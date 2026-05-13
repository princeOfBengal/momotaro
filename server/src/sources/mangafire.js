const fetch = require('node-fetch');

// MangaFire source adapter.
//
// Reverse-engineering notes (verified against the live site at mangafire.to):
//
//   OPEN — straight HTML, no auth or token needed:
//     GET /manga/{slug}.{hid}                — series detail page; the FULL
//                                              chapter list (per language) is
//                                              embedded inline as static HTML.
//
//   GATED — return HTTP 403 "Request is invalid":
//     GET /filter?keyword=…                  — title search
//     GET /ajax/read/chapter/{mangaId}       — page-list AJAX (Cloudflare
//                                              Turnstile token required;
//                                              site key is embedded in the
//                                              reader page as
//                                              `var captchaKey = '0x4AAAAAAA…'`)
//
// What this adapter therefore supports today:
//   searchSeries        ⚠️  accepts a mangafire URL pasted as the query;
//                          returns [seriesFromUrl]. Direct keyword search
//                          throws an explainer because /filter is gated.
//   getSeries           ✅ scrapes the series HTML page
//   getChapters         ✅ scrapes the chapter list embedded in the series
//                          HTML — supports per-language filtering by
//                          re-fetching with `?language=XX` if needed,
//                          though the default page already includes EN.
//   getChapterImages    ❌ throws GATED_ERROR (Turnstile gate)
//   seriesUrl           ✅
//
// Same partial-support pattern as comixto.js / mangakakalot.js: any download
// attempt surfaces the gated-error string in `download_jobs.error` and
// `manga_schedules.last_result`. The crucial scheduler use-case still works
// because we CAN list chapters and diff against local — only the actual
// image download is unavailable. Pair the mangafire URL with a MangaDex URL
// on the same manga (URL store allows multiple URLs per manga) for actual
// downloading.

const SITE_BASE = 'https://mangafire.to';
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
      'User-Agent':      USER_AGENT,
      'Accept':          options.json ? 'application/json' : 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    throw new Error(`MangaFire ${resp.status} for ${url}`);
  }
  return options.json ? resp.json() : resp.text();
}

function seriesUrl(id) {
  return id ? `${SITE_BASE}/manga/${id}` : null;
}

// ── HTML helpers ───────────────────────────────────────────────────────────
//
// The site uses static server-rendered HTML for the series page, so a
// handful of small regexes cover everything. No need for a full HTML parser
// dependency — every selector below is anchored on stable attribute strings
// that the site itself writes from server-side templates (`og:title`,
// `data-name="chapter"`, `data-number="…"`, etc.).

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

