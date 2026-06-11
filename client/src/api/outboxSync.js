// Flushes the progress outbox (offline `markChapterRead` / `updateProgress`
// calls) up to the server when connectivity returns. Designed to be safe
// to call concurrently — a second `flushOutbox()` while one is already in
// flight returns the in-flight promise instead of starting a parallel
// drain.
//
// Strategy:
//   1. Read every row in `progress_outbox` (chapter_id keyed; latest write
//      per chapter is the only one that matters — older writes were already
//      collapsed at enqueue time).
//   2. For each row, replay against the corresponding server endpoint:
//        - `payload.chapterId` + `payload.completed` → markChapterRead
//        - anything else                              → updateProgress
//   3. On success, delete the outbox row.
//   4. On failure, leave the row in place so the next flush retries it.
//
// We deliberately don't batch multiple rows into a single request: the
// server endpoints are per-manga/per-chapter writes, so the "batch" is
// just an in-process for-loop. Each row is independent so a single
// chapter failing doesn't block the rest.

import { listOutboxForUser, clearOutboxEntry, getActiveUserIdSync } from './offlineDb.js';
import { rawApi } from './client.js';

let _flushPromise = null;
let _lastFlushAt  = 0;

export async function flushOutbox({ minIntervalMs = 5_000 } = {}) {
  // Coalesce: if a flush is in-flight, return it. If one finished very
  // recently and the *current* user has nothing pending, skip.
  if (_flushPromise) return _flushPromise;
  if (Date.now() - _lastFlushAt < minIntervalMs) {
    const userId = getActiveUserIdSync();
    const rows = await listOutboxForUser(userId);
    if (rows.length === 0) return { drained: 0, failed: 0 };
  }

  _flushPromise = doFlush().finally(() => {
    _flushPromise = null;
    _lastFlushAt  = Date.now();
  });
  return _flushPromise;
}

async function doFlush() {
  // Only replay rows belonging to the currently logged-in user, since the
  // X-User-Token attached by `rawApi.*` is theirs. Other users' rows stay in
  // the outbox until that user signs in and triggers a flush.
  const userId = getActiveUserIdSync();
  let rows;
  try { rows = await listOutboxForUser(userId); }
  catch { return { drained: 0, failed: 0 }; }

  let drained = 0;
  let failed  = 0;
  let dropped = 0;

  for (const row of rows) {
    try {
      const payload = row.payload || {};
      if ('chapterId' in payload && 'completed' in payload) {
        await rawApi.markChapterRead(row.manga_id, payload.chapterId, payload.completed);
      } else {
        await rawApi.updateProgress(row.manga_id, payload);
      }
      await clearOutboxEntry(row);
      drained++;
    } catch (err) {
      // A 404 is the one status that means this replay can NEVER succeed: the
      // chapter (or its manga) was deleted server-side after the write was
      // queued offline, so the progress route now rejects it. Drop the row —
      // leaving it would poison-pill the queue (retried on every reconnect,
      // forever). Everything else is treated as transient and retried, on
      // purpose: 401/403 (token needs refresh), 429/408 (throttled/timeout),
      // 5xx, and network errors are all recoverable, and dropping an unsynced
      // progress write on one of those would lose the user's reading position.
      // `err.status` is attached by rawApi (undefined for network failures).
      if (err && err.status === 404) {
        try { await clearOutboxEntry(row); } catch { /* ignore */ }
        dropped++;
      } else {
        failed++;
      }
    }
  }
  return { drained, failed, dropped };
}
