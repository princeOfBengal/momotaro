# Art Gallery Ribbon Ordering — Implementation Plan

Companion to [art-gallery-ordering.md](art-gallery-ordering.md). Lists the exact
files, lines, and code to add/change. No server, DB, CSS, or dependency changes.

## Summary of file touchpoints

| File                                                                                  | Change                                                                  | Approx. lines |
|---------------------------------------------------------------------------------------|-------------------------------------------------------------------------|--------------:|
| [client/src/pages/Home.jsx](../../client/src/pages/Home.jsx)                          | Add `readGalleryOrder` helper, mount-time state, shuffle memo, wire prop |           ~20 |
| [client/src/pages/Settings.jsx](../../client/src/pages/Settings.jsx)                  | Add option list, state, persist effect, dropdown card                    |           ~30 |

Total: ~50 lines added across two files. No new files.

---

## Step 1 — Home.jsx

### 1a. Add constants + reader near the other Home localStorage helpers

Insert after the `LS_GENRE_MIN_SCORE` block ([Home.jsx:18-31](../../client/src/pages/Home.jsx#L18-L31)):

```js
// Art Gallery ribbon ordering. "chronological" preserves the server's
// newest-first ordering; "random" applies a per-mount Fisher–Yates shuffle.
// Same writer/reader split as home_genre_score_threshold — Settings writes,
// Home reads at mount.
const LS_GALLERY_ORDER       = 'home_gallery_order';
const GALLERY_ORDER_VALUES   = ['chronological', 'random'];
const DEFAULT_GALLERY_ORDER  = 'chronological';
```

### 1b. Add the reader helper

Insert alongside `readGenreMinScore` ([Home.jsx:65-71](../../client/src/pages/Home.jsx#L65-L71)):

```js
function readGalleryOrder() {
  const raw = localStorage.getItem(LS_GALLERY_ORDER);
  return GALLERY_ORDER_VALUES.includes(raw) ? raw : DEFAULT_GALLERY_ORDER;
}
```

### 1c. Add state inside `Home()`

Insert after the `genreMinScore` line ([Home.jsx:317](../../client/src/pages/Home.jsx#L317)):

```js
const [galleryOrder]        = useState(() => readGalleryOrder());
// Per-mount shuffle seed — stable across re-renders within a Home session,
// reshuffles on navigate-away-and-back. Only consumed when galleryOrder
// === 'random', but mint unconditionally so it's a no-cost constant otherwise.
const [galleryShuffleSeed]  = useState(() => (Math.random() * 0x7fffffff) | 0);
```

### 1d. Add the memoized ordered list

Insert next to `continueRest` / `genreRibbonsVisible` ([Home.jsx:407-433](../../client/src/pages/Home.jsx#L407-L433)):

```js
const galleryItems = useMemo(() => {
  const raw = data?.art_gallery ?? [];
  if (galleryOrder !== 'random' || raw.length < 2) return raw;
  return shuffleWithSeed(raw, galleryShuffleSeed);
}, [data, galleryOrder, galleryShuffleSeed]);
```

`shuffleWithSeed` already exists at [Home.jsx:73-83](../../client/src/pages/Home.jsx#L73-L83) — no new helper.

### 1e. Wire the prop

At [Home.jsx:662](../../client/src/pages/Home.jsx#L662), change:

```jsx
items={data.art_gallery}
```

to:

```jsx
items={galleryItems}
```

That is the only render-side change in Home.jsx.

---

## Step 2 — Settings.jsx (`HomepageSection`)

### 2a. Add constants near the other Homepage option lists

Insert after `DEFAULT_DISCOVER_INTERVAL` ([Settings.jsx:1121](../../client/src/pages/Settings.jsx#L1121)):

```js
// Art Gallery ribbon ordering on Home. Values mirror Home.jsx's
// GALLERY_ORDER_VALUES — keep in sync.
const GALLERY_ORDER_OPTIONS = [
  { value: 'chronological', label: 'Chronological (newest first)' },
  { value: 'random',        label: 'Random' },
];
const DEFAULT_GALLERY_ORDER = 'chronological';
```

### 2b. Add state inside `HomepageSection()`

Insert after the `genreMinScore` useState block ([Settings.jsx:1146-1151](../../client/src/pages/Settings.jsx#L1146-L1151)):

```js
const [galleryOrder, setGalleryOrder] = useState(() => {
  const saved = localStorage.getItem('home_gallery_order');
  return GALLERY_ORDER_OPTIONS.some(o => o.value === saved)
    ? saved
    : DEFAULT_GALLERY_ORDER;
});
```

### 2c. Add the persist effect

Insert after the `home_genre_score_threshold` effect ([Settings.jsx:1165-1167](../../client/src/pages/Settings.jsx#L1165-L1167)):

```js
useEffect(() => {
  localStorage.setItem('home_gallery_order', galleryOrder);
}, [galleryOrder]);
```

### 2d. Add the dropdown card to the rendered output

Insert as a new `<div className="settings-card">` directly after the Discover
interval card and before the Genre threshold card (around
[Settings.jsx:1237-1239](../../client/src/pages/Settings.jsx#L1237-L1239)):

```jsx
<div className="settings-card" style={{ marginTop: 16 }}>
  <div className="setting-group">
    <label className="setting-group-label" htmlFor="gallery-order">
      Art Gallery order
    </label>
    <p className="rs-setting-hint">
      How saved pages are ordered in the <strong>Art Gallery</strong> ribbon on
      Home. <em>Chronological</em> shows the most recently saved page first.
      <em> Random</em> shuffles the order each time you open Home.
    </p>
    <select
      id="gallery-order"
      className="setting-select"
      value={galleryOrder}
      onChange={e => setGalleryOrder(e.target.value)}
      style={{ maxWidth: 320 }}
    >
      {GALLERY_ORDER_OPTIONS.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  </div>
</div>
```

Uses existing `settings-card`, `setting-group`, `setting-group-label`,
`rs-setting-hint`, and `setting-select` classes — no new CSS.

---

## Step 3 — Server / DB

**No changes.** The existing `/api/home` response already returns
`art_gallery` newest-first ([server/src/routes/library.js:1166](../../server/src/routes/library.js#L1166))
and the existing `HOME_LIMITS.gallery.max = 100` cap
([server/src/routes/library.js:1014](../../server/src/routes/library.js#L1014))
keeps the client shuffle bounded.

## Step 4 — CSS / styles

**No changes.** Reusing `settings-card` and `setting-select` from
[Settings.css](../../client/src/pages/Settings.css). The ribbon's CSS
keyframes are order-agnostic.

## Step 5 — Tests / verification

There is no JS test suite for these pages, so verification is manual via the
running app (matches how `home_genre_score_threshold` and
`home_discover_refresh_ms` shipped). Use the [run skill](../../README.md) or
launch Vite directly.

Manual test matrix:

| Scenario                                                | Expected                                                                                              |
|---------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| Fresh install, no localStorage key                      | Ribbon order = newest-first (current behaviour).                                                       |
| Settings → set to Random → reload Settings              | Dropdown still shows Random. `localStorage.home_gallery_order === 'random'`.                          |
| Settings → set to Random → navigate to Home             | Ribbon order differs from `data.art_gallery` order.                                                   |
| Random mode, navigate away and back to Home             | Order reshuffles (different from previous mount).                                                     |
| Random mode, scroll, idle, re-render Home               | Order stable within the mount (no flicker).                                                           |
| Switch back to Chronological → Home                     | Newest-first restored, matches `data.art_gallery[0]` on the left.                                     |
| Gallery has 0 items                                     | Ribbon does not render (existing `if (!items || items.length === 0) return null` guard).              |
| Gallery has 1 item                                      | Single tile renders; no error in console.                                                             |
| Animation pause when ribbon off-screen                  | Still works (IntersectionObserver path untouched).                                                    |

DevTools spot-check: on Home mount in Random mode, the shuffle should not
appear on a Performance flame chart at any noticeable width — n is capped
at 100 and Fisher–Yates is O(n).

---

## Rollout

- Single PR. No feature flag — the default value (`"chronological"`) preserves
  current behaviour bit-for-bit, so the change is invisible until the user
  opts in.
- No migration. Missing key resolves to the default.
- No deprecations.

## Risk register

| Risk                                                          | Mitigation                                                                                            |
|---------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `GALLERY_ORDER_VALUES` in Home drifts from `GALLERY_ORDER_OPTIONS` in Settings | Both files have a comment pointing at the other; values are short (`'chronological'`, `'random'`) and validated on read in Home, so an unknown value silently falls back. |
| Users expect the dedicated `/art-gallery` page to honour the setting too | Out of scope per design doc (that page is grouped-by-series). If requested later, lift `readGalleryOrder` into a small shared helper module. |
| Future reader changes write to `localStorage.home_gallery_order` with a new value | Validation in `readGalleryOrder` already drops unknown values to the default; no crash path. |

## Out-of-scope follow-ups (do not do now)

- Cross-device sync of the preference.
- Per-series ordering on the dedicated Art Gallery page.
- Server-side `ORDER BY RANDOM()` — wrong tool; the data already fits in the
  client array.
- A "reshuffle now" button on Home — not requested and Random already
  reshuffles on each Home mount.
