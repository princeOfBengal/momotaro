# Doujinshi.info Integration

Momotaro integrates with [Doujinshi.info](https://doujinshi.info) for metadata enrichment of doujinshi titles. It's the lowest-priority third-party source — the order is AniList > MyAnimeList > MangaUpdates > Doujinshi.info — but it owns titles the other three don't index.

## Authentication

Doujinshi.info uses **email + password** login (not OAuth). The resulting JWT access token and refresh token are stored **server-wide** in the `settings` table — all devices share the same doujinshi.info account.

**Login flow:**

1. User enters email and password in Settings → Doujinshi.Info tab
2. Frontend POSTs to `POST /api/auth/doujinshi/login`
3. Server calls `POST https://api.doujinshi.info/v1/auth/login` and stores the returned tokens in `settings.doujinshi_token` and `settings.doujinshi_refresh_token`
4. `GET /api/settings` returns `doujinshi_logged_in: true` when a token is stored

Unlike AniList, doujinshi.info login does not track a username or avatar — the Settings UI simply shows a "Logged in" confirmation.

Authentication is optional for searching and fetching. The stored token is forwarded as a `Bearer` token on API calls when present, but read-only search and book fetch endpoints are publicly accessible.

Relevant files:

- [server/src/metadata/doujinshi.js](../server/src/metadata/doujinshi.js) — all API calls and normalization
- [server/src/routes/settings.js](../server/src/routes/settings.js) — login/logout endpoints
- [client/src/pages/Settings.jsx](../client/src/pages/Settings.jsx) — Doujinshi.Info settings UI

## Search Mechanics

The doujinshi.info backend returns a `502 Bad Gateway` error for any search query that contains spaces — a known server-side bug. Momotaro works around this by **replacing spaces with underscores** before sending the query:

```text
"Glasses In Summer Life"  →  "Glasses_In_Summer_Life"
```

The API recognises underscore-separated words as equivalent to space-separated words, so results are the same as a native multi-word search would produce.

All requests to `api.doujinshi.info` include an `Accept: application/json` header. If the server returns a non-JSON response (e.g. a Cloudflare error page), `readJson()` throws a clean error — `"Doujinshi.info returned a non-JSON response (HTTP N). The service may be temporarily unavailable"` — instead of a raw JSON parse failure.

## Metadata Normalization

The `normalizeBook()` function maps a doujinshi.info book object to Momotaro's standard metadata shape:

| Doujinshi.info field | Stored as | Notes |
| --- | --- | --- |
| `name.english` / `name.romaji` / `name.japanese` | `title` | First non-empty value |
| `slug` | `doujinshi_id` | Text slug, e.g. `glasses-in-summer-life` |
| `cover` | `doujinshi_cover` (`<mangaId>_dj.webp`) | Downloaded and saved as WebP thumbnail. Active cover is then chosen by the priority resolver — see [scanner.md § Cover Priority](./scanner.md#cover-priority). Legacy installs that pre-date the dedicated column have their `<mangaId>_cover.webp` filename backfilled into `doujinshi_cover` at startup. |
| `date_released` (YYYY-MM-DD) | `year` | First 4 digits |
| `tags.data` where `type.slug === 'genre'` | `genres` | JSON array |
| `tags.data` where `type.slug === 'artist'` | `author` | Joined with `", "` |
| `tags.data` where `type.slug === 'circle'` | `author` | Fallback if no artist tags |
| — | `status` | Always `FINISHED` (doujinshi are complete works) |
| — | `description`, `score` | Always `null` (not provided by the API) |
| — | `anilist_id`, `mal_id` | Always `null` |

**Tags are only returned on full book fetches** (`GET /book/{slug}`), not on search results. When a user selects a result from the search modal or the auto-fetch resolves the top result, a full book fetch is always performed first so that genres and author are populated.

## Caching

Every successful slug fetch (`fetchByDoujinshiSlug`) writes the normalized record to the shared per-source JSON cache at:

```text
{DATA_PATH}/metadata-cache/doujinshi/{slug}.json
```

via the same cache module the other three sources use ([server/src/metadata/cache.js](../server/src/metadata/cache.js)). Slug values are sanitized (`[^a-zA-Z0-9_-]` is replaced with `_`) before being used as a filename so a malformed slug can never escape the cache directory; in practice the upstream slugs are already URL-safe so the sanitization is a no-op.

Two consumers read this cache:

- **Bulk Export Metadata** — `POST /api/libraries/:id/export-metadata` and the per-manga variant emit the cached doujinshi record without re-pinging doujinshi.info.
- **Break Linkage fallback** — when the user breaks the currently-displayed source on a manga that's also linked to doujinshi.info, the [Break Linkage fallback path](./api.md#fallback-after-break-linkage) reads the cached doujinshi record and re-applies it without a network call. The same path runs at the end of every library scan via the [metadata-priority enforcement pass](./scanner.md#end-of-scan-metadata-priority-enforcement).

## API Functions

All in [server/src/metadata/doujinshi.js](../server/src/metadata/doujinshi.js):

| Function | HTTP call | Purpose |
| --- | --- | --- |
| `loginDoujinshi(email, password)` | `POST /auth/login` | Exchange credentials for access + refresh tokens |
| `refreshDoujinshiToken(accessToken, refreshToken)` | `POST /auth/login` | Obtain a new access token using the stored refresh token |
| `searchDoujinshi(query, token, page)` | `GET /search?q=…` | Search with underscore-normalised query, returns up to 10 results |
| `fetchFromDoujinshi(title, token)` | search + `GET /book/{slug}` | Auto-fetch: search, then fetch full detail of top result |
| `fetchByDoujinshiSlug(slug, token)` | `GET /book/{slug}` | Fetch full book detail (including tags) by known slug |

## Metadata Priority

Metadata fields and covers follow two **separate** priority systems — see [scanner.md § Cover Priority](./scanner.md#cover-priority) for the full cover story; what follows here is just doujinshi-specific.

**Text-field priority** — local JSON wins, every third-party source is ranked, then `none`:

1. **Local JSON** (`metadata_source = 'local'`) — never overwritten by bulk or single-manga pulls. Pulls against a `'local'` title perform a **link-only** write: only the external ID is stored.
2. **AniList** (`metadata_source = 'anilist'`)
3. **MyAnimeList** (`metadata_source = 'myanimelist'`)
4. **MangaUpdates** (`metadata_source = 'mangaupdates'`)
5. **Doujinshi.info** (`metadata_source = 'doujinshi'`)

Applying a higher-priority source on top of a lower-priority displayed manga rewrites text fields and updates `metadata_source`. Applying a lower-priority source records the linkage but leaves text fields alone.

**Cover priority** — local JSON does **not** enter; the active `<mangaId>.webp` is chosen by:

```text
anilist_cover > mal_cover > mangaupdates_cover > doujinshi_cover > original_cover
```

So a Doujinshi.info-only manga ends up with the doujinshi cover as active, and adding any higher-priority linkage automatically promotes that source's cover on the next reinforcement pass (which runs after every library scan, or on demand via `POST /api/admin/reset-thumbnails`). Manual user picks via `set-thumbnail` are sticky against fetches but cleared by Reset Thumbnails.

## Bulk Metadata Pull

The bulk metadata pull endpoint (`POST /api/libraries/:id/bulk-metadata`) accepts an optional `source` field in the request body:

```json
{ "source": "doujinshi" }
```

Defaults to `"anilist"` if omitted. Valid values: `"anilist"`, `"myanimelist"`, `"mangaupdates"`, `"doujinshi"`. The frontend (Settings → Library Management) shows a dropdown when the **Bulk Metadata Pull** button is clicked, letting the user choose between all four sources.
