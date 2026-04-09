import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

/**
 * Landing page for the AniList OAuth Authorization Code redirect.
 * AniList appends the auth code as a query param:
 *   /auth/anilist/callback?code=AUTH_CODE
 */
export default function AnilistCallback() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('Completing login...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (!code) {
      setError('No authorization code found in the redirect URL. Please try again.');
      return;
    }

    // The redirect_uri sent to the exchange endpoint must match the one
    // that was registered on AniList and used in the authorize URL.
    const redirectUri = window.location.origin + '/auth/anilist/callback';

    api.anilistExchange(code, redirectUri)
      .then(user => {
        setStatus(`Logged in as ${user.username}. Redirecting...`);
        setTimeout(() => navigate('/settings', { replace: true }), 1500);
      })
      .catch(err => {
        setError('Login failed: ' + err.message);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      color: 'var(--text-primary)',
      fontFamily: 'inherit',
    }}>
      {error ? (
        <>
          <p style={{ color: '#f44336', fontSize: 15 }}>{error}</p>
          <button
            className="btn btn-ghost"
            onClick={() => navigate('/settings', { replace: true })}
          >
            Back to Settings
          </button>
        </>
      ) : (
        <>
          <div className="spinner" />
          <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{status}</p>
        </>
      )}
    </div>
  );
}
