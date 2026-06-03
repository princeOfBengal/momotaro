import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConnectivity } from '../context/ConnectivityContext';
import {
  listDownloads,
  cancelJob,
  retryJob,
  deleteSeries as downloaderDeleteSeries,
  deleteChapter as downloaderDeleteChapter,
  onChange as onDownloaderChange,
} from '../api/downloader';
import { listOfflineManga, clearFinishedJobs } from '../api/offlineDb';
import { appConfirm } from '../dialog/dialogService';
import {
  isAvailable as offlineStorageAvailable,
  getStatus   as offlineGetStatus,
} from '../api/offlineStorage';
import './Downloads.css';

// Top-level downloads-management page. Mounted at /downloads via the lazy
// route in App.jsx. Two tabs: "Queue" (every job — queued, running,
// failed, cancelled, done within the last day) and "Library" (every series
// with at least one downloaded chapter).

const QUEUE_TERMINAL_STATES = new Set(['done', 'failed', 'cancelled']);

function statusLabel(j, downloadsAllowed) {
  if (j.status === 'running' && j.progress) {
    return `Downloading ${j.progress.current}/${j.progress.total}…`;
  }
  if (j.status === 'failed') return `Failed — ${j.error || 'unknown error'}`;
  // P3: "Queued" while the network is gated reads as "Paused" — same
  // underlying job state, but the user-visible reason is different. The
  // ConnectivityContext owns the gate; we don't try to figure it out here.
  if (j.status === 'queued' && !downloadsAllowed) return 'Paused';
  return j.status.charAt(0).toUpperCase() + j.status.slice(1);
}

