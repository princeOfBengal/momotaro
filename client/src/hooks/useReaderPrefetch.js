import { useEffect, useRef } from 'react';
import { api } from '../api/client';

const NEXT_CHAPTER_TRIGGER_DISTANCE = 3;
const NEXT_CHAPTER_PAGES_TO_WARM = 2;
const PREFETCHED_URL_CAP = 200;
// Local-storage flag the Settings → Offline panel writes. Default off so
// existing users don't suddenly start consuming background data.
const LS_PREFETCH_NEXT_OFFLINE = 'momotaro_prefetch_next_offline';

function isMeteredConnection() {
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (!c) return false;
  if (c.saveData === true) return true;
  if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return true;
  return false;
}

function shouldPrefetchNextOffline() {
  try { return localStorage.getItem(LS_PREFETCH_NEXT_OFFLINE) === '1'; }
  catch { return false; }
}

function clamp(i, len) {
  return i >= 0 && i < len ? i : null;
}

function dedupe(indices) {
  const seen = new Set();
  const out = [];
  for (const i of indices) {
    if (i == null) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(i);
  }
  return out;
}

function pagedTargets({ currentPage, pageLayout, mangaSpreads, pages }) {
  const len = pages.length;
  if (len === 0) return [];

  if (pageLayout === 'double-manga' && mangaSpreads) {
    const spreadIdx = mangaSpreads.findIndex(s => s.includes(currentPage));
    if (spreadIdx === -1) return [];
    const next = mangaSpreads[spreadIdx + 1] || [];
    const after = mangaSpreads[spreadIdx + 2] || [];
    const prev = mangaSpreads[spreadIdx - 1] || [];
    return dedupe([...next, ...after, ...prev]);
  }

  if (pageLayout === 'double') {
    return dedupe([
      clamp(currentPage + 2, len),
      clamp(currentPage + 3, len),
      clamp(currentPage + 4, len),
      clamp(currentPage + 5, len),
      clamp(currentPage - 2, len),
    ]);
  }

  return dedupe([
    clamp(currentPage + 1, len),
    clamp(currentPage + 2, len),
    clamp(currentPage - 1, len),
  ]);
}

