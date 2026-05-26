import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../context/UserContext';
import './Pairing.css';
import './Login.css';

// Mirrors the server's username rule (3–32 chars: letters, digits, . _ -).
const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/i;

/**
 * Login / create-account screen. Reached when the server reports
 * `user_required` (multi-user enabled, real accounts exist, no valid session).
 * Shared across PWA / APK / AppImage — it's just the React build. Styled with
 * the pairing-wizard primitives (pw-*) plus the tab strip in Login.css.
 */
export default function Login() {
  const navigate = useNavigate();
  const { user, login, register } = useUser();

  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState(null);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  // Already logged in → leave the login screen.
  useEffect(() => { if (user) navigate('/', { replace: true }); }, [user, navigate]);

  // Lockout countdown tick.
  useEffect(() => {
    if (lockoutSeconds <= 0) return undefined;
    const t = setInterval(() => setLockoutSeconds(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [lockoutSeconds]);

  function switchMode(m) {
    setMode(m);
    setError(null);
    setAttemptsRemaining(null);
  }

  function handleErr(err) {
    setError(err.message || 'Something went wrong. Please try again.');
    const body = err.body || {};
    if (typeof body.attempts_remaining === 'number') setAttemptsRemaining(body.attempts_remaining);
    if (typeof body.seconds_remaining === 'number' && body.seconds_remaining > 0) {
      setLockoutSeconds(body.seconds_remaining);
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || lockoutSeconds > 0) return;
    setError(null);
    setAttemptsRemaining(null);

    const u = username.trim();
    if (!USERNAME_RE.test(u)) {
      setError('Username must be 3–32 characters: letters, numbers, and . _ -');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (mode === 'register' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'login') await login(u, password);
      else                  await register(u, password, displayName.trim() || undefined);
      navigate('/', { replace: true });
    } catch (err) {
      handleErr(err);
    } finally {
      setSubmitting(false);
    }
  }

  const locked = lockoutSeconds > 0;
  const fmt = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  };

  return (
    <div className="pw-page">
      <div className="pw-card">
        <img src="/logo.png" alt="" className="pw-logo" />
        <h1 className="pw-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="pw-subtitle">
          {mode === 'login'
            ? 'Log in to see your library, reading progress, lists, and stats.'
            : 'Your reading progress, lists, and stats stay private to your account.'}
        </p>

        <div className="lg-tabs" role="tablist">
          <button
            type="button" role="tab" aria-selected={mode === 'login'}
            className={`lg-tab${mode === 'login' ? ' active' : ''}`}
            onClick={() => switchMode('login')}
          >
            Log in
          </button>
          <button
            type="button" role="tab" aria-selected={mode === 'register'}
            className={`lg-tab${mode === 'register' ? ' active' : ''}`}
            onClick={() => switchMode('register')}
          >
            Create account
          </button>
        </div>

        <form onSubmit={onSubmit}>
          <div className="pw-field">
            <label className="pw-label">Username</label>
            <input
              className="pw-input"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              maxLength={32}
              autoFocus
            />
          </div>

          {mode === 'register' && (
            <div className="pw-field">
              <label className="pw-label">Display name <span className="lg-optional">(optional)</span></label>
              <input
                className="pw-input"
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                maxLength={64}
              />
            </div>
          )}

          <div className="pw-field">
            <label className="pw-label">Password</label>
            <input
              className="pw-input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          {mode === 'register' && (
            <div className="pw-field">
              <label className="pw-label">Confirm password</label>
              <input
                className="pw-input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
              />
            </div>
          )}

          {error && <p className="pw-error">{error}</p>}
          {attemptsRemaining != null && attemptsRemaining > 0 && !locked && (
            <p className="pw-hint">
              {attemptsRemaining} attempt{attemptsRemaining === 1 ? '' : 's'} remaining before this device is locked.
            </p>
          )}
          {locked && <p className="pw-error">Too many attempts — this device is locked. Try again in {fmt(lockoutSeconds)}.</p>}

          <div className="pw-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting || locked}>
              {submitting
                ? (mode === 'login' ? 'Logging in…' : 'Creating…')
                : (mode === 'login' ? 'Log in' : 'Create account')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
