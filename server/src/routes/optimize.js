const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { parseChapterInfo, detectExtraInfo, detectExtraLabel, detectChapterType, invalidateCbzCache } = require('../scanner/chapterParser');
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
function buildStandardName({ chapter, chapterEnd, volume, volumeEnd }, extraLabel = null) {
  const v = volume  !== null ? `Vol ${fmtSpan(volume, volumeEnd)}`  : null;
  const c = chapter !== null ? `Ch ${fmtSpan(chapter, chapterEnd)}` : null;
  const base = v && c ? `${v} ${c}` : (c || v);
  if (!base) return null;
  // Keep the extra-content tag so "Ch 5 Omake" doesn't collapse onto "Ch 5"
  // and the label survives the rename (detectExtraLabel re-reads it).
  return extraLabel ? `${base} ${extraLabel}` : base;
}

/**
 * True when `stdName` re-parses to the same span tuple and extra label as the
 * entry it was built from — i.e. the rename preserves the entry's identity.
 * A standard name always starts with its number, so the scanner's folder-wide
 * title-position rules can't change its label; single-name detection matches.
 */
function standardNameRoundTrips(stdName, info, extraLabel, seriesName) {
  const re = parseChapterInfo(stdName + '.cbz');
  return re.chapter === info.chapter && re.chapterEnd === info.chapterEnd &&
         re.volume === info.volume && re.volumeEnd === info.volumeEnd &&
         detectExtraLabel(stdName + '.cbz', seriesName) === extraLabel;
}

// ── Progress reconciliation across a standardizing rename ────────────────────
//
// Renaming a chapter file changes its folder_name, so the incremental scanner
// deletes the old chapters row and inserts a new one with a fresh id. That id
// churn would otherwise orphan read-state: `progress.completed_chapters` (a JSON
// blob of chapter ids, untouched by the delete) keeps pointing at the dead id,
// and `progress.current_chapter_id` is wiped to NULL by its ON DELETE SET NULL.
//
// The parsed span tuple (number/number_end/volume/volume_end, plus the extra
// label) is INVARIANT across a standardizing rename — "Yamada v17-18" and
// "Vol 17-18" both parse to volume 17–18, "Ch 5 - Omake" and "Ch 5 Omake" both
// to chapter 5 / Omake — so we map old id → new id by matching that tuple
// within the manga and rewrite every user's progress row.

function snapshotChapterTuples(db, mangaId) {
  return db.prepare(
    'SELECT id, folder_name, number, number_end, volume, volume_end, extra_label FROM chapters WHERE manga_id = ?'
  ).all(mangaId);
}

function tupleKey(r) {
  return `${r.number}|${r.number_end}|${r.volume}|${r.volume_end}|${r.extra_label}`;
}

// old id → new id, only for tuples that are unique on BOTH sides (ambiguous
// duplicates are left alone — safer to under-reconcile than to mis-map).
//
// `dedupedTo` (deleted entry name → kept entry name) covers duplicates removed
// by this run: the old side had several rows for the tuple, but we know which
// one survived. The survivor's own row is matched by tuple (treated as unique),
// and each deleted row is then pointed explicitly at wherever the survivor
// ended up — its new id if it was renamed, its unchanged id if it wasn't. The
// explicit step matters when a delete FAILED in a 3+ copy group: the survivor
// and the failed copy both fall through to the name-conflict skip, the tuple
// stays ambiguous on the new side, and without it the deleted copies'
// read-state would be dropped.
function buildIdRemap(oldRows, newRows, dedupedTo = new Map()) {
  const tally = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(tupleKey(r), (m.get(tupleKey(r)) || 0) + 1);
    return m;
  };
  const oldCounts = tally(oldRows);
  const newCounts = tally(newRows);
  const newByKey = new Map(newRows.map(r => [tupleKey(r), r.id]));

  // Tuple keys of the duplicate groups this run collapsed to a single survivor.
  const oldByName = new Map(oldRows.map(r => [r.folder_name, r]));
  const dedupedKeys = new Set();
  for (const keptName of dedupedTo.values()) {
    const kept = oldByName.get(keptName);
    if (kept) dedupedKeys.add(tupleKey(kept));
  }

  const remap = new Map();
  for (const r of oldRows) {
    const k = tupleKey(r);
    const oldUnique = oldCounts.get(k) === 1 || dedupedKeys.has(k);
    if (oldUnique && newCounts.get(k) === 1) {
      const newId = newByKey.get(k);
      if (newId != null && newId !== r.id) remap.set(r.id, newId);
    }
  }

  // Deleted copies → the survivor's final id. Liveness is checked by the
  // caller, which drops any target that isn't a current chapter row.
  for (const [deletedName, keptName] of dedupedTo) {
    const deleted = oldByName.get(deletedName);
    const kept = oldByName.get(keptName);
    if (!deleted || !kept) continue;
    remap.set(deleted.id, remap.get(kept.id) ?? kept.id);
  }
  return remap;
}

