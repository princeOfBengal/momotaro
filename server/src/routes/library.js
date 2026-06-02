const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db/database');
const { runFullScan, scanLibrary, getScanStatus } = require('../scanner/libraryScanner');
const { thumbnailPath, thumbnailUrl } = require('../scanner/thumbnailPaths');
const { addLibraryWatch, removeLibraryWatch } = require('../watcher');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { requireAdmin } = require('../middleware/auth');
const genresCache = require('../genresCache');
const cbzCache = require('../scanner/cbzCache');
const { safeJsonParse, csvEscape, formatUnix } = require('../utils');

const router = express.Router();

// ── Library / reading-list listing helpers ──────────────────────────────────
//
// The library grid only renders cover, title, year, score, status. Returning
// the full row (description, genres JSON, author, cover-source columns…) on
// every Library / reading-list fetch was wasted bandwidth and JSON-parse cost.
// Restrict to the columns the grid + keyset cursor actually need.
//
// `m.title` is needed for sort=title cursors; `m.updated_at` for sort=updated
// cursors. Both are read by encodeCursor() via valueColumn lookup further
// below.

const LIBRARY_LIST_COLUMNS = [
  'm.id',
  'm.title',
  'm.year',
  'm.score',
  'm.status',
  'm.cover_image',
  'm.updated_at',
].join(', ');

// Map a thin row to the response shape the client expects. `genres` is
// intentionally omitted — MangaCard never reads it, and search-by-genre is
// resolved server-side via manga_genres / FTS.
function toListingRow(m) {
  return {
    id:          m.id,
    title:       m.title,
    year:        m.year,
    score:       m.score,
    status:      m.status,
    cover_image: m.cover_image,
    updated_at:  m.updated_at,
    cover_url:   m.cover_image ? thumbnailUrl(m.cover_image) : null,
  };
}

// Bounded LRU caches for the two listing endpoints. Keyspace is unbounded in
// principle (free-form search queries), so cap at MAX_LISTING_CACHE entries
// and evict oldest-inserted on overflow. TTL matches /api/home (30 s).
const LISTING_CACHE_TTL_MS  = 30 * 1000;
const MAX_LISTING_CACHE     = 50;
const _libraryCache           = new Map(); // key -> { value, ts }
const _readingListMangaCache  = new Map(); // key -> { value, ts }

function getListingCache(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts >= LISTING_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh insertion order so this key is now most-recent.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setListingCache(cache, key, value) {
  if (cache.size >= MAX_LISTING_CACHE) {
    // Map iterates in insertion order — first key is the oldest.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, ts: Date.now() });
}

// ── Library CRUD ────────────────────────────────────────────────────────────

// GET /api/libraries — list all libraries with manga counts
router.get('/libraries', asyncWrapper(async (req, res) => {
  const db = getDb();
  const libraries = db.prepare(`
    SELECT l.*, COUNT(m.id) as manga_count
    FROM libraries l
    LEFT JOIN manga m ON m.library_id = l.id
    GROUP BY l.id
    ORDER BY l.name ASC
  `).all();
  res.json({ data: libraries });
}));

// POST /api/libraries — create a new library
router.post('/libraries', requireAdmin, asyncWrapper(async (req, res) => {
  const { name, path: libPath } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!libPath || !libPath.trim()) return res.status(400).json({ error: 'path is required' });

  const db = getDb();

  const existing = db.prepare('SELECT id FROM libraries WHERE path = ?').get(libPath.trim());
  if (existing) return res.status(409).json({ error: 'A library with this path already exists' });

  const result = db.prepare('INSERT INTO libraries (name, path) VALUES (?, ?)')
    .run(name.trim(), libPath.trim());

  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(result.lastInsertRowid);

  // Ensure the directory exists, then scan and watch in background
  fs.mkdirSync(library.path, { recursive: true });
  addLibraryWatch(library);
  scanLibrary(library, { force: true }).catch(err => console.error('[Library] Scan error:', err.message));

  res.status(201).json({ data: { ...library, manga_count: 0 } });
}));

// PATCH /api/libraries/:id — update name and/or path, or toggle show_in_all
router.patch('/libraries/:id', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const { name, path: newPath, show_in_all } = req.body;

  // Allow toggling show_in_all independently (no name required)
  if (show_in_all !== undefined && !name && !newPath) {
    db.prepare('UPDATE libraries SET show_in_all = ? WHERE id = ?')
      .run(show_in_all ? 1 : 0, library.id);
    // /api/home and /api/stats both scope to libraries with show_in_all = 1
    // in All Libraries mode; drop their caches so the toggle is visible
    // immediately instead of after the next TTL expiry.
    _homeCache.clear();
    _statsCache.clear();
    const updated = db.prepare(`
      SELECT l.*, COUNT(m.id) as manga_count
      FROM libraries l LEFT JOIN manga m ON m.library_id = l.id
      WHERE l.id = ? GROUP BY l.id
    `).get(library.id);
    return res.json({ data: updated });
  }

  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const pathChanged = newPath && newPath.trim() && newPath.trim() !== library.path;

  if (pathChanged) {
    const conflict = db.prepare('SELECT id FROM libraries WHERE path = ? AND id != ?')
      .get(newPath.trim(), library.id);
    if (conflict) return res.status(409).json({ error: 'Another library already uses this path' });
  }

  const finalPath = pathChanged ? newPath.trim() : library.path;
  db.prepare('UPDATE libraries SET name = ?, path = ? WHERE id = ?')
    .run(name.trim(), finalPath, library.id);

  const updated = db.prepare('SELECT * FROM libraries WHERE id = ?').get(library.id);

  if (pathChanged) {
    // Stop watching old path, start watching new path, re-scan
    await removeLibraryWatch(library.id);
    fs.mkdirSync(finalPath, { recursive: true });
    addLibraryWatch(updated);
    scanLibrary(updated, { force: true }).catch(err => console.error('[Library] Scan error after path change:', err.message));
  }

  const withCount = db.prepare(`
    SELECT l.*, COUNT(m.id) as manga_count
    FROM libraries l LEFT JOIN manga m ON m.library_id = l.id
    WHERE l.id = ? GROUP BY l.id
  `).get(library.id);

  res.json({ data: withCount });
}));

// DELETE /api/libraries/:id — remove library and all its manga
router.delete('/libraries/:id', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  // Stop file watcher first
  await removeLibraryWatch(library.id);

  // Cancel every active CBZ extraction belonging to this library before the
  // CASCADE runs. Without this, Phase 2 workers continue writing dim
  // UPDATEs to rows that are about to be deleted and any readers holding
  // page waiters hang for the full timeout. The query joins through manga
  // because chapters → libraries is mediated by manga.library_id.
  let cbzIds = [];
  try {
    cbzIds = db.prepare(`
      SELECT c.id
      FROM chapters c
      JOIN manga m ON m.id = c.manga_id
      WHERE m.library_id = ? AND c.type = 'cbz'
    `).all(library.id).map(r => r.id);
  } catch (_) { /* defensive — schema variation in tests */ }
  if (cbzIds.length > 0) cbzCache.cancelChapters(cbzIds, 'Library removed');

  // ON DELETE SET NULL on manga.library_id — manually delete manga so cascade
  // removes chapters/pages/progress
  db.prepare('DELETE FROM manga WHERE library_id = ?').run(library.id);
  db.prepare('DELETE FROM libraries WHERE id = ?').run(library.id);

  res.json({ message: 'Library deleted' });
}));

