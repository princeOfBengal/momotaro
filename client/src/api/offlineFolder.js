// JS-side bridge for the OfflineFolder Capacitor plugin. The plugin owns
// every interaction with the Storage Access Framework tree the user picks
// via the system document picker — JS never sees a raw `content://` URI
// because Capacitor's WebView can't load them; instead we go through
// `prepareFileForWebView` which copies the file into app-private cache
// and returns a `file://` URL that `Capacitor.convertFileSrc` can wrap.
//
// Outside the native shell every method either no-ops or throws a typed
// `OfflineFolderUnavailableError`, mirroring the contract the rest of
// the offline subsystem already expects from `offlineStorage.js`.

import { registerPlugin, Capacitor } from '@capacitor/core';

// On the Electron desktop shell the in-tree plugin is exposed by the preload at
// window.MomotaroElectron.OfflineFolder (the Capacitor Electron platform
// doesn't route bare registerPlugin() calls to in-tree plugins). On Android the
// registerPlugin() proxy reaches the native plugin via the bridge directly. The
// bridge object has the same method names, so every call site below is
// unchanged. Evaluated once at module load — the preload runs before any
// renderer script, so window.MomotaroElectron is already present on electron.
const OfflineFolder =
  (typeof window !== 'undefined'
    && window.MomotaroElectron
    && window.MomotaroElectron.OfflineFolder)
  || registerPlugin('OfflineFolder');

export class OfflineFolderUnavailableError extends Error {
  constructor(msg = 'Offline folder is only available in the Android app') {
    super(msg);
    this.name = 'OfflineFolderUnavailableError';
  }
}

function isNativeShell() {
  return typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
}

function notNative() {
  throw new OfflineFolderUnavailableError();
}

// ── Configuration ──────────────────────────────────────────────────────────

// `{ configured: boolean, treeUri: string|null, displayName: string|null }`.
// On a non-native shell returns `configured: false` so the rest of the
// JS stack can treat it the same as "user hasn't picked yet."
export async function getFolderStatus() {
  if (!isNativeShell()) return { configured: false, treeUri: null, displayName: null };
  try { return await OfflineFolder.getStatus(); }
  catch { return { configured: false, treeUri: null, displayName: null }; }
}

// Launches the SAF document-tree picker. Returns the same shape as
// `getFolderStatus()`. When the user cancels, the response carries
// `configured: false, cancelled: true` so the UI can distinguish a
// cancel from a hard failure.
export async function pickFolder() {
  if (!isNativeShell()) notNative();
  return OfflineFolder.pickFolder();
}

// Releases the persisted URI permission and forgets the saved tree URI.
// Doesn't delete anything on disk — the user keeps whatever files they
// previously downloaded.
export async function clearFolder() {
  if (!isNativeShell()) notNative();
  return OfflineFolder.clearFolder();
}

// ── File operations (relative paths under the picked tree) ─────────────────

export async function ensureDir(path) {
  if (!isNativeShell()) notNative();
  return OfflineFolder.ensureDir({ path });
}

export async function writeBytes(path, bytes) {
  if (!isNativeShell()) notNative();
  const b64 = await toBase64(bytes);
  await OfflineFolder.writeFile({ path, data: b64 });
}

export async function writeText(path, text) {
  if (!isNativeShell()) notNative();
  const b64 = btoa(unescape(encodeURIComponent(text)));
  await OfflineFolder.writeFile({ path, data: b64 });
}

export async function readBytes(path) {
  if (!isNativeShell()) notNative();
  const r = await OfflineFolder.readFile({ path });
  return base64ToBytes(r.data || '');
}

export async function readText(path) {
  if (!isNativeShell()) notNative();
  const r = await OfflineFolder.readFile({ path });
  return decodeURIComponent(escape(atob(r.data || '')));
}

export async function exists(path) {
  if (!isNativeShell()) return false;
  try {
    const r = await OfflineFolder.exists({ path });
    return !!(r && r.exists);
  } catch { return false; }
}

// Enumerate the immediate children of a directory under the tree URI.
// Returns `[{ name, isDirectory }, ...]`. Missing directory → `[]`
// (callers treat absence and empty identically). Used by the filesystem-
// scan path in offlineApi.js to rebuild chapter state from disk when IDB
// is empty / stale.
export async function listFiles(path) {
  if (!isNativeShell()) return [];
  try {
    const r = await OfflineFolder.listFiles({ path });
    return Array.isArray(r?.entries) ? r.entries : [];
  } catch { return []; }
}

export async function removePath(path, { recursive = false } = {}) {
  if (!isNativeShell()) notNative();
  await OfflineFolder.deletePath({ path, recursive });
}

// Resolves a path under the picked tree to a URL the WebView can load
// via `<img src>`. Internally the Java plugin copies the SAF content
// into app-private cache and returns a `file://` URL we then run
// through `Capacitor.convertFileSrc` for the loopback shim.
export async function srcUrl(path) {
  if (!isNativeShell()) notNative();
  const r = await OfflineFolder.prepareFileForWebView({ path });
  return Capacitor.convertFileSrc(r.fileUrl);
}

// Wipes the cache-mirror directory the WebView reads from. Called when
// the user picks a different folder OR clears the offline store, so
// stale cached pages from the previous tree don't keep resolving.
export async function clearWebViewCache() {
  if (!isNativeShell()) return;
  try { await OfflineFolder.clearCache(); } catch { /* best-effort */ }
}

export function isAvailable() {
  return isNativeShell();
}

// ── Encoding helpers ───────────────────────────────────────────────────────

async function toBase64(input) {
  if (typeof input === 'string') return input; // assume already base64
  let buf;
  if (input instanceof ArrayBuffer) buf = new Uint8Array(input);
  else if (input instanceof Uint8Array) buf = input;
  else if (input instanceof Blob) buf = new Uint8Array(await input.arrayBuffer());
  else throw new TypeError('writeBytes: unsupported input type');
  // Chunked btoa loop — avoids "Maximum call stack size exceeded" on
  // typical manga pages (a few MB) and is faster than a FileReader hop.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
