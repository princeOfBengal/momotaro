import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * OfflineFolder — desktop analog of the Android SAF-backed
 * OfflineFolderPlugin.java. Owns the user-chosen download folder and all
 * filesystem I/O the offline subsystem performs through it.
 *
 * Unlike Android (SAF tree URIs, DocumentFile, content:// + cache-mirror),
 * Linux gives us a plain absolute path the renderer can't read directly (the
 * page is on a secure custom scheme) but the main process can. So:
 *
 *   - The picked folder is a normal directory; we persist its absolute path in
 *     userData (no SAF permission to pin — fs access is direct).
 *   - File ops are plain fs against absolute paths under that root, with a
 *     traversal guard. The base64 in/out contract matches the JS bridge in
 *     client/src/api/offlineFolder.js byte-for-byte, so the shared offline
 *     stack is unchanged.
 *   - prepareFileForWebView returns a `momotaro-offline://` URL served by a
 *     privileged streaming protocol — no cache-copy needed (the Android copy
 *     existed only because content:// can't load in a WebView). convertFileSrc
 *     is the identity on electron, so the URL we return is what `<img src>` gets.
 *
 * The Capacitor Electron platform doesn't route bare registerPlugin() calls to
 * in-tree plugins, so these are plain ipcMain channels surfaced to the renderer
 * as window.MomotaroElectron.OfflineFolder in preload.ts.
 */

export const OFFLINE_SCHEME = 'momotaro-offline';

function configPath(): string {
  return path.join(app.getPath('userData'), 'offline-folder.json');
}
function readRoot(): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return j && typeof j.root === 'string' && j.root ? j.root : null;
  } catch {
    return null;
  }
}
function writeRoot(root: string | null): void {
  try { fs.writeFileSync(configPath(), JSON.stringify({ root: root || null })); } catch { /* best-effort */ }
}

// Resolve a forward-slash relative path under the root, refusing anything that
// escapes it (a stray `..` in a chapter name, etc.).
function resolveUnder(root: string, rel: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel || '');
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('path escapes offline root: ' + rel);
  }
  return abs;
}

function rootOrThrow(): string {
  const root = readRoot();
  if (!root) throw new Error('No download folder configured.');
  return root;
}

// Build the WebView-loadable URL for a relative path. Per-segment encoding so
// spaces, brackets ([id]), and CJK survive intact.
function offlineUrlFor(rel: string): string {
  const encoded = String(rel || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${OFFLINE_SCHEME}://file/${encoded}`;
}

export function registerOfflineFolder(getMainWindow: () => BrowserWindow | null): void {
  // NOTE: the OFFLINE_SCHEME privilege is registered in index.ts, NOT here.
  // Electron's protocol.registerSchemesAsPrivileged REPLACES the whole list on
  // each call (despite "can only be called once" docs) — a separate call here
  // for just the offline scheme stripped the app scheme's `secure` flag and
  // broke Web Crypto (verified in the Phase 2 spike). So both schemes are
  // declared together in one final call in index.ts. Here we only register the
  // file-serving handler (valid once app is ready).
  const registerProtocol = () => {
    protocol.registerFileProtocol(OFFLINE_SCHEME, (request, cb) => {
      try {
        const root = readRoot();
        if (!root) return cb({ error: -6 }); // net::ERR_FILE_NOT_FOUND
        const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
        const abs = resolveUnder(root, rel);
        if (!fs.existsSync(abs)) return cb({ error: -6 });
        cb({ path: abs });
      } catch {
        cb({ error: -6 });
      }
    });
  };
  if (app.isReady()) registerProtocol();
  else app.whenReady().then(registerProtocol);

  // ── Folder lifecycle ──────────────────────────────────────────────────────
  ipcMain.handle('OfflineFolder-getStatus', () => {
    const root = readRoot();
    if (!root || !(fs.existsSync(root) && fs.statSync(root).isDirectory())) {
      return { configured: false, treeUri: null, displayName: null };
    }
    return { configured: true, treeUri: root, displayName: root };
  });

  ipcMain.handle('OfflineFolder-pickFolder', async () => {
    const win = getMainWindow();
    const opts = { title: 'Choose Momotaro download folder', properties: ['openDirectory', 'createDirectory'] as any };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { configured: false, cancelled: true };
    }
    const root = result.filePaths[0];
    writeRoot(root);
    return { configured: true, treeUri: root, displayName: root };
  });

  ipcMain.handle('OfflineFolder-clearFolder', () => {
    writeRoot(null);
  });

  // ── File ops (relative paths under the picked root) ───────────────────────
  ipcMain.handle('OfflineFolder-ensureDir', async (_e, { path: rel }) => {
    const abs = resolveUnder(rootOrThrow(), rel);
    await fsp.mkdir(abs, { recursive: true });
    return { uri: abs };
  });

  ipcMain.handle('OfflineFolder-writeFile', async (_e, { path: rel, data }) => {
    const abs = resolveUnder(rootOrThrow(), rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, Buffer.from(String(data || ''), 'base64'));
  });

  ipcMain.handle('OfflineFolder-readFile', async (_e, { path: rel }) => {
    const abs = resolveUnder(rootOrThrow(), rel);
    const buf = await fsp.readFile(abs);
    return { data: buf.toString('base64') };
  });

  ipcMain.handle('OfflineFolder-exists', async (_e, { path: rel }) => {
    const root = readRoot();
    if (!root) return { exists: false };
    try { return { exists: fs.existsSync(resolveUnder(root, rel)) }; }
    catch { return { exists: false }; }
  });

  ipcMain.handle('OfflineFolder-listFiles', async (_e, { path: rel }) => {
    const root = readRoot();
    if (!root) return { entries: [] };
    try {
      const abs = resolveUnder(root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { entries: [] };
      const dirents = await fsp.readdir(abs, { withFileTypes: true });
      return { entries: dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() })) };
    } catch {
      return { entries: [] };
    }
  });

  ipcMain.handle('OfflineFolder-deletePath', async (_e, { path: rel, recursive }) => {
    const abs = resolveUnder(rootOrThrow(), rel);
    await fsp.rm(abs, { recursive: !!recursive, force: true });
  });

  ipcMain.handle('OfflineFolder-prepareFileForWebView', async (_e, { path: rel }) => {
    const abs = resolveUnder(rootOrThrow(), rel);
    if (!fs.existsSync(abs)) throw new Error('file not found: ' + rel);
    return { fileUrl: offlineUrlFor(rel) };
  });

  // No cache-mirror on desktop (the protocol streams straight from disk), so
  // clearCache is a no-op kept for contract parity with the Android plugin.
  ipcMain.handle('OfflineFolder-clearCache', () => { /* no-op */ });
}
