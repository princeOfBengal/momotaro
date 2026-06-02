const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const yauzl = require('yauzl');
const sharp = require('sharp');
const config = require('../config');

// Per-chapter disk cache for CBZ archives.
//
// Two extraction modes are supported on the same on-disk layout:
//
//   FAST (opt-in, `mode: 'fast'`):
//     Phase 1 — read the central directory, probe image dimensions for every
//       entry (decompresses only enough bytes for sharp.metadata()), extract
//       the first FAST_PREFIX entries, then resolve.
//     Phase 2 — background-extract the remainder in strict page-index order,
//       writing the `.ready` marker last. Individual page reads can block on
//       waitForPageFile() until their file is on disk.
//
//   FULL (legacy, `mode: 'full'`):
//     Single-shot extraction of every entry, then `.ready`. Identical to
//     pre-feature behaviour. Used by thumbnail / cover / metadata code paths
//     that don't tolerate partial state.
//
// Layout: CBZ_CACHE_DIR/<chapterId>_<mtimeFloor>/
//           ├── 0001.jpg          (zero-padded sequential filenames so the
//           ├── 0002.jpg           reader's natural-sort matches archive order)
//           ├── ...
//           └── .ready            (written last by both modes; absence means
//                                  partial extraction)
//
// Including the archive's floor-seconds mtime in the directory name prevents
// stale files from ever being served after the CBZ is rewritten — a new mtime
// resolves to a new directory.
//
// Failure mitigations (the user can delete or rename folders mid-extract):
//   - cancelChapter(chapterId) aborts an in-flight Phase 2, rejects every
//     pageWaiter with a 'CHAPTER_REMOVED' error, removes the dir, drops the
//     state slot.
//   - The Phase 2 worker re-fingerprints the CBZ between pages (mtime + size)
//     so an atomic rewrite or delete is caught quickly.
//   - auditOrphans(db) walks the cache dir, removes any subdir whose
//     chapter id no longer exists in the chapters table.

const DEFAULT_CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB default cap

// Tunables — read from config so env vars can override without code changes.
const FAST_PREFIX               = config.CBZ_FAST_PREFIX;
const DIM_PROBE_CONCURRENCY     = config.CBZ_DIM_PROBE_CONCURRENCY;
const DIM_PROBE_BUFFER_BYTES    = config.CBZ_DIM_PROBE_BUFFER_BYTES;
const PHASE2_CONCURRENCY        = config.CBZ_PHASE2_CONCURRENCY;
const PAGE_WAIT_TIMEOUT_MS      = config.CBZ_PAGE_WAIT_TIMEOUT_MS;
const PHASE2_RESTAT_INTERVAL    = config.CBZ_PHASE2_RESTAT_INTERVAL;
const MAX_WAITERS_PER_CHAPTER   = 32;

// Mutable at runtime via setLimitBytes() so the user can reconfigure from
// Settings without restarting the server.
let cacheLimitBytes = DEFAULT_CACHE_LIMIT_BYTES;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const READY_MARKER = '.ready';

// LRU: iteration order of a Map is insertion order, so re-inserting on touch
// moves a key to the tail (most recent). Key = absolute chapter-dir path.
const index = new Map();    // chapterDir -> { size }
let totalBytes = 0;

// Per-chapter extraction state. Keyed by chapterDir so concurrent Phase-1
// callers for the same chapter share a single Phase 1 promise.
const chapterStates = new Map(); // chapterDir -> ChapterState

// Global queue gate for Phase 2 background work — keeps a binge-clicker from
// spawning unbounded sharp work across the whole library. Each running Phase 2
// counts as one slot.
let phase2Active = 0;
const phase2Queue = [];

// One-time libvips warm-up; first sharp() call lazy-loads bindings. Cheap
// belt-and-braces so the very first chapter open doesn't pay the cost.
sharp(Buffer.alloc(8)).metadata().catch(() => {});

