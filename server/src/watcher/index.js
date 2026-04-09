const chokidar = require('chokidar');
const path = require('path');
const { scanMangaDirectory } = require('../scanner/libraryScanner');

const DEBOUNCE_MS = 3000;

// Map of libraryId -> { watcher, libraryPath }
const watchers = new Map();
// Debounce map: mangaPath -> timer
const pending = new Map();

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

  function handleChange(filePath) {
    const rel = path.relative(library.path, filePath);
    const topLevel = rel.split(path.sep)[0];
    if (!topLevel) return;

    const mangaPath = path.join(library.path, topLevel);

    if (pending.has(mangaPath)) clearTimeout(pending.get(mangaPath));

    const timer = setTimeout(async () => {
      pending.delete(mangaPath);
      console.log(`[Watcher] Change in library "${library.name}": ${topLevel}`);
      try {
        await scanMangaDirectory(mangaPath, topLevel, library.id);
      } catch (err) {
        console.error(`[Watcher] Scan error for ${topLevel}:`, err.message);
      }
    }, DEBOUNCE_MS);

    pending.set(mangaPath, timer);
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
}

module.exports = { startWatcher, addLibraryWatch, removeLibraryWatch };
