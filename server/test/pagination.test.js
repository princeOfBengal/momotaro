/**
 * Keyset-pagination acceptance test for GET /api/library.
 *
 * Covers the gated risks from the implementation plan for cursor pagination
 * over sort=year / sort=rating:
 *
 *   L1  NULL-boundary correctness — paging to exhaustion yields exactly the
 *       same rows, in the same order, as a single unbounded ORDER BY, including
 *       the trailing NULL block (NULLS LAST) and all tiebreakers.
 *   M3  No ORDER BY drift — the unbounded (limit-less) response order is
 *       asserted against an explicit golden ordering for each sort.
 *   H2  Cross-sort cursor replay is rejected (width mismatch → 400), not
 *       silently mis-paginated.
 *   C1  EXPLAIN QUERY PLAN uses idx_manga_year / idx_manga_score for ordering
 *       with no "USE TEMP B-TREE" sort step.
 *
 * Requires a working better-sqlite3 binding (run in the project runtime /
 * Docker):  node test/pagination.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-pagination-'));
  process.env.DB_PATH = path.join(tmp, 'app.db');
  process.env.SCAN_ON_STARTUP = 'false';
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}src${path.sep}`)) delete require.cache[k];
  }
  return tmp;
}

// Deterministic seed exercising every ordering edge:
//   - duplicate years and duplicate scores (id tiebreaker)
//   - duplicate (score, title) pairs (rating's 3-level key: score, title, id)
//   - NULL years and NULL scores (NULLS LAST tail)
//   - a NULL-title-free set (title is non-nullable in practice)
function seed(db) {
  const rows = [];
  let id = 0;
  const push = (title, year, score) => {
    id++;
    rows.push({ id, title, year, score });
  };
  // Distinct values
  push('Alpha', 2020, 9.5);
  push('Bravo', 2019, 8.0);
  push('Charlie', 2021, 7.25);
  // Duplicate years (→ id tiebreaker on year sort)
  push('Delta', 2020, 6.0);
  push('Echo', 2020, 6.0);
  // Duplicate scores, distinct titles (→ title tiebreaker on rating sort)
  push('Foxtrot', 2015, 8.0);
  push('Golf', 2014, 8.0);
  // Duplicate (score, title) (→ id tiebreaker on rating sort)
  push('Hotel', 2013, 5.5);
  push('Hotel', 2012, 5.5);
  // NULL year, non-null score (→ year NULLS-LAST tail)
  push('India', null, 9.0);
  push('Juliet', null, 4.0);
  // NULL score, non-null year (→ rating NULLS-LAST tail)
  push('Kilo', 2008, null);
  push('Lima', 2007, null);
  // NULL score AND NULL year, with duplicate titles in the tail
  push('Mike', null, null);
  push('Mike', null, null);
  push('November', null, null);

  const stmt = db.prepare(
    'INSERT INTO manga (id, folder_name, path, title, year, score, genres) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    stmt.run(r.id, `f${r.id}`, `/lib/f${r.id}`, r.title, r.year, r.score, '[]');
  }
  return rows;
}

async function startApp() {
  const { getDb } = require('../src/db/database');
  const { resolveUser, requireUser } = require('../src/middleware/userAuth');
  const libraryRoutes = require('../src/routes/library');

  const db = getDb();
  // Single-user mode OFF so no token is required (matches parity.test.js Mode A).
  db.prepare("INSERT INTO settings (key, value) VALUES ('multi_user_enabled', '0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  const seeded = seed(db);

  const app = express();
  app.use(express.json());
  app.use('/api', resolveUser, requireUser, libraryRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  return { db, srv, base: `http://127.0.0.1:${srv.address().port}`, seeded };
}

// Walk every page of a sort via cursors and return the flat id list.
async function pageAll(base, sort, pageSize) {
  const ids = [];
  let cursor = null;
  let guard = 0;
  for (;;) {
    guard++;
    assert.ok(guard < 1000, 'pagination did not terminate');
    const qs = new URLSearchParams({ sort, limit: String(pageSize) });
    if (cursor) qs.set('cursor', cursor);
    const resp = await fetch(`${base}/api/library?${qs}`);
    assert.equal(resp.status, 200, `page fetch 200 for sort=${sort}`);
    const body = await resp.json();
    for (const m of body.data) ids.push(m.id);
    if (!body.has_more) { assert.equal(body.next_cursor, null, 'last page has null cursor'); break; }
    assert.ok(body.next_cursor, 'non-last page has a cursor');
    cursor = body.next_cursor;
  }
  return ids;
}

async function unboundedIds(base, sort) {
  const resp = await fetch(`${base}/api/library?sort=${sort}`);
  assert.equal(resp.status, 200, `unbounded fetch 200 for sort=${sort}`);
  const body = await resp.json();
  // No limit → bare { data } envelope, no pagination fields.
  assert.equal(body.has_more, undefined, 'unbounded response omits has_more');
  return body.data.map(m => m.id);
}

// Golden orderings computed in JS straight from the seed, independent of SQL,
// so this also pins ORDER BY semantics (M3) rather than just self-consistency.
function goldenOrder(rows, sort) {
  const byId = (a, b) => a.id - b.id;
  const r = [...rows];
  if (sort === 'title') {
    return r.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || byId(a, b)).map(x => x.id);
  }
  if (sort === 'year') {
    // year DESC NULLS LAST, id ASC
    return r.sort((a, b) => {
      const an = a.year === null, bn = b.year === null;
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.year !== b.year) return b.year - a.year;
      return byId(a, b);
    }).map(x => x.id);
  }
  if (sort === 'rating') {
    // score DESC NULLS LAST, title ASC, id ASC
    return r.sort((a, b) => {
      const an = a.score === null, bn = b.score === null;
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.score !== b.score) return b.score - a.score;
      if (a.title !== b.title) return a.title < b.title ? -1 : 1;
      return byId(a, b);
    }).map(x => x.id);
  }
  throw new Error(`no golden for ${sort}`);
}

function explainUsesIndex(db, sql, indexName) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  const text = plan.map(p => p.detail).join(' | ');
  const usesIndex = text.includes(indexName);
  const tempSort = /USE TEMP B-TREE/i.test(text);
  return { usesIndex, tempSort, text };
}

async function main() {
  const tmp = freshDb();
  const { db, srv, base, seeded } = await startApp();

  try {
    // ── L1 + M3: pagination ≡ unbounded ≡ golden, for several page sizes. ──
    for (const sort of ['year', 'rating', 'title', 'updated']) {
      const unbounded = await unboundedIds(base, sort);
      // updated has no meaningful golden here (all updated_at default equal),
      // so only assert self-consistency for it; year/rating/title get golden.
      if (sort !== 'updated') {
        assert.deepEqual(unbounded, goldenOrder(seeded, sort), `unbounded order matches golden for sort=${sort}`);
      }
      for (const pageSize of [1, 2, 4, 5, seeded.length, seeded.length + 10]) {
        const paged = await pageAll(base, sort, pageSize);
        assert.deepEqual(paged, unbounded, `paged(${pageSize}) ≡ unbounded for sort=${sort}`);
        // No dupes, full coverage.
        assert.equal(new Set(paged).size, seeded.length, `no dupes / full coverage sort=${sort} page=${pageSize}`);
      }
    }
    console.log('pagination.test.js: L1/M3 pagination ≡ unbounded ≡ golden (incl. NULL tails)  ✓');

    // ── H2: cross-sort cursor replay rejected. ────────────────────────────
    // Grab a rating cursor (3-wide) and replay it under year (expects 2-wide).
    const ratingPage = await fetch(`${base}/api/library?sort=rating&limit=2`).then(r => r.json());
    assert.ok(ratingPage.next_cursor, 'rating produced a cursor');
    const bad = await fetch(`${base}/api/library?sort=year&limit=2&cursor=${encodeURIComponent(ratingPage.next_cursor)}`);
    assert.equal(bad.status, 400, 'width-mismatched cursor → 400');
    // And a legacy 2-wide title cursor still works (back-compat).
    const titlePage = await fetch(`${base}/api/library?sort=title&limit=2`).then(r => r.json());
    const titleNext = await fetch(`${base}/api/library?sort=title&limit=2&cursor=${encodeURIComponent(titlePage.next_cursor)}`);
    assert.equal(titleNext.status, 200, 'title cursor resumes 200');
    console.log('pagination.test.js: H2 cross-sort cursor rejected; title cursor back-compat  ✓');

    // ── C1: query plans use the indexes, no temp sort. ────────────────────
    const baseFrom = 'FROM manga m LEFT JOIN libraries l ON l.id = m.library_id WHERE 1=1 AND (m.library_id IS NULL OR l.show_in_all = 1)';
    const yearPlan = explainUsesIndex(db, `SELECT m.id ${baseFrom} ORDER BY m.year DESC NULLS LAST, m.id ASC LIMIT 201`, 'idx_manga_year');
    const scorePlan = explainUsesIndex(db, `SELECT m.id ${baseFrom} ORDER BY m.score DESC NULLS LAST, m.title ASC, m.id ASC LIMIT 201`, 'idx_manga_score');
    console.log('  year  plan :', yearPlan.text);
    console.log('  score plan :', scorePlan.text);
    assert.ok(yearPlan.usesIndex && !yearPlan.tempSort, 'C1: year sort uses idx_manga_year with no temp b-tree');
    assert.ok(scorePlan.usesIndex && !scorePlan.tempSort, 'C1: rating sort uses idx_manga_score with no temp b-tree');
    console.log('pagination.test.js: C1 index-backed ordering, no temp b-tree  ✓');

    console.log('pagination.test.js: ALL PASSED');
  } finally {
    srv.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
