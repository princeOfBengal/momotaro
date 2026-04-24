# Momotaro Developer Docs

Quick-reference documentation for the Momotaro self-hosted manga server.

## Contents

| Document | What it covers |
|---|---|
| [overview.md](./overview.md) | Stack, directory layout, dev setup, environment variables |
| [database.md](./database.md) | Full SQLite schema — every table, column, index, migration, and connection pragmas |
| [api.md](./api.md) | All REST API endpoints with request/response shapes |
| [scanner.md](./scanner.md) | Library scanning, parallel scan, incremental mtime shortcut, streaming CBZ reads, cached disk-usage columns, file watching |
| [database.md § Search Index](./database.md#search-index-manga_fts--manga_genres) | `manga_fts` (FTS5 over title/author) + normalised `manga_genres`, with triggers that keep both in sync from the canonical `manga.genres` JSON blob |
| [reader.md](./reader.md) | Reader modes, gesture system internals, progress saving, controls visibility |
| [frontend.md](./frontend.md) | React routing, pages, components, API client, PWA config |
| [anilist.md](./anilist.md) | Per-device OAuth, metadata fetch, progress sync, rate limiting, `track_volumes` flag |
| [doujinshi.md](./doujinshi.md) | Email/password auth, search mechanics (space→underscore workaround), normalization, metadata priority |

## Quick Start

```bash
# Development
cd server && npm install && npm run dev   # API on :3000
cd client && npm install && npm run dev   # UI  on :5173

# Production
docker compose up --build                 # UI  on :8080
```

## Key Architecture Notes

- **Single SQLite DB** — `better-sqlite3` with WAL mode, `synchronous = NORMAL`, and a 256 MB page cache + 1 GB mmap window sized for 8 TB libraries. All writes are synchronous on the server thread; no connection pooling needed.
- **Incremental scanning** — The scanner stores each chapter's file mtime in `chapters.file_mtime`. On re-scan, chapters whose mtime is unchanged and already have indexed pages are skipped entirely, making repeated scans of large libraries fast.
- **Parallel scanning** — `scanLibrary` walks manga directories with `MANGA_CONCURRENCY = 4` workers via an internal `withLimit` helper. DB correctness is preserved because `better-sqlite3` serialises writes on a single thread; the speedup comes from overlapping disk I/O.
- **CBZ reads** — Scanning uses `yauzl` to list entries from the archive's central directory (parsed directories are kept in a bounded LRU, mtime-validated, no fd retention). Serving extracts each requested entry to `CBZ_CACHE_DIR/<chapterId>_<mtimeFloor>/<entry>` on first hit and then serves it as a plain file with `res.sendFile`; the extract cache defaults to 20 GB with LRU eviction and is **user-configurable at runtime** from Settings → Database. An optional daily/weekly auto-clear schedule fires a full wipe at a user-chosen time (see [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache)). Streaming serves were swapped for extract-to-disk after concurrent streams were observed cross-contaminating between archives. `pages.path` stores the ZIP entry name for CBZ chapters and the absolute filesystem path for folder chapters; the serving route branches on `chapters.type`.
- **Cached disk-usage columns** — `manga.bytes_on_disk` / `manga.file_count` are populated at scan time (summed from `chapters.bytes_on_disk` / `chapters.file_count`), so `/api/stats` and `/api/manga/:id/info` answer with one query instead of walking the library.
- **Indexed search** — `?search=` no longer scans the manga table. Title/author hits resolve through an FTS5 virtual table (`manga_fts`, `unicode61` tokeniser, whole-word match); genre hits resolve through a normalised `manga_genres(manga_id, genre COLLATE NOCASE)` table with a composite PK. Both structures are maintained by triggers against the canonical `manga.genres` JSON blob and `manga.title`/`manga.author`, so no write path needed to change.
- **Per-device AniList login** — Each browser generates a UUID stored in `localStorage` (`momotaro_device_id`) and sends it as `X-Device-ID` on every request. The server stores AniList tokens in `device_anilist_sessions` keyed by device ID. Logging in on one device does not affect any other.
- **Server-wide Doujinshi.info login** — Doujinshi.info credentials (access token + refresh token) are stored in the `settings` table and shared across all devices, unlike AniList which is per-device.
- **File-first** — Manga and chapter records reflect the filesystem. The scanner upserts rows on every scan. Deleting a manga via the UI removes DB rows **and** the files on disk. The scanner also prunes stale records automatically: chapters missing from disk are removed during `scanMangaDirectory`; manga with no remaining chapters (empty folder, all chapters deleted) are removed at the end of the chapter pass; manga whose folder no longer exists are caught by a library-level cleanup pass at the end of each `scanLibrary` run.
- **AniList sync is fire-and-forget** — `syncToAniList()` runs after the HTTP response is sent. It uses the `X-Device-ID` from the original request to look up the token. Errors are logged but never surfaced to the client. HTTP 429 responses are retried automatically (up to 3 times, honouring the `retry-after` header).
- **All reader settings in localStorage** — No server-side user preferences. Settings persist per browser. The library's default sort order (`home_default_sort`) follows the same pattern and is set from Settings → Homepage Settings; valid values are `title`, `updated`, `year`, `rating`.
- **Rating sort** — `GET /api/library?sort=rating` (and the same parameter on `/api/reading-lists/:id/manga`) orders rows by `m.score DESC NULLS LAST, m.title ASC`, so manga with an AniList or MyAnimeList score rank by that score, and any title that hasn't been matched to a third-party source falls to the bottom alphabetically.
- **Docker data persistence** — `docker-compose.yml` bind-mounts `./data` into the container (not a named volume), so all server state — SQLite DB, thumbnails, CBZ extract cache — lives in the user's filesystem and survives every Docker lifecycle operation including `docker compose down -v`. See [overview.md § Data persistence](./overview.md#data-persistence).
- **Portable config export/import** — `GET /api/admin/export-config` dumps the full user-facing state (settings, API keys, libraries, manga metadata linkage, reading lists, progress, art gallery) to a single JSON file keyed by `manga.path` and chapter `folder_name` instead of auto-increment IDs. `POST /api/admin/import-config` restores the payload inside a single SQLite transaction and remaps everything to the new IDs in the target DB. See [api.md § Configuration Backup](./api.md#configuration-backup).
- **Graceful shutdown** — The server handles `SIGTERM` and `SIGINT` by closing the HTTP server cleanly before exiting, with a 10-second force-exit fallback.
- **React 17+ event delegation** — When writing pointer/gesture handlers in React, `e.currentTarget` is the document root, not the DOM element. Always use `useRef` to get the real DOM node for `setPointerCapture` and `getBoundingClientRect`.
