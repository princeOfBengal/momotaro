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
  putOfflineManga,
  putOfflineChapter,
  putOfflinePages,
} from './offlineDb.js';
import {
  srcUrl,
  readBytes,
  readText,
  exists as fsExists,
  listFiles,
  isAvailable,
  isConfigured,
} from './offlineStorage.js';
import { isEncryptionEnabled, isUnlocked, maybeDecrypt } from './offlineCrypto.js';
import { parseChapterDirName } from './downloader.js';

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

// ── Filesystem-as-source-of-truth scanner ─────────────────────────────────
//
// IDB is the fast cache, but the offline folder on disk is authoritative.
// These helpers walk the user-picked tree to reconstruct manga / chapter /
// page state when IDB has no row for the requested id — surviving Clear
// Data, browser-DB corruption, or the user manually copying downloads
// between devices.
//
// Each function is best-effort: missing/corrupt sidecar JSON falls back
// to whatever can be inferred from filenames. Returns null when the
// folder itself doesn't exist, so callers can decide whether to surface
// "not downloaded" vs an empty placeholder.

const PAGE_FILE_RE = /^(\d{1,5})\.([a-z0-9]+)$/i;

// True when an entry's name looks like a page file we wrote
// (`0001.jpg`, `0042.webp`, etc.).
function isPageFile(name) { return PAGE_FILE_RE.test(name || ''); }

// Parse a page filename back into `{ page_index, ext }`. `0001.jpg`
// → `{ page_index: 1, ext: 'jpg' }`. Mirrors the format the
// downloader writes (4-digit zero-padded index).
function parsePageFileName(name) {
  const m = (name || '').match(PAGE_FILE_RE);
  if (!m) return null;
  return { page_index: Number(m[1]), ext: m[2].toLowerCase() };
}

async function readJsonAt(path) {
  try {
    if (!(await fsExists(path))) return null;
    const text = await readText(path);
    return JSON.parse(text);
  } catch { return null; }
}

// Scan `<mangaId>/manga.json` + walk `<mangaId>/chapters/` and return
// the equivalent of an api.getManga response, populated entirely from
// disk. Returns null when the manga folder doesn't exist or has neither
// a manga.json nor any chapter folders. Caller is responsible for
// rehydrating IDB if it wants to cache the result.
async function scanMangaFromDisk(mangaId) {
  if (!isAvailable()) return null;
  if (!(await isConfigured())) return null;

  const mangaRel = String(mangaId);
  // Cheap early-out: if the top-level manga folder isn't even there,
  // there's nothing to recover.
  if (!(await fsExists(mangaRel))) return null;

  const mangaJson = await readJsonAt(`${mangaRel}/manga.json`);
  const chapters  = await scanChapterFoldersForManga(mangaId);
  if (!mangaJson && chapters.length === 0) return null;

  // Combine: manga.json gives us metadata; chapters[] gives us the list.
  // Prefer manga.json's id but fall back to the requested mangaId.
  const base = mangaJson || { id: Number(mangaId) };

  // Re-derive `cover_url` from whatever cover.<ext> is sitting in the
  // manga folder. The URL stored in manga.json may have been generated
  // against an earlier picked-folder context; resolving now via
  // `srcUrl` produces a URL the WebView can actually load right now.
  const coverUrl = await findCoverUrl(mangaId);

  return {
    ...base,
    id:             Number(base.id ?? mangaId),
    chapter_count:  chapters.length,
    cover_url:      coverUrl || base.cover_url || null,
    chapters,
  };
}

// Locate the cover file in a manga folder (`cover.jpg`, `cover.webp`,
// etc.) and return its WebView-loadable URL. Used by the scanner to
// re-derive cover_url at read time rather than trusting whatever was
// baked into the manga.json snapshot at download time.
async function findCoverUrl(mangaId) {
  const entries = await listFiles(String(mangaId));
  for (const e of entries) {
    if (!e || e.isDirectory) continue;
    if (/^cover\.[a-z0-9]+$/i.test(e.name)) {
      try { return await srcUrl(`${mangaId}/${e.name}`); }
      catch { return null; }
    }
  }
  return null;
}

