const crypto = require('crypto');

/**
 * Generate a 32-byte URL-safe token. Returned as base64url (~43 chars). The
 * plaintext is only ever shown once at creation; the database stores the
 * SHA-256 hash via `hashToken`.
 */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * 6-digit numeric PIN, leading zeros preserved. 1,000,000 combinations is
 * sufficient when paired with rate limiting + a 5-minute TTL + 5-attempt cap.
 */
function generatePin() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Hash the admin password with scrypt. Cost params are Node defaults
 * (N=16384, r=8, p=1) which take ~70 ms on modest hardware — fine for
 * single-admin login flows.
 *
 * Stored format: "salt_hex:hash_hex". A future cost bump would change the
 * length and force re-hashing on next successful login.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    // Guard against a malformed hash whose hex decodes to zero bytes: scrypt
    // with keylen 0 yields an empty buffer, and timingSafeEqual(empty, empty)
    // is true — i.e. *any* password would verify. A real hash is 64 bytes, so
    // a zero-length (or empty-salt) stored value is never legitimate.
    if (expected.length === 0 || salt.length === 0) return false;
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Constant-time string equality. Returns false for length mismatch (cannot be
 * timing-safe across lengths anyway, so leak that).
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = {
  generateToken,
  hashToken,
  generatePin,
  hashPassword,
  verifyPassword,
  safeEqual,
};
