// Seeded PRNG + deterministic shuffle shared by Home (Discover / genre ribbons)
// and MangaDetail (Discover Similar Manga daily rotation). Same seed → same
// order, so callers derive a seed (per-mount, per-day, per-genre, …) to control
// when the order changes.

// mulberry32 — tiny, fast 32-bit seeded PRNG returning floats in [0, 1).
export function mulberry32(seed) {
  let state = seed | 0;
  return function () {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates over a copy (never mutates the input), driven by a seeded PRNG.
export function shuffleWithSeed(items, seed) {
  const rng = mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
