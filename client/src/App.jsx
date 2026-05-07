import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Library from './pages/Library';
import MangaDetail from './pages/MangaDetail';

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
const AnilistCallback = lazy(() => import('./pages/AnilistCallback'));

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
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/genres" element={<Genres />} />
          <Route path="/art-gallery" element={<ArtGallery />} />
          <Route path="/library" element={<Library />} />
          <Route path="/manga/:id" element={<MangaDetail />} />
          <Route path="/manga/:id/edit" element={<EditManga />} />
          <Route path="/read/:chapterId" element={<Reader />} />
          <Route path="/libraries" element={<Libraries />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/auth/anilist/callback" element={<AnilistCallback />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
