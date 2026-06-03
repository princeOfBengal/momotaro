const fetch = require('node-fetch');
const { createPacer } = require('./_pacer');

// MangaDex source adapter for the Third Party Sourcing feature.
//
// API docs: https://api.mangadex.org/docs/
// All endpoints are public read-only — no auth needed for search / chapters /
// at-home. MangaDex does require a User-Agent identifying the client.
//
// Rate limiting is enforced per-process via REQUEST_INTERVAL_MS. The download
// queue further paces image fetches via the user-configurable page-delay
// setting (see downloader/queue.js).

const API_BASE      = 'https://api.mangadex.org';
const COVER_BASE    = 'https://uploads.mangadex.org/covers';
const USER_AGENT    = 'Momotaro/1.0 (https://github.com/momotaro)';
// Soft cap between metadata requests. Image fetches go through the downloader
// which has its own configurable per-page delay; this only paces /manga,
// /manga/{id}/feed, and /at-home/server/{id}.
const REQUEST_INTERVAL_MS = 250;

const _pacer = createPacer(REQUEST_INTERVAL_MS);

async function pacedFetch(url, options = {}) {
  await _pacer.wait();

  const resp = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept':     'application/json',
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    let body = '';
    try { body = await resp.text(); } catch { /* ignore */ }
    throw new Error(`MangaDex ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

function pickAttr(obj, key) {
  if (!obj || !obj.attributes) return null;
  const v = obj.attributes[key];
  if (!v) return null;
  if (typeof v === 'string') return v;
  // Localised strings — prefer English then Japanese-romanised then any.
  if (typeof v === 'object') {
    return v.en || v['ja-ro'] || v.ja || Object.values(v)[0] || null;
  }
  return null;
}

function findRelationship(obj, type) {
  return (obj?.relationships || []).find(r => r.type === type) || null;
}

function findRelationships(obj, type) {
  return (obj?.relationships || []).filter(r => r.type === type);
}

function coverUrl(mangaId, fileName, size = 512) {
  if (!mangaId || !fileName) return null;
  // MangaDex serves three sizes via filename suffix: .256.jpg, .512.jpg,
  // or the original. 512 is plenty for a search-result thumbnail.
  return `${COVER_BASE}/${mangaId}/${fileName}.${size}.jpg`;
}

function seriesUrl(id) {
  return id ? `https://mangadex.org/title/${id}` : null;
}

function normalizeSeries(item) {
  const id    = item.id;
  const cover = findRelationship(item, 'cover_art');
  const coverFile = cover?.attributes?.fileName || null;
  const authors = findRelationships(item, 'author')
    .map(r => r.attributes?.name)
    .filter(Boolean);

  const tags = (item.attributes?.tags || [])
    .map(t => pickAttr(t, 'name'))
    .filter(Boolean);

  return {
    id,
    title:       pickAttr(item, 'title'),
    description: pickAttr(item, 'description'),
    author:      authors.join(', ') || null,
    year:        item.attributes?.year || null,
    status:      item.attributes?.status || null,
    content_rating: item.attributes?.contentRating || null,
    genres:      tags,
    cover_url:   coverUrl(id, coverFile),
    series_url:  seriesUrl(id),
    last_chapter: item.attributes?.lastChapter || null,
    available_languages: item.attributes?.availableTranslatedLanguages || [],
  };
}

/**
 * Search MangaDex by title.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Array<{id, title, author, year, status, cover_url, ...}>>}
 */
async function searchSeries(query, { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const params = new URLSearchParams();
  params.set('title', query.trim());
  params.set('limit', String(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)));
  params.append('includes[]', 'cover_art');
  params.append('includes[]', 'author');
  params.append('includes[]', 'artist');
  // Surface explicit-rated entries too — the user is choosing what to download.
  for (const r of ['safe', 'suggestive', 'erotica', 'pornographic']) {
    params.append('contentRating[]', r);
  }
  const json = await pacedFetch(`${API_BASE}/manga?${params}`);
  return (json.data || []).map(normalizeSeries);
}

/**
 * Get a single series by id.
 */
async function getSeries(seriesId) {
  const params = new URLSearchParams();
  params.append('includes[]', 'cover_art');
  params.append('includes[]', 'author');
  params.append('includes[]', 'artist');
  const json = await pacedFetch(`${API_BASE}/manga/${seriesId}?${params}`);
  return normalizeSeries(json.data);
}

function normalizeChapter(item) {
  const a = item.attributes || {};
  const num    = a.chapter ? parseFloat(a.chapter) : null;
  const volume = a.volume  ? parseFloat(a.volume)  : null;
  const group  = findRelationship(item, 'scanlation_group');
  return {
    id:           item.id,
    number:       Number.isFinite(num)    ? num    : null,
    volume:       Number.isFinite(volume) ? volume : null,
    title:        a.title || null,
    language:     a.translatedLanguage || null,
    pages:        a.pages || 0,
    published_at: a.publishAt || a.readableAt || null,
    group:        group?.attributes?.name || null,
    external_url: a.externalUrl || null, // Some chapters are hosted elsewhere
  };
}

/**
 * List all chapters for a series, paged through MangaDex's 500-per-page feed.
 *
 * @param {string} seriesId
 * @param {object} [opts]
 * @param {string[]} [opts.languages=['en']] — translated language filter.
 * @returns {Promise<Array>} chapter objects (unique by number+language).
 */
async function getChapters(seriesId, { languages = ['en'] } = {}) {
  const out = [];
  const seenIds = new Set();
  let offset = 0;
  const PAGE = 500;
  // Hard ceiling so a series with thousands of chapter rows can't run away
  // — this is well above the longest series MangaDex hosts.
  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams();
    params.set('limit',  String(PAGE));
    params.set('offset', String(offset));
    params.append('order[volume]',  'asc');
    params.append('order[chapter]', 'asc');
    params.append('includes[]',     'scanlation_group');
    for (const r of ['safe', 'suggestive', 'erotica', 'pornographic']) {
      params.append('contentRating[]', r);
    }
    for (const lang of languages) {
      params.append('translatedLanguage[]', lang);
    }
    const json = await pacedFetch(`${API_BASE}/manga/${seriesId}/feed?${params}`);
    const rows = (json.data || []).map(normalizeChapter);
    for (const r of rows) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        out.push(r);
      }
    }
    const total = json.total || 0;
    offset += rows.length;
    if (rows.length < PAGE || offset >= total) break;
  }
  // Stable sort: volume → chapter → published_at. Volume-less chapters fall to
  // the bottom of their volume tier; chapter-less rows (one-shots, extras) go
  // to the very end.
  out.sort((a, b) => {
    const va = a.volume ?? Number.POSITIVE_INFINITY;
    const vb = b.volume ?? Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    const ca = a.number ?? Number.POSITIVE_INFINITY;
    const cb = b.number ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return String(a.published_at || '').localeCompare(String(b.published_at || ''));
  });
  return out;
}

/**
 * Resolve the per-chapter image URLs via the MangaDex@Home server hint.
 *
 * @param {string} chapterId
 * @returns {Promise<{base_url, hash, files: string[], data_saver_files: string[]}>}
 */
async function getChapterImages(chapterId) {
  const json = await pacedFetch(`${API_BASE}/at-home/server/${chapterId}`);
  const baseUrl = json.baseUrl;
  const hash    = json.chapter?.hash;
  const data    = json.chapter?.data || [];
  if (!baseUrl || !hash || data.length === 0) {
    throw new Error('MangaDex returned no images for this chapter (it may be hosted externally).');
  }
  return {
    base_url: baseUrl,
    hash,
    files:            data.map(f => `${baseUrl}/data/${hash}/${f}`),
    data_saver_files: (json.chapter?.dataSaver || []).map(f => `${baseUrl}/data-saver/${hash}/${f}`),
  };
}

module.exports = {
  id: 'mangadex',
  label: 'MangaDex',
  homepage: 'https://mangadex.org',
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT, // exported so the downloader can match the UA on image fetches
};
