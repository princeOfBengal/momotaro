const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const yauzl = require('yauzl');
const config = require('../config');

// Per-chapter disk cache for CBZ archives.
//
// On first open, the entire CBZ is decompressed into a chapter-specific folder
// under CBZ_CACHE_DIR. Pages are renamed to zero-padded sequential files so the
// reader's natural-sort always agrees with the archive's intended order. The
// serving route then behaves like a folder chapter — plain res.sendFile from
// the extracted directory.
//
// Layout: CBZ_CACHE_DIR/<chapterId>_<mtimeFloor>/
//           ├── 0001.jpg
//           ├── 0002.jpg
//           ├── ...
//           └── .ready        (written last; absence means partial extraction)
//
// Including the archive's floor-seconds mtime in the directory name prevents
// stale files from ever being served after the CBZ is rewritten — a new mtime
// resolves to a new directory.
//
// Eviction is auto-clear: when the global total exceeds the configured cap,
// every cached chapter directory is wiped in one pass — except for the chapter
// that just triggered the overflow (passed via `protectedDir`), which is kept
// so the caller that drove the overflow gets a working file and forward
// progress is preserved (e.g. the thumbnail-regeneration loop). Working at
// page granularity inside a chapter would leave partial directories behind
// and force re-extraction mid-read.

const DEFAULT_CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB default cap
// Mutable at runtime via setLimitBytes() so the user can reconfigure from
// Settings without restarting the server.
let cacheLimitBytes = DEFAULT_CACHE_LIMIT_BYTES;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const READY_MARKER = '.ready';

// LRU: iteration order of a Map is insertion order, so re-inserting on touch
// moves a key to the tail (most recent). Key = absolute chapter-dir path.
const index = new Map();    // chapterDir -> { size }
let totalBytes = 0;

// Dedupe concurrent extractions of the same chapter.
const inFlight = new Map(); // chapterDir -> Promise<{ dir, pages }>

function isImage(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function chapterDirFor(chapterId, mtimeMs) {
  return path.join(config.CBZ_CACHE_DIR, `${chapterId}_${Math.floor(mtimeMs / 1000)}`);
}

function touch(chapterDir) {
  const meta = index.get(chapterDir);
  if (!meta) return;
  index.delete(chapterDir);
  index.set(chapterDir, meta);
}

function addToIndex(chapterDir, size) {
  const existing = index.get(chapterDir);
  if (existing) {
    totalBytes -= existing.size;
    index.delete(chapterDir);
  }
  index.set(chapterDir, { size });
  totalBytes += size;
  evictIfNeeded(chapterDir);
}

function removeFromIndex(chapterDir) {
  const meta = index.get(chapterDir);
  if (!meta) return;
  index.delete(chapterDir);
  totalBytes -= meta.size;
}

function evictChapterDir(chapterDir) {
  removeFromIndex(chapterDir);
  fs.rm(chapterDir, { recursive: true, force: true }, () => {});
}

// Auto-clear: when the cache hits its size cap, wipe every cached chapter
// directory in one pass. The optional `protectedDir` keeps a single chapter on
// disk — the one that just triggered the overflow — so the caller that drove
// the addition (e.g. the regenerate-thumbnails loop, a reader opening the
// chapter) still gets a working file. With no protected dir (cap lowered via
// settings, init walked an over-cap on-disk state), the wipe is total.
function evictIfNeeded(protectedDir = null) {
  if (totalBytes <= cacheLimitBytes) return;
  let evicted = 0;
  let evictedBytes = 0;
  for (const [chapterDir, meta] of Array.from(index)) {
    if (chapterDir === protectedDir) continue;
    evictChapterDir(chapterDir);
    evicted++;
    evictedBytes += meta.size;
  }
  if (evicted > 0) {
    const freedGb = (evictedBytes / 1024 / 1024 / 1024).toFixed(2);
    const limGb   = (cacheLimitBytes / 1024 / 1024 / 1024).toFixed(2);
    console.log(
      `[CBZ Cache] Cap reached (${limGb} GB) — auto-cleared ${evicted} chapter` +
      `${evicted === 1 ? '' : 's'} (${freedGb} GB freed)`
    );
  }
}

/**
 * Update the cache cap at runtime. Immediately evicts the least-recently-used
 * chapter directories if the new cap is below the current total.
 */
function setLimitBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Cache limit must be a positive number of bytes');
  }
  cacheLimitBytes = Math.floor(n);
  evictIfNeeded();
}

