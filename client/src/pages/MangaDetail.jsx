import React, { useState, useEffect, useCallback, useDeferredValue, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAdminTask } from '../hooks/useAdminTask';
import { useConnectivity } from '../context/ConnectivityContext';
import {
  queueChapter,
  queueSeries,
  cancelJob,
  retryJob,
  deleteChapter as downloaderDeleteChapter,
  deleteSeries  as downloaderDeleteSeries,
  refreshOfflineSnapshot,
  isOfflineSnapshotStale,
  onChange      as onDownloaderChange,
} from '../api/downloader';
import { getJobForChapter, listJobs, getOfflineChapter, listOfflineChaptersForManga } from '../api/offlineDb';
import { isAvailable as offlineStorageAvailable } from '../api/offlineStorage';
import { getResume, clearResume } from '../utils/readingProgress';
import { appAlert, appConfirm, ensureAdminAccess } from '../dialog/dialogService';
import './MangaDetail.css';

const CHAPTERS_COLLAPSED_COUNT = 5;

// Threshold above which we render the chapter-filter input. Below this,
// scrolling the list is fast enough that an input would just be clutter.
const CHAPTER_FILTER_THRESHOLD = 50;
// Threshold above which we render the Jump-to-current button. Lower than
// the filter threshold because users want a fast resume mechanism even
// before lists get hard to scroll.
const CHAPTER_JUMP_THRESHOLD = 30;

// Single source of truth for chapter-label formatting. Used by both the
// chapter row and the resume subtitle below the Continue Reading button
// so the labels never diverge. Falls back to folder_name when both
// volume and number are unknown (manga ripped without metadata).
function formatChapterLabel(ch, trackVolumes) {
  if (!ch) return '—';
  if (ch.volume != null && ch.number != null) {
    return `Vol. ${ch.volume} Ch. ${ch.number}`;
  }
  if (ch.volume != null) return `Volume ${ch.volume}`;
  if (ch.number != null) {
    return `${trackVolumes ? 'Volume' : 'Chapter'} ${ch.number}`;
  }
  return ch.folder_name || '—';
}

// ── Offline-download status hooks ───────────────────────────────────────────
// Tiny IDB-backed selectors used by the chapter/series download UI. They
// re-read on every downloader event so we get push updates without polling.

function useChapterDownloadStatus(chapterId) {
  // Shape: { status: 'queued'|'running'|'done'|'failed'|'cancelled'|null,
  //          progress: { current, total } | null, jobId, error }
  const [state, setState] = useState({ status: null });
  useEffect(() => {
    // On the PWA / regular-browser path the offline downloader is a no-op
    // (no filesystem access) and the only consumer of this hook —
    // ChapterDownloadButton — returns null. Rules-of-hooks force the
    // hook to still mount; we just skip the IDB work + subscription so
    // a 200-chapter MangaDetail doesn't fire 200 background queries on
    // a browser session.
    if (!offlineStorageAvailable()) return;
    if (!chapterId) return;
    let cancelled = false;
    async function refresh() {
      try {
        const [job, ch] = await Promise.all([
          getJobForChapter(chapterId),
          getOfflineChapter(chapterId),
        ]);
        if (cancelled) return;
        if (job) {
          setState({ status: job.status, progress: job.progress, jobId: job.id, error: job.error });
        } else if (ch && ch.status === 'done') {
          setState({ status: 'done' });
        } else {
          setState({ status: null });
        }
      } catch {
        if (!cancelled) setState({ status: null });
      }
    }
    refresh();
    const off = onDownloaderChange(refresh);
    return () => { cancelled = true; off(); };
  }, [chapterId]);
  return state;
}

// Aggregate state for an entire series. Returns the count of chapters in
// each terminal-or-active bucket plus an overall "phase":
//   - 'none'        — nothing in the DB
//   - 'partial'     — some chapters done, others not even queued
//   - 'downloading' — at least one queued/running
//   - 'complete'    — every known chapter is done
function useSeriesDownloadSummary(mangaId, chapterIds) {
  const [summary, setSummary] = useState({ phase: 'none', done: 0, active: 0, failed: 0, total: 0 });
  useEffect(() => {
    // Same rationale as useChapterDownloadStatus: SeriesDownloadButton
    // already returns null on PWA, so don't fire IDB queries we'll throw
    // away. Keeps PWA MangaDetail mount cost identical to pre-P1.
    if (!offlineStorageAvailable()) {
      setSummary({ phase: 'none', done: 0, active: 0, failed: 0, total: chapterIds?.length || 0 });
      return;
    }
    if (!mangaId || !chapterIds || chapterIds.length === 0) {
      setSummary({ phase: 'none', done: 0, active: 0, failed: 0, total: 0 });
      return;
    }
    let cancelled = false;
    const idSet = new Set(chapterIds.map(Number));
    async function refresh() {
      try {
        // One scan of each store, no per-chapter round-trips. The series
        // can have hundreds of chapters; firing one IDB get per chapter
        // on every downloader event would dominate the render budget on
        // mid-tier devices.
        const [jobs, downloadedChapters] = await Promise.all([
          listJobs(),
          listOfflineChaptersForManga(Number(mangaId)),
        ]);

        const doneSet = new Set(
          downloadedChapters.filter(c => c.status === 'done').map(c => Number(c.id))
        );
        let done = 0, active = 0, failed = 0;
        for (const cid of idSet) if (doneSet.has(cid)) done++;

        // Track chapters we've already attributed so a chapter with both
        // a 'failed' job row and a follow-up 'done' job counts once.
        const attributed = new Set(doneSet);
        for (const j of jobs) {
          const cid = Number(j.chapter_id);
          if (!idSet.has(cid) || attributed.has(cid)) continue;
          if (j.status === 'running' || j.status === 'queued') {
            active++;
            attributed.add(cid);
          } else if (j.status === 'failed') {
            failed++;
            attributed.add(cid);
          }
        }
        if (cancelled) return;
        let phase = 'none';
        if (active > 0) phase = 'downloading';
        else if (done === idSet.size) phase = 'complete';
        else if (done > 0) phase = 'partial';
        setSummary({ phase, done, active, failed, total: idSet.size });
      } catch {
        if (!cancelled) setSummary({ phase: 'none', done: 0, active: 0, failed: 0, total: chapterIds.length });
      }
    }
    refresh();
    const off = onDownloaderChange(refresh);
    return () => { cancelled = true; off(); };
  }, [mangaId, chapterIds]);
  return summary;
}

function chapterDownloadBadgeLabel(state, downloadsAllowed = true) {
  if (!state) return null;
  switch (state.status) {
    case 'queued':    return downloadsAllowed ? 'Queued' : 'Paused';
    case 'running':   return state.progress
      ? `${state.progress.current}/${state.progress.total}`
      : 'Downloading…';
    case 'done':      return 'Downloaded';
    case 'failed':    return 'Failed';
    case 'cancelled': return 'Cancelled';
    default:          return null;
  }
}

