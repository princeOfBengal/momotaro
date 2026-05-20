# Offline Mode

The Android app keeps reading working without server connectivity. Users
pick a folder on their device once, queue downloads from any manga page,
and the bytes land in that folder with human-readable folder names. When
the network drops (or the user forces offline mode), the app routes
every read through a local IndexedDB cache backed by the filesystem —
the offline copy is the source of truth and IDB is just a fast index.

This doc covers the architecture: native plugins, JS modules, on-disk
layout, connectivity routing, the download queue, encryption, and the
filesystem-discovery path that makes downloads survive a Clear-Data
wipe. Build instructions live in [BUILD_ANDROID.md](../BUILD_ANDROID.md).

## Capabilities

| Capability | Where |
|---|---|
| Pick a download folder via Android's system document picker | `OfflineFolderPlugin.pickFolder` → SAF `ACTION_OPEN_DOCUMENT_TREE` |
| Persist the folder permission across reboots | `takePersistableUriPermission` in the same plugin |
| Queue chapter / series downloads from any manga page | `client/src/api/downloader.js` |
| Resume an interrupted queue on app re-launch | `initDownloader()` rehydrates from IndexedDB |
| Keep downloading while the app is backgrounded | `DownloadKeepAlivePlugin` foreground service |
| Detect offline state from three signals (browser event, native event, server ping) | `client/src/context/ConnectivityContext.jsx` |
| Route every `api.*` read to a local shim when offline | `OFFLINE_ROUTED_METHODS` in `client/src/api/client.js` |
| Render downloaded pages in `<img src>` from a SAF folder | `prepareFileForWebView` cache-copy |
| Survive IndexedDB wipes via filesystem-based discovery (v1.7) | `scanMangaFromDisk` in `client/src/api/offlineApi.js` |
| Optional at-rest AES-GCM encryption of page bytes | `client/src/api/offlineCrypto.js` |
| Wi-Fi-only setting, paused-status badge | `setNetworkAllowed` + `wifiOnly` in `ConnectivityContext` |
| Per-chapter delta refresh + stale-copy detection | `refreshOfflineSnapshot` / `isChapterStale` in `downloader.js` |
| Progress write outbox + flush on reconnect | `client/src/api/outboxSync.js` |
| Top-level `/downloads` queue management page | `client/src/pages/Downloads.jsx` |

## On-disk layout

The user picks a folder once via SAF and everything lives under it. Path
shape (v1.6.2+):

```text
<user-picked folder>/
└── <mangaId>/
    ├── manga.json                          # series metadata (full snapshot at download time)
    ├── cover.<ext>                         # cover image, plaintext (not encrypted by design)
    └── chapters/
        ├── Vol.2 Ch.5 - Title [9100]/      # friendly chapter folder, parseable name
        │   ├── meta.json                   # chapter metadata + page list
        │   ├── 0001.jpg                    # zero-padded page index
        │   ├── 0002.jpg
        │   └── ...
        ├── Vol.2 Ch.6 [9101]/              # missing title → just Vol/Ch
        ├── Ch.7 [9102]/                    # no volume info
        └── 9100/                           # legacy pre-v1.6.2 numeric layout (still readable)
```

**Folder naming.** `buildChapterDirName(chapter)` in
[client/src/api/downloader.js](../client/src/api/downloader.js) produces
the user-visible name; `parseChapterDirName(name)` is its inverse and is
exported for use by the filesystem scanner. Both cascade through several
shapes:

| Server fields | Folder name |
|---|---|
| volume + number + short title | `Vol.2 Ch.5 - Chapter Title [9100]` |
| volume + number | `Vol.2 Ch.5 [9100]` |
| number only | `Ch.5 [9100]` |
| volume only | `Vol.2 [9100]` |
| only the server's `folder_name` | `<sanitized folder_name> [9100]` |
| nothing usable | `Chapter [9100]` |

The trailing `[id]` is the unique key — every chapter the downloader has
ever written carries it. Spaces and hyphens stay; path-unsafe characters
(`/\\:*?"<>|`) get replaced with `_`. CJK series titles travel through
verbatim.

