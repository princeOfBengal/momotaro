// Client-side download queue. Series and chapter download requests are
// persisted into `download_jobs` (see offlineDb.js), then a single worker
// drains them sequentially:
//
//   1. Fetch the manga + chapter metadata over `apiFetch` (online required).
//   2. Fetch the page list for the chapter.
//   3. For each page: GET `/api/pages/:id/image` as binary, write to disk.
//   4. Write a per-chapter `meta.json` and update the IndexedDB index.
//
// The worker is started lazily on enqueue and on app launch (to resume any
// 'queued' or 'running' jobs from a previous session). Cancellation goes
// through an in-process AbortController map keyed by job id so the
// in-flight page fetch can be aborted mid-stream.
//
// Concurrency: one worker, one job at a time. The server enforces its own
// rate limiting on `/api/pages/*/image`; serial downloads are also kinder
// to mobile radios. Per-page parallelism within a chapter can be a P2
// optimisation if the user reports slow downloads.
//
// Events: callers subscribe to `onChange(handler)` for state changes. The
// MangaDetail "Download series" button uses this to re-render its state
// machine without polling.

import { rawApi, buildPageImageUrl, buildThumbnailUrl } from './client.js';
import {
  enqueueJob,
  updateJob,
  listJobs,
  getJob,
  getJobForChapter,
  STORES,
  getOfflineDb,
  putOfflineManga,
  putOfflineChapter,
  putOfflinePages,
  getOfflineManga,
  getOfflineChapter,
  listOfflineChaptersForManga,
  deleteOfflineManga,
  deleteOfflineChapter,
  clearAllJobs as _clearAllJobs,
} from './offlineDb.js';
import {
  isAvailable as offlineStorageAvailable,
  isConfigured as offlineStorageConfigured,
  writeBytes,
  writeText,
  removePath,
  srcUrl,
  NoOfflineFolderError,
} from './offlineStorage.js';
import {
  keepAliveStart,
  keepAliveUpdate,
  keepAliveStop,
} from './downloadKeepAlive.js';
import { maybeEncrypt, isEncryptionEnabled, isUnlocked } from './offlineCrypto.js';
import {
  isAvailable as keepAliveAvailable,
  setPlanState as keepAliveSetPlanState,
  consumeProgressReport as keepAliveConsumeProgressReport,
} from './downloadKeepAlive.js';

// Path layout under the configured root:
//   <mangaId>/manga.json
//   <mangaId>/cover.<ext>
//   <mangaId>/chapters/<friendly chapter dir>/meta.json
//   <mangaId>/chapters/<friendly chapter dir>/<page_index>.<ext>
//
// `<friendly chapter dir>` is `Vol.X Ch.Y - Title [chapterId]` whenever
// we have volume/number info; falls back to the server's folder_name or
// a plain `[chapterId]` when those are missing. The trailing
// `[chapterId]` is the unique key — every read/delete that needs to
// resolve a chapter dir back to bytes on disk reads the stored
// `chapter_dir_path` off the IDB row, so the friendly portion is
// purely cosmetic. Older downloads keep their numeric dir names
// because their IDB rows still point at the legacy path.
function mangaDir(mangaId)               { return `${mangaId}`; }
function coverPath(mangaId, ext)         { return `${mangaDir(mangaId)}/cover.${ext}`; }
function mangaJsonPath(mangaId)          { return `${mangaDir(mangaId)}/manga.json`; }

// Compute the chapter directory path at write time. Takes the chapter
// object from the server's chapter list (`{ id, volume, number, title,
// folder_name }`) so we don't have to keep a separate mapping.
function chapterDirFor(mangaId, chapter) {
  return `${mangaId}/chapters/${buildChapterDirName(chapter)}`;
}
function pagePathFor(mangaId, chapter, idx, ext) {
  return `${chapterDirFor(mangaId, chapter)}/${String(idx).padStart(4, '0')}.${ext}`;
}
function chapterJsonPathFor(mangaId, chapter) {
  return `${chapterDirFor(mangaId, chapter)}/meta.json`;
}

// Build the human-readable chapter directory name from whatever fields
// the server populated. Path-unsafe characters are stripped so the same
// name lands cleanly inside both Capacitor's app-private storage and a
// SAF-selected user folder. The trailing `[id]` keeps each chapter
// uniquely addressable even when two folders would otherwise collide
// (e.g. two oneshots without volume/number that share a title).
function buildChapterDirName(chapter) {
  if (!chapter) return 'Chapter';
  const id = chapter.id;
  const parts = [];
  if (chapter.volume != null) parts.push(`Vol.${formatChapterNum(chapter.volume)}`);
  if (chapter.number != null) parts.push(`Ch.${formatChapterNum(chapter.number)}`);
  let base;
  if (parts.length > 0) {
    base = parts.join(' ');
    // Include the chapter title only when it's short enough not to
    // explode the path length on long manga titles.
    if (chapter.title && chapter.title.length <= 40) {
      base += ` - ${chapter.title}`;
    }
  } else if (chapter.folder_name) {
    base = chapter.folder_name;
  } else {
    base = 'Chapter';
  }
  return `${sanitizeFsName(base)} [${id}]`;
}

