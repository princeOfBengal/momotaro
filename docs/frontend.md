# Frontend Architecture

React 18 SPA bundled with Vite. Dev server on `:5173`, proxies `/api` to `:3000`.

## Routing

Defined in [client/src/App.jsx](../client/src/App.jsx):

| Path | Component | Description |
|---|---|---|
| `/` | `Library` | Main manga grid |
| `/manga/:mangaId` | `MangaDetail` | Manga info and chapter list |
| `/read/:chapterId` | `Reader` | Full-screen reader |
| `/settings` | `Settings` | App settings + AniList OAuth |
| `/libraries` | `Libraries` | Manage library paths |
| `/anilist/callback` | `AnilistCallback` | OAuth redirect handler |

## Pages

### Library (`src/pages/Library.jsx`)

- Loads all manga via `GET /api/library`
- Sidebar filter by library or reading list
- Search bar (client-side filter on title)
- Sort by: title, last read, date added, score
- Scan button triggers `POST /api/scan`
- Click manga card → navigate to `/manga/:id`

### MangaDetail (`src/pages/MangaDetail.jsx`)

- Shows cover, metadata (title, status, year, genres, score, description)
- Chapter list sorted by `number ?? volume` (ascending)
- Chapter display label logic:
  - `vol !== null && number !== null` → `Vol. N Ch. N`
  - `vol !== null` → `Volume N`
  - `number !== null` → `Chapter N` (or `Volume N` if `track_volumes`)
  - fallback → `folder_name`
- "Refresh Metadata" button → `POST /api/manga/:id/refresh-metadata`
- Manual AniList search modal → `GET /api/metadata/search?q=` → `POST /api/manga/:id/apply-metadata`
- Progress badge on each chapter (read / current / unread)
- Resume reading button (jumps to last read chapter+page)

### Reader (`src/pages/Reader.jsx`)

See [reader.md](./reader.md) for full details.

URL: `/read/:chapterId?mangaId=<id>&page=<n>`

### Settings (`src/pages/Settings.jsx`)

- AniList connection: enter client ID + secret, trigger OAuth flow
- Shows connection status and username when logged in
- Logout button clears stored token

### Libraries (`src/pages/Libraries.jsx`)

- List all configured libraries with their paths
- Add new library (name + path)
- Delete library

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

Notable helpers:
```js
api.pageImageUrl(pageId)    // → "/api/pages/{id}/image"
api.thumbnailUrl(manga)     // → thumbnail path
```

## Context

`SidebarContext` (`src/context/SidebarContext.jsx`) — boolean `sidebarOpen` + `setSidebarOpen` shared between `Library` page and `Sidebar` component.

## PWA

`vite-plugin-pwa` generates a service worker and `manifest.json`. The app can be installed as a PWA on mobile/desktop. Icons are in `client/public/`.

## CSS Architecture

No CSS framework — hand-written component-scoped CSS files. Global base styles in `src/styles/global.css`. Dark-first color scheme with CSS custom properties.
