const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { fetchFromAniList, fetchBatchFromAniList, searchAniList, fetchByAniListId, getMediaListEntry, saveMediaListEntry } = require('../metadata/anilist');
const { searchDoujinshi, fetchFromDoujinshi, fetchByDoujinshiSlug } = require('../metadata/doujinshi');
const { fetchFromMAL, searchMAL, fetchByMALId } = require('../metadata/myanimelist');
const { getSetting, getDeviceSession } = require('./settings');
const { thumbnailPath, ensureShardDir } = require('../scanner/thumbnailPaths');
const config = require('../config');

const router = express.Router();

function getToken(db) {
  return getSetting(db, 'anilist_token');
}

function getDoujinshiToken(db) {
  return getSetting(db, 'doujinshi_token');
}

function getMalClientId(db) {
  return getSetting(db, 'mal_client_id');
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

// Only stores the external linkage IDs (anilist_id, mal_id, doujinshi_id) without
// overwriting any existing metadata fields or changing metadata_source.
// Used when local metadata is present and should remain the display source.
function applyLinkageOnlyToDb(db, mangaId, result) {
  db.prepare(`
    UPDATE manga SET
      anilist_id   = COALESCE(?, anilist_id),
      mal_id       = COALESCE(?, mal_id),
      doujinshi_id = COALESCE(?, doujinshi_id),
      updated_at   = unixepoch()
    WHERE id = ?
  `).run(
    result.anilist_id   ?? null,
    result.mal_id       ?? null,
    result.doujinshi_id ?? null,
    mangaId
  );
}

/**
 * Download a source cover image, resize to thumbnail dimensions, and save
 * it to the thumbnails directory. Updates cover_image and the source-specific
 * cover column in the DB.
 *
 * source: 'anilist' | 'myanimelist'
 * Runs best-effort — never throws so metadata apply never fails due to a bad image.
 */
// setActive: when false, saves the source-specific cover file but does not replace the
// active thumbnail. Used for local-metadata manga so their existing cover is preserved.
async function fetchAndStoreCover(db, mangaId, coverUrl, source = 'anilist', { setActive = true } = {}) {
  if (!coverUrl) return;
  try {
    const resp = await fetch(coverUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buffer = await resp.buffer();

    // Source-specific filename and DB column
    const SOURCE_META = {
      anilist:     { suffix: 'anilist', dbField: 'anilist_cover' },
      myanimelist: { suffix: 'mal',     dbField: 'mal_cover'     },
    };
    const meta      = SOURCE_META[source] || null;
    const savedName = meta ? `${mangaId}_${meta.suffix}.webp` : `${mangaId}_cover.webp`;
    ensureShardDir(savedName);
    const savedPath = thumbnailPath(savedName);

    await sharp(buffer)
      .resize(300, 430, { fit: 'cover', position: 'top' })
      .webp({ quality: 85 })
      .toFile(savedPath);

    if (setActive) {
      const activeName = `${mangaId}.webp`;
      ensureShardDir(activeName);
      fs.copyFileSync(savedPath, thumbnailPath(activeName));
    }

    if (meta) {
      if (setActive) {
        db.prepare(`UPDATE manga SET cover_image = ?, ${meta.dbField} = ? WHERE id = ?`)
          .run(`${mangaId}.webp`, savedName, mangaId);
      } else {
        db.prepare(`UPDATE manga SET ${meta.dbField} = ? WHERE id = ?`)
          .run(savedName, mangaId);
      }
    } else if (setActive) {
      db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
        .run(`${mangaId}.webp`, mangaId);
    }

    console.log(`[Metadata] Cover saved for manga ${mangaId} (${source})`);
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
  await fetchAndStoreCover(db, manga.id, result.cover_url, 'anilist');

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
  await fetchAndStoreCover(db, manga.id, result.cover_url, 'anilist');

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
  await fetchAndStoreCover(db, manga.id, result.cover_url, 'doujinshi');

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
  await fetchAndStoreCover(db, manga.id, result.cover_url, 'doujinshi');

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({
    found: true,
    data: { ...updated, genres: safeJsonParse(updated.genres, []) },
  });
}));

// GET /api/mal/search?q=...&page=1 — manual MAL search returning up to 10 results
router.get('/mal/search', asyncWrapper(async (req, res) => {
  const { q, page = '1' } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'q parameter is required' });

  const db = getDb();
  const clientId = getMalClientId(db);
  if (!clientId) return res.status(400).json({ error: 'MyAnimeList Client ID is not configured in Settings.' });

  const results = await searchMAL(q.trim(), clientId, parseInt(page, 10));
  res.json({ data: results });
}));

