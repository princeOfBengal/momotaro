import React from 'react';
import '../Settings.css';

// Stand-in panel rendered in place of an offline-locked section when the
// user navigates to it while disconnected. The Settings router decides when
// to show this (see `OFFLINE_LOCKED_SECTIONS`) so the section component
// itself never mounts in the offline path and can't hit dead API calls.
export default function OfflineLockedPanel({ label }) {
  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">{label}</h2>
          <p className="sp-section-desc">
            This section needs an active server connection. Restore your
            connection and return to use it — the page will resume operating
            in online mode the moment the server is reachable again.
          </p>
        </div>
      </div>
      <div className="settings-card">
        <p className="settings-hint" style={{ margin: 0 }}>
          You're currently <strong>offline</strong>. Only downloaded manga,
          the reader, and offline-download management are available right now.
        </p>
      </div>
    </div>
  );
}
