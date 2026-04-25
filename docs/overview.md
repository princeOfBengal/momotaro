# Momotaro — Project Overview

Momotaro is a self-hosted manga reader server. You drop manga folders (or CBZ files) into a library directory, and it serves a web UI to browse, read, and track progress — with optional AniList sync.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js + Express |
| Database | SQLite via `better-sqlite3` |
| Image processing | `sharp` (WebP thumbnails) |
| Archive reads | `yauzl` (streaming CBZ/ZIP — single-entry reads, no extraction) |
| Archive writes | `adm-zip` (CBZ creation in the optimize endpoint only) |
| File watching | `chokidar` |
| Frontend | React 18 + React Router 6 |
| Bundler | Vite 5 |
| Deployment | Docker (nginx + Node) |

## Directory Structure

```text
momotaro/
├── server/              # Express API server
│   └── src/
│       ├── index.js           # App entry point + graceful shutdown
│       ├── config.js          # Env-var configuration
│       ├── logger.js          # Console interceptor → in-memory log ring buffer (2000 entries)
│       ├── db/database.js     # SQLite init + migrations
│       ├── routes/            # API route handlers
│       ├── scanner/           # Library scanning logic
│       ├── metadata/          # AniList / Jikan / Doujinshi.info integration
│       └── watcher/           # File system watcher
├── client/              # React SPA
│   └── src/
│       ├── api/client.js      # All API calls + device ID + timeout
│       ├── pages/             # Route-level components
│       ├── components/        # Shared UI components
│       └── context/           # React context (sidebar)
├── assets/              # Source artwork / logo files
├── data/                # Runtime data: DB, thumbnails (gitignored)
├── docker-compose.yml
└── docs/                # This documentation
```

## First-Time Setup

When no libraries are configured, the Library page shows a "Welcome to Momotaro" prompt with a button that navigates directly to the Libraries tab in Settings. There is no default library created automatically — the user must add at least one library path before the app will scan for manga.

## Development Setup

```bash
# Server (runs on :3000)
cd server && npm install && npm run dev

# Client (runs on :5173, proxies /api and /thumbnails to :3000)
cd client && npm install && npm run dev
```

## Docker (Production)

```bash
docker compose up -d --build
# UI + API on http://localhost:3000
```

### Data persistence

The compose file bind-mounts two host directories into the container:

| Host path | Container path | Contents |
| --- | --- | --- |
| `./library` | `/app/library` (read-only) | Your manga folders / CBZ files |
| `./data` | `/app/data` | SQLite DB, thumbnails, CBZ extract cache |

Because `./data` is a host bind mount (not a Docker-managed named volume), **all server state survives** `docker compose stop`, `docker compose down`, `docker compose down -v`, `docker compose up --build`, image pulls, and host reboots. The SQLite database at `./data/momotaro.db` holds every piece of state the server cares about: configured libraries, reading lists, reading progress, metadata tagging, per-device AniList sessions, Doujinshi.info tokens, and AniList/MAL client credentials.

**To back up the server**, copy the `./data` directory while the container is stopped (or while it's running — SQLite WAL is safe to copy live, but stopping first is simpler).

**To migrate to another host**, copy both `./data` and `./library` to the new host alongside `docker-compose.yml`, then `docker compose up -d --build`.

**If you previously used the old named-volume setup** (`momotaro_data`) and have data in it you want to keep, copy it out once before switching:

```bash
docker run --rm -v momotaro_data:/from -v "$(pwd)/data":/to alpine \
  sh -c "cp -a /from/. /to/"
# then, optional cleanup of the now-unused named volume:
docker volume rm momotaro_data
```

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Server listen port |
| `DATA_PATH` | `./data` | Where DB and thumbnails are stored |
| `DB_PATH` | `$DATA_PATH/momotaro.db` | SQLite database file |
| `THUMBNAIL_DIR` | `$DATA_PATH/thumbnails` | Generated cover thumbnails |
| `CBZ_CACHE_DIR` | `$DATA_PATH/cbz-cache` | Per-chapter extract cache for CBZ archives. Size cap and scheduled auto-clear are runtime-configurable from Settings → Database (persisted in the `settings` table). See [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache). |
| `SCAN_ON_STARTUP` | `true` | Re-scan all libraries when server starts |
| `METADATA_FETCH_ENABLED` | `true` | Auto-fetch AniList metadata on scan |
| `REQUEST_DELAY_MS` | `700` | Legacy minimum delay floor; the AniList integration now reads `X-RateLimit-Limit` and adapts spacing per response (default range 700–5 000 ms). |
