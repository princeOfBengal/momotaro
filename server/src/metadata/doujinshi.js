const fetch = require('node-fetch');

const DOUJINSHI_BASE = 'https://api.doujinshi.info/v1';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Headers for GET requests — no Content-Type (GETs have no body). */
function getHeaders(token) {
  const h = { Accept: 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/** Headers for POST requests. */
function postHeaders(token) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/**
 * Read a fetch response as JSON.
 * Throws a clean error if the response is not JSON (e.g. a Cloudflare HTML error page).
 * Attaches `statusCode` to the error so callers can detect specific HTTP failures.
 */
async function readJson(resp) {
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json') && !ct.includes('text/json')) {
    throw new Error(
      `Doujinshi.info returned a non-JSON response (HTTP ${resp.status}). ` +
      `The service may be temporarily unavailable — please try again later.`
    );
  }
  return resp.json();
}

/** Decode the payload of a JWT without verifying the signature. */
function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Extract user ID from a doujinshi.info access token (JWT sub or id claim). */
function getUserIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return payload.sub || payload.id || payload.user_id || null;
}

// ── Normalization ─────────────────────────────────────────────────────────────

function normalizeBook(book) {
  const name = book.name || {};
  const title = name.english || name.romaji || name.japanese || '';

  // Tags are present on single-book responses, not search results
  const tagList = book.tags?.data || [];
  const genres = [];
  const artists = [];
  const circles = [];

  for (const tag of tagList) {
    const typeSlug = tag.type?.slug || '';
    const tagName = tag.name?.english || tag.name?.romaji || tag.name?.japanese || '';
    if (!tagName) continue;

    if (typeSlug === 'genre') {
      genres.push(tagName);
    } else if (typeSlug === 'artist') {
      artists.push(tagName);
    } else if (typeSlug === 'circle') {
      circles.push(tagName);
    }
  }

  // Prefer artist names; fall back to circle names
  const authorParts = artists.length > 0 ? artists : circles;
  const author = authorParts.length > 0 ? authorParts.join(', ') : null;

  let year = null;
  if (book.date_released) {
    const m = String(book.date_released).match(/^(\d{4})/);
    if (m) year = parseInt(m[1], 10);
  }

  return {
    doujinshi_id: book.slug || null,
    anilist_id:   null,
    mal_id:       null,
    title,
    description:  null,
    status:       'FINISHED',
    year,
    genres,
    score:        null,
    cover_url:    book.cover || null,
    author,
    source:       'doujinshi',
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Login with email/password.
 * Returns { access_token, refresh_token } or throws.
 */
async function loginDoujinshi(email, password) {
  const resp = await fetch(`${DOUJINSHI_BASE}/auth/login`, {
    method:  'POST',
    headers: postHeaders(null),
    body:    JSON.stringify({ email, password }),
  });
  const json = await readJson(resp);
  if (!resp.ok) {
    const msg = json?.message || json?.error || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  const accessToken  = json.access_token  || json.data?.access_token;
  const refreshToken = json.refresh_token || json.data?.refresh_token;
  if (!accessToken) throw new Error('No access_token in response');
  return { access_token: accessToken, refresh_token: refreshToken || null };
}

/**
 * Refresh an expired access token.
 * Returns a new access_token string, or throws.
 */
async function refreshDoujinshiToken(accessToken, refreshToken) {
  if (!refreshToken) throw new Error('No refresh token stored');

  const userId = getUserIdFromToken(accessToken);
  const body   = userId
    ? { id: userId, refresh_token: refreshToken }
    : { refresh_token: refreshToken };

  const resp = await fetch(`${DOUJINSHI_BASE}/auth/login`, {
    method:  'POST',
    headers: postHeaders(null),
    body:    JSON.stringify(body),
  });
  const json = await readJson(resp);
  if (!resp.ok) throw new Error(`Token refresh failed: HTTP ${resp.status}`);

  const newToken = json.access_token || json.data?.access_token;
  if (!newToken) throw new Error('No access_token in refresh response');
  return newToken;
}

// ── Search & fetch ────────────────────────────────────────────────────────────

/**
 * Search doujinshi by title query. Returns an array of normalized book objects.
 *
 * The doujinshi.info backend returns 502 for queries containing spaces.
 * Spaces are replaced with underscores before sending, which the API handles
 * correctly (e.g. "Glasses In Summer Life" → "Glasses_In_Summer_Life").
 */
async function searchDoujinshi(query, token, page = 1) {
  const normalized = query.replace(/ /g, '_');
  const params = new URLSearchParams({ q: normalized, page, limit: 10 });
  const resp   = await fetch(`${DOUJINSHI_BASE}/search?${params}`, {
    headers: getHeaders(token),
  });
  const json = await readJson(resp);
  if (!resp.ok) throw new Error(`Doujinshi.info search failed: HTTP ${resp.status}`);
  if (!Array.isArray(json.data)) return [];
  return json.data.map(normalizeBook);
}

/**
 * Auto-fetch best match for a title. Returns a normalized result or null.
 * Fetches full book details for the top result so tags/author are included.
 */
async function fetchFromDoujinshi(title, token) {
  const results = await searchDoujinshi(title, token);
  if (!results.length) return null;
  const slug = results[0].doujinshi_id;
  if (!slug) return results[0];
  return fetchByDoujinshiSlug(slug, token);
}

/**
 * Fetch full book details by slug. Returns a normalized result or null.
 * This includes tags (genres, author) which are not in search results.
 */
async function fetchByDoujinshiSlug(slug, token) {
  const resp = await fetch(`${DOUJINSHI_BASE}/book/${encodeURIComponent(slug)}`, {
    headers: getHeaders(token),
  });
  const json = await readJson(resp);
  if (!resp.ok || !json.data) return null;
  return normalizeBook(json.data);
}

module.exports = {
  loginDoujinshi,
  refreshDoujinshiToken,
  searchDoujinshi,
  fetchFromDoujinshi,
  fetchByDoujinshiSlug,
  getUserIdFromToken,
};
