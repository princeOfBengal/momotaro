// Phase 0 smoke test: can Electron launch headlessly in this environment?
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();

const done = (code, msg) => { console.log(msg); try { app.exit(code); } catch { process.exit(code); } };

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 400, height: 300 });
    await win.loadURL('data:text/html,<title>smoke</title><h1>ok</h1>');
    const r = await win.webContents.executeJavaScript('document.title');
    done(0, `SMOKE_OK electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node} title=${r}`);
  } catch (e) {
    done(1, 'SMOKE_FAIL ' + (e && e.stack || e));
  }
});
app.on('window-all-closed', () => app.quit());
setTimeout(() => done(2, 'SMOKE_TIMEOUT'), 30000);
