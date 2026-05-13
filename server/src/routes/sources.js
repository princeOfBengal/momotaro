const express = require('express');
const fs = require('fs');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { getSource, listSources } = require('../sources');
const { parseUrl, buildUrl } = require('../sources/urlParser');
const downloader = require('../downloader/queue');
const scheduler = require('../scheduler');
const { cleanTitle } = require('../scanner/libraryScanner');

const router = express.Router();

// Sources known to the linkage helpers. Mirrors the column map in
// downloader/queue.js → sourceColumn().
const LINKAGE_COLUMNS = {
  mangadex:     'mangadex_id',
  comixto:      'comixto_id',
  mangakakalot: 'mangakakalot_id',
  mangafire:    'mangafire_id',
  weebcentral:  'weebcentral_id',
};

/**
 * Re-derive `manga.<source>_id` from the most recent matching row in
 * `manga_source_urls`. Called after every insert / update / delete on the URL
 * table so the denormalized "active" pointer the rest of the app reads stays
 * consistent. NULLs out the column when no URL of that source remains.
 */
function syncDenormalizedLinkage(db, mangaId, source) {
  const column = LINKAGE_COLUMNS[source];
  if (!column) return;
  const latest = db.prepare(`
    SELECT source_id FROM manga_source_urls
     WHERE manga_id = ? AND source = ? AND source_id IS NOT NULL
     ORDER BY id DESC LIMIT 1
  `).pluck().get(mangaId, source);
  db.prepare(`UPDATE manga SET ${column} = ? WHERE id = ?`).run(latest || null, mangaId);
}

/**
 * Upsert a URL into `manga_source_urls`. UNIQUE(manga_id, url) collapses
 * duplicates to a single row; a re-insert updates source_id/label without
 * losing the original `created_at`. Caller is responsible for calling
 * syncDenormalizedLinkage(db, mangaId, source) afterwards.
 */
function upsertSourceUrl(db, { manga_id, source, source_id, url, label }) {
  return db.prepare(`
    INSERT INTO manga_source_urls (manga_id, source, source_id, url, label)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (manga_id, url) DO UPDATE SET
      source    = excluded.source,
      source_id = excluded.source_id,
      label     = COALESCE(excluded.label, manga_source_urls.label)
  `).run(manga_id, source, source_id || null, url, label || null);
}

// ── Discovery ───────────────────────────────────────────────────────────────

// GET /api/sources — list available source adapters
router.get('/sources', asyncWrapper(async (req, res) => {
  res.json({ data: listSources() });
}));

// GET /api/sources/:source/search?q=...
router.get('/sources/:source/search', asyncWrapper(async (req, res) => {
  const source = getSource(req.params.source);
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ data: [] });
  const results = await source.searchSeries(q, { limit: 20 });
  res.json({ data: results });
}));

// GET /api/sources/:source/series/:id — series detail
router.get('/sources/:source/series/:id', asyncWrapper(async (req, res) => {
  const source = getSource(req.params.source);
  const detail = await source.getSeries(req.params.id);
  res.json({ data: detail });
}));

// GET /api/sources/:source/series/:id/chapters
router.get('/sources/:source/series/:id/chapters', asyncWrapper(async (req, res) => {
  const source = getSource(req.params.source);
  const lang = (req.query.lang || 'en').split(',').map(s => s.trim()).filter(Boolean);
  const chapters = await source.getChapters(req.params.id, { languages: lang });

  // Annotate each chapter with whether the user has already downloaded it,
  // either to a specific target manga (?manga_id=N) or via any prior job for
  // this source+series (used in the "new series" flow). The latter doesn't
  // catch chapters that exist on disk from outside this tool — for that the
  // user picks "existing series" so we can compare against actual files.
  const db = getDb();
  const downloadedJobIds = new Set(db.prepare(`
    SELECT source_chapter_id FROM download_jobs
     WHERE source = ? AND source_series_id = ? AND status = 'done'
  `).all(req.params.source, req.params.id).map(r => r.source_chapter_id));

  let existingChapterNumbers = new Set();
  if (req.query.manga_id) {
    const rows = db.prepare(
      `SELECT number FROM chapters WHERE manga_id = ? AND number IS NOT NULL`
    ).all(req.query.manga_id);
    existingChapterNumbers = new Set(rows.map(r => Number(r.number)));
  }

  const annotated = chapters.map(ch => ({
    ...ch,
    already_downloaded: downloadedJobIds.has(ch.id)
      || (ch.number !== null && existingChapterNumbers.has(Number(ch.number))),
  }));

  res.json({ data: annotated });
}));

