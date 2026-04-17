const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db/database');
const { runFullScan, scanLibrary, getScanStatus } = require('../scanner/libraryScanner');
const { thumbnailPath, thumbnailUrl } = require('../scanner/thumbnailPaths');
const { addLibraryWatch, removeLibraryWatch } = require('../watcher');
const { asyncWrapper } = require('../middleware/asyncWrapper');

const router = express.Router();

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
router.post('/libraries', asyncWrapper(async (req, res) => {
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
router.patch('/libraries/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const { name, path: newPath, show_in_all } = req.body;

  // Allow toggling show_in_all independently (no name required)
  if (show_in_all !== undefined && !name && !newPath) {
    db.prepare('UPDATE libraries SET show_in_all = ? WHERE id = ?')
      .run(show_in_all ? 1 : 0, library.id);
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
router.delete('/libraries/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  // Stop file watcher first
  await removeLibraryWatch(library.id);

  // ON DELETE SET NULL on manga.library_id — manually delete manga so cascade
  // removes chapters/pages/progress
  db.prepare('DELETE FROM manga WHERE library_id = ?').run(library.id);
  db.prepare('DELETE FROM libraries WHERE id = ?').run(library.id);

  res.json({ message: 'Library deleted' });
}));

// POST /api/libraries/:id/scan — scan a specific library
router.post('/libraries/:id/scan', asyncWrapper(async (req, res) => {
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

// GET /api/reading-lists — all lists with manga counts
router.get('/reading-lists', asyncWrapper(async (req, res) => {
  const db = getDb();
  const lists = db.prepare(`
    SELECT rl.*, COUNT(rlm.manga_id) as manga_count
    FROM reading_lists rl
    LEFT JOIN reading_list_manga rlm ON rlm.list_id = rl.id
    GROUP BY rl.id
    ORDER BY rl.is_default DESC, rl.name ASC
  `).all();
  res.json({ data: lists });
}));

// POST /api/reading-lists — create a custom list
router.post('/reading-lists', asyncWrapper(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO reading_lists (name, is_default) VALUES (?, 0)').run(name.trim());
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
  const list = db.prepare('SELECT * FROM reading_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Reading list not found' });
  if (list.is_default) return res.status(400).json({ error: 'Cannot delete a built-in reading list' });
  db.prepare('DELETE FROM reading_lists WHERE id = ?').run(list.id);
  res.json({ message: 'Deleted' });
}));

// GET /api/reading-lists/:id/manga — manga in a list (supports search & sort)
router.get('/reading-lists/:id/manga', asyncWrapper(async (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT id FROM reading_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Reading list not found' });

  const { search, sort = 'title' } = req.query;
  let query = `
    SELECT m.* FROM manga m
    INNER JOIN reading_list_manga rlm ON rlm.manga_id = m.id AND rlm.list_id = ?
    WHERE 1=1
  `;
  const params = [list.id];

  if (search) {
    const terms = search.split(',').map(t => t.trim()).filter(Boolean);
    if (terms.length === 1) {
      query += ` AND (m.title LIKE ? OR m.author LIKE ? OR EXISTS (
        SELECT 1 FROM json_each(m.genres) WHERE LOWER(value) LIKE LOWER(?)
      ))`;
      params.push(`%${terms[0]}%`, `%${terms[0]}%`, `%${terms[0]}%`);
    } else {
      for (const term of terms) {
        query += ` AND EXISTS (
          SELECT 1 FROM json_each(m.genres) WHERE LOWER(value) = LOWER(?)
        )`;
        params.push(term);
      }
    }
  }

  const orderMap = { title: 'm.title ASC', updated: 'm.updated_at DESC', year: 'm.year DESC', added: 'rlm.added_at DESC' };
  query += ` ORDER BY ${orderMap[sort] || 'm.title ASC'}`;

  const manga = db.prepare(query).all(...params);
  res.json({
    data: manga.map(m => ({
      ...m,
      genres: safeJsonParse(m.genres, []),
      cover_url: m.cover_image ? thumbnailUrl(m.cover_image) : null,
    })),
  });
}));

// POST /api/reading-lists/:id/manga — add manga to list
router.post('/reading-lists/:id/manga', asyncWrapper(async (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT id FROM reading_lists WHERE id = ?').get(req.params.id);
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
  db.prepare('DELETE FROM reading_list_manga WHERE list_id = ? AND manga_id = ?')
    .run(req.params.id, req.params.mangaId);
  res.json({ message: 'Removed' });
}));

// GET /api/manga/:id/reading-lists — which list IDs contain this manga
router.get('/manga/:id/reading-lists', asyncWrapper(async (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT list_id FROM reading_list_manga WHERE manga_id = ?').all(req.params.id);
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

  let query = `SELECT m.* FROM manga m LEFT JOIN libraries l ON l.id = m.library_id WHERE 1=1`;
  const params = [];

  if (search) {
    const terms = search.split(',').map(t => t.trim()).filter(Boolean);
    if (terms.length === 1) {
      query += ` AND (m.title LIKE ? OR m.author LIKE ? OR EXISTS (
        SELECT 1 FROM json_each(m.genres) WHERE LOWER(value) LIKE LOWER(?)
      ))`;
      params.push(`%${terms[0]}%`, `%${terms[0]}%`, `%${terms[0]}%`);
    } else {
      for (const term of terms) {
        query += ` AND EXISTS (
          SELECT 1 FROM json_each(m.genres) WHERE LOWER(value) = LOWER(?)
        )`;
        params.push(term);
      }
    }
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
    const orderMap = { year: 'm.year DESC' };
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
    data: manga.map(m => ({
      ...m,
      genres: safeJsonParse(m.genres, []),
      cover_url: m.cover_image ? thumbnailUrl(m.cover_image) : null,
    })),
  };
  if (limit !== null) {
    payload.next_cursor = nextCursor;
    payload.has_more    = hasMore;
  }

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

  const progress = db.prepare('SELECT * FROM progress WHERE manga_id = ?').get(manga.id);

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

// PATCH /api/manga/:id — update per-manga settings
router.patch('/manga/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { track_volumes } = req.body;
  if (track_volumes !== undefined) {
    db.prepare('UPDATE manga SET track_volumes = ?, updated_at = unixepoch() WHERE id = ?')
      .run(track_volumes ? 1 : 0, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  res.json({ data: { ...updated, genres: safeJsonParse(updated.genres, []) } });
}));

// DELETE /api/manga/:id — remove manga from DB and delete its files on disk
router.delete('/manga/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  // Collect chapter IDs before the cascade delete clears them
  const chapters = db.prepare('SELECT id FROM chapters WHERE manga_id = ?').all(manga.id);

  // Remove from DB — CASCADE deletes chapters, pages, progress
  db.prepare('DELETE FROM manga WHERE id = ?').run(manga.id);

  // Delete thumbnail
  if (manga.cover_image) {
    try { fs.unlinkSync(thumbnailPath(manga.cover_image)); } catch (_) {}
  }

  // Delete CBZ cache for every chapter
  for (const ch of chapters) {
    try {
      fs.rmSync(path.join(config.CBZ_CACHE_DIR, String(ch.id)), { recursive: true, force: true });
    } catch (_) {}
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
router.post('/scan', asyncWrapper(async (req, res) => {
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

// ── Statistics ───────────────────────────────────────────────────────────────

let _statsCache = null;
let _statsCacheTime = 0;

// GET /api/stats
router.get('/stats', asyncWrapper(async (req, res) => {
  const now = Date.now();
  if (_statsCache && (now - _statsCacheTime) < 5 * 60 * 1000) {
    return res.json({ data: _statsCache });
  }

  const db = getDb();

  const { total_manga }    = db.prepare('SELECT COUNT(*) as total_manga FROM manga').get();
  const { total_chapters } = db.prepare('SELECT COUNT(*) as total_chapters FROM chapters').get();
  const { total_pages }    = db.prepare('SELECT COALESCE(SUM(page_count), 0) as total_pages FROM chapters').get();

  // Genre counts — aggregated in SQLite via json_each
  const { total_genres } = db.prepare(`
    SELECT COUNT(DISTINCT value) as total_genres
    FROM manga, json_each(manga.genres)
    WHERE manga.genres IS NOT NULL AND manga.genres != '[]'
  `).get();
  const top_genres = db.prepare(`
    SELECT value as genre, COUNT(*) as count
    FROM manga, json_each(manga.genres)
    WHERE manga.genres IS NOT NULL AND manga.genres != '[]'
    GROUP BY value
    ORDER BY count DESC
    LIMIT 10
  `).all().map(r => ({ genre: r.genre, count: r.count }));

  // Estimated read time via a single JOIN — no JS iteration over all chapters
  const { estimated_read_time_minutes } = db.prepare(`
    SELECT COALESCE(
      ROUND(SUM(COALESCE(c.page_count, 40) * 0.5)),
      0
    ) as estimated_read_time_minutes
    FROM progress p, json_each(p.completed_chapters) je
    JOIN chapters c ON c.id = CAST(je.value AS INTEGER)
  `).get();

  // Popular manga — sorted by completed chapter count in SQL
  const top_manga = db.prepare(`
    SELECT p.manga_id as id, m.title, m.cover_image,
           json_array_length(p.completed_chapters) as chapters_read
    FROM progress p
    JOIN manga m ON m.id = p.manga_id
    ORDER BY chapters_read DESC
    LIMIT 10
  `).all().map(r => ({
    id: r.id,
    title: r.title,
    cover_url: r.cover_image ? thumbnailUrl(r.cover_image) : null,
    chapters_read: r.chapters_read,
  }));

  // Total disk size is now a single SUM over cached per-manga values —
  // previously this walked every library, which doesn't scale past a few TB.
  const { total_size_bytes } = db.prepare(
    'SELECT COALESCE(SUM(bytes_on_disk), 0) as total_size_bytes FROM manga'
  ).get();

  _statsCache = {
    total_manga,
    total_chapters,
    total_pages,
    total_size_bytes,
    total_genres,
    estimated_read_time_minutes: Math.round(estimated_read_time_minutes || 0),
    top_genres,
    top_manga,
  };
  _statsCacheTime = Date.now();

  res.json({ data: _statsCache });
}));


function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
