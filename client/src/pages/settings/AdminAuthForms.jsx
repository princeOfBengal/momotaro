import React, { useState } from 'react';
import { api } from '../../api/client';
import '../Settings.css';

// Shared between ClientManagementSection, PortForwardingSection, and the
// AdminGuard wrapper. Same UX surface for the three first-run/login flows.
// Imports Settings.css directly so its `.settings-card` / `.cm-*` classes
// resolve even if a future caller doesn't happen to have pulled Settings.css
// in their own import graph. `.lp-form-error` lives in the eager
// styles/global.css, so it's available on every route.

export function AdminSetupForm({ onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (pw !== pw2)    { setError('Passwords do not match.'); return; }
    setSaving(true);
    try {
      await api.adminSetup(pw);
      onDone({ type: 'success', text: 'Admin account created.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card">
      <p className="cm-block-title">Create admin password</p>
      <p className="settings-hint" style={{ marginBottom: 14 }}>
        This password unlocks Client Management and any future security
        settings. There is only one admin account per server — keep this
        password safe; there is no recovery option.
      </p>
      <form className="settings-token-form" onSubmit={handleSubmit}>
        <label className="settings-label">Password</label>
        <input
          type="password"
          className="settings-input"
          value={pw}
          onChange={e => setPw(e.target.value)}
          autoComplete="new-password"
          autoFocus
        />
        <label className="settings-label" style={{ marginTop: 8 }}>Confirm password</label>
        <input
          type="password"
          className="settings-input"
          value={pw2}
          onChange={e => setPw2(e.target.value)}
          autoComplete="new-password"
        />
        {error && <p className="lp-form-error" style={{ marginTop: 8 }}>{error}</p>}
        <div className="settings-token-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !pw || !pw2}>
            {saving ? 'Creating...' : 'Create admin password'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function AdminLoginForm({ onDone }) {
  const [pw, setPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.adminLogin(pw);
      onDone({ type: 'success', text: 'Logged in.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card">
      <p className="cm-block-title">Admin login</p>
      <form className="settings-token-form" onSubmit={handleSubmit}>
        <label className="settings-label">Password</label>
        <input
          type="password"
          className="settings-input"
          value={pw}
          onChange={e => setPw(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />
        {error && <p className="lp-form-error" style={{ marginTop: 8 }}>{error}</p>}
        <div className="settings-token-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !pw}>
            {saving ? 'Logging in...' : 'Log in'}
          </button>
        </div>
      </form>
    </div>
  );
}
