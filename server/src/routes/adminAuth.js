const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { hashPassword, verifyPassword, hashToken } = require('../auth/crypto');
const adminSession = require('../auth/adminSession');
const rateLimit = require('../auth/rateLimit');
const { requireAdmin, isLanIp, isLanBypassEnabled, isAuthEnabled, extractClientToken, extractAdminToken } = require('../middleware/auth');

const router = express.Router();

const LOGIN_LIMIT_PER_MIN = 10;

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) || null;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value || '');
}

/**
 * GET /api/admin/auth-status
 *
 * Public discovery endpoint used by the web UI to decide which screen to
 * render on load. Reports:
 *
 *   - configured           : has an admin password been set?
 *   - logged_in            : is the caller's admin token valid?
 *   - auth_enabled         : is client-token enforcement on?
 *   - lan_bypass_enabled   : do LAN IPs skip auth?
 *   - caller_is_lan        : is the *current* caller on a LAN IP?
 *   - pairing_required     : would this caller be rejected by the regular
 *                            auth gate? If true, the SPA should route the
 *                            user to /pairing before showing any library
 *                            content. This is the signal the browser-side
 *                            FirstLaunchGate keys off so a first-time
 *                            external visitor lands on the PIN wizard
 *                            instead of seeing broken pages from 401s.
 */
router.get('/admin/auth-status', asyncWrapper(async (req, res) => {
  const db = getDb();
  const adminTokenStr = extractAdminToken(req);
  const loggedIn = !!(adminTokenStr && adminSession.validateSession(adminTokenStr));

  const authEnabled       = isAuthEnabled(db);
  const lanBypassEnabled  = isLanBypassEnabled(db);
  const callerIsLan       = isLanIp(req.ip);

  // pairing_required mirrors the gate logic in requireClientOrAdmin, but as
  // a hint instead of a hard 401. Returns true only when the caller would
  // be turned away by the real gate AND has no obvious way back in.
  let pairingRequired = false;
  if (authEnabled && !loggedIn) {
    if (!(lanBypassEnabled && callerIsLan)) {
      const clientToken = extractClientToken(req);
      let clientTokenValid = false;
      if (clientToken) {
        const row = db.prepare(
          'SELECT id, revoked FROM paired_clients WHERE token_hash = ?'
        ).get(hashToken(clientToken));
        clientTokenValid = !!(row && !row.revoked);
      }
      pairingRequired = !clientTokenValid;
    }
  }

  res.json({
    data: {
      configured:         !!getSetting(db, 'admin_password_hash'),
      logged_in:          loggedIn,
      auth_enabled:       authEnabled,
      lan_bypass_enabled: lanBypassEnabled,
      caller_is_lan:      callerIsLan,
      pairing_required:   pairingRequired,
    },
  });
}));

/**
 * POST /api/admin/setup
 *
 * Public ONLY before any admin password has been set. Once a password
 * exists this route returns 409 — changing the password requires logging
 * in and calling `PUT /api/admin/password`.
 *
 * Body: { password }. We never persist the plaintext; the scrypt hash goes
 * into the settings table under `admin_password_hash`.
 */
