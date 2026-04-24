const express = require('express');
const fs = require('fs');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const config = require('../config');
const logger = require('../logger');
const { thumbnailPath, ensureShardDir } = require('../scanner/thumbnailPaths');
const { generateThumbnail } = require('../scanner/thumbnailGenerator');
const cbzCache = require('../scanner/cbzCache');
const cbzCacheSchedule = require('../scanner/cbzCacheSchedule');

const router = express.Router();

// Lower bound of 100 MB — smaller caps would force re-extraction mid-read of
// any chapter larger than the cap. Upper bound of 10 TB — a soft sanity check
// to catch fat-fingered byte counts.
const CACHE_LIMIT_MIN_BYTES = 100 * 1024 * 1024;
const CACHE_LIMIT_MAX_BYTES = 10 * 1024 * 1024 * 1024 * 1024;

const VALID_AUTOCLEAR_MODES = new Set(['off', 'daily', 'weekly']);

function upsertSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function readCacheSettings(db) {
  const rows = db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN (
      'cbz_cache_limit_bytes',
      'cbz_cache_autoclear_mode',
      'cbz_cache_autoclear_day',
      'cbz_cache_autoclear_time'
    )
  `).all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const parsedLimit = parseInt(map['cbz_cache_limit_bytes'] || '', 10);
  const parsedDay   = parseInt(map['cbz_cache_autoclear_day']  || '0', 10);
  return {
    limit_bytes:   Number.isFinite(parsedLimit) && parsedLimit > 0
                     ? parsedLimit
                     : cbzCache.DEFAULT_CACHE_LIMIT_BYTES,
    limit_default_bytes: cbzCache.DEFAULT_CACHE_LIMIT_BYTES,
    limit_min_bytes:     CACHE_LIMIT_MIN_BYTES,
    limit_max_bytes:     CACHE_LIMIT_MAX_BYTES,
    autoclear_mode: map['cbz_cache_autoclear_mode'] || 'off',
    autoclear_day:  Number.isInteger(parsedDay) && parsedDay >= 0 && parsedDay <= 6 ? parsedDay : 0,
    autoclear_time: map['cbz_cache_autoclear_time'] || '03:00',
    next_run_at:    cbzCacheSchedule.getNextRunAt(),
  };
}

// ── CBZ Cache ─────────────────────────────────────────────────────────────────
// CBZ pages are extracted to disk on first access and served as plain files on
// every subsequent hit. The cache is capped at 20 GB with LRU eviction; these
// endpoints expose the current size and a manual wipe.

// GET /api/admin/cbz-cache-size
router.get('/admin/cbz-cache-size', asyncWrapper(async (req, res) => {
  const { size_bytes, limit_bytes } = cbzCache.stats();
  res.json({ data: { size_bytes, limit_bytes } });
}));

// POST /api/admin/clear-cbz-cache
router.post('/admin/clear-cbz-cache', asyncWrapper(async (req, res) => {
  cbzCache.wipe();
  console.log('[Admin] CBZ cache cleared');
  res.json({ data: { size_bytes: 0 } });
}));

// GET /api/admin/cbz-cache-settings
router.get('/admin/cbz-cache-settings', asyncWrapper(async (req, res) => {
  const db = getDb();
  res.json({ data: readCacheSettings(db) });
}));

// PUT /api/admin/cbz-cache-settings
// Body (all fields optional — only provided fields are updated):
//   limit_bytes:     positive integer, bounded by MIN/MAX above
//   autoclear_mode:  'off' | 'daily' | 'weekly'
//   autoclear_day:   0..6  (0 = Sunday)  — only meaningful when mode=weekly
//   autoclear_time:  'HH:MM' 24-hour, server-local time
router.put('/admin/cbz-cache-settings', asyncWrapper(async (req, res) => {
  const db = getDb();
  const body = req.body || {};

  if (body.limit_bytes !== undefined) {
    const n = Number(body.limit_bytes);
    if (!Number.isFinite(n) || n < CACHE_LIMIT_MIN_BYTES) {
      return res.status(400).json({
        error: `limit_bytes must be at least ${CACHE_LIMIT_MIN_BYTES} bytes (100 MB)`,
      });
    }
    if (n > CACHE_LIMIT_MAX_BYTES) {
      return res.status(400).json({ error: 'limit_bytes exceeds 10 TB' });
    }
    const intBytes = Math.floor(n);
    upsertSetting(db, 'cbz_cache_limit_bytes', String(intBytes));
    cbzCache.setLimitBytes(intBytes);
  }

  if (body.autoclear_mode !== undefined) {
    if (!VALID_AUTOCLEAR_MODES.has(body.autoclear_mode)) {
      return res.status(400).json({ error: "autoclear_mode must be 'off', 'daily', or 'weekly'" });
    }
    upsertSetting(db, 'cbz_cache_autoclear_mode', body.autoclear_mode);
  }

  if (body.autoclear_day !== undefined) {
    const d = parseInt(body.autoclear_day, 10);
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      return res.status(400).json({ error: 'autoclear_day must be an integer 0..6 (0 = Sunday)' });
    }
    upsertSetting(db, 'cbz_cache_autoclear_day', String(d));
  }

  if (body.autoclear_time !== undefined) {
    const s = String(body.autoclear_time);
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return res.status(400).json({ error: 'autoclear_time must be HH:MM' });
    const h  = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) {
      return res.status(400).json({ error: 'autoclear_time out of range' });
    }
    // Canonicalise to zero-padded HH:MM.
    const canonical = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    upsertSetting(db, 'cbz_cache_autoclear_time', canonical);
  }

  cbzCacheSchedule.reschedule();
  res.json({ data: readCacheSettings(db) });
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

        // Fall back: generate from the first page of the first chapter. For
        // CBZ chapters we resolve the page through the cache — ensuring the
        // archive is extracted and then reading the first cache file. Folder
        // chapters hand the absolute path straight to sharp.
        const firstPage = db.prepare(`
          SELECT p.path AS stored_path, p.page_index, c.id AS chapter_id,
                 c.type AS chapter_type, c.path AS chapter_path
          FROM pages p
          JOIN chapters c ON c.id = p.chapter_id
          WHERE c.manga_id = ? AND p.page_index = 0
          ORDER BY COALESCE(c.number, c.volume) ASC NULLS LAST, c.folder_name ASC
          LIMIT 1
        `).get(manga.id);

        if (firstPage) {
          let source;
          if (firstPage.chapter_type === 'folder') {
            source = firstPage.stored_path;
          } else if (firstPage.chapter_type === 'cbz') {
            source = await cbzCache.getCbzPageFile(
              firstPage.chapter_id,
              firstPage.chapter_path,
              firstPage.page_index
            );
          }

          if (source) {
            const generated = await generateThumbnail(source, manga.id);
            if (generated) {
              db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
                .run(`${manga.id}.webp`, manga.id);
              regenerated++;
            }
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
