/**
 * Phase-1 user-accounts migration test. Builds a realistic *pre-accounts*
 * (legacy) database, then loads the real db/database.js so its migrate() runs,
 * and asserts the legacy reading data is correctly carried onto the default
 * user with the new per-user schema — and that a second open is a no-op.
 *
 * Runs without a test runner — plain node assertions, exits non-zero on
 * failure. Requires a working better-sqlite3 binding (run in the server's
 * normal runtime / Docker, same as the app):
 *
 *   node test/migration.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-migtest-'));
const dbPath = path.join(tmp, 'legacy.db');

function buildLegacyDb(p) {
  const L = new Database(p);
  L.pragma('foreign_keys = ON');
  // A faithful slice of the pre-user-accounts schema: shared catalogue tables
  // in their current shape, plus the LEGACY forms of the tables this migration
  // rewrites (global progress / reading_lists, device-keyed AniList).
  L.exec(`
    CREATE TABLE libraries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, show_in_all INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE manga (
      id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
      folder_name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
      cover_image TEXT, status TEXT, year INTEGER, genres TEXT DEFAULT '[]', anilist_id INTEGER, mal_id INTEGER,
      score REAL, metadata_source TEXT DEFAULT 'none', track_volumes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE, folder_name TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, number REAL, volume REAL, title TEXT, page_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(manga_id, folder_name));
    CREATE TABLE pages (id INTEGER PRIMARY KEY AUTOINCREMENT, chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE, page_index INTEGER NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL, width INTEGER, height INTEGER, UNIQUE(chapter_id, page_index));

    CREATE TABLE progress (id INTEGER PRIMARY KEY AUTOINCREMENT, manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE UNIQUE, current_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL, current_page INTEGER NOT NULL DEFAULT 0, completed_chapters TEXT NOT NULL DEFAULT '[]', last_read_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE reading_list_manga (list_id INTEGER NOT NULL REFERENCES reading_lists(id) ON DELETE CASCADE, manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE, added_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (list_id, manga_id));
    CREATE TABLE device_anilist_sessions (device_id TEXT PRIMARY KEY, anilist_token TEXT NOT NULL DEFAULT '', anilist_user_id TEXT NOT NULL DEFAULT '', anilist_username TEXT NOT NULL DEFAULT '', anilist_avatar TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE anilist_media_list_cache (device_id TEXT NOT NULL, media_id INTEGER NOT NULL, entry_json TEXT, fetched_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (device_id, media_id));

    INSERT INTO manga (id, folder_name, path, title, genres) VALUES
      (10, 'a', '/lib/a', 'Alpha', '["Mystery"]'),
      (11, 'b', '/lib/b', 'Beta',  '["Romance"]');
    INSERT INTO chapters (id, manga_id, folder_name, path, type) VALUES (100, 10, 'c1', '/lib/a/c1', 'folder');
    INSERT INTO progress (manga_id, current_chapter_id, current_page, completed_chapters) VALUES (10, 100, 3, '[100]');
    INSERT INTO reading_lists (id, name, is_default) VALUES (1, 'Favorites', 1), (2, 'Want to Read', 1), (3, 'Horror', 0);
    INSERT INTO reading_list_manga (list_id, manga_id) VALUES (3, 10), (1, 11);
    INSERT INTO device_anilist_sessions (device_id, anilist_token, anilist_user_id, anilist_username, updated_at) VALUES
      ('devA', 'tokOLD', '55', 'olduser', 100), ('devB', 'tokNEW', '66', 'newuser', 200);
    INSERT INTO anilist_media_list_cache (device_id, media_id, entry_json) VALUES ('devA', 999, '{}'), ('devB', 999, '{}');
  `);
  L.close();
}

buildLegacyDb(dbPath);

// Point the app's DB layer at the legacy file and run migrate() via getDb().
process.env.DB_PATH = dbPath;
process.env.SCAN_ON_STARTUP = 'false';
const { getDb, DEFAULT_USER_ID } = require('../src/db/database');
const db = getDb();

function hasCol(table, col) {
  return !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col);
}

// Default user exists and owns the migrated data.
assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(DEFAULT_USER_ID), 'default user created');

// progress is per-user, attributed to the default user, values preserved.
assert.ok(hasCol('progress', 'user_id'), 'progress.user_id added');
const prog = db.prepare('SELECT * FROM progress WHERE manga_id = 10').get();
assert.equal(prog.user_id, DEFAULT_USER_ID, 'progress attributed to default user');
assert.equal(prog.current_page, 3, 'progress page preserved');
assert.deepEqual(JSON.parse(prog.completed_chapters), [100], 'completed chapters preserved');

// reading_lists per-user, ids preserved, memberships intact.
assert.ok(hasCol('reading_lists', 'user_id'), 'reading_lists.user_id added');
const lists = db.prepare('SELECT * FROM reading_lists ORDER BY id').all();
assert.equal(lists.length, 3, 'three lists carried over');
assert.ok(lists.every(l => l.user_id === DEFAULT_USER_ID), 'lists owned by default user');
assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_list_manga').get().n, 2, 'memberships preserved');
assert.ok(db.prepare("SELECT 1 FROM reading_lists WHERE user_id = ? AND name = 'Favorites'").get(DEFAULT_USER_ID), 'Favorites present');
assert.ok(db.prepare("SELECT 1 FROM reading_lists WHERE user_id = ? AND name = 'Want to Read'").get(DEFAULT_USER_ID), 'Want to Read present');

// AniList cache re-keyed to (user_id, media_id), deduped.
assert.ok(hasCol('anilist_media_list_cache', 'user_id'), 'anilist cache re-keyed');
assert.ok(!hasCol('anilist_media_list_cache', 'device_id'), 'anilist cache device_id removed');
assert.equal(db.prepare('SELECT COUNT(*) n FROM anilist_media_list_cache').get().n, 1, 'cache deduped to one row');

// AniList session backfilled from the most-recently-updated device session.
const ses = db.prepare('SELECT * FROM user_anilist_sessions WHERE user_id = ?').get(DEFAULT_USER_ID);
assert.ok(ses, 'user anilist session backfilled');
assert.equal(ses.anilist_username, 'newuser', 'newest device session chosen');

// New tables + columns exist.
for (const t of ['user_sessions', 'login_lockouts', 'reading_history', 'user_anilist_sessions']) {
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t), `${t} created`);
}
assert.ok(hasCol('connection_attempts', 'username'), 'connection_attempts.username added');

// No FK violations introduced.
assert.equal(db.pragma('foreign_key_check').length, 0, 'no FK violations');

console.log('migration.test.js: legacy migration assertions passed');

// Idempotency: closing and re-opening must not change anything.
db.close();
delete require.cache[require.resolve('../src/db/database')];
const { getDb: getDb2 } = require('../src/db/database');
const db2 = getDb2();
assert.equal(db2.prepare('SELECT COUNT(*) n FROM reading_lists').get().n, 3, 'idempotent: still three lists');
assert.equal(db2.prepare('SELECT user_id FROM progress WHERE manga_id = 10').get().user_id, DEFAULT_USER_ID, 'idempotent: progress unchanged');
assert.equal(db2.prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'idempotent: still one user');
db2.close();

console.log('migration.test.js: idempotent restart assertions passed');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('migration.test.js: ALL PASSED');
process.exit(0);
