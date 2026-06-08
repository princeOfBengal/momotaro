import { useCallback, useEffect, useState } from 'react';
import {
  resolveInitialPageAnimation,
  clampAnimSpeed,
  resolveInitialPredictNextChapter,
} from './readerSettings';

// One piece of reader state mirrored to localStorage under `storageKey`,
// persisted as String(value) on every change (private-browsing safe). The
// initial value is resolved once by `initializer` (run lazily by useState),
// exactly as the old per-setting `useState(() => getItem(...))` blocks did —
// including the on-mount write of the default, which both surfaces already
// performed.
function usePersistentState(storageKey, initializer) {
  const [value, setValue] = useState(initializer);
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* private browsing — fine */ }
  }, [storageKey, value]);
  return [value, setValue];
}

// Single source of truth for every reader_* preference. Consumed by both
// Reader.jsx (which uses all of them, including the runtime-only zoom and
// brightness) and Settings → Reading (which uses the subset it surfaces). The
// keys, defaults, legacy migrations, and per-setting persistence are therefore
// defined in exactly one place; the two surfaces can no longer drift.
//
// The hook calls usePersistentState a fixed number of times in a fixed order,
// satisfying the Rules of Hooks — do not turn this into a dynamic loop.
export function useReaderSettings() {
  const [readingMode, setReadingMode]             = usePersistentState('reader_readingMode', () => localStorage.getItem('reader_readingMode') || 'rtl');
  const [zoom, setZoom]                           = usePersistentState('reader_zoom', () => Number(localStorage.getItem('reader_zoom')) || 100);
  const [pageAnimation, setPageAnimation]         = usePersistentState('reader_pageAnimation', () => resolveInitialPageAnimation(localStorage));
  const [pageAnimSpeed, setPageAnimSpeedRaw]      = usePersistentState('reader_pageAnimSpeed', () => clampAnimSpeed(Number(localStorage.getItem('reader_pageAnimSpeed')) || 1));
  const [showEdgeHints, setShowEdgeHints]         = usePersistentState('reader_edgeHints', () => localStorage.getItem('reader_edgeHints') === 'true');
  const [gesturesEnabled, setGesturesEnabled]     = usePersistentState('reader_gestures', () => localStorage.getItem('reader_gestures') !== 'false');
  const [alwaysFullscreen, setAlwaysFullscreen]   = usePersistentState('reader_alwaysFS', () => localStorage.getItem('reader_alwaysFS') === 'true');
  const [bgColor, setBgColor]                     = usePersistentState('reader_bgColor', () => localStorage.getItem('reader_bgColor') || 'black');
  const [grayscale, setGrayscale]                 = usePersistentState('reader_grayscale', () => localStorage.getItem('reader_grayscale') === 'true');
  const [scaleType, setScaleType]                 = usePersistentState('reader_scaleType', () => localStorage.getItem('reader_scaleType') || 'screen');
  const [pageLayout, setPageLayout]               = usePersistentState('reader_pageLayout', () => localStorage.getItem('reader_pageLayout') || 'single');
  const [readingOrientation, setReadingOrientation] = usePersistentState('reader_orientation', () => localStorage.getItem('reader_orientation') || 'ltr');
  const [brightness, setBrightness]               = usePersistentState('reader_brightness', () => Number(localStorage.getItem('reader_brightness')) || 100);
  const [prefetchPages, setPrefetchPages]         = usePersistentState('reader_prefetchPages', () => localStorage.getItem('reader_prefetchPages') !== 'false');
  const [fastChapterOpen, setFastChapterOpen]     = usePersistentState('reader_fastChapterOpen', () => localStorage.getItem('reader_fastChapterOpen') === 'true');
  const [predictNextChapter, setPredictNextChapter] = usePersistentState('reader_predictNextChapter', () => resolveInitialPredictNextChapter(localStorage));
  const [volumeButtonNav, setVolumeButtonNav]         = usePersistentState('reader_volumeButtonNav', () => localStorage.getItem('reader_volumeButtonNav') === 'true');
  const [volumeButtonReverse, setVolumeButtonReverse] = usePersistentState('reader_volumeButtonReverse', () => localStorage.getItem('reader_volumeButtonReverse') === 'true');

  // Animation speed is always clamped to [0.5, 2] on the way in, so neither
  // surface has to remember to clamp at the call site.
  const setPageAnimSpeed = useCallback((n) => setPageAnimSpeedRaw(clampAnimSpeed(Number(n))), [setPageAnimSpeedRaw]);

  // One-time cleanup of the legacy boolean key (resolveInitialPageAnimation
  // already handled the migration at read-time).
  useEffect(() => {
    if (localStorage.getItem('reader_animTrans') !== null) {
      try { localStorage.removeItem('reader_animTrans'); } catch { /* ignore */ }
    }
  }, []);

  return {
    readingMode, setReadingMode,
    zoom, setZoom,
    pageAnimation, setPageAnimation,
    pageAnimSpeed, setPageAnimSpeed,
    showEdgeHints, setShowEdgeHints,
    gesturesEnabled, setGesturesEnabled,
    alwaysFullscreen, setAlwaysFullscreen,
    bgColor, setBgColor,
    grayscale, setGrayscale,
    scaleType, setScaleType,
    pageLayout, setPageLayout,
    readingOrientation, setReadingOrientation,
    brightness, setBrightness,
    prefetchPages, setPrefetchPages,
    fastChapterOpen, setFastChapterOpen,
    predictNextChapter, setPredictNextChapter,
    volumeButtonNav, setVolumeButtonNav,
    volumeButtonReverse, setVolumeButtonReverse,
  };
}
