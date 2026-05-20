import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * DownloadKeepAlive — desktop analog of the Android foreground-service plugin
 * (DownloadKeepAlivePlugin.java + DownloadKeepAliveService.java).
 *
 * Why it's simpler on desktop: Android reclaims a backgrounded WebView under
 * Doze / memory pressure, so Android needs a foreground service to keep the JS
 * queue's process alive. A desktop Electron process is NOT reclaimed while it's
 * running or minimized — the only thing that kills the JS download queue (which
 * lives in the renderer) is the window being *closed* (renderer destroyed).
 *
 * So the desktop "keep alive" is: while a download is active, intercept a window
 * close and HIDE the window to the tray instead of destroying it — the renderer
 * (and thus the queue) keeps running. When the queue drains (`stop`) and the
 * window is hidden, the app quits (the user did ask to close it). A tray icon +
 * a one-shot notification surface what's happening, mirroring the Android
 * persistent notification.
 *
 * The native-handoff methods (`setPlanState` / `consumeProgressReport`) are
 * no-ops: there is no separate background worker on desktop — the renderer is
 * the worker and stays alive — so there is nothing to hand off or reconcile.
 * This matches the Android SAF-mode behavior, where the handoff is already
 * inert (downloader.js sends an empty plan with encryptionActive:true).
 *
 * Surfaced to the renderer as window.MomotaroElectron.DownloadKeepAlive; the
 * shared bridge in client/src/api/downloadKeepAlive.js prefers it on desktop.
 */

let active = false;     // a download run is in progress (keepAliveStart..stop)
let quitting = false;   // set when stop() initiates an app quit, so the close
                        // interceptor doesn't re-hide the window during teardown
let tray: Tray | null = null;
let latestText = 'Downloading chapters…';
let backgroundNoticeShown = false;
const closeWired = new WeakSet<BrowserWindow>();

function iconImage() {
  const file = process.platform === 'win32' ? 'appIcon.ico' : 'appIcon.png';
  const p = path.join(app.getAppPath(), 'assets', file);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

function ensureCloseHandler(win: BrowserWindow): void {
  if (!win || closeWired.has(win)) return;
  win.on('close', (e) => {
    // While downloading, a close hides to tray so the renderer/queue survives.
    if (active && !quitting) {
      e.preventDefault();
      win.hide();
      if (!backgroundNoticeShown) {
        backgroundNoticeShown = true;
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: 'Momotaro',
              body: 'Still downloading in the background. Click the tray icon to reopen.',
            }).show();
          }
        } catch { /* notifications are best-effort */ }
      }
    }
  });
  closeWired.add(win);
}

function ensureTray(getMainWindow: () => BrowserWindow | null): void {
  if (tray) return;
  try {
    tray = new Tray(iconImage());
    tray.setToolTip('Momotaro');
    const show = () => {
      const w = getMainWindow();
      if (w && !w.isDestroyed()) { w.show(); w.focus(); }
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Momotaro', click: show },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', show);
    tray.on('double-click', show);
  } catch {
    tray = null; // headless / no display — non-fatal, the queue still runs
  }
}

function removeTray(): void {
  try { tray?.destroy(); } catch { /* ignore */ }
  tray = null;
}

export function registerDownloadKeepAlive(getMainWindow: () => BrowserWindow | null): void {
  // Android requests POST_NOTIFICATIONS at runtime; desktop notifications need
  // no such grant. Resolve as granted.
  ipcMain.handle('DownloadKeepAlive-requestPermissions', () => ({ notifications: 'granted' }));

  ipcMain.handle('DownloadKeepAlive-start', (_e, opts) => {
    active = true;
    backgroundNoticeShown = false;
    latestText = (opts && opts.text) || latestText;
    const win = getMainWindow();
    if (win) { ensureCloseHandler(win); ensureTray(getMainWindow); }
    if (tray) tray.setToolTip(`${(opts && opts.title) || 'Momotaro'} — ${latestText}`);
  });

  ipcMain.handle('DownloadKeepAlive-update', (_e, opts) => {
    latestText = (opts && opts.text) || latestText;
    if (tray) tray.setToolTip(`Momotaro — ${latestText}`);
  });

  ipcMain.handle('DownloadKeepAlive-stop', () => {
    active = false;
    const win = getMainWindow();
    removeTray();
    // The queue drained. If the user had closed the window during the download
    // (so it's hidden), honor that close now and quit.
    if (win && !win.isDestroyed() && !win.isVisible()) {
      quitting = true;
      app.quit();
    }
  });

  // No separate background worker on desktop — the renderer is the worker.
  ipcMain.handle('DownloadKeepAlive-setPlanState', () => { /* no-op */ });
  ipcMain.handle('DownloadKeepAlive-consumeProgressReport', () => ({ reports: [] }));
  ipcMain.handle('DownloadKeepAlive-isSupported', () => ({
    supported: true,
    notificationsGranted: (() => { try { return Notification.isSupported(); } catch { return true; } })(),
  }));
}
