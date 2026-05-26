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
 *
 * Thin wrapper over `createLockoutStore` — see [auth/lockout.js] for the
 * shared state machine that also powers `loginLockout`.
 */

const {
  createLockoutStore,
  LOCKOUT_DURATION_SEC, DEFAULT_MAX_ATTEMPTS, MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS,
} = require('./lockout');

const SETTING_KEY = 'pairing_pin_max_attempts';

const store = createLockoutStore({
  table:      'pin_lockouts',
  keyColumn:  'ip',
  settingKey: SETTING_KEY,
});

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  MIN_MAX_ATTEMPTS,
  MAX_MAX_ATTEMPTS,
  LOCKOUT_DURATION_SEC,
  SETTING_KEY,
  getMaxAttempts: store.getMaxAttempts,
  setMaxAttempts: store.setMaxAttempts,
  status:         (ip) => store.status(ip),
  recordFailure:  (ip) => store.recordFailure(ip),
  clear:          (ip) => store.clear(ip),
};
