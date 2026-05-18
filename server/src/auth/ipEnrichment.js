/**
 * IP enrichment — reverse DNS + offline GeoIP lookups, both cached.
 *
 * Used by `connectionLog.js` to attach a country/city/hostname to every
 * captured event so the admin can spot foreign sources at a glance in the
 * UI. Both lookups are bounded and never throw — a missing geoip-lite or
 * a flaky DNS resolver degrades to empty strings rather than blocking
 * the request path.
 *
 * Both caches are in-process Maps with TTL + size caps:
 *   - reverse DNS: 30 min TTL, 10k entry cap (LRU on overflow)
 *   - geoip:      no TTL (the dataset is static for the lifetime of the
 *                 process), 10k entry cap (LRU)
 *
 * `enrich(ip)` returns synchronously with whatever's already cached and
 * fires-and-forgets a reverse DNS resolve. The next request from the
 * same IP picks up the resolved hostname.
 */

const dns = require('dns').promises;

let geoip = null;
try {
  geoip = require('geoip-lite');
} catch (_) {
  // Soft dependency — runs fine without it, just returns empty geo fields.
}

const RDNS_TTL_MS = 30 * 60 * 1000;
const RDNS_MAX    = 10_000;
const GEO_MAX     = 10_000;

const rdnsCache = new Map(); // ip -> { hostname, ts }
const rdnsInFlight = new Set(); // ips currently being resolved (dedupe)
const geoCache  = new Map(); // ip -> { country, region, city, timezone }

function trimCache(cache, max) {
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function normaliseIp(ip) {
  if (!ip) return '';
  // Strip IPv4-mapped-IPv6 prefix that Node sometimes attaches.
  return String(ip).replace(/^::ffff:/, '');
}

function looksPrivate(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

function geoLookup(ip) {
  const clean = normaliseIp(ip);
  if (!clean || looksPrivate(clean) || !geoip) {
    return { country: '', region: '', city: '', timezone: '' };
  }
  const cached = geoCache.get(clean);
  if (cached) return cached;
  let out = { country: '', region: '', city: '', timezone: '' };
  try {
    const r = geoip.lookup(clean);
    if (r) {
      out = {
        country:  r.country  || '',
        region:   r.region   || '',
        city:     r.city     || '',
        timezone: r.timezone || '',
      };
    }
  } catch (_) { /* swallow */ }
  geoCache.set(clean, out);
  trimCache(geoCache, GEO_MAX);
  return out;
}

function reverseDnsSync(ip) {
  const clean = normaliseIp(ip);
  if (!clean) return '';
  const cached = rdnsCache.get(clean);
  if (!cached) {
    // Kick off an async resolve so the next request has the answer cached.
    scheduleReverseDns(clean);
    return '';
  }
  if (Date.now() - cached.ts > RDNS_TTL_MS) {
    scheduleReverseDns(clean);
    return cached.hostname; // serve stale until refreshed
  }
  return cached.hostname;
}

function scheduleReverseDns(ip) {
  if (looksPrivate(ip)) {
    // Skip the resolver for LAN addresses — typically resolves to a router
    // hostname or fails outright. Record empty to suppress repeated tries.
    rdnsCache.set(ip, { hostname: '', ts: Date.now() });
    trimCache(rdnsCache, RDNS_MAX);
    return;
  }
  if (rdnsInFlight.has(ip)) return;
  rdnsInFlight.add(ip);
  // Bound the DNS attempt — some resolvers hang for many seconds on
  // un-PTR'd IPs.
  const timer = setTimeout(() => {
    if (rdnsInFlight.has(ip)) {
      rdnsInFlight.delete(ip);
      rdnsCache.set(ip, { hostname: '', ts: Date.now() });
      trimCache(rdnsCache, RDNS_MAX);
    }
  }, 3000);
  dns.reverse(ip).then(hosts => {
    clearTimeout(timer);
    rdnsInFlight.delete(ip);
    const hostname = Array.isArray(hosts) && hosts.length > 0 ? hosts[0] : '';
    rdnsCache.set(ip, { hostname, ts: Date.now() });
    trimCache(rdnsCache, RDNS_MAX);
  }).catch(() => {
    clearTimeout(timer);
    rdnsInFlight.delete(ip);
    rdnsCache.set(ip, { hostname: '', ts: Date.now() });
    trimCache(rdnsCache, RDNS_MAX);
  });
}

/**
 * One-shot enrichment used by `connectionLog.fingerprint(req)`. Returns
 * { reverse_dns, country, region, city, timezone } — synchronously, from
 * cache where possible. The first call for a new IP returns an empty
 * reverse_dns and schedules a background lookup; subsequent calls pick
 * up the resolved hostname.
 */
function enrich(ip) {
  const clean = normaliseIp(ip);
  return {
    reverse_dns: reverseDnsSync(clean),
    ...geoLookup(clean),
  };
}

module.exports = {
  enrich,
  geoLookup,
  reverseDnsSync,
  normaliseIp,
  looksPrivate,
};
