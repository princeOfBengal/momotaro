import React from 'react';
import './MangaCard.css';

export default function MangaCard({ manga }) {
  const coverUrl = manga.cover_image
    ? `/thumbnails/${manga.cover_image}`
    : null;

  const statusColors = {
    RELEASING: '#4caf50',
    FINISHED: '#999',
    HIATUS: '#ff9800',
    UPCOMING: '#2196f3',
    CANCELLED: '#f44336',
    UNKNOWN: '#666',
  };

  return (
    <div className="manga-card">
      <div className="manga-card-cover">
        {coverUrl ? (
          <img src={coverUrl} alt={manga.title} loading="lazy" />
        ) : (
          <div className="manga-card-placeholder">
            <span>📖</span>
          </div>
        )}
        {manga.status && manga.status !== 'UNKNOWN' && (
          <span
            className="manga-card-status"
            style={{ background: statusColors[manga.status] || '#666' }}
          >
            {manga.status === 'RELEASING' ? 'Ongoing' :
             manga.status === 'FINISHED' ? 'Finished' :
             manga.status === 'HIATUS' ? 'Hiatus' :
             manga.status}
          </span>
        )}
        {manga.score && (
          <span className="manga-card-score">★ {manga.score.toFixed(1)}</span>
        )}
      </div>
      <div className="manga-card-info">
        <p className="manga-card-title">{manga.title}</p>
        {manga.year && <p className="manga-card-year">{manga.year}</p>}
      </div>
    </div>
  );
}
