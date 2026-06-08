# API Reference

All routes are prefixed `/api`. Server runs on port 3000 in development.

The client API layer lives in [client/src/api/client.js](../client/src/api/client.js).

## Auth Headers

The client attaches up to four identity headers depending on what it has
configured. Each represents a different access layer:

| Header | Layer | Set by |
|---|---|---|
| `X-Device-ID: <uuid>` | Device UUID (legacy / telemetry) | Generated on first load, persisted in `localStorage` as `momotaro_device_id`. No longer used for AniList scoping (that's now per-user). |
| `Authorization: Bearer <token>` / `X-Client-Token` | **Device trust** — paired client | `POST /api/pairing/submit-pin`. Required when `auth_enabled = 1`. |
| `X-Admin-Token` | **Admin capability** | `POST /api/admin/login`. Gates Client Management, Port Forwarding, DB ops, user management. |
| `X-User-Token` | **User identity** — who is reading | `POST /api/users/login` or `/register`. Required when `multi_user_enabled = 1` (the default since the user-accounts release). |

Returned errors:
- Missing/invalid device token (when `auth_enabled = 1`, off-LAN, no admin) → `401 "Authentication required"`.
- Missing/invalid user token (when `multi_user_enabled = 1`, no admin bridge) on a per-user route → `401 "User authentication required"`.

## User Accounts

Multi-user accounts (see [user-accounts.md](./user-accounts.md)). Reachable
once the request has passed the network gate so an unpaired external visitor
can't register (requirement #6).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/users/register` | Body: `{ username, password, display_name? }`. The first account adopts the default user (id=1), inheriting all pre-accounts reading data. Returns `{ user_token, user }`. Gated by `allow_registration` (default on). |
| `POST` | `/api/users/login` | Body: `{ username, password }`. Generic 401 (no enumeration). Returns `{ attempts_remaining }` on failure and `seconds_remaining` when the 5-strikes-→-24h device lockout fires (429). |
| `POST` | `/api/users/logout` | Revokes the bearer session. |
| `GET`  | `/api/users/me` | The active account profile. |
| `PUT`  | `/api/users/me/password` | Body: `{ current_password, new_password }`. Verifies current password, requires ≥ 8 chars, **revokes every existing session for this user** and mints a fresh one for the calling device. Returns `{ user_token }` — the client persists it immediately so the next request still authenticates. Other devices fail their next request with 401 and drop to `/login`. |
| `GET`  | `/api/users/exists?username=` | Boolean availability check for the register form (rate-limited). |
| `GET`  | `/api/history?limit=N` | The caller's own reading-history timeline (newest first). |
| `GET`  | `/api/history?format=csv` | CSV download of the caller's full reading history. Ignores the `limit` cap so the export is complete. Columns: _Manga, Chapter, Event, Read at (UTC)_. UTF-8 BOM + RFC 4180 line endings. Native browser navigation can't carry `X-User-Token`, so the client downloads via fetch + blob + a synthetic `<a download>` (`_userDownload` helper). |
| `GET`  | `/api/reading-lists.csv` | CSV download of every membership across the caller's reading lists (built-in + custom). Columns: _List, Built-in, Manga, Library, Folder path, Added at (UTC)_. Same fetch + blob flow. The `.csv` suffix keeps the path unambiguous from `/api/reading-lists/:id`. |
| `DELETE` | `/api/history` | Clear the caller's own reading history. |

### Admin user management (admin-only)

All gated by `X-Admin-Token`. Requirement #10: the operator has total power
over every account.

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/admin/users` | Roster with per-user counts (sessions, progress, lists, history, AniList linked). |
| `POST`   | `/api/admin/users` | Admin-create. First admin-created account adopts the default user. |
| `PATCH`  | `/api/admin/users/:id` | Body keys: `display_name`, `is_admin`, `disabled`, `new_password`. Password reset / disable also revoke that user's sessions. |
| `DELETE` | `/api/admin/users/:id` | Cascades progress, lists, history, sessions, AniList linkage via FK. **Cannot delete the primary account (id=1).** |
| `POST`   | `/api/admin/users/:id/revoke-sessions` | Force-logout on every device. |
| `GET`    | `/api/admin/users/:id/history` | One user's reading history. |
| `GET`    | `/api/admin/users/:id/export` | Full per-user JSON bundle (account + sessions/devices + progress by path + lists + history). **Never includes password hash or AniList token.** |
| `GET`    | `/api/admin/reading-history` | All-users timeline joined to username; `?format=csv` reuses the connection-log CSV helpers. |
| `GET`    | `/api/admin/login-lockouts` | Active login lockouts + the configured cap. |
| `DELETE` | `/api/admin/login-lockouts/:key` | Clear one device's login lockout (admin escape hatch). |

The `multi_user_enabled` and `allow_registration` flags are part of
`GET/PUT /api/admin/security-settings` alongside `auth_enabled` and
`lan_bypass_enabled`.

---

## User Preferences

Per-user, server-synced UI preferences. Replaces the four pre-existing
`localStorage` Homepage Settings (`home_default_sort`, `home_discover_refresh_ms`,
`home_genre_score_threshold`, `home_gallery_order`) and adds twelve new
Discover / ribbon-layout / Recently-Added keys so the same account sees
the same Home configuration across every device. Backed by the
`user_preferences (user_id, key, value, updated_at)` SQLite table — see
[database.md](./database.md).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/user/preferences` | Returns every preference for the calling user as a flat `{ key: value }` object. Values are JSON-decoded server-side so booleans, numbers, and arrays round-trip with their original types. |
| `PUT` | `/api/user/preferences` | Partial merge. Body is `{ key: value, … }`; each key is upserted, omitted keys are left untouched. Returns the full merged object so the client can sync state without a follow-up GET. Empty body is a no-op. Wrapped in a single transaction so a partial failure leaves no half-written prefs. |

The endpoint is mounted at `/api/user` under `requireClientOrAdmin +
requireUser`; both the mount-line and the inner router enforce
`requireUser`, so an unauthenticated request 401s before it can read or
write per-user state.

**Cache invalidation.** Routes that mirror prefs into a `?query` (notably
`/api/home`, whose cache key is derived from the same params) must
invalidate their per-user cache slot when a sync write changes a
home-affecting key. The PUT handler imports
[`deleteHomeCacheForUser`](../server/src/routes/library.js) from the
library router and calls it whenever any of the known
`home_*` keys change. The HOME_AFFECTING_KEYS allowlist lives in
[server/src/routes/userPreferences.js](../server/src/routes/userPreferences.js)
and must be kept in sync with the prefs read in
[client/src/pages/Home.jsx](../client/src/pages/Home.jsx).

**Pre-existing keys (migrated from `localStorage`):**

| Key | Default | Type |
|---|---|---|
| `home_default_sort` | `"title"` | string (`title` / `updated` / `year` / `rating`) |
| `home_discover_refresh_ms` | `86400000` (24 h) | number, milliseconds; `0` = manual only |
| `home_genre_score_threshold` | `7` | number 0–10 |
| `home_gallery_order` | `"chronological"` | string |

**Keys added by the Homepage Settings expansion:**

| Key | Default | Type / range |
|---|---|---|
| `home_discover_min_score` | `0` | number 0–10 |
| `home_discover_excluded_genres` | `[]` | string[] |
| `home_favorite_genres_mode` | `"auto"` | `"auto"` \| `"manual"` |
| `home_favorite_genres_manual` | `[]` | string[] (max 4) |
| `home_discover_min_match_count` | `1` | number 1–4 |
| `home_discover_library_ids` | `[]` (empty = all) | number[] |
| `home_discover_skip_bookmarked` | `false` | boolean |
| `home_discover_pool_size` | `30` | number |
| `home_discover_visible_count` | `15` | number |
| `home_ribbon_order` | see [frontend.md § Homepage Settings](./frontend.md#settings-srcpagessettingsjsx) | `{ id, visible }[]` |
| `home_resume_hero_enabled` | `true` | boolean |
| `home_genre_ribbon_count` | `4` | number 1–4 |
| `home_recent_window_hours` | `0` (no window) | number |

**Per-device transient keys that stay in `localStorage`** (they
*shouldn't* sync — they're rotation state, not settings):
`home_discover_last_refresh`, `home_discover_seed`, `home_prefs_migrated`.

**Legacy migration.** On the first mount after upgrade, the
[`PreferencesProvider`](../client/src/context/PreferencesContext.jsx)
copies any of the four pre-existing `home_*` `localStorage` keys to the
server via a single PUT, deletes them locally, and sets
`localStorage.home_prefs_migrated = '1'` so the migration runs exactly
once per browser.

**Forwarding prefs to `/api/home`.** `/api/home` continues to accept
filters as query parameters (matches the existing `min_score` /
`discover_limit` pattern). The client reads prefs out of
`PreferencesContext` and forwards them — the server does **not** read
prefs directly, so the cache key stays derivable purely from query
params.

---

## Libraries

| Method | Path | Description |
|---|---|---|
| GET | `/api/libraries` | List all libraries with manga counts |
| POST | `/api/libraries` | Create library `{ name, path }` |
| PATCH | `/api/libraries/:id` | Update library `{ name?, path?, show_in_all? }` |
| DELETE | `/api/libraries/:id` | Delete library and all its manga |
| POST | `/api/libraries/:id/scan` | Trigger manual scan of one library |
| POST | `/api/manga/:id/scan` | Re-scan a single manga directory (used by the watcher path and the Refresh button on MangaDetail) |
| POST | `/api/scan` | Trigger full scan of all libraries (returns 409 if already running) |
| GET | `/api/scan/status` | Current scan progress — see *Scan Progress* below |
| POST | `/api/libraries/:id/export-metadata` | Write `metadata.json` to each manga folder that has third-party metadata |
| POST | `/api/libraries/:id/reset-metadata` | Bulk Break Linkage across every manga in the library — same per-manga semantics as `POST /api/manga/:id/reset-metadata` (see [Reset Metadata](#reset-metadata)) |

### Scan Progress

Startup scans and manual scans are non-blocking — the HTTP endpoints return immediately and the scan runs in the background. Poll `GET /api/scan/status` to observe progress.

Response shape:

```json
{
  "data": {
    "running": true,
    "trigger": "startup",
    "startedAt": 1713200000000,
    "finishedAt": null,
    "currentLibrary": { "id": 1, "name": "Main" },
    "totalLibraries": 2,
    "completedLibraries": 0,
    "currentMangaIndex": 142,
    "currentMangaTotal": 5000,
    "currentMangaName": "Some Title",
    "lastError": null,
    "elapsedSeconds": 180,
    "etaSeconds": 6100
  }
}
```

- `trigger` is `startup`, `manual-full`, or `manual-library`.
- `etaSeconds` is estimated for the *current* library only (time so far / manga processed × manga remaining in this library). It is `null` until at least one manga has been processed.
- Only one scan runs at a time. Calling `POST /api/scan` or `POST /api/libraries/:id/scan` while a scan is running returns HTTP 409 with the current status payload.
- After completion, `running` stays `false` and `finishedAt` / `elapsedSeconds` reflect the most recent run until the next scan begins.

---

## Manga / Library

| Method | Path | Description |
|---|---|---|
| GET | `/api/library` | List manga (supports `?search=`, `?sort=`, `?library_id=`, `?status=`, `?limit=`, `?cursor=`) |
| GET | `/api/manga/:id` | Get single manga with chapters and progress |
| GET | `/api/manga/:id/info` | Get filesystem info computed on demand: path, chapter count, folder size in MB, `track_volumes`, and missing-chapter / missing-volume gap lists |
| GET | `/api/manga/:id/offline-package` | Batched payload for the offline downloader — `{ manga, chapters, server_updated_at, fetched_at }`. Used by `queueSeries` (one round-trip per series instead of two) and `refreshOfflineSnapshot` (stale-copy detection). The chapter rows alias `file_mtime AS updated_at` because `chapters` has no literal `updated_at` column. See [offline.md § Server endpoint](./offline.md#server-endpoint). |
| PATCH | `/api/manga/:id` | Update user-editable manga fields. Body accepts any subset of `{ track_volumes?, title?, author?, genres? }`. `track_volumes` is coerced to 0/1; an empty `title` returns 400; `author = ""` clears the field; `genres` must be an array of strings (non-strings/empties are dropped). The triggers on `manga` keep `manga_fts` and `manga_genres` in sync automatically when `title`/`author`/`genres` change. |
| GET  | `/api/manga/:id/thumbnail-options` | List all thumbnail choices: anilist, original, history, chapter first pages (each annotated with its pre-generated cover when available) |
| POST | `/api/manga/:id/set-thumbnail` | Set thumbnail from a page `{ page_id }` or saved file `{ saved_filename }` |
| POST | `/api/manga/:id/generate-chapter-covers` | Render a 300×430 WebP from the first page of every chapter and save each into `thumbnail_history` (idempotent per chapter); does not change the active cover |
| DELETE | `/api/manga/:id` | Remove manga from DB and delete files on disk |

### Search (`?search=`)

Search is indexed — a FTS5 virtual table over `(title, author)` plus a normalised `manga_genres(manga_id, genre)` table. No full table scan, no `LIKE '%term%'`. See [database.md](./database.md#search-index-manga_fts--manga_genres) for schema and triggers.

- **Single term** — matches if the term appears as a **whole word** in the manga's title or author, *or* matches a genre **exactly** (case-insensitive). "Yona" finds "Yona of the Dawn"; "Dawn" finds it too; "Daw" does not. "Romance" matches manga tagged Romance; "rom" does not. Multi-word input is implicit AND: "Yona Dawn" requires both words to appear in the title/author, matching "Yona of the Dawn". Author first and last names both work since each tokenises as a separate word.
- **Comma-separated terms** — treated as a genre filter; manga must have **all** listed genres (exact match, case-insensitive). Title and author are not checked in this mode.

FTS5 operator characters (`"`, `*`, `+`, `-`, `:`, `(`, `)`, `^`) are stripped from user input before the query is built, so pasting a title with punctuation or accidentally typing `*foo*` still works. An empty or punctuation-only search matches nothing for the FTS branch — the genre branch still applies.

The same logic applies to the reading-list manga endpoint (`GET /api/reading-lists/:id/manga?search=`).

### Pagination (`?limit=`, `?cursor=`)

`GET /api/library` is opt-in paginated. Omitting both parameters returns the full result set (unchanged legacy behavior). Supplying either parameter switches the response to the paginated shape.

- `?limit=N` — max rows per page. Bounded to `[1, 500]`. Default 200 when only `cursor` is set.
- `?cursor=<opaque>` — resume token from a previous response's `next_cursor`. Supported for **all four sorts** (`title`, `updated`, `year`, `rating`). A cursor minted under one sort is rejected with `400` if replayed under a different sort (the encoded key width won't match that sort's key list).

### Sort modes (`?sort=`)

| Value | Order |
| --- | --- |
| `title` *(default)* | `m.title ASC`, ID tiebreaker |
| `updated` | `m.updated_at DESC`, ID tiebreaker |
| `year` | `m.year DESC`, title tiebreaker |
| `rating` | `m.score DESC NULLS LAST, m.title ASC` — manga not matched to AniList or MAL (score is `NULL`) sink to the bottom and sort alphabetically within that group |

`sort=rating` is also accepted by `GET /api/reading-lists/:id/manga`.

Paginated response shape:

```json
{
  "data": [ /* manga rows */ ],
  "next_cursor": "eyJ2IjoiTXkgTWFuZ2EiLCJpZCI6NDJ9",
  "has_more": true
}
```

`next_cursor` is `null` when `has_more` is `false` — i.e. the final page has been returned. Cursors are opaque base64url tokens containing **all of the last row's ordering-key values** plus its `id` tiebreaker (`[...keyValues, id]`); single-key sorts (`title`, `updated`) encode `[value, id]`, `rating` encodes `[score, title, id]`. Do not parse or construct them on the client.

Under the hood, the server fetches `limit + 1` rows and applies a keyset `WHERE` against the index matching the sort: `idx_manga_title` / `idx_manga_updated_at` for the single-key sorts, and `idx_manga_year (year DESC, id)` / `idx_manga_score (score DESC, title, id)` for `year` / `rating`. The keyset predicate is **NULLS-LAST aware** for the nullable `year` / `score` columns — a row with a NULL key sorts after every non-NULL row and the cursor steps into that trailing block without skipping or duplicating rows. `EXPLAIN QUERY PLAN` confirms each sort scans its index in order with no temp b-tree, so the cost of fetching page N is independent of N — unlike `OFFSET`, which scans every skipped row.

Deep cursor pages (`?cursor=` present) bypass the in-process listing cache, since they are cheap to recompute via the index and caching them would let one client's deep scroll evict the shared hot first-page / per-library entries.

### Listing row shape

`GET /api/library` and `GET /api/reading-lists/:id/manga` return a **slim** row containing only the columns the grid renders. Heavier metadata fields (`description`, `genres`, `author`, `anilist_id`, `mal_id`, `mangaupdates_id`, `doujinshi_id`, all `*_cover` source columns, `metadata_source`, `track_volumes`, `bytes_on_disk`, `file_count`, etc.) are intentionally omitted. Fetch the full row via `GET /api/manga/:id` when needed.

```json
{
  "id":          5,
  "title":       "...",
  "year":        2020,
  "score":       8.3,
  "status":      "FINISHED",
  "cover_image": "5.webp",
  "cover_url":   "/thumbnails/05/5.webp",
  "updated_at":  1713200000
}
```

`updated_at` is retained because the `sort=updated` keyset cursor reads it. `title` is retained for the `sort=title` cursor. Both are also rendered by the UI (year/score badges, title text). Search-by-genre still works because the WHERE clause is resolved server-side via the indexed `manga_genres` table — the response payload does not need to include genres.

### Caching

Both `/api/library` and `/api/reading-lists/:id/manga` are cached at two layers:

- **In-process LRU cache** — keyed by every parameter that affects the result (`search`, `status`, `sort`, `library_id`, `limit` for the library endpoint; `list_id`, `search`, `sort` for the reading-list endpoint). 30 s TTL, capped at 200 entries per endpoint with oldest-insertion eviction. Cursor-bearing (deep) pages are **not** cached — only page 1 (no cursor) and search bursts are. New manga from a scan, metadata refresh, or `PATCH /api/manga/:id` become visible within the TTL window — same staleness contract as `/api/home` and `/api/stats`.
- **HTTP cache header** — every response carries `Cache-Control: private, max-age=15, stale-while-revalidate=60` so non-PWA tabs (incognito, fresh installs) get a fast browser cache to back up the service worker's StaleWhileRevalidate rule. Different query strings get different SW / browser cache entries.

### `GET /api/manga/:id/info` response

```json
{
  "data": {
    "path": "/library/My Manga",
    "file_count": 842,
    "size_mb": 312.47,
    "track_volumes": false,
    "missing_chapters": { "count": 2, "numbers": [37, 58], "max": 120, "truncated": false },
    "missing_volumes":  { "count": 0, "numbers": [], "max": 0, "truncated": false }
  }
}
```

This endpoint is computed **on demand** (not from the cached scan-time columns) so the modal reflects the disk's current state after a refresh:

- `file_count` — number of chapter rows for the manga (a chapter folder counts as 1, a single CBZ counts as 1), via `COUNT(*)` on `chapters`.
- `size_mb` — recursive on-disk size of `manga.path`, computed by an iterative `readdir`/`stat` walk at request time (returns 0 if the folder is missing).
- `track_volumes` — the manga's flag, so the client knows which axis to display.
- `missing_chapters` / `missing_volumes` — **gap detection**. Each chapter is bucketed into the integer floor of its `number` / `volume` (so `5.5` still covers chapter 5); the response lists the integers in `[1, max]` with no chapter assigned. Shape: `{ count, numbers, max, truncated }`, where `numbers` is capped at 500 entries and `truncated` is true when `count` exceeds the cap. Both axes are always returned so the client can re-render if the `track_volumes` toggle changes without another round-trip.

### `GET /api/manga/:id/thumbnail-options` response

```json
{
  "data": {
    "active_cover":        "5.webp",
    "anilist_cover":       "5_anilist.webp",
    "mal_cover":           "5_mal.webp",
    "mangaupdates_cover":  "5_mu.webp",
    "doujinshi_cover":     null,
    "original_cover":      "5_original.webp",
    "cover_user_set":      false,
    "history": [
      { "id": 3, "filename": "5_1713200000000.webp", "created_at": 1713200000 }
    ],
    "chapter_first_pages": [
      { "chapter_id": 12, "page_id": 100, "label": "Vol.1 Ch.1", "generated_filename": "5_ch12.webp" },
      { "chapter_id": 13, "page_id": 117, "label": "Vol.1 Ch.2", "generated_filename": null }
    ]
  }
}
```

- `anilist_cover` / `mal_cover` / `mangaupdates_cover` / `doujinshi_cover` / `original_cover` — `null` if not yet generated for that source. The Thumbnail Picker only renders a tile for sources whose column is non-null.
- `cover_user_set` — `true` when the user has manually picked the active cover via this endpoint (`POST /api/manga/:id/set-thumbnail`). **Sticky across library scans** — subsequent metadata-apply paths and the post-scan reinforcement pass leave the active cover alone while this is `true`. Only `POST /api/admin/reset-thumbnails` clears the flag and re-aligns to the priority order. See [scanner.md § Cover priority](./scanner.md#cover-priority).
- `history` — up to 20 entries, most recent first. Populated by `POST /api/manga/:id/set-thumbnail` with `{ page_id }`. Excludes generated chapter covers — those are folded into `chapter_first_pages` below.
- `chapter_first_pages` — one entry per chapter (the page at `page_index = 0`), ordered by chapter number. `generated_filename` is the deterministic `<mangaId>_ch<chapterId>.webp` produced by `POST /api/manga/:id/generate-chapter-covers` when present, or `null` when that chapter hasn't been generated yet. The Choose Thumbnail modal renders the pre-sized thumbnail when `generated_filename` is set (applied via `set-thumbnail` `{ saved_filename }`) and falls back to streaming the raw page image otherwise (applied via `set-thumbnail` `{ page_id }`).

### `POST /api/manga/:id/set-thumbnail`

Accepts either a live page or a previously saved thumbnail file:

```json
{ "page_id": 100 }
```

Generates a 300 × 430 WebP from the page image, saves it as `{mangaId}_{timestamp}.webp`, copies it to the active `{mangaId}.webp`, and records the filename in `thumbnail_history`.

**Folder vs. CBZ chapters** — the page source is resolved from the parent chapter's `type`:

- `folder` — the page's absolute file path is passed directly to `sharp`.
- `cbz` — `cbzCache.getCbzPageFile(chapterId, chapterPath, pageIndex)` extracts the chapter to the on-disk cache (no-op if it's already extracted) and returns the absolute path of the requested page file. That path is then handed to `sharp` like a folder page. Subsequent picks from the same chapter reuse the cache dir; an LRU/auto-clear eviction can wipe it, in which case the next call re-extracts. See [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache).

```json
{ "saved_filename": "5_anilist.webp" }
```

Copies an existing saved file to the active `{mangaId}.webp`. The filename must start with `{mangaId}_` and end with `.webp` (path traversal prevention).

**Both forms set `manga.cover_user_set = 1`.** The pick is **sticky across library scans** — metadata fetches won't touch the active cover (they only refresh the relevant `*_cover` source column), and the post-scan cover-priority reinforcement pass skips manga with this flag set. Only `POST /api/admin/reset-thumbnails` clears the flag and re-aligns to the priority order. See [scanner.md § Cover priority](./scanner.md#cover-priority).

### `POST /api/manga/:id/generate-chapter-covers`

Renders a 300×430 WebP thumbnail from the first page (`page_index = 0`) of every chapter and inserts each into `thumbnail_history`. Triggered from the **Generate Covers** button on the Choose Thumbnail modal.

```json
{ "data": { "generated": 18, "skipped": 2, "errors": 0, "total": 20 } }
```

- Filenames follow the deterministic pattern `<mangaId>_ch<chapterId>.webp`, so re-running the endpoint is **idempotent** — chapters whose thumbnail file already exists are skipped (their history row is re-inserted via `INSERT OR IGNORE` to recover from any DB-only loss).
- The active cover is **not** changed; this only populates the pool of options the user can pick from in the modal. Apply one with `POST /api/manga/:id/set-thumbnail` `{ "saved_filename": "<mangaId>_ch<chapterId>.webp" }`.
- CBZ chapters are resolved through `cbzCache.getCbzPageFile`, which extracts the chapter on demand. Because the cache auto-clears on overflow (see [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache)), the loop verifies the resolved file still exists immediately before reading it and re-extracts once if a parallel reader or the auto-clear scheduler wiped it.
- Runs synchronously on the request thread. Long-tail manga with many chapters can take a while — the client allows up to 10 minutes before timing out.

---

## Art Gallery

A per-manga collection of saved pages. Users bookmark pages from the reader via the *Add to Art Gallery* button; the pages appear as a grid at the bottom of MangaDetail. Gallery entries are stored in the `art_gallery` table (see [database.md](./database.md)).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/gallery/all` | Every gallery item across every manga, grouped by series. Powers the standalone `/art-gallery` page (see [frontend.md § ArtGallery](./frontend.md#artgallery-srcpagesartgalleryjsx)). |
| GET | `/api/manga/:id/gallery` | List gallery items for a manga, newest first |
| POST | `/api/manga/:id/gallery` | Add a page `{ pageId }` |
| DELETE | `/api/manga/:id/gallery/page/:pageId` | Remove by page ID (used by the reader toggle) |
| DELETE | `/api/manga/:id/gallery/:itemId` | Remove by gallery item ID (used by the MangaDetail remove button) |

### `GET /api/manga/:id/gallery`

Returns entries joined with `pages` and `chapters` so the UI can label each thumbnail without extra queries:

```json
{
  "data": [
    {
      "id": 12,
      "manga_id": 5,
      "chapter_id": 87,
      "page_id": 412,
      "page_index": 6,
      "created_at": 1713200000,
      "chapter_number": 3,
      "chapter_volume": null,
      "chapter_folder_name": "Chapter 3"
    }
  ]
}
```

The UI composes the chapter label from `chapter_number`, `chapter_volume`, and `chapter_folder_name` using the same logic as the chapter list (see [frontend.md](./frontend.md)).

### `POST /api/manga/:id/gallery`

Body: `{ "pageId": <page-id> }`. The server validates via JOIN that the page belongs to the manga before inserting. Uses `INSERT OR IGNORE` on the `UNIQUE(manga_id, page_id)` constraint, so re-adding an existing page is a no-op.

### `DELETE` endpoints

Two deletion paths exist because the reader and MangaDetail have different IDs on hand:

- The reader only knows the current `page_id`, so it calls `/gallery/page/:pageId`.
- The gallery UI on MangaDetail renders each item by its gallery row `id`, and calls `/gallery/:itemId`.

Both return `{ data: { deleted: true } }` on success; neither is an error if the target row does not exist.

---

## Chapters & Pages

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/manga/:mangaId/chapters` | List chapters for a manga |
| GET | `/api/chapters/:id` | Get single chapter |
| GET | `/api/chapters/:id/pages` | List pages for a chapter (includes width/height/is_wide). Accepts `?fast=1` and `?resume_page=N` for the first-page-fast CBZ flow. |
| POST | `/api/chapters/:id/prioritize-pages` | Priority hint for fast-mode Phase 2 — move named page indices to front of the work queue. No-op when no active fast extraction. |
| POST | `/api/pages/dims` | Client-reported page dimensions (backup safety net from `<img onLoad>`). Batch of up to 100. UPDATE filter `AND (width IS NULL OR height IS NULL)` so client reports never overwrite server-probed values. |
| GET | `/api/pages/:id/image` | Serve page image (binary, `Cache-Control: public, max-age=86400`). May return HTTP 410 Gone (chapter removed) or HTTP 503 + `Retry-After` (fast-mode Phase 2 didn't deliver the page within `CBZ_PAGE_WAIT_TIMEOUT_MS`). |

### `GET /api/chapters/:id/pages`

Lists pages for a chapter. For folder chapters this is a straight DB read; for CBZ chapters it drives `cbzCache.ensureChapterExtracted` and UPSERTs page rows keyed on `(chapter_id, page_index)` so IDs survive cache evictions and re-extractions.

**Query parameters:**

| Param | Meaning |
| --- | --- |
| `fast=1` | Opt into fast-mode extraction. Server runs Phase 1 (plan + probe dims + extract the first `CBZ_FAST_PREFIX` pages) and returns; Phase 2 continues in the background. Sent by the reader when the per-device "Fast chapter open" setting is on. Folder chapters ignore this flag — they're already instant. |
| `resume_page=N` | Resume-position hint. When fast mode is on, Phase 1 also extracts a small window around `N` so a deep-link / saved-resume entry doesn't block on `waitForPageFile` for the user's landing page. Ignored in full mode. |

**Response shape:**

```json
{
  "data": [
    { "id": 100, "page_index": 0, "filename": "001.jpg", "width": 1280, "height": 1840, "is_wide": false },
    ...
  ],
  "extracting": false,
  "total_pages": 200
}
```

- `extracting` is `true` only on a fresh fast-mode response while Phase 2 is still running. The client schedules a re-fetch loop while this is `true`; the loop re-anchors `currentPage` by page-index (not spread index) so Double Page (Manga) layout never jumps the user to a different page when dims update.
- `total_pages` is the planned page count — useful while `extracting: true` because rows for not-yet-extracted pages exist with their dims and IDs set.
- HTTP 410 if the chapter was removed mid-call (cancellation from `DELETE /api/manga/:id`, scanner pruning, etc).

`width`/`height` populated for every page. Folder chapters get them at scan time. CBZ chapters get them via fast-mode Phase 1 dim probe (256 KB header sniff per entry) OR via Phase 2's per-page sharp re-probe OR via the route's null-dim heal pass that re-reads `sharp.metadata()` on the extracted file. The healing path is what catches Phase 1 sniff failures — see [scanner.md § Fast mode](./scanner.md#fast-mode-first-page-fast).

`is_wide` is computed at serve time from `width`/`height` and is `true` whenever `width > height`. The reader uses this in Double Page (Manga) mode. `null` means dimensions are still unknown — the reader's defensive default renders unknown-dim pages **solo** rather than paired, so a wide spread whose dims aren't known yet can never be visually mispaired. See [reader.md § Double-Manga Spread Detection](./reader.md#double-manga-spread-detection).

### `POST /api/chapters/:id/prioritize-pages`

Body: `{ "page_indices": [80, 81, 82] }`. Moves the named page indices to the front of fast-mode Phase 2's work queue. Driven by the reader when the user scrubs or jumps. No-op when there's no active fast extraction (priority hints are only meaningful then). Returns 404 if the chapter row was deleted between the client's hint and the server processing it.

### `POST /api/pages/dims`

Client-side dimension reporter — the final safety net for Double Page (Manga) when every server-side probe path missed (Phase 1 256 KB header sniff failed, Phase 2's sharp.metadata also failed, cache-hit heal didn't run because rows look complete). The browser has already decoded the image when the reader's `<img onLoad>` fires, so `naturalWidth`/`naturalHeight` is authoritative for that page.

**Body:**

```json
{
  "dims": [
    { "page_id": 100, "width": 1280, "height": 1840 },
    ...
  ]
}
```

Batch limit 100 per request. Server validates each entry (positive integers, ≤30000 px) and silently drops out-of-range rows.

**Response:**

```json
{ "data": { "updated": 7 } }
```

The route runs one transaction of `UPDATE pages SET width=?, height=? WHERE id=? AND (width IS NULL OR height IS NULL)`. The `IS NULL` filter is the trust boundary — clients can fill in unknowns, never overwrite a server-probed value. Race with Phase 2's server-side re-probe is idempotent (both decode the same bytes, both write the same value, UPDATE filter ensures only the first writer's value lands).

Client behaviour: dim reports are buffered (Map keyed by `page_id` for dedupe) and flushed in batches when the buffer reaches 16 entries OR after 800 ms of inactivity. Offline failures are silently swallowed — the local pages-state patch in the reader still applies, so in-session Double Page (Manga) layout is correct even when the server-side persistence can't reach.

### `GET /api/pages/:id/image`

Page images are served via `res.sendFile`:

- **Folder chapters** — `res.sendFile(pages.path)` against the absolute filesystem path stored on the page row. Express handles `ETag`, `Last-Modified`, and conditional 304 responses.
- **CBZ chapters** — `cbzCache.ensureChapterExtracted(chapterId, chapterPath, { mode })` is called first to make sure the archive's per-chapter cache directory under `CBZ_CACHE_DIR/<chapterId>_<mtimeFloor>/` exists; if the cache was evicted since the chapter was opened it re-extracts on the fly. Mode inherits from `?fast=1`. If the requested page file is already on disk → `res.sendFile`. Otherwise wait on `waitForPageFile` for fast-mode Phase 2 to land the file. `Cache-Control: max-age=86400` is set on both branches via `sendFile`'s `maxAge` option, plus standard ETag / Last-Modified.

Error responses specific to fast mode:

- **HTTP 410 Gone** — chapter (or its archive) was removed while the request was waiting. The reader surfaces this as a distinct "this chapter is no longer available" screen with a back link, rather than retrying as a generic error.
- **HTTP 503 + `Retry-After: 2`** — fast-mode Phase 2 didn't extract the requested page within `CBZ_PAGE_WAIT_TIMEOUT_MS` (default 30 s), or the per-chapter waiter cap was hit. Client may retry once.

---

## Progress

| Method | Path | Description |
|---|---|---|
| GET | `/api/progress/:mangaId` | Get reading progress |
| PUT | `/api/progress/:mangaId` | Update progress (triggers AniList sync for the requesting device) |
| DELETE | `/api/progress/:mangaId` | Reset progress |
| PATCH | `/api/progress/:mangaId/chapter/:chapterId` | Mark a specific chapter as read or unread `{ completed: boolean }` |

**PUT body:**
```json
{
  "chapterId": 42,
  "page": 7,
  "markChapterComplete": false
}
```

**PATCH `/api/progress/:mangaId/chapter/:chapterId`**

Used by the chapter-level *Mark as Read* / *Mark as Unread* toggle on MangaDetail. Body: `{ "completed": true | false }`.

- When `completed: true`, the chapter ID is added to `completed_chapters`. The server also advances `current_chapter_id` to the next unread chapter in reading order — but only if the current chapter is at or behind the chapter being marked (so marking chapters 1, 2, 3 in sequence leaves *Continue Reading* pointing at chapter 4). If the current chapter is already further ahead, it is left alone.
- When `completed: false`, the chapter ID is removed from `completed_chapters`; `current_chapter_id` is untouched.
- Triggers a fire-and-forget AniList sync after the HTTP response, scoped to the requesting device.

**Progress response `data` shape:**
```json
{
  "id": 1,
  "manga_id": 5,
  "current_chapter_id": 42,
  "current_page": 7,
  "completed_chapters": [40, 41],
  "last_read_at": 1700000000,
  "updated_at": 1700000000
}
```

---

## Metadata

### Linkage and display priority

A manga can be linked to **AniList, MyAnimeList, MangaUpdates, and Doujinshi.info simultaneously**. Establishing a new linkage never breaks an existing one — the only way to remove a linkage is the explicit Break Linkage action (`POST /api/manga/:id/reset-metadata`). Adding a `metadata.json` to a manga's folder doesn't break linkages either; it just changes which fields are displayed.

**Display priority** (text fields only) decides which source's data populates `manga.title`, `manga.description`, `manga.status`, `manga.year`, `manga.genres`, `manga.score`, and `manga.author`:

| Priority | Source | Identified by |
| --- | --- | --- |
| 4 (highest) | local | `metadata_source = 'local'` (set by the scanner when `metadata.json` is present in the manga folder) |
| 3 | AniList | `metadata_source = 'anilist'` |
| 2 | MyAnimeList | `metadata_source = 'myanimelist'` |
| 1 | MangaUpdates | `metadata_source = 'mangaupdates'` |
| 0 | Doujinshi.info | `metadata_source = 'doujinshi'` |
| -1 | none | `metadata_source = 'none'` |

When a metadata fetch result is applied to a row, the server compares the incoming source's priority to `metadata_source`:

- **incoming ≥ current** — the displayed fields are rewritten with the new source's data and `metadata_source` is updated to the new source.
- **incoming < current** — only the linkage ID is written. Displayed fields stay where they are. The other source's data is still recorded so the user can see it from the Thumbnail Picker / Metadata modal.

In every case, **all four linkage IDs are written through `COALESCE`**. A NULL incoming value never overwrites an existing ID — that's the central invariant. Concretely:

- Apply MAL to an empty manga → `metadata_source = 'myanimelist'`, `mal_id` set.
- Apply AniList to a MAL-displayed manga → `metadata_source = 'anilist'` (3 > 2), `anilist_id` set, **`mal_id` preserved**.
- Apply MAL to an AniList-displayed manga → `metadata_source` stays `'anilist'` (2 < 3), `mal_id` set, AniList text fields untouched.
- Drop a `metadata.json` on a manga linked to AniList and MAL → scanner switches `metadata_source` to `'local'`; `anilist_id` and `mal_id` are untouched. Apply AniList again afterwards → display stays local (4 > 3), AniList linkage refreshed.
- Break only AniList → `anilist_id` cleared, `mal_id` and local fields preserved.

This priority drives both the bulk pull and every single-manga refresh / apply route.

#### Active-cover priority (independent of text-field priority)

The active cover (`<mangaId>.webp`) is chosen by a **separate** priority order and **does not include local** — local JSON sidecars only swap text fields:

```text
anilist_cover > mal_cover > mangaupdates_cover > doujinshi_cover > original_cover
```

Every metadata-apply path stores the fetched cover into its source-specific column (`anilist_cover` / `mal_cover` / `mangaupdates_cover` / `doujinshi_cover`) and then calls `reinforceActiveCover` from [server/src/scanner/coverResolver.js](../server/src/scanner/coverResolver.js), which copies the highest-priority on-disk file into `<mangaId>.webp`.

A manual user pick via `POST /api/manga/:id/set-thumbnail` sets `manga.cover_user_set = 1`. From that point on, subsequent metadata fetches only refresh the source-specific column — they never touch the active cover. The pick is **sticky across library scans**: the post-scan reinforcement pass calls `reinforceAllCovers(force = false)` and skips manga with this flag set.

The only path that clears the flag and re-aligns to the priority order is the explicit `POST /api/admin/reset-thumbnails` admin action (Settings → Database), which calls `reinforceAllCovers(force = true)`. It re-uses cover files already on disk and never pings any upstream. See [scanner.md § Cover priority](./scanner.md#cover-priority).

### AniList

| Method | Path | Description |
|---|---|---|
| POST | `/api/manga/:id/refresh-metadata` | Auto-fetch from AniList by title |
| POST | `/api/manga/:id/apply-metadata` | Apply a specific AniList result `{ anilist_id }` |
| GET | `/api/anilist/search?q=&page=` | Search AniList by title (manual search) |
| GET | `/api/manga/:id/anilist-status` | Get user's AniList list entry for this manga (per-device 5-minute cache; only re-fetches on miss / stale) |
| PATCH | `/api/manga/:id/anilist-progress` | Manually update AniList progress (refreshes the cached list entry with the post-mutation value) |

Both `refresh-metadata` and `apply-metadata` write the `author` field in addition to the standard metadata fields. See [anilist.md](./anilist.md) for how the author name is extracted from the AniList staff list.

Every successful by-ID and search response is also written to a per-source JSON cache file at `data/metadata-cache/anilist/<id>.json`. The Export Metadata flow reads exclusively from that cache — it never re-pings AniList. AniList is contacted **only** in response to direct user activity: search/refresh/apply, the bulk metadata pull, the per-chapter progress sync (`PUT /api/progress/:mangaId`), one-off OAuth events, and a stale `anilist-status` lookup. See [anilist.md § When the server pings AniList](./anilist.md#when-the-server-pings-anilist) for the complete enumeration.

### Doujinshi.info

| Method | Path | Description |
|---|---|---|
| POST | `/api/manga/:id/refresh-doujinshi-metadata` | Auto-fetch from Doujinshi.info by title |
| POST | `/api/manga/:id/apply-doujinshi-metadata` | Apply a specific result `{ slug }` |
| GET | `/api/doujinshi/search?q=&page=` | Search Doujinshi.info by title (manual search) |

Spaces in the `q` parameter are automatically replaced with underscores before the upstream request is made (see [doujinshi.md](./doujinshi.md#search-mechanics)).

### MyAnimeList

| Method | Path                                    | Description                                          |
| ------ | --------------------------------------- | ---------------------------------------------------- |
| POST   | `/api/manga/:id/refresh-mal-metadata`   | Auto-fetch from MyAnimeList by title                 |
| POST   | `/api/manga/:id/apply-mal-metadata`     | Apply a specific MAL result `{ mal_id }`             |
| GET    | `/api/mal/search?q=&page=`              | Search MyAnimeList by title (manual search)          |

All three endpoints require a MAL Client ID to be configured in Settings (`mal_client_id`). Requests use the `X-MAL-CLIENT-ID` header — no OAuth login is required.

`refresh-mal-metadata` applies the same title-cleaning as the AniList equivalent (strips parenthetical suffixes, brackets, and curly-brace content, normalises hyphens/underscores to spaces).

Author is extracted from the `authors` field of the MAL response, preferring entries with role `"Story & Art"`, `"Story"`, or `"Art"`. If none of those roles match, the first listed author is used as a fallback.

`/manga` calls send `nsfw=true` so adult titles are returned alongside SFW ones — without it MAL silently filters them out, which would mask titles the on-disk library scanner already indexed.

### MangaUpdates

| Method | Path                                                | Description                                          |
| ------ | --------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/api/manga/:id/refresh-mangaupdates-metadata`      | Auto-fetch from MangaUpdates by title                |
| POST   | `/api/manga/:id/apply-mangaupdates-metadata`        | Apply a specific result `{ mangaupdates_id }`        |
| GET    | `/api/mangaupdates/search?q=&page=`                 | Search MangaUpdates by title (manual search)         |

No auth required — Momotaro only calls the public read endpoints (`POST /v1/series/search` and `GET /v1/series/{id}`). The OpenAPI spec does describe a Bearer auth scheme, but it's only required for user-scoped endpoints (lists, ratings) which Momotaro doesn't consume.

MangaUpdates does not publish a rate limit. The acceptable use policy asks for "reasonable spacing between requests so as not to overwhelm the MangaUpdates servers, and employ caching mechanisms when accessing data." Momotaro paces ~1 req/sec sequential and ~3 req/sec via the bulk concurrency pool, with a shared 429/503 cooldown that pauses every concurrent worker on push-back. See [mangaupdates.md § Rate Limiting & Bulk Throughput](./mangaupdates.md#rate-limiting--bulk-throughput).

### Export Metadata (per-manga)

| Method | Path                             | Description                                          |
| ------ | -------------------------------- | ---------------------------------------------------- |
| POST   | `/api/manga/:id/export-metadata` | Write `metadata.json` to this manga's folder on disk |

Writes a `metadata.json` sidecar file to `{manga.path}/metadata.json`. The **on-disk file is always overwritten** when this endpoint succeeds — `fs.writeFileSync` is unconditional, so calling export with the file already present replaces it with the freshly-built payload.

**Export never pings AniList, MAL, MangaUpdates, or Doujinshi.info.** It serialises whichever record was previously cached during a prior fetch — either from the on-disk JSON cache (`data/metadata-cache/<source>/<id>.json`) or the manga row itself. If a per-source export is requested for a source that has never been fetched, the endpoint returns `409` with a hint to refresh that source first.

**Request body** (optional):

```json
{ "source": "anilist" | "myanimelist" | "mangaupdates" | "doujinshi" }
```

Two modes:

- **Per-source export** (`source` provided) — emit THAT specific source's previously-pulled record, regardless of which source the manga currently displays. Lookup order:
   1. `data/metadata-cache/<source>/<id>.json` (written on every successful fetch).
   2. The manga row itself, if `metadata_source` matches the requested source (covers legacy rows that pre-date the JSON cache).

  If neither is available the response is `409` with the message *"No previously-pulled `<source>` metadata found for this manga. Refresh the `<source>` linkage first; export will not re-ping `<source>`."* The exported `metadata_source` field reflects the source the export was issued for, not the manga's row-level `metadata_source`. Returns 400 if `<source>_id` is null on the manga.

- **Auto / priority-ordered** (no `source`) — emit whichever upstream record is in the cache, in priority order **AniList → MyAnimeList → MangaUpdates**. Falls through to the DB row if no cache entry exists for any linkage. Returns 400 if the manga has no third-party linkage at all.

The DB row is never modified by export. Includes all non-null metadata fields plus `metadata_source` and `exported_at`. See the [library-level Export Metadata](#export-metadata) section for the full file format.

**Response shape:**

```json
{ "data": { "path": "/library/My Manga/metadata.json", "source": "anilist" } }
```

The `source` field is only present in the per-source mode response.

### Reset Metadata

| Method | Path                            | Description                                                  |
| ------ | ------------------------------- | ------------------------------------------------------------ |
| POST   | `/api/manga/:id/reset-metadata` | Break external linkage; optionally clear sourced fields      |

**Request body** (optional):

```json
{ "source": "anilist" | "myanimelist" | "mangaupdates" | "doujinshi" }
```

**The Break Linkage button is the only way a linkage is ever cleared** — applying metadata, importing config, dropping a `metadata.json`, or running bulk pulls all preserve linkages. See [Linkage and display priority](#linkage-and-display-priority) for the full apply-side guarantee.

Behavior depends on whether `source` is supplied:

- **`source` omitted** — full reset. Clears `anilist_id`, `mal_id`, `mangaupdates_id`, `doujinshi_id`, all sourced metadata fields (`description`, `status`, `year`, `genres`, `score`, `author`), sets `metadata_source = 'none'`, and clears `last_metadata_fetch_attempt_at`. No fallback fetch — every linkage is gone.
- **`source` supplied, matches `metadata_source`** — the broken source's ID (`anilist_id` / `mal_id` / `mangaupdates_id` / `doujinshi_id`) and cover column (`anilist_cover` / `mal_cover` / `mangaupdates_cover` / `doujinshi_cover`) are nulled, the row is committed at `metadata_source = 'none'`, **and then a priority-ordered fallback fetch runs** (see [Fallback after Break Linkage](#fallback-after-break-linkage) below). If a remaining linkage produces a usable record, the displayed fields are repopulated from that source and `metadata_source` is updated accordingly. If none does, the row stays at `'none'` with cleared fields.
- **`source` supplied, does *not* match `metadata_source`** (e.g. source is `'anilist'` but the manga displays `'local'` or `'myanimelist'`) — **link-only break**. Only the specified source's `*_id` and `*_cover` are nulled. All metadata fields, `metadata_source`, and any other linkage IDs are preserved. No fallback fetch is needed because the displayed source wasn't the one being broken. This is the common case now that linkages persist independently of the display source.

Per-field summary:

| Field | Full reset | Match-source break (with fallback) | Link-only break |
| --- | --- | --- | --- |
| `<source>_id` | `NULL` | `NULL` | `NULL` |
| `<source>_cover` | `NULL` | `NULL` | `NULL` |
| `metadata_source` | `'none'` | next-priority remaining source, or `'none'` if no fallback succeeds | unchanged |
| sourced fields (desc / status / year / genres / score / author) | `NULL` | rewritten from the fallback source, or `NULL` if no fallback succeeds | unchanged |
| `last_metadata_fetch_attempt_at` | `NULL` | `NULL`, then re-stamped if the fallback fetch hits the network | unchanged |

**Reset Metadata does not change the active cover directly.** The fallback path (when one applies) calls `reinforceActiveCover` after writing fields, so a successful fallback realigns the active cover to the new displayed source. When no fallback applies (link-only break, or full reset with no remaining linkages), the cover is left untouched and the priority resolver picks up the change on the next scan or `POST /api/admin/reset-thumbnails`.

Returns the updated manga row reflecting the post-fallback state. Use the full-reset form when the wrong title was auto-matched; use the per-source form to detach a single source while keeping the rest of the manga's metadata in place.

#### Fallback after Break Linkage

When the broken source matches `metadata_source` and another linked source still exists, `applyFallbackMetadata` (in [server/src/routes/metadata.js](../server/src/routes/metadata.js)) runs the priority order — `anilist > myanimelist > mangaupdates > doujinshi`, skipping the source being broken — and stops at the first remaining linkage that produces a normalized record:

1. **Cache hit** — reads the previously-saved record from `data/metadata-cache/<source>/<id>.json` and re-applies it without any network call. Every successful prior fetch (refresh, apply, bulk, single-source pull) writes its normalized result here, so the common case is cache-hit and the break completes synchronously with no upstream ping.
2. **Network fallback** — if the cache has no record for the chosen source, the helper makes one live request to that source (AniList by ID, MAL by ID with the configured Client ID, MangaUpdates by ID, Doujinshi by slug). Failures fall through to the next candidate.
3. **No fallback possible** — if every remaining candidate is empty or fails, the row stays at `metadata_source = 'none'` with cleared fields. The original break is *not* rolled back; the linkage really is gone.

Local metadata is intentionally not handled by the fallback path. At apply time `local` outranks every third-party source, so the only way for the displayed source to be a third party is for `metadata.json` not to exist; there's nothing to read at reset time. If a user later drops a `metadata.json`, the next scan picks it up.

The same `applyFallbackMetadata` helper drives the [end-of-scan metadata-priority enforcement pass](./scanner.md#end-of-scan-metadata-priority-enforcement) (with `brokenSource = null`), so the apply behaviour and ID-coalesce semantics are identical to a Break Linkage fallback.

### Bulk Metadata Pull

`POST /api/libraries/:id/bulk-metadata` accepts an optional body:

```json
{ "source": "anilist" }
```

`source` can be `"anilist"` (default), `"myanimelist"`, `"mangaupdates"`, or `"doujinshi"`. The endpoint responds immediately; the actual fetch loop runs in the background.

**The bulk pull always runs over every title in the library — it never refuses.** Each manga is sorted into one of two phases up-front:

| Phase | Selected when | What happens |
| --- | --- | --- |
| **Refresh by ID** | The manga has the source's linkage ID set (`anilist_id` / `mal_id` / `mangaupdates_id` / `doujinshi_id`) | The endpoint fetches the canonical record by ID — no search, no ambiguity. The result is then applied with the priority-aware writer described under [Linkage and display priority](#linkage-and-display-priority): linkages from other sources are preserved unconditionally, displayed fields are overwritten only when this source's priority is ≥ current. |
| **Search by title** | No linkage ID for the chosen source | The folder-derived title runs through the shared `cleanSearchTitle` helper before the search, stripping release-group brackets, volume / chapter markers, year ranges, and quality tags (e.g. `"Fruits Basket Another (2018-2022) (Digital) (1r0n)"` → `"Fruits Basket Another"`). Results are then applied with the same priority-aware writer. |

**Title cleaning rules** (applied to both new searches and the single-manga `refresh-metadata`-family endpoints):

- Bracketed groups: `{...}`, `[...]`, `(...)` — repeatedly, so nested brackets collapse.
- Volume markers: `Vol.01`, `Volume 3`, `v01`, `v01-05`, `v.1`.
- Chapter markers: `Ch.01`, `Chapter 03`, `c05`, `c.05`.
- 4-digit year ranges: `1997-2003`, `2018–2022`.
- Release-quality / status words: `Digital`, `HD`, `HQ`, `LQ`, `Raw`, `Complete`, `Ongoing`, `Omnibus`, `Uncensored`, `WebRip`, `Fix`, etc.
- Hyphens / underscores collapse to spaces; whitespace is normalised.

The shared cleaner lives in [server/src/metadata/anilist.js](../server/src/metadata/anilist.js) → `cleanSearchTitle` and is consumed by AniList, MyAnimeList, and Doujinshi.info via re-export.

**Cooldown:** the bulk endpoint stamps `last_metadata_fetch_attempt_at` after each title is processed, but it no longer respects the cooldown when deciding what to do — bulk is a manual, user-initiated action and is expected to refetch on demand. (The post-scan automatic metadata fetch still honours the cooldown via the same column.) `POST /api/manga/:id/reset-metadata` continues to clear the timestamp.

**AniList batching** — both phases use one GraphQL request per `ANILIST_BATCH_SIZE = 10` titles, via aliased `Media(id: …)` (refresh) or `Media(search: …)` (search) blocks. 10 aliases per request keeps query complexity well below AniList's ceiling while halving outbound HTTP count vs. the previous 5-per-batch. MyAnimeList and Doujinshi.info have no alias equivalent and run sequentially with per-source delays (1000 ms / 500 ms).

**Adaptive AniList pacing** — every successful AniList response is read for `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. The bulk loop pulls its inter-request sleep from `recommendedDelayMs()` between calls, so:

- When AniList signals the standard 90 req/min limit, the loop spaces requests at ~717 ms.
- When AniList temporarily degrades the limit to 30 req/min (a documented condition that has occurred in production), the loop automatically shifts to ~2050 ms spacing — no 429s, no manual intervention.
- When `X-RateLimit-Remaining` drops to ≤ 5 within a window, the loop stretches per-call delay so the remaining budget lands after `X-RateLimit-Reset`.
- A 429 still triggers the existing `Retry-After`-respecting back-off and pins the next call to the slowest setting (5 000 ms) until headers indicate health restored.

This adaptive pacing also drives the per-manga `POST /api/libraries/:id/export-metadata` route's AniList re-fetch step.

**Adult content** — Single-manga AniList search/refresh/apply queries do **not** pass `isAdult`, so AniList returns both adult and SFW titles together (matching what the library scanner already indexed on disk). The bulk-by-title AniList batch path (`fetchBatchFromAniList`) currently does send `isAdult: false` per alias, so the bulk title-search phase will only match SFW results — pre-linked manga (the refresh-by-ID phase) and per-manga manual searches are unaffected. MyAnimeList's `/manga` endpoint sends `nsfw=true`, opting into the gray and black NSFW grades (default would silently filter them out).

**Cover promotion** — driven by the same display priority. A source's cover is always downloaded into its dedicated column (`anilist_cover`, `mal_cover`) on a successful fetch, so the Thumbnail Picker can offer it later. The active `cover_image` is only swapped when the incoming source becomes the new display source, which means: AniList replaces MAL/none/doujinshi covers, MAL replaces only doujinshi/none, MAL never overwrites an AniList cover or a local-displayed manga's cover.

**Single-manga endpoints** (`refresh-metadata`, `apply-metadata`, `refresh-mal-metadata`, `apply-mal-metadata`, `refresh-doujinshi-metadata`, `apply-doujinshi-metadata`) all use the same priority-aware writer as bulk. They never force-promote — clicking *Apply MAL* on an AniList-displayed manga records the MAL linkage and saves the MAL cover to `mal_cover` but leaves the visible cover and displayed fields untouched. To swap display source, the user can either pick the higher-priority source's *Apply* (e.g. AniList) or use Break Linkage to drop the current source first.

**Response shape:**
```json
{
  "message":    "Bulk metadata pull started",
  "total":      50,
  "to_refresh": 38,
  "to_search":  12,
  "source":     "anilist"
}
```

- `total` — every manga in the library
- `to_refresh` — manga that will be refreshed by their existing linkage ID for the chosen source
- `to_search` — manga that will be searched by cleaned title

**Rate limiting** — AniList request spacing is **adaptive** (see *Adaptive AniList pacing* above). MyAnimeList is fixed at 1 000 ms per request (`MAL_REQUEST_INTERVAL_MS`). Doujinshi.info is fixed at 500 ms; each title requires two upstream calls (search + fetch-by-slug).

**Server logs** — progress is logged per-title as `(X/Y) Refreshed / Applied / Linked / No match / Error`, with a final summary line reporting each counter.

### Export Metadata

`POST /api/libraries/:id/export-metadata` writes a `metadata.json` sidecar file into each manga's folder. No request body is required.

Export behaviour per title (linkage is the primary signal — `metadata_source` only matters when no linkage is present):

| Has any linkage (`anilist_id` / `mal_id` / `doujinshi_id`) | `metadata_source` | Action |
| --- | --- | --- |
| Yes | any | **Re-fetch** from the highest-priority linked source (AniList > MyAnimeList > Doujinshi.info) and write that data to `metadata.json`, **overwriting any existing file** including a hand-edited local one. DB is not modified, so in-app display continues to use whatever `metadata_source` already pointed at. Falls back to DB-stored fields if every fetch attempt fails and `metadata_source` is a third-party tag. |
| No | `'anilist'` / `'myanimelist'` / `'doujinshi'` | Write DB fields to `metadata.json`. (Edge case: third-party-sourced fields with no linkage ID, e.g. legacy data.) |
| No | `'local'` or `'none'` | Skip — there is nothing third-party to export. |

This is the path the user uses to **replace a hand-curated `metadata.json` with fresh AniList or MAL data**: trigger Bulk Export and the sidecar will be rewritten from whichever third-party source the manga is linked to, AniList preferred. The `metadata_source` of the row never changes — if `metadata_source = 'local'`, the in-app display stays on the local fields after the rewrite. To move display to the third-party source, the user can run a Bulk Metadata Pull afterwards (or click Apply on the linked source's tab in the Metadata modal).

The endpoint is not fully synchronous — it issues upstream HTTP requests per linked manga. AniList fetches use the adaptive spacing driven by the `X-RateLimit-Limit` header; MyAnimeList uses `MAL_REQUEST_INTERVAL_MS`; Doujinshi.info uses 500 ms. The client allows up to 10 minutes per request (`timeoutMs: 600_000`) for large libraries.

**Response shape:**
```json
{
  "data": {
    "total": 50,
    "exported": 38,
    "exported_local": 4,
    "skipped": 12,
    "errors": 0
  }
}
```

- `total` — total manga in the library
- `exported` — total number of `metadata.json` files written (includes `exported_local`)
- `exported_local` — subset of `exported` where a manga whose displayed source is `'local'` had its sidecar overwritten with freshly-fetched third-party data
- `skipped` — manga with no linkage AND no third-party-sourced fields in the DB (i.e. nothing third-party to export)
- `errors` — manga whose folder could not be written to (permissions, path missing, etc.); these are logged server-side

**Written file** — each `metadata.json` is pretty-printed JSON written to `{manga.path}/metadata.json`. It includes only non-null fields. Example:

```json
{
  "title": "My Manga",
  "author": "Last First",
  "description": "Synopsis text...",
  "genres": ["Action", "Drama"],
  "year": 2020,
  "score": 8.3,
  "status": "FINISHED",
  "anilist_id": 12345,
  "metadata_source": "anilist",
  "exported_at": "2026-04-16T12:00:00.000Z"
}
```

The file uses the same field names recognised by the local metadata scanner (`title`, `author`, `description`, `genres`, `year`, `score`), so a library rescan after a database reset will automatically pick them up as `metadata_source = 'local'`. Extra fields (`status`, `anilist_id`, `mal_id`, `doujinshi_id`, `metadata_source`, `exported_at`) are preserved in the file for reference but are not consumed by the scanner.

---

## Third Party Sourcing

Routes that drive the in-app downloader, per-manga URL log, and per-manga schedule poller. All routes are mounted under `/api/sources/*` (discovery + downloads + match), `/api/manga/:id/source-urls*` (URL log), `/api/manga/:id/schedule*` (schedule editor), and `/api/manga/:id/link-source*` (legacy direct-column linkage). The full surface — request bodies, response shapes, adapter-specific notes, and the scheduler poll-loop — is documented in [sources.md](./sources.md). A condensed list:

| Method | Path | Description |
|---|---|---|
| GET | `/api/sources` | Available source adapters (id, label, homepage) |
| GET | `/api/sources/:source/search?q=…` | Title search at one source |
| GET | `/api/sources/:source/series/:id` | Series detail |
| GET | `/api/sources/:source/series/:id/chapters?lang=en[&manga_id=…]` | Chapter list annotated with `already_downloaded` |
| POST | `/api/sources/:source/download` | Enqueue chapters into the persistent download queue |
| GET | `/api/sources/downloads?limit=50` | Recent jobs newest-first |
| DELETE | `/api/sources/downloads/:id` | Cancel queued or running job |
| POST | `/api/sources/downloads/:id/retry` | Re-queue a failed/cancelled job |
| POST | `/api/sources/downloads/clear-finished` | Drop done/failed/cancelled rows |
| GET | `/api/sources/match-existing?title=…` | FTS5 lookup against the user's library for the "Add to existing series" picker |
| GET / POST / PATCH / DELETE | `/api/manga/:id/source-urls[/:urlId]` | Per-manga URL log — see [sources.md § Source linkage](./sources.md#source-linkage) |
| GET | `/api/schedules` | Every schedule with each manga's URLs embedded |
| GET / PUT / DELETE | `/api/manga/:id/schedule` | Per-manga schedule editor |
| POST | `/api/manga/:id/schedule/run-now` | One-shot check independent of the schedule |
| POST | `/api/manga/:id/link-source` | Legacy direct linkage — set `<source>_id` without writing to `manga_source_urls`. Prefer the `/source-urls` routes for user-facing workflows. |
| DELETE | `/api/manga/:id/link-source/:source` | Legacy linkage clear |

---

## Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get settings; AniList login state is scoped to `X-Device-ID` |
| PUT | `/api/settings` | Save `{ anilist_client_id?, anilist_client_secret? }` |

**GET response `data` shape:**
```json
{
  "anilist_client_id": "12345",
  "anilist_client_secret_set": true,
  "anilist_token_set": true,
  "anilist_logged_in": true,
  "anilist_user_id": "67890",
  "anilist_username": "myuser",
  "anilist_avatar": "https://...",
  "doujinshi_logged_in": true,
  "mal_client_id_set": true,
  "tps_max_concurrent_chapters": 1,
  "tps_page_delay_ms": 500
}
```

`anilist_token_set` and `anilist_logged_in` reflect the session for the requesting device only. `doujinshi_logged_in` is server-wide (true whenever a doujinshi token is stored in `settings`). `mal_client_id_set` is server-wide (true whenever a MAL Client ID is stored). `tps_*` are the live Third Party Sourcing downloader knobs — exposed in Settings → Third Party Sourcing and applied via `downloader.applySettings()` on every PUT.

**PUT accepts** `{ anilist_client_id?, anilist_client_secret?, mal_client_id?, tps_max_concurrent_chapters?, tps_page_delay_ms? }`. All fields are optional; only provided fields are written. Empty-string values clear the AniList / MAL credential fields. `tps_max_concurrent_chapters` is bounded `[1, 8]` and `tps_page_delay_ms` is bounded `[0, 60000]` — out-of-range values return `400`.

> CBZ cache size and the auto-clear schedule are *not* read or written through `/api/settings` — they live under their own route pair, `GET`/`PUT /api/admin/cbz-cache-settings` (see [Admin → CBZ Cache Settings](#cbz-cache-settings)). They are still persisted into the underlying `settings` table (keys prefixed `cbz_cache_*`), so they travel with config exports and survive server restarts.

---

## AniList Auth (OAuth)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/anilist/exchange` | Exchange OAuth code for token — requires `X-Device-ID` |
| DELETE | `/api/auth/anilist` | Log out — clears session for the requesting device only |

**POST `/api/auth/anilist/exchange` body:**
```json
{
  "code": "AUTH_CODE",
  "redirect_uri": "http://yourhost/auth/anilist/callback"
}
```

Returns `{ username, avatar }` on success. Requires `X-Device-ID` header — returns 400 without it.

---

## Doujinshi.info Auth

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/doujinshi/login` | Log in with email + password — stores token server-wide |
| DELETE | `/api/auth/doujinshi` | Log out — clears doujinshi tokens from `settings` |

**POST `/api/auth/doujinshi/login` body:**
```json
{
  "email": "user@example.com",
  "password": "yourpassword"
}
```

Returns `{ logged_in: true }` on success. Unlike AniList, the token is shared across all devices. See [doujinshi.md](./doujinshi.md) for full details.

---

## Reading Lists

| Method | Path | Description |
|---|---|---|
| GET | `/api/reading-lists` | List all reading lists with manga counts |
| POST | `/api/reading-lists` | Create list `{ name }` |
| DELETE | `/api/reading-lists/:id` | Delete custom list (built-in lists cannot be deleted) |
| GET | `/api/reading-lists/:id/manga` | Manga in a list (supports `?search=`, `?sort=`) |
| POST | `/api/reading-lists/:id/manga` | Add manga `{ manga_id }` |
| DELETE | `/api/reading-lists/:id/manga/:mangaId` | Remove manga from list |
| GET | `/api/manga/:id/reading-lists` | List IDs of reading lists containing this manga |

---

## Optimization

| Method | Path | Description |
|---|---|---|
| POST | `/api/manga/:id/optimize` | Convert chapter folders to CBZ, optionally repack `.7z` archives via the system 7-Zip binary, and standardise chapter names. Triggers a `scanMangaDirectory` re-scan when finished. |
| POST | `/api/libraries/:id/bulk-optimize` | Run the same optimisation across every manga in the library. Responds immediately; the work runs in the background. Used by the **Bulk Optimize** button in Settings → Libraries. |

---

## Home

`GET /api/home` — single aggregate endpoint powering the Home landing page. Everything is scoped to libraries visible in the **All Libraries** view (`libraries.show_in_all = 1`, or `manga.library_id IS NULL`) — a library hidden from All Libraries is invisible on Home too, across every ribbon.

**Query parameters** (all optional, bounded server-side):

| Param | Default | Max | Purpose |
| --- | --- | --- | --- |
| `continue_limit` | 15 | 50 | Rows in the Continue Reading ribbon |
| `discover_limit` | 30 | 60 | Candidate rows in the Discover pool (client slices this to ~15 visible) |
| `gallery_limit`  | 50 | 100 | Rows in the Art Gallery ribbon |
| `ribbon_limit`   | 50 | 100 | Candidate pool size per "Top Manga in XXX" ribbon (client picks a stable seeded-random ~15 visible slice) |
| `recent_limit`   | 15 | 30 | Rows in the Recently Added ribbon |
| `min_score`      | 7 | n/a | Minimum AniList/MAL score (clamped to `[0, 10]`) for the per-genre ribbons. Titles with `score < min_score` or `score IS NULL` are excluded from `favorite_genres_ribbons[].manga`. |

**Response `data` shape:**

```json
{
  "continue_reading": [
    {
      "id": 5, "title": "...", "cover_url": "/thumbnails/...",
      "track_volumes": 0,
      "current_chapter_id": 42,
      "current_chapter": { "id": 42, "folder_name": "...", "number": 14, "volume": null },
      "current_page": 5,
      "total_chapters": 120,
      "completed_count": 13,
      "last_read_at": 1713900000
    }
  ],
  "discover_candidates": [
    { "id": 10, "title": "...", "cover_url": "...", "score": 8.5, "match_count": 3 }
  ],
  "recently_added": [
    { "id": 22, "title": "...", "cover_url": "...", "score": null, "created_at": 1713900000 }
  ],
  "art_gallery": [
    {
      "id": 12, "manga_id": 5, "manga_title": "...", "track_volumes": 0,
      "chapter_id": 42, "chapter_folder_name": "Chapter 14",
      "chapter_number": 14, "chapter_volume": null,
      "page_id": 412, "page_index": 6,
      "page_image_url": "/api/pages/412/image",
      "created_at": 1713900000
    }
  ],
  "favorite_genres_ribbons": [
    { "genre": "Action", "manga": [{ "id": 1, "title": "...", "cover_url": "...", "score": 9.4 }] }
  ]
}
```

**Per-ribbon semantics:**

- **`continue_reading`** — rows from `progress` sorted `last_read_at DESC`, joined to manga + current chapter. `total_chapters` is the count of chapter rows for the manga; the client uses `completed_count / total_chapters` to draw the progress bar. Filtered to visible libraries.
- **`discover_candidates`** — top favorite genres are computed exactly as in `/api/stats` (reading-history weighted, visible libraries only) and truncated to 4. Every manga in a visible library that has **no progress row** (or an empty `completed_chapters`) is scored by how many distinct favorite genres it matches; the top N are returned in `(match_count DESC, score DESC NULLS LAST, id ASC)` order. The client then picks a stable seeded-random slice for the Discover ribbon (see *Discover refresh cadence* below). The same pool feeds the Discover ribbon's **Surprise me** button, which navigates to a randomly chosen entry's detail page.
- **`recently_added`** — newest manga rows by `created_at DESC, id DESC`, scoped to visible libraries. Surfaces titles produced by the most recent scan without forcing a Library re-sort.
- **`art_gallery`** — `art_gallery` rows joined to `manga` + `chapters` + `pages`, newest first, visible libraries only. The pre-built `page_image_url` spares the client from hand-composing it.
- **`favorite_genres_ribbons`** — up to 4 entries (one per top favorite genre). Each entry's `manga` list is a **candidate pool**: every manga in a visible library tagged with that genre whose AniList/MAL score is non-NULL and `>= min_score`, ordered by `id ASC` (deterministic). Randomisation happens client-side — the client shuffles the pool with `discoverSeed XOR hash(genre)` and slices to ~15 visible, so each genre rotates independently from the others while sharing the same Discover refresh cadence. Genres with zero matching manga at the current threshold are omitted, so the returned array may be shorter than 4. Raise / lower `min_score` (default 7, exposed in Settings → Homepage Settings) to broaden or narrow the pool.

**Caching:** 30-second in-memory TTL keyed by `min_score` (so different per-device thresholds don't fight a single global cache slot). The endpoint also sets `Cache-Control: private, max-age=30, stale-while-revalidate=300` so the browser HTTP cache backs up the service worker for non-PWA tabs and incognito windows. The service worker additionally caches `/api/home` under its `browse-data` StaleWhileRevalidate rule (30-day expiry); the cache key includes the query string, so each unique `min_score` gets its own SW entry.

**Efficiency:** every query hits indexed columns (`progress.manga_id` PK, `manga_genres` PK, `manga(library_id)`, `chapters(manga_id)`, `art_gallery(manga_id)`). No `json_each` over unindexed columns; the `discover_candidates` query scans at most `manga × avg_genre_count` rows and stops at the LIMIT clause. Memory footprint is bounded by the cache + whatever `better-sqlite3` prepared-statement handles are retained — the row caps above ensure a single response fits in well under 100 KB for typical libraries.

**Discover refresh cadence** — the **server** always returns the same deterministic top-N candidate pool (stable for a given library state). The *visible* 15-item slice is chosen by the **client** from a seeded shuffle of those candidates; the seed is persisted in `localStorage` and rotates on a user-chosen interval (default daily), so the same candidate pool produces different visible picks day-to-day without extra server load. See [frontend.md § Home](./frontend.md#home-srcpageshomejsx).

---

## Genres

`GET /api/genres` — every distinct genre across **visible libraries** (same scope as Home: `libraries.show_in_all = 1` or `manga.library_id IS NULL`), each paired with a count of tagged manga and the cover of the highest-scored manga in that genre. Powers the Browse By Genre page (`/genres`).

**Response `data` shape:**

```json
[
  { "genre": "Mystery",  "manga_count": 14, "cover_url": "/thumbnails/.../25.webp" },
  { "genre": "Romance",  "manga_count": 31, "cover_url": "/thumbnails/.../12.webp" }
]
```

- Returned in alphabetical order (`g.genre ASC`).
- `cover_url` is the cover of the highest-scored manga tagged with that genre, with `NULL` scores sinking to the bottom of the ranking. Returns `null` when no manga in the genre has a stored thumbnail.
- The Browse By Genre page renders each tile with `cover_url` faded behind the genre name; clicking a tile navigates to `/library` with the genre name pre-filled in the search box, where the existing search route resolves it via the normalised `manga_genres` table — no separate genre filter API was added.

**Caching (3 layers).** The genre list barely changes — it only mutates when a scan finds a new genre tag or metadata apply rewrites a manga's `genres` JSON — so the endpoint is aggressively cached at every layer:

1. **Service worker** — `/api/genres` is registered under the `browse-data` StaleWhileRevalidate rule (alongside `/api/home`, `/api/library`, `/api/stats`, etc.), 500 entries / 30 days. Repeat visits to `/genres` paint **instantly from disk cache** without a network round-trip; the SW background-fetches a fresh response and updates the cache for next time. Most "click Browse By Genre" actions never hit the server at all after the first visit.
2. **Browser HTTP cache** — `Cache-Control: private, max-age=300, stale-while-revalidate=600` so non-PWA tabs / incognito (where the SW isn't active) still get 5 minutes of pure-cache hits.
3. **Server in-memory payload** — built lazily on first request, then **pinned until the CBZ cache auto-clear scheduler fires** (lives in [`server/src/genresCache.js`](../server/src/genresCache.js)). The schedule lives in Settings → Database (`Off` / `Daily` / `Weekly` at a chosen time); whenever the auto-clear timer wipes the CBZ cache, it also calls `genresCache.precompute()` so the per-genre top-cover sub-queries fire once on that schedule rather than on every visitor's request. When auto-clear is `Off`, the payload is computed once on first hit after server start and stays pinned for the lifetime of the process — by the user's explicit choice. Server restart and explicit `precompute()` calls are the only other times the queries run.

The combined effect is that under typical usage the Browse By Genre page costs **zero queries** to open: the SW serves instantly, and even when it revalidates, the server returns a precomputed in-memory payload. The expensive cover-resolution sub-queries fire at most once per scheduled CBZ auto-clear (i.e. once a day or once a week, depending on the user's setting), not on a periodic timer and not on every reader's request.

**Efficiency:** the outer query is a single GROUP BY on the indexed `manga_genres` table joined to `manga` for the visible-library filter. The per-row correlated subquery picks the top cover via `(score DESC NULLS LAST, id ASC)` and stops at LIMIT 1; on libraries with hundreds of distinct genres this is still bounded by `genres × log(manga_per_genre)` index probes — even on a cold cache the request is well under the 30 ms range.

---

## Statistics

| Method | Path | Description |
|---|---|---|
| GET | `/api/stats` | Library statistics; optional `?library_id=N` scopes every aggregate to one library (cached 5 minutes per scope) |

**Query parameters:**

- `library_id` *(optional)* — positive integer. When omitted, every aggregate is scoped to libraries visible in the **All Libraries** view (`libraries.show_in_all = 1`, or `manga.library_id IS NULL`) — a library hidden from All Libraries is excluded from these counts, sums, rankings, and the read-time estimate too, matching the visibility rule already enforced for `/api/library`, `/api/home`, `/api/genres`, and `/api/gallery`. When provided, every aggregate is scoped to that single library regardless of its `show_in_all` flag (so per-library stats are still inspectable for hidden libraries via the Statistics dropdown). Unknown IDs return `404`; non-integer values return `400`.

**Response `data` shape:**

```json
{
  "library_id": null,
  "total_manga": 42,
  "total_chapters": 1200,
  "total_pages": 28000,
  "total_size_bytes": 15032385536,
  "total_genres": 18,
  "estimated_read_time_minutes": 4200,
  "top_genres":      [{ "genre": "Action", "count": 15 }],
  "favorite_genres": [{ "genre": "Action", "chapters_read": 140 }],
  "top_manga":       [{ "id": 1, "title": "...", "cover_url": "...", "chapters_read": 42 }]
}
```

`library_id` echoes the scope of the response — `null` for All Libraries, or the numeric ID that was passed in.

**`top_genres` vs `favorite_genres`:**

- `top_genres` counts how many **series** are tagged with each genre (the library's genre inventory).
- `favorite_genres` ranks genres by **reading history**. Every chapter the user has read contributes one point to each of that manga's genres, so a reader who has finished 40 chapters of a 3-genre series adds 40 to each of those three genres. Only manga with at least one completed chapter contribute. Titles with no metadata (and therefore no genres) are naturally excluded. Top 10 returned; ties break on genre name ascending.

Genre aggregation and read-time estimation are computed entirely in SQL against the normalised `manga_genres` table, not by walking JSON blobs. `total_size_bytes` is a single `SUM(manga.bytes_on_disk)` over the cached per-manga column written by the scanner; it no longer walks the filesystem. See [scanner.md](./scanner.md#cached-disk-usage-columns).

**Cache:** each scope has its own 5-minute cached entry (keyed by `library_id` or `__all__`). Switching between libraries does not invalidate previously-cached scopes.

---

## Admin Auth & Sessions

Public-but-narrow endpoints used to bootstrap the admin session and the SPA's
first-launch routing. Backed by [server/src/auth/adminSession.js](../server/src/auth/adminSession.js)
and gated by `requireAdmin` once a password is set.

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/admin/auth-status` | Public discovery endpoint. Reports `configured`, `logged_in`, `auth_enabled`, `lan_bypass_enabled`, `caller_is_lan`, `pairing_required`, `multi_user_enabled`, `user_required`, `allow_registration`, and `logged_in_user`. The SPA's [`FirstLaunchGate`](../client/src/App.jsx) reads `pairing_required` / `user_required` to decide whether to route to `/pairing` or `/login` before showing library content. |
| `POST` | `/api/admin/setup` | One-shot — only reachable while no admin password has been set. Body `{ password }` (≥ 8 chars); persists the scrypt hash under `settings.admin_password_hash` and mints an admin session token. Returns 409 once configured. |
| `POST` | `/api/admin/login` | Body `{ password }`. Rate-limited to `LOGIN_LIMIT_PER_MIN = 10` per IP/minute; failure events recorded to the connection log. Returns `{ admin_token }`. |
| `POST` | `/api/admin/logout` | Idempotent. Revokes the bearer admin token. |
| `PUT`  | `/api/admin/password` | Body `{ current_password, new_password }`. Verifies the current password, persists the new scrypt hash, **revokes every admin session** and mints a fresh one for the caller. |
| `GET`  | `/api/admin/security-settings` | Returns `{ auth_enabled, lan_bypass_enabled, multi_user_enabled, allow_registration }`. |
| `PUT`  | `/api/admin/security-settings` | Body accepts any subset of those four booleans; persisted to the `settings` table. |

---

## Pairing & Clients

Used by the Android APK and PWA first-launch pairing wizard and by the
Client Management UI. The public `/api/pairing/*` endpoints are the
bootstrap path for an unpaired device; the `/api/admin/*` ones drive the
operator UI. See also [android.md § Pairing wizard](./android.md#pairing-wizard).

### Public pairing flow

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/pairing/request` | Body `{ device_name, platform? }`. Generates a `pairing_id` + a 6-digit PIN with a 5-minute TTL. **The PIN is not returned here** — it's visible only via the admin UI (`GET /api/admin/pairings/pending`). Rate-limited to 10 requests/min per IP. Returns `{ pairing_id, expires_at, ttl_seconds }`. |
| `GET`  | `/api/pairing/status/:id` | Client poll while waiting for admin approval. Returns `{ state: 'pending' }` or `{ state: 'approved', token, device_name }` (token is delivered exactly once and the row is deleted). 404 + `{ error: 'expired' }` once the row is gone (timed out or already consumed). Not rate-limited — clients are expected to poll every 2–3 s for up to 5 min. |
| `POST` | `/api/pairing/submit-pin` | Body `{ pairing_id, pin }`. On match, generates a client token, stores its SHA-256 hash in `paired_clients`, and stashes the plaintext on the pending row so the next status poll picks it up. Wrong-PIN increments per-pending `attempts` and per-IP `pin_lockouts`; reaching the admin-configured cap (default 5) deletes the pending row and locks the IP out for 24 h. Rate-limited to 15/min per IP. |

### Admin pairing & client management

All gated by `requireAdmin`.

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/admin/pairings/pending` | Lists every active pending pairing **with its PIN**, so the operator can read it aloud or type it into the requesting client. Expired rows are pruned opportunistically. |
| `DELETE` | `/api/admin/pairings/:id` | Manually cancel a pending pairing. |
| `GET`    | `/api/admin/clients` | Roster of paired clients with forensic fingerprint (`device_name`, `platform`, OS / browser / device type, first- and last-seen IPs, `request_count`, `revoked`). Tokens are never returned — only metadata. Buffered request counts are flushed first so the numbers are current. |
| `DELETE` | `/api/admin/clients/:id` | Soft-delete a paired client (`paired_clients.revoked = 1`). Future requests with that token are rejected by the auth middleware. Idempotent. |
| `GET`    | `/api/admin/pairing-pin-settings` | Returns `{ max_attempts, default_max_attempts, min_max_attempts, max_max_attempts, lockout_duration_sec, active_lockouts: [{ ip, failed_attempts, locked_until, updated_at }] }`. Expired lockout rows are pruned opportunistically. |
| `PUT`    | `/api/admin/pairing-pin-settings` | Body `{ max_attempts }` (clamped to `[MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS]`). |
| `DELETE` | `/api/admin/pairing-pin-lockouts/:ip` | Admin escape hatch for a household member who fat-fingered the PIN past the cap. Idempotent. |

---

## Connection Log

Forensic record of every connection attempt, paired-client request, and
auth event. Backed by the `connection_attempts` table and surfaced under
the Connection Log section of Client Management. Useful for incident
response on a server reachable from outside the LAN.

All routes are gated by `requireAdmin`. Events are buffered in memory and
flushed on each query via `connectionLog.flushAll()` so the listed rows
are current.

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/admin/connection-log` | Newest-first event timeline with keyset cursor pagination. Query params: `limit` (≤ 5000, default 100), `cursor` (opaque base64url of `<occurred_at>:<id>`), `event_type` (comma-separated), `severity` (`all` / `failures` / `successes`), `ip` (substring match), `q` (LIKE across `device_name`, `user_agent`, `reverse_dns`, `country`, `city`, `path`, `detail`, `referer`), `paired_client_id`, `since`, `until`. Returns `{ entries, total, filtered_total, next_cursor }`. |
| `GET`    | `/api/admin/connection-log/sources` | Grouped-by-source rollup: one row per `(real_ip, user_agent, paired_client_id)` tuple, with first / last seen, event counts, and the most recent fingerprint fields. Default window 30 days; `?since=<unix>` extends. Caps at 500 rows. |
| `GET`    | `/api/admin/connection-log.csv` | Two-section CSV download: paired devices + every connection event, newest first. UTF-8 BOM + RFC 4180 line endings so Windows Excel renders Japanese / accented strings cleanly. **Auth fallback**: accepts the admin session token via the `?t=` query string when no `X-Admin-Token` header is present, so the file can be downloaded via a plain `<a download>` if needed. |
| `DELETE` | `/api/admin/connection-log` | Wipes the event log. Useful before handing off a server or after archiving a CSV. |

Event types tracked include `pairing_request`, `pin_correct`, `pin_wrong`,
`lockout`, `lockout_blocked`, `pair_rate_limited`, `request_rate_limited`,
`admin_login_ok` / `admin_login_fail` / `admin_login_rate_limited`,
`client_request`, `admin_action`, `request_denied`, `request_error`,
`user_register`, `user_login_ok`, `user_login_fail`, `user_login_locked`,
`user_logout`, `user_password_changed`, and
`connection_log_exported`. The `severity = 'failures'` and `'successes'`
shortcuts select pre-defined subsets of those types (see the
`FAILURE_EVENTS` / `SUCCESS_EVENTS` constants in
[server/src/routes/adminAuth.js](../server/src/routes/adminAuth.js)).

---

## Network / Port Forwarding

Admin endpoints for the Port Forwarding section of Settings, driven by the
[UPnP module](../server/src/network/upnp.js). Settings are persisted in
the `settings` table under `port_forwarding_mode` (`'off' | 'upnp' |
'manual'`, default `off`) and `upnp_external_port` (string integer,
defaults to the server `PORT`).

All routes are gated by `requireAdmin`.

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/admin/network/status` | `{ config: { mode, external_port, internal_port }, upnp: { ...current UPnP state } }`. |
| `PUT`  | `/api/admin/network/config` | Body accepts any subset of `{ mode, external_port }`. Switching to `upnp` starts the refresh loop with the configured mapping; switching to `off` or `manual` stops it (the difference is purely cosmetic in the UI — `manual` tells the user they're expected to forward the port by hand). |
| `POST` | `/api/admin/network/probe` | One-shot UPnP probe — answers "does my router speak UPnP?" without altering any mapping. |
| `POST` | `/api/admin/network/public-ip` | HTTP-based public-IP detection. Independent of UPnP — works whether the router supports it or not. Used by the *Detect public IP* button in Manual mode and as a fallback in UPnP mode when the gateway doesn't return an external IP. |
| `POST` | `/api/admin/network/refresh` | Force a re-map right now (only valid when mode is `upnp`; 409 otherwise). |

The mapping refresh loop is also re-armed at server boot when
`port_forwarding_mode = 'upnp'` so a previously-enabled tunnel persists
across restarts.

---

## Admin / Database Management

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/admin/cbz-cache-size` | Current size and configured cap of the CBZ extract cache |
| POST | `/api/admin/clear-cbz-cache` | **Async** — returns `202` and runs in the background (see [Async admin tasks](#async-admin-tasks)). Deletes every extracted chapter directory in `CBZ_CACHE_DIR`. |
| GET | `/api/admin/clear-cbz-cache/status` | Status companion — current task state for the clear-cache runner |
| GET | `/api/admin/cbz-cache-settings` | Get the cache size cap and auto-clear schedule |
| PUT | `/api/admin/cbz-cache-settings` | Update the cache cap and/or auto-clear schedule (live — no restart needed) |
| GET | `/api/admin/export-config` | Download the server's user-facing state as a single JSON file (see [Configuration Backup](#configuration-backup)). Mount-line `requireAdmin` is header-only, so the SPA fetches via the `_adminDownload` helper (fetch + blob + synthetic `<a download>`) — `window.location.href` would 401 because native navigation can't carry `X-Admin-Token`. |
| POST | `/api/admin/import-config` | Restore state from a config JSON payload |
| POST | `/api/admin/regenerate-thumbnails` | **Async** — returns `202`; runner walks every manga, restoring AniList cover when on disk or regenerating from the first page. Progress reported as `i / N` via the status companion. |
| GET | `/api/admin/regenerate-thumbnails/status` | Status companion for the regenerate-thumbnails runner |
| POST | `/api/admin/reset-thumbnails` | **Async** — returns `202`. Re-aligns every manga's active cover to the priority order (anilist > mal > mu > doujinshi > original); overrides `cover_user_set`. **Never pings any upstream.** |
| GET | `/api/admin/reset-thumbnails/status` | Status companion for the reset-thumbnails runner |
| POST | `/api/admin/vacuum-db` | **Async** — returns `202` and runs `VACUUM` in the background. Persisted across restarts (the one task whose state survives in `admin_tasks`). |
| GET | `/api/admin/vacuum-db/status` | Status companion for the vacuum-db runner; survives a restart via the persisted `admin_tasks` row (flipped from `running` to `interrupted` at boot if the server died mid-VACUUM). |
| GET | `/api/admin/tasks/list` | Snapshot of every long-running admin task currently in the in-process registry (vacuum, cache wipe, reset thumbnails, regenerate, per-manga / per-library optimize). Powers the [`AdminTaskBanner`](../client/src/components/AdminTaskBanner.jsx). |
| GET | `/api/admin/export-series-list` | Download a CSV listing every manga (`Library, Series Name (AniList/MAL/MangaUpdates/Doujinshi), Folder path, # chapters, # volumes, Author`). Per-source title cells are read from the on-disk per-source metadata cache — never re-pings any upstream. `Content-Disposition: attachment; filename="momotaro-series-list-<date>.csv"`. Fetched via `_adminDownload` for the same reason as `/admin/export-config`. |
| GET | `/api/admin/logs` | Return the in-memory system log buffer as JSON |
| GET | `/api/admin/logs/export` | Download the log buffer as a plain-text `.txt` file. Fetched via `_adminDownload` for the same reason as `/admin/export-config`. |

### Async admin tasks

The four long-running admin actions (`clear-cbz-cache`,
`regenerate-thumbnails`, `reset-thumbnails`, `vacuum-db`) used to run
synchronously on the request thread; on large libraries the client
timed out before the server finished, even though the work completed.
They now flow through the [task registry](../server/src/admin/taskRegistry.js):

- The `POST` enqueues the task and returns **`202 Accepted`** immediately
  with the initial `{ status: { kind, status: 'running', started_at, … } }`
  state.
- A second `POST` while the same task is running returns **`409`** with
  `{ error, status: <existing state> }` so the UI can adopt the existing
  run instead of starting a duplicate.
- The runner is invoked via `setImmediate` so the route handler can
  flush the 202 before any synchronous heavy work (`db.exec('VACUUM')`,
  `fs.rmSync` loop) blocks the event loop.
- A `GET /api/admin/<task>/status` companion returns the same state
  shape — used by the [`useAdminTask`](../client/src/hooks/useAdminTask.js)
  hook (1.5 s polling, paused while the tab is hidden, in-flight responses
  discarded on race).

**State shape** returned by every status endpoint and inside the 202 body:

```json
{
  "kind":         "vacuum-db",
  "resource_id":  null,
  "status":       "running",
  "started_at":   1713200000000,
  "finished_at":  null,
  "progress":     { "current": 142, "total": 5000, "label": "Regenerated 140, 2 errors" },
  "result":       null,
  "error":        null
}
```

`status` is one of `running`, `done`, `failed`, or `interrupted`
(VACUUM only — the persisted row is rewritten at boot if the server
died mid-task). `result` is the runner's return value once complete
(e.g. `{ size_before_bytes, size_after_bytes }` for `vacuum-db`).

**Persistence.** Only `vacuum-db` mirrors its state to the
`admin_tasks` table — restarting the server mid-VACUUM otherwise made
the UI return a "no task ever ran" answer, which is misleading on a
multi-TB DB that legitimately takes minutes. Every other kind is
in-memory only; a server restart drops the "done — 312 MB freed" badge,
which is acceptable.

**`GET /api/admin/cbz-cache-size` response `data` shape:**

```json
{ "size_bytes": 1374389534, "limit_bytes": 21474836480 }
```

`size_bytes` is the total disk usage under `CBZ_CACHE_DIR`; `limit_bytes` is the active cap — user-configurable from Settings → Database → CBZ Cache. When an extraction pushes `size_bytes` over `limit_bytes`, the cache auto-clears: every cached chapter directory is wiped except the one that triggered the overflow, so the in-flight read (or batch operation like `POST /api/admin/regenerate-thumbnails`) keeps making progress. See [scanner.md § CBZ Serve Cache](./scanner.md#cbz-serve-cache).

**`POST /api/admin/clear-cbz-cache` response `data` shape:**

```json
{ "size_bytes": 0 }
```

### CBZ Cache Settings

**`GET /api/admin/cbz-cache-settings` response `data` shape:**

```json
{
  "limit_bytes":         21474836480,
  "limit_default_bytes": 21474836480,
  "limit_min_bytes":     104857600,
  "limit_max_bytes":     10995116277760,
  "autoclear_mode":      "off",
  "autoclear_day":       0,
  "autoclear_time":      "03:00",
  "next_run_at":         null
}
```

- `limit_bytes` — active cap. Persisted in the `settings` table as `cbz_cache_limit_bytes`.
- `limit_default_bytes` / `limit_min_bytes` / `limit_max_bytes` — 20 GB / 100 MB / 10 TB respectively. The UI uses these to validate user input.
- `autoclear_mode` — `'off'`, `'daily'`, or `'weekly'`.
- `autoclear_day` — `0..6` with `0 = Sunday`. Ignored when `autoclear_mode !== 'weekly'`.
- `autoclear_time` — `HH:MM` 24-hour, **server local time**.
- `next_run_at` — ISO-8601 timestamp of the next scheduled wipe, or `null` when `autoclear_mode === 'off'`.

**`PUT /api/admin/cbz-cache-settings`** body — every field is optional; only provided fields are updated. Returns the same shape as GET after applying changes.

```json
{
  "limit_bytes":    10737418240,
  "autoclear_mode": "weekly",
  "autoclear_day":  0,
  "autoclear_time": "03:00"
}
```

On a successful update the server applies the new size cap immediately (evicting LRU chapters if the new cap is below the current total) and reschedules the auto-clear timer. No restart is required. Validation errors return `400` with a human-readable message; implemented in [server/src/routes/admin.js](../server/src/routes/admin.js) and scheduling in [server/src/scanner/cbzCacheSchedule.js](../server/src/scanner/cbzCacheSchedule.js).

### Configuration Backup

Intended for portable backups: export the server's user-facing state as a JSON file, then re-import it on a fresh install to restore everything. See also the UX write-up in [frontend.md § Settings](./frontend.md#settings-srcpagessettingsjsx).

**`GET /api/admin/export-config`** — returns a single JSON file download. `Content-Disposition: attachment; filename="momotaro-config-<iso-timestamp>.json"`. Body shape:

```json
{
  "version":     1,
  "app":         "momotaro",
  "exported_at": "2026-04-23T12:00:00.000Z",
  "settings":                 { "anilist_client_id": "...", "...": "..." },
  "device_anilist_sessions":  [ /* rows from device_anilist_sessions */ ],
  "libraries":                [ { "name": "...", "path": "...", "show_in_all": 1 } ],
  "manga_metadata":           [ /* per-manga metadata keyed by path */ ],
  "reading_lists":            [ { "name": "...", "is_default": 0, "manga": [{"manga_path": "...", "added_at": 0}] } ],
  "progress":                 [ /* progress rows, with chapter folder names instead of IDs */ ],
  "art_gallery":              [ /* per-page bookmarks keyed by (manga_path, chapter_folder, page_index) */ ]
}
```

Every reference to a manga uses `manga.path` (the UNIQUE column) rather than the auto-increment `manga.id`, so the payload remains valid across a fresh DB where IDs are re-assigned. Chapters inside each manga are referenced by `folder_name`; pages by `page_index`.

**`POST /api/admin/import-config`** — accepts the payload produced by the export endpoint as its JSON body. The route validates (`app === 'momotaro'`, `version` within supported range) and then runs the whole restore inside a single `better-sqlite3` transaction so a mid-import error leaves the DB untouched.

Request-body limit is raised to **64 MB** on the server (`express.json({ limit: '64mb' })`) to accommodate large libraries. The client layer raises its per-request timeout to 5 minutes for this call.

**Behaviour per section:**

| Section | Behaviour |
| --- | --- |
| `settings` | Upsert by key. Existing keys not in the import payload are left alone. |
| `device_anilist_sessions` | Replaced wholesale. |
| `libraries` | Upsert by `path` — name and `show_in_all` refresh, existing path is preserved. |
| `manga_metadata` | UPDATE-only. The import never creates manga rows — the scanner is the authority on what manga exist. If a manga at the given `path` is not in the DB yet, a warning is emitted. |
| `reading_lists` | Non-default lists are wiped and re-inserted; `reading_list_manga` is fully replaced. Built-in lists (Favorites, Want to Read) keep their row but their memberships are re-populated. |
| `progress` | Upsert by `manga_id`. `current_chapter_folder` / `completed_chapter_folders` are remapped to chapter IDs in the target DB. Missing chapters are dropped silently from `completed_chapters`. |
| `art_gallery` | Wiped and re-inserted. Entries whose `(manga_path, chapter_folder, page_index)` cannot be resolved are skipped. |

**Live-effect hooks** — after the transaction commits, the CBZ cache `setLimitBytes()` is called with the restored `cbz_cache_limit_bytes`, and the auto-clear scheduler is rescheduled. Any settings that affect runtime state therefore take effect without a restart.

**`POST /api/admin/import-config` response `data` shape:**

```json
{
  "counts": {
    "settings": 8,
    "device_sessions": 1,
    "libraries": 2,
    "manga_metadata": 432,
    "reading_lists": 3,
    "reading_list_manga": 58,
    "progress": 120,
    "art_gallery": 14
  },
  "warnings": [
    "manga_metadata: no manga at path /library/Old Title — run a scan first"
  ],
  "warnings_truncated": false,
  "total_warnings": 1
}
```

Warnings are capped at 50 entries per response (`warnings_truncated = true` when the full list is longer). The typical operator workflow is: mount the library at the same path as the export, wait for the startup scan to complete, then import.

**`POST /api/admin/regenerate-thumbnails` response `data` shape:**

```json
{ "message": "Thumbnail regeneration started", "total": 42 }
```

Regeneration logic per manga:

1. If `anilist_cover` file exists on disk → copy it to the active `{id}.webp`
2. Otherwise → regenerate from the first page (`page_index = 0`) of the first chapter

**`POST /api/admin/reset-thumbnails` response `data` shape:**

```json
{
  "total":                 432,
  "changed_to_anilist":    301,
  "changed_to_mal":         52,
  "changed_to_mu":           8,
  "changed_to_doujinshi":    4,
  "changed_to_original":    18,
  "kept_user":               0,
  "kept_no_source":         49,
  "errors":                  0
}
```

Synchronous endpoint — the response is returned after the full pass completes. For each manga the resolver in [server/src/scanner/coverResolver.js](../server/src/scanner/coverResolver.js) walks the priority list **AniList → MyAnimeList → MangaUpdates → Doujinshi.info → original scan**, copies the first source-specific file that exists on disk into `{id}.webp`, and clears `cover_user_set` to 0.

Crucially this never pings any upstream — it only re-uses cover files already on disk from previous metadata fetches. Manga with no source-specific cover at all (and no original) end up in `kept_no_source`. The same pass runs automatically at the end of every `scanLibrary` and `runFullScan` call (see [scanner.md § Cover priority](./scanner.md#cover-priority)) — the standalone admin endpoint exists so the operator can rebuild the alignment on demand from Settings → Database.

**`POST /api/admin/vacuum-db` response `data` shape:**

```json
{ "size_before_bytes": 20971520, "size_after_bytes": 14680064 }
```

### System Logs

`console.log`, `console.info`, `console.warn`, and `console.error` are intercepted at server startup by [server/src/logger.js](../server/src/logger.js) and mirrored into an in-memory ring buffer. Output continues to stream to stdout/stderr as before; the buffer only adds a readable record that the UI can fetch or export. The buffer holds the most recent **2000** entries and is process-local — it resets on every server restart.

**`GET /api/admin/logs` response `data` shape:**

```json
{
  "entries": [
    { "ts": "2026-04-16T12:00:00.000Z", "level": "info",  "message": "[Server] Momotaro running on port 3000" },
    { "ts": "2026-04-16T12:00:01.100Z", "level": "warn",  "message": "[Scanner] Skipping unreadable file: ..." },
    { "ts": "2026-04-16T12:00:02.500Z", "level": "error", "message": "[Error] Request timed out" }
  ],
  "max": 2000
}
```

`level` is one of `info` (covers `console.log` / `console.info`), `warn`, or `error`. Entries are returned oldest-first in insertion order.

**`GET /api/admin/logs/export`** responds with:

```text
Content-Type: text/plain; charset=utf-8
Content-Disposition: attachment; filename="momotaro-logs-<iso-timestamp>.txt"
```

The body is the same entries formatted as `[<iso-ts>] [<LEVEL>] <message>`, one per line. The client triggers the download via `api.exportSystemLogs()` — fetch + blob so the `X-Admin-Token` header rides along (the mount-line `requireAdmin` gate doesn't accept a `?t=` query token, so a bare `window.location.href` navigation would 401).

---

## Health

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Returns `{ status: "ok", version: "1.0.0" }` |

---

## Android App Distribution

Public endpoints used by the Capacitor-wrapped Android app — they bootstrap
a freshly-installed APK that has no client token yet. See
[android.md § Self-hosted distribution](./android.md#self-hosted-distribution).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/app/version` | Reads `data/downloads/version.json` and reports the latest published APK. 404 when no APK has been dropped into `data/downloads/` yet. |
| GET | `/downloads/momotaro.apk` | Static file: the signed release APK. Public so the system browser tab that handles the `.apk` download (which can't carry a bearer token) can fetch it. |

### `GET /api/app/version` response

```json
{
  "data": {
    "version":     "1.1",
    "apk_url":     "/downloads/momotaro.apk",
    "released_at": "2026-05-15",
    "notes":       "Brief change summary shown in the update banner.",
    "size_bytes":  3398672
  }
}
```

`version` is the only required field in `version.json`; `released_at` and
`notes` are optional and pass through unchanged. `size_bytes` is computed
from the on-disk APK each call so the value stays accurate after a
re-release without editing `version.json`.

The client's [useAppUpdateCheck](../client/src/hooks/useAppUpdateCheck.js)
compares this `version` against the bundled
[APP_VERSION](../client/src/version.js) constant and surfaces the
[UpdateBanner](../client/src/components/UpdateBanner.jsx) when they
differ — see [android.md § Update mechanism](./android.md#end-to-end-update-flow).

---

## Image URLs

Page images are served at:
```
GET /api/pages/:pageId/image
```

Thumbnails are served as static files from `THUMBNAIL_DIR` at `/thumbnails/<filename>`.

The client helpers `api.pageImageUrl(pageId)` and `api.thumbnailUrl(filename)` return the full URL strings.
