import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import './Ribbon.css';

// A horizontal-scrolling ribbon. Native scroll drives everything (touch
// momentum on mobile, trackpad swipe on desktop, wheel on mouse) — the arrow
// buttons are a mouse-user convenience layered on top. No JS animation
// loops, no interval polling: the browser does the work.
//
// Props:
//   title        — heading rendered above the ribbon
//   actions      — optional node rendered at the right of the heading
//   viewAllTo    — optional react-router target. When set, a "See all" link
//                  is rendered to the left of `actions`, navigating to /library
//                  with the matching filter pre-applied via location.state
//   emptyMessage — string shown when `children` is empty; ribbon hidden
//                  entirely when both are missing
//   children     — the ribbon items (caller decides the tile markup + width)
export default function Ribbon({ title, actions, viewAllTo, emptyMessage, children, className = '' }) {
  const trackRef = useRef(null);
  const [canScrollLeft,  setCanScrollLeft]  = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // 1 px tolerance to avoid flicker from sub-pixel scroll positions.
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = trackRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScrollState, { passive: true });
    // Recompute when the window resizes (tiles re-flow, content may shrink
    // below the viewport width and the right arrow should vanish).
    window.addEventListener('resize', updateScrollState);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [updateScrollState, children]);

  function scrollByDir(dir) {
    const el = trackRef.current;
    if (!el) return;
    // Scroll by ~80% of the visible width so a couple of tiles stay on-screen
    // for orientation across a page turn.
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  }

  const hasItems = React.Children.count(children) > 0;

  if (!hasItems && !emptyMessage) return null;

  return (
    <section className={`ribbon ${className}`}>
      <header className="ribbon-head">
        <h2 className="ribbon-title">{title}</h2>
        <div className="ribbon-head-right">
          {viewAllTo && hasItems && (
            <Link
              to={typeof viewAllTo === 'string' ? viewAllTo : viewAllTo.pathname}
              state={typeof viewAllTo === 'object' ? viewAllTo.state : undefined}
              className="ribbon-view-all"
            >
              See all
            </Link>
          )}
          {actions}
          {hasItems && (
            <div className="ribbon-arrows" aria-hidden="true">
              <button
                type="button"
                className="ribbon-arrow"
                onClick={() => scrollByDir(-1)}
                disabled={!canScrollLeft}
                aria-label={`Scroll ${title} left`}
                tabIndex={-1}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                  <path fillRule="evenodd" d="M12.707 15.707a1 1 0 01-1.414 0L5.586 10l5.707-5.707a1 1 0 111.414 1.414L8.414 10l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" />
                </svg>
              </button>
              <button
                type="button"
                className="ribbon-arrow"
                onClick={() => scrollByDir(1)}
                disabled={!canScrollRight}
                aria-label={`Scroll ${title} right`}
                tabIndex={-1}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
                  <path fillRule="evenodd" d="M7.293 4.293a1 1 0 011.414 0L14.414 10l-5.707 5.707a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {hasItems ? (
        <div className="ribbon-track" ref={trackRef} role="list">
          {children}
        </div>
      ) : (
        <p className="ribbon-empty">{emptyMessage}</p>
      )}
    </section>
  );
}
