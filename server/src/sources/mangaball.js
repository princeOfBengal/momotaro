const fetch = require('node-fetch');

// MangaBall source adapter — full chapter download support, third source
// after MangaDex and WeebCentral with the complete download lifecycle.
//
// Reverse-engineering notes (verified end-to-end against the live site
// using Horimiya at /title-detail/horimiya-68517bef5a163752cfb9d159/):
//
//   The site is a PHP app at mangaball.net with a clean `/api/v1/` REST
//   surface guarded by Laravel-style CSRF. Three protections:
//
//     1. PHPSESSID cookie — set by any HTML page; required on every API
//        call.
//     2. CSRF token — embedded in every page as
//        `<meta name="csrf-token" content="...">`. Sent back as the
//        `X-CSRF-TOKEN` header on every API request.
//     3. X-Requested-With: XMLHttpRequest — the API rejects requests
//        without it (treated as cross-origin).
//
//   We warm a session lazily on first call and cache it for 10 minutes.
//   On 403 (CSRF token expired) we re-warm and retry once.
//
//   Endpoints used:
//
//     POST /api/v1/smart-search/search/                — search.
//        body (form-encoded): search_input={query}
//        Returns: {code:200, data:{manga:[{title, img, url, ...}, ...]}}
//
//     GET  /title-detail/{any-slug}-{ObjectId}/        — series detail
//                                                        (HTML scrape).
//                                                        The slug prefix
//                                                        is SEO; using a
//                                                        placeholder slug
//                                                        works because
//                                                        the site
//                                                        canonicalises.
//
//     POST /api/v1/chapter/chapter-listing-by-title-id/ — chapter list.
//        body (JSON): {title_id: "<24-hex ObjectId>"}
//        Returns: {code:200, ALL_CHAPTERS:[{number, number_float, title,
//                  translations: [{id, language, languageName, group,
//                  date, pages, url, volume}, ...]}, ...]}
//
//     GET  /chapter-detail/{translationObjectId}/       — chapter reader
//                                                        (HTML scrape).
//                                                        Image URLs are
//                                                        embedded inline
//                                                        in the response
//                                                        as <img src=…>
//                                                        from the
//                                                        heracross.red-
//                                                        and-blue.net
//                                                        image host.

const SITE_BASE = 'https://mangaball.net';
const USER_AGENT = 'Mozilla/5.0 (Momotaro/1.0; +https://github.com/momotaro)';
const REQUEST_INTERVAL_MS = 250;
// Re-warm session if it's older than this. The PHPSESSID + CSRF pair
// remains valid much longer in practice, but we don't want to hold a stale
// CSRF for hours and discover failure on the first download attempt.
const SESSION_TTL_MS = 10 * 60 * 1000;

let _lastRequestAt = 0;
let _session = null; // { csrf, cookieHeader, warmedAt }

// ── Cookie / session helpers ──────────────────────────────────────────────

/**
 * Parse a cookie string out of a Set-Cookie response header. We only need
 * `name=value` (everything before the first `;`) — domain/path/expiry are
 * irrelevant when we're echoing it back to the same origin.
 */
