/**
 * Verifies the "More Info" missing-chapter / missing-volume computation is
 * range-aware: a multi-chapter/volume file (Ch 10-12, v17-18) must mark every
 * integer it covers as present, so the bundled middle/end numbers aren't
 * falsely reported missing.
 *
 * Mirrors the route wiring in GET /api/manga/:id/info:
 *   computeMissingSequence(rows.flatMap(r => expandChapterRange(start, end)))
 *
 * Run with:  node test/missingSequence.test.js
 */

const assert = require('assert');
const { computeMissingSequence, expandChapterRange } = require('../src/utils');

let passed = 0;

// rows: [[start, end], ...] on one axis → { count, numbers, max }
function missingFor(rows) {
  return computeMissingSequence(rows.flatMap(([s, e]) => expandChapterRange(s, e)));
}
function check(label, rows, expected) {
  const got = missingFor(rows);
  assert.deepStrictEqual(
    { count: got.count, numbers: got.numbers, max: got.max },
    expected,
    `${label}: got ${JSON.stringify(got)}`,
  );
  passed++;
}

// A range that is the highest entry must extend `max` to its end (regression:
// pre-fix, "Ch 10-12" only registered 10, understating max as 10).
check('range fills to its end', [[1, null], [2, null], [3, null], [4, null], [5, null],
                                 [6, null], [7, null], [8, null], [9, null], [10, 12]],
  { count: 0, numbers: [], max: 12 });

// A range bundled below a higher single — pre-fix, 11 and 12 were falsely
// reported missing because 15 pushed max to 15.
check('range bundles middle, real gaps after', [[10, 12], [15, null]].concat(
        Array.from({ length: 9 }, (_, i) => [i + 1, null])),
  { count: 2, numbers: [13, 14], max: 15 });

// Volume range to the top of the collection.
check('volume range extends max', [[1, null], [2, null], [17, 18]].concat(
        Array.from({ length: 14 }, (_, i) => [i + 3, null])),
  { count: 0, numbers: [], max: 18 });

// Genuine gap with no ranges (unchanged baseline behaviour).
check('plain gap', [[1, null], [2, null], [4, null]],
  { count: 1, numbers: [3], max: 4 });

// Volume-only rows contribute nothing on the chapter axis (start null → []).
check('null axis ignored', [[null, null], [null, null]],
  { count: 0, numbers: [], max: 0 });

console.log(`missingSequence tests: ${passed} assertions passed.`);
