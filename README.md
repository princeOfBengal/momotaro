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

A first-class Android app wraps the same React UI with a native shell. On
first launch it walks the user through pairing with your server, persists
the issued token, and behaves identically to the PWA from there on.

To build the APK yourself, see [BUILD_ANDROID.md](BUILD_ANDROID.md). You'll
need JDK 17+ and the Android SDK installed locally.

```bash
# After making web-UI changes:
cd client && npm run build && npx cap copy android
cd android && ./gradlew assembleDebug
# APK lands at: client/android/app/build/outputs/apk/debug/app-debug.apk
```

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
- **Android shell**: Capacitor 7 over the same React build
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
