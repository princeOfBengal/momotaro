# Momotaro

A self-hosted manga and comics server. Drop in your collection, read from any
device — browser, PWA, or Android app.

## Quick Start (Docker)

```bash
# Clone / download this project
git clone <repo> momotaro
cd momotaro

# Create your library folder and add manga
mkdir library
# Drop manga folders into ./library/

# Build and start
docker compose up -d --build
```

Open <http://localhost:3000> in your browser. Click **Scan Library** to
index your manga.

Your library data (database, thumbnails) is stored in a Docker named volume
(`momotaro_data`) so it persists across restarts and image rebuilds.

## Library Structure

Organize your manga like this:

```text
library/
├── One Piece/
│   ├── Chapter 001/          # Folder of images
│   │   ├── 001.jpg
│   │   └── 002.jpg
│   ├── Chapter 002.cbz       # Or CBZ archives
│   └── Chapter 003.cbz
├── Berserk/
│   ├── Vol.01 Ch.001.cbz
│   └── Vol.01 Ch.002.cbz
└── My Hero Academia/
    ├── ch001/
    └── ch002/
```

**Supported formats:** folders of images (JPG, PNG, WebP, AVIF, GIF), or CBZ
files. Chapter naming understands `Chapter 001`, `Ch. 12.5`, `Vol.01 Ch.001`,
`c001`, `001`, and most variants.

## Core Features

- **Automatic metadata** — titles, descriptions, genres, scores fetched from
  AniList (with MyAnimeList and MangaUpdates fallbacks)
- **Two reading modes** — paged (RTL/LTR) and continuous scroll
- **Progress tracking** — remembers where you left off in every series
- **File watching** — drop new chapters in; they appear automatically
- **Mobile friendly** — swipe to navigate pages on touch screens
- **Keyboard navigation** — arrow keys, Escape to exit reader
- **Third-party sourcing** — pull missing chapters from MangaDex and other
  sources directly into your library

## Remote Access

Momotaro can be reached from outside your home network in three ways. Pick
whichever fits your setup; they all work with the same backend.

### Option 1: UPnP (zero-config, requires router support)

1. Open **Settings → Port Forwarding** in the web UI.
2. Pick **UPnP** mode. Optionally change the external port.
3. The server asks your router to forward TCP traffic to itself and
   refreshes the mapping every 30 minutes.
4. The status panel shows the detected public URL once mapping succeeds.

If your router has UPnP disabled (some ISPs ship them that way), the status
flips to **Mapping failed**. Either turn UPnP on in the router admin or
switch to Option 2 or 3.

### Option 2: Manual port forwarding

1. In your router, forward TCP port `3000` (or your configured port) to
   the LAN IP of the Momotaro host.
2. In **Settings → Port Forwarding**, pick **Manual** mode. The UI just
   echoes back what you configured; it doesn't touch the router.

### Option 3: Reverse proxy with HTTPS (recommended for public access)

The cleanest path for internet exposure is a TLS-terminating reverse proxy.
Examples:

