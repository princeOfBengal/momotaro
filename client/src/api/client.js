// ── Server URL resolution ────────────────────────────────────────────────────
// PWA / dev: same-origin (BASE = ''), so /api/* hits whatever host served the
// HTML. Android app (wrapped via Capacitor): the WebView serves files from
// `https://localhost`, which obviously can't reach the real Momotaro server —
// the user pairs the app to a server during onboarding and the URL is saved
// to localStorage. Read on every call so a re-pair takes effect without a
// reload.
const BUILD_DEFAULT_BASE = import.meta.env.VITE_API_BASE || '';
const SERVER_URL_KEY = 'momotaro_server_url';

function getServerUrl() {
  const saved = localStorage.getItem(SERVER_URL_KEY);
  if (saved) return saved.replace(/\/+$/, '');
  return BUILD_DEFAULT_BASE;
}

function setServerUrl(url) {
  if (url) localStorage.setItem(SERVER_URL_KEY, url.replace(/\/+$/, ''));
  else     localStorage.removeItem(SERVER_URL_KEY);
}

function clearServerUrl() {
  localStorage.removeItem(SERVER_URL_KEY);
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function getDeviceId() {
  let id = localStorage.getItem('momotaro_device_id');
  if (!id) {
    id = crypto.randomUUID?.() ?? generateUUID();
    localStorage.setItem('momotaro_device_id', id);
  }
  return id;
}

// ── Admin session token ─────────────────────────────────────────────────────
// Set by POST /api/admin/setup or /api/admin/login. Stored in localStorage so
// the admin stays signed in across page reloads. Sent on every request via
// `X-Admin-Token`; the server treats it as a satisfying credential for both
// admin-gated and client-gated routes.
const ADMIN_TOKEN_KEY = 'momotaro_admin_token';

function getAdminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) || null;
}

function setAdminToken(token) {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
  else       localStorage.removeItem(ADMIN_TOKEN_KEY);
}

function clearAdminToken() {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

// ── Paired-client token ─────────────────────────────────────────────────────
// Issued at the end of the PIN-pairing flow (see `Pairing.jsx`). The Android
// app saves this after onboarding; subsequent requests go out with both the
// `Authorization: Bearer` header (preferred) and the server URL pointing at
// the paired host. The PWA on the same LAN as the server typically does not
// need this — LAN bypass + no auth_enabled covers that case.
const CLIENT_TOKEN_KEY = 'momotaro_client_token';

function getClientToken() {
  return localStorage.getItem(CLIENT_TOKEN_KEY) || null;
}

function setClientToken(token) {
  if (token) localStorage.setItem(CLIENT_TOKEN_KEY, token);
  else       localStorage.removeItem(CLIENT_TOKEN_KEY);
}

function clearClientToken() {
  localStorage.removeItem(CLIENT_TOKEN_KEY);
}

// ── User session token ───────────────────────────────────────────────────────
// Issued by POST /api/users/login | /register. Identifies *who* is reading
// (distinct from the paired-client token, which identifies the device). Sent on
// every request via `X-User-Token`. `momotaro_active_user_id` mirrors the
// logged-in user's id so non-React utilities (readingProgress) can namespace
// per-user localStorage without a round-trip.
const USER_TOKEN_KEY = 'momotaro_user_token';
const ACTIVE_USER_KEY = 'momotaro_active_user_id';

function getUserToken() {
  return localStorage.getItem(USER_TOKEN_KEY) || null;
}

function setUserToken(token) {
  if (token) localStorage.setItem(USER_TOKEN_KEY, token);
  else       localStorage.removeItem(USER_TOKEN_KEY);
}

function clearUserToken() {
  localStorage.removeItem(USER_TOKEN_KEY);
  localStorage.removeItem(ACTIVE_USER_KEY);
}

function getActiveUserId() {
  return localStorage.getItem(ACTIVE_USER_KEY) || null;
}

function setActiveUserId(id) {
  if (id === null || id === undefined) localStorage.removeItem(ACTIVE_USER_KEY);
  else localStorage.setItem(ACTIVE_USER_KEY, String(id));
}

/**
 * Walk a parsed JSON response and rewrite any string that points at a gated
 * media endpoint the SPA will load via a native browser element (`<img src>`
 * etc), which can't carry the Authorization header. Two patterns match:
 *
 *   - `/thumbnails/<shard>/<file>` — library cover art baked into many
 *     responses as `cover_url`. Served by express.static, gated by the
 *     same client/admin auth middleware.
 *   - `/api/pages/<id>/image` — manga page bytes. The
 *     `api.pageImageUrl()` helper already does this for paths the SPA
 *     constructs locally; this catches the server-baked `page_image_url`
 *     field used by ArtGalleryRibbon (home page + dedicated /art-gallery).
 *
 * Two rewrites are applied:
 *   1. Prepend the saved server URL when the URL is server-relative.
 *      Necessary in the Capacitor APK because the WebView origin is
 *      `https://localhost`, so a bare `/thumbnails/...` would otherwise
 *      try to load from the asset shell instead of the real Momotaro
 *      server. In the PWA `getServerUrl()` returns '', so the URL is
 *      left relative and resolves same-origin as before.
 *   2. Append `?t=<token>` so the image request carries auth.
 *
 * External URLs (AniList covers, MangaDex thumbs) pass through.
 * Already-tagged URLs are not double-tagged. Recurses into arrays and
 * plain objects. Returns a shallow copy; the input is not mutated.
 */
const TOKEN_BEARING_URL_RE = /\/thumbnails\/|\/api\/pages\/\d+\/image(?:\?|$|\/)/;

function rewriteMediaUrls(value, serverUrl, token) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (!TOKEN_BEARING_URL_RE.test(value)) return value;
    let out = value;
    if (serverUrl && out.startsWith('/')) {
      out = serverUrl + out;
    }
    if (token && !/[?&]t=/.test(out)) {
      const sep = out.includes('?') ? '&' : '?';
      out = `${out}${sep}t=${encodeURIComponent(token)}`;
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map(v => rewriteMediaUrls(v, serverUrl, token));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = rewriteMediaUrls(value[k], serverUrl, token);
    }
    return out;
  }
  return value;
}

