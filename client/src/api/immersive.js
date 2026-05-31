import { registerPlugin } from '@capacitor/core';

// Native bridge for the in-tree ImmersiveMode plugin (see
// client/android/app/src/main/java/dev/momotaro/app/ImmersiveModePlugin.java).
// `registerPlugin` is no-op on web — the returned proxy throws
// UNIMPLEMENTED if any method is called outside the Capacitor shell, which
// is why the helpers below early-return on `!isNativePlatform()`.
const ImmersiveMode = registerPlugin('ImmersiveMode');

export function isNativeShell() {
  if (typeof window === 'undefined') return false;
  // Capacitor's signal (Android APK and, in theory, the Capacitor Electron
  // platform). Trustworthy on Android.
  if (window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform()) {
    return true;
  }
  // Electron-only fallback: the preload always exposes window.MomotaroElectron.
  // Detect the desktop shell directly so the fullscreen button (and any other
  // native-only path) works even if Capacitor's isNativePlatform() is wrong
  // on this build (it has been flaky in @capacitor-community/electron 5).
  if (window.MomotaroElectron && window.MomotaroElectron.ImmersiveMode) return true;
  return false;
}

// On the Electron desktop shell the in-tree plugin is exposed by the preload at
// window.MomotaroElectron.ImmersiveMode (the Capacitor Electron platform
// doesn't route bare registerPlugin() calls to in-tree plugins). On Android the
// registerPlugin() proxy reaches the native plugin via the bridge directly.
function electronBridge() {
  return (typeof window !== 'undefined'
      && window.MomotaroElectron
      && window.MomotaroElectron.ImmersiveMode) || null;
}

/**
 * Hide both the status bar and the navigation bar. Swipe from the screen
 * edge transiently reveals them, then they auto-hide — the standard
 * "sticky immersive" UX. On desktop this fullscreens the window + hides the
 * menu bar.
 */
export async function enableImmersive() {
  if (!isNativeShell()) return;
  const eb = electronBridge();
  try { await (eb ? eb.enable() : ImmersiveMode.enable()); } catch { /* best-effort */ }
}

/**
 * Restore the system bars. Call on unmount of any view that called
 * enableImmersive() so the rest of the app shows them normally.
 */
export async function disableImmersive() {
  if (!isNativeShell()) return;
  const eb = electronBridge();
  try { await (eb ? eb.disable() : ImmersiveMode.disable()); } catch { /* best-effort */ }
}
