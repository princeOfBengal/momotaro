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
 *   - 'request_denied'    — gated request rejected (401 / 403) at the auth
 *                            middleware. Captured by requestLogger.js.
 *   - 'admin_action'      — non-GET request against /api/admin/*. Captured
 *                            by requestLogger.js so every admin write has
 *                            a full audit trail.
 *   - 'request_error'     — gated request resulted in a 4xx / 5xx response
 *                            other than the explicit denied / admin cases.
 */

const { getDb } = require('../db/database');
const userAgent = require('./userAgent');
const ipEnrichment = require('./ipEnrichment');

const FLUSH_INTERVAL_MS = 60_000;

// clientId -> { count, lastIp, lastUa, lastFingerprint }
const pendingMetrics = new Map();
// clientId -> last flush time (ms)
const lastFlushAt    = new Map();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function firstHeader(req, name) {
  if (!req || !req.headers) return '';
  const v = req.headers[name];
  if (Array.isArray(v)) return String(v[0] || '');
  return typeof v === 'string' ? v : '';
}

function pickRealIp(req) {
  // Header precedence reflects how operators commonly front Momotaro:
  //   Cloudflare Tunnel  → CF-Connecting-IP
  //   nginx / Caddy      → X-Real-IP
  //   Generic            → first hop of X-Forwarded-For
  // Fall back to Express's resolved req.ip when no proxy header is set.
  const cf  = firstHeader(req, 'cf-connecting-ip').trim();
  if (cf) return cf;
  const xri = firstHeader(req, 'x-real-ip').trim();
  if (xri) return xri;
  const xff = firstHeader(req, 'x-forwarded-for').trim();
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return ipEnrichment.normaliseIp((req && req.ip) || '');
}

/**
 * Parse the Sec-CH-UA-* family into a compact JSON blob.
 *
 *   { brands, mobile, platform, platformVersion, model, arch, bitness, fullVersionList }
 *
 * All fields are optional — modern Chromium sends most of them; Safari /
 * Firefox send none. We swallow malformed values so a hostile client
 * can't poison the log with junk.
 */
