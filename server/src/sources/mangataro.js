const fetch = require('node-fetch');
const crypto = require('crypto');

// MangaTaro source adapter — full chapter download support.
//
// Reverse-engineering notes (verified end-to-end against the live site
// using Horimiya at /manga/horimiya, manga_id=158587):
//
//   The site is a WordPress + custom-theme app at mangataro.org with a
//   small JSON API mounted at /auth/* (no auth required for the read-only
//   endpoints we need — the prefix is misleading). Three endpoints:
//
//     POST /auth/search                                — title search.
//        body (JSON):  {query: "...", limit: 20}
//        Returns:      {success, query, count, results: [{
//                        id, title, slug, alt_titles, authors,
//                        permalink, thumbnail, description, type, status
//                      }]}
//        `id` is the numeric series id; `slug` is the URL slug.
//
//     GET  /auth/manga-chapters?manga_id={id}
//                              &offset=0
//                              &limit=500
//                              &order=ASC
//                              &_t={token}
//                              &_ts={timestamp}        — chapter list.
//        Returns: {success, chapters: [{id, chapter, title, date,
//                                       chapter_type, language, group_name,
//                                       url, ...}], has_more}
//        Token is required: a 16-char MD5 prefix derived from the timestamp
//        plus an hour-based secret. Algorithm mirrors what the site's own
//        bundle does — see generateToken() below.
//
//     GET  /auth/chapter-content?chapter_id={id}      — page list.
//        Returns: {success, chapter_id, chapter_type:"media",
//                  images:[<absolute URL>, ...]}
//        No token required. Image host is mangataro.yachts (CDN); we fetch
//        them directly via the downloader queue.
//
//   The user-facing URL on the series page uses the slug — that's what we
//   record as the canonical URL and as `source_id`. The numeric manga_id
//   needed by the chapters endpoint is scraped from the series page on
//   first chapter-list call and cached in-process for the lifetime of the
//   server (slug → numeric id is effectively immutable for a given series).
//
// Same-shape contract as the other adapters — slot-in compatible with the
// downloader queue and the scheduler diff path.

const SITE_BASE  = 'https://mangataro.org';
const USER_AGENT = 'Mozilla/5.0 (Momotaro/1.0; +https://github.com/momotaro)';
const REQUEST_INTERVAL_MS = 250;

let _lastRequestAt = 0;
// slug → numeric manga_id. Populated by getMangaIdForSlug() on first use.
const _slugIdCache = new Map();

async function pacedFetch(url, options = {}) {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  const resp = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'User-Agent':      USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         SITE_BASE + '/',
      ...(options.headers || {}),
    },
  });
  return resp;
}

