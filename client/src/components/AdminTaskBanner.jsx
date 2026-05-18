import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import './AdminTaskBanner.css';

const POLL_INTERVAL_MS = 5000;

// Task kinds that meaningfully degrade the rest of the app while running.
// These get the top banner because the user otherwise sees Library pages
// load slowly, MangaDetail pages spinner-stall, etc. and has no way to
// connect that back to a long-running admin op started elsewhere.
//
// Other registered kinds (regenerate-thumbnails, optimize-manga,
// bulk-optimize-library) don't visibly slow the rest of the app — their
// progress lives only in the per-card UI where the user triggered them.
//
//   vacuum-db        — holds an exclusive SQLite write lock; all writers queue
//   clear-cbz-cache  — synchronous fs.rmSync loop; starves disk readers
//   reset-thumbnails — many small DB writes + filesystem copies across every
//                       manga in the library
const DEGRADING_KINDS = new Set([
  'vacuum-db',
  'clear-cbz-cache',
  'reset-thumbnails',
]);

const KIND_LABELS = {
  'vacuum-db':        'Database compaction in progress',
  'clear-cbz-cache':  'Clearing CBZ cache',
  'reset-thumbnails': 'Resetting thumbnails',
};

const KIND_DETAIL = {
  'vacuum-db':        'Other actions may be slow until this finishes.',
  'clear-cbz-cache':  'Page loads may be slow until this finishes.',
  'reset-thumbnails': 'Cover updates may lag until this finishes.',
};

function formatElapsed(sec) {
  if (sec == null) return '';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Top-of-app banner that surfaces long-running admin tasks the operator
 * triggered (typically in another tab / device). Polls
 * `GET /api/admin/tasks/list` every 5 s while an admin session is active
 * and the tab is visible. Renders nothing when no admin token is in
 * localStorage — non-admin paired clients don't see infrastructure noise
 * about ops they didn't trigger.
 *
 * Multiple concurrent banner-worthy tasks collapse into one banner that
 * names the longest-running task and notes "(+N other)". The elapsed-time
 * counter tracks the primary (oldest) task.
 */
export default function AdminTaskBanner() {
  const [tasks, setTasks] = useState([]);
  const [now, setNow] = useState(Date.now());
  const mountedRef = useRef(true);
  const pollTimerRef = useRef(null);
  const tickerRef = useRef(null);
  // Bump on each fetch to discard stale responses (mirrors the pattern in
  // useAdminTask) — the banner shouldn't flicker if a slow response
  // returns after a faster subsequent one.
  const requestIdRef = useRef(0);

  function fetchTasks() {
    const adminToken = api.getAdminToken();
    if (!adminToken) {
      if (mountedRef.current) setTasks([]);
      return;
    }
    const myId = ++requestIdRef.current;
    fetch(`${api.getServerUrl()}/api/admin/tasks/list`, {
      headers: { 'X-Admin-Token': adminToken },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(payload => {
        if (!mountedRef.current) return;
        if (myId !== requestIdRef.current) return;
        const list = Array.isArray(payload?.data) ? payload.data : [];
        setTasks(list);
      })
      .catch(() => {
        // Network blip — keep showing the last-known state. The next
        // scheduled poll retries.
      });
  }

  function clearPollTimer() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function schedulePoll() {
    if (!mountedRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    clearPollTimer();
    pollTimerRef.current = setTimeout(() => {
      fetchTasks();
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  // Mount: initial fetch + start polling.
  useEffect(() => {
    mountedRef.current = true;
    fetchTasks();
    schedulePoll();
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
  }, []);

  // 1 s ticker only runs when at least one task is being shown — otherwise
  // it's pointless re-renders. Bound to the running-tasks length via a ref
  // mirror inside the effect.
  const hasRunning = tasks.some(
    t => t && t.status === 'running' && DEGRADING_KINDS.has(t.kind)
  );
  useEffect(() => {
    if (!hasRunning) return;
    tickerRef.current = setInterval(() => {
      if (mountedRef.current) setNow(Date.now());
    }, 1000);
    return () => clearInterval(tickerRef.current);
  }, [hasRunning]);

  // Visibility: pause poll while hidden, refresh + resume on return.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    function onVisChange() {
      if (document.hidden) {
        clearPollTimer();
      } else {
        fetchTasks();
        schedulePoll();
      }
    }
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, []);

  // Filter to running banner-worthy tasks. The list payload may include
  // recently-completed entries (the registry keeps them in memory until
  // the next start of the same kind); we ignore anything not 'running'.
  const running = tasks.filter(
    t => t && t.status === 'running' && DEGRADING_KINDS.has(t.kind)
  );

  if (running.length === 0) return null;

  // Promote the longest-running task to the foreground — that's the one
  // most likely to be impacting the user. If multiple are running, the
  // banner notes "(+N other)" so the user knows the count.
  const primary = running.reduce(
    (a, b) => ((a.started_at || 0) <= (b.started_at || 0) ? a : b),
  );
  const otherCount = running.length - 1;

  const elapsedSec = primary.started_at
    ? Math.floor((now - primary.started_at) / 1000)
    : 0;
  const label  = KIND_LABELS[primary.kind] || 'Long-running task in progress';
  const detail = KIND_DETAIL[primary.kind] || '';

  return (
    <div className="admin-task-banner" role="status" aria-live="polite">
      <span className="admin-task-banner-icon" aria-hidden="true">⚠</span>
      <span className="admin-task-banner-text">
        <strong>{label}</strong>
        {otherCount > 0 && (
          <span className="admin-task-banner-other"> (+{otherCount} other)</span>
        )}
        {detail && <span className="admin-task-banner-detail"> · {detail}</span>}
      </span>
      <span className="admin-task-banner-elapsed">{formatElapsed(elapsedSec)}</span>
    </div>
  );
}