function pickMeta(html, property) {
  const re = new RegExp(`<meta\\s+property="${property}"\\s+content="([^"]+)"`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Very tolerant text extractor: picks the first match for a simple tag-with-
 * inner-text pattern. Used for the `<title>` and the inline JSON page-info
 * blob — both are stable on the live site.
 */
function pickText(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

/**
 * Extract a clean series title from the `og:title` (the on-page title is
 * "Horimiya Manga - Read Manga Online Free" — strip the suffix).
 */
function cleanSeriesTitle(rawTitle) {
  if (!rawTitle) return null;
  return rawTitle
    .replace(/\s*Manga\s*[-–]\s*Read Manga Online Free\s*$/i, '')
    .trim();
}

// ── Series detail ──────────────────────────────────────────────────────────

/**
 * Fetch the series detail page HTML and turn it into the same normalised
 * series shape every adapter exports.
 *
 * @param {string} id  the {slug}.{hid} composite from the URL
 */
async function getSeries(id) {
  if (!id) throw new Error('id is required');
  const html = await pacedFetch(`${SITE_BASE}/manga/${id}`);
  return parseSeriesHtml(html, id);
}

function parseSeriesHtml(html, id) {
  const ogTitle = pickMeta(html, 'og:title');
  // Prefer the on-page <h1 itemprop="name"> — it's the bare series title; the
  // og:title carries the SEO suffix ("Horimiya Manga - Read Manga Online Free")
  // which we'd otherwise have to strip.
  const title = pickText(html, /<h1[^>]*itemprop="name"[^>]*>([^<]+)<\/h1>/)
    || cleanSeriesTitle(ogTitle);
  const description = pickMeta(html, 'og:description')
    || pickText(html, /<meta\s+name="description"\s+content="([^"]+)"/);

  // Cover image — the poster div is the canonical source on this site
  // (og:image isn't always set). The <img itemprop="image"> attribute lets
  // us pinpoint the actual poster, not banner/logo images elsewhere.
  const cover = pickText(html, /<img[^>]*itemprop="image"[^>]*src="([^"]+)"/)
    || pickText(html, /<div\s+class="poster"[^>]*>\s*<div>\s*<img[^>]*src="([^"]+)"/i)
    || pickMeta(html, 'og:image');

  // Per-language chapter counts come from the dropdown items:
  //   <a class="dropdown-item active" href="#" data-code="EN" data-title="English"> <i class="flag EN"></i> English (254 Chapters) </a>
  // The same dropdown is rendered twice (chapter-by-language switcher and
  // volume-by-language switcher) — dedupe by code so the result is clean.
  const langSeen = new Set();
  const languages = [];
  for (const m of html.matchAll(/data-code="([A-Z-]+)"[^>]*data-title="([^"]+)"/g)) {
    const code = m[1].toLowerCase();
    if (langSeen.has(code)) continue;
    langSeen.add(code);
    languages.push({ code, name: decodeEntities(m[2]) });
  }

  // Status — renders as a bare <p>Completed</p> at the top of the .info
  // div, not via a "Status:" label like other sites.
  const statusFromInfo = pickText(
    html,
    /<div\s+class="info"[^>]*>\s*<p>([^<]+)<\/p>/
  );

  // Author / type from labelled rows. Mangafire renders these in
  // <div>Status:<a>Releasing</a></div> patterns. Stay tolerant of whitespace.
  const findInfo = (label) => {
    const re = new RegExp(label + ':?[\\s\\S]{0,50}?<a[^>]*>([^<]+)<\\/a>', 'i');
    const m = html.match(re);
    return m ? decodeEntities(m[1]).trim() : null;
  };

  return {
    id,
    title,
    description,
    author:           findInfo('Author'),
    year:             null,
    status:           statusFromInfo,
    content_rating:   null,
    genres:           [],
    cover_url:        cover,
    series_url:       seriesUrl(id),
    last_chapter:     null,        // computed by caller from chapter list if needed
    available_languages: languages.map(l => l.code),
  };
}

// ── Chapter list ───────────────────────────────────────────────────────────

/**
 * Scrape the chapter list embedded on the series page. Returns one entry per
 * chapter row in the requested language(s).
 *
 * Each `<li class="item" data-number="N"><a href="/read/{slug}/{lang}/chapter-N"
 * title="Vol X - Chap N"><span>Chapter N: title</span><span>date</span></a></li>`
 * — only the EN list is rendered when no `?language=` is on the request URL,
 * so we re-fetch per language when the caller asks for non-EN.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {string[]} [opts.languages=['en']]
 */