/**
 * Size on disk of a chapter entry: the file size for an archive, or the sum of
 * the top-level files for a folder of images.
 */
function entrySize(fullPath, type) {
  if (type !== 'folder') return fs.statSync(fullPath).size;
  let total = 0;
  for (const f of fs.readdirSync(fullPath)) {
    const st = fs.statSync(path.join(fullPath, f));
    if (st.isFile()) total += st.size;
  }
  return total;
}

/**
 * Collapse duplicate chapters/volumes — entries that resolve to the same
 * standard name, e.g. two copies of "Vol 1" — down to the largest copy on
 * disk. The smaller copies are deleted and dropped from `toProcess`, so the
 * survivor then flows through the normal rename/convert path.
 *
 * Ties keep the entry already sitting at the target name, else the first in
 * natural order. Any copy whose delete fails stays in `toProcess`, so the
 * group falls through to the existing name-conflict skip.
 *
 * Extras are never deduplicated: two "Ch 5 Bonus" files are far more likely
 * to be different bonus pieces than copies of one. They still hit the
 * name-conflict skip, which leaves both files alone. This keys off
 * `hasExtraKeyword` (any keyword in the name) rather than the label. Entries
 * whose label was suppressed as series naming never get here — performOptimize
 * leaves them untouched — so the check is a second line of defence.
 *
 * Returns a Map of deleted entry name → kept entry name.
 */
