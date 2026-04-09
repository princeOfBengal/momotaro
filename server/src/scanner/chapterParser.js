const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('../config');

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
  // Strip bracketed groups (e.g. [Fansub Group], [HQ])
  base = base.replace(/\[.*?\]/g, ' ');

  // Normalize non-semantic separators (_  &  +) to spaces so \b word boundaries
  // fire correctly — e.g. "Scans_Vol.2" becomes "Scans Vol.2"
  base = base.replace(/[_&+]/g, ' ').replace(/\s+/g, ' ').trim();

  let volume = null;
  let chapter = null;

  // Extract volume: Vol.3, Vol 03, Volume 2, v01, V2, etc.
  // Covers: volume, vol, v (standalone, not mid-word)
  const volMatch = base.match(/\b(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)\b/i);
  if (volMatch) {
    volume = parseFloat(volMatch[1]);
    // Remove matched text so the number doesn't leak into chapter extraction
    base = (base.slice(0, volMatch.index) + base.slice(volMatch.index + volMatch[0].length))
      .replace(/\s+/g, ' ').trim();
  }

  // Extract chapter: Ch.23.5, Ch 12, Chapter 5, c01, C01, etc.
  // Covers: chapter, ch, c (standalone, not mid-word)
  const chMatch = base.match(/\b(?:ch(?:apter)?|c)\.?\s*(\d+(?:\.\d+)?)\b/i);
  if (chMatch) {
    chapter = parseFloat(chMatch[1]);
  }

  // Fallback: first standalone number that isn't a 4-digit year (1900–2099)
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

/**
 * Convenience wrapper — returns just the chapter number (backward compat).
 */
function parseChapterNumber(name) {
  return parseChapterInfo(name).chapter;
}

/**
 * Get sorted image list from a folder chapter.
 */
function getFolderPages(dirPath) {
  let files;
  try {
    files = fs.readdirSync(dirPath);
  } catch {
    return [];
  }
  return files
    .filter(isImage)
    .sort(naturalSort)
    .map(f => ({ filename: f, path: path.join(dirPath, f) }));
}

/**
 * Get sorted image list from a CBZ file.
 * Extracts to CBZ cache directory if not already extracted.
 */
function getCbzPages(cbzPath, chapterId) {
  const cacheDir = path.join(config.CBZ_CACHE_DIR, String(chapterId));

  // If already extracted, return cached pages
  if (fs.existsSync(cacheDir)) {
    try {
      const files = fs.readdirSync(cacheDir).filter(isImage).sort(naturalSort);
      if (files.length > 0) {
        return files.map(f => ({ filename: f, path: path.join(cacheDir, f) }));
      }
    } catch {
      // Fall through to re-extract
    }
  }

  return extractCbz(cbzPath, cacheDir);
}

function extractCbz(cbzPath, outputDir) {
  try {
    const zip = new AdmZip(cbzPath);
    const entries = zip.getEntries()
      .filter(e => !e.isDirectory && isImage(e.entryName))
      .sort((a, b) => naturalSort(a.entryName, b.entryName));

    if (entries.length === 0) return [];

    fs.mkdirSync(outputDir, { recursive: true });

    const pages = [];
    entries.forEach((entry, idx) => {
      const ext = path.extname(entry.entryName).toLowerCase();
      const destName = String(idx).padStart(5, '0') + ext;
      const destPath = path.join(outputDir, destName);
      fs.writeFileSync(destPath, entry.getData());
      pages.push({ filename: entry.name || destName, path: destPath });
    });

    return pages;
  } catch (err) {
    console.error(`Failed to extract CBZ ${cbzPath}:`, err.message);
    return [];
  }
}

/**
 * Get pages for a chapter. For CBZ, chapterId is needed for cache directory naming.
 */
function getChapterPages(chapter) {
  if (chapter.type === 'folder') {
    return getFolderPages(chapter.path);
  }
  if (chapter.type === 'cbz') {
    return getCbzPages(chapter.path, chapter.id);
  }
  return [];
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
  detectChapterType,
  getFolderPages,
  getCbzPages,
  extractCbz,
};
