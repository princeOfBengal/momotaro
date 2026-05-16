import { registerPlugin } from '@capacitor/core';

// Native bridge for the in-tree ImmersiveMode plugin (see
// client/android/app/src/main/java/dev/momotaro/app/ImmersiveModePlugin.java).
// `registerPlugin` is no-op on web — the returned proxy throws
// UNIMPLEMENTED if any method is called outside the Capacitor shell, which
// is why the helpers below early-return on `!isNativePlatform()`.
const ImmersiveMode = registerPlugin('ImmersiveMode');

function isNativeShell() {
  return typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
}

/**
 * Hide both the status bar and the navigation bar. Swipe from the screen
 * edge transiently reveals them, then they auto-hide — the standard
 * "sticky immersive" UX.
 */
export async function enableImmersive() {
  if (!isNativeShell()) return;
  try { await ImmersiveMode.enable(); } catch { /* best-effort */ }
}

/**
 * Restore the system bars. Call on unmount of any view that called
 * enableImmersive() so the rest of the app shows them normally.
 */
export async function disableImmersive() {
  if (!isNativeShell()) return;
  try { await ImmersiveMode.disable(); } catch { /* best-effort */ }
}
