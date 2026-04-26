const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { fetchFromAniList, fetchBatchFromAniList, fetchBatchByAniListIds, searchAniList, fetchByAniListId, getMediaListEntry, saveMediaListEntry, recommendedDelayMs: anilistRecommendedDelayMs } = require('../metadata/anilist');
const { searchDoujinshi, fetchFromDoujinshi, fetchByDoujinshiSlug } = require('../metadata/doujinshi');
const { fetchFromMAL, searchMAL, fetchByMALId, MAL_REQUEST_INTERVAL_MS } = require('../metadata/myanimelist');
const { getSetting, getDeviceSession } = require('./settings');
const { thumbnailPath, ensureShardDir } = require('../scanner/thumbnailPaths');
const cbzCache = require('../scanner/cbzCache');
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

// Display priority for the metadata fields shown in the UI.
//
//   local > anilist > myanimelist > doujinshi > none
//
// A manga can be linked to any combination of AniList / MAL / Doujinshi
// simultaneously — adding one linkage never breaks another. The displayed
// metadata source (`metadata_source`) is whichever **currently linked**
// source has the highest priority among the linkages plus any local JSON.
// `metadata_source` is therefore the visible-fields source, not a flag
// that disables other linkages.
const DISPLAY_PRIORITY = {
  none:        -1,
  doujinshi:    0,
  myanimelist:  1,
  anilist:      2,
  local:        3,
};

function priorityOf(source) {
  return DISPLAY_PRIORITY[source] ?? -1;
}

/**
 * True when an incoming source should take over the displayed fields.
 * Equal-priority means "refresh in place" (e.g. re-fetching AniList for an
 * AniList-displayed manga rewrites the same fields). Lower-priority leaves
 * displayed fields untouched and only records the linkage.
 */
function shouldOverwriteDisplay(currentSource, incomingSource) {
  return priorityOf(incomingSource) >= priorityOf(currentSource);
}

/**
 * Apply a metadata fetch result to a manga row in a way that:
 *
 *   1. Always preserves any existing linkage IDs from other sources via
 *      COALESCE — establishing a MAL link never clobbers `anilist_id`,
 *      and vice versa. Doujinshi.info's slug is also preserved.
 *   2. Updates only the incoming source's linkage ID with the fetched
 *      value (so re-fetching AniList still rewrites `anilist_id`, even
 *      though it's normally the same number).
 *   3. Overwrites displayed fields (title, description, status, year,
 *      genres, score, author, metadata_source) only when the incoming
 *      source's priority is ≥ current.
 *
 * The cover image is NOT handled here — `fetchAndStoreCover` writes to the
 * source-specific cover column unconditionally, and only swaps the active
 * `cover_image` when this source is the new display source.
 *
 * Returns true when the displayed fields were changed.
 */
function applyMetadataToDb(db, manga, result, source) {
  const overwriteDisplay = shouldOverwriteDisplay(manga.metadata_source, source);

  // Only the incoming source's ID is taken from `result`; the others fall
  // back to whatever the row already had. This is the central anti-clobber
  // invariant for the linkage logic.
  const anilistId   = source === 'anilist'     ? (result.anilist_id   ?? null) : null;
  const malId       = source === 'myanimelist' ? (result.mal_id       ?? null) : null;
  const doujinshiId = source === 'doujinshi'   ? (result.doujinshi_id ?? null) : null;

  if (overwriteDisplay) {
    db.prepare(`
      UPDATE manga SET
        title           = ?,
        description     = ?,
        status          = ?,
        year            = ?,
        genres          = ?,
        score           = ?,
        author          = ?,
        anilist_id      = COALESCE(?, anilist_id),
        mal_id          = COALESCE(?, mal_id),
        doujinshi_id    = COALESCE(?, doujinshi_id),
        metadata_source = ?,
        updated_at      = unixepoch()
      WHERE id = ?
    `).run(
      result.title,
      result.description,
      result.status,
      result.year,
      JSON.stringify(result.genres ?? []),
      result.score,
      result.author ?? null,
      anilistId, malId, doujinshiId,
      source,
      manga.id
    );
  } else {
    db.prepare(`
      UPDATE manga SET
        anilist_id   = COALESCE(?, anilist_id),
        mal_id       = COALESCE(?, mal_id),
        doujinshi_id = COALESCE(?, doujinshi_id),
        updated_at   = unixepoch()
      WHERE id = ?
    `).run(anilistId, malId, doujinshiId, manga.id);
  }

  return overwriteDisplay;
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

// Apply metadata and cover for a single manga. The DB write preserves
// linkage IDs for every other source (so e.g. applying MAL never wipes
// `anilist_id`) and only overwrites displayed fields when the incoming
// source has equal or higher priority than the current display source.
//
// The source-specific cover column (`anilist_cover`, `mal_cover`) is always
// updated on a successful download; the active `cover_image` is only swapped
// when this source becomes the new display source — so adding a MAL link
// to an AniList-displayed manga downloads the MAL cover for the picker but
// leaves the visible cover on AniList.
async function applyMetadataToManga(db, manga, result, source) {
  const becameDisplay = applyMetadataToDb(db, manga, result, source);
  await fetchAndStoreCover(db, manga.id, result.cover_url, source, {
    setActive: becameDisplay,
  });
  return { becameDisplay };
}

// POST /api/manga/:id/refresh-metadata — auto-fetch by title
router.post('/manga/:id/refresh-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const token = getToken(db);
  // Title cleaning is done inside fetchFromAniList via the shared helper, so
  // we just hand the raw title through.
  const result = await fetchFromAniList(manga.title, token);

  if (!result) {
    return res.json({ found: false, message: 'No match found on AniList for this title.' });
  }

  await applyMetadataToManga(db, manga, result, 'anilist');

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

  await applyMetadataToManga(db, manga, result, 'anilist');

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

  await applyMetadataToManga(db, manga, result, 'doujinshi');

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

  await applyMetadataToManga(db, manga, result, 'doujinshi');

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

  await applyMetadataToManga(db, manga, result, 'myanimelist');

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

  await applyMetadataToManga(db, manga, result, 'myanimelist');

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({
    found: true,
    data: { ...updated, genres: safeJsonParse(updated.genres, []) },
  });
}));

