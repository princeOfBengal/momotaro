import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSidebar } from '../context/SidebarContext';
import { api } from '../api/client';
import './Sidebar.css';

export default function Sidebar() {
  const { isOpen, close } = useSidebar();
  const navigate = useNavigate();

  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  // Load settings whenever the sidebar opens
  useEffect(() => {
    if (!isOpen) return;
    api.getSettings()
      .then(data => {
        setSettings(data);
        setClientId(data.anilist_client_id || '');
      })
      .catch(() => {});
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

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
      setStatusMsg({ type: 'success', text: 'Logged out.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Logout failed: ' + err.message });
    } finally {
      setLoggingOut(false);
    }
  }

  const canLogin = settings && !!clientId.trim() && settings.anilist_client_secret_set;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`sidebar-backdrop ${isOpen ? 'sidebar-backdrop-visible' : ''}`}
        onClick={close}
      />

      {/* Panel */}
      <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <span className="sidebar-title">Settings</span>
          <button className="sidebar-close" onClick={close} aria-label="Close settings">✕</button>
        </div>

        <div className="sidebar-body">

          {/* Status message */}
          {statusMsg && (
            <div className={`sidebar-status sidebar-status-${statusMsg.type}`}>
              {statusMsg.text}
            </div>
          )}

          {/* ── Navigation ── */}
          <section className="sidebar-section">
            <h3 className="sidebar-section-title">Manage</h3>
            <button
              className="sidebar-nav-item"
              onClick={() => { close(); navigate('/libraries'); }}
            >
              <svg className="sidebar-nav-icon" viewBox="0 0 20 20" fill="currentColor">
                <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
              Libraries
              <svg className="sidebar-nav-chevron" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
              </svg>
            </button>
          </section>

          {/* ── AniList Account section ── */}
          <section className="sidebar-section">
            <h3 className="sidebar-section-title">AniList Account</h3>

            {!settings ? (
              <div className="sidebar-loading"><div className="spinner" style={{ width: 24, height: 24, borderWidth: 2 }} /></div>
            ) : settings.anilist_logged_in ? (
              /* Logged in state */
              <div className="sidebar-user-card">
                <div className="sidebar-user-row">
                  {settings.anilist_avatar && (
                    <img
                      className="sidebar-avatar"
                      src={settings.anilist_avatar}
                      alt={settings.anilist_username}
                    />
                  )}
                  <div className="sidebar-user-info">
                    <p className="sidebar-username">{settings.anilist_username}</p>
                    <a
                      className="sidebar-profile-link"
                      href={`https://anilist.co/user/${settings.anilist_username}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View Profile
                    </a>
                  </div>
                </div>
                <p className="sidebar-sync-note">
                  Reading progress syncs to your AniList automatically.
                </p>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleLogout}
                  disabled={loggingOut}
                >
                  {loggingOut ? 'Logging out...' : 'Log Out'}
                </button>
              </div>
            ) : (
              /* Logged out state */
              <>
                <p className="sidebar-desc">
                  Log in to track your reading progress on AniList automatically.
                </p>

                <div className="sidebar-steps">
                  <p className="sidebar-steps-title">Setup:</p>
                  <ol>
                    <li>
                      Go to{' '}
                      <a href="https://anilist.co/settings/developer" target="_blank" rel="noreferrer">
                        AniList → Settings → Developer
                      </a>{' '}
                      and create a new client
                    </li>
                    <li>
                      Set Redirect URL to:<br />
                      <code className="sidebar-code">{window.location.origin}/auth/anilist/callback</code>
                    </li>
                    <li>Paste the Client ID and Client Secret below</li>
                  </ol>
                </div>

                <form className="sidebar-form" onSubmit={handleSaveCredentials}>
                  <label className="sidebar-label">Client ID</label>
                  <input
                    type="text"
                    className="sidebar-input"
                    placeholder="e.g. 38687"
                    value={clientId}
                    onChange={e => setClientId(e.target.value)}
                    autoComplete="off"
                  />

                  <label className="sidebar-label">
                    Client Secret
                    {settings.anilist_client_secret_set && (
                      <span className="sidebar-saved-note"> (saved)</span>
                    )}
                  </label>
                  <input
                    type="password"
                    className="sidebar-input"
                    placeholder={settings.anilist_client_secret_set
                      ? 'Leave blank to keep existing'
                      : 'Paste client secret...'}
                    value={clientSecret}
                    onChange={e => setClientSecret(e.target.value)}
                    autoComplete="off"
                  />

                  <div className="sidebar-form-actions">
                    <button
                      type="submit"
                      className="btn btn-ghost btn-sm"
                      disabled={saving || !clientId.trim()}
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    {canLogin && (
                      <a className="btn btn-primary btn-sm" href={buildOAuthUrl()}>
                        Login with AniList
                      </a>
                    )}
                  </div>

                  {!canLogin && clientId.trim() && (
                    <p className="sidebar-hint">
                      {!settings.anilist_client_secret_set
                        ? 'Enter your Client Secret to enable login.'
                        : ''}
                    </p>
                  )}
                </form>
              </>
            )}
          </section>

        </div>
      </aside>
    </>
  );
}