function removeSmallerDuplicates(toProcess, summary, ctx) {
  const groups = new Map();
  for (const e of toProcess) {
    if (!e.stdName || e.hasExtraKeyword) continue;
    if (!groups.has(e.stdName)) groups.set(e.stdName, []);
    groups.get(e.stdName).push(e);
  }

  const dedupedTo = new Map();
  const removed = new Set();
  for (const [stdName, group] of groups) {
    if (group.length < 2) continue;

    let sized;
    try {
      sized = group.map(e => ({ e, size: entrySize(e.fullPath, e.type) }));
    } catch (err) {
      summary.errors.push({ name: stdName, error: 'Could not size duplicates: ' + err.message });
      continue;
    }
    const target = stdName + '.cbz';
    sized.sort((a, b) =>
      (b.size - a.size) ||
      ((b.e.name === target) - (a.e.name === target)) ||
      naturalSort(a.e.name, b.e.name)
    );
    const keep = sized[0];

    const groupRemoved = [];
    for (const { e, size } of sized.slice(1)) {
      try {
        if (e.type === 'folder') {
          // Same as a converted folder: keep its metadata (a failed move
          // throws before anything is deleted, leaving the copy in place).
          // Archived only for now — promoteDeferredMetadata offers each file
          // the series-level name after the kept chapters are converted.
          const moves = moveMetadataOut(e.fullPath, ctx, e.name, { seriesLevel: false });
          for (const m of moves) {
            const logEntry = { name: `${e.name}/${path.basename(m.from)}`, movedTo: displayPath(ctx.seriesPath, m.to) };
            summary.metadataMoved.push(logEntry);
            ctx.deferred.push({ path: m.to, originalName: path.basename(m.from), logEntry });
          }
          fs.rmSync(e.fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(e.fullPath);
          invalidateCbzCache(e.fullPath);
        }
        groupRemoved.push(e);
        dedupedTo.set(e.name, keep.e.name);
        summary.duplicatesRemoved.push({ name: e.name, size, keptName: keep.e.name, keptSize: keep.size });
      } catch (err) {
        summary.errors.push({ name: e.name, error: 'Could not delete duplicate: ' + err.message });
      }
    }
    for (const e of groupRemoved) removed.add(e);
  }

  if (removed.size > 0) {
    const remaining = toProcess.filter(e => !removed.has(e));
    toProcess.length = 0;
    toProcess.push(...remaining);
  }
  return dedupedTo;
}

// Metadata that can sit next to a chapter's images: ComicInfo.xml, scraper /
// gallery JSON (metadata.json, info.json, <image>.json sidecars, …), OPF, NFO.
const METADATA_FILE_RE = /\.(json|xml|opf|nfo)$/i;

/**
 * Folder (inside the series folder) holding per-chapter metadata variants
 * that can't take the series-level name. Candidates, in order: "metadata",
 * "_metadata", "_metadata (2)", … Chosen once per optimize run:
 *
 *   1. An EXISTING candidate usable as an archive (a directory with no images
 *      directly inside) wins, so the archive doesn't move between runs. E.g. a
 *      chapter folder of images called "metadata" pushes the first run to
 *      "_metadata"; once that chapter is packed to metadata.cbz, "metadata" is
 *      free again — but "_metadata" already exists and keeps being used.
 *   2. Otherwise the first candidate that's free (no file or folder by that
 *      name, ignoring case).
 *
 * The folder only ever holds subfolders, so the scanner never treats it as a
 * chapter.
 */
function archiveCandidateIndex(name) {
  const lower = name.toLowerCase();
  if (lower === 'metadata') return 0;
  if (lower === '_metadata') return 1;
  const m = /^_metadata \((\d+)\)$/.exec(lower);
  return m && Number(m[1]) >= 2 ? Number(m[1]) : -1;
}

function archiveCandidateName(i) {
  return i === 0 ? 'metadata' : i === 1 ? '_metadata' : `_metadata (${i})`;
}

function resolveArchiveDirName(seriesPath) {
  let names = [];
  try { names = fs.readdirSync(seriesPath); } catch { /* fall through to a fresh name */ }
  const existing = names
    .map(n => ({ n, i: archiveCandidateIndex(n) }))
    .filter(c => c.i >= 0)
    .sort((a, b) => a.i - b.i);
  for (const { n } of existing) {
    try {
      const p = path.join(seriesPath, n);
      if (fs.statSync(p).isDirectory() && !fs.readdirSync(p).some(isImage)) return n;
    } catch { /* unreadable — not usable */ }
  }
  const taken = new Set(existing.map(c => c.i));
  for (let i = 0; ; i++) {
    if (!taken.has(i)) return archiveCandidateName(i);
  }
}

/**
 * Path of the entry in `dir` whose name equals `name` ignoring case, or null.
 * Destination checks use this on every platform so a chapter's
 * "comicinfo.xml" never lands beside the series' "ComicInfo.xml" on a
 * case-sensitive filesystem — the scanner matches that name case-insensitively
 * and would pick either.
 */
function findCaseInsensitive(dir, name) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const want = name.toLowerCase();
  const hit = names.find(n => n.toLowerCase() === want);
  return hit === undefined ? null : path.join(dir, hit);
}

/**
 * Move a chapter folder's metadata files up into the series folder so they
 * survive the folder being packed and deleted. The series folder is also the
 * first place findLocalMetadata looks (chapter folders are only its fallback,
 * and stop existing after conversion), so local metadata keeps applying.
 *
 * Where each file goes:
 *   1. "<series>/<name>" when that name is free — the first chapter's
 *      ComicInfo.xml / info.json becomes the series-level copy.
 *   2. Nowhere, when a file with the same name AND bytes is already in the
 *      series folder (or in this chapter's archive folder) — the redundant copy
 *      goes away with the chapter folder.
 *   3. Otherwise — or always, with `seriesLevel: false` — the run's archive
 *      folder: "<series>/<archive>/<chapter>/<name>" (see
 *      resolveArchiveDirName). Per-chapter variants (every chapter has its
 *      own ComicInfo.xml) keep their original names without cluttering the
 *      series folder; " (2)", " (3)" … appended on a further clash.
 *
 * Name checks ignore case on every platform (see findCaseInsensitive).
 *
 * `seriesLevel: false` is for duplicate copies being deleted, which run before
 * any folder is converted: a discarded copy must not claim the series-level
 * name ahead of the kept chapters. Its archived files are queued on
 * `ctx.deferred` and promoted by promoteDeferredMetadata once the conversions
 * have had first claim.
 *
 * `ctx` = { seriesPath, archiveDirName, deferred } for the current run.
 * Returns the moves performed ([{ from, to }], absolute paths, plus a
 * `createdDirs` list) so the caller can undo them if packing fails.
 */
