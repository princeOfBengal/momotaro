# Linux AppImage — Phase 3: DownloadKeepAlive + keep-the-queue-alive

**Status: ✅ done & verified.** The third and last Java→Electron plugin. Downloads
survive the user closing the window, the no-op native-handoff contract is in
place, and a tray icon + notification surface background activity. Builds on
[Phase 2](./linux-phase2.md).

## The desktop model (why it's simpler than Android)

Android needs a **foreground service** because the OS reclaims a backgrounded
WebView under Doze / memory pressure, which would kill the JS download queue's
process ([offline.md § DownloadKeepAlive](./offline.md)).

A desktop Electron process is **not** reclaimed while running or minimized. The
only thing that kills the queue (which lives in the **renderer**) is the window
being **closed** (renderer destroyed). So the desktop "keep alive" is:

> While a download is active, intercept a window **close** and **hide** the
> window to the tray instead of destroying it — the renderer and its queue keep
> running. When the queue drains (`stop`) and the window is hidden, quit the app
> (the user did ask to close it).

There is no separate background worker, so the native-handoff methods are no-ops
— matching Android's SAF mode, where the handoff is already inert
([downloader.js `syncPlanStateToNative`](../client/src/api/downloader.js) sends
an empty plan).

## What landed

[client/electron/src/plugins/download-keep-alive.ts](../client/electron/src/plugins/download-keep-alive.ts)
— `registerDownloadKeepAlive(getMainWindow)`, implementing the bridge contract
from [client/src/api/downloadKeepAlive.js](../client/src/api/downloadKeepAlive.js):

| Method | Desktop behavior |
|---|---|
| `start({title,text})` | mark active; attach the close→hide interceptor to the window; show a tray icon; set tooltip. |
| `update({text})` | refresh tray tooltip with progress. |
| `stop()` | clear active; remove tray; if the window is currently hidden (user closed it mid-download) → `app.quit()`. |
| `requestPermissions` | resolve `{notifications:'granted'}` (desktop needs no runtime grant). |
| `setPlanState` | **no-op** (renderer is the worker; nothing to hand off). |
| `consumeProgressReport` | **`{reports:[]}`** (nothing ran in a separate process). |
| `isSupported` | `{supported:true, notificationsGranted:<Notification.isSupported()>}`. |

Behavior details:
- **Close interception** is attached to the main window and only `preventDefault`s
  while a download is active (and not already quitting). Inactive close → normal
  quit path (`window-all-closed` in [index.ts](../client/electron/src/index.ts) is
  unchanged).
- **Tray** (`Show Momotaro` / `Quit`, click to restore) appears during downloads
  using `assets/appIcon.*`; creation is best-effort (try/catch) so a headless /
  no-display environment never breaks the queue.
- **Background notification** fires once when a download is hidden to tray
  ("Still downloading… click the tray icon to reopen").

## Wiring & files changed

| File | Change |
|---|---|
| [client/electron/src/plugins/download-keep-alive.ts](../client/electron/src/plugins/download-keep-alive.ts) | **new** — plugin impl, close interceptor, tray, notification |
| [client/electron/src/plugins/index.ts](../client/electron/src/plugins/index.ts) | `registerDownloadKeepAlive(getMainWindow)` |
| [client/electron/src/preload.ts](../client/electron/src/preload.ts) | `MomotaroElectron.DownloadKeepAlive` (7 methods) |
| [client/src/api/downloadKeepAlive.js](../client/src/api/downloadKeepAlive.js) | prefer the desktop bridge (additive; Android/web unchanged) |

No new privileged scheme → no `registerSchemesAsPrivileged` changes (see the
Phase 2 caveat).

## Verification

Harness [client/electron/phase3-verify.cjs](../client/electron/phase3-verify.cjs)
(report [phase3-report.json](../client/electron/phase3-report.json)) drives the
real bridge and the window lifecycle:

| Check | Result |
|---|---|
| Bridge present; `requestPermissions` | `{notifications:'granted'}` |
| `isSupported` | `{supported:true, notificationsGranted:true}` |
| `consumeProgressReport` (no-op handoff) | `{reports:[]}` |
| `setPlanState` (no-op, no throw) | `setPlanOk:true` |
| **A.** close while active | window `destroyed:false, visible:false` — hidden to tray, renderer/queue survive |
| **B.** `stop()` while visible | `destroyed:false, visible:true`, app alive (no quit) |
| **C.** `stop()` while hidden | `stopQuitWhenHidden:true` — app quit fired |

## Run it

```bash
cd client && npm run build && npx cap sync @capacitor-community/electron
cd electron && npm run build
./node_modules/electron/dist/electron.exe phase3-verify.cjs   # automated checks
./node_modules/electron/dist/electron.exe .                   # launch; start a download, close the window → it minimizes to tray and keeps downloading
```

## All three native plugins now ported

| Android (Java) | Electron | Phase |
|---|---|---|
| ImmersiveModePlugin | ImmersiveMode (fullscreen + menu bar) | 1 |
| OfflineFolderPlugin (SAF) | OfflineFolder (fs + `momotaro-offline://`) | 2 |
| DownloadKeepAlive + Service (FGS) | DownloadKeepAlive (hide-to-tray) | 3 |

The desktop app now has functional parity with the Android app's native layer.
Remaining: **Phase 4** — self-hosted update flow (`shell.openExternal` + a Linux
version channel) and AppImage packaging via electron-builder (plus the
Electron-LTS bump).
