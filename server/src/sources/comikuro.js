const fetch = require('node-fetch');

// ComiKuro source adapter — full chapter download support, but with an
// upstream twist worth knowing.
//
// ComiKuro itself is a metadata aggregator: it stores rich series info
// (description, covers, chapter counts, genres) but does NOT host the
// chapter pages for the vast majority of titles. When you click "Read" on
// the live site, the SPA scrapes the chapter list and images from one of
// several upstream hosts (kaliscan, comix.to, mangaball, zazamanga). We
// mirror that behaviour with one upstream pinned: kaliscan.com, since it
// has the broadest English coverage and the cleanest HTML to scrape.
//
// All HTTP traffic flows through https://api.comikuro.to/api/_proxy/proxy
// (the site's allowlisted CORS proxy). Hitting the upstream hosts directly
// would skip ComiKuro entirely; routing through their proxy keeps this
// adapter consistent with what the user sees in the UI and inherits any
// CDN headers the proxy adds (User-Agent, etc.).
//
// Endpoints used:
//
//   Search (via proxy → comick.dev):
//     GET /api/_proxy/proxy?url=https://api.comick.dev/v1.0/search?q={query}&limit=N
//     Returns: [{id, hid, slug, title, desc, status, last_chapter,
//                content_rating, country, md_covers:[{b2key}], …}]
//
//   Series detail (native ComiKuro API):
//     GET /api/_data/manga?slug={slug}
//     Returns: {pageProps:{comic:{…}, artists:[…], authors:[…], …}}
//
//   Chapter list (via proxy → kaliscan):
//     1. POST search to find kaliscan manga_id by title
//     2. GET /service/backend/chaplist/?manga_id=N&manga_name=Title
//     Returns HTML with <li id="c-{number}"><a href="/manga/{id}-{slug}/chapter-{n}">
//
//   Chapter images (via proxy → kaliscan):
//     GET /manga/{kaliscan_id}-{slug}/chapter-{number}
//     Returns HTML containing `var chapImages = "url1,url2,…"` — comma-
//     separated CDN URLs with time-expiring `acc=…&expires=…` tokens.
//     The downloader fetches the URLs immediately after this call so the
//     ~12-hour expiry window is never an issue in practice.
//
// Same-shape contract as the other adapters — slot-in compatible with the
// downloader queue and the scheduler diff path. Cover URL format is
// `https://meo.comick.pictures/{b2key}` — verified by inspecting the live
// SPA's image render path.

const SITE_BASE      = 'https://comikuro.to';
const API_BASE       = 'https://api.comikuro.to';
const COVER_CDN      = 'https://meo.comick.pictures';
const COMICK_DEV_API = 'https://api.comick.dev';
const KALISCAN_BASE  = 'https://kaliscan.com';
const USER_AGENT     = 'Mozilla/5.0 (Momotaro/1.0; +https://github.com/momotaro)';
const REQUEST_INTERVAL_MS = 250;

let _lastRequestAt = 0;
// Caches keyed by ComiKuro slug. Both are effectively immutable for a
// given series, so a process-lifetime cache pays for itself within a few
// chapter downloads.
const _seriesCache = new Map();   // slug → normalized series detail
const _kaliscanIdCache = new Map(); // slug → { manga_id, slug } on kaliscan

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
      'Origin':          SITE_BASE,
      'Referer':         SITE_BASE + '/',
      ...(options.headers || {}),
    },
  });
  return resp;
}

