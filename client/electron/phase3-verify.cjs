/*
 * Phase 3 runtime verification — DownloadKeepAlive (keep the queue alive across
 * a window close) + bridge contract.
 *
 * Drives the real window.MomotaroElectron.DownloadKeepAlive bridge and exercises
 * the three behaviors that matter on desktop:
 *   A. While a download is "active", closing the window HIDES it (renderer +
 *      queue survive) instead of destroying it.
 *   B. stop() while the window is visible does NOT quit (just clears state/tray).
 *   C. stop() while the window is hidden (user had closed it mid-download) quits
 *      the app — the download is done, honor the earlier close.
 * Plus the no-op handoff contract (requestPermissions / isSupported /
 * consumeProgressReport / setPlanState).
 */
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { registerNativePlugins } = require('./build/src/plugins/index.js');
const { setupContentSecurityPolicy } = require('./build/src/setup.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const APP_DIR = path.join(__dirname, 'app');
const PRELOAD = path.join(__dirname, 'build', 'src', 'preload.js');
const APP_SCHEME = 'capacitor-electron';
let win = null;

// Mirror the real shell: app scheme then BOTH schemes (last call wins, secure).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
]);
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'momotaro-offline', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
registerNativePlugins(() => win);

const report = { electron: process.versions.electron };
let reported = false;
function finish(extra) {
  if (reported) return;
  reported = true;
  Object.assign(report, extra || {});
  fs.writeFileSync(path.join(__dirname, 'phase3-report.json'), JSON.stringify(report, null, 2));
  console.log('PHASE3_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('PHASE3_REPORT_END');
}
app.on('before-quit', () => { report.stopQuitWhenHidden = true; });
app.on('will-quit', () => { finish(); });

function registerAppProtocol() {
  protocol.registerFileProtocol(APP_SCHEME, (request, cb) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const fp = path.join(APP_DIR, p);
    cb({ path: fs.existsSync(fp) && fs.statSync(fp).isFile() ? fp : path.join(APP_DIR, 'index.html') });
  });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = (js) => win.webContents.executeJavaScript(js).catch((e) => ({ execError: String(e) }));

(async () => {
  try {
    await app.whenReady();
    registerAppProtocol();
    setupContentSecurityPolicy(APP_SCHEME);

    win = new BrowserWindow({ show: true, width: 1000, height: 800,
      webPreferences: { preload: PRELOAD, nodeIntegration: true, contextIsolation: true, allowRunningInsecureContent: true } });
    await win.loadURL(`${APP_SCHEME}://-/`);
    await delay(900);

    // Bridge contract (no-op handoff methods).
    report.bridge = await exec(`(async()=>{const KA=window.MomotaroElectron.DownloadKeepAlive;const o={};o.hasBridge=!!KA;o.reqPerms=await KA.requestPermissions({permissions:['notifications']});o.isSupported=await KA.isSupported();o.consume=await KA.consumeProgressReport();try{await KA.setPlanState({serverUrl:'x',clientToken:null,jobs:[]});o.setPlanOk=true}catch(e){o.setPlanOk='ERR:'+e.message}return o;})()`);

    // Test A — close while active hides to tray (renderer survives).
    await exec(`window.MomotaroElectron.DownloadKeepAlive.start({title:'Momotaro',text:'page 1'})`);
    await delay(150);
    report.beforeClose = { visible: win.isVisible(), destroyed: win.isDestroyed() };
    win.close();
    await delay(400);
    report.afterCloseWhileActive = { destroyed: win.isDestroyed(), visible: win.isDestroyed() ? null : win.isVisible() };

    // Test B — stop while visible does NOT quit.
    if (!win.isDestroyed()) { win.show(); await delay(150); }
    await exec(`window.MomotaroElectron.DownloadKeepAlive.stop()`);
    await delay(200);
    report.afterStopWhileVisible = { destroyed: win.isDestroyed(), visible: win.isDestroyed() ? null : win.isVisible(), windows: BrowserWindow.getAllWindows().length };
    report.appAliveAfterStopVisible = true; // reaching here proves no quit

    // Test C — stop while hidden quits (downloads done, honor the earlier close).
    await exec(`window.MomotaroElectron.DownloadKeepAlive.start({title:'Momotaro',text:'page 2'})`);
    await delay(120);
    win.hide();
    await delay(150);
    report.beforeFinalStop = { visible: win.isVisible(), destroyed: win.isDestroyed() };
    await exec(`window.MomotaroElectron.DownloadKeepAlive.stop()`); // triggers app.quit() → will-quit → finish()

    // Safety net if the quit never happens.
    setTimeout(() => { finish({ stopQuitTimedOut: true }); app.exit(0); }, 5000);
  } catch (e) {
    finish({ fatal: String(e && e.stack || e) });
    app.exit(0);
  }
})();