// Skip re-fetching titles that were attempted within this window unless `force: true`.
const BULK_RETRY_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;  // 7 days
// AniList's GraphQL endpoint accepts aliased queries; each alias counts as
// a separate Media lookup against the per-minute request budget but only
// one HTTP request and one rate-limit slot. 10 aliases per request keeps
// us well below the documented complexity ceiling while halving the
// outbound HTTP count vs. the previous 5-per-batch.
const ANILIST_BATCH_SIZE = 10;

const markAttemptedStmt = (db) =>
  db.prepare('UPDATE manga SET last_metadata_fetch_attempt_at = ? WHERE id = ?');

function markAttempted(db, mangaIds, nowSeconds) {
  const stmt = markAttemptedStmt(db);
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(nowSeconds, id);
  });
  tx(mangaIds);
}

// POST /api/libraries/:id/bulk-metadata — refresh / fetch metadata for every
// manga in a library. Always runs over every title; never refuses.
//
// Body: { source: 'anilist' | 'myanimelist' | 'doujinshi' }   (defaults to anilist)
//
// Per-manga behaviour:
//
//   • If the manga already has the source's linkage ID
//     (anilist_id / mal_id / doujinshi_id), the existing record is **refreshed
//     by ID** — no search, no ambiguity. Fields are overwritten with the
//     authoritative current data from the source. For local-source manga
//     (`metadata_source = 'local'`) only the linkage ID is rewritten; the
//     user's own metadata fields and cover are preserved.
//
//   • Otherwise, the title is **searched**. The folder-derived title runs
//     through the shared `cleanSearchTitle` helper to strip release-group
//     brackets, volume / chapter markers, year ranges, and quality tags
//     (e.g. "Fruits Basket Another (2018-2022) (Digital) (1r0n)" →
//     "Fruits Basket Another"), giving the AniList / MAL / Doujinshi.info
//     search a much better chance of matching.
//
// `last_metadata_fetch_attempt_at` is still stamped so the *automatic*
// post-scan metadata fetch can honour a cooldown. The bulk endpoint itself
// no longer respects the cooldown — the user explicitly asked for a refresh.
router.post('/libraries/:id/bulk-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const VALID_SOURCES = new Set(['anilist', 'myanimelist', 'doujinshi']);
  const source = VALID_SOURCES.has(req.body?.source) ? req.body.source : 'anilist';

  const allManga = db.prepare(
    `SELECT id, title, metadata_source, anilist_id, mal_id, doujinshi_id,
            anilist_cover, mal_cover
     FROM manga WHERE library_id = ?`
  ).all(library.id);
  const totalCount = allManga.length;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Split into refresh (existing linkage for this source) vs search (no link).
  function linkIdFor(m) {
    if (source === 'anilist')     return m.anilist_id;
    if (source === 'myanimelist') return m.mal_id;
    if (source === 'doujinshi')   return m.doujinshi_id;
    return null;
  }
  const toRefresh = [];
  const toSearch  = [];
  for (const m of allManga) {
    if (linkIdFor(m)) toRefresh.push(m);
    else              toSearch.push(m);
  }

  // Respond immediately — the pull runs in the background.
  res.json({
    message:    'Bulk metadata pull started',
    total:      totalCount,
    to_refresh: toRefresh.length,
    to_search:  toSearch.length,
    source,
  });

  if (totalCount === 0) {
    console.log(`[BulkMetadata][${source}] "${library.name}" is empty — nothing to do.`);
    return;
  }

  console.log(
    `[BulkMetadata][${source}] Starting for "${library.name}": ` +
    `${toRefresh.length} to refresh by ID, ${toSearch.length} to search by title ` +
    `(${totalCount} total).`
  );

  const anilistToken   = getToken(db);
  const doujinshiToken = getDoujinshiToken(db);
  const malClientId    = getMalClientId(db);

  const counters = {
    refreshed: 0, // had linkage; record updated from the source
    applied:   0, // searched; full metadata applied
    linked:    0, // searched; local-source manga, link-only write
    noMatch:   0, // searched; no result
    errors:    0,
  };
  const totalToDo = toRefresh.length + toSearch.length;
  const progressN = () =>
    counters.refreshed + counters.applied + counters.linked +
    counters.noMatch  + counters.errors + 1;

  async function applySearchResult(manga, result) {
    const n = progressN();
    if (!result) {
      counters.noMatch++;
      console.log(`[BulkMetadata][${source}] (${n}/${totalToDo}) No match: "${manga.title}"`);
      return;
    }
    // applyMetadataToManga preserves other linkages, switches displayed
    // fields only when this source has higher-or-equal priority, and
    // promotes the cover only when this source becomes the new display.
    const { becameDisplay } = await applyMetadataToManga(db, manga, result, source);
    if (becameDisplay) {
      counters.applied++;
      console.log(
        `[BulkMetadata][${source}] (${n}/${totalToDo}) Applied (now displayed): ` +
        `"${manga.title}" → "${result.title}"`
      );
    } else {
      counters.linked++;
      console.log(
        `[BulkMetadata][${source}] (${n}/${totalToDo}) Linked (display preserved as ${manga.metadata_source}): ` +
        `"${manga.title}" → "${result.title}"`
      );
    }
  }

  async function applyRefreshResult(manga, result) {
    const n = progressN();
    if (!result) {
      // ID lookup miss is rare (deleted entry on the upstream); treat as a
      // soft error so the user notices stale linkages.
      counters.errors++;
      console.warn(
        `[BulkMetadata][${source}] (${n}/${totalToDo}) Refresh failed — ` +
        `linkage exists but lookup returned nothing: "${manga.title}"`
      );
      return;
    }
    const { becameDisplay } = await applyMetadataToManga(db, manga, result, source);
    counters.refreshed++;
    console.log(
      `[BulkMetadata][${source}] (${n}/${totalToDo}) Refreshed: ` +
      `"${manga.title}" → "${result.title}"` +
      (becameDisplay ? '' : ` [display preserved as ${manga.metadata_source}]`)
    );
  }

  // Per-source delay between outbound HTTP requests. AniList exposes
  // `X-RateLimit-Limit`; the helper recomputes a target spacing on every
  // response so a degraded service (recently 30 req/min instead of 90)
  // doesn't trigger an avoidable 429. MAL has no public limit but
  // community usage settles around 1 req/sec — `MAL_REQUEST_INTERVAL_MS`
  // owns that constant. Doujinshi.info stays at the previous 500 ms.
  function delayMsFor(src) {
    if (src === 'anilist')     return anilistRecommendedDelayMs();
    if (src === 'myanimelist') return MAL_REQUEST_INTERVAL_MS;
    return 500; // doujinshi
  }
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ── Refresh phase: fetch every linked title by its ID ────────────────────
  if (source === 'anilist' && toRefresh.length > 0) {
    // Batched alias query — one HTTP request per ANILIST_BATCH_SIZE titles.
    for (let i = 0; i < toRefresh.length; i += ANILIST_BATCH_SIZE) {
      const batch = toRefresh.slice(i, i + ANILIST_BATCH_SIZE);
      try {
        const results = await fetchBatchByAniListIds(
          batch.map(m => Number(m.anilist_id)), anilistToken
        );
        for (let j = 0; j < batch.length; j++) {
          await applyRefreshResult(batch[j], results[j]);
        }
      } catch (err) {
        for (const m of batch) {
          counters.errors++;
          const n = progressN();
          console.warn(
            `[BulkMetadata][anilist] (${n}/${totalToDo}) Refresh batch error for "${m.title}": ${err.message}`
          );
        }
      }
      markAttempted(db, batch.map(m => m.id), nowSeconds);
      await sleep(delayMsFor('anilist'));
    }
  } else if (toRefresh.length > 0) {
    for (const m of toRefresh) {
      try {
        const result = source === 'myanimelist'
          ? await fetchByMALId(Number(m.mal_id), malClientId)
          : await fetchByDoujinshiSlug(m.doujinshi_id, doujinshiToken);
        await applyRefreshResult(m, result);
      } catch (err) {
        counters.errors++;
        const n = progressN();
        console.warn(
          `[BulkMetadata][${source}] (${n}/${totalToDo}) Refresh error for "${m.title}": ${err.message}`
        );
      }
      markAttempted(db, [m.id], nowSeconds);
      await sleep(delayMsFor(source));
    }
  }

  // ── Search phase: clean the title and look up unlinked manga ─────────────
  if (source === 'anilist' && toSearch.length > 0) {
    for (let i = 0; i < toSearch.length; i += ANILIST_BATCH_SIZE) {
      const batch = toSearch.slice(i, i + ANILIST_BATCH_SIZE);
      try {
        // Title cleaning happens inside fetchBatchFromAniList already.
        const results = await fetchBatchFromAniList(batch.map(m => m.title), anilistToken);
        for (let j = 0; j < batch.length; j++) {
          await applySearchResult(batch[j], results[j]);
        }
      } catch (err) {
        for (const m of batch) {
          counters.errors++;
          const n = progressN();
          console.warn(
            `[BulkMetadata][anilist] (${n}/${totalToDo}) Search batch error for "${m.title}": ${err.message}`
          );
        }
      }
      markAttempted(db, batch.map(m => m.id), nowSeconds);
      await sleep(delayMsFor('anilist'));
    }
  } else if (toSearch.length > 0) {
    for (const m of toSearch) {
      try {
        const result = source === 'doujinshi'
          ? await fetchFromDoujinshi(m.title, doujinshiToken)
          : await fetchFromMAL(m.title, malClientId);
        await applySearchResult(m, result);
      } catch (err) {
        counters.errors++;
        const n = progressN();
        console.warn(
          `[BulkMetadata][${source}] (${n}/${totalToDo}) Search error for "${m.title}": ${err.message}`
        );
      }
      markAttempted(db, [m.id], nowSeconds);
      await sleep(delayMsFor(source));
    }
  }

  console.log(
    `[BulkMetadata][${source}] Finished for "${library.name}": ` +
    `${counters.refreshed} refreshed, ${counters.applied} applied, ` +
    `${counters.linked} linked (local preserved), ${counters.noMatch} no match, ` +
    `${counters.errors} errors.`
  );
}));

