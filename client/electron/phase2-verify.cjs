/*
 * Phase 2 runtime verification — OfflineFolder plugin + momotaro-offline:// protocol.
 *
 * Drives the REAL OfflineFolder bridge (window.MomotaroElectron.OfflineFolder)
 * through the same operations the offline stack performs, then cross-checks the
 * results on disk from the main process. Covers: folder status, dir creation,
 * binary + text write/read (base64 round-trip through IPC), listFiles, the
 * filesystem layout, AES-GCM encrypt→write→read→decrypt integrity, the
 * prepareFileForWebView → streaming-protocol → <img> render path, and delete.
 *
 * The interactive folder picker is bypassed by pre-seeding the plugin's config
 * file (simulating a prior pickFolder) so the run is fully automated.
 */
const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { registerNativePlugins } = require('./build/src/plugins/index.js');
const { setupContentSecurityPolicy } = require('./build/src/setup.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const APP_DIR = path.join(__dirname, 'app');
const PRELOAD = path.join(__dirname, 'build', 'src', 'preload.js');
const APP_SCHEME = 'capacitor-electron';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let win = null;

// Mirror the real shell exactly: electron-serve registers the app scheme
// (call 1), then index.ts re-declares BOTH schemes in one final call (call 2,
// which wins because registerSchemesAsPrivileged replaces the list). Both must
// end up `secure` so the page stays a secure context (Web Crypto).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
]);
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'momotaro-offline', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
registerNativePlugins(() => win); // ipcMain handlers + offline file protocol (no scheme registration)

function registerAppProtocol() {
  protocol.registerFileProtocol(APP_SCHEME, (request, cb) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const filePath = path.join(APP_DIR, p);
    if (filePath.startsWith(APP_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) cb({ path: filePath });
    else cb({ path: path.join(APP_DIR, 'index.html') });
  });
}

const CH_DIR = '5/chapters/Vol.2 Ch.5 [9100]'; // exercise spaces + [id] brackets

const probeJs = `
(async () => {
  const OF = window.MomotaroElectron.OfflineFolder;
  const conv = (u) => window.Capacitor.convertFileSrc(u);
  const b64ToBytes = (b) => { const s = atob(b); const a = new Uint8Array(s.length); for (let i=0;i<s.length;i++) a[i]=s.charCodeAt(i); return a; };
  const bytesToB64 = (a) => { let s=''; for (let i=0;i<a.length;i++) s+=String.fromCharCode(a[i]); return btoa(s); };
  const loadImg = (src) => new Promise((res) => { const im=new Image(); const t=setTimeout(()=>res('timeout'),6000); im.onload=()=>{clearTimeout(t);res('ok:'+im.naturalWidth)}; im.onerror=()=>{clearTimeout(t);res('error')}; im.src=src; });
  const out = {};
  out.secureAtStart = window.isSecureContext;
  out.subtleAtStart = typeof (window.crypto && window.crypto.subtle);

  out.status = await OF.getStatus();
  await OF.ensureDir({ path: '${CH_DIR}' });

  // binary page write + cover
  await OF.writeFile({ path: '${CH_DIR}/0001.jpg', data: '${PNG_B64}' });
  await OF.writeFile({ path: '5/cover.png', data: '${PNG_B64}' });
  // text metadata
  const mangaJson = JSON.stringify({ id: 5, title: 'Test Series', chapters: 1 });
  await OF.writeFile({ path: '5/manga.json', data: btoa(unescape(encodeURIComponent(mangaJson))) });

  out.existsPage = (await OF.exists({ path: '${CH_DIR}/0001.jpg' })).exists;
  out.existsMissing = (await OF.exists({ path: '5/nope.jpg' })).exists;

  const lf = await OF.listFiles({ path: '5/chapters' });
  out.listFiles = lf.entries.map(e => e.name + (e.isDirectory ? '/' : ''));

  const rj = await OF.readFile({ path: '5/manga.json' });
  out.mangaJsonRoundTrip = decodeURIComponent(escape(atob(rj.data))) === mangaJson;

  // AES-GCM encrypt -> write -> read -> decrypt (binary integrity through fs+IPC)
  try {
    const wc = window.crypto;          // the page's Web Crypto (proven secure-context object)
    const subtle = wc.subtle;
    const SECRET = 'momotaro-secret-page-bytes';
    const key = await subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt','decrypt']);
    const iv = wc.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(SECRET)));
    const env = new Uint8Array(iv.length + ct.length); env.set(iv,0); env.set(ct,iv.length);
    await OF.writeFile({ path: '${CH_DIR}/0002.enc', data: bytesToB64(env) });
    const back = b64ToBytes((await OF.readFile({ path: '${CH_DIR}/0002.enc' })).data);
    const dec = new Uint8Array(await subtle.decrypt({ name:'AES-GCM', iv: back.slice(0,12) }, key, back.slice(12)));
    out.encRoundTrip = new TextDecoder().decode(dec) === SECRET;
    out.encEnvelopeBytes = env.length;
  } catch (e) { out.encRoundTrip = 'ERR:' + e.message; }

  // prepareFileForWebView -> momotaro-offline:// -> <img> render
  const pre = await OF.prepareFileForWebView({ path: '${CH_DIR}/0001.jpg' });
  out.fileUrl = pre.fileUrl;
  out.imgRender = await loadImg(conv(pre.fileUrl));

  return out;
})()
`;

(async () => {
  const report = { electron: process.versions.electron };
  let tmp = null;
  try {
    await app.whenReady();
    registerAppProtocol();
    setupContentSecurityPolicy(APP_SCHEME);

    // Pre-seed the plugin's persisted folder (bypass the interactive picker).
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-offline-'));
    const cfg = path.join(app.getPath('userData'), 'offline-folder.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ root: tmp }));
    report.seededRoot = tmp;

    win = new BrowserWindow({ show: false, width: 1000, height: 800,
      webPreferences: { preload: PRELOAD, nodeIntegration: true, contextIsolation: true, allowRunningInsecureContent: true } });
    await win.loadURL(`${APP_SCHEME}://-/`);
    await new Promise((r) => setTimeout(r, 900));

    report.probe = await win.webContents.executeJavaScript(probeJs);

    // Cross-check on disk from the main process.
    report.onDisk = {
      pageExists: fs.existsSync(path.join(tmp, '5/chapters/Vol.2 Ch.5 [9100]/0001.jpg')),
      coverExists: fs.existsSync(path.join(tmp, '5/cover.png')),
      mangaJsonExists: fs.existsSync(path.join(tmp, '5/manga.json')),
      pageBytes: fs.existsSync(path.join(tmp, '5/chapters/Vol.2 Ch.5 [9100]/0001.jpg'))
        ? fs.statSync(path.join(tmp, '5/chapters/Vol.2 Ch.5 [9100]/0001.jpg')).size : -1,
    };

    // Delete + confirm gone (renderer + disk).
    report.afterDelete = await win.webContents.executeJavaScript(`(async()=>{const OF=window.MomotaroElectron.OfflineFolder; await OF.deletePath({path:'5',recursive:true}); await OF.clearCache(); return { exists: (await OF.exists({path:'5/manga.json'})).exists };})()`);
    report.afterDelete.onDiskGone = !fs.existsSync(path.join(tmp, '5'));

    win.destroy();
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  } finally {
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(app.getPath('userData'), 'offline-folder.json'), { force: true }); } catch {}
  }
  fs.writeFileSync(path.join(__dirname, 'phase2-report.json'), JSON.stringify(report, null, 2));
  console.log('PHASE2_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('PHASE2_REPORT_END');
  app.exit(0);
})();
