import React, { useRef, useEffect, useState } from 'react';
import { api } from '../api/client';
import './ReaderPaged.css';

const SWIPE_THRESHOLD = 40;   // px horizontal required to count as a swipe
const SWIPE_MAX_ANGLE = 0.5;  // max |dy/dx| ratio — keeps swipes mostly horizontal
const DOUBLE_TAP_MS   = 280;  // ms window for double-tap
const PAN_THRESHOLD   = 6;    // px before a drag becomes a pan
const MAX_ZOOM        = 400;
const MIN_ZOOM        = 25;

function dist(p1, p2) { return Math.hypot(p2.x - p1.x, p2.y - p1.y); }
function mid(p1, p2)  { return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; }

export default function ReaderPaged({
  pages,
  currentPage,
  page2Index,
  rtl,
  orientationRtl,
  scaleType,
  zoom,
  animateTransitions,
  animKey,
  animDir,
  gesturesEnabled,
  onNext,
  onPrev,
  onCenterTap,
  onZoomChange,
}) {
  const rootRef = useRef(null);               // DOM ref — used for setPointerCapture & getBoundingClientRect

  const [panOffset, setPanOffsetState] = useState({ x: 0, y: 0 });
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Use a ref mirror so pointer handlers (which close over stale state) always read current pan
  function setPanOffset(v) { panOffsetRef.current = v; setPanOffsetState(v); }

  // Per-pointer tracking map: id → { x, y }
  const ptrs        = useRef(new Map());
  const pinchState  = useRef(null);  // { startDist, startZoom, startMid, originX, originY }
  const panState    = useRef(null);  // { originX, originY, startX, startY, moved }
  const tapState    = useRef(null);  // { x, y, time } — single-touch start for tap/swipe
  const lastTap     = useRef(0);     // timestamp of previous tap (for double-tap detection)
  const pendingTap  = useRef(false); // true: pointerup decided this was a tap, click will execute it
  const tapPos      = useRef(null);  // { x, y } — position to use for the pending tap
  const suppressClick = useRef(false); // blocks click after swipe / pan / pinch / double-tap

  const isZoomed = zoom > 100;

  // ── Reset on page change ───────────────────────────────────────────────────────
  useEffect(() => {
    setPanOffset({ x: 0, y: 0 });
    ptrs.current.clear();
    pinchState.current = panState.current = tapState.current = null;
    lastTap.current = 0;
    pendingTap.current = false;
    tapPos.current = null;
    suppressClick.current = false;
    setDragging(false);
  }, [currentPage]);

  useEffect(() => {
    if (!isZoomed) {
      setPanOffset({ x: 0, y: 0 });
      setDragging(false);
    }
  }, [isZoomed]);

  // ── Preload ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    [currentPage + 1, currentPage + 2].forEach(i => {
      if (i < pages.length) { const img = new Image(); img.src = api.pageImageUrl(pages[i].id); }
    });
  }, [currentPage, pages]);

  // ── Helpers ────────────────────────────────────────────────────────────────────

  // Call setPointerCapture on the real DOM node, not React's synthetic currentTarget.
  // React 17+ delegates events to the root, so e.currentTarget is NOT the DOM element
  // we want to capture on — using the ref avoids this.
  function capture(pointerId) {
    try { rootRef.current?.setPointerCapture(pointerId); } catch (_) {}
  }
  function release(pointerId) {
    try { rootRef.current?.releasePointerCapture(pointerId); } catch (_) {}
  }

  function execTap(x, y) {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const pct  = (x - rect.left) / rect.width;
    if (pct < 0.25)      { rtl ? onNext() : onPrev(); }
    else if (pct > 0.75) { rtl ? onPrev() : onNext(); }
    else                 { onCenterTap(); }
  }

  // ── Pointer events ─────────────────────────────────────────────────────────────

  function onPointerDown(e) {
    capture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (ptrs.current.size >= 2) {
      // Cancel any in-flight single-finger gesture
      tapState.current   = null;
      panState.current   = null;
      suppressClick.current = true;
      setDragging(false);

      const [p1, p2] = [...ptrs.current.values()];
      pinchState.current = {
        startDist: dist(p1, p2),
        startZoom: zoom,
        startMid:  mid(p1, p2),
        originX:   panOffsetRef.current.x,
        originY:   panOffsetRef.current.y,
      };
      return;
    }

    // Single pointer down
    pinchState.current    = null;
    suppressClick.current = false;

    if (isZoomed) {
      panState.current = {
        originX: panOffsetRef.current.x,
        originY: panOffsetRef.current.y,
        startX:  e.clientX,
        startY:  e.clientY,
        moved:   false,
      };
    } else {
      tapState.current = { x: e.clientX, y: e.clientY };
    }
  }

  function onPointerMove(e) {
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Pinch
    if (ptrs.current.size >= 2 && pinchState.current) {
      const [p1, p2] = [...ptrs.current.values()];
      const scale   = dist(p1, p2) / pinchState.current.startDist;
      const newZoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchState.current.startZoom * scale)));
      onZoomChange(newZoom);
      const m = mid(p1, p2);
      setPanOffset({
        x: pinchState.current.originX + (m.x - pinchState.current.startMid.x),
        y: pinchState.current.originY + (m.y - pinchState.current.startMid.y),
      });
      return;
    }

    // Single-finger pan while zoomed
    if (ptrs.current.size === 1 && isZoomed && panState.current) {
      const dx = e.clientX - panState.current.startX;
      const dy = e.clientY - panState.current.startY;
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

  function onPointerUp(e) {
    const prevSize = ptrs.current.size;
    ptrs.current.delete(e.pointerId);
    release(e.pointerId);
    const currSize = ptrs.current.size;

    // Pinch: 2 → 1 fingers — transition to single-finger pan
    if (prevSize >= 2 && currSize === 1) {
      pinchState.current = null;
      if (isZoomed) {
        const [, remaining] = [...ptrs.current.entries()][0];
        panState.current = {
          originX: panOffsetRef.current.x,
          originY: panOffsetRef.current.y,
          startX: remaining.x,
          startY: remaining.y,
          moved: false,
        };
      }
      return;
    }

    if (currSize > 0) return; // more fingers still down

    // All pointers up
    setDragging(false);

    // Pan ended
    if (panState.current) {
      panState.current = null;
      // suppressClick is already true if there was actual movement (pan)
      // If no movement (tap-while-zoomed), suppressClick is false → fall through to tap logic
      if (suppressClick.current) return;
    }

    // Pinch ended (shouldn't reach here normally, but just in case)
    if (suppressClick.current) return;

    // ── Tap / Swipe ──────────────────────────────────────────────────────────────
    const start = tapState.current;
    tapState.current = null;
    if (!start) return;

    const dx  = e.clientX - start.x;
    const dy  = e.clientY - start.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Determine if this was a tap (negligible movement)
    if (absDx < 20 && absDy < 20) {
      const now = Date.now();

      // Double-tap zoom toggle (touch/pen — avoid misfiring on fast mouse double-clicks)
      if ((e.pointerType === 'touch' || e.pointerType === 'pen') && now - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        suppressClick.current = true;
        onZoomChange(isZoomed ? 100 : 200);
        return;
      }
      lastTap.current = now;

      // Single tap: defer to click event so we use the correct final position.
      // We mark it as a pending tap so handleClick knows it came from pointer handling.
      pendingTap.current = true;
      tapPos.current = { x: e.clientX, y: e.clientY };
      return;
    }

    // Swipe: horizontal and exceeds threshold, only when not zoomed and gestures enabled
    if (!isZoomed && gesturesEnabled && absDx > SWIPE_THRESHOLD && absDx / absDy > (1 / SWIPE_MAX_ANGLE)) {
      suppressClick.current = true;
      if (dx < 0) rtl ? onPrev() : onNext();
      else        rtl ? onNext() : onPrev();
      return;
    }

    // Movement that was neither a clean tap nor a swipe — suppress stray click
    suppressClick.current = true;
  }

  function onPointerCancel(e) {
    ptrs.current.delete(e.pointerId);
    release(e.pointerId);
    if (ptrs.current.size === 0) {
      pinchState.current = panState.current = tapState.current = null;
      pendingTap.current = false;
      suppressClick.current = false;
      setDragging(false);
    }
  }

  // ── Click handler ──────────────────────────────────────────────────────────────
  // Always stop propagation. The outer reader div has no onClick — all interaction
  // is handled here. For taps, pendingTap.current was set in pointerup.

  function handleClick(e) {
    e.stopPropagation();

    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }

    if (pendingTap.current) {
      pendingTap.current = false;
      const pos = tapPos.current ?? { x: e.clientX, y: e.clientY };
      tapPos.current = null;
      if (!isZoomed) execTap(pos.x, pos.y);
      // Taps while zoomed do nothing (pan is already handled above)
      return;
    }

    // Pure mouse click (no preceding pointer events set pendingTap) — handle by position
    if (!isZoomed) execTap(e.clientX, e.clientY);
  }

  // ── Render ─────────────────────────────────────────────────────────────────────

  const page = pages[currentPage];
  if (!page) return null;

  const page2     = page2Index != null ? pages[page2Index] : null;
  const animClass = animateTransitions ? `page-anim-${animDir}` : '';
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={handleClick}
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
          />
          {page2 && (
            <img
              src={api.pageImageUrl(rightPage.id)}
              alt={rightAlt}
              className="reader-page-img"
              draggable={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}