// Build the metadata.json payload from a manga row + optional fetched third-party record.
// When `remote` is provided (local-source manga linked to a third-party), its fields override
// the DB fields so the exported JSON reflects the third-party data rather than the local entry.
function buildExportPayload(manga, remote) {
  const genres = remote?.genres ?? safeJsonParse(manga.genres, []);
  const title          = remote?.title       ?? manga.title;
  const author         = remote?.author      ?? manga.author;
  const description    = remote?.description ?? manga.description;
  const year           = remote?.year        ?? manga.year;
  const score          = remote?.score       ?? manga.score;
  const status         = remote?.status      ?? manga.status;
  const anilist_id     = remote?.anilist_id   ?? manga.anilist_id;
  const mal_id         = remote?.mal_id       ?? manga.mal_id;
  const doujinshi_id   = remote?.doujinshi_id ?? manga.doujinshi_id;
  const metadata_source = remote?.source      ?? manga.metadata_source;

  return {
    title,
    ...(author      ? { author }      : {}),
    ...(description ? { description } : {}),
    ...(genres && genres.length ? { genres } : {}),
    ...(year   ? { year }   : {}),
    ...(score  ? { score }  : {}),
    ...(status ? { status } : {}),
    ...(anilist_id   ? { anilist_id }   : {}),
    ...(mal_id       ? { mal_id }       : {}),
    ...(doujinshi_id ? { doujinshi_id } : {}),
    metadata_source,
    exported_at: new Date().toISOString(),
  };
}