// Inverse of `buildChapterDirName`: recover whatever chapter info we
// can from a folder name on disk. Used by the filesystem-as-source-of-
// truth scanner (offlineApi.js) when IDB has no row for the chapter
// but the bytes are still on disk.
//
// Recognized shapes:
//   "Vol.2 Ch.5 - Title [9100]"  →  { id: 9100, volume: 2,  number: 5,    title: "Title" }
//   "Vol.2 Ch.5 [9100]"          →  { id: 9100, volume: 2,  number: 5,    title: null }
//   "Ch.5 [9100]"                →  { id: 9100, volume: null, number: 5,  title: null }
//   "Vol.2 [9100]"               →  { id: 9100, volume: 2,  number: null, title: null }
//   "<folder_name> [9100]"       →  { id: 9100, folder_name: "<folder_name>" }
//   "9100"                       →  { id: 9100 }                   (pre-v1.6.2 layout)
//   anything else                →  null  (caller skips this entry)
//
// The `[id]` trailing tag is the only required field — every chapter
// the downloader has ever written carries it. Folders without an `[id]`
// suffix and without a numeric-only name are skipped to avoid surfacing
// e.g. system `.thumbs/` dirs or stray user-created subfolders.
export function parseChapterDirName(name) {
  if (!name) return null;

  // Legacy numeric layout (pre-v1.6.2): the entire folder name is the id.
  if (/^\d+$/.test(name)) {
    return { id: Number(name), volume: null, number: null, title: null, folder_name: null };
  }

  // v1.6.2+ layout: "...stuff... [id]"
  const m = name.match(/^(.*) \[(\d+)\]$/);
  if (!m) return null;
  const inner = m[1].trim();
  const id    = Number(m[2]);

  // Try to peel off Vol.X / Ch.Y prefixes. Both, either, or neither
  // can be present; the remainder (after a " - " separator) is the
  // chapter title.
  let rest = inner;
  let volume = null;
  let number = null;

  const volM = rest.match(/^Vol\.([0-9]+(?:\.[0-9]+)?)\s*/);
  if (volM) {
    volume = Number(volM[1]);
    rest = rest.slice(volM[0].length);
  }
  const chM = rest.match(/^Ch\.([0-9]+(?:\.[0-9]+)?)\s*/);
  if (chM) {
    number = Number(chM[1]);
    rest = rest.slice(chM[0].length);
  }

  let title = null;
  let folder_name = null;
  if (rest.startsWith('- ')) {
    title = rest.slice(2).trim() || null;
  } else if (volume == null && number == null && rest) {
    // Folder name was used as the base (no Vol/Ch parsed) — preserve
    // it so the chapter still has a label for display.
    folder_name = rest;
  }

  return { id, volume, number, title, folder_name };
}

// Drops anything that's illegal inside a Windows / Android filesystem
// path segment + collapses runs of whitespace + trims the result.
// Preserves Unicode letters (CJK series titles travel through verbatim)
// AND keeps spaces and hyphens — they're path-safe and are what makes
// the resulting `Vol.2 Ch.5 - Title` actually readable.
function sanitizeFsName(s) {
  return String(s == null ? '' : s)
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// `5` → "5", `5.5` → "5.5", `5.0` → "5". Avoids JS's default
// toString() that would render `5` as just `5` but `5.0` also as `5`.
function formatChapterNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return Number.isInteger(num) ? String(num) : String(num);
}

const _listeners = new Set();
const _inflight  = new Map(); // jobId → AbortController
let _workerRunning = false;
let _initialised   = false;
// Pause flag the connectivity layer flips when the user is on cellular
// and has Wi-Fi-only mode enabled. Surfaced via `setNetworkAllowed`. The
// worker checks before each runJob and bails immediately when blocked —
// jobs stay 'queued' and the worker exits cleanly. A subsequent
// `setNetworkAllowed(true)` re-pumps.
let _networkAllowed = true;

function notify() {
  for (const fn of _listeners) {
    try { fn(); } catch { /* swallow — UI subscribers shouldn't break each other */ }
  }
  // Best-effort plan re-sync on every notify. The native side caches the
  // plan; pushing it again is idempotent and cheap (just a JSON string
  // over the Capacitor bridge). If we ever notify a lot more frequently
  // we'll want to debounce; for now it lines up with queue mutations
  // 1:1, which is the right cadence.
  syncPlanStateToNative().catch(() => { /* non-fatal */ });
}