// Remove any sibling directories matching `<chapterId>_*` other than the
// current one. Called before extracting a new mtime to reclaim space from
// outdated extractions of the same chapter.
function cleanupStaleForChapter(chapterId, currentDir) {
  let entries;
  try { entries = fs.readdirSync(config.CBZ_CACHE_DIR, { withFileTypes: true }); }
  catch { return; }
  const prefix = `${chapterId}_`;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith(prefix)) continue;
    const full = path.join(config.CBZ_CACHE_DIR, e.name);
    if (full === currentDir) continue;
    evictChapterDir(full);
  }
}

function dirSizeSync(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { total += fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
  }
  return total;
}

// Extract every image entry from the CBZ into `chapterDir`, renaming each to
// `NNNN.<ext>` so filesystem natural-sort matches the reader's page order.
//
// Returns [{ cacheFilename, originalName, size }] in page order. The `.ready`
// marker is written last; readers treat its absence as a partial extraction.
function extractAll(cbzPath, chapterDir) {
  return new Promise((resolve, reject) => {
    fs.mkdir(chapterDir, { recursive: true }, (mkErr) => {
      if (mkErr) return reject(mkErr);
      yauzl.open(cbzPath, { lazyEntries: true, autoClose: false }, (openErr, zip) => {
        if (openErr || !zip) return reject(openErr || new Error('zip open failed'));

        const imageEntries = [];
        zip.on('entry', (entry) => {
          if (!entry.fileName.endsWith('/') && isImage(entry.fileName)) {
            imageEntries.push(entry);
          }
          zip.readEntry();
        });
        zip.on('error', (e) => { try { zip.close(); } catch {} reject(e); });
        zip.on('end', async () => {
          try {
            // Natural-sort on the basename only — archive directory prefixes
            // would otherwise skew ordering (e.g. `_cover/` grouping ahead of
            // `pages/001.jpg`).
            imageEntries.sort((a, b) =>
              naturalSort(path.basename(a.fileName), path.basename(b.fileName))
            );

            const pages = [];
            const pad = Math.max(4, String(imageEntries.length).length);
            let totalSize = 0;

            for (let i = 0; i < imageEntries.length; i++) {
              const entry = imageEntries[i];
              const ext = (path.extname(entry.fileName) || '.jpg').toLowerCase();
              const cacheFilename = String(i + 1).padStart(pad, '0') + ext;
              const target = path.join(chapterDir, cacheFilename);
              const tmp = target + '.tmp';

              const size = await new Promise((res, rej) => {
                zip.openReadStream(entry, (sErr, stream) => {
                  if (sErr) return rej(sErr);
                  const out = fs.createWriteStream(tmp);
                  let written = 0;
                  stream.on('data', (c) => { written += c.length; });
                  stream.on('error', (e) => { out.destroy(); fs.unlink(tmp, () => {}); rej(e); });
                  out.on('error', (e) => { fs.unlink(tmp, () => {}); rej(e); });
                  out.on('finish', () => {
                    fs.rename(tmp, target, (rnErr) => {
                      if (rnErr) { fs.unlink(tmp, () => {}); return rej(rnErr); }
                      res(written);
                    });
                  });
                  stream.pipe(out);
                });
              });

              pages.push({
                cacheFilename,
                originalName: path.basename(entry.fileName),
                size,
              });
              totalSize += size;
            }

            await fsp.writeFile(path.join(chapterDir, READY_MARKER), '');
            try { zip.close(); } catch {}
            resolve({ pages, totalSize });
          } catch (e) {
            try { zip.close(); } catch {}
            reject(e);
          }
        });
        zip.readEntry();
      });
    });
  });
}

/**
 * Ensure a chapter is fully extracted to its cache directory. Returns:
 *   { dir, pages, freshlyExtracted }
 *     dir              — absolute path to the chapter's cache folder
 *     pages            — [{ cacheFilename, originalName, size }] in page order.
 *                        Only present when we just extracted (freshlyExtracted).
 *     freshlyExtracted — true if this call did the extraction; false on cache hit.
 *
 * Extraction is deduped: concurrent calls for the same chapter share a single
 * work Promise. Stale mtime directories for the same chapterId are cleaned up
 * as part of a fresh extraction.
 */