// Re-fetch third-party metadata for a manga that has at least one linkage.
// AniList is preferred over MyAnimeList over Doujinshi.info, matching the
// display priority. Returns `{ remote, source }` where `source` names the
// upstream that answered, or null if no linkage is present / every fetch
// failed.
async function fetchRemoteForExport(manga, { anilistToken, malClientId, doujinshiToken }) {
  try {
    if (manga.anilist_id) {
      const remote = await fetchByAniListId(Number(manga.anilist_id), anilistToken);
      if (remote) return { remote, source: 'anilist' };
    }
  } catch (err) {
    console.warn(`[ExportMetadata] AniList fetch failed for "${manga.title}": ${err.message}`);
  }
  try {
    if (manga.mal_id && malClientId) {
      const remote = await fetchByMALId(Number(manga.mal_id), malClientId);
      if (remote) return { remote, source: 'myanimelist' };
    }
  } catch (err) {
    console.warn(`[ExportMetadata] MAL fetch failed for "${manga.title}": ${err.message}`);
  }
  try {
    if (manga.doujinshi_id) {
      const remote = await fetchByDoujinshiSlug(manga.doujinshi_id, doujinshiToken);
      if (remote) return { remote, source: 'doujinshi' };
    }
  } catch (err) {
    console.warn(`[ExportMetadata] Doujinshi fetch failed for "${manga.title}": ${err.message}`);
  }
  return null;
}

