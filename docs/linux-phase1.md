# Linux AppImage — Phase 1: Shell + Pairing + ImmersiveMode

**Status: ✅ done & verified.** The Electron shell boots the real React app,
routes a fresh launch through the pairing wizard (native-shell-first flow,
identical to Android), reaches a plain-HTTP server, and the first native plugin
(ImmersiveMode) works end-to-end. Builds on [Phase 0](./linux-phase0-spike.md).

## What landed

### 1. Shell configuration (the verified Phase 0 settings)
[client/electron/src/setup.ts](../client/electron/src/setup.ts):

- **`allowRunningInsecureContent: true`** on the main `BrowserWindow`. The
  custom scheme stays `secure` (so Web Crypto / at-rest encryption works), and
  this flag lets that secure-context renderer `fetch`/`<img>` a plain-HTTP
  self-hosted server. No `androidScheme: http` analog needed.
- **Broadened CSP** in `setupContentSecurityPolicy`. The template default
  (`default-src capacitor-electron://* …`) blocks all server traffic; the new
  policy adds `connect-src`/`img-src`/`media-src` for `http:`/`https:`, plus the
  `momotaro-offline:` scheme (reserved for Phase 2) and `data:`/`blob:` (for
  decrypted page blobs).

### 2. ImmersiveMode plugin (first Java→Electron port)
The Reader's fullscreen toggle ([client/src/api/immersive.js](../client/src/api/immersive.js)),
the desktop analog of [ImmersiveModePlugin.java](../client/android/app/src/main/java/dev/momotaro/app/ImmersiveModePlugin.java):
`enable()` hides the menu bar + fullscreens the window; `disable()` restores both.

### Plugin architecture decision (important for Phases 2–3)

Capacitor's `registerPlugin('Name')` (bare, as the shared bridges call it)
**does not work for in-tree plugins on Electron**:

- Core's `registerPlugin` proxy resolves a method via either a JS implementation
  passed to `registerPlugin`, or a `PluginHeader` (the native bridge). On
  Electron there are no `PluginHeaders`, and core **never consults**
  `window.CapacitorCustomPlatform.plugins` — so a bare call throws
  `Unimplemented`. (On Android the same bare call works because the native
  bridge injects `PluginHeaders`.)
- The only registry `setupCapacitorElectronPlugins()` reads,
  `src/rt/electron-plugins.js`, is **regenerated (clobbered) by every
  `cap sync`** — unusable for app-specific in-tree plugins.

**Chosen pattern (cap-sync-safe, used for all three plugins):**

| Side | File | Role |
|---|---|---|
| Main | [src/plugins/index.ts](../client/electron/src/plugins/index.ts) `registerNativePlugins()` | Registers plain `ipcMain.handle('${Plugin}-${method}')` channels. Not via electron-plugins.js, so `cap sync` can't clobber it. |
| Main wiring | [src/index.ts](../client/electron/src/index.ts) | Calls `registerNativePlugins(() => myCapacitorApp.getMainWindow())`. |
| Preload | [src/preload.ts](../client/electron/src/preload.ts) | Exposes `window.MomotaroElectron.<Plugin>.<method>` → `ipcRenderer.invoke(...)`. |
| Shared JS | [client/src/api/immersive.js](../client/src/api/immersive.js) | Prefers `window.MomotaroElectron` when present; falls back to the Capacitor native bridge on Android. |

`index.ts`, `setup.ts`, and `preload.ts` are created once by `cap add` and are
**not** touched by `cap sync` — safe to hand-edit. Phases 2–3 add OfflineFolder
and DownloadKeepAlive by registering more handlers in `registerNativePlugins`
and more methods on the `MomotaroElectron` bridge.

## Files changed

| File | Change |
|---|---|
| [client/electron/src/setup.ts](../client/electron/src/setup.ts) | CSP broadened; `allowRunningInsecureContent: true` |
| [client/electron/src/index.ts](../client/electron/src/index.ts) | import + `registerNativePlugins(...)` |
| [client/electron/src/preload.ts](../client/electron/src/preload.ts) | `window.MomotaroElectron` bridge |
| [client/electron/src/plugins/index.ts](../client/electron/src/plugins/index.ts) | **new** — in-tree plugin IPC handlers |
| [client/src/api/immersive.js](../client/src/api/immersive.js) | electron bridge branch (additive; Android/web paths unchanged) |
| [client/src/pages/Pairing.jsx](../client/src/pages/Pairing.jsx) | desktop device-name suggestion (`electron` → "Linux PC") |

Shared `client/src` changes are additive and don't alter Android/PWA behavior.

## Verification

Harness [client/electron/phase1-verify.cjs](../client/electron/phase1-verify.cjs)
(report: [phase1-report.json](../client/electron/phase1-report.json)) loads the
**real** built app + **real** compiled preload, applies the **real**
`setupContentSecurityPolicy`, and registers the **real** ImmersiveMode handlers.

| Check | Result |
|---|---|
| App boots, React mounts (`#root` populated) | `rootChildCount: 2` |
| FirstLaunchGate routes native shell → pairing | `location.pathname === '/pairing'` |
| Real pairing wizard rendered | body text: *"…WELCOME · Pair this device · Connect this device to your…"* |
| `isNativePlatform()` / `getPlatform()` | `true` / `electron` |
| `window.MomotaroElectron` + ImmersiveMode methods | present |
| Cleartext HTTP `fetch` under real CSP | `ok:200` |
| ImmersiveMode `enable()` | menu bar hidden + window fullscreen (`enter-full-screen` fired) |
| ImmersiveMode `disable()` | menu bar + windowed restored (`leave-full-screen` fired) |

> The offline banner appears in the body snippet because no real server is
> paired (health ping fails) — expected; the pairing wizard renders regardless,
> matching Android's native-shell-first behavior.

## Run it

```bash
cd client && npm run build && npx cap sync @capacitor-community/electron
cd electron && npm run build   # tsc (emits despite stale template-typing warnings)
./node_modules/electron/dist/electron.exe phase1-verify.cjs        # automated checks
./node_modules/electron/dist/electron.exe .                        # launch the app interactively
```

To pair against a live server: launch the app, enter `http://<host>:<port>` in
the wizard, and redeem the PIN from the server's **Settings → Client Management**.

## Deferred to later phases

- **OfflineFolder** plugin (folder picker + fs ops + `momotaro-offline://`
  streaming protocol for page rendering) — **Phase 2**.
- **DownloadKeepAlive** + tray / minimize-to-tray so downloads survive window
  close — **Phase 3**.
- **Update flow + AppImage packaging** (`shell.openExternal`, electron-builder,
  Electron-LTS bump) — **Phase 4**.
- The bare `registerPlugin('OfflineFolder')`/`('DownloadKeepAlive')` calls in
  the shared bridges currently throw `Unimplemented` on electron but are caught
  by their callers (verified: app boots cleanly); they get the
  `window.MomotaroElectron` branch in their phases.