function parseCookies(setCookieHeader) {
  if (!setCookieHeader) return {};
  const lines = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader.split(/,(?=[^;]+=)/);
  const out = {};
  for (const line of lines) {
    const m = line.match(/^\s*([^=;\s]+)=([^;]*)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function cookieHeaderFromMap(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Pace + execute a fetch. Mangaball has no published rate limit; the 250ms
 * floor matches the rest of our adapters.
 */
async function pacedFetch(url, options = {}) {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  return fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      'User-Agent':       USER_AGENT,
      'Accept-Language':  'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
  });
}

/**
 * Pull a fresh CSRF token + session cookie. Cached for SESSION_TTL_MS.
 *
 * Two-step warmup: hit the homepage to grab PHPSESSID, then visit a
 * title-detail page to grab the matching csrf-token meta. The CSRF rotates
 * per-page-load against the session cookie, so the order matters — token
 * obtained without a session would be rejected on the next API call.
 */
async function warmupSession({ force = false } = {}) {
  if (!force && _session && Date.now() - _session.warmedAt < SESSION_TTL_MS) {
    return _session;
  }
  // Step 1: home → PHPSESSID
  const homeResp = await pacedFetch(`${SITE_BASE}/`, {
    headers: { 'Accept': 'text/html,*/*;q=0.8' },
  });
  if (!homeResp.ok) {
    throw new Error(`MangaBall warmup ${homeResp.status} on homepage`);
  }
  const cookies = parseCookies(homeResp.headers.raw()['set-cookie']);
  const html = await homeResp.text();
  const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  if (!m) throw new Error('MangaBall warmup: csrf-token meta not found on homepage');
  _session = {
    csrf:         m[1],
    cookieHeader: cookieHeaderFromMap(cookies),
    warmedAt:     Date.now(),
  };
  return _session;
}

/**
 * Run an API request with the warmed session. On 403/419 (CSRF rejection
 * patterns), re-warm and retry once. On any other non-2xx, throw with the
 * site's own error payload when it's JSON.
 */
async function apiRequest(path, { method = 'POST', json, form, headers = {}, accept = 'application/json' } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await warmupSession({ force: attempt > 0 });
    const opts = {
      method,
      headers: {
        'Cookie':            session.cookieHeader,
        'X-CSRF-TOKEN':      session.csrf,
        'X-Requested-With':  'XMLHttpRequest',
        'Accept':            accept,
        'Referer':           SITE_BASE + '/',
        ...headers,
      },
    };
    if (json !== undefined) {
      opts.body = JSON.stringify(json);
      opts.headers['Content-Type'] = 'application/json';
    } else if (form !== undefined) {
      opts.body = new URLSearchParams(form).toString();
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const resp = await pacedFetch(SITE_BASE + path, opts);
    if (resp.status === 403 || resp.status === 419) {
      if (attempt === 0) continue; // refresh & retry
    }
    if (!resp.ok && resp.status !== 200) {
      const body = await resp.text().catch(() => '');
      throw new Error(`MangaBall ${resp.status} ${path}: ${body.slice(0, 200)}`);
    }
    if (accept === 'application/json') {
      const data = await resp.json();
      if (data && typeof data === 'object' && data.code && data.code !== 200) {
        throw new Error(`MangaBall ${data.code}: ${data.message || 'API error'}`);
      }
      return data;
    }
    return resp.text();
  }
  throw new Error('MangaBall: session refresh failed');
}

/**
 * Same retry/refresh story as apiRequest, but for plain HTML page scrapes
 * (series detail page, chapter detail page). These don't fail with CSRF
 * codes but we still want the cookie session to be warmed for consistency.
 */
async function htmlGet(url) {
  const session = await warmupSession();
  const resp = await pacedFetch(url, {
    headers: {
      'Cookie':            session.cookieHeader,
      'Accept':            'text/html,application/xhtml+xml,*/*;q=0.8',
      'Referer':           SITE_BASE + '/',
    },
  });
  if (!resp.ok) {
    throw new Error(`MangaBall ${resp.status} ${url}`);
  }
  return resp.text();
}

// ── HTML helpers ──────────────────────────────────────────────────────────

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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripHtml(s) {
  if (!s) return s;
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function seriesUrl(id) {
  // `series-` is a placeholder slug; the site canonicalises to the real
  // title slug on first hit, so any non-empty prefix works.
  return id ? `${SITE_BASE}/title-detail/series-${id}/` : null;
}

/**
 * The site's title strings come heavily SEO-padded ("Horimiya Online Free
 * - Horimiya / Hori-san to Miyamura-kun / [20 alternates] Multiple
 * Languages"). The JSON-LD `caption` field on the series page carries the
 * clean title; for search results we apply a best-effort strip of the
 * "Online Free" suffix and split on "/" to take the canonical first form.
 */
function cleanTitle(rawTitle) {
  if (!rawTitle) return null;
  let t = String(rawTitle).trim();
  // Strip "Online Free - " suffix from og:title
  t = t.replace(/\s+Online\s+Free\s*-\s*/i, ' ');
  // If multiple alt titles separated by " / ", keep the first that looks
  // like a real title (alphanumeric latin)
  const parts = t.split(/\s*\/\s*/);
  if (parts.length > 1) {
    const latinFirst = parts.find(p => /[A-Za-z]/.test(p));
    if (latinFirst) t = latinFirst.trim();
  }
  // Trailing "Multiple Languages" or trailing parenthetical noise.
  t = t.replace(/\s*Multiple\s*Languages\s*$/i, '').trim();
  t = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return t;
}

// ── Search ────────────────────────────────────────────────────────────────

/**
 * Each result has:
 *   img:     cover URL
 *   title:   long pile of alt titles separated by " / "
 *   status:  HTML span (badge-status) — strip for "Completed"/"Ongoing"
 *   url:     "/title-detail/{slug}-{ObjectId}/"
 *   views, followers, rating
 */
function normalizeSearchHit(item) {
  if (!item || !item.url) return null;
  const idMatch = item.url.match(/-([a-f0-9]{24})\/?$/i);
  if (!idMatch) return null;
  return {
    id:           idMatch[1],
    title:        cleanTitle(item.title),
    description:  null,
    author:       null,
    year:         null,
    status:       stripHtml(item.status) || null,
    content_rating: null,
    genres:       [],
    cover_url:    item.img || null,
    series_url:   seriesUrl(idMatch[1]),
    last_chapter: null,
    available_languages: ['en'],
  };
}

async function searchSeries(query, { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const data = await apiRequest('/api/v1/smart-search/search/', {
    form: { search_input: query.trim() },
  });
  const items = data?.data?.manga || [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return items.slice(0, cap).map(normalizeSearchHit).filter(Boolean);
}

// ── Series detail ─────────────────────────────────────────────────────────

/**
 * Pull what we can from the series page. The site renders most of the
 * side-panel metadata via JS from a bundle that doesn't expose its data
 * source on the wire — but the JSON-LD caption + og: meta carry the
 * essentials (title, cover, description), and the chapter listing API
 * gives us the rest at scheduling time.
 */
async function getSeries(id) {
  if (!id) throw new Error('id is required');
  const html = await htmlGet(`${SITE_BASE}/title-detail/series-${encodeURIComponent(id)}/`);
  return parseSeriesHtml(html, id);
}

function parseSeriesHtml(html, id) {
  // JSON-LD ImageObject often includes a clean caption
  let title = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const obj = JSON.parse(m[1].trim());
      const graph = obj['@graph'] || [obj];
      for (const node of graph) {
        if (node['@type'] === 'ImageObject' && node.caption) {
          title = node.caption;
          break;
        }
      }
      if (title) break;
    } catch { /* ignore parse error on one block */ }
  }
  if (!title) {
    const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (ogTitle) title = cleanTitle(decodeEntities(ogTitle[1]));
  }

  // Description is the same SEO-padded blob as og:title; we don't surface
  // it here — the user-facing UI typically prefers the AniList/MAL
  // description anyway, and propagating mangaball's noise would just
  // pollute the metadata source picker.
  const cover = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1] || null;

  return {
    id,
    title,
    description:    null,
    author:         null,
    year:           null,
    status:         null,
    content_rating: null,
    genres:         [],
    cover_url:      cover ? decodeEntities(cover) : null,
    series_url:     seriesUrl(id),
    last_chapter:   null,
    available_languages: ['en'],
  };
}

// ── Chapter list ──────────────────────────────────────────────────────────

const CHAPTER_DETAIL_RE = /\/chapter-detail\/([a-f0-9]{24})\/?/i;

/**
 * Walk the per-language translations array, emitting one chapter entry per
 * (language, group) pair so the scheduler can reason about each
 * translation independently. Mirrors mangadex's contract — the queue's
 * source_chapter_id is the per-translation ObjectId, which uniquely
 * identifies what to fetch when getChapterImages is called.
 */
async function getChapters(titleId, { languages = ['en'] } = {}) {
  if (!titleId) throw new Error('titleId is required');
  const data = await apiRequest('/api/v1/chapter/chapter-listing-by-title-id/', {
    json: { title_id: titleId },
  });
  const list = data?.ALL_CHAPTERS || [];
  const langSet = new Set(languages.map(l => l.toLowerCase()));
  const out = [];
  for (const row of list) {
    const number = Number.isFinite(row?.number_float) ? row.number_float : null;
    const translations = Array.isArray(row?.translations) ? row.translations : [];
    for (const tr of translations) {
      const lang = String(tr?.language || '').toLowerCase();
      if (!langSet.has(lang)) continue;
      const idMatch = String(tr?.url || '').match(CHAPTER_DETAIL_RE);
      const chapterId = tr?.id || idMatch?.[1];
      if (!chapterId) continue;
      const volRaw = tr?.volume;
      const volume = Number.isFinite(volRaw) && volRaw > 0 ? volRaw : null;
      out.push({
        id:           chapterId,
        number,
        volume,
        title:        tr?.name || row?.title || null,
        language:     lang,
        pages:        Number.isFinite(tr?.pages) ? tr.pages : 0,
        published_at: tr?.date || null,
        group:        tr?.group?.name || null,
        external_url: null,
      });
    }
  }
  // Sort oldest-first by chapter number, matching the mangadex adapter
  // contract so the scheduler diff sees a consistent shape.
  out.sort((a, b) => {
    const ca = a.number ?? Number.POSITIVE_INFINITY;
    const cb = b.number ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return String(a.published_at || '').localeCompare(String(b.published_at || ''));
  });
  return out;
}

// ── Chapter images ────────────────────────────────────────────────────────

const IMAGE_HOSTS = [
  'heracross.red-and-blue.net',
  // Mangaball rotates image hosts (poke-themed pokemon cdn names); accept
  // any subdomain off these known parent domains.
  'red-and-blue.net',
  'poke-black-and-white.net',
];

/**
 * Returns the same `{ files, base_url, hash, data_saver_files }` shape the
 * mangadex adapter does so the downloader worker doesn't need a per-source
 * branch for image fetching. The chapter-detail HTML page directly carries
 * every page image URL inline from the heracross.* CDN — verified live at
 * /chapter-detail/699c8cfb009699b10eacbd6e/ which yielded all 16 .webp
 * pages, each ~230 KB of valid RIFF/WEBP bytes.
 */
async function getChapterImages(chapterId) {
  if (!chapterId) throw new Error('chapterId is required');
  const html = await htmlGet(`${SITE_BASE}/chapter-detail/${encodeURIComponent(chapterId)}/`);
  // Pull every CDN image URL on the page. Many of the small UI elements
  // (cover thumbnails on the "next chapter" rail, language flags) live on
  // bulbasaur.* — those have a `/covers/` or `/storage/groups/` path that
  // we exclude. The actual page images all live under `/storage/{titleId}/...`.
  const seen = new Set();
  const files = [];
  for (const m of html.matchAll(/https?:\/\/[a-z0-9.-]+\.(?:red-and-blue|black-and-white|poke[a-z-]*)\.net\/storage\/[a-f0-9]{24}\/[^"\s'<>]+\.(?:jpe?g|png|webp)/gi)) {
    const u = m[0];
    if (seen.has(u)) continue;
    seen.add(u);
    files.push(u);
  }
  if (files.length === 0) {
    throw new Error('MangaBall returned no images for this chapter');
  }
  return {
    base_url:         '',
    hash:             '',
    files,
    data_saver_files: [],
  };
}

module.exports = {
  id: 'mangaball',
  label: 'MangaBall',
  homepage: SITE_BASE,
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  // Exposed for tests
  _warmupSession: warmupSession,
  _parseSearchHits: (data) => (data?.data?.manga || []).map(normalizeSearchHit).filter(Boolean),
  _cleanTitle: cleanTitle,
  // Reset session cache (mostly useful between tests)
  _resetSession: () => { _session = null; },
};