// ── Native handoff (plan sync) ──────────────────────────────────────────────

// Rebuild and push the JS queue state to the native DownloadKeepAlive
// plugin. The plan contains enough information for the Java service to
// take over downloads on `onTaskRemoved` (user swiping the app from
// recents). Encryption mode is opt-out: when encryption is active the
// plan tells Java to refuse, since we don't ship the AES key off-process.
// Push an EMPTY plan to the native side. v1.6 moved offline storage to
// SAF tree URIs, which the Java foreground service can't write to with
// raw `File` APIs — DocumentFile/ContentResolver ops have to go through
// the OfflineFolderPlugin instance and the Service doesn't have a
// reference to it. Until a future revision teaches the service to use
// DocumentFile, we deliberately keep the native handoff inert: downloads
// pause when the app is swiped away from recents (FGS keeps the process
// alive only while the WebView/Activity is). The JS pump still drains
// the queue normally in-app + when backgrounded with the screen on.
async function syncPlanStateToNative() {
  if (!keepAliveAvailable()) return;
  try {
    await keepAliveSetPlanState({
      serverUrl:         rawApi.getServerUrl() || '',
      clientToken:       rawApi.getClientToken() || null,
      offlineRootSubdir: '',
      encryptionActive:  true,    // hard-disable Java takeover for SAF mode
      jobs:              [],
    });
  } catch {
    // The plan push is best-effort; failures are silent.
  }
}

// Drain anything the Java service completed (or failed) while the JS
// process was gone. Called on app boot from App.jsx via initDownloader.
// Each report entry is one job:
//   { jobId, status: 'done'|'failed', error?, completedPages? }
// We translate to IDB updates and emit one notify() at the end.
export async function reconcileNativeProgress() {
  if (!keepAliveAvailable()) return;
  let drained = 0;
  try {
    const r = await keepAliveConsumeProgressReport();
    const reports = (r && r.reports) || [];
    for (const rep of reports) {
      const id = Number(rep.jobId);
      if (!Number.isFinite(id)) continue;
      const existing = await getJob(id);
      if (!existing) continue;
      if (rep.status === 'done') {
        await updateJob(id, { status: 'done', finished_at: Date.now(), progress: null });
        drained++;
      } else if (rep.status === 'failed') {
        await updateJob(id, {
          status:      'failed',
          finished_at: Date.now(),
          error:       String(rep.error || 'background download failed'),
        });
        drained++;
      } else if (rep.status === 'partial') {
        // Java was interrupted mid-chapter. Leave the job as 'queued' so
        // the next pump picks it up; the page-existence check in
        // downloadChapter will skip pages that already landed on disk.
        await updateJob(id, { status: 'queued', error: null, progress: rep.progress || null });
        drained++;
      }
    }
  } catch { /* non-fatal */ }
  if (drained > 0) notify();
  return drained;
}

export function onChange(handler) {
  _listeners.add(handler);
  return () => _listeners.delete(handler);
}

