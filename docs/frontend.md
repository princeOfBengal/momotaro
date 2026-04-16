# Frontend Architecture

React 18 SPA bundled with Vite. Dev server on `:5173`, proxies `/api` and `/thumbnails` to `:3000`.

## Routing

Defined in [client/src/App.jsx](../client/src/App.jsx):

| Path | Component | Description |
| --- | --- | --- |
| `/` | `Library` | Main manga grid |
| `/manga/:mangaId` | `MangaDetail` | Manga info and chapter list |
| `/read/:chapterId` | `Reader` | Full-screen reader |
| `/settings` | `Settings` | App settings + AniList OAuth |
| `/auth/anilist/callback` | `AnilistCallback` | OAuth redirect handler |

## Pages

### Library (`src/pages/Library.jsx`)

- Loads manga via `GET /api/library`
- Sidebar filter by library or reading list
- Search bar with 300 ms debounce — matches against title, **author/artist name** (partial), or genre. Comma-separated terms filter by all listed genres simultaneously.
- Sort by: A–Z, recently updated, year
- Scan button triggers `POST /api/scan`
- Click manga card → navigate to `/manga/:id`
- **Filter initialisation from navigation state** — on mount, `activeLibrary` and `activeList` are seeded from `location.state.library` and `location.state.list` (React Router state). This allows the MangaDetail nav drawer to navigate back to a specific library or reading list without URL parameters.
- **First-time setup state**: when no libraries are configured (`libraries.length === 0`) and no search or list filter is active, shows a "Welcome to Momotaro" prompt with a button that navigates to Settings → Library Management tab
- **Libraries sidebar section**: shown whenever at least one library exists (`libraries.length > 0`). The **All Libraries** aggregate entry is only shown when there are two or more libraries — with a single library it is omitted as redundant.

### MangaDetail (`src/pages/MangaDetail.jsx`)

- Shows cover, metadata (title, author/artist, status, year, genres, score, description)
  - `author` is displayed below the title when present; the element is omitted entirely when `manga.author` is falsy
- Chapter list sorted by `number ?? volume` (ascending)
- Chapter display label logic:
  - `vol !== null && number !== null` → `Vol. N Ch. N`
  - `vol !== null` → `Volume N`
  - `number !== null` → `Chapter N` (or `Volume N` if `track_volumes`)
  - fallback → `folder_name`
- **Nav drawer** — hamburger button (☰) in the navbar opens a slide-in drawer listing all libraries and reading lists. Clicking an entry navigates to `/` and passes `{ library: id }` or `{ list: id }` in React Router location state, which `Library` reads on mount to pre-select the filter.
- **More Info button** — opens a modal that fetches `GET /api/manga/:id/info` and displays the manga's filesystem path, total file count, and folder size in MB. The request is made lazily on first open and the result is cached for the lifetime of the page.
- **Metadata button** opens a modal with a **Source dropdown** (AniList / MyAnimeList / Doujinshi.info, defaults to AniList). Each source exposes the same two actions:
  - *Fetch* — auto-fetch by title (`refresh-metadata`, `refresh-mal-metadata`, or `refresh-doujinshi-metadata`)
  - *Search Manually* — opens a search modal (`AnilistSearchModal`, `MALSearchModal`, or `DoujinshiSearchModal`)
- AniList search modal → `GET /api/anilist/search?q=` → `POST /api/manga/:id/apply-metadata`
- MyAnimeList search modal → `GET /api/mal/search?q=` → `POST /api/manga/:id/apply-mal-metadata`
- Doujinshi.info search modal → `GET /api/doujinshi/search?q=` → `POST /api/manga/:id/apply-doujinshi-metadata`
- The status badge in the modal reflects the current source: "Local file", "Linked to AniList", "Linked to MyAnimeList", "Linked to Doujinshi.info", or "No metadata linked". MyAnimeList badges link out to `myanimelist.net/manga/{mal_id}`.
- **Export as JSON** — when the source dropdown matches the manga's currently linked source (e.g. the dropdown is set to AniList and `metadata_source === 'anilist'`), an *Export as JSON* action row appears below the *Search Manually* row. Clicking *Export* calls `POST /api/manga/:id/export-metadata`, which writes a `metadata.json` sidecar file directly to the manga's folder on disk. The result is shown as a success or error message inside the modal. The button is available independently on each of the three source tabs so the user can switch tabs to find and export the linked source's metadata.
- **Break Linkage** — when a manga is linked to AniList, MyAnimeList, or Doujinshi.info, a danger-styled *Reset* button appears at the bottom of the modal. Clicking it calls `POST /api/manga/:id/reset-metadata`, which clears the external ID (`anilist_id`, `mal_id`, or `doujinshi_id`), nulls out all sourced metadata fields, and sets `metadata_source` back to `'none'`. Use this when the wrong title was auto-matched; the manga can then be re-linked to the correct entry. `title` and `cover_image` are preserved.
- Progress badge on each chapter (read / current / unread)
- Resume reading button (jumps to last read chapter+page)
- **Clickable thumbnail** — the cover image has the `detail-cover-clickable` class and shows a "Change" hint overlay on hover. Clicking it opens the **Thumbnail Picker Modal**, which fetches `GET /api/manga/:id/thumbnail-options` and presents four ordered sections:
  1. **AniList** — the thumbnail sourced from AniList (`anilist_cover`), if available
  2. **Original** — the first-ever generated thumbnail (`original_cover`), if available
  3. **Previously Used** — up to 20 entries from `thumbnail_history`, most recent first
  4. **Chapter Covers** — the first page (`page_index = 0`) of every chapter
  Selecting an option calls either `POST /api/manga/:id/set-thumbnail` with `{ saved_filename }` (for saved files) or `{ page_id }` (for chapter first pages). On success, the active cover image is cache-busted by updating a `coverBust` timestamp appended to the thumbnail URL.
