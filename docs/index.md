# Momotaro Developer Docs

Quick-reference documentation for the Momotaro self-hosted manga server.

## Contents

| Document | What it covers |
|---|---|
| [overview.md](./overview.md) | Stack, directory layout, dev setup, environment variables |
| [database.md](./database.md) | Full SQLite schema — every table, column, index, migration, and connection pragmas |
| [api.md](./api.md) | All REST API endpoints with request/response shapes |
| [scanner.md](./scanner.md) | Library scanning, parallel scan, incremental mtime shortcut, streaming CBZ reads, cached disk-usage columns, file watching |
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
- **Streaming CBZ reads** — CBZ chapters are never extracted to disk. The scanner uses `yauzl` to list entries from the archive's central directory, and the page-serving route streams individual entries on demand with `openCbzEntryStream`. Parsed central directories are kept in a bounded LRU (mtime-validated, no fd retention) so repeat page fetches from a hot archive skip the ~1 ms/entry `readEntry` walk. `pages.path` stores the ZIP entry name for CBZ chapters and the absolute filesystem path for folder chapters; the serving route branches on `chapters.type`. Any legacy `CBZ_CACHE_DIR` contents are wiped on server startup.
- **Cached disk-usage columns** — `manga.bytes_on_disk` / `manga.file_count` are populated at scan time (summed from `chapters.bytes_on_disk` / `chapters.file_count`), so `/api/stats` and `/api/manga/:id/info` answer with one query instead of walking the library.
- **Per-device AniList login** — Each browser generates a UUID stored in `localStorage` (`momotaro_device_id`) and sends it as `X-Device-ID` on every request. The server stores AniList tokens in `device_anilist_sessions` keyed by device ID. Logging in on one device does not affect any other.
- **Server-wide Doujinshi.info login** — Doujinshi.info credentials (access token + refresh token) are stored in the `settings` table and shared across all devices, unlike AniList which is per-device.
- **File-first** — Manga and chapter records reflect the filesystem. The scanner upserts rows on every scan. Deleting a manga via the UI removes DB rows **and** the files on disk. The scanner also prunes stale records automatically: chapters missing from disk are removed during `scanMangaDirectory`; manga with no remaining chapters (empty folder, all chapters deleted) are removed at the end of the chapter pass; manga whose folder no longer exists are caught by a library-level cleanup pass at the end of each `scanLibrary` run.
- **AniList sync is fire-and-forget** — `syncToAniList()` runs after the HTTP response is sent. It uses the `X-Device-ID` from the original request to look up the token. Errors are logged but never surfaced to the client. HTTP 429 responses are retried automatically (up to 3 times, honouring the `retry-after` header).
- **All reader settings in localStorage** — No server-side user preferences. Settings persist per browser.
- **Graceful shutdown** — The server handles `SIGTERM` and `SIGINT` by closing the HTTP server cleanly before exiting, with a 10-second force-exit fallback.
- **React 17+ event delegation** — When writing pointer/gesture handlers in React, `e.currentTarget` is the document root, not the DOM element. Always use `useRef` to get the real DOM node for `setPointerCapture` and `getBoundingClientRect`.
