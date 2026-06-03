import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { appConfirm } from '../../dialog/dialogService';
import '../Settings.css';

export default function MyAnimeListSection() {
  const [settings, setSettings] = useState(null);
  const [clientId, setClientId] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  useEffect(() => {
    api.getSettings().then(data => {
      setSettings(data);
    }).catch(() => {});
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    if (!clientId.trim()) return;
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.saveMalClientId(clientId.trim());
      setSettings(prev => ({ ...prev, mal_client_id_set: true }));
      setClientId('');
      setStatusMsg({ type: 'success', text: 'Client ID saved.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Failed to save: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!(await appConfirm('Remove the MyAnimeList Client ID?', { okLabel: 'Remove' }))) return;
    setSaving(true);
    setStatusMsg(null);
    try {
      await api.saveMalClientId('');
      setSettings(prev => ({ ...prev, mal_client_id_set: false }));
      setStatusMsg({ type: 'success', text: 'Client ID removed.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">MyAnimeList Integration</h2>
          <p className="sp-section-desc">
            Provide a MyAnimeList API Client ID to enable metadata search and bulk pulls
            from{' '}
            <a href="https://myanimelist.net" target="_blank" rel="noreferrer">MyAnimeList</a>.
            No login is required — only the Client ID is needed to query manga metadata.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      <div className="settings-card">
        {settings.mal_client_id_set ? (
          <>
            <p className="settings-username">Client ID configured</p>
            <p className="settings-hint">
              MyAnimeList metadata is available from the Metadata panel on any manga page
              and via Bulk Metadata Pull in Library Management.
            </p>
            <div className="settings-token-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleClear}
                disabled={saving}
                style={{ alignSelf: 'flex-start' }}
              >
                {saving ? 'Removing…' : 'Remove Client ID'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-oauth-intro">To get a Client ID, create a free API client on MyAnimeList:</p>
            <ol className="settings-steps">
              <li>
                Go to{' '}
                <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noreferrer">
                  MyAnimeList → API Config
                </a>{' '}
                and click <strong>Create ID</strong>
              </li>
              <li>Fill in App Name and App Type, then copy the <strong>Client ID</strong></li>
              <li>Paste the Client ID below and click Save</li>
            </ol>
            <form className="settings-token-form" onSubmit={handleSave}>
              <label className="settings-label">Client ID</label>
              <input
                type="text"
                className="settings-input"
                placeholder="Paste your MAL Client ID…"
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                autoComplete="off"
              />
              <div className="settings-token-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || !clientId.trim()}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
