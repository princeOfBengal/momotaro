import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import AppSidebar from '../components/AppSidebar';
import './Library.css';
import './Home.css';
import './ThirdPartySourcing.css';

// Third Party Sourcing — search a third-party source (MangaDex today),
// pick chapters, and enqueue them as CBZ downloads into either a new series
// folder in a chosen library or an existing series folder. Linkage to the
// source is recorded automatically so the future scheduler can re-check the
// same series for new releases.
//
// Live download progress comes from polling /api/sources/downloads every 2s
// while there's at least one queued or running job. The polling backs off
// when the queue is empty so the page is cheap to leave open.

const POLL_INTERVAL_ACTIVE_MS = 2000;
const POLL_INTERVAL_IDLE_MS   = 10_000;

function chapterLabel(ch) {
  const parts = [];
  if (ch.volume !== null && ch.volume !== undefined) parts.push(`Vol. ${ch.volume}`);
  if (ch.number !== null && ch.number !== undefined) parts.push(`Ch. ${ch.number}`);
  if (parts.length === 0) parts.push('Chapter');
  let s = parts.join(' ');
  if (ch.title) s += ` — ${ch.title}`;
  return s;
}

function jobLabel(j) {
  const parts = [];
  if (j.chapter_volume !== null && j.chapter_volume !== undefined) parts.push(`Vol. ${j.chapter_volume}`);
  if (j.chapter_number !== null && j.chapter_number !== undefined) parts.push(`Ch. ${j.chapter_number}`);
  return parts.join(' ') || (j.chapter_title || j.source_chapter_id);
}

function statusBadgeClass(status) {
  return `tps-status tps-status-${status}`;
}

