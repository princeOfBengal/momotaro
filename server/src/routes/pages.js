const express = require('express');
const path = require('path');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { openCbzEntryStream } = require('../scanner/chapterParser');

const router = express.Router();

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function readCbzEntryDimensions(cbzPath, entryName) {
  try {
    const stream = await openCbzEntryStream(cbzPath, entryName);
    const buf = await streamToBuffer(stream);
    const meta = await sharp(buf).metadata();
    return { width: meta.width || null, height: meta.height || null };
  } catch {
    return { width: null, height: null };
  }
}

// Run fn(item) for each item with at most `limit` calls in flight at once.
async function withLimit(limit, items, fn) {
  const results = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  async function worker() {
    while (queue.length) {
      const { item, i } = queue.shift();
      results[i] = await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
  const chapter = db.prepare('SELECT id, type, path FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

  let pages = db.prepare(
    'SELECT id, page_index, filename, path, width, height FROM pages WHERE chapter_id = ? ORDER BY page_index ASC'
  ).all(chapter.id);

  // CBZ chapters skip dimension fetching at scan time (would require
  // decompressing every entry). Lazily populate dimensions on first chapter
  // open so the reader can detect double-page spreads. One-time cost per CBZ
  // chapter — subsequent opens hit the persisted values.
  if (chapter.type === 'cbz') {
    const needDims = pages.filter(p => p.width === null || p.height === null);
    if (needDims.length > 0) {
      const dimsList = await withLimit(4, needDims, p => readCbzEntryDimensions(chapter.path, p.path));
      const updateStmt = db.prepare('UPDATE pages SET width = ?, height = ? WHERE id = ?');
      const tx = db.transaction((items, dims) => {
        items.forEach((p, i) => updateStmt.run(dims[i].width, dims[i].height, p.id));
      });
      tx(needDims, dimsList);
      needDims.forEach((p, i) => { p.width = dimsList[i].width; p.height = dimsList[i].height; });
    }
  }

  // A page is considered "wide" only when it's a true double-page spread —
  // i.e. its width is roughly 2× the typical page width in the chapter.
  // Comparing against the median width (rather than just width > height)
  // avoids treating mildly-landscape pages as spreads.
  const WIDE_FACTOR = 1.5;
  const sortedWidths = pages
    .map(p => p.width)
    .filter(w => w !== null && w > 0)
    .sort((a, b) => a - b);
  const medianWidth = sortedWidths.length > 0
    ? sortedWidths[Math.floor(sortedWidths.length / 2)]
    : null;

  res.json({
    data: pages.map(({ path: _path, ...rest }) => ({
      ...rest,
      is_wide: rest.width !== null && medianWidth !== null
        ? rest.width > medianWidth * WIDE_FACTOR
        : null,
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