// POST /api/libraries/:id/scan — scan a specific library
router.post('/libraries/:id/scan', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const status = getScanStatus();
  if (status.running) {
    return res.status(409).json({ error: 'Scan already in progress', status });
  }

  res.json({ message: 'Scan started' });
  scanLibrary(library, { force: true }).catch(err => console.error('[Scan] Error:', err.message));
}));

// ── Reading Lists ────────────────────────────────────────────────────────────

// GET /api/reading-lists.csv — downloadable CSV of every membership in the
// caller's lists. Distinct path (with the .csv suffix) so it can't be matched
// as `:id` by a later `/reading-lists/:id/...` route. Default + custom lists
// are both included; the user is welcome to filter in their spreadsheet.
router.get('/reading-lists.csv', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const rows = db.prepare(`
    SELECT rl.name AS list_name, rl.is_default,
           m.id    AS manga_id, m.title AS manga_title, m.path AS manga_path,
           l.name  AS library_name,
           rlm.added_at
    FROM reading_lists rl
    JOIN reading_list_manga rlm ON rlm.list_id = rl.id
    JOIN manga m                ON m.id = rlm.manga_id
    LEFT JOIN libraries l       ON l.id = m.library_id
    WHERE rl.user_id = ?
    ORDER BY rl.is_default DESC, rl.name ASC, m.title COLLATE NOCASE ASC
  `).all(userId);

  const lines = [];
  lines.push(['List', 'Built-in', 'Manga', 'Library', 'Folder path', 'Added at (UTC)'].map(csvEscape).join(','));
  for (const r of rows) {
    lines.push([
      r.list_name,
      r.is_default ? 'yes' : '',
      r.manga_title || `#${r.manga_id}`,
      r.library_name || '',
      r.manga_path || '',
      formatUnix(r.added_at),
    ].map(csvEscape).join(','));
  }
  // UTF-8 BOM so Excel renders non-ASCII titles correctly. RFC 4180 line endings.
  const body = '﻿' + lines.join('\r\n') + '\r\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="momotaro-reading-lists-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}));

// GET /api/reading-lists — all lists with manga counts
router.get('/reading-lists', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const lists = db.prepare(`
    SELECT rl.*, COUNT(rlm.manga_id) as manga_count
    FROM reading_lists rl
    LEFT JOIN reading_list_manga rlm ON rlm.list_id = rl.id
    WHERE rl.user_id = ?
    GROUP BY rl.id
    ORDER BY rl.is_default DESC, rl.name ASC
  `).all(userId);
  res.json({ data: lists });
}));

// POST /api/reading-lists — create a custom list
router.post('/reading-lists', asyncWrapper(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const db = getDb();
  const userId = req.user.id;
  try {
    const result = db.prepare('INSERT INTO reading_lists (user_id, name, is_default) VALUES (?, ?, 0)').run(userId, name.trim());
    const list = db.prepare('SELECT * FROM reading_lists WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: { ...list, manga_count: 0 } });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A list with this name already exists' });
    throw err;
  }
}));

// DELETE /api/reading-lists/:id — delete custom list (not default)
router.delete('/reading-lists/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const list = db.prepare('SELECT * FROM reading_lists WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!list) return res.status(404).json({ error: 'Reading list not found' });
  if (list.is_default) return res.status(400).json({ error: 'Cannot delete a built-in reading list' });
  db.prepare('DELETE FROM reading_lists WHERE id = ?').run(list.id);
  res.json({ message: 'Deleted' });
}));

// GET /api/reading-lists/:id/manga — manga in a list (supports search & sort)
router.get('/reading-lists/:id/manga', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const list = db.prepare('SELECT id FROM reading_lists WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!list) return res.status(404).json({ error: 'Reading list not found' });

  const { search, sort = 'title' } = req.query;

  // Browser HTTP cache backs up the SW StaleWhileRevalidate. 15 s window
  // matches the in-process cache TTL below.
  //
  // Search responses are explicitly NOT cached anywhere on the device:
  // every keystroke produces a unique URL, and accumulating them in the
  // browser HTTP cache (in addition to the SW) put enough pressure on
  // mobile storage to noticeably stall subsequent fetches. The SW also
  // has a NetworkOnly rule for `?search=` that bypasses its runtime
  // cache, but the server-side header makes the contract explicit.
  if (search) {
    res.set('Cache-Control', 'no-store');
  } else {
    res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
  }

  const cacheKey = `list:${list.id}|s:${search || ''}|o:${sort}`;
  const cached = getListingCache(_readingListMangaCache, cacheKey);
  if (cached) return res.json({ data: cached });

  let query = `
    SELECT ${LIBRARY_LIST_COLUMNS} FROM manga m
    INNER JOIN reading_list_manga rlm ON rlm.manga_id = m.id AND rlm.list_id = ?
    WHERE 1=1
  `;
  const params = [list.id];

  {
    const { clause, params: p } = buildSearchClause(search);
    query += clause;
    params.push(...p);
  }

  const orderMap = {
    title:   'm.title ASC',
    updated: 'm.updated_at DESC',
    year:    'm.year DESC',
    added:   'rlm.added_at DESC',
    // Rating sort: manga missing a score (not matched to AniList or MAL) are
    // pushed to the bottom; ties break on title so the order is stable.
    rating:  'm.score DESC NULLS LAST, m.title ASC',
  };
  query += ` ORDER BY ${orderMap[sort] || 'm.title ASC'}`;

  const manga = db.prepare(query).all(...params).map(toListingRow);
  setListingCache(_readingListMangaCache, cacheKey, manga);
  res.json({ data: manga });
}));

// POST /api/reading-lists/:id/manga — add manga to list
router.post('/reading-lists/:id/manga', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const list = db.prepare('SELECT id FROM reading_lists WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!list) return res.status(404).json({ error: 'Reading list not found' });

  const { manga_id } = req.body;
  if (!manga_id) return res.status(400).json({ error: 'manga_id is required' });

  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(manga_id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  db.prepare('INSERT OR IGNORE INTO reading_list_manga (list_id, manga_id) VALUES (?, ?)').run(list.id, manga_id);
  res.json({ message: 'Added' });
}));

// DELETE /api/reading-lists/:id/manga/:mangaId — remove manga from list
router.delete('/reading-lists/:id/manga/:mangaId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  // The list_id IN (…) sub-select scopes the delete to the caller's own lists,
  // so a user can't remove entries from another account's list.
  db.prepare(`
    DELETE FROM reading_list_manga
    WHERE list_id = ? AND manga_id = ?
      AND list_id IN (SELECT id FROM reading_lists WHERE user_id = ?)
  `).run(req.params.id, req.params.mangaId, userId);
  res.json({ message: 'Removed' });
}));

