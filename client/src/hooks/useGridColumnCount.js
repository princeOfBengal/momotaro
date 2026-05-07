import { useLayoutEffect, useState } from 'react';

const FALLBACK_MIN_COL = 160;
const FALLBACK_GAP = 20;
const RESIZE_DEBOUNCE_MS = 50;

function readNumberVar(el, name, fallback) {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Derives the column count for an `auto-fill, minmax(...)` CSS grid from a
// single source of truth: CSS variables `--col-min` and `--col-gap` set on the
// scroll container per breakpoint. The formula matches the one `auto-fill`
// uses internally:
//   cols = floor((width + gap) / (minCol + gap))
//
// Returns `{ cols, gap, minCol, containerWidth }`. `cols` is at least 1 once
// width is known. Callers should treat width === 0 as "not measured yet" and
// avoid laying out off it.
//
// Resize is debounced 50 ms — iOS Safari fires storms of resize events during
// the keyboard-driven viewport shrink, and recomputing per-event would cause
// the virtualizer to thrash measure() during that window.
export function useGridColumnCount(ref) {
  const [state, setState] = useState({
    cols: 1,
    gap: FALLBACK_GAP,
    minCol: FALLBACK_MIN_COL,
    containerWidth: 0,
  });

  // useLayoutEffect runs synchronously after the DOM is committed but before
  // paint, so the initial measurement applies before the first frame and the
  // virtualizer renders with the correct column count from the start.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let timer = null;

    const measure = () => {
      const minCol = readNumberVar(el, '--col-min', FALLBACK_MIN_COL);
      const gap = readNumberVar(el, '--col-gap', FALLBACK_GAP);
      const width = el.clientWidth;
      if (width <= 0) return;
      const cols = Math.max(1, Math.floor((width + gap) / (minCol + gap)));
      setState(prev => {
        if (
          prev.cols === cols
          && prev.gap === gap
          && prev.minCol === minCol
          && prev.containerWidth === width
        ) return prev;
        return { cols, gap, minCol, containerWidth: width };
      });
    };

    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [ref]);

  return state;
}
