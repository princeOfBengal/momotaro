const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { parseChapterInfo, getChapterPages, detectChapterType } = require('./chapterParser');
const { generateThumbnail } = require('./thumbnailGenerator');
const { findLocalMetadata } = require('./localMetadata');

const IMAGE_DIM_CONCURRENCY = 4;

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
 * Scan all libraries stored in the database.
 */
async function runFullScan() {
  const db = getDb();
  const libraries = db.prepare('SELECT * FROM libraries').all();

  if (libraries.length === 0) {
    console.log('[Scanner] No libraries configured — skipping scan.');
    return;
  }

  for (const library of libraries) {
    await scanLibrary(library);
  }
}

/**
 * Scan all manga directories in a single library.
 */
async function scanLibrary(library) {
  console.log(`[Scanner] Scanning library "${library.name}": ${library.path}`);

  if (!fs.existsSync(library.path)) {
    console.warn(`[Scanner] Library path does not exist: ${library.path}`);
    fs.mkdirSync(library.path, { recursive: true });
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

  for (const folderName of mangaDirs) {
    const mangaPath = path.join(library.path, folderName);
    try {
      await scanMangaDirectory(mangaPath, folderName, library.id);
    } catch (err) {
      console.error(`[Scanner] Error scanning ${folderName}:`, err.message);
    }
  }

  console.log(`[Scanner] Done scanning library "${library.name}".`);
}

/**
 * Scan a single manga directory. Idempotent — safe to call repeatedly.
 * Uses file_mtime on each chapter to skip re-processing unchanged content.
 */
async function scanMangaDirectory(mangaPath, folderName, libraryId = null) {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM manga WHERE path = ?').get(mangaPath);

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

  // Apply local JSON metadata if no external source has already populated it
  const currentMeta = db.prepare('SELECT metadata_source FROM manga WHERE id = ?').get(mangaId);
  if (currentMeta && currentMeta.metadata_source !== 'anilist') {
    const localMeta = findLocalMetadata(mangaPath);
    if (localMeta) {
      db.prepare(`
        UPDATE manga SET
          title           = COALESCE(?, title),
          description     = COALESCE(?, description),
          genres          = ?,
          year            = COALESCE(?, year),
          score           = COALESCE(?, score),
          metadata_source = 'local',
          updated_at      = unixepoch()
        WHERE id = ?
      `).run(
        localMeta.title,
        localMeta.description,
        JSON.stringify(localMeta.genres),
        localMeta.year,
        localMeta.score,
        mangaId
      );
      console.log(`[Scanner] Applied local metadata for: ${folderName}`);
    }
  }

  // Scan chapters
  let entries;
  try {
    entries = fs.readdirSync(mangaPath);
  } catch {
    return;
  }

  const chapterEntries = entries
    .filter(name => {
      const full = path.join(mangaPath, name);
      return detectChapterType(full) !== null;
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

  let coverPage = null;
  let lowestChapterNumber = Infinity;

  for (const name of chapterEntries) {
    const chapterPath = path.join(mangaPath, name);
    const type = detectChapterType(chapterPath);
    if (!type) continue;

    // Get current mtime for change detection
    let currentMtime = null;
    try {
      currentMtime = Math.floor(fs.statSync(chapterPath).mtimeMs / 1000);
    } catch { /* non-critical — will re-process */ }

    const { chapter: number, volume } = parseChapterInfo(name);

    const existingChapter = db.prepare(
      'SELECT * FROM chapters WHERE manga_id = ? AND folder_name = ?'
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

      // Skip expensive page re-indexing if mtime unchanged and pages already indexed
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

    // Resolve cover candidate even when skipping full re-index
    if (skipPageIndexing) {
      if (number !== null && number < lowestChapterNumber) {
        lowestChapterNumber = number;
        // Peek at the first page path from DB to use as cover
        const firstPage = db.prepare(
          'SELECT path FROM pages WHERE chapter_id = ? ORDER BY page_index ASC LIMIT 1'
        ).get(chapterId);
        if (firstPage) coverPage = firstPage.path;
      } else if (coverPage === null) {
        const firstPage = db.prepare(
          'SELECT path FROM pages WHERE chapter_id = ? ORDER BY page_index ASC LIMIT 1'
        ).get(chapterId);
        if (firstPage) coverPage = firstPage.path;
      }
      continue;
    }

    // Index pages with bounded concurrency for image dimension fetching
    const chapter = { id: chapterId, path: chapterPath, type };
    const pages = getChapterPages(chapter);

    if (pages.length > 0) {
      const dims = await withLimit(IMAGE_DIM_CONCURRENCY, pages, p => getImageDimensions(p.path));
      const pagesWithDims = pages.map((p, i) => ({ ...p, ...dims[i] }));

      const insertPage = db.prepare(`
        INSERT OR IGNORE INTO pages (chapter_id, page_index, filename, path, width, height)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      db.transaction((rows) => {
        rows.forEach((p, i) =>
          insertPage.run(chapterId, i, p.filename, p.path, p.width ?? null, p.height ?? null)
        );
      })(pagesWithDims);

      db.prepare('UPDATE chapters SET page_count = ?, file_mtime = ? WHERE id = ?')
        .run(pagesWithDims.length, currentMtime, chapterId);

      if (number !== null && number < lowestChapterNumber) {
        lowestChapterNumber = number;
        coverPage = pagesWithDims[0].path;
      } else if (coverPage === null) {
        coverPage = pagesWithDims[0].path;
      }
    }
  }

  // Generate thumbnail if we have a cover page and none exists yet
  if (coverPage && (!existing || !existing.cover_image)) {
    const thumbPath = await generateThumbnail(coverPage, mangaId);
    if (thumbPath) {
      db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
        .run(path.basename(thumbPath), mangaId);
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

module.exports = { runFullScan, scanLibrary, scanMangaDirectory };
