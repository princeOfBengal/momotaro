const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db/database');
const { runFullScan, scanLibrary } = require('../scanner/libraryScanner');
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
  scanLibrary(library).catch(err => console.error('[Library] Scan error:', err.message));

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
    scanLibrary(updated).catch(err => console.error('[Library] Scan error after path change:', err.message));
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

  res.json({ message: 'Scan started' });
  scanLibrary(library).catch(err => console.error('[Scan] Error:', err.message));
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
      query += ` AND (m.title LIKE ? OR EXISTS (
        SELECT 1 FROM json_each(m.genres) WHERE LOWER(value) LIKE LOWER(?)
      ))`;
      params.push(`%${terms[0]}%`, `%${terms[0]}%`);
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
      cover_url: m.cover_image ? `/thumbnails/${m.cover_image}` : null,
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

// GET /api/library
router.get('/library', asyncWrapper(async (req, res) => {
  const db = getDb();
  const { search, status, sort = 'title', library_id } = req.query;

  let query = `SELECT m.* FROM manga m LEFT JOIN libraries l ON l.id = m.library_id WHERE 1=1`;
  const params = [];

  if (search) {
    const terms = search.split(',').map(t => t.trim()).filter(Boolean);
    if (terms.length === 1) {
      // Single term: title LIKE or genre LIKE (partial, case-insensitive)
      query += ` AND (m.title LIKE ? OR EXISTS (
        SELECT 1 FROM json_each(m.genres) WHERE LOWER(value) LIKE LOWER(?)
      ))`;
      params.push(`%${terms[0]}%`, `%${terms[0]}%`);
    } else {
      // Comma-separated: manga must have ALL listed genres (exact, case-insensitive)
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
    // All Libraries view: exclude libraries hidden from "All"
    query += ' AND (m.library_id IS NULL OR l.show_in_all = 1)';
  }

  const orderMap = { title: 'm.title ASC', updated: 'm.updated_at DESC', year: 'm.year DESC' };
  query += ` ORDER BY ${orderMap[sort] || 'm.title ASC'}`;

  const manga = db.prepare(query).all(...params);

  res.json({
    data: manga.map(m => ({
      ...m,
      genres: safeJsonParse(m.genres, []),
      cover_url: m.cover_image ? `/thumbnails/${m.cover_image}` : null,
    })),
  });
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
      cover_url: manga.cover_image ? `/thumbnails/${manga.cover_image}` : null,
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
    try { fs.unlinkSync(path.join(config.THUMBNAIL_DIR, manga.cover_image)); } catch (_) {}
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
  res.json({ message: 'Scan started' });
  runFullScan().catch(err => console.error('[Scan] Error:', err.message));
}));

// ── Statistics ───────────────────────────────────────────────────────────────

let _statsCache = null;
let _statsCacheTime = 0;

function getDirSizeSync(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          total += fs.statSync(full).size;
        } else if (entry.isDirectory()) {
          total += getDirSizeSync(full);
        }
      } catch {}
    }
  } catch {}
  return total;
}

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

  // Genre counts
  const genreCounts = {};
  for (const { genres } of db.prepare("SELECT genres FROM manga WHERE genres IS NOT NULL AND genres != '[]'").all()) {
    for (const g of safeJsonParse(genres, [])) {
      genreCounts[g] = (genreCounts[g] || 0) + 1;
    }
  }
  const total_genres = Object.keys(genreCounts).length;
  const top_genres = Object.entries(genreCounts)
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Estimated read time — build a chapter→page_count map then walk completed_chapters
  const chapterPages = {};
  for (const { id, page_count } of db.prepare('SELECT id, page_count FROM chapters').all()) {
    chapterPages[id] = page_count;
  }
  let estimated_read_time_minutes = 0;
  for (const { completed_chapters } of db.prepare('SELECT completed_chapters FROM progress').all()) {
    for (const chId of safeJsonParse(completed_chapters, [])) {
      estimated_read_time_minutes += (chapterPages[chId] || 40) * 0.5; // ~0.5 min/page
    }
  }

  // Popular manga (by completed chapters count)
  const top_manga = db.prepare(`
    SELECT p.manga_id as id, m.title, m.cover_image, p.completed_chapters
    FROM progress p
    JOIN manga m ON m.id = p.manga_id
  `).all()
    .map(r => ({
      id: r.id,
      title: r.title,
      cover_url: r.cover_image ? `/thumbnails/${r.cover_image}` : null,
      chapters_read: safeJsonParse(r.completed_chapters, []).length,
    }))
    .sort((a, b) => b.chapters_read - a.chapters_read)
    .slice(0, 10);

  // Total disk size (cached — may take a moment on first call)
  let total_size_bytes = 0;
  for (const { path: p } of db.prepare('SELECT path FROM manga WHERE path IS NOT NULL').all()) {
    total_size_bytes += getDirSizeSync(p);
  }

  _statsCache = {
    total_manga,
    total_chapters,
    total_pages,
    total_size_bytes,
    total_genres,
    estimated_read_time_minutes: Math.round(estimated_read_time_minutes),
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