// POST /api/libraries/:id/export-metadata — write metadata.json to each
// manga folder.
//
// Per-manga behaviour:
//   • If at least one external linkage exists (`anilist_id`, `mal_id`, or
//     `doujinshi_id`), re-fetch from the highest-priority linked source
//     (AniList > MAL > Doujinshi.info) and write THAT to `metadata.json`,
//     overwriting any existing file regardless of the manga's current
//     `metadata_source`. This is the "replace local JSON with third-party
//     data" path the user asked for.
//   • Otherwise, if `metadata_source` is one of the third-party tags
//     ('anilist', 'myanimelist', 'doujinshi'), write the DB-stored fields.
//     This handles legacy rows where the linkage ID was somehow lost but
//     the metadata is still present.
//   • Otherwise (no link AND `metadata_source` is 'none' or 'local' with
//     no link), skip — there's nothing third-party to export.
//
// The DB row itself is never touched; only the on-disk sidecar is written.
router.post('/libraries/:id/export-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const totalCount = db.prepare('SELECT COUNT(*) AS n FROM manga WHERE library_id = ?').get(library.id).n;
  const allManga   = db.prepare('SELECT * FROM manga WHERE library_id = ?').all(library.id);

  const anilistToken   = getToken(db);
  const doujinshiToken = getDoujinshiToken(db);
  const malClientId    = getMalClientId(db);

  let exported               = 0;
  let exportedLocal          = 0; // local-displayed manga had its sidecar replaced
  let skipped                = 0;
  let writeErrors            = 0;

  for (const manga of allManga) {
    const hasThirdPartyLink = !!(manga.anilist_id || manga.mal_id || manga.doujinshi_id);

    // Skip when there is genuinely nothing external to export — neither a
    // linkage nor third-party-sourced fields in the DB.
    if (!hasThirdPartyLink &&
        (manga.metadata_source === 'none' || manga.metadata_source === 'local')) {
      skipped++;
      continue;
    }

    try {
      let payload;
      let usedRemote = false;
      const wasLocalDisplayed = manga.metadata_source === 'local';

      if (hasThirdPartyLink) {
        const fetched = await fetchRemoteForExport(manga, {
          anilistToken, malClientId, doujinshiToken,
        });
        if (fetched) {
          payload = buildExportPayload(manga, fetched.remote);
          usedRemote = true;
          // Pace per the source that just answered. AniList exposes a
          // live X-RateLimit-Limit header; MAL/Doujinshi use fixed delays.
          if (fetched.source === 'anilist') {
            await new Promise(r => setTimeout(r, anilistRecommendedDelayMs()));
          } else if (fetched.source === 'myanimelist') {
            await new Promise(r => setTimeout(r, MAL_REQUEST_INTERVAL_MS));
          } else if (fetched.source === 'doujinshi') {
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }

      if (!payload) {
        // Fallback: write whatever the DB has. Only happens for rows that
        // have third-party fields but no linkage — rare, but legitimate.
        if (!hasThirdPartyLink &&
            !['anilist', 'myanimelist', 'doujinshi'].includes(manga.metadata_source)) {
          skipped++;
          continue;
        }
        payload = buildExportPayload(manga, null);
      }

      const outPath = path.join(manga.path, 'metadata.json');
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
      exported++;
      if (wasLocalDisplayed && usedRemote) exportedLocal++;
    } catch (err) {
      writeErrors++;
      console.warn(`[ExportMetadata] Failed for "${manga.title}": ${err.message}`);
    }
  }

  console.log(
    `[ExportMetadata] "${library.name}": exported ${exported} ` +
    `(${exportedLocal} local-displayed manga had their sidecar replaced with third-party data), ` +
    `skipped ${skipped}, ${writeErrors} write errors.`
  );

  res.json({
    data: { total: totalCount, exported, exported_local: exportedLocal, skipped, errors: writeErrors },
  });
}));

