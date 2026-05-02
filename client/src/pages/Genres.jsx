import React, { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AppSidebar from '../components/AppSidebar';
import './Library.css';
import './Home.css';
import './Genres.css';

// Browse By Genre — grid of every genre present across visible libraries.
// Each tile is decorated with a faded thumbnail of the highest-scored manga
// tagged with that genre; clicking the tile navigates to /library with the
// genre name pre-filled in the search box (which the existing search route
// already resolves to a genre filter — see api.md § Search for the rules).
export default function Genres() {
  const navigate = useNavigate();
  const [genres, setGenres] = useState(null);
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
      const data = await api.getGenres();
      setGenres(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleGenreClick(genre) {
    navigate('/library', { state: { search: genre } });
  }

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
            <h1 className="genres-title">Browse By Genre</h1>
            <p className="genres-sub">
              Pick a genre to search every visible library for matching titles.
            </p>
          </header>

          {error && (
            <div className="error-message">
              <h2>Failed to load genres</h2>
              <p>{error}</p>
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={load}>
                Retry
              </button>
            </div>
          )}

          {!error && genres === null && (
            <div className="genres-grid" aria-hidden="true">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="genre-tile skeleton-block" />
              ))}
            </div>
          )}

          {!error && genres !== null && genres.length === 0 && (
            <div className="home-empty">
              <div className="home-empty-icon">🏷️</div>
              <h2>No genres yet</h2>
              <p>Genres appear once your library has manga with tagged metadata.</p>
            </div>
          )}

          {!error && genres !== null && genres.length > 0 && (
            <>
              <p className="library-count">{genres.length} {genres.length === 1 ? 'genre' : 'genres'}</p>
              <div className="genres-grid">
                {genres.map(g => (
                  <button
                    key={g.genre}
                    type="button"
                    className="genre-tile"
                    onClick={() => handleGenreClick(g.genre)}
                    aria-label={`Search ${g.genre}, ${g.manga_count} ${g.manga_count === 1 ? 'title' : 'titles'}`}
                  >
                    {g.cover_url && (
                      <img
                        src={g.cover_url}
                        alt=""
                        className="genre-tile-bg"
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        aria-hidden="true"
                      />
                    )}
                    <span className="genre-tile-overlay" aria-hidden="true" />
                    <span className="genre-tile-label">{g.genre}</span>
                    <span className="genre-tile-count">
                      {g.manga_count} {g.manga_count === 1 ? 'title' : 'titles'}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
