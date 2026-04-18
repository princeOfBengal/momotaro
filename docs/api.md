# API Reference

All routes are prefixed `/api`. Server runs on port 3000 in development.

The client API layer lives in [client/src/api/client.js](../client/src/api/client.js).

## Device Identity Header

Every request from the client includes:

```
X-Device-ID: <uuid>
```

The UUID is generated on first load and persisted in `localStorage` as `momotaro_device_id`. Endpoints that read or write AniList session state use this header to scope data to the requesting device.

---

## Libraries

| Method | Path | Description |
|---|---|---|
| GET | `/api/libraries` | List all libraries with manga counts |
| POST | `/api/libraries` | Create library `{ name, path }` |
| PATCH | `/api/libraries/:id` | Update library `{ name?, path?, show_in_all? }` |
| DELETE | `/api/libraries/:id` | Delete library and all its manga |
| POST | `/api/libraries/:id/scan` | Trigger manual scan of one library |
| POST | `/api/scan` | Trigger full scan of all libraries (returns 409 if already running) |
| GET | `/api/scan/status` | Current scan progress — see *Scan Progress* below |
| POST | `/api/libraries/:id/export-metadata` | Write `metadata.json` to each manga folder that has third-party metadata |

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
| GET | `/api/manga/:id/info` | Get filesystem info: path, file count, folder size in MB |
| PATCH | `/api/manga/:id` | Update manga settings `{ track_volumes? }` |
| GET  | `/api/manga/:id/thumbnail-options` | List all thumbnail choices: anilist, original, history, chapter first pages |
| POST | `/api/manga/:id/set-thumbnail` | Set thumbnail from a page `{ page_id }` or saved file `{ saved_filename }` |
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
- `?cursor=<opaque>` — resume token from a previous response's `next_cursor`. Supported for `sort=title` (default) and `sort=updated` only. `sort=year` returns `400` when a cursor is supplied.

Paginated response shape:

```json
{
  "data": [ /* manga rows */ ],
  "next_cursor": "eyJ2IjoiTXkgTWFuZ2EiLCJpZCI6NDJ9",
  "has_more": true
}
```

`next_cursor` is `null` when `has_more` is `false` — i.e. the final page has been returned. Cursors are opaque base64url tokens containing the last row's sort-key plus its `id` as a tiebreaker; do not parse or construct them on the client.

Under the hood, the server fetches `limit + 1` rows and uses `WHERE (title, id) > (?, ?)` (or `<` for DESC sorts) against the `idx_manga_title` / `idx_manga_updated_at` indexes, so the cost of fetching page N is independent of N — unlike `OFFSET`, which scans every skipped row.

### `GET /api/manga/:id/info` response

```json
{
  "data": {
    "path": "/library/My Manga",
    "file_count": 842,
    "size_mb": 312.47
  }
}
```

