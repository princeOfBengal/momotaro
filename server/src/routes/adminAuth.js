const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { hashPassword, verifyPassword, hashToken } = require('../auth/crypto');
const adminSession = require('../auth/adminSession');
const rateLimit = require('../auth/rateLimit');
const pinLockout = require('../auth/pinLockout');
const connectionLog = require('../auth/connectionLog');
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
  const fp = connectionLog.fingerprint(req);
  if (!rateLimit.check(`admin-login:${req.ip}`, LOGIN_LIMIT_PER_MIN, 60_000)) {
    connectionLog.recordEvent('admin_login_rate_limited', { ...fp, detail: `rate cap ${LOGIN_LIMIT_PER_MIN}/min` });
    return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
  }
  const db = getDb();
  const stored = getSetting(db, 'admin_password_hash');
  if (!stored) {
    return res.status(409).json({ error: 'Admin not configured. POST /admin/setup first.' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyPassword(password, stored)) {
    connectionLog.recordEvent('admin_login_fail', { ...fp, detail: 'wrong password' });
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = adminSession.createSession();
  connectionLog.recordEvent('admin_login_ok', { ...fp });
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
 * GET /api/admin/pairing-pin-settings
 *
 * Returns the admin-configurable max-wrong-PIN cap and the list of IPs that
 * are currently locked out. Used by the Client Management UI to render the
 * "Max wrong PIN attempts before lockout" input and (optionally) a list of
 * active lockouts the admin can inspect.
 */
router.get('/admin/pairing-pin-settings', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Drop expired lockout rows opportunistically so the table doesn't bloat.
  db.prepare('DELETE FROM pin_lockouts WHERE locked_until > 0 AND locked_until <= ?').run(now);
  const lockouts = db.prepare(`
    SELECT ip, failed_attempts, locked_until, updated_at
      FROM pin_lockouts
     WHERE locked_until > ?
     ORDER BY locked_until DESC
  `).all(now);
  res.json({
    data: {
      max_attempts:          pinLockout.getMaxAttempts(db),
      default_max_attempts:  pinLockout.DEFAULT_MAX_ATTEMPTS,
      min_max_attempts:      pinLockout.MIN_MAX_ATTEMPTS,
      max_max_attempts:      pinLockout.MAX_MAX_ATTEMPTS,
      lockout_duration_sec:  pinLockout.LOCKOUT_DURATION_SEC,
      active_lockouts:       lockouts,
    },
  });
}));

/**
 * PUT /api/admin/pairing-pin-settings
 * Body: { max_attempts: integer }
 */
router.put('/admin/pairing-pin-settings', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const body = req.body || {};
  if ('max_attempts' in body) {
    const n = parseInt(body.max_attempts, 10);
    if (!Number.isFinite(n) || n < pinLockout.MIN_MAX_ATTEMPTS || n > pinLockout.MAX_MAX_ATTEMPTS) {
      return res.status(400).json({
        error: `max_attempts must be an integer between ${pinLockout.MIN_MAX_ATTEMPTS} and ${pinLockout.MAX_MAX_ATTEMPTS}.`,
      });
    }
    pinLockout.setMaxAttempts(db, n);
  }
  res.json({
    data: {
      max_attempts:          pinLockout.getMaxAttempts(db),
      default_max_attempts:  pinLockout.DEFAULT_MAX_ATTEMPTS,
      min_max_attempts:      pinLockout.MIN_MAX_ATTEMPTS,
      max_max_attempts:      pinLockout.MAX_MAX_ATTEMPTS,
      lockout_duration_sec:  pinLockout.LOCKOUT_DURATION_SEC,
    },
  });
}));

/**
 * DELETE /api/admin/pairing-pin-lockouts/:ip
 * Clears the lockout for one IP — the admin's escape hatch when a household
 * member fat-fingers the PIN past the cap. Idempotent.
 */