**Title-length cap.** Titles longer than 40 chars are dropped from the
folder name. Path depth + locale-specific filesystem limits make
`<root>/.../<mangaId>/chapters/<verbose name>/<pad>.<ext>` reach the
~255-char chapter limit on some Android setups; the cap keeps every
chapter dir well clear of it.

## Native plugins

The Android shell exposes three Capacitor plugins (all in
[client/android/app/src/main/java/dev/momotaro/app](../client/android/app/src/main/java/dev/momotaro/app/)):

| Plugin | Source | Purpose |
|---|---|---|
| `ImmersiveMode` | [ImmersiveModePlugin.java](../client/android/app/src/main/java/dev/momotaro/app/ImmersiveModePlugin.java) | Existing — toggles the system bars on the Reader page. |
| `DownloadKeepAlive` | [DownloadKeepAlivePlugin.java](../client/android/app/src/main/java/dev/momotaro/app/DownloadKeepAlivePlugin.java) + [DownloadKeepAliveService.java](../client/android/app/src/main/java/dev/momotaro/app/DownloadKeepAliveService.java) | Holds the process foreground while the JS download queue is active. Optional in-Java download worker that takes over on swipe-from-recents. |
| `OfflineFolder` | [OfflineFolderPlugin.java](../client/android/app/src/main/java/dev/momotaro/app/OfflineFolderPlugin.java) | Owns the SAF tree URI. Every filesystem operation in the offline subsystem flows through this plugin. |

Plugins are registered in
[MainActivity.java](../client/android/app/src/main/java/dev/momotaro/app/MainActivity.java)
before `super.onCreate()` so Capacitor's bridge picks them up during the
initial plugin scan.

### `OfflineFolder` — SAF tree URI owner

The user grants access to a folder once via Android's system document
picker (`Intent.ACTION_OPEN_DOCUMENT_TREE`). The returned tree URI is
pinned via `takePersistableUriPermission` and saved in `SharedPreferences`
(slot `momotaro_offline_folder` / key `tree_uri`). No
`WRITE_EXTERNAL_STORAGE` permission is requested — SAF grants access
via the URI itself, which works back to API 21 and is the only modern
way to write to user-visible folders without scoped-storage gymnastics.

| Method | Returns | Notes |
|---|---|---|
| `getStatus` | `{ configured, treeUri, displayName }` | `displayName` is derived from `DocumentsContract.getTreeDocumentId` (e.g. `Internal storage/Documents/Manga`) — falls back to the URI string. |
| `pickFolder` | same shape | Launches the picker via `startActivityForResult` → `onFolderPicked` callback. `cancelled: true` when the user dismisses. |
| `clearFolder` | — | Releases the persisted grant. Doesn't delete on-disk bytes. |
| `ensureDir({ path })` | `{ uri }` | mkdir-p over `DocumentFile.createDirectory`. Idempotent. |
| `writeFile({ path, data })` | — | base64-decoded write via `ContentResolver.openOutputStream`. Parent dirs auto-created. |
| `readFile({ path })` | `{ data }` | Returns base64. Used for metadata files. |
| `exists({ path })` | `{ exists }` | DocumentFile lookup. |
| `listFiles({ path })` | `{ entries: [{ name, isDirectory }, ...] }` | The filesystem-discovery scanner's only enumeration tool. |
| `deletePath({ path, recursive })` | — | Recursive variant walks `DocumentFile.listFiles()`. |
| `prepareFileForWebView({ path })` | `{ fileUrl }` | Copies the SAF file into `getCacheDir()/offline-mirror/<relPath>`. The returned `file://` URL is what `Capacitor.convertFileSrc` rewrites to a WebView-loadable URL. |
| `clearCache` | — | Wipes the offline-mirror. Triggered on folder change so stale cached pages don't keep resolving. |

The cache-copy in `prepareFileForWebView` is necessary because
`content://` URIs from SAF can't be loaded directly by the WebView in
Capacitor 8 — there's no built-in `WebViewAssetLoader` for SAF. The
mirror is keyed by relative path so subsequent renders of the same page
reuse the existing cached file (skipped when size matches). Android may
evict the mirror under storage pressure; the worst case is a re-copy on
next render.

### `DownloadKeepAlive` — foreground service

The Java plugin owns a notification-backed foreground service whose only
job is to keep the app's process alive while the queue is running. The
JS download loop itself stays in the WebView; the service just ensures
Android doesn't reclaim the process under Doze or memory pressure.

