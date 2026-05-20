/*
 * Phase 0 runtime verification harness for the Momotaro Linux AppImage spike.
 *
 * Loads the REAL built React app (client/electron/app) with the REAL compiled
 * Capacitor preload (build/src/preload.js) under a privileged custom scheme —
 * exactly as the production Electron shell will — then probes every
 * load-bearing runtime behavior the development plan depends on:
 *
 *   1. window.Capacitor.isNativePlatform() === true   (all native-gated code paths light up)
 *   2. window.Capacitor.getPlatform() === 'electron'
 *   3. Capacitor.convertFileSrc(x) behavior            (identity on electron)
 *   4. secure context + Web Crypto AES-GCM round trip  (at-rest offline encryption)
 *   5. custom file:// protocol serving an arbitrary on-disk file (offline page render path)
 *   6. cleartext HTTP fetch + <img> to a plain-http server (talking to a self-hosted server)
 *
 * Step 6 is tested under two webPreferences configs to resolve the
 * secure-context mixed-content question (the Electron analog of Android's
 * androidScheme:http cleartext fight).
 *
 * Writes phase0-report.json and prints a summary, then exits.
 */
const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const APP_DIR = path.join(__dirname, 'app');
const OFFLINE_DIR = path.join(__dirname, 'phase0-offline');
const PRELOAD = path.join(__dirname, 'build', 'src', 'preload.js');
const APP_SCHEME = 'capacitor-electron';
const OFFLINE_SCHEME = 'momotaro-offline';

// 1x1 transparent PNG — stands in for a downloaded manga page + a server image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
fs.mkdirSync(OFFLINE_DIR, { recursive: true });
fs.writeFileSync(path.join(OFFLINE_DIR, 'page.png'), PNG);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

// Mirror electron-serve's privilege registration for the app scheme, plus a
// second scheme that stands in for the OfflineFolder plugin's render URL.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME,     privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: OFFLINE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function startHttpServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (req.url.startsWith('/api/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.url.startsWith('/img.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png', ...cors });
        res.end(PNG);
      } else {
        res.writeHead(404, cors); res.end('nope');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function registerProtocols() {
  protocol.registerFileProtocol(APP_SCHEME, (request, cb) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const filePath = path.join(APP_DIR, p);
    if (filePath.startsWith(APP_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      cb({ path: filePath });
    } else {
      cb({ path: path.join(APP_DIR, 'index.html') }); // SPA fallback
    }
  });
  protocol.registerFileProtocol(OFFLINE_SCHEME, (request, cb) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const filePath = path.join(OFFLINE_DIR, rel);
    if (filePath.startsWith(OFFLINE_DIR) && fs.existsSync(filePath)) cb({ path: filePath });
    else cb({ statusCode: 404, data: 'not found' });
  });
}

function setCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' ${APP_SCHEME}: ${OFFLINE_SCHEME}: 'unsafe-inline' 'unsafe-eval' data: blob:; ` +
          `connect-src 'self' ${APP_SCHEME}: http://127.0.0.1:* http: https:; ` +
          `img-src 'self' ${APP_SCHEME}: ${OFFLINE_SCHEME}: http://127.0.0.1:* http: https: data: blob:; ` +
          `script-src 'self' ${APP_SCHEME}: 'unsafe-inline' 'unsafe-eval';`,
        ],
      },
    });
  });
}

const probeJs = (offlineUrl, httpImg, httpHealth) => `
(async () => {
  const out = {};
  const loadImg = (src) => new Promise((res) => {
    const im = new Image();
    const t = setTimeout(() => res('timeout'), 6000);
    im.onload  = () => { clearTimeout(t); res(im.naturalWidth > 0 ? 'ok:' + im.naturalWidth : 'zero-size'); };
    im.onerror = () => { clearTimeout(t); res('error'); };
    im.src = src;
  });
  out.hasCapacitor = typeof window.Capacitor !== 'undefined';
  out.customPlatformName = window.CapacitorCustomPlatform ? window.CapacitorCustomPlatform.name : null;
  try { out.getPlatform = window.Capacitor.getPlatform(); } catch (e) { out.getPlatform = 'ERR:' + e.message; }
  try { out.isNativePlatform = window.Capacitor.isNativePlatform(); } catch (e) { out.isNativePlatform = 'ERR:' + e.message; }
  try { out.convertFileSrc = window.Capacitor.convertFileSrc('/5/chapters/Vol.2 Ch.5 [9100]/0001.jpg'); } catch (e) { out.convertFileSrc = 'ERR:' + e.message; }
  out.isSecureContext = window.isSecureContext;
  out.hasSubtleCrypto = !!(window.crypto && window.crypto.subtle);
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('momotaro'));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    out.aesGcmRoundTrip = new TextDecoder().decode(new Uint8Array(pt)) === 'momotaro';
  } catch (e) { out.aesGcmRoundTrip = 'ERR:' + e.message; }
  out.offlineProtocolImg = await loadImg('${offlineUrl}');
  out.httpImg = await loadImg('${httpImg}');
  try { const r = await fetch('${httpHealth}'); out.httpFetch = r.ok ? ('ok:' + r.status) : ('bad:' + r.status); }
  catch (e) { out.httpFetch = 'ERR:' + e.message; }
  return out;
})()
`;

async function runConfig(label, webPrefsExtra, urls) {
  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: true,
      contextIsolation: true,
      ...webPrefsExtra,
    },
  });
  let result;
  try {
    await win.loadURL(`${APP_SCHEME}://-/`);
    await new Promise((r) => setTimeout(r, 800)); // let the bundle wire up window.Capacitor
    result = await win.webContents.executeJavaScript(probeJs(urls.offline, urls.httpImg, urls.httpHealth));
  } catch (e) {
    result = { harnessError: String(e && e.message || e) };
  }
  win.destroy();
  return { config: label, ...result };
}

(async () => {
  const report = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, configs: [] };
  try {
    await app.whenReady();
    registerProtocols();
    setCsp();
    const srv = await startHttpServer();
    const port = srv.address().port;
    report.httpServerPort = port;
    const urls = {
      offline: `${OFFLINE_SCHEME}://file/page.png`,
      httpImg: `http://127.0.0.1:${port}/img.png`,
      httpHealth: `http://127.0.0.1:${port}/api/health`,
    };

    report.configs.push(await runConfig('secure+webSecurity:true+allowInsecure', { webSecurity: true, allowRunningInsecureContent: true }, urls));
    report.configs.push(await runConfig('webSecurity:false', { webSecurity: false }, urls));

    srv.close();
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(path.join(__dirname, 'phase0-report.json'), JSON.stringify(report, null, 2));
  console.log('PHASE0_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('PHASE0_REPORT_END');
  app.exit(0);
})();
