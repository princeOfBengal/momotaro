const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { fetchFromAniList, fetchBatchFromAniList, fetchBatchByAniListIds, searchAniList, fetchByAniListId, getMediaListEntry, saveMediaListEntry, recommendedDelayMs: anilistRecommendedDelayMs } = require('../metadata/anilist');
const { searchDoujinshi, fetchFromDoujinshi, fetchByDoujinshiSlug } = require('../metadata/doujinshi');
const { fetchFromMAL, searchMAL, fetchByMALId, fetchBatchByMALIds, fetchBatchFromMAL, MAL_REQUEST_INTERVAL_MS } = require('../metadata/myanimelist');
const {
  fetchFromMangaUpdates, searchMangaUpdates, fetchByMangaUpdatesId,
  fetchBatchByMangaUpdatesIds, fetchBatchFromMangaUpdates,
  MU_REQUEST_INTERVAL_MS,
} = require('../metadata/mangaupdates');
const { getCached: getCachedMetadata } = require('../metadata/cache');
const { getUserAniList } = require('./settings');
const { requireAdmin } = require('../middleware/auth');
const { thumbnailPath, ensureShardDir } = require('../scanner/thumbnailPaths');
const { reinforceActiveCover } = require('../scanner/coverResolver');
const { safeJsonParse, getSetting, computeAggregateScore } = require('../utils');
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

// AniList user-list cache. Hit on every manga-detail page open via
// GET /manga/:id/anilist-status, so we cache the result per (user, media)
// for a short window to keep page browsing from triggering an AniList ping
// each time. Mutations (PATCH .../anilist-progress) refresh the entry and
// invalidate is implicit because we overwrite with the post-mutation value.
const ANILIST_LIST_CACHE_TTL_SECONDS = 5 * 60;

function getCachedListEntry(db, userId, mediaId) {
  if (!userId || !mediaId) return null;
  const row = db.prepare(
    'SELECT entry_json, fetched_at FROM anilist_media_list_cache WHERE user_id = ? AND media_id = ?'
  ).get(userId, mediaId);
  if (!row) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - row.fetched_at;
  if (ageSeconds > ANILIST_LIST_CACHE_TTL_SECONDS) return null;
  // entry_json === null is a real cached answer ("not on user's list").
  if (row.entry_json === null) return { hit: true, entry: null };
  try {
    return { hit: true, entry: JSON.parse(row.entry_json) };
  } catch {
    return null;
  }
}

function setCachedListEntry(db, userId, mediaId, entry) {
  if (!userId || !mediaId) return;
  db.prepare(`
    INSERT INTO anilist_media_list_cache (user_id, media_id, entry_json, fetched_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id, media_id) DO UPDATE SET
      entry_json = excluded.entry_json,
      fetched_at = excluded.fetched_at
  `).run(userId, mediaId, entry === null ? null : JSON.stringify(entry));
}

// Display priority for the metadata fields shown in the UI.
//
//   local > anilist > myanimelist > mangaupdates > doujinshi > none
//
// A manga can be linked to any combination of AniList / MAL / MangaUpdates /
// Doujinshi simultaneously — adding one linkage never breaks another. The
// displayed metadata source (`metadata_source`) is whichever **currently
// linked** source has the highest priority among the linkages plus any
// local JSON. `metadata_source` is therefore the visible-fields source,
// not a flag that disables other linkages.
const DISPLAY_PRIORITY = {
  none:         -1,
  doujinshi:     0,
  mangaupdates:  1,
  myanimelist:   2,
  anilist:       3,
  local:         4,
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
  const anilistId      = source === 'anilist'      ? (result.anilist_id      ?? null) : null;
  const malId          = source === 'myanimelist'  ? (result.mal_id          ?? null) : null;
  const muId           = source === 'mangaupdates' ? (result.mangaupdates_id ?? null) : null;
  const doujinshiId    = source === 'doujinshi'    ? (result.doujinshi_id    ?? null) : null;

  // Per-source ratings are stored independently of which source is displayed
  // — same decoupling as the per-source cover columns. The incoming source's
  // rating always overwrites its own column; the others (and the generic
  // local_score) carry over from the row. `score` is then the average of all
  // non-null per-source ratings, so it stays correct regardless of display
  // priority. Doujinshi has no rating column, so it only triggers a recompute.
  const nextScores = {
    anilist_score:      source === 'anilist'      ? (result.score ?? null) : (manga.anilist_score ?? null),
    mal_score:          source === 'myanimelist'  ? (result.score ?? null) : (manga.mal_score ?? null),
    mangaupdates_score: source === 'mangaupdates' ? (result.score ?? null) : (manga.mangaupdates_score ?? null),
    local_score:        manga.local_score ?? null,
  };
  const aggregateScore = computeAggregateScore(nextScores);

  if (overwriteDisplay) {
    db.prepare(`
      UPDATE manga SET
        title              = ?,
        description        = ?,
        status             = ?,
        year               = ?,
        genres             = ?,
        anilist_score      = ?,
        mal_score          = ?,
        mangaupdates_score = ?,
        score              = ?,
        author             = ?,
        anilist_id         = COALESCE(?, anilist_id),
        mal_id             = COALESCE(?, mal_id),
        mangaupdates_id    = COALESCE(?, mangaupdates_id),
        doujinshi_id       = COALESCE(?, doujinshi_id),
        metadata_source    = ?,
        updated_at         = unixepoch()
      WHERE id = ?
    `).run(
      result.title,
      result.description,
      result.status,
      result.year,
      JSON.stringify(result.genres ?? []),
      nextScores.anilist_score, nextScores.mal_score, nextScores.mangaupdates_score,
      aggregateScore,
      result.author ?? null,
      anilistId, malId, muId, doujinshiId,
      source,
      manga.id
    );
  } else {
    db.prepare(`
      UPDATE manga SET
        anilist_score      = ?,
        mal_score          = ?,
        mangaupdates_score = ?,
        score              = ?,
        anilist_id         = COALESCE(?, anilist_id),
        mal_id             = COALESCE(?, mal_id),
        mangaupdates_id    = COALESCE(?, mangaupdates_id),
        doujinshi_id       = COALESCE(?, doujinshi_id),
        updated_at         = unixepoch()
      WHERE id = ?
    `).run(
      nextScores.anilist_score, nextScores.mal_score, nextScores.mangaupdates_score,
      aggregateScore,
      anilistId, malId, muId, doujinshiId, manga.id
    );
  }

  return overwriteDisplay;
}

/**
 * Recompute and persist a manga's average `score` from its current per-source
 * rating columns. Used on paths that change a rating column without going
 * through `applyMetadataToDb` (e.g. breaking a non-displayed source's linkage).
 */
