import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api/client';
import { appAlert, appConfirm } from '../../dialog/dialogService';
import { useAdminTaskButton } from '../../hooks/useAdminTaskButton';
import { formatNextRun } from '../../utils/format';
import '../Settings.css';
import '../../components/ReaderControls.css';

const GB = 1024 * 1024 * 1024;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function DatabaseSection() {
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

  // Fetch + blob download so the X-Admin-Token header rides along — the
  // mount-line requireAdmin gate accepts only the header, so a bare
  // window.location.href navigation would 401. The server's Content-Disposition
  // header still drives the saved filename via _adminDownload.
  async function handleExportConfig() {
    try { await api.exportConfig(); }
    catch (err) { appAlert('Export failed: ' + err.message); }
  }

  async function handleExportSeriesList() {
    try { await api.exportSeriesList(); }
    catch (err) { appAlert('Export failed: ' + err.message); }
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

    const confirmed = await appConfirm(
      'Import this configuration?\n\n' +
      'This will overwrite settings, API keys, reading lists, reading progress, ' +
      'and saved art gallery entries in the current database. ' +
      'Manga metadata (AniList/MAL links, etc.) will be reapplied where the ' +
      'scanner has already indexed the matching manga.\n\n' +
      'This cannot be undone.',
      { danger: true, okLabel: 'Import' },
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
