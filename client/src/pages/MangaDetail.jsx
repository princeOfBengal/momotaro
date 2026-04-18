import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import './MangaDetail.css';

const CHAPTERS_COLLAPSED_COUNT = 5;

// ── Thumbnail Picker Modal ─────────────────────────────────────────────────────
function ThumbOption({ src, label, applying, onUse }) {
  return (
    <div
      className={`thumb-option${applying ? ' thumb-option-applying' : ''}`}
      onClick={!applying ? onUse : undefined}
      title={label || undefined}
    >
      <div className="thumb-option-img-wrap">
        <img src={src} alt={label || ''} loading="lazy" />
        {applying && (
          <div className="thumb-option-overlay">
            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
          </div>
        )}
      </div>
      {label && <span className="thumb-option-label">{label}</span>}
    </div>
  );
}

function ThumbnailPickerModal({ mangaId, onApplied, onClose }) {
  const [options, setOptions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [applying, setApplying] = useState(null);

  useEffect(() => {
    api.getThumbnailOptions(mangaId)
      .then(data => setOptions(data))
      .catch(err => setLoadError(err.message));
  }, [mangaId]);

  async function applyFile(filename) {
    setApplying(filename);
    try {
      await api.setThumbnailFromFile(mangaId, filename);
      onApplied();
    } catch (err) {
      alert('Failed: ' + err.message);
      setApplying(null);
    }
  }

  async function applyPage(pageId) {
    setApplying(pageId);
    try {
      await api.setPageAsThumbnail(mangaId, pageId);
      onApplied();
    } catch (err) {
      alert('Failed: ' + err.message);
      setApplying(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box thumb-picker-modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Choose Thumbnail</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="thumb-picker-body">
          {!options && !loadError && (
            <div className="loading-center" style={{ minHeight: 120 }}>
              <div className="spinner" />
            </div>
          )}
          {loadError && <p className="thumb-picker-error">{loadError}</p>}
          {options && (
            <>
              {options.anilist_cover && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">AniList</h3>
                  <div className="thumb-picker-grid">
                    <ThumbOption
                      src={api.thumbnailUrl(options.anilist_cover)}
                      label="AniList Cover"
                      applying={applying === options.anilist_cover}
                      onUse={() => applyFile(options.anilist_cover)}
                    />
                  </div>
                </div>
              )}

              {options.original_cover && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">Original</h3>
                  <div className="thumb-picker-grid">
                    <ThumbOption
                      src={api.thumbnailUrl(options.original_cover)}
                      label="Scan Default"
                      applying={applying === options.original_cover}
                      onUse={() => applyFile(options.original_cover)}
                    />
                  </div>
                </div>
              )}

              {options.history.length > 0 && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">Previously Used</h3>
                  <div className="thumb-picker-grid">
                    {options.history.map(h => (
                      <ThumbOption
                        key={h.id}
                        src={api.thumbnailUrl(h.filename)}
                        applying={applying === h.filename}
                        onUse={() => applyFile(h.filename)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {options.chapter_first_pages.length > 0 && (
                <div className="thumb-picker-section">
                  <h3 className="thumb-picker-section-title">Chapter Covers</h3>
                  <div className="thumb-picker-grid">
                    {options.chapter_first_pages.map(ch => (
                      <ThumbOption
                        key={ch.chapter_id}
                        src={api.pageImageUrl(ch.page_id)}
                        label={ch.label}
                        applying={applying === ch.page_id}
                        onUse={() => applyPage(ch.page_id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {!options.anilist_cover && !options.original_cover && options.history.length === 0 && options.chapter_first_pages.length === 0 && (
                <p className="thumb-picker-empty">No thumbnail options available yet. Read a chapter first to generate options.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Manual Search Modal ────────────────────────────────────────────────────────
function AnilistSearchModal({ mangaId, defaultQuery, onApplied, onClose }) {
  const [query, setQuery] = useState(defaultQuery || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.searchAnilist(q.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  // Auto-search on open with default query
  useEffect(() => {
    if (defaultQuery) doSearch(defaultQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApply(result) {
    setApplying(result.anilist_id);
    try {
      const updated = await api.applyMetadata(mangaId, result.anilist_id);
      onApplied(updated);
    } catch (err) {
      alert('Failed to apply: ' + err.message);
      setApplying(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') doSearch(query);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Search AniList</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-search-row">
          <input
            className="modal-search-input"
            type="text"
            placeholder="Search manga title..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="btn btn-primary"
            onClick={() => doSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div className="modal-results">
          {searchError && <p className="modal-error">{searchError}</p>}
          {results.map(r => (
            <div key={r.anilist_id} className="modal-result-row">
              {r.cover_url && (
                <img
                  className="modal-result-cover"
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                />
              )}
              <div className="modal-result-info">
                <p className="modal-result-title">{r.title}</p>
                <p className="modal-result-meta">
                  {r.year && <span>{r.year}</span>}
                  {r.status && <span>{r.status}</span>}
                  {r.score && <span>★ {r.score.toFixed(1)}</span>}
                </p>
                {r.genres.length > 0 && (
                  <p className="modal-result-genres">
                    {r.genres.slice(0, 4).join(' · ')}
                  </p>
                )}
              </div>
              <button
                className="btn btn-primary modal-result-btn"
                disabled={applying === r.anilist_id}
                onClick={() => handleApply(r)}
              >
                {applying === r.anilist_id ? '...' : 'Use'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Doujinshi.Info Search Modal ────────────────────────────────────────────────
function DoujinshiSearchModal({ mangaId, defaultQuery, onApplied, onClose }) {
  const [query, setQuery] = useState(defaultQuery || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.searchDoujinshi(q.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (defaultQuery) doSearch(defaultQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApply(result) {
    setApplying(result.doujinshi_id);
    try {
      const updated = await api.applyDoujinshiMetadata(mangaId, result.doujinshi_id);
      onApplied(updated);
    } catch (err) {
      alert('Failed to apply: ' + err.message);
      setApplying(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') doSearch(query);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Search Doujinshi.info</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-search-row">
          <input
            className="modal-search-input"
            type="text"
            placeholder="Search title..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="btn btn-primary"
            onClick={() => doSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div className="modal-results">
          {searchError && <p className="modal-error">{searchError}</p>}
          {results.map(r => (
            <div key={r.doujinshi_id} className="modal-result-row">
              {r.cover_url && (
                <img
                  className="modal-result-cover"
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                />
              )}
              <div className="modal-result-info">
                <p className="modal-result-title">{r.title}</p>
                <p className="modal-result-meta">
                  {r.year && <span>{r.year}</span>}
                  {r.status && <span>{r.status}</span>}
                </p>
                {r.genres && r.genres.length > 0 && (
                  <p className="modal-result-genres">
                    {r.genres.slice(0, 4).join(' · ')}
                  </p>
                )}
              </div>
              <button
                className="btn btn-primary modal-result-btn"
                disabled={applying === r.doujinshi_id}
                onClick={() => handleApply(r)}
              >
                {applying === r.doujinshi_id ? '...' : 'Use'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── MyAnimeList Search Modal ──────────────────────────────────────────────────
function MALSearchModal({ mangaId, defaultQuery, onApplied, onClose }) {
  const [query, setQuery] = useState(defaultQuery || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.searchMal(q.trim());
      setResults(data);
      if (data.length === 0) setSearchError('No results found.');
    } catch (err) {
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (defaultQuery) doSearch(defaultQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleApply(result) {
    setApplying(result.mal_id);
    try {
      const updated = await api.applyMalMetadata(mangaId, result.mal_id);
      onApplied(updated);
    } catch (err) {
      alert('Failed to apply: ' + err.message);
      setApplying(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') doSearch(query);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Search MyAnimeList</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-search-row">
          <input
            className="modal-search-input"
            type="text"
            placeholder="Search manga title..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <button
            className="btn btn-primary"
            onClick={() => doSearch(query)}
            disabled={searching || !query.trim()}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>

        <div className="modal-results">
          {searchError && <p className="modal-error">{searchError}</p>}
          {results.map(r => (
            <div key={r.mal_id} className="modal-result-row">
              {r.cover_url && (
                <img
                  className="modal-result-cover"
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                />
              )}
              <div className="modal-result-info">
                <p className="modal-result-title">{r.title}</p>
                <p className="modal-result-meta">
                  {r.year && <span>{r.year}</span>}
                  {r.status && <span>{r.status}</span>}
                  {r.score && <span>★ {r.score.toFixed(1)}</span>}
                </p>
                {r.genres && r.genres.length > 0 && (
                  <p className="modal-result-genres">
                    {r.genres.slice(0, 4).join(' · ')}
                  </p>
                )}
              </div>
              <button
                className="btn btn-primary modal-result-btn"
                disabled={applying === r.mal_id}
                onClick={() => handleApply(r)}
              >
                {applying === r.mal_id ? '...' : 'Use'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── AniList Status Panel ───────────────────────────────────────────────────────
const STATUS_LABELS = {
  CURRENT:   'Reading',
  COMPLETED: 'Completed',
  PLANNING:  'Plan to Read',
  DROPPED:   'Dropped',
  PAUSED:    'Paused',
  REPEATING: 'Re-Reading',
};

function formatAnilistDate(d) {
  if (!d || !d.year) return null;
  const parts = [d.year, d.month, d.day].filter(Boolean);
  if (parts.length === 3) return new Date(d.year, d.month - 1, d.day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (parts.length === 2) return new Date(d.year, d.month - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  return String(d.year);
}

function EditableNumber({ value, onSave, saving, step = 1, min = 0, max, display }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  function startEdit() {
    setDraft(String(value ?? 0));
    setEditing(true);
  }

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    const n = step === 1 ? parseInt(draft, 10) : parseFloat(draft);
    const clamped = max !== undefined ? Math.min(max, Math.max(min, n)) : Math.max(min, n);
    if (!isNaN(clamped) && clamped !== (value ?? 0)) {
      onSave(clamped);
    }
    setEditing(false);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setEditing(false);
  }

  if (editing) {
    return (
      <span className="al-edit-inline">
        <input
          ref={inputRef}
          type="number"
          min={min}
          max={max}
          step={step}
          className="al-edit-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        {max !== undefined && <span className="al-edit-max">/ {max}</span>}
      </span>
    );
  }

  return (
    <span className="al-edit-inline">
      <span className="al-status-value">{display ?? (value ?? 0)}</span>
      <button
        className="al-edit-btn"
        onClick={startEdit}
        disabled={saving}
        title="Edit"
      >✎</button>
    </span>
  );
}

function AnilistStatusPanel({ status, onEntryChange, onBreakLinkage, mangaId }) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  if (status === null) {
    return (
      <div className="al-status-panel al-status-loading">
        <div className="al-status-header">
          <span className="al-status-source">AniList</span>
        </div>
        <div className="al-status-skeleton" />
      </div>
    );
  }

  if (!status.logged_in) {
    return (
      <div className="al-status-panel al-status-disconnected">
        <div className="al-status-header">
          <span className="al-status-source">AniList</span>
          <span className="al-status-hint">Connect an AniList account in Settings to see your reading status here.</span>
        </div>
      </div>
    );
  }

  if (!status.linked) {
    return (
      <div className="al-status-panel al-status-disconnected">
        <div className="al-status-header">
          <span className="al-status-source">AniList</span>
          <span className="al-status-hint">No AniList entry linked. Use <em>Fetch Metadata</em> below to link this manga.</span>
        </div>
      </div>
    );
  }

  const { entry, anilist_id } = status;

  async function handleSave(field, value) {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {};
      if (field === 'chapters') body.chapters = value;
      if (field === 'volumes')  body.volumes  = value;
      if (field === 'status')   body.status   = value;
      if (field === 'score')    body.score    = value;
      const result = await api.updateAnilistProgress(mangaId, body);
      onEntryChange(result.entry);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="al-status-panel">
      <div className="al-status-header">
        <span className="al-status-source">AniList</span>
        {anilist_id && (
          <div className="al-status-header-links">
            <a
              className="al-status-link"
              href={`https://anilist.co/manga/${anilist_id}`}
              target="_blank"
              rel="noreferrer"
            >
              View on AniList ↗
            </a>
            {onBreakLinkage && (
              <button
                type="button"
                className="al-status-break-btn"
                onClick={onBreakLinkage}
              >
                Break Linkage
              </button>
            )}
          </div>
        )}
      </div>

      {!entry ? (
        <p className="al-status-empty">Not on your list yet. Progress will be added automatically when you read.</p>
      ) : (
        <div className="al-status-body">
          {saveError && <p className="al-save-error">{saveError}</p>}

          <div className="al-status-row">
            <span className="al-status-field">Status</span>
            <select
              className={`al-status-badge al-badge-${entry.status?.toLowerCase()} al-status-select`}
              value={entry.status || 'CURRENT'}
              onChange={e => handleSave('status', e.target.value)}
              disabled={saving}
            >
              {Object.entries(STATUS_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>

          <div className="al-status-row">
            <span className="al-status-field">Chapters Read</span>
            <EditableNumber
              value={entry.progress ?? 0}
              saving={saving}
              onSave={n => handleSave('chapters', n)}
            />
          </div>

          <div className="al-status-row">
            <span className="al-status-field">Volumes Read</span>
            <EditableNumber
              value={entry.progressVolumes ?? 0}
              saving={saving}
              onSave={n => handleSave('volumes', n)}
            />
          </div>

          <div className="al-status-row">
            <span className="al-status-field">Your Score</span>
            <EditableNumber
              value={entry.score ?? 0}
              saving={saving}
              step={0.5}
              min={0}
              max={10}
              display={entry.score > 0 ? `★ ${entry.score % 1 === 0 ? entry.score : entry.score.toFixed(1)}` : '—'}
              onSave={n => handleSave('score', n)}
            />
          </div>

          {formatAnilistDate(entry.startedAt) && (
            <div className="al-status-row">
              <span className="al-status-field">Started</span>
              <span className="al-status-value">{formatAnilistDate(entry.startedAt)}</span>
            </div>
          )}

          {formatAnilistDate(entry.completedAt) && (
            <div className="al-status-row">
              <span className="al-status-field">Completed</span>
              <span className="al-status-value">{formatAnilistDate(entry.completedAt)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function MangaDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [manga, setManga] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [coverBust, setCoverBust] = useState(0);
  const [showThumbPicker, setShowThumbPicker] = useState(false);

  // Metadata fetch state
  const [fetchingMeta, setFetchingMeta] = useState(false);
  const [exportingMangaMeta, setExportingMangaMeta] = useState(false);
  const [metaMessage, setMetaMessage] = useState(null); // { type: 'success'|'error'|'notfound', text }
  const [showSearch, setShowSearch] = useState(false);
  const [showDoujinshiSearch, setShowDoujinshiSearch] = useState(false);
  const [showMALSearch, setShowMALSearch] = useState(false);
  const [metaSource, setMetaSource] = useState('anilist'); // 'anilist' | 'myanimelist' | 'doujinshi'
  const [savingTrackSetting, setSavingTrackSetting] = useState(false);

  // AniList reading status
  const [anilistStatus, setAnilistStatus] = useState(null); // null = loading

  // Reading lists
  const [readingLists, setReadingLists] = useState([]);
  const [mangaListIds, setMangaListIds] = useState(new Set());
  const [togglingList, setTogglingList] = useState(null);
  const [showListDropdown, setShowListDropdown] = useState(false);
  const [showMetaModal, setShowMetaModal] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [markingChapters, setMarkingChapters] = useState(new Set());
  const [showAllChapters, setShowAllChapters] = useState(false);
  const [gallery, setGallery] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [removingGalleryIds, setRemovingGalleryIds] = useState(new Set());
  const listDropdownRef = useRef(null);
  const settingsDropdownRef = useRef(null);

  useEffect(() => {
    if (!showListDropdown) return;
    function onMouseDown(e) {
      if (listDropdownRef.current && !listDropdownRef.current.contains(e.target)) {
        setShowListDropdown(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showListDropdown]);

  useEffect(() => {
    if (!showSettingsDropdown) return;
    function onMouseDown(e) {
      if (settingsDropdownRef.current && !settingsDropdownRef.current.contains(e.target)) {
        setShowSettingsDropdown(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showSettingsDropdown]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Optimize
  const [showOptimize, setShowOptimize] = useState(false);
  const [optimizePhase, setOptimizePhase] = useState('confirm'); // 'confirm' | 'running' | 'done'
  const [optimizeResult, setOptimizeResult] = useState(null);

  // More Info
  const [showInfo, setShowInfo] = useState(false);
  const [infoData, setInfoData] = useState(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState(null);

  // Nav drawer (libraries + reading lists)
  const [showNavDrawer, setShowNavDrawer] = useState(false);
  const [navLibraries, setNavLibraries] = useState([]);
  const [navLists, setNavLists] = useState([]);
  const [navLoaded, setNavLoaded] = useState(false);

  useEffect(() => {
    setLoading(true);
    setAnilistStatus(null);
    Promise.all([
      api.getManga(id),
      api.getAnilistStatus(id),
      api.getReadingLists(),
      api.getMangaReadingLists(id),
    ]).then(([mangaData, statusData, listsData, listIds]) => {
      setManga(mangaData);
      setAnilistStatus(statusData);
      setReadingLists(listsData);
      setMangaListIds(new Set(listIds));
      setLoading(false);
    }).catch(err => { setError(err.message); setLoading(false); });
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setGalleryLoading(true);
    api.getGallery(id).then(items => {
      if (cancelled) return;
      setGallery(items);
      setGalleryLoading(false);
    }).catch(() => { if (!cancelled) setGalleryLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  async function handleRemoveFromGallery(itemId) {
    if (removingGalleryIds.has(itemId)) return;
    setRemovingGalleryIds(s => new Set([...s, itemId]));
    try {
      await api.removeFromGallery(id, itemId);
      setGallery(prev => prev.filter(item => item.id !== itemId));
    } catch {
      // Leave the item in place; user can retry
    } finally {
      setRemovingGalleryIds(s => { const n = new Set(s); n.delete(itemId); return n; });
    }
  }

  function formatChapterLabel(item) {
    const vol = item.chapter_volume;
    const num = item.chapter_number;
    if (vol !== null && num !== null) return `Vol. ${vol} Ch. ${num}`;
    if (vol !== null)                  return `Volume ${vol}`;
    if (num !== null)                  return (manga?.track_volumes ? `Volume ${num}` : `Chapter ${num}`);
    return item.chapter_folder_name || '';
  }

  async function handleToggleList(listId) {
    if (togglingList === listId) return;
    setTogglingList(listId);
    try {
      if (mangaListIds.has(listId)) {
        await api.removeFromReadingList(listId, manga.id);
        setMangaListIds(prev => { const s = new Set(prev); s.delete(listId); return s; });
      } else {
        await api.addToReadingList(listId, manga.id);
        setMangaListIds(prev => new Set([...prev, listId]));
      }
    } catch (err) {
      alert('Failed to update reading list: ' + err.message);
    } finally {
      setTogglingList(null);
    }
  }

  async function handleResetProgress() {
    if (!confirm('Reset all reading progress for this manga?')) return;
    try {
      await api.resetProgress(id);
      const data = await api.getManga(id);
      setManga(data);
    } catch (err) {
      alert('Failed to reset progress: ' + err.message);
    }
  }

  async function handleToggleTrackVolumes() {
    if (savingTrackSetting) return;
    const newVal = !manga.track_volumes;
    setSavingTrackSetting(true);
    try {
      await api.updateManga(id, { track_volumes: newVal });
      setManga(prev => ({ ...prev, track_volumes: newVal ? 1 : 0 }));
    } catch (err) {
      alert('Failed to save setting: ' + err.message);
    } finally {
      setSavingTrackSetting(false);
    }
  }

  async function handleFetchMetadata() {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.refreshMetadata(id);
      if (result.found) {
        setManga(prev => ({ ...prev, ...result.data, chapters: prev.chapters, progress: prev.progress }));
        setCoverBust(Date.now());
        setMetaMessage({ type: 'success', text: 'Metadata fetched from AniList.' });
      } else {
        setMetaMessage({ type: 'notfound', text: result.message || 'No match found on AniList.' });
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  async function handleFetchDoujinshiMetadata() {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.refreshDoujinshiMetadata(id);
      if (result.found) {
        setManga(prev => ({ ...prev, ...result.data, chapters: prev.chapters, progress: prev.progress }));
        setCoverBust(Date.now());
        setMetaMessage({ type: 'success', text: 'Metadata fetched from Doujinshi.info.' });
      } else {
        setMetaMessage({ type: 'notfound', text: result.message || 'No match found on Doujinshi.info.' });
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  function handleMetadataApplied(updated) {
    setManga(prev => ({ ...prev, ...updated, chapters: prev.chapters, progress: prev.progress }));
    setCoverBust(Date.now());
    setShowSearch(false);
    setShowDoujinshiSearch(false);
    setShowMetaModal(true);
    setMetaMessage({ type: 'success', text: 'Metadata applied from AniList.' });
  }

  function handleDoujinshiMetadataApplied(updated) {
    setManga(prev => ({ ...prev, ...updated, chapters: prev.chapters, progress: prev.progress }));
    setCoverBust(Date.now());
    setShowDoujinshiSearch(false);
    setShowMetaModal(true);
    setMetaMessage({ type: 'success', text: 'Metadata applied from Doujinshi.info.' });
  }

  async function handleResetMetadata(source) {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.resetMetadata(id, source);
      setManga(prev => ({ ...prev, ...result, chapters: prev.chapters, progress: prev.progress }));
      setMetaMessage({ type: 'success', text: 'Metadata linkage removed.' });
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  async function handleBreakAnilistLinkage() {
    if (!confirm('Remove the AniList link for this manga?')) return;
    try {
      const result = await api.resetMetadata(id, 'anilist');
      setManga(prev => ({ ...prev, ...result, chapters: prev.chapters, progress: prev.progress }));
      setCoverBust(Date.now());
      // AniList panel state reflects the new unlinked status
      setAnilistStatus(prev => prev?.logged_in
        ? { logged_in: true, linked: false }
        : prev);
    } catch (err) {
      alert('Failed to remove AniList linkage: ' + err.message);
    }
  }

  async function handleFetchMalMetadata() {
    setFetchingMeta(true);
    setMetaMessage(null);
    try {
      const result = await api.refreshMalMetadata(id);
      if (result.found) {
        setManga(prev => ({ ...prev, ...result.data, chapters: prev.chapters, progress: prev.progress }));
        setCoverBust(Date.now());
        setMetaMessage({ type: 'success', text: 'Metadata fetched from MyAnimeList.' });
      } else {
        setMetaMessage({ type: 'notfound', text: result.message || 'No match found on MyAnimeList.' });
      }
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setFetchingMeta(false);
    }
  }

  function handleMalMetadataApplied(updated) {
    setManga(prev => ({ ...prev, ...updated, chapters: prev.chapters, progress: prev.progress }));
    setCoverBust(Date.now());
    setShowMALSearch(false);
    setShowMetaModal(true);
    setMetaMessage({ type: 'success', text: 'Metadata applied from MyAnimeList.' });
  }

  async function handleExportMangaMetadata() {
    setExportingMangaMeta(true);
    setMetaMessage(null);
    try {
      await api.exportMangaMetadata(id);
      setMetaMessage({ type: 'success', text: 'Metadata exported — metadata.json saved to the manga\'s folder.' });
    } catch (err) {
      setMetaMessage({ type: 'error', text: 'Export failed: ' + err.message });
    } finally {
      setExportingMangaMeta(false);
    }
  }

  if (loading) return (
    <div className="detail-page">
      <nav className="navbar">
        <button className="detail-nav-hamburger" onClick={openNavDrawer} aria-label="Browse libraries">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/" className="btn btn-ghost">← Back</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
        <div className="navbar-spacer" />
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">⚙</button>
      </nav>
      <div className="loading-center"><div className="spinner" /></div>
    </div>
  );

  if (error) return (
    <div className="detail-page">
      <nav className="navbar">
        <button className="detail-nav-hamburger" onClick={openNavDrawer} aria-label="Browse libraries">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/" className="btn btn-ghost">← Back</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
        <div className="navbar-spacer" />
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">⚙</button>
      </nav>
      <div className="error-message"><h2>Error</h2><p>{error}</p></div>
    </div>
  );

  const { chapters = [], progress } = manga;
  const completedIds = new Set(progress?.completed_chapters || []);
  // Reading order (ascending) — used for the "start at first chapter" fallback
  const readingOrderChapters = [...chapters].sort((a, b) => {
    // Use volume as primary sort key for volume-only entries, chapter number otherwise
    const aKey = a.number ?? a.volume;
    const bKey = b.number ?? b.volume;
    if (aKey === null && bKey === null) return a.folder_name.localeCompare(b.folder_name);
    if (aKey === null) return 1;
    if (bKey === null) return -1;
    return aKey - bKey;
  });
  // Display order (descending) — highest chapter/volume on top
  const displayChapters = [...readingOrderChapters].reverse();
  const visibleChapters = showAllChapters ? displayChapters : displayChapters.slice(0, CHAPTERS_COLLAPSED_COUNT);
  const hasMoreChapters = displayChapters.length > CHAPTERS_COLLAPSED_COUNT;

  function continueReading() {
    if (progress?.current_chapter_id) {
      navigate(`/read/${progress.current_chapter_id}?page=${progress.current_page}&mangaId=${id}`);
    } else if (readingOrderChapters.length > 0) {
      navigate(`/read/${readingOrderChapters[0].id}?page=0&mangaId=${id}`);
    }
  }

  async function handleMarkChapter(chapterId, completed) {
    if (markingChapters.has(chapterId)) return;
    const prevProgress = manga.progress;
    setMarkingChapters(s => new Set([...s, chapterId]));
    // Optimistic update so the UI responds instantly
    setManga(prev => {
      const prevCompleted = prev.progress?.completed_chapters || [];
      const newCompleted = completed
        ? Array.from(new Set([...prevCompleted, chapterId]))
        : prevCompleted.filter(cid => cid !== chapterId);
      return { ...prev, progress: { ...(prev.progress || {}), completed_chapters: newCompleted } };
    });
    try {
      const result = await api.markChapterRead(id, chapterId, completed);
      setManga(prev => ({ ...prev, progress: result }));
    } catch {
      setManga(prev => ({ ...prev, progress: prevProgress }));
    } finally {
      setMarkingChapters(s => { const n = new Set(s); n.delete(chapterId); return n; });
    }
  }

  const coverBase = manga.cover_image ? api.thumbnailUrl(manga.cover_image) : null;
  const coverUrl = coverBase ? `${coverBase}${coverBust ? `?t=${coverBust}` : ''}` : null;
  const genres = Array.isArray(manga.genres) ? manga.genres : [];
  const hasMetadata = manga.metadata_source && manga.metadata_source !== 'none';

  async function handleOptimize() {
    setOptimizePhase('running');
    try {
      const result = await api.optimizeManga(id);
      setOptimizeResult(result);
      setOptimizePhase('done');
      // Reload manga so chapter list reflects new names
      const updated = await api.getManga(id);
      setManga(prev => ({ ...prev, ...updated }));
    } catch (err) {
      setOptimizeResult({ error: err.message });
      setOptimizePhase('done');
    }
  }

  function openOptimizeModal() {
    setOptimizePhase('confirm');
    setOptimizeResult(null);
    setShowOptimize(true);
  }

  async function openNavDrawer() {
    setShowNavDrawer(true);
    if (navLoaded) return;
    try {
      const libs = await api.getLibraries();
      setNavLibraries(libs);
      setNavLists(readingLists);
      setNavLoaded(true);
    } catch { /* silently ignore — drawer still opens */ }
  }

  function goToLibrary(libraryId) {
    setShowNavDrawer(false);
    navigate('/', { state: { library: libraryId } });
  }

  function goToList(listId) {
    setShowNavDrawer(false);
    navigate('/', { state: { list: listId } });
  }

  async function handleOpenInfo() {
    setShowInfo(true);
    if (infoData) return; // already fetched
    setInfoLoading(true);
    setInfoError(null);
    try {
      const data = await api.getMangaInfo(id);
      setInfoData(data);
    } catch (err) {
      setInfoError(err.message);
    } finally {
      setInfoLoading(false);
    }
  }

  async function handleDeleteConfirmed() {
    setDeleting(true);
    try {
      await api.deleteManga(manga.id);
      navigate('/');
    } catch (err) {
      setDeleting(false);
      setShowDeleteConfirm(false);
      alert('Delete failed: ' + err.message);
    }
  }

  return (
    <div className="detail-page">
      <nav className="navbar">
        <button className="detail-nav-hamburger" onClick={openNavDrawer} aria-label="Browse libraries">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" clipRule="evenodd" />
          </svg>
        </button>
        <Link to="/" className="btn btn-ghost">← Library</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
        <div className="navbar-spacer" />
        <button
          className="detail-optimize-btn"
          onClick={openOptimizeModal}
          title="Optimize chapters"
          aria-label="Optimize chapters"
        >
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.381z" clipRule="evenodd" />
          </svg>
        </button>
        <button
          className="detail-delete-btn"
          onClick={() => setShowDeleteConfirm(true)}
          title="Delete manga"
          aria-label="Delete manga"
        >
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </button>
        <button className="btn-settings" onClick={() => navigate('/settings')} aria-label="Open settings" title="Settings">⚙</button>
      </nav>

      <main className="detail-main">
        <div className="detail-hero">
          <div className="detail-cover detail-cover-clickable" onClick={() => setShowThumbPicker(true)}>
            {coverUrl
              ? <img src={coverUrl} alt={manga.title} />
              : <div className="detail-cover-placeholder">📖</div>
            }
            <div className="detail-cover-change-hint">Change</div>
          </div>

          <div className="detail-info">
            <h1 className="detail-title">{manga.title}</h1>

            {manga.author && (
              <p className="detail-author">{manga.author}</p>
            )}

            <div className="detail-meta">
              {manga.status && <span className={`detail-status status-${manga.status.toLowerCase()}`}>{manga.status}</span>}
              {manga.year && <span className="detail-year">{manga.year}</span>}
              {manga.score && <span className="detail-score">★ {manga.score.toFixed(1)}</span>}
              {hasMetadata && (
                <span className="detail-source">
                  {manga.metadata_source === 'local'
                    ? 'Local'
                    : manga.anilist_id
                      ? <a href={`https://anilist.co/manga/${manga.anilist_id}`} target="_blank" rel="noreferrer">AniList</a>
                      : 'AniList'
                  }
                </span>
              )}
            </div>

            {genres.length > 0 && (
              <div className="detail-genres">
                {genres.map(g => <span key={g} className="genre-tag">{g}</span>)}
              </div>
            )}

            {manga.description && (
              <p className="detail-description">{manga.description}</p>
            )}

            <div className="detail-stats">
              <span>{chapters.length} {manga.track_volumes ? `volume${chapters.length !== 1 ? 's' : ''}` : `chapter${chapters.length !== 1 ? 's' : ''}`}</span>
              {progress && <span>{completedIds.size} {manga.track_volumes ? (completedIds.size !== 1 ? 'volumes' : 'volume') : (completedIds.size !== 1 ? 'chapters' : 'chapter')} read</span>}
            </div>

            <div className="detail-actions">
              {chapters.length > 0 && (
                <button className="btn btn-primary" onClick={continueReading}>
                  {progress?.current_chapter_id ? 'Continue Reading' : 'Start Reading'}
                </button>
              )}
              {progress && (
                <button className="btn btn-ghost" onClick={handleResetProgress}>
                  Reset Progress
                </button>
              )}
              {/* Desktop: individual buttons */}
              <button className="btn btn-ghost detail-desktop-only" onClick={() => setShowMetaModal(true)}>
                Metadata
              </button>
              <button className="btn btn-ghost detail-desktop-only" onClick={openOptimizeModal}>
                Optimize
              </button>
              <button className="btn btn-ghost detail-desktop-only" onClick={handleOpenInfo}>
                More Info
              </button>
              {/* Mobile: consolidated Settings dropdown */}
              <div className="detail-settings-wrap detail-mobile-only" ref={settingsDropdownRef}>
                <button
                  className={`btn btn-ghost detail-settings-trigger${showSettingsDropdown ? ' open' : ''}`}
                  onClick={() => setShowSettingsDropdown(v => !v)}
                >
                  Settings
                  <svg className="detail-settings-chevron" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 1l4 4 4-4"/>
                  </svg>
                </button>
                {showSettingsDropdown && (
                  <div className="detail-settings-dropdown">
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); setShowMetaModal(true); }}>
                      Metadata
                    </button>
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); openOptimizeModal(); }}>
                      Optimize
                    </button>
                    <button className="detail-settings-item" onClick={() => { setShowSettingsDropdown(false); handleOpenInfo(); }}>
                      More Info
                    </button>
                  </div>
                )}
              </div>
              {readingLists.length > 0 && (
                <div className="rl-dropdown-wrap" ref={listDropdownRef}>
                  <button
                    className={`btn btn-ghost rl-dropdown-trigger${showListDropdown ? ' open' : ''}`}
                    onClick={() => setShowListDropdown(v => !v)}
                  >
                    Lists{mangaListIds.size > 0 ? ` · ${mangaListIds.size}` : ''}
                    <svg className="rl-chevron" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 1l4 4 4-4"/>
                    </svg>
                  </button>
                  {showListDropdown && (
                    <div className="rl-dropdown">
                      {readingLists.map(list => {
                        const checked = mangaListIds.has(list.id);
                        return (
                          <button
                            key={list.id}
                            className={`rl-dropdown-item${checked ? ' checked' : ''}`}
                            onClick={() => handleToggleList(list.id)}
                            disabled={togglingList === list.id}
                          >
                            <span className="rl-dropdown-box">
                              {checked && (
                                <svg viewBox="0 0 10 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 4l3 3 5-6"/>
                                </svg>
                              )}
                            </span>
                            {list.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* AniList reading status */}
        <AnilistStatusPanel
          status={anilistStatus}
          mangaId={id}
          onEntryChange={entry => setAnilistStatus(prev => ({ ...prev, entry }))}
          onBreakLinkage={manga.anilist_id ? handleBreakAnilistLinkage : null}
        />

        {/* Tracking settings */}
        <div className="tracking-panel">
          <div className="tracking-panel-row">
            <div className="tracking-panel-info">
              <span className="tracking-panel-label">Track as Volumes</span>
              <span className="tracking-panel-desc">
                Reports volume progress to AniList instead of chapter progress.
                Use this when your folders represent volumes rather than individual chapters.
              </span>
            </div>
            <button
              className={`track-toggle ${manga.track_volumes ? 'on' : ''}`}
              onClick={handleToggleTrackVolumes}
              disabled={savingTrackSetting}
              role="switch"
              aria-checked={!!manga.track_volumes}
            >
              <span className="track-toggle-thumb" />
            </button>
          </div>
        </div>

        {/* Chapters */}
        <div className="chapter-section">
          <h2 className="chapter-section-title">{manga.track_volumes ? 'Volumes' : 'Chapters'}</h2>
          {displayChapters.length === 0 ? (
            <p className="chapter-empty">No {manga.track_volumes ? 'volumes' : 'chapters'} found. Make sure your manga folders contain images or CBZ files.</p>
          ) : (
            <div className="chapter-list">
              {visibleChapters.map(ch => {
                const isRead = completedIds.has(ch.id);
                const isCurrent = progress?.current_chapter_id === ch.id;
                const isMarking = markingChapters.has(ch.id);
                return (
                  <Link
                    key={ch.id}
                    to={`/read/${ch.id}?mangaId=${id}`}
                    className={`chapter-row ${isRead ? 'chapter-read' : ''} ${isCurrent ? 'chapter-current' : ''}`}
                  >
                    <div className="chapter-row-left">
                      <span className="chapter-num">
                        {ch.volume !== null && ch.number !== null
                          ? `Vol. ${ch.volume} Ch. ${ch.number}`
                          : ch.volume !== null
                            ? `Volume ${ch.volume}`
                            : ch.number !== null
                              ? `${manga.track_volumes ? 'Volume' : 'Chapter'} ${ch.number}`
                              : ch.folder_name}
                      </span>
                      {ch.title && <span className="chapter-title">{ch.title}</span>}
                    </div>
                    <div className="chapter-row-right">
                      {isCurrent && <span className="chapter-badge badge-current">Reading</span>}
                      {isRead && !isCurrent && <span className="chapter-badge badge-read">Read</span>}
                      <span className="chapter-pages">{ch.page_count}p</span>
                      <button
                        className={`chapter-mark-btn${isRead ? ' is-read' : ''}`}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); handleMarkChapter(ch.id, !isRead); }}
                        disabled={isMarking}
                        title={isRead ? 'Mark as unread' : 'Mark as read'}
                        aria-label={isRead ? 'Mark as unread' : 'Mark as read'}
                      >
                        {isMarking ? (
                          <div className="spinner" style={{ width: 14, height: 14, borderWidth: 1.5 }} />
                        ) : isRead ? (
                          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                            <circle cx="10" cy="10" r="8" fill="currentColor" />
                            <path d="M6.5 10l2.5 2.5 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true">
                            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
          {hasMoreChapters && (
            <button
              className="chapter-expand-btn"
              onClick={() => setShowAllChapters(v => !v)}
            >
              {showAllChapters
                ? 'Show less'
                : `Show all ${displayChapters.length} ${manga.track_volumes ? 'volumes' : 'chapters'}`}
            </button>
          )}
        </div>

        {/* Art Gallery */}
        <div className="gallery-section">
          <h2 className="chapter-section-title">Art Gallery</h2>
          {galleryLoading ? (
            <p className="chapter-empty">Loading gallery…</p>
          ) : gallery.length === 0 ? (
            <p className="chapter-empty">
              No pages saved yet. Open a chapter, find a page you like, and use the
              “Add to Art Gallery” button in the reader’s settings panel.
            </p>
          ) : (
            <div className="gallery-grid">
              {gallery.map(item => {
                const isRemoving = removingGalleryIds.has(item.id);
                return (
                  <div key={item.id} className={`gallery-item${isRemoving ? ' gallery-item-removing' : ''}`}>
                    <Link
                      to={`/read/${item.chapter_id}?page=${item.page_index}&mangaId=${id}`}
                      className="gallery-item-link"
                      title={`${formatChapterLabel(item)} · Page ${item.page_index + 1}`}
                    >
                      <img
                        src={api.pageImageUrl(item.page_id)}
                        alt={`${formatChapterLabel(item)} page ${item.page_index + 1}`}
                        loading="lazy"
                        className="gallery-item-img"
                      />
                      <div className="gallery-item-label">
                        <span className="gallery-item-chapter">{formatChapterLabel(item)}</span>
                        <span className="gallery-item-page">Page {item.page_index + 1}</span>
                      </div>
                    </Link>
                    <button
                      className="gallery-item-remove"
                      onClick={() => handleRemoveFromGallery(item.id)}
                      disabled={isRemoving}
                      title="Remove from gallery"
                      aria-label="Remove from gallery"
                    >
                      {isRemoving
                        ? <div className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                        : <span aria-hidden="true">✕</span>}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {showMetaModal && (
        <div className="modal-backdrop" onClick={() => setShowMetaModal(false)}>
          <div className="modal-box meta-modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Metadata</h2>
              <button className="modal-close" onClick={() => setShowMetaModal(false)}>✕</button>
            </div>
            <div className="meta-modal-body">
              <div className="meta-source-row">
                <label className="meta-source-label">Source</label>
                <select
                  className="meta-source-select"
                  value={metaSource}
                  onChange={e => { setMetaSource(e.target.value); setMetaMessage(null); }}
                >
                  <option value="anilist">AniList</option>
                  <option value="myanimelist">MyAnimeList</option>
                  <option value="doujinshi">Doujinshi.info</option>
                </select>
              </div>

              <p className="meta-modal-desc">
                {metaSource === 'anilist'
                  ? 'Link this manga to an AniList entry to populate its title, cover image, description, genres, score, and release status.'
                  : metaSource === 'myanimelist'
                    ? 'Link this manga to a MyAnimeList entry to populate its title, cover image, description, genres, score, and release status.'
                    : 'Link this manga to a Doujinshi.info entry to populate its title, cover image, year, and tags.'}
                {' '}Linked metadata will not be overwritten by local JSON files.
              </p>

              <div className="meta-modal-status-row">
                {hasMetadata ? (
                  manga.metadata_source === 'local'
                    ? <span className="meta-status-badge meta-status-local">Local file</span>
                    : manga.metadata_source === 'anilist'
                      ? <span className="meta-status-badge meta-status-anilist">
                          Linked to AniList
                          {manga.anilist_id && (
                            <a href={`https://anilist.co/manga/${manga.anilist_id}`} target="_blank" rel="noreferrer"> ↗</a>
                          )}
                        </span>
                      : manga.metadata_source === 'myanimelist'
                        ? <span className="meta-status-badge meta-status-mal">
                            Linked to MyAnimeList
                            {manga.mal_id && (
                              <a href={`https://myanimelist.net/manga/${manga.mal_id}`} target="_blank" rel="noreferrer"> ↗</a>
                            )}
                          </span>
                        : manga.metadata_source === 'doujinshi'
                          ? <span className="meta-status-badge meta-status-doujinshi">
                              Linked to Doujinshi.info
                              {manga.doujinshi_id && (
                                <a href={`https://doujinshi.info/book/${manga.doujinshi_id}`} target="_blank" rel="noreferrer"> ↗</a>
                              )}
                            </span>
                          : <span className="meta-status-badge meta-status-anilist">Linked</span>
                ) : (
                  <span className="meta-status-badge meta-status-none">No metadata linked</span>
                )}
              </div>

              {metaMessage && (
                <div className={`metadata-msg metadata-msg-${metaMessage.type}`}>
                  {metaMessage.text}
                </div>
              )}

              {metaSource === 'anilist' ? (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">{hasMetadata ? 'Re-fetch Metadata' : 'Fetch Metadata'}</span>
                      <span className="meta-modal-action-desc">
                        Automatically search AniList by this manga's title and apply the closest match.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleFetchMetadata}
                      disabled={fetchingMeta}
                    >
                      {fetchingMeta ? 'Fetching…' : hasMetadata ? 'Re-fetch' : 'Fetch'}
                    </button>
                  </div>
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Search Manually</span>
                      <span className="meta-modal-action-desc">
                        Browse AniList search results and choose the correct entry yourself.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowMetaModal(false); setShowSearch(true); }}
                    >
                      Search
                    </button>
                  </div>
                  {manga.metadata_source === 'anilist' && (
                    <div className="meta-modal-action-row">
                      <div className="meta-modal-action-info">
                        <span className="meta-modal-action-label">Export as JSON</span>
                        <span className="meta-modal-action-desc">
                          Save the current AniList metadata as <code>metadata.json</code> in this manga's folder.
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleExportMangaMetadata}
                        disabled={exportingMangaMeta}
                      >
                        {exportingMangaMeta ? 'Exporting…' : 'Export'}
                      </button>
                    </div>
                  )}
                </div>
              ) : metaSource === 'myanimelist' ? (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">{hasMetadata ? 'Re-fetch Metadata' : 'Fetch Metadata'}</span>
                      <span className="meta-modal-action-desc">
                        Automatically search MyAnimeList by this manga's title and apply the closest match.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleFetchMalMetadata}
                      disabled={fetchingMeta}
                    >
                      {fetchingMeta ? 'Fetching…' : hasMetadata ? 'Re-fetch' : 'Fetch'}
                    </button>
                  </div>
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Search Manually</span>
                      <span className="meta-modal-action-desc">
                        Browse MyAnimeList search results and choose the correct entry yourself.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowMetaModal(false); setShowMALSearch(true); }}
                    >
                      Search
                    </button>
                  </div>
                  {manga.metadata_source === 'myanimelist' && (
                    <div className="meta-modal-action-row">
                      <div className="meta-modal-action-info">
                        <span className="meta-modal-action-label">Export as JSON</span>
                        <span className="meta-modal-action-desc">
                          Save the current MyAnimeList metadata as <code>metadata.json</code> in this manga's folder.
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleExportMangaMetadata}
                        disabled={exportingMangaMeta}
                      >
                        {exportingMangaMeta ? 'Exporting…' : 'Export'}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">{hasMetadata ? 'Re-fetch Metadata' : 'Fetch Metadata'}</span>
                      <span className="meta-modal-action-desc">
                        Automatically search Doujinshi.info by this manga's title and apply the closest match.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleFetchDoujinshiMetadata}
                      disabled={fetchingMeta}
                    >
                      {fetchingMeta ? 'Fetching…' : hasMetadata ? 'Re-fetch' : 'Fetch'}
                    </button>
                  </div>
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Search Manually</span>
                      <span className="meta-modal-action-desc">
                        Browse Doujinshi.info search results and choose the correct entry yourself.
                      </span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setShowMetaModal(false); setShowDoujinshiSearch(true); }}
                    >
                      Search
                    </button>
                  </div>
                  {manga.metadata_source === 'doujinshi' && (
                    <div className="meta-modal-action-row">
                      <div className="meta-modal-action-info">
                        <span className="meta-modal-action-label">Export as JSON</span>
                        <span className="meta-modal-action-desc">
                          Save the current Doujinshi.info metadata as <code>metadata.json</code> in this manga's folder.
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={handleExportMangaMetadata}
                        disabled={exportingMangaMeta}
                      >
                        {exportingMangaMeta ? 'Exporting…' : 'Export'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {((metaSource === 'anilist'     && manga.anilist_id) ||
                (metaSource === 'myanimelist' && manga.mal_id)     ||
                (metaSource === 'doujinshi'   && manga.doujinshi_id)) && (
                <div className="meta-modal-actions">
                  <div className="meta-modal-action-row">
                    <div className="meta-modal-action-info">
                      <span className="meta-modal-action-label">Break Linkage</span>
                      <span className="meta-modal-action-desc">
                        Remove the connection to{' '}
                        {metaSource === 'anilist' ? 'AniList'
                          : metaSource === 'myanimelist' ? 'MyAnimeList'
                          : 'Doujinshi.info'}.{' '}
                        {manga.metadata_source === metaSource
                          ? 'All fetched metadata will be cleared.'
                          : 'Your existing metadata will be preserved — only the link is removed.'}
                      </span>
                    </div>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleResetMetadata(metaSource)}
                      disabled={fetchingMeta}
                    >
                      Break
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showSearch && (
        <AnilistSearchModal
          mangaId={id}
          defaultQuery={manga.title}
          onApplied={handleMetadataApplied}
          onClose={() => setShowSearch(false)}
        />
      )}

      {showDoujinshiSearch && (
        <DoujinshiSearchModal
          mangaId={id}
          defaultQuery={manga.title}
          onApplied={handleDoujinshiMetadataApplied}
          onClose={() => setShowDoujinshiSearch(false)}
        />
      )}

      {showMALSearch && (
        <MALSearchModal
          mangaId={id}
          defaultQuery={manga.title}
          onApplied={handleMalMetadataApplied}
          onClose={() => setShowMALSearch(false)}
        />
      )}

      {showOptimize && (
        <div className="modal-backdrop" onClick={() => optimizePhase !== 'running' && setShowOptimize(false)}>
          <div className="modal-box optimize-modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Optimize Chapters</h2>
              {optimizePhase !== 'running' && (
                <button className="modal-close" onClick={() => setShowOptimize(false)}>✕</button>
              )}
            </div>

            {optimizePhase === 'confirm' && (
              <div className="optimize-body">
                <p className="optimize-desc">
                  This will process every chapter in <strong>{manga.title}</strong>:
                </p>
                <ul className="optimize-list">
                  <li>Folders of images → converted to <strong>.cbz</strong></li>
                  <li><strong>.zip</strong> files → renamed to <strong>.cbz</strong></li>
                  <li><strong>.7z</strong> files → extracted and repacked as <strong>.cbz</strong> (requires 7-Zip)</li>
                  <li>File names → standardized to <strong>Ch N</strong> or <strong>Vol N Ch M</strong></li>
                </ul>
                <p className="optimize-warning">Original folders and non-CBZ archives will be deleted. This cannot be undone.</p>
                <div className="optimize-actions">
                  <button className="btn btn-ghost" onClick={() => setShowOptimize(false)}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleOptimize}>Start Optimization</button>
                </div>
              </div>
            )}

            {optimizePhase === 'running' && (
              <div className="optimize-body optimize-running">
                <div className="spinner" />
                <p className="optimize-running-label">Optimizing… please wait</p>
              </div>
            )}

            {optimizePhase === 'done' && optimizeResult && (
              <div className="optimize-body">
                {optimizeResult.error ? (
                  <p className="optimize-error">Error: {optimizeResult.error}</p>
                ) : (
                  <>
                    <div className="optimize-results">
                      <div className="optimize-stat">
                        <span className="optimize-stat-value">{optimizeResult.renamed}</span>
                        <span className="optimize-stat-label">Renamed</span>
                      </div>
                      <div className="optimize-stat">
                        <span className="optimize-stat-value">{optimizeResult.converted}</span>
                        <span className="optimize-stat-label">Converted to CBZ</span>
                      </div>
                      <div className="optimize-stat">
                        <span className="optimize-stat-value">{optimizeResult.skipped.length}</span>
                        <span className="optimize-stat-label">Skipped</span>
                      </div>
                      <div className="optimize-stat">
                        <span className="optimize-stat-value">{optimizeResult.errors.length}</span>
                        <span className="optimize-stat-label">Errors</span>
                      </div>
                    </div>
                    {optimizeResult.skipped.length > 0 && (
                      <div className="optimize-log">
                        <p className="optimize-log-title">Skipped</p>
                        {optimizeResult.skipped.map((s, i) => (
                          <p key={i} className="optimize-log-item"><span className="optimize-log-name">{s.name}</span> — {s.reason}</p>
                        ))}
                      </div>
                    )}
                    {optimizeResult.errors.length > 0 && (
                      <div className="optimize-log optimize-log-errors">
                        <p className="optimize-log-title">Errors</p>
                        {optimizeResult.errors.map((e, i) => (
                          <p key={i} className="optimize-log-item"><span className="optimize-log-name">{e.name}</span> — {e.error}</p>
                        ))}
                      </div>
                    )}
                  </>
                )}
                <div className="optimize-actions">
                  <button className="btn btn-primary" onClick={() => setShowOptimize(false)}>Done</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Nav drawer */}
      {showNavDrawer && (
        <div className="detail-nav-backdrop" onClick={() => setShowNavDrawer(false)} />
      )}
      <div className={`detail-nav-drawer${showNavDrawer ? ' open' : ''}`}>
        <div className="detail-nav-drawer-header">
          <span className="detail-nav-drawer-title">Browse</span>
          <button className="detail-nav-drawer-close" onClick={() => setShowNavDrawer(false)} aria-label="Close">✕</button>
        </div>
        <div className="detail-nav-drawer-body">
          {navLibraries.length > 1 && (
            <>
              <p className="detail-nav-section-label">Libraries</p>
              <button className="detail-nav-item" onClick={() => goToLibrary(null)}>
                All Libraries
              </button>
              {navLibraries.map(lib => (
                <button key={lib.id} className="detail-nav-item" onClick={() => goToLibrary(lib.id)}>
                  {lib.name}
                  <span className="detail-nav-count">{lib.manga_count}</span>
                </button>
              ))}
              <div className="detail-nav-divider" />
            </>
          )}
          {navLists.length > 0 && (
            <>
              <p className="detail-nav-section-label">Reading Lists</p>
              {navLists.map(list => (
                <button key={list.id} className="detail-nav-item" onClick={() => goToList(list.id)}>
                  {list.name}
                  <span className="detail-nav-count">{list.manga_count}</span>
                </button>
              ))}
            </>
          )}
          {!navLoaded && (
            <div className="detail-nav-loading"><div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /></div>
          )}
        </div>
      </div>

      {showInfo && (
        <div className="modal-backdrop" onClick={() => setShowInfo(false)}>
          <div className="modal-box info-modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">More Info</h2>
              <button className="modal-close" onClick={() => setShowInfo(false)}>✕</button>
            </div>
            <div className="info-modal-body">
              {infoLoading && <div className="loading-center"><div className="spinner" /></div>}
              {infoError && <p className="info-modal-error">{infoError}</p>}
              {infoData && (
                <dl className="info-modal-list">
                  <div className="info-modal-row">
                    <dt className="info-modal-label">File Path</dt>
                    <dd className="info-modal-value info-modal-path">{infoData.path}</dd>
                  </div>
                  <div className="info-modal-row">
                    <dt className="info-modal-label">Files Found</dt>
                    <dd className="info-modal-value">{infoData.file_count.toLocaleString()}</dd>
                  </div>
                  <div className="info-modal-row">
                    <dt className="info-modal-label">Folder Size</dt>
                    <dd className="info-modal-value">{infoData.size_mb.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB</dd>
                  </div>
                </dl>
              )}
            </div>
          </div>
        </div>
      )}

      {showThumbPicker && (
        <ThumbnailPickerModal
          mangaId={id}
          onApplied={() => {
            setCoverBust(Date.now());
            setShowThumbPicker(false);
          }}
          onClose={() => setShowThumbPicker(false)}
        />
      )}

      {showDeleteConfirm && (
        <div className="modal-backdrop" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="modal-box delete-confirm-box" onClick={e => e.stopPropagation()}>
            <div className="delete-confirm-icon">
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <h2 className="delete-confirm-title">Delete manga?</h2>
            <p className="delete-confirm-body">
              <strong>{manga.title}</strong> and all its files will be permanently removed from disk. This cannot be undone.
            </p>
            <div className="delete-confirm-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDeleteConfirmed}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
