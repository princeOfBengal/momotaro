# Linux AppImage — Feature Parity Audit

**Verdict: ✅ parity confirmed for the audited surface.** Offline mode,
manga downloading, and on-device (filesystem) scans in offline mode all work on
the Electron/Linux build. The audit combined a code review of the shared offline
subsystem with **running the real shared code in the Electron renderer**, not
just inspection.

## Method

1. **Code audit** of every shared offline module against the Electron
   `OfflineFolder`/`DownloadKeepAlive` plugin contracts:
   [offlineApi.js](../client/src/api/offlineApi.js),
   [offlineStorage.js](../client/src/api/offlineStorage.js),
   [offlineFolder.js](../client/src/api/offlineFolder.js),
   [downloader.js](../client/src/api/downloader.js),
   [offlineDb.js](../client/src/api/offlineDb.js),
   [offlineCrypto.js](../client/src/api/offlineCrypto.js),
   [ConnectivityContext.jsx](../client/src/context/ConnectivityContext.jsx).
2. **Runtime execution of the real `offlineApi` chunk** in the Electron renderer
   ([audit-offline-verify.cjs](../client/electron/audit-offline-verify.cjs),
   report [audit-offline-report.json](../client/electron/audit-offline-report.json)) —
   a manga laid out exactly as `downloader.js` writes it, with a fresh `userData`
   so IndexedDB starts empty and **every read is forced through the on-device
   filesystem scanner**.
3. **Platform-branch sweep** of `client/src` for any `getPlatform()`/`android`/
   `ios` logic that could mishandle `electron`.

Earlier phase harnesses provide the supporting primitive evidence
([phase 0–4 docs](./linux.md)).

## Parity matrix

| Android capability | Electron status | Evidence |
|---|---|---|
| Pairing-first launch | ✅ | [phase 1](./linux-phase1.md): boots → `/pairing` |
| Talk to plain-HTTP server | ✅ | [phase 1](./linux-phase1.md): cleartext fetch `ok:200` |
| Immersive reader | ✅ | [phase 1](./linux-phase1.md): fullscreen toggle |
| Pick download folder + fs I/O | ✅ | [phase 2](./linux-phase2.md): OfflineFolder ops |
| Render downloaded pages | ✅ | [phase 2](./linux-phase2.md) + this audit: `momotaro-offline://` `<img>` `ok:1` |
| At-rest AES-GCM encryption | ✅ | [phase 2](./linux-phase2.md): encrypt→write→read→decrypt round-trip |
| Keep queue alive in background | ✅ (hide-to-tray) | [phase 3](./linux-phase3.md) |
| Self-hosted update + PWA download | ✅ | [phase 4](./linux-phase4.md) + Settings "Linux" section |
| **Offline mode (detect + route)** | ✅ | below |
| **Downloading manga** | ✅ | below |
| **On-device scan in offline mode** | ✅ | below |

## Focus area 1 — Offline mode ✅

**Detection** (`ConnectivityContext`) combines three signals; on Electron:
- `navigator.onLine` + `online`/`offline` events — work in the Chromium renderer (`navigatorOnLine: true` observed).
- `@capacitor/network` — on the Electron custom platform Capacitor core resolves the plugin's **web implementation** (it ignores `'electron'` and falls back to `'web'`), so `Network.getStatus`/`addListener` work; if the import ever fails, the code explicitly falls back to the `navigator` path.
- `/api/health` ping — plain fetch, works (phase 1).
- Force-offline toggle — `localStorage`, platform-independent.