// GET /api/manga/:id/reading-lists — which list IDs contain this manga
router.get('/manga/:id/reading-lists', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const rows = db.prepare(`
    SELECT rlm.list_id
    FROM reading_list_manga rlm
    JOIN reading_lists rl ON rl.id = rlm.list_id
    WHERE rlm.manga_id = ? AND rl.user_id = ?
  `).all(req.params.id, userId);
  res.json({ data: rows.map(r => r.list_id) });
}));

// ── Manga / Library endpoints ────────────────────────────────────────────────

// Opaque cursor helpers — encode the row's sort-key + id so the next page
// can resume past the last row without using OFFSET.
function encodeCursor(value, id) {
  return Buffer.from(JSON.stringify([value, id])).toString('base64url');
}
function decodeCursor(token) {
  try {
    const arr = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    if (!Array.isArray(arr) || arr.length !== 2) return null;
    return { value: arr[0], id: arr[1] };
  } catch { return null; }
}

const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 200;

// Sort modes that support keyset pagination. Each entry describes the SQL
// sort column, ORDER direction, and the corresponding WHERE comparison.
const KEYSET_SORTS = {
  title:   { column: 'm.title',      direction: 'ASC',  cmp: '>' },
  updated: { column: 'm.updated_at', direction: 'DESC', cmp: '<' },
};

// GET /api/library
// Optional pagination: pass ?limit=N (default 200 when cursor is present, max 500).
// When `limit` is supplied the response includes `next_cursor` (null when the
// listing is exhausted) and `has_more`. Resume with ?cursor=<opaque>.
// Cursors are supported for sort=title (default) and sort=updated; year sort
// falls back to LIMIT-only (no cursor).
router.get('/library', asyncWrapper(async (req, res) => {
  const db = getDb();
  const { search, status, sort = 'title', library_id, cursor } = req.query;

  let limit = null;
  if (req.query.limit !== undefined || cursor) {
    const parsed = req.query.limit !== undefined
      ? parseInt(req.query.limit, 10)
      : DEFAULT_LIMIT;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  // Browser HTTP cache backs up the SW StaleWhileRevalidate for non-PWA
  // tabs (incognito, fresh installs). Aligned with the in-process cache TTL.
  //
  // Search responses are NOT cached on the device — every keystroke is a
  // unique URL, and caching them flooded both the SW's `browse-data` LRU
  // and the browser HTTP cache, which on mobile Chromium showed up as a
  // freeze during search inside a particular library. The SW's NetworkOnly
  // rule for `?search=` already bypasses runtime caching there; this
  // header keeps the browser HTTP cache aligned.
  if (search) {
    res.set('Cache-Control', 'no-store');
  } else {
    res.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=60');
  }

  // In-process cache: keyed by every parameter that affects the result. 30 s
  // TTL matches /api/home / /api/stats — scans surface within that window.
  const cacheKey = [
    `s:${search || ''}`,
    `st:${status || ''}`,
    `o:${sort}`,
    `lib:${library_id || ''}`,
    `c:${cursor || ''}`,
    `lim:${limit == null ? '' : limit}`,
  ].join('|');
  const cached = getListingCache(_libraryCache, cacheKey);
  if (cached) return res.json(cached);

  let query = `SELECT ${LIBRARY_LIST_COLUMNS} FROM manga m LEFT JOIN libraries l ON l.id = m.library_id WHERE 1=1`;
  const params = [];

  {
    const { clause, params: p } = buildSearchClause(search);
    query += clause;
    params.push(...p);
  }
  if (status) {
    query += ' AND m.status = ?';
    params.push(status.toUpperCase());
  }
  if (library_id) {
    query += ' AND m.library_id = ?';
    params.push(parseInt(library_id, 10));
  } else {
    query += ' AND (m.library_id IS NULL OR l.show_in_all = 1)';
  }

  const keysetSort = KEYSET_SORTS[sort] || null;

  // Keyset clause — only when a cursor was provided AND the sort supports it
  if (cursor) {
    if (!keysetSort) {
      return res.status(400).json({ error: `Cursor pagination is not supported for sort=${sort}` });
    }
    const decoded = decodeCursor(cursor);
    if (!decoded) return res.status(400).json({ error: 'Invalid cursor' });
    query += ` AND (${keysetSort.column} ${keysetSort.cmp} ?
                    OR (${keysetSort.column} = ? AND m.id ${keysetSort.cmp} ?))`;
    params.push(decoded.value, decoded.value, decoded.id);
  }

  if (keysetSort) {
    // Include m.id as a tiebreaker so the cursor is deterministic across ties
    query += ` ORDER BY ${keysetSort.column} ${keysetSort.direction}, m.id ${keysetSort.direction}`;
  } else {
    const orderMap = {
      year:   'm.year DESC',
      // Rating: highest score first, with unrated manga (no AniList/MAL match)
      // falling to the bottom via NULLS LAST.
      rating: 'm.score DESC NULLS LAST, m.title ASC',
    };
    query += ` ORDER BY ${orderMap[sort] || 'm.title ASC'}, m.id ASC`;
  }

  if (limit !== null) {
    // Over-fetch by one row to detect has_more without a COUNT(*)
    query += ' LIMIT ?';
    params.push(limit + 1);
  }

  const rows = db.prepare(query).all(...params);

  let hasMore = false;
  let nextCursor = null;
  let manga = rows;
  if (limit !== null && rows.length > limit) {
    hasMore = true;
    manga = rows.slice(0, limit);
    if (keysetSort) {
      const last = manga[manga.length - 1];
      const valueColumn = keysetSort.column.replace(/^m\./, '');
      nextCursor = encodeCursor(last[valueColumn], last.id);
    }
  }

  const payload = {
    data: manga.map(toListingRow),
  };
  if (limit !== null) {
    payload.next_cursor = nextCursor;
    payload.has_more    = hasMore;
  }

  setListingCache(_libraryCache, cacheKey, payload);
  res.json(payload);
}));

// GET /api/manga/:id
router.get('/manga/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const chapters = db.prepare(
    'SELECT * FROM chapters WHERE manga_id = ? ORDER BY number ASC NULLS LAST, folder_name ASC'
  ).all(manga.id);

  // Scope progress to the requesting user — otherwise multi-user installs
  // would leak whichever account happened to be matched first.
  const progress = db.prepare('SELECT * FROM progress WHERE user_id = ? AND manga_id = ?')
    .get(req.user.id, manga.id);

  res.json({
    data: {
      ...manga,
      genres: safeJsonParse(manga.genres, []),
      cover_url: manga.cover_image ? thumbnailUrl(manga.cover_image) : null,
      chapters,
      progress: progress
        ? { ...progress, completed_chapters: safeJsonParse(progress.completed_chapters, []) }
        : null,
    },
  });
}));