function moveMetadataOut(folderPath, ctx, chapterName, { seriesLevel = true } = {}) {
  const { seriesPath } = ctx;
  const moves = [];
  const createdDirs = [];
  const sameFile = (p, bytes) => fs.statSync(p).isFile() && fs.readFileSync(p).equals(bytes);
  try {
    for (const f of fs.readdirSync(folderPath).filter(n => METADATA_FILE_RE.test(n)).sort(naturalSort)) {
      const src = path.join(folderPath, f);
      if (!fs.statSync(src).isFile()) continue;
      const bytes = fs.readFileSync(src);

      let dest;
      const seriesCopy = findCaseInsensitive(seriesPath, f);
      if (seriesCopy && sameFile(seriesCopy, bytes)) continue;
      if (!seriesCopy && seriesLevel) {
        dest = path.join(seriesPath, f);
      } else {
        const archiveDir = path.join(seriesPath, ctx.archiveDirName, chapterName);
        const ext = path.extname(f);
        const stem = f.slice(0, f.length - ext.length);
        dest = null;
        for (let i = 1; ; i++) {
          const candidate = i === 1 ? f : `${stem} (${i})${ext}`;
          const existing = findCaseInsensitive(archiveDir, candidate);
          if (!existing) { dest = path.join(archiveDir, candidate); break; }
          if (sameFile(existing, bytes)) break;
        }
        if (!dest) continue;
        if (!fs.existsSync(archiveDir)) {
          fs.mkdirSync(archiveDir, { recursive: true });
          createdDirs.push(archiveDir);
        }
      }
      fs.renameSync(src, dest);
      moves.push({ from: src, to: dest });
    }
  } catch (err) {
    undoMoves(moves);
    removeEmptyDirs(createdDirs, ctx);
    throw new Error('Could not move metadata out of folder: ' + err.message);
  }
  moves.createdDirs = createdDirs;
  return moves;
}

/**
 * Second pass for metadata archived from deleted duplicate copies: once every
 * kept chapter has been converted (and so had first claim on the series-level
 * names), move each archived file up to the series folder if that name —
 * ignoring case — is still free. Without this, a series whose only
 * ComicInfo.xml / info.json lived in a discarded copy would keep the file on
 * disk but lose it in the app (findLocalMetadata doesn't read the archive).
 * Promotes under the file's ORIGINAL name — the archived copy may carry a
 * " (2)" suffix, which findLocalMetadata wouldn't recognise as ComicInfo.xml /
 * info.json; if the original name is taken (ignoring case), the file stays
 * archived. Updates each file's result-log entry and drops archive folders
 * left empty.
 */
function promoteDeferredMetadata(ctx) {
  const emptied = [];
  for (const d of ctx.deferred) {
    if (!fs.existsSync(d.path)) continue;
    const name = d.originalName;
    if (findCaseInsensitive(ctx.seriesPath, name)) continue;
    const dest = path.join(ctx.seriesPath, name);
    try {
      fs.renameSync(d.path, dest);
    } catch (err) {
      console.warn(`[Optimize] Could not promote "${d.path}" to the series folder: ${err.message}`);
      continue;
    }
    if (d.logEntry) d.logEntry.movedTo = displayPath(ctx.seriesPath, dest);
    emptied.push(path.dirname(d.path));
  }
  removeEmptyDirs(emptied, ctx);
}

function undoMoves(moves) {
  for (const { from, to } of [...moves].reverse()) {
    try { fs.renameSync(to, from); } catch (err) {
      console.warn(`[Optimize] Could not move "${to}" back into its chapter folder: ${err.message}`);
    }
  }
}

/**
 * True when `target` exists and is a different file from `source`. Identity is
 * by device + inode (file index on Windows), not by name: a case-only rename
 * ("ch 1.cbz" → "Ch 1.cbz") on a case-insensitive filesystem resolves to the
 * source itself and is allowed, while on Linux the two names are distinct
 * files and the target is protected. A filesystem that reports no inode falls
 * back to comparing resolved paths (case-insensitively on Windows / macOS).
 */
