# AniList Integration

> **Shipped (Phase 3):** AniList is per **Momotaro user**, not per device. Each
> account links its own AniList; multiple AniList accounts coexist on one
> server. Login state is stored in `user_anilist_sessions` (PK `user_id`), and
> the per-user list-entry cache is keyed `(user_id, media_id)`. The legacy
> `device_anilist_sessions` table is migrated to the default user on first
> boot and then dropped (Phase 7). Design refs:
> [user-accounts.md §7.7](./user-accounts.md) ·
> [user-accounts-compat.md § AniList](./user-accounts-compat.md#anilist).

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

## Per-User Login

AniList login is **per Momotaro user**. Each account links its own AniList,
many AniList accounts coexist on one server, and the link follows the account
across devices instead of being pinned to whichever browser logged in.

The server stores login state in `user_anilist_sessions` keyed by `user_id`
(see [server/src/db/database.js](../server/src/db/database.js)). The OAuth
exchange resolves `req.user.id` (the logged-in Momotaro user, via the
`X-User-Token` header) and writes the JWT + decoded `exp` to that user's row.
Logging out (`DELETE /api/auth/anilist`) only clears the requesting user's
link.

In single-user / pre-accounts mode the implicit default user (id=1) owns the
link, so a household with one Momotaro user has exactly one AniList session
— the same single-user behavior as before.

The OAuth client credentials (`anilist_client_id`, `anilist_client_secret`)
remain global in the `settings` table — they belong to the server's
registered AniList application, not to any individual user.

**Rate-limit invariant:** AniList's 90 req/min limit is per-IP and every
account's calls leave the server's one IP, so the adaptive limiter in
`anilistRequest()` is a **single process-wide instance shared by all users**.
Sharding it per user would let N accounts each assume a full budget and
collectively trip 429s — do not do that.

## OAuth Setup

AniList uses OAuth 2.0. The user must create an AniList API application and supply the client ID and secret in Settings.

**Flow:**

1. User enters client ID + secret in Settings → stored in `settings` table
2. Frontend redirects user to `https://anilist.co/api/v2/oauth/authorize?...`
3. AniList redirects back to `<origin>/anilist/callback` with `?code=...`
4. `AnilistCallback.jsx` POSTs the code to `POST /api/auth/anilist/exchange`
5. Server exchanges code for access token via AniList token endpoint
6. Token stored in `user_anilist_sessions` for the requesting Momotaro user (`req.user.id`, resolved from the `X-User-Token`); the JWT's `exp` is decoded into `token_expires_at` so the UI can prompt re-login on expiry.

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

Both handlers pass the owning `req.user.id` (the Momotaro user whose progress
changed) into `syncToAniList()`. That function looks up the token from
`user_anilist_sessions` for that user. If the user has no AniList session,
sync is skipped silently. So User A's reads sync to A's AniList, User B's to
B's; a device shared between two accounts no longer cross-attributes.

Logic in [server/src/routes/progress.js](../server/src/routes/progress.js) → `syncToAniList()`:

1. Look up `anilist_token` and `anilist_user_id` from `user_anilist_sessions` for the owning `user_id` — skip if that user hasn't linked AniList
2. Check `manga.anilist_id` — skip if no AniList match
3. Skip if `completedChapters` is empty
4. Compute the **highest** completed chapter AND volume in one query —
   `MAX(COALESCE(number_end, number))` and `MAX(COALESCE(volume_end, volume))`.
   The `COALESCE(*_end, *)` is what makes **multi-chapter / multi-volume files**
   report correctly: finishing a `v17-18.cbz` pushes volume **18** (the end of
   the range), not 17. This is intentionally the *furthest read* integer, **not**
   a contiguous 1..N count — marking a later chapter complete reports that number
   even if earlier ones are unmarked, matching how AniList models progress. Do
   not "fix" it into a contiguous walk.
5. **Send both axes when known.** AniList stores chapter (`progress`) and volume
   (`progressVolumes`) progress independently, so a combined `Vol 17-18 Ch
   150-160` read writes both fields accurate in a single `saveMediaListEntry`
   mutation: `{ chapters: 160, volumes: 18 }`. `track_volumes` no longer decides
   *which* field is sent — it only governs the COMPLETED threshold and the
   count-fallback axis (step 6).
6. If **neither** axis has a numbered entry, fall back to `completedChapters.length`
   on the primary axis (`volumes` when `track_volumes = 1`, else `chapters`).
7. Determine status: `COMPLETED` if `completedChapters.length >= totalChapters`, else `CURRENT`
8. Call `saveMediaListEntry(token, anilistId, status, progressArg)` where
   `progressArg` carries whichever of `{ chapters, volumes }` are non-null.

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
- **Progress sync**: governs the COMPLETED-status threshold and the count-fallback axis. Both `progress` and `progressVolumes` are sent to AniList whenever the data exists (see [Progress Sync](#progress-sync)); `track_volumes` no longer toggles which field is written.
- **Chapter display**: chapter entries show `Volume N` if only a volume number is parsed