async function getJson(url, options = {}) {
  const resp = await pacedFetch(url, {
    ...options,
    headers: { 'Accept': 'application/json,*/*;q=0.8', ...(options.headers || {}) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`ComiKuro ${resp.status} ${url}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function getProxiedHtml(targetUrl) {
  const url = `${API_BASE}/api/_proxy/proxy?url=${encodeURIComponent(targetUrl)}`;
  const resp = await pacedFetch(url, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (!resp.ok) {
    throw new Error(`ComiKuro proxy ${resp.status} for ${targetUrl}`);
  }
  return resp.text();
}

function seriesUrl(slug) {
  return slug ? `${SITE_BASE}/manga/${slug}` : null;
}

function coverUrl(b2key) {
  if (!b2key) return null;
  return `${COVER_CDN}/${b2key}`;
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

function stripHtml(s) {
  if (!s) return s;
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * Map a comick.dev search hit to our standard shape. We use the slug as
 * the canonical id (matches what the user-pasted URL contains and what
 * `_data/manga?slug=...` expects).
 */
function normalizeSearchHit(item) {
  if (!item || !item.slug) return null;
  const cover = Array.isArray(item.md_covers) && item.md_covers[0]?.b2key
    ? coverUrl(item.md_covers[0].b2key)
    : null;
  // status: 1=ongoing, 2=completed, 3=cancelled, 4=hiatus per Comick's enum.
  const STATUS_MAP = { 1: 'ongoing', 2: 'completed', 3: 'cancelled', 4: 'hiatus' };
  return {
    id:           item.slug,
    title:        item.title || null,
    description:  item.desc || null,
    author:       null,
    year:         item.year || null,
    status:       STATUS_MAP[item.status] || null,
    content_rating: item.content_rating || null,
    genres:       [],
    cover_url:    cover,
    series_url:   seriesUrl(item.slug),
    last_chapter: item.last_chapter != null ? String(item.last_chapter) : null,
    available_languages: ['en'],
  };
}

async function searchSeries(query, { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const target = `${COMICK_DEV_API}/v1.0/search?q=${encodeURIComponent(query.trim())}&limit=${cap}`;
  const url = `${API_BASE}/api/_proxy/proxy?url=${encodeURIComponent(target)}`;
  const data = await getJson(url);
  const items = Array.isArray(data) ? data : [];
  return items.map(normalizeSearchHit).filter(Boolean);
}

// ── Series detail ──────────────────────────────────────────────────────────

async function getSeries(slug) {
  if (!slug) throw new Error('slug is required');
  if (_seriesCache.has(slug)) return _seriesCache.get(slug);

  const data = await getJson(`${API_BASE}/api/_data/manga?slug=${encodeURIComponent(slug)}`);
  const props = data?.pageProps;
  const c = props?.comic;
  if (!c) {
    throw new Error(`ComiKuro: no series found for slug "${slug}"`);
  }
  const authors = Array.isArray(props.authors)
    ? props.authors.map(a => a?.name).filter(Boolean).join(', ')
    : null;
  const artists = Array.isArray(props.artists)
    ? props.artists.map(a => a?.name).filter(Boolean).join(', ')
    : null;
  let author = authors;
  if (artists && artists !== authors) {
    author = author ? `${author} (art: ${artists})` : artists;
  }
  const genres = Array.isArray(c.md_comic_md_genres)
    ? c.md_comic_md_genres.map(g => g?.md_genres?.name).filter(Boolean)
    : [];
  // status: 1=ongoing, 2=completed, 3=cancelled, 4=hiatus
  const STATUS_MAP = { 1: 'ongoing', 2: 'completed', 3: 'cancelled', 4: 'hiatus' };
  const cover = Array.isArray(c.md_covers) && c.md_covers[0]?.b2key
    ? coverUrl(c.md_covers[0].b2key)
    : null;

  const out = {
    id:           c.slug || slug,
    title:        c.title || null,
    description:  c.desc || null,
    author,
    year:         c.year || null,
    status:       STATUS_MAP[c.status] || null,
    content_rating: c.content_rating || null,
    genres,
    cover_url:    cover,
    series_url:   seriesUrl(c.slug || slug),
    last_chapter: c.last_chapter != null ? String(c.last_chapter) : null,
    available_languages: Array.isArray(props.langList) ? props.langList : ['en'],
    // Stash the kaliscan-resolution hints for getChapters() — saves an
    // extra HTML fetch when the same process later asks for chapters.
    _kaliscanHint: { title: c.title, year: c.year, last_chapter: c.last_chapter },
  };
  _seriesCache.set(slug, out);
  return out;
}

// ── Kaliscan upstream resolution ───────────────────────────────────────────

/**
 * Resolve the ComiKuro slug → kaliscan {manga_id, slug} pair by searching
 * kaliscan via the ComiKuro proxy and matching titles. Cached for the
 * process lifetime — the mapping is stable.
 *
 * Best-match heuristic:
 *   1. Exact case-insensitive title match against the result block's
 *      <h3> text wins.
 *   2. Otherwise the first hit (kaliscan orders by relevance).
 *
 * Returns { manga_id, slug } or throws if kaliscan has nothing.
 */
async function resolveKaliscan(comikuroSlug) {
  if (_kaliscanIdCache.has(comikuroSlug)) return _kaliscanIdCache.get(comikuroSlug);

  // Need a title to search kaliscan with. getSeries caches it cheaply.
  const series = await getSeries(comikuroSlug);
  const title = series._kaliscanHint?.title || series.title;
  if (!title) throw new Error(`ComiKuro: cannot resolve kaliscan match without a title for "${comikuroSlug}"`);

  const target = `${KALISCAN_BASE}/service/backend/search/?q=${encodeURIComponent(title)}`;
  const html = await getProxiedHtml(target);
  // Each hit is `<a title="..." href="/manga/{id}-{slug}">` inside a
  // `<div class="novel__item">` block. Pick the first whose visible
  // title matches the ComiKuro title (case-insensitive trim) — falls
  // back to the first hit when no exact match.
  const blocks = [...html.matchAll(/<div class="novel__item">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi)]
    .map(m => m[0]);
  if (blocks.length === 0) {
    throw new Error(`ComiKuro: no kaliscan results for "${title}"`);
  }
  const titleLower = String(title).toLowerCase().trim();
  let chosen = null;
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(\/manga\/(\d+)-([^"\/?#]+))"/i);
    if (!hrefMatch) continue;
    const candidateTitle = stripHtml(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '')
      || stripHtml(block.match(/<a[^>]+title="([^"]+)"/i)?.[1] || '');
    const exact = candidateTitle.toLowerCase().trim() === titleLower;
    const item = { manga_id: hrefMatch[2], slug: hrefMatch[3], title: candidateTitle };
    if (exact) { chosen = item; break; }
    if (!chosen) chosen = item;
  }
  if (!chosen) {
    throw new Error(`ComiKuro: no parseable kaliscan match for "${title}"`);
  }
  _kaliscanIdCache.set(comikuroSlug, chosen);
  return chosen;
}

// ── Chapter list ───────────────────────────────────────────────────────────

/**
 * Encode the kaliscan reader URL components into our chapter id so the
 * queue can pass it back unchanged to getChapterImages without us needing
 * a side database. Format: `{kaliscan_id}-{kaliscan_slug}/chapter-{number}`.
 * The site's chapter URL is exactly `${KALISCAN_BASE}/manga/{this string}`.
 */
function encodeChapterId(kaliscanId, kaliscanSlug, number) {
  return `${kaliscanId}-${kaliscanSlug}/chapter-${number}`;
}

async function getChapters(comikuroSlug /*, opts */) {
  if (!comikuroSlug) throw new Error('slug is required');
  const ks = await resolveKaliscan(comikuroSlug);

  const target = `${KALISCAN_BASE}/service/backend/chaplist/?manga_id=${encodeURIComponent(ks.manga_id)}&manga_name=${encodeURIComponent(ks.title || comikuroSlug)}`;
  const html = await getProxiedHtml(target);

  // <li id="c-{number}">
  //   <a href="/manga/{id}-{slug}/chapter-{number}" title="{title}">
  //     <strong class="chapter-title">Chapter N</strong>
  //     <time class="chapter-update">{relative date}</time>
  //   </a>
  // </li>
  const out = [];
  const seen = new Set();
  const blockRe = /<li[^>]*id=["']c-([^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const numberRaw = m[1];
    const block = m[2];
    const num = parseFloat(numberRaw);
    const number = Number.isFinite(num) ? num : null;
    const titleText = stripHtml(block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1] || '');
    const date = stripHtml(block.match(/<time[^>]*>([\s\S]*?)<\/time>/i)?.[1] || '');
    const id = encodeChapterId(ks.manga_id, ks.slug, numberRaw);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      number,
      volume:       null,
      title:        titleText || null,
      language:     'en', // kaliscan only serves English
      pages:        0,
      published_at: date || null,
      group:        null,
      external_url: null,
    });
  }
  // Sort oldest-first, matching the other adapters' contract so the
  // scheduler diff sees a consistent ordering.
  out.sort((a, b) => {
    const ca = a.number ?? Number.POSITIVE_INFINITY;
    const cb = b.number ?? Number.POSITIVE_INFINITY;
    return ca - cb;
  });
  return out;
}

// ── Chapter images ─────────────────────────────────────────────────────────

/**
 * Returns the same `{ files, base_url, hash, data_saver_files }` shape the
 * mangadex adapter does so the downloader worker doesn't need a per-source
 * branch for image fetching. The `chapImages = "..."` string in kaliscan's
 * reader HTML is a comma-separated list of pre-signed CDN URLs.
 */
async function getChapterImages(chapterId) {
  if (!chapterId) throw new Error('chapterId is required');
  // chapterId format: "{kaliscan_id}-{kaliscan_slug}/chapter-{number}".
  // We pass it straight into the kaliscan reader URL.
  const target = `${KALISCAN_BASE}/manga/${chapterId}`;
  const html = await getProxiedHtml(target);

  const m = html.match(/var\s+chapImages\s*=\s*"([^"]+)"/i);
  if (!m) {
    throw new Error('ComiKuro/kaliscan returned no images for this chapter (the reader HTML did not contain chapImages)');
  }
  const files = m[1]
    .split(',')
    .map(s => decodeEntities(s.trim()))
    .filter(s => /^https?:\/\//.test(s));
  if (files.length === 0) {
    throw new Error('ComiKuro/kaliscan returned an empty chapImages list');
  }
  return {
    base_url:         '',
    hash:             '',
    files,
    data_saver_files: [],
  };
}

module.exports = {
  id: 'comikuro',
  label: 'ComiKuro',
  homepage: SITE_BASE,
  searchSeries,
  getSeries,
  getChapters,
  getChapterImages,
  seriesUrl,
  USER_AGENT,
  // Exposed for tests
  _normalizeSearchHit: normalizeSearchHit,
  _resolveKaliscan:    resolveKaliscan,
  _resetCache: () => { _seriesCache.clear(); _kaliscanIdCache.clear(); },
};