// ── Downloads ───────────────────────────────────────────────────────────────

// POST /api/sources/:source/download
//
// Body: {
//   source_series_id:    string,
//   source_series_title: string,
//   chapters: [
//     { id, number?, volume?, title? }, ...
//   ],
//   target: {
//     mode:        'new' | 'existing',
//     library_id?: number,            // mode='new'
//     folder_name?: string,           // mode='new'  (defaults to sanitized series title)
//     manga_id?:   number,            // mode='existing'
//   },
// }
router.post('/sources/:source/download', asyncWrapper(async (req, res) => {
  const source = getSource(req.params.source);
  const sourceId = source.id;
  const {
    source_series_id,
    source_series_title,
    chapters = [],
    target,
  } = req.body || {};

  if (!source_series_id) return res.status(400).json({ error: 'source_series_id is required' });
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({ error: 'chapters must be a non-empty array' });
  }
  if (!target || !target.mode) return res.status(400).json({ error: 'target.mode is required' });
  if (target.mode !== 'new' && target.mode !== 'existing') {
    return res.status(400).json({ error: `target.mode must be "new" or "existing"` });
  }

  const db = getDb();

  // Resolve & validate the target up front so we fail with a clean 400
  // instead of writing 50 jobs that all fail later.
  let resolvedFolderName = null;
  let resolvedMangaId    = null;
  let resolvedLibraryId  = null;
  let mangaPathForLink   = null;

  if (target.mode === 'new') {
    if (!target.library_id) return res.status(400).json({ error: 'target.library_id is required for mode=new' });
    const lib = db.prepare('SELECT id, path FROM libraries WHERE id = ?').get(target.library_id);
    if (!lib) return res.status(404).json({ error: 'target library not found' });
    resolvedLibraryId  = lib.id;
    resolvedFolderName = (target.folder_name && target.folder_name.trim())
      || cleanTitle(source_series_title || source_series_id);
    if (!resolvedFolderName) return res.status(400).json({ error: 'target.folder_name resolves to empty string' });
    mangaPathForLink = require('path').join(lib.path, resolvedFolderName);
  } else {
    if (!target.manga_id) return res.status(400).json({ error: 'target.manga_id is required for mode=existing' });
    const manga = db.prepare('SELECT id, path, library_id FROM manga WHERE id = ?').get(target.manga_id);
    if (!manga) return res.status(404).json({ error: 'target manga not found' });
    if (!manga.path || !fs.existsSync(manga.path)) {
      return res.status(409).json({ error: `target manga folder no longer exists: ${manga.path}` });
    }
    resolvedMangaId   = manga.id;
    resolvedLibraryId = manga.library_id;
    mangaPathForLink  = manga.path;
  }

  // Persist the source linkage immediately so even if the download is later
  // cancelled, the user's intent ("this series in my library is the same as
  // this MangaDex series") is recorded — that's what the future scheduler
  // needs to find candidates for re-checking.
  //
  // For mode='existing' we record the URL right now and let
  // syncDenormalizedLinkage update the per-source `*_id` column. For
  // mode='new' the manga row doesn't exist yet — the URL + linkage fire in
  // the queue worker after the post-download rescan (see queue.js).
  if (target.mode === 'existing') {
    const canonicalUrl = buildUrl(sourceId, source_series_id);
    if (canonicalUrl) {
      upsertSourceUrl(db, {
        manga_id:  resolvedMangaId,
        source:    sourceId,
        source_id: source_series_id,
        url:       canonicalUrl,
        label:     source_series_title || null,
      });
      syncDenormalizedLinkage(db, resolvedMangaId, sourceId);
    }
  }

  const jobIds = [];
  for (const ch of chapters) {
    if (!ch || !ch.id) continue;
    const id = downloader.enqueueJob({
      source: sourceId,
      source_series_id,
      source_series_title,
      source_chapter_id:  ch.id,
      chapter_number:     ch.number ?? null,
      chapter_volume:     ch.volume ?? null,
      chapter_title:      ch.title  || null,
      target_mode:        target.mode,
      target_library_id:  resolvedLibraryId,
      target_manga_id:    resolvedMangaId,
      target_folder_name: resolvedFolderName,
    });
    jobIds.push(id);
  }

  res.status(201).json({
    data: {
      job_ids: jobIds,
      enqueued: jobIds.length,
      target_path: mangaPathForLink,
    },
  });
}));