// Walk the chapters/ subdirectory and parse each entry. Skips anything
// that doesn't look like a chapter folder (system dirs, `.thumbnails`,
// stray files, etc.) via the strict regex in `parseChapterDirName`.
async function scanChapterFoldersForManga(mangaId) {
  const entries = await listFiles(`${mangaId}/chapters`);
  const out = [];
  for (const entry of entries) {
    if (!entry || !entry.isDirectory) continue;
    const parsed = parseChapterDirName(entry.name);
    if (!parsed || !Number.isFinite(parsed.id)) continue;

    const dirRel = `${mangaId}/chapters/${entry.name}`;
    const meta = await readJsonAt(`${dirRel}/meta.json`);
    out.push({
      id:                 parsed.id,
      manga_id:           Number(mangaId),
      volume:             meta?.volume    ?? parsed.volume    ?? null,
      number:             meta?.number    ?? parsed.number    ?? null,
      title:              meta?.title     ?? parsed.title     ?? null,
      folder_name:        meta?.folder_name ?? parsed.folder_name ?? null,
      page_count:         meta?.page_count ?? (meta?.pages?.length || null),
      type:               'offline',
      chapter_dir_path:   dirRel,
      _meta:              meta || null, // carry through for getPages
      encrypted:          !!meta?.encrypted,
    });
  }
  // Reading order: by volume (nulls last), then number (nulls last),
  // then folder name.
  out.sort((a, b) => {
    const va = a.volume ?? Number.POSITIVE_INFINITY;
    const vb = b.volume ?? Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    const na = a.number ?? Number.POSITIVE_INFINITY;
    const nb = b.number ?? Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    return String(a.folder_name || '').localeCompare(String(b.folder_name || ''), undefined, { numeric: true });
  });
  return out;
}

// Scan a chapter's pages directly from disk. Prefers meta.json's page
// array (carries server page IDs + dimensions); falls back to listing
// image files in the chapter directory when meta.json is missing.
async function scanPagesFromDisk(chapterDirPath, chapterId) {
  // Best path: meta.json carries everything the Reader needs.
  const meta = await readJsonAt(`${chapterDirPath}/meta.json`);
  if (meta && Array.isArray(meta.pages) && meta.pages.length > 0) {
    return {
      pages:     meta.pages,
      encrypted: !!meta.encrypted,
    };
  }

  // Fallback: list the chapter directory and synthesize a page list
  // from the filenames. We don't know server page IDs in this branch —
  // use chapterId * 10000 + page_index as a deterministic local ID so
  // the Reader's pageImageUrl lookup keeps working across renders.
  const entries = await listFiles(chapterDirPath);
  const pages = entries
    .filter(e => e && !e.isDirectory && isPageFile(e.name))
    .map(e => {
      const parsed = parsePageFileName(e.name);
      return {
        id:         Number(chapterId) * 10000 + parsed.page_index,
        page_index: parsed.page_index,
        filename:   e.name,
        width:      null,
        height:     null,
        local_path: `${chapterDirPath}/${e.name}`,
      };
    })
    .sort((a, b) => a.page_index - b.page_index);
  return { pages, encrypted: false }; // can't infer encryption without meta
}

// Locate a chapter folder by walking the offline tree until we find a
// chapter dir whose `[id]` suffix matches. Used only on the cold path
// (IDB has no row for this chapter) — the result is cached back into
// IDB by the caller so subsequent reads are O(1).
async function findChapterDirPath(chapterId) {
  if (!isAvailable() || !(await isConfigured())) return null;
  const wantedId = Number(chapterId);
  const topLevel = await listFiles('');
  for (const entry of topLevel) {
    if (!entry || !entry.isDirectory) continue;
    const mangaId = Number(entry.name);
    if (!Number.isFinite(mangaId)) continue;
    const chapters = await listFiles(`${mangaId}/chapters`);
    for (const ch of chapters) {
      if (!ch || !ch.isDirectory) continue;
      const parsed = parseChapterDirName(ch.name);
      if (parsed && Number(parsed.id) === wantedId) {
        return `${mangaId}/chapters/${ch.name}`;
      }
    }
  }
  return null;
}

// Rehydrate IDB from a filesystem scan so subsequent reads hit the fast
// path. Best-effort — IDB write failures don't impair the current read.
async function rehydrateMangaFromScan(scanned) {
  if (!scanned || !scanned.id) return;
  try {
    await putOfflineManga({
      ...scanned,
      // Don't shadow the in-memory chapters array onto the IDB row —
      // it's reconstructed from offline_chapters at read time.
      chapters: undefined,
      downloaded_at: scanned.downloaded_at || Date.now(),
    });
    for (const ch of scanned.chapters || []) {
      await putOfflineChapter({
        ...ch,
        manga_id: Number(scanned.id),
        status:   'done',
      });
      // If we have per-page data from meta.json, populate the pages
      // store too so getPages can route to it on the next read.
      if (ch._meta && Array.isArray(ch._meta.pages)) {
        await putOfflinePages(ch.id, ch._meta.pages.map(p => ({
          chapter_id: ch.id,
          page_index: p.page_index,
          page_id:    p.id,
          filename:   p.filename,
          width:      p.width ?? null,
          height:     p.height ?? null,
          local_path: p.local_path,
        })));
      }
    }
  } catch { /* IDB-write failure is non-fatal — read already succeeded */ }
}

