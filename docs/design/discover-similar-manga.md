# Discover Similar Manga — Implementation Plan

Adds a **Discover Similar Manga** section to the manga-detail page, rendered
directly under the existing **Art Gallery** section. It surfaces other manga
that share **≥ 75 % of the current manga's tags** and whose average rating
clears the user's **Discover quality threshold** setting.

Companion to the existing Home-page design docs
([art-gallery-ordering.md](art-gallery-ordering.md),
[homepage-settings-expansion.md](homepage-settings-expansion.md)); this reuses
the same primitives (`manga_genres`, the `home_discover_min_score` pref, the
`Ribbon` component).

---

## Key decisions (resolved up front)

| Question | Decision | Rationale |
|---|---|---|
| What is a "tag"? | Momotaro has **no separate tag concept** — tags = the `genres` field, normalised into `manga_genres(manga_id, genre)`. | See [database.md § manga_genres](../database.md#manga_genres--normalised-genre-pairs). Reuse the indexed table; no schema change. |
| Overlap direction | **`shared / N ≥ 0.75`** — a candidate `M` must contain at least 75 % of the *current* manga `C`'s `N` tags (`shared` = tags in common). Extra tags on `M` don't disqualify it. | User-selected direction; 75 % threshold. Most intuitive "more like this"; robust to broadly-tagged candidates. The rule binds for **every** tag count (see SQL below) — it is never capped by a flat floor. |
| "Average rating" source | `manga.score` (REAL, 0–10, "average score from metadata source"). | Already the field the app treats as the average rating everywhere else. |
| "Discover quality threshold" | The existing per-user pref **`home_discover_min_score`** (default `0`, range 0–10), defined in [HomepageSection.jsx:96](../../client/src/pages/settings/HomepageSection.jsx#L96) / labelled at [:280](../../client/src/pages/settings/HomepageSection.jsx#L280). | Requirement names this exact setting. Single source of truth — changing it moves both Home Discover and this section together (intended). |
| Where to compute | **Server-side, new endpoint** `GET /api/manga/:id/similar`. | Tag-overlap + score filter belong in SQL against `manga_genres`; sending the whole library to the client to filter would be far worse. Mirrors the Discover query in [library.js:1557-1618](../../server/src/routes/library.js#L1557-L1618). |
| Threshold plumbing | Client reads `home_discover_min_score` from `PreferencesContext` and **forwards it as a `?min_score=` query param**; the server does **not** read prefs directly. | Matches the established `/api/home` contract — server stays stateless w.r.t. prefs, so the response cache key is derivable purely from the query string ([api.md § User Preferences](../api.md#user-preferences)). |

---

## Design

### New endpoint — `GET /api/manga/:id/similar`

Query params:

| Param | Meaning | Clamp |
|---|---|---|
| `min_score` | Average-rating floor forwarded from `home_discover_min_score` | `clampScore(x, 0)` → `[0,10]`, reuse the existing helper used at [library.js:1404](../../server/src/routes/library.js#L1404) |
| `limit` | Max results | `[1, 30]`, default `20` |

Response (slim rows, same shape family as Discover — no heavy fields):

```json
{
  "data": [
    { "id": 42, "title": "…", "cover_url": "/thumbnails/…?v=…", "score": 8.4 }
  ]
}
```

The shared-tag count is computed server-side for the `HAVING` / `ORDER BY` but
not returned — the UI renders cover + title + score only.

### The overlap SQL

Compute the current manga's tag count `N` and the integer required-match count
**server-side** (never trust a client-supplied count):

```js
const currentTags = db.prepare(
  'SELECT genre FROM manga_genres WHERE manga_id = ?'
).all(id).map(r => r.genre);
const N = currentTags.length;
if (N === 0) return res.json({ data: [] });          // 0-tag manga → no basis

// Required shared-tag count = ceil(0.75 * N), in integer arithmetic so no
// IEEE-754 rounding creeps in: floor((3N+3)/4) == ceil(3N/4) == ceil(0.75N).
// This SINGLE rule binds for every tag count — never capped by a flat floor —
// so the "75 % of C's tags" promise holds whether a manga has 4 tags or 20
// (5 tags → 4 shared, 20 tags → 15). A 4-tag manga needs 3 (3/4 = 75 %), so
// sparse titles still match without a separate floor. Manga with 1–3 tags
// require all of them (2/3 = 67 % < 75 %) — the intended strictness at that size.
const required = Math.floor((3 * N + 3) / 4);
```

Then one grouped query, modelled on the Discover block:

```sql
SELECT m.id, m.title, m.cover_image, m.cover_updated_at, m.score,
       COUNT(DISTINCT g.genre COLLATE NOCASE) AS shared
FROM   manga m
JOIN   manga_genres g ON g.manga_id = m.id
LEFT JOIN libraries l ON l.id = m.library_id
WHERE  m.id != ?                                     -- exclude self
  AND (m.library_id IS NULL OR l.show_in_all = 1)    -- visibility scope
  AND g.genre IN (<N placeholders>) COLLATE NOCASE   -- only C's tags count
  AND m.score >= ?                                   -- quality threshold
GROUP BY m.id
HAVING shared >= ?                                   -- required (ceil 0.75N)
ORDER BY shared DESC, m.score DESC NULLS LAST, m.id ASC
LIMIT ?
```

Params bound in order: `id`, `...currentTags`, `min_score`, `required`, `limit`.

Why this shape:
- Restricting the join to `g.genre IN (C's tags)` means `COUNT(DISTINCT g.genre)`
  counts **only shared tags**, so `HAVING shared >= required` is exactly the
  75 %-of-C rule. Extra candidate tags are simply not joined, so they don't
  affect the count — matching decision A.
- `m.score >= ?` with a NULL score evaluates to NULL (falsey), so **unrated
  manga are excluded automatically** — they have no average rating and thus
  can't clear the threshold.
- `COLLATE NOCASE`, `NULLS LAST`, and the `show_in_all` gate all mirror the
  existing Discover / genre-ribbon queries for behavioural consistency.
- Uses `idx_manga_genres_genre` for the `genre IN (…)` lookups.

### `>= ` vs `> ` (a wording inconsistency to resolve)

The requirement says ratings "**higher than** the threshold" (`>`), but the
existing Discover query uses `m.score >= ?` and the setting's own hint calls it
a "minimum score … to be eligible." **Recommendation: use `>=`** so the *same
setting* behaves identically in both places (least surprising). Flagged here so
the choice is deliberate rather than accidental — swap to `>` if strict
"higher than" is required.

---

## Client integration

### Where it renders

Insert a new `<section>` immediately **after** the Art Gallery section in
[MangaDetail.jsx:3150](../../client/src/pages/MangaDetail.jsx#L3150) (the
`<div className="gallery-section" ref={gallerySectionRef}>` block), before the
component's closing markup.

### Data flow

1. Read the pref: `const [minScore] = useUserPref('home_discover_min_score', 0)`.
   `MangaDetail` renders inside `<PreferencesProvider>` (wrapped in App.jsx), so
   the hook is available — **verify the provider wraps the `/manga/:id` route**
   before wiring (one grep of App.jsx).
2. The manga's genres are already in state — `const genres = Array.isArray(manga.genres) ? manga.genres : []`
   at [MangaDetail.jsx:2543](../../client/src/pages/MangaDetail.jsx#L2543). Use
   `genres.length` to decide whether to attempt the fetch at all (skip when 0).
3. New API method in [client.js](../../client/src/api/client.js):
   ```js
   getSimilar: (id, { minScore } = {}) => {
     const qs = new URLSearchParams();
     if (minScore) qs.set('min_score', String(minScore));
     const suffix = qs.toString() ? `?${qs}` : '';
     return req(`/api/manga/${id}/similar${suffix}`).then(r => r.data);
   },
   ```
4. Fetch lazily (see Performance below), keyed on `[id, minScore]`. Store
   `similar` / `similarLoading` state alongside the existing `gallery` state
   ([MangaDetail.jsx:1896-1897](../../client/src/pages/MangaDetail.jsx#L1896-L1897)).

### Rendering

Reuse the existing [`Ribbon`](../../client/src/components/Ribbon.jsx) component
(caller supplies tiles) with the **same tile markup Home uses for
`discover_candidates`** ([Home.jsx](../../client/src/pages/Home.jsx#L816)):

```jsx
<Ribbon title="Discover Similar Manga">
  {similar.map(m => (
    <Link key={m.id} to={`/manga/${m.id}`} className="…same tile classes…" role="listitem">
      <img src={m.cover_url} alt={m.title} loading="lazy" />
      <span>{m.title}</span>
      {m.score != null && <span className="score-badge">★ {m.score.toFixed(1)}</span>}
    </Link>
  ))}
</Ribbon>
```

`Ribbon` already returns `null` when it has no children and no `emptyMessage`
([Ribbon.jsx:56](../../client/src/components/Ribbon.jsx#L56)) — so **an empty
result hides the section entirely**, no extra guard needed. That's the desired
"no clutter when there's nothing to show" behaviour.

### Daily rotation (new-titles-every-day)

The filters (tag-match + rating) stay **entirely server-side and fixed** — only
the *presentation order and visible slice* rotate. Mirrors Home's Discover /
genre-ribbon pattern (server returns a pool, client seed-shuffles):

- **Server** returns a deterministically ordered candidate **pool**
  (`limit` default `60`, ordered by shared-tag count then score), not the final
  visible set.
- **Client** shuffles the pool with `dailyShuffleSeed(mangaId)` and slices to
  `SIMILAR_DISPLAY_COUNT = 18` in a `useMemo` keyed on `[similar, id]`.
  - Seed = `localDayIndex ^ imul(mangaId, 0x9e3779b1)`, where `localDayIndex`
    is `floor(localMidnightMs / 86_400_000)`. It only changes at **local
    midnight**, so the order is stable for the whole day (refreshes and
    re-renders don't reshuffle) and rotates the next day.
  - XOR'ing in the manga id gives each manga page its own daily order rather
    than every page rotating in lockstep.
- A pool (60) larger than the window (18) is what makes *new* titles surface as
  the days advance — without it a daily shuffle would only reorder the same
  tiles. Only the 18 rendered tiles fetch covers.
- **Why not `ORDER BY RANDOM()`:** it would defeat the 60 s server cache and
  can't be made stable-per-day; the deterministic pool + client seed-shuffle
  keeps the server response cacheable (same rationale as
  [art-gallery-ordering.md](art-gallery-ordering.md)).
- **Edge:** leaving the tab open across local midnight won't reshuffle until
  the next render/visit (seed is read at render time, deps are `[similar, id]`).
  Acceptable — the "come back tomorrow" flow remounts the page and re-reads the
  seed. Same trade-off Home accepts.

---

## Performance ramifications & mitigations

| Concern | Impact | Mitigation |
|---|---|---|
| **Tag fan-out** — a manga tagged with a popular genre (e.g. "Action") makes `g.genre IN (…)` match thousands of rows before `GROUP BY`/`HAVING` prune them. | The dominant cost. Grows with library size × tag popularity. | (a) The `min_score` filter cuts the candidate set. (b) `LIMIT 60` (the pool cap). (c) `GROUP BY` temp b-tree lives in RAM (`temp_store = MEMORY`, [database.md](../database.md#connection-settings)). (d) See caching below. (e) Only the 18 rendered tiles fetch covers. |
| **Per-request recompute** on every detail-page open | One extra query per page view. | **In-process LRU cache**, mirroring `_homeCache` / the listing cache. Key = `${mangaId}|${minScore}`; TTL 60 s; small cap (e.g. 100) with oldest-eviction. Since `min_score` is in the key, a pref change transparently misses the old slot — no stale results. Optionally clear on scan completion like the other caches. |
| **Added latency to the detail page** | Slower first paint if fetched eagerly with the main manga call. | **Implemented:** fetch only **after** the manga row resolves (needs genre count + threshold), only when `genres.length > 0`, **and** only once an always-rendered zero-height sentinel near the section enters the viewport (`IntersectionObserver`, `rootMargin: 600px`). The section sits below Art Gallery, so on most opens the query never fires. The gate resets on `:id` change (the route component is reused across manga). |
| **Payload size** | — | Return slim rows only (`id, title, cover_url, score`), exactly like Discover — not full manga rows. |
| **Cover requests** | A ribbon of 20 covers = 20 thumbnail GETs. | `loading="lazy"` on tiles (already the tile convention); `/thumbnails` is served `immutable` so repeat visits are free. |
| **Offline / PWA** | Endpoint needs the server. | Skip the fetch when `useConnectivity().online` is false; the section just doesn't render. No error surfaced. |

---

## Potential bugs & logic inconsistencies (with mitigations)

1. **Floating-point `ceil` bug** — `Math.ceil(0.75 * N)` can misfire on the same
   IEEE-754 rounding class as `0.8` did. → Use integer `Math.floor((3*N + 3) / 4)`
   (`== ceil(0.75N)`). Called out in the SQL section.

2. **Small tag counts require 100 %.** The percentage floors up, so a manga with
   1–3 tags needs *all* of them to match (2/3 = 67 % < 75 %). At **75 %** a 4-tag
   manga only needs 3 (3/4 = 75 %), so the previously-problematic 4-tag case is
   handled by the percentage itself — **no flat floor is used**. This was a
   deliberate change from an earlier `min(ceil(0.8N), 3)` design, whose floor of
   3 *subsumed* the percentage for every manga with ≥ 3 tags (a 10-tag title
   matched on just 3 shared tags = 30 %). The pure 75 % rule instead **binds for
   every tag count** (5 tags → 4 shared, 10 → 8, 20 → 15), so "75 % of the tags"
   means what it says. **Residual trade-off:** sparsely-tagged manga (1–3 tags)
   are strict (100 %); if that feels too tight, relax *only* those small-N cases
   with an explicit floor, or expose the percentage as a setting — but do **not**
   reintroduce an ungated floor, which would flatten the percentage again.

3. **Zero-tag manga** → `N = 0` → division basis undefined and `required = 0`
   would match every manga. → Early-return `{ data: [] }` when `N === 0`.

4. **Self-match** — the current manga trivially shares 100 % of its own tags.
   → `WHERE m.id != ?`.

5. **`>` vs `>=` on the threshold** — literal wording ("higher than") vs the
   existing Discover behaviour (`>=`). → Resolved above (recommend `>=`);
   documented so it isn't an accidental divergence.

6. **Hidden-library leakage** — without the `show_in_all` gate, similar manga
   from libraries excluded from "All Libraries" would surface here.
   → `(m.library_id IS NULL OR l.show_in_all = 1)`, matching every other Home
   query.

7. **Stale cache after a metadata edit** — editing a manga's genres/score
   (`PATCH /api/manga/:id`) changes both the current manga's tag set and
   candidates'. A cached similar-list could lag. → 60 s TTL bounds staleness to
   the same contract as `/api/home` and the listing cache; acceptable and
   documented. Optionally invalidate the current manga's slot on its own PATCH.

8. **NULL / unrated candidates** — must not appear when a threshold is set (and
   arguably never, since they have no average rating). → `m.score >= ?` drops
   NULLs automatically even at threshold 0 (`NULL >= 0` is NULL). If threshold
   is 0 you may still want to *include* unrated manga — decide explicitly;
   default here **excludes** them, matching "higher than the threshold rating."

9. **Case / duplicate tags** — `manga_genres.genre` is `COLLATE NOCASE` with a
   `(manga_id, genre)` PK, so "Action"/"action" can't double-count and
   `COUNT(DISTINCT …)` is honest. No extra handling needed.

10. **Cross-device pref drift** — `home_discover_min_score` is server-synced;
    the client forwards whatever the context currently holds. No server-side
    pref read means no risk of the endpoint and Home disagreeing on the value
    within a session.

---

## Implementation steps

### Server

1. **[server/src/routes/library.js](../../server/src/routes/library.js)** — add
   `GET /api/manga/:id/similar` near the other `/api/manga/:id/*` reads.
   - Reuse `clampScore`, `clampLimit`, `thumbnailUrl`, the `show_in_all` gate,
     and the `_homeCache`-style LRU pattern already in this file.
   - Compute `N`, early-return on `N === 0`, compute `required` with the
     integer formula, run the query, map to slim rows.
   - Wire the same per-user auth the other manga reads use (the endpoint is
     read-only and not user-scoped in its SQL, but keep the middleware
     consistent with sibling routes).
2. **Cache** — a small module-local `Map` LRU keyed `${id}|${minScore}`,
   60 s TTL. Optionally clear it where the scanner already clears `_homeCache`.

*No DB migration.* `manga_genres` and `idx_manga_genres_genre` already exist.

### Client

3. **[client/src/api/client.js](../../client/src/api/client.js)** — add
   `getSimilar(id, { minScore })`.
4. **[client/src/pages/MangaDetail.jsx](../../client/src/pages/MangaDetail.jsx)**
   - Add `similar` state + `similarVisible` gate + `similarRef` sentinel near
     the gallery state.
   - Read `home_discover_min_score` via `useUserPref`.
   - Fetch on `[id, hasGenres, minScore, online, similarVisible]` — only once
     the manga (hence genres) is loaded, `genres.length > 0`, `online`, and the
     sentinel has entered the viewport. Reset `similarVisible` on `:id` change.
   - Shuffle to `displayedSimilar` via `shuffleWithSeed` from
     [utils/shuffle.js](../../client/src/utils/shuffle.js) (shared with Home).
   - Render the `Ribbon` section (and the always-present sentinel) right after
     `gallery-section`.
5. **CSS** — reuse existing ribbon / tile classes; add at most a small wrapper
   class in [MangaDetail.css](../../client/src/pages/MangaDetail.css) for
   spacing under the gallery. No new component.

### Docs

6. Add the endpoint to [docs/api.md § Manga / Library](../api.md#manga--library)
   and a one-line note under [docs/frontend.md] for the MangaDetail section.

---

## Test plan (manual — no JS test suite for these pages)

| Scenario | Expected |
|---|---|
| Manga with 5 tags (required = `ceil(0.75·5)` = 4); candidate shares 4 (80 %) and clears threshold | Candidate appears (shared count enforced server-side via `HAVING`). |
| Same candidate but sharing only 3/5 (60 %) | Excluded (3 < 4). |
| Candidate shares 4/5 **plus** 3 extra tags | Still appears (extras ignored). |
| Manga with 20 tags (required = 15); candidate shares 15 (75 %) vs one sharing 10 (50 %) | The 15-share appears; the 10-share is excluded — the percentage still binds at high tag counts. |
| Candidate score below threshold | Excluded. |
| Candidate with NULL score | Excluded (even at threshold 0). |
| Current manga has 0 tags | Section hidden; endpoint returns `[]`; no query fan-out. |
| Current manga has 4 tags (required = 3) | Candidates sharing 3 or 4 tags match (3/4 = 75 %); sharing 2 (50 %) is excluded. |
| Current manga has 2 tags (required = 2) | Only candidates sharing both tags match (1/2 = 50 % < 75 %). |
| Current manga is the only match | Self excluded; section hidden if nothing else. |
| Candidate in a `show_in_all = 0` library | Excluded. |
| Change `home_discover_min_score` in Settings → reopen detail | List reflects the new threshold (cache miss on new key). |
| Offline (PWA, server unreachable) | Section silently absent; no error. |
| Popular-genre manga in a large library | Response fast (cache + limit + score filter); no visible jank. |

---

## Out of scope / follow-ups

- Excluding manga the user has already read/completed (Discover does; this
  section deliberately does **not**, so re-reads can surface — revisit if asked).
- A dedicated "See all similar" page.
- A configurable overlap percentage or a minimum-shared-tags floor (see bug #2).
- Weighting by tag rarity (TF-IDF-style) instead of a flat count — would improve
  relevance but needs a rarity table; not requested.
