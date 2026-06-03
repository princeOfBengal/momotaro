import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useConnectivity } from '../../context/ConnectivityContext';
import { appConfirm } from '../../dialog/dialogService';
import {
  isAvailable as offlineStorageAvailable,
  getStatus     as offlineGetStatus,
  pickFolder    as offlinePickFolder,
  clearFolder   as offlineClearFolder,
} from '../../api/offlineStorage';
import {
  listDownloads,
  cancelJob,
  retryJob,
  clearQueue as downloaderClearQueue,
  deleteSeries as downloaderDeleteSeries,
  onChange as onDownloaderChange,
  resumeAfterUnlock as downloaderResumeAfterUnlock,
} from '../../api/downloader';
import { listOfflineManga, listOfflineChaptersForManga } from '../../api/offlineDb';
import {
  isEncryptionEnabled as offlineIsEncryptionEnabled,
  isUnlocked          as offlineIsUnlocked,
  enableEncryption    as offlineEnableEncryption,
  disableEncryption   as offlineDisableEncryption,
  unlock              as offlineUnlock,
  lock                as offlineLock,
} from '../../api/offlineCrypto';
import '../Settings.css';

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
    if (!(await appConfirm(
      'Disable encryption?\n\n'
      + 'Already-downloaded encrypted chapters will become unreadable — '
      + 'you will need to delete and re-download them as plaintext. '
      + 'New downloads from now on will be saved unencrypted.',
      { danger: true, okLabel: 'Disable' },
    ))) return;
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
export default function OfflineDownloadsSection() {
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
      // The offline_manga row doesn't carry a chapter_count — the
      // canonical figure is the number of downloaded chapter folders
      // on disk, mirrored by the offline_chapters rows for the series.
      const enriched = await Promise.all(list.map(async m => {
        try {
          const chapters = await listOfflineChaptersForManga(m.id);
          return { ...m, chapter_count: chapters.length };
        } catch {
          return { ...m, chapter_count: 0 };
        }
      }));
      setDownloaded(enriched);
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
    if (!(await appConfirm(
      'Forget the current download folder?\n\n'
      + 'Already-downloaded files on disk are NOT deleted — they just '
      + 'become unreachable from inside the app until you re-pick that '
      + 'same folder. Pending downloads will pause until you pick again.',
      { okLabel: 'Forget folder' },
    ))) return;
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
    if (!(await appConfirm('Remove this downloaded series from the device? On-disk files will be deleted.', { danger: true, okLabel: 'Delete' }))) return;
    setBusy(true);
    try {
      await downloaderDeleteSeries(mangaId);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function handleClearQueue() {
    if (!(await appConfirm(
      'Clear every entry from the download queue?\n\n'
      + 'In-flight downloads will be cancelled. Already-downloaded '
      + 'chapters on disk are NOT affected — only the queue history '
      + 'and any pending work are removed.',
      { danger: true, okLabel: 'Clear queue' },
    ))) return;
    setBusy(true);
    try {
      await downloaderClearQueue();
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
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          margin: '0 0 10px',
        }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Download Queue</h3>
          {jobs.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleClearQueue}
              disabled={busy}
            >Clear queue</button>
          )}
        </div>
        {jobs.length === 0
          ? <p className="settings-hint">No downloads yet. Open a manga and tap the download icon to queue a chapter.</p>
          : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                maxHeight: 320,
                overflowY: 'auto',
              }}
            >
              {jobs.map(j => (
                <li
                  key={j.id}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    columnGap: 10,
                    rowGap: 4,
                    padding: '8px 0',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <span style={{
                    flex: '1 1 140px',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    <strong>{j.kind === 'series' ? `Series #${j.manga_id}` : `Chapter ${j.chapter_id}`}</strong>
                    <span style={{ color: 'var(--text-dim, #9aa)', marginLeft: 6 }}>
                      · manga #{j.manga_id}
                    </span>
                  </span>
                  <span style={{
                    color: 'var(--text-dim, #9aa)',
                    fontSize: 13,
                    minWidth: 0,
                    overflowWrap: 'anywhere',
                  }}>
                    {j.status === 'running' && j.progress
                      ? `Downloading ${j.progress.current}/${j.progress.total}…`
                      : j.status === 'failed'
                        ? `Failed — ${j.error || 'unknown error'}`
                        : j.status}
                  </span>
                  {(j.status === 'failed' || j.status === 'cancelled') && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => retryJob(j.id)}
                      style={{ flexShrink: 0 }}
                    >Retry</button>
                  )}
                  {(j.status === 'queued' || j.status === 'running') && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => cancelJob(j.id)}
                      style={{ flexShrink: 0 }}
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
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                maxHeight: 320,
                overflowY: 'auto',
              }}
            >
              {downloaded.map(m => (
                <li
                  key={m.id}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    columnGap: 10,
                    rowGap: 4,
                    padding: '8px 0',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <span style={{
                    flex: '1 1 160px',
                    minWidth: 0,
                    overflowWrap: 'anywhere',
                  }}>
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
                    style={{ flexShrink: 0 }}
                  >Delete</button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}
