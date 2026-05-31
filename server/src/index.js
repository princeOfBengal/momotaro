const logger = require('./logger');
logger.install();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { getDb } = require('./db/database');
const { runFullScan, getScanStatus } = require('./scanner/libraryScanner');
const { migrateToSharded } = require('./scanner/thumbnailPaths');
const cbzCache = require('./scanner/cbzCache');
const cbzCacheSchedule = require('./scanner/cbzCacheSchedule');
const downloader = require('./downloader/queue');
const scheduler = require('./scheduler');
const taskRegistry = require('./admin/taskRegistry');
const { startWatcher } = require('./watcher');
const { errorHandler } = require('./middleware/errorHandler');

const libraryRoutes = require('./routes/library');
const chapterRoutes = require('./routes/chapters');
const pageRoutes = require('./routes/pages');
const progressRoutes = require('./routes/progress');
const { router: settingsRoutes } = require('./routes/settings');
const metadataRoutes = require('./routes/metadata');
const optimizeRoutes = require('./routes/optimize');
const adminRoutes = require('./routes/admin');
const galleryRoutes = require('./routes/gallery');
const configRoutes = require('./routes/config');
const sourcesRoutes = require('./routes/sources');
const pairingRoutes = require('./routes/pairing');
const adminAuthRoutes = require('./routes/adminAuth');
const userRoutes = require('./routes/users');
const userPreferencesRoutes = require('./routes/userPreferences');
const networkRoutes = require('./routes/network');
const appVersionRoutes = require('./routes/appVersion');
const { requireClientOrAdmin, requireAdmin, enforceLanOnlyMode } = require('./middleware/auth');
const { resolveUser, requireUser } = require('./middleware/userAuth');
const { requestLogger } = require('./middleware/requestLogger');
const upnp = require('./network/upnp');

const app = express();

// Conservative security headers — applied to every response, including
// static assets. Two we set unconditionally:
//
//   X-Content-Type-Options: nosniff   — browsers must honour our declared
//     Content-Type rather than guessing from the body. Prevents a stray
//     JSON or text response from being executed as a script.
//   Referrer-Policy: same-origin      — when an admin clicks a link out of
//     the app, the destination only sees the origin, not the full URL.
//
// Not set: X-Frame-Options (some users embed Momotaro in a dashboard),
// HSTS (irrelevant on plain HTTP), CSP (would require a full audit of the
// React build's inline-script / inline-style usage and is brittle to
// upgrade). Add those behind a reverse proxy when you front the server
// with TLS.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(cors());
// Compress JSON + HTML; skip page images (already JPEG/PNG/WebP) and thumbnail
// static route since those bodies are already compressed and gzipping them
// wastes CPU without reducing size.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.path.startsWith('/thumbnails/')) return false;
    if (/^\/api\/pages\/\d+\/image$/.test(req.path)) return false;
    return compression.filter(req, res);
  },
}));
// Most endpoints send small payloads, but the config-import route accepts a
// full state dump that can reach several MB for large libraries.
app.use(express.json({ limit: '64mb' }));

// LAN-only mode enforcement. Runs first so it precedes static assets,
// the health endpoint, pairing, auth — everything. When the admin picks
// "Local only" in Port Forwarding (the default), non-LAN source IPs get
// 403 here regardless of any router-level forward. See
// [middleware/auth.js] for the recovery story.
app.use(enforceLanOnlyMode);

// Serve generated thumbnails. Gated by the same client-or-admin token
// check that protects every /api route, so an external visitor without
// a paired token can't enumerate library cover art. The middleware
// accepts the token via the `?t=` query string (see
// [middleware/auth.js]) — the SPA's thumbnailUrl helper appends it.
fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });
app.use('/thumbnails', requireClientOrAdmin, express.static(config.THUMBNAIL_DIR));

// Self-hosted Android APK distribution. Public on purpose — the system
// browser tab that handles the APK download cannot carry the bearer
// token (no JS context), and the threat model for a server already
// reachable on the LAN/public internet doesn't change meaningfully:
// the APK is the client code, not secret data. Only the contents of
// data/downloads/ are exposed (currently just `momotaro.apk` +
// `version.json`); no other paths leak.
fs.mkdirSync(config.DOWNLOADS_DIR, { recursive: true });
app.use('/downloads', express.static(config.DOWNLOADS_DIR));

// Forensic request logger. Mounted before any /api router so a request
// denied at the auth layer (401 / 403) still has its outcome captured.
// Successful 2xx reads are deliberately NOT logged here — they would
// flood the table with no security value. See middleware/requestLogger.js
// for the full filter rules.
app.use('/api', requestLogger);

