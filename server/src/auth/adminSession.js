const { generateToken } = require('./crypto');

/**
 * In-memory admin session store. Sessions are deliberately ephemeral —
 * restarting the server logs the admin out. There is only ever one admin
 * identity (the password set during first-run security setup), but multiple
 * concurrent sessions are allowed so the admin can stay signed in on phone
 * and desktop simultaneously.
 *
 * Session token format matches the client-pairing token: 32 random bytes
 * base64url-encoded. The token is returned to the caller exactly once at
 * login and sent back on every admin request in the `X-Admin-Token` header.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours of inactivity

const sessions = new Map(); // token -> { created_at, last_used_at }

function createSession() {
  const token = generateToken();
  const now = Date.now();
  sessions.set(token, { created_at: now, last_used_at: now });
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  const now = Date.now();
  if (now - session.last_used_at > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  session.last_used_at = now;
  return true;
}

function revokeSession(token) {
  if (token) sessions.delete(token);
}

function revokeAll() {
  sessions.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.last_used_at > SESSION_TTL_MS) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref();

module.exports = { createSession, validateSession, revokeSession, revokeAll };
