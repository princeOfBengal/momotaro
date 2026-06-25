const express = require('express');
const { getDb } = require('../db/database');
const { asyncWrapper } = require('../middleware/asyncWrapper');

const router = express.Router();

const SELECT_ITEM_SQL = `
  SELECT g.id, g.manga_id, g.chapter_id, g.page_id, g.created_at,
         p.page_index,
         c.number       AS chapter_number,
         c.number_end   AS chapter_number_end,
         c.volume       AS chapter_volume,
         c.volume_end   AS chapter_volume_end,
         c.folder_name  AS chapter_folder_name,
         c.title        AS chapter_title
  FROM art_gallery g
  JOIN pages    p ON p.id = g.page_id
  JOIN chapters c ON c.id = g.chapter_id
`;

// GET /api/gallery/all — every saved page in the art gallery, grouped by
// series. Each group is `{ manga_id, manga_title, items: [...] }` ordered by
// title; items inside a group are newest-first. Each item carries the page's
// stored width/height so the dedicated Art Gallery page can render landscape
// pages at their natural aspect ratio without cropping.
router.get('/gallery/all', asyncWrapper(async (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ag.id, ag.manga_id, m.title AS manga_title,
           ag.chapter_id,
           c.folder_name AS chapter_folder_name,
           c.number AS chapter_number,
           c.number_end AS chapter_number_end,
           c.volume AS chapter_volume,
           c.volume_end AS chapter_volume_end,
           c.title  AS chapter_title,
           ag.page_id, p.page_index, p.width, p.height,
           ag.created_at
    FROM art_gallery ag
    JOIN manga m    ON m.id = ag.manga_id
    JOIN chapters c ON c.id = ag.chapter_id
    JOIN pages p    ON p.id = ag.page_id
    LEFT JOIN libraries l ON l.id = m.library_id
    WHERE (m.library_id IS NULL OR l.show_in_all = 1)
    ORDER BY m.title COLLATE NOCASE ASC, ag.created_at DESC, ag.id DESC
  `).all();

  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.manga_id);
    if (!g) {
      g = { manga_id: r.manga_id, manga_title: r.manga_title, items: [] };
      groups.set(r.manga_id, g);
    }
    g.items.push({
      id:                  r.id,
      manga_id:            r.manga_id,
      manga_title:         r.manga_title,
      chapter_id:          r.chapter_id,
      chapter_folder_name: r.chapter_folder_name,
      chapter_number:      r.chapter_number,
      chapter_volume:      r.chapter_volume,
      chapter_title:       r.chapter_title,
      page_id:             r.page_id,
      page_index:          r.page_index,
      width:               r.width,
      height:              r.height,
      page_image_url:      `/api/pages/${r.page_id}/image`,
      created_at:          r.created_at,
    });
  }

  res.json({ data: Array.from(groups.values()) });
}));

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
