const fetch = require('node-fetch');

// MangaDotNet source adapter — full chapter download support.
//
// Reverse-engineering notes (verified end-to-end against the live site
// using Horimiya at /manga/196):
//
//   The site is a React Router v7 SSR app at mangadot.net with a clean
//   `/api/*` REST surface for read-only data plus a `/_rr/*` surface for
//   resource-route loaders. None of the read endpoints we need require auth.
//
//   Endpoints used:
//
//     GET  /_rr/suggestions?q={query}                  — search/autocomplete.
//        Returns: {suggestions: [{
//          id, title, photo, genres,
//          chapter_count, status, view_count, tracked_count
//        }]}
//        `genres` is a comma-joined string. `photo` is a relative path
//        ("/uploads/..."), absolute by prefixing the site base.
//
//     GET  /api/manga/{id}                              — series detail.
//        Returns: {manga: {id, title, genres:[…], status, photo, description,
//                          authors:JSON-string, artists:JSON-string,
//                          country_of_origin, alt_titles:[…], …}}
//
//     GET  /api/manga/{id}/chapters/list                — chapter list.
//        Returns: [{id, chapter_number, volume_number, chapter_title,
//                   language, group_id, group_name, page_count,
//                   date_added, source, scanlator_name, groups:[…]}]
//        Optional `?lang=en` and `?group_id=N` filters mirror what the
//        site UI sends; we leave them off so the user can see every
//        translation and post-filter client-side.
//
//     GET  /api/chapters/{chapterId}/images             — chapter pages.
//        Returns: {chapter:{…}, manga:{…}, images:[{url, w, h}, …]}
//        URLs are site-relative ("/chapters/manga_196/chapter_1/001.webp"),
//        so the downloader needs them absolutised against mangadot.net.
//
//   Image host is mangadot.net itself — no CDN, no token, no Referer
//   gating; verified end-to-end with curl returning valid WEBP bytes.
//
// Same-shape contract as the other adapters — slot-in compatible with the
// downloader queue and the scheduler diff path.

const SITE_BASE  = 'https://mangadot.net';
const USER_AGENT = 'Mozilla/5.0 (Momotaro/1.0; +https://github.com/momotaro)';
const REQUEST_INTERVAL_MS = 250;

let _lastRequestAt = 0;

