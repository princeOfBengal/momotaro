import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppActive } from '../hooks/useAppActive';
import './ArtGalleryRibbon.css';

// User pause preference is shared across every ribbon (the Home strip and the
// per-series strips on /art-gallery) and persisted so a motion-sensitive user
// can stop it once and have it stick. We keep it in localStorage + an in-tab
// custom event so toggling any one ribbon syncs the rest immediately.
const PAUSE_KEY = 'momotaro_gallery_paused';
const PAUSE_EVENT = 'momotaro:gallery-paused';

function readPausedPref() {
  try { return localStorage.getItem(PAUSE_KEY) === '1'; } catch { return false; }
}
function writePausedPref(v) {
  try { localStorage.setItem(PAUSE_KEY, v ? '1' : '0'); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(PAUSE_EVENT, { detail: v })); } catch { /* no-op */ }
}

// Auto-rotating horizontal ribbon for the Art Gallery section.
//
// Implemented with a single CSS keyframe animation on a duplicated item list
// (`items ++ items`). The animation translates by exactly 50 % of the track
// width — i.e. one full pass over the original set — so when the animation
// loops back to 0 %, the content under the viewport is identical and the
// user sees a seamless infinite scroll without any JS per-frame work.
//
// Hover (mouse) and focus-within (keyboard) pause the animation through CSS.
// Touch devices pause via an onTouchStart handler and resume on touchend /
// touchcancel, so a tap-to-read interaction doesn't scroll the tile out
// from under the user. An IntersectionObserver short-circuits the animation
// when the ribbon is scrolled off-screen.
//
// IntersectionObserver only covers *in-page* off-screen — it does NOT fire when
// the whole app is backgrounded (the element still intersects the layout
// viewport). That gap mattered: on the Android WebView build, leaving this
// infinite animation + its promoted GPU layer live in the background let the OS
// reclaim the renderer, so returning to Home showed a blank grey screen. We now
// also pause via `useAppActive` (Page Visibility + Capacitor App appStateChange)
// so backgrounding freezes the compositor and releases the layer (see the CSS,
// which drops `will-change` while `.is-paused`).
//
// A header Pause/Resume button gives explicit user control (and satisfies
// WCAG 2.2.2 "Pause, Stop, Hide" for auto-moving content). We deliberately do
// NOT auto-freeze under `prefers-reduced-motion`: that media query reports
// `reduce` spuriously on the PWA (Android battery-saver / "remove animations")
// and on the Linux AppImage (Chromium reads GTK's `gtk-enable-animations`,
// which lightweight/GPU-disabled desktops leave off), which previously froze
// the ribbon solid on exactly those platforms. The explicit, persisted control
// replaces that blunt kill-switch.