export default function ThirdPartySourcing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // When the page is opened from a specific manga's detail view we lock the
  // target picker to mode='existing' + that manga, and auto-search using its
  // title — saves the user from re-typing the same title and from accidentally
  // sending downloads to the wrong folder.
  const lockedMangaId = searchParams.get('manga_id') || null;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [libraries, setLibraries]       = useState([]);
  const [readingLists, setReadingLists] = useState([]);

  // The locked manga (when arriving from MangaDetail). Loaded once so we can
  // pre-fill the search box with its title and force target mode/manga.
  const [lockedManga, setLockedManga] = useState(null);

  // Source selection (only MangaDex for the MVP)
  const [sources, setSources] = useState([]);
  const [source, setSource]   = useState('mangadex');

  // Search state
  const [query, setQuery]         = useState('');
  const [results, setResults]     = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  // Active series (clicked from results) + chapters
  const [activeSeries, setActiveSeries] = useState(null);
  const [chapters, setChapters]         = useState(null);
  const [chaptersError, setChaptersError] = useState(null);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [selected, setSelected] = useState(() => new Set());

  // Target picker
  const [targetMode, setTargetMode]         = useState('new');   // 'new' | 'existing'
  const [targetLibraryId, setTargetLibraryId] = useState('');
  const [targetFolderName, setTargetFolderName] = useState('');
  const [targetMangaId, setTargetMangaId]   = useState('');
  const [matches, setMatches]               = useState([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submitInfo, setSubmitInfo]   = useState(null);

  // Downloads panel
  const [jobs, setJobs] = useState([]);
  const pollTimer = useRef(null);

  // ── Initial loads ─────────────────────────────────────────────────────────

  useEffect(() => {
    api.getLibraries().then(setLibraries).catch(() => {});
    api.getReadingLists().then(setReadingLists).catch(() => {});
    api.listSources().then(s => {
      setSources(s);
      if (s.length > 0 && !s.find(x => x.id === source)) setSource(s[0].id);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-pick the first library when libraries arrive and nothing is chosen.
  useEffect(() => {
    if (!targetLibraryId && libraries.length > 0) {
      setTargetLibraryId(String(libraries[0].id));
    }
  }, [libraries, targetLibraryId]);

  // When opened from MangaDetail (?manga_id=N), pull the manga so we can
  // pre-fill the search box and lock the target picker to "add to existing".
  useEffect(() => {
    if (!lockedMangaId) return;
    let cancelled = false;
    api.getManga(lockedMangaId)
      .then(m => {
        if (cancelled) return;
        setLockedManga(m);
        setQuery(m.title || '');
        setTargetMode('existing');
        setTargetMangaId(String(m.id));
        // Kick off the search automatically so the user doesn't have to.
        setSearching(true);
        setSearchError(null);
        return api.searchSource(source, m.title || '');
      })
      .then(results => {
        if (cancelled || !results) return;
        setResults(results);
        if (results.length === 0) setSearchError('No results found.');
      })
      .catch(err => {
        if (cancelled) return;
        setSearchError(err.message);
      })
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
    // Source can change later, but the lock is a one-shot bootstrap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedMangaId]);

  // ── Downloads polling ─────────────────────────────────────────────────────

  // refreshJobs returns the freshly-fetched list so the polling tick can
  // decide cadence from the data it just saw — using `jobs` from React state
  // would be a stale closure (the effect's deps are intentionally empty so
  // the timer chain isn't torn down on every render) and would make the
  // poll always pick the idle interval.
  const refreshJobs = useCallback(async () => {
    try {
      const data = await api.listSourceDownloads(50);
      setJobs(data);
      return data;
    } catch (_) {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    function schedule(data) {
      if (cancelled) return;
      const active = (data || []).some(j => j.status === 'queued' || j.status === 'running');
      const next = active ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;
      pollTimer.current = setTimeout(() => {
        refreshJobs().then(schedule);
      }, next);
    }
    refreshJobs().then(schedule);
    return () => { cancelled = true; clearTimeout(pollTimer.current); };
  }, [refreshJobs]);

  // ── Search ────────────────────────────────────────────────────────────────

  async function doSearch(e) {
    e?.preventDefault?.();
    if (!query.trim() || searching) return;
    setSearching(true);
    setSearchError(null);
    setResults(null);
    setActiveSeries(null);
    setChapters(null);
    setSelected(new Set());
    try {
      const data = await api.searchSource(source, query.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  }

  // ── Series + chapter loading ──────────────────────────────────────────────

  async function openSeries(series) {
    setActiveSeries(series);
    setChapters(null);
    setChaptersError(null);
    setLoadingChapters(true);
    setSelected(new Set());
    setSubmitError(null);
    setSubmitInfo(null);

    // Default the new-series folder name to a sanitised series title.
    setTargetFolderName(cleanFolderSuggestion(series.title));

    // Pre-suggest existing matches in case the user already has the series.
    api.matchExistingManga(series.title).then(setMatches).catch(() => setMatches([]));

    try {
      const list = await api.getSourceChapters(source, series.id, {
        mangaId: targetMode === 'existing' && targetMangaId ? targetMangaId : undefined,
      });
      setChapters(list);
    } catch (err) {
      setChaptersError(err.message);
    } finally {
      setLoadingChapters(false);
    }
  }

  // When the user changes target manga while looking at chapters, refresh the
  // already-downloaded annotations.
  useEffect(() => {
    if (!activeSeries) return;
    if (targetMode !== 'existing' || !targetMangaId) return;
    let cancelled = false;
    api.getSourceChapters(source, activeSeries.id, { mangaId: targetMangaId })
      .then(list => { if (!cancelled) setChapters(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [targetMode, targetMangaId, activeSeries, source]);

  // ── Selection helpers ─────────────────────────────────────────────────────

  function toggleChapter(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAll() {
    if (!chapters) return;
    setSelected(new Set(chapters.filter(c => !c.already_downloaded).map(c => c.id)));
  }
  function selectNone() { setSelected(new Set()); }
  function selectMissing() {
    if (!chapters) return;
    setSelected(new Set(chapters.filter(c => !c.already_downloaded).map(c => c.id)));
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleDownload() {
    if (!activeSeries || selected.size === 0) return;
    if (targetMode === 'new' && !targetLibraryId) {
      setSubmitError('Pick a library to save the new series in.');
      return;
    }
    if (targetMode === 'existing' && !targetMangaId) {
      setSubmitError('Pick which existing series should receive these chapters.');
      return;
    }
    if (targetMode === 'new' && !targetFolderName.trim()) {
      setSubmitError('Folder name cannot be empty.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setSubmitInfo(null);
    try {
      const body = {
        source_series_id:    activeSeries.id,
        source_series_title: activeSeries.title,
        chapters: chapters
          .filter(c => selected.has(c.id))
          .map(c => ({ id: c.id, number: c.number, volume: c.volume, title: c.title })),
        target: targetMode === 'new'
          ? { mode: 'new',      library_id: parseInt(targetLibraryId, 10), folder_name: targetFolderName.trim() }
          : { mode: 'existing', manga_id:   parseInt(targetMangaId,  10) },
      };
      const result = await api.enqueueSourceDownload(source, body);
      setSubmitInfo(`Queued ${result.enqueued} chapter${result.enqueued === 1 ? '' : 's'} → ${result.target_path}`);
      setSelected(new Set());
      refreshJobs();
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelJob(id) {
    try {
      await api.cancelSourceDownload(id);
      refreshJobs();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleRetryJob(id) {
    try {
      await api.retrySourceDownload(id);
      refreshJobs();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleClearFinished() {
    try {
      await api.clearFinishedDownloads();
      refreshJobs();
    } catch (err) {
      alert(err.message);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

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
        <Link to="/library" className="btn btn-ghost home-nav-btn">Library</Link>
        <button
          className="btn-settings"
          onClick={() => navigate('/settings')}
          aria-label="Open settings"
          title="Settings"
        >⚙</button>
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
          onReadingListsChanged={() => api.getReadingLists().then(setReadingLists).catch(() => {})}
        />

        <main className="home-main tps-main">
          <header className="genres-header">
            <h1 className="genres-title">Third Party Sourcing</h1>
            <p className="genres-sub">
              Search third-party sources, download chapters as CBZ, and add them
              to a new or existing series in your library.
            </p>
          </header>

          {/* Source picker + search row */}
          <section className="tps-search-card">
            <form className="tps-search-row" onSubmit={doSearch}>
              <select
                className="tps-source-select"
                value={source}
                onChange={e => setSource(e.target.value)}
              >
                {sources.map(s => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
              <input
                className="tps-search-input"
                placeholder="Search by title…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={searching || !query.trim()}
              >
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>
            {searchError && <p className="tps-error">{searchError}</p>}
          </section>

          {/* Search results — hide when a series is open to keep focus */}
          {results && !activeSeries && (
            <section className="tps-results">
              {results.map(r => (
                <button
                  type="button"
                  key={r.id}
                  className="tps-result-row"
                  onClick={() => openSeries(r)}
                >
                  {r.cover_url
                    ? <img src={r.cover_url} alt="" className="tps-result-cover" loading="lazy" />
                    : <div className="tps-result-cover tps-result-cover-empty" />}
                  <div className="tps-result-info">
                    <p className="tps-result-title">{r.title || '(untitled)'}</p>
                    <p className="tps-result-meta">
                      {r.author && <span>{r.author}</span>}
                      {r.year   && <span>{r.year}</span>}
                      {r.status && <span>{r.status}</span>}
                    </p>
                    {r.genres && r.genres.length > 0 && (
                      <p className="tps-result-genres">{r.genres.slice(0, 5).join(' · ')}</p>
                    )}
                  </div>
                  <span className="tps-result-cta">View chapters →</span>
                </button>
              ))}
            </section>
          )}

          {/* Active series — chapter picker + target picker */}
          {activeSeries && (
            <section className="tps-series-pane">
              <div className="tps-series-head">
                {activeSeries.cover_url && (
                  <img className="tps-series-cover" src={activeSeries.cover_url} alt="" />
                )}
                <div className="tps-series-headinfo">
                  <h2 className="tps-series-title">{activeSeries.title}</h2>
                  {activeSeries.author && <p className="tps-series-meta">{activeSeries.author}</p>}
                  {activeSeries.description && (
                    <p className="tps-series-desc">{activeSeries.description.slice(0, 400)}{activeSeries.description.length > 400 ? '…' : ''}</p>
                  )}
                </div>
                <button
                  className="btn btn-ghost tps-back-btn"
                  onClick={() => { setActiveSeries(null); setChapters(null); setSelected(new Set()); }}
                >← Back to results</button>
              </div>

              <div className="tps-target-card">
                <h3 className="tps-target-heading">
                  Where should the chapters go?
                  {lockedManga && (
                    <span className="tps-locked-pill">
                      Locked to: {lockedManga.title}
                    </span>
                  )}
                </h3>
                <div className="tps-target-modes">
                  <label className={`tps-radio${lockedManga ? ' tps-radio-disabled' : ''}`}>
                    <input
                      type="radio"
                      checked={targetMode === 'new'}
                      onChange={() => setTargetMode('new')}
                      disabled={!!lockedManga}
                    />
                    Save as a new series
                  </label>
                  <label className={`tps-radio${lockedManga ? ' tps-radio-disabled' : ''}`}>
                    <input
                      type="radio"
                      checked={targetMode === 'existing'}
                      onChange={() => setTargetMode('existing')}
                      disabled={!!lockedManga}
                    />
                    Add to an existing series
                  </label>
                </div>

                {targetMode === 'new' && (
                  <div className="tps-target-row">
                    <div className="tps-field">
                      <label className="tps-field-label">Library</label>
                      <select
                        className="tps-target-select"
                        value={targetLibraryId}
                        onChange={e => setTargetLibraryId(e.target.value)}
                      >
                        {libraries.length === 0 && <option value="">No libraries — create one in Settings</option>}
                        {libraries.map(l => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="tps-field">
                      <label className="tps-field-label">Folder name</label>
                      <input
                        className="tps-target-input"
                        value={targetFolderName}
                        onChange={e => setTargetFolderName(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {targetMode === 'existing' && (
                  <div className="tps-target-row">
                    <div className="tps-field" style={{ flex: 1 }}>
                      <label className="tps-field-label">Existing series in your library</label>
                      {lockedManga ? (
                        <input
                          className="tps-target-input"
                          value={lockedManga.title}
                          readOnly
                          disabled
                        />
                      ) : (
                        <select
                          className="tps-target-select"
                          value={targetMangaId}
                          onChange={e => setTargetMangaId(e.target.value)}
                        >
                          <option value="">— Pick a series —</option>
                          {matches.length > 0 && (
                            <optgroup label="Suggested matches">
                              {matches.map(m => (
                                <option key={m.id} value={m.id}>
                                  {m.title}{m.library_name ? ` (${m.library_name})` : ''}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      )}
                      {!lockedManga && matches.length === 0 && (
                        <p className="tps-field-hint">
                          No close matches in your library. Type a different title in
                          the search box above to look for the right series.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Chapters list */}
              <div className="tps-chapters-card">
                <div className="tps-chapters-toolbar">
                  <h3 className="tps-target-heading" style={{ margin: 0 }}>Chapters</h3>
                  <div className="tps-chapters-actions">
                    <button className="btn btn-ghost btn-sm" onClick={selectAll}>Select all available</button>
                    <button className="btn btn-ghost btn-sm" onClick={selectMissing}>Select missing</button>
                    <button className="btn btn-ghost btn-sm" onClick={selectNone}>Clear</button>
                  </div>
                </div>

                {loadingChapters && (
                  <div className="loading-center" style={{ minHeight: 120 }}>
                    <div className="spinner" />
                  </div>
                )}
                {chaptersError && <p className="tps-error">{chaptersError}</p>}

                {chapters && chapters.length === 0 && (
                  <p className="tps-field-hint">No English chapters available for this series.</p>
                )}

                {chapters && chapters.length > 0 && (
                  <ul className="tps-chapter-list">
                    {chapters.map(ch => (
                      <li
                        key={ch.id}
                        className={`tps-chapter-row${ch.already_downloaded ? ' tps-chapter-row-already' : ''}`}
                      >
                        <label className="tps-chapter-label">
                          <input
                            type="checkbox"
                            checked={selected.has(ch.id)}
                            onChange={() => toggleChapter(ch.id)}
                            disabled={ch.already_downloaded}
                          />
                          <span className="tps-chapter-text">{chapterLabel(ch)}</span>
                        </label>
                        <span className="tps-chapter-meta">
                          {ch.group && <span className="tps-chapter-group">{ch.group}</span>}
                          {ch.pages > 0 && <span>{ch.pages}p</span>}
                          {ch.already_downloaded && <span className="tps-chapter-badge">already in library</span>}
                          {ch.external_url && <span className="tps-chapter-badge tps-chapter-badge-warn">external</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Submit row */}
              <div className="tps-submit-row">
                <span className="tps-selected-count">
                  {selected.size} chapter{selected.size === 1 ? '' : 's'} selected
                </span>
                {submitError && <span className="tps-error" style={{ margin: 0 }}>{submitError}</span>}
                {submitInfo && <span className="tps-info">{submitInfo}</span>}
                <button
                  className="btn btn-primary"
                  disabled={submitting || selected.size === 0}
                  onClick={handleDownload}
                >
                  {submitting ? 'Queueing…' : `Download ${selected.size || ''} chapter${selected.size === 1 ? '' : 's'}`}
                </button>
              </div>
            </section>
          )}

          {/* Downloads queue panel */}
          <section className="tps-downloads">
            <div className="tps-downloads-head">
              <h3 className="tps-downloads-title">Downloads</h3>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleClearFinished}
                disabled={!jobs.some(j => j.status !== 'queued' && j.status !== 'running')}
              >Clear finished</button>
            </div>
            {jobs.length === 0 && <p className="tps-field-hint">No downloads yet.</p>}
            {jobs.length > 0 && (
              <ul className="tps-job-list">
                {jobs.map(j => (
                  <li key={j.id} className="tps-job-row">
                    <div className="tps-job-main">
                      <p className="tps-job-title">
                        <span className={statusBadgeClass(j.status)}>{j.status}</span>
                        {j.source_series_title || '(unknown series)'} — {jobLabel(j)}
                      </p>
                      <p className="tps-job-meta">
                        {j.target_chapter_filename
                          ? <code>{j.target_chapter_filename}</code>
                          : <span>{j.target_mode === 'new' ? `→ ${j.target_folder_name}` : '→ existing series'}</span>
                        }
                        {j.pages_total > 0 && (
                          <span className="tps-job-progress">
                            {' · '}{j.pages_downloaded}/{j.pages_total} pages
                          </span>
                        )}
                      </p>
                      {j.error && <p className="tps-job-error">{j.error}</p>}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      {(j.status === 'queued' || j.status === 'running') && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleCancelJob(j.id)}
                        >Cancel</button>
                      )}
                      {(j.status === 'failed' || j.status === 'cancelled') && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleRetryJob(j.id)}
                          title="Re-queue this download — it'll start over from page 1 at the back of the queue"
                        >Retry</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

// Cleans a series title for use as a folder name. Strips characters the
// filesystem won't accept and collapses whitespace; the server applies the
// same logic on the API side, but doing it here gives the user a chance to
// preview/override before submitting.
function cleanFolderSuggestion(title) {
  if (!title) return '';
  return String(title)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
}