// GET /api/sources/downloads — list recent jobs (newest first)
router.get('/sources/downloads', asyncWrapper(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json({ data: downloader.listJobs({ limit }) });
}));

// DELETE /api/sources/downloads/:id — cancel a queued or running job
router.delete('/sources/downloads/:id', asyncWrapper(async (req, res) => {
  const ok = downloader.cancelJob(parseInt(req.params.id, 10));
  if (!ok) return res.status(404).json({ error: 'Job not found or already finished' });
  res.json({ message: 'Cancelled' });
}));

// POST /api/sources/downloads/:id/retry — re-queue a failed or cancelled job.
// Resets run-state columns and pushes created_at to now so the retry sits at
// the back of the queue rather than jumping ahead of already-waiting jobs.
router.post('/sources/downloads/:id/retry', asyncWrapper(async (req, res) => {
  const ok = downloader.retryJob(parseInt(req.params.id, 10));
  if (!ok) return res.status(404).json({ error: 'Job not found or not retryable' });
  res.json({ message: 'Re-queued' });
}));

// POST /api/sources/downloads/clear-finished — drop done/failed/cancelled rows
router.post('/sources/downloads/clear-finished', asyncWrapper(async (req, res) => {
  const removed = downloader.clearFinished();
  res.json({ data: { removed } });
}));

// ── Existing-library matching ───────────────────────────────────────────────

// GET /api/sources/match-existing?title=...
//
// Finds manga in the user's library whose title looks similar to the search
// term, so the "Add to existing series" picker can suggest a default. Pure
// FTS5 lookup — same indexed search the rest of the app uses.
router.get('/sources/match-existing', asyncWrapper(async (req, res) => {
  const title = String(req.query.title || '').trim();
  if (!title) return res.json({ data: [] });
  const db = getDb();
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return res.json({ data: [] });
  const match = words.map(w => `"${w}"`).join(' OR ');

  const rows = db.prepare(`
    SELECT m.id, m.title, m.path, m.cover_image, m.library_id, l.name AS library_name
      FROM manga m
      JOIN manga_fts f ON f.rowid = m.id
      LEFT JOIN libraries l ON l.id = m.library_id
     WHERE manga_fts MATCH ?
     LIMIT 25
  `).all(match);

  res.json({ data: rows });
}));

// ── Manga ↔ source linkage ──────────────────────────────────────────────────
//
// Letting users record / clear the source ID on an existing series even
// without downloading — this is what the future scheduler will use to know
// "this series in your library is the same as this MangaDex series, so check
// for new chapters there".

// POST /api/manga/:id/link-source — body: { source: 'mangadex', source_id: '...' }
router.post('/manga/:id/link-source', asyncWrapper(async (req, res) => {
  const { source, source_id } = req.body || {};
  if (!source || !source_id) {
    return res.status(400).json({ error: 'source and source_id are required' });
  }
  const column = LINKAGE_COLUMNS[source];
  if (!column) return res.status(400).json({ error: `Unknown source "${source}"` });

  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  db.prepare(`UPDATE manga SET ${column} = ? WHERE id = ?`).run(String(source_id), manga.id);
  res.json({ data: { manga_id: manga.id, source, source_id: String(source_id) } });
}));

// DELETE /api/manga/:id/link-source/:source — clear linkage to that source
router.delete('/manga/:id/link-source/:source', asyncWrapper(async (req, res) => {
  const column = LINKAGE_COLUMNS[req.params.source];
  if (!column) return res.status(400).json({ error: `Unknown source "${req.params.source}"` });

  const db = getDb();
  db.prepare(`UPDATE manga SET ${column} = NULL WHERE id = ?`).run(req.params.id);
  res.json({ message: 'Linkage cleared' });
}));

// ── Per-manga source URL store ──────────────────────────────────────────────
//
// Multiple URLs per manga (different source, alternate mirror, replacement
// after a dead link). Auto-recorded by the download flow; manually editable
// from the MangaDetail UI. Drives the future scheduler — the URL list is the
// authoritative "where do I check for new chapters" record per series.

