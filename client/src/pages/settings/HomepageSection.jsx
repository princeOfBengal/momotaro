import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { appAlert, appConfirm } from '../../dialog/dialogService';
import { useUserPref, usePreferences } from '../../context/PreferencesContext';
import GenreChipPicker from '../../components/GenreChipPicker';
import RibbonOrderEditor from '../../components/RibbonOrderEditor';
import ToggleRow from '../../components/ToggleRow';
import '../Settings.css';

const DEFAULT_SORT_OPTIONS = [
  { value: 'title',   label: 'A–Z (title)' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'year',    label: 'Year' },
  { value: 'rating',  label: 'Rating (AniList / MyAnimeList)' },
];

// Discover refresh cadence options. Value is milliseconds; 0 == manual-only.
// Default is one day; values must match what resolveDiscoverSeed() in
// Home.jsx reads from prefs.
const DISCOVER_INTERVAL_OPTIONS = [
  { value: 6 * 60 * 60 * 1000,       label: 'Every 6 hours'  },
  { value: 12 * 60 * 60 * 1000,      label: 'Every 12 hours' },
  { value: 24 * 60 * 60 * 1000,      label: 'Daily (default)' },
  { value: 7 * 24 * 60 * 60 * 1000,  label: 'Weekly' },
  { value: 0,                        label: 'Manual only' },
];
const DEFAULT_DISCOVER_INTERVAL = 24 * 60 * 60 * 1000;

// Art Gallery ribbon ordering on Home. Values mirror Home.jsx's
// GALLERY_ORDER_VALUES — keep in sync.
const GALLERY_ORDER_OPTIONS = [
  { value: 'chronological', label: 'Chronological (newest first)' },
  { value: 'random',        label: 'Random' },
];
const DEFAULT_GALLERY_ORDER = 'chronological';

// Score threshold for the per-genre "Top Manga in <Genre>" ribbons. The home
// endpoint clamps to [0, 10] server-side; matching the same range here.
const DEFAULT_GENRE_MIN_SCORE = 7;
const GENRE_MIN_SCORE_MIN     = 0;
const GENRE_MIN_SCORE_MAX     = 10;
const GENRE_MIN_SCORE_STEP    = 0.5;

