const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { requireUser } = require('../middleware/userAuth');

const router = express.Router();

// Per-user, server-synced preferences. Powers Homepage Settings (and any
// future per-user UI state). Values are stored as JSON-encoded text so the
// caller sees the same types it sent. See docs/design/homepage-settings-
// expansion.md for the architectural rationale.
//
// Companion cache invalidation: changes to home_* keys must drop the
// affected user's entries from the /api/home in-memory cache, since the
// cache key is derived from the same params that flow from these prefs.
// `library` route exports `_homeCache` so we can call deleteForUser here.
const { deleteHomeCacheForUser } = require('./library');

// Keys whose values, when changed, must invalidate the per-user /api/home
// cache. Keep in sync with the Home pref reads in client/src/pages/Home.jsx.
const HOME_AFFECTING_KEYS = new Set([
  'home_default_sort',
  'home_discover_refresh_ms',
  'home_genre_score_threshold',
  'home_gallery_order',
  'home_discover_min_score',
  'home_discover_excluded_genres',
  'home_favorite_genres_mode',
  'home_favorite_genres_manual',
  'home_discover_min_match_count',
  'home_discover_library_ids',
  'home_discover_skip_bookmarked',
  'home_discover_pool_size',
  'home_discover_visible_count',
  'home_ribbon_order',
  'home_resume_hero_enabled',
  'home_genre_ribbon_count',
  'home_recent_window_hours',
]);

function rowsToObject(rows) {
  const out = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch (_) {
      // A row written outside this route (or a hand-edited DB) may not be
      // valid JSON. Return the raw string rather than dropping the row so
      // the user at least sees what's there.
      out[r.key] = r.value;
    }
  }
  return out;
}

// GET /api/user/preferences — returns every preference for the current user.
router.get(
  '/preferences',
  requireUser,
  asyncWrapper(async (req, res) => {
    const db = getDb();
    const rows = db
      .prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
      .all(req.user.id);
    res.json({ data: rowsToObject(rows) });
  }),
);

// PUT /api/user/preferences — partial merge. Each key in the body is
// upserted; keys absent from the body are left untouched. Returns the full
// merged object so the client can synchronise state without a follow-up GET.
router.put(
  '/preferences',
  requireUser,
  asyncWrapper(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object of {key: value}' });
    }
    const entries = Object.entries(body);
    if (entries.length === 0) {
      // Empty body is a no-op — return current prefs without touching the DB.
      const db = getDb();
      const rows = db
        .prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
        .all(req.user.id);
      return res.json({ data: rowsToObject(rows) });
    }
    for (const [k] of entries) {
      if (typeof k !== 'string' || !k) {
        return res.status(400).json({ error: 'Preference keys must be non-empty strings' });
      }
    }

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO user_preferences (user_id, key, value, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(user_id, key) DO UPDATE SET
        value      = excluded.value,
        updated_at = unixepoch()
    `);
    const tx = db.transaction((userId, kv) => {
      for (const [key, value] of kv) {
        upsert.run(userId, key, JSON.stringify(value));
      }
    });
    tx(req.user.id, entries);

    // Drop the user's /api/home cache slot if any home-affecting key changed,
    // so the next Home fetch rebuilds with the new filters.
    if (entries.some(([k]) => HOME_AFFECTING_KEYS.has(k))) {
      deleteHomeCacheForUser(req.user.id);
    }

    const rows = db
      .prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
      .all(req.user.id);
    res.json({ data: rowsToObject(rows) });
  }),
);

module.exports = router;
