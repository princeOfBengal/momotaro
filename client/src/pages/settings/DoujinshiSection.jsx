import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { appConfirm } from '../../dialog/dialogService';
import '../Settings.css';

export default function DoujinshiSection() {
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
    if (!(await appConfirm('Log out of Doujinshi.info?', { okLabel: 'Log out' }))) return;
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