async function getJson(url, options = {}) {
  const resp = await pacedFetch(url, {
    ...options,
    headers: { 'Accept': 'application/json', ...(options.headers || {}) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`MangaTaro ${resp.status} ${url}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function htmlGet(url) {
  const resp = await pacedFetch(url, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (!resp.ok) {
    throw new Error(`MangaTaro ${resp.status} ${url}`);
  }
  return resp.text();
}

// ── Token ──────────────────────────────────────────────────────────────────

/**
 * Mirror of the site's `generateToken()` JS: 16-char prefix of
 * md5(timestamp_seconds + 'mng_ch_' + UTC YYYYMMDDHH). The hour-based secret
 * is what gives the token a one-hour validity window; we regenerate per
 * request so the freshly-paced fetch never trips the staleness check.
 */
function generateToken() {
  const timestamp = Math.floor(Date.now() / 1000);
  const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
  const secret = 'mng_ch_' + hour;
  const token = crypto.createHash('md5').update(timestamp + secret).digest('hex').substring(0, 16);
  return { token, timestamp };
}

// ── HTML helpers ───────────────────────────────────────────────────────────

function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function pickMeta(html, property) {
  const re = new RegExp(`<meta\\s+property=['"]${property}['"]\\s+content=['"]([^'"]+)['"]`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function seriesUrl(slug) {
  return slug ? `${SITE_BASE}/manga/${slug}` : null;
}

/**
 * Strip the SEO suffix the og:title carries (" Manga | Read Online Free at
 * MangaTaro"), leaving the bare series title.
 */
function cleanSeriesTitle(rawTitle) {
  if (!rawTitle) return null;
  return String(rawTitle)
    .replace(/\s+Manga\s*\|\s*Read\s+Online\s+Free\s+at\s+MangaTaro\s*$/i, '')
    .replace(/\s*\|\s*Read[^|]*MangaTaro\s*$/i, '')
    .trim();
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * Normalise a search-API hit into the shape the rest of the app expects.
 * `id` is the numeric series id from the API — we use the slug as the
 * canonical source_id (matches the user-pasted URL form), but stash the
 * numeric id in the slug→id cache so the chapter-list call doesn't need
 * an extra round-trip.
 */
function normalizeSearchHit(item) {
  if (!item || !item.slug) return null;
  if (item.id != null) _slugIdCache.set(item.slug, String(item.id));
  const authors = Array.isArray(item.authors)
    ? item.authors.filter(Boolean).join(', ')
    : (item.authors || null);
  return {
    id:           item.slug,
    title:        item.title || null,
    description:  item.description || null,
    author:       authors || null,
    year:         null,
    status:       item.status || null,
    content_rating: null,
    genres:       [],
    cover_url:    item.thumbnail || null,
    series_url:   seriesUrl(item.slug),
    last_chapter: null,
    available_languages: ['en'],
  };
}

async function searchSeries(query, { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const data = await getJson(`${SITE_BASE}/auth/search`, {
    method:  'POST',
    body:    JSON.stringify({ query: query.trim(), limit: cap }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!data || data.success !== true) return [];
  return (data.results || []).map(normalizeSearchHit).filter(Boolean);
}

// ── Series detail ──────────────────────────────────────────────────────────

async function getSeries(slug) {
  if (!slug) throw new Error('slug is required');
  const html = await htmlGet(`${SITE_BASE}/manga/${encodeURIComponent(slug)}`);
  return parseSeriesHtml(html, slug);
}

/**
 * Pull what the chapter-list element + JSON-LD + og: meta + tag links
 * expose. The author/status come from the inline ComicSeries JSON-LD; the
 * tags come from the side-panel `/tag/<slug>` anchors.
 */
function parseSeriesHtml(html, slug) {
  const ogTitle   = pickMeta(html, 'og:title');
  const title     = cleanSeriesTitle(ogTitle) || slug;
  const cover     = pickMeta(html, 'og:image');
  const descriptionRaw = pickMeta(html, 'og:description')
    || (() => {
      const m = html.match(/<meta\s+name=['"]description['"]\s+content=['"]([^'"]+)['"]/i);
      return m ? decodeEntities(m[1]) : null;
    })();

  // ComicSeries JSON-LD carries author + status verbatim. There can be more
  // than one ld+json block on the page (BreadcrumbList, WebSite); pick the
  // ComicSeries one specifically.
  let author = null;
  let status = null;
  for (const m of html.matchAll(/<script\s+type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj['@type'] === 'ComicSeries') {
        if (obj.author && obj.author.name) author = String(obj.author.name);
        if (obj.status) status = String(obj.status);
        break;
      }
    } catch { /* one block being malformed shouldn't kill the parse */ }
  }

  // Tags surfaced as side-panel links: /tag/<slug>. Drop the meta-tag
  // "manga" / "manhwa" / "manhua" entries that are type markers, not genres.
  const TYPE_TAGS = new Set(['manga', 'manhwa', 'manhua', 'comics']);
  const tagSet = new Set();
  for (const m of html.matchAll(/href=['"][^'"]*\/tag\/([a-z0-9-]+)['"]/gi)) {
    const t = decodeURIComponent(m[1].replace(/-/g, ' '));
    if (!TYPE_TAGS.has(t.toLowerCase())) tagSet.add(t);
  }

  // Cache the numeric id off `data-manga-id` on the chapter-list container —
  // saves the chapter-list call from re-fetching the HTML.
  const idMatch = html.match(/data-manga-id=['"](\d+)['"]/i);
  if (idMatch) _slugIdCache.set(slug, idMatch[1]);

  return {
    id:           slug,
    title,
    description:  descriptionRaw,
    author,
    year:         null,
    status,
    content_rating: null,
    genres:       [...tagSet],
    cover_url:    cover || null,
    series_url:   seriesUrl(slug),
    last_chapter: null,
    available_languages: ['en'],
  };
}

// ── Chapter list ───────────────────────────────────────────────────────────

/**
 * Resolve the slug → numeric manga_id needed by the chapters API. Cached
 * for the process lifetime — slug↔id is effectively immutable. Falls back
 * to scraping `data-manga-id` off the series page when the cache is cold.
 */
async function getMangaIdForSlug(slug) {
  if (_slugIdCache.has(slug)) return _slugIdCache.get(slug);
  const html = await htmlGet(`${SITE_BASE}/manga/${encodeURIComponent(slug)}`);
  const m = html.match(/data-manga-id=['"](\d+)['"]/i);
  if (!m) throw new Error(`MangaTaro: could not find data-manga-id for "${slug}"`);
  _slugIdCache.set(slug, m[1]);
  return m[1];
}

function normalizeChapter(item) {
  if (!item || item.id == null) return null;
  const numRaw = item.chapter;
  const num = numRaw != null && numRaw !== '' ? parseFloat(numRaw) : null;
  return {
    id:           String(item.id),
    number:       Number.isFinite(num) ? num : null,
    volume:       null,
    title:        item.title || null,
    language:     item.language || 'en',
    pages:        0,
    published_at: item.date || null,
    group:        item.group_name || null,
    external_url: null,
  };
}

/**
 * Page through /auth/manga-chapters in 500-chapter batches until has_more
 * is false (or a hard 20-page ceiling, well above the longest series the
 * site hosts). Each batch needs a fresh token (the hour-based secret can
 * roll between batches if we straddle the hour boundary).
 */
async function getChapters(slug /*, opts */) {
  if (!slug) throw new Error('slug is required');
  const mangaId = await getMangaIdForSlug(slug);
  const out = [];
  const seenIds = new Set();
  let offset = 0;
  const PAGE = 500;
  for (let i = 0; i < 20; i++) {
    const { token, timestamp } = generateToken();
    const params = new URLSearchParams();
    params.set('manga_id', mangaId);
    params.set('offset',   String(offset));
    params.set('limit',    String(PAGE));
    params.set('order',    'ASC');
    params.set('_t',       token);
    params.set('_ts',      String(timestamp));
    const data = await getJson(`${SITE_BASE}/auth/manga-chapters?${params}`);
    if (!data || data.success !== true) break;
    const rows = (data.chapters || []).map(normalizeChapter).filter(Boolean);
    for (const r of rows) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        out.push(r);
      }
    }
    offset += rows.length;
    if (!data.has_more || rows.length < PAGE) break;
  }
  // Stable sort by chapter number, matching the other adapters' contract so
  // the scheduler diff sees a consistent shape.
  out.sort((a, b) => {
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
 * mangadex adapter does so the downloader worker doesn't need a per-source
 * branch for image fetching. The chapter-content endpoint hands back every
 * page URL in order, hosted on the mangataro.yachts CDN.
 */
async function getChapterImages(chapterId) {
  if (!chapterId) throw new Error('chapterId is required');
  const data = await getJson(`${SITE_BASE}/auth/chapter-content?chapter_id=${encodeURIComponent(chapterId)}`);
  if (!data || data.success !== true) {
    throw new Error(`MangaTaro: chapter-content returned ${data && data.message ? data.message : 'failure'}`);
  }
  if (data.chapter_type && data.chapter_type !== 'media') {
    throw new Error(`MangaTaro: chapter ${chapterId} is type "${data.chapter_type}", not downloadable as images`);
  }
  const files = Array.isArray(data.images) ? data.images.filter(u => typeof u === 'string' && u.length > 0) : [];
  if (files.length === 0) {
    throw new Error('MangaTaro returned no images for this chapter');
  }
  return {
    base_url:         '',
    hash:             '',
    files,
    data_saver_files: [],
  };
}

module.exports = {
  id: 'mangataro',
  label: 'MangaTaro',
  homepage: SITE_BASE,
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  // Exposed for tests
  _generateToken: generateToken,
  _parseSeriesHtml: parseSeriesHtml,
  _normalizeSearchHit: normalizeSearchHit,
  _resetCache: () => _slugIdCache.clear(),
};
