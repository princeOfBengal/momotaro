const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const { listCbzEntries, openCbzEntryStream } = require('./chapterParser');

// Downscaled copies of Art Gallery pages. Gallery tiles never render taller
// than 280 CSS px, so serving the full page (1–3 MB) for each one is wasted
// bandwidth — and for a CBZ chapter that has been evicted from the extraction
// cache it used to cost a full chapter re-extract per tile. These thumbnails
// are built from a single decompressed zip entry (or the folder image) and
// never touch cbzCache, so a gallery with pages from hundreds of different
// chapters costs nothing in cache churn.
//
// Layout: THUMBNAIL_DIR/gallery/<shard>/<pageId>_<version>.webp
//   - shard   = pageId % 256 as two-digit hex (same scheme as covers)
//   - version = the chapter's file_mtime, so a page's content can never change
//     behind an immutable URL. Today a rescan that sees a new mtime re-indexes
//     the chapter's pages (new ids), but the version keeps the URL honest even
//     if a page id ever outlives a content change.

const GALLERY_DIR = path.join(config.THUMBNAIL_DIR, 'gallery');
// Scale so the image covers MIN_W x MIN_H (the 2:3 tile at 2x DPR — tiles
// never render taller than 280 CSS px), then crop anything beyond MAX_W x
// MAX_H. Normal pages land at ~400x600, spreads at ~800x600, and a long
// webtoon strip keeps a sharp 400 px-wide top section instead of collapsing
// into a 20 px sliver.
const MIN_W = 400;
const MIN_H = 600;
const MAX_W = 1600;
const MAX_H = 1200;
const QUALITY     = 80;
const CONCURRENCY = 2;    // backfill bursts must not saturate a small host's CPU

const FILE_RE = /^(\d+)_(\d+)\.webp$/;

