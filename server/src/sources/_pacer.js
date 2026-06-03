// Per-adapter rate-limit pacer.
//
// Each source adapter targets a different upstream site, so each gets its own
// independent pacer instance — `createPacer(intervalMs)` returns an object
// whose `wait()` ensures at least `intervalMs` has elapsed since the previous
// call within that pacer.
//
// Extracted from the inline `_lastRequestAt` + setTimeout pattern that was
// duplicated across every adapter. Each adapter still owns its own request
// wrapper (headers, parsing, error format vary per site) — only the pacing
// primitive is shared.

function createPacer(intervalMs) {
  let lastRequestAt = 0;
  return {
    async wait() {
      const remaining = intervalMs - (Date.now() - lastRequestAt);
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      lastRequestAt = Date.now();
    },
  };
}

module.exports = { createPacer };
