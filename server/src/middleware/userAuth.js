const { getDb, DEFAULT_USER_ID } = require('../db/database');
const userSession = require('../auth/userSession');
const adminSession = require('../auth/adminSession');
const { extractAdminToken } = require('./auth');
const { getSetting } = require('../utils');

/**
 * User-identity middleware. The second of the two access layers:
 * `requireClientOrAdmin` (middleware/auth.js) answers "may this device reach
 * the server at all"; this layer answers "who is reading". They compose — a
 * request that cleared the network gate still gets a `req.user`.
 *
 * Resolution:
 *   - Multi-user OFF, or no real account has been created yet  → default user
 *     (id=1). This keeps single-user / pre-accounts installs working unchanged
 *     and lets a fresh install be used before anyone registers.
 *   - Multi-user ON with real accounts → resolve the `X-User-Token` to its
 *     session; `req.user` is null when the token is missing/invalid, and
 *     `requireUser` turns that into a 401.
 *
 * `multi_user_enabled` defaults **ON** (Phase 5). An operator can still turn it
 * off (`'0'`) for a frictionless single-user install, in which case every
 * request resolves to the default user and the app behaves exactly as it did
 * before accounts existed.
 */

const DEFAULT_USER = Object.freeze({ id: DEFAULT_USER_ID, username: 'default', is_admin: 1 });

function isMultiUserEnabled(db) {
  // Default ON. Only an explicit '0' disables it.
  return getSetting(db, 'multi_user_enabled') !== '0';
}

function allowRegistration(db) {
  // Default ON — any network-gated caller may create an account.
  return getSetting(db, 'allow_registration') !== '0';
}

/**
 * True once at least one *real* account exists. The default user (id=1,
 * username 'default') is a data-owner placeholder, not a login; until it is
 * adopted (renamed) by the first registration, the install is still "no
 * accounts" and runs in default-user mode even with the flag on.
 */
function hasRealAccounts(db) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE NOT (id = ? AND username = 'default')"
  ).get(DEFAULT_USER_ID).n > 0;
}

function extractUserToken(req) {
  const t = req.headers['x-user-token'];
  return typeof t === 'string' && t ? t.trim() : null;
}

function resolveUser(req, _res, next) {
  const db = getDb();
  if (!isMultiUserEnabled(db)) {
    req.user = DEFAULT_USER;
    return next();
  }
  const token = extractUserToken(req);
  const session = token ? userSession.validate(token, req) : null;
  if (session) {
    req.user = session.user;
    return next();
  }
  // Admin bridge (§11): a valid admin token acts as the primary owner account
  // (the default user, id=1) so the operator can use gated routes via the admin
  // session without maintaining a separate user login. A real user token always
  // wins over this; the bridge only applies when no user session is present.
  const adminTok = extractAdminToken(req);
  if (adminTok && adminSession.validateSession(adminTok)) {
    req.user = DEFAULT_USER;
    return next();
  }
  req.user = null;
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'User authentication required' });
}

module.exports = {
  resolveUser,
  requireUser,
  extractUserToken,
  isMultiUserEnabled,
  allowRegistration,
  hasRealAccounts,
  DEFAULT_USER,
};
