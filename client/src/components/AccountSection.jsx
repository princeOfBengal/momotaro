import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../context/UserContext';
import { api } from '../api/client';
import { appAlert, appConfirm } from '../dialog/dialogService';

// "Account" settings section: the logged-in user, a log-out button, password
// change, data exports, and their own reading-history timeline. In single-user
// / pre-accounts mode there's no session, so it offers a link to log in /
// create an account instead.
export default function AccountSection() {
  const navigate = useNavigate();
  const { user, logout } = useUser();
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);

  // Change-password form state. `pwMsg` is `{ type: 'success' | 'error', text }`
  // — same vocabulary the Settings page uses elsewhere for inline status lines.
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw]         = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwSaving, setPwSaving]   = useState(false);
  const [pwMsg, setPwMsg]         = useState(null);

  const [exportingHistory, setExportingHistory] = useState(false);
  const [exportingLists,   setExportingLists]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setHistory([]); return undefined; }
    api.getHistory(100)
      .then(h => { if (!cancelled) setHistory(Array.isArray(h) ? h : []); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [user]);

  async function handleLogout() {
    setBusy(true);
    try { await logout(); navigate('/login', { replace: true }); }
    catch (_) { setBusy(false); }
  }

  async function handleClearHistory() {
    if (!(await appConfirm('Clear your reading history? This cannot be undone.', { danger: true, okLabel: 'Clear' }))) return;
    try { await api.clearHistory(); setHistory([]); }
    catch (e) { appAlert('Failed to clear history: ' + e.message); }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPwMsg(null);
    if (newPw.length < 8) {
      setPwMsg({ type: 'error', text: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }
    setPwSaving(true);
    try {
      // Server revokes every other session for this account; the response
      // includes a fresh token for this device that the client helper has
      // already persisted, so the next request still authenticates.
      await api.changeUserPassword(currentPw, newPw);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      setPwMsg({ type: 'success', text: 'Password updated. Other devices have been signed out.' });
    } catch (err) {
      setPwMsg({ type: 'error', text: err.message || 'Failed to change password.' });
    } finally {
      setPwSaving(false);
    }
  }

  async function handleExportHistory() {
    setExportingHistory(true);
    try { await api.exportReadingHistoryCsv(); }
    catch (e) { appAlert('Export failed: ' + e.message); }
    finally { setExportingHistory(false); }
  }

  async function handleExportLists() {
    setExportingLists(true);
    try { await api.exportReadingListsCsv(); }
    catch (e) { appAlert('Export failed: ' + e.message); }
    finally { setExportingLists(false); }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Account</h2>
          <p className="sp-section-desc">
            Your account and reading history. Reading progress, lists, favourite
            genres, and stats are private to your account and sync across your devices.
          </p>
        </div>
      </div>

      {user ? (
        <>
          <div className="cm-block">
            <p className="cm-block-title">Signed in</p>
            <p className="settings-hint">
              <strong>{user.display_name || user.username}</strong> (@{user.username}){user.is_admin ? ' · admin' : ''}
            </p>
            <button className="btn btn-ghost" onClick={handleLogout} disabled={busy} style={{ marginTop: 12 }}>
              {busy ? 'Logging out…' : 'Log out'}
            </button>
          </div>

          <div className="cm-block">
            <p className="cm-block-title">Change password</p>
            <p className="settings-hint">
              Updating your password signs you out of every other device. This
              device stays signed in.
            </p>
            <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxWidth: 360 }}>
              <input
                type="password"
                className="settings-input"
                placeholder="Current password"
                autoComplete="current-password"
                value={currentPw}
                onChange={e => setCurrentPw(e.target.value)}
                disabled={pwSaving}
                required
              />
              <input
                type="password"
                className="settings-input"
                placeholder="New password (min. 8 characters)"
                autoComplete="new-password"
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                disabled={pwSaving}
                required
                minLength={8}
              />
              <input
                type="password"
                className="settings-input"
                placeholder="Confirm new password"
                autoComplete="new-password"
                value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)}
                disabled={pwSaving}
                required
                minLength={8}
              />
              <div>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={pwSaving || !currentPw || !newPw || !confirmPw}
                >
                  {pwSaving ? 'Saving…' : 'Update password'}
                </button>
              </div>
              {pwMsg && (
                <p
                  className="settings-hint"
                  style={{ color: pwMsg.type === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-primary)' }}
                >
                  {pwMsg.text}
                </p>
              )}
            </form>
          </div>

          <div className="cm-block">
            <p className="cm-block-title">Export your data</p>
            <p className="settings-hint">
              Download a CSV snapshot of your reading lists or your full reading
              history. Files are scoped to your account.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleExportLists}
                disabled={exportingLists}
              >
                {exportingLists ? 'Preparing…' : 'Export reading lists (.csv)'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleExportHistory}
                disabled={exportingHistory}
              >
                {exportingHistory ? 'Preparing…' : 'Export reading history (.csv)'}
              </button>
            </div>
          </div>

          <div className="cm-block">
            <p className="cm-block-title">Reading history</p>
            {history === null ? (
              <p className="settings-hint">Loading…</p>
            ) : history.length === 0 ? (
              <p className="settings-hint">No reading history yet — finish a chapter and it will show up here.</p>
            ) : (
              <>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {history.map(h => (
                    <li key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-primary)' }}>
                        {h.manga_title || `#${h.manga_id}`}
                        {h.chapter_number != null ? ` · ch. ${h.chapter_number}` : ''}
                      </span>
                      <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {h.event} · {new Date(h.read_at * 1000).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
                <button className="btn btn-ghost btn-sm" onClick={handleClearHistory} style={{ marginTop: 12 }}>
                  Clear history
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="cm-block">
          <p className="settings-hint">
            You're browsing as the shared default user (multi-user mode is off, or you haven't logged in).
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/login')} style={{ marginTop: 12 }}>
            Log in / Create account
          </button>
        </div>
      )}
    </div>
  );
}
