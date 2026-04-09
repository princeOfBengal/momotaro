import React, { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { api } from '../api/client';
import './ReaderScroll.css';

const ReaderScroll = forwardRef(function ReaderScroll({ pages, initialPage, onPageChange, zoom, isWebtoon }, ref) {
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
            src={api.pageImageUrl(page.id)}
            alt={`Page ${idx + 1}`}
            className="scroll-page-img"
            loading="lazy"
          />
        </div>
      ))}
    </div>
  );
});

export default ReaderScroll;
