const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const { getDb } = require('../db/database');
const { getSource } = require('../sources');
// `scanMangaDirectory` is lazily required inside runJob() instead of at the
// top because there's a load-order cycle: libraryScanner → routes/metadata
// → routes/settings → downloader/queue. A top-level destructure here
// captures `module.exports` of libraryScanner *before* it has reached its
// own module.exports = {...} line, leaving `scanMangaDirectory` permanently
// undefined and surfacing as "scanMangaDirectory is not a function" in the
// post-download rescan.

// Background downloader for the Third Party Sourcing feature.
//
// One in-process FIFO. `MAX_CONCURRENT_CHAPTERS` workers pop the oldest
// 'queued' job, fetch it from its source, write a CBZ into the destination
// folder, then re-scan that single manga directory so the new chapter is
// indexed. Settings (concurrency + per-page delay) come from the SQLite
// `settings` table and can be hot-reloaded via `applySettings`.
//
// Persistence: jobs live in `download_jobs`. The queue rehydrates from
// `status='queued'` and `status='running'` (treated as queued) on startup, so
// a kill mid-download doesn't lose anything except the bytes of the
// currently-active chapter.

const DEFAULTS = {
  max_concurrent: 1,
  page_delay_ms:  500,
};

const SETTING_KEYS = {
  CONCURRENCY: 'tps_max_concurrent_chapters',
  PAGE_DELAY:  'tps_page_delay_ms',
};

let _settings = { ...DEFAULTS };
let _activeWorkers = 0;
let _initialized = false;
// Maps source-chapter-id → AbortController so a cancel from the API can stop
// in-flight image downloads. Workers also re-check job status between pages.
const _inflight = new Map();

// ── Settings I/O ────────────────────────────────────────────────────────────

