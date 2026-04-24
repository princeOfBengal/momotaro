import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import Ribbon from '../components/Ribbon';
import ArtGalleryRibbon from '../components/ArtGalleryRibbon';
import AppSidebar from '../components/AppSidebar';
import './Library.css';
import './Home.css';

// localStorage keys driving the Discover ribbon's daily refresh behaviour.
const LS_INTERVAL_MS    = 'home_discover_refresh_ms';
const LS_LAST_REFRESH   = 'home_discover_last_refresh';
const LS_SEED           = 'home_discover_seed';

const DEFAULT_DISCOVER_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DISCOVER_VISIBLE_COUNT       = 15;

// Deterministic PRNG seeded with a 32-bit integer. Used so the Discover
// shuffle is stable for an entire refresh window — reloading the page
// doesn't change what the user sees until the cadence elapses.
function mulberry32(seed) {
  let state = seed | 0;
  return function () {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed(items, seed) {
  const rng = mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function readIntervalMs() {
  const raw = localStorage.getItem(LS_INTERVAL_MS);
  if (raw === null) return DEFAULT_DISCOVER_INTERVAL_MS;
  if (raw === '0') return 0; // manual-only
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DISCOVER_INTERVAL_MS;
}

function resolveDiscoverSeed(now = Date.now()) {
  const intervalMs = readIntervalMs();
  const lastRaw = localStorage.getItem(LS_LAST_REFRESH);
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;

  // Interval of 0 means "manual-only" — keep whatever seed we have (or mint
  // one on first load) and never auto-rotate.
  if (intervalMs === 0) {
    let seed = parseInt(localStorage.getItem(LS_SEED) || '0', 10);
    if (!seed) {
      seed = (Math.random() * 0x7fffffff) | 0;
      localStorage.setItem(LS_SEED, String(seed));
      localStorage.setItem(LS_LAST_REFRESH, String(now));
    }
    return seed;
  }

  if (!last || now - last >= intervalMs) {
    const seed = (Math.random() * 0x7fffffff) | 0;
    localStorage.setItem(LS_SEED, String(seed));
    localStorage.setItem(LS_LAST_REFRESH, String(now));
    return seed;
  }
  const existing = parseInt(localStorage.getItem(LS_SEED) || '0', 10);
  return existing || 1;
}

function forceDiscoverSeed() {
  const seed = (Math.random() * 0x7fffffff) | 0;
  localStorage.setItem(LS_SEED, String(seed));
  localStorage.setItem(LS_LAST_REFRESH, String(Date.now()));
  return seed;
}

// ── Tile components ───────────────────────────────────────────────────────

function CoverImg({ src, alt }) {
  if (!src) {
    return <div className="ribbon-tile-cover-fallback" aria-hidden="true">📕</div>;
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} />;
}

function ContinueReadingTile({ manga }) {
  const track = manga.track_volumes ? 'Volume' : 'Chapter';
  const label = manga.current_chapter
    ? (manga.current_chapter.number != null
        ? `${track} ${manga.current_chapter.number}`
        : (manga.current_chapter.volume != null
            ? `Volume ${manga.current_chapter.volume}`
            : manga.current_chapter.folder_name || '—'))
    : '—';
  const pct = manga.total_chapters > 0
    ? Math.min(100, Math.round((manga.completed_count / manga.total_chapters) * 100))
    : 0;
  return (
    <Link
      to={`/manga/${manga.id}`}
      className="ribbon-tile"
      role="listitem"
      aria-label={`${manga.title} — continue at ${label}`}
    >
      <div className="ribbon-tile-cover">
        <CoverImg src={manga.cover_url} alt="" />
        {pct > 0 && (
          <span
            className="ribbon-tile-progress"
            style={{ width: `${pct}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="ribbon-tile-meta">
        <p className="ribbon-tile-title">{manga.title}</p>
        <p className="ribbon-tile-sub">{label}</p>
      </div>
    </Link>
  );
}

function MangaTile({ manga, sub }) {
  return (
    <Link
      to={`/manga/${manga.id}`}
      className="ribbon-tile"
      role="listitem"
      aria-label={manga.title}
    >
      <div className="ribbon-tile-cover">
        <CoverImg src={manga.cover_url} alt="" />
        {manga.score != null && (
          <span className="ribbon-tile-score" aria-label={`Score ${manga.score}`}>
            ★ {Number(manga.score).toFixed(1)}
          </span>
        )}
      </div>
      <div className="ribbon-tile-meta">
        <p className="ribbon-tile-title">{manga.title}</p>
        {sub && <p className="ribbon-tile-sub">{sub}</p>}
      </div>
    </Link>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function Home() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [discoverSeed, setDiscoverSeed] = useState(() => resolveDiscoverSeed());

  // Sidebar data + drawer state. The sidebar is shared with the Library
  // page; here every selection navigates the user over to /library with
  // the chosen filter pre-applied via React Router location state.
  const [libraries, setLibraries] = useState([]);
  const [readingLists, setReadingLists] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
      setLoading(true);
      const fetched = await api.getHome();
      setData(fetched);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Slice discover candidates to a stable visible window. Memoized on the
  // seed so React does not re-shuffle on every unrelated render.
  const discoverVisible = useMemo(() => {
    if (!data?.discover_candidates?.length) return [];
    const shuffled = shuffleWithSeed(data.discover_candidates, discoverSeed);
    return shuffled.slice(0, DISCOVER_VISIBLE_COUNT);
  }, [data, discoverSeed]);

  function handleManualDiscoverRefresh() {
    setDiscoverSeed(forceDiscoverSeed());
  }

  return (
    <div className="library-page home-page">
      <nav className="navbar">
        {/* Hamburger — mobile only, opens the shared sidebar as a drawer */}
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

      {/* Backdrop for the mobile sidebar drawer */}
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
        {loading && !data && (
          <div className="loading-center"><div className="spinner" /></div>
        )}

        {error && !data && (
          <div className="error-message">
            <h2>Failed to load Home</h2>
            <p>{error}</p>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={load}>
              Retry
            </button>
          </div>
        )}

        {data && (
          <>
            {data.continue_reading.length === 0
              && data.discover_candidates.length === 0
              && data.art_gallery.length === 0
              && data.favorite_genres_ribbons.length === 0 ? (
              <div className="home-empty">
                <div className="home-empty-icon">📚</div>
                <h2>Welcome to Momotaro</h2>
                <p>Your Home will fill in as you add manga and start reading.</p>
                <Link to="/library" className="btn btn-primary" style={{ marginTop: 16 }}>
                  Browse Library
                </Link>
              </div>
            ) : (
              <>
                <Ribbon title="Continue Reading">
                  {data.continue_reading.map(m => (
                    <ContinueReadingTile key={m.id} manga={m} />
                  ))}
                </Ribbon>

                <Ribbon
                  title="Discover New Series"
                  actions={
                    discoverVisible.length > 0 && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleManualDiscoverRefresh}
                        title="Shuffle new picks"
                      >
                        Refresh
                      </button>
                    )
                  }
                  emptyMessage={
                    data.discover_candidates.length === 0
                      ? 'Read some chapters so we can learn your favourite genres.'
                      : null
                  }
                >
                  {discoverVisible.map(m => (
                    <MangaTile
                      key={m.id}
                      manga={m}
                      sub={m.match_count > 1
                        ? `${m.match_count} matching genres`
                        : '1 matching genre'}
                    />
                  ))}
                </Ribbon>

                <ArtGalleryRibbon items={data.art_gallery} />

                {data.favorite_genres_ribbons.map(r => (
                  <Ribbon
                    key={r.genre}
                    title={`Top Manga in ${r.genre}`}
                  >
                    {r.manga.map(m => (
                      <MangaTile key={m.id} manga={m} />
                    ))}
                  </Ribbon>
                ))}
              </>
            )}
          </>
        )}
        </main>
      </div>
    </div>
  );
}
