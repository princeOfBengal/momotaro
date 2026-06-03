const fetch = require('node-fetch');
const { createPacer } = require('./_pacer');

// comix.to source adapter for the Third Party Sourcing feature.
//
// The site exposes a JSON API at `/api/v1` discovered by reading the SPA
// bundle. Two of the endpoints are open and two are gated.
//
//   OPEN  — no auth needed:
//     GET /api/v1/manga?keyword=…   (search; param name verified against the
//                                    bundle: `ke.list({keyword:o,limit:12})`)
//     GET /api/v1/manga/{hid}       (series detail)
//
//   GATED — return `{status:"error",message:"Missing token.",code:403}`:
//     GET /api/v1/manga/{hid}/chapters
//     GET /api/v1/chapters/{hid}/pages
//
// The token is derived in the browser by an obfuscated VM-bytecode module
// (`secure-*.js`) that the SPA runs as an axios request interceptor. Cookies,
// `Referer`, `Origin`, `X-Requested-With`, and SSR-hydration into the
// chapter page's `<script id="initial-data">` were all probed and none
// bypass it; the chapter page only inlines `{mangaHid, chapterId}` and
// loads the page list via the gated endpoint at runtime.
//
// Reproducing the token in Node would require either (a) running JSDOM +
// the obfuscated module — fragile, breaks on every site update — or
// (b) bundling Puppeteer/Playwright (~200 MB). Neither is appropriate for
// a self-hosted manga server's dependency footprint.
//
// What this adapter therefore supports today:
//   - searchSeries   ✅
//   - getSeries      ✅
//   - seriesUrl      ✅  (used by the URL recorder + linkage)
//   - getChapters    ❌  throws a descriptive error
//   - getChapterImages ❌  throws a descriptive error
//
// The schedule, downloader, URL store, and Settings → Scheduling pages all
// degrade gracefully on the error: jobs land in `failed` with
// `error: comix.to chapter access requires...`, and `last_result` shows the
// same string. The user can still link a comix.to URL to a manga, browse
// titles, and use the cross-source `links.md` (MangaDex link) that comix.to
// itself returns to fall back to the MangaDex adapter for actual downloads.

const API_BASE      = 'https://comix.to/api/v1';
const SITE_BASE     = 'https://comix.to';
const USER_AGENT    = 'Mozilla/5.0 (Momotaro/1.0; +https://github.com/momotaro)';
const REQUEST_INTERVAL_MS = 250;

const _pacer = createPacer(REQUEST_INTERVAL_MS);

async function pacedFetch(url, options = {}) {
  await _pacer.wait();

  const resp = await fetch(url, {
    ...options,
    headers: {
      'User-Agent':       USER_AGENT,
      'Accept':           'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers || {}),
    },
  });

  let json;
  try { json = await resp.json(); }
  catch { throw new Error(`comix.to ${resp.status}: response was not JSON`); }

  // Surface the site's own error payload verbatim — it's clearer than HTTP
  // status alone (e.g. "Missing token." for the gated endpoints).
  if (json && json.status === 'error') {
    throw new Error(`comix.to: ${json.message || `error ${json.code || resp.status}`}`);
  }
  if (!resp.ok) {
    throw new Error(`comix.to ${resp.status}`);
  }
  // The site wraps successful responses as `{status:"ok", result:<data>}` —
  // unwrap to match the shape the rest of the code expects.
  return json && json.status === 'ok' ? json.result : json;
}

function seriesUrl(hid) {
  return hid ? `${SITE_BASE}/title/${hid}` : null;
}

function normalizeSeries(item) {
  if (!item) return null;
  const cover = item.poster?.large || item.poster?.medium || null;
  const authors = (item.authors || []).map(a => a?.name).filter(Boolean);
  const genres  = (item.genres  || []).map(g => g?.title || g?.name).filter(Boolean);
  return {
    id:          item.hid,
    title:       item.title,
    description: item.synopsis || null,
    author:      authors.join(', ') || null,
    year:        item.year || null,
    status:      item.status || null,
    content_rating: item.contentRating || null,
    genres,
    cover_url:   cover,
    series_url:  seriesUrl(item.hid),
    last_chapter: item.finalChapter || item.latestChapter || null,
    available_languages: item.originalLanguage ? [item.originalLanguage] : [],
    // Extra cross-source links comix.to itself surfaces — useful when the
    // user wants to fall back to a different source for actual downloads.
    cross_links: item.links || null,
  };
}

/**
 * Title search.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 */
async function searchSeries(query, { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const params = new URLSearchParams();
  params.set('keyword', query.trim());
  params.set('limit',   String(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)));
  const result = await pacedFetch(`${API_BASE}/manga?${params}`);
  const items = result?.items || [];
  return items.map(normalizeSeries);
}

/**
 * Single series by `hid`.
 */
async function getSeries(hid) {
  const result = await pacedFetch(`${API_BASE}/manga/${encodeURIComponent(hid)}`);
  return normalizeSeries(result);
}

// Sentinel error message — the scheduler surfaces it verbatim in
// `last_result`, the downloader writes it to `download_jobs.error`, and the
// Settings UI displays it inline. Keep it short and actionable.
const GATED_ERR =
  'comix.to chapter access is gated by a browser-only security token; ' +
  'use the linked MangaDex URL for actual downloads.';

/**
 * Chapter listing — gated by the site's anti-bot token. Throws a clear
 * error so the scheduler / downloader surfaces a useful message instead of
 * a 403 string.
 */
async function getChapters(/* hid, opts */) {
  throw new Error(GATED_ERR);
}

/**
 * Per-chapter image URLs — same gate.
 */
async function getChapterImages(/* chapterId */) {
  throw new Error(GATED_ERR);
}

module.exports = {
  id: 'comixto',
  label: 'Comix.to',
  homepage: 'https://comix.to',
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  // Exposed for the docs and for any future test that wants to probe the
  // gated state without hard-coding the message.
  GATED_ERROR: GATED_ERR,
};
