const fetch = require('node-fetch');

const ANILIST_URL = 'https://graphql.anilist.co';

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  description(asHtml: false)
  status
  startDate { year }
  genres
  averageScore
  coverImage { large medium }
  staff(perPage: 10, sort: [RELEVANCE]) {
    edges {
      role
      node {
        name { full }
      }
    }
  }
`;

// `isAdult` is intentionally omitted — when no adult filter is provided
// AniList returns both adult and non-adult results, which is what users of
// a self-hosted personal library expect (the library scanner indexes
// whatever the user dropped in; the metadata source should match it).
const AUTO_SEARCH_QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA) {
    ${MEDIA_FIELDS}
  }
}
`;

const MANUAL_SEARCH_QUERY = `
query ($search: String, $page: Int) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: MANGA) {
      ${MEDIA_FIELDS}
    }
  }
}
`;

const FETCH_BY_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: MANGA) {
    ${MEDIA_FIELDS}
  }
}
`;

function buildHeaders(token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// Adaptive rate-limit state. AniList's published limit is 90 req/min, but
// they sometimes temporarily degrade it to 30 req/min and signal that via
// `X-RateLimit-Limit`. We read the header on every successful response and
// recompute a target inter-request delay so callers (the bulk loop) pace
// themselves to the actual cap instead of a hardcoded 700 ms that would
// 429 under degraded service.
//
//   - SAFE_DELAY  — what callers should sleep between requests
//   - lastReset   — Unix seconds when the current window resets, used to
//                   serialise spacing when only a few requests remain
const ANILIST_DEFAULT_LIMIT      = 90;          // documented standard
const ANILIST_SAFETY_MARGIN_MS   = 50;          // padding above the math floor
const ANILIST_MIN_DELAY_MS       = 700;         // never go faster than this
const ANILIST_MAX_DELAY_MS       = 5_000;       // bound the slow path

let _adaptiveDelayMs = ANILIST_MIN_DELAY_MS;
let _rateLimitState = {
  limit:     ANILIST_DEFAULT_LIMIT,
  remaining: ANILIST_DEFAULT_LIMIT,
  resetAt:   0,
};

function recommendedDelayMs() {
  return _adaptiveDelayMs;
}

function updateAdaptiveDelay() {
  const { limit, remaining, resetAt } = _rateLimitState;
  // Target steady-state: spread `limit` requests evenly over the 60 s
  // window plus a small safety margin.
  const steadyMs = Math.ceil(60_000 / Math.max(1, limit)) + ANILIST_SAFETY_MARGIN_MS;

  // If we're nearly out of quota in the current window, slow down so the
  // remaining calls land after the window resets.
  if (resetAt && remaining > 0 && remaining <= 5) {
    const msUntilReset = Math.max(0, resetAt * 1000 - Date.now());
    const perCall = Math.ceil(msUntilReset / Math.max(1, remaining)) + ANILIST_SAFETY_MARGIN_MS;
    _adaptiveDelayMs = Math.max(ANILIST_MIN_DELAY_MS, Math.min(ANILIST_MAX_DELAY_MS, Math.max(steadyMs, perCall)));
    return;
  }

  _adaptiveDelayMs = Math.max(ANILIST_MIN_DELAY_MS, Math.min(ANILIST_MAX_DELAY_MS, steadyMs));
}

function readRateHeaders(resp) {
  const limit     = parseInt(resp.headers.get('x-ratelimit-limit')     || '', 10);
  const remaining = parseInt(resp.headers.get('x-ratelimit-remaining') || '', 10);
  const resetAt   = parseInt(resp.headers.get('x-ratelimit-reset')     || '', 10);
  if (Number.isFinite(limit))     _rateLimitState.limit     = limit;
  if (Number.isFinite(remaining)) _rateLimitState.remaining = remaining;
  if (Number.isFinite(resetAt))   _rateLimitState.resetAt   = resetAt;
  updateAdaptiveDelay();
}

async function anilistRequest(query, variables, token, attempt = 0) {
  const resp = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ query, variables }),
  });

  // Rate limited — back off and retry up to 3 times. Pin the adaptive delay
  // to the slowest setting so subsequent callers don't immediately try
  // again at the previous (now-too-fast) cadence.
  if (resp.status === 429) {
    readRateHeaders(resp);
    _adaptiveDelayMs = ANILIST_MAX_DELAY_MS;
    if (attempt < 3) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
      const delay = Math.min(retryAfter * 1000, 90_000);
      console.warn(`[AniList] Rate limited — retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return anilistRequest(query, variables, token, attempt + 1);
    }
    throw new Error('AniList rate limit exceeded after 3 retries');
  }

  readRateHeaders(resp);

  const json = await resp.json();

  // If the token is invalid, retry without it (unauthenticated metadata fetch)
  if (!resp.ok) {
    const isInvalidToken = json?.errors?.some(e =>
      e.message?.toLowerCase().includes('invalid token') ||
      e.message?.toLowerCase().includes('unauthorized')
    );
    if (isInvalidToken && token) {
      console.warn('[AniList] Stored token is invalid — retrying without authentication');
      const retry = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: buildHeaders(null),
        body: JSON.stringify({ query, variables }),
      });
      if (!retry.ok) throw new Error(`AniList responded with ${retry.status}`);
      return retry.json();
    }
    const msg = json?.errors?.[0]?.message || `HTTP ${resp.status}`;
    throw new Error(`AniList: ${msg}`);
  }

  return json;
}

