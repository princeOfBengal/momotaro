import React, { useEffect, useRef } from 'react';
import { useAdminTask } from './useAdminTask';
import { appConfirm } from '../dialog/dialogService';
import { formatElapsed } from '../utils/format';

// ── Long-running admin action button helper ───────────────────────────────────
//
// Each of the heavy admin endpoints (Compact DB, Clear Cache, Reset / Regenerate
// Thumbnails, Bulk Optimize, per-manga Optimize) is now wired through the
// Phase 2 fire-and-forget + status-poll API via the `useAdminTask` hook. This
// helper wraps the hook with the visual state machine the Phase 5 plan
// specified:
//
//   idle                   → render the original button label
//   running, no progress   → "<runningLabel>… 0:14"   (button disabled)
//   running, w/ progress   → "<runningLabel> 242 / 1,847"
//   done, recent           → green badge with formatted result + dismiss ×
//   failed                 → red badge with the server error + dismiss ×
//   done, stale (>5 min)   → revert to idle (the result is from a previous
//                            session; don't keep showing it as fresh)
//
// Returns `{ task, button, badge }`. Cards mount the badge inside the
// description column and the button at the right edge, matching the
// pre-existing card layout.

const STALE_BADGE_MS    = 5 * 60 * 1000;   // older than this → don't show 'done' badge after re-mount
const AUTO_DISMISS_MS   = 30 * 1000;        // newly-done badge auto-clears after this

export function useAdminTaskButton({
  startUrl,
  statusUrl,
  idleLabel,
  runningLabel = 'Running',
  formatResult,            // (result) => string
  confirmMessage,          // optional appConfirm() text before start
  buttonClassName = 'btn btn-ghost btn-sm',
  buttonStyle     = { flexShrink: 0, alignSelf: 'flex-start' },
  buttonTitle,
  disabled: extraDisabled = false,
  onDone,                  // optional side-effect callback when result arrives
}) {
  const task = useAdminTask({ startUrl, statusUrl });

  // Auto-dismiss done badges so the UI doesn't sit on a stale "✓ Done" line
  // indefinitely. Failed badges stick until the user explicitly dismisses.
  useEffect(() => {
    if (!task.isDone || !task.state?.finished_at) return;
    const ageMs = Date.now() - task.state.finished_at;
    if (ageMs >= STALE_BADGE_MS) {
      // Re-mounted onto an old completion — clear silently.
      task.reset();
      return;
    }
    const remaining = Math.max(0, AUTO_DISMISS_MS - ageMs);
    const t = setTimeout(() => task.reset(), remaining);
    return () => clearTimeout(t);
  }, [task.isDone, task.state?.finished_at, task.reset]);

  // Fire the `onDone` callback once per running→done transition.
  const prevDoneRef = useRef(false);
  useEffect(() => {
    if (task.isDone && !prevDoneRef.current && onDone) {
      try { onDone(task.result); } catch (_) { /* swallowed — telemetry */ }
    }
    prevDoneRef.current = task.isDone;
  }, [task.isDone, task.result, onDone]);

  async function handleClick() {
    if (confirmMessage && !(await appConfirm(confirmMessage))) return;
    try { await task.start(); } catch (_) { /* surfaced via task.lastError */ }
  }

  // Compose the button label from the live state.
  let label = idleLabel;
  if (task.isRunning) {
    const p = task.progress;
    if (p && p.current != null && p.total) {
      label = `${runningLabel} ${p.current.toLocaleString()} / ${p.total.toLocaleString()}…`;
    } else {
      label = `${runningLabel}… ${formatElapsed(task.elapsedSec)}`;
    }
  }

  const button = (
    <button
      className={buttonClassName}
      style={buttonStyle}
      onClick={handleClick}
      disabled={task.isRunning || extraDisabled}
      title={
        task.isRunning
          ? `Started ${formatElapsed(task.elapsedSec)} ago`
          : buttonTitle
      }
    >
      {label}
    </button>
  );

  // Decide whether to render any badge. `lastError` (POST-time error) is
  // shown only when the task isn't otherwise reporting a state — e.g. a
  // 500 from the server before any state was applied.
  const isStaleFinish = task.state?.finished_at &&
                        Date.now() - task.state.finished_at > STALE_BADGE_MS;
  let badge = null;
  if (!task.isRunning && !isStaleFinish) {
    if (task.isDone) {
      badge = (
        <p className="db-op-status db-op-status-ok db-op-status-row">
          <span>
            ✓ {formatResult ? formatResult(task.result) : 'Done'}
            {task.elapsedSec > 1 && <span className="db-op-elapsed"> ({formatElapsed(task.elapsedSec)})</span>}
          </span>
          <button
            type="button"
            className="db-op-dismiss"
            onClick={() => task.reset()}
            aria-label="Dismiss"
            title="Dismiss"
          >×</button>
        </p>
      );
    } else if (task.isFailed) {
      badge = (
        <p className="db-op-status db-op-status-err db-op-status-row">
          <span>✗ Failed: {task.error || 'unknown error'}</span>
          <button
            type="button"
            className="db-op-dismiss"
            onClick={() => task.reset()}
            aria-label="Dismiss"
            title="Dismiss"
          >×</button>
        </p>
      );
    } else if (task.lastError) {
      badge = (
        <p className="db-op-status db-op-status-err db-op-status-row">
          <span>✗ {task.lastError}</span>
          <button
            type="button"
            className="db-op-dismiss"
            onClick={() => task.reset()}
            aria-label="Dismiss"
            title="Dismiss"
          >×</button>
        </p>
      );
    }
  }

  return { task, button, badge };
}
