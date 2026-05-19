// Optional at-rest encryption for downloaded manga page content.
//
// Threat model: defends downloaded manga pages against an adversary who
// has the raw filesystem bytes but not the user's passphrase. Modern
// Android devices already use FBE so the OS encrypts everything at rest
// behind the lock screen — this layer adds a second factor that survives
// a post-unlock copy of `/Android/data/dev.momotaro.app/files/...` (e.g.
// adb pull, file-manager export). Does NOT defend against an attacker
// who can execute code inside the running Momotaro process.
//
// Scope: page bytes only. Covers (`cover.<ext>`) and `manga.json`
// metadata are deliberately stored as plaintext — they're displayed by
// the Library grid via plain `<img src>` without per-render crypto cost,
// and they're not meaningfully sensitive (titles + a 300×430 thumbnail).
// Mixing plaintext metadata with encrypted pages is intentional and
// tracked per-chapter via the `encrypted` flag on each `offline_chapters`
// row so the reader knows which path to take.
//
// Design:
//   - Off by default. The user enables it in Settings → Offline and
//     supplies a passphrase. The downloader and reader become aware on
//     the next call.
//   - Each encrypted page file is written as a single binary blob:
//
//       [12-byte IV] [ciphertext (incl. 16-byte GCM tag)]
//
//     The IV is unique per file (cryptorandom). The AES-GCM 256 key is
//     derived from the passphrase via PBKDF2-HMAC-SHA256 with 250k
//     iterations and a 16-byte salt persisted in IndexedDB's `meta` store.
//   - The reader resolves a page by:
//       1. reading the encrypted file bytes,
//       2. decrypting in JS,
//       3. wrapping the plaintext as an in-memory Blob,
//       4. handing the blob URL to <img src>.
//     Blob URLs are revoked when the reader unmounts (see offlineApi).
//
// Performance note: AES-GCM in WebView/Chromium is hardware-accelerated
// on every Android device since ~2018, so per-page decrypt is ~10ms on
// mid-tier hardware. The visible cost shows up in the reader's first-paint
// (one decrypt per visible page); subsequent flips reuse the blob URL.

import { getMeta, setMeta } from './offlineDb.js';

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES        = 16;
const IV_BYTES          = 12;
const KEY_BITS          = 256;

const META_ENABLED_KEY  = 'crypto.enabled';
const META_SALT_KEY     = 'crypto.salt_b64';
// We store an envelope challenge to verify a passphrase matches the
// existing salt-derived key without persisting the key itself. Encrypt a
// known plaintext on enable; decrypt-and-compare on unlock.
const META_CHALLENGE_KEY    = 'crypto.challenge';
const CHALLENGE_PLAINTEXT   = 'momotaro:offline:v1';

// Module-scope state. The key is only ever held in-memory, deliberately
// non-persistent — closing the app forgets it and the user must re-enter
// the passphrase on next launch (or via the unlock prompt).
let _activeKey = null;
let _enabledCached = null;

// ── Public surface ──────────────────────────────────────────────────────────

export async function isEncryptionEnabled() {
  if (_enabledCached !== null) return _enabledCached;
  _enabledCached = !!(await getMeta(META_ENABLED_KEY));
  return _enabledCached;
}

export function isUnlocked() {
  return _activeKey !== null;
}