function loadSettings(db) {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (?, ?)`
  ).all(SETTING_KEYS.CONCURRENCY, SETTING_KEYS.PAGE_DELAY);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const conc  = parseInt(map[SETTING_KEYS.CONCURRENCY], 10);
  const delay = parseInt(map[SETTING_KEYS.PAGE_DELAY],  10);

  _settings = {
    max_concurrent: Number.isFinite(conc)  && conc  >= 1 && conc  <= 8       ? conc  : DEFAULTS.max_concurrent,
    page_delay_ms:  Number.isFinite(delay) && delay >= 0 && delay <= 60_000  ? delay : DEFAULTS.page_delay_ms,
  };
}

function getSettings() {
  return { ..._settings };
}

/**
 * Hot-reload settings from the DB. Called by the Settings PUT route after a
 * user change so the new concurrency takes effect on the next pump tick
 * without a server restart.
 */
function applySettings() {
  loadSettings(getDb());
  // Spin up additional workers if concurrency was raised.
  pump();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ILLEGAL_FS_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

function sanitizeFilename(name, fallback = 'untitled') {
  if (!name) return fallback;
  const cleaned = String(name)
    .replace(ILLEGAL_FS_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '') // no leading dots — Windows reserves these
    .trim();
  // Windows reserved device names. Add an underscore suffix if the basename
  // matches; the user can rename later.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return cleaned + '_';
  }
  return cleaned.slice(0, 200) || fallback;
}

function pad(n, width = 4) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  // Preserve fractional chapter numbers (e.g. 23.5) — pad only the integer part.
  const isInt = Number.isInteger(n);
  if (isInt) return String(n).padStart(width, '0');
  const [intPart, fracPart] = String(n).split('.');
  return intPart.padStart(width, '0') + '.' + fracPart;
}

/**
 * Build a CBZ filename from chapter metadata. Handles all four
 * volume/chapter/title permutations and sanitizes the result.
 */
function buildChapterFilename({ volume, number, title }) {
  const parts = [];
  if (volume !== null && volume !== undefined) parts.push(`Vol. ${pad(volume, 2)}`);
  if (number !== null && number !== undefined) parts.push(`Ch. ${pad(number, 4)}`);
  if (parts.length === 0 && title) parts.push(title);
  if (parts.length === 0) parts.push('Chapter');
  let base = parts.join(' ');
  if (title && (number !== null || volume !== null)) {
    const cleanTitle = sanitizeFilename(title, '');
    if (cleanTitle) base += ` - ${cleanTitle}`;
  }
  return sanitizeFilename(base) + '.cbz';
}

function extFromContentType(ct, fallbackUrl) {
  if (ct) {
    if (ct.includes('jpeg')) return '.jpg';
    if (ct.includes('png'))  return '.png';
    if (ct.includes('webp')) return '.webp';
    if (ct.includes('gif'))  return '.gif';
  }
  // Fall back to the URL extension. MangaDex@Home always serves .jpg/.png/.webp.
  const m = String(fallbackUrl || '').match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i);
  if (m) return '.' + m[1].toLowerCase();
  return '.jpg';
}

async function fetchImage(url, { signal, userAgent }) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': userAgent, 'Accept': 'image/*' },
    signal,
  });
  if (!resp.ok) {
    throw new Error(`Image ${resp.status} for ${url}`);
  }
  return {
    buffer: await resp.buffer(),
    ext:    extFromContentType(resp.headers.get('content-type'), url),
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Target resolution ───────────────────────────────────────────────────────

/**
 * Resolve where a job's CBZ should land on disk. Returns
 * { folder, isNewSeries, libraryId, mangaId? }. Mode='new' creates the manga
 * folder if it doesn't already exist; mode='existing' reads the path off the
 * pre-existing manga row.
 *
 * Throws (and the worker marks the job 'failed') if the target is unresolvable
 * — e.g. the user picked a manga that's since been deleted.
 */
function resolveTarget(db, job) {
  if (job.target_mode === 'existing') {
    if (!job.target_manga_id) throw new Error('existing target requires target_manga_id');
    const manga = db.prepare('SELECT id, path, library_id FROM manga WHERE id = ?').get(job.target_manga_id);
    if (!manga) throw new Error(`Target manga ${job.target_manga_id} no longer exists`);
    if (!manga.path || !fs.existsSync(manga.path)) {
      throw new Error(`Target manga folder no longer exists: ${manga.path}`);
    }
    return { folder: manga.path, isNewSeries: false, libraryId: manga.library_id, mangaId: manga.id };
  }

  // mode === 'new'
  if (!job.target_library_id) throw new Error('new target requires target_library_id');
  if (!job.target_folder_name) throw new Error('new target requires target_folder_name');
  const library = db.prepare('SELECT id, path FROM libraries WHERE id = ?').get(job.target_library_id);
  if (!library) throw new Error(`Target library ${job.target_library_id} no longer exists`);
  const folder = path.join(library.path, job.target_folder_name);
  fs.mkdirSync(folder, { recursive: true });
  return { folder, isNewSeries: true, libraryId: library.id };
}

/**
 * Record the source URL + linkage for the manga row at `mangaPath`. Called by
 * the worker after a fresh manga has been rescanned in (mode='new'), so the
 * next download against the same source — and the future scheduler — can find
 * the URL.
 *
 * Also bumps `last_used_at` on the URL row, so the future scheduler can pace
 * its re-checks by recency-of-download. Idempotent — relies on the UNIQUE
 * (manga_id, url) constraint.
 */
function recordSourceUrlForPath(db, source, sourceSeriesId, sourceSeriesTitle, mangaPath) {
  if (!source || !sourceSeriesId || !mangaPath) return;
  const row = db.prepare('SELECT id FROM manga WHERE path = ?').get(mangaPath);
  if (!row) return;

  let url;
  try {
    url = require('../sources/urlParser').buildUrl(source, sourceSeriesId);
  } catch { return; }
  if (!url) return;

  const sourcesRoutes = require('../routes/sources');
  sourcesRoutes.upsertSourceUrl(db, {
    manga_id:  row.id,
    source,
    source_id: sourceSeriesId,
    url,
    label:     sourceSeriesTitle || null,
  });
  db.prepare(`UPDATE manga_source_urls SET last_used_at = unixepoch() WHERE manga_id = ? AND url = ?`)
    .run(row.id, url);
  sourcesRoutes.syncDenormalizedLinkage(db, row.id, source);
}

/**
 * Touch `last_used_at` on the URL row for an already-linked manga (mode=
 * existing flow). Lets the scheduler pace future re-checks against the most
 * recently used URL even when no new URL is being recorded.
 */
function touchSourceUrlForManga(db, mangaId, source, sourceSeriesId) {
  if (!mangaId || !source || !sourceSeriesId) return;
  let url;
  try {
    url = require('../sources/urlParser').buildUrl(source, sourceSeriesId);
  } catch { return; }
  if (!url) return;
  db.prepare(
    `UPDATE manga_source_urls SET last_used_at = unixepoch()
      WHERE manga_id = ? AND url = ?`
  ).run(mangaId, url);
}

function sourceColumn(source) {
  switch (source) {
    case 'mangadex':     return 'mangadex_id';
    case 'comixto':      return 'comixto_id';
    case 'mangakakalot': return 'mangakakalot_id';
    case 'mangafire':    return 'mangafire_id';
    case 'weebcentral':  return 'weebcentral_id';
    case 'mangaball':    return 'mangaball_id';
    default:             return null;
  }
}

// ── Worker ──────────────────────────────────────────────────────────────────

function pickNextJob(db) {
  // Atomic pick: status='queued' → 'running' in one statement so two workers
  // can't claim the same row. Returns the updated row (RETURNING is supported
  // by sqlite ≥ 3.35 / better-sqlite3 ≥ 8).
  const job = db.prepare(`
    UPDATE download_jobs
       SET status     = 'running',
           started_at = COALESCE(started_at, unixepoch())
     WHERE id = (
       SELECT id FROM download_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
     )
     RETURNING *
  `).get();
  return job || null;
}

async function runJob(job) {
  const db = getDb();
  const source = getSource(job.source);
  const controller = new AbortController();
  _inflight.set(job.id, controller);

  try {
    const target = resolveTarget(db, job);
    const filename = job.target_chapter_filename || buildChapterFilename({
      volume: job.chapter_volume,
      number: job.chapter_number,
      title:  job.chapter_title,
    });
    const cbzPath = path.join(target.folder, filename);
    const tmpPath = cbzPath + '.tmp';

    // Don't re-download an existing file. The user can delete it manually if
    // they want a fresh copy; this protects against re-runs of the same job.
    if (fs.existsSync(cbzPath)) {
      db.prepare(
        `UPDATE download_jobs
            SET status = 'done', finished_at = unixepoch(),
                target_chapter_filename = COALESCE(target_chapter_filename, ?)
          WHERE id = ?`
      ).run(filename, job.id);
      return;
    }

    const imgs = await source.getChapterImages(job.source_chapter_id);
    const urls = imgs.files;
    if (!urls || urls.length === 0) {
      throw new Error('No image URLs returned by source');
    }

    db.prepare(
      `UPDATE download_jobs SET pages_total = ?, target_chapter_filename = ? WHERE id = ?`
    ).run(urls.length, filename, job.id);

    const zip = new AdmZip();
    const padWidth = String(urls.length).length;

    for (let i = 0; i < urls.length; i++) {
      // Re-check the job hasn't been cancelled between pages.
      const fresh = db.prepare('SELECT status FROM download_jobs WHERE id = ?').pluck().get(job.id);
      if (fresh === 'cancelled') {
        throw Object.assign(new Error('Cancelled by user'), { _cancelled: true });
      }

      const { buffer, ext } = await fetchImage(urls[i], {
        signal:    controller.signal,
        userAgent: source.USER_AGENT,
      });
      const entryName = String(i + 1).padStart(padWidth, '0') + ext;
      zip.addFile(entryName, buffer);

      db.prepare('UPDATE download_jobs SET pages_downloaded = ? WHERE id = ?')
        .run(i + 1, job.id);

      if (_settings.page_delay_ms > 0 && i < urls.length - 1) {
        await sleep(_settings.page_delay_ms);
      }
    }

    // Atomic write: build the .tmp then rename. The chokidar watcher only
    // sees the final filename; the partial file never gets indexed.
    zip.writeZip(tmpPath);
    fs.renameSync(tmpPath, cbzPath);

    // Re-scan ONLY the destination manga folder (not the whole library) so
    // the new chapter is indexed and viewable immediately. scanMangaDirectory
    // is the per-folder entry point — it walks just `mangaPath`, upserts the
    // manga row, indexes the new chapters, generates the cover thumbnail if
    // missing, and returns. A full library scan would be wasteful here.
    //
    // Lazy-required (see top-of-file comment) to dodge the libraryScanner ↔
    // routes/metadata ↔ routes/settings ↔ downloader cycle.
    try {
      const { scanMangaDirectory } = require('../scanner/libraryScanner');
      const mangaPath = target.folder;
      const folderName = path.basename(mangaPath);
      await scanMangaDirectory(mangaPath, folderName, target.libraryId);
      // Now that the manga row exists, persist the URL + linkage so future
      // runs (and the scheduler, when it lands) can find this series. For
      // mode='existing' the URL was already recorded by the route handler;
      // we just bump last_used_at so recency-of-download stays current.
      if (target.isNewSeries) {
        recordSourceUrlForPath(db, job.source, job.source_series_id, job.source_series_title, mangaPath);
      } else if (target.mangaId) {
        touchSourceUrlForManga(db, target.mangaId, job.source, job.source_series_id);
      }
    } catch (err) {
      console.warn(`[Downloader] Post-download rescan failed for ${target.folder}: ${err.message}`);
    }

    db.prepare(`
      UPDATE download_jobs
         SET status = 'done', finished_at = unixepoch(), error = NULL
       WHERE id = ?
    `).run(job.id);
  } catch (err) {
    const cancelled = err._cancelled || err.name === 'AbortError';
    db.prepare(`
      UPDATE download_jobs
         SET status      = ?,
             finished_at = unixepoch(),
             error       = ?
       WHERE id = ?
    `).run(cancelled ? 'cancelled' : 'failed', err.message.slice(0, 500), job.id);
    if (!cancelled) {
      console.error(`[Downloader] Job ${job.id} failed: ${err.message}`);
    }
  } finally {
    _inflight.delete(job.id);
  }
}

// Pump: while there's room and there are queued jobs, spin up workers.
function pump() {
  if (!_initialized) return;
  const db = getDb();
  while (_activeWorkers < _settings.max_concurrent) {
    const job = pickNextJob(db);
    if (!job) return;
    _activeWorkers++;
    runJob(job)
      .catch(err => console.error('[Downloader] runJob threw:', err))
      .finally(() => {
        _activeWorkers--;
        // One worker freeing up may unblock the next job.
        setImmediate(pump);
      });
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

function init() {
  const db = getDb();
  loadSettings(db);
  // Recover from a kill mid-run: anything stuck in 'running' goes back to
  // 'queued' so the next pump picks it up. The CBZ for the partial chapter
  // was never renamed off `.tmp`, so it doesn't exist on disk — the worker
  // will start the same chapter over.
  const recovered = db.prepare(
    `UPDATE download_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`
  ).run();
  if (recovered.changes > 0) {
    console.log(`[Downloader] Re-queued ${recovered.changes} interrupted job(s) on startup.`);
  }
  // Best-effort: clean up any leftover .tmp files in known library paths so
  // they don't accumulate. Bounded to 100 dirs to keep startup snappy.
  try {
    const libs = db.prepare('SELECT path FROM libraries').all().slice(0, 100);
    for (const { path: libPath } of libs) {
      cleanupTmpFiles(libPath, 2);
    }
  } catch (_) { /* non-fatal */ }
  _initialized = true;
  pump();
}

function cleanupTmpFiles(dir, depth) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      cleanupTmpFiles(p, depth - 1);
    } else if (e.isFile() && e.name.endsWith('.cbz.tmp')) {
      try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Enqueue one chapter download. Returns the row id of the new job.
 */
function enqueueJob(spec) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO download_jobs (
      source, source_series_id, source_series_title,
      source_chapter_id, chapter_number, chapter_volume, chapter_title,
      target_mode, target_library_id, target_manga_id, target_folder_name,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
  `).run(
    spec.source,
    spec.source_series_id,
    spec.source_series_title || null,
    spec.source_chapter_id,
    spec.chapter_number ?? null,
    spec.chapter_volume ?? null,
    spec.chapter_title  || null,
    spec.target_mode,
    spec.target_library_id || null,
    spec.target_manga_id   || null,
    spec.target_folder_name || null,
  );
  setImmediate(pump);
  return result.lastInsertRowid;
}

