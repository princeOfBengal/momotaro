const express = require('express');
const { getDb, DEFAULT_USER_ID } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const cbzCacheSchedule = require('../scanner/cbzCacheSchedule');
const cbzCache = require('../scanner/cbzCache');

const router = express.Router();

// Current export-file schema version.
//   v1 — pre user-accounts: global progress / reading_lists, device_anilist_sessions.
//   v2 — user-accounts: rows carry an owning `username`; user_anilist_sessions
//        replaces device_anilist_sessions; a `users` roster (no hashes) and
//        per-user `reading_history` are included.
// The importer accepts both: v1 payloads fold every per-user row onto the
// default user, and unmatched usernames in a v2 payload do the same.
const CONFIG_VERSION = 2;

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Export ───────────────────────────────────────────────────────────────────

// Manga rows are keyed by `path` (UNIQUE column) so the export survives a
// fresh DB where auto-increment IDs differ. Reading-list memberships,
// progress, reading history, and the art gallery use the same path-based
// linkage; chapters within a manga are identified by their `folder_name`,
// which is also stable across scans. Per-user rows additionally carry the
// owning account's `username` so they can be re-attributed on import.

router.get('/admin/export-config', asyncWrapper(async (req, res) => {
  const db = getDb();
  // AniList tokens are live credentials and are redacted unless explicitly
  // requested (?include_tokens=1) for a same-owner migration.
  const includeTokens = req.query.include_tokens === '1';

  const settings = Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])
  );

  // Users — identity only, never password hashes.
  const userRows = db.prepare(
    'SELECT id, username, display_name, is_admin, disabled, created_at FROM users'
  ).all();
  const usernameById = new Map(userRows.map(u => [u.id, u.username]));
  const users = userRows.map(u => ({
    username:     u.username,
    display_name: u.display_name,
    is_admin:     u.is_admin,
    disabled:     u.disabled,
    created_at:   u.created_at,
  }));

  // Per-user AniList links (replaces device_anilist_sessions).
  const userAnilistSessions = db.prepare(`
    SELECT user_id, anilist_token, anilist_user_id, anilist_username,
           anilist_avatar, token_expires_at, updated_at
    FROM user_anilist_sessions
  `).all().map(s => ({
    username:         usernameById.get(s.user_id) || null,
    anilist_user_id:  s.anilist_user_id,
    anilist_username: s.anilist_username,
    anilist_avatar:   s.anilist_avatar,
    token_expires_at: s.token_expires_at,
    updated_at:       s.updated_at,
    ...(includeTokens ? { anilist_token: s.anilist_token } : {}),
  })).filter(s => s.username);

  const libraries = db.prepare(`
    SELECT name, path, show_in_all FROM libraries
  `).all();

  const mangaRows = db.prepare(`
    SELECT id, path, title, description, status, year, genres,
           anilist_id, mal_id, mangaupdates_id, doujinshi_id, score, author,
           metadata_source, track_volumes,
           cover_image, cover_user_set,
           anilist_cover, original_cover, mal_cover, mangaupdates_cover, doujinshi_cover
    FROM manga
  `).all();

  // Build id → path map for foreign-key translation below.
  const mangaIdToPath = new Map(mangaRows.map(m => [m.id, m.path]));

  const mangaMetadata = mangaRows.map(m => ({
    path:               m.path,
    title:              m.title,
    description:        m.description,
    status:             m.status,
    year:               m.year,
    genres:             safeJsonParse(m.genres, []),
    anilist_id:         m.anilist_id,
    mal_id:             m.mal_id,
    mangaupdates_id:    m.mangaupdates_id,
    doujinshi_id:       m.doujinshi_id,
    score:              m.score,
    author:             m.author,
    metadata_source:    m.metadata_source,
    track_volumes:      m.track_volumes,
    cover_image:        m.cover_image,
    cover_user_set:     m.cover_user_set,
    anilist_cover:      m.anilist_cover,
    original_cover:     m.original_cover,
    mal_cover:          m.mal_cover,
    mangaupdates_cover: m.mangaupdates_cover,
    doujinshi_cover:    m.doujinshi_cover,
  }));

  // Reading lists + memberships, exported by (username, path).
  const listRows = db.prepare('SELECT id, user_id, name, is_default, created_at FROM reading_lists').all();
  const membershipRows = db.prepare(`
    SELECT list_id, manga_id, added_at FROM reading_list_manga
  `).all();

  const membershipsByList = new Map();
  for (const m of membershipRows) {
    if (!membershipsByList.has(m.list_id)) membershipsByList.set(m.list_id, []);
    const path = mangaIdToPath.get(m.manga_id);
    if (path) membershipsByList.get(m.list_id).push({ manga_path: path, added_at: m.added_at });
  }

  const readingLists = listRows.map(l => ({
    username:   usernameById.get(l.user_id) || null,
    name:       l.name,
    is_default: l.is_default,
    created_at: l.created_at,
    manga:      membershipsByList.get(l.id) || [],
  })).filter(l => l.username);

  // Pre-fetch chapter id → folder_name for every referenced chapter (used by
  // both progress and reading-history translation below).
  const chapterFolderByChapterId = new Map();
  {
    const allChapters = db.prepare('SELECT id, manga_id, folder_name FROM chapters').all();
    for (const c of allChapters) chapterFolderByChapterId.set(c.id, c.folder_name);
  }

  // Progress. current_chapter_id + completed_chapters are translated into
  // chapter folder_names so the import can re-resolve them against whatever
  // chapter IDs the target DB has.
  const progressRows = db.prepare(`
    SELECT user_id, manga_id, current_chapter_id, current_page, completed_chapters,
           last_read_at, updated_at
    FROM progress
  `).all();

  const progress = progressRows.map(p => {
    const completedIds = safeJsonParse(p.completed_chapters, []);
    const completedFolders = completedIds
      .map(id => chapterFolderByChapterId.get(id))
      .filter(Boolean);
    return {
      username:                  usernameById.get(p.user_id) || null,
      manga_path:                mangaIdToPath.get(p.manga_id) || null,
      current_chapter_folder:    p.current_chapter_id
                                   ? (chapterFolderByChapterId.get(p.current_chapter_id) || null)
                                   : null,
      current_page:              p.current_page,
      completed_chapter_folders: completedFolders,
      last_read_at:              p.last_read_at,
      updated_at:                p.updated_at,
    };
  }).filter(p => p.manga_path && p.username);

  // Reading history — per-user timeline, keyed by (username, manga_path,
  // chapter_folder).
  const readingHistory = db.prepare(`
    SELECT user_id, manga_id, chapter_id, event, read_at FROM reading_history
  `).all().map(h => ({
    username:       usernameById.get(h.user_id) || null,
    manga_path:     mangaIdToPath.get(h.manga_id) || null,
    chapter_folder: h.chapter_id ? (chapterFolderByChapterId.get(h.chapter_id) || null) : null,
    event:          h.event,
    read_at:        h.read_at,
  })).filter(h => h.manga_path && h.username);

  // Art gallery — saved pages. Re-key by (manga_path, chapter_folder, page_index).
  const galleryRows = db.prepare(`
    SELECT ag.manga_id, c.folder_name AS chapter_folder, p.page_index, ag.created_at
    FROM art_gallery ag
    JOIN chapters c ON c.id = ag.chapter_id
    JOIN pages    p ON p.id = ag.page_id
  `).all();

  const artGallery = galleryRows.map(g => ({
    manga_path:     mangaIdToPath.get(g.manga_id),
    chapter_folder: g.chapter_folder,
    page_index:     g.page_index,
    created_at:     g.created_at,
  })).filter(g => g.manga_path);

  const payload = {
    version:               CONFIG_VERSION,
    app:                   'momotaro',
    exported_at:           new Date().toISOString(),
    settings,
    users,
    user_anilist_sessions: userAnilistSessions,
    libraries,
    manga_metadata:        mangaMetadata,
    reading_lists:         readingLists,
    progress,
    reading_history:       readingHistory,
    art_gallery:           artGallery,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="momotaro-config-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
}));

