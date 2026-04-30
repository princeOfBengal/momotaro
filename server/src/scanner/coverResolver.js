const fs = require('fs');
const { thumbnailPath, ensureShardDir } = require('./thumbnailPaths');

// Active-cover priority — highest first. The active cover is independent
// of `metadata_source` (which controls displayed text fields): even a
// manga whose displayed metadata comes from a local JSON sidecar should
// still pick its visible cover by this order, falling back to the scanner-
// generated original only when no third-party cover is on disk.
//
//   AniList > MyAnimeList > MangaUpdates > Doujinshi.info > original scan
//
// "User-set" covers (chapter pages, manual picks, set-thumbnail-from-file)
// short-circuit the priority — see `reinforceActiveCover` below.
const COVER_PRIORITY_FIELDS = [
  'anilist_cover',
  'mal_cover',
  'mangaupdates_cover',
  'doujinshi_cover',
  'original_cover',
];

/**
 * Walk the priority list and return the first source-specific filename
 * that (a) is recorded on the manga row and (b) actually exists on disk.
 * Returns null when nothing usable is available.
 */
function pickPriorityCoverFilename(manga) {
  for (const field of COVER_PRIORITY_FIELDS) {
    const filename = manga[field];
    if (!filename) continue;
    try {
      if (fs.existsSync(thumbnailPath(filename))) return { filename, field };
    } catch {
      // unreadable shard dir → treat as missing
    }
  }
  return null;
}

/**
 * Make sure the active cover (`<mangaId>.webp`) for a single manga reflects
 * the priority order. No-op when:
 *
 *   • The user has manually picked a cover (`cover_user_set = 1`) AND we
 *     weren't asked to `force` (the Reset Thumbnails op forces).
 *   • No source-specific or original cover file exists on disk.
 *
 * Returns one of:
 *   { changed: false }                              — nothing to do
 *   { changed: true,  source: '<priority field>' }  — active cover updated
 *   { changed: false, reason: 'user_set' }          — preserved user choice
 *
 * The caller is responsible for opening the DB; this helper does the row
 * read and the file copy itself so it can be invoked from anywhere
 * (admin endpoint, scanner completion, post-metadata-apply).
 */
function reinforceActiveCover(db, mangaId, { force = false } = {}) {
  const row = db.prepare(`
    SELECT id, cover_user_set, cover_image,
           anilist_cover, mal_cover, mangaupdates_cover, doujinshi_cover, original_cover
    FROM manga WHERE id = ?
  `).get(mangaId);
  if (!row) return { changed: false, reason: 'not_found' };

  if (row.cover_user_set && !force) {
    return { changed: false, reason: 'user_set' };
  }

  const pick = pickPriorityCoverFilename(row);
  if (!pick) return { changed: false, reason: 'no_source' };

  const activeName = `${mangaId}.webp`;
  try {
    ensureShardDir(activeName);
    fs.copyFileSync(thumbnailPath(pick.filename), thumbnailPath(activeName));
  } catch (err) {
    console.warn(`[Cover] Reinforce failed for manga ${mangaId} (target=${pick.filename}): ${err.message}`);
    return { changed: false, reason: 'copy_failed' };
  }

  // Always normalise cover_image to the active filename. The file content
  // changes, but the DB pointer stays canonical so other parts of the app
  // (URL builder, cache-bust query) only have to deal with one name.
  if (force) {
    db.prepare('UPDATE manga SET cover_image = ?, cover_user_set = 0 WHERE id = ?')
      .run(activeName, mangaId);
  } else if (row.cover_image !== activeName) {
    db.prepare('UPDATE manga SET cover_image = ? WHERE id = ?')
      .run(activeName, mangaId);
  }

  return { changed: true, source: pick.field };
}

/**
 * Run reinforceActiveCover over every manga in the DB (or one library when
 * `libraryId` is given). Used by:
 *
 *   • `POST /api/admin/reset-thumbnails`  (force=true; clobbers user picks)
 *   • End of `scanLibrary` / `runFullScan` (force=true; the user explicitly
 *     wants the priority reinforced after every scan).
 *
 * Returns counters: { total, changed_to_<source>, kept, errors }.
 */
function reinforceAllCovers(db, { libraryId = null, force = true } = {}) {
  const rows = libraryId
    ? db.prepare('SELECT id FROM manga WHERE library_id = ?').all(libraryId)
    : db.prepare('SELECT id FROM manga').all();

  const counters = {
    total:                 rows.length,
    changed_to_anilist:    0,
    changed_to_mal:        0,
    changed_to_mu:         0,
    changed_to_doujinshi:  0,
    changed_to_original:   0,
    kept_user:             0,
    kept_no_source:        0,
    errors:                0,
  };

  for (const r of rows) {
    try {
      const result = reinforceActiveCover(db, r.id, { force });
      if (result.changed) {
        const fieldToBucket = {
          anilist_cover:      'changed_to_anilist',
          mal_cover:          'changed_to_mal',
          mangaupdates_cover: 'changed_to_mu',
          doujinshi_cover:    'changed_to_doujinshi',
          original_cover:     'changed_to_original',
        };
        const bucket = fieldToBucket[result.source];
        if (bucket) counters[bucket]++;
      } else if (result.reason === 'user_set') {
        counters.kept_user++;
      } else if (result.reason === 'no_source') {
        counters.kept_no_source++;
      } else if (result.reason !== 'not_found') {
        counters.errors++;
      }
    } catch (err) {
      counters.errors++;
      console.warn(`[Cover] Reset error for manga ${r.id}: ${err.message}`);
    }
  }
  return counters;
}

module.exports = {
  COVER_PRIORITY_FIELDS,
  pickPriorityCoverFilename,
  reinforceActiveCover,
  reinforceAllCovers,
};
