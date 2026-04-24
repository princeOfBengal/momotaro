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

const app = express();

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

// Serve generated thumbnails
fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });
app.use('/thumbnails', express.static(config.THUMBNAIL_DIR));

// API routes
app.use('/api', libraryRoutes);
app.use('/api', chapterRoutes);
app.use('/api', pageRoutes);
app.use('/api', progressRoutes);
app.use('/api', settingsRoutes);
app.use('/api', metadataRoutes);
app.use('/api', optimizeRoutes);
app.use('/api', adminRoutes);
app.use('/api', galleryRoutes);
app.use('/api', configRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

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

  // One-time migration: relocate any flat thumbnails into shard subdirs.
  // No-op once the tree is fully sharded.
  migrateToSharded();

  // Graceful shutdown
  let server;
  async function shutdown(signal) {
    console.log(`[Server] ${signal} received — shutting down gracefully`);
    server?.close(() => {
      console.log('[Server] HTTP server closed');
      process.exit(0);
    });
    // Force exit if server hasn't closed within 10 s
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[Server] Momotaro running on port ${config.PORT}`);
  });

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