function parseClientHints(req) {
  if (!req || !req.headers) return null;
  const h = req.headers;
  const sanitise = (v) => {
    if (Array.isArray(v)) v = v[0];
    if (typeof v !== 'string') return '';
    return v.slice(0, 512).replace(/[\r\n\t]/g, ' ').trim();
  };
  const out = {};
  const brands           = sanitise(h['sec-ch-ua']);
  const mobile           = sanitise(h['sec-ch-ua-mobile']);
  const platform         = sanitise(h['sec-ch-ua-platform']);
  const platformVersion  = sanitise(h['sec-ch-ua-platform-version']);
  const model            = sanitise(h['sec-ch-ua-model']);
  const arch             = sanitise(h['sec-ch-ua-arch']);
  const bitness          = sanitise(h['sec-ch-ua-bitness']);
  const fullVersionList  = sanitise(h['sec-ch-ua-full-version-list']);
  if (brands)          out.brands = brands;
  if (mobile)          out.mobile = mobile === '?1';
  if (platform)        out.platform = platform.replace(/^"|"$/g, '');
  if (platformVersion) out.platformVersion = platformVersion.replace(/^"|"$/g, '');
  if (model)           out.model = model.replace(/^"|"$/g, '');
  if (arch)            out.arch = arch.replace(/^"|"$/g, '');
  if (bitness)         out.bitness = bitness.replace(/^"|"$/g, '');
  if (fullVersionList) out.fullVersionList = fullVersionList;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

function firstLanguage(req) {
  const al = firstHeader(req, 'accept-language');
  if (!al) return '';
  // First tag, dropping any q-weight — "fr-FR,fr;q=0.9,en;q=0.8" → "fr-FR".
  const first = al.split(',')[0]?.split(';')[0]?.trim();
  return (first || '').slice(0, 32);
}

/**
 * Build a forensic fingerprint of the request. Combines the cheap
 * user-agent parsing with header-derived fields and the cached
 * reverse-DNS / GeoIP enrichment.
 *
 * Return shape is intentionally flat so it composes with `recordEvent`
 * via spread: `recordEvent('pin_wrong', { ...fingerprint(req), detail: ... })`.
 */
function fingerprint(req) {
  const ua = firstHeader(req, 'user-agent');
  const parsed = userAgent.detect(ua);
  const reqIp  = ipEnrichment.normaliseIp((req && req.ip) || '');
  const realIp = pickRealIp(req);
  const enrichment = ipEnrichment.enrich(realIp || reqIp);
  return {
    ip:              reqIp,
    real_ip:         realIp || reqIp,
    user_agent:      ua,
    os:              parsed.os,
    browser:         parsed.browser,
    device_type:     parsed.device_type,
    accept_language: firstLanguage(req),
    referer:         firstHeader(req, 'referer'),
    origin:          firstHeader(req, 'origin'),
    forwarded_for:   firstHeader(req, 'x-forwarded-for'),
    host:            firstHeader(req, 'host'),
    protocol:        (req && req.protocol) || '',
    dnt:             firstHeader(req, 'dnt') === '1' ? 1 : 0,
    client_hints:    parseClientHints(req),
    reverse_dns:     enrichment.reverse_dns,
    country:         enrichment.country,
    region:          enrichment.region,
    city:            enrichment.city,
    timezone:        enrichment.timezone,
  };
}

/**
 * Append a forensic-log row. `fields` accepts the union of the base
 * fingerprint and any event-specific extras (platform, device_name,
 * pairing_id, paired_client_id, method, path, status_code, auth_kind,
 * detail, ...).
 */
function recordEvent(eventType, fields = {}) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO connection_attempts (
        event_type, ip, user_agent, os, browser, device_type,
        platform, device_name, pairing_id, paired_client_id,
        occurred_at, detail,
        accept_language, referer, origin, forwarded_for, real_ip,
        client_hints, method, path, status_code, protocol, host,
        reverse_dns, country, region, city, timezone, dnt, auth_kind,
        username
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?
      )
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
      fields.accept_language || null,
      fields.referer         || null,
      fields.origin          || null,
      fields.forwarded_for   || null,
      fields.real_ip         || null,
      fields.client_hints    || null,
      fields.method          || null,
      fields.path            || null,
      fields.status_code == null ? null : fields.status_code,
      fields.protocol        || null,
      fields.host            || null,
      fields.reverse_dns     || null,
      fields.country         || null,
      fields.region          || null,
      fields.city            || null,
      fields.timezone        || null,
      fields.dnt == null ? null : (fields.dnt ? 1 : 0),
      fields.auth_kind       || null,
      fields.username        || null,
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
  const fp = fingerprint(req);
  const m = pendingMetrics.get(clientId) || { count: 0 };
  m.count++;
  m.lastIp = fp.ip;
  m.lastUa = fp.user_agent;
  m.lastFingerprint = fp;
  pendingMetrics.set(clientId, m);

  const last = lastFlushAt.get(clientId) || 0;
  if (now - last >= FLUSH_INTERVAL_MS) {
    lastFlushAt.set(clientId, now);
    flushClient(clientId);
    // First request of a new window — log a heartbeat. Subsequent requests
    // in the same window just bump the counter without a new event row.
    recordEvent('client_request', {
      ...fp,
      paired_client_id: clientId,
      auth_kind:        'client',
      method:           (req && req.method) || '',
      path:             pathOf(req),
    });
  }
}

function pathOf(req) {
  if (!req) return '';
  if (typeof req.originalUrl === 'string') return req.originalUrl.split('?')[0];
  if (typeof req.path === 'string')        return req.path;
  return '';
}

function flushClient(clientId) {
  const m = pendingMetrics.get(clientId);
  if (!m) return;
  try {
    const db = getDb();
    const fp = m.lastFingerprint || {};
    const parsed = userAgent.detect(m.lastUa || '');
    db.prepare(`
      UPDATE paired_clients SET
        last_seen_at      = unixepoch(),
        last_seen_ip      = ?,
        request_count     = request_count + ?,
        user_agent        = COALESCE(NULLIF(?, ''), user_agent),
        os                = COALESCE(NULLIF(?, ''), os),
        browser           = COALESCE(NULLIF(?, ''), browser),
        device_type       = COALESCE(NULLIF(?, ''), device_type),
        accept_language   = COALESCE(NULLIF(?, ''), accept_language),
        last_real_ip      = COALESCE(NULLIF(?, ''), last_real_ip),
        last_reverse_dns  = COALESCE(NULLIF(?, ''), last_reverse_dns),
        last_country      = COALESCE(NULLIF(?, ''), last_country),
        last_region       = COALESCE(NULLIF(?, ''), last_region),
        last_city         = COALESCE(NULLIF(?, ''), last_city),
        last_timezone     = COALESCE(NULLIF(?, ''), last_timezone),
        last_client_hints = COALESCE(NULLIF(?, ''), last_client_hints)
      WHERE id = ?
    `).run(
      m.lastIp || '',
      m.count,
      m.lastUa || '',
      parsed.os,
      parsed.browser,
      parsed.device_type,
      fp.accept_language || '',
      fp.real_ip         || '',
      fp.reverse_dns     || '',
      fp.country         || '',
      fp.region          || '',
      fp.city            || '',
      fp.timezone        || '',
      fp.client_hints    || '',
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
  pathOf,
};
