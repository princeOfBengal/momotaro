import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { appAlert, appConfirm } from '../../dialog/dialogService';
import { useAdminTaskButton } from '../../hooks/useAdminTaskButton';
import '../Settings.css';
import '../Libraries.css';

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

export default function LibrariesSection() {
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
    const confirmed = await appConfirm(
      `Delete library "${lib.name}"?\n\n` +
      `This will remove all ${lib.manga_count} series from Momotaro. ` +
      `Files on disk will not be affected.`,
      { danger: true, okLabel: 'Delete' },
    );
    if (!confirmed) return;
    try {
      await api.deleteLibrary(lib.id);
      setLibraries(prev => prev.filter(l => l.id !== lib.id));
      if (editId === lib.id) setEditId(null);
    } catch (err) {
      appAlert('Delete failed: ' + err.message);
    }
  }

  async function handleToggleShowInAll(lib) {
    try {
      const updated = await api.updateLibrary(lib.id, { show_in_all: lib.show_in_all ? 0 : 1 });
      setLibraries(prev => prev.map(l => l.id === lib.id ? updated : l));
    } catch (err) {
      appAlert('Failed to update: ' + err.message);
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
      appAlert('Scan failed: ' + err.message);
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
      appAlert('Bulk metadata pull failed: ' + err.message);
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
      appAlert('Reset metadata failed: ' + err.message);
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
      appAlert('Metadata export failed: ' + err.message);
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
