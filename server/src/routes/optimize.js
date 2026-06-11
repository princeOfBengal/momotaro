const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { parseChapterInfo, detectChapterType } = require('../scanner/chapterParser');
const { scanMangaDirectory } = require('../scanner/libraryScanner');
const taskRegistry = require('../admin/taskRegistry');

const router = express.Router();

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
function isImage(f) { return IMAGE_EXTS.has(path.extname(f).toLowerCase()); }
function naturalSort(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }

/**
 * Build a clean, standard chapter name from parsed info.
 * Examples: { volume: 3, chapter: 15 } → "Vol 3 Ch 15"
 *           { volume: null, chapter: 23.5 } → "Ch 23.5"
 *           { volume: 2, chapter: null } → "Vol 2"
 * Returns null if neither is present.
 */
function buildStandardName({ chapter, volume }) {
  if (volume !== null && chapter !== null) return `Vol ${volume} Ch ${chapter}`;
  if (chapter !== null) return `Ch ${chapter}`;
  if (volume !== null) return `Vol ${volume}`;
  return null;
}

/**
 * Convert a folder of images into a CBZ file at destCbzPath, then delete the folder.
 */
function folderToCbz(folderPath, destCbzPath) {
  const files = fs.readdirSync(folderPath).filter(isImage).sort(naturalSort);
  if (files.length === 0) throw new Error('No images found in folder');
  const zip = new AdmZip();
  for (const f of files) {
    zip.addFile(f, fs.readFileSync(path.join(folderPath, f)));
  }
  zip.writeZip(destCbzPath);
  fs.rmSync(folderPath, { recursive: true, force: true });
}

// Cached result of 7z binary search
let _7zBin = undefined;

function get7zBin() {
  if (_7zBin !== undefined) return _7zBin;
  const candidates = [
    '7z',
    '7za',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" i`, { stdio: 'ignore', timeout: 3000 });
      _7zBin = bin;
      return bin;
    } catch { /* not found, try next */ }
  }
  _7zBin = null;
  return null;
}

/**
 * Extract a .7z archive and repack as CBZ.
 * Returns true on success, false if 7-Zip binary not available.
 * Throws on extraction errors.
 */
function sevenZipToCbz(sevenZipPath, destCbzPath) {
  const bin = get7zBin();
  if (!bin) return false;

  const tmpDir = sevenZipPath + '_tmp_extract';
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`"${bin}" e "${sevenZipPath}" -o"${tmpDir}" -y -bd`, { stdio: 'ignore' });

    const files = fs.readdirSync(tmpDir).filter(isImage).sort(naturalSort);
    if (files.length === 0) throw new Error('No images found in .7z archive');

    const zip = new AdmZip();
    for (const f of files) {
      zip.addFile(f, fs.readFileSync(path.join(tmpDir, f)));
    }
    zip.writeZip(destCbzPath);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(sevenZipPath);
    return true;
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Core optimize logic for a single manga. Renames/converts chapters to CBZ
 * with standardized names, then rescans the manga directory.
 */
async function performOptimize(manga) {
  const summary = { renamed: 0, converted: 0, skipped: [], errors: [] };

  let entries;
  try {
    entries = fs.readdirSync(manga.path);
  } catch (err) {
    throw new Error('Could not read directory: ' + err.message);
  }

  // Collect all recognized chapter/volume entries with parsed info
  const toProcess = [];
  for (const name of entries) {
    const fullPath = path.join(manga.path, name);
    let type;
    try { type = detectChapterType(fullPath); } catch { continue; }
    if (!type) continue;

    const info = parseChapterInfo(name);
    const stdName = buildStandardName(info);
    toProcess.push({ name, fullPath, type, stdName });
  }

  // Detect target-name conflicts (two entries resolving to the same standard name)
  const nameCount = {};
  for (const e of toProcess) {
    if (e.stdName) nameCount[e.stdName] = (nameCount[e.stdName] || 0) + 1;
  }

  for (const { name, fullPath, type, stdName } of toProcess) {
    const ext = type === 'folder' ? '' : path.extname(name).toLowerCase();

    // Handle conflict
    if (stdName && nameCount[stdName] > 1) {
      summary.skipped.push({ name, reason: `Name conflict: multiple entries map to "${stdName}.cbz"` });
      continue;
    }

    // Determine destination CBZ path
    let targetCbzPath;
    if (stdName) {
      targetCbzPath = path.join(manga.path, stdName + '.cbz');
    } else {
      // Can't parse a number — convert format in place but keep the basename
      if (type === 'cbz') {
        summary.skipped.push({ name, reason: 'Could not parse chapter/volume number' });
        continue;
      }
      const base = path.basename(name, ext);
      targetCbzPath = path.join(manga.path, base + '.cbz');
    }

    try {
      if (type === 'folder') {
        folderToCbz(fullPath, targetCbzPath);
        summary.converted++;
        if (stdName && name !== stdName) summary.renamed++;

      } else if (ext === '.zip') {
        fs.renameSync(fullPath, targetCbzPath);
        summary.converted++;
        if (stdName && name !== stdName + '.cbz') summary.renamed++;

      } else if (ext === '.7z') {
        const ok = sevenZipToCbz(fullPath, targetCbzPath);
        if (!ok) {
          summary.skipped.push({ name, reason: '7-Zip not installed — cannot convert .7z files' });
        } else {
          summary.converted++;
          if (stdName && name !== stdName + '.cbz') summary.renamed++;
        }

      } else if (ext === '.cbz') {
        if (fullPath !== targetCbzPath) {
          fs.renameSync(fullPath, targetCbzPath);
          summary.renamed++;
        }
        // already correct — nothing to do
      }
    } catch (err) {
      summary.errors.push({ name, error: err.message });
    }
  }

  // Rescan so the DB reflects the new file names
  try {
    await scanMangaDirectory(manga.path, manga.folder_name, manga.library_id, { source: 'optimize' });
  } catch (err) {
    console.error('[Optimize] Rescan error:', err.message);
  }

  return summary;
}

