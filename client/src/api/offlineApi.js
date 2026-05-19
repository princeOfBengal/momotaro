// Offline-mode read replacements for `api.*`. Each function here is a
// drop-in that mirrors the shape the online endpoint returns, so the
// rendering code in Library / MangaDetail / Reader doesn't need to branch.
//
// Anything that requires the server (server-side scans, third-party
// downloads, bulk metadata, auth/admin, anything-anilist) lives in
// `OFFLINE_UNSUPPORTED` and throws so the UI lockdown can catch the error
// and render the right empty/disabled state.

import {
  getOfflineManga,
  getOfflineChapter,
  listOfflineManga,
  listOfflineChaptersForManga,
  getOfflinePagesByChapter,
  getOfflinePageByPageId,
  enqueueProgressWrite,
} from './offlineDb.js';
import { srcUrl, readBytes, isAvailable } from './offlineStorage.js';
import { isEncryptionEnabled, isUnlocked, maybeDecrypt } from './offlineCrypto.js';

export class OfflineUnavailableError extends Error {
  constructor(opName) {
    super(`"${opName}" is not available while offline.`);
    this.name = 'OfflineUnavailableError';
    this.op = opName;
  }
}

function unsupported(name) {
  return async () => { throw new OfflineUnavailableError(name); };
}

// Convert an `offline_manga` row into the shape the online `getManga`
// returns. Missing fields are left undefined; callers already handle nulls
// because the server sometimes omits the same fields.
function mangaRowToApiShape(row) {
  if (!row) return null;
  return {
    id:             row.id,
    title:          row.title,
    original_title: row.original_title || null,
    author:         row.author || null,
    artist:         row.artist || null,
    description:    row.description || null,
    year:           row.year || null,
    rating:         row.rating || null,
    status:         row.status || null,
    genres:         row.genres || [],
    tags:           row.tags || [],
    alt_titles:     row.alt_titles || [],
    folder_path:    row.folder_path || null,
    library_id:     row.library_id || null,
    chapter_count:  row.chapter_count || 0,
    // The cover thumbnail is stored locally; the UI uses this verbatim in
    // `<img src>`, so it must already be a renderable URL by the time we
    // hand it back.
    cover_url:      row.cover_url || null,
    is_offline:     true,
  };
}

function chapterRowToApiShape(row) {
  if (!row) return null;
  return {
    id:           row.id,
    manga_id:     row.manga_id,
    number:       row.number ?? null,
    volume:       row.volume ?? null,
    title:        row.title ?? null,
    folder_name:  row.folder_name ?? null,
    page_count:   row.page_count ?? 0,
    type:         row.type || 'offline',
  };
}

// `listOfflineManga` accepts the same `{ sort, search }` shape the server
// uses, so this is mostly a pass-through. `library_id` is honoured by
// filtering after the read since we keep `library_id` on every row.
async function getLibrary(params = {}, options = {}) {
  const { sort, search, library_id } = params || {};
  let rows = await listOfflineManga({ sort, search });
  if (library_id != null) {
    rows = rows.filter(r => r.library_id == library_id);
  }
  const data = rows.map(mangaRowToApiShape);
  // The browse + search code paths support both shapes — `{ data, has_more,
  // next_cursor }` when `raw: true` is set, and a bare array otherwise. We
  // never paginate offline (the working set is tiny by definition), so
  // both forms degenerate to "all results, no more".
  if (options.raw) {
    return { data, has_more: false, next_cursor: null };
  }
  return data;
}

async function getManga(id) {
  const row = await getOfflineManga(id);
  if (!row) throw new OfflineUnavailableError(`manga ${id} is not downloaded`);
  return mangaRowToApiShape(row);
}

async function getChapters(mangaId) {
  const rows = await listOfflineChaptersForManga(mangaId);
  return rows.map(chapterRowToApiShape);
}

async function getChapter(id) {
  // The Reader fetches the chapter to derive manga_id from it when the
  // `mangaId` query param is missing. Direct lookup by chapter id avoids
  // iterating every downloaded series.
  const hit = await getOfflineChapter(id);
  if (!hit) throw new OfflineUnavailableError(`chapter ${id} is not downloaded`);
  return chapterRowToApiShape(hit);
}

