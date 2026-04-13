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

const AUTO_SEARCH_QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA, isAdult: false) {
    ${MEDIA_FIELDS}
  }
}
`;

const MANUAL_SEARCH_QUERY = `
query ($search: String, $page: Int) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: MANGA, isAdult: false) {
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

async function anilistRequest(query, variables, token, attempt = 0) {
  const resp = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ query, variables }),
  });

  // Rate limited — back off and retry up to 3 times
  if (resp.status === 429) {
    if (attempt < 3) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
      const delay = Math.min(retryAfter * 1000, 90_000);
      console.warn(`[AniList] Rate limited — retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return anilistRequest(query, variables, token, attempt + 1);
    }
    throw new Error('AniList rate limit exceeded after 3 retries');
  }

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

function cleanSearchTitle(title) {
  return title
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Auto-fetch: returns best single result or null. */
async function fetchFromAniList(title, token) {
  const search = cleanSearchTitle(title);
  const json = await anilistRequest(AUTO_SEARCH_QUERY, { search }, token);
  if (json.errors || !json.data?.Media) return null;
  return normalizeMedia(json.data.Media);
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

module.exports = { fetchFromAniList, searchAniList, fetchByAniListId, getViewer, saveMediaListEntry, getMediaListEntry };