// Series-level download CTA. Hidden when running in a non-native shell
// (downloads need filesystem access). State machine:
//   - none/partial → "Download series" (queues every missing chapter)
//   - downloading → "Downloading X/Y…"  + Cancel
//   - complete    → "Downloaded ✓"      + Remove
//   - complete + stale → "Refresh offline copy" (server has newer data)
function SeriesDownloadButton({ mangaId, chapters, serverUpdatedAt }) {
  const { online } = useConnectivity();
  const navigate = useNavigate();
  const chapterIds = React.useMemo(
    () => (chapters || []).map(c => Number(c.id)),
    [chapters],
  );
  const summary = useSeriesDownloadSummary(mangaId, chapterIds);
  const [busy, setBusy]       = useState(false);
  const [errMsg, setErrMsg]   = useState(null);
  const [stale, setStale]     = useState(false);

  // Recheck stale status whenever the manga's server updated_at changes or
  // a download finishes (which writes the new server_updated_at locally).
  useEffect(() => {
    let cancelled = false;
    if (!mangaId || !serverUpdatedAt) {
      setStale(false);
      return;
    }
    isOfflineSnapshotStale(mangaId, serverUpdatedAt)
      .then(v => { if (!cancelled) setStale(v); })
      .catch(() => { if (!cancelled) setStale(false); });
    return () => { cancelled = true; };
  }, [mangaId, serverUpdatedAt, summary.done]);

  if (!offlineStorageAvailable()) return null;
  if (!chapters || chapters.length === 0) return null;

  async function startDownload() {
    if (!online) {
      setErrMsg('Server unreachable — connect to download.');
      return;
    }
    setBusy(true);
    setErrMsg(null);
    try { await queueSeries(mangaId); }
    catch (e) {
      // NO_FOLDER is the user-actionable case from the SAF gate. Offer
      // to send them straight to Settings → Offline so they can pick.
      if (e && e.code === 'NO_FOLDER') {
        const go = await appConfirm(
          'Pick a download folder first.\n\n'
          + 'Open Settings → Offline Downloads now?',
          { okLabel: 'Open Settings' },
        );
        if (go) navigate('/settings', { state: { section: 'offline' } });
        return;
      }
      setErrMsg(String(e?.message || e));
    }
    finally { setBusy(false); }
  }

  async function cancelAll() {
    setBusy(true);
    try {
      const jobs = await listJobs();
      const mine = jobs.filter(j =>
        Number(j.manga_id) === Number(mangaId)
        && (j.status === 'queued' || j.status === 'running'),
      );
      for (const j of mine) await cancelJob(j.id);
    } finally { setBusy(false); }
  }

  async function removeAll() {
    if (!(await appConfirm('Remove every downloaded chapter of this series from the device?', { danger: true, okLabel: 'Remove' }))) return;
    setBusy(true);
    try { await downloaderDeleteSeries(mangaId); }
    finally { setBusy(false); }
  }

  async function refreshSnapshot() {
    setBusy(true);
    setErrMsg(null);
    try {
      const result = await refreshOfflineSnapshot(mangaId);
      setStale(false);
      const parts = [];
      if (result.newly_queued > 0) {
        parts.push(`${result.newly_queued} new`);
      }
      if (result.restaged > 0) {
        parts.push(`${result.restaged} updated`);
      }
      if (parts.length > 0) {
        // Toast-style — reuse the title attribute as a lightweight signal.
        setErrMsg(`Queued ${parts.join(', ')} chapter${(result.newly_queued + result.restaged) === 1 ? '' : 's'}.`);
      }
    } catch (e) {
      setErrMsg(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  // Render based on summary phase.
  if (summary.phase === 'downloading') {
    return (
      <button
        className="btn btn-ghost detail-action-btn"
        onClick={cancelAll}
        disabled={busy}
        aria-label="Cancel downloads"
        title="Cancel downloads"
      >
        <svg className="detail-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <line x1="6" y1="6" x2="10" y2="10" />
          <line x1="10" y1="6" x2="6" y2="10" />
        </svg>
        <span className="detail-action-label">
          Downloading {summary.done}/{summary.total}…
        </span>
      </button>
    );
  }

  if (summary.phase === 'complete') {
    if (stale && online) {
      return (
        <button
          className="btn btn-ghost detail-action-btn"
          onClick={refreshSnapshot}
          disabled={busy}
          aria-label="Refresh offline copy"
          title={errMsg || 'New chapters or metadata available on the server.'}
        >
          <svg className="detail-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 8a6 6 0 1 1-1.76-4.24" />
            <polyline points="14 2 14 6 10 6" />
          </svg>
          <span className="detail-action-label">Refresh offline copy</span>
        </button>
      );
    }
    return (
      <button
        className="btn btn-ghost detail-action-btn"
        onClick={removeAll}
        disabled={busy}
        aria-label="Remove downloaded series"
        title="Remove downloaded series"
      >
        <svg className="detail-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 13 6" />
          <path d="M5 6l1 8a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2l1-8" />
        </svg>
        <span className="detail-action-label">Downloaded ✓</span>
      </button>
    );
  }

  const label = summary.phase === 'partial'
    ? `Resume download (${summary.total - summary.done} left)`
    : 'Download series';

  return (
    <button
      className="btn btn-ghost detail-action-btn"
      onClick={startDownload}
      disabled={busy || !online}
      aria-label={label}
      title={errMsg || label}
    >
      <svg className="detail-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 2v9" />
        <polyline points="4 7 8 11 12 7" />
        <path d="M2 13h12" />
      </svg>
      <span className="detail-action-label">{label}</span>
    </button>
  );
}

// Compact per-chapter download control. Renders a small icon button inside
// each chapter row; clicking queues / cancels / removes that single chapter.
function ChapterDownloadButton({ mangaId, chapterId }) {
  const state = useChapterDownloadStatus(chapterId);
  const { online, downloadsAllowed } = useConnectivity();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!offlineStorageAvailable()) return null;

  async function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      switch (state.status) {
        case 'done':
          if (await appConfirm('Remove this downloaded chapter?', { danger: true, okLabel: 'Remove' })) {
            await downloaderDeleteChapter(mangaId, chapterId);
          }
          break;
        case 'failed':
          if (state.jobId) await retryJob(state.jobId);
          break;
        case 'queued':
        case 'running':
          if (state.jobId) await cancelJob(state.jobId);
          break;
        default:
          if (!online) return;
          try { await queueChapter(mangaId, chapterId); }
          catch (err) {
            // Same NO_FOLDER routing as the series-level button — offer
            // a confirm + nav so the user isn't stuck reading a generic
            // error in a tooltip.
            if (err && err.code === 'NO_FOLDER') {
              const go = await appConfirm(
                'Pick a download folder first.\n\n'
                + 'Open Settings → Offline Downloads now?',
                { okLabel: 'Open Settings' },
              );
              if (go) navigate('/settings', { state: { section: 'offline' } });
            } else {
              throw err;
            }
          }
      }
    } finally { setBusy(false); }
  }

  const label = chapterDownloadBadgeLabel(state, downloadsAllowed);
  const isActive = state.status === 'queued' || state.status === 'running';
  const isDone   = state.status === 'done';
  const isFailed = state.status === 'failed';

  return (
    <button
      className={`chapter-mark-btn chapter-download-btn`
        + (isActive ? ' is-downloading' : '')
        + (isDone   ? ' is-downloaded' : '')
        + (isFailed ? ' is-failed' : '')}
      onClick={handleClick}
      disabled={busy || (!isDone && !isActive && !isFailed && !online)}
      title={label || (online ? 'Download chapter' : 'Connect to download')}
      aria-label={label || 'Download chapter'}
    >
      {isActive ? (
        <div className="spinner" style={{ width: 14, height: 14, borderWidth: 1.5 }} />
      ) : isDone ? (
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <circle cx="10" cy="10" r="8" fill="currentColor" />
          <path d="M6 10l3 3 5-6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      ) : isFailed ? (
        <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true">
          <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
          <line x1="10" y1="6" x2="10" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="10" cy="14" r="0.8" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true">
          <path d="M10 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <polyline points="6 9 10 13 14 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M5 15h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

// "0:14", "1:23" — shown next to the spinner while optimize is running so
// the user has feedback that things are progressing even with no per-chapter
// progress signal coming from the server (per-manga optimize is a single
// pass; bulk-optimize-library is the one that emits per-item progress).
function formatOptimizeElapsed(sec) {
  if (sec == null) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Thumbnail Picker Modal ─────────────────────────────────────────────────────
function ThumbOption({ src, label, applying, onUse }) {
  return (
    <div
      className={`thumb-option${applying ? ' thumb-option-applying' : ''}`}
      onClick={!applying ? onUse : undefined}
      title={label || undefined}
    >
      <div className="thumb-option-img-wrap">
        <img src={src} alt={label || ''} loading="lazy" />
        {applying && (
          <div className="thumb-option-overlay">
            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
          </div>
        )}
      </div>
      {label && <span className="thumb-option-label">{label}</span>}
    </div>
  );
}

function ThumbnailPickerModal({ mangaId, onApplied, onClose }) {
  const [options, setOptions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [applying, setApplying] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState(null);

  useEffect(() => {
    api.getThumbnailOptions(mangaId)
      .then(data => setOptions(data))
      .catch(err => setLoadError(err.message));
  }, [mangaId]);

  async function applyFile(filename) {
    setApplying(filename);
    try {
      await api.setThumbnailFromFile(mangaId, filename);
      onApplied();
    } catch (err) {
      appAlert('Failed: ' + err.message);
      setApplying(null);
    }
  }

  async function applyPage(pageId) {
    setApplying(pageId);
    try {
      await api.setPageAsThumbnail(mangaId, pageId);
      onApplied();
    } catch (err) {
      appAlert('Failed: ' + err.message);
      setApplying(null);
    }
  }

  async function generateCovers() {
    setGenerating(true);
    setGenerateMsg(null);
    try {
      const result = await api.generateChapterCovers(mangaId);
      const parts = [];
      if (result.generated) parts.push(`${result.generated} new`);
      if (result.skipped)   parts.push(`${result.skipped} reused`);
      if (result.errors)    parts.push(`${result.errors} error${result.errors === 1 ? '' : 's'}`);
      setGenerateMsg(
        parts.length > 0
          ? `Generated chapter covers — ${parts.join(', ')}.`
          : 'No chapters available to generate from.'
      );
      const refreshed = await api.getThumbnailOptions(mangaId);
      setOptions(refreshed);
    } catch (err) {
      setGenerateMsg('Failed: ' + err.message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box thumb-picker-modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Choose Thumbnail</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="thumb-picker-body">
          <div className="thumb-picker-actions">
            <button
              className="thumb-picker-generate-btn"
              onClick={generateCovers}
              disabled={generating || !options}
              title="Render a thumbnail from the first page of every chapter"
            >
              {generating ? 'Generating…' : 'Generate Covers'}
            </button>
            {generateMsg && (
              <span
                className={`thumb-picker-generate-msg${generateMsg.startsWith('Failed') ? ' is-error' : ''}`}
              >{generateMsg}</span>
            )}
          </div>

          {!options && !loadError && (
            <div className="loading-center" style={{ minHeight: 120 }}>
              <div className="spinner" />
            </div>
          )}
          {loadError && <p className="thumb-picker-error">{loadError}</p>}
          {options && (
            <>
              {options.anilist_cover && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">AniList</h3>
                  <div className="thumb-picker-grid">
                    <ThumbOption
                      src={api.thumbnailUrl(options.anilist_cover)}
                      label="AniList Cover"
                      applying={applying === options.anilist_cover}
                      onUse={() => applyFile(options.anilist_cover)}
                    />
                  </div>
                </div>
              )}

              {options.mal_cover && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">MyAnimeList</h3>
                  <div className="thumb-picker-grid">
                    <ThumbOption
                      src={api.thumbnailUrl(options.mal_cover)}
                      label="MAL Cover"
                      applying={applying === options.mal_cover}
                      onUse={() => applyFile(options.mal_cover)}
                    />
                  </div>
                </div>
              )}

              {options.mangaupdates_cover && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">MangaUpdates</h3>
                  <div className="thumb-picker-grid">
                    <ThumbOption
                      src={api.thumbnailUrl(options.mangaupdates_cover)}
                      label="MangaUpdates Cover"
                      applying={applying === options.mangaupdates_cover}
                      onUse={() => applyFile(options.mangaupdates_cover)}
                    />
                  </div>
                </div>
              )}

              {options.doujinshi_cover && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">Doujinshi.info</h3>
                  <div className="thumb-picker-grid">
                    <ThumbOption
                      src={api.thumbnailUrl(options.doujinshi_cover)}
                      label="Doujinshi.info Cover"
                      applying={applying === options.doujinshi_cover}
                      onUse={() => applyFile(options.doujinshi_cover)}
                    />
                  </div>
                </div>
              )}

              {options.original_cover && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">Original</h3>
                  <div className="thumb-picker-grid">
                    <ThumbOption
                      src={api.thumbnailUrl(options.original_cover)}
                      label="Scan Default"
                      applying={applying === options.original_cover}
                      onUse={() => applyFile(options.original_cover)}
                    />
                  </div>
                </div>
              )}

              {options.history.length > 0 && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">Previously Used</h3>
                  <div className="thumb-picker-grid">
                    {options.history.map(h => (
                      <ThumbOption
                        key={h.id}
                        src={api.thumbnailUrl(h.filename)}
                        applying={applying === h.filename}
                        onUse={() => applyFile(h.filename)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {options.chapter_first_pages.length > 0 && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">Chapter Covers</h3>
                  <div className="thumb-picker-grid">
                    {options.chapter_first_pages.map(ch => (
                      ch.generated_filename
                        ? (
                          <ThumbOption
                            key={ch.chapter_id}
                            src={api.thumbnailUrl(ch.generated_filename)}
                            label={ch.label}
                            applying={applying === ch.generated_filename}
                            onUse={() => applyFile(ch.generated_filename)}
                          />
                        )
                        : (
                          <ThumbOption
                            key={ch.chapter_id}
                            src={api.pageImageUrl(ch.page_id)}
                            label={ch.label}
                            applying={applying === ch.page_id}
                            onUse={() => applyPage(ch.page_id)}
                          />
                        )
                    ))}
                  </div>
                </div>
              )}

              {!options.anilist_cover && !options.mal_cover && !options.original_cover && options.history.length === 0
                  && options.chapter_first_pages.length === 0 && (
                <p className="thumb-picker-empty">No thumbnail options available yet. Read a chapter first to generate options.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Manual Search Modal ────────────────────────────────────────────────────────
function AnilistSearchModal({ mangaId, defaultQuery, onApplied, onClose }) {
  const [query, setQuery] = useState(defaultQuery || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.searchAnilist(q.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  // Auto-search on open with default query
  useEffect(() => {
    if (defaultQuery) doSearch(defaultQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApply(result) {
    setApplying(result.anilist_id);
    try {
      const updated = await api.applyMetadata(mangaId, result.anilist_id);
      onApplied(updated);
    } catch (err) {
      appAlert('Failed to apply: ' + err.message);
      setApplying(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') doSearch(query);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Search AniList</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-search-row">
          <input
            className="modal-search-input"
            type="text"
            placeholder="Search manga title..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="btn btn-primary"
            onClick={() => doSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div className="modal-results">
          {searchError && <p className="modal-error">{searchError}</p>}
          {results.map(r => (
            <div key={r.anilist_id} className="modal-result-row">
              {r.cover_url && (
                <img
                  className="modal-result-cover"
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                />
              )}
              <div className="modal-result-info">
                <p className="modal-result-title">{r.title}</p>
                <p className="modal-result-meta">
                  {r.year && <span>{r.year}</span>}
                  {r.status && <span>{r.status}</span>}
                  {r.score && <span>★ {r.score.toFixed(1)}</span>}
                </p>
                {r.genres.length > 0 && (
                  <p className="modal-result-genres">
                    {r.genres.slice(0, 4).join(' · ')}
                  </p>
                )}
              </div>
              <button
                className="btn btn-primary modal-result-btn"
                disabled={applying === r.anilist_id}
                onClick={() => handleApply(r)}
              >
                {applying === r.anilist_id ? '...' : 'Use'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Doujinshi.Info Search Modal ────────────────────────────────────────────────
function DoujinshiSearchModal({ mangaId, defaultQuery, onApplied, onClose }) {
  const [query, setQuery] = useState(defaultQuery || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.searchDoujinshi(q.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (defaultQuery) doSearch(defaultQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApply(result) {
    setApplying(result.doujinshi_id);
    try {
      const updated = await api.applyDoujinshiMetadata(mangaId, result.doujinshi_id);
      onApplied(updated);
    } catch (err) {
      appAlert('Failed to apply: ' + err.message);
      setApplying(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') doSearch(query);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Search Doujinshi.info</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-search-row">
          <input
            className="modal-search-input"
            type="text"
            placeholder="Search title..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="btn btn-primary"
            onClick={() => doSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div className="modal-results">
          {searchError && <p className="modal-error">{searchError}</p>}
          {results.map(r => (
            <div key={r.doujinshi_id} className="modal-result-row">
              {r.cover_url && (
                <img
                  className="modal-result-cover"
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                />
              )}
              <div className="modal-result-info">
                <p className="modal-result-title">{r.title}</p>
                <p className="modal-result-meta">
                  {r.year && <span>{r.year}</span>}
                  {r.status && <span>{r.status}</span>}
                </p>
                {r.genres && r.genres.length > 0 && (
                  <p className="modal-result-genres">
                    {r.genres.slice(0, 4).join(' · ')}
                  </p>
                )}
              </div>
              <button
                className="btn btn-primary modal-result-btn"
                disabled={applying === r.doujinshi_id}
                onClick={() => handleApply(r)}
              >
                {applying === r.doujinshi_id ? '...' : 'Use'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── MyAnimeList Search Modal ──────────────────────────────────────────────────
function MALSearchModal({ mangaId, defaultQuery, onApplied, onClose }) {
  const [query, setQuery] = useState(defaultQuery || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.searchMal(q.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (defaultQuery) doSearch(defaultQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApply(result) {
    setApplying(result.mal_id);
    try {
      const updated = await api.applyMalMetadata(mangaId, result.mal_id);
      onApplied(updated);
    } catch (err) {
      appAlert('Failed to apply: ' + err.message);
      setApplying(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') doSearch(query);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Search MyAnimeList</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-search-row">
          <input
            className="modal-search-input"
            type="text"
            placeholder="Search manga title..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="btn btn-primary"
            onClick={() => doSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div className="modal-results">
          {searchError && <p className="modal-error">{searchError}</p>}
          {results.map(r => (
            <div key={r.mal_id} className="modal-result-row">
              {r.cover_url && (
                <img
                  className="modal-result-cover"
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                />
              )}
              <div className="modal-result-info">
                <p className="modal-result-title">{r.title}</p>
                <p className="modal-result-meta">
                  {r.year && <span>{r.year}</span>}
                  {r.status && <span>{r.status}</span>}
                  {r.score && <span>★ {r.score.toFixed(1)}</span>}
                </p>
                {r.genres && r.genres.length > 0 && (
                  <p className="modal-result-genres">
                    {r.genres.slice(0, 4).join(' · ')}
                  </p>
                )}
              </div>
              <button
                className="btn btn-primary modal-result-btn"
                disabled={applying === r.mal_id}
                onClick={() => handleApply(r)}
              >
                {applying === r.mal_id ? '...' : 'Use'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── MangaUpdates Search Modal ──────────────────────────────────────────────
function MangaUpdatesSearchModal({ mangaId, defaultQuery, onApplied, onClose }) {
  const [query, setQuery] = useState(defaultQuery || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.searchMangaUpdates(q.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (defaultQuery) doSearch(defaultQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApply(result) {
    setApplying(result.mangaupdates_id);
    try {
      const updated = await api.applyMangaUpdatesMetadata(mangaId, result.mangaupdates_id);
      onApplied(updated);
    } catch (err) {
      appAlert('Failed to apply: ' + err.message);
      setApplying(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') doSearch(query);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Search MangaUpdates</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-search-row">
          <input
            className="modal-search-input"
            type="text"
            placeholder="Search manga title..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="btn btn-primary"
            onClick={() => doSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div className="modal-results">
          {searchError && <p className="modal-error">{searchError}</p>}
          {results.map(r => (
            <div key={r.mangaupdates_id} className="modal-result-row">
              {r.cover_url && (
                <img
                  className="modal-result-cover"
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                />
              )}
              <div className="modal-result-info">
                <p className="modal-result-title">{r.title}</p>
                <p className="modal-result-meta">
                  {r.year && <span>{r.year}</span>}
                  {r.status && <span>{r.status}</span>}
                  {r.score && <span>★ {r.score.toFixed(1)}</span>}
                </p>
                {r.genres && r.genres.length > 0 && (
                  <p className="modal-result-genres">
                    {r.genres.slice(0, 4).join(' · ')}
                  </p>
                )}
              </div>
              <button
                className="btn btn-primary modal-result-btn"
                disabled={applying === r.mangaupdates_id}
                onClick={() => handleApply(r)}
              >
                {applying === r.mangaupdates_id ? '...' : 'Use'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── AniList Status Panel ───────────────────────────────────────────────────────
const STATUS_LABELS = {
  CURRENT:   'Reading',
  COMPLETED: 'Completed',
  PLANNING:  'Plan to Read',
  DROPPED:   'Dropped',
  PAUSED:    'Paused',
  REPEATING: 'Re-Reading',
};

function formatAnilistDate(d) {
  if (!d || !d.year) return null;
  const parts = [d.year, d.month, d.day].filter(Boolean);
  if (parts.length === 3) return new Date(d.year, d.month - 1, d.day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (parts.length === 2) return new Date(d.year, d.month - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  return String(d.year);
}

function EditableNumber({ value, onSave, saving, step = 1, min = 0, max, display }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  function startEdit() {
    setDraft(String(value ?? 0));
    setEditing(true);
  }

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    const n = step === 1 ? parseInt(draft, 10) : parseFloat(draft);
    const clamped = max !== undefined ? Math.min(max, Math.max(min, n)) : Math.max(min, n);
    if (!isNaN(clamped) && clamped !== (value ?? 0)) {
      onSave(clamped);
    }
    setEditing(false);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setEditing(false);
  }

  if (editing) {
    return (
      <span className="al-edit-inline">
        <input
          ref={inputRef}
          type="number"
          min={min}
          max={max}
          step={step}
          className="al-edit-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        {max !== undefined && <span className="al-edit-max">/ {max}</span>}
      </span>
    );
  }

  return (
    <span className="al-edit-inline">
      <span className="al-status-value">{display ?? (value ?? 0)}</span>
      <button
        className="al-edit-btn"
        onClick={startEdit}
        disabled={saving}
        title="Edit"
      >✎</button>
    </span>
  );
}

function AnilistStatusPanel({ status, onEntryChange, onBreakLinkage, mangaId }) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  if (status === null) {
    return (
      <div className="al-status-panel al-status-loading">
        <div className="al-status-header">
          <span className="al-status-source">AniList</span>
        </div>
        <div className="al-status-skeleton" />
      </div>
    );
  }

  if (!status.logged_in) {
    return (
      <div className="al-status-panel al-status-disconnected">
        <div className="al-status-header">
          <span className="al-status-source">AniList</span>
          <span className="al-status-hint">Connect an AniList account in Settings to see your reading status here.</span>
        </div>
      </div>
    );
  }

  if (!status.linked) {
    return (
      <div className="al-status-panel al-status-disconnected">
        <div className="al-status-header">
          <span className="al-status-source">AniList</span>
          <span className="al-status-hint">No AniList entry linked. Use <em>Fetch Metadata</em> below to link this manga.</span>
        </div>
      </div>
    );
  }

  const { entry, anilist_id } = status;

  async function handleSave(field, value) {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {};
      if (field === 'chapters') body.chapters = value;
      if (field === 'volumes')  body.volumes  = value;
      if (field === 'status')   body.status   = value;
      if (field === 'score')    body.score    = value;
      const result = await api.updateAnilistProgress(mangaId, body);
      onEntryChange(result.entry);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="al-status-panel">
      <div className="al-status-header">
        <span className="al-status-source">AniList</span>
        {anilist_id && (
          <div className="al-status-header-links">
            <a
              className="al-status-link"
              href={`https://anilist.co/manga/${anilist_id}`}
              target="_blank"
              rel="noreferrer"
            >
              View on AniList ↗
            </a>
            {onBreakLinkage && (
              <button
                type="button"
                className="al-status-break-btn"
                onClick={onBreakLinkage}
              >
                Break Linkage
              </button>
            )}
          </div>
        )}
      </div>

      {!entry ? (
        <p className="al-status-empty">Not on your list yet. Progress will be added automatically when you read.</p>
      ) : (
        <div className="al-status-body">
          {saveError && <p className="al-save-error">{saveError}</p>}

          <div className="al-status-row">
            <span className="al-status-field">Status</span>
            <select
              className={`al-status-badge al-badge-${entry.status?.toLowerCase()} al-status-select`}
              value={entry.status || 'CURRENT'}
              onChange={e => handleSave('status', e.target.value)}
              disabled={saving}
            >
              {Object.entries(STATUS_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          <div className="al-status-row">
            <span className="al-status-field">Chapters Read</span>
            <EditableNumber
              value={entry.progress ?? 0}
              saving={saving}
              onSave={n => handleSave('chapters', n)}
            />
          </div>

          <div className="al-status-row">
            <span className="al-status-field">Volumes Read</span>
            <EditableNumber
              value={entry.progressVolumes ?? 0}
              saving={saving}
              onSave={n => handleSave('volumes', n)}
            />
          </div>

          <div className="al-status-row">
            <span className="al-status-field">Your Score</span>
            <EditableNumber
              value={entry.score ?? 0}
              saving={saving}
              step={0.5}
              min={0}
              max={10}
              display={entry.score > 0 ? `★ ${entry.score % 1 === 0 ? entry.score : entry.score.toFixed(1)}` : '—'}
              onSave={n => handleSave('score', n)}
            />
          </div>

          {formatAnilistDate(entry.startedAt) && (
            <div className="al-status-row">
              <span className="al-status-field">Started</span>
              <span className="al-status-value">{formatAnilistDate(entry.startedAt)}</span>
            </div>
          )}

          {formatAnilistDate(entry.completedAt) && (
            <div className="al-status-row">
              <span className="al-status-field">Completed</span>
              <span className="al-status-value">{formatAnilistDate(entry.completedAt)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Schedule editor (lives inside SourceUrlsModal) ─────────────────────────────
//
// A schedule fires the per-manga auto-check that walks every recorded source
// URL, diffs against the local folder by chapter number, and enqueues
// anything missing. The poll cadence on the server is once per minute, so
// the schedule's effective resolution is the minute set in `time_of_day`.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ScheduleEditor({ mangaId, hasUrls }) {
  const [schedule, setSchedule] = useState(null); // server row, or `null` if unset
  const [loading,  setLoading]  = useState(true);

  // Local form state — populated from `schedule` once it loads.
  const [enabled,   setEnabled]   = useState(true);
  const [frequency, setFrequency] = useState('daily');
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [timeOfDay, setTimeOfDay] = useState('09:00');

  const [saving,    setSaving]    = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedFlash, setSavedFlash] = useState(null);

  const [running,   setRunning]   = useState(false);
  const [runResult, setRunResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getMangaSchedule(mangaId);
      setSchedule(data);
      if (data) {
        setEnabled(!!data.enabled);
        setFrequency(data.frequency);
        setDayOfWeek(data.day_of_week ?? 0);
        setTimeOfDay(data.time_of_day);
      }
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setLoading(false);
    }
  }, [mangaId]);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSavedFlash(null);
    try {
      const body = {
        enabled,
        frequency,
        time_of_day: timeOfDay,
        day_of_week: frequency === 'weekly' ? dayOfWeek : null,
      };
      const updated = await api.saveMangaSchedule(mangaId, body);
      setSchedule(updated);
      setSavedFlash('Saved.');
      setTimeout(() => setSavedFlash(null), 2000);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.deleteMangaSchedule(mangaId);
      setSchedule(null);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRunNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const result = await api.runMangaScheduleNow(mangaId);
      setRunResult(result);
      // Refresh schedule so last_checked_at + last_result are up to date.
      load();
    } catch (err) {
      setRunResult({ ok: false, summary: err.message, enqueued: 0 });
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return <div className="loading-center" style={{ minHeight: 80 }}><div className="spinner" /></div>;
  }

  return (
    <div>
      {!hasUrls && (
        <p className="settings-hint" style={{ margin: '0 0 10px' }}>
          Add at least one source URL above before scheduling — the scheduler
          checks each recorded URL for new chapters.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />
          Enabled
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Frequency
          </label>
          <select
            className="setting-select"
            value={frequency}
            onChange={e => setFrequency(e.target.value)}
            style={{ minWidth: 110 }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>

        {frequency === 'weekly' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
              Day
            </label>
            <select
              className="setting-select"
              value={dayOfWeek}
              onChange={e => setDayOfWeek(parseInt(e.target.value, 10))}
              style={{ minWidth: 130 }}
            >
              {DAY_NAMES.map((name, i) => (
                <option key={i} value={i}>{name}</option>
              ))}
            </select>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Time (server local)
          </label>
          <input
            className="setting-select"
            type="time"
            value={timeOfDay}
            onChange={e => setTimeOfDay(e.target.value)}
            style={{ minWidth: 110 }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving || !hasUrls}
        >
          {saving ? 'Saving…' : (schedule ? 'Update schedule' : 'Save schedule')}
        </button>

        {schedule && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleDelete}
            disabled={saving}
          >
            Remove schedule
          </button>
        )}

        <button
          className="btn btn-ghost btn-sm"
          onClick={handleRunNow}
          disabled={running || !hasUrls}
          title="Check for new chapters right now, regardless of the schedule"
        >
          {running ? 'Checking…' : 'Run check now'}
        </button>

        {savedFlash && <span className="sp-status sp-status-success">{savedFlash}</span>}
        {saveError && <span className="sp-status sp-status-error">{saveError}</span>}
      </div>

      {runResult && (
        <p
          className="settings-hint"
          style={{
            marginTop: 8,
            color: runResult.ok ? 'var(--success, #6c6)' : 'var(--danger, #f55)',
          }}
        >
          Run result: {runResult.summary}
          {runResult.enqueued > 0 && ' — see Downloads in Third Party Sourcing.'}
        </p>
      )}

      {schedule && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          {schedule.next_run_at && schedule.enabled && (
            <div>Next run: {new Date(schedule.next_run_at * 1000).toLocaleString()}</div>
          )}
          {schedule.last_checked_at && (
            <div>
              Last run: {new Date(schedule.last_checked_at * 1000).toLocaleString()}
              {schedule.last_result && ` — ${schedule.last_result}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Third Party Source URLs modal ──────────────────────────────────────────────
//
// Manages the per-manga record of source URLs that drives both manual
// re-downloads and the future scheduler. The list is auto-populated by the
// download flow; this modal lets the user paste a new URL, fix one whose
// slug changed, or remove a dead link.
function SourceUrlsModal({ manga, onClose }) {
  const navigate = useNavigate();
  const [urls, setUrls] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [newUrl, setNewUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [editError, setEditError] = useState(null);

  const [pendingDelete, setPendingDelete] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await api.getMangaSourceUrls(manga.id);
      setUrls(data);
    } catch (err) {
      setLoadError(err.message);
    }
  }, [manga.id]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e) {
    e?.preventDefault?.();
    if (!newUrl.trim() || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.addMangaSourceUrl(manga.id, { url: newUrl.trim() });
      setNewUrl('');
      load();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit(row) {
    if (!editingValue.trim()) {
      setEditError('URL cannot be empty.');
      return;
    }
    setEditError(null);
    try {
      await api.updateMangaSourceUrl(manga.id, row.id, { url: editingValue.trim() });
      setEditingId(null);
      setEditingValue('');
      load();
    } catch (err) {
      setEditError(err.message);
    }
  }

  async function handleDelete(row) {
    try {
      await api.deleteMangaSourceUrl(manga.id, row.id);
      setPendingDelete(null);
      load();
    } catch (err) {
      appAlert(err.message);
    }
  }

  function handleSearchNew() {
    onClose?.();
    navigate(`/third-party-sourcing?manga_id=${manga.id}`);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Third Party Sources</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '0 4px 12px' }}>
          <button
            className="btn btn-primary"
            onClick={handleSearchNew}
            style={{ width: '100%' }}
          >
            Search third-party sources for "{manga.title}"
          </button>
          <p className="settings-hint" style={{ marginTop: 8 }}>
            Pre-fills the search and locks the destination to this series so any
            chapters you queue land in the right folder.
          </p>
        </div>

        <div className="modal-results" style={{ paddingTop: 6 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px', opacity: 0.75 }}>
            Known URLs
          </h3>

          {loadError && <p className="modal-error">{loadError}</p>}
          {!loadError && urls === null && (
            <div className="loading-center" style={{ minHeight: 80 }}><div className="spinner" /></div>
          )}
          {urls && urls.length === 0 && (
            <p className="settings-hint" style={{ margin: '0 0 12px' }}>
              No URLs recorded yet. Search for this title above and any chapters
              you download will register the URL here automatically.
            </p>
          )}

          {urls && urls.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {urls.map(row => (
                <li
                  key={row.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '8px 10px', border: '1px solid var(--border)',
                    borderRadius: 6, background: 'var(--bg)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                      {row.source}
                    </div>
                    {editingId === row.id ? (
                      <input
                        className="modal-search-input"
                        value={editingValue}
                        onChange={e => setEditingValue(e.target.value)}
                        autoFocus
                      />
                    ) : (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ wordBreak: 'break-all' }}
                      >{row.url}</a>
                    )}
                    {editingId === row.id && editError && (
                      <p className="modal-error" style={{ margin: '4px 0 0' }}>{editError}</p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {editingId === row.id ? (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => handleSaveEdit(row)}>Save</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setEditingId(null); setEditError(null); }}>Cancel</button>
                      </>
                    ) : pendingDelete === row.id ? (
                      <>
                        <button className="btn btn-ghost btn-sm" onClick={() => setPendingDelete(null)}>Cancel</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(row)}>Confirm delete</button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => { setEditingId(row.id); setEditingValue(row.url); setEditError(null); }}
                        >Edit</button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setPendingDelete(row.id)}
                        >Remove</button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={handleAdd} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 8 }}>
            <input
              className="modal-search-input"
              type="url"
              placeholder="https://mangadex.org/title/{uuid}"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={adding || !newUrl.trim()}
            >
              {adding ? 'Adding…' : 'Add URL'}
            </button>
          </form>
          {addError && <p className="modal-error" style={{ marginTop: 6 }}>{addError}</p>}
          <p className="settings-hint" style={{ marginTop: 6 }}>
            Recognised:{' '}
            <code>https://mangadex.org/title/&#123;uuid&#125;</code> ·{' '}
            <code>https://comix.to/title/&#123;hid&#125;</code> ·{' '}
            <code>https://www.mangakakalot.gg/manga/&#123;slug&#125;</code> ·{' '}
            <code>https://mangafire.to/manga/&#123;slug&#125;.&#123;hid&#125;</code> ·{' '}
            <code>https://weebcentral.com/series/&#123;ULID&#125;</code> ·{' '}
            <code>https://mangaball.net/title-detail/&#123;slug&#125;-&#123;ObjectId&#125;/</code> ·{' '}
            <code>https://mangataro.org/manga/&#123;slug&#125;</code> ·{' '}
            <code>https://mangadot.net/manga/&#123;id&#125;</code> ·{' '}
            <code>https://comikuro.to/manga/&#123;slug&#125;</code> ·{' '}
            <code>https://www.natomanga.com/manga/&#123;slug&#125;</code>.
          </p>

          <div style={{
            borderTop: '1px solid var(--border)',
            marginTop: 18,
            paddingTop: 14,
          }}>
            <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px', opacity: 0.75 }}>
              Auto-check schedule
            </h3>
            <p className="settings-hint" style={{ margin: '0 0 10px' }}>
              Picks up where the recorded URLs leave off — runs daily or weekly,
              detects which chapters this folder is missing (numbers parsed
              from your existing files), and downloads anything new.
            </p>
            <ScheduleEditor
              mangaId={manga.id}
              hasUrls={(urls || []).length > 0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function MangaDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [manga, setManga] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [coverBust, setCoverBust] = useState(0);
  const [showThumbPicker, setShowThumbPicker] = useState(false);

  // Metadata fetch state
  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [exportingMangaMeta, setExportingMangaMeta] = useState(false);
  const [metaMessage, setMetaMessage] = useState(null); // { type: 'success'|'error'|'notfound', text }
  const [showSearch, setShowSearch] = useState(false);
  const [showDoujinshiSearch, setShowDoujinshiSearch] = useState(false);
  const [showMALSearch, setShowMALSearch] = useState(false);
  const [showMangaUpdatesSearch, setShowMangaUpdatesSearch] = useState(false);
  const [metaSource, setMetaSource] = useState('anilist'); // 'anilist' | 'myanimelist' | 'mangaupdates' | 'doujinshi'
  const [savingTrackSetting, setSavingTrackSetting] = useState(false);

  // AniList reading status
  const [anilistStatus, setAnilistStatus] = useState(null); // null = loading

  // Reading lists
  const [readingLists, setReadingLists] = useState([]);
  const [mangaListIds, setMangaListIds] = useState(new Set());
  const [togglingList, setTogglingList] = useState(null);
  const [showListDropdown, setShowListDropdown] = useState(false);
  const [showMetaModal, setShowMetaModal] = useState(false);
  const [showSourceUrlsModal, setShowSourceUrlsModal] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [markingChapters, setMarkingChapters] = useState(new Set());
  const [showAllChapters, setShowAllChapters] = useState(false);
  // Description expand state — only meaningful on phones where the 5-line
  // clamp is too aggressive for typical AniList descriptions. Per-mount
  // (resets on back navigation). 280 chars ≈ 5 lines at 14px on a 360px
  // viewport; below that the toggle isn't rendered.
  const [descExpanded, setDescExpanded] = useState(false);
  // Chapter filter state — only rendered when chapters.length > 50.
  // Deferred so list re-renders don't block keystrokes.
  const [chapterFilter, setChapterFilter] = useState('');
  const deferredChapterFilter = useDeferredValue(chapterFilter);
  // Container ref for the chapter list. Jump-to-current queries the current
  // row inside this container at click time, which avoids a stale-ref race
  // when the active row changes (progress moves A → B) but A stays mounted,
  // or when the active row is filtered out and remounted later. Scoped to
  // the container so a stray .chapter-current outside this section can't
  // be hit by mistake.
  const chapterListRef = useRef(null);
  const gallerySectionRef = useRef(null);
  const [gallery, setGallery] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [removingGalleryIds, setRemovingGalleryIds] = useState(new Set());
  const listDropdownRef = useRef(null);
  const settingsDropdownRef = useRef(null);

  useEffect(() => {
    if (!showListDropdown) return;
    function onMouseDown(e) {
      if (listDropdownRef.current && !listDropdownRef.current.contains(e.target)) {
        setShowListDropdown(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showListDropdown]);

  useEffect(() => {
    if (!showSettingsDropdown) return;
    function onMouseDown(e) {
      if (settingsDropdownRef.current && !settingsDropdownRef.current.contains(e.target)) {
        setShowSettingsDropdown(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showSettingsDropdown]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Optimize
  const [showOptimize, setShowOptimize] = useState(false);
  // The modal's phase derives from the live task state below — 'confirm' until
  // the user clicks Start, then 'running' / 'done' / 'failed' from the hook.
  const optimizeTask = useAdminTask({
    startUrl:  `/api/manga/${id}/optimize`,
    statusUrl: `/api/manga/${id}/optimize/status`,
  });
  // When the per-manga optimize completes, pull the manga fresh so the
  // chapter list reflects the renames. Once per running→done transition.
  // IMPORTANT: this useRef + useEffect pair must sit above the
  // `if (loading)` / `if (error)` early returns further down — otherwise
  // hook order changes across renders and React unmounts the tree.
  const prevOptimizeDoneRef = useRef(false);
  useEffect(() => {
    if (optimizeTask.isDone && !prevOptimizeDoneRef.current) {
      api.getManga(id).then(updated => {
        setManga(prev => ({ ...prev, ...updated }));
      }).catch(() => {});
    }
    prevOptimizeDoneRef.current = optimizeTask.isDone;
  }, [optimizeTask.isDone, id]);

  // Refresh — single-folder rescan triggered from the navbar refresh button.
  // `refreshing` controls the spinner state on the icon; `refreshFlash`
  // shows a small inline status pill ("+3 chapters" / "no changes" / error)
  // for a couple of seconds after the rescan completes.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFlash, setRefreshFlash] = useState(null); // { ok: bool, text: string }

  // More Info
  const [showInfo, setShowInfo] = useState(false);
  const [infoData, setInfoData] = useState(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState(null);

  // Nav drawer (libraries + reading lists)
  const [showNavDrawer, setShowNavDrawer] = useState(false);
  const [navLibraries, setNavLibraries] = useState([]);
  const [navLists, setNavLists] = useState([]);
  const [navLoaded, setNavLoaded] = useState(false);

  useEffect(() => {
    setLoading(true);
    setAnilistStatus(null);
    Promise.all([
      api.getManga(id),
      api.getAnilistStatus(id),
      api.getReadingLists(),
      api.getMangaReadingLists(id),
    ]).then(([mangaData, statusData, listsData, listIds]) => {
      setManga(mangaData);
      setAnilistStatus(statusData);
      setReadingLists(listsData);
      setMangaListIds(new Set(listIds));
      setLoading(false);
    }).catch(err => { setError(err.message); setLoading(false); });
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setGalleryLoading(true);
    api.getGallery(id).then(items => {
      if (cancelled) return;
      setGallery(items);
      setGalleryLoading(false);
    }).catch(() => { if (!cancelled) setGalleryLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Keep a ref of `showInfo` so the scan-status poller below can read the
  // latest value without re-subscribing every time the modal toggles.
  const showInfoRef = useRef(false);
  useEffect(() => { showInfoRef.current = showInfo; }, [showInfo]);

  // Watch for library scans (started elsewhere, e.g. Settings → Libraries) and
  // refresh the More Info stats when one completes. Polls scan status while
  // the page is mounted. On a running → idle transition we re-fetch the manga
  // and the info payload so file count / folder size reflect the scan result.
  const prevScanRunningRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    async function tick() {
      if (cancelled) return;
      try {
        const status = await api.getScanStatus();
        const wasRunning = prevScanRunningRef.current;
        const isRunning = !!status?.running;
        prevScanRunningRef.current = isRunning;
        if (wasRunning && !isRunning && !cancelled) {
          try {
            const fresh = await api.getManga(id);
            if (cancelled) return;
            setManga(fresh);
          } catch { /* keep prior manga */ }
          if (cancelled) return;
          setInfoData(null);
          setInfoError(null);
          if (showInfoRef.current) {
            setInfoLoading(true);
            try {
              const data = await api.getMangaInfo(id);
              if (!cancelled) setInfoData(data);
            } catch (err) {
              if (!cancelled) setInfoError(err.message);
            } finally {
              if (!cancelled) setInfoLoading(false);
            }
          }
        }
      } catch { /* network/auth blip — try again next tick */ }
      if (!cancelled) {
        // Faster polling while a scan is in flight so the post-scan refresh
        // lands quickly; slower otherwise to keep the page idle-cheap.
        const delay = prevScanRunningRef.current ? 2000 : 5000;
        timer = setTimeout(tick, delay);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshFlash(null);
    try {
      const result = await api.scanManga(id);
      // Re-fetch the manga so the chapter list re-renders with anything
      // the scan added/removed. Single round-trip — much cheaper than the
      // full library reload that would happen if the user manually scanned.
      const fresh = await api.getManga(id);
      setManga(fresh);
      // Invalidate the More Info cache so the next open (or the currently
      // open modal) reflects the post-rescan file count and folder size.
      setInfoData(null);
      setInfoError(null);
      if (showInfo) {
        setInfoLoading(true);
        try {
          const data = await api.getMangaInfo(id);
          setInfoData(data);
        } catch (err) {
          setInfoError(err.message);
        } finally {
          setInfoLoading(false);
        }
      }
      const added = result?.added | 0;
      const removed = result?.removed | 0;
      let text;
      if (added && removed)       text = `+${added} new, -${removed} removed`;
      else if (added)             text = `+${added} new chapter${added === 1 ? '' : 's'}`;
      else if (removed)           text = `-${removed} removed`;
      else                        text = 'No changes';
      setRefreshFlash({ ok: true, text });
    } catch (err) {
      setRefreshFlash({ ok: false, text: 'Refresh failed: ' + err.message });
    } finally {
      setRefreshing(false);
      // Auto-clear the flash after a few seconds so it doesn't stick.
      setTimeout(() => setRefreshFlash(null), 4000);
    }
  }

  async function handleRemoveFromGallery(itemId) {
    if (removingGalleryIds.has(itemId)) return;
    setRemovingGalleryIds(s => new Set([...s, itemId]));
    try {
      await api.removeFromGallery(id, itemId);
      setGallery(prev => prev.filter(item => item.id !== itemId));
    } catch {
      // Leave the item in place; user can retry
    } finally {
      setRemovingGalleryIds(s => { const n = new Set(s); n.delete(itemId); return n; });
    }
  }

  // Art Gallery items reference a chapter via `chapter_*` prefixed fields
  // (different shape from a raw chapter object). Renamed away from the
  // generic `formatChapterLabel` so it can't shadow the module-level
  // helper of the same name used by chapter rows and the resume
  // subtitle — that shadow was the cause of "Vol. undefined Ch.
  // undefined" labels on the chapter list in 1.12.1.
  function formatGalleryItemLabel(item) {
    const vol = item.chapter_volume;
    const num = item.chapter_number;
    if (vol != null && num != null) return `Vol. ${vol} Ch. ${num}`;
    if (vol != null)                return `Volume ${vol}`;
    if (num != null)                return (manga?.track_volumes ? `Volume ${num}` : `Chapter ${num}`);
    return item.chapter_folder_name || '';
  }

  async function handleToggleList(listId) {
    if (togglingList === listId) return;
    setTogglingList(listId);
    try {
      if (mangaListIds.has(listId)) {
        await api.removeFromReadingList(listId, manga.id);
        setMangaListIds(prev => { const s = new Set(prev); s.delete(listId); return s; });
      } else {
        await api.addToReadingList(listId, manga.id);
        setMangaListIds(prev => new Set([...prev, listId]));
      }
    } catch (err) {
      appAlert('Failed to update reading list: ' + err.message);
    } finally {
      setTogglingList(null);
    }
  }

  async function handleResetProgress() {
    if (!(await appConfirm('Reset all reading progress for this manga?', { danger: true, okLabel: 'Reset' }))) return;
    try {
      await api.resetProgress(id);
      clearResume(id);
      const data = await api.getManga(id);
      setManga(data);
    } catch (err) {
      appAlert('Failed to reset progress: ' + err.message);
    }
  }

  async function handleToggleTrackVolumes() {
    if (savingTrackSetting) return;
    const newVal = !manga.track_volumes;
    setSavingTrackSetting(true);
    try {
      await api.updateManga(id, { track_volumes: newVal });
      setManga(prev => ({ ...prev, track_volumes: newVal ? 1 : 0 }));
    } catch (err) {
      appAlert('Failed to save setting: ' + err.message);
    } finally {
      setSavingTrackSetting(false);
    }
  }

  async function handleFetchMetadata() {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.refreshMetadata(id);
      if (result.found) {
        setManga(prev => ({ ...prev, ...result.data, chapters: prev.chapters, progress: prev.progress }));
        setCoverBust(Date.now());
        setMetaMessage({ type: 'success', text: 'Metadata fetched from AniList.' });
      } else {
        setMetaMessage({ type: 'notfound', text: result.message || 'No match found on AniList.' });
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  async function handleFetchDoujinshiMetadata() {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.refreshDoujinshiMetadata(id);
      if (result.found) {
        setManga(prev => ({ ...prev, ...result.data, chapters: prev.chapters, progress: prev.progress }));
        setCoverBust(Date.now());
        setMetaMessage({ type: 'success', text: 'Metadata fetched from Doujinshi.info.' });
      } else {
        setMetaMessage({ type: 'notfound', text: result.message || 'No match found on Doujinshi.info.' });
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  function handleMetadataApplied(updated) {
    setManga(prev => ({ ...prev, ...updated, chapters: prev.chapters, progress: prev.progress }));
    setCoverBust(Date.now());
    setShowSearch(false);
    setShowDoujinshiSearch(false);
    setShowMetaModal(true);
    setMetaMessage({ type: 'success', text: 'Metadata applied from AniList.' });
  }

  function handleDoujinshiMetadataApplied(updated) {
    setManga(prev => ({ ...prev, ...updated, chapters: prev.chapters, progress: prev.progress }));
    setCoverBust(Date.now());
    setShowDoujinshiSearch(false);
    setShowMetaModal(true);
    setMetaMessage({ type: 'success', text: 'Metadata applied from Doujinshi.info.' });
  }

  async function handleResetMetadata(source) {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.resetMetadata(id, source);
      setManga(prev => ({ ...prev, ...result, chapters: prev.chapters, progress: prev.progress }));
      setMetaMessage({ type: 'success', text: 'Metadata linkage removed.' });
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  async function handleBreakAnilistLinkage() {
    if (!(await appConfirm('Remove the AniList link for this manga?', { okLabel: 'Remove' }))) return;
    try {
      const result = await api.resetMetadata(id, 'anilist');
      setManga(prev => ({ ...prev, ...result, chapters: prev.chapters, progress: prev.progress }));
      setCoverBust(Date.now());
      // AniList panel state reflects the new unlinked status
      setAnilistStatus(prev => prev?.logged_in
        ? { logged_in: true, linked: false }
        : prev);
    } catch (err) {
      appAlert('Failed to remove AniList linkage: ' + err.message);
    }
  }

  async function handleFetchMalMetadata() {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.refreshMalMetadata(id);
      if (result.found) {
        setManga(prev => ({ ...prev, ...result.data, chapters: prev.chapters, progress: prev.progress }));
        setCoverBust(Date.now());
        setMetaMessage({ type: 'success', text: 'Metadata fetched from MyAnimeList.' });
      } else {
        setMetaMessage({ type: 'notfound', text: result.message || 'No match found on MyAnimeList.' });
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  function handleMalMetadataApplied(updated) {
    setManga(prev => ({ ...prev, ...updated, chapters: prev.chapters, progress: prev.progress }));
    setCoverBust(Date.now());
    setShowMALSearch(false);
    setShowMetaModal(true);
    setMetaMessage({ type: 'success', text: 'Metadata applied from MyAnimeList.' });
  }

  function handleMangaUpdatesMetadataApplied(updated) {
    setManga(prev => ({ ...prev, ...updated, chapters: prev.chapters, progress: prev.progress }));
    setCoverBust(Date.now());
    setShowMangaUpdatesSearch(false);
    setShowMetaModal(true);
    setMetaMessage({ type: 'success', text: 'Metadata applied from MangaUpdates.' });
  }

  async function handleFetchMangaUpdatesMetadata() {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.refreshMangaUpdatesMetadata(id);
      if (!result.found) {
        setMetaMessage({ type: 'notfound', text: result.message || 'No match found on MangaUpdates.' });
      } else {
        setManga(prev => ({ ...prev, ...result.data, chapters: prev.chapters, progress: prev.progress }));
        setCoverBust(Date.now());
        setMetaMessage({ type: 'success', text: 'Metadata refreshed from MangaUpdates.' });
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  async function handleExportMangaMetadata(source) {
    setExportingMangaMeta(true);
    setMetaMessage(null);
    try {
      await api.exportMangaMetadata(id, source);
      const friendly = source === 'anilist'
        ? 'AniList'
        : source === 'myanimelist'
          ? 'MyAnimeList'
          : source === 'doujinshi'
            ? 'Doujinshi.info'
            : null;
      setMetaMessage({
        type: 'success',
        text: friendly
          ? `Exported ${friendly} metadata — metadata.json saved to the manga's folder (any existing file was overwritten).`
          : 'Metadata exported — metadata.json saved to the manga\'s folder (any existing file was overwritten).',
      });
      // Refresh the page state so any field that the export's upstream fetch
      // surfaced (or any out-of-band change since this page mounted) is
      // reflected immediately. Cover gets a cache-bust too so a freshly-saved
      // source-specific cover (e.g. mal_cover) is reloaded by the picker.
      try {
        const data = await api.getManga(id);
        setManga(data);
        setCoverBust(Date.now());
      } catch (refreshErr) {
        console.warn('[Export] Refresh after export failed:', refreshErr);
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Export failed: ' + err.message });
    } finally {
      setExportingMangaMeta(false);
    }
  }

  if (loading) return (
    <div className="detail-page">
      <nav className="navbar">
        <button className="detail-nav-hamburger" onClick={openNavDrawer} aria-label="Browse libraries">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/library" className="btn btn-ghost">← Back</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
        <div className="navbar-spacer" />
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">⚙</button>
      </nav>
      <div className="loading-center"><div className="spinner" /></div>
    </div>
  );

  if (error) return (
    <div className="detail-page">
      <nav className="navbar">
        <button className="detail-nav-hamburger" onClick={openNavDrawer} aria-label="Browse libraries">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/library" className="btn btn-ghost">← Back</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
        <div className="navbar-spacer" />
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">⚙</button>
      </nav>
      <div className="error-message"><h2>Error</h2><p>{error}</p></div>
    </div>
  );

  const { chapters = [], progress } = manga;
  const completedIds = new Set(progress?.completed_chapters || []);
  // Reading order (ascending) — used for the "start at first chapter" fallback
  const readingOrderChapters = [...chapters].sort((a, b) => {
    // Use volume as primary sort key for volume-only entries, chapter number otherwise
    const aKey = a.number ?? a.volume;
    const bKey = b.number ?? b.volume;
    if (aKey === null && bKey === null) return a.folder_name.localeCompare(b.folder_name);
    if (aKey === null) return 1;
    if (bKey === null) return -1;
    return aKey - bKey;
  });
  // Display order (descending) — highest chapter/volume on top
  const displayChapters = [...readingOrderChapters].reverse();

  // Active filter (deferred so keystrokes don't block). When a filter is
  // typed, we apply it to the FULL chapter list — not the truncated 5-row
  // preview — and skip the truncation entirely so matches outside the
  // preview window still show. The Show-more button is hidden whenever
  // a filter is active.
  //
  // Plain consts (not useMemo) on purpose: this whole block lives AFTER
  // the `if (loading) return …` early returns at the top of the
  // component, so any hook here would be conditionally called between
  // renders — Rules of Hooks violation that crashes the component to a
  // blank page on first paint. The filter is O(n) on ≤500 string ops,
  // cheap enough to run every render.
  const filterActive = deferredChapterFilter.trim().length > 0;
  const filteredChapters = (() => {
    if (!filterActive) return displayChapters;
    const q = deferredChapterFilter.trim().toLowerCase();
    return displayChapters.filter(ch => {
      // Match on number, volume, title, or folder_name — the same fields
      // formatChapterLabel inspects, plus the title for free-form names.
      const num    = ch.number != null ? String(ch.number) : '';
      const vol    = ch.volume != null ? String(ch.volume) : '';
      const title  = (ch.title || '').toLowerCase();
      const folder = (ch.folder_name || '').toLowerCase();
      return num.includes(q) || vol.includes(q) || title.includes(q) || folder.includes(q);
    });
  })();

  const visibleChapters = (filterActive || showAllChapters)
    ? filteredChapters
    : filteredChapters.slice(0, CHAPTERS_COLLAPSED_COUNT);
  // Hide Show-more during a filter — every match should be visible.
  const hasMoreChapters = !filterActive && displayChapters.length > CHAPTERS_COLLAPSED_COUNT;

  // Current chapter for the resume subtitle. Plain .find for the same
  // Rules-of-Hooks reason as above; the call is also gated by progress
  // existing at all so it's a no-op for fresh manga.
  const currentChapter = progress?.current_chapter_id
    ? chapters.find(c => c.id === progress.current_chapter_id) || null
    : null;
  // Reading-progress percentage for the visualisation bar. Same formula
  // Home's resume-hero card uses, so the two surfaces never disagree.
  const readPct = chapters.length > 0
    ? Math.min(100, Math.round((completedIds.size / chapters.length) * 100))
    : 0;

  function continueReading() {
    // Prefer this device's saved resume position (per-device, intra-chapter)
    // over the server-side last-read pointer so a partial read on this device
    // takes the user back to the exact page they left off on.
    const resume = getResume(id);
    if (resume && chapters.some(c => c.id === resume.chapterId)) {
      navigate(`/read/${resume.chapterId}?page=${resume.page}&mangaId=${id}`);
      return;
    }
    if (progress?.current_chapter_id) {
      navigate(`/read/${progress.current_chapter_id}?page=${progress.current_page}&mangaId=${id}`);
    } else if (readingOrderChapters.length > 0) {
      navigate(`/read/${readingOrderChapters[0].id}?page=0&mangaId=${id}`);
    }
  }

  async function handleMarkChapter(chapterId, completed) {
    if (markingChapters.has(chapterId)) return;
    const prevProgress = manga.progress;
    setMarkingChapters(s => new Set([...s, chapterId]));
    // Optimistic update so the UI responds instantly
    setManga(prev => {
      const prevCompleted = prev.progress?.completed_chapters || [];
      const newCompleted = completed
        ? Array.from(new Set([...prevCompleted, chapterId]))
        : prevCompleted.filter(cid => cid !== chapterId);
      return { ...prev, progress: { ...(prev.progress || {}), completed_chapters: newCompleted } };
    });
    try {
      const result = await api.markChapterRead(id, chapterId, completed);
      setManga(prev => ({ ...prev, progress: result }));
    } catch {
      setManga(prev => ({ ...prev, progress: prevProgress }));
    } finally {
      setMarkingChapters(s => { const n = new Set(s); n.delete(chapterId); return n; });
    }
  }

  // Prefer the server-baked `cover_url` (already a usable URL — and the
  // offline shim sets it to a local file:// URL via convertFileSrc) over
  // re-deriving from the filename. Falls back to the legacy
  // `thumbnailUrl(cover_image)` path for any response that doesn't include
  // cover_url yet.
  const coverBase = manga.cover_url || (manga.cover_image ? api.thumbnailUrl(manga.cover_image) : null);
  const coverUrl = coverBase ? `${coverBase}${coverBust ? (coverBase.includes('?') ? '&' : '?') + `t=${coverBust}` : ''}` : null;
  const genres = Array.isArray(manga.genres) ? manga.genres : [];
  const hasMetadata = manga.metadata_source && manga.metadata_source !== 'none';

  async function handleOptimize() {
    try { await optimizeTask.start(); }
    catch (_) { /* surfaced via optimizeTask.lastError */ }
  }

  async function openOptimizeModal() {
    // Admin-gated action — pop the password prompt if the caller doesn't
    // already hold an admin token. On cancel we just return without
    // opening the modal.
    if (!(await ensureAdminAccess())) return;
    // Clear any badge from a previous completion so the modal opens in
    // the 'confirm' phase. No-op while a task is currently running, in
    // which case the modal adopts the live 'running' state instead.
    optimizeTask.reset();
    setShowOptimize(true);
  }

  // Admin-gated companions for the two other restricted entry points on
  // this page. Wrapping at the handler keeps every call site (navbar
  // icon, mobile settings dropdown, …) behind the same gate.
  async function openSourceUrlsModal() {
    if (!(await ensureAdminAccess())) return;
    setShowSourceUrlsModal(true);
  }
  async function openEditPage() {
    if (!(await ensureAdminAccess())) return;
    navigate(`/manga/${manga.id}/edit`);
  }
  async function openDeletePrompt() {
    if (!(await ensureAdminAccess())) return;
    setShowDeleteConfirm(true);
  }

  function closeOptimizeModal() {
    if (optimizeTask.isRunning) return; // can't close mid-run
    setShowOptimize(false);
  }

  // Drive the modal phase off the live task state. `confirm` is the
  // initial-mount default and what the modal returns to after reset().
  const optimizePhase = optimizeTask.isRunning ? 'running'
                      : optimizeTask.isDone    ? 'done'
                      : optimizeTask.isFailed  ? 'failed'
                      : optimizeTask.lastError ? 'failed'
                      : 'confirm';
  const optimizeResult = optimizeTask.result;
  const optimizeError  = optimizeTask.error || optimizeTask.lastError;

  async function openNavDrawer() {
    setShowNavDrawer(true);
    if (navLoaded) return;
    try {
      const libs = await api.getLibraries();
      setNavLibraries(libs);
      setNavLists(readingLists);
      setNavLoaded(true);
    } catch { /* silently ignore — drawer still opens */ }
  }

  function goToLibrary(libraryId) {
    setShowNavDrawer(false);
    navigate('/library', { state: { library: libraryId } });
  }

  function goToList(listId) {
    setShowNavDrawer(false);
    navigate('/library', { state: { list: listId } });
  }

  async function handleOpenInfo() {
    setShowInfo(true);
    if (infoData) return; // already fetched
    setInfoLoading(true);
    setInfoError(null);
    try {
      const data = await api.getMangaInfo(id);
      setInfoData(data);
    } catch (err) {
      setInfoError(err.message);
    } finally {
      setInfoLoading(false);
    }
  }

  async function handleDeleteConfirmed() {
    setDeleting(true);
    try {
      await api.deleteManga(manga.id);
      navigate('/');
    } catch (err) {
      setDeleting(false);
      setShowDeleteConfirm(false);
      appAlert('Delete failed: ' + err.message);
    }
  }

  return (
    <div className="detail-page">
      <nav className="navbar">
        <button className="detail-nav-hamburger" onClick={openNavDrawer} aria-label="Browse libraries">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/library" className="btn btn-ghost detail-desktop-only">← Library</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
        <div className="navbar-spacer" />
        {refreshFlash && (
          <span
            className={`detail-refresh-flash${refreshFlash.ok ? '' : ' is-error'}`}
            role="status"
          >{refreshFlash.text}</span>
        )}
        <button
          className={`detail-refresh-btn${refreshing ? ' is-spinning' : ''}`}
          onClick={handleRefresh}
          disabled={refreshing}
          title="Re-scan this manga's folder for new chapters"
          aria-label="Refresh chapters"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 2 17 7 12 7" />
            <polyline points="3 18 3 13 8 13" />
            <path d="M16.5 8a7 7 0 0 0-12.5 2.5M3.5 12a7 7 0 0 0 12.5-2.5" />
          </svg>
        </button>
        <button
          className="detail-optimize-btn detail-desktop-only"
          onClick={openOptimizeModal}
          title="Optimize chapters"
          aria-label="Optimize chapters"
        >
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.381z" clipRule="evenodd" />
          </svg>
        </button>
        <button
          className="detail-source-btn detail-desktop-only"
          onClick={openSourceUrlsModal}
          title="Search third-party sources"
          aria-label="Search third-party sources"
        >
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.5 4a4.5 4.5 0 014.473 4.072A3.5 3.5 0 0114.5 14H5.5a4.5 4.5 0 010-9zm5.146 5.354a.5.5 0 01.708 0l1.5 1.5a.5.5 0 01-.708.708L11.5 10.707V13.5a.5.5 0 01-1 0v-2.793l-.646.647a.5.5 0 11-.708-.708l1.5-1.5z" clipRule="evenodd" />
          </svg>
        </button>
        <button
          className="detail-edit-btn detail-desktop-only"
          onClick={openEditPage}
          title="Edit manga"
          aria-label="Edit manga"
        >
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" />
            <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
          </svg>
        </button>
        <button
          className="detail-delete-btn detail-desktop-only"
          onClick={openDeletePrompt}
          title="Delete manga"
          aria-label="Delete manga"
        >
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </button>
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">⚙</button>
      </nav>

      <main className="detail-main">
        <div className="detail-hero">
          <div className="detail-cover detail-cover-clickable" onClick={() => setShowThumbPicker(true)}>
            {coverUrl
              ? <img src={coverUrl} alt={manga.title} />
              : <div className="detail-cover-placeholder">📖</div>
            }
            {/* Hover overlay (desktop) and corner badge (touch) are mutually
                exclusive — see CSS. Together they cover both pointer modes
                without users having to discover the cover is tappable. */}
            <div className="detail-cover-change-hint">Change</div>
            <span className="detail-cover-edit-badge" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" />
                <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
              </svg>
            </span>
          </div>

          <div className="detail-info">
            <h1 className="detail-title">{manga.title}</h1>

            {manga.author && (
              <p className="detail-author">{manga.author}</p>
            )}

            <div className="detail-meta">
              {manga.status && <span className={`detail-status status-${manga.status.toLowerCase()}`}>{manga.status}</span>}
              {manga.year && <span className="detail-year">{manga.year}</span>}
              {manga.score && <span className="detail-score">★ {manga.score.toFixed(1)}</span>}
              {hasMetadata && (
                <span className="detail-source">
                  {manga.metadata_source === 'local'
                    ? 'Local'
                    : manga.anilist_id
                      ? <a href={`https://anilist.co/manga/${manga.anilist_id}`} target="_blank" rel="noreferrer">AniList</a>
                      : 'AniList'
                  }
                </span>
              )}
            </div>

            {genres.length > 0 && (
              <div className="detail-genres">
                {/* Each genre links to Library with the genre pre-filled as
                    a search term. Library reads `location.state.search`
                    and binds it to its search input. Tapping a genre is the
                    primary "find more like this" path on mobile. */}
                {genres.map(g => (
                  <Link
                    key={g}
                    to="/library"
                    state={{ search: g }}
                    className="genre-tag"
                  >{g}</Link>
                ))}
              </div>
            )}

            {manga.description && (
              // Wrap so the toggle can be a sibling of the clamped <p>.
              // `is-expanded` removes the 5-line clamp and the bottom mask.
              // `hasLongDesc` heuristic: 280 chars ≈ 5 lines at 14px on a
              // 360px viewport. Below that, the toggle is not rendered.
              <div className={`detail-description-wrap${descExpanded ? ' is-expanded' : ''}`}>
                <p className="detail-description">{manga.description}</p>
                {manga.description.length > 280 && (
                  <button
                    className="detail-description-toggle detail-mobile-only"
                    onClick={() => setDescExpanded(v => !v)}
                  >
                    {descExpanded ? 'Show less' : 'Show more'}
                  </button>
                )}
              </div>
            )}

            <div className="detail-stats">
              <span>{chapters.length} {manga.track_volumes ? `volume${chapters.length !== 1 ? 's' : ''}` : `chapter${chapters.length !== 1 ? 's' : ''}`}</span>
              {progress && <span>{completedIds.size} {manga.track_volumes ? (completedIds.size !== 1 ? 'volumes' : 'volume') : (completedIds.size !== 1 ? 'chapters' : 'chapter')} read</span>}
              {/* Tiny inline teaser that the gallery section exists below;
                  cheap discoverability without reordering content. */}
              {gallery.length > 0 && (
                <button
                  type="button"
                  className="detail-gallery-teaser"
                  onClick={() => gallerySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >🎨 {gallery.length} saved {gallery.length === 1 ? 'page' : 'pages'} →</button>
              )}
            </div>

            {chapters.length > 0 && (
              // Reading-progress visualisation. Same shape and tokens as
              // Home's hero progress bar so the two surfaces feel like
              // one design. Hidden when there are no chapters to avoid
              // a 0% rail that's just visual noise.
              <div className="detail-progress-bar" aria-label={`${readPct}% read`} role="progressbar" aria-valuenow={readPct} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${readPct}%` }} />
              </div>
            )}

            <div className="detail-actions">
              {chapters.length > 0 && (
                <button
                  className="btn btn-primary detail-action-btn"
                  onClick={continueReading}
                  aria-label={progress?.current_chapter_id ? 'Continue Reading' : 'Start Reading'}
                  title={progress?.current_chapter_id ? 'Continue Reading' : 'Start Reading'}
                >
                  <svg className="detail-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 3l5 5-5 5M9 3l5 5-5 5"/>
                  </svg>
                  <span className="detail-action-label">
                    {progress?.current_chapter_id ? 'Continue Reading' : 'Start Reading'}
                  </span>
                  {/* Resume context — phone-only. Tells the user what they're
                      about to resume into so they don't second-guess the tap.
                      `currentChapter` is null until chapters load; until then
                      the subtitle is omitted instead of showing a stale "—". */}
                  {progress?.current_chapter_id && currentChapter && (
                    <span className="detail-resume-sub detail-mobile-only">
                      {formatChapterLabel(currentChapter, manga.track_volumes)}
                      {currentChapter.page_count > 0 && (
                        <> · page {(progress.current_page || 0) + 1}/{currentChapter.page_count}</>
                      )}
                    </span>
                  )}
                </button>
              )}
              {/* Secondary group — wrapped in its own container so the mobile
                  grid's auto-fit can collapse empty tracks cleanly. On
                  desktop the wrapper uses `display: contents` so all
                  children flow into the parent flex-row as before
                  (no layout change). On phones the wrapper becomes its
                  own grid container, sized to the actual secondary count
                  (3, 4, or 5 items) — no empty cells regardless of which
                  conditionals fire. */}
              <div className="detail-actions-secondary">
              {progress && (
                <button
                  className="btn btn-ghost detail-action-btn"
                  onClick={handleResetProgress}
                  aria-label="Reset Progress"
                  title="Reset Progress"
                >
                  <svg className="detail-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 8a6 6 0 1 1-1.76-4.24"/>
                    <polyline points="14 2 14 6 10 6"/>
                  </svg>
                  <span className="detail-action-label">Reset Progress</span>
                </button>
              )}
              <SeriesDownloadButton
                mangaId={id}
                chapters={chapters}
                serverUpdatedAt={manga.updated_at}
              />

              {/* Desktop: individual buttons. Optimize and Third Party
                  Sources live in the navbar icon row, so they're not
                  duplicated here. */}
              <button className="btn btn-ghost detail-desktop-only" onClick={() => setShowMetaModal(true)}>
                Metadata
              </button>
              <button className="btn btn-ghost detail-desktop-only" onClick={handleOpenInfo}>
                More Info
              </button>
              {/* Mobile: consolidated Settings dropdown */}
              <div className="detail-settings-wrap detail-mobile-only" ref={settingsDropdownRef}>
                <button
                  className={`btn btn-ghost detail-action-btn detail-settings-trigger${showSettingsDropdown ? ' open' : ''}`}
                  onClick={() => setShowSettingsDropdown(v => !v)}
                  aria-label="Settings"
                  title="Settings"
                >
                  <svg className="detail-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                  <span className="detail-action-label">Settings</span>
                  <svg className="detail-settings-chevron" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 1l4 4 4-4"/>
                  </svg>
                </button>
                {showSettingsDropdown && (
                  <div className="detail-settings-dropdown">
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); setShowMetaModal(true); }}>
                      Metadata
                    </button>
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); openOptimizeModal(); }}>
                      Optimize
                    </button>
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); openSourceUrlsModal(); }}>
                      Third Party Sources
                    </button>
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); openEditPage(); }}>
                      Edit
                    </button>
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); handleOpenInfo(); }}>
                      More Info
                    </button>
                    {/* Divider + destructive action separated from the rest so an
                        accidental tap on Delete reads as deliberate. The
                        confirmation modal still gates the actual deletion. */}
                    <div className="detail-settings-divider" />
                    <button
                      className="detail-settings-item detail-settings-item-danger"
                      onClick={() => { setShowSettingsDropdown(false); openDeletePrompt(); }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {readingLists.length > 0 && (
                <div className="rl-dropdown-wrap" ref={listDropdownRef}>
                  <button
                    className={`btn btn-ghost detail-action-btn rl-dropdown-trigger${showListDropdown ? ' open' : ''}`}
                    onClick={() => setShowListDropdown(v => !v)}
                    aria-label={`Reading Lists${mangaListIds.size > 0 ? ` (${mangaListIds.size})` : ''}`}
                    title="Reading Lists"
                  >
                    <svg className="detail-action-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                      <line x1="3" y1="4" x2="13" y2="4"/>
                      <line x1="3" y1="8" x2="13" y2="8"/>
                      <line x1="3" y1="12" x2="13" y2="12"/>
                    </svg>
                    <span className="detail-action-label">Lists</span>
                    {mangaListIds.size > 0 && <span className="detail-action-count">· {mangaListIds.size}</span>}
                    <svg className="rl-chevron" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M1 1l4 4 4-4"/>
                    </svg>
                  </button>
                  {showListDropdown && (
                    <div className="rl-dropdown">
                      {readingLists.map(list => {
                        const checked = mangaListIds.has(list.id);
                        return (
                          <button
                            key={list.id}
                            className={`rl-dropdown-item${checked ? ' checked' : ''}`}
                            onClick={() => handleToggleList(list.id)}
                            disabled={togglingList === list.id}
                          >
                            <span className="rl-dropdown-box">
                              {checked && (
                                <svg viewBox="0 0 10 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 4l3 3 5-6"/>
                                </svg>
                              )}
                            </span>
                            {list.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              </div>{/* /.detail-actions-secondary */}
            </div>
          </div>
        </div>

        {/* AniList reading status */}
        <AnilistStatusPanel
          status={anilistStatus}
          mangaId={id}
          onEntryChange={entry => setAnilistStatus(prev => ({ ...prev, entry }))}
          onBreakLinkage={manga.anilist_id ? handleBreakAnilistLinkage : null}
        />

        {/* Tracking settings */}
        <div className="tracking-panel">
          <div className="tracking-panel-row">
            <div className="tracking-panel-info">
              <span className="tracking-panel-label">
                Track as Volumes
                {/* Phone-only — collapse the long description behind a tiny
                    "?" so the toggle row stays one line tall. Native
                    <details> means no extra component, no a11y wiring. */}
                <details className="tracking-help-mobile">
                  <summary aria-label="What does this do?">?</summary>
                  <p>
                    Reports volume progress to AniList instead of chapter progress.
                    Use this when your folders represent volumes rather than individual chapters.
                  </p>
                </details>
              </span>
              <span className="tracking-panel-desc">
                Reports volume progress to AniList instead of chapter progress.
                Use this when your folders represent volumes rather than individual chapters.
              </span>
            </div>
            <button
              className={`track-toggle ${manga.track_volumes ? 'on' : ''}`}
              onClick={handleToggleTrackVolumes}
              disabled={savingTrackSetting}
              role="switch"
              aria-checked={!!manga.track_volumes}
            >
              <span className="track-toggle-thumb" />
            </button>
          </div>
        </div>

        {/* Chapters */}
        <div className="chapter-section">
          <div className="chapter-section-head">
            <h2 className="chapter-section-title">{manga.track_volumes ? 'Volumes' : 'Chapters'}</h2>
            {/* Jump-to-current — surfaces only when the list is long enough
                that scrolling to the current row is friction. Smooth scroll
                centres the row in the page-level scroll container. */}
            {progress?.current_chapter_id && displayChapters.length > CHAPTER_JUMP_THRESHOLD && (
              <button
                type="button"
                className="chapter-jump-btn"
                onClick={() => {
                  // Query at click time, not via per-row refs. The chapter-
                  // list is keyed on the current chapter id (via the
                  // `chapter-current` class), so this stays correct as
                  // progress moves and as the filter mounts/unmounts rows.
                  const el = chapterListRef.current?.querySelector('.chapter-current');
                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              >Jump to current</button>
            )}
          </div>
          {displayChapters.length > CHAPTER_FILTER_THRESHOLD && (
            <input
              type="search"
              className="chapter-filter-input"
              placeholder={`Filter ${displayChapters.length} ${manga.track_volumes ? 'volumes' : 'chapters'}…`}
              value={chapterFilter}
              onChange={e => setChapterFilter(e.target.value)}
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
          {displayChapters.length === 0 ? (
            <p className="chapter-empty">No {manga.track_volumes ? 'volumes' : 'chapters'} found. Make sure your manga folders contain images or CBZ files.</p>
          ) : filterActive && filteredChapters.length === 0 ? (
            <p className="chapter-empty">No {manga.track_volumes ? 'volumes' : 'chapters'} match "{deferredChapterFilter.trim()}".</p>
          ) : (
            <div className="chapter-list" ref={chapterListRef}>
              {visibleChapters.map(ch => {
                const isRead = completedIds.has(ch.id);
                const isCurrent = progress?.current_chapter_id === ch.id;
                const isMarking = markingChapters.has(ch.id);
                return (
                  <Link
                    key={ch.id}
                    to={`/read/${ch.id}?mangaId=${id}`}
                    className={`chapter-row ${isRead ? 'chapter-read' : ''} ${isCurrent ? 'chapter-current' : ''}`}
                  >
                    <div className="chapter-row-left">
                      <span className="chapter-num">
                        {formatChapterLabel(ch, manga.track_volumes)}
                      </span>
                      {ch.title && <span className="chapter-title">{ch.title}</span>}
                    </div>
                    <div className="chapter-row-right">
                      {isCurrent && <span className="chapter-badge badge-current">Reading</span>}
                      {isRead && !isCurrent && <span className="chapter-badge badge-read">Read</span>}
                      <span className="chapter-pages">{ch.page_count}p</span>
                      <ChapterDownloadButton mangaId={id} chapterId={ch.id} />
                      <button
                        className={`chapter-mark-btn${isRead ? ' is-read' : ''}`}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); handleMarkChapter(ch.id, !isRead); }}
                        disabled={isMarking}
                        title={isRead ? 'Mark as unread' : 'Mark as read'}
                        aria-label={isRead ? 'Mark as unread' : 'Mark as read'}
                      >
                        {isMarking ? (
                          <div className="spinner" style={{ width: 14, height: 14, borderWidth: 1.5 }} />
                        ) : isRead ? (
                          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                            <circle cx="10" cy="10" r="8" fill="currentColor" />
                            <path d="M6.5 10l2.5 2.5 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true">
                            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
          {hasMoreChapters && (
            <button
              className="chapter-expand-btn"
              onClick={() => setShowAllChapters(v => !v)}
            >
              {showAllChapters
                ? 'Show less'
                : `Show all ${displayChapters.length} ${manga.track_volumes ? 'volumes' : 'chapters'}`}
            </button>
          )}
        </div>

        {/* Art Gallery */}
        <div className="gallery-section" ref={gallerySectionRef}>
          <h2 className="chapter-section-title">Art Gallery</h2>
          {galleryLoading ? (
            <p className="chapter-empty">Loading gallery…</p>
          ) : gallery.length === 0 ? (
            <p className="chapter-empty">
              No pages saved yet. Open a chapter, find a page you like, and use the
              “Add to Art Gallery” button in the reader’s settings panel.
            </p>
          ) : (
            <div className="gallery-grid">
              {gallery.map(item => {
                const isRemoving = removingGalleryIds.has(item.id);
                return (
                  <div key={item.id} className={`gallery-item${isRemoving ? ' gallery-item-removing' : ''}`}>
                    <Link
                      to={`/read/${item.chapter_id}?page=${item.page_index}&mangaId=${id}`}
                      className="gallery-item-link"
                      title={`${formatGalleryItemLabel(item)} · Page ${item.page_index + 1}`}
                    >
                      <img
                        src={api.pageImageUrl(item.page_id)}
                        alt={`${formatGalleryItemLabel(item)} page ${item.page_index + 1}`}
                        loading="lazy"
                        className="gallery-item-img"
                      />
                      <div className="gallery-item-label">
                        <span className="gallery-item-chapter">{formatGalleryItemLabel(item)}</span>
                        <span className="gallery-item-page">Page {item.page_index + 1}</span>
                      </div>
                    </Link>
                    <button
                      className="gallery-item-remove"
                      onClick={() => handleRemoveFromGallery(item.id)}
                      disabled={isRemoving}
                      title="Remove from gallery"
                      aria-label="Remove from gallery"
                    >
                      {isRemoving
                        ? <div className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                        : <span aria-hidden="true">✕</span>}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {showMetaModal && (
        <div className="modal-backdrop" onClick={() => setShowMetaModal(false)}>
          <div className="modal-box meta-modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Metadata</h2>
              <button className="modal-close" onClick={() => setShowMetaModal(false)}>✕</button>
            </div>
            <div className="meta-modal-body">
              <div className="meta-source-row">
                <label className="meta-source-label">Source</label>
                <select
                  className="meta-source-select"
                  value={metaSource}
                  onChange={e => { setMetaSource(e.target.value); setMetaMessage(null); }}
                >
                  <option value="anilist">AniList</option>
                  <option value="myanimelist">MyAnimeList</option>
                  <option value="mangaupdates">MangaUpdates</option>
                  <option value="doujinshi">Doujinshi.info</option>
                </select>
              </div>

              <p className="meta-modal-desc">
                {metaSource === 'anilist'
                  ? 'Link this manga to an AniList entry to populate its title, cover image, description, genres, score, and release status.'
                  : metaSource === 'myanimelist'
                    ? 'Link this manga to a MyAnimeList entry to populate its title, cover image, description, genres, score, and release status.'
                    : metaSource === 'mangaupdates'
                      ? 'Link this manga to a MangaUpdates entry to populate its title, cover image, description, genres, score, and release status.'
                      : 'Link this manga to a Doujinshi.info entry to populate its title, cover image, year, and tags.'}
                {' '}Linked metadata will not be overwritten by local JSON files.
              </p>

              <div className="meta-modal-status-row">
                {hasMetadata ? (
                  manga.metadata_source === 'local'
                    ? <span className="meta-status-badge meta-status-local">Local file</span>
                    : manga.metadata_source === 'anilist'
                      ? <span className="meta-status-badge meta-status-anilist">
                          Linked to AniList
                          {manga.anilist_id && (
                            <a href={`https://anilist.co/manga/${manga.anilist_id}`} target="_blank" rel="noreferrer"> ↗</a>
                          )}
                        </span>
                      : manga.metadata_source === 'myanimelist'
                        ? <span className="meta-status-badge meta-status-mal">
                            Linked to MyAnimeList
                            {manga.mal_id && (
                              <a href={`https://myanimelist.net/manga/${manga.mal_id}`} target="_blank" rel="noreferrer"> ↗</a>
                            )}
                          </span>
                        : manga.metadata_source === 'mangaupdates'
                          ? <span className="meta-status-badge meta-status-mangaupdates">
                              Linked to MangaUpdates
                              {manga.mangaupdates_id && (
                                <a href={`https://www.mangaupdates.com/series.html?id=${manga.mangaupdates_id}`} target="_blank" rel="noreferrer"> ↗</a>
                              )}
                            </span>
                          : manga.metadata_source === 'doujinshi'
                            ? <span className="meta-status-badge meta-status-doujinshi">
                                Linked to Doujinshi.info
                                {manga.doujinshi_id && (
                                  <a href={`https://doujinshi.info/book/${manga.doujinshi_id}`} target="_blank" rel="noreferrer"> ↗</a>
                                )}
                              </span>
                            : <span className="meta-status-badge meta-status-anilist">Linked</span>
                ) : (
                  <span className="meta-status-badge meta-status-none">No metadata linked</span>
                )}
              </div>

              {metaMessage && (
                <div className={`metadata-msg metadata-msg-${metaMessage.type}`}>
                  {metaMessage.text}
                </div>
              )}

              {metaSource === 'anilist' ? (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">{hasMetadata ? 'Re-fetch Metadata' : 'Fetch Metadata'}</span>
                      <span className="meta-modal-action-desc">
                        Automatically search AniList by this manga's title and apply the closest match.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleFetchMetadata}
                      disabled={fetchingMeta}
                    >
                      {fetchingMeta ? 'Fetching…' : hasMetadata ? 'Re-fetch' : 'Fetch'}
                    </button>
                  </div>
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Search Manually</span>
                      <span className="meta-modal-action-desc">
                        Browse AniList search results and choose the correct entry yourself.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowMetaModal(false); setShowSearch(true); }}
                    >
                      Search
                    </button>
                  </div>
                  {manga.anilist_id && (
                    <div className="meta-modal-action-row">
                      <div className="meta-modal-action-info">
                        <span className="meta-modal-action-label">Export as JSON</span>
                        <span className="meta-modal-action-desc">
                          Re-fetch this manga's AniList entry and save it as <code>metadata.json</code> in
                          the manga's folder. Any existing <code>metadata.json</code> will be overwritten.
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleExportMangaMetadata('anilist')}
                        disabled={exportingMangaMeta}
                      >
                        {exportingMangaMeta ? 'Exporting…' : 'Export'}
                      </button>
                    </div>
                  )}
                </div>
              ) : metaSource === 'myanimelist' ? (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">{hasMetadata ? 'Re-fetch Metadata' : 'Fetch Metadata'}</span>
                      <span className="meta-modal-action-desc">
                        Automatically search MyAnimeList by this manga's title and apply the closest match.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleFetchMalMetadata}
                      disabled={fetchingMeta}
                    >
                      {fetchingMeta ? 'Fetching…' : hasMetadata ? 'Re-fetch' : 'Fetch'}
                    </button>
                  </div>
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Search Manually</span>
                      <span className="meta-modal-action-desc">
                        Browse MyAnimeList search results and choose the correct entry yourself.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowMetaModal(false); setShowMALSearch(true); }}
                    >
                      Search
                    </button>
                  </div>
                  {manga.mal_id && (
                    <div className="meta-modal-action-row">
                      <div className="meta-modal-action-info">
                        <span className="meta-modal-action-label">Export as JSON</span>
                        <span className="meta-modal-action-desc">
                          Re-fetch this manga's MyAnimeList entry and save it as <code>metadata.json</code> in
                          the manga's folder. Any existing <code>metadata.json</code> will be overwritten.
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleExportMangaMetadata('myanimelist')}
                        disabled={exportingMangaMeta}
                      >
                        {exportingMangaMeta ? 'Exporting…' : 'Export'}
                      </button>
                    </div>
                  )}
                </div>
              ) : metaSource === 'mangaupdates' ? (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">{hasMetadata ? 'Re-fetch Metadata' : 'Fetch Metadata'}</span>
                      <span className="meta-modal-action-desc">
                        Automatically search MangaUpdates by this manga's title and apply the closest match.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleFetchMangaUpdatesMetadata}
                      disabled={fetchingMeta}
                    >
                      {fetchingMeta ? 'Fetching…' : hasMetadata ? 'Re-fetch' : 'Fetch'}
                    </button>
                  </div>
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Search Manually</span>
                      <span className="meta-modal-action-desc">
                        Browse MangaUpdates search results and choose the correct entry yourself.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowMetaModal(false); setShowMangaUpdatesSearch(true); }}
                    >
                      Search
                    </button>
                  </div>
                  {manga.mangaupdates_id && (
                    <div className="meta-modal-action-row">
                      <div className="meta-modal-action-info">
                        <span className="meta-modal-action-label">Export as JSON</span>
                        <span className="meta-modal-action-desc">
                          Read this manga's previously-fetched MangaUpdates record from cache and save it as
                          <code>metadata.json</code> in the manga's folder. Any existing
                          <code>metadata.json</code> will be overwritten.
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleExportMangaMetadata('mangaupdates')}
                        disabled={exportingMangaMeta}
                      >
                        {exportingMangaMeta ? 'Exporting…' : 'Export'}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">{hasMetadata ? 'Re-fetch Metadata' : 'Fetch Metadata'}</span>
                      <span className="meta-modal-action-desc">
                        Automatically search Doujinshi.info by this manga's title and apply the closest match.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleFetchDoujinshiMetadata}
                      disabled={fetchingMeta}
                    >
                      {fetchingMeta ? 'Fetching…' : hasMetadata ? 'Re-fetch' : 'Fetch'}
                    </button>
                  </div>
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Search Manually</span>
                      <span className="meta-modal-action-desc">
                        Browse Doujinshi.info search results and choose the correct entry yourself.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowMetaModal(false); setShowDoujinshiSearch(true); }}
                    >
                      Search
                    </button>
                  </div>
                  {manga.doujinshi_id && (
                    <div className="meta-modal-action-row">
                      <div className="meta-modal-action-info">
                        <span className="meta-modal-action-label">Export as JSON</span>
                        <span className="meta-modal-action-desc">
                          Re-fetch this manga's Doujinshi.info entry and save it as <code>metadata.json</code> in
                          the manga's folder. Any existing <code>metadata.json</code> will be overwritten.
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleExportMangaMetadata('doujinshi')}
                        disabled={exportingMangaMeta}
                      >
                        {exportingMangaMeta ? 'Exporting…' : 'Export'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {((metaSource === 'anilist'      && manga.anilist_id)      ||
                (metaSource === 'myanimelist'  && manga.mal_id)          ||
                (metaSource === 'mangaupdates' && manga.mangaupdates_id) ||
                (metaSource === 'doujinshi'    && manga.doujinshi_id)) && (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Break Linkage</span>
                      <span className="meta-modal-action-desc">
                        Remove the connection to{' '}
                        {metaSource === 'anilist' ? 'AniList'
                          : metaSource === 'myanimelist' ? 'MyAnimeList'
                          : metaSource === 'mangaupdates' ? 'MangaUpdates'
                          : 'Doujinshi.info'}.{' '}
                        {manga.metadata_source === metaSource
                          ? 'All fetched metadata will be cleared.'
                          : 'Your existing metadata will be preserved — only the link is removed.'}
                      </span>
                    </div>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleResetMetadata(metaSource)}
                      disabled={fetchingMeta}
                    >
                      Break
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showSearch && (
        <AnilistSearchModal
          mangaId={id}
          defaultQuery={manga.title}
          onApplied={handleMetadataApplied}
          onClose={() => setShowSearch(false)}
        />
      )}

      {showDoujinshiSearch && (
        <DoujinshiSearchModal
          mangaId={id}
          defaultQuery={manga.title}
          onApplied={handleDoujinshiMetadataApplied}
          onClose={() => setShowDoujinshiSearch(false)}
        />
      )}

      {showMALSearch && (
        <MALSearchModal
          mangaId={id}
          defaultQuery={manga.title}
          onApplied={handleMalMetadataApplied}
          onClose={() => setShowMALSearch(false)}
        />
      )}

      {showMangaUpdatesSearch && (
        <MangaUpdatesSearchModal
          mangaId={id}
          defaultQuery={manga.title}
          onApplied={handleMangaUpdatesMetadataApplied}
          onClose={() => setShowMangaUpdatesSearch(false)}
        />
      )}

      {showOptimize && (
        <div className="modal-backdrop" onClick={closeOptimizeModal}>
          <div className="modal-box optimize-modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Optimize Chapters</h2>
              {optimizePhase !== 'running' && (
                <button className="modal-close" onClick={closeOptimizeModal}>✕</button>
              )}
            </div>

            {optimizePhase === 'confirm' && (
              <div className="optimize-body">
                <p className="optimize-desc">
                  This will process every chapter in <strong>{manga.title}</strong>:
                </p>
                <ul className="optimize-list">
                  <li>Folders of images → converted to <strong>.cbz</strong></li>
                  <li><strong>.zip</strong> files → renamed to <strong>.cbz</strong></li>
                  <li><strong>.7z</strong> files → extracted and repacked as <strong>.cbz</strong> (requires 7-Zip)</li>
                  <li>File names → standardized to <strong>Ch N</strong> or <strong>Vol N Ch M</strong></li>
                </ul>
                <p className="optimize-warning">Original folders and non-CBZ archives will be deleted. This cannot be undone.</p>
                <div className="optimize-actions">
                  <button className="btn btn-ghost" onClick={closeOptimizeModal}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleOptimize}>Start Optimization</button>
                </div>
              </div>
            )}

            {optimizePhase === 'running' && (
              <div className="optimize-body optimize-running">
                <div className="spinner" />
                <p className="optimize-running-label">
                  Optimizing… {formatOptimizeElapsed(optimizeTask.elapsedSec)}
                </p>
                <p className="optimize-running-hint">
                  You can close this dialog and come back — the operation continues in the background.
                </p>
              </div>
            )}

            {optimizePhase === 'failed' && (
              <div className="optimize-body">
                <p className="optimize-error">Error: {optimizeError || 'unknown error'}</p>
                <div className="optimize-actions">
                  <button className="btn btn-ghost" onClick={() => optimizeTask.reset()}>Try Again</button>
                  <button className="btn btn-primary" onClick={closeOptimizeModal}>Close</button>
                </div>
              </div>
            )}

            {optimizePhase === 'done' && optimizeResult && (
              <div className="optimize-body">
                <div className="optimize-results">
                  <div className="optimize-stat">
                    <span className="optimize-stat-value">{optimizeResult.renamed}</span>
                    <span className="optimize-stat-label">Renamed</span>
                  </div>
                  <div className="optimize-stat">
                    <span className="optimize-stat-value">{optimizeResult.converted}</span>
                    <span className="optimize-stat-label">Converted to CBZ</span>
                  </div>
                  <div className="optimize-stat">
                    <span className="optimize-stat-value">{(optimizeResult.skipped || []).length}</span>
                    <span className="optimize-stat-label">Skipped</span>
                  </div>
                  <div className="optimize-stat">
                    <span className="optimize-stat-value">{(optimizeResult.errors || []).length}</span>
                    <span className="optimize-stat-label">Errors</span>
                  </div>
                </div>
                {(optimizeResult.skipped || []).length > 0 && (
                  <div className="optimize-log">
                    <p className="optimize-log-title">Skipped</p>
                    {optimizeResult.skipped.map((s, i) => (
                      <p key={i} className="optimize-log-item"><span className="optimize-log-name">{s.name}</span> — {s.reason}</p>
                    ))}
                  </div>
                )}
                {(optimizeResult.errors || []).length > 0 && (
                  <div className="optimize-log optimize-log-errors">
                    <p className="optimize-log-title">Errors</p>
                    {optimizeResult.errors.map((e, i) => (
                      <p key={i} className="optimize-log-item"><span className="optimize-log-name">{e.name}</span> — {e.error}</p>
                    ))}
                  </div>
                )}
                <div className="optimize-actions">
                  <button className="btn btn-primary" onClick={closeOptimizeModal}>Done</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Nav drawer */}
      {showNavDrawer && (
        <div className="detail-nav-backdrop" onClick={() => setShowNavDrawer(false)} />
      )}
      <div className={`detail-nav-drawer${showNavDrawer ? ' open' : ''}`}>
        <div className="detail-nav-drawer-header">
          <span className="detail-nav-drawer-title">Browse</span>
          <button className="detail-nav-drawer-close" onClick={() => setShowNavDrawer(false)} aria-label="Close">✕</button>
        </div>
        <div className="detail-nav-drawer-body">
          {navLibraries.length > 1 && (
            <>
              <p className="detail-nav-section-label">Libraries</p>
              <button className="detail-nav-item" onClick={() => goToLibrary(null)}>
                All Libraries
              </button>
              {navLibraries.map(lib => (
                <button key={lib.id} className="detail-nav-item" onClick={() => goToLibrary(lib.id)}>
                  {lib.name}
                  <span className="detail-nav-count">{lib.manga_count}</span>
                </button>
              ))}
              <div className="detail-nav-divider" />
            </>
          )}
          {navLists.length > 0 && (
            <>
              <p className="detail-nav-section-label">Reading Lists</p>
              {navLists.map(list => (
                <button key={list.id} className="detail-nav-item" onClick={() => goToList(list.id)}>
                  {list.name}
                  <span className="detail-nav-count">{list.manga_count}</span>
                </button>
              ))}
            </>
          )}
          {!navLoaded && (
            <div className="detail-nav-loading"><div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /></div>
          )}
        </div>
      </div>

      {showInfo && (
        <div className="modal-backdrop" onClick={() => setShowInfo(false)}>
          <div className="modal-box info-modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">More Info</h2>
              <button className="modal-close" onClick={() => setShowInfo(false)}>✕</button>
            </div>
            <div className="info-modal-body">
              {infoLoading && <div className="loading-center"><div className="spinner" /></div>}
              {infoError && <p className="info-modal-error">{infoError}</p>}
              {infoData && (() => {
                const trackingVolumes = !!manga?.track_volumes;
                const missing = trackingVolumes ? infoData.missing_volumes : infoData.missing_chapters;
                const noun  = trackingVolumes ? 'Volumes' : 'Chapters';
                const DISPLAY_CAP = 50;
                const formatList = (m) => {
                  const numbers = m?.numbers || [];
                  const total = m?.count ?? numbers.length;
                  if (total === 0) return 'None';
                  if (total <= DISPLAY_CAP) return numbers.join(', ');
                  return numbers.slice(0, DISPLAY_CAP).join(', ') + `, … (+${(total - DISPLAY_CAP).toLocaleString()} more)`;
                };
                return (
                <dl className="info-modal-list">
                  <div className="info-modal-row">
                    <dt className="info-modal-label">File Path</dt>
                    <dd className="info-modal-value info-modal-path">{infoData.path}</dd>
                  </div>
                  <div className="info-modal-row">
                    <dt className="info-modal-label">Files Found</dt>
                    <dd className="info-modal-value">{(infoData.file_count ?? 0).toLocaleString()}</dd>
                  </div>
                  <div className="info-modal-row">
                    <dt className="info-modal-label">Folder Size</dt>
                    <dd className="info-modal-value">{(infoData.size_mb ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB</dd>
                  </div>
                  {missing && (
                    <>
                      <div className="info-modal-row">
                        <dt className="info-modal-label">Missing {noun}</dt>
                        <dd className="info-modal-value">{(missing.count ?? 0).toLocaleString()}</dd>
                      </div>
                      <div className="info-modal-row">
                        <dt className="info-modal-label">Missing {noun} List</dt>
                        <dd className="info-modal-value info-modal-list-value">{formatList(missing)}</dd>
                      </div>
                    </>
                  )}
                </dl>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {showThumbPicker && (
        <ThumbnailPickerModal
          mangaId={id}
          onApplied={() => {
            setCoverBust(Date.now());
            setShowThumbPicker(false);
          }}
          onClose={() => setShowThumbPicker(false)}
        />
      )}

      {showSourceUrlsModal && (
        <SourceUrlsModal
          manga={manga}
          onClose={() => setShowSourceUrlsModal(false)}
        />
      )}

      {showDeleteConfirm && (
        <div className="modal-backdrop" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="modal-box delete-confirm-box" onClick={e => e.stopPropagation()}>
            <div className="delete-confirm-icon">
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <h2 className="delete-confirm-title">Delete manga?</h2>
            <p className="delete-confirm-body">
              <strong>{manga.title}</strong> and all its files will be permanently removed from disk. This cannot be undone.
            </p>
            <div className="delete-confirm-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDeleteConfirmed}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