async function getManga(id) {
  // Fast path: IDB has the manga row.
  const row = await getOfflineManga(id);
  if (row) {
    const chapterRows = await listOfflineChaptersForManga(id);
    if (chapterRows.length > 0) {
      return {
        ...mangaRowToApiShape(row),
        chapters: chapterRows.map(chapterRowToApiShape).filter(Boolean),
      };
    }
    // IDB has the manga but no chapter rows — fall through to the
    // filesystem scan so the user gets the chapters that exist on disk
    // instead of "No chapters found." This is exactly the symptom of
    // an IDB wipe that the user reported.
  }

  // Filesystem source of truth.
  const scanned = await scanMangaFromDisk(id);
  if (scanned) {
    // Best-effort cache fill so subsequent reads are fast. Doesn't
    // block the response — the user already has the data they need.
    rehydrateMangaFromScan(scanned).catch(() => { /* non-fatal */ });
    return {
      ...mangaRowToApiShape(scanned),
      chapters: scanned.chapters.map(chapterRowToApiShape).filter(Boolean),
    };
  }

  throw new OfflineUnavailableError(`manga ${id} is not downloaded`);
}

async function getChapters(mangaId) {
  const rows = await listOfflineChaptersForManga(mangaId);
  if (rows.length > 0) return rows.map(chapterRowToApiShape);

  // IDB empty for this manga — try the filesystem.
  const scanned = await scanMangaFromDisk(mangaId);
  if (!scanned) return [];
  rehydrateMangaFromScan(scanned).catch(() => {});
  return scanned.chapters.map(chapterRowToApiShape).filter(Boolean);
}

async function getChapter(id) {
  // Fast path: IDB hit.
  const hit = await getOfflineChapter(id);
  if (hit) return chapterRowToApiShape(hit);

  // Filesystem fallback: we don't know which manga the chapter belongs
  // to without IDB, so this is best-effort — walk every manga folder
  // looking for a chapter dir whose `[id]` suffix matches. For an
  // offline library with hundreds of series this is slow on first miss,
  // but rehydration after the first lookup populates IDB so it only
  // happens once.
  if (!isAvailable() || !(await isConfigured())) {
    throw new OfflineUnavailableError(`chapter ${id} is not downloaded`);
  }
  const topLevel = await listFiles('');
  for (const entry of topLevel) {
    if (!entry || !entry.isDirectory) continue;
    const mangaId = Number(entry.name);
    if (!Number.isFinite(mangaId)) continue;
    const scanned = await scanMangaFromDisk(mangaId);
    if (!scanned) continue;
    const match = (scanned.chapters || []).find(c => Number(c.id) === Number(id));
    if (match) {
      rehydrateMangaFromScan(scanned).catch(() => {});
      return chapterRowToApiShape(match);
    }
  }
  throw new OfflineUnavailableError(`chapter ${id} is not downloaded`);
}

async function getPages(chapterId) {
  let [rows, chapter] = await Promise.all([
    getOfflinePagesByChapter(chapterId),
    getOfflineChapter(chapterId),
  ]);

  // Filesystem fallback when IDB has no page rows for this chapter.
  // Common cause: Clear data wiped IDB but the on-disk chapter is fine.
  // `getChapter` above may have already rehydrated `chapter` when the
  // Reader called it — but we still need to reconstruct the page list.
  if (rows.length === 0) {
    let chapterDirPath = chapter && chapter.chapter_dir_path;
    if (!chapterDirPath) {
      // We don't have an IDB row at all, so we don't know the dir path.
      // Locate it by walking — slow but bounded; only runs the first
      // time a chapter is opened post-wipe.
      chapterDirPath = await findChapterDirPath(chapterId);
    }
    if (chapterDirPath) {
      const { pages: scanPages, encrypted } = await scanPagesFromDisk(chapterDirPath, chapterId);
      rows = scanPages.map(p => ({
        chapter_id: Number(chapterId),
        page_index: p.page_index,
        page_id:    p.id,
        filename:   p.filename,
        width:      p.width ?? null,
        height:     p.height ?? null,
        local_path: p.local_path
                    ?? `${chapterDirPath}/${String(p.page_index).padStart(4, '0')}.jpg`,
      }));
      // Synthesize an in-memory chapter row so the encryption flag flows
      // through. Persist it best-effort so the next getChapter call has
      // an IDB hit.
      chapter = chapter || { id: Number(chapterId), encrypted };
      if (!chapter.encrypted && encrypted) chapter.encrypted = true;
      putOfflinePages(chapterId, rows).catch(() => {});
    }
  }

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

  // Per-manga shims fired by MangaDetail's mount-time Promise.all
  // (and Reader's silent gallery fetch). Each one returns the same
  // empty-data shape the server emits when the underlying integration
  // isn't configured, so the page's null-safe render paths pick it up
  // without branching.
  getAnilistStatus:     async () => ({ logged_in: false }),
  getMangaReadingLists: async () => [],
  getGallery:           async () => [],

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
