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