function normalizeStatus(status) {
  const map = {
    RELEASING: 'RELEASING',
    FINISHED: 'FINISHED',
    NOT_YET_RELEASED: 'UPCOMING',
    CANCELLED: 'CANCELLED',
    HIATUS: 'HIATUS',
  };
  return map[status] || 'UNKNOWN';
}

function normalizeMedia(m) {
  const titleStr = m.title.english || m.title.romaji || m.title.native || '';
  const description = m.description
    ? m.description
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim()
    : null;

  // Extract author/artist from staff edges (Story & Art, Story, Art roles)
  let author = null;
  if (m.staff?.edges?.length > 0) {
    const AUTHOR_ROLES = new Set(['Story & Art', 'Story', 'Art']);
    const names = m.staff.edges
      .filter(e => AUTHOR_ROLES.has(e.role) && e.node?.name?.full)
      .map(e => e.node.name.full);
    const unique = [...new Set(names)];
    if (unique.length > 0) author = unique.join(', ');
  }

  return {
    anilist_id: m.id,
    title: titleStr,
    description,
    status: normalizeStatus(m.status),
    year: m.startDate?.year || null,
    genres: m.genres || [],
    score: m.averageScore ? m.averageScore / 10 : null,
    cover_url: m.coverImage?.large || m.coverImage?.medium || null,
    author,
    source: 'anilist',
    mal_id: null,
  };
}

