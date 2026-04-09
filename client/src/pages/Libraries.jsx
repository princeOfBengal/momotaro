import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import './Libraries.css';

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
        <div className="lp-field lp-field-path">
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
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Libraries page ────────────────────────────────────────────────────────────

export default function Libraries() {
  const [libraries, setLibraries] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editError, setEditError] = useState(null);
  const [scanning, setScanning] = useState(null);

  useEffect(() => {
    api.getLibraries()
      .then(data => setLibraries(data))
      .catch(() => setLibraries([]));
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
    const newVal = lib.show_in_all ? 0 : 1;
    try {
      const updated = await api.updateLibrary(lib.id, { show_in_all: newVal });
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

  return (
    <div className="lp-page">
      <nav className="navbar">
        <Link to="/" className="btn btn-ghost">← Library</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
      </nav>

      <main className="lp-main">
        {/* ── Page header ── */}
        <div className="lp-page-header">
          <div>
            <h1 className="lp-title">Libraries</h1>
            <p className="lp-desc">
              Each library points to a folder on the server. Momotaro scans it for manga
              series and watches for new additions automatically.
            </p>
          </div>
          {!showAdd && (
            <button
              className="btn btn-primary"
              onClick={() => { setShowAdd(true); setAddError(null); setEditId(null); }}
            >
              + Add Library
            </button>
          )}
        </div>

        {/* ── Add form ── */}
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

        {/* ── Library list ── */}
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
                        title="Scan this library for new manga"
                      >
                        {scanning === lib.id ? 'Scanning…' : 'Scan Now'}
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
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
