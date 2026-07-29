/**
 * Home cold-start mitigation test. Verifies:
 *   1. The two ribbon indexes added by ensureHomeIndexes() are actually chosen
 *      by the planner for the Continue Reading and Art Gallery queries (so a
 *      cold /api/home miss is index-backed, not a scan+sort).
 *   2. The background warmer (warmHomeStartup / warmHome) runs end-to-end
 *      against a seeded catalogue without throwing and warms at least the
 *      default user.
 *
 * Runs without a test runner — plain node assertions, exits non-zero on
 * failure. Requires a working better-sqlite3 binding (same as the app):
 *
 *   node test/homeWarmer.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-homewarm-'));
process.env.DATA_PATH = tmp;
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb } = require('../src/db/database');
const db = getDb();

// Seed a tiny catalogue. manga_genres is maintained by triggers on `manga`,
// so we only insert the genres JSON blob and let the trigger normalise it.
db.exec(`
  INSERT INTO libraries (id,name,path,show_in_all) VALUES (1,'Main','/lib',1);
  INSERT INTO manga (id,library_id,folder_name,path,title,score,genres,created_at,cover_image)
    VALUES (1,1,'a','/lib/a','Alpha',8.5,'["Action"]',1000,'1.webp'),
           (2,1,'b','/lib/b','Beta',7.2,'["Action","Romance"]',2000,'2.webp');
  INSERT INTO chapters (id,manga_id,folder_name,path,type,number,page_count)
    VALUES (10,1,'c1','/lib/a/c1','folder',1,5);
  INSERT INTO pages (id,chapter_id,page_index,filename,path,width,height)
    VALUES (100,10,0,'p.jpg','/lib/a/c1/p.jpg',800,1200);
  INSERT INTO progress (user_id,manga_id,current_chapter_id,current_page,completed_chapters,last_read_at)
    VALUES (1,1,10,2,'[]',5000);
  INSERT INTO art_gallery (id,manga_id,chapter_id,page_id,created_at) VALUES (1,1,10,100,4000);
`);

function plan(sql, params) {
  return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(r => r.detail).join(' | ');
}

// ── 1. Index usage ──────────────────────────────────────────────────────────
const continuePlan = plan(`
  SELECT m.id FROM progress p
  JOIN manga m ON m.id = p.manga_id
  LEFT JOIN libraries l ON l.id = m.library_id
  LEFT JOIN chapters c ON c.id = p.current_chapter_id
  WHERE p.user_id = ? AND (m.library_id IS NULL OR l.show_in_all = 1)
  ORDER BY p.last_read_at DESC LIMIT ?`, [1, 15]);

const galleryPlan = plan(`
  SELECT ag.id FROM art_gallery ag
  JOIN manga m ON m.id = ag.manga_id
  JOIN chapters c ON c.id = ag.chapter_id
  JOIN pages pg ON pg.id = ag.page_id
  LEFT JOIN libraries l ON l.id = m.library_id
  WHERE (m.library_id IS NULL OR l.show_in_all = 1)
  ORDER BY ag.created_at DESC LIMIT ?`, [50]);

assert(
  continuePlan.includes('idx_progress_user_last_read'),
  `Continue Reading should use idx_progress_user_last_read; got: ${continuePlan}`,
);
// The gallery ORDER BY must be satisfied by the index, not a temp b-tree.
assert(
  galleryPlan.includes('idx_art_gallery_created_at') && !/USE TEMP B-TREE/i.test(galleryPlan),
  `Art Gallery should use idx_art_gallery_created_at with no temp b-tree; got: ${galleryPlan}`,
);
console.log('homeWarmer.test.js: ribbon queries are index-backed  ✓');

// ── 2. Warmer end-to-end ─────────────────────────────────────────────────────
const lib = require('../src/routes/library');
assert.doesNotThrow(() => lib.warmHomeStartup(), 'warmHomeStartup threw');

(async () => {
  // Seed a second user with canonical default params so the pass has >1 user
  // and actually exercises the between-user yield path (not just the single-
  // user shortcut). buildHomePayload for a user with no rows returns empty
  // ribbons rather than throwing, so this warms cleanly.
  lib.recordHomeActivity(2, lib.parseHomeParams({}));

  const warmed = await lib.warmHome({ maxUsers: 8, windowMs: 7 * 24 * 60 * 60 * 1000 });
  assert(
    warmed >= 2,
    `warmHome should warm both seeded users (default + user 2); warmed=${warmed}`,
  );
  console.log('homeWarmer.test.js: warmer runs end-to-end across multiple users  ✓');

  console.log('homeWarmer.test.js: ALL PASSED');
})().catch(err => {
  console.error('homeWarmer.test.js: FAILED', err);
  process.exit(1);
});