// POST /api/manga/:id/optimize
//
// Returns 202 with the initial task state. Runs in the background — disk
// I/O for a folder-to-CBZ conversion can take a while on a large manga
// with hundreds of chapters. Keyed by manga_id so two different manga can
// optimize concurrently; a second start for the same manga returns 409.
router.post('/manga/:id/optimize', asyncWrapper(async (req, res) => {
  const db = getDb();
  const mangaId = parseInt(req.params.id, 10);
  if (!Number.isFinite(mangaId)) return res.status(400).json({ error: 'Invalid manga id' });

  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(mangaId);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });
  if (!fs.existsSync(manga.path)) {
    return res.status(400).json({ error: 'Manga directory not found on disk' });
  }

  const result = taskRegistry.start('optimize-manga', mangaId, async () => {
    return await performOptimize(manga);
  });
  if (!result.ok) {
    return res.status(409).json({ error: 'Optimize already in progress for this manga', status: result.state });
  }
  res.status(202).json({ data: { status: result.state } });
}));

router.get('/manga/:id/optimize/status', asyncWrapper(async (req, res) => {
  const mangaId = parseInt(req.params.id, 10);
  if (!Number.isFinite(mangaId)) return res.status(400).json({ error: 'Invalid manga id' });
  res.json({ data: taskRegistry.get('optimize-manga', mangaId) });
}));

// POST /api/libraries/:id/bulk-optimize — optimize every manga in a library
//
// Returns 202 with the initial task state. The runner walks the library
// and reports progress as `(processed, total, currentMangaName)` so the UI
// can show "Optimizing 242 / 1,847 — One Piece". Keyed by library_id so
// two libraries can bulk-optimize concurrently; a second start for the
// same library returns 409.
router.post('/libraries/:id/bulk-optimize', asyncWrapper(async (req, res) => {
  const db = getDb();
  const libraryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(libraryId)) return res.status(400).json({ error: 'Invalid library id' });

  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const mangaList = db.prepare('SELECT * FROM manga WHERE library_id = ? AND path IS NOT NULL').all(library.id);

  const result = taskRegistry.start('bulk-optimize-library', libraryId, async (report) => {
    let processed = 0;
    let errors = 0;
    report(0, mangaList.length, library.name);
    for (const manga of mangaList) {
      processed++;
      if (!fs.existsSync(manga.path)) {
        console.warn(`[BulkOptimize] Skipping "${manga.folder_name}" — path not found`);
        report(processed, mangaList.length, manga.folder_name);
        continue;
      }
      try {
        const summary = await performOptimize(manga);
        console.log(`[BulkOptimize] "${manga.folder_name}": renamed=${summary.renamed} converted=${summary.converted} errors=${summary.errors.length}`);
      } catch (err) {
        errors++;
        console.warn(`[BulkOptimize] Error for "${manga.folder_name}": ${err.message}`);
      }
      report(processed, mangaList.length, manga.folder_name);
    }
    console.log(`[BulkOptimize] Finished for library "${library.name}" (${mangaList.length} entries)`);
    return { total: mangaList.length, errors };
  });
  if (!result.ok) {
    return res.status(409).json({ error: 'Bulk optimize already in progress for this library', status: result.state });
  }
  res.status(202).json({ data: { status: result.state } });
}));

router.get('/libraries/:id/bulk-optimize/status', asyncWrapper(async (req, res) => {
  const libraryId = parseInt(req.params.id, 10);
  if (!Number.isFinite(libraryId)) return res.status(400).json({ error: 'Invalid library id' });
  res.json({ data: taskRegistry.get('bulk-optimize-library', libraryId) });
}));

module.exports = router;
