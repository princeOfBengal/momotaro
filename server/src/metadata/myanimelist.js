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

// Shared 429 cooldown — when one request is rate-limited, every other
// concurrent request waits until the cooldown passes. Without this, three
// parallel workers would all keep firing into a 429 wall and stretch the
// back-off into a multi-minute outage.
let _malCooldownUntil = 0;

async function _waitForCooldown() {
  const wait = _malCooldownUntil - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

async function malRequest(path, clientId) {
  await _waitForCooldown();
  const resp = await fetch(`${MAL_API_BASE}${path}`, {
    headers: buildHeaders(clientId),
  });

  if (resp.status === 429) {
    // MAL doesn't document rate limits; respect Retry-After if present,
    // otherwise default to 60 s. Pin the shared cooldown so peer workers
    // pause too. Retry once after the cooldown.
    const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
    const waitMs = Math.max(1000, Math.min(120_000, retryAfter * 1000));
    _malCooldownUntil = Date.now() + waitMs;
    console.warn(`[MAL] Rate limited — backing off ${waitMs / 1000}s (shared)`);
    await _waitForCooldown();
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
// 1 req/sec is safe in pure-sequential mode. The bulk loop uses
// `fetchBatch*` helpers below, which run a small concurrency pool with a
// per-start interval of `MAL_BATCH_INTERVAL_MS` — the effective steady-state
// throughput is ~3 req/sec (concurrency × stagger), which is a ~3× speedup
// over strict sequential without crossing into 429 territory in practice.
const NSFW_PARAM_VALUE = 'true';
const MAL_REQUEST_INTERVAL_MS = 1000;
const MAL_BATCH_CONCURRENCY = 3;
const MAL_BATCH_INTERVAL_MS = 350;

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

/**
 * Run `fn` over each item with a small concurrency pool, returning results in
 * the same order. Acts as MAL's stand-in for AniList's aliased GraphQL — MAL
 * has no batch endpoint, so the only way to speed up bulk pulls is to issue
 * several HTTP requests in parallel. A per-start `MAL_BATCH_INTERVAL_MS`
 * stagger caps total throughput at roughly 3 req/sec; the shared 429 cooldown
 * inside `malRequest` makes peer workers pause together when MAL pushes back.
 *
 * Per-item failures resolve to `null` rather than throwing, so a single bad
 * lookup doesn't poison the rest of the batch.
 */
async function malBatch(items, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  let nextSlotAt = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;

      // Stagger request *starts* across all workers — the slot variable is
      // shared, so worker N waits until everybody before it has cleared its
      // window. With 3 workers and a 350 ms interval that's ~3 req/sec total.
      const now      = Date.now();
      const startAt  = Math.max(now, nextSlotAt);
      nextSlotAt     = startAt + MAL_BATCH_INTERVAL_MS;
      const wait     = startAt - now;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        // Fall through with null; the caller logs/aggregates errors.
        results[i] = null;
      }
    }
  }

  const concurrency = Math.min(MAL_BATCH_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/**
 * Batched fetch-by-ID. Mirrors `fetchBatchByAniListIds` so the bulk loop has
 * a uniform interface across both metadata sources. Returns results in the
 * same order as `ids`; null slots mean the lookup returned no record.
 */
async function fetchBatchByMALIds(malIds, clientId) {
  return malBatch(malIds, id => fetchByMALId(Number(id), clientId));
}

/**
 * Batched search-by-title. Each title runs through `cleanSearchTitle` inside
 * `fetchFromMAL`; null entries mean "no match found".
 */
async function fetchBatchFromMAL(titles, clientId) {
  return malBatch(titles, t => fetchFromMAL(t, clientId));
}

module.exports = {
  fetchFromMAL,
  searchMAL,
  fetchByMALId,
  fetchBatchByMALIds,
  fetchBatchFromMAL,
  MAL_REQUEST_INTERVAL_MS,
  MAL_BATCH_CONCURRENCY,
  MAL_BATCH_INTERVAL_MS,
};
