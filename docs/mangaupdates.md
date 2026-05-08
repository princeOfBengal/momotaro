# MangaUpdates Integration

Momotaro integrates with [MangaUpdates](https://www.mangaupdates.com/) for **metadata enrichment** — fetching titles, descriptions, genres, cover art, scores, and release status. There is no progress-sync surface (the API does have user list endpoints, but Momotaro does not consume them).

## Authentication

The two endpoints Momotaro uses — series search and series-by-id — are **public**. No API key, no OAuth, no headers. The `bearerAuth` scheme in the OpenAPI spec only covers user-scoped endpoints (lists, ratings, etc.) which Momotaro does not call.

This is the only third-party integration with no per-server credentials to configure: it works out of the box.

## API Requests

All requests hit:

```
Base URL: https://api.mangaupdates.com/v1
```

| Endpoint | Method | Used by |
|---|---|---|
| `/series/search` | POST | Auto-fetch (`fetchFromMangaUpdates`), manual search (`searchMangaUpdates`), batch auto-fetch by title |
| `/series/{series_id}` | GET | Apply by ID (`fetchByMangaUpdatesId`), batch refresh by ID, the round-trip after a search hit |

Search requests always include `stype: 'title'` and `perpage: 5` (auto-fetch) or `10` (manual search). The auto-fetch path takes the top result of the search and immediately follows up with a `/series/{id}` GET so the cached record has all the fields the search response omits (`authors`, full `description`, etc.).

## Manga Fields Used

The `SeriesModelV1` shape has dozens of fields; Momotaro normalises only what the rest of the app understands.

| MangaUpdates field | Momotaro field | Notes |
|---|---|---|
| `series_id` | `mangaupdates_id` | Integer — uses the modern long-form ID, not the legacy 6-digit one |
| `title` | `title` | |
| `description` | `description` | HTML in source — stripped to plain text, common entities decoded, `<br>` → newline |
| `status` (string) + `completed` (bool) | `status` | Free-text input; `completed=true` → `FINISHED`, otherwise the string is matched against `hiatus`/`cancel`/`ongoing`/`complete` |
| `year` (string) | `year` | First 4-digit run extracted to int |
| `genres[].genre` | `genres` | Array of strings |
| `bayesian_rating` | `score` | Already 0–10 — passed through unchanged |
| `image.url.original` (or `.thumb`) | `cover_url` | Full HTTPS URL on `cdn.mangaupdates.com` — used as the input to `fetchAndStoreCover` |
| `authors[]` | `author` | `type` is `"Author"` or `"Artist"` (same person can appear in both roles); names are deduped and joined with `, ` |

Normalisation is in [server/src/metadata/mangaupdates.js](../server/src/metadata/mangaupdates.js) → `normalizeSeries()`.

### Status mapping

`status` is free-text on MangaUpdates rather than an enum. The defensive heuristic:

| MU value (substring) | Momotaro `status` |
|---|---|
| `completed: true` | `FINISHED` |
| `Hiatus` | `HIATUS` |
| `Discontinued`, `Cancelled` | `CANCELLED` |
| `Ongoing`, `Publishing` | `RELEASING` |
| `Completed`, `Finished` | `FINISHED` |
| (anything else) | `UNKNOWN` |

## Title Cleaning

Before any search Momotaro runs the title through the shared `cleanSearchTitle` helper from [server/src/metadata/anilist.js](../server/src/metadata/anilist.js) — release-group brackets, volume/chapter markers, year ranges, and quality tags are stripped. The same helper feeds AniList and MAL, so all three sources see an identical scrubbed string.

## Cover Storage

When MangaUpdates metadata is applied, the cover image is downloaded and saved as:

```
{THUMBNAIL_DIR}/{mangaId}_mu.webp
```

The file is resized to 300 × 430 WebP at 85 % quality (same as AniList / MAL covers). The `mangaupdates_cover` column on the `manga` table records the filename. The active cover (`{mangaId}.webp`) is updated to point to this file **only when MangaUpdates becomes the displayed source**, per the priority order below.

## Rate Limiting & Bulk Throughput

MangaUpdates does not publish a rate limit. The acceptable use policy on [api.mangaupdates.com](https://api.mangaupdates.com/) asks for "reasonable spacing between requests so as not to overwhelm the MangaUpdates servers, and employ caching mechanisms when accessing data."

Bulk pulls therefore use **bounded concurrency** — same pattern as the MAL integration:

| Constant | Value | Purpose |
|---|---|---|
| `MU_BATCH_CONCURRENCY` | 3 | Maximum in-flight requests at once |
| `MU_BATCH_INTERVAL_MS` | 350 | Minimum time between successive request *starts* across all workers |
| `MU_REQUEST_INTERVAL_MS` | 1 000 | Strict-sequential floor used by code paths that don't run through the batch helper |

Steady-state throughput is **~3 req/sec** (concurrency ÷ stagger). The bulk metadata route slices `toRefresh` and `toSearch` into chunks of `MU_CHUNK_SIZE = 30`; after each chunk completes the `last_metadata_fetch_attempt_at` column is stamped, so a long-running bulk pull's progress is durable even if the server restarts.

### 429 / 503 handling — shared cooldown

All MangaUpdates HTTP calls go through the `muRequest` helper, which maintains a process-wide cooldown timestamp. When any request hits a 429 (rate-limit) or 503 (service temporarily unavailable — the spec documents this on several endpoints):

1. The `Retry-After` header is honoured (capped to `[1 s, 120 s]`); 60 s is the default if absent.
2. The cooldown timestamp is set to `now + retry-after` so every other in-flight worker sleeps until the cooldown clears before issuing its next request.
3. The original request retries up to 3 times.

This keeps three concurrent workers from each hammering MangaUpdates after a 429 and stretching the back-off into a multi-minute outage.

### Per-item failure semantics

`fetchBatchByMangaUpdatesIds` and `fetchBatchFromMangaUpdates` resolve a per-item lookup failure to `null` rather than throwing — one bad ID or a flaky single response never poisons the rest of the chunk. The bulk route also wraps each per-item DB write in its own `try` so an individual `applyMetadataToManga` failure increments the error counter and continues.

## Caching

Every successful by-ID fetch and every successful search result is written to a per-source JSON cache file at:

```
{DATA_PATH}/metadata-cache/mangaupdates/{seriesId}.json
```

via the shared cache module ([server/src/metadata/cache.js](../server/src/metadata/cache.js)). The Export Metadata flow (`POST /api/manga/:id/export-metadata` and the bulk variant) reads exclusively from this cache when `mangaupdates` is the source — it never re-pings MangaUpdates during export, matching the policy enforced for AniList and MAL.

## Metadata Priority

When a manga is linked to multiple sources, Momotaro displays whichever has the highest priority:

1. **Local JSON file** (`metadata_source = 'local'`)
2. **AniList** (`metadata_source = 'anilist'`)
3. **MyAnimeList** (`metadata_source = 'myanimelist'`)
4. **MangaUpdates** (`metadata_source = 'mangaupdates'`)
5. **Doujinshi.info** (`metadata_source = 'doujinshi'`)

Establishing a MangaUpdates linkage on a manga that's already AniList-displayed records the new `mangaupdates_id` and downloads the MU cover into `mangaupdates_cover` — but the visible title/description/cover stay on AniList. The Thumbnail Picker can still offer the MU cover, and the Metadata modal's MangaUpdates tab can still export MU JSON or break the linkage independently.

## API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/mangaupdates/search?q=…&page=…` | Manual search — returns up to 10 normalised results |
| `POST /api/manga/:id/refresh-mangaupdates-metadata` | Auto-fetch by title, apply the closest match |
| `POST /api/manga/:id/apply-mangaupdates-metadata` | Apply a specific entry by `mangaupdates_id` (selected via the manual-search modal) |
| `POST /api/libraries/:id/bulk-metadata` with `source: "mangaupdates"` | Bulk refresh / fetch over an entire library |
| `POST /api/manga/:id/reset-metadata` with `source: "mangaupdates"` | Break the MangaUpdates linkage |
| `POST /api/manga/:id/export-metadata` with `source: "mangaupdates"` | Write `metadata.json` from the cached MangaUpdates record (no upstream ping) |

## Relevant Files

- [server/src/metadata/mangaupdates.js](../server/src/metadata/mangaupdates.js) — All MangaUpdates fetch / search / normalize logic
- [server/src/metadata/cache.js](../server/src/metadata/cache.js) — Shared write-through JSON cache (`anilist`, `myanimelist`, `mangaupdates`, `doujinshi`)
- [server/src/routes/metadata.js](../server/src/routes/metadata.js) — API endpoints (search / refresh / apply / bulk / reset / export)
- [client/src/pages/MangaDetail.jsx](../client/src/pages/MangaDetail.jsx) — `MangaUpdatesSearchModal` component and Metadata modal integration
- [client/src/api/client.js](../client/src/api/client.js) — `searchMangaUpdates`, `applyMangaUpdatesMetadata`, `refreshMangaUpdatesMetadata`

## Crediting MangaUpdates

The MangaUpdates acceptable use policy asks that any product surfacing their data **credits MangaUpdates**. The Metadata modal in MangaDetail displays a "Linked to MangaUpdates" badge with a direct link to the series page on `mangaupdates.com` whenever a manga is MU-displayed; that's the in-app credit.