function isImage(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function chapterDirFor(chapterId, mtimeMs) {
  return path.join(config.CBZ_CACHE_DIR, `${chapterId}_${Math.floor(mtimeMs / 1000)}`);
}

function parseChapterIdFromDirName(name) {
  const us = name.indexOf('_');
  if (us <= 0) return null;
  const id = parseInt(name.slice(0, us), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function touch(chapterDir) {
  const meta = index.get(chapterDir);
  if (!meta) return;
  index.delete(chapterDir);
  index.set(chapterDir, meta);
}

function addToIndex(chapterDir, size) {
  const existing = index.get(chapterDir);
  if (existing) {
    totalBytes -= existing.size;
    index.delete(chapterDir);
  }
  index.set(chapterDir, { size });
  totalBytes += size;
  evictIfNeeded(chapterDir);
}

function updateIndexSize(chapterDir, newSize) {
  const existing = index.get(chapterDir);
  if (!existing) return;
  totalBytes -= existing.size;
  existing.size = newSize;
  totalBytes += newSize;
}

function removeFromIndex(chapterDir) {
  const meta = index.get(chapterDir);
  if (!meta) return;
  index.delete(chapterDir);
  totalBytes -= meta.size;
}

function evictChapterDir(chapterDir) {
  removeFromIndex(chapterDir);
  fs.rm(chapterDir, { recursive: true, force: true }, () => {});
}

// Returns the set of chapterDirs currently mid-extraction (Phase 1 or Phase 2
// not yet complete). Eviction must avoid wiping these — Phase 2 is still
// writing into them, and the user has an open reader holding their page IDs.
function activeExtractionDirs() {
  const out = new Set();
  for (const dir of chapterStates.keys()) out.add(dir);
  return out;
}

// Auto-clear: when the cache hits its size cap, evict cached chapter
// directories starting with the least-recently-used. The optional
// `protectedDir` keeps a specific chapter on disk — the one that just
// triggered the overflow — so the caller that drove the addition (a reader
// opening a chapter, the regenerate-thumbnails loop) still gets a working
// file. Any directory currently in `chapterStates` (Phase 1 still in flight,
// Phase 2 still running) is also skipped — clobbering an in-progress
// extraction would corrupt the caller's view of the cache.
function evictIfNeeded(protectedDir = null) {
  if (totalBytes <= cacheLimitBytes) return;
  const active = activeExtractionDirs();
  let evicted = 0;
  let evictedBytes = 0;
  // Iterate insertion-order (oldest first) so we evict LRU.
  for (const [chapterDir, meta] of Array.from(index)) {
    if (totalBytes <= cacheLimitBytes) break;
    if (chapterDir === protectedDir) continue;
    if (active.has(chapterDir)) continue;
    evictChapterDir(chapterDir);
    evicted++;
    evictedBytes += meta.size;
  }
  if (evicted > 0) {
    const freedGb = (evictedBytes / 1024 / 1024 / 1024).toFixed(2);
    const limGb   = (cacheLimitBytes / 1024 / 1024 / 1024).toFixed(2);
    console.log(
      `[CBZ Cache] Cap reached (${limGb} GB) — evicted ${evicted} chapter` +
      `${evicted === 1 ? '' : 's'} (${freedGb} GB freed)`
    );
  }
}

/**
 * Update the cache cap at runtime. Immediately evicts the least-recently-used
 * chapter directories if the new cap is below the current total.
 */
function setLimitBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Cache limit must be a positive number of bytes');
  }
  cacheLimitBytes = Math.floor(n);
  evictIfNeeded();
}

// Remove any sibling directories matching `<chapterId>_*` other than the
// current one. Called before extracting a new mtime to reclaim space from
// outdated extractions of the same chapter.
function cleanupStaleForChapter(chapterId, currentDir) {
  let entries;
  try { entries = fs.readdirSync(config.CBZ_CACHE_DIR, { withFileTypes: true }); }
  catch { return; }
  const prefix = `${chapterId}_`;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith(prefix)) continue;
    const full = path.join(config.CBZ_CACHE_DIR, e.name);
    if (full === currentDir) continue;
    // Don't wipe a sibling that's in active use (would be weird but defensive).
    if (chapterStates.has(full)) continue;
    evictChapterDir(full);
  }
}

function dirSizeSync(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { total += fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
  }
  return total;
}

// ── Central-directory planning ────────────────────────────────────────────
// Read the CBZ's central directory and compute deterministic per-page output
// filenames. No bytes are decompressed; the cost is one open + a walk of the
// directory entries. Used by both modes to seed `pages` rows before any
// extraction starts.
//
// Returns: { entries, plannedPages } where plannedPages[i] = {
//   pageIndex, originalName, cacheFilename, ext
// } in natural-sort order matching the eventual extraction order.

function planChapterPages(cbzPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(cbzPath, { lazyEntries: true, autoClose: false }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr || new Error('zip open failed'));
      const entries = [];
      zip.on('entry', (entry) => {
        if (!entry.fileName.endsWith('/') && isImage(entry.fileName)) {
          entries.push(entry);
        }
        zip.readEntry();
      });
      zip.on('error', (e) => { try { zip.close(); } catch {} reject(e); });
      zip.on('end', () => {
        // Natural-sort on the basename only — archive directory prefixes would
        // otherwise group out-of-order (e.g. `_cover/` before `pages/001.jpg`).
        entries.sort((a, b) => naturalSort(path.basename(a.fileName), path.basename(b.fileName)));
        const pad = Math.max(4, String(entries.length).length);
        const plannedPages = entries.map((entry, i) => {
          const ext = (path.extname(entry.fileName) || '.jpg').toLowerCase();
          return {
            pageIndex:    i,
            originalName: path.basename(entry.fileName),
            cacheFilename: String(i + 1).padStart(pad, '0') + ext,
            ext,
          };
        });
        // Caller owns the zip handle from here on.
        resolve({ zip, entries, plannedPages });
      });
      zip.readEntry();
    });
  });
}

// ── Dimension probe (Phase 1 only) ────────────────────────────────────────
// Read just enough of each entry to get `sharp.metadata()` to return width
// and height, then stop. Costs a fraction of a full extract per page; the
// trade-off is that we touch every entry twice (probe + later extract) but
// only the second pass writes bytes to disk.
//
// `signal` is an AbortSignal that aborts the work if the chapter is
// cancelled (manga deleted while we're probing).