| Method | Notes |
|---|---|
| `start({ title, text })` | Promotes the service via `startForeground` with `FOREGROUND_SERVICE_TYPE_DATA_SYNC`. Idempotent — subsequent calls update the notification. Requests `POST_NOTIFICATIONS` on first call (Android 13+). |
| `update({ text })` | Refreshes the notification text — used to surface per-page progress. |
| `stop` | `stopForeground(STOP_FOREGROUND_REMOVE)` + `stopSelf`. |
| `setPlanState(plan)` | Persists a JSON plan to `SharedPreferences` (`plan_json`) and bumps `plan_epoch`. Used by the optional native-handoff path. |
| `consumeProgressReport` | Drains anything the in-Java worker completed while the JS context was gone. Used on app boot to reconcile state. |
| `isSupported` | Returns `{ supported, notificationsGranted }`. |

The `Service.onTaskRemoved` hook fires when the user swipes the app from
recents. The current v1.6+ implementation deliberately ignores the
handoff plan for SAF-mode users — the Java service can't write to a SAF
tree without going through the OfflineFolder plugin's DocumentFile-
backed methods, and the service doesn't have a reference to that plugin
instance. The plan-state push from `downloader.syncPlanStateToNative()`
always sends an empty `jobs` array + `encryptionActive: true` to lock
the worker out. Foreground downloads continue normally; only the
swipe-from-recents survival case is disabled. A future revision can
teach the service to use SAF directly.

Manifest entries the plugins require (in
[AndroidManifest.xml](../client/android/app/src/main/AndroidManifest.xml)):

```xml
<service
    android:name=".DownloadKeepAliveService"
    android:exported="false"
    android:stopWithTask="false"
    android:foregroundServiceType="dataSync" />

<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

## JS modules

```text
client/src/
├── api/
│   ├── client.js                 # Routed `api.*` proxy + OFFLINE_ROUTED_METHODS allowlist
│   ├── offlineFolder.js          # Thin JS bridge over the OfflineFolder plugin
│   ├── offlineStorage.js         # Facade: isAvailable/isConfigured/pickFolder/clearFolder + file ops
│   ├── offlineDb.js              # IndexedDB schema (offline_manga, offline_chapters, offline_pages, download_jobs, progress_outbox, meta)
│   ├── offlineApi.js             # Drop-in offline shims for api.* methods + filesystem scanner
│   ├── offlineCrypto.js          # Optional PBKDF2 + AES-GCM via Web Crypto
│   ├── downloader.js             # Queue worker, chapter naming, plan-state sync, refresh, delta detection
│   ├── downloadKeepAlive.js      # Thin JS bridge over the DownloadKeepAlive plugin
│   └── outboxSync.js             # Replays buffered progress writes on reconnect
└── context/
    └── ConnectivityContext.jsx   # Three-signal connectivity probe + offline banner + downloads-allowed gate
