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
 * Render one axis of a span: "15" for a single number, "17-18" for a range.
 */
function fmtSpan(start, end) {
  return end != null && end !== start ? `${start}-${end}` : `${start}`;
}

/**
 * Build a clean, standard chapter name from parsed info. Range-aware: a single
 * file can span multiple chapters/volumes.
 * Examples: { volume: 3, chapter: 15 }                       → "Vol 3 Ch 15"
 *           { volume: 17, volumeEnd: 18 }                    → "Vol 17-18"
 *           { chapter: 10, chapterEnd: 12 }                  → "Ch 10-12"
 *           { volume: 1, volumeEnd: 2, chapter: 5, chapterEnd: 12 } → "Vol 1-2 Ch 5-12"
 * Returns null if neither is present.
 */
function buildStandardName({ chapter, chapterEnd, volume, volumeEnd }) {
  const v = volume  !== null ? `Vol ${fmtSpan(volume, volumeEnd)}`  : null;
  const c = chapter !== null ? `Ch ${fmtSpan(chapter, chapterEnd)}` : null;
  if (v && c) return `${v} ${c}`;
  if (c) return c;
  if (v) return v;
  return null;
}

// ── Progress reconciliation across a standardizing rename ────────────────────
//
// Renaming a chapter file changes its folder_name, so the incremental scanner
// deletes the old chapters row and inserts a new one with a fresh id. That id
// churn would otherwise orphan read-state: `progress.completed_chapters` (a JSON
// blob of chapter ids, untouched by the delete) keeps pointing at the dead id,
// and `progress.current_chapter_id` is wiped to NULL by its ON DELETE SET NULL.
//
// The parsed span tuple (number/number_end/volume/volume_end) is INVARIANT
// across a standardizing rename — "Yamada v17-18" and "Vol 17-18" both parse to
// volume 17–18 — so we map old id → new id by matching that tuple within the
// manga and rewrite every user's progress row.

function snapshotChapterTuples(db, mangaId) {
  return db.prepare(
    'SELECT id, number, number_end, volume, volume_end FROM chapters WHERE manga_id = ?'
  ).all(mangaId);
}

function tupleKey(r) {
  return `${r.number}|${r.number_end}|${r.volume}|${r.volume_end}`;
}

// old id → new id, only for tuples that are unique on BOTH sides (ambiguous
// duplicates are left alone — safer to under-reconcile than to mis-map).
function buildIdRemap(oldRows, newRows) {
  const tally = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(tupleKey(r), (m.get(tupleKey(r)) || 0) + 1);
    return m;
  };
  const oldCounts = tally(oldRows);
  const newCounts = tally(newRows);
  const newByKey = new Map(newRows.map(r => [tupleKey(r), r.id]));

  const remap = new Map();
  for (const r of oldRows) {
    const k = tupleKey(r);
    if (oldCounts.get(k) === 1 && newCounts.get(k) === 1) {
      const newId = newByKey.get(k);
      if (newId != null && newId !== r.id) remap.set(r.id, newId);
    }
  }
  return remap;
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
  const db = getDb();
  const summary = { renamed: 0, converted: 0, skipped: [], errors: [] };

  let entries;
  try {
    entries = fs.readdirSync(manga.path);
  } catch (err) {
    throw new Error('Could not read directory: ' + err.message);
  }

  // Snapshot read-state BEFORE the renames churn chapter ids. `current_chapter_id`
  // is captured here because its ON DELETE SET NULL wipes it during the rescan;
  // `completed_chapters` is a JSON blob the delete doesn't touch, so it's re-read
  // fresh afterwards (which also avoids clobbering a concurrent read mid-optimize).
  const oldChapters = snapshotChapterTuples(db, manga.id);
  const preCurrent = new Map(); // user_id → current_chapter_id at snapshot time
  for (const p of db.prepare('SELECT user_id, current_chapter_id FROM progress WHERE manga_id = ?').all(manga.id)) {
    preCurrent.set(p.user_id, p.current_chapter_id);
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

  // Carry read-state across the rename-induced id churn (see buildIdRemap).
  try {
    const newChapters = snapshotChapterTuples(db, manga.id);
    const remap = buildIdRemap(oldChapters, newChapters);
    if (remap.size > 0) {
      const liveIds = new Set(newChapters.map(c => c.id));
      const remapId = (id) => (id == null ? null : (remap.get(id) ?? id));
      const rows = db.prepare(
        'SELECT user_id, current_chapter_id, completed_chapters FROM progress WHERE manga_id = ?'
      ).all(manga.id);
      const upd = db.prepare(
        'UPDATE progress SET current_chapter_id = ?, completed_chapters = ? WHERE manga_id = ? AND user_id = ?'
      );
      db.transaction(() => {
        for (const p of rows) {
          let completed;
          try { completed = JSON.parse(p.completed_chapters || '[]'); } catch { completed = []; }
          completed = [...new Set(completed.map(remapId).filter(id => liveIds.has(id)))];
          // current_chapter_id was nulled by the delete — restore from the
          // pre-rename snapshot only if nothing re-set it in the meantime.
          let current = p.current_chapter_id;
          if (current == null) {
            const restored = remapId(preCurrent.get(p.user_id));
            current = (restored != null && liveIds.has(restored)) ? restored : null;
          }
          upd.run(current, JSON.stringify(completed), manga.id, p.user_id);
        }
      })();
    }
  } catch (err) {
    console.warn('[Optimize] Progress reconciliation failed:', err.message);
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
