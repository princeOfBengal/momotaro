/**
 * Phase-1 config export/import round-trip test. Mounts the real config router
 * on a bare Express app and drives it over HTTP, against a temp DB migrated by
 * the real db/database.js. Verifies:
 *
 *   1. Round-trip: export → wipe per-user data → import reproduces it on the
 *      default user (progress, custom reading list + membership, history).
 *   2. v1 backward-compat: a pre-user-accounts payload (no usernames,
 *      device_anilist_sessions) imports cleanly, folding everything onto the
 *      default user — and crucially the reading_lists insert does NOT throw on
 *      the new UNIQUE(user_id, name) constraint.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):
 *
 *   node test/config-roundtrip.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-cfgtest-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb, DEFAULT_USER_ID } = require('../src/db/database');
const configRoutes = require('../src/routes/config');

const db = getDb(); // runs migrate(): creates default user + default lists

const MPATH = '/lib/alpha';

function seed() {
  db.exec(`
    INSERT INTO manga (id, folder_name, path, title, genres) VALUES (10, 'alpha', '${MPATH}', 'Alpha', '["Mystery"]');
    INSERT INTO chapters (id, manga_id, folder_name, path, type) VALUES (100, 10, 'c1', '${MPATH}/c1', 'folder');
    INSERT INTO progress (user_id, manga_id, current_chapter_id, current_page, completed_chapters)
      VALUES (${DEFAULT_USER_ID}, 10, 100, 5, '[100]');
    INSERT INTO reading_lists (user_id, name, is_default) VALUES (${DEFAULT_USER_ID}, 'Horror', 0);
  `);
  const horrorId = db.prepare("SELECT id FROM reading_lists WHERE user_id = ? AND name = 'Horror'").pluck().get(DEFAULT_USER_ID);
  db.prepare('INSERT INTO reading_list_manga (list_id, manga_id) VALUES (?, 10)').run(horrorId);
  db.prepare('INSERT INTO reading_history (user_id, manga_id, chapter_id, event) VALUES (?, 10, 100, ?)').run(DEFAULT_USER_ID, 'completed');
}

function wipePerUser() {
  db.exec(`
    DELETE FROM reading_list_manga;
    DELETE FROM reading_lists WHERE is_default = 0;
    DELETE FROM progress;
    DELETE FROM reading_history;
  `);
}

async function main() {
  seed();

  const app = express();
  app.use(express.json({ limit: '64mb' }));
  app.use('/api', configRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  // 1) Export.
  const exp = await fetch(`${base}/api/admin/export-config`);
  assert.equal(exp.status, 200, 'export 200');
  const payload = await exp.json();
  assert.equal(payload.version, 2, 'export is v2');
  assert.ok(Array.isArray(payload.users) && payload.users.some(u => u.username === 'default'), 'users roster present');
  const pr = payload.progress.find(p => p.manga_path === MPATH);
  assert.ok(pr && pr.username === 'default', 'progress carries username');
  assert.deepEqual(pr.completed_chapter_folders, ['c1'], 'completed folders translated');
  const horror = payload.reading_lists.find(l => l.name === 'Horror');
  assert.ok(horror && horror.username === 'default' && horror.manga[0].manga_path === MPATH, 'reading list exported with membership');
  assert.ok(payload.reading_history.some(h => h.manga_path === MPATH && h.event === 'completed'), 'history exported');

  // 2) Wipe then re-import the exported payload.
  wipePerUser();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM progress').get().n, 0, 'progress wiped');
  const imp = await fetch(`${base}/api/admin/import-config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(imp.status, 200, 'import 200');

  const prog = db.prepare('SELECT * FROM progress WHERE manga_id = 10').get();
  assert.ok(prog && prog.user_id === DEFAULT_USER_ID && prog.current_page === 5, 'progress restored on default user');
  assert.equal(JSON.parse(prog.completed_chapters)[0], 100, 'completed chapter re-resolved');
  assert.ok(db.prepare("SELECT 1 FROM reading_lists WHERE user_id = ? AND name = 'Horror'").get(DEFAULT_USER_ID), 'Horror list restored');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_list_manga').get().n, 1, 'membership restored');
  assert.ok(db.prepare('SELECT 1 FROM reading_history WHERE manga_id = 10').get(), 'history restored');
  console.log('config-roundtrip.test.js: v2 round-trip passed');

  // 3) v1 backward-compat import.
  wipePerUser();
  const v1 = {
    app: 'momotaro', version: 1, settings: {},
    device_anilist_sessions: [
      { device_id: 'd1', anilist_token: 'tokV1', anilist_user_id: '7', anilist_username: 'legacy', updated_at: 50 },
    ],
    libraries: [], manga_metadata: [],
    reading_lists: [{ name: 'V1 List', is_default: 0, manga: [{ manga_path: MPATH }] }],
    progress: [{ manga_path: MPATH, current_chapter_folder: 'c1', current_page: 9, completed_chapter_folders: ['c1'] }],
    art_gallery: [],
  };
  const imp1 = await fetch(`${base}/api/admin/import-config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v1),
  });
  assert.equal(imp1.status, 200, 'v1 import 200 (no UNIQUE(user_id,name) throw)');
  const prog1 = db.prepare('SELECT * FROM progress WHERE manga_id = 10').get();
  assert.ok(prog1 && prog1.user_id === DEFAULT_USER_ID && prog1.current_page === 9, 'v1 progress on default user');
  assert.ok(db.prepare("SELECT 1 FROM reading_lists WHERE user_id = ? AND name = 'V1 List'").get(DEFAULT_USER_ID), 'v1 list on default user');
  const sess = db.prepare('SELECT * FROM user_anilist_sessions WHERE user_id = ?').get(DEFAULT_USER_ID);
  assert.ok(sess && sess.anilist_token === 'tokV1', 'v1 device session folded onto default user');
  console.log('config-roundtrip.test.js: v1 backward-compat passed');

  srv.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('config-roundtrip.test.js: ALL PASSED');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
