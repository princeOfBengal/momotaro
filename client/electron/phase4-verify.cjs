/*
 * Phase 4 runtime verification — the desktop update CTA bridge
 * (window.MomotaroElectron.openExternal → ipcMain → shell.openExternal).
 *
 * shell.openExternal is monkey-patched to RECORD the URL instead of actually
 * launching a browser, so the test is side-effect-free. Confirms the full
 * renderer→main path works and that the http(s) guard rejects other schemes.
 */
const electron = require('electron');
const { app, BrowserWindow, protocol } = electron;
const fs = require('fs');
const path = require('path');
const { registerNativePlugins } = require('./build/src/plugins/index.js');
const { setupContentSecurityPolicy } = require('./build/src/setup.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// Record openExternal calls instead of opening a browser.
const opened = [];
electron.shell.openExternal = (url) => { opened.push(url); return Promise.resolve('opened:' + url); };

const APP_DIR = path.join(__dirname, 'app');
const PRELOAD = path.join(__dirname, 'build', 'src', 'preload.js');
const APP_SCHEME = 'capacitor-electron';
let win = null;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
]);
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'momotaro-offline', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
registerNativePlugins(() => win);

(async () => {
  const report = { electron: process.versions.electron };
  try {
    await app.whenReady();
    protocol.registerFileProtocol(APP_SCHEME, (request, cb) => {
      let p = decodeURIComponent(new URL(request.url).pathname);
      if (p === '/' || p === '') p = '/index.html';
      const fp = path.join(APP_DIR, p);
      cb({ path: fs.existsSync(fp) && fs.statSync(fp).isFile() ? fp : path.join(APP_DIR, 'index.html') });
    });
    setupContentSecurityPolicy(APP_SCHEME);

    win = new BrowserWindow({ show: false, width: 1000, height: 800,
      webPreferences: { preload: PRELOAD, nodeIntegration: true, contextIsolation: true, allowRunningInsecureContent: true } });
    await win.loadURL(`${APP_SCHEME}://-/`);
    await new Promise((r) => setTimeout(r, 800));

    report.probe = await win.webContents.executeJavaScript(`(async()=>{
      const M = window.MomotaroElectron;
      const o = { hasOpenExternal: typeof (M && M.openExternal) === 'function', platform: M && M.platform };
      o.httpResult = await M.openExternal('https://my-momotaro.example/downloads/momotaro.AppImage');
      try { o.badSchemeResult = await M.openExternal('file:///etc/passwd'); } catch(e){ o.badSchemeResult = 'ERR:'+e.message; }
      return o;
    })()`);

    report.openedByMain = opened.slice();   // what shell.openExternal actually received
    win.destroy();
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(path.join(__dirname, 'phase4-report.json'), JSON.stringify(report, null, 2));
  console.log('PHASE4_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('PHASE4_REPORT_END');
  app.exit(0);
})();
