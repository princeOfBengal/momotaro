import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import MangaCard from '../components/MangaCard';
import './Library.css';

export default function Library() {
  const navigate = useNavigate();
  const location = useLocation();
  const [manga, setManga] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('title');
  const [scanning, setScanning] = useState(false);

  // Libraries
  const [libraries, setLibraries] = useState([]);
  const [activeLibrary, setActiveLibrary] = useState(location.state?.library ?? null);

  // Reading lists
  const [readingLists, setReadingLists] = useState([]);
  const [activeList, setActiveList] = useState(location.state?.list ?? null);

  // New list creation
  // Mobile drawer
  const [drawerOpen, setDrawerOpen] = useState(false);

  // New list creation
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [savingList, setSavingList] = useState(false);
  const newListInputRef = useRef(null);

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

  // Focus the new-list input when it appears
  useEffect(() => {
    if (creatingList) newListInputRef.current?.focus();
  }, [creatingList]);

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

  async function handleCreateList(e) {
    e.preventDefault();
    if (!newListName.trim() || savingList) return;
    setSavingList(true);
    try {
      await api.createReadingList({ name: newListName.trim() });
      setNewListName('');
      setCreatingList(false);
      loadReadingLists();
    } catch (err) {
      alert('Failed to create list: ' + err.message);
    } finally {
      setSavingList(false);
    }
  }

  async function handleDeleteList(e, id) {
    e.stopPropagation();
    try {
      await api.deleteReadingList(id);
      if (activeList === id) selectAll();
      loadReadingLists();
    } catch (err) {
      alert('Failed to delete list: ' + err.message);
    }
  }

  const isViewingAll = activeLibrary === null && activeList === null;

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
        {/* ── Sidebar ── */}
        <aside className={`library-sidebar${drawerOpen ? ' drawer-open' : ''}`}>
          <div className="lib-drawer-header">
            <span className="lib-drawer-title">Menu</span>
            <button className="lib-drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Close menu">✕</button>
          </div>

          {/* Libraries section — only when more than one exists */}
          {libraries.length > 1 && (
            <>
              <p className="library-sidebar-heading">Libraries</p>
              <button
                className={`library-sidebar-item${isViewingAll ? ' active' : ''}`}
                onClick={selectAll}
              >
                All Libraries
                <span className="library-sidebar-count">
                  {libraries.reduce((s, l) => s + l.manga_count, 0)}
                </span>
              </button>
              {libraries.map(lib => (
                <button
                  key={lib.id}
                  className={`library-sidebar-item${activeLibrary === lib.id ? ' active' : ''}`}
                  onClick={() => selectLibrary(lib.id)}
                >
                  {lib.name}
                  <span className="library-sidebar-count">{lib.manga_count}</span>
                </button>
              ))}
              <div className="library-sidebar-divider" />
            </>
          )}

          {/* Reading List section */}
          <div className="library-sidebar-section-header">
            <p className="library-sidebar-heading">Reading List</p>
            {!creatingList && (
              <button
                className="library-sidebar-add-btn"
                onClick={() => setCreatingList(true)}
                title="New reading list"
              >+</button>
            )}
          </div>

          {readingLists.map(list => (
            <div key={list.id} className="library-sidebar-item-row">
              <button
                className={`library-sidebar-item${activeList === list.id ? ' active' : ''}`}
                onClick={() => selectList(list.id)}
              >
                {list.name}
                <span className="library-sidebar-count">{list.manga_count}</span>
              </button>
              {!list.is_default && (
                <button
                  className="library-sidebar-delete-btn"
                  onClick={e => handleDeleteList(e, list.id)}
                  title={`Delete "${list.name}"`}
                >×</button>
              )}
            </div>
          ))}

          {creatingList && (
            <form className="library-sidebar-new-list" onSubmit={handleCreateList}>
              <input
                ref={newListInputRef}
                className="library-sidebar-new-list-input"
                type="text"
                placeholder="List name..."
                value={newListName}
                onChange={e => setNewListName(e.target.value)}
                onKeyDown={e => e.key === 'Escape' && setCreatingList(false)}
                maxLength={60}
              />
              <div className="library-sidebar-new-list-actions">
                <button type="submit" className="library-sidebar-new-list-save" disabled={!newListName.trim() || savingList}>
                  Add
                </button>
                <button type="button" className="library-sidebar-new-list-cancel" onClick={() => { setCreatingList(false); setNewListName(''); }}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </aside>

        <main className="library-main">
          {loading && (
            <div className="loading-center"><div className="spinner" /></div>
          )}
          {error && (
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
          {!loading && !error && manga.length > 0 && (
            <>
              <p className="library-count">{manga.length} series</p>
              <div className="manga-grid">
                {manga.map(m => (
                  <Link key={m.id} to={`/manga/${m.id}`}>
                    <MangaCard manga={m} />
                  </Link>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