// POST /api/manga/:id/export-metadata — write metadata.json for a single
// manga.
//
// Body: { source?: 'anilist' | 'myanimelist' | 'doujinshi' }
//
// • Per-source mode (`source` provided) — fetch from THAT specific source's
//   linkage, regardless of which source the manga currently displays. Each
//   tab in the Metadata modal can independently export its own JSON, so the
//   user can save AniList JSON for a manga whose displayed source is local,
//   MAL JSON for an AniList-displayed manga, etc. Requires `<source>_id`
//   to be set; otherwise 400.
// • Auto mode (no `source`) — re-fetch from the highest-priority linked
//   source (AniList > MAL > Doujinshi.info), matching the bulk-export rule.
//   Falls back to DB-stored fields if the manga has third-party `metadata_source`
//   but no linkage at all.
//
// In every mode the on-disk `metadata.json` is **always overwritten** —
// `fs.writeFileSync` is unconditional by design. Calling export with the
// file already present replaces it with the freshly-built payload.
router.post('/manga/:id/export-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { source } = req.body || {};
  const SOURCE_LINK_FIELD = {
    anilist:     'anilist_id',
    myanimelist: 'mal_id',
    doujinshi:   'doujinshi_id',
  };

  // ── Per-source export ────────────────────────────────────────────────────
  if (source !== undefined) {
    if (!SOURCE_LINK_FIELD[source]) {
      return res.status(400).json({ error: 'Invalid source' });
    }
    const linkId = manga[SOURCE_LINK_FIELD[source]];
    if (!linkId) {
      return res.status(400).json({
        error: `This manga has no ${source} linkage. Fetch from ${source} first, then export.`,
      });
    }

    let remote = null;
    try {
      if (source === 'anilist') {
        remote = await fetchByAniListId(Number(linkId), getToken(db));
      } else if (source === 'myanimelist') {
        const clientId = getMalClientId(db);
        if (!clientId) {
          return res.status(400).json({ error: 'MyAnimeList Client ID is not configured in Settings.' });
        }
        remote = await fetchByMALId(Number(linkId), clientId);
      } else {
        remote = await fetchByDoujinshiSlug(linkId, getDoujinshiToken(db));
      }
    } catch (err) {
      console.warn(`[ExportMetadata] ${source} fetch failed for "${manga.title}": ${err.message}`);
    }
    if (!remote) {
      return res.status(502).json({ error: `Could not fetch metadata from ${source}.` });
    }

    // Spread `source` into `remote` so buildExportPayload's `remote.source`
    // branch fires — the exported `metadata_source` then reflects the source
    // we actually fetched from, not the manga's currently displayed source.
    const payload = buildExportPayload(manga, { ...remote, source });
    const outPath = path.join(manga.path, 'metadata.json');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

    console.log(
      `[ExportMetadata] Wrote metadata.json for "${manga.title}" ` +
      `(per-source export from ${source}; overwrote any existing file)`
    );
    return res.json({ data: { path: outPath, source } });
  }

  // ── Auto / priority-ordered export (legacy default) ──────────────────────
  const hasThirdPartyLink = !!(manga.anilist_id || manga.mal_id || manga.doujinshi_id);
  const hasThirdPartyFields = ['anilist', 'myanimelist', 'doujinshi'].includes(manga.metadata_source);

  if (!hasThirdPartyLink && !hasThirdPartyFields) {
    return res.status(400).json({ error: 'This manga has no linked metadata to export.' });
  }

  let remote = null;
  if (hasThirdPartyLink) {
    const fetched = await fetchRemoteForExport(manga, {
      anilistToken:   getToken(db),
      malClientId:    getMalClientId(db),
      doujinshiToken: getDoujinshiToken(db),
    });
    if (fetched) remote = fetched.remote;
    if (!remote && !hasThirdPartyFields) {
      return res.status(502).json({ error: 'Could not fetch metadata from the linked source.' });
    }
  }

  const payload = buildExportPayload(manga, remote);
  const outPath = path.join(manga.path, 'metadata.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(
    `[ExportMetadata] Wrote metadata.json for "${manga.title}" ` +
    `(source=${manga.metadata_source}${remote ? ' → re-fetched third-party' : ''}; overwrote any existing file)`
  );
  res.json({ data: { path: outPath } });
}));

