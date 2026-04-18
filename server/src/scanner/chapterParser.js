const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const yauzl = require('yauzl');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

function isImage(filename) {
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Parse chapter and volume numbers from a folder/file name.
 * Returns { chapter: float|null, volume: float|null }.
 *
 * Handles messy real-world names like:
 *   "Vol. 03 Ch. 023.5 - Some Title [Group]"  → { volume: 3, chapter: 23.5 }
 *   "[Fansub] Vol.02 Ch.012 Extra Text"        → { volume: 2, chapter: 12 }
 *   "Chapter 23.5"                             → { volume: null, chapter: 23.5 }
 *   "001"                                      → { volume: null, chapter: 1 }
 */
function parseChapterInfo(name) {
  // Strip only known archive/image extensions — NOT path.extname() which incorrectly
  // treats e.g. ".13 - Title" as an extension for folder names like "Ch.13 - Title".
  let base = path.basename(name).replace(/\.(cbz|zip|7z|rar|pdf|jpg|jpeg|png|webp|gif|avif)$/i, '');
  base = base.replace(/\[.*?\]/g, ' ');
  base = base.replace(/[_&+]/g, ' ').replace(/\s+/g, ' ').trim();

  let volume = null;
  let chapter = null;

  const volMatch = base.match(/\b(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)\b/i);
  if (volMatch) {
    volume = parseFloat(volMatch[1]);
    base = (base.slice(0, volMatch.index) + base.slice(volMatch.index + volMatch[0].length))
      .replace(/\s+/g, ' ').trim();
  }

  const chMatch = base.match(/\b(?:ch(?:apter)?|c)\.?\s*(\d+(?:\.\d+)?)\b/i);
  if (chMatch) {
    chapter = parseFloat(chMatch[1]);
  }

  if (chapter === null) {
    const numRe = /\b(\d+(?:\.\d+)?)\b/g;
    let numMatch;
    while ((numMatch = numRe.exec(base)) !== null) {
      const n = parseFloat(numMatch[1]);
      const isYear = Number.isInteger(n) && n >= 1900 && n <= 2099;
      if (!isYear) { chapter = n; break; }
    }
  }

  return { chapter, volume };
}

function parseChapterNumber(name) {
  return parseChapterInfo(name).chapter;
}

/**
 * Get sorted image list from a folder chapter.
 * Returns [{ filename, path (absolute), size }].
 */
function getFolderPages(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter(e => e.isFile() && isImage(e.name))
    .map(e => e.name)
    .sort(naturalSort);

  return files.map(name => {
    const full = path.join(dirPath, name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* skip */ }
    return { filename: name, path: full, size };
  });
}

// ── CBZ central-directory cache ───────────────────────────────────────────────
//
// Bounded LRU: cbzPath → { mtimeMs, entries: Map<entryName, yauzlEntry> }.
//
// Parsing the central directory is the dominant cost for repeat reads from the
// same archive — walking entries via yauzl's `readEntry()` event loop costs
// ~1ms/entry of event-loop overhead, so a 200-entry chapter would pay ~200ms
// per page request. Caching the parsed entry map reduces sequential reads to
// one parse per archive until the file's mtime changes.
//
// Holds NO file descriptors — each stream still opens the zip fresh. Staleness
// is detected by comparing the file's current mtime on every hit (a cheap stat).
// Memory budget: ~200 B/entry × ~100 entries/archive × 500 archives ≈ 10 MB.
const CBZ_ENTRIES_CACHE_MAX = 500;
const cbzEntriesCache = new Map();

async function getCachedCbzEntries(cbzPath) {
  let mtimeMs;
  try {
    mtimeMs = (await fsp.stat(cbzPath)).mtimeMs;
  } catch (err) {
    cbzEntriesCache.delete(cbzPath);
    throw err;
  }

  const hit = cbzEntriesCache.get(cbzPath);
  if (hit && hit.mtimeMs === mtimeMs) {
    // LRU bump: re-insert so it's now the most-recently-used key
    cbzEntriesCache.delete(cbzPath);
    cbzEntriesCache.set(cbzPath, hit);
    return hit.entries;
  }

  // Cold or stale — read the central directory once and map every entry.
  // Non-image and directory entries are kept too: openCbzEntryStream looks up
  // by exact name, and filtering here would force a re-parse for any caller
  // that ever asks for a non-image resource inside the archive.
  const entries = await new Promise((resolve, reject) => {
    yauzl.open(cbzPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err || new Error('zip open failed'));
      const map = new Map();
      zip.on('entry', (entry) => {
        if (!/\/$/.test(entry.fileName)) map.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on('end',   () => resolve(map));
      zip.on('error', reject);
      zip.readEntry();
    });
  });

  cbzEntriesCache.set(cbzPath, { mtimeMs, entries });
  if (cbzEntriesCache.size > CBZ_ENTRIES_CACHE_MAX) {
    cbzEntriesCache.delete(cbzEntriesCache.keys().next().value);
  }
  return entries;
}

/**
 * Drop any cached entry map for this archive. Safe to call whether or not
 * the path is currently cached. Exposed for callers that mutate or delete
 * CBZ files outside the normal scan path.
 */
function invalidateCbzCache(cbzPath) {
  cbzEntriesCache.delete(cbzPath);
}

/**
 * Open a CBZ and resolve with [{ filename, entryName, size }] sorted
 * naturally. Does NOT extract — reads from the cached central directory.
 *
 * `entryName` is the full path inside the archive (what yauzl calls `fileName`),
 * suitable for stored-path lookup when streaming a single entry later.
 * `filename` is the basename for display purposes.
 */
async function listCbzEntries(cbzPath) {
  let entries;
  try {
    entries = await getCachedCbzEntries(cbzPath);
  } catch (err) {
    console.error(`[CBZ] Failed to open ${cbzPath}: ${err.message}`);
    return [];
  }
  const out = [];
  for (const [name, entry] of entries) {
    if (!isImage(name)) continue;
    out.push({
      filename:  path.basename(name),
      entryName: name,
      size:      entry.uncompressedSize || 0,
    });
  }
  out.sort((a, b) => naturalSort(a.entryName, b.entryName));
  return out;
}

/**
 * Unified chapter-page listing.
 * Returns [{ filename, path, size }]:
 *   - For 'folder' chapters, `path` is the absolute filesystem path.
 *   - For 'cbz' chapters, `path` is the entry name inside the archive
 *     (to be streamed on demand from chapter.path).
 */
async function getChapterPages(chapter) {
  if (chapter.type === 'folder') {
    return getFolderPages(chapter.path);
  }
  if (chapter.type === 'cbz') {
    const entries = await listCbzEntries(chapter.path);
    return entries.map(e => ({ filename: e.filename, path: e.entryName, size: e.size }));
  }
  return [];
}

/**
 * Open a single entry inside a CBZ as a readable stream.
 *
 * Uses the cached central directory to skip yauzl's per-entry event walk —
 * on a cache hit we open the archive, call openReadStream directly with the
 * cached entry (whose offsets are already known), and rely on `autoClose` to
 * release the fd when the stream ends.
 *
 * Rejects if the archive is unreadable or the entry isn't present. On a
 * "not found" from a cached lookup, the cache is dropped and one re-parse
 * is attempted — covers the rare case where a file was rewritten with the
 * same mtime (sub-second precision collisions on some filesystems).
 */
async function openCbzEntryStream(cbzPath, entryName) {
  const entries = await getCachedCbzEntries(cbzPath);
  const entry = entries.get(entryName);
  if (entry) return openStreamForEntry(cbzPath, entry);

  // Cached map didn't have it — drop and retry fresh before giving up.
  cbzEntriesCache.delete(cbzPath);
  const fresh = await getCachedCbzEntries(cbzPath);
  const retry = fresh.get(entryName);
  if (!retry) throw new Error(`Entry not found: ${entryName}`);
  return openStreamForEntry(cbzPath, retry);
}

function openStreamForEntry(cbzPath, entry) {
  return new Promise((resolve, reject) => {
    yauzl.open(cbzPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err || new Error('zip open failed'));
      zip.openReadStream(entry, (sErr, stream) => {
        if (sErr) {
          // Cached offsets may be out of date — invalidate so the next
          // caller re-parses the central directory.
          cbzEntriesCache.delete(cbzPath);
          return reject(sErr);
        }
        resolve(stream);
      });
    });
  });
}

/**
 * Detect chapter type from a path.
 */
function detectChapterType(entryPath) {
  const stat = fs.statSync(entryPath);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(entryPath);
    if (files.some(isImage)) return 'folder';
    return null;
  }
  const ext = path.extname(entryPath).toLowerCase();
  if (ext === '.cbz' || ext === '.zip') return 'cbz';
  return null;
}

module.exports = {
  parseChapterInfo,
  parseChapterNumber,
  getChapterPages,
  getFolderPages,
  listCbzEntries,
  openCbzEntryStream,
  detectChapterType,
  invalidateCbzCache,
};
