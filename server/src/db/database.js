const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { hashPassword } = require('../auth/crypto');

// Owner of all reading data on a single-user / pre-accounts install. The
// user-accounts migration attributes every legacy progress row, reading list,
// and AniList session to this id; the first real account adopts this row.
const DEFAULT_USER_ID = 1;

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

    // Ask SQLite to hand idle page-cache pages back to the OS every few
    // minutes. No-op when the cache is hot — only reclaims what SQLite
    // isn't using. Cheap; .unref() so the timer never blocks shutdown.
    setInterval(() => {
      try { db.pragma('shrink_memory'); } catch (_) { /* best-effort */ }
    }, 5 * 60 * 1000).unref();
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

    -- device_anilist_sessions (pre-accounts per-device AniList store) is no
    -- longer created here; it was replaced by user_anilist_sessions in Phase 3.
    -- See backfillUserAniListSession + dropLegacyDeviceAniListTable below.

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
    -- Back the keyset cursors for sort=year / sort=rating in GET /api/library.
    -- Column order + direction mirror the ORDER BY (year DESC NULLS LAST, id ASC;
    -- score DESC NULLS LAST, title ASC, id ASC) so the planner can satisfy both
    -- the ORDER BY and the keyset range without a temp b-tree even at 10k+ rows.
    CREATE INDEX IF NOT EXISTS idx_manga_year              ON manga(year DESC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_manga_score             ON manga(score DESC, title ASC, id ASC);
    -- Back the Home "Recently Added" ribbon (ORDER BY created_at DESC, id DESC)
    -- and its optional recent-window filter (created_at >= cutoff). Column order
    -- + direction mirror the ORDER BY so the planner skips the temp b-tree even
    -- at 10k+ rows; without it every /api/home cache miss full-sorts the table.
    CREATE INDEX IF NOT EXISTS idx_manga_created_at         ON manga(created_at DESC, id DESC);
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

    -- Per-device cache of the user's AniList list entry for a given media id.
    -- entry_json is the serialised MediaList payload, or NULL meaning "the
    -- AniList API confirmed the user does not have this manga on their list"
    -- (a real, cacheable answer that we shouldn't keep re-fetching).
    CREATE TABLE IF NOT EXISTS anilist_media_list_cache (
      device_id  TEXT    NOT NULL,
      media_id   INTEGER NOT NULL,
      entry_json TEXT,
      fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (device_id, media_id)
    );
  `);

  // Built-in reading lists are now seeded per-user (see seedDefaultLists),
  // called from the user-accounts migration block below for the default user
  // and at account creation for every new user.

  upgradeToMultiLibrary(db);

  // Column-level migrations — safe to run on every startup
  addColumnIfMissing(db, 'libraries', 'show_in_all', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'libraries', 'last_scan_mtime_ms', 'REAL');
  addColumnIfMissing(db, 'chapters',  'volume',      'REAL');
  addColumnIfMissing(db, 'chapters',  'number_end',  'REAL');
  addColumnIfMissing(db, 'chapters',  'volume_end',  'REAL');
  addColumnIfMissing(db, 'chapters',  'file_mtime',  'INTEGER');
  addColumnIfMissing(db, 'manga',     'author',            'TEXT');
  addColumnIfMissing(db, 'manga',     'doujinshi_id',      'TEXT');
  addColumnIfMissing(db, 'manga',     'mangaupdates_id',   'INTEGER');
  addColumnIfMissing(db, 'manga',     'mangadex_id',       'TEXT');
  addColumnIfMissing(db, 'manga',     'comixto_id',        'TEXT');
  addColumnIfMissing(db, 'manga',     'mangakakalot_id',   'TEXT');
  addColumnIfMissing(db, 'manga',     'mangafire_id',      'TEXT');
  addColumnIfMissing(db, 'manga',     'weebcentral_id',    'TEXT');
  addColumnIfMissing(db, 'manga',     'mangaball_id',      'TEXT');
  addColumnIfMissing(db, 'manga',     'mangataro_id',      'TEXT');
  addColumnIfMissing(db, 'manga',     'mangadotnet_id',    'TEXT');
  addColumnIfMissing(db, 'manga',     'comikuro_id',       'TEXT');
  addColumnIfMissing(db, 'manga',     'natomanga_id',      'TEXT');
  addColumnIfMissing(db, 'manga',     'anilist_cover',     'TEXT');
  addColumnIfMissing(db, 'manga',     'original_cover',    'TEXT');
  addColumnIfMissing(db, 'manga',     'mal_cover',         'TEXT');
  addColumnIfMissing(db, 'manga',     'mangaupdates_cover','TEXT');
  addColumnIfMissing(db, 'manga',     'doujinshi_cover',   'TEXT');
  // 1 when the user manually picked a cover via the Thumbnail Picker; the
  // priority-driven Reset Thumbnails op leaves these manga alone unless the
  // operator runs the explicit reset (which clears the flag back to 0).
  addColumnIfMissing(db, 'manga',     'cover_user_set',    'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'manga',     'last_metadata_fetch_attempt_at', 'INTEGER');

  // Cached disk-usage columns — populated during scan so that /api/stats and
  // /api/manga/:id/info don't need to re-walk the library each request.
  addColumnIfMissing(db, 'chapters',  'bytes_on_disk', 'INTEGER');
  addColumnIfMissing(db, 'chapters',  'file_count',    'INTEGER');
  addColumnIfMissing(db, 'manga',     'bytes_on_disk', 'INTEGER');
  addColumnIfMissing(db, 'manga',     'file_count',    'INTEGER');

  migrateSearchIndex(db);
  backfillDoujinshiCover(db);
  createDownloadJobsTable(db);
  createMangaSourceUrlsTable(db);
  createMangaSchedulesTable(db);
  createAuthTables(db);
  createAdminTasksTable(db);

  // ── User accounts (Phase 1): schema + default-user attribution ──────────────
  // Order matters: the user tables and the default user must exist before the
  // per-user table rebuilds can FK-reference them. Each step is guarded and
  // idempotent, so re-running on an already-migrated DB is a no-op.
  createUserTables(db);
  ensureDefaultUser(db);
  migrateProgressToPerUser(db);
  migrateReadingListsToPerUser(db);
  seedDefaultLists(db, DEFAULT_USER_ID);
  rekeyAniListMediaCache(db);
  backfillUserAniListSession(db);
  dropLegacyDeviceAniListTable(db);
  addColumnIfMissing(db, 'connection_attempts', 'username', 'TEXT');
}

/**
 * Drop the pre-accounts `device_anilist_sessions` table now that
 * `backfillUserAniListSession` has carried its most-recent row onto the
 * default user. Idempotent (no-op on fresh installs / second boots).
 */
function dropLegacyDeviceAniListTable(db) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_anilist_sessions'"
  ).get();
  if (!exists) return;
  db.exec('DROP TABLE device_anilist_sessions');
  console.log('[DB] Dropped legacy device_anilist_sessions table (replaced by user_anilist_sessions in Phase 3).');
}

/**
 * User-account tables. `users` is the identity; `user_sessions` are persistent
 * bearer sessions (SHA-256 token hashes, like paired_clients); `login_lockouts`
 * mirrors pin_lockouts but keyed per device; `reading_history` is the append-only
 * per-user timeline; `user_anilist_sessions` re-homes AniList logins from device
 * to Momotaro user (one row per linked user → many AniList accounts coexist).
 */
function createUserTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      display_name   TEXT    NOT NULL DEFAULT '',
      password_hash  TEXT    NOT NULL,
      is_admin       INTEGER NOT NULL DEFAULT 0,
      disabled       INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash        TEXT    NOT NULL UNIQUE,
      paired_client_id  INTEGER REFERENCES paired_clients(id) ON DELETE SET NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at      INTEGER,
      last_seen_ip      TEXT,
      revoked           INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id    ON user_sessions(user_id);

    CREATE TABLE IF NOT EXISTS login_lockouts (
      lockout_key      TEXT    PRIMARY KEY,
      failed_attempts  INTEGER NOT NULL DEFAULT 0,
      locked_until     INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS reading_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
      manga_id    INTEGER NOT NULL REFERENCES manga(id)    ON DELETE CASCADE,
      chapter_id  INTEGER          REFERENCES chapters(id) ON DELETE SET NULL,
      event       TEXT    NOT NULL DEFAULT 'read',
      read_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_reading_history_user_time ON reading_history(user_id, read_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reading_history_manga     ON reading_history(manga_id);

    CREATE TABLE IF NOT EXISTS user_anilist_sessions (
      user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      anilist_token    TEXT    NOT NULL DEFAULT '',
      anilist_user_id  TEXT    NOT NULL DEFAULT '',
      anilist_username TEXT    NOT NULL DEFAULT '',
      anilist_avatar   TEXT    NOT NULL DEFAULT '',
      token_expires_at INTEGER,
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Per-user, server-synced preferences. Key/value blob keyed by user_id so
    -- a single account converges on one configuration across every device.
    -- The value column is JSON-encoded text so booleans, numbers, and arrays
    -- survive a round trip. Powers Homepage Settings (default sort, discover
    -- filters, ribbon layout); see docs/design/homepage-settings-expansion.md.
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, key)
    ) WITHOUT ROWID;
  `);
}

