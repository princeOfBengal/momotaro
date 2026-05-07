# Reader

The reader is a fullscreen page viewer with three reading modes and rich gesture support.

## Architecture

| File | Role |
|---|---|
| [client/src/pages/Reader.jsx](../client/src/pages/Reader.jsx) | State management, navigation, settings, progress saving |
| [client/src/components/ReaderPaged.jsx](../client/src/components/ReaderPaged.jsx) | Paged mode renderer — handles all pointer/touch/gesture input |
| [client/src/components/ReaderScroll.jsx](../client/src/components/ReaderScroll.jsx) | Scroll/webtoon mode renderer |
| [client/src/components/ReaderControls.jsx](../client/src/components/ReaderControls.jsx) | Top/bottom bars + settings panel |
| [client/src/components/ReaderPaged.css](../client/src/components/ReaderPaged.css) | Paged reader styles (scale types, animations) |
| [client/src/components/ReaderControls.css](../client/src/components/ReaderControls.css) | Controls bar styles |

## Reading Modes

| Mode | Value | Description |
|---|---|---|
| Right to Left | `rtl` | Paged, right-tap goes back, left-tap goes forward |
| Left to Right | `ltr` | Paged, standard western direction |
| Vertical | `vertical` | Paged, but vertically oriented |
| Webtoon | `webtoon` | Continuous vertical scroll |

`isPaged = mode === 'ltr' || mode === 'rtl'` — determines which renderer to use.

## Page Layouts (Paged Mode Only)

| Layout | Description |
|---|---|
| `single` | One page at a time |
| `double` | Always show two pages side by side |
| `double-manga` | Smart spread detection: page 0 solo (cover), wide pages solo, normal pages paired |

### Double-Manga Spread Detection

`mangaSpreads` (computed in `Reader.jsx`) builds an array of spread groups. A page is considered **wide** when `page.is_wide === 1` — set by the API when the page is a true double-page spread (width ≥ 1.5× the median page width in the chapter, so it visually occupies the space of two normal pages). Wide pages and the first page always render solo. Normal pages are paired greedily.

## Scale Types (Paged Mode)

Controlled by `.scale-{type}` class on `.reader-paged-inner`:

| Value | Behaviour |
|---|---|
| `screen` | `max-width: 100%; max-height: 100%` — contains in viewport |
| `fit-width` | `width: 100%` — fills width, scrollable vertically |
| `fit-width-shrink` | `max-width: 100%` — shrinks if too wide, never upscales |
| `fit-height` | `height: 100%` — fills height |
| `original` | Natural size, scrollable |

## Settings Persistence

All reader settings are stored in `localStorage` with `reader_` prefix:

