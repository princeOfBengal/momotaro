/**
 * Phase-2 user-auth flow test. Drives the real users router over HTTP against a
 * migrated temp DB with multi-user enabled. Covers register (first account
 * adopts the default user), login (incl. generic failure + attempts_remaining),
 * me, logout (session revocation), duplicate username, and exists.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):
 *
 *   node test/userAuth.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-auth-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb } = require('../src/db/database');
const { resolveUser } = require('../src/middleware/userAuth');
const userRoutes = require('../src/routes/users');

const db = getDb();
db.prepare("INSERT INTO settings (key, value) VALUES ('multi_user_enabled', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run();

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', resolveUser, userRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });

  // Register first account → adopts default user (id=1).
  let res = await post('/api/users/register', { username: 'alice', password: 'password123' });
  assert.equal(res.status, 201, 'register alice 201');
  const alice = (await res.json()).data;
  assert.ok(alice.user_token, 'alice got a token');
  assert.equal(alice.user.id, 1, 'first account adopts default user id=1');
  assert.equal(alice.user.username, 'alice', 'username set');

  // me with token works; without token is 401.
  res = await get('/api/users/me', { 'X-User-Token': alice.user_token });
  assert.equal(res.status, 200, 'me 200 with token');
  assert.equal((await res.json()).data.username, 'alice', 'me returns alice');
  res = await get('/api/users/me');
  assert.equal(res.status, 401, 'me 401 without token');

  // Login: wrong password is generic 401 with attempts_remaining; right works.
  res = await post('/api/users/login', { username: 'alice', password: 'nope' });
  assert.equal(res.status, 401, 'wrong password 401');
  const failBody = await res.json();
  assert.equal(failBody.error, 'Incorrect username or password', 'generic error (no enumeration)');
  assert.equal(typeof failBody.attempts_remaining, 'number', 'attempts_remaining present');
  res = await post('/api/users/login', { username: 'alice', password: 'password123' });
  assert.equal(res.status, 200, 'login 200');
  assert.ok((await res.json()).data.user_token, 'login returns token');

  // Duplicate username → 409.
  res = await post('/api/users/register', { username: 'Alice', password: 'password123' });
  assert.equal(res.status, 409, 'duplicate username (case-insensitive) 409');

  // Second account is created fresh (not adoption).
  res = await post('/api/users/register', { username: 'bob', password: 'password123' });
  assert.equal(res.status, 201, 'register bob 201');
  const bob = (await res.json()).data;
  assert.notEqual(bob.user.id, 1, 'bob is a new user, not the default');

  // Logout revokes the session.
  res = await post('/api/users/logout', {}, { 'X-User-Token': alice.user_token });
  assert.equal(res.status, 200, 'logout 200');
  res = await get('/api/users/me', { 'X-User-Token': alice.user_token });
  assert.equal(res.status, 401, 'me 401 after logout (session revoked)');

  // exists.
  res = await get('/api/users/exists?username=bob');
  assert.equal((await res.json()).data.exists, true, 'bob exists');
  res = await get('/api/users/exists?username=charlie');
  assert.equal((await res.json()).data.exists, false, 'charlie does not exist');

  srv.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('userAuth.test.js: ALL PASSED');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