async function probeChapterDimensions(zip, entries, plannedPages, signal) {
  if (signal?.aborted) return new Map();
  const dims = new Map(); // pageIndex -> { width, height }

  async function probeOne(i) {
    if (signal?.aborted) return;
    const entry = entries[i];
    const pageIdx = plannedPages[i].pageIndex;
    try {
      const buf = await new Promise((res, rej) => {
        zip.openReadStream(entry, (sErr, stream) => {
          if (sErr) return rej(sErr);
          const chunks = [];
          let read = 0;
          let resolved = false;
          stream.on('data', (c) => {
            if (resolved) return;
            chunks.push(c);
            read += c.length;
            if (read >= DIM_PROBE_BUFFER_BYTES) {
              resolved = true;
              stream.destroy();
              res(Buffer.concat(chunks, read));
            }
          });
          stream.on('end', () => {
            if (!resolved) {
              resolved = true;
              res(Buffer.concat(chunks, read));
            }
          });
          stream.on('error', (e) => { if (!resolved) { resolved = true; rej(e); } });
          stream.on('close', () => {
            // Some readable streams emit close without end after destroy().
            // Make sure we resolve so the probe doesn't hang.
            if (!resolved) {
              resolved = true;
              res(Buffer.concat(chunks, read));
            }
          });
        });
      });
      if (signal?.aborted) return;
      const meta = await sharp(buf).metadata();
      dims.set(pageIdx, {
        width:  meta.width  || null,
        height: meta.height || null,
      });
    } catch {
      dims.set(pageIdx, { width: null, height: null });
    }
  }

  // Bounded-concurrency worker pool.
  const tasks = entries.map((_, i) => i);
  await Promise.all(
    Array.from({ length: Math.min(DIM_PROBE_CONCURRENCY, tasks.length) }, async () => {
      while (tasks.length) {
        const i = tasks.shift();
        if (i === undefined) break;
        await probeOne(i);
      }
    })
  );

  return dims;
}

// ── Single-entry extract helper ───────────────────────────────────────────
// Decompresses one ZIP entry to <chapterDir>/<cacheFilename>, writing via
// `.tmp` + rename so a crash never leaves a half-written file in place.
// Resolves with the on-disk size.
function extractOneEntry(zip, entry, chapterDir, cacheFilename) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (sErr, stream) => {
      if (sErr) return reject(sErr);
      const target = path.join(chapterDir, cacheFilename);
      const tmp = target + '.tmp';
      const out = fs.createWriteStream(tmp);
      let written = 0;
      stream.on('data', (c) => { written += c.length; });
      stream.on('error', (e) => { out.destroy(); fs.unlink(tmp, () => {}); reject(e); });
      out.on('error', (e) => { fs.unlink(tmp, () => {}); reject(e); });
      out.on('finish', () => {
        fs.rename(tmp, target, (rnErr) => {
          if (rnErr) { fs.unlink(tmp, () => {}); return reject(rnErr); }
          resolve(written);
        });
      });
      stream.pipe(out);
    });
  });
}

function isChapterRemovedError(e) {
  return e && (e.code === 'CHAPTER_REMOVED' || e.code === 'ARCHIVE_REMOVED');
}

function makeChapterRemovedError(reason) {
  const e = new Error(reason || 'Chapter cache was cancelled');
  e.code = 'CHAPTER_REMOVED';
  return e;
}

function makeArchiveRemovedError() {
  const e = new Error('Archive disappeared while extracting');
  e.code = 'ARCHIVE_REMOVED';
  return e;
}

// ── Chapter state slot ────────────────────────────────────────────────────
// Created on first ensure* call for a (chapterId, mtime) pair. Removed when
// the state's phase2 promise settles (success or abort) and the dir is
// either fully extracted or cleaned up.

function buildState({ chapterId, chapterDir, totalPages, onPageExtracted = null }) {
  return {
    chapterId,
    chapterDir,
    totalPages,
    extracted: new Set(),       // cacheFilenames already on disk
    pageWaiters: new Map(),     // cacheFilename -> [{ resolve, reject }, ...]
    priorityIndices: [],        // page indices the worker should jump ahead to
    abortController: new AbortController(),
    failed: null,               // set if Phase 2 errored fatally
    phase1: null,
    phase2: null,
    // Fire-and-forget hook invoked by runPhase2 after each successful entry
    // extract — `(pageIndex, absPath) => void | Promise<void>`. Set by the
    // pages.js route in fast mode so a sharp.metadata() re-probe can backfill
    // dims for any page whose Phase 1 header sniff returned null. Errors
    // inside the callback are swallowed by the invoker so a dim-update
    // failure never breaks extraction forward progress.
    onPageExtracted,
  };
}

function rejectAllWaiters(state, err) {
  for (const list of state.pageWaiters.values()) {
    for (const w of list) {
      try { w.reject(err); } catch {}
    }
  }
  state.pageWaiters.clear();
}

function notifyPageReady(state, cacheFilename) {
  state.extracted.add(cacheFilename);
  const list = state.pageWaiters.get(cacheFilename);
  if (!list) return;
  state.pageWaiters.delete(cacheFilename);
  for (const w of list) {
    try { w.resolve(); } catch {}
  }
}

// ── Public: cancellation ──────────────────────────────────────────────────
// Called when a chapter row is removed (manga delete, library delete,
// rename, scanner pruning). Aborts any in-flight extraction, rejects every
// open waiter, removes the on-disk dir, drops the state slot.
//
// Returns the number of state slots that were cancelled (0 when there was
// nothing in flight — common case, callers don't need to gate on it).