// Strip release-group / scanner / archive cruft from a folder-derived title
// before sending it to a metadata source. Conservative in two directions:
//
//   1. We only remove tokens we recognise as non-title — we never touch
//      alphabetic words that could be part of the actual series name.
//   2. We run the same cleaner for every source (AniList / MAL / Doujinshi)
//      so there's a single search string shape to reason about.
//
// Example: "Fruits Basket Another (2018-2022) (Digital) (1r0n)"
//       → "Fruits Basket Another"
function cleanSearchTitle(title) {
  let s = String(title || '');

  // ── Bracketed scanner / release-group tags ────────────────────────────────
  // Applied repeatedly so nested brackets collapse: "[[HQ]] Title" → "Title".
  let prev;
  do {
    prev = s;
    s = s
      .replace(/\{[^{}]*\}/g, ' ')
      .replace(/\[[^\[\]]*\]/g, ' ')
      .replace(/\([^()]*\)/g, ' ');
  } while (s !== prev);

  // ── Volume / chapter references ───────────────────────────────────────────
  // "Vol.01", "Volume 3", "v01", "v01-05", "v.1" — all out.
  s = s.replace(/\b(?:vol(?:ume)?|v)\.?\s*\d+(?:[-–.]\d+)?\b/gi, ' ');
  // "Ch.01", "Chapter 03", "c05", "c.05".
  s = s.replace(/\b(?:ch(?:apter)?|c)\.?\s*\d+(?:[-–.]\d+)?\b/gi, ' ');

  // ── Standalone year / year-range outside any bracket ─────────────────────
  // Matches "1997-2003" and bare "2021"; keeps numeric years that are part
  // of the actual title (e.g. "2001 Nights") off-limits unless presented
  // as a range, because a standalone 4-digit year in a folder name is
  // almost always a release marker.
  s = s.replace(/\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b/g, ' ');

  // ── Release-quality / status tags ─────────────────────────────────────────
  const TAG_WORDS = [
    'Digital', 'Physical', 'Scan', 'Scans', 'Scanned',
    'HQ', 'HD', 'SD', 'Hi[- ]?Res', 'Hi[- ]?Quality', 'High[- ]?Quality',
    'LQ', 'Low[- ]?Quality',
    'Raw', 'Raws',
    'Official', 'Unofficial', 'Fan[- ]?made',
    'Complete', 'Completed', 'Ongoing', 'Finished',
    'Omnibus', 'Collected', 'Collection', 'Compilation', 'Box[- ]?set',
    'Uncensored', 'Censored',
    'WebRip', 'Web[- ]?Rip', 'Web[- ]?dl',
    'Fix', 'Fixed', 'Repack', 'Reupload', 'Re[- ]?scan',
    'eng', 'English', 'ESP', 'Spanish', 'JPN', 'Japanese',
  ];
  const tagRe = new RegExp(`\\b(?:${TAG_WORDS.join('|')})\\b`, 'gi');
  s = s.replace(tagRe, ' ');

  // ── Normalise separators ──────────────────────────────────────────────────
  s = s.replace(/[-_]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // Trim trailing / leading punctuation that cleaning may have exposed.
  s = s.replace(/^[\s.,;:!?\-]+|[\s.,;:!?\-]+$/g, '').trim();

  return s;
}

/** Auto-fetch: returns best single result or null. */
async function fetchFromAniList(title, token) {
  const search = cleanSearchTitle(title);
  const json = await anilistRequest(AUTO_SEARCH_QUERY, { search }, token);
  if (json.errors || !json.data?.Media) return null;
  return normalizeMedia(json.data.Media);
}

/**
 * Batch auto-fetch: sends one GraphQL request with aliased Media queries for
 * each title and returns results in the same order as the input. Null entries
 * mean "no match"; a whole-batch failure throws.
 *
 * AniList's rate limit is per request (not per alias), so batching 5–10 titles
 * per call roughly cuts HTTP request count by that factor.
 */
async function fetchBatchFromAniList(titles, token) {
  if (!titles.length) return [];

  const cleaned = titles.map(cleanSearchTitle);
  const varDefs     = cleaned.map((_, i) => `$s${i}: String`).join(', ');
  const aliasBlocks = cleaned
    .map((_, i) => `q${i}: Media(search: $s${i}, type: MANGA, isAdult: false) { ...MediaFields }`)
    .join('\n  ');

  const query = `
    query (${varDefs}) {
      ${aliasBlocks}
    }
    fragment MediaFields on Media {
      ${MEDIA_FIELDS}
    }
  `;
  const variables = Object.fromEntries(cleaned.map((s, i) => [`s${i}`, s]));

  const json = await anilistRequest(query, variables, token);
  // AniList populates `errors` when individual aliases return null but still
  // returns data for the rest, so we don't bail on json.errors here.
  if (!json.data) return titles.map(() => null);

  return titles.map((_, i) => {
    const media = json.data[`q${i}`];
    return media ? normalizeMedia(media) : null;
  });
}

/** Manual search: returns up to 10 results for user selection. */
async function searchAniList(query, token, page = 1) {
  const json = await anilistRequest(MANUAL_SEARCH_QUERY, { search: query, page }, token);
  if (json.errors || !json.data?.Page?.media) return [];
  return json.data.Page.media.map(normalizeMedia);
}

/** Fetch full metadata by a known AniList ID. */
async function fetchByAniListId(anilistId, token) {
  const json = await anilistRequest(FETCH_BY_ID_QUERY, { id: anilistId }, token);
  if (json.errors || !json.data?.Media) return null;
  return normalizeMedia(json.data.Media);
}

/**
 * Batched fetch-by-ID. Same alias pattern as fetchBatchFromAniList, but
 * resolves already-linked titles straight to their canonical record instead
 * of doing a search. Used by bulk-refresh flows to refetch manga whose
 * `anilist_id` is already set.
 *
 * Returns results in the same order as `ids`; a null slot means the ID
 * resolved to no media (deleted / inaccessible).
 */
async function fetchBatchByAniListIds(ids, token) {
  if (!ids.length) return [];
  const varDefs     = ids.map((_, i) => `$id${i}: Int`).join(', ');
  const aliasBlocks = ids
    .map((_, i) => `q${i}: Media(id: $id${i}, type: MANGA) { ...MediaFields }`)
    .join('\n  ');

  const query = `
    query (${varDefs}) {
      ${aliasBlocks}
    }
    fragment MediaFields on Media {
      ${MEDIA_FIELDS}
    }
  `;
  const variables = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));

  const json = await anilistRequest(query, variables, token);
  if (!json.data) return ids.map(() => null);

  return ids.map((_, i) => {
    const media = json.data[`q${i}`];
    return media ? normalizeMedia(media) : null;
  });
}

