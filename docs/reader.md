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

`mangaSpreads` (computed in `Reader.jsx`) builds an array of spread groups. A page is considered **wide** when `page.is_wide === true` — set by the API whenever the page is landscape (`width > height`), since such pages typically represent a spread. Wide pages and the first page always render solo. Normal pages are paired greedily.

**Defensive default for unknown dimensions.** Pages with `is_wide === null` (dimensions not yet known — happens transiently for CBZ chapters under fast-mode extraction when the Phase 1 256 KB header sniff fails for some pages) render **solo**. The pair-with-next check requires both pages to be **explicitly known not-wide** (`is_wide === false`). Rationale: rendering an unknown page solo briefly looks like one tile alongside another, which is suboptimal but never *wrong*. Rendering an unknown page paired with its neighbour can crush a wide spread into half-screen — visibly broken. Defaulting to solo eliminates the broken case entirely; the layout self-corrects within seconds as dims arrive.

**How dims arrive after a fast-mode chapter open** (four independent paths, layered for resilience):

1. **Phase 1 dim probe** — sharp header sniff per entry during chapter open. Most reliable for standard image formats; fast (~5–15 ms per entry).
2. **Phase 2 server-side re-probe** — after each background extract, `sharp.metadata()` runs on the on-disk file and the dim is written via `UPDATE … WHERE … AND (width IS NULL OR height IS NULL)`. Reliable where the 256 KB sniff was not, since it reads the full file.
3. **Cache-hit heal pass** — on subsequent chapter opens, any row with null dims triggers a `backfillDimsFromDisk` over the existing extracted files. Catches anything (1) and (2) missed.
4. **Client onLoad probe** — when an `<img>` finishes decoding, the reader reads `naturalWidth`/`naturalHeight` and reports them via `POST /api/pages/dims`. The browser's native decoder is the final source of truth — catches any format `sharp` couldn't read. Implemented in `ReaderPaged.jsx`, `ReaderScroll.jsx`, and the `new Image()` instances in `useReaderPrefetch.js`. See [Backup client-side dim probe](#backup-client-side-dim-probe) below.

The reader updates its local `pages` state when dims are learned. `mangaSpreads` recomputes via its `useMemo` deps; `currentPage` re-anchors **by page index** (not by spread index) so a dim update never jumps the user to a different image. Most corrections happen for pages the prefetcher loaded a few pages ahead of where the user is reading, so the visible layout shift is rare in practice.

### Backup client-side dim probe

When an `<img>` finishes decoding in the reader, `e.target.naturalWidth` / `naturalHeight` are authoritative. The Reader registers an `onPageDimsLearned` callback that:

1. Patches local `pages` state via a `setPages` updater that only mutates rows where `is_wide` is currently `null` (idempotent — re-renders that fire the same onLoad against a now-known row no-op).
2. Calls `api.reportPageDimensions(pageId, width, height)`, a buffered helper that dedupes by `page_id` (`Map`-keyed), batches up to 16 entries, and flushes after 800 ms of idle to `POST /api/pages/dims`. The server's UPDATE filter `AND (width IS NULL OR height IS NULL)` guarantees client reports never overwrite a server-probed value.

Coverage: every image rendered in `ReaderPaged.jsx` (1 or 2 displayed) and `ReaderScroll.jsx` (every visible page in scroll mode), plus every `new Image()` instance the prefetch hook warms. The prefetched path is especially valuable — it runs 1–5 pages ahead of where the user is reading, so dim corrections typically arrive **before** the user navigates to the affected page (invisible layout fix).

Offline behaviour: the local pages-state patch still applies (in-session layout correct). The `POST /api/pages/dims` is buffered + fire-and-forget; offline failures are caught and swallowed, so the buffer clears on the attempt and the local state remains correct.

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
| `reader_fastChapterOpen` | `false` (opt-in; the `?fast=1` flag for `/api/chapters/:id/pages` — see [scanner.md § Fast mode](./scanner.md#fast-mode-first-page-fast)) |
| `reader_predictNextChapter` | `true` for users who had `reader_prefetchPages` on (preserves today's implicit behaviour), `false` for users who had it off. One-time migration via `resolveInitialPredictNextChapter`; settings independent thereafter. |
| `reader_volumeButtonNav` | `false` (opt-in, **Android only**). Turn pages with the hardware volume keys. See [Volume-button navigation](#volume-button-navigation-android-only). |
| `reader_volumeButtonReverse` | `false` (Android only). Swap the mapping so Volume Down = next, Volume Up = prev. |

**Legacy migrations**:

- `reader_animTrans` (boolean) → `reader_pageAnimation` (`'slide'` / `'off'`) on first read, then removed.
- `reader_predictNextChapter` initial value inherits from `reader_prefetchPages` on first read (no-set scenario), then persists independently. Existing users who had image prefetch off don't suddenly start getting background next-chapter pre-extraction requests after upgrade.

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

**Next-chapter warm-up.** When `currentPage >= pages.length - 3`, the hook calls `api.getPages(nextChapterId)` (or `api.getPagesWithMeta(nextChapterId, { fast: true })` when both `predictNextChapter` and `fastChapterOpen` are on) once per chapter transition (gated by a ref-set), then warms the first two pages of the result. This populates the SW's `chapter-pages-meta` cache (CacheFirst, 30-day TTL) at the same time, so the cold-start cost of opening the next chapter is paid in the background rather than on the user's tap.

Two independent settings govern next-chapter prefetch:

- **`reader_predictNextChapter`** (default inherits from `reader_prefetchPages` on first read; independent thereafter) gates the next-chapter prefetch entirely. Off → no `getPages(next.id)` fires near end-of-chapter.
- **`reader_fastChapterOpen`** (default off — opt-in) decides which endpoint flavour the prefetch hits. When both flags are on, the prefetch returns after server-side Phase 1 (~1–3 s) instead of holding the connection for a full extract. Phase 2 continues in the background, so user navigation lands on a near-instant cache hit. See [scanner.md § Fast mode](./scanner.md#fast-mode-first-page-fast).

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

## ReaderControls — Tabs

The in-reader settings panel has four tabs that mirror the layout of Settings → Reading Settings on the main Settings page:

| Tab | Contents |
| --- | --- |
| **General** | Reading Mode, Reading Orientation, Page Transition, Animation Speed, Show edge hints, Gestures, Always Full Screen, plus the per-page actions (Make Current Image Thumbnail / Add to Art Gallery / Download Current Page) |
| **Display** | Background Color, Grayscale, Brightness |
| **Paged** | Scale Type, Page Layout (Single / Double / Double Page (Manga)) |
| **Advanced** | **Preload upcoming pages** (`reader_prefetchPages`), **Fast chapter open** (`reader_fastChapterOpen`), **Pre-load next chapter** (`reader_predictNextChapter`). Three settings that affect server-side or background work — grouped together so a user wanting to control resource usage can find them in one place. Each toggle in the in-reader Advanced tab is wired to the same `localStorage` key as its twin in Settings → Reading Settings → Advanced, so changes from either surface propagate. |

### General Tab

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

## Volume-Button Navigation (Android only)

On the Android Capacitor app the hardware volume keys can turn pages, with the
same effect as a side tap/swipe: **Volume Up = next page, Volume Down = previous
page** (logical direction — it does not invert with RTL). A reverse toggle swaps
the two. Both are opt-in and live in **Advanced** reader settings (Settings →
Reading → Advanced, and the in-reader Advanced tab) — the toggles only render on
Android.

| Setting | localStorage key |
|---|---|
| Volume buttons turn pages | `reader_volumeButtonNav` (default `false`) |
| Reverse volume buttons | `reader_volumeButtonReverse` (default `false`) |

**How it works.** The in-tree `VolumeButtons` Capacitor plugin
([VolumeButtonsPlugin.java](../client/android/app/src/main/java/dev/momotaro/app/VolumeButtonsPlugin.java))
holds an `active` flag; [MainActivity.java](../client/android/app/src/main/java/dev/momotaro/app/MainActivity.java)
overrides `onKeyDown`/`onKeyUp` and, while active, consumes `KEYCODE_VOLUME_UP` /
`KEYCODE_VOLUME_DOWN` (suppressing the system volume HUD and the volume change)
and forwards a `volumeButton` event with `direction: "up" | "down"` to the JS
reader. The JS bridge ([client/src/api/volumeButtons.js](../client/src/api/volumeButtons.js))
no-ops off Android (`Capacitor.getPlatform() === 'android'`), so the PWA and the
Linux/Electron AppImage never act on volume keys — the plugin isn't in the
Electron preload either.

[Reader.jsx](../client/src/pages/Reader.jsx) subscribes once (the bridge
round-trip is expensive) and reads the latest page-turn callbacks + reverse flag
through a ref, so toggling reverse never forces a resubscribe. The effect bails
on `!isPaged`, so **webtoon / continuous-scroll mode is a no-op** (no discrete
pages to turn) — volume works normally there. Cleanup always calls
`disableVolumeButtons()`, so the native interception can never outlive the
reader; combined with the fact that `onKeyDown` only fires for the foreground
Activity, volume keys behave normally everywhere outside an active paged read.

**No Android permission is required** — observing/consuming volume keys for the
foreground Activity is unprivileged input, and we never touch the audio stream
(so no `MODIFY_AUDIO_SETTINGS`). This is a native change, so it ships only in a
new APK build (`versionCode`/`versionName` + `APP_VERSION` bumped); PWA users
correctly never see the feature.

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
