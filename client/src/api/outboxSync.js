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

import { listOutbox, clearOutboxEntry } from './offlineDb.js';
import { rawApi } from './client.js';

let _flushPromise = null;
let _lastFlushAt  = 0;

export async function flushOutbox({ minIntervalMs = 5_000 } = {}) {
  // Coalesce: if a flush is in-flight, return it. If one finished very
  // recently and no new writes have shown up, skip.
  if (_flushPromise) return _flushPromise;
  if (Date.now() - _lastFlushAt < minIntervalMs) {
    const rows = await listOutbox();
    if (rows.length === 0) return { drained: 0, failed: 0 };
  }

  _flushPromise = doFlush().finally(() => {
    _flushPromise = null;
    _lastFlushAt  = Date.now();
  });
  return _flushPromise;
}

async function doFlush() {
  let rows;
  try { rows = await listOutbox(); }
  catch { return { drained: 0, failed: 0 }; }

  let drained = 0;
  let failed  = 0;

  for (const row of rows) {
    try {
      const payload = row.payload || {};
      if ('chapterId' in payload && 'completed' in payload) {
        await rawApi.markChapterRead(row.manga_id, payload.chapterId, payload.completed);
      } else {
        await rawApi.updateProgress(row.manga_id, payload);
      }
      await clearOutboxEntry(row.chapter_id);
      drained++;
    } catch {
      failed++;
      // Leave the row in place — the next reconnect will retry it.
    }
  }
  return { drained, failed };
}
