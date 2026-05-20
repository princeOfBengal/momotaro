import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import { getCapacitorElectronConfig, setupElectronDeepLinking } from '@capacitor-community/electron';
import type { MenuItemConstructorOptions } from 'electron';
import { app, MenuItem, protocol } from 'electron';
import electronIsDev from 'electron-is-dev';
import unhandled from 'electron-unhandled';
import { autoUpdater } from 'electron-updater';

import { ElectronCapacitorApp, setupContentSecurityPolicy, setupReloadWatcher } from './setup';
import { registerNativePlugins, OFFLINE_SCHEME } from './plugins';

// Graceful handling of unhandled errors.
unhandled();

// Define our menu templates (these are optional)
const trayMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [new MenuItem({ label: 'Quit App', role: 'quit' })];
const appMenuBarMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
  { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
  { role: 'viewMenu' },
];

// Get Config options from capacitor.config
const capacitorFileConfig: CapacitorElectronConfig = getCapacitorElectronConfig();

// Initialize our app. You can pass menu templates into the app here.
// const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig);
const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig, trayMenuTemplate, appMenuBarMenuTemplate);

// Re-declare ALL privileged schemes in one final call. electron-serve already
// registered the app scheme (in the constructor above); Electron's
// registerSchemesAsPrivileged REPLACES the entire list on each call (the "can
// only be called once" docs mean later calls overwrite earlier ones), so a
// separate call for just the offline scheme would strip the app scheme's
// `secure` flag and break Web Crypto / at-rest encryption. We therefore
// re-declare BOTH here, secure, after electron-serve's call and before `ready`.
// Verified in the Phase 2 spike (docs/linux-phase2.md).
protocol.registerSchemesAsPrivileged([
  {
    scheme: myCapacitorApp.getCustomURLScheme(),
    privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: OFFLINE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// If deeplinking is enabled then we will set it up here.
if (capacitorFileConfig.electron?.deepLinkingEnabled) {
  setupElectronDeepLinking(myCapacitorApp, {
    customProtocol: capacitorFileConfig.electron.deepLinkingCustomProtocol ?? 'mycapacitorapp',
  });
}

// If we are in Dev mode, use the file watcher components.
if (electronIsDev) {
  setupReloadWatcher(myCapacitorApp);
}

// Run Application
(async () => {
  // Wait for electron app to be ready.
  await app.whenReady();
  // Security - Set Content-Security-Policy based on whether or not we are in dev mode.
  setupContentSecurityPolicy(myCapacitorApp.getCustomURLScheme());
  // Initialize our app, build windows, and load content.
  await myCapacitorApp.init();
  // Self-hosted updates use the in-app banner (server /api/app/version +
  // shell.openExternal of the AppImage), mirroring the Android APK flow — see
  // docs/linux-phase4.md. electron-updater's auto-check is a future v2 path
  // (needs a publish feed); only run it in a packaged build and never let a
  // missing feed surface an error.
  if (!electronIsDev) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => { /* no feed configured yet */ });
  }
})();

// Handle when all of our windows are close (platforms have their own expectations).
app.on('window-all-closed', function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// When the dock icon is clicked.
app.on('activate', async function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (myCapacitorApp.getMainWindow().isDestroyed()) {
    await myCapacitorApp.init();
  }
});

// Place all ipc or other electron api calls and custom functionality under this line

// In-tree native plugins (ImmersiveMode now; OfflineFolder + DownloadKeepAlive
// in later phases). Registered as plain ipcMain handlers — NOT via
// electron-plugins.js, which `cap sync` regenerates and would clobber — so they
// survive every sync. Renderer side is exposed in preload.ts as
// window.MomotaroElectron.
registerNativePlugins(() => myCapacitorApp.getMainWindow());
