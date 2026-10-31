/**
 * Art Gallery thumbnails (scanner/galleryThumbs.js).
 *
 * Proves that a gallery thumbnail for a CBZ page is built from that one zip
 * entry without touching the CBZ extraction cache, that it is downscaled to
 * the tile bounds, that concurrent requests share one generation, and that
 * removal + the orphan sweep keep the gallery directory in step with the
 * art_gallery table.
 *
 * Run with:  node test/galleryThumbs.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-gallerythumbs-'));
process.env.THUMBNAIL_DIR = path.join(tmpRoot, 'thumbnails');
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const AdmZip = require('adm-zip');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const {
  galleryThumbPath, galleryThumbUrl, ensureGalleryThumb,
  removeGalleryThumbs, sweepOrphanGalleryThumbs, GALLERY_DIR,
} = require('../src/scanner/galleryThumbs');

const MTIME = 1713200000000;

// Read through a buffer: sharp(path) keeps the file open on Windows, which
// would make the removal assertions below fail with EPERM.
const probe = (file) => sharp(fs.readFileSync(file));

function image(width, height, rgb) {
  return sharp({ create: { width, height, channels: 3, background: rgb } }).jpeg().toBuffer();
}

(async () => {
  // Entries live in subdirectories in non-basename order, so page_index must
  // be resolved through the same basename sort the reader uses.
  const zip = new AdmZip();
  zip.addFile('b/01.jpg', await image(1200, 1800, { r: 255, g: 0, b: 0 }));
  zip.addFile('a/02.jpg', await image(2400, 1800, { r: 0, g: 255, b: 0 }));
  zip.addFile('03.jpg',   await image(300, 450,  { r: 0, g: 0, b: 255 }));
  const cbzPath = path.join(tmpRoot, 'ch1.cbz');
  zip.writeZip(cbzPath);

  const cbzPage = (id, page_index, filename) => ({
    id, page_index, filename, path: 'unused-for-cbz',
    chapter_type: 'cbz', chapter_path: cbzPath, file_mtime: MTIME,
  });

  // 1) Portrait page downscales to fit 800x600, keeping its aspect ratio.
  const p1 = await ensureGalleryThumb(cbzPage(11, 0, '01.jpg'));
  assert.strictEqual(p1, galleryThumbPath(11, MTIME));
  let meta = await probe(p1).metadata();
  assert.strictEqual(meta.format, 'webp');
  assert.deepStrictEqual([meta.width, meta.height], [400, 600]);
  const { data, info } = await probe(p1).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 200 && data[1] < 50, `page_index 0 should be the red 01.jpg (${info.channels}ch)`);

  // 2) Landscape spread fits by width.
  meta = await probe(await ensureGalleryThumb(cbzPage(12, 1, '02.jpg'))).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [800, 600]);

  // 3) Small pages are never upscaled.
  meta = await probe(await ensureGalleryThumb(cbzPage(13, 2, '03.jpg'))).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [300, 450]);

  // 3b) A long webtoon strip keeps a sharp top section instead of a sliver.
  const stripZip = new AdmZip();
  stripZip.addFile('01.png', await sharp({
    create: { width: 800, height: 12000, channels: 3, background: { r: 5, g: 5, b: 5 } },
  }).png().toBuffer());
  // 3c) EXIF orientation 6 (stored landscape, displayed portrait) is applied.
  stripZip.addFile('02.jpg', await sharp({
    create: { width: 1800, height: 1200, channels: 3, background: { r: 5, g: 5, b: 5 } },
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  const stripPath = path.join(tmpRoot, 'strip.cbz');
  stripZip.writeZip(stripPath);
  meta = await probe(await ensureGalleryThumb({ ...cbzPage(17, 0, '01.png'), chapter_path: stripPath })).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [400, 1200]);
  meta = await probe(await ensureGalleryThumb({ ...cbzPage(18, 1, '02.jpg'), chapter_path: stripPath })).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [400, 600]);

  // 4) Nothing was extracted into the CBZ cache.
  assert.deepStrictEqual(fs.readdirSync(process.env.CBZ_CACHE_DIR), []);

  // 5) Concurrent requests for a missing thumb share one generation.
  const concurrent = await Promise.all([1, 2, 3].map(() => ensureGalleryThumb(cbzPage(14, 0, '01.jpg'))));
  assert.ok(concurrent.every(p => p === galleryThumbPath(14, MTIME)));
  const shardDir = path.dirname(galleryThumbPath(14, MTIME));
  assert.deepStrictEqual(fs.readdirSync(shardDir).filter(n => n.startsWith('14_')), [`14_${MTIME}.webp`]);

  // 6) Folder chapters read the image file directly.
  const folderImg = path.join(tmpRoot, 'folder-01.jpg');
  fs.writeFileSync(folderImg, await image(1000, 1500, { r: 9, g: 9, b: 9 }));
  meta = await probe(await ensureGalleryThumb({
    id: 15, page_index: 0, filename: 'folder-01.jpg', path: folderImg,
    chapter_type: 'folder', chapter_path: tmpRoot, file_mtime: null,
  })).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [400, 600]);
  assert.strictEqual(galleryThumbUrl(15, null), '/api/pages/15/thumb?v=0');

  // 7) A missing archive rejects instead of hanging.
  await assert.rejects(ensureGalleryThumb({ ...cbzPage(16, 0, '01.jpg'), chapter_path: path.join(tmpRoot, 'gone.cbz') }));

  // 8) removeGalleryThumbs deletes every version of one page only.
  fs.copyFileSync(galleryThumbPath(11, MTIME), galleryThumbPath(11, 1));
  assert.strictEqual(removeGalleryThumbs(11), 2);
  assert.ok(!fs.existsSync(galleryThumbPath(11, MTIME)));
  assert.ok(fs.existsSync(galleryThumbPath(12, MTIME)));

  // 8b) Removing a page while its thumbnail is still generating leaves no file.
  const racing = ensureGalleryThumb(cbzPage(19, 0, '01.jpg'));
  removeGalleryThumbs(19);
  await racing;
  await new Promise(r => setImmediate(r));
  assert.ok(!fs.existsSync(galleryThumbPath(19, MTIME)), 'thumb written after removal should be cleaned up');

  // 9) Sweep keeps live (page, current mtime) pairs and reaps the rest:
  //    page 12 is live, page 13 is live but its chapter's mtime moved on,
  //    pages 14/15/17/18 are no longer in the gallery.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chapters (id INTEGER PRIMARY KEY, file_mtime INTEGER);
    CREATE TABLE art_gallery (id INTEGER PRIMARY KEY, chapter_id INTEGER, page_id INTEGER);
    INSERT INTO chapters VALUES (1, ${MTIME}), (2, ${MTIME + 5000});
    INSERT INTO art_gallery (chapter_id, page_id) VALUES (1, 12), (2, 13);
  `);
  fs.writeFileSync(path.join(path.dirname(galleryThumbPath(12, MTIME)), `12_${MTIME}.webp.123.tmp`), '');
  assert.strictEqual(sweepOrphanGalleryThumbs(db), 6);
  assert.ok(fs.existsSync(galleryThumbPath(12, MTIME)));
  for (const id of [13, 14, 15, 17, 18]) {
    const shard = path.dirname(galleryThumbPath(id, MTIME));
    assert.deepStrictEqual(fs.readdirSync(shard).filter(n => n.startsWith(`${id}_`)), [], `page ${id} should be swept`);
  }
  assert.ok(fs.existsSync(GALLERY_DIR));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('galleryThumbs: all assertions passed');
})().catch(err => {
  console.error(err);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(1);
});