// GET /api/manga/:id/offline-package — single batched payload the Android
// app's download queue uses to bootstrap an offline series snapshot. Returns
// manga metadata + cover URL + the full chapter list in one round-trip,
// versus the historical N round-trips (one per call to /manga/:id and
// /manga/:id/chapters).
//
// Per-chapter page lists are intentionally NOT included. /chapters/:id/pages
// is the only call that exercises the CBZ extractor, and pre-extracting an
// entire series synchronously inside a single HTTP request would either
// time out the client or starve the request queue. The downloader fetches
// pages chapter-by-chapter, which keeps memory bounded and lets the user
// cancel mid-series cheaply.
//
// `updated_at` is exposed at the top level so the client can compare against
// its local `downloaded_at` and surface a "refresh offline copy" action when
// the server-side row has been re-scanned / re-tagged.
router.get('/manga/:id/offline-package', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  // The chapters table doesn't have a literal `updated_at` column —
  // its modification timestamp is `file_mtime`, set by the library
  // scanner from the CBZ archive's (or folder's) on-disk mtime and
  // updated on every re-scan. Expose it under the same `updated_at`
  // key the rest of the API uses so the offline downloader's
  // stale-copy detector (see client/src/api/downloader.js,
  // `isChapterStale`) can compare against it without branching.
  const chapters = db.prepare(
    `SELECT id, manga_id, number, volume, title, folder_name, page_count, type,
            file_mtime AS updated_at
     FROM chapters
     WHERE manga_id = ?
     ORDER BY number ASC NULLS LAST, folder_name ASC`
  ).all(manga.id);

  res.json({
    data: {
      manga: {
        ...manga,
        genres:    safeJsonParse(manga.genres, []),
        cover_url: manga.cover_image ? thumbnailUrl(manga.cover_image) : null,
      },
      chapters,
      // Server-side timestamp the client can persist alongside the local
      // snapshot. Compare against the local `downloaded_at` to decide
      // whether the offline copy is stale.
      server_updated_at: manga.updated_at,
      fetched_at:        Math.floor(Date.now() / 1000),
    },
  });
}));

// PATCH /api/manga/:id — update per-manga settings or user-editable metadata
router.patch('/manga/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { track_volumes, title, author, genres } = req.body;

  if (track_volumes !== undefined) {
    db.prepare('UPDATE manga SET track_volumes = ?, updated_at = unixepoch() WHERE id = ?')
      .run(track_volumes ? 1 : 0, req.params.id);
  }

  if (title !== undefined) {
    const trimmed = String(title).trim();
    if (!trimmed) return res.status(400).json({ error: 'title cannot be empty' });
    db.prepare('UPDATE manga SET title = ?, updated_at = unixepoch() WHERE id = ?')
      .run(trimmed, req.params.id);
  }

  if (author !== undefined) {
    const trimmed = String(author).trim();
    db.prepare('UPDATE manga SET author = ?, updated_at = unixepoch() WHERE id = ?')
      .run(trimmed || null, req.params.id);
  }

  if (genres !== undefined) {
    if (!Array.isArray(genres)) return res.status(400).json({ error: 'genres must be an array' });
    const cleaned = genres
      .map(g => (typeof g === 'string' ? g.trim() : ''))
      .filter(Boolean);
    db.prepare('UPDATE manga SET genres = ?, updated_at = unixepoch() WHERE id = ?')
      .run(JSON.stringify(cleaned), req.params.id);
  }

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  res.json({ data: { ...updated, genres: safeJsonParse(updated.genres, []) } });
}));

// DELETE /api/manga/:id — remove manga from DB and delete its files on disk
router.delete('/manga/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  // Collect CBZ chapter IDs and cancel any active extractions before the
  // CASCADE clears them. cbzCache.cancelChapters aborts Phase 2 workers,
  // rejects every open page waiter with CHAPTER_REMOVED (→ HTTP 410 from
  // the image route), and removes the per-chapter cache directories. The
  // cache dirs are keyed by `<chapterId>_<mtime>`, which is why the old
  // `fs.rmSync(path.join(CBZ_CACHE_DIR, String(ch.id)))` did nothing
  // useful — it tried to remove `<CACHE_DIR>/<id>` without the mtime
  // suffix and silently no-op'd.
  const cbzIds = db.prepare(
    "SELECT id FROM chapters WHERE manga_id = ? AND type = 'cbz'"
  ).all(manga.id).map(r => r.id);
  if (cbzIds.length > 0) cbzCache.cancelChapters(cbzIds, 'Manga removed');

  // Remove from DB — CASCADE deletes chapters, pages, progress
  db.prepare('DELETE FROM manga WHERE id = ?').run(manga.id);

  // Delete thumbnail
  if (manga.cover_image) {
    try { fs.unlinkSync(thumbnailPath(manga.cover_image)); } catch (_) {}
  }

  // Delete the manga folder on disk
  if (manga.path) {
    try {
      fs.rmSync(manga.path, { recursive: true, force: true });
      console.log(`[Delete] Removed manga folder: ${manga.path}`);
    } catch (err) {
      console.warn(`[Delete] Could not remove manga folder: ${err.message}`);
    }
  }

  res.json({ message: 'Deleted' });
}));

// POST /api/scan — scan all libraries
router.post('/scan', requireAdmin, asyncWrapper(async (req, res) => {
  const status = getScanStatus();
  if (status.running) {
    return res.status(409).json({ error: 'Scan already in progress', status });
  }
  res.json({ message: 'Scan started' });
  runFullScan({ force: true, trigger: 'manual-full' })
    .catch(err => console.error('[Scan] Error:', err.message));
}));

// GET /api/scan/status — current scan progress
router.get('/scan/status', asyncWrapper(async (req, res) => {
  res.json({ data: getScanStatus() });
}));

// POST /api/manga/:id/scan — re-scan only this manga's folder.
//
// Cheap alternative to a full library scan when the user just wants to pick
// up freshly-added chapters for one series. Walks `manga.path` only, runs
// the same upsert / chapter-index / cover-thumbnail pipeline as the bulk
// scanner, but never touches sibling manga or runs the per-library cover /
// metadata reinforcement passes — those rely on aggregated state that
// only makes sense after a full pass.
//
// Synchronous: the response is sent only after the rescan completes so the
// MangaDetail page can re-fetch and immediately display the new chapters.
// `scanMangaDirectory` is fast for a single folder (a handful of MB of disk
// I/O at most) so blocking the request here is fine.
// Single-manga rescan is left ungated: it's a MangaDetail user action (refresh
// after dropping new chapters into a folder), not Library Management. The
// admin-only paths are the per-library and full-server scans above.
router.post('/manga/:id/scan', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare(
    'SELECT id, folder_name, path, library_id FROM manga WHERE id = ?'
  ).get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const beforeCount = db.prepare(
    'SELECT COUNT(*) AS n FROM chapters WHERE manga_id = ?'
  ).pluck().get(manga.id);

  const { scanMangaDirectory } = require('../scanner/libraryScanner');
  try {
    await scanMangaDirectory(manga.path, manga.folder_name, manga.library_id);
  } catch (err) {
    return res.status(500).json({ error: 'Scan failed: ' + err.message });
  }

  const afterCount = db.prepare(
    'SELECT COUNT(*) AS n FROM chapters WHERE manga_id = ?'
  ).pluck().get(manga.id);

  res.json({
    data: {
      before_chapter_count: beforeCount,
      after_chapter_count:  afterCount,
      added:                Math.max(0, afterCount - beforeCount),
      removed:              Math.max(0, beforeCount - afterCount),
    },
  });
}));

