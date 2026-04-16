const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const config = require('../config');

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

// ── CBZ Cache ─────────────────────────────────────────────────────────────────

// GET /api/admin/cbz-cache-size
router.get('/admin/cbz-cache-size', asyncWrapper(async (req, res) => {
  const size_bytes = dirSizeBytes(config.CBZ_CACHE_DIR);
  res.json({ data: { size_bytes } });
}));

// POST /api/admin/clear-cbz-cache
// Deletes all entries inside CBZ_CACHE_DIR (not the directory itself).
// Returns the new size (always 0 on success).
router.post('/admin/clear-cbz-cache', asyncWrapper(async (req, res) => {
  let entries = [];
  try { entries = fs.readdirSync(config.CBZ_CACHE_DIR, { withFileTypes: true }); } catch { /* empty dir or missing */ }
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
        const activePath = path.join(config.THUMBNAIL_DIR, `${manga.id}.webp`);

        // Prefer AniList cover if it exists on disk
        if (manga.anilist_cover) {
          const anilistPath = path.join(config.THUMBNAIL_DIR, manga.anilist_cover);
          if (fs.existsSync(anilistPath)) {
            fs.copyFileSync(anilistPath, activePath);
            db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
              .run(`${manga.id}.webp`, manga.id);
            regenerated++;
            continue;
          }
        }

        // Fall back: generate from first page of first chapter
        const firstPage = db.prepare(`
          SELECT p.path FROM pages p
          JOIN chapters c ON c.id = p.chapter_id
          WHERE c.manga_id = ? AND p.page_index = 0
          ORDER BY COALESCE(c.number, c.volume) ASC NULLS LAST, c.folder_name ASC
          LIMIT 1
        `).get(manga.id);

        if (firstPage && fs.existsSync(firstPage.path)) {
          await sharp(firstPage.path)
            .resize(300, 430, { fit: 'cover', position: 'top' })
            .webp({ quality: 85 })
            .toFile(activePath);
          db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
            .run(`${manga.id}.webp`, manga.id);
          regenerated++;
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

module.exports = router;