// Called from App.jsx on launch and from ConnectivityContext on reconnect.
// Safe to call repeatedly; only the first call rehydrates the queue.
export async function initDownloader() {
  if (_initialised) return;
  _initialised = true;
  if (!offlineStorageAvailable()) return; // PWA — downloads aren't supported
  // Re-queue anything left as 'running' from a previous session — it never
  // got a 'done'/'failed' marker, so retry from scratch.
  const running = await listJobs({ status: 'running' });
  for (const j of running) {
    await updateJob(j.id, { status: 'queued', error: null });
  }
  notify();
  pump();
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function queueChapter(mangaId, chapterId) {
  if (!offlineStorageAvailable()) {
    throw new Error('Offline downloads require the Android app.');
  }
  // v1.6: the user must explicitly pick a download folder via SAF before
  // any download can run. We surface this as a typed error so the UI
  // can route the user to Settings → Offline Downloads instead of just
  // showing a generic failure toast.
  if (!(await offlineStorageConfigured())) throw new NoOfflineFolderError();
  await assertEncryptionUnlockedIfEnabled();
  // Don't double-queue. If the chapter is already done or queued/running,
  // just return the existing job id. Failed/cancelled rows are re-armed
  // in place rather than creating a duplicate — keeps the queue UI tidy
  // and avoids `getJobForChapter` having to disambiguate between siblings.
  const existing = await getJobForChapter(chapterId);
  if (existing) {
    if (['queued', 'running', 'done'].includes(existing.status)) {
      return existing.id;
    }
    await updateJob(existing.id, {
      status:      'queued',
      error:       null,
      attempts:    0,
      created_at:  Date.now(), // move to back of the queue
      finished_at: null,
      progress:    null,
    });
    notify();
    pump();
    return existing.id;
  }
  const id = await enqueueJob({
    kind:       'chapter',
    manga_id:   Number(mangaId),
    chapter_id: Number(chapterId),
    status:     'queued',
  });
  notify();
  pump();
  return id;
}

export async function queueSeries(mangaId) {
  if (!offlineStorageAvailable()) {
    throw new Error('Offline downloads require the Android app.');
  }
  if (!(await offlineStorageConfigured())) throw new NoOfflineFolderError();
  await assertEncryptionUnlockedIfEnabled();
  // Use the batched offline-package endpoint so series enqueue takes one
  // HTTP round-trip, not two (manga + chapters). The result is also primed
  // into the snapshot cache, which short-circuits the first runJob's
  // `ensureMangaSnapshot` call below.
  const pkg = await rawApi.getOfflinePackage(mangaId);
  primeOfflinePackage(mangaId, pkg);

  const ids = [];
  for (const ch of pkg.chapters) {
    const id = await queueChapter(mangaId, ch.id);
    ids.push(id);
  }
  return ids;
}

// Per-mangaId memo of the most recent /offline-package payload. The
// downloader worker reads from it instead of round-tripping through
// `getManga` + `getChapters` for every job. Cleared when the user requests
// a stale-copy refresh.
const _packageCache = new Map();

function primeOfflinePackage(mangaId, pkg) {
  if (!pkg) return;
  _packageCache.set(Number(mangaId), { pkg, ts: Date.now() });
}

export function invalidateOfflinePackage(mangaId) {
  _packageCache.delete(Number(mangaId));
}

async function getOfflinePackageCached(mangaId, signal) {
  const cached = _packageCache.get(Number(mangaId));
  // Cache for 5 minutes — long enough to cover a full series download in
  // most cases, short enough that a stale-copy refresh from the UI takes
  // effect on the next chapter.
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.pkg;
  const pkg = await rawApi.getOfflinePackage(mangaId, { signal });
  primeOfflinePackage(mangaId, pkg);
  return pkg;
}

export async function cancelJob(jobId) {
  const ctrl = _inflight.get(jobId);
  if (ctrl) ctrl.abort();
  const job = await getJob(jobId);
  if (job && ['queued', 'running'].includes(job.status)) {
    await updateJob(jobId, { status: 'cancelled' });
  }
  notify();
}

export async function retryJob(jobId) {
  const job = await getJob(jobId);
  if (!job) return;
  await updateJob(jobId, { status: 'queued', error: null, attempts: 0 });
  notify();
  pump();
}

// Abort every in-flight job and drop every row from the persisted queue.
// Surfaced via the Settings UI as the "Clear queue" affordance — wipes
// both the visible history (done/failed/cancelled) and any
// queued/running work in one shot.
export async function clearQueue() {
  for (const ctrl of _inflight.values()) {
    try { ctrl.abort(); } catch { /* ignore — already aborted */ }
  }
  _inflight.clear();
  await _clearAllJobs();
  notify();
}

export async function listDownloads() {
  return listJobs();
}

// Wakes the pump after the encryption store transitions locked → unlocked.
// The Settings UI calls this from EncryptionCard's unlock handler so the
// queue drains immediately rather than waiting for the user to navigate.
export function resumeAfterUnlock() {
  notify();
  pump();
}

// Called from ConnectivityContext after every network-status change.
// `allowed=false` halts the queue AND interrupts any in-flight chapter
// (so the user toggling Wi-Fi-only mid-download doesn't keep downloading
// over cellular). The interrupted chapter is re-queued — not failed —
// so it picks up on the next allow.
// `allowed=true` resumes by pumping. No-op on PWA.
export function setNetworkAllowed(allowed) {
  const next = Boolean(allowed);
  if (_networkAllowed === next) return;
  _networkAllowed = next;
  if (!next) {
    // Interrupt every in-flight controller. The runJob catch handler
    // recognises the `pause` cause and re-queues instead of cancelling.
    for (const ctrl of _inflight.values()) {
      try { ctrl.abort(PAUSE_REASON); } catch { /* old browsers ignore signal */ }
    }
  }
  notify();
  if (next) pump();
}

// Sentinel passed to AbortController.abort() so runJob can distinguish
// "user paused via Wi-Fi-only" from "user explicitly cancelled". String
// identity check is safe — we never construct another DOMException with
// this `.message`.
const PAUSE_REASON = 'momotaro:network-paused';

// Refuse to enqueue (or start) a download when the user has at-rest
// encryption enabled but the store is locked — without the in-memory
// key, `maybeEncrypt` would silently pass plaintext through to disk,
// producing a half-encrypted store that the reader can't make sense of.
// Throws an OfflineUnavailable-shaped error the UI surfaces as a toast.
async function assertEncryptionUnlockedIfEnabled() {
  if (!(await isEncryptionEnabled())) return;
  if (isUnlocked()) return;
  const e = new Error(
    'Encryption is enabled but locked. Open Settings → Offline → '
    + 'At-rest Encryption and enter your passphrase to unlock before downloading.'
  );
  e.code = 'ENCRYPTION_LOCKED';
  throw e;
}

export function isNetworkAllowed() {
  return _networkAllowed;
}

// Remove every downloaded byte for a series + the IDB row. Doesn't touch
// in-flight jobs — caller should `cancelJob` first.
export async function deleteSeries(mangaId) {
  if (!offlineStorageAvailable()) return;
  await removePath(mangaDir(mangaId), { recursive: true });
  await deleteOfflineManga(mangaId);
  notify();
}

// Remove a single chapter on disk + its IDB rows. Series stays
// downloaded. The on-disk path is the one the downloader recorded at
// write time — newer chapters get the friendly `Vol.X Ch.Y [id]`
// layout, older chapters (downloaded before v1.6.2) still carry the
// legacy numeric `${mangaId}/chapters/${chapterId}` path. We read it
// off the IDB row so both work without branching on age.
export async function deleteChapter(mangaId, chapterId) {
  if (!offlineStorageAvailable()) return;
  const row = await getOfflineChapter(chapterId);
  const dirPath = (row && row.chapter_dir_path) || `${mangaId}/chapters/${chapterId}`;
  await removePath(dirPath, { recursive: true });
  await deleteOfflineChapter(chapterId);
  notify();
}

// ── Worker ──────────────────────────────────────────────────────────────────

async function pump() {
  if (_workerRunning) return;
  _workerRunning = true;
  let promoted = false; // foreground-service notification active?
  try {
    while (true) {
      if (!_networkAllowed) break; // paused; setNetworkAllowed(true) re-pumps
      // Refuse to spin if the user has at-rest encryption enabled but
      // hasn't unlocked yet — otherwise runJob would keep picking up the
      // same head-of-queue job and bailing in a tight loop. Resumed on
      // unlock via the explicit `resumeAfterUnlock` export.
      try { await assertEncryptionUnlockedIfEnabled(); }
      catch (e) { if (e.code === 'ENCRYPTION_LOCKED') break; throw e; }
      // Likewise refuse to spin when the user has un-picked the
      // download folder. Queued jobs sit in IDB until the user picks
      // again; pickFolder doesn't auto-resume so the caller (Settings)
      // explicitly calls `resumeAfterUnlock` to wake the pump.
      if (!(await offlineStorageConfigured())) break;

      const queued = await listJobs({ status: 'queued' });
      if (queued.length === 0) break;

      // Oldest queued first.
      queued.sort((a, b) => a.created_at - b.created_at);
      const job = queued[0];

      // Promote the process to foreground once at the start of the run so
      // Android doesn't reclaim the WebView during a long download. The
      // notification text is refreshed per-job in runJob. We don't promote
      // unless we're actually running anything — short queues that drain
      // before a single chapter completes won't even raise the notif.
      if (!promoted) {
        await keepAliveStart({
          title: 'Momotaro',
          text:  `Downloading (${queued.length} queued)…`,
        });
        promoted = true;
      }

      await runJob(job);
    }
  } finally {
    if (promoted) await keepAliveStop();
    _workerRunning = false;
  }
}

async function runJob(job) {
  const ctrl = new AbortController();
  _inflight.set(job.id, ctrl);
  try {
    // `maybeEncrypt` inside downloadChapter is the authoritative gate
    // for the locked-store case — it throws ENCRYPTION_LOCKED and the
    // catch below re-queues the job. We also short-circuit at the pump
    // level so we don't even reach here in the steady-state locked case.
    await updateJob(job.id, {
      status:     'running',
      attempts:   (job.attempts || 0) + 1,
      error:      null,
      started_at: Date.now(),
    });
    notify();
    await downloadChapter(job, ctrl.signal);
    await updateJob(job.id, { status: 'done', finished_at: Date.now(), progress: null });
  } catch (err) {
    if (ctrl.signal.aborted) {
      // Distinguish "the network-allowed flag flipped during the run"
      // from "the user clicked Cancel". Pause → re-queue so the next
      // pump picks it up; explicit cancel → terminal 'cancelled' state.
      // Browsers prior to the AbortSignal#reason proposal won't surface
      // the reason — fall back to inspecting the message on `err`.
      const reason = ctrl.signal.reason ?? (err && err.message);
      const paused = reason === PAUSE_REASON;
      try {
        await updateJob(job.id, paused
          ? { status: 'queued', error: null, progress: null, started_at: null }
          : { status: 'cancelled', finished_at: Date.now() });
      } catch {}
    } else if (err && err.code === 'ENCRYPTION_LOCKED') {
      // The user locked the encryption store mid-chapter (or never
      // unlocked it). Send the job back to 'queued' so it resumes once
      // they unlock; don't mark it 'failed' because the user didn't do
      // anything wrong — the bytes on disk are still recoverable.
      try { await updateJob(job.id, { status: 'queued', error: null, progress: null, started_at: null }); } catch {}
    } else {
      try {
        await updateJob(job.id, {
          status:      'failed',
          finished_at: Date.now(),
          error:       String(err?.message || err || 'Unknown error'),
        });
      } catch {}
    }
  } finally {
    _inflight.delete(job.id);
    notify();
  }
}

// Download the manga shell (cover + manga.json) if missing, then the
// chapter's pages. Idempotent — re-running on an already-complete chapter is
// a no-op for the page bytes (file existence check), but always rewrites
// the chapter index so any post-scan metadata changes propagate.
async function downloadChapter(job, signal) {
  const mangaId   = job.manga_id;
  const chapterId = job.chapter_id;

  await ensureMangaSnapshot(mangaId, signal);

  // Fetch chapter detail + page list.
  const [chapter, pages] = await Promise.all([
    findChapterRow(mangaId, chapterId, signal),
    rawApi.getPages(chapterId, { signal }),
  ]);
  if (!chapter) throw new Error(`Chapter ${chapterId} not found on server`);

  // Per-page download. We record progress on the job after each page so the
  // UI can render "12 / 47". `chapterDirRel` is the chapter directory
  // path under the offline root — computed once from the chapter's
  // server metadata (volume/number/title) and reused for every page +
  // the meta.json. Stored on the offline_chapters row at the end so
  // delete / read operations can resolve back to the exact folder
  // without having to recompute (and without depending on whether the
  // server-side metadata changed after the download).
  const chapterDirRel = chapterDirFor(mangaId, chapter);
  const pageRows = [];
  for (let i = 0; i < pages.length; i++) {
    if (signal.aborted) throw new Error('aborted');
    const p = pages[i];
    const ext = extractExt(p.filename) || guessExtFromMime(p) || 'jpg';
    const relPath = pagePathFor(mangaId, chapter, p.page_index ?? i, ext);

    const url = buildPageImageUrl(p.id);
    const bytes = await fetchBinary(url, signal);
    // Encrypt-on-write when the user has at-rest encryption enabled and
    // the store is unlocked; otherwise pass-through.
    const writeable = await maybeEncrypt(bytes);
    await writeBytes(relPath, writeable);

    pageRows.push({
      chapter_id:  chapterId,
      page_index:  p.page_index ?? i,
      page_id:     p.id,
      filename:    p.filename,
      width:       p.width ?? null,
      height:      p.height ?? null,
      local_path:  relPath,
    });

    await updateJob(job.id, {
      progress: { current: i + 1, total: pages.length },
    });
    if (i % 4 === 0) {
      notify(); // batch the in-app UI notifications
      // Refresh the keep-alive notification text too — at the same cadence
      // so we don't spam the system tray. Best-effort; no-op on PWA.
      keepAliveUpdate({
        text: `Chapter ${chapterId}: page ${i + 1}/${pages.length}`,
      });
    }
  }

  // Persist chapter index + meta.json on disk. Capture the server's
  // `updated_at` for the chapter — the delta check inside
  // `refreshOfflineSnapshot` compares this against the server's current
  // value to detect chapters that have been re-scanned (CBZ replaced,
  // pages reordered, etc.) since we downloaded them.
  //
  // `encrypted` records whether THIS chapter's bytes were written
  // through the AES-GCM envelope. The reader checks the flag per chapter
  // so a library mixing pre-encryption (plaintext) and post-encryption
  // (ciphertext) chapters renders both correctly.
  const wasEncrypted = (await isEncryptionEnabled()) && isUnlocked();
  await putOfflinePages(chapterId, pageRows);
  await putOfflineChapter({
    ...chapter,
    id:                 chapterId,
    manga_id:           mangaId,
    page_count:         pages.length,
    status:             'done',
    downloaded_at:      Date.now(),
    server_updated_at:  chapter.updated_at ?? null,
    server_page_count:  pages.length,
    encrypted:          wasEncrypted,
    // Persisted so `deleteChapter` can find the right folder on disk
    // even after a future schema change to the dir-name builder.
    // Legacy rows (pre-v1.6.2) won't have this field; the delete path
    // falls back to the old numeric `${mangaId}/chapters/${chapterId}`
    // layout for them.
    chapter_dir_path:   chapterDirRel,
  });
  await writeText(chapterJsonPathFor(mangaId, chapter), JSON.stringify({
    id:                 chapterId,
    manga_id:           mangaId,
    number:             chapter.number ?? null,
    number_end:         chapter.number_end ?? null,
    volume:             chapter.volume ?? null,
    volume_end:         chapter.volume_end ?? null,
    title:              chapter.title ?? null,
    folder_name:        chapter.folder_name ?? null,
    page_count:         pages.length,
    pages:              pageRows,
    downloaded_at:      Date.now(),
    server_updated_at:  chapter.updated_at ?? null,
    // `encrypted` lets the filesystem scanner know whether to take the
    // decrypt-to-blob path on read. IDB carries the same flag; the
    // sidecar copy here is what survives an IDB wipe.
    encrypted:          wasEncrypted,
  }, null, 2));
  notify();
}

// Snapshot the series-level data: manga metadata + cover image. Skipped on
// subsequent chapter downloads when the snapshot is already present.
//
// `pkg` is the optional pre-fetched /offline-package payload; passing it
// avoids a redundant network call when the caller already had the data
// (queueSeries primes it). Without `pkg` we fetch from the same endpoint —
// `getOfflinePackageCached` is memoized so back-to-back chapters in the
// same series share a single fetch.
async function ensureMangaSnapshot(mangaId, signal, pkg = null) {
  const db = await getOfflineDb();
  const existing = await db.get(STORES.MANGA, Number(mangaId));
  if (existing && existing.cover_url) return existing;

  const resolved = pkg || await getOfflinePackageCached(mangaId, signal);
  const manga = resolved.manga;

  // Pull cover bytes into local storage, then point cover_url at the
  // local file via `srcUrl` so the UI doesn't need any extra branching.
  let coverLocalUrl = null;
  if (manga.cover_url || manga.thumbnail_filename) {
    try {
      const remote = manga.cover_url || buildThumbnailUrl(manga.thumbnail_filename);
      const ext = extractExt(remote) || 'webp';
      const bytes = await fetchBinary(remote, signal);
      const rel = coverPath(mangaId, ext);
      // Covers are intentionally NOT encrypted — they're displayed by
      // the Library/Home grids via plain <img src> without any per-render
      // crypto cost, and the threat model (someone with raw filesystem
      // bytes) is not meaningfully degraded by exposing a 300×430 cover
      // thumbnail. Same applies to manga.json (titles, descriptions).
      // The reader's per-page content IS encrypted (see
      // downloadChapter), which is where the actual sensitive bytes are.
      await writeBytes(rel, bytes);
      coverLocalUrl = await srcUrl(rel);
    } catch (e) {
      // Cover is non-essential — proceed without it.
      coverLocalUrl = null;
    }
  }

  const row = {
    ...manga,
    id:                Number(mangaId),
    cover_url:         coverLocalUrl,
    downloaded_at:     Date.now(),
    server_updated_at: resolved.server_updated_at ?? null,
  };
  await putOfflineManga(row);
  await writeText(mangaJsonPath(mangaId), JSON.stringify(row, null, 2));
  return row;
}

// Find a single chapter for the manga we're downloading. Uses the same
// /offline-package cache the snapshot uses — back-to-back chapter
// downloads only pay one HTTP round-trip per series.
async function findChapterRow(mangaId, chapterId, signal) {
  const pkg = await getOfflinePackageCached(mangaId, signal);
  return pkg.chapters.find(c => Number(c.id) === Number(chapterId));
}

// Bytes-level fetch. `apiFetch` only handles JSON; here we need the raw
// Uint8Array. `pageImageUrl` already encodes the auth token via `?t=` so
// no Authorization header is required.
async function fetchBinary(url, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

function extractExt(s) {
  if (!s) return null;
  const m = String(s).match(/\.([A-Za-z0-9]+)(?:\?|$)/);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  // Whitelist — guard against the regex matching a non-extension token like
  // a query-param fragment ending in numbers.
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext) ? ext : null;
}

function guessExtFromMime() {
  // The server doesn't expose per-page MIME in the JSON; the filename ext
  // path covers ~all real cases. Returning null falls through to 'jpg' which
  // is the dominant format in CBZ archives.
  return null;
}

// Convenience for the UI: returns one of `null | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'`
// for a given chapter. Used by MangaDetail to render the per-chapter badge.
export async function getChapterDownloadStatus(chapterId) {
  const job = await getJobForChapter(chapterId);
  if (job) return { status: job.status, progress: job.progress, error: job.error, jobId: job.id };
  const ch  = await getOfflineChapter(chapterId);
  if (ch && ch.status === 'done') return { status: 'done', progress: null };
  return { status: null };
}

// Refresh the offline snapshot for a series — re-fetches the
// /offline-package payload, rewrites the manga.json on disk, and queues
// any chapters that exist on the server but not locally. Existing
// downloaded chapters are left untouched (they're addressed by chapter id,
// not by some hash — re-downloading them is wasteful when the on-disk
// bytes are still valid). Returns a small summary.
export async function refreshOfflineSnapshot(mangaId) {
  if (!offlineStorageAvailable()) {
    throw new Error('Offline downloads require the Android app.');
  }
  invalidateOfflinePackage(mangaId);
  const pkg = await rawApi.getOfflinePackage(mangaId);
  primeOfflinePackage(mangaId, pkg);

  // Merge the freshly-fetched server fields onto whatever we have locally,
  // preserving the local cover_url (so the UI doesn't flash blank) and the
  // original downloaded_at (so existing series ordering is stable). We
  // intentionally avoid deleteOfflineManga + re-put — that would drop the
  // chapter and page rows we still want to keep.
  const existing = await getOfflineManga(mangaId);
  const merged = {
    ...(existing || {}),
    ...pkg.manga,
    id:                Number(mangaId),
    server_updated_at: pkg.server_updated_at ?? null,
    cover_url:         (existing && existing.cover_url) || null,
    downloaded_at:     (existing && existing.downloaded_at) || Date.now(),
  };
  await putOfflineManga(merged);
  // Rewrite manga.json on disk too so a future "rebuild IDB from disk"
  // recovery would pick up the refreshed metadata.
  try { await writeText(mangaJsonPath(mangaId), JSON.stringify(merged, null, 2)); }
  catch { /* non-fatal — IDB row is authoritative */ }

  // Three-way diff per chapter:
  //   - On server, not local:    queue (new chapter)
  //   - On both, page_count or server updated_at differs: delete local
  //     copy + queue (changed chapter — CBZ replaced, pages reordered)
  //   - On both, identical:      leave alone
  // Local-only chapters are deliberately left in place — the server may
  // have temporarily lost the file (e.g. drive unmounted) and we don't
  // want to discard the user's downloaded bytes on a transient blip.
  const localChapters = await listOfflineChaptersForManga(mangaId);
  const localById = new Map(
    localChapters
      .filter(c => c.status === 'done')
      .map(c => [Number(c.id), c]),
  );
  const newlyQueued = [];
  const restaged   = [];
  for (const ch of pkg.chapters) {
    const cid = Number(ch.id);
    const local = localById.get(cid);
    if (!local) {
      const id = await queueChapter(mangaId, cid);
      newlyQueued.push(id);
      continue;
    }
    if (isChapterStale(local, ch)) {
      // Delete the on-disk bytes for the stale chapter so the re-download
      // writes a clean copy (otherwise leftover pages from the old version
      // could outnumber the new ones).
      try { await deleteChapter(mangaId, cid); }
      catch { /* best-effort */ }
      const id = await queueChapter(mangaId, cid);
      restaged.push(id);
    }
  }
  return {
    server_chapter_count: pkg.chapters.length,
    local_done_count:     localById.size,
    newly_queued:         newlyQueued.length,
    restaged:             restaged.length,
    server_updated_at:    pkg.server_updated_at ?? null,
  };
}

// True when the local copy of a chapter is out of sync with the server.
//
// Two signals:
//   - page_count drift (covers CBZ replaced, pages added/removed)
//   - server `updated_at` drift (covers metadata-only updates like title
//     fixes that don't change the page count)
//
// Either alone is enough to trigger a re-download — EXCEPT when the
// local row has no `server_updated_at`. That field was introduced in
// P3; chapters downloaded under P1/P2 don't carry it. We don't want a
// P3 upgrade to silently restage every existing chapter on the next
// Refresh tap, so when local timestamp is missing we trust the
// page_count check alone. The user can still force a full restage by
// removing the series and re-downloading.
function isChapterStale(local, serverChapter) {
  const lpc = Number(local.page_count ?? 0);
  const spc = Number(serverChapter.page_count ?? 0);
  if (lpc && spc && lpc !== spc) return true;

  const lts = Number(local.server_updated_at ?? 0);
  const sts = Number(serverChapter.updated_at  ?? 0);
  // Only trip on timestamp drift when BOTH sides have a usable value.
  // Otherwise we'd false-positive every pre-P3 chapter on first refresh.
  if (lts && sts && sts > lts) return true;
  return false;
}

// True when the local offline snapshot is older than the server's
// `updated_at` for the same series. Used by MangaDetail to surface a
// "refresh" CTA without polling.
export async function isOfflineSnapshotStale(mangaId, serverUpdatedAtUnix) {
  if (!serverUpdatedAtUnix) return false;
  const existing = await getOfflineManga(mangaId);
  if (!existing) return false;
  const localTs = existing.server_updated_at;
  if (!localTs) return true; // We don't know — surface refresh to be safe.
  return Number(serverUpdatedAtUnix) > Number(localTs);
}
