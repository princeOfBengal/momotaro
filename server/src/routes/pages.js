const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');

const router = express.Router();

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

// GET /api/chapters/:id/pages — list all pages for a chapter
router.get('/chapters/:id/pages', asyncWrapper(async (req, res) => {
  const db = getDb();
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

  const pages = db.prepare(
    'SELECT id, page_index, filename, width, height FROM pages WHERE chapter_id = ? ORDER BY page_index ASC'
  ).all(chapter.id);

  res.json({
    data: pages.map(p => ({
      ...p,
      is_wide: p.width !== null && p.height !== null ? p.width > p.height : null,
    })),
  });
}));

// GET /api/pages/:id/image — serve a page image
router.get('/pages/:id/image', asyncWrapper(async (req, res) => {
  const db = getDb();
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });

  const filePath = page.path;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Image file not found on disk' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const stream = fs.createReadStream(filePath);
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}));

module.exports = router;
