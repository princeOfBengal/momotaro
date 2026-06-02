const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
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

// Upsert the pages rows for a CBZ chapter so they match the chapter's planned
// extraction layout. Keyed on (chapter_id, page_index) — IDs are preserved
// across re-extractions, which is what keeps the reader's page-id URLs valid
// when a cache eviction triggers a re-extract mid-read.
//
// width/height are applied only when present on the planned page (fast-mode
// Phase 1 supplies them up front; full-mode populates them after extraction).
//
// Any pages rows beyond `plannedPages.length` (left over from a previous
// archive version with more pages) are deleted in the same transaction so
// the chapter row's page_count stays honest.
function upsertCbzPageRows(db, chapterId, plannedPages) {
  const upsert = db.prepare(`
    INSERT INTO pages (chapter_id, page_index, filename, path, width, height)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chapter_id, page_index) DO UPDATE SET
      filename = excluded.filename,
      path     = excluded.path,
      width    = COALESCE(excluded.width,  pages.width),
      height   = COALESCE(excluded.height, pages.height)
  `);
  const trim = db.prepare('DELETE FROM pages WHERE chapter_id = ? AND page_index >= ?');
  const setCount = db.prepare('UPDATE chapters SET page_count = ? WHERE id = ?');

  db.transaction(() => {
    for (const p of plannedPages) {
      upsert.run(
        chapterId,
        p.pageIndex,
        p.originalName,
        p.cacheFilename,
        p.width ?? null,
        p.height ?? null
      );
    }
    trim.run(chapterId, plannedPages.length);
    setCount.run(plannedPages.length, chapterId);
  })();
}

// Construct a per-page onPageExtracted callback for cbzCache to invoke after
// every successful page extract in fast mode. The callback reads
// sharp.metadata() on the freshly-extracted file and queues a width/height
// UPDATE for the matching pages row, but only when the row's current
// width/height is NULL — so a Phase 1 probe that succeeded never gets
// clobbered by a later re-probe. Updates are batched (BATCH_SIZE rows, or
// after FLUSH_IDLE_MS of inactivity) so the writer thread sees one
// transaction per batch instead of one per page.
//
// The buffer + timer live in the closure, so they outlive the route
// handler that constructed them. cancelChapter and chapter deletion still
// work correctly: a flush against a deleted row UPDATEs zero rows, which
// is a harmless no-op.
function makeDimReprobeHook(db, chapterId) {
  // BATCH_SIZE must exceed CBZ_FAST_PREFIX so the buffer cannot fill from
  // Phase 1's prefix alone — if it could, a BATCH_SIZE-triggered flush
  // would fire DURING Phase 1, before the route's synchronous upsert has
  // a chance to enqueue on the better-sqlite3 writer. Those UPDATEs would
  // hit non-existent rows (UPDATE matches 0 rows) and the dim corrections
  // would be silently lost. With BATCH_SIZE > FAST_PREFIX, the prefix can
  // never fill the buffer alone, so flushes are always either timer-driven
  // (500 ms after first push — well past upsert) or triggered by Phase 2
  // pages arriving (which only start after upsert has run synchronously).
  const BATCH_SIZE     = Math.max(8, (config.CBZ_FAST_PREFIX || 6) + 4);
  const FLUSH_IDLE_MS  = 500;
  const pending = [];           // [{ pageIndex, width, height }]
  let timer = null;

  const upd = db.prepare(
    'UPDATE pages SET width = ?, height = ? ' +
    'WHERE chapter_id = ? AND page_index = ? AND (width IS NULL OR height IS NULL)'
  );
  const flushTxn = db.transaction((rows) => {
    for (const { pageIndex, width, height } of rows) {
      upd.run(width, height, chapterId, pageIndex);
    }
  });

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    try { flushTxn(batch); }
    catch (_) { /* row gone / chapter deleted — fine, no-op */ }
  }

  return async function onPageExtracted(pageIndex, absPath) {
    let width = null;
    let height = null;
    try {
      const meta = await sharp(absPath).metadata();
      width  = meta.width  || null;
      height = meta.height || null;
    } catch {
      return; // sharp failed; leave dim NULL for the cache-hit heal to retry
    }
    if (width === null && height === null) return;
    pending.push({ pageIndex, width, height });
    if (pending.length >= BATCH_SIZE) {
      flush();
    } else if (!timer) {
      // Idle flush — guarantees the trailing batch lands even if Phase 2
      // exited mid-batch.
      timer = setTimeout(flush, FLUSH_IDLE_MS);
    }
  };
}