// Health check — public, used by clients to probe whether a host is a
// Momotaro server before attempting pairing.
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Public auth endpoints. These must remain reachable without a token —
// they're the bootstrap path for new clients and the recovery path for an
// admin who has cleared their browser storage. The adminAuth router gates
// its sensitive routes internally with `requireAdmin`.
app.use('/api', pairingRoutes);
app.use('/api', adminAuthRoutes);
// App version check — public so a freshly-installed APK with no token
// can still discover that an update is available without going through
// pairing first.
app.use('/api', appVersionRoutes);

// Network management (UPnP / port forwarding). All routes inside are
// gated by `requireAdmin` internally — mounted at the public tier because
// it never serves library data, only network plumbing.
app.use('/api', networkRoutes);

// Gated API routes. When `auth_enabled = 0` (default for fresh installs)
// the middleware passes every request through, preserving today's
// behaviour. Flipping the toggle through the admin UI starts enforcing
// client tokens / admin session / LAN bypass per the policy in
// [middleware/auth.js].
//
// `resolveUser` runs after the network gate on every gated route, setting
// `req.user`. It's independent of how the gate was satisfied, so per-user
// scoping applies even to LAN-bypass requests. When multi-user is off (or no
// real account exists yet) it resolves to the default user, preserving today's
// single-user behaviour.
app.use('/api', resolveUser);

// ── Mount ordering matters here. ───────────────────────────────────────────
// Express runs the mount-line middleware (`requireUser` / `requireAdmin`) for
// EVERY request whose URL prefix matches '/api', *before* the inner router
// does its own route matching. That means a stray `requireUser` on a mount
// will 401 unrelated requests that just happen to fall through to that line
// before reaching the router they actually belong to.
//
// In particular, `<img src="/api/pages/123/image">` requests carry no
// `X-User-Token` (native `<img>` can't send custom headers), so they'd be
// 401'd by any `requireUser`-gated mount that sits between them and the
// `pageRoutes` mount they target. The fix is to mount the routers that need
// no per-user gate FIRST (chapter, page, gallery, settings, metadata), so
// the image / chapter-pages-list / cover routes match and serve before any
// `requireUser` mount is consulted.
//
// User auth (register / login / logout / me / exists): network-gated so an
// unpaired external visitor can't create an account, but NOT behind
// `requireUser` — login and register are how you *become* a user. logout / me
// apply `requireUser` per-route inside the router.
app.use('/api', requireClientOrAdmin, userRoutes);

// No per-user gate. These serve catalogue and image bytes (the latter via
// native `<img>` tags with no custom headers) and use `req.user` only where
// they need it, with optional chaining. Placed before the `requireUser`
// mounts so the gate never short-circuits an image request.
app.use('/api', requireClientOrAdmin, chapterRoutes);
app.use('/api', requireClientOrAdmin, pageRoutes);
app.use('/api', requireClientOrAdmin, galleryRoutes);
app.use('/api', requireClientOrAdmin, settingsRoutes);
app.use('/api', requireClientOrAdmin, metadataRoutes);

// `requireUser` guards the routes that read per-user state. It's a no-op while
// multi-user is off (req.user is always the default user); once enforced it
// turns a missing/invalid session into a 401 instead of letting a handler
// dereference a null user.
app.use('/api', requireClientOrAdmin, requireUser, libraryRoutes);
app.use('/api', requireClientOrAdmin, requireUser, progressRoutes);
// Per-user preferences (Homepage Settings + future per-user UI state). Mount
// at /api/user so the route is /api/user/preferences. requireUser is enforced
// inside the router too, but the mount-line gate keeps unauthenticated
// requests from even reaching the handler.
app.use('/api/user', requireClientOrAdmin, requireUser, userPreferencesRoutes);

// Admin-only operator surfaces: database management, system logs, optimize
// bulk ops, third-party sourcing, and the config export/import bundle.
// requireAdmin returns 409 when no admin password is configured (the UI's
// AdminGuard surfaces a setup form), or 401 when there's no valid admin
// session token (the UI surfaces the login form).
app.use('/api', requireClientOrAdmin, requireAdmin, optimizeRoutes);
app.use('/api', requireClientOrAdmin, requireAdmin, adminRoutes);
app.use('/api', requireClientOrAdmin, requireAdmin, configRoutes);
app.use('/api', requireClientOrAdmin, requireAdmin, sourcesRoutes);

// Serve built React client (production)
const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, {
    setHeaders(res, filePath) {
      // Service worker and its registration script must never be served from
      // the HTTP cache — the browser must re-fetch them on every load so it
      // can detect updates.  All other static assets use the default ETag
      // behaviour (conditional re-validation).
      if (
        filePath.endsWith('sw.js') ||
        filePath.endsWith('registerSW.js') ||
        filePath.endsWith('manifest.webmanifest')
      ) {
        res.setHeader('Cache-Control', 'no-store, no-cache');
      }
    },
  }));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(errorHandler);

