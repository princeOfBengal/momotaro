const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');

const router = express.Router();

const SELECT_ITEM_SQL = `
  SELECT g.id, g.manga_id, g.chapter_id, g.page_id, g.created_at,
         p.page_index,
         c.number       AS chapter_number,
         c.volume       AS chapter_volume,
         c.folder_name  AS chapter_folder_name,
         c.title        AS chapter_title
  FROM art_gallery g
  JOIN pages    p ON p.id = g.page_id
  JOIN chapters c ON c.id = g.chapter_id
`;

// GET /api/manga/:id/gallery — list art gallery items, newest first
router.get('/manga/:id/gallery', asyncWrapper(async (req, res) => {
  const db = getDb();
  const items = db.prepare(
    `${SELECT_ITEM_SQL} WHERE g.manga_id = ? ORDER BY g.created_at DESC, g.id DESC`
  ).all(parseInt(req.params.id, 10));
  res.json({ data: items });
}));

// POST /api/manga/:id/gallery — add a page. Body: { pageId }
router.post('/manga/:id/gallery', asyncWrapper(async (req, res) => {
  const db = getDb();
  const mangaId = parseInt(req.params.id, 10);
  const pageId  = parseInt(req.body?.pageId, 10);
  if (!pageId) return res.status(400).json({ error: 'pageId is required' });

  // Resolve the page's chapter and validate it belongs to this manga
  const page = db.prepare(
    `SELECT p.id, p.chapter_id, c.manga_id
     FROM pages p JOIN chapters c ON c.id = p.chapter_id
     WHERE p.id = ?`
  ).get(pageId);
  if (!page)                      return res.status(404).json({ error: 'Page not found' });
  if (page.manga_id !== mangaId)  return res.status(400).json({ error: 'Page does not belong to this manga' });

  db.prepare(
    'INSERT OR IGNORE INTO art_gallery (manga_id, chapter_id, page_id) VALUES (?, ?, ?)'
  ).run(mangaId, page.chapter_id, pageId);

  const item = db.prepare(
    `${SELECT_ITEM_SQL} WHERE g.manga_id = ? AND g.page_id = ?`
  ).get(mangaId, pageId);

  res.json({ data: item });
}));

// DELETE /api/manga/:id/gallery/page/:pageId — remove a page from the gallery by pageId
router.delete('/manga/:id/gallery/page/:pageId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const mangaId = parseInt(req.params.id, 10);
  const pageId  = parseInt(req.params.pageId, 10);
  const info = db.prepare('DELETE FROM art_gallery WHERE manga_id = ? AND page_id = ?').run(mangaId, pageId);
  res.json({ data: { removed: info.changes } });
}));

// DELETE /api/manga/:id/gallery/:itemId — remove a page from the gallery by gallery item id
router.delete('/manga/:id/gallery/:itemId', asyncWrapper(async (req, res) => {
  const db = getDb();
  const mangaId = parseInt(req.params.id, 10);
  const itemId  = parseInt(req.params.itemId, 10);
  const info = db.prepare('DELETE FROM art_gallery WHERE manga_id = ? AND id = ?').run(mangaId, itemId);
  res.json({ data: { removed: info.changes } });
}));

module.exports = router;
