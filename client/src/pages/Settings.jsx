import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useAdminTask } from '../hooks/useAdminTask';
import { useConnectivity } from '../context/ConnectivityContext';
import {
  isAvailable as offlineStorageAvailable,
  getStatus     as offlineGetStatus,
  pickFolder    as offlinePickFolder,
  clearFolder   as offlineClearFolder,
} from '../api/offlineStorage';
import {
  listDownloads,
  cancelJob,
  retryJob,
  deleteSeries as downloaderDeleteSeries,
  onChange as onDownloaderChange,
  resumeAfterUnlock as downloaderResumeAfterUnlock,
} from '../api/downloader';
import { listOfflineManga } from '../api/offlineDb';
import {
  isEncryptionEnabled as offlineIsEncryptionEnabled,
  isUnlocked          as offlineIsUnlocked,
  enableEncryption    as offlineEnableEncryption,
  disableEncryption   as offlineDisableEncryption,
  unlock              as offlineUnlock,
  lock                as offlineLock,
} from '../api/offlineCrypto';
import { APP_VERSION } from '../version';
import './Settings.css';
import './Libraries.css';
import '../components/ReaderControls.css';

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
function formatElapsed(sec) {
  if (sec == null) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const STALE_BADGE_MS    = 5 * 60 * 1000;   // older than this → don't show 'done' badge after re-mount
const AUTO_DISMISS_MS   = 30 * 1000;        // newly-done badge auto-clears after this

function useAdminTaskButton({
  startUrl,
  statusUrl,
  idleLabel,
  runningLabel = 'Running',
  formatResult,            // (result) => string
  confirmMessage,          // optional window.confirm() text before start
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
    if (confirmMessage && !window.confirm(confirmMessage)) return;
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

// Per-library bulk optimize. Each library row mounts its own instance so
// the hook state is scoped to that library — two libraries can show
// independent progress at the same time.
function BulkOptimizeButton({ libraryId, disabled }) {
  const { button } = useAdminTaskButton({
    startUrl:     `/api/libraries/${libraryId}/bulk-optimize`,
    statusUrl:    `/api/libraries/${libraryId}/bulk-optimize/status`,
    idleLabel:    'Bulk Optimize',
    runningLabel: 'Optimizing',
    buttonTitle:  'Rename and convert all chapters in this library to standardized CBZ format',
    disabled,
  });
  return button;
}

// ── Shared library form ───────────────────────────────────────────────────────

function LibraryForm({ initialName = '', initialPath = '', submitLabel, onSubmit, onCancel, error }) {
  const [name, setName] = useState(initialName);
  const [libPath, setLibPath] = useState(initialPath);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !libPath.trim()) return;
    setSaving(true);
    try {
      await onSubmit(name.trim(), libPath.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="lp-form" onSubmit={handleSubmit}>
      <div className="lp-form-fields">
        <div className="lp-field">
          <label className="lp-label">Library name</label>
          <input
            className="lp-input"
            placeholder="e.g. Manga, Comics, Light Novels"
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="lp-field">
          <label className="lp-label">Folder path on server</label>
          <input
            className="lp-input lp-input-mono"
            placeholder="e.g. /data/manga  or  C:\manga"
            value={libPath}
            onChange={e => setLibPath(e.target.value)}
          />
        </div>
      </div>
      {error && <p className="lp-form-error">{error}</p>}
      <div className="lp-form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || !name.trim() || !libPath.trim()}
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Section: Library Management ───────────────────────────────────────────────

function LibrariesSection() {
  const [libraries, setLibraries] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editError, setEditError] = useState(null);
  const [scanning, setScanning] = useState(null);
  const [bulkPulling, setBulkPulling] = useState(null);
  const [bulkStatus, setBulkStatus] = useState(null); // { libId, message }
  const [bulkSourceDropdown, setBulkSourceDropdown] = useState(null); // lib.id of open dropdown
  const [exporting, setExporting] = useState(null); // lib.id being exported
  const [exportStatus, setExportStatus] = useState(null); // { libId, message }
  const [resetting, setResetting] = useState(null); // lib.id being reset
  const [resetConfirm, setResetConfirm] = useState(null); // library object pending confirm
  const [resetStatus, setResetStatus] = useState(null); // { libId, message }

  useEffect(() => {
    api.getLibraries().then(data => setLibraries(data)).catch(() => setLibraries([]));
  }, []);

  async function handleAdd(name, path) {
    setAddError(null);
    try {
      const lib = await api.createLibrary({ name, path });
      setLibraries(prev => [...prev, lib]);
      setShowAdd(false);
    } catch (err) {
      setAddError(err.message);
      throw err;
    }
  }

  async function handleEdit(id, name, path) {
    setEditError(null);
    try {
      const updated = await api.updateLibrary(id, { name, path });
      setLibraries(prev => prev.map(l => l.id === id ? updated : l));
      setEditId(null);
    } catch (err) {
      setEditError(err.message);
      throw err;
    }
  }

  async function handleDelete(lib) {
    const confirmed = window.confirm(
      `Delete library "${lib.name}"?\n\n` +
      `This will remove all ${lib.manga_count} series from Momotaro. ` +
      `Files on disk will not be affected.`
    );
    if (!confirmed) return;
    try {
      await api.deleteLibrary(lib.id);
      setLibraries(prev => prev.filter(l => l.id !== lib.id));
      if (editId === lib.id) setEditId(null);
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  async function handleToggleShowInAll(lib) {
    try {
      const updated = await api.updateLibrary(lib.id, { show_in_all: lib.show_in_all ? 0 : 1 });
      setLibraries(prev => prev.map(l => l.id === lib.id ? updated : l));
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
  }

  async function handleScan(lib) {
    setScanning(lib.id);
    try {
      await api.scanLibrary(lib.id);
      setTimeout(() => {
        api.getLibraries().then(data => setLibraries(data)).catch(() => {});
        setScanning(s => s === lib.id ? null : s);
      }, 3000);
    } catch (err) {
      alert('Scan failed: ' + err.message);
      setScanning(s => s === lib.id ? null : s);
    }
  }

  async function handleBulkMetadata(lib, source) {
    setBulkSourceDropdown(null);
    setBulkPulling(lib.id);
    setBulkStatus(null);
    try {
      const result = await api.bulkMetadata(lib.id, source);
      const { to_refresh = 0, to_search = 0, total = 0 } = result;
      const plural = (n, s, p = s + 's') => `${n} ${n === 1 ? s : p}`;
      let message;
      if (total === 0) {
        message = 'No manga in this library yet — nothing to pull.';
      } else {
        const parts = [];
        if (to_refresh > 0) {
          parts.push(`refreshing ${plural(to_refresh, 'already-linked title')}`);
        }
        if (to_search > 0) {
          parts.push(`searching for ${plural(to_search, 'unlinked title')}`);
        }
        message =
          parts.length > 0
            ? `Started: ${parts.join(' and ')} in the background.`
            : `Started for ${plural(total, 'title')} in the background.`;
      }
      setBulkStatus({ libId: lib.id, message });
    } catch (err) {
      alert('Bulk metadata pull failed: ' + err.message);
    } finally {
      setBulkPulling(null);
    }
  }

  async function handleConfirmReset() {
    const lib = resetConfirm;
    if (!lib) return;
    setResetConfirm(null);
    setResetting(lib.id);
    setResetStatus(null);
    try {
      const result = await api.resetLibraryMetadata(lib.id);
      const {
        titles_reset           = 0,
        json_files_deleted     = 0,
        cache_files_deleted    = 0,
        thumbnails_restored    = 0,
        thumbnails_regenerated = 0,
      } = result;
      const plural = (n, s, p = s + 's') => `${n} ${n === 1 ? s : p}`;
      const thumbBits = [];
      if (thumbnails_restored    > 0) thumbBits.push(`restored ${thumbnails_restored}`);
      if (thumbnails_regenerated > 0) thumbBits.push(`regenerated ${thumbnails_regenerated} from first page`);
      const thumbSentence = thumbBits.length > 0
        ? ` Thumbnails: ${thumbBits.join(', ')}.`
        : '';
      const message =
        `Reset ${plural(titles_reset, 'title')}. ` +
        `Deleted ${plural(json_files_deleted, 'local JSON file')} and ` +
        `${plural(cache_files_deleted, 'cached metadata file')}.` +
        thumbSentence;
      setResetStatus({ libId: lib.id, message });
      // Manga counts don't change, but let other UI pick up cleared metadata.
      api.getLibraries().then(data => setLibraries(data)).catch(() => {});
    } catch (err) {
      alert('Reset metadata failed: ' + err.message);
    } finally {
      setResetting(null);
    }
  }

  async function handleExportMetadata(lib) {
    setExporting(lib.id);
    setExportStatus(null);
    try {
      const result = await api.exportMetadata(lib.id);
      const { exported, exported_local = 0, skipped, errors } = result;
      let message;
      if (exported === 0 && skipped > 0) {
        message = `No metadata to export — none of the ${skipped} title${skipped !== 1 ? 's' : ''} have third-party metadata yet.`;
      } else {
        message = `Exported metadata for ${exported} title${exported !== 1 ? 's' : ''}.`;
        if (exported_local > 0) {
          message += ` ${exported_local} local-metadata title${exported_local !== 1 ? 's' : ''} overwritten with third-party data.`;
        }
        if (skipped > 0) message += ` ${skipped} skipped (no metadata).`;
        if (errors  > 0) message += ` ${errors} write error${errors !== 1 ? 's' : ''}.`;
      }
      setExportStatus({ libId: lib.id, message });
    } catch (err) {
      alert('Metadata export failed: ' + err.message);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Library Management</h2>
          <p className="sp-section-desc">
            Each library points to a folder on the server. Momotaro scans it for manga
            series and watches for new additions automatically.
          </p>
        </div>
        {!showAdd && (
          <button
            className="btn btn-primary"
            style={{ flexShrink: 0 }}
            onClick={() => { setShowAdd(true); setAddError(null); setEditId(null); }}
          >
            + Add Library
          </button>
        )}
      </div>

      {showAdd && (
        <div className="lp-add-card">
          <p className="lp-add-title">New Library</p>
          <LibraryForm
            submitLabel="Add Library"
            onSubmit={handleAdd}
            onCancel={() => { setShowAdd(false); setAddError(null); }}
            error={addError}
          />
        </div>
      )}

      {libraries === null ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : libraries.length === 0 && !showAdd ? (
        <div className="lp-empty">
          <div className="lp-empty-icon">📚</div>
          <h2>No libraries yet</h2>
          <p>Click <strong>+ Add Library</strong> to point Momotaro at a folder of manga.</p>
        </div>
      ) : (
        <div className="lp-list">
          {libraries.map(lib => (
            <div key={lib.id} className={`lp-card${editId === lib.id ? ' lp-card-editing' : ''}`}>
              {editId === lib.id ? (
                <>
                  <div className="lp-card-edit-header">
                    <span className="lp-card-edit-label">Editing: {lib.name}</span>
                  </div>
                  <LibraryForm
                    initialName={lib.name}
                    initialPath={lib.path}
                    submitLabel="Save Changes"
                    onSubmit={(name, path) => handleEdit(lib.id, name, path)}
                    onCancel={() => { setEditId(null); setEditError(null); }}
                    error={editError}
                  />
                </>
              ) : (
                <>
                  <div className="lp-card-info">
                    <div className="lp-card-name-row">
                      <span className="lp-lib-name">{lib.name}</span>
                      <span className="lp-lib-badge">{lib.manga_count} series</span>
                    </div>
                    <div className="lp-card-path-row">
                      <svg className="lp-folder-icon" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                      <span className="lp-lib-path">{lib.path}</span>
                    </div>
                    <div className="lp-card-toggle-row">
                      <span className="lp-toggle-label">Show in All Libraries</span>
                      <button
                        className={`lp-toggle${lib.show_in_all ? ' on' : ''}`}
                        onClick={() => handleToggleShowInAll(lib)}
                        title={lib.show_in_all ? 'Hide from All Libraries view' : 'Show in All Libraries view'}
                      >
                        <span className="lp-toggle-thumb" />
                      </button>
                    </div>
                  </div>
                  <div className="lp-card-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleScan(lib)}
                      disabled={scanning === lib.id}
                    >
                      {scanning === lib.id ? 'Scanning…' : 'Scan Now'}
                    </button>
                    <div className="lp-bulk-meta-wrap">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setBulkSourceDropdown(bulkSourceDropdown === lib.id ? null : lib.id)}
                        disabled={bulkPulling === lib.id || scanning === lib.id}
                        title="Search for metadata for each title in this library"
                      >
                        {bulkPulling === lib.id ? 'Pulling…' : 'Bulk Metadata Pull ▾'}
                      </button>
                      {bulkSourceDropdown === lib.id && (
                        <div className="lp-bulk-meta-dropdown">
                          <button
                            className="lp-bulk-meta-option"
                            onClick={() => handleBulkMetadata(lib, 'anilist')}
                          >
                            AniList
                          </button>
                          <button
                            className="lp-bulk-meta-option"
                            onClick={() => handleBulkMetadata(lib, 'myanimelist')}
                          >
                            MyAnimeList
                          </button>
                          <button
                            className="lp-bulk-meta-option"
                            onClick={() => handleBulkMetadata(lib, 'mangaupdates')}
                          >
                            MangaUpdates
                          </button>
                          <button
                            className="lp-bulk-meta-option"
                            onClick={() => handleBulkMetadata(lib, 'doujinshi')}
                          >
                            Doujinshi.info
                          </button>
                        </div>
                      )}
                    </div>
                    <BulkOptimizeButton libraryId={lib.id} disabled={scanning === lib.id} />
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleExportMetadata(lib)}
                      disabled={exporting === lib.id}
                      title="Write metadata.json to each manga folder that has third-party metadata"
                    >
                      {exporting === lib.id ? 'Exporting…' : 'Export Metadata'}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm lp-btn-danger"
                      onClick={() => setResetConfirm(lib)}
                      disabled={resetting === lib.id}
                      title="Delete all third-party metadata and local metadata.json sidecars in this library"
                    >
                      {resetting === lib.id ? 'Resetting…' : 'Reset Metadata'}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setEditId(lib.id); setEditError(null); setShowAdd(false); }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-sm lp-btn-danger"
                      onClick={() => handleDelete(lib)}
                    >
                      Delete
                    </button>
                  </div>
                  {bulkStatus?.libId === lib.id && (
                    <p className="lp-bulk-status">{bulkStatus.message}</p>
                  )}
                  {exportStatus?.libId === lib.id && (
                    <p className="lp-bulk-status">{exportStatus.message}</p>
                  )}
                  {resetStatus?.libId === lib.id && (
                    <p className="lp-bulk-status">{resetStatus.message}</p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {resetConfirm && (
        <div className="lp-modal-backdrop" onClick={() => setResetConfirm(null)}>
          <div className="lp-modal-box" onClick={e => e.stopPropagation()}>
            <div className="lp-modal-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495a1.75 1.75 0 013.03 0l6.28 10.875A1.75 1.75 0 0116.28 16H3.72a1.75 1.75 0 01-1.515-2.63l6.28-10.875zM10 7a1 1 0 00-1 1v3a1 1 0 102 0V8a1 1 0 00-1-1zm0 7a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
              </svg>
            </div>
            <h2 className="lp-modal-title">Reset metadata for "{resetConfirm.name}"?</h2>
            <p className="lp-modal-body">
              This will permanently remove <strong>all third-party metadata</strong>
              {' '}(AniList, MyAnimeList, MangaUpdates, Doujinshi.info) for every
              series in this library, and delete any local metadata
              <code className="lp-modal-code">.json</code> sidecar files
              (<code className="lp-modal-code">metadata.json</code>,{' '}
              <code className="lp-modal-code">info.json</code>,{' '}
              <code className="lp-modal-code">gallery.json</code>,
              image-sidecar files, etc.) saved in each manga folder. Each
              series' title will revert to its folder name and its thumbnail
              will revert to the original generated cover.
            </p>
            <p className="lp-modal-warning">
              This action cannot be undone.
            </p>
            <div className="lp-modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setResetConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="btn lp-btn-danger-solid"
                onClick={handleConfirmReset}
              >
                Reset Metadata
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section: AniList ──────────────────────────────────────────────────────────

function AnilistSection() {
  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  useEffect(() => {
    api.getSettings().then(data => {
      setSettings(data);
      setClientId(data.anilist_client_id || '');
    }).catch(() => {});
  }, []);

  function buildOAuthUrl() {
    const redirectUri = encodeURIComponent(window.location.origin + '/auth/anilist/callback');
    return `https://anilist.co/api/v2/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code`;
  }

  async function handleSaveCredentials(e) {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      const body = { anilist_client_id: clientId };
      if (clientSecret.trim()) body.anilist_client_secret = clientSecret.trim();
      await api.saveSettings(body);
      setSettings(prev => ({
        ...prev,
        anilist_client_id: clientId,
        anilist_client_secret_set: prev.anilist_client_secret_set || !!clientSecret.trim(),
      }));
      setClientSecret('');
      setStatusMsg({ type: 'success', text: 'Credentials saved.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    if (!confirm('Log out of AniList?')) return;
    setLoggingOut(true);
    try {
      await api.anilistLogout();
      setSettings(prev => ({
        ...prev,
        anilist_logged_in: false,
        anilist_token_set: false,
        anilist_user_id: null,
        anilist_username: null,
        anilist_avatar: null,
      }));
      setStatusMsg({ type: 'success', text: 'Logged out of AniList.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Logout failed: ' + err.message });
    } finally {
      setLoggingOut(false);
    }
  }

  if (!settings) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  const canLogin = !!clientId.trim() && settings.anilist_client_secret_set;

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">AniList</h2>
          <p className="sp-section-desc">
            Log in with your AniList account to automatically track your reading progress.
            When you finish a chapter, Momotaro will update your AniList manga list in the background.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      {settings.anilist_logged_in ? (
        <div className="settings-card">
          <div className="settings-user-row">
            {settings.anilist_avatar && (
              <img
                className="settings-avatar"
                src={settings.anilist_avatar}
                alt={settings.anilist_username}
              />
            )}
            <div>
              <p className="settings-username">{settings.anilist_username}</p>
              <a
                className="settings-profile-link"
                href={`https://anilist.co/user/${settings.anilist_username}`}
                target="_blank"
                rel="noreferrer"
              >
                View AniList Profile
              </a>
            </div>
          </div>
          <p className="settings-hint">Reading progress syncs to your AniList automatically.</p>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleLogout}
            disabled={loggingOut}
            style={{ alignSelf: 'flex-start' }}
          >
            {loggingOut ? 'Logging out...' : 'Log Out'}
          </button>
        </div>
      ) : (
        <div className="settings-card">
          <p className="settings-oauth-intro">To log in, you need a free AniList API client:</p>
          <ol className="settings-steps">
            <li>
              Go to{' '}
              <a href="https://anilist.co/settings/developer" target="_blank" rel="noreferrer">
                AniList → Settings → Developer
              </a>{' '}
              and click <strong>Create new client</strong>
            </li>
            <li>
              Set the <strong>Redirect URL</strong> to exactly:<br />
              <code>{window.location.origin}/auth/anilist/callback</code>
            </li>
            <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> and paste them below</li>
          </ol>
          <form className="settings-token-form" onSubmit={handleSaveCredentials}>
            <label className="settings-label">Client ID</label>
            <input
              type="text"
              className="settings-input"
              placeholder="e.g. 38687"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              autoComplete="off"
            />
            <label className="settings-label" style={{ marginTop: 4 }}>
              Client Secret
              {settings.anilist_client_secret_set && (
                <span className="settings-saved-note"> (saved)</span>
              )}
            </label>
            <input
              type="password"
              className="settings-input"
              placeholder={
                settings.anilist_client_secret_set
                  ? 'Leave blank to keep existing secret'
                  : 'Paste your client secret...'
              }
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              autoComplete="off"
            />
            <div className="settings-token-actions">
              <button
                type="submit"
                className="btn btn-ghost"
                disabled={saving || !clientId.trim()}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              {canLogin && (
                <a className="btn btn-primary" href={buildOAuthUrl()}>
                  Login with AniList
                </a>
              )}
            </div>
          </form>
          {!canLogin && (
            <p className="settings-hint">
              {!clientId.trim()
                ? 'Enter your Client ID and Client Secret above to enable login.'
                : 'Enter your Client Secret above to enable login.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section: Doujinshi.Info ───────────────────────────────────────────────────

function DoujinshiSection() {
  const [settings, setSettings] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  useEffect(() => {
    api.getSettings().then(data => setSettings(data)).catch(() => {});
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setLoggingIn(true);
    setStatusMsg(null);
    try {
      await api.doujinshiLogin(email.trim(), password);
      setSettings(prev => ({ ...prev, doujinshi_logged_in: true }));
      setEmail('');
      setPassword('');
      setStatusMsg({ type: 'success', text: 'Logged in to Doujinshi.info.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Login failed: ' + err.message });
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    if (!confirm('Log out of Doujinshi.info?')) return;
    setLoggingOut(true);
    try {
      await api.doujinshiLogout();
      setSettings(prev => ({ ...prev, doujinshi_logged_in: false }));
      setStatusMsg({ type: 'success', text: 'Logged out of Doujinshi.info.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Logout failed: ' + err.message });
    } finally {
      setLoggingOut(false);
    }
  }

  if (!settings) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Doujinshi.Info</h2>
          <p className="sp-section-desc">
            Log in with your{' '}
            <a href="https://doujinshi.info" target="_blank" rel="noreferrer">Doujinshi.info</a>
            {' '}account to search and pull metadata for doujinshi titles.
            An account is free to create.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      {settings.doujinshi_logged_in ? (
        <div className="settings-card">
          <p className="settings-username">Logged in to Doujinshi.info</p>
          <p className="settings-hint">
            Doujinshi.info metadata is available from the Metadata panel on any manga page,
            and via Bulk Metadata Pull in Library Management.
          </p>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleLogout}
            disabled={loggingOut}
            style={{ alignSelf: 'flex-start' }}
          >
            {loggingOut ? 'Logging out...' : 'Log Out'}
          </button>
        </div>
      ) : (
        <div className="settings-card">
          <form className="settings-token-form" onSubmit={handleLogin}>
            <label className="settings-label">Email</label>
            <input
              type="email"
              className="settings-input"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
            />
            <label className="settings-label" style={{ marginTop: 4 }}>Password</label>
            <input
              type="password"
              className="settings-input"
              placeholder="Your password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <div className="settings-token-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loggingIn || !email.trim() || !password.trim()}
              >
                {loggingIn ? 'Logging in...' : 'Log In'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Section: MyAnimeList ──────────────────────────────────────────────────────

function MyAnimeListSection() {
  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  useEffect(() => {
    api.getSettings().then(data => {
      setSettings(data);
    }).catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!clientId.trim()) return;
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.saveMalClientId(clientId.trim());
      setSettings(prev => ({ ...prev, mal_client_id_set: true }));
      setClientId('');
      setStatusMsg({ type: 'success', text: 'Client ID saved.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!confirm('Remove the MyAnimeList Client ID?')) return;
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.saveMalClientId('');
      setSettings(prev => ({ ...prev, mal_client_id_set: false }));
      setStatusMsg({ type: 'success', text: 'Client ID removed.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">MyAnimeList Integration</h2>
          <p className="sp-section-desc">
            Provide a MyAnimeList API Client ID to enable metadata search and bulk pulls
            from{' '}
            <a href="https://myanimelist.net" target="_blank" rel="noreferrer">MyAnimeList</a>.
            No login is required — only the Client ID is needed to query manga metadata.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      <div className="settings-card">
        {settings.mal_client_id_set ? (
          <>
            <p className="settings-username">Client ID configured</p>
            <p className="settings-hint">
              MyAnimeList metadata is available from the Metadata panel on any manga page
              and via Bulk Metadata Pull in Library Management.
            </p>
            <div className="settings-token-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleClear}
                disabled={saving}
                style={{ alignSelf: 'flex-start' }}
              >
                {saving ? 'Removing…' : 'Remove Client ID'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-oauth-intro">To get a Client ID, create a free API client on MyAnimeList:</p>
            <ol className="settings-steps">
              <li>
                Go to{' '}
                <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noreferrer">
                  MyAnimeList → API Config
                </a>{' '}
                and click <strong>Create ID</strong>
              </li>
              <li>Fill in App Name and App Type, then copy the <strong>Client ID</strong></li>
              <li>Paste the Client ID below and click Save</li>
            </ol>
            <form className="settings-token-form" onSubmit={handleSave}>
              <label className="settings-label">Client ID</label>
              <input
                type="text"
                className="settings-input"
                placeholder="Paste your MAL Client ID…"
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                autoComplete="off"
              />
              <div className="settings-token-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || !clientId.trim()}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ── Section: Homepage Settings ────────────────────────────────────────────────

const DEFAULT_SORT_OPTIONS = [
  { value: 'title',   label: 'A–Z (title)' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'year',    label: 'Year' },
  { value: 'rating',  label: 'Rating (AniList / MyAnimeList)' },
];

// Discover refresh cadence options. Value is milliseconds; 0 == manual-only.
// Default is one day; values must match what resolveDiscoverSeed() in
// Home.jsx reads out of localStorage.
const DISCOVER_INTERVAL_OPTIONS = [
  { value: String(6 * 60 * 60 * 1000),  label: 'Every 6 hours'  },
  { value: String(12 * 60 * 60 * 1000), label: 'Every 12 hours' },
  { value: String(24 * 60 * 60 * 1000), label: 'Daily (default)' },
  { value: String(7 * 24 * 60 * 60 * 1000), label: 'Weekly' },
  { value: '0', label: 'Manual only' },
];
const DEFAULT_DISCOVER_INTERVAL = String(24 * 60 * 60 * 1000);

// Score threshold for the per-genre "Top Manga in <Genre>" ribbons. The home
// endpoint clamps to [0, 10] server-side; matching the same range here.
const DEFAULT_GENRE_MIN_SCORE = 7;
const GENRE_MIN_SCORE_MIN     = 0;
const GENRE_MIN_SCORE_MAX     = 10;
const GENRE_MIN_SCORE_STEP    = 0.5;

function clampGenreMinScore(n) {
  if (!Number.isFinite(n)) return DEFAULT_GENRE_MIN_SCORE;
  return Math.max(GENRE_MIN_SCORE_MIN, Math.min(GENRE_MIN_SCORE_MAX, n));
}

function HomepageSection() {
  const [defaultSort, setDefaultSort] = useState(() => {
    const saved = localStorage.getItem('home_default_sort');
    return DEFAULT_SORT_OPTIONS.some(o => o.value === saved) ? saved : 'title';
  });
  const [discoverInterval, setDiscoverInterval] = useState(() => {
    const saved = localStorage.getItem('home_discover_refresh_ms');
    return DISCOVER_INTERVAL_OPTIONS.some(o => o.value === saved)
      ? saved
      : DEFAULT_DISCOVER_INTERVAL;
  });
  const [genreMinScore, setGenreMinScore] = useState(() => {
    const saved = localStorage.getItem('home_genre_score_threshold');
    if (saved === null) return DEFAULT_GENRE_MIN_SCORE;
    const parsed = parseFloat(saved);
    return Number.isFinite(parsed) ? clampGenreMinScore(parsed) : DEFAULT_GENRE_MIN_SCORE;
  });

  useEffect(() => {
    localStorage.setItem('home_default_sort', defaultSort);
  }, [defaultSort]);

  useEffect(() => {
    localStorage.setItem('home_discover_refresh_ms', discoverInterval);
    // When the user lowers the cadence, reset the last-refresh stamp so the
    // new window starts now — otherwise they'd have to wait out the previous
    // (longer) window before seeing a change.
    localStorage.setItem('home_discover_last_refresh', String(Date.now()));
  }, [discoverInterval]);

  useEffect(() => {
    localStorage.setItem('home_genre_score_threshold', String(genreMinScore));
  }, [genreMinScore]);

  function handleResetDiscoverNow() {
    localStorage.removeItem('home_discover_last_refresh');
    localStorage.removeItem('home_discover_seed');
    alert('Discover picks will reshuffle the next time you open Home.');
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Homepage Settings</h2>
          <p className="sp-section-desc">
            Controls for the Home page and the main library page.
            These preferences are saved in this browser.
          </p>
        </div>
      </div>

      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="setting-group">
          <label className="setting-group-label">Default sort order</label>
          <p className="rs-setting-hint">
            How manga are ordered when you open a library, All Libraries, or a reading list.
            You can still change the sort from the top bar at any time. Rating uses the score
            from AniList or MyAnimeList; unrated titles are pushed to the bottom.
          </p>
          <select
            className="setting-select"
            value={defaultSort}
            onChange={e => setDefaultSort(e.target.value)}
            style={{ maxWidth: 320 }}
          >
            {DEFAULT_SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-card">
        <div className="setting-group">
          <label className="setting-group-label">Discover refresh interval</label>
          <p className="rs-setting-hint">
            Controls how often the <strong>Discover New Series</strong> ribbon on Home
            reshuffles its picks. The underlying candidate list is ranked by how many of
            your favourite genres each manga matches; the visible slice rotates on this
            cadence so the same titles don't stay on top forever.
            A manual <em>Refresh</em> button is always available from Home.
          </p>
          <select
            className="setting-select"
            value={discoverInterval}
            onChange={e => setDiscoverInterval(e.target.value)}
            style={{ maxWidth: 320 }}
          >
            {DISCOVER_INTERVAL_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <div style={{ marginTop: 10 }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleResetDiscoverNow}
            >
              Reshuffle now
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="setting-group">
          <label className="setting-group-label" htmlFor="genre-min-score">
            Genre ribbon rating threshold
          </label>
          <p className="rs-setting-hint">
            Minimum AniList / MyAnimeList score a manga must have to appear in the
            <strong> Top Manga in &lt;Genre&gt;</strong> ribbons on Home. The visible picks are
            randomised from every title in the genre that meets this threshold and
            rotate on the same cadence as <em>Discover New Series</em> above. Titles with
            no rating are never included.
          </p>
          <div className="genre-threshold-row">
            <input
              id="genre-min-score"
              type="range"
              min={GENRE_MIN_SCORE_MIN}
              max={GENRE_MIN_SCORE_MAX}
              step={GENRE_MIN_SCORE_STEP}
              value={genreMinScore}
              onChange={e => setGenreMinScore(clampGenreMinScore(parseFloat(e.target.value)))}
              className="genre-threshold-slider"
            />
            <span className="genre-threshold-value" aria-live="polite">
              {genreMinScore <= 0 ? 'Any rating' : `≥ ${genreMinScore.toFixed(1)}`}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setGenreMinScore(DEFAULT_GENRE_MIN_SCORE)}
              disabled={genreMinScore === DEFAULT_GENRE_MIN_SCORE}
              title={`Reset to default (${DEFAULT_GENRE_MIN_SCORE.toFixed(1)})`}
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section: Reading Settings ─────────────────────────────────────────────────

function ToggleRow({ label, desc, value, onChange }) {
  return (
    <div className="setting-row">
      <div className="setting-row-info">
        <span className="setting-row-label">{label}</span>
        {desc && <span className="setting-row-desc">{desc}</span>}
      </div>
      <button
        className={`toggle-switch ${value ? 'on' : ''}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

// Mirrors Reader.jsx — keep the migration logic identical so opening Settings
// before the reader still translates the legacy boolean key correctly.
function resolveInitialPageAnimation() {
  const stored = localStorage.getItem('reader_pageAnimation');
  if (stored === 'off' || stored === 'slide' || stored === 'fade' || stored === 'curl') return stored;
  const legacy = localStorage.getItem('reader_animTrans');
  if (legacy === 'true')  return 'slide';
  if (legacy === 'false') return 'off';
  return 'slide';
}

function clampAnimSpeed(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, n));
}

function ReadingSection() {
  const [readingMode, setReadingMode]             = useState(() => localStorage.getItem('reader_readingMode') || 'rtl');
  const [readingOrientation, setReadingOrientation] = useState(() => localStorage.getItem('reader_orientation') || 'ltr');
  const [pageAnimation, setPageAnimation]         = useState(resolveInitialPageAnimation);
  const [pageAnimSpeed, setPageAnimSpeed]         = useState(() => clampAnimSpeed(Number(localStorage.getItem('reader_pageAnimSpeed')) || 1));
  const [showEdgeHints, setShowEdgeHints]         = useState(() => localStorage.getItem('reader_edgeHints') === 'true');
  const [gesturesEnabled, setGesturesEnabled]     = useState(() => localStorage.getItem('reader_gestures') !== 'false');
  const [alwaysFullscreen, setAlwaysFullscreen]   = useState(() => localStorage.getItem('reader_alwaysFS') === 'true');
  const [bgColor, setBgColor]                     = useState(() => localStorage.getItem('reader_bgColor') || 'black');
  const [grayscale, setGrayscale]                 = useState(() => localStorage.getItem('reader_grayscale') === 'true');
  const [scaleType, setScaleType]                 = useState(() => localStorage.getItem('reader_scaleType') || 'screen');
  const [pageLayout, setPageLayout]               = useState(() => localStorage.getItem('reader_pageLayout') || 'single');
  const [prefetchPages, setPrefetchPages]         = useState(() => localStorage.getItem('reader_prefetchPages') !== 'false');
  const [resetHintsMsg, setResetHintsMsg]         = useState(null);

  useEffect(() => { localStorage.setItem('reader_readingMode',  readingMode); },         [readingMode]);
  useEffect(() => { localStorage.setItem('reader_orientation',  readingOrientation); },  [readingOrientation]);
  useEffect(() => { localStorage.setItem('reader_pageAnimation', pageAnimation); },      [pageAnimation]);
  useEffect(() => { localStorage.setItem('reader_pageAnimSpeed', String(pageAnimSpeed)); }, [pageAnimSpeed]);
  useEffect(() => { localStorage.setItem('reader_edgeHints',    String(showEdgeHints)); }, [showEdgeHints]);
  useEffect(() => { localStorage.setItem('reader_gestures',     gesturesEnabled); },     [gesturesEnabled]);
  useEffect(() => { localStorage.setItem('reader_alwaysFS',     alwaysFullscreen); },    [alwaysFullscreen]);
  useEffect(() => { localStorage.setItem('reader_bgColor',      bgColor); },             [bgColor]);
  useEffect(() => { localStorage.setItem('reader_grayscale',    grayscale); },           [grayscale]);
  useEffect(() => { localStorage.setItem('reader_scaleType',    scaleType); },           [scaleType]);
  useEffect(() => { localStorage.setItem('reader_pageLayout',   pageLayout); },          [pageLayout]);
  useEffect(() => { localStorage.setItem('reader_prefetchPages', String(prefetchPages)); }, [prefetchPages]);

  // One-time cleanup of the legacy boolean key.
  useEffect(() => {
    if (localStorage.getItem('reader_animTrans') !== null) {
      localStorage.removeItem('reader_animTrans');
    }
  }, []);

  function handleResetHints() {
    try { localStorage.removeItem('reader_hintsSeen'); } catch (_) {}
    setResetHintsMsg('Hint will replay on the next chapter open.');
    setTimeout(() => setResetHintsMsg(null), 3000);
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Reading Settings</h2>
          <p className="sp-section-desc">
            Default settings used when opening the reader. All of these can also be changed
            from within the reader itself.
          </p>
        </div>
      </div>

      {/* General */}
      <div className="rs-group">
        <p className="rs-group-title">General</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Reading Mode</label>
            <div className="setting-options setting-options-grid">
              {[
                { value: 'ltr',      label: 'Left to Right' },
                { value: 'rtl',      label: 'Right to Left' },
                { value: 'vertical', label: 'Vertical' },
                { value: 'webtoon',  label: 'Webtoon' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${readingMode === value ? ' active' : ''}`}
                  onClick={() => setReadingMode(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Reading Orientation</label>
            <p className="rs-setting-hint">Controls which side the next page appears on in double-page mode.</p>
            <div className="setting-options">
              {[
                { value: 'ltr', label: 'Left to Right' },
                { value: 'rtl', label: 'Right to Left' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${readingOrientation === value ? ' active' : ''}`}
                  onClick={() => setReadingOrientation(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Page Transition</label>
            <p className="rs-setting-hint">Animation played when turning pages in paged modes.</p>
            <div className="setting-options setting-options-grid">
              {[
                { value: 'off',   label: 'Off' },
                { value: 'slide', label: 'Slide' },
                { value: 'fade',  label: 'Fade' },
                { value: 'curl',  label: 'Curl' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${pageAnimation === value ? ' active' : ''}`}
                  onClick={() => setPageAnimation(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Animation Speed</label>
            <p className="rs-setting-hint">
              {pageAnimation === 'off'
                ? 'Choose a transition style above to adjust speed.'
                : 'Multiplier applied to the page-turn animation duration.'}
            </p>
            <div className="setting-slider-row">
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.25}
                value={pageAnimSpeed}
                disabled={pageAnimation === 'off'}
                onChange={e => setPageAnimSpeed(clampAnimSpeed(Number(e.target.value)))}
                className="setting-slider"
              />
              <span className="setting-slider-label">{pageAnimSpeed}×</span>
            </div>
          </div>

          <div className="rs-divider" />

          <ToggleRow
            label="Show edge hints"
            desc="Faint arrows on screen edges show tap zones"
            value={showEdgeHints}
            onChange={setShowEdgeHints}
          />
          <ToggleRow
            label="Gestures"
            desc="Touch swipe, double-tap to zoom"
            value={gesturesEnabled}
            onChange={setGesturesEnabled}
          />
          <ToggleRow
            label="Always Full Screen"
            value={alwaysFullscreen}
            onChange={setAlwaysFullscreen}
          />
          <ToggleRow
            label="Preload upcoming pages"
            desc="Fetch the next pages in the background so taps feel instant. Skipped automatically on metered (Save-Data) connections."
            value={prefetchPages}
            onChange={setPrefetchPages}
          />

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Reset reader hints</label>
            <p className="rs-setting-hint">
              Replays the one-time edge-hint pulse the next time you open a chapter.
            </p>
            <button className="btn" onClick={handleResetHints} style={{ alignSelf: 'flex-start' }}>
              Reset hints
            </button>
            {resetHintsMsg && (
              <p className="rs-setting-hint" style={{ marginTop: 8, color: 'var(--accent, #4caf50)' }}>
                {resetHintsMsg}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Display */}
      <div className="rs-group">
        <p className="rs-group-title">Display</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Background Color</label>
            <div className="setting-options">
              {[
                { value: 'black', label: 'Black' },
                { value: 'gray',  label: 'Gray' },
                { value: 'white', label: 'White' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn setting-btn-color setting-btn-color-${value}${bgColor === value ? ' active' : ''}`}
                  onClick={() => setBgColor(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <ToggleRow
            label="Grayscale"
            desc="Render pages without color"
            value={grayscale}
            onChange={setGrayscale}
          />
        </div>
      </div>

      {/* Paged Mode */}
      <div className="rs-group">
        <p className="rs-group-title">Paged Mode</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Scale Type</label>
            <select
              className="setting-select"
              value={scaleType}
              onChange={e => setScaleType(e.target.value)}
            >
              <option value="screen">Screen</option>
              <option value="fit-width">Fit Width</option>
              <option value="fit-width-shrink">Fit Width (Shrink Only)</option>
              <option value="fit-height">Fit Height</option>
              <option value="original">Original</option>
            </select>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Page Layout</label>
            <select
              className="setting-select"
              value={pageLayout}
              onChange={e => setPageLayout(e.target.value)}
            >
              <option value="single">Single Page</option>
              <option value="double">Double Page</option>
              <option value="double-manga">Double Page (Manga)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section: Database Management ─────────────────────────────────────────────

const GB = 1024 * 1024 * 1024;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatNextRun(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      weekday: 'short',
      month:   'short',
      day:     'numeric',
      hour:    '2-digit',
      minute:  '2-digit',
    });
  } catch {
    return null;
  }
}

function DatabaseSection() {
  const [cacheSize, setCacheSize] = useState(null);   // bytes | null = loading

  // Cache settings (limit + auto-clear schedule)
  const [cacheSettings, setCacheSettings] = useState(null);
  const [limitGbInput, setLimitGbInput]   = useState('');
  const [autoMode, setAutoMode]           = useState('off');
  const [autoDay, setAutoDay]             = useState(0);
  const [autoTime, setAutoTime]           = useState('03:00');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg]     = useState(null); // { type, text }

  const [importStatus, setImportStatus] = useState('idle'); // 'idle' | 'loading' | 'done' | 'error'
  const [importResult, setImportResult] = useState(null);   // { counts, warnings, total_warnings }
  const [importError, setImportError]   = useState(null);
  const importFileRef = useRef(null);

  // ── Long-running admin tasks ────────────────────────────────────────────────
  // Each wraps the new Phase 2 endpoint pair (POST + GET status). The hook
  // handles polling, elapsed-time display, badge state, and 409-adopt-on-
  // duplicate-click. Result formatters render the per-task success message.

  const refreshCacheSize = useCallback(() => {
    api.getCbzCacheSize().then(d => setCacheSize(d.size_bytes)).catch(() => {});
  }, []);

  const clearCacheTask = useAdminTaskButton({
    startUrl:     '/api/admin/clear-cbz-cache',
    statusUrl:    '/api/admin/clear-cbz-cache/status',
    idleLabel:    'Clear Cache',
    runningLabel: 'Clearing',
    formatResult: r => r && r.freed_bytes
      ? `Cleared — freed ${fmtMB(r.freed_bytes)}`
      : 'Cleared',
    onDone:       refreshCacheSize,
    disabled:     cacheSize === null,
  });

  const regenTask = useAdminTaskButton({
    startUrl:     '/api/admin/regenerate-thumbnails',
    statusUrl:    '/api/admin/regenerate-thumbnails/status',
    idleLabel:    'Regenerate All',
    runningLabel: 'Regenerating',
    formatResult: r => r
      ? `Regenerated ${(r.regenerated || 0).toLocaleString()} of ${(r.total || 0).toLocaleString()}` +
        (r.errors ? `, ${r.errors} errors` : '')
      : 'Done',
  });

  const resetThumbsTask = useAdminTaskButton({
    startUrl:     '/api/admin/reset-thumbnails',
    statusUrl:    '/api/admin/reset-thumbnails/status',
    idleLabel:    'Reset Thumbnails',
    runningLabel: 'Resetting',
    formatResult: r => r
      ? `Reset: ${r.changed_to_anilist} → AniList, ${r.changed_to_mal} → MAL, ` +
        `${r.changed_to_mu} → MangaUpdates, ${r.changed_to_doujinshi} → Doujinshi, ` +
        `${r.changed_to_original} → original` +
        (r.kept_no_source ? `; ${r.kept_no_source} had no source on disk` : '') +
        (r.errors ? `; ${r.errors} errors` : '') +
        ` (${r.total} total)`
      : 'Done',
    confirmMessage:
      'Reset all thumbnails to their priority-default cover?\n\n' +
      'This will overwrite every manually-picked cover and re-align all manga to:\n' +
      'AniList → MyAnimeList → MangaUpdates → Doujinshi.info → original scan.\n\n' +
      'No upstream is contacted — only existing source-specific cover files are used.',
  });

  const vacuumTask = useAdminTaskButton({
    startUrl:     '/api/admin/vacuum-db',
    statusUrl:    '/api/admin/vacuum-db/status',
    idleLabel:    'Compact Database',
    runningLabel: 'Compacting',
    formatResult: r => r
      ? `Compacted: ${fmtMB(r.size_before_bytes)} → ${fmtMB(r.size_after_bytes)}`
      : 'Done',
  });

  useEffect(() => {
    api.getCbzCacheSize()
      .then(d => setCacheSize(d.size_bytes))
      .catch(() => setCacheSize(0));

    api.getCbzCacheSettings()
      .then(d => {
        setCacheSettings(d);
        setLimitGbInput((d.limit_bytes / GB).toFixed(1).replace(/\.0$/, ''));
        setAutoMode(d.autoclear_mode);
        setAutoDay(d.autoclear_day);
        setAutoTime(d.autoclear_time);
      })
      .catch(() => {});
  }, []);

  async function handleSaveCacheSettings() {
    setSettingsMsg(null);

    const gb = Number(limitGbInput);
    if (!Number.isFinite(gb) || gb < 0.1) {
      setSettingsMsg({ type: 'error', text: 'Cache size must be at least 0.1 GB (100 MB).' });
      return;
    }

    const limitBytes = Math.floor(gb * GB);

    setSavingSettings(true);
    try {
      const updated = await api.saveCbzCacheSettings({
        limit_bytes:    limitBytes,
        autoclear_mode: autoMode,
        autoclear_day:  autoDay,
        autoclear_time: autoTime,
      });
      setCacheSettings(updated);
      // Re-sync the input in case the server canonicalized anything.
      setLimitGbInput((updated.limit_bytes / GB).toFixed(1).replace(/\.0$/, ''));
      setAutoMode(updated.autoclear_mode);
      setAutoDay(updated.autoclear_day);
      setAutoTime(updated.autoclear_time);
      // Current cache may have been trimmed if the new cap is lower.
      api.getCbzCacheSize().then(d => setCacheSize(d.size_bytes)).catch(() => {});
      setSettingsMsg({ type: 'success', text: 'Cache settings saved.' });
    } catch (err) {
      setSettingsMsg({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setSavingSettings(false);
    }
  }

  function fmtMB(bytes) {
    if (bytes === null) return '…';
    if (bytes === 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return mb < 0.1 ? '<0.1 MB' : `${mb.toFixed(1)} MB`;
  }

  function handleExportConfig() {
    // Straight browser download — the server emits a Content-Disposition
    // header so the filename is momotaro-config-<timestamp>.json.
    window.location.href = api.exportConfigUrl();
  }

  function handleExportSeriesList() {
    // Straight browser download — the server emits a Content-Disposition
    // header so the filename is momotaro-series-list-<YYYY-MM-DD>.csv.
    window.location.href = api.exportSeriesListUrl();
  }

  function triggerImportPicker() {
    setImportError(null);
    setImportResult(null);
    importFileRef.current?.click();
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    // Clear the input so the same file can be re-selected after an error.
    e.target.value = '';
    if (!file) return;

    let payload;
    try {
      const text = await file.text();
      payload = JSON.parse(text);
    } catch (err) {
      setImportError('Could not parse JSON: ' + err.message);
      setImportStatus('error');
      return;
    }

    if (payload?.app !== 'momotaro') {
      setImportError('File is not a Momotaro config export.');
      setImportStatus('error');
      return;
    }

    const confirmed = window.confirm(
      'Import this configuration?\n\n' +
      'This will overwrite settings, API keys, reading lists, reading progress, ' +
      'and saved art gallery entries in the current database. ' +
      'Manga metadata (AniList/MAL links, etc.) will be reapplied where the ' +
      'scanner has already indexed the matching manga.\n\n' +
      'This cannot be undone.'
    );
    if (!confirmed) return;

    setImportStatus('loading');
    setImportError(null);
    setImportResult(null);
    try {
      const result = await api.importConfig(payload);
      setImportResult(result);
      setImportStatus('done');
      // Refresh the CBZ cache stats + settings since they may have been
      // overwritten by the import.
      api.getCbzCacheSize().then(d => setCacheSize(d.size_bytes)).catch(() => {});
      api.getCbzCacheSettings().then(d => {
        setCacheSettings(d);
        setLimitGbInput((d.limit_bytes / GB).toFixed(1).replace(/\.0$/, ''));
        setAutoMode(d.autoclear_mode);
        setAutoDay(d.autoclear_day);
        setAutoTime(d.autoclear_time);
      }).catch(() => {});
    } catch (err) {
      setImportError(err.message);
      setImportStatus('error');
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Database Management</h2>
          <p className="sp-section-desc">
            Tools for maintaining Momotaro's database and on-disk cache.
          </p>
        </div>
      </div>

      {/* CBZ Cache */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">CBZ Cache</p>
            <p className="db-op-desc">
              Pages from CBZ archives are extracted to disk the first time they are read and
              cached for faster subsequent access. The cache is safe to clear at any time —
              pages will be re-extracted from the original files on next access.
            </p>
            <p className="db-op-status">
              Current size: <strong>{fmtMB(cacheSize)}</strong>
              {cacheSettings && (
                <> &nbsp;/&nbsp; Limit: <strong>{(cacheSettings.limit_bytes / GB).toFixed(1)} GB</strong></>
              )}
            </p>
            {clearCacheTask.badge}
          </div>
          {clearCacheTask.button}
        </div>

        {/* Cache limit + auto-clear schedule */}
        {cacheSettings && (
          <>
            <div className="rs-divider" style={{ margin: '16px 0' }} />

            <div className="setting-group">
              <label className="setting-group-label">Maximum cache size</label>
              <p className="rs-setting-hint">
                When the cache reaches this size it auto-clears — every cached chapter is wiped
                except the one that just triggered the overflow, so in-flight reads and batch
                operations (like Regenerate Thumbnails) keep making progress. Minimum 0.1 GB.
                Default is 20 GB.
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 280 }}>
                <input
                  type="number"
                  className="settings-input"
                  min="0.1"
                  step="0.1"
                  value={limitGbInput}
                  onChange={e => setLimitGbInput(e.target.value)}
                  style={{ flex: 1 }}
                />
                <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>GB</span>
              </div>
            </div>

            <div className="rs-divider" style={{ margin: '16px 0' }} />

            <div className="setting-group">
              <label className="setting-group-label">Auto-clear schedule</label>
              <p className="rs-setting-hint">
                Wipe the cache automatically on a schedule. Clearing removes every extracted
                chapter — pages are re-extracted on next read.
              </p>
              <div className="setting-options">
                {[
                  { value: 'off',    label: 'Off'    },
                  { value: 'daily',  label: 'Daily'  },
                  { value: 'weekly', label: 'Weekly' },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    className={`setting-btn${autoMode === value ? ' active' : ''}`}
                    onClick={() => setAutoMode(value)}
                  >{label}</button>
                ))}
              </div>
            </div>

            {autoMode === 'weekly' && (
              <div className="setting-group" style={{ marginTop: 12 }}>
                <label className="setting-group-label">Day of week</label>
                <select
                  className="setting-select"
                  value={autoDay}
                  onChange={e => setAutoDay(parseInt(e.target.value, 10))}
                >
                  {DAY_NAMES.map((name, i) => (
                    <option key={i} value={i}>{name}</option>
                  ))}
                </select>
              </div>
            )}

            {autoMode !== 'off' && (
              <div className="setting-group" style={{ marginTop: 12 }}>
                <label className="setting-group-label">Time of day (server local)</label>
                <input
                  type="time"
                  className="settings-input"
                  value={autoTime}
                  onChange={e => setAutoTime(e.target.value)}
                  style={{ maxWidth: 160 }}
                />
              </div>
            )}

            {autoMode !== 'off' && cacheSettings.next_run_at && (
              <p className="db-op-status" style={{ marginTop: 12 }}>
                Next auto-clear: <strong>{formatNextRun(cacheSettings.next_run_at) || cacheSettings.next_run_at}</strong>
              </p>
            )}

            {settingsMsg && (
              <p
                className={`db-op-status ${settingsMsg.type === 'success' ? 'db-op-status-ok' : 'db-op-status-err'}`}
                style={{ marginTop: 12 }}
              >
                {settingsMsg.text}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSaveCacheSettings}
                disabled={savingSettings}
              >
                {savingSettings ? 'Saving…' : 'Save Cache Settings'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Regenerate Thumbnails */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">Regenerate Thumbnails</p>
            <p className="db-op-desc">
              Rebuilds cover thumbnails for every manga in the library. Useful when thumbnails
              become mismatched after manga are added or removed. If AniList metadata has been
              pulled for a title, its AniList cover is restored as the active thumbnail.
              Otherwise, a new thumbnail is generated from the first page of the first chapter.
            </p>
            {regenTask.badge}
          </div>
          {regenTask.button}
        </div>
      </div>

      {/* Reset Thumbnails */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">Reset Thumbnails</p>
            <p className="db-op-desc">
              Re-aligns every manga's cover to the priority order
              <strong> AniList → MyAnimeList → MangaUpdates → Doujinshi.info → original scan</strong>.
              Manually-picked covers are <strong>overridden</strong>. No upstream is contacted —
              this only re-uses cover files already on disk from earlier metadata fetches.
              The same priority pass also runs automatically at the end of every library scan.
            </p>
            {resetThumbsTask.badge}
          </div>
          {resetThumbsTask.button}
        </div>
      </div>

      {/* Configuration Backup */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">Configuration Backup</p>
            <p className="db-op-desc">
              Download a single JSON file containing your API keys, libraries, reading lists,
              reading progress and history, saved art gallery entries, applied manga metadata
              (AniList / MAL / Doujinshi links), and cache settings. Import the file on a fresh
              install to restore your setup without needing to re-pull metadata or re-save
              progress. For a full restore, mount the same library folder paths before importing.
            </p>
            {importStatus === 'done' && importResult && (
              <p className="db-op-status db-op-status-ok">
                Imported:{' '}
                {importResult.counts.settings} settings,{' '}
                {importResult.counts.libraries} libraries,{' '}
                {importResult.counts.manga_metadata} manga,{' '}
                {importResult.counts.reading_lists} lists,{' '}
                {importResult.counts.reading_list_manga} memberships,{' '}
                {importResult.counts.progress} progress,{' '}
                {importResult.counts.art_gallery} gallery.
                {importResult.total_warnings > 0 && (
                  <> &nbsp;({importResult.total_warnings} warning{importResult.total_warnings === 1 ? '' : 's'})</>
                )}
              </p>
            )}
            {importStatus === 'error' && importError && (
              <p className="db-op-status db-op-status-err">Import failed: {importError}</p>
            )}
            {importResult?.warnings?.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Show warnings ({importResult.warnings.length}
                  {importResult.warnings_truncated ? ` of ${importResult.total_warnings}` : ''})
                </summary>
                <ul style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0 20px' }}>
                  {importResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </details>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignSelf: 'flex-start' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleExportConfig}
            >
              Export
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={triggerImportPicker}
              disabled={importStatus === 'loading'}
            >
              {importStatus === 'loading' ? 'Importing…' : 'Import'}
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </div>
        </div>
      </div>

      {/* Series List Export */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">Export Series List</p>
            <p className="db-op-desc">
              Download a CSV with one row per series, listing the title as known
              by each third-party source (AniList, MyAnimeList, MangaUpdates,
              Doujinshi.info) alongside the folder path, chapter / volume
              counts, and author. Useful for spot-checking that titles are
              matched to the right series at each source. Per-source titles are
              read from the on-disk metadata cache — if a source column is
              empty for a linked manga, refresh that source from the manga's
              detail page to repopulate it.
            </p>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ flexShrink: 0, alignSelf: 'flex-start' }}
            onClick={handleExportSeriesList}
          >
            Export Series List
          </button>
        </div>
      </div>

      {/* Compact Database */}
      <div className="settings-card">
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">Compact Database</p>
            <p className="db-op-desc">
              Defragments the SQLite database file and reclaims disk space left over from
              deleted records. Safe to run at any time — most useful after removing a large
              number of manga or chapters.
            </p>
            {vacuumTask.badge}
          </div>
          {vacuumTask.button}
        </div>
      </div>
    </div>
  );
}

// ── Section: Scheduling ───────────────────────────────────────────────────────
//
// One row per scheduled manga, with the recorded source URLs inline so the
// user can see what each schedule will check. Add / edit / delete is done in
// place — same shape as the per-manga editor on MangaDetail, just without
// the URL-management surface (URLs continue to be edited from MangaDetail's
// Third Party Sources modal, since adding a URL needs the per-manga
// search/auto-record flow there).

const SCHED_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatScheduleSummary(s) {
  if (!s.frequency || !s.time_of_day) return '—';
  if (s.frequency === 'daily')  return `Daily at ${s.time_of_day}`;
  if (s.frequency === 'weekly') return `Weekly on ${SCHED_DAY_NAMES[s.day_of_week] || '?'} at ${s.time_of_day}`;
  return s.frequency;
}

function ScheduleEditForm({ initial, onSave, onCancel, busy }) {
  const [enabled,   setEnabled]   = useState(initial?.enabled !== 0);
  const [frequency, setFrequency] = useState(initial?.frequency   || 'daily');
  const [dayOfWeek, setDayOfWeek] = useState(initial?.day_of_week ?? 0);
  const [timeOfDay, setTimeOfDay] = useState(initial?.time_of_day || '09:00');

  function handleSubmit(e) {
    e.preventDefault();
    onSave({
      enabled,
      frequency,
      time_of_day: timeOfDay,
      day_of_week: frequency === 'weekly' ? dayOfWeek : null,
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Enabled
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Frequency</label>
        <select className="setting-select" value={frequency} onChange={e => setFrequency(e.target.value)} style={{ minWidth: 110 }}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      {frequency === 'weekly' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Day</label>
          <select className="setting-select" value={dayOfWeek} onChange={e => setDayOfWeek(parseInt(e.target.value, 10))} style={{ minWidth: 130 }}>
            {SCHED_DAY_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
          </select>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Time (server local)</label>
        <input className="setting-select" type="time" value={timeOfDay} onChange={e => setTimeOfDay(e.target.value)} style={{ minWidth: 110 }} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ScheduleAddForm({ existingMangaIds, onAdded, onCancel }) {
  const [query, setQuery]     = useState('');
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [pickedManga, setPickedManga] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState(null);

  // Debounced search against the FTS5-backed match-existing endpoint.
  useEffect(() => {
    if (pickedManga) return;
    if (!query.trim()) { setMatches([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.matchExistingManga(query.trim())
        .then(rows => {
          if (cancelled) return;
          // Filter out manga that already have a schedule (the caller passed
          // the set of currently-scheduled IDs).
          setMatches(rows.filter(r => !existingMangaIds.has(r.id)));
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, pickedManga, existingMangaIds]);

  async function handleSave(scheduleBody) {
    if (!pickedManga) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveMangaSchedule(pickedManga.id, scheduleBody);
      onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>Add a schedule</h3>

      {!pickedManga && (
        <>
          <input
            className="setting-select"
            type="text"
            placeholder="Search your library by title…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ width: '100%', maxWidth: 420 }}
            autoFocus
          />
          {searching && <p className="rs-setting-hint" style={{ marginTop: 6 }}>Searching…</p>}
          {!searching && query && matches.length === 0 && (
            <p className="rs-setting-hint" style={{ marginTop: 6 }}>
              No matches in your library{existingMangaIds.size > 0 ? ' (already-scheduled titles are hidden)' : ''}.
            </p>
          )}
          {matches.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {matches.map(m => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setPickedManga(m)}
                  >
                    {m.title}{m.library_name ? ` — ${m.library_name}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}

      {pickedManga && (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Adding schedule for <strong>{pickedManga.title}</strong>{' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPickedManga(null)}
              style={{ marginLeft: 6 }}
            >Pick a different manga</button>
          </p>
          <ScheduleEditForm
            initial={null}
            onSave={handleSave}
            onCancel={onCancel}
            busy={saving}
          />
          {error && <p className="sp-status sp-status-error" style={{ marginTop: 6 }}>{error}</p>}
          <p className="rs-setting-hint" style={{ marginTop: 8 }}>
            URLs to check are managed from this manga's <em>Third Party Sources</em> modal
            (manga detail page → top-bar icon next to Optimize).
          </p>
        </>
      )}
    </div>
  );
}

function ScheduleRow({ schedule, onChange }) {
  const [editing,   setEditing]   = useState(false);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState(null);
  const [running,   setRunning]   = useState(false);
  const [runResult, setRunResult] = useState(null);

  async function handleSave(body) {
    setBusy(true);
    setError(null);
    try {
      await api.saveMangaSchedule(schedule.manga_id, body);
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRunNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const r = await api.runMangaScheduleNow(schedule.manga_id);
      setRunResult(r);
      onChange();
    } catch (err) {
      setRunResult({ ok: false, summary: err.message });
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Remove the schedule for "${schedule.manga.title}"?`)) return;
    try {
      await api.deleteMangaSchedule(schedule.manga_id);
      onChange();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="settings-card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {schedule.manga.cover_url && (
          <img
            src={schedule.manga.cover_url}
            alt=""
            style={{ width: 48, height: 70, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Link to={`/manga/${schedule.manga.id}`} style={{ fontWeight: 600, fontSize: 15 }}>
              {schedule.manga.title}
            </Link>
            <span
              className="sp-status"
              style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 4,
                background: schedule.enabled ? 'var(--accent-dim, rgba(106,166,255,0.18))' : 'var(--bg-elev)',
                color: schedule.enabled ? 'var(--accent, #6aa6ff)' : 'var(--text-muted)',
              }}
            >
              {schedule.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>
            {formatScheduleSummary(schedule)}
            {schedule.next_run_at && schedule.enabled && (
              <> · next: {new Date(schedule.next_run_at * 1000).toLocaleString()}</>
            )}
          </p>
          {schedule.last_checked_at && (
            <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>
              Last run: {new Date(schedule.last_checked_at * 1000).toLocaleString()}
              {schedule.last_result && ` — ${schedule.last_result}`}
            </p>
          )}
        </div>
        {!editing && (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button className="btn btn-ghost btn-sm" onClick={handleRunNow} disabled={running}>
              {running ? 'Checking…' : 'Run now'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-ghost btn-sm" onClick={handleDelete}>Remove</button>
          </div>
        )}
      </div>

      {editing && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <ScheduleEditForm
            initial={schedule}
            onSave={handleSave}
            onCancel={() => { setEditing(false); setError(null); }}
            busy={busy}
          />
          {error && <p className="sp-status sp-status-error" style={{ marginTop: 6 }}>{error}</p>}
        </div>
      )}

      {runResult && (
        <p
          className="rs-setting-hint"
          style={{
            marginTop: 8,
            color: runResult.ok ? 'var(--success, #6c6)' : 'var(--danger, #f55)',
          }}
        >
          {runResult.summary}
          {runResult.enqueued > 0 && ' — see Downloads in Third Party Sourcing.'}
        </p>
      )}

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <div style={{
          fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
          color: 'var(--text-muted)', marginBottom: 6,
        }}>
          URLs that will be checked ({schedule.urls.length})
        </div>
        {schedule.urls.length === 0 && (
          <p className="rs-setting-hint" style={{ margin: 0 }}>
            No URLs recorded — the schedule will run but find nothing to check.
            Add a URL from the manga's <em>Third Party Sources</em> modal.
          </p>
        )}
        {schedule.urls.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {schedule.urls.map(u => (
              <li key={u.id} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{
                  fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
                  color: 'var(--text-muted)', minWidth: 70,
                }}>
                  {u.source}
                </span>
                <a href={u.url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                  {u.url}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SchedulingSection() {
  const [schedules, setSchedules] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [adding,    setAdding]    = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    api.listSchedules()
      .then(setSchedules)
      .catch(err => setLoadError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const existingMangaIds = new Set((schedules || []).map(s => s.manga_id));

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Scheduling</h2>
          <p className="sp-section-desc">
            Auto-checks for new chapters from the third-party sources you've
            linked to each manga. Schedules fire on the server at the time
            shown (server local time); the poll cadence is one minute, so
            real fire time is the configured minute give or take 60 seconds.
          </p>
        </div>
        {!adding && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            Add schedule
          </button>
        )}
      </div>

      {loadError && (
        <div className="sp-status sp-status-error">Failed to load schedules: {loadError}</div>
      )}

      {adding && (
        <ScheduleAddForm
          existingMangaIds={existingMangaIds}
          onAdded={() => { setAdding(false); load(); }}
          onCancel={() => setAdding(false)}
        />
      )}

      {schedules === null && !loadError && (
        <div className="loading-center" style={{ minHeight: 100 }}><div className="spinner" /></div>
      )}

      {schedules && schedules.length === 0 && !adding && (
        <div className="settings-card">
          <p className="settings-hint" style={{ margin: 0 }}>
            No schedules yet. Click <strong>Add schedule</strong>, or open a
            manga and use the <em>Third Party Sources</em> button in the top
            bar to set one up there.
          </p>
        </div>
      )}

      {schedules && schedules.length > 0 && (
        <>
          <p className="rs-setting-hint" style={{ marginBottom: 10 }}>
            {schedules.length} scheduled {schedules.length === 1 ? 'manga' : 'manga'}.
          </p>
          {schedules.map(s => (
            <ScheduleRow key={s.id} schedule={s} onChange={load} />
          ))}
        </>
      )}
    </div>
  );
}

// ── Section: Third Party Sourcing ─────────────────────────────────────────────
//
// Exposes the two knobs the in-process download queue reads: how many
// chapters can run concurrently, and how long to sleep between page fetches
// inside one chapter. Both are saved server-side; the queue hot-reloads.

function ThirdPartySourcingSection() {
  const [concurrency, setConcurrency] = useState(1);
  const [pageDelay,   setPageDelay]   = useState(500);
  const [savedFlash,  setSavedFlash]  = useState(null);
  const [error,       setError]       = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [loaded,      setLoaded]      = useState(false);

  useEffect(() => {
    api.getSettings().then(s => {
      if (s.tps_max_concurrent_chapters !== undefined) {
        setConcurrency(s.tps_max_concurrent_chapters);
      }
      if (s.tps_page_delay_ms !== undefined) {
        setPageDelay(s.tps_page_delay_ms);
      }
      setLoaded(true);
    }).catch(err => setError(err.message));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedFlash(null);
    try {
      await api.saveSettings({
        tps_max_concurrent_chapters: concurrency,
        tps_page_delay_ms:           pageDelay,
      });
      setSavedFlash('Saved.');
      setTimeout(() => setSavedFlash(null), 1800);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Third Party Sourcing</h2>
          <p className="sp-section-desc">
            Tunes the in-app downloader that fetches chapters from MangaDex (and
            future sources). Defaults are intentionally polite to avoid getting
            rate-limited; raise them only if you've checked the source's terms.
          </p>
        </div>
      </div>

      {!loaded && (
        <div className="loading-center" style={{ minHeight: 80 }}><div className="spinner" /></div>
      )}

      {loaded && (
        <>
          <div className="settings-card" style={{ marginBottom: 16 }}>
            <div className="setting-group">
              <label className="setting-group-label" htmlFor="tps-concurrency">
                Concurrent chapters
              </label>
              <p className="rs-setting-hint">
                How many chapters the downloader works on at the same time.
                Conservative default is <strong>1</strong> — increase if you're
                downloading large backlogs and your network can handle it.
              </p>
              <input
                id="tps-concurrency"
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={e => setConcurrency(parseInt(e.target.value, 10) || 1)}
                className="setting-select"
                style={{ maxWidth: 120 }}
              />
            </div>
          </div>

          <div className="settings-card" style={{ marginBottom: 16 }}>
            <div className="setting-group">
              <label className="setting-group-label" htmlFor="tps-page-delay">
                Delay between page requests (ms)
              </label>
              <p className="rs-setting-hint">
                Pause inserted between consecutive image fetches inside a single
                chapter. <strong>500&nbsp;ms</strong> is a polite default for
                MangaDex@Home. Set to <code>0</code> to disable; the upper limit
                is <code>60000</code>.
              </p>
              <input
                id="tps-page-delay"
                type="number"
                min={0}
                max={60_000}
                step={50}
                value={pageDelay}
                onChange={e => setPageDelay(parseInt(e.target.value, 10) || 0)}
                className="setting-select"
                style={{ maxWidth: 160 }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {savedFlash && <span className="sp-status sp-status-ok">{savedFlash}</span>}
            {error      && <span className="sp-status sp-status-error">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Section: System Logs ──────────────────────────────────────────────────────

function SystemLogsSection() {
  const [entries, setEntries] = useState(null);
  const [max, setMax] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSystemLogs();
      setEntries(data.entries || []);
      setMax(data.max);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function handleExport() {
    window.location.href = api.systemLogsExportUrl();
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">System Logs</h2>
          <p className="sp-section-desc">
            Recent server console output. The server keeps the last
            {max ? ` ${max.toLocaleString()} ` : ' '}
            log lines in memory — older entries are discarded. Export to save a
            snapshot to a <code>.txt</code> file.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleExport}
            disabled={!entries || entries.length === 0}
          >
            Export as .txt
          </button>
        </div>
      </div>

      {error && (
        <div className="sp-status sp-status-error">Failed to load logs: {error}</div>
      )}

      {entries === null ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : entries.length === 0 ? (
        <div className="settings-card">
          <p className="settings-hint" style={{ margin: 0 }}>No log entries captured yet.</p>
        </div>
      ) : (
        <div className="logs-viewer">
          {entries.map((e, i) => (
            <div key={i} className={`logs-line logs-line-${e.level}`}>
              <span className="logs-ts">{e.ts}</span>
              <span className={`logs-level logs-level-${e.level}`}>{e.level.toUpperCase()}</span>
              <span className="logs-msg">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section: Statistics ───────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatReadTime(minutes) {
  if (!minutes) return '0 min';
  if (minutes < 60) return `${minutes} min`;
  const h = (minutes / 60).toFixed(1);
  return `${h} hr${h === '1.0' ? '' : 's'}`;
}

const STAT_TILES = [
  {
    key: 'total_manga',
    label: 'Total Series',
    unit: 'Series',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
  },
  {
    key: 'total_chapters',
    label: 'Total Chapters',
    unit: 'Chapters',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    key: 'total_size_bytes',
    label: 'Total Size',
    unit: null,
    format: formatBytes,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    ),
  },
  {
    key: 'total_genres',
    label: 'Total Genres',
    unit: 'Genres',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
      </svg>
    ),
  },
  {
    key: 'estimated_read_time_minutes',
    label: 'Est. Read Time',
    unit: null,
    format: formatReadTime,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </svg>
    ),
  },
];

function StatisticsSection() {
  const [libraries, setLibraries] = useState(null);
  // null = All Libraries; otherwise a numeric library ID.
  const [selectedLib, setSelectedLib] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.getLibraries().then(data => setLibraries(data)).catch(() => setLibraries([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(false);
    api.getStats(selectedLib)
      .then(data => { setStats(data); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, [selectedLib]);

  // Show the switcher only when more than one library exists — with a single
  // library the All / Lib-A distinction is redundant.
  const showSwitcher = libraries && libraries.length > 1;

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Statistics</h2>
          <p className="sp-section-desc">An overview of your manga library.</p>
        </div>
      </div>

      {showSwitcher && (
        <div className="setting-options" style={{ flexWrap: 'wrap', marginBottom: 20 }}>
          <button
            className={`setting-btn${selectedLib === null ? ' active' : ''}`}
            onClick={() => setSelectedLib(null)}
          >
            All Libraries
          </button>
          {libraries.map(lib => (
            <button
              key={lib.id}
              className={`setting-btn${selectedLib === lib.id ? ' active' : ''}`}
              onClick={() => setSelectedLib(lib.id)}
              title={lib.path}
            >
              {lib.name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : error ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Failed to load statistics.</p>
      ) : (
        <>
          {/* ── Stat tiles ── */}
          <div className="stat-tiles">
            {STAT_TILES.map(tile => {
              const raw = stats[tile.key];
              const display = tile.format ? tile.format(raw) : `${(raw ?? 0).toLocaleString()}`;
              const valueLabel = tile.unit ? `${display} ${tile.unit}` : display;
              return (
                <div key={tile.key} className="stat-tile">
                  <span className="stat-tile-label">{tile.label}</span>
                  <span className="stat-tile-icon">{tile.icon}</span>
                  <span className="stat-tile-value">{valueLabel}</span>
                </div>
              );
            })}
          </div>

          {/* ── Ranked lists ── */}
          <div className="stat-grid">
            {/* Popular Series */}
            <div className="stat-list-box">
              <div className="stat-list-header">
                <span className="stat-list-title">Popular Series</span>
                <span className="stat-list-col-label">Read</span>
              </div>
              {stats.top_manga.length === 0 ? (
                <p className="stat-list-empty">No reading history yet.</p>
              ) : stats.top_manga.map((m, i) => (
                <div key={m.id} className="stat-list-item">
                  <span className="stat-list-rank">{i + 1}</span>
                  <span className={`stat-list-bar${i > 0 ? ' dim' : ''}`} />
                  {m.cover_url && (
                    <img className="stat-list-thumb" src={m.cover_url} alt="" />
                  )}
                  <span className="stat-list-name">{m.title}</span>
                  <span className="stat-list-count">
                    {m.chapters_read > 0 ? `${m.chapters_read} ch` : '—'}
                  </span>
                </div>
              ))}
            </div>

            {/* Popular Genres */}
            <div className="stat-list-box">
              <div className="stat-list-header">
                <span className="stat-list-title">Popular Genres</span>
                <span className="stat-list-col-label">Series</span>
              </div>
              {stats.top_genres.length === 0 ? (
                <p className="stat-list-empty">No genre data found.</p>
              ) : stats.top_genres.map((g, i) => (
                <div key={g.genre} className="stat-list-item">
                  <span className="stat-list-rank">{i + 1}</span>
                  <span className={`stat-list-bar${i > 0 ? ' dim' : ''}`} />
                  <span className="stat-list-name">{g.genre}</span>
                  <span className="stat-list-count">{g.count}</span>
                </div>
              ))}
            </div>

            {/* Favorite Genres — weighted by chapters read */}
            <div className="stat-list-box">
              <div className="stat-list-header">
                <span className="stat-list-title">Favorite Genres</span>
                <span className="stat-list-col-label">Chapters Read</span>
              </div>
              {stats.favorite_genres?.length ? (
                stats.favorite_genres.map((g, i) => (
                  <div key={g.genre} className="stat-list-item">
                    <span className="stat-list-rank">{i + 1}</span>
                    <span className={`stat-list-bar${i > 0 ? ' dim' : ''}`} />
                    <span className="stat-list-name">{g.genre}</span>
                    <span className="stat-list-count">{g.chapters_read}</span>
                  </div>
                ))
              ) : (
                <p className="stat-list-empty">
                  Read some chapters to rank your favourite genres.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Section: Client Management ────────────────────────────────────────────────
// Backed by the Phase 1 pairing + admin-auth API. Three discrete states:
//
//   1. Admin password not yet set → show first-run setup form
//   2. Password set but no valid admin session → show login form
//   3. Authenticated → show the management UI (pending pairings, paired
//      clients list, security toggles, change password)
//
// Pending-pairings list polls every 2 s while visible. Polling stops on
// unmount (cleanup) and pauses while a network request is in flight, so a
// slow API or tab-throttled timer can't stack overlapping fetches.

function formatRelativeTime(unixSec) {
  if (!unixSec) return 'never';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diff < 60)       return 'just now';
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatCountdown(expiresUnix) {
  const remaining = Math.max(0, expiresUnix - Math.floor(Date.now() / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ClientManagementSection() {
  const [authStatus, setAuthStatus] = useState(null); // null = loading
  const [statusMsg, setStatusMsg] = useState(null);

  const refreshAuthStatus = useCallback(async () => {
    try {
      const data = await api.getAuthStatus();
      setAuthStatus(data);
    } catch (err) {
      setAuthStatus({ configured: false, logged_in: false, auth_enabled: false, lan_bypass_enabled: false });
    }
  }, []);

  useEffect(() => { refreshAuthStatus(); }, [refreshAuthStatus]);

  if (authStatus === null) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Client Management</h2>
          <p className="sp-section-desc">
            Pair external devices with this server using a one-time PIN and
            revoke access at any time. When auth enforcement is turned on,
            paired clients (or LAN devices, if you allow LAN bypass) are the
            only ones that can read your library.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      {!authStatus.configured && (
        <AdminSetupForm
          onDone={(msg) => { setStatusMsg(msg); refreshAuthStatus(); }}
        />
      )}

      {authStatus.configured && !authStatus.logged_in && (
        <AdminLoginForm
          onDone={(msg) => { setStatusMsg(msg); refreshAuthStatus(); }}
        />
      )}

      {authStatus.configured && authStatus.logged_in && (
        <ClientManagementAuthed
          authStatus={authStatus}
          onAuthChange={refreshAuthStatus}
          setStatusMsg={setStatusMsg}
        />
      )}
    </div>
  );
}

function AdminSetupForm({ onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (pw !== pw2)    { setError('Passwords do not match.'); return; }
    setSaving(true);
    try {
      await api.adminSetup(pw);
      onDone({ type: 'success', text: 'Admin account created.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card">
      <p className="cm-block-title">Create admin password</p>
      <p className="settings-hint" style={{ marginBottom: 14 }}>
        This password unlocks Client Management and any future security
        settings. There is only one admin account per server — keep this
        password safe; there is no recovery option.
      </p>
      <form className="settings-token-form" onSubmit={handleSubmit}>
        <label className="settings-label">Password</label>
        <input
          type="password"
          className="settings-input"
          value={pw}
          onChange={e => setPw(e.target.value)}
          autoComplete="new-password"
          autoFocus
        />
        <label className="settings-label" style={{ marginTop: 8 }}>Confirm password</label>
        <input
          type="password"
          className="settings-input"
          value={pw2}
          onChange={e => setPw2(e.target.value)}
          autoComplete="new-password"
        />
        {error && <p className="lp-form-error" style={{ marginTop: 8 }}>{error}</p>}
        <div className="settings-token-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !pw || !pw2}>
            {saving ? 'Creating...' : 'Create admin password'}
          </button>
        </div>
      </form>
    </div>
  );
}

function AdminLoginForm({ onDone }) {
  const [pw, setPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.adminLogin(pw);
      onDone({ type: 'success', text: 'Logged in.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card">
      <p className="cm-block-title">Admin login</p>
      <form className="settings-token-form" onSubmit={handleSubmit}>
        <label className="settings-label">Password</label>
        <input
          type="password"
          className="settings-input"
          value={pw}
          onChange={e => setPw(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />
        {error && <p className="lp-form-error" style={{ marginTop: 8 }}>{error}</p>}
        <div className="settings-token-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !pw}>
            {saving ? 'Logging in...' : 'Log in'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ClientManagementAuthed({ authStatus, onAuthChange, setStatusMsg }) {
  const [pending, setPending] = useState([]);
  const [clients, setClients] = useState([]);
  const [now, setNow]         = useState(() => Math.floor(Date.now() / 1000));
  const [savingToggle, setSavingToggle] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [pinSettings, setPinSettings] = useState(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [p, c, ps] = await Promise.all([
        api.listPendingPairings().catch(() => []),
        api.listPairedClients().catch(() => []),
        api.getPairingPinSettings().catch(() => null),
      ]);
      setPending(Array.isArray(p) ? p : []);
      setClients(Array.isArray(c) ? c : []);
      if (ps) setPinSettings(ps);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 2000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [refresh]);

  async function handleCancelPending(id) {
    try {
      await api.cancelPendingPairing(id);
      setPending(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Cancel failed: ' + err.message });
    }
  }

  async function handleRevoke(id, deviceName) {
    if (!confirm(`Revoke access for "${deviceName}"? They will be signed out immediately.`)) return;
    try {
      await api.revokePairedClient(id);
      setClients(prev => prev.map(c => c.id === id ? { ...c, revoked: 1 } : c));
      setStatusMsg({ type: 'success', text: `Revoked "${deviceName}".` });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Revoke failed: ' + err.message });
    }
  }

  async function handleToggle(key, next) {
    setSavingToggle(true);
    try {
      await api.saveSecuritySettings({ [key]: next });
      onAuthChange();
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSavingToggle(false);
    }
  }

  async function handleLogout() {
    if (!confirm('Sign out of admin? Your saved password still works for next time.')) return;
    try {
      await api.adminLogout();
      onAuthChange();
      setStatusMsg({ type: 'success', text: 'Signed out.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Sign-out failed: ' + err.message });
    }
  }

  const activeClients  = clients.filter(c => !c.revoked);
  const revokedClients = clients.filter(c =>  c.revoked);

  return (
    <>
      {/* ── Security toggles ────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">Security</p>

        {!authStatus.auth_enabled && (
          <div className="cm-warning">
            Authentication is currently <strong>off</strong>. Anyone who can
            reach this server can read your library. Turn it on once you have
            paired at least one device — otherwise you may lock yourself out.
          </div>
        )}

        {authStatus.auth_enabled
          && typeof window !== 'undefined'
          && window.location.protocol === 'http:' && (
          <div className="cm-warning">
            Authentication is on, but this server is being served over plain
            HTTP. Tokens are sent in the <code>Authorization</code> header in
            cleartext — fine on a trusted LAN, dangerous over the open
            internet. Front Momotaro with a TLS-terminating reverse proxy
            (Caddy, nginx, Cloudflare Tunnel) before exposing the port.
          </div>
        )}

        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Require authentication on all API requests</div>
            <div className="cm-toggle-help">
              When on, every request must present a paired-client token, an
              admin session, or come from a LAN address (if LAN bypass is on).
            </div>
          </div>
          <button
            className={`toggle-switch ${authStatus.auth_enabled ? 'on' : ''}`}
            onClick={() => handleToggle('auth_enabled', !authStatus.auth_enabled)}
            role="switch"
            aria-checked={!!authStatus.auth_enabled}
            disabled={savingToggle}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Allow LAN devices to skip pairing</div>
            <div className="cm-toggle-help">
              Devices on your home network (RFC1918 / loopback) connect
              without a token. Turn this off if you're on an untrusted LAN
              (e.g. shared office Wi-Fi).
            </div>
          </div>
          <button
            className={`toggle-switch ${authStatus.lan_bypass_enabled ? 'on' : ''}`}
            onClick={() => handleToggle('lan_bypass_enabled', !authStatus.lan_bypass_enabled)}
            role="switch"
            aria-checked={!!authStatus.lan_bypass_enabled}
            disabled={savingToggle}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <PinLockoutControl
          settings={pinSettings}
          onChanged={() => { refresh(); }}
          setStatusMsg={setStatusMsg}
        />
      </div>

      <div className="cm-divider" />

      {/* ── Pending pairings ────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">
          Pending pairings
          <span className="cm-block-count">{pending.length ? `(${pending.length})` : ''}</span>
        </p>

        {pending.length === 0 ? (
          <div className="cm-empty">
            No devices are waiting to pair. Open the Momotaro app on a new
            device and follow the on-screen instructions — a request will
            show up here automatically.
          </div>
        ) : (
          pending.map(p => (
            <div key={p.id} className="cm-card">
              <div className="cm-card-main">
                <div className="cm-device-name">{p.device_name}</div>
                <div className="cm-device-meta">
                  <span>{p.platform || 'unknown platform'}</span>
                  <span>from {p.ip || 'unknown IP'}</span>
                  {p.attempts > 0 && <span>{p.attempts} wrong attempts</span>}
                </div>
                <div className="cm-pin-row">
                  <span className="cm-pin">{p.pin}</span>
                  <span className="cm-pin-countdown">expires in {formatCountdown(p.expires_at)}</span>
                </div>
                <div className="cm-toggle-help">
                  Read this PIN to whoever is holding the device — they enter
                  it on the device's pairing screen.
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => handleCancelPending(p.id)}>
                Cancel
              </button>
            </div>
          ))
        )}
      </div>

      <div className="cm-divider" />

      {/* ── Paired clients ──────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">
          Paired devices
          <span className="cm-block-count">{activeClients.length ? `(${activeClients.length})` : ''}</span>
        </p>

        {activeClients.length === 0 ? (
          <div className="cm-empty">No paired devices yet.</div>
        ) : (
          activeClients.map(c => (
            <div key={c.id} className="cm-card">
              <div className="cm-card-main">
                <div className="cm-device-name">{c.device_name}</div>
                <div className="cm-device-meta">
                  <span>{c.platform || c.device_type || 'unknown platform'}</span>
                  {c.os && <span>{c.os}</span>}
                  {c.browser && <span>{c.browser}</span>}
                  <span>last seen {formatRelativeTime(c.last_seen_at)}</span>
                  {c.last_seen_ip && <span>from {c.last_seen_ip}</span>}
                  {typeof c.request_count === 'number' && (
                    <span>{c.request_count.toLocaleString()} requests</span>
                  )}
                  {c.first_seen_ip && c.first_seen_ip !== c.last_seen_ip && (
                    <span>first IP {c.first_seen_ip}</span>
                  )}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => handleRevoke(c.id, c.device_name)}
              >
                Revoke
              </button>
            </div>
          ))
        )}

        {revokedClients.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
              {revokedClients.length} revoked device{revokedClients.length === 1 ? '' : 's'}
            </summary>
            <div style={{ marginTop: 10 }}>
              {revokedClients.map(c => (
                <div key={c.id} className="cm-card" style={{ opacity: 0.6 }}>
                  <div className="cm-card-main">
                    <div className="cm-device-name">{c.device_name}</div>
                    <div className="cm-device-meta cm-device-meta-revoked">
                      <span>revoked</span>
                      {c.os && <span>{c.os}</span>}
                      {c.browser && <span>{c.browser}</span>}
                      {c.last_seen_ip && <span>last IP {c.last_seen_ip}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="cm-divider" />

      {/* ── Connection log (forensic CSV export) ────────────────────── */}
      <ConnectionLogBlock setStatusMsg={setStatusMsg} />

      <div className="cm-divider" />

      {/* ── Admin account ───────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">Admin account</p>
        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Signed in</div>
            <div className="cm-toggle-help">Sessions last 12 hours of inactivity, then you sign in again.</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Sign out</button>
        </div>
        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Password</div>
            <div className="cm-toggle-help">
              Changing your password signs out every other admin browser.
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowPasswordForm(v => !v)}
          >
            {showPasswordForm ? 'Cancel' : 'Change password'}
          </button>
        </div>

        {showPasswordForm && (
          <ChangePasswordForm
            onDone={(msg) => { setShowPasswordForm(false); setStatusMsg(msg); }}
          />
        )}
      </div>
    </>
  );
}

function PinLockoutControl({ settings, onChanged, setStatusMsg }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings && typeof settings.max_attempts === 'number') {
      setDraft(String(settings.max_attempts));
    }
  }, [settings?.max_attempts]);

  if (!settings) {
    return (
      <div className="cm-toggle-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div className="cm-toggle-label">Pairing PIN brute-force protection</div>
        <div className="cm-toggle-help">Loading…</div>
      </div>
    );
  }

  const min = settings.min_max_attempts || 1;
  const max = settings.max_max_attempts || 100;
  const def = settings.default_max_attempts || 5;
  const parsed = parseInt(draft, 10);
  const valid = Number.isFinite(parsed) && parsed >= min && parsed <= max;
  const dirty = String(settings.max_attempts) !== draft.trim();

  async function handleSave() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await api.savePairingPinSettings({ max_attempts: parsed });
      setStatusMsg({ type: 'success', text: `Pairing PIN attempt cap set to ${parsed}.` });
      onChanged();
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearLockout(ip) {
    if (!confirm(`Clear the 24-hour pairing lockout for ${ip}?`)) return;
    try {
      await api.clearPairingPinLockout(ip);
      setStatusMsg({ type: 'success', text: `Cleared lockout for ${ip}.` });
      onChanged();
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Clear failed: ' + err.message });
    }
  }

  const lockouts = Array.isArray(settings.active_lockouts) ? settings.active_lockouts : [];

  return (
    <>
      <div className="cm-toggle-row" style={{ flexWrap: 'wrap', rowGap: 10 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="cm-toggle-label">Max wrong PIN attempts before lockout</div>
          <div className="cm-toggle-help">
            After this many wrong PIN guesses from the same IP, pairing is
            blocked from that IP for 24 hours. Default is {def}.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            className="pf-port-input"
            value={draft}
            min={min}
            max={max}
            onChange={e => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            style={{ width: 80 }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={!valid || !dirty || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {!valid && draft !== '' && (
        <div className="cm-warning" style={{ marginTop: -2 }}>
          Enter an integer between {min} and {max}.
        </div>
      )}

      {lockouts.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="cm-toggle-help" style={{ marginBottom: 6 }}>
            Currently locked out:
          </div>
          {lockouts.map(l => {
            const remaining = Math.max(0, l.locked_until - Math.floor(Date.now() / 1000));
            const hrs = Math.floor(remaining / 3600);
            const mins = Math.floor((remaining % 3600) / 60);
            return (
              <div key={l.ip} className="cm-card">
                <div className="cm-card-main">
                  <div className="cm-device-name">{l.ip}</div>
                  <div className="cm-device-meta">
                    <span>{l.failed_attempts} wrong attempts</span>
                    <span>unlocks in {hrs}h {mins}m</span>
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleClearLockout(l.ip)}
                >
                  Clear
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Connection log helpers ──────────────────────────────────────────────────

const EVENT_LABELS = {
  pairing_request:           'Pairing requested',
  pin_correct:               'PIN correct (paired)',
  pin_wrong:                 'Wrong PIN',
  lockout:                   'IP locked out (24h)',
  lockout_blocked:           'Locked IP blocked',
  pair_rate_limited:         'Rate-limited PIN submit',
  request_rate_limited:      'Rate-limited pairing request',
  client_request:            'Client heartbeat',
  admin_login_ok:            'Admin login',
  admin_login_fail:          'Admin login failed',
  admin_login_rate_limited:  'Rate-limited admin login',
  connection_log_exported:   'Connection log CSV exported',
  admin_action:              'Admin action',
  request_denied:            'Request denied',
  request_error:             'Request error (4xx/5xx)',
};

const FAILURE_TYPES = new Set([
  'pin_wrong', 'lockout', 'lockout_blocked', 'pair_rate_limited',
  'request_rate_limited', 'admin_login_fail', 'admin_login_rate_limited',
  'request_denied', 'request_error',
]);

const SUCCESS_TYPES = new Set([
  'pairing_request', 'pin_correct', 'admin_login_ok', 'client_request',
  'admin_action', 'connection_log_exported',
]);

const TIME_WINDOWS = [
  { value: 'all',  label: 'All time' },
  { value: '1h',   label: 'Last hour',  seconds: 3600 },
  { value: '24h',  label: 'Last 24h',   seconds: 86400 },
  { value: '7d',   label: 'Last 7d',    seconds: 7 * 86400 },
  { value: '30d',  label: 'Last 30d',   seconds: 30 * 86400 },
];

function eventLabel(t)  { return EVENT_LABELS[t] || t; }
function eventColor(t)  {
  if (FAILURE_TYPES.has(t)) return '#e6a17a';
  if (SUCCESS_TYPES.has(t)) return '#7adba6';
  return undefined;
}

function formatAbsoluteTime(unixSec) {
  if (!unixSec) return '';
  try {
    return new Date(unixSec * 1000).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return new Date(unixSec * 1000).toISOString(); }
}

// ISO-2 country code → flag emoji. Falls back to the raw code on unknowns.
function countryFlag(code) {
  if (!code || typeof code !== 'string' || code.length !== 2) return '';
  const A = 0x1F1E6;
  const cc = code.toUpperCase();
  const a = cc.charCodeAt(0);
  const b = cc.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return '';
  return String.fromCodePoint(A + a - 65) + String.fromCodePoint(A + b - 65);
}

function summariseLocation(e) {
  const parts = [];
  if (e.city)    parts.push(e.city);
  if (e.region && e.region !== e.city) parts.push(e.region);
  if (e.country) parts.push(e.country);
  return parts.join(', ');
}

function tryParseClientHints(json) {
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    return typeof o === 'object' && o !== null ? o : null;
  } catch { return null; }
}

function ConnectionLogBlock({ setStatusMsg }) {
  const [tab, setTab] = useState('events'); // 'events' | 'sources'
  const [downloading, setDownloading] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      await api.downloadConnectionLogCsv();
      setStatusMsg({ type: 'success', text: 'Connection log CSV downloaded.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Download failed: ' + err.message });
    } finally {
      setDownloading(false);
    }
  }

  async function handleClear() {
    if (!confirm('Delete every entry from the connection log? This cannot be undone — export the CSV first if you might need it later.')) return;
    setClearing(true);
    try {
      await api.clearConnectionLog();
      setStatusMsg({ type: 'success', text: 'Connection log cleared.' });
      // Bump a refresh signal — pass through via a key on the inner views.
      window.dispatchEvent(new CustomEvent('momotaro:connection-log-cleared'));
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Clear failed: ' + err.message });
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="cm-block">
      <p className="cm-block-title">Connection log</p>
      <div className="cm-toggle-help" style={{ marginBottom: 10 }}>
        Every pairing attempt, wrong-PIN guess, lockout, denied API request,
        and admin action is logged. For each event we capture the IP, real
        IP (forwarded headers), reverse-DNS hostname, GeoIP country / city,
        OS, browser, device type, Accept-Language, Sec-CH-UA client hints,
        request method + path, response status, and how the request was
        authorised. Switch to <strong>Sources</strong> for a one-row-per-source
        rollup that surfaces unique visitors at a glance.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          className={`btn ${tab === 'events' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
          onClick={() => setTab('events')}
        >
          Events
        </button>
        <button
          className={`btn ${tab === 'sources' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
          onClick={() => setTab('sources')}
        >
          Sources
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-primary btn-sm"
          onClick={handleDownload}
          disabled={downloading}
        >
          {downloading ? 'Preparing CSV…' : 'Download full CSV'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleClear}
          disabled={clearing}
        >
          {clearing ? 'Clearing…' : 'Clear log'}
        </button>
      </div>

      {tab === 'events' ? <ConnectionEventsView /> : <ConnectionSourcesView />}
    </div>
  );
}

function ConnectionEventsView() {
  const [entries, setEntries] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  // Filters
  const [severity, setSeverity]   = useState('all');
  const [ip, setIp]               = useState('');
  const [q, setQ]                 = useState('');
  const [timeWindow, setTimeWindow] = useState('all');
  const [eventTypes, setEventTypes] = useState([]); // empty = all

  // Debounce text filters
  const [debouncedIp, setDebouncedIp] = useState('');
  const [debouncedQ,  setDebouncedQ]  = useState('');
  useEffect(() => { const t = setTimeout(() => setDebouncedIp(ip), 300); return () => clearTimeout(t); }, [ip]);
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q),   300); return () => clearTimeout(t); }, [q]);

  const filters = useMemoFilters({ severity, ip: debouncedIp, q: debouncedQ, timeWindow, eventTypes });

  const load = useCallback(async (cursor = null) => {
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const data = await api.getConnectionLog({
        ...filters,
        limit: 100,
        cursor: cursor || undefined,
      });
      const next = data?.entries || [];
      if (cursor) {
        setEntries(prev => [...prev, ...next]);
      } else {
        setEntries(next);
        setExpanded(new Set());
      }
      setNextCursor(data?.next_cursor || null);
      setTotal(data?.total || 0);
      setFilteredTotal(data?.filtered_total || 0);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      if (cursor) setLoadingMore(false); else setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(null); }, [load]);

  useEffect(() => {
    const onCleared = () => load(null);
    window.addEventListener('momotaro:connection-log-cleared', onCleared);
    return () => window.removeEventListener('momotaro:connection-log-cleared', onCleared);
  }, [load]);

  function toggleExpanded(id) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function toggleEventType(t) {
    setEventTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  }

  const allEventTypes = Object.keys(EVENT_LABELS);

  return (
    <>
      <div className="cm-cl-filters">
        <input
          type="text"
          className="settings-input cm-cl-input"
          placeholder="Filter by IP (substring, includes forwarded-for)"
          value={ip}
          onChange={e => setIp(e.target.value)}
        />
        <input
          type="text"
          className="settings-input cm-cl-input"
          placeholder="Search device name, user agent, country, path, referer…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={severity}
          onChange={e => setSeverity(e.target.value)}
        >
          <option value="all">All events</option>
          <option value="failures">Failures only</option>
          <option value="successes">Successes only</option>
        </select>
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={timeWindow}
          onChange={e => setTimeWindow(e.target.value)}
        >
          {TIME_WINDOWS.map(w => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>
      </div>

      <div className="cm-cl-chips">
        {allEventTypes.map(t => {
          const active = eventTypes.includes(t);
          return (
            <button
              key={t}
              type="button"
              className={`cm-cl-chip${active ? ' cm-cl-chip-on' : ''}`}
              onClick={() => toggleEventType(t)}
              style={active ? { borderColor: eventColor(t) || undefined, color: eventColor(t) || undefined } : undefined}
            >
              {eventLabel(t)}
            </button>
          );
        })}
        {eventTypes.length > 0 && (
          <button type="button" className="cm-cl-chip-clear" onClick={() => setEventTypes([])}>
            Clear ({eventTypes.length})
          </button>
        )}
      </div>

      {error && (
        <div className="cm-warning" style={{ marginBottom: 8 }}>
          Load failed: {error}
        </div>
      )}

      <div className="cm-cl-meta">
        {loading
          ? 'Loading…'
          : filteredTotal === total
            ? `${total.toLocaleString()} events`
            : `${filteredTotal.toLocaleString()} matching of ${total.toLocaleString()} total`}
      </div>

      {entries.length === 0 ? (
        <div className="cm-empty">
          {loading ? 'Loading…' : 'No events match these filters.'}
        </div>
      ) : (
        <div className="cm-cl-table-wrap">
          <table className="cm-cl-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Source</th>
                <th>Device</th>
                <th>Request</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => {
                const isOpen = expanded.has(e.id);
                const flag = countryFlag(e.country);
                const loc  = summariseLocation(e);
                return (
                  <React.Fragment key={e.id}>
                    <tr className={`cm-cl-row${isOpen ? ' cm-cl-row-open' : ''}`}>
                      <td title={formatAbsoluteTime(e.occurred_at)}>
                        {formatRelativeTime(e.occurred_at)}
                      </td>
                      <td style={{ color: eventColor(e.event_type) }}>
                        {eventLabel(e.event_type)}
                      </td>
                      <td>
                        <div className="cm-cl-mono">{e.real_ip || e.ip || '—'}</div>
                        {(loc || e.reverse_dns) && (
                          <div className="cm-cl-sub">
                            {flag && <span style={{ marginRight: 4 }}>{flag}</span>}
                            {loc}
                            {e.reverse_dns && <span className="cm-cl-rdns"> · {e.reverse_dns}</span>}
                          </div>
                        )}
                      </td>
                      <td>
                        <div>{[e.device_name, e.platform].filter(Boolean).join(' · ') || '—'}</div>
                        <div className="cm-cl-sub">
                          {[e.device_type, e.os, e.browser].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td>
                        {e.method && e.path ? (
                          <div className="cm-cl-mono cm-cl-path">
                            <span className="cm-cl-method">{e.method}</span> {e.path}
                            {e.status_code != null && (
                              <span className="cm-cl-status"> {e.status_code}</span>
                            )}
                          </div>
                        ) : e.detail ? (
                          <div className="cm-cl-sub">{e.detail}</div>
                        ) : (
                          <span className="cm-cl-sub">—</span>
                        )}
                      </td>
                      <td className="cm-cl-expand-col">
                        <button
                          type="button"
                          className="cm-cl-expand-btn"
                          onClick={() => toggleExpanded(e.id)}
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="cm-cl-detail-row">
                        <td colSpan={6}>
                          <EventDetail event={e} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => load(nextCursor)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

// Wrap filter-object construction in a stable reference so `load`'s
// useCallback doesn't recreate on every keystroke pass-through.
function useMemoFilters(args) {
  return React.useMemo(() => {
    const out = {};
    if (args.severity && args.severity !== 'all') out.severity = args.severity;
    if (args.ip)        out.ip = args.ip;
    if (args.q)         out.q  = args.q;
    if (args.eventTypes && args.eventTypes.length > 0) out.event_type = args.eventTypes.join(',');
    if (args.timeWindow && args.timeWindow !== 'all') {
      const def = TIME_WINDOWS.find(w => w.value === args.timeWindow);
      if (def?.seconds) out.since = Math.floor(Date.now() / 1000) - def.seconds;
    }
    return out;
  }, [args.severity, args.ip, args.q, args.timeWindow, args.eventTypes.join(',')]);
}

function EventDetail({ event: e }) {
  const hints = tryParseClientHints(e.client_hints);
  const rows = [
    ['Occurred at',     formatAbsoluteTime(e.occurred_at)],
    ['Event type',      e.event_type],
    ['Auth kind',       e.auth_kind || '—'],
    ['IP (req.ip)',     e.ip],
    ['Real IP',         e.real_ip],
    ['Forwarded-For',   e.forwarded_for],
    ['Reverse DNS',     e.reverse_dns],
    ['Country',         e.country ? `${countryFlag(e.country)} ${e.country}` : ''],
    ['Region',          e.region],
    ['City',            e.city],
    ['Timezone',        e.timezone],
    ['OS',              e.os],
    ['Browser',         e.browser],
    ['Device type',     e.device_type],
    ['Platform',        e.platform],
    ['Device name',     e.device_name],
    ['Accept-Language', e.accept_language],
    ['DNT',             e.dnt == null ? '' : (e.dnt ? '1 (Do-Not-Track)' : '0')],
    ['Method',          e.method],
    ['Path',            e.path],
    ['Status code',     e.status_code == null ? '' : String(e.status_code)],
    ['Protocol',        e.protocol],
    ['Host',            e.host],
    ['Origin',          e.origin],
    ['Referer',         e.referer],
    ['Pairing ID',      e.pairing_id],
    ['Paired client',   e.paired_client_id == null ? '' : `#${e.paired_client_id}`],
    ['Detail',          e.detail],
    ['User agent',      e.user_agent],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <div className="cm-cl-detail">
      <dl className="cm-cl-detail-grid">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {hints && (
        <div className="cm-cl-detail-hints">
          <div className="cm-cl-detail-hints-title">Sec-CH-UA client hints</div>
          <pre className="cm-cl-detail-hints-pre">
            {JSON.stringify(hints, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ConnectionSourcesView() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [filter, setFilter]     = useState('');
  const [sort, setSort]             = useState('last_seen'); // last_seen | event_count | failure_count | first_seen
  const [timeWindow, setTimeWindow] = useState('30d');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const def = TIME_WINDOWS.find(w => w.value === timeWindow);
      const since = def?.seconds
        ? Math.floor(Date.now() / 1000) - def.seconds
        : undefined;
      const data = await api.getConnectionSources(since);
      setSources(data?.sources || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [timeWindow]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onCleared = () => load();
    window.addEventListener('momotaro:connection-log-cleared', onCleared);
    return () => window.removeEventListener('momotaro:connection-log-cleared', onCleared);
  }, [load]);

  const filtered = React.useMemo(() => {
    const f = filter.trim().toLowerCase();
    let rows = sources;
    if (f) {
      rows = rows.filter(s =>
        [s.source_ip, s.reverse_dns, s.country, s.city, s.region,
         s.device_name, s.user_agent, s.os, s.browser, s.platform]
          .some(v => v && String(v).toLowerCase().includes(f))
      );
    }
    const sorted = rows.slice().sort((a, b) => {
      const av = a[sort] ?? 0;
      const bv = b[sort] ?? 0;
      return bv - av;
    });
    return sorted;
  }, [sources, filter, sort]);

  return (
    <>
      <div className="cm-cl-filters">
        <input
          type="text"
          className="settings-input cm-cl-input"
          placeholder="Filter by IP, hostname, country, device, browser…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={sort}
          onChange={e => setSort(e.target.value)}
        >
          <option value="last_seen">Sort: most recent</option>
          <option value="first_seen">Sort: oldest</option>
          <option value="event_count">Sort: most events</option>
          <option value="failure_count">Sort: most failures</option>
        </select>
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={timeWindow}
          onChange={e => setTimeWindow(e.target.value)}
        >
          {TIME_WINDOWS.filter(w => w.value !== 'all').map(w => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="cm-warning" style={{ marginBottom: 8 }}>
          Load failed: {error}
        </div>
      )}

      <div className="cm-cl-meta">
        {loading ? 'Loading…' :
          `${filtered.length.toLocaleString()} unique source${filtered.length === 1 ? '' : 's'}` +
          (filter ? ` matching "${filter}"` : '')
        }
      </div>

      {filtered.length === 0 ? (
        <div className="cm-empty">
          {loading ? 'Loading…' : 'No sources in this window.'}
        </div>
      ) : (
        <div className="cm-cl-table-wrap">
          <table className="cm-cl-table">
            <thead>
              <tr>
                <th>Source IP / hostname</th>
                <th>Location</th>
                <th>Device</th>
                <th>Events</th>
                <th>First seen</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const flag = countryFlag(s.country);
                const loc  = summariseLocation(s);
                return (
                  <tr key={`${s.source_ip}|${s.paired_client_id ?? ''}|${s.user_agent ?? ''}`}>
                    <td>
                      <div className="cm-cl-mono">{s.source_ip || '—'}</div>
                      {s.reverse_dns && <div className="cm-cl-sub">{s.reverse_dns}</div>}
                      {s.paired_client_id && (
                        <div className="cm-cl-sub cm-cl-paired-badge">
                          Paired client #{s.paired_client_id}
                          {s.device_name ? ` · ${s.device_name}` : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {flag && <span style={{ marginRight: 4 }}>{flag}</span>}
                      {loc || <span className="cm-cl-sub">—</span>}
                      {s.timezone && <div className="cm-cl-sub">{s.timezone}</div>}
                    </td>
                    <td>
                      <div>{[s.device_type, s.platform].filter(Boolean).join(' · ') || '—'}</div>
                      <div className="cm-cl-sub">
                        {[s.os, s.browser].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      <div>{(s.event_count || 0).toLocaleString()} total</div>
                      {s.failure_count > 0 && (
                        <div className="cm-cl-sub" style={{ color: '#e6a17a' }}>
                          {s.failure_count} failure{s.failure_count === 1 ? '' : 's'}
                        </div>
                      )}
                      {s.pair_count > 0 && (
                        <div className="cm-cl-sub" style={{ color: '#7adba6' }}>
                          {s.pair_count} pair{s.pair_count === 1 ? '' : 's'}
                        </div>
                      )}
                      {s.admin_login_count > 0 && (
                        <div className="cm-cl-sub">
                          {s.admin_login_count} admin login{s.admin_login_count === 1 ? '' : 's'}
                        </div>
                      )}
                    </td>
                    <td title={formatAbsoluteTime(s.first_seen)}>
                      {formatRelativeTime(s.first_seen)}
                    </td>
                    <td title={formatAbsoluteTime(s.last_seen)}>
                      {formatRelativeTime(s.last_seen)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ChangePasswordForm({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext]       = useState('');
  const [next2, setNext2]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (next !== next2)  { setError('New passwords do not match.'); return; }
    setSaving(true);
    try {
      await api.changeAdminPassword(current, next);
      onDone({ type: 'success', text: 'Password changed.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card" style={{ marginTop: 12 }}>
      <form className="settings-token-form" onSubmit={handleSubmit}>
        <label className="settings-label">Current password</label>
        <input
          type="password"
          className="settings-input"
          value={current}
          onChange={e => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <label className="settings-label" style={{ marginTop: 8 }}>New password</label>
        <input
          type="password"
          className="settings-input"
          value={next}
          onChange={e => setNext(e.target.value)}
          autoComplete="new-password"
        />
        <label className="settings-label" style={{ marginTop: 8 }}>Confirm new password</label>
        <input
          type="password"
          className="settings-input"
          value={next2}
          onChange={e => setNext2(e.target.value)}
          autoComplete="new-password"
        />
        {error && <p className="lp-form-error" style={{ marginTop: 8 }}>{error}</p>}
        <div className="settings-token-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !current || !next || !next2}>
            {saving ? 'Saving...' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Section: Port Forwarding ──────────────────────────────────────────────────
// UPnP-driven port mapping. Like Client Management, it's gated behind the
// admin password — un-authed users see the login/setup flow. When live the
// section polls `/api/admin/network/status` every 5 s so the mapping state
// reflects the actual UPnP loop, not just what we last persisted.

function PortForwardingSection() {
  const [authStatus, setAuthStatus] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  const refreshAuthStatus = useCallback(async () => {
    try {
      const data = await api.getAuthStatus();
      setAuthStatus(data);
    } catch {
      setAuthStatus({ configured: false, logged_in: false });
    }
  }, []);

  useEffect(() => { refreshAuthStatus(); }, [refreshAuthStatus]);

  if (authStatus === null) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Port Forwarding</h2>
          <p className="sp-section-desc">
            Open this server to the internet. UPnP asks your router to forward
            a port automatically; Manual mode is for when you've forwarded the
            port yourself (or use a reverse proxy like Caddy / Cloudflare
            Tunnel). Combine with paired-client auth in Client Management to
            keep your library private.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      {!authStatus.configured && (
        <AdminSetupForm
          onDone={(msg) => { setStatusMsg(msg); refreshAuthStatus(); }}
        />
      )}

      {authStatus.configured && !authStatus.logged_in && (
        <AdminLoginForm
          onDone={(msg) => { setStatusMsg(msg); refreshAuthStatus(); }}
        />
      )}

      {authStatus.configured && authStatus.logged_in && (
        <PortForwardingAuthed setStatusMsg={setStatusMsg} />
      )}
    </div>
  );
}

function PortForwardingAuthed({ setStatusMsg }) {
  const [data, setData]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [probing, setProbing] = useState(false);
  // The configured-port input is a controlled string so the user can type
  // freely. Apply only re-validates on submit.
  const [portInput, setPortInput] = useState('');
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api.getNetworkStatus();
      setData(next);
      // Don't clobber an in-progress edit — only seed the input on first load.
      setPortInput(prev => prev === '' ? String(next.config.external_port) : prev);
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Failed to load network status: ' + err.message });
    } finally {
      inFlight.current = false;
    }
  }, [setStatusMsg]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, [refresh]);

  async function handleModeChange(mode) {
    if (!data || saving) return;
    setSaving(true);
    try {
      const next = await api.saveNetworkConfig({ mode });
      setData(next);
      setStatusMsg({ type: 'success', text: `Mode set to "${mode}".` });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePort() {
    const n = parseInt(portInput, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) {
      setStatusMsg({ type: 'error', text: 'External port must be between 1 and 65535.' });
      return;
    }
    setSaving(true);
    try {
      const next = await api.saveNetworkConfig({ external_port: n });
      setData(next);
      setStatusMsg({ type: 'success', text: 'External port updated.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const next = await api.refreshUpnpMapping();
      setData(prev => ({ ...prev, upnp: next }));
      if (next.state === 'mapped') {
        setStatusMsg({ type: 'success', text: 'Mapping re-applied.' });
      } else {
        setStatusMsg({ type: 'error', text: next.last_error || 'Mapping failed. Check router UPnP settings.' });
      }
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Refresh failed: ' + err.message });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleProbeUpnp() {
    setProbing(true);
    try {
      const result = await api.probeUpnp();
      if (result.supported) {
        const n = result.devices?.length || 0;
        const ipPart = result.public_ip ? ` Public IP: ${result.public_ip}.` : '';
        setStatusMsg({
          type: 'success',
          text: `Found ${n} gateway${n === 1 ? '' : 's'} responding to UPnP.${ipPart}`,
        });
      } else {
        setStatusMsg({ type: 'error', text: result.error || 'No router responded to UPnP discovery.' });
      }
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Probe failed: ' + err.message });
    } finally {
      setProbing(false);
    }
  }

  // Used by Manual mode — does NOT touch UPnP. Calls an external HTTPS
  // echo service via the server (so the server's view of its own WAN IP
  // is what's reported, not the admin browser's).
  async function handleDetectPublicIp() {
    setProbing(true);
    try {
      const result = await api.detectPublicIp();
      setStatusMsg({ type: 'success', text: `Public IP: ${result.public_ip}` });
    } catch (err) {
      setStatusMsg({ type: 'error', text: err.message });
    } finally {
      setProbing(false);
    }
  }

  if (!data) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  const { config: cfg, upnp: upnpStatus } = data;
  const publicUrl = upnpStatus.public_ip
    ? `http://${upnpStatus.public_ip}:${upnpStatus.external_port || cfg.external_port}`
    : null;

  // Cleartext-over-WAN warning. Trigger when the admin UI itself is being
  // served over plain HTTP *and* port forwarding is on — in that combo,
  // every paired-client request crosses the open internet with the auth
  // token visible to anyone on the path. Same-host check matters because
  // the admin might be on the LAN (via the server's local IP) but external
  // clients are not. We err on the side of warning.
  const onHttp = typeof window !== 'undefined' && window.location.protocol === 'http:';
  const showHttpsWarning = onHttp && cfg.mode !== 'off';

  return (
    <>
      {showHttpsWarning && (
        <div className="cm-warning" style={{ marginBottom: 20 }}>
          <strong>This server is reachable over plain HTTP.</strong> Once
          the port is forwarded, every request — including paired-client
          auth tokens — travels in cleartext. Front the server with a
          reverse proxy that terminates TLS ({' '}
          <a href="https://caddyserver.com/" target="_blank" rel="noreferrer">Caddy</a>,{' '}
          <a href="https://nginxproxymanager.com/" target="_blank" rel="noreferrer">nginx Proxy Manager</a>,{' '}
          or <a href="https://www.cloudflare.com/products/tunnel/" target="_blank" rel="noreferrer">Cloudflare Tunnel</a>)
          before exposing it to the internet.
        </div>
      )}

      {/* ── Mode picker ─────────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">Forwarding mode</p>
        <div className="pf-mode-group">
          {[
            { id: 'off',    label: 'Local only', desc: 'Reject every non-LAN request at the app, regardless of router forwards.' },
            { id: 'upnp',   label: 'UPnP',       desc: 'Ask the router to forward automatically and accept external traffic.' },
            { id: 'manual', label: 'Manual',     desc: "You've forwarded the port yourself or run a reverse proxy." },
          ].map(opt => (
            <button
              key={opt.id}
              className={`pf-mode-btn${cfg.mode === opt.id ? ' active' : ''}`}
              onClick={() => handleModeChange(opt.id)}
              disabled={saving}
            >
              <div className="pf-mode-label">{opt.label}</div>
              <div className="pf-mode-desc">{opt.desc}</div>
            </button>
          ))}
        </div>
        {cfg.mode === 'off' && (
          <div className="pf-status-card" style={{ marginTop: 14 }}>
            <span className="pf-status-dot mapped" />
            <div className="pf-status-body">
              <div className="pf-status-title">External access blocked</div>
              <div className="pf-status-detail">
                The server is now rejecting every request from outside your LAN
                with a 403, even if a router port-forward rule still points at
                it. To fully close the port, also remove the rule in your
                router admin panel — Momotaro can't reach in there to delete
                it for you.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Port configuration ─────────────────────────────────────── */}
      {cfg.mode !== 'off' && (
        <div className="cm-block">
          <p className="cm-block-title">Ports</p>
          <div className="pf-port-row">
            <input
              type="number"
              className="pf-port-input"
              value={portInput}
              onChange={e => setPortInput(e.target.value)}
              min="1"
              max="65535"
            />
            <span className="pf-port-arrow">external →</span>
            <input
              type="number"
              className="pf-port-input"
              value={cfg.internal_port}
              disabled
              title="The server's listen port is fixed at startup via the PORT env var."
            />
            <span className="pf-mode-desc" style={{ marginLeft: 4 }}>internal</span>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSavePort}
              disabled={saving || portInput === String(cfg.external_port)}
            >
              {saving ? 'Saving...' : 'Apply'}
            </button>
          </div>
        </div>
      )}

      {/* ── Live status ─────────────────────────────────────────────── */}
      {cfg.mode === 'upnp' && (
        <div className="cm-block">
          <p className="cm-block-title">Status</p>
          <UpnpStatusCard upnp={upnpStatus} cfg={cfg} publicUrl={publicUrl} />

          <div className="pf-action-row">
            <button className="btn btn-ghost btn-sm" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Re-apply mapping'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleProbeUpnp} disabled={probing}>
              {probing ? 'Probing...' : 'Probe router'}
            </button>
          </div>
        </div>
      )}

      {cfg.mode === 'manual' && (
        <div className="cm-block">
          <p className="cm-block-title">Manual setup</p>
          <div className="pf-status-card">
            <span className="pf-status-dot idle" />
            <div className="pf-status-body">
              <div className="pf-status-title">Manual mode</div>
              <div className="pf-status-detail">
                Configure your router to forward TCP port{' '}
                <strong>{cfg.external_port}</strong> to this server on internal
                port <strong>{cfg.internal_port}</strong>. We won't try UPnP and
                won't display a live status here — once you've forwarded the
                port, test from a phone on cellular data to confirm it works.
              </div>
            </div>
          </div>
          <div className="pf-action-row">
            <button className="btn btn-ghost btn-sm" onClick={handleDetectPublicIp} disabled={probing}>
              {probing ? 'Detecting...' : 'Detect public IP'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function UpnpStatusCard({ upnp, cfg, publicUrl }) {
  let dotClass = 'idle';
  let title = 'Idle';
  let detail = 'Waiting for first mapping attempt...';

  if (upnp.state === 'mapped') {
    dotClass = 'mapped';
    title = 'Mapped';
    detail = publicUrl
      ? <>Reachable at <span className="pf-public-url">{publicUrl}</span></>
      : `External port ${upnp.external_port} forwarded to internal ${upnp.internal_port}.`;
  } else if (upnp.state === 'partial') {
    // Multi-device discovery found N gateways but only some accepted the
    // mapping (typical on Windows hosts with virtual NICs — Hyper-V's
    // "gateway" rejects, the real router accepts). This is a success
    // state, not a failure.
    dotClass = 'mapped';
    title = `Mapped on ${upnp.devices_mapped} of ${upnp.devices_found} gateways`;
    detail = publicUrl
      ? <>Reachable at <span className="pf-public-url">{publicUrl}</span>. Virtual adapters that rejected the mapping are expected and harmless.</>
      : `External port ${upnp.external_port} forwarded on the working router. Other gateways (likely VPN / Hyper-V / WSL virtual adapters) rejected the mapping — that's expected.`;
  } else if (upnp.state === 'error') {
    dotClass = 'error';
    title = 'Mapping failed';
    detail = upnp.last_error || 'Router refused the mapping.';
  } else if (upnp.state === 'disabled') {
    dotClass = 'idle';
    title = 'Disabled';
    detail = `Configured external port: ${cfg.external_port}. Switch mode to UPnP to start mapping.`;
  }

  return (
    <div className="pf-status-card">
      <span className={`pf-status-dot ${dotClass}`} />
      <div className="pf-status-body">
        <div className="pf-status-title">{title}</div>
        <div className="pf-status-detail">{detail}</div>
        {upnp.last_attempt_at && (
          <div className="pf-status-detail" style={{ marginTop: 4 }}>
            Last attempt {formatRelativeTime(upnp.last_attempt_at)}
            {upnp.last_mapped_at && ` · last success ${formatRelativeTime(upnp.last_mapped_at)}`}
            {upnp.devices_found > 0 && ` · ${upnp.devices_mapped}/${upnp.devices_found} gateways accepted`}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Android ───────────────────────────────────────────────────────────────────
//
// Settings panel that exposes two operations against the self-hosted APK
// distribution endpoints:
//   1. Download APK — direct link to /downloads/momotaro.apk. Available
//      from every device, since you might be browsing the web UI on a
//      desktop and want to grab the APK to sideload onto your phone.
//   2. Update check — only rendered inside the Capacitor native shell.
//      Compares the bundled APP_VERSION against /api/app/version's
//      reported `version` and shows up-to-date / update-available / no
//      APK published. The home-screen `UpdateBanner` component is the
//      passive surface for the same data; this is the manual surface.
//
// Both pieces are pure client-side glue against existing public server
// endpoints — no new server work was needed.

// Capacitor platform string ('android' | 'ios' | 'electron' | 'web'), or null
// off the native shell. Used to scope the per-platform update-check cards so the
// Android card only shows in the APK and the Linux card only in the desktop app.
function nativePlatform() {
  try {
    if (typeof window !== 'undefined' && window.Capacitor
        && typeof window.Capacitor.getPlatform === 'function') {
      return window.Capacitor.getPlatform();
    }
  } catch { /* ignore */ }
  return null;
}

// Open a URL in the OS browser. In the Electron desktop shell, navigation is
// locked to the app's custom scheme, so a plain <a href>/target=_blank is
// blocked — route through the preload bridge. In the PWA, fall back to a normal
// new-tab open. (Plain download anchors are used directly where a file download
// is wanted in the browser.)
function openExternalUrl(url) {
  const bridge = (typeof window !== 'undefined'
      && window.MomotaroElectron
      && typeof window.MomotaroElectron.openExternal === 'function')
    ? window.MomotaroElectron.openExternal
    : null;
  if (bridge) { bridge(url); return; }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}

function formatApkSize(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function AndroidSection() {
  const isAndroidApp = nativePlatform() === 'android';
  const apkUrl       = `${api.getServerUrl()}/downloads/momotaro.apk`;
  const [check, setCheck] = useState({ status: 'idle' });

  async function checkForUpdates() {
    setCheck({ status: 'checking' });
    try {
      const data = await api.getAppVersion();
      if (!data?.version) {
        setCheck({ status: 'error', message: 'Server returned malformed version data.' });
        return;
      }
      const apkAbsolute = data.apk_url?.startsWith('/')
        ? `${api.getServerUrl()}${data.apk_url}`
        : data.apk_url;
      if (data.version === APP_VERSION) {
        setCheck({ status: 'up-to-date', latest: data.version });
      } else {
        setCheck({
          status:     'update-available',
          latest:     data.version,
          notes:      data.notes,
          releasedAt: data.released_at,
          sizeBytes:  data.size_bytes,
          apkUrl:     apkAbsolute,
        });
      }
    } catch (err) {
      // /api/app/version returns 404 when no APK is published. The fetch
      // wrapper surfaces non-2xx responses as `HTTP <status>` thrown
      // errors, which is what we pattern-match on here.
      if (/HTTP 404/.test(err.message) || /No published/i.test(err.message)) {
        setCheck({ status: 'no-published' });
      } else {
        setCheck({ status: 'error', message: err.message || 'Could not reach the server.' });
      }
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Android</h2>
          <p className="sp-section-desc">
            Download the Momotaro Android APK directly from this server, and
            check whether the device running this app has the latest version.
          </p>
        </div>
      </div>

      <div className="settings-card">
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Download APK</h3>
        <p className="settings-hint">
          The latest signed APK published to this server is available at{' '}
          <code>/downloads/momotaro.apk</code>. After downloading on a phone,
          tap the file to install. The first install from a browser requires
          Android's "Install unknown apps" permission for that browser —
          one-time setting.
        </p>
        <div className="settings-token-actions" style={{ marginTop: 12 }}>
          <a className="btn btn-primary" href={apkUrl} download="momotaro.apk">
            Download APK
          </a>
        </div>
      </div>

      {isAndroidApp && (
        <div className="settings-card" style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Update check</h3>
          <p className="settings-hint">
            This device is running version <strong>v{APP_VERSION}</strong>.
            Check whether a newer release has been published.
          </p>
          <div className="settings-token-actions" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              onClick={checkForUpdates}
              disabled={check.status === 'checking'}
            >
              {check.status === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
          </div>

          {check.status === 'up-to-date' && (
            <div className="sp-status sp-status-success" style={{ marginTop: 12 }}>
              You're on the latest version (v{check.latest}).
            </div>
          )}

          {check.status === 'update-available' && (
            <div className="sp-status sp-status-success" style={{ marginTop: 12 }}>
              <div><strong>Update available — v{check.latest}</strong></div>
              {check.notes && (
                <div style={{ marginTop: 4 }}>{check.notes}</div>
              )}
              {(check.releasedAt || check.sizeBytes) && (
                <div style={{ marginTop: 4, opacity: 0.8, fontSize: 13 }}>
                  {check.releasedAt && <>Released {check.releasedAt}</>}
                  {check.releasedAt && check.sizeBytes && <> · </>}
                  {formatApkSize(check.sizeBytes)}
                </div>
              )}
              <div className="settings-token-actions" style={{ marginTop: 10 }}>
                <a
                  className="btn btn-primary"
                  href={check.apkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Download update
                </a>
              </div>
            </div>
          )}

          {check.status === 'no-published' && (
            <p className="settings-hint" style={{ marginTop: 12 }}>
              No APK has been published on this server yet.
            </p>
          )}

          {check.status === 'error' && (
            <div className="sp-status sp-status-error" style={{ marginTop: 12 }}>
              {check.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Linux ─────────────────────────────────────────────────────────────────────
//
// Mirror of the Android section for the Linux AppImage desktop app. The
// "Download AppImage" link is available from any device — most usefully from the
// PWA on a Linux desktop, to grab the installer the same way Android users grab
// the APK. The "Update check" card only renders inside the Electron desktop
// shell; it compares the bundled APP_VERSION against the server's Linux channel
// (api.getAppVersion() auto-selects /api/app/version?platform=linux on
// electron). Downloads open in the OS browser via openExternalUrl because the
// desktop shell blocks in-app navigation off the app scheme; in the PWA the
// download is a normal browser anchor.
function LinuxSection() {
  const isElectron  = nativePlatform() === 'electron';
  const appImageUrl = `${api.getServerUrl()}/downloads/momotaro.AppImage`;
  const [check, setCheck] = useState({ status: 'idle' });

  async function checkForUpdates() {
    setCheck({ status: 'checking' });
    try {
      const data = await api.getAppVersion(); // electron → linux channel
      if (!data?.version) {
        setCheck({ status: 'error', message: 'Server returned malformed version data.' });
        return;
      }
      const rel = data.download_url || data.appimage_url;
      const downloadAbsolute = rel?.startsWith('/') ? `${api.getServerUrl()}${rel}` : rel;
      if (data.version === APP_VERSION) {
        setCheck({ status: 'up-to-date', latest: data.version });
      } else {
        setCheck({
          status:      'update-available',
          latest:      data.version,
          notes:       data.notes,
          releasedAt:  data.released_at,
          sizeBytes:   data.size_bytes,
          downloadUrl: downloadAbsolute,
        });
      }
    } catch (err) {
      // 404 = nothing published for this platform; surfaced as a thrown
      // `HTTP 404` / "No published" by the fetch wrapper.
      if (/HTTP 404/.test(err.message) || /No published/i.test(err.message)) {
        setCheck({ status: 'no-published' });
      } else {
        setCheck({ status: 'error', message: err.message || 'Could not reach the server.' });
      }
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Linux</h2>
          <p className="sp-section-desc">
            Download the Momotaro Linux desktop app (AppImage) directly from this
            server, and check whether this device has the latest version.
          </p>
        </div>
      </div>

      <div className="settings-card">
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Download AppImage</h3>
        <p className="settings-hint">
          The latest AppImage published to this server is available at{' '}
          <code>/downloads/momotaro.AppImage</code>. After downloading, make it
          executable (<code>chmod +x momotaro.AppImage</code>, or right-click →
          Properties → "Allow executing file as program") and run it.
        </p>
        <div className="settings-token-actions" style={{ marginTop: 12 }}>
          {isElectron ? (
            <button className="btn btn-primary" type="button" onClick={() => openExternalUrl(appImageUrl)}>
              Download AppImage
            </button>
          ) : (
            <a className="btn btn-primary" href={appImageUrl} download="momotaro.AppImage">
              Download AppImage
            </a>
          )}
        </div>
      </div>

      {isElectron && (
        <div className="settings-card" style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Update check</h3>
          <p className="settings-hint">
            This device is running version <strong>v{APP_VERSION}</strong>.
            Check whether a newer release has been published.
          </p>
          <div className="settings-token-actions" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              onClick={checkForUpdates}
              disabled={check.status === 'checking'}
            >
              {check.status === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
          </div>

          {check.status === 'up-to-date' && (
            <div className="sp-status sp-status-success" style={{ marginTop: 12 }}>
              You're on the latest version (v{check.latest}).
            </div>
          )}

          {check.status === 'update-available' && (
            <div className="sp-status sp-status-success" style={{ marginTop: 12 }}>
              <div><strong>Update available — v{check.latest}</strong></div>
              {check.notes && (
                <div style={{ marginTop: 4 }}>{check.notes}</div>
              )}
              {(check.releasedAt || check.sizeBytes) && (
                <div style={{ marginTop: 4, opacity: 0.8, fontSize: 13 }}>
                  {check.releasedAt && <>Released {check.releasedAt}</>}
                  {check.releasedAt && check.sizeBytes && <> · </>}
                  {formatApkSize(check.sizeBytes)}
                </div>
              )}
              <div className="settings-token-actions" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" type="button" onClick={() => openExternalUrl(check.downloadUrl)}>
                  Download update
                </button>
              </div>
            </div>
          )}

          {check.status === 'no-published' && (
            <p className="settings-hint" style={{ marginTop: 12 }}>
              No AppImage has been published on this server yet.
            </p>
          )}

          {check.status === 'error' && (
            <div className="sp-status sp-status-error" style={{ marginTop: 12 }}>
              {check.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Nav sections config ───────────────────────────────────────────────────────

// ── At-rest encryption ────────────────────────────────────────────────────────
//
// Owns the three states the user toggles between:
//   - off:    no passphrase set, downloads write plaintext
//   - locked: passphrase set but not yet entered this session; reader
//             can't decrypt downloaded chapters until user unlocks
//   - on:     unlocked, downloads encrypt-on-write, reader decrypts to
//             blob URLs at render time
function EncryptionCard({ nativeOnly }) {
  const [phase, setPhase] = useState('loading'); // loading | off | locked | on
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const enabled = await offlineIsEncryptionEnabled();
      if (!enabled)            setPhase('off');
      else if (offlineIsUnlocked()) setPhase('on');
      else                     setPhase('locked');
    } catch {
      setPhase('off');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleEnable(e) {
    e.preventDefault();
    setError(null);
    if (pass1.length < 6)       { setError('Passphrase must be at least 6 characters.'); return; }
    if (pass1 !== pass2)        { setError('Passphrases do not match.'); return; }
    setBusy(true);
    try {
      await offlineEnableEncryption(pass1);
      setPass1(''); setPass2('');
      await refresh();
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await offlineUnlock(unlockPass);
      setUnlockPass('');
      await refresh();
      // Resume any downloads that were paused by the locked store.
      try { downloaderResumeAfterUnlock(); } catch { /* non-fatal */ }
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function handleLock() {
    offlineLock();
    await refresh();
  }

  async function handleDisable() {
    if (!window.confirm(
      'Disable encryption?\n\n'
      + 'Already-downloaded encrypted chapters will become unreadable — '
      + 'you will need to delete and re-download them as plaintext. '
      + 'New downloads from now on will be saved unencrypted.'
    )) return;
    setBusy(true);
    try {
      await offlineDisableEncryption();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>At-rest Encryption</h3>
      <p className="settings-hint">
        Optional. Encrypts every downloaded <strong>page</strong> with
        AES-GCM using a key derived from your passphrase via PBKDF2.
        Covers and metadata stay plaintext so the Library grid remains
        cheap to render — only the actual page content (the part an
        adversary copying your offline folder would care about) is
        protected. Pages take a few extra ms to decrypt at render time.
        Your passphrase is <strong>not stored</strong> anywhere — losing
        it means the encrypted bytes on disk become unreadable.
      </p>

      {phase === 'loading' && <p className="settings-hint">Loading…</p>}

      {phase === 'off' && (
        <form onSubmit={handleEnable} style={{ marginTop: 12 }}>
          <div className="settings-token-actions" style={{ gap: 8, flexDirection: 'column', alignItems: 'stretch' }}>
            <input
              type="password"
              className="settings-input"
              value={pass1}
              onChange={e => setPass1(e.target.value)}
              placeholder="Passphrase (min 6 chars)"
              autoComplete="new-password"
              disabled={nativeOnly || busy}
            />
            <input
              type="password"
              className="settings-input"
              value={pass2}
              onChange={e => setPass2(e.target.value)}
              placeholder="Confirm passphrase"
              autoComplete="new-password"
              disabled={nativeOnly || busy}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={nativeOnly || busy || !pass1 || !pass2}
            >Enable encryption</button>
          </div>
        </form>
      )}

      {phase === 'locked' && (
        <form onSubmit={handleUnlock} style={{ marginTop: 12 }}>
          <p className="settings-hint">
            Encrypted downloads are present but locked for this session.
            Enter your passphrase to read them — until you do, the reader
            cannot decrypt downloaded chapters.
          </p>
          <div className="settings-token-actions" style={{ gap: 8 }}>
            <input
              type="password"
              className="settings-input"
              value={unlockPass}
              onChange={e => setUnlockPass(e.target.value)}
              placeholder="Passphrase"
              autoComplete="current-password"
              disabled={busy}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !unlockPass}
            >Unlock</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisable} disabled={busy}>
              Disable encryption (destroys access to existing encrypted downloads)
            </button>
          </div>
        </form>
      )}

      {phase === 'on' && (
        <div style={{ marginTop: 12 }}>
          <div className="sp-status sp-status-success" style={{ marginBottom: 8 }}>
            Encryption is unlocked for this session.
          </div>
          <div className="settings-token-actions" style={{ gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleLock} disabled={busy}>
              Lock now
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleDisable} disabled={busy}>
              Disable encryption
            </button>
          </div>
        </div>
      )}

      {error && <div className="sp-status sp-status-error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

// ── Offline Downloads ─────────────────────────────────────────────────────────
//
// Lets the user pick a subdirectory name under the app's external-files
// directory (no Android permissions needed) and surfaces the offline-mode
// toggle that ConnectivityContext consults. List of downloaded jobs is
// rendered from the IDB-backed queue.
function OfflineDownloadsSection() {
  const { mode, forced, forceOffline, wifiOnly, setWifiOnly, networkType, downloadsAllowed } = useConnectivity();
  // SAF folder state. `folderStatus` is whatever the OfflineFolder plugin
  // currently reports — `{ configured, displayName, treeUri }`. Refreshed
  // after pick/clear, and on mount so a returning user sees the right
  // state without having to interact.
  const [folderStatus, setFolderStatus] = useState({ configured: false, displayName: null });
  const [folderError, setFolderError]   = useState(null);
  const [folderBusy,  setFolderBusy]    = useState(false);
  const [downloaded, setDownloaded]   = useState([]);   // offline_manga rows
  const [jobs, setJobs]               = useState([]);   // active + recent
  const [busy, setBusy]               = useState(false);
  // P3 setting — auto-download the next chapter when nearing end of current
  // chapter. Off by default to avoid silently consuming background data.
  const [prefetchNext, setPrefetchNext] = useState(() => {
    try { return localStorage.getItem('momotaro_prefetch_next_offline') === '1'; }
    catch { return false; }
  });

  function togglePrefetchNext() {
    const next = !prefetchNext;
    setPrefetchNext(next);
    try {
      if (next) localStorage.setItem('momotaro_prefetch_next_offline', '1');
      else      localStorage.removeItem('momotaro_prefetch_next_offline');
    } catch { /* ignore */ }
  }

  const nativeOnly = !offlineStorageAvailable();

  const reload = useCallback(async () => {
    try {
      const [list, joblist] = await Promise.all([
        listOfflineManga({ sort: 'updated' }),
        listDownloads(),
      ]);
      setDownloaded(list);
      setJobs(joblist.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)));
    } catch {
      // IndexedDB unavailable (e.g. private-mode browser) — leave empty.
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Subscribe to downloader changes so the active-job list updates without
  // polling.
  useEffect(() => {
    const off = onDownloaderChange(() => { reload(); });
    return off;
  }, [reload]);

  // Refresh the folder status on mount (and after every pick/clear) so
  // the UI reflects reality without the user having to re-navigate.
  const refreshFolderStatus = useCallback(async () => {
    try {
      const s = await offlineGetStatus();
      setFolderStatus(s);
    } catch {
      setFolderStatus({ configured: false, displayName: null });
    }
  }, []);
  useEffect(() => { refreshFolderStatus(); }, [refreshFolderStatus]);

  async function handlePickFolder() {
    setFolderError(null);
    setFolderBusy(true);
    try {
      const result = await offlinePickFolder();
      await refreshFolderStatus();
      // After a successful pick, kick the download queue so any jobs
      // that were waiting on a folder start running. No-op if nothing's
      // queued.
      if (result && result.configured) {
        try { downloaderResumeAfterUnlock(); } catch { /* non-fatal */ }
      }
    } catch (err) {
      setFolderError(String(err?.message || err));
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleClearFolder() {
    if (!window.confirm(
      'Forget the current download folder?\n\n'
      + 'Already-downloaded files on disk are NOT deleted — they just '
      + 'become unreachable from inside the app until you re-pick that '
      + 'same folder. Pending downloads will pause until you pick again.'
    )) return;
    setFolderError(null);
    setFolderBusy(true);
    try {
      await offlineClearFolder();
      await refreshFolderStatus();
    } catch (err) {
      setFolderError(String(err?.message || err));
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleDeleteSeries(mangaId) {
    if (!window.confirm('Remove this downloaded series from the device? On-disk files will be deleted.')) return;
    setBusy(true);
    try {
      await downloaderDeleteSeries(mangaId);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Offline Downloads</h2>
          <p className="sp-section-desc">
            Download chapters and entire series to your device for reading
            without a network connection. {nativeOnly
              ? 'Downloading is only available in the Android app — open the site inside the installed app to use this feature.'
              : <Link to="/downloads">Open the full downloads manager →</Link>}
          </p>
        </div>
      </div>

      {/* ── Mode toggle ────────────────────────────────────────────────── */}
      <div className="settings-card">
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Offline Mode</h3>
        <p className="settings-hint">
          Forces the app to use only downloaded content even when the server
          is reachable. Useful on metered connections or when you want to
          avoid background data usage. Current state:{' '}
          <strong>{mode === 'online'
            ? 'Online'
            : (mode === 'offline-forced' ? 'Offline (forced)' : 'Offline (server unreachable)')}</strong>.
        </p>
        <div className="settings-token-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className={`track-toggle ${forced ? 'on' : ''}`}
            role="switch"
            aria-checked={forced}
            onClick={() => forceOffline(!forced)}
          >
            <span className="track-toggle-thumb" />
          </button>
        </div>
      </div>

      {/* ── At-rest encryption ─────────────────────────────────────────── */}
      <EncryptionCard nativeOnly={nativeOnly} />

      {/* ── Prefetch next chapter ──────────────────────────────────────── */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Auto-download next chapter</h3>
        <p className="settings-hint">
          When you're near the end of a chapter in the reader, automatically
          queue the next chapter for offline reading. Combined with{' '}
          <strong>Wi-Fi only</strong> below, this gives you a stable
          read-ahead buffer without using cellular data.
        </p>
        <div className="settings-token-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className={`track-toggle ${prefetchNext ? 'on' : ''}`}
            role="switch"
            aria-checked={prefetchNext}
            onClick={togglePrefetchNext}
            disabled={nativeOnly}
          >
            <span className="track-toggle-thumb" />
          </button>
        </div>
      </div>

      {/* ── Wi-Fi only ──────────────────────────────────────────────────── */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Download over Wi-Fi only</h3>
        <p className="settings-hint">
          Pauses the download queue when the device is on cellular or any
          metered connection. Queued jobs resume automatically once Wi-Fi is
          back. Current connection:{' '}
          <strong>{networkType === 'unknown' ? 'unknown' : networkType}</strong>{' '}
          ({downloadsAllowed ? 'downloads enabled' : 'downloads paused'}).
        </p>
        <div className="settings-token-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className={`track-toggle ${wifiOnly ? 'on' : ''}`}
            role="switch"
            aria-checked={wifiOnly}
            onClick={() => setWifiOnly(!wifiOnly)}
          >
            <span className="track-toggle-thumb" />
          </button>
        </div>
      </div>

      {/* ── Folder picker ──────────────────────────────────────────────── */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Download Folder</h3>
        <p className="settings-hint">
          Choose where downloaded chapters should be saved. Tapping
          <strong> Choose folder</strong> opens Android's storage picker —
          select any folder on internal storage or an SD card.
          Android will ask permission to access the folder you pick;
          accept it once and Momotaro remembers the choice across restarts.
          <strong> No downloads can run until a folder is chosen.</strong>
        </p>

        <div className="settings-token-actions" style={{ marginTop: 12, alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {folderStatus.configured ? (
              <>
                <span style={{ color: 'var(--text-muted)', fontSize: 12, display: 'block' }}>
                  Current download folder:
                </span>
                <code style={{
                  display: 'block',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{folderStatus.displayName || '(unnamed folder)'}</code>
              </>
            ) : (
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No folder chosen yet.
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handlePickFolder}
            disabled={nativeOnly || folderBusy}
          >
            {folderBusy
              ? 'Opening picker…'
              : folderStatus.configured ? 'Change folder' : 'Choose folder'}
          </button>
          {folderStatus.configured && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleClearFolder}
              disabled={folderBusy}
            >
              Clear
            </button>
          )}
        </div>

        {folderError && (
          <div className="sp-status sp-status-error" style={{ marginTop: 8 }}>{folderError}</div>
        )}

        <p className="settings-hint" style={{ marginTop: 8 }}>
          Permission to access the chosen folder is granted by Android when
          you accept the picker dialog and persists across restarts. To
          revoke, tap <em>Clear</em> here or remove the grant under
          Settings → Apps → Momotaro → Permissions.
        </p>
      </div>

      {/* ── Active + recent jobs ──────────────────────────────────────── */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Download Queue</h3>
        {jobs.length === 0
          ? <p className="settings-hint">No downloads yet. Open a manga and tap the download icon to queue a chapter.</p>
          : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {jobs.slice(0, 30).map(j => (
                <li
                  key={j.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{j.kind === 'series' ? `Series #${j.manga_id}` : `Chapter ${j.chapter_id}`}</strong>
                    <span style={{ color: 'var(--text-dim, #9aa)', marginLeft: 6 }}>
                      · manga #{j.manga_id}
                    </span>
                  </span>
                  <span style={{ color: 'var(--text-dim, #9aa)', fontSize: 13 }}>
                    {j.status === 'running' && j.progress
                      ? `Downloading ${j.progress.current}/${j.progress.total}…`
                      : j.status === 'failed'
                        ? `Failed — ${j.error || 'unknown error'}`
                        : j.status}
                  </span>
                  {j.status === 'failed' && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => retryJob(j.id)}
                    >Retry</button>
                  )}
                  {(j.status === 'queued' || j.status === 'running') && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => cancelJob(j.id)}
                    >Cancel</button>
                  )}
                </li>
              ))}
            </ul>
          )}
      </div>

      {/* ── Downloaded series ─────────────────────────────────────────── */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Downloaded Series</h3>
        {downloaded.length === 0
          ? <p className="settings-hint">No series downloaded yet.</p>
          : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {downloaded.map(m => (
                <li
                  key={m.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{m.title}</strong>
                    <span style={{ color: 'var(--text-dim, #9aa)', marginLeft: 6 }}>
                      · {m.chapter_count || 0} chapters
                    </span>
                  </span>
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
      </div>
    </div>
  );
}

const SECTIONS = [
  {
    id: 'statistics',
    label: 'Statistics',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
      </svg>
    ),
  },
  {
    id: 'anilist',
    label: 'AniList',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
  {
    id: 'myanimelist',
    label: 'MyAnimeList',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M8 12h8M12 8v8" />
      </svg>
    ),
  },
  {
    id: 'doujinshi',
    label: 'Doujinshi.Info',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    ),
  },
  {
    id: 'homepage',
    label: 'Homepage Settings',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
      </svg>
    ),
  },
  {
    id: 'reading',
    label: 'Reading Settings',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.396 0 2.757.35 3.5 1.294zm1 0v10.49A7.969 7.969 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804z" />
      </svg>
    ),
  },
  {
    id: 'libraries',
    label: 'Library Management',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
      </svg>
    ),
  },
  {
    id: 'clients',
    label: 'Client Management',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <line x1="12" y1="18" x2="12" y2="18" />
      </svg>
    ),
  },
  {
    id: 'portforwarding',
    label: 'Port Forwarding',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="M12 5l7 7-7 7" />
        <circle cx="4" cy="12" r="1.5" />
      </svg>
    ),
  },
  {
    id: 'sourcing',
    label: 'Third Party Sourcing',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 3a1 1 0 011 1v6.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 111.414-1.414L9 10.586V4a1 1 0 011-1z" />
        <path d="M3 14a1 1 0 011 1v1a1 1 0 001 1h10a1 1 0 001-1v-1a1 1 0 112 0v1a3 3 0 01-3 3H5a3 3 0 01-3-3v-1a1 1 0 011-1z" />
      </svg>
    ),
  },
  {
    id: 'scheduling',
    label: 'Scheduling',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15 14" />
      </svg>
    ),
  },
  {
    id: 'database',
    label: 'Database',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.657-4.03 3-9 3S3 13.657 3 12" />
        <path d="M3 5v14c0 1.657 4.03 3 9 3s9-1.343 9-3V5" />
      </svg>
    ),
  },
  {
    id: 'logs',
    label: 'System Logs',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8M8 17h8M8 9h2" />
      </svg>
    ),
  },
  {
    id: 'android',
    label: 'Android',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="4" width="12" height="16" rx="2" />
        <line x1="11" y1="17" x2="13" y2="17" />
      </svg>
    ),
  },
  {
    id: 'linux',
    label: 'Linux',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'offline',
    label: 'Offline Downloads',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
  },
];

// ── Settings page ─────────────────────────────────────────────────────────────

// Sections that require an active server connection. Each entry is the
// `s.id` from SECTIONS above. When the user is offline these sidebar
// items are greyed out and clicking them shows a "Reconnect to access"
// panel rather than the section that would otherwise hit dead API calls.
//
// Sections NOT in this set (reading, android, linux, offline) are fully usable
// offline because they only read/write client-side state — reader
// preferences in localStorage, APK/AppImage version checks (which themselves
// degrade gracefully), and the offline download manager.
const OFFLINE_LOCKED_SECTIONS = new Set([
  'statistics',
  'anilist',
  'myanimelist',
  'doujinshi',
  'homepage',
  'libraries',
  'clients',
  'portforwarding',
  'sourcing',
  'scheduling',
  'database',
  'logs',
]);

function OfflineLockedPanel({ label }) {
  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">{label}</h2>
          <p className="sp-section-desc">
            This section needs an active server connection. Restore your
            connection and return to use it — the page will resume operating
            in online mode the moment the server is reachable again.
          </p>
        </div>
      </div>
      <div className="settings-card">
        <p className="settings-hint" style={{ margin: 0 }}>
          You're currently <strong>offline</strong>. Only downloaded manga,
          the reader, and offline-download management are available right now.
        </p>
      </div>
    </div>
  );
}

export default function Settings() {
  const location = useLocation();
  const { online } = useConnectivity();
  const [section, setSection] = useState(location.state?.section || 'anilist');

  function isLocked(id) {
    return !online && OFFLINE_LOCKED_SECTIONS.has(id);
  }

  function selectSection(id) {
    // Even though the sidebar button is disabled when locked, keep this
    // guard so deep-links (location.state.section) that land on a locked
    // section also render the locked panel rather than crashing the
    // section component on dead API calls.
    setSection(id);
  }

  // If the user navigates *to* Settings on a deep-link pointing at a
  // section that's now locked (e.g. they were viewing it online, swiped
  // away, server became unreachable), bounce the selection to a section
  // that works rather than rendering an error.
  useEffect(() => {
    if (isLocked(section)) {
      // Don't change which section the URL points at; we just render
      // the locked panel for it. Selection state stays put so a flip
      // back to online renders the original section.
    }
  }, [section, online]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sp-page">
      <nav className="navbar">
        <Link to="/library" className="btn btn-ghost">← Library</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
      </nav>

      <div className="sp-layout">
        <aside className="sp-sidebar">
          <p className="sp-sidebar-heading">Settings</p>
          {SECTIONS.map(s => {
            const locked = isLocked(s.id);
            return (
              <button
                key={s.id}
                className={`sp-nav-item${section === s.id ? ' active' : ''}${locked ? ' sp-nav-item-locked' : ''}`}
                onClick={() => selectSection(s.id)}
                disabled={locked}
                title={locked ? 'Unavailable offline' : undefined}
                aria-disabled={locked}
              >
                {s.icon}
                {s.label}
                {locked && <span className="sp-nav-item-lock" aria-hidden="true">·</span>}
              </button>
            );
          })}
        </aside>

        <main className="sp-content">
          {isLocked(section) ? (
            <OfflineLockedPanel
              label={SECTIONS.find(s => s.id === section)?.label || 'Section'}
            />
          ) : (
            <>
              {section === 'statistics'  && <StatisticsSection />}
              {section === 'anilist'     && <AnilistSection />}
              {section === 'myanimelist' && <MyAnimeListSection />}
              {section === 'doujinshi'   && <DoujinshiSection />}
              {section === 'homepage'    && <HomepageSection />}
              {section === 'reading'     && <ReadingSection />}
              {section === 'libraries'   && <LibrariesSection />}
              {section === 'clients'     && <ClientManagementSection />}
              {section === 'portforwarding' && <PortForwardingSection />}
              {section === 'sourcing'    && <ThirdPartySourcingSection />}
              {section === 'scheduling'  && <SchedulingSection />}
              {section === 'database'    && <DatabaseSection />}
              {section === 'logs'        && <SystemLogsSection />}
              {section === 'android'     && <AndroidSection />}
              {section === 'linux'       && <LinuxSection />}
              {section === 'offline'     && <OfflineDownloadsSection />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
