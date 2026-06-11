# Frontend Architecture

React 18 SPA bundled with Vite. Dev server on `:5173`, proxies `/api` and `/thumbnails` to `:3000`.

## Routing

Defined in [client/src/App.jsx](../client/src/App.jsx):

| Path | Component | Description |
| --- | --- | --- |
| `/` | `Home` | Landing page with horizontal ribbons (Continue Reading, Recently Added, Discover, Art Gallery, Top Manga per favourite genre) |
| `/genres` | `Genres` | Browse By Genre — grid of every genre across visible libraries, each tile decorated with a faded top-rated cover; clicking a tile searches All Libraries for that genre |
| `/art-gallery` | `ArtGallery` | Standalone Art Gallery page — every bookmarked page grouped by series, each series rendered as its own ribbon. Reached from the sidebar shortcut. |
| `/third-party-sourcing` | `ThirdPartySourcing` | **Admin-gated** (wrapped in `RequireAdminAccess`). Third Party Sourcing UI — source dropdown, search, series detail + chapter picker, downloads queue. Accepts `?manga_id=N` to pre-fill the search box and lock the target to that existing manga. See [sources.md](./sources.md). |
| `/library` | `Library` | Main manga grid with search, sort, and the libraries / reading-lists sidebar |
| `/manga/:id` | `MangaDetail` | Manga info and chapter list |
| `/manga/:id/edit` | `EditManga` | **Admin-gated** (wrapped in `RequireAdminAccess`). Manual metadata editor — title, author, genres, and the `track_volumes` toggle. Reached from the *Edit Metadata* button on MangaDetail. PATCHes `/api/manga/:id`. |
| `/read/:chapterId` | `Reader` | Full-screen reader |
| `/libraries` | `Libraries` | Older standalone Library Management page; the same controls also live under Settings → Libraries. |
| `/settings` | `Settings` | App settings + AniList OAuth |
| `/auth/anilist/callback` | `AnilistCallback` | OAuth redirect handler |
| `/pairing` | `Pairing` | First-launch pairing wizard for the Android APK — 5 steps: welcome → server URL → device name → PIN entry → done. See [android.md § Pairing wizard](./android.md#pairing-wizard). |
| `/login` | `Login` | Two-tab Log in / Create account screen, with live `attempts_remaining` and the 24 h lockout countdown driven by structured error bodies from the API client. Reached automatically when the server reports `user_required` from `/api/admin/auth-status`. See [User Accounts & Login](#user-accounts--login). |
| `/downloads` | `Downloads` | Offline-mode queue + library management — two tabs (*Queue* listing every job from the persistent downloader, *Library* listing every series with at least one downloaded chapter). Capacitor-only surface backed by the offline subsystem in [offline.md](./offline.md). |
| `*` | — | Anything else `Navigate`s to `/`. |

Every route except `/`, `/library`, and `/manga/:id` is `React.lazy`-loaded. The main bundle is the Home → Library → MangaDetail click-through path; the Reader, Settings, Libraries, EditManga, Genres, ArtGallery, ThirdPartySourcing, and AnilistCallback chunks are fetched on first visit and then cached by the service worker for offline-instant subsequent navigations.

**Back-link convention:** the `<Link to="/">` used as the navbar logo on every page always returns to Home. "← Back" / "← Library" buttons (on MangaDetail, Settings, Libraries) target `/library` so they return to the full browsable grid, not the ribbon landing page.

**First-launch gating** — [`FirstLaunchGate`](../client/src/App.jsx) wraps every route except `/pairing` and `/auth/anilist/callback`. On mount it asks `GET /api/admin/auth-status` whether the caller would be turned away by the auth middleware and, if so, `<Navigate replace to="/pairing">`s. The native shell (Capacitor APK) short-circuits this when there's no saved server URL and no client token — it redirects to `/pairing` immediately without the probe, since `getServerUrl()` is empty and the would-be fetch would go to `http://momotaro.app/api/admin/auth-status` (the Capacitor asset shell, which has no API). See [android.md § First-launch routing](./android.md#first-launch-routing).

**Provider hierarchy** — [App.jsx](../client/src/App.jsx) nests, outermost to innermost: `BrowserRouter` → `ConnectivityProvider` → `DialogProvider` → (`Suspense`) → `UserProvider` → `PreferencesProvider` → `FirstLaunchGate` → `Routes`. The persistent chrome that must survive route changes — `ConnectivityBanner`, `AdminTaskBanner`, `InstallPrompt`, `UpdateBanner`, `AdminUnlockDialog`, and `BottomNav` — is mounted as siblings of `Routes` (inside `DialogProvider`) so it never re-mounts on navigation.

**Admin-gated routes** — `/third-party-sourcing` and `/manga/:id/edit` are wrapped in [`RequireAdminAccess`](#requireadminaccess), which blocks the page behind the server admin password until a valid admin session exists. One-shot admin actions that don't own a whole route (Optimize, per-manga metadata edits triggered inline, etc.) instead call `ensureAdminAccess()` from [the dialog subsystem](#dialog-subsystem-srcdialog) to pop the same password modal on demand. See [RequireAdminAccess](#requireadminaccess) and [Dialog subsystem](#dialog-subsystem-srcdialog).

## Pages

### Home (`src/pages/Home.jsx`)

Landing page at `/`. Renders the shared [`AppSidebar`](../client/src/components/AppSidebar.jsx) on the left (libraries + reading lists, same component used by the Library page) and a stack of horizontal-scrolling **ribbons** on the right, fed by a single `GET /api/home` fetch (see [api.md § Home](./api.md#home)). Every ribbon is scoped to manga in libraries that are visible in the All Libraries view — hiding a library via `show_in_all = 0` hides it from Home everywhere too.

Selecting a library or reading list in the sidebar navigates the user to `/library` with the filter pre-applied via React Router location state; on Library the same selections mutate in-place instead. The sidebar layout (`.library-layout` + `.library-sidebar` grid, mobile drawer behaviour, backdrop) is inherited from `Library.css`, which Home imports explicitly so both pages share the same CSS without duplication.

**Search bar** — the navbar carries a `<input type="search">` between the brand and the action buttons. Typing triggers a 300 ms-debounced `api.getLibrary({ search })` (no `library_id`, so the server resolves it to All Libraries scope — `show_in_all = 1` libraries plus orphan rows). While the input is non-empty, the ribbon stack is replaced by a flat `.manga-grid` of results with a `<count> result(s) across All Libraries` header. Clearing the box restores the ribbons. A "no results" empty state mirrors the Library page's copy. The same `.library-search*` styles drive the input on both pages so the cross-page muscle memory is consistent.

**Resume hero card** — the most-recently-read entry from `continue_reading[0]` is promoted out of the Continue Reading ribbon into a hero card directly under the navbar. The card shows the cover, title, current-chapter label, page number, a progress bar, and two CTAs: *Resume reading* (deep-links into `/read/:chapterId?mangaId=&page=`) and *Open detail*. The remaining `continue_reading` rows still render in the Continue Reading ribbon below. Hidden when no progress row exists.

**Ribbons** (in order; empty ribbons are omitted from the render):

1. **Continue Reading** — remaining manga with a `progress` row after the hero card consumes the first entry, newest `last_read_at` first. Each tile shows the cover, title, current-chapter label (respects `track_volumes`), and a thin progress bar along the bottom of the cover proportional to `completed_count / total_chapters`.
2. **Recently Added** — newest manga rows by `created_at DESC`, visible libraries only. Header carries a *See all* link to the Library page.
3. **Discover New Series** — unread manga tagged with at least one of the reader's top 4 favourite genres (favourites computed exactly as on the Statistics page, but scoped to visible libraries only). Server returns the top ~30 candidates ranked by `(match_count DESC, score DESC NULLS LAST)`; the client picks a stable seeded-random 15-item slice and re-seeds on a user-chosen cadence (see *Discover refresh cadence* below). The ribbon header exposes a **Surprise me** button (navigates to a random unread title from the candidate pool) and a manual **Refresh** button that shuffles immediately without waiting for the next interval.
4. **Art Gallery** — every page the user has bookmarked via the *Add to Art Gallery* button in the reader. Implemented as [components/ArtGalleryRibbon.jsx](../client/src/components/ArtGalleryRibbon.jsx), `React.lazy`-loaded so it doesn't block the initial Home bundle — a CSS keyframe animation auto-scrolls the track at a pace proportional to item count, with the track content duplicated so the keyframe can loop seamlessly at translateX(-50 %). The animation pauses on mouse hover, keyboard focus-within, and during touch drags; an `IntersectionObserver` also pauses it when the ribbon is off-screen so a background tab burns zero GPU cycles. `@media (prefers-reduced-motion: reduce)` disables the animation entirely and exposes a native scroll instead.
5. **Top Manga in XXX** — one ribbon per favourite genre (up to 4). The server returns a candidate pool of every manga in the genre whose AniList/MAL score is `>=` the `home_genre_score_threshold` preference (default 7, configured in Settings → Homepage Settings, read via `useUserPref`). The client shuffles each pool with `discoverSeed XOR hash(genre)` and slices to ~15 visible — so each genre rotates independently and all genre ribbons re-shuffle on the same cadence as Discover (manual *Refresh* / Settings *Reshuffle now* buttons rotate both at once). Each tile shows the cover, title, and AniList/MAL score in the corner. Header carries a *See all* link that navigates to `/library` with the genre name pre-filled in the search box (passed via `location.state.search`).

**Performance notes** — every cover `<img>` carries explicit `width`/`height` to reserve layout space (no CLS as covers stream in), and the first tile in each ribbon plus the hero cover use `loading="eager"` + `fetchpriority="high"` so the LCP image isn't lazy-loaded. Tile components are wrapped in `React.memo`. While `/api/home` is in flight, a skeleton scaffold (pulsing tiles + hero placeholder) replaces the previous spinner so first paint is immediate. Sidebar fetches (`getLibraries` / `getReadingLists`) are deferred via `requestIdleCallback` so they don't compete with `/api/home` for the first network slot.

**Discover refresh cadence** — the visible Discover slice is deterministic for a given seed (uses a Mulberry32 PRNG seeded from a 32-bit integer in the device-local `home_discover_seed` `localStorage` key). On mount, Home checks the device-local `home_discover_last_refresh` stamp against the `home_discover_refresh_ms` **server preference** (set in Settings → Homepage Settings, default 24 h; read via `useUserPref`). If the window has elapsed, a fresh seed is generated and the last-refresh stamp is updated. `Manual only` (interval = 0) disables automatic rotation entirely; the user can still press **Refresh** or tap **Reshuffle now** in Settings.

**Component structure:**

- [components/Ribbon.jsx](../client/src/components/Ribbon.jsx) — generic horizontal ribbon with a title, optional action slot, disabled-aware left/right scroll arrows, and a CSS `scroll-snap-type: x proximity` track. Native scroll drives touch momentum, trackpad swipe, and mouse wheel; the arrows are a mouse-user affordance and are hidden on `(hover: none)` and under 700 px via media query. Per-ribbon `contain: paint` means scrolling one ribbon never repaints another.
- [components/ArtGalleryRibbon.jsx](../client/src/components/ArtGalleryRibbon.jsx) — the auto-rotating variant described above.
- Tile markup is owned by Home.jsx (three variants: Continue-Reading tile with progress bar, generic MangaTile with score badge, gallery tile). All tiles reuse the `.ribbon-tile*` class family from [components/Ribbon.css](../client/src/components/Ribbon.css).

**Empty state** — when Continue Reading, Discover, Art Gallery, and all four genre ribbons are empty (fresh install with no reading history), Home renders a "Welcome to Momotaro" empty state that links to `/library`. Individual empty ribbons are suppressed from the layout rather than rendered as dead sections.

**PWA behaviour** — `/api/home` is registered under the `browse-data` StaleWhileRevalidate rule in the service worker (see *PWA caching strategy* below), so Home hydrates instantly from cache on every visit while a fresh response arrives in the background. The 30-second server-side cache absorbs the resulting burst of prefetches without extra DB load.

### Genres (`src/pages/Genres.jsx`)

Landing page at `/genres`. Renders the shared `AppSidebar` on the left and a responsive grid of **genre tiles** on the right (one tile per distinct genre across visible libraries). Data comes from a single `GET /api/genres` fetch — see [api.md § Genres](./api.md#genres).

Each tile is a `<button>` (so it stays keyboard-navigable) decorated with a **faded thumbnail** of the highest-scored manga in that genre — the cover is positioned `inset: 0`, `object-fit: cover`, `opacity: 0.22`, with a slight grayscale + blur and a bottom-weighted gradient overlay for label contrast. The thumbnail is purely decorative (`alt=""`, `aria-hidden="true"`, `pointer-events: none`); the button label is the genre name plus the manga count.

Clicking a tile calls `navigate('/library', { state: { search: genre } })`, which Library reads on mount and seeds into its search box. Single-term search resolves to an exact (case-insensitive) genre match server-side via the normalised `manga_genres` table — see [api.md § Search](./api.md#search-search) — so the existing search route is the only filter mechanism; no separate "filter by genre" code path was added.

Empty / loading / error states mirror the rest of the app: a skeleton grid replaces the tiles before data arrives, an inline error block surfaces failures with a Retry button, and a "No genres yet" state appears when the library has no tagged metadata.

### ArtGallery (`src/pages/ArtGallery.jsx`)

Landing page at `/art-gallery`. Renders the shared `AppSidebar` plus, on the right, one `ArtGalleryRibbon` per series the user has bookmarked pages for. Data comes from `api.getAllGallery()` (returns `[{ manga, items: [...] }]`). Unlike the Home Art Gallery ribbon, the tiles here use the page's natural aspect ratio (no cropping) so landscape spreads display correctly. Empty / error / loading states mirror the rest of the app.

The sidebar shortcut to this page is rendered by `AppSidebar` directly below the Reading Lists section.

### ThirdPartySourcing (`src/pages/ThirdPartySourcing.jsx`)

Page at `/third-party-sourcing`. Implements the four-pane UI for picking a third-party source, searching, picking chapters, and watching the download queue — see [sources.md § UI entry point](./sources.md#ui-entry-point) for the full breakdown. The sidebar shortcut sits below the Art Gallery entry in `AppSidebar`. When opened with `?manga_id=N`, the page reads the query param, pre-fills the search box with the manga's title, locks the target to mode='existing' + that manga, and auto-runs the search — driven from the *Find more sources* button in MangaDetail's *Third Party Sources* modal.

### Library (`src/pages/Library.jsx`)

- Loads manga via `GET /api/library`
- Sidebar filter by library or reading list
- Search bar with 300 ms debounce — matches against title, **author/artist name** (whole-word, case-insensitive via FTS5), or genre (exact, case-insensitive). Multi-word input is implicit AND on title/author. Comma-separated terms filter by all listed genres simultaneously. See [api.md § Search](./api.md#search-search) for full semantics.
- Sort by: A–Z, recently updated, year, **rating** (AniList/MAL `score`, descending; unrated manga sink to the bottom ordered alphabetically)
- **Default sort** comes from the `home_default_sort` server preference read via `useUserPref` (set via Settings → Homepage Settings; valid values `title` \| `updated` \| `year` \| `rating`, defaults to `title`). Falls back to `title` if the stored value is missing or unrecognised. Changing the sort from the top bar does not update the persisted default — use Homepage Settings for that.
- Scan button triggers `POST /api/scan`
- Click manga card → navigate to `/manga/:id`
- **Filter initialisation from navigation state** — on mount, `activeLibrary` and `activeList` are seeded from `location.state.library` and `location.state.list` (React Router state), and `search` is seeded from `location.state.search`. This allows the MangaDetail nav drawer to navigate back to a specific library or reading list without URL parameters, and lets the Home page's *See all* links on the genre ribbons pre-fill the search box with the genre name.
- **First-time setup state**: when no libraries are configured (`libraries.length === 0`) and no search or list filter is active, shows a "Welcome to Momotaro" prompt with a button that navigates to Settings → Library Management tab
- **Libraries sidebar section**: shown whenever at least one library exists (`libraries.length > 0`). The **All Libraries** aggregate entry is only shown when there are two or more libraries — with a single library it is omitted as redundant.

**Loading & error UX:**

- **Initial-load skeleton** — until the first `GET /api/library` response arrives, the page renders a grid of placeholder cards matching the live `.manga-grid` layout (with a count-line placeholder above) so vertical real-estate is reserved before first paint. Replaces the prior spinner-only state. The skeleton classes (`.skeleton-block`, `.skeleton-line`, `.skeleton-tile`) are shared with Home — `Library.jsx` imports `Home.css` for that reason.
- **Hold-during-refetch** — sort changes, search keystrokes, and library/list switches keep the current grid visible (subtly dimmed via `.library-grid-wrap.is-refetching { opacity: 0.6 }`) instead of blanking to the spinner. Empty / error states only replace the grid when there is no data to show.
- **Inline error banner** — when a refetch fails over an existing grid (e.g. the network drops during a search), the error surfaces as a red banner (`.library-inline-error`) above the unchanged grid with a Retry button. Initial-load failures still show the full-page error treatment.
- **Off-screen card skipping** — `.manga-card` carries `content-visibility: auto` + `contain-intrinsic-size: 0 320px`, so the browser skips layout / paint for cards outside the viewport on long grids. In-page find (Ctrl+F), screen readers, and tab navigation are unaffected. Browsers without support (Safari < 18) fall back to standard rendering.

**Cursor pagination (all four sorts):** the browse grid and the search grid both page via keyset cursors for `title`, `updated`, `year`, and `rating` (a reading-list filter falls back to the unbounded one-shot fetch — that endpoint has no cursor support). `supportsCursorPagination(sort, activeList)` in [Library.jsx](../client/src/pages/Library.jsx) gates this; `PAGE_SIZE = 200` per page, fetched on demand by `VirtualizedMangaGrid`'s `onEndReached`. Appended pages are de-duped by `id` (`appendUnique`) so a row shifted across the cursor boundary by a concurrent metadata change (more likely on the volatile `score` / `year` keys) can't mount two cards under the same React key. Because of pagination the count line reads `N+ series` until the grid is fully scrolled.

**A–Z quick-jump rail:** at 10 k series, scrolling to a title is impractical even windowed, so a vertical letter rail ([components/LetterJumpRail.jsx](../client/src/components/LetterJumpRail.jsx)) floats at the right edge in browse mode. It renders **only under the `title` sort and the cursor-browse path** (`activeList === null`) — an alphabetical anchor has no meaning under `updated` / `year` / `rating` or inside a reading list. Clicking a letter sets `seekLetter`, which flows into the `?seek=` param on the page-1 fetch (see [api.md § Quick-jump letters](./api.md#quick-jump-letters-seek--apilibraryletters)); the server anchors the grid at that letter's block and `onEndReached` keeps paging forward from the returned cursor. This is a **forward anchor** (you scroll down from the letter; re-clicking the active letter clears it back to the top), not a scroll-to — a true scroll-to would have to load every intervening page, defeating the windowing. The rail dims letters with no titles using the bucket set from `GET /api/library/letters` (fetched per `library_id`); a failed/absent fetch leaves every letter enabled rather than blocking navigation. `seekLetter` is threaded into `browseCountKey` and `scrollKey` so each anchored view gets its own snapshot + scroll-restore identity, and is persisted to `sessionStorage` keyed by `location.key` so the back-from-detail remount restores the anchored view (component `useState` would otherwise reset it). Switching sort or library/list clears the anchor. The rail hides under `460px` viewport height where 27 legible pips don't fit.

**Deep-scroll restore (back-from-detail):** restoring a deep scroll position needs the full row set rebuilt before `useScrollPosition` is armed — otherwise the virtualizer's total height is one page tall when the saved `scrollTop` is applied and the user is clamped to the end of page 1. Two layers handle this:

- **In-session snapshot (fast path).** Back-from-detail is a component remount, not a page reload, and `location.key` is stable across the round-trip. A module-scoped `Map` (`browseSnapshots` in [Library.jsx](../client/src/pages/Library.jsx), keyed by `browseCountKey`) holds the settled `{ rows, cursor, hasMore }` for each recently-viewed browse view. On remount `load()` restores it synchronously — **zero network, instant paint**, with the cursor preserved so `onEndReached` keeps paging seamlessly. The cache is a bounded insertion-order LRU (`putSnapshot` / `getSnapshot`, cap `SNAPSHOT_CACHE_MAX = 6`) since each entry can hold thousands of slim rows, and entries carry a `ts` checked against `SNAPSHOT_TTL_MS = 90 s` (kept close to the server listing cache's 30 s TTL) so returning to a view after an idle re-pulls fresh data instead of restoring a stale grid — bounding the restored grid's staleness (e.g. an edited title/cover) to the app's existing listing-freshness contract. A pure re-store (same row reference, e.g. right after a restore) is skipped so the TTL keeps reflecting the original fetch time.
- **Serial refetch (cold-cache fallback).** When the snapshot has been LRU-evicted but the `sessionStorage` depth (`library-count:<key>`, keyed identically to the scroll position) still exists, `load()` re-fetches sequentially up to that depth (bounded by `REHYDRATE_MAX_PAGES = 60`) before revealing the grid. This is the pre-snapshot behaviour, retained only for the eviction edge case.

The pagination + snapshot helpers (`appendUnique`, `browseCountKey`, `shouldPersistDepth`, `rehydrateTarget`, `getSnapshot`, `putSnapshot`) live in [libraryPagination.js](../client/src/pages/libraryPagination.js) so they're unit-tested without a React harness — see [client/test/libraryPagination.test.mjs](../client/test/libraryPagination.test.mjs).

### MangaDetail (`src/pages/MangaDetail.jsx`)

- Shows cover, metadata (title, author/artist, status, year, genres, score, description)
  - `author` is displayed below the title when present; the element is omitted entirely when `manga.author` is falsy
- Chapter list — sorted by `COALESCE(number, volume) ASC NULLS LAST, folder_name ASC` as the canonical **reading order**, then reversed for display so the highest chapter/volume appears on top. By default only the first 5 rows (the newest 5 chapters) are rendered; a **Show all N chapters** button at the bottom of the list toggles the full view and swaps to **Show less**. The word *chapters* becomes *volumes* automatically when `manga.track_volumes` is set. The *Continue Reading* fallback still uses the ascending reading order so starting from scratch jumps to chapter 1, not the newest entry.
- **Mark chapter as read / unread** — every row exposes a toggle button that calls `PATCH /api/progress/:mangaId/chapter/:chapterId` with `{ completed: true | false }`. When a chapter is marked read, the server advances `current_chapter_id` past it only if the existing current chapter is at or behind the marked one, so bulk-marking several chapters leaves *Continue Reading* pointing at the first genuinely unread chapter. Updates are applied optimistically and then reconciled with the server response.
- Chapter display label logic:
  - `vol !== null && number !== null` → `Vol. N Ch. N`
  - `vol !== null` → `Volume N`
  - `number !== null` → `Chapter N` (or `Volume N` if `track_volumes`)
  - fallback → `folder_name`
- **Art Gallery** — a grid of user-bookmarked pages rendered at the bottom of the page, below the chapter list. Populated via the *Add to Art Gallery* button in the reader (see [reader.md](./reader.md)). The grid is `repeat(auto-fill, minmax(140px, 1fr))` with each tile showing the page thumbnail (aspect-ratio 2/3, `object-fit: cover`), a label with the chapter/volume string and the 1-based page number, and a circular ✕ remove button overlayed in the top-right corner. The ✕ is hidden on desktop until hover/focus, and always visible on touch devices via `@media (hover: none)`. Clicking a tile navigates to `/read/:chapterId?page=<page_index>&mangaId=<id>` so the user lands on the exact page. Data comes from `GET /api/manga/:id/gallery`, which is fetched once on mount and kept in component state; removal goes through `DELETE /api/manga/:id/gallery/:itemId`. When the list is empty the section shows a hint pointing the user at the reader button.
- **Nav drawer** — hamburger button (☰) in the navbar opens a slide-in drawer listing all libraries and reading lists. Clicking an entry navigates to `/` and passes `{ library: id }` or `{ list: id }` in React Router location state, which `Library` reads on mount to pre-select the filter.
- **More Info button** — opens a modal that fetches `GET /api/manga/:id/info` and displays the manga's filesystem path, chapter count, folder size in MB, and a **missing chapters/volumes** report (gaps in the `1..max` sequence, switching axis with `track_volumes`). The endpoint walks the folder on demand so the figures reflect the disk's current state, not the last scan rollup. The request is made lazily on first open and the result is cached for the lifetime of the page.
- **Metadata button** opens a modal with a **Source dropdown** (AniList / MyAnimeList / MangaUpdates / Doujinshi.info, defaults to AniList). Each source exposes the same two actions:
  - *Fetch* — auto-fetch by title (`refresh-metadata`, `refresh-mal-metadata`, `refresh-mangaupdates-metadata`, or `refresh-doujinshi-metadata`)
  - *Search Manually* — opens a search modal (`AnilistSearchModal`, `MALSearchModal`, `MangaUpdatesSearchModal`, or `DoujinshiSearchModal`)
- AniList search modal → `GET /api/anilist/search?q=` → `POST /api/manga/:id/apply-metadata`
- MyAnimeList search modal → `GET /api/mal/search?q=` → `POST /api/manga/:id/apply-mal-metadata`
- MangaUpdates search modal → `GET /api/mangaupdates/search?q=` → `POST /api/manga/:id/apply-mangaupdates-metadata`
- Doujinshi.info search modal → `GET /api/doujinshi/search?q=` → `POST /api/manga/:id/apply-doujinshi-metadata`
- **Local-metadata behavior** — when `metadata_source === 'local'`, *Fetch* and *Search Manually* perform a **link-only** write on the server: only the external ID and the source-specific cover column are stored so the user's local-JSON metadata fields (title, description, genres, etc.) are preserved. Whether the visible cover changes depends on the cover-priority resolver — if the new source ranks above any source already on the manga, the next reinforcement pass will swap the active cover. See [api.md § Linkage and display priority](./api.md#linkage-and-display-priority) and [scanner.md § Cover Priority](./scanner.md#cover-priority).
- The status badge in the modal reflects the current source: "Local file", "Linked to AniList", "Linked to MyAnimeList", "Linked to MangaUpdates", "Linked to Doujinshi.info", or "No metadata linked". Each linked-source badge links out to the corresponding upstream page (`anilist.co/manga/{anilist_id}`, `myanimelist.net/manga/{mal_id}`, `mangaupdates.com/series.html?id={mangaupdates_id}`, or `doujinshi.info/book/{doujinshi_id}`).
- **Export as JSON** — every source tab exposes its own *Export as JSON* row whenever the corresponding linkage exists on the manga (`anilist_id`, `mal_id`, `mangaupdates_id`, or `doujinshi_id`), independent of which source is currently displayed. Clicking *Export* calls `POST /api/manga/:id/export-metadata` with `{ source: '<src>' }`, which reads the previously-cached record from `data/metadata-cache/<source>/<id>.json` (or the manga row as a fallback) and writes a `metadata.json` sidecar to the manga's folder. **Export never re-pings any upstream** — if no cached data is available for the requested source the endpoint returns 409 with a hint to refresh first. **Any existing `metadata.json` is unconditionally overwritten** when export succeeds. The exported JSON's `metadata_source` field reflects the source the export was issued for, not the manga's row-level `metadata_source`. Result is shown as a success or error message inside the modal.
- **Break Linkage (Metadata modal)** — whenever the currently-selected source dropdown has a matching linkage on the manga (e.g. dropdown is set to AniList and `manga.anilist_id != null`), a danger-styled *Break* button appears at the bottom of the modal. The button is visible even when the manga's `metadata_source` is `'local'` or a *different* third-party source — so an AniList-tracked manga displaying local-JSON metadata can still have its AniList link removed without disturbing the local fields. The button description changes based on what will happen: *"All fetched metadata will be cleared"* when the selected source is the current display source, or *"Your existing metadata will be preserved — only the link is removed"* otherwise. Calls `POST /api/manga/:id/reset-metadata` with `{ source: 'anilist' | 'myanimelist' | 'mangaupdates' | 'doujinshi' }` — see [api.md](./api.md#reset-metadata) for the full-reset vs link-only semantics.
- **Break Linkage (AniList tracking panel)** — a secondary *Break Linkage* button also appears directly below the *View on AniList ↗* link in the `AnilistStatusPanel` whenever `manga.anilist_id` is set. This lets the user detach AniList from anywhere the tracking panel is visible without opening the Metadata modal. After a successful break, the panel switches to the unlinked state (`{ logged_in: true, linked: false }`) and the cover thumbnail is cache-busted so any replaced cover is refreshed immediately.
- Progress badge on each chapter (read / current / unread)
- Resume reading button (jumps to last read chapter+page)
- **Clickable thumbnail** — the cover image has the `detail-cover-clickable` class and shows a "Change" hint overlay on hover. Clicking it opens the **Thumbnail Picker Modal**, which fetches `GET /api/manga/:id/thumbnail-options` and presents the available source covers in priority order, followed by previously-used and per-chapter options:
  1. **AniList** — `anilist_cover`, if available
  2. **MyAnimeList** — `mal_cover`, if available
  3. **MangaUpdates** — `mangaupdates_cover`, if available
  4. **Doujinshi.info** — `doujinshi_cover`, if available
  5. **Original** — the first-ever scan-generated thumbnail (`original_cover`), if available
  6. **Previously Used** — up to 20 entries from `thumbnail_history`, most recent first
  7. **Chapter Covers** — the first page (`page_index = 0`) of every chapter
  Selecting an option calls either `POST /api/manga/:id/set-thumbnail` with `{ saved_filename }` (for saved files) or `{ page_id }` (for chapter first pages). **Either form sets `manga.cover_user_set = 1`**, which sticks the user's choice against subsequent metadata fetches — only the **Reset Thumbnails** action (Settings → Database) and the post-scan reinforcement pass clear the flag and re-align the cover to the priority order. For CBZ-backed chapters, the server streams the single ZIP entry out of the archive and resizes it with `sharp` — the archive is never extracted to disk, so this works even at library sizes of several TB. On success, the active cover image is cache-busted by updating a `coverBust` timestamp appended to the thumbnail URL.
- **Mobile Settings dropdown** — on screens ≤ 640 px the individual *Metadata*, *Optimize*, and *More Info* buttons are replaced by a single **Settings** dropdown (class `detail-settings-wrap detail-mobile-only`). Tapping an item closes the dropdown then opens the relevant modal. On desktop the three buttons remain visible individually (class `detail-desktop-only`).
- **Mobile action-row icons** — on screens ≤ 640 px the four buttons in `.detail-actions` (*Continue Reading*, *Reset Progress*, *Settings*, *Lists*) collapse to icon-only via the `.detail-action-btn` / `.detail-action-icon` / `.detail-action-label` triple: each button renders both an inline SVG (double-chevron, circular-arrow refresh, gear cog, three-line list) and a `<span class="detail-action-label">` with the original text. Default CSS hides the icon and shows the label; the `≤ 640 px` media query inverts that, also hides the dropdown chevrons (`.rl-chevron`, `.detail-settings-chevron`), and tightens padding so all four buttons fit in one row. The Lists count badge (`.detail-action-count`, e.g. `· 2`) stays visible alongside the icon. `aria-label` and `title` attributes carry the accessible name regardless of which mode is active.

### Reader (`src/pages/Reader.jsx`)

See [reader.md](./reader.md) for full details.

URL: `/read/:chapterId?mangaId=<id>&page=<n>`

### Settings (`src/pages/Settings.jsx`)

`Settings.jsx` is a **slim tab router**: it owns the tab chrome, the `location.state.section` deep-link handling, and the active-tab state, then renders one section component per tab from [`src/pages/settings/`](../client/src/pages/settings/) (`AnilistSection`, `MyAnimeListSection`, `DoujinshiSection`, `LibrariesSection`, `HomepageSection`, `ReadingSection`, `DatabaseSection`, `SchedulingSection`, `ThirdPartySourcingSection`, `SystemLogsSection`, `StatisticsSection`, `ClientManagementSection`, `PortForwardingSection`, `AndroidSection`, `LinuxSection`, `OfflineDownloadsSection`, plus `OfflineLockedPanel`, `AdminAuthForms`, and the `nativeShell` helper). Each section is its own chunk, prefetched on sidebar hover. The behaviour of each tab is described below regardless of which file implements it.

- Accepts an optional `location.state.section` value on navigation to open a specific tab directly (e.g. the "Go to Library Management" button in the first-time setup state passes `{ section: 'libraries' }`)
- **Statistics tab**: overview of the manga library. When more than one library exists, a row of pill buttons (**All Libraries** plus one per library) appears above the tiles — selecting a library re-fetches `GET /api/stats?library_id=N` so every tile and ranked list switches to that scope. With a single library the switcher is hidden. Contents:
  - *Stat tiles* — Total Series, Total Chapters, Total Size, Total Genres, Estimated Read Time.
  - *Popular Series* — top 10 by chapters read.
  - *Popular Genres* — top 10 genres by number of series tagged with each (the library's genre inventory).
  - *Favorite Genres* — top 10 genres weighted by **reading history**. Each completed chapter contributes one point to every genre tagged on that chapter's manga, so a reader who has finished 40 chapters of a 3-genre series adds 40 to each of those three genres. Empty-state copy prompts the user to read some chapters when no progress exists. The three ranked lists use a `repeat(auto-fit, minmax(300px, 1fr))` grid so wide screens get 3 columns, typical laptops get 2, and mobile collapses to 1.
- **AniList tab**: enter client ID + secret, trigger OAuth flow; login state is per-device
- **MyAnimeList tab**: enter Client ID (no login required); stored server-wide. Shows "Client ID configured" when set, with a *Remove Client ID* button to clear it
- **Doujinshi.Info tab**: email + password login form; login state is server-wide (shared across all devices)
- **Libraries tab**: add, edit, delete library paths; trigger per-library scans. The page uses a wider content area (max-width 1100 px) to accommodate all action buttons on each library card. Each library card shows the following actions:
  - **Scan Now** — triggers `POST /api/libraries/:id/scan`
  - **Bulk Metadata Pull ▾** — shows a source dropdown (AniList / MyAnimeList / MangaUpdates / Doujinshi.info) before starting the pull. The bulk pull always runs over every title — already-linked titles are *refreshed by ID* against the chosen source while unlinked titles are *searched by cleaned title*. After the request returns, the status line summarises the split, e.g. *"Started: refreshing 38 already-linked titles and searching for 12 unlinked titles in the background."* See [api.md § Bulk Metadata Pull](./api.md#bulk-metadata-pull) for the full per-phase semantics and the title-cleaning rule set.
  - **Bulk Optimize** — converts chapters to CBZ and standardises filenames
  - **Export Metadata** — calls `POST /api/libraries/:id/export-metadata`, which writes a `metadata.json` sidecar file into every manga folder that has third-party metadata. Titles where `metadata_source === 'local'` but a third-party link exists (`anilist_id` / `mal_id` / `doujinshi_id`) are re-fetched from the linked source and the resulting JSON overwrites any existing `metadata.json`. The status line reports the total exported plus a count of `exported_local` titles that had their file overwritten with freshly-fetched third-party data. Because the endpoint may issue many upstream requests for large libraries, the client's per-request timeout is raised to 10 minutes for this call only. The exported files use field names that the local metadata scanner already understands, so a database reset followed by a rescan will re-import the metadata automatically.
  - **Edit** / **Delete** — rename or remove the library
- **Homepage Settings tab**: preferences that affect Home and the main library page. Each entry is a **server-synced, per-account preference** via [`PreferencesContext`](#context) (`useUserPref` / `setPref`) — stored on the server and synced across the account's devices, **not** per-browser `localStorage`. (The transient Discover reshuffle stamps — `home_discover_last_refresh`, `home_discover_seed` — stay device-local in `localStorage`; the preferences below do not.) The tab surfaces more entries than listed here (Discover quality threshold, excluded / favourite genres, minimum matching genres, library scope, candidate-pool / visible counts, ribbon order, resume hero, genre-ribbon count, recently-added window, art-gallery order); the three below are representative.
  - *Default sort order* — picker with A–Z (title) / Recently Updated / Year / Rating (AniList / MyAnimeList). Backed by the `home_default_sort` preference; `Library.jsx` reads it via `useUserPref` on mount.
  - *Discover refresh interval* — picker with Every 6 hours / Every 12 hours / Daily (default) / Weekly / Manual only. Backed by the `home_discover_refresh_ms` preference (value in ms, `0` = manual-only). `Home.jsx` reads it via `useUserPref` when deciding whether to re-seed the Discover shuffle. Changing it also clears the device-local `home_discover_last_refresh` stamp so lowering the cadence starts a fresh window immediately. A **Reshuffle now** button clears the stamp so Home picks a new seed on the next visit. The same seed (XORed with a per-genre hash) drives the *Top Manga in &lt;Genre&gt;* ribbons, so reshuffling rotates both at once.
  - *Genre ribbon rating threshold* — slider from `0` (any rating) to `10` in `0.5` steps, default `7`. Backed by the `home_genre_score_threshold` preference. Sent to `/api/home` as `min_score`; the server filters every per-genre ribbon's candidate pool to titles whose AniList/MAL `score >= threshold`. Titles with no rating are never included regardless of threshold.
- **Reading Settings tab**: defaults that the reader picks up on next open. Every entry is per-device (`localStorage`) and mirrored by the in-reader settings panel — last write wins. The tab is organised into four sub-groups: **General**, **Display**, **Paged Mode**, and **Advanced**. The Advanced sub-group has a one-to-one twin in the in-reader settings menu — see [reader.md § ReaderControls — Tabs](./reader.md#readercontrols--tabs). See [reader.md § Page-Turn Animations](./reader.md#page-turn-animations) and [reader.md § Edge Hints](./reader.md#edge-hints) for behavioural detail on the other groups.
  - *Reading Mode* / *Reading Orientation* — `localStorage.reader_readingMode` and `reader_orientation`.
  - *Page Transition* — picker with Off / Slide / Fade / Curl. Backed by `localStorage.reader_pageAnimation` (default `slide`). The legacy boolean `reader_animTrans` is migrated on first read (`true → 'slide'`, `false → 'off'`) and removed.
  - *Animation Speed* — slider from `0.5×` to `2×` in `0.25` steps, default `1×`. Backed by `localStorage.reader_pageAnimSpeed`. Surfaces as the CSS variable `--reader-anim-mult` on `.reader-page` and scales every transition's `animation-duration` via `calc()`. Disabled (and shows a hint) when *Page Transition* is `Off`.
  - *Show edge hints* — toggle backed by `localStorage.reader_edgeHints` (default off). When on, faint chevrons sit at the left/right tap zones; they fade for 1.5 s after every tap and hide while the settings panel is open, while zoomed in, or when controls are visible. The first reader open per device always shows a one-time pulse regardless of this toggle (tracked by `localStorage.reader_hintsSeen`).
  - *Gestures* / *Always Full Screen* — `localStorage.reader_gestures` and `reader_alwaysFS`.
  - *Background Color* / *Grayscale* — `localStorage.reader_bgColor` and `reader_grayscale`.
  - *Scale Type* / *Page Layout* — `localStorage.reader_scaleType` and `reader_pageLayout`.
  - **Reset reader hints** — clears `localStorage.reader_hintsSeen` so the one-time edge-hint pulse fires again on the next chapter open.
  - **Advanced sub-group** (three settings that affect server-side or background work — grouped so a user wanting to control resource usage can find them together):
    - *Preload upcoming pages* — `localStorage.reader_prefetchPages` (default on). Gates the in-chapter image warm-up in [useReaderPrefetch.js](../client/src/hooks/useReaderPrefetch.js).
    - *Fast chapter open* — `localStorage.reader_fastChapterOpen` (default off, opt-in). When on, the reader's `getPagesWithMeta` call sends `?fast=1` so the server returns after Phase 1 (~1–3 s) and continues extracting the rest of the CBZ in the background. The reader's page-image requests (`ReaderPaged`/`ReaderScroll` and the prefetch warm-ups) **also** carry `?fast=1` while this setting is on — so each image streams via the per-page wait path rather than blocking on the full chapter extraction. `api.pageImageUrl(id, { fast })` builds those URLs; non-reader callers (cover thumbnails, the offline downloader) omit the flag and keep the legacy full path. See [scanner.md § Fast mode](./scanner.md#fast-mode-first-page-fast).
    - *Pre-load next chapter* — `localStorage.reader_predictNextChapter` (default migrated from `reader_prefetchPages` on first read; independent thereafter). Gates the near-end-of-chapter prefetch in `useReaderPrefetch`. When combined with *Fast chapter open*, the prefetch routes through the fast-mode endpoint so navigating to the next chapter lands on a near-instant cache hit.
- **Database tab**: maintenance operations for the server's database and on-disk cache:
  - *CBZ Cache* — displays the current cache size alongside the configured cap (e.g. `1.4 GB / 20.0 GB`). **Clear Cache** deletes every extracted chapter directory in `CBZ_CACHE_DIR` (pages are re-extracted on next access). Below the current-size row, an expanded block exposes:
    - *Maximum cache size* — numeric input in GB. Saved value is persisted as `cbz_cache_limit_bytes` in the `settings` table and applied live via `cbzCache.setLimitBytes()` — any chapters over the new cap are evicted immediately.
    - *Auto-clear schedule* — segmented control (Off / Daily / Weekly). **Weekly** reveals a day-of-week `<select>`; both Daily and Weekly reveal a `<input type="time">`. Times are interpreted in server local time. When enabled, a "Next auto-clear: …" status line shows the concrete next fire. Save button fires `PUT /api/admin/cbz-cache-settings` and refreshes the displayed next-run timestamp.
  - *Configuration Backup* — **Export** triggers a download of `momotaro-config-<iso-timestamp>.json` via `api.exportConfig()` (fetch + blob so the `X-Admin-Token` header rides along — a bare `window.location.href` navigation can't carry headers and the mount-line `requireAdmin` gate would 401). **Import** opens a hidden `<input type="file" accept="application/json">`, parses the JSON client-side (so malformed files fail fast), runs a destructive-action confirm dialog, then POSTs to `/api/admin/import-config`. The result is summarised inline as per-section insert counts (`N settings, N libraries, N manga, N lists, N memberships, N progress, N gallery`), and any warnings are listed in a collapsible `<details>` block. See [api.md § Configuration Backup](./api.md#configuration-backup) for the JSON format and behaviour.
  - *Regenerate Thumbnails* — **Regenerate All** fires `POST /api/admin/regenerate-thumbnails`; the job runs in the background and the UI shows a confirmation with the total manga count. For each manga, the AniList cover is restored if available, otherwise a new thumbnail is generated from the first page of the first chapter.
  - *Reset Thumbnails* — **Reset Thumbnails** fires `POST /api/admin/reset-thumbnails` synchronously after a confirm dialog. Re-aligns every manga's active cover to the priority order **AniList → MyAnimeList → MangaUpdates → Doujinshi.info → original scan** and **overrides any manually-picked cover** (`cover_user_set` is reset to 0 across the board). No upstream is contacted — the operation only re-uses cover files already on disk from earlier metadata fetches. The status line breaks down the result per source (e.g. *"301 → AniList, 52 → MAL, 8 → MangaUpdates, 4 → Doujinshi, 18 → original; 49 had no source on disk"*). The same priority pass also runs automatically at the end of every library scan via the scanner — see [scanner.md § Cover Priority](./scanner.md#cover-priority).
  - *Compact Database* — **Compact Database** runs `POST /api/admin/vacuum-db` synchronously and displays the before/after file size
- **System Logs tab**: shows the server's in-memory log buffer (most recent 2000 entries of `console.log` / `info` / `warn` / `error`). Each row renders the ISO timestamp, level tag (colour-coded: accent for info, amber for warn, red for error), and message in a monospace viewer. Two actions:
  - **Refresh** — re-calls `GET /api/admin/logs` and repopulates the list
  - **Export as .txt** — calls `api.exportSystemLogs()` (fetch + blob with `X-Admin-Token` header) to download `momotaro-logs-<iso-timestamp>.txt`. Buffer is process-local and resets on server restart.

### AnilistCallback (`src/pages/AnilistCallback.jsx`)

Landing page for the AniList OAuth redirect. Extracts `?code=` from the URL, POSTs to `POST /api/auth/anilist/exchange`, then redirects to `/settings` on success.

### Login (`src/pages/Login.jsx`)

Two-tab Log in / Create account screen reached when the server's
`/api/admin/auth-status` reports `user_required`. Surfaces live
`attempts_remaining` and the 24 h lockout countdown driven by structured
error bodies returned from `POST /api/users/login` (5-strikes-→-24h
device lockout). Styled with the pairing-wizard primitives (`pw-*`) plus
tabs in `Login.css`. See [User Accounts & Login](#user-accounts--login).

### Downloads (`src/pages/Downloads.jsx`)

Top-level downloads-management page mounted at `/downloads` via the lazy
route in [App.jsx](../client/src/App.jsx). Two tabs:

- **Queue** — every job (queued, running, failed, cancelled, plus
  `done` within the last day) from the persistent downloader
  ([client/src/api/downloader.js](../client/src/api/downloader.js)).
  Rows show progress / failure reason / cancel / retry; the page
  subscribes via `onDownloaderChange` so state updates push live.
- **Library** — every series with at least one downloaded chapter,
  pulled from `listOfflineManga` ([client/src/api/offlineDb.js](../client/src/api/offlineDb.js)).
  Per-series delete and per-chapter delete go through the downloader's
  delete helpers so the IndexedDB index, filesystem files, and queue
  references all stay consistent.

`useConnectivity()` gates "Resume downloads" buttons: with `wifiOnly =
true`, a queued job only runs while the device is on Wi-Fi, so the page
also surfaces a "waiting for Wi-Fi" hint on running rows. See
[offline.md](./offline.md) for the offline subsystem architecture.

## User Accounts & Login

Multi-user accounts ship in the user-accounts release (see
[user-accounts.md](./user-accounts.md)). The server flag `multi_user_enabled`
defaults to **on**; with it on, each device must log in or create the owner
account before reaching the library.

- **[client/src/pages/Login.jsx](../client/src/pages/Login.jsx)** — two-tab
  Log in / Create account screen, with live `attempts_remaining` and a 24 h
  lockout countdown driven by structured error bodies from
  [api/client.js](../client/src/api/client.js). Styled with the pairing-wizard
  primitives (`pw-*`) plus tabs in `Login.css`.
- **[client/src/context/UserContext.jsx](../client/src/context/UserContext.jsx)**
  (`UserProvider`, `useUser()`) — holds the logged-in user, hydrates from
  `GET /api/users/me` on mount, exposes `login` / `register` / `logout`.
  Identity only; independent of connectivity and pairing.
- **FirstLaunchGate** ([App.jsx](../client/src/App.jsx)) — after the existing
  `pairing_required` check, redirects to `/login` when the server reports
  `user_required`. Caches `multi_user_enabled` in `localStorage` so the
  offline branch can require a stored user token on multi-user installs.
- **API client** ([client.js](../client/src/api/client.js)) attaches
  `X-User-Token` on every request alongside the device + admin tokens, and
  exposes `register` / `login` / `logout` / `getMe` (login/register persist
  the session token + `momotaro_active_user_id`).
- **Settings → Account** ([components/AccountSection.jsx](../client/src/components/AccountSection.jsx))
  — the current user, Log out, **Change password** form (current / new / confirm with an inline status line — `PUT /api/users/me/password` revokes every other session and the helper persists the fresh token returned for the calling device), **Export your data** (two buttons: reading lists `.csv`, reading history `.csv`), then the live reading-history timeline + Clear history. Both CSV downloads go through the `_userDownload` helper (fetch + blob + synthetic `<a download>`) since `requireUser` is header-only and a `window.location.href` navigation would 401.
- **Settings → Client Management** (admin) renders
  [components/UserManagementBlock.jsx](../client/src/components/UserManagementBlock.jsx):
  multi-user / allow-registration toggles, create-account form, roster with
  per-user actions (Export / Reset PW / Force sign-out / Disable / Delete),
  all-users reading-history CSV download, login-lockouts list + clear.

**Per-user resume keys.** `localStorage` keys produced by
[utils/readingProgress.js](../client/src/utils/readingProgress.js) are
namespaced `momotaro_resume_<userId>_<mangaId>` so two users on one device
don't clobber each other's intra-chapter resume page; pre-upgrade un-namespaced
keys are migrated lazily on first read.

**AniList is per-user.** Each Momotaro account links its own AniList; the
client-side AniList flow ([AnilistCallback.jsx](../client/src/pages/AnilistCallback.jsx))
needs no code change — `X-User-Token` is auto-attached. See
[anilist.md](./anilist.md).

The legacy `momotaro_device_id` is still set (used as forensic telemetry by
the connection log) but no longer scopes AniList; the device UUID can be
cleared safely without affecting login state:

```js
localStorage.removeItem('momotaro_device_id')
```

## Navbar Logo

The "Momotaro" logo (`/logo.png`) appears in the navbar of every page as a `<Link to="/">` element. Clicking it always navigates to the root route, resetting any active library or reading list filter. The CSS class `.navbar-brand` / `.navbar-logo` controls sizing (40 px tall, width auto).

## Components

### `MangaCard`

The grid tile rendered by Library and by Home's search-results view. Reads only `cover_url` (with `cover_image` as fallback for legacy callers), `title`, `year`, `score`, and `status` off the row.

- Cover image (thumbnail URL) with a colour-coded **status badge** (top-left, hidden when `status` is missing or `UNKNOWN`) and an AniList/MAL **score badge** (bottom-right, ★ + 1-decimal, hidden when `score` is null)
- Title (clamped to 2 lines)
- Year (when present)

**Performance hints** — the cover `<img>` carries `width={300}` / `height={450}` (matching the 2:3 aspect of generated thumbnails), `loading="lazy"`, `decoding="async"`, and `draggable={false}`. The width/height attributes are a layout hint only — CSS `width: 100%; height: 100%; object-fit: cover` still drives painted size. Together with `content-visibility: auto` on `.manga-card` (see *Library Loading & error UX* above), this keeps long grids cheap to scroll and eliminates layout shift as covers stream in.

**Memoization** — the component is wrapped in `React.memo` with a custom equality check that compares only the slim row fields the card actually renders (`id`, `title`, `year`, `score`, `status`, `cover_image`, `cover_url`). Library renders the entire grid up front (potentially thousands of cards), so without memoization any sibling state change — opening a sidebar drawer, focusing the search input, sort changes, refetch settling — re-renders every card, which on mobile is heavy enough to cause a perceived freeze. The custom comparator avoids the per-render allocation footprint of the default shallow check and ignores fields that aren't part of the rendered output.

### `ReaderPaged` / `ReaderScroll` / `ReaderControls`

See [reader.md](./reader.md).

### `InstallPrompt`

Mounted once at the root of `App.jsx` outside `<Routes>` so it persists across navigation. Self-gating — only renders on mobile viewports, hides itself when the app is already running standalone (PWA installed), and suppresses on the reader route to keep the bottom of the screen clear for taps.

### `UpdateBanner`

Mounted alongside `InstallPrompt` at the App root. Renders only inside the Capacitor native shell — `useAppUpdateCheck` gates on `Capacitor.isNativePlatform()`, so the PWA never sees it. Polls `GET /api/app/version` on mount; when the server's reported version differs from the bundled [`APP_VERSION`](../client/src/version.js), surfaces a bottom-fixed card with the release notes and an "Update" button that's a plain `<a target="_blank">` to the APK URL — Android handles the download + install prompt from there. Dismissal is per-version (stored in `localStorage[momotaro_dismissed_update_version]`), so the same release won't keep re-nagging. Reuses the [`InstallPrompt`](../client/src/components/InstallPrompt.css) CSS for visual consistency. Hidden on `/read/:chapterId` for the same reason `InstallPrompt` is. See [android.md § Self-hosted distribution](./android.md#self-hosted-distribution).

### `VirtualizedMangaGrid`

Windowed grid renderer used by Library when the result set grows large enough that mounting every `MangaCard` becomes expensive even with `content-visibility: auto`. Reads grid column count from the `useGridColumnCount` hook (which observes the container's actual width through `ResizeObserver`) and uses `useScrollPosition` to map the visible viewport onto a slice of the manga array.

### `LetterJumpRail`

Vertical A–Z quick-jump rail ([components/LetterJumpRail.jsx](../client/src/components/LetterJumpRail.jsx)) rendered by Library in browse mode under the `title` sort. Props: `active` (the anchored letter, or null), `available` (a `Set` of present buckets `#`/`A`..`Z`, or null to enable all), `onSelect(ch)`. Pure presentation — the `?seek=` fetch, snapshot/scroll keying, and `sessionStorage` persistence all live in `Library.jsx` (see *A–Z quick-jump rail* under the Library page above). Letters outside `available` render disabled. Fixed to the right edge with a translucent backdrop; hidden under `460px` viewport height.

### `ArtGalleryRibbon`

Shared between the Home Art Gallery ribbon and the dedicated `/art-gallery` page. The Home variant auto-scrolls via a pure-CSS keyframe (pauses on hover/focus/touch/off-screen/`prefers-reduced-motion`); the standalone-page variant is rendered statically per series with natural-aspect-ratio tiles.

### `AdminTaskBanner`

Top-of-app banner that surfaces long-running admin tasks the operator
triggered (typically in another tab or device). Polls
`GET /api/admin/tasks/list` every 5 s while an admin token is in
`localStorage` and the tab is visible, then renders a fixed banner when
any *degrading* task (`vacuum-db`, `clear-cbz-cache`, `reset-thumbnails`)
is in `running` state. Non-degrading tasks (`regenerate-thumbnails`,
`optimize-manga:*`, `bulk-optimize-library:*`) are tracked in their own
per-card UIs and are deliberately not surfaced here. Renders nothing for
non-admin paired clients. See [api.md § Async admin tasks](./api.md#async-admin-tasks).

### `AccountSection`

The "Account" sub-section inside Settings, rendered by
[components/AccountSection.jsx](../client/src/components/AccountSection.jsx).
Shows the currently logged-in user, **Log out**, a *Change password*
form (current / new / confirm with an inline status line — `PUT
/api/users/me/password` revokes every other session and the helper
persists the fresh token returned for the calling device), *Export your
data* (two CSV buttons: reading lists, reading history), then the live
reading-history timeline + *Clear history*. Both CSV downloads route
through the `_userDownload` helper (fetch + blob + synthetic `<a
download>`) since `requireUser` is header-only and a `window.location.href`
navigation would 401. In single-user / pre-accounts mode (no logged-in
user) the section collapses to a "Log in or create an account" link.

### `UserManagementBlock`

Admin "User accounts" panel rendered inside Client Management
([components/UserManagementBlock.jsx](../client/src/components/UserManagementBlock.jsx)).
Drives the multi-user / allow-registration toggles, create-account form,
roster with per-user actions (Export / Reset password / Force sign-out /
Disable / Delete), all-users reading-history CSV download, and the
login-lockouts list + clear button. All operations flow through the
admin user-management endpoints documented in
[api.md § Admin user management](./api.md#admin-user-management-admin-only).

### `RibbonOrderEditor`

Edits the Home page's ribbon order + visibility — used by Settings →
Homepage Settings → *Layout*. Value shape is
`[{ id: string, visible: boolean }, …]`. Each row carries a visibility
toggle and ↑ / ↓ buttons; drag-and-drop is deliberately omitted in v1 to
keep the bundle lean (the ↑ / ↓ buttons are also keyboard- and
screen-reader-friendly by default). Unknown / missing ribbon ids are
reconciled at render time so adding a new ribbon in the future doesn't
strand users whose persisted order predates it: any id from the
canonical set that's missing from `value` is appended in its default
position. Persists to `home_ribbon_order` in [`PreferencesContext`](#context).

### `GenreChipPicker`

Multi-select chip picker for genre names, used by Settings → Homepage
Settings for both the Discover *Excluded genres* blacklist and the
Manual *Favorite genres* picker (same UI, different role — controlled by
the `mode` prop). Fetches once from `GET /api/genres`. When `max` is
set, every unselected chip is disabled once the cap is reached, so the
user frees a slot by removing a selection rather than the picker silently
evicting the oldest. `mode = 'exclude'` toggles a CSS hook so excluded chips render
struck-through vs filled. Persists to `home_discover_excluded_genres` /
`home_favorite_genres_manual` in [`PreferencesContext`](#context).

### `AppSidebar`

Shared left-rail sidebar rendered by Home, Library, Genres, ArtGallery, and ThirdPartySourcing. Contents, top to bottom:

- **Home** shortcut (always present) — `<Link to="/">` with a house icon.
- **Libraries** — each configured library (with manga count) and, when there are ≥ 2, an **All Libraries** aggregate entry.
- **Reading Lists** — every list with an inline `+` affordance to create a new one and `×` to delete non-default lists.
- **Browse By Genre** shortcut — `<Link to="/genres">` rendered below the Reading Lists section. Always visible regardless of library / list state.
- **Art Gallery** shortcut — `<Link to="/art-gallery">` rendered below Browse By Genre.
- **Third Party Sourcing** shortcut — `<Link to="/third-party-sourcing">` rendered below Art Gallery.

Selection is driven by optional `onSelectAll` / `onSelectLibrary` / `onSelectList` props. Library passes in-place setState callbacks; Home omits them, which causes the sidebar to navigate to `/library` with the chosen filter in React Router location state. List creation and deletion are managed inside the component itself, with `onReadingListsChanged` letting the host refetch counts afterwards.

Mobile behaviour is managed by the host via `drawerOpen` + `onCloseDrawer` props — the hamburger button on each page's navbar toggles `drawerOpen`, and the sidebar applies the slide-in transform when it's true. Styling uses the `.library-sidebar*` class family in [pages/Library.css](../client/src/pages/Library.css); Home imports that file explicitly so both pages share the exact same layout rules.

### `BottomNav`

Phone-only persistent navigation rail rendered by [components/BottomNav.jsx](../client/src/components/BottomNav.jsx), mounted once at the App root (outside `<Routes>`) so it survives route changes without re-mounting. Four tabs — **Home** (`/`), **Library** (`/library`), **Downloads** (`/downloads`), **Settings** (`/settings`) — each an inline-SVG icon + label.

- **Active-tab logic** — Home matches `/` exactly; the others match by prefix. `/manga/:id`, `/manga/:id/edit`, `/genres`, and `/art-gallery` are treated as part of the **Library** area so the Library tab stays lit when the user drills into a series. The `/library` exact-or-slash check avoids a false match against `/libraries` (the Library Management settings page).
- **Hidden routes** — the component returns `null` on any path under `/read/`, `/pairing`, `/login`, or `/auth/` so the full-screen reader and the pre-app gates get no nav DOM at all.
- **Layout token** — CSS gates display on `max-width: 700px` (it renders but is `display:none` on desktop). Scrolling containers reserve space via `--bottom-nav-h` (declared in `global.css`); the reader overrides that token to `0` so its full-bleed layout isn't pushed by the rail during the route-transition unmount.

### `RequireAdminAccess`

Route wrapper ([components/RequireAdminAccess.jsx](../client/src/components/RequireAdminAccess.jsx)) that gates a whole page behind the server admin password. Wraps `/third-party-sourcing` and `/manga/:id/edit` in [App.jsx](../client/src/App.jsx).

On mount it calls `GET /api/admin/auth-status`:

- **`logged_in`** → renders `children` unchanged.
- **`configured: false`** (fresh install, no admin password ever set) → shows a modal pointing the user to **Settings → Client Management** to create one, with a one-click *Open Settings* jump (`location.state.section = 'clients'`).
- **otherwise** → shows an inline admin-password modal that calls `api.adminLogin(pw)` and re-checks; *Cancel* navigates back (or Home when there's no history).
- **Offline / probe failure** — if the status probe can't reach the server but a token already exists in `localStorage`, the user is trusted through (the wrapped page is offline-aware and any gated API call will surface a real error); the password field is disabled while offline since it can only be verified live.

### Dialog subsystem (`src/dialog/`)

In-app replacement for `window.alert` / `confirm` / `prompt`, plus the imperative admin-access gate. Files:

- **[dialogService.js](../client/src/dialog/dialogService.js)** — React-free imperative API any module (utility, async hook, catch handler) can call without threading context. Exposes `appAlert(msg) → Promise<void>`, `appConfirm(msg) → Promise<boolean>`, `appPrompt(msg, default) → Promise<string|null>`, mirroring the native globals' contracts. One dialog at a time; concurrent calls queue FIFO and resolve in order. If no provider is mounted after a tick it falls back to the native browser primitive. Also exposes **`ensureAdminAccess() → Promise<boolean>`** — resolves `true` immediately when an admin token already exists, otherwise pops the admin-password modal; used by action-level callers (`if (!(await ensureAdminAccess())) return;`) to gate one-shot admin operations without wrapping a route.
- **[DialogProvider.jsx](../client/src/dialog/DialogProvider.jsx)** — mounts near the App root, registers itself as the dialog host via `__attachDialogHost`, and renders the actual modal UI.
- **[AdminUnlockDialog.jsx](../client/src/dialog/AdminUnlockDialog.jsx)** — the modal host for `ensureAdminAccess()`, mounted as a sibling of `<Routes>`.
- **[scrollLock.js](../client/src/dialog/scrollLock.js)** — body-scroll lock helper used while a dialog is open.

### `ToggleRow`

Generic on/off switch row ([components/ToggleRow.jsx](../client/src/components/ToggleRow.jsx)) used across Settings sections. Props: `label`, `desc`, `value`, `onChange`. Renders an accessible `role="switch"` button using the `.setting-row*` / `.toggle-*` classes from `Settings.css`.

## API Client (`src/api/client.js`)

Single `api` object with typed methods for every endpoint. Returns parsed JSON data (unwraps `{ data: ... }` envelope). Throws on non-OK responses.

In the Capacitor native shell the same `api` object is silently routed to an offline shim when `ConnectivityContext` reports the server unreachable (or the user toggled forced-offline). Methods listed in `OFFLINE_ROUTED_METHODS` resolve via `client/src/api/offlineApi.js` against an IndexedDB cache + filesystem fallback; methods outside the allowlist fall through to the raw network call and fail fast. The full architecture — folder picker, native plugins, IndexedDB schema, download queue, encryption, filesystem-as-source-of-truth scanner — lives in [offline.md](./offline.md).

Every request includes:

- `Content-Type: application/json`
- `X-Device-ID: <uuid>` (from `localStorage`)
- `Authorization: Bearer <clientToken>` when a paired-client token is in `localStorage[momotaro_client_token]` (set by the pairing wizard's final step)
- `X-Admin-Token: <token>` when an admin session is in `localStorage[momotaro_admin_token]`
- An `AbortController` timeout — default 15 s, overridable per call via `{ timeoutMs }` on the fetch options. Throws `'Request timed out'` if exceeded. `api.exportMetadata(libraryId)` raises this to 10 minutes because the endpoint may issue many upstream fetches for large libraries.

The fetch URL is always prefixed with `getServerUrl()` (reads `localStorage[momotaro_server_url]` on every call). In the PWA this returns `''` so requests stay same-origin; in the Capacitor APK it returns the URL the user picked in the pairing wizard.

**`rewriteMediaUrls(json, serverUrl, token)`** — every successful response is walked after parsing to fix up server-baked image URLs:

- URLs matching `/thumbnails/...` or `/api/pages/N/image` get **`serverUrl` prepended** when they start with `/`. Necessary in the APK because the WebView origin is `http://momotaro.app` — a bare `/thumbnails/05/5.webp` would otherwise try to load from the asset shell instead of the real Momotaro server. In the PWA `serverUrl` is `''` so URLs stay relative and resolve same-origin as before.
- The same URLs get **`?t=<token>` appended** so the `<img src>` request carries auth — `<img>` can't carry the `Authorization` header, and the server's auth middleware accepts the token via query string as a fallback.

Gated on `clientToken` presence: pre-pairing flows (health check, PIN handshake) intentionally skip the walk. See [android.md § Media URL rewriting](./android.md#media-url-rewriting).

Notable helpers:

```js
api.pageImageUrl(pageId)    // → "{serverUrl}/api/pages/{id}/image?t={token}"
api.thumbnailUrl(filename)  // → "{serverUrl}/thumbnails/{shard}/{filename}?t={token}"
api.getAppVersion()         // → /api/app/version — used by useAppUpdateCheck
api.healthCheck()           // → /api/health — used by the pairing wizard
api.pairingRequest(name, platform)
api.pairingSubmitPin(pairingId, pin)  // persists the returned token to localStorage
```

Metadata methods:

```js
api.refreshMetadata(mangaId)                       // AniList auto-fetch by title
api.refreshMalMetadata(mangaId)                    // MyAnimeList auto-fetch by title
api.refreshMangaUpdatesMetadata(mangaId)           // MangaUpdates auto-fetch by title
api.refreshDoujinshiMetadata(mangaId)              // Doujinshi.info auto-fetch by title
api.searchAnilist(q, page)                         // AniList manual search
api.searchMal(q, page)                             // MyAnimeList manual search
api.searchMangaUpdates(q, page)                    // MangaUpdates manual search
api.searchDoujinshi(q, page)                       // Doujinshi.info manual search
api.applyMetadata(mangaId, anilistId)              // Apply AniList result by ID
api.applyMalMetadata(mangaId, malId)               // Apply MyAnimeList result by ID
api.applyMangaUpdatesMetadata(mangaId, muId)       // Apply MangaUpdates result by series_id
api.applyDoujinshiMetadata(mangaId, slug)          // Apply Doujinshi.info result by slug
api.resetMetadata(mangaId, source?)                // Break linkage — omit source for full reset, pass 'anilist'|'myanimelist'|'mangaupdates'|'doujinshi' to break only that source's link
api.bulkMetadata(libraryId, source)                // Bulk pull — source: 'anilist' | 'myanimelist' | 'mangaupdates' | 'doujinshi'
api.exportMetadata(libraryId)                      // Write metadata.json to each manga folder (reads JSON cache, never re-pings)
api.exportMangaMetadata(mangaId, source?)          // Write metadata.json for a single manga (per-source or auto)
api.saveMalClientId(clientId)                      // Save (or clear with '') MAL Client ID
api.doujinshiLogin(email, password)                // Doujinshi.info login
api.doujinshiLogout()                              // Doujinshi.info logout
```

Thumbnail methods:

```js
api.getThumbnailOptions(mangaId)              // GET thumbnail-options (anilist, mal, mangaupdates, doujinshi, original, history, chapter pages)
api.setPageAsThumbnail(mangaId, pageId)       // POST set-thumbnail with { page_id } — also sets cover_user_set = 1
api.setThumbnailFromFile(mangaId, filename)   // POST set-thumbnail with { saved_filename } — also sets cover_user_set = 1
```

Admin / database methods:

```js
api.getCbzCacheSize()          // GET cbz-cache-size → { size_bytes, limit_bytes }
api.clearCbzCache()            // POST clear-cbz-cache → { size_bytes: 0 }
api.getCbzCacheSettings()      // GET cbz-cache-settings → { limit_bytes, autoclear_mode, autoclear_day, autoclear_time, next_run_at, ... }
api.saveCbzCacheSettings(body) // PUT cbz-cache-settings → updated settings (any subset of { limit_bytes, autoclear_mode, autoclear_day, autoclear_time })
api.exportConfig()             // GET admin/export-config → triggers JSON download via fetch + blob (X-Admin-Token header)
api.importConfig(payload)      // POST admin/import-config → { counts, warnings, warnings_truncated, total_warnings } — 5-minute timeout
api.regenerateThumbnails()     // POST regenerate-thumbnails → { message, total }
api.resetThumbnails()          // POST reset-thumbnails  → per-source counters; clears every manga's cover_user_set and re-aligns to the priority order (no upstream pings)
api.vacuumDb()                 // POST vacuum-db → { size_before_bytes, size_after_bytes }
api.getSystemLogs()            // GET admin/logs → { entries: [{ ts, level, message }], max }
api.exportSystemLogs()         // GET admin/logs/export → triggers .txt download via fetch + blob (X-Admin-Token header)
```

## Context

Four React contexts back the app tree (the `UserProvider`, `PreferencesProvider`, and `ConnectivityProvider` wrap the routes in [client/src/App.jsx](../client/src/App.jsx); `SidebarContext` is scoped to the Library page).

- **`SidebarContext`** ([src/context/SidebarContext.jsx](../client/src/context/SidebarContext.jsx)) — boolean `sidebarOpen` + `setSidebarOpen` shared between `Library` page and `Sidebar` component.
- **`UserContext`** ([src/context/UserContext.jsx](../client/src/context/UserContext.jsx)) — holds the logged-in user, hydrates from `GET /api/users/me` on mount, exposes `login` / `register` / `logout` / `useUser()`. Identity only; independent of connectivity and pairing.
- **`PreferencesContext`** ([src/context/PreferencesContext.jsx](../client/src/context/PreferencesContext.jsx)) — per-user, server-synced UI preferences. Fetches once via `GET /api/user/preferences` on mount, holds the prefs map in memory, and exposes `useUserPref(key, default)` / `setPref(key, value)`. Writes are **optimistic locally + debounced 300 ms PUT** to `/api/user/preferences`; on failure the patch is requeued for the next flush. Re-fetches on `visibilitychange` so a change made on Device A appears on Device B the next time B's tab regains focus. Real-time push is out of scope. On first mount, a one-shot legacy migration copies any of the four pre-existing `home_*` `localStorage` keys to the server and removes them locally — gated by `localStorage.home_prefs_migrated = '1'`. See [api.md § User Preferences](./api.md#user-preferences) for the wire format.
- **`ConnectivityContext`** ([src/context/ConnectivityContext.jsx](../client/src/context/ConnectivityContext.jsx)) — source of truth for "are we online and is the server reachable". Combines `navigator.onLine`, `@capacitor/network` (for the Android WebView, whose `online`/`offline` events fire inconsistently), and a periodic `/api/health` ping (30 s while online, 7.5 s while offline). Exposes `mode` (`'online' | 'offline-auto' | 'offline-forced'`), `online`, `forced` / `forceOffline(bool)`, `networkType` (`wifi` / `cellular` / `ethernet` / `unknown` / `none`), and `wifiOnly` (persisted setting that gates the downloader on metered networks). The forced flag persists across launches via `localStorage[momotaro_force_offline]`; `wifiOnly` via `localStorage[momotaro_wifi_only_downloads]`. Drives the offline routing in [client/src/api/client.js](../client/src/api/client.js) and the [Downloads page](#downloads-srcpagesdownloadsjsx).

## Hooks

- **`useReaderPrefetch`** ([src/hooks/useReaderPrefetch.js](../client/src/hooks/useReaderPrefetch.js)) — proactively warm up the next chapter's page bytes while the reader is on the current chapter.
- **`useGridColumnCount`** ([src/hooks/useGridColumnCount.js](../client/src/hooks/useGridColumnCount.js)) — observes a container's actual width through `ResizeObserver` and reports the live column count. Used by `VirtualizedMangaGrid` to map the visible viewport onto a slice of the manga array.
- **`useScrollPosition`** ([src/hooks/useScrollPosition.js](../client/src/hooks/useScrollPosition.js)) — windowed-grid scroll bookkeeping for `VirtualizedMangaGrid`.
- **`useAppUpdateCheck`** ([src/hooks/useAppUpdateCheck.js](../client/src/hooks/useAppUpdateCheck.js)) — polls `GET /api/app/version` and reports whether the server's reported version differs from the bundled [`APP_VERSION`](../client/src/version.js). Gated on `Capacitor.isNativePlatform()` so the PWA never sees the banner. Powers [`UpdateBanner`](#updatebanner). See [android.md § Update mechanism](./android.md#end-to-end-update-flow).
- **`useAdminTask`** ([src/hooks/useAdminTask.js](../client/src/hooks/useAdminTask.js)) — drives the UI of a long-running admin action (vacuum, cache wipe, reset thumbnails, regenerate). Kicks off the `POST`, adopts an already-running task on mount or on `409`, polls the status companion endpoint (`GET /api/admin/<task>/status`) at 1.5 s while running, exposes an elapsed-time counter, and reset()s after the user dismisses the badge. Polling pauses while the tab is hidden and refreshes immediately on visibility return. In-flight responses from earlier requests are discarded on race. Pairs with the [Async admin tasks contract](./api.md#async-admin-tasks).
- **`useAdminTaskButton`** ([src/hooks/useAdminTaskButton.jsx](../client/src/hooks/useAdminTaskButton.jsx)) — wraps `useAdminTask` with the full button visual state machine used by the heavy admin-action cards (Compact DB, Clear Cache, Reset / Regenerate Thumbnails, Bulk Optimize, per-manga Optimize). Returns `{ task, button, badge }`: idle shows the original label; running shows `"<label>… 0:14"` or `"<label> 242 / 1,847"` when progress is reported; done shows a green result badge (auto-dismissed after 30 s, suppressed entirely if older than 5 min on re-mount); failure shows a red error badge. Confirmation prompts route through `appConfirm` from the [dialog subsystem](#dialog-subsystem-srcdialog).

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
| `favicon.png` | 32 × 32 | Browser-tab favicon, referenced from index.html and pre-cached |
| `logo.png` | 256 × auto | Navbar wordmark on every page + pairing-wizard hero |

All five are regenerated by `node scripts/generate-favicons.cjs` from `assets/icon-only.png` (the chibi) and `assets/new_logo.png` (the wordmark). The script flood-fills the white border of `icon-only.png` to transparent so the rounded shape is preserved with alpha-clear corners.

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
| `browse-data` | `/api/(library\|libraries\|manga\|chapters\|reading-lists\|stats\|home)` | StaleWhileRevalidate | 500 | 30 days |
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
- The **search input lives outside the sticky navbar** at this breakpoint. The desktop search-wrap inside the navbar is hidden via `.lib-desktop-only`, and a dedicated `.lib-mobile-search-row` (a non-sticky full-width row directly below the navbar, above `.lib-mobile-bar`) carries an identical `<input type="search">` bound to the same React state. Both inputs use the same `value` / `onChange`, so cross-viewport behavior is identical. Reason: with the search input *inside* the sticky navbar on mobile, focusing it spawned the iOS soft keyboard, which shrunk the visual viewport and forced iOS Safari to relayout the sticky context against a fully-rendered manga grid below — a known iOS rendering pipeline pattern that froze the page hard enough that the user had to force-quit the app. Lifting the input out of the sticky context entirely sidesteps the cascade. The mobile input also carries `enterKeyHint="search"`, `autoComplete/autoCorrect/autoCapitalize="off"`, and `spellCheck={false}` for a cleaner mobile keyboard. The Home page search input stays inside the sticky navbar at every breakpoint because Home does not render the heavy library grid at search-tap time (only ribbons), so the sticky-input + soft-keyboard cascade never reaches a layout cost that matters there.

### MangaDetail page (≤ 640px / ≤ 600px)

- Action buttons stretch to fill the full row width and switch to **icon-only** rendering — *Continue Reading* (double chevron), *Reset Progress* (circular refresh arrow), *Settings* (gear cog), and *Lists* (three-line list, with the count badge preserved). Dropdown chevrons are hidden in this mode. See *Mobile action-row icons* above for the class wiring.
- *Metadata*, *Optimize*, and *More Info* are consolidated into the **Settings** dropdown to save row space (see MangaDetail page description above).
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
| `src/pages/Settings.css` | Settings layout, tab bar, stat tiles/grid, `.setting-row*` / `.toggle-*` (shared by `ToggleRow`) |
| `src/pages/Libraries.css` | Library management list and form |
| `src/components/BottomNav.css` | Phone-only bottom navigation rail (gated `≤ 700px`) |
| `src/components/RequireAdminAccess.css` | Admin-gate prompt modal (`.admin-prompt-*`) |
| `src/dialog/Dialog.css` | In-app alert / confirm / prompt + admin-unlock modal styling |
