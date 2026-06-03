// IndexedDB-backed index of everything Momotaro has downloaded for offline
// reading. The on-disk CBZ-equivalent (per-page image files) is the canonical
// store — this DB is a fast lookup so the Library / Search / MangaDetail
// surfaces don't have to walk the filesystem on every render.
//
// The DB is rebuilt opportunistically from the on-disk index when a row is
// missing, so wiping IndexedDB only loses progress-outbox entries; downloaded
// content survives.
//
// Schema is at version 2. The v1 → v2 bump re-keys the progress outbox from
// `chapter_id` to the composite `[user_id, chapter_id]` so two accounts on the
// same device can each have pending writes for the same chapter without
// clobbering each other. See `upgrade()` for the migration.

import { openDB } from 'idb';

export const DB_NAME = 'momotaro-offline';
export const DB_VERSION = 2;
// Mirrors server-side DEFAULT_USER_ID; used as the stamp for legacy outbox
// rows when no one is logged in (and for the read-back when offlineApi is
// invoked without an active session — e.g. flag-off single-user mode).
const DEFAULT_USER_ID = 1;

/**
 * Read the logged-in user's id from localStorage without an async round-trip.
 * Falls back to the default user (id 1) when no one is logged in — that's the
 * pre-accounts / single-user identity the server also resolves to.
 */
export function getActiveUserIdSync() {
  try {
    const raw = localStorage.getItem('momotaro_active_user_id');
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* localStorage disabled / SSR */ }
  return DEFAULT_USER_ID;
}

export const STORES = {
  MANGA:    'offline_manga',
  CHAPTERS: 'offline_chapters',
  PAGES:    'offline_pages',
  JOBS:     'download_jobs',
  OUTBOX:   'progress_outbox',
  META:     'meta',
};

let _dbPromise = null;

export function getOfflineDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = openDB(DB_NAME, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      // ── offline_manga ───────────────────────────────────────────────────
      // One row per downloaded series. `search_text` is a lowercased
      // concatenation of every searchable string (title + alt_titles +
      // author + tags) so offline search can substring-match in JS without
      // an FTS index. Sorted by `downloaded_at` (most recent first) when
      // listed.
      if (!db.objectStoreNames.contains(STORES.MANGA)) {
        const s = db.createObjectStore(STORES.MANGA, { keyPath: 'id' });
        s.createIndex('by_downloaded_at', 'downloaded_at');
        s.createIndex('by_title',         'title');
      }

      // ── offline_chapters ───────────────────────────────────────────────
      // Chapter-level row; `cbz_local_path` is the relative path under the
      // configured root that holds this chapter's page files (or a future
      // CBZ archive). `status` mirrors the queue lifecycle so the
      // MangaDetail row can render the right badge without joining
      // against `download_jobs`.
      if (!db.objectStoreNames.contains(STORES.CHAPTERS)) {
        const s = db.createObjectStore(STORES.CHAPTERS, { keyPath: 'id' });
        s.createIndex('by_manga',          'manga_id');
        s.createIndex('by_manga_status',  ['manga_id', 'status']);
      }

      // ── offline_pages ───────────────────────────────────────────────────
      // One row per downloaded page. Composite primary key
      // `[chapter_id, page_index]` mirrors the server's natural ordering.
      // `page_id` is the server's page row id — used to keep `pageImageUrl`
      // callers working when offline (they pass page_id; we resolve to a
      // local file).
      if (!db.objectStoreNames.contains(STORES.PAGES)) {
        const s = db.createObjectStore(STORES.PAGES, {
          keyPath: ['chapter_id', 'page_index'],
        });
        s.createIndex('by_chapter', 'chapter_id');
        s.createIndex('by_page_id', 'page_id', { unique: false });
      }

      // ── download_jobs ───────────────────────────────────────────────────
      // FIFO queue persisted to disk so an app kill mid-download just costs
      // the bytes of the currently-running chapter. `created_at` is the
      // insertion order; the worker pops oldest queued first.
      if (!db.objectStoreNames.contains(STORES.JOBS)) {
        const s = db.createObjectStore(STORES.JOBS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        s.createIndex('by_status',     'status');
        s.createIndex('by_manga',      'manga_id');
        s.createIndex('by_chapter',    'chapter_id');
        s.createIndex('by_created_at', 'created_at');
      }

      // ── progress_outbox ────────────────────────────────────────────────
      // Pending PUT /api/progress/* writes. Keyed by [user_id, chapter_id]
      // (v2) so two accounts on the same device don't clobber each other's
      // pending writes for the same chapter; rows for one chapter still
      // collapse for one user.
      if (oldVersion < 2 && db.objectStoreNames.contains(STORES.OUTBOX)) {
        // Migrate v1 (keyPath: chapter_id) → v2 (composite). Snapshot the old
        // rows via the version-change transaction, drop the store, recreate
        // with the new keyPath, and re-put each row stamped with the active
        // user id so they flush to the right account on next reconnect.
        const oldStore = tx.objectStore(STORES.OUTBOX);
        const oldRows  = await oldStore.getAll();
        db.deleteObjectStore(STORES.OUTBOX);
        const s = db.createObjectStore(STORES.OUTBOX, { keyPath: ['user_id', 'chapter_id'] });
        s.createIndex('by_user',  'user_id');
        s.createIndex('by_manga', 'manga_id');
        const stamp = getActiveUserIdSync();
        for (const row of oldRows) {
          s.put({ ...row, user_id: Number(row.user_id) || stamp, chapter_id: Number(row.chapter_id) });
        }
      } else if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
        // Fresh install — create v2 schema directly.
        const s = db.createObjectStore(STORES.OUTBOX, { keyPath: ['user_id', 'chapter_id'] });
        s.createIndex('by_user',  'user_id');
        s.createIndex('by_manga', 'manga_id');
      }

      // ── meta ────────────────────────────────────────────────────────────
      // Single-row key/value store for things like the bound server_id, the
      // last successful sync timestamp, and the JSON index version. Keyed
      // by a free-form `key` field.
      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'key' });
      }
    },
  });
  return _dbPromise;
}

