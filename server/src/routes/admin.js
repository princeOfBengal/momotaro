const express = require('express');
const fs = require('fs');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const config = require('../config');
const logger = require('../logger');
const { thumbnailPath, ensureShardDir } = require('../scanner/thumbnailPaths');
const { generateThumbnail } = require('../scanner/thumbnailGenerator');
const { reinforceAllCovers } = require('../scanner/coverResolver');
const cbzCache = require('../scanner/cbzCache');
const cbzCacheSchedule = require('../scanner/cbzCacheSchedule');
const taskRegistry = require('../admin/taskRegistry');

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
// every subsequent hit. The cache is capped (default 20 GB) and auto-clears
// when an extraction pushes it over the cap — every cached chapter is wiped
// except the one that triggered the overflow, so the caller still gets a
// working file. These endpoints expose the current size and a manual wipe.

// GET /api/admin/cbz-cache-size
router.get('/admin/cbz-cache-size', asyncWrapper(async (req, res) => {
  const { size_bytes, limit_bytes } = cbzCache.stats();
  res.json({ data: { size_bytes, limit_bytes } });
}));

// POST /api/admin/clear-cbz-cache
//
// Returns 202 with the initial task state. The actual wipe runs in the
// background — `cbzCache.wipe()` is synchronous and iterates `fs.rmSync`
// across every cached chapter directory, which can take 30s+ on a 20 GB
// cache. Poll GET /api/admin/clear-cbz-cache/status for completion.
//
// 409 if a previous wipe is still running.
router.post('/admin/clear-cbz-cache', asyncWrapper(async (req, res) => {
  const result = taskRegistry.start('clear-cbz-cache', null, async () => {
    const before = cbzCache.stats().size_bytes;
    cbzCache.wipe();
    console.log('[Admin] CBZ cache cleared');
    return { size_bytes: 0, freed_bytes: before };
  });
  if (!result.ok) {
    return res.status(409).json({ error: 'Cache clear already in progress', status: result.state });
  }
  res.status(202).json({ data: { status: result.state } });
}));