export default function Downloads() {
  const navigate = useNavigate();
  const { downloadsAllowed, wifiOnly, networkType, online } = useConnectivity();
  const [tab, setTab]   = useState('queue'); // 'queue' | 'library'
  const [jobs, setJobs] = useState([]);
  const [series, setSeries] = useState([]);
  const [busy, setBusy] = useState(false);
  // SAF folder status — async to fetch, but small. Refreshed on mount and
  // every downloader event so a pick/clear in Settings reflects here
  // without the user navigating away.
  const [folderStatus, setFolderStatus] = useState({ configured: false, displayName: null });

  const nativeOnly = !offlineStorageAvailable();

  const reload = useCallback(async () => {
    try {
      const [j, s, fs] = await Promise.all([
        listDownloads(),
        listOfflineManga({ sort: 'updated' }),
        offlineGetStatus(),
      ]);
      j.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      setJobs(j);
      setSeries(s);
      setFolderStatus(fs);
    } catch { /* ignore — IDB unavailable */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const off = onDownloaderChange(() => { reload(); });
    return off;
  }, [reload]);

  const counts = useMemo(() => {
    let queued = 0, running = 0, failed = 0, done = 0, cancelled = 0;
    for (const j of jobs) {
      if (j.status === 'queued')    queued++;
      else if (j.status === 'running')  running++;
      else if (j.status === 'failed')   failed++;
      else if (j.status === 'done')     done++;
      else if (j.status === 'cancelled') cancelled++;
    }
    return { queued, running, failed, done, cancelled, total: jobs.length };
  }, [jobs]);

  async function handleClearFinished() {
    if (!(await appConfirm('Clear all done and cancelled rows from the queue?', { okLabel: 'Clear' }))) return;
    setBusy(true);
    try { await clearFinishedJobs(); await reload(); }
    finally { setBusy(false); }
  }

  async function handleDeleteSeries(mangaId) {
    if (!(await appConfirm('Remove this downloaded series from the device? On-disk files will be deleted.', { danger: true, okLabel: 'Delete' }))) return;
    setBusy(true);
    try { await downloaderDeleteSeries(mangaId); await reload(); }
    finally { setBusy(false); }
  }

  return (
    <div className="downloads-page">
      <nav className="navbar">
        <Link to="/library" className="btn btn-ghost">← Library</Link>
        <Link to="/" className="navbar-brand">
          <img src="/logo.png" alt="Momotaro" className="navbar-logo" />
        </Link>
        <div className="navbar-spacer" />
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">⚙</button>
      </nav>

      <main className="downloads-main">
        <header className="downloads-header">
          <h1 className="downloads-title">Downloads</h1>
          <p className="downloads-subtitle">
            {nativeOnly
              ? 'Offline downloads are only available in the Android app.'
              : folderStatus.configured
                ? <>Saving to <code>{folderStatus.displayName || '(picked folder)'}</code></>
                : <>No download folder chosen yet —{' '}
                    <Link to="/settings" state={{ section: 'offline' }}>
                      pick one in Settings →
                    </Link>{' '}
                    to enable downloads.</>}
          </p>
          <p className="downloads-network">
            <span className={`downloads-status-dot downloads-status-dot-${downloadsAllowed ? 'ok' : 'paused'}`} />
            {online
              ? (downloadsAllowed
                  ? `Queue active over ${networkType}`
                  : `Queue paused (Wi-Fi only; current network: ${networkType})`)
              : 'Queue paused (server unreachable)'}
            {wifiOnly && <span className="downloads-network-meta"> · Wi-Fi only</span>}
          </p>
        </header>

        <div className="downloads-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'queue'}
            className={`downloads-tab${tab === 'queue' ? ' active' : ''}`}
            onClick={() => setTab('queue')}
          >Queue <span className="downloads-tab-count">({counts.total})</span></button>
          <button
            role="tab"
            aria-selected={tab === 'library'}
            className={`downloads-tab${tab === 'library' ? ' active' : ''}`}
            onClick={() => setTab('library')}
          >Downloaded ({series.length})</button>
        </div>

        {tab === 'queue' && (
          <section className="downloads-section" aria-labelledby="downloads-queue">
            <div className="downloads-section-head">
              <h2 id="downloads-queue" className="downloads-section-title">
                {counts.running > 0 && <span>{counts.running} active</span>}
                {counts.queued  > 0 && <span> · {counts.queued} queued</span>}
                {counts.failed  > 0 && <span className="downloads-meta-bad"> · {counts.failed} failed</span>}
                {counts.total === 0 && <span>No downloads yet</span>}
              </h2>
              {(counts.done > 0 || counts.cancelled > 0) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={handleClearFinished}
                  disabled={busy}
                >Clear finished</button>
              )}
            </div>

            {counts.total === 0 ? (
              <p className="downloads-empty">
                Open a manga and tap the download icon to queue chapters.
              </p>
            ) : (
              <ul className="downloads-job-list">
                {jobs.map(j => {
                  const terminal = QUEUE_TERMINAL_STATES.has(j.status);
                  return (
                    <li key={j.id} className={`downloads-job downloads-job-${j.status}`}>
                      <Link
                        to={`/manga/${j.manga_id}`}
                        className="downloads-job-link"
                      >
                        <span className="downloads-job-title">
                          {j.kind === 'series' ? `Series #${j.manga_id}` : `Chapter ${j.chapter_id}`}
                        </span>
                        <span className="downloads-job-meta">
                          manga #{j.manga_id}{j.attempts ? ` · attempt ${j.attempts}` : ''}
                        </span>
                      </Link>
                      <span className={`downloads-job-status${j.status === 'queued' && !downloadsAllowed ? ' downloads-job-status-paused' : ''}`}>{statusLabel(j, downloadsAllowed)}</span>
                      {j.status === 'failed' && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => retryJob(j.id)}
                        >Retry</button>
                      )}
                      {!terminal && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => cancelJob(j.id)}
                        >Cancel</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {tab === 'library' && (
          <section className="downloads-section" aria-labelledby="downloads-lib">
            <div className="downloads-section-head">
              <h2 id="downloads-lib" className="downloads-section-title">
                {series.length} downloaded {series.length === 1 ? 'series' : 'series'}
              </h2>
            </div>

            {series.length === 0 ? (
              <p className="downloads-empty">
                Nothing downloaded yet. Open any manga and tap "Download
                series" or the per-chapter download icon.
              </p>
            ) : (
              <ul className="downloads-series-list">
                {series.map(m => (
                  <li key={m.id} className="downloads-series">
                    <Link to={`/manga/${m.id}`} className="downloads-series-cover">
                      {m.cover_url
                        ? <img src={m.cover_url} alt="" loading="lazy" />
                        : <div className="downloads-series-cover-fallback" aria-hidden="true">📕</div>}
                    </Link>
                    <div className="downloads-series-body">
                      <Link to={`/manga/${m.id}`} className="downloads-series-title">{m.title}</Link>
                      <p className="downloads-series-meta">
                        {m.chapter_count || 0} chapter{m.chapter_count === 1 ? '' : 's'}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleDeleteSeries(m.id)}
                      disabled={busy}
                    >Delete</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
