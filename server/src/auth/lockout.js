/**
 * Shared lockout state machine. Backs both `pinLockout` (per IP, against the
 * pairing-PIN flow) and `loginLockout` (per device or IP, against user login).
 *
 * The two wrappers differ only in:
 *   - which SQLite table they persist to,
 *   - which column names the table uses for its key + counters,
 *   - which `settings` row stores the admin-configurable cap,
 *   - how they derive the lockout key from their input (raw IP vs. request).
 *
 * Everything else — counter increment, "already locked" short-circuit, lockout
 * duration, status payload shape — is shared here. Callers should keep using
 * their respective wrapper; this factory is an implementation detail.
 */

const { getDb } = require('../db/database');
const { getSetting, setSetting } = require('../utils');

const LOCKOUT_DURATION_SEC = 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const MIN_MAX_ATTEMPTS     = 1;
const MAX_MAX_ATTEMPTS     = 100;

function nowSec() { return Math.floor(Date.now() / 1000); }

/**
 * Build a lockout module against a single SQLite table.
 *
 * @param {object} opts
 * @param {string} opts.table       Lockout table name.
 * @param {string} opts.keyColumn   Name of the PK column holding the lookup key
 *                                  (e.g. 'ip' for pin_lockouts, 'lockout_key'
 *                                  for login_lockouts).
 * @param {string} opts.settingKey  Settings-table row holding the admin's
 *                                  configurable cap.
 */
function createLockoutStore({ table, keyColumn, settingKey }) {
  // Empty-status helper used when there's no DB row for the key.
  const emptyStatus = (extra = {}) => ({
    locked: false, locked_until: 0, seconds_remaining: 0, failed_attempts: 0, ...extra,
  });

  function getMaxAttempts(db) {
    const raw = getSetting(db, settingKey);
    const n = parseInt(raw || '', 10);
    if (!Number.isFinite(n) || n < MIN_MAX_ATTEMPTS) return DEFAULT_MAX_ATTEMPTS;
    if (n > MAX_MAX_ATTEMPTS) return MAX_MAX_ATTEMPTS;
    return n;
  }

  function setMaxAttempts(db, n) {
    setSetting(db, settingKey, String(n));
  }

  function status(key) {
    if (!key) return emptyStatus();
    const db = getDb();
    const row = db.prepare(
      `SELECT failed_attempts, locked_until, updated_at FROM ${table} WHERE ${keyColumn} = ?`
    ).get(key);
    if (!row) return emptyStatus();
    const now = nowSec();
    if (row.locked_until > now) {
      return {
        locked: true,
        locked_until: row.locked_until,
        seconds_remaining: row.locked_until - now,
        failed_attempts: row.failed_attempts,
      };
    }
    // Not currently locked. If the most recent failure is older than one
    // lockout window, the counter has decayed (see recordFailure) — report a
    // fresh allowance so the UI doesn't show a phantom "0 remaining" after the
    // 24 h penalty has been served.
    const decayed = (now - row.updated_at) >= LOCKOUT_DURATION_SEC;
    return {
      locked: false,
      locked_until: 0,
      seconds_remaining: 0,
      failed_attempts: decayed ? 0 : row.failed_attempts,
    };
  }

  function recordFailure(key) {
    const db = getDb();
    const max = getMaxAttempts(db);
    const now = nowSec();

    if (!key) {
      return {
        locked: false, locked_until: 0, attempts: 0,
        max_attempts: max, attempts_remaining: max, just_locked: false,
      };
    }

    const row = db.prepare(
      `SELECT failed_attempts, locked_until, updated_at FROM ${table} WHERE ${keyColumn} = ?`
    ).get(key);

    // Already locked — don't increment further; callers should check status()
    // first and reject, but be defensive.
    if (row && row.locked_until > now) {
      return {
        locked: true, locked_until: row.locked_until,
        attempts: row.failed_attempts, max_attempts: max,
        attempts_remaining: 0, just_locked: false,
      };
    }

    // Decay: if the most recent failure is older than one lockout window, the
    // counter starts fresh. A single rule serves two cases:
    //   - a lockout whose 24 h penalty has elapsed — the device/IP regains the
    //     full allowance instead of being re-locked on the next single mistake
    //     (the previous bug: failed_attempts climbed from `max` forever), and
    //   - a stale partial counter that never reached the cap (no perpetual
    //     accumulation of failures spread across days).
    // A sustained attacker keeps `updated_at` fresh, so brute-force protection
    // is intact: they still get only `max` attempts per lockout window.
    const expired = row && (now - row.updated_at) >= LOCKOUT_DURATION_SEC;
    const priorAttempts = expired ? 0 : (row?.failed_attempts || 0);
    const attempts = priorAttempts + 1;
    const lockedUntil = attempts >= max ? now + LOCKOUT_DURATION_SEC : 0;

    db.prepare(`
      INSERT INTO ${table} (${keyColumn}, failed_attempts, locked_until, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(${keyColumn}) DO UPDATE SET
        failed_attempts = excluded.failed_attempts,
        locked_until    = excluded.locked_until,
        updated_at      = excluded.updated_at
    `).run(key, attempts, lockedUntil, now);

    return {
      locked: lockedUntil > 0,
      locked_until: lockedUntil,
      attempts,
      max_attempts: max,
      attempts_remaining: Math.max(0, max - attempts),
      just_locked: lockedUntil > 0,
    };
  }

  function clear(key) {
    if (!key) return;
    getDb().prepare(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(key);
  }

  return { getMaxAttempts, setMaxAttempts, status, recordFailure, clear };
}

module.exports = {
  createLockoutStore,
  LOCKOUT_DURATION_SEC,
  DEFAULT_MAX_ATTEMPTS,
  MIN_MAX_ATTEMPTS,
  MAX_MAX_ATTEMPTS,
};
