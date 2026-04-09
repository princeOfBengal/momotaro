# API Reference

All routes are prefixed `/api`. Server runs on port 3000 in development.

The client API layer lives in [client/src/api/client.js](../client/src/api/client.js).

---

## Libraries

| Method | Path | Description |
|---|---|---|
| GET | `/api/libraries` | List all libraries |
| POST | `/api/libraries` | Create library `{ name, path }` |
| PATCH | `/api/libraries/:id` | Update library `{ name?, path?, show_in_all? }` |
| DELETE | `/api/libraries/:id` | Delete library and its manga |
| POST | `/api/libraries/:id/scan` | Trigger manual scan of one library |
| POST | `/api/scan` | Trigger full scan of all libraries |

---

## Manga / Library

| Method | Path | Description |
|---|---|---|
| GET | `/api/library` | List all manga (supports `?libraryId=`, `?search=`) |
| GET | `/api/manga/:id` | Get single manga |
| DELETE | `/api/manga/:id` | Remove manga from DB (does not delete files) |

---

## Chapters & Pages

| Method | Path | Description |
|---|---|---|
| GET | `/api/manga/:mangaId/chapters` | List chapters for a manga |
| GET | `/api/chapters/:id` | Get single chapter |
| GET | `/api/chapters/:id/pages` | List pages for a chapter |
| GET | `/api/pages/:id/image` | Serve page image (binary, with cache headers) |

---

## Progress

| Method | Path | Description |
|---|---|---|
| GET | `/api/progress/:mangaId` | Get reading progress |
| PUT | `/api/progress/:mangaId` | Update progress (triggers AniList sync) |
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

| Method | Path | Description |
|---|---|---|
| POST | `/api/manga/:id/refresh-metadata` | Auto-fetch from AniList by title |
| POST | `/api/manga/:id/apply-metadata` | Apply metadata from search result |
| GET | `/api/metadata/search?q=` | Search AniList by title |

---

## Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get all settings (tokens redacted) |
| PUT | `/api/settings` | Save settings `{ key: value, ... }` |

---

## AniList Auth (OAuth)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/anilist/exchange` | Exchange OAuth code for token `{ code, redirect_uri }` |
| DELETE | `/api/auth/anilist/logout` | Clear stored AniList token |
| GET | `/api/auth/anilist/status` | Check if AniList is connected |

---

## Reading Lists

| Method | Path | Description |
|---|---|---|
| GET | `/api/reading-lists` | List all reading lists |
| POST | `/api/reading-lists` | Create list `{ name }` |
| DELETE | `/api/reading-lists/:id` | Delete list |
| POST | `/api/reading-lists/:id/manga` | Add manga `{ mangaId }` |
| DELETE | `/api/reading-lists/:id/manga/:mangaId` | Remove manga from list |

---

## Optimization

| Method | Path | Description |
|---|---|---|
| POST | `/api/manga/:id/optimize` | Trigger image optimization for a manga |

---

## Health

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Returns `{ status: "ok" }` |

---

## Image URLs

Page images are served at:
```
GET /api/pages/:pageId/image
```

Thumbnails are served as static files from `THUMBNAIL_DIR`.

The client helper `api.pageImageUrl(pageId)` returns the full URL string.