router.post('/admin/setup', asyncWrapper(async (req, res) => {
  const db = getDb();
  if (getSetting(db, 'admin_password_hash')) {
    return res.status(409).json({ error: 'Admin already configured. Use /admin/login.' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  setSetting(db, 'admin_password_hash', hashPassword(password));
  console.log('[Admin] Initial password set.');

  const token = adminSession.createSession();
  res.json({ data: { admin_token: token } });
}));

/**
 * POST /api/admin/login
 * Body: { password }
 */
router.post('/admin/login', asyncWrapper(async (req, res) => {
  if (!rateLimit.check(`admin-login:${req.ip}`, LOGIN_LIMIT_PER_MIN, 60_000)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
  }
  const db = getDb();
  const stored = getSetting(db, 'admin_password_hash');
  if (!stored) {
    return res.status(409).json({ error: 'Admin not configured. POST /admin/setup first.' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyPassword(password, stored)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = adminSession.createSession();
  res.json({ data: { admin_token: token } });
}));

/**
 * POST /api/admin/logout
 * Revokes the bearer admin token. Idempotent.
 */
router.post('/admin/logout', asyncWrapper(async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (typeof token === 'string') adminSession.revokeSession(token);
  res.json({ message: 'Logged out' });
}));

/**
 * PUT /api/admin/password
 * Body: { current_password, new_password }
 * Requires admin auth. Revokes all existing admin sessions on success.
 */
router.put('/admin/password', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const stored = getSetting(db, 'admin_password_hash');
  const current = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
  const next    = typeof req.body?.new_password     === 'string' ? req.body.new_password     : '';
  if (!verifyPassword(current, stored)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (next.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  setSetting(db, 'admin_password_hash', hashPassword(next));
  adminSession.revokeAll();
  console.log('[Admin] Password changed — all sessions revoked.');

  const fresh = adminSession.createSession();
  res.json({ data: { admin_token: fresh } });
}));

/**
 * GET /api/admin/security-settings
 * PUT /api/admin/security-settings
 *
 * Toggles for whether client-token auth is enforced on regular API routes
 * and whether LAN clients skip the token check.
 */
router.get('/admin/security-settings', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  res.json({
    data: {
      auth_enabled:        isAuthEnabled(db),
      lan_bypass_enabled:  isLanBypassEnabled(db),
    },
  });
}));

router.put('/admin/security-settings', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const body = req.body || {};
  if ('auth_enabled' in body) {
    setSetting(db, 'auth_enabled', body.auth_enabled ? '1' : '0');
  }
  if ('lan_bypass_enabled' in body) {
    setSetting(db, 'lan_bypass_enabled', body.lan_bypass_enabled ? '1' : '0');
  }
  res.json({
    data: {
      auth_enabled:        isAuthEnabled(db),
      lan_bypass_enabled:  isLanBypassEnabled(db),
    },
  });
}));

/**
 * GET /api/admin/pairings/pending
 *
 * Lists every active pending pairing along with its PIN so the admin can
 * read the PIN aloud / type it into the requesting client. This is the
 * Apollo-style flow: the PIN is visible only to whoever is logged into the
 * server admin UI.
 */
router.get('/admin/pairings/pending', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM pending_pairings WHERE expires_at <= unixepoch()').run();
  const rows = db.prepare(`
    SELECT id, pin, device_name, platform, ip, requested_at, expires_at, attempts
      FROM pending_pairings
     WHERE approved_token IS NULL
     ORDER BY requested_at DESC
  `).all();
  res.json({ data: rows });
}));

/**
 * DELETE /api/admin/pairings/:id
 * Manually cancel a pending pairing (admin doesn't want this device to pair).
 */
router.delete('/admin/pairings/:id', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const { changes } = db.prepare('DELETE FROM pending_pairings WHERE id = ?').run(req.params.id);
  res.json({ data: { deleted: changes } });
}));

/**
 * GET /api/admin/clients
 * Paired clients list. Tokens are never returned — only the metadata.
 */
router.get('/admin/clients', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, device_name, platform, created_at, last_seen_at, last_seen_ip, revoked
      FROM paired_clients
     ORDER BY (revoked = 1) ASC, COALESCE(last_seen_at, created_at) DESC
  `).all();
  res.json({ data: rows });
}));

/**
 * DELETE /api/admin/clients/:id
 * Revokes (soft-deletes) a paired client. Future requests with that token
 * are rejected by the auth middleware. Idempotent.
 */
router.delete('/admin/clients/:id', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid client id' });
  const { changes } = db.prepare('UPDATE paired_clients SET revoked = 1 WHERE id = ?').run(id);
  if (changes === 0) return res.status(404).json({ error: 'Client not found' });
  console.log(`[Admin] Revoked paired client id=${id}`);
  res.json({ data: { revoked: id } });
}));

module.exports = router;
