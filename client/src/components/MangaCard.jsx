import React from 'react';
import { api } from '../api/client';
import './MangaCard.css';

function MangaCardImpl({ manga }) {
  const coverUrl = manga.cover_url || api.thumbnailUrl(manga.cover_image);

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
          <img
            src={coverUrl}
            alt={manga.title}
            width={300}
            height={450}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
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

const MangaCard = React.memo(MangaCardImpl, (prev, next) => {
  const a = prev.manga;
  const b = next.manga;
  if (a === b) return true;
  return (
    a.id === b.id
    && a.title === b.title
    && a.year === b.year
    && a.score === b.score
    && a.status === b.status
    && a.cover_image === b.cover_image
    && a.cover_url === b.cover_url
  );
});

export default MangaCard;
