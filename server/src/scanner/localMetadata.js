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
 * Search for metadata in:
 *  1. JSON sidecar (manga dir, then first chapter subdirectory yielding one)
 *  2. ComicInfo.xml (same search order) as fallback
 *
 * Returns a normalised metadata object ready to write to the DB, or null.
 */
function findLocalMetadata(mangaPath) {
  const subdirs = immediateSubdirs(mangaPath);

  // 1. JSON sidecar
  let raw = findJsonInDir(mangaPath);
  if (!raw) {
    for (const sub of subdirs) {
      raw = findJsonInDir(sub);
      if (raw) break;
    }
  }
  if (raw) {
    const meta = normalizeLocalMeta(raw);
    if (meta) return meta;
  }

  // 2. ComicInfo.xml fallback
  let tags = findComicInfoXmlInDir(mangaPath);
  if (!tags) {
    for (const sub of subdirs) {
      tags = findComicInfoXmlInDir(sub);
      if (tags) break;
    }
  }
  if (tags) return normalizeComicInfo(tags);

  return null;
}

function immediateSubdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Locate and parse a ComicInfo.xml file in `dir`. Returns a flat
 * { localName: text } map of its child elements, or null.
 */
function findComicInfoXmlInDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const found = names.find(n => n.toLowerCase() === 'comicinfo.xml');
  if (!found) return null;
  try {
    return parseComicInfoXml(fs.readFileSync(path.join(dir, found), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Minimal ComicInfo.xml parser. ComicInfo elements directly under the root
 * are leaf elements containing text — we collect each by local name
 * (stripping any namespace prefix) so tags like <ty:PublishingStatusTachiyomi>
 * resolve to "PublishingStatusTachiyomi". Returns null if no tags found.
 */
function parseComicInfoXml(text) {
  const root = /<(?:[a-zA-Z_][\w.-]*:)?ComicInfo(?:\s[^>]*)?>([\s\S]*)<\/(?:[a-zA-Z_][\w.-]*:)?ComicInfo>/i.exec(text);
  if (!root) return null;
  const body = root[1];

  const tags = {};
  const re = /<(?:[a-zA-Z_][\w.-]*:)?([a-zA-Z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z_][\w.-]*:)?\1>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    tags[m[1]] = decodeXmlEntities(m[2]).trim();
  }
  return Object.keys(tags).length > 0 ? tags : null;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * Map a ComicInfo.xml tag map onto our internal metadata shape.
 * In ComicInfo, <Series> is the work title (the manga); <Title> is the
 * chapter/issue title — we prefer Series and fall back to Title.
 */
function normalizeComicInfo(tags) {
  const title = str(tags.Series) || str(tags.Title) || null;
  const description = str(tags.Summary) || null;

  let genres = [];
  const genreText = str(tags.Genre) || str(tags.Tags);
  if (genreText) {
    genres = genreText.split(',').map(s => s.trim()).filter(Boolean);
  }

  let year = null;
  if (tags.Year != null) {
    const n = parseInt(String(tags.Year).slice(0, 4), 10);
    if (n >= 1900 && n <= 2100) year = n;
  }

  // CommunityRating is 0–5 in the ComicInfo spec; scale to our 0–10.
  let score = null;
  const cr = parseFloat(tags.CommunityRating);
  if (!isNaN(cr) && cr > 0) {
    score = Math.min(10, cr * 2);
  }

  const author =
    str(tags.Writer) ||
    str(tags.Penciller) ||
    str(tags.Inker) ||
    str(tags.Letterer) ||
    null;

  if (!title && genres.length === 0 && !description) return null;

  return { title, description, genres, year, score, author };
}

/**
 * Map a raw parsed JSON object onto our internal metadata shape.
 * Handles the HentaiNexus format, common variants, and the
 * scraper format keyed by `primary_title` (AniList/MangaUpdates aggregator).
 * Returns null if the object yields nothing useful.
 */
function normalizeLocalMeta(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (str(raw.primary_title)) return normalizeScraperMeta(raw);

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

  // Author / artist — try common key names in priority order
  const author =
    str(raw.artist) ||
    str(raw.Artist) ||
    str(raw.author) ||
    str(raw.Author) ||
    str(raw.circle) ||
    str(raw.Circle) ||
    null;

  if (!title && genres.length === 0 && !description) return null;

  return { title, description, genres, year, score, author };
}

/**
 * Scraper-style sidecar (e.g. `primary_title`, `authors[]`, `anilist_score`,
 * `start_date.year`, `sources.anilist`). Genres are taken from the explicit
 * `genres` field — `tags`/`categories` in this format are content descriptors
 * we don't want to surface as primary genres.
 */
function normalizeScraperMeta(raw) {
  const title = str(raw.primary_title) || null;
  const description = str(raw.description) || null;

  let genres = [];
  if (Array.isArray(raw.genres) && raw.genres.length > 0) {
    genres = raw.genres
      .map(t => (typeof t === 'string' ? t.trim() : String(t)))
      .filter(Boolean);
  }

  let year = null;
  const sdYear = raw.start_date && raw.start_date.year;
  if (typeof sdYear === 'number' && sdYear >= 1900 && sdYear <= 2100) {
    year = sdYear;
  } else if (raw.year != null) {
    const n = parseInt(String(raw.year).slice(0, 4), 10);
    if (n >= 1900 && n <= 2100) year = n;
  }

  // Score: anilist_score is 0–100; the *_rating fields look like 0–10.
  let score = null;
  const anilistScore = parseFloat(raw.anilist_score);
  if (!isNaN(anilistScore) && anilistScore > 0) {
    score = Math.min(10, anilistScore / 10);
  } else {
    for (const key of ['mangaupdates_bayesian_rating', 'mangaupdates_rating', 'animeplanet_rating']) {
      const v = parseFloat(raw[key]);
      if (!isNaN(v) && v > 0) {
        score = v > 10 ? Math.min(10, v / 10) : Math.min(10, v);
        break;
      }
    }
  }

  let author = null;
  if (Array.isArray(raw.authors) && raw.authors.length > 0) {
    const names = raw.authors.map(a => str(a)).filter(Boolean);
    if (names.length > 0) author = names.join(', ');
  }

  if (!title && genres.length === 0 && !description) return null;

  return { title, description, genres, year, score, author };
}

/** Return a trimmed non-empty string, or null. */
function str(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

module.exports = { findLocalMetadata };
