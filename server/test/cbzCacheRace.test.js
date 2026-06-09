/**
 * Regression test for the fast-mode "in-progress eviction" race.
 *
 * Bug: ensureChapterExtracted() checked the in-memory `index` (and evicted any
 * indexed dir lacking a `.ready` marker) BEFORE checking `chapterStates`. In
 * fast mode the dir is added to `index` at the start of Phase 1 but `.ready`
 * isn't written until Phase 2 completes, so a concurrent fast-mode caller
 * arriving during Phase 2 would see "indexed + no marker", conclude the dir was
 * corrupt, and rm -rf it out from under the still-running Phase 2 — whose next
 * write then failed with `ENOENT ... <page>.tmp`.
 *
 * This reproduces the exact reader flow: open a chapter fast (returns after
 * Phase 1, Phase 2 still running), then fire a second fast-mode call (as the
 * page-image route does) while Phase 2 is in flight, and assert the extraction
 * completes intact.
 *
 * Requires the project runtime (sharp + a working zip). Run with:
 *   node test/cbzCacheRace.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-cbzrace-'));
// Configure the cache dir and a tiny fast prefix BEFORE requiring config/cbzCache.
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
process.env.CBZ_FAST_PREFIX = '2';
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const AdmZip = require('adm-zip');
const sharp = require('sharp');
const cbzCache = require('../src/scanner/cbzCache');

const PAGE_COUNT = 12;
const CHAPTER_ID = 653162;

async function buildCbz() {
  const zip = new AdmZip();
  for (let i = 0; i < PAGE_COUNT; i++) {
    // Distinct sizes so a wrong file would be detectable; small enough to be fast.
    const buf = await sharp({
      create: { width: 40 + i, height: 60 + i, channels: 3, background: { r: i * 10 % 255, g: 80, b: 120 } },
    }).jpeg().toBuffer();
    zip.addFile(`page_${String(i + 1).padStart(3, '0')}.jpg`, buf);
  }
  const cbzPath = path.join(tmpRoot, 'chapter.cbz');
  zip.writeZip(cbzPath);
  return cbzPath;
}

async function waitForReady(dir, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(path.join(dir, '.ready'))) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('.ready never appeared — Phase 2 did not complete');
}

(async () => {
  const cbzPath = await buildCbz();

  // 1. First caller: fast mode. Returns after Phase 1 with Phase 2 in flight.
  const first = await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'fast' });
  assert.strictEqual(first.freshlyExtracted, true, 'first call should freshly extract');
  assert.strictEqual(first.extracting, true, 'Phase 2 should still be running after Phase 1');
  const dir = first.dir;
  assert.ok(fs.existsSync(dir), 'chapter dir should exist after Phase 1');
  assert.ok(!fs.existsSync(path.join(dir, '.ready')), 'marker must be absent mid-Phase-2 (test precondition)');

  // 2. Concurrent caller during Phase 2 — exactly what /api/pages/:id/image?fast=1
  //    does. Pre-fix this evicted `dir`, killing Phase 2.
  const second = await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'fast' });
  assert.strictEqual(second.dir, dir, 'concurrent caller must resolve the same dir');
  assert.strictEqual(second.freshlyExtracted, false, 'concurrent caller must not re-extract');
  assert.ok(fs.existsSync(dir), 'dir must survive the concurrent fast-mode call (no eviction)');

  // 3. Phase 2 must finish cleanly: marker written, every page on disk, no .tmp.
  await waitForReady(dir);
  const files = fs.readdirSync(dir);
  const images = files.filter(f => f.endsWith('.jpg'));
  const leftovers = files.filter(f => f.endsWith('.tmp'));
  assert.strictEqual(images.length, PAGE_COUNT, `all ${PAGE_COUNT} pages extracted (got ${images.length})`);
  assert.strictEqual(leftovers.length, 0, 'no leftover .tmp files');
  for (let i = 0; i < PAGE_COUNT; i++) {
    const name = String(i + 1).padStart(4, '0') + '.jpg';
    assert.ok(fs.existsSync(path.join(dir, name)), `page ${name} present`);
  }

  // 4. Post-completion cache hit still works (chapterStates cleared, index serves it).
  const third = await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'fast' });
  assert.strictEqual(third.dir, dir);
  assert.strictEqual(third.freshlyExtracted, false, 'completed extraction is a cache hit');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('cbzCacheRace.test.js: PASS — fast-mode concurrent caller no longer evicts in-progress extraction');
  process.exit(0);
})().catch((err) => {
  console.error('cbzCacheRace.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
