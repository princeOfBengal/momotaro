const fetch = require('node-fetch');
const { createPacer } = require('./_pacer');

// Shared base for the "MangaBox" family of sites (MangaKakalot, Manganato /
// Natomanga, and their many mirrors). These are all the same codebase operated
// by the same group, so they expose an identical surface:
//
//   GET  /home/search/json?searchword={alias}     — title autocomplete (JSON)
//   GET  /manga/{slug}                            — series detail (HTML)
//   GET  /api/manga/{slug}/chapters?limit=-1      — chapter list (JSON)
//   GET  /manga/{slug}/{chapterSlug}              — reader page (HTML). Image
//        URLs live in inline `cdns = [...]` / `chapterImages = [...]` script
//        arrays; the actual files are served from a shared *.2xstorage.com CDN.
//
// This mirrors the structure of Mihon/keiyoushi's `MangaBox` multisrc theme
// (lib-multisrc/mangabox) — one base class, thin per-site subclasses that only
// supply the domain(s). We learned the chapter-API and reader-array shapes
// directly from that extension's `Mangakakalot.kt` / `MangaBox.kt`.
//
// Cloudflare note: the operator puts an interactive JS challenge in front of
// *some* hosts/paths but not others. Crucially the challenge is per-host, and
// for every series there is at least one mirror that serves the search JSON,
// the chapters JSON, the series HTML, and the reader HTML without a challenge.
// Each adapter is therefore configured with the specific hosts that are open
// for each surface (they can differ — e.g. for Natomanga the search JSON is
// open on natomanga.com while the HTML/API is open on manganato.gg). The
// image CDN validates the Referer against the family's domains, so the
// adapter exports `IMAGE_HEADERS` for the downloader to send on image fetches.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_INTERVAL_MS = 300;

// ── HTML / string helpers ────────────────────────────────────────────────────

function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mirror of the site's own `change_alias()` JS — lowercases, folds Vietnamese /
 * Unicode diacritics, and replaces every punctuation/space run with `_`. The
 * search endpoint returns nothing for raw queries with spaces or uppercase, so
 * what we send has to match what the browser autocomplete sends.
 */
function changeAlias(input) {
  let str = String(input || '').toLowerCase();
  str = str.normalize('NFD').replace(/\p{M}/gu, '');
  str = str.replace(/đ/g, 'd');
  str = str.replace(/[^a-z0-9]+/g, '_');
  str = str.replace(/_+/g, '_');
  str = str.replace(/^_+|_+$/g, '');
  return str;
}

/**
 * Pull the chapter number out of a label like "Chapter 298.1" / "Vol.2 Chapter
 * 5". Returns null when there's no number so callers can fall back to the raw
 * label.
 */