router.get('/admin/clear-cbz-cache/status', asyncWrapper(async (req, res) => {
  res.json({ data: taskRegistry.get('clear-cbz-cache', null) });
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
//
// Returns 202 with the initial task state. The runner walks every manga
// and, for each one, restores the AniList cover from disk when available
// or generates a fresh thumbnail from the first page of the first chapter.
// Progress (i / N) is reported through the registry so the UI can show
// "Regenerated 242 / 1,847". 409 if a regeneration is already running.
//
// For each manga:
//   1. If anilist_cover file exists on disk → restore it as the active cover
//   2. Otherwise → regenerate from the first page of the first chapter
router.post('/admin/regenerate-thumbnails', asyncWrapper(async (req, res) => {
  const result = taskRegistry.start('regenerate-thumbnails', null, async (report) => {
    const db = getDb();
    const allManga = db.prepare('SELECT id, anilist_cover FROM manga').all();
    let regenerated = 0;
    let errors = 0;

    report(0, allManga.length, 'Starting…');

    for (let i = 0; i < allManga.length; i++) {
      const manga = allManga[i];
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
            report(i + 1, allManga.length, `Regenerated ${regenerated}, ${errors} errors`);
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
          // The CBZ cache auto-clears on overflow. The just-extracted chapter
          // is normally protected from that wipe, but a parallel reader (or
          // the auto-clear scheduler) could still wipe it between
          // getCbzPageFile() and sharp reading the file. Re-resolve and verify
          // the file is on disk; on a vanished source, re-extract once.
          let generated = null;
          for (let attempt = 0; attempt < 2 && !generated; attempt++) {
            let source;
            if (firstPage.chapter_type === 'folder') {
              source = firstPage.stored_path;
            } else if (firstPage.chapter_type === 'cbz') {
              source = await cbzCache.getCbzPageFile(
                firstPage.chapter_id,
                firstPage.chapter_path,
                firstPage.page_index
              );
              if (source && !fs.existsSync(source)) {
                if (attempt === 0) continue; // wiped mid-flight — retry
                source = null;
              }
            }
            if (!source) break;
            generated = await generateThumbnail(source, manga.id);
            if (!generated && firstPage.chapter_type === 'cbz' && attempt === 0
                && !fs.existsSync(source)) {
              // sharp failed because the cached file was wiped between resolve
              // and read — retry once with a fresh extraction.
              continue;
            }
          }

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
      report(i + 1, allManga.length, `Regenerated ${regenerated}, ${errors} errors`);
    }

    console.log(
      `[Admin] Thumbnail regeneration complete: ` +
      `${regenerated} regenerated, ${errors} errors (${allManga.length} total)`
    );
    return { regenerated, errors, total: allManga.length };
  });

  if (!result.ok) {
    return res.status(409).json({ error: 'Thumbnail regeneration already in progress', status: result.state });
  }
  res.status(202).json({ data: { status: result.state } });
}));

router.get('/admin/regenerate-thumbnails/status', asyncWrapper(async (req, res) => {
  res.json({ data: taskRegistry.get('regenerate-thumbnails', null) });
}));

// POST /api/admin/reset-thumbnails
//
// Override every manga's active cover with the highest-priority cover already
// on disk for that manga, in the order:
//
//   AniList > MyAnimeList > MangaUpdates > Doujinshi.info > original scan cover
//
// **Forces** even manga whose cover was manually picked back onto the priority
// rule — the per-manga `cover_user_set` flag is cleared. Manga with no source-
// specific cover at all are left as-is (the scan-generated original is the
// final fallback inside the priority list, so they get that automatically).
//
// Crucially, this never pings AniList / MAL / MangaUpdates / Doujinshi.info —
// it copies whichever source-specific files are already on disk from previous
// metadata fetches.
router.post('/admin/reset-thumbnails', asyncWrapper(async (req, res) => {
  const result = taskRegistry.start('reset-thumbnails', null, async () => {
    const db = getDb();
    console.log('[Admin] Reset Thumbnails: enforcing cover priority across the library (force=true).');
    const counters = reinforceAllCovers(db, { force: true });
    console.log(
      `[Admin] Reset Thumbnails complete: ` +
      `${counters.changed_to_anilist} → AniList, ` +
      `${counters.changed_to_mal} → MAL, ` +
      `${counters.changed_to_mu} → MangaUpdates, ` +
      `${counters.changed_to_doujinshi} → Doujinshi, ` +
      `${counters.changed_to_original} → original, ` +
      `${counters.kept_no_source} no source on disk, ` +
      `${counters.errors} errors (${counters.total} total)`
    );
    return counters;
  });
  if (!result.ok) {
    return res.status(409).json({ error: 'Reset thumbnails already in progress', status: result.state });
  }
  res.status(202).json({ data: { status: result.state } });
}));

router.get('/admin/reset-thumbnails/status', asyncWrapper(async (req, res) => {
  res.json({ data: taskRegistry.get('reset-thumbnails', null) });
}));

// ── Database Vacuum ───────────────────────────────────────────────────────────

// POST /api/admin/vacuum-db
//
// Runs VACUUM in the background and returns 202 with the initial task
// state. VACUUM holds an exclusive write lock for the duration of the
// rewrite (~10–30s on a multi-TB DB), so the actual work continues blocking
// other DB writers — but the HTTP request returns immediately, which is
// the user-visible fix. Poll GET /api/admin/vacuum-db/status for completion.
//
// This is the one task whose state is persisted to `admin_tasks` so that an
// operator who restarts the server thinking VACUUM is hung doesn't lose
// the answer to "did it actually run?" The on-startup reconciliation in
// taskRegistry.init() flips any 'running' row to 'interrupted'.
//
// 409 if a vacuum is already in progress.
router.post('/admin/vacuum-db', asyncWrapper(async (req, res) => {
  const result = taskRegistry.start('vacuum-db', null, async () => {
    const sizeBefore = (() => {
      try { return fs.statSync(config.DB_PATH).size; } catch { return 0; }
    })();
    getDb().exec('VACUUM');
    const sizeAfter = (() => {
      try { return fs.statSync(config.DB_PATH).size; } catch { return 0; }
    })();
    console.log(
      `[Admin] Database vacuumed: ` +
      `${(sizeBefore / 1024 / 1024).toFixed(1)} MB → ${(sizeAfter / 1024 / 1024).toFixed(1)} MB`
    );
    return { size_before_bytes: sizeBefore, size_after_bytes: sizeAfter };
  });
  if (!result.ok) {
    return res.status(409).json({ error: 'Vacuum already in progress', status: result.state });
  }
  res.status(202).json({ data: { status: result.state } });
}));

router.get('/admin/vacuum-db/status', asyncWrapper(async (req, res) => {
  res.json({ data: taskRegistry.get('vacuum-db', null) });
}));

// ── Series List Export ───────────────────────────────────────────────────────
//
// GET /api/admin/export-series-list
//
// Emits a CSV listing every series in the library with one row per manga
// and the following columns:
//
//   Library, Series Name (AniList), Series Name (MAL),
//   Series Name (MangaUpdates), Series Name (Doujinshi.info),
//   Folder path, Number of chapters, Number of volumes, Author
//
// Per-source title cells are read from the on-disk metadata cache at
// `data/metadata-cache/<source>/<id>.json` (the same cache the bulk
// export, scheduler, and break-linkage fallback use). When a manga has a
// source ID but the cache is missing, the cell is left empty — the user
// can refresh the linkage from MangaDetail to repopulate.
//
// Designed as a spot-check tool: the user opens the CSV, sorts by
// library, eyeballs the four source columns side by side, and catches
// titles that have drifted from the canonical (e.g. the AniList match
// pointing at the wrong series).

const { getCached: getCachedMetadata } = require('../metadata/cache');

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Always quote so embedded commas/newlines/quotes stay correct under
  // RFC 4180. Quote-doubling per the spec.
  return '"' + s.replace(/"/g, '""') + '"';
}

router.get('/admin/export-series-list', asyncWrapper(async (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.title, m.author, m.path, m.folder_name,
           m.anilist_id, m.mal_id, m.mangaupdates_id, m.doujinshi_id,
           l.name AS library_name,
           (
             SELECT COUNT(*) FROM chapters c
              WHERE c.manga_id = m.id
           ) AS chapter_count,
           (
             SELECT COUNT(DISTINCT c.volume) FROM chapters c
              WHERE c.manga_id = m.id AND c.volume IS NOT NULL
           ) AS volume_count
      FROM manga m
      LEFT JOIN libraries l ON l.id = m.library_id
     ORDER BY
       CASE WHEN l.name IS NULL THEN 1 ELSE 0 END,
       l.name COLLATE NOCASE ASC,
       m.title COLLATE NOCASE ASC
  `).all();

  // Header. The order here matches the spec exactly so the user can
  // diff columns side-by-side without column-juggling.
  const header = [
    'Library',
    'Series Name (AniList)',
    'Series Name (MAL)',
    'Series Name (MangaUpdates)',
    'Series Name (Doujinshi.info)',
    'Folder path',
    'Number of chapters',
    'Number of volumes',
    'Author',
  ];

  const lines = [header.map(csvEscape).join(',')];

  for (const r of rows) {
    const anilistTitle      = r.anilist_id      ? (getCachedMetadata('anilist',      r.anilist_id)?.title      || '') : '';
    const malTitle          = r.mal_id          ? (getCachedMetadata('myanimelist',  r.mal_id)?.title          || '') : '';
    const mangaupdatesTitle = r.mangaupdates_id ? (getCachedMetadata('mangaupdates', r.mangaupdates_id)?.title || '') : '';
    const doujinshiTitle    = r.doujinshi_id    ? (getCachedMetadata('doujinshi',    r.doujinshi_id)?.title    || '') : '';

    lines.push([
      r.library_name || '(no library)',
      anilistTitle,
      malTitle,
      mangaupdatesTitle,
      doujinshiTitle,
      r.path || '',
      r.chapter_count ?? 0,
      r.volume_count ?? 0,
      r.author || '',
    ].map(csvEscape).join(','));
  }

  // Excel and Google Sheets read UTF-8 cleanly when the BOM is present —
  // without it, non-ASCII titles (Japanese, French, etc.) render as
  // mojibake on Windows Excel. The BOM is invisible in proper UTF-8
  // readers.
  const body = '﻿' + lines.join('\r\n') + '\r\n';

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="momotaro-series-list-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}));

// ── Background tasks ──────────────────────────────────────────────────────────
//
// GET /api/admin/tasks/list
//
// Snapshot of every long-running admin action currently tracked in the
// in-process task registry (vacuum-db, clear-cbz-cache, reset-thumbnails,
// regenerate-thumbnails, optimize-manga:*, bulk-optimize-library:*).
// Used by the "what's running" UI banner so the operator can see what's
// happening even while navigating the rest of the app. Persisted history
// (admin_tasks rows from prior runs) is not included — that's a separate
// query if a history view is ever added.
router.get('/admin/tasks/list', asyncWrapper(async (req, res) => {
  res.json({ data: taskRegistry.list() });
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
