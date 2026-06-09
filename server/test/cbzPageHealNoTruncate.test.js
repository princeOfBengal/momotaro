/**
 * Regression test for the page-table truncation bug.
 *
 * The cache-hit heal in routes/pages.js rebuilt the `pages` rows from the
 * on-disk file list whenever `rows.length !== diskFiles.length`. During
 * fast-mode Phase 2 the on-disk set is a PARTIAL (and, with priority
 * extraction, NON-PREFIX) subset of the planned pages, so the heal trimmed the
 * pages table to the extracted count — deleting tail rows (destroying the
 * stable IDs the reader's in-flight <img> URLs depend on) and scrambling
 * page_index. The fix gates the rebuild on the extraction being COMPLETE.
 *
 * This drives the extracted helper directly against a temp SQLite DB:
 *   A) extracting:true + partial prefix on disk      → no truncation, IDs kept
 *   B) extracting:true + non-prefix (priority) subset → no reorder
 *   C) extracting:false + legacy entry-name paths     → rebuild heals paths
 *   D) extracting:false + rows already match disk      → no-op
 *
 * Run with:  node test/cbzPageHealNoTruncate.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-pageheal-'));
process.env.CBZ_CACHE_DIR = path.join(tmpRoot, 'cbz-cache');
fs.mkdirSync(process.env.CBZ_CACHE_DIR, { recursive: true });

const Database = require('better-sqlite3');
const sharp = require('sharp');
const { __test } = require('../src/routes/pages');
const { reconcileCbzPageRowsOnCacheHit } = __test;

const PAD = 4;
const cacheName = (i) => String(i + 1).padStart(PAD, '0') + '.jpg'; // 1-based, 0001.jpg

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL,
      page_index INTEGER NOT NULL,
      filename   TEXT NOT NULL,
      path       TEXT NOT NULL,
      width      INTEGER,
      height     INTEGER,
      UNIQUE(chapter_id, page_index)
    );
  `);
  return db;
}

// Seed `count` page rows for a chapter with cache-filename paths and known dims.
function seedFullRows(db, chapterId, count, { dims = true } = {}) {
  db.prepare('INSERT INTO chapters (id, page_count) VALUES (?, ?)').run(chapterId, count);
  const ins = db.prepare(
    'INSERT INTO pages (chapter_id, page_index, filename, path, width, height) VALUES (?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      ins.run(chapterId, i, cacheName(i), cacheName(i), dims ? 100 : null, dims ? 140 : null);
    }
  })();
}

function rowsOf(db, chapterId) {
  return db.prepare(
    'SELECT id, page_index, path, width, height FROM pages WHERE chapter_id = ? ORDER BY page_index ASC'
  ).all(chapterId);
}

// Write `names` as real tiny JPEGs into `dir` (+ optional .ready marker).
async function writeFiles(dir, names, { ready = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = await sharp({
    create: { width: 8, height: 12, channels: 3, background: { r: 5, g: 6, b: 7 } },
  }).jpeg().toBuffer();
  for (const n of names) fs.writeFileSync(path.join(dir, n), buf);
  if (ready) fs.writeFileSync(path.join(dir, '.ready'), '');
}

(async () => {
  // ── A) Mid-extraction prefix subset: must NOT truncate ──────────────────
  {
    const db = makeDb();
    const CH = 1;
    seedFullRows(db, CH, 50, { dims: true });
    const before = rowsOf(db, CH);
    const dir = path.join(tmpRoot, 'A');
    // Only the first 20 pages extracted so far (no .ready — Phase 2 running).
    await writeFiles(dir, Array.from({ length: 20 }, (_, i) => cacheName(i)));

    await reconcileCbzPageRowsOnCacheHit(db, CH, dir, { extracting: true });

    const after = rowsOf(db, CH);
    assert.strictEqual(after.length, 50, 'A: all 50 rows must survive mid-extraction');
    assert.deepStrictEqual(
      after.map(r => r.id), before.map(r => r.id),
      'A: page-row IDs must be preserved (no delete+reinsert)',
    );
    assert.deepStrictEqual(
      after.map(r => r.path), before.map(r => r.path),
      'A: page_index → path mapping must be unchanged',
    );
    assert.strictEqual(
      db.prepare('SELECT page_count FROM chapters WHERE id = ?').pluck().get(CH), 50,
      'A: page_count must stay at the full count',
    );
    db.close();
  }

  // ── B) Mid-extraction NON-prefix (priority) subset: must NOT reorder ─────
  {
    const db = makeDb();
    const CH = 2;
    seedFullRows(db, CH, 50, { dims: true });
    const before = rowsOf(db, CH);
    const dir = path.join(tmpRoot, 'B');
    // Priority extraction landed pages 1..20 plus page 50 out of order.
    const names = Array.from({ length: 20 }, (_, i) => cacheName(i));
    names.push(cacheName(49)); // 0050.jpg
    await writeFiles(dir, names);

    await reconcileCbzPageRowsOnCacheHit(db, CH, dir, { extracting: true });

    const after = rowsOf(db, CH);
    assert.strictEqual(after.length, 50, 'B: all 50 rows must survive a non-prefix subset');
    assert.deepStrictEqual(
      after.map(r => r.path), before.map(r => r.path),
      'B: page_index → path mapping must not be scrambled by out-of-order files',
    );
    db.close();
  }

  // ── C) Completed + legacy entry-name paths: rebuild heals to cache names ──
  {
    const db = makeDb();
    const CH = 3;
    const N = 6;
    // Legacy rows: paths are ZIP entry names, not cache filenames.
    db.prepare('INSERT INTO chapters (id, page_count) VALUES (?, ?)').run(CH, N);
    const ins = db.prepare(
      'INSERT INTO pages (chapter_id, page_index, filename, path, width, height) VALUES (?, ?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        ins.run(CH, i, `p${i}.jpg`, `pages/${String(i + 1).padStart(3, '0')}.jpg`, null, null);
      }
    })();
    const dir = path.join(tmpRoot, 'C');
    await writeFiles(dir, Array.from({ length: N }, (_, i) => cacheName(i)), { ready: true });

    await reconcileCbzPageRowsOnCacheHit(db, CH, dir, { extracting: false });

    const after = rowsOf(db, CH);
    assert.strictEqual(after.length, N, 'C: row count matches the complete archive');
    assert.deepStrictEqual(
      after.map(r => r.path), Array.from({ length: N }, (_, i) => cacheName(i)),
      'C: legacy entry-name paths must be rebuilt to cache filenames',
    );
    assert.ok(
      after.every(r => r.width !== null && r.height !== null),
      'C: dims must be backfilled from disk after the rebuild',
    );
    db.close();
  }

  // ── D) Completed + rows already correct: no-op ───────────────────────────
  {
    const db = makeDb();
    const CH = 4;
    seedFullRows(db, CH, 8, { dims: true });
    const before = rowsOf(db, CH);
    const dir = path.join(tmpRoot, 'D');
    await writeFiles(dir, Array.from({ length: 8 }, (_, i) => cacheName(i)), { ready: true });

    await reconcileCbzPageRowsOnCacheHit(db, CH, dir, { extracting: false });

    const after = rowsOf(db, CH);
    assert.deepStrictEqual(after.map(r => r.id), before.map(r => r.id), 'D: IDs unchanged on a healthy cache hit');
    assert.deepStrictEqual(after.map(r => r.path), before.map(r => r.path), 'D: paths unchanged on a healthy cache hit');
    db.close();
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('cbzPageHealNoTruncate.test.js: PASS — heal never truncates mid-extraction, still heals when complete');
  process.exit(0);
})().catch((err) => {
  console.error('cbzPageHealNoTruncate.test.js: FAIL');
  console.error(err);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