async function apiFetch(path, options = {}) {
  // `signal` is the caller-supplied AbortSignal (used by Library to cancel
  // stale debounced fetches when the user keeps typing). It is composed with
  // the internal timeout signal so either one can abort the request, and we
  // can distinguish "user cancelled" from "timed out" in the catch.
  //
  // `raw: true` returns the full JSON envelope ({ data, next_cursor, ... })
  // instead of just `data`. Used for paginated endpoints where the caller
  // needs the cursor + has_more fields alongside the rows.
  const { timeoutMs = 15_000, signal: userSignal, raw = false, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let onUserAbort = null;
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort();
    } else {
      onUserAbort = () => controller.abort();
      userSignal.addEventListener('abort', onUserAbort, { once: true });
    }
  }

  const adminToken  = getAdminToken();
  const clientToken = getClientToken();
  const userToken   = getUserToken();
  try {
    const resp = await fetch(`${getServerUrl()}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceId(),
        ...(adminToken  ? { 'X-Admin-Token': adminToken } : {}),
        ...(clientToken ? { 'Authorization': `Bearer ${clientToken}` } : {}),
        ...(userToken   ? { 'X-User-Token': userToken } : {}),
        ...fetchOptions.headers,
      },
    });
    const json = await resp.json();
    if (!resp.ok) {
      // Attach the parsed body + status so callers that need structured fields
      // (e.g. login's attempts_remaining / seconds_remaining) can read them.
      // Existing callers keep working — they only read `err.message`.
      const err = new Error(json.error || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.body = json;
      throw err;
    }
    // Rewrite any `/thumbnails/*` and `/api/pages/N/image` URLs the server
    // baked into the response so `<img src>` requests (a) hit the real
    // server instead of the Capacitor asset shell, and (b) carry the
    // auth token. Gated on clientToken: pre-pairing flows (health check,
    // pairing handshake) intentionally skip the walk to preserve the
    // original code path. Post-pairing the token is always present, which
    // is when image URLs need fixing up anyway.
    const rewritten = clientToken ? rewriteMediaUrls(json, getServerUrl(), clientToken) : json;
    if (raw) return rewritten;
    return rewritten.data !== undefined ? rewritten.data : rewritten;
  } catch (err) {
    if (err.name === 'AbortError') {
      // Bubble user-cancellation as an AbortError so the caller can ignore it
      // without surfacing a misleading "Request timed out" to the UI.
      if (userSignal?.aborted) throw err;
      throw new Error('Request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (userSignal && onUserAbort) userSignal.removeEventListener('abort', onUserAbort);
  }
}

// Authenticated file download for admin endpoints. Uses fetch + blob + a
// synthetic `<a download>` so the X-Admin-Token header rides along — native
// browser navigation can't attach custom headers. Shared by the per-user
// export and the all-users reading-history CSV.
async function _adminDownload(path, fallbackName) {
  const adminToken = getAdminToken();
  if (!adminToken) throw new Error('Admin session required');
  return _tokenDownload(path, { 'X-Admin-Token': adminToken }, fallbackName);
}

// Same shape as _adminDownload but signed with the per-user session token.
// `requireUser` reads only the X-User-Token header (no ?t= fallback), so any
// CSV/JSON export gated by requireUser has to go through fetch + blob too —
// the same constraint that drove _adminDownload.
async function _userDownload(path, fallbackName) {
  const userToken = getUserToken();
  if (!userToken) throw new Error('Sign in to export your data');
  return _tokenDownload(path, { 'X-User-Token': userToken }, fallbackName);
}

async function _tokenDownload(path, headers, fallbackName) {
  const resp = await fetch(`${getServerUrl()}${path}`, { headers });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); if (j?.error) msg = j.error; } catch (_) { /* not JSON */ }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const cd = resp.headers.get('Content-Disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m ? m[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const _rawApi = {
  // Library
  getLibrary: (params = {}, options = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiFetch(`/api/library${q ? '?' + q : ''}`, options);
  },
  getManga: (id) => apiFetch(`/api/manga/${id}`),
  // Single batched payload for the offline-download bootstrap: manga +
  // cover URL + full chapter list, plus a `server_updated_at` field the
  // client persists to detect a stale local copy later.
  getOfflinePackage: (id) => apiFetch(`/api/manga/${id}/offline-package`),
  updateManga: (id, body) =>
    apiFetch(`/api/manga/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteManga: (id) =>
    apiFetch(`/api/manga/${id}`, { method: 'DELETE' }),
  getChapters: (mangaId) => apiFetch(`/api/manga/${mangaId}/chapters`),
  getChapter: (id) => apiFetch(`/api/chapters/${id}`),
  getPages: (chapterId) => apiFetch(`/api/chapters/${chapterId}/pages`),
  triggerScan: () => apiFetch('/api/scan', { method: 'POST' }),
  getScanStatus: () => apiFetch('/api/scan/status'),
  // Re-scan only one manga's folder. Synchronous on the server — the
  // promise resolves once the folder walk + chapter index + thumbnail
  // generation finish, so the caller can immediately re-fetch the manga
  // and show the new chapters. Returns { added, removed,
  // before_chapter_count, after_chapter_count }. The default 15 s timeout
  // is plenty: a single folder rarely has more than ~200 chapters and the
  // incremental mtime check skips anything unchanged.
  scanManga: (id) => apiFetch(`/api/manga/${id}/scan`, { method: 'POST', timeoutMs: 60_000 }),

  // Progress
  getProgress: (mangaId) => apiFetch(`/api/progress/${mangaId}`),
  updateProgress: (mangaId, body) =>
    apiFetch(`/api/progress/${mangaId}`, { method: 'PUT', body: JSON.stringify(body) }),
  resetProgress: (mangaId) =>
    apiFetch(`/api/progress/${mangaId}`, { method: 'DELETE' }),
  markChapterRead: (mangaId, chapterId, completed) =>
    apiFetch(`/api/progress/${mangaId}/chapter/${chapterId}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed }),
    }),

  // Art Gallery
  getGallery: (mangaId) => apiFetch(`/api/manga/${mangaId}/gallery`),
  addToGallery: (mangaId, pageId) =>
    apiFetch(`/api/manga/${mangaId}/gallery`, {
      method: 'POST',
      body: JSON.stringify({ pageId }),
    }),
  removeFromGalleryByPage: (mangaId, pageId) =>
    apiFetch(`/api/manga/${mangaId}/gallery/page/${pageId}`, { method: 'DELETE' }),
  removeFromGallery: (mangaId, itemId) =>
    apiFetch(`/api/manga/${mangaId}/gallery/${itemId}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => apiFetch('/api/settings'),
  saveSettings: (body) =>
    apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  saveMalClientId: (clientId) =>
    apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ mal_client_id: clientId }) }),
  clearAnilistToken: () =>
    apiFetch('/api/settings/anilist_token', { method: 'DELETE' }),

  // AniList auth
  anilistExchange: (code, redirect_uri) =>
    apiFetch('/api/auth/anilist/exchange', { method: 'POST', body: JSON.stringify({ code, redirect_uri }) }),
  anilistLogout: () =>
    apiFetch('/api/auth/anilist', { method: 'DELETE' }),

  // Doujinshi.info auth
  doujinshiLogin: (email, password) =>
    apiFetch('/api/auth/doujinshi/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  doujinshiLogout: () =>
    apiFetch('/api/auth/doujinshi', { method: 'DELETE' }),

  // Libraries
  getLibraries: () => apiFetch('/api/libraries'),
  createLibrary: (body) =>
    apiFetch('/api/libraries', { method: 'POST', body: JSON.stringify(body) }),
  updateLibrary: (id, body) =>
    apiFetch(`/api/libraries/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLibrary: (id) =>
    apiFetch(`/api/libraries/${id}`, { method: 'DELETE' }),
  scanLibrary: (id) =>
    apiFetch(`/api/libraries/${id}/scan`, { method: 'POST' }),

  // Metadata
  refreshMetadata: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/refresh-metadata`, { method: 'POST' }),
  refreshDoujinshiMetadata: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/refresh-doujinshi-metadata`, { method: 'POST' }),
  bulkMetadata: (libraryId, source = 'anilist') =>
    apiFetch(`/api/libraries/${libraryId}/bulk-metadata`, {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),
  bulkOptimize: (libraryId) =>
    apiFetch(`/api/libraries/${libraryId}/bulk-optimize`, { method: 'POST' }),
  exportMetadata: (libraryId) =>
    apiFetch(`/api/libraries/${libraryId}/export-metadata`, {
      method: 'POST',
      // Local-source manga linked to a third-party trigger per-item API fetches,
      // so allow up to 10 minutes for very large libraries.
      timeoutMs: 600_000,
    }),
  // Wipe every third-party metadata field for every manga in a library and
  // delete any local metadata JSON sidecars saved into their folders. Walks
  // the whole library on disk, so allow up to 10 minutes.
  resetLibraryMetadata: (libraryId) =>
    apiFetch(`/api/libraries/${libraryId}/reset-metadata`, {
      method: 'POST',
      timeoutMs: 600_000,
    }),
  searchAnilist: (q, page = 1) =>
    apiFetch(`/api/anilist/search?${new URLSearchParams({ q, page })}`),
  applyMetadata: (mangaId, anilistId) =>
    apiFetch(`/api/manga/${mangaId}/apply-metadata`, {
      method: 'POST',
      body: JSON.stringify({ anilist_id: anilistId }),
    }),
  searchDoujinshi: (q, page = 1) =>
    apiFetch(`/api/doujinshi/search?${new URLSearchParams({ q, page })}`),
  applyDoujinshiMetadata: (mangaId, slug) =>
    apiFetch(`/api/manga/${mangaId}/apply-doujinshi-metadata`, {
      method: 'POST',
      body: JSON.stringify({ slug }),
    }),
  resetMetadata: (mangaId, source) =>
    apiFetch(`/api/manga/${mangaId}/reset-metadata`, {
      method: 'POST',
      body: JSON.stringify(source ? { source } : {}),
    }),
  // Per-manga export. Pass `source` ('anilist' | 'myanimelist' | 'doujinshi')
  // to fetch from that specific source's linkage and write a metadata.json
  // tagged with that source — overwrites any existing file unconditionally.
  // Omit `source` for the legacy auto-priority behaviour (highest-priority
  // linked source wins).
  exportMangaMetadata: (mangaId, source) =>
    apiFetch(`/api/manga/${mangaId}/export-metadata`, {
      method: 'POST',
      body: JSON.stringify(source ? { source } : {}),
    }),
  refreshMalMetadata: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/refresh-mal-metadata`, { method: 'POST' }),
  searchMal: (q, page = 1) =>
    apiFetch(`/api/mal/search?${new URLSearchParams({ q, page })}`),
  applyMalMetadata: (mangaId, malId) =>
    apiFetch(`/api/manga/${mangaId}/apply-mal-metadata`, {
      method: 'POST',
      body: JSON.stringify({ mal_id: malId }),
    }),

  // MangaUpdates — public read endpoints, no auth needed.
  refreshMangaUpdatesMetadata: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/refresh-mangaupdates-metadata`, { method: 'POST' }),
  searchMangaUpdates: (q, page = 1) =>
    apiFetch(`/api/mangaupdates/search?${new URLSearchParams({ q, page })}`),
  applyMangaUpdatesMetadata: (mangaId, mangaUpdatesId) =>
    apiFetch(`/api/manga/${mangaId}/apply-mangaupdates-metadata`, {
      method: 'POST',
      body: JSON.stringify({ mangaupdates_id: mangaUpdatesId }),
    }),

  getAnilistStatus: (mangaId) => apiFetch(`/api/manga/${mangaId}/anilist-status`),
  updateAnilistProgress: (mangaId, body) =>
    apiFetch(`/api/manga/${mangaId}/anilist-progress`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Reading Lists
  getReadingLists: () => apiFetch('/api/reading-lists'),
  createReadingList: (body) =>
    apiFetch('/api/reading-lists', { method: 'POST', body: JSON.stringify(body) }),
  deleteReadingList: (id) =>
    apiFetch(`/api/reading-lists/${id}`, { method: 'DELETE' }),
  getReadingListManga: (id, params = {}, options = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiFetch(`/api/reading-lists/${id}/manga${q ? '?' + q : ''}`, options);
  },
  addToReadingList: (listId, mangaId) =>
    apiFetch(`/api/reading-lists/${listId}/manga`, { method: 'POST', body: JSON.stringify({ manga_id: mangaId }) }),
  removeFromReadingList: (listId, mangaId) =>
    apiFetch(`/api/reading-lists/${listId}/manga/${mangaId}`, { method: 'DELETE' }),
  getMangaReadingLists: (mangaId) => apiFetch(`/api/manga/${mangaId}/reading-lists`),

  // Thumbnail
  setPageAsThumbnail: (mangaId, pageId) =>
    apiFetch(`/api/manga/${mangaId}/set-thumbnail`, {
      method: 'POST',
      body: JSON.stringify({ page_id: pageId }),
    }),
  setThumbnailFromFile: (mangaId, savedFilename) =>
    apiFetch(`/api/manga/${mangaId}/set-thumbnail`, {
      method: 'POST',
      body: JSON.stringify({ saved_filename: savedFilename }),
    }),
  getThumbnailOptions: (mangaId) => apiFetch(`/api/manga/${mangaId}/thumbnail-options`),
  generateChapterCovers: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/generate-chapter-covers`, {
      method: 'POST',
      // Generates one 300×430 webp per chapter (one CBZ extract each on a cold
      // cache); long-tail manga can have hundreds of chapters, so allow up to
      // 10 minutes before the client gives up.
      timeoutMs: 600_000,
    }),

  // Optimize
  optimizeManga: (id) => apiFetch(`/api/manga/${id}/optimize`, { method: 'POST' }),

  // Info
  getMangaInfo: (id) => apiFetch(`/api/manga/${id}/info`),

  // Admin / Database Management
  getCbzCacheSize: () => apiFetch('/api/admin/cbz-cache-size'),
  clearCbzCache: () => apiFetch('/api/admin/clear-cbz-cache', { method: 'POST' }),
  getCbzCacheSettings: () => apiFetch('/api/admin/cbz-cache-settings'),
  saveCbzCacheSettings: (body) =>
    apiFetch('/api/admin/cbz-cache-settings', { method: 'PUT', body: JSON.stringify(body) }),
  regenerateThumbnails: () => apiFetch('/api/admin/regenerate-thumbnails', { method: 'POST' }),
  resetThumbnails:      () => apiFetch('/api/admin/reset-thumbnails',      { method: 'POST' }),
  vacuumDb: () => apiFetch('/api/admin/vacuum-db', { method: 'POST' }),

  // Config backup (export/import). Routed through _adminDownload so the
  // X-Admin-Token header rides along — `requireAdmin` is mount-line on
  // configRoutes/adminRoutes and doesn't accept a `?t=` query token, so a
  // native browser navigation (window.location.href) would 401.
  exportConfig: () => _adminDownload('/api/admin/export-config', 'momotaro-config.json'),
  // CSV download: one row per manga, columns: Library, Series Name
  // (AniList/MAL/MangaUpdates/Doujinshi.info), Folder path, Number of
  // chapters, Number of volumes, Author. Used for manually spot-checking
  // that third-party metadata matches are correct.
  exportSeriesList: () => _adminDownload('/api/admin/export-series-list', 'momotaro-series-list.csv'),
  importConfig: (payload) =>
    apiFetch('/api/admin/import-config', {
      method: 'POST',
      body: JSON.stringify(payload),
      // Import can touch every row in the DB; allow up to 5 minutes.
      timeoutMs: 300_000,
    }),

  // System Logs
  getSystemLogs: () => apiFetch('/api/admin/logs'),
  exportSystemLogs: () => _adminDownload('/api/admin/logs/export', 'momotaro-system-logs.txt'),

  // Home page — single aggregate fetch for every ribbon (continue reading,
  // discover, recently added, art gallery, top-manga-per-genre). Scoped
  // server-side to visible libraries; cached for 30 s in-process keyed by
  // `min_score`. Pass `{ minScore }` to filter the per-genre ribbons by a
  // rating threshold (default 7); the value is clamped to [0, 10] server-side.
  getHome: ({ minScore } = {}) => {
    const params = new URLSearchParams();
    if (minScore !== undefined && minScore !== null) {
      params.set('min_score', String(minScore));
    }
    const qs = params.toString();
    return apiFetch(`/api/home${qs ? '?' + qs : ''}`);
  },

  // Genres — every distinct genre across visible libraries with a
  // representative top-rated cover per genre. Powers the Browse By Genre page.
  getGenres: () => apiFetch('/api/genres'),

  // Every saved art-gallery page across visible libraries, grouped by series.
  // Items include `width` / `height` so landscape pages can render at their
  // natural aspect ratio on the dedicated Art Gallery page.
  getAllGallery: () => apiFetch('/api/gallery/all'),

  // Statistics. Pass a library ID to scope every aggregate to that library;
  // omit or pass null for the All Libraries view.
  getStats: (libraryId = null) => {
    const q = libraryId == null ? '' : `?library_id=${encodeURIComponent(libraryId)}`;
    return apiFetch(`/api/stats${q}`);
  },

  // Third Party Sourcing — search and download chapters from external sources
  // (MangaDex today; comix.to + scheduler are explicit follow-ups). All
  // download work happens server-side via the queue in
  // server/src/downloader/queue.js — these endpoints just enqueue and report.
  listSources: () => apiFetch('/api/sources'),
  searchSource: (source, q) =>
    apiFetch(`/api/sources/${source}/search?${new URLSearchParams({ q })}`),
  getSourceSeries: (source, id) =>
    apiFetch(`/api/sources/${source}/series/${encodeURIComponent(id)}`),
  // Pass `mangaId` to also flag chapters whose chapter-number matches one
  // already in that local manga folder (so the picker can pre-uncheck them).
  getSourceChapters: (source, id, { lang = 'en', mangaId } = {}) => {
    const params = new URLSearchParams({ lang });
    if (mangaId) params.set('manga_id', String(mangaId));
    return apiFetch(`/api/sources/${source}/series/${encodeURIComponent(id)}/chapters?${params}`);
  },
  enqueueSourceDownload: (source, body) =>
    apiFetch(`/api/sources/${source}/download`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listSourceDownloads: (limit = 50) =>
    apiFetch(`/api/sources/downloads?limit=${limit}`),
  cancelSourceDownload: (id) =>
    apiFetch(`/api/sources/downloads/${id}`, { method: 'DELETE' }),
  // Re-queues a failed or cancelled job. Server resets run-state and bumps
  // created_at so the retry lands at the back of the queue.
  retrySourceDownload: (id) =>
    apiFetch(`/api/sources/downloads/${id}/retry`, { method: 'POST' }),
  clearFinishedDownloads: () =>
    apiFetch('/api/sources/downloads/clear-finished', { method: 'POST' }),
  matchExistingManga: (title) =>
    apiFetch(`/api/sources/match-existing?${new URLSearchParams({ title })}`),
  linkMangaToSource: (mangaId, source, sourceId) =>
    apiFetch(`/api/manga/${mangaId}/link-source`, {
      method: 'POST',
      body: JSON.stringify({ source, source_id: sourceId }),
    }),
  unlinkMangaFromSource: (mangaId, source) =>
    apiFetch(`/api/manga/${mangaId}/link-source/${source}`, { method: 'DELETE' }),

  // Per-manga record of known source URLs. The download flow auto-inserts
  // these whenever a chapter is queued for the manga, and the user can also
  // add/edit/remove via the MangaDetail Third Party Sources modal.
  getMangaSourceUrls: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/source-urls`),
  addMangaSourceUrl: (mangaId, body) =>
    apiFetch(`/api/manga/${mangaId}/source-urls`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateMangaSourceUrl: (mangaId, urlId, body) =>
    apiFetch(`/api/manga/${mangaId}/source-urls/${urlId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteMangaSourceUrl: (mangaId, urlId) =>
    apiFetch(`/api/manga/${mangaId}/source-urls/${urlId}`, { method: 'DELETE' }),

  // Per-manga schedule for auto-checking the recorded source URLs and
  // downloading any new chapters. Server poll cadence is one minute, so the
  // schedule's effective resolution is "the minute you set in time_of_day,
  // give or take 60s".
  listSchedules: () => apiFetch('/api/schedules'),
  getMangaSchedule: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/schedule`),
  saveMangaSchedule: (mangaId, body) =>
    apiFetch(`/api/manga/${mangaId}/schedule`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteMangaSchedule: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/schedule`, { method: 'DELETE' }),
  // Triggers an immediate check, independent of the schedule. Returns the
  // same { ok, summary, enqueued } shape the poll loop writes to last_result.
  runMangaScheduleNow: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/schedule/run-now`, {
      method: 'POST',
      // The check fetches one HTTP request per linked URL plus inserts; on a
      // slow network with several mirrors this can take longer than the
      // default 15s budget.
      timeoutMs: 60_000,
    }),

  // ── Remote-access admin + pairing ──────────────────────────────────────
  // These endpoints back the Client Management section in Settings. The
  // admin token returned by `adminSetup` and `adminLogin` is persisted by
  // `setAdminToken` so subsequent requests in the same browser session pick
  // it up via the `X-Admin-Token` header.
  getAuthStatus: () => apiFetch('/api/admin/auth-status'),

  // ── User accounts (login / register / logout / me) ─────────────────────
  // login & register persist the returned session token (and the active user
  // id, for per-user localStorage namespacing) so every subsequent request
  // carries `X-User-Token`. logout revokes server-side then clears locally.
  register: async (username, password, displayName) => {
    const data = await apiFetch('/api/users/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, display_name: displayName }),
    });
    if (data?.user_token) setUserToken(data.user_token);
    if (data?.user?.id != null) setActiveUserId(data.user.id);
    return data;
  },
  login: async (username, password) => {
    const data = await apiFetch('/api/users/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    if (data?.user_token) setUserToken(data.user_token);
    if (data?.user?.id != null) setActiveUserId(data.user.id);
    return data;
  },
  logout: async () => {
    try {
      await apiFetch('/api/users/logout', { method: 'POST' });
    } finally {
      clearUserToken();
    }
  },
  getMe: () => apiFetch('/api/users/me'),
  userExists: (username) =>
    apiFetch(`/api/users/exists?${new URLSearchParams({ username })}`),
  // Change the signed-in user's own password. The server revokes every other
  // session for this account and mints a fresh token for the calling device,
  // which we persist immediately so the next request still authenticates.
  changeUserPassword: async (currentPassword, newPassword) => {
    const data = await apiFetch('/api/users/me/password', {
      method: 'PUT',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    if (data?.user_token) setUserToken(data.user_token);
    return data;
  },
  // The caller's own reading-history timeline.
  getHistory: (limit = 100) => apiFetch(`/api/history?limit=${limit}`),
  clearHistory: () => apiFetch('/api/history', { method: 'DELETE' }),
  // Blob downloads for the caller's own data — fetch + blob so the
  // X-User-Token header rides along (the mount-line requireUser gate is
  // header-only, same constraint as _adminDownload).
  exportReadingHistoryCsv: () =>
    _userDownload('/api/history?format=csv', 'momotaro-reading-history.csv'),
  exportReadingListsCsv: () =>
    _userDownload('/api/reading-lists.csv', 'momotaro-reading-lists.csv'),

  adminSetup: async (password) => {
    const data = await apiFetch('/api/admin/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (data?.admin_token) setAdminToken(data.admin_token);
    return data;
  },
  adminLogin: async (password) => {
    const data = await apiFetch('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (data?.admin_token) setAdminToken(data.admin_token);
    return data;
  },
  adminLogout: async () => {
    try {
      await apiFetch('/api/admin/logout', { method: 'POST' });
    } finally {
      clearAdminToken();
    }
  },
  changeAdminPassword: async (currentPassword, newPassword) => {
    const data = await apiFetch('/api/admin/password', {
      method: 'PUT',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    if (data?.admin_token) setAdminToken(data.admin_token);
    return data;
  },
  getSecuritySettings: () => apiFetch('/api/admin/security-settings'),
  saveSecuritySettings: (body) =>
    apiFetch('/api/admin/security-settings', { method: 'PUT', body: JSON.stringify(body) }),
  listPendingPairings: () => apiFetch('/api/admin/pairings/pending'),
  cancelPendingPairing: (id) =>
    apiFetch(`/api/admin/pairings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listPairedClients: () => apiFetch('/api/admin/clients'),
  revokePairedClient: (id) =>
    apiFetch(`/api/admin/clients/${id}`, { method: 'DELETE' }),
  // Pairing-PIN brute-force lockout settings — configurable cap and the list
  // of IPs currently sitting out a 24-hour lockout.
  getPairingPinSettings: () => apiFetch('/api/admin/pairing-pin-settings'),
  savePairingPinSettings: (body) =>
    apiFetch('/api/admin/pairing-pin-settings', { method: 'PUT', body: JSON.stringify(body) }),
  clearPairingPinLockout: (ip) =>
    apiFetch(`/api/admin/pairing-pin-lockouts/${encodeURIComponent(ip)}`, { method: 'DELETE' }),

  // ── User management (admin) ────────────────────────────────────────────
  // The operator's total control over accounts (requirement #10). All gated
  // server-side by requireAdmin (the X-Admin-Token rides along automatically).
  adminListUsers: () => apiFetch('/api/admin/users'),
  adminCreateUser: (body) =>
    apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  adminUpdateUser: (id, body) =>
    apiFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  adminDeleteUser: (id) =>
    apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' }),
  adminRevokeUserSessions: (id) =>
    apiFetch(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST' }),
  adminGetUserHistory: (id, limit = 200) =>
    apiFetch(`/api/admin/users/${id}/history?limit=${limit}`),
  adminGetReadingHistory: (filters = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiFetch(`/api/admin/reading-history${suffix}`);
  },
  adminGetLoginLockouts: () => apiFetch('/api/admin/login-lockouts'),
  adminClearLoginLockout: (key) =>
    apiFetch(`/api/admin/login-lockouts/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  // Blob downloads (carry X-Admin-Token via fetch, like the connection-log CSV).
  adminExportUser: (id) => _adminDownload(`/api/admin/users/${id}/export`, 'momotaro-user.json'),
  adminDownloadReadingHistoryCsv: (filters = {}) => {
    const qs = new URLSearchParams({ format: 'csv' });
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    return _adminDownload(`/api/admin/reading-history?${qs}`, 'momotaro-reading-history.csv');
  },

  // Forensic connection log — every pairing attempt, wrong-PIN guess,
  // lockout, denied request, and admin write is logged with the
  // requesting IP, OS, browser, device type, Accept-Language, reverse-DNS,
  // GeoIP country/city, client hints, request path + response status.
  // The CSV bundle is intended as an incident-response artefact (admin
  // downloads it after a suspicious lockout to identify the attacker).
  //
  // `filters` accepts: limit, cursor, event_type (comma-separated),
  // severity ('all' | 'failures' | 'successes'), ip, q, paired_client_id,
  // since (unix sec), until (unix sec).
  getConnectionLog: (filters = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiFetch(`/api/admin/connection-log${suffix}`);
  },
  // Grouped-by-source rollup: one row per unique (real_ip, UA) pair with
  // first/last seen, country, browser, event counts, and a paired-client
  // link when the source is authenticated.
  getConnectionSources: (since) => {
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    return apiFetch(`/api/admin/connection-log/sources${qs}`);
  },
  clearConnectionLog: () =>
    apiFetch('/api/admin/connection-log', { method: 'DELETE' }),
  downloadConnectionLogCsv: () =>
    _adminDownload('/api/admin/connection-log.csv', 'momotaro-connection-log.csv'),

  // ── Port forwarding (UPnP) ─────────────────────────────────────────────
  // Backs the Port Forwarding section. `getNetworkStatus` is what the UI
  // polls every few seconds while the section is open — returns both the
  // user-saved config and the live UPnP state. Probe is a one-shot check
  // for whether the router answers SSDP at all.
  getNetworkStatus: () => apiFetch('/api/admin/network/status'),
  saveNetworkConfig: (body) =>
    apiFetch('/api/admin/network/config', { method: 'PUT', body: JSON.stringify(body), timeoutMs: 30_000 }),
  probeUpnp: () =>
    apiFetch('/api/admin/network/probe', { method: 'POST', timeoutMs: 30_000 }),
  refreshUpnpMapping: () =>
    apiFetch('/api/admin/network/refresh', { method: 'POST', timeoutMs: 30_000 }),
  // HTTP-based — doesn't touch the router. Used by Manual mode where
  // talking to UPnP would be the wrong thing to do.
  detectPublicIp: () =>
    apiFetch('/api/admin/network/public-ip', { method: 'POST', timeoutMs: 15_000 }),

  // ── Pairing (client-side flow, used by Pairing.jsx) ─────────────────────
  // These hit the public pairing endpoints — no admin token required. The
  // wrapper writes the resulting client token to localStorage on success so
  // every subsequent `api.*` call from the same browser/APK includes it.
  pairingRequest: (deviceName, platform) =>
    apiFetch('/api/pairing/request', {
      method: 'POST',
      body: JSON.stringify({ device_name: deviceName, platform }),
    }),
  pairingStatus: (id) =>
    apiFetch(`/api/pairing/status/${encodeURIComponent(id)}`),
  pairingSubmitPin: async (pairingId, pin) => {
    const data = await apiFetch('/api/pairing/submit-pin', {
      method: 'POST',
      body: JSON.stringify({ pairing_id: pairingId, pin }),
    });
    if (data?.token) setClientToken(data.token);
    return data;
  },
  // Public health check used by the pairing wizard to validate the server
  // URL before asking the user for a device name.
  healthCheck: () => apiFetch('/api/health'),

  // Public app-version metadata — used by the native apps' update check.
  // Sends `platform` so the server picks the right channel: 'linux' for the
  // Electron desktop app (AppImage), 'android' otherwise (APK; also the
  // server's default for back-compat). Returns { version, download_url,
  // apk_url|appimage_url, released_at, notes, size_bytes }, or 404 when the
  // server has nothing published for that platform (swallowed silently).
  getAppVersion: () => {
    const isElectron = typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.getPlatform === 'function'
      && window.Capacitor.getPlatform() === 'electron';
    const platform = isElectron ? 'linux' : 'android';
    return apiFetch(`/api/app/version?platform=${platform}`);
  },

  // Helpers
  // `<img src>` requests are initiated by the browser, not by our
  // `fetch()` wrapper, so they can't carry the Authorization header. The
  // server accepts the same paired-client token via the `?t=` query
  // string as a fallback (see [server/src/middleware/auth.js]). On the
  // LAN with auth disabled this just produces a slightly longer URL
  // that the server ignores.
  pageImageUrl: (pageId) => {
    const tok = getClientToken();
    const qs = tok ? `?t=${encodeURIComponent(tok)}` : '';
    return `${getServerUrl()}/api/pages/${pageId}/image${qs}`;
  },
  thumbnailUrl,
  getAdminToken,
  setAdminToken,
  clearAdminToken,
  getClientToken,
  setClientToken,
  clearClientToken,
  getUserToken,
  setUserToken,
  clearUserToken,
  getActiveUserId,
  setActiveUserId,
  getServerUrl,
  setServerUrl,
  clearServerUrl,
};

// Thumbnails are sharded by `mangaId % 256` into 2-digit hex subdirectories,
// e.g. `5.webp` is served from `/thumbnails/05/5.webp`. The server migrates
// any legacy flat files at startup; the API also returns a `cover_url` field
// that's already sharded, so prefer that when available.
//
// `?t=<token>` is appended for the same reason as on `pageImageUrl`:
// `<img src>` requests don't carry the Authorization header, and the
// /thumbnails route is now gated by the client-or-admin auth check.
function thumbnailUrl(filename) {
  if (!filename) return null;
  const tok = getClientToken();
  const qs  = tok ? `?t=${encodeURIComponent(tok)}` : '';
  const m   = String(filename).match(/^(\d+)/);
  if (!m) return `${getServerUrl()}/thumbnails/${filename}${qs}`;
  const shard = (parseInt(m[1], 10) % 256).toString(16).padStart(2, '0');
  return `${getServerUrl()}/thumbnails/${shard}/${filename}${qs}`;
}

// ── Offline routing ────────────────────────────────────────────────────────
// The user-facing `api` proxy delegates to `offlineApi` when the
// ConnectivityContext reports offline. The raw (always-network) surface is
// re-exported as `rawApi` for callers that must hit the server regardless
// of mode — most notably the download queue, which has nothing to download
// from when offline.
//
// `setConnectivityProbe` is called once by ConnectivityProvider on mount;
// it hands us a `() => boolean` that returns true when we should route to
// the offline shim. Until it's wired we default to "online" so the existing
// PWA/browser flow is unaffected.
//
// `OFFLINE_ROUTED_METHODS` enumerates which methods get routed. Anything not
// listed always uses the raw network path — for read endpoints that means
// the call will fail with a fetch error when offline (and the calling
// component is expected to handle it), and for write endpoints that's the
// desired behaviour (we don't want to silently swallow a save attempt
// while offline unless we explicitly buffer it).

let _isOffline = () => false;

export function setConnectivityProbe(fn) {
  _isOffline = (typeof fn === 'function') ? fn : (() => false);
}

// Sync helper used by the few components that must branch on connectivity
// from outside React (e.g. the page-image src builder).
export function isOfflineNow() {
  try { return !!_isOffline(); } catch { return false; }
}

// Build a `/api/pages/:id/image` URL with the auth-token query param. Used
// by the downloader (which fetches the bytes directly via fetch) and by
// the online pageImageUrl. Exported so downloader.js can call it without
// having to know about token internals.
export function buildPageImageUrl(pageId) {
  const tok = getClientToken();
  const qs  = tok ? `?t=${encodeURIComponent(tok)}` : '';
  return `${getServerUrl()}/api/pages/${pageId}/image${qs}`;
}

// Same idea for thumbnails — downloader.js uses this to grab the cover
// bytes during the manga snapshot step.
export function buildThumbnailUrl(filename) {
  return thumbnailUrl(filename);
}

// Allowlist of methods that have an offline equivalent. Anything not
// listed here is left as-is on the routed `api` — calling such a method
// while offline simply hits the network path and fails-fast, which is what
// the UI lockdown code already handles. The allowlist approach avoids two
// subtle traps:
//
//   1. Wrapping sync helpers like `getServerUrl` / `getClientToken` would
//      otherwise have to deal with the case where the lazy offlineApi
//      module hasn't resolved yet — returning a Promise instead of the
//      expected string would break every caller (notably the connectivity
//      ping itself).
//   2. The wrapper would otherwise route methods to undefined shim
//      implementations and then fall through, which obscures bugs where a
//      method really *should* have offline support and we forgot.
const OFFLINE_ROUTED_METHODS = new Set([
  'getLibrary',
  'getManga',
  'getChapters',
  'getChapter',
  'getPages',
  'getProgress',
  'getHome',
  'getLibraries',
  'getReadingLists',
  'getReadingListManga',
  'getGenres',
  'getAllGallery',
  // Per-manga metadata that MangaDetail + Reader fire on mount. Without
  // these the parallel Promise.all in MangaDetail rejects on the first
  // TypeError("Failed to fetch") and the whole page renders an error
  // even though the offline manga data itself was reachable.
  'getAnilistStatus',
  'getMangaReadingLists',
  'getGallery',
  'updateProgress',
  'markChapterRead',
]);

function createRoutedApi(raw) {
  // Lazy-import the offline shim so the offline subsystem isn't loaded by
  // every consumer of `api` — keeps the initial bundle of the PWA path
  // unchanged. Once loaded the same instance is reused.
  let _offlinePromise = null;
  function loadOffline() {
    if (!_offlinePromise) _offlinePromise = import('./offlineApi.js').then(m => m.offlineApi);
    return _offlinePromise;
  }

  // Synchronous lookup populated on demand. `null` = not yet resolved,
  // otherwise the offlineApi module reference. The first call from
  // `isOfflineNow()==true` triggers the dynamic import; further calls hit
  // the cached module. Eagerly importing here would pull the offline
  // subsystem (idb + offlineDb + the shim) into the main bundle for every
  // online session.
  let _offline = null;
  function primeOffline() {
    if (_offline || _offlinePromise) return;
    loadOffline().then(o => { _offline = o; }).catch(() => { /* not fatal */ });
  }

  const wrapped = {};
  for (const key of Object.keys(raw)) {
    const original = raw[key];
    if (typeof original !== 'function' || !OFFLINE_ROUTED_METHODS.has(key)) {
      wrapped[key] = original;
      continue;
    }
    wrapped[key] = (...args) => {
      if (isOfflineNow()) {
        if (_offline && typeof _offline[key] === 'function') {
          return _offline[key](...args);
        }
        // First-ever offline call: prime + await the chunk. Subsequent
        // calls hit the cached shim. Every listed method already returns
        // a Promise so the extra microtask is invisible.
        primeOffline();
        return loadOffline().then(off => {
          if (typeof off[key] === 'function') return off[key](...args);
          return original(...args);
        });
      }
      return original(...args);
    };
  }

  // Special-case `pageImageUrl`: synchronous, no async fallback, returns
  // either the network URL or the locally-cached one populated by
  // `getPages`. The offline shim keeps a small Map keyed by page_id.
  // First call when offline primes the chunk so subsequent renders hit
  // the cached map directly.
  wrapped.pageImageUrl = (pageId) => {
    if (isOfflineNow()) {
      if (_offline) {
        const local = _offline.pageImageUrl(pageId);
        if (local) return local;
      } else {
        primeOffline();
      }
    }
    return raw.pageImageUrl(pageId);
  };

  return wrapped;
}

export const rawApi = _rawApi;
export const api    = createRoutedApi(_rawApi);