// POST /api/manga/:id/reset-metadata — break external linkage and clear sourced metadata fields
// Body: { source?: 'anilist' | 'myanimelist' | 'doujinshi' }
//   omitted → full reset: clears all IDs, metadata fields, sets metadata_source to 'none'
//   given  → break only that source's linkage:
//            - always NULLs the corresponding *_id (and source cover column, if any)
//            - when metadata_source matches source: also clears metadata fields and sets to 'none'
//            - when metadata_source is 'local' or another third-party: preserves fields so that
//              local JSON / other-source data remains the display source
router.post('/manga/:id/reset-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { source } = req.body || {};
  const SOURCE_MAP = {
    anilist:     { idField: 'anilist_id',   coverField: 'anilist_cover' },
    myanimelist: { idField: 'mal_id',       coverField: 'mal_cover'     },
    doujinshi:   { idField: 'doujinshi_id', coverField: null            },
  };

  if (source !== undefined) {
    if (!SOURCE_MAP[source]) return res.status(400).json({ error: 'Invalid source' });
    const { idField, coverField } = SOURCE_MAP[source];
    const fullReset = manga.metadata_source === source;

    if (fullReset) {
      db.prepare(`
        UPDATE manga SET
          ${idField}                     = NULL,
          ${coverField ? `${coverField} = NULL,` : ''}
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
    } else {
      db.prepare(`
        UPDATE manga SET
          ${idField}                     = NULL,
          ${coverField ? `${coverField} = NULL,` : ''}
          updated_at                     = unixepoch()
        WHERE id = ?
      `).run(manga.id);
    }
  } else {
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
  }

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({ data: { ...updated, genres: safeJsonParse(updated.genres, []) } });
}));

// Filename helpers — generated chapter covers use a deterministic name so
// re-running Generate Covers is idempotent, and we can split them out from
// manually-saved history entries (which use a timestamp suffix) at read time.
function generatedCoverFilename(mangaId, chapterId) {
  return `${mangaId}_ch${chapterId}.webp`;
}
function isGeneratedCoverFilename(mangaId, filename) {
  return new RegExp(`^${mangaId}_ch\\d+\\.webp$`).test(filename);
}

function chapterLabel(ch) {
  if (ch.volume !== null && ch.number !== null) return `Vol.${ch.volume} Ch.${ch.number}`;
  if (ch.volume !== null) return `Vol.${ch.volume}`;
  if (ch.number !== null) return `Ch.${ch.number}`;
  return ch.folder_name;
}

// GET /api/manga/:id/thumbnail-options — list all available thumbnail choices
router.get('/manga/:id/thumbnail-options', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id, anilist_cover, original_cover, cover_image FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  // Pull every history row for the manga. Generated chapter covers (deterministic
  // filenames `<mangaId>_ch<chapterId>.webp`) are folded into chapter_first_pages
  // below — they aren't returned as a separate section. Manual saves (timestamped
  // filenames) feed the Previously Used section, capped at 20 most recent.
  const allHistory = db.prepare(
    'SELECT id, filename, created_at FROM thumbnail_history WHERE manga_id = ? ORDER BY created_at DESC'
  ).all(manga.id);
  const generatedByChapter = new Map(); // chapter_id -> filename
  for (const h of allHistory) {
    const m = new RegExp(`^${manga.id}_ch(\\d+)\\.webp$`).exec(h.filename);
    if (m) generatedByChapter.set(parseInt(m[1], 10), h.filename);
  }
  const history = allHistory
    .filter(h => !isGeneratedCoverFilename(manga.id, h.filename))
    .slice(0, 20);

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
      // Each chapter gets one tile. If a generated cover exists for that chapter
      // (produced by POST /generate-chapter-covers), the entry includes its
      // `generated_filename` so the client can render the pre-sized thumbnail
      // and apply it via setThumbnailFromFile. Otherwise the client falls back
      // to streaming the raw page image and generating on apply.
      chapter_first_pages: chapterPages
        .filter(ch => ch.page_id !== null)
        .map(ch => ({
          chapter_id:        ch.chapter_id,
          page_id:           ch.page_id,
          label:             chapterLabel(ch),
          generated_filename: generatedByChapter.get(ch.chapter_id) || null,
        })),
    },
  });
}));

// POST /api/manga/:id/generate-chapter-covers — render a 300×430 WebP thumbnail
// from the first page of every chapter and add each to thumbnail_history.
//
// Filenames are deterministic per (manga, chapter) so repeated runs are
// idempotent: existing files are reused and only missing chapters are
// regenerated. The active cover is left untouched — this only populates the
// pool of available thumbnails the user can pick from in the modal.
router.post('/manga/:id/generate-chapter-covers', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const chapters = db.prepare(`
    SELECT c.id   AS chapter_id, c.type AS chapter_type, c.path AS chapter_path,
           p.id   AS page_id,    p.path AS page_path,    p.page_index
    FROM chapters c
    LEFT JOIN pages p ON p.chapter_id = c.id AND p.page_index = 0
    WHERE c.manga_id = ?
    ORDER BY COALESCE(c.number, c.volume) ASC NULLS LAST, c.folder_name ASC
  `).all(manga.id);

  let generated = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const ch of chapters) {
    if (!ch.page_id) { skipped++; continue; }

    const filename = generatedCoverFilename(manga.id, ch.chapter_id);
    ensureShardDir(filename);
    const outputPath = thumbnailPath(filename);

    // Idempotency: if the file is already on disk, just make sure the history
    // row exists (handles cases where the row was lost but the file remains)
    // and skip the regen.
    if (fs.existsSync(outputPath)) {
      db.prepare('INSERT OR IGNORE INTO thumbnail_history (manga_id, filename) VALUES (?, ?)')
        .run(manga.id, filename);
      skipped++;
      continue;
    }

    try {
      // Resolve the source image. For CBZ chapters we route through the cache;
      // the cache may auto-clear mid-loop (overflow protection keeps the just-
      // extracted dir, but parallel reads or the schedule can still wipe ours),
      // so verify the file exists and re-extract once if it vanished.
      let input;
      if (ch.chapter_type === 'cbz') {
        if (!fs.existsSync(ch.chapter_path)) { errors++; continue; }
        input = await cbzCache.getCbzPageFile(ch.chapter_id, ch.chapter_path, ch.page_index);
        if (input && !fs.existsSync(input)) {
          input = await cbzCache.getCbzPageFile(ch.chapter_id, ch.chapter_path, ch.page_index);
        }
      } else {
        if (!fs.existsSync(ch.page_path)) { errors++; continue; }
        input = ch.page_path;
      }
      if (!input) { errors++; continue; }

      await sharp(input)
        .resize(300, 430, { fit: 'cover', position: 'top' })
        .webp({ quality: 85 })
        .toFile(outputPath);

      db.prepare('INSERT OR IGNORE INTO thumbnail_history (manga_id, filename) VALUES (?, ?)')
        .run(manga.id, filename);
      generated++;
    } catch (err) {
      errors++;
      console.warn(
        `[Thumbnail] Generate-chapter-covers: manga ${manga.id} chapter ${ch.chapter_id} failed: ${err.message}`
      );
    }
  }

  console.log(
    `[Thumbnail] Generated chapter covers for manga ${manga.id}: ` +
    `${generated} new, ${skipped} reused, ${errors} errors (${chapters.length} chapters)`
  );

  res.json({ data: { generated, skipped, errors, total: chapters.length } });
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
    // Generate from a page and save as a uniquely-named history file. CBZ
    // pages are resolved through the extraction cache so we're always reading
    // a plain on-disk image rather than reaching back into the archive.
    const page = db.prepare(`
      SELECT p.path AS page_path, p.page_index, c.id AS chapter_id,
             c.type AS chapter_type, c.path AS chapter_path
      FROM pages p
      JOIN chapters c ON c.id = p.chapter_id
      WHERE p.id = ?
    `).get(page_id);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    if (page.chapter_type === 'folder' && !fs.existsSync(page.page_path)) {
      return res.status(404).json({ error: 'Image file not found on disk' });
    }
    if (page.chapter_type === 'cbz' && !fs.existsSync(page.chapter_path)) {
      return res.status(404).json({ error: 'Archive file not found on disk' });
    }

    let input;
    try {
      if (page.chapter_type === 'cbz') {
        input = await cbzCache.getCbzPageFile(page.chapter_id, page.chapter_path, page.page_index);
      } else {
        input = page.page_path;
      }
    } catch (err) {
      return res.status(404).json({ error: 'Image entry not found in archive' });
    }
    if (!input) return res.status(500).json({ error: 'Failed to load page image' });

    const histFilename = `${manga.id}_${Date.now()}.webp`;
    ensureShardDir(histFilename);
    const histPath     = thumbnailPath(histFilename);

    await sharp(input)
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
