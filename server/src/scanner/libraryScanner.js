const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { parseChapterInfo, getChapterPages, detectChapterType } = require('./chapterParser');
const { generateThumbnail } = require('./thumbnailGenerator');
const { findLocalMetadata } = require('./localMetadata');

async function getImageDimensions(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    return { width: meta.width || null, height: meta.height || null };
  } catch {
    return { width: null, height: null };
  }
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
 * @param {{ id: number, name: string, path: string }} library
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
 * @param {string} mangaPath  Full path to the manga directory.
 * @param {string} folderName Directory name.
 * @param {number|null} libraryId The library this manga belongs to.
 */
async function scanMangaDirectory(mangaPath, folderName, libraryId = null) {
  const db = getDb();

  // Upsert manga record — use path as the unique key so the same folder name
  // can exist in different libraries without colliding.
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

  // Apply local JSON metadata only when no external source (e.g. AniList) has
  // already populated the record.  Re-checked on every scan so that adding a
  // JSON file after the initial scan picks it up.
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

  // Remove DB records for chapters that no longer exist on disk (e.g. after rename/optimize)
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

    const { chapter: number, volume } = parseChapterInfo(name);

    // Upsert chapter
    const existingChapter = db.prepare(
      'SELECT * FROM chapters WHERE manga_id = ? AND folder_name = ?'
    ).get(mangaId, name);

    let chapterId;
    if (!existingChapter) {
      const r = db.prepare(`
        INSERT INTO chapters (manga_id, folder_name, path, type, number, volume, title)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(mangaId, name, chapterPath, type, number, volume, null);
      chapterId = r.lastInsertRowid;
    } else {
      chapterId = existingChapter.id;
      db.prepare('UPDATE chapters SET path = ?, type = ?, number = ?, volume = ? WHERE id = ?')
        .run(chapterPath, type, number, volume, chapterId);
      db.prepare('DELETE FROM pages WHERE chapter_id = ?').run(chapterId);
    }

    // Index pages
    const chapter = { id: chapterId, path: chapterPath, type };
    const pages = getChapterPages(chapter);

    if (pages.length > 0) {
      const pagesWithDims = await Promise.all(
        pages.map(async p => ({ ...p, ...(await getImageDimensions(p.path)) }))
      );

      const insertPage = db.prepare(`
        INSERT OR IGNORE INTO pages (chapter_id, page_index, filename, path, width, height)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertMany = db.transaction((pages) => {
        pages.forEach((p, i) => insertPage.run(chapterId, i, p.filename, p.path, p.width ?? null, p.height ?? null));
      });
      insertMany(pagesWithDims);

      db.prepare('UPDATE chapters SET page_count = ? WHERE id = ?')
        .run(pagesWithDims.length, chapterId);

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

/**
 * Clean a folder name into a readable title.
 */
function cleanTitle(folderName) {
  return folderName
    .replace(/\[.*?\]/g, '')
    .replace(/\([\d]{4}\)/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { runFullScan, scanLibrary, scanMangaDirectory };