function cancelChapter(chapterId, reason = 'Chapter removed') {
  let cancelled = 0;
  for (const [dir, state] of Array.from(chapterStates)) {
    if (state.chapterId !== chapterId) continue;
    try { state.abortController.abort(); } catch {}
    const err = makeChapterRemovedError(reason);
    state.failed = err;
    rejectAllWaiters(state, err);
    chapterStates.delete(dir);
    removeFromIndex(dir);
    fs.rm(dir, { recursive: true, force: true }, () => {});
    cancelled++;
  }
  return cancelled;
}

function cancelChapters(chapterIds, reason = 'Chapter removed') {
  let total = 0;
  for (const id of chapterIds) total += cancelChapter(id, reason);
  return total;
}

// ── Public: orphan audit ──────────────────────────────────────────────────
// Walk CBZ_CACHE_DIR; remove any subdir whose <chapterId> prefix doesn't
// correspond to a live chapter row of type 'cbz'. Closes the watcher's
// depth-0 / unlinkDir blind spot — a manga folder deleted while the server
// was running won't have triggered an unlinkDir event, but the next call to
// auditOrphans (end of scanLibrary, startup) will reap the dead cache dirs.
//
// Defensive: never wipes a directory that's currently in chapterStates
// (Phase 2 still writing into it) even if the chapter row appears missing
// — concurrent rename + new-id resolution would otherwise tear an in-flight
// extraction. The next audit pass after extraction completes will clean it
// up if it's still orphaned.

function auditOrphans(db, { dryRun = false } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(config.CBZ_CACHE_DIR, { withFileTypes: true });
  } catch {
    return { orphans_removed: 0, bytes_freed: 0 };
  }

  let knownIds;
  try {
    knownIds = new Set(
      db.prepare("SELECT id FROM chapters WHERE type = 'cbz'").all().map(r => r.id)
    );
  } catch {
    return { orphans_removed: 0, bytes_freed: 0 };
  }

  let orphansRemoved = 0;
  let bytesFreed = 0;

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(config.CBZ_CACHE_DIR, e.name);
    if (chapterStates.has(full)) continue; // active extraction — leave alone
    const chId = parseChapterIdFromDirName(e.name);
    if (chId === null) continue;            // foreign / unrecognised dir name
    if (knownIds.has(chId)) continue;       // legitimate

    const size = index.get(full)?.size ?? dirSizeSync(full);
    if (!dryRun) {
      removeFromIndex(full);
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    orphansRemoved++;
    bytesFreed += size;
  }

  if (orphansRemoved > 0) {
    const verb = dryRun ? 'would remove' : 'removed';
    const gb = (bytesFreed / 1024 / 1024 / 1024).toFixed(2);
    console.log(`[CBZ Cache] Orphan audit ${verb} ${orphansRemoved} stale directories (${gb} GB).`);
  }

  return { orphans_removed: orphansRemoved, bytes_freed: bytesFreed };
}

// ── Phase 2 scheduler ─────────────────────────────────────────────────────
// Bounded concurrency across the whole library — keeps a burst of opens
// from spawning unbounded sharp work. Each phase2() invocation is wrapped
// in a slot acquire/release. Cancelled chapters release their slot via the
// AbortSignal exit path.

function acquirePhase2Slot() {
  return new Promise(resolve => {
    if (phase2Active < PHASE2_CONCURRENCY) {
      phase2Active++;
      return resolve();
    }
    phase2Queue.push(resolve);
  });
}

function releasePhase2Slot() {
  phase2Active--;
  const next = phase2Queue.shift();
  if (next) { phase2Active++; next(); }
}

// ── Phase 2 worker ────────────────────────────────────────────────────────
// Extracts every entry not yet on disk, in priority-then-index order. Stats
// the source CBZ every PHASE2_RESTAT_INTERVAL pages to detect rename /
// rewrite / delete mid-flight. Writes `.ready` at the end, adds the dir to
// the cache index with the real size, and resolves.

