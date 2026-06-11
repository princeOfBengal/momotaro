import React from 'react';

// Generic on/off switch row used across Settings sections and the in-reader
// settings panel. The `.setting-row*` and `.toggle-*` classes live in the
// shared styles/settingControls.css, which both surfaces import (Settings.jsx
// and ReaderControls.jsx), so this primitive only emits the classNames.
//
// `stopPropagation` is opt-in: the reader renders this over a background that
// toggles the chrome on tap, so the switch must swallow the click there. The
// Settings page has no such handler and leaves it off.

export default function ToggleRow({ label, desc, value, onChange, stopPropagation = false }) {
  const handleClick = (e) => {
    if (stopPropagation) e.stopPropagation();
    onChange(!value);
  };
  return (
    <div className="setting-row">
      <div className="setting-row-info">
        <span className="setting-row-label">{label}</span>
        {desc && <span className="setting-row-desc">{desc}</span>}
      </div>
      <button
        className={`toggle-switch ${value ? 'on' : ''}`}
        onClick={handleClick}
        role="switch"
        aria-checked={value}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}