// ── Manga ────────────────────────────────────────────────────────────────────

export async function putOfflineManga(row) {
  const db = await getOfflineDb();
  await db.put(STORES.MANGA, normalizeMangaRow(row));
}

export async function getOfflineManga(id) {
  const db = await getOfflineDb();
  return db.get(STORES.MANGA, Number(id));
}

export async function listOfflineManga({ sort = 'title', search = '' } = {}) {
  const db = await getOfflineDb();
  let rows = await db.getAll(STORES.MANGA);

  const q = search.trim().toLowerCase();
  if (q) {
    // Substring match against the precomputed search blob. AND-composes
    // whitespace-separated terms so "shonen action" matches a row that
    // mentions both somewhere — same behaviour the server's FTS gives.
    const terms = q.split(/\s+/).filter(Boolean);
    rows = rows.filter(r => {
      const blob = r.search_text || '';
      return terms.every(t => blob.includes(t));
    });
  }

  rows.sort((a, b) => {
    switch (sort) {
      case 'updated':
        return (b.updated_at || b.downloaded_at || 0) - (a.updated_at || a.downloaded_at || 0);
      case 'year':
        return (b.year || 0) - (a.year || 0);
      case 'rating':
        return (b.rating || 0) - (a.rating || 0);
      case 'title':
      default:
        return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    }
  });
  return rows;
}

