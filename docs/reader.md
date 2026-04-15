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

`mangaSpreads` (computed in `Reader.jsx`) builds an array of spread groups. A page is considered **wide** when `page.is_wide === 1` (set by the scanner when `width > height`). Wide pages and the first page always render solo. Normal pages are paired greedily.

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
| `reader_animTrans` | `false` |
| `reader_gestures` | `true` |
| `reader_alwaysFS` | `false` |
| `reader_bgColor` | `black` |
| `reader_grayscale` | `false` |
| `reader_scaleType` | `screen` |
| `reader_pageLayout` | `single` |
| `reader_orientation` | `ltr` |

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