async function runPhase2({ state, cbzPath, baseStat }) {
  const { abortController, chapterDir, chapterId } = state;
  const signal = abortController.signal;
  let zip;

  await acquirePhase2Slot();
  try {
    if (signal.aborted) throw makeChapterRemovedError();

    // Open a fresh zip handle for Phase 2 — Phase 1's handle is closed by the
    // time we get here (it's released eagerly after the prefix extract so the
    // file descriptor isn't held while we wait for the Phase 2 slot).
    zip = await new Promise((res, rej) => {
      yauzl.open(cbzPath, { lazyEntries: true, autoClose: false }, (e, z) => {
        if (e || !z) return rej(e || new Error('zip open failed'));
        res(z);
      });
    });

    // Re-enumerate entries (cheap — central directory walk only) so we have a
    // fresh handle per entry for openReadStream.
    const entries = [];
    await new Promise((res, rej) => {
      zip.on('entry', (entry) => {
        if (!entry.fileName.endsWith('/') && isImage(entry.fileName)) entries.push(entry);
        zip.readEntry();
      });
      zip.on('error', rej);
      zip.on('end', res);
      zip.readEntry();
    });
    entries.sort((a, b) => naturalSort(path.basename(a.fileName), path.basename(b.fileName)));

    const pad = Math.max(4, String(entries.length).length);
    const plannedFilenames = entries.map((entry, i) => {
      const ext = (path.extname(entry.fileName) || '.jpg').toLowerCase();
      return String(i + 1).padStart(pad, '0') + ext;
    });

    let sinceRestat = 0;

    // Honour priority hints by extracting any requested indices first, in the
    // order they were registered, then fall back to ascending order.
    function nextWorkIndex(remaining) {
      while (state.priorityIndices.length) {
        const i = state.priorityIndices.shift();
        if (typeof i === 'number' && remaining.has(i)) {
          remaining.delete(i);
          return i;
        }
      }
      // Smallest remaining index — strict ascending fallback.
      let min = Infinity;
      for (const i of remaining) if (i < min) min = i;
      if (min === Infinity) return null;
      remaining.delete(min);
      return min;
    }

    const remaining = new Set();
    for (let i = 0; i < entries.length; i++) {
      if (!state.extracted.has(plannedFilenames[i])) remaining.add(i);
    }

    while (remaining.size > 0) {
      if (signal.aborted) throw makeChapterRemovedError();

      // Periodic CBZ fingerprint check — catches rename / rewrite / delete.
      if (sinceRestat >= PHASE2_RESTAT_INTERVAL) {
        sinceRestat = 0;
        let st;
        try { st = await fsp.stat(cbzPath); }
        catch { throw makeArchiveRemovedError(); }
        if (
          Math.floor(st.mtimeMs / 1000) !== Math.floor(baseStat.mtimeMs / 1000) ||
          st.size !== baseStat.size
        ) {
          throw makeArchiveRemovedError();
        }
      }

      const i = nextWorkIndex(remaining);
      if (i === null) break;

      const cacheFilename = plannedFilenames[i];
      const target = path.join(chapterDir, cacheFilename);

      // Skip if it landed via the prefix extraction or a previous run.
      let already = false;
      try { fs.statSync(target); already = true; } catch {}
      if (already) {
        notifyPageReady(state, cacheFilename);
        sinceRestat++;
        continue;
      }

      try {
        await extractOneEntry(zip, entries[i], chapterDir, cacheFilename);
      } catch (e) {
        if (isChapterRemovedError(e) || signal.aborted) throw e;
        // Single-page failure (corrupt entry). Reject the waiters for this
        // page only and continue — don't poison the whole chapter.
        const list = state.pageWaiters.get(cacheFilename);
        if (list) {
          state.pageWaiters.delete(cacheFilename);
          for (const w of list) {
            try { w.reject(e); } catch {}
          }
        }
        sinceRestat++;
        continue;
      }

      notifyPageReady(state, cacheFilename);
      sinceRestat++;

      // Fire the per-page extract hook. Fire-and-forget so a slow callback
      // (e.g. sharp.metadata() under load) never blocks Phase 2's forward
      // progress. The pages.js fast-mode path uses this to re-probe dims
      // from the extracted file and patch any null dims that Phase 1's
      // 256 KB header sniff missed. Errors are swallowed — a dim-update
      // failure should never derail extraction.
      if (state.onPageExtracted) {
        try { Promise.resolve(state.onPageExtracted(i, target)).catch(() => {}); }
        catch { /* synchronous throw — ignore */ }
      }

      // Update the reserved-size estimate every page so the index stays
      // close to reality during long Phase 2 runs.
      try {
        const sz = fs.statSync(target).size;
        const existing = index.get(chapterDir);
        if (existing) updateIndexSize(chapterDir, existing.size + sz - approxPerPage(baseStat.size, entries.length));
      } catch { /* ignore */ }
    }

    if (signal.aborted) throw makeChapterRemovedError();

    // Write the .ready marker last so a crash leaves the dir unrecoverable.
    await fsp.writeFile(path.join(chapterDir, READY_MARKER), '');

    // Reconcile reserved size with reality.
    const realSize = dirSizeSync(chapterDir);
    updateIndexSize(chapterDir, realSize);
    evictIfNeeded(chapterDir);
  } catch (err) {
    state.failed = err;
    rejectAllWaiters(state, err);
    // If we aborted because the chapter row went away or the archive vanished,
    // tear down the dir; otherwise leave whatever is on disk for the next
    // chapter-open to find (cache will detect missing .ready and re-extract).
    if (isChapterRemovedError(err) || err.code === 'ARCHIVE_REMOVED') {
      removeFromIndex(chapterDir);
      try { fs.rmSync(chapterDir, { recursive: true, force: true }); } catch {}
    }
    throw err;
  } finally {
    try { if (zip) zip.close(); } catch {}
    chapterStates.delete(chapterDir);
    releasePhase2Slot();
  }
}

// Per-page estimate used to incrementally reconcile the reserved size as
// Phase 2 runs. baseStat.size is the compressed archive size; image entries
// inside a CBZ are already image-compressed so the decompressed sum is
// approximately the archive size, within a few percent.
function approxPerPage(archiveSize, n) {
  if (!n) return 0;
  return Math.floor(archiveSize / n);
}

