const express = require('express');
const { getDb, DEFAULT_USER_ID, seedDefaultLists } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { hashPassword, verifyPassword } = require('../auth/crypto');
const userSession = require('../auth/userSession');
const loginLockout = require('../auth/loginLockout');
const rateLimit = require('../auth/rateLimit');
const connectionLog = require('../auth/connectionLog');
const { requireUser, extractUserToken, allowRegistration } = require('../middleware/userAuth');

const router = express.Router();

// 3–32 chars: letters, digits, dot, underscore, hyphen.
const USERNAME_RE   = /^[a-z0-9_.-]{3,32}$/i;
const MIN_PASSWORD  = 8;
const REGISTER_LIMIT_PER_MIN = 10;
const LOGIN_LIMIT_PER_MIN    = 20;
const EXISTS_LIMIT_PER_MIN   = 30;

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, is_admin: u.is_admin };
}

// The paired device this request rode in on (null for LAN/admin/open).
function pairedClientId(req) {
  return req.auth && req.auth.kind === 'client' ? req.auth.clientId : null;
}

function lockedResponse(res, status) {
  return res.status(429).json({
    error: 'Too many failed logins. This device is locked for 24 hours.',
    locked_until: status.locked_until,
    seconds_remaining: status.seconds_remaining ?? Math.max(0, status.locked_until - Math.floor(Date.now() / 1000)),
  });
}

/**
 * POST /api/users/register
 *
 * Reachable only after the network gate (so an unpaired external visitor can't
 * create an account — requirement #6). The very first account *adopts* the
 * default user row (id=1), inheriting all pre-accounts reading data; later
 * accounts are created fresh. Returns a session token.
 */
router.post('/users/register', asyncWrapper(async (req, res) => {
  const fp = connectionLog.fingerprint(req);
  if (!rateLimit.check(`user-reg:${req.ip}`, REGISTER_LIMIT_PER_MIN, 60_000)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  const db = getDb();
  if (!allowRegistration(db)) {
    return res.status(403).json({ error: 'Account creation is disabled on this server.' });
  }

  const username    = String(req.body?.username || '').trim();
  const password    = typeof req.body?.password === 'string' ? req.body.password : '';
  const displayName = (String(req.body?.display_name || '').trim() || username).slice(0, 64);

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, and . _ -' });
  }
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  const realAccounts = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE NOT (id = ? AND username = 'default')"
  ).get(DEFAULT_USER_ID).n;

  const passwordHash = hashPassword(password);
  let userId;
  try {
    if (realAccounts === 0) {
      // Adopt the default user — its migrated reading data becomes this account's.
      db.prepare(
        'UPDATE users SET username = ?, display_name = ?, password_hash = ?, is_admin = 1, disabled = 0 WHERE id = ?'
      ).run(username, displayName, passwordHash, DEFAULT_USER_ID);
      userId = DEFAULT_USER_ID;
    } else {
      const info = db.prepare(
        'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0)'
      ).run(username, displayName, passwordHash);
      userId = info.lastInsertRowid;
    }
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'That username is already taken.' });
    throw err;
  }

  seedDefaultLists(db, userId); // no-op for the adopted default user (already seeded)
  db.prepare('UPDATE users SET last_login_at = unixepoch() WHERE id = ?').run(userId);

  const token = userSession.create(userId, pairedClientId(req), req);
  const user = db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(userId);

  connectionLog.recordEvent('user_register', { ...fp, username, paired_client_id: pairedClientId(req) });
  res.status(201).json({ data: { user_token: token, user: publicUser(user) } });
}));

/**
 * POST /api/users/login
 *
 * Lockout-guarded (5 failures → 24 h device lockout). Errors are generic to
 * avoid username enumeration.
 */
router.post('/users/login', asyncWrapper(async (req, res) => {
  const fp = connectionLog.fingerprint(req);
  if (!rateLimit.check(`user-login:${req.ip}`, LOGIN_LIMIT_PER_MIN, 60_000)) {
    connectionLog.recordEvent('user_login_fail', { ...fp, detail: 'rate limited' });
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  const db = getDb();

  const lock = loginLockout.status(req);
  if (lock.locked) {
    connectionLog.recordEvent('user_login_locked', { ...fp, detail: `unlocks at ${lock.locked_until}` });
    return lockedResponse(res, lock);
  }

  const username = String(req.body?.username || '').trim();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  const ok = !!user && !user.disabled && verifyPassword(password, user.password_hash);

  if (!ok) {
    const r = loginLockout.recordFailure(req);
    connectionLog.recordEvent('user_login_fail', {
      ...fp, username,
      detail: r.just_locked ? `locked 24h after ${r.attempts} attempts` : `attempt ${r.attempts}/${r.max_attempts}`,
    });
    if (r.locked) return lockedResponse(res, r);
    return res.status(401).json({ error: 'Incorrect username or password', attempts_remaining: r.attempts_remaining });
  }

  loginLockout.clear(req);
  db.prepare('UPDATE users SET last_login_at = unixepoch() WHERE id = ?').run(user.id);
  const token = userSession.create(user.id, pairedClientId(req), req);

  connectionLog.recordEvent('user_login_ok', { ...fp, username: user.username, paired_client_id: pairedClientId(req) });
  res.json({ data: { user_token: token, user: publicUser(user) } });
}));

/**
 * POST /api/users/logout — revoke the caller's session.
 */
router.post('/users/logout', requireUser, asyncWrapper(async (req, res) => {
  userSession.revoke(extractUserToken(req));
  connectionLog.recordEvent('user_logout', { ...connectionLog.fingerprint(req), username: req.user?.username });
  res.json({ message: 'Logged out' });
}));

/**
 * PUT /api/users/me/password — change the caller's own password.
 *
 * Verifies the current password before updating, then revokes every existing
 * session for this user and mints a fresh one so the caller stays logged in
 * while every other device is logged out. Mirrors the admin /admin/password
 * pattern.
 */
router.put('/users/me/password', requireUser, asyncWrapper(async (req, res) => {
  const db = getDb();
  const current = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
  const next    = typeof req.body?.new_password     === 'string' ? req.body.new_password     : '';

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !verifyPassword(current, row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters.` });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  userSession.revokeAllForUser(req.user.id);
  const token = userSession.create(req.user.id, pairedClientId(req), req);

  connectionLog.recordEvent('user_password_changed', {
    ...connectionLog.fingerprint(req),
    username: req.user.username,
  });
  res.json({ data: { user_token: token } });
}));

/**
 * GET /api/users/me — the active account.
 */
router.get('/users/me', requireUser, asyncWrapper(async (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT id, username, display_name, is_admin FROM users WHERE id = ?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ data: publicUser(u) });
}));

/**
 * GET /api/users/exists?username= — boolean availability check for the
 * register form. Rate-limited and boolean-only (no enumeration of anything
 * beyond "is this name free").
 */
router.get('/users/exists', asyncWrapper(async (req, res) => {
  if (!rateLimit.check(`user-exists:${req.ip}`, EXISTS_LIMIT_PER_MIN, 60_000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  const username = String(req.query?.username || '').trim();
  if (!USERNAME_RE.test(username)) return res.json({ data: { valid: false, exists: false } });
  const db = getDb();
  const exists = !!db.prepare(
    "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND NOT (id = ? AND username = 'default')"
  ).get(username, DEFAULT_USER_ID);
  res.json({ data: { valid: true, exists } });
}));

module.exports = router;
