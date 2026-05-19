// Thin facade over the OfflineFolder Capacitor plugin (SAF-backed) for
// the rest of the offline subsystem. The contract:
//
//   isAvailable()                  → running on the Android shell
//   isConfigured()                 → user has picked a tree-URI folder
//   getStatus()                    → { configured, displayName, treeUri }
//   pickFolder()                   → SAF picker; returns new status
//   clearFolder()                  → forgets the picked folder
//   writeBytes(path, bytes)        → write raw binary
//   writeText(path, text)          → write UTF-8 text (metadata)
//   readText(path)                 → UTF-8 read
//   readBytes(path)                → Uint8Array read (used by decrypt)
//   exists(path)                   → boolean
//   removePath(path, recursive)    → delete file or tree
//   srcUrl(path)                   → URL the WebView can render
//   clearWebViewCache()            → wipe the cache mirror
//
// Every path is a forward-slash relative path under the user-picked
// tree. The previous "subfolder name under Directory.External" model
// is gone — v1.6 fails closed when no folder is configured so users
// can't silently end up with downloads in app-private storage they
// didn't expect.
//
// `NoOfflineFolderError` is thrown by writeBytes / writeText / readText /
// readBytes / removePath / srcUrl when the user hasn't picked a folder
// yet. Callers handle it by prompting the user to set one in Settings.

import {
  getFolderStatus,
  pickFolder as plugPickFolder,
  clearFolder as plugClearFolder,
  ensureDir   as plugEnsureDir,
  writeBytes  as plugWriteBytes,
  writeText   as plugWriteText,
  readBytes   as plugReadBytes,
  readText    as plugReadText,
  exists      as plugExists,
  removePath  as plugRemovePath,
  srcUrl      as plugSrcUrl,
  clearWebViewCache as plugClearWebViewCache,
  isAvailable as plugIsAvailable,
  OfflineFolderUnavailableError,
} from './offlineFolder.js';

export class OfflineStorageUnavailableError extends OfflineFolderUnavailableError {}

export class NoOfflineFolderError extends Error {
  constructor(msg = 'No download folder configured.') {
    super(msg);
    this.name = 'NoOfflineFolderError';
    this.code = 'NO_FOLDER';
  }
}

// ── State accessors ────────────────────────────────────────────────────────

// In-process cache so we don't hit the Capacitor bridge on every call to
// `isConfigured`. Refreshed via `refreshStatus()` after every state-
// changing op (pick / clear). Initial value `null` means "haven't asked
// yet" — first access forces a read.
let _cachedStatus = null;
let _statusInFlight = null;

export function isAvailable() {
  return plugIsAvailable();
}

export async function getStatus() {
  if (_cachedStatus) return _cachedStatus;
  if (_statusInFlight) return _statusInFlight;
  _statusInFlight = getFolderStatus()
    .then(s => { _cachedStatus = s; _statusInFlight = null; return s; })
    .catch(() => { _statusInFlight = null; return { configured: false, treeUri: null, displayName: null }; });
  return _statusInFlight;
}

// Sync probe used by the download pre-flight check. Returns null if we
// haven't loaded the status yet — caller should fall back to the async
// `getStatus()` (or just call `assertConfigured()` which awaits).
export function getCachedStatus() {
  return _cachedStatus;
}

export async function isConfigured() {
  const s = await getStatus();
  return !!(s && s.configured);
}

async function refreshStatus() {
  _cachedStatus = null;
  return getStatus();
}

async function assertConfigured() {
  if (!isAvailable()) throw new OfflineStorageUnavailableError();
  if (!(await isConfigured())) throw new NoOfflineFolderError();
}

// ── Folder lifecycle ───────────────────────────────────────────────────────

export async function pickFolder() {
  if (!isAvailable()) throw new OfflineStorageUnavailableError();
  // Wipe the WebView cache mirror before swapping — otherwise cover
  // thumbnails and decrypted blob URLs from the previous tree would
  // continue to resolve, masking the fact that the new tree is empty.
  try { await plugClearWebViewCache(); } catch { /* non-fatal */ }
  const status = await plugPickFolder();
  await refreshStatus();
  return status;
}

export async function clearFolder() {
  if (!isAvailable()) throw new OfflineStorageUnavailableError();
  try { await plugClearWebViewCache(); } catch { /* non-fatal */ }
  await plugClearFolder();
  await refreshStatus();
}

// ── File ops ───────────────────────────────────────────────────────────────

export async function ensureDir(path) {
  await assertConfigured();
  return plugEnsureDir(path);
}

export async function writeBytes(path, bytes) {
  await assertConfigured();
  return plugWriteBytes(path, bytes);
}

export async function writeText(path, text) {
  await assertConfigured();
  return plugWriteText(path, text);
}

export async function readText(path) {
  await assertConfigured();
  return plugReadText(path);
}

export async function readBytes(path) {
  await assertConfigured();
  return plugReadBytes(path);
}

export async function exists(path) {
  if (!isAvailable()) return false;
  if (!(await isConfigured())) return false;
  return plugExists(path);
}

export async function removePath(path, opts = {}) {
  await assertConfigured();
  return plugRemovePath(path, opts);
}

export async function srcUrl(path) {
  await assertConfigured();
  return plugSrcUrl(path);
}

export async function clearWebViewCache() {
  if (!isAvailable()) return;
  return plugClearWebViewCache();
}

// ── Display helpers ────────────────────────────────────────────────────────

// User-facing path string for the Settings panel. Returns null when no
// folder is configured. Async because the plugin owns the source of truth.
export async function getDisplayPath() {
  const s = await getStatus();
  return s && s.configured ? s.displayName : null;
}

// ── One-time migration ────────────────────────────────────────────────────
//
// v1.5 stored a `momotaro_offline_root` subfolder name in localStorage
// and ran on top of @capacitor/filesystem's Directory.External. v1.6
// drops that model entirely. On first v1.6 launch we drop the stale
// localStorage key so the Settings UI doesn't show a phantom
// "configured" state pointing at a folder we no longer use. Existing
// on-disk files at the old path are left alone — the user can wipe
// them via a file manager.
const LEGACY_ROOT_KEY = 'momotaro_offline_root';
let _migrationDone = false;
export function migrateLegacyRoot() {
  if (_migrationDone) return;
  _migrationDone = true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(LEGACY_ROOT_KEY)) {
      localStorage.removeItem(LEGACY_ROOT_KEY);
    }
  } catch { /* ignore */ }
}