// ── ensureChapterExtracted (unified entry point) ──────────────────────────
//
// mode: 'full' (default — pre-feature behaviour) or 'fast'.
//
// Returns: { dir, plannedPages, freshlyExtracted, mode, extracting }
//   dir              — absolute path to the chapter's cache folder
//   plannedPages     — [{ pageIndex, originalName, cacheFilename, width, height }]
//                      Set on fresh fast or full extractions. `width`/`height`
//                      are present only in `fast` mode (probed up front).
//   freshlyExtracted — true if this call did the work (Phase 1 or full);
//                      false on cache hit
//   mode             — 'fast' or 'full'; echoes the caller's request
//   extracting       — true when fast mode and Phase 2 is still running
//
// Concurrent calls for the same chapter share the Phase 1 promise. A `full`
// caller arriving while a `fast` Phase 2 is in flight will await Phase 2's
// completion before resolving (so /api/admin/regenerate-thumbnails always
// sees a fully-extracted directory).

async function ensureChapterExtracted(chapterId, cbzPath, opts = {}) {
  const mode = opts.mode === 'fast' ? 'fast' : 'full';
  // Per-page post-extract callback — used by the fast-mode pages route to
  // re-probe dims on the extracted file. Ignored in full mode (the route
  // runs backfillDimsFromDisk after a single full extract; no per-page
  // signal needed).
  const onPageExtracted = typeof opts.onPageExtracted === 'function' ? opts.onPageExtracted : null;
  let stat;
  try { stat = await fsp.stat(cbzPath); }
  catch (e) {
    if (e.code === 'ENOENT') {
      const err = new Error('CBZ file not found');
      err.code = 'ENOENT';
      throw err;
    }
    throw e;
  }
  const dir = chapterDirFor(chapterId, stat.mtimeMs);
  const readyPath = path.join(dir, READY_MARKER);

  // In-memory cache hit.
  if (index.has(dir)) {
    try {
      await fsp.access(readyPath);
      touch(dir);
      return { dir, plannedPages: null, freshlyExtracted: false, mode, extracting: false };
    } catch {
      // Marker gone — treat as corrupt and re-extract.
      evictChapterDir(dir);
    }
  }

  // Another caller is mid-extraction for this exact dir. Wait on their state.
  if (chapterStates.has(dir)) {
    const existing = chapterStates.get(dir);
    if (mode === 'full') {
      // Full-mode callers need the .ready marker before returning. Phase 1 +
      // Phase 2 both resolve on the same `phase2` promise.
      await existing.phase1.catch((e) => { if (isChapterRemovedError(e)) throw e; });
      await existing.phase2.catch((e) => { if (isChapterRemovedError(e)) throw e; });
      return { dir, plannedPages: null, freshlyExtracted: false, mode, extracting: false };
    }
    // Fast-mode callers can return as soon as Phase 1 is done.
    const phase1Result = await existing.phase1;
    return {
      dir,
      plannedPages: phase1Result.plannedPages,
      freshlyExtracted: false,
      mode,
      extracting: !!existing.phase2 && existing.phase2.then ? true : false,
    };
  }

  // On-disk hit from a previous run that init() hasn't walked yet.
  try {
    await fsp.access(readyPath);
    const size = dirSizeSync(dir);
    addToIndex(dir, size);
    return { dir, plannedPages: null, freshlyExtracted: false, mode, extracting: false };
  } catch { /* need to extract */ }

  if (mode === 'full') {
    return runFullExtract({ chapterId, cbzPath, stat, dir });
  }
  return runFastExtract({ chapterId, cbzPath, stat, dir, resumePage: opts.resumePage, onPageExtracted });
}

// ── Full (legacy) extraction ──────────────────────────────────────────────
// Single-shot: extract every entry, write .ready, return. Behaviour-compat
// with the pre-feature code path.

async function runFullExtract({ chapterId, cbzPath, stat, dir }) {
  cleanupStaleForChapter(chapterId, dir);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dir, { recursive: true });

  const state = buildState({ chapterId, chapterDir: dir, totalPages: 0 });
  chapterStates.set(dir, state);
  // Reserve approximate size so a parallel chapter-open can't evict us
  // mid-extract.
  addToIndex(dir, stat.size);

  let zip;
  const phase2 = (async () => {
    try {
      const planned = await planChapterPages(cbzPath);
      zip = planned.zip;
      const { entries, plannedPages } = planned;
      state.totalPages = entries.length;

      for (let i = 0; i < entries.length; i++) {
        if (state.abortController.signal.aborted) throw makeChapterRemovedError();
        await extractOneEntry(zip, entries[i], dir, plannedPages[i].cacheFilename);
        notifyPageReady(state, plannedPages[i].cacheFilename);
      }

      await fsp.writeFile(path.join(dir, READY_MARKER), '');
      const realSize = dirSizeSync(dir);
      updateIndexSize(dir, realSize);
      evictIfNeeded(dir);
      return { plannedPages };
    } catch (err) {
      state.failed = err;
      rejectAllWaiters(state, err);
      if (isChapterRemovedError(err)) {
        removeFromIndex(dir);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      throw err;
    } finally {
      try { if (zip) zip.close(); } catch {}
      chapterStates.delete(dir);
    }
  })();

  state.phase1 = phase2; // full mode collapses phase1 onto phase2
  state.phase2 = phase2;

  const { plannedPages } = await phase2;
  return { dir, plannedPages, freshlyExtracted: true, mode: 'full', extracting: false };
}

