import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../context/UserContext';
import { api } from '../api/client';

// "Account" settings section: the logged-in user, a log-out button, and their
// own reading-history timeline. In single-user / pre-accounts mode there's no
// session, so it offers a link to log in / create an account instead.
export default function AccountSection() {
  const navigate = useNavigate();
  const { user, logout } = useUser();
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);

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
    if (!window.confirm('Clear your reading history? This cannot be undone.')) return;
    try { await api.clearHistory(); setHistory([]); }
    catch (e) { window.alert('Failed to clear history: ' + e.message); }
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
