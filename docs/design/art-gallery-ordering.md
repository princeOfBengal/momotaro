# Art Gallery Ribbon Ordering

## Problem

The Art Gallery ribbon on the Home page currently shows saved pages in a single
fixed order: newest-first, sorted server-side by `art_gallery.created_at DESC`
(see [server/src/routes/library.js:1166](../../server/src/routes/library.js#L1166)).
Users want the option to randomize the ribbon's order instead, so the same items
don't always sit on the left.

The pre-existing **Homepage Settings** section already groups Home-related
preferences (default sort, Discover cadence, genre threshold) — this is where
the new control belongs (see [client/src/pages/Settings.jsx:1135](../../client/src/pages/Settings.jsx#L1135)).

## Goals

- Two ordering modes: **Chronological** (current behaviour, newest-first) and **Random**.
- Setting lives in Homepage Settings, persisted per device.
- Minimum impact to system resources: no new server queries, no extra network
  round-trips, no per-frame JS work, no animation cost beyond what
  [ArtGalleryRibbon](../../client/src/components/ArtGalleryRibbon.jsx) already pays.

## Non-goals

- Per-series ordering on the dedicated [/art-gallery page](../../client/src/pages/ArtGallery.jsx).
  That page already groups by series; revisit only if asked.
- Server-side randomization. `ORDER BY RANDOM()` in SQLite scans the whole row
  set and is the wrong knob to reach for when the data already fits in a small
  client-held array.
- Cross-device sync of the preference. The other Homepage Settings
  (`home_default_sort`, `home_discover_refresh_ms`, `home_genre_score_threshold`)
  are all `localStorage`-only; this matches.

## Design

### Where ordering happens

Sort client-side, inside Home, in the same `useMemo` style already used by
`discoverVisible` and `genreRibbonsVisible`
([client/src/pages/Home.jsx:407](../../client/src/pages/Home.jsx#L407)).
The server keeps returning newest-first; Home decides whether to render that
order verbatim or to shuffle it.

This avoids:
- a second `/api/home` shape,
- any DB change,
- re-fetching when the user toggles the setting.

### The shuffle

Reuse the existing `mulberry32` PRNG + `shuffleWithSeed` helpers already in
[Home.jsx:42](../../client/src/pages/Home.jsx#L42). They are Fisher–Yates over a
sliced copy — O(n) on an array that is capped at `HOME_LIMITS.gallery.max = 100`
(see [server/src/routes/library.js:1014](../../server/src/routes/library.js#L1014)).
On a typical run n ≈ 20–50. The work is negligible and runs at most once per
Home mount.

**Seed choice for Random mode:** mint a fresh seed on every Home mount
(`Math.random() * 0x7fffffff | 0`). Holding the seed inside `useMemo` means the
order is stable across unrelated re-renders within a session but reshuffles on
navigate-away-and-back, which matches the "random" promise without flicker.

We deliberately do **not** tie this to the Discover refresh cadence
(`home_discover_refresh_ms`). Discover rotates a curated pool on a *schedule*
to feel like daily picks; the gallery is the user's own bookmarks and a daily
freeze would feel sluggish. A per-mount reshuffle is cheap and intuitive.

### Storage key

```
localStorage["home_gallery_order"] = "chronological" | "random"
```

Default: `"chronological"` (preserves current behaviour for existing users).
Unknown / missing value falls back to the default — same pattern as
`readGenreMinScore` ([Home.jsx:65](../../client/src/pages/Home.jsx#L65)).

### Resource impact

| Resource              | Cost                                                                     |
|-----------------------|--------------------------------------------------------------------------|
| Network               | 0 new requests. Same `/api/home` payload.                                |
| Server CPU / DB       | 0. Same SQL, same `ORDER BY created_at DESC` (a cheap index scan).       |
| Client CPU on mount   | One Fisher–Yates pass over ≤100 items in Random mode only. ~microseconds.|
| Client CPU per frame  | 0. The existing CSS keyframe animation is unaffected.                    |
| Memory                | One additional `Array.slice()` of ≤100 small objects in Random mode.     |
| Bundle size           | ~10 lines in Home.jsx, one `<select>` in Settings.jsx. No new deps.      |

The ribbon already pauses its animation off-screen via `IntersectionObserver`
([ArtGalleryRibbon.jsx:38](../../client/src/components/ArtGalleryRibbon.jsx#L38))
— that property is preserved.

### React lifecycle

Mirror the `genreMinScore` pattern Home already uses
([Home.jsx:317](../../client/src/pages/Home.jsx#L317)):

```js
const [galleryOrder] = useState(() => readGalleryOrder());
// ↑ read once at mount. The Settings page is the canonical writer; when the
//   user changes it there, navigating back to Home remounts Home and re-reads.

const galleryItems = useMemo(() => {
  const raw = data?.art_gallery ?? [];
  if (galleryOrder !== 'random' || raw.length < 2) return raw;
  return shuffleWithSeed(raw, galleryShuffleSeed);
}, [data, galleryOrder, galleryShuffleSeed]);
```

`galleryShuffleSeed` is a `useState(() => mintSeed())` initialized once per
mount, so the order is stable across unrelated re-renders.

## Implementation steps

1. **[Home.jsx](../../client/src/pages/Home.jsx)**
   - Add `readGalleryOrder()` helper (returns `"chronological"` or `"random"`).
   - Add `galleryOrder` state and `galleryShuffleSeed` state (mint at mount).
   - Add `galleryItems` `useMemo` and pass it to `<ArtGalleryRibbon items={…} />`
     instead of `data.art_gallery` directly (line 662).

2. **[Settings.jsx](../../client/src/pages/Settings.jsx) → `HomepageSection`**
   - Add a `GALLERY_ORDER_OPTIONS` constant near the existing
     `DISCOVER_INTERVAL_OPTIONS`.
   - Add a `galleryOrder` state mirroring `discoverInterval` (read from
     `localStorage`, write on change in a `useEffect`).
   - Add a new `<div className="settings-card">` block with a `<select>` — same
     shape as the Discover interval card. Hint text: *"Chronological shows the
     most recently saved pages first. Random shuffles the order on each
     visit."*

3. **No server changes.** The existing `/api/home` and `/api/gallery/all`
   responses are already exactly what we need.

4. **No CSS changes.** The ribbon's animation is order-agnostic.

## Edge cases

- **0 or 1 items**: `ArtGalleryRibbon` returns `null` for empty, and a
  single-item shuffle is a no-op. The `raw.length < 2` short-circuit in the
  memo skips the allocation.
- **User toggles the setting in Settings**: Home remounts on route change, so
  the new value is picked up automatically — same as `home_genre_score_threshold`
  (see existing comment at [Home.jsx:316-318](../../client/src/pages/Home.jsx#L316-L318)).
- **Migration**: none. Missing key → `"chronological"` → identical to today's
  behaviour. Existing users notice nothing until they opt in.
- **Off-screen tab**: shuffle runs once at mount regardless; the ribbon's
  `IntersectionObserver` still pauses the *animation* when off-screen.

## Test plan

- Settings: toggling the dropdown writes `home_gallery_order` to `localStorage`
  and survives reload.
- Home, chronological mode: ribbon order matches `data.art_gallery` (newest-first).
- Home, random mode: order differs from the server order; re-navigating to
  Home reshuffles.
- Random mode with 0 items: ribbon does not render (existing behaviour preserved).
- Random mode with 1 item: ribbon renders that single item.
- DevTools Performance: no measurable change to scripting time on Home mount.
