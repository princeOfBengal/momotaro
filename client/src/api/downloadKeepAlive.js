// JS bridge for the in-tree DownloadKeepAlive plugin. The plugin promotes
// the app process to "foreground" via a persistent notification while the
// queue is running, so Android doesn't kill the WebView under Doze or
// memory pressure when the user backgrounds the app.
//
// Outside the Capacitor native shell (PWA, regular browser) every method
// is a no-op — the foreground concept is moot there.
//
// The caller doesn't need to track state; the plugin is fully idempotent.
// `start({ title, text })` is safe to call repeatedly with updated text;
// `stop()` is safe to call when nothing is running.

import { registerPlugin } from '@capacitor/core';

// On the Electron desktop shell the in-tree plugin is exposed by the preload at
// window.MomotaroElectron.DownloadKeepAlive (the Capacitor Electron platform
// doesn't route bare registerPlugin() calls to in-tree plugins). On Android the
// registerPlugin() proxy reaches the native plugin directly. Same method names,
// so every call site below is unchanged.
const KeepAlive =
  (typeof window !== 'undefined'
    && window.MomotaroElectron
    && window.MomotaroElectron.DownloadKeepAlive)
  || registerPlugin('DownloadKeepAlive');

function isNativeShell() {
  return typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
}

// True when the native shell is available — used by the downloader to
// decide whether to bother building plan-state JSON.
export function isAvailable() {
  return isNativeShell();
}

// Request the runtime POST_NOTIFICATIONS grant once per session. On
// Android 12 and below this is a compile-time perm so the call is a
// no-op resolution. On Android 13+ this is the only path that ever
// shows the system prompt — without it the notification silently never
// appears (the foreground promotion still works, but the user has no
// visibility into what the app is doing).
//
// We don't gate the download on the result: even denied, the FGS keeps
// the process alive.
let _permissionRequested = false;
async function ensureNotificationPermission() {
  if (_permissionRequested) return;
  _permissionRequested = true;
  try {
    // The @CapacitorPlugin annotation exposes a `requestPermissions` that
    // maps the `notifications` alias to the POST_NOTIFICATIONS string.
    await KeepAlive.requestPermissions({ permissions: ['notifications'] });
  } catch { /* user denied or older Android — fine, FGS still works */ }
}

export async function keepAliveStart({ title, text } = {}) {
  if (!isNativeShell()) return;
  // Fire-and-forget — we don't want to delay the download for the
  // permission prompt; the FGS will start before the user even sees it.
  ensureNotificationPermission();
  try {
    await KeepAlive.start({
      title: title || 'Momotaro',
      text:  text  || 'Downloading chapters…',
    });
  } catch { /* best-effort */ }
}

export async function keepAliveUpdate({ text } = {}) {
  if (!isNativeShell()) return;
  try { await KeepAlive.update({ text: text || 'Downloading chapters…' }); }
  catch { /* best-effort */ }
}

export async function keepAliveStop() {
  if (!isNativeShell()) return;
  try { await KeepAlive.stop(); }
  catch { /* best-effort */ }
}

// Hand the current queue state to the native service so it can take over
// downloads if the user swipes the app away from recents. Called by the
// downloader after every queue mutation. No-op on PWA.
//
// `plan` shape:
//   {
//     serverUrl:         string,           // e.g. "https://example.com"
//     clientToken:       string|null,      // bearer token for /api/* + ?t=
//     offlineRootSubdir: string,           // e.g. "MomotaroOffline"
//     encryptionActive:  boolean,          // gate — true means Java skips
//     jobs: [{
//       jobId:            number,
//       mangaId:          number,
//       chapterId:        number,
//       extDirSubpath:    string,          // "5/chapters/100" — Java writes pages here
//     }, ...]
//   }
//
// Java stores the plan in service state, ready for an onTaskRemoved
// trigger. If `encryptionActive` is true, Java refuses to act on the
// plan because we don't ship the AES key off-process (see
// offlineCrypto.js docstring — keys are deliberately not persisted).
export async function setPlanState(plan) {
  if (!isNativeShell()) return;
  try { await KeepAlive.setPlanState(plan || {}); }
  catch { /* best-effort */ }
}

// Read everything the Java side completed (or failed) since the last call,
// then clear it from the service. Returns the same shape the Java side
// emits — an array of `{ jobId, status, error?, completedPages? }`.
// No-op + returns empty array on PWA.
export async function consumeProgressReport() {
  if (!isNativeShell()) return { reports: [] };
  try {
    const r = await KeepAlive.consumeProgressReport();
    return r || { reports: [] };
  } catch {
    return { reports: [] };
  }
}
