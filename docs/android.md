# Android App

The Android app is a [Capacitor](https://capacitorjs.com/) wrapper around the
same React/Vite build the PWA serves. Same code, same UI; the wrapper adds a
native shell, a first-run pairing flow that reaches out to the server's
public pairing API, and a self-hosted update mechanism that points back at
the Momotaro instance itself.

Build instructions live in [BUILD_ANDROID.md](../BUILD_ANDROID.md) — this
doc covers the architecture, the non-obvious config decisions, and where to
look when something breaks.

## Architecture

```text
client/
├── src/                           # React SPA — same code the PWA serves
│   ├── App.jsx                    # FirstLaunchGate routes native shell to /pairing
│   ├── pages/Pairing.jsx          # 5-step PIN pairing wizard
│   ├── hooks/useAppUpdateCheck.js # Polls /api/app/version on launch
│   ├── components/UpdateBanner.jsx# Bottom-fixed "update available" card
│   ├── version.js                 # APP_VERSION constant (must match build.gradle)
│   └── api/client.js              # rewriteMediaUrls() makes server URLs absolute post-pairing
├── capacitor.config.json          # androidScheme: http, hostname: momotaro.app
└── android/                       # Capacitor-generated Android project
    ├── app/
    │   ├── build.gradle           # Signing config reads ../key.properties
    │   └── src/main/
    │       ├── AndroidManifest.xml          # usesCleartextTraffic + NSC reference
    │       └── res/xml/network_security_config.xml  # permits cleartext globally
    ├── build.gradle               # AGP 9.2.1
    ├── gradle/wrapper/            # Gradle 9.4.1
    ├── key.properties             # gitignored — release signing credentials
    └── key.properties.example     # template
```

## WebView origin

`capacitor.config.json`:

```json
{
  "server": {
    "androidScheme": "http",
    "hostname": "momotaro.app"
  },
  "android": {
    "allowMixedContent": true
  }
}
```

Two non-obvious choices here:

- **`androidScheme: "http"`** — the WebView serves the bundled SPA from
  `http://momotaro.app` instead of Capacitor's default `https://localhost`.
  When the user's server speaks plain HTTP (the common self-hosted case),
  HTTPS-page-fetching-HTTP triggers mixed-content blocking in newer
  Chromium WebView versions. `allowMixedContent` no longer overrides this
  reliably; the OS-level `usesCleartextTraffic` + NetworkSecurityConfig
  also weren't enough. Forcing the WebView itself to HTTP made the
  source-and-destination schemes match and resolved the block. Switch
  back to `"https"` once the server is fronted with TLS.
- **`hostname: "momotaro.app"`** — Chromium caches HSTS at the WebView
  system level, **persisting across app uninstalls**. A previous build
  that served from `https://localhost` left an HSTS entry that auto-upgraded
  later `http://localhost` loads back to HTTPS, re-triggering the cleartext
  block. A non-`localhost` hostname sidesteps the cached entry entirely.
  `momotaro.app` is never resolved over the network — the WebView treats
  it as a custom internal scheme handled by Capacitor's `WebViewLocalServer`.

## Cleartext at the OS layer

`AndroidManifest.xml` declares both flags:

```xml
<application
    android:usesCleartextTraffic="true"
    android:networkSecurityConfig="@xml/network_security_config">
```

And `res/xml/network_security_config.xml` permits cleartext globally:

```xml
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

This is necessary because the app talks to plain-HTTP Momotaro servers by
default. Once you put HTTPS in front of the server, tighten this to
`cleartextTrafficPermitted="false"` (or scope cleartext to your LAN range
via a `<domain-config>` block) — Play Store flags app-wide cleartext during
review.

## First-launch routing

[client/src/App.jsx § FirstLaunchGate](../client/src/App.jsx) decides where
to send the user on app start. The native-shell case is the interesting one:

```js
if (isNativeShell() && !api.getServerUrl() && !api.getClientToken()) {
  setDecision('redirect');  // → /pairing
  return;
}
```

In the APK the WebView origin is `http://momotaro.app` — there is no real
server at that hostname, so the usual `getAuthStatus()` probe would fail.
The early-return avoids that doomed call entirely and sends a fresh install
straight into the pairing wizard.

PWA visitors skip the early-return because they were loaded *from* the
server they want to pair with (same-origin), so the regular probe works.

## Pairing wizard

[client/src/pages/Pairing.jsx](../client/src/pages/Pairing.jsx) is a 5-step
flow:

1. Welcome screen.
2. **Server URL** — user types `http://<host>:<port>`; the wizard calls
   `GET /api/health` to validate before continuing.
3. **Device name** — pre-filled from the user-agent.
4. **PIN entry** — wizard calls `POST /api/pairing/request` to start the
   handshake, then waits for the user to type the 6-digit PIN visible in
   the server's **Settings → Client Management** UI. Submitting via
   `POST /api/pairing/submit-pin` mints a long-lived bearer token.
5. Success → token persisted to `localStorage` as `momotaro_client_token`;
   subsequent API calls send it as `Authorization: Bearer <token>`.

The server side is documented in [api.md § Pairing](./api.md#pairing).

## Media URL rewriting

The server's library / home / gallery responses bake **server-relative**
URLs into JSON: `cover_url: "/thumbnails/05/5.webp"`,
`page_image_url: "/api/pages/123/image"`. In the PWA these resolve
same-origin against the server. In the APK the WebView origin is
`http://momotaro.app`, so the same relative URLs would resolve to a path
the Capacitor asset shell has never heard of — every `<img>` would break.

[client/src/api/client.js § rewriteMediaUrls](../client/src/api/client.js)
walks every JSON response after `apiFetch` parses it and rewrites the
URLs that match `/thumbnails/...` or `/api/pages/N/image`:

1. **Prepends the saved server URL** when the URL starts with `/` and a
   server URL is configured. The relative `/thumbnails/05/5.webp` becomes
   the absolute `http://<host>:<port>/thumbnails/05/5.webp`.
2. **Appends `?t=<token>`** for the same reason `api.thumbnailUrl()` and
   `api.pageImageUrl()` do — `<img src>` requests don't carry the
   `Authorization` header, so the server's auth middleware accepts the
   token via query string as a fallback.

The rewrite is gated on `clientToken` presence. Pre-pairing flows
(health-check, PIN handshake) skip the walk entirely so they take the
exact code path that worked before any media rewriting existed.

## Build chain

Compatibility matrix as of this writing:

| Component | Version | Why |
|---|---|---|
| JDK | 26 | What the contributor had installed. JDK 21 (LTS) also works. |
| Gradle | 9.4.1 | First Gradle line that runs on JDK 24+. 8.x errors with "Unsupported class file major version 70". |
| Android Gradle Plugin | 9.2.1 | First AGP whose `JdkImageTransform` accepts the output of JDK 26's `jlink`. 8.x fails the transform on `core-for-system-modules.jar`. |
| Capacitor | 8.3.4 | Bundled in `package.json`. Untested against AGP 9, but the debug + release builds work in practice. |
| `compileSdkVersion` / `targetSdkVersion` | 36 | Android 16. AGP 8.10+ minimum. |
| `minSdkVersion` | 24 | Android 7.0. Capacitor 8 floor. |

AGP 9 dropped support for the non-optimize ProGuard default;
[client/android/app/build.gradle](../client/android/app/build.gradle) uses
`proguard-android-optimize.txt` accordingly. Minification stays off in
release for now (`minifyEnabled false`) — turning it on requires verifying
Capacitor's reflective JNI hooks survive R8, which hasn't been done.

## Release signing

`assembleRelease` reads `client/android/key.properties` (gitignored) and
applies `signingConfigs.release` only if that file is a regular file.
Missing file → release build fails with a clear error rather than silently
producing an unsigned APK. The signing block in
[client/android/app/build.gradle](../client/android/app/build.gradle):

```groovy
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
if (keystorePropertiesFile.isFile()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        if (keystorePropertiesFile.isFile()) {
            release {
                storeFile     file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias      keystoreProperties['keyAlias']
                keyPassword   keystoreProperties['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
            if (keystorePropertiesFile.isFile()) {
                signingConfig signingConfigs.release
            }
        }
    }
}
```

The `.isFile()` check (not `.exists()`) catches the surprise case where a
contributor accidentally creates `key.properties` as a directory — Windows
`mkdir` on a non-existent path silently does this and Gradle's
`FileInputStream` then errors with "Access is denied" several frames deep.

Keystore generation, file format, and the full release workflow live in
[BUILD_ANDROID.md § Release builds](../BUILD_ANDROID.md#release-builds).

## Self-hosted distribution

The signed APK lives on the Momotaro server itself, served alongside the
PWA. No app store, no review, no Google account.

### Server side

| Path | Source | Description |
|---|---|---|
| `GET /api/app/version` | [server/src/routes/appVersion.js](../server/src/routes/appVersion.js) | Reads `data/downloads/version.json` and returns `{ version, apk_url, released_at, notes, size_bytes }`. 404 when no APK is published. Public — pre-pairing clients need to discover updates. |
| `GET /downloads/momotaro.apk` | `express.static` mounted in [server/src/index.js](../server/src/index.js) | Serves the APK file. Public — the system browser tab that handles `.apk` downloads can't carry a bearer token, and the APK is client code not secrets. |

The version metadata file at `data/downloads/version.json`:

```json
{
  "version": "1.1",
  "released_at": "2026-05-15",
  "notes": "Brief change summary shown in the update banner."
}
```

Flat-file rather than a DB row deliberately — the release process is
`cp app-release.apk → data/downloads/momotaro.apk` plus editing one
small JSON file, easy to script later without schema migrations.

### Client side

| File | Role |
|---|---|
| [client/src/version.js](../client/src/version.js) | `APP_VERSION` constant. **Must be kept in sync with `versionName` in `build.gradle`** when releasing. |
| [client/src/hooks/useAppUpdateCheck.js](../client/src/hooks/useAppUpdateCheck.js) | Polls `GET /api/app/version` on mount. Gates on `Capacitor.isNativePlatform()` so the PWA stays silent. Per-version dismissal in `localStorage[momotaro_dismissed_update_version]`. |
| [client/src/components/UpdateBanner.jsx](../client/src/components/UpdateBanner.jsx) | Bottom-fixed card mounted at the App root. Hidden on `/read/:chapterId`. "Update" is an `<a target="_blank">` to the APK URL — Android handles the download + install prompt. |

The banner does **not** try to install the APK in-app. Doing so would
require `REQUEST_INSTALL_PACKAGES` permission and a `FileProvider` URI
dance; the system handler is well-trodden, works without extra perms,
and only requires the user to allow "Install unknown apps" for their
browser once.

### End-to-end update flow

1. Maintainer cuts a release — bumps `versionCode` + `versionName` in
   `build.gradle`, bumps `APP_VERSION` in `client/src/version.js`,
   `assembleRelease`, copies the signed APK to
   `data/downloads/momotaro.apk`, updates `data/downloads/version.json`.
2. Existing v1.0 installs launch the app — `useAppUpdateCheck` hits
   `/api/app/version`, sees `1.1`, compares to bundled `1.0`, sets banner
   state.
3. User taps the banner — system browser opens, downloads the APK, prompts
   user to install. Android replaces the installed app in place (signature
   matches because the maintainer kept the same release keystore).

## Update-flow failure modes

All are silent — `useAppUpdateCheck` returns `null` and the banner stays
hidden:

- No saved server URL (pre-pairing) — nothing to ask.
- `/api/app/version` returns 404 — server hasn't published an APK yet.
- Network error — the server is down or unreachable; not the moment to
  surface an update prompt.
- User has dismissed this exact version before — re-prompting on the same
  version is noise.

The intent is the banner only ever appears when there's something genuinely
actionable for the user.

## Production hardening checklist

Before exposing the server to the public internet with the app installed on
real users' devices:

- **HTTPS**: front the server with Caddy / Cloudflare Tunnel / nginx and
  switch `capacitor.config.json` back to `"androidScheme": "https"`.
  Auth tokens travel in cleartext today; that's only acceptable on a LAN.
- **Cleartext config**: once HTTPS is in front, tighten
  [network_security_config.xml](../client/android/app/src/main/res/xml/network_security_config.xml)
  to `cleartextTrafficPermitted="false"`.
- **Backup the keystore**: losing `momotaro-release.jks` means you can
  never update the app under the same package ID. Store it offsite —
  encrypted cloud backup, password manager attachment, hardware token,
  whatever you trust.
- **Minification**: flip `minifyEnabled true` in the release block of
  `app/build.gradle`. Reduces APK size by ~40%. Test pairing afterwards —
  R8 occasionally strips reflective hooks Capacitor needs.
- **Privacy policy**: even for sideload-only distribution, a one-page
  policy describing what data the app stores (paired-client token,
  server URL, reading progress synced to user's own server) is good
  practice. Required for F-Droid / Play Store submission.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERR_CLEARTEXT_NOT_PERMITTED` on test-connection | WebView is serving page from `https://localhost` (cached HSTS, or `androidScheme: "https"` not yet changed) | Confirm `location.href` in DevTools is `http://momotaro.app/...`; if not, re-check `capacitor.config.json` and reinstall the app (uninstall first, don't upgrade) |
| `Mixed Content` warning | Page scheme doesn't match destination scheme | Use `androidScheme: "http"` for HTTP servers, `"https"` once you have TLS |
| Build fails with "Access is denied" on `key.properties` | `key.properties` exists as a directory | `Remove-Item key.properties -Recurse -Force` then copy from `key.properties.example` as a regular file |
| Build fails with `JdkImageTransform` jlink error | Toolchain mismatch: AGP 8.x can't drive JDK 24+ jlink | AGP 9.2.1 + Gradle 9.4.1 as documented above, or downgrade to JDK 21 |
| Update banner doesn't appear after publishing | `APP_VERSION` in `client/src/version.js` already matches `version.json`'s `version` | Bump `APP_VERSION` to match what `build.gradle` says; rebuild the APK |
| Images broken after pairing | Server returned URLs without server-prefixing | `clientToken` not set when `apiFetch` ran; confirm pairing actually persisted the token to `localStorage[momotaro_client_token]` |
| Page loads from `https://localhost` after config says `http` | Stale install; Capacitor cached the old `androidScheme` in app data | Uninstall the app completely (don't upgrade-install) and reinstall. Bumping `versionCode` triggers Capacitor's new-binary check on next launch |