// GET /api/manga/:id/info — file path, file count, and folder size.
// Values come from the cached `bytes_on_disk` / `file_count` columns populated
// during scan. This used to walk the manga folder on each request, which is
// untenable at 8 TB scale.
router.get('/manga/:id/info', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare(
    'SELECT id, path, bytes_on_disk, file_count FROM manga WHERE id = ?'
  ).get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const sizeBytes = manga.bytes_on_disk || 0;
  res.json({
    data: {
      path:       manga.path,
      file_count: manga.file_count || 0,
      size_mb:    Math.round((sizeBytes / (1024 * 1024)) * 100) / 100,
    },
  });
}));

// ── Genres ───────────────────────────────────────────────────────────────────
//
// GET /api/genres — every distinct genre across visible libraries plus a
// representative top-rated cover per genre. Powers the Browse By Genre page.
//
// The expensive cover-resolution sub-queries are NOT run on a TTL timer.
// Instead, the payload is built lazily on first request and then kept until
// the CBZ cache auto-clear scheduler fires `genresCache.precompute()` — so
// recomputation rides along with the user's existing maintenance cadence
// (off / daily / weekly, configured in Settings → Database). When auto-clear
// is off, the payload is pinned for the process lifetime by the user's
// explicit choice. See `server/src/genresCache.js`.
//
// Service-worker StaleWhileRevalidate + Cache-Control further mean the
// browser usually paints from disk without ever touching the server.
router.get('/genres', asyncWrapper(async (req, res) => {
  res.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=600');
  res.json({ data: genresCache.getPayload() });
}));

// ── Statistics ───────────────────────────────────────────────────────────────

// Keyed by library_id (null key = all libraries). Cleared every 5 minutes per
// slot. Keeping the cache at all because the genre aggregates walk json_each
// for every manga; caching keeps the Statistics page snappy when the user
// toggles between libraries.
const _statsCache = new Map(); // key -> { payload, ts }
const STATS_TTL_MS = 5 * 60 * 1000;

function cacheKey(userId, libraryId) {
  const lib = libraryId == null ? '__all__' : `lib:${libraryId}`;
  return `u:${userId}|${lib}`;
}

// GET /api/stats  —  optional ?library_id=N scopes every aggregate to one
// library; omit for All Libraries.
router.get('/stats', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  let libraryId = null;
  if (req.query.library_id !== undefined && req.query.library_id !== '') {
    const parsed = parseInt(req.query.library_id, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'library_id must be a positive integer' });
    }
    const exists = db.prepare('SELECT 1 FROM libraries WHERE id = ?').pluck().get(parsed);
    if (!exists) return res.status(404).json({ error: 'Library not found' });
    libraryId = parsed;
  }

  const key = cacheKey(userId, libraryId);
  const cached = _statsCache.get(key);
  const now = Date.now();
  if (cached && (now - cached.ts) < STATS_TTL_MS) {
    return res.json({ data: cached.payload });
  }

  // Every aggregate either filters on `m.library_id` directly or joins
  // through `manga` to do so. Building the JOIN + WHERE fragments once keeps
  // each query body consistent. In All-Libraries scope we exclude manga whose
  // library has `show_in_all = 0` — matching the visibility rule already
  // enforced for /api/library, /api/home, /api/genres, and /api/gallery — so
  // hiding a library from All Libraries hides it from these stats too.
  const libJoin   = libraryId == null
    ? 'LEFT JOIN libraries l ON l.id = m.library_id'
    : '';
  const libFilter = libraryId == null
    ? '(m.library_id IS NULL OR l.show_in_all = 1)'
    : 'm.library_id = ?';
  const libParams = libraryId == null ? [] : [libraryId];

  const { total_manga } = db.prepare(`
    SELECT COUNT(*) as total_manga
    FROM manga m
    ${libJoin}
    WHERE ${libFilter}
  `).get(...libParams);

  const { total_chapters } = db.prepare(`
    SELECT COUNT(*) as total_chapters
    FROM chapters c
    JOIN manga m ON m.id = c.manga_id
    ${libJoin}
    WHERE ${libFilter}
  `).get(...libParams);

  const { total_pages } = db.prepare(`
    SELECT COALESCE(SUM(c.page_count), 0) as total_pages
    FROM chapters c
    JOIN manga m ON m.id = c.manga_id
    ${libJoin}
    WHERE ${libFilter}
  `).get(...libParams);

  // Genre inventory — normalised `manga_genres` table keeps this cheap.
  const { total_genres } = db.prepare(`
    SELECT COUNT(DISTINCT g.genre COLLATE NOCASE) as total_genres
    FROM manga_genres g
    JOIN manga m ON m.id = g.manga_id
    ${libJoin}
    WHERE ${libFilter}
  `).get(...libParams);

  const top_genres = db.prepare(`
    SELECT g.genre as genre, COUNT(*) as count
    FROM manga_genres g
    JOIN manga m ON m.id = g.manga_id
    ${libJoin}
    WHERE ${libFilter}
    GROUP BY g.genre COLLATE NOCASE
    ORDER BY count DESC, g.genre ASC
    LIMIT 10
  `).all(...libParams).map(r => ({ genre: r.genre, count: r.count }));

  // Favorite Genres — ranking weighted by reading history. Each completed
  // chapter contributes one point to every genre tagged on its manga, so a
  // user who has read 40 chapters of a 3-genre manga adds 40 to each of
  // those three genres. Only manga with at least one completed chapter
  // contribute. Titles with no AniList/MAL/local metadata have no genres
  // and are naturally excluded.
  const favorite_genres = db.prepare(`
    SELECT g.genre as genre,
           SUM(json_array_length(p.completed_chapters)) as chapters_read
    FROM progress p
    JOIN manga m        ON m.id = p.manga_id
    JOIN manga_genres g ON g.manga_id = p.manga_id
    ${libJoin}
    WHERE p.user_id = ?
      AND json_array_length(p.completed_chapters) > 0
      AND ${libFilter}
    GROUP BY g.genre COLLATE NOCASE
    ORDER BY chapters_read DESC, g.genre ASC
    LIMIT 10
  `).all(userId, ...libParams).map(r => ({
    genre: r.genre,
    chapters_read: r.chapters_read,
  }));

  // Estimated read time via a single JOIN — no JS iteration over all chapters
  const { estimated_read_time_minutes } = db.prepare(`
    SELECT COALESCE(
      ROUND(SUM(COALESCE(c.page_count, 40) * 0.5)),
      0
    ) as estimated_read_time_minutes
    FROM progress p, json_each(p.completed_chapters) je
    JOIN chapters c ON c.id = CAST(je.value AS INTEGER)
    JOIN manga m    ON m.id = p.manga_id
    ${libJoin}
    WHERE p.user_id = ?
      AND ${libFilter}
  `).get(userId, ...libParams);

  // Popular manga — sorted by completed chapter count in SQL
  const top_manga = db.prepare(`
    SELECT p.manga_id as id, m.title, m.cover_image,
           json_array_length(p.completed_chapters) as chapters_read
    FROM progress p
    JOIN manga m ON m.id = p.manga_id
    ${libJoin}
    WHERE p.user_id = ?
      AND ${libFilter}
    ORDER BY chapters_read DESC
    LIMIT 10
  `).all(userId, ...libParams).map(r => ({
    id: r.id,
    title: r.title,
    cover_url: r.cover_image ? thumbnailUrl(r.cover_image) : null,
    chapters_read: r.chapters_read,
  }));

  // Total disk size is now a single SUM over cached per-manga values —
  // previously this walked every library, which doesn't scale past a few TB.
  const { total_size_bytes } = db.prepare(`
    SELECT COALESCE(SUM(m.bytes_on_disk), 0) as total_size_bytes
    FROM manga m
    ${libJoin}
    WHERE ${libFilter}
  `).get(...libParams);

  const payload = {
    library_id: libraryId,
    total_manga,
    total_chapters,
    total_pages,
    total_size_bytes,
    total_genres,
    estimated_read_time_minutes: Math.round(estimated_read_time_minutes || 0),
    top_genres,
    favorite_genres,
    top_manga,
  };
  _statsCache.set(key, { payload, ts: Date.now() });

  res.json({ data: payload });
}));

