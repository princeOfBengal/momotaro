import React from 'react';
import { useLocation } from 'react-router-dom';
import { useAppUpdateCheck } from '../hooks/useAppUpdateCheck';
// Reuses install-banner styles for visual consistency — same bottom-fixed
// card affordance, just different content.
import './InstallPrompt.css';

// In-app update banner for the self-hosted native builds (Android APK,
// Linux AppImage).
//
// Renders only inside the native shell (the hook gates that), and only when the
// server's published version differs from the bundled `APP_VERSION`. Tapping
// "Update" opens the download URL in the system browser, which then downloads
// the APK / AppImage. On Android this is a plain `target="_blank"` anchor; on
// the Electron desktop shell navigation is locked to the app's custom scheme,
// so we route through window.MomotaroElectron.openExternal (shell.openExternal)
// instead. We deliberately don't install in-app (Android would need
// REQUEST_INSTALL_PACKAGES; the system handler is well-trodden).
//
// Hidden on the reader route so it never lands on top of page-turn taps.
export default function UpdateBanner() {
  const location = useLocation();
  const { update, dismiss } = useAppUpdateCheck();

  // On the desktop shell, open the download in the OS browser via the bridge.
  const electronOpen = (typeof window !== 'undefined'
      && window.MomotaroElectron
      && typeof window.MomotaroElectron.openExternal === 'function')
    ? window.MomotaroElectron.openExternal
    : null;

  if (!update) return null;
  if (location.pathname.startsWith('/read/')) return null;

  return (
    <div className="install-banner" role="region" aria-label="Update available">
      <div className="install-banner-inner">
        <div className="install-banner-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
            <path d="M21 12a9 9 0 1 1-3-6.7"/>
            <polyline points="21 4 21 10 15 10"/>
          </svg>
        </div>
        <div className="install-banner-text">
          <p className="install-banner-title">Update available · v{update.version}</p>
          <p className="install-banner-sub">
            {update.notes || 'Tap Update to download the new APK.'}
          </p>
        </div>
        {electronOpen ? (
          <button
            className="install-banner-cta"
            type="button"
            onClick={() => electronOpen(update.downloadUrl)}
          >
            Update
          </button>
        ) : (
          <a
            className="install-banner-cta"
            href={update.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Update
          </a>
        )}
        <button
          className="install-banner-close"
          onClick={dismiss}
          aria-label="Dismiss update banner"
        >✕</button>
      </div>
    </div>
  );
}
