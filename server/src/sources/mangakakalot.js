const fetch = require('node-fetch');

// MangaKakalot source adapter.
//
// Reverse-engineering notes (verified against the live site):
//   - Title autocomplete is exposed at:
//       GET /home/search/json?searchword={normalized}
//     The site's own `fsearch.js` normalises the query through `change_alias`
//     (lowercase, Unicode-fold, replace punctuation/spaces with `_`, collapse
//     `_+`, strip leading/trailing `_`). We mirror that here so what gets
//     sent matches what the site would send for the same input.
//   - Response shape: `[{id, slug, name, author, chapterLatest, url, thumb}, ...]`
//   - Series detail (HTML at /manga/{slug}), chapter list, and chapter image
//     pages are all behind a Cloudflare interactive JS challenge — every
//     attempt with cookies, full browser headers, and known mirrors fails
//     with HTTP 403 + "Just a moment..." interstitial. Without bundling
//     Puppeteer (~200 MB) or running an external FlareSolverr proxy, those
//     endpoints are inaccessible.
//
// Therefore this adapter implements the same partial-support pattern as
// `comixto.js`:
//
//   searchSeries        ✅ live JSON endpoint
//   getSeries           ✅ synthesised from a search-by-slug round-trip
//                          (the search response includes everything the
//                          user-facing UI needs: title, author, latest
//                          chapter, thumb, URL)
//   seriesUrl           ✅ deterministic from slug
//   getChapters         ❌ throws GATED_ERROR
//   getChapterImages    ❌ throws GATED_ERROR
//
// Downstream consumers (downloader queue, scheduler, Settings → Scheduling)
// surface the gated error verbatim in `download_jobs.error` and
// `manga_schedules.last_result`, so the user sees an actionable message
// rather than a silent failure.

const SITE_BASE  = 'https://www.mangakakalot.gg';
const SEARCH_URL = `${SITE_BASE}/home/search/json`;
const USER_AGENT = 'Mozilla/5.0 (Momotaro/1.0; +https://github.com/momotaro)';
const REQUEST_INTERVAL_MS = 250;

let _lastRequestAt = 0;

async function pacedFetch(url, options = {}) {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  const resp = await fetch(url, {
    ...options,
    headers: {
      'User-Agent':       USER_AGENT,
      'Accept':           'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer':          SITE_BASE + '/',
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`MangaKakalot ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return resp.json();
}

/**
 * Mirror of the site's own `change_alias()` — lowercases, normalises
 * Vietnamese/Unicode diacritics, replaces punctuation/spaces with `_`, and
 * collapses runs. Without this the search endpoint returns no results for
 * inputs that contain uppercase letters or spaces.
 */
function changeAlias(input) {
  let str = String(input || '').toLowerCase();
  // Diacritic fold via NFD normalisation — cleaner and more complete than
  // the giant char-class the site ships, and equivalent for the practical
  // input space.
  str = str.normalize('NFD').replace(/\p{M}/gu, '');
  // Replace anything outside [a-z0-9] with `_`, then collapse and trim.
  str = str.replace(/[^a-z0-9]+/g, '_');
  str = str.replace(/^_+|_+$/g, '');
  return str;
}

function seriesUrl(slug) {
  return slug ? `${SITE_BASE}/manga/${slug}` : null;
}

/**
 * Normalise a single search-result row into the shape the rest of the app
 * expects (matches the keys returned by `mangadex.normalizeSeries`).
 */
function normalizeSearchHit(item) {
  if (!item) return null;
  return {
    id:          item.slug,                // canonical id we store on manga.mangakakalot_id
    title:       item.name || null,
    description: null,                     // not in the search payload
    author:      item.author || null,
    year:        null,
    status:      null,
    content_rating: null,
    genres:      [],
    cover_url:   item.thumb || null,
    series_url:  item.url || seriesUrl(item.slug),
    last_chapter: parseLatestChapter(item.chapterLatest),
    available_languages: ['en'],
  };
}

/**
 * Pull the chapter number out of a string like "Chapter 298.1". Returns null
 * if no number is present so callers can show the raw label as a fallback.
 */
function parseLatestChapter(label) {
  if (!label) return null;
  const m = String(label).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
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
  const normalized = changeAlias(query);
  if (!normalized) return [];
  const params = new URLSearchParams({ searchword: normalized });
  const json = await pacedFetch(`${SEARCH_URL}?${params}`);
  const items = Array.isArray(json) ? json : [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return items.slice(0, cap).map(normalizeSearchHit);
}

/**
 * Single series by slug. The series HTML page is Cloudflare-gated, so we
 * can't fetch it directly — instead we round-trip through the search
 * endpoint (which IS open) using the slug as the query. The returned hit
 * carries everything the UI shows on the series detail card.
 *
 * If the search endpoint returns no row for the slug (e.g. the title was
 * removed from the site, or the slug was hand-typed and is wrong) we throw
 * with a clear message so the caller can surface it.
 */
async function getSeries(slug) {
  if (!slug) throw new Error('slug is required');
  // The search endpoint matches against the title, not the slug — but every
  // slug is derived from the title via change_alias, so the slug's token
  // shape ("a-b-c") fed back as " a b c " usually surfaces the matching
  // title in the autocomplete (verified against "horimiya"). We require an
  // exact slug match in the response — anything looser risks silently
  // returning a different series for typo'd or stale slugs.
  const hits = await searchSeries(slug.replace(/[-_]+/g, ' '), { limit: 20 });
  const exact = hits.find(h => h && h.id === slug);
  if (exact) return exact;
  throw new Error(`MangaKakalot: no series found for slug "${slug}"`);
}

// Sentinel used by both gated calls. The downloader writes this to
// `download_jobs.error` and the scheduler writes it to `last_result`, so
// keep it short and user-actionable.
const GATED_ERR =
  'MangaKakalot chapter access is blocked by the site\'s Cloudflare ' +
  'challenge — chapter download is not supported from this source.';

async function getChapters(/* slug */) { throw new Error(GATED_ERR); }
async function getChapterImages(/* chapterId */) { throw new Error(GATED_ERR); }

module.exports = {
  id: 'mangakakalot',
  label: 'MangaKakalot',
  homepage: SITE_BASE,
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  GATED_ERROR: GATED_ERR,
  // Exported so tests can verify the alias normalisation matches the site's.
  _changeAlias: changeAlias,
};
