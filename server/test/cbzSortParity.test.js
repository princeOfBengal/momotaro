/**
 * Regression test for the scanner ↔ cache sort-order alignment.
 *
 * The library scanner (chapterParser.listCbzEntries) and the CBZ cache
 * (cbzCache.planChapterPages) independently order a chapter's page entries.
 * Before the fix the scanner sorted by FULL entry name while the cache sorted
 * by BASENAME, so for archives whose images live in subdirectories the cover /
 * first-page pick disagreed with the reader's page 1. Both now sort by
 * basename via the shared utils comparator — this test proves they agree.
 *
 * Run with:  node test/cbzSortParity.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-sortparity-'));
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
process.env.CBZ_FAST_PREFIX = '2';
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { listCbzEntries } = require('../src/scanner/chapterParser');
const cbzCache = require('../src/scanner/cbzCache');

const CHAPTER_ID = 909090;

// Entries deliberately ordered so that BASENAME order differs from full-path
// order: by full path it's ['03.jpg', 'a/02.jpg', 'b/01.jpg'] (digit < letter),
// but by basename it's ['01.jpg', '02.jpg', '03.jpg'].
const ENTRIES = ['b/01.jpg', 'a/02.jpg', '03.jpg'];
const EXPECTED_BASENAMES = ['01.jpg', '02.jpg', '03.jpg'];

async function buildCbz() {
  const zip = new AdmZip();
  for (const name of ENTRIES) {
    const buf = await sharp({
      create: { width: 16, height: 24, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();
    zip.addFile(name, buf);
  }
  const cbzPath = path.join(tmpRoot, 'subdirs.cbz');
  zip.writeZip(cbzPath);
  return cbzPath;
}

(async () => {
  const cbzPath = await buildCbz();

  // 1) Scanner ordering.
  const scannerEntries = await listCbzEntries(cbzPath);
  const scannerBasenames = scannerEntries.map(e => e.filename);
  assert.deepStrictEqual(
    scannerBasenames, EXPECTED_BASENAMES,
    `scanner order should be basename-sorted, got ${JSON.stringify(scannerBasenames)}`,
  );

  // 2) Cache ordering (originalName is the basename, in planned extraction order).
  const extraction = await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'fast' });
  const cacheBasenames = extraction.plannedPages.map(p => p.originalName);

  // 3) The two MUST agree — that's the invariant that keeps the cover and the
  //    reader's page 1 pointing at the same image.
  assert.deepStrictEqual(
    cacheBasenames, scannerBasenames,
    `scanner and cache must order pages identically:\n  scanner ${JSON.stringify(scannerBasenames)}\n  cache   ${JSON.stringify(cacheBasenames)}`,
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('cbzSortParity.test.js: PASS — scanner and cache agree on basename page order');
  process.exit(0);
})().catch((err) => {
  console.error('cbzSortParity.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
