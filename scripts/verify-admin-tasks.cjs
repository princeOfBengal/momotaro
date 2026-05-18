/**
 * HTTP smoke test for the long-running admin action pipeline.
 *
 * Exercises the Phase 2 endpoint convention against a live server:
 *   - POST returns 202 with initial state
 *   - GET /status returns the live state
 *   - Second POST while running returns 409 with the existing state
 *   - State eventually transitions to 'done' with a result
 *
 * Usage (PowerShell):
 *   $env:MOMOTARO_URL='http://localhost:3000'
 *   $env:MOMOTARO_ADMIN_TOKEN='<token from POST /api/admin/login>'
 *   node scripts/verify-admin-tasks.cjs
 *
 * Usage (bash):
 *   MOMOTARO_URL=http://localhost:3000 \
 *   MOMOTARO_ADMIN_TOKEN=<token> \
 *   node scripts/verify-admin-tasks.cjs
 *
 * What it tests (and what it doesn't):
 *   ✓ Vacuum DB     — global, fast on a small dev DB
 *   ✓ Clear CBZ cache — global, idempotent
 *   ✓ Reset thumbnails — global, idempotent
 *   ✓ Regen thumbnails — global, progress-reporting
 *   ✓ Tasks list endpoint shows the running task while in flight
 *   ✗ Per-manga optimize / bulk-optimize-library — skipped because they
 *     mutate library files on disk. Run those manually against a backup.
 *   ✗ Cross-tab, Android backgrounding, UI badge animations — manual
 *     verification only (see docs/phase-8-verification.md).
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

const BASE  = process.env.MOMOTARO_URL || 'http://localhost:3000';
const TOKEN = process.env.MOMOTARO_ADMIN_TOKEN;

if (!TOKEN) {
  console.error('Set MOMOTARO_ADMIN_TOKEN. Get one from POST /api/admin/login.');
  process.exit(2);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function http(method, path, expectStatus) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
  });
  const text = await resp.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { _raw: text }; }
  }
  if (expectStatus && resp.status !== expectStatus) {
    throw new Error(`${method} ${path} → expected ${expectStatus}, got ${resp.status}: ${text.slice(0, 200)}`);
  }
  return { status: resp.status, body };
}

async function pollUntil(predicate, timeoutMs = 90_000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await predicate();
    if (r) return r;
    await wait(intervalMs);
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

let testCount = 0;
let failed    = 0;

async function test(name, fn) {
  testCount++;
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('✓');
  } catch (err) {
    failed++;
    console.log('✗');
    console.log('    ' + err.message);
  }
}

/**
 * Common pattern: start a task, expect 202; poll status until done; assert
 * the result shape via the caller's check.
 */
async function exerciseTask({ name, startPath, statusPath, checkResult }) {
  await test(`${name}: POST returns 202 with initial running state`, async () => {
    const r = await http('POST', startPath, 202);
    if (r.body?.data?.status?.status !== 'running') {
      throw new Error(`expected status='running', got ${JSON.stringify(r.body)}`);
    }
  });

  await test(`${name}: GET /status reflects running task`, async () => {
    const r = await http('GET', statusPath, 200);
    const s = r.body?.data;
    if (!s || (s.status !== 'running' && s.status !== 'done')) {
      // Tolerate the rare race where a fast op finished between the
      // POST and the GET — both 'running' and 'done' are valid here.
      throw new Error(`expected running or done, got ${JSON.stringify(s)}`);
    }
  });

  await test(`${name}: second POST while running returns 409`, async () => {
    // Only meaningful if it's still running at this point. Re-POST and
    // assert 409 OR accept 202 if the prior run already finished.
    const r = await http('POST', startPath);
    if (r.status === 409) {
      if (r.body?.status?.status !== 'running') {
        throw new Error(`expected 409 body to carry running state, got ${JSON.stringify(r.body)}`);
      }
    } else if (r.status === 202) {
      // Prior run finished — that's fine, just verify the new one started.
      if (r.body?.data?.status?.status !== 'running') {
        throw new Error(`re-start 202 missing running state: ${JSON.stringify(r.body)}`);
      }
    } else {
      throw new Error(`expected 409 or 202, got ${r.status}`);
    }
  });

  await test(`${name}: task transitions to done`, async () => {
    const final = await pollUntil(async () => {
      const r = await http('GET', statusPath);
      if (r.body?.data?.status === 'done') return r.body.data;
      if (r.body?.data?.status === 'failed') {
        throw new Error(`task failed: ${r.body.data.error}`);
      }
      return null;
    });
    if (checkResult) checkResult(final.result);
  });
}

(async () => {
  console.log(`Verifying admin-task endpoints at ${BASE}`);

  // Sanity: server is reachable + admin token valid.
  await test('GET /api/admin/auth-status returns 200', async () => {
    await http('GET', '/api/admin/auth-status', 200);
  });

  await test('GET /api/admin/tasks/list returns 200 with array', async () => {
    const r = await http('GET', '/api/admin/tasks/list', 200);
    if (!Array.isArray(r.body?.data)) {
      throw new Error(`expected data array, got ${JSON.stringify(r.body)}`);
    }
  });

  console.log('\nclear-cbz-cache:');
  await exerciseTask({
    name:       'clear-cbz-cache',
    startPath:  '/api/admin/clear-cbz-cache',
    statusPath: '/api/admin/clear-cbz-cache/status',
    checkResult: r => {
      if (typeof r?.size_bytes !== 'number') {
        throw new Error(`expected result.size_bytes, got ${JSON.stringify(r)}`);
      }
    },
  });

  console.log('\nvacuum-db:');
  await exerciseTask({
    name:       'vacuum-db',
    startPath:  '/api/admin/vacuum-db',
    statusPath: '/api/admin/vacuum-db/status',
    checkResult: r => {
      if (typeof r?.size_before_bytes !== 'number' || typeof r?.size_after_bytes !== 'number') {
        throw new Error(`expected size_before/after bytes, got ${JSON.stringify(r)}`);
      }
    },
  });

  console.log('\nreset-thumbnails:');
  await exerciseTask({
    name:       'reset-thumbnails',
    startPath:  '/api/admin/reset-thumbnails',
    statusPath: '/api/admin/reset-thumbnails/status',
    checkResult: r => {
      if (typeof r?.total !== 'number') {
        throw new Error(`expected result.total, got ${JSON.stringify(r)}`);
      }
    },
  });

  console.log('\nregenerate-thumbnails:');
  // This one can run for minutes on a real library — start it, verify it's
  // tracked, then bail. Don't wait for completion in the smoke test.
  await test('regenerate-thumbnails: POST returns 202', async () => {
    const r = await http('POST', '/api/admin/regenerate-thumbnails');
    if (r.status !== 202 && r.status !== 409) {
      throw new Error(`expected 202 or 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    }
  });

  await test('regenerate-thumbnails: tasks/list includes it within 2s', async () => {
    let seen = false;
    for (let i = 0; i < 4 && !seen; i++) {
      const r = await http('GET', '/api/admin/tasks/list');
      const list = r.body?.data || [];
      seen = list.some(t => t.kind === 'regenerate-thumbnails' && t.status === 'running');
      if (!seen) await wait(500);
    }
    if (!seen) throw new Error('regen task not visible in tasks/list within 2s');
  });

  console.log(`\n${testCount - failed} / ${testCount} passing${failed ? ` — ${failed} failed` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(2);
});