- [Caddy](https://caddyserver.com/) — auto-renewing Let's Encrypt certs in
  one config line
- [nginx Proxy Manager](https://nginxproxymanager.com/) — GUI-managed nginx
- [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/) — works
  even behind CGNAT; no port forwarding needed

Front the Momotaro container on port 3000, terminate TLS at the proxy, and
forward the proxy's port `443` instead. Momotaro itself stays on plain HTTP
inside the trust boundary.

### Behind CGNAT or a restrictive ISP

If `whatismyip.com` and your router's WAN IP disagree, you're behind
[CGNAT](https://en.wikipedia.org/wiki/Carrier-grade_NAT) and port forwarding
won't work — packets from the internet never reach your router. The two
realistic answers are:

- **Cloudflare Tunnel** — runs a small daemon on the Momotaro host that
  dials out to Cloudflare; no inbound traffic needed
- **Tailscale** (or any WireGuard mesh) — put both ends on the VPN and pair
  using the VPN IP; sidesteps the public internet entirely

Both are free for personal use and take ~10 minutes to set up.

## Authentication & Client Pairing

By default Momotaro runs with **no auth** — anyone who can reach the URL can
read everything. That's fine on a LAN-only deployment. Once you forward a
port or front the server with a public proxy, turn on auth:

1. Open **Settings → Client Management**.
2. Set an admin password (8 characters minimum).
3. Pair at least one device using its on-screen pairing flow — read the
   6-digit PIN from the admin UI and type it into the device.
4. Flip the **Require authentication on all API requests** toggle.

From that point on, every API request needs either a paired-client token, a
valid admin session, or a request from a LAN address (if **Allow LAN
devices to skip pairing** is on, which is the default).

Revoke any device from the Client Management list — the token stops working
on the next request.

**PIN hardening:** PINs are 6 digits, single-use, valid for 5 minutes, and
the pairing record is destroyed after 5 wrong attempts. Pairing requests
are rate-limited to 10 per minute per IP. Admin login is rate-limited the
same way.

## Android App

Momotaro ships with a first-class Android app — a [Capacitor](https://capacitorjs.com/)
wrapper around the same React UI. On first launch it walks the user
through pairing with your server (PIN-based, 6 digits from
**Settings → Client Management**), persists the issued token, and
behaves identically to the PWA from there on.

The app is **self-hosted alongside the server**: your Momotaro instance
serves the signed APK at `/downloads/momotaro.apk` and the in-app update
check polls `/api/app/version` on launch. No app store, no review, no
Google account.

Pick the path that matches your role:

### I just want to use the Android app on my phone

Your server admin needs to publish an APK first (see the next section).
Once they have:

1. On your phone, open a browser and navigate to your Momotaro server's
   download URL, e.g. `http://your-server:3000/downloads/momotaro.apk`.
2. Android downloads the APK. Tap the notification (or the file in
   Downloads) to install.
3. The first time you install an APK from a browser, Android asks you to
   allow "Install unknown apps" for that browser — one-time setting.
4. Launch Momotaro. Enter your server URL → device name → 6-digit PIN
   that the admin reads off **Settings → Client Management**.
5. Done — the library opens. Subsequent updates to the app are
   advertised by an in-app banner; tapping it re-runs steps 1–3.

### I'm self-hosting and want to provide the APK to others

You need to build and sign the APK once, then drop it on your server. Full
walkthrough in [BUILD_ANDROID.md](BUILD_ANDROID.md). Quick version:

```bash
# One-time setup
# 1. Install JDK 17 or 21 (or 26 — see BUILD_ANDROID.md for toolchain notes)
#    and Android Studio (for the SDK + build-tools 36).
# 2. Generate a release keystore. Back this file up offline — losing it
#    means you can never update the app under the same package ID.
keytool -genkey -v -keystore momotaro-release.jks -keyalg RSA -keysize 2048 \
    -validity 10000 -alias momotaro
# 3. Copy the keystore credentials template into place and fill it in.
cp client/android/key.properties.example client/android/key.properties
# Edit client/android/key.properties — set the four values. Gitignored.

# Per-release
cd client
npm install                          # first time only
npm run build && npx cap copy android
cd android && ./gradlew assembleRelease
# Signed APK lands at:
#   client/android/app/build/outputs/apk/release/app-release.apk

# Publish it via the server's download endpoint
mkdir -p ../../data/downloads
cp app/build/outputs/apk/release/app-release.apk ../../data/downloads/momotaro.apk
cat > ../../data/downloads/version.json <<'EOF'
{
  "version": "1.1",
  "released_at": "2026-05-15",
  "notes": "First self-hosted release."
}
EOF
# Restart the Momotaro server so it serves the new file + version metadata.
```

Every existing install on a paired phone will see the "Update available"
banner on its next launch and a tap downloads the new APK through the
system browser.

### I just want a quick debug build to test on my own phone

If you're hacking on the code and don't need a signed release yet, the
debug variant is enough — skip the keystore, skip the server publishing
step, just:

```bash
cd client
npm install
npm run build && npx cap copy android
cd android && ./gradlew.bat assembleDebug   # Windows
# or ./gradlew assembleDebug                # macOS / Linux
# Unsigned debug APK at:
#   client/android/app/build/outputs/apk/debug/app-debug.apk
```

Sideload via USB or share-to-device. The pairing flow on the phone is
the same as the release variant.

### Architecture details

Capacitor's WebView origin is configured as `http://momotaro.app` in
[client/capacitor.config.json](client/capacitor.config.json) — `http`
because most self-hosted Momotaro instances speak plain HTTP, and the
custom hostname dodges a Chromium HSTS-for-localhost gotcha. Once you
front the server with HTTPS (Caddy / Cloudflare Tunnel / nginx),
switch this back to `"androidScheme": "https"` and tighten
[client/android/app/src/main/res/xml/network_security_config.xml](client/android/app/src/main/res/xml/network_security_config.xml)
to disallow cleartext.

Full architecture writeup is in [docs/android.md](docs/android.md).

## Configuration

Edit `docker-compose.yml` to change the port or library path:

```yaml
services:
  momotaro:
    ports:
      - "3000:3000"   # Change the left side to your preferred host port
    volumes:
      - /your/manga/path:/app/library:ro   # Absolute path to your manga folder
      - momotaro_data:/app/data            # Database and thumbnails
```

Available environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Internal port the server listens on |
| `SCAN_ON_STARTUP` | `true` | Automatically scan library when the container starts |
| `REQUEST_DELAY_MS` | `700` | Floor delay (ms) between AniList API requests; the runtime adapts upward based on AniList's rate-limit headers. |

## Development

```bash
# Server
cd server
npm install
npm run dev   # starts on :3000

# Client (in another terminal)
cd client
npm install
npm run dev   # starts on :5173, proxies API to :3000
```

## Tech Stack

- **Backend**: Node.js, Express, SQLite (better-sqlite3), chokidar, sharp,
  nat-upnp-2
- **Frontend**: React 18, Vite, React Router
- **Metadata**: AniList GraphQL API, Jikan (MyAnimeList), MangaUpdates,
  Doujinshi.info
- **Android shell**: Capacitor 8 over the same React build (Gradle 9.4 / AGP 9.2)
- **Docker**: nginx + Node Alpine

## Security Notes

- **HTTPS is your responsibility.** Momotaro itself speaks plain HTTP;
  every flow that travels over WAN (paired-client tokens, admin sessions,
  passwords, library content) is in cleartext unless you put a TLS proxy
  in front. The admin UI shows a warning banner when port forwarding is on
  but the connection is unencrypted.
- **Tokens are stored in `localStorage`**, scoped to the WebView/PWA
  origin. Other apps on the device cannot read them, but a successful
  cross-site script injection in the page would. There is no
  user-generated content rendered as HTML today, which closes the obvious
  vector.
- **Admin sessions are in-memory.** Restarting the server logs every admin
  out — by design. Paired-client tokens persist in the database (hashed
  via SHA-256; the plaintext is only ever shown once).
- **Rate limits are in-memory.** Clustering the server would defeat them;
  there's no Redis-backed limiter. Self-hosted single-instance is the
  supported topology.
