const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');
const { saveMediaListEntry } = require('../metadata/anilist');
const { getUserAniList } = require('./settings');
const { safeJsonParse, csvEscape, formatUnix } = require('../utils');

const router = express.Router();

// GET /api/progress/:mangaId
router.get('/progress/:mangaId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const progress = db.prepare('SELECT * FROM progress WHERE user_id = ? AND manga_id = ?')
    .get(userId, req.params.mangaId);
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
  const userId = req.user.id;
  const mangaId = parseInt(req.params.mangaId, 10);
  const { chapterId, page = 0, markChapterComplete = false } = req.body;

  // A chapterId that isn't part of this manga (deleted since the client loaded,
  // or a cross-manga id) must not be stored as current_chapter_id or pushed
  // into completed_chapters. Validating here also turns a would-be foreign-key
  // 500 (bogus current_chapter_id) into a clean 404. Offline replays of a
  // since-deleted chapter get this 404 and are dropped by the outbox (see
  // outboxSync.js) instead of poison-pilling the queue.
  if (chapterId) {
    const owns = db.prepare('SELECT 1 FROM chapters WHERE id = ? AND manga_id = ?').pluck().get(chapterId, mangaId);
    if (!owns) return res.status(404).json({ error: 'Chapter not found for this manga' });
  }

  const existing = db.prepare('SELECT * FROM progress WHERE user_id = ? AND manga_id = ?').get(userId, mangaId);
  let completedChapters = safeJsonParse(existing?.completed_chapters, []);

  const newlyCompleted =
    markChapterComplete && chapterId && !completedChapters.includes(chapterId);
  if (newlyCompleted) {
    completedChapters.push(chapterId);
  }

  // A new chapter became the reading position — log it as a "read" event for
  // the per-user history timeline. Page-by-page saves within the same chapter
  // don't change current_chapter_id, so they don't flood the log.
  const chapterOpened = chapterId && existing?.current_chapter_id !== chapterId;

  if (!existing) {
    db.prepare(`
      INSERT INTO progress (user_id, manga_id, current_chapter_id, current_page, completed_chapters, last_read_at, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(userId, mangaId, chapterId || null, page, JSON.stringify(completedChapters));
  } else {
    db.prepare(`
      UPDATE progress SET
        current_chapter_id = ?,
        current_page = ?,
        completed_chapters = ?,
        last_read_at = unixepoch(),
        updated_at = unixepoch()
      WHERE user_id = ? AND manga_id = ?
    `).run(chapterId || null, page, JSON.stringify(completedChapters), userId, mangaId);
  }

  if (chapterOpened)  recordHistory(db, userId, mangaId, chapterId, 'read');
  if (newlyCompleted) recordHistory(db, userId, mangaId, chapterId, 'completed');

  const updated = db.prepare('SELECT * FROM progress WHERE user_id = ? AND manga_id = ?').get(userId, mangaId);
  res.json({
    data: {
      ...updated,
      completed_chapters: safeJsonParse(updated.completed_chapters, []),
    },
  });

  // Fire-and-forget AniList sync (don't block the response).
  // Only sync when a chapter was just newly completed — page-by-page progress
  // updates within an unfinished chapter must not ping AniList. Synced to the
  // AniList account linked by *this* user.
  if (newlyCompleted) {
    syncToAniList(db, mangaId, completedChapters, userId).catch(err =>
      console.warn('[AniList Sync] Failed:', err.message)
    );
  }
}));

// PATCH /api/progress/:mangaId/chapter/:chapterId — toggle a single chapter's read status
// Body: { completed: boolean }
// When marking read: advances current_chapter_id to the next unread chapter if the marked
// chapter is at or ahead of the current position. Never moves current backwards.
router.patch('/progress/:mangaId/chapter/:chapterId', asyncWrapper(async (req, res) => {
  const db        = getDb();
  const userId    = req.user.id;
  const mangaId   = parseInt(req.params.mangaId,   10);
  const chapterId = parseInt(req.params.chapterId,  10);
  const { completed } = req.body;

  // Reject a chapter that doesn't belong to this manga (deleted since the
  // client loaded, or a cross-manga id) so a stale toggle can't push a dead id
  // into completed_chapters. Offline replays for a since-deleted chapter get
  // this 404 and are dropped by the outbox rather than retried forever.
  const owns = db.prepare('SELECT 1 FROM chapters WHERE id = ? AND manga_id = ?').pluck().get(chapterId, mangaId);
  if (!owns) return res.status(404).json({ error: 'Chapter not found for this manga' });

  const existing         = db.prepare('SELECT * FROM progress WHERE user_id = ? AND manga_id = ?').get(userId, mangaId);
  let completedChapters  = safeJsonParse(existing?.completed_chapters, []);
  let currentChapterId   = existing?.current_chapter_id ?? null;
  let currentPage        = existing?.current_page       ?? 0;

  const wasCompleted    = completedChapters.includes(chapterId);
  const completionChanged = (!!completed) !== wasCompleted;

  if (completed) {
    if (!wasCompleted) completedChapters.push(chapterId);

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
      INSERT INTO progress (user_id, manga_id, current_chapter_id, current_page, completed_chapters, last_read_at, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(userId, mangaId, currentChapterId, currentPage, JSON.stringify(completedChapters));
  } else {
    db.prepare(`
      UPDATE progress SET
        current_chapter_id = ?,
        current_page       = ?,
        completed_chapters = ?,
        last_read_at       = unixepoch(),
        updated_at         = unixepoch()
      WHERE user_id = ? AND manga_id = ?
    `).run(currentChapterId, currentPage, JSON.stringify(completedChapters), userId, mangaId);
  }

  // Log a completion to the per-user history when the chapter flips to read.
  if (completionChanged && completed) recordHistory(db, userId, mangaId, chapterId, 'completed');

  const updated = db.prepare('SELECT * FROM progress WHERE user_id = ? AND manga_id = ?').get(userId, mangaId);
  res.json({
    data: {
      ...updated,
      completed_chapters: safeJsonParse(updated.completed_chapters, []),
    },
  });

  // Fire-and-forget AniList sync — only when the chapter's completion state
  // actually flipped, so a no-op toggle (e.g. marking an already-complete
  // chapter as complete) does not ping AniList.
  if (completionChanged) {
    syncToAniList(db, mangaId, completedChapters, userId).catch(err =>
      console.warn('[AniList Sync] Failed:', err.message)
    );
  }
}));

// GET /api/history — the caller's own reading-history timeline (newest first).
// Accepts `?format=csv` for a downloadable CSV scoped to the same user. The CSV
// branch ignores the `limit` cap and emits everything so an account export is
// complete; the JSON branch keeps the cap so the UI list stays bounded.
router.get('/history', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const wantCsv = req.query?.format === 'csv';

  let limit = parseInt(req.query?.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 1000) limit = 1000;

  const rows = db.prepare(`
    SELECT h.id, h.manga_id, m.title AS manga_title, m.cover_image,
           h.chapter_id, c.folder_name AS chapter_folder, c.number AS chapter_number,
           h.event, h.read_at
    FROM reading_history h
    LEFT JOIN manga m    ON m.id = h.manga_id
    LEFT JOIN chapters c ON c.id = h.chapter_id
    WHERE h.user_id = ?
    ORDER BY h.read_at DESC, h.id DESC
    ${wantCsv ? '' : 'LIMIT ?'}
  `).all(...(wantCsv ? [userId] : [userId, limit]));

  if (wantCsv) {
    const lines = [];
    lines.push(['Manga', 'Chapter', 'Event', 'Read at (UTC)'].map(csvEscape).join(','));
    for (const r of rows) {
      lines.push([
        r.manga_title || `#${r.manga_id}`,
        r.chapter_number ?? r.chapter_folder ?? '',
        r.event,
        formatUnix(r.read_at),
      ].map(csvEscape).join(','));
    }
    // UTF-8 BOM so Excel renders non-ASCII titles correctly. RFC 4180 line endings.
    const body = '﻿' + lines.join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="momotaro-reading-history-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(body);
  }
  res.json({ data: rows });
}));

