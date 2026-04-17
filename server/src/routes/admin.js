const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const config = require('../config');
const logger = require('../logger');
const { thumbnailPath, ensureShardDir } = require('../scanner/thumbnailPaths');
const { generateThumbnail } = require('../scanner/thumbnailGenerator');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Synchronously walk a directory and return total size in bytes. */
function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += dirSizeBytes(p);
    } else {
      try { total += fs.statSync(p).size; } catch { /* ignore */ }
    }
  }
  return total;
}

// ── CBZ Cache (legacy) ────────────────────────────────────────────────────────
// Streaming reads mean the extraction cache is no longer populated. These
// endpoints remain for the admin UI and as a way to wipe any pre-migration
// cache directory that may still be on disk.

// GET /api/admin/cbz-cache-size
router.get('/admin/cbz-cache-size', asyncWrapper(async (req, res) => {
  const size_bytes = dirSizeBytes(config.CBZ_CACHE_DIR);
  res.json({ data: { size_bytes, limit_bytes: 0 } });
}));

// POST /api/admin/clear-cbz-cache
router.post('/admin/clear-cbz-cache', asyncWrapper(async (req, res) => {
  let entries = [];
  try { entries = fs.readdirSync(config.CBZ_CACHE_DIR, { withFileTypes: true }); } catch { /* empty or missing */ }
  for (const e of entries) {
    const p = path.join(config.CBZ_CACHE_DIR, e.name);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log('[Admin] CBZ cache cleared');
  res.json({ data: { size_bytes: 0 } });
}));

// ── Thumbnail Regeneration ────────────────────────────────────────────────────

// POST /api/admin/regenerate-thumbnails
// Responds immediately; regeneration runs in the background.
// For each manga:
//   1. If anilist_cover file exists on disk → restore it as the active cover
//   2. Otherwise → regenerate from the first page of the first chapter
router.post('/admin/regenerate-thumbnails', asyncWrapper(async (req, res) => {
  const db = getDb();
  const allManga = db.prepare('SELECT id, anilist_cover FROM manga').all();

  res.json({ data: { message: 'Thumbnail regeneration started', total: allManga.length } });

  // Fire-and-forget background task
  ;(async () => {
    let regenerated = 0;
    let errors = 0;

    for (const manga of allManga) {
      try {
        const activeName = `${manga.id}.webp`;
        const activePath = thumbnailPath(activeName);
        ensureShardDir(activeName);

        // Prefer AniList cover if it exists on disk
        if (manga.anilist_cover) {
          const anilistPath = thumbnailPath(manga.anilist_cover);
          if (fs.existsSync(anilistPath)) {
            fs.copyFileSync(anilistPath, activePath);
            db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
              .run(`${manga.id}.webp`, manga.id);
            regenerated++;
            continue;
          }
        }

        // Fall back: generate from first page of first chapter. We need the
        // chapter type + path so `generateThumbnail` can stream from a CBZ
        // instead of treating the stored path as a filesystem location.
        const firstPage = db.prepare(`
          SELECT p.path AS stored_path, c.type AS chapter_type, c.path AS chapter_path
          FROM pages p
          JOIN chapters c ON c.id = p.chapter_id
          WHERE c.manga_id = ? AND p.page_index = 0
          ORDER BY COALESCE(c.number, c.volume) ASC NULLS LAST, c.folder_name ASC
          LIMIT 1
        `).get(manga.id);

        if (firstPage) {
          const source = firstPage.chapter_type === 'folder'
            ? firstPage.stored_path
            : { type: firstPage.chapter_type, chapterPath: firstPage.chapter_path, entry: firstPage.stored_path };

          const generated = await generateThumbnail(source, manga.id);
          if (generated) {
            db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
              .run(`${manga.id}.webp`, manga.id);
            regenerated++;
          }
        }
      } catch (err) {
        errors++;
        console.warn(`[Admin] Thumbnail regen error for manga ${manga.id}: ${err.message}`);
      }
    }

    console.log(
      `[Admin] Thumbnail regeneration complete: ` +
      `${regenerated} regenerated, ${errors} errors (${allManga.length} total)`
    );
  })();
}));

// ── Database Vacuum ───────────────────────────────────────────────────────────

// POST /api/admin/vacuum-db
// Runs VACUUM on the SQLite database to reclaim disk space from deleted rows.
// Returns the database file size before and after.
router.post('/admin/vacuum-db', asyncWrapper(async (req, res) => {
  const sizeBefore = (() => {
    try { return fs.statSync(config.DB_PATH).size; } catch { return 0; }
  })();

  const db = getDb();
  db.exec('VACUUM');

  const sizeAfter = (() => {
    try { return fs.statSync(config.DB_PATH).size; } catch { return 0; }
  })();

  console.log(
    `[Admin] Database vacuumed: ` +
    `${(sizeBefore / 1024 / 1024).toFixed(1)} MB → ${(sizeAfter / 1024 / 1024).toFixed(1)} MB`
  );
  res.json({ data: { size_before_bytes: sizeBefore, size_after_bytes: sizeAfter } });
}));

// ── System Logs ───────────────────────────────────────────────────────────────

// GET /api/admin/logs
// Returns the in-memory log buffer as JSON.
router.get('/admin/logs', asyncWrapper(async (req, res) => {
  res.json({ data: { entries: logger.getEntries(), max: logger.MAX_ENTRIES } });
}));

// GET /api/admin/logs/export
// Streams logs as a plain-text file download.
router.get('/admin/logs/export', asyncWrapper(async (req, res) => {
  const text = logger.formatAsText(logger.getEntries());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="momotaro-logs-${stamp}.txt"`);
  res.send(text);
}));

module.exports = router;