/**
 * Create the default data-owner user (id=1) if absent. Its password is random
 * and unusable — it is a placeholder that owns all pre-accounts reading data
 * until the first real account adopts it (Phase 2). is_admin=1 so the
 * single-user default install retains full capability.
 */
function ensureDefaultUser(db) {
  const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(DEFAULT_USER_ID);
  if (exists) return;
  const unusable = hashPassword(crypto.randomBytes(32).toString('hex'));
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, is_admin)
    VALUES (?, 'default', 'Default', ?, 1)
  `).run(DEFAULT_USER_ID, unusable);
  console.log('[DB] Created default user (id=1) to own pre-accounts reading data.');
}

/**
 * Seed the two built-in reading lists for a user. Idempotent via the
 * (user_id, name) unique constraint. Used by the migration for the default
 * user and (Phase 2) at account creation for every new user.
 */
function seedDefaultLists(db, userId) {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO reading_lists (user_id, name, is_default) VALUES (?, ?, 1)'
  );
  for (const name of ['Favorites', 'Want to Read']) ins.run(userId, name);
}

/**
 * Rebuild `progress` with a `user_id` column and `UNIQUE(user_id, manga_id)`,
 * attributing every existing row to the default user. SQLite can't ALTER a
 * UNIQUE constraint, so this uses the table-rebuild pattern. Foreign keys are
 * disabled around the rebuild per the SQLite-recommended procedure; `progress`
 * is not referenced by any other table, so the DROP cascades nothing. Guarded
 * on the presence of the `user_id` column, so it runs exactly once.
 */
function migrateProgressToPerUser(db) {
  const hasUserId = db.prepare(
    "SELECT 1 FROM pragma_table_info('progress') WHERE name = 'user_id'"
  ).get();
  if (hasUserId) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE progress_new (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id            INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
          manga_id           INTEGER NOT NULL REFERENCES manga(id)  ON DELETE CASCADE,
          current_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
          current_page       INTEGER NOT NULL DEFAULT 0,
          completed_chapters TEXT    NOT NULL DEFAULT '[]',
          last_read_at       INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, manga_id)
        );
        INSERT INTO progress_new
          (id, user_id, manga_id, current_chapter_id, current_page,
           completed_chapters, last_read_at, updated_at)
          SELECT id, ${DEFAULT_USER_ID}, manga_id, current_chapter_id, current_page,
                 completed_chapters, last_read_at, updated_at
          FROM progress;
        DROP TABLE progress;
        ALTER TABLE progress_new RENAME TO progress;
        CREATE INDEX IF NOT EXISTS idx_progress_manga_id   ON progress(manga_id);
        CREATE INDEX IF NOT EXISTS idx_progress_user_manga ON progress(user_id, manga_id);
      `);
    })();
    const violations = db.pragma('foreign_key_check');
    if (violations.length) console.warn('[DB] progress migration FK violations:', violations);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  console.log('[DB] Migrated progress to per-user (UNIQUE(user_id, manga_id)).');
}

