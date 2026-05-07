import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import AppSidebar from '../components/AppSidebar';
import VirtualizedMangaGrid from '../components/VirtualizedMangaGrid';
import { useScrollPosition } from '../hooks/useScrollPosition';
import './Library.css';
// Reuse the skeleton classes (.skeleton-block, .skeleton-line, .skeleton-tile)
// already defined for Home — same precedent as Home importing Library.css.
import './Home.css';

// Cursor-paginated page size for the BROWSE view. The server bounds limit to
// [1, 500]; 200 keeps the rendered grid small so initial paint stays cheap
// on tablet-class CPUs.
const PAGE_SIZE = 200;

// Cursor pagination is only supported by the API for sort=title and
// sort=updated. sort=year and sort=rating fall back to unbounded fetching.
function supportsCursorPagination(sort, activeList) {
  if (activeList !== null) return false;
  return sort === 'title' || sort === 'updated';
}

// Initial-load skeleton — renders placeholder cards inside the same
// .manga-grid so vertical real-estate is reserved before data arrives.
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

  // ── Browse state ─────────────────────────────────────────────────────────
  // The full library/list grid. Loaded once on mount, refetched when the
  // sort/library/list filters change. **Never refetched on search** — search
  // has its own state and renders independently. This is the same separation
  // Home uses for ribbons vs. search results, and is what keeps the keystroke
  // path cheap.
  const [manga, setManga] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── Search state ─────────────────────────────────────────────────────────
  // Replicates Home.jsx. `null` is the idle sentinel ("no search active");
  // an empty array is a real "no results" answer.
  const [searchResults, setSearchResults] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const [search, setSearch] = useState(location.state?.search ?? '');
  const [sort, setSort] = useState(() => {
    const saved = localStorage.getItem('home_default_sort');
    return ['title', 'updated', 'year', 'rating'].includes(saved) ? saved : 'title';
  });
  const [scanning, setScanning] = useState(false);

  // Libraries / reading lists / drawer
  const [libraries, setLibraries] = useState([]);
  const [activeLibrary, setActiveLibrary] = useState(location.state?.library ?? null);
  const [readingLists, setReadingLists] = useState([]);
  const [activeList, setActiveList] = useState(location.state?.list ?? null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Pagination state for the BROWSE grid.
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Pagination state for the SEARCH grid. Engages only when the active sort
  // supports cursor pagination (title / updated) AND no reading-list filter
  // is active — the reading-list endpoint doesn't support cursors today, so
  // it falls back to the unbounded one-shot fetch. Genre / multi-term
  // searches inside a paginatable sort go through this same path because the
  // server's keyset clause AND-composes with the FTS / genre subqueries on
  // m.id without conflict.
  const [searchNextCursor, setSearchNextCursor] = useState(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);

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

  // ── Browse fetch ─────────────────────────────────────────────────────────
  // Loads the full library/list grid. Notably, **the search query is not
  // part of this fetch**. Typing in the search box does not trigger a
  // refetch here, does not replace `manga`, and does not cause the browse
  // grid to reconcile. The grid is unmounted from the DOM entirely while
  // search is active (see render below), so its size is irrelevant during
  // the keystroke path.
  const load = useCallback(async () => {
    try {
      setLoading(true);
      const useCursor = supportsCursorPagination(sort, activeList);

      if (activeList !== null) {
        const data = await api.getReadingListManga(activeList, { sort });
        setManga(data);
        setNextCursor(null);
        setHasMore(false);
      } else if (useCursor) {
        const params = { sort, limit: PAGE_SIZE };
        if (activeLibrary !== null) params.library_id = activeLibrary;
        const resp = await api.getLibrary(params, { raw: true });
        setManga(resp.data || []);
        setNextCursor(resp.next_cursor ?? null);
        setHasMore(!!resp.has_more);
      } else {
        const params = { sort };
        if (activeLibrary !== null) params.library_id = activeLibrary;
        const data = await api.getLibrary(params);
        setManga(data);
        setNextCursor(null);
        setHasMore(false);
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sort, activeLibrary, activeList]);

  useEffect(() => { load(); }, [load]);

  // ── Search fetch ─────────────────────────────────────────────────────────
  // Debounced first-page search. Local `cancelled` flag (no AbortController),
  // 300 ms debounce, separate state. Empty input resets `searchResults` to
  // null so the browse grid re-renders without any refetch.
  //
  // When the sort + filter combination supports keyset pagination (title /
  // updated, no reading-list filter), the first page is bounded to PAGE_SIZE
  // and the cursor is captured for `loadMoreSearch` below. Without this, a
  // popular genre search ("drama") in a 10K-title library returned thousands
  // of rows in one shot — meaningful JSON-parse + first-paint cost on
  // mid-tier mobile, even though virtualization keeps the rendered DOM
  // small.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      setSearchNextCursor(null);
      setSearchHasMore(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        let data;
        let nextCur = null;
        let more = false;

        if (activeList !== null) {
          // Reading-list endpoint has no cursor support — accept the
          // one-shot fetch. Reading lists are typically small.
          data = await api.getReadingListManga(activeList, { search: q, sort });
        } else {
          const params = { search: q, sort };
          if (activeLibrary !== null) params.library_id = activeLibrary;
          if (supportsCursorPagination(sort, activeList)) {
            params.limit = PAGE_SIZE;
            const resp = await api.getLibrary(params, { raw: true });
            data = resp.data || [];
            nextCur = resp.next_cursor ?? null;
            more = !!resp.has_more;
          } else {
            data = await api.getLibrary(params);
          }
        }
        if (cancelled) return;
        setSearchResults(data);
        setSearchNextCursor(nextCur);
        setSearchHasMore(more);
        setSearchError(null);
      } catch (err) {
        if (cancelled) return;
        setSearchError(err.message);
        setSearchResults([]);
        setSearchNextCursor(null);
        setSearchHasMore(false);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, sort, activeLibrary, activeList]);

  // ── Pagination append (browse) ───────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    if (!hasMore || !nextCursor) return;
    if (!supportsCursorPagination(sort, activeList)) return;

    setLoadingMore(true);
    try {
      const params = { sort, limit: PAGE_SIZE, cursor: nextCursor };
      if (activeLibrary !== null) params.library_id = activeLibrary;
      const resp = await api.getLibrary(params, { raw: true });
      setManga(prev => [...prev, ...(resp.data || [])]);
      setNextCursor(resp.next_cursor ?? null);
      setHasMore(!!resp.has_more);
    } catch {
      // Silent on error: existing grid stays valid; user can scroll back
      // into the sentinel to retry.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, nextCursor, sort, activeLibrary, activeList]);

  // ── Pagination append (search) ───────────────────────────────────────────
  // Mirrors `loadMore` but for the search results array. Skipped entirely in
  // unpaginated paths (reading-list endpoint, or sort=year/sort=rating where
  // the server has no cursor support); in those paths `searchHasMore` stays
  // false and the virtualizer never calls back.
  const loadMoreSearch = useCallback(async () => {
    if (searchLoadingMore) return;
    if (!searchHasMore || !searchNextCursor) return;
    if (activeList !== null) return;
    if (!supportsCursorPagination(sort, activeList)) return;

    setSearchLoadingMore(true);
    try {
      const params = {
        search: search.trim(),
        sort,
        limit: PAGE_SIZE,
        cursor: searchNextCursor,
      };
      if (activeLibrary !== null) params.library_id = activeLibrary;
      const resp = await api.getLibrary(params, { raw: true });
      setSearchResults(prev => [...(prev || []), ...(resp.data || [])]);
      setSearchNextCursor(resp.next_cursor ?? null);
      setSearchHasMore(!!resp.has_more);
    } catch {
      // Silent on error — virtualizer can re-fire onEndReached when
      // items.length next changes.
    } finally {
      setSearchLoadingMore(false);
    }
  }, [searchLoadingMore, searchHasMore, searchNextCursor, search, sort, activeLibrary, activeList]);

  // Browse-mode infinite scroll is now driven by VirtualizedMangaGrid: when
  // its last visible row is within a few rows of the end, it calls back into
  // `loadMore`. The previous IntersectionObserver-on-sentinel approach was
  // removed with virtualization because the sentinel is no longer rendered.

  // Scrollable element for the page. The virtualizer reports row positions
  // against this element's scrollTop, and `useScrollPosition` persists +
  // restores it across navigations so back-from-detail lands the user where
  // they left off.
  const libraryMainRef = useRef(null);

  // Key the saved scroll position by:
  //   - location.key (so a forward navigation gets fresh state, but back-
  //     from-detail returns to the same value and triggers restore);
  //   - the rendering mode (search vs browse) — they share the scroll
  //     container but show different grids, so scrollTop isn't comparable;
  //   - the active filter tuple in browse mode (sort/library/list change ⇒
  //     content fully changes ⇒ start at top by virtue of having no entry).
  // The search query itself is NOT in the key — it changes on every
  // keystroke, which would otherwise snap the user to top mid-type.
  const isSearching = search.trim().length > 0;
  const scrollKey = isSearching
    ? `${location.key || 'default'}|mode:search`
    : `${location.key || 'default'}|mode:browse|lib:${activeLibrary ?? ''}|list:${activeList ?? ''}|sort:${sort}`;
  const browseReady = !loading && manga.length > 0;
  const searchReady = searchResults !== null && searchResults.length > 0;
  useScrollPosition(libraryMainRef, scrollKey, browseReady || searchReady);

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

  // Card rendering is delegated to VirtualizedMangaGrid, which only mounts the
  // rows currently in (or near) the viewport. Pre-allocating thousands of
  // <Link><MangaCard/></Link> JSX elements via useMemo gave nothing here once
  // virtualization landed — React.memo on MangaCard already prevents
  // re-renders of unchanged cards, and the virtualizer only ever asks for the
  // visible window.

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
        <div className="library-search-wrap lib-desktop-only">
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

      {/* Mobile-only search row, lifted out of the sticky navbar so the
          input doesn't sit in the same layout context as the heavy browse
          grid below. */}
      <div className="lib-mobile-search-row">
        <input
          className="library-search"
          type="search"
          placeholder="Search by title, artist, or genre"
          value={search}
          onChange={e => setSearch(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>

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

        <main className="library-main" ref={libraryMainRef}>
          {isSearching ? (
            // ── SEARCH MODE ───────────────────────────────────────────────
            // Direct mirror of Home's search-mode render. The browse grid
            // (potentially thousands of mounted cards) is NOT in the DOM
            // at all in this branch, so the keystroke + keyboard reflow
            // path operates over a small DOM tree — same as Home, which
            // is the page the user reports works on mobile.
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
                        : 'Try a different keyword, or clear the search to browse the full library.'}
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="library-count">
                      {searchResults.length}{searchHasMore ? '+' : ''} {searchResults.length === 1 ? 'result' : 'results'}
                    </p>
                    <VirtualizedMangaGrid
                      items={searchResults}
                      scrollElementRef={libraryMainRef}
                      onEndReached={searchHasMore ? loadMoreSearch : undefined}
                    />
                    {searchHasMore && (
                      <div className="library-load-more" aria-live="polite">
                        {searchLoadingMore ? (
                          <div className="spinner library-load-more-spinner" />
                        ) : (
                          <span className="library-load-more-hint">Scroll for more</span>
                        )}
                      </div>
                    )}
                  </>
                )
              )}
            </>
          ) : (
            // ── BROWSE MODE ───────────────────────────────────────────────
            <>
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
                  {libraries.length === 0 && activeList === null ? (
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
                      {activeList !== null
                        ? <p>No manga in this list yet. Add some from a manga's page.</p>
                        : <p>Drop manga folders into your library directory, then click Scan Library.</p>
                      }
                    </>
                  )}
                </div>
              )}

              {/* Grid render — kept visible during refetches so sort/library
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
                  <p className="library-count">
                    {manga.length}{hasMore ? '+' : ''} series
                  </p>
                  <VirtualizedMangaGrid
                    items={manga}
                    scrollElementRef={libraryMainRef}
                    onEndReached={hasMore ? loadMore : undefined}
                  />
                  {hasMore && (
                    <div className="library-load-more" aria-live="polite">
                      {loadingMore ? (
                        <div className="spinner library-load-more-spinner" />
                      ) : (
                        <span className="library-load-more-hint">Scroll for more</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