// ── Home page ────────────────────────────────────────────────────────────────
//
// Single aggregate endpoint that powers the Home landing page. Everything is
// scoped to libraries that are visible in the "All Libraries" view
// (`libraries.show_in_all = 1` or `manga.library_id IS NULL`) — a library
// hidden from All Libraries never surfaces on Home either.
//
// Response is cached in-memory with a short TTL (30 s) to absorb the rapid
// repeat-fetches caused by PWA prefetching, client-side StaleWhileRevalidate,
// and bfcache restores. All underlying queries hit indexed columns; cache is
// there to keep per-request cost ~0, not because any single query is slow.

const HOME_TTL_MS = 30 * 1000;
// Cache keyed by `min_score` since the per-genre ribbons are filtered by it
// and a single global cache would otherwise serve one device's threshold to
// another. 21 possible quantised score values × 30 s TTL keeps memory tiny.
const _homeCache = new Map(); // key (minScore string) -> { payload, ts }

// Caller-tunable limits, bounded to protect the server from pathological
// clients. The client only ever sends defaults right now; these exist so the
// endpoint remains safe if the client layer is ever swapped out.
const HOME_LIMITS = {
  continue:     { default: 15, max: 50 },
  discover:     { default: 30, max: 60 },
  gallery:      { default: 50, max: 100 },
  // Per-genre "Top Manga in X" ribbons return a candidate pool now (the
  // client picks a stable seeded-random ~15-item visible slice on the same
  // cadence as Discover), so the default size is bigger than the old 15.
  genreRibbons: { default: 50, max: 100 },
  recent:       { default: 15, max: 30 }, // recently added titles
};

// Default minimum AniList/MAL score for the per-genre ribbons. The user can
// override this from Settings → Homepage Settings; the value is sent in
// `min_score` and clamped to [0, 10] server-side.
const HOME_DEFAULT_MIN_SCORE = 7;

function clampLimit(q, cfg) {
  const n = parseInt(q, 10);
  if (!Number.isFinite(n) || n <= 0) return cfg.default;
  return Math.min(n, cfg.max);
}

function clampMinScore(q) {
  if (q === undefined || q === null || q === '') return HOME_DEFAULT_MIN_SCORE;
  const n = parseFloat(q);
  if (!Number.isFinite(n)) return HOME_DEFAULT_MIN_SCORE;
  return Math.max(0, Math.min(10, n));
}