async function ensureChapterExtracted(chapterId, cbzPath) {
  const stat = await fsp.stat(cbzPath);
  const dir = chapterDirFor(chapterId, stat.mtimeMs);
  const readyPath = path.join(dir, READY_MARKER);

  // In-memory cache hit.
  if (index.has(dir)) {
    try {
      await fsp.access(readyPath);
      touch(dir);
      return { dir, pages: null, freshlyExtracted: false };
    } catch {
      // Marker gone — treat as corrupt and re-extract.
      evictChapterDir(dir);
    }
  }

  // On-disk hit from a previous run that init() hasn't walked yet.
  try {
    await fsp.access(readyPath);
    const size = dirSizeSync(dir);
    addToIndex(dir, size);
    return { dir, pages: null, freshlyExtracted: false };
  } catch { /* need to extract */ }

  if (inFlight.has(dir)) return inFlight.get(dir);

  const p = (async () => {
    cleanupStaleForChapter(chapterId, dir);
    // Clear any partial contents from a previous aborted extraction.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    const { pages, totalSize } = await extractAll(cbzPath, dir);
    addToIndex(dir, totalSize);
    return { dir, pages, freshlyExtracted: true };
  })().finally(() => inFlight.delete(dir));
  inFlight.set(dir, p);
  return p;
}

/**
 * Resolve a CBZ page to an absolute on-disk file path, extracting the chapter
 * first if needed. Used by thumbnail/cover callers that just need raw bytes
 * and don't go through the paged reader flow.
 */
async function getCbzPageFile(chapterId, cbzPath, pageIndex) {
  const { dir } = await ensureChapterExtracted(chapterId, cbzPath);
  const files = fs.readdirSync(dir).filter(f => f !== READY_MARKER && !f.endsWith('.tmp'));
  files.sort(naturalSort);
  if (pageIndex < 0 || pageIndex >= files.length) {
    throw new Error(`Page index ${pageIndex} out of range (0..${files.length - 1})`);
  }
  return path.join(dir, files[pageIndex]);
}

/**
 * Scan CBZ_CACHE_DIR and rebuild the in-memory index. Warm cache from the
 * previous run is preserved across restarts. Directories without a `.ready`
 * marker (partial extractions from a crashed run) are removed.
 */
function init(limitBytes) {
  if (limitBytes != null) {
    const n = Number(limitBytes);
    if (Number.isFinite(n) && n > 0) cacheLimitBytes = Math.floor(n);
  }
  index.clear();
  totalBytes = 0;

  const root = config.CBZ_CACHE_DIR;
  let chapterDirs;
  try {
    chapterDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    fs.mkdirSync(root, { recursive: true });
    return;
  }

  for (const dirEnt of chapterDirs) {
    if (!dirEnt.isDirectory()) continue;
    const full = path.join(root, dirEnt.name);
    const ready = path.join(full, READY_MARKER);
    if (!fs.existsSync(ready)) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
      continue;
    }
    // Sweep any stray .tmp files from a partial extraction that nevertheless
    // wrote the ready marker (shouldn't happen — marker is written last — but
    // cheap to guard).
    try {
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith('.tmp')) {
          try { fs.unlinkSync(path.join(full, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    const size = dirSizeSync(full);
    index.set(full, { size });
    totalBytes += size;
  }

  if (index.size > 0) {
    const gb = (totalBytes / 1024 / 1024 / 1024).toFixed(2);
    const limGb = (cacheLimitBytes / 1024 / 1024 / 1024).toFixed(1);
    console.log(`[CBZ Cache] Loaded ${index.size} chapter${index.size === 1 ? '' : 's'} (${gb} GB / ${limGb} GB)`);
  }
  evictIfNeeded();
}

/** Remove every cached chapter directory. */
function wipe() {
  const root = config.CBZ_CACHE_DIR;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      try { fs.rmSync(path.join(root, e.name), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* dir missing — fine */ }
  index.clear();
  totalBytes = 0;
}

function stats() {
  return {
    size_bytes: totalBytes,
    limit_bytes: cacheLimitBytes,
    entries: index.size,
  };
}

module.exports = {
  ensureChapterExtracted,
  getCbzPageFile,
  init,
  wipe,
  stats,
  setLimitBytes,
  DEFAULT_CACHE_LIMIT_BYTES,
};
