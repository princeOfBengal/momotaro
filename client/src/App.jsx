import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Library from './pages/Library';
import MangaDetail from './pages/MangaDetail';
import Reader from './pages/Reader';
import AnilistCallback from './pages/AnilistCallback';
import Libraries from './pages/Libraries';
import Settings from './pages/Settings';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/manga/:id" element={<MangaDetail />} />
        <Route path="/read/:chapterId" element={<Reader />} />
        <Route path="/libraries" element={<Libraries />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/auth/anilist/callback" element={<AnilistCallback />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
