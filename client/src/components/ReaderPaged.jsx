import React, { useRef, useEffect, useState } from 'react';
import { api } from '../api/client';
import './ReaderPaged.css';

const SWIPE_THRESHOLD     = 40;   // px horizontal required to count as a swipe
const SWIPE_MAX_ANGLE     = 0.5;  // max |dy/dx| ratio — keeps swipes mostly horizontal
const DOUBLE_TAP_MS       = 280;  // ms window for double-tap
const PAN_THRESHOLD       = 6;    // px before a drag becomes a pan
const TAP_MOVE_THRESHOLD  = 20;   // px of movement still counted as a tap
const MAX_ZOOM            = 400;
const MIN_ZOOM            = 25;
const TOUCH_TO_MOUSE_MS   = 500;  // suppress synthesized mouse events after a touch

function dist(p1, p2) { return Math.hypot(p2.x - p1.x, p2.y - p1.y); }
function mid(p1, p2)  { return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; }

/**
 * ReaderPaged — paged renderer + gesture surface.
 *
 * Gesture handling is implemented on top of **native TouchEvent and MouseEvent
 * listeners** (attached imperatively in a single useEffect) rather than React's
 * synthetic PointerEvent. The native path is the most reliable across the three
 * shells we ship to:
 *   - PWA / desktop browser — touchscreens deliver TouchEvent, mice deliver
 *     MouseEvent. Both behave the same as in the previous implementation.
 *   - Android Capacitor WebView — TouchEvent fires natively; the Android
 *     immersive mode is set on Reader mount.
 *   - Electron AppImage (Linux) — Pointer Events synthesised by Chromium on
 *     Linux touchscreens were flaky in our build (Electron 26 + X11), with
 *     `pointerType` sometimes "mouse" and `setPointerCapture` failing silently.
 *     Using the raw TouchEvent API bypasses all of that. Combined with the
 *     `--disable-pinch` and `--touch-events=enabled` Chromium switches set in
 *     [client/electron/src/index.ts](../../electron/src/index.ts), the
 *     touchscreen behaves identically to the Android app.
 *
 * Touch state lives in refs so the handlers can be installed exactly once and
 * always read current props. Mouse events get a TOUCH_TO_MOUSE_MS suppression
 * window so the synthetic mouse/click pair that browsers fire after touch
 * doesn't double-trigger the tap router.
 */
