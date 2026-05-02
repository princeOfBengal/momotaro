# Database Schema

SQLite database at `$DATA_PATH/momotaro.db`. Initialized and migrated in [server/src/db/database.js](../server/src/db/database.js).

## Connection Settings

Applied on every startup via `db.pragma()`:

| Pragma | Value | Effect |
|---|---|---|
| `journal_mode` | `WAL` | Write-ahead logging — allows concurrent reads during a write |
| `foreign_keys` | `ON` | Enforces FK constraints and `ON DELETE CASCADE` |
| `synchronous` | `NORMAL` | Safe with WAL; avoids the fsync overhead of `FULL` |
| `cache_size` | `-262144` | 256 MB in-process page cache — fits the hot working set at 8TB scale |
| `mmap_size` | `1073741824` | 1 GB memory-mapped I/O region; read-heavy library queries skip `read()` syscalls |
| `wal_autocheckpoint` | `10000` | Checkpoint every ~10 000 pages (≈40 MB) instead of the 1 000-page default — fewer stalls during bulk scans |
| `temp_store` | `MEMORY` | Temporary sort/join tables live in RAM |

## Tables

### `libraries`
Multiple library root directories.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `name` | TEXT | Display name |
| `path` | TEXT UNIQUE | Absolute filesystem path |
| `show_in_all` | INTEGER | 1 = included in "All Libraries" filter |
| `created_at` | INTEGER | Unix timestamp |

### `manga`
One row per manga folder.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `library_id` | INTEGER FK | References `libraries(id)`, SET NULL on delete |
| `folder_name` | TEXT | Bare folder name |
| `path` | TEXT UNIQUE | Absolute path |
| `title` | TEXT | Display title (from metadata or folder name) |
| `author` | TEXT | Artist / author name (from local JSON or AniList staff) |
| `description` | TEXT | From AniList/MAL |
| `cover_image` | TEXT | Relative path under `THUMBNAIL_DIR` |
| `status` | TEXT | e.g. `FINISHED`, `RELEASING` |
| `year` | INTEGER | |
| `genres` | TEXT | JSON array, e.g. `["Action","Romance"]` |
| `anilist_id` | INTEGER | AniList media ID |
| `mal_id` | INTEGER | MyAnimeList ID |
| `mangaupdates_id` | INTEGER | MangaUpdates `series_id` (the modern long-form ID) |
| `doujinshi_id` | TEXT | Doujinshi.info book slug, e.g. `glasses-in-summer-life` |
| `score` | REAL | Average score from metadata source (0–10 scale) |
| `metadata_source` | TEXT | `none`, `anilist`, `myanimelist`, `mangaupdates`, `doujinshi`, `local` — controls which source's text fields the UI displays |
| `track_volumes` | INTEGER | 0 = track by chapter, 1 = track by volume |
| `anilist_cover` | TEXT | Filename of the AniList-sourced thumbnail, e.g. `5_anilist.webp` |
| `mal_cover` | TEXT | Filename of the MyAnimeList-sourced thumbnail, e.g. `5_mal.webp` |
| `mangaupdates_cover` | TEXT | Filename of the MangaUpdates-sourced thumbnail, e.g. `5_mu.webp` |
| `doujinshi_cover` | TEXT | Filename of the Doujinshi.info-sourced thumbnail, e.g. `5_dj.webp` (legacy installs see `5_cover.webp`, backfilled by `backfillDoujinshiCover`) |
| `original_cover` | TEXT | Filename of the first-ever scan-generated thumbnail, e.g. `5_original.webp` — set once and never overwritten; final fallback in the cover priority |
| `cover_user_set` | INTEGER | 1 when the user manually picked the active cover via `POST /api/manga/:id/set-thumbnail`. The post-scan and Reset-Thumbnails reinforcement passes are the only paths that ever clear it (and they always do; both call `reinforceAllCovers(force=true)`). Default 0. |
| `last_metadata_fetch_attempt_at` | INTEGER | Unix timestamp of the last bulk-pull attempt (any source) — used to skip recently-tried no-match titles |
| `bytes_on_disk` | INTEGER | Cached rollup of `SUM(chapters.bytes_on_disk)`. Refreshed per-manga by the watcher / optimize paths, and via one grouped `UPDATE … FROM (SELECT … GROUP BY manga_id)` at the end of each `scanLibrary` run. Lets `/api/stats` and `/api/manga/:id/info` answer without walking the library. |
| `file_count` | INTEGER | Cached rollup of `SUM(chapters.file_count)` — total image pages across all chapters. |
| `created_at` | INTEGER | |
| `updated_at` | INTEGER | |