// ── Fast extraction ───────────────────────────────────────────────────────
// Phase 1: plan + probe dims + extract FAST_PREFIX (plus optional resume
// window) pages. Resolves once those files are on disk and the planned-page
// metadata is ready.
// Phase 2: background worker extracts the remainder in ascending order, with
// priority indices serviced first.

async function runFastExtract({ chapterId, cbzPath, stat, dir, resumePage, onPageExtracted }) {
  cleanupStaleForChapter(chapterId, dir);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dir, { recursive: true });

  const state = buildState({ chapterId, chapterDir: dir, totalPages: 0, onPageExtracted });
  chapterStates.set(dir, state);
  addToIndex(dir, stat.size);

  const phase1 = (async () => {
    let zip;
    try {
      const planned = await planChapterPages(cbzPath);
      zip = planned.zip;
      const { entries, plannedPages } = planned;
      state.totalPages = entries.length;

      // Dim probe across every entry — cheap stream sniff, no disk writes.
      const dims = await probeChapterDimensions(zip, entries, plannedPages, state.abortController.signal);
      if (state.abortController.signal.aborted) throw makeChapterRemovedError();
      const plannedWithDims = plannedPages.map(p => ({
        ...p,
        ...(dims.get(p.pageIndex) || { width: null, height: null }),
      }));

      // Build the prefix set: the first FAST_PREFIX entries, plus a small
      // window around the resume page when supplied.
      const prefixSet = new Set();
      for (let i = 0; i < Math.min(FAST_PREFIX, entries.length); i++) prefixSet.add(i);
      if (Number.isInteger(resumePage) && resumePage >= 0 && resumePage < entries.length) {
        for (let i = Math.max(0, resumePage - 1); i <= Math.min(entries.length - 1, resumePage + 2); i++) {
          prefixSet.add(i);
        }
      }

      for (const i of Array.from(prefixSet).sort((a, b) => a - b)) {
        if (state.abortController.signal.aborted) throw makeChapterRemovedError();
        await extractOneEntry(zip, entries[i], dir, plannedWithDims[i].cacheFilename);
        notifyPageReady(state, plannedWithDims[i].cacheFilename);
        // Per-page hook for prefix entries too — Phase 1's 256 KB header
        // sniff may have missed dims even on pages we extracted in full.
        // sharp.metadata() on the on-disk file is the reliable source.
        if (state.onPageExtracted) {
          const target = path.join(dir, plannedWithDims[i].cacheFilename);
          try { Promise.resolve(state.onPageExtracted(i, target)).catch(() => {}); }
          catch { /* synchronous throw — ignore */ }
        }
      }

      // Close the Phase 1 zip handle now that the prefix is on disk; Phase 2
      // opens a fresh handle so we don't hold an FD across the slot wait.
      try { zip.close(); } catch {}
      zip = null;

      return { plannedPages: plannedWithDims };
    } catch (err) {
      state.failed = err;
      rejectAllWaiters(state, err);
      try { if (zip) zip.close(); } catch {}
      if (isChapterRemovedError(err)) {
        removeFromIndex(dir);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        chapterStates.delete(dir);
      }
      throw err;
    }
  })();

  state.phase1 = phase1;

  // Phase 2 kicks off as soon as Phase 1 settles. Failures in Phase 1 abort
  // Phase 2 too (no point trying to extract more if planning failed).
  state.phase2 = phase1.then(async () => {
    if (state.failed) return;
    await runPhase2({ state, cbzPath, baseStat: stat });
  }).catch(() => { /* swallowed — failure already recorded on state */ });

  // Surface unhandled rejections from Phase 1 so the caller sees them.
  const result = await phase1;
  return {
    dir,
    plannedPages: result.plannedPages,
    freshlyExtracted: true,
    mode: 'fast',
    extracting: true,
  };
}

// ── Public: waiter for a specific page file ───────────────────────────────
// Called by GET /api/pages/:id/image when the requested page hasn't landed
// on disk yet. Resolves when the rename-into-place succeeds for that
// cacheFilename. Rejects on cancellation (410 Gone), Phase 2 fatal, or
// timeout (503-style retry).

function waitForPageFile(chapterDir, cacheFilename, { timeoutMs = PAGE_WAIT_TIMEOUT_MS } = {}) {
  const state = chapterStates.get(chapterDir);
  if (!state) {
    // No active extraction — either fully done (file should exist) or evicted.
    // The caller will fall back to a fresh ensureChapterExtracted; rejecting
    // here lets that path re-establish state.
    const e = new Error('No active extraction for this chapter');
    e.code = 'NO_ACTIVE_EXTRACTION';
    return Promise.reject(e);
  }
  if (state.failed) return Promise.reject(state.failed);
  if (state.extracted.has(cacheFilename)) return Promise.resolve();

  // Backpressure: refuse to queue more than N waiters per chapter so a key-
  // mashing user can't pin arbitrary numbers of HTTP slots.
  const totalWaiters = Array.from(state.pageWaiters.values()).reduce((n, list) => n + list.length, 0);
  if (totalWaiters >= MAX_WAITERS_PER_CHAPTER) {
    const e = new Error('Too many concurrent waiters');
    e.code = 'WAITER_OVERLOAD';
    return Promise.reject(e);
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    const list = state.pageWaiters.get(cacheFilename) || [];
    list.push(waiter);
    state.pageWaiters.set(cacheFilename, list);

    const timer = setTimeout(() => {
      const cur = state.pageWaiters.get(cacheFilename);
      if (cur) {
        const idx = cur.indexOf(waiter);
        if (idx !== -1) cur.splice(idx, 1);
        if (cur.length === 0) state.pageWaiters.delete(cacheFilename);
      }
      const e = new Error('Timed out waiting for page extraction');
      e.code = 'PAGE_WAIT_TIMEOUT';
      reject(e);
    }, timeoutMs);

    // Wrap so the timer clears when the waiter settles via notifyPageReady.
    const origResolve = waiter.resolve;
    const origReject  = waiter.reject;
    waiter.resolve = (v) => { clearTimeout(timer); origResolve(v); };
    waiter.reject  = (e) => { clearTimeout(timer); origReject(e);  };
  });
}

