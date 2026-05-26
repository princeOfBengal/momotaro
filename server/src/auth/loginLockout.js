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
 *
 * Thin wrapper over `createLockoutStore` — see [auth/lockout.js] for the
 * shared state machine that also powers `pinLockout`.
 */

const {
  createLockoutStore,
  LOCKOUT_DURATION_SEC, DEFAULT_MAX_ATTEMPTS, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS,
} = require('./lockout');

const SETTING_KEY = 'login_max_attempts';

const store = createLockoutStore({
  table:      'login_lockouts',
  keyColumn:  'lockout_key',
  settingKey: SETTING_KEY,
});

/** Stable lockout key for a request (device first, IP fallback). */
function keyFor(req) {
  if (req && req.auth && req.auth.kind === 'client' && req.auth.clientId) {
    return `client:${req.auth.clientId}`;
  }
  return `ip:${(req && req.ip) || 'unknown'}`;
}

/** Current lockout status for the request's device/IP. Includes the resolved key. */
function status(req) {
  const key = keyFor(req);
  return { ...store.status(key), key };
}

function recordFailure(req) {
  return store.recordFailure(keyFor(req));
}

function clear(req) {
  store.clear(keyFor(req));
}

/** Clear a lockout by its raw key (admin escape hatch). */
function clearKey(key) {
  if (!key) return;
  store.clear(String(key));
}

module.exports = {
  LOCKOUT_DURATION_SEC, DEFAULT_MAX_ATTEMPTS, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS, SETTING_KEY,
  keyFor,
  getMaxAttempts: store.getMaxAttempts,
  setMaxAttempts: store.setMaxAttempts,
  status,
  recordFailure,
  clear,
  clearKey,
};
