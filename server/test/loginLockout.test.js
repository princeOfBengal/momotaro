/**
 * Phase-2 login-lockout test. Verifies the 5-strikes → 24 h device lockout,
 * per-device (not per-username/global) keying, and clear-on-success.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):
 *
 *   node test/loginLockout.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-lock-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb } = require('../src/db/database');
getDb(); // run migrate(): creates login_lockouts + settings
const lock = require('../src/auth/loginLockout');

const deviceReq = { auth: { kind: 'client', clientId: 1 }, ip: '203.0.113.5' };
const otherReq  = { ip: '198.51.100.9' }; // different key (IP)

assert.equal(lock.getMaxAttempts(getDb()), 5, 'default cap is 5');
assert.equal(lock.status(deviceReq).locked, false, 'starts unlocked');

// Four failures: still allowed, countdown decreasing.
let r;
for (let i = 1; i <= 4; i++) {
  r = lock.recordFailure(deviceReq);
  assert.equal(r.locked, false, `attempt ${i} not yet locked`);
  assert.equal(r.attempts_remaining, 5 - i, `attempt ${i} remaining`);
}
// Fifth failure trips the lockout.
r = lock.recordFailure(deviceReq);
assert.equal(r.locked, true, 'fifth attempt locks');
assert.equal(r.just_locked, true, 'just_locked set');
assert.ok(r.locked_until > Math.floor(Date.now() / 1000), 'locked_until in the future');
assert.equal(lock.status(deviceReq).locked, true, 'status reports locked');

// A different device/IP is unaffected — lockout is per-device, not global.
assert.equal(lock.status(otherReq).locked, false, 'other device not locked');
assert.equal(lock.recordFailure(otherReq).attempts_remaining, 4, 'other device counts independently');

// Clearing (successful login) resets the device.
lock.clear(deviceReq);
assert.equal(lock.status(deviceReq).locked, false, 'cleared device unlocked');
assert.equal(lock.status(deviceReq).failed_attempts, 0, 'counter reset');

// Device key takes precedence over IP for a paired client.
assert.equal(lock.keyFor({ auth: { kind: 'client', clientId: 9 }, ip: '1.1.1.1' }), 'client:9', 'device key precedence');

// ── Lockout decay: an expired 24 h window restores the full allowance ───────
// Regression guard for the bug where failed_attempts kept climbing past `max`
// forever, so the first failure after a lockout expired re-locked instantly.
const decayReq = { auth: { kind: 'client', clientId: 2 }, ip: '203.0.113.7' };
const decayKey = lock.keyFor(decayReq);
for (let i = 0; i < 5; i++) lock.recordFailure(decayReq);
assert.equal(lock.status(decayReq).locked, true, 'decay device locked after 5 strikes');

// Backdate the row so both the lockout AND the last failure are > 24 h old.
const longAgo = Math.floor(Date.now() / 1000) - (25 * 60 * 60);
getDb().prepare(
  'UPDATE login_lockouts SET locked_until = ?, updated_at = ? WHERE lockout_key = ?'
).run(longAgo, longAgo, decayKey);

const decayedStatus = lock.status(decayReq);
assert.equal(decayedStatus.locked, false, 'expired lockout no longer locked');
assert.equal(decayedStatus.failed_attempts, 0, 'expired lockout counter decays to 0');

// The next failure starts a fresh count (1 of 5) instead of re-locking.
const afterDecay = lock.recordFailure(decayReq);
assert.equal(afterDecay.locked, false, 'single failure after expiry does NOT re-lock');
assert.equal(afterDecay.attempts, 1, 'counter restarts at 1 after the window elapses');
assert.equal(afterDecay.attempts_remaining, 4, 'full allowance minus one restored');

getDb().close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('loginLockout.test.js: ALL PASSED');
process.exit(0);