// ── Public: priority hints ────────────────────────────────────────────────
// Move the named page indices to the front of the Phase 2 work queue, so a
// scrubber jump or resume-position landing extracts target pages before the
// scanner runs out of work elsewhere. No-op when there's no active fast
// extraction.

function prioritizePages(chapterId, pageIndices) {
  if (!Array.isArray(pageIndices) || pageIndices.length === 0) return 0;
  let touched = 0;
  for (const state of chapterStates.values()) {
    if (state.chapterId !== chapterId) continue;
    for (const i of pageIndices) {
      if (typeof i !== 'number' || !Number.isInteger(i)) continue;
      if (i < 0 || i >= state.totalPages) continue;
      if (!state.priorityIndices.includes(i)) state.priorityIndices.push(i);
    }
    touched++;
  }
  return touched;
}

/**
 * Resolve a CBZ page to an absolute on-disk file path, extracting the chapter
 * first if needed. Used by thumbnail/cover callers that just need raw bytes
 * and don't go through the paged reader flow. Always uses full mode so the
 * caller sees a complete directory listing.
 */
async function getCbzPageFile(chapterId, cbzPath, pageIndex) {
  const { dir } = await ensureChapterExtracted(chapterId, cbzPath, { mode: 'full' });
  const files = fs.readdirSync(dir).filter(f => f !== READY_MARKER && !f.endsWith('.tmp'));
  files.sort(naturalSort);
  if (pageIndex < 0 || pageIndex >= files.length) {
    throw new Error(`Page index ${pageIndex} out of range (0..${files.length - 1})`);
  }
  return path.join(dir, files[pageIndex]);
}

/**
 * Scan CBZ_CACHE_DIR and rebuild the in-memory index. Warm cache from the
 * previous run is preserved across restarts. Directories without a `.ready`
 * marker (partial extractions from a crashed run) are removed.
 */
function init(limitBytes) {
  if (limitBytes != null) {
    const n = Number(limitBytes);
    if (Number.isFinite(n) && n > 0) cacheLimitBytes = Math.floor(n);
  }
  index.clear();
  totalBytes = 0;
  chapterStates.clear();

  const root = config.CBZ_CACHE_DIR;
  let chapterDirs;
  try {
    chapterDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    fs.mkdirSync(root, { recursive: true });
    return;
  }

  for (const dirEnt of chapterDirs) {
    if (!dirEnt.isDirectory()) continue;
    const full = path.join(root, dirEnt.name);
    const ready = path.join(full, READY_MARKER);
    if (!fs.existsSync(ready)) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
      continue;
    }
    // Sweep any stray .tmp files from a partial extraction.
    try {
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith('.tmp')) {
          try { fs.unlinkSync(path.join(full, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    const size = dirSizeSync(full);
    index.set(full, { size });
    totalBytes += size;
  }

  if (index.size > 0) {
    const gb = (totalBytes / 1024 / 1024 / 1024).toFixed(2);
    const limGb = (cacheLimitBytes / 1024 / 1024 / 1024).toFixed(1);
    console.log(`[CBZ Cache] Loaded ${index.size} chapter${index.size === 1 ? '' : 's'} (${gb} GB / ${limGb} GB)`);
  }
  evictIfNeeded();
}

/** Remove every cached chapter directory. */
function wipe() {
  // Abort every in-flight extraction first so Phase 2 doesn't re-create
  // directories we're about to wipe.
  for (const [, state] of chapterStates) {
    try { state.abortController.abort(); } catch {}
    rejectAllWaiters(state, makeChapterRemovedError('Cache wiped'));
  }
  chapterStates.clear();

  const root = config.CBZ_CACHE_DIR;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      try { fs.rmSync(path.join(root, e.name), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* dir missing — fine */ }
  index.clear();
  totalBytes = 0;
}

function stats() {
  return {
    size_bytes: totalBytes,
    limit_bytes: cacheLimitBytes,
    entries: index.size,
    in_progress_extractions: chapterStates.size,
  };
}

module.exports = {
  ensureChapterExtracted,
  getCbzPageFile,
  waitForPageFile,
  prioritizePages,
  cancelChapter,
  cancelChapters,
  auditOrphans,
  init,
  wipe,
  stats,
  setLimitBytes,
  DEFAULT_CACHE_LIMIT_BYTES,
  // Exposed so route handlers can route 'CHAPTER_REMOVED' / 'ARCHIVE_REMOVED'
  // to HTTP 410.
  isChapterRemovedError,
};