function clampGenreMinScore(n) {
  if (!Number.isFinite(n)) return DEFAULT_GENRE_MIN_SCORE;
  return Math.max(GENRE_MIN_SCORE_MIN, Math.min(GENRE_MIN_SCORE_MAX, n));
}
function clampDiscoverMinScore(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

const DISCOVER_POOL_OPTIONS      = [15, 30, 60];
const DEFAULT_DISCOVER_POOL      = 30;
const DISCOVER_VISIBLE_OPTIONS   = [10, 15, 20, 30];
const DEFAULT_DISCOVER_VISIBLE   = 15;
const MATCH_COUNT_OPTIONS        = [1, 2, 3, 4];
const GENRE_RIBBON_COUNT_OPTIONS = [1, 2, 3, 4];

const RECENT_WINDOW_OPTIONS = [
  { value: 24,  label: 'Last 24 hours' },
  { value: 168, label: 'Last 7 days' },
  { value: 720, label: 'Last 30 days' },
  { value: 0,   label: 'All time (default)' },
];

const DEFAULT_RIBBON_ORDER = [
  { id: 'continue', visible: true },
  { id: 'recent',   visible: true },
  { id: 'discover', visible: true },
  { id: 'gallery',  visible: true },
  { id: 'genres',   visible: true },
];

const RIBBON_META = [
  { id: 'continue', label: 'Continue Reading',
    description: 'Recently opened series, most-recent first.' },
  { id: 'recent',   label: 'Recently Added',
    description: 'Newest titles from the latest scan.' },
  { id: 'discover', label: 'Discover New Series',
    description: 'Unread titles matching your favourite genres.' },
  { id: 'gallery',  label: 'Art Gallery',
    description: 'Pages you saved while reading.' },
  { id: 'genres',   label: 'Top Manga in <Genre> ribbons',
    description: 'One ribbon per favourite genre.' },
];

export default function HomepageSection() {
  // Every setting in this section is a server-synced preference via
  // useUserPref. Defaults match Home.jsx's behaviour pre-rollout so an empty
  // pref store renders exactly the same Home as before this change shipped.
  const [defaultSort, setDefaultSort]             = useUserPref('home_default_sort', 'title');
  const [discoverInterval, setDiscoverInterval]   = useUserPref('home_discover_refresh_ms', DEFAULT_DISCOVER_INTERVAL);
  const [genreMinScore, setGenreMinScore]         = useUserPref('home_genre_score_threshold', DEFAULT_GENRE_MIN_SCORE);
  const [galleryOrder, setGalleryOrder]           = useUserPref('home_gallery_order', DEFAULT_GALLERY_ORDER);
  const [discoverMinScore, setDiscoverMinScore]   = useUserPref('home_discover_min_score', 0);
  const [excludedGenres, setExcludedGenres]       = useUserPref('home_discover_excluded_genres', []);
  const [favGenresMode, setFavGenresMode]         = useUserPref('home_favorite_genres_mode', 'auto');
  const [favGenresManual, setFavGenresManual]     = useUserPref('home_favorite_genres_manual', []);
  const [minMatchCount, setMinMatchCount]         = useUserPref('home_discover_min_match_count', 1);
  const [discoverLibIds, setDiscoverLibIds]       = useUserPref('home_discover_library_ids', []);
  const [skipBookmarked, setSkipBookmarked]       = useUserPref('home_discover_skip_bookmarked', false);
  const [poolSize, setPoolSize]                   = useUserPref('home_discover_pool_size', DEFAULT_DISCOVER_POOL);
  const [visibleCount, setVisibleCount]           = useUserPref('home_discover_visible_count', DEFAULT_DISCOVER_VISIBLE);
  const [ribbonOrder, setRibbonOrder]             = useUserPref('home_ribbon_order', DEFAULT_RIBBON_ORDER);
  const [resumeHeroEnabled, setResumeHeroEnabled] = useUserPref('home_resume_hero_enabled', true);
  const [genreRibbonCount, setGenreRibbonCount]   = useUserPref('home_genre_ribbon_count', 4);
  const [recentWindowHours, setRecentWindowHours] = useUserPref('home_recent_window_hours', 0);

  const { setPref } = usePreferences();

  // Library list for the Discover library-scope picker. The checklist below
  // renders against it; empty array == "all libraries" (server semantics
  // match — the empty case never hits the SQL IN-clause branch).
  const [libraries, setLibraries] = useState(null);
  useEffect(() => {
    api.getLibraries().then(setLibraries).catch(() => setLibraries([]));
  }, []);

  // Whenever the user changes a Discover-affecting filter, clear the
  // transient per-device reshuffle stamp so the next Home visit picks a fresh
  // seed — otherwise they'd change a filter and not see any visible effect
  // until the existing rotation window elapses.
  useEffect(() => {
    try {
      localStorage.removeItem('home_discover_last_refresh');
      localStorage.removeItem('home_discover_seed');
    } catch (_) { /* localStorage disabled — non-fatal */ }
  }, [
    discoverMinScore, excludedGenres, favGenresMode, favGenresManual,
    minMatchCount, discoverLibIds, skipBookmarked, poolSize, visibleCount,
    discoverInterval,
  ]);

  function handleResetDiscoverNow() {
    try {
      localStorage.removeItem('home_discover_last_refresh');
      localStorage.removeItem('home_discover_seed');
    } catch (_) { /* non-fatal */ }
    appAlert('Discover picks will reshuffle the next time you open Home.');
  }

  async function handleResetAll() {
    if (!(await appConfirm('Reset every Homepage setting to its default? Your changes on this account will be cleared on every device.', { danger: true, okLabel: 'Reset' }))) return;
    setPref('home_default_sort',             'title');
    setPref('home_discover_refresh_ms',      DEFAULT_DISCOVER_INTERVAL);
    setPref('home_genre_score_threshold',    DEFAULT_GENRE_MIN_SCORE);
    setPref('home_gallery_order',            DEFAULT_GALLERY_ORDER);
    setPref('home_discover_min_score',       0);
    setPref('home_discover_excluded_genres', []);
    setPref('home_favorite_genres_mode',     'auto');
    setPref('home_favorite_genres_manual',   []);
    setPref('home_discover_min_match_count', 1);
    setPref('home_discover_library_ids',     []);
    setPref('home_discover_skip_bookmarked', false);
    setPref('home_discover_pool_size',       DEFAULT_DISCOVER_POOL);
    setPref('home_discover_visible_count',   DEFAULT_DISCOVER_VISIBLE);
    setPref('home_ribbon_order',             DEFAULT_RIBBON_ORDER);
    setPref('home_resume_hero_enabled',      true);
    setPref('home_genre_ribbon_count',       4);
    setPref('home_recent_window_hours',      0);
  }

  function toggleLibraryScope(id) {
    const set = new Set(discoverLibIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setDiscoverLibIds(Array.from(set));
  }

  // <select> values come in as strings; coerce on the boundary.
  function asNumber(v, fallback) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Homepage Settings</h2>
          <p className="sp-section-desc">
            Controls for the Home page and the main library page.
            These preferences are saved to your account and sync across devices.
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleResetAll}
          style={{ flexShrink: 0 }}
          title="Reset every Homepage setting to its default"
        >
          Reset to defaults
        </button>
      </div>

      {/* ── Group A — Library default ── */}
      <div className="rs-group">
        <p className="rs-group-title">Library default</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Default sort order</label>
            <p className="rs-setting-hint">
              How manga are ordered when you open a library, All Libraries, or a reading list.
              You can still change the sort from the top bar at any time. Rating uses the score
              from AniList or MyAnimeList; unrated titles are pushed to the bottom.
            </p>
            <select
              className="setting-select"
              value={defaultSort}
              onChange={e => setDefaultSort(e.target.value)}
              style={{ maxWidth: 320 }}
            >
              {DEFAULT_SORT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Group B — Discover New Series ── */}
      <div className="rs-group">
        <p className="rs-group-title">Discover New Series</p>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Discover refresh interval</label>
            <p className="rs-setting-hint">
              Controls how often the <strong>Discover New Series</strong> ribbon on Home
              reshuffles its picks. The underlying candidate list is ranked by how many of
              your favourite genres each manga matches; the visible slice rotates on this
              cadence so the same titles don't stay on top forever.
              A manual <em>Refresh</em> button is always available from Home.
            </p>
            <select
              className="setting-select"
              value={String(discoverInterval)}
              onChange={e => setDiscoverInterval(asNumber(e.target.value, DEFAULT_DISCOVER_INTERVAL))}
              style={{ maxWidth: 320 }}
            >
              {DISCOVER_INTERVAL_OPTIONS.map(o => (
                <option key={o.value} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleResetDiscoverNow}
              >
                Reshuffle now
              </button>
            </div>
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label" htmlFor="discover-min-score">
              Discover quality threshold
            </label>
            <p className="rs-setting-hint">
              Minimum AniList / MyAnimeList score a manga must have to be eligible for
              Discover. Set to <em>Any rating</em> to include unrated titles.
            </p>
            <div className="genre-threshold-row">
              <input
                id="discover-min-score"
                type="range"
                min={GENRE_MIN_SCORE_MIN}
                max={GENRE_MIN_SCORE_MAX}
                step={GENRE_MIN_SCORE_STEP}
                value={discoverMinScore}
                onChange={e => setDiscoverMinScore(clampDiscoverMinScore(parseFloat(e.target.value)))}
                className="genre-threshold-slider"
              />
              <span className="genre-threshold-value" aria-live="polite">
                {discoverMinScore <= 0 ? 'Any rating' : `≥ ${discoverMinScore.toFixed(1)}`}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setDiscoverMinScore(0)}
                disabled={discoverMinScore === 0}
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label" htmlFor="genre-min-score">
              Genre ribbon rating threshold
            </label>
            <p className="rs-setting-hint">
              Minimum AniList / MyAnimeList score a manga must have to appear in the
              <strong> Top Manga in &lt;Genre&gt;</strong> ribbons on Home. The visible picks are
              randomised from every title in the genre that meets this threshold and
              rotate on the same cadence as <em>Discover New Series</em>. Titles with
              no rating are never included.
            </p>
            <div className="genre-threshold-row">
              <input
                id="genre-min-score"
                type="range"
                min={GENRE_MIN_SCORE_MIN}
                max={GENRE_MIN_SCORE_MAX}
                step={GENRE_MIN_SCORE_STEP}
                value={genreMinScore}
                onChange={e => setGenreMinScore(clampGenreMinScore(parseFloat(e.target.value)))}
                className="genre-threshold-slider"
              />
              <span className="genre-threshold-value" aria-live="polite">
                {genreMinScore <= 0 ? 'Any rating' : `≥ ${genreMinScore.toFixed(1)}`}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setGenreMinScore(DEFAULT_GENRE_MIN_SCORE)}
                disabled={genreMinScore === DEFAULT_GENRE_MIN_SCORE}
                title={`Reset to default (${DEFAULT_GENRE_MIN_SCORE.toFixed(1)})`}
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Excluded genres</label>
            <p className="rs-setting-hint">
              Titles tagged with any of these genres are removed from Discover entirely,
              even if they match a favourite genre. Useful for permanently filtering out
              themes you never want suggested.
            </p>
            <GenreChipPicker
              value={excludedGenres}
              onChange={setExcludedGenres}
              mode="exclude"
              placeholder="No genres excluded."
            />
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Favourite genres</label>
            <p className="rs-setting-hint">
              <em>Automatic</em> derives your favourites from the genres you've read most.
              <em> Manual</em> lets you pick up to four genres yourself — useful if your
              read history doesn't yet reflect your taste, or if you want to explore a
              different lane.
            </p>
            <div className="setting-options" style={{ marginBottom: 10 }}>
              {[
                { value: 'auto',   label: 'Automatic' },
                { value: 'manual', label: 'Manual' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${favGenresMode === value ? ' active' : ''}`}
                  onClick={() => setFavGenresMode(value)}
                >{label}</button>
              ))}
            </div>
            {favGenresMode === 'manual' && (
              <GenreChipPicker
                value={favGenresManual}
                onChange={setFavGenresManual}
                max={4}
                mode="select"
                placeholder="Pick 1–4 genres."
              />
            )}
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Minimum matching genres</label>
            <p className="rs-setting-hint">
              How many of your favourite genres a title must match to be eligible.
              Higher values narrow Discover to titles closest to your taste.
            </p>
            <div className="setting-options">
              {MATCH_COUNT_OPTIONS.map(n => (
                <button
                  key={n}
                  className={`setting-btn${minMatchCount === n ? ' active' : ''}`}
                  onClick={() => setMinMatchCount(n)}
                >{n}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Library scope</label>
            <p className="rs-setting-hint">
              Restrict Discover to specific libraries. Leave every box checked to draw
              from every library visible in <em>All Libraries</em>.
            </p>
            {libraries === null ? (
              <div className="loading-center"><div className="spinner" /></div>
            ) : libraries.length === 0 ? (
              <p className="rs-setting-hint">No libraries configured.</p>
            ) : (
              <div className="hs-lib-checklist">
                {libraries.map(lib => {
                  const checked = discoverLibIds.length === 0 || discoverLibIds.includes(lib.id);
                  return (
                    <label key={lib.id} className="hs-lib-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          // Treat an empty selection as "all" (server semantics
                          // match). Switch from implicit-all to explicit list
                          // on first unchecking.
                          if (discoverLibIds.length === 0) {
                            setDiscoverLibIds(libraries.filter(l => l.id !== lib.id).map(l => l.id));
                          } else {
                            toggleLibraryScope(lib.id);
                          }
                        }}
                      />
                      <span>{lib.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <ToggleRow
            label="Skip already-bookmarked titles"
            desc="Hide manga that already appear in any of your reading lists, so Discover only surfaces titles you haven't saved."
            value={skipBookmarked}
            onChange={setSkipBookmarked}
          />
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Candidate pool size</label>
            <p className="rs-setting-hint">
              How many candidate titles the server returns. A larger pool gives Discover
              more variety to rotate through; smaller pools focus on the very best matches.
            </p>
            <div className="setting-options">
              {DISCOVER_POOL_OPTIONS.map(n => (
                <button
                  key={n}
                  className={`setting-btn${poolSize === n ? ' active' : ''}`}
                  onClick={() => setPoolSize(n)}
                >{n}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Visible tile count</label>
            <p className="rs-setting-hint">
              How many tiles appear in the Discover ribbon at once. The pool above sets
              what the rotation chooses from; this is what you actually see.
            </p>
            <div className="setting-options">
              {DISCOVER_VISIBLE_OPTIONS.map(n => (
                <button
                  key={n}
                  className={`setting-btn${visibleCount === n ? ' active' : ''}`}
                  onClick={() => setVisibleCount(n)}
                >{n}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Group C — Layout ── */}
      <div className="rs-group">
        <p className="rs-group-title">Layout</p>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Ribbon visibility &amp; order</label>
            <p className="rs-setting-hint">
              Reorder Home's ribbons or hide any you don't use. Changes apply immediately.
            </p>
            <RibbonOrderEditor
              value={ribbonOrder}
              onChange={setRibbonOrder}
              ribbons={RIBBON_META}
            />
          </div>
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <ToggleRow
            label="Resume Hero"
            desc="The large card above the ribbons that links to your most-recent chapter. Turn off to fold the title back into Continue Reading."
            value={resumeHeroEnabled}
            onChange={setResumeHeroEnabled}
          />
        </div>

        <div className="settings-card" style={{ marginBottom: 12 }}>
          <div className="setting-group">
            <label className="setting-group-label">Number of genre ribbons</label>
            <p className="rs-setting-hint">
              How many <strong>Top Manga in &lt;Genre&gt;</strong> ribbons show on Home,
              one per favourite genre. Cap at fewer if Home feels too long.
            </p>
            <div className="setting-options">
              {GENRE_RIBBON_COUNT_OPTIONS.map(n => (
                <button
                  key={n}
                  className={`setting-btn${genreRibbonCount === n ? ' active' : ''}`}
                  onClick={() => setGenreRibbonCount(n)}
                >{n}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label" htmlFor="gallery-order">
              Art Gallery order
            </label>
            <p className="rs-setting-hint">
              How saved pages are ordered in the <strong>Art Gallery</strong> ribbon on
              Home. <em>Chronological</em> shows the most recently saved page first.
              <em> Random</em> shuffles the order each time you open Home.
            </p>
            <select
              id="gallery-order"
              className="setting-select"
              value={galleryOrder}
              onChange={e => setGalleryOrder(e.target.value)}
              style={{ maxWidth: 320 }}
            >
              {GALLERY_ORDER_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Group D — Recently Added ── */}
      <div className="rs-group">
        <p className="rs-group-title">Recently Added</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label" htmlFor="recent-window">
              Time window
            </label>
            <p className="rs-setting-hint">
              Cap the <strong>Recently Added</strong> ribbon to titles added in a recent
              window. <em>All time</em> shows the newest titles unconditionally.
            </p>
            <select
              id="recent-window"
              className="setting-select"
              value={String(recentWindowHours)}
              onChange={e => setRecentWindowHours(asNumber(e.target.value, 0))}
              style={{ maxWidth: 320 }}
            >
              {RECENT_WINDOW_OPTIONS.map(o => (
                <option key={o.value} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
