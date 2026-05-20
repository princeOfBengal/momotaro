import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { APP_VERSION } from '../version';

/**
 * Self-hosted update check for the Android APK.
 *
 * Polls `GET /api/app/version` once on mount, compares the server-reported
 * version string with the bundled `APP_VERSION`, and surfaces an update
 * descriptor when they differ. The caller (InstallUpdateBanner) renders a
 * dismissable banner with a link to the APK.
 *
 * Only runs inside the Capacitor APK shell — for the PWA the user just
 * hard-reloads to get new code, so an update banner would be noise. Gating
 * on `Capacitor.isNativePlatform()` keeps the hook silent on web.
 *
 * Failure modes (all silent, return `null` so the banner stays hidden):
 *   - No server URL configured yet (pre-pairing) — nothing to ask.
 *   - /api/app/version 404 — server hasn't published an APK.
 *   - Fetch errors (network down, server old without the route) — don't
 *     surface this as an update; just stay quiet.
 *
 * The dismissal is per-version: dismissing "1.2" keeps the banner hidden
 * until a hypothetical 1.3 ships. That avoids nagging while still
 * advertising the genuinely new release.
 */
const DISMISSED_KEY = 'momotaro_dismissed_update_version';

function isNativeShell() {
  return typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
}

export function useAppUpdateCheck() {
  const [update, setUpdate] = useState(null);

  useEffect(() => {
    if (!isNativeShell()) return;
    if (!api.getServerUrl()) return;

    let cancelled = false;
    api.getAppVersion()
      .then(data => {
        if (cancelled || !data?.version) return;
        if (data.version === APP_VERSION) return;
        if (localStorage.getItem(DISMISSED_KEY) === data.version) return;
        // Compose the absolute download URL using the same server-URL
        // prepending logic we use for media. `download_url` is the generic
        // field (APK or AppImage); `apk_url` is the legacy Android field.
        const downloadRel = data.download_url || data.apk_url;
        const downloadAbsolute = downloadRel?.startsWith('/')
          ? `${api.getServerUrl()}${downloadRel}`
          : downloadRel;
        setUpdate({
          version:     data.version,
          downloadUrl: downloadAbsolute,
          releasedAt:  data.released_at,
          notes:       data.notes,
          sizeBytes:   data.size_bytes,
        });
      })
      .catch(() => { /* silent — see comment above */ });

    return () => { cancelled = true; };
  }, []);

  function dismiss() {
    if (update) localStorage.setItem(DISMISSED_KEY, update.version);
    setUpdate(null);
  }

  return { update, dismiss };
}
