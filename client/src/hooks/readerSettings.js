// Framework-free reader-preference helpers. Reader.jsx and ReadingSection.jsx
// previously each declared the full set of reader_* localStorage settings
// independently (identical keys, defaults, parsing, one persist effect apiece)
// plus a verbatim copy of these three migration helpers — with comments openly
// asking the two to be kept in sync by hand. The logic lives here now, and
// useReaderSettings.js drives the React state/persistence off it.
//
// These take the storage object explicitly so the regression test can inject a
// fake (mirrors libraryPagination.js); useReaderSettings passes localStorage.

// Resolve the page-transition style. Migrates the legacy boolean key
// `reader_animTrans` (true → 'slide', false → 'off') the first time it's read.
export function resolveInitialPageAnimation(storage) {
  const stored = storage.getItem('reader_pageAnimation');
  if (stored === 'off' || stored === 'slide' || stored === 'fade' || stored === 'curl') return stored;
  const legacy = storage.getItem('reader_animTrans');
  if (legacy === 'true')  return 'slide';
  if (legacy === 'false') return 'off';
  return 'slide';
}

export function clampAnimSpeed(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, n));
}

// Initial value for `reader_predictNextChapter`. If the user hasn't set it
// yet, fall back to whatever `reader_prefetchPages` is — that's the setting
// that implicitly gated next-chapter prefetch before this feature shipped.
// This preserves today's behaviour for upgrade: a user who turned image
// prefetch off doesn't suddenly start getting next-chapter pre-extraction
// requests; a user with the default on stays in the same state. We write
// the resolved value back to storage so subsequent reads (and the Settings
// page) see a concrete value rather than re-running the migration after the
// user later flips `prefetchPages`.
export function resolveInitialPredictNextChapter(storage) {
  const stored = storage.getItem('reader_predictNextChapter');
  if (stored !== null) return stored !== 'false';
  const inherited = storage.getItem('reader_prefetchPages') !== 'false';
  try { storage.setItem('reader_predictNextChapter', String(inherited)); }
  catch { /* private browsing — fine */ }
  return inherited;
}
