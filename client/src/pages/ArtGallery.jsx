import React, { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AppSidebar from '../components/AppSidebar';
import ArtGalleryRibbon from '../components/ArtGalleryRibbon';
import './Library.css';
import './Home.css';

// Dedicated Art Gallery page. One ribbon per series, full-image (uncropped)
// tiles so landscape spreads display at their natural aspect ratio.
export default function ArtGallery() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [libraries, setLibraries] = useState([]);
  const [readingLists, setReadingLists] = useState([]);

  const loadLibraries    = useCallback(() => {
    api.getLibraries().then(d => setLibraries(d)).catch(() => {});
  }, []);
  const loadReadingLists = useCallback(() => {
    api.getReadingLists().then(d => setReadingLists(d)).catch(() => {});
  }, []);

  useEffect(() => {
    loadLibraries();
    loadReadingLists();
  }, [loadLibraries, loadReadingLists]);

  const load = useCallback(async () => {
    try {
      const data = await api.getAllGallery();
      setGroups(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalItems = (groups || []).reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div className="library-page home-page">
      <nav className="navbar">
        <button
          className="lib-hamburger"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/" className="navbar-brand">
          <img src="/logo.png" alt="Momotaro" className="navbar-logo" />
        </Link>
        <div className="navbar-spacer" />
        <Link to="/library" className="btn btn-ghost home-nav-btn">
          Library
        </Link>
        <button
          className="btn-settings"
          onClick={() => navigate('/settings')}
          aria-label="Open settings"
          title="Settings"
        >
          ⚙
        </button>
      </nav>

      <div
        className={`library-drawer-backdrop${drawerOpen ? ' open' : ''}`}
        onClick={() => setDrawerOpen(false)}
      />

      <div className="library-layout">
        <AppSidebar
          libraries={libraries}
          readingLists={readingLists}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
          onReadingListsChanged={loadReadingLists}
        />

        <main className="home-main">
          <header className="genres-header">
            <h1 className="genres-title">Art Gallery</h1>
            <p className="genres-sub">
              Every page you've saved, grouped by series.
            </p>
          </header>

          {error && (
            <div className="error-message">
              <h2>Failed to load gallery</h2>
              <p>{error}</p>
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={load}>
                Retry
              </button>
            </div>
          )}

          {!error && groups === null && (
            <div className="loading-center" style={{ minHeight: 240 }}>
              <div className="spinner" />
            </div>
          )}

          {!error && groups !== null && groups.length === 0 && (
            <div className="home-empty">
              <div className="home-empty-icon">🖼️</div>
              <h2>No saved art yet</h2>
              <p>Save a page from the reader and it'll show up here.</p>
            </div>
          )}

          {!error && groups !== null && groups.length > 0 && (
            <>
              <p className="library-count">
                {totalItems} {totalItems === 1 ? 'page' : 'pages'} across {groups.length} {groups.length === 1 ? 'series' : 'series'}
              </p>
              {groups.map(g => (
                <ArtGalleryRibbon
                  key={g.manga_id}
                  items={g.items}
                  title={g.manga_title}
                  titleHref={`/manga/${g.manga_id}`}
                  fullSize
                />
              ))}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
