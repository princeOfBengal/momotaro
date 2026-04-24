const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const cbzCacheSchedule = require('../scanner/cbzCacheSchedule');
const cbzCache = require('../scanner/cbzCache');

const router = express.Router();

// Current export-file schema version. Bumped when the structure changes in a
// non-backwards-compatible way; the importer accepts the current version and
// any older versions it knows how to upgrade.
const CONFIG_VERSION = 1;

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Export ───────────────────────────────────────────────────────────────────

// Manga rows are keyed by `path` (UNIQUE column) so the export survives a
// fresh DB where auto-increment IDs differ. Reading-list memberships,
// progress, and the art gallery use the same path-based linkage; chapters
// within a manga are identified by their `folder_name`, which is also stable
// across scans.

router.get('/admin/export-config', asyncWrapper(async (req, res) => {
  const db = getDb();

  const settings = Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])
  );

  const deviceSessions = db.prepare(`
    SELECT device_id, anilist_token, anilist_user_id, anilist_username,
           anilist_avatar, updated_at
    FROM device_anilist_sessions
  `).all();

  const libraries = db.prepare(`
    SELECT name, path, show_in_all FROM libraries
  `).all();

  const mangaRows = db.prepare(`
    SELECT id, path, title, description, status, year, genres,
           anilist_id, mal_id, doujinshi_id, score, author,
           metadata_source, track_volumes,
           cover_image, anilist_cover, original_cover, mal_cover
    FROM manga
  `).all();

  // Build id → path map for foreign-key translation below.
  const mangaIdToPath = new Map(mangaRows.map(m => [m.id, m.path]));

  const mangaMetadata = mangaRows.map(m => ({
    path:            m.path,
    title:           m.title,
    description:     m.description,
    status:          m.status,
    year:            m.year,
    genres:          safeJsonParse(m.genres, []),
    anilist_id:      m.anilist_id,
    mal_id:          m.mal_id,
    doujinshi_id:    m.doujinshi_id,
    score:           m.score,
    author:          m.author,
    metadata_source: m.metadata_source,
    track_volumes:   m.track_volumes,
    cover_image:     m.cover_image,
    anilist_cover:   m.anilist_cover,
    original_cover:  m.original_cover,
    mal_cover:       m.mal_cover,
  }));

  // Reading lists + memberships, exported by path.
  const listRows = db.prepare('SELECT id, name, is_default, created_at FROM reading_lists').all();
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
    name:       l.name,
    is_default: l.is_default,
    created_at: l.created_at,
    manga:      membershipsByList.get(l.id) || [],
  }));

  // Progress. current_chapter_id + completed_chapters are translated into
  // chapter folder_names so the import can re-resolve them against whatever
  // chapter IDs the target DB has.
  const progressRows = db.prepare(`
    SELECT manga_id, current_chapter_id, current_page, completed_chapters,
           last_read_at, updated_at
    FROM progress
  `).all();

  // Pre-fetch chapter id → folder_name for every referenced chapter.
  const chapterFolderByChapterId = new Map();
  {
    const allChapters = db.prepare('SELECT id, manga_id, folder_name FROM chapters').all();
    for (const c of allChapters) chapterFolderByChapterId.set(c.id, c.folder_name);
  }

  const progress = progressRows.map(p => {
    const completedIds = safeJsonParse(p.completed_chapters, []);
    const completedFolders = completedIds
      .map(id => chapterFolderByChapterId.get(id))
      .filter(Boolean);
    return {
      manga_path:                mangaIdToPath.get(p.manga_id) || null,
      current_chapter_folder:    p.current_chapter_id
                                   ? (chapterFolderByChapterId.get(p.current_chapter_id) || null)
                                   : null,
      current_page:              p.current_page,
      completed_chapter_folders: completedFolders,
      last_read_at:              p.last_read_at,
      updated_at:                p.updated_at,
    };
  }).filter(p => p.manga_path);

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
    version:                 CONFIG_VERSION,
    app:                     'momotaro',
    exported_at:             new Date().toISOString(),
    settings,
    device_anilist_sessions: deviceSessions,
    libraries,
    manga_metadata:          mangaMetadata,
    reading_lists:           readingLists,
    progress,
    art_gallery:             artGallery,
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
    settings: 0, device_sessions: 0, libraries: 0, manga_metadata: 0,
    reading_lists: 0, reading_list_manga: 0, progress: 0, art_gallery: 0,
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

    // ── Device AniList sessions ─────────────────────────────────────────────
    if (Array.isArray(payload.device_anilist_sessions)) {
      db.prepare('DELETE FROM device_anilist_sessions').run();
      const ins = db.prepare(`
        INSERT INTO device_anilist_sessions
          (device_id, anilist_token, anilist_user_id, anilist_username, anilist_avatar, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const s of payload.device_anilist_sessions) {
        if (!s?.device_id) continue;
        ins.run(
          s.device_id,
          s.anilist_token    || '',
          s.anilist_user_id  || '',
          s.anilist_username || '',
          s.anilist_avatar   || '',
          Number.isFinite(s.updated_at) ? s.updated_at : Math.floor(Date.now() / 1000),
        );
        counts.device_sessions++;
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

    // ── Manga metadata ─────────────────────────────────────────────────────
    if (Array.isArray(payload.manga_metadata)) {
      const upd = db.prepare(`
        UPDATE manga SET
          title           = COALESCE(?, title),
          description     = ?,
          status          = ?,
          year            = ?,
          genres          = ?,
          anilist_id      = ?,
          mal_id          = ?,
          doujinshi_id    = ?,
          score           = ?,
          author          = ?,
          metadata_source = COALESCE(?, metadata_source),
          track_volumes   = COALESCE(?, track_volumes),
          cover_image     = COALESCE(?, cover_image),
          anilist_cover   = ?,
          original_cover  = ?,
          mal_cover       = ?,
          updated_at      = unixepoch()
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
          Number.isFinite(m.anilist_id)   ? m.anilist_id   : null,
          Number.isFinite(m.mal_id)       ? m.mal_id       : null,
          m.doujinshi_id ?? null,
          Number.isFinite(m.score) ? m.score : null,
          m.author ?? null,
          m.metadata_source ?? null,
          Number.isFinite(m.track_volumes) ? m.track_volumes : null,
          m.cover_image ?? null,
          m.anilist_cover ?? null,
          m.original_cover ?? null,
          m.mal_cover ?? null,
          id,
        );
        counts.manga_metadata++;
      }
    }

    // ── Reading lists + memberships ─────────────────────────────────────────
    if (Array.isArray(payload.reading_lists)) {
      // Wipe non-default lists; for default lists we keep the row (the
      // migration seeds them) and reset the memberships.
      db.prepare('DELETE FROM reading_list_manga').run();
      db.prepare('DELETE FROM reading_lists WHERE is_default = 0').run();

      const insList = db.prepare(
        'INSERT INTO reading_lists (name, is_default, created_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET is_default = excluded.is_default'
      );
      const findList = db.prepare('SELECT id FROM reading_lists WHERE name = ?').pluck();
      const insMember = db.prepare(
        'INSERT OR IGNORE INTO reading_list_manga (list_id, manga_id, added_at) VALUES (?, ?, ?)'
      );

      for (const l of payload.reading_lists) {
        if (!l?.name) continue;
        insList.run(
          l.name,
          l.is_default ? 1 : 0,
          Number.isFinite(l.created_at) ? l.created_at : Math.floor(Date.now() / 1000),
        );
        const listId = findList.get(l.name);
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
      // Pre-build (manga_id, folder_name) → chapter_id map for remapping.
      const chapterIdByKey = new Map();
      for (const c of db.prepare('SELECT id, manga_id, folder_name FROM chapters').all()) {
        chapterIdByKey.set(`${c.manga_id}:${c.folder_name}`, c.id);
      }

      const upsert = db.prepare(`
        INSERT INTO progress
          (manga_id, current_chapter_id, current_page, completed_chapters, last_read_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(manga_id) DO UPDATE SET
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

    // ── Art gallery ─────────────────────────────────────────────────────────
    if (Array.isArray(payload.art_gallery)) {
      // (manga_id, chapter_folder) → chapter_id
      const chapterIdByKey = new Map();
      for (const c of db.prepare('SELECT id, manga_id, folder_name FROM chapters').all()) {
        chapterIdByKey.set(`${c.manga_id}:${c.folder_name}`, c.id);
      }
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