- **Mobile Settings dropdown** — on screens ≤ 640 px the individual *Metadata*, *Optimize*, and *More Info* buttons are replaced by a single **Settings ▾** dropdown (class `detail-settings-wrap detail-mobile-only`). Tapping an item closes the dropdown then opens the relevant modal. On desktop the three buttons remain visible individually (class `detail-desktop-only`).

### Reader (`src/pages/Reader.jsx`)

See [reader.md](./reader.md) for full details.

URL: `/read/:chapterId?mangaId=<id>&page=<n>`

### Settings (`src/pages/Settings.jsx`)

- Accepts an optional `location.state.section` value on navigation to open a specific tab directly (e.g. the "Go to Library Management" button in the first-time setup state passes `{ section: 'libraries' }`)
- **AniList tab**: enter client ID + secret, trigger OAuth flow; login state is per-device
- **MyAnimeList tab**: enter Client ID (no login required); stored server-wide. Shows "Client ID configured" when set, with a *Remove Client ID* button to clear it
- **Doujinshi.Info tab**: email + password login form; login state is server-wide (shared across all devices)
- **Libraries tab**: add, edit, delete library paths; trigger per-library scans. The page uses a wider content area (max-width 1100 px) to accommodate all action buttons on each library card. Each library card shows the following actions:
  - **Scan Now** — triggers `POST /api/libraries/:id/scan`
  - **Bulk Metadata Pull ▾** — shows a source dropdown (AniList / MyAnimeList / Doujinshi.info) before starting the pull. After the request returns, a status line is shown under the card indicating how many titles will be fetched vs. how many were skipped (e.g. *"Pulling metadata for 12 titles in the background. 38 skipped (already have metadata)."* or *"All 50 titles already have metadata — nothing to pull."*)
  - **Bulk Optimize** — converts chapters to CBZ and standardises filenames
  - **Export Metadata** — calls `POST /api/libraries/:id/export-metadata`, which writes a `metadata.json` sidecar file into every manga folder that has third-party metadata (`metadata_source != 'none'`). After it completes, a status line shows how many titles were exported and how many were skipped. The exported files use field names that the local metadata scanner already understands, so a database reset followed by a rescan will re-import the metadata automatically.
  - **Edit** / **Delete** — rename or remove the library
- **Database tab**: maintenance operations for the server's database and on-disk cache:
  - *CBZ Cache* — displays the current cache size; **Clear Cache** deletes all extracted pages from `CBZ_CACHE_DIR` (pages are re-extracted on next access)
  - *Regenerate Thumbnails* — **Regenerate All** fires `POST /api/admin/regenerate-thumbnails`; the job runs in the background and the UI shows a confirmation with the total manga count. For each manga, the AniList cover is restored if available, otherwise a new thumbnail is generated from the first page of the first chapter
  - *Compact Database* — **Compact Database** runs `POST /api/admin/vacuum-db` synchronously and displays the before/after file size

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

Metadata methods:

