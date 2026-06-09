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
  naturalSort, compareByBasename,
};
