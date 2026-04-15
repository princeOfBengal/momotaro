const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { fetchFromAniList, searchAniList, fetchByAniListId, getMediaListEntry, saveMediaListEntry } = require('../metadata/anilist');
const { searchDoujinshi, fetchFromDoujinshi, fetchByDoujinshiSlug } = require('../metadata/doujinshi');
const { getSetting, getDeviceSession } = require('./settings');
const config = require('../config');

const router = express.Router();

function getToken(db) {
  return getSetting(db, 'anilist_token');
}

function getDoujinshiToken(db) {
  return getSetting(db, 'doujinshi_token');
}

function applyMetadataToDb(db, mangaId, result) {
  db.prepare(`
    UPDATE manga SET
      title           = ?,
      description     = ?,
      status          = ?,
      year            = ?,
      genres          = ?,
      score           = ?,
      anilist_id      = ?,
      mal_id          = ?,
      doujinshi_id    = ?,
      author          = ?,
      metadata_source = ?,
      updated_at      = unixepoch()
    WHERE id = ?
  `).run(
    result.title,
    result.description,
    result.status,
    result.year,
    JSON.stringify(result.genres),
    result.score,
    result.anilist_id   ?? null,
    result.mal_id       ?? null,
    result.doujinshi_id ?? null,
    result.author       ?? null,
    result.source,
    mangaId
  );
}

/**
 * Download the AniList cover image, resize to thumbnail dimensions, and save
 * it to the thumbnails directory. Updates cover_image in the DB.
 * Runs best-effort — never throws so metadata apply never fails due to a bad image.
 */
async function fetchAndStoreCover(db, mangaId, coverUrl) {
  if (!coverUrl) return;
  try {
    const resp = await fetch(coverUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buffer = await resp.buffer();

    fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });
    const outputPath = path.join(config.THUMBNAIL_DIR, `${mangaId}.webp`);

    await sharp(buffer)
      .resize(300, 430, { fit: 'cover', position: 'top' })
      .webp({ quality: 85 })
      .toFile(outputPath);

    db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
      .run(`${mangaId}.webp`, mangaId);

    console.log(`[Metadata] Cover saved for manga ${mangaId}`);
  } catch (err) {
    console.warn(`[Metadata] Could not fetch cover for manga ${mangaId}: ${err.message}`);
  }
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// POST /api/manga/:id/refresh-metadata — auto-fetch by title
router.post('/manga/:id/refresh-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const token = getToken(db);
  const cleanTitle = manga.title.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const result = await fetchFromAniList(cleanTitle, token);

  if (!result) {
    return res.json({ found: false, message: 'No match found on AniList for this title.' });
  }

  applyMetadataToDb(db, manga.id, result);
  await fetchAndStoreCover(db, manga.id, result.cover_url);

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({
    found: true,
    data: { ...updated, genres: safeJsonParse(updated.genres, []) },
  });
}));

// GET /api/anilist/search?q=...&page=1 — manual search returning up to 10 results
router.get('/anilist/search', asyncWrapper(async (req, res) => {
  const { q, page = '1' } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'q parameter is required' });

  const db = getDb();
  const token = getToken(db);
  const results = await searchAniList(q.trim(), token, parseInt(page, 10));

  res.json({ data: results });
}));

// POST /api/manga/:id/apply-metadata — apply a specific AniList entry by ID
router.post('/manga/:id/apply-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { anilist_id } = req.body;
  if (!anilist_id) return res.status(400).json({ error: 'anilist_id is required' });

  const token = getToken(db);
  const result = await fetchByAniListId(Number(anilist_id), token);

  if (!result) return res.status(404).json({ error: 'Entry not found on AniList' });

  applyMetadataToDb(db, manga.id, result);
  await fetchAndStoreCover(db, manga.id, result.cover_url);

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({
    data: { ...updated, genres: safeJsonParse(updated.genres, []) },
  });
}));

// PATCH /api/manga/:id/anilist-progress — update chapters/volumes/status on AniList
router.patch('/manga/:id/anilist-progress', asyncWrapper(async (req, res) => {
  const db = getDb();

  const deviceId = req.headers['x-device-id'] || null;
  const session  = getDeviceSession(db, deviceId);
  const token    = session?.anilist_token   || null;
  const userId   = session?.anilist_user_id || null;
  if (!token || !userId) return res.status(401).json({ error: 'Not logged in to AniList' });

  const manga = db.prepare('SELECT anilist_id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga)            return res.status(404).json({ error: 'Manga not found' });
  if (!manga.anilist_id) return res.status(400).json({ error: 'Manga has no AniList link' });

  const { chapters, volumes, status, score } = req.body;

  // Build only the fields the caller provided
  const progressArg = {};
  if (chapters !== undefined && chapters !== null) progressArg.chapters = Math.max(0, parseInt(chapters, 10));
  if (volumes  !== undefined && volumes  !== null) progressArg.volumes  = Math.max(0, parseInt(volumes,  10));
  if (score    !== undefined && score    !== null) progressArg.score    = Math.min(10, Math.max(0, parseFloat(score)));

  // Fetch current entry to preserve existing status when only progress changes
  const existing = await getMediaListEntry(token, userId, manga.anilist_id).catch(() => null);
  const resolvedStatus = status || existing?.status || 'CURRENT';

  await saveMediaListEntry(token, manga.anilist_id, resolvedStatus, progressArg);

  // Re-fetch fresh entry to return to client
  const updated = await getMediaListEntry(token, userId, manga.anilist_id).catch(() => null);
  res.json({ data: { entry: updated } });
}));

// GET /api/doujinshi/search?q=...&page=1 — manual search returning up to 10 results
router.get('/doujinshi/search', asyncWrapper(async (req, res) => {
  const { q, page = '1' } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'q parameter is required' });

  const db = getDb();
  const token = getDoujinshiToken(db);
  const results = await searchDoujinshi(q.trim(), token, parseInt(page, 10));

  res.json({ data: results });
}));

