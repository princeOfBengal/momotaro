/**
 * Phase-2 cross-user isolation test. Two accounts read against the same
 * catalogue; asserts that one account's progress, Home, stats, and reading
 * lists are invisible to the other (requirement #4) — and that per-user cache
 * keys don't cross-serve.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):
 *
 *   node test/isolation.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-iso-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb } = require('../src/db/database');
const { resolveUser, requireUser } = require('../src/middleware/userAuth');
const userRoutes = require('../src/routes/users');
const libraryRoutes = require('../src/routes/library');
const progressRoutes = require('../src/routes/progress');

const db = getDb();
db.prepare("INSERT INTO settings (key, value) VALUES ('multi_user_enabled', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run();

// Seed one manga (in a visible library: library_id NULL) + a chapter. The
// manga_genres trigger fills the genre index from the genres JSON.
db.exec(`
  INSERT INTO manga (id, folder_name, path, title, genres) VALUES (10, 'm', '/lib/m', 'Mystery One', '["Mystery"]');
  INSERT INTO chapters (id, manga_id, folder_name, path, type, number, page_count) VALUES (100, 10, 'c1', '/lib/m/c1', 'folder', 1, 10);
`);

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', resolveUser, userRoutes);                 // login/register (no requireUser)
  app.use('/api', resolveUser, requireUser, libraryRoutes);  // home/stats/reading-lists
  app.use('/api', resolveUser, requireUser, progressRoutes); // progress
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const reg = (u) => fetch(`${base}/api/users/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'password123' }),
  }).then(r => r.json()).then(j => j.data.user_token);
  const J = (t) => ({ 'X-User-Token': t });
  const getJson = (p, t) => fetch(`${base}${p}`, { headers: J(t) }).then(r => r.json()).then(j => j.data);

  const tokA = await reg('alice');
  const tokB = await reg('bob');

  // Alice completes the chapter.
  let res = await fetch(`${base}/api/progress/10`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...J(tokA) },
    body: JSON.stringify({ chapterId: 100, page: 0, markChapterComplete: true }),
  });
  assert.equal(res.status, 200, 'alice progress write 200');

  // Progress isolation.
  const progA = await getJson('/api/progress/10', tokA);
  assert.ok(progA && progA.completed_chapters.includes(100), 'alice sees her progress');
  const progB = await getJson('/api/progress/10', tokB);
  assert.equal(progB, null, 'bob sees no progress for the same manga');

  // Home isolation.
  const homeA = await getJson('/api/home', tokA);
  assert.ok(homeA.continue_reading.some(m => m.id === 10), 'alice Home shows the read manga');
  const homeB = await getJson('/api/home', tokB);
  assert.equal(homeB.continue_reading.length, 0, 'bob Home is empty');

  // Stats isolation — favorite genres are recalculated per user.
  const statsA = await getJson('/api/stats', tokA);
  assert.ok(statsA.favorite_genres.some(g => g.genre === 'Mystery'), 'alice favorite genres include Mystery');
  const statsB = await getJson('/api/stats', tokB);
  assert.equal(statsB.favorite_genres.length, 0, 'bob has no favorite genres');

  // Reading-list isolation.
  res = await fetch(`${base}/api/reading-lists`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...J(tokA) },
    body: JSON.stringify({ name: 'AliceList' }),
  });
  assert.equal(res.status, 201, 'alice creates a list');
  const listsA = await getJson('/api/reading-lists', tokA);
  const listsB = await getJson('/api/reading-lists', tokB);
  assert.ok(listsA.some(l => l.name === 'AliceList'), 'alice sees AliceList');
  assert.ok(!listsB.some(l => l.name === 'AliceList'), 'bob does NOT see AliceList');
  // Each user has their own default lists.
  assert.ok(listsB.some(l => l.name === 'Favorites'), 'bob has his own Favorites');

  srv.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('isolation.test.js: ALL PASSED');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
