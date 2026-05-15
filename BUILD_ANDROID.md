# Building the Momotaro Android APK

The Android app is a [Capacitor](https://capacitorjs.com/) wrapper around the
existing React/Vite build — same UI as the PWA, plus a native shell and a
first-run pairing flow that talks to the Phase 1 pairing API.

The scaffold lives at [client/android/](client/android/) and was generated
with `npx cap add android`. To build a working APK you need a JDK and the
Android SDK on your local machine.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 18+ | You already have it; same Node that builds the web client. |
| **JDK 17 or 21** | LTS | Capacitor 6/7 require 17+. JDK 13 (current on this box) will *not* work — install Temurin 17 from [adoptium.net](https://adoptium.net/) and set `JAVA_HOME` to that install. |
| **Android Studio** | latest | Easiest way to get the Android SDK, build-tools, and an emulator. [developer.android.com/studio](https://developer.android.com/studio) |
| `ANDROID_HOME` env var | — | After installing Android Studio, set this to e.g. `C:\Users\<you>\AppData\Local\Android\Sdk`. |

In Android Studio, open the SDK Manager and ensure **SDK Platform 34** (or
whatever Capacitor's `compileSdkVersion` says) and the latest **Build Tools**
are installed.

## Build steps

```bash
# 1. Build the React app (always do this first; the APK packs whatever is
#    currently in client/dist).
cd client
npm install
npm run build

# 2. Copy the freshly built web assets into the Android project.
npx cap copy android

# 3. Build the debug APK.
cd android
./gradlew assembleDebug      # macOS / Linux
gradlew.bat assembleDebug    # Windows
```

The unsigned debug APK lands at:

```
client/android/app/build/outputs/apk/debug/app-debug.apk
```

Sideload it onto a phone (drag-and-drop via USB debugging, or copy to the
device and tap it).

## Release builds

Debug APKs are signed with a generic debug key and not suitable for
distribution. For a release build:

```bash
# 1. Generate a keystore once. Keep this file safe — losing it means you
#    can never update the app under the same package ID.
keytool -genkey -v -keystore momotaro-release.jks -keyalg RSA -keysize 2048 \
    -validity 10000 -alias momotaro

# 2. Create client/android/key.properties (do NOT commit):
#    storePassword=...
#    keyPassword=...
#    keyAlias=momotaro
#    storeFile=/absolute/path/to/momotaro-release.jks

# 3. Wire the key into client/android/app/build.gradle's signingConfigs —
#    Capacitor's docs cover this:
#    https://capacitorjs.com/docs/android/deploying-to-google-play

# 4. Build:
cd client/android
./gradlew assembleRelease
```

## What gets shipped

The APK bundles the contents of `client/dist`, which is the same React build
the PWA serves. On launch, the app:

1. Checks `localStorage` for `momotaro_server_url` and `momotaro_client_token`.
2. If either is missing → routes to `/pairing` (the onboarding wizard).
3. If both are present → renders the normal Library page.

The pairing wizard is in [client/src/pages/Pairing.jsx](client/src/pages/Pairing.jsx).
It calls these public server endpoints (from Phase 1):

- `GET /api/health` — to verify the entered URL is a Momotaro server
- `POST /api/pairing/request` — to start pairing
- `POST /api/pairing/submit-pin` — to redeem the PIN shown in the server's
  Settings → Client Management section

On success it persists the issued client token to `localStorage` and the
shared API client (`client/src/api/client.js`) adds it to every subsequent
request as `Authorization: Bearer <token>`.

## Configuration

- **App ID**: `dev.momotaro.app` — change in [client/capacitor.config.json](client/capacitor.config.json)
  before first build if you want a different package name.
- **App name**: edit [client/android/app/src/main/res/values/strings.xml](client/android/app/src/main/res/values/strings.xml).
- **Icon / splash**: replace `client/android/app/src/main/res/mipmap-*` and
  the launcher / splash drawables. Capacitor has a helper:
  `npm install -D @capacitor/assets && npx @capacitor/assets generate`.
- **HTTP traffic**: the config enables `allowMixedContent: true` so the
  WebView (served over `https://localhost` by Capacitor) can talk to a plain
  HTTP Momotaro server. If you front your server with HTTPS (Caddy /
  Cloudflare Tunnel / nginx), remove that flag — auth tokens travel
  cleartext over plain HTTP, which matters once the server is exposed to
  the internet.

## Updating the app

After any change to the web code:

```bash
cd client
npm run build
npx cap copy android
cd android && ./gradlew assembleDebug
```

`npx cap copy` is fast — it just refreshes `android/app/src/main/assets/public`.
Use `npx cap sync` instead if you also added or upgraded a Capacitor plugin.

## Troubleshooting

- **"unsupported class file version"** during Gradle: your JDK is older than
  17. Install Temurin 17 and update `JAVA_HOME`.
- **"SDK location not found"**: set `ANDROID_HOME` (or create
  `client/android/local.properties` with `sdk.dir=/path/to/sdk`).
- **"Manifest merger failed"** after changing `appId`: run
  `npx cap sync android` and rebuild — Capacitor rewrites the manifest
  from the config.
- **APK installs but pairing fails with a network error**: the WebView
  can't reach your server URL. From the Android device, try opening the
  same URL in Chrome. Common causes: server bound to `127.0.0.1` (use
  `0.0.0.0`), wrong IP in onboarding, or the device is on cellular while
  the server URL is a LAN address.
