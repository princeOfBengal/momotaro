import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useConnectivity } from '../context/ConnectivityContext';
import { __attachAdminHost } from './dialogService';
import { acquireScrollLock } from './scrollLock';
import './Dialog.css';

// Imperative companion to <RequireAdminAccess>. Mounts once near the root
// and registers itself with the dialog service; callers anywhere in the
// app then write:
//
//   import { ensureAdminAccess } from '@/dialog/dialogService';
//   if (!(await ensureAdminAccess())) return;
//   doTheGatedThing();
//
// On a fresh install with no admin password set, the modal swaps its
// password form for a "configure first" pointer at Settings → Client
// Management so the user has a single click to fix the prerequisite.
export default function AdminUnlockDialog() {
  const navigate = useNavigate();
  const { online } = useConnectivity();
  const [resolver, setResolver] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [pw, setPw]                 = useState('');
  const [error, setError]           = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const detach = __attachAdminHost((resolve) => {
      // Reset transient state every time the dialog is re-shown — a
      // previous cancel left `error`/`pw` set and we want a clean slate.
      setPw('');
      setError(null);
      setSubmitting(false);
      setConfigured(true);  // optimistic; flipped if the probe says otherwise
      setResolver(() => resolve);
      // Probe server config in the background. If it answers "not
      // configured" we flip the UI to the setup-pointer branch; transient
      // probe failures are ignored so a flaky network doesn't lock out the
      // password form.
      api.getAuthStatus()
        .then((d) => { if (d && d.configured === false) setConfigured(false); })
        .catch(() => { /* ignore — keep the password form visible */ });
    });
    return detach;
  }, []);

  useEffect(() => {
    if (resolver && inputRef.current) {
      inputRef.current.focus?.();
    }
  }, [resolver, configured]);

  useEffect(() => {
    if (!resolver) return;
    return acquireScrollLock();
  }, [resolver]);

  const close = useCallback((result) => {
    const r = resolver;
    setResolver(null);
    setPw('');
    setError(null);
    if (r) r(result);
  }, [resolver]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!pw || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.adminLogin(pw);
      close(true);
    } catch (err) {
      setError(err?.message || 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    }
  }

  if (!resolver) return null;

  return (
    <div
      className="app-dialog-backdrop app-dialog-backdrop-elevated"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-unlock-title"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) close(false); }}
    >
      <div className="app-dialog">
        <h2 id="admin-unlock-title" className="app-dialog-title">
          Admin access required
        </h2>

        {!configured ? (
          <>
            <p className="app-dialog-message">
              No admin password has been set for this server yet. Create
              one under Settings → Client Management, then try again.
            </p>
            <div className="app-dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => close(false)}
              >Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  close(false);
                  navigate('/settings', { state: { section: 'clients' } });
                }}
              >Open Settings</button>
            </div>
          </>
        ) : (
          <>
            <p className="app-dialog-message">
              This action is restricted to the server admin. Enter the
              admin password to continue.
            </p>
            <form className="app-dialog-form" onSubmit={handleSubmit}>
              <input
                ref={inputRef}
                type="password"
                className="app-dialog-input"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Admin password"
                autoComplete="current-password"
                // autoFocus as a backup for the imperative focus() call —
                // iOS Safari will reject programmatic focus once the click
                // gesture's task tick has elapsed, but it honours the
                // attribute when the element first mounts.
                autoFocus
                disabled={submitting || !online}
              />
              {!online && (
                <p className="app-dialog-error">
                  You're offline — the admin password can only be verified
                  while the server is reachable.
                </p>
              )}
              {error && <p className="app-dialog-error">{error}</p>}
              <div className="app-dialog-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => close(false)}
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
