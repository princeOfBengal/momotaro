import React, { useState } from 'react';
import { api } from '../../api/client';
import { APP_VERSION } from '../../version';
import { formatApkSize } from '../../utils/format';
import { nativePlatform, openExternalUrl } from './nativeShell';
import '../Settings.css';

// ── Linux ─────────────────────────────────────────────────────────────────────
//
// Mirror of the Android section for the Linux AppImage desktop app. The
// "Download AppImage" link is available from any device — most usefully from the
// PWA on a Linux desktop, to grab the installer the same way Android users grab
// the APK. The "Update check" card only renders inside the Electron desktop
// shell; it compares the bundled APP_VERSION against the server's Linux channel
// (api.getAppVersion() auto-selects /api/app/version?platform=linux on
// electron). Downloads open in the OS browser via openExternalUrl because the
// desktop shell blocks in-app navigation off the app scheme; in the PWA the
// download is a normal browser anchor.
export default function LinuxSection() {
  const isElectron  = nativePlatform() === 'electron';
  const appImageUrl = `${api.getServerUrl()}/downloads/momotaro.AppImage`;
  const [check, setCheck] = useState({ status: 'idle' });

  async function checkForUpdates() {
    setCheck({ status: 'checking' });
    try {
      const data = await api.getAppVersion(); // electron → linux channel
      if (!data?.version) {
        setCheck({ status: 'error', message: 'Server returned malformed version data.' });
        return;
      }
      const rel = data.download_url || data.appimage_url;
      const downloadAbsolute = rel?.startsWith('/') ? `${api.getServerUrl()}${rel}` : rel;
      if (data.version === APP_VERSION) {
        setCheck({ status: 'up-to-date', latest: data.version });
      } else {
        setCheck({
          status:      'update-available',
          latest:      data.version,
          notes:       data.notes,
          releasedAt:  data.released_at,
          sizeBytes:   data.size_bytes,
          downloadUrl: downloadAbsolute,
        });
      }
    } catch (err) {
      // 404 = nothing published for this platform; surfaced as a thrown
      // `HTTP 404` / "No published" by the fetch wrapper.
      if (/HTTP 404/.test(err.message) || /No published/i.test(err.message)) {
        setCheck({ status: 'no-published' });
      } else {
        setCheck({ status: 'error', message: err.message || 'Could not reach the server.' });
      }
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Linux</h2>
          <p className="sp-section-desc">
            Download the Momotaro Linux desktop app (AppImage) directly from this
            server, and check whether this device has the latest version.
          </p>
        </div>
      </div>

      <div className="settings-card">
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Download AppImage</h3>
        <p className="settings-hint">
          The latest AppImage published to this server is available at{' '}
          <code>/downloads/momotaro.AppImage</code>. After downloading, make it
          executable (<code>chmod +x momotaro.AppImage</code>, or right-click →
          Properties → "Allow executing file as program") and run it.
        </p>
        <div className="settings-token-actions" style={{ marginTop: 12 }}>
          {isElectron ? (
            <button className="btn btn-primary" type="button" onClick={() => openExternalUrl(appImageUrl)}>
              Download AppImage
            </button>
          ) : (
            <a className="btn btn-primary" href={appImageUrl} download="momotaro.AppImage">
              Download AppImage
            </a>
          )}
        </div>
      </div>

      {isElectron && (
        <div className="settings-card" style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Update check</h3>
          <p className="settings-hint">
            This device is running version <strong>v{APP_VERSION}</strong>.
            Check whether a newer release has been published.
          </p>
          <div className="settings-token-actions" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              onClick={checkForUpdates}
              disabled={check.status === 'checking'}
            >
              {check.status === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
          </div>

          {check.status === 'up-to-date' && (
            <div className="sp-status sp-status-success" style={{ marginTop: 12 }}>
              You're on the latest version (v{check.latest}).
            </div>
          )}

          {check.status === 'update-available' && (
            <div className="sp-status sp-status-success" style={{ marginTop: 12 }}>
              <div><strong>Update available — v{check.latest}</strong></div>
              {check.notes && (
                <div style={{ marginTop: 4 }}>{check.notes}</div>
              )}
              {(check.releasedAt || check.sizeBytes) && (
                <div style={{ marginTop: 4, opacity: 0.8, fontSize: 13 }}>
                  {check.releasedAt && <>Released {check.releasedAt}</>}
                  {check.releasedAt && check.sizeBytes && <> · </>}
                  {formatApkSize(check.sizeBytes)}
                </div>
              )}
              <div className="settings-token-actions" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" type="button" onClick={() => openExternalUrl(check.downloadUrl)}>
                  Download update
                </button>
              </div>
            </div>
          )}

          {check.status === 'no-published' && (
            <p className="settings-hint" style={{ marginTop: 12 }}>
              No AppImage has been published on this server yet.
            </p>
          )}

          {check.status === 'error' && (
            <div className="sp-status sp-status-error" style={{ marginTop: 12 }}>
              {check.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
