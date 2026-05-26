const express = require('express');
const fetch = require('node-fetch');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { getViewer } = require('../metadata/anilist');
const { loginDoujinshi } = require('../metadata/doujinshi');
const downloader = require('../downloader/queue');
const { getSetting, setSetting } = require('../utils');

const router = express.Router();

const SECRET_KEYS = [
  'anilist_token', 'anilist_client_secret',
  'doujinshi_token', 'doujinshi_refresh_token',
  'mal_client_id',
];
const USER_KEYS = ['anilist_user_id', 'anilist_username', 'anilist_avatar'];

// AniList login is per Momotaro **user** (not per device): each account links
// its own AniList, and many AniList accounts coexist on one server. Stored in
// `user_anilist_sessions` keyed by user_id.
function getUserAniList(db, userId) {
  if (!userId) return null;
  return db.prepare('SELECT * FROM user_anilist_sessions WHERE user_id = ?').get(userId) || null;
}

function setUserAniList(db, userId, fields) {
  const { anilist_token, anilist_user_id, anilist_username, anilist_avatar, token_expires_at } = fields;
  db.prepare(`
    INSERT INTO user_anilist_sessions
      (user_id, anilist_token, anilist_user_id, anilist_username, anilist_avatar, token_expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      anilist_token    = excluded.anilist_token,
      anilist_user_id  = excluded.anilist_user_id,
      anilist_username = excluded.anilist_username,
      anilist_avatar   = excluded.anilist_avatar,
      token_expires_at = excluded.token_expires_at,
      updated_at       = unixepoch()
  `).run(
    userId,
    anilist_token || '', anilist_user_id || '', anilist_username || '', anilist_avatar || '',
    token_expires_at ?? null,
  );
}

function deleteUserAniList(db, userId) {
  if (!userId) return;
  db.prepare('DELETE FROM user_anilist_sessions WHERE user_id = ?').run(userId);
}

// AniList access tokens are JWTs valid ~1 year with no usable refresh. Decode
// (without verifying — the token came straight from AniList's token endpoint)
// to surface the `exp` so the UI can prompt re-login instead of silently
// failing once it lapses.
function decodeJwtExp(token) {
  try {
    const payloadB64 = String(token).split('.')[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

// GET /api/settings
router.get('/settings', asyncWrapper(async (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const raw = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const session = getUserAniList(db, req.user?.id);

  res.json({
    data: {
      anilist_client_id:           raw['anilist_client_id'] || '',
      anilist_client_secret_set:   !!(raw['anilist_client_secret']),
      anilist_token_set:           !!(session?.anilist_token),
      anilist_logged_in:           !!(session?.anilist_token && session?.anilist_user_id),
      anilist_user_id:             session?.anilist_user_id  || null,
      anilist_username:            session?.anilist_username || null,
      anilist_avatar:              session?.anilist_avatar   || null,
      anilist_token_expires_at:    session?.token_expires_at || null,
      doujinshi_logged_in:       !!(raw['doujinshi_token']),
      mal_client_id_set:         !!(raw['mal_client_id']),
      tps_max_concurrent_chapters: downloader.getSettings().max_concurrent,
      tps_page_delay_ms:           downloader.getSettings().page_delay_ms,
    },
  });
}));

// PUT /api/settings — save client credentials
router.put('/settings', asyncWrapper(async (req, res) => {
  const db = getDb();
  const allowed = ['anilist_client_id', 'anilist_client_secret', 'mal_client_id'];
  for (const key of allowed) {
    if (key in req.body) setSetting(db, key, req.body[key]);
  }

  // Third Party Sourcing — concurrency + per-page delay. Validate before
  // writing so a bad value can't disable the downloader.
  let tpsChanged = false;
  if ('tps_max_concurrent_chapters' in req.body) {
    const n = parseInt(req.body.tps_max_concurrent_chapters, 10);
    if (!Number.isFinite(n) || n < 1 || n > 8) {
      return res.status(400).json({ error: 'tps_max_concurrent_chapters must be an integer in [1, 8]' });
    }
    setSetting(db, 'tps_max_concurrent_chapters', String(n));
    tpsChanged = true;
  }
  if ('tps_page_delay_ms' in req.body) {
    const n = parseInt(req.body.tps_page_delay_ms, 10);
    if (!Number.isFinite(n) || n < 0 || n > 60_000) {
      return res.status(400).json({ error: 'tps_page_delay_ms must be an integer in [0, 60000]' });
    }
    setSetting(db, 'tps_page_delay_ms', String(n));
    tpsChanged = true;
  }
  if (tpsChanged) downloader.applySettings();

  res.json({ message: 'Settings saved' });
}));

// POST /api/auth/anilist/exchange — exchange OAuth authorization code for access token
router.post('/auth/anilist/exchange', asyncWrapper(async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code)         return res.status(400).json({ error: 'code is required' });
  if (!redirect_uri) return res.status(400).json({ error: 'redirect_uri is required' });

  // AniList is linked to the logged-in Momotaro user. In single-user /
  // pre-accounts mode resolveUser yields the default user, so this keeps
  // working without a login.
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'User authentication required' });

  const db = getDb();
  const clientId     = getSetting(db, 'anilist_client_id');
  const clientSecret = getSetting(db, 'anilist_client_secret');

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'AniList Client ID and Client Secret must be saved in Settings first.' });
  }

  // Exchange code for access token
  const tokenResp = await fetch('https://anilist.co/api/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirect_uri,
      code,
    }),
  });

  const tokenJson = await tokenResp.json();
  if (!tokenResp.ok) {
    const msg = tokenJson?.message || tokenJson?.error || `HTTP ${tokenResp.status}`;
    return res.status(400).json({ error: 'Token exchange failed: ' + msg });
  }

  const accessToken = tokenJson.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: 'No access_token in AniList response' });
  }

  // Validate token + fetch user profile
  let viewer;
  try {
    viewer = await getViewer(accessToken);
  } catch (err) {
    return res.status(401).json({ error: 'Could not fetch user profile: ' + err.message });
  }

  setUserAniList(db, userId, {
    anilist_token:    accessToken,
    anilist_user_id:  String(viewer.id),
    anilist_username: viewer.name,
    anilist_avatar:   viewer.avatar?.large || viewer.avatar?.medium || '',
    token_expires_at: decodeJwtExp(accessToken),
  });

  res.json({
    data: {
      username: viewer.name,
      avatar:   viewer.avatar?.large || viewer.avatar?.medium || null,
    },
  });
}));

// DELETE /api/auth/anilist — unlink AniList for the logged-in user
router.delete('/auth/anilist', asyncWrapper(async (req, res) => {
  const db = getDb();
  deleteUserAniList(db, req.user?.id);
  res.json({ message: 'Logged out' });
}));

// POST /api/auth/doujinshi/login — email/password login (server-wide token)
router.post('/auth/doujinshi/login', asyncWrapper(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  let tokens;
  try {
    tokens = await loginDoujinshi(email, password);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const db = getDb();
  setSetting(db, 'doujinshi_token',         tokens.access_token);
  setSetting(db, 'doujinshi_refresh_token',  tokens.refresh_token || '');

  res.json({ data: { logged_in: true } });
}));

// DELETE /api/auth/doujinshi — logout (clears server-wide doujinshi token)
router.delete('/auth/doujinshi', asyncWrapper(async (req, res) => {
  const db = getDb();
  setSetting(db, 'doujinshi_token',         '');
  setSetting(db, 'doujinshi_refresh_token',  '');
  res.json({ message: 'Logged out of Doujinshi.info' });
}));

module.exports = { router, getSetting, getUserAniList };
