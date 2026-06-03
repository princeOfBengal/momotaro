import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { appConfirm } from '../../dialog/dialogService';
import '../Settings.css';

export default function AnilistSection() {
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
    if (!(await appConfirm('Log out of AniList?', { okLabel: 'Log out' }))) return;
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
