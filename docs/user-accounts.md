# Design Doc — User Accounts & Login Interface

Status: **Implemented** (Phases 1–7 shipped) · Owner: _TBD_ · Last updated: 2026-05-25

> Multi-user accounts for Momotaro: per-user reading lists, progress, reading
> history, favorite statistics, top genres, and a personalized Home — synced
> across a user's devices, isolated between users, and working in the PWA, the
> Android APK, and the Linux AppImage (offline included). Layered on top of the
> existing device-pairing trust model; it does not replace it.

---

## 1. Summary

Momotaro is single-tenant today. Any caller that clears the network gate (a
paired-client token, a LAN-bypass IP, or the admin token) sees **one shared
pool** of reading state:

- [`progress`](../server/src/db/database.js#L87) is keyed `UNIQUE(manga_id)` — one global row per manga.
- [`reading_lists`](../server/src/db/database.js#L111) is keyed `UNIQUE(name)` — one global set, seeded `Favorites` / `Want to Read`.
- `/api/stats` and `/api/home` derive favorite genres, top genres, top manga, Discover, and the per-genre ribbons from that one `progress` table ([library.js:827](../server/src/routes/library.js#L827), [library.js:1005](../server/src/routes/library.js#L1005)).

This proposal adds a **`users`** entity and a **user-session** layer so every
piece of reading state is owned by an account, synced across that account's
devices, and invisible to other accounts.

The framing that drives every decision below: **device pairing and user
identity are two separate layers and stay separate.**

| Layer | Question | Today | After |
|---|---|---|---|
| **Device trust** | May this device reach the server at all? | PIN pairing → `paired_clients` token; LAN bypass; admin token ([auth.js](../server/src/middleware/auth.js)) | unchanged |
| **User identity** | Who is reading on this device now? | _none — state is global_ | new `users` + user sessions |

A new device passes **two gates in sequence**: pairing (existing wizard) then
login/registration (new). This is exactly why an external visitor must pair
*and* authenticate before account creation is even reachable (§6.4).

---

## 2. Goals / Non-goals

### Goals
1. New device → after pairing, prompt to **log in** or **create an account**.
2. Per-account reading lists, progress, history, favorite statistics, top genres.
3. Same account on multiple devices → **synced** view of all of the above.
4. **Isolation**: account B can never read account A's state.
5. **Personalized Home** per user — Discover New Series and Top-Manga-in-*genre* ribbons computed from that user's own reading.
6. External-IP visitors still pair + authenticate before account creation is possible.
7. **5 wrong passwords → the device is locked out of login for 24 h.**
8. Favorite-genre statistics recalculated per user.
9. On login, the device fingerprint appears in the **Connection Log**.
10. The **server admin has total power over every account** — view, export reading data + account info, reset password, disable, revoke sessions, and **delete accounts**.
11. Works across all three shells — **PWA, Android APK, Linux AppImage** — with **offline reading preserved** on the APK and AppImage.
12. **`multi_user_enabled` defaults to ON** (new and upgraded installs alike); see §13 for the upgrade story.
13. **Per-user AniList** — each account signs in to its own AniList; **multiple AniList accounts coexist** on one server; progress sync and list-entry reads use the reading account's AniList token (§7.7).

### Non-goals (this phase)
- Per-user reader prefs (RTL, page-fit, theme) — stay in `localStorage` per device (§14).
- OAuth / SSO / external identity providers.
- Per-user *library visibility* — everyone sees the same catalogue; only reading **state** is partitioned.
- Replacing the admin-password model with user roles (kept separate — §11).

---

## 3. Background — what exists today

- **Pairing**: [pairing.js](../server/src/routes/pairing.js) — `request` → `submit-pin` → `status`; mints a token, stores `SHA-256(token)` in `paired_clients`. PIN brute-force capped 5/IP → 24 h via [pinLockout.js](../server/src/auth/pinLockout.js).
- **Admin**: [adminAuth.js](../server/src/routes/adminAuth.js) — single `admin_password_hash` in `settings`; in-memory sessions ([adminSession.js](../server/src/auth/adminSession.js)); `X-Admin-Token`.
- **Network gate**: [auth.js](../server/src/middleware/auth.js) `requireClientOrAdmin` — passes on disabled-auth, admin token, LAN bypass, or a valid `paired_clients` token.
- **Connection Log**: `connection_attempts` + [connectionLog.js](../server/src/auth/connectionLog.js); `GET /api/admin/connection-log` + CSV.
- **Client routing**: [App.jsx `FirstLaunchGate`](../client/src/App.jsx#L81) reads `pairing_required` from `/api/admin/auth-status`, redirects to `/pairing`. Native-shell detection via `isNativeShell()` ([App.jsx:74](../client/src/App.jsx#L74)).
- **Client tokens**: stored in `localStorage` (`momotaro_client_token`, `momotaro_admin_token`, `momotaro_device_id`), attached per request in [client.js](../client/src/api/client.js#L167).
- **Offline**: writes buffer in IndexedDB `progress_outbox` via `enqueueProgressWrite` ([offlineApi.js:543](../client/src/api/offlineApi.js#L543)) and replay on reconnect through [outboxSync.js](../client/src/api/outboxSync.js). Outbox rows carry **no user identity today.**

There is **no reading-history table** — only `progress.last_read_at`. We add one (§5.3).

---

## 4. High-level approach

1. `users` + persistent `user_sessions` (token hashes, like `paired_clients`).
2. New identity middleware `resolveUser` / `requireUser` reading `X-User-Token`, running **after** the network gate.
3. Per-user reading state: add `user_id` to `progress` and `reading_lists`; add `reading_history`; scope every stats/home query by `req.user.id`.
4. `multi_user_enabled` setting **defaulting on**, with a default-user migration that makes upgrades render unchanged until accounts diverge (§13).
5. Auth endpoints (register/login/logout/me); scrypt reuse; **device-keyed** login lockout (§6.3).
6. Client (shared across all shells): a `/login` page + `UserContext`; `FirstLaunchGate` redirect on missing session.
7. Admin: full user-management + per-user export + all-users history; login events in the Connection Log.

---

## 5. Data model

Conventions follow [database.js](../server/src/db/database.js): `snake_case`, unix-epoch `INTEGER`
timestamps defaulting to `unixepoch()`, explicit `ON DELETE`, additive
migrations via `addColumnIfMissing` / the table-rebuild pattern.

### 5.1 New tables

```sql
-- Accounts. password_hash reuses crypto.hashPassword (scrypt), "salt:hash".
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT    NOT NULL DEFAULT '',
  password_hash  TEXT    NOT NULL,
  is_admin       INTEGER NOT NULL DEFAULT 0,    -- admin bridge (§11)
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at  INTEGER
);

-- Persistent sessions. Stores SHA-256(token) only, like paired_clients.
-- Persistent (not in-memory like adminSession) so users stay logged in across
-- restarts and the APK/AppImage shells.
CREATE TABLE IF NOT EXISTS user_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        TEXT    NOT NULL UNIQUE,
  paired_client_id  INTEGER REFERENCES paired_clients(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at      INTEGER,
  last_seen_ip      TEXT,
  revoked           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id    ON user_sessions(user_id);

-- Per-device login lockout. Same semantics as pin_lockouts; key is the device
-- (paired_client_id), IP fallback. 5 failures -> locked_until = now + 24h.
CREATE TABLE IF NOT EXISTS login_lockouts (
  lockout_key      TEXT    PRIMARY KEY,   -- "client:<id>" | "ip:<addr>"
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- True reading-history timeline (distinct from "current position" progress).
-- Appended each time a chapter is opened / completed. Powers the per-user
-- history view and the admin audit/export.
CREATE TABLE IF NOT EXISTS reading_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  manga_id    INTEGER NOT NULL REFERENCES manga(id)    ON DELETE CASCADE,
  chapter_id  INTEGER          REFERENCES chapters(id) ON DELETE SET NULL,
  event       TEXT    NOT NULL DEFAULT 'read',          -- 'read' | 'completed'
  read_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_reading_history_user_time ON reading_history(user_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_history_manga     ON reading_history(manga_id);

-- Per-user AniList link. Replaces device_anilist_sessions (keyed by device_id).
-- One AniList account per Momotaro user; many rows = many AniList accounts
-- coexisting on one server. anilist_token is a ~1-year JWT (no usable refresh);
-- token_expires_at is decoded from the JWT `exp` so the UI can prompt re-login.
CREATE TABLE IF NOT EXISTS user_anilist_sessions (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  anilist_token    TEXT    NOT NULL DEFAULT '',
  anilist_user_id  TEXT    NOT NULL DEFAULT '',
  anilist_username TEXT    NOT NULL DEFAULT '',
  anilist_avatar   TEXT    NOT NULL DEFAULT '',
  token_expires_at INTEGER,
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);
```

The per-user AniList list-entry cache `anilist_media_list_cache` is **re-keyed**
from `(device_id, media_id)` to `(user_id, media_id)` — see §7.7 and the
companion [Feature Preservation spec](./user-accounts-compat.md).

### 5.2 Modified tables — per-user reading state

`progress` (`UNIQUE(manga_id)`) and `reading_lists` (`UNIQUE(name)`) carry
constraints SQLite can't `ALTER`. Use the **table-rebuild pattern** already
established by `upgradeToMultiLibrary` ([database.js:640](../server/src/db/database.js#L640)): build
`*_new`, copy rows assigning the migration's default user, drop, rename.

```sql
CREATE TABLE progress_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  manga_id           INTEGER NOT NULL REFERENCES manga(id)  ON DELETE CASCADE,
  current_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  current_page       INTEGER NOT NULL DEFAULT 0,
  completed_chapters TEXT    NOT NULL DEFAULT '[]',
  last_read_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, manga_id)
);  -- copy: SELECT <default_user_id>, manga_id, ... FROM progress;

CREATE TABLE reading_lists_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, name)
);
```

`reading_list_manga` is structurally unchanged (it references `list_id`, now
per-user) and gains isolation for free; rows cascade when a list — hence a user
— is deleted. On **account creation**, seed `Favorites` / `Want to Read` per
user (the pair currently seeded globally at [database.js:169](../server/src/db/database.js#L169)).

### 5.3 Why a separate `reading_history`

`progress` answers "where am I now" and is overwritten on every read.
Requirements #2 and #10 need a chronological log per user that the admin can
audit/export — append-only, semantically distinct. It is written from the same
path that updates progress ([progress.js PUT/PATCH](../server/src/routes/progress.js#L24)).

### 5.4 Connection log

Add a `username` column to `connection_attempts` (via `addColumnIfMissing`) so
login events attribute without a join. New `event_type`s: `user_register`,
`user_login_ok`, `user_login_fail`, `user_login_locked`, `user_logout` — routed
through existing `connectionLog.recordEvent`, surfacing full device fingerprint
(IP, OS, browser, GeoIP, …) in the timeline + CSV with no other schema work.

---

## 6. Authentication & sessions

### 6.1 Tokens and headers

- **Device token** (existing): `Authorization: Bearer` / `X-Client-Token` / `?t=` → `paired_clients`. Unchanged.
- **User token** (new): `X-User-Token` → `user_sessions`. A distinct header so it composes with the device token already in `Authorization`. The `?t=` query fallback is **not** extended to user tokens (only `<img>`/`<video>` need it, and those serve catalogue content, not per-user data).
- Both reuse `crypto.generateToken()` and store only `hashToken(token)` ([crypto.js](../server/src/auth/crypto.js)).
- Session TTL: sliding **30 days** of inactivity (readers stay logged in on phones), refreshed on each authenticated request + a periodic sweep — same shape as `adminSession`, but DB-backed.

### 6.2 Middleware

New `middleware/userAuth.js`:

```
resolveUser(req)            // req.user = {id, username, is_admin} | null from X-User-Token
requireUser(req,res,next)   // 401 when multi_user_enabled and req.user is null
```

Pipeline:

```
enforceLanOnlyMode → requireClientOrAdmin → resolveUser → [route]
                     (network gate)          (identity)
```

`requireClientOrAdmin` is unchanged. `resolveUser` is **independent of how the
network gate was satisfied**, so even a LAN-bypass device must log in for
personalization. A valid admin token resolves to the admin's user identity
(§11) so the operator browses without a second login.

### 6.3 Login lockout (requirement #7)

Generalize `pinLockout` into `auth/loginLockout.js` over `login_lockouts`:

- **Key** `client:<paired_client_id>` when a valid device token is present (the normal post-pairing case), else `ip:<req.ip>`. This makes the cap a real **device** lockout and immune to username-cycling (counter is per device, not per username).
- `status(key)` is checked **before** password verification, so a locked device gets `429` with no scrypt round.
- 5 failures (configurable via a `login_max_attempts` setting, mirroring the PIN cap) → `locked_until = now + 24h`; `clear(key)` on success.
- Admin escape hatch: `DELETE /api/admin/login-lockouts/:key` (mirrors `DELETE /api/admin/pairing-pin-lockouts/:ip`).

### 6.4 Registration policy (requirements #1, #6)

Registration is reachable **only after the network gate** (`requireClientOrAdmin`
runs first), so an unpaired external visitor literally cannot hit
`POST /api/users/register` — they're redirected to `/pairing` and 401'd. That
*is* requirement #6, with no extra route code. A `allow_registration` setting
(default `1`) lets the admin freeze sign-ups; when `0`, only the admin creates
accounts. Username 3–32 of `[a-z0-9_.-]`, unique case-insensitively; password
≥8 (the admin rule).

---

## 7. API surface

### 7.1 User endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/users/register` | network gate + `allow_registration` | Create account, seed lists, return user token. |
| `POST` | `/api/users/login` | network gate | Verify (lockout-guarded), mint session token. |
| `POST` | `/api/users/logout` | user | Revoke current session. |
| `GET`  | `/api/users/me` | user | `{ id, username, display_name }`. |
| `PUT`  | `/api/users/me/password` | user | Body `{ current_password, new_password }`. Verify current, ≥ 8 chars new, **revoke every existing session for this user**, mint a fresh one for the calling device. Returns `{ user_token }` — other devices fail their next request with 401 and drop to `/login`. Mirrors the admin `/admin/password` pattern. |
| `GET`  | `/api/users/exists?username=` | network gate | Optional, rate-limited, boolean-only. |

Login/register → `{ data: { user_token, user } }`. Login failure → generic
`401 "Incorrect username or password"` (no enumeration) + `attempts_remaining`;
locked device → `429` + `seconds_remaining` (same shape as pairing).

### 7.2 Auth-status discovery (extend existing)

Extend `GET /api/admin/auth-status` ([adminAuth.js:44](../server/src/routes/adminAuth.js#L44)):

```jsonc
{
  "multi_user_enabled": true,
  "user_required": true,                       // enabled && no valid X-User-Token
  "logged_in_user": { "id": 3, "username": "kenji" } | null,
  "allow_registration": true
}
```

`FirstLaunchGate` consumes `user_required` exactly as it consumes
`pairing_required` today.

### 7.3 Modified reading endpoints (now user-scoped)

No new paths; each gains `requireUser` + a `req.user.id` filter:

- `GET/PUT/PATCH/DELETE /api/progress/:mangaId` — `WHERE manga_id=?` → `WHERE user_id=? AND manga_id=?`; PUT/PATCH also append a `reading_history` row.
- `/api/reading-lists` (+ `:id`, `:id/manga`, `/api/manga/:id/reading-lists`) — scoped to the user's lists; touching another user's list → `404` (not `403`, to avoid leaking existence).
- `GET /api/stats` — `progress`-derived aggregates filtered by `user_id`; catalogue counts (`total_manga`, `total_genres`) stay global. **Cache key gains `user_id`** (§9).
- `GET /api/home` — `continue_reading`, favorite genres, `discover_candidates`, `favorite_genres_ribbons` filtered by `user_id`. **Cache key gains `user_id`.**

### 7.4 History endpoints (user)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/history` | Caller's history, newest-first, keyset-paginated. |
| `GET` | `/api/history?format=csv` | CSV download of the caller's full history (ignores the JSON branch's `limit` cap so the export is complete). Columns: _Manga, Chapter, Event, Read at (UTC)_. UTF-8 BOM + RFC 4180 line endings. Fetched via the `_userDownload` helper (fetch + blob + synthetic `<a download>`) since `requireUser` reads only the header. |
| `GET` | `/api/reading-lists.csv` | CSV download of every membership across the caller's lists (built-in + custom). Columns: _List, Built-in, Manga, Library, Folder path, Added at (UTC)_. Same fetch + blob flow. The `.csv` suffix keeps the path unambiguous from `/api/reading-lists/:id`. |
| `DELETE` | `/api/history` | Clear the caller's own history. |

### 7.5 Admin endpoints — total power over accounts (requirement #10)

All `requireAdmin`-gated. The admin acts on any account **without that user's
password**.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/users` | Roster: username, created, last login, device/session count, totals. |
| `POST` | `/api/admin/users` | Create an account (used when `allow_registration=0`). |
| `PATCH` | `/api/admin/users/:id` | Rename, **reset password**, disable/enable. |
| `DELETE` | `/api/admin/users/:id` | **Delete account** — cascades progress, lists, history, sessions. |
| `POST` | `/api/admin/users/:id/revoke-sessions` | Force-logout the user on all devices. |
| `GET` | `/api/admin/users/:id/history` | One user's reading history. |
| `GET` | `/api/admin/users/:id/export` | **Export everything about a user** (§7.6). |
| `GET` | `/api/admin/reading-history` | **All users'** history, joined to username, filterable, CSV — the requirement-#10 view. |
| `DELETE` | `/api/admin/login-lockouts/:key` | Clear a device login lockout. |

### 7.6 Per-user export (`GET /api/admin/users/:id/export`)

A single artifact (JSON, with `?format=csv` for the tabular sections) bundling
**account info + reading data**:

- **Account**: username, display name, created/last-login, disabled flag, `is_admin` (never the password hash).
- **Devices/sessions**: each `user_sessions` row's `paired_client_id`, first/last seen IP + time (joined to `paired_clients` for OS/browser/GeoIP).
- **Progress**: every `progress` row (current chapter/page, completed set, timestamps).
- **Reading lists**: each list + its manga (by `manga.path` + chapter `folder_name`, matching the portable keying the existing config export uses).
- **Reading history**: full `reading_history` timeline.

Reuses the CSV helpers in [adminAuth.js:575](../server/src/routes/adminAuth.js#L575) and the path-keyed shape of
the existing config export so artifacts are portable across installs. The export
itself is logged as an `admin_action` connection event.

---

### 7.7 AniList — per-user accounts (multiple logins)

AniList tokens are *already* per-user (each OAuth grant authorizes one AniList
user, returning a ~1-year JWT used as `Authorization: Bearer` against
`https://graphql.anilist.co`). Momotaro just mis-keys them by **device**
(`device_anilist_sessions`, `X-Device-ID`), so a user can't carry their AniList
link across devices and two users on one device clobber each other. We re-key to
the **Momotaro user**.

- **Storage**: `user_anilist_sessions` keyed by `user_id` (§5.1). One AniList account per Momotaro user; the server holds one row per linked user → many AniList accounts coexist.
- **OAuth** (`POST /api/auth/anilist/exchange`, [settings.js:111](../server/src/routes/settings.js#L111)): drop `X-Device-ID`; resolve `req.user.id` (requireUser) and store the token on that user's row. Keep the **authorization-code grant** (Momotaro has a backend + `client_secret`). `anilist_client_id` / `anilist_client_secret` stay **global** in `settings` — they're the server's registered app, not a per-user secret. The browser callback ([AnilistCallback.jsx](../client/src/pages/AnilistCallback.jsx)) is unchanged; the API client just attaches `X-User-Token`.
- **Sync** (`syncToAniList`, [progress.js:164](../server/src/routes/progress.js#L164)): take the **owning `user_id`** (whose progress changed), look up that user's token, skip silently if unlinked. A's reads sync to A's AniList; B's to B's.
- **List-entry reads** (`/api/manga/:id/anilist-status`, apply-list-entry, [metadata.js:487](../server/src/routes/metadata.js#L487)): use `req.user.id`'s token; `anilist_media_list_cache` re-keyed to `(user_id, media_id)`.
- **Rate limit — keep the limiter global.** AniList's 90 req/min is **per IP**, and every account's calls leave the server's one IP. The adaptive limiter in `anilistRequest()` (`recommendedDelayMs`) must remain a **single process-wide instance shared by all users**; sharding it per user would let N accounts each assume a full budget and collectively trip 429s.
- **Catalogue metadata enrichment unchanged.** Search / refresh / fetch-by-ID (`getToken` → global `settings.anilist_token`, [metadata.js:26](../server/src/routes/metadata.js#L26)) read shared catalogue data and work unauthenticated; they need no per-user token.
- **Token lifecycle**: ~1-year JWT, no usable refresh. Decode `exp` into `token_expires_at`; surface "AniList session expired — sign in again" rather than attempting a refresh.

Full preservation/migration detail (including the device→user backfill) lives in
the [Feature Preservation spec](./user-accounts-compat.md#anilist).

## 8. Authentication flow (end to end)

**New external device, fresh install:**

```
1. Boot → FirstLaunchGate → GET /api/admin/auth-status
2. pairing_required=true → /pairing (existing wizard, unchanged)
3. Pair (admin reveals PIN) → device token stored
4. Re-check → pairing_required=false, user_required=true → /login
5. /login: "Log in" or "Create account" → user token stored
6. user_required=false → app renders; Home personalized for that user
```

**Returning device:** both tokens in storage → both gates pass → straight to
Home. **Switch user on a shared device:** Settings → Log out (revokes session,
device stays paired) → `/login`. **5 wrong passwords:** `429` for 24 h on that
device; admin can clear.

---

## 9. Per-user scoping (the isolation guarantee)

Isolation (#4) is enforced at the query layer; `user_id` always comes from the
validated session, never the request body:

- **Continue Reading / progress** ([library.js:969](../server/src/routes/library.js#L969)) → `AND p.user_id = ?`.
- **Favorite genres** ([library.js:1005](../server/src/routes/library.js#L1005)) + the `/api/stats` copy ([library.js:827](../server/src/routes/library.js#L827)) → `AND p.user_id = ?`. This *is* the per-user recalculation (#8): same chapters-read weighting, restricted to the caller's rows.
- **Discover New Series** ([library.js:1029](../server/src/routes/library.js#L1029)) → "unread" becomes `LEFT JOIN progress p ON p.manga_id=m.id AND p.user_id=?`. A Mystery-heavy reader's Discover differs from everyone else's (#5).
- **Top Manga in *genre*** ([library.js:1096](../server/src/routes/library.js#L1096)) → the genre *set* is the user's favorites (already per-user); the candidate manga stay catalogue-wide + score-filtered (#5).

**Cache correctness (must-fix, security-grade):** `_homeCache` is keyed only by
`minScore` ([library.js:910](../server/src/routes/library.js#L910)) and `_statsCache` by `library_id`
([library.js:770](../server/src/routes/library.js#L770)). Once these go per-user, **`user_id` must be added to
both keys**, or one user's Home leaks to another. The `Cache-Control: private`
headers already prevent shared-proxy caching; the in-memory server cache is the
real risk.

---

## 10. Client & platform changes (PWA, Android APK, Linux AppImage)

All three shells run the **same React build** — the PWA directly, the APK via
Capacitor WebView (origin `http://momotaro.app`), and the AppImage via
`@capacitor-community/electron` ([linux.md](./linux.md), [android.md](./android.md)). So the login UI and
session plumbing are written **once** in the shared client and inherited by all
three. No new native plugin is required.

### 10.1 Shared client (benefits every shell)
- **`client/src/pages/Login.jsx` (+ `Login.css`)** — "Log in" / "Create account" tabs, styled like the [Pairing wizard](../client/src/pages/Pairing.jsx); renders `attempts_remaining` and the lockout countdown.
- **`UserContext`** (like [ConnectivityContext](../client/src/context/ConnectivityContext.jsx)) — holds the user token + `me`; exposes `login`, `register`, `logout`.
- **API client** ([client.js](../client/src/api/client.js)) — store `momotaro_user_token`; attach `X-User-Token` on every request next to the existing client token ([client.js:176](../client/src/api/client.js#L176)); add token accessors + endpoint wrappers; extend `getAuthStatus`.
- **`FirstLaunchGate`** ([App.jsx:81](../client/src/App.jsx#L81)) — after the `pairing_required` check, add `user_required` → `/login`; exempt `/login` alongside `/pairing` and the AniList callback.
- **Settings → Account** — current user + Log out + own history; admin-only sub-panel under Client Management for the roster, per-user export, delete, and all-users history, beside the existing Connection Log / Paired Devices tables in [Settings.jsx](../client/src/pages/Settings.jsx).
- **Home** — no structural change; once `X-User-Token` is sent it's personalized server-side. Namespace the Discover shuffle seed in `localStorage` by user id so switching accounts doesn't carry the rotation window.

### 10.2 Native-shell first-launch (APK + AppImage)
The shells have no same-origin server, so they already special-case routing in
`FirstLaunchGate` ([App.jsx:99](../client/src/App.jsx#L99)): a native shell with no saved server URL
and no client token goes to `/pairing`. **Extend that condition** so that a
native shell which *is* paired (has server URL + client token) but has **no user
token** routes to `/login`. The `?t=`/media-URL rewriting and the
download-keepalive service are device-token paths and need no change.

### 10.3 No native code changes required
- **Android** ([android.md](./android.md)): login is web-layer inside the WebView; `AndroidManifest`, `network_security_config`, and the `DownloadKeepAliveService` are untouched.
- **Linux/Electron** ([linux.md](./linux.md)): same React build via the Electron shell; the three in-tree plugins (`offline-folder`, `download-keep-alive`) are unaffected.

---

## 11. Admin model (and the admin↔user bridge)

Keep the admin-password layer as-is and treat "admin" as a capability, not a
role. The admin token already gates Client Management, Port Forwarding, DB ops,
import/export, and the connection log; folding it into `users` is a large, risky
refactor for no gain here. Requirement #10 is satisfied by the admin-gated
routes in §7.5/§7.6.

To avoid two credentials for the operator:
- On first-run admin-password setup, optionally create a matching `users` row with `is_admin = 1`.
- `resolveUser` accepts a valid **admin token** as proof of the admin's identity, so the operator personalizes without a second login.
- All-users history/export/delete are **admin-token gated** via existing `requireAdmin`, independent of whether the admin keeps a personal reading account.

The admin's power is total and password-free: read, **export** (§7.6), reset
password, disable, force-logout, and **delete** any account.

_Alternative considered_: first registered user becomes admin, drop the separate
password. Cleaner long-term identity, but rewrites the mature admin surface and
migration story — deferred (§19).

---

## 12. Connection Log integration (requirement #9)

`routes/users.js` calls `connectionLog.recordEvent('user_login_ok' | …, {
...fingerprint, username, paired_client_id })`, exactly as `adminAuth.js` does
for admin logins — so a login surfaces full device info (IP, OS, browser,
GeoIP, reverse DNS) in the timeline + CSV with only the §5.4 `username` column
added. Register the new event types in the `SUCCESS_EVENTS` / `FAILURE_EVENTS`
classifiers ([adminAuth.js:353](../server/src/routes/adminAuth.js#L353)) so the severity filter and Sources
rollup categorize them. `user_sessions.last_seen_ip` gives the admin a
per-account "where is this active" view.

---

## 13. Migration & backward compatibility (`multi_user_enabled` defaults ON)

The risk is existing installs with populated global `progress` / `reading_lists`.
The default-user pattern lets us **ship the flag on** without disrupting them.

1. **Setting** `multi_user_enabled` defaults to **`1`**. (When explicitly set to `0`, `resolveUser` injects a fixed default user and `requireUser` is a no-op — an escape hatch for a single-user household that never wants a login screen.)
2. **First-boot migration** in `migrate()`:
   - Create `users`; insert a **default user** (`id = 1`, e.g. `default`) with a random unusable password.
   - Rebuild `progress` + `reading_lists` per §5.2, assigning all existing rows to user `1`.
   - `reading_list_manga` preserved as-is; `reading_history` starts empty (optional one-time backfill from `progress.completed_chapters` + `last_read_at`).
3. **Adoption of legacy data**: because the flag is on, an upgraded install will prompt for login on next launch. The **first account created adopts the default user's row** (rename user `1` to the chosen username + set its password) rather than starting empty — so the household's existing library reading survives the upgrade seamlessly. Subsequent accounts start fresh. (The admin can instead claim it during admin-account setup — §11.)
4. **Config export/import**: extend the existing `export-config` / `import-config` to include `users` (no password hashes by default), per-user `progress`, `reading_lists`, `reading_history`, and `user_anilist_sessions` (replacing the old `device_anilist_sessions` block; AniList tokens redacted by default), remapping IDs in the existing single transaction. Pre-feature backups import as "all data belongs to the default user," and the most-recently-updated legacy device AniList session becomes the default user's link.

Document the on-by-default behavior and the legacy-adoption step in
[overview.md](./overview.md).

---

## 14. Offline mode (APK + AppImage) — requirement #11

Offline reading must keep working on the native shells. Today writes buffer in
IndexedDB `progress_outbox` ([offlineApi.js:543](../client/src/api/offlineApi.js#L543)) and replay via
[outboxSync.js](../client/src/api/outboxSync.js), with **no user identity** on the rows — the gap to close.

1. **Attribute offline writes.** Stamp the **active `user_id`** onto each outbox row at `enqueueProgressWrite` time. On reconnect, `flushOutbox` replays each row with that user's `X-User-Token`. Since the server attributes by session token, the token used at flush must match the row's user — so flush the **active user's** rows and retain other users' rows until they next log in.
2. **Namespace per-user device state.** Key the IndexedDB outbox (and any cached per-user progress) by `user_id`, so two users sharing one device don't cross-contaminate buffered progress. **Decided: downloaded content is device-level** — the CBZ pages live once on disk (SAF/offline folder) and are shared by every account on that device, since they're just cached copies of the shared catalogue; only reading *progress/history* is per-user. This avoids duplicating gigabytes per account, and means the offline "downloaded" library list (`offlineApi.getHome` → Recently Added) is identical for all users on a device while each user's progress over those chapters stays separate.
3. **Session must survive offline.** The user token lives in `localStorage` (persisted across restarts), so an already-logged-in user reads offline with no server round-trip — accounts can't be *created* offline, only used.
4. **Gate.** `FirstLaunchGate`'s offline branch ([App.jsx:107](../client/src/App.jsx#L107)) currently allows through when offline + client token exists; **also require a stored user token** before allowing offline use.
5. **Offline Home** ([offlineApi.js:576](../client/src/api/offlineApi.js#L576)) already returns the downloaded set as the "Recently Added" surface and empty personalized ribbons — correct offline (no server to personalize against); no change beyond per-user namespacing of progress.

Net: offline download, read, and progress-buffering keep working on the APK and
AppImage; reconnect syncs each user's offline reads to their own account.

---

## 15. Impact on existing features (regression analysis)

Per-user state changes the meaning of every query that reads `progress` or
`reading_lists`, and turning `multi_user_enabled` **on by default** changes the
first-run experience for installs that never configured auth. Below is every
preexisting feature that touches that surface, what concretely breaks, and the
fix. **HARD BREAK** = fails outright (throws or serves wrong data) if shipped
without the mitigation.

| Feature (file) | What breaks | Severity | Mitigation |
|---|---|---|---|
| **Config export/import** ([config.js](../server/src/routes/config.js)) | Import does `INSERT INTO reading_lists … ON CONFLICT(name)` ([config.js:316](../server/src/routes/config.js#L316)) — the `name` unique index is replaced by `(user_id, name)`, so the conflict target ceases to exist and the import transaction throws. Export reads `progress` / `reading_lists` globally with no user dimension; import wipes lists globally. | **HARD BREAK** | Add a `user`/`username` dimension to the export payload (bump its `version`); retarget the conflict to `(user_id, name)`; route pre-feature backups onto the **default user**; scope the import wipe per-user. See §13.4. |
| **Default reading-list seeding** ([database.js:169](../server/src/db/database.js#L169)) | Global `INSERT OR IGNORE INTO reading_lists (name, is_default)` has no `user_id` once that column is `NOT NULL` → migration/startup fails. | **HARD BREAK** | Seed `Favorites` / `Want to Read` **per user at account creation**; the migration assigns the existing global lists to the default user; remove the global seed. |
| **Server caches** `_homeCache`, `_statsCache` ([library.js:910](../server/src/routes/library.js#L910), [library.js:747](../server/src/routes/library.js#L747)) | Keyed by `minScore` / `library_id` only — one user's personalized Home or stats is served to the next caller. | **HARD BREAK** (cross-user leak) | Add `user_id` to both keys (§9). `_readingListMangaCache` is **safe** (keyed by globally-unique `list_id`; non-owned lists 404 before they can populate it); `_libraryCache` is **safe** (catalogue data, no progress). |
| **`/api/progress`, `/api/reading-lists` gating** ([progress.js](../server/src/routes/progress.js), [library.js:208](../server/src/routes/library.js#L208)) | These run today with only the network gate; adding `requireUser` 401s any caller without `X-User-Token` — including the Reader/MangaDetail until the token is wired, and any external scripts. | **BREAK** (internal, mitigated) | Wire `X-User-Token` through the shared client (§10.1); in default-user mode the implicit user keeps them working; document the new 401 in [api.md](./api.md). |
| **AniList progress sync + login** ([progress.js:164](../server/src/routes/progress.js#L164), [settings.js:111](../server/src/routes/settings.js#L111)) | Keyed by **device** (`X-Device-ID` → `device_anilist_sessions`), so a link can't follow a user across devices and two users on one device clobber each other's AniList session. | **CHANGED → per-user** (now in scope) | Re-keyed to the owning `user_id` via `user_anilist_sessions`; each account links its own AniList, multiple accounts coexist, rate limiter stays global. Migration backfills the legacy device session onto the default user, so the single existing link keeps working. See §7.7 + [compat spec § AniList](./user-accounts-compat.md#anilist). |
| **Settings stats view** ([Settings.jsx](../client/src/pages/Settings.jsx) → `/api/stats`) | Favorite genres / top manga / estimated read-time now reflect only the **viewing account**, not the whole server. An admin who expected server-wide numbers sees just their own. | **BEHAVIOR SHIFT** | Catalogue counts (`total_manga`, `total_genres`) stay global; offer an admin "all users" stats toggle, or document the new per-account meaning. |
| **`auth_enabled = 0` / LAN-bypass installs** ([auth.js](../server/src/middleware/auth.js)) | With multi-user on by default, `user_required` is true even when pairing/auth was never configured, so a previously frictionless open/LAN install now shows a login screen on next launch. | **BEHAVIOR SHIFT** (on-by-default cost) | First-account bootstrap works through the open network gate (no pairing needed when auth is off) and **adopts the default user's data** (§13.3); the `multi_user_enabled = 0` escape hatch restores zero-friction single-user behavior. |
| **Offline outbox upgrade** ([outboxSync.js](../client/src/api/outboxSync.js), [offlineApi.js:543](../client/src/api/offlineApi.js#L543)) | Outbox rows queued **before** the upgrade have no `user_id`; replay now needs a user token. | **UPGRADE DATA RISK** | On the first post-upgrade flush, attribute orphan rows to the logged-in (adopting/default) user; then per-user stamping applies (§14.1). |
| **Client resume position** ([readingProgress.js](../client/src/utils/readingProgress.js)) | `momotaro_resume_<mangaId>` is per-device `localStorage`; two users on one device share the intra-chapter resume page. | **MINOR** | Namespace the key by `user_id`. |
| **Manga deletion cascade** ([library.js](../server/src/routes/library.js)) | `progress` keeps `ON DELETE CASCADE` from `manga`; per-user rows cascade the same way. | **SAFE** | No change — deleting a manga clears all users' progress for it, as before. |
| **Library / Genres / Art Gallery / Recently Added** | Derive from the catalogue, not from `progress`. | **SAFE** | No change. |

The two highest-risk items are the **config export/import** and the **on-by-default
vs. `auth_enabled=0`** interaction: the first throws on a path users actively
rely on for backups, the second changes the very first screen an upgrader sees.
Both are covered in §13; neither should ship before its mitigation.

## 16. Security considerations

- **No enumeration**: login + list-mutation errors are generic; `/users/exists` is rate-limited, boolean-only, disableable.
- **Hashing**: scrypt via `hashPassword`; never store plaintext; sessions store only `hashToken`.
- **Lockout** keyed by device defeats username-cycling; 24 h matches pairing; admin can clear.
- **Isolation is server-enforced** — `user_id` derives from the validated session, so a forged client cannot read another user's rows.
- **Cache keys** (§9) are a security item, not just correctness.
- **Token transport**: `X-User-Token` is a custom header (no cross-origin send without CORS); `?t=` is *not* extended to user tokens; `Referrer-Policy: same-origin` (already set) limits leakage.
- **Admin power is broad by design** (#10): document clearly that the operator can read, export, and delete any account's data so household members understand the trust model.

---

## 17. Phased delivery

1. **Schema & migration** — new tables; rebuild `progress`/`reading_lists`; default user; flag on; legacy-adoption hook. **In lockstep (both HARD BREAK the instant the `reading_lists` constraint changes — §15):** move default-list seeding to per-user, and patch config export/import to the `(user_id, name)` conflict target + per-user payload. No behavior change until login lands.
2. **Server auth** — `loginLockout`, `userAuth` middleware, `routes/users.js`, extend `auth-status`. Unit-test isolation + lockout.
3. **Scope reading routes** — progress/lists/stats/home by `req.user.id`; **fix cache keys**; write `reading_history`.
4. **Client** — `Login.jsx`, `UserContext`, API wiring, `FirstLaunchGate` (incl. native-shell branch), Settings → Account.
5. **AniList re-key** — `user_anilist_sessions`; OAuth exchange + sync + list-entry by `req.user.id`; re-key `anilist_media_list_cache`; backfill legacy device session → default user; keep the rate limiter global (§7.7).
6. **Admin** — roster, per-user export, delete, force-logout, all-users history + CSV, lockout clear, Connection Log events.
7. **Offline** — per-user outbox stamping + namespacing; gate requires user token; verify on APK + AppImage.
8. **Ship on by default** — verify upgrade adoption; export/import coverage; docs.

## 18. Testing

- **Isolation**: A reads Mystery → B's `/home`, `/stats`, `/reading-lists`, `/history`, `/progress` show none of it.
- **Sync**: same token on two clients → a write on one appears on the other after cache TTL.
- **Lockout**: 5 bad passwords → `429` 24 h on that device only; admin clear works.
- **Gate order**: external IP, no device token → `/pairing`, never reaches `/users/register`.
- **Migration**: pre-feature DB → all legacy progress/lists land on the default user; first new account adopts them; renders unchanged.
- **Cache**: alternating requests from two users never serve a cross-user `/home` or `/stats`.
- **Admin**: export bundles a user's account+reading data; delete cascades all of it; force-logout invalidates every session.
- **AniList per-user**: A and B link different AniList accounts; A's completion syncs to A's list only; B's to B's; an unlinked account syncs nothing; concurrent syncs from both share one rate-limit budget without 429 storms; upgrade keeps the single legacy link working under the default user.
- **Platforms/offline**: on APK + AppImage — pair → login → read offline → reconnect → offline reads attributed to the correct account; second user on the same device sees only their own progress.

## 19. Open questions

1. **Guest browsing** — allow a read-only anonymous mode, or hard-require login? (Default: require.)
2. **Reader preferences** — keep per-device in `localStorage`, or move onto the account so they sync?
3. **Admin = user?** — adopt the `is_admin`-on-`users` bridge now (§11), or stay fully separate until a later identity refactor?

_Resolved:_ downloaded content is **device-level** (§14.2) — shared CBZ pages on disk, per-user progress. **AniList is per-user** (§7.7) — each account links its own AniList; multiple accounts coexist.