// POST /api/manga/:id/apply-mal-metadata — apply a specific MAL entry by ID
router.post('/manga/:id/apply-mal-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { mal_id } = req.body;
  if (!mal_id) return res.status(400).json({ error: 'mal_id is required' });

  const clientId = getMalClientId(db);
  if (!clientId) return res.status(400).json({ error: 'MyAnimeList Client ID is not configured in Settings.' });

  const result = await fetchByMALId(Number(mal_id), clientId);
  if (!result) return res.status(404).json({ error: 'Entry not found on MyAnimeList' });

  applyMetadataToDb(db, manga.id, result);
  await fetchAndStoreCover(db, manga.id, result.cover_url, 'myanimelist');

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({ data: { ...updated, genres: safeJsonParse(updated.genres, []) } });
}));

// POST /api/manga/:id/refresh-mal-metadata — auto-fetch from MAL by title
router.post('/manga/:id/refresh-mal-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const clientId = getMalClientId(db);
  if (!clientId) return res.status(400).json({ error: 'MyAnimeList Client ID is not configured in Settings.' });

  const cleanTitle = manga.title.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const result = await fetchFromMAL(cleanTitle, clientId);

  if (!result) {
    return res.json({ found: false, message: 'No match found on MyAnimeList for this title.' });
  }

  applyMetadataToDb(db, manga.id, result);
  await fetchAndStoreCover(db, manga.id, result.cover_url, 'myanimelist');

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({
    found: true,
    data: { ...updated, genres: safeJsonParse(updated.genres, []) },
  });
}));

// Skip re-fetching titles that were attempted within this window unless `force: true`.
const BULK_RETRY_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;  // 7 days
const ANILIST_BATCH_SIZE = 5;

const markAttemptedStmt = (db) =>
  db.prepare('UPDATE manga SET last_metadata_fetch_attempt_at = ? WHERE id = ?');

function markAttempted(db, mangaIds, nowSeconds) {
  const stmt = markAttemptedStmt(db);
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(nowSeconds, id);
  });
  tx(mangaIds);
}

