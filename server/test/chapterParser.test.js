/**
 * Unit tests for parseChapterInfo's multi-chapter / multi-volume range support.
 *
 * Covers every separator variation, the combined Vol+Ch range form, the
 * single-number back-compat cases, and the false-positive guards (hyphenated
 * titles, year ranges, descending / oversized spans).
 *
 * Run with:  node test/chapterParser.test.js
 */

const assert = require('assert');
const { parseChapterInfo } = require('../src/scanner/chapterParser');

let passed = 0;

// Assert the full { chapter, chapterEnd, volume, volumeEnd } shape.
function eq(input, expected) {
  const got = parseChapterInfo(input);
  const want = {
    chapter:    expected.chapter    ?? null,
    chapterEnd: expected.chapterEnd ?? null,
    volume:     expected.volume     ?? null,
    volumeEnd:  expected.volumeEnd  ?? null,
  };
  assert.deepStrictEqual(got, want, `parseChapterInfo(${JSON.stringify(input)}) → ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// ── Single values (back-compat — *End must stay null) ────────────────────────
eq('Vol. 03 Ch. 023.5 - Some Title [Group]', { volume: 3, chapter: 23.5 });
eq('[Fansub] Vol.02 Ch.012 Extra Text',      { volume: 2, chapter: 12 });
eq('Chapter 23.5',                           { chapter: 23.5 });
eq('Vol 1.cbz',                              { volume: 1 });
eq('001',                                    { chapter: 1 });
eq('v01',                                    { volume: 1 });
eq('c01',                                    { chapter: 1 });
eq('Ch.13 - Title',                          { chapter: 13 });

// ── Volume ranges ────────────────────────────────────────────────────────────
eq('Yamada-kun and the Seven Witches v17-18.cbz', { volume: 17, volumeEnd: 18 });
eq('v17-v18',          { volume: 17, volumeEnd: 18 });
eq('Vol. 17-18',       { volume: 17, volumeEnd: 18 });
eq('Volume 17-18',     { volume: 17, volumeEnd: 18 });
eq('Volumes 1-3',      { volume: 1,  volumeEnd: 3 });
eq('Vols 1-3',         { volume: 1,  volumeEnd: 3 });
eq('v01-03',           { volume: 1,  volumeEnd: 3 });
eq('v17–18',      { volume: 17, volumeEnd: 18 }); // en-dash
eq('v17—18',      { volume: 17, volumeEnd: 18 }); // em-dash
eq('v17~18',           { volume: 17, volumeEnd: 18 }); // tilde
eq('Vol 1 to 3',       { volume: 1,  volumeEnd: 3 });

// ── Volume discrete joiners ──────────────────────────────────────────────────
eq('v17 & 18',         { volume: 17, volumeEnd: 18 });
eq('v17,18',           { volume: 17, volumeEnd: 18 });
eq('v17+18',           { volume: 17, volumeEnd: 18 });
eq('Vol.17 & Vol.18',  { volume: 17, volumeEnd: 18 });

// ── Chapter ranges ───────────────────────────────────────────────────────────
eq('c10-12',           { chapter: 10, chapterEnd: 12 });
eq('c10-c12',          { chapter: 10, chapterEnd: 12 });
eq('Ch. 10-12',        { chapter: 10, chapterEnd: 12 });
eq('Chapter 10-12',    { chapter: 10, chapterEnd: 12 });
eq('Chapters 10-15',   { chapter: 10, chapterEnd: 15 });
eq('c001-005',         { chapter: 1,  chapterEnd: 5 });
eq('Ch 100.5-101',     { chapter: 100.5, chapterEnd: 101 });

// ── Combined volume + chapter ranges ─────────────────────────────────────────
eq('Vol. 17-18 Ch. 150-160', { volume: 17, volumeEnd: 18, chapter: 150, chapterEnd: 160 });
eq('v17-18 c150-160',        { volume: 17, volumeEnd: 18, chapter: 150, chapterEnd: 160 });
eq('Vol 1-2 Ch 5-12',        { volume: 1,  volumeEnd: 2,  chapter: 5,   chapterEnd: 12 });
eq('Vol 3 Ch 11-14',         { volume: 3,  chapter: 11,  chapterEnd: 14 }); // chapter range, single volume

// ── Bare numeric range ───────────────────────────────────────────────────────
eq('Spy x Family 01-05',     { chapter: 1, chapterEnd: 5 });

// ── Chained runs (3+ numbers) consume FULLY — no leak into the other axis ────
// Regression: pre-fix, "Vol 1,2,3,4,5" parsed as volume 1-2 AND chapter 3-4
// because the volume match ate only the first pair and the leftover ",3,4,5"
// fell through to the bare-chapter fallback.
eq('Vol 1,2,3,4,5',    { volume: 1,  volumeEnd: 5 });
eq('v17 & 18 & 19',    { volume: 17, volumeEnd: 19 });
eq('v1+2+3',           { volume: 1,  volumeEnd: 3 });
eq('Ch 10-12-14',      { chapter: 10, chapterEnd: 14 });
eq('001-003-005',      { chapter: 1,  chapterEnd: 5 });
// A chained volume run must NOT swallow a following explicit chapter range.
eq('Vol 1-2-3 Ch 5-12', { volume: 1, volumeEnd: 3, chapter: 5, chapterEnd: 12 });

// ── False-positive guards (must NOT parse a range) ───────────────────────────
eq('Yamada-kun',                       {});                       // title hyphen, no digits
eq('2017-2018',                        {});                       // both years → no range, no chapter
eq('My Series (2011-2014) v05',        { volume: 5 });            // year range ignored, volume kept
eq('Ch 5 - The Beginning',             { chapter: 5 });           // "- The" isn't a second number
eq('Vol.1 - Yamada-kun',               { volume: 1 });            // hyphen then non-numeric title
eq('c18-17',                           { chapter: 18 });          // descending → treated as single start
eq('c1-9999',                          { chapter: 1 });           // span over cap → single start

console.log(`chapterParser range tests: ${passed} assertions passed.`);