// Backfill missing width/height on a chapter's pages by reading sharp metadata
// off the already-extracted files on disk. Used by the full-extract path
// (which doesn't probe dims at Phase 1) to maintain the existing scanner
// invariant that folder-chapter dims are populated. Runs in one transaction.
async function backfillDimsFromDisk(db, chapterId, chapterDir) {
  const rows = db.prepare(
    'SELECT id, path FROM pages WHERE chapter_id = ? AND (width IS NULL OR height IS NULL) ORDER BY page_index ASC'
  ).all(chapterId);
  if (rows.length === 0) return;
  const dims = await withLimit(
    4,
    rows,
    r => readImageDimensions(path.join(chapterDir, r.path))
  );
  const upd = db.prepare('UPDATE pages SET width = ?, height = ? WHERE id = ?');
  db.transaction(() => {
    rows.forEach((r, i) => upd.run(dims[i].width, dims[i].height, r.id));
  })();
}

// Resolve a page by id, returning everything the serving route needs to find
// the image on disk. CBZ pages live under the per-chapter cache directory
// (stored_path is the cache filename); folder pages store an absolute path.
function lookupPageMeta(id) {
  const row = getDb().prepare(
    `SELECT p.path, p.chapter_id, p.page_index,
            c.type AS chapter_type, c.path AS chapter_path
     FROM pages p
     JOIN chapters c ON c.id = p.chapter_id
     WHERE p.id = ?`
  ).get(id);
  if (!row) return null;
  return {
    chapterId:   row.chapter_id,
    pageIndex:   row.page_index,
    type:        row.chapter_type,
    chapterPath: row.chapter_path,
    storedPath:  row.path,
  };
}

// Parse the per-request fast-open flag. The client sends `?fast=1` on
// /api/chapters/:id/pages when its "Fast chapter open" reading setting is
// on. Anything else (omitted, falsy, malformed) keeps the legacy full-extract
// path so a broken setting never degrades the reader experience.
function fastFlag(req) {
  const v = req.query.fast;
  return v === '1' || v === 'true';
}

