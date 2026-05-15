import React, { Suspense, lazy, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Library from './pages/Library';
import MangaDetail from './pages/MangaDetail';
import InstallPrompt from './components/InstallPrompt';
import { api } from './api/client';

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

function FirstLaunchGate({ children }) {
  const location = useLocation();
  const [decision, setDecision] = useState('loading'); // 'loading' | 'allow' | 'redirect'

  useEffect(() => {
    let cancelled = false;

    if (PAIRING_EXEMPT_PATHS.has(location.pathname)) {
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
  }, [location.pathname]);

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

export default function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  );
}
