const path = require('path');

const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '../../data');

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  LIBRARY_PATH: process.env.LIBRARY_PATH || path.join(__dirname, '../../library'),
  DATA_PATH,
  DB_PATH: process.env.DB_PATH || path.join(DATA_PATH, 'momotaro.db'),
  THUMBNAIL_DIR: process.env.THUMBNAIL_DIR || path.join(DATA_PATH, 'thumbnails'),
  CBZ_CACHE_DIR: process.env.CBZ_CACHE_DIR || path.join(DATA_PATH, 'cbz-cache'),
  // Holds the signed APK + version.json for self-hosted Android distribution.
  // Releaser drops `momotaro.apk` and `version.json` here; the app's update
  // check reads version.json and the user's browser downloads the APK.
  DOWNLOADS_DIR: process.env.DOWNLOADS_DIR || path.join(DATA_PATH, 'downloads'),
  SCAN_ON_STARTUP: process.env.SCAN_ON_STARTUP !== 'false',
  REQUEST_DELAY_MS: parseInt(process.env.REQUEST_DELAY_MS || '700', 10),

  // ── First-page-fast CBZ open ────────────────────────────────────────────
  // Tunables for the two-phase extraction path. See cbzCache.js for the full
  // protocol. Only consulted when the per-device reader setting "Fast chapter
  // open" is on (default off — the feature is opt-in for one release).
  CBZ_FAST_PREFIX:           parseInt(process.env.CBZ_FAST_PREFIX        || '6',      10),
  CBZ_DIM_PROBE_CONCURRENCY: parseInt(process.env.CBZ_DIM_PROBE_CONCURRENCY || '6',   10),
  CBZ_DIM_PROBE_BUFFER_BYTES: parseInt(process.env.CBZ_DIM_PROBE_BUFFER_BYTES || '262144', 10),
  CBZ_PHASE2_CONCURRENCY:    parseInt(process.env.CBZ_PHASE2_CONCURRENCY  || '2',     10),
  CBZ_PAGE_WAIT_TIMEOUT_MS:  parseInt(process.env.CBZ_PAGE_WAIT_TIMEOUT_MS || '30000', 10),
  CBZ_PHASE2_RESTAT_INTERVAL: parseInt(process.env.CBZ_PHASE2_RESTAT_INTERVAL || '8', 10),
};
