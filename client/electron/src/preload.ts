require('./rt/electron-rt');
//////////////////////////////
// User Defined Preload scripts below

// In-tree native plugins for the desktop shell. The Capacitor Electron platform
// doesn't route bare `registerPlugin('Name')` calls to in-tree plugins (no
// PluginHeaders, and core doesn't consult CapacitorCustomPlatform.plugins), so
// we expose them under our own bridge namespace. The shared JS bridges in
// client/src/api/*.js prefer window.MomotaroElectron when present and fall back
// to the Capacitor native bridge on Android. Channel names match the
// ipcMain.handle() registrations in src/plugins/index.ts.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('MomotaroElectron', {
  platform: 'electron',
  // Open a URL in the OS default browser. Used by the self-hosted update banner
  // to download the AppImage — navigation is locked to the app scheme, so a
  // plain <a target="_blank"> would be denied by setWindowOpenHandler.
  openExternal: (url: string) => ipcRenderer.invoke('App-openExternal', { url }),
  ImmersiveMode: {
    enable: () => ipcRenderer.invoke('ImmersiveMode-enable'),
    disable: () => ipcRenderer.invoke('ImmersiveMode-disable'),
  },
  OfflineFolder: {
    getStatus: () => ipcRenderer.invoke('OfflineFolder-getStatus'),
    pickFolder: () => ipcRenderer.invoke('OfflineFolder-pickFolder'),
    clearFolder: () => ipcRenderer.invoke('OfflineFolder-clearFolder'),
    ensureDir: (o: unknown) => ipcRenderer.invoke('OfflineFolder-ensureDir', o),
    writeFile: (o: unknown) => ipcRenderer.invoke('OfflineFolder-writeFile', o),
    readFile: (o: unknown) => ipcRenderer.invoke('OfflineFolder-readFile', o),
    exists: (o: unknown) => ipcRenderer.invoke('OfflineFolder-exists', o),
    listFiles: (o: unknown) => ipcRenderer.invoke('OfflineFolder-listFiles', o),
    deletePath: (o: unknown) => ipcRenderer.invoke('OfflineFolder-deletePath', o),
    prepareFileForWebView: (o: unknown) => ipcRenderer.invoke('OfflineFolder-prepareFileForWebView', o),
    clearCache: () => ipcRenderer.invoke('OfflineFolder-clearCache'),
  },
  DownloadKeepAlive: {
    requestPermissions: (o: unknown) => ipcRenderer.invoke('DownloadKeepAlive-requestPermissions', o),
    start: (o: unknown) => ipcRenderer.invoke('DownloadKeepAlive-start', o),
    update: (o: unknown) => ipcRenderer.invoke('DownloadKeepAlive-update', o),
    stop: () => ipcRenderer.invoke('DownloadKeepAlive-stop'),
    setPlanState: (o: unknown) => ipcRenderer.invoke('DownloadKeepAlive-setPlanState', o),
    consumeProgressReport: () => ipcRenderer.invoke('DownloadKeepAlive-consumeProgressReport'),
    isSupported: () => ipcRenderer.invoke('DownloadKeepAlive-isSupported'),
  },
});
