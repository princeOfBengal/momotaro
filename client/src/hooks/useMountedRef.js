import { useEffect, useRef } from 'react';

// Returns a ref whose `.current` is true while the component is mounted and
// false after unmount. Use it to gate deferred state updates (setTimeout
// callbacks, post-await branches) so they don't fire on an unmounted
// component — the same guard `useActionStatus` bakes in, extracted for the
// handful of inline timers that don't go through that hook.
//
//   const mounted = useMountedRef();
//   setTimeout(() => { if (mounted.current) setFlash(null); }, 1800);
export function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}
