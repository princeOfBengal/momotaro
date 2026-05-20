# Linux AppImage — Phase 0 Compatibility Spike

**Status: ✅ GO.** Every load-bearing assumption behind the Linux-AppImage plan
(wrap the existing React/Capacitor build in a `@capacitor-community/electron`
shell, exactly as Android wraps it) is verified at runtime. Proceed to Phase 1.

Phase 0 is a *compatibility spike*, not packaging. It answers "will this
approach work at all?" before any plugin code is written. The AppImage build
itself is Linux-only and lands in Phase 4; the spike runs on the dev machine
(Windows) because the Capacitor⇄Electron integration it validates is
OS-agnostic — the same Chromium/Capacitor runtime ships in the Linux AppImage.

## Objective

Confirm, before investing in the three native-plugin ports:

1. `@capacitor-community/electron` installs against **Capacitor 8** (the version in [client/package.json](../client/package.json)).
2. `Capacitor.isNativePlatform()` returns **true** under the Electron shell — the single fact every `isNativeShell()`-gated feature depends on.
3. `Capacitor.getPlatform()` is `'electron'` (pairing's `detectPlatform()`).
4. `Capacitor.convertFileSrc` behavior (drives the OfflineFolder render path).
5. Secure context + Web Crypto work (at-rest offline encryption).
6. A custom protocol can serve an arbitrary on-disk file to `<img>` (offline page rendering).
7. The renderer can reach a **plain-HTTP** server via `fetch` + `<img>` (the self-hosted-server case; the Electron analog of Android's cleartext fight).

## Environment

| | |
|---|---|
| Node / npm (build tooling) | v26.1.0 / 11.13.0 |
| `@capacitor-community/electron` | **5.0.1** (latest) |
| Electron (template default) | 26.6.10 (Chromium 116, Node 18.16) |
| Capacitor core/cli (project) | 8.x |
| Spike host | Windows (integration is OS-agnostic; AppImage packaging deferred to Phase 4) |

## Result 1 — Capacitor 8 compatibility ✅

`@capacitor-community/electron@5.0.1` declares its Capacitor dependency as
**`@capacitor/core >=5.4.0`** and **`@capacitor/cli >=5.4.0`** — open-ended, no
upper bound, satisfied by 8.x. `npm install --save-dev @capacitor-community/electron`
completed with **no peer-dependency conflict**, and `npx cap add
@capacitor-community/electron` scaffolded `client/electron/` cleanly.

> The plugin-scan warning `Unable to find node_modules/@vitejs/plugin-react` is
> harmless — the Capacitor CLI scans dependencies for *native plugins* and
> trips over an unrelated Vite devDependency. No effect on the build.

`cap add` modified **neither `client/src` nor `capacitor.config.json`** — the
"one shared codebase, zero web-code changes" property holds at the scaffold
stage, mirroring Android.

## Result 2 — Runtime verification ✅

The harness ([client/electron/phase0-verify.cjs](../client/electron/phase0-verify.cjs))
loads the **real built React app** (`client/electron/app`) with the **real
compiled Capacitor preload** (`build/src/preload.js`) under the privileged
custom scheme — production-shaped — then probes each behavior, and spins a
local plain-HTTP server to stand in for a self-hosted Momotaro server. Output
captured in [client/electron/phase0-report.json](../client/electron/phase0-report.json).
Reproduced identically across two runs.

| Probe | Result | What it proves |
|---|---|---|
| `window.Capacitor` present | `true` | core runtime active |
| `CapacitorCustomPlatform.name` | `electron` | preload injects the custom platform |
| `getPlatform()` | `electron` | `Pairing.detectPlatform()` resolves correctly |
| **`isNativePlatform()`** | **`true`** | **every native-gated path lights up: pairing-first launch, immersive, offline folder, keep-alive, update check** |
| `convertFileSrc('/5/chapters/…/0001.jpg')` | returns input **unchanged** | identity on electron → offline plugin must return ready-to-load URLs |
| `isSecureContext` | `true` | required for Web Crypto |
| AES-GCM encrypt→decrypt round trip | `true` | **at-rest offline encryption works** ([offlineCrypto.js](../client/src/api/offlineCrypto.js)) |
| custom-protocol `<img src>` (arbitrary on-disk file) | `ok:1` | **offline page render path is viable** |
| plain-HTTP `<img src>` | `ok:1` | server cover/page images load |
| plain-HTTP `fetch('http://…/api/health')` | `ok:200` | **the app can talk to a self-hosted HTTP server** |

### How core resolves the platform (static confirmation)

- [@capacitor/core index.cjs.js:46-52](../client/node_modules/@capacitor/core/dist/index.cjs.js#L46): `getPlatform()` returns `win.CapacitorCustomPlatform.name` when present; `isNativePlatform() = getPlatform() !== 'web'`.
- [electron-rt.ts:84-87](../client/electron/src/rt/electron-rt.ts#L84): the preload exposes `CapacitorCustomPlatform = { name: 'electron', plugins }`.
- [index.cjs.js:186-192](../client/node_modules/@capacitor/core/dist/index.cjs.js#L186): `convertFileSrc` falls back to `(filePath) => filePath`; the electron platform defines no override → **identity** (verified at runtime above).
- [electron-serve/index.js:53-60](../client/electron/node_modules/electron-serve/index.js#L53): registers the app scheme `standard + secure + supportFetchAPI` → secure context (Web Crypto) + fetch.

## The verified production configuration

This exact configuration passed all probes and is what Phase 1 should adopt:

- **Scheme:** keep electron-serve's privileged custom scheme (`standard, secure, supportFetchAPI, stream`). Secure context is required for Web Crypto, so do **not** drop `secure`.
- **Window `webPreferences`:** `contextIsolation: true`, the Capacitor `preload`, **`allowRunningInsecureContent: true`**, leave `webSecurity: true`.
  - This combination is what makes a **secure-context** page reach a **plain-HTTP** server (`fetch` + `<img>`) — resolving the mixed-content question *without* sacrificing the secure context. No `androidScheme:http` analog is needed.
  - `webSecurity: false` was also tested and is a **dead end** — it fails to load the privileged custom scheme at all (`ERR_FAILED`). Don't use it.
- **CSP** ([setup.ts § setupContentSecurityPolicy](../client/electron/src/setup.ts#L220)) must be broadened from the template default. The template ships `default-src capacitor-electron://* 'unsafe-inline' data:`, which blocks server traffic. Verified-working policy includes:
  - `connect-src 'self' capacitor-electron: http: https:`
  - `img-src 'self' capacitor-electron: <offline-scheme>: http: https: data: blob:`

## Confirmed seams (predicted by the plan, now proven) and their resolutions

| Seam | Finding | Resolution / phase |
|---|---|---|
| `convertFileSrc` identity | offline plugin's `prepareFileForWebView` must return a **directly loadable** URL (not a bare `file://`) | OfflineFolder registers a streaming custom protocol; return its URL — **Phase 2** |
| Mixed content (secure scheme → HTTP server) | blocked by default; **`allowRunningInsecureContent: true` fixes it** while preserving secure context | window config — **Phase 1** |
| Restrictive default CSP | template CSP blocks server `fetch`/`img` | broaden `connect-src`/`img-src` — **Phase 1** |
| Navigation locked to custom scheme ([setup.ts:185-196](../client/electron/src/setup.ts#L185)) | `UpdateBanner`'s `<a target="_blank">` to the AppImage URL would be denied | use `shell.openExternal` via a small plugin/IPC — **Phase 4** |
| `window-all-closed` quits ([index.ts:53-59](../client/electron/src/index.ts#L53)) | closing the window kills in-progress downloads | minimize-to-tray / keep-alive while jobs run (template already has tray scaffolding) — **Phase 3** |
| `electron-updater` pre-wired ([index.ts:49](../client/electron/src/index.ts#L49)) | bonus — AppImage in-place update path is available | optional v2 update mechanism — **Phase 4** |

## Deferred (not Phase 0)

- **AppImage packaging** on Linux via electron-builder — **Phase 4**.
- The three native-plugin **implementations** (ImmersiveMode / OfflineFolder / DownloadKeepAlive) — **Phases 1–3**.
- **Electron version bump.** The template pins Electron 26 (Chromium 116). Production should move to a current Electron LTS; the spike's stale-typings `tsc` errors (template deps vs Node 26 `@types`) and the manual binary-extract workaround below go away with that bump.

## Reproduction

```bash
cd client
npm install                              # restores @capacitor-community/electron devDep
npm run build                            # produces client/dist
npx cap sync @capacitor-community/electron
cd electron
npm run build                            # tsc → build/src (emits despite stale-typing warnings)
./node_modules/electron/dist/electron.exe phase0-verify.cjs   # prints PHASE0_REPORT + writes phase0-report.json
```

> **Binary-download note (sandbox only):** in the spike environment the
> `electron` postinstall did not finish extracting its prebuilt binary
> (`node_modules/electron/dist` had only `locales`, no `electron.exe`), though
> the ~102 MB zip was fully cached by `@electron/get`. Fix used: extract the
> cached zip into `node_modules/electron/dist` and write `path.txt` containing
> `electron.exe`. On a normal dev machine the postinstall handles this; the
> production Electron-LTS bump is the durable fix.

## Working-tree footprint

- `client/package.json` + `client/package-lock.json` — added the `@capacitor-community/electron` devDependency.
- `client/electron/` — new scaffold. Its `.gitignore` excludes `app/`, `node_modules/`, `build/`, `dist/`, `logs/`, so a commit tracks only the editable shell source (`src/`, configs).
- Spike-only artifacts under `client/electron/`: `phase0-verify.cjs`, `phase0-smoke.cjs`, `phase0-report.json`, `phase0-offline/` — safe to delete; kept as re-runnable evidence.
- **No changes to `client/src` or `capacitor.config.json`.**
