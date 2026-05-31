import React, { useMemo } from 'react';
import './RibbonOrderEditor.css';

/**
 * Edits the Home page's ribbon order + visibility.
 *
 * Value shape: [{ id: string, visible: boolean }, ...]
 *
 * Each row carries a visibility toggle and ↑ / ↓ buttons. Drag-and-drop is
 * deliberately omitted in v1 to keep the bundle lean — ↑/↓ buttons are also
 * better for accessibility (keyboard + screen reader) by default.
 *
 * Unknown / missing ribbon ids are reconciled at render time so adding a new
 * ribbon in the future doesn't strand users whose persisted order predates
 * it: any id in DEFAULTS that's missing from `value` is appended in its
 * default position.
 */
export default function RibbonOrderEditor({ value, onChange, ribbons }) {
  // Reconcile against the canonical ribbon set: drop unknown ids, append any
  // missing ones (preserving the default order they appear in `ribbons`).
  const normalised = useMemo(() => {
    const known = new Map(ribbons.map(r => [r.id, r]));
    const seen = new Set();
    const out = [];
    for (const entry of value || []) {
      if (known.has(entry.id) && !seen.has(entry.id)) {
        out.push({ id: entry.id, visible: entry.visible !== false });
        seen.add(entry.id);
      }
    }
    for (const r of ribbons) {
      if (!seen.has(r.id)) out.push({ id: r.id, visible: true });
    }
    return out;
  }, [value, ribbons]);

  function update(next) {
    onChange(next);
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= normalised.length) return;
    const next = normalised.slice();
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    update(next);
  }

  function toggleVisible(index) {
    const next = normalised.slice();
    next[index] = { ...next[index], visible: !next[index].visible };
    update(next);
  }

  return (
    <ul className="roe-list" aria-label="Home ribbon order">
      {normalised.map((entry, i) => {
        const meta = ribbons.find(r => r.id === entry.id);
        if (!meta) return null;
        return (
          <li key={entry.id} className={`roe-row${entry.visible ? '' : ' roe-row-hidden'}`}>
            <div className="roe-row-info">
              <span className="roe-row-label">{meta.label}</span>
              {meta.description && (
                <span className="roe-row-desc">{meta.description}</span>
              )}
            </div>
            <div className="roe-row-actions">
              <button
                type="button"
                className="roe-btn"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${meta.label} up`}
                title="Move up"
              >↑</button>
              <button
                type="button"
                className="roe-btn"
                onClick={() => move(i, +1)}
                disabled={i === normalised.length - 1}
                aria-label={`Move ${meta.label} down`}
                title="Move down"
              >↓</button>
              <button
                type="button"
                className={`roe-toggle${entry.visible ? ' on' : ''}`}
                onClick={() => toggleVisible(i)}
                role="switch"
                aria-checked={entry.visible}
                aria-label={`${meta.label} visibility`}
                title={entry.visible ? 'Visible — click to hide' : 'Hidden — click to show'}
              >
                <span className="roe-toggle-thumb" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
