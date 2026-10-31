/**
 * Unit tests for detectExtraLabel / detectExtraLabels — the Omake / Bonus /
 * Extras … tagging that keeps bonus material distinct from the regular
 * chapter or volume sharing its number.
 *
 * Run with:  node test/extraLabel.test.js
 */

const assert = require('assert');
const { detectExtraLabel, detectExtraLabels, detectExtraInfo, parseChapterInfo } = require('../src/scanner/chapterParser');

let passed = 0;

function eq(input, expected, seriesName = null) {
  const got = detectExtraLabel(input, seriesName);
  assert.strictEqual(got, expected, `detectExtraLabel(${JSON.stringify(input)}) → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  passed++;
}

// ── Keywords → canonical label ───────────────────────────────────────────────
eq('Ch 10 - Omake.cbz',              'Omake');
eq('Ch 5 Bonus.cbz',                 'Bonus');
eq('Ch 5 Bonuses',                   'Bonus');
eq('Vol 1 Extras.cbz',               'Extra');
eq('Vol 3 Extra Chapter.cbz',        'Extra');
eq('Artbook.cbz',                    'Artbook');
eq('Vol 2 Art Book.cbz',             'Artbook');
eq('Art-Books 1',                    'Artbook');
eq('Official Fanbook.cbz',           'Fanbook');
eq('Data Book.cbz',                  'Databook');
eq('Guidebook vol 1.cbz',            'Guidebook');
eq('Illustrations.cbz',              'Illustrations');
eq('Vol 4 Artworks',                 'Illustrations');
eq('Ch 20 Side Story.cbz',           'Side Story');
eq('Side-Stories 01',                'Side Story');
eq('Short Stories.cbz',              'Short Story');
eq('Gaiden 01.cbz',                  'Gaiden');
eq('Spin-off Ch 1.cbz',              'Spin-off');
eq('Ch 5.5 Special.cbz',             'Special');
eq('One-shot.cbz',                   'Oneshot');
eq('Oneshot 1.cbz',                  'Oneshot');
eq('Pilot Chapter.cbz',              'Pilot');
eq('Vol 1 4-Koma.cbz',               '4-Koma');
eq('Yonkoma 3.cbz',                  '4-Koma');
eq('Ch 12 Interlude.cbz',            'Interlude');
eq('Intermission.cbz',               'Interlude');
eq('Vol 10 Afterword.cbz',           'Afterword');
eq('OMAKE_ch_3.cbz',                 'Omake');      // case + underscores

// ── Standard optimize names re-read to the same label ────────────────────────
for (const label of ['Omake', 'Bonus', 'Extra', 'Artbook', 'Fanbook', 'Databook', 'Guidebook',
  'Illustrations', 'Side Story', 'Short Story', 'Gaiden', 'Spin-off', 'Special', 'Oneshot',
  'Pilot', '4-Koma', 'Interlude', 'Afterword']) {
  eq(`Ch 5 ${label}.cbz`, label);
}

// ── Not extras ───────────────────────────────────────────────────────────────
eq('Ch 5.cbz',                       null);
eq('Vol 1.cbz',                      null);
eq('Ch 5 [Extra Scans].cbz',         null);         // scanlator tag ignored
eq('Ch 5 - Extraordinary.cbz',       null);         // whole words only
eq('Ch 5 - Bonusworld.cbz',          null);
eq('Kingdom Gaiden c001.cbz',        null, 'Kingdom Gaiden');   // series name ignored
eq('Kingdom Gaiden c001 Omake.cbz',  'Omake', 'Kingdom Gaiden');

// ── Series name is removed as whole words only ───────────────────────────────
eq('Ch 5 Omake.cbz',                 'Omake', 'K');      // "K" must not eat the k in Omake
eq('Ch 3 Bonus.cbz',                 'Bonus', 'Bo');
eq('Ch 3 Bonus.cbz',                 'Bonus', 'Ao');
eq('Kingdom_Gaiden c001.cbz',        null,    'Kingdom Gaiden');  // underscore ≈ space
eq('kingdom  gaiden c001.cbz',       null,    'Kingdom Gaiden');  // case / whitespace
eq('Kingdom Gaiden c001.cbz',        null,    'Kingdom Gaiden (2015)');  // folder "(qualifier)" ignored
eq('Ch 5 Omake.cbz',                 'Omake', 'Oma');    // series name as a word prefix isn't stripped

// ── Folder-wide rules ────────────────────────────────────────────────────────
function labels(names, series) {
  return [...detectExtraLabels(names, series).values()];
}
function keywords(names, series) {
  return [...detectExtraInfo(names, series).values()].map(i => i.keyword);
}
{
  // Shared title prefix — keyword before the number on every entry.
  assert.deepStrictEqual(labels(['Gaiden c001.cbz', 'Gaiden c002.cbz'], 'Something Else'), [null, null]); passed++;
  // …even when one entry is a real extra (old "all identical" rule failed here).
  assert.deepStrictEqual(
    labels(['X Gaiden c1.cbz', 'X Gaiden c2.cbz', 'X Gaiden c3.cbz', 'X Gaiden c3 Omake.cbz'], 'X Gaiden (2015)'),
    [null, null, null, 'Omake']); passed++;
  // Prefix suppressed, the trailing keyword on the same name still wins.
  assert.deepStrictEqual(labels(['X Omake c1.cbz', 'X Omake c2 Bonus.cbz'], 'Other'), [null, 'Bonus']); passed++;

  // Majority backstop — a few odd-named files break the shared prefix.
  assert.deepStrictEqual(
    labels(['X Gaiden c1.cbz', 'X Gaiden c2.cbz', 'X Gaiden c3.cbz', 'c4.cbz', 'X Gaiden c4 Omake.cbz'], 'Other'),
    [null, null, null, null, 'Omake']); passed++;
  // Exactly half isn't a majority: "every chapter has an omake" keeps its labels.
  assert.deepStrictEqual(labels(['Ch 1.cbz', 'Omake 1.cbz', 'Ch 2.cbz', 'Omake 2.cbz'], 'S'),
    [null, 'Omake', null, 'Omake']); passed++;
  // Majority only applies in title position — trailing extras are never suppressed.
  assert.deepStrictEqual(labels(['Ch 5 Bonus.cbz', 'Ch 6 Bonus.cbz', 'Ch 7 Bonus.cbz', 'Ch 8.cbz'], 'S'),
    ['Bonus', 'Bonus', 'Bonus', null]); passed++;

  // Shared prefix that would leave a name empty is not applied.
  // (EXTRA_LABELS order decides between two keywords — Extra precedes Artbook.)
  assert.deepStrictEqual(labels(['Artbook.cbz', 'Artbook Extra.cbz'], 'S'), ['Artbook', 'Extra']); passed++;

  assert.deepStrictEqual(labels(['Ch 5.cbz', 'Ch 5 Bonus.cbz'], 'Series'), [null, 'Bonus']); passed++;
  assert.deepStrictEqual(labels(['Artbook.cbz'], 'Series'), ['Artbook']); passed++;

  // `keyword` ignores the suppression rules — it protects files from dedupe.
  assert.deepStrictEqual(labels(['Bonus 5 A.cbz', 'Bonus 5 B.cbz'], 'S'), [null, null]); passed++;
  assert.deepStrictEqual(keywords(['Bonus 5 A.cbz', 'Bonus 5 B.cbz'], 'S'), [true, true]); passed++;
  assert.deepStrictEqual(keywords(['Kingdom Gaiden c1.cbz', 'Ch 2.cbz'], 'Kingdom Gaiden'), [false, false]); passed++;
}

// ── Parser: keywords can't supply the fallback chapter number ────────────────
{
  const eqInfo = (name, want) => {
    const got = parseChapterInfo(name);
    assert.deepStrictEqual(
      [got.volume, got.chapter], [want.volume ?? null, want.chapter ?? null],
      `parseChapterInfo(${JSON.stringify(name)}) → ${JSON.stringify(got)}`);
    passed++;
  };
  eqInfo('Vol 1 4-Koma.cbz',  { volume: 1 });          // was Vol 1 Ch 4
  eqInfo('Vol 1 Yonkoma.cbz', { volume: 1 });
  eqInfo('4-Koma 3.cbz',      { chapter: 3 });
  eqInfo('Oneshot 1.cbz',     { chapter: 1 });
  eqInfo('Ch 5 4-Koma.cbz',   { chapter: 5 });
}

console.log(`extraLabel tests: ${passed} assertions passed.`);
