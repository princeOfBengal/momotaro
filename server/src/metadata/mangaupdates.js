const fetch = require('node-fetch');
const { setCached } = require('./cache');

const MU_API_BASE = 'https://api.mangaupdates.com/v1';

// MangaUpdates does not publish a documented rate limit. Their acceptable use
// policy asks for "reasonable spacing between requests so as not to overwhelm
// the MangaUpdates servers, and employ caching mechanisms when accessing
// data." We use the same conservative defaults as the MAL integration:
//   • ~1 req/sec for strict-sequential paths.
//   • ~3 req/sec total throughput for the bounded-concurrency batch helper
//     (3 workers × 350 ms stagger).
const MU_REQUEST_INTERVAL_MS = 1000;
const MU_BATCH_CONCURRENCY   = 3;
const MU_BATCH_INTERVAL_MS   = 350;

// Shared cooldown — when one request is rate-limited or hits a 503, every
// other concurrent worker waits until the cooldown clears. Without this,
// peer workers would each fire into the same back-pressure wall.
let _muCooldownUntil = 0;

async function _waitForCooldown() {
  const wait = _muCooldownUntil - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

function describeRequest(method, path, body) {
  if (body && body.search !== undefined) {
    return `${method} ${path} search="${body.search}"${body.page ? ` page=${body.page}` : ''}`;
  }
  return `${method} ${path}`;
}

async function muRequest(method, path, body = null, attempt = 0) {
  const desc = describeRequest(method, path, body);
  console.log(`[MangaUpdates] → ${desc}`);
  await _waitForCooldown();

  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(`${MU_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Both 429 (rate-limit) and 503 (service temporarily unavailable, which the
  // MU spec documents on several endpoints) are recoverable. Honour
  // `Retry-After` when present, otherwise default to 60 s. Retry up to 3
  // times. Pin a process-wide cooldown so peer workers also pause.
  if ((resp.status === 429 || resp.status === 503) && attempt < 3) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
    const waitMs = Math.max(1000, Math.min(120_000, retryAfter * 1000));
    _muCooldownUntil = Date.now() + waitMs;
    console.warn(
      `[MangaUpdates] HTTP ${resp.status} (${desc}) — backing off ${waitMs / 1000}s ` +
      `(attempt ${attempt + 1}/3)`
    );
    await _waitForCooldown();
    return muRequest(method, path, body, attempt + 1);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`MangaUpdates: HTTP ${resp.status}${text ? ' — ' + text.slice(0, 120) : ''}`);
  }

  return resp.json();
}

// ── Status normalization ──────────────────────────────────────────────────
//
// `status` on MangaUpdates is a free-text string ("Ongoing", "Complete",
// "Hiatus", "Discontinued", etc.) rather than an enum. There's also a
// separate `completed` boolean — when set we trust it over the string.
function normalizeStatus(record) {
  if (record.completed === true) return 'FINISHED';
  const raw = String(record.status || '').toLowerCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('hiatus'))                                   return 'HIATUS';
  if (raw.includes('discontinued') || raw.includes('cancel'))   return 'CANCELLED';
  if (raw.includes('ongoing') || raw.includes('publishing'))    return 'RELEASING';
  if (raw.includes('complete') || raw.includes('finished'))     return 'FINISHED';
  return 'UNKNOWN';
}

// MangaUpdates returns descriptions with HTML tags (`<p>`, `<i>`, `<br>`,
// `<a>`). Strip them and decode the common entities so the stored
// description is plain text — same shape as the AniList integration.
function stripHtml(s) {
  if (!s) return null;
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi,    '\n\n')
    .replace(/<[^>]*>/g,      '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

function normalizeSeries(m) {
  if (!m || !m.series_id) return null;

  const description = stripHtml(m.description);

  // `year` is a string on MU; pull the first 4-digit run.
  let year = null;
  if (m.year) {
    const yearMatch = String(m.year).match(/\d{4}/);
    if (yearMatch) year = parseInt(yearMatch[0], 10);
  }

  const genres = Array.isArray(m.genres)
    ? m.genres.map(g => g?.genre).filter(Boolean)
    : [];

  // Authors: the API uses `type: "Author" | "Artist"` and the same person
  // can appear under both roles as separate entries. Dedupe by name and
  // join — same shape as AniList's Story / Art / Story & Art extraction.
  let author = null;
  if (Array.isArray(m.authors) && m.authors.length > 0) {
    const names = m.authors
      .map(a => (a && typeof a.name === 'string') ? a.name.trim() : null)
      .filter(Boolean);
    const unique = [...new Set(names)];
    if (unique.length > 0) author = unique.join(', ');
  }

  const cover_url = m.image?.url?.original || m.image?.url?.thumb || null;

  // `bayesian_rating` is already a 0–10 float — same scale Momotaro stores.
  let score = null;
  if (m.bayesian_rating != null) {
    const r = parseFloat(m.bayesian_rating);
    if (Number.isFinite(r)) score = r;
  }

  return {
    mangaupdates_id: m.series_id,
    anilist_id:      null,
    mal_id:          null,
    doujinshi_id:    null,
    title:           m.title || '',
    description,
    status:          normalizeStatus(m),
    year,
    genres,
    score,
    cover_url,
    author,
    source:          'mangaupdates',
  };
}

// Title cleaner shared with AniList / MAL so all three sources see the
// same scrubbed search string (release-group brackets, vol/chap markers,
// year ranges, quality tags removed).
const { cleanSearchTitle } = require('./anilist');

/**
 * Auto-fetch: returns the best-match record for a title or null.
 *
 * The /series/search endpoint returns lightweight `record` objects that
 * omit several fields we rely on (`authors`, full `description`, etc.).
 * After picking the top hit we round-trip through fetchByMangaUpdatesId so
 * the caller gets — and the cache stores — a fully-detailed record.
 */
async function fetchFromMangaUpdates(title) {
  const search = cleanSearchTitle(title);
  if (!search) return null;
  const json = await muRequest('POST', '/series/search', {
    search,
    page:    1,
    perpage: 5,
    stype:   'title',
  });
  const first = json?.results?.[0]?.record;
  if (!first?.series_id) return null;
  return fetchByMangaUpdatesId(first.series_id);
}

/** Manual search: returns up to 10 results for user selection. */
async function searchMangaUpdates(query, page = 1) {
  const json = await muRequest('POST', '/series/search', {
    search:  query,
    page,
    perpage: 10,
    stype:   'title',
  });
  const results = (json?.results || [])
    .map(r => r?.record)
    .filter(Boolean)
    .map(normalizeSeries)
    .filter(Boolean);
  // Cache the lightweight search records — the apply path can consult
  // these to short-circuit when the user picks one.
  for (const r of results) {
    if (r?.mangaupdates_id) setCached('mangaupdates', r.mangaupdates_id, r);
  }
  return results;
}

/** Fetch full metadata by a known MangaUpdates series ID. */
async function fetchByMangaUpdatesId(seriesId) {
  const json = await muRequest('GET', `/series/${seriesId}`);
  const record = normalizeSeries(json);
  if (record?.mangaupdates_id) setCached('mangaupdates', record.mangaupdates_id, record);
  return record;
}

/**
 * Run `fn` over each item with a small concurrency pool, returning results
 * in the same order. Mirrors `malBatch` in myanimelist.js — MangaUpdates
 * has no native batch endpoint, so the only way to speed up bulk pulls is
 * to issue several requests in parallel with a per-start stagger that caps
 * total throughput at MU_BATCH_CONCURRENCY ÷ MU_BATCH_INTERVAL_MS req/sec.
 *
 * Per-item failures resolve to `null` so a single bad lookup doesn't
 * poison the rest of the chunk.
 */
async function muBatch(items, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex  = 0;
  let nextSlotAt = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;

      const now      = Date.now();
      const startAt  = Math.max(now, nextSlotAt);
      nextSlotAt     = startAt + MU_BATCH_INTERVAL_MS;
      const wait     = startAt - now;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = null;
      }
    }
  }

  const concurrency = Math.min(MU_BATCH_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function fetchBatchByMangaUpdatesIds(ids) {
  return muBatch(ids, id => fetchByMangaUpdatesId(Number(id)));
}

async function fetchBatchFromMangaUpdates(titles) {
  return muBatch(titles, t => fetchFromMangaUpdates(t));
}

module.exports = {
  fetchFromMangaUpdates,
  searchMangaUpdates,
  fetchByMangaUpdatesId,
  fetchBatchByMangaUpdatesIds,
  fetchBatchFromMangaUpdates,
  MU_REQUEST_INTERVAL_MS,
  MU_BATCH_CONCURRENCY,
  MU_BATCH_INTERVAL_MS,
};
