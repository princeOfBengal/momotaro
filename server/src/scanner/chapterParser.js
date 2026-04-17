const fs = require('fs');
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

/**
 * Open a CBZ and resolve with [{ filename, entryName, size }] sorted
 * naturally. Does NOT extract — just reads the central directory.
 *
 * `entryName` is the full path inside the archive (what yauzl calls `fileName`),
 * suitable for stored-path lookup when streaming a single entry later.
 * `filename` is the basename for display purposes.
 */
function listCbzEntries(cbzPath) {
  return new Promise((resolve) => {
    yauzl.open(cbzPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        console.error(`[CBZ] Failed to open ${cbzPath}: ${err && err.message}`);
        return resolve([]);
      }
      const out = [];
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName) || !isImage(entry.fileName)) {
          return zip.readEntry();
        }
        out.push({
          filename:  path.basename(entry.fileName),
          entryName: entry.fileName,
          size:      entry.uncompressedSize || 0,
        });
        zip.readEntry();
      });
      zip.on('end', () => {
        out.sort((a, b) => naturalSort(a.entryName, b.entryName));
        resolve(out);
      });
      zip.on('error', (e) => {
        console.error(`[CBZ] Read error on ${cbzPath}: ${e.message}`);
        resolve(out);
      });
      zip.readEntry();
    });
  });
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
 * Opens the archive fresh each time — the OS page cache handles hot reads;
 * yauzl is fast at central-directory parsing (one seek + a few KB read).
 *
 * Resolves to a Node Readable stream; rejects if the entry can't be found
 * or the archive can't be opened.
 */
function openCbzEntryStream(cbzPath, entryName) {
  return new Promise((resolve, reject) => {
    yauzl.open(cbzPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err || new Error('zip open failed'));
      let found = false;
      zip.on('entry', (entry) => {
        if (entry.fileName === entryName) {
          found = true;
          zip.openReadStream(entry, (sErr, stream) => {
            if (sErr) return reject(sErr);
            // Closing the stream will autoClose the ZipFile since lazyEntries.
            resolve(stream);
          });
          return;
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!found) reject(new Error(`Entry not found: ${entryName}`));
      });
      zip.on('error', reject);
      zip.readEntry();
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
};
