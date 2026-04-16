const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { getDb } = require('./db/database');
const { runFullScan } = require('./scanner/libraryScanner');
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

const app = express();

app.use(cors());
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
  fs.mkdirSync(config.CBZ_CACHE_DIR, { recursive: true });
  fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });

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
  const libraries = db.prepare('SELECT * FROM libraries').all();
  startWatcher(libraries);

  // Initial scan
  if (config.SCAN_ON_STARTUP) {
    await runFullScan();
  }
}

start().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
