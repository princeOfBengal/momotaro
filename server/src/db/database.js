const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
    db = new Database(config.DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');   // WAL + NORMAL is safe and faster than FULL
    db.pragma('cache_size = -32000');    // 32 MB page cache
    db.pragma('temp_store = MEMORY');    // temp tables in RAM
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      path         TEXT    NOT NULL UNIQUE,
      show_in_all  INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS manga (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id      INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
      folder_name     TEXT    NOT NULL,
      path            TEXT    NOT NULL UNIQUE,
      title           TEXT    NOT NULL,
      description     TEXT,
      cover_image     TEXT,
      status          TEXT,
      year            INTEGER,
      genres          TEXT    DEFAULT '[]',
      anilist_id      INTEGER,
      mal_id          INTEGER,
      score           REAL,
      metadata_source TEXT    DEFAULT 'none',
      track_volumes   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id     INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      folder_name  TEXT    NOT NULL,
      path         TEXT    NOT NULL,
      type         TEXT    NOT NULL,
      number       REAL,
      volume       REAL,
      title        TEXT,
      page_count   INTEGER NOT NULL DEFAULT 0,
      file_mtime   INTEGER,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(manga_id, folder_name)
    );

    CREATE TABLE IF NOT EXISTS pages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      page_index INTEGER NOT NULL,
      filename   TEXT    NOT NULL,
      path       TEXT    NOT NULL,
      width      INTEGER,
      height     INTEGER,
      UNIQUE(chapter_id, page_index)
    );

    CREATE TABLE IF NOT EXISTS progress (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id           INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE UNIQUE,
      current_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
      current_page       INTEGER NOT NULL DEFAULT 0,
      completed_chapters TEXT    NOT NULL DEFAULT '[]',
      last_read_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS device_anilist_sessions (
      device_id        TEXT PRIMARY KEY,
      anilist_token    TEXT NOT NULL DEFAULT '',
      anilist_user_id  TEXT NOT NULL DEFAULT '',
      anilist_username TEXT NOT NULL DEFAULT '',
      anilist_avatar   TEXT NOT NULL DEFAULT '',
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS reading_lists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS reading_list_manga (
      list_id    INTEGER NOT NULL REFERENCES reading_lists(id) ON DELETE CASCADE,
      manga_id   INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (list_id, manga_id)
    );

    CREATE INDEX IF NOT EXISTS idx_manga_library_id  ON manga(library_id);
    CREATE INDEX IF NOT EXISTS idx_manga_title        ON manga(title);
    CREATE INDEX IF NOT EXISTS idx_manga_updated_at   ON manga(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chapters_manga_id  ON chapters(manga_id);
    CREATE INDEX IF NOT EXISTS idx_pages_chapter_id   ON pages(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_progress_manga_id  ON progress(manga_id);
    CREATE INDEX IF NOT EXISTS idx_rlm_list_id        ON reading_list_manga(list_id);
    CREATE INDEX IF NOT EXISTS idx_rlm_manga_id       ON reading_list_manga(manga_id);
  `);

  // Seed the two built-in reading lists
  for (const name of ['Favorites', 'Want to Read']) {
    db.prepare("INSERT OR IGNORE INTO reading_lists (name, is_default) VALUES (?, 1)").run(name);
  }

  upgradeToMultiLibrary(db);

  // Column-level migrations — safe to run on every startup
  addColumnIfMissing(db, 'libraries', 'show_in_all', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'chapters',  'volume',      'REAL');
  addColumnIfMissing(db, 'chapters',  'file_mtime',  'INTEGER');
  addColumnIfMissing(db, 'manga',     'author',       'TEXT');
}

/**
 * Add a column to a table if it doesn't already exist.
 */
function addColumnIfMissing(db, table, column, definition) {
  const has = db.prepare(
    `SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`
  ).get(column);
  if (!has) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[DB] Added ${column} to ${table}.`);
  }
}

/**
 * One-time migration for installations that predate multi-library support.
 */
function upgradeToMultiLibrary(db) {
  const hasLibraryId = db.prepare(
    "SELECT 1 FROM pragma_table_info('manga') WHERE name = 'library_id'"
  ).get();
  if (hasLibraryId) return;

  const hasTrackVolumes = db.prepare(
    "SELECT 1 FROM pragma_table_info('manga') WHERE name = 'track_volumes'"
  ).get();
  const tvExpr = hasTrackVolumes ? 'COALESCE(m.track_volumes, 0)' : '0';

  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      path         TEXT    NOT NULL UNIQUE,
      show_in_all  INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  db.exec(`
    CREATE TABLE manga_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id      INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
      folder_name     TEXT    NOT NULL,
      path            TEXT    NOT NULL UNIQUE,
      title           TEXT    NOT NULL,
      description     TEXT,
      cover_image     TEXT,
      status          TEXT,
      year            INTEGER,
      genres          TEXT    DEFAULT '[]',
      anilist_id      INTEGER,
      mal_id          INTEGER,
      score           REAL,
      metadata_source TEXT    DEFAULT 'none',
      track_volumes   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  db.exec(`
    INSERT INTO manga_new
      (id, library_id, folder_name, path, title, description, cover_image,
       status, year, genres, anilist_id, mal_id, score, metadata_source,
       track_volumes, created_at, updated_at)
    SELECT
      id, NULL, folder_name, path, title, description, cover_image,
      status, year, COALESCE(genres, '[]'), anilist_id, mal_id, score,
      COALESCE(metadata_source, 'none'), ${tvExpr}, created_at, updated_at
    FROM manga m;

    DROP TABLE manga;
    ALTER TABLE manga_new RENAME TO manga;
    CREATE INDEX IF NOT EXISTS idx_manga_library_id ON manga(library_id);
  `);

  console.log('[DB] Migrated to multi-library schema.');
}

module.exports = { getDb };
