const fetch = require('node-fetch');

const MAL_API_BASE = 'https://api.myanimelist.net/v2';

// Fields requested on every manga object
const MANGA_FIELDS = [
  'id',
  'title',
  'main_picture',
  'alternative_titles',
  'start_date',
  'synopsis',
  'mean',
  'status',
  'genres',
  'num_volumes',
  'num_chapters',
  'authors{first_name,last_name,role}',
].join(',');

function buildHeaders(clientId) {
  const headers = { Accept: 'application/json' };
  if (clientId) headers['X-MAL-CLIENT-ID'] = clientId;
  return headers;
}

async function malRequest(path, clientId) {
  const resp = await fetch(`${MAL_API_BASE}${path}`, {
    headers: buildHeaders(clientId),
  });

  if (resp.status === 429) {
    // MAL doesn't document rate limits; back off 60 s and retry once
    console.warn('[MAL] Rate limited — retrying in 60 s');
    await new Promise(resolve => setTimeout(resolve, 60_000));
    const retry = await fetch(`${MAL_API_BASE}${path}`, {
      headers: buildHeaders(clientId),
    });
    if (!retry.ok) throw new Error(`MyAnimeList responded with ${retry.status} after retry`);
    return retry.json();
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`MyAnimeList: HTTP ${resp.status}${text ? ' — ' + text.slice(0, 120) : ''}`);
  }

  return resp.json();
}

// ── Status normalization ──────────────────────────────────────────────────────

function normalizeStatus(status) {
  const map = {
    finished:            'FINISHED',
    currently_publishing: 'RELEASING',
    not_yet_published:   'UPCOMING',
    on_hiatus:           'HIATUS',
    discontinued:        'CANCELLED',
  };
  return map[status] || 'UNKNOWN';
}

// ── Manga normalization ───────────────────────────────────────────────────────

function normalizeManga(m) {
  const title = m.alternative_titles?.en || m.title || '';

  const description = m.synopsis
    ? m.synopsis
        .replace(/\[Written by MAL Rewrite\]/gi, '')
        .replace(/\[Written by MAL Staff\]/gi, '')
        .trim()
    : null;

  // Extract author/artist. MAL authors field is an array of
  // { node: { id, first_name, last_name }, role: { key, name } }
  let author = null;
  if (Array.isArray(m.authors) && m.authors.length > 0) {
    const AUTHOR_ROLES = new Set(['Story & Art', 'Story', 'Art']);
    const names = m.authors
      .filter(a => AUTHOR_ROLES.has(a.role?.name) && (a.node?.first_name || a.node?.last_name))
      .map(a => [a.node.last_name, a.node.first_name].filter(Boolean).join(' '));
    const unique = [...new Set(names)];
    if (unique.length > 0) author = unique.join(', ');
    // Fallback: use first author if no role matched
    if (!author && m.authors[0]?.node) {
      const n = m.authors[0].node;
      author = [n.last_name, n.first_name].filter(Boolean).join(' ') || null;
    }
  }

  let year = null;
  if (m.start_date) {
    const match = String(m.start_date).match(/^(\d{4})/);
    if (match) year = parseInt(match[1], 10);
  }

  const genres = (m.genres || []).map(g => g.name).filter(Boolean);
  const score = m.mean != null ? parseFloat(m.mean) : null;
  const coverUrl = m.main_picture?.large || m.main_picture?.medium || null;

  return {
    mal_id:       m.id,
    anilist_id:   null,
    doujinshi_id: null,
    title,
    description,
    status:    normalizeStatus(m.status),
    year,
    genres,
    score,
    cover_url: coverUrl,
    author,
    source:    'myanimelist',
  };
}

// ── Title cleaning ────────────────────────────────────────────────────────────
// Shared with the AniList integration so every metadata source sees the same
// cleaned search string. See anilist.js → cleanSearchTitle for the full
// rule set (scanner tags, volume/chapter markers, year ranges,
// release-quality words).

const { cleanSearchTitle } = require('./anilist');

// ── Public API ────────────────────────────────────────────────────────────────

// `nsfw=true` opts the manga-search endpoint into returning entries flagged
// as NSFW (the API's `nsfw` rating values: gray / black). Default is false,
// which silently filters them out — not what users of a self-hosted
// personal library want, since the library scanner already indexed
// whatever they put on disk and the metadata source should match.
//
// MAL doesn't publish its rate-limit number; community usage suggests
// 1 req/sec is safe. The bulk loop respects `MAL_REQUEST_INTERVAL_MS`.
const NSFW_PARAM_VALUE = 'true';
const MAL_REQUEST_INTERVAL_MS = 1000;

/**
 * Auto-fetch: returns the closest match for a title or null.
 * Uses the search endpoint and returns the top result.
 */
async function fetchFromMAL(title, clientId) {
  const q = cleanSearchTitle(title);
  const params = new URLSearchParams({
    q,
    limit:  5,
    nsfw:   NSFW_PARAM_VALUE,
    fields: MANGA_FIELDS,
  });
  const json = await malRequest(`/manga?${params}`, clientId);
  const data = json.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  return normalizeManga(data[0].node);
}

/**
 * Manual search: returns up to 10 results for user selection.
 */
async function searchMAL(query, clientId, page = 1) {
  const limit = 10;
  const offset = (page - 1) * limit;
  const params = new URLSearchParams({
    q: query,
    limit,
    offset,
    nsfw:   NSFW_PARAM_VALUE,
    fields: MANGA_FIELDS,
  });
  const json = await malRequest(`/manga?${params}`, clientId);
  const data = json.data;
  if (!Array.isArray(data)) return [];
  return data.map(item => normalizeManga(item.node));
}

/**
 * Fetch full metadata by a known MAL manga ID.
 *
 * The detail endpoint does not require an `nsfw` parameter — the request is
 * keyed by ID, not by a search filter — but we still fetch every documented
 * field so adult titles round-trip with full metadata.
 */
async function fetchByMALId(malId, clientId) {
  const params = new URLSearchParams({ fields: MANGA_FIELDS });
  const json = await malRequest(`/manga/${malId}?${params}`, clientId);
  if (!json || !json.id) return null;
  return normalizeManga(json);
}

module.exports = {
  fetchFromMAL,
  searchMAL,
  fetchByMALId,
  MAL_REQUEST_INTERVAL_MS,
};