// POST /api/manga/:id/apply-doujinshi-metadata — apply a specific doujinshi entry by slug
router.post('/manga/:id/apply-doujinshi-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const token = getDoujinshiToken(db);
  const result = await fetchByDoujinshiSlug(slug, token);

  if (!result) return res.status(404).json({ error: 'Entry not found on Doujinshi.info' });

  applyMetadataToDb(db, manga.id, result);
  await fetchAndStoreCover(db, manga.id, result.cover_url);

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({
    data: { ...updated, genres: safeJsonParse(updated.genres, []) },
  });
}));

// POST /api/manga/:id/refresh-doujinshi-metadata — auto-fetch by title from Doujinshi.info
router.post('/manga/:id/refresh-doujinshi-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const token = getDoujinshiToken(db);
  const cleanTitle = manga.title.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const result = await fetchFromDoujinshi(cleanTitle, token);

  if (!result) {
    return res.json({ found: false, message: 'No match found on Doujinshi.info for this title.' });
  }

  applyMetadataToDb(db, manga.id, result);
  await fetchAndStoreCover(db, manga.id, result.cover_url);

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({
    found: true,
    data: { ...updated, genres: safeJsonParse(updated.genres, []) },
  });
}));

// POST /api/libraries/:id/bulk-metadata — auto-fetch metadata for every manga in a library
// Body: { source: 'anilist' | 'doujinshi' }  (defaults to 'anilist')
// Only processes manga with metadata_source = 'none' — any existing metadata (local JSON,
// AniList, or Doujinshi.info) is always preserved.
router.post('/libraries/:id/bulk-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const source = (req.body?.source === 'doujinshi') ? 'doujinshi' : 'anilist';

  // Only fetch manga that have no metadata yet — skip anything already sourced
  const totalCount = db.prepare('SELECT COUNT(*) AS n FROM manga WHERE library_id = ?').get(library.id).n;
  const mangaList  = db.prepare(
    "SELECT id, title FROM manga WHERE library_id = ? AND metadata_source = 'none'"
  ).all(library.id);
  const skippedExisting = totalCount - mangaList.length;

  // Respond immediately — the pull runs in the background
  res.json({
    message:          'Bulk metadata pull started',
    total:            totalCount,
    to_fetch:         mangaList.length,
    skipped_existing: skippedExisting,
    source,
  });

  if (mangaList.length === 0) {
    console.log(
      `[BulkMetadata][${source}] Nothing to do for "${library.name}" — ` +
      `all ${totalCount} titles already have metadata.`
    );
    return;
  }

  console.log(
    `[BulkMetadata][${source}] Starting for "${library.name}": ` +
    `${mangaList.length} to fetch, ${skippedExisting} skipped (already have metadata).`
  );

  const anilistToken   = getToken(db);
  const doujinshiToken = getDoujinshiToken(db);

  let applied = 0;
  let noMatch = 0;
  let errors  = 0;

  for (const manga of mangaList) {
    try {
      let result = null;
      if (source === 'doujinshi') {
        result = await fetchFromDoujinshi(manga.title, doujinshiToken);
        // fetchFromDoujinshi makes two HTTP requests (search + fetch by slug);
        // use a longer delay to keep total request rate reasonable.
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        result = await fetchFromAniList(manga.title, anilistToken);
        // Stay well within AniList's ~90 req/min rate limit
        await new Promise(resolve => setTimeout(resolve, 700));
      }

      if (result) {
        applyMetadataToDb(db, manga.id, result);
        await fetchAndStoreCover(db, manga.id, result.cover_url);
        applied++;
        console.log(
          `[BulkMetadata][${source}] (${applied + noMatch + errors}/${mangaList.length}) ` +
          `Applied: "${manga.title}" → "${result.title}"`
        );
      } else {
        noMatch++;
        console.log(
          `[BulkMetadata][${source}] (${applied + noMatch + errors}/${mangaList.length}) ` +
          `No match: "${manga.title}"`
        );
      }
    } catch (err) {
      errors++;
      console.warn(
        `[BulkMetadata][${source}] (${applied + noMatch + errors}/${mangaList.length}) ` +
        `Error for "${manga.title}": ${err.message}`
      );
      // Still delay after errors to avoid hammering the API on repeated failures
      await new Promise(resolve => setTimeout(resolve, source === 'doujinshi' ? 500 : 700));
    }
  }

  console.log(
    `[BulkMetadata][${source}] Finished for "${library.name}": ` +
    `${applied} applied, ${noMatch} no match, ${errors} errors ` +
    `(${skippedExisting} titles skipped — already had metadata).`
  );
}));

// GET /api/manga/:id/anilist-status — fetch the logged-in user's list entry for this manga
router.get('/manga/:id/anilist-status', asyncWrapper(async (req, res) => {
  const db = getDb();

  const deviceId = req.headers['x-device-id'] || null;
  const session  = getDeviceSession(db, deviceId);
  const token    = session?.anilist_token   || null;
  const userId   = session?.anilist_user_id || null;

  if (!token || !userId) {
    return res.json({ data: { logged_in: false } });
  }

  const manga = db.prepare('SELECT anilist_id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  if (!manga.anilist_id) {
    return res.json({ data: { logged_in: true, linked: false } });
  }

  const entry = await getMediaListEntry(token, userId, manga.anilist_id).catch(() => null);

  res.json({
    data: {
      logged_in:   true,
      linked:      true,
      anilist_id:  manga.anilist_id,
      entry,          // null = not on user's list yet
    },
  });
}));

module.exports = router;
