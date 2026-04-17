const express = require('express');
const path = require('path');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { openCbzEntryStream } = require('../scanner/chapterParser');

const router = express.Router();

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

/**
 * Bounded LRU: pageId → { type, chapterPath, storedPath }.
 *
 * Semantics of `storedPath` depend on `type`:
 *   - folder → absolute filesystem path (what `sendFile` wants)
 *   - cbz    → ZIP entry name inside `chapterPath` (what yauzl needs)
 *
 * Cache only goes stale when a rescan replaces rows with new IDs (in which
 * case nothing points at the old ID) or when the underlying file vanishes
 * (we evict on the resulting error below).
 */
const PAGE_PATH_CACHE_MAX = 10_000;
const pagePathCache = new Map();

function lookupPageMeta(id) {
  const hit = pagePathCache.get(id);
  if (hit !== undefined) {
    pagePathCache.delete(id);
    pagePathCache.set(id, hit);
    return hit;
  }
  const row = getDb().prepare(
    `SELECT p.path, c.type AS chapter_type, c.path AS chapter_path
     FROM pages p
     JOIN chapters c ON c.id = p.chapter_id
     WHERE p.id = ?`
  ).get(id);
  if (!row) return null;
  const entry = {
    type:        row.chapter_type,
    chapterPath: row.chapter_path,
    storedPath:  row.path,
  };
  pagePathCache.set(id, entry);
  if (pagePathCache.size > PAGE_PATH_CACHE_MAX) {
    pagePathCache.delete(pagePathCache.keys().next().value);
  }
  return entry;
}

function mimeFor(name) {
  return MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// GET /api/chapters/:id/pages — list all pages for a chapter
router.get('/chapters/:id/pages', asyncWrapper(async (req, res) => {
  const db = getDb();
  const chapter = db.prepare('SELECT id FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

  const pages = db.prepare(
    'SELECT id, page_index, filename, width, height FROM pages WHERE chapter_id = ? ORDER BY page_index ASC'
  ).all(chapter.id);

  res.json({
    data: pages.map(p => ({
      ...p,
      is_wide: p.width !== null && p.height !== null ? p.width > p.height : null,
    })),
  });
}));

// GET /api/pages/:id/image — serve a page image.
// Folder chapters: sendFile from disk.
// CBZ chapters: open the archive and pipe the entry stream straight through.
router.get('/pages/:id/image', (req, res, next) => {
  const meta = lookupPageMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Page not found' });

  if (meta.type === 'folder') {
    res.sendFile(meta.storedPath, {
      maxAge: 86_400_000,
      lastModified: true,
      etag: true,
      headers: { 'Content-Type': mimeFor(meta.storedPath) },
    }, (err) => {
      if (!err || res.headersSent) return;
      if (err.code === 'ENOENT') {
        pagePathCache.delete(req.params.id);
        res.status(404).json({ error: 'Image file not found on disk' });
      } else {
        next(err);
      }
    });
    return;
  }

  if (meta.type === 'cbz') {
    openCbzEntryStream(meta.chapterPath, meta.storedPath).then((stream) => {
      res.setHeader('Content-Type', mimeFor(meta.storedPath));
      // Archive contents are immutable for an unchanged CBZ; the scanner bumps
      // page row IDs on mtime change, so caching by URL is safe.
      res.setHeader('Cache-Control', 'public, max-age=86400');
      stream.on('error', (err) => {
        if (!res.headersSent) next(err);
        else res.destroy(err);
      });
      stream.pipe(res);
    }).catch((err) => {
      pagePathCache.delete(req.params.id);
      if (err && err.message && err.message.startsWith('Entry not found')) {
        return res.status(404).json({ error: 'Image entry not found in archive' });
      }
      if (err && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Archive file not found on disk' });
      }
      next(err);
    });
    return;
  }

  res.status(500).json({ error: `Unknown chapter type: ${meta.type}` });
});

module.exports = router;
