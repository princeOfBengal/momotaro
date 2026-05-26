const { getDb } = require('../db/database');
const { hashToken } = require('../auth/crypto');
const adminSession = require('../auth/adminSession');
const connectionLog = require('../auth/connectionLog');

/**
 * Authentication middleware for Phase 1 remote-access support.
 *
 * Two access tiers:
 *
 *  - **Client token** (`Authorization: Bearer <token>` or `X-Client-Token`):
 *    issued at the end of the PIN-pairing flow, bound to a row in
 *    `paired_clients`. Required on every gated API route when
 *    `auth_enabled = 1`.
 *
 *  - **Admin token** (`X-Admin-Token`): minted by `POST /api/admin/login`,
 *    lives in process memory (see `auth/adminSession.js`). The admin token
 *    satisfies any client-gated route as well as the admin-only routes —
 *    one fewer hoop when an admin is testing from their browser.
 *
 * `auth_enabled` toggle:
 *  - When `0` (default for fresh installs): client gate is a no-op so the
 *    existing PWA + LAN setup keeps working without changes.
 *  - When `1`: every gated route requires a valid client token, admin
 *    token, or LAN bypass.
 *
 * LAN bypass: when `lan_bypass_enabled = 1`, requests originating from
 * RFC1918 / loopback addresses skip the token check. Mirrors Apollo's
 * "internal trust" model so a phone on the same Wi-Fi can connect without
 * pairing. Disable this if your LAN is untrusted (e.g. shared office Wi-Fi).
 *
 * Note on `req.ip` accuracy: behind a reverse proxy (nginx, Caddy), Express
 * sees the proxy's IP and LAN bypass will trigger for every request. Set
 * `trust proxy` in `index.js` when fronting with a known proxy.
 */

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) || null;
}

function isLanIp(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '::1') return true;
  if (clean.startsWith('127.')) return true;
  if (clean.startsWith('10.')) return true;
  if (clean.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true;
  if (clean.startsWith('169.254.')) return true;
  const lower = clean.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

function extractClientToken(req) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-client-token'];
  if (typeof alt === 'string' && alt) return alt.trim();
  // Query-parameter fallback. Necessary for requests the browser
  // initiates natively (e.g. `<img src>`, `<video src>`) which cannot
  // carry custom headers — the SPA's `fetch()` calls still use the
  // header above. This is the same pattern Plex uses for its
  // X-Plex-Token. The Referrer-Policy: same-origin header (set in
  // index.js) prevents the token from leaking via Referer to
  // third-party origins. Server access logs on a self-hosted instance
  // are the operator's own.
  const qToken = req.query && req.query.t;
  if (typeof qToken === 'string' && qToken) return qToken.trim();
  return null;
}

function extractAdminToken(req) {
  const t = req.headers['x-admin-token'];
  return typeof t === 'string' && t ? t.trim() : null;
}

function isAuthEnabled(db) {
  return getSetting(db, 'auth_enabled') === '1';
}

/**
 * LAN bypass: on by default. Devices on the local network are trusted
 * unless the admin explicitly opts out (e.g. for an untrusted office /
 * shared Wi-Fi). The previous false-by-default flipped surprise pairing
 * prompts on home users who flipped `auth_enabled` and didn't realise
 * they also had to toggle bypass on. Plex and Jellyfin both treat LAN
 * as trusted by default.
 *
 * Backwards-compat: admins who previously toggled it OFF have a stored
 * value of '0', which we still honour. Only the unset case flips from
 * "off" to "on".
 */
function isLanBypassEnabled(db) {
  return getSetting(db, 'lan_bypass_enabled') !== '0';
}

// Per-request bookkeeping is delegated to `connectionLog.recordClientRequest`
// — it buffers counters in memory and writes them to `paired_clients` at most
// once a minute, while emitting a 'client_request' forensic event at each
// flush boundary so the CSV export has periodic heartbeats per device.

/**
 * Gate for regular API routes. Allows the request through when:
 *   - auth is disabled, OR
 *   - admin session is valid, OR
 *   - request came from a LAN IP and LAN bypass is on, OR
 *   - a valid (non-revoked) client token is presented.
 */