// Props:
//   items     — gallery item objects (see /api/home or /api/gallery/all)
//   title     — section heading
//   fullSize  — when true, tiles use the page's natural aspect ratio
//               (`object-fit: contain`, fixed height + auto width). Used by
//               the Art Gallery page so landscape pages aren't cropped.
//   titleHref — optional Link target for the heading
export default function ArtGalleryRibbon({ items, title = 'Art Gallery', fullSize = false, titleHref = null }) {
  const rootRef = useRef(null);
  const [inView, setInView]     = useState(false);
  const [touching, setTouching] = useState(false);
  const [userPaused, setUserPaused] = useState(readPausedPref);
  // False while the app is backgrounded or the document is hidden — freezes the
  // animation so the WebView isn't holding a live GPU layer in the background.
  const appActive = useAppActive();

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true); // fall back to always-animating
      return;
    }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) setInView(e.isIntersecting);
    }, { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Keep every ribbon's button in sync when one of them toggles pause. The
  // custom event covers sibling ribbons in this document; the `storage` event
  // (fires only in *other* tabs/PWA windows, never the originating one) syncs
  // across windows without double-firing the optimistic update.
  useEffect(() => {
    const onSync = e => setUserPaused(Boolean(e.detail));
    const onStorage = e => { if (e.key === PAUSE_KEY) setUserPaused(e.newValue === '1'); };
    window.addEventListener(PAUSE_EVENT, onSync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PAUSE_EVENT, onSync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  if (!items || items.length === 0) return null;

  // Pick a duration proportional to item count so the per-tile dwell time is
  // constant regardless of how many bookmarks the user has.
  const durationSeconds = Math.max(20, items.length * 4);

  // Pause when: the user paused it, touch-dragging, scrolled off-screen, or the
  // app is backgrounded/hidden (don't burn GPU on an off-screen keyframe and
  // don't strand a live GPU layer in the background). Hover/focus pausing is
  // handled in CSS.
  const paused = userPaused || touching || !inView || !appActive;

  const togglePaused = () => {
    const next = !userPaused;
    setUserPaused(next);     // optimistic local update
    writePausedPref(next);   // persist + broadcast to sibling ribbons
  };

  return (
    <section
      ref={rootRef}
      className={`gallery-ribbon${paused ? ' is-paused' : ''}${fullSize ? ' fullsize' : ''}`}
    >
      <header className="gallery-ribbon-head">
        {titleHref
          ? <Link to={titleHref} className="ribbon-title gallery-ribbon-title-link">{title}</Link>
          : <h2 className="ribbon-title">{title}</h2>}
        <button
          type="button"
          className="gallery-ribbon-toggle"
          onClick={togglePaused}
          // Neutral name + `aria-pressed` carries the paused state, so the
          // announced label stays accurate in both states ("Toggle art gallery
          // rotation, pressed/not pressed") rather than naming one action while
          // doing the other. `title` stays dynamic for the sighted hover tooltip.
          aria-pressed={userPaused}
          aria-label="Toggle art gallery rotation"
          title={userPaused ? 'Resume rotation' : 'Pause rotation'}
        >
          {userPaused ? (
            // Play / resume triangle
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M6 4.5v11a1 1 0 0 0 1.54.84l8.5-5.5a1 1 0 0 0 0-1.68l-8.5-5.5A1 1 0 0 0 6 4.5z" />
            </svg>
          ) : (
            // Pause bars
            <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M6 3.5h3v13H6zM11 3.5h3v13h-3z" />
            </svg>
          )}
        </button>
      </header>
      <div
        className="gallery-ribbon-viewport"
        onTouchStart={() => setTouching(true)}
        onTouchEnd={() => setTouching(false)}
        onTouchCancel={() => setTouching(false)}
      >
        <div
          className="gallery-ribbon-track"
          style={{ animationDuration: `${durationSeconds}s` }}
        >
          {/* Duplicate the list so the keyframe loop can seamlessly wrap. */}
          {[...items, ...items].map((g, idx) => {
            // In fullSize mode each tile sizes itself to the page's natural
            // aspect ratio so landscape spreads aren't cropped. Fall back to
            // a 2:3 portrait when dimensions aren't known yet.
            const tileStyle = fullSize
              ? { aspectRatio: `${g.width || 2} / ${g.height || 3}` }
              : undefined;
            return (
              <Link
                key={`${g.id}-${idx}`}
                to={`/read/${g.chapter_id}?page=${g.page_index}&mangaId=${g.manga_id}`}
                className="gallery-ribbon-tile"
                style={tileStyle}
                aria-label={`Open page ${g.page_index + 1} of ${g.manga_title}`}
                // Duplicated items shouldn't all be Tab-stops — only the first
                // copy of each entry is keyboard-reachable.
                tabIndex={idx < items.length ? 0 : -1}
              >
                <img
                  src={g.page_image_url}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
                <span className="gallery-ribbon-tile-meta">
                  <span className="gallery-ribbon-tile-manga">{g.manga_title}</span>
                  <span className="gallery-ribbon-tile-page">p.{g.page_index + 1}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
