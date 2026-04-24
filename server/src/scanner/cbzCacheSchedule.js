const cbzCache = require('./cbzCache');
const { getDb } = require('../db/database');

// Auto-clear scheduler for the CBZ extract cache. Fires at a configurable
// daily or weekly time (server local time) and wipes the cache. State lives
// in the `settings` table so it survives restarts:
//
//   cbz_cache_autoclear_mode — 'off' | 'daily' | 'weekly'
//   cbz_cache_autoclear_day  — 0..6  (0 = Sunday; weekly only)
//   cbz_cache_autoclear_time — 'HH:MM' (24-hour)
//
// reschedule() is idempotent — callers may invoke it on startup and again
// every time settings change.

let currentTimer  = null;
let nextRunAt     = null;   // Date | null

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readSettings() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN (
      'cbz_cache_autoclear_mode',
      'cbz_cache_autoclear_day',
      'cbz_cache_autoclear_time'
    )
  `).all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const day = parseInt(map['cbz_cache_autoclear_day'] || '0', 10);
  return {
    mode: map['cbz_cache_autoclear_mode'] || 'off',
    day:  Number.isInteger(day) && day >= 0 && day <= 6 ? day : 0,
    time: map['cbz_cache_autoclear_time'] || '03:00',
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

function reschedule() {
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
  nextRunAt = null;

  let settings;
  try {
    settings = readSettings();
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
    try {
      cbzCache.wipe();
      console.log('[CBZ Cache] Auto-clear fired — cache wiped.');
    } catch (err) {
      console.error('[CBZ Cache] Auto-clear failed:', err.message);
    }
    reschedule();
  }, ms);
  currentTimer.unref();
}

function getNextRunAt() {
  return nextRunAt ? nextRunAt.toISOString() : null;
}

module.exports = { reschedule, getNextRunAt };