| Key | Default |
|---|---|
| `reader_readingMode` | `rtl` |
| `reader_zoom` | `100` |
| `reader_pageAnimation` | `slide` (one of `off` \| `slide` \| `fade` \| `curl`) |
| `reader_pageAnimSpeed` | `1` (multiplier; bounded `[0.5, 2]` in 0.25 steps) |
| `reader_edgeHints` | `false` |
| `reader_hintsSeen` | unset (set to `true` after the first-run pulse plays once) |
| `reader_gestures` | `true` |
| `reader_alwaysFS` | `false` |
| `reader_bgColor` | `black` |
| `reader_grayscale` | `false` |
| `reader_brightness` | `100` |
| `reader_scaleType` | `screen` |
| `reader_pageLayout` | `single` |
| `reader_orientation` | `ltr` |
| `reader_prefetchPages` | `true` (any value other than the literal string `false` is treated as on — see [Page Prefetch](#page-prefetch)) |

**Legacy migration**: the previous boolean key `reader_animTrans` is translated on first read (`true` → `'slide'`, `false` → `'off'`) and then removed from `localStorage`. New installs default to `'slide'`.

## Page Prefetch

Implemented in [client/src/hooks/useReaderPrefetch.js](../client/src/hooks/useReaderPrefetch.js). The hook is invoked from `Reader.jsx` and is the **only** place page-image prefetching happens — `ReaderPaged.jsx` is purely a renderer + gesture surface. Toggle: `reader_prefetchPages` (default on), exposed in both the in-reader settings panel and Settings → Reading Settings.

**Layout-aware target selection.** The set of pages prefetched on each `currentPage` change depends on `pageLayout` and (for double-manga) the `mangaSpreads` array computed in `Reader.jsx`:

| Layout | Targets |
| --- | --- |
| `single` | `currentPage + 1`, `+ 2`, plus `- 1` for cheap back-navigation |
| `double` | `currentPage + 2, + 3` (next visible pair), `+ 4, + 5` (the pair after), plus `- 2` |
| `double-manga` | flatten of `mangaSpreads[spreadIdx + 1]`, `mangaSpreads[spreadIdx + 2]`, `mangaSpreads[spreadIdx - 1]` |

The double-manga branch is what makes the spread invariants survive prefetch: because `mangaSpreads` already encodes "page 0 solo, wide pages solo, otherwise greedily paired", the targets the hook hands to `new Image()` always match what the renderer is about to paint. A wide page coming up is fetched once (solo); the page that *would* have been its naïve `+1` neighbour is *not* fetched alongside it, because it is not going to render alongside it.

Currently-displayed pages (`currentPage`, `page2Index`) are excluded from targets, so a layout swap mid-chapter does not double-fetch the on-screen image.

**De-duplication.** A `Set<string>` of issued URLs lives in a hook-scoped ref. Each loop skips URLs already seen, so rapid forward/backward paging never re-issues an in-flight `new Image()` for the same page. The set is reset when `chapterId` changes and trimmed to the most recent ~200 entries to bound memory.

**Next-chapter warm-up.** When `currentPage >= pages.length - 3`, the hook fetches `api.getPages(nextChapterId)` once per chapter transition (also gated by a ref-set) and prefetches the first two pages of the result. This populates the SW's `chapter-pages-meta` cache (CacheFirst, 30-day TTL) at the same time, so the cold-start cost of opening the next chapter is paid in the background rather than on the user's tap.

**Skipped when:**

- `enabled` is false (toggle off in settings)
- `isPaged` is false — webtoon / vertical-scroll already lazy-loads via `IntersectionObserver` in `ReaderScroll`, so the hook does not duplicate that work
- `navigator.connection.saveData === true` or `effectiveType` is `'slow-2g'`/`'2g'` — Save-Data is honoured automatically without a user toggle change

**Interaction with the service worker.** Every prefetch is a normal `<img>` GET, so it flows through the SW's `page-images` CacheFirst rule and populates the same cache the on-screen `<img>` will read on the next page turn. There are no SW changes; the win is purely in the request being initiated earlier.

## Page-Turn Animations

`reader_pageAnimation` selects which keyframe runs when `currentPage` changes in paged mode. `animKey` re-mounts the inner wrapper on every page change so the keyframe restarts.

| Value | Keyframe | Base duration |
| --- | --- | --- |
| `off` | none | 0 |
| `slide` | `page-slide-{next,prev}` (24 px X-translate + opacity ramp) | 180 ms |
| `fade` | `page-fade` (symmetric opacity 0 → 1, ignores direction) | 150 ms |
| `curl` | `page-curl-{next,prev}` (`perspective(1200px)` + `rotateY` from leading edge) | 220 ms |

Every duration is multiplied by `var(--reader-anim-mult)` (set on `.reader-page` from `reader_pageAnimSpeed`), so the speed slider scales every style at once. `prefers-reduced-motion: reduce` overrides everything to `animation: none` regardless of the chosen style.

The 3D `perspective` lives on `.reader-paged-inner`; for slide/fade it's a no-op since those animations don't use `rotateY`.

## Edge Hints

Subtle chevron affordances at the left/right tap zones. Implemented in [client/src/components/ReaderEdgeHints.jsx](../client/src/components/ReaderEdgeHints.jsx) with `pointer-events: none` so the gesture system in `ReaderPaged` retains exclusive control of every touch.

| Mode | Trigger | Lifetime |
| --- | --- | --- |
| `first-run` | First reader open per device when `reader_hintsSeen !== 'true'` | Two-pulse keyframe (~1.8 s), then writes `reader_hintsSeen = 'true'` and unmounts |
| `persistent` | `reader_edgeHints === 'true'` and the user has already seen the first-run pulse | Always shown at opacity 0.7; fades to 0 for 1.5 s after every tap |
| `off` | Any of: not paged mode, settings panel open, zoom > 100, persistent disabled and first-run already seen | — |

The hints render as solid dark pills with white chevrons (z-index 160, sitting above the brightness overlay but below the control bars at z-index 200) so they remain legible against any page background — pure-white pages, pure-black pages, and the full range of cover art in between. Controls visibility intentionally does **not** suppress hints: the top/bottom bars don't overlap the vertical-center pills, and on touch devices controls stay visible from mount until a center tap, so gating on them would prevent the first-run pulse from ever playing.

Tap-driven suppression is wired through a new `onAnyTap` callback on `ReaderPaged`, fired from `execTap` after a confirmed tap. The callback is purely advisory — it never affects which side advances or any other gesture decision. **Reset reader hints** in Settings → Reading Settings clears `reader_hintsSeen` so the first-run pulse fires again on the next open.

In RTL mode the chevrons flip so each arrow visually points at the side that advances reading.

## Brightness

A `reader-brightness-overlay` div (`position: fixed; inset: 0; background: #000; pointer-events: none; z-index: 150`) sits above page content but below the control bars (z-index 200). Its CSS `opacity` is computed as `(100 - brightness) / 100`, so 100% brightness → opacity 0 (invisible), 10% brightness → opacity 0.9 (nearly black).

The `brightness` state is initialised from `localStorage` (`reader_brightness`, default 100) and updated via the slider in the **Display** tab of the settings panel.

## ReaderControls — General Tab

The **General** tab of the settings panel contains a **Make Current Image Thumbnail** button. Clicking it calls `POST /api/manga/:id/set-thumbnail` with the current page's `page_id`. The button cycles through four states:

| State | Label | Condition |
| --- | --- | --- |
| `idle` | Make Current Image Thumbnail | Default |
| `loading` | Saving… | Request in-flight |
| `done` | Thumbnail saved! | Success — resets to `idle` after 2 s |
| `error` | Failed — try again | Error — resets to `idle` after 2 s |

The button is disabled while loading or when `mangaId` is not available.

Directly below it sits the **Add to Art Gallery / Remove from Art Gallery** toggle, which bookmarks the current page to the manga's Art Gallery (shown at the bottom of MangaDetail — see [frontend.md](./frontend.md)). Label and behaviour depend on the `isCurrentPageInGallery` prop passed down from `Reader.jsx`:

| State | Label (not in gallery) | Label (in gallery) |
| --- | --- | --- |
| `idle` | Add to Art Gallery | Remove from Art Gallery |
| `loading` | Adding… | Removing… |
| `done` | Added! | Removed! |
| `error` | Failed — try again | Failed — try again |

`Reader.jsx` fetches `GET /api/manga/:id/gallery` once on mount into a `Set<page_id>` and uses that set to compute `isCurrentPageInGallery` for the current page. The toggle callback dispatches to `POST /api/manga/:id/gallery` (adding `{ pageId }`) or `DELETE /api/manga/:id/gallery/page/:pageId` and updates the set optimistically. The `UNIQUE(manga_id, page_id)` constraint on `art_gallery` with `INSERT OR IGNORE` makes the add path idempotent, so a double-tap never errors.

Directly below the gallery toggle sits a **Download Current Page** button which saves the current page's image to the device. It follows the same four-state cycle as the thumbnail button (`idle` / `loading` / `done` / `error`). The callback in `Reader.jsx` fetches `GET /api/pages/:id/image` as a blob and triggers a download via a temporary `<a download>` element. The filename is built from the manga title, chapter label (`v{volume}c{number}`, `v{volume}`, `c{number}`, or folder name), and the 1-based page index — unsafe filesystem characters (`\/:*?"<>|`) are replaced with underscores. The extension is taken from `page.filename`, defaulting to `.jpg`.

## Controls Visibility

- **Desktop**: `mousemove` anywhere → show controls, restart 3s auto-hide timer
- **Touch**: controls only shown by tapping the center zone of the screen
- **Settings panel open**: center tap closes settings instead of hiding controls
- Controls stay visible while scrubber is being dragged (`scrubActiveRef`)

## Mobile Layout

### Safe-area / notch support

Both control bars use `env(safe-area-inset-*)` so they clear the iOS notch (top) and home indicator (bottom). The app uses `viewport-fit=cover` (set in `index.html`) to fill the full screen including notched areas.

```css
/* Top bar */
height: calc(52px + env(safe-area-inset-top, 0px));
padding-top: env(safe-area-inset-top, 0px);

/* Bottom bar */
height: calc(52px + env(safe-area-inset-bottom, 0px));
padding-bottom: env(safe-area-inset-bottom, 0px);

/* Left/right (landscape notch) */
padding-left:  max(12px, env(safe-area-inset-left, 12px));
padding-right: max(12px, env(safe-area-inset-right, 12px));
```

The reader content area (`reader-page.bars-visible`) applies matching top/bottom padding so pages are never hidden under the bars:

```css
padding-top:    calc(52px + env(safe-area-inset-top, 0px));
padding-bottom: calc(52px + env(safe-area-inset-bottom, 0px));
```

The settings panel offset accounts for the variable-height top bar:

```css
top: calc(52px + env(safe-area-inset-top, 0px));
```

### Small-screen controls (≤ 600px)

- The **zoom slider** (`~170px`) is hidden; `+`/`−` step buttons remain.
- The **page scrubber** gets the full available width.
- The settings panel expands to `width: 100vw` (no left border) for full-width overlay.
- The manga title in the top bar shrinks to `max-width: 38vw` to leave room for nav buttons.

## Keyboard Navigation

| Key | Action |
|---|---|
| `ArrowRight` / `ArrowDown` | Next page (or previous in RTL mode) |
| `ArrowLeft` / `ArrowUp` | Previous page (or next in RTL mode) |
| `Escape` | Close settings panel, or navigate back to manga detail |

## Progress Saving

`saveProgress(page, completed)` is debounced 2000ms (`PROGRESS_DEBOUNCE_MS`). It calls `PUT /api/progress/:mangaId`. When reaching the last page, `markChapterComplete: true` is sent, which adds the chapter to `completed_chapters` and triggers AniList sync.

---

## ReaderPaged — Gesture System

All pointer input is handled exclusively in `ReaderPaged.jsx`. No click/touch events bubble to outer elements.

### Key Design Decisions

**`rootRef` for DOM access** — React 17+ delegates all synthetic events to the document root. `e.currentTarget` during a pointer event is the document root, **not** the actual DOM element. `setPointerCapture` must be called on the real element, so `rootRef = useRef(null)` is attached to the div and used in `capture()` / `release()`.

**`handleClick` always calls `e.stopPropagation()`** — prevents any click from ever reaching the outer `reader-page` div (which has no click handler anyway). This is the single authoritative tap handler.

**`suppressClick` ref** — set to `true` after a swipe, pan, pinch, or double-tap to block the trailing synthetic click event that browsers fire after pointer events.

**`pendingTap` ref** — set in `onPointerUp` when the gesture is confirmed as a single tap (small movement). `handleClick` reads this to know the click came from a pointer interaction, and uses `tapPos` (captured at pointerup time) rather than the click's `clientX/Y` for accurate position.

### Pointer State

```
ptrs          Map<pointerId, {x, y}>   — all active pointers
pinchState    { startDist, startZoom, startMid, originX, originY }
panState      { originX, originY, startX, startY, moved }
tapState      { x, y }                 — start of single-touch gesture
lastTap       timestamp                — for double-tap detection
```

### Gesture Flow

```
onPointerDown
  ≥2 fingers → start pinch (cancel single-finger state)
  1 finger + zoomed → start pan
  1 finger + normal → start tap tracking

onPointerMove
  ≥2 fingers + pinch → update zoom + pan offset
  1 finger + zoomed + pan → update pan offset (set dragging if > PAN_THRESHOLD)

onPointerUp
  2→1 fingers → end pinch, start pan with remaining finger
  0 fingers remaining:
    pan ended with movement → return (suppressClick already set)
    tap/swipe check:
      movement < 20px → single tap (check double-tap, else pendingTap)
      horizontal swipe → navigate (suppressClick = true)
      neither → suppressClick = true

handleClick (always stopPropagation)
  suppressClick → clear and return
  pendingTap → execTap(tapPos) → route by horizontal position
  pure mouse click → execTap(e.clientX, e.clientY)
```

### Tap Zone Routing (`execTap`)

```
|<-- 25% -->|<-- 50% center -->|<-- 25% -->|
   left tap        center          right tap
```

- Left tap: `rtl ? onNext() : onPrev()`
- Right tap: `rtl ? onPrev() : onNext()`
- Center tap: `onCenterTap()` → closes settings or toggles controls visibility

### Swipe Detection Constants

```js
SWIPE_THRESHOLD = 40   // px horizontal displacement required
SWIPE_MAX_ANGLE = 0.5  // max |dy/dx| ratio (prevents diagonal swipes)
```

Condition: `!isZoomed && gesturesEnabled && absDx > SWIPE_THRESHOLD && absDx / absDy > (1 / SWIPE_MAX_ANGLE)`

### Double-Tap Zoom

- Touch/pen only (skipped for mouse)
- Window: 280ms (`DOUBLE_TAP_MS`)
- Toggles zoom: 100% ↔ 200%

### Pan While Zoomed

- Single-finger drag when `zoom > 100`
- `PAN_THRESHOLD = 6px` before pan activates (prevents accidental micro-movement from being treated as pan)
- Pan offset stored in both `panOffsetRef` (always current, read by pointer handlers) and `panOffset` state (triggers re-render)
- Reset to `{x:0, y:0}` on page change and when zoom returns to 100%
