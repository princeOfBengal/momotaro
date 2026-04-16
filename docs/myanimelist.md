# MyAnimeList Integration

Momotaro integrates with MyAnimeList (MAL) for **metadata enrichment** — fetching titles, descriptions, genres, cover art, scores, and release status.

## Authentication

MAL metadata queries use a **Client ID** passed as the `X-MAL-CLIENT-ID` request header. No OAuth login is needed. The Client ID is stored server-wide in the `settings` table as `mal_client_id`.

To obtain a Client ID:
1. Go to [MyAnimeList → API Config](https://myanimelist.net/apiconfig) and click **Create ID**
2. Fill in App Name and App Type (select "web" for a server deployment)
3. Copy the Client ID and paste it into Settings → MyAnimeList Integration

## API Requests

All requests hit the MAL REST API v2:

```
Base URL: https://api.myanimelist.net/v2
```

Every request includes the header:

```
X-MAL-CLIENT-ID: {client_id}
```

No `Authorization` header or OAuth token is required for metadata-only usage.

## Manga Fields Requested

Every search result and detail fetch requests the same field list:

```
id, title, main_picture, alternative_titles, start_date, synopsis,
mean, status, genres, num_volumes, num_chapters, authors{first_name,last_name,role}
```

## Metadata Normalization

The `normalizeManga` function in [server/src/metadata/myanimelist.js](../server/src/metadata/myanimelist.js) maps the MAL response to Momotaro's standard metadata shape:

| MAL field | Momotaro field | Notes |
|---|---|---|
| `id` | `mal_id` | Integer |
| `alternative_titles.en` or `title` | `title` | English preferred |
| `synopsis` | `description` | MAL rewrite attribution stripped |
| `status` | `status` | See status map below |
| `start_date` | `year` | First 4 digits extracted |
| `genres[].name` | `genres` | Array of strings |
| `mean` | `score` | Float 0–10 |
| `main_picture.large` / `.medium` | `cover_url` | Used to download cover |
| `authors[]` | `author` | See author extraction below |

### Status mapping

| MAL `status` | Momotaro `status` |
|---|---|
| `finished` | `FINISHED` |
| `currently_publishing` | `RELEASING` |
| `not_yet_published` | `UPCOMING` |
| `on_hiatus` | `HIATUS` |
| `discontinued` | `CANCELLED` |

### Author extraction

The `authors` field is an array of `{ node: { first_name, last_name }, role: { key, name } }`. Author names are extracted with this priority:

1. Authors whose `role.name` is `"Story & Art"`, `"Story"`, or `"Art"` — joined with `, ` after deduplication
2. If none of those roles match, the first author in the array is used as a fallback

Names are formatted as `last_name first_name` (MAL convention), with empty parts omitted.

## Title Cleaning

Before auto-fetching, the manga's stored title is cleaned the same way as the AniList integration:

- Content inside `{}`, `[]`, and `()` is removed
- Hyphens and underscores are replaced with spaces
- Extra whitespace is collapsed and trimmed

## Cover Storage

When metadata is applied, the cover image is downloaded and saved as:

```
{THUMBNAIL_DIR}/{mangaId}_mal.webp
```

The file is resized to 300 × 430 WebP at 85 % quality (same as AniList covers). The `mal_cover` column in the `manga` table records the filename. The active cover (`{mangaId}.webp`) is updated to point to this file.

## Rate Limiting

MAL does not publish explicit rate limits. The bulk metadata loop spaces requests 700 ms apart, matching the AniList delay. If a 429 response is received, the service backs off for 60 seconds and retries once.

## Metadata Priority

When multiple sources are available, Momotaro respects this order:

1. **Local JSON file** (`metadata_source = 'local'`)
2. **AniList** (`metadata_source = 'anilist'`)
3. **MyAnimeList** (`metadata_source = 'myanimelist'`)
4. **Doujinshi.info** (`metadata_source = 'doujinshi'`)

Bulk metadata pulls skip any title that already has metadata from a higher-priority source. Per-manga apply endpoints always overwrite because the user explicitly selected a new entry.

## Relevant Files

- [server/src/metadata/myanimelist.js](../server/src/metadata/myanimelist.js) — All MAL fetch/search/normalize logic
- [server/src/routes/metadata.js](../server/src/routes/metadata.js) — API endpoints (`/api/mal/search`, `/api/manga/:id/refresh-mal-metadata`, `/api/manga/:id/apply-mal-metadata`)
- [server/src/routes/settings.js](../server/src/routes/settings.js) — `mal_client_id` storage in `settings` table
- [client/src/pages/MangaDetail.jsx](../client/src/pages/MangaDetail.jsx) — `MALSearchModal` component and metadata modal integration
- [client/src/pages/Settings.jsx](../client/src/pages/Settings.jsx) — MyAnimeList Integration settings section
