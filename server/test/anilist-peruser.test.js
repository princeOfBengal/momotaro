/**
 * Phase-3 per-user AniList test. Two accounts link (or don't link) their own
 * AniList; verifies:
 *   - a completed chapter syncs to the *owning* user's AniList token only,
 *   - an unlinked account triggers no sync,
 *   - /manga/:id/anilist-status is per-user (linked for one, logged-out for the
 *     other),
 *   - the user-list cache is keyed per user.
 *
 * The AniList HTTP layer (metadata/anilist) is mocked, so no network is hit.
 * Mocks are installed before requiring the routers, which destructure those
 * functions at load time.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):  node test/anilist-peruser.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-al-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

// --- Mock the AniList HTTP layer BEFORE the routers destructure it. ---
const anilist = require('../src/metadata/anilist');
const saveCalls = [];
anilist.saveMediaListEntry = async (token, mediaId, status, progressArg) => {
  saveCalls.push({ token, mediaId, status, progressArg });
  return {};
};
anilist.getMediaListEntry = async (token, anilistUserId, mediaId) => ({
  status: 'CURRENT', progress: 1, _token: token, _mediaId: mediaId,
});
anilist.getViewer = async () => ({ id: 0, name: 'unused' });

const { getDb } = require('../src/db/database');
const { resolveUser, requireUser } = require('../src/middleware/userAuth');
const userRoutes = require('../src/routes/users');
const progressRoutes = require('../src/routes/progress');
const metadataRoutes = require('../src/routes/metadata');

const db = getDb();
db.prepare("INSERT INTO settings (key, value) VALUES ('multi_user_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
db.exec(`
  INSERT INTO manga (id, folder_name, path, title, anilist_id) VALUES (10, 'm', '/lib/m', 'Linked Manga', 111);
  INSERT INTO chapters (id, manga_id, folder_name, path, type, number, page_count) VALUES (100, 10, 'c1', '/lib/m/c1', 'folder', 1, 10);
`);

function linkAniList(userId, token, alUserId, alName) {
  db.prepare(`
    INSERT INTO user_anilist_sessions (user_id, anilist_token, anilist_user_id, anilist_username, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET anilist_token=excluded.anilist_token, anilist_user_id=excluded.anilist_user_id, anilist_username=excluded.anilist_username
  `).run(userId, token, alUserId, alName);
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForCalls(n, timeoutMs = 1000) {
  const start = Date.now();
  while (saveCalls.length < n && Date.now() - start < timeoutMs) await wait(20);
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', resolveUser, userRoutes);
  app.use('/api', resolveUser, requireUser, progressRoutes);
  app.use('/api', resolveUser, metadataRoutes); // anilist-status tolerates no-user
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const reg = (u) => fetch(`${base}/api/users/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'password123' }),
  }).then(r => r.json()).then(j => j.data);
  const H = (t) => ({ 'X-User-Token': t });
  const markRead = (tok) => fetch(`${base}/api/progress/10`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...H(tok) },
    body: JSON.stringify({ chapterId: 100, page: 0, markChapterComplete: true }),
  });

  const alice = await reg('alice'); // adopts default user (id=1)
  const bob   = await reg('bob');   // fresh user (id=2)

  // Alice links her AniList; Bob stays unlinked.
  linkAniList(alice.user.id, 'ALICE_AL_TOKEN', '5001', 'aliceAL');

  // Alice completes the chapter → sync to ALICE's token only.
  let res = await markRead(alice.user_token);
  assert.equal(res.status, 200, 'alice progress 200');
  await waitForCalls(1);
  assert.equal(saveCalls.length, 1, 'exactly one AniList sync');
  assert.equal(saveCalls[0].token, 'ALICE_AL_TOKEN', 'synced with alice\'s token');
  assert.equal(saveCalls[0].mediaId, 111, 'synced the right AniList media id');

  // Bob (unlinked) completes the chapter → NO sync.
  res = await markRead(bob.user_token);
  assert.equal(res.status, 200, 'bob progress 200');
  await wait(150);
  assert.equal(saveCalls.length, 1, 'unlinked user triggered no AniList sync');

  // anilist-status is per-user.
  const statusA = await fetch(`${base}/api/manga/10/anilist-status`, { headers: H(alice.user_token) }).then(r => r.json());
  assert.equal(statusA.data.logged_in, true, 'alice logged in to AniList');
  assert.equal(statusA.data.linked, true, 'alice manga linked');
  assert.ok(statusA.data.entry, 'alice gets a list entry');

  const statusB = await fetch(`${base}/api/manga/10/anilist-status`, { headers: H(bob.user_token) }).then(r => r.json());
  assert.equal(statusB.data.logged_in, false, 'bob not logged in to AniList');

  // Cache is keyed per user — alice has a cached row, bob has none.
  const aliceCache = db.prepare('SELECT COUNT(*) n FROM anilist_media_list_cache WHERE user_id = ?').get(alice.user.id).n;
  const bobCache   = db.prepare('SELECT COUNT(*) n FROM anilist_media_list_cache WHERE user_id = ?').get(bob.user.id).n;
  assert.ok(aliceCache >= 1, 'alice list-entry cached');
  assert.equal(bobCache, 0, 'bob has no cached entry');

  srv.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('anilist-peruser.test.js: ALL PASSED');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
