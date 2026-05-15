const logger = require('./logger');
logger.install();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { getDb } = require('./db/database');
const { runFullScan } = require('./scanner/libraryScanner');
const { migrateToSharded } = require('./scanner/thumbnailPaths');
const cbzCache = require('./scanner/cbzCache');
const cbzCacheSchedule = require('./scanner/cbzCacheSchedule');
const downloader = require('./downloader/queue');
const scheduler = require('./scheduler');
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
const networkRoutes = require('./routes/network');
const { requireClientOrAdmin, enforceLanOnlyMode } = require('./middleware/auth');
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

// Serve generated thumbnails
fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });
app.use('/thumbnails', express.static(config.THUMBNAIL_DIR));

// Health check — public, used by clients to probe whether a host is a
// Momotaro server before attempting pairing.
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Public auth endpoints. These must remain reachable without a token —
// they're the bootstrap path for new clients and the recovery path for an
// admin who has cleared their browser storage. The adminAuth router gates
// its sensitive routes internally with `requireAdmin`.
app.use('/api', pairingRoutes);
app.use('/api', adminAuthRoutes);

// Network management (UPnP / port forwarding). All routes inside are
// gated by `requireAdmin` internally — mounted at the public tier because
// it never serves library data, only network plumbing.
app.use('/api', networkRoutes);

// Gated API routes. When `auth_enabled = 0` (default for fresh installs)
// the middleware passes every request through, preserving today's
// behaviour. Flipping the toggle through the admin UI starts enforcing
// client tokens / admin session / LAN bypass per the policy in
// [middleware/auth.js].
app.use('/api', requireClientOrAdmin, libraryRoutes);
app.use('/api', requireClientOrAdmin, chapterRoutes);
app.use('/api', requireClientOrAdmin, pageRoutes);
app.use('/api', requireClientOrAdmin, progressRoutes);
app.use('/api', requireClientOrAdmin, settingsRoutes);
app.use('/api', requireClientOrAdmin, metadataRoutes);
app.use('/api', requireClientOrAdmin, optimizeRoutes);
app.use('/api', requireClientOrAdmin, adminRoutes);
app.use('/api', requireClientOrAdmin, galleryRoutes);
app.use('/api', requireClientOrAdmin, configRoutes);
app.use('/api', requireClientOrAdmin, sourcesRoutes);

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
}

start().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
