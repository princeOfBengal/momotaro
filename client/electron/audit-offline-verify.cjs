/*
 * Parity audit — runs the REAL shared offline code (client/src/api/offlineApi.js)
 * in the Electron renderer against an on-disk manga laid out exactly as
 * downloader.js writes it. A fresh userData makes IndexedDB start EMPTY, so
 * every read is forced down the on-device filesystem-scanner path
 * (scanMangaFromDisk) — the feature the user asked to verify.
 *
 * Verifies: getManga (FS scan), getChapters/getChapter (top-level walk),
 * getPages (page reconstruction + momotaro-offline:// URL render), IDB
 * rehydration making the manga appear in getLibrary/getHome.
 */
const electron = require('electron');
const { app, BrowserWindow, protocol } = electron;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { registerNativePlugins } = require('./build/src/plugins/index.js');
const { setupContentSecurityPolicy } = require('./build/src/setup.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// Fresh userData → empty IndexedDB this run → forces the filesystem scanner.
const freshUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-ud-'));
app.setPath('userData', freshUserData);

const APP_DIR = path.join(__dirname, 'app');
const PRELOAD = path.join(__dirname, 'build', 'src', 'preload.js');
const APP_SCHEME = 'capacitor-electron';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let win = null;

// Lay down a downloaded manga in the EXACT on-disk layout downloader.js writes.
const offlineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-off-'));
const CH_DIR = '5/chapters/Vol.1 Ch.1 - Intro [9100]';
function W(rel, buf) {
  const p = path.join(offlineRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
}
W('5/cover.png', PNG);
W('5/manga.json', Buffer.from(JSON.stringify({
  id: 5, title: 'Test Series', author: 'A. Author', genres: ['Action', 'Drama'],
  chapter_count: 1, server_updated_at: 1, downloaded_at: Date.now(),
})));
W(CH_DIR + '/0000.jpg', PNG);
W(CH_DIR + '/0001.jpg', PNG);
W(CH_DIR + '/meta.json', Buffer.from(JSON.stringify({
  id: 9100, manga_id: 5, number: 1, volume: 1, title: 'Intro', page_count: 2, encrypted: false,
  pages: [
    { id: 111, page_index: 0, filename: '0000.jpg', width: 800, height: 1200, local_path: CH_DIR + '/0000.jpg' },
    { id: 112, page_index: 1, filename: '0001.jpg', width: 800, height: 1200, local_path: CH_DIR + '/0001.jpg' },
  ],
})));

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
]);
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'momotaro-offline', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
registerNativePlugins(() => win);

const probeJs = (chunk) => `
(async () => {
  const out = {};
  const mod = await import('/assets/${chunk}');
  const OA = mod.offlineApi;
  out.imported = !!OA;
  const loadImg = (src) => new Promise((res) => { const im = new Image(); const t = setTimeout(() => res('timeout'), 5000); im.onload = () => { clearTimeout(t); res('ok:' + im.naturalWidth); }; im.onerror = () => { clearTimeout(t); res('error'); }; im.src = src; });

  // On-device scan: IDB is empty, so this must reconstruct from disk.
  const m = await OA.getManga(5);
  out.manga = m && { id: m.id, title: m.title, author: m.author, genres: m.genres, chapter_count: m.chapter_count, chapters: (m.chapters || []).map(c => c.id), coverScheme: (m.cover_url || '').split(':')[0], is_offline: m.is_offline };

  out.getChapters = (await OA.getChapters(5)).map(c => ({ id: c.id, number: c.number, volume: c.volume, title: c.title }));
  const ch = await OA.getChapter(9100); out.getChapter = ch && { id: ch.id, manga_id: ch.manga_id };

  const pages = await OA.getPages(9100);
  out.pages = pages.map(p => ({ id: p.id, idx: p.page_index, scheme: (p._local_src || '').split(':')[0] }));
  out.firstPageRender = pages[0] ? await loadImg(pages[0]._local_src) : 'no-pages';
  out.pageImageUrlSync = (OA.pageImageUrl(111) || '').split(':')[0]; // populated by getPages

  // Rehydration: after the scan, the manga should now be in IDB-backed views.
  await new Promise(r => setTimeout(r, 400));
  out.library = (await OA.getLibrary()).map(x => x.id);
  out.homeRecent = ((await OA.getHome()).recently_added || []).map(x => x.id);

  // Connectivity signals available to ConnectivityContext on this platform.
  out.navigatorOnLine = navigator.onLine;
  out.platform = window.Capacitor.getPlatform();
  return out;
})()
`;

(async () => {
  const report = { electron: process.versions.electron };
  try {
    await app.whenReady();
    fs.writeFileSync(path.join(app.getPath('userData'), 'offline-folder.json'), JSON.stringify({ root: offlineRoot }));
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

    const chunk = fs.readdirSync(path.join(APP_DIR, 'assets')).find((f) => /^offlineApi-.*\.js$/.test(f));
    report.offlineApiChunk = chunk || null;
    if (!chunk) throw new Error('offlineApi chunk not found in app/assets');
    report.test = await win.webContents.executeJavaScript(probeJs(chunk));

    win.destroy();
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  } finally {
    try { fs.rmSync(offlineRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(freshUserData, { recursive: true, force: true }); } catch {}
  }
  fs.writeFileSync(path.join(__dirname, 'audit-offline-report.json'), JSON.stringify(report, null, 2));
  console.log('AUDIT_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('AUDIT_REPORT_END');
  app.exit(0);
})();
