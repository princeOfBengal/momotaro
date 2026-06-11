const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const { scanMangaDirectory } = require('../scanner/libraryScanner');

// How long to wait after the last top-level event for a manga before acting.
const DEBOUNCE_MS = 3000;

// Stabilization poll. The watcher runs at depth 0, so it only sees the
// top-level manga folder appear/change — it does NOT see chapters being
// copied *inside* that folder. A new series is therefore announced by a
// single `addDir` at the very start of the copy, while its (potentially
// dozens of) chapters are still streaming in. Scanning immediately would
// index only the handful of chapters written so far.
//
// To avoid that, once the debounce fires we poll a cheap recursive signature
// of the manga folder (entry count + total size + newest mtime) and wait
// until it holds steady across one poll interval before scanning. This lets a
// 50-chapter drop finish copying before we index it, so all 50 populate
// without the user having to press Rescan. The poll is scoped to the single
// affected folder, so it never re-introduces the per-directory watch cost
// that depth-0 watching deliberately avoids.
const STABLE_POLL_MS = 2000;
const STABLE_MAX_WAIT_MS = 300000; // give very large copies up to 5 minutes to settle

// Map of libraryId -> { watcher, libraryPath }
const watchers = new Map();
// Debounce map: mangaPath -> timer
const pending = new Map();
// Manga folders with a scan currently in flight, so overlapping events don't
// kick off two concurrent scans of the same folder.
const scanning = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cheap recursive fingerprint of a manga folder used to detect when an
 * in-progress copy has finished. Walks the folder iteratively (single manga
 * folder, so the cost is bounded and local) and combines entry count, total
 * byte size, and newest mtime. Any add/remove/append changes the result.
 */
function folderSignature(dir) {
  let count = 0;
  let size = 0;
  let maxMtime = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      count++;
      if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
      if (entry.isDirectory()) stack.push(full);
      else size += stat.size;
    }
  }
  return `${count}:${size}:${maxMtime}`;
}

/**
 * Wait for a manga folder to stop changing, then rescan it. Polls
 * folderSignature until two consecutive reads match (copy finished) or the
 * max wait elapses, then runs a full single-folder scan so every chapter that
 * landed is indexed.
 */
async function scanWhenStable(mangaPath, folderName, library) {
  const startedAt = Date.now();
  let previous = folderSignature(mangaPath);
  while (Date.now() - startedAt < STABLE_MAX_WAIT_MS) {
    await sleep(STABLE_POLL_MS);
    // Folder vanished mid-wait (moved/deleted) — let the scan handle cleanup.
    if (!fs.existsSync(mangaPath)) break;
    const current = folderSignature(mangaPath);
    if (current === previous) break; // settled
    previous = current;
  }
  // The library may have been removed (and its rows deleted) while we waited
  // out the copy — up to STABLE_MAX_WAIT_MS. Don't resurrect manga/chapter rows
  // for a library that's no longer watched. Library IDs are AUTOINCREMENT, so
  // this can't false-match a different library.
  if (!watchers.has(library.id)) return;
  await scanMangaDirectory(mangaPath, folderName, library.id, { source: 'watcher' });
}

/**
 * Start file watchers for an array of library objects.
 * @param {{ id: number, name: string, path: string }[]} libraries
 */
function startWatcher(libraries) {
  for (const library of libraries) {
    addLibraryWatch(library);
  }
}

/**
 * Begin watching a single library path.
 * Safe to call multiple times — skips if already watching.
 * @param {{ id: number, name: string, path: string }} library
 */
function addLibraryWatch(library) {
  if (watchers.has(library.id)) return;

  const watcher = chokidar.watch(library.path, {
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });

  function triggerScan(mangaPath, topLevel) {
    // A scan is already running for this folder — re-arm the debounce so we
    // pick up whatever changed once it finishes, rather than running a second
    // concurrent scan of the same folder.
    if (scanning.has(mangaPath)) {
      scheduleScan(mangaPath, topLevel);
      return;
    }
    scanning.add(mangaPath);
    console.log(`[Watcher] Change in library "${library.name}": ${topLevel} — rescanning folder`);
    scanWhenStable(mangaPath, topLevel, library)
      .catch(err => console.error(`[Watcher] Scan error for ${topLevel}:`, err.message))
      .finally(() => scanning.delete(mangaPath));
  }

  function scheduleScan(mangaPath, topLevel) {
    if (pending.has(mangaPath)) clearTimeout(pending.get(mangaPath));
    const timer = setTimeout(() => {
      pending.delete(mangaPath);
      triggerScan(mangaPath, topLevel);
    }, DEBOUNCE_MS);
    pending.set(mangaPath, timer);
  }

  function handleChange(filePath) {
    const rel = path.relative(library.path, filePath);
    const topLevel = rel.split(path.sep)[0];
    if (!topLevel) return;
    scheduleScan(path.join(library.path, topLevel), topLevel);
  }

  watcher.on('add',    handleChange);
  watcher.on('addDir', handleChange);
  watcher.on('change', handleChange);
  watcher.on('unlink', handleChange);
  watcher.on('error',  err => console.error(`[Watcher] Error (${library.name}):`, err));

  watchers.set(library.id, { watcher, libraryPath: library.path });
  console.log(`[Watcher] Watching library "${library.name}": ${library.path}`);
}

/**
 * Stop watching a library and clean up its watcher.
 * @param {number} libraryId
 */
async function removeLibraryWatch(libraryId) {
  const entry = watchers.get(libraryId);
  if (!entry) return;
  await entry.watcher.close();
  watchers.delete(libraryId);

  // Cancel any debounce timers still pending for folders under this library so
  // a late-firing timer can't kick off a scan (and re-create rows) for a
  // library that's just been removed. Deleting Map entries mid-iteration is
  // safe. An already-running scanWhenStable poll can't be cancelled, but it
  // finishes on its own and is harmless.
  const prefix = entry.libraryPath + path.sep;
  for (const [mangaPath, timer] of pending) {
    if (mangaPath === entry.libraryPath || mangaPath.startsWith(prefix)) {
      clearTimeout(timer);
      pending.delete(mangaPath);
    }
  }
}

module.exports = { startWatcher, addLibraryWatch, removeLibraryWatch };
