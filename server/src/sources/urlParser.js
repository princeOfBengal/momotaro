// URL ↔ (source, source_id) translation for the manga_source_urls store.
//
// The user can paste any URL into the per-manga URL manager; this module
// recognises which source it belongs to and extracts the series id. It also
// builds the canonical landing URL given a (source, id) pair so the rest of
// the app can stay agnostic about each source's URL scheme.
//
// Adding a new source: append a new entry to PARSERS with `match`, `extract`,
// and `build`. The first entry whose `match` returns true wins.

const MANGADEX_SLUG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// comix.to series ids ("hid") are short base36-ish slugs the site uses in
// URLs of the form `/title/{hid}-{seo-slug}` — observed examples: 5ze6g,
// jjeq3, pem4, 55kym, ll172, 116167. Accept 3..10 alphanumerics.
const COMIXTO_HID = /^[a-z0-9]{3,10}$/i;

const PARSERS = [
  {
    source: 'mangadex',
    // Accept https://mangadex.org/title/{uuid}[/...] and the .org/.cc/.com TLDs
    // that have been used historically by mirrors / preview deployments.
    match: (u) =>
      /^https?:\/\/(www\.)?mangadex\.(org|cc|com)\/title\/[0-9a-f-]+/i.test(u),
    extract: (u) => {
      const m = u.match(/\/title\/([0-9a-f-]+)/i);
      if (!m) return null;
      const id = m[1];
      if (!MANGADEX_SLUG.test(id)) return null;
      return { source: 'mangadex', source_id: id };
    },
    build: (id) => `https://mangadex.org/title/${id}`,
  },
  {
    source: 'mangaball',
    // mangaball.net URLs:
    //   - title page:   https://mangaball.net/title-detail/{slug}-{ObjectId}/
    //   - chapter page: https://mangaball.net/chapter-detail/{ObjectId}/
    //
    // The MongoDB ObjectId (24 hex chars) is the stable identifier; the
    // {slug}- prefix is SEO and the site redirects /title-detail/{anything}-
    // {ObjectId}/ to the canonical slugged form, so we canonicalise to a
    // safe placeholder slug ("series-") + the ObjectId.
    match: (u) =>
      /^https?:\/\/(www\.)?mangaball\.net\/title-detail\/(?:[a-z0-9_-]+-)?[a-f0-9]{24}\/?$/i.test(u),
    extract: (u) => {
      const m = u.match(/\/title-detail\/(?:[a-z0-9_-]+-)?([a-f0-9]{24})\/?$/i);
      if (!m) return null;
      return { source: 'mangaball', source_id: m[1].toLowerCase() };
    },
    // Use a generic slug — the site redirects to the canonical one anyway.
    build: (id) => `https://mangaball.net/title-detail/series-${id}/`,
  },
  {
    source: 'weebcentral',
    // weebcentral.com URLs:
    //   - title page:   https://weebcentral.com/series/{ULID}/{Title-slug}
    //   - chapter page: https://weebcentral.com/chapters/{ULID}
    //
    // The series ULID is the stable identifier; the title slug is SEO and
    // is regenerated when the series is renamed. The bare /series/{ULID}
    // form (no slug) returns the same page, so we canonicalise to that.
    // ULIDs are exactly 26 chars from Crockford's base32 alphabet (no
    // I/L/O/U), uppercase.
    match: (u) =>
      /^https?:\/\/(www\.)?weebcentral\.com\/series\/[0-9A-HJKMNP-TV-Z]{26}/i.test(u),
    extract: (u) => {
      const m = u.match(/\/series\/([0-9A-HJKMNP-TV-Z]{26})/i);
      if (!m) return null;
      return { source: 'weebcentral', source_id: m[1].toUpperCase() };
    },
    build: (id) => `https://weebcentral.com/series/${id}`,
  },
  {
    source: 'mangafire',
    // mangafire.to URLs:
    //   - title page:   https://mangafire.to/manga/{slug}.{hid}
    //   - chapter page: https://mangafire.to/read/{slug}.{hid}/{lang}/chapter-N
    //
    // The {slug}.{hid} composite is the actual series identifier — both
    // halves are required at the source (the bare slug 404s, the bare hid
    // 404s). We canonicalise to the /manga/ form regardless of where the
    // user pasted from.
    match: (u) =>
      /^https?:\/\/(www\.)?mangafire\.to\/(manga|read)\/[a-z0-9_-]+\.[a-z0-9]+/i.test(u),
    extract: (u) => {
      const m = u.match(/\/(?:manga|read)\/([a-z0-9_-]+\.[a-z0-9]+)/i);
      if (!m) return null;
      const id = m[1];
      // Sanity-check shape: slug then dot then short id of 2..10 chars.
      if (!/^[a-z0-9_-]{1,200}\.[a-z0-9]{2,10}$/i.test(id)) return null;
      return { source: 'mangafire', source_id: id };
    },
    build: (id) => `https://mangafire.to/manga/${id}`,
  },
  {
    source: 'mangakakalot',
    // mangakakalot.gg URLs are slug-based:
    //   - title page:   https://www.mangakakalot.gg/manga/{slug}
    //   - chapter page: https://www.mangakakalot.gg/manga/{slug}/chapter-N[-N]
    // Slug is a lowercase a-z0-9-_ identifier (e.g. "horimiya",
    // "a-mouse-biting-a-dragons-tail"). The www. is optional but the site
    // canonicalises to the www form, so we build URLs that way too.
    match: (u) =>
      /^https?:\/\/(www\.)?mangakakalot\.gg\/manga\/[a-z0-9_-]+/i.test(u),
    extract: (u) => {
      const m = u.match(/\/manga\/([a-z0-9_-]+)/i);
      if (!m) return null;
      const slug = m[1];
      // Reject anything that looks like a chapter sub-path leftover or junk.
      if (slug.length < 1 || slug.length > 200) return null;
      return { source: 'mangakakalot', source_id: slug };
    },
    build: (slug) => `https://www.mangakakalot.gg/manga/${slug}`,
  },
  {
    source: 'natomanga',
    // Natomanga / Manganato family URLs are slug-based and share one slug
    // namespace across every mirror:
    //   - title page:   https://www.natomanga.com/manga/{slug}
    //   - chapter page: https://www.manganato.gg/manga/{slug}/chapter-N
    // Recognised mirrors: natomanga.com, manganato.gg, nelomanga.com,
    // nelomanga.net. Whatever the user pastes, we canonicalise to the
    // natomanga.com title form. The trailing /chapter-… segment (if any) is
    // dropped so only the series slug is captured.
    match: (u) =>
      /^https?:\/\/(www\.)?(natomanga\.com|manganato\.gg|nelomanga\.(com|net))\/manga\/[a-z0-9_-]+/i.test(u),
    extract: (u) => {
      const m = u.match(/\/manga\/([a-z0-9_-]+)/i);
      if (!m) return null;
      const slug = m[1];
      if (slug.length < 1 || slug.length > 200) return null;
      return { source: 'natomanga', source_id: slug };
    },
    build: (slug) => `https://www.natomanga.com/manga/${slug}`,
  },
  {
    source: 'comikuro',
    // comikuro.to URLs are slug-based:
    //   - title page:   https://comikuro.to/manga/{slug}
    //   - reader page:  https://comikuro.to/read/{chapter_hid}
    // The slug ("horimiya") is the stable identifier for the series.
    // Reader URLs use a separate hid we don't expose to callers — only
    // the /manga/ form gets canonicalised here.
    match: (u) =>
      /^https?:\/\/(www\.)?comikuro\.to\/manga\/[a-z0-9_-]+/i.test(u),
    extract: (u) => {
      const m = u.match(/\/manga\/([a-z0-9_-]+)/i);
      if (!m) return null;
      const slug = m[1];
      if (slug.length < 1 || slug.length > 200) return null;
      return { source: 'comikuro', source_id: slug };
    },
    build: (slug) => `https://comikuro.to/manga/${slug}`,
  },
  {
    source: 'mangadotnet',
    // mangadot.net URLs are id-based:
    //   - title page:   https://mangadot.net/manga/{id}
    //   - chapter page: https://mangadot.net/chapter/{chapter_id}[?source=...]
    // Series id is a positive integer assigned by the site; the chapter
    // page lives at a flat /chapter/{id} path (not under /manga/{id}/...),
    // so we only canonicalise from the /manga/{id} form to avoid mistaking
    // a chapter id for a series id.
    match: (u) =>
      /^https?:\/\/(www\.)?mangadot\.net\/manga\/\d+/i.test(u),
    extract: (u) => {
      const m = u.match(/\/manga\/(\d+)/i);
      if (!m) return null;
      return { source: 'mangadotnet', source_id: m[1] };
    },
    build: (id) => `https://mangadot.net/manga/${id}`,
  },
  {
    source: 'mangataro',
    // mangataro.org URLs are slug-based:
    //   - title page:   https://mangataro.org/manga/{slug}
    //   - chapter page: https://mangataro.org/read/{slug}/ch{N}-{chapter_id}
    // The slug ("horimiya", "hori-san-to-miyamura-kun") is the stable
    // identifier the user pastes; the numeric manga_id needed by the
    // chapter-list API is resolved from the series page on demand.
    match: (u) =>
      /^https?:\/\/(www\.)?mangataro\.org\/(manga|read)\/[a-z0-9_-]+/i.test(u),
    extract: (u) => {
      const m = u.match(/\/(?:manga|read)\/([a-z0-9_-]+)/i);
      if (!m) return null;
      const slug = m[1];
      if (slug.length < 1 || slug.length > 200) return null;
      return { source: 'mangataro', source_id: slug };
    },
    build: (slug) => `https://mangataro.org/manga/${slug}`,
  },
  {
    source: 'comixto',
    // comix.to URLs come in two shapes:
    //   - title page:    https://comix.to/title/{hid}-{seo-slug}
    //   - chapter page:  https://comix.to/title/{hid}-{seo-slug}/{chapter-id}-chapter-N
    // Both encode the series hid as the first dash-separated segment after
    // /title/. We extract just that — the seo-slug rots when the title is
    // edited, but the hid is stable.
    match: (u) =>
      /^https?:\/\/(www\.)?comix\.to\/title\/[a-z0-9]{3,10}([-/].*)?$/i.test(u),
    extract: (u) => {
      const m = u.match(/\/title\/([a-z0-9]{3,10})(?:[-/]|$)/i);
      if (!m) return null;
      const id = m[1];
      if (!COMIXTO_HID.test(id)) return null;
      return { source: 'comixto', source_id: id };
    },
    build: (id) => `https://comix.to/title/${id}`,
  },
];

/**
 * Parse a user-entered URL into { source, source_id, url } where `url` is a
 * normalised canonical form. Returns null if no parser recognises it — the
 * caller should respond with a 400 in that case rather than store an
 * un-actionable URL.
 */
function parseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Light validation — URL constructor catches ftp://, mailto:, and bare
  // strings that aren't actually URLs.
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;

  for (const p of PARSERS) {
    if (!p.match(trimmed)) continue;
    const extracted = p.extract(trimmed);
    if (!extracted) continue;
    return {
      source:    extracted.source,
      source_id: extracted.source_id,
      url:       p.build(extracted.source_id),
    };
  }
  return null;
}

/**
 * Build the canonical landing URL for a (source, id) pair. Returns null if
 * the source isn't recognised.
 */
function buildUrl(source, sourceId) {
  if (!source || !sourceId) return null;
  const p = PARSERS.find(x => x.source === source);
  return p ? p.build(sourceId) : null;
}

module.exports = { parseUrl, buildUrl };
