import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { formatBytes, formatReadTime } from '../../utils/format';
import '../Settings.css';

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

export default function StatisticsSection() {
  const [libraries, setLibraries] = useState(null);
  // null = All Libraries; otherwise a numeric library ID.
  const [selectedLib, setSelectedLib] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.getLibraries().then(data => setLibraries(data)).catch(() => setLibraries([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(false);
    api.getStats(selectedLib)
      .then(data => { setStats(data); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, [selectedLib]);

  // Show the switcher only when more than one library exists — with a single
  // library the All / Lib-A distinction is redundant.
  const showSwitcher = libraries && libraries.length > 1;

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Statistics</h2>
          <p className="sp-section-desc">An overview of your manga library.</p>
        </div>
      </div>

      {showSwitcher && (
        <div className="setting-options" style={{ flexWrap: 'wrap', marginBottom: 20 }}>
          <button
            className={`setting-btn${selectedLib === null ? ' active' : ''}`}
            onClick={() => setSelectedLib(null)}
          >
            All Libraries
          </button>
          {libraries.map(lib => (
            <button
              key={lib.id}
              className={`setting-btn${selectedLib === lib.id ? ' active' : ''}`}
              onClick={() => setSelectedLib(lib.id)}
              title={lib.path}
            >
              {lib.name}
            </button>
          ))}
        </div>
      )}

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

            {/* Favorite Genres — weighted by chapters read */}
            <div className="stat-list-box">
              <div className="stat-list-header">
                <span className="stat-list-title">Favorite Genres</span>
                <span className="stat-list-col-label">Chapters Read</span>
              </div>
              {stats.favorite_genres?.length ? (
                stats.favorite_genres.map((g, i) => (
                  <div key={g.genre} className="stat-list-item">
                    <span className="stat-list-rank">{i + 1}</span>
                    <span className={`stat-list-bar${i > 0 ? ' dim' : ''}`} />
                    <span className="stat-list-name">{g.genre}</span>
                    <span className="stat-list-count">{g.chapters_read}</span>
                  </div>
                ))
              ) : (
                <p className="stat-list-empty">
                  Read some chapters to rank your favourite genres.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
