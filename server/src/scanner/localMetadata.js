const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = /\.(jpe?g|png|webp|avif|gif)$/i;

/**
 * Find the first usable metadata JSON file in a directory.
 *
 * Priority order:
 *  1. Explicit names: metadata.json, info.json, gallery.json, comic.json
 *  2. Image sidecar files: <image>.png.json, <image>.jpg.json, etc.
 *  3. Any other *.json file
 *
 * Returns the parsed object or null.
 */
function findJsonInDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const jsonNames = names.filter(n => n.toLowerCase().endsWith('.json'));
  if (jsonNames.length === 0) return null;

  const EXPLICIT = new Set(['metadata.json', 'info.json', 'gallery.json', 'comic.json', 'book.json']);
  const explicit = jsonNames.find(n => EXPLICIT.has(n.toLowerCase()));
  const sidecar  = jsonNames.find(n => IMAGE_EXTS.test(n.slice(0, -5))); // strip .json, check if remainder is an image name
  const fallback = jsonNames[0];

  const chosen = explicit || sidecar || fallback;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, chosen), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Search for metadata JSON in:
 *  1. The manga directory itself (top-level sidecar or metadata.json)
 *  2. Any immediate subdirectory that is a chapter folder (first one found)
 *
 * Returns a normalised metadata object ready to write to the DB, or null.
 */
function findLocalMetadata(mangaPath) {
  // 1. Check the manga dir itself
  let raw = findJsonInDir(mangaPath);

  // 2. Fall back to first chapter subdirectory
  if (!raw) {
    let subdirs;
    try {
      subdirs = fs.readdirSync(mangaPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(mangaPath, e.name));
    } catch {
      subdirs = [];
    }
    for (const sub of subdirs) {
      raw = findJsonInDir(sub);
      if (raw) break;
    }
  }

  if (!raw) return null;
  return normalizeLocalMeta(raw);
}

/**
 * Map a raw parsed JSON object onto our internal metadata shape.
 * Handles the HentaiNexus format and common variants.
 * Returns null if the object yields nothing useful.
 */
function normalizeLocalMeta(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  // Title — try several common key names
  const title =
    str(raw.title) ||
    str(raw.Title) ||
    str(raw.name)  ||
    str(raw.Name)  ||
    null;

  // Description / summary
  const description =
    str(raw.description) ||
    str(raw.Description) ||
    str(raw.summary)     ||
    str(raw.Summary)     ||
    null;

  // Genres / tags — many formats use different keys
  let genres = [];
  for (const key of ['tags', 'Tags', 'genres', 'Genres', 'categories', 'Categories']) {
    const val = raw[key];
    if (Array.isArray(val) && val.length > 0) {
      genres = val.map(t => (typeof t === 'string' ? t.trim() : String(t))).filter(Boolean);
      break;
    }
  }

  // Publication year
  let year = null;
  for (const key of ['year', 'Year', 'published', 'date']) {
    const v = raw[key];
    if (v) {
      const n = parseInt(String(v).slice(0, 4), 10);
      if (n >= 1900 && n <= 2100) { year = n; break; }
    }
  }

  // Score / rating (0–10 scale normalisation)
  let score = null;
  for (const key of ['score', 'Score', 'rating', 'Rating']) {
    const v = parseFloat(raw[key]);
    if (!isNaN(v) && v > 0) {
      // If the value looks like a 0–100 scale, divide by 10
      score = v > 10 ? Math.min(10, v / 10) : Math.min(10, v);
      break;
    }
  }

  if (!title && genres.length === 0 && !description) return null;

  return { title, description, genres, year, score };
}

/** Return a trimmed non-empty string, or null. */
function str(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

module.exports = { findLocalMetadata };
