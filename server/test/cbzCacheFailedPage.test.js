/**
 * Regression test for Fix 3: a page whose zip entry fails to extract must
 * reject its waiters FAST with PAGE_EXTRACT_FAILED, not block the full
 * PAGE_WAIT_TIMEOUT and then 503-loop forever.
 *
 * We force a deterministic extract failure by pre-creating a *directory* at the
 * `<page>.tmp` path Phase 2 will try to write — fs.createWriteStream then fails
 * (EISDIR / EPERM), which is exactly the corrupt-entry code path. We target the
 * LAST page index so Phase 2 (ascending order) reaches it well after the
 * blocker is in place.
 *
 * Run with:  node test/cbzCacheFailedPage.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-failpage-'));
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
process.env.CBZ_FAST_PREFIX = '2';
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const AdmZip = require('adm-zip');
const sharp = require('sharp');
const cbzCache = require('../src/scanner/cbzCache');

const PAGE_COUNT = 12;
const CHAPTER_ID = 778899;
const LAST_FILE = String(PAGE_COUNT).padStart(4, '0') + '.jpg'; // 0012.jpg

async function buildCbz() {
  const zip = new AdmZip();
  for (let i = 0; i < PAGE_COUNT; i++) {
    const buf = await sharp({
      create: { width: 50, height: 70, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer();
    zip.addFile(`page_${String(i + 1).padStart(3, '0')}.jpg`, buf);
  }
  const cbzPath = path.join(tmpRoot, 'chapter.cbz');
  zip.writeZip(cbzPath);
  return cbzPath;
}

(async () => {
  const cbzPath = await buildCbz();

  // Phase 1 returns after the 2-page prefix; Phase 2 is now extracting 3..12.
  const first = await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'fast' });
  const dir = first.dir;

  // Block the last page's .tmp write by occupying the path with a directory.
  fs.mkdirSync(path.join(dir, LAST_FILE + '.tmp'), { recursive: true });

  // Wait on the page that will fail. Must reject with PAGE_EXTRACT_FAILED and
  // do so well under the 30s default timeout (we cap at 12s as a safety net —
  // the rejection should arrive in well under a second).
  const start = Date.now();
  let code = null;
  try {
    await cbzCache.waitForPageFile(dir, LAST_FILE, { timeoutMs: 12000 });
    assert.fail('waitForPageFile should have rejected for the failed page');
  } catch (err) {
    code = err.code;
  }
  const elapsed = Date.now() - start;

  assert.strictEqual(code, 'PAGE_EXTRACT_FAILED', `expected PAGE_EXTRACT_FAILED, got ${code}`);
  assert.ok(elapsed < 10000, `rejection must be fast, took ${elapsed}ms`);

  // The rest of the chapter still extracted fine — one bad page mustn't poison
  // the others. Page 1 (prefix) is definitely present.
  assert.ok(fs.existsSync(path.join(dir, '0001.jpg')), 'good pages still extracted');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('cbzCacheFailedPage.test.js: PASS — failed page rejects fast with PAGE_EXTRACT_FAILED');
  process.exit(0);
})().catch((err) => {
  console.error('cbzCacheFailedPage.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