```

### `ConnectivityContext`

Three signals combine into a single `online` boolean:

1. `navigator.onLine` + browser `online`/`offline` events.
2. `@capacitor/network` listener (more reliable on Android — the WebView
   events don't always fire).
3. Periodic ping to `${serverUrl}/api/health` — the only signal that
   catches "Wi-Fi up but the server is unreachable." Polled every 30 s
   when online, 7.5 s when offline, with a 5 s timeout per attempt.

The user can also force offline via Settings → Offline Downloads, which
flips `mode` to `offline-forced` regardless of the ping result. The
combined state drives:

- `online` — used by every page that gates behavior on connectivity.
- `downloadsAllowed` — `online && (networkType in {wifi, ethernet, unknown} || !wifiOnly)`. Pushed to the downloader via `setNetworkAllowed`.
- `<ConnectivityBanner />` — the top-of-app status bar.

### API routing in `client.js`

The user-facing `api.*` object is a wrapper around `rawApi.*` (the
network surface). On every call, the wrapper checks `isOfflineNow()` —
which `ConnectivityContext` sets to `() => !online` via
`setConnectivityProbe`. When offline, only methods listed in
`OFFLINE_ROUTED_METHODS` are routed; everything else falls straight
through to the raw network call (which fails fast with `TypeError:
Failed to fetch`, which the UI lockdown handles).

The allowlist currently covers:

```js
'getLibrary', 'getManga', 'getChapters', 'getChapter', 'getPages',
'getProgress', 'getHome',
'getLibraries', 'getReadingLists', 'getReadingListManga',
'getGenres', 'getAllGallery',
'getAnilistStatus', 'getMangaReadingLists', 'getGallery',  // v1.6.1
'updateProgress', 'markChapterRead',
```

Adding a method to this set without also adding a shim in `offlineApi.js`
is the most common way to break offline mode — the wrapper will route
the call, find no implementation, and fall through to the network. The
shim should return a shape that matches what the server emits in the
"feature not configured" path (e.g.
`getAnilistStatus` → `{ logged_in: false }`) so the UI's null-safe
render paths pick it up without branching.

### IndexedDB (cache, not authoritative)

[client/src/api/offlineDb.js](../client/src/api/offlineDb.js) wraps the
`idb` library and exposes six object stores in DB `momotaro-offline`:

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `offline_manga` | `id` | `by_downloaded_at`, `by_title` | One row per downloaded series. `search_text` is a lowercased title+alt+author+tags blob used by the offline-search substring match. |
| `offline_chapters` | `id` | `by_manga`, `by_manga_status` | Carries `encrypted`, `chapter_dir_path`, `server_updated_at` for delta detection. |
| `offline_pages` | `[chapter_id, page_index]` | `by_chapter`, `by_page_id` | Pre-computed `local_path` per page so render is one IDB lookup. |
| `download_jobs` | autoinc `id` | `by_status`, `by_manga`, `by_chapter`, `by_created_at` | FIFO queue with `'queued' / 'running' / 'done' / 'failed' / 'cancelled'`. |
| `progress_outbox` | `chapter_id` | `by_manga` | Buffered `updateProgress`/`markChapterRead` writes. Latest-per-chapter collapse. |
| `meta` | `key` | — | Key/value scratchpad: crypto salt, challenge, enabled flag. |

**The store is no longer authoritative as of v1.7.** When a row is
missing, `offlineApi.getManga`/`getChapter`/`getPages` fall through to
the filesystem scanner and re-populate the IDB rows from disk. This
makes the offline copy survive Clear Data, browser DB corruption, or
manual file moves between devices.

### `offlineApi.js` — drop-in `api.*` shims + filesystem scanner

The shims emit response shapes that match what the server returns
verbatim, so MangaDetail / Reader / Library don't branch on connectivity.
Each routed method has a two-tier resolution:

1. **IDB fast path.** Query the relevant store. If the rows are there,
   return them.
2. **Filesystem fallback.** Walk the SAF tree via `OfflineFolder.listFiles`
   to reconstruct the missing rows from on-disk artifacts. Best-effort
   re-populates IDB so the next call hits the fast path.

The scanner is rooted at `scanMangaFromDisk(mangaId)`:

- Reads `<mangaId>/manga.json` for series metadata.
- Lists `<mangaId>/chapters/` and runs each entry name through
  `parseChapterDirName` (imported from
  [downloader.js](../client/src/api/downloader.js)).
- For each chapter, reads `<chapterDir>/meta.json` for the page list
  + `encrypted` flag.
- Re-derives `cover_url` by globbing `<mangaId>/cover.*` and resolving
  via `srcUrl` — the URL baked into manga.json at download time may
  refer to a previous picked-folder context.
- Synthesizes a chapter row if meta.json is missing, falling back to
  listing image files and assigning local IDs as
  `chapterId * 10000 + pageIndex` (collision-free across chapters,
  recoverable on re-rehydration when meta.json eventually shows up).

`findChapterDirPath(chapterId)` is the slow-path locator for the
Reader → `getPages` → IDB-miss → no-known-manga case. It walks every
top-level folder under the SAF root, looks at each `<id>/chapters/`,
and matches the `[id]` suffix. O(N×M) over series and chapters, but
only runs once per cold chapter — the result is cached back into IDB.

### Encryption

[client/src/api/offlineCrypto.js](../client/src/api/offlineCrypto.js)
provides optional at-rest encryption for **page bytes only**. Covers
and `manga.json` stay plaintext so the Library grid renders without a
per-frame crypto cost; the threat model (someone with raw filesystem
bytes) isn't meaningfully degraded by exposing titles and 300×430
thumbnails.

- **KDF**: PBKDF2-HMAC-SHA256, 250,000 iterations, 16-byte random salt.
- **AEAD**: AES-GCM-256, 12-byte random IV per file. Envelope is `[IV][ct]`.
- **Persistence**: salt + challenge ciphertext live in `meta` IDB store.
  The derived key is held in process memory only — closing the app
  forgets it, so the user re-enters the passphrase via
  Settings → Offline Downloads or the Reader's inline `ReaderUnlockGate`.
- **Per-chapter flag**: `offline_chapters.encrypted` (IDB) AND
  `meta.json#encrypted` (disk). Mixed-mode libraries (some chapters
  plaintext, some encrypted) work correctly — `getPages` reads the
  per-chapter flag at the start of every render.
