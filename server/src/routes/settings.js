const express = require('express');
const fetch = require('node-fetch');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { getViewer } = require('../metadata/anilist');
const { loginDoujinshi } = require('../metadata/doujinshi');

const router = express.Router();

const SECRET_KEYS = [
  'anilist_token', 'anilist_client_secret',
  'doujinshi_token', 'doujinshi_refresh_token',
];
const USER_KEYS = ['anilist_user_id', 'anilist_username', 'anilist_avatar'];

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) || null;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value || '');
}

function getDeviceSession(db, deviceId) {
  if (!deviceId) return null;
  return db.prepare('SELECT * FROM device_anilist_sessions WHERE device_id = ?').get(deviceId) || null;
}

function setDeviceSession(db, deviceId, fields) {
  const { anilist_token, anilist_user_id, anilist_username, anilist_avatar } = fields;
  db.prepare(`
    INSERT INTO device_anilist_sessions (device_id, anilist_token, anilist_user_id, anilist_username, anilist_avatar, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(device_id) DO UPDATE SET
      anilist_token    = excluded.anilist_token,
      anilist_user_id  = excluded.anilist_user_id,
      anilist_username = excluded.anilist_username,
      anilist_avatar   = excluded.anilist_avatar,
      updated_at       = unixepoch()
  `).run(deviceId, anilist_token || '', anilist_user_id || '', anilist_username || '', anilist_avatar || '');
}

function deleteDeviceSession(db, deviceId) {
  if (!deviceId) return;
  db.prepare('DELETE FROM device_anilist_sessions WHERE device_id = ?').run(deviceId);
}

// GET /api/settings
router.get('/settings', asyncWrapper(async (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const raw = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const deviceId = req.headers['x-device-id'] || null;
  const session = getDeviceSession(db, deviceId);

  res.json({
    data: {
      anilist_client_id:         raw['anilist_client_id'] || '',
      anilist_client_secret_set: !!(raw['anilist_client_secret']),
      anilist_token_set:         !!(session?.anilist_token),
      anilist_logged_in:         !!(session?.anilist_token && session?.anilist_user_id),
      anilist_user_id:           session?.anilist_user_id  || null,
      anilist_username:          session?.anilist_username || null,
      anilist_avatar:            session?.anilist_avatar   || null,
      doujinshi_logged_in:       !!(raw['doujinshi_token']),
    },
  });
}));

// PUT /api/settings — save client_id and/or client_secret
router.put('/settings', asyncWrapper(async (req, res) => {
  const db = getDb();
  const allowed = ['anilist_client_id', 'anilist_client_secret'];
  for (const key of allowed) {
    if (key in req.body) setSetting(db, key, req.body[key]);
  }
  res.json({ message: 'Settings saved' });
}));

// POST /api/auth/anilist/exchange — exchange OAuth authorization code for access token
router.post('/auth/anilist/exchange', asyncWrapper(async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code)         return res.status(400).json({ error: 'code is required' });
  if (!redirect_uri) return res.status(400).json({ error: 'redirect_uri is required' });

  const deviceId = req.headers['x-device-id'] || null;
  if (!deviceId) return res.status(400).json({ error: 'X-Device-ID header is required' });

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

  setDeviceSession(db, deviceId, {
    anilist_token:    accessToken,
    anilist_user_id:  String(viewer.id),
    anilist_username: viewer.name,
    anilist_avatar:   viewer.avatar?.large || viewer.avatar?.medium || '',
  });

  res.json({
    data: {
      username: viewer.name,
      avatar:   viewer.avatar?.large || viewer.avatar?.medium || null,
    },
  });
}));

// DELETE /api/auth/anilist — logout (device-scoped)
router.delete('/auth/anilist', asyncWrapper(async (req, res) => {
  const db = getDb();
  const deviceId = req.headers['x-device-id'] || null;
  deleteDeviceSession(db, deviceId);
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

module.exports = { router, getSetting, getDeviceSession };
