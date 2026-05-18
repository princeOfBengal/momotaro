import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';

const DEFAULT_POLL_MS = 1500;

/**
 * React hook that drives a long-running admin action UI.
 *
 * Kicks off the POST, picks up an already-running task on mount, polls
 * the status endpoint while it's running, and exposes an elapsed-time
 * counter so the button can render "Compacting database… 0:14".
 *
 * Pairs with the Phase 2 endpoint convention: a POST that returns 202
 * (or 409 if already running, with the current state in the body) and a
 * GET /status companion that returns the same state shape:
 *
 *   { kind, resource_id, status, started_at, finished_at,
 *     progress, result, error }
 *
 * Behaviour notes:
 *   - 409 on POST is treated as "another tab/click started this already";
 *     the hook silently adopts the returned state instead of reporting
 *     an error.
 *   - Polling pauses when the tab is hidden and refreshes immediately
 *     when it returns to the foreground.
 *   - Network errors during polling are silently retried; only POST
 *     errors that aren't 202/409 surface as `lastError`. Otherwise the
 *     UI would flash a red banner every time Wi-Fi blinks while a task
 *     is running.
 *   - In-flight responses from earlier requests are discarded if a newer
 *     request has been issued in the meantime — protects against the
 *     mount-fetch vs start() race.
 *   - `reset()` clears local 'done' / 'failed' state for the dismiss-the-
 *     badge use case. No-op while running, since there's no cancel API.
 *   - The hook never cancels a running task. Leaving the component just
 *     stops the UI from tracking — work continues server-side.
 */
export function useAdminTask({
  startUrl,
  statusUrl,
  pollIntervalMs = DEFAULT_POLL_MS,
}) {
  const [state, setState] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const mountedRef = useRef(true);
  const pollTimerRef = useRef(null);
  const tickerRef = useRef(null);
  const tickerStartedAtRef = useRef(null);
  // Mirror of `state?.status === 'running'` so the visibility-change
  // handler can decide whether to refetch without the parent effect
  // re-binding on every state transition.
  const isRunningRef = useRef(false);
  // Monotonic counter. Each fetch / start captures the current value at
  // dispatch; any in-flight response whose captured id is older than the
  // latest value when it returns is treated as superseded and its result
  // is thrown away. Protects against the initial /status fetch resolving
  // *after* the user has already clicked start() and applied a newer
  // 'running' state on top.
  const latestRequestIdRef = useRef(0);

  function buildHeaders() {
    const adminToken = api.getAdminToken();
    const clientToken = api.getClientToken();
    const h = { 'Content-Type': 'application/json' };
    if (adminToken)  h['X-Admin-Token'] = adminToken;
    if (clientToken) h['Authorization'] = `Bearer ${clientToken}`;
    return h;
  }

  function buildUrl(path) {
    return `${api.getServerUrl()}${path}`;
  }

  function clearPollTimer() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function stopTicker() {
    if (tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    tickerStartedAtRef.current = null;
  }

  function ensureTicker(startedAtMs) {
    // Tickers are keyed by started_at — if a new task starts (different
    // started_at), we restart the ticker so the counter doesn't carry the
    // previous run's accumulated time.
    if (tickerStartedAtRef.current === startedAtMs) return;
    stopTicker();
    tickerStartedAtRef.current = startedAtMs;
    const update = () => {
      if (!mountedRef.current) return;
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    };
    update();
    tickerRef.current = setInterval(update, 1000);
  }

  function schedulePoll(delay = pollIntervalMs) {
    if (!mountedRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    clearPollTimer();
    pollTimerRef.current = setTimeout(fetchStatus, delay);
  }

  function applyState(next) {
    if (!mountedRef.current) return;
    setState(next);
    isRunningRef.current = next?.status === 'running';
    if (isRunningRef.current) {
      ensureTicker(next.started_at);
      schedulePoll();
      return;
    }
    clearPollTimer();
    stopTicker();
    if (next && next.started_at && next.finished_at) {
      // Show final duration on the done / failed / interrupted badge.
      setElapsedSec(Math.max(0, Math.floor((next.finished_at - next.started_at) / 1000)));
    } else if (!next) {
      setElapsedSec(0);
    }
  }

  async function fetchStatus() {
    const myId = ++latestRequestIdRef.current;
    try {
      const resp = await fetch(buildUrl(statusUrl), { headers: buildHeaders() });
      if (myId !== latestRequestIdRef.current) return;
      if (!resp.ok) return; // 401/403/5xx — keep existing state; poll will retry
      const json = await resp.json();
      if (myId !== latestRequestIdRef.current) return;
      applyState(json?.data ?? null);
    } catch (_) {
      if (myId !== latestRequestIdRef.current) return;
      // Network blip — leave state alone; the next scheduled poll retries.
    }
  }

  // Mount: pick up any in-progress task so navigating back to a page
  // mid-task shows the live indicator instead of an idle button.
  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();
    return () => {
      mountedRef.current = false;
      clearPollTimer();
      stopTicker();
    };
    // statusUrl is the identity of this hook instance — changing it
    // should restart everything. Caller typically passes a constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusUrl]);

  // Visibility: pause poll while hidden, refresh immediately on return
  // if we last knew the task was running. Bound once, reads the latest
  // running state via ref so we don't re-bind per state change.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    function onVisChange() {
      if (document.hidden) {
        clearPollTimer();
      } else if (isRunningRef.current) {
        fetchStatus();
      }
    }
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    setLastError(null);
    // Bump the request id so any in-flight status fetch is invalidated
    // and can't overwrite the state we're about to apply from the POST.
    const myId = ++latestRequestIdRef.current;
    try {
      const resp = await fetch(buildUrl(startUrl), {
        method: 'POST',
        headers: buildHeaders(),
      });
      const json = await resp.json().catch(() => ({}));
      if (myId !== latestRequestIdRef.current) return;
      if (resp.status === 202 || resp.status === 409) {
        // 202 — we just started it. 409 — another tab/click already
        // started it; the body carries the existing task state. Both
        // adopt the state and begin polling.
        const taskState = json?.data?.status ?? json?.status ?? null;
        if (taskState) {
          applyState(taskState);
        } else {
          // Server didn't echo the state — fall back to a status fetch.
          fetchStatus();
        }
        return;
      }
      throw new Error(json?.error || `HTTP ${resp.status}`);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err && err.message ? err.message : String(err);
      setLastError(msg);
      throw err;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startUrl]);

  const reset = useCallback(() => {
    if (isRunningRef.current) return;
    setState(null);
    setLastError(null);
    setElapsedSec(0);
    stopTicker();
  }, []);

  return {
    state,
    start,
    reset,
    elapsedSec,
    isRunning: state?.status === 'running',
    isDone:    state?.status === 'done',
    isFailed:  state?.status === 'failed' || state?.status === 'interrupted',
    progress:  state?.progress ?? null,
    result:    state?.result   ?? null,
    error:     state?.error    ?? null,
    lastError,
  };
}
