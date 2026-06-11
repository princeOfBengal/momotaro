import React, { useEffect, useState, useMemo } from 'react';
import { api } from '../api/client';
import './GenreChipPicker.css';

/**
 * Multi-select chip picker for genre names. Used by Homepage Settings for both
 * the Discover "excluded genres" blacklist and the Manual "favorite genres"
 * picker — same UI, different role.
 *
 * Props:
 *   value     — string[] currently selected genres (case-insensitive equality)
 *   onChange  — (next: string[]) => void
 *   max       — optional selection cap. When reached, every unselected chip is
 *               disabled so the cap holds; the user removes a selection (via the
 *               × on a selected chip) to free a slot.
 *   mode      — 'exclude' | 'select' — purely cosmetic; toggles a CSS hook so
 *               excluded chips look "struck through" vs included chips look
 *               filled.
 *   placeholder — small note rendered when no chips are selected.
 */
export default function GenreChipPicker({
  value = [],
  onChange,
  max,
  mode = 'select',
  placeholder = 'No genres selected.',
}) {
  const [allGenres, setAllGenres] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.getGenres()
      .then(rows => {
        if (cancelled) return;
        // /api/genres returns [{ genre, manga_count, cover_url }, ...].
        setAllGenres(Array.isArray(rows) ? rows.map(r => r.genre).filter(Boolean) : []);
      })
      .catch(err => { if (!cancelled) setError(err.message || 'Failed to load genres'); });
    return () => { cancelled = true; };
  }, []);

  // Case-insensitive lookup helpers — the server treats genres as
  // COLLATE NOCASE everywhere, so we mirror that here.
  const valueLower = useMemo(() => new Set(value.map(s => s.toLowerCase())), [value]);
  const visible = useMemo(() => {
    if (!allGenres) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return allGenres;
    return allGenres.filter(g => g.toLowerCase().includes(q));
  }, [allGenres, filter]);

  function toggle(genre) {
    const lower = genre.toLowerCase();
    if (valueLower.has(lower)) {
      onChange(value.filter(g => g.toLowerCase() !== lower));
      return;
    }
    // At the cap, unselected chips are disabled (see `disabled` below), so this
    // only runs with a free slot. Guard anyway so a programmatic caller can't
    // push past `max`.
    if (max && value.length >= max) return;
    onChange([...value, genre]);
  }

  if (allGenres === null && !error) {
    return <div className="gcp-loading">Loading genres…</div>;
  }
  if (error) {
    return <div className="gcp-error">{error}</div>;
  }

  return (
    <div className={`gcp-wrap gcp-mode-${mode}`}>
      {value.length > 0 ? (
        <div className="gcp-selected-row" aria-label="Selected genres">
          {value.map(g => (
            <button
              key={g}
              type="button"
              className="gcp-chip gcp-chip-selected"
              onClick={() => toggle(g)}
              title="Remove"
            >
              {g}
              <span className="gcp-chip-x" aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="gcp-empty">{placeholder}</p>
      )}
      <input
        type="search"
        className="gcp-filter"
        placeholder="Filter genres…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <div className="gcp-choices" role="listbox" aria-multiselectable="true">
        {visible.length === 0 ? (
          <p className="gcp-empty">No genres match your filter.</p>
        ) : (
          visible.map(g => {
            const selected = valueLower.has(g.toLowerCase());
            const disabled = !selected && max && value.length >= max;
            return (
              <button
                key={g}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled}
                className={`gcp-chip${selected ? ' gcp-chip-selected' : ''}${disabled ? ' gcp-chip-disabled' : ''}`}
                onClick={() => toggle(g)}
                title={disabled ? `Maximum of ${max} selections` : ''}
              >
                {g}
              </button>
            );
          })
        )}
      </div>
      {max && (
        <p className="gcp-hint">
          {value.length} / {max} selected
        </p>
      )}
    </div>
  );
}
