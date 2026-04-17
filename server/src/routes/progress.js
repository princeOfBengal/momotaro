const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { saveMediaListEntry } = require('../metadata/anilist');
const { getDeviceSession } = require('./settings');

const router = express.Router();

// GET /api/progress/:mangaId
router.get('/progress/:mangaId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const progress = db.prepare('SELECT * FROM progress WHERE manga_id = ?').get(req.params.mangaId);
  if (!progress) return res.json({ data: null });

  res.json({
    data: {
      ...progress,
      completed_chapters: safeJsonParse(progress.completed_chapters, []),
    },
  });
}));

// PUT /api/progress/:mangaId
router.put('/progress/:mangaId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const mangaId = parseInt(req.params.mangaId, 10);
  const { chapterId, page = 0, markChapterComplete = false } = req.body;

  const existing = db.prepare('SELECT * FROM progress WHERE manga_id = ?').get(mangaId);
  let completedChapters = safeJsonParse(existing?.completed_chapters, []);

  if (markChapterComplete && chapterId && !completedChapters.includes(chapterId)) {
    completedChapters.push(chapterId);
  }

  if (!existing) {
    db.prepare(`
      INSERT INTO progress (manga_id, current_chapter_id, current_page, completed_chapters, last_read_at, updated_at)
      VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(mangaId, chapterId || null, page, JSON.stringify(completedChapters));
  } else {
    db.prepare(`
      UPDATE progress SET
        current_chapter_id = ?,
        current_page = ?,
        completed_chapters = ?,
        last_read_at = unixepoch(),
        updated_at = unixepoch()
      WHERE manga_id = ?
    `).run(chapterId || null, page, JSON.stringify(completedChapters), mangaId);
  }

  const updated = db.prepare('SELECT * FROM progress WHERE manga_id = ?').get(mangaId);
  res.json({
    data: {
      ...updated,
      completed_chapters: safeJsonParse(updated.completed_chapters, []),
    },
  });

  // Fire-and-forget AniList sync (don't block the response)
  const deviceId = req.headers['x-device-id'] || null;
  syncToAniList(db, mangaId, completedChapters, deviceId).catch(err =>
    console.warn('[AniList Sync] Failed:', err.message)
  );
}));

// PATCH /api/progress/:mangaId/chapter/:chapterId — toggle a single chapter's read status
// Body: { completed: boolean }
// When marking read: advances current_chapter_id to the next unread chapter if the marked
// chapter is at or ahead of the current position. Never moves current backwards.
router.patch('/progress/:mangaId/chapter/:chapterId', asyncWrapper(async (req, res) => {
  const db        = getDb();
  const mangaId   = parseInt(req.params.mangaId,   10);
  const chapterId = parseInt(req.params.chapterId,  10);
  const { completed } = req.body;

  const existing         = db.prepare('SELECT * FROM progress WHERE manga_id = ?').get(mangaId);
  let completedChapters  = safeJsonParse(existing?.completed_chapters, []);
  let currentChapterId   = existing?.current_chapter_id ?? null;
  let currentPage        = existing?.current_page       ?? 0;

  if (completed) {
    if (!completedChapters.includes(chapterId)) completedChapters.push(chapterId);

    // Sorted chapter list — same order as the client's sortedChapters
    const allChapters = db.prepare(`
      SELECT id FROM chapters
      WHERE manga_id = ?
      ORDER BY COALESCE(number, volume) ASC NULLS LAST, folder_name ASC
    `).all(mangaId);

    const markedIdx  = allChapters.findIndex(c => c.id === chapterId);
    const currentIdx = allChapters.findIndex(c => c.id === currentChapterId);

    // Advance current if it is null or at/behind the chapter just marked
    if (currentChapterId === null || currentIdx === -1 || currentIdx <= markedIdx) {
      const completedSet = new Set(completedChapters);
      const nextChapter  = allChapters.slice(markedIdx + 1).find(c => !completedSet.has(c.id));
      currentChapterId = nextChapter?.id ?? null;
      currentPage = 0;
    }
  } else {
    completedChapters = completedChapters.filter(id => id !== chapterId);
    // Leave current_chapter_id unchanged when unmarking
  }

  if (!existing) {
    db.prepare(`
      INSERT INTO progress (manga_id, current_chapter_id, current_page, completed_chapters, last_read_at, updated_at)
      VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(mangaId, currentChapterId, currentPage, JSON.stringify(completedChapters));
  } else {
    db.prepare(`
      UPDATE progress SET
        current_chapter_id = ?,
        current_page       = ?,
        completed_chapters = ?,
        last_read_at       = unixepoch(),
        updated_at         = unixepoch()
      WHERE manga_id = ?
    `).run(currentChapterId, currentPage, JSON.stringify(completedChapters), mangaId);
  }

  const updated = db.prepare('SELECT * FROM progress WHERE manga_id = ?').get(mangaId);
  res.json({
    data: {
      ...updated,
      completed_chapters: safeJsonParse(updated.completed_chapters, []),
    },
  });

  // Fire-and-forget AniList sync
  const deviceId = req.headers['x-device-id'] || null;
  syncToAniList(db, mangaId, completedChapters, deviceId).catch(err =>
    console.warn('[AniList Sync] Failed:', err.message)
  );
}));

// DELETE /api/progress/:mangaId
router.delete('/progress/:mangaId', asyncWrapper(async (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM progress WHERE manga_id = ?').run(req.params.mangaId);
  res.json({ message: 'Progress reset' });
}));

/**
 * Sync local reading progress to the user's AniList list.
 * Runs after the HTTP response has been sent.
 */
async function syncToAniList(db, mangaId, completedChapters, deviceId) {
  const session = getDeviceSession(db, deviceId);
  const token = session?.anilist_token;
  const userId = session?.anilist_user_id;
  if (!token || !userId) return; // Not logged in on this device — skip

  const manga = db.prepare('SELECT anilist_id, track_volumes FROM manga WHERE id = ?').get(mangaId);
  if (!manga?.anilist_id) return; // No AniList match for this manga — skip

  if (completedChapters.length === 0) return;

  const trackVolumes = manga.track_volumes === 1;

  // Find the highest completed number using the appropriate column.
  // completedChapters is an array of chapter IDs, not numbers.
  const placeholders = completedChapters.map(() => '?').join(',');
  const col = trackVolumes ? 'volume' : 'number';
  const { maxVal } = db.prepare(
    `SELECT MAX(CAST(${col} AS REAL)) AS maxVal FROM chapters WHERE id IN (${placeholders}) AND ${col} IS NOT NULL`
  ).get(...completedChapters);

  let highestNumber;
  if (maxVal != null) {
    highestNumber = Math.floor(maxVal);
  } else {
    // No numbered entries — fall back to count
    highestNumber = completedChapters.length;
  }

  const totalChapters = db.prepare('SELECT COUNT(*) FROM chapters WHERE manga_id = ?').pluck().get(mangaId);
  const status = totalChapters > 0 && completedChapters.length >= totalChapters ? 'COMPLETED' : 'CURRENT';

  const progressArg = trackVolumes
    ? { volumes: highestNumber }
    : { chapters: highestNumber };

  await saveMediaListEntry(token, manga.anilist_id, status, progressArg);
  console.log(`[AniList Sync] ${manga.anilist_id} → ${status}, ${trackVolumes ? 'volumeProgress' : 'chapterProgress'}=${highestNumber}`);
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