// ── Import ───────────────────────────────────────────────────────────────────

function validatePayload(p) {
  if (!p || typeof p !== 'object') return 'Config must be a JSON object';
  if (p.app !== 'momotaro') return 'File is not a Momotaro config export';
  if (!Number.isFinite(p.version) || p.version < 1 || p.version > CONFIG_VERSION) {
    return `Unsupported config version ${p.version} (this server accepts v1–v${CONFIG_VERSION})`;
  }
  return null;
}

router.post('/admin/import-config', asyncWrapper(async (req, res) => {
  const payload = req.body;
  const err = validatePayload(payload);
  if (err) return res.status(400).json({ error: err });

  const db = getDb();
  const warnings = [];
  let counts = {
    settings: 0, users: 0, anilist_sessions: 0, libraries: 0, manga_metadata: 0,
    reading_lists: 0, reading_list_manga: 0, progress: 0, reading_history: 0, art_gallery: 0,
  };

  const applyImport = db.transaction(() => {
    // ── Settings ────────────────────────────────────────────────────────────
    if (payload.settings && typeof payload.settings === 'object') {
      const upsert = db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      for (const [key, value] of Object.entries(payload.settings)) {
        if (typeof key !== 'string') continue;
        upsert.run(key, String(value ?? ''));
        counts.settings++;
      }
    }

    // Map existing accounts by lowercased username. We never create login
    // accounts from an import (no password hashes are carried); any unmatched
    // username — and every row in a v1 payload — folds onto the default user.
    const userIdByName = new Map(
      db.prepare('SELECT id, username FROM users').all().map(u => [u.username.toLowerCase(), u.id])
    );
    const ownerId = (username) => {
      if (!username) return DEFAULT_USER_ID;
      return userIdByName.get(String(username).toLowerCase()) ?? DEFAULT_USER_ID;
    };
    if (Array.isArray(payload.users)) {
      for (const u of payload.users) {
        if (u?.username && userIdByName.has(String(u.username).toLowerCase())) counts.users++;
      }
    }

    // ── AniList sessions ────────────────────────────────────────────────────
    if (Array.isArray(payload.user_anilist_sessions)) {
      // v2: per-user links. Only rows that still carry a token can be restored
      // (exports redact by default); a token-less row has nothing to log in with.
      const ins = db.prepare(`
        INSERT INTO user_anilist_sessions
          (user_id, anilist_token, anilist_user_id, anilist_username, anilist_avatar, token_expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          anilist_token    = excluded.anilist_token,
          anilist_user_id  = excluded.anilist_user_id,
          anilist_username = excluded.anilist_username,
          anilist_avatar   = excluded.anilist_avatar,
          token_expires_at = excluded.token_expires_at,
          updated_at       = excluded.updated_at
      `);
      for (const s of payload.user_anilist_sessions) {
        if (!s || !s.anilist_token) continue;
        ins.run(
          ownerId(s.username),
          s.anilist_token,
          s.anilist_user_id  || '',
          s.anilist_username || '',
          s.anilist_avatar   || '',
          Number.isFinite(s.token_expires_at) ? s.token_expires_at : null,
          Number.isFinite(s.updated_at) ? s.updated_at : Math.floor(Date.now() / 1000),
        );
        counts.anilist_sessions++;
      }
    } else if (Array.isArray(payload.device_anilist_sessions)) {
      // v1: fold the most-recently-updated tokened device session onto the
      // default user, matching the device→user backfill the DB migration does.
      const withTok = payload.device_anilist_sessions.filter(s => s?.anilist_token);
      withTok.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
      const s = withTok[0];
      if (s) {
        db.prepare(`
          INSERT INTO user_anilist_sessions
            (user_id, anilist_token, anilist_user_id, anilist_username, anilist_avatar, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            anilist_token    = excluded.anilist_token,
            anilist_user_id  = excluded.anilist_user_id,
            anilist_username = excluded.anilist_username,
            anilist_avatar   = excluded.anilist_avatar,
            updated_at       = excluded.updated_at
        `).run(
          DEFAULT_USER_ID,
          s.anilist_token,
          s.anilist_user_id  || '',
          s.anilist_username || '',
          s.anilist_avatar   || '',
          Number.isFinite(s.updated_at) ? s.updated_at : Math.floor(Date.now() / 1000),
        );
        counts.anilist_sessions++;
      }
    }

    // ── Libraries ───────────────────────────────────────────────────────────
    // Upsert by path so user-edited paths on disk are not clobbered silently.
    if (Array.isArray(payload.libraries)) {
      const upsert = db.prepare(`
        INSERT INTO libraries (name, path, show_in_all)
        VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          name        = excluded.name,
          show_in_all = excluded.show_in_all
      `);
      for (const l of payload.libraries) {
        if (!l?.name || !l?.path) continue;
        upsert.run(l.name, l.path, l.show_in_all ?? 1);
        counts.libraries++;
      }
    }

    // Build path → id map for the rest of the import. Only existing manga
    // rows can receive metadata / progress / list memberships; if the scanner
    // has not yet populated a given manga, we collect a warning.
    const mangaIdByPath = new Map(
      db.prepare('SELECT id, path FROM manga').all().map(m => [m.path, m.id])
    );

    // Shared (manga_id, folder_name) → chapter_id map, used by progress and
    // reading-history translation.
    const chapterIdByKey = new Map();
    for (const c of db.prepare('SELECT id, manga_id, folder_name FROM chapters').all()) {
      chapterIdByKey.set(`${c.manga_id}:${c.folder_name}`, c.id);
    }

    // ── Manga metadata ─────────────────────────────────────────────────────
    if (Array.isArray(payload.manga_metadata)) {
      const upd = db.prepare(`
        UPDATE manga SET
          title              = COALESCE(?, title),
          description        = ?,
          status             = ?,
          year               = ?,
          genres             = ?,
          anilist_id         = ?,
          mal_id             = ?,
          mangaupdates_id    = ?,
          doujinshi_id       = ?,
          score              = ?,
          author             = ?,
          metadata_source    = COALESCE(?, metadata_source),
          track_volumes      = COALESCE(?, track_volumes),
          cover_image        = COALESCE(?, cover_image),
          cover_user_set     = COALESCE(?, cover_user_set),
          anilist_cover      = ?,
          original_cover     = ?,
          mal_cover          = ?,
          mangaupdates_cover = ?,
          doujinshi_cover    = ?,
          updated_at         = unixepoch()
        WHERE id = ?
      `);
      for (const m of payload.manga_metadata) {
        const id = mangaIdByPath.get(m?.path);
        if (!id) {
          if (m?.path) warnings.push(`manga_metadata: no manga at path ${m.path} — run a scan first`);
          continue;
        }
        upd.run(
          m.title ?? null,
          m.description ?? null,
          m.status ?? null,
          Number.isFinite(m.year) ? m.year : null,
          JSON.stringify(Array.isArray(m.genres) ? m.genres : []),
          Number.isFinite(m.anilist_id)      ? m.anilist_id      : null,
          Number.isFinite(m.mal_id)          ? m.mal_id          : null,
          Number.isFinite(m.mangaupdates_id) ? m.mangaupdates_id : null,
          m.doujinshi_id ?? null,
          Number.isFinite(m.score) ? m.score : null,
          m.author ?? null,
          m.metadata_source ?? null,
          Number.isFinite(m.track_volumes) ? m.track_volumes : null,
          m.cover_image ?? null,
          (m.cover_user_set === 0 || m.cover_user_set === 1) ? m.cover_user_set : null,
          m.anilist_cover ?? null,
          m.original_cover ?? null,
          m.mal_cover ?? null,
          m.mangaupdates_cover ?? null,
          m.doujinshi_cover ?? null,
          id,
        );
        counts.manga_metadata++;
      }
    }

    // ── Reading lists + memberships ─────────────────────────────────────────
    if (Array.isArray(payload.reading_lists)) {
      // Per-owner scoped reset: wipe memberships + non-default lists only for
      // the accounts present in this payload, so other users' lists survive.
      const ownersInPayload = new Set(payload.reading_lists.map(l => ownerId(l?.username)));
      const delMembers = db.prepare(
        'DELETE FROM reading_list_manga WHERE list_id IN (SELECT id FROM reading_lists WHERE user_id = ?)'
      );
      const delLists = db.prepare('DELETE FROM reading_lists WHERE user_id = ? AND is_default = 0');
      for (const oid of ownersInPayload) { delMembers.run(oid); delLists.run(oid); }

      const insList = db.prepare(
        'INSERT INTO reading_lists (user_id, name, is_default, created_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, name) DO UPDATE SET is_default = excluded.is_default'
      );
      const findList = db.prepare('SELECT id FROM reading_lists WHERE user_id = ? AND name = ?').pluck();
      const insMember = db.prepare(
        'INSERT OR IGNORE INTO reading_list_manga (list_id, manga_id, added_at) VALUES (?, ?, ?)'
      );

      for (const l of payload.reading_lists) {
        if (!l?.name) continue;
        const oid = ownerId(l.username);
        insList.run(
          oid,
          l.name,
          l.is_default ? 1 : 0,
          Number.isFinite(l.created_at) ? l.created_at : Math.floor(Date.now() / 1000),
        );
        const listId = findList.get(oid, l.name);
        if (!listId) continue;
        counts.reading_lists++;

        if (Array.isArray(l.manga)) {
          for (const entry of l.manga) {
            const mangaId = mangaIdByPath.get(entry?.manga_path);
            if (!mangaId) {
              if (entry?.manga_path) warnings.push(`reading_list "${l.name}": no manga at path ${entry.manga_path}`);
              continue;
            }
            insMember.run(
              listId,
              mangaId,
              Number.isFinite(entry.added_at) ? entry.added_at : Math.floor(Date.now() / 1000),
            );
            counts.reading_list_manga++;
          }
        }
      }
    }

    // ── Progress ────────────────────────────────────────────────────────────
    if (Array.isArray(payload.progress)) {
      const upsert = db.prepare(`
        INSERT INTO progress
          (user_id, manga_id, current_chapter_id, current_page, completed_chapters, last_read_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, manga_id) DO UPDATE SET
          current_chapter_id = excluded.current_chapter_id,
          current_page       = excluded.current_page,
          completed_chapters = excluded.completed_chapters,
          last_read_at       = excluded.last_read_at,
          updated_at         = excluded.updated_at
      `);

      for (const p of payload.progress) {
        const mangaId = mangaIdByPath.get(p?.manga_path);
        if (!mangaId) {
          if (p?.manga_path) warnings.push(`progress: no manga at path ${p.manga_path}`);
          continue;
        }
        const currentChapterId = p.current_chapter_folder
          ? (chapterIdByKey.get(`${mangaId}:${p.current_chapter_folder}`) || null)
          : null;

        const completedIds = (Array.isArray(p.completed_chapter_folders) ? p.completed_chapter_folders : [])
          .map(f => chapterIdByKey.get(`${mangaId}:${f}`))
          .filter(Boolean);

        upsert.run(
          ownerId(p.username),
          mangaId,
          currentChapterId,
          Number.isFinite(p.current_page) ? p.current_page : 0,
          JSON.stringify(completedIds),
          Number.isFinite(p.last_read_at) ? p.last_read_at : Math.floor(Date.now() / 1000),
          Number.isFinite(p.updated_at)   ? p.updated_at   : Math.floor(Date.now() / 1000),
        );
        counts.progress++;
      }
    }

    // ── Reading history ─────────────────────────────────────────────────────
    if (Array.isArray(payload.reading_history)) {
      // Per-owner scoped reset so re-importing doesn't duplicate the timeline.
      const ownersInPayload = new Set(payload.reading_history.map(h => ownerId(h?.username)));
      const delHist = db.prepare('DELETE FROM reading_history WHERE user_id = ?');
      for (const oid of ownersInPayload) delHist.run(oid);

      const ins = db.prepare(
        'INSERT INTO reading_history (user_id, manga_id, chapter_id, event, read_at) VALUES (?, ?, ?, ?, ?)'
      );
      for (const h of payload.reading_history) {
        const mangaId = mangaIdByPath.get(h?.manga_path);
        if (!mangaId) continue;
        const chapterId = h.chapter_folder
          ? (chapterIdByKey.get(`${mangaId}:${h.chapter_folder}`) || null)
          : null;
        ins.run(
          ownerId(h.username),
          mangaId,
          chapterId,
          typeof h.event === 'string' ? h.event : 'read',
          Number.isFinite(h.read_at) ? h.read_at : Math.floor(Date.now() / 1000),
        );
        counts.reading_history++;
      }
    }

    // ── Art gallery ─────────────────────────────────────────────────────────
    if (Array.isArray(payload.art_gallery)) {
      // (chapter_id, page_index) → page_id
      const pageIdByKey = new Map();
      for (const pg of db.prepare('SELECT id, chapter_id, page_index FROM pages').all()) {
        pageIdByKey.set(`${pg.chapter_id}:${pg.page_index}`, pg.id);
      }

      db.prepare('DELETE FROM art_gallery').run();
      const ins = db.prepare(
        'INSERT OR IGNORE INTO art_gallery (manga_id, chapter_id, page_id, created_at) VALUES (?, ?, ?, ?)'
      );

      for (const g of payload.art_gallery) {
        const mangaId = mangaIdByPath.get(g?.manga_path);
        if (!mangaId) continue;
        const chapterId = chapterIdByKey.get(`${mangaId}:${g.chapter_folder}`);
        if (!chapterId) continue;
        const pageId = pageIdByKey.get(`${chapterId}:${g.page_index}`);
        if (!pageId) continue;
        ins.run(
          mangaId,
          chapterId,
          pageId,
          Number.isFinite(g.created_at) ? g.created_at : Math.floor(Date.now() / 1000),
        );
        counts.art_gallery++;
      }
    }
  });

  try {
    applyImport();
  } catch (importErr) {
    return res.status(400).json({ error: `Import failed: ${importErr.message}` });
  }

  // Settings and schedule changes need to take effect live. Re-reading the
  // cache limit and rescheduling the auto-clear timer keeps the in-memory
  // state consistent with the restored row in the settings table.
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'cbz_cache_limit_bytes'").pluck().get();
    const n = row ? parseInt(row, 10) : NaN;
    if (Number.isFinite(n) && n > 0) cbzCache.setLimitBytes(n);
    cbzCacheSchedule.reschedule();
  } catch { /* non-fatal — leave previous state in place */ }

  // Cap warnings so a huge import doesn't blow the response size.
  const MAX_WARNINGS = 50;
  const truncated = warnings.length > MAX_WARNINGS;
  const warningsOut = truncated ? warnings.slice(0, MAX_WARNINGS) : warnings;

  res.json({
    data: {
      counts,
      warnings: warningsOut,
      warnings_truncated: truncated,
      total_warnings:     warnings.length,
    },
  });
}));

module.exports = router;
