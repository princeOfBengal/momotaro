# Phase 8 — Long-running admin actions: verification checklist

The async + status-poll rewrite (Phases 1–6) replaced the synchronous
heavy-action endpoints (VACUUM, clear cache, reset / regenerate thumbnails,
optimize manga, bulk-optimize-library) with a fire-and-forget + status-poll
pattern, plus a UI hook, badged buttons, and a top-of-app degradation
banner.

This file is the manual verification matrix. The two automated pieces are
covered separately:

- **`server/test/taskRegistry.test.js`** — runs locally with
  `node test/taskRegistry.test.js`. Covers the registry state machine
  (start / done / failed, 409 conflict, progress reports, per-resource
  keying, event-loop deferral). No live server needed.
- **`scripts/verify-admin-tasks.cjs`** — runs against a live dockerized
  instance with `MOMOTARO_URL` + `MOMOTARO_ADMIN_TOKEN` env vars set.
  Covers the HTTP contract (202 / 409 / GET status / tasks list).

Everything below requires eyes-on-screen — these are UX states, cross-tab
sync, browser visibility, and Android backgrounding behaviour. Allow ~45
min for a full pass.

## Setup

1. `docker compose up -d --build`.
2. Open the web UI at `http://<host>:3000` in **two browser tabs** of the
   same browser (cross-tab sync test relies on the same `localStorage`).
3. **Settings → Client Management → Admin login** in tab A. Verify tab B
   also reflects the admin session on refresh.
4. Open the dev-tools Network panel in tab A and keep it visible.

## Scenarios

### 1. Happy path — each global action shows live elapsed time
For each of: **Compact Database**, **Clear Cache**, **Reset Thumbnails**,
**Regenerate All**:

- Click the button in **Settings → Database & Cache**.
- The button label switches within ~200 ms to `<verb>… 0:01` (or
  `<verb> N / M…` for regen-thumbnails once the first progress tick
  arrives).
- The label ticks every second.
- On completion, a green badge appears in the description column:
  `✓ <formatted result>`. Auto-dismisses after 30s. Manual × works.
- Network panel shows a single POST returning **202** (not 200), then
  ~1 GET to `/status` every 1.5 s.

### 2. Navigate-away survival
- Click **Compact Database**.
- Within 1 s, click the breadcrumb to navigate to **Library**.
- Library loads (observably slower while VACUUM holds the lock).
- Click **Settings** in the sidebar.
- The Compact Database button still shows `Compacting… 0:NN` with the
  correct elapsed time, ticking. Polling has resumed.

### 3. Reload survival — VACUUM only (persisted)
- Click **Compact Database**.
- Once it says `Compacting… 0:03`, hit **Cmd/Ctrl-R** (hard reload).
- After the SPA re-mounts, navigate to **Settings**.
- Compact Database shows `Compacting… 0:0N` again, picked up from the
  server's persisted state. Elapsed time is computed from the real
  `started_at`, not from the reload moment.
- Eventually transitions to `✓ Compacted: X MB → Y MB`.

