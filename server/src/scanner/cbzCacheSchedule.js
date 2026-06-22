const cbzCache = require('./cbzCache');
const { getDb } = require('../db/database');
const genresCache = require('../genresCache');

// Auto-clear scheduler for the CBZ extract cache. Fires at a configurable
// daily or weekly time (server local time) and runs an age-based sweep: every
// scheduled clear evicts only chapters that haven't been read within
// `max_age_days`. State lives in the `settings` table so it survives restarts:
//
//   cbz_cache_autoclear_mode         — 'off' | 'daily' | 'weekly'  (cadence)
//   cbz_cache_autoclear_day          — 0..6  (0 = Sunday; weekly only)
//   cbz_cache_autoclear_time         — 'HH:MM' (24-hour)
//   cbz_cache_autoclear_max_age_days — integer >= 1 (age cutoff)
//
// The scheduled clear is ALWAYS the age sweep (cbzCache.sweepOlderThan), which
// skips chapters with an in-flight extraction — so it never aborts a chapter the
// user is actively reading, and never discards the warm cache wholesale. The
// destructive full wipe (cbzCache.wipe) is reserved for the manual
// Settings → Clear Cache button and is never used on a schedule.
//
// reschedule() is idempotent — callers may invoke it on startup and again
// every time settings change.

let currentTimer  = null;
let nextRunAt     = null;   // Date | null

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const VALID_MODES  = new Set(['off', 'daily', 'weekly']);

const DEFAULTS = {
  mode:         'off',
  day:          0,
  time:         '03:00',
  max_age_days: 7,
};

// Single source of truth for the auto-clear settings, shared by the scheduler
// and the admin route so the API can never report a schedule the scheduler
// wouldn't run. Invalid / missing values fall back to DEFAULTS.
function readAutoclearSettings(db = getDb()) {
  const rows = db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN (
      'cbz_cache_autoclear_mode',
      'cbz_cache_autoclear_day',
      'cbz_cache_autoclear_time',
      'cbz_cache_autoclear_max_age_days'
    )
  `).all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const day        = parseInt(map['cbz_cache_autoclear_day'], 10);
  const maxAgeDays = parseInt(map['cbz_cache_autoclear_max_age_days'], 10);

  return {
    mode: VALID_MODES.has(map['cbz_cache_autoclear_mode']) ? map['cbz_cache_autoclear_mode'] : DEFAULTS.mode,
    day:  Number.isInteger(day) && day >= 0 && day <= 6    ? day                             : DEFAULTS.day,
    time: map['cbz_cache_autoclear_time']                  || DEFAULTS.time,
    max_age_days: Number.isFinite(maxAgeDays) && maxAgeDays >= 1 ? maxAgeDays : DEFAULTS.max_age_days,
  };
}

function computeNextRunAt(now, settings) {
  const { mode, day, time } = settings;
  if (mode !== 'daily' && mode !== 'weekly') return null;

  const [rawH, rawM] = String(time).split(':').map(s => parseInt(s, 10));
  const hour = Number.isFinite(rawH) ? Math.min(Math.max(rawH, 0), 23) : 3;
  const min  = Number.isFinite(rawM) ? Math.min(Math.max(rawM, 0), 59) : 0;

  const target = new Date(now);
  target.setHours(hour, min, 0, 0);

  if (mode === 'daily') {
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }

  // weekly
  const currentDow = target.getDay();
  let deltaDays = (day - currentDow + 7) % 7;
  if (deltaDays === 0 && target <= now) deltaDays = 7;
  target.setDate(target.getDate() + deltaDays);
  return target;
}

function formatNextRun(date, settings) {
  const pad = n => String(n).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (settings.mode === 'weekly') {
    return `${DAY_NAMES[date.getDay()]} ${hhmm} (weekly)`;
  }
  return `${date.toLocaleDateString()} ${hhmm} (daily)`;
}

function gb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

// Execute one scheduled clear — always the active-safe age sweep, never wipe()
// (which would abort in-flight reads). Settings are re-read live at fire time so
// a threshold change that landed since the timer was armed (including via config
// import, which writes settings directly) takes effect on this run.
function runScheduledClear() {
  let s;
  try { s = readAutoclearSettings(); }
  catch (err) {
    console.error('[CBZ Cache] Could not read auto-clear settings at fire time:', err.message);
    return;
  }
  try {
    const maxAgeMs = s.max_age_days * 24 * 60 * 60 * 1000;
    const { removed, freed } = cbzCache.sweepOlderThan(maxAgeMs);
    console.log(`[CBZ Cache] Auto-clear (not read in ${s.max_age_days}d) — evicted ${removed} chapter${removed === 1 ? '' : 's'} (${gb(freed)} GB).`);
  } catch (err) {
    console.error('[CBZ Cache] Auto-clear failed:', err.message);
  }
}

function reschedule() {
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
  nextRunAt = null;

  let settings;
  try {
    settings = readAutoclearSettings();
  } catch (err) {
    console.error('[CBZ Cache] Could not read auto-clear settings:', err.message);
    return;
  }

  if (settings.mode === 'off') {
    console.log('[CBZ Cache] Auto-clear disabled.');
    return;
  }

  const now = new Date();
  const fireAt = computeNextRunAt(now, settings);
  if (!fireAt) return;

  const ms = Math.max(0, fireAt.getTime() - now.getTime());
  nextRunAt = fireAt;
  console.log(`[CBZ Cache] Next auto-clear: ${formatNextRun(fireAt, settings)}`);

  currentTimer = setTimeout(() => {
    runScheduledClear();
    // Piggyback on the auto-clear cadence to refresh the Browse By Genre
    // payload. Keeps the per-genre top-cover sub-queries off the request
    // path — they fire once per scheduled clear, not once per visitor.
    genresCache.precompute();
    reschedule();
  }, ms);
  currentTimer.unref();
}

function getNextRunAt() {
  return nextRunAt ? nextRunAt.toISOString() : null;
}

module.exports = {
  reschedule,
  getNextRunAt,
  readAutoclearSettings,
  runScheduledClear,
  VALID_MODES,
  DEFAULTS,
};