/**
 * Rebuild `reading_lists` with a `user_id` column and `UNIQUE(user_id, name)`,
 * attributing existing lists to the default user. Row `id`s are preserved so
 * `reading_list_manga.list_id` references stay valid. Foreign keys MUST be off
 * during the rebuild: `reading_list_manga` references `reading_lists` with
 * ON DELETE CASCADE, so a DROP with FKs enabled would wipe every membership.
 */
function migrateReadingListsToPerUser(db) {
  const hasUserId = db.prepare(
    "SELECT 1 FROM pragma_table_info('reading_lists') WHERE name = 'user_id'"
  ).get();
  if (hasUserId) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE reading_lists_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(user_id, name)
        );
        INSERT INTO reading_lists_new (id, user_id, name, is_default, created_at)
          SELECT id, ${DEFAULT_USER_ID}, name, is_default, created_at FROM reading_lists;
        DROP TABLE reading_lists;
        ALTER TABLE reading_lists_new RENAME TO reading_lists;
      `);
    })();
    const violations = db.pragma('foreign_key_check');
    if (violations.length) console.warn('[DB] reading_lists migration FK violations:', violations);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  console.log('[DB] Migrated reading_lists to per-user (UNIQUE(user_id, name)).');
}

/**
 * Re-key `anilist_media_list_cache` from (device_id, media_id) to
 * (user_id, media_id). This is a cache, so legacy rows are folded onto the
 * default user (INSERT OR IGNORE dedupes when several devices cached the same
 * media). Guarded on the presence of the old `device_id` column.
 */
function rekeyAniListMediaCache(db) {
  const hasDeviceId = db.prepare(
    "SELECT 1 FROM pragma_table_info('anilist_media_list_cache') WHERE name = 'device_id'"
  ).get();
  if (!hasDeviceId) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE anilist_media_list_cache_new (
          user_id    INTEGER NOT NULL,
          media_id   INTEGER NOT NULL,
          entry_json TEXT,
          fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (user_id, media_id)
        );
        INSERT OR IGNORE INTO anilist_media_list_cache_new (user_id, media_id, entry_json, fetched_at)
          SELECT ${DEFAULT_USER_ID}, media_id, entry_json, fetched_at FROM anilist_media_list_cache;
        DROP TABLE anilist_media_list_cache;
        ALTER TABLE anilist_media_list_cache_new RENAME TO anilist_media_list_cache;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  console.log('[DB] Re-keyed anilist_media_list_cache to (user_id, media_id).');
}

/**
 * Carry the existing AniList login forward: copy the most-recently-updated
 * `device_anilist_sessions` row (if any) onto the default user, so a
 * single-user install keeps its AniList sync after the upgrade. No-op if the
 * default user already has a session or no device session has a token.
 */
function backfillUserAniListSession(db) {
  const already = db.prepare('SELECT 1 FROM user_anilist_sessions WHERE user_id = ?').get(DEFAULT_USER_ID);
  if (already) return;
  // Fresh installs never had `device_anilist_sessions`; legacy installs have
  // it until `dropLegacyDeviceAniListTable` runs. Tolerate either.
  const legacyExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_anilist_sessions'"
  ).get();
  if (!legacyExists) return;
  const row = db.prepare(`
    SELECT anilist_token, anilist_user_id, anilist_username, anilist_avatar
    FROM device_anilist_sessions
    WHERE anilist_token != ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
  if (!row) return;
  db.prepare(`
    INSERT INTO user_anilist_sessions
      (user_id, anilist_token, anilist_user_id, anilist_username, anilist_avatar, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `).run(
    DEFAULT_USER_ID,
    row.anilist_token, row.anilist_user_id || '', row.anilist_username || '', row.anilist_avatar || '',
  );
  console.log('[DB] Backfilled default user AniList session from legacy device session.');
}

