/*
 * Verifies the Linux settings subsetting renders in the desktop shell:
 * the "Linux" nav item, the "Download AppImage" card, and the electron-only
 * "Check for updates" card. Seeds an (unreachable) server URL + token so
 * FirstLaunchGate lets the app through to /settings instead of /pairing.
 */
const electron = require('electron');
const { app, BrowserWindow, protocol } = electron;
const fs = require('fs');
const path = require('path');
const { registerNativePlugins } = require('./build/src/plugins/index.js');
const { setupContentSecurityPolicy } = require('./build/src/setup.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
electron.shell.openExternal = (url) => Promise.resolve('opened:' + url); // never launch a browser

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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = (js) => win.webContents.executeJavaScript(js).catch((e) => ({ execError: String(e && e.message || e) }));

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

    win = new BrowserWindow({ show: false, width: 1100, height: 850,
      webPreferences: { preload: PRELOAD, nodeIntegration: true, contextIsolation: true, allowRunningInsecureContent: true } });

    await win.loadURL(`${APP_SCHEME}://-/`);
    await delay(500);
    // Seed an unreachable server so FirstLaunchGate allows the app (past pairing).
    await exec(`localStorage.setItem('momotaro_server_url','http://127.0.0.1:1');localStorage.setItem('momotaro_client_token','test-token');'ok'`);

    await win.loadURL(`${APP_SCHEME}://-/settings`);
    await delay(2800); // FirstLaunchGate auth probe fails fast → allow → Settings mounts

    report.settings = await exec(`(async()=>{
      const navText = () => Array.from(document.querySelectorAll('button,a,[role=button]')).map(b=>(b.textContent||'').trim());
      const out = { path: location.pathname, platform: window.Capacitor.getPlatform() };
      out.hasLinuxNav = navText().some(t => t === 'Linux');
      out.hasAndroidNav = navText().some(t => t === 'Android');
      // click the Linux nav item, then read the section body
      const linuxBtn = Array.from(document.querySelectorAll('button,a,[role=button]')).find(b => (b.textContent||'').trim() === 'Linux');
      out.foundLinuxButton = !!linuxBtn;
      if (linuxBtn) linuxBtn.click();
      await new Promise(r=>setTimeout(r,350));
      const body = document.body.innerText || '';
      out.hasDownloadAppImage = /Download AppImage/.test(body);
      out.hasUpdateCheck = /Check for updates/.test(body);
      out.mentionsAppImagePath = /momotaro\\.AppImage/.test(body);
      return out;
    })()`);

    win.destroy();
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(path.join(__dirname, 'phase4-settings-report.json'), JSON.stringify(report, null, 2));
  console.log('SETTINGS_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('SETTINGS_REPORT_END');
  app.exit(0);
})();
