# Momotaro Developer Docs

Quick-reference documentation for the Momotaro self-hosted manga server.

## Contents

| Document | What it covers |
|---|---|
| [overview.md](./overview.md) | Stack, directory layout, dev setup, environment variables |
| [database.md](./database.md) | Full SQLite schema — every table, column, index, and migration |
| [api.md](./api.md) | All REST API endpoints with request/response shapes |
| [scanner.md](./scanner.md) | Library scanning, chapter name parsing rules, CBZ extraction, file watching |
| [reader.md](./reader.md) | Reader modes, gesture system internals, progress saving, controls visibility |
| [frontend.md](./frontend.md) | React routing, pages, components, API client, PWA config |
| [anilist.md](./anilist.md) | OAuth setup, metadata fetch, progress sync logic, `track_volumes` flag |

## Quick Start

```bash
# Development
cd server && npm install && npm run dev   # API on :3000
cd client && npm install && npm run dev   # UI  on :5173

# Production
docker compose up --build                 # UI  on :8080
```

## Key Architecture Notes

- **Single SQLite DB** — `better-sqlite3` with WAL mode. All writes are synchronous on the server; no connection pooling needed.
- **File-first** — Manga and chapter records reflect the filesystem. The scanner upserts rows; deleting a manga from the UI only removes the DB row, not the files.
- **React 17+ event delegation** — When writing pointer/gesture handlers in React, `e.currentTarget` is the document root, not the DOM element. Always use `useRef` to get the real DOM node for `setPointerCapture` and `getBoundingClientRect`.
- **AniList sync is fire-and-forget** — `syncToAniList()` runs after the HTTP response is sent. Errors are logged but never surfaced to the client.
- **All reader settings in localStorage** — No server-side user preferences. Settings persist per browser.
