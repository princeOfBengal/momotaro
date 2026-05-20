# Building the Momotaro Linux AppImage

The Linux desktop app is an [Electron](https://www.electronjs.org/) shell around
the **same** React/Vite build the PWA and Android app use — via
[`@capacitor-community/electron`](https://github.com/capacitor-community/electron),
the desktop analog of `npx cap add android`. Same UI, same pairing-first launch,
same offline subsystem; the native layer (immersive reader, offline folder,
download keep-alive) is re-implemented in the Electron main process.

The scaffold lives at [client/electron/](client/electron/). Architecture and the
phase-by-phase build log are in [docs/linux.md](docs/linux.md) and
`docs/linux-phase{0..4}.md`.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 18+ | Same Node that builds the web client. |
| **A Linux host or Docker** | — | **AppImage can only be assembled on Linux.** electron-builder needs `appimagetool`/`mksquashfs`, which don't run on Windows/macOS. Use a Linux box, WSL2, or the official `electronuserland/builder` Docker image (below). Everything *except* the final AppImage packaging is OS-agnostic. |

## Build steps (on Linux)

```bash
# 1. Build the React app (the shell packs whatever is in client/dist).
cd client
npm install
npm run build

# 2. Sync web assets into the Electron project. Use `sync` (not `copy`) when
#    package.json dependencies changed — same rule as Android.
npx cap sync @capacitor-community/electron

# 3. Build the Electron main process (TypeScript) + the AppImage.
cd electron
npm install
npm run electron:make      # tsc + electron-builder --linux AppImage
```

The AppImage lands at:

```
client/electron/dist-electron/Momotaro-<version>.AppImage
```

`chmod +x` it and run, or double-click in a file manager. (For desktop-menu
integration users can install [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher).)

### Building from Windows/macOS via Docker

```bash
# from repo root, after `cd client && npm run build && npx cap sync @capacitor-community/electron`
docker run --rm -ti \
  -v "$PWD/client/electron":/project \
  -w /project \
  electronuserland/builder:wine \
  /bin/bash -c "npm install && npm run electron:make"
```

> The current scaffold pins **Electron 26** (the template default). Before a
> public release, bump to a current Electron LTS (and the matching
> `electron-builder`) — see [docs/linux-phase4.md § Follow-ups](docs/linux-phase4.md).
> The Phase 0–4 verification ran on Electron 26.

## Self-hosted distribution

Like the Android APK, the AppImage is served by the Momotaro server itself. The
server exposes:

- `GET /api/app/version?platform=linux` — reads `data/downloads/version-linux.json`
  and returns `{ version, download_url, appimage_url, released_at, notes,
  size_bytes }`. 404 when nothing is published.
- `GET /downloads/momotaro.AppImage` — the binary (`express.static` mount).

### One-command deploy (recommended)

[scripts/deploy-linux-appimage.sh](scripts/deploy-linux-appimage.sh) builds the
AppImage and drops it + `version-linux.json` into the server's download dir in
one step. **Run it on Linux** (or in the Docker builder image — see below):

```bash
bash scripts/deploy-linux-appimage.sh
# → data/downloads/momotaro.AppImage + data/downloads/version-linux.json
# honours $DATA_PATH (default ./data); SKIP_BUILD=1 redeploys an existing build
```

> **Confirmed: the AppImage cannot be assembled on Windows.** A build attempt on
> Windows packages the app bundle (`resources/app.asar`) but fails at the
> AppImage step — electron-builder 23.6.0 routes Linux packaging on Windows to a
> remote build service that no longer exists, and the underlying tools
> (`appimagetool`/`mksquashfs`) are Linux-only. Build on Linux, in WSL2, or via
> the `electronuserland/builder` Docker image. (On a Linux host electron-builder
> assembles the AppImage locally — no remote service.)

### Manual deploy (equivalent steps)

```bash
# 1. Bump versions in lockstep before building:
#    - client/src/version.js            -> APP_VERSION (the value the update check compares)
#    - client/electron/package.json     -> version    (the AppImage artifact name)
#    Mismatched versions are the classic release bug.

# 2. Build the AppImage (see above).

# 3. Drop the AppImage + metadata into the server's data dir:
mkdir -p data/downloads
cp client/electron/dist-electron/Momotaro-*.AppImage data/downloads/momotaro.AppImage
cat > data/downloads/version-linux.json <<'EOF'
{
  "version": "1.7.1",
  "released_at": "2026-05-20",
  "notes": "Brief change summary shown in the update banner."
}
EOF
```

The Android channel (`version.json` + `momotaro.apk`) is independent — both can
be published side by side from the same `data/downloads/` dir.

### In-app update flow

Existing installs poll `GET /api/app/version?platform=linux` on launch
([useAppUpdateCheck.js](client/src/hooks/useAppUpdateCheck.js)), compare the
server's `version` to the bundled `APP_VERSION`, and show the
[UpdateBanner](client/src/components/UpdateBanner.jsx) when they differ. Tapping
**Update** opens `download_url` in the OS browser via
`window.MomotaroElectron.openExternal` (the desktop CTA — a plain
`target="_blank"` is blocked because navigation is locked to the app's custom
scheme). The user downloads the new AppImage and replaces the old file.

> A future v2 can switch to `electron-updater` for in-place AppImage updates
> (zsync) + relaunch; the scaffold already bundles it. v1 mirrors the Android
> "download + replace" flow exactly. See [docs/linux-phase4.md](docs/linux-phase4.md).

## Configuration

- **App ID / name**: `dev.momotaro.app` / `Momotaro` in
  [client/electron/electron-builder.config.json](client/electron/electron-builder.config.json)
  and [client/capacitor.config.json](client/capacitor.config.json).
- **Icon**: replace `client/electron/assets/appIcon.png` (Linux) /
  `appIcon.ico` (Windows).
- **HTTP servers**: the desktop shell talks to plain-HTTP self-hosted servers
  out of the box (`allowRunningInsecureContent` on a secure custom scheme — see
  [docs/linux-phase1.md](docs/linux-phase1.md)). No `androidScheme`-style change
  is needed; once your server is fronted with TLS it just works over HTTPS too.

## Run / develop without packaging

```bash
cd client && npm run build && npx cap sync @capacitor-community/electron
cd electron && npm run build
./node_modules/.bin/electron .     # launches the app against the built web assets
```

First launch routes to the pairing wizard: enter `http://<host>:<port>` and
redeem the PIN from the server's **Settings → Client Management**.
