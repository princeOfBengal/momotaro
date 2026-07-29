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
  // Delay the fire-and-forget startup scan by this many ms so the first Home
  // request (and the DB warm pass) win the disk before the scan's read /
  // thumbnail I/O ramps up. `0` restores the old immediate-scan behaviour.
  SCAN_STARTUP_DELAY_MS: parseInt(process.env.SCAN_STARTUP_DELAY_MS || '15000', 10),
  REQUEST_DELAY_MS: parseInt(process.env.REQUEST_DELAY_MS || '700', 10),

  // ── DB memory management ────────────────────────────────────────────────
  // How often to run `PRAGMA shrink_memory`, which hands SQLite's idle page
  // cache back to the OS. Default `0` = never: the page cache is already hard-
  // capped by `cache_size` (256 MB), and periodic shrinking is exactly what
  // makes the first Home load after an idle period slow (it discards the hot
  // working set, forcing cold disk reads on return). Set a positive ms value
  // (e.g. 3600000 for hourly) only on memory-constrained hosts that need the
  // idle pages reclaimed and can tolerate the cold-return penalty.
  DB_SHRINK_INTERVAL_MS: parseInt(process.env.DB_SHRINK_INTERVAL_MS || '0', 10),

  // ── Home working-set warmer ─────────────────────────────────────────────
  // A background job re-runs the /api/home queries for recently-active users
  // so the SQLite + OS page cache for the Home working set stays resident.
  // This is what keeps a return-after-idle Home load fast without lengthening
  // any response-cache TTL (freshness is unchanged). `0` disables the warmer.
  HOME_WARM_INTERVAL_MS: parseInt(process.env.HOME_WARM_INTERVAL_MS || '150000', 10),
  // Only warm users seen within this window (ms). A user who hasn't opened
  // Home in this long drops out of the warm set until their next visit.
  HOME_WARM_WINDOW_MS: parseInt(process.env.HOME_WARM_WINDOW_MS || String(7 * 24 * 60 * 60 * 1000), 10),
  // Cap on how many users are warmed per pass (most-recently-seen first), so a
  // large multi-user instance can't fan the warmer out unboundedly.
  HOME_WARM_MAX_USERS: parseInt(process.env.HOME_WARM_MAX_USERS || '8', 10),

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
