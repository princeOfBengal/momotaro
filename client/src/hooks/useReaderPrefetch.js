import { useEffect, useRef } from 'react';
import { api } from '../api/client';

const NEXT_CHAPTER_TRIGGER_DISTANCE = 3;
const NEXT_CHAPTER_PAGES_TO_WARM = 2;
const PREFETCHED_URL_CAP = 200;

function isMeteredConnection() {
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (!c) return false;
  if (c.saveData === true) return true;
  if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return true;
  return false;
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
      const url = api.pageImageUrl(page.id);
      if (issuedUrls.current.has(url)) continue;
      issuedUrls.current.add(url);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    }

    if (issuedUrls.current.size > PREFETCHED_URL_CAP) {
      const trimmed = Array.from(issuedUrls.current).slice(-PREFETCHED_URL_CAP);
      issuedUrls.current = new Set(trimmed);
    }
  }, [enabled, isPaged, pages, currentPage, page2Index, pageLayout, mangaSpreads]);

  useEffect(() => {
    if (!enabled) return;
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
    api.getPages(next.id).then(nextPages => {
      if (cancelled) return;
      if (!Array.isArray(nextPages)) return;
      for (let i = 0; i < Math.min(NEXT_CHAPTER_PAGES_TO_WARM, nextPages.length); i++) {
        const p = nextPages[i];
        if (!p) continue;
        const url = api.pageImageUrl(p.id);
        if (issuedUrls.current.has(url)) continue;
        issuedUrls.current.add(url);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [enabled, pages, currentPage, allChapters, chapterId]);

  useEffect(() => {
    issuedUrls.current = new Set();
    warmedNextChapters.current = new Set();
  }, [chapterId]);
}