`file_count` and `size_mb` are read from the cached `manga.file_count` / `manga.bytes_on_disk` columns populated by the scanner — no disk walk happens at request time. Values are accurate as of the most recent scan of the manga. See [scanner.md](./scanner.md#cached-disk-usage-columns).

### `GET /api/manga/:id/thumbnail-options` response

```json
{
  "data": {
    "active_cover": "5.webp",
    "anilist_cover": "5_anilist.webp",
    "original_cover": "5_original.webp",
    "history": [
      { "id": 3, "filename": "5_1713200000000.webp", "created_at": 1713200000 }
    ],
    "chapter_first_pages": [
      { "chapter_id": 12, "chapter_name": "Chapter 1", "page_id": 100 }
    ]
  }
}
```

- `anilist_cover` / `original_cover` — `null` if not yet generated.
- `history` — up to 20 entries, most recent first. Populated by `POST /api/manga/:id/set-thumbnail` with `{ page_id }`.
- `chapter_first_pages` — one entry per chapter (the page at `page_index = 0`), ordered by chapter number.

### `POST /api/manga/:id/set-thumbnail`

Accepts either a live page or a previously saved thumbnail file:

```json
{ "page_id": 100 }
```

Generates a 300 × 430 WebP from the page image, saves it as `{mangaId}_{timestamp}.webp`, copies it to the active `{mangaId}.webp`, and records the filename in `thumbnail_history`.

**Folder vs. CBZ chapters** — the page source is resolved from the parent chapter's `type`:

- `folder` — the page's absolute file path is passed directly to `sharp`.
- `cbz` — the single ZIP entry named by `pages.path` is streamed out of the archive via `yauzl.openReadStream`, buffered, and handed to `sharp`. The archive is never fully extracted; only the central directory and the one needed entry are read. Memory footprint is one page (≈1–2 MB) for the duration of the resize.

```json
{ "saved_filename": "5_anilist.webp" }
```

Copies an existing saved file to the active `{mangaId}.webp`. The filename must start with `{mangaId}_` and end with `.webp` (path traversal prevention).

---

## Art Gallery

A per-manga collection of saved pages. Users bookmark pages from the reader via the *Add to Art Gallery* button; the pages appear as a grid at the bottom of MangaDetail. Gallery entries are stored in the `art_gallery` table (see [database.md](./database.md)).

| Method | Path | Description |
| --- | --- | --- |
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
|---|---|---|
| GET | `/api/manga/:mangaId/chapters` | List chapters for a manga |
| GET | `/api/chapters/:id` | Get single chapter |
| GET | `/api/chapters/:id/pages` | List pages for a chapter (includes width/height/is_wide) |
| GET | `/api/pages/:id/image` | Serve page image (binary, `Cache-Control: public, max-age=86400`) |

Page images are served in one of two ways depending on the parent chapter's `type`:

- **Folder chapters** — `res.sendFile(path)` against the absolute filesystem path stored on the page row. Express handles `ETag`, `Last-Modified`, and conditional 304 responses.
- **CBZ chapters** — `yauzl` opens the archive, locates the entry named by `pages.path`, and pipes the decompressed stream through to the response. No files are extracted to disk. `Cache-Control: public, max-age=86400` is set explicitly because `sendFile`'s automatic cache headers don't apply.

`width` and `height` in `/api/chapters/:id/pages` are populated for every page. Folder-chapter pages get them at scan time; CBZ-chapter pages start out null (dimension fetching is skipped during the scan to avoid decompressing every entry) and the route then populates them lazily on the first open of each chapter — see [scanner.md → Image Dimension Fetching](./scanner.md#image-dimension-fetching). The first open of a CBZ chapter therefore briefly waits while every entry is read through `sharp.metadata()`; subsequent opens read the persisted values and respond immediately.

`is_wide` is computed at serve time from the stored `width`/`height` and is `true` only when the page is a true double-page spread — its width is ≥ 1.5× the median page width across the chapter. This catches pages drawn at twice the normal width (so the reader can render them solo in Double Page (Manga) mode) without flagging mildly-landscape pages. It is `null` only when dimensions are still unknown (e.g. an unreadable CBZ entry).

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

### AniList

| Method | Path | Description |
|---|---|---|
| POST | `/api/manga/:id/refresh-metadata` | Auto-fetch from AniList by title |
| POST | `/api/manga/:id/apply-metadata` | Apply a specific AniList result `{ anilist_id }` |
| GET | `/api/anilist/search?q=&page=` | Search AniList by title (manual search) |
| GET | `/api/manga/:id/anilist-status` | Get user's AniList list entry for this manga |
| PATCH | `/api/manga/:id/anilist-progress` | Manually update AniList progress |

Both `refresh-metadata` and `apply-metadata` write the `author` field in addition to the standard metadata fields. See [anilist.md](./anilist.md) for how the author name is extracted from the AniList staff list.

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

### Export Metadata (per-manga)

| Method | Path                             | Description                                          |
| ------ | -------------------------------- | ---------------------------------------------------- |
| POST   | `/api/manga/:id/export-metadata` | Write `metadata.json` to this manga's folder on disk |

Writes a `metadata.json` sidecar file to `{manga.path}/metadata.json`. Requires either `metadata_source != 'none'` or a `metadata_source = 'local'` manga with a third-party link (`anilist_id` / `mal_id` / `doujinshi_id`); returns 400 otherwise.

**Local-source with third-party link** — when `metadata_source === 'local'` and at least one ID is present, the server re-fetches the linked third-party source (priority AniList > MyAnimeList > Doujinshi.info) and writes *that* data into the JSON, overwriting any existing file. The database row is not modified, so in-app display continues to use the local record. If the remote fetch fails, the endpoint returns 502.

For all other linked sources, the file is written directly from the DB fields. Includes all non-null metadata fields plus `metadata_source` and `exported_at`. See the [library-level Export Metadata](#export-metadata) section for the full file format.

**Response shape:**

```json
{ "data": { "path": "/library/My Manga/metadata.json" } }
```

### Reset Metadata

| Method | Path                            | Description                                                  |
| ------ | ------------------------------- | ------------------------------------------------------------ |
| POST   | `/api/manga/:id/reset-metadata` | Break external linkage; optionally clear sourced fields      |

**Request body** (optional):

```json
{ "source": "anilist" | "myanimelist" | "doujinshi" }
```

Behavior depends on whether `source` is supplied:

- **`source` omitted** — full reset. Clears `anilist_id`, `mal_id`, `doujinshi_id`, all sourced metadata fields (`description`, `status`, `year`, `genres`, `score`, `author`), sets `metadata_source = 'none'`, and clears `last_metadata_fetch_attempt_at`.
- **`source` supplied, matches `metadata_source`** — full reset as above, but only the specified source's ID (`anilist_id` / `mal_id` / `doujinshi_id`) and cover column (`anilist_cover` / `mal_cover`) are cleared. Doujinshi.info has no dedicated cover column.
- **`source` supplied, does *not* match `metadata_source`** (e.g. source is `'anilist'` but the manga displays `'local'` or `'myanimelist'`) — **link-only break**. Only the specified source's `*_id` and cover column are nulled. All metadata fields, `metadata_source`, and any other linkage IDs are preserved. This is how the UI detaches an auxiliary link while keeping the user's chosen display source intact.

Per-field summary:

| Field                            | Full reset | Link-only break |
| -------------------------------- | ---------- | --------------- |
| `<source>_id`                    | `NULL`     | `NULL`          |
| `<source>_cover` (if applicable) | `NULL`     | `NULL`          |
| `metadata_source`                | `'none'`   | unchanged       |
| sourced fields (desc / status / year / genres / score / author) | `NULL` | unchanged |
| `last_metadata_fetch_attempt_at` | `NULL`     | unchanged       |
| `title`, `cover_image`           | unchanged  | unchanged       |

Returns the updated manga row. Use the full-reset form when the wrong title was auto-matched; use the link-only form to detach an AniList/MAL link from a manga that's displaying local-JSON metadata.

### Bulk Metadata Pull

`POST /api/libraries/:id/bulk-metadata` accepts an optional body:

```json
{ "source": "anilist", "force": false }
```

`source` can be `"anilist"` (default), `"myanimelist"`, or `"doujinshi"`. `force` defaults to `false`; set it to `true` to bypass the 7-day retry cooldown described below. The endpoint responds immediately; the actual fetch loop runs in the background.

**Skip logic** — processed vs. skipped depends on the title's current `metadata_source`:

| `metadata_source` | Behavior |
| --- | --- |
| `'none'` | Full fetch — all metadata fields and the linkage ID are applied; the source's cover is downloaded and promoted to active (subject to the priority rule below). |
| `'local'` | **Link-only** — only the external ID (`anilist_id` / `mal_id` / `doujinshi_id`) is written; the user's local-JSON metadata fields (title, description, genres, etc.) are preserved. The source's cover is still downloaded and, if priority allows, promoted to active. Already-linked titles for the current source are skipped. |
| `'anilist'`, `'myanimelist'`, `'doujinshi'` | Skipped — title already has third-party metadata. |

**Retry cooldown** — every processed title has its `last_metadata_fetch_attempt_at` stamped regardless of outcome. On subsequent bulk pulls, any title whose last attempt is within 7 days is skipped unless `force: true` is passed. Titles that already succeeded are skipped automatically by the source check above, so the cooldown only affects titles that previously produced no match. `POST /api/manga/:id/reset-metadata` clears the timestamp so a reset title is eligible again immediately.

**AniList batching** — when `source = 'anilist'`, titles are sent 5 per GraphQL request using query aliases, cutting outbound HTTP count ~5×. Each batch is still spaced 700 ms apart to stay within AniList's request-per-minute limit. MyAnimeList and Doujinshi.info remain sequential (no alias equivalent in their REST APIs).

**Cover promotion priority** — during a bulk pull, an already-saved cover from a higher-priority source is never replaced. The promotion rule for the source being pulled:

| Source being pulled | Promoted to active cover when… |
| --- | --- |
| `anilist` | Always (top priority). |
| `myanimelist` | No `anilist_cover` file exists yet. |
| `doujinshi` | Neither `anilist_cover` nor `mal_cover` exists yet. |

A lower-priority source's cover file is still downloaded and saved to its column (`mal_cover` / `doujinshi_cover`) — it just doesn't overwrite `cover_image`. The user can switch covers manually via the Thumbnail Picker. The same priority applies to both third-party-metadata (`metadata_source = 'none'`) and local-metadata (`metadata_source = 'local'`) titles.

**Single-manga endpoints** (`refresh-metadata`, `apply-metadata`, `refresh-mal-metadata`, `apply-mal-metadata`, `refresh-doujinshi-metadata`, `apply-doujinshi-metadata`) behave slightly differently:

- For `metadata_source = 'local'`, they also use link-only writes (local JSON metadata preserved).
- For other sources, they fully overwrite since the user explicitly picked a new entry.
- The cover is **always** promoted to active — user intent overrides the bulk priority rule, so e.g. clicking *Fetch* on the MAL tab will replace an existing AniList cover with the MAL one.

**Response shape:**
```json
{
  "message": "Bulk metadata pull started",
  "total": 50,
  "to_fetch": 10,
  "skipped_existing": 30,
  "skipped_already_linked": 8,
  "skipped_recent_attempt": 2,
  "source": "anilist"
}
```

- `total` — total manga in the library
- `to_fetch` — manga that will be processed (`'none'` or `'local'`, not on cooldown, not already linked for this source)
- `skipped_existing` — third-party metadata already present (anilist / myanimelist / doujinshi)
- `skipped_already_linked` — `'local'` metadata and the relevant ID for this source is already stored
- `skipped_recent_attempt` — last fetch attempt within the 7-day cooldown and `force` was not set

**Rate limiting** — AniList requests are spaced 700 ms apart to stay within the ~90 req/min limit. Doujinshi.info requests are spaced 500 ms apart; each title requires two upstream calls (search + fetch-by-slug).

**Server logs** — progress is logged per-title as `(X/Y) Applied / No match / Error`, with a final summary line reporting applied, no-match, error, and skipped counts.

### Export Metadata

`POST /api/libraries/:id/export-metadata` writes a `metadata.json` sidecar file into each manga's folder. No request body is required.

Export behaviour per title:

| `metadata_source`                           | Link present                                    | Action |
| ------------------------------------------- | ----------------------------------------------- | ------ |
| `'anilist'` / `'myanimelist'` / `'doujinshi'` | —                                             | Write DB fields to `metadata.json`. |
| `'local'`                                   | `anilist_id` / `mal_id` / `doujinshi_id` set    | **Re-fetch** the linked source (priority AniList > MAL > Doujinshi.info) and write *that* data to `metadata.json`, overwriting any existing file. DB is not modified. |
| `'local'`                                   | no link                                         | Skip. |
| `'none'`                                    | —                                               | Skip. |

The endpoint is not fully synchronous any more — it may issue upstream HTTP requests for each local-source manga with a link. AniList fetches are spaced 700 ms apart for rate limiting. The client allows up to 10 minutes per request (`timeoutMs: 600_000`) for large libraries.

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
- `exported_local` — subset of `exported` where a local-source manga had its file overwritten with freshly-fetched third-party data
- `skipped` — manga with `metadata_source = 'none'`, or `'local'` with no third-party link, or a linked `'local'` manga whose remote fetch returned nothing
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
  "mal_client_id_set": true
}
```

`anilist_token_set` and `anilist_logged_in` reflect the session for the requesting device only. `doujinshi_logged_in` is server-wide (true whenever a doujinshi token is stored in `settings`). `mal_client_id_set` is server-wide (true whenever a MAL Client ID is stored).

**PUT** also accepts `mal_client_id` to save or clear the MyAnimeList Client ID. Passing an empty string clears it.

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
| POST | `/api/manga/:id/optimize` | Convert chapter folders to CBZ / standardize filenames |

---

## Statistics

| Method | Path | Description |
|---|---|---|
| GET | `/api/stats` | Library statistics (cached 5 minutes) |

**Response `data` shape:**
```json
{
  "total_manga": 42,
  "total_chapters": 1200,
  "total_pages": 28000,
  "total_size_bytes": 15032385536,
  "total_genres": 18,
  "estimated_read_time_minutes": 4200,
  "top_genres": [{ "genre": "Action", "count": 15 }],
  "top_manga": [{ "id": 1, "title": "...", "cover_url": "...", "chapters_read": 42 }]
}
```

Genre aggregation and read-time estimation are computed entirely in SQL. `total_size_bytes` is a single `SUM(manga.bytes_on_disk)` over the cached per-manga column written by the scanner; it no longer walks the filesystem. See [scanner.md](./scanner.md#cached-disk-usage-columns).

---

## Admin / Database Management

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/admin/cbz-cache-size` | Legacy — report size of any leftover extract-to-disk cache. `limit_bytes` is always `0` since CBZs are now streamed on demand. |
| POST | `/api/admin/clear-cbz-cache` | Delete all entries in `CBZ_CACHE_DIR`; returns new size (always 0). Kept for operator convenience — the cache is also wiped automatically on server startup. |
| POST | `/api/admin/regenerate-thumbnails` | Rebuild active cover for every manga — responds immediately, runs in background |
| POST | `/api/admin/vacuum-db` | Run `VACUUM` on the SQLite database file; returns size before and after |
| GET | `/api/admin/logs` | Return the in-memory system log buffer as JSON |
| GET | `/api/admin/logs/export` | Download the log buffer as a plain-text `.txt` file |

**`GET /api/admin/cbz-cache-size` response `data` shape:**

```json
{ "size_bytes": 0, "limit_bytes": 0 }
```

`size_bytes` will usually be `0` — the server wipes any leftover cache directory on startup (see [scanner.md](./scanner.md#legacy-cache-cleanup)). It will only be non-zero if legacy cache entries were written after the most recent startup (which can't happen with the streaming reader) or if something outside Momotaro dropped files into the directory. `limit_bytes` is always `0` to signal that no ceiling is enforced.

**`POST /api/admin/clear-cbz-cache` response `data` shape:**

```json
{ "size_bytes": 0 }
```

**`POST /api/admin/regenerate-thumbnails` response `data` shape:**

```json
{ "message": "Thumbnail regeneration started", "total": 42 }
```

Regeneration logic per manga:

1. If `anilist_cover` file exists on disk → copy it to the active `{id}.webp`
2. Otherwise → regenerate from the first page (`page_index = 0`) of the first chapter

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

The body is the same entries formatted as `[<iso-ts>] [<LEVEL>] <message>`, one per line. The client triggers the download by navigating the browser directly to this URL (`api.systemLogsExportUrl()`).

---

## Health

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Returns `{ status: "ok", version: "1.0.0" }` |

---

## Image URLs

Page images are served at:
```
GET /api/pages/:pageId/image
```

Thumbnails are served as static files from `THUMBNAIL_DIR` at `/thumbnails/<filename>`.

The client helpers `api.pageImageUrl(pageId)` and `api.thumbnailUrl(filename)` return the full URL strings.
