import React, { useEffect, useMemo, useState, useCallback, lazy, Suspense, memo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import Ribbon from '../components/Ribbon';
import AppSidebar from '../components/AppSidebar';
// MangaCard is also statically imported by Library, so it lives in the main
// chunk regardless — no benefit to lazy-loading it here.
import MangaCard from '../components/MangaCard';
import './Library.css';
import './Home.css';

// Only used below the fold (after every other ribbon). Lazy split keeps the
// initial Home bundle smaller; ArtGalleryRibbon's CSS animation is also
// expensive enough to be worth deferring.
const ArtGalleryRibbon = lazy(() => import('../components/ArtGalleryRibbon'));

// localStorage keys driving the Discover ribbon's daily refresh behaviour.
const LS_INTERVAL_MS    = 'home_discover_refresh_ms';
const LS_LAST_REFRESH   = 'home_discover_last_refresh';
const LS_SEED           = 'home_discover_seed';
// Per-device minimum AniList/MAL score for the per-genre ribbons. The same
// `discoverSeed` rotates these ribbons too (see GENRE_VISIBLE_COUNT below),
// so the score threshold and shuffle cadence are decoupled — change the
// number to broaden / narrow the candidate pool, change the Discover
// interval to rotate the visible slice faster / slower.
const LS_GENRE_MIN_SCORE = 'home_genre_score_threshold';

const DEFAULT_DISCOVER_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DISCOVER_VISIBLE_COUNT       = 15;
const GENRE_VISIBLE_COUNT          = 15;
const DEFAULT_GENRE_MIN_SCORE      = 7;

// Cover dimensions reserved at layout time so the browser doesn't reflow as
// images stream in. Matches the actual rendered size on desktop and is a
// single hint — CSS responsive rules still control the painted width.
const COVER_W = 140;
const COVER_H = 210;

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

// FNV-1a 32-bit string hash. Used to derive a stable per-genre offset for the
// Top Manga ribbons so each genre rotates independently from `discoverSeed`
// (same cadence — different ordering, so the genres don't all happen to
// promote the same indexed positions in their respective candidate pools).
function hashStr32(s) {
  let h = 2166136261 | 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function readGenreMinScore() {
  const raw = localStorage.getItem(LS_GENRE_MIN_SCORE);
  if (raw === null) return DEFAULT_GENRE_MIN_SCORE;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return DEFAULT_GENRE_MIN_SCORE;
  return Math.max(0, Math.min(10, n));
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

// Schedule a low-priority callback. Sidebar fetches use this so they don't
// compete with `/api/home` for the initial network slot.
function whenIdle(cb) {
  if (typeof window === 'undefined') return cb();
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(cb, { timeout: 1500 });
  }
  return setTimeout(cb, 250);
}

// ── Tile components ───────────────────────────────────────────────────────

// `eager` is set on the first tile in each ribbon so the LCP cover doesn't
// wait on lazy-loading. The browser otherwise can't tell how far inside a
// horizontally-scrolling list any tile is.
function CoverImg({ src, alt, eager = false }) {
  if (!src) {
    return <div className="ribbon-tile-cover-fallback" aria-hidden="true">📕</div>;
  }
  return (
    <img
      src={src}
      alt={alt}
      width={COVER_W}
      height={COVER_H}
      loading={eager ? 'eager' : 'lazy'}
      fetchpriority={eager ? 'high' : 'low'}
      decoding="async"
      draggable={false}
    />
  );
}

const ContinueReadingTile = memo(function ContinueReadingTile({ manga, eager }) {
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
        <CoverImg src={manga.cover_url} alt="" eager={eager} />
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
});

const MangaTile = memo(function MangaTile({ manga, sub, eager }) {
  return (
    <Link
      to={`/manga/${manga.id}`}
      className="ribbon-tile"
      role="listitem"
      aria-label={manga.title}
    >
      <div className="ribbon-tile-cover">
        <CoverImg src={manga.cover_url} alt="" eager={eager} />
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
});

// Resume hero — single big card surfaced above all ribbons, pointing the user
// at the most recently read manga's current chapter and page. Highest-intent
// action on a return visit; replaces the small first tile of Continue Reading.
function ResumeHero({ manga }) {
  if (!manga || !manga.current_chapter_id) return null;
  const track = manga.track_volumes ? 'Volume' : 'Chapter';
  const label = manga.current_chapter?.number != null
    ? `${track} ${manga.current_chapter.number}`
    : (manga.current_chapter?.volume != null
        ? `Volume ${manga.current_chapter.volume}`
        : manga.current_chapter?.folder_name || '—');
  const pct = manga.total_chapters > 0
    ? Math.min(100, Math.round((manga.completed_count / manga.total_chapters) * 100))
    : 0;
  const page = manga.current_page ? Number(manga.current_page) : 0;
  const resumeHref = `/read/${manga.current_chapter_id}?mangaId=${manga.id}${page ? `&page=${page}` : ''}`;
  return (
    <section className="home-hero" aria-label="Resume reading">
      <Link to={resumeHref} className="home-hero-cover" aria-hidden="true" tabIndex={-1}>
        {manga.cover_url
          ? <img src={manga.cover_url} alt="" width={140} height={210}
              fetchpriority="high" decoding="async" draggable={false} />
          : <div className="home-hero-cover-fallback">📕</div>}
      </Link>
      <div className="home-hero-body">
        <p className="home-hero-eyebrow">Pick up where you left off</p>
        <Link to={`/manga/${manga.id}`} className="home-hero-title">{manga.title}</Link>
        <p className="home-hero-sub">
          {label}
          {page > 0 && <> · page {page + 1}</>}
        </p>
        {pct > 0 && (
          <div className="home-hero-progress" aria-label={`${pct} percent complete`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="home-hero-actions">
          <Link to={resumeHref} className="btn btn-primary">Resume reading</Link>
          <Link to={`/manga/${manga.id}`} className="btn btn-ghost">Open detail</Link>
        </div>
      </div>
    </section>
  );
}

// Skeleton scaffold rendered before /api/home resolves. Reserves the same
// vertical real-estate as the hydrated page so the layout doesn't jump when
// data arrives.
function HomeSkeleton() {
  const tiles = Array.from({ length: 7 });
  return (
    <div aria-hidden="true">
      <div className="home-hero home-hero-skeleton">
        <div className="home-hero-cover skeleton-block" />
        <div className="home-hero-body">
          <div className="skeleton-line skeleton-line-sm" />
          <div className="skeleton-line skeleton-line-lg" />
          <div className="skeleton-line skeleton-line-md" />
          <div className="skeleton-line skeleton-line-progress" />
        </div>
      </div>
      {[0, 1, 2].map(i => (
        <section className="ribbon" key={i}>
          <header className="ribbon-head">
            <div className="skeleton-line skeleton-title" />
          </header>
          <div className="ribbon-track">
            {tiles.map((_, j) => (
              <div className="ribbon-tile skeleton-tile" key={j}>
                <div className="ribbon-tile-cover skeleton-block" />
                <div className="ribbon-tile-meta">
                  <div className="skeleton-line skeleton-line-sm" />
                  <div className="skeleton-line skeleton-line-xs" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function Home() {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [discoverSeed, setDiscoverSeed] = useState(() => resolveDiscoverSeed());
  // Score threshold for the "Top Manga in <Genre>" ribbons. Read from
  // localStorage on mount; the Settings page's Homepage section is the
  // canonical writer. Changing this in Settings causes Home to remount and
  // re-fetch with the new value.
  const [genreMinScore] = useState(() => readGenreMinScore());

  // Sidebar data + drawer state. The sidebar is shared with the Library
  // page; here every selection navigates the user over to /library with
  // the chosen filter pre-applied via React Router location state.
  const [libraries, setLibraries] = useState([]);
  const [readingLists, setReadingLists] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Search — when non-empty, the ribbons collapse and a flat results grid
  // is shown instead. Scoped to All Libraries: `api.getLibrary({ search })`
  // omits `library_id`, which the server resolves to "every manga in a
  // library where show_in_all = 1, plus orphan rows".
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState(null); // null = idle
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const loadLibraries    = useCallback(() => {
    api.getLibraries().then(d => setLibraries(d)).catch(() => {});
  }, []);
  const loadReadingLists = useCallback(() => {
    api.getReadingLists().then(d => setReadingLists(d)).catch(() => {});
  }, []);

  // Sidebar data isn't on the critical path to first paint — defer it so
  // /api/home gets the first network slot. Drawer-only on mobile; on desktop
  // the rail still appears within a frame or two.
  useEffect(() => {
    const handle = whenIdle(() => {
      loadLibraries();
      loadReadingLists();
    });
    return () => {
      if (typeof handle === 'number') clearTimeout(handle);
      else if (typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(handle);
      }
    };
  }, [loadLibraries, loadReadingLists]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const fetched = await api.getHome({ minScore: genreMinScore });
      setData(fetched);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [genreMinScore]);

  useEffect(() => { load(); }, [load]);

  // Debounced search. 300 ms matches the Library page so cross-page muscle
  // memory is consistent. Empty query → reset state and let the ribbons show.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const data = await api.getLibrary({ search: q });
        if (cancelled) return;
        setSearchResults(data);
        setSearchError(null);
      } catch (err) {
        if (cancelled) return;
        setSearchError(err.message);
        setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  // Slice discover candidates to a stable visible window. Memoized on the
  // seed so React does not re-shuffle on every unrelated render.
  const discoverVisible = useMemo(() => {
    if (!data?.discover_candidates?.length) return [];
    const shuffled = shuffleWithSeed(data.discover_candidates, discoverSeed);
    return shuffled.slice(0, DISCOVER_VISIBLE_COUNT);
  }, [data, discoverSeed]);

  // Continue Reading minus the first row — that one becomes the Resume hero.
  const continueRest = useMemo(() => {
    if (!data?.continue_reading?.length) return [];
    return data.continue_reading.slice(1);
  }, [data]);

  // Genre ribbon visible slices. Each genre's pool is shuffled with a seed
  // derived from `discoverSeed` XOR a per-genre hash, so all genre ribbons
  // and Discover rotate on the *same* cadence (driven by Home's
  // home_discover_refresh_ms in Settings) but each shows a different
  // ordering. Sliced to GENRE_VISIBLE_COUNT for display.
  const genreRibbonsVisible = useMemo(() => {
    if (!data?.favorite_genres_ribbons?.length) return [];
    return data.favorite_genres_ribbons.map(r => {
      const seed = (discoverSeed ^ hashStr32(r.genre)) >>> 0;
      return {
        genre: r.genre,
        manga: shuffleWithSeed(r.manga, seed).slice(0, GENRE_VISIBLE_COUNT),
      };
    });
  }, [data, discoverSeed]);

  function handleManualDiscoverRefresh() {
    setDiscoverSeed(forceDiscoverSeed());
  }

  // Pick a single random unread title and navigate to its detail page. Uses
  // the discover candidate pool so it respects the user's favorite genres.
  function handleSurpriseMe() {
    const pool = data?.discover_candidates;
    if (!pool || pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    navigate(`/manga/${pick.id}`);
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
        <div className="library-search-wrap">
          <input
            className="library-search"
            type="search"
            placeholder="Search across All Libraries"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
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
        {/* Search mode — when the user types, ribbons collapse and a flat
            grid replaces them. Empty input restores the ribbon layout. */}
        {search.trim() ? (
          <>
            {searchLoading && searchResults === null && (
              <div className="loading-center"><div className="spinner" /></div>
            )}
            {searchError && (
              <div className="error-message">
                <h2>Search failed</h2>
                <p>{searchError}</p>
              </div>
            )}
            {searchResults !== null && !searchError && (
              searchResults.length === 0 ? (
                <div className="library-empty">
                  <div className="library-empty-icon">🔍</div>
                  <h2>No results for "{search.trim()}"</h2>
                  <p>
                    {search.includes(',')
                      ? 'Try fewer genres or check spelling.'
                      : 'Try a different keyword, or browse the full library.'}
                  </p>
                </div>
              ) : (
                <>
                  <p className="library-count">
                    {searchResults.length} {searchResults.length === 1 ? 'result' : 'results'}
                    {' '}across All Libraries
                  </p>
                  <div className="manga-grid">
                    {searchResults.map(m => (
                      <Link key={m.id} to={`/manga/${m.id}`}>
                        <MangaCard manga={m} />
                      </Link>
                    ))}
                  </div>
                </>
              )
            )}
          </>
        ) : (
        <>
        {loading && !data && <HomeSkeleton />}

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
              && (data.recently_added?.length ?? 0) === 0
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
                <ResumeHero manga={data.continue_reading[0]} />

                {continueRest.length > 0 && (
                  <Ribbon title="Continue Reading">
                    {continueRest.map((m, i) => (
                      <ContinueReadingTile key={m.id} manga={m} eager={i === 0} />
                    ))}
                  </Ribbon>
                )}

                {data.recently_added && data.recently_added.length > 0 && (
                  <Ribbon
                    title="Recently Added"
                    viewAllTo={{ pathname: '/library', state: { search: '' } }}
                  >
                    {data.recently_added.map((m, i) => (
                      <MangaTile key={m.id} manga={m} eager={i === 0} />
                    ))}
                  </Ribbon>
                )}

                <Ribbon
                  title="Discover New Series"
                  actions={
                    discoverVisible.length > 0 && (
                      <>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={handleSurpriseMe}
                          title="Open a random unread series"
                        >
                          Surprise me
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={handleManualDiscoverRefresh}
                          title="Shuffle new picks"
                        >
                          Refresh
                        </button>
                      </>
                    )
                  }
                  emptyMessage={
                    data.discover_candidates.length === 0
                      ? 'Read some chapters so we can learn your favourite genres.'
                      : null
                  }
                >
                  {discoverVisible.map((m, i) => (
                    <MangaTile
                      key={m.id}
                      manga={m}
                      eager={i === 0}
                      sub={m.match_count > 1
                        ? `${m.match_count} matching genres`
                        : '1 matching genre'}
                    />
                  ))}
                </Ribbon>

                <Suspense fallback={null}>
                  <ArtGalleryRibbon items={data.art_gallery} />
                </Suspense>

                {genreRibbonsVisible.map(r => (
                  <Ribbon
                    key={r.genre}
                    title={`Top Manga in ${r.genre}`}
                    viewAllTo={{ pathname: '/library', state: { search: r.genre } }}
                  >
                    {r.manga.map((m, i) => (
                      <MangaTile key={m.id} manga={m} eager={i === 0} />
                    ))}
                  </Ribbon>
                ))}
              </>
            )}
          </>
        )}
        </>
        )}
        </main>
      </div>
    </div>
  );
}
