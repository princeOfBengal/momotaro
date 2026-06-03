import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { appAlert } from '../../dialog/dialogService';
import '../Settings.css';

export default function SystemLogsSection() {
  const [entries, setEntries] = useState(null);
  const [max, setMax] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSystemLogs();
      setEntries(data.entries || []);
      setMax(data.max);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleExport() {
    // Fetch + blob so the X-Admin-Token header rides along (window.location.href
    // can't carry headers, and the mount-line requireAdmin gate doesn't accept
    // ?t= the way requireClientOrAdmin does).
    try { await api.exportSystemLogs(); }
    catch (err) { appAlert('Export failed: ' + err.message); }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">System Logs</h2>
          <p className="sp-section-desc">
            Recent server console output. The server keeps the last
            {max ? ` ${max.toLocaleString()} ` : ' '}
            log lines in memory — older entries are discarded. Export to save a
            snapshot to a <code>.txt</code> file.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleExport}
            disabled={!entries || entries.length === 0}
          >
            Export as .txt
          </button>
        </div>
      </div>

      {error && (
        <div className="sp-status sp-status-error">Failed to load logs: {error}</div>
      )}

      {entries === null ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : entries.length === 0 ? (
        <div className="settings-card">
          <p className="settings-hint" style={{ margin: 0 }}>No log entries captured yet.</p>
        </div>
      ) : (
        <div className="logs-viewer">
          {entries.map((e, i) => (
            <div key={i} className={`logs-line logs-line-${e.level}`}>
              <span className="logs-ts">{e.ts}</span>
              <span className={`logs-level logs-level-${e.level}`}>{e.level.toUpperCase()}</span>
              <span className="logs-msg">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
