/**
 * Per-device login lockout. Mirrors `auth/pinLockout.js` (the pairing-PIN
 * limiter) but for user login, and keyed by the **device** rather than the IP
 * so the cap really "locks out the device" (requirement #7) and a brute-forcer
 * can't cycle usernames to dodge it.
 *
 * Key precedence:
 *   - `client:<paired_client_id>` when the request arrived on a paired-device
 *     token (the normal post-pairing case).
 *   - `ip:<addr>` otherwise (LAN-bypass / admin / open).
 *
 * Persisted to the `login_lockouts` table so a restart mid-attack doesn't reset
 * the counter. Cap is `login_max_attempts` (default 5); lockout lasts 24 h.
 */

const { getDb } = require('../db/database');

const LOCKOUT_DURATION_SEC = 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const MIN_MAX_ATTEMPTS     = 1;
const MAX_MAX_ATTEMPTS     = 100;
const SETTING_KEY          = 'login_max_attempts';

function nowSec() { return Math.floor(Date.now() / 1000); }

/** Stable lockout key for a request (device first, IP fallback). */
function keyFor(req) {
  if (req && req.auth && req.auth.kind === 'client' && req.auth.clientId) {
    return `client:${req.auth.clientId}`;
  }
  return `ip:${(req && req.ip) || 'unknown'}`;
}

function getMaxAttempts(db) {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(SETTING_KEY);
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n < MIN_MAX_ATTEMPTS) return DEFAULT_MAX_ATTEMPTS;
  if (n > MAX_MAX_ATTEMPTS) return MAX_MAX_ATTEMPTS;
  return n;
}

function setMaxAttempts(db, n) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(SETTING_KEY, String(n));
}

/** Current lockout status for the request's device/IP. */
function status(req) {
  const key = keyFor(req);
  const db = getDb();
  const row = db.prepare('SELECT failed_attempts, locked_until FROM login_lockouts WHERE lockout_key = ?').get(key);
  if (!row) return { locked: false, locked_until: 0, seconds_remaining: 0, failed_attempts: 0, key };
  const now = nowSec();
  if (row.locked_until > now) {
    return { locked: true, locked_until: row.locked_until, seconds_remaining: row.locked_until - now, failed_attempts: row.failed_attempts, key };
  }
  return { locked: false, locked_until: 0, seconds_remaining: 0, failed_attempts: row.failed_attempts, key };
}

/**
 * Record a failed login. At the cap, locks the device for 24 h. Returns the
 * updated status including `attempts_remaining` and `just_locked`.
 */
function recordFailure(req) {
  const db = getDb();
  const key = keyFor(req);
  const max = getMaxAttempts(db);
  const now = nowSec();

  const row = db.prepare('SELECT failed_attempts, locked_until FROM login_lockouts WHERE lockout_key = ?').get(key);
  if (row && row.locked_until > now) {
    return { locked: true, locked_until: row.locked_until, attempts: row.failed_attempts, max_attempts: max, attempts_remaining: 0, just_locked: false };
  }

  const attempts = (row?.failed_attempts || 0) + 1;
  const lockedUntil = attempts >= max ? now + LOCKOUT_DURATION_SEC : 0;

  db.prepare(`
    INSERT INTO login_lockouts (lockout_key, failed_attempts, locked_until, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(lockout_key) DO UPDATE SET
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

/** Clear the counter on a successful login. Idempotent. */
function clear(req) {
  getDb().prepare('DELETE FROM login_lockouts WHERE lockout_key = ?').run(keyFor(req));
}

/** Clear a lockout by its raw key (admin escape hatch). */
function clearKey(key) {
  if (!key) return;
  getDb().prepare('DELETE FROM login_lockouts WHERE lockout_key = ?').run(String(key));
}

module.exports = {
  LOCKOUT_DURATION_SEC, DEFAULT_MAX_ATTEMPTS, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS, SETTING_KEY,
  keyFor, getMaxAttempts, setMaxAttempts, status, recordFailure, clear, clearKey,
};