function parseChapterNumber(label) {
  if (label === null || label === undefined) return null;
  const m = String(label).match(/chapter\s*(\d+(?:\.\d+)?)/i)
    || String(label).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Extract a JS array literal (`name = ["a","b",...]`) from inline reader-page
 * script content. Ported from MangaBox.kt's `extractArray`. Returns decoded,
 * unescaped string entries with any trailing slash stripped.
 */
function extractArray(scriptContent, arrayName) {
  const re = new RegExp(`${arrayName}\\s*=\\s*\\[([^\\]]*)\\]`);
  const m = scriptContent.match(re);
  if (!m || !m[1].trim()) return [];
  return m[1]
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => v.replace(/^["']|["']$/g, '').replace(/\\\//g, '/').replace(/\/$/, ''));
}

// ── Adapter factory ──────────────────────────────────────────────────────────

/**
 * Build a MangaBox-family source adapter.
 *
 * @param {object} cfg
 * @param {string}   cfg.id            — registry id (e.g. 'mangakakalot')
 * @param {string}   cfg.label         — display name
 * @param {string}   cfg.homepage      — canonical public URL (user-facing)
 * @param {string}   cfg.searchBase    — host that serves /home/search/json open
 * @param {string}   cfg.contentBase   — host that serves /manga/* + /api/* open
 * @param {string[]} cfg.imageReferers — Referer values the image CDN accepts
 */
function createMangaBoxAdapter(cfg) {
  const { id, label, homepage, searchBase, contentBase } = cfg;
  const imageReferer = (cfg.imageReferers && cfg.imageReferers[0]) || `${contentBase}/`;
  const pacer = createPacer(REQUEST_INTERVAL_MS);

  async function pacedFetch(url, { json = false, ...options } = {}) {
    await pacer.wait();
    const resp = await fetch(url, {
      redirect: 'follow',
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': json
          ? 'application/json, text/plain, */*'
          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const gated = /just a moment|challenge-platform|cf-browser-verification/i.test(body);
      throw new Error(
        `${label} ${resp.status} for ${url}` +
        (gated ? ' (blocked by Cloudflare challenge)' : ''),
      );
    }
    return json ? resp.json() : resp.text();
  }

  function seriesUrl(slug) {
    return slug ? `${homepage}/manga/${slug}` : null;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  function normalizeSearchHit(item) {
    if (!item || !item.slug) return null;
    return {
      id:             item.slug,
      title:          item.name ? decodeEntities(item.name) : null,
      description:    null,
      author:         item.author ? decodeEntities(item.author) : null,
      year:           null,
      status:         null,
      content_rating: null,
      genres:         [],
      cover_url:      item.thumb || null,
      series_url:     seriesUrl(item.slug),
      last_chapter:   parseChapterNumber(item.chapterLatest),
      available_languages: ['en'],
    };
  }

  async function searchSeries(query, { limit = 20 } = {}) {
    if (!query || !query.trim()) return [];
    const alias = changeAlias(query);
    if (!alias) return [];
    const params = new URLSearchParams({ searchword: alias });
    const json = await pacedFetch(`${searchBase}/home/search/json?${params}`, {
      json: true,
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': `${searchBase}/` },
    });
    const items = Array.isArray(json) ? json : [];
    const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    return items.slice(0, cap).map(normalizeSearchHit).filter(Boolean);
  }

  // ── Series detail ────────────────────────────────────────────────────────────

  function parseSeriesHtml(html, slug) {
    const infoM = html.match(/<ul class="manga-info-text">([\s\S]*?)<\/ul>/i);
    const info = infoM ? infoM[1] : html;

    const title =
      stripTags((info.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) ||
      stripTags((info.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1]) ||
      null;

    const liGet = (labelRe) => {
      const m = info.match(new RegExp(`<li[^>]*>\\s*${labelRe}\\s*:([\\s\\S]*?)<\\/li>`, 'i'));
      return m ? stripTags(m[1]) : null;
    };

    const author = liGet('Author\\(s\\)') || liGet('Author');
    const status = liGet('Status');

    const genresM = info.match(/<li class="genres"[^>]*>([\s\S]*?)<\/li>/i);
    const genres = genresM
      ? [...genresM[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map(g => stripTags(g[1])).filter(Boolean)
      : [];

    const cover =
      (html.match(/<div class="manga-info-pic">[\s\S]*?<img[^>]+src="([^"]+)"/i) || [])[1] ||
      (html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] ||
      null;

    // #contentBox holds a "<h2><p>Title summary:</p></h2>{text}" block.
    let description = null;
    const descM = html.match(/<div\s+id="contentBox"[^>]*>([\s\S]*?)<\/div>/i);
    if (descM) {
      description = stripTags(descM[1].replace(/<h2[\s\S]*?<\/h2>/i, ''));
      if (description) description = description.replace(/^[^:]*summary:\s*/i, '').trim();
    }

    return {
      id:             slug,
      title,
      description:    description || null,
      author:         author || null,
      year:           null,
      status:         status || null,
      content_rating: null,
      genres,
      cover_url:      cover ? decodeEntities(cover) : null,
      series_url:     seriesUrl(slug),
      last_chapter:   null,
      available_languages: ['en'],
    };
  }

  async function getSeries(slug) {
    if (!slug) throw new Error('slug is required');
    const html = await pacedFetch(`${contentBase}/manga/${encodeURIComponent(slug)}`, {
      headers: { 'Referer': `${contentBase}/` },
    });
    return parseSeriesHtml(html, slug);
  }

  // ── Chapter list ──────────────────────────────────────────────────────────────

  async function getChapters(slug /*, opts */) {
    if (!slug) throw new Error('slug is required');
    const json = await pacedFetch(
      `${contentBase}/api/manga/${encodeURIComponent(slug)}/chapters?limit=-1`,
      { json: true, headers: { 'Referer': `${contentBase}/manga/${slug}` } },
    );
    if (!json || json.success === false) {
      throw new Error(`${label}: chapter list unavailable for "${slug}"`);
    }
    const rows = (json.data && Array.isArray(json.data.chapters)) ? json.data.chapters : [];
    const out = rows.map((ch) => {
      const chapterSlug = ch.chapter_slug;
      if (!chapterSlug) return null;
      const number = (ch.chapter_num !== null && ch.chapter_num !== undefined)
        ? Number(ch.chapter_num)
        : parseChapterNumber(ch.chapter_name);
      return {
        // The worker passes this back to getChapterImages — encode both the
        // series slug and the chapter slug so the reader URL can be rebuilt.
        id:           `${slug}/${chapterSlug}`,
        number:       Number.isFinite(number) ? number : null,
        volume:       null,
        title:        ch.chapter_name ? decodeEntities(ch.chapter_name) : null,
        language:     'en',
        pages:        0,
        published_at: ch.updated_at || null,
        group:        null,
        external_url: null,
      };
    }).filter(Boolean);

    // The API returns newest-first; flip to oldest-first so the scheduler diff
    // sees the same ordering the other adapters produce.
    out.sort((a, b) => {
      const ca = a.number ?? Number.POSITIVE_INFINITY;
      const cb = b.number ?? Number.POSITIVE_INFINITY;
      if (ca !== cb) return ca - cb;
      return String(a.published_at || '').localeCompare(String(b.published_at || ''));
    });
    return out;
  }

  // ── Chapter images ──────────────────────────────────────────────────────────────

  function parseReaderImages(html) {
    // The image data lives in an inline <script> as `cdns`, `backupImage` and
    // `chapterImages` array literals (see MangaBox.kt pageListParse).
    const cdns = [...extractArray(html, 'cdns'), ...extractArray(html, 'backupImage')]
      .filter(Boolean);
    const paths = extractArray(html, 'chapterImages');

    if (cdns.length && paths.length) {
      const base = cdns[0].replace(/\/$/, '');
      return paths.map(p => `${base}/${String(p).replace(/^\//, '')}`);
    }

    // Fallback: server-rendered <img> tags inside the reader container.
    const containerM = html.match(/container-chapter-reader[\s\S]*$/i);
    const scope = containerM ? containerM[0] : html;
    const files = [];
    for (const m of scope.matchAll(/<img[^>]+(?:data-src|src)="(https?:\/\/[^"]+\.(?:jpe?g|png|webp|gif))"/gi)) {
      const u = decodeEntities(m[1]);
      if (/\/(logo|banner|404|avatar)/i.test(u)) continue;
      files.push(u);
    }
    return files;
  }

  async function getChapterImages(chapterId) {
    if (!chapterId) throw new Error('chapterId is required');
    // chapterId is "{slug}/{chapterSlug}".
    const readerPath = chapterId.split('/').map(encodeURIComponent).join('/');
    const html = await pacedFetch(`${contentBase}/manga/${readerPath}`, {
      headers: { 'Referer': `${contentBase}/manga/${chapterId.split('/')[0]}` },
    });
    const files = parseReaderImages(html);
    if (files.length === 0) {
      throw new Error(`${label} returned no images for chapter "${chapterId}"`);
    }
    return { base_url: '', hash: '', files, data_saver_files: [] };
  }

  return {
    id,
    label,
    homepage,
    searchSeries,
    getSeries,
    getChapters,
    getChapterImages,
    seriesUrl,
    USER_AGENT,
    // The image CDN rejects fetches without a recognised Referer; the
    // downloader merges these onto its image requests.
    IMAGE_HEADERS: { 'Referer': imageReferer },
    // Exposed for tests.
    _changeAlias: changeAlias,
    _parseSeriesHtml: parseSeriesHtml,
    _parseReaderImages: parseReaderImages,
    _extractArray: extractArray,
  };
}

module.exports = { createMangaBoxAdapter, changeAlias, extractArray, USER_AGENT };