// DELETE /api/history — clear the caller's own reading history.
router.delete('/history', asyncWrapper(async (req, res) => {
  const db = getDb();
  const { changes } = db.prepare('DELETE FROM reading_history WHERE user_id = ?').run(req.user.id);
  res.json({ data: { deleted: changes } });
}));

// DELETE /api/progress/:mangaId
router.delete('/progress/:mangaId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  db.prepare('DELETE FROM progress WHERE user_id = ? AND manga_id = ?').run(userId, req.params.mangaId);
  res.json({ message: 'Progress reset' });
}));

/**
 * Append a row to the per-user reading-history timeline. Best-effort — a
 * telemetry write must never fail the progress update that triggered it.
 * `event` is 'read' (a chapter became the reading position) or 'completed'.
 */
function recordHistory(db, userId, mangaId, chapterId, event) {
  try {
    db.prepare(
      'INSERT INTO reading_history (user_id, manga_id, chapter_id, event) VALUES (?, ?, ?, ?)'
    ).run(userId, mangaId, chapterId || null, event);
  } catch (err) {
    console.warn('[ReadingHistory] insert failed:', err.message);
  }
}

/**
 * Sync local reading progress to the AniList list of the Momotaro user who
 * owns this progress (`momotaroUserId`). Runs after the HTTP response is sent.
 * No-op when that user hasn't linked an AniList account.
 */
async function syncToAniList(db, mangaId, completedChapters, momotaroUserId) {
  const session = getUserAniList(db, momotaroUserId);
  const token = session?.anilist_token;
  if (!token || !session?.anilist_user_id) return; // user hasn't linked AniList — skip

  const manga = db.prepare('SELECT anilist_id, track_volumes FROM manga WHERE id = ?').get(mangaId);
  if (!manga?.anilist_id) return; // No AniList match for this manga — skip

  if (completedChapters.length === 0) return;

  const trackVolumes = manga.track_volumes === 1;

  // AniList progress = the HIGHEST chapter (or volume) number the user has read,
  // i.e. MAX over completed chapters — NOT a contiguous 1..N count. This is
  // intentional: marking a later chapter complete reports that number even if
  // earlier chapters are still unmarked. Do not "fix" this into a contiguous
  // walk. `completedChapters` is an array of chapter IDs, not numbers.
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

module.exports = router;
