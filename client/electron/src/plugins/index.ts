import { BrowserWindow, ipcMain, shell } from 'electron';
import { registerOfflineFolder, OFFLINE_SCHEME } from './offline-folder';
import { registerDownloadKeepAlive } from './download-keep-alive';

export { OFFLINE_SCHEME };

/**
 * In-tree native plugins for the Momotaro desktop shell — the Electron analogs
 * of the Android Java plugins under
 * client/android/app/src/main/java/dev/momotaro/app.
 *
 * Registered as plain `ipcMain.handle()` channels (deliberately NOT through
 * Capacitor's electron-plugins.js, which `cap sync` regenerates and would
 * clobber) and surfaced to the renderer via window.MomotaroElectron in
 * preload.ts. Channel names are `${PluginName}-${method}`.
 *
 * Phase 1 ships ImmersiveMode; OfflineFolder (Phase 2) and DownloadKeepAlive
 * (Phase 3) will register here too.
 *
 * @param getMainWindow accessor for the app's main BrowserWindow, supplied by
 *   index.ts so handlers always target the live window even after re-init.
 */
export function registerNativePlugins(getMainWindow: () => BrowserWindow | null): void {
  const resolveWindow = (): BrowserWindow | null =>
    getMainWindow() || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;

  // ── ImmersiveMode ─────────────────────────────────────────────────────────
  // Desktop equivalent of the Android status/nav-bar toggle: the Reader hides
  // the window's menu bar and goes fullscreen so manga pages own the screen,
  // then restores both on unmount. Mirrors ImmersiveModePlugin.java's
  // enable()/disable() contract (resolve quietly; never reject).
  ipcMain.handle('ImmersiveMode-enable', () => {
    const win = resolveWindow();
    if (!win) return;
    win.setMenuBarVisibility(false);
    win.setFullScreen(true);
  });
  ipcMain.handle('ImmersiveMode-disable', () => {
    const win = resolveWindow();
    if (!win) return;
    win.setFullScreen(false);
    win.setMenuBarVisibility(true);
  });

  // ── OfflineFolder ─────────────────────────────────────────────────────────
  // Folder picker + filesystem I/O + the momotaro-offline:// streaming protocol.
  registerOfflineFolder(getMainWindow);

  // ── DownloadKeepAlive ─────────────────────────────────────────────────────
  // Keeps the renderer (and its download queue) alive across a window close by
  // hiding to tray; no-op native handoff. Desktop analog of the Android FGS.
  registerDownloadKeepAlive(getMainWindow);

  // ── App.openExternal ──────────────────────────────────────────────────────
  // Open an http(s) URL in the OS default browser (self-hosted update download).
  ipcMain.handle('App-openExternal', (_e, { url } = {}) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    return undefined;
  });
}
