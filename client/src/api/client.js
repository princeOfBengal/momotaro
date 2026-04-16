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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const resp = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceId(),
        ...options.headers,
      },
      ...options,
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

  // Progress
  getProgress: (mangaId) => apiFetch(`/api/progress/${mangaId}`),
  updateProgress: (mangaId, body) =>
    apiFetch(`/api/progress/${mangaId}`, { method: 'PUT', body: JSON.stringify(body) }),
  resetProgress: (mangaId) =>
    apiFetch(`/api/progress/${mangaId}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => apiFetch('/api/settings'),
  saveSettings: (body) =>
    apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
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

  // Statistics
  getStats: () => apiFetch('/api/stats'),

  // Helpers
  pageImageUrl: (pageId) => `${BASE}/api/pages/${pageId}/image`,
  thumbnailUrl: (filename) => filename ? `${BASE}/thumbnails/${filename}` : null,
};
