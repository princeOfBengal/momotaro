import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import ReaderPaged from '../components/ReaderPaged';
import ReaderScroll from '../components/ReaderScroll';
import ReaderControls from '../components/ReaderControls';
import ReaderEdgeHints from '../components/ReaderEdgeHints';
import { useReaderPrefetch } from '../hooks/useReaderPrefetch';
import { getResumePageForChapter, setResume, clearResume } from '../utils/readingProgress';
import { enableImmersive, disableImmersive } from '../api/immersive';
import './Reader.css';

// Resolve the page-transition style. Migrates the legacy boolean key
// `reader_animTrans` (true → 'slide', false → 'off') the first time it's read.
function resolveInitialPageAnimation() {
  const stored = localStorage.getItem('reader_pageAnimation');
  if (stored === 'off' || stored === 'slide' || stored === 'fade' || stored === 'curl') return stored;
  const legacy = localStorage.getItem('reader_animTrans');
  if (legacy === 'true')  return 'slide';
  if (legacy === 'false') return 'off';
  return 'slide';
}

function clampAnimSpeed(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, n));
}

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
  const [pageAnimation, setPageAnimation] = useState(resolveInitialPageAnimation);
  const [pageAnimSpeed, setPageAnimSpeed] = useState(() => clampAnimSpeed(Number(localStorage.getItem('reader_pageAnimSpeed')) || 1));
  const [showEdgeHints, setShowEdgeHints] = useState(() => localStorage.getItem('reader_edgeHints') === 'true');
  const [gesturesEnabled, setGesturesEnabled] = useState(() => localStorage.getItem('reader_gestures') !== 'false');
  const [alwaysFullscreen, setAlwaysFullscreen] = useState(() => localStorage.getItem('reader_alwaysFS') === 'true');
  const [bgColor, setBgColor] = useState(() => localStorage.getItem('reader_bgColor') || 'black');
  const [grayscale, setGrayscale] = useState(() => localStorage.getItem('reader_grayscale') === 'true');
  const [scaleType, setScaleType] = useState(() => localStorage.getItem('reader_scaleType') || 'screen');
  const [pageLayout, setPageLayout] = useState(() => localStorage.getItem('reader_pageLayout') || 'single');
  const [readingOrientation, setReadingOrientation] = useState(() => localStorage.getItem('reader_orientation') || 'ltr');
  const [brightness, setBrightness] = useState(() => Number(localStorage.getItem('reader_brightness')) || 100);
  const [prefetchPages, setPrefetchPages] = useState(() => localStorage.getItem('reader_prefetchPages') !== 'false');

  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const [animDir, setAnimDir] = useState('next');
  // URL `?page=` wins; otherwise fall back to this device's saved resume
  // position for the current chapter, otherwise 0.
  const [currentPage, setCurrentPage] = useState(() => {
    const urlPage = searchParams.get('page');
    if (urlPage !== null) return parseInt(urlPage, 10) || 0;
    return getResumePageForChapter(mangaId, chapterId) ?? 0;
  });
  const [galleryPageIds, setGalleryPageIds] = useState(() => new Set());

  const progressTimer = useRef(null);
  const controlsTimer = useRef(null);
  const scrubActiveRef = useRef(false);
  const scrollerRef = useRef(null);
  const containerRef = useRef(null);
  const hintSuppressTimer = useRef(null);
  const [hintsSuppressed, setHintsSuppressed] = useState(false);

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

  useReaderPrefetch({
    pages,
    currentPage,
    page2Index,
    pageLayout,
    mangaSpreads,
    isPaged,
    allChapters,
    chapterId,
    enabled: prefetchPages,
  });

  // Persist settings
  useEffect(() => { localStorage.setItem('reader_readingMode', readingMode); }, [readingMode]);
  useEffect(() => { localStorage.setItem('reader_zoom', zoom); }, [zoom]);
  useEffect(() => { localStorage.setItem('reader_pageAnimation', pageAnimation); }, [pageAnimation]);
  useEffect(() => { localStorage.setItem('reader_pageAnimSpeed', String(pageAnimSpeed)); }, [pageAnimSpeed]);
  useEffect(() => { localStorage.setItem('reader_edgeHints', String(showEdgeHints)); }, [showEdgeHints]);
  useEffect(() => { localStorage.setItem('reader_gestures', gesturesEnabled); }, [gesturesEnabled]);

  // One-time cleanup of the legacy boolean key (resolveInitialPageAnimation
  // already handled the migration at read-time).
  useEffect(() => {
    if (localStorage.getItem('reader_animTrans') !== null) {
      localStorage.removeItem('reader_animTrans');
    }
  }, []);
  useEffect(() => { localStorage.setItem('reader_alwaysFS', alwaysFullscreen); }, [alwaysFullscreen]);
  useEffect(() => { localStorage.setItem('reader_bgColor', bgColor); }, [bgColor]);
  useEffect(() => { localStorage.setItem('reader_grayscale', grayscale); }, [grayscale]);
  useEffect(() => { localStorage.setItem('reader_scaleType', scaleType); }, [scaleType]);
  useEffect(() => { localStorage.setItem('reader_pageLayout', pageLayout); }, [pageLayout]);
  useEffect(() => { localStorage.setItem('reader_orientation', readingOrientation); }, [readingOrientation]);
  useEffect(() => { localStorage.setItem('reader_brightness', brightness); }, [brightness]);
  useEffect(() => { localStorage.setItem('reader_prefetchPages', String(prefetchPages)); }, [prefetchPages]);

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

  // Capacitor APK only: enter Android sticky-immersive mode while the
  // Reader is mounted — hides both the status bar (top with time/battery)
  // and the navigation bar (bottom with back/home/recents). Swiping from
  // either edge briefly reveals them and they auto-hide again. The web
  // Fullscreen API above only hides browser chrome (which doesn't exist
  // inside the Capacitor WebView), so for the APK we need this native
  // path. PWA / desktop browsers no-op inside the helpers.
  useEffect(() => {
    enableImmersive();
    return () => { disableImmersive(); };
  }, []);

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

  // Load art gallery page IDs so the Add-to-Gallery button reflects the current state
  useEffect(() => {
    if (!mangaId) return;
    let cancelled = false;
    api.getGallery(mangaId).then(items => {
      if (cancelled) return;
      setGalleryPageIds(new Set(items.map(it => it.page_id)));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [mangaId]);

  // Sync current page to URL
  useEffect(() => {
    setSearchParams(prev => {
      prev.set('page', String(currentPage));
      return prev;
    }, { replace: true });
  }, [currentPage]);

  // Save progress.
  // Per-device resume position is written to localStorage immediately so an
  // abrupt exit (close tab, lock phone) still preserves the page. The
  // server-side progress (used for AniList sync + completion tracking) stays
  // debounced to avoid spamming the API while the user pages quickly.
  const saveProgress = useCallback((page, completed = false) => {
    if (!mangaId) return;
    if (completed) {
      clearResume(mangaId);
    } else {
      setResume(mangaId, chapterId, page);
    }
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

  // Briefly fade out persistent edge hints after any tap so they don't compete
  // visually with whatever the user is doing. Touch handlers are not modified —
  // ReaderPaged calls this from its existing execTap path.
  const handleAnyTap = useCallback(() => {
    setHintsSuppressed(true);
    clearTimeout(hintSuppressTimer.current);
    hintSuppressTimer.current = setTimeout(() => setHintsSuppressed(false), 1500);
  }, []);

  // Hint mode resolution. Suppressed in non-paged modes, while the settings
  // panel is open, and while zoomed in (panning would visually conflict).
  // Controls visibility intentionally does NOT suppress hints: the top/bottom
  // bars don't overlap with the vertical-center tap-zone affordances, and on
  // touch devices controls stay visible from mount until a center tap, so
  // gating on them would mean the first-run pulse never plays.
  const isZoomedIn = zoom > 100;
  const hintsInitiallySeen = useRef(localStorage.getItem('reader_hintsSeen') === 'true');
  const hintMode = (!isPaged || showSettings || isZoomedIn)
    ? 'off'
    : (!hintsInitiallySeen.current ? 'first-run' : (showEdgeHints ? 'persistent' : 'off'));

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
      const resumePage = getResumePageForChapter(mangaId, target.id) ?? 0;
      setCurrentPage(resumePage);
      navigate(`/read/${target.id}?mangaId=${mangaId}&page=${resumePage}`);
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
      pageAnimation={pageAnimation}
      pageAnimSpeed={pageAnimSpeed}
      showEdgeHints={showEdgeHints}
      gesturesEnabled={gesturesEnabled}
      alwaysFullscreen={alwaysFullscreen}
      bgColor={bgColor}
      grayscale={grayscale}
      brightness={brightness}
      prefetchPages={prefetchPages}
      scaleType={scaleType}
      pageLayout={pageLayout}
      showSettings={showSettings}
      hasPrevChapter={hasPrevChapter}
      hasNextChapter={hasNextChapter}
      mangaId={mangaId}
      isFullscreen={isFullscreen}
      onReadingModeChange={setReadingMode}
      onZoomChange={setZoom}
      onPageAnimationChange={setPageAnimation}
      onPageAnimSpeedChange={(n) => setPageAnimSpeed(clampAnimSpeed(n))}
      onShowEdgeHintsChange={setShowEdgeHints}
      onGesturesChange={setGesturesEnabled}
      onAlwaysFullscreenChange={setAlwaysFullscreen}
      onBgColorChange={setBgColor}
      onGrayscaleChange={setGrayscale}
      onBrightnessChange={setBrightness}
      onPrefetchPagesChange={setPrefetchPages}
      onScaleTypeChange={setScaleType}
      onPageLayoutChange={setPageLayout}
      readingOrientation={readingOrientation}
      onReadingOrientationChange={setReadingOrientation}
      onSetPageAsThumbnail={async () => {
        const page = pages[currentPage];
        if (!mangaId || !page) throw new Error('No page');
        await api.setPageAsThumbnail(mangaId, page.id);
      }}
      isCurrentPageInGallery={!!pages[currentPage] && galleryPageIds.has(pages[currentPage].id)}
      onToggleGalleryPage={async () => {
        const page = pages[currentPage];
        if (!mangaId || !page) throw new Error('No page');
        if (galleryPageIds.has(page.id)) {
          await api.removeFromGalleryByPage(mangaId, page.id);
          setGalleryPageIds(prev => { const n = new Set(prev); n.delete(page.id); return n; });
        } else {
          await api.addToGallery(mangaId, page.id);
          setGalleryPageIds(prev => new Set(prev).add(page.id));
        }
      }}
      onDownloadPage={async () => {
        const page = pages[currentPage];
        if (!page) throw new Error('No page');
        const ext = (page.filename?.match(/\.[a-z0-9]+$/i)?.[0] || '.jpg').toLowerCase();
        const chapterPart = chapter ? (
          (chapter.volume !== null && chapter.number !== null)
            ? `v${chapter.volume}c${chapter.number}`
            : chapter.volume !== null ? `v${chapter.volume}`
            : chapter.number !== null ? `c${chapter.number}`
            : chapter.folder_name
        ) : '';
        const base = [manga?.title, chapterPart, `p${currentPage + 1}`].filter(Boolean).join(' - ');
        const filename = `${base.replace(/[\\/:*?"<>|]/g, '_')}${ext}`;
        const resp = await fetch(api.pageImageUrl(page.id));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
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
      style={{ '--reader-zoom': zoom / 100, '--reader-anim-mult': pageAnimSpeed }}
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
          pageAnimation={pageAnimation}
          animKey={animKey}
          animDir={animDir}
          gesturesEnabled={gesturesEnabled}
          onNext={nextPage}
          onPrev={prevPage}
          onCenterTap={handleCenterTap}
          onZoomChange={setZoom}
          onAnyTap={handleAnyTap}
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
      <ReaderEdgeHints mode={hintMode} rtl={isRtl} suppressed={hintsSuppressed} />
      {zoom !== 100 && (
        <button
          type="button"
          className="reader-restore-zoom"
          onClick={() => setZoom(100)}
          aria-label="Restore zoom to 100%"
        >
          Restore Zoom
        </button>
      )}
      {controls}
    </div>
  );
}
