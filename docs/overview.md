# Momotaro — Project Overview

Momotaro is a self-hosted manga reader server. You drop manga folders (or CBZ files) into a library directory, and it serves a web UI to browse, read, and track progress — with optional AniList sync.

**Multi-user accounts** are on by default since the user-accounts release: each
device logs in (or creates the owner account), and reading progress, lists,
history, favourite stats, and AniList linkage are private to each account and
sync across that account's devices. An admin (the existing Client Management
operator) has total control over every account — view, export, delete,
force-logout — and can audit all-users reading history. A single-user install
keeps working unchanged: the operator can turn the flag off
(`multi_user_enabled = 0`) for a zero-friction one-library-many-devices setup,
or just create one account and let everyone share it. Design docs:
[user-accounts.md](./user-accounts.md),
[user-accounts-compat.md](./user-accounts-compat.md),
[user-accounts-implementation.md](./user-accounts-implementation.md).

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js + Express |
| Database | SQLite via `better-sqlite3` |
| Image processing | `sharp` (WebP thumbnails) |
| Archive reads | `yauzl` — central-directory-only reads at scan time; two-mode per-chapter extraction (full vs first-page-fast) on first reader open (see [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache) and [scanner.md § Fast mode](./scanner.md#fast-mode-first-page-fast)) |
| Archive writes | `adm-zip` (CBZ creation in the optimize endpoint only) |
| File watching | `chokidar` |
| Frontend | React 18 + React Router 6 |
| Bundler | Vite 5 |
| Deployment | Docker (nginx + Node) |
| Android | Capacitor 8 wrapper over the same React build — see [android.md](./android.md) |

## Directory Structure

```text
momotaro/
├── server/              # Express API server
│   └── src/
│       ├── index.js              # App entry point + graceful shutdown
│       ├── config.js             # Env-var configuration
│       ├── utils.js              # Shared helpers (`safeJsonParse`, `csvEscape`, `formatUnix`, `getSetting` / `setSetting`)
│       ├── logger.js             # Console interceptor → in-memory log ring buffer (2000 entries)
│       ├── genresCache.js        # In-memory payload cache backing /api/genres
│       ├── db/database.js        # SQLite init + migrations
│       ├── routes/               # API route handlers (library, chapters, pages, progress, settings, metadata, optimize, admin, adminAuth, gallery, config, sources, pairing, network, users, userPreferences, appVersion)
│       ├── scanner/              # Library scanning, CBZ extract cache + scheduler, thumbnails, cover priority
│       ├── metadata/             # AniList / MAL / MangaUpdates / Doujinshi.info + per-source JSON cache
│       ├── sources/              # Third Party Sourcing adapters (mangadex, weebcentral, mangaball, mangataro, mangadotnet, comikuro, comix.to, mangakakalot, natomanga, mangafire; _mangabox shared base) + URL parser
│       ├── downloader/queue.js   # Persistent FIFO download queue for the Third Party Sourcing flow
│       ├── scheduler/            # Per-manga `manga_schedules` poll loop and run-now worker
│       ├── auth/                 # Sessions + auth primitives — `adminSession`, `userSession`, `loginLockout` / `pinLockout`, `rateLimit`, `connectionLog`, `crypto` (scrypt password hash + token gen), `ipEnrichment`, `userAgent`
│       ├── admin/taskRegistry.js # Shared task primitive for async admin actions (vacuum, cache wipe, reset/regenerate thumbnails) — in-memory state with optional `admin_tasks` mirroring
│       ├── network/upnp.js       # UPnP IGD client driving the Port Forwarding admin UI
│       ├── middleware/           # `asyncWrapper`, `auth` (network gate, admin gate), `userAuth` (per-user gate), `requestLogger`, central error handler
│       └── watcher/              # chokidar watcher
├── client/              # React SPA + Android wrapper
│   ├── capacitor.config.json  # Capacitor scheme / hostname / mixed-content config — see [android.md](./android.md)
│   ├── android/               # Capacitor-generated Android project (Gradle build, AndroidManifest, NSC, release keystore wiring)
│   └── src/
│       ├── api/               # `client.js` (all API calls + device/user/admin tokens + `rewriteMediaUrls`), plus the offline subsystem — `offlineApi`, `offlineDb`, `offlineFolder`, `offlineStorage`, `offlineCrypto`, `outboxSync`, `downloader`, `downloadKeepAlive`, `immersive` (see [offline.md](./offline.md))
│       ├── version.js         # APP_VERSION constant — kept in sync with `versionName` in `android/app/build.gradle`
│       ├── pages/             # Route-level components (Home, Library, MangaDetail, Reader, Settings, EditManga, Libraries, Genres, ArtGallery, ThirdPartySourcing, AnilistCallback, Pairing, Login, Downloads)
│       │   └── settings/      # Per-tab Settings section components (Anilist, MyAnimeList, Doujinshi, Libraries, Homepage, Reading, Database, Scheduling, ThirdPartySourcing, SystemLogs, Statistics, ClientManagement, PortForwarding, Android, Linux, OfflineDownloads, …) + AdminAuthForms + nativeShell helper — Settings.jsx is now a slim tab router over these
│       ├── components/        # Shared UI components (AppSidebar, Sidebar, BottomNav, MangaCard, Ribbon, ArtGalleryRibbon, RibbonOrderEditor, GenreChipPicker, ToggleRow, InstallPrompt, UpdateBanner, AdminTaskBanner, RequireAdminAccess, AccountSection, UserManagementBlock, Reader{Paged,Scroll,Controls,EdgeHints}, VirtualizedMangaGrid, LetterJumpRail)
│       ├── dialog/            # In-app modal subsystem replacing window.alert/confirm/prompt — `DialogProvider`, `dialogService` (`appAlert`/`appConfirm`/`appPrompt` + `ensureAdminAccess`), `AdminUnlockDialog`, `scrollLock`
│       ├── hooks/             # `useReaderPrefetch`, `useGridColumnCount`, `useScrollPosition`, `useAppUpdateCheck`, `useAdminTask`, `useAdminTaskButton`
│       ├── utils/             # Dependency-free helpers — `format.js` (elapsed / next-run formatters), `readingProgress.js` (per-user resume keys)
│       └── context/           # React contexts: `SidebarContext`, `UserContext`, `PreferencesContext`, `ConnectivityContext`
├── assets/              # Source artwork / logo files
├── data/                # Runtime data: DB, thumbnails, CBZ extract cache, per-source metadata cache, downloads/ (signed APK + version.json — see [android.md](./android.md)) — gitignored
├── py_scripts/          # Stand-alone helper Python scripts for library cleanup (not invoked by the server)
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

The container ships the Node server and the prebuilt React SPA together. Express serves the SPA out of `client/dist` and the API under `/api/*` on the same port. The dev-mode Vite server on `:5173` only runs when you start it manually with `npm run dev`; it isn't part of the Docker image.

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
| `LIBRARY_PATH` | `./library` | Default library directory used when no library row exists yet. Libraries are normally configured at runtime via the API; this is just a fallback path. |
| `DATA_PATH` | `./data` | Where DB and thumbnails are stored |
| `DB_PATH` | `$DATA_PATH/momotaro.db` | SQLite database file |
| `THUMBNAIL_DIR` | `$DATA_PATH/thumbnails` | Generated cover thumbnails |
| `CBZ_CACHE_DIR` | `$DATA_PATH/cbz-cache` | Per-chapter extract cache for CBZ archives. Size cap and scheduled auto-clear are runtime-configurable from Settings → Database (persisted in the `settings` table). See [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache). |
| `DOWNLOADS_DIR` | `$DATA_PATH/downloads` | Holds the signed Android APK (`momotaro.apk`) and `version.json` advertised by `GET /api/app/version`. See [android.md § Self-hosted distribution](./android.md#self-hosted-distribution). |
| `SCAN_ON_STARTUP` | `true` | Re-scan all libraries when server starts (set to the literal string `false` to disable). |
| `REQUEST_DELAY_MS` | `700` | Legacy minimum delay floor; the AniList integration now reads `X-RateLimit-Limit` and adapts spacing per response (default range 700–5 000 ms). |
