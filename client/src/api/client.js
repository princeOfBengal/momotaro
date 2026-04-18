const BASE = import.meta.env.VITE_API_BASE || '';

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

async function apiFetch(path, options = {}) {
  const { timeoutMs = 15_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceId(),
        ...fetchOptions.headers,
      },
      ...fetchOptions,
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
    return json.data !== undefined ? json.data : json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  // Library
  getLibrary: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiFetch(`/api/library${q ? '?' + q : ''}`);
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
  exportMangaMetadata: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/export-metadata`, { method: 'POST' }),
  refreshMalMetadata: (mangaId) =>
    apiFetch(`/api/manga/${mangaId}/refresh-mal-metadata`, { method: 'POST' }),
  searchMal: (q, page = 1) =>
    apiFetch(`/api/mal/search?${new URLSearchParams({ q, page })}`),
  applyMalMetadata: (mangaId, malId) =>
    apiFetch(`/api/manga/${mangaId}/apply-mal-metadata`, {
      method: 'POST',
      body: JSON.stringify({ mal_id: malId }),
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
  getReadingListManga: (id, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiFetch(`/api/reading-lists/${id}/manga${q ? '?' + q : ''}`);
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

  // Optimize
  optimizeManga: (id) => apiFetch(`/api/manga/${id}/optimize`, { method: 'POST' }),

  // Info
  getMangaInfo: (id) => apiFetch(`/api/manga/${id}/info`),

  // Admin / Database Management
  getCbzCacheSize: () => apiFetch('/api/admin/cbz-cache-size'),
  clearCbzCache: () => apiFetch('/api/admin/clear-cbz-cache', { method: 'POST' }),
  regenerateThumbnails: () => apiFetch('/api/admin/regenerate-thumbnails', { method: 'POST' }),
  vacuumDb: () => apiFetch('/api/admin/vacuum-db', { method: 'POST' }),

  // System Logs
  getSystemLogs: () => apiFetch('/api/admin/logs'),
  systemLogsExportUrl: () => `${BASE}/api/admin/logs/export`,

  // Statistics
  getStats: () => apiFetch('/api/stats'),

  // Helpers
  pageImageUrl: (pageId) => `${BASE}/api/pages/${pageId}/image`,
  thumbnailUrl,
};

// Thumbnails are sharded by `mangaId % 256` into 2-digit hex subdirectories,
// e.g. `5.webp` is served from `/thumbnails/05/5.webp`. The server migrates
// any legacy flat files at startup; the API also returns a `cover_url` field
// that's already sharded, so prefer that when available.
function thumbnailUrl(filename) {
  if (!filename) return null;
  const m = String(filename).match(/^(\d+)/);
  if (!m) return `${BASE}/thumbnails/${filename}`;
  const shard = (parseInt(m[1], 10) % 256).toString(16).padStart(2, '0');
  return `${BASE}/thumbnails/${shard}/${filename}`;
}
