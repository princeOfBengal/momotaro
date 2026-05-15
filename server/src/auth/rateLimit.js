/**
 * Tiny in-memory token bucket. One bucket per (key, action) — typically
 * (client IP, route group). Sufficient for a single-instance self-hosted
 * server; if Momotaro is ever clustered, replace with a Redis-backed limiter.
 */

const buckets = new Map(); // key -> { count, resetAt }

/**
 * Returns true if the request is allowed, false if it should be rejected
 * with HTTP 429. Window resets when `resetAt` elapses — strict fixed window,
 * not sliding, which is good enough for abuse-prevention granularity.
 */
function check(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

module.exports = { check };
