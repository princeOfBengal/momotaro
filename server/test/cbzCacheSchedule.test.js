/**
 * Tests the auto-clear scheduler's settings reader + clear routing:
 *
 *   1. readAutoclearSettings() returns the documented defaults when nothing is
 *      stored, and coerces invalid values back to defaults (so the API can never
 *      report — nor the scheduler run — a schedule the validator would reject).
 *   2. runScheduledClear() is ALWAYS the active-safe age sweep
 *      (cbzCache.sweepOlderThan) and NEVER calls wipe() (which would abort
 *      in-flight reads). This is the core safety guarantee of the scheduled clear.
 *
 * DB-backed (real migrations). Run with:
 *   node test/cbzCacheSchedule.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-cbzsched-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';
process.env.CBZ_CACHE_DIR = path.join(tmp, 'cbz-cache');
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const { getDb } = require('../src/db/database');
const cbzCache = require('../src/scanner/cbzCache');
const schedule = require('../src/scanner/cbzCacheSchedule');

const db = getDb(); // runs migrate()

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
function clearAutoclear() {
  db.prepare("DELETE FROM settings WHERE key LIKE 'cbz_cache_autoclear_%'").run();
}

try {
  // ── 1. Defaults ────────────────────────────────────────────────────────────
  clearAutoclear();
  let s = schedule.readAutoclearSettings(db);
  assert.strictEqual(s.mode, 'off',     'default mode off');
  assert.strictEqual(s.max_age_days, 7, 'default max_age_days 7');
  assert.strictEqual(s.time, '03:00',   'default time');
  assert.strictEqual(s.day, 0,          'default day');
  assert.strictEqual(s.scope, undefined,      'scope concept removed');
  assert.strictEqual(s.target_pct, undefined, 'target_pct concept removed');

  // ── 1b. Valid values pass through ──────────────────────────────────────────
  setSetting('cbz_cache_autoclear_mode', 'weekly');
  setSetting('cbz_cache_autoclear_max_age_days', '3');
  s = schedule.readAutoclearSettings(db);
  assert.strictEqual(s.mode, 'weekly');
  assert.strictEqual(s.max_age_days, 3);

  // ── 1c. Invalid values fall back to defaults ───────────────────────────────
  setSetting('cbz_cache_autoclear_mode', 'bogus');
  setSetting('cbz_cache_autoclear_max_age_days', '0'); // < 1
  s = schedule.readAutoclearSettings(db);
  assert.strictEqual(s.mode, 'off',     'invalid mode → off');
  assert.strictEqual(s.max_age_days, 7, 'out-of-range age → 7');

  // ── 2. runScheduledClear is always the age sweep (never wipe) ──────────────
  const calls = [];
  const orig = { sweepOlderThan: cbzCache.sweepOlderThan, wipe: cbzCache.wipe };
  cbzCache.sweepOlderThan = (ms) => { calls.push(['sweepOlderThan', ms]); return { removed: 0, freed: 0 }; };
  cbzCache.wipe           = ()   => { calls.push(['wipe']);               return undefined; };

  try {
    clearAutoclear();
    setSetting('cbz_cache_autoclear_max_age_days', '5');
    calls.length = 0;
    schedule.runScheduledClear();
    assert.deepStrictEqual(calls, [['sweepOlderThan', 5 * 24 * 60 * 60 * 1000]], 'scheduled clear → sweepOlderThan(5d)');
    assert.ok(!calls.some(c => c[0] === 'wipe'), 'scheduled clear never calls wipe()');

    // A different threshold is picked up live on the next run.
    setSetting('cbz_cache_autoclear_max_age_days', '14');
    calls.length = 0;
    schedule.runScheduledClear();
    assert.deepStrictEqual(calls, [['sweepOlderThan', 14 * 24 * 60 * 60 * 1000]], 'threshold re-read live at fire time');
  } finally {
    Object.assign(cbzCache, orig); // restore
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* DB file locked on Windows — OS reaps temp */ }
  console.log('cbzCacheSchedule.test.js: PASS — settings defaults/coercion + age-sweep-only routing (no wipe)');
  process.exit(0);
} catch (err) {
  console.error('cbzCacheSchedule.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
