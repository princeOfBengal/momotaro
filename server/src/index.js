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
app.use(express.json());

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
  // Streaming reads from CBZ files replaced the extract-to-disk cache. If an
  // old cache directory is lying around from a previous install, wipe it on
  // startup — it can easily be multi-GB and is now dead weight.
  try {
    const entries = fs.readdirSync(config.CBZ_CACHE_DIR, { withFileTypes: true });
    for (const e of entries) {
      try {
        fs.rmSync(path.join(config.CBZ_CACHE_DIR, e.name), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    if (entries.length > 0) {
      console.log(`[Server] Cleared ${entries.length} legacy CBZ cache ${entries.length === 1 ? 'entry' : 'entries'}.`);
    }
  } catch { /* dir doesn't exist — fine */ }

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

  // Initialize database (runs migrations)
  const db = getDb();

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
