import { useCallback, useEffect, useRef, useState } from 'react';

// Drives the idle → loading → done|error → idle(after resetMs) machine shared
// by the reader's one-shot action buttons (set thumbnail, toggle gallery,
// download page). `run(fn)` awaits the async action and flips status; the
// caller renders labels off `status` and disables the button while loading.
//
// All state updates after the await are guarded by a mounted ref, and the
// reset timer is cleared on unmount — so leaving the reader mid-action or
// within resetMs of one never sets state on an unmounted component (the
// previous inline handlers had that latent warning on both paths).
export function useActionStatus(resetMs = 2000) {
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const timer = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback(async (fn) => {
    setStatus('loading');
    let next;
    try {
      await fn();
      next = 'done';
    } catch {
      next = 'error';
    }
    if (!mounted.current) return; // component left during the await — drop the update
    setStatus(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), resetMs);
  }, [resetMs]);

  return { status, run };
}
