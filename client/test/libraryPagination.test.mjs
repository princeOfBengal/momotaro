/**
 * Regression test for the Library grid's cursor-pagination + scroll-depth
 * helpers in client/src/pages/libraryPagination.js — the module Library.jsx
 * imports, so this exercises the real code path (no copy).
 *
 * Focus: the in-place sort-switch rehydration bug (Bug 1). When the user
 * switches sort/library after a deep scroll, React re-runs the persist effect
 * with the *new* view key while `manga` still holds the *old* view's data
 * (load() hasn't swapped it yet). The earlier code wrote the old depth under
 * the new key, and load() then rehydrated the new view to that bogus depth.
 * `shouldPersistDepth` must refuse that write. Also covers the H2 de-dupe.
 *
 * No DOM / React needed — run in the project runtime:
 *   node client/test/libraryPagination.test.mjs
 */

import assert from 'node:assert';
import {
  browseCountKey,
  appendUnique,
  shouldPersistDepth,
  rehydrateTarget,
  getSnapshot,
  putSnapshot,
  SNAPSHOT_CACHE_MAX,
} from '../src/pages/libraryPagination.js';

// A faithful stand-in for the component's sessionStorage usage.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _dump: () => Object.fromEntries(m),
  };
}

// Replay one persist-effect tick exactly as Library.jsx wires it: write the
// current depth under `currentKey` *iff* shouldPersistDepth allows.
function persistTick(storage, { loading, activeList, length, loadedKey, currentKey }) {
  if (shouldPersistDepth({ loading, activeList, length, loadedKey, currentKey })) {
    storage.setItem(currentKey, length);
  }
}

// ── 1. Bug 1: in-place sort switch must not pollute the new sort's depth. ────
{
  const storage = fakeStorage();
  const LOC = 'k1';
  const ratingKey = browseCountKey(LOC, null, null, 'rating');
  const titleKey  = browseCountKey(LOC, null, null, 'title');
  assert.notEqual(ratingKey, titleKey, 'distinct keys per sort');

  // User deep-scrolls the rating view to 1000 items. load() stamped loadedKey
  // to ratingKey, so the persist effect is allowed to record the depth.
  persistTick(storage, { loading: false, activeList: null, length: 1000, loadedKey: ratingKey, currentKey: ratingKey });
  assert.equal(storage.getItem(ratingKey), '1000', 'rating depth persisted');

  // Now the user switches sort rating → title. React recomputes currentKey to
  // titleKey and re-runs the persist effect BEFORE load() swaps the data:
  //   loading=false, manga still the 1000 rating rows, loadedKey still rating.
  persistTick(storage, { loading: false, activeList: null, length: 1000, loadedKey: ratingKey, currentKey: titleKey });
  assert.equal(storage.getItem(titleKey), null, 'BUG1: title depth NOT polluted by the rating view');

  // Therefore load() for title rehydrates to the true title depth (0 → page 1
  // only), not 1000.
  assert.equal(rehydrateTarget(storage.getItem(titleKey)), 0, 'title rehydrates fresh, not to 1000');

  // After load() settles for title (200 rows) it stamps loadedKey=titleKey;
  // now the persist effect may record the correct title depth.
  persistTick(storage, { loading: false, activeList: null, length: 200, loadedKey: titleKey, currentKey: titleKey });
  assert.equal(storage.getItem(titleKey), '200', 'title depth persisted once data belongs to the key');
  // And the rating depth the user built up earlier is preserved for a return.
  assert.equal(rehydrateTarget(storage.getItem(ratingKey)), 1000, 'rating depth survives for back-to-rating');

  console.log('libraryPagination.test: Bug 1 — in-place sort switch does not pollute / over-rehydrate  ✓');
}

// ── 2. shouldPersistDepth guard conditions. ─────────────────────────────────
{
  const k = browseCountKey('k', null, null, 'year');
  assert.equal(shouldPersistDepth({ loading: true,  activeList: null, length: 5, loadedKey: k, currentKey: k }), false, 'no write mid-refetch');
  assert.equal(shouldPersistDepth({ loading: false, activeList: 3,    length: 5, loadedKey: k, currentKey: k }), false, 'no write in reading-list mode');
  assert.equal(shouldPersistDepth({ loading: false, activeList: null, length: 0, loadedKey: k, currentKey: k }), false, 'no write with empty grid');
  assert.equal(shouldPersistDepth({ loading: false, activeList: null, length: 5, loadedKey: 'other', currentKey: k }), false, 'no write under a mismatched key');
  assert.equal(shouldPersistDepth({ loading: false, activeList: null, length: 5, loadedKey: k, currentKey: k }), true,  'writes when data belongs to the live key');
  console.log('libraryPagination.test: shouldPersistDepth guard conditions  ✓');
}

// ── 3. browseCountKey distinctness across the filter tuple. ──────────────────
{
  const keys = new Set([
    browseCountKey('k', null, null, 'title'),
    browseCountKey('k', null, null, 'rating'),
    browseCountKey('k', 7,    null, 'title'),
    browseCountKey('k', null, 2,    'title'),
    browseCountKey('k2', null, null, 'title'),
  ]);
  assert.equal(keys.size, 5, 'each (history-entry, library, list, sort) tuple gets a distinct key');
  console.log('libraryPagination.test: browseCountKey distinctness  ✓');
}

