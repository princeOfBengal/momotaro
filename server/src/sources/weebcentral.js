const fetch = require('node-fetch');

// WeebCentral source adapter — the second source after MangaDex with FULL
// support including chapter image download.
//
// Reverse-engineering notes (verified end-to-end against the live site
// using Horimiya at /series/01J76XY7PBJ0A3GC5PC79VET42):
//
//   OPEN — straight HTML/HTMX, no auth, no Cloudflare gate, no token
//   challenge:
//
//     POST /search/simple?location=main           — autocomplete-style
//        body:  text={url-encoded query}             search; HTMX fragment
//        Returns:                                    with one anchor per hit
//          <a href="…/series/{ULID}/{slug}"> ... </a>
//
//     GET  /series/{ULID}                         — series detail (HTML).
//                                                   Slug-less URL works
//                                                   identically to the
//                                                   slugged form.
//
//     GET  /series/{ULID}/full-chapter-list       — full chapter list as
//                                                   HTML fragment (HTMX).
//                                                   ~136 chapter <div>s for
//                                                   Horimiya, each carrying
//                                                   the chapter ULID via
//                                                   <a href="…/chapters/{ULID}">,
//                                                   the publish timestamp via
//                                                   x-data="checkNewChapter('ISO8601')",
//                                                   and the label via
//                                                   <span class="">Page. N</span>.
//
//     GET  /chapters/{ULID}/images?reading_style=long_strip
//                                                 — page list as an HTML
//                                                   fragment of <img src="
//                                                   https://official.lowee.us/manga/{Title}/{NNNN-NNN}.png">.
//                                                   Without the
//                                                   reading_style query the
//                                                   endpoint 307s into a
//                                                   400 page; the SPA's
//                                                   reader sets it from a
//                                                   form, we mirror that.
//
//   The image host (official.lowee.us) serves files openly with no token —
//   verified end-to-end with `curl … 0130-001.png` returning 235 KB of
//   real image bytes.
//
// What this adapter therefore supports today:
//   searchSeries        ✅ live HTMX endpoint, parses anchors out of fragment
//   getSeries           ✅ scrapes /series/{ULID}
//   getChapters         ✅ scrapes /series/{ULID}/full-chapter-list
//   getChapterImages    ✅ scrapes /chapters/{ULID}/images?reading_style=…
//   seriesUrl           ✅
//
// Same shape as the MangaDex adapter — slot-in compatible with the
// downloader queue and the scheduler diff path.

const SITE_BASE  = 'https://weebcentral.com';
const USER_AGENT = 'Mozilla/5.0 (Momotaro/1.0; +https://github.com/momotaro)';
const REQUEST_INTERVAL_MS = 250;

let _lastRequestAt = 0;

