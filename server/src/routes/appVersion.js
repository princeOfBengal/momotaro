const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { asyncWrapper } = require('../middleware/asyncWrapper');

const router = express.Router();

const VERSION_FILENAME = 'version.json';
const APK_FILENAME = 'momotaro.apk';

/**
 * GET /api/app/version
 *
 * Public — used by the Android app's first-launch / on-resume update check.
 * Reads `data/downloads/version.json` and reports the latest available
 * release plus the URL the user's browser can hit to download the APK.
 *
 * Returns 404 when no APK has been published yet (file missing). The
 * client treats 404 as "no update available" and stays silent.
 *
 * The version.json file is human-edited as part of the release process
 * (see BUILD_ANDROID.md → Self-hosted distribution). Keeping it as a flat
 * file rather than a DB row means there's no migration step and the
 * release process is `cp` + edit a small JSON — easy to script later.
 */
router.get('/app/version', asyncWrapper(async (req, res) => {
  const versionFile = path.join(config.DOWNLOADS_DIR, VERSION_FILENAME);
  const apkFile     = path.join(config.DOWNLOADS_DIR, APK_FILENAME);

  if (!fs.existsSync(versionFile) || !fs.existsSync(apkFile)) {
    return res.status(404).json({ error: 'No published APK on this server.' });
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: 'version.json is malformed: ' + err.message });
  }

  if (!parsed.version) {
    return res.status(500).json({ error: 'version.json is missing required `version` field.' });
  }

  const stat = fs.statSync(apkFile);

  res.json({
    data: {
      version:     String(parsed.version),
      apk_url:     `/downloads/${APK_FILENAME}`,
      released_at: parsed.released_at || null,
      notes:       parsed.notes || null,
      size_bytes:  stat.size,
    },
  });
}));

module.exports = router;
