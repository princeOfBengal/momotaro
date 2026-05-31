# Homepage Settings Expansion — Implementation Plan

Adds 12 new Homepage Settings (Discover filters, ribbon layout, recently-added
window) and migrates Homepage Settings from per-browser `localStorage` to
**per-user server-synced preferences** so a user logged in on multiple devices
sees the same settings everywhere.

---

## Architectural decisions

### 1. Per-user, server-synced storage (replaces `localStorage`)

Today every Homepage Setting lives in `localStorage` ([Settings.jsx:1143-1321](../../client/src/pages/Settings.jsx#L1143-L1321)).
That worked when settings were single-device; with the new user-accounts
feature, the same account on a phone and a desktop should converge on one
configuration.

**Scope: every setting visible inside the Homepage Settings section syncs**
— the four pre-existing ones *and* the twelve new ones added by this plan.
The inventory of keys is fixed in [§ Settings inventory](#settings-inventory)
below; no Homepage setting may remain `localStorage`-only.

Replacement model:

- New SQLite table `user_preferences (user_id, key, value, updated_at)` —
  key/value blob per user, mirroring the existing `settings` table pattern.
- New endpoints:
  - `GET  /api/user/preferences` — returns all prefs for the current user as
    a flat object.
  - `PUT  /api/user/preferences` — accepts a partial object and merges
    (upserts each key, leaves untouched keys alone).
- A new client `PreferencesContext` provider fetches once on app mount, holds
  the prefs object in memory, and exposes `useUserPref(key, default)` /
  `setUserPref(key, value)`. Writes are optimistic locally + debounced PUT
  (300 ms) to the server.
- **No real-time push.** A second device sees changes on its next page load
  (or on tab focus — we add a cheap `visibilitychange` refetch). Real-time
  WebSocket sync is out of scope; document it as a follow-up.
- **Migration**: on first mount after upgrade, if the server returns an empty
  prefs object but the browser has any legacy `home_*` keys, the client
  uploads them once then deletes the `localStorage` entries. One-shot, gated
  by a `home_prefs_migrated` flag in `localStorage`.

### 2. Settings that affect SQL still travel as query params

`/api/home` continues to accept its filter inputs as query params (matches
the existing `minScore` / `discover_limit` pattern). The client reads them
out of the preferences context and forwards them to the request — the server
does **not** read prefs directly when handling `/api/home`. This keeps the
home endpoint stateless w.r.t. preferences and the `_homeCache` key derivable
purely from query params.

### 3. Pure-client vs server-filter split

| Setting                              | Where it acts        |
|--------------------------------------|----------------------|
| Discover quality threshold           | Server (SQL filter)  |
| Discover excluded genres             | Server (SQL filter)  |
| Discover min matching genres         | Server (SQL filter)  |
| Discover library scope               | Server (SQL filter)  |
| Skip bookmarked titles               | Server (SQL filter)  |
| Discover candidate pool size         | Server (SQL `LIMIT`) |
| Favorite-genre source (auto/manual)  | Server (override)    |
| Number of genre ribbons              | Server (slice)       |
| Recently Added window                | Server (SQL filter)  |
| Discover visible count               | Client (array slice) |
| Ribbon order + visibility            | Client (render)      |
| Resume Hero on/off                   | Client (render)      |

---

## The 12 settings

Discover-targeted:
1. Discover quality threshold (slider 0–10)
2. Excluded genres (chip blacklist)
3. Favorite-genre source — Automatic / Manual (4-genre picker)
4. Minimum matching genres (1–4)
5. Library scope for Discover (per-library checkbox)
6. Skip already-bookmarked titles (toggle)
7. Discover candidate pool size (15/30/60)

Homepage at large:
8. Ribbon visibility & order
9. Resume Hero on/off
10. Recently Added time window (24h / 7d / 30d / All)
11. Number of genre ribbons (1–4)
12. Discover visible count (10/15/20/30)

---

## Settings inventory

The authoritative list of every key the Homepage Settings section reads or
writes. **Every row in the "Syncs" table is server-backed via
`user_preferences` and must be wired through `useUserPref` — no Homepage
setting may remain `localStorage`-only after this work lands.**

### Syncs across devices (server-backed `user_preferences`)

Pre-existing (must be migrated off `localStorage`):

| `user_preferences.key`         | Replaces `localStorage` key      | Default       | Type                  |
|--------------------------------|----------------------------------|---------------|-----------------------|
| `home_default_sort`            | `home_default_sort`              | `"title"`     | string                |
| `home_discover_refresh_ms`     | `home_discover_refresh_ms`       | `86400000`    | number (ms; 0=manual) |
| `home_genre_score_threshold`   | `home_genre_score_threshold`     | `7`           | number 0–10           |
| `home_gallery_order`           | `home_gallery_order`             | `"chronological"` | string            |

Added by this plan:

| `user_preferences.key`            | Default                  | Type                |
|-----------------------------------|--------------------------|---------------------|
| `home_discover_min_score`         | `0`                      | number 0–10         |
| `home_discover_excluded_genres`   | `[]`                     | string[]            |
| `home_favorite_genres_mode`       | `"auto"`                 | `"auto" \| "manual"`|
| `home_favorite_genres_manual`     | `[]`                     | string[] (max 4)    |
| `home_discover_min_match_count`   | `1`                      | number 1–4          |
| `home_discover_library_ids`       | `[]` (empty = all)       | number[]            |
| `home_discover_skip_bookmarked`   | `false`                  | boolean             |
| `home_discover_pool_size`         | `30`                     | number              |
| `home_discover_visible_count`     | `15`                     | number              |
| `home_ribbon_order`               | see Phase 4 Group B      | `{id,visible}[]`    |
| `home_resume_hero_enabled`        | `true`                   | boolean             |
| `home_genre_ribbon_count`         | `4`                      | number 1–4          |
| `home_recent_window_hours`        | `0` (no window)          | number              |

### Stays in `localStorage` (per-device transient state, not a setting)

These are *not* settings — they are rotation state that should differ across
devices on purpose, so syncing them would be wrong:

| `localStorage` key             | Why it stays local                                                              |
|--------------------------------|---------------------------------------------------------------------------------|
| `home_discover_last_refresh`   | Last reshuffle timestamp — per-device, drives the "interval elapsed?" check     |
| `home_discover_seed`           | Per-device shuffle seed; syncing would make every device show the same order    |
| `home_prefs_migrated`          | One-shot flag set by the legacy migration in Phase 3b                           |

A code reviewer can verify completeness by grepping `client/src/pages/Settings.jsx`
for `localStorage` inside `HomepageSection` — after this work, the only
remaining hit should be `home_discover_last_refresh` (cleared on filter
change in Phase 5c).

---

## Summary of file touchpoints

| File                                                                                       | Change                                                                | Approx. lines |
|--------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|--------------:|
| [server/src/db/database.js](../../server/src/db/database.js)                               | New `user_preferences` table in `createUserTables`                    |          ~15  |
| [server/src/routes/userPreferences.js](../../server/src/routes/userPreferences.js)         | **New file** — GET/PUT endpoints                                      |          ~80  |
| [server/src/index.js](../../server/src/index.js) (or wherever routes mount)                | Mount the new router                                                  |           ~2  |
| [server/src/routes/library.js](../../server/src/routes/library.js)                         | New `/api/home` query params + extended Discover query + cache key    |         ~120  |
| [server/src/routes/library.js](../../server/src/routes/library.js)                         | New `GET /api/genres` (if absent)                                     |          ~25  |
| [client/src/context/PreferencesContext.jsx](../../client/src/context/PreferencesContext.jsx) | **New file** — provider, hook, debounced writer, legacy migration   |         ~120  |
| [client/src/App.jsx](../../client/src/App.jsx)                                             | Wrap tree in `<PreferencesProvider>`                                  |           ~3  |
| [client/src/api/client.js](../../client/src/api/client.js)                                 | `api.getUserPreferences`, `api.putUserPreferences`, extend `getHome`, add `getGenres` |    ~40  |
| [client/src/components/RibbonOrderEditor.jsx](../../client/src/components/RibbonOrderEditor.jsx) | **New file** — visibility toggles + ↑/↓ reorder                 |          ~90  |
| [client/src/components/GenreChipPicker.jsx](../../client/src/components/GenreChipPicker.jsx) | **New file** — fetch genres, multi-select chips                     |          ~70  |
| [client/src/pages/Settings.jsx](../../client/src/pages/Settings.jsx)                       | Rewrite `HomepageSection` into three sub-groups; replace `localStorage` with `useUserPref` |  ~250  |
| [client/src/pages/Home.jsx](../../client/src/pages/Home.jsx)                               | Replace `localStorage` reads with `useUserPref`; render ribbons from an order array; honour all new prefs |  ~150  |

Total: ~3 new files, ~1,000 lines added/changed.

---

## Phase 1 — Server: `user_preferences` table + endpoints

### 1a. Schema

In [server/src/db/database.js:255-308](../../server/src/db/database.js#L255-L308), inside `createUserTables`:

```sql
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;
```

`value` is JSON-encoded text so booleans, numbers, and arrays all survive a
round trip. The PK guarantees one row per `(user, key)` and supports cheap
`INSERT ... ON CONFLICT DO UPDATE`.

### 1b. New router — `server/src/routes/userPreferences.js`

```js
// GET /api/user/preferences
//   → { data: { home_discover_excluded_genres: [...], ... } }
// PUT /api/user/preferences
//   body: { home_discover_excluded_genres: [...], ... }
//   → upserts each key; returns the full merged object
```

Reject the request with 401 when `req.user?.id` is missing. Wrap PUT in a
single transaction so partial failures don't leave half-written prefs.

### 1c. Mount the router

Add `app.use('/api/user', require('./routes/userPreferences'))` next to the
other route mounts.

---

## Phase 2 — Server: extend `/api/home` filters

File: [server/src/routes/library.js:1040-1250](../../server/src/routes/library.js#L1040-L1250)

### 2a. Parse new query params

At the top of the handler, alongside the existing `clampLimit` parsing:

```js
const discoverMinScore       = clampScore(req.query.discover_min_score, 0);
const discoverExcludedGenres = parseCsvLower(req.query.discover_excluded_genres);
const discoverMinMatchCount  = clampInt(req.query.discover_min_match_count, 1, 1, 4);
const discoverLibraryIds     = parseCsvInt(req.query.discover_library_ids);
const discoverSkipBookmarked = req.query.discover_skip_bookmarked === '1';
const favoriteGenresOverride = parseCsv(req.query.favorite_genres);
const genreRibbonCount       = clampInt(req.query.genre_ribbon_count, 4, 1, 4);
const recentWindowHours      = clampInt(req.query.recent_window_hours, 0, 0, 24 * 365);
```

### 2b. Extend the Discover query

Existing query at [library.js:1130-1145](../../server/src/routes/library.js#L1130-L1145).
Add:

- `AND m.id NOT IN (SELECT manga_id FROM manga_genres WHERE genre IN (...) COLLATE NOCASE)`
  when `discoverExcludedGenres.length > 0` (exclude the manga, not just the
  genre row — a title tagged Action+Ecchi should be excluded entirely when
  Ecchi is blacklisted, not retained via its Action row).
- `AND m.library_id IN (...)` when `discoverLibraryIds.length > 0`.
- `AND m.score >= ?` when `discoverMinScore > 0`.
- `HAVING COUNT(DISTINCT g.genre COLLATE NOCASE) >= ?` when
  `discoverMinMatchCount > 1`.
- `AND m.id NOT IN (SELECT manga_id FROM reading_list_items WHERE
  list_id IN (SELECT id FROM reading_lists WHERE user_id = ?))`
  when `discoverSkipBookmarked` (verify table names against the actual
  reading-lists schema before writing).

### 2c. Favorite-genre override

At [library.js:1105-1119](../../server/src/routes/library.js#L1105-L1119):

```js
const favoriteGenres = favoriteGenresOverride.length > 0
  ? favoriteGenresOverride.slice(0, 4)
  : favoriteGenreRows.map(r => r.genre);
```

Skip the auto-derivation query entirely when the override is present.

### 2d. Recently Added window

At [library.js:1223-1230](../../server/src/routes/library.js#L1223-L1230):

```sql
AND (? = 0 OR m.created_at >= unixepoch() - ? * 3600)
```

Bind `recentWindowHours` twice; `0` means "no window."

### 2e. Slice genre ribbons

At [library.js:1210-1218](../../server/src/routes/library.js#L1210-L1218):
slice `favoriteGenres.slice(0, genreRibbonCount)` before the `.map()`.

### 2f. Cache key extension

At [library.js:1050](../../server/src/routes/library.js#L1050), replace the
single-line key with a hash of every param that affects the payload:

```js
const cacheKey = `u:${userId}|` + sha1Short(JSON.stringify({
  minScore, discoverMinScore, discoverExcludedGenres, discoverMinMatchCount,
  discoverLibraryIds, discoverSkipBookmarked, favoriteGenresOverride,
  genreRibbonCount, recentWindowHours,
  limContinue, limDiscover, limGallery, limRibbon, limRecent,
}));
```

`sha1Short` = first 12 hex chars of a SHA-1; cheap and collision-safe at
this scale.

### 2g. `GET /api/genres`

Verify whether this already exists (grep `app.get.*genres` and
`router.get.*genres`). If not, add to library.js:

```sql
SELECT DISTINCT g.genre AS genre
FROM   manga_genres g
JOIN   manga m       ON m.id = g.manga_id
LEFT JOIN libraries l ON l.id = m.library_id
WHERE  (m.library_id IS NULL OR l.show_in_all = 1)
ORDER BY g.genre COLLATE NOCASE ASC
```

Cache for 5 minutes in-process.

---

## Phase 3 — Client: PreferencesContext

### 3a. The provider — `client/src/context/PreferencesContext.jsx`

```jsx
const PreferencesContext = createContext(null);

export function PreferencesProvider({ children }) {
  const [prefs, setPrefs] = useState(null);   // null = loading
  const pendingRef = useRef({});               // batched writes
  const timerRef   = useRef(null);

  // Initial load
  useEffect(() => {
    api.getUserPreferences()
      .then(async (server) => {
        const migrated = await maybeMigrateLegacyLocalStorage(server);
        setPrefs(migrated);
      })
      .catch(() => setPrefs({}));  // fall back to defaults on error
  }, []);

  // Refetch when the tab regains focus, so a change on another device
  // shows up without a full reload.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        api.getUserPreferences().then(setPrefs).catch(() => {});
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const setPref = useCallback((key, value) => {
    setPrefs(prev => ({ ...prev, [key]: value }));   // optimistic
    pendingRef.current[key] = value;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 300);
  }, []);

  function flush() {
    const batch = pendingRef.current;
    pendingRef.current = {};
    api.putUserPreferences(batch).catch(() => {
      // On failure, requeue so the next change retries.
      Object.assign(pendingRef.current, batch);
    });
  }

  return (
    <PreferencesContext.Provider value={{ prefs, setPref }}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function useUserPref(key, defaultValue) {
  const { prefs, setPref } = useContext(PreferencesContext);
  const value = prefs?.[key];
  return [
    value === undefined ? defaultValue : value,
    (v) => setPref(key, v),
  ];
}
```

### 3b. One-shot legacy migration

```js
const LEGACY_MAP = {
  home_default_sort:                'home_default_sort',
  home_discover_refresh_ms:         'home_discover_refresh_ms',
  home_gallery_order:               'home_gallery_order',
  home_genre_score_threshold:       'home_genre_score_threshold',
};

async function maybeMigrateLegacyLocalStorage(serverPrefs) {
  if (localStorage.getItem('home_prefs_migrated') === '1') return serverPrefs;
  if (Object.keys(serverPrefs).length > 0) {
    localStorage.setItem('home_prefs_migrated', '1');
    return serverPrefs;
  }
  const carry = {};
  for (const [lsKey, prefKey] of Object.entries(LEGACY_MAP)) {
    const raw = localStorage.getItem(lsKey);
    if (raw != null) carry[prefKey] = coerce(prefKey, raw);
  }
  if (Object.keys(carry).length > 0) {
    await api.putUserPreferences(carry);
    Object.keys(LEGACY_MAP).forEach(k => localStorage.removeItem(k));
  }
  localStorage.setItem('home_prefs_migrated', '1');
  return { ...serverPrefs, ...carry };
}
```

### 3c. Wrap the app

In [client/src/App.jsx](../../client/src/App.jsx), wrap the routed tree in
`<PreferencesProvider>` below the existing user/auth providers.

### 3d. API client

In [client/src/api/client.js](../../client/src/api/client.js):

```js
getUserPreferences: () => req('/api/user/preferences').then(r => r.data),
putUserPreferences: (patch) => req('/api/user/preferences', {
  method: 'PUT', body: JSON.stringify(patch),
}).then(r => r.data),

getGenres: () => req('/api/genres').then(r => r.data),

getHome: ({ minScore, discoverMinScore, discoverExcludedGenres, /* … */ } = {}) => {
  const qs = new URLSearchParams();
  if (minScore != null)                  qs.set('min_score', String(minScore));
  if (discoverMinScore)                  qs.set('discover_min_score', String(discoverMinScore));
  if (discoverExcludedGenres?.length)    qs.set('discover_excluded_genres', discoverExcludedGenres.join(','));
  // …same pattern for every new param
  return req(`/api/home?${qs}`).then(r => r.data);
},
```

---

## Phase 4 — Settings UI

File: [client/src/pages/Settings.jsx:1143-1321](../../client/src/pages/Settings.jsx#L1143-L1321)
Rewrite `HomepageSection`. **Every** `useState(() => localStorage.getItem(...))`
+ `useEffect(localStorage.setItem)` pair in this section must be replaced
with a single `useUserPref(key, default)` — including the four pre-existing
bindings at [Settings.jsx:1144-1166](../../client/src/pages/Settings.jsx#L1144-L1166)
and their corresponding writers at [1167-1185](../../client/src/pages/Settings.jsx#L1167-L1185).
After this rewrite, the only `localStorage` access remaining inside
`HomepageSection` is the `handleResetDiscoverNow` helper at
[1187-1191](../../client/src/pages/Settings.jsx#L1187-L1191), which clears
the transient `home_discover_last_refresh` / `home_discover_seed` rotation
state (correctly local — see [§ Settings inventory](#settings-inventory)).

Structure the page into four sub-groups using the existing `rs-group` /
`rs-group-title` pattern from `ReadingSection` ([Settings.jsx:1414](../../client/src/pages/Settings.jsx#L1414)).
Every pre-existing setting has an explicit new home below, marked **(existing)**.

### Group A — Library default
- Default sort order **(existing)** — `select`, bound to
  `home_default_sort` via `useUserPref`. Move the markup from
  [Settings.jsx:1205-1224](../../client/src/pages/Settings.jsx#L1205-L1224)
  here unchanged apart from the state binding.

### Group B — Discover New Series
- Discover refresh interval **(existing)** — `select`, bound to
  `home_discover_refresh_ms`. Migrate the card at
  [Settings.jsx:1226-1255](../../client/src/pages/Settings.jsx#L1226-L1255).
  The `Reshuffle now` button keeps its `localStorage.removeItem` calls —
  it operates on the per-device rotation state, not the synced setting.
- Discover quality threshold — slider 0–10, bound to
  `home_discover_min_score`. New control modelled on the genre-threshold
  slider markup at [Settings.jsx:1281-1318](../../client/src/pages/Settings.jsx#L1281-L1318).
- Genre ribbon rating threshold **(existing)** — slider, bound to
  `home_genre_score_threshold`. Migrate the card at
  [Settings.jsx:1281-1318](../../client/src/pages/Settings.jsx#L1281-L1318).
- Excluded genres — `<GenreChipPicker mode="exclude">` bound to
  `home_discover_excluded_genres`.
- Favorite-genre source — radio Auto / Manual bound to
  `home_favorite_genres_mode`; when Manual, render
  `<GenreChipPicker mode="select" max={4}>` bound to
  `home_favorite_genres_manual`.
- Minimum matching genres — segmented control 1–4, bound to
  `home_discover_min_match_count`.
- Library scope — fetch `api.getLibraries()`, render a checklist bound to
  `home_discover_library_ids`; empty array means "all visible libraries."
- Skip bookmarked titles — `ToggleRow` bound to `home_discover_skip_bookmarked`.
- Discover candidate pool size — segmented control 15/30/60, bound to
  `home_discover_pool_size`.
- Discover visible count — segmented control 10/15/20/30, bound to
  `home_discover_visible_count`.

### Group C — Layout
- Ribbon visibility & order — `<RibbonOrderEditor>` bound to
  `home_ribbon_order` (default
  `[{id:'continue',visible:true},{id:'recent',visible:true},{id:'discover',visible:true},{id:'gallery',visible:true},{id:'genres',visible:true}]`).
- Resume Hero — `ToggleRow` bound to `home_resume_hero_enabled` (default `true`).
- Number of genre ribbons — segmented control 1–4, bound to
  `home_genre_ribbon_count`.
- Art Gallery order **(existing)** — `select`, bound to
  `home_gallery_order`. Migrate the card at
  [Settings.jsx:1257-1279](../../client/src/pages/Settings.jsx#L1257-L1279).
  Lives in Layout because it controls how an already-visible ribbon
  renders.

### Group D — Recently Added
- Time window — select 24h / 7d / 30d / All time → stores hours
  (`24 / 168 / 720 / 0`), bound to `home_recent_window_hours`.

### Reset to defaults
A small `Reset to defaults` button at the top of the section that PUTs every
key back to its default (or empties them and lets the readers fall through).
Confirm with `window.confirm` first.

### New components

**`GenreChipPicker`** — props `{ value, onChange, mode, max }`. Fetches once
via `api.getGenres()`. Clicking a chip toggles inclusion in `value`. When
`max` is set, selecting beyond the limit unselects the oldest.

**`RibbonOrderEditor`** — renders the ordered list with a visibility toggle
and up/down arrows per row. No drag-and-drop in v1 (keeps the bundle lean);
buttons are accessible by default.

---

## Phase 5 — Home rendering refactor

File: [client/src/pages/Home.jsx](../../client/src/pages/Home.jsx)

### 5a. Read prefs into local state

Replace the four `localStorage` reads ([Home.jsx:325-335](../../client/src/pages/Home.jsx#L325-L335))
with `useUserPref` calls. Default to today's defaults so an unauthenticated
or pre-migration session behaves identically.

### 5b. Forward to `/api/home`

Update the `load` callback ([Home.jsx:376-387](../../client/src/pages/Home.jsx#L376-L387))
to pass every new pref as an option. Add each pref to the `useCallback` deps
array — changing any of them in Settings causes a remount-refetch (same
pattern as today's `genreMinScore`).

### 5c. Reset reshuffle stamp when filters change

When a Discover-affecting pref changes, also clear `home_discover_last_refresh`
in `localStorage` so the next visit reshuffles immediately. (This stays in
`localStorage` — it's per-device transient state, not a preference.)

### 5d. Render ribbons from an order array

Replace the hardcoded ribbon sequence ([Home.jsx:619-707](../../client/src/pages/Home.jsx#L619-L707))
with a `.map()` over `home_ribbon_order`, switching on `id`:

```jsx
{ribbonOrder.filter(r => r.visible).map(r => {
  switch (r.id) {
    case 'continue': return continueRest.length > 0 && <Ribbon key="continue" …>{…}</Ribbon>;
    case 'recent':   return data.recently_added?.length > 0 && <Ribbon key="recent" …>{…}</Ribbon>;
    case 'discover': return <Ribbon key="discover" …>{…}</Ribbon>;
    case 'gallery':  return <Suspense key="gallery" …><ArtGalleryRibbon …/></Suspense>;
    case 'genres':   return genreRibbonsVisible.map(g => <Ribbon key={`g-${g.genre}`} …>{…}</Ribbon>);
    default:         return null;
  }
})}
```

### 5e. Resume Hero toggle

When `home_resume_hero_enabled === false`, skip `<ResumeHero>` and prepend
the would-be hero manga back to `continueRest` so it still appears as a tile.

### 5f. Discover visible count

Replace the constant `DISCOVER_VISIBLE_COUNT` ([Home.jsx:37](../../client/src/pages/Home.jsx#L37))
with the pref value in the `discoverVisible` memo.

---

## Phase 6 — Polish

- **Empty-state copy** for Discover when filters are too aggressive
  ([Home.jsx:664-668](../../client/src/pages/Home.jsx#L664-L668)): detect
  `discover_candidates.length === 0` while `favoriteGenres.length > 0` and
  any Discover filter is non-default, then show "No titles match your
  Discover filters. Try lowering the quality threshold or allowing more
  genres."
- **Saving indicator** — small "Saved" pill briefly visible in the Settings
  header after a successful PUT, so users on slow connections trust the
  sync. Hook into `PreferencesContext` to expose `lastSavedAt`.
- **Conflict resolution** — last-write-wins via the timestamp comparison on
  the server. If Device A and Device B race, B's PUT overwrites A's. Acceptable
  for a Homepage Settings page; document the limitation.
- **Server cache invalidation on PUT** — when prefs that affect `/api/home`
  change, drop the affected user's entries from `_homeCache`. Easiest:
  expose a `_homeCache.deleteForUser(userId)` on the cache module and call
  it from the PUT handler.

---

## Suggested execution order

1. **Phase 1** — DB + endpoints. Ship behind no UI; smoke-test with `curl`.
2. **Phase 3a–3c** — PreferencesContext + provider, with legacy migration.
   At this point existing settings still work, just via the new pipe.
3. **Phase 3d + Phase 4 (Group B Resume Hero only)** — wire a single
   trivial pref through end-to-end to validate the loop on real devices.
4. **Phase 2** — server `/api/home` filter extensions.
5. **Phase 5** — Home rendering refactor (ribbon-order array first,
   default order kept).
6. **Phase 4 (rest)** — flip features on one at a time.
7. **Phase 6** — polish.

`main` is shippable after every step. Steps 1–3 are invisible to users; the
refactor in step 5 is invisible until step 6 exposes the controls.

---

## Out of scope / open questions

- **Real-time cross-device sync** — current design refetches on tab focus.
  WebSocket-based push would close the gap but adds protocol surface; defer
  until a user actually complains.
- **Drag-and-drop reorder** — v1 uses ↑/↓ buttons. `@dnd-kit/sortable` is
  ~30 KB gzipped; revisit if reorder is exercised often.
- **Conflict resolution for concurrent writes** — last-write-wins. Per-key
  timestamp granularity could be added (the table already has `updated_at`)
  but isn't worth the complexity for Homepage Settings.
- **Default-user behaviour** — when no real user is logged in (single-user
  installs), prefs persist under `user_id = 1` (the default data-owner row,
  [database.js:317-326](../../server/src/db/database.js#L317-L326)). Same
  table, no special case.
- **Reading Lists schema** — Phase 2b's "skip bookmarked" filter needs the
  actual reading-list table/column names verified before the query is
  written. Add a grep step before Phase 2 begins.