/**
 * Durable state for long-running admin actions (VACUUM, cache wipe, manga
 * optimize, thumbnail regeneration). One row per task kind — kind is the
 * primary key, so re-running an op overwrites the previous result. State
 * lives here only for the kinds the in-process registry opts into
 * persisting (see [server/src/admin/taskRegistry.js]); short, cheap ops
 * keep their state in memory only.
 *
 * On startup `taskRegistry.init()` flips any row still marked 'running' to
 * 'interrupted' with a synthetic error, so a user who restarts the server
 * mid-VACUUM doesn't see a ghost "Running…" indicator forever.
 *
 * status values:
 *   'running'      — task started; runner has not yet resolved/rejected
 *   'done'         — runner resolved; result_json holds its return value
 *   'failed'       — runner rejected; error holds the message
 *   'interrupted'  — process died while the task was running (set at boot)
 */
function createAdminTasksTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_tasks (
      kind         TEXT    PRIMARY KEY,
      status       TEXT    NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER,
      result_json  TEXT,
      error        TEXT
    );
  `);
}

/**
 * Authentication tables for Phase 1 of remote-access support.
 *
 * `paired_clients` — one row per device that has completed pairing. We store
 * `token_hash` (SHA-256 of the plaintext token) rather than the token itself
 * so a DB leak does not expose live credentials. The plaintext is returned
 * exactly once at pairing completion and never persisted.
 *
 * `pending_pairings` — short-lived rows representing a device that has
 * requested pairing and is waiting for the admin to enter the PIN. Rows are
 * pruned by TTL (`expires_at`) and after `attempts` exceeds the cap. A
 * successful PIN submission moves the minted token's hash into
 * `paired_clients` and deletes the pending row.
 */
function createAuthTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paired_clients (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      device_name   TEXT    NOT NULL,
      platform      TEXT    NOT NULL DEFAULT '',
      token_hash    TEXT    NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at  INTEGER,
      last_seen_ip  TEXT,
      revoked       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_paired_clients_token_hash ON paired_clients(token_hash);

    CREATE TABLE IF NOT EXISTS pending_pairings (
      id            TEXT    PRIMARY KEY,
      pin           TEXT    NOT NULL,
      device_name   TEXT    NOT NULL,
      platform      TEXT    NOT NULL DEFAULT '',
      ip            TEXT,
      requested_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at    INTEGER NOT NULL,
      attempts      INTEGER NOT NULL DEFAULT 0,
      approved_token TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_pairings_expires ON pending_pairings(expires_at);

    -- Tracks wrong-PIN guesses per source IP across pending pairings so a
    -- brute-forcer can't reset the per-pairing counter by restarting the
    -- handshake. When failed_attempts reaches the admin-configured cap, the
    -- IP is locked out of pairing for 24 h via locked_until. A successful
    -- PIN submission clears the row for that IP.
    CREATE TABLE IF NOT EXISTS pin_lockouts (
      ip               TEXT    PRIMARY KEY,
      failed_attempts  INTEGER NOT NULL DEFAULT 0,
      locked_until     INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Forensic event log for every connection attempt against the pairing /
    -- auth surface. Both successful and unsuccessful events are captured so
    -- an admin can later identify a malicious actor by IP, user agent, OS,
    -- browser, and device-type fingerprint. Free-form detail column is
    -- reserved for event-specific notes (e.g. lockout duration, error reason).
    CREATE TABLE IF NOT EXISTS connection_attempts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type        TEXT    NOT NULL,
      ip                TEXT,
      user_agent        TEXT,
      os                TEXT,
      browser           TEXT,
      device_type       TEXT,
      platform          TEXT,
      device_name       TEXT,
      pairing_id        TEXT,
      paired_client_id  INTEGER,
      occurred_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      detail            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_connection_attempts_ip          ON connection_attempts(ip);
    CREATE INDEX IF NOT EXISTS idx_connection_attempts_occurred_at ON connection_attempts(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_connection_attempts_event_type  ON connection_attempts(event_type);
  `);

  // Forensic columns on paired_clients — populated when pairing completes and
  // refreshed on subsequent authenticated requests. Added incrementally so
  // pre-existing installs upgrade in place.
  addColumnIfMissing(db, 'paired_clients', 'user_agent',     'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'os',             'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'browser',        'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'device_type',    'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'first_seen_at',  'INTEGER');
  addColumnIfMissing(db, 'paired_clients', 'first_seen_ip',  'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'request_count',  'INTEGER NOT NULL DEFAULT 0');
  // Extended fingerprint on the per-client row. These mirror the latest
  // values seen on `connection_attempts` so the Paired Devices list can
  // show country / hostname / language without joining the event table.
  addColumnIfMissing(db, 'paired_clients', 'accept_language',   'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'last_real_ip',      'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'last_reverse_dns',  'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'last_country',      'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'last_region',       'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'last_city',         'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'last_timezone',     'TEXT');
  addColumnIfMissing(db, 'paired_clients', 'last_client_hints', 'TEXT');

  // Forensic columns on pending_pairings — captured at the start of the
  // handshake so even failed attempts have a fingerprint in the log.
  addColumnIfMissing(db, 'pending_pairings', 'user_agent',  'TEXT');
  addColumnIfMissing(db, 'pending_pairings', 'os',          'TEXT');
  addColumnIfMissing(db, 'pending_pairings', 'browser',     'TEXT');
  addColumnIfMissing(db, 'pending_pairings', 'device_type', 'TEXT');

  // Extended forensic captures on every connection_attempts row. The base
  // schema in createAuthTables() above keeps the minimal set; everything
  // added below is appended via ALTER so pre-existing installs upgrade in
  // place without losing the historical event stream.
  //
  //   accept_language  — first language tag from Accept-Language (e.g. "en-US")
  //   referer / origin — where the request claims to come from
  //   forwarded_for    — raw X-Forwarded-For chain when behind a proxy
  //   real_ip          — best-guess true source IP (CF-Connecting-IP > X-Real-IP > XFF[0])
  //   client_hints     — JSON of Sec-CH-UA-* hints (platform, mobile, model, ...)
  //   method / path    — request line (request-level events only)
  //   status_code      — response status (request-level events only)
  //   protocol / host  — scheme + host header at request time
  //   reverse_dns      — best-effort PTR lookup of real_ip (cached)
  //   country/region/city/timezone — GeoIP lookup of real_ip (offline DB)
  //   dnt              — Do-Not-Track header (1 if set)
  //   auth_kind        — open|admin|lan|client|none — how the request was authorised
  addColumnIfMissing(db, 'connection_attempts', 'accept_language', 'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'referer',         'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'origin',          'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'forwarded_for',   'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'real_ip',         'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'client_hints',    'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'method',          'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'path',            'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'status_code',     'INTEGER');
  addColumnIfMissing(db, 'connection_attempts', 'protocol',        'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'host',            'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'reverse_dns',     'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'country',         'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'region',          'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'city',            'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'timezone',        'TEXT');
  addColumnIfMissing(db, 'connection_attempts', 'dnt',             'INTEGER');
  addColumnIfMissing(db, 'connection_attempts', 'auth_kind',       'TEXT');

  // Compound index for the "Sources" rollup view (group by real_ip + UA).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_connection_attempts_real_ip
      ON connection_attempts(real_ip);
  `);
}

/**
 * One row per manga that the user has opted into auto-checking against its
 * recorded source URLs. Driven by [server/src/scheduler/index.js], which
 * polls this table once a minute, finds rows where `next_run_at <= now`,
 * fetches each URL's chapter list, and enqueues whatever the local folder is
 * missing into the existing download queue.
 *
 * `frequency='daily'`  → fires every day at `time_of_day` (server local).
 * `frequency='weekly'` → fires once a week on `day_of_week` (0=Sunday).
 *
 * `next_run_at` is recomputed by the scheduler after every fire, and by the
 * route handler whenever the schedule is created or edited — so the poll
 * loop only ever has to do an indexed `WHERE next_run_at <= ?` lookup.
 *
 * `last_result` is a short user-facing string (e.g. "Queued 3 new chapters",
 * "No new chapters", "error: Network timeout") so the UI can show what
 * happened on the most recent run without needing a separate log table.
 */
function createMangaSchedulesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manga_schedules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id        INTEGER NOT NULL UNIQUE REFERENCES manga(id) ON DELETE CASCADE,
      enabled         INTEGER NOT NULL DEFAULT 1,
      frequency       TEXT    NOT NULL,
      day_of_week     INTEGER,
      time_of_day     TEXT    NOT NULL,
      last_checked_at INTEGER,
      last_result     TEXT,
      next_run_at     INTEGER,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_manga_schedules_due ON manga_schedules(next_run_at) WHERE enabled = 1;
  `);
}

