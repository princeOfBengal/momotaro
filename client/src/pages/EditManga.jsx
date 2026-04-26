import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import './EditManga.css';

export default function EditManga() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [originalTitle, setOriginalTitle] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [genres, setGenres] = useState([]);
  const [genreDraft, setGenreDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const genreInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.getManga(id)
      .then(data => {
        if (cancelled) return;
        setOriginalTitle(data.title || '');
        setTitle(data.title || '');
        setAuthor(data.author || '');
        setGenres(Array.isArray(data.genres) ? data.genres : []);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setLoadError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  function addGenre(value) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (genres.some(g => g.toLowerCase() === trimmed.toLowerCase())) {
      setGenreDraft('');
      return;
    }
    setGenres([...genres, trimmed]);
    setGenreDraft('');
  }

  function removeGenre(genre) {
    setGenres(genres.filter(g => g !== genre));
  }

  function handleGenreKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addGenre(genreDraft);
    } else if (e.key === 'Backspace' && !genreDraft && genres.length > 0) {
      setGenres(genres.slice(0, -1));
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) {
      setSaveError('Title cannot be empty');
      return;
    }
    setSaving(true);
    setSaveError(null);
    const pendingGenres = genreDraft.trim()
      ? [...genres, genreDraft.trim()]
      : genres;
    try {
      await api.updateManga(id, {
        title: title.trim(),
        author: author.trim(),
        genres: pendingGenres,
      });
      navigate(`/manga/${id}`);
    } catch (err) {
      setSaveError(err.message);
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="edit-manga-page">
        <Navbar mangaId={id} />
        <div className="loading-center"><div className="spinner" /></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="edit-manga-page">
        <Navbar mangaId={id} />
        <div className="error-message">
          <h2>Manga not found</h2>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="edit-manga-page">
      <Navbar mangaId={id} />
      <main className="edit-manga-main">
        <header className="edit-manga-header">
          <h1 className="edit-manga-title">Edit manga</h1>
          <p className="edit-manga-subtitle">{originalTitle}</p>
        </header>

        <form className="edit-manga-form" onSubmit={handleSubmit}>
          <div className="edit-field">
            <label htmlFor="edit-title" className="edit-label">Title</label>
            <input
              id="edit-title"
              className="edit-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="edit-field">
            <label htmlFor="edit-author" className="edit-label">Author</label>
            <input
              id="edit-author"
              className="edit-input"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              placeholder="e.g. Akira Toriyama"
            />
          </div>

          <div className="edit-field">
            <label className="edit-label">Genres</label>
            <div
              className="edit-genres"
              onClick={() => genreInputRef.current?.focus()}
            >
              {genres.map(g => (
                <span key={g} className="edit-genre-chip">
                  {g}
                  <button
                    type="button"
                    className="edit-genre-remove"
                    onClick={(e) => { e.stopPropagation(); removeGenre(g); }}
                    aria-label={`Remove ${g}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                ref={genreInputRef}
                className="edit-genre-input"
                value={genreDraft}
                onChange={e => setGenreDraft(e.target.value)}
                onKeyDown={handleGenreKeyDown}
                onBlur={() => addGenre(genreDraft)}
                placeholder={genres.length === 0 ? 'Type a genre and press Enter' : ''}
              />
            </div>
            <p className="edit-hint">Press Enter or comma to add. Backspace removes the last tag.</p>
          </div>

          {saveError && <p className="edit-error">{saveError}</p>}

          <div className="edit-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !title.trim()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => navigate(`/manga/${id}`)}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function Navbar({ mangaId }) {
  return (
    <nav className="navbar">
      <Link to={`/manga/${mangaId}`} className="btn btn-ghost">← Back</Link>
      <Link to="/" className="navbar-brand">
        <img src="/logo.png" alt="Momotaro" className="navbar-logo" />
      </Link>
      <div className="navbar-spacer" />
    </nav>
  );
}
