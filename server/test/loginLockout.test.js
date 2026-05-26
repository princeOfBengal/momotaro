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

getDb().close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('loginLockout.test.js: ALL PASSED');
process.exit(0);
