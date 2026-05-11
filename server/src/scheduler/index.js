const { getDb } = require('../db/database');
const { getSource } = require('../sources');
const downloader = require('../downloader/queue');

// Per-manga auto-check scheduler.
//
// Wakes up every 60 seconds, picks every `manga_schedules` row that's due,
// fetches each recorded source URL's chapter list, diffs against what's
// already on disk for that manga (the scanner has already parsed chapter and
// volume numbers off the folder/file names — see `chapters.number`), and
// enqueues anything missing into the existing download queue.
//
// One-minute polling vs. per-row setTimeout: an indexed lookup on
// `next_run_at` is essentially free, and recomputing timers on every
// schedule edit (or after every fire) is more code for no real benefit at
// the scales this app deals with (a few hundred scheduled manga, tops).
//
// All time math is done in *server local time*, matching the rest of the
// app's scheduling conventions (see also cbzCacheSchedule.js).

const POLL_INTERVAL_MS  = 60 * 1000;
// Polite delay between consecutive per-manga checks within one tick — keeps
// us from hammering a source if the user happens to schedule 50 series at
// the same minute.
const INTER_MANGA_DELAY_MS = 1000;

let _pollTimer    = null;
let _running      = false;   // re-entrancy guard around runDueChecks()
let _started      = false;

// ── Time helpers ───────────────────────────────────────────────────────────

function parseHHMM(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return { h, m: mn };
}

/**
 * Compute the next unix-seconds timestamp at which a schedule should fire,
 * relative to `nowMs` (defaults to Date.now()). Returns null on invalid
 * inputs so the route handler can reject with a 400 instead of silently
 * scheduling something that never fires.
 *
 * - daily:   today at HH:MM if still in the future, else tomorrow at HH:MM
 * - weekly:  the next occurrence of (day_of_week, HH:MM) on or after now
 */
function computeNextRunAt({ frequency, day_of_week, time_of_day }, nowMs = Date.now()) {
  const hhmm = parseHHMM(time_of_day);
  if (!hhmm) return null;

  const now = new Date(nowMs);
  const candidate = new Date(nowMs);
  candidate.setHours(hhmm.h, hhmm.m, 0, 0);

  if (frequency === 'daily') {
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return Math.floor(candidate.getTime() / 1000);
  }

  if (frequency === 'weekly') {
    const dow = parseInt(day_of_week, 10);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    // Find the next occurrence of `dow`. If today is `dow` and HH:MM hasn't
    // passed yet, today wins; otherwise add days.
    let daysAhead = (dow - candidate.getDay() + 7) % 7;
    if (daysAhead === 0 && candidate <= now) daysAhead = 7;
    candidate.setDate(candidate.getDate() + daysAhead);
    return Math.floor(candidate.getTime() / 1000);
  }

  return null;
}

// ── Diff helpers ───────────────────────────────────────────────────────────

/**
 * Compare two REAL chapter numbers within a small tolerance to absorb the
 * float-representation jitter that comes from things like 23.5 vs
 * "23.500001". Practically these are always small whole numbers or
 * half-step fractions, so 1e-3 is plenty.
 */
function chapterNumbersEqual(a, b) {
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-3;
}

/**
 * Read the local chapter set for a manga as a sorted list of numeric
 * chapter values. `chapters.number` is populated by the scanner via
 * `parseChapterInfo` ([scanner/chapterParser.js]), which already handles
 * Chapter 1, ch 01, c01, ch.1, etc. — so we don't need to re-parse here.
 *
 * Volume-only entries (number IS NULL) are excluded from the comparison
 * set; they're impossible to dedupe against numbered remote rows without
 * fragile heuristics. The scheduler still won't re-enqueue volume-only
 * remote chapters because the downloader's "skip if file exists" guard
 * catches duplicates at the filesystem level.
 */
function localChapterNumbers(db, mangaId) {
  return db.prepare(
    `SELECT number FROM chapters WHERE manga_id = ? AND number IS NOT NULL`
  ).all(mangaId).map(r => Number(r.number));
}

function isMissing(localNums, remoteNumber) {
  if (remoteNumber == null) return false;
  return !localNums.some(n => chapterNumbersEqual(n, remoteNumber));
}

// ── Per-manga check ────────────────────────────────────────────────────────

/**
 * Run one pass for one manga: walk every recorded source URL, fetch its
 * chapter list, diff against the local folder, and enqueue every missing
 * chapter. Returns a summary string for `last_result` plus the count of
 * jobs enqueued so the run-now endpoint can surface it to the user.
 *
 * Only the `mangadex_id`-style integration is exercised today. Adding
 * comix.to (the explicit Phase-2 follow-up) requires nothing here —
 * `getSource` will resolve the new adapter as soon as it's registered.
 */