- **Render path**: encrypted pages go through `decryptToBlobUrl` →
  `URL.createObjectURL(new Blob([plain]))` → revoked in
  `releasePageBlobs()` on chapter unmount.

When encryption is enabled but the store is locked,
`maybeEncrypt`/`maybeDecrypt` throw `ENCRYPTION_LOCKED`. The downloader's
`assertEncryptionUnlockedIfEnabled()` short-circuits the pump and any
queued jobs sit in `'queued'` state (not `'failed'`) until the user
unlocks via Settings or the Reader gate. `downloader.resumeAfterUnlock()`
wakes the pump after a successful unlock.

## The download queue

[client/src/api/downloader.js](../client/src/api/downloader.js) owns the
JS-side queue. Lifecycle:

```text
            ┌── notify() ──→ syncPlanStateToNative() (Java cache)
            │
queueChapter│  queueSeries
            │                 ┌── ENCRYPTION_LOCKED → 'queued'
            ▼                 │   (resumeAfterUnlock retries)
       ┌────────┐   pump      ▼              ┌── ctrl.aborted + PAUSE_REASON → 'queued'
       │ queued │ ─────→ runJob ──→ downloadChapter ──→  ┌── success → 'done'
       └────────┘                                        ├── ctrl.aborted (explicit) → 'cancelled'
            ▲                                            └── any other error → 'failed'
            │                          ┌────────┐
            └── retryJob ──────────────│ failed │
                                       └────────┘
```

**`runJob` is the worker.** It promotes the FGS via `keepAliveStart` on
the first job, drains the queue serially (single-threaded — one chapter
at a time keeps memory bounded and is friendlier to mobile radios), and
calls `keepAliveStop` after the queue empties.

**Network gating.** `_networkAllowed` is the runtime gate the
`ConnectivityContext` flips via `setNetworkAllowed(downloadsAllowed)`.
When false, `pump` exits cleanly and any in-flight controller is
aborted with the `PAUSE_REASON` sentinel — `runJob`'s catch handler
sees the reason and re-queues (vs `'cancelled'` for explicit user
cancels). Same mechanism handles Wi-Fi-only flipping while on cellular.

**Per-chapter delta refresh.** `refreshOfflineSnapshot(mangaId)`
re-fetches the `/api/manga/:id/offline-package` payload, three-way
diffs against the local chapter rows, and re-queues anything where:

- `page_count` drifted (server-side CBZ was replaced), OR
- `server_updated_at` advanced past the local copy.

The conservative branch on missing-local-timestamp avoids restaging
every pre-P3 chapter on the first refresh after upgrade.

**Stale-copy CTA.** MangaDetail's `SeriesDownloadButton` checks
`isOfflineSnapshotStale(mangaId, manga.updated_at)` on mount + after
every queue event. When the local snapshot's `server_updated_at` is
older than the manga's current `updated_at`, the button swaps from
"Downloaded ✓" → "Refresh offline copy."

## Server endpoint

