import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import ReaderPaged from '../components/ReaderPaged';
import ReaderScroll from '../components/ReaderScroll';
import ReaderControls from '../components/ReaderControls';
import './Reader.css';

const PROGRESS_DEBOUNCE_MS = 2000;

export default function Reader() {
  const { chapterId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const mangaId = searchParams.get('mangaId');

  const [chapter, setChapter] = useState(null);
  const [pages, setPages] = useState([]);
  const [manga, setManga] = useState(null);
  const [allChapters, setAllChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Reader settings — persisted to localStorage
  const [readingMode, setReadingMode] = useState(() => localStorage.getItem('reader_readingMode') || 'rtl');
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem('reader_zoom')) || 100);
  const [animateTransitions, setAnimateTransitions] = useState(() => localStorage.getItem('reader_animTrans') === 'true');
  const [gesturesEnabled, setGesturesEnabled] = useState(() => localStorage.getItem('reader_gestures') !== 'false');
  const [alwaysFullscreen, setAlwaysFullscreen] = useState(() => localStorage.getItem('reader_alwaysFS') === 'true');
  const [bgColor, setBgColor] = useState(() => localStorage.getItem('reader_bgColor') || 'black');
  const [grayscale, setGrayscale] = useState(() => localStorage.getItem('reader_grayscale') === 'true');
  const [scaleType, setScaleType] = useState(() => localStorage.getItem('reader_scaleType') || 'screen');
  const [pageLayout, setPageLayout] = useState(() => localStorage.getItem('reader_pageLayout') || 'single');
  const [readingOrientation, setReadingOrientation] = useState(() => localStorage.getItem('reader_orientation') || 'ltr');
  const [brightness, setBrightness] = useState(() => Number(localStorage.getItem('reader_brightness')) || 100);

  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const [animDir, setAnimDir] = useState('next');
  const [currentPage, setCurrentPage] = useState(() => parseInt(searchParams.get('page') || '0', 10));

  const progressTimer = useRef(null);
  const controlsTimer = useRef(null);
  const scrubActiveRef = useRef(false);
  const scrollerRef = useRef(null);
  const containerRef = useRef(null);

  // Derived
  const isPaged = readingMode === 'ltr' || readingMode === 'rtl';
  const isRtl = readingMode === 'rtl';
  const isWebtoon = readingMode === 'webtoon';

  // Spread map for Double Page (Manga): array of [pageIdx] or [pageIdx, pageIdx+1]
  // Page 0 is always solo (title/cover). Wide pages are always solo.
  // After any solo page, the next normal page starts a fresh pair.
  const mangaSpreads = useMemo(() => {
    if (!isPaged || pageLayout !== 'double-manga' || pages.length === 0) return null;
    const spreads = [];
    let i = 0;
    while (i < pages.length) {
      const isCover = i === 0;
      const isWide = pages[i]?.is_wide; // null treated as false (unknown = assume normal)
      if (isCover || isWide) {
        spreads.push([i]);
        i++;
      } else if (i + 1 < pages.length && !pages[i + 1]?.is_wide) {
        spreads.push([i, i + 1]);
        i += 2;
      } else {
        // Last page, or next page is wide — stay solo
        spreads.push([i]);
        i++;
      }
    }
    return spreads;
  }, [pages, isPaged, pageLayout]);

  // Given a raw page index, return the anchor (first page) of its spread
  const getSpreadAnchor = useCallback((page) => {
    if (!mangaSpreads) return page;
    const spread = mangaSpreads.find(s => s.includes(page));
    return spread ? spread[0] : page;
  }, [mangaSpreads]);

  // The second page to show alongside currentPage (null = show solo)
  const page2Index = useMemo(() => {
    if (!isPaged) return null;
    if (pageLayout === 'double') {
      return currentPage + 1 < pages.length ? currentPage + 1 : null;
    }
    if (pageLayout === 'double-manga' && mangaSpreads) {
      const spread = mangaSpreads.find(s => s[0] === currentPage);
      return spread && spread.length > 1 ? spread[1] : null;
    }
    return null;
  }, [isPaged, pageLayout, currentPage, pages.length, mangaSpreads]);

  // Persist settings
  useEffect(() => { localStorage.setItem('reader_readingMode', readingMode); }, [readingMode]);
  useEffect(() => { localStorage.setItem('reader_zoom', zoom); }, [zoom]);
  useEffect(() => { localStorage.setItem('reader_animTrans', animateTransitions); }, [animateTransitions]);
  useEffect(() => { localStorage.setItem('reader_gestures', gesturesEnabled); }, [gesturesEnabled]);
  useEffect(() => { localStorage.setItem('reader_alwaysFS', alwaysFullscreen); }, [alwaysFullscreen]);
  useEffect(() => { localStorage.setItem('reader_bgColor', bgColor); }, [bgColor]);
  useEffect(() => { localStorage.setItem('reader_grayscale', grayscale); }, [grayscale]);
  useEffect(() => { localStorage.setItem('reader_scaleType', scaleType); }, [scaleType]);
  useEffect(() => { localStorage.setItem('reader_pageLayout', pageLayout); }, [pageLayout]);
  useEffect(() => { localStorage.setItem('reader_orientation', readingOrientation); }, [readingOrientation]);
  useEffect(() => { localStorage.setItem('reader_brightness', brightness); }, [brightness]);

  // Fullscreen
  useEffect(() => {
    function onFsChange() { setIsFullscreen(!!document.fullscreenElement); }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    if (alwaysFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, [alwaysFullscreen]);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // Keep focus on container so arrow keys work
  useEffect(() => { containerRef.current?.focus(); }, []);

  // Load chapter data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getChapter(chapterId),
      api.getPages(chapterId),
    ]).then(([ch, pgs]) => {
      if (cancelled) return;
      setChapter(ch);
      setPages(pgs);
      setLoading(false);
    }).catch(err => {
      if (!cancelled) { setError(err.message); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [chapterId]);

  // Load manga + sibling chapters
  useEffect(() => {
    if (!mangaId) return;
    Promise.all([
      api.getManga(mangaId),
      api.getChapters(mangaId),
    ]).then(([m, chs]) => {
      setManga(m);
      setAllChapters(chs.sort((a, b) => {
        const aKey = a.number ?? a.volume;
        const bKey = b.number ?? b.volume;
        if (aKey === null && bKey === null) return 0;
        if (aKey === null) return 1;
        if (bKey === null) return -1;
        return aKey - bKey;
      }));
    }).catch(() => {});
  }, [mangaId]);

  // Sync current page to URL
  useEffect(() => {
    setSearchParams(prev => {
      prev.set('page', String(currentPage));
      return prev;
    }, { replace: true });
  }, [currentPage]);

  // Save progress
  const saveProgress = useCallback((page, completed = false) => {
    if (!mangaId) return;
    clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => {
      api.updateProgress(mangaId, {
        chapterId: parseInt(chapterId, 10),
        page,
        markChapterComplete: completed,
      }).catch(() => {});
    }, PROGRESS_DEBOUNCE_MS);
  }, [mangaId, chapterId]);

  // Show controls and (re)start the auto-hide timer.
  const showControlsAndReset = useCallback(() => {
    setShowControls(true);
    clearTimeout(controlsTimer.current);
    if (isPaged && !scrubActiveRef.current) {
      controlsTimer.current = setTimeout(() => setShowControls(false), 3000);
    }
  }, [isPaged]);

  // Toggle: center tap shows if hidden, hides if visible.
  const handleToggleControls = useCallback(() => {
    setShowControls(prev => {
      clearTimeout(controlsTimer.current);
      if (prev) return false;
      if (isPaged && !scrubActiveRef.current) {
        controlsTimer.current = setTimeout(() => setShowControls(false), 3000);
      }
      return true;
    });
  }, [isPaged]);

  // Center tap: close settings if open, otherwise toggle controls.
  const handleCenterTap = useCallback(() => {
    if (showSettings) { setShowSettings(false); return; }
    handleToggleControls();
  }, [showSettings, handleToggleControls]);

  // Mouse movement auto-shows controls (desktop only).
  // Touch/pen interactions must not trigger this — mobile browsers fire
  // synthetic mousemove compatibility events on every tap, which would
  // show controls on side taps and cancel out center taps.
  // Filtering to pointerType === 'mouse' isolates real mouse movement.
  useEffect(() => {
    function onPointerMove(e) {
      if (e.pointerType === 'mouse') showControlsAndReset();
    }
    window.addEventListener('pointermove', onPointerMove);
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [showControlsAndReset]);

  // Keyboard navigation
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        isRtl ? prevPage() : nextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        isRtl ? nextPage() : prevPage();
      } else if (e.key === 'Escape') {
        if (showSettings) { setShowSettings(false); return; }
        if (mangaId) navigate(`/manga/${mangaId}`);
        else navigate('/');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function nextPage() {
    if (mangaSpreads) {
      const spreadIdx = mangaSpreads.findIndex(s => s.includes(currentPage));
      if (spreadIdx === -1 || spreadIdx >= mangaSpreads.length - 1) {
        saveProgress(pages.length - 1, true);
        return;
      }
      const next = mangaSpreads[spreadIdx + 1][0];
      setAnimDir('next');
      setAnimKey(k => k + 1);
      setCurrentPage(next);
      saveProgress(next);
      return;
    }
    const step = isPaged && pageLayout === 'double' ? 2 : 1;
    const next = currentPage + step;
    if (next >= pages.length) { saveProgress(pages.length - 1, true); return; }
    setAnimDir('next');
    setAnimKey(k => k + 1);
    setCurrentPage(next);
    saveProgress(next);
  }

  function prevPage() {
    if (mangaSpreads) {
      const spreadIdx = mangaSpreads.findIndex(s => s.includes(currentPage));
      if (spreadIdx <= 0) return;
      const prev = mangaSpreads[spreadIdx - 1][0];
      setAnimDir('prev');
      setAnimKey(k => k + 1);
      setCurrentPage(prev);
      saveProgress(prev);
      return;
    }
    const step = isPaged && pageLayout === 'double' ? 2 : 1;
    const prev = Math.max(0, currentPage - step);
    setAnimDir('prev');
    setAnimKey(k => k + 1);
    setCurrentPage(prev);
    saveProgress(prev);
  }

  function handlePageChange(page, fromScrubber = false) {
    // Snap to spread anchor in double-manga mode
    const snapped = getSpreadAnchor(page);
    setAnimDir(snapped > currentPage ? 'next' : 'prev');
    setAnimKey(k => k + 1);
    setCurrentPage(snapped);
    if (fromScrubber && !isPaged && scrollerRef.current) {
      scrollerRef.current.scrollToPage(snapped);
    }
    saveProgress(snapped, snapped >= pages.length - 1);
  }

  function handleScrubStart() {
    scrubActiveRef.current = true;
    clearTimeout(controlsTimer.current);
  }

  function handleScrubEnd() {
    scrubActiveRef.current = false;
    showControlsAndReset();
    containerRef.current?.focus();
  }

  function navigateChapter(delta) {
    if (!allChapters.length) return;
    const idx = allChapters.findIndex(c => c.id === parseInt(chapterId, 10));
    if (idx === -1) return;
    const target = allChapters[idx + delta];
    if (target) {
      setCurrentPage(0);
      navigate(`/read/${target.id}?mangaId=${mangaId}&page=0`);
    }
  }

  const chapterIdx = allChapters.findIndex(c => c.id === parseInt(chapterId, 10));
  const hasPrevChapter = chapterIdx > 0;
  const hasNextChapter = chapterIdx < allChapters.length - 1;

  if (loading) return (
    <div className="reader-loading">
      <div className="spinner" />
      <p>Loading chapter...</p>
    </div>
  );

  if (error) return (
    <div className="reader-loading">
      <h2>Failed to load chapter</h2>
      <p>{error}</p>
      <Link to={mangaId ? `/manga/${mangaId}` : '/'} className="btn btn-primary" style={{ marginTop: 16 }}>
        Go Back
      </Link>
    </div>
  );

  const controls = (
    <ReaderControls
      show={showControls}
      chapter={chapter}
      manga={manga}
      currentPage={currentPage}
      totalPages={pages.length}
      readingMode={readingMode}
      zoom={zoom}
      animateTransitions={animateTransitions}
      gesturesEnabled={gesturesEnabled}
      alwaysFullscreen={alwaysFullscreen}
      bgColor={bgColor}
      grayscale={grayscale}
      brightness={brightness}
      scaleType={scaleType}
      pageLayout={pageLayout}
      showSettings={showSettings}
      hasPrevChapter={hasPrevChapter}
      hasNextChapter={hasNextChapter}
      mangaId={mangaId}
      isFullscreen={isFullscreen}
      onReadingModeChange={setReadingMode}
      onZoomChange={setZoom}
      onAnimateTransitionsChange={setAnimateTransitions}
      onGesturesChange={setGesturesEnabled}
      onAlwaysFullscreenChange={setAlwaysFullscreen}
      onBgColorChange={setBgColor}
      onGrayscaleChange={setGrayscale}
      onBrightnessChange={setBrightness}
      onScaleTypeChange={setScaleType}
      onPageLayoutChange={setPageLayout}
      readingOrientation={readingOrientation}
      onReadingOrientationChange={setReadingOrientation}
      onSetPageAsThumbnail={async () => {
        const page = pages[currentPage];
        if (!mangaId || !page) throw new Error('No page');
        await api.setPageAsThumbnail(mangaId, page.id);
      }}
      onToggleSettings={() => setShowSettings(s => !s)}
      onToggleFullscreen={toggleFullscreen}
      onPrevChapter={() => navigateChapter(-1)}
      onNextChapter={() => navigateChapter(1)}
      onPageChange={page => handlePageChange(page, true)}
      onScrubStart={handleScrubStart}
      onScrubEnd={handleScrubEnd}
    />
  );

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={[
        'reader-page',
        showControls ? 'bars-visible' : '',
        `bg-${bgColor}`,
        grayscale ? 'reader-grayscale' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--reader-zoom': zoom / 100 }}
    >
      <div className="reader-brightness-overlay" style={{ opacity: (100 - brightness) / 100 }} />
      {isPaged ? (
        <ReaderPaged
          pages={pages}
          currentPage={currentPage}
          page2Index={page2Index}
          rtl={isRtl}
          orientationRtl={readingOrientation === 'rtl'}
          scaleType={scaleType}
          zoom={zoom}
          animateTransitions={animateTransitions}
          animKey={animKey}
          animDir={animDir}
          gesturesEnabled={gesturesEnabled}
          onNext={nextPage}
          onPrev={prevPage}
          onCenterTap={handleCenterTap}
          onZoomChange={setZoom}
        />
      ) : (
        <ReaderScroll
          ref={scrollerRef}
          pages={pages}
          initialPage={currentPage}
          onPageChange={handlePageChange}
          zoom={zoom}
          isWebtoon={isWebtoon}
        />
      )}
      {controls}
    </div>
  );
}
