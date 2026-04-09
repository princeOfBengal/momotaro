# Momotaro Developer Docs

Quick-reference documentation for the Momotaro self-hosted manga server.

## Contents

| Document | What it covers |
|---|---|
| [overview.md](./overview.md) | Stack, directory layout, dev setup, environment variables |
| [database.md](./database.md) | Full SQLite schema — every table, column, index, migration, and connection pragmas |
| [api.md](./api.md) | All REST API endpoints with request/response shapes |
| [scanner.md](./scanner.md) | Library scanning, incremental scan logic, CBZ cache validation, file watching |
| [reader.md](./reader.md) | Reader modes, gesture system internals, progress saving, controls visibility |
| [frontend.md](./frontend.md) | React routing, pages, components, API client, PWA config |
| [anilist.md](./anilist.md) | Per-device OAuth, metadata fetch, progress sync, rate limiting, `track_volumes` flag |

## Quick Start

```bash
# Development
cd server && npm install && npm run dev   # API on :3000
cd client && npm install && npm run dev   # UI  on :5173

# Production
docker compose up --build                 # UI  on :8080
```

## Key Architecture Notes

- **Single SQLite DB** — `better-sqlite3` with WAL mode, `synchronous = NORMAL`, and a 32 MB page cache. All writes are synchronous on the server thread; no connection pooling needed.
- **Incremental scanning** — The scanner stores each chapter's file mtime in `chapters.file_mtime`. On re-scan, chapters whose mtime is unchanged and already have indexed pages are skipped entirely, making repeated scans of large libraries fast.
- **Per-device AniList login** — Each browser generates a UUID stored in `localStorage` (`momotaro_device_id`) and sends it as `X-Device-ID` on every request. The server stores AniList tokens in `device_anilist_sessions` keyed by device ID. Logging in on one device does not affect any other.
- **File-first** — Manga and chapter records reflect the filesystem. The scanner upserts rows on every scan. Deleting a manga via the UI removes DB rows **and** the files on disk.
- **AniList sync is fire-and-forget** — `syncToAniList()` runs after the HTTP response is sent. It uses the `X-Device-ID` from the original request to look up the token. Errors are logged but never surfaced to the client. HTTP 429 responses are retried automatically (up to 3 times, honouring the `retry-after` header).
- **All reader settings in localStorage** — No server-side user preferences. Settings persist per browser.
- **Graceful shutdown** — The server handles `SIGTERM` and `SIGINT` by closing the HTTP server cleanly before exiting, with a 10-second force-exit fallback.
- **React 17+ event delegation** — When writing pointer/gesture handlers in React, `e.currentTarget` is the document root, not the DOM element. Always use `useRef` to get the real DOM node for `setPointerCapture` and `getBoundingClientRect`.