### 4. Server restart mid-VACUUM
- Click **Compact Database** in tab A.
- In a terminal: `docker compose restart momotaro` (or kill+restart).
- Wait for the server to come back up (the page may show network errors
  during the gap — that's expected).
- Hard-reload the SPA. Navigate to **Settings**.
- Compact Database shows a red badge: `✗ Failed: Server restarted while
  this task was running`. The badge is from the persisted
  `admin_tasks` table, written by `taskRegistry.init()` on boot.
- Click **×** to dismiss. Click **Compact Database** again to verify it
  starts fresh and completes normally.

### 5. Concurrent click
- Click **Clear Cache** rapidly **three times in a row**.
- First click: button transitions to `Clearing… 0:00`.
- Second and third clicks: **no error toast**, no error badge, button
  stays in `Clearing…` state.
- Network panel: 1st POST returns 202; subsequent POSTs return **409**
  with `{ status: { kind: 'clear-cbz-cache', status: 'running', ... } }`
  in the body.
- Completion: single green badge appears.

### 6. Cross-tab adoption
- In **tab A**, click **Compact Database**.
- Within ~2 s, switch to **tab B** and navigate to **Settings**.
- Within one poll interval (≤1.5 s), tab B's Compact Database button
  transitions from idle to `Compacting… 0:NN`. The elapsed values in
  tab A and tab B match (modulo the poll lag).
- When the task completes, both tabs show the badge.

### 7. Tab backgrounded
- Click **Regenerate All** (long-running enough to test backgrounding).
- Once it shows `Regenerating 5 / 1,847…`, switch to a different tab or
  minimize the browser.
- Wait ~30 s.
- Return to the Momotaro tab.
- Within ~1 s the badge catches up to the current progress (e.g.
  `Regenerating 412 / 1,847…`).
- Network panel: polls paused while the tab was hidden, immediate
  refetch on visibility return, then normal cadence resumes.

### 8. Degradation banner
- In a fresh tab on the Home page, verify no banner is showing.
- Switch to Settings, click **Compact Database**.
- Within ~5 s (one banner-poll interval), the yellow banner appears at
  the top: `⚠ Database compaction in progress · Other actions may be
  slow until this finishes. 0:NN`.
- Navigate to **Library**. Banner stays visible; library loads observably
  slow during the VACUUM.
- Navigate back to Settings. Banner still visible.
- On completion, banner unmounts within ~5 s.

#### 8a. Multiple banner-worthy ops
- Click **Compact Database**, then immediately **Clear Cache**.
- Banner shows the older (vacuum) task with `(+1 other)` next to the
  label.
- As each task completes, the banner downgrades; eventually unmounts.

#### 8b. Non-admin paired client doesn't see the banner
- Open a private/incognito window. Pair a fake "client" via the public
  pairing flow (admin in the main window approves the PIN). The
  incognito window now has a `momotaro_client_token` but no
  `momotaro_admin_token`.
- Trigger VACUUM in the admin window.
- The incognito window does NOT show the banner. Browse Library /
  MangaDetail — works (slowly) but never surfaces the banner.

### 9. Per-manga isolation
- Open **MangaDetail** for Manga A. Click the ⋯ menu → **Optimize
  Chapters**. Confirm. Modal shows `Optimizing… 0:NN`.
- While that's running, navigate to **MangaDetail** for Manga B
  (different manga). Open its Optimize modal — it shows the **Confirm**
  phase (Manga B has its own per-manga task slot).
- Confirm Manga B's optimize. Both modals now show running state
  independently.
- Each completes independently, each shows its own result counters.

### 10. Failure path
**Induce a failure for VACUUM** (one easy way: temporarily make
`data/momotaro.db` read-only via `chmod 0444 data/momotaro.db` from
inside the container):

- Click **Compact Database**.
- Within ~10 s, button shows `✗ Failed: <SQLite error message>`.
- Restore write permission (`chmod 0644 data/momotaro.db`).
- Click **Compact Database** again — completes normally.

Clean up: `chmod 0644 data/momotaro.db` (or just `docker compose
restart`).

### 11. Per-manga optimize modal — live-state adoption
- Open Manga A's Optimize modal. Click Confirm. Modal shows
  `Optimizing… 0:NN`.
- Click outside the modal to close it (note: while running, the modal
  should refuse to close — this confirms it).
- Wait until the task completes (badge appears in the modal).
- Click **Done** to dismiss the modal.
- Re-open the modal — it should be back in the **Confirm** phase (the
  `openOptimizeModal` handler calls `task.reset()` to clear stale done
  state).

### 12. Polling stops when nothing is running
- Settle the server (no tasks).
- In an idle Settings tab, watch the network panel for 30 s.
- Confirmed: GET `/api/admin/tasks/list` fires every ~5 s (banner poll).
  No per-task `/status` GETs unless a task is running.

## Pre-flight check (run before manual verification)

```bash
# Local unit tests
cd server && node test/taskRegistry.test.js

# HTTP smoke test against the running server
docker compose up -d
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<your-admin-password>"}' | jq -r '.data.admin_token')
MOMOTARO_URL=http://localhost:3000 \
MOMOTARO_ADMIN_TOKEN=$ADMIN_TOKEN \
  node scripts/verify-admin-tasks.cjs
```

Both should report all green before the manual matrix begins.

## Known-acceptable quirks (NOT bugs)

- **VACUUM blocks readers.** The async rewrite fixes the HTTP-timeout
  problem; it does NOT make the rest of the app responsive while VACUUM
  holds the write lock. The Phase 6 banner is what acknowledges this to
  the user. A future server-health follow-up could split the work via
  `PRAGMA incremental_vacuum`.
- **409 logs as `request_error`** in the connection log (any 4xx is
  logged by `requestLogger`). A user double-clicking Compact Database
  leaves a connection-log row. Documented; can be suppressed with a
  one-line skip-list rule if it gets noisy.
- **`POST /admin/vacuum-db` API contract changed** from 200-with-inline-
  result to 202-with-status-link. Anyone scripting these endpoints
  externally (curl in cron, monitoring) needs to follow the new
  status-companion pattern. Release-note line covers this.
- **Reset-thumbnails badge fires the degradation banner** even though
  the op doesn't actually hold a global lock. Conservative — the banner
  is informational. Move it out of `DEGRADING_KINDS` in
  `AdminTaskBanner.jsx` if it proves misleading.
- **Per-manga and bulk-optimize aren't in the banner.** Intentional —
  per-manga optimize is per-resource, bulk-optimize-library is per-
  library; neither degrades the rest of the app.
