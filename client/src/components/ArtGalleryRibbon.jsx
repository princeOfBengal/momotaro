import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './ArtGalleryRibbon.css';

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
// entirely when the ribbon is not on-screen, keeping a background tab's GPU
// cost at zero.

export default function ArtGalleryRibbon({ items, title = 'Art Gallery' }) {
  const rootRef = useRef(null);
  const [inView, setInView]     = useState(false);
  const [touching, setTouching] = useState(false);

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

  if (!items || items.length === 0) return null;

  // Pick a duration proportional to item count so the per-tile dwell time is
  // constant regardless of how many bookmarks the user has.
  const durationSeconds = Math.max(20, items.length * 4);

  // Pause when: touch-dragging, or not in view (don't burn GPU on an
  // off-screen keyframe). Hover/focus pausing is handled in CSS.
  const paused = touching || !inView;

  return (
    <section
      ref={rootRef}
      className={`gallery-ribbon${paused ? ' is-paused' : ''}`}
    >
      <header className="gallery-ribbon-head">
        <h2 className="ribbon-title">{title}</h2>
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
          {[...items, ...items].map((g, idx) => (
            <Link
              key={`${g.id}-${idx}`}
              to={`/read/${g.chapter_id}?page=${g.page_index}&mangaId=${g.manga_id}`}
              className="gallery-ribbon-tile"
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
          ))}
        </div>
      </div>
    </section>
  );
}
