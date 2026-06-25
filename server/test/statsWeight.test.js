/**
 * Verifies the chapter-equivalent weighting used by the reading statistics
 * (Total Chapters, Favorite Genres, Popular Series) and the source-diff range
 * expansion. Runs the real SQL fragment against an in-memory SQLite DB.
 *
 * Run with:  node test/statsWeight.test.js
 */

const assert = require('assert');
const Database = require('better-sqlite3');
const { readWeightSql, expandChapterRange } = require('../src/utils');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE chapters (
    id INTEGER PRIMARY KEY,
    number REAL, number_end REAL,
    volume REAL, volume_end REAL
  );
`);

const ins = db.prepare(
  'INSERT INTO chapters (id, number, number_end, volume, volume_end) VALUES (?, ?, ?, ?, ?)'
);
const weightOf = db.prepare(`SELECT ${readWeightSql('c')} AS w FROM chapters c WHERE c.id = ?`);

let passed = 0;
function weightCase(label, [number, numberEnd, volume, volumeEnd], expected) {
  const id = passed + 1;
  ins.run(id, number, numberEnd, volume, volumeEnd);
  const got = weightOf.get(id).w;
  assert.strictEqual(got, expected, `${label}: weight ${got}, expected ${expected}`);
  passed++;
}

// number=, number_end=, volume=, volume_end=
weightCase('single chapter',        [15,   null, null, null], 1);
weightCase('chapter range 10-12',   [10,   12,   null, null], 3);
weightCase('single volume',         [null, null, 3,    null], 4);
weightCase('volume range 17-18',    [null, null, 17,   18],   8);
weightCase('vol+chapter (single)',  [15,   null, 3,    null], 1);  // chapter axis dominates
weightCase('vol + chapter range',   [5,    12,   1,    2],    8);  // chapters 5..12
weightCase('fractional single',     [23.5, null, null, null], 1); // floor → 1
weightCase('untitled / bare',       [null, null, null, null], 1);

// ── expandChapterRange (source-diff covered-set) ─────────────────────────────
function rangeCase(label, [n, e], expected) {
  assert.deepStrictEqual(expandChapterRange(n, e), expected, `${label}: ${JSON.stringify(expandChapterRange(n, e))}`);
  passed++;
}
rangeCase('single 11',      [11, null], [11]);
rangeCase('range 10-12',    [10, 12],   [10, 11, 12]);
rangeCase('fractional 23.5',[23.5, null], [23.5]);
rangeCase('frac range 10.5-12', [10.5, 12], [10.5, 11, 12]); // start kept, no spurious 10
rangeCase('null number',    [null, null], []);

console.log(`statsWeight tests: ${passed} assertions passed.`);