// GET /api/manga/:id/source-urls — list registered URLs for this manga
router.get('/manga/:id/source-urls', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const rows = db.prepare(`
    SELECT id, source, source_id, url, label, created_at, last_used_at
      FROM manga_source_urls
     WHERE manga_id = ?
     ORDER BY id ASC
  `).all(manga.id);
  res.json({ data: rows });
}));

// POST /api/manga/:id/source-urls
//
// Body: { url, label? }                       — auto-detect (source, source_id) from URL
//   or: { source, source_id, label?, url? }   — explicit; URL is built canonically if omitted
//
// 400 when the URL doesn't match any known source pattern. The user is told
// the supported patterns so they know what to paste.
router.post('/manga/:id/source-urls', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { url, source, source_id, label } = req.body || {};

  let resolved = null;
  if (url) {
    resolved = parseUrl(url);
    if (!resolved) {
      return res.status(400).json({
        error: 'URL does not match any known source pattern',
        accepted: [
        'https://mangadex.org/title/{uuid}',
        'https://comix.to/title/{hid}',
        'https://www.mangakakalot.gg/manga/{slug}',
        'https://mangafire.to/manga/{slug}.{hid}',
        'https://weebcentral.com/series/{ULID}',
      ],
      });
    }
  } else if (source && source_id) {
    const built = buildUrl(source, source_id);
    if (!built) return res.status(400).json({ error: `Unknown source "${source}"` });
    resolved = { source, source_id, url: built };
  } else {
    return res.status(400).json({ error: 'Provide url, or source + source_id' });
  }

  upsertSourceUrl(db, { manga_id: manga.id, ...resolved, label });
  syncDenormalizedLinkage(db, manga.id, resolved.source);

  const row = db.prepare(
    `SELECT * FROM manga_source_urls WHERE manga_id = ? AND url = ?`
  ).get(manga.id, resolved.url);
  res.status(201).json({ data: row });
}));

// PATCH /api/manga/:id/source-urls/:urlId
//
// Body: { url?, label? } — replace the URL (re-parsed for source/id) and/or
// the display label. Replacing the URL is the primary editing path: when a
// source's slug changes or the user moves to a different mirror, they paste
// the new URL and the (source, source_id) re-derive automatically.
router.patch('/manga/:id/source-urls/:urlId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM manga_source_urls
     WHERE id = ? AND manga_id = ?
  `).get(req.params.urlId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Source URL not found' });

  const { url, label } = req.body || {};
  if (url === undefined && label === undefined) {
    return res.status(400).json({ error: 'Provide url and/or label' });
  }

  let newSource    = row.source;
  let newSourceId  = row.source_id;
  let newUrl       = row.url;

  if (url !== undefined) {
    const resolved = parseUrl(url);
    if (!resolved) {
      return res.status(400).json({
        error: 'URL does not match any known source pattern',
        accepted: [
        'https://mangadex.org/title/{uuid}',
        'https://comix.to/title/{hid}',
        'https://www.mangakakalot.gg/manga/{slug}',
        'https://mangafire.to/manga/{slug}.{hid}',
        'https://weebcentral.com/series/{ULID}',
      ],
      });
    }
    // Editing to a URL that already exists for this manga would violate the
    // UNIQUE constraint. Tell the user instead of throwing a 500.
    if (resolved.url !== row.url) {
      const dup = db.prepare(
        `SELECT id FROM manga_source_urls WHERE manga_id = ? AND url = ? AND id != ?`
      ).get(req.params.id, resolved.url, row.id);
      if (dup) return res.status(409).json({ error: 'That URL is already recorded for this manga' });
    }
    newSource   = resolved.source;
    newSourceId = resolved.source_id;
    newUrl      = resolved.url;
  }

  db.prepare(`
    UPDATE manga_source_urls
       SET source = ?, source_id = ?, url = ?, label = COALESCE(?, label)
     WHERE id = ?
  `).run(newSource, newSourceId, newUrl, label !== undefined ? label : null, row.id);

  // Sync both the old and the new source — moving from source A to source B
  // could break the A linkage and/or establish a new B linkage.
  syncDenormalizedLinkage(db, req.params.id, row.source);
  if (newSource !== row.source) syncDenormalizedLinkage(db, req.params.id, newSource);

  const updated = db.prepare('SELECT * FROM manga_source_urls WHERE id = ?').get(row.id);
  res.json({ data: updated });
}));

// DELETE /api/manga/:id/source-urls/:urlId
router.delete('/manga/:id/source-urls/:urlId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM manga_source_urls WHERE id = ? AND manga_id = ?
  `).get(req.params.urlId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Source URL not found' });

  db.prepare('DELETE FROM manga_source_urls WHERE id = ?').run(row.id);
  syncDenormalizedLinkage(db, req.params.id, row.source);
  res.json({ message: 'Removed' });
}));

