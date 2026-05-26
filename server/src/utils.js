/**
 * Shared pure utilities reused across route files.
 *
 * Keep this file dependency-free (no DB / config imports) so it can be required
 * from anywhere without creating circular module loads.
 */

/** Parse a JSON string, returning `fallback` on any error. */
function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
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

module.exports = { safeJsonParse, csvEscape, formatUnix, getSetting, setSetting };
