import React, { Suspense, lazy, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Library from './pages/Library';
import MangaDetail from './pages/MangaDetail';
import InstallPrompt from './components/InstallPrompt';
import UpdateBanner from './components/UpdateBanner';
import AdminTaskBanner from './components/AdminTaskBanner';
import BottomNav from './components/BottomNav';
import RequireAdminAccess from './components/RequireAdminAccess';
import { api, setConnectivityProbe, GATE_OK_KEY } from './api/client';
import { ConnectivityProvider, ConnectivityBanner, useConnectivity } from './context/ConnectivityContext';
import { UserProvider } from './context/UserContext';
import { PreferencesProvider } from './context/PreferencesContext';
import DialogProvider from './dialog/DialogProvider';
import AdminUnlockDialog from './dialog/AdminUnlockDialog';
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
// Settings (slim router; each section is a further per-section chunk under
// pages/settings/, prefetched on sidebar hover), Libraries / EditManga /
// Genres (rarely visited), AnilistCallback (only during OAuth).
const Reader          = lazy(() => import('./pages/Reader'));
const EditManga       = lazy(() => import('./pages/EditManga'));
const Settings        = lazy(() => import('./pages/Settings'));
const Libraries       = lazy(() => import('./pages/Libraries'));
const Genres          = lazy(() => import('./pages/Genres'));
const ArtGallery      = lazy(() => import('./pages/ArtGallery'));
const ThirdPartySourcing = lazy(() => import('./pages/ThirdPartySourcing'));
const AnilistCallback = lazy(() => import('./pages/AnilistCallback'));
const Pairing         = lazy(() => import('./pages/Pairing'));
const Login           = lazy(() => import('./pages/Login'));
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
 * The same gate also handles the second layer — user login. When the server
 * reports `user_required` (multi-user enabled, a real account exists, and this
 * caller has no valid session) it routes to `/login`. Pairing is checked first,
 * so an external device pairs *then* logs in.
 *
 * Optimistic fast path: a previous clean allow is recorded in
 * `localStorage[GATE_OK_KEY]`. When the flag is set, the gate renders the
 * app immediately and the probe revalidates in the background — a returning
 * user no longer pays a blocking round-trip on every app open. If the
 * background probe comes back pairing/user-required (revoked device, closed
 * registration), the flag is cleared and the redirect fires then; the only
 * exposure in that window is data already cached on the device. First-ever
 * visits have no flag and keep the blocking spinner. Every token/server-url
 * setter in api/client.js clears the flag AND the probe's TTL cache
 * (invalidateGateState), so a logout is never masked by a stale allow and a
 * fresh login is never bounced by a cached `user_required` verdict.
 *
 * The probe itself goes through `api.getAuthStatusCached()` (60 s TTL) —
 * this effect re-runs on every route change, and per-navigation probes were
 * pure overhead competing with page data fetches. A visibilitychange
 * listener re-evaluates on tab focus so a revocation is noticed on
 * long-idle tabs too, at most once per TTL window.
 *
 * Skipped:
 *   - The `/pairing` and `/login` routes themselves (would infinite-loop)
 *   - The AniList OAuth callback (third-party redirect, doesn't carry tokens)
 *
 * Failure mode: if `/api/admin/auth-status` is unreachable (network
 * partition, server down), we let the user through. The downstream API
 * calls will surface the real error; we don't want a blank page just
 * because the status endpoint blipped. An unreachable probe deliberately
 * neither sets nor clears the fast-path flag — "unknown" must not become
 * "allow forever", nor silently sign anyone out.
 */
const GATE_EXEMPT_PATHS = new Set(['/pairing', '/login', '/auth/anilist/callback']);

function isNativeShell() {
  return typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
}

function FirstLaunchGate({ children }) {
  const location = useLocation();
  const { online } = useConnectivity();
  // 'loading' | 'allow' | 'redirect'. Starts at 'allow' when the fast-path
  // flag records a previous clean probe — see the component doc above.
  const [decision, setDecision] = useState(() => {
    try {
      return localStorage.getItem(GATE_OK_KEY) === '1' ? 'allow' : 'loading';
    } catch (_) {
      return 'loading';
    }
  });
  const [target, setTarget] = useState('/pairing');    // where to send on 'redirect'
  // Bumped on tab-visibility regain so a long-idle tab re-evaluates. The
  // probe is TTL-cached in the API client, so this re-checks at most once
  // per TTL window, not on every focus.
  const [probeVersion, setProbeVersion] = useState(0);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') setProbeVersion(v => v + 1);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (GATE_EXEMPT_PATHS.has(location.pathname)) {
      setDecision('allow');
      return;
    }

    // In the APK the WebView is served from capacitor://localhost, so there
    // is no server to call until the user picks one in the pairing wizard.
    // Skip the auth-status probe entirely and route to /pairing when we have
    // neither a saved server URL nor a client token — otherwise the probe
    // hits localhost, fails, and we'd send the user to a broken Home page.
    if (isNativeShell() && !api.getServerUrl() && !api.getClientToken()) {
      setTarget('/pairing');
      setDecision('redirect');
      return;
    }

    // Offline: skip the auth-status probe entirely — we already have a client
    // token and the server isn't reachable. If this is a multi-user install
    // (cached from the last successful auth-status), also require a stored
    // user token; accounts can't be created offline, only used. Falls back
    // to "allow" when we have no cached flag yet (first ever launch).
    if (!online) {
      const cachedMU = localStorage.getItem('momotaro_multi_user_cached') === '1';
      if (cachedMU && !api.getUserToken()) {
        setTarget('/login');
        setDecision('redirect');
      } else {
        setDecision('allow');
      }
      return;
    }

    api.getAuthStatusCached()
      .then(status => {
        if (cancelled) return;
        // Cache the multi-user flag so the offline branch above can tell
        // whether identity is required when we can't reach the server.
        try {
          localStorage.setItem(
            'momotaro_multi_user_cached',
            status?.multi_user_enabled ? '1' : '0',
          );
        } catch (_) { /* localStorage disabled — non-fatal */ }
        // Pairing (device trust) is checked first, then login (identity).
        // Any non-allow verdict clears the fast-path flag so the next boot
        // blocks on the probe again; a clean allow (re)arms it.
        if (status?.pairing_required) {
          try { localStorage.removeItem(GATE_OK_KEY); } catch (_) {}
          setTarget('/pairing'); setDecision('redirect');
        } else if (status?.user_required) {
          try { localStorage.removeItem(GATE_OK_KEY); } catch (_) {}
          setTarget('/login'); setDecision('redirect');
        } else {
          try { localStorage.setItem(GATE_OK_KEY, '1'); } catch (_) {}
          setDecision('allow');
        }
      })
      .catch(() => {
        // Server unreachable / not running — don't block the UI. The user
        // will see the real error from whatever route they navigated to.
        // Deliberately leaves the fast-path flag untouched: "unknown" is
        // neither a durable allow nor grounds to force a re-probe spinner
        // on the next boot.
        if (!cancelled) setDecision('allow');
      });

    return () => { cancelled = true; };
  }, [location.pathname, online, probeVersion]);

  if (decision === 'loading') {
    return (
      <div className="loading-center" style={{ minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }
  if (decision === 'redirect') return <Navigate to={target} replace />;
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
        <DialogProvider>
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
          <UserProvider>
          <PreferencesProvider>
          <FirstLaunchGate>
            <Routes>
              <Route path="/pairing" element={<Pairing />} />
              <Route path="/login" element={<Login />} />
              <Route path="/" element={<Home />} />
              <Route path="/genres" element={<Genres />} />
              <Route path="/art-gallery" element={<ArtGallery />} />
              <Route
                path="/third-party-sourcing"
                element={
                  <RequireAdminAccess>
                    <ThirdPartySourcing />
                  </RequireAdminAccess>
                }
              />
              <Route path="/library" element={<Library />} />
              <Route path="/manga/:id" element={<MangaDetail />} />
              <Route
                path="/manga/:id/edit"
                element={
                  <RequireAdminAccess>
                    <EditManga />
                  </RequireAdminAccess>
                }
              />
              <Route path="/read/:chapterId" element={<Reader />} />
              <Route path="/libraries" element={<Libraries />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/downloads" element={<Downloads />} />
              <Route path="/auth/anilist/callback" element={<AnilistCallback />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </FirstLaunchGate>
          </PreferencesProvider>
          </UserProvider>
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
        {/* Imperative companion to <RequireAdminAccess>. Action-level
            callers anywhere in the app pop this via ensureAdminAccess()
            to gate one-shot admin operations (Optimize, Edit Manga,
            Third Party Sources, etc) without wrapping a whole route. */}
        <AdminUnlockDialog />
        {/* Phone-only persistent navigation rail. Self-gates on viewport
            width (CSS) and pathname (component returns null on reader /
            pairing / login / auth callback). Sits outside <Routes> so it
            persists across route changes without re-mounting. */}
        <BottomNav />
        </DialogProvider>
      </ConnectivityProvider>
    </BrowserRouter>
  );
}
