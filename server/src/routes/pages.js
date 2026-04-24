const express = require('express');
const path = require('path');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const cbzCache = require('../scanner/cbzCache');

const router = express.Router();

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

function mimeFor(name) {
  return MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
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

async function readImageDimensions(absPath) {
  try {
    const meta = await sharp(absPath).metadata();
    return { width: meta.width || null, height: meta.height || null };
  } catch {
    return { width: null, height: null };
  }
}

// Rewrite the pages rows for a CBZ chapter to match the extracted cache
// directory exactly. Runs once per fresh extraction (first open, or first
// open after an archive rewrite / eviction). Page dimensions are read
// concurrently via sharp since the files are already on disk.
async function rebuildCbzPageRows(db, chapterId, extractedPages, chapterDir) {
  const dims = await withLimit(
    4,
    extractedPages,
    p => readImageDimensions(path.join(chapterDir, p.cacheFilename))
  );
  const insert = db.prepare(`
    INSERT INTO pages (chapter_id, page_index, filename, path, width, height)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM pages WHERE chapter_id = ?').run(chapterId);
    extractedPages.forEach((p, i) => {
      insert.run(
        chapterId,
        i,
        p.originalName,
        p.cacheFilename,
        dims[i].width,
        dims[i].height
      );
    });
    db.prepare('UPDATE chapters SET page_count = ? WHERE id = ?')
      .run(extractedPages.length, chapterId);
  })();
}

// Resolve a page by id, returning everything the serving route needs to find
// the image on disk. CBZ pages live under the per-chapter cache directory
// (stored_path is the cache filename); folder pages store an absolute path.
// Queried fresh on every request — row IDs can shift when pages are rebuilt
// after a re-extraction, so caching by pageId is unsafe.
function lookupPageMeta(id) {
  const row = getDb().prepare(
    `SELECT p.path, p.chapter_id, c.type AS chapter_type, c.path AS chapter_path
     FROM pages p
     JOIN chapters c ON c.id = p.chapter_id
     WHERE p.id = ?`
  ).get(id);
  if (!row) return null;
  return {
    chapterId:   row.chapter_id,
    type:        row.chapter_type,
    chapterPath: row.chapter_path,
    storedPath:  row.path,
  };
}

// GET /api/chapters/:id/pages — list all pages for a chapter.
// CBZ chapters are fully extracted to cache on first open, then the pages
// rows are rebuilt from the resulting directory so order, dimensions, and
// on-disk filenames stay in lockstep.
router.get('/chapters/:id/pages', asyncWrapper(async (req, res) => {
  const db = getDb();
  const chapter = db.prepare('SELECT id, type, path FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

  if (chapter.type === 'cbz') {
    let extraction;
    try {
      extraction = await cbzCache.ensureChapterExtracted(chapter.id, chapter.path);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Archive file not found on disk' });
      }
      throw err;
    }

    if (extraction.freshlyExtracted) {
      await rebuildCbzPageRows(db, chapter.id, extraction.pages, extraction.dir);
    } else {
      // Existing rows may predate this cache layout (e.g. first run after the
      // extraction rewrite) or the cache may have been evicted and re-extracted
      // by a parallel request that didn't invalidate our rows. If the current
      // rows don't all point to files in the cache dir, rebuild from disk.
      const rows = db.prepare('SELECT path FROM pages WHERE chapter_id = ?').all(chapter.id);
      const diskFiles = require('fs').readdirSync(extraction.dir)
        .filter(f => f !== '.ready' && !f.endsWith('.tmp'));
      const diskSet = new Set(diskFiles);
      const mismatch = rows.length !== diskFiles.length ||
                       rows.some(r => !diskSet.has(r.path));
      if (mismatch) {
        diskFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        const pages = diskFiles.map(f => ({ cacheFilename: f, originalName: f }));
        await rebuildCbzPageRows(db, chapter.id, pages, extraction.dir);
      }
    }
  }

  const pages = db.prepare(
    'SELECT id, page_index, filename, path, width, height FROM pages WHERE chapter_id = ? ORDER BY page_index ASC'
  ).all(chapter.id);

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
// Folder chapters: sendFile straight from the stored absolute path.
// CBZ chapters: sendFile from the chapter's cache directory. If the cache has
// been evicted since the chapter was opened, re-extract on the fly.
router.get('/pages/:id/image', asyncWrapper(async (req, res, next) => {
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
        res.status(404).json({ error: 'Image file not found on disk' });
      } else {
        next(err);
      }
    });
    return;
  }

  if (meta.type === 'cbz') {
    let extraction;
    try {
      extraction = await cbzCache.ensureChapterExtracted(meta.chapterId, meta.chapterPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Archive file not found on disk' });
      }
      return next(err);
    }

    // If this request re-extracted the chapter (cache was evicted), the
    // pages rows on file still match because we write them once per unique
    // (chapterId, mtime) pair and the archive itself is unchanged.
    const abs = path.join(extraction.dir, meta.storedPath);
    res.sendFile(abs, {
      maxAge: 86_400_000,
      lastModified: true,
      etag: true,
      headers: { 'Content-Type': mimeFor(meta.storedPath) },
    }, (err) => {
      if (!err || res.headersSent) return;
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Image file not found on disk' });
      } else {
        next(err);
      }
    });
    return;
  }

  res.status(500).json({ error: `Unknown chapter type: ${meta.type}` });
}));

module.exports = router;
