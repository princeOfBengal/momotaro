// Reference-counted body-scroll lock shared by every dialog surface
// (DialogProvider, AdminUnlockDialog, RequireAdminAccess). Each component
// calls `acquire()` when its modal opens and `release()` (the returned
// function) when it closes. The lock is only released back to the page's
// original `overflow` value once the last holder lets go — without this
// counter, two stacked modals racing their cleanup hooks could leave the
// page scroll-locked even after every dialog had been dismissed.

let _count = 0;
let _stash = null;

export function acquireScrollLock() {
  if (typeof document === 'undefined') return () => {};
  if (_count === 0) {
    _stash = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  _count++;
  // Each acquire returns its own release closure so callers can't
  // accidentally release more times than they acquired (the closure
  // becomes a no-op after the first run).
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    _count = Math.max(0, _count - 1);
    if (_count === 0) {
      document.body.style.overflow = _stash ?? '';
      _stash = null;
    }
  };
}
