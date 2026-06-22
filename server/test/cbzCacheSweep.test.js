/**
 * Tests for the scheduled-clear primitives + `.ready` size persistence added
 * alongside the age/idle-aware auto-clear:
 *
 *   1. `.ready` carries { v, size, pages } and the persisted size equals the
 *      sum of the page files (dirSizeSync, which now skips the marker).
 *   2. init() rebuilds the index from the persisted size with no drift, and
 *      falls back to a disk walk for an empty / legacy marker.
 *   3. sweepOlderThan() — the only scheduled-clear primitive — evicts chapters
 *      whose atime is past the cutoff (seeded from the marker mtime on init) and
 *      keeps freshly-accessed ones, never touching an in-flight extraction.
 *
 * Requires the project runtime (sharp + a working zip). Run with:
 *   node test/cbzCacheSweep.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-cbzsweep-'));
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const AdmZip = require('adm-zip');
const sharp = require('sharp');
const cbzCache = require('../src/scanner/cbzCache');

const PAGE_COUNT = 8;

async function buildCbz(name) {
  const zip = new AdmZip();
  for (let i = 0; i < PAGE_COUNT; i++) {
    const buf = await sharp({
      create: { width: 50 + i, height: 70 + i, channels: 3, background: { r: i * 9 % 255, g: 60, b: 90 } },
    }).jpeg().toBuffer();
    zip.addFile(`p_${String(i + 1).padStart(3, '0')}.jpg`, buf);
  }
  const cbzPath = path.join(tmpRoot, `${name}.cbz`);
  zip.writeZip(cbzPath);
  return cbzPath;
}

function sumPageBytes(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f === '.ready' || f.endsWith('.tmp')) continue;
    total += fs.statSync(path.join(dir, f)).size;
  }
  return total;
}

// evictChapterDir() updates the in-memory index synchronously but does the disk
// `fs.rm` asynchronously, so disk removal is eventually-consistent — poll for it.
async function waitGone(dir, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(dir)) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`dir was not removed from disk in time: ${dir}`);
}

async function waitForCondition(fn, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`condition not met in time: ${label}`);
}

(async () => {
  const cbzPath = await buildCbz('shared'); // identical content reused across ids

  // ── 1. `.ready` round-trip + size accuracy ─────────────────────────────────
  cbzCache.wipe();
  const ext = await cbzCache.ensureChapterExtracted(1001, cbzPath, { mode: 'full' });
  const dir = ext.dir;
  const expectedSize = sumPageBytes(dir);

  const readyRaw = fs.readFileSync(path.join(dir, '.ready'), 'utf8');
  const readyJson = JSON.parse(readyRaw);
  assert.strictEqual(readyJson.v, 1, 'marker carries a version');
  assert.strictEqual(readyJson.pages, PAGE_COUNT, 'marker records page count');
  assert.strictEqual(readyJson.size, expectedSize, 'persisted size = sum of page files');
  assert.strictEqual(cbzCache.stats().size_bytes, expectedSize, 'index size matches real size (no drift)');
  assert.strictEqual(cbzCache.stats().entries, 1, 'one chapter indexed');

  // ── 2a. init() rebuilds from the persisted size with no drift ──────────────
  const sizeBefore = cbzCache.stats().size_bytes;
  cbzCache.init();
  assert.strictEqual(cbzCache.stats().size_bytes, sizeBefore, 'init() size from marker == pre-init size');
  assert.strictEqual(cbzCache.stats().entries, 1, 'init() rebuilt the one chapter');

  // ── 2b. init() falls back to a disk walk for an empty / legacy marker ──────
  fs.writeFileSync(path.join(dir, '.ready'), ''); // simulate a pre-#4 empty marker
  cbzCache.init();
  assert.strictEqual(cbzCache.stats().size_bytes, expectedSize, 'empty marker → dirSizeSync fallback, same size');
  assert.strictEqual(cbzCache.stats().entries, 1, 'empty-marker dir still loads');

  // ── 3. sweepOlderThan: age cutoff + keep-fresh ─────────────────────────────
  cbzCache.wipe();
  const aExt = await cbzCache.ensureChapterExtracted(2001, cbzPath, { mode: 'full' });
  // Backdate A's marker mtime so init() seeds an old atime for it.
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(aExt.dir, '.ready'), tenDaysAgo, tenDaysAgo);
  cbzCache.init(); // A now has atime ≈ 10 days ago

  const bExt = await cbzCache.ensureChapterExtracted(2002, cbzPath, { mode: 'full' }); // atime = now
  assert.strictEqual(cbzCache.stats().entries, 2, 'two chapters indexed before sweep');

  const swept = cbzCache.sweepOlderThan(24 * 60 * 60 * 1000); // older than 1 day
  assert.strictEqual(swept.removed, 1, 'exactly the stale chapter is swept');
  assert.strictEqual(cbzCache.stats().entries, 1, 'one chapter remains in index');
  await waitGone(aExt.dir); // disk removal is async
  assert.ok(fs.existsSync(bExt.dir), 'fresh chapter dir kept');

  // ── 5. Fast-mode (two-phase) accounting converges to the real on-disk size ──
  // Exercises runPhase2's incremental reserve + final reconcile — the full-mode
  // subtests above never touch that path.
  cbzCache.wipe();
  const fast = await cbzCache.ensureChapterExtracted(4001, cbzPath, { mode: 'fast' });
  assert.strictEqual(fast.extracting, true, 'fast mode returns with Phase 2 in flight');
  await waitForCondition(() => fs.existsSync(path.join(fast.dir, '.ready')), 'Phase 2 .ready');
  await waitForCondition(
    () => cbzCache.stats().size_bytes === sumPageBytes(fast.dir),
    'fast-mode index size == real on-disk size',
  );
  assert.strictEqual(cbzCache.stats().entries, 1, 'one chapter after fast extract');
  // The persisted marker size must also match (written from the same realSize).
  const fastReady = JSON.parse(fs.readFileSync(path.join(fast.dir, '.ready'), 'utf8'));
  assert.strictEqual(fastReady.size, sumPageBytes(fast.dir), 'fast-mode .ready size persisted correctly');
  assert.strictEqual(fastReady.pages, PAGE_COUNT, 'fast-mode .ready page count');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('cbzCacheSweep.test.js: PASS — .ready size persistence + sweepOlderThan + fast-mode accounting');
  process.exit(0);
})().catch((err) => {
  console.error('cbzCacheSweep.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
