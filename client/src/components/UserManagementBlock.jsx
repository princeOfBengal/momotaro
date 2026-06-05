import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { appConfirm, appPrompt } from '../dialog/dialogService';

// Admin "User accounts" panel, rendered inside Client Management (admin-gated).
// Gives the operator total control over every account (requirement #10):
// multi-user toggles, create, reset password, enable/disable, force-logout,
// export, delete, all-users history CSV, and login-lockout clearing.

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  fontSize: 13,
};

export default function UserManagementBlock({ authStatus, setStatusMsg, onAuthChange }) {
  const [users, setUsers] = useState([]);
  const [lockouts, setLockouts] = useState([]);
  const [newU, setNewU] = useState('');
  const [newP, setNewP] = useState('');
  const [newAdmin, setNewAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const notify = (type, text) => { if (setStatusMsg) setStatusMsg({ type, text }); };

  const refresh = useCallback(async () => {
    try {
      const [u, ll] = await Promise.all([
        api.adminListUsers().catch(() => []),
        api.adminGetLoginLockouts().catch(() => null),
      ]);
      setUsers(Array.isArray(u) ? u : []);
      setLockouts(ll?.active_lockouts || []);
    } catch (_) { /* ignore */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function toggle(key, next) {
    try { await api.saveSecuritySettings({ [key]: next }); if (onAuthChange) onAuthChange(); }
    catch (e) { notify('error', 'Save failed: ' + e.message); }
  }

  async function createUser(e) {
    e.preventDefault();
    if (!newU.trim() || newP.length < 8) { notify('error', 'Username and an 8+ character password are required.'); return; }
    setBusy(true);
    try {
      await api.adminCreateUser({ username: newU.trim(), password: newP, is_admin: newAdmin });
      setNewU(''); setNewP(''); setNewAdmin(false);
      notify('success', 'Account created.');
      refresh();
    } catch (err) { notify('error', err.message); }
    finally { setBusy(false); }
  }

  async function resetPassword(u) {
    const pw = await appPrompt(
      `New password for @${u.username} (min 8 characters):`,
      '',
      { inputType: 'password', okLabel: 'Reset', autoComplete: 'new-password' },
    );
    if (pw == null) return;
    if (pw.length < 8) { notify('error', 'Password must be at least 8 characters.'); return; }
    try {
      await api.adminUpdateUser(u.id, { new_password: pw });
      notify('success', `Password reset for @${u.username}; their sessions were revoked.`);
      refresh();
    } catch (e) { notify('error', e.message); }
  }

  async function toggleDisabled(u) {
    try { await api.adminUpdateUser(u.id, { disabled: !u.disabled }); refresh(); }
    catch (e) { notify('error', e.message); }
  }

  async function forceLogout(u) {
    try { await api.adminRevokeUserSessions(u.id); notify('success', `@${u.username} signed out on all devices.`); refresh(); }
    catch (e) { notify('error', e.message); }
  }

  async function exportUser(u) {
    try { await api.adminExportUser(u.id); } catch (e) { notify('error', 'Export failed: ' + e.message); }
  }

  async function deleteUser(u) {
    if (!(await appConfirm(`Delete @${u.username}? This permanently removes their progress, lists, and history.`, { danger: true, okLabel: 'Delete' }))) return;
    try { await api.adminDeleteUser(u.id); notify('success', `Deleted @${u.username}.`); refresh(); }
    catch (e) { notify('error', e.message); }
  }

  async function clearLockout(key) {
    try { await api.adminClearLoginLockout(key); refresh(); }
    catch (e) { notify('error', e.message); }
  }

  return (
    <div className="cm-block">
      <p className="cm-block-title">User accounts</p>
      <p className="cm-toggle-help" style={{ marginBottom: 12 }}>
        Each account has its own reading lists, progress, history, stats, and AniList login.
        You can view, export, or delete any account's data.
      </p>

      <div className="cm-toggle-row">
        <div>
          <div className="cm-toggle-label">Multi-user accounts</div>
          <div className="cm-toggle-help">
            When on, each device must log in. When off, everyone shares one library as the default user.
          </div>
        </div>
        <button
          className={`toggle-switch ${authStatus.multi_user_enabled ? 'on' : ''}`}
          role="switch" aria-checked={!!authStatus.multi_user_enabled}
          onClick={() => toggle('multi_user_enabled', !authStatus.multi_user_enabled)}
        />
      </div>

      <div className="cm-toggle-row">
        <div>
          <div className="cm-toggle-label">Allow account creation</div>
          <div className="cm-toggle-help">When off, only you (admin) can create accounts on this server.</div>
        </div>
        <button
          className={`toggle-switch ${authStatus.allow_registration ? 'on' : ''}`}
          role="switch" aria-checked={!!authStatus.allow_registration}
          onClick={() => toggle('allow_registration', !authStatus.allow_registration)}
        />
      </div>

      <form onSubmit={createUser} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '16px 0' }}>
        <input style={inputStyle} placeholder="username" value={newU} onChange={e => setNewU(e.target.value)} maxLength={32} autoCapitalize="none" />
        <input style={inputStyle} type="password" placeholder="password" value={newP} onChange={e => setNewP(e.target.value)} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={newAdmin} onChange={e => setNewAdmin(e.target.checked)} /> admin
        </label>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>Create account</button>
      </form>

      <div className="cm-client-list">
        {users.length === 0 && <p className="cm-toggle-help">No accounts yet.</p>}
        {users.map(u => (
          <div key={u.id} className="cm-client-row">
            <div>
              <div className="cm-client-name">
                @{u.username}{u.is_admin ? ' · admin' : ''}{u.disabled ? ' · disabled' : ''}
              </div>
              <div className="cm-client-meta">
                {u.progress_count} read · {u.list_count} lists · {u.history_count} history · {u.active_sessions} sessions
                {u.anilist_linked ? ' · AniList linked' : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => exportUser(u)}>Export</button>
              <button className="btn btn-ghost btn-sm" onClick={() => resetPassword(u)}>Reset PW</button>
              <button className="btn btn-ghost btn-sm" onClick={() => forceLogout(u)}>Sign out</button>
              <button className="btn btn-ghost btn-sm" onClick={() => toggleDisabled(u)}>{u.disabled ? 'Enable' : 'Disable'}</button>
              <button className="btn btn-ghost btn-sm" style={{ color: '#f44336' }} onClick={() => deleteUser(u)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => api.adminDownloadReadingHistoryCsv().catch(e => notify('error', e.message))}>
          Download all-users reading history (CSV)
        </button>
      </div>

      {lockouts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <p className="cm-block-title">Login lockouts</p>
          {lockouts.map(l => (
            <div key={l.lockout_key} className="cm-client-row">
              <div className="cm-client-meta">
                {l.lockout_key} · {l.failed_attempts} failed · until {new Date(l.locked_until * 1000).toLocaleString()}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => clearLockout(l.lockout_key)}>Clear</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
