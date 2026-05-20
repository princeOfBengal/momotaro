# Linux Desktop App (AppImage)

The Linux desktop app is an [Electron](https://www.electronjs.org/) shell around
the **same** React/Vite build the PWA and Android app use, via
[`@capacitor-community/electron`](https://github.com/capacitor-community/electron)
— the desktop analog of `npx cap add android`. It has one-to-one feature parity
with the Android app: same UI, same first-run **pairing** flow, same **offline**
subsystem (download queue, IndexedDB cache, filesystem scanner, at-rest
encryption), and the same self-hosted **update** mechanism.

Build + distribution: [BUILD_LINUX.md](../BUILD_LINUX.md). Shared web app:
[frontend.md](./frontend.md). Offline internals: [offline.md](./offline.md).
The Android counterpart this mirrors: [android.md](./android.md).

## Why Electron + Capacitor

`@capacitor-community/electron` makes `Capacitor.isNativePlatform()` return
`true` and `getPlatform()` return `'electron'`, so **every** code path the
Android app gates on `isNativeShell()` — pairing-first launch, immersive reader,
offline folder, download keep-alive, the update banner — activates unchanged.
The shared `client/src` needed only small, additive bridge branches.

## Architecture

```text
client/
├── src/                     # ONE shared React app (PWA + Android + Electron)
├── android/                 # Capacitor Android project (Java plugins)
└── electron/                # Capacitor Electron project
    ├── src/
    │   ├── index.ts         # main: window, single registerSchemesAsPrivileged, plugins, guarded autoUpdater
    │   ├── setup.ts         # BrowserWindow (allowRunningInsecureContent), broadened CSP, electron-serve
    │   ├── preload.ts       # exposes window.MomotaroElectron bridge
    │   └── plugins/         # in-tree native plugins (see below)
    │       ├── index.ts             # registerNativePlugins + App-openExternal
    │       ├── offline-folder.ts    # OfflineFolder + momotaro-offline:// protocol
    │       └── download-keep-alive.ts
    └── electron-builder.config.json # linux: AppImage
```

### Native plugins (Java → Electron)

| Android (Java) | Electron | Renderer bridge | What it does |
|---|---|---|---|
| ImmersiveModePlugin | ImmersiveMode | `MomotaroElectron.ImmersiveMode` | Reader fullscreen + hide menu bar |
| OfflineFolderPlugin (SAF) | OfflineFolder | `MomotaroElectron.OfflineFolder` | Folder picker + fs I/O + `momotaro-offline://` page streaming |
| DownloadKeepAlive + Service (FGS) | DownloadKeepAlive | `MomotaroElectron.DownloadKeepAlive` | Hide-to-tray on close so the queue survives; no-op handoff |
| — | App.openExternal | `MomotaroElectron.openExternal` | Open the update download in the OS browser |

**Why a custom `MomotaroElectron` bridge instead of `registerPlugin`:** Capacitor
core does not route bare `registerPlugin('Name')` calls to in-tree plugins on
Electron (no `PluginHeaders`, and it ignores `CapacitorCustomPlatform.plugins`),
and the only registry `cap sync` would use is regenerated on every sync. So the
in-tree plugins are plain `ipcMain` channels exposed under `window.MomotaroElectron`
in the hand-owned preload, and the shared bridges prefer it on desktop and fall
back to the Capacitor native bridge on Android.

## Key design decisions (verified)

- **Cleartext servers:** the renderer runs on a *secure* custom scheme (needed
  for Web Crypto / at-rest encryption) and reaches plain-HTTP self-hosted
  servers via `allowRunningInsecureContent: true` + a broadened CSP. No
  `androidScheme: http` analog needed.
- **One privileged-scheme call:** `protocol.registerSchemesAsPrivileged`
  *replaces* the list on each call, so the app scheme **and** `momotaro-offline`
  are declared together in one final call in `index.ts` — a separate call would
  strip the app scheme's `secure` flag and break encryption.
- **Keep-alive = hide-to-tray:** desktop processes aren't reclaimed like
  backgrounded Android WebViews; the only risk to the queue is the window
  closing, so an active download hides the window (renderer survives) and the app
  quits when the queue drains.

## Build log

Phase-by-phase implementation + verification:
[phase 0](./linux-phase0-spike.md) ·
[phase 1](./linux-phase1.md) ·
[phase 2](./linux-phase2.md) ·
[phase 3](./linux-phase3.md) ·
[phase 4](./linux-phase4.md).

## Status

Phases 0–4 implemented and verified on Electron 26 (Windows dev host; the
Capacitor⇄Electron runtime is OS-agnostic). Remaining before a public release:
assemble the AppImage on a Linux host/Docker, bump to an Electron LTS, and run
the manual end-to-end acceptance pass — see
[linux-phase4.md § Not done here](./linux-phase4.md).
