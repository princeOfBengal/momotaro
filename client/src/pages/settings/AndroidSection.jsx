import React, { useState } from 'react';
import { api } from '../../api/client';
import { APP_VERSION } from '../../version';
import { formatApkSize } from '../../utils/format';
import { nativePlatform } from './nativeShell';
import '../Settings.css';

// ── Android ───────────────────────────────────────────────────────────────────
//
// Settings panel that exposes two operations against the self-hosted APK
// distribution endpoints:
//   1. Download APK — direct link to /downloads/momotaro.apk. Available
//      from every device, since you might be browsing the web UI on a
//      desktop and want to grab the APK to sideload onto your phone.
//   2. Update check — only rendered inside the Capacitor native shell.
//      Compares the bundled APP_VERSION against /api/app/version's
//      reported `version` and shows up-to-date / update-available / no
//      APK published. The home-screen `UpdateBanner` component is the
//      passive surface for the same data; this is the manual surface.
//
// Both pieces are pure client-side glue against existing public server
// endpoints — no new server work was needed.

export default function AndroidSection() {
  const isAndroidApp = nativePlatform() === 'android';
  const apkUrl       = `${api.getServerUrl()}/downloads/momotaro.apk`;
  const [check, setCheck] = useState({ status: 'idle' });

  async function checkForUpdates() {
    setCheck({ status: 'checking' });
    try {
      const data = await api.getAppVersion();
      if (!data?.version) {
        setCheck({ status: 'error', message: 'Server returned malformed version data.' });
        return;
      }
      const apkAbsolute = data.apk_url?.startsWith('/')
        ? `${api.getServerUrl()}${data.apk_url}`
        : data.apk_url;
      if (data.version === APP_VERSION) {
        setCheck({ status: 'up-to-date', latest: data.version });
      } else {
        setCheck({
          status:     'update-available',
          latest:     data.version,
          notes:      data.notes,
          releasedAt: data.released_at,
          sizeBytes:  data.size_bytes,
          apkUrl:     apkAbsolute,
        });
      }
    } catch (err) {
      // /api/app/version returns 404 when no APK is published. The fetch
      // wrapper surfaces non-2xx responses as `HTTP <status>` thrown
      // errors, which is what we pattern-match on here.
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
          <h2 className="sp-section-title">Android</h2>
          <p className="sp-section-desc">
            Download the Momotaro Android APK directly from this server, and
            check whether the device running this app has the latest version.
          </p>
        </div>
      </div>

      <div className="settings-card">
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Download APK</h3>
        <p className="settings-hint">
          The latest signed APK published to this server is available at{' '}
          <code>/downloads/momotaro.apk</code>. After downloading on a phone,
          tap the file to install. The first install from a browser requires
          Android's "Install unknown apps" permission for that browser —
          one-time setting.
        </p>
        <div className="settings-token-actions" style={{ marginTop: 12 }}>
          <a className="btn btn-primary" href={apkUrl} download="momotaro.apk">
            Download APK
          </a>
        </div>
      </div>

      {isAndroidApp && (
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
                <a
                  className="btn btn-primary"
                  href={check.apkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Download update
                </a>
              </div>
            </div>
          )}

          {check.status === 'no-published' && (
            <p className="settings-hint" style={{ marginTop: 12 }}>
              No APK has been published on this server yet.
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
