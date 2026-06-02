const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { parseChapterInfo, getChapterPages, detectChapterType } = require('./chapterParser');
const { generateThumbnail } = require('./thumbnailGenerator');
const { thumbnailPath, ensureShardDir } = require('./thumbnailPaths');
const { findLocalMetadata } = require('./localMetadata');
const { reinforceAllCovers } = require('./coverResolver');
const { enforceMetadataPriorityForLibrary } = require('../routes/metadata');
const cbzCache = require('./cbzCache');

// Concurrency knobs.
//   MANGA_CONCURRENCY — how many manga directories we walk in parallel. Sharp
//     and readdir are I/O heavy; 4 keeps a modern SSD busy without overwhelming
//     better-sqlite3's single-threaded writer queue.
//   IMAGE_DIM_CONCURRENCY — per-manga cap on concurrent sharp.metadata() calls
//     for folder-chapter pages. Combined worst case: MANGA × IMAGE_DIM.
const MANGA_CONCURRENCY     = 4;
const IMAGE_DIM_CONCURRENCY = 3;

// ─── Scan progress state ────────────────────────────────────────────────────
// Single shared state — only one scan can run at a time. Updated by
// runFullScan / scanLibrary and read by the /api/scan/status endpoint.
function makeIdleState() {
  return {
    running: false,
    trigger: null,              // 'startup' | 'manual-full' | 'manual-library'
    startedAt: null,            // unix ms
    finishedAt: null,           // unix ms of last completion
    currentLibrary: null,       // { id, name }
    totalLibraries: 0,
    completedLibraries: 0,
    currentMangaIndex: 0,       // count of manga completed in current library
    currentMangaTotal: 0,
    currentMangaName: null,     // last manga started (best-effort in parallel mode)
    lastError: null,
  };
}

let scanState = makeIdleState();

function getScanStatus() {
  const now = Date.now();
  const base = { ...scanState };
  if (scanState.startedAt) {
    const endTs = scanState.running ? now : (scanState.finishedAt || now);
    base.elapsedSeconds = Math.max(0, Math.floor((endTs - scanState.startedAt) / 1000));
  } else {
    base.elapsedSeconds = 0;
  }
  if (scanState.running && scanState.currentMangaIndex > 0 && scanState.currentMangaTotal > 0) {
    const libStart = scanState._currentLibraryStartedAt || scanState.startedAt;
    const perItemMs = (now - libStart) / scanState.currentMangaIndex;
    const remaining = Math.max(0, scanState.currentMangaTotal - scanState.currentMangaIndex);
    base.etaSeconds = Math.round((perItemMs * remaining) / 1000);
  } else {
    base.etaSeconds = null;
  }
  delete base._currentLibraryStartedAt;
  return base;
}

