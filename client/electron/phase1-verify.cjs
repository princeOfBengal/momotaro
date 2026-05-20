/*
 * Phase 1 runtime verification — shell config + ImmersiveMode + pairing.
 *
 * Loads the REAL built app with the REAL compiled preload (which now exposes
 * window.MomotaroElectron), applies the REAL setupContentSecurityPolicy from
 * build/src/setup.js, and registers the REAL ImmersiveMode handlers via
 * registerNativePlugins from build/src/plugins/index.js. Then verifies:
 *
 *   1. App boots and FirstLaunchGate routes the native shell to /pairing.
 *   2. isNativePlatform()/getPlatform() (re-confirm under Phase 1 config).
 *   3. window.MomotaroElectron bridge present with ImmersiveMode methods.
 *   4. Cleartext HTTP fetch works under the REAL (broadened) CSP + allowInsecure.
 *   5. ImmersiveMode is FUNCTIONAL: enable() hides the menu bar + fullscreens
 *      the window; disable() restores both (checked from the main process).
 */
const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { registerNativePlugins } = require('./build/src/plugins/index.js');
const { setupContentSecurityPolicy } = require('./build/src/setup.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const APP_DIR = path.join(__dirname, 'app');
const PRELOAD = path.join(__dirname, 'build', 'src', 'preload.js');
const APP_SCHEME = 'capacitor-electron';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function startHttpServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (req.url.startsWith('/api/health')) { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ status: 'ok' })); }
      else if (req.url.startsWith('/img.png')) { res.writeHead(200, { 'Content-Type': 'image/png', ...cors }); res.end(PNG); }
      else { res.writeHead(404, cors); res.end('nope'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function registerAppProtocol() {
  protocol.registerFileProtocol(APP_SCHEME, (request, cb) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const filePath = path.join(APP_DIR, p);
    if (filePath.startsWith(APP_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) cb({ path: filePath });
    else cb({ path: path.join(APP_DIR, 'index.html') }); // SPA fallback
  });
}

const probeJs = (httpHealth) => `
(async () => {
  const out = {};
  out.isNativePlatform = (() => { try { return window.Capacitor.isNativePlatform(); } catch (e) { return 'ERR:' + e.message; } })();
  out.getPlatform      = (() => { try { return window.Capacitor.getPlatform(); }      catch (e) { return 'ERR:' + e.message; } })();
  out.hasMomotaroBridge = typeof window.MomotaroElectron !== 'undefined';
  out.bridgePlatform    = window.MomotaroElectron ? window.MomotaroElectron.platform : null;
  out.hasImmersiveEnable  = !!(window.MomotaroElectron && window.MomotaroElectron.ImmersiveMode && typeof window.MomotaroElectron.ImmersiveMode.enable === 'function');
  out.hasImmersiveDisable = !!(window.MomotaroElectron && window.MomotaroElectron.ImmersiveMode && typeof window.MomotaroElectron.ImmersiveMode.disable === 'function');
  out.locationPathname = window.location.pathname;
  const root = document.getElementById('root');
  out.rootChildCount = root ? root.childElementCount : -1;
  out.bodyTextSnippet = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 140);
  try { const r = await fetch('${httpHealth}'); out.httpFetch = r.ok ? ('ok:' + r.status) : ('bad:' + r.status); }
  catch (e) { out.httpFetch = 'ERR:' + e.message; }
  return out;
})()
`;

const waitFsEvent = (win, evt, ms = 1500) => new Promise((res) => {
  const t = setTimeout(() => res(false), ms);
  win.once(evt, () => { clearTimeout(t); res(true); });
});

(async () => {
  const report = { electron: process.versions.electron, chrome: process.versions.chrome };
  try {
    await app.whenReady();
    registerAppProtocol();
    setupContentSecurityPolicy(APP_SCHEME); // the REAL Phase 1 CSP
    const srv = await startHttpServer();
    const port = srv.address().port;

    const win = new BrowserWindow({
      show: true, width: 1000, height: 800,
      webPreferences: { preload: PRELOAD, nodeIntegration: true, contextIsolation: true, allowRunningInsecureContent: true },
    });
    registerNativePlugins(() => win); // real ImmersiveMode handlers target this window

    await win.loadURL(`${APP_SCHEME}://-/`);
    await new Promise((r) => setTimeout(r, 1200)); // let React mount + FirstLaunchGate route

    report.probe = await win.webContents.executeJavaScript(probeJs(`http://127.0.0.1:${port}/api/health`));

    // Functional ImmersiveMode test, driven exactly as immersive.js drives it.
    report.immersive = { before: { menuBarVisible: win.isMenuBarVisible(), fullScreen: win.isFullScreen() } };
    const enterFs = waitFsEvent(win, 'enter-full-screen');
    await win.webContents.executeJavaScript('window.MomotaroElectron.ImmersiveMode.enable()');
    await enterFs;
    report.immersive.afterEnable = { menuBarVisible: win.isMenuBarVisible(), fullScreen: win.isFullScreen() };
    const leaveFs = waitFsEvent(win, 'leave-full-screen');
    await win.webContents.executeJavaScript('window.MomotaroElectron.ImmersiveMode.disable()');
    await leaveFs;
    report.immersive.afterDisable = { menuBarVisible: win.isMenuBarVisible(), fullScreen: win.isFullScreen() };

    win.destroy();
    srv.close();
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(path.join(__dirname, 'phase1-report.json'), JSON.stringify(report, null, 2));
  console.log('PHASE1_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('PHASE1_REPORT_END');
  app.exit(0);
})();
