# AniList Integration

Momotaro integrates with AniList for:
1. **Metadata enrichment** — fetch titles, descriptions, genres, cover art
2. **Progress sync** — push reading progress back to the user's AniList list

## OAuth Setup

AniList uses OAuth 2.0. The user must create an AniList API application and supply the client ID and secret in Settings.

**Flow:**
1. User enters client ID + secret in Settings → stored in `settings` table
2. Frontend redirects user to `https://anilist.co/api/v2/oauth/authorize?...`
3. AniList redirects back to `<origin>/anilist/callback` with `?code=...`
4. `AnilistCallback.jsx` POSTs the code to `POST /api/auth/anilist/exchange`
5. Server exchanges code for access token via AniList token endpoint
6. Token stored in `settings` table under `anilist_token`

Relevant files:
- [server/src/metadata/anilist.js](../server/src/metadata/anilist.js) — All AniList GraphQL queries
- [server/src/routes/settings.js](../server/src/routes/settings.js) — OAuth exchange endpoint
- [client/src/pages/AnilistCallback.jsx](../client/src/pages/AnilistCallback.jsx) — Callback handler
- [client/src/pages/Settings.jsx](../client/src/pages/Settings.jsx) — Settings UI

## Metadata Fetch

Triggered automatically on scan (if `METADATA_FETCH_ENABLED=true`) or manually via the "Refresh Metadata" button in MangaDetail.

The server searches AniList by the manga's folder name / title, picks the best match, and stores:
- `anilist_id`, `mal_id`
- `title`, `description`, `status`, `year`, `genres`, `score`
- `track_volumes` — set to `1` if the AniList entry tracks volumes rather than chapters (e.g. light novels)
- `cover_image` — downloaded and saved as thumbnail

## Progress Sync

Triggered **asynchronously** after every `PUT /api/progress/:mangaId` call. The HTTP response is sent first; sync happens in the background.

Logic in [server/src/routes/progress.js](../server/src/routes/progress.js) → `syncToAniList()`:

1. Check `anilist_token` and `anilist_user_id` exist in settings — skip if not logged in
2. Check `manga.anilist_id` — skip if no AniList match
3. Skip if `completedChapters` is empty
4. Determine tracking mode from `manga.track_volumes`:
   - `track_volumes = 1` → query `chapters.volume` column → report as volume progress
   - `track_volumes = 0` → query `chapters.number` column → report as chapter progress
5. Find the **highest** completed number (`Math.floor(Math.max(...))`)
6. Fall back to `completedChapters.length` if no numbered entries exist
7. Determine status: `COMPLETED` if `completedChapters.length >= totalChapters`, else `CURRENT`
8. Call `saveMediaListEntry(token, anilistId, status, { chapters: N })` or `{ volumes: N }`

## GraphQL Queries Used

All in `server/src/metadata/anilist.js`:

| Function | Query | Purpose |
|---|---|---|
| `searchAnilistManga(token, title)` | `Page.media` | Search by title, returns top results |
| `getAnilistManga(token, id)` | `Media(id)` | Fetch by known AniList ID |
| `saveMediaListEntry(token, id, status, progress)` | `SaveMediaListEntry` mutation | Update user's list entry |
| `getAnilistUser(token)` | `Viewer` | Get logged-in user ID |

## `track_volumes` Flag

When AniList marks a manga as tracking volumes (e.g. light novels published by volume rather than serialized chapters), the `manga.track_volumes` column is set to `1`.

This flag affects:
- **UI labels**: "Volume 1" instead of "Chapter 1" in MangaDetail and the reader
- **Progress sync**: volume numbers are reported to AniList instead of chapter numbers
- **Chapter display**: chapter entries show `Volume N` if only a volume number is parsed
