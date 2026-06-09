/**
 * Unit test for the Phase 2 priority scheduler (foreground vs background) and
 * the grant-time promotion path.
 *
 * Guards:
 *   - Fix 2: the next-chapter prefetch must not starve the chapter the user is
 *     actively reading. Foreground waiters drain before background ones, and
 *     background (prefetch) extractions never exceed PHASE2_CONCURRENCY - 1
 *     simultaneously.
 *   - Fix 1 (#1): a chapter started as a background prefetch can be PROMOTED to
 *     foreground mid-flight — whether it's still queued (re-picked ahead of
 *     other background work) or already running (frees background-cap room).
 *
 * The scheduler keys on the chapter STATE object and reads `state.background`
 * live, so the test drives it with lightweight fake states.
 *
 * Run with:  node test/phase2Scheduler.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Pin concurrency to 2 BEFORE requiring config/cbzCache so backgroundCap === 1.
process.env.CBZ_PHASE2_CONCURRENCY = '2';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-sched-'));
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const cbzCache = require('../src/scanner/cbzCache');
const { acquirePhase2Slot, releasePhase2Slot, promotePhase2ToForeground, dropPhase2Waiter, phase2Stats } = cbzCache.__testing;

// Lets queued resolvers (and their .then continuations) actually run.
const tick = () => new Promise(r => setImmediate(r));

// Fake chapter state. `ran` flips true once its slot is granted.
function makeState(background) {
  const s = { background, ran: false };
  s.promise = acquirePhase2Slot(s).then(() => { s.ran = true; });
  return s;
}

(async () => {
  assert.strictEqual(phase2Stats().concurrency, 2, 'concurrency pinned to 2');
  assert.strictEqual(phase2Stats().backgroundCap, 1, 'background cap is concurrency - 1');

  // ── Invariant 1: foreground priority + background cap ─────────────────────
  const s1 = makeState(false); // fg
  const s2 = makeState(false); // fg
  await tick();
  assert.strictEqual(phase2Stats().active, 2, 'both slots foreground');

  const bgA = makeState(true);  // queued background
  const fgC = makeState(false); // queued foreground (enqueued AFTER bgA)
  await tick();
  assert.strictEqual(phase2Stats().queued, 2, 'two waiters queued');
  assert.strictEqual(phase2Stats().foregroundQueued, 1, 'one foreground queued');
  assert.strictEqual(phase2Stats().backgroundQueued, 1, 'one background queued');

  // Free a slot — the FOREGROUND waiter must win even though it queued later.
  releasePhase2Slot(s1);
  await tick();
  assert.strictEqual(fgC.ran, true, 'foreground waiter granted first');
  assert.strictEqual(bgA.ran, false, 'background waiter still waiting');

  // Free another — no foreground queued, background under cap → background runs.
  releasePhase2Slot(s2);
  await tick();
  assert.strictEqual(bgA.ran, true, 'background granted once under cap with a free slot');
  assert.strictEqual(phase2Stats().backgroundActive, 1, 'exactly one background running');

  // A second background must NOT run while one background is active (cap 1)...
  const bgB = makeState(true);
  await tick();
  assert.strictEqual(phase2Stats().backgroundQueued, 1, 'second background queued (capped)');

  // ...even after a foreground slot frees: the freed slot stays idle (reserved).
  releasePhase2Slot(fgC);
  await tick();
  assert.strictEqual(bgB.ran, false, 'second background stays queued under cap');
  assert.strictEqual(phase2Stats().active, 1, 'freed slot left idle (foreground-reserved)');

  // Finishing the running background frees the cap → the queued one runs.
  releasePhase2Slot(bgA);
  await tick();
  assert.strictEqual(bgB.ran, true, 'queued background runs after the prior one finishes');

  releasePhase2Slot(bgB);
  await tick();
  assert.strictEqual(phase2Stats().active, 0, 'all slots released');
  assert.strictEqual(phase2Stats().queued, 0, 'no waiters left');

  // ── Promotion while QUEUED: jumps ahead of earlier-queued background ───────
  const f1 = makeState(false);
  const f2 = makeState(false);
  await tick();
  const qBgA = makeState(true);  // queued background (earlier)
  const qBgB = makeState(true);  // queued background (later)
  await tick();
  assert.strictEqual(phase2Stats().backgroundQueued, 2, 'two background queued');

  // Promote the LATER one to foreground.
  promotePhase2ToForeground(qBgB);
  await tick();
  assert.strictEqual(qBgB.ran, false, 'promotion alone does not grant while slots are full');

  // Free a slot — the promoted (now foreground) waiter wins over the earlier bg.
  releasePhase2Slot(f1);
  await tick();
  assert.strictEqual(qBgB.ran, true, 'promoted-while-queued waiter granted ahead of earlier background');
  assert.strictEqual(qBgA.ran, false, 'earlier (still background) waiter still waiting');

  releasePhase2Slot(f2);
  await tick();
  // The earlier background is granted on the next free slot (it's now the only
  // background, under cap).
  assert.strictEqual(qBgA.ran, true, 'earlier background granted on next free slot');
  releasePhase2Slot(qBgA);
  releasePhase2Slot(qBgB);
  await tick();
  assert.strictEqual(phase2Stats().active, 0, 'drained to empty after queued-promotion case');
  assert.strictEqual(phase2Stats().queued, 0, 'no waiters after queued-promotion case');

  // ── Promotion while RUNNING: frees background-cap room for a queued bg ─────
  const g1 = makeState(false);   // fg, running
  await tick();
  const rBgA = makeState(true);  // bg, running (active 2, bgRunning 1)
  await tick();
  assert.strictEqual(rBgA.ran, true, 'background running');
  const rBgB = makeState(true);  // bg, queued
  await tick();

  // Free the foreground slot — cap reached by rBgA, so rBgB stays queued, idle.
  releasePhase2Slot(g1);
  await tick();
  assert.strictEqual(rBgB.ran, false, 'queued background blocked by the running one (cap)');
  assert.strictEqual(phase2Stats().active, 1, 'one running, one slot idle');

  // Promote the RUNNING background — frees cap room → the queued bg can start.
  promotePhase2ToForeground(rBgA);
  await tick();
  assert.strictEqual(rBgB.ran, true, 'queued background runs after the running one is promoted');

  releasePhase2Slot(rBgA);
  releasePhase2Slot(rBgB);
  await tick();

  // ── Cancelled-while-queued waiter: dropped + resolved, no slot consumed ────
  const c1 = makeState(false);   // fg, running
  const c2 = makeState(false);   // fg, running
  await tick();
  assert.strictEqual(phase2Stats().active, 2, 'both slots full');
  const cancelled = makeState(false); // queued (slots full)
  await tick();
  assert.strictEqual(phase2Stats().queued, 1, 'one waiter queued');

  dropPhase2Waiter(cancelled); // `cancelled` is the state object passed to acquire
  await tick();
  // The waiter's acquire promise resolves (so the awaiting runPhase2 can proceed
  // to self-abort) but it never entered the running set — no slot consumed.
  assert.strictEqual(cancelled.ran, true, 'dropped waiter was resolved');
  assert.strictEqual(phase2Stats().queued, 0, 'dropped waiter removed from queue');
  assert.strictEqual(phase2Stats().active, 2, 'dropped waiter did not occupy a real slot');

  releasePhase2Slot(c1);
  releasePhase2Slot(c2);
  await tick();
  assert.strictEqual(phase2Stats().active, 0, 'slots released after cancel-waiter case');

  // ── No underflow: releasing an unknown state is a harmless no-op ───────────
  releasePhase2Slot({ background: false }); // never acquired
  assert.strictEqual(phase2Stats().active, 0, 'releasing an unknown state does not corrupt counts');
  assert.strictEqual(phase2Stats().backgroundActive, 0, 'no negative background count');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('phase2Scheduler.test.js: PASS — foreground priority, background cap, and promotion all hold');
  process.exit(0);
})().catch((err) => {
  console.error('phase2Scheduler.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
