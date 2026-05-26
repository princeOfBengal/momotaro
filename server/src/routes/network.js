/**
 * Admin endpoints for the Port Forwarding section of Settings.
 *
 *   GET    /api/admin/network/status      — current UPnP state + config
 *   PUT    /api/admin/network/config      — change mode / external port; applies live
 *   POST   /api/admin/network/probe       — one-shot "does my router speak UPnP?"
 *   POST   /api/admin/network/refresh     — force a re-map right now
 *
 * Settings persistence keys (key/value rows in the `settings` table):
 *
 *   port_forwarding_mode  'off' | 'upnp' | 'manual'   default 'off'
 *   upnp_external_port    string integer              default = server PORT
 *
 * 'manual' mode never touches UPnP; we just display the configured public
 * URL so the user can verify they forwarded the port correctly by hand.
 */

const express = require('express');
const config = require('../config');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { requireAdmin } = require('../middleware/auth');
const upnp = require('../network/upnp');
const { getSetting, setSetting } = require('../utils');

const router = express.Router();

const VALID_MODES = new Set(['off', 'upnp', 'manual']);

function readConfig(db) {
  const mode = getSetting(db, 'port_forwarding_mode') || 'off';
  const extRaw = getSetting(db, 'upnp_external_port');
  const ext = parseInt(extRaw || '', 10);
  return {
    mode: VALID_MODES.has(mode) ? mode : 'off',
    external_port: Number.isFinite(ext) && ext > 0 && ext <= 65535 ? ext : config.PORT,
    internal_port: config.PORT,
  };
}

router.get('/admin/network/status', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  res.json({ data: { config: readConfig(db), upnp: upnp.getStatus() } });
}));

router.put('/admin/network/config', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const body = req.body || {};

  let mode = getSetting(db, 'port_forwarding_mode') || 'off';
  if ('mode' in body) {
    if (!VALID_MODES.has(body.mode)) {
      return res.status(400).json({ error: "mode must be 'off', 'upnp', or 'manual'" });
    }
    mode = body.mode;
    setSetting(db, 'port_forwarding_mode', mode);
  }

  if ('external_port' in body) {
    const n = parseInt(body.external_port, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: 'external_port must be an integer in [1, 65535]' });
    }
    setSetting(db, 'upnp_external_port', String(n));
  }

  const cfg = readConfig(db);

  // Re-apply the live UPnP state to match. Switching to/from 'upnp' starts
  // or stops the refresh loop; changing only the port re-maps. 'manual' and
  // 'off' both leave the UPnP loop off (the difference is purely cosmetic
  // in the admin UI — 'manual' tells the user to forward the port by hand).
  if (mode === 'upnp') {
    upnp.start({ externalPort: cfg.external_port, internalPort: cfg.internal_port });
  } else {
    await upnp.stop();
  }

  res.json({ data: { config: cfg, upnp: upnp.getStatus() } });
}));

router.post('/admin/network/probe', requireAdmin, asyncWrapper(async (req, res) => {
  const result = await upnp.probe();
  res.json({ data: result });
}));

// HTTP-based public-IP detection. Independent of UPnP — works whether the
// router supports it or not. Used by the "Detect public IP" button in
// Manual mode (which has no business touching UPnP) and as a fallback in
// UPnP mode when the gateway doesn't return an external IP.
router.post('/admin/network/public-ip', requireAdmin, asyncWrapper(async (req, res) => {
  try {
    const ip = await upnp.probePublicIp();
    res.json({ data: { public_ip: ip } });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach a public-IP service: ' + err.message });
  }
}));

router.post('/admin/network/refresh', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const cfg = readConfig(db);
  if (cfg.mode !== 'upnp') {
    return res.status(409).json({ error: 'Port forwarding mode is not "upnp" — nothing to refresh.' });
  }
  const result = await upnp.applyMapping(cfg.external_port, cfg.internal_port);
  res.json({ data: result });
}));

module.exports = router;
