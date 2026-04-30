const fs = require('fs');
const path = require('path');
const config = require('../config');

const CACHE_DIR = path.join(config.DATA_PATH, 'metadata-cache');

const VALID_SOURCES = new Set(['anilist', 'myanimelist', 'mangaupdates']);

function sourceDir(source) {
  return path.join(CACHE_DIR, source);
}

function cachePath(source, id) {
  return path.join(sourceDir(source), `${id}.json`);
}

function ensureDir(source) {
  fs.mkdirSync(sourceDir(source), { recursive: true });
}

/**
 * Read a previously-fetched normalized metadata record from the on-disk cache.
 * Returns the parsed object or null if the file is missing / unreadable.
 */
function getCached(source, id) {
  if (!VALID_SOURCES.has(source) || id === null || id === undefined) return null;
  const p = cachePath(source, id);
  try {
    const text = fs.readFileSync(p, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Write-through write of a normalized metadata record. Best-effort — never
 * throws so a cache write failure can't break the upstream fetch path.
 */
function setCached(source, id, record) {
  if (!VALID_SOURCES.has(source) || id === null || id === undefined || !record) return;
  try {
    ensureDir(source);
    const payload = { ...record, _cached_at: Math.floor(Date.now() / 1000) };
    fs.writeFileSync(cachePath(source, id), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[MetadataCache] Failed to write ${source}/${id}: ${err.message}`);
  }
}

module.exports = { getCached, setCached };