async function checkOneManga(mangaId) {
  const db = getDb();
  const manga = db.prepare(
    `SELECT id, title FROM manga WHERE id = ?`
  ).get(mangaId);
  if (!manga) return { ok: false, summary: 'Manga not found', enqueued: 0 };

  // Dedupe by (source, source_id) — multiple URLs may point at the same
  // series at the same source (alternate mirror) and we don't want to fetch
  // the chapter list twice.
  const urlRows = db.prepare(`
    SELECT id, source, source_id, url FROM manga_source_urls WHERE manga_id = ?
  `).all(manga.id);

  const sourceTargets = new Map(); // key: source|source_id  → first row encountered
  for (const r of urlRows) {
    if (!r.source || !r.source_id) continue;
    const key = `${r.source}|${r.source_id}`;
    if (!sourceTargets.has(key)) sourceTargets.set(key, r);
  }

  if (sourceTargets.size === 0) {
    return { ok: false, summary: 'No source URLs recorded', enqueued: 0 };
  }

  const localNums = localChapterNumbers(db, manga.id);
  let totalEnqueued = 0;
  let perSourceErrors = [];

  for (const target of sourceTargets.values()) {
    let source;
    try {
      source = getSource(target.source);
    } catch (err) {
      perSourceErrors.push(`${target.source}: ${err.message}`);
      continue;
    }

    let remoteChapters;
    try {
      remoteChapters = await source.getChapters(target.source_id, { languages: ['en'] });
    } catch (err) {
      perSourceErrors.push(`${target.source}: ${err.message}`);
      continue;
    }

    const missing = remoteChapters.filter(c => isMissing(localNums, c.number));
    if (missing.length === 0) continue;

    for (const ch of missing) {
      try {
        downloader.enqueueJob({
          source:              target.source,
          source_series_id:    target.source_id,
          source_series_title: manga.title,
          source_chapter_id:   ch.id,
          chapter_number:      ch.number ?? null,
          chapter_volume:      ch.volume ?? null,
          chapter_title:       ch.title  || null,
          target_mode:         'existing',
          target_library_id:   null,
          target_manga_id:     manga.id,
          target_folder_name:  null,
        });
        totalEnqueued++;
        // Track in the in-memory set so a second URL pointing at the same
        // missing chapter doesn't double-enqueue within the same run. The
        // downloader's on-disk dedupe still protects across runs.
        if (ch.number != null) localNums.push(Number(ch.number));
      } catch (err) {
        perSourceErrors.push(`enqueue: ${err.message}`);
      }
    }
  }

  let summary;
  if (totalEnqueued > 0) {
    summary = `Queued ${totalEnqueued} new chapter${totalEnqueued === 1 ? '' : 's'}`;
  } else if (perSourceErrors.length > 0) {
    summary = `error: ${perSourceErrors[0]}`;
  } else {
    summary = 'No new chapters';
  }
  if (perSourceErrors.length > 0 && totalEnqueued > 0) {
    summary += ` (${perSourceErrors.length} source error${perSourceErrors.length === 1 ? '' : 's'})`;
  }

  return { ok: perSourceErrors.length === 0, summary, enqueued: totalEnqueued };
}

/**
 * Save the outcome of a check back onto the schedule row and bump
 * `next_run_at` to the next occurrence. `lastChecked` is the timestamp the
 * fire happened — used as the base when computing the next slot for daily
 * schedules so a long-running check doesn't push the next fire late.
 */
function recordRunResult(db, scheduleRow, summary, lastChecked = Math.floor(Date.now() / 1000)) {
  const next = computeNextRunAt(scheduleRow, lastChecked * 1000);
  db.prepare(`
    UPDATE manga_schedules
       SET last_checked_at = ?,
           last_result     = ?,
           next_run_at     = ?,
           updated_at      = unixepoch()
     WHERE id = ?
  `).run(lastChecked, summary, next, scheduleRow.id);
}

// ── Poll loop ──────────────────────────────────────────────────────────────

async function runDueChecks() {
  if (_running) return;
  _running = true;
  try {
    const db = getDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const due = db.prepare(`
      SELECT * FROM manga_schedules
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT 50
    `).all(nowSec);

    for (let i = 0; i < due.length; i++) {
      const sched = due[i];
      try {
        const { summary } = await checkOneManga(sched.manga_id);
        recordRunResult(db, sched, summary, Math.floor(Date.now() / 1000));
        console.log(`[Scheduler] manga ${sched.manga_id}: ${summary}`);
      } catch (err) {
        recordRunResult(db, sched, `error: ${err.message.slice(0, 120)}`, Math.floor(Date.now() / 1000));
        console.warn(`[Scheduler] manga ${sched.manga_id} check threw: ${err.message}`);
      }
      if (i < due.length - 1) await new Promise(r => setTimeout(r, INTER_MANGA_DELAY_MS));
    }
  } finally {
    _running = false;
  }
}

function start() {
  if (_started) return;
  _started = true;
  // Backfill `next_run_at` for any rows that have it null (e.g. data
  // imported via export/import before this column existed in the export
  // payload). Costs nothing on a fresh DB.
  const db = getDb();
  const orphans = db.prepare(
    `SELECT id, frequency, day_of_week, time_of_day FROM manga_schedules WHERE enabled = 1 AND next_run_at IS NULL`
  ).all();
  for (const row of orphans) {
    const next = computeNextRunAt(row);
    if (next != null) {
      db.prepare(`UPDATE manga_schedules SET next_run_at = ? WHERE id = ?`).run(next, row.id);
    }
  }

  _pollTimer = setInterval(() => {
    runDueChecks().catch(err => console.error('[Scheduler] poll error:', err));
  }, POLL_INTERVAL_MS);
  // .unref so a pending tick never blocks graceful shutdown.
  _pollTimer.unref?.();

  // Don't wait the first 60 s on boot — fire one tick after a short delay so
  // anything overdue from the previous process is picked up promptly.
  setTimeout(() => runDueChecks().catch(() => {}), 5000).unref?.();
}

function stop() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  _started = false;
}

module.exports = {
  start,
  stop,
  // Exposed for the route handlers + tests
  computeNextRunAt,
  checkOneManga,
  recordRunResult,
};