function requireClientOrAdmin(req, res, next) {
  const db = getDb();
  const callerIsLan = isLanIp(req.ip);

  const adminToken = extractAdminToken(req);
  if (adminToken && adminSession.validateSession(adminToken)) {
    req.auth = { kind: 'admin' };
    return next();
  }

  // The no-auth shortcuts ("open mode" and "LAN bypass") apply **only on the
  // LAN**. Traffic arriving via port forwarding from the public internet must
  // always present a paired-client token, regardless of `auth_enabled` or
  // `lan_bypass_enabled` — this is the security boundary that backs
  // requirement #6 in the user-accounts design: a new device reaching the
  // server over its public IP must complete pairing (admin-approved PIN)
  // before any account-creation prompt is even reachable.
  if (callerIsLan && !isAuthEnabled(db)) {
    req.auth = { kind: 'open' };
    return next();
  }

  if (callerIsLan && isLanBypassEnabled(db)) {
    req.auth = { kind: 'lan' };
    return next();
  }

  const token = extractClientToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const row = db.prepare(
    'SELECT id, device_name, revoked FROM paired_clients WHERE token_hash = ?'
  ).get(hashToken(token));

  if (!row || row.revoked) {
    return res.status(401).json({ error: 'Invalid or revoked token' });
  }

  connectionLog.recordClientRequest(row.id, req);
  req.auth = { kind: 'client', clientId: row.id, deviceName: row.device_name };
  return next();
}

/**
 * Gate for admin-only routes. The admin password must be set, and the
 * caller must present a valid admin session token.
 */
function requireAdmin(req, res, next) {
  const db = getDb();
  const hashSet = getSetting(db, 'admin_password_hash');
  if (!hashSet) {
    return res.status(409).json({ error: 'Admin password not configured. POST /api/admin/setup first.' });
  }
  const token = extractAdminToken(req);
  if (!token || !adminSession.validateSession(token)) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  req.auth = { kind: 'admin' };
  return next();
}

/**
 * Hard LAN-only enforcement. When `port_forwarding_mode = 'off'` (default
 * for new installs and the value the admin picks via the Port Forwarding
 * "Local only" button), every request from a non-LAN source IP is
 * rejected here — *before* auth, pairing, or any feature handler runs.
 *
 * The point is to give the user a real off switch: even if their router
 * still has a manual port-forward rule pointing at this host, the app
 * refuses to serve external traffic. This is the difference between
 * "passively stopped managing UPnP" (the old behaviour) and "actively
 * declining to accept external connections" (what the user actually
 * wants when they click Off).
 *
 * Recovery: if the admin somehow locks themselves out (e.g., toggles Off
 * while connected from cellular and immediately gets 403'd), the escape
 * hatch is to get on the LAN, or to edit the SQLite row directly
 * (`UPDATE settings SET value='manual' WHERE key='port_forwarding_mode';`)
 * via docker exec / SSH. The web UI deliberately cannot override this
 * from a non-LAN source — that's what makes it a real boundary.
 *
 * Important caveat about `req.ip`: when Momotaro sits behind a reverse
 * proxy or Docker `docker-proxy` userland forwarder, `req.ip` is the
 * proxy's IP, not the real client. In that case every request looks
 * LAN-ish and this gate is ineffective. The Client Management section
 * already documents this; the trust-proxy story is a separate fix.
 */
function enforceLanOnlyMode(req, res, next) {
  const db = getDb();
  const mode = getSetting(db, 'port_forwarding_mode') || 'off';
  if (mode !== 'off') return next();
  if (isLanIp(req.ip)) return next();
  return res.status(403).json({
    error: 'Server is in LAN-only mode. External connections are not accepted. ' +
           'Enable UPnP or Manual port forwarding in Settings to allow remote access.',
  });
}

module.exports = {
  requireClientOrAdmin,
  requireAdmin,
  enforceLanOnlyMode,
  isLanIp,
  isLanBypassEnabled,
  isAuthEnabled,
  extractClientToken,
  extractAdminToken,
};
