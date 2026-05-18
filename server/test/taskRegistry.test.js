/**
 * Behavioral test for the admin task registry. Runs without a test runner
 * — just node assertions. Covers the state machine, 409 behavior, error
 * path, progress reporting, and per-resource keying. Exits with non-zero
 * on any failure.
 *
 * Run from server/:
 *   node test/taskRegistry.test.js
 *
 * Persisted-kind paths (the admin_tasks table + restart recovery) are NOT
 * covered here — they require a working better-sqlite3 binding and a real
 * DB file. The HTTP smoke-test script in scripts/verify-admin-tasks.cjs
 * exercises those paths end-to-end against a running server.
 */

const assert = require('assert');
const reg    = require('../src/admin/taskRegistry');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

let testCount = 0;
let failed    = 0;
async function test(name, fn) {
  testCount++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

(async () => {
  console.log('taskRegistry behavioral tests');

  await test('start() on a fresh kind returns ok:true with running state', async () => {
    const r = reg.start('t1-fresh', null, async () => 'ok');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.state.status, 'running');
    assert.strictEqual(r.state.kind, 't1-fresh');
    assert.strictEqual(r.state.resource_id, null);
    assert.ok(typeof r.state.started_at === 'number');
    await wait(20);
  });

  await test('runner result becomes state.result with status=done', async () => {
    reg.start('t2-result', null, async () => ({ freed_mb: 42 }));
    await wait(20);
    const got = reg.get('t2-result', null);
    assert.strictEqual(got.status, 'done');
    assert.deepStrictEqual(got.result, { freed_mb: 42 });
    assert.ok(got.finished_at >= got.started_at);
  });

  await test('thrown runner becomes status=failed with error message', async () => {
    reg.start('t3-fail', null, async () => { throw new Error('boom'); });
    await wait(20);
    const got = reg.get('t3-fail', null);
    assert.strictEqual(got.status, 'failed');
    assert.strictEqual(got.error, 'boom');
  });

  await test('second start while running returns ok:false with existing state', async () => {
    const a = reg.start('t4-dupe', null, async () => { await wait(60); return 'first'; });
    const b = reg.start('t4-dupe', null, async () => 'second');
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.state.status, 'running');
    assert.strictEqual(b.state.started_at, a.state.started_at);
    await wait(100);
    const final = reg.get('t4-dupe', null);
    assert.strictEqual(final.status, 'done');
    assert.strictEqual(final.result, 'first');
  });

  await test('start after completion is accepted again', async () => {
    reg.start('t5-restart', null, async () => 'first');
    await wait(20);
    const r2 = reg.start('t5-restart', null, async () => 'second');
    assert.strictEqual(r2.ok, true);
    await wait(20);
    const final = reg.get('t5-restart', null);
    assert.strictEqual(final.result, 'second');
  });

  await test('progress reports update state mid-run', async () => {
    reg.start('t6-progress', null, async (report) => {
      report(0, 3, 'starting');
      await wait(40);
      report(1, 3, 'middle');
      await wait(40);
      report(3, 3, 'end');
      return null;
    });
    await wait(60);
    const mid = reg.get('t6-progress', null);
    assert.strictEqual(mid.status, 'running');
    assert.ok(mid.progress);
    assert.strictEqual(mid.progress.current, 1);
    assert.strictEqual(mid.progress.total, 3);
    assert.strictEqual(mid.progress.label, 'middle');
    await wait(100);
  });

  await test('per-resource keying: two manga optimize concurrently', async () => {
    const a = reg.start('opt-manga', 1, async () => { await wait(60); return { id: 1 }; });
    const b = reg.start('opt-manga', 2, async () => { await wait(60); return { id: 2 }; });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    await wait(20);
    const list = reg.list().filter(t => t.kind === 'opt-manga' && t.status === 'running');
    assert.strictEqual(list.length, 2);
    await wait(80);
  });

  await test('same-resource duplicate is rejected', async () => {
    reg.start('opt-manga', 99, async () => { await wait(60); return 'first'; });
    const dupe = reg.start('opt-manga', 99, async () => 'second');
    assert.strictEqual(dupe.ok, false);
    await wait(80);
  });

  await test('get() returns null for unknown kind/resource', async () => {
    assert.strictEqual(reg.get('does-not-exist', null), null);
    assert.strictEqual(reg.get('opt-manga', 9999), null);
  });

  await test('list() returns every in-memory task', async () => {
    // Several previous tests left their final state in memory — confirm
    // list() includes them and they're well-shaped.
    const all = reg.list();
    assert.ok(all.length > 0);
    for (const t of all) {
      assert.ok(typeof t.kind === 'string');
      assert.ok(['running', 'done', 'failed', 'interrupted'].includes(t.status));
    }
  });

  await test('runner runs after start() returns (event-loop deferred)', async () => {
    // Critical for the HTTP path: start() must return so the route handler
    // can send the 202 response before a sync runner blocks the loop.
    let runnerStarted = false;
    reg.start('t-defer', null, async () => {
      runnerStarted = true;
      return null;
    });
    // Right after start() returns, the runner has NOT yet executed.
    assert.strictEqual(runnerStarted, false);
    await wait(20);
    assert.strictEqual(runnerStarted, true);
  });

  console.log(`\n${testCount - failed} / ${testCount} passing${failed ? ` — ${failed} failed` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exit(2);
});
