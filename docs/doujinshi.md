# Doujinshi.info Integration

Momotaro integrates with [Doujinshi.info](https://doujinshi.info) for metadata enrichment of doujinshi titles. It is a secondary metadata source alongside AniList.

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
| `cover` | `cover_url` → `cover_image` | Downloaded and saved as WebP thumbnail |
| `date_released` (YYYY-MM-DD) | `year` | First 4 digits |
| `tags.data` where `type.slug === 'genre'` | `genres` | JSON array |
| `tags.data` where `type.slug === 'artist'` | `author` | Joined with `", "` |
| `tags.data` where `type.slug === 'circle'` | `author` | Fallback if no artist tags |
| — | `status` | Always `FINISHED` (doujinshi are complete works) |
| — | `description`, `score` | Always `null` (not provided by the API) |
| — | `anilist_id`, `mal_id` | Always `null` |

**Tags are only returned on full book fetches** (`GET /book/{slug}`), not on search results. When a user selects a result from the search modal or the auto-fetch resolves the top result, a full book fetch is always performed first so that genres and author are populated.

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

Metadata fields and covers follow two separate priority systems — the metadata fields are protected from overwrite by source, while the active thumbnail has its own promotion priority.

**Metadata fields** — local JSON is always preserved as the display source for fields (title, description, genres, etc.):

1. **Local JSON** (`metadata_source = 'local'`) — never overwritten by bulk or single-manga pulls. Bulk pulls against a `'local'` title perform a **link-only** write: only the external ID (`anilist_id` / `mal_id` / `doujinshi_id`) is stored.
2. **Third-party** (`metadata_source = 'anilist' | 'myanimelist' | 'doujinshi'`) — already-linked third-party titles are skipped by bulk pulls entirely. Per-manga apply endpoints still overwrite because the user explicitly chose a new entry.
3. `'none'` titles receive a full metadata apply on first bulk pull.

**Cover promotion** — covers have their own priority independent of the metadata-field rule above. During bulk pulls the enforced order is AniList > MyAnimeList > Doujinshi.info; a lower-priority source's cover is saved to its own column but does not overwrite `cover_image` when a higher-priority cover already exists. This applies uniformly to `'none'` and `'local'` titles, so a local-metadata title receiving AniList linkage via bulk pull will still swap its thumbnail to the AniList cover.

For single-manga operations (Fetch button, manual search), the user is explicitly choosing a source — cover promotion always fires regardless of what other covers are already saved (user intent overrides the priority rule). The metadata-field rule still applies: local JSON titles get link-only writes; other sources fully overwrite.

## Bulk Metadata Pull

The bulk metadata pull endpoint (`POST /api/libraries/:id/bulk-metadata`) now accepts an optional `source` field in the request body:

```json
{ "source": "doujinshi" }
```

Defaults to `"anilist"` if omitted. The frontend (Settings → Library Management) shows a dropdown when the "Bulk Metadata Pull" button is clicked, letting the user choose between AniList and Doujinshi.info.
