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
    db.pragma('synchronous = NORMAL');       // WAL + NORMAL is safe and faster than FULL
    db.pragma('cache_size = -262144');       // 256 MB page cache — fits the hot working set at 8TB scale
    db.pragma('mmap_size = 1073741824');     // 1 GB memory-mapped I/O for read-heavy queries
    db.pragma('wal_autocheckpoint = 10000'); // Checkpoint every ~10k pages (~40 MB) instead of the 1k default
    db.pragma('temp_store = MEMORY');        // temp tables in RAM
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

    CREATE INDEX IF NOT EXISTS idx_manga_library_id       ON manga(library_id);
    CREATE INDEX IF NOT EXISTS idx_manga_title             ON manga(title);
    CREATE INDEX IF NOT EXISTS idx_manga_updated_at        ON manga(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_manga_lib_status        ON manga(library_id, status);
    CREATE INDEX IF NOT EXISTS idx_manga_lib_metadata_src  ON manga(library_id, metadata_source);
    CREATE INDEX IF NOT EXISTS idx_chapters_manga_id       ON chapters(manga_id);
    CREATE INDEX IF NOT EXISTS idx_pages_chapter_id        ON pages(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_progress_manga_id       ON progress(manga_id);
    CREATE INDEX IF NOT EXISTS idx_rlm_list_id             ON reading_list_manga(list_id);
    CREATE INDEX IF NOT EXISTS idx_rlm_manga_id            ON reading_list_manga(manga_id);

    CREATE TABLE IF NOT EXISTS thumbnail_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id   INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      filename   TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(manga_id, filename)
    );
    CREATE INDEX IF NOT EXISTS idx_thumb_history_manga_id ON thumbnail_history(manga_id);

    CREATE TABLE IF NOT EXISTS art_gallery (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id   INTEGER NOT NULL REFERENCES manga(id)    ON DELETE CASCADE,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      page_id    INTEGER NOT NULL REFERENCES pages(id)    ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(manga_id, page_id)
    );
    CREATE INDEX IF NOT EXISTS idx_art_gallery_manga_id ON art_gallery(manga_id);
  `);

  // Seed the two built-in reading lists
  for (const name of ['Favorites', 'Want to Read']) {
    db.prepare("INSERT OR IGNORE INTO reading_lists (name, is_default) VALUES (?, 1)").run(name);
  }

  upgradeToMultiLibrary(db);

  // Column-level migrations — safe to run on every startup
  addColumnIfMissing(db, 'libraries', 'show_in_all', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'libraries', 'last_scan_mtime_ms', 'REAL');
  addColumnIfMissing(db, 'chapters',  'volume',      'REAL');
  addColumnIfMissing(db, 'chapters',  'file_mtime',  'INTEGER');
  addColumnIfMissing(db, 'manga',     'author',         'TEXT');
  addColumnIfMissing(db, 'manga',     'doujinshi_id',   'TEXT');
  addColumnIfMissing(db, 'manga',     'anilist_cover',  'TEXT');
  addColumnIfMissing(db, 'manga',     'original_cover', 'TEXT');
  addColumnIfMissing(db, 'manga',     'mal_cover',      'TEXT');
  addColumnIfMissing(db, 'manga',     'last_metadata_fetch_attempt_at', 'INTEGER');

  // Cached disk-usage columns — populated during scan so that /api/stats and
  // /api/manga/:id/info don't need to re-walk the library each request.
  addColumnIfMissing(db, 'chapters',  'bytes_on_disk', 'INTEGER');
  addColumnIfMissing(db, 'chapters',  'file_count',    'INTEGER');
  addColumnIfMissing(db, 'manga',     'bytes_on_disk', 'INTEGER');
  addColumnIfMissing(db, 'manga',     'file_count',    'INTEGER');

  migrateSearchIndex(db);
}

/**
 * Replace the old full-scan search (LIKE %term% + json_each over genres) with
 * two indexed structures:
 *
 *   - manga_fts: FTS5 virtual table over (title, author). Default unicode61
 *     tokenizer — whole-word case-insensitive match, no prefix. A search for
 *     "Yona" finds "Yona of the Dawn"; a search for "Daw" does not.
 *
 *   - manga_genres: normalised (manga_id, genre COLLATE NOCASE) pairs with a
 *     composite PK. Multi-term comma search becomes one indexed lookup per
 *     term, exact-match only.
 *
 * Triggers keep both structures in lockstep with `manga.genres` and
 * `manga.title` / `manga.author`, so no write-path code needed to change —
 * every route that sets those columns fans out for free.
 */
function migrateSearchIndex(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS manga_fts USING fts5(
      title,
      author,
      content='manga',
      content_rowid='id',
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS manga_genres (
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      genre    TEXT    NOT NULL COLLATE NOCASE,
      PRIMARY KEY (manga_id, genre)
    );
    CREATE INDEX IF NOT EXISTS idx_manga_genres_genre ON manga_genres(genre COLLATE NOCASE);

    -- FTS5 sync (external-content pattern).
    CREATE TRIGGER IF NOT EXISTS manga_fts_ai AFTER INSERT ON manga BEGIN
      INSERT INTO manga_fts(rowid, title, author) VALUES (NEW.id, NEW.title, NEW.author);
    END;
    CREATE TRIGGER IF NOT EXISTS manga_fts_ad AFTER DELETE ON manga BEGIN
      INSERT INTO manga_fts(manga_fts, rowid, title, author)
        VALUES ('delete', OLD.id, OLD.title, OLD.author);
    END;
    CREATE TRIGGER IF NOT EXISTS manga_fts_au AFTER UPDATE OF title, author ON manga BEGIN
      INSERT INTO manga_fts(manga_fts, rowid, title, author)
        VALUES ('delete', OLD.id, OLD.title, OLD.author);
      INSERT INTO manga_fts(rowid, title, author) VALUES (NEW.id, NEW.title, NEW.author);
    END;

    -- manga_genres sync. On INSERT/UPDATE, wipe then re-insert from the JSON
    -- blob — genres are short lists, so the delete+insert cost is trivial
    -- compared to maintaining a diff. json_each errors on invalid JSON, so
    -- fall back to '[]' via a CASE.
    CREATE TRIGGER IF NOT EXISTS manga_genres_ai AFTER INSERT ON manga BEGIN
      INSERT OR IGNORE INTO manga_genres (manga_id, genre)
        SELECT NEW.id, value FROM json_each(
          CASE WHEN json_valid(NEW.genres) THEN NEW.genres ELSE '[]' END
        );
    END;
    CREATE TRIGGER IF NOT EXISTS manga_genres_au AFTER UPDATE OF genres ON manga BEGIN
      DELETE FROM manga_genres WHERE manga_id = NEW.id;
      INSERT OR IGNORE INTO manga_genres (manga_id, genre)
        SELECT NEW.id, value FROM json_each(
          CASE WHEN json_valid(NEW.genres) THEN NEW.genres ELSE '[]' END
        );
    END;
    -- DELETE handled by ON DELETE CASCADE on the FK.
  `);

  // One-time backfill: if the FTS table is empty but manga rows exist, seed
  // it. Same for manga_genres. Both are idempotent (INSERT OR IGNORE), so a
  // second run after a partial migration is safe.
  const ftsEmpty = db.prepare('SELECT 1 FROM manga_fts LIMIT 1').get() === undefined;
  const mangaCount = db.prepare('SELECT COUNT(*) AS n FROM manga').get().n;
  if (ftsEmpty && mangaCount > 0) {
    db.exec(`INSERT INTO manga_fts(rowid, title, author) SELECT id, title, author FROM manga;`);
    console.log(`[DB] Backfilled manga_fts with ${mangaCount} rows.`);
  }

  const genresEmpty = db.prepare('SELECT 1 FROM manga_genres LIMIT 1').get() === undefined;
  if (genresEmpty && mangaCount > 0) {
    const { changes } = db.prepare(`
      INSERT OR IGNORE INTO manga_genres (manga_id, genre)
        SELECT m.id, j.value
        FROM manga m,
             json_each(CASE WHEN json_valid(m.genres) THEN m.genres ELSE '[]' END) j
        WHERE m.genres IS NOT NULL
    `).run();
    console.log(`[DB] Backfilled manga_genres with ${changes} rows.`);
  }
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
