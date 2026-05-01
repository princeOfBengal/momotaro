import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import MangaCard from '../components/MangaCard';
import AppSidebar from '../components/AppSidebar';
import './Library.css';
// Reuse the skeleton classes (.skeleton-block, .skeleton-line, .skeleton-tile)
// already defined for Home — same precedent as Home importing Library.css.
import './Home.css';

// Initial-load skeleton — renders placeholder cards inside the same
// .manga-grid so vertical real-estate is reserved before data arrives. Only
// shown when the grid is empty; refetches over existing data keep the real
// grid visible to avoid blink.
function LibrarySkeleton() {
  const tiles = Array.from({ length: 24 });
  return (
    <div aria-hidden="true">
      <div className="skeleton-line skeleton-title" style={{ marginBottom: 16 }} />
      <div className="manga-grid">
        {tiles.map((_, i) => (
          <div className="manga-card skeleton-tile" key={i}>
            <div className="manga-card-cover skeleton-block" />
            <div className="manga-card-info">
              <div className="skeleton-line skeleton-line-md" />
              <div className="skeleton-line skeleton-line-xs" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Library() {
  const navigate = useNavigate();
  const location = useLocation();
  const [manga, setManga] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(location.state?.search ?? '');
  const [sort, setSort] = useState(() => {
    const saved = localStorage.getItem('home_default_sort');
    return ['title', 'updated', 'year', 'rating'].includes(saved) ? saved : 'title';
  });
  const [scanning, setScanning] = useState(false);

  // Libraries
  const [libraries, setLibraries] = useState([]);
  const [activeLibrary, setActiveLibrary] = useState(location.state?.library ?? null);

  // Reading lists
  const [readingLists, setReadingLists] = useState([]);
  const [activeList, setActiveList] = useState(location.state?.list ?? null);

  // Mobile drawer
  const [drawerOpen, setDrawerOpen] = useState(false);

  function loadLibraries() {
    api.getLibraries().then(data => setLibraries(data)).catch(() => {});
  }

  function loadReadingLists() {
    api.getReadingLists().then(data => setReadingLists(data)).catch(() => {});
  }

  useEffect(() => {
    loadLibraries();
    loadReadingLists();
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      let data;
      if (activeList !== null) {
        data = await api.getReadingListManga(activeList, { search, sort });
      } else {
        const params = { search, sort };
        if (activeLibrary !== null) params.library_id = activeLibrary;
        data = await api.getLibrary(params);
      }
      setManga(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, sort, activeLibrary, activeList]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  function selectAll()        { setActiveLibrary(null); setActiveList(null);  setDrawerOpen(false); }
  function selectLibrary(id)  { setActiveLibrary(id);   setActiveList(null);  setDrawerOpen(false); }
  function selectList(id)     { setActiveList(id);       setActiveLibrary(null); setDrawerOpen(false); }

  async function handleScan() {
    setScanning(true);
    try {
      await api.triggerScan();
      setTimeout(() => {
        load();
        loadLibraries();
        setScanning(false);
      }, 3000);
    } catch {
      setScanning(false);
    }
  }

  return (
    <div className="library-page">
      <nav className="navbar">
        {/* Hamburger — mobile only */}
        <button
          className="lib-hamburger"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
        <div className="library-search-wrap">
          <input
            className="library-search"
            type="search"
            placeholder="Search by title, artist, or genre (e.g. Romance, Drama)"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="navbar-spacer" />
        {/* Sort + Scan — hidden on mobile, shown in lib-mobile-bar */}
        <select
          className="library-sort lib-desktop-only"
          value={sort}
          onChange={e => setSort(e.target.value)}
        >
          <option value="title">A–Z</option>
          <option value="updated">Recently Updated</option>
          <option value="year">Year</option>
          <option value="rating">Rating</option>
        </select>
        <button className="btn btn-ghost lib-desktop-only" onClick={handleScan} disabled={scanning}>
          {scanning ? 'Scanning...' : 'Scan Library'}
        </button>
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">
          ⚙
        </button>
      </nav>

      {/* Mobile-only: sort + scan toolbar */}
      <div className="lib-mobile-bar">
        <select className="library-sort" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="title">A–Z</option>
          <option value="updated">Recently Updated</option>
          <option value="year">Year</option>
          <option value="rating">Rating</option>
        </select>
        <button className="btn btn-ghost btn-sm" onClick={handleScan} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {/* Drawer backdrop */}
      <div
        className={`library-drawer-backdrop${drawerOpen ? ' open' : ''}`}
        onClick={() => setDrawerOpen(false)}
      />

      <div className="library-layout">
        <AppSidebar
          libraries={libraries}
          readingLists={readingLists}
          activeLibrary={activeLibrary}
          activeList={activeList}
          onSelectAll={selectAll}
          onSelectLibrary={selectLibrary}
          onSelectList={selectList}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
          onReadingListsChanged={loadReadingLists}
        />

        <main className="library-main">
          {/* Initial load — no data yet. Skeleton replaces the spinner so
              vertical real-estate is reserved and first paint feels instant. */}
          {loading && manga.length === 0 && !error && (
            <LibrarySkeleton />
          )}

          {/* Initial-load failure — full-page error. Refetch errors over
              existing data fall through to the inline banner below. */}
          {error && manga.length === 0 && (
            <div className="error-message">
              <h2>Failed to load library</h2>
              <p>{error}</p>
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={load}>
                Retry
              </button>
            </div>
          )}

          {!loading && !error && manga.length === 0 && (
            <div className="library-empty">
              {libraries.length === 0 && !search && activeList === null ? (
                <>
                  <div className="library-empty-icon">📂</div>
                  <h2>Welcome to Momotaro</h2>
                  <p>To get started, add a library folder in Settings.</p>
                  <button
                    className="btn btn-primary"
                    style={{ marginTop: 16 }}
                    onClick={() => navigate('/settings', { state: { section: 'libraries' } })}
                  >
                    Go to Library Management
                  </button>
                </>
              ) : (
                <>
                  <div className="library-empty-icon">📚</div>
                  <h2>No manga found</h2>
                  {search
                    ? <p>No results for "{search}"{search.includes(',') ? ' — try fewer genres or check spelling' : ''}</p>
                    : activeList !== null
                      ? <p>No manga in this list yet. Add some from a manga's page.</p>
                      : <p>Drop manga folders into your library directory, then click Scan Library.</p>
                  }
                </>
              )}
            </div>
          )}

          {/* Grid render — kept visible during refetches so search/sort
              changes don't blink. A subtle opacity dim signals the in-flight
              request without destroying current results. */}
          {manga.length > 0 && (
            <div className={`library-grid-wrap${loading ? ' is-refetching' : ''}`}>
              {error && (
                <div className="library-inline-error" role="alert">
                  Failed to refresh: {error}
                  <button className="btn btn-ghost btn-sm" onClick={load}>Retry</button>
                </div>
              )}
              <p className="library-count">{manga.length} series</p>
              <div className="manga-grid">
                {manga.map(m => (
                  <Link key={m.id} to={`/manga/${m.id}`}>
                    <MangaCard manga={m} />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
