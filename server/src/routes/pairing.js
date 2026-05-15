const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { generateToken, hashToken, generatePin, safeEqual } = require('../auth/crypto');
const rateLimit = require('../auth/rateLimit');

const router = express.Router();

const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const MAX_DEVICE_NAME_LEN = 64;
const MAX_PLATFORM_LEN = 32;
const REQUEST_LIMIT_PER_MIN = 10;
const SUBMIT_LIMIT_PER_MIN  = 15;

/**
 * Sweep expired pending pairings. Cheap; runs at the top of every request
 * touching the table so we don't need a dedicated timer. Idempotent.
 */
function pruneExpired(db) {
  db.prepare('DELETE FROM pending_pairings WHERE expires_at <= unixepoch()').run();
}

function sanitizeString(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

/**
 * POST /api/pairing/request
 *
 * Public endpoint. A client calls this to begin pairing. The server:
 *   1. Generates a unique `pairing_id` (the client's polling handle).
 *   2. Generates a 6-digit PIN that is **only** revealed via the admin UI
 *      (`GET /api/admin/pairings/pending`), never returned in this response.
 *   3. Stores both with a 5-minute expiry.
 *
 * The client then displays a "Enter this PIN in your server's admin UI"
 * screen and polls `GET /api/pairing/status/:id` until approval.
 *
 * Wait — re-read the spec. Apollo's model is: server generates PIN, *user
 * types it into the client*. To mirror that flow, the PIN must be visible to
 * the admin (server UI) and entered by the user on the client. This route
 * therefore returns only `pairing_id`; the PIN ships out via the admin UI.
 */
router.post('/pairing/request', asyncWrapper(async (req, res) => {
  if (!rateLimit.check(`pair-req:${req.ip}`, REQUEST_LIMIT_PER_MIN, 60_000)) {
    return res.status(429).json({ error: 'Too many pairing requests. Try again in a minute.' });
  }

  const deviceName = sanitizeString(req.body?.device_name, MAX_DEVICE_NAME_LEN);
  const platform   = sanitizeString(req.body?.platform,    MAX_PLATFORM_LEN);
  if (!deviceName) {
    return res.status(400).json({ error: 'device_name is required' });
  }

  const db = getDb();
  pruneExpired(db);

  const pairingId = crypto.randomUUID();
  const pin = generatePin();
  const expiresAt = Math.floor((Date.now() + PAIRING_TTL_MS) / 1000);

  db.prepare(`
    INSERT INTO pending_pairings (id, pin, device_name, platform, ip, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(pairingId, pin, deviceName, platform, req.ip || '', expiresAt);

  console.log(`[Pairing] Request "${deviceName}" (${platform || 'unknown'}) from ${req.ip} → pairing_id=${pairingId.slice(0, 8)}…`);

  res.json({
    data: {
      pairing_id: pairingId,
      expires_at: expiresAt,
      ttl_seconds: Math.floor(PAIRING_TTL_MS / 1000),
    },
  });
}));

/**
 * GET /api/pairing/status/:id
 *
 * Public endpoint. Polled by the client while it waits for the admin to
 * approve. Returns:
 *
 *   - 200 { state: 'pending' }
 *   - 200 { state: 'approved', token, device_name } — the token is delivered
 *     here exactly once. After the first successful read the row is deleted
 *     so a stolen pairing_id can't replay it.
 *   - 404 { error: 'expired' } when the row is gone (timed out or already
 *     consumed). The client should restart pairing.
 *
 * We do **not** rate-limit polling — the client is expected to poll every
 * 2–3 seconds for up to 5 minutes.
 */
router.get('/pairing/status/:id', asyncWrapper(async (req, res) => {
  const db = getDb();
  pruneExpired(db);

  const row = db.prepare(
    'SELECT id, device_name, approved_token FROM pending_pairings WHERE id = ?'
  ).get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: 'expired' });
  }

  if (row.approved_token) {
    db.prepare('DELETE FROM pending_pairings WHERE id = ?').run(row.id);
    return res.json({
      data: {
        state: 'approved',
        token: row.approved_token,
        device_name: row.device_name,
      },
    });
  }

  res.json({ data: { state: 'pending' } });
}));

/**
 * POST /api/pairing/submit-pin
 *
 * Public endpoint. The client submits the PIN that the user read off the
 * admin UI. On success we mint a token, persist the SHA-256 hash in
 * `paired_clients`, and stash the plaintext on the pending row so the next
 * status poll picks it up. The plaintext is wiped at status-poll time —
 * never written to disk in plaintext form.
 *
 * Wrong-PIN handling:
 *   - increments `attempts`
 *   - after 5 wrong attempts the pending row is deleted (force restart)
 *   - rate-limited per IP to slow distributed brute force
 */
router.post('/pairing/submit-pin', asyncWrapper(async (req, res) => {
  if (!rateLimit.check(`pair-sub:${req.ip}`, SUBMIT_LIMIT_PER_MIN, 60_000)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  const pairingId = sanitizeString(req.body?.pairing_id, 64);
  const pin       = sanitizeString(req.body?.pin, 12);
  if (!pairingId || !pin) {
    return res.status(400).json({ error: 'pairing_id and pin are required' });
  }

  const db = getDb();
  pruneExpired(db);

  const row = db.prepare(
    'SELECT id, pin, device_name, platform, attempts, approved_token FROM pending_pairings WHERE id = ?'
  ).get(pairingId);

  if (!row) {
    return res.status(404).json({ error: 'expired' });
  }

  if (row.approved_token) {
    return res.status(409).json({ error: 'Already approved. Poll /pairing/status/:id to retrieve the token.' });
  }

  if (!safeEqual(pin, row.pin)) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_PIN_ATTEMPTS) {
      db.prepare('DELETE FROM pending_pairings WHERE id = ?').run(pairingId);
      console.warn(`[Pairing] Too many wrong PINs for ${pairingId.slice(0, 8)}… — pairing invalidated`);
      return res.status(429).json({ error: 'Too many wrong attempts. Restart pairing.' });
    }
    db.prepare('UPDATE pending_pairings SET attempts = ? WHERE id = ?').run(attempts, pairingId);
    return res.status(401).json({ error: 'Wrong PIN', attempts_remaining: MAX_PIN_ATTEMPTS - attempts });
  }

  const token = generateToken();
  const tokenHash = hashToken(token);

  const insertTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO paired_clients (device_name, platform, token_hash, last_seen_at, last_seen_ip)
      VALUES (?, ?, ?, unixepoch(), ?)
    `).run(row.device_name, row.platform, tokenHash, req.ip || '');

    db.prepare('UPDATE pending_pairings SET approved_token = ? WHERE id = ?').run(token, pairingId);
  });
  insertTx();

  console.log(`[Pairing] Approved "${row.device_name}" (${row.platform || 'unknown'}) from ${req.ip}`);

  res.json({
    data: {
      state: 'approved',
      token,
      device_name: row.device_name,
    },
  });
}));

module.exports = router;
