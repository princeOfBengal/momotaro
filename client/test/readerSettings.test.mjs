/**
 * Regression test for the reader-preference migration helpers in
 * client/src/hooks/readerSettings.js — the framework-free module that
 * useReaderSettings.js (consumed by both Reader.jsx and ReadingSection.jsx)
 * drives its initial values off. Both surfaces previously carried verbatim
 * copies of this logic; the test pins the migration invariants so the single
 * shared copy can't regress.
 *
 * No DOM / React needed:
 *   node client/test/readerSettings.test.mjs
 */

import assert from 'node:assert';
import {
  resolveInitialPageAnimation,
  clampAnimSpeed,
  resolveInitialPredictNextChapter,
} from '../src/hooks/readerSettings.js';

// Faithful stand-in for the component's localStorage usage.
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

// ── 1. resolveInitialPageAnimation — valid values pass through. ──────────────
{
  for (const v of ['off', 'slide', 'fade', 'curl']) {
    assert.equal(resolveInitialPageAnimation(fakeStorage({ reader_pageAnimation: v })), v, `${v} passes through`);
  }
  console.log('readerSettings.test: pageAnimation valid passthrough  ✓');
}

// ── 2. resolveInitialPageAnimation — legacy boolean migration. ───────────────
{
  assert.equal(resolveInitialPageAnimation(fakeStorage({ reader_animTrans: 'true' })),  'slide', 'legacy true → slide');
  assert.equal(resolveInitialPageAnimation(fakeStorage({ reader_animTrans: 'false' })), 'off',   'legacy false → off');
  // Unset everything → default slide.
  assert.equal(resolveInitialPageAnimation(fakeStorage()), 'slide', 'unset → slide');
  // A garbage stored value (not one of the four) falls through to legacy/default.
  assert.equal(resolveInitialPageAnimation(fakeStorage({ reader_pageAnimation: 'bogus' })), 'slide', 'invalid → default');
  assert.equal(resolveInitialPageAnimation(fakeStorage({ reader_pageAnimation: 'bogus', reader_animTrans: 'false' })), 'off', 'invalid stored falls back to legacy');
  console.log('readerSettings.test: pageAnimation legacy migration  ✓');
}

// ── 3. clampAnimSpeed — bounds + non-finite. ─────────────────────────────────
{
  assert.equal(clampAnimSpeed(NaN), 1, 'NaN → 1');
  assert.equal(clampAnimSpeed(Infinity), 1, 'Infinity → 1');
  assert.equal(clampAnimSpeed(0), 0.5, 'below min clamps to 0.5');
  assert.equal(clampAnimSpeed(0.5), 0.5, 'min passes');
  assert.equal(clampAnimSpeed(1.25), 1.25, 'in-range passes');
  assert.equal(clampAnimSpeed(2), 2, 'max passes');
  assert.equal(clampAnimSpeed(5), 2, 'above max clamps to 2');
  console.log('readerSettings.test: clampAnimSpeed bounds  ✓');
}

// ── 4. resolveInitialPredictNextChapter — explicit value wins. ───────────────
{
  assert.equal(resolveInitialPredictNextChapter(fakeStorage({ reader_predictNextChapter: 'true' })),  true,  'explicit true');
  assert.equal(resolveInitialPredictNextChapter(fakeStorage({ reader_predictNextChapter: 'false' })), false, 'explicit false');
  console.log('readerSettings.test: predictNextChapter explicit value  ✓');
}

// ── 5. resolveInitialPredictNextChapter — inherits prefetch + writes back. ───
{
  // Unset → inherits reader_prefetchPages (default-on when also unset).
  const s1 = fakeStorage();
  assert.equal(resolveInitialPredictNextChapter(s1), true, 'unset inherits default-on prefetch');
  assert.equal(s1._dump().reader_predictNextChapter, 'true', 'resolved value written back');

  // prefetch explicitly off → inherit off.
  const s2 = fakeStorage({ reader_prefetchPages: 'false' });
  assert.equal(resolveInitialPredictNextChapter(s2), false, 'inherits prefetch off');
  assert.equal(s2._dump().reader_predictNextChapter, 'false', 'inherited-off value written back');
  console.log('readerSettings.test: predictNextChapter inherit + write-back  ✓');
}

console.log('readerSettings.test: ALL PASSED');
