# Database Schema

SQLite database at `$DATA_PATH/momotaro.db`. Initialized and migrated in [server/src/db/database.js](../server/src/db/database.js).

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
| `description` | TEXT | From AniList/MAL |
| `cover_image` | TEXT | Relative path under `THUMBNAIL_DIR` |
| `status` | TEXT | e.g. `FINISHED`, `RELEASING` |
| `year` | INTEGER | |
| `genres` | TEXT | JSON array, e.g. `["Action","Romance"]` |
| `anilist_id` | INTEGER | AniList media ID |
| `mal_id` | INTEGER | MyAnimeList ID |
| `score` | REAL | Average score from metadata source |
| `metadata_source` | TEXT | `none`, `anilist`, `mal`, `local` |
| `track_volumes` | INTEGER | 0 = track by chapter, 1 = track by volume |
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
| `created_at` | INTEGER | |

**Unique constraint:** `(manga_id, folder_name)`

### `pages`
One row per image page.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `chapter_id` | INTEGER FK | References `chapters(id)`, CASCADE delete |
| `page_index` | INTEGER | 0-based position |
| `filename` | TEXT | File name |
| `path` | TEXT | Absolute path |
| `width` | INTEGER | Pixel dimensions (may be null) |
| `height` | INTEGER | |
| `is_wide` | INTEGER | 1 if width > height (auto-detected for double-page spreads) |

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
Key-value store for app-wide configuration.

| Key | Value Description |
|---|---|
| `anilist_token` | OAuth access token |
| `anilist_user_id` | Logged-in user's AniList ID |
| `anilist_username` | Display name |
| `anilist_client_id` | OAuth app client ID |
| `anilist_client_secret` | OAuth app client secret |

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

## Indexes

```sql
idx_manga_library_id     ON manga(library_id)
idx_chapters_manga_id    ON chapters(manga_id)
idx_pages_chapter_id     ON pages(chapter_id)
idx_progress_manga_id    ON progress(manga_id)
idx_rlm_list_id          ON reading_list_manga(list_id)
idx_rlm_manga_id         ON reading_list_manga(manga_id)
```

## Migrations

The `migrate()` function in `database.js` runs on every startup with `CREATE TABLE IF NOT EXISTS`, so it is safe to run repeatedly.

Two explicit migration functions handle older installs:

- **`upgradeToMultiLibrary`** — Adds `library_id` to `manga` and switches the unique constraint from `folder_name` to `path`. Runs once, detected by checking `pragma_table_info`.
- **`upgradeLibraryShowInAll`** — Adds `show_in_all` column to `libraries` if missing.

## Pragmas

```sql
PRAGMA journal_mode = WAL;    -- Better concurrent read performance
PRAGMA foreign_keys = ON;     -- Enforce FK constraints
```
