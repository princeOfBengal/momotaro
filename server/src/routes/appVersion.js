const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { asyncWrapper } = require('../middleware/asyncWrapper');

const router = express.Router();

// Per-platform self-hosted distribution. Each platform has a flat metadata file
// and a binary in DATA/downloads. The release process drops the binary and
// edits the JSON — no DB row, no migration (see BUILD_ANDROID.md /
// BUILD_LINUX.md → Self-hosted distribution).
const CHANNELS = {
  android: { versionFile: 'version.json',       binary: 'momotaro.apk',      urlField: 'apk_url' },
  linux:   { versionFile: 'version-linux.json', binary: 'momotaro.AppImage', urlField: 'appimage_url' },
};

/**
 * GET /api/app/version?platform=android|linux
 *
 * Public — used by the native app's first-launch / on-resume update check
 * (Android APK and Linux AppImage). `platform` defaults to `android` so
 * existing Android clients that call `/api/app/version` with no query string
 * keep working unchanged.
 *
 * Reads `data/downloads/<versionFile>` and reports the latest available release
 * plus the URL the user can hit to download the build. Returns 404 when nothing
 * is published for that platform; the client treats 404 as "no update" and
 * stays silent. Both a generic `download_url` and the legacy per-platform field
 * (`apk_url` / `appimage_url`) are returned.
 */
router.get('/app/version', asyncWrapper(async (req, res) => {
  const platform = String(req.query.platform || 'android').toLowerCase();
  const channel = CHANNELS[platform];
  if (!channel) {
    return res.status(400).json({
      error: `Unknown platform '${platform}'. Expected one of: ${Object.keys(CHANNELS).join(', ')}.`,
    });
  }

  const versionFile = path.join(config.DOWNLOADS_DIR, channel.versionFile);
  const binaryFile  = path.join(config.DOWNLOADS_DIR, channel.binary);

  if (!fs.existsSync(versionFile) || !fs.existsSync(binaryFile)) {
    return res.status(404).json({ error: `No published ${platform} build on this server.` });
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `${channel.versionFile} is malformed: ` + err.message });
  }

  if (!parsed.version) {
    return res.status(500).json({ error: `${channel.versionFile} is missing required \`version\` field.` });
  }

  const stat = fs.statSync(binaryFile);
  const downloadUrl = `/downloads/${channel.binary}`;

  res.json({
    data: {
      version:            String(parsed.version),
      platform,
      download_url:        downloadUrl,
      [channel.urlField]:  downloadUrl, // apk_url / appimage_url — back-compat
      released_at:         parsed.released_at || null,
      notes:               parsed.notes || null,
      size_bytes:          stat.size,
    },
  });
}));

module.exports = router;