```js
api.refreshMetadata(mangaId)                  // AniList auto-fetch by title
api.refreshMalMetadata(mangaId)               // MyAnimeList auto-fetch by title
api.refreshDoujinshiMetadata(mangaId)         // Doujinshi.info auto-fetch by title
api.searchAnilist(q, page)                    // AniList manual search
api.searchMal(q, page)                        // MyAnimeList manual search
api.searchDoujinshi(q, page)                  // Doujinshi.info manual search
api.applyMetadata(mangaId, anilistId)         // Apply AniList result by ID
api.applyMalMetadata(mangaId, malId)          // Apply MyAnimeList result by ID
api.applyDoujinshiMetadata(mangaId, slug)     // Apply Doujinshi.info result by slug
api.resetMetadata(mangaId)                    // Break external linkage and clear sourced fields
api.bulkMetadata(libraryId, source)           // Bulk pull — source: 'anilist' | 'myanimelist' | 'doujinshi'
api.exportMetadata(libraryId)                 // Write metadata.json to each manga folder with third-party metadata
api.exportMangaMetadata(mangaId)              // Write metadata.json for a single manga
api.saveMalClientId(clientId)                 // Save (or clear with '') MAL Client ID
api.doujinshiLogin(email, password)           // Doujinshi.info login
api.doujinshiLogout()                         // Doujinshi.info logout
```

Thumbnail methods:

```js
api.getThumbnailOptions(mangaId)              // GET thumbnail-options (anilist, original, history, chapter pages)
api.setPageAsThumbnail(mangaId, pageId)       // POST set-thumbnail with { page_id }
api.setThumbnailFromFile(mangaId, filename)   // POST set-thumbnail with { saved_filename }
```

Admin / database methods:

```js
api.getCbzCacheSize()        // GET cbz-cache-size → { size_bytes }
api.clearCbzCache()          // POST clear-cbz-cache → { size_bytes: 0 }
api.regenerateThumbnails()   // POST regenerate-thumbnails → { message, total }
api.vacuumDb()               // POST vacuum-db → { size_before_bytes, size_after_bytes }
```

## Context

`SidebarContext` (`src/context/SidebarContext.jsx`) — boolean `sidebarOpen` + `setSidebarOpen` shared between `Library` page and `Sidebar` component.

## PWA

`vite-plugin-pwa` generates a service worker (`sw.js`) and `manifest.webmanifest` at build time. The app is fully installable as a PWA on Android and iOS.

### Manifest

Key fields in `vite.config.js`:

| Field | Value | Notes |
| --- | --- | --- |
| `id` | `/` | Stable app identity independent of server hostname/IP |
| `display` | `standalone` | Hides browser chrome when installed |
| `orientation` | `any` | Allows portrait and landscape |
| `prefer_related_applications` | `false` | Prevents Android from suppressing the install prompt |
| `theme_color` | `#1a1a1a` | Matches the navbar background |
| `background_color` | `#0f0f0f` | Shown during splash screen |

Icons in `client/public/`:

| File | Size | Purpose |
| --- | --- | --- |
| `icon-192.png` | 192 × 192 | Standard Android home screen icon |
| `icon-512.png` | 512 × 512 | High-res + maskable (listed twice in manifest) |
| `apple-touch-icon.png` | 180 × 180 | iOS "Add to Home Screen" icon |
| `icon.svg` | — | Favicon, also pre-cached |

### Service worker headers

The server (`server/src/index.js`) overrides `Cache-Control` for PWA-critical files so the browser always re-fetches them and picks up updates:

```text
sw.js              → Cache-Control: no-store, no-cache
registerSW.js      → Cache-Control: no-store, no-cache
manifest.webmanifest → Cache-Control: no-store, no-cache
```

All other static assets (JS bundles, CSS) use Express's default ETag-based conditional revalidation.

### Service worker update behaviour

`skipWaiting: true` and `clientsClaim: true` are set in the Workbox config. When a new build is deployed, the new service worker activates immediately and takes control of all open tabs without waiting for them to be closed.

### Caching strategy

The service worker uses five named caches with different strategies matched in priority order:

| Cache | URL pattern | Strategy | Max entries | TTL |
| --- | --- | --- | --- | --- |
| `page-images` | `/api/pages/:id/image` | CacheFirst | 5 000 | 1 year |
| `thumbnails` | `/thumbnails/*` | CacheFirst | 2 000 | 1 year |
| `chapter-pages-meta` | `/api/chapters/:id/pages` | CacheFirst | 1 000 | 30 days |
| `browse-data` | `/api/(library\|libraries\|manga\|chapters\|reading-lists\|stats)` | StaleWhileRevalidate | 500 | 30 days |
| `api-misc` | `/api/*` (catch-all) | NetworkFirst | 200 | 7 days |

**Why each strategy:**

