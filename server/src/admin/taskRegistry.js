/**
 * Shared task primitive for long-running admin actions (VACUUM, CBZ-cache
 * wipe, manga optimize, thumbnail regeneration).
 *
 * Why this exists: the original sync-and-await pattern for these endpoints
 * means the client times out before the server finishes, even though the
 * work completes. Wrapping them in a tiny in-process registry lets the
 * HTTP handler return 202 immediately, while a status companion endpoint
 * exposes whatever state the runner is currently in. See the Phase 1 plan
 * in CHANGELOG / git log for the broader context.
 *
 * Concurrency model: one task at a time per (kind, resourceId) pair.
 * resourceId is null for global ops (vacuum-db, clear-cbz-cache,
 * reset-thumbnails); per-manga optimize uses the manga id. A second start
 * for the same key while the first is still running returns
 * `{ ok: false, state: <existing> }` so the route handler can respond with
 * 409 and the caller can adopt the existing run.
 *
 * Persistence: most task state lives in memory only — it's fine to lose a
 * "done — 312 MB freed" badge across a restart. The exception is VACUUM,
 * which can run for minutes on a multi-TB DB; if the operator restarts the
 * server thinking it's hung, we don't want the UI to silently report "no
 * task ever ran". Persisted kinds (see PERSISTED_KINDS) mirror their state
 * to the `admin_tasks` table on every transition; `init()` is called at
 * boot to flip any persisted 'running' row to 'interrupted'.
 */

const { getDb } = require('../db/database');

// `${kind}:${resourceId ?? ''}` → state object (mutated in place by the runner)
const tasks = new Map();

// Task kinds whose state mirrors to `admin_tasks` so it survives a restart.
// Keep this tight — every persisted kind costs one DB write at task-start
// and one at task-finish, and we don't want admin_tasks to become a
// general-purpose activity log.
const PERSISTED_KINDS = new Set(['vacuum-db']);

function keyOf(kind, resourceId) {
  return `${kind}:${resourceId == null ? '' : resourceId}`;
}

// Strip the internal cursor (timeouts, callbacks) before handing state out
// to a route. Today state has no internal-only fields, but the indirection
// is cheap and means we can add some without leaking them through `get()`.
function publicState(state) {
  if (!state) return null;
  return {
    kind:         state.kind,
    resource_id:  state.resource_id,
    status:       state.status,
    started_at:   state.started_at,
    finished_at:  state.finished_at,
    progress:     state.progress,
    result:       state.result,
    error:        state.error,
  };
}

function persistInsert(state) {
  if (!PERSISTED_KINDS.has(state.kind)) return;
  try {
    getDb().prepare(`
      INSERT INTO admin_tasks (kind, status, started_at, finished_at, result_json, error)
      VALUES (?, 'running', ?, NULL, NULL, NULL)
      ON CONFLICT(kind) DO UPDATE SET
        status      = 'running',
        started_at  = excluded.started_at,
        finished_at = NULL,
        result_json = NULL,
        error       = NULL
    `).run(state.kind, state.started_at);
  } catch (err) {
    // Telemetry must never abort a real task — log and continue with
    // in-memory-only state for this run.
    console.warn(`[TaskRegistry] persistInsert(${state.kind}) failed: ${err.message}`);
  }
}

function persistFinish(state) {
  if (!PERSISTED_KINDS.has(state.kind)) return;
  try {
    getDb().prepare(`
      UPDATE admin_tasks
         SET status      = ?,
             finished_at = ?,
             result_json = ?,
             error       = ?
       WHERE kind        = ?
    `).run(
      state.status,
      state.finished_at,
      state.result == null ? null : JSON.stringify(state.result),
      state.error,
      state.kind,
    );
  } catch (err) {
    console.warn(`[TaskRegistry] persistFinish(${state.kind}) failed: ${err.message}`);
  }
}