// POST /api/libraries/:id/bulk-metadata — auto-fetch metadata for every manga in a library
// Body: { source: 'anilist' | 'myanimelist' | 'doujinshi', force?: boolean }
//       source defaults to 'anilist'. force=true ignores the 7-day retry cooldown.
//
// Behavior by existing metadata_source:
//   'none'           — full fetch: all metadata fields + linkage IDs applied
//   'local'          — link-only: only the external ID (anilist_id / mal_id / doujinshi_id)
//                      is stored; existing local fields and cover are preserved; skipped if
//                      the relevant ID is already set
//   'anilist' / etc. — skipped entirely (third-party metadata already present)
//
// Cooldown: a title whose last fetch attempt (for any source) is within
// BULK_RETRY_COOLDOWN_SECONDS is skipped unless force=true, so no-match titles
// don't get re-queried on every bulk pull.
router.post('/libraries/:id/bulk-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const VALID_SOURCES = new Set(['anilist', 'myanimelist', 'doujinshi']);
  const source = VALID_SOURCES.has(req.body?.source) ? req.body.source : 'anilist';
  const force  = req.body?.force === true;

  const allManga = db.prepare(
    `SELECT id, title, metadata_source, anilist_id, mal_id, doujinshi_id,
            last_metadata_fetch_attempt_at
     FROM manga WHERE library_id = ?`
  ).all(library.id);
  const totalCount = allManga.length;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Classify each manga into what we should do with it
  const toProcess = [];
  let skippedExisting       = 0; // already has third-party metadata — skip entirely
  let skippedAlreadyLinked  = 0; // has local metadata + already linked for this source
  let skippedRecentAttempt  = 0; // recently attempted with no result — honour cooldown

  for (const m of allManga) {
    if (m.metadata_source !== 'none' && m.metadata_source !== 'local') {
      skippedExisting++;
      continue;
    }
    if (m.metadata_source === 'local') {
      const alreadyLinked =
        (source === 'anilist'     && m.anilist_id)    ||
        (source === 'myanimelist' && m.mal_id)        ||
        (source === 'doujinshi'   && m.doujinshi_id);
      if (alreadyLinked) {
        skippedAlreadyLinked++;
        continue;
      }
    }
    if (!force
        && m.last_metadata_fetch_attempt_at
        && (nowSeconds - m.last_metadata_fetch_attempt_at) < BULK_RETRY_COOLDOWN_SECONDS) {
      skippedRecentAttempt++;
      continue;
    }
    toProcess.push(m);
  }

  // Respond immediately — the pull runs in the background
  res.json({
    message:                  'Bulk metadata pull started',
    total:                    totalCount,
    to_fetch:                 toProcess.length,
    skipped_existing:         skippedExisting,
    skipped_already_linked:   skippedAlreadyLinked,
    skipped_recent_attempt:   skippedRecentAttempt,
    source,
  });

  if (toProcess.length === 0) {
    console.log(
      `[BulkMetadata][${source}] Nothing to do for "${library.name}" — ` +
      `all ${totalCount} titles covered ` +
      `(${skippedExisting} have third-party metadata, ${skippedAlreadyLinked} local already linked, ` +
      `${skippedRecentAttempt} recently attempted).`
    );
    return;
  }

  console.log(
    `[BulkMetadata][${source}] Starting for "${library.name}": ` +
    `${toProcess.length} to fetch ` +
    `(${skippedExisting} skipped — third-party metadata, ${skippedAlreadyLinked} skipped — local already linked, ` +
    `${skippedRecentAttempt} skipped — recently attempted).`
  );

  const anilistToken   = getToken(db);
  const doujinshiToken = getDoujinshiToken(db);
  const malClientId    = getMalClientId(db);

  const counters = { applied: 0, linked: 0, noMatch: 0, errors: 0 };
  const total = toProcess.length;

  async function applyOne(manga, result) {
    const n = counters.applied + counters.linked + counters.noMatch + counters.errors + 1;
    if (!result) {
      counters.noMatch++;
      console.log(`[BulkMetadata][${source}] (${n}/${total}) No match: "${manga.title}"`);
      return;
    }
    if (manga.metadata_source === 'local') {
      applyLinkageOnlyToDb(db, manga.id, result);
      await fetchAndStoreCover(db, manga.id, result.cover_url, source, { setActive: false });
      counters.linked++;
      console.log(
        `[BulkMetadata][${source}] (${n}/${total}) Linked (local preserved): ` +
        `"${manga.title}" → "${result.title}"`
      );
    } else {
      applyMetadataToDb(db, manga.id, result);
      await fetchAndStoreCover(db, manga.id, result.cover_url, source);
      counters.applied++;
      console.log(
        `[BulkMetadata][${source}] (${n}/${total}) Applied: "${manga.title}" → "${result.title}"`
      );
    }
  }

  if (source === 'anilist') {
    // Batch: one GraphQL request per ANILIST_BATCH_SIZE titles
    for (let i = 0; i < toProcess.length; i += ANILIST_BATCH_SIZE) {
      const batch = toProcess.slice(i, i + ANILIST_BATCH_SIZE);
      try {
        const results = await fetchBatchFromAniList(batch.map(m => m.title), anilistToken);
        for (let j = 0; j < batch.length; j++) {
          await applyOne(batch[j], results[j]);
        }
      } catch (err) {
        for (const manga of batch) {
          counters.errors++;
          const n = counters.applied + counters.linked + counters.noMatch + counters.errors;
          console.warn(
            `[BulkMetadata][anilist] (${n}/${total}) Batch error for "${manga.title}": ${err.message}`
          );
        }
      }
      // Always mark batch members attempted — even on a whole-batch failure
      // the cooldown still applies, since retrying immediately won't help.
      markAttempted(db, batch.map(m => m.id), nowSeconds);
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  } else {
    // Non-AniList sources have no GraphQL alias trick — process sequentially
    const perRequestDelay = source === 'doujinshi' ? 500 : 700;
    for (const manga of toProcess) {
      try {
        const result = source === 'doujinshi'
          ? await fetchFromDoujinshi(manga.title, doujinshiToken)
          : await fetchFromMAL(manga.title, malClientId);
        await applyOne(manga, result);
      } catch (err) {
        counters.errors++;
        const n = counters.applied + counters.linked + counters.noMatch + counters.errors;
        console.warn(
          `[BulkMetadata][${source}] (${n}/${total}) Error for "${manga.title}": ${err.message}`
        );
      }
      markAttempted(db, [manga.id], nowSeconds);
      await new Promise(resolve => setTimeout(resolve, perRequestDelay));
    }
  }

  console.log(
    `[BulkMetadata][${source}] Finished for "${library.name}": ` +
    `${counters.applied} applied, ${counters.linked} linked (local preserved), ` +
    `${counters.noMatch} no match, ${counters.errors} errors ` +
    `(${skippedExisting} skipped — third-party metadata, ${skippedAlreadyLinked} skipped — local already linked, ` +
    `${skippedRecentAttempt} skipped — recently attempted).`
  );
}));