export default function ReaderPaged({
  pages,
  currentPage,
  page2Index,
  rtl,
  orientationRtl,
  scaleType,
  zoom,
  pageAnimation,
  animKey,
  animDir,
  gesturesEnabled,
  onNext,
  onPrev,
  onCenterTap,
  onZoomChange,
  onAnyTap,
  // Backup dim-probe: when sharp's server-side dim probe failed for a page
  // (Phase 1 256 KB header sniff couldn't read it, Phase 2 re-probe missed
  // it), the browser's native image decoder still knows the real dims as
  // soon as <img onLoad> fires. We forward (pageId, w, h) up so Reader can
  // patch local pages state (mangaSpreads recomputes → Double Page (Manga)
  // pairing self-corrects) and persist via api.reportPageDimensions.
  onPageDimsLearned,
}) {
  const rootRef = useRef(null);

  const [panOffset, setPanOffsetState] = useState({ x: 0, y: 0 });
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  function setPanOffset(v) { panOffsetRef.current = v; setPanOffsetState(v); }

  // ── Stable refs for handler closures ──────────────────────────────────────
  // Handlers attach once on mount; they read live values from these refs
  // instead of closing over props/state directly. Avoids re-attaching native
  // listeners on every render.
  const propsRef = useRef({});
  propsRef.current = {
    rtl, gesturesEnabled, zoom,
    onNext, onPrev, onCenterTap, onZoomChange, onAnyTap,
  };

  const touches      = useRef(new Map());  // identifier → {x, y}
  const pinchState   = useRef(null);       // { startDist, startZoom, startMid, originX, originY }
  const panState     = useRef(null);       // { originX, originY, startX, startY, moved }
  const tapState     = useRef(null);       // { x, y, time } — start of single-finger gesture
  const lastTap      = useRef(0);          // timestamp for double-tap detection
  const suppressClick      = useRef(false); // block trailing click after swipe / pan / pinch / double-tap
  const lastTouchEnd       = useRef(0);     // last touch-end time — suppresses synthetic mouse events

  const isZoomed = zoom > 100;

  // ── Reset on page change ──────────────────────────────────────────────────
  useEffect(() => {
    setPanOffset({ x: 0, y: 0 });
    touches.current.clear();
    pinchState.current = panState.current = tapState.current = null;
    lastTap.current = 0;
    suppressClick.current = false;
    setDragging(false);
  }, [currentPage]);

  useEffect(() => {
    if (!isZoomed) {
      setPanOffset({ x: 0, y: 0 });
      setDragging(false);
    }
  }, [isZoomed]);

  // ── Tap zone routing ──────────────────────────────────────────────────────
  function execTap(x, y) {
    const el = rootRef.current;
    if (!el) return;
    const p = propsRef.current;
    const rect = el.getBoundingClientRect();
    const pct  = (x - rect.left) / rect.width;
    p.onAnyTap?.();
    if (pct < 0.25)      { p.rtl ? p.onNext() : p.onPrev(); }
    else if (pct > 0.75) { p.rtl ? p.onPrev() : p.onNext(); }
    else                 { p.onCenterTap(); }
  }

  // ── Native event listeners ────────────────────────────────────────────────
  // Attached imperatively (not via React props) so we can use { passive: false }
  // on touch events — required for preventDefault() to actually suppress the
  // browser-native pinch zoom / scroll on top of `touch-action: none`.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    // ── Touch ───────────────────────────────────────────────────────────────

    function onTouchStart(e) {
      // Always preventDefault so the browser doesn't synthesise extra mouse
      // events while still letting the gesture system handle multi-touch.
      e.preventDefault();
      lastTouchEnd.current = Date.now();  // pre-empt synthetic mouse events

      const z = propsRef.current.zoom;
      const zoomed = z > 100;

      for (const t of e.changedTouches) {
        touches.current.set(t.identifier, { x: t.clientX, y: t.clientY });
      }

      if (touches.current.size >= 2) {
        // Pinch start — cancel any single-finger gesture state
        tapState.current = null;
        panState.current = null;
        suppressClick.current = true;
        setDragging(false);

        const [p1, p2] = [...touches.current.values()];
        pinchState.current = {
          startDist: dist(p1, p2),
          startZoom: z,
          startMid:  mid(p1, p2),
          originX:   panOffsetRef.current.x,
          originY:   panOffsetRef.current.y,
        };
        return;
      }

      // Single-finger start
      pinchState.current   = null;
      suppressClick.current = false;
      const t0 = e.changedTouches[0];
      if (zoomed) {
        panState.current = {
          originX: panOffsetRef.current.x,
          originY: panOffsetRef.current.y,
          startX:  t0.clientX,
          startY:  t0.clientY,
          moved:   false,
        };
      } else {
        tapState.current = { x: t0.clientX, y: t0.clientY, time: Date.now() };
      }
    }

    function onTouchMove(e) {
      e.preventDefault();
      lastTouchEnd.current = Date.now();

      for (const t of e.changedTouches) {
        if (touches.current.has(t.identifier)) {
          touches.current.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
      }

      // Pinch
      if (touches.current.size >= 2 && pinchState.current) {
        const [p1, p2] = [...touches.current.values()];
        const scale   = dist(p1, p2) / pinchState.current.startDist;
        const newZoom = Math.round(
          Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchState.current.startZoom * scale))
        );
        propsRef.current.onZoomChange(newZoom);
        const m = mid(p1, p2);
        setPanOffset({
          x: pinchState.current.originX + (m.x - pinchState.current.startMid.x),
          y: pinchState.current.originY + (m.y - pinchState.current.startMid.y),
        });
        return;
      }

      // Single-finger pan while zoomed
      if (touches.current.size === 1 && propsRef.current.zoom > 100 && panState.current) {
        const t0 = e.changedTouches[0];
        const dx = t0.clientX - panState.current.startX;
        const dy = t0.clientY - panState.current.startY;
        if (!panState.current.moved && (Math.abs(dx) > PAN_THRESHOLD || Math.abs(dy) > PAN_THRESHOLD)) {
          panState.current.moved = true;
          suppressClick.current  = true;
          setDragging(true);
        }
        if (panState.current.moved) {
          setPanOffset({
            x: panState.current.originX + dx,
            y: panState.current.originY + dy,
          });
        }
      }
    }

    function onTouchEnd(e) {
      // preventDefault to suppress the synthetic mousedown/mouseup/click that
      // would otherwise follow (in addition to lastTouchEnd's time-window
      // safety net).
      e.preventDefault();
      lastTouchEnd.current = Date.now();

      const endedTouches = [...e.changedTouches];
      for (const t of endedTouches) touches.current.delete(t.identifier);

      // Pinch (2+ → 1): transition to single-finger pan if still zoomed
      if (pinchState.current && touches.current.size === 1) {
        pinchState.current = null;
        if (propsRef.current.zoom > 100) {
          const [, remaining] = [...touches.current.entries()][0];
          panState.current = {
            originX: panOffsetRef.current.x,
            originY: panOffsetRef.current.y,
            startX:  remaining.x,
            startY:  remaining.y,
            moved:   false,
          };
        }
        return;
      }

      // More fingers still down — wait for the rest to lift
      if (touches.current.size > 0) return;

      // All touches up
      setDragging(false);

      // Pinch ended cleanly
      if (pinchState.current) {
        pinchState.current = null;
        suppressClick.current = true;
        return;
      }

      // Pan ended
      if (panState.current) {
        const wasMovement = panState.current.moved;
        panState.current = null;
        if (wasMovement) {
          suppressClick.current = true;
          return;
        }
        // No movement during pan tracking — fall through to tap logic below
      }

      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }

      // ── Tap or swipe ──
      const start = tapState.current;
      tapState.current = null;
      if (!start) return;

      const end   = endedTouches[0];
      const dx    = end.clientX - start.x;
      const dy    = end.clientY - start.y;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // Tap (negligible movement)
      if (absDx < TAP_MOVE_THRESHOLD && absDy < TAP_MOVE_THRESHOLD) {
        const now = Date.now();
        if (now - lastTap.current < DOUBLE_TAP_MS) {
          // Double-tap zoom toggle
          lastTap.current = 0;
          propsRef.current.onZoomChange(propsRef.current.zoom > 100 ? 100 : 200);
          return;
        }
        lastTap.current = now;
        if (propsRef.current.zoom <= 100) execTap(end.clientX, end.clientY);
        return;
      }

      // Swipe
      const p = propsRef.current;
      if (p.zoom <= 100 && p.gesturesEnabled
          && absDx > SWIPE_THRESHOLD
          && absDx / Math.max(absDy, 1) > (1 / SWIPE_MAX_ANGLE)) {
        if (dx < 0) p.rtl ? p.onPrev() : p.onNext();
        else        p.rtl ? p.onNext() : p.onPrev();
      }
    }

    function onTouchCancel(e) {
      for (const t of e.changedTouches) touches.current.delete(t.identifier);
      if (touches.current.size === 0) {
        pinchState.current = panState.current = tapState.current = null;
        suppressClick.current = false;
        setDragging(false);
      }
    }

    // ── Mouse (desktop pointer) ─────────────────────────────────────────────
    // Mouse path is independent of touch; it does not use the touches map.

    let mouseDown      = false;
    let mouseDownPos   = null;
    let mouseMoved     = false;

    function isFromTouch() {
      return Date.now() - lastTouchEnd.current < TOUCH_TO_MOUSE_MS;
    }

    function onMouseDown(e) {
      if (e.button !== 0)  return;  // left button only
      if (isFromTouch())   return;
      mouseDown      = true;
      mouseDownPos   = { x: e.clientX, y: e.clientY };
      mouseMoved     = false;

      if (propsRef.current.zoom > 100) {
        panState.current = {
          originX: panOffsetRef.current.x,
          originY: panOffsetRef.current.y,
          startX:  e.clientX,
          startY:  e.clientY,
          moved:   false,
        };
      }
    }

    function onMouseMove(e) {
      if (!mouseDown || !mouseDownPos) return;
      const dx = e.clientX - mouseDownPos.x;
      const dy = e.clientY - mouseDownPos.y;
      if (!mouseMoved && (Math.abs(dx) > PAN_THRESHOLD || Math.abs(dy) > PAN_THRESHOLD)) {
        mouseMoved = true;
      }
      if (propsRef.current.zoom > 100 && panState.current && mouseMoved) {
        panState.current.moved = true;
        suppressClick.current  = true;
        setDragging(true);
        setPanOffset({
          x: panState.current.originX + dx,
          y: panState.current.originY + dy,
        });
      }
    }

    function onMouseUp(e) {
      if (e.button !== 0) return;
      mouseDown = false;
      if (panState.current) {
        const wasMovement = panState.current.moved;
        panState.current = null;
        if (wasMovement) {
          suppressClick.current = true;
          setDragging(false);
        }
      }
    }

    function onClick(e) {
      // Always stop propagation — Reader.jsx outer divs have no click handler
      // and we don't want stray clicks bubbling.
      e.stopPropagation();

      if (isFromTouch()) {
        // The touchend handler already executed the tap (and possibly set
        // suppressClick). Just clear the flag and bail.
        suppressClick.current = false;
        return;
      }
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (propsRef.current.zoom > 100) return;  // taps while zoomed are no-ops
      execTap(e.clientX, e.clientY);
    }

    // Touch listeners: { passive: false } so preventDefault works.
    el.addEventListener('touchstart',  onTouchStart,  { passive: false });
    el.addEventListener('touchmove',   onTouchMove,   { passive: false });
    el.addEventListener('touchend',    onTouchEnd,    { passive: false });
    el.addEventListener('touchcancel', onTouchCancel, { passive: false });
    // Mouse listeners — document-level for move/up so a drag that leaves the
    // element still completes.
    el.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    el.addEventListener('click', onClick);

    return () => {
      el.removeEventListener('touchstart',  onTouchStart);
      el.removeEventListener('touchmove',   onTouchMove);
      el.removeEventListener('touchend',    onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
      el.removeEventListener('click', onClick);
    };
  }, []);  // Stable listeners — current values read from propsRef

  // ── Render ────────────────────────────────────────────────────────────────

  const page = pages[currentPage];
  if (!page) return null;

  const page2     = page2Index != null ? pages[page2Index] : null;
  const animClass = pageAnimation === 'fade'  ? 'page-anim-fade'
                  : pageAnimation === 'curl'  ? `page-anim-curl-${animDir}`
                  : pageAnimation === 'slide' ? `page-anim-slide-${animDir}`
                  : '';
  const leftPage  = page2 && orientationRtl ? page2 : page;
  const rightPage = page2 && orientationRtl ? page  : page2;
  const leftAlt   = page2 && orientationRtl ? `Page ${currentPage + 2}` : `Page ${currentPage + 1}`;
  const rightAlt  = page2 && orientationRtl ? `Page ${currentPage + 1}` : `Page ${currentPage + 2}`;

  return (
    <div
      ref={rootRef}
      className={[
        'reader-paged',
        rtl ? 'rtl' : 'ltr',
        isZoomed ? (dragging ? 'panning' : 'pannable') : '',
      ].filter(Boolean).join(' ')}
    >
      <div
        className={`reader-paged-inner scale-${scaleType}${page2 ? ' double-page' : ''}`}
        style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(var(--reader-zoom, 1))` }}
      >
        <div
          key={animKey}
          className={`reader-paged-anim-wrapper${animClass ? ` ${animClass}` : ''}`}
        >
          <img
            src={api.pageImageUrl(leftPage.id)}
            alt={leftAlt}
            className="reader-page-img"
            draggable={false}
            onLoad={(e) => {
              // Skip if dims are already known — the server-side path
              // populated them (or a previous onLoad already did).
              if (leftPage.is_wide !== null && leftPage.is_wide !== undefined) return;
              const w = e.target.naturalWidth;
              const h = e.target.naturalHeight;
              if (!w || !h) return;
              onPageDimsLearned?.(leftPage.id, w, h);
            }}
          />
          {page2 && (
            <img
              src={api.pageImageUrl(rightPage.id)}
              alt={rightAlt}
              className="reader-page-img"
              draggable={false}
              onLoad={(e) => {
                if (rightPage.is_wide !== null && rightPage.is_wide !== undefined) return;
                const w = e.target.naturalWidth;
                const h = e.target.naturalHeight;
                if (!w || !h) return;
                onPageDimsLearned?.(rightPage.id, w, h);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
