import React from 'react';

// Generic on/off switch row used across Settings sections. The `.setting-row*`
// and `.toggle-*` classes live in Settings.css today; importing Settings.css
// at the section-component level keeps that coupling intact without coupling
// this primitive to a page-specific stylesheet.

export default function ToggleRow({ label, desc, value, onChange }) {
  return (
    <div className="setting-row">
      <div className="setting-row-info">
        <span className="setting-row-label">{label}</span>
        {desc && <span className="setting-row-desc">{desc}</span>}
      </div>
      <button
        className={`toggle-switch ${value ? 'on' : ''}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}
