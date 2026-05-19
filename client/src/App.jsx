import React, { Suspense, lazy, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Library from './pages/Library';
import MangaDetail from './pages/MangaDetail';
import InstallPrompt from './components/InstallPrompt';
import UpdateBanner from './components/UpdateBanner';
import AdminTaskBanner from './components/AdminTaskBanner';
import { api, setConnectivityProbe } from './api/client';
import { ConnectivityProvider, ConnectivityBanner, useConnectivity } from './context/ConnectivityContext';
import { initDownloader, reconcileNativeProgress } from './api/downloader';
import { flushOutbox } from './api/outboxSync';
import { migrateLegacyRoot } from './api/offlineStorage';
import './styles/connectivity.css';

// v1.5 → v1.6 migration. Drops the legacy `momotaro_offline_root`
// localStorage key from the old "type a subfolder name" flow so the
// Settings panel shows the new SAF-picker state ("No folder chosen
// yet") instead of a phantom configured value. Runs once per app boot;
// the function itself is idempotent.
migrateLegacyRoot();

// Routes off the primary browse path are loaded on demand. The PWA
// `globPatterns: ['**/*.{js,css,...}']` in vite.config.js precaches every
// emitted chunk, so once a route has been visited (or the SW has installed
// after first paint) the chunk lives in cache and feels native on subsequent
// navigations.
//
// Eager: Home, Library, MangaDetail — the click-through path for every
// browsing session. Adding a Suspense gap here would be a regression on the
// most-frequent navigation.
//
// Lazy: Reader (heavy — paged + scroll + controls + edge hints + prefetch),
// Settings (~2.3k LOC of admin UI), Libraries / EditManga / Genres (rarely
// visited), AnilistCallback (only during OAuth).
const Reader          = lazy(() => import('./pages/Reader'));
const EditManga       = lazy(() => import('./pages/EditManga'));
const Settings        = lazy(() => import('./pages/Settings'));
const Libraries       = lazy(() => import('./pages/Libraries'));
const Genres          = lazy(() => import('./pages/Genres'));
const ArtGallery      = lazy(() => import('./pages/ArtGallery'));
const ThirdPartySourcing = lazy(() => import('./pages/ThirdPartySourcing'));
const AnilistCallback = lazy(() => import('./pages/AnilistCallback'));
const Pairing         = lazy(() => import('./pages/Pairing'));
const Downloads       = lazy(() => import('./pages/Downloads'));

/**
 * First-launch gate. Decides whether to send the user through the pairing
 * wizard before showing the app.
 *
 * The signal we trust is the server's `pairing_required` field on
 * `/api/admin/auth-status` — true when this caller would be turned away
 * by the regular auth middleware. That fires in three situations the
 * SPA cares about:
 *
 *   1. First time visiting the public URL from cellular (no token, off LAN)
 *   2. Re-installing the APK after a revoke (token was wiped from storage)
 *   3. Opening the PWA in a fresh browser profile at the public hostname
 *
 * The SPA can't determine "am I on the LAN?" client-side — it has to ask
 * the server. Hence the async check on mount.
 *
 * Skipped:
 *   - The `/pairing` route itself (would infinite-loop)
 *   - The AniList OAuth callback (third-party redirect, doesn't carry tokens)
 *
 * Failure mode: if `/api/admin/auth-status` is unreachable (network
 * partition, server down), we let the user through. The downstream API
 * calls will surface the real error; we don't want a blank page just
 * because the status endpoint blipped.
 */
const PAIRING_EXEMPT_PATHS = new Set(['/pairing', '/auth/anilist/callback']);

function isNativeShell() {
  return typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
}

function FirstLaunchGate({ children }) {
  const location = useLocation();
  const { online } = useConnectivity();
  const [decision, setDecision] = useState('loading'); // 'loading' | 'allow' | 'redirect'

  useEffect(() => {
    let cancelled = false;

    if (PAIRING_EXEMPT_PATHS.has(location.pathname)) {
      setDecision('allow');
      return;
    }

    // In the APK the WebView is served from capacitor://localhost, so there
    // is no server to call until the user picks one in the pairing wizard.
    // Skip the auth-status probe entirely and route to /pairing when we have
    // neither a saved server URL nor a client token — otherwise the probe
    // hits localhost, fails, and we'd send the user to a broken Home page.
    if (isNativeShell() && !api.getServerUrl() && !api.getClientToken()) {
      setDecision('redirect');
      return;
    }

    // Offline: skip the auth-status probe entirely. The user has already
    // paired (we have a client token), and the server is unreachable, so
    // there's no point asking the server whether pairing is needed.
    if (!online) {
      setDecision('allow');
      return;
    }

    api.getAuthStatus()
      .then(status => {
        if (cancelled) return;
        setDecision(status?.pairing_required ? 'redirect' : 'allow');
      })
      .catch(() => {
        // Server unreachable / not running — don't block the UI. The user
        // will see the real error from whatever route they navigated to.
        if (!cancelled) setDecision('allow');
      });

    return () => { cancelled = true; };
  }, [location.pathname, online]);

  if (decision === 'loading') {
    return (
      <div className="loading-center" style={{ minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }
  if (decision === 'redirect') return <Navigate to="/pairing" replace />;
  return children;
}

function RouteFallback() {
  return (
    <div className="loading-center" style={{ minHeight: '100vh' }}>
      <div className="spinner" />
    </div>
  );
}

// Bridges the connectivity context's `online` flag down to the routing
// layer in `api/client.js`. The probe is read on every routed `api.*` call,
// so the user flipping the Offline switch in Settings takes effect on the
// next call without remount.
function ConnectivityProbeBinder() {
  const { online } = useConnectivity();
  useEffect(() => {
    setConnectivityProbe(() => !online);
  }, [online]);
  return null;
}

// Lazily wakes the download queue on app boot and whenever connectivity
// returns. Safe to call repeatedly; the downloader internally guards
// against re-initialisation. Also drains the progress outbox on reconnect
// so reads marked offline get reported to the server as soon as we can
// reach it.
//
// `reconcileNativeProgress` runs once at boot to harvest anything the
// native foreground service downloaded while the JS context was gone
// (user swiped the app from recents, then re-opened it later). The
// reports update IDB to reflect on-disk reality so the UI doesn't show
// "queued" for chapters that are actually done.
function DownloaderBootstrap() {
  const { online } = useConnectivity();
  useEffect(() => {
    // Reconcile FIRST, then init — that way init's "any 'running' jobs
    // get re-queued" loop sees the post-reconcile state, not the pre.
    reconcileNativeProgress()
      .catch(() => {})
      .finally(() => { initDownloader(); });
  }, []);
  useEffect(() => {
    if (online) {
      initDownloader();          // resume any stuck jobs
      flushOutbox().catch(() => { /* best-effort; retry on next reconnect */ });
    }
  }, [online]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ConnectivityProvider getServerUrl={api.getServerUrl}>
        <ConnectivityProbeBinder />
        <DownloaderBootstrap />
        {/* Slim offline-mode banner. Renders nothing when online; otherwise
            sits at the very top above the admin-task banner. */}
        <ConnectivityBanner />
        {/* Top-of-app degradation banner. Polls /api/admin/tasks/list every
            5s when an admin session is active, shows a thin warning bar
            while a global-locking task (VACUUM, clear-cache, reset-
            thumbnails) is running. Self-hides when no admin token exists,
            so non-admin paired clients never see infra noise. Mounted
            inside BrowserRouter so it sits above the Routes <Suspense>
            fallback. */}
        <AdminTaskBanner />
        <Suspense fallback={<RouteFallback />}>
          <FirstLaunchGate>
            <Routes>
              <Route path="/pairing" element={<Pairing />} />
              <Route path="/" element={<Home />} />
              <Route path="/genres" element={<Genres />} />
              <Route path="/art-gallery" element={<ArtGallery />} />
              <Route path="/third-party-sourcing" element={<ThirdPartySourcing />} />
              <Route path="/library" element={<Library />} />
              <Route path="/manga/:id" element={<MangaDetail />} />
              <Route path="/manga/:id/edit" element={<EditManga />} />
              <Route path="/read/:chapterId" element={<Reader />} />
              <Route path="/libraries" element={<Libraries />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/downloads" element={<Downloads />} />
              <Route path="/auth/anilist/callback" element={<AnilistCallback />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </FirstLaunchGate>
        </Suspense>
        {/* Mounted outside <Routes> so it persists across navigation. The
            component self-gates: only renders on mobile viewports, hides
            itself when the app is already running standalone, and skips the
            reader route to keep the bottom of the screen clear for taps. */}
        <InstallPrompt />
        {/* Self-hosted APK update prompt. Only renders inside the Capacitor
            native shell — see useAppUpdateCheck. Stacks on top of the PWA
            install banner if both fire (they normally don't: InstallPrompt
            hides itself when running standalone, which the APK always is). */}
        <UpdateBanner />
      </ConnectivityProvider>
    </BrowserRouter>
  );
}
