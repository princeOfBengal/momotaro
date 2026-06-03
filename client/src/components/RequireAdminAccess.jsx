import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useConnectivity } from '../context/ConnectivityContext';
import './RequireAdminAccess.css';

// Route wrapper that gates a page behind the server's admin password.
//
// On mount it asks the server (`/api/admin/auth-status`) whether the caller
// already holds a valid admin session. When they do, the wrapped children
// mount as normal. Otherwise an inline modal collects the admin password,
// calls `api.adminLogin`, and re-checks; the children mount once the token
// is valid. Cancelling sends the user back to where they came from (Home
// when there is no history to fall back on — opening a gated URL directly
// shouldn't leave them on a blank screen).
//
// The "configured: false" branch covers the fresh-install case where no
// admin password has ever been set: there is nothing to authenticate
// against, so we tell the user to set one up in Settings → Client
// Management first and offer a one-click jump there.
export default function RequireAdminAccess({ children }) {
  const navigate = useNavigate();
  const { online } = useConnectivity();
  const [status, setStatus] = useState({ loading: true });
  const [pw, setPw] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    // Offline: there is no way to verify the token against the server, so
    // we trust whatever is in localStorage. The wrapped page already
    // renders an offline-aware panel when the network is down, and any
    // gated API call it eventually makes will surface a real error.
    if (!online && api.getAdminToken()) {
      setStatus({ loading: false, configured: true, logged_in: true });
      return;
    }
    try {
      const data = await api.getAuthStatus();
      setStatus({
        loading:    false,
        configured: !!data?.configured,
        logged_in:  !!data?.logged_in,
      });
    } catch (err) {
      // Status probe failed (server unreachable / transient). If we still
      // hold a token locally we let the user through — same trust policy
      // as the offline branch above.
      if (api.getAdminToken()) {
        setStatus({ loading: false, configured: true, logged_in: true });
        return;
      }
      setStatus({
        loading:    false,
        configured: false,
        logged_in:  false,
        fetchError: err?.message || 'Could not reach the server.',
      });
    }
  }, [online]);

  useEffect(() => { refresh(); }, [refresh]);

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate('/', { replace: true });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!pw || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.adminLogin(pw);
      setPw('');
      await refresh();
    } catch (err) {
      setError(err?.message || 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  }

  if (status.loading) {
    return (
      <div className="loading-center" style={{ minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (status.logged_in) return children;

  const notConfigured = !status.configured;

  return (
    <div
      className="admin-prompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-prompt-title"
    >
      <div className="admin-prompt-modal">
        <h2 id="admin-prompt-title" className="admin-prompt-title">
          Admin access required
        </h2>

        {notConfigured ? (
          <>
            <p className="admin-prompt-desc">
              No admin password has been set for this server yet. Create one
              under <strong>Settings → Client Management</strong>, then come
              back to open this page.
            </p>
            {status.fetchError && (
              <p className="admin-prompt-error">{status.fetchError}</p>
            )}
            <div className="admin-prompt-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={goBack}
              >Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate('/settings', { state: { section: 'clients' } })}
              >Open Settings</button>
            </div>
          </>
        ) : (
          <>
            <p className="admin-prompt-desc">
              This page is restricted to the server admin. Enter the admin
              password to continue.
            </p>
            <form className="admin-prompt-form" onSubmit={handleSubmit}>
              <label className="admin-prompt-label" htmlFor="admin-prompt-pw">
                Admin password
              </label>
              <input
                id="admin-prompt-pw"
                type="password"
                className="admin-prompt-input"
                value={pw}
                onChange={e => setPw(e.target.value)}
                autoFocus
                autoComplete="current-password"
                disabled={submitting || !online}
              />
              {!online && (
                <p className="admin-prompt-error">
                  You're offline — the admin password can only be verified
                  while the server is reachable.
                </p>
              )}
              {error && <p className="admin-prompt-error">{error}</p>}
              <div className="admin-prompt-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={goBack}
                  disabled={submitting}
                >Cancel</button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting || !pw || !online}
                >{submitting ? 'Checking…' : 'Unlock'}</button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