- **CacheFirst** for page images and thumbnails — content is identified by a numeric ID and never mutated; there is no benefit to a network round-trip once cached.
- **CacheFirst** for chapter page listings — page paths and dimensions are written once at scan time and never updated for a given chapter ID. Eliminates a network call on every reader open.
- **StaleWhileRevalidate** for browse data — library listings, manga detail, chapter lists, reading lists, and stats change only on scan or metadata update. The cached version is returned instantly; the fresh version is fetched in the background so the next visit reflects any changes.
- **NetworkFirst** for everything else — reading progress must be accurate; search results are ephemeral. Falls back to a 7-day cache if the server is unreachable (e.g. away from home network).

### Installation requirement

Android Chrome requires **HTTPS** (or `localhost`) to show the install prompt. iOS Safari's "Add to Home Screen" works over plain HTTP. For home-server deployments a reverse proxy with a self-signed certificate (e.g. Caddy) satisfies the HTTPS requirement.

## Mobile UI

The app is fully responsive and designed to work on phones and small screens. No separate mobile routes — the same pages adapt via CSS media queries.

### Breakpoints

| Breakpoint | Affects |
| --- | --- |
| `≤ 700px` | Library page drawer, global button tap targets |
| `≤ 640px` | MangaDetail layout, Settings tab bar |
| `≤ 600px` | Reader controls, MangaDetail bottom-sheet modals |
| `≤ 580px` | Libraries management page |
| `≤ 420px` | Very small phones — smaller grid columns, compact navbar |

### Library page (≤ 700px)

- The sidebar collapses into a fixed slide-out **drawer** (`transform: translateX(-100%)` → `translateX(0)` when `.drawer-open`).
- A **hamburger button** (40 × 40 px) in the navbar triggers the drawer.
- A **semi-transparent backdrop** (`position: fixed; inset: 0; z-index: 199`) covers the page when the drawer is open so tapping outside closes it.
- **Important**: the backdrop element is always in the DOM at `≤ 700px` but uses `opacity: 0; pointer-events: none` when closed so it never intercepts taps. Only the `.open` class restores `opacity: 1; pointer-events: auto`.
- Manga grid columns shrink to `minmax(130px, 1fr)` (100px at `≤ 420px`).
- A mobile-only sort bar replaces the toolbar that is hidden with `.lib-desktop-only`.

### MangaDetail page (≤ 640px / ≤ 600px)

- Action buttons stretch to fill the full row width.
- *Metadata*, *Optimize*, and *More Info* are consolidated into a **Settings ▾** dropdown to save row space (see MangaDetail page description above).
- The metadata/search **modals become bottom sheets** at `≤ 600px`: `align-items: flex-end`, rounded top corners only, `max-height: 88vh`.

### Reader (≤ 600px)

- The **zoom slider** is hidden; `+`/`−` step buttons remain so zoom is still adjustable.
- The settings panel expands to full viewport width (`width: 100vw; border-left: none`).
- Both control bars (top and bottom) use `env(safe-area-inset-*)` to avoid overlap with the iOS notch and home indicator.
- The reader content area adds matching padding via `env(safe-area-inset-top/bottom)` when bars are visible.

### Settings page (≤ 640px)

- The left sidebar becomes a **horizontal scrolling tab bar** (no scrollbar visible, accent underline on active tab).
- Nav items meet the 44 px minimum touch target.

### Global touch improvements (`src/styles/global.css`, `≤ 700px`)

- All `.btn` elements have `min-height: 44px` to meet Apple/Google tap-target guidelines.
- `-webkit-tap-highlight-color: transparent` removes the grey tap flash on iOS Safari.
- Explicit `:active` states replace `:hover` feedback (hover states don't persist after touch).

### PWA / safe-area

The app targets `viewport-fit=cover` (set in `index.html`) so the content fills the entire screen on notched devices. Control bars and the navbar use `env(safe-area-inset-*)` to stay inside the safe area.

## CSS Architecture

No CSS framework — hand-written component-scoped CSS files. Global base styles in `src/styles/global.css`. Dark-first color scheme with CSS custom properties.

### File overview

| File | Scope |
| --- | --- |
| `src/styles/global.css` | CSS variables, base resets, navbar, shared button classes, global mobile touch rules |
| `src/pages/Library.css` | Library grid, sidebar/drawer, hamburger, backdrop |
| `src/pages/MangaDetail.css` | Detail layout, chapter list, modals / bottom sheets |
| `src/pages/Reader.css` | Full-screen reader layout, `bars-visible` padding |
| `src/components/ReaderControls.css` | Top/bottom bars, zoom controls, settings panel |
| `src/pages/Settings.css` | Settings layout, tab bar, stat tiles/grid |
| `src/pages/Libraries.css` | Library management list and form |
