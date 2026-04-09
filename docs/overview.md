# Momotaro — Project Overview

Momotaro is a self-hosted manga reader server. You drop manga folders (or CBZ files) into a library directory, and it serves a web UI to browse, read, and track progress — with optional AniList sync.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | SQLite via `better-sqlite3` |
| Image processing | `sharp` (WebP thumbnails) |
| Archive support | `adm-zip` (CBZ/ZIP extraction) |
| File watching | `chokidar` |
| Frontend | React 18 + React Router 6 |
| Bundler | Vite 5 |
| Deployment | Docker (nginx + Node) |

## Directory Structure

```
momotaro/
├── server/              # Express API server
│   └── src/
│       ├── index.js           # App entry point
│       ├── config.js          # Env-var configuration
│       ├── db/database.js     # SQLite init + migrations
│       ├── routes/            # API route handlers
│       ├── scanner/           # Library scanning logic
│       ├── metadata/          # AniList / Jikan integration
│       └── watcher/           # File system watcher
├── client/              # React SPA
│   └── src/
│       ├── api/client.js      # All API calls in one place
│       ├── pages/             # Route-level components
│       ├── components/        # Shared UI components
│       └── context/           # React context (sidebar)
├── library/             # Default manga storage (mounted volume in Docker)
├── data/                # Runtime data: DB, thumbnails, CBZ cache
├── docker-compose.yml
└── docs/                # This documentation
```

## Development Setup

```bash
# Server (runs on :3000)
cd server && npm install && npm run dev

# Client (runs on :5173, proxies /api to :3000)
cd client && npm install && npm run dev
```

## Docker (Production)

```bash
docker compose up --build
# UI available at http://localhost:8080
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `LIBRARY_PATH` | `./library` | Root manga library directory |
| `DATA_PATH` | `./data` | Where DB, thumbnails, CBZ cache are stored |
| `DB_PATH` | `$DATA_PATH/momotaro.db` | SQLite database file |
| `THUMBNAIL_DIR` | `$DATA_PATH/thumbnails` | Generated cover thumbnails |
| `CBZ_CACHE_DIR` | `$DATA_PATH/cbz-cache` | Extracted CBZ pages |
| `SCAN_ON_STARTUP` | `true` | Re-scan library when server starts |
| `METADATA_FETCH_ENABLED` | `true` | Auto-fetch AniList metadata on scan |
| `REQUEST_DELAY_MS` | `700` | Delay between AniList API requests (rate limiting) |