/**
 * Mark a queued job as cancelled. If the job is currently running, abort its
 * in-flight image fetch — the worker will see the cancelled status on the next
 * page boundary and write the row to 'cancelled'.
 */
function cancelJob(id) {
  const db = getDb();
  const job = db.prepare('SELECT id, status FROM download_jobs WHERE id = ?').get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    db.prepare(
      `UPDATE download_jobs SET status='cancelled', finished_at=unixepoch() WHERE id = ?`
    ).run(id);
    return true;
  }
  if (job.status === 'running') {
    db.prepare(`UPDATE download_jobs SET status='cancelled' WHERE id = ?`).run(id);
    const ctrl = _inflight.get(id);
    if (ctrl) ctrl.abort();
    return true;
  }
  return false;
}

function listJobs({ limit = 50 } = {}) {
  const db = getDb();
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  // Display ordering — distinct from the FIFO pick order in pickNextJob().
  //
  //   1. running   (what the worker is doing right now — sorted by id ASC so
  //                 if the user later raises max_concurrent the older job
  //                 ranks first, matching pick order)
  //   2. queued    (FIFO — oldest first, so the user can read the list
  //                 top-to-bottom and see exactly what runs next)
  //   3. failed / cancelled / done  (most recent first)
  //
  // The previous `ORDER BY id DESC` made every new download appear at the
  // top, burying the in-progress job at the bottom — which read as "the
  // running download was replaced" even though it was still there. The pick
  // order (oldest queued first) was always FIFO; only the display lied.
  return db.prepare(`
    SELECT id, source, source_series_id, source_series_title,
           source_chapter_id, chapter_number, chapter_volume, chapter_title,
           target_mode, target_library_id, target_manga_id, target_folder_name,
           target_chapter_filename, status, error,
           pages_downloaded, pages_total, created_at, started_at, finished_at
      FROM download_jobs
     ORDER BY
       CASE status
         WHEN 'running'   THEN 0
         WHEN 'queued'    THEN 1
         ELSE                  2
       END ASC,
       CASE
         WHEN status IN ('running', 'queued') THEN created_at
         ELSE -created_at
       END ASC,
       id ASC
     LIMIT ?
  `).all(cap);
}

