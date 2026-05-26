/**
 * Phase-5 admin user-management test. Drives the real adminAuth router over
 * HTTP with a valid admin session. Covers: roster, create (first account
 * adopts the default user), per-user export bundle (no secrets), per-user
 * history, force-logout (session revocation), all-users history, the
 * delete-cascade, and the primary-account delete guard.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):  node test/admin-users.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-adm-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb, DEFAULT_USER_ID } = require('../src/db/database');
const { hashPassword } = require('../src/auth/crypto');
const adminSession = require('../src/auth/adminSession');
const userSession = require('../src/auth/userSession');
const adminRoutes = require('../src/routes/adminAuth');

const db = getDb();
// Configure admin (so requireAdmin doesn't 409) + mint a session token.
db.prepare("INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(hashPassword('adminpassword'));
const ADMIN = adminSession.createSession();

db.exec(`
  INSERT INTO manga (id, folder_name, path, title, genres) VALUES (10, 'm', '/lib/m', 'Mystery One', '["Mystery"]');
  INSERT INTO chapters (id, manga_id, folder_name, path, type, number) VALUES (100, 10, 'c1', '/lib/m/c1', 'folder', 1);
`);

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', adminRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN };

  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  const del  = (p) => fetch(`${base}${p}`, { method: 'DELETE', headers: H });
  const getJ = (p) => fetch(`${base}${p}`, { headers: H }).then(r => r.json());

  // Create two accounts via the admin endpoint. First adopts the default user.
  let res = await post('/api/admin/users', { username: 'alice', password: 'password123', is_admin: true });
  assert.equal(res.status, 201, 'create alice 201');
  const alice = (await res.json()).data;
  assert.equal(alice.id, DEFAULT_USER_ID, 'first account adopts default user id=1');

  res = await post('/api/admin/users', { username: 'bob', password: 'password123' });
  const bob = (await res.json()).data;
  assert.ok(bob.id !== DEFAULT_USER_ID, 'bob is a new user');

  // Give bob some reading data + a session.
  db.prepare('INSERT INTO progress (user_id, manga_id, current_chapter_id, current_page, completed_chapters) VALUES (?, 10, 100, 2, ?)').run(bob.id, '[100]');
  db.prepare('INSERT INTO reading_history (user_id, manga_id, chapter_id, event) VALUES (?, 10, 100, ?)').run(bob.id, 'completed');
  const horror = db.prepare('INSERT INTO reading_lists (user_id, name, is_default) VALUES (?, ?, 0)').run(bob.id, 'Horror').lastInsertRowid;
  db.prepare('INSERT INTO reading_list_manga (list_id, manga_id) VALUES (?, 10)').run(horror);
  const bobToken = userSession.create(bob.id, null, { ip: '1.2.3.4' });
  assert.ok(userSession.validate(bobToken, {}), 'bob session valid');

  // Roster includes both with counts.
  const roster = await getJ('/api/admin/users');
  const bobRow = roster.data.find(u => u.id === bob.id);
  assert.ok(bobRow && bobRow.progress_count === 1 && bobRow.history_count === 1, 'roster shows bob counts');
  assert.ok(roster.data.find(u => u.id === alice.id && u.is_admin), 'alice is admin in roster');

  // Per-user export bundle — has data, no secrets.
  res = await fetch(`${base}/api/admin/users/${bob.id}/export`, { headers: H });
  assert.equal(res.status, 200, 'export 200');
  const bundle = await res.json();
  assert.equal(bundle.account.username, 'bob', 'export account');
  assert.ok(!('password_hash' in bundle.account), 'no password hash in export');
  assert.ok(bundle.progress.some(p => p.manga_path === '/lib/m'), 'export has progress by path');
  assert.ok(bundle.reading_lists.some(l => l.name === 'Horror'), 'export has reading list');
  assert.ok(bundle.reading_history.length === 1, 'export has history');

  // Per-user history.
  const hist = await getJ(`/api/admin/users/${bob.id}/history`);
  assert.ok(hist.data.length === 1 && hist.data[0].manga_title === 'Mystery One', 'per-user history joined to title');

  // All-users history joins username.
  const allHist = await getJ('/api/admin/reading-history');
  assert.ok(allHist.data.some(r => r.username === 'bob' && r.manga_title === 'Mystery One'), 'all-users history joins username');

  // Force-logout revokes bob's sessions.
  res = await post(`/api/admin/users/${bob.id}/revoke-sessions`);
  assert.equal(res.status, 200, 'revoke-sessions 200');
  assert.equal(userSession.validate(bobToken, {}), null, 'bob session revoked');

  // Cannot delete the primary account.
  res = await del(`/api/admin/users/${DEFAULT_USER_ID}`);
  assert.equal(res.status, 400, 'primary account delete blocked');

  // Delete bob → cascades all reading data.
  res = await del(`/api/admin/users/${bob.id}`);
  assert.equal(res.status, 200, 'delete bob 200');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(bob.id).n, 0, 'bob gone');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM progress WHERE user_id = ?').get(bob.id).n, 0, 'progress cascaded');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_history WHERE user_id = ?').get(bob.id).n, 0, 'history cascaded');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_lists WHERE user_id = ?').get(bob.id).n, 0, 'lists cascaded');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_sessions WHERE user_id = ?').get(bob.id).n, 0, 'sessions cascaded');

  // PATCH: reset password revokes sessions; disable guard on primary.
  res = await fetch(`${base}/api/admin/users/${alice.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ new_password: 'newpassword1' }) });
  assert.equal(res.status, 200, 'patch reset password 200');
  res = await fetch(`${base}/api/admin/users/${DEFAULT_USER_ID}`, { method: 'PATCH', headers: H, body: JSON.stringify({ disabled: true }) });
  assert.equal(res.status, 400, 'cannot disable primary account');

  // Login-lockouts list works.
  const ll = await getJ('/api/admin/login-lockouts');
  assert.ok(Array.isArray(ll.data.active_lockouts), 'login-lockouts list');

  srv.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('admin-users.test.js: ALL PASSED');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
