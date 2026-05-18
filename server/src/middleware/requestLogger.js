/**
 * Forensic request logger.
 *
 * Sits on the gated API tier (mounted after `requireClientOrAdmin` in
 * index.js) and captures one row per "interesting" request. Definition of
 * interesting, in order of priority:
 *
 *   1. Every non-2xx response  → 'request_denied' (401/403) or
 *                                 'request_error' (everything else 4xx/5xx).
 *      These are the high-signal entries the admin actually wants to spot.
 *   2. Every admin write       → 'admin_action' for non-GET /api/admin/*
 *                                 requests, regardless of status. This gives
 *                                 a full audit trail for every server-state
 *                                 change made through the admin UI.
 *   3. Every other 2xx hit is folded into the existing per-client heartbeat
 *      via `connectionLog.recordClientRequest` (no extra row written here).
 *
 * The middleware never throws and never blocks the response — the log
 * write happens on `res.on('finish')`, after the body is on the wire.
 */

const connectionLog = require('../auth/connectionLog');

// Paths that emit their own dedicated event types — skip the generic
// admin_action / request_denied capture for these to avoid double-logging.
//
//   /api/admin/login       → admin_login_ok / admin_login_fail
//   /api/admin/connection-log.csv → connection_log_exported
//   /api/admin/connection-log     → DELETE rewrites the log; capturing its own
//                                   deletion would either be wiped immediately
//                                   or re-introduce a phantom row after
//                                   clearing.
const SUPPRESSED_PATHS = new Set([
  '/api/admin/login',
  '/api/admin/connection-log',
  '/api/admin/connection-log.csv',
]);

function isAdminWrite(req) {
  if (!req || req.method === 'GET' || req.method === 'HEAD') return false;
  const p = connectionLog.pathOf(req);
  if (SUPPRESSED_PATHS.has(p)) return false;
  return p.startsWith('/api/admin/');
}

function authKindOf(req) {
  return (req && req.auth && req.auth.kind) || 'none';
}

function pairedClientIdOf(req) {
  return (req && req.auth && req.auth.kind === 'client' && req.auth.clientId) || null;
}

function deviceNameOf(req) {
  return (req && req.auth && req.auth.kind === 'client' && req.auth.deviceName) || null;
}

function classify(status, req) {
  const p = connectionLog.pathOf(req);
  // Login / log-management endpoints emit their own event types — let
  // those win and don't duplicate them under the generic categories.
  if (SUPPRESSED_PATHS.has(p)) return null;
  if (status === 401 || status === 403) return 'request_denied';
  if (status === 429)                   return 'request_denied';
  if (isAdminWrite(req))                return 'admin_action';
  if (status >= 400)                    return 'request_error';
  return null;
}

function requestLogger(req, res, next) {
  // Bail out on the polling-heavy endpoints — they would flood the log
  // with status_code=200 rows the admin doesn't care about and would
  // make the table grow ~1 row/second per open tab.
  if (req.method === 'GET') {
    const p = connectionLog.pathOf(req);
    if (
      p === '/api/scan/status' ||
      p === '/api/admin/network/status' ||
      p === '/api/admin/pairings/pending' ||
      p === '/api/health'
    ) {
      return next();
    }
  }

  res.on('finish', () => {
    try {
      const eventType = classify(res.statusCode, req);
      if (!eventType) return;
      const fp = connectionLog.fingerprint(req);
      connectionLog.recordEvent(eventType, {
        ...fp,
        method:           req.method,
        path:             connectionLog.pathOf(req),
        status_code:      res.statusCode,
        auth_kind:        authKindOf(req),
        paired_client_id: pairedClientIdOf(req),
        device_name:      deviceNameOf(req),
      });
    } catch (_) {
      // Telemetry must never leak into the response path.
    }
  });

  next();
}

module.exports = { requestLogger };