One server-side addition supports the queue:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/manga/:id/offline-package` | Single batched payload — manga metadata + cover URL + full chapter list + `server_updated_at`. Used by `queueSeries` so a series download is one HTTP round-trip instead of two (manga + chapters), and by `refreshOfflineSnapshot` for stale-copy detection. |

Implementation in
[server/src/routes/library.js](../server/src/routes/library.js). The
chapters query aliases `file_mtime AS updated_at` — the `chapters`
table has no literal `updated_at` column; `file_mtime` is the scanner-
maintained per-chapter mtime which is the right value for staleness
comparison.

## Settings UI

Offline Downloads lives in [Settings.jsx](../client/src/pages/Settings.jsx)
as its own section (`OfflineDownloadsSection`). It exposes:

| Card | What it does |
|---|---|
| Offline Mode toggle | Force-offline regardless of network state. Persisted in `localStorage` (`momotaro_force_offline`). |
| At-rest Encryption | Three-state UI (off / locked / on) — `EncryptionCard`. |
| Auto-download next chapter | Triggers `queueChapter` for the next chapter when the Reader gets within 3 pages of the end. Off by default. |
| Wi-Fi only | Gates downloads behind `networkType === 'wifi'`. |
| Download Folder | Current pick + "Choose folder" / "Clear" buttons → `OfflineFolder.pickFolder` / `clearFolder`. |
| Download Queue | First N jobs, with Retry / Cancel. |
| Downloaded Series | Per-series Delete. |

A separate top-level page at `/downloads`
([Downloads.jsx](../client/src/pages/Downloads.jsx)) is the full queue +
library manager. Linked from Settings for users with more than a handful
of downloads.

## Offline lockdown

Pages that would otherwise crash on dead `api.*` calls render an
offline-aware fallback instead. Two patterns in use:

- **Section-level greyed-out sidebar items** —
  [Settings.jsx](../client/src/pages/Settings.jsx) `OFFLINE_LOCKED_SECTIONS`
  is the allowlist of sections that *can* run without the server
  (Reading prefs, Android, Offline Downloads). Everything else greys out
  in the sidebar and shows `<OfflineLockedPanel />` when clicked.
- **Per-route wrapper** —
  [ThirdPartySourcing.jsx](../client/src/pages/ThirdPartySourcing.jsx)
  uses a connectivity-checking wrapper that switches the entire page
  body between the real implementation and an offline placeholder,
  avoiding rules-of-hooks violations from skipping mount-time effects.
- **Inline button gating** —
  [Library.jsx](../client/src/pages/Library.jsx)'s "Scan Library" button
  and [AppSidebar.jsx](../client/src/components/AppSidebar.jsx)'s
  reading-list create button stay rendered but `disabled` when offline.

## Version history

| Version | Code | What landed |
|---|---|---|
| 1.5 | 5 | P1–P4: IndexedDB schema, drop-in offline `api.*` shims, JS download queue, MangaDetail + Reader integration, Wi-Fi-only setting, foreground service keepalive, per-chapter at-rest encryption, stale-copy refresh. Storage was `Directory.External + <subfolderName>`. |
| 1.6 | 7 | Storage moved to SAF tree URIs. New `OfflineFolderPlugin` (`pickFolder` / `writeFile` / `readFile` / etc.). Settings folder UI switched from text input to picker button. `NoOfflineFolderError` gates downloads until a folder is picked. Legacy `momotaro_offline_root` localStorage cleared on first boot. Native swipe-away handoff disabled for SAF mode. |
| 1.6.1 | 8 | Added `getAnilistStatus`, `getMangaReadingLists`, `getGallery` to `OFFLINE_ROUTED_METHODS` + matching shims so MangaDetail's mount Promise.all stops rejecting offline. |
| 1.6.2 | 9 | `offlineApi.getManga` now reads chapters from IDB and includes them in the response (was missing — caused "No chapters found" offline). New downloads land in `Vol.X Ch.Y - Title [id]` folders. `chapter_dir_path` persisted on the IDB chapter row so delete operations resolve the right folder. |
| 1.7 | 10 | Filesystem-as-source-of-truth. `OfflineFolder.listFiles` enumerates SAF directories. `scanMangaFromDisk` rebuilds the offline state from `manga.json` + chapter folder names + per-chapter `meta.json`. `getManga` / `getChapter` / `getPages` are IDB-first, FS-fallback, rehydrate-on-fallback. Downloads survive Clear-Data wipes. `meta.json` now carries the per-chapter `encrypted` flag so encryption flows through the FS path correctly. |

Older versions (1.0–1.4) shipped without an offline subsystem and are
historical.
