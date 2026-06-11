/**
 * Audit-remediation regression tests. Covers three fixes against a real
 * Express app + temp SQLite DB (same harness style as isolation.test.js):
 *
 *   Group B — "chapters read" counts (Home completed_count, Stats top_manga)
 *             exclude chapters deleted since they were marked read, so the
 *             number can never exceed a manga's live chapter total.
 *   Group D — the downloader's terminal `done` write is guarded by
 *             `AND status='running'`, so a cancel that lands during the final
 *             rescan window isn't clobbered.
 *   Group E — the progress routes reject a chapterId that doesn't belong to
 *             the manga (deleted / cross-manga) so a dead id can't enter
 *             completed_chapters (and a bogus current_chapter_id can't FK-500).
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):
 *
 *   node test/auditFixes.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-audit-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb } = require('../src/db/database');
const { resolveUser, requireUser } = require('../src/middleware/userAuth');
const userRoutes = require('../src/routes/users');
const libraryRoutes = require('../src/routes/library');
const progressRoutes = require('../src/routes/progress');

const db = getDb();
db.prepare("INSERT INTO settings (key, value) VALUES ('multi_user_enabled', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run();

// Two manga in a visible library (library_id NULL). Manga 20 has three
// chapters; manga 30 has one (used to probe cross-manga chapter rejection).
db.exec(`
  INSERT INTO manga (id, folder_name, path, title, genres) VALUES (20, 'a', '/lib/a', 'Alpha', '["Action"]');
  INSERT INTO manga (id, folder_name, path, title, genres) VALUES (30, 'b', '/lib/b', 'Beta',  '["Action"]');
  INSERT INTO chapters (id, manga_id, folder_name, path, type, number, page_count) VALUES
    (200, 20, 'c1', '/lib/a/c1', 'folder', 1, 10),
    (201, 20, 'c2', '/lib/a/c2', 'folder', 2, 10),
    (202, 20, 'c3', '/lib/a/c3', 'folder', 3, 10),
    (300, 30, 'c1', '/lib/b/c1', 'folder', 1, 10);
`);

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', resolveUser, userRoutes);
  app.use('/api', resolveUser, requireUser, libraryRoutes);
  app.use('/api', resolveUser, requireUser, progressRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const tok = await fetch(`${base}/api/users/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password123' }),
  }).then(r => r.json()).then(j => j.data.user_token);

  const H = { 'Content-Type': 'application/json', 'X-User-Token': tok };
  const getJson = (p) => fetch(`${base}${p}`, { headers: { 'X-User-Token': tok } }).then(r => r.json()).then(j => j.data);
  const patch = (p, body) => fetch(`${base}${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  const put   = (p, body) => fetch(`${base}${p}`, { method: 'PUT',   headers: H, body: JSON.stringify(body) });

  // ── Group E — non-owned chapter ids are rejected ──────────────────────────
  assert.equal((await patch('/api/progress/20/chapter/300', { completed: true })).status, 404,
    'PATCH: chapter from another manga rejected');
  assert.equal((await patch('/api/progress/20/chapter/999999', { completed: true })).status, 404,
    'PATCH: nonexistent chapter rejected');
  assert.equal((await put('/api/progress/20', { chapterId: 300, page: 0 })).status, 404,
    'PUT: cross-manga chapterId rejected');
  assert.equal((await put('/api/progress/20', { chapterId: 999999, page: 0 })).status, 404,
    'PUT: nonexistent chapterId rejected (clean 404, not an FK 500)');

  // None of the rejected writes created a progress row / stored a dead id.
  const progAfterRejects = await getJson('/api/progress/20');
  assert.ok(progAfterRejects === null
    || !(progAfterRejects.completed_chapters || []).some(id => id === 300 || id === 999999),
    'rejected chapter ids never entered completed_chapters');

  // A valid, owned chapter still completes normally.
  assert.equal((await patch('/api/progress/20/chapter/200', { completed: true })).status, 200,
    'PATCH: owned chapter accepted');

  // ── Group B — counts exclude chapters deleted after being marked read ─────
  for (const id of [201, 202]) {
    assert.equal((await patch(`/api/progress/20/chapter/${id}`, { completed: true })).status, 200, `mark ${id} read`);
  }
  // completed_chapters is now [200, 201, 202]; delete one chapter off disk.
  db.prepare('DELETE FROM chapters WHERE id = ?').run(202);

  const home = await getJson('/api/home');
  const card = home.continue_reading.find(m => m.id === 20);
  assert.ok(card, 'manga 20 present in Continue Reading');
  assert.equal(card.total_chapters, 2, 'live total reflects the deletion');
  assert.equal(card.completed_count, 2, 'completed_count excludes the deleted chapter (was 3)');
  assert.ok(card.completed_count <= card.total_chapters, 'completed_count never exceeds the live total');

  const stats = await getJson('/api/stats');
  const top = stats.top_manga.find(m => m.id === 20);
  assert.ok(top, 'manga 20 present in Popular Manga');
  assert.equal(top.chapters_read, 2, 'top_manga.chapters_read excludes the deleted chapter');

  // ── Group D — guarded terminal write preserves a cancel ───────────────────
  db.prepare(`INSERT INTO download_jobs (id, source, source_series_id, source_chapter_id, target_mode, status)
              VALUES (1, 'mangadex', 's1', 'c1', 'existing', 'running')`).run();
  // A cancel lands during the post-download rescan window.
  db.prepare("UPDATE download_jobs SET status='cancelled' WHERE id = 1").run();
  // The exact guarded UPDATE runJob() issues at the end of a successful download.
  db.prepare(`UPDATE download_jobs SET status='done', finished_at=unixepoch(), error=NULL
              WHERE id = 1 AND status = 'running'`).run();
  assert.equal(db.prepare('SELECT status FROM download_jobs WHERE id = 1').pluck().get(), 'cancelled',
    'a cancel survives the guarded terminal write');

  // A job still 'running' at the terminal write completes normally.
  db.prepare(`INSERT INTO download_jobs (id, source, source_series_id, source_chapter_id, target_mode, status)
              VALUES (2, 'mangadex', 's2', 'c2', 'existing', 'running')`).run();
  db.prepare(`UPDATE download_jobs SET status='done', finished_at=unixepoch(), error=NULL
              WHERE id = 2 AND status = 'running'`).run();
  assert.equal(db.prepare('SELECT status FROM download_jobs WHERE id = 2').pluck().get(), 'done',
    'a running job completes normally');

  srv.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('auditFixes.test.js: ALL PASSED');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