async function start() {
  fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });

  // Initialize database first so cache init can read the user-configured
  // cache cap from the settings table.
  const db = getDb();

  // Reconcile persisted admin-task state. Any row still marked 'running'
  // means the process died mid-task (e.g., a multi-minute VACUUM the
  // operator force-restarted). Flip it to 'interrupted' so a status poll
  // from the UI returns an honest answer instead of a stale heartbeat.
  taskRegistry.init();

  const savedLimitRow = db.prepare(
    "SELECT value FROM settings WHERE key = 'cbz_cache_limit_bytes'"
  ).pluck().get();
  const savedLimit = savedLimitRow ? parseInt(savedLimitRow, 10) : NaN;

  // Rebuild the CBZ extraction-cache index from whatever is on disk. Warm
  // cache from the previous run is preserved; anything over the configured
  // cap is evicted immediately.
  cbzCache.init(Number.isFinite(savedLimit) && savedLimit > 0 ? savedLimit : undefined);

  // Start the cache auto-clear scheduler (no-op if mode is 'off').
  cbzCacheSchedule.reschedule();

  // Initialise the Third Party Sourcing download queue. Re-queues any jobs
  // that were 'running' when the previous process died and starts pumping
  // immediately if there's outstanding work.
  downloader.init();

  // Per-manga scheduled auto-checks. Polls `manga_schedules` once a minute,
  // fires due rows, and enqueues missing chapters through the download
  // queue. No-op when no schedules exist.
  scheduler.start();

  // One-time migration: relocate any flat thumbnails into shard subdirs.
  // No-op once the tree is fully sharded.
  migrateToSharded();

  // Graceful shutdown
  let server;
  async function shutdown(signal) {
    console.log(`[Server] ${signal} received — shutting down gracefully`);
    // Best-effort UPnP unmap. We don't await this past a short budget — a
    // dead/UPnP-less router would otherwise stall shutdown for 20s.
    Promise.race([
      upnp.stop(),
      new Promise(r => setTimeout(r, 2_000)),
    ]).finally(() => {
      server?.close(() => {
        console.log('[Server] HTTP server closed');
        process.exit(0);
      });
    });
    // Force exit if server hasn't closed within 10 s
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[Server] Momotaro running on port ${config.PORT}`);
  });

  // If the admin previously enabled UPnP, re-arm the mapping loop on
  // boot. Failures here (no UPnP IGD, timeout, etc.) surface via the admin
  // UI's status panel; we never block startup on UPnP.
  const pfMode = db.prepare(
    "SELECT value FROM settings WHERE key = 'port_forwarding_mode'"
  ).pluck().get() || 'off';
  if (pfMode === 'upnp') {
    const extRaw = db.prepare(
      "SELECT value FROM settings WHERE key = 'upnp_external_port'"
    ).pluck().get();
    const ext = parseInt(extRaw || '', 10);
    const externalPort = Number.isFinite(ext) && ext > 0 && ext <= 65535 ? ext : config.PORT;
    upnp.start({ externalPort, internalPort: config.PORT });
  }

  // Start file watchers for all libraries
  const libraries = db.prepare('SELECT id, name, path FROM libraries').all();
  startWatcher(libraries);

  // Initial scan — fire-and-forget. Server is already listening; progress
  // is observable via GET /api/scan/status.
  if (config.SCAN_ON_STARTUP) {
    runFullScan({ trigger: 'startup' })
      .catch(err => console.error('[Scan] Startup scan error:', err.message));
  }

  // Daily PRAGMA optimize. Keeps the query-planner stats fresh on a
  // long-lived connection per SQLite's recommendation for apps that hold
  // a single connection across years of uptime. Most calls are millisecond
  // no-ops; ANALYZE only re-runs on tables SQLite considers stale.
  //
  // Defer the first run by 5 min so cold-boot perceived speed isn't
  // affected by the initial pass (which can take a few seconds on a
  // never-analyzed DB). Skip if a scan is currently in progress —
  // ANALYZE briefly write-locks sqlite_stat1, and the scan is the most
  // write-heavy op in the app; cheaper to wait until tomorrow.
  let optimizeRunCount = 0;
  function runDbOptimize() {
    try {
      if (getScanStatus().running) return; // try again on the next tick
      db.pragma('optimize');
      optimizeRunCount++;
      if (optimizeRunCount === 1) {
        console.log('[DB] PRAGMA optimize ran (first run after startup).');
      }
    } catch (err) {
      console.warn(`[DB] PRAGMA optimize failed: ${err.message}`);
    }
  }
  setTimeout(() => {
    runDbOptimize();
    setInterval(runDbOptimize, 24 * 60 * 60 * 1000).unref();
  }, 5 * 60 * 1000).unref();
}

start().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