// Generic helpers for the Discover-filter query params. The handler tolerates
// missing / malformed input by falling back to the supplied default — bad
// values from a stale client never cause a 500.
function clampScore(q, fallback) {
  if (q === undefined || q === null || q === '') return fallback;
  const n = parseFloat(q);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, n));
}
function clampInt(q, fallback, min, max) {
  if (q === undefined || q === null || q === '') return fallback;
  const n = parseInt(q, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function parseCsv(q) {
  if (typeof q !== 'string' || !q) return [];
  return q.split(',').map(s => s.trim()).filter(Boolean);
}
function parseCsvLower(q) {
  return parseCsv(q).map(s => s.toLowerCase());
}
function parseCsvInt(q) {
  return parseCsv(q)
    .map(s => parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n > 0);
}

// Short hash for the /api/home cache key. We include every filter param in
// the key, so a stable, collision-resistant digest keeps the string compact.
const _crypto = require('crypto');
function sha1Short(s) {
  return _crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// Drop a single user's /api/home cache slot(s). Called by the userPreferences
// PUT handler when a home-affecting key changes. Walks the small in-memory
// Map; cheap at any realistic size (one slot per (user × param-hash)).
function deleteHomeCacheForUser(userId) {
  const prefix = `u:${userId}|`;
  for (const k of _homeCache.keys()) {
    if (k.startsWith(prefix)) _homeCache.delete(k);
  }
}

// GET /api/home
router.get('/home', asyncWrapper(async (req, res) => {
  // Browser HTTP cache backs up the service worker's StaleWhileRevalidate.
  // Helps non-PWA tabs and incognito windows where the SW isn't active.
  res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=300');

  const userId = req.user.id;
  const minScore = clampMinScore(req.query.min_score);

  // Discover-ribbon filters. Every one of these is optional and falls back to
  // a "behave as before" default — a client that doesn't know about a given
  // param still gets today's behaviour.
  const discoverMinScore       = clampScore(req.query.discover_min_score, 0);
  const discoverExcludedGenres = parseCsvLower(req.query.discover_excluded_genres);
  const discoverMinMatchCount  = clampInt(req.query.discover_min_match_count, 1, 1, 4);
  const discoverLibraryIds     = parseCsvInt(req.query.discover_library_ids);
  const discoverSkipBookmarked = req.query.discover_skip_bookmarked === '1';
  const favoriteGenresOverride = parseCsv(req.query.favorite_genres);
  const genreRibbonCount       = clampInt(req.query.genre_ribbon_count, 4, 1, 4);
  const recentWindowHours      = clampInt(req.query.recent_window_hours, 0, 0, 24 * 365);

  const db = getDb();

  const limContinue = clampLimit(req.query.continue_limit, HOME_LIMITS.continue);
  const limDiscover = clampLimit(req.query.discover_limit, HOME_LIMITS.discover);
  const limGallery  = clampLimit(req.query.gallery_limit,  HOME_LIMITS.gallery);
  const limRibbon   = clampLimit(req.query.ribbon_limit,   HOME_LIMITS.genreRibbons);
  const limRecent   = clampLimit(req.query.recent_limit,   HOME_LIMITS.recent);

  // Cache key includes user_id + a hash of every param that affects the
  // payload. continue_reading / favorite genres / discover are all per-user,
  // so one user's Home must never be served to another; the param hash keeps
  // two clients with different Discover filters from colliding either.
  const cacheKey = `u:${userId}|` + sha1Short(JSON.stringify({
    minScore, discoverMinScore, discoverExcludedGenres, discoverMinMatchCount,
    discoverLibraryIds, discoverSkipBookmarked, favoriteGenresOverride,
    genreRibbonCount, recentWindowHours,
    limContinue, limDiscover, limGallery, limRibbon, limRecent,
  }));
  const now = Date.now();
  const cached = _homeCache.get(cacheKey);
  if (cached && (now - cached.ts) < HOME_TTL_MS) {
    return res.json({ data: cached.payload });
  }

  // ── Continue Reading ─────────────────────────────────────────────────────
  // Manga the user has opened, most-recent first. Joined to chapters so the
  // UI can show the label of the current chapter without a follow-up fetch.
  const continueReadingRows = db.prepare(`
    SELECT m.id, m.title, m.cover_image, m.track_volumes,
           p.current_chapter_id, p.current_page, p.last_read_at,
           c.number AS cur_number, c.volume AS cur_volume, c.folder_name AS cur_folder,
           c.page_count AS cur_page_count,
           (SELECT COUNT(*) FROM chapters ch WHERE ch.manga_id = m.id) AS total_chapters,
           json_array_length(p.completed_chapters) AS completed_count
    FROM progress p
    JOIN manga m ON m.id = p.manga_id
    LEFT JOIN libraries l ON l.id = m.library_id
    LEFT JOIN chapters c  ON c.id = p.current_chapter_id
    WHERE p.user_id = ?
      AND (m.library_id IS NULL OR l.show_in_all = 1)
    ORDER BY p.last_read_at DESC
    LIMIT ?
  `).all(userId, limContinue);

  const continue_reading = continueReadingRows.map(r => ({
    id:                r.id,
    title:             r.title,
    cover_url:         r.cover_image ? thumbnailUrl(r.cover_image) : null,
    track_volumes:     r.track_volumes,
    current_chapter_id: r.current_chapter_id,
    current_chapter: r.current_chapter_id ? {
      id:          r.current_chapter_id,
      folder_name: r.cur_folder,
      number:      r.cur_number,
      volume:      r.cur_volume,
      page_count:  r.cur_page_count,
    } : null,
    current_page:      r.current_page,
    total_chapters:    r.total_chapters,
    completed_count:   r.completed_count || 0,
    last_read_at:      r.last_read_at,
  }));

  // ── Favorite genres (scoped to visible libraries) ─────────────────────────
  // When the client passes a `favorite_genres` override (the user selected
  // Manual mode in Settings), skip the chapters-read derivation entirely and
  // use the supplied list. Capped at 4 to match the auto-derivation limit.
  let favoriteGenres;
  if (favoriteGenresOverride.length > 0) {
    favoriteGenres = favoriteGenresOverride.slice(0, 4);
  } else {
    const favoriteGenreRows = db.prepare(`
      SELECT g.genre AS genre,
             SUM(json_array_length(p.completed_chapters)) AS chapters_read
      FROM progress p
      JOIN manga m        ON m.id = p.manga_id
      JOIN manga_genres g ON g.manga_id = p.manga_id
      LEFT JOIN libraries l ON l.id = m.library_id
      WHERE p.user_id = ?
        AND json_array_length(p.completed_chapters) > 0
        AND (m.library_id IS NULL OR l.show_in_all = 1)
      GROUP BY g.genre COLLATE NOCASE
      ORDER BY chapters_read DESC, g.genre ASC
      LIMIT 4
    `).all(userId);
    favoriteGenres = favoriteGenreRows.map(r => r.genre);
  }

  // ── Discover New Series ──────────────────────────────────────────────────
  // Unread manga (no progress row, or a progress row with zero completed
  // chapters) tagged with at least one favorite genre. Ranked by match count
  // so a manga matching 3 of the top 4 genres ranks above one matching 1.
  // Unrated AniList/MAL score sinks to the bottom within each match-count
  // tier so the user sees scored picks first.
  //
  // Optional user-tunable filters layered on top:
  //   * discoverMinScore           — `m.score >= ?` (0 disables)
  //   * discoverExcludedGenres     — drop any manga tagged with a blacklisted
  //                                  genre, not just the genre row itself, so
  //                                  Action+Ecchi is removed wholesale when
  //                                  Ecchi is excluded
  //   * discoverLibraryIds         — restrict to a subset of libraries (also
  //                                  must still pass the show_in_all gate)
  //   * discoverSkipBookmarked     — exclude manga that already appear in any
  //                                  of the user's reading lists
  //   * discoverMinMatchCount      — HAVING-clause filter on the COUNT()
  let discover_candidates = [];
  if (favoriteGenres.length > 0) {
    const placeholders = favoriteGenres.map(() => '?').join(',');
    let extraWhere   = '';
    let havingClause = '';
    const extraParams = [];

    if (discoverMinScore > 0) {
      extraWhere += ' AND m.score >= ?';
      extraParams.push(discoverMinScore);
    }
    if (discoverLibraryIds.length > 0) {
      extraWhere += ` AND m.library_id IN (${discoverLibraryIds.map(() => '?').join(',')})`;
      extraParams.push(...discoverLibraryIds);
    }
    if (discoverExcludedGenres.length > 0) {
      const exPh = discoverExcludedGenres.map(() => '?').join(',');
      extraWhere += `
        AND m.id NOT IN (
          SELECT manga_id FROM manga_genres
          WHERE genre IN (${exPh}) COLLATE NOCASE
        )`;
      extraParams.push(...discoverExcludedGenres);
    }
    if (discoverSkipBookmarked) {
      extraWhere += `
        AND m.id NOT IN (
          SELECT manga_id FROM reading_list_manga
          WHERE list_id IN (SELECT id FROM reading_lists WHERE user_id = ?)
        )`;
      extraParams.push(userId);
    }
    if (discoverMinMatchCount > 1) {
      havingClause = ' HAVING match_count >= ?';
      extraParams.push(discoverMinMatchCount);
    }

    discover_candidates = db.prepare(`
      SELECT m.id, m.title, m.cover_image, m.score,
             COUNT(DISTINCT g.genre COLLATE NOCASE) AS match_count
      FROM manga m
      JOIN manga_genres g ON g.manga_id = m.id
      LEFT JOIN libraries l ON l.id = m.library_id
      LEFT JOIN progress p  ON p.manga_id = m.id AND p.user_id = ?
      WHERE (m.library_id IS NULL OR l.show_in_all = 1)
        AND (p.manga_id IS NULL
             OR p.completed_chapters IS NULL
             OR p.completed_chapters = '[]')
        AND g.genre IN (${placeholders}) COLLATE NOCASE
        ${extraWhere}
      GROUP BY m.id
      ${havingClause}
      ORDER BY match_count DESC, m.score DESC NULLS LAST, m.id ASC
      LIMIT ?
    `).all(userId, ...favoriteGenres, ...extraParams, limDiscover).map(r => ({
      id:          r.id,
      title:       r.title,
      cover_url:   r.cover_image ? thumbnailUrl(r.cover_image) : null,
      score:       r.score,
      match_count: r.match_count,
    }));
  }

  // ── Art Gallery ──────────────────────────────────────────────────────────
  const galleryRows = db.prepare(`
    SELECT ag.id, ag.manga_id, m.title AS manga_title, m.track_volumes,
           ag.chapter_id, c.folder_name AS chapter_folder,
           c.number AS chapter_number, c.volume AS chapter_volume,
           ag.page_id, pg.page_index, pg.width, pg.height, ag.created_at
    FROM art_gallery ag
    JOIN manga m    ON m.id = ag.manga_id
    JOIN chapters c ON c.id = ag.chapter_id
    JOIN pages pg   ON pg.id = ag.page_id
    LEFT JOIN libraries l ON l.id = m.library_id
    WHERE (m.library_id IS NULL OR l.show_in_all = 1)
    ORDER BY ag.created_at DESC
    LIMIT ?
  `).all(limGallery);

  const art_gallery = galleryRows.map(r => ({
    id:              r.id,
    manga_id:        r.manga_id,
    manga_title:     r.manga_title,
    track_volumes:   r.track_volumes,
    chapter_id:      r.chapter_id,
    chapter_folder_name: r.chapter_folder,
    chapter_number:  r.chapter_number,
    chapter_volume:  r.chapter_volume,
    page_id:         r.page_id,
    page_index:      r.page_index,
    // Natural pixel dimensions, so the home-page ribbon can render
    // landscape spreads at the correct aspect ratio (fullSize mode in
    // ArtGalleryRibbon). Same shape as /api/gallery/all returns.
    width:           r.width,
    height:          r.height,
    page_image_url:  `/api/pages/${r.page_id}/image`,
    created_at:      r.created_at,
  }));

  // ── Top Manga per Favorite Genre (up to 4 ribbons) ───────────────────────
  // Returns a *candidate pool* per genre. The client shuffles each pool with
  // the same seed that drives the Discover ribbon (XORed with a per-genre
  // hash so each ribbon rotates independently) and slices to the visible
  // window. This is why the query is filtered by score >= min_score and
  // ordered by id rather than score — randomisation happens client-side, so
  // the server only needs a deterministic, threshold-filtered candidate set.
  const topByGenreStmt = db.prepare(`
    SELECT m.id, m.title, m.cover_image, m.score
    FROM manga m
    JOIN manga_genres g ON g.manga_id = m.id
    LEFT JOIN libraries l ON l.id = m.library_id
    WHERE (m.library_id IS NULL OR l.show_in_all = 1)
      AND g.genre = ? COLLATE NOCASE
      AND m.score IS NOT NULL
      AND m.score >= ?
    ORDER BY m.id ASC
    LIMIT ?
  `);

  const favorite_genres_ribbons = favoriteGenres.slice(0, genreRibbonCount).map(genre => ({
    genre,
    manga: topByGenreStmt.all(genre, minScore, limRibbon).map(r => ({
      id:        r.id,
      title:     r.title,
      cover_url: r.cover_image ? thumbnailUrl(r.cover_image) : null,
      score:     r.score,
    })),
  })).filter(r => r.manga.length > 0);

  // ── Recently Added ───────────────────────────────────────────────────────
  // Newest manga rows by created_at, scoped to visible libraries. Surfaces
  // titles produced by the most recent scan without forcing a Library re-sort.
  // `recentWindowHours = 0` (default) keeps today's unbounded behaviour; a
  // positive value caps the ribbon to "added in the last N hours."
  const recentlyAddedRows = db.prepare(`
    SELECT m.id, m.title, m.cover_image, m.score, m.created_at
    FROM manga m
    LEFT JOIN libraries l ON l.id = m.library_id
    WHERE (m.library_id IS NULL OR l.show_in_all = 1)
      AND (? = 0 OR m.created_at >= unixepoch() - ? * 3600)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(recentWindowHours, recentWindowHours, limRecent);
  const recently_added = recentlyAddedRows.map(r => ({
    id:         r.id,
    title:      r.title,
    cover_url:  r.cover_image ? thumbnailUrl(r.cover_image) : null,
    score:      r.score,
    created_at: r.created_at,
  }));

  const payload = {
    continue_reading,
    discover_candidates,
    recently_added,
    art_gallery,
    favorite_genres_ribbons,
  };

  _homeCache.set(cacheKey, { payload, ts: Date.now() });

  res.json({ data: payload });
}));


/**
 * Translate a user-entered search string into a `{ clause, params }` pair that
 * slots into the WHERE of a library listing query.
 *
 * Semantics:
 *   - No comma (single term): title OR author whole-word match via manga_fts,
 *     OR exact genre match via manga_genres. "Yona" finds "Yona of the Dawn";
 *     "Daw" does not. "romance" finds manga tagged Romance.
 *   - Comma-separated: every term must match a genre exactly (AND). Matches
 *     the historical comma-list tag filter.
 *
 * FTS5 MATCH expression is built by stripping everything that isn't a letter,
 * number, or whitespace (neutralising FTS5 operators like *, ", -, : ) and
 * then phrase-quoting each surviving word and joining with AND. An empty
 * input — or one made entirely of punctuation — skips the FTS branch and
 * matches only against exact genre.
 */
function buildSearchClause(search) {
  if (!search) return { clause: '', params: [] };
  const terms = String(search).split(',').map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return { clause: '', params: [] };

  if (terms.length === 1) {
    const term = terms[0];
    const match = toFtsMatchQuery(term);
    if (!match) {
      return {
        clause: ` AND m.id IN (SELECT manga_id FROM manga_genres WHERE genre = ? COLLATE NOCASE)`,
        params: [term],
      };
    }
    return {
      clause: ` AND (
        m.id IN (SELECT rowid FROM manga_fts WHERE manga_fts MATCH ?)
        OR m.id IN (SELECT manga_id FROM manga_genres WHERE genre = ? COLLATE NOCASE)
      )`,
      params: [match, term],
    };
  }

  // Multi-term comma list: all terms must match a genre. Repeated subquery
  // pattern lets the optimizer hit the manga_genres PK once per term.
  const clause = terms.map(() =>
    ` AND m.id IN (SELECT manga_id FROM manga_genres WHERE genre = ? COLLATE NOCASE)`
  ).join('');
  return { clause, params: terms };
}

function toFtsMatchQuery(text) {
  const words = String(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map(w => `"${w}"`).join(' AND ');
}

module.exports = router;
// Cache invalidation hook used by routes/userPreferences.js when a
// home-affecting key changes. Kept on the module exports so the prefs route
// doesn't depend on the internal _homeCache Map directly.
module.exports.deleteHomeCacheForUser = deleteHomeCacheForUser;