export function useReaderPrefetch({
  pages,
  currentPage,
  page2Index,
  pageLayout,
  mangaSpreads,
  isPaged,
  allChapters,
  chapterId,
  enabled,
  // Predictive next-chapter pre-extraction. Independent of `enabled` (which
  // controls in-chapter image warm-up). When on, the hook fires a
  // best-effort getPages(next.id) call near end-of-chapter so the server
  // starts extracting the next chapter ahead of the navigation. The first
  // few images of the next chapter are also warmed into the browser cache
  // — both effects happen on the SAME getPages call.
  predictNextChapter = true,
  // When predictNextChapter is on AND fastChapterOpen is on, route the
  // pre-extraction through the fast-mode page-list endpoint so the server
  // returns after Phase 1 (~1–3 s) instead of holding the HTTP connection
  // for the full extraction. Phase 2 keeps running server-side; the
  // actual navigation lands on a cache hit. When fast mode is off, the
  // pre-extraction falls back to the legacy path (synchronous full
  // extract). Default false so the hook's behaviour matches today's prior
  // to the fast-open feature.
  fastChapterOpen = false,
  // Backup dim-probe callback — fires when a prefetched image finishes
  // decoding and the corresponding page row's `is_wide` is still unknown.
  // Each Image() instance gets its own onload that calls back with the
  // real naturalWidth/Height the browser observed. Especially valuable
  // here because the prefetch warms pages 1–5 ahead of the user, so dim
  // corrections arrive BEFORE the user navigates to those pages.
  onPageDimsLearned,
}) {
  const issuedUrls = useRef(new Set());
  const warmedNextChapters = useRef(new Set());

  useEffect(() => {
    if (!enabled) return;
    if (!isPaged) return;
    if (!pages || pages.length === 0) return;
    if (isMeteredConnection()) return;

    const onScreen = new Set([currentPage, page2Index].filter(i => i != null));
    const targets = pagedTargets({ currentPage, pageLayout, mangaSpreads, pages })
      .filter(i => !onScreen.has(i));

    for (const i of targets) {
      const page = pages[i];
      if (!page) continue;
      // Match the displayed images: when fast-open is on, warm via the fast
      // path so these lookahead requests stream too instead of each blocking on
      // a full chapter extraction.
      const url = api.pageImageUrl(page.id, { fast: fastChapterOpen });
      if (issuedUrls.current.has(url)) continue;
      issuedUrls.current.add(url);
      const img = new Image();
      img.decoding = 'async';
      // Capture page so the closure has the right is_wide/id even after
      // the loop moves on. Same dim-probe-on-load pattern as the displayed
      // <img> in ReaderPaged / ReaderScroll. Idempotent thanks to the
      // is_wide guard plus the buffer dedupe in api.reportPageDimensions.
      if (onPageDimsLearned) {
        const pg = page;
        img.onload = () => {
          if (pg.is_wide !== null && pg.is_wide !== undefined) return;
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!w || !h) return;
          onPageDimsLearned(pg.id, w, h);
        };
      }
      img.src = url;
    }

    if (issuedUrls.current.size > PREFETCHED_URL_CAP) {
      const trimmed = Array.from(issuedUrls.current).slice(-PREFETCHED_URL_CAP);
      issuedUrls.current = new Set(trimmed);
    }
  }, [enabled, isPaged, pages, currentPage, page2Index, pageLayout, mangaSpreads, onPageDimsLearned]);

  useEffect(() => {
    // Gated on `predictNextChapter` (the Reading Settings toggle) rather
    // than `enabled`. This effect controls BOTH the server-side pre-extract
    // and the first-page browser-cache warm-up, since the same getPages
    // call powers both. A user who wants in-chapter image prefetch but not
    // next-chapter pre-extract sets `enabled=true` + `predictNextChapter=false`.
    if (!predictNextChapter) return;
    if (!pages || pages.length === 0) return;
    if (!allChapters || allChapters.length === 0) return;
    if (isMeteredConnection()) return;

    if (currentPage < pages.length - NEXT_CHAPTER_TRIGGER_DISTANCE) return;

    const idx = allChapters.findIndex(c => c.id === parseInt(chapterId, 10));
    if (idx === -1) return;
    const next = allChapters[idx + 1];
    if (!next) return;
    if (warmedNextChapters.current.has(next.id)) return;
    warmedNextChapters.current.add(next.id);

    let cancelled = false;
    // Fast mode → server returns after Phase 1 (~1-3 s), Phase 2 continues
    // in the background. Legacy → server blocks until full extract completes
    // before responding (unchanged from pre-feature behaviour).
    const pagesPromise = fastChapterOpen
      ? api.getPagesWithMeta(next.id, { fast: true, prefetch: true })
      : api.getPages(next.id);

    pagesPromise.then(result => {
      if (cancelled) return;
      // getPagesWithMeta returns { data, extracting, total_pages }; the
      // legacy getPages returns the plain array.
      const nextPages = Array.isArray(result) ? result : result?.data;
      if (!Array.isArray(nextPages)) return;
      for (let i = 0; i < Math.min(NEXT_CHAPTER_PAGES_TO_WARM, nextPages.length); i++) {
        const p = nextPages[i];
        if (!p) continue;
        const url = api.pageImageUrl(p.id, { fast: fastChapterOpen });
        if (issuedUrls.current.has(url)) continue;
        issuedUrls.current.add(url);
        const img = new Image();
        img.decoding = 'async';
        // NOTE: the callback here is fired for pages of the NEXT chapter,
        // not the current one. Reader's setPages targets the current
        // chapter's array — so the local-state patch is effectively a
        // no-op for next-chapter pages (they're not in state yet). The
        // server-side report still persists, so when the user opens the
        // next chapter the row already has dims. Both effects are useful
        // independently.
        if (onPageDimsLearned) {
          const pg = p;
          img.onload = () => {
            if (pg.is_wide !== null && pg.is_wide !== undefined) return;
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            if (!w || !h) return;
            onPageDimsLearned(pg.id, w, h);
          };
        }
        img.src = url;
      }
    }).catch(() => {});

    // P3: when the user has the offline-prefetch setting enabled AND
    // we're online + Wi-Fi-only-eligible, also enqueue the next chapter
    // for full offline download. The downloader is idempotent — already-
    // downloaded chapters short-circuit, and the Wi-Fi-only gate inside
    // setNetworkAllowed pauses cellular pulls without needing a separate
    // check here. The chapter id is deduped via the same
    // `warmedNextChapters` set so we don't queue it twice per session.
    if (shouldPrefetchNextOffline()) {
      // Lazy import so the downloader module isn't pulled into the Reader
      // chunk on devices that never enable the setting.
      import('../api/downloader').then(({ queueChapter }) => {
        if (cancelled) return;
        // mangaId comes from the chapter row on the server side; the
        // reader passes it through allChapters consistently.
        const mangaId = next.manga_id || allChapters[idx]?.manga_id;
        if (!mangaId) return;
        queueChapter(mangaId, next.id).catch(() => { /* best-effort */ });
      }).catch(() => { /* downloader unavailable on PWA — fine */ });
    }

    return () => { cancelled = true; };
  }, [predictNextChapter, fastChapterOpen, pages, currentPage, allChapters, chapterId, onPageDimsLearned]);

  useEffect(() => {
    issuedUrls.current = new Set();
    warmedNextChapters.current = new Set();
  }, [chapterId]);
}
