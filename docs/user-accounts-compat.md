# Design Doc — Feature Preservation & Backward Compatibility (User Accounts)

Status: **Implemented** (Phases 1–7 shipped) · Owner: _TBD_ · Last updated: 2026-05-25 · Companion to [user-accounts.md](./user-accounts.md)

> The user-accounts feature partitions reading state by account and turns
> `multi_user_enabled` on by default. This spec is the contract that **every
> preexisting feature keeps working exactly as before**. It promotes the §15
> regression analysis from a risk list into preservation requirements, each with
> a concrete mechanism and an acceptance test.

---

## 1. The compatibility invariant

**Default-User Equivalence:**

> With exactly one account — or with `multi_user_enabled = 0` — every preexisting
> feature behaves identically to how it did before accounts existed. With N
> accounts, each account independently reproduces that same single-user behavior
> over its own data.

Why this holds structurally:

- A fixed **default user (`id = 1`)** always exists after migration.
- `resolveUser` injects the default user whenever no valid `X-User-Token` is presented **or** the feature flag is off ([user-accounts.md §6.2](./user-accounts.md), §13.1).
- Every per-user query reads `req.user.id`. So "no accounts configured" ≡ "one implicit account" ≡ today's behavior.

This invariant is the acceptance bar for the whole project: the **single-user
parity suite** (§6) runs the app with one account and asserts its outputs match a
pre-feature snapshot, table-for-table and endpoint-for-endpoint.

---

## 2. Compatibility matrix

Every preexisting feature, the behavior we must preserve, the mechanism, and the
regression test that proves it. "Unchanged" = no code change needed; listed so
the audit is complete.

