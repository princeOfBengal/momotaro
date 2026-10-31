const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const yauzl = require('yauzl');
const { naturalSort, compareByBasename } = require('../utils');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

function isImage(filename) {
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

// A single number, optionally fractional (chapter 23.5).
const NUM = '(\\d+(?:\\.\\d+)?)';

// Separators that can sit between the two numbers of a span. Covers hyphen,
// en-dash (–), em-dash (—), tilde (Japanese-style range), the word
// "to", and the discrete joiners & + , — these last three express one file
// holding two non-adjacent numbers ("Yamada v17 & 18"). They are matched
// BEFORE the underscore/whitespace normalisation strips anything, which is why
// parseChapterInfo deliberately keeps & + , in the working string.
const RANGE_SEP = '\\s*(?:-|\\u2013|\\u2014|~|to|&|\\+|,)\\s*';

const VOL_PREFIX = '(?:volumes?|vols?|v)';
const CH_PREFIX  = '(?:chapters?|chs?|c)';

// Range patterns are tried before the single-number patterns on each axis. The
// optional repeated prefix on the second number accepts "v17-v18" / "Ch.10-Ch.12".
//
// The trailing `(?: SEP NUM )+` matches the WHOLE chained run, not just the
// first pair — so "Vol 1,2,3,4,5" / "v17 & 18 & 19" are consumed entirely
// (group 1 = first number, group 2 = the LAST number, since a repeated capture
// group keeps its final iteration). Without this, the volume match would eat
// only "Vol 1,2" and the leftover ",3,4,5" would leak into the CHAPTER axis via
// the bare-number fallback, fabricating a phantom chapter range.
const VOL_RANGE_RE  = new RegExp(`\\b${VOL_PREFIX}\\.?\\s*${NUM}(?:${RANGE_SEP}(?:${VOL_PREFIX}\\.?\\s*)?${NUM})+\\b`, 'i');
const VOL_SINGLE_RE = new RegExp(`\\b${VOL_PREFIX}\\.?\\s*${NUM}\\b`, 'i');
const CH_RANGE_RE   = new RegExp(`\\b${CH_PREFIX}\\.?\\s*${NUM}(?:${RANGE_SEP}(?:${CH_PREFIX}\\.?\\s*)?${NUM})+\\b`, 'i');
const CH_SINGLE_RE  = new RegExp(`\\b${CH_PREFIX}\\.?\\s*${NUM}\\b`, 'i');
const BARE_RANGE_RE = new RegExp(`\\b${NUM}(?:${RANGE_SEP}${NUM})+\\b`, 'g');
const BARE_NUM_RE   = /\b(\d+(?:\.\d+)?)\b/g;

// Reject absurd spans that almost certainly come from a mis-parse ("c1-9999").
// Both the scheduler's covered-set expansion and the statistics weighting
// multiply by the span, so an unbounded value would poison them.
const MAX_VOLUME_SPAN  = 50;
const MAX_CHAPTER_SPAN = 100;

function isYear(n) {
  return Number.isInteger(n) && n >= 1900 && n <= 2099;
}

// Validate a [start, end] pair as a real ascending span within the cap.
// Returns { value, end } or null (caller then treats it as a single number).
function resolveSpan(startStr, endStr, maxSpan) {
  const s = parseFloat(startStr);
  const e = parseFloat(endStr);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (e <= s) return null;
  if (e - s > maxSpan) return null;
  return { value: s, end: e };
}

/**
 * Parse chapter and volume numbers from a folder/file name. A single file or
 * folder can span a RANGE of chapters and/or volumes; the name reflects it
 * (e.g. "Yamada-kun v17-18.cbz" holds volumes 17–18).
 *
 * Returns { chapter, chapterEnd, volume, volumeEnd } — the `*End` fields are
 * null unless a range was detected, in which case `chapter`/`volume` hold the
 * START and `chapterEnd`/`volumeEnd` the END (inclusive).
 *
 * Examples:
 *   "Vol. 03 Ch. 023.5 - Title [Group]" → { volume: 3,  volumeEnd: null, chapter: 23.5, chapterEnd: null }
 *   "Yamada-kun v17-18"                 → { volume: 17, volumeEnd: 18,   chapter: null, chapterEnd: null }
 *   "Vol. 1-2 Ch. 5-12"                 → { volume: 1,  volumeEnd: 2,    chapter: 5,    chapterEnd: 12   }
 *   "v17 & 18"                          → { volume: 17, volumeEnd: 18,   chapter: null, chapterEnd: null }
 *   "001-005"                           → { volume: null, volumeEnd: null, chapter: 1,  chapterEnd: 5    }
 */
function parseChapterInfo(name) {
  // Strip only known archive/image extensions — NOT path.extname() which incorrectly
  // treats e.g. ".13 - Title" as an extension for folder names like "Ch.13 - Title".
  let base = path.basename(name).replace(/\.(cbz|zip|7z|rar|pdf|jpg|jpeg|png|webp|gif|avif)$/i, '');
  base = base.replace(/\[.*?\]/g, ' ');
  // Normalise underscores, but KEEP & + , — the range patterns consume them as
  // discrete joiners. Collapsing them to spaces here (the old behaviour) would
  // make "v17 & 18" indistinguishable from a stray title number.
  base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  let volume = null, volumeEnd = null;
  let chapter = null, chapterEnd = null;

  // ── Volume (range first, else single) ────────────────────────────────────
  let volMatch = base.match(VOL_RANGE_RE);
  let span = volMatch ? resolveSpan(volMatch[1], volMatch[2], MAX_VOLUME_SPAN) : null;
  if (span) {
    volume = span.value;
    volumeEnd = span.end;
  } else {
    volMatch = base.match(VOL_SINGLE_RE);
    if (volMatch) volume = parseFloat(volMatch[1]);
  }
  if (volMatch) {
    // Remove the matched volume text so its digits can't be re-read as a chapter.
    base = (base.slice(0, volMatch.index) + base.slice(volMatch.index + volMatch[0].length))
      .replace(/\s+/g, ' ').trim();
  }

  // ── Chapter (range first, else single) ───────────────────────────────────
  let chMatch = base.match(CH_RANGE_RE);
  span = chMatch ? resolveSpan(chMatch[1], chMatch[2], MAX_CHAPTER_SPAN) : null;
  if (span) {
    chapter = span.value;
    chapterEnd = span.end;
  } else {
    chMatch = base.match(CH_SINGLE_RE);
    if (chMatch) chapter = parseFloat(chMatch[1]);
  }

  // ── Fallback: no explicit "Ch" prefix found ──────────────────────────────
  if (chapter === null) {
    // Drop extra-content keywords first so a digit inside one ("4-Koma") isn't
    // read as the chapter: "Vol 1 4-Koma" is volume 1, not Vol 1 Ch 4.
    for (const re of EXTRA_LABELS_GLOBAL) base = base.replace(re, ' ');
    base = base.replace(/\s+/g, ' ').trim();
    // Bare numeric range ("001-005"), rejecting year–year spans ("2017-2018").
    BARE_RANGE_RE.lastIndex = 0;
    let m;
    while ((m = BARE_RANGE_RE.exec(base)) !== null) {
      if (isYear(parseFloat(m[1])) || isYear(parseFloat(m[2]))) continue;
      const sp = resolveSpan(m[1], m[2], MAX_CHAPTER_SPAN);
      if (sp) { chapter = sp.value; chapterEnd = sp.end; break; }
    }
    // Else the first standalone number that isn't a 4-digit year.
    if (chapter === null) {
      BARE_NUM_RE.lastIndex = 0;
      while ((m = BARE_NUM_RE.exec(base)) !== null) {
        const n = parseFloat(m[1]);
        if (!isYear(n)) { chapter = n; break; }
      }
    }
  }

  return { chapter, chapterEnd, volume, volumeEnd };
}

function parseChapterNumber(name) {
  return parseChapterInfo(name).chapter;
}

// ── Extra-content labels ─────────────────────────────────────────────────────
//
// Bonus material ("Ch 5 Omake", "Vol 1 Extras", "Artbook") shares its number
// with a regular chapter/volume, so the number alone can't tell them apart.
// Each pattern maps the spellings seen in the wild onto one canonical label,
// which is stored on the chapter row, shown in the UI, and kept in the
// optimize standard name. Order matters only when a name carries two keywords
// — the first match wins.
const EXTRA_LABELS = [
  ['Omake',         /\bomake\b/i],
  ['Bonus',         /\bbonus(?:es)?\b/i],
  ['Extra',         /\bextras?\b/i],
  ['Artbook',       /\bart[\s-]?books?\b/i],
  ['Fanbook',       /\bfan[\s-]?books?\b/i],
  ['Databook',      /\bdata[\s-]?books?\b/i],
  ['Guidebook',     /\bguide[\s-]?books?\b/i],
  ['Illustrations', /\b(?:illust(?:ration)?s?|art[\s-]?works?|art[\s-]?gallery)\b/i],
  ['Side Story',    /\bside[\s-]?stor(?:y|ies)\b/i],
  ['Short Story',   /\bshort[\s-]?stor(?:y|ies)\b/i],
  ['Gaiden',        /\bgaiden\b/i],
  ['Spin-off',      /\bspin[\s-]?offs?\b/i],
  ['Special',       /\bspecials?\b/i],
  ['Oneshot',       /\bone[\s-]?shots?\b/i],
  ['Pilot',         /\bpilot\b/i],
  ['4-Koma',        /\b(?:4|yon)[\s-]?koma\b/i],
  ['Interlude',     /\b(?:interludes?|intermissions?)\b/i],
  ['Afterword',     /\b(?:afterwords?|postscripts?)\b/i],
];

const EXTRA_LABELS_GLOBAL = EXTRA_LABELS.map(([, re]) => new RegExp(re.source, 'gi'));

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Entry name → the text keyword detection runs on: extension and `[group]`
// tags removed (a scanlator called "[Extra Scans]" would otherwise tag every
// file), underscores and runs of whitespace collapsed to single spaces.
function normalizeEntryText(name) {
  return path.basename(name)
    .replace(/\.(cbz|zip|7z|rar|pdf)$/i, '')
    .replace(/\[.*?\]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Remove the series name wherever it appears as whole words. Bounded by
// letters/digits on both sides so a short series name ("K", "Ao") can't eat
// the inside of a keyword ("Omake" → "Oma e"). Folder names often carry a
// "(2015)" / "(Official)" qualifier the file names don't, so the name with
// parenthesised parts removed is tried as well.
function stripSeriesName(text, seriesName) {
  if (!seriesName) return text;
  const full = normalizeEntryText(seriesName);
  const bare = full.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  for (const series of new Set([full, bare])) {
    if (!series) continue;
    const pattern = escapeRegExp(series).replace(/ /g, '\\s+');
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Words before the first word containing a digit — where a series title sits
// in names like "X Gaiden c001". True extras usually follow the number.
function titleWordCount(words) {
  const i = words.findIndex(w => /\d/.test(w));
  return i === -1 ? words.length : i;
}

// Every keyword match in `text`: [{ label, leading }], in EXTRA_LABELS order.
// `leading` = the match starts before the first number (title position).
function findExtraMatches(text) {
  const words = text ? text.split(' ') : [];
  const titleEnd = words.slice(0, titleWordCount(words)).join(' ').length;
  const matches = [];
  for (const [label, re] of EXTRA_LABELS) {
    const m = re.exec(text);
    if (m) matches.push({ label, leading: m.index < titleEnd });
  }
  return matches;
}

/**
 * Extra-content detection for every entry in one manga folder.
 * Returns Map of name → { label, keyword }:
 *
 *   label   — canonical tag to store and display, or null.
 *   keyword — true when ANY extra keyword appears in the name once only the
 *             folder's series name is removed — i.e. before rules 2 and 3,
 *             so even a suppressed label still counts. Optimize's duplicate
 *             removal keys off this, not `label`, so the labelling heuristics
 *             below can never make bonus material eligible for deletion (a
 *             folder holding just "Bonus 5 A" and "Bonus 5 B" loses its labels
 *             to rule 2, but neither file can be deleted as a duplicate).
 *
 * Series naming is recognised three ways, all limited to the title position
 * (before the first number) so "Ch 5 Bonus"-style extras are never affected:
 *
 *   1. The folder's series name, removed as whole words.
 *   2. A shared title prefix: when 2+ entries all start with the same words
 *      before their numbers ("X Gaiden c1", "X Gaiden c3 Omake"), those words
 *      are the series title even if the folder is named differently. Only
 *      applied when every entry keeps at least one word after removal.
 *   3. Majority: a label found in title position on more than half of 3+
 *      entries is series naming (catches a few odd-named files breaking the
 *      shared prefix). Exactly half doesn't count, so "every chapter has an
 *      omake" folders keep their labels.
 */
function detectExtraInfo(names, seriesName = null) {
  const wordLists = names.map(n => {
    const text = stripSeriesName(normalizeEntryText(n), seriesName);
    return text ? text.split(' ') : [];
  });
  const hasKeyword = wordLists.map(ws => findExtraMatches(ws.join(' ')).length > 0);

  // 2. Shared title prefix (case-insensitive, whole words).
  if (names.length >= 2) {
    let shared = Math.min(...wordLists.map(titleWordCount));
    for (let i = 0; i < shared; i++) {
      const w = wordLists[0][i].toLowerCase();
      if (!wordLists.every(ws => ws[i].toLowerCase() === w)) { shared = i; break; }
    }
    if (shared > 0 && wordLists.every(ws => ws.length > shared)) {
      for (let i = 0; i < wordLists.length; i++) wordLists[i] = wordLists[i].slice(shared);
    }
  }

  const matches = wordLists.map(ws => findExtraMatches(ws.join(' ')));

  // 3. Majority in title position.
  const suppressed = new Set();
  if (names.length >= 3) {
    const leadingCounts = new Map();
    for (const ms of matches) {
      for (const label of new Set(ms.filter(m => m.leading).map(m => m.label))) {
        leadingCounts.set(label, (leadingCounts.get(label) || 0) + 1);
      }
    }
    for (const [label, count] of leadingCounts) {
      if (count > names.length / 2) suppressed.add(label);
    }
  }

  const out = new Map();
  names.forEach((n, i) => {
    const kept = matches[i].find(m => !(m.leading && suppressed.has(m.label)));
    out.set(n, { label: kept ? kept.label : null, keyword: hasKeyword[i] });
  });
  return out;
}

/** Labels for every entry in one manga folder: Map of name → label|null. */
function detectExtraLabels(names, seriesName = null) {
  const labels = new Map();
  for (const [n, info] of detectExtraInfo(names, seriesName)) labels.set(n, info.label);
  return labels;
}

/** Canonical extra-content label for a single entry name, or null. */
function detectExtraLabel(name, seriesName = null) {
  return detectExtraLabels([name], seriesName).get(name);
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
  // Basename sort to match cbzCache's extraction order (planChapterPages /
  // runPhase2). Sorting on the full entryName would mis-group archives whose
  // images live in subdirectories, making the scanner's cover/first-page pick
  // disagree with the reader's page 1.
  out.sort((a, b) => compareByBasename(a.entryName, b.entryName));
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
  detectExtraLabel,
  detectExtraLabels,
  detectExtraInfo,
  getChapterPages,
  getFolderPages,
  listCbzEntries,
  openCbzEntryStream,
  detectChapterType,
  invalidateCbzCache,
};
