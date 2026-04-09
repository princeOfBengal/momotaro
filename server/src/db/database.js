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
      title        TEXT,
      page_count   INTEGER NOT NULL DEFAULT 0,
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

    CREATE INDEX IF NOT EXISTS idx_chapters_manga_id    ON chapters(manga_id);
    CREATE INDEX IF NOT EXISTS idx_pages_chapter_id     ON pages(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_progress_manga_id    ON progress(manga_id);
    CREATE INDEX IF NOT EXISTS idx_rlm_list_id          ON reading_list_manga(list_id);
    CREATE INDEX IF NOT EXISTS idx_rlm_manga_id         ON reading_list_manga(manga_id);
  `);

  // Seed the two built-in reading lists
  for (const name of ['Favorites', 'Want to Read']) {
    db.prepare("INSERT OR IGNORE INTO reading_lists (name, is_default) VALUES (?, 1)").run(name);
  }

  // Upgrade older single-library databases to multi-library schema.
  // Must run before we try to reference the library_id column.
  upgradeToMultiLibrary(db);

  // Safe to create now — library_id is guaranteed to exist after the migration
  db.exec(`CREATE INDEX IF NOT EXISTS idx_manga_library_id ON manga(library_id)`);

  // Add show_in_all to libraries if not present (older installations)
  upgradeLibraryShowInAll(db);
}

/**
 * One-time migration for installations that predate multi-library support.
 * The old schema had `folder_name TEXT UNIQUE` without a library_id column.
 * We recreate the manga table to add library_id and change the unique
 * constraint to UNIQUE(path) (paths are globally unique on the filesystem).
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

  // Create libraries table if somehow not yet created
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      path         TEXT    NOT NULL UNIQUE,
      show_in_all  INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Recreate manga with new schema (library_id, UNIQUE path)
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

function upgradeLibraryShowInAll(db) {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('libraries') WHERE name = 'show_in_all'").get();
  if (has) return;
  db.exec("ALTER TABLE libraries ADD COLUMN show_in_all INTEGER NOT NULL DEFAULT 1");
  console.log('[DB] Added show_in_all column to libraries.');
}

module.exports = { getDb };