async function pacedFetch(url, options = {}) {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  const resp = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'User-Agent':      USER_AGENT,
      'Accept':          'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         SITE_BASE + '/',
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`MangaDotNet ${resp.status} ${url}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

function seriesUrl(id) {
  return id ? `${SITE_BASE}/manga/${id}` : null;
}

/**
 * Absolutise a site-relative URL against mangadot.net. The site stores
 * cover photos and chapter pages as relative paths; the downloader expects
 * absolute URLs to fetch from.
 */
function absoluteUrl(maybeRelative) {
  if (!maybeRelative) return null;
  const s = String(maybeRelative);
  if (/^https?:\/\//i.test(s)) return s;
  return SITE_BASE + (s.startsWith('/') ? s : '/' + s);
}

/**
 * `manga.authors` and `manga.artists` come back as JSON-encoded strings
 * (`"[\"HERO\"]"`), not arrays — best-effort parse and join with commas.
 * Falls back to the raw value if it isn't valid JSON, so a future schema
 * change to a real array still surfaces something readable.
 */
function parsePeople(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.filter(Boolean).join(', ') || null;
  if (typeof raw !== 'string') return String(raw);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.filter(Boolean).join(', ') || null;
    } catch { /* fall through */ }
  }
  return trimmed;
}

// ── Search ─────────────────────────────────────────────────────────────────

function normalizeSuggestion(item) {
  if (!item || item.id == null) return null;
  const genres = typeof item.genres === 'string'
    ? item.genres.split(',').map(s => s.trim()).filter(Boolean)
    : (Array.isArray(item.genres) ? item.genres : []);
  return {
    id:           String(item.id),
    title:        item.title || null,
    description:  null,
    author:       null,
    year:         null,
    status:       item.status || null,
    content_rating: null,
    genres,
    cover_url:    absoluteUrl(item.photo),
    series_url:   seriesUrl(item.id),
    last_chapter: item.chapter_count != null ? String(item.chapter_count) : null,
    available_languages: ['en'],
  };
}

async function searchSeries(query, { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const url = `${SITE_BASE}/_rr/suggestions?q=${encodeURIComponent(query.trim())}`;
  const data = await pacedFetch(url);
  const items = Array.isArray(data?.suggestions) ? data.suggestions : [];
  return items.slice(0, cap).map(normalizeSuggestion).filter(Boolean);
}

// ── Series detail ──────────────────────────────────────────────────────────

async function getSeries(id) {
  if (!id) throw new Error('id is required');
  const data = await pacedFetch(`${SITE_BASE}/api/manga/${encodeURIComponent(id)}`);
  return normalizeSeries(data?.manga, id);
}

function normalizeSeries(m, fallbackId) {
  if (!m) {
    return {
      id: String(fallbackId), title: null, description: null, author: null,
      year: null, status: null, content_rating: null, genres: [],
      cover_url: null, series_url: seriesUrl(fallbackId),
      last_chapter: null, available_languages: ['en'],
    };
  }
  const id = m.id != null ? String(m.id) : String(fallbackId);
  const genres = Array.isArray(m.genres) ? m.genres.filter(Boolean) : [];
  const authors = parsePeople(m.authors);
  const artists = parsePeople(m.artists);
  // Combine authors and artists into one comma-separated label (dropping
  // the artist line when it's identical or empty) — matches the convention
  // the other adapters use for the unified `author` field.
  let author = authors;
  if (artists && artists !== authors) {
    author = author ? `${author} (art: ${artists})` : artists;
  }
  return {
    id,
    title:        m.title || null,
    description:  m.description || null,
    author,
    year:         null,
    status:       m.status || null,
    content_rating: null,
    genres,
    cover_url:    absoluteUrl(m.photo),
    series_url:   seriesUrl(id),
    last_chapter: m.chapter_count != null ? String(m.chapter_count) : null,
    available_languages: ['en'],
  };
}

// ── Chapter list ───────────────────────────────────────────────────────────

function normalizeChapter(item) {
  if (!item || item.id == null) return null;
  const numRaw = item.chapter_number;
  const num = numRaw != null && numRaw !== '' ? parseFloat(numRaw) : null;
  const volRaw = item.volume_number;
  const vol = volRaw != null && volRaw !== '' ? parseFloat(volRaw) : null;
  // The site emits the same series of "groups" two ways: a top-level
  // group_name (legacy single-group field) and a `groups: [{id, name}]`
  // array (multi-group). Prefer the array when present.
  const groupNames = Array.isArray(item.groups) && item.groups.length > 0
    ? item.groups.map(g => g?.name).filter(Boolean).join(', ')
    : (item.scanlator_name || item.group_name || null);
  return {
    id:           String(item.id),
    number:       Number.isFinite(num) ? num : null,
    volume:       Number.isFinite(vol) ? vol : null,
    title:        item.chapter_title || null,
    language:     item.language || 'en',
    pages:        Number.isFinite(item.page_count) ? item.page_count : 0,
    published_at: item.date_added || null,
    group:        groupNames,
    external_url: null,
  };
}

/**
 * Fetch all chapters for a series. The endpoint returns the full list in a
 * single response (no pagination on the wire — the UI does its own
 * client-side paging). Filters by `languages` post-fetch so callers get a
 * consistent contract with the other adapters.
 */
async function getChapters(id, { languages = ['en'] } = {}) {
  if (!id) throw new Error('id is required');
  const data = await pacedFetch(`${SITE_BASE}/api/manga/${encodeURIComponent(id)}/chapters/list`);
  const list = Array.isArray(data) ? data : [];
  const langSet = new Set(languages.map(l => String(l).toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const norm = normalizeChapter(row);
    if (!norm) continue;
    if (!langSet.has(String(norm.language).toLowerCase())) continue;
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    out.push(norm);
  }
  // Stable sort: volume → chapter → published_at, matching the other
  // adapters' contract so the scheduler diff sees consistent ordering.
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

// ── Chapter images ─────────────────────────────────────────────────────────

/**
 * Returns the same `{ files, base_url, hash, data_saver_files }` shape the
 * mangadex adapter does, so the downloader worker doesn't need a per-source
 * branch for image fetching. The endpoint hands back per-page entries with
 * site-relative URLs — we absolutise them before returning.
 */
async function getChapterImages(chapterId) {
  if (!chapterId) throw new Error('chapterId is required');
  const data = await pacedFetch(`${SITE_BASE}/api/chapters/${encodeURIComponent(chapterId)}/images`);
  const images = Array.isArray(data?.images) ? data.images : [];
  const files = images
    .map(img => absoluteUrl(typeof img === 'string' ? img : img?.url))
    .filter(Boolean);
  if (files.length === 0) {
    throw new Error('MangaDotNet returned no images for this chapter');
  }
  return {
    base_url:         '',
    hash:             '',
    files,
    data_saver_files: [],
  };
}

module.exports = {
  id: 'mangadotnet',
  label: 'MangaDotNet',
  homepage: SITE_BASE,
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  // Exposed for tests
  _normalizeSuggestion: normalizeSuggestion,
  _normalizeSeries:     normalizeSeries,
  _normalizeChapter:    normalizeChapter,
  _absoluteUrl:         absoluteUrl,
};