// ── 4. H2 — appendUnique drops ids already present, preserves order. ─────────
{
  const prev = [{ id: 1 }, { id: 2 }, { id: 3 }];
  // A row (id:3) shifted across the cursor boundary re-appears on the next page.
  const next = [{ id: 3 }, { id: 4 }, { id: 5 }];
  const merged = appendUnique(prev, next);
  assert.deepEqual(merged.map(m => m.id), [1, 2, 3, 4, 5], 'duplicate id:3 dropped, order kept');
  // Fast path: no overlap returns a plain concat.
  assert.deepEqual(appendUnique(prev, [{ id: 6 }]).map(m => m.id), [1, 2, 3, 6], 'no-overlap concat');
  // Empty incoming is a no-op copy.
  assert.deepEqual(appendUnique(prev, []).map(m => m.id), [1, 2, 3], 'empty incoming');
  console.log('libraryPagination.test: H2 appendUnique de-dupe  ✓');
}

// ── 5. rehydrateTarget parsing. ─────────────────────────────────────────────
{
  assert.equal(rehydrateTarget(null), 0, 'missing → 0');
  assert.equal(rehydrateTarget('0'), 0, 'zero → 0');
  assert.equal(rehydrateTarget('-5'), 0, 'negative → 0');
  assert.equal(rehydrateTarget('abc'), 0, 'garbage → 0');
  assert.equal(rehydrateTarget('1000'), 1000, 'valid count');
  console.log('libraryPagination.test: rehydrateTarget parsing  ✓');
}

// ── 6. Browse snapshots — store/get round-trip + miss. ───────────────────────
{
  const cache = new Map();
  const k = browseCountKey('k', null, null, 'title');
  assert.equal(getSnapshot(cache, k), null, 'miss returns null');

  const snap = { rows: [{ id: 1 }, { id: 2 }], cursor: 'c1', hasMore: true, ts: 100 };
  putSnapshot(cache, k, snap);
  const got = getSnapshot(cache, k);
  assert.strictEqual(got, snap, 'get returns the exact stored snapshot (reference)');
  assert.deepEqual(got.rows.map(r => r.id), [1, 2], 'rows survive round-trip');
  assert.equal(got.cursor, 'c1', 'cursor survives round-trip');
  assert.equal(got.hasMore, true, 'hasMore survives round-trip');

  // Re-store under the same key replaces in place (no duplicate entry).
  putSnapshot(cache, k, { ...snap, cursor: 'c2' });
  assert.equal(cache.size, 1, 're-store under same key does not grow the cache');
  assert.equal(getSnapshot(cache, k).cursor, 'c2', 're-store overwrites');
  console.log('libraryPagination.test: snapshot store/get round-trip + miss  ✓');
}

// ── 7. Browse snapshots — bounded LRU eviction past the cap. ─────────────────
{
  const cache = new Map();
  const max = 3;
  const mk = n => `key${n}`;
  for (let n = 0; n < max; n++) putSnapshot(cache, mk(n), { rows: [], cursor: null, hasMore: false, ts: n }, max);
  assert.equal(cache.size, max, 'cache fills to cap');

  // Inserting one more evicts the oldest (key0).
  putSnapshot(cache, mk(99), { rows: [], cursor: null, hasMore: false, ts: 99 }, max);
  assert.equal(cache.size, max, 'cache stays at cap after overflow');
  assert.equal(getSnapshot(cache, mk(0)), null, 'oldest entry (key0) evicted');
  assert.ok(getSnapshot(cache, mk(99)), 'newest entry retained');

  // A get refreshes LRU order: touch key1, then overflow — key2 (now oldest) goes.
  getSnapshot(cache, mk(1));
  putSnapshot(cache, mk(100), { rows: [], cursor: null, hasMore: false, ts: 100 }, max);
  assert.ok(getSnapshot(cache, mk(1)), 'touched key1 survives eviction');
  assert.equal(getSnapshot(cache, mk(2)), null, 'untouched key2 (now oldest) evicted');
  console.log('libraryPagination.test: snapshot LRU eviction + touch-on-get  ✓');
}

// ── 8. SNAPSHOT_CACHE_MAX default is a sane positive cap. ────────────────────
{
  assert.ok(Number.isInteger(SNAPSHOT_CACHE_MAX) && SNAPSHOT_CACHE_MAX > 0, 'cap is a positive integer');
  const cache = new Map();
  for (let n = 0; n < SNAPSHOT_CACHE_MAX + 5; n++) {
    putSnapshot(cache, `d${n}`, { rows: [], cursor: null, hasMore: false, ts: n });
  }
  assert.equal(cache.size, SNAPSHOT_CACHE_MAX, 'default cap applied when max omitted');
  console.log('libraryPagination.test: SNAPSHOT_CACHE_MAX default cap  ✓');
}

console.log('libraryPagination.test: ALL PASSED');