async function getPages(chapterId) {
  const [rows, chapter] = await Promise.all([
    getOfflinePagesByChapter(chapterId),
    getOfflineChapter(chapterId),
  ]);
  // The Reader expects rows in page_index order with `id`, `page_index`,
  // `filename`, `width`, `height`, `is_wide`. `path` is intentionally
  // stripped on the server side too.
  rows.sort((a, b) => a.page_index - b.page_index);

  // Per-chapter encryption flag — set by the downloader at write time.
  // A library where some chapters were downloaded before the user
  // enabled encryption and others after will have a mix; we route each
  // chapter independently.
  //
  // Two URL resolution paths:
  //   - Plaintext: `srcUrl` returns a Capacitor file:// URL via
  //     convertFileSrc — the WebView loads it like any other image. Fast.
  //   - Encrypted: read the on-disk ciphertext, decrypt, wrap as a
  //     `blob:` URL. The reader keeps a per-chapter URL map; we revoke
  //     these in `releasePageBlobs()` when the reader unmounts.
  const chapterEncrypted = !!(chapter && chapter.encrypted);

  const resolved = await Promise.all(rows.map(async r => {
    const local = chapterEncrypted
      ? await decryptToBlobUrl(r.local_path, r.filename)
      : await srcUrl(r.local_path);
    rememberPageUrl(r.page_id, local);
    return {
      id:         r.page_id,
      page_index: r.page_index,
      filename:   r.filename,
      width:      r.width ?? null,
      height:     r.height ?? null,
      is_wide:    r.width != null && r.height != null && r.width > 0 && r.height > 0
                  ? r.width > r.height
                  : null,
      _local_src: local,
    };
  }));
  return resolved;
}

// In-flight blob URLs created during the most-recent `getPages` call.
// The reader is responsible for calling `releasePageBlobs()` on unmount
// so we don't accumulate memory across chapter flips.
const _activeBlobUrls = new Set();

async function decryptToBlobUrl(relPath, filename) {
  try {
    const ciphertext = await readBytes(relPath);
    const plain = await maybeDecrypt(ciphertext);
    const mime  = guessMimeFromFilename(filename);
    const blob  = new Blob([plain], { type: mime });
    const url   = URL.createObjectURL(blob);
    _activeBlobUrls.add(url);
    return url;
  } catch (e) {
    // Decrypt failure (wrong key, corrupted file, etc.) — return an
    // empty string; the <img> will render the broken-image icon and the
    // user sees something is wrong without crashing the reader.
    return '';
  }
}

function guessMimeFromFilename(name) {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.png'))  return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif'))  return 'image/gif';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}

// Reader calls this on unmount of the page-list view so we don't leak
// memory for thousands of blob URLs over a long session. The plain-text
// path is a no-op since it doesn't create blobs.
export function releasePageBlobs() {
  for (const u of _activeBlobUrls) {
    try { URL.revokeObjectURL(u); } catch { /* ignore */ }
  }
  _activeBlobUrls.clear();
  clearPageUrlCache();
}

// The Reader builds image src URLs synchronously from page_id. We can't
// reach the filesystem synchronously, so the offline path returns a sentinel
// URL the Reader's `<img onError>` will swap for a backup; in practice the
// Reader uses `getPages` first (which already populates `_local_src`) and
// pageImageUrl is only used as a fallback. We expose a synchronous lookup
// via a session-scoped cache populated by getPages.
const _pageIdToLocalUrl = new Map();

export function rememberPageUrl(pageId, url) {
  _pageIdToLocalUrl.set(Number(pageId), url);
}

export function clearPageUrlCache() {
  _pageIdToLocalUrl.clear();
}

function pageImageUrl(pageId) {
  return _pageIdToLocalUrl.get(Number(pageId)) || '';
}

// Reading progress writes accumulate in the outbox and flush on reconnect.
async function updateProgress(mangaId, body) {
  await enqueueProgressWrite({
    manga_id:    mangaId,
    chapter_id:  body.current_chapter_id ?? body.chapter_id ?? 0,
    page:        body.current_page ?? null,
    completed:   body.completed_chapter_ids || null,
    payload:     body,
  });
  return { ok: true, offline: true };
}