**Observed:** in [phase 1](./linux-phase1.md) with no server reachable, the app
rendered the offline banner ("You are offline — server unreachable. Downloaded
content is still available."), proving `ConnectivityContext` detects offline and
the `ConnectivityBanner`/probe wiring runs on Electron.

**Routing** (`api` → `offlineApi`) is connectivity-based shared code; the offline
shim it routes to is verified in Focus area 3.

## Focus area 2 — Downloading manga ✅

The download queue ([downloader.js](../client/src/api/downloader.js)) is
platform-agnostic JS; every platform-specific primitive it relies on is verified
on Electron:

| Download step | Primitive | Evidence |
|---|---|---|
| Fetch page/cover bytes from server | `fetch` to http(s) | phase 1 (`ok:200`) |
| Write pages / cover / `manga.json` / `meta.json` | `OfflineFolder.writeBytes/writeText/ensureDir` | phase 2 (exact 70-byte PNG on disk; text round-trip) |
| Encrypt-on-write | `offlineCrypto.maybeEncrypt` (Web Crypto) | phase 2 (AES-GCM round-trip) |
| Cover URL for the grid | `srcUrl` → `momotaro-offline://` | phase 2 + this audit (renders) |
| Stay alive while downloading | `DownloadKeepAlive` (hide-to-tray) | phase 3 |
| Persist/resume the queue | `download_jobs` in IndexedDB | runs at boot via `initDownloader` (app boots cleanly) |

**Closed loop:** this audit writes a manga in the **exact on-disk format the
downloader produces** and proves the scanner reads and renders it — so
"what the downloader writes" ↔ "what the reader/scanner consumes" is verified
end to end on Electron.

> The only step not exercised here is the live orchestration against a running
> Momotaro server (it needs a real server with manga). That path is
> platform-agnostic `fetch` + the verified primitives above; it is the manual
> acceptance step (identical to Android, where a network download likewise can't
> be unit-tested without a server). Run it via Settings → Offline → choose a
> folder → a manga's "Download" button.

## Focus area 3 — On-device scans in offline mode ✅

The filesystem-as-source-of-truth scanner (`scanMangaFromDisk` /
`scanChapterFoldersForManga` / `scanPagesFromDisk` / `findChapterDirPath` in
[offlineApi.js](../client/src/api/offlineApi.js)) was run as **real code** in the
Electron renderer with **IndexedDB empty**, so the only way to answer was to walk
the disk via the Electron `OfflineFolder` plugin:

| Call (IDB empty → forced FS scan) | Result |
|---|---|
| `getManga(5)` | reconstructed: title, author, `genres:[Action,Drama]`, `chapter_count:1`, `chapters:[9100]`, `cover_url` = `momotaro-offline://…`, `is_offline:true` |
| `getChapters(5)` | `[{id:9100, number:1, volume:1, title:'Intro'}]` |
| `getChapter(9100)` | `{id:9100, manga_id:5}` (via top-level `listFiles('')` walk) |
| `getPages(9100)` | 2 pages from `meta.json`, each `_local_src` = `momotaro-offline://…` |
| first page `<img>` render | **`ok:1`** (renders in the secure page) |
| `pageImageUrl(111)` (sync cache) | `momotaro-offline://…` (populated by `getPages`) |
| IDB rehydration → `getLibrary()` | `[5]` |
| → `getHome().recently_added` | `[5]` |

This is the same code path Android uses (introduced in v1.7); it operates purely
through the `OfflineFolder` facade, which the Electron plugin implements with
plain `fs` + the `momotaro-offline://` streaming protocol. Special characters in
chapter folder names (spaces, `[id]` brackets) round-trip correctly.

## Platform-branch sweep — clean

Every `getPlatform()`/`android`/`ios` branch in shared code handles `electron`
correctly:
- [client.js](../client/src/api/client.js) — `getAppVersion` selects the linux channel.
- [Pairing.jsx](../client/src/pages/Pairing.jsx) — `electron` → "Linux PC".
- [Settings.jsx](../client/src/pages/Settings.jsx) — Android update card is APK-only; new Linux section.
- The three native bridges (`immersive`/`offlineFolder`/`downloadKeepAlive`) prefer `window.MomotaroElectron` on desktop.
- [InstallPrompt.jsx](../client/src/components/InstallPrompt.jsx) — correctly **inert** on the desktop shell (desktop viewport gate; `beforeinstallprompt` never fires in Electron). No broken PWA banner.

## Notes (shared characteristics, not Linux gaps)

- **`getLibrary` is IndexedDB-only.** After a *full* IndexedDB wipe, the offline
  library list is empty until a specific manga is accessed (which FS-scans and
  rehydrates IDB — verified above). This is the **same on Android** (the v1.7
  scanner is per-manga, not a boot-time full-disk rescan). A boot-time
  "rebuild library from disk" pass would be a shared enhancement for both
  platforms, not a Linux-specific fix.
- **`networkType` is `unknown`/`ethernet` on desktop**, so the "Wi-Fi only
  downloads" gate is effectively a no-op there — correct for a desktop with no
  metered-connection concept.

## Conclusion

The Linux AppImage has feature parity with the Android app for offline mode,
downloading, and on-device offline scans. The offline data path was verified by
executing the real shared code on Electron; the download path's every primitive
is verified and its on-disk format is proven readable. Remaining before release
is unchanged from [phase 4](./linux-phase4.md): assemble the AppImage on Linux,
bump Electron to an LTS, and a manual live-server download/read acceptance pass.