// POST /api/libraries/:id/export-metadata — write metadata.json to each manga folder that has
// third-party metadata (metadata_source != 'none').  Responds synchronously with counts.
router.post('/libraries/:id/export-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const totalCount = db.prepare('SELECT COUNT(*) AS n FROM manga WHERE library_id = ?').get(library.id).n;
  const mangaList  = db.prepare(
    "SELECT * FROM manga WHERE library_id = ? AND metadata_source != 'none'"
  ).all(library.id);

  let exported = 0;
  let writeErrors = 0;

  for (const manga of mangaList) {
    try {
      const genres = safeJsonParse(manga.genres, []);
      const payload = {
        title:           manga.title,
        ...(manga.author      ? { author:      manga.author }      : {}),
        ...(manga.description ? { description: manga.description } : {}),
        ...(genres.length     ? { genres }                         : {}),
        ...(manga.year        ? { year:        manga.year }        : {}),
        ...(manga.score       ? { score:       manga.score }       : {}),
        ...(manga.status      ? { status:      manga.status }      : {}),
        ...(manga.anilist_id  ? { anilist_id:  manga.anilist_id }  : {}),
        ...(manga.mal_id      ? { mal_id:      manga.mal_id }      : {}),
        ...(manga.doujinshi_id ? { doujinshi_id: manga.doujinshi_id } : {}),
        metadata_source: manga.metadata_source,
        exported_at:     new Date().toISOString(),
      };
      const outPath = path.join(manga.path, 'metadata.json');
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
      exported++;
    } catch (err) {
      writeErrors++;
      console.warn(`[ExportMetadata] Failed for "${manga.title}": ${err.message}`);
    }
  }

  const skipped = totalCount - mangaList.length;
  console.log(
    `[ExportMetadata] "${library.name}": exported ${exported}, ` +
    `skipped ${skipped} (no metadata), ${writeErrors} write errors.`
  );

  res.json({
    data: { total: totalCount, exported, skipped, errors: writeErrors },
  });
}));

// POST /api/manga/:id/export-metadata — write metadata.json to this manga's folder on disk
router.post('/manga/:id/export-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });
  if (!manga.metadata_source || manga.metadata_source === 'none') {
    return res.status(400).json({ error: 'This manga has no linked metadata to export.' });
  }

  const genres = safeJsonParse(manga.genres, []);
  const payload = {
    title:           manga.title,
    ...(manga.author       ? { author:       manga.author }       : {}),
    ...(manga.description  ? { description:  manga.description }  : {}),
    ...(genres.length      ? { genres }                           : {}),
    ...(manga.year         ? { year:         manga.year }         : {}),
    ...(manga.score        ? { score:        manga.score }        : {}),
    ...(manga.status       ? { status:       manga.status }       : {}),
    ...(manga.anilist_id   ? { anilist_id:   manga.anilist_id }   : {}),
    ...(manga.mal_id       ? { mal_id:       manga.mal_id }       : {}),
    ...(manga.doujinshi_id ? { doujinshi_id: manga.doujinshi_id } : {}),
    metadata_source: manga.metadata_source,
    exported_at:     new Date().toISOString(),
  };

  const outPath = path.join(manga.path, 'metadata.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`[ExportMetadata] Wrote metadata.json for "${manga.title}" (${manga.metadata_source})`);
  res.json({ data: { path: outPath } });
}));

