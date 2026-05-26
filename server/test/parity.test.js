/**
 * Phase-7 single-user parity acceptance test. Verifies the [Default-User
 * Equivalence invariant](../../docs/user-accounts-compat.md#1-the-compatibility-invariant):
 *
 *   With one account — or with `multi_user_enabled = 0` — every preexisting
 *   feature behaves identically to how it did before accounts existed.
 *
 * Two modes are exercised against the same seeded library + the same writes,
 * and the responses are asserted equivalent on the user-visible fields:
 *
 *   - Mode A: multi-user OFF (default user, no login required).
 *   - Mode B: multi-user ON, with one account (alice) that adopted the
 *     default user's data — i.e. the typical post-upgrade configuration.
 *
 * Requires a working better-sqlite3 binding (run in the project runtime /
 * Docker):  node test/parity.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-parity-'));
  process.env.DB_PATH = path.join(tmp, 'app.db');
  process.env.SCAN_ON_STARTUP = 'false';
  // Bust require cache so getDb() reopens against the new DB_PATH.
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}src${path.sep}`)) delete require.cache[k];
  }
  return tmp;
}

async function startApp(setupDb) {
  const { getDb } = require('../src/db/database');
  const { resolveUser, requireUser } = require('../src/middleware/userAuth');
  const userRoutes = require('../src/routes/users');
  const libraryRoutes = require('../src/routes/library');
  const progressRoutes = require('../src/routes/progress');

  const db = getDb();
  // Seed one manga + chapter so progress / home / stats have content to scope.
  db.exec(`
    INSERT INTO manga (id, folder_name, path, title, genres) VALUES (10, 'm', '/lib/m', 'Mystery One', '["Mystery"]');
    INSERT INTO chapters (id, manga_id, folder_name, path, type, number, page_count) VALUES (100, 10, 'c1', '/lib/m/c1', 'folder', 1, 10);
  `);
  setupDb(db);

  const app = express();
  app.use(express.json());
  app.use('/api', resolveUser, userRoutes);
  app.use('/api', resolveUser, requireUser, libraryRoutes);
  app.use('/api', resolveUser, requireUser, progressRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  return { db, srv, base: `http://127.0.0.1:${srv.address().port}` };
}

// One end-to-end exercise of the per-user data surface. Returns the responses
// that parity asserts equivalence on.
async function exercise(base, headers) {
  const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(b) });
  const put  = (p, b) => fetch(`${base}${p}`, { method: 'PUT',  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(b) });
  const get  = (p)    => fetch(`${base}${p}`, { headers }).then(r => r.json()).then(j => j.data);

  // Write progress (and have it become "continue reading").
  const r = await put('/api/progress/10', { chapterId: 100, page: 0, markChapterComplete: true });
  assert.equal(r.status, 200, 'progress write 200');
  // Create a custom reading list and add the manga.
  const listResp = await post('/api/reading-lists', { name: 'Horror' });
  assert.equal(listResp.status, 201, 'create list 201');
  const list = (await listResp.json()).data;
  await post(`/api/reading-lists/${list.id}/manga`, { manga_id: 10 });

  const progress = await get('/api/progress/10');
  const home     = await get('/api/home');
  const stats    = await get('/api/stats');
  const lists    = await get('/api/reading-lists');

  return { progress, home, stats, lists };
}

function compare(a, b) {
  // Compare on the user-visible shape — completed chapter, continue_reading
  // includes the manga, stats favorite_genres has Mystery, and the same lists
  // appear (Favorites + Want to Read seeded, plus Horror).
  assert.deepEqual(a.progress.completed_chapters, b.progress.completed_chapters, 'completed chapters equal');
  assert.equal(a.progress.current_page, b.progress.current_page, 'current page equal');
  assert.deepEqual(
    a.home.continue_reading.map(m => m.id).sort(),
    b.home.continue_reading.map(m => m.id).sort(),
    'continue_reading manga ids equal',
  );
  assert.deepEqual(
    a.stats.favorite_genres.map(g => g.genre).sort(),
    b.stats.favorite_genres.map(g => g.genre).sort(),
    'favorite genres equal',
  );
  assert.deepEqual(
    a.lists.map(l => l.name).sort(),
    b.lists.map(l => l.name).sort(),
    'reading-list names equal',
  );
}

async function main() {
  // ── Mode A: multi-user OFF, default user resolves implicitly. ──────────
  const tmpA = freshDb();
  const A = await startApp((db) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('multi_user_enabled', '0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  });
  const respA = await exercise(A.base, {}); // no X-User-Token; default user is implicit
  A.srv.close();
  A.db.close();
  fs.rmSync(tmpA, { recursive: true, force: true });

  // ── Mode B: multi-user ON, one account (adopts the default user). ──────
  const tmpB = freshDb();
  const B = await startApp(() => { /* multi-user defaults ON in Phase 5+ */ });
  const reg = await fetch(`${B.base}/api/users/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password123' }),
  }).then(r => r.json());
  const tok = reg.data.user_token;
  assert.equal(reg.data.user.id, 1, 'alice adopts the default user id=1');
  const respB = await exercise(B.base, { 'X-User-Token': tok });
  B.srv.close();
  B.db.close();
  fs.rmSync(tmpB, { recursive: true, force: true });

  // ── Assert equivalence. ────────────────────────────────────────────────
  compare(respA, respB);
  console.log('parity.test.js: Mode A (flag off) ≡ Mode B (flag on, one account)');
  console.log('parity.test.js: ALL PASSED');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
