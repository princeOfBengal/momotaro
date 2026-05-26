/**
 * Persistent user sessions, backed by the `user_sessions` table. Unlike the
 * admin session store (in-memory, 12 h), user sessions survive restarts and
 * use a long sliding window so a reader stays logged in on their phone.
 *
 * Only the SHA-256 hash of the bearer token is stored — the plaintext is
 * returned once at login/register and sent back in the `X-User-Token` header.
 * Mirrors the `paired_clients` token model.
 */

const { generateToken, hashToken } = require('./crypto');
const { getDb } = require('../db/database');

const SESSION_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days of inactivity
const SESSION_TTL_SEC = Math.floor(SESSION_TTL_MS / 1000);
// Don't write last_seen on every request — only when it has drifted past this.
const TOUCH_THROTTLE_SEC = 60;

/**
 * Mint a session for `userId`, optionally bound to the paired device it was
 * created from. Returns the plaintext token (shown once).
 */
function create(userId, pairedClientId, req) {
  const token = generateToken();
  getDb().prepare(`
    INSERT INTO user_sessions (user_id, token_hash, paired_client_id, last_seen_at, last_seen_ip)
    VALUES (?, ?, ?, unixepoch(), ?)
  `).run(userId, hashToken(token), pairedClientId || null, (req && req.ip) || null);
  return token;
}

/**
 * Resolve a token to its session + user, or null when missing / revoked /
 * expired / the account is disabled. Refreshes the sliding window (throttled).
 */
function validate(token, req) {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT s.id, s.user_id, s.last_seen_at, s.revoked,
           u.username, u.is_admin, u.disabled
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));

  if (!row || row.revoked || row.disabled) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (row.last_seen_at && (nowSec - row.last_seen_at) > SESSION_TTL_SEC) {
    db.prepare('UPDATE user_sessions SET revoked = 1 WHERE id = ?').run(row.id);
    return null;
  }

  if (!row.last_seen_at || (nowSec - row.last_seen_at) >= TOUCH_THROTTLE_SEC) {
    db.prepare('UPDATE user_sessions SET last_seen_at = unixepoch(), last_seen_ip = ? WHERE id = ?')
      .run((req && req.ip) || null, row.id);
  }

  return {
    sessionId: row.id,
    user: { id: row.user_id, username: row.username, is_admin: row.is_admin },
  };
}

/** Revoke a single session by its plaintext token. Idempotent. */
function revoke(token) {
  if (!token) return;
  getDb().prepare('UPDATE user_sessions SET revoked = 1 WHERE token_hash = ?').run(hashToken(token));
}

/** Revoke every session for a user (admin force-logout / password reset). */
function revokeAllForUser(userId) {
  getDb().prepare('UPDATE user_sessions SET revoked = 1 WHERE user_id = ?').run(userId);
}

/** Drop revoked rows and sessions past the TTL. Cheap; best-effort. */
function sweep() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - SESSION_TTL_SEC;
    getDb().prepare(
      'DELETE FROM user_sessions WHERE revoked = 1 OR (last_seen_at IS NOT NULL AND last_seen_at < ?)'
    ).run(cutoff);
  } catch (_) { /* best-effort */ }
}

setInterval(sweep, 6 * 60 * 60 * 1000).unref();

module.exports = { create, validate, revoke, revokeAllForUser, sweep, SESSION_TTL_MS };