const MEDIA_LIST_ENTRY_QUERY = `
query ($userId: Int, $mediaId: Int) {
  MediaList(userId: $userId, mediaId: $mediaId) {
    status
    progress
    progressVolumes
    score(format: POINT_10_DECIMAL)
    startedAt { year month day }
    completedAt { year month day }
    updatedAt
  }
}
`;

/**
 * Fetch a user's list entry for a specific manga.
 * Returns the entry object or null if not on their list.
 */
async function getMediaListEntry(token, userId, mediaId) {
  const json = await anilistRequest(MEDIA_LIST_ENTRY_QUERY, { userId: parseInt(userId, 10), mediaId }, token);
  if (json.errors || !json.data?.MediaList) return null;
  return json.data.MediaList;
}

const VIEWER_QUERY = `
query {
  Viewer {
    id
    name
    avatar { large medium }
    siteUrl
  }
}
`;

// Built dynamically — see saveMediaListEntry below

/** Fetch the authenticated user's profile. Requires a valid token. */
async function getViewer(token) {
  if (!token) throw new Error('Token required');
  const resp = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ query: VIEWER_QUERY }),
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) {
    const msg = json?.errors?.[0]?.message || `HTTP ${resp.status}`;
    throw new Error(`AniList: ${msg}`);
  }
  return json.data.Viewer;
}

/**
 * Update a manga's reading status and progress on the user's AniList list.
 * Pass either `chapters` or `volumes` (or both) — only the provided fields are
 * included in the mutation so we never accidentally zero-out the other one.
 *
 * status: 'CURRENT' | 'COMPLETED' | 'PLANNING' | 'PAUSED' | 'DROPPED'
 * options: { chapters?: number, volumes?: number, score?: number }
 * score uses POINT_10_DECIMAL format (0–10, one decimal place supported)
 */
async function saveMediaListEntry(token, mediaId, status, { chapters = null, volumes = null, score = null } = {}) {
  if (!token) return null;

  // Build the mutation dynamically — only declare variables that have values
  const argDefs = ['$mediaId: Int', '$status: MediaListStatus'];
  const argVals = ['mediaId: $mediaId', 'status: $status'];
  const variables = { mediaId, status };

  if (chapters !== null) {
    argDefs.push('$progress: Int');
    argVals.push('progress: $progress');
    variables.progress = chapters;
  }
  if (volumes !== null) {
    argDefs.push('$progressVolumes: Int');
    argVals.push('progressVolumes: $progressVolumes');
    variables.progressVolumes = volumes;
  }
  if (score !== null) {
    argDefs.push('$score: Float');
    argVals.push('score: $score');
    variables.score = score;
  }

  const mutation = `
    mutation (${argDefs.join(', ')}) {
      SaveMediaListEntry(${argVals.join(', ')}) {
        id status progress progressVolumes
      }
    }
  `;

  const resp = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ query: mutation, variables }),
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) {
    const msg = json?.errors?.[0]?.message || `HTTP ${resp.status}`;
    throw new Error(`AniList: ${msg}`);
  }
  return json.data.SaveMediaListEntry;
}

module.exports = { fetchFromAniList, fetchBatchFromAniList, searchAniList, fetchByAniListId, fetchBatchByAniListIds, cleanSearchTitle, recommendedDelayMs, getViewer, saveMediaListEntry, getMediaListEntry };