async function markChapterRead(mangaId, chapterId, completed) {
  await enqueueProgressWrite({
    manga_id:   mangaId,
    chapter_id: chapterId,
    completed:  completed ? [chapterId] : [],
    payload:    { chapterId, completed },
  });
  return { ok: true, offline: true };
}

// `getProgress` falls back to whatever is buffered in localStorage by the
// existing `readingProgress.js` helper plus any outbox entry. To keep the
// scope of P1 small, we just return an empty progress shape — the Reader
// already treats null/undefined fields as "no progress recorded".
async function getProgress(_mangaId) {
  return { current_chapter_id: null, current_page: null, completed_chapter_ids: [] };
}

// Used by Home to render a "Downloaded" ribbon when offline. Field names
// must match what `Home.jsx` reads — `continue_reading`,
// `discover_candidates`, `recently_added`, `favorite_genres_ribbons`. Any
// missing field is treated as "no ribbon" by the page.
async function getHome() {
  const downloaded = await listOfflineManga({ sort: 'updated' });
  const data = downloaded.map(mangaRowToApiShape);
  return {
    continue_reading:         [],
    discover_candidates:      [],
    // The "Recently Added" ribbon doubles as our "Downloaded" surface so
    // the user has an entry point to the offline library.
    recently_added:           data.slice(0, 15),
    favorite_genres_ribbons:  [],
    gallery:                  [],
  };
}

// ── Public surface ──────────────────────────────────────────────────────────
// Every entry corresponds to a method on `api.*`. Methods not listed here
// fall through to `unsupported` (see api/client.js routing) and throw an
// OfflineUnavailableError on call.

export const offlineApi = {
  // Read paths that work offline.
  getLibrary,
  getManga,
  getChapters,
  getChapter,
  getPages,
  getProgress,
  getHome,

  // Reading lists, libraries, genres, gallery — all return empty so the UI
  // renders cleanly without server context. (Real offline reading-list
  // support would need to mirror them at download time; deferred.)
  getLibraries:        async () => [],
  getReadingLists:     async () => [],
  getReadingListManga: async () => [],
  getGenres:           async () => [],
  getAllGallery:       async () => [],

  // Write paths that buffer locally + flush on reconnect.
  updateProgress,
  markChapterRead,

  // Helpers used by Reader / thumbnails.
  pageImageUrl,

  // Catch-all bucket for anything that needs the server. Throwing an
  // OfflineUnavailableError lets the UI hide / disable the affected
  // controls (see ConnectivityContext + UI lockdown rules).
  triggerScan:            unsupported('triggerScan'),
  scanManga:              unsupported('scanManga'),
  resetProgress:          unsupported('resetProgress'),
  refreshMetadata:        unsupported('refreshMetadata'),
  bulkMetadata:           unsupported('bulkMetadata'),
  exportMetadata:         unsupported('exportMetadata'),
  resetLibraryMetadata:   unsupported('resetLibraryMetadata'),
  searchAnilist:          unsupported('searchAnilist'),
  applyMetadata:          unsupported('applyMetadata'),
  searchMal:              unsupported('searchMal'),
  searchDoujinshi:        unsupported('searchDoujinshi'),
  searchMangaUpdates:     unsupported('searchMangaUpdates'),
  listSources:            unsupported('listSources'),
  searchSource:           unsupported('searchSource'),
  getSourceSeries:        unsupported('getSourceSeries'),
  getSourceChapters:      unsupported('getSourceChapters'),
  enqueueSourceDownload:  unsupported('enqueueSourceDownload'),
  listSourceDownloads:    unsupported('listSourceDownloads'),
  cancelSourceDownload:   unsupported('cancelSourceDownload'),
  retrySourceDownload:    unsupported('retrySourceDownload'),
  clearFinishedDownloads: unsupported('clearFinishedDownloads'),
  matchExistingManga:     unsupported('matchExistingManga'),
  // Admin / server lifecycle.
  getCbzCacheSize:        unsupported('getCbzCacheSize'),
  clearCbzCache:          unsupported('clearCbzCache'),
  vacuumDb:               unsupported('vacuumDb'),
  regenerateThumbnails:   unsupported('regenerateThumbnails'),
  resetThumbnails:        unsupported('resetThumbnails'),
  getSystemLogs:          unsupported('getSystemLogs'),
  getAuthStatus:          unsupported('getAuthStatus'),
};

export { isAvailable };
