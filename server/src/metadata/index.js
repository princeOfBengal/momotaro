const { fetchFromAniList } = require('./anilist');
const { fetchFromJikan } = require('./jikan');
const config = require('../config');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try AniList first, fall back to Jikan. Returns normalized metadata or null.
 */
async function fetchMetadata(title) {
  // Try AniList
  try {
    const result = await fetchFromAniList(title);
    if (result) {
      await delay(config.REQUEST_DELAY_MS);
      return result;
    }
  } catch (err) {
    console.warn(`[Metadata] AniList failed for "${title}": ${err.message}`);
  }

  // Fallback to Jikan
  try {
    await delay(400); // Jikan rate limit: 3 req/sec
    const result = await fetchFromJikan(title);
    if (result) return result;
  } catch (err) {
    console.warn(`[Metadata] Jikan failed for "${title}": ${err.message}`);
  }

  return null;
}

module.exports = { fetchMetadata };
