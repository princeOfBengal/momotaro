const sharp = require('sharp');
const { thumbnailPath, ensureShardDir } = require('./thumbnailPaths');
const { openCbzEntryStream } = require('./chapterParser');

/**
 * Read a readable stream into a single Buffer.
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Load the raw bytes of a cover-page source.
 *
 * Accepts either:
 *   - a string (absolute filesystem path to the image), or
 *   - an object { type, chapterPath, entry } where `type` is 'folder'|'cbz':
 *       · folder → `entry` is the absolute file path
 *       · cbz    → `entry` is the ZIP entry name inside chapterPath
 */
async function loadCoverSource(src) {
  if (typeof src === 'string') return src;                    // sharp can read paths directly
  if (!src) return null;
  if (src.type === 'folder') return src.entry;
  if (src.type === 'cbz') {
    const stream = await openCbzEntryStream(src.chapterPath, src.entry);
    return streamToBuffer(stream);
  }
  return null;
}

async function generateThumbnail(source, mangaId) {
  const filename = `${mangaId}.webp`;
  ensureShardDir(filename);
  const outputPath = thumbnailPath(filename);

  try {
    const input = await loadCoverSource(source);
    if (!input) return null;
    await sharp(input)
      .resize(300, 430, { fit: 'cover', position: 'top' })
      .webp({ quality: 85 })
      .toFile(outputPath);
    return outputPath;
  } catch (err) {
    console.error(`Failed to generate thumbnail for manga ${mangaId}:`, err.message);
    return null;
  }
}

module.exports = { generateThumbnail };
