/**
 * Shared pure utilities reused across route files.
 *
 * Keep this file dependency-free (no DB / config imports) so it can be required
 * from anywhere without creating circular module loads.
 */

const path = require('path');

/** Parse a JSON string, returning `fallback` on any error. */
function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Natural (numeric-aware, case-insensitive) string comparator. Single source of
 * truth so the scanner (chapterParser) and the CBZ cache (cbzCache) order page
 * entries identically — a divergence here silently mismatches the cover/first
 * page against the reader's page order for archives with subdirectories.
 */
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Natural sort on the BASENAME only. Archive directory prefixes would otherwise
 * group out-of-order (e.g. `_cover/000.jpg` before `pages/001.jpg`). Both the
 * scanner and the cache feed central-directory order into a stable sort, so
 * equal-basename ties break identically across the two modules.
 */
function compareByBasename(a, b) {
  return naturalSort(path.basename(a), path.basename(b));
}

/**
 * Quote a value for inclusion in an RFC 4180 CSV cell. Always quotes so
 * embedded commas, newlines, and quotes stay correct. Doubles internal quotes.
 * `null` / `undefined` become an empty (unquoted) cell.
 */
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

/** Format a unix-epoch second as an ISO-8601 UTC string. Empty when missing. */
function formatUnix(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toISOString(); } catch { return ''; }
}

/**
 * Expand a parsed chapter span into the discrete chapter numbers it covers.
 * A single chapter ("Ch 11") yields `[11]`; a multi-chapter file ("Ch 10-12")
 * yields `[10, 11, 12]` so a source diff treats every chapter bundled inside it
 * as already present. The integer walk uses `ceil(start)..floor(end)`, and the
 * exact `start` is always included so a fractional start (10.5-12 → 10.5,11,12)
 * is preserved without inventing a spurious lower integer.
 */
function expandChapterRange(number, numberEnd) {
  if (number == null) return [];
  const start = Number(number);
  if (!Number.isFinite(start)) return [];
  const out = [start];
  const end = numberEnd != null ? Number(numberEnd) : start;
  if (Number.isFinite(end) && end > start) {
    // n !== start skips re-adding an integer start the walk would emit.
    for (let n = Math.ceil(start); n <= Math.floor(end); n++) {
      if (n !== start) out.push(n);
    }
  }
  return out;
}

/**
 * SQL fragment: a chapter row's weight in CHAPTER-EQUIVALENTS, the unit used by
 * the reading statistics. A single file/folder can be one chapter, a chapter
 * range, one volume, or a volume range — and a volume averages ~4 chapters — so:
 *
 *   chapter present (number not null) → span = number_end − number + 1
 *                                       (1 for a single chapter; the chapter
 *                                       axis dominates even when a volume is
 *                                       also labeled, so "Vol 3 Ch 15" = 1)
 *   volume only (number null)         → 4 × (volume_end − volume + 1)
 *                                       (4 for one volume; 8 for v17-18)
 *   neither (bare/untitled)           → 1
 *
 * `CAST(... AS INTEGER)` floors fractional chapter numbers (23.5 → 23, so a lone
 * 23.5 still weighs 1); `max(1, …)` floors any span that somehow went negative.
 * `c` is the chapters-table alias in scope at the call site.
 */
function readWeightSql(c) {
  return `max(1, CASE
    WHEN ${c}.number IS NOT NULL
      THEN CAST(COALESCE(${c}.number_end, ${c}.number) AS INTEGER) - CAST(${c}.number AS INTEGER) + 1
    WHEN ${c}.volume IS NOT NULL
      THEN 4 * (CAST(COALESCE(${c}.volume_end, ${c}.volume) AS INTEGER) - CAST(${c}.volume AS INTEGER) + 1)
    ELSE 1
  END)`;
}

// Cap on how many missing numbers are listed (the count is still exact).
const MISSING_LIST_CAP = 500;

/**
 * Given a flat list of present chapter/volume numbers, report the gaps in the
 * 1..max integer sequence. Each value is bucketed into its integer floor (so a
 * fractional 5.5 still covers chapter 5). Callers expand ranges first (via
 * `expandChapterRange`) so a multi-chapter/volume file marks every integer it
 * covers — otherwise the bundled middle/end numbers would read as missing.
 *
 * Returns `{ count, numbers, max, truncated }` — `count` is exact; `numbers` is
 * capped at MISSING_LIST_CAP entries; `truncated` flags when the list was cut.
 */
function computeMissingSequence(values) {
  const present = new Set();
  let max = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    const n = Math.floor(v);
    if (n >= 1) {
      present.add(n);
      if (n > max) max = n;
    }
  }
  let count = 0;
  const numbers = [];
  for (let i = 1; i <= max; i++) {
    if (!present.has(i)) {
      count++;
      if (numbers.length < MISSING_LIST_CAP) numbers.push(i);
    }
  }
  return { count, numbers, max, truncated: count > numbers.length };
}

/**
 * Read a row from the `settings` key/value table. Returns `null` when the row
 * is missing OR its value is the empty string (the schema default) — several
 * call sites compare with `=== '1'`, so the "" → null collapse keeps "unset"
 * and "set to empty" behaving identically.
 */
function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) || null;
}

/**
 * Upsert a row in the `settings` key/value table. Null / undefined / empty
 * values are stored as ''.
 */
function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value || '');
}

module.exports = {
  safeJsonParse, csvEscape, formatUnix, getSetting, setSetting,
  naturalSort, compareByBasename, expandChapterRange, readWeightSql,
  computeMissingSequence,
};
