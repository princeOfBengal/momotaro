// Shared platform-detection / external-URL helpers used by the Android and
// Linux sections. Both peek at globals injected by the Capacitor wrapper or
// the Electron preload bridge; lifted out so the per-platform sections stay
// concerned with their own UI.

// Capacitor platform string ('android' | 'ios' | 'electron' | 'web'), or null
// off the native shell. Used to scope the per-platform update-check cards so the
// Android card only shows in the APK and the Linux card only in the desktop app.
export function nativePlatform() {
  try {
    if (typeof window !== 'undefined' && window.Capacitor
        && typeof window.Capacitor.getPlatform === 'function') {
      return window.Capacitor.getPlatform();
    }
  } catch { /* ignore */ }
  return null;
}

// Open a URL in the OS browser. In the Electron desktop shell, navigation is
// locked to the app's custom scheme, so a plain <a href>/target=_blank is
// blocked — route through the preload bridge. In the PWA, fall back to a normal
// new-tab open. (Plain download anchors are used directly where a file download
// is wanted in the browser.)
export function openExternalUrl(url) {
  const bridge = (typeof window !== 'undefined'
      && window.MomotaroElectron
      && typeof window.MomotaroElectron.openExternal === 'function')
    ? window.MomotaroElectron.openExternal
    : null;
  if (bridge) { bridge(url); return; }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}