// ── Per-manga scheduled auto-checking ──────────────────────────────────────
//
// One schedule per manga. The scheduler module ([scheduler/index.js]) polls
// `manga_schedules` once a minute, picks every row whose next_run_at has
// passed, fetches each recorded URL's chapter list, diffs against the local
// folder, and enqueues anything missing through the existing download queue.
//
// `next_run_at` is recomputed both here (on create / update) and by the
// scheduler (after every fire) so the poll loop only ever has to do an
// indexed `WHERE next_run_at <= ?` lookup.

const ALLOWED_FREQUENCIES = ['daily', 'weekly'];

function validateScheduleInput(body) {
  const out = {};
  if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };

  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;

  if (body.frequency !== undefined) {
    if (!ALLOWED_FREQUENCIES.includes(body.frequency)) {
      return { error: `frequency must be one of: ${ALLOWED_FREQUENCIES.join(', ')}` };
    }
    out.frequency = body.frequency;
  }

  if (body.time_of_day !== undefined) {
    if (!/^\d{1,2}:\d{2}$/.test(String(body.time_of_day))) {
      return { error: 'time_of_day must be HH:MM (24-hour)' };
    }
    out.time_of_day = String(body.time_of_day);
  }

  if (body.day_of_week !== undefined && body.day_of_week !== null) {
    const dow = parseInt(body.day_of_week, 10);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return { error: 'day_of_week must be an integer 0..6 (0=Sunday)' };
    }
    out.day_of_week = dow;
  } else if (body.day_of_week === null) {
    out.day_of_week = null;
  }

  return { ok: out };
}

// GET /api/schedules — every schedule, organised per manga, with each
// manga's recorded source URLs embedded inline so the Settings page can
// render the whole list with a single fetch.
//
// Two queries (schedules joined to manga, then all URLs for the matched
// manga in one IN-list lookup) and a JS group, instead of a correlated
// subquery — keeps the cost flat in the URL count even when one manga has
// many recorded URLs.
router.get('/schedules', asyncWrapper(async (req, res) => {
  const db = getDb();
  const schedules = db.prepare(`
    SELECT s.id, s.manga_id, s.enabled, s.frequency, s.day_of_week,
           s.time_of_day, s.last_checked_at, s.last_result, s.next_run_at,
           s.created_at, s.updated_at,
           m.title AS manga_title, m.cover_image AS manga_cover_image
      FROM manga_schedules s
      JOIN manga m ON m.id = s.manga_id
     ORDER BY m.title COLLATE NOCASE ASC
  `).all();

  if (schedules.length === 0) return res.json({ data: [] });

  const ids = schedules.map(s => s.manga_id);
  const placeholders = ids.map(() => '?').join(',');
  const urlRows = db.prepare(`
    SELECT id, manga_id, source, source_id, url, label, last_used_at
      FROM manga_source_urls
     WHERE manga_id IN (${placeholders})
     ORDER BY id ASC
  `).all(...ids);

  const urlsByManga = new Map();
  for (const r of urlRows) {
    if (!urlsByManga.has(r.manga_id)) urlsByManga.set(r.manga_id, []);
    urlsByManga.get(r.manga_id).push({
      id: r.id, source: r.source, source_id: r.source_id, url: r.url,
      label: r.label, last_used_at: r.last_used_at,
    });
  }

  const { thumbnailUrl } = require('../scanner/thumbnailPaths');
  const data = schedules.map(s => ({
    id:              s.id,
    manga_id:        s.manga_id,
    enabled:         s.enabled,
    frequency:       s.frequency,
    day_of_week:     s.day_of_week,
    time_of_day:     s.time_of_day,
    last_checked_at: s.last_checked_at,
    last_result:     s.last_result,
    next_run_at:     s.next_run_at,
    created_at:      s.created_at,
    updated_at:      s.updated_at,
    manga: {
      id:        s.manga_id,
      title:     s.manga_title,
      cover_url: s.manga_cover_image ? thumbnailUrl(s.manga_cover_image) : null,
    },
    urls: urlsByManga.get(s.manga_id) || [],
  }));
  res.json({ data });
}));

