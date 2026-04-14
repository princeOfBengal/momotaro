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

`source` can be `"anilist"` (default) or `"doujinshi"`. The endpoint responds immediately and runs in the background.

**Metadata priority** — the bulk pull respects source priority to avoid overwriting higher-quality metadata:

- Source `anilist`: skips manga with `metadata_source = 'local'`
- Source `doujinshi`: skips manga with `metadata_source = 'local'` or `'anilist'`

Single-manga endpoints (`refresh-metadata`, `apply-metadata`, etc.) always apply regardless of existing source, since the user explicitly requested it.

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
