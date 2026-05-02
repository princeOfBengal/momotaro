# AniList Integration

Momotaro integrates with AniList for:

1. **Metadata enrichment** — fetch titles, descriptions, genres, cover art
2. **Progress sync** — push reading progress back to the user's AniList list

## When the server pings AniList

AniList is only contacted in response to direct user activity. The server is
**never** allowed to ping AniList in the background, on a timer, while idle,
or as part of an export. The complete list of triggers:

- The user clicks **Refresh Metadata** or runs an AniList **search** on a manga
  (`POST /api/manga/:id/refresh-metadata`, `GET /api/anilist/search`,
  `POST /api/manga/:id/apply-metadata`).
- The user runs a **bulk metadata pull** for a library
  (`POST /api/libraries/:id/bulk-metadata` with `source=anilist`). The pull
  paces itself off the live `X-RateLimit-Limit` header — see below.
- The user **finishes a chapter / volume** while logged in to AniList — the
  progress sync inside `PUT /api/progress/:mangaId` pushes the new highest
  chapter to the user's list.
- The user opens a manga's detail page — `GET /api/manga/:id/anilist-status`
  reads the user's list entry, but only on a per-device cache miss
  (5-minute TTL). Repeated browsing of the same manga does not re-ping.
- One-off OAuth events (token exchange + viewer fetch on login).

**Export Metadata never pings AniList or MAL.** Both library-level and
per-manga export endpoints serialize the previously-pulled record from the
on-disk JSON cache (or the manga row, as a final fallback). If a per-source
export is requested for a source that has never been fetched, the endpoint
returns 409 with a hint to run a refresh first; it does **not** reach out
to AniList silently.

Every AniList HTTP request is logged through a single `[AniList]` line in
the system log so the operator can audit exactly when and why each ping
happened.

## Per-Device Login

AniList login is **per device** (per browser). Each browser generates a UUID on first load, stores it in `localStorage` as `momotaro_device_id`, and sends it as the `X-Device-ID` header on every API request.

The server stores login state in the `device_anilist_sessions` table keyed by `device_id`. Logging in on one device does not affect any other device's session. Logging out only clears the session for the requesting device.

The OAuth client credentials (`anilist_client_id`, `anilist_client_secret`) are still global — stored in the `settings` table — since they belong to the server's registered AniList application, not to individual users.

## OAuth Setup

AniList uses OAuth 2.0. The user must create an AniList API application and supply the client ID and secret in Settings.

**Flow:**

1. User enters client ID + secret in Settings → stored in `settings` table
2. Frontend redirects user to `https://anilist.co/api/v2/oauth/authorize?...`
3. AniList redirects back to `<origin>/anilist/callback` with `?code=...`
4. `AnilistCallback.jsx` POSTs the code to `POST /api/auth/anilist/exchange`
5. Server exchanges code for access token via AniList token endpoint
6. Token stored in `device_anilist_sessions` for the requesting device's `X-Device-ID`

Relevant files:

- [server/src/metadata/anilist.js](../server/src/metadata/anilist.js) — All AniList GraphQL queries
- [server/src/routes/settings.js](../server/src/routes/settings.js) — OAuth exchange endpoint
- [client/src/pages/AnilistCallback.jsx](../client/src/pages/AnilistCallback.jsx) — Callback handler
- [client/src/pages/Settings.jsx](../client/src/pages/Settings.jsx) — Settings UI

## Metadata Fetch

Triggered manually by the user — either the "Refresh Metadata" button on a manga's detail page, the "Refresh / Apply" actions in the metadata search modal, or a library-level bulk metadata pull from Settings. The library scanner does **not** call AniList; scans only apply local `metadata.json` sidecars when present.

The server searches AniList by the manga's folder name / title, picks the best match, and stores:

- `anilist_id` — recorded on the manga row. Existing `mal_id` / `mangaupdates_id` / `doujinshi_id` linkages are preserved via `COALESCE` and never overwritten by an AniList apply.
- `title`, `description`, `status`, `year`, `genres`, `score` — written only when the incoming source's display priority ≥ the manga's current `metadata_source` (see [api.md § Linkage and display priority](./api.md#linkage-and-display-priority)).
- `author` — extracted from the AniList `staff` edges (see below). Subject to the same display-priority guard.
- `anilist_cover` — downloaded to `<mangaId>_anilist.webp`. The active `<mangaId>.webp` is then re-resolved by the cover-priority resolver, which respects `cover_user_set` and falls through `anilist > mal > mangaupdates > doujinshi > original`.

`track_volumes` is **not** populated by the metadata fetch path — it is a per-manga toggle the user controls via `PATCH /api/manga/:id` (Settings on MangaDetail). It affects how the reader labels chapters and how progress is reported to AniList.

Every successful by-ID or search response is also written to a per-source JSON cache file at `data/metadata-cache/anilist/<id>.json`. The Export Metadata flow reads these cache files instead of re-pinging AniList.

### Author Extraction from Staff

The `MEDIA_FIELDS` GraphQL fragment requests `staff(perPage: 10, sort: [RELEVANCE]) { edges { role node { name { full } } } }`. After fetching, `normalizeMedia()` filters edges to roles `"Story & Art"`, `"Story"`, and `"Art"`, deduplicates the resulting names, and joins them with `", "`. The result is stored in `manga.author`.

If no staff edges match those roles the field is stored as `null` and the author label is omitted on the manga page.

## Progress Sync

Triggered **asynchronously** when (and only when) the set of completed chapters
for a manga actually changes. The HTTP response is sent first; sync happens in
the background. Routine page-by-page progress saves while the user is mid-chapter
do **not** trigger a sync — this is enforced server-side so the reader can keep
debouncing page updates without worrying about hammering AniList.

The two routes that can trigger a sync are:

- `PUT /api/progress/:mangaId` — fires the sync **only** when the request both
  carries `markChapterComplete: true` AND the `chapterId` was not already in the
  stored `completed_chapters`. This is the "user advanced past the last page of
  a chapter" case. Every other PUT (page-by-page progress within an unfinished
  chapter, or a re-mark of an already-completed chapter) skips the sync.
- `PATCH /api/progress/:mangaId/chapter/:chapterId` — fires the sync **only**
  when the chapter's completion state actually flips (unread → completed or
  completed → unread). A no-op toggle does not ping AniList.

