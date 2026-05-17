/**
 * Forensic connection log + per-client metrics. Two responsibilities:
 *
 *   1. `recordEvent` — appends a row to `connection_attempts` for every
 *      auth-surface event (pairing request, wrong PIN, lockout, pair
 *      success, paired-client request, admin login). The CSV export reads
 *      this table directly so the admin can spot patterns (one IP probing
 *      many device names, repeated lockouts, etc).
 *
 *   2. `recordClientRequest` — buffers per-paired-client request counts and
 *      flushes them to `paired_clients` no more than once a minute. The
 *      throttle avoids a DB write per request without losing accuracy:
 *      counts accumulate in memory and the flusher writes the delta.
 *
 * Events:
 *   - 'pairing_request'   — POST /pairing/request succeeded
 *   - 'pin_wrong'         — POST /pairing/submit-pin with a bad PIN
 *   - 'pin_correct'       — successful pair
 *   - 'lockout'           — IP just hit the wrong-PIN cap
 *   - 'lockout_blocked'   — request from a currently-locked IP
 *   - 'pair_rate_limited' — burst rate limiter rejected a submit
 *   - 'request_rate_limited' — burst rate limiter rejected a /pairing/request
 *   - 'client_request'    — sampled paired-client API hit (first hit only
 *                            within a flush window — see recordClientRequest)
 *   - 'admin_login_ok'    — successful admin login
 *   - 'admin_login_fail'  — wrong admin password
 */

const { getDb } = require('../db/database');
const userAgent = require('./userAgent');

const FLUSH_INTERVAL_MS = 60_000;

// clientId -> { count, lastIp, lastUa }
const pendingMetrics = new Map();
// clientId -> last flush time (ms)
const lastFlushAt    = new Map();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function fingerprint(req) {
  const ua = (req && req.headers && req.headers['user-agent']) || '';
  const parsed = userAgent.detect(ua);
  return {
    ip:          (req && req.ip) || '',
    user_agent:  ua,
    os:          parsed.os,
    browser:     parsed.browser,
    device_type: parsed.device_type,
  };
}

/**
 * Append a forensic-log row. `fields` may include any of:
 *   ip, user_agent, os, browser, device_type, platform, device_name,
 *   pairing_id, paired_client_id, detail
 */
function recordEvent(eventType, fields = {}) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO connection_attempts
        (event_type, ip, user_agent, os, browser, device_type, platform,
         device_name, pairing_id, paired_client_id, occurred_at, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventType,
      fields.ip          || null,
      fields.user_agent  || null,
      fields.os          || null,
      fields.browser     || null,
      fields.device_type || null,
      fields.platform    || null,
      fields.device_name || null,
      fields.pairing_id  || null,
      fields.paired_client_id == null ? null : fields.paired_client_id,
      nowSec(),
      fields.detail      || null,
    );
  } catch (err) {
    // Never fail a request because of telemetry.
    console.warn(`[ConnLog] recordEvent(${eventType}) failed: ${err.message}`);
  }
}

/**
 * Record a paired-client API hit. The counter is buffered and flushed at
 * most once per minute per client. The first request after a flush window
 * opens is also logged as a 'client_request' forensic event so the timeline
 * has periodic heartbeats; high-frequency hits in between are folded into
 * the request_count update.
 */
function recordClientRequest(clientId, req) {
  if (!clientId) return;
  const now = Date.now();
  const m = pendingMetrics.get(clientId) || { count: 0 };
  m.count++;
  m.lastIp = (req && req.ip) || '';
  m.lastUa = (req && req.headers && req.headers['user-agent']) || '';
  pendingMetrics.set(clientId, m);

  const last = lastFlushAt.get(clientId) || 0;
  if (now - last >= FLUSH_INTERVAL_MS) {
    lastFlushAt.set(clientId, now);
    flushClient(clientId);
    // First request of a new window — log a heartbeat. Subsequent requests
    // in the same window just bump the counter without a new event row.
    const fp = fingerprint(req);
    recordEvent('client_request', { ...fp, paired_client_id: clientId });
  }
}

function flushClient(clientId) {
  const m = pendingMetrics.get(clientId);
  if (!m) return;
  try {
    const db = getDb();
    const parsed = userAgent.detect(m.lastUa || '');
    db.prepare(`
      UPDATE paired_clients SET
        last_seen_at   = unixepoch(),
        last_seen_ip   = ?,
        request_count  = request_count + ?,
        user_agent     = COALESCE(NULLIF(?, ''), user_agent),
        os             = COALESCE(NULLIF(?, ''), os),
        browser        = COALESCE(NULLIF(?, ''), browser),
        device_type    = COALESCE(NULLIF(?, ''), device_type)
      WHERE id = ?
    `).run(
      m.lastIp || '',
      m.count,
      m.lastUa || '',
      parsed.os,
      parsed.browser,
      parsed.device_type,
      clientId,
    );
    pendingMetrics.delete(clientId);
  } catch (err) {
    console.warn(`[ConnLog] flushClient(${clientId}) failed: ${err.message}`);
  }
}

function flushAll() {
  for (const clientId of Array.from(pendingMetrics.keys())) {
    flushClient(clientId);
  }
}

// Periodic safety flush: ensures buffered counters don't sit indefinitely if
// a client goes idle after a burst. .unref() so the timer never blocks
// shutdown.
setInterval(() => {
  try { flushAll(); } catch (_) { /* swallowed in flushClient */ }
}, FLUSH_INTERVAL_MS).unref();

module.exports = {
  fingerprint,
  recordEvent,
  recordClientRequest,
  flushAll,
};
