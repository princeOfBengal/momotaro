const fs = require('fs');
const path = require('path');
const config = require('../config');

// Thumbnails are sharded into 256 subdirectories (00–ff) based on the
// leading numeric ID in the filename. This keeps any single directory
// under ~400 entries even at 100 000 manga, which NTFS and ext4 handle
// far more efficiently than a single 50 000+ entry folder.
//
// File name conventions: all thumbnails start with the manga id, e.g.
//   5.webp, 5_anilist.webp, 5_original.webp, 5_1713200000000.webp
// The shard is `id % 256` rendered as a two-digit lowercase hex string.

function shardFor(filename) {
  const m = String(filename).match(/^(\d+)/);
  if (!m) return null;
  return (parseInt(m[1], 10) % 256).toString(16).padStart(2, '0');
}

function thumbnailPath(filename) {
  const shard = shardFor(filename);
  if (!shard) return path.join(config.THUMBNAIL_DIR, filename);
  return path.join(config.THUMBNAIL_DIR, shard, filename);
}

function thumbnailUrl(filename) {
  const shard = shardFor(filename);
  if (!shard) return `/thumbnails/${filename}`;
  return `/thumbnails/${shard}/${filename}`;
}

function ensureShardDir(filename) {
  const shard = shardFor(filename);
  if (!shard) {
    fs.mkdirSync(config.THUMBNAIL_DIR, { recursive: true });
    return;
  }
  fs.mkdirSync(path.join(config.THUMBNAIL_DIR, shard), { recursive: true });
}

// One-time migration: walk THUMBNAIL_DIR and relocate any flat .webp files
// into their shard subdirectory. Safe to run on every startup — no-op once
// the tree is fully sharded.
function migrateToSharded() {
  let entries;
  try {
    entries = fs.readdirSync(config.THUMBNAIL_DIR, { withFileTypes: true });
  } catch { return; }

  let moved = 0;
  let errors = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith('.webp')) continue;
    const shard = shardFor(e.name);
    if (!shard) continue;
    const src  = path.join(config.THUMBNAIL_DIR, e.name);
    const dest = path.join(config.THUMBNAIL_DIR, shard, e.name);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      moved++;
    } catch (err) {
      errors++;
      console.warn(`[Thumbnail Migration] Failed to move ${e.name}: ${err.message}`);
    }
  }
  if (moved > 0 || errors > 0) {
    console.log(`[Thumbnail Migration] Sharded ${moved} thumbnail(s)${errors ? `, ${errors} errors` : ''}.`);
  }
}

module.exports = { shardFor, thumbnailPath, thumbnailUrl, ensureShardDir, migrateToSharded };
