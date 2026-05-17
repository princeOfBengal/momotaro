/**
 * Tracks failed pairing-PIN guesses per source IP and enforces a 24-hour
 * lockout once the admin-configured cap is reached. Persisted to the
 * `pin_lockouts` SQLite table so a server restart doesn't reset the counter
 * mid-attack.
 *
 * The per-pending-pairing `attempts` field on `pending_pairings` is still
 * what causes a single handshake to give up after too many wrong PINs; this
 * module is the cross-pairing safety net that stops an attacker from simply
 * restarting the handshake to reset that counter.
 */

const { getDb } = require('../db/database');

const LOCKOUT_DURATION_SEC   = 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS   = 5;
const MIN_MAX_ATTEMPTS       = 1;
const MAX_MAX_ATTEMPTS       = 100;
const SETTING_KEY            = 'pairing_pin_max_attempts';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function getMaxAttempts(db) {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(SETTING_KEY);
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n < MIN_MAX_ATTEMPTS) return DEFAULT_MAX_ATTEMPTS;
  if (n > MAX_MAX_ATTEMPTS) return MAX_MAX_ATTEMPTS;
  return n;
}

function setMaxAttempts(db, n) {
  const v = String(n);
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(SETTING_KEY, v);
}

/**
 * Returns { locked: boolean, locked_until: number, seconds_remaining: number }
 * for the given IP. `locked_until` is the unix-epoch second at which the
 * lockout ends; 0 when not locked.
 */
function status(ip) {
  if (!ip) return { locked: false, locked_until: 0, seconds_remaining: 0, failed_attempts: 0 };
  const db = getDb();
  const row = db.prepare(
    'SELECT failed_attempts, locked_until FROM pin_lockouts WHERE ip = ?'
  ).get(ip);
  if (!row) return { locked: false, locked_until: 0, seconds_remaining: 0, failed_attempts: 0 };
  const now = nowSec();
  if (row.locked_until > now) {
    return {
      locked: true,
      locked_until: row.locked_until,
      seconds_remaining: row.locked_until - now,
      failed_attempts: row.failed_attempts,
    };
  }
  return {
    locked: false,
    locked_until: 0,
    seconds_remaining: 0,
    failed_attempts: row.failed_attempts,
  };
}

/**
 * Record a wrong-PIN attempt for the IP. If the count reaches the configured
 * maximum, the IP is locked out for 24 hours. Returns the updated status,
 * including whether the lockout just triggered and how many attempts remain
 * (clamped at 0 on lockout).
 */
function recordFailure(ip) {
  const db = getDb();
  const max = getMaxAttempts(db);
  const now = nowSec();

  if (!ip) {
    return {
      locked: false,
      locked_until: 0,
      attempts: 0,
      max_attempts: max,
      attempts_remaining: max,
      just_locked: false,
    };
  }

  const row = db.prepare(
    'SELECT failed_attempts, locked_until FROM pin_lockouts WHERE ip = ?'
  ).get(ip);

  // Already locked — don't increment further; the caller checks status() first
  // and rejects, but be defensive.
  if (row && row.locked_until > now) {
    return {
      locked: true,
      locked_until: row.locked_until,
      attempts: row.failed_attempts,
      max_attempts: max,
      attempts_remaining: 0,
      just_locked: false,
    };
  }

  const attempts = (row?.failed_attempts || 0) + 1;
  let lockedUntil = 0;
  if (attempts >= max) {
    lockedUntil = now + LOCKOUT_DURATION_SEC;
  }

  db.prepare(`
    INSERT INTO pin_lockouts (ip, failed_attempts, locked_until, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      failed_attempts = excluded.failed_attempts,
      locked_until    = excluded.locked_until,
      updated_at      = excluded.updated_at
  `).run(ip, attempts, lockedUntil, now);

  return {
    locked: lockedUntil > 0,
    locked_until: lockedUntil,
    attempts,
    max_attempts: max,
    attempts_remaining: Math.max(0, max - attempts),
    just_locked: lockedUntil > 0,
  };
}

/**
 * Clears the per-IP counter on a successful PIN entry. Idempotent.
 */
function clear(ip) {
  if (!ip) return;
  const db = getDb();
  db.prepare('DELETE FROM pin_lockouts WHERE ip = ?').run(ip);
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  MIN_MAX_ATTEMPTS,
  MAX_MAX_ATTEMPTS,
  LOCKOUT_DURATION_SEC,
  SETTING_KEY,
  getMaxAttempts,
  setMaxAttempts,
  status,
  recordFailure,
  clear,
};