// Parse the optional `?resume_page=N` hint. Lets the route extend the Phase 1
// prefix to cover the user's resume position so deep-link entries land
// without waiting on Phase 2.
function resumePageHint(req) {
  const v = req.query.resume_page;
  if (v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// GET /api/chapters/:id/pages — list all pages for a chapter.
// Folder chapters: a straight DB read; dims are populated at scan time.
// CBZ chapters: drive ensureChapterExtracted (fast or full per ?fast=1),
//   upsert page rows from the planned-page list so IDs survive re-extracts,
//   then return.
router.get('/chapters/:id/pages', asyncWrapper(async (req, res) => {
  const db = getDb();
  const chapter = db.prepare('SELECT id, type, path FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

  let extracting = false;
  let totalPages = null;

  if (chapter.type === 'cbz') {
    const mode = fastFlag(req) ? 'fast' : 'full';
    const resumePage = resumePageHint(req);
    // Fast mode only: hand the cache a per-page hook that re-probes dims
    // from each extracted file via sharp and batches UPDATEs to the pages
    // table. This is what makes Phase 1's 256 KB header-sniff misses
    // self-heal during Phase 2 — without it, a wide page whose header
    // probe failed would stay is_wide=null until the next chapter re-open,
    // and Double Page (Manga) would mispair it in the meantime. The hook
    // is a no-op for rows that already have dims, so a successful Phase 1
    // probe never gets clobbered.
    const onPageExtracted = mode === 'fast'
      ? makeDimReprobeHook(db, chapter.id)
      : undefined;
    let extraction;
    try {
      extraction = await cbzCache.ensureChapterExtracted(chapter.id, chapter.path, {
        mode,
        resumePage,
        onPageExtracted,
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Archive file not found on disk' });
      }
      if (cbzCache.isChapterRemovedError(err)) {
        return res.status(410).json({ error: 'Chapter was removed' });
      }
      throw err;
    }

    if (extraction.freshlyExtracted && extraction.plannedPages) {
      // Stable-id rebuild: upsert keyed on (chapter_id, page_index).
      upsertCbzPageRows(db, chapter.id, extraction.plannedPages);

      // Full mode never probes dims at Phase 1 — backfill from disk so the
      // existing reader invariant (CBZ dims known on first list) still
      // holds for the legacy path.
      if (mode === 'full') {
        await backfillDimsFromDisk(db, chapter.id, extraction.dir);
      }
    } else if (!extraction.freshlyExtracted) {
      // Cache hit — heal two kinds of staleness:
      //
      // 1. Path mismatch. A prior version of the code wrote rows with the
      //    now-stale path scheme (e.g. ZIP entry names rather than cache
      //    filenames), or a parallel extraction created files we don't yet
      //    have rows for. Rebuild the rows from the on-disk file list.
      //
      // 2. Null dimensions. Fast-mode Phase 1's 256 KB header probe can fail
      //    for a corrupt image header or an unusual codec — those pages get
      //    null `width`/`height` and would be mispaired in Double Page
      //    (Manga) (which treats unknown as not-wide). Phase 2 only extracts
      //    files, it doesn't re-probe dims. Without this heal, Phase 1
      //    probe failures would stick around forever and Double Page
      //    (Manga) would render a wide spread paired with its neighbour on
      //    every chapter re-open. Reading sharp.metadata() from the
      //    extracted file is reliable where the 256 KB sniff was not, so
      //    backfillDimsFromDisk corrects the row. The client's 6s re-fetch
      //    loop hits this path and picks up the corrected dims — that's
      //    what actually makes the late re-fetch useful.
      const rows = db.prepare(
        'SELECT path, width, height FROM pages WHERE chapter_id = ?'
      ).all(chapter.id);
      let diskFiles = [];
      try {
        diskFiles = fs.readdirSync(extraction.dir).filter(f => f !== '.ready' && !f.endsWith('.tmp'));
      } catch { /* ignore — dir may have been concurrently evicted */ }
      const diskSet = new Set(diskFiles);
      const pathMismatch = rows.length !== diskFiles.length || rows.some(r => !diskSet.has(r.path));
      const hasNullDims  = rows.some(r => r.width === null || r.height === null);

      if (pathMismatch && diskFiles.length > 0) {
        diskFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        const planned = diskFiles.map((f, i) => ({
          pageIndex: i,
          originalName: f,
          cacheFilename: f,
          width: null,
          height: null,
        }));
        upsertCbzPageRows(db, chapter.id, planned);
        await backfillDimsFromDisk(db, chapter.id, extraction.dir);
      } else if (hasNullDims) {
        // backfillDimsFromDisk only sharp-reads rows whose dims are NULL, so
        // a chapter with full dims pays only the indexed `hasNullDims` query
        // above. A row whose file isn't on disk yet (Phase 2 mid-extract)
        // produces a {null,null} read that's a safe no-op UPDATE.
        await backfillDimsFromDisk(db, chapter.id, extraction.dir);
      }
    }

    extracting = !!extraction.extracting;
    totalPages = extraction.plannedPages?.length ?? null;
  }

  const pages = db.prepare(
    'SELECT id, page_index, filename, path, width, height FROM pages WHERE chapter_id = ? ORDER BY page_index ASC'
  ).all(chapter.id);

  // A page is considered "wide" when it's landscape-oriented (width > height).
  // In Double Page (Manga) mode the reader renders such pages solo, since they
  // typically represent a spread or otherwise shouldn't be paired.
  res.json({
    data: pages.map(({ path: _path, ...rest }) => ({
      ...rest,
      is_wide: rest.width !== null && rest.height !== null && rest.width > 0 && rest.height > 0
        ? rest.width > rest.height
        : null,
    })),
    extracting,
    total_pages: totalPages ?? pages.length,
  });
}));

// POST /api/pages/dims — client-reported page dimensions, used as a final
// safety net when every server-side probe path missed (Phase 1 256 KB sniff
// failed, Phase 2's sharp.metadata also failed, cache-hit heal didn't run
// because rows look complete). The browser has already decoded the image
// when the reader's <img onLoad> fires, so naturalWidth/naturalHeight is
// authoritative for that page.
//
// Body: { dims: [{ page_id, width, height }, ...] }
//
// Every UPDATE filters `AND (width IS NULL OR height IS NULL)` — a row whose
// dims are already known never gets clobbered by a client report. This keeps
// the trust boundary one-way: the client can fill in unknowns, never overwrite
// a server-probed value. Validation rejects out-of-range numbers as a sanity
// guard (no security implication, just defensive).
//
// Returns the count of rows actually updated so the client knows how much it
// patched (useful for telemetry, never surfaced to UI).
router.post('/pages/dims', asyncWrapper(async (req, res) => {
  const dims = Array.isArray(req.body?.dims) ? req.body.dims : [];
  if (dims.length === 0) return res.json({ data: { updated: 0 } });
  if (dims.length > 100) {
    return res.status(400).json({ error: 'Batch too large (max 100)' });
  }

  const db = getDb();
  const upd = db.prepare(
    'UPDATE pages SET width = ?, height = ? ' +
    'WHERE id = ? AND (width IS NULL OR height IS NULL)'
  );

  let updated = 0;
  db.transaction((rows) => {
    for (const r of rows) {
      const pageId = parseInt(r.page_id, 10);
      const w = parseInt(r.width, 10);
      const h = parseInt(r.height, 10);
      // Defensive validation. Anything out of range is silently dropped — the
      // upstream image renderer will have shown the page regardless, so a
      // bad dim report just means the row stays NULL until something else
      // (cache-hit heal, full re-extract) backfills it.
      if (!Number.isInteger(pageId) || pageId <= 0) continue;
      if (!Number.isInteger(w) || w <= 0 || w > 30000) continue;
      if (!Number.isInteger(h) || h <= 0 || h > 30000) continue;
      const result = upd.run(w, h, pageId);
      if (result.changes > 0) updated++;
    }
  })(dims);

  res.json({ data: { updated } });
}));

// POST /api/chapters/:id/prioritize-pages — move the named page indices to
// the front of the Phase 2 work queue. Driven by the reader when the user
// scrubs / jumps ahead so the target pages extract before pages further
// downstream the user hasn't reached yet. No-op when there's no active fast
// extraction (priority hints only meaningful then). Returns 404 if the
// chapter row is gone (a stale request from a since-deleted manga).
router.post('/chapters/:id/prioritize-pages', asyncWrapper(async (req, res) => {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM chapters WHERE id = ?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: 'Chapter not found' });
  const indices = Array.isArray(req.body?.page_indices) ? req.body.page_indices : [];
  const touched = cbzCache.prioritizePages(parseInt(req.params.id, 10), indices);
  res.json({ data: { touched } });
}));

// GET /api/pages/:id/image — serve a page image.
// Folder chapters: sendFile straight from the stored absolute path.
// CBZ chapters: sendFile from the chapter's cache directory. If the cache has
// been evicted since the chapter was opened, re-extract on the fly. If the
// requested page hasn't been extracted yet (fast-mode Phase 2 still running),
// wait on the per-file readiness promise with a hard cap.
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
    // The pages-list endpoint kicked off an extraction; resolve the dir
    // without forcing a re-extract by passing through the same `fast` flag
    // the original list call used. (Pure cache-hit path is dominant here.)
    //
    // If this call has to KICK OFF a fresh fast extraction (the chapter was
    // evicted between the pages-list call and now, or the page-image route
    // is being hit before pages-list for some reason), we still want the
    // dim-reprobe hook so probe failures get healed. The hook only fires
    // on a fresh extraction path; on a cache hit it's never invoked.
    const fastMode = fastFlag(req);
    const onPageExtracted = fastMode
      ? makeDimReprobeHook(getDb(), meta.chapterId)
      : undefined;
    let extraction;
    try {
      extraction = await cbzCache.ensureChapterExtracted(meta.chapterId, meta.chapterPath, {
        mode: fastMode ? 'fast' : 'full',
        onPageExtracted,
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Archive file not found on disk' });
      }
      if (cbzCache.isChapterRemovedError(err)) {
        return res.status(410).json({ error: 'Chapter was removed' });
      }
      return next(err);
    }

    const abs = path.join(extraction.dir, meta.storedPath);

    // Fast path: file already on disk → straight sendFile.
    if (fs.existsSync(abs)) {
      return res.sendFile(abs, {
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
    }

    // Otherwise this page is still extracting (fast mode Phase 2). Wait on it.
    // Free the slot if the client disconnects so we don't hold the request
    // open past the user's interest.
    let aborted = false;
    req.on('close', () => { aborted = true; });
    try {
      await cbzCache.waitForPageFile(extraction.dir, meta.storedPath);
    } catch (err) {
      if (aborted) return; // client gave up
      if (err.code === 'CHAPTER_REMOVED' || err.code === 'ARCHIVE_REMOVED') {
        return res.status(410).json({ error: 'Chapter was removed' });
      }
      if (err.code === 'PAGE_WAIT_TIMEOUT' || err.code === 'WAITER_OVERLOAD') {
        res.setHeader('Retry-After', '2');
        return res.status(503).json({ error: 'Page still extracting — try again' });
      }
      if (err.code === 'NO_ACTIVE_EXTRACTION') {
        // The extraction state was cleared between our ensureChapterExtracted
        // and waitForPageFile — either it finished (file should now exist) or
        // was evicted. Either way, recheck disk and send if present.
        if (fs.existsSync(abs)) {
          return res.sendFile(abs, {
            maxAge: 86_400_000,
            lastModified: true,
            etag: true,
            headers: { 'Content-Type': mimeFor(meta.storedPath) },
          });
        }
        return res.status(503).json({ error: 'Page no longer available — retry' });
      }
      return next(err);
    }

    if (aborted) return;
    return res.sendFile(abs, {
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
  }

  res.status(500).json({ error: `Unknown chapter type: ${meta.type}` });
}));

module.exports = router;
