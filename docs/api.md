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
| POST | `/api/scan` | Trigger full scan of all libraries |

---

## Manga / Library

| Method | Path | Description |
|---|---|---|
| GET | `/api/library` | List manga (supports `?search=`, `?sort=`, `?library_id=`, `?status=`) |
| GET | `/api/manga/:id` | Get single manga with chapters and progress |
| GET | `/api/manga/:id/info` | Get filesystem info: path, file count, folder size in MB |
| PATCH | `/api/manga/:id` | Update manga settings `{ track_volumes? }` |
| GET  | `/api/manga/:id/thumbnail-options` | List all thumbnail choices: anilist, original, history, chapter first pages |
| POST | `/api/manga/:id/set-thumbnail` | Set thumbnail from a page `{ page_id }` or saved file `{ saved_filename }` |
| DELETE | `/api/manga/:id` | Remove manga from DB and delete files on disk |

### Search (`?search=`)

The `search` parameter is matched against title, **author/artist name** (partial, case-insensitive), and genres.

- **Single term** — matches any manga whose title, author, or any genre contains the term as a substring. Artist first and last names both match because the comparison is a substring search against the full stored name.
- **Comma-separated terms** — treated as a genre filter; manga must have **all** listed genres (exact match, case-insensitive). Author is not checked in this mode.

The same logic applies to the reading-list manga endpoint (`GET /api/reading-lists/:id/manga?search=`).

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

`file_count` and `size_mb` are computed by an async recursive directory walk at request time (not cached).

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

```json
{ "saved_filename": "5_anilist.webp" }
```

Copies an existing saved file to the active `{mangaId}.webp`. The filename must start with `{mangaId}_` and end with `.webp` (path traversal prevention).

---

## Chapters & Pages

| Method | Path | Description |
|---|---|---|
| GET | `/api/manga/:mangaId/chapters` | List chapters for a manga |
| GET | `/api/chapters/:id` | Get single chapter |
| GET | `/api/chapters/:id/pages` | List pages for a chapter (includes width/height/is_wide) |
| GET | `/api/pages/:id/image` | Serve page image (binary, `Cache-Control: public, max-age=86400`) |

Page images are streamed with `fs.createReadStream`. The stream is destroyed if the client disconnects before the transfer completes.

---

## Progress

| Method | Path | Description |
|---|---|---|
| GET | `/api/progress/:mangaId` | Get reading progress |
| PUT | `/api/progress/:mangaId` | Update progress (triggers AniList sync for the requesting device) |
| DELETE | `/api/progress/:mangaId` | Reset progress |

**PUT body:**
```json
{
  "chapterId": 42,
  "page": 7,
  "markChapterComplete": false
}
```

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

### Bulk Metadata Pull

`POST /api/libraries/:id/bulk-metadata` accepts an optional body:

```json
{ "source": "anilist" }
```

`source` can be `"anilist"` (default) or `"doujinshi"`. The endpoint responds immediately; the actual fetch loop runs in the background.

**Skip logic** — only manga with `metadata_source = 'none'` are processed. Any title that already has metadata from any source (local JSON, AniList, or Doujinshi.info) is always skipped. Single-manga endpoints (`refresh-metadata`, `apply-metadata`, etc.) always apply regardless of existing source, since the user explicitly requested it.

**Response shape:**
```json
{
  "message": "Bulk metadata pull started",
  "total": 50,
  "to_fetch": 12,
  "skipped_existing": 38,
  "source": "anilist"
}
```

- `total` — total manga in the library
- `to_fetch` — manga that will be processed (had `metadata_source = 'none'`)
- `skipped_existing` — manga skipped because they already have metadata

**Rate limiting** — AniList requests are spaced 700 ms apart to stay within the ~90 req/min limit. Doujinshi.info requests are spaced 500 ms apart; each title requires two upstream calls (search + fetch-by-slug).

**Server logs** — progress is logged per-title as `(X/Y) Applied / No match / Error`, with a final summary line reporting applied, no-match, error, and skipped counts.

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
  "doujinshi_logged_in": true
}
```

`anilist_token_set` and `anilist_logged_in` reflect the session for the requesting device only. `doujinshi_logged_in` is server-wide (true whenever a doujinshi token is stored in `settings`).

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

Genre aggregation and read-time estimation are computed entirely in SQL. Disk size is measured asynchronously using `fs.promises` so the stats endpoint never blocks the event loop.

---

## Admin / Database Management

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/admin/cbz-cache-size` | Return current size of the CBZ cache in bytes |
| POST | `/api/admin/clear-cbz-cache` | Delete all entries in `CBZ_CACHE_DIR`; returns new size (always 0) |
| POST | `/api/admin/regenerate-thumbnails` | Rebuild active cover for every manga — responds immediately, runs in background |
| POST | `/api/admin/vacuum-db` | Run `VACUUM` on the SQLite database file; returns size before and after |

**`GET /api/admin/cbz-cache-size` and `POST /api/admin/clear-cbz-cache` response `data` shape:**

```json
{ "size_bytes": 104857600 }
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
