const fetch = require('node-fetch');

const JIKAN_URL = 'https://api.jikan.moe/v4';

function normalizeStatus(status) {
  if (!status) return 'UNKNOWN';
  const s = status.toLowerCase();
  if (s.includes('publishing')) return 'RELEASING';
  if (s.includes('finished')) return 'FINISHED';
  if (s.includes('hiatus')) return 'HIATUS';
  if (s.includes('discontinued')) return 'CANCELLED';
  return 'UNKNOWN';
}

async function fetchFromJikan(title) {
  const search = title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
  const url = `${JIKAN_URL}/manga?q=${encodeURIComponent(search)}&limit=1&sfw=true`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Jikan responded with ${resp.status}`);
  }

  const json = await resp.json();
  const data = json.data?.[0];
  if (!data) return null;

  const description = data.synopsis
    ? data.synopsis.replace(/\[Written by.*?\]/g, '').trim()
    : null;

  return {
    title: data.title_english || data.title || title,
    description,
    status: normalizeStatus(data.status),
    year: data.published?.from ? new Date(data.published.from).getFullYear() : null,
    genres: (data.genres || []).map(g => g.name),
    score: data.score || null,
    anilist_id: null,
    mal_id: data.mal_id || null,
    source: 'jikan',
  };
}

module.exports = { fetchFromJikan };
