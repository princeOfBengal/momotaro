// Pure, framework-free helpers for the Library grid's cursor pagination and
// scroll-depth rehydration. Extracted from Library.jsx so the invariants that
// caused real bugs can be unit-tested without a full React render harness:
//
//   - H2: a row shifted across the cursor boundary by a concurrent metadata
//     change must not be appended twice (duplicate React keys).
//   - Bug 1: an in-place sort/library switch changes the view key *before*
//     load() swaps the data; we must not persist the previous view's loaded
//     depth under the new key, or load() would rehydrate the new view to that
//     bogus depth.
//
// Library.jsx imports these directly, so the regression test exercises the
// real code path, not a copy.

// The sessionStorage key identifying one browse view: a history entry + the
// library/list/sort filter tuple. Mirrors the browse `scrollKey` suffix so the
// persisted depth and the restored scroll position always agree on "this view".
export function browseCountKey(locationKey, activeLibrary, activeList, sort, seek = '') {
  return `library-count:${locationKey || 'default'}|lib:${activeLibrary ?? ''}|list:${activeList ?? ''}|sort:${sort}|seek:${seek || ''}`;
}

// Append a page of rows, dropping any whose id is already present (H2).
export function appendUnique(prev, incoming) {
  const seen = new Set(prev.map(m => m.id));
  const fresh = incoming.filter(m => !seen.has(m.id));
  return fresh.length === incoming.length ? [...prev, ...incoming] : [...prev, ...fresh];
}

// Decide whether the persist effect may write the current loaded depth under
// `currentKey` (Bug 1 guard). Only when the data actually belongs to that key.
export function shouldPersistDepth({ loading, activeList, length, loadedKey, currentKey }) {
  if (loading) return false;          // mid-refetch — depth not settled
  if (activeList !== null) return false; // reading-list path loads everything
  if (!length) return false;          // nothing loaded yet
  return loadedKey === currentKey;    // data corresponds to this exact view
}

// Parse a persisted depth back to a rehydration target (non-negative int).
export function rehydrateTarget(raw) {
  const n = parseInt(raw || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── In-session browse snapshots ─────────────────────────────────────────────
//
// Back-from-detail in this SPA is a component remount, not a page reload, and
// location.key is stable across the round-trip (the same property browseCountKey
// and useScrollPosition already rely on). So a module-level Map of settled
// browse state survives exactly the navigation we want to restore — with zero
// serialization and zero network. The old approach refetched up to 60 cursor
// pages serially to rebuild the virtualizer's height before revealing the grid;
// a snapshot hit makes that instant. A full reload clears the Map, but reload
// also mints a fresh location.key so the saved depth wouldn't match anyway.
//
// A snapshot is `{ rows, cursor, hasMore }` — everything load() needs to put the
// grid back exactly as it was, including the cursor so onEndReached keeps paging
// seamlessly from where the user left off. The cache is a bounded insertion-order
// LRU (mirrors the server listing cache) because each entry can hold thousands
// of slim rows; only the few most-recently-visited views need restoring.
//
// These operate on a caller-supplied Map so they stay pure + unit-testable; the
// live Map is module-scoped in Library.jsx.

export const SNAPSHOT_CACHE_MAX = 6;

export function getSnapshot(cache, key) {
  const snap = cache.get(key);
  if (!snap) return null;
  // Refresh insertion order so this key is now most-recent (LRU touch).
  cache.delete(key);
  cache.set(key, snap);
  return snap;
}

export function putSnapshot(cache, key, snapshot, max = SNAPSHOT_CACHE_MAX) {
  // Re-insert at the end so an update also refreshes LRU order.
  cache.delete(key);
  cache.set(key, snapshot);
  while (cache.size > max) {
    // Map iterates in insertion order — first key is the oldest.
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