Both handlers extract `X-Device-ID` from the request header and pass it to
`syncToAniList()`. That function looks up the token from
`device_anilist_sessions` for that device. If the device has no AniList session,
sync is skipped silently.

Logic in [server/src/routes/progress.js](../server/src/routes/progress.js) → `syncToAniList()`:

1. Look up `anilist_token` and `anilist_user_id` from `device_anilist_sessions` for the request's `device_id` — skip if not logged in
2. Check `manga.anilist_id` — skip if no AniList match
3. Skip if `completedChapters` is empty
4. Determine tracking mode from `manga.track_volumes`:
   - `track_volumes = 1` → query `chapters.volume` column → report as volume progress
   - `track_volumes = 0` → query `chapters.number` column → report as chapter progress
5. Find the **highest** completed number (`Math.floor(Math.max(...))`)
6. Fall back to `completedChapters.length` if no numbered entries exist
7. Determine status: `COMPLETED` if `completedChapters.length >= totalChapters`, else `CURRENT`
8. Call `saveMediaListEntry(token, anilistId, status, { chapters: N })` or `{ volumes: N }`

## Rate Limiting

`anilistRequest()` in `anilist.js` reads the rate-limit headers AniList returns on every response and adapts inter-call spacing accordingly. Bulk loops should consult `recommendedDelayMs()` instead of hardcoding a delay.

**Headers consumed:**

| Header | Used for |
| --- | --- |
| `X-RateLimit-Limit` | Sets steady-state spacing to `60_000 / limit + 50 ms` (e.g. 717 ms at 90 req/min, 2 050 ms at the temporarily-degraded 30 req/min). |
| `X-RateLimit-Remaining` | When ≤ 5, the spacing is stretched so the rest of the budget lands after `X-RateLimit-Reset`. |
| `X-RateLimit-Reset` | Unix-seconds anchor for the above. |
| `Retry-After` (on 429) | Drives the existing retry loop. |

The recommended delay is clamped to `[700, 5 000] ms`. A 429 forces it to 5 000 ms until headers from a successful response indicate the service is healthy again. The retry loop itself is unchanged: up to 3 attempts honouring `Retry-After` (capped at 90 s); throws `'AniList rate limit exceeded after 3 retries'` if all attempts fail.

**Adult content:** Single-title queries (`AUTO_SEARCH_QUERY`, `MANUAL_SEARCH_QUERY`, `FETCH_BY_ID_QUERY`) do not pass `isAdult`, so AniList returns adult and SFW titles together — matching the on-disk library scanner, which indexes whatever the user dropped in. The bulk-search batch path (`fetchBatchFromAniList`) currently passes `isAdult: false` on each alias, so a bulk title-search phase only matches SFW results; pre-linked manga that go through the bulk refresh-by-ID phase (`fetchBatchByAniListIds`) and manual single-manga search/apply paths are unaffected.

## GraphQL Queries Used

All in `server/src/metadata/anilist.js`:

| Function | Query | Purpose |
|---|---|---|
| `fetchFromAniList(title, token)` | `Media(search)` | Auto-fetch best match by title |
| `searchAniList(query, token, page)` | `Page.media` | Manual search, returns up to 10 results |
| `fetchByAniListId(id, token)` | `Media(id)` | Fetch by known AniList ID |
| `saveMediaListEntry(token, id, status, opts)` | `SaveMediaListEntry` mutation | Update user's list entry |
| `getMediaListEntry(token, userId, mediaId)` | `MediaList` | Fetch user's existing list entry |
| `getViewer(token)` | `Viewer` | Get logged-in user profile |

All media queries use the shared `MEDIA_FIELDS` fragment which includes `staff` edges for author extraction.

## `track_volumes` Flag

`manga.track_volumes` is a per-manga toggle the user controls from MangaDetail (it ships PATCH `/api/manga/:id` with `{ track_volumes }`). Defaults to `0`. It is **not** populated by any metadata fetch path — neither AniList, MAL, MangaUpdates, nor Doujinshi.info touches it.

When set to `1`, this flag affects:
- **UI labels**: "Volume 1" instead of "Chapter 1" in MangaDetail and the reader
- **Progress sync**: volume numbers are reported to AniList (`{ volumes: N }`) instead of chapter numbers (`{ chapters: N }`)
- **Chapter display**: chapter entries show `Volume N` if only a volume number is parsed
