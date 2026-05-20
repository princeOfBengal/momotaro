# Linux AppImage — Phase 2: OfflineFolder + offline rendering

**Status: ✅ done & verified.** The desktop equivalent of the Android
SAF-backed offline storage works end-to-end: pick a folder, write/read manga
bytes and metadata, enumerate the tree, render downloaded pages in the reader,
round-trip AES-GCM-encrypted pages, and delete. Builds on
[Phase 1](./linux-phase1.md). The full offline subsystem
([offline.md](./offline.md)) — IndexedDB cache, download queue, filesystem
scanner, at-rest encryption — runs unchanged on top of this plugin.

## What landed

### OfflineFolder plugin
[client/electron/src/plugins/offline-folder.ts](../client/electron/src/plugins/offline-folder.ts)
— the Electron analog of [OfflineFolderPlugin.java](../client/android/app/src/main/java/dev/momotaro/app/OfflineFolderPlugin.java).
Implements the exact JS-bridge contract from
[client/src/api/offlineFolder.js](../client/src/api/offlineFolder.js):

| Method | Desktop implementation |
|---|---|
| `getStatus` / `pickFolder` / `clearFolder` | `dialog.showOpenDialog({openDirectory})`; the absolute path is persisted in `userData/offline-folder.json` (no SAF permission to pin — fs access is direct). `displayName` is the path. |
| `ensureDir` / `writeFile` / `readFile` / `exists` / `listFiles` / `deletePath` | plain `fs`/`fs.promises` against absolute paths under the root, base64 in/out (matches the bridge byte-for-byte), with a path-traversal guard. |
| `prepareFileForWebView` | returns a `momotaro-offline://file/<rel>` URL (per-segment encoded). **No cache-copy** — the Android copy existed only because `content://` can't load in a WebView; on desktop the protocol streams straight from disk. |
| `clearCache` | no-op (no mirror to wipe). |

`convertFileSrc` is the identity on electron (Phase 0), so the URL returned by
`prepareFileForWebView` is exactly what `<img src>` receives — served by the
privileged `momotaro-offline://` file protocol.

### Wiring
- [src/plugins/index.ts](../client/electron/src/plugins/index.ts) — `registerNativePlugins` now also calls `registerOfflineFolder`.
- [src/preload.ts](../client/electron/src/preload.ts) — `window.MomotaroElectron.OfflineFolder` with all 11 methods.
- [client/src/api/offlineFolder.js](../client/src/api/offlineFolder.js) — resolves `OfflineFolder` to the `MomotaroElectron` bridge on desktop, the `registerPlugin` proxy on Android (one-line, additive; every call site unchanged).

## ⚠️ Critical finding: `registerSchemesAsPrivileged` REPLACES, it doesn't accumulate

The offline render path needs a **privileged** `momotaro-offline://` scheme
(standard + secure) so a downloaded page loads inside the secure-context app
page. The trap:

- **`protocol.registerSchemesAsPrivileged` replaces the entire privileged-scheme
  list on every call** (the "can only be called once" docs really mean "later
  calls overwrite earlier ones").
- electron-serve registers the **app** scheme (secure) in its constructor. A
  *separate* second call for just `momotaro-offline` **silently stripped the app
  scheme's `secure` flag** → the page stopped being a secure context →
  `window.crypto.subtle` became `undefined` → **at-rest encryption would
  break**, even though pages still loaded and rendered.

This was invisible to a loadability check (images still rendered) and only
surfaced when the harness probed `window.isSecureContext` /
`crypto.subtle` and an actual AES-GCM round-trip.

**Fix:** declare **both** schemes in one final call in
[index.ts](../client/electron/src/index.ts), after electron-serve's call and
before `ready`. The plugin no longer registers the scheme itself.

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: myCapacitorApp.getCustomURLScheme(),
    privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: OFFLINE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
```

Takeaway for later phases: any new privileged scheme must be added to this single
list — never as an additional `registerSchemesAsPrivileged` call.

## Files changed

| File | Change |
|---|---|
| [client/electron/src/plugins/offline-folder.ts](../client/electron/src/plugins/offline-folder.ts) | **new** — OfflineFolder impl + `momotaro-offline://` file protocol |
| [client/electron/src/plugins/index.ts](../client/electron/src/plugins/index.ts) | register OfflineFolder; re-export `OFFLINE_SCHEME` |
| [client/electron/src/index.ts](../client/electron/src/index.ts) | single combined `registerSchemesAsPrivileged` (app + offline, both secure) |
| [client/electron/src/preload.ts](../client/electron/src/preload.ts) | `MomotaroElectron.OfflineFolder` bridge |
| [client/src/api/offlineFolder.js](../client/src/api/offlineFolder.js) | prefer the desktop bridge (additive; Android/web unchanged) |

## Verification

Harness [client/electron/phase2-verify.cjs](../client/electron/phase2-verify.cjs)
(report [phase2-report.json](../client/electron/phase2-report.json)) drives the
real OfflineFolder bridge through the offline stack's operations and
cross-checks on disk from the main process. The interactive picker is bypassed
by pre-seeding `offline-folder.json`.

| Check | Result |
|---|---|
| Secure context preserved after scheme fix | `isSecureContext: true`, `crypto.subtle: object` |
| `getStatus` after seed | `configured: true`, path returned |
| `ensureDir` + binary `writeFile` (page + cover) | on disk; page size `70` = exact PNG bytes |
| Text `writeFile`/`readFile` (manga.json) | round-trip identical |
| `exists` present / missing | `true` / `false` |
| `listFiles('5/chapters')` | `["Vol.2 Ch.5 [9100]/"]` (spaces + brackets intact) |
| **AES-GCM encrypt→write→read→decrypt** | **`true`** (envelope 54B = 12 IV + 26 + 16 GCM tag) — at-rest encryption end-to-end |
| `prepareFileForWebView` → protocol → `<img>` | `ok:1` (renders in the secure page) |
| recursive `deletePath('5')` | renderer `exists:false` **and** `onDiskGone:true` |

## Run it

```bash
cd client && npm run build && npx cap sync @capacitor-community/electron
cd electron && npm run build
./node_modules/electron/dist/electron.exe phase2-verify.cjs   # automated checks
./node_modules/electron/dist/electron.exe .                   # launch; Settings → Offline → choose a folder, download a series, read offline
```

## Deferred to later phases

- **DownloadKeepAlive** + minimize-to-tray so an active download survives window
  close — **Phase 3**. (Its bare `registerPlugin('DownloadKeepAlive')` calls
  still throw `Unimplemented` on electron but are caught by callers; the app
  boots and downloads run while the window is open.)
- **Update flow + AppImage packaging** (`shell.openExternal`, electron-builder,
  Electron-LTS bump) — **Phase 4**.
- The download **queue** itself ([downloader.js](../client/src/api/downloader.js))
  already works on top of this plugin (it only needs OfflineFolder + network);
  end-to-end series download against a live server is part of Phase 1/2 manual
  acceptance.