async function getChapters(id, { languages = ['en'] } = {}) {
  if (!id) throw new Error('id is required');
  const out = [];
  const seen = new Set();
  for (const lang of languages) {
    const url = lang === 'en'
      ? `${SITE_BASE}/manga/${id}`
      : `${SITE_BASE}/manga/${id}?language=${encodeURIComponent(lang)}`;
    const html = await pacedFetch(url);
    const chapters = parseChapterList(html, id, lang);
    for (const c of chapters) {
      const key = `${c.id}|${c.language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  // Stable sort: volume → number → published_at, matching the mangadex shape
  // so the scheduler's diff doesn't have to know about per-source ordering.
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

function parseChapterList(html, id, language) {
  const out = [];
  // Match each <li class="item" data-number="…"> ... </li>. Dates are in the
  // second <span>; titles in the first; volume in the anchor's title attr.
  const liRe = /<li\s+class="item"\s+data-number="([^"]+)">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const number = parseFloat(m[1]);
    if (!Number.isFinite(number)) continue;
    const inner = m[2];

    const hrefMatch = inner.match(/<a\s+href="(\/read\/[^"]+)"\s+title="([^"]*)"/);
    if (!hrefMatch) continue;
    const href     = hrefMatch[1];
    const titleAtt = hrefMatch[2];

    // Title attr is "Vol X -  Chap N" or "Vol 0 -  Chap N" etc. Pull the volume.
    const volMatch = titleAtt.match(/Vol\s*(\d+(?:\.\d+)?)/i);
    const volume = volMatch ? parseFloat(volMatch[1]) : null;
    // Vol 0 in the title is mangafire's placeholder for "no volume info";
    // normalise it to null so the scheduler doesn't treat it as a real volume.
    const cleanedVolume = (volume === 0) ? null : (Number.isFinite(volume) ? volume : null);

    // Display title from the first inner <span> ("Chapter N: subtitle")
    const spans = [...inner.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(s => decodeEntities(s[1]).trim());
    const displayTitle = spans[0] || null;
    // Strip the "Chapter N:" prefix to leave just the subtitle.
    const subtitle = displayTitle
      ? displayTitle.replace(/^chapter\s+[\d.]+\s*[:\-]?\s*/i, '').trim()
      : null;
    const publishedAt = spans[1] || null;

    out.push({
      // Internal id used by the queue's source_chapter_id column. The href
      // is unique per (slug.hid, language, chapter-number) so it doubles as
      // a stable opaque id and tells the worker exactly where to find the
      // images when the Turnstile gate is eventually bypassed.
      id:           href,
      number,
      volume:       cleanedVolume,
      title:        subtitle || null,
      language,
      pages:        0,
      published_at: publishedAt,
      group:        null,
      external_url: null,
    });
  }
  return out;
}

// ── Search ─────────────────────────────────────────────────────────────────

const URL_LIKE = /^https?:\/\/(www\.)?mangafire\.to\//i;

/**
 * Direct keyword search via /filter is server-blocked (HTTP 403 in every
 * shape we've probed). The functional substitute: detect when the user
 * pasted a mangafire URL into the search box, parse it, and synthesise a
 * single-result list from the series detail page. Anything else throws a
 * clear explainer so the UI surfaces actionable instructions.
 */
async function searchSeries(query, /* { limit } */) {
  if (!query || !query.trim()) return [];
  const trimmed = query.trim();
  if (URL_LIKE.test(trimmed)) {
    const m = trimmed.match(/\/(?:manga|read)\/([a-z0-9_-]+\.[a-z0-9]+)/i);
    if (!m) {
      throw new Error('MangaFire: that URL doesn\'t look like a series page (expected /manga/{slug}.{hid}).');
    }
    const id = m[1];
    try {
      const series = await getSeries(id);
      return [series];
    } catch (err) {
      throw new Error(`MangaFire: couldn't load that URL — ${err.message}`);
    }
  }
  throw new Error(
    'MangaFire keyword search is blocked at the source (HTTP 403 on /filter). ' +
    'Paste a https://mangafire.to/manga/{slug}.{hid} URL into the search box instead — ' +
    'the rest of the flow (chapter list, scheduling, URL recording) works.'
  );
}

// Sentinel used by the gated image endpoint. The downloader writes this to
// download_jobs.error and the scheduler to last_result, so the UI surfaces
// it inline.
const GATED_ERR =
  'MangaFire chapter images are loaded behind a Cloudflare Turnstile ' +
  'challenge — chapter download is not supported from this source.';

async function getChapterImages(/* readUrlPath */) {
  throw new Error(GATED_ERR);
}

module.exports = {
  id: 'mangafire',
  label: 'MangaFire',
  homepage: SITE_BASE,
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  GATED_ERROR: GATED_ERR,
  // Exposed for tests
  _parseSeriesHtml: parseSeriesHtml,
  _parseChapterList: parseChapterList,
};
