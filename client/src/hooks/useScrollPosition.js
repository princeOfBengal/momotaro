import { useEffect, useRef } from 'react';

const STORAGE_PREFIX = 'library-scroll:';
const SCROLL_WRITE_THROTTLE_MS = 100;

// Persists and restores `scrollTop` for a non-window scroll container across
// navigations. Keyed by a caller-supplied string so that:
//   - same key (e.g. user navigated to detail and back) → restore previous
//     scroll position;
//   - different key (e.g. user changed sort/library/search) → reset to top.
//
// `ready` gates the restore until the caller has populated enough content for
// the saved scrollTop to be meaningful. Without it, an early restore against
// an empty list silently clamps to 0 because `scrollHeight` is still small,
// and the user lands at the top instead of where they were.
//
// Storage failures (private mode, quota) are swallowed silently — scroll
// restoration is a nice-to-have, not a correctness requirement.
export function useScrollPosition(scrollElementRef, key, ready) {
  const restoredKeyRef = useRef(null);
  const lastWriteRef = useRef(0);

  useEffect(() => {
    if (!ready) return;
    if (restoredKeyRef.current === key) return;
    const el = scrollElementRef.current;
    if (!el) return;

    let stored = null;
    try {
      stored = sessionStorage.getItem(STORAGE_PREFIX + key);
    } catch {}

    if (stored != null) {
      const top = parseInt(stored, 10);
      if (Number.isFinite(top) && top > 0) {
        // Two rAFs: first lets the virtualizer mount + report total size,
        // second runs after the layout pass that picks that size up.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const node = scrollElementRef.current;
            if (node) node.scrollTop = top;
          });
        });
      } else {
        el.scrollTop = 0;
      }
    } else {
      el.scrollTop = 0;
    }
    restoredKeyRef.current = key;
  }, [key, ready, scrollElementRef]);

  useEffect(() => {
    const el = scrollElementRef.current;
    if (!el) return;

    const onScroll = () => {
      const now = Date.now();
      if (now - lastWriteRef.current < SCROLL_WRITE_THROTTLE_MS) return;
      lastWriteRef.current = now;
      try {
        sessionStorage.setItem(STORAGE_PREFIX + key, String(el.scrollTop));
      } catch {}
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [key, scrollElementRef]);
}