async function pacedFetch(url, options = {}) {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - _lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();

  const resp = await fetch(url, {
    redirect:   'follow',
    ...options,
    headers: {
      'User-Agent':       USER_AGENT,
      'Accept':           'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language':  'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    throw new Error(`WeebCentral ${resp.status} for ${url}`);
  }
  return resp.text();
}

function seriesUrl(id) {
  return id ? `${SITE_BASE}/series/${id}` : null;
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function pickMeta(html, property) {
  const re = new RegExp(`<meta\\s+property="${property}"\\s+content="([^"]+)"`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Strip the " | Weeb Central" SEO suffix the og:title carries, leaving the
 * bare series title. The on-page <h1> would also work but isn't always
 * unique on the series detail page (sub-headers reuse the tag).
 */
function cleanSeriesTitle(rawTitle) {
  if (!rawTitle) return null;
  return rawTitle.replace(/\s*\|\s*Weeb\s*Central\s*$/i, '').trim();
}

// ── Search ─────────────────────────────────────────────────────────────────

const SLUG_LIKE = /\/series\/([0-9A-HJKMNP-TV-Z]{26})(?:\/([^"\s/]+))?/i;

/**
 * Parse the HTMX autocomplete-search fragment that POST /search/simple
 * returns. Each hit is an <a href="…/series/{ULID}/{slug}"> with an inline
 * cover and the title text.
 */
function parseSearchHits(fragmentHtml) {
  const hits = [];
  const seen = new Set();
  const aRe = /<a\s+href="([^"]+\/series\/[^"]+)"[\s\S]*?<\/a>/g;
  let m;
  while ((m = aRe.exec(fragmentHtml)) !== null) {
    const href = m[0].match(/href="([^"]+)"/)?.[1];
    const slug = href?.match(SLUG_LIKE);
    if (!slug) continue;
    const id = slug[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);

    // Cover URL inside the <picture>; either the .webp source or the .jpg fallback.
    const cover =
      m[0].match(/<source[^>]+srcset="([^"]+)"/)?.[1] ||
      m[0].match(/<img[^>]+src="([^"]+)"/)?.[1] ||
      null;

    // Title is the trailing text inside the inner div with line-clamp-2.
    let titleText = m[0].match(/<div[^>]*line-clamp-2[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (titleText) titleText = decodeEntities(titleText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

    hits.push({
      id,
      title:        titleText || null,
      description:  null,
      author:       null,
      year:         null,
      status:       null,
      content_rating: null,
      genres:       [],
      cover_url:    cover,
      series_url:   seriesUrl(id),
      last_chapter: null,
      available_languages: ['en'],
    });
  }
  return hits;
}

async function searchSeries(query, { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const body = new URLSearchParams({ text: query.trim() });
  const html = await pacedFetch(`${SITE_BASE}/search/simple?location=main`, {
    method: 'POST',
    body:    body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'HX-Request':   'true',
      'Referer':      SITE_BASE + '/',
    },
  });
  const hits = parseSearchHits(html);
  return hits.slice(0, Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50));
}

// ── Series detail ──────────────────────────────────────────────────────────

async function getSeries(id) {
  if (!id) throw new Error('id is required');
  const html = await pacedFetch(`${SITE_BASE}/series/${encodeURIComponent(id)}`);
  return parseSeriesHtml(html, id);
}

function parseSeriesHtml(html, id) {
  const ogTitle = pickMeta(html, 'og:title');
  const title   = cleanSeriesTitle(ogTitle);
  const description = pickMeta(html, 'og:description')
    || pickText(html, /<meta\s+name="description"\s+content="([^"]+)"/);
  const cover   = pickMeta(html, 'og:image');

  // Side-panel labelled rows:
  //   <li>...<strong>Author(s):</strong>HAGIWARA Daisuke , HERO</li>
  //   <li>...<strong>Status:</strong>Complete</li>
  //   <li>...<strong>Released:</strong>2011</li>
  //   <li>...<strong>Type:</strong>Manga</li>
  // The values can contain anchor tags (linked authors / tags), so strip
  // any inner HTML before returning.
  const meta = {};
  for (const m of html.matchAll(/<strong>\s*([A-Za-z()\s/]+?)\s*:\s*<\/strong>([\s\S]{0,800}?)<\/li>/g)) {
    const label = m[1].trim();
    const text  = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text) meta[label] = text;
  }

  // Genres are listed under "Tag(s):" or "Tags:" on the side panel (anchor
  // links to /search?included_tag=…). Pull every distinct tag.
  const tagSet = new Set();
  for (const m of html.matchAll(/href="[^"]*included_tag=([^"&]+)"/g)) {
    tagSet.add(decodeURIComponent(m[1].replace(/\+/g, ' ')));
  }

  const yearRaw = meta['Released'];
  const year = yearRaw ? parseInt(yearRaw, 10) : null;

  return {
    id,
    title,
    description,
    author:           meta['Author(s)'] || meta['Author'] || null,
    year:             Number.isFinite(year) ? year : null,
    status:           meta['Status'] || null,
    content_rating:   meta['Adult Content'] === 'Yes' ? 'pornographic' : null,
    genres:           [...tagSet],
    cover_url:        cover,
    series_url:       seriesUrl(id),
    last_chapter:     null,
    available_languages: ['en'],
  };
}

function pickText(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

// ── Chapter list ───────────────────────────────────────────────────────────

/**
 * Scrape the chapter list returned by /series/{id}/full-chapter-list.
 *
 * The fragment is a series of <div class="flex items-center" x-data="…">
 * blocks — one per chapter. Each block contains:
 *   - the chapter ULID via <a href="https://weebcentral.com/chapters/{ULID}">
 *   - the chapter label via the first <span class="">Page. N</span>
 *   - the publish timestamp via the x-data="checkNewChapter('ISO8601')" attr
 *
 * Returns chapters in chronological order (oldest first), matching the
 * mangadex adapter's contract so the scheduler diff sees a consistent shape.
 */
async function getChapters(id /*, opts */) {
  if (!id) throw new Error('id is required');
  const html = await pacedFetch(
    `${SITE_BASE}/series/${encodeURIComponent(id)}/full-chapter-list`,
    { headers: { 'HX-Request': 'true', 'Referer': `${SITE_BASE}/series/${id}` } },
  );
  return parseChapterList(html);
}

function parseChapterList(html) {
  const out = [];
  // Each chapter block starts at `<div class="flex items-center" x-data=`.
  // Splitting on that boundary makes each block self-contained.
  const blocks = html.split(/<div class="flex items-center"\s+x-data=/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const dateM = block.match(/checkNewChapter\('([^']+)'\)/);
    const urlM  = block.match(/href="(https:\/\/weebcentral\.com\/chapters\/[0-9A-HJKMNP-TV-Z]{26})"/i);
    if (!urlM) continue;
    const labelM = block.match(/<span class="">([^<]+)<\/span>/);
    const label  = labelM ? decodeEntities(labelM[1]).trim() : null;

    // Pull the numeric chapter from labels like "Page. 130", "Chapter 5",
    // "Vol 1 Chap 3" etc. The first standalone number wins.
    let number = null;
    if (label) {
      const numM = label.match(/(\d+(?:\.\d+)?)/);
      if (numM) number = parseFloat(numM[1]);
    }

    const chapterUlid = urlM[1].split('/').pop().toUpperCase();
    out.push({
      // The ULID is the stable opaque identifier the worker passes back to
      // getChapterImages — mirrors mangadex's chapter id contract.
      id:           chapterUlid,
      number,
      volume:       null,    // weebcentral doesn't expose volume info on chapter rows
      title:        label,
      language:     'en',    // every weebcentral chapter is English
      pages:        0,
      published_at: dateM?.[1] || null,
      group:        null,
      external_url: null,
    });
  }
  // Site renders newest first; flip so the scheduler diff (which iterates
  // missing-on-local) sees the lowest chapter number first, matching the
  // mangadex adapter's order.
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
 * Resolve the per-page image URLs for a chapter ULID. The /images endpoint
 * 307s into a 400 page without `reading_style=long_strip`, which the SPA
 * sets via a hidden form before triggering the HTMX swap — we mirror that.
 *
 * Returns the same `{ files, base_url, hash, data_saver_files }` shape the
 * mangadex adapter does, so the downloader worker doesn't need a per-source
 * branch for image fetching. `base_url` and `hash` are unused at the worker
 * level (they're mangadex-specific) but kept in the shape for parity.
 */
async function getChapterImages(chapterId) {
  if (!chapterId) throw new Error('chapterId is required');
  const html = await pacedFetch(
    `${SITE_BASE}/chapters/${encodeURIComponent(chapterId)}/images?reading_style=long_strip`,
    {
      headers: {
        'HX-Request': 'true',
        'Referer':    `${SITE_BASE}/chapters/${chapterId}`,
      },
    },
  );
  // Each page is an <img src="https://official.lowee.us/manga/{Title}/{NNNN-NNN}.png">
  // (or .jpg/.webp). The `onerror` fallback img also matches the <img src=…>
  // pattern, so anchor on src= and exclude the static broken_image asset.
  const files = [];
  for (const m of html.matchAll(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpe?g|png|webp))"/gi)) {
    const u = decodeEntities(m[1]);
    if (u.includes('/static/images/')) continue;
    files.push(u);
  }
  if (files.length === 0) {
    throw new Error('WeebCentral returned no images for this chapter');
  }
  return {
    base_url:         '',
    hash:             '',
    files,
    data_saver_files: [],
  };
}

module.exports = {
  id: 'weebcentral',
  label: 'WeebCentral',
  homepage: SITE_BASE,
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  // Exposed for tests
  _parseSearchHits: parseSearchHits,
  _parseSeriesHtml: parseSeriesHtml,
  _parseChapterList: parseChapterList,
};