// Enable encryption with a fresh passphrase. Creates a new salt, derives
// the key, stores the verifier challenge, and arms the in-memory key so
// downloads can encrypt right away. Idempotent only for the same
// passphrase (calling twice with different passphrases will reject the
// second call — the user has to disable + re-enable, which is a
// destructive op for existing encrypted content).
export async function enableEncryption(passphrase) {
  if (!passphrase || passphrase.length < 6) {
    throw new Error('Passphrase must be at least 6 characters.');
  }
  const already = await isEncryptionEnabled();
  if (already) {
    throw new Error('Encryption is already enabled. Disable it first to change the passphrase.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key  = await deriveKey(passphrase, salt);
  const challenge = await encryptWithKey(key, str2bytes(CHALLENGE_PLAINTEXT));
  await setMeta(META_SALT_KEY,      bytesToBase64(salt));
  await setMeta(META_CHALLENGE_KEY, bytesToBase64(challenge));
  await setMeta(META_ENABLED_KEY,   true);
  _enabledCached = true;
  _activeKey = key;
}

// Unlock an already-encrypted store. Derives the key from the user's
// passphrase + persisted salt, then verifies it by decrypting the stored
// challenge. Rejects on wrong passphrase.
export async function unlock(passphrase) {
  if (!passphrase) throw new Error('Passphrase required.');
  const enabled = await isEncryptionEnabled();
  if (!enabled) throw new Error('Encryption is not enabled.');
  const saltB64 = await getMeta(META_SALT_KEY);
  if (!saltB64) throw new Error('Encryption metadata missing — re-enable encryption.');
  const challengeB64 = await getMeta(META_CHALLENGE_KEY);
  if (!challengeB64) throw new Error('Encryption metadata missing — re-enable encryption.');

  const salt = base64ToBytes(saltB64);
  const candidate = await deriveKey(passphrase, salt);
  try {
    const plain = await decryptWithKey(candidate, base64ToBytes(challengeB64));
    if (bytes2str(plain) !== CHALLENGE_PLAINTEXT) throw new Error('Verifier mismatch');
  } catch {
    throw new Error('Wrong passphrase.');
  }
  _activeKey = candidate;
}

export function lock() {
  _activeKey = null;
}

// Disable encryption entirely. Wipes the salt + challenge so future
// downloads write plaintext again. Does NOT decrypt existing files on
// disk — the user has to re-download anything they want as plaintext.
export async function disableEncryption() {
  await setMeta(META_ENABLED_KEY,   false);
  await setMeta(META_SALT_KEY,      null);
  await setMeta(META_CHALLENGE_KEY, null);
  _enabledCached = false;
  _activeKey = null;
}

// Encrypt-on-write. Returns the bytes the downloader should hand to
// writeBytes().
//
// Three cases:
//   - Encryption disabled              → pass-through
//   - Encryption enabled + unlocked    → encrypt
//   - Encryption enabled + locked      → THROW with code 'ENCRYPTION_LOCKED'.
//
// We deliberately don't silently pass plaintext through when locked —
// doing so would leave the store in a half-encrypted state the reader
// can't make sense of. Callers handle the throw by re-queuing the job.
export async function maybeEncrypt(bytes) {
  if (!(await isEncryptionEnabled())) return bytes;
  if (!_activeKey) {
    const e = new Error('Encryption is enabled but locked.');
    e.code = 'ENCRYPTION_LOCKED';
    throw e;
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return encryptWithKey(_activeKey, u8);
}

// Decrypt-on-read.
//   - Encryption disabled              → pass-through
//   - Encryption enabled + unlocked    → decrypt (throws on corrupt input)
//   - Encryption enabled + locked      → THROW with code 'ENCRYPTION_LOCKED'.
//
// Same rationale as `maybeEncrypt`: silently returning ciphertext bytes
// would render a broken image with no actionable signal for the user.
// Caller catches and renders an "unlock to read" affordance.
export async function maybeDecrypt(bytes) {
  if (!(await isEncryptionEnabled())) return bytes;
  if (!_activeKey) {
    const e = new Error('Encryption is enabled but locked.');
    e.code = 'ENCRYPTION_LOCKED';
    throw e;
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return decryptWithKey(_activeKey, u8);
}

// ── Crypto primitives ──────────────────────────────────────────────────────

async function deriveKey(passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    str2bytes(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptWithKey(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

async function decryptWithKey(key, envelope) {
  if (envelope.length < IV_BYTES + 16) {
    throw new Error('Ciphertext too short');
  }
  const iv = envelope.slice(0, IV_BYTES);
  const ct = envelope.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(plain);
}

function str2bytes(s) {
  return new TextEncoder().encode(s);
}
function bytes2str(b) {
  return new TextDecoder().decode(b);
}
function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
