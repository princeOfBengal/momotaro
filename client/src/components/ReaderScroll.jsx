import React, { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { api } from '../api/client';
import { onPageImgError, onPageImgLoad } from './pageImageRetry';
import './ReaderScroll.css';

const ReaderScroll = forwardRef(function ReaderScroll({
  pages,
  initialPage,
  onPageChange,
  zoom,
  isWebtoon,
  // When true, page-image URLs carry `?fast=1` so the server streams pages via
  // the fast-open path instead of blocking each image on a full chapter
  // extraction. Mirrors the reader's "Fast chapter open" setting.
  fast,
  // Backup dim-probe: see ReaderPaged.jsx for the rationale. In scroll mode
  // every visible page hits onLoad as the user scrolls; we patch dims on the
  // way past so Double Page (Manga) is correct even if the user switches
  // layout mid-chapter.
  onPageDimsLearned,
}, ref) {
  const containerRef = useRef(null);
  const imageRefs = useRef([]);
  const scrolledToInitial = useRef(false);

  // Expose scrollToPage so the scrubber can drive the scroll position
  useImperativeHandle(ref, () => ({
    scrollToPage: (idx) => {
      const el = imageRefs.current[idx];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  }));

  // Scroll to initial page on mount
  useEffect(() => {
    if (scrolledToInitial.current) return;
    if (imageRefs.current[initialPage]) {
      imageRefs.current[initialPage].scrollIntoView({ block: 'start' });
      scrolledToInitial.current = true;
    }
  }, [initialPage, pages]);

  // IntersectionObserver: track which page is most visible
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting && entry.intersectionRatio > 0.4) {
            const idx = parseInt(entry.target.dataset.index, 10);
            if (!isNaN(idx)) onPageChange(idx);
          }
        });
      },
      { root: containerRef.current, threshold: 0.4 }
    );

    imageRefs.current.forEach(el => { if (el) observer.observe(el); });
    return () => observer.disconnect();
  }, [pages, onPageChange]);

  return (
    <div ref={containerRef} className={`reader-scroll${isWebtoon ? ' webtoon' : ''}`}>
      {pages.map((page, idx) => (
        <div
          key={page.id}
          ref={el => { imageRefs.current[idx] = el; }}
          data-index={idx}
          className="scroll-page-wrap"
        >
          <img
            src={api.pageImageUrl(page.id, { fast })}
            alt={`Page ${idx + 1}`}
            className="scroll-page-img"
            loading="lazy"
            onLoad={(e) => {
              onPageImgLoad(e.currentTarget);
              if (page.is_wide !== null && page.is_wide !== undefined) return;
              const w = e.target.naturalWidth;
              const h = e.target.naturalHeight;
              if (!w || !h) return;
              onPageDimsLearned?.(page.id, w, h);
            }}
            onError={onPageImgError}
          />
        </div>
      ))}
    </div>
  );
});

export default ReaderScroll;