router.delete('/admin/pairing-pin-lockouts/:ip', requireAdmin, asyncWrapper(async (req, res) => {
  const ip = String(req.params.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'IP is required' });
  pinLockout.clear(ip);
  console.log(`[Admin] Cleared pairing-PIN lockout for ${ip}`);
  res.json({ data: { cleared: ip } });
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
 * Paired clients list, with forensic fingerprint (OS, browser, device type,
 * first-seen IP, request count). Tokens are never returned — only the
 * metadata. Buffered request counts are flushed first so the numbers the
 * admin sees are current.
 */
router.get('/admin/clients', requireAdmin, asyncWrapper(async (req, res) => {
  connectionLog.flushAll();
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, device_name, platform, created_at,
           last_seen_at, last_seen_ip,
           first_seen_at, first_seen_ip,
           user_agent, os, browser, device_type,
           request_count, revoked
      FROM paired_clients
     ORDER BY (revoked = 1) ASC, COALESCE(last_seen_at, created_at) DESC
  `).all();
  res.json({ data: rows });
}));

/**
 * GET /api/admin/connection-log
 * Returns the most recent forensic events. Used by the UI to preview what
 * the CSV download will contain. `limit` query param caps the number of
 * rows (default 200, max 5000).
 */
router.get('/admin/connection-log', requireAdmin, asyncWrapper(async (req, res) => {
  connectionLog.flushAll();
  const db = getDb();
  let limit = parseInt(req.query?.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  if (limit > 5000) limit = 5000;
  const rows = db.prepare(`
    SELECT id, event_type, ip, user_agent, os, browser, device_type,
           platform, device_name, pairing_id, paired_client_id,
           occurred_at, detail
      FROM connection_attempts
     ORDER BY occurred_at DESC, id DESC
     LIMIT ?
  `).all(limit);
  const total = db.prepare('SELECT COUNT(*) AS n FROM connection_attempts').get().n;
  res.json({ data: { entries: rows, total } });
}));

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function formatUnix(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toISOString(); } catch { return ''; }
}

/**
 * GET /api/admin/connection-log.csv
 *
 * Authenticated CSV download covering every connection attempt the server
 * has observed, plus a roll-up of the current paired-client roster. The
 * file is intended as an incident-response artefact — if a malicious actor
 * probes the pairing flow, the admin can hand this CSV to law enforcement
 * or use it to identify the attacker by IP, OS, browser, and device-type
 * fingerprint.
 *
 * Output has two sections:
 *   1. PAIRED DEVICES — one row per row in `paired_clients`, including
 *      revoked entries. Captures aggregate per-device metrics (request
 *      count, first/last seen IPs, OS/browser fingerprint).
 *   2. CONNECTION EVENTS — one row per row in `connection_attempts`,
 *      newest first. Captures both successful and unsuccessful attempts:
 *      pairing requests, wrong-PIN guesses, lockouts, rate-limit hits, and
 *      admin-login attempts.
 *
 * Auth: admin session token via `?t=` query string (the same fallback the
 * client-token gate already uses for `<img src>` requests) — native browser
 * navigation can't send custom headers, and we want this to be downloadable
 * with a single click.
 */
router.get('/admin/connection-log.csv', asyncWrapper(async (req, res) => {
  // Custom auth path: accept either the X-Admin-Token header (when the SPA
  // does a fetch+blob download) or a `?t=` query token (when the user types
  // the URL directly). We can't put this behind `requireAdmin` because that
  // middleware only reads the header.
  const headerToken = req.headers['x-admin-token'];
  const queryToken  = typeof req.query?.t === 'string' ? req.query.t : '';
  const adminToken  = (typeof headerToken === 'string' && headerToken) || queryToken;
  if (!adminToken || !adminSession.validateSession(adminToken)) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  connectionLog.flushAll();

  const db = getDb();
  const fp = connectionLog.fingerprint(req);
  connectionLog.recordEvent('connection_log_exported', { ...fp, detail: 'CSV export' });

  const clients = db.prepare(`
    SELECT id, device_name, platform, created_at,
           first_seen_at, first_seen_ip,
           last_seen_at, last_seen_ip,
           user_agent, os, browser, device_type,
           request_count, revoked
      FROM paired_clients
     ORDER BY (revoked = 1) ASC, COALESCE(last_seen_at, created_at) DESC
  `).all();

  const events = db.prepare(`
    SELECT id, event_type, ip, user_agent, os, browser, device_type,
           platform, device_name, pairing_id, paired_client_id,
           occurred_at, detail
      FROM connection_attempts
     ORDER BY occurred_at DESC, id DESC
  `).all();

  const lines = [];

  lines.push(csvEscape(`Momotaro connection log — generated ${new Date().toISOString()}`));
  lines.push('');
  lines.push(csvEscape('SECTION: PAIRED DEVICES'));
  const clientHeader = [
    'ID', 'Device name', 'Platform', 'Device type', 'OS', 'Browser',
    'User agent', 'First seen (UTC)', 'First seen IP',
    'Last seen (UTC)', 'Last seen IP', 'Paired at (UTC)',
    'Request count', 'Status',
  ];
  lines.push(clientHeader.map(csvEscape).join(','));
  for (const c of clients) {
    lines.push([
      c.id,
      c.device_name || '',
      c.platform || '',
      c.device_type || '',
      c.os || '',
      c.browser || '',
      c.user_agent || '',
      formatUnix(c.first_seen_at || c.created_at),
      c.first_seen_ip || '',
      formatUnix(c.last_seen_at),
      c.last_seen_ip || '',
      formatUnix(c.created_at),
      c.request_count || 0,
      c.revoked ? 'revoked' : 'active',
    ].map(csvEscape).join(','));
  }

  lines.push('');
  lines.push(csvEscape('SECTION: CONNECTION EVENTS (newest first)'));
  const eventHeader = [
    'Event ID', 'Occurred at (UTC)', 'Event type', 'IP', 'Device type',
    'OS', 'Browser', 'Platform', 'Device name', 'User agent',
    'Pairing ID', 'Paired client ID', 'Detail',
  ];
  lines.push(eventHeader.map(csvEscape).join(','));
  for (const e of events) {
    lines.push([
      e.id,
      formatUnix(e.occurred_at),
      e.event_type || '',
      e.ip || '',
      e.device_type || '',
      e.os || '',
      e.browser || '',
      e.platform || '',
      e.device_name || '',
      e.user_agent || '',
      e.pairing_id || '',
      e.paired_client_id == null ? '' : e.paired_client_id,
      e.detail || '',
    ].map(csvEscape).join(','));
  }

  // UTF-8 BOM so Windows Excel renders non-ASCII (Japanese, French, etc.)
  // cleanly. RFC 4180 line endings.
  const body = '﻿' + lines.join('\r\n') + '\r\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="momotaro-connection-log-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}));

/**
 * DELETE /api/admin/connection-log
 * Wipes the event log. Useful before handing the server off, or after
 * exporting and archiving the CSV.
 */
router.delete('/admin/connection-log', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const { changes } = db.prepare('DELETE FROM connection_attempts').run();
  console.log(`[Admin] Cleared ${changes} connection-log rows.`);
  res.json({ data: { deleted: changes } });
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