### `chapters`
One row per chapter folder or CBZ file.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `manga_id` | INTEGER FK | References `manga(id)`, CASCADE delete |
| `folder_name` | TEXT | Bare file/folder name |
| `path` | TEXT | Absolute path |
| `type` | TEXT | `folder` or `cbz` |
| `number` | REAL | Parsed chapter number (null if volume-only) |
| `volume` | REAL | Parsed volume number (null if chapter-only) |
| `title` | TEXT | Optional chapter title |
| `page_count` | INTEGER | |
| `file_mtime` | INTEGER | Unix timestamp (seconds) of the chapter file/folder at last scan — used to skip re-processing unchanged chapters |
| `bytes_on_disk` | INTEGER | Size of the chapter on disk. For `folder`: sum of its image files. For `cbz`: the archive's own size (NOT the uncompressed sum). |
| `file_count` | INTEGER | Number of image pages in the chapter (equal to `page_count`). |
| `created_at` | INTEGER | |

**Unique constraint:** `(manga_id, folder_name)`

### `pages`
One row per image page.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `chapter_id` | INTEGER FK | References `chapters(id)`, CASCADE delete |
| `page_index` | INTEGER | 0-based position |
| `filename` | TEXT | Basename for display (e.g. `001.jpg`) |
| `path` | TEXT | **Dual-purpose by chapter type.** For `chapters.type = 'folder'` rows: absolute filesystem path. For `chapters.type = 'cbz'` rows: a filename relative to the chapter's CBZ extraction cache directory (`CBZ_CACHE_DIR/<chapterId>_<mtimeFloor>/`). Newly-scanned CBZ chapters initially store the ZIP entry name; the first time the chapter is opened, `GET /api/chapters/:id/pages` extracts the archive into the cache and rebuilds the rows so `path` matches the on-disk cache filename (e.g. `0001.jpg`). See [scanner.md → CBZ Serve Cache](./scanner.md#cbz-serve-cache). |
| `width` | INTEGER | Pixel dimensions. Folder-chapter pages get them at scan time; CBZ pages start null and are populated by the API the first time the chapter is opened (see [scanner.md → Image Dimension Fetching](./scanner.md#image-dimension-fetching)). Stays null only when an entry is unreadable. |
| `height` | INTEGER | |
| `is_wide` | — | Not a column. Derived at API serve time from `width`/`height`: `true` when the page's width is ≥ 1.5× the median page width across the chapter (a true double-page spread that visually occupies two normal pages). `null` when dimensions are unknown. |

**Unique constraint:** `(chapter_id, page_index)`

### `progress`
One row per manga (UNIQUE on `manga_id`).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `manga_id` | INTEGER FK UNIQUE | References `manga(id)`, CASCADE delete |
| `current_chapter_id` | INTEGER FK | Last-read chapter |
| `current_page` | INTEGER | 0-based page index within current chapter |
| `completed_chapters` | TEXT | JSON array of chapter IDs, e.g. `[3,4,7]` |
| `last_read_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |

### `settings`
Key-value store for server-wide configuration (not per-device state). Every row is included in `GET /api/admin/export-config` and restored on import.

| Key | Value Description |
|---|---|
| `anilist_client_id` | AniList OAuth app client ID |
| `anilist_client_secret` | AniList OAuth app client secret |
| `doujinshi_token` | Doujinshi.info JWT access token (15-minute expiry) |
| `doujinshi_refresh_token` | Doujinshi.info refresh token for obtaining new access tokens |
| `mal_client_id` | MyAnimeList API Client ID (`X-MAL-CLIENT-ID` header; no OAuth) |
| `cbz_cache_limit_bytes` | CBZ extract-cache size cap, bytes. Bounded to `[100 MB, 10 TB]`; default 20 GB when missing. Applied live via `cbzCache.setLimitBytes()` when changed through the admin API. See [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache). |
| `cbz_cache_autoclear_mode` | `off` \| `daily` \| `weekly`. Drives the auto-clear scheduler. |
| `cbz_cache_autoclear_day` | `0..6` (0 = Sunday). Day-of-week when `cbz_cache_autoclear_mode = 'weekly'`. Ignored otherwise. |
| `cbz_cache_autoclear_time` | `HH:MM` 24-hour, server local time. Time-of-day for the scheduled wipe. |

### `device_anilist_sessions`
Per-device AniList login state. Keyed by a UUID generated in the browser (`localStorage` key `momotaro_device_id`) and sent as the `X-Device-ID` request header.

| Column | Type | Notes |
|---|---|---|
| `device_id` | TEXT PK | UUID from browser localStorage |
| `anilist_token` | TEXT | OAuth access token for this device |
| `anilist_user_id` | TEXT | AniList user ID |
| `anilist_username` | TEXT | Display name |
| `anilist_avatar` | TEXT | Avatar URL |
| `updated_at` | INTEGER | Unix timestamp |

### `anilist_media_list_cache`

Per-device cache of the user's AniList list entry for a given media ID. `GET /api/manga/:id/anilist-status` reads from here on every manga-detail page open and only falls through to a live `MediaList` GraphQL query when the cached row is missing or older than 5 minutes (`ANILIST_LIST_CACHE_TTL_SECONDS`). The mutating `PATCH /api/manga/:id/anilist-progress` writes the post-mutation entry back into the cache, so the next page open is served from cache without re-pinging AniList.

| Column | Type | Notes |
|---|---|---|
| `device_id` | TEXT | UUID from browser localStorage (`X-Device-ID` header) |
| `media_id` | INTEGER | AniList media id (`manga.anilist_id`) |
| `entry_json` | TEXT | Serialised MediaList payload — **`NULL` is a real, cacheable answer** meaning "the user does not have this manga on their list yet" |
| `fetched_at` | INTEGER | Unix timestamp; rows older than 5 minutes are treated as misses |

**Primary key:** `(device_id, media_id)` — `INSERT … ON CONFLICT DO UPDATE` is used everywhere that writes to it, so the row is upserted with a fresh `fetched_at` on every refresh.

### `thumbnail_history`

Records every page that has ever been manually set as a manga's thumbnail. Used to populate the "Previously Used" section of the thumbnail picker.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `manga_id` | INTEGER FK | References `manga(id)`, CASCADE delete |
| `filename` | TEXT | Saved thumbnail filename, e.g. `5_1713200000000.webp` |
| `created_at` | INTEGER | Unix timestamp (`unixepoch()` default) |

**Unique constraint:** `(manga_id, filename)` — `INSERT OR IGNORE` prevents duplicate entries.

**Index:** `idx_thumb_history_manga_id ON thumbnail_history(manga_id)`

---

### `art_gallery`

User-bookmarked pages shown in the *Art Gallery* section at the bottom of MangaDetail. Rows are inserted by the *Add to Art Gallery* button in the reader and can be removed from either the reader (toggle) or the gallery grid.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment; used by the MangaDetail remove button |
| `manga_id` | INTEGER FK | References `manga(id)`, CASCADE delete |
| `chapter_id` | INTEGER FK | References `chapters(id)`, CASCADE delete — kept so labels survive scan churn as long as the chapter still exists |
| `page_id` | INTEGER FK | References `pages(id)`, CASCADE delete |
| `created_at` | INTEGER | Unix timestamp (`unixepoch()` default); drives the newest-first ordering |

**Unique constraint:** `(manga_id, page_id)` — `INSERT OR IGNORE` makes re-adding an existing page a no-op. The reader uses this as an idempotent toggle.

**Index:** `idx_art_gallery_manga_id ON art_gallery(manga_id)`

**Cascade behaviour:** Deleting a manga, chapter, or page automatically removes the matching gallery rows — no manual cleanup is required after rescans that drop pages.

---

### `reading_lists`
User-created (and two built-in) reading lists.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT UNIQUE | |
| `is_default` | INTEGER | 1 for "Favorites" and "Want to Read" |
| `created_at` | INTEGER | |

### `reading_list_manga`
Junction table linking manga to lists.

| Column | Type | Notes |
|---|---|---|
| `list_id` | INTEGER FK | |
| `manga_id` | INTEGER FK | |
| `added_at` | INTEGER | Unix timestamp |

**Primary key:** `(list_id, manga_id)`

## Search Index (`manga_fts` + `manga_genres`)

Search is served from two derived structures maintained by triggers. No route needs to call `LIKE '%term%'` or `json_each(m.genres)` anymore — every query hits an index.

### `manga_fts` — FTS5 virtual table

```sql
CREATE VIRTUAL TABLE manga_fts USING fts5(
  title,
  author,
  content='manga',
  content_rowid='id',
  tokenize='unicode61'
);
```

External-content FTS5 table: the virtual table stores the inverted index only; the source of truth is still `manga.title` / `manga.author`. `content_rowid='id'` links each FTS row to the manga it represents, so `SELECT rowid FROM manga_fts WHERE manga_fts MATCH ?` returns `manga.id` values directly.

Default `unicode61` tokeniser: whole-word, case-insensitive, Unicode-normalised. **Substring matching is intentionally not supported** — a query for `Daw` will not match `Yona of the Dawn`. See [api.md § Search](./api.md#search-search) for the full semantic table.

### `manga_genres` — normalised genre pairs

```sql
CREATE TABLE manga_genres (
  manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
  genre    TEXT    NOT NULL COLLATE NOCASE,
  PRIMARY KEY (manga_id, genre)
);
CREATE INDEX idx_manga_genres_genre ON manga_genres(genre COLLATE NOCASE);
```

One row per (manga, genre) pair. `COLLATE NOCASE` on the column makes `genre = ?` case-insensitive and prevents `"Action"` + `"action"` from ever being two rows. `manga.genres` (the JSON blob) remains the authoritative store; this table is derived from it and rebuilt via triggers whenever the blob changes.

Multi-term genre search (`?search=action,romance`) translates to one `AND m.id IN (SELECT manga_id FROM manga_genres WHERE genre = ? COLLATE NOCASE)` per term, so each check uses the PK directly.

### Triggers

```text
manga_fts_ai     AFTER INSERT ON manga           → insert new FTS row
manga_fts_ad     AFTER DELETE ON manga           → delete FTS row (external-content 'delete' form)
manga_fts_au     AFTER UPDATE OF title,author    → delete + re-insert FTS row
manga_genres_ai  AFTER INSERT ON manga           → fan out NEW.genres JSON into rows
manga_genres_au  AFTER UPDATE OF genres ON manga → delete all, fan out NEW.genres JSON
```

Delete-side for `manga_genres` is handled by `ON DELETE CASCADE` on the FK. Both `_ai`/`_au` triggers guard against malformed JSON with `CASE WHEN json_valid(NEW.genres) THEN NEW.genres ELSE '[]' END` before calling `json_each`, so a bad blob doesn't abort the write.

**No write-path code changes needed anywhere** — every existing `UPDATE manga SET genres = ?` or `UPDATE manga SET title = ?` (scanner, AniList, MAL, doujinshi, local metadata, apply/refresh routes) fans out for free.

### Backfill

On startup, `migrateSearchIndex` detects empty-but-table-exists state and seeds both structures from the existing `manga` rows:

```sql
-- only if manga_fts is empty while manga has rows
INSERT INTO manga_fts(rowid, title, author) SELECT id, title, author FROM manga;
INSERT OR IGNORE INTO manga_genres (manga_id, genre)
  SELECT m.id, j.value
  FROM manga m, json_each(CASE WHEN json_valid(m.genres) THEN m.genres ELSE '[]' END) j;
```

Both are idempotent (`INSERT OR IGNORE`, and the FTS backfill is gated on emptiness), so a crash mid-migration and a retry on next boot is safe.

## Indexes

```sql
idx_manga_library_id      ON manga(library_id)
idx_manga_title           ON manga(title)                    -- speeds up ORDER BY title (default sort)
idx_manga_updated_at      ON manga(updated_at DESC)          -- speeds up ORDER BY updated_at
idx_manga_lib_status      ON manga(library_id, status)       -- speeds up library filter by status
idx_manga_lib_metadata_src ON manga(library_id, metadata_source) -- speeds up bulk metadata and export queries
idx_chapters_manga_id     ON chapters(manga_id)
idx_pages_chapter_id      ON pages(chapter_id)
idx_progress_manga_id     ON progress(manga_id)
idx_rlm_list_id           ON reading_list_manga(list_id)
idx_rlm_manga_id          ON reading_list_manga(manga_id)
idx_art_gallery_manga_id  ON art_gallery(manga_id)
```

## Migrations

The `migrate()` function in `database.js` runs on every startup using `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, making it safe to run repeatedly.

Column-level additions use the shared `addColumnIfMissing(db, table, column, definition)` helper, which checks `pragma_table_info` before running `ALTER TABLE`. This replaces the old per-feature upgrade functions.

Columns added via `addColumnIfMissing` (safe to run on every startup):

| Table | Column | Added for |
| --- | --- | --- |
| `libraries` | `show_in_all` | Multi-library "All Libraries" filter |
| `libraries` | `last_scan_mtime_ms` | Startup-scan root-mtime shortcut |
| `chapters` | `volume` | Volume-level chapter tracking |
| `chapters` | `file_mtime` | Incremental scan optimisation |
| `manga` | `author` | AniList staff extraction |
| `manga` | `doujinshi_id` | Doujinshi.info integration |
| `manga` | `mangaupdates_id` | MangaUpdates integration |
| `manga` | `anilist_cover` | AniList thumbnail filename |
| `manga` | `mal_cover` | MyAnimeList thumbnail filename |
| `manga` | `mangaupdates_cover` | MangaUpdates thumbnail filename |
| `manga` | `doujinshi_cover` | Doujinshi.info thumbnail filename (legacy installs are backfilled — see below) |
| `manga` | `original_cover` | First-ever scan-generated thumbnail filename |
| `manga` | `cover_user_set` | Manual-pick flag — see [scanner.md § Cover priority](./scanner.md#cover-priority) |
| `manga` | `last_metadata_fetch_attempt_at` | Bulk-pull retry cooldown |
| `chapters` | `bytes_on_disk` | Cached disk-usage column (see [scanner.md](./scanner.md#cached-disk-usage-columns)) |
| `chapters` | `file_count` | Cached file-count column |
| `manga` | `bytes_on_disk` | Rollup of chapter sizes for O(1) `/api/stats` |
| `manga` | `file_count` | Rollup of chapter file counts |

Structural migrations and one-time backfills handled separately from the column-level helper:

- **`upgradeToMultiLibrary`** — Recreates the `manga` table to add `library_id` and change the unique constraint from `folder_name` to `path`. Runs once, detected by checking `pragma_table_info`.
- **`backfillDoujinshiCover`** — Pre-`doujinshi_cover` installations saved Doujinshi.info covers as `<mangaId>_cover.webp` because doujinshi was the one source without a dedicated column. The new cover-priority resolver only looks at `*_cover` columns, so any doujinshi-displayed manga whose linkage exists but `doujinshi_cover IS NULL` gets the legacy filename written into the column on next startup. The actual file isn't touched. Logged as `[DB] Backfilled doujinshi_cover for N legacy doujinshi-displayed manga.` when it fires; no-op on subsequent boots.
