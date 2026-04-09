# Frontend Architecture

React 18 SPA bundled with Vite. Dev server on `:5173`, proxies `/api` and `/thumbnails` to `:3000`.

## Routing

Defined in [client/src/App.jsx](../client/src/App.jsx):

| Path | Component | Description |
|---|---|---|
| `/` | `Library` | Main manga grid |
| `/manga/:mangaId` | `MangaDetail` | Manga info and chapter list |
| `/read/:chapterId` | `Reader` | Full-screen reader |
| `/settings` | `Settings` | App settings + AniList OAuth |
| `/auth/anilist/callback` | `AnilistCallback` | OAuth redirect handler |

## Pages

### Library (`src/pages/Library.jsx`)

- Loads manga via `GET /api/library`
- Sidebar filter by library or reading list
- Search bar with 300 ms debounce (title or comma-separated genres)
- Sort by: A–Z, recently updated, year
- Scan button triggers `POST /api/scan`
- Click manga card → navigate to `/manga/:id`
- **First-time setup state**: when no libraries are configured (`libraries.length === 0`) and no search or list filter is active, shows a "Welcome to Momotaro" prompt with a button that navigates to Settings → Library Management tab

### MangaDetail (`src/pages/MangaDetail.jsx`)

- Shows cover, metadata (title, status, year, genres, score, description)
- Chapter list sorted by `number ?? volume` (ascending)
- Chapter display label logic:
  - `vol !== null && number !== null` → `Vol. N Ch. N`
  - `vol !== null` → `Volume N`
  - `number !== null` → `Chapter N` (or `Volume N` if `track_volumes`)
  - fallback → `folder_name`
- "Refresh Metadata" button → `POST /api/manga/:id/refresh-metadata`
- Manual AniList search modal → `GET /api/anilist/search?q=` → `POST /api/manga/:id/apply-metadata`
- Progress badge on each chapter (read / current / unread)
- Resume reading button (jumps to last read chapter+page)

### Reader (`src/pages/Reader.jsx`)

See [reader.md](./reader.md) for full details.

URL: `/read/:chapterId?mangaId=<id>&page=<n>`

### Settings (`src/pages/Settings.jsx`)

- Accepts an optional `location.state.section` value on navigation to open a specific tab directly (e.g. the "Go to Library Management" button in the first-time setup state passes `{ section: 'libraries' }`)
- **AniList tab**: enter client ID + secret, trigger OAuth flow; login state is per-device (see below)
- **Libraries tab**: add, edit, delete library paths; trigger per-library scans

### AnilistCallback (`src/pages/AnilistCallback.jsx`)

Landing page for the AniList OAuth redirect. Extracts `?code=` from the URL, POSTs to `POST /api/auth/anilist/exchange`, then redirects to `/settings` on success.

## AniList — Per-Device Login

Each browser generates a UUID via `crypto.randomUUID()` on first load and stores it in `localStorage` as `momotaro_device_id`. Every API request includes this as the `X-Device-ID` header. The server scopes all AniList session reads and writes to that device ID, so logging in on one device has no effect on any other device.

To reset a device's AniList session manually (e.g. for testing):

```js
localStorage.removeItem('momotaro_device_id')
```

## Navbar Logo

The "Momotaro" logo (`/logo.png`) appears in the navbar of every page as a `<Link to="/">` element. Clicking it always navigates to the root route, resetting any active library or reading list filter. The CSS class `.navbar-brand` / `.navbar-logo` controls sizing (40 px tall, width auto).

## Components

### `MangaCard`

- Cover image (thumbnail URL)
- Title, chapter count
- Progress indicator (last read chapter)

### `ReaderPaged` / `ReaderScroll` / `ReaderControls`

See [reader.md](./reader.md).

### `Sidebar`

- Library list + reading list filter
- Controlled via `SidebarContext` for mobile open/close
- Hamburger button in Library header opens it on mobile

## API Client (`src/api/client.js`)

Single `api` object with typed methods for every endpoint. Returns parsed JSON data (unwraps `{ data: ... }` envelope). Throws on non-OK responses.

Every request includes:

- `Content-Type: application/json`
- `X-Device-ID: <uuid>` (from `localStorage`)
- A 15-second `AbortController` timeout — throws `'Request timed out'` if exceeded

Notable helpers:

```js
api.pageImageUrl(pageId)    // → "/api/pages/{id}/image"
api.thumbnailUrl(filename)  // → "/thumbnails/{filename}"
```

## Context

`SidebarContext` (`src/context/SidebarContext.jsx`) — boolean `sidebarOpen` + `setSidebarOpen` shared between `Library` page and `Sidebar` component.

## PWA

`vite-plugin-pwa` generates a service worker and `manifest.json`. The app can be installed as a PWA on mobile/desktop. Icons are in `client/public/`. The logo image (`logo.png`) is also in `client/public/` and pre-cached by the service worker via the `globPatterns` config.

## CSS Architecture

No CSS framework — hand-written component-scoped CSS files. Global base styles in `src/styles/global.css`. Dark-first color scheme with CSS custom properties.