async function getImageDimensions(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    return { width: meta.width || null, height: meta.height || null };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Run fn(item) for each item with at most `limit` calls in flight at once.
 * Preserves input order in the returned array.
 */
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

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Delete a manga record and its thumbnail file.
 * CASCADE on the DB handles chapters / pages / progress automatically.
 *
 * Before the row is deleted we collect every CBZ chapter id and call
 * cbzCache.cancelChapters so any in-flight Phase 2 extractions stop cleanly:
 * abort signals fire, page waiters reject with CHAPTER_REMOVED (routed to
 * HTTP 410 by the reader's image route), the cache directories are removed,
 * and the in-memory state slots are dropped. Without this, a delete while a
 * reader is mid-binge leaves the request hanging until the per-page timeout.
 */
function removeManga(db, manga) {
  let chapterIds = [];
  try {
    chapterIds = db.prepare(
      "SELECT id FROM chapters WHERE manga_id = ? AND type = 'cbz'"
    ).all(manga.id).map(r => r.id);
  } catch (_) { /* table may be missing in tests — fine */ }
  if (chapterIds.length > 0) {
    cbzCache.cancelChapters(chapterIds, 'Manga removed');
  }
  db.prepare('DELETE FROM manga WHERE id = ?').run(manga.id);
  if (manga.cover_image) {
    try { fs.unlinkSync(thumbnailPath(manga.cover_image)); } catch (_) {}
  }
}

/**
 * Scan all libraries stored in the database.
 */
async function runFullScan({ force = false, trigger = 'manual-full' } = {}) {
  if (scanState.running) {
    console.warn('[Scanner] runFullScan called while a scan is already running — skipping.');
    return;
  }

  const db = getDb();
  const libraries = db.prepare(
    'SELECT id, name, path, last_scan_mtime_ms FROM libraries'
  ).all();

  if (libraries.length === 0) {
    console.log('[Scanner] No libraries configured — skipping scan.');
    return;
  }

  scanState = {
    ...makeIdleState(),
    running: true,
    trigger,
    startedAt: Date.now(),
    totalLibraries: libraries.length,
  };

  try {
    for (const library of libraries) {
      await scanLibrary(library, { force, _fromFullScan: true });
      scanState.completedLibraries++;
    }
  } catch (err) {
    scanState.lastError = err.message;
    console.error('[Scanner] Full scan failed:', err.message);
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
    scanState.currentLibrary = null;
    scanState.currentMangaName = null;
  }
}

/**
 * Scan all manga directories in a single library.
 *
 * When `force: false` (the default for startup scans), the library root's
 * mtime is compared against `libraries.last_scan_mtime_ms`. If unchanged, the
 * full walk is skipped — chapter-internal edits are still caught live by the
 * chokidar watcher, so the only thing this can miss is an offline edit that
 * doesn't bump the root mtime (e.g. replacing a CBZ inside an existing manga
 * folder with the server stopped). Manual scans via the API pass `force: true`
 * so that case is always a quick fix.
 */
async function scanLibrary(library, { force = false, _fromFullScan = false } = {}) {
  const claimedState = !_fromFullScan;
  if (claimedState) {
    if (scanState.running) {
      console.warn(`[Scanner] scanLibrary("${library.name}") called while a scan is already running — skipping.`);
      return;
    }
    scanState = {
      ...makeIdleState(),
      running: true,
      trigger: 'manual-library',
      startedAt: Date.now(),
      totalLibraries: 1,
    };
  }

  try {
    scanState.currentLibrary = { id: library.id, name: library.name };
    scanState.currentMangaIndex = 0;
    scanState.currentMangaTotal = 0;
    scanState.currentMangaName = null;
    scanState._currentLibraryStartedAt = Date.now();

    console.log(`[Scanner] Scanning library "${library.name}": ${library.path}`);

    if (!fs.existsSync(library.path)) {
      console.warn(`[Scanner] Library path does not exist: ${library.path}`);
      fs.mkdirSync(library.path, { recursive: true });
      return;
    }

    let rootMtimeMs = null;
    try {
      rootMtimeMs = fs.statSync(library.path).mtimeMs;
    } catch { /* best effort */ }

    if (!force && rootMtimeMs !== null && library.last_scan_mtime_ms === rootMtimeMs) {
      console.log(`[Scanner] "${library.name}" unchanged since last scan — skipping full walk.`);
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(library.path, { withFileTypes: true });
    } catch (err) {
      console.error(`[Scanner] Failed to read library directory "${library.name}":`, err.message);
      return;
    }

    const mangaDirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort(naturalSort);
    scanState.currentMangaTotal = mangaDirs.length;

    // Parallelize the outer loop — each manga is an independent unit of work.
    // DB writes serialize inside better-sqlite3 so correctness is preserved.
    await withLimit(MANGA_CONCURRENCY, mangaDirs, async (folderName) => {
      scanState.currentMangaName = folderName;
      const mangaPath = path.join(library.path, folderName);
      try {
        await scanMangaDirectory(mangaPath, folderName, library.id, { skipRollup: true });
      } catch (err) {
        console.error(`[Scanner] Error scanning ${folderName}:`, err.message);
      }
      scanState.currentMangaIndex++;
    });

    // Remove DB entries for manga whose folder no longer exists on disk
    const db = getDb();
    const libraryManga = db.prepare(
      'SELECT id, path, cover_image FROM manga WHERE library_id = ?'
    ).all(library.id);
    for (const m of libraryManga) {
      if (!fs.existsSync(m.path)) {
        removeManga(db, m);
        console.log(`[Scanner] Removed deleted manga: ${path.basename(m.path)}`);
      }
    }

    // Single grouped rollup for every manga in this library — runs one
    // SUM/GROUP BY pass over the chapters table instead of N correlated
    // subqueries (one per scanMangaDirectory call). Manga with no chapter
    // rows are force-zeroed separately so deletions propagate cleanly.
    db.prepare(`
      UPDATE manga
      SET bytes_on_disk = COALESCE(agg.bytes, 0),
          file_count    = COALESCE(agg.files, 0)
      FROM (
        SELECT c.manga_id,
               SUM(c.bytes_on_disk) AS bytes,
               SUM(c.file_count)    AS files
        FROM chapters c
        JOIN manga m ON m.id = c.manga_id
        WHERE m.library_id = ?
        GROUP BY c.manga_id
      ) AS agg
      WHERE manga.id = agg.manga_id
    `).run(library.id);

    db.prepare(`
      UPDATE manga
      SET bytes_on_disk = 0, file_count = 0
      WHERE library_id = ?
        AND NOT EXISTS (SELECT 1 FROM chapters WHERE manga_id = manga.id)
    `).run(library.id);

    if (rootMtimeMs !== null) {
      db.prepare('UPDATE libraries SET last_scan_mtime_ms = ? WHERE id = ?')
        .run(rootMtimeMs, library.id);
    }

    // Enforce metadata priority across the library *before* cover
    // reinforcement. For each manga whose displayed source isn't the
    // highest-priority remaining linkage (local > anilist > mal >
    // mangaupdates > doujinshi), re-apply from the on-disk per-source
    // cache. Cache hits avoid an upstream ping; if the cache is missing for
    // the chosen source, applyFallbackMetadata falls through to a network
    // fetch as a last resort. The cover reinforce pass below then sees the
    // post-enforcement metadata_source and picks the right active cover.
    try {
      const metaCounters = await enforceMetadataPriorityForLibrary(db, library.id);
      console.log(
        `[Scanner] Metadata priority enforced for "${library.name}": ` +
        `${metaCounters.switched} switched, ` +
        `${metaCounters.skipped} unchanged, ` +
        `${metaCounters.failed} failed ` +
        `(${metaCounters.checked} checked).`
      );
    } catch (err) {
      console.warn(`[Scanner] Metadata priority enforcement failed: ${err.message}`);
    }

    // Reinforce cover priority across the library. Re-aligns the visible
    // cover to the priority order (anilist > mal > mu > doujinshi >
    // original) for any manga whose `cover_user_set` flag is 0. Manga the
    // user has manually picked a cover for are skipped entirely — their
    // pick is sticky across scans, regardless of which third-party covers
    // happen to be on disk. The only path that clobbers a user pick is the
    // explicit Reset Thumbnails admin action (`POST /api/admin/reset-thumbnails`,
    // which still passes force=true).
    //
    // No upstream pings — this only re-uses cover files already on disk.
    try {
      const coverCounters = reinforceAllCovers(db, { libraryId: library.id, force: false });
      console.log(
        `[Scanner] Cover priority reinforced for "${library.name}": ` +
        `${coverCounters.changed_to_anilist} → AniList, ` +
        `${coverCounters.changed_to_mal} → MAL, ` +
        `${coverCounters.changed_to_mu} → MangaUpdates, ` +
        `${coverCounters.changed_to_doujinshi} → Doujinshi, ` +
        `${coverCounters.changed_to_original} → original, ` +
        `${coverCounters.kept_user} kept user pick, ` +
        `${coverCounters.kept_no_source} no source on disk, ` +
        `${coverCounters.errors} errors (${coverCounters.total} total).`
      );
    } catch (err) {
      console.warn(`[Scanner] Cover priority reinforcement failed: ${err.message}`);
    }

    // CBZ extract-cache orphan audit. Closes the watcher's depth-0 +
    // missing-unlinkDir blind spot: when a manga folder is removed (or
    // renamed, which the watcher sees as add+remove) the cache dirs for its
    // chapters become unreferenced. We've just finished pruning every dead
    // chapter row above, so the live chapters set is current — anything in
    // CBZ_CACHE_DIR whose chapter id isn't in that set is genuinely stale.
    try {
      cbzCache.auditOrphans(db);
    } catch (err) {
      console.warn(`[Scanner] CBZ cache orphan audit failed: ${err.message}`);
    }

    console.log(`[Scanner] Done scanning library "${library.name}".`);
  } finally {
    if (claimedState) {
      scanState.running = false;
      scanState.finishedAt = Date.now();
      scanState.currentLibrary = null;
      scanState.currentMangaName = null;
    }
  }
}

/**
 * Compute chapter-level disk stats.
 *   - For folder chapters: sum of image-file sizes (caller passes `pages`).
 *   - For CBZ chapters: the archive's own size on disk.
 * Returns { bytesOnDisk, fileCount }.
 */
function computeChapterStats(type, chapterPath, pages) {
  if (type === 'cbz') {
    let bytes = 0;
    try { bytes = fs.statSync(chapterPath).size; } catch { /* ignore */ }
    return { bytesOnDisk: bytes, fileCount: pages.length };
  }
  let bytes = 0;
  for (const p of pages) bytes += (p.size || 0);
  return { bytesOnDisk: bytes, fileCount: pages.length };
}

/**
 * Scan a single manga directory. Idempotent — safe to call repeatedly.
 * Uses file_mtime on each chapter to skip re-processing unchanged content.
 *
 * `skipRollup: true` suppresses the per-manga rollup UPDATE at the end of the
 * function. The bulk `scanLibrary` path sets this so it can run one grouped
 * rollup across every manga in the library in a single statement — see there
 * for rationale.
 */
async function scanMangaDirectory(mangaPath, folderName, libraryId = null, { skipRollup = false } = {}) {
  const db = getDb();

  // `cover_image` and `cover_user_set` are both needed by the thumbnail
  // regeneration guard at the bottom of this function. Previously this
  // query only selected `id, library_id`, which meant `existing.cover_image`
  // was always `undefined` for existing manga — and the guard
  // `if (coverPage && (!existing || !existing.cover_image))` evaluated to
  // `true` every single time. Result: every rescan (TPS chapter download,
  // file watcher event, per-manga refresh, optimize) overwrote the user's
  // active cover (AniList / MAL / MangaUpdates / Doujinshi.info / manual
  // pick) with the first page of the lowest-numbered chapter, with no
  // signal to the user. Reading the two columns now lets the guard
  // correctly distinguish "new manga, needs a generated cover" from
  // "existing manga, leave the priority-resolved cover alone".
  const existing = db.prepare(
    'SELECT id, library_id, cover_image, cover_user_set FROM manga WHERE path = ?'
  ).get(mangaPath);

  let mangaId;
  if (!existing) {
    const result = db.prepare(`
      INSERT INTO manga (library_id, folder_name, path, title, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `).run(libraryId, folderName, mangaPath, cleanTitle(folderName));
    mangaId = result.lastInsertRowid;
    console.log(`[Scanner] New manga: ${folderName}`);
  } else {
    mangaId = existing.id;
    db.prepare('UPDATE manga SET path = ?, library_id = ?, updated_at = unixepoch() WHERE id = ?')
      .run(mangaPath, libraryId ?? existing.library_id, mangaId);
  }

  // Apply local JSON metadata if a sidecar exists. Local has the highest
  // display priority, so it overrides AniList- or MAL-displayed fields when
  // present. Existing linkage IDs (`anilist_id`, `mal_id`, `doujinshi_id`)
  // are left untouched — adding a metadata.json never breaks an external
  // linkage. To remove the local metadata, delete the file from disk and
  // re-scan; or use Break Linkage in the UI.
  const localMeta = findLocalMetadata(mangaPath);
  if (localMeta) {
    db.prepare(`
      UPDATE manga SET
        title           = COALESCE(?, title),
        description     = COALESCE(?, description),
        genres          = ?,
        year            = COALESCE(?, year),
        score           = COALESCE(?, score),
        author          = COALESCE(?, author),
        metadata_source = 'local',
        updated_at      = unixepoch()
      WHERE id = ?
    `).run(
      localMeta.title,
      localMeta.description,
      JSON.stringify(localMeta.genres),
      localMeta.year,
      localMeta.score,
      localMeta.author,
      mangaId
    );
    console.log(`[Scanner] Applied local metadata for: ${folderName}`);
  }

  let entries;
  try {
    entries = fs.readdirSync(mangaPath);
  } catch {
    const mangaRecord = db.prepare('SELECT id, cover_image FROM manga WHERE id = ?').get(mangaId);
    if (mangaRecord) removeManga(db, mangaRecord);
    return;
  }

  const chapterEntries = entries
    .filter(name => {
      const full = path.join(mangaPath, name);
      try { return detectChapterType(full) !== null; } catch { return false; }
    })
    .sort(naturalSort);

  // Remove DB records for chapters no longer on disk. Cancel any active CBZ
  // extraction for these chapters first so an in-flight Phase 2 doesn't
  // continue writing into a directory the scanner is about to orphan, and
  // any reader holding pageWaiters gets a prompt CHAPTER_REMOVED rejection
  // (rendered as HTTP 410 by /api/pages/:id/image).
  const scannedSet = new Set(chapterEntries);
  const dbChapters = db.prepare('SELECT id, folder_name, type FROM chapters WHERE manga_id = ?').all(mangaId);
  const stale = dbChapters.filter(row => !scannedSet.has(row.folder_name));
  if (stale.length > 0) {
    const cbzIds = stale.filter(r => r.type === 'cbz').map(r => r.id);
    if (cbzIds.length > 0) cbzCache.cancelChapters(cbzIds, 'Chapter removed by scanner');
    for (const row of stale) {
      db.prepare('DELETE FROM chapters WHERE id = ?').run(row.id);
    }
  }

  if (chapterEntries.length === 0) {
    const mangaRecord = db.prepare('SELECT id, cover_image FROM manga WHERE id = ?').get(mangaId);
    if (mangaRecord) removeManga(db, mangaRecord);
    console.log(`[Scanner] Removed manga with no chapters: ${folderName}`);
    return;
  }

  let coverPage = null;                // { type, chapterPath, entryNameOrPath }
  let lowestChapterNumber = Infinity;

  for (const name of chapterEntries) {
    const chapterPath = path.join(mangaPath, name);
    const type = detectChapterType(chapterPath);
    if (!type) continue;

    let currentMtime = null;
    try {
      currentMtime = Math.floor(fs.statSync(chapterPath).mtimeMs / 1000);
    } catch { /* non-critical */ }

    const { chapter: number, volume } = parseChapterInfo(name);

    const existingChapter = db.prepare(
      'SELECT id, file_mtime, page_count FROM chapters WHERE manga_id = ? AND folder_name = ?'
    ).get(mangaId, name);

    let chapterId;
    let skipPageIndexing = false;

    if (!existingChapter) {
      const r = db.prepare(`
        INSERT INTO chapters (manga_id, folder_name, path, type, number, volume, title, file_mtime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(mangaId, name, chapterPath, type, number, volume, null, currentMtime);
      chapterId = r.lastInsertRowid;
    } else {
      chapterId = existingChapter.id;
      db.prepare('UPDATE chapters SET path = ?, type = ?, number = ?, volume = ? WHERE id = ?')
        .run(chapterPath, type, number, volume, chapterId);

      if (
        currentMtime !== null &&
        existingChapter.file_mtime === currentMtime &&
        existingChapter.page_count > 0
      ) {
        skipPageIndexing = true;
      } else {
        db.prepare('DELETE FROM pages WHERE chapter_id = ?').run(chapterId);
      }
    }

    if (skipPageIndexing) {
      if (number !== null && number < lowestChapterNumber) {
        lowestChapterNumber = number;
        const firstPage = db.prepare(
          'SELECT path FROM pages WHERE chapter_id = ? ORDER BY page_index ASC LIMIT 1'
        ).get(chapterId);
        if (firstPage) coverPage = { type, chapterPath, entry: firstPage.path };
      } else if (coverPage === null) {
        const firstPage = db.prepare(
          'SELECT path FROM pages WHERE chapter_id = ? ORDER BY page_index ASC LIMIT 1'
        ).get(chapterId);
        if (firstPage) coverPage = { type, chapterPath, entry: firstPage.path };
      }
      continue;
    }

    // Enumerate pages. For CBZ this just reads the ZIP central directory —
    // nothing is extracted to disk.
    const chapter = { id: chapterId, path: chapterPath, type };
    const pages = await getChapterPages(chapter);

    if (pages.length > 0) {
      // Read image dimensions only for folder chapters — CBZ pages would
      // require decompressing every page, which is exactly what streaming is
      // here to avoid. CBZ dimensions will be filled lazily by the reader.
      let pageRows;
      if (type === 'folder') {
        const dims = await withLimit(IMAGE_DIM_CONCURRENCY, pages, p => getImageDimensions(p.path));
        pageRows = pages.map((p, i) => ({ ...p, ...dims[i] }));
      } else {
        pageRows = pages.map(p => ({ ...p, width: null, height: null }));
      }

      const insertPage = db.prepare(`
        INSERT OR IGNORE INTO pages (chapter_id, page_index, filename, path, width, height)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rows) => {
        rows.forEach((p, i) =>
          insertPage.run(chapterId, i, p.filename, p.path, p.width ?? null, p.height ?? null)
        );
      })(pageRows);

      const { bytesOnDisk, fileCount } = computeChapterStats(type, chapterPath, pageRows);

      db.prepare(
        'UPDATE chapters SET page_count = ?, file_mtime = ?, bytes_on_disk = ?, file_count = ? WHERE id = ?'
      ).run(pageRows.length, currentMtime, bytesOnDisk, fileCount, chapterId);

      if (number !== null && number < lowestChapterNumber) {
        lowestChapterNumber = number;
        coverPage = { type, chapterPath, entry: pageRows[0].path };
      } else if (coverPage === null) {
        coverPage = { type, chapterPath, entry: pageRows[0].path };
      }
    }
  }

  // Roll up chapter stats to the manga row in a single query.
  // In bulk library scans this is skipped in favour of one grouped UPDATE over
  // every manga in the library — avoids N subquery passes over the chapters
  // table when we're about to walk every row anyway.
  if (!skipRollup) {
    db.prepare(`
      UPDATE manga
      SET bytes_on_disk = COALESCE(
            (SELECT SUM(bytes_on_disk) FROM chapters WHERE manga_id = ?), 0
          ),
          file_count    = COALESCE(
            (SELECT SUM(file_count)    FROM chapters WHERE manga_id = ?), 0
          )
      WHERE id = ?
    `).run(mangaId, mangaId, mangaId);
  }

  // Generate a cover from the first page ONLY when:
  //   - we have a usable first-page candidate (`coverPage`), AND
  //   - either the manga row was just inserted (existing === null), or
  //     the existing row has no active cover at all (cover_image IS NULL)
  //
  // A user-picked cover (`cover_user_set = 1`) is sticky and is NEVER
  // overwritten here. An existing manga whose active cover is already
  // resolved by the priority pipeline (AniList / MAL / MangaUpdates /
  // Doujinshi / original) is also left alone — we don't re-derive what's
  // already correct.
  //
  // After a legitimate generation (truly new manga), call
  // `reinforceActiveCover` so any third-party covers that happen to be on
  // disk (e.g. carried over from a previous metadata fetch on a
  // re-imported manga, or written by a parallel apply-metadata call
  // racing with this scan) still win over the auto-generated one.
  const needsGeneratedCover =
    coverPage
    && (existing === undefined || existing === null || !existing.cover_image)
    && !(existing && existing.cover_user_set);

  if (needsGeneratedCover) {
    const thumbPath = await generateThumbnail(coverPage, mangaId);
    if (thumbPath) {
      const originalName = `${mangaId}_original.webp`;
      const originalPath = thumbnailPath(originalName);
      if (!fs.existsSync(originalPath)) {
        try {
          ensureShardDir(originalName);
          fs.copyFileSync(thumbPath, originalPath);
        } catch (_) {}
      }
      db.prepare('UPDATE manga SET cover_image = ?, original_cover = COALESCE(original_cover, ?) WHERE id = ?')
        .run(path.basename(thumbPath), originalName, mangaId);

      // Defensive: if any higher-priority source cover is already on disk
      // for this manga, the priority resolver will swap it in over the
      // just-generated one. No-op when only the original is available.
      try {
        const { reinforceActiveCover } = require('./coverResolver');
        reinforceActiveCover(db, mangaId, { force: false });
      } catch (err) {
        console.warn(`[Scanner] post-generate cover reinforce failed for manga ${mangaId}: ${err.message}`);
      }
    }
  }
}

function cleanTitle(folderName) {
  return folderName
    .replace(/\[.*?\]/g, '')
    .replace(/\([\d]{4}\)/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { runFullScan, scanLibrary, scanMangaDirectory, getScanStatus, cleanTitle };