function targetOccupiedByOther(source, target) {
  let t;
  try { t = fs.statSync(target, { bigint: true }); } catch { return false; }
  let s;
  try { s = fs.statSync(source, { bigint: true }); } catch { return true; }
  if (t.ino !== 0n && s.ino !== 0n) return !(t.ino === s.ino && t.dev === s.dev);
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(source) !== norm(target);
}

// Series-relative path for the result log, "/"-separated on every platform.
function displayPath(seriesPath, p) {
  return path.relative(seriesPath, p).split(path.sep).join('/');
}

// Remove the given archive dirs if empty (and the run's archive root too, if
// that leaves it empty). Never touches a directory that still has contents.
function removeEmptyDirs(dirs, ctx) {
  const tryRemove = (d) => { try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* keep */ } };
  for (const d of new Set(dirs)) tryRemove(d);
  if (dirs.length) tryRemove(path.join(ctx.seriesPath, ctx.archiveDirName));
}

// Suffix for a CBZ being written; renamed onto the real name only once the
// whole archive is on disk. Not a chapter extension, so the scanner ignores it.
const PARTIAL_SUFFIX = '.partial';

/**
 * Write `zip` to `destCbzPath` without ever leaving a truncated archive under
 * the real name: build the buffer, write it to "<dest>.partial", check the
 * size, then rename onto the destination (atomic within one volume). Any
 * failure removes the partial file and throws.
 *
 * Deliberately not adm-zip's writeZip: it writes straight into the target, so
 * a full disk leaves a truncated .cbz, and it returns without throwing when it
 * can't write (e.g. the target is a directory) — the caller would then delete
 * the chapter folder with no archive written.
 */
