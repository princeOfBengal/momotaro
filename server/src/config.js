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
};
