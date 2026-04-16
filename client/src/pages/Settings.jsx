import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import './Settings.css';
import './Libraries.css';
import '../components/ReaderControls.css';

// ── Shared library form ───────────────────────────────────────────────────────

function LibraryForm({ initialName = '', initialPath = '', submitLabel, onSubmit, onCancel, error }) {
  const [name, setName] = useState(initialName);
  const [libPath, setLibPath] = useState(initialPath);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim() || !libPath.trim()) return;
    setSaving(true);
    try {
      await onSubmit(name.trim(), libPath.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="lp-form" onSubmit={handleSubmit}>
      <div className="lp-form-fields">
        <div className="lp-field">
          <label className="lp-label">Library name</label>
          <input
            className="lp-input"
            placeholder="e.g. Manga, Comics, Light Novels"
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="lp-field">
          <label className="lp-label">Folder path on server</label>
          <input
            className="lp-input lp-input-mono"
            placeholder="e.g. /data/manga  or  C:\manga"
            value={libPath}
            onChange={e => setLibPath(e.target.value)}
          />
        </div>
      </div>
      {error && <p className="lp-form-error">{error}</p>}
      <div className="lp-form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || !name.trim() || !libPath.trim()}
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Section: Library Management ───────────────────────────────────────────────

function LibrariesSection() {
  const [libraries, setLibraries] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editError, setEditError] = useState(null);
  const [scanning, setScanning] = useState(null);
  const [bulkPulling, setBulkPulling] = useState(null);
  const [bulkStatus, setBulkStatus] = useState(null); // { libId, message }
  const [bulkOptimizing, setBulkOptimizing] = useState(null);
  const [bulkSourceDropdown, setBulkSourceDropdown] = useState(null); // lib.id of open dropdown

  useEffect(() => {
    api.getLibraries().then(data => setLibraries(data)).catch(() => setLibraries([]));
  }, []);

  async function handleAdd(name, path) {
    setAddError(null);
    try {
      const lib = await api.createLibrary({ name, path });
      setLibraries(prev => [...prev, lib]);
      setShowAdd(false);
    } catch (err) {
      setAddError(err.message);
      throw err;
    }
  }

  async function handleEdit(id, name, path) {
    setEditError(null);
    try {
      const updated = await api.updateLibrary(id, { name, path });
      setLibraries(prev => prev.map(l => l.id === id ? updated : l));
      setEditId(null);
    } catch (err) {
      setEditError(err.message);
      throw err;
    }
  }

  async function handleDelete(lib) {
    const confirmed = window.confirm(
      `Delete library "${lib.name}"?\n\n` +
      `This will remove all ${lib.manga_count} series from Momotaro. ` +
      `Files on disk will not be affected.`
    );
    if (!confirmed) return;
    try {
      await api.deleteLibrary(lib.id);
      setLibraries(prev => prev.filter(l => l.id !== lib.id));
      if (editId === lib.id) setEditId(null);
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  async function handleToggleShowInAll(lib) {
    try {
      const updated = await api.updateLibrary(lib.id, { show_in_all: lib.show_in_all ? 0 : 1 });
      setLibraries(prev => prev.map(l => l.id === lib.id ? updated : l));
    } catch (err) {
      alert('Failed to update: ' + err.message);
    }
  }

  async function handleScan(lib) {
    setScanning(lib.id);
    try {
      await api.scanLibrary(lib.id);
      setTimeout(() => {
        api.getLibraries().then(data => setLibraries(data)).catch(() => {});
        setScanning(s => s === lib.id ? null : s);
      }, 3000);
    } catch (err) {
      alert('Scan failed: ' + err.message);
      setScanning(s => s === lib.id ? null : s);
    }
  }

  async function handleBulkMetadata(lib, source) {
    setBulkSourceDropdown(null);
    setBulkPulling(lib.id);
    setBulkStatus(null);
    try {
      const result = await api.bulkMetadata(lib.id, source);
      const { to_fetch, skipped_existing, total } = result;
      let message;
      if (to_fetch === 0) {
        message = `All ${total} titles already have metadata — nothing to pull.`;
      } else if (skipped_existing > 0) {
        message = `Pulling metadata for ${to_fetch} title${to_fetch !== 1 ? 's' : ''} in the background. ${skipped_existing} skipped (already have metadata).`;
      } else {
        message = `Pulling metadata for ${to_fetch} title${to_fetch !== 1 ? 's' : ''} in the background.`;
      }
      setBulkStatus({ libId: lib.id, message });
    } catch (err) {
      alert('Bulk metadata pull failed: ' + err.message);
    } finally {
      setBulkPulling(null);
    }
  }

  async function handleBulkOptimize(lib) {
    setBulkOptimizing(lib.id);
    try {
      await api.bulkOptimize(lib.id);
    } catch (err) {
      alert('Bulk optimize failed: ' + err.message);
    } finally {
      setBulkOptimizing(null);
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Library Management</h2>
          <p className="sp-section-desc">
            Each library points to a folder on the server. Momotaro scans it for manga
            series and watches for new additions automatically.
          </p>
        </div>
        {!showAdd && (
          <button
            className="btn btn-primary"
            style={{ flexShrink: 0 }}
            onClick={() => { setShowAdd(true); setAddError(null); setEditId(null); }}
          >
            + Add Library
          </button>
        )}
      </div>

      {showAdd && (
        <div className="lp-add-card">
          <p className="lp-add-title">New Library</p>
          <LibraryForm
            submitLabel="Add Library"
            onSubmit={handleAdd}
            onCancel={() => { setShowAdd(false); setAddError(null); }}
            error={addError}
          />
        </div>
      )}

      {libraries === null ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : libraries.length === 0 && !showAdd ? (
        <div className="lp-empty">
          <div className="lp-empty-icon">📚</div>
          <h2>No libraries yet</h2>
          <p>Click <strong>+ Add Library</strong> to point Momotaro at a folder of manga.</p>
        </div>
      ) : (
        <div className="lp-list">
          {libraries.map(lib => (
            <div key={lib.id} className={`lp-card${editId === lib.id ? ' lp-card-editing' : ''}`}>
              {editId === lib.id ? (
                <>
                  <div className="lp-card-edit-header">
                    <span className="lp-card-edit-label">Editing: {lib.name}</span>
                  </div>
                  <LibraryForm
                    initialName={lib.name}
                    initialPath={lib.path}
                    submitLabel="Save Changes"
                    onSubmit={(name, path) => handleEdit(lib.id, name, path)}
                    onCancel={() => { setEditId(null); setEditError(null); }}
                    error={editError}
                  />
                </>
              ) : (
                <>
                  <div className="lp-card-info">
                    <div className="lp-card-name-row">
                      <span className="lp-lib-name">{lib.name}</span>
                      <span className="lp-lib-badge">{lib.manga_count} series</span>
                    </div>
                    <div className="lp-card-path-row">
                      <svg className="lp-folder-icon" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                      <span className="lp-lib-path">{lib.path}</span>
                    </div>
                    <div className="lp-card-toggle-row">
                      <span className="lp-toggle-label">Show in All Libraries</span>
                      <button
                        className={`lp-toggle${lib.show_in_all ? ' on' : ''}`}
                        onClick={() => handleToggleShowInAll(lib)}
                        title={lib.show_in_all ? 'Hide from All Libraries view' : 'Show in All Libraries view'}
                      >
                        <span className="lp-toggle-thumb" />
                      </button>
                    </div>
                  </div>
                  <div className="lp-card-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleScan(lib)}
                      disabled={scanning === lib.id}
                    >
                      {scanning === lib.id ? 'Scanning…' : 'Scan Now'}
                    </button>
                    <div className="lp-bulk-meta-wrap">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setBulkSourceDropdown(bulkSourceDropdown === lib.id ? null : lib.id)}
                        disabled={bulkPulling === lib.id || scanning === lib.id}
                        title="Search for metadata for each title in this library"
                      >
                        {bulkPulling === lib.id ? 'Pulling…' : 'Bulk Metadata Pull ▾'}
                      </button>
                      {bulkSourceDropdown === lib.id && (
                        <div className="lp-bulk-meta-dropdown">
                          <button
                            className="lp-bulk-meta-option"
                            onClick={() => handleBulkMetadata(lib, 'anilist')}
                          >
                            AniList
                          </button>
                          <button
                            className="lp-bulk-meta-option"
                            onClick={() => handleBulkMetadata(lib, 'doujinshi')}
                          >
                            Doujinshi.info
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleBulkOptimize(lib)}
                      disabled={bulkOptimizing === lib.id || scanning === lib.id}
                      title="Rename and convert all chapters in this library to standardized CBZ format"
                    >
                      {bulkOptimizing === lib.id ? 'Optimizing…' : 'Bulk Optimize'}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setEditId(lib.id); setEditError(null); setShowAdd(false); }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-sm lp-btn-danger"
                      onClick={() => handleDelete(lib)}
                    >
                      Delete
                    </button>
                  </div>
                  {bulkStatus?.libId === lib.id && (
                    <p className="lp-bulk-status">{bulkStatus.message}</p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section: AniList ──────────────────────────────────────────────────────────

function AnilistSection() {
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

// ── Section: Doujinshi.Info ───────────────────────────────────────────────────

function DoujinshiSection() {
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
    if (!confirm('Log out of Doujinshi.info?')) return;
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

// ── Section: Reading Settings ─────────────────────────────────────────────────

function ToggleRow({ label, desc, value, onChange }) {
  return (
    <div className="setting-row">
      <div className="setting-row-info">
        <span className="setting-row-label">{label}</span>
        {desc && <span className="setting-row-desc">{desc}</span>}
      </div>
      <button
        className={`toggle-switch ${value ? 'on' : ''}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

function ReadingSection() {
  const [readingMode, setReadingMode]             = useState(() => localStorage.getItem('reader_readingMode') || 'rtl');
  const [readingOrientation, setReadingOrientation] = useState(() => localStorage.getItem('reader_orientation') || 'ltr');
  const [animateTransitions, setAnimateTransitions] = useState(() => localStorage.getItem('reader_animTrans') === 'true');
  const [gesturesEnabled, setGesturesEnabled]     = useState(() => localStorage.getItem('reader_gestures') !== 'false');
  const [alwaysFullscreen, setAlwaysFullscreen]   = useState(() => localStorage.getItem('reader_alwaysFS') === 'true');
  const [bgColor, setBgColor]                     = useState(() => localStorage.getItem('reader_bgColor') || 'black');
  const [grayscale, setGrayscale]                 = useState(() => localStorage.getItem('reader_grayscale') === 'true');
  const [scaleType, setScaleType]                 = useState(() => localStorage.getItem('reader_scaleType') || 'screen');
  const [pageLayout, setPageLayout]               = useState(() => localStorage.getItem('reader_pageLayout') || 'single');

  useEffect(() => { localStorage.setItem('reader_readingMode',  readingMode); },         [readingMode]);
  useEffect(() => { localStorage.setItem('reader_orientation',  readingOrientation); },  [readingOrientation]);
  useEffect(() => { localStorage.setItem('reader_animTrans',    animateTransitions); },  [animateTransitions]);
  useEffect(() => { localStorage.setItem('reader_gestures',     gesturesEnabled); },     [gesturesEnabled]);
  useEffect(() => { localStorage.setItem('reader_alwaysFS',     alwaysFullscreen); },    [alwaysFullscreen]);
  useEffect(() => { localStorage.setItem('reader_bgColor',      bgColor); },             [bgColor]);
  useEffect(() => { localStorage.setItem('reader_grayscale',    grayscale); },           [grayscale]);
  useEffect(() => { localStorage.setItem('reader_scaleType',    scaleType); },           [scaleType]);
  useEffect(() => { localStorage.setItem('reader_pageLayout',   pageLayout); },          [pageLayout]);

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Reading Settings</h2>
          <p className="sp-section-desc">
            Default settings used when opening the reader. All of these can also be changed
            from within the reader itself.
          </p>
        </div>
      </div>

      {/* General */}
      <div className="rs-group">
        <p className="rs-group-title">General</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Reading Mode</label>
            <div className="setting-options setting-options-grid">
              {[
                { value: 'ltr',      label: 'Left to Right' },
                { value: 'rtl',      label: 'Right to Left' },
                { value: 'vertical', label: 'Vertical' },
                { value: 'webtoon',  label: 'Webtoon' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${readingMode === value ? ' active' : ''}`}
                  onClick={() => setReadingMode(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Reading Orientation</label>
            <p className="rs-setting-hint">Controls which side the next page appears on in double-page mode.</p>
            <div className="setting-options">
              {[
                { value: 'ltr', label: 'Left to Right' },
                { value: 'rtl', label: 'Right to Left' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${readingOrientation === value ? ' active' : ''}`}
                  onClick={() => setReadingOrientation(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <ToggleRow
            label="Animate Page Transitions"
            value={animateTransitions}
            onChange={setAnimateTransitions}
          />
          <ToggleRow
            label="Gestures"
            desc="Touch swipe, double-tap to zoom"
            value={gesturesEnabled}
            onChange={setGesturesEnabled}
          />
          <ToggleRow
            label="Always Full Screen"
            value={alwaysFullscreen}
            onChange={setAlwaysFullscreen}
          />
        </div>
      </div>

      {/* Display */}
      <div className="rs-group">
        <p className="rs-group-title">Display</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Background Color</label>
            <div className="setting-options">
              {[
                { value: 'black', label: 'Black' },
                { value: 'gray',  label: 'Gray' },
                { value: 'white', label: 'White' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn setting-btn-color setting-btn-color-${value}${bgColor === value ? ' active' : ''}`}
                  onClick={() => setBgColor(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <ToggleRow
            label="Grayscale"
            desc="Render pages without color"
            value={grayscale}
            onChange={setGrayscale}
          />
        </div>
      </div>

      {/* Paged Mode */}
      <div className="rs-group">
        <p className="rs-group-title">Paged Mode</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Scale Type</label>
            <select
              className="setting-select"
              value={scaleType}
              onChange={e => setScaleType(e.target.value)}
            >
              <option value="screen">Screen</option>
              <option value="fit-width">Fit Width</option>
              <option value="fit-width-shrink">Fit Width (Shrink Only)</option>
              <option value="fit-height">Fit Height</option>
              <option value="original">Original</option>
            </select>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Page Layout</label>
            <select
              className="setting-select"
              value={pageLayout}
              onChange={e => setPageLayout(e.target.value)}
            >
              <option value="single">Single Page</option>
              <option value="double">Double Page</option>
              <option value="double-manga">Double Page (Manga)</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section: Database Management ─────────────────────────────────────────────

function DatabaseSection() {
  const [cacheSize, setCacheSize] = useState(null);   // bytes | null = loading
  const [clearing, setClearing] = useState(false);

  const [thumbStatus, setThumbStatus] = useState('idle'); // 'idle' | 'loading' | 'done' | 'error'
  const [thumbTotal, setThumbTotal] = useState(null);

  const [vacuumStatus, setVacuumStatus] = useState('idle'); // 'idle' | 'loading' | 'done' | 'error'
  const [vacuumResult, setVacuumResult] = useState(null); // { before, after }

  useEffect(() => {
    api.getCbzCacheSize()
      .then(d => setCacheSize(d.size_bytes))
      .catch(() => setCacheSize(0));
  }, []);

  async function handleClearCache() {
    setClearing(true);
    try {
      const d = await api.clearCbzCache();
      setCacheSize(d.size_bytes);
    } catch (err) {
      alert('Failed to clear cache: ' + err.message);
    } finally {
      setClearing(false);
    }
  }

  async function handleRegenerate() {
    setThumbStatus('loading');
    setThumbTotal(null);
    try {
      const d = await api.regenerateThumbnails();
      setThumbTotal(d.total);
      setThumbStatus('done');
    } catch (err) {
      setThumbStatus('error');
    }
  }

  async function handleVacuum() {
    setVacuumStatus('loading');
    setVacuumResult(null);
    try {
      const d = await api.vacuumDb();
      setVacuumResult({ before: d.size_before_bytes, after: d.size_after_bytes });
      setVacuumStatus('done');
    } catch (err) {
      setVacuumStatus('error');
    }
  }

  function fmtMB(bytes) {
    if (bytes === null) return '…';
    if (bytes === 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return mb < 0.1 ? '<0.1 MB' : `${mb.toFixed(1)} MB`;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Database Management</h2>
          <p className="sp-section-desc">
            Tools for maintaining Momotaro's database and on-disk cache.
          </p>
        </div>
      </div>

      {/* CBZ Cache */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">CBZ Cache</p>
            <p className="db-op-desc">
              Pages from CBZ archives are extracted to disk the first time they are read and
              cached for faster subsequent access. The cache is safe to clear at any time —
              pages will be re-extracted from the original files on next access.
            </p>
            <p className="db-op-status">
              Current size: <strong>{fmtMB(cacheSize)}</strong>
            </p>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ flexShrink: 0, alignSelf: 'flex-start' }}
            onClick={handleClearCache}
            disabled={clearing || cacheSize === null}
          >
            {clearing ? 'Clearing…' : 'Clear Cache'}
          </button>
        </div>
      </div>

      {/* Regenerate Thumbnails */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">Regenerate Thumbnails</p>
            <p className="db-op-desc">
              Rebuilds cover thumbnails for every manga in the library. Useful when thumbnails
              become mismatched after manga are added or removed. If AniList metadata has been
              pulled for a title, its AniList cover is restored as the active thumbnail.
              Otherwise, a new thumbnail is generated from the first page of the first chapter.
            </p>
            {thumbStatus === 'done' && (
              <p className="db-op-status db-op-status-ok">
                Regeneration started for {thumbTotal} manga. Thumbnails will update in the background.
              </p>
            )}
            {thumbStatus === 'error' && (
              <p className="db-op-status db-op-status-err">Failed — try again.</p>
            )}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ flexShrink: 0, alignSelf: 'flex-start' }}
            onClick={handleRegenerate}
            disabled={thumbStatus === 'loading'}
          >
            {thumbStatus === 'loading' ? 'Starting…' : 'Regenerate All'}
          </button>
        </div>
      </div>

      {/* Compact Database */}
      <div className="settings-card">
        <div className="db-op-row">
          <div className="db-op-info">
            <p className="db-op-title">Compact Database</p>
            <p className="db-op-desc">
              Defragments the SQLite database file and reclaims disk space left over from
              deleted records. Safe to run at any time — most useful after removing a large
              number of manga or chapters.
            </p>
            {vacuumStatus === 'done' && vacuumResult && (
              <p className="db-op-status db-op-status-ok">
                Compacted: {fmtMB(vacuumResult.before)} → {fmtMB(vacuumResult.after)}
              </p>
            )}
            {vacuumStatus === 'error' && (
              <p className="db-op-status db-op-status-err">Failed — try again.</p>
            )}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ flexShrink: 0, alignSelf: 'flex-start' }}
            onClick={handleVacuum}
            disabled={vacuumStatus === 'loading'}
          >
            {vacuumStatus === 'loading' ? 'Compacting…' : 'Compact Database'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section: Statistics ───────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatReadTime(minutes) {
  if (!minutes) return '0 min';
  if (minutes < 60) return `${minutes} min`;
  const h = (minutes / 60).toFixed(1);
  return `${h} hr${h === '1.0' ? '' : 's'}`;
}

const STAT_TILES = [
  {
    key: 'total_manga',
    label: 'Total Series',
    unit: 'Series',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
  },
  {
    key: 'total_chapters',
    label: 'Total Chapters',
    unit: 'Chapters',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    key: 'total_size_bytes',
    label: 'Total Size',
    unit: null,
    format: formatBytes,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
      </svg>
    ),
  },
  {
    key: 'total_genres',
    label: 'Total Genres',
    unit: 'Genres',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
      </svg>
    ),
  },
  {
    key: 'estimated_read_time_minutes',
    label: 'Est. Read Time',
    unit: null,
    format: formatReadTime,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </svg>
    ),
  },
];

function StatisticsSection() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.getStats()
      .then(data => { setStats(data); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, []);

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Statistics</h2>
          <p className="sp-section-desc">An overview of your manga library.</p>
        </div>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : error ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Failed to load statistics.</p>
      ) : (
        <>
          {/* ── Stat tiles ── */}
          <div className="stat-tiles">
            {STAT_TILES.map(tile => {
              const raw = stats[tile.key];
              const display = tile.format ? tile.format(raw) : `${(raw ?? 0).toLocaleString()}`;
              const valueLabel = tile.unit ? `${display} ${tile.unit}` : display;
              return (
                <div key={tile.key} className="stat-tile">
                  <span className="stat-tile-label">{tile.label}</span>
                  <span className="stat-tile-icon">{tile.icon}</span>
                  <span className="stat-tile-value">{valueLabel}</span>
                </div>
              );
            })}
          </div>

          {/* ── Ranked lists ── */}
          <div className="stat-grid">
            {/* Popular Series */}
            <div className="stat-list-box">
              <div className="stat-list-header">
                <span className="stat-list-title">Popular Series</span>
                <span className="stat-list-col-label">Read</span>
              </div>
              {stats.top_manga.length === 0 ? (
                <p className="stat-list-empty">No reading history yet.</p>
              ) : stats.top_manga.map((m, i) => (
                <div key={m.id} className="stat-list-item">
                  <span className="stat-list-rank">{i + 1}</span>
                  <span className={`stat-list-bar${i > 0 ? ' dim' : ''}`} />
                  {m.cover_url && (
                    <img className="stat-list-thumb" src={m.cover_url} alt="" />
                  )}
                  <span className="stat-list-name">{m.title}</span>
                  <span className="stat-list-count">
                    {m.chapters_read > 0 ? `${m.chapters_read} ch` : '—'}
                  </span>
                </div>
              ))}
            </div>

            {/* Popular Genres */}
            <div className="stat-list-box">
              <div className="stat-list-header">
                <span className="stat-list-title">Popular Genres</span>
                <span className="stat-list-col-label">Series</span>
              </div>
              {stats.top_genres.length === 0 ? (
                <p className="stat-list-empty">No genre data found.</p>
              ) : stats.top_genres.map((g, i) => (
                <div key={g.genre} className="stat-list-item">
                  <span className="stat-list-rank">{i + 1}</span>
                  <span className={`stat-list-bar${i > 0 ? ' dim' : ''}`} />
                  <span className="stat-list-name">{g.genre}</span>
                  <span className="stat-list-count">{g.count}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Nav sections config ───────────────────────────────────────────────────────

const SECTIONS = [
  {
    id: 'statistics',
    label: 'Statistics',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
      </svg>
    ),
  },
  {
    id: 'anilist',
    label: 'AniList',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
  {
    id: 'doujinshi',
    label: 'Doujinshi.Info',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    ),
  },
  {
    id: 'reading',
    label: 'Reading Settings',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.396 0 2.757.35 3.5 1.294zm1 0v10.49A7.969 7.969 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804z" />
      </svg>
    ),
  },
  {
    id: 'libraries',
    label: 'Library Management',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
      </svg>
    ),
  },
  {
    id: 'database',
    label: 'Database',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.657-4.03 3-9 3S3 13.657 3 12" />
        <path d="M3 5v14c0 1.657 4.03 3 9 3s9-1.343 9-3V5" />
      </svg>
    ),
  },
];

// ── Settings page ─────────────────────────────────────────────────────────────

export default function Settings() {
  const location = useLocation();
  const [section, setSection] = useState(location.state?.section || 'anilist');

  return (
    <div className="sp-page">
      <nav className="navbar">
        <Link to="/" className="btn btn-ghost">← Library</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
      </nav>

      <div className="sp-layout">
        <aside className="sp-sidebar">
          <p className="sp-sidebar-heading">Settings</p>
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={`sp-nav-item${section === s.id ? ' active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </aside>

        <main className="sp-content">
          {section === 'statistics'  && <StatisticsSection />}
          {section === 'anilist'    && <AnilistSection />}
          {section === 'doujinshi'  && <DoujinshiSection />}
          {section === 'reading'    && <ReadingSection />}
          {section === 'libraries'  && <LibrariesSection />}
          {section === 'database'   && <DatabaseSection />}
        </main>
      </div>
    </div>
  );
}