export async function deleteOfflineManga(id) {
  const db = await getOfflineDb();
  // Two-pass: snapshot the chapter ids first, then a single readwrite tx
  // wipes every store the manga touches. Doing chapter-id collection
  // *outside* the rw tx avoids holding the lock during the index scan.
  const chapterIds = (await db.getAllFromIndex(STORES.CHAPTERS, 'by_manga', Number(id)))
    .map(c => Number(c.id));

  const tx = db.transaction(
    [STORES.MANGA, STORES.CHAPTERS, STORES.PAGES, STORES.JOBS, STORES.OUTBOX],
    'readwrite',
  );
  await tx.objectStore(STORES.MANGA).delete(Number(id));
  await deleteIndex(tx.objectStore(STORES.CHAPTERS), 'by_manga', IDBKeyRange.only(Number(id)));
  await deleteIndex(tx.objectStore(STORES.JOBS),     'by_manga', IDBKeyRange.only(Number(id)));
  await deleteIndex(tx.objectStore(STORES.OUTBOX),   'by_manga', IDBKeyRange.only(Number(id)));

  // Pages are keyed by [chapter_id, page_index] and only have a chapter
  // index. Loop the captured chapter ids and drop each chapter's pages
  // in the same transaction.
  const pages = tx.objectStore(STORES.PAGES);
  for (const cid of chapterIds) {
    await deleteIndex(pages, 'by_chapter', IDBKeyRange.only(cid));
  }
  await tx.done;
}

// Pre-compute the lower-cased text blob used for offline substring search.
// Strips out anything that isn't useful as a search target (cover URLs,
// numeric ids) and folds in fields the SQL search also covers (alt titles,
// author, genres).
function buildSearchText(row) {
  const fields = [
    row.title,
    row.original_title,
    row.author,
    row.artist,
    Array.isArray(row.alt_titles) ? row.alt_titles.join(' ') : row.alt_titles,
    Array.isArray(row.genres)     ? row.genres.join(' ')     : row.genres,
    Array.isArray(row.tags)       ? row.tags.join(' ')       : row.tags,
  ];
  return fields.filter(Boolean).join(' ').toLowerCase();
}

function normalizeMangaRow(row) {
  return {
    ...row,
    id:             Number(row.id),
    downloaded_at:  row.downloaded_at || Date.now(),
    search_text:    buildSearchText(row),
  };
}

// ── Chapters ─────────────────────────────────────────────────────────────────

export async function putOfflineChapter(row) {
  const db = await getOfflineDb();
  await db.put(STORES.CHAPTERS, {
    ...row,
    id:        Number(row.id),
    manga_id:  Number(row.manga_id),
    status:    row.status || 'done',
  });
}

export async function getOfflineChapter(id) {
  const db = await getOfflineDb();
  return db.get(STORES.CHAPTERS, Number(id));
}

export async function listOfflineChaptersForManga(mangaId) {
  const db = await getOfflineDb();
  const rows = await db.getAllFromIndex(STORES.CHAPTERS, 'by_manga', Number(mangaId));
  // The MangaDetail UI orders chapters by (volume, number, folder_name) —
  // do the same here so the offline list matches the online one.
  rows.sort((a, b) => {
    const va = a.volume ?? Number.POSITIVE_INFINITY;
    const vb = b.volume ?? Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    const na = a.number ?? Number.POSITIVE_INFINITY;
    const nb = b.number ?? Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    return (a.folder_name || '').localeCompare(b.folder_name || '', undefined, { numeric: true });
  });
  return rows;
}

export async function deleteOfflineChapter(id) {
  const db = await getOfflineDb();
  const tx = db.transaction([STORES.CHAPTERS, STORES.PAGES], 'readwrite');
  await tx.objectStore(STORES.CHAPTERS).delete(Number(id));
  await deleteIndex(tx.objectStore(STORES.PAGES), 'by_chapter', IDBKeyRange.only(Number(id)));
  await tx.done;
}

// ── Pages ────────────────────────────────────────────────────────────────────

export async function putOfflinePages(chapterId, pages) {
  const db = await getOfflineDb();
  const tx = db.transaction(STORES.PAGES, 'readwrite');
  for (const p of pages) {
    await tx.store.put({ ...p, chapter_id: Number(chapterId) });
  }
  await tx.done;
}

export async function getOfflinePagesByChapter(chapterId) {
  const db = await getOfflineDb();
  return db.getAllFromIndex(STORES.PAGES, 'by_chapter', Number(chapterId));
}

export async function getOfflinePageByPageId(pageId) {
  const db = await getOfflineDb();
  return db.getFromIndex(STORES.PAGES, 'by_page_id', Number(pageId));
}

