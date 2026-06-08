import { Capacitor, registerPlugin } from '@capacitor/core';

// Native bridge for the in-tree VolumeButtons plugin (see
// client/android/app/src/main/java/dev/momotaro/app/VolumeButtonsPlugin.java).
// `registerPlugin` is a no-op proxy on web; every helper below early-returns
// off Android so the PWA and the Linux/Electron AppImage never touch it. This
// feature is Android-only by design — the plugin only exists in the Android
// Gradle project and is not wired into the Electron preload.
const VolumeButtons = registerPlugin('VolumeButtons');

// Android-only. `isNativeShell()` from immersive.js is true for Electron too,
// so it is deliberately NOT used here — we need the platform to be android
// specifically so the Linux AppImage never enables volume-button navigation.
export function isAndroid() {
  if (typeof window === 'undefined') return false;
  return !!(window.Capacitor
    && typeof Capacitor.getPlatform === 'function'
    && Capacitor.getPlatform() === 'android');
}

/** Tell the native side to start intercepting volume keys. No-op off Android. */
export async function enableVolumeButtons() {
  if (!isAndroid()) return;
  try { await VolumeButtons.enable(); } catch { /* best-effort */ }
}

/** Tell the native side to stop intercepting volume keys. No-op off Android. */
export async function disableVolumeButtons() {
  if (!isAndroid()) return;
  try { await VolumeButtons.disable(); } catch { /* best-effort */ }
}

/**
 * Subscribe to volume-button presses. `handler` receives 'up' | 'down'.
 * Returns a function that removes the listener. No-op (returns a noop
 * remover) off Android.
 */
export function addVolumeButtonListener(handler) {
  if (!isAndroid()) return () => {};
  const handlePromise = VolumeButtons.addListener('volumeButton', (ev) => {
    handler(ev && ev.direction);
  });
  return () => {
    // addListener resolves to a handle with remove(); guard for the proxy.
    Promise.resolve(handlePromise)
      .then((h) => h && typeof h.remove === 'function' && h.remove())
      .catch(() => {});
  };
}
