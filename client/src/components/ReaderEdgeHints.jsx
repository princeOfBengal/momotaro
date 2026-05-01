import React, { useEffect, useState } from 'react';
import './ReaderEdgeHints.css';

const FIRST_RUN_DURATION_MS = 1800;

// Subtle chevron affordances at the left/right tap zones in the reader.
// `pointer-events: none` on the wrapper means the existing gesture system in
// ReaderPaged keeps exclusive control of every touch, swipe, and tap — these
// are purely visual.
//
// `mode`:
//   - 'first-run'  — shows a brief two-pulse animation on first reader open,
//                    then writes `reader_hintsSeen` and disappears for good.
//   - 'persistent' — shows faint chevrons continuously, fading out for a beat
//                    after every tap (driven by `suppressed`).
//   - 'off'        — render nothing.
//
// The arrow direction is flipped in RTL so the chevrons point at the side
// that advances reading.
export default function ReaderEdgeHints({ mode, rtl, suppressed }) {
  const [firstRunDone, setFirstRunDone] = useState(false);

  useEffect(() => {
    if (mode !== 'first-run') return;
    const t = setTimeout(() => {
      try { localStorage.setItem('reader_hintsSeen', 'true'); } catch (_) {}
      setFirstRunDone(true);
    }, FIRST_RUN_DURATION_MS);
    return () => clearTimeout(t);
  }, [mode]);

  if (mode === 'off') return null;
  if (mode === 'first-run' && firstRunDone) return null;

  const className = mode === 'first-run' ? 'edge-hint-pulse' : 'edge-hint-persistent';
  // In RTL, the side that goes to the next page is on the left. Swapping the
  // chevrons keeps each arrow pointing at the direction it sends the reader.
  const leftGlyph  = rtl ? '›' : '‹';
  const rightGlyph = rtl ? '‹' : '›';

  return (
    <div className={`reader-edge-hints ${className}${suppressed ? ' suppressed' : ''}`} aria-hidden="true">
      <div className="edge-hint edge-hint-left">{leftGlyph}</div>
      <div className="edge-hint edge-hint-right">{rightGlyph}</div>
    </div>
  );
}
