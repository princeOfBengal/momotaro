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

// `BASE` is kept as an alias for backwards compatibility — anything outside
// `apiFetch` (URL builders for image src attributes, etc.) reads it directly.
// Using a getter would be cleaner but breaks the existing `const`-destructuring
// callers; the explicit helper functions cover the same ground.

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
  try {
    const resp = await fetch(`${getServerUrl()}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceId(),
        ...(adminToken  ? { 'X-Admin-Token': adminToken } : {}),
        ...(clientToken ? { 'Authorization': `Bearer ${clientToken}` } : {}),
        ...fetchOptions.headers,
      },
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
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

export const api = {
  // Library
  getLibrary: (params = {}, options = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiFetch(`/api/library${q ? '?' + q : ''}`, options);
  },
  getManga: (id) => apiFetch(`/api/manga/${id}`),
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

  // Config backup (export/import)
  exportConfigUrl: () => `${getServerUrl()}/api/admin/export-config`,
  // CSV download: one row per manga, columns: Library, Series Name
  // (AniList/MAL/MangaUpdates/Doujinshi.info), Folder path, Number of
  // chapters, Number of volumes, Author. Used for manually spot-checking
  // that third-party metadata matches are correct.
  exportSeriesListUrl: () => `${getServerUrl()}/api/admin/export-series-list`,
  importConfig: (payload) =>
    apiFetch('/api/admin/import-config', {
      method: 'POST',
      body: JSON.stringify(payload),
      // Import can touch every row in the DB; allow up to 5 minutes.
      timeoutMs: 300_000,
    }),

  // System Logs
  getSystemLogs: () => apiFetch('/api/admin/logs'),
  systemLogsExportUrl: () => `${getServerUrl()}/api/admin/logs/export`,

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

  // Public app-version metadata — used by the Android app's update check.
  // Returns { version, apk_url, released_at, notes, size_bytes }, or 404
  // if the server has no published APK. The caller swallows 404s
  // silently (no update advertised, not an error).
  getAppVersion: () => apiFetch('/api/app/version'),

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