function versionFor(fileMtime) {
  const n = Math.floor(Number(fileMtime));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function shardFor(pageId) {
  return (pageId % 256).toString(16).padStart(2, '0');
}

function galleryThumbPath(pageId, version) {
  return path.join(GALLERY_DIR, shardFor(pageId), `${pageId}_${versionFor(version)}.webp`);
}

function galleryThumbUrl(pageId, version) {
  return `/api/pages/${pageId}/thumb?v=${versionFor(version)}`;
}

// Raw bytes for one page, without going through the CBZ extraction cache.
// `page` needs { page_index, filename, path, chapter_type, chapter_path }.
async function loadPageSource(page) {
  // Read folder images into memory rather than handing sharp the path: libvips
  // keeps files it opened by path cached open, which on Windows blocks the
  // user from moving or deleting their own library files.
  if (page.chapter_type === 'folder') return fs.promises.readFile(page.path);
  if (page.chapter_type !== 'cbz') throw new Error(`Unsupported chapter type: ${page.chapter_type}`);

  // listCbzEntries sorts exactly like the extraction cache (see
  // test/cbzSortParity.test.js), so page_index addresses the same entry the
  // reader shows. (pages.path can't be used: the scanner stores the entry
  // name there but chapter open overwrites it with the cache filename.) Fall
  // back to a basename match if the archive has drifted.
  const entries = await listCbzEntries(page.chapter_path);
  let entry = entries[page.page_index];
  if (!entry || entry.filename !== page.filename) {
    entry = entries.find(e => e.filename === page.filename) || entry;
  }
  if (!entry) throw new Error(`Page ${page.page_index} not found in ${page.chapter_path}`);

  const stream = await openCbzEntryStream(page.chapter_path, entry.entryName);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ── Concurrency limiter + in-flight dedupe ─────────────────────────────────
let running = 0;
const queue = [];
const inFlight = new Map(); // outPath → Promise<string>

function acquire() {
  if (running < CONCURRENCY) { running++; return Promise.resolve(); }
  return new Promise(resolve => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next(); else running--;
}

async function generate(page, outPath) {
  await acquire();
  try {
    if (fs.existsSync(outPath)) return outPath; // another request won the race
    const input = await loadPageSource(page);
    const { width, height, orientation } = await sharp(input).metadata();
    if (!width || !height) throw new Error('Unreadable image dimensions');
    // EXIF orientations 5–8 are 90° rotations; .rotate() below applies them,
    // so plan the resize on the upright dimensions.
    const [w, h] = orientation >= 5 ? [height, width] : [width, height];
    const scale = Math.min(1, Math.max(MIN_W / w, MIN_H / h));
    const rw = Math.max(1, Math.round(w * scale));
    const rh = Math.max(1, Math.round(h * scale));
    const cw = Math.min(rw, MAX_W);
    const ch = Math.min(rh, MAX_H);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmp = `${outPath}.${process.pid}.tmp`;
    let img = sharp(input).rotate().resize(rw, rh, { fit: 'fill' });
    // Keep the top (where a strip starts) and the horizontal centre.
    if (cw < rw || ch < rh) {
      img = img.extract({ left: Math.floor((rw - cw) / 2), top: 0, width: cw, height: ch });
    }
    await img.webp({ quality: QUALITY }).toFile(tmp);
    fs.renameSync(tmp, outPath);
    return outPath;
  } finally {
    release();
  }
}

/**
 * Resolve the on-disk thumbnail for a gallery page, generating it on first
 * use. Concurrent callers for the same page share one generation.
 * `page` needs { id, page_index, filename, path, chapter_type, chapter_path,
 * file_mtime }.
 */
function ensureGalleryThumb(page) {
  const outPath = galleryThumbPath(page.id, page.file_mtime);
  if (fs.existsSync(outPath)) return Promise.resolve(outPath);
  let p = inFlight.get(outPath);
  if (!p) {
    p = generate(page, outPath).finally(() => inFlight.delete(outPath));
    inFlight.set(outPath, p);
  }
  return p;
}

/** Delete every version of one page's thumbnail. */
function removeGalleryThumbs(pageId) {
  const dir = path.join(GALLERY_DIR, shardFor(pageId));
  // A generation still running (e.g. the add → immediate remove) would write
  // its file after we've cleaned up; remove again once it settles.
  for (const [outPath, p] of inFlight) {
    if (path.dirname(outPath) === dir && path.basename(outPath).startsWith(`${pageId}_`)) {
      p.then(() => removeGalleryThumbs(pageId), () => {});
    }
  }
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const m = name.match(FILE_RE);
    if (!m || parseInt(m[1], 10) !== pageId) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* already gone */ }
  }
  return removed;
}

/**
 * Reap thumbnails whose gallery row is gone (manga/chapter/page cascade,
 * config import) or whose chapter archive has since been replaced. Also
 * clears leftover .tmp files from a crash mid-write.
 */
function sweepOrphanGalleryThumbs(db) {
  let shards;
  try { shards = fs.readdirSync(GALLERY_DIR, { withFileTypes: true }); } catch { return 0; }

  const live = new Set(
    db.prepare(`
      SELECT ag.page_id AS page_id, c.file_mtime AS file_mtime
      FROM art_gallery ag JOIN chapters c ON c.id = ag.chapter_id
    `).all().map(r => `${r.page_id}_${versionFor(r.file_mtime)}.webp`)
  );

  let removed = 0;
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const dir = path.join(GALLERY_DIR, shard.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (live.has(name)) continue;
      const full = path.join(dir, name);
      // Leave an in-progress write alone; generate() renames it shortly.
      if (name.endsWith('.tmp') && inFlight.size > 0) continue;
      try { fs.unlinkSync(full); removed++; } catch { /* already gone */ }
    }
  }
  if (removed > 0) console.log(`[Gallery] Removed ${removed} orphaned gallery thumbnail(s).`);
  return removed;
}

module.exports = {
  galleryThumbPath,
  galleryThumbUrl,
  ensureGalleryThumb,
  removeGalleryThumbs,
  sweepOrphanGalleryThumbs,
  GALLERY_DIR,
};
