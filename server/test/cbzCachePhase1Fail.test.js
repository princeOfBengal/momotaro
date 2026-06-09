/**
 * Regression test for Fix 1: a fast-mode extraction whose Phase 1 fails for a
 * NON-removal reason (corrupt / truncated archive, transient read error) must
 * NOT leave the chapter's state slot wedged in `chapterStates`. Before the fix,
 * the Phase 1 catch only released the slot for CHAPTER_REMOVED/ARCHIVE_REMOVED
 * errors, so a corrupt CBZ poisoned the chapter forever — every later open
 * awaited the rejected phase1 promise and 500'd until the file mtime changed or
 * the server restarted. It also leaked the reserved cache bytes.
 *
 * Also covers the R1.1 companion change: a full-mode caller must never receive
 * a "success" pointing at a directory the failing worker tore down — it must
 * reject (and re-extract cleanly) instead of ENOENT-ing on the follow-up read.
 *
 * Run with:  node test/cbzCachePhase1Fail.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-p1fail-'));
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
process.env.CBZ_FAST_PREFIX = '2';
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const cbzCache = require('../src/scanner/cbzCache');

const CHAPTER_ID = 553311;

// A file that exists (so it passes the ENOENT guard) but is not a valid zip,
// so yauzl.open inside planChapterPages rejects — a deterministic, non-removal
// Phase 1 failure, exactly like a corrupt/truncated CBZ.
function writeCorruptCbz() {
  const cbzPath = path.join(tmpRoot, 'corrupt.cbz');
  fs.writeFileSync(cbzPath, Buffer.from('not a zip — just garbage bytes\n'.repeat(64)));
  return cbzPath;
}

(async () => {
  const cbzPath = writeCorruptCbz();
  const baselineBytes = cbzCache.stats().size_bytes;

  // 1) Fast-mode open of a corrupt archive must reject.
  let rejected = false;
  try {
    await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'fast' });
    assert.fail('fast extraction of a corrupt archive should reject');
  } catch {
    rejected = true;
  }
  assert.ok(rejected, 'fast extraction rejected');

  // 2) The state slot must be released — nothing left mid-extraction.
  assert.strictEqual(
    cbzCache.stats().in_progress_extractions, 0,
    'no extraction state may leak after a Phase 1 failure',
  );

  // 3) The reserved cache bytes must be reclaimed (no phantom index entry).
  assert.strictEqual(
    cbzCache.stats().size_bytes, baselineBytes,
    'reserved cache bytes must return to baseline after a Phase 1 failure',
  );

  // 4) A SECOND open must also reject promptly (retryable), not hang on a
  //    poisoned promise and not resolve with stale state. 5s is a generous
  //    safety net — a corrupt-archive rejection arrives in well under a second.
  const start = Date.now();
  let secondRejected = false;
  try {
    await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'fast' });
    assert.fail('second fast open of the corrupt archive should reject');
  } catch {
    secondRejected = true;
  }
  assert.ok(secondRejected, 'second open rejected (chapter not wedged)');
  assert.ok(Date.now() - start < 5000, 'second open rejected promptly, not hung');

  // 5) R1.1: a full-mode caller must reject too — never return a dead `dir`.
  let fullRejected = false;
  try {
    await cbzCache.ensureChapterExtracted(CHAPTER_ID, cbzPath, { mode: 'full' });
    assert.fail('full-mode open of the corrupt archive should reject');
  } catch {
    fullRejected = true;
  }
  assert.ok(fullRejected, 'full-mode open rejected (no dead-dir success)');
  assert.strictEqual(
    cbzCache.stats().in_progress_extractions, 0,
    'no extraction state leaked after the full-mode failure either',
  );
  assert.strictEqual(
    cbzCache.stats().size_bytes, baselineBytes,
    'reserved cache bytes must return to baseline after a full-mode failure too',
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('cbzCachePhase1Fail.test.js: PASS — Phase 1 failure releases the slot and stays retryable');
  process.exit(0);
})().catch((err) => {
  console.error('cbzCachePhase1Fail.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