function recomputeAggregateScore(db, mangaId) {
  const row = db.prepare(
    'SELECT anilist_score, mal_score, mangaupdates_score, local_score FROM manga WHERE id = ?'
  ).get(mangaId);
  if (!row) return;
  db.prepare('UPDATE manga SET score = ?, updated_at = unixepoch() WHERE id = ?')
    .run(computeAggregateScore(row), mangaId);
}

/**
 * Download a source cover image, resize to thumbnail dimensions, and save
 * it to the thumbnails directory under the source-specific filename.
 *
 * Active-cover assignment is **not** done here — the caller is expected
 * to invoke `reinforceActiveCover()` from coverResolver afterward, which
 * applies the priority order (anilist > mal > mu > doujinshi > original)
 * and respects the per-manga `cover_user_set` flag.
 *
 * source: 'anilist' | 'myanimelist' | 'mangaupdates' | 'doujinshi'
 * Runs best-effort — never throws so metadata apply never fails due to a bad image.
 */
async function fetchAndStoreCover(db, mangaId, coverUrl, source) {
  if (!coverUrl) return;
  try {
    const resp = await fetch(coverUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buffer = await resp.buffer();

    // Source-specific filename and DB column. Each integrated upstream now
    // has its own slot, so the priority resolver can rank them
    // independently of which one is currently the displayed source.
    const SOURCE_META = {
      anilist:      { suffix: 'anilist', dbField: 'anilist_cover'      },
      myanimelist:  { suffix: 'mal',     dbField: 'mal_cover'          },
      mangaupdates: { suffix: 'mu',      dbField: 'mangaupdates_cover' },
      doujinshi:    { suffix: 'dj',      dbField: 'doujinshi_cover'    },
    };
    const meta = SOURCE_META[source];
    if (!meta) {
      console.warn(`[Metadata] fetchAndStoreCover called with unknown source "${source}"`);
      return;
    }
    const savedName = `${mangaId}_${meta.suffix}.webp`;
    ensureShardDir(savedName);
    const savedPath = thumbnailPath(savedName);

    await sharp(buffer)
      .resize(300, 430, { fit: 'cover', position: 'top' })
      .webp({ quality: 85 })
      .toFile(savedPath);

    db.prepare(`UPDATE manga SET ${meta.dbField} = ? WHERE id = ?`)
      .run(savedName, mangaId);

    console.log(`[Metadata] Cover saved for manga ${mangaId} (${source})`);
  } catch (err) {
    console.warn(`[Metadata] Could not fetch cover for manga ${mangaId}: ${err.message}`);
  }
}

// Apply metadata and cover for a single manga. Three concerns, kept
// independent on purpose:
//
//   1. **Display fields** (title / description / status / year / genres /
//      score / author / metadata_source) are overwritten only when the
//      incoming source's display priority ≥ the current displayed source.
//      This is `becameDisplay` — same semantics as before.
//
//   2. **Linkage IDs** (anilist_id / mal_id / mangaupdates_id /
//      doujinshi_id) are preserved via COALESCE on every write so adding
//      a new linkage never clobbers another.
//
//   3. **Active cover** is decoupled from display source. The fetched
//      image always lands in its source-specific column (anilist_cover,
//      mal_cover, mangaupdates_cover, doujinshi_cover); then
//      `reinforceActiveCover` decides whether the visible
//      `<mangaId>.webp` should be re-pointed at it based on:
//        • the global priority (anilist > mal > mu > doujinshi > original), and
//        • the per-manga `cover_user_set` flag (a manual user pick wins).
//      So a fresh MAL apply on an AniList-covered manga downloads the
//      MAL cover for the Thumbnail Picker but leaves the visible cover
//      on AniList — even if the user later breaks the AniList linkage,
//      the next reinforce will fall through to MAL.
async function applyMetadataToManga(db, manga, result, source) {
  const becameDisplay = applyMetadataToDb(db, manga, result, source);
  await fetchAndStoreCover(db, manga.id, result.cover_url, source);
  reinforceActiveCover(db, manga.id);
  return { becameDisplay };
}

// Re-populate displayed metadata from the next-priority linked source after
// the currently-displayed one was just broken. Used by the reset-metadata
// route below and the scan-end priority enforcement pass.
//
// Walks third-party linkages in display priority (anilist > mal >
// mangaupdates > doujinshi), skipping the broken source and any whose ID
// column is already NULL. For each candidate it tries the on-disk
// per-source metadata cache first (populated whenever any fetch-by-id call
// runs against that source) and only falls back to a live upstream fetch
// when there's no cached record. This is what lets a fallback complete
// without a network round-trip whenever the user has previously linked the
// manga to that source: the normalized record we wrote at apply time is
// still on disk under data/metadata-cache/<source>/<id>.json.
//
// `applyMetadataToManga` overwrites display fields because the freshly-
// reset row has metadata_source='none', which has the lowest priority.
//
// Local metadata is intentionally not handled here: at apply time, local
// (priority 4) outranks every third-party source, so the only way for the
// displayed source to be a third party is for `metadata.json` to not exist.
// If a user later drops a `metadata.json` it will be picked up by the next
// scan; nothing to read at reset time.
//
// Returns the source name that was applied, or null when no fallback was
// possible. Best-effort — never throws so the reset still completes if the
// upstream is unreachable; the caller has already committed the SQL reset
// and the manga lands at metadata_source='none' if every fetch fails.
async function applyFallbackMetadata(db, mangaId, brokenSource) {
  const fresh = db.prepare('SELECT * FROM manga WHERE id = ?').get(mangaId);
  if (!fresh) return null;

  const candidates = [
    {
      source: 'anilist',
      id: fresh.anilist_id,
      cacheKey: () => Number(fresh.anilist_id),
      networkFetch: () => fetchByAniListId(Number(fresh.anilist_id), getToken(db)),
    },
    {
      source: 'myanimelist',
      id: fresh.mal_id,
      cacheKey: () => Number(fresh.mal_id),
      networkFetch: () => {
        const clientId = getMalClientId(db);
        // Without a configured Client ID we can't talk to MAL at all; skip
        // rather than throw, so the loop tries the next candidate.
        if (!clientId) return null;
        return fetchByMALId(Number(fresh.mal_id), clientId);
      },
    },
    {
      source: 'mangaupdates',
      id: fresh.mangaupdates_id,
      cacheKey: () => Number(fresh.mangaupdates_id),
      networkFetch: () => fetchByMangaUpdatesId(Number(fresh.mangaupdates_id)),
    },
    {
      source: 'doujinshi',
      // doujinshi_id is a slug (TEXT), not an integer — don't Number()-cast it.
      id: fresh.doujinshi_id,
      cacheKey: () => fresh.doujinshi_id,
      networkFetch: () => fetchByDoujinshiSlug(fresh.doujinshi_id, getDoujinshiToken(db)),
    },
  ];

  for (const candidate of candidates) {
    if (candidate.source === brokenSource) continue;
    if (!candidate.id) continue;

    // Cache-first: a successful prior apply for this source wrote the
    // normalized record to disk, so we can flip the display source
    // immediately without a network call.
    let result = getCachedMetadata(candidate.source, candidate.cacheKey());

    if (!result) {
      try {
        result = await candidate.networkFetch();
      } catch (err) {
        console.warn(
          `[FallbackMetadata] Manga ${mangaId}: network fallback to ${candidate.source} failed: ${err.message}`
        );
        continue;
      }
    }

    if (!result) continue;

    await applyMetadataToManga(db, fresh, result, candidate.source);
    const action = brokenSource ? `fell back from ${brokenSource}` : 'enforced priority';
    console.log(`[FallbackMetadata] Manga ${mangaId}: ${action} → ${candidate.source}`);
    return candidate.source;
  }
  return null;
}

// Choose the metadata source a manga *should* be displaying based on its
// current linkages, in display priority order (local > anilist > mal >
// mangaupdates > doujinshi). Returns the source name or null if the manga
// has no linkages at all (in which case no enforcement is needed).
//
// `local` is treated as already-correct: when local metadata.json exists,
// the scanner sets `metadata_source = 'local'` per-manga before this pass
// runs, so any row landing here with metadata_source='local' is in the
// right state regardless of linkages.
function desiredMetadataSource(row) {
  if (row.metadata_source === 'local') return 'local';
  if (row.anilist_id)           return 'anilist';
  if (row.mal_id)               return 'myanimelist';
  if (row.mangaupdates_id)      return 'mangaupdates';
  if (row.doujinshi_id)         return 'doujinshi';
  return null;
}

// Bulk-enforce display priority for every manga in a library. For each row
// where the displayed metadata source isn't the highest-priority remaining
// linkage, re-apply from the on-disk per-source cache (network only as a
// last-resort fallback). Local-metadata manga are skipped — they were
// already set by the scanner. Returns a counter object the caller can log.
//
// This pass is fast in the common steady-state case: one SELECT lists every
// manga in the library, the per-row desired-source check is a few field
// reads, and only manga whose state actually needs to change incur an
// apply. The cache hit path is purely on-disk: applyFallbackMetadata reads
// the cached normalized record, runs the standard apply path (which
// rewrites display fields, copies the source-specific cover into the
// active slot, and re-runs reinforceActiveCover), and returns. No upstream
// pings unless the cache is missing for the chosen source.
async function enforceMetadataPriorityForLibrary(db, libraryId) {
  const rows = db.prepare(`
    SELECT id, metadata_source, anilist_id, mal_id, mangaupdates_id, doujinshi_id
    FROM manga
    WHERE library_id = ?
  `).all(libraryId);

  let checked = 0;
  let switched = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    checked++;
    const desired = desiredMetadataSource(row);
    if (!desired || desired === row.metadata_source) {
      skipped++;
      continue;
    }
    try {
      const applied = await applyFallbackMetadata(db, row.id, null);
      if (applied) {
        switched++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.warn(`[EnforcePriority] Manga ${row.id} apply failed: ${err.message}`);
    }
  }
  return { checked, switched, skipped, failed };
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

  const userId        = req.user?.id || null;
  const session       = getUserAniList(db, userId);
  const token         = session?.anilist_token   || null;
  const anilistUserId = session?.anilist_user_id || null;
  if (!token || !anilistUserId) return res.status(401).json({ error: 'Not logged in to AniList' });

  const manga = db.prepare('SELECT anilist_id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga)            return res.status(404).json({ error: 'Manga not found' });
  if (!manga.anilist_id) return res.status(400).json({ error: 'Manga has no AniList link' });

  const { chapters, volumes, status, score } = req.body;

  // Build only the fields the caller provided
  const progressArg = {};
  if (chapters !== undefined && chapters !== null) progressArg.chapters = Math.max(0, parseInt(chapters, 10));
  if (volumes  !== undefined && volumes  !== null) progressArg.volumes  = Math.max(0, parseInt(volumes,  10));
  if (score    !== undefined && score    !== null) progressArg.score    = Math.min(10, Math.max(0, parseFloat(score)));

  // Fetch current entry to preserve existing status when only progress changes.
  // The user-list cache is fine to consult here — if it's fresh, we trust it.
  let existing;
  const cached = getCachedListEntry(db, userId, manga.anilist_id);
  if (cached) {
    existing = cached.entry;
  } else {
    existing = await getMediaListEntry(token, anilistUserId, manga.anilist_id).catch(() => null);
    setCachedListEntry(db, userId, manga.anilist_id, existing);
  }
  const resolvedStatus = status || existing?.status || 'CURRENT';

  await saveMediaListEntry(token, manga.anilist_id, resolvedStatus, progressArg);

  // Re-fetch fresh entry to return to client; refresh the cache with the new value.
  const updated = await getMediaListEntry(token, anilistUserId, manga.anilist_id).catch(() => null);
  setCachedListEntry(db, userId, manga.anilist_id, updated);
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

// GET /api/mangaupdates/search?q=...&page=1 — manual MangaUpdates search
// returning up to 10 results. No auth required; the public read endpoints
// don't take a key.
router.get('/mangaupdates/search', asyncWrapper(async (req, res) => {
  const { q, page = '1' } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'q parameter is required' });

  const results = await searchMangaUpdates(q.trim(), parseInt(page, 10));
  res.json({ data: results });
}));

// POST /api/manga/:id/apply-mangaupdates-metadata — apply a specific
// MangaUpdates entry by series_id (selected via the manual search modal).
router.post('/manga/:id/apply-mangaupdates-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { mangaupdates_id } = req.body;
  if (!mangaupdates_id) return res.status(400).json({ error: 'mangaupdates_id is required' });

  const result = await fetchByMangaUpdatesId(Number(mangaupdates_id));
  if (!result) return res.status(404).json({ error: 'Entry not found on MangaUpdates' });

  await applyMetadataToManga(db, manga, result, 'mangaupdates');

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({ data: { ...updated, genres: safeJsonParse(updated.genres, []) } });
}));