// GET /api/manga/:id/schedule — current schedule (or null when none exists)
router.get('/manga/:id/schedule', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const row = db.prepare(
    `SELECT * FROM manga_schedules WHERE manga_id = ?`
  ).get(manga.id);
  res.json({ data: row || null });
}));

// PUT /api/manga/:id/schedule — upsert
//
// Body: { frequency: 'daily'|'weekly', time_of_day: 'HH:MM', day_of_week?: 0..6, enabled?: bool }
//
// `frequency` and `time_of_day` are required on create; on update we patch
// in whatever's provided and keep the rest. `next_run_at` is recomputed
// here so the next poll tick sees the new schedule.
router.put('/manga/:id/schedule', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const v = validateScheduleInput(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const patch = v.ok;

  const existing = db.prepare('SELECT * FROM manga_schedules WHERE manga_id = ?').get(manga.id);

  const merged = {
    enabled:     patch.enabled     ?? existing?.enabled     ?? 1,
    frequency:   patch.frequency   ?? existing?.frequency,
    time_of_day: patch.time_of_day ?? existing?.time_of_day,
    day_of_week: 'day_of_week' in patch ? patch.day_of_week : existing?.day_of_week ?? null,
  };

  if (!merged.frequency || !merged.time_of_day) {
    return res.status(400).json({ error: 'frequency and time_of_day are required on first save' });
  }
  if (merged.frequency === 'weekly' && (merged.day_of_week == null)) {
    return res.status(400).json({ error: 'day_of_week is required when frequency=weekly' });
  }

  const nextRunAt = scheduler.computeNextRunAt(merged);
  if (nextRunAt == null) return res.status(400).json({ error: 'Could not compute next_run_at — check time_of_day' });

  if (existing) {
    db.prepare(`
      UPDATE manga_schedules
         SET enabled     = ?,
             frequency   = ?,
             day_of_week = ?,
             time_of_day = ?,
             next_run_at = ?,
             updated_at  = unixepoch()
       WHERE id = ?
    `).run(
      merged.enabled, merged.frequency, merged.day_of_week,
      merged.time_of_day, merged.enabled ? nextRunAt : null,
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO manga_schedules
        (manga_id, enabled, frequency, day_of_week, time_of_day, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      manga.id, merged.enabled, merged.frequency, merged.day_of_week,
      merged.time_of_day, merged.enabled ? nextRunAt : null,
    );
  }

  const fresh = db.prepare('SELECT * FROM manga_schedules WHERE manga_id = ?').get(manga.id);
  res.json({ data: fresh });
}));

// DELETE /api/manga/:id/schedule
router.delete('/manga/:id/schedule', asyncWrapper(async (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM manga_schedules WHERE manga_id = ?').run(req.params.id);
  res.json({ message: 'Schedule removed' });
}));

// POST /api/manga/:id/schedule/run-now — fire a one-shot check immediately,
// independent of the schedule. The result is also written back to the
// schedule row's last_checked_at / last_result so the UI shows the same
// status whether the run came from the poll loop or from this endpoint.
router.post('/manga/:id/schedule/run-now', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const result = await scheduler.checkOneManga(manga.id);
  // Persist the outcome onto the schedule row when one exists. If the user
  // never created a schedule (run-now used as a manual "check now" button
  // without committing to recurring checks), just return the result.
  const sched = db.prepare('SELECT * FROM manga_schedules WHERE manga_id = ?').get(manga.id);
  if (sched) {
    scheduler.recordRunResult(db, sched, result.summary);
  }

  res.json({ data: result });
}));

module.exports = router;
// Helpers reused by the download flow + the queue worker.
module.exports.upsertSourceUrl        = upsertSourceUrl;
module.exports.syncDenormalizedLinkage = syncDenormalizedLinkage;