function loadPersisted(kind) {
  if (!PERSISTED_KINDS.has(kind)) return null;
  try {
    const row = getDb().prepare(`
      SELECT kind, status, started_at, finished_at, result_json, error
        FROM admin_tasks
       WHERE kind = ?
    `).get(kind);
    if (!row) return null;
    let result = null;
    if (row.result_json) {
      try { result = JSON.parse(row.result_json); } catch (_) { result = null; }
    }
    return {
      kind:        row.kind,
      resource_id: null,
      status:      row.status,
      started_at:  row.started_at,
      finished_at: row.finished_at,
      progress:    null,
      result,
      error:       row.error,
    };
  } catch (err) {
    console.warn(`[TaskRegistry] loadPersisted(${kind}) failed: ${err.message}`);
    return null;
  }
}

/**
 * Begin a task. The runner is invoked via setImmediate so the route
 * handler that called start() can flush its 202 response *before* a
 * synchronous heavy runner (db.exec('VACUUM'), fs.rmSync) blocks the event
 * loop. Without the defer, the start() caller would itself sit on the
 * blocked tick and the 202 would arrive only after the work completed —
 * which is exactly the behaviour we're trying to fix.
 *
 *   start(kind, resourceId, runner, opts?) →
 *     { ok: true,  state }  — accepted; runner queued
 *     { ok: false, state }  — same (kind, resourceId) already running
 *
 * The runner signature is `async (report) => result`. Call
 * `report(current, total, label?)` from inside to publish progress.
 * The resolved value becomes `state.result`; thrown errors become
 * `state.error`.
 */
function start(kind, resourceId, runner, _opts = {}) {
  const k = keyOf(kind, resourceId);
  const existing = tasks.get(k);
  if (existing && existing.status === 'running') {
    return { ok: false, state: publicState(existing) };
  }

  const state = {
    kind,
    resource_id: resourceId == null ? null : resourceId,
    status:      'running',
    started_at:  Date.now(),
    finished_at: null,
    progress:    null,
    result:      null,
    error:       null,
  };
  tasks.set(k, state);
  persistInsert(state);

  setImmediate(async () => {
    const report = (current, total, label) => {
      state.progress = {
        current: current == null ? null : Number(current),
        total:   total   == null ? null : Number(total),
        label:   label   == null ? null : String(label),
      };
    };
    try {
      const result = await runner(report);
      state.status      = 'done';
      state.finished_at = Date.now();
      state.result      = result == null ? null : result;
      state.progress    = null;
      persistFinish(state);
    } catch (err) {
      state.status      = 'failed';
      state.finished_at = Date.now();
      state.error       = err && err.message ? err.message : String(err);
      state.progress    = null;
      persistFinish(state);
      const tag = resourceId == null ? kind : `${kind}:${resourceId}`;
      console.warn(`[TaskRegistry] ${tag} failed: ${state.error}`);
    }
  });

  return { ok: true, state: publicState(state) };
}

/**
 * Lookup current state for (kind, resourceId). Falls back to the persisted
 * row when nothing is in memory AND the kind is persisted — that's the
 * recovery path after a server restart, where the in-memory map is empty
 * but admin_tasks still holds the 'interrupted' row written by init().
 */
function get(kind, resourceId) {
  const inMemory = tasks.get(keyOf(kind, resourceId));
  if (inMemory) return publicState(inMemory);
  if (resourceId == null) {
    const persisted = loadPersisted(kind);
    if (persisted) return persisted;
  }
  return null;
}

/**
 * Snapshot of every task currently in memory — used by the future
 * "Background tasks" UI banner. Persisted historical entries are not
 * included; a separate endpoint can read admin_tasks directly if a
 * history view is ever added.
 */
function list() {
  return Array.from(tasks.values()).map(publicState);
}

/**
 * One-shot startup hook. Marks any persisted row still tagged 'running' as
 * 'interrupted' with a synthetic error message, so a UI status poll after
 * a restart returns an honest answer instead of a stale heartbeat. Safe to
 * call multiple times — the UPDATE only fires on rows that match.
 */
function init() {
  try {
    const { changes } = getDb().prepare(`
      UPDATE admin_tasks
         SET status      = 'interrupted',
             finished_at = ?,
             error       = 'Server restarted while this task was running'
       WHERE status      = 'running'
    `).run(Date.now());
    if (changes > 0) {
      console.log(`[TaskRegistry] Marked ${changes} interrupted task(s) on startup.`);
    }
  } catch (err) {
    console.warn(`[TaskRegistry] init() failed: ${err.message}`);
  }
}

module.exports = { start, get, list, init, PERSISTED_KINDS };
