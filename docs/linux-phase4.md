# Linux AppImage — Phase 4: self-hosted update + packaging

**Status: ✅ code complete & verified; AppImage binary build pending a Linux
host.** The self-hosted update flow (server channel + in-app banner +
`shell.openExternal`) is implemented and tested, and electron-builder is
configured for AppImage output. The only step that cannot run in this
Windows/sandbox environment is the actual `.AppImage` assembly, which requires
Linux/Docker (see [BUILD_LINUX.md](../BUILD_LINUX.md)). Builds on
[Phase 3](./linux-phase3.md).

## What landed

### Server — per-platform update channel
[server/src/routes/appVersion.js](../server/src/routes/appVersion.js) now serves
`GET /api/app/version?platform=android|linux`:

- `linux` → reads `data/downloads/version-linux.json`, serves `momotaro.AppImage`, returns `appimage_url`.
- `android` → unchanged (`version.json` / `momotaro.apk` / `apk_url`). **`platform` defaults to `android`**, so existing Android clients are untouched.
- Both return a generic `download_url`; 404 when nothing is published; 400 for an unknown platform.

### Client — platform-aware update check
- [client/src/api/client.js](../client/src/api/client.js) `getAppVersion()` sends `platform=linux` on the Electron shell (`Capacitor.getPlatform()==='electron'`), `android` otherwise.
- [useAppUpdateCheck.js](../client/src/hooks/useAppUpdateCheck.js) uses the generic `download_url` (falls back to `apk_url`).
- [UpdateBanner.jsx](../client/src/components/UpdateBanner.jsx) "Update" CTA: on desktop calls `window.MomotaroElectron.openExternal(downloadUrl)` (a plain `target="_blank"` is blocked — navigation is locked to the app scheme); on Android, the existing anchor.

### Desktop — openExternal bridge
- [preload.ts](../client/electron/src/preload.ts) — `window.MomotaroElectron.openExternal(url)`.
- [src/plugins/index.ts](../client/electron/src/plugins/index.ts) — `ipcMain.handle('App-openExternal', …)` → `shell.openExternal`, **guarded to http(s) only**.
- [index.ts](../client/electron/src/index.ts) — electron-updater's auto-check is now gated to packaged builds and `.catch()`-guarded (the self-hosted banner is the v1 update path; electron-updater is a documented v2 follow-up).

### Packaging
- [electron-builder.config.json](../client/electron/electron-builder.config.json) — `appId: dev.momotaro.app`, `productName: Momotaro`, `linux.target: ["AppImage"]`, category, icon, `artifactName: Momotaro-${version}.AppImage`, output `dist-electron/`.
- [client/electron/package.json](../client/electron/package.json) `version` bumped to **1.7.1** to match `APP_VERSION` (kept in lockstep — the AppImage artifact name vs the update-check version).
- [tsconfig.json](../client/electron/tsconfig.json) — `skipLibCheck: true`, so `npm run build` (`tsc`) now exits 0 (the stale template-typing errors were all in `node_modules` `.d.ts` files).
- [BUILD_LINUX.md](../BUILD_LINUX.md) — full build + self-hosted distribution + Docker cross-build instructions (parallel to BUILD_ANDROID.md).

### Settings subsetting + PWA download (Android-parity UX)

Mirrors the Android distribution UX (download link from the PWA → install →
update prompts → manual "check for updates" in Settings):

- **New "Linux" settings section** ([Settings.jsx](../client/src/pages/Settings.jsx)
  `LinuxSection`, registered in `SECTIONS` next to "Android"):
  - **Download AppImage** card — rendered on every platform, so a user browsing
    the **PWA** on a Linux desktop can grab the installer (a normal download
    anchor in the browser; routed through `openExternalUrl` in the desktop shell,
    where in-app navigation off the app scheme is blocked).
  - **Update check** card — only inside the Electron shell; "Check for updates"
    compares `APP_VERSION` against the Linux channel and offers "Download update"
    via the OS browser.
- The **Android** section's update-check card is now scoped to the APK
  (`nativePlatform() === 'android'`) so it no longer appears in the desktop app;
  its "Download APK" link still shows everywhere (parity with how the APK is
  grabbed from the PWA). New helpers `nativePlatform()` / `openExternalUrl()`
  replace the old `isNativeShell()`.
- Passive update prompts after install are the [UpdateBanner](../client/src/components/UpdateBanner.jsx)
  (already platform-aware from this phase).

## Verification

| Area | Method | Result |
|---|---|---|
| Server channel | standalone express + temp `DOWNLOADS_DIR` | 404 when unpublished (both); linux → `version 2.0.0`, `download_url`+`appimage_url` = `/downloads/momotaro.AppImage`, `size_bytes`; android default + explicit → `apk_url`+`download_url` (back-compat); unknown platform → 400 |
| `tsc` build | `npm run build` | exit 0 (clean) |
| openExternal bridge | [phase4-verify.cjs](../client/electron/phase4-verify.cjs) (report [phase4-report.json](../client/electron/phase4-report.json)) | `hasOpenExternal:true`, `platform:electron`; https URL round-trips renderer→main→`shell.openExternal`; `file://` rejected by the guard (only the https URL reached `openExternal`) |
| Linux settings subsetting | [phase4-settings-verify.cjs](../client/electron/phase4-settings-verify.cjs) (report [phase4-settings-report.json](../client/electron/phase4-settings-report.json)) | in the desktop shell at `/settings`: "Linux" nav present, "Download AppImage" card renders, electron-only "Check for updates" card renders, AppImage path shown; "Android" section still present |

(The server route test was a throwaway harness in `server/`, removed after the run; its output is captured above.)

## Not done here — needs a Linux host (next, mechanical)

1. **Assemble the AppImage.** AppImage packaging requires Linux tooling
   (`appimagetool`/`mksquashfs`), so it cannot run on Windows/macOS. On a Linux
   box, WSL2, or via the `electronuserland/builder` Docker image:
   ```bash
   cd client && npm run build && npx cap sync @capacitor-community/electron
   cd electron && npm install && npm run electron:make
   # → client/electron/dist-electron/Momotaro-1.7.1.AppImage
   ```
   The config is well-formed and the file layout (`build/`, `app/`, `assets/`)
   is the same one validated by every phase harness; only the final compression
   step is Linux-only.

2. **Electron-LTS bump.** The scaffold pins Electron 26 (Chromium 116) — the
   template default. Bump to a current Electron LTS + matching `electron-builder`
   before a public release (security + Chromium currency). All Phase 0–4
   verification ran on Electron 26; re-run the harnesses after the bump.

3. **Manual end-to-end acceptance** (on the built AppImage): pair → browse →
   read; pick an offline folder, download a series, read offline; publish a
   higher `version-linux.json` and confirm the update banner → "Update" opens the
   AppImage download in the browser.

## v2 follow-up (optional)
Switch the desktop update from "download + replace" (current, mirrors Android)
to `electron-updater` in-place AppImage updates (zsync) + relaunch. The scaffold
already bundles `electron-updater`; this needs a publish feed + signing.