// POST /api/manga/:id/refresh-mangaupdates-metadata — auto-fetch from
// MangaUpdates by title. Returns { found: false } when there's no match.
router.post('/manga/:id/refresh-mangaupdates-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const result = await fetchFromMangaUpdates(manga.title);

  if (!result) {
    return res.json({ found: false, message: 'No match found on MangaUpdates for this title.' });
  }

  await applyMetadataToManga(db, manga, result, 'mangaupdates');

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

// MAL is REST and has no aliased / batch endpoint, so the bulk loop hands a
// chunk of titles to `fetchBatchFromMAL` / `fetchBatchByMALIds` which run a
// small concurrency pool internally (see myanimelist.js). The chunk size is a
// scheduling unit — DB writes flush after each chunk so progress is durable
// even on a long-running bulk pull. 30 keeps each chunk to ~10 s of work at
// the ~3 req/sec sustained throughput.
const MAL_CHUNK_SIZE = 30;

// MangaUpdates is also REST without a batch endpoint; same pattern as MAL.
// The internal concurrency pool inside `mangaupdates.js` paces ~3 req/sec
// total. 30-per-chunk keeps the per-chunk wall clock comparable to MAL.
const MU_CHUNK_SIZE = 30;

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
// Body: { source: 'anilist' | 'myanimelist' | 'mangaupdates' | 'doujinshi' }
//   (defaults to anilist)
//
// Per-manga behaviour:
//
//   • If the manga already has the source's linkage ID
//     (anilist_id / mal_id / mangaupdates_id / doujinshi_id), the existing
//     record is **refreshed by ID** — no search, no ambiguity. Fields are
//     overwritten with the authoritative current data from the source. For
//     local-source manga (`metadata_source = 'local'`) only the linkage ID
//     is rewritten; the user's own metadata fields and cover are preserved.
//
//   • Otherwise, the title is **searched**. The folder-derived title runs
//     through the shared `cleanSearchTitle` helper to strip release-group
//     brackets, volume / chapter markers, year ranges, and quality tags
//     (e.g. "Fruits Basket Another (2018-2022) (Digital) (1r0n)" →
//     "Fruits Basket Another"), giving every source's search a much better
//     chance of matching.
//
// `last_metadata_fetch_attempt_at` is still stamped so the *automatic*
// post-scan metadata fetch can honour a cooldown. The bulk endpoint itself
// no longer respects the cooldown — the user explicitly asked for a refresh.
router.post('/libraries/:id/bulk-metadata', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const VALID_SOURCES = new Set(['anilist', 'myanimelist', 'mangaupdates', 'doujinshi']);
  const source = VALID_SOURCES.has(req.body?.source) ? req.body.source : 'anilist';

  const allManga = db.prepare(
    `SELECT id, title, metadata_source, anilist_id, mal_id, mangaupdates_id, doujinshi_id,
            anilist_cover, mal_cover, mangaupdates_cover,
            anilist_score, mal_score, mangaupdates_score, local_score
     FROM manga WHERE library_id = ?`
  ).all(library.id);
  const totalCount = allManga.length;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Split into refresh (existing linkage for this source) vs search (no link).
  function linkIdFor(m) {
    if (source === 'anilist')      return m.anilist_id;
    if (source === 'myanimelist')  return m.mal_id;
    if (source === 'mangaupdates') return m.mangaupdates_id;
    if (source === 'doujinshi')    return m.doujinshi_id;
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
  // doesn't trigger an avoidable 429. MAL and MangaUpdates have no
  // published limits — community usage and MU's own acceptable use policy
  // settle on ~1 req/sec for sequential paths. Doujinshi.info stays at
  // the previous 500 ms.
  function delayMsFor(src) {
    if (src === 'anilist')      return anilistRecommendedDelayMs();
    if (src === 'myanimelist')  return MAL_REQUEST_INTERVAL_MS;
    if (src === 'mangaupdates') return MU_REQUEST_INTERVAL_MS;
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
  } else if (source === 'myanimelist' && toRefresh.length > 0) {
    // MAL has no batch endpoint; `fetchBatchByMALIds` runs a concurrency
    // pool internally and paces itself via the shared 429 cooldown. Per-item
    // lookup failures resolve to null in `results` (handled inside
    // applyRefreshResult). Per-item DB errors are caught here so one bad row
    // doesn't abort the rest of the chunk.
    for (let i = 0; i < toRefresh.length; i += MAL_CHUNK_SIZE) {
      const chunk = toRefresh.slice(i, i + MAL_CHUNK_SIZE);
      const results = await fetchBatchByMALIds(
        chunk.map(m => m.mal_id), malClientId
      );
      for (let j = 0; j < chunk.length; j++) {
        try {
          await applyRefreshResult(chunk[j], results[j]);
        } catch (err) {
          counters.errors++;
          const n = progressN();
          console.warn(
            `[BulkMetadata][myanimelist] (${n}/${totalToDo}) Apply error for "${chunk[j].title}": ${err.message}`
          );
        }
      }
      markAttempted(db, chunk.map(m => m.id), nowSeconds);
    }
  } else if (source === 'mangaupdates' && toRefresh.length > 0) {
    // Same shape as the MAL branch — MangaUpdates also has no batch endpoint
    // and `fetchBatchByMangaUpdatesIds` runs a bounded concurrency pool with
    // a shared 429/503 cooldown.
    for (let i = 0; i < toRefresh.length; i += MU_CHUNK_SIZE) {
      const chunk = toRefresh.slice(i, i + MU_CHUNK_SIZE);
      const results = await fetchBatchByMangaUpdatesIds(
        chunk.map(m => m.mangaupdates_id)
      );
      for (let j = 0; j < chunk.length; j++) {
        try {
          await applyRefreshResult(chunk[j], results[j]);
        } catch (err) {
          counters.errors++;
          const n = progressN();
          console.warn(
            `[BulkMetadata][mangaupdates] (${n}/${totalToDo}) Apply error for "${chunk[j].title}": ${err.message}`
          );
        }
      }
      markAttempted(db, chunk.map(m => m.id), nowSeconds);
    }
  } else if (toRefresh.length > 0) {
    // Doujinshi.info — sequential by design (server is the bottleneck).
    for (const m of toRefresh) {
      try {
        const result = await fetchByDoujinshiSlug(m.doujinshi_id, doujinshiToken);
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
  } else if (source === 'myanimelist' && toSearch.length > 0) {
    for (let i = 0; i < toSearch.length; i += MAL_CHUNK_SIZE) {
      const chunk = toSearch.slice(i, i + MAL_CHUNK_SIZE);
      const results = await fetchBatchFromMAL(
        chunk.map(m => m.title), malClientId
      );
      for (let j = 0; j < chunk.length; j++) {
        try {
          await applySearchResult(chunk[j], results[j]);
        } catch (err) {
          counters.errors++;
          const n = progressN();
          console.warn(
            `[BulkMetadata][myanimelist] (${n}/${totalToDo}) Apply error for "${chunk[j].title}": ${err.message}`
          );
        }
      }
      markAttempted(db, chunk.map(m => m.id), nowSeconds);
    }
  } else if (source === 'mangaupdates' && toSearch.length > 0) {
    for (let i = 0; i < toSearch.length; i += MU_CHUNK_SIZE) {
      const chunk = toSearch.slice(i, i + MU_CHUNK_SIZE);
      const results = await fetchBatchFromMangaUpdates(chunk.map(m => m.title));
      for (let j = 0; j < chunk.length; j++) {
        try {
          await applySearchResult(chunk[j], results[j]);
        } catch (err) {
          counters.errors++;
          const n = progressN();
          console.warn(
            `[BulkMetadata][mangaupdates] (${n}/${totalToDo}) Apply error for "${chunk[j].title}": ${err.message}`
          );
        }
      }
      markAttempted(db, chunk.map(m => m.id), nowSeconds);
    }
  } else if (toSearch.length > 0) {
    for (const m of toSearch) {
      try {
        const result = await fetchFromDoujinshi(m.title, doujinshiToken);
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
  const title           = remote?.title           ?? manga.title;
  const author          = remote?.author          ?? manga.author;
  const description     = remote?.description     ?? manga.description;
  const year            = remote?.year            ?? manga.year;
  // Top-level `score` is always the stored average of every available rating
  // (NOT the single exported source's score), so the importer keeps the same
  // aggregate. The per-source breakdown rides in `ratings` below.
  const score           = manga.score;
  const status          = remote?.status          ?? manga.status;
  const anilist_id      = remote?.anilist_id      ?? manga.anilist_id;
  const mal_id          = remote?.mal_id          ?? manga.mal_id;
  const mangaupdates_id = remote?.mangaupdates_id ?? manga.mangaupdates_id;
  const doujinshi_id    = remote?.doujinshi_id    ?? manga.doujinshi_id;
  const metadata_source = remote?.source          ?? manga.metadata_source;

  // Every provider rating the manga has, regardless of which source is being
  // exported — exporting AniList metadata still carries the MAL rating, etc.
  // Read straight off the DB columns, which the apply path keeps authoritative.
  const ratings = {};
  if (manga.anilist_score      != null) ratings.anilist      = manga.anilist_score;
  if (manga.mal_score          != null) ratings.myanimelist  = manga.mal_score;
  if (manga.mangaupdates_score != null) ratings.mangaupdates = manga.mangaupdates_score;

  return {
    title,
    ...(author      ? { author }      : {}),
    ...(description ? { description } : {}),
    ...(genres && genres.length ? { genres } : {}),
    ...(year   ? { year }   : {}),
    ...(score  ? { score }  : {}),
    ...(Object.keys(ratings).length ? { ratings } : {}),
    ...(status ? { status } : {}),
    ...(anilist_id      ? { anilist_id }      : {}),
    ...(mal_id          ? { mal_id }          : {}),
    ...(mangaupdates_id ? { mangaupdates_id } : {}),
    ...(doujinshi_id    ? { doujinshi_id }    : {}),
    metadata_source,
    exported_at: new Date().toISOString(),
  };
}

// Resolve the exportable record for a manga *without ever pinging AniList,
// MAL, or MangaUpdates*. Order of preference:
//
//   1. The local JSON cache file written every time an upstream fetch
//      succeeded (`data/metadata-cache/<source>/<id>.json`).
//   2. Nothing — the caller will fall through to `buildExportPayload(manga, null)`,
//      which uses whatever fields the DB row already has.
//
// Sources are checked in display priority (anilist > myanimelist >
// mangaupdates) so a manga linked to multiple upstreams exports the
// highest-priority cached record. Doujinshi has no JSON cache; the
// DB-backed fallback covers it.
function loadCachedRemoteForExport(manga) {
  if (manga.anilist_id) {
    const cached = getCachedMetadata('anilist', Number(manga.anilist_id));
    if (cached) return { remote: cached, source: 'anilist' };
  }
  if (manga.mal_id) {
    const cached = getCachedMetadata('myanimelist', Number(manga.mal_id));
    if (cached) return { remote: cached, source: 'myanimelist' };
  }
  if (manga.mangaupdates_id) {
    const cached = getCachedMetadata('mangaupdates', Number(manga.mangaupdates_id));
    if (cached) return { remote: cached, source: 'mangaupdates' };
  }
  return null;
}

// POST /api/libraries/:id/export-metadata — write metadata.json to each
// manga folder.
//
// Export NEVER re-pings AniList or MAL. The metadata that was previously
// pulled is what gets exported. Sources, in priority order:
//
//   1. The on-disk JSON cache (`data/metadata-cache/<source>/<id>.json`)
//      written every time the user fetched / refreshed a linkage.
//   2. The manga row itself — used when the manga's `metadata_source`
//      already points at a third-party (so the displayed fields ARE the
//      previously-fetched record), or as a final fallback for rows that
//      pre-date the JSON cache.
//
// Per-manga behaviour:
//   • If a JSON cache file exists for any linkage, write that — even when
//     the manga currently displays local fields. The cache is the canonical
//     "previously pulled" record.
//   • Otherwise, if `metadata_source` is one of the third-party tags or the
//     row carries third-party fields, write the DB-stored fields verbatim.
//   • Otherwise (no link AND `metadata_source` is 'none' or 'local' with
//     no cache), skip — there's nothing third-party to export.
//
// The DB row itself is never touched; only the on-disk sidecar is written.
router.post('/libraries/:id/export-metadata', requireAdmin, asyncWrapper(async (req, res) => {
  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const totalCount = db.prepare('SELECT COUNT(*) AS n FROM manga WHERE library_id = ?').get(library.id).n;
  const allManga   = db.prepare('SELECT * FROM manga WHERE library_id = ?').all(library.id);

  let exported               = 0;
  let exportedLocal          = 0; // local-displayed manga had its sidecar replaced
  let skipped                = 0;
  let writeErrors            = 0;

  for (const manga of allManga) {
    const hasThirdPartyLink = !!(manga.anilist_id || manga.mal_id || manga.mangaupdates_id || manga.doujinshi_id);

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
        const cached = loadCachedRemoteForExport(manga);
        if (cached) {
          payload = buildExportPayload(manga, cached.remote);
          usedRemote = true;
        }
      }

      if (!payload) {
        // Fallback: write whatever the DB has. Covers (a) rows whose linkage
        // pre-dates the JSON cache and (b) third-party-sourced rows where
        // the DB already holds the previously-pulled record. We still skip
        // when there is genuinely nothing third-party in the DB.
        if (!hasThirdPartyLink &&
            !['anilist', 'myanimelist', 'mangaupdates', 'doujinshi'].includes(manga.metadata_source)) {
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
    `skipped ${skipped}, ${writeErrors} write errors. (no upstream pings)`
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
// Export NEVER re-pings AniList or MAL. It always reads the previously-pulled
// record — either from the on-disk JSON cache or from the manga row.
//
// • Per-source mode (`source` provided) — emit THAT specific source's
//   previously-pulled record. Lookup order:
//     1. `data/metadata-cache/<source>/<id>.json` (written on every fetch)
//     2. The manga row, if `metadata_source` matches the requested source
//   If neither exists, returns 409 with a hint to refresh that source first.
// • Auto mode (no `source`) — emit whichever upstream record is available
//   in the cache (AniList preferred over MAL), or the DB row if no cache.
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
    anilist:      'anilist_id',
    myanimelist:  'mal_id',
    mangaupdates: 'mangaupdates_id',
    doujinshi:    'doujinshi_id',
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

    // 1. Cache file (AniList, MAL, and MangaUpdates have one; doujinshi
    //    falls through to the DB).
    let remote = null;
    if (source === 'anilist' || source === 'myanimelist' || source === 'mangaupdates') {
      const cached = getCachedMetadata(source, Number(linkId));
      if (cached) remote = cached;
    }

    // 2. DB fallback when the manga's displayed source matches the request.
    //    The `manga` row already holds the previously-pulled record in that
    //    case, so we can build the payload directly from it.
    if (!remote && manga.metadata_source === source) {
      const payload = buildExportPayload(manga, null);
      const outPath = path.join(manga.path, 'metadata.json');
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
      console.log(
        `[ExportMetadata] Wrote metadata.json for "${manga.title}" ` +
        `(per-source ${source}, from DB; no upstream ping)`
      );
      return res.json({ data: { path: outPath, source } });
    }

    if (!remote) {
      return res.status(409).json({
        error: `No previously-pulled ${source} metadata found for this manga. Refresh the ${source} linkage first; export will not re-ping ${source}.`,
      });
    }

    // Spread `source` into `remote` so buildExportPayload's `remote.source`
    // branch fires — the exported `metadata_source` then reflects the source
    // whose cached record we used, not the manga's currently displayed source.
    const payload = buildExportPayload(manga, { ...remote, source });
    const outPath = path.join(manga.path, 'metadata.json');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

    console.log(
      `[ExportMetadata] Wrote metadata.json for "${manga.title}" ` +
      `(per-source ${source}, from cache; no upstream ping)`
    );
    return res.json({ data: { path: outPath, source } });
  }

  // ── Auto / priority-ordered export (cache → DB; no upstream) ─────────────
  const hasThirdPartyLink = !!(manga.anilist_id || manga.mal_id || manga.mangaupdates_id || manga.doujinshi_id);
  const hasThirdPartyFields = ['anilist', 'myanimelist', 'mangaupdates', 'doujinshi'].includes(manga.metadata_source);

  if (!hasThirdPartyLink && !hasThirdPartyFields) {
    return res.status(400).json({ error: 'This manga has no linked metadata to export.' });
  }

  const cached = hasThirdPartyLink ? loadCachedRemoteForExport(manga) : null;
  const remote = cached?.remote || null;

  const payload = buildExportPayload(manga, remote);
  const outPath = path.join(manga.path, 'metadata.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(
    `[ExportMetadata] Wrote metadata.json for "${manga.title}" ` +
    `(source=${manga.metadata_source}${remote ? ` → cache=${cached.source}` : ' → DB only'}; no upstream ping)`
  );
  res.json({ data: { path: outPath } });
}));

// POST /api/manga/:id/reset-metadata — break external linkage and clear sourced metadata fields
// Body: { source?: 'anilist' | 'myanimelist' | 'mangaupdates' | 'doujinshi' }
//   omitted → full reset: clears all IDs, metadata fields, sets metadata_source to 'none'
//   given  → break only that source's linkage:
//            - always NULLs the corresponding *_id (and source cover column, if any)
//            - when metadata_source matches source AND another linked source
//              exists: re-fetches the next-priority remaining source
//              (anilist > mal > mangaupdates > doujinshi) and switches the
//              displayed title/description/cover/etc. to that source.
//            - when metadata_source matches source AND no other linkage
//              exists: clears displayed fields and sets metadata_source to
//              'none'.
//            - when metadata_source is 'local' or another third-party that
//              isn't the one being broken: preserves displayed fields so the
//              active source stays in place.
router.post('/manga/:id/reset-metadata', asyncWrapper(async (req, res) => {
  const db = getDb();
  const manga = db.prepare('SELECT * FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  const { source } = req.body || {};
  const SOURCE_MAP = {
    anilist:      { idField: 'anilist_id',      coverField: 'anilist_cover',      scoreField: 'anilist_score'      },
    myanimelist:  { idField: 'mal_id',          coverField: 'mal_cover',          scoreField: 'mal_score'          },
    mangaupdates: { idField: 'mangaupdates_id', coverField: 'mangaupdates_cover', scoreField: 'mangaupdates_score' },
    doujinshi:    { idField: 'doujinshi_id',    coverField: null,                 scoreField: null                 },
  };

  if (source !== undefined) {
    if (!SOURCE_MAP[source]) return res.status(400).json({ error: 'Invalid source' });
    const { idField, coverField, scoreField } = SOURCE_MAP[source];
    const fullReset = manga.metadata_source === source;

    if (fullReset) {
      // Step 1: NULL the broken source's ID/cover/rating and put the row in
      // the 'none' state. This commits unconditionally so the linkage really
      // is broken even if every fallback fetch below fails. Other sources'
      // rating columns are left intact so the fallback's average can still
      // include them.
      db.prepare(`
        UPDATE manga SET
          ${idField}                     = NULL,
          ${coverField ? `${coverField} = NULL,` : ''}
          ${scoreField ? `${scoreField} = NULL,` : ''}
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

      // Step 2: try the next-priority remaining linkage. The helper reads
      // the post-reset row, so candidate IDs reflect the NULL we just
      // wrote, and any fetch that succeeds overwrites display fields
      // (and recomputes the average score from the surviving rating
      // columns) because metadata_source='none' has the lowest priority.
      await applyFallbackMetadata(db, manga.id, source);

      // Step 1 left `score` NULL but kept the other sources' rating columns.
      // If the fallback applied, it already recomputed `score`; if it didn't
      // (no other linkage, or the lookup failed), recompute here so a surviving
      // rating column can't leave a chip showing while the sort score is NULL.
      recomputeAggregateScore(db, manga.id);
    } else {
      // Breaking a non-displayed source: drop its linkage/cover/rating, then
      // recompute the average from whatever rating columns survive.
      db.prepare(`
        UPDATE manga SET
          ${idField}                     = NULL,
          ${coverField ? `${coverField} = NULL,` : ''}
          ${scoreField ? `${scoreField} = NULL,` : ''}
          updated_at                     = unixepoch()
        WHERE id = ?
      `).run(manga.id);
      recomputeAggregateScore(db, manga.id);
    }
  } else {
    db.prepare(`
      UPDATE manga SET
        anilist_id                     = NULL,
        mal_id                         = NULL,
        mangaupdates_id                = NULL,
        doujinshi_id                   = NULL,
        metadata_source                = 'none',
        description                    = NULL,
        status                         = NULL,
        year                           = NULL,
        genres                         = NULL,
        score                          = NULL,
        anilist_score                  = NULL,
        mal_score                      = NULL,
        mangaupdates_score             = NULL,
        local_score                    = NULL,
        author                         = NULL,
        last_metadata_fetch_attempt_at = NULL,
        updated_at                     = unixepoch()
      WHERE id = ?
    `).run(manga.id);
  }

  const updated = db.prepare('SELECT * FROM manga WHERE id = ?').get(manga.id);
  res.json({ data: { ...updated, genres: safeJsonParse(updated.genres, []) } });
}));

// POST /api/libraries/:id/reset-metadata — wipe ALL third-party metadata for
// every manga in a library and delete any local metadata JSON sidecars saved
// inside their folders. Per-manga effect mirrors the full-reset branch of
// POST /manga/:id/reset-metadata, repeated for every title in the library.
//
// What gets cleared per manga:
//   • DB columns: every *_id linkage, every sourced field (description,
//     status, year, genres, score, author), metadata_source -> 'none',
//     last_metadata_fetch_attempt_at -> NULL.
//   • Title is reverted to the cleaned folder name (same rule the scanner
//     uses on first ingest), since titles can have been overwritten by a
//     third-party fetch.
//   • Cover: third-party cover-filename pointers (anilist/mal/mangaupdates/
//     doujinshi) are NULLed and `cover_user_set` is reset, then the active
//     thumbnail is rebuilt from `original_cover` (the scanner-generated
//     first-page thumbnail). When `original_cover` is missing, we
//     regenerate from the lowest-numbered chapter's first page on the fly.
//   • On-disk: the metadata-cache files keyed by each linkage id
//     (`data/metadata-cache/<source>/<id>.json`).
//   • Local sidecars: any `metadata.json` / `info.json` / `gallery.json` /
//     `comic.json` / `book.json` at the top of the manga folder, plus any
//     `<image>.<ext>.json` image-sidecar files at that level. We only delete
//     files the local-metadata scanner would itself have picked up — we
//     deliberately do NOT walk into chapter subfolders or wipe unknown JSON.
//
// Files on disk other than the JSON sidecars are not touched. Cover-image
// files for other sources stay on disk (orphaned but harmless).
router.post('/libraries/:id/reset-metadata', requireAdmin, asyncWrapper(async (req, res) => {
  const { cleanTitle } = require('../scanner/libraryScanner');
  const { generateThumbnail } = require('../scanner/thumbnailGenerator');
  const { thumbnailPath: thumbPathFor, ensureShardDir: ensureThumbShard } = require('../scanner/thumbnailPaths');

  const db = getDb();
  const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!library) return res.status(404).json({ error: 'Library not found' });

  const allManga = db.prepare(
    `SELECT id, path, folder_name, original_cover,
            anilist_id, mal_id, mangaupdates_id, doujinshi_id
       FROM manga WHERE library_id = ?`
  ).all(library.id);

  const IMAGE_SIDECAR_RE = /\.(jpe?g|png|webp|avif|gif)\.json$/i;
  const EXPLICIT_NAMES = new Set([
    'metadata.json', 'info.json', 'gallery.json', 'comic.json', 'book.json',
  ]);

  const cacheDir = path.join(config.DATA_PATH, 'metadata-cache');
  const cacheTargets = [
    { source: 'anilist',      column: 'anilist_id'      },
    { source: 'myanimelist',  column: 'mal_id'          },
    { source: 'mangaupdates', column: 'mangaupdates_id' },
    { source: 'doujinshi',    column: 'doujinshi_id'    },
  ];

  let titlesReset        = 0;
  let jsonFilesDeleted   = 0;
  let cacheFilesDeleted  = 0;
  let thumbnailsRebuilt  = 0;
  let thumbnailsRegenerated = 0;

  // The DB update also flips title back to cleanTitle(folder_name) and clears
  // the third-party cover pointers + user-set flag so the cover-resolver below
  // is free to fall back to original_cover.
  const updateStmt = db.prepare(`
    UPDATE manga SET
      title                          = ?,
      anilist_id                     = NULL,
      mal_id                         = NULL,
      mangaupdates_id                = NULL,
      doujinshi_id                   = NULL,
      anilist_cover                  = NULL,
      mal_cover                      = NULL,
      mangaupdates_cover             = NULL,
      doujinshi_cover                = NULL,
      cover_user_set                 = 0,
      metadata_source                = 'none',
      description                    = NULL,
      status                         = NULL,
      year                           = NULL,
      genres                         = NULL,
      score                          = NULL,
      anilist_score                  = NULL,
      mal_score                      = NULL,
      mangaupdates_score             = NULL,
      local_score                    = NULL,
      author                         = NULL,
      last_metadata_fetch_attempt_at = NULL,
      updated_at                     = unixepoch()
    WHERE id = ?
  `);

  for (const manga of allManga) {
    // Per-manga JSON sidecars at the top of the folder.
    if (manga.path) {
      let entries = [];
      try { entries = fs.readdirSync(manga.path); } catch { /* unreadable */ }
      for (const name of entries) {
        const lower = name.toLowerCase();
        if (EXPLICIT_NAMES.has(lower) || IMAGE_SIDECAR_RE.test(lower)) {
          try {
            fs.unlinkSync(path.join(manga.path, name));
            jsonFilesDeleted++;
          } catch (err) {
            console.warn(`[ResetMetadata] Failed to delete ${name} in "${manga.path}": ${err.message}`);
          }
        }
      }
    }

    // Per-source metadata-cache files.
    for (const { source, column } of cacheTargets) {
      const id = manga[column];
      if (id === null || id === undefined) continue;
      const file = path.join(cacheDir, source, `${id}.json`);
      try {
        fs.unlinkSync(file);
        cacheFilesDeleted++;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`[ResetMetadata] Failed to delete cache ${source}/${id}.json: ${err.message}`);
        }
      }
    }

    const newTitle = cleanTitle(manga.folder_name || '') || manga.folder_name || 'Untitled';
    updateStmt.run(newTitle, manga.id);
    titlesReset++;

    // Rebuild the active thumbnail. Preferred path: copy from the
    // scanner-generated original. Fallback: regenerate from the lowest-
    // numbered chapter's first page when the original is missing.
    const activeName = `${manga.id}.webp`;
    const activePath = thumbPathFor(activeName);
    let restoredFromOriginal = false;

    if (manga.original_cover) {
      const originalPath = thumbPathFor(manga.original_cover);
      try {
        if (fs.existsSync(originalPath)) {
          ensureThumbShard(activeName);
          fs.copyFileSync(originalPath, activePath);
          restoredFromOriginal = true;
          thumbnailsRebuilt++;
        }
      } catch (err) {
        console.warn(`[ResetMetadata] Failed to restore original cover for manga ${manga.id}: ${err.message}`);
      }
    }

    if (!restoredFromOriginal) {
      // Regenerate from disk: take the first page of the lowest-numbered
      // chapter (folder name fallback when no chapter has a parsed number).
      const firstChapter = db.prepare(`
        SELECT c.id, c.path AS chapter_path, c.type
          FROM chapters c
         WHERE c.manga_id = ?
         ORDER BY (CASE WHEN c.number IS NULL THEN 1 ELSE 0 END) ASC,
                  c.number ASC,
                  c.folder_name ASC
         LIMIT 1
      `).get(manga.id);

      if (firstChapter) {
        const firstPage = db.prepare(`
          SELECT path FROM pages WHERE chapter_id = ?
           ORDER BY page_index ASC LIMIT 1
        `).get(firstChapter.id);

        if (firstPage) {
          try {
            const out = await generateThumbnail(
              { type: firstChapter.type, chapterPath: firstChapter.chapter_path, entry: firstPage.path },
              manga.id,
            );
            if (out) {
              // Persist as the new "original" so future resets are cheap.
              const originalName = `${manga.id}_original.webp`;
              try {
                ensureThumbShard(originalName);
                fs.copyFileSync(out, thumbPathFor(originalName));
                db.prepare('UPDATE manga SET original_cover = ? WHERE id = ?')
                  .run(originalName, manga.id);
              } catch (err) {
                console.warn(`[ResetMetadata] Failed to persist new original_cover for manga ${manga.id}: ${err.message}`);
              }
              thumbnailsRegenerated++;
            }
          } catch (err) {
            console.warn(`[ResetMetadata] Thumbnail regen failed for manga ${manga.id}: ${err.message}`);
          }
        }
      }
    }

    db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?').run(activeName, manga.id);
  }

  console.log(
    `[ResetMetadata] "${library.name}": reset ${titlesReset} titles, ` +
    `deleted ${jsonFilesDeleted} local JSON sidecar(s), ` +
    `${cacheFilesDeleted} metadata-cache file(s); ` +
    `restored ${thumbnailsRebuilt} thumbnails from original, ` +
    `regenerated ${thumbnailsRegenerated} from first page.`
  );

  res.json({
    data: {
      total: allManga.length,
      titles_reset: titlesReset,
      json_files_deleted: jsonFilesDeleted,
      cache_files_deleted: cacheFilesDeleted,
      thumbnails_restored: thumbnailsRebuilt,
      thumbnails_regenerated: thumbnailsRegenerated,
    },
  });
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
  const manga = db.prepare('SELECT id, anilist_cover, mal_cover, mangaupdates_cover, doujinshi_cover, original_cover, cover_image, cover_user_set FROM manga WHERE id = ?').get(req.params.id);
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
      anilist_cover:       manga.anilist_cover       || null,
      mal_cover:           manga.mal_cover           || null,
      mangaupdates_cover:  manga.mangaupdates_cover  || null,
      doujinshi_cover:     manga.doujinshi_cover     || null,
      original_cover:      manga.original_cover      || null,
      cover_user_set:      !!manga.cover_user_set,
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

  // Mark this as a manual user choice. The Reset Thumbnails op (and the
  // post-scan reinforcement that uses the same op) is the only thing that
  // will override it — the metadata-apply path will leave it alone, even
  // if the user later applies AniList on top.
  db.prepare('UPDATE manga SET cover_image = ?, cover_user_set = 1 WHERE id = ?')
    .run(`${manga.id}.webp`, manga.id);

  res.json({ data: { cover_image: `${manga.id}.webp` } });
}));

// GET /api/manga/:id/anilist-status — fetch the logged-in user's list entry for this manga
router.get('/manga/:id/anilist-status', asyncWrapper(async (req, res) => {
  const db = getDb();

  const userId        = req.user?.id || null;
  const session       = getUserAniList(db, userId);
  const token         = session?.anilist_token   || null;
  const anilistUserId = session?.anilist_user_id || null;

  if (!token || !anilistUserId) {
    return res.json({ data: { logged_in: false } });
  }

  const manga = db.prepare('SELECT anilist_id FROM manga WHERE id = ?').get(req.params.id);
  if (!manga) return res.status(404).json({ error: 'Manga not found' });

  if (!manga.anilist_id) {
    return res.json({ data: { logged_in: true, linked: false } });
  }

  // Per-user cache keeps repeated page opens from each triggering an
  // AniList ping. Cache miss / stale -> one fetch, then we populate.
  let entry;
  const cached = getCachedListEntry(db, userId, manga.anilist_id);
  if (cached) {
    entry = cached.entry;
  } else {
    entry = await getMediaListEntry(token, anilistUserId, manga.anilist_id).catch(() => null);
    setCachedListEntry(db, userId, manga.anilist_id, entry);
  }

  res.json({
    data: {
      logged_in:   true,
      linked:      true,
      anilist_id:  manga.anilist_id,
      entry,          // null = not on user's list yet
    },
  });
}));

// Express-router as the default shape, with helper functions attached for
// non-route consumers (the scanner calls enforceMetadataPriorityForLibrary
// at end-of-scan, before cover priority is reinforced).
module.exports = router;
module.exports.applyFallbackMetadata = applyFallbackMetadata;
module.exports.enforceMetadataPriorityForLibrary = enforceMetadataPriorityForLibrary;