function writeZipSafely(zip, destCbzPath) {
  const tmp = destCbzPath + PARTIAL_SUFFIX;
  try {
    const buf = zip.toBuffer();
    if (!buf || buf.length === 0) throw new Error('Archive came out empty');
    fs.writeFileSync(tmp, buf);
    if (fs.statSync(tmp).size !== buf.length) throw new Error('Archive was not fully written');
    fs.renameSync(tmp, destCbzPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Convert a folder of images into a CBZ file at destCbzPath, then delete the
 * folder. Metadata files are moved into the series folder first (see
 * moveMetadataOut); if packing fails they're moved back and no archive is
 * left, so the chapter folder is exactly as it was.
 *
 * Returns { moves, removeError }. Failing to delete the folder AFTER the
 * archive is written is reported, not thrown: the CBZ is complete and the
 * metadata really has moved, while the delete may already have removed some
 * pages — rolling back could leave no complete copy at all. The leftover
 * folder is collapsed as a duplicate on the next run (smaller if pages were
 * removed; on a size tie the copy at the standard name — the CBZ — wins).
 */
function folderToCbz(folderPath, destCbzPath, ctx, chapterName) {
  const files = fs.readdirSync(folderPath).filter(isImage).sort(naturalSort);
  if (files.length === 0) throw new Error('No images found in folder');

  const moves = moveMetadataOut(folderPath, ctx, chapterName);
  try {
    const zip = new AdmZip();
    for (const f of files) {
      zip.addFile(f, fs.readFileSync(path.join(folderPath, f)));
    }
    writeZipSafely(zip, destCbzPath);
  } catch (err) {
    undoMoves(moves);
    removeEmptyDirs(moves.createdDirs, ctx);
    throw err;
  }
  let removeError = null;
  try {
    fs.rmSync(folderPath, { recursive: true, force: true });
  } catch (err) {
    removeError = err;
  }
  return { moves, removeError };
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
    writeZipSafely(zip, destCbzPath);

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
  const summary = { renamed: 0, converted: 0, duplicatesRemoved: [], metadataMoved: [], skipped: [], errors: [] };

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

  // A "<name>.cbz.partial" is a write that never completed (crash / kill
  // mid-pack — writeZipSafely removes its own on failure). The source folder
  // was never deleted, so the partial is pure leftover.
  for (const name of entries) {
    if (name.toLowerCase().endsWith('.cbz' + PARTIAL_SUFFIX)) {
      try { fs.rmSync(path.join(manga.path, name), { force: true }); } catch { /* retried next run */ }
    }
  }

  // Per-run metadata context: where archived variants go, and the deleted
  // duplicates' files waiting for promoteDeferredMetadata.
  const metaCtx = {
    seriesPath: manga.path,
    archiveDirName: resolveArchiveDirName(manga.path),
    deferred: [],
  };

  // Collect all recognized chapter/volume entries with parsed info
  const recognized = [];
  for (const name of entries) {
    const fullPath = path.join(manga.path, name);
    let type;
    try { type = detectChapterType(fullPath); } catch { continue; }
    if (type) recognized.push({ name, fullPath, type });
  }
  // Same folder-wide labelling the scanner uses, so names and DB rows agree.
  const extraInfo = detectExtraInfo(recognized.map(e => e.name), manga.folder_name);
  const toProcess = [];
  for (const e of recognized) {
    const { label: extraLabel, keyword: hasExtraKeyword } = extraInfo.get(e.name);
    const info = parseChapterInfo(e.name);
    const stdName = buildStandardName(info, extraLabel);
    // A keyword whose label was suppressed as series naming (shared title
    // prefix / majority — e.g. "Side Story 2" in a folder of mostly side
    // stories). The standard name would carry no label, so renaming would
    // erase the only marker that this might be bonus content: it would read
    // as a main chapter and become deletable as a duplicate on a later run.
    // Keep the original name — no rename, no dedupe.
    if (stdName && hasExtraKeyword && !extraLabel) {
      summary.skipped.push({ name: e.name, reason: 'Name contains an extra-content keyword treated as part of the series title — left unchanged' });
      continue;
    }
    // Safety net: the standard name must parse back to the same numbers and
    // label, or the rename would silently change what the entry IS (and orphan
    // its read-state). Leave such entries untouched — no rename, no dedupe.
    if (stdName && !standardNameRoundTrips(stdName, info, extraLabel, manga.folder_name)) {
      summary.skipped.push({ name: e.name, reason: `Standard name "${stdName}.cbz" would not keep its chapter/volume number` });
      continue;
    }
    toProcess.push({ ...e, extraLabel, hasExtraKeyword, stdName });
  }

  // Duplicates (several entries → same standard name): keep the largest copy.
  const dedupedTo = removeSmallerDuplicates(toProcess, summary, metaCtx);

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

    // Never write over another file: renameSync and writeZip silently replace
    // an existing target. Covers entries left in place above, an unnumbered
    // "Artbook" folder next to an existing "Artbook.cbz", "X.zip" next to
    // "X.cbz", … — anything already sitting at the target that isn't the
    // entry itself (a case-only rename on Windows is the same file).
    if (targetOccupiedByOther(fullPath, targetCbzPath)) {
      summary.skipped.push({ name, reason: `"${path.basename(targetCbzPath)}" already exists — left unchanged so it isn't overwritten` });
      continue;
    }

    try {
      if (type === 'folder') {
        const { moves, removeError } = folderToCbz(fullPath, targetCbzPath, metaCtx, stdName || name);
        for (const m of moves) {
          summary.metadataMoved.push({ name: `${name}/${path.basename(m.from)}`, movedTo: displayPath(manga.path, m.to) });
        }
        summary.converted++;
        if (stdName && name !== stdName) summary.renamed++;
        if (removeError) {
          summary.errors.push({
            name,
            error: `Packed to "${path.basename(targetCbzPath)}", but the original folder couldn't be removed: ${removeError.message}`,
          });
        }

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

  // Deleted duplicates' metadata: offer the series-level names now that the
  // kept chapters have had first claim.
  promoteDeferredMetadata(metaCtx);

  // Rescan so the DB reflects the new file names
  try {
    await scanMangaDirectory(manga.path, manga.folder_name, manga.library_id, { source: 'optimize' });
  } catch (err) {
    console.error('[Optimize] Rescan error:', err.message);
  }

  // Carry read-state across the rename-induced id churn (see buildIdRemap).
  try {
    const newChapters = snapshotChapterTuples(db, manga.id);
    const remap = buildIdRemap(oldChapters, newChapters, dedupedTo);
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
        console.log(`[BulkOptimize] "${manga.folder_name}": renamed=${summary.renamed} converted=${summary.converted} duplicatesRemoved=${summary.duplicatesRemoved.length} errors=${summary.errors.length}`);
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
