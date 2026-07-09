const { getDb } = require('./db/database');
const { thumbnailUrl } = require('./scanner/thumbnailPaths');

// Precomputed payload for `GET /api/genres` — every distinct genre across
// visible libraries plus a representative top-rated cover per genre.
//
// Refresh strategy: the payload is built **lazily** on first request after
// server start, then kept indefinitely until an external event invalidates or
// recomputes it. The expensive part — the per-genre correlated cover lookup —
// is only paid for at those well-defined moments, not on a periodic timer.
//
// The CBZ cache auto-clear scheduler (`scanner/cbzCacheSchedule.js`) calls
// `precompute()` whenever it fires, so recomputation rides along with the
// user's existing cache-management cadence (off / daily / weekly). When
// auto-clear is off, the payload is computed once on first request and stays
// pinned for the lifetime of the process — by the user's explicit choice.
//
// `_payload === null` is the "not yet built" sentinel. An empty array is a
// real payload (a library with zero genres) and is cached as such.

let _payload = null;

function buildPayload() {
  const db = getDb();
  // The correlated subquery returns the picked manga's *id* rather than its
  // cover filename — the cover URL needs both `cover_image` and
  // `cover_updated_at` (the `?v=` cache key), and resolving them in a single
  // batched IN query afterwards is cheaper than duplicating the ordered
  // subquery per column.
  const rows = db.prepare(`
    SELECT g.genre AS genre,
           COUNT(DISTINCT m.id) AS manga_count,
           (
             SELECT m2.id
             FROM manga m2
             JOIN manga_genres g2 ON g2.manga_id = m2.id
             LEFT JOIN libraries l2 ON l2.id = m2.library_id
             WHERE g2.genre = g.genre COLLATE NOCASE
               AND (m2.library_id IS NULL OR l2.show_in_all = 1)
               AND m2.cover_image IS NOT NULL
             ORDER BY m2.score DESC NULLS LAST, m2.id ASC
             LIMIT 1
           ) AS cover_manga_id
    FROM manga_genres g
    JOIN manga m ON m.id = g.manga_id
    LEFT JOIN libraries l ON l.id = m.library_id
    WHERE (m.library_id IS NULL OR l.show_in_all = 1)
    GROUP BY g.genre COLLATE NOCASE
    ORDER BY g.genre ASC
  `).all();

  const coverIds = [...new Set(rows.map(r => r.cover_manga_id).filter(id => id != null))];
  const coversById = new Map();
  if (coverIds.length > 0) {
    const placeholders = coverIds.map(() => '?').join(',');
    for (const m of db.prepare(
      `SELECT id, cover_image, cover_updated_at FROM manga WHERE id IN (${placeholders})`
    ).all(...coverIds)) {
      coversById.set(m.id, m);
    }
  }

  return rows.map(r => {
    const cover = r.cover_manga_id != null ? coversById.get(r.cover_manga_id) : null;
    return {
      genre:       r.genre,
      manga_count: r.manga_count,
      cover_url:   cover?.cover_image ? thumbnailUrl(cover.cover_image, cover.cover_updated_at) : null,
    };
  });
}

// Synchronous read — better-sqlite3 is synchronous, so first-request lazy
// build doesn't need promise coalescing.
function getPayload() {
  if (_payload === null) {
    _payload = buildPayload();
  }
  return _payload;
}

// Eagerly rebuild and store. Invoked by the CBZ auto-clear scheduler so the
// queries run on the user-chosen maintenance schedule (daily / weekly) rather
// than on every reader's request. Errors are swallowed and logged — a failed
// recompute leaves the previous payload in place rather than nulling it.
function precompute() {
  try {
    _payload = buildPayload();
    console.log(`[Genres Cache] Precomputed ${_payload.length} genres.`);
    return true;
  } catch (err) {
    console.error('[Genres Cache] Precompute failed:', err.message);
    return false;
  }
}

// Force a lazy rebuild on the next read. Reserved for callers that know the
// data has changed but don't want to pay the build cost themselves.
function invalidate() {
  _payload = null;
}

module.exports = { getPayload, precompute, invalidate };
