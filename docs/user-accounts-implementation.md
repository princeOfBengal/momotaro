# Implementation Plan — User Accounts

Status: **Implemented** (Phases 1–7 shipped) · Owner: _TBD_ · Last updated: 2026-05-25

> Executable, dependency-ordered plan to build the user-accounts feature.
> Design: [user-accounts.md](./user-accounts.md). Compatibility contract:
> [user-accounts-compat.md](./user-accounts-compat.md). This doc is the *how* and
> *in what order* — file-level tasks, function signatures, tests, and a
> shippable checkpoint per phase.

---

## 0. Ground rules

- **Branch per phase.** Each phase below is independently reviewable and leaves `main` working. Never merge a phase that breaks the [Default-User Equivalence invariant](./user-accounts-compat.md#1-the-compatibility-invariant).
- **The flag during the build.** `multi_user_enabled` is read through one helper. It is treated as **OFF (default-user mode)** until the client login lands (Phase 5), so every dev build stays usable; Phase 7 flips the code default to **ON** and verifies on-by-default end to end. "OFF" never means "no `user_id`" — it means `resolveUser` injects the fixed default user, so the per-user code paths are exercised from Phase 1.
- **Default user.** Migration creates `users(id=1, username='default')` with a random unusable password. `DEFAULT_USER_ID = 1` is a shared constant. The first real account created **adopts** row 1 ([user-accounts.md §13.3](./user-accounts.md)).
- **Tests.** Match the existing convention: plain `node:assert` scripts under `server/test/*.test.js`, run with `node test/<name>.test.js`, exit non-zero on failure (see [test/taskRegistry.test.js](../server/test/taskRegistry.test.js)). No test-runner dependency is added.
- **DB rebuilds.** `progress` / `reading_lists` / `anilist_media_list_cache` change uniqueness, so they use the table-rebuild pattern of `upgradeToMultiLibrary` ([database.js:640](../server/src/db/database.js#L640)). Toggle `PRAGMA foreign_keys=OFF` around each rebuild (outside a transaction), then `PRAGMA foreign_key_check` after — `foreign_keys` is ON globally ([database.js:13](../server/src/db/database.js#L13)).
- **Migrations are forward-only and non-destructive** (assign to default user, never drop reading data). Rollback = flip the flag, not a down-migration (§Rollback in the compat doc).

---

## Phase 1 — Schema + default-user scoping (invisible) · **L**

Goal: all reading state becomes per-user and is attributed to the default user.
The app behaves byte-for-byte as today. No login, no client change.

### DB — [server/src/db/database.js](../server/src/db/database.js)
Add to `migrate()` after `createAuthTables(db)`, in this order:

1. `createUserTables(db)` — `users`, `user_sessions`, `login_lockouts`, `reading_history`, `user_anilist_sessions` (DDL in [user-accounts.md §5.1](./user-accounts.md)).
2. `ensureDefaultUser(db)` — `INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (1, 'default', <random-unusable>)`.
3. `migrateProgressToPerUser(db)` — guard on `pragma_table_info('progress')` lacking `user_id`; rebuild `progress_new` with `UNIQUE(user_id, manga_id)`, `INSERT … SELECT 1, manga_id, …`.
4. `migrateReadingListsToPerUser(db)` — guard likewise; rebuild with `UNIQUE(user_id, name)`, assign existing rows (incl. `is_default`) to user 1. `reading_list_manga` untouched.
5. `rekeyAniListMediaCache(db)` — rebuild `anilist_media_list_cache` keyed `(user_id, media_id)`; map legacy rows to user 1 (or drop — it's a cache).
6. `backfillUserAniListSession(db)` — copy the most-recently-updated `device_anilist_sessions` row into `user_anilist_sessions(user_id=1)`. Keep `device_anilist_sessions` read-only for one release.
7. `addColumnIfMissing(db, 'connection_attempts', 'username', 'TEXT')`.

Add `seedDefaultLists(db, userId)` (extract from the global seed at [database.js:169](../server/src/db/database.js#L169)); call it for new users in Phase 2, not globally.

### Server middleware — new [server/src/middleware/userAuth.js](../server/src/middleware/userAuth.js)
Phase-1 stub:
```js
const DEFAULT_USER = { id: 1, username: 'default', is_admin: 1 };
function resolveUser(req, _res, next) { req.user = DEFAULT_USER; next(); } // real lookup in Phase 2
function requireUser(req, res, next) { return next(); }                    // enforced in Phase 2
```
Mount in [index.js](../server/src/index.js): insert `resolveUser` on the gated tier, e.g. change each gated `app.use('/api', requireClientOrAdmin, <router>)` to `app.use('/api', requireClientOrAdmin, resolveUser, <router>)` (or one `app.use('/api', resolveUser)` immediately before the gated block at [index.js:135](../server/src/index.js#L135)).

### Server routes — scope to `req.user.id`
- [progress.js](../server/src/routes/progress.js): every `WHERE manga_id = ?` → `WHERE user_id = ? AND manga_id = ?`; INSERTs include `user_id`; append a `reading_history` row on PUT/PATCH. (AniList sync still device-keyed here — rewired in Phase 4.)
- [library.js](../server/src/routes/library.js): reading-list routes ([:208](../server/src/routes/library.js#L208)) scope to `req.user.id`; `/api/stats` ([:756](../server/src/routes/library.js#L756)) and `/api/home` ([:945](../server/src/routes/library.js#L945)) progress-derived queries add `user_id`; **add `user_id` to `_statsCache` and `_homeCache` keys** ([:750](../server/src/routes/library.js#L750), [:951](../server/src/routes/library.js#L951)).

### Config export/import — [server/src/routes/config.js](../server/src/routes/config.js) (mandatory this phase — hard-breaks otherwise)
- Import: retarget `INSERT INTO reading_lists … ON CONFLICT(name)` → `ON CONFLICT(user_id, name)` ([config.js:316](../server/src/routes/config.js#L316)).
- Export/import gain the user dimension + `schema_version`; pre-version payloads route all `progress`/lists/history to user 1; `user_anilist_sessions` replaces the `device_anilist_sessions` block (tokens redacted by default). Detail: [compat §3.4](./user-accounts-compat.md#34-config-export--import-versioned-payload).

### Tests
- `server/test/migration.test.js` — on a seeded pre-feature DB: progress/lists land on user 1, counts preserved, `foreign_key_check` clean.
- `server/test/config-roundtrip.test.js` — export → wipe → import reproduces state; a pre-version backup imports onto user 1.

### ✅ Checkpoint
Server boots on a real existing DB; `/api/home`, `/api/stats`, `/api/progress`, `/api/reading-lists`, config export/import all behave identically to pre-phase (the single-user parity snapshot matches). **Revert:** drop the branch; migration is non-destructive but forward-only, so test on a DB copy first.

---

## Phase 2 — Auth backend (no client yet) · **L**

Goal: real accounts, sessions, lockout, and discovery — exercised via curl/tests.

### New modules
- [server/src/auth/loginLockout.js](../server/src/auth/loginLockout.js) — clone [pinLockout.js](../server/src/auth/pinLockout.js); key `client:<paired_client_id>` or `ip:<addr>`; setting `login_max_attempts` (default 5); 24 h; `status/recordFailure/clear` over `login_lockouts`.
- [server/src/auth/userSession.js](../server/src/auth/userSession.js) — DB-backed (`user_sessions`): `create(userId, pairedClientId, req) → token` (stores `hashToken`), `validate(token) → {userId,…}|null` (sliding 30-day TTL, refresh `last_seen_*`), `revoke(token)`, `revokeAllForUser(userId)`, periodic sweep. Reuse [crypto.js](../server/src/auth/crypto.js) `generateToken`/`hashToken`/`hashPassword`/`verifyPassword`.
- [server/src/routes/users.js](../server/src/routes/users.js) — `POST /users/register` (network-gated + `allow_registration`; first account adopts user 1; `seedDefaultLists`), `POST /users/login` (lockout-guarded; generic error; `connectionLog.recordEvent`), `POST /users/logout` (requireUser), `GET /users/me` (requireUser), `GET /users/exists` (rate-limited, boolean).

### Wire-up
- Mount in [index.js](../server/src/index.js): `app.use('/api', requireClientOrAdmin, usersRoutes)` (network gate, but no `requireUser` — login can't require a user). `logout`/`me` apply `requireUser` per-route.
- Upgrade `userAuth.js`: `resolveUser` does the real `X-User-Token` → `userSession.validate` lookup; when `multi_user_enabled=0` **or** no users beyond default exist, fall back to `DEFAULT_USER` (keeps dev usable pre-client). `requireUser` 401s only when the flag is enforced and `req.user` is null.
- Extend `GET /api/admin/auth-status` ([adminAuth.js:44](../server/src/routes/adminAuth.js#L44)) with `multi_user_enabled`, `user_required`, `logged_in_user`, `allow_registration` (resolve the user inline since this route is in the public tier above `resolveUser`).
- Register new event types in `SUCCESS_EVENTS`/`FAILURE_EVENTS` ([adminAuth.js:353](../server/src/routes/adminAuth.js#L353)).

### Tests
- `server/test/userAuth.test.js` — register/login/logout/me happy paths; duplicate username; generic login error.
- `server/test/loginLockout.test.js` — 5 fails → 429; per-device keying; clear on success.
- `server/test/isolation.test.js` — two users; A's progress/lists/history/stats/home invisible to B (drives Phase 1 scoping too).

### ✅ Checkpoint
Full auth flow works via curl; isolation tests green. Flag still off in default builds → UI unaffected. **Revert:** unmount `usersRoutes` + revert `userAuth.js` to the stub.

---

## Phase 3 — AniList per-user · **M**

Goal: each account links its own AniList; the legacy link keeps working.

- Refactor session helpers in [settings.js](../server/src/routes/settings.js) from device-keyed (`getDeviceSession`/`setDeviceSession`, [:28](../server/src/routes/settings.js#L28)) to user-keyed over `user_anilist_sessions` (`getUserAniList`/`setUserAniList`/`deleteUserAniList`).
- `POST /api/auth/anilist/exchange` ([settings.js:111](../server/src/routes/settings.js#L111)): drop `X-Device-ID`; use `req.user.id`; decode JWT `exp` → `token_expires_at`. `GET /api/settings` + `DELETE /api/auth/anilist` become user-scoped. Client credentials stay global.
- `syncToAniList` ([progress.js:164](../server/src/routes/progress.js#L164)): signature `(db, mangaId, completed, userId)`; look up the owning user's token; skip if unlinked. Update both call sites in progress.js to pass `req.user.id`.
- `/api/manga/:id/anilist-status` + apply-list-entry ([metadata.js:487](../server/src/routes/metadata.js#L487), [:1873](../server/src/routes/metadata.js#L1873)): use `req.user.id`; the `(user_id, media_id)` cache is already rebuilt (Phase 1).
- **Do not touch** the global rate limiter in [metadata/anilist.js](../server/src/metadata/anilist.js) — it must stay one process-wide instance ([compat § AniList](./user-accounts-compat.md#anilist)). Metadata enrichment (`getToken` → global setting) is unchanged.

### Tests
- `server/test/anilist-peruser.test.js` — A and B link different accounts (mock `getViewer`/`saveMediaListEntry`); A's completion hits A's token only; unlinked account no-ops; backfilled legacy link works as user 1.

### ✅ Checkpoint
Two mock AniList accounts sync independently; one shared rate limiter. **Revert:** restore device-keyed helpers (schema is additive, so safe).

---

## Phase 4 — Client: login, context, gate · **L**

Goal: the actual login interface across PWA / APK / AppImage (one React build).

- [client/src/api/client.js](../client/src/api/client.js): store `momotaro_user_token`; attach `X-User-Token` alongside the client token ([:176](../client/src/api/client.js#L176)); add `getUserToken/setUserToken/clearUserToken`, `register/login/logout/getMe`; extend `getAuthStatus` parsing.
- new [client/src/context/UserContext.jsx](../client/src/context/UserContext.jsx) — holds token + `me`; `login/register/logout`.
- [client/src/pages/Login.jsx](../client/src/pages/Login.jsx) + `Login.css` — "Log in" / "Create account" tabs, lockout countdown + `attempts_remaining`; styled like [Pairing.jsx](../client/src/pages/Pairing.jsx).
- [client/src/App.jsx](../client/src/App.jsx): wrap in `UserProvider`; `FirstLaunchGate` adds `user_required → /login` after the `pairing_required` check ([:112](../client/src/App.jsx#L112)); native-shell branch ([:99](../client/src/App.jsx#L99)) routes paired-but-not-logged-in shells to `/login`; exempt `/login`.
- [client/src/utils/readingProgress.js](../client/src/utils/readingProgress.js): namespace `momotaro_resume_<userId>_<id>`; one-time migrate un-namespaced keys.
- [AnilistCallback.jsx](../client/src/pages/AnilistCallback.jsx): verify it works now that the token is auto-attached (no code change expected).

### ✅ Checkpoint
On all three shells: pair → login/create → personalized Home; logout → `/login`; returning device skips prompts. **Revert:** the client reads the same APIs; reverting the gate restores open access (server still enforces).

---

## Phase 5 — Admin user management + on-by-default · **M**

Goal: total admin power; flip the default ON.

- [adminAuth.js](../server/src/routes/adminAuth.js): add `GET/POST /admin/users`, `PATCH/DELETE /admin/users/:id`, `POST /admin/users/:id/revoke-sessions`, `GET /admin/users/:id/history`, `GET /admin/users/:id/export` (account + devices + progress + lists + history; AniList token redacted; reuse CSV helpers at [:575](../server/src/routes/adminAuth.js#L575)), `GET /admin/reading-history` (all users), `DELETE /admin/login-lockouts/:key`.
- [Settings.jsx](../client/src/pages/Settings.jsx): **Account** panel (current user, logout, per-user AniList login, own history); admin **User Management** sub-panel under Client Management (roster, export, delete, force-logout, all-users history); optional admin "all users" stats toggle ([compat §3.3](./user-accounts-compat.md#33-home--stats--discover--genre-ribbons)).
- Flip `multi_user_enabled` code default to **ON**; remove the dev stub fallback in `resolveUser`; new installs require login, upgrades hit the adoption flow.

### Tests
- `server/test/admin-users.test.js` — export bundles a user's data; delete cascades progress/lists/history/sessions; force-logout invalidates sessions; all-users history joins usernames.

### ✅ Checkpoint
Admin can view/export/delete any account; fresh install requires login; upgrade adopts legacy data. **Revert:** set `multi_user_enabled=0` to restore single-user behavior.

---

## Phase 6 — Offline (APK + AppImage) · **M**

Goal: offline read + buffered progress attributed to the right account.

- [offlineDb.js](../client/src/api/offlineDb.js): add `user_id` to `progress_outbox` rows; namespace per-user IDB stores for buffered progress.
- [offlineApi.js](../client/src/api/offlineApi.js): `enqueueProgressWrite` ([:543](../client/src/api/offlineApi.js#L543)) stamps the active `user_id`.
- [outboxSync.js](../client/src/api/outboxSync.js): replay each row with its user's `X-User-Token`; pre-upgrade orphan rows → current user on first flush.
- [App.jsx](../client/src/App.jsx) offline branch ([:107](../client/src/App.jsx#L107)): also require a stored user token.
- Downloaded content stays device-level — no change to the download store.

### ✅ Checkpoint
On a real APK + AppImage: download → airplane mode → read → reconnect → progress lands on the correct account; second user on the same device sees only their own progress. **Revert:** outbox changes are additive; old replay path still works for the active user.

---

## Phase 7 — Hardening & docs · **S**

- Run all three acceptance suites ([compat §6](./user-accounts-compat.md#6-acceptance-test-plan-works-as-before)): single-user parity, multi-user isolation, upgrade.
- Update [overview.md](./overview.md), [api.md](./api.md) (new endpoints + the `X-User-Token` header + the new 401s), [anilist.md](./anilist.md) (replace the "proposed" banner with the shipped per-user model), [frontend.md](./frontend.md) (Login page + UserContext), [database.md](./database.md) (new/changed tables).
- Drop the legacy `device_anilist_sessions` table (one release after Phase 3).

---

## File change summary

**New (server):** `middleware/userAuth.js`, `auth/userSession.js`, `auth/loginLockout.js`, `routes/users.js`, `test/{migration,config-roundtrip,userAuth,loginLockout,isolation,anilist-peruser,admin-users}.test.js`.
**Modified (server):** `db/database.js`, `index.js`, `routes/{progress,library,settings,metadata,adminAuth,config}.js`.
**New (client):** `pages/Login.jsx` + `Login.css`, `context/UserContext.jsx`.
**Modified (client):** `App.jsx`, `api/client.js`, `pages/{Settings,AnilistCallback}.jsx`, `utils/readingProgress.js`, `api/{offlineDb,offlineApi,outboxSync}.js`.

## Dependency order (why this sequence)

```
P1 schema+scoping ─┬─> P2 auth ──┬─> P4 client ──> P6 offline
                   │             └─> P5 admin + flip-on
                   └─> P3 anilist (needs users table from P1; independent of client)
P7 hardening depends on all.
```

P1 must land first and atomically (the `reading_lists` constraint + config import +
default seeding break together). P3 needs only the P1 tables, so it can proceed in
parallel with P2/P4. The flag flips ON in P5, once login (P4) exists.

## Risk register

| Risk | Phase | Guard |
|---|---|---|
| `reading_lists` constraint change breaks config import | P1 | Land the `ON CONFLICT(user_id,name)` + seeding fixes in the same PR; `config-roundtrip.test.js` |
| Cross-user cache leak (`_homeCache`/`_statsCache`) | P1 | `user_id` in cache keys; isolation test alternates two users |
| FK violation during table rebuild | P1 | `foreign_keys=OFF` around rebuild + `foreign_key_check` after |
| Dev lockout while client is unbuilt | P2–P4 | `resolveUser` default-user fallback until P5 flips the flag |
| AniList 429 storm from many accounts | P3 | Keep the limiter a single global instance |
| Upgrade loses the existing AniList link | P3 | Backfill most-recent device session → user 1; `anilist-peruser.test.js` |
| Offline reads mis-attributed after upgrade | P6 | Orphan outbox rows → current user on first flush |

## Definition of done

- All three acceptance suites pass; single-user parity matches the pre-feature snapshot.
- Fresh install: pair → create account → personalized Home on PWA, APK, AppImage.
- Upgrade: legacy reading data + AniList link adopted by the first account; old config backups import.
- Admin can export and delete any account; login lockout works per-device; login events appear in the Connection Log.
- Offline read + sync verified on APK and AppImage; downloaded content shared device-level, progress per-user.
- Docs updated (Phase 7).
