const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { parseChapterInfo, getChapterPages, detectChapterType } = require('./chapterParser');
const { generateThumbnail } = require('./thumbnailGenerator');
const { thumbnailPath, ensureShardDir } = require('./thumbnailPaths');
const { findLocalMetadata } = require('./localMetadata');

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
 */
function removeManga(db, manga) {
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

  const existing = db.prepare('SELECT id, library_id FROM manga WHERE path = ?').get(mangaPath);

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

  // Remove DB records for chapters no longer on disk
  const scannedSet = new Set(chapterEntries);
  const dbChapters = db.prepare('SELECT id, folder_name FROM chapters WHERE manga_id = ?').all(mangaId);
  for (const row of dbChapters) {
    if (!scannedSet.has(row.folder_name)) {
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

  // Generate thumbnail if we have a cover candidate and none exists yet.
  if (coverPage && (!existing || !existing.cover_image)) {
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

module.exports = { runFullScan, scanLibrary, scanMangaDirectory, getScanStatus };