// ── Jobs ─────────────────────────────────────────────────────────────────────
// Lifecycle: 'queued' → 'running' → 'done' | 'failed' | 'cancelled'.
// Jobs are kept around after completion so the UI can show the recent
// download log; explicit `clearFinishedJobs()` is the GC.

export async function enqueueJob(job) {
  const db = await getOfflineDb();
  const id = await db.add(STORES.JOBS, {
    status:     'queued',
    attempts:   0,
    created_at: Date.now(),
    ...job,
  });
  return id;
}

export async function updateJob(id, patch) {
  const db = await getOfflineDb();
  const existing = await db.get(STORES.JOBS, id);
  if (!existing) return;
  await db.put(STORES.JOBS, { ...existing, ...patch });
}

export async function listJobs({ status } = {}) {
  const db = await getOfflineDb();
  if (status) return db.getAllFromIndex(STORES.JOBS, 'by_status', status);
  return db.getAll(STORES.JOBS);
}

export async function getJob(id) {
  const db = await getOfflineDb();
  return db.get(STORES.JOBS, id);
}

export async function getJobForChapter(chapterId) {
  const db = await getOfflineDb();
  // A chapter can have multiple rows over its history (e.g. a 'failed' run
  // followed by a 'queued' retry). The downloader-status UI cares about
  // the most recent state, so return the row with the highest `created_at`.
  const rows = await db.getAllFromIndex(STORES.JOBS, 'by_chapter', Number(chapterId));
  if (rows.length === 0) return undefined;
  rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return rows[0];
}

export async function clearFinishedJobs() {
  const db = await getOfflineDb();
  const tx = db.transaction(STORES.JOBS, 'readwrite');
  const done = await tx.store.index('by_status').getAllKeys('done');
  const cancelled = await tx.store.index('by_status').getAllKeys('cancelled');
  for (const k of [...done, ...cancelled]) await tx.store.delete(k);
  await tx.done;
}

// Wipe every row from the jobs store. The caller is responsible for
// aborting any in-flight controllers first (see cancelJob in
// downloader.js) — this just clears the persisted queue.
export async function clearAllJobs() {
  const db = await getOfflineDb();
  await db.clear(STORES.JOBS);
}

// ── Outbox (progress sync) ───────────────────────────────────────────────────

export async function enqueueProgressWrite(entry) {
  const db = await getOfflineDb();
  // Stamp the active user id so the row replays against the correct account
  // when connectivity returns (and so two users on the same device don't
  // collapse onto each other's pending write for the same chapter).
  const userId = entry.user_id != null ? Number(entry.user_id) : getActiveUserIdSync();
  await db.put(STORES.OUTBOX, {
    ...entry,
    user_id:    userId,
    chapter_id: Number(entry.chapter_id),
    manga_id:   Number(entry.manga_id),
    updated_at: Date.now(),
  });
}

/** Every outbox row, across all users on this device. */
export async function listOutbox() {
  const db = await getOfflineDb();
  return db.getAll(STORES.OUTBOX);
}

/** Outbox rows belonging to one user (what the flusher replays). */
export async function listOutboxForUser(userId) {
  const db = await getOfflineDb();
  return db.getAllFromIndex(STORES.OUTBOX, 'by_user', Number(userId));
}

/** Remove one outbox row by its composite key. `row` must carry user_id + chapter_id. */
export async function clearOutboxEntry(row) {
  const db = await getOfflineDb();
  await db.delete(STORES.OUTBOX, [Number(row.user_id), Number(row.chapter_id)]);
}

// ── Meta key/value ───────────────────────────────────────────────────────────

export async function getMeta(key) {
  const db = await getOfflineDb();
  const row = await db.get(STORES.META, key);
  return row?.value;
}

export async function setMeta(key, value) {
  const db = await getOfflineDb();
  await db.put(STORES.META, { key, value });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function deleteIndex(store, indexName, keyRange) {
  const keys = await store.index(indexName).getAllKeys(keyRange);
  for (const k of keys) await store.delete(k);
}
