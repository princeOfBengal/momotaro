const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');

async function generateThumbnail(imagePath, mangaId) {
  const outputDir = config.THUMBNAIL_DIR;
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${mangaId}.webp`);

  try {
    await sharp(imagePath)
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