// POST /api/manga/:id/reset-metadata — break external linkage and clear all sourced metadata fields
router.post('/manga/:id/reset-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  db.prepare(`
    UPDATE manga SET
      anilist_id                     = NULL,
      mal_id                         = NULL,
      doujinshi_id                   = NULL,
      metadata_source                = 'none',
      description                    = NULL,
      status                         = NULL,
      year                           = NULL,
      genres                         = NULL,
      score                          = NULL,
      author                         = NULL,
      last_metadata_fetch_attempt_at = NULL,
      updated_at                     = unixepoch()
    WHERE id = ?
  `).run(manga.id);

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({ data: { ...updated, genres: safeJsonParse(updated.genres, []) } });
}));

// GET /api/manga/:id/thumbnail-options — list all available thumbnail choices
router.get('/manga/:id/thumbnail-options', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id, anilist_cover, original_cover, cover_image FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  // Previously-used page thumbnails (most recent first, cap at 20)
  const history = db.prepare(
    'SELECT id, filename, created_at FROM thumbnail_history WHERE manga_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(manga.id);

  // First page of every chapter, ordered chapter-number ascending
  const chapterPages = db.prepare(`
    SELECT c.id AS chapter_id, c.number, c.volume, c.folder_name,
           p.id AS page_id
    FROM chapters c
    LEFT JOIN pages p ON p.chapter_id = c.id AND p.page_index = 0
    WHERE c.manga_id = ?
    ORDER BY COALESCE(c.number, c.volume) ASC NULLS LAST, c.folder_name ASC
  `).all(manga.id);

  res.json({
    data: {
      active_cover:        manga.cover_image,
      anilist_cover:       manga.anilist_cover  || null,
      original_cover:      manga.original_cover || null,
      history,
      chapter_first_pages: chapterPages
        .filter(ch => ch.page_id !== null)
        .map(ch => ({
          chapter_id: ch.chapter_id,
          page_id:    ch.page_id,
          label: ch.volume !== null && ch.number !== null
            ? `Vol.${ch.volume} Ch.${ch.number}`
            : ch.volume !== null
              ? `Vol.${ch.volume}`
              : ch.number !== null
                ? `Ch.${ch.number}`
                : ch.folder_name,
        })),
    },
  });
}));

// POST /api/manga/:id/set-thumbnail — set thumbnail from a page or an existing saved file
//   { page_id: N }            generate from a reader page (saved to history)
//   { saved_filename: "..." } apply an existing thumbnail file (anilist, original, or history)
router.post('/manga/:id/set-thumbnail', asyncWrapper(async (req, res) => {
  const db = getDb();
  const { page_id, saved_filename } = req.body;
  if (!page_id && !saved_filename) {
    return res.status(400).json({ error: 'page_id or saved_filename is required' });
  }

  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const activeName = `${manga.id}.webp`;
  ensureShardDir(activeName);
  const activePath = thumbnailPath(activeName);

  if (saved_filename) {
    // Validate: basename only, must belong to this manga, webp only
    const safeName = path.basename(saved_filename);
    if (!safeName.startsWith(`${manga.id}_`) || !safeName.endsWith('.webp')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const srcPath = thumbnailPath(safeName);
    if (!fs.existsSync(srcPath)) {
      return res.status(404).json({ error: 'Thumbnail file not found' });
    }
    fs.copyFileSync(srcPath, activePath);
    console.log(`[Thumbnail] Set thumbnail for manga ${manga.id} from saved file ${safeName}`);
  } else {
    // Generate from a page and save as a uniquely-named history file
    const page = db.prepare('SELECT path FROM pages WHERE id = ?').get(page_id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    if (!fs.existsSync(page.path)) {
      return res.status(404).json({ error: 'Image file not found on disk' });
    }

    const histFilename = `${manga.id}_${Date.now()}.webp`;
    ensureShardDir(histFilename);
    const histPath     = thumbnailPath(histFilename);

    await sharp(page.path)
      .resize(300, 430, { fit: 'cover', position: 'top' })
      .webp({ quality: 85 })
      .toFile(histPath);

    fs.copyFileSync(histPath, activePath);

    // Record in history (INSERT OR IGNORE to avoid duplicates)
    db.prepare('INSERT OR IGNORE INTO thumbnail_history (manga_id, filename) VALUES (?, ?)')
      .run(manga.id, histFilename);

    console.log(`[Thumbnail] Set thumbnail for manga ${manga.id} from page ${page_id}`);
  }

  db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
    .run(`${manga.id}.webp`, manga.id);

  res.json({ data: { cover_image: `${manga.id}.webp` } });
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