/**
 * Per-manga record of known third-party source URLs. Multiple URLs per manga
 * are allowed (different source, mirror, or replacement after a dead link).
 *
 * Layered on top of `manga.mangadex_id` (etc.) — the per-source columns stay
 * as denormalized "active" pointers used by the cover/metadata pipelines, and
 * are kept in sync with the most recent matching URL row by triggers below.
 *
 * `last_used_at` is touched whenever a download succeeds against the URL, so
 * a future scheduler can sort series by recency-of-use to pace its checks.
 */
function createMangaSourceUrlsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manga_source_urls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id      INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      source        TEXT    NOT NULL,
      source_id     TEXT,
      url           TEXT    NOT NULL,
      label         TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_used_at  INTEGER,
      UNIQUE (manga_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_manga_source_urls_manga  ON manga_source_urls(manga_id);
    CREATE INDEX IF NOT EXISTS idx_manga_source_urls_source ON manga_source_urls(source);
  `);
}

/**
 * Background download queue used by the Third Party Sourcing feature. One row
 * per chapter the user asked the app to fetch from MangaDex (or any future
 * source). Rows survive process restarts so a kill mid-download leaves a clear
 * record of what was queued — the queue rehydrates on startup and skips
 * anything already in `done` / `failed` / `cancelled`.
 *
 * `target_*` columns describe where the resulting CBZ should land:
 *   - target_mode = 'new'       → create folder named target_folder_name in target_library_id
 *   - target_mode = 'existing'  → write into manga(id = target_manga_id)
 *
 * Self-contained — no FK to manga / libraries because the destination might
 * not exist yet (mode='new'), and we want the record to survive a manga
 * deletion so the user can still see the history.
 */
function createDownloadJobsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS download_jobs (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      source               TEXT    NOT NULL,
      source_series_id     TEXT    NOT NULL,
      source_series_title  TEXT,
      source_chapter_id    TEXT    NOT NULL,
      chapter_number       REAL,
      chapter_volume       REAL,
      chapter_title        TEXT,
      target_mode          TEXT    NOT NULL,
      target_library_id    INTEGER,
      target_manga_id      INTEGER,
      target_folder_name   TEXT,
      target_chapter_filename TEXT,
      status               TEXT    NOT NULL DEFAULT 'queued',
      error                TEXT,
      pages_downloaded     INTEGER NOT NULL DEFAULT 0,
      pages_total          INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at           INTEGER,
      finished_at          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_download_jobs_status     ON download_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_download_jobs_created_at ON download_jobs(created_at DESC);
  `);
}

/**
 * Pre-`doujinshi_cover`-column installations saved Doujinshi.info covers as
 * `<mangaId>_cover.webp` because doujinshi was the one source without a
 * dedicated column. The new cover-priority resolver only looks at *_cover
 * columns, so doujinshi-displayed manga would otherwise lose their cover
 * after the first Reset Thumbnails / post-scan reinforcement.
 *
 * Backfill: any manga whose `doujinshi_cover` is NULL but whose displayed
 * source is doujinshi gets the legacy filename written into the new column.
 * The actual file isn't touched — we only point the column at it.
 */
function backfillDoujinshiCover(db) {
  const { changes } = db.prepare(`
    UPDATE manga
       SET doujinshi_cover = (id || '_cover.webp')
     WHERE metadata_source = 'doujinshi'
       AND doujinshi_cover IS NULL
       AND doujinshi_id    IS NOT NULL
  `).run();
  if (changes > 0) {
    console.log(`[DB] Backfilled doujinshi_cover for ${changes} legacy doujinshi-displayed manga.`);
  }
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

module.exports = { getDb, seedDefaultLists, DEFAULT_USER_ID };