| Feature | Preserved behavior | Mechanism | Acceptance test |
|---|---|---|---|
| **Reading progress / Continue Reading** | Same current chapter/page, completed set, last-read ordering | `progress` gains `user_id`; all reads filter on it; default user holds migrated rows (§3.1) | Single account: `/api/progress/:id` and Home `continue_reading` match pre-feature snapshot |
| **Reader intra-chapter resume** | Resumes at the same page | `momotaro_resume_<id>` localStorage namespaced by user (§3.1) | Reopen mid-chapter → same page; second user on device has independent resume |
| **Reading lists (incl. Favorites / Want to Read)** | Same lists + memberships; defaults present | `reading_lists` gains `user_id`; defaults seeded per-user; legacy lists → default user (§3.2) | List CRUD + membership identical for the single account |
| **Home ribbons** (Continue, Discover, Recently Added, Art Gallery, Top-in-genre) | Same ribbons, same picks for the single user | All `progress`-derived queries filter `user_id`; cache key gains `user_id` (§3.3) | `/api/home` payload matches snapshot for one account |
| **Stats** (favorite genres, top manga, read time) | Same numbers for the single user; catalogue counts unchanged for everyone | `/api/stats` aggregates filter `user_id`; counts stay global; cache key gains `user_id` (§3.3) | `/api/stats` matches snapshot; admin "all users" view reproduces old whole-server numbers |
| **AniList login + progress sync** | Linking and sync work; the one existing link keeps working after upgrade | Re-keyed device→user (`user_anilist_sessions`); legacy session backfilled to default user; limiter stays global ([§ AniList](#anilist)) | Link AniList on one account → sync pushes correctly; upgrade keeps the prior link |
| **AniList metadata enrichment** (search/refresh/apply/bulk) | Unchanged — catalogue-wide, works unauthenticated | `getToken` keeps reading global `settings.anilist_token`; not per-user ([§ AniList](#anilist)) | Refresh/search/bulk return identical results with no user AniList link |
| **Config export / import** | Backup + restore round-trips; old backups still import | Versioned payload gains the user dimension; `ON CONFLICT(user_id,name)`; old backups → default user (§3.4) | Export→wipe→import reproduces state; a pre-feature backup imports onto the default user |
| **Offline read + progress buffering** (APK, AppImage) | Download, read offline, sync on reconnect | Outbox rows stamped with `user_id`; downloaded content stays device-level; gate requires user token (§3.6) | Offline read → reconnect → progress lands on the right account |
| **Pairing / PIN lockout** | Identical device-trust flow | Untouched — separate layer (§3.8) | Pairing wizard + 5-PIN lockout behave exactly as before |
| **Admin (Client Management, Port Forwarding, DB ops, connection log)** | Identical | Admin layer untouched; user-management is additive (§3.8) | All admin routes behave as before; new routes are additive |
| **Connection Log / CSV export** | Same events + columns, plus new login events | Additive `username` column + new event types; existing rows/queries unchanged (§3.8) | Existing event timeline + CSV unchanged; login events appear additionally |
| **Library / search / genres / art gallery / scanner** | Identical | Catalogue features read no per-user state (§3.8) | Listing, FTS search, genre browse, gallery, scan all match snapshot |
| **Third-Party Sourcing / downloads / schedules** | Identical | Device/server-level features, no per-user state (§3.8) | Download queue + schedules behave as before |
| **Doujinshi.info / MAL / MangaUpdates** | Identical | Server-wide creds, unchanged (§3.8) | Search/apply unchanged |

---

## 3. Per-feature preservation detail

### 3.1 Reading progress & reader resume

- **Server progress** ([progress.js](../server/src/routes/progress.js)): add `user_id`; every `WHERE manga_id = ?` becomes `WHERE user_id = ? AND manga_id = ?`. Migration assigns all existing rows to the default user, so a single account sees its full history untouched. The `ON DELETE CASCADE` from `manga` is preserved.
- **Reader resume** ([readingProgress.js](../client/src/utils/readingProgress.js)): the `momotaro_resume_<mangaId>` localStorage key becomes `momotaro_resume_<userId>_<mangaId>`. On upgrade, un-namespaced keys are read once as the default/first user's and rewritten, so no resume position is lost.
- **AniList sync trigger** is unchanged in *when* it fires (only on a real completion-state change); only *whose* token it uses changes ([§ AniList](#anilist)).

### 3.2 Reading lists & default-list seeding

- The global seed at [database.js:169](../server/src/db/database.js#L169) (`Favorites`, `Want to Read`) **moves into account creation** — each new user is seeded the same pair. The migration assigns the existing global lists (and their `reading_list_manga` rows) to the default user.
- `UNIQUE(name)` → `UNIQUE(user_id, name)`, so two users may both have a list called "Horror" without collision.
- Routes scope to `req.user.id`; touching a non-owned list returns `404` (existence not leaked). For a single account this is invisible — every list is theirs.

### 3.3 Home / stats / Discover / genre ribbons

- All `progress`-derived queries in `/api/home` and `/api/stats` filter `user_id` (enumerated in [user-accounts.md §9](./user-accounts.md)).
- **Catalogue figures stay global**: `total_manga`, `total_chapters`, `total_genres`, `top_genres` (inventory), Recently Added, and the per-genre *candidate pools* describe the library, not the user — unchanged for everyone.
- **Caches**: `_homeCache` and `_statsCache` keys gain `user_id`; `_readingListMangaCache` is already safe (globally-unique `list_id`); `_libraryCache` is catalogue-only. With one account the cache behaves exactly as today (one key set).
- **Admin parity for stats**: because per-account stats change what the admin sees versus the old whole-server numbers, add an admin-only "all users" aggregate (sum across users) so the operator can still get the pre-feature server-wide view. This is additive; the default per-account view is the new normal for readers.

### 3.4 Config export / import (versioned payload)

This is the highest-risk preexisting feature ([config.js](../server/src/routes/config.js)). Preservation plan:

1. **Schema-conflict fix (mandatory, same PR as the migration):** the import's `INSERT INTO reading_lists … ON CONFLICT(name)` ([config.js:316](../server/src/routes/config.js#L316)) retargets to `ON CONFLICT(user_id, name)`. Without this the import throws the moment the unique index changes.
2. **Payload version bump**: add `schema_version` to the export. Writers emit the user dimension:
   - `users` (no `password_hash` by default — export is for content portability, not credential transfer),
   - `progress`, `reading_lists`, `reading_history` each carry the owning `username`,
   - `user_anilist_sessions` replaces `device_anilist_sessions` (tokens redacted by default; opt-in flag to include them for a same-owner migration).
3. **Old-backup compatibility**: a pre-feature backup has no `users`/`username` keys. The importer detects the missing version and routes **all** progress / lists / history onto the **default user**, and folds the most-recently-updated legacy `device_anilist_sessions` row into the default user's AniList link. So every existing backup still restores cleanly.
4. **Round-trip parity**: with one account, export→import reproduces identical state (the parity suite asserts this).

### AniList

AniList tokens are already per-user — each OAuth grant authorizes one AniList
user and returns a **~1-year JWT** (no usable refresh) used as
`Authorization: Bearer` against `https://graphql.anilist.co`. The only change is
**where Momotaro keys them**: device → Momotaro user. This both fixes the
multi-user mismatch *and* preserves the single existing link across the upgrade.

**Data**
- New `user_anilist_sessions` keyed by `user_id` ([user-accounts.md §5.1](./user-accounts.md)). One AniList account per Momotaro user; one row per linked user → **many AniList accounts coexist on one server**.
- `anilist_media_list_cache` re-keyed `(device_id, media_id)` → `(user_id, media_id)`.
- `anilist_client_id` / `anilist_client_secret` stay **global** in `settings` (the server's registered OAuth app, not a per-user secret).

**Flows changed**
- OAuth exchange ([settings.js:111](../server/src/routes/settings.js#L111)): drop `X-Device-ID`; resolve `req.user.id` and store the token on that user's row. Keep the **authorization-code grant** (Momotaro has a backend + secret). The callback ([AnilistCallback.jsx](../client/src/pages/AnilistCallback.jsx)) is unchanged; the API client now attaches `X-User-Token`.
- Progress sync ([progress.js:164](../server/src/routes/progress.js#L164)): `syncToAniList(db, mangaId, completed, userId)` takes the **owning** `user_id` and uses that user's token; unlinked → skip silently.
- List-entry read / apply ([metadata.js:487](../server/src/routes/metadata.js#L487), [metadata.js:1873](../server/src/routes/metadata.js#L1873)) and `/api/manga/:id/anilist-status`: use `req.user.id`'s token + the re-keyed cache.

**Invariants preserved**
- **Global rate limiter (critical):** AniList's 90 req/min is **per IP**; every account's calls leave the server's single IP. The adaptive limiter in `anilistRequest()` (`recommendedDelayMs`) **stays one process-wide instance shared by all users**. Sharding per user would let N accounts each assume a full budget and collectively trip 429s. Multiple users' syncs serialize through the same limiter exactly as one user's calls do today.
- **Metadata enrichment unchanged:** search / refresh / fetch-by-ID (`getToken` → global `settings.anilist_token`, [metadata.js:26](../server/src/routes/metadata.js#L26)) read shared catalogue data and work unauthenticated — no per-user token required, behavior identical.
- **"When AniList is pinged" unchanged:** still only on direct user activity (the trigger list in [anilist.md](./anilist.md) is unaffected) — no background pings, no per-user timers.

**Migration / backfill (keeps the one existing link working)**
- Create `user_anilist_sessions`. There is no device→user mapping (devices predate users), so assign the **most-recently-updated** `device_anilist_sessions` row to the **default user** as their AniList link. The household's single AniList login therefore keeps syncing under the adopting account with no re-auth.
- Retain `device_anilist_sessions` read-only for one release, then drop it.
- **Token lifecycle**: decode the JWT `exp` into `token_expires_at`; on expiry, surface "AniList session expired — sign in again." Never attempt a refresh (AniList has no usable refresh endpoint).
- **Per-user export** ([user-accounts.md §7.6](./user-accounts.md)) includes the linkage (`anilist_username`, `anilist_user_id`) but **redacts the token** by default.

### 3.6 Offline mode (APK + AppImage)

Preserves offline download → read → reconnect-sync ([offline.md](./offline.md)):

- **Outbox attribution**: stamp the active `user_id` onto each `progress_outbox` row at `enqueueProgressWrite` time ([offlineApi.js:543](../client/src/api/offlineApi.js#L543)); `flushOutbox` ([outboxSync.js](../client/src/api/outboxSync.js)) replays with that user's `X-User-Token`. Rows queued **before** the upgrade have no `user_id` → attributed to the logged-in (adopting/default) user on first flush.
- **Downloaded content is device-level** ([user-accounts.md §14.2](./user-accounts.md)): CBZ pages live once on disk (SAF/offline folder), shared by all accounts on the device; only progress/history is per-user. The offline "downloaded" list (`offlineApi.getHome` → Recently Added) is identical for all users on a device.
- **Per-user IDB namespacing** for buffered progress so two users on one device don't cross-contaminate.
- **Gate**: `FirstLaunchGate`'s offline branch ([App.jsx:107](../client/src/App.jsx#L107)) additionally requires a stored user token (accounts can't be created offline, only used).
- Single-user result: offline behaves exactly as today.

### 3.7 Server-side caches

Covered in §3.3. The rule: **any cache whose value derives from `progress` gains
`user_id` in its key** (`_homeCache`, `_statsCache`); caches over catalogue or
globally-unique keys are left alone (`_libraryCache`, `_readingListMangaCache`).
A single account exercises one key set — identical to today.

### 3.8 Unchanged by construction (audited)

These read no per-user state and are deliberately left untouched; listed so the
audit is exhaustive:

- **Pairing + PIN lockout** ([pairing.js](../server/src/routes/pairing.js), [pinLockout.js](../server/src/auth/pinLockout.js)) — the device-trust layer, orthogonal to identity.
- **Admin password + sessions + all existing admin routes** ([adminAuth.js](../server/src/routes/adminAuth.js)) — user-management is additive.
- **Connection Log** ([connectionLog.js](../server/src/auth/connectionLog.js)) — additive `username` column + new event types; existing events, columns, and CSV layout unchanged.
- **Library listing / FTS search / genres / art gallery** ([library.js](../server/src/routes/library.js)) — catalogue reads.
- **Scanner, watcher, CBZ cache, thumbnails** — filesystem/catalogue, no reading state.
- **Third-Party Sourcing, download queue, schedules** — server/device-level.
- **MAL / MangaUpdates / Doujinshi.info** — server-wide credentials, unchanged.

---

## 4. Default-User Equivalence in code

The single mechanism that makes "no accounts" identical to "today":

```js
// middleware/userAuth.js (sketch)
function resolveUser(req, res, next) {
  if (!multiUserEnabled(db)) { req.user = DEFAULT_USER; return next(); }   // flag off
  const tok = req.headers['x-user-token'];
  const session = tok && lookupUserSession(tok);
  req.user = session ? session.user : null;       // null → requireUser 401s
  next();
}
```

- **Flag off** → `DEFAULT_USER` (id 1) on every request → all per-user queries collapse to the one user that owns the migrated data → byte-for-byte today.
- **Flag on, one account** → that account owns the migrated data → identical outputs once logged in.
- **Flag on, N accounts** → each request carries its own `req.user.id` → N independent reproductions of single-user behavior.

No route handler special-cases "no accounts"; they all just read `req.user.id`.
That uniformity is what guarantees the invariant rather than hoping each feature
remembered to handle the single-user case.

---

## 5. Migration ordering (must ship together)

Several changes hard-break the instant the schema changes, so they land in one
atomic migration + PR:

1. Create `users` + default user (id 1); `user_sessions`, `login_lockouts`, `reading_history`, `user_anilist_sessions`.
2. Rebuild `progress` / `reading_lists` per-user; assign legacy rows to the default user.
3. **Same PR:** move default-list seeding to per-account; patch `config.js` import to `ON CONFLICT(user_id, name)` and the versioned payload; re-key `anilist_media_list_cache`; backfill the legacy device AniList session onto the default user.

Until login lands (a later phase), the flag-off / default-user path keeps the app
fully functional — the schema migration alone changes no observable behavior.

---

## 6. Acceptance test plan ("works as before")

Three suites gate the rollout:

1. **Single-user parity** — capture a pre-feature snapshot of `/api/home`, `/api/stats`, `/api/progress/:id`, `/api/reading-lists`, a config export, and an AniList sync call. Run the same against the post-feature build with one account; assert equality (modulo additive fields). This is the direct proof of the §1 invariant.
2. **Multi-user isolation** — two accounts; assert A's reads never appear in B's home/stats/lists/history/progress, that each syncs to its own AniList, and that no cache cross-serves.
3. **Upgrade** — load a real pre-feature DB and a pre-feature config backup; assert: all legacy progress/lists/history land on the default user; the first created account adopts them; the legacy AniList link still syncs; the old backup imports cleanly.

Plus targeted regressions for each "Acceptance test" cell in §2.

---

## 7. Rollback

- **Soft disable**: set `multi_user_enabled = 0`. `resolveUser` reverts to the default user, `requireUser` no-ops, and the app behaves as single-user today. Per-account data created by other users is retained (still attributed to their `user_id`) but only the default user's data is surfaced until the flag is re-enabled.
- **Irreversible**: the schema rebuild (per-user `progress` / `reading_lists`, new tables) is forward-only; the default-user assignment means it is non-destructive — no reading data is lost by migrating, and the flag toggle is the supported on/off switch.
- **AniList**: disabling the flag leaves `user_anilist_sessions` intact; the default user's link (the backfilled legacy session) continues to work, matching pre-feature behavior.