function clearFinished() {
  const db = getDb();
  return db.prepare(
    `DELETE FROM download_jobs WHERE status IN ('done','failed','cancelled')`
  ).run().changes;
}

/**
 * Re-queue a failed or cancelled job. Resets the run-state columns
 * (`error`, `started_at`, `finished_at`, `pages_downloaded`) so the worker
 * starts the chapter over from page 1, and bumps `created_at` to now so the
 * retry lands at the *back* of the queue rather than jumping ahead of jobs
 * that were already waiting — keeps FIFO honest from the user's POV.
 *
 * No-op for jobs in `queued`, `running`, or `done` — there's nothing to retry.
 * Returns true on success, false if the job is missing or not retryable.
 */
function retryJob(id) {
  const db = getDb();
  const job = db.prepare('SELECT id, status FROM download_jobs WHERE id = ?').get(id);
  if (!job) return false;
  if (job.status !== 'failed' && job.status !== 'cancelled') return false;
  db.prepare(`
    UPDATE download_jobs
       SET status            = 'queued',
           error             = NULL,
           started_at        = NULL,
           finished_at       = NULL,
           pages_downloaded  = 0,
           created_at        = unixepoch()
     WHERE id = ?
  `).run(id);
  setImmediate(pump);
  return true;
}

module.exports = {
  init,
  applySettings,
  getSettings,
  enqueueJob,
  cancelJob,
  retryJob,
  listJobs,
  clearFinished,
  // Exposed for tests / introspection
  _internal: { buildChapterFilename, sanitizeFilename, sourceColumn },
};
