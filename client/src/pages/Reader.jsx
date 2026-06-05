import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import ReaderPaged from '../components/ReaderPaged';
import ReaderScroll from '../components/ReaderScroll';
import ReaderControls from '../components/ReaderControls';
import ReaderEdgeHints from '../components/ReaderEdgeHints';
import { useReaderPrefetch } from '../hooks/useReaderPrefetch';
import { getResumePageForChapter, setResume, clearResume } from '../utils/readingProgress';
import { enableImmersive, disableImmersive, isNativeShell } from '../api/immersive';
import {
  isEncryptionEnabled as offlineIsEncryptionEnabled,
  isUnlocked          as offlineIsUnlocked,
  unlock              as offlineUnlock,
} from '../api/offlineCrypto';
import { getOfflineChapter as getOfflineChapterRow } from '../api/offlineDb';
import { resumeAfterUnlock as downloaderResumeAfterUnlock } from '../api/downloader';
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

// Initial value for `reader_predictNextChapter`. If the user hasn't set it
// yet, fall back to whatever `reader_prefetchPages` is — that's the setting
// that implicitly gated next-chapter prefetch before this feature shipped.
// This preserves today's behaviour for upgrade: a user who turned image
// prefetch off doesn't suddenly start getting next-chapter pre-extraction
// requests; a user with the default on stays in the same state. We write
// the resolved value back to localStorage so subsequent reads (and the
// Settings page) see a concrete value rather than re-running the migration
// after the user later flips `prefetchPages`.
function resolveInitialPredictNextChapter() {
  const stored = localStorage.getItem('reader_predictNextChapter');
  if (stored !== null) return stored !== 'false';
  const inherited = localStorage.getItem('reader_prefetchPages') !== 'false';
  try { localStorage.setItem('reader_predictNextChapter', String(inherited)); }
  catch { /* private browsing — fine */ }
  return inherited;
}

const PROGRESS_DEBOUNCE_MS = 2000;

// Renders the inline "Unlock to read" passphrase prompt when the user
// opens an encrypted chapter without having unlocked the offline store
// yet. Replaces the broken-image-soup the reader would otherwise show.
//
// Auto-focuses the passphrase input so the user can type immediately
// without an extra tap — important on mobile where the on-screen
// keyboard delays input by 100-200ms otherwise.
function ReaderUnlockGate({ mangaId, onUnlocked }) {
  const [pass, setPass]     = useState('');
  const [error, setError]   = useState(null);
  const [busy, setBusy]     = useState(false);
  const inputRef            = useRef(null);

  useEffect(() => {
    // Tiny delay so the keyboard reliably pops on Android; focusing
    // immediately on mount sometimes races with the route transition.
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      await offlineUnlock(pass);
      setPass('');
      onUnlocked();
    } catch (err) {
      setError(String(err?.message || err) || 'Wrong passphrase.');
      // Re-focus + select so the user can correct quickly.
      requestAnimationFrame(() => inputRef.current?.select());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reader-loading">
      <h2 style={{ margin: '0 0 12px' }}>Encrypted</h2>
      <p style={{ margin: '0 0 18px', maxWidth: 380, textAlign: 'center', color: 'var(--text-muted)' }}>
        This chapter was downloaded with at-rest encryption.
        Enter your passphrase to read it.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 280, maxWidth: '90%' }}>
        <input
          ref={inputRef}
          type="password"
          className="settings-input"
          value={pass}
          onChange={e => setPass(e.target.value)}
          placeholder="Passphrase"
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !pass}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      {error && (
        <p style={{ marginTop: 12, color: '#e87878', fontSize: '0.9rem' }}>{error}</p>
      )}
      <Link
        to={mangaId ? `/manga/${mangaId}` : '/'}
        className="btn btn-ghost"
        style={{ marginTop: 18 }}
      >
        Cancel
      </Link>
    </div>
  );
}

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
  // First-page-fast CBZ open. Per-device toggle from Settings → Reading
  // Settings → Advanced (and the matching Advanced tab in the in-reader
  // settings menu). Default off so the existing full-extract path stays the
  // default until users opt in. When on, the Reader passes `?fast=1` to
  // /api/chapters/:id/pages and the server returns after only the prefix is
  // on disk, with the remainder extracting in the background.
  const [fastChapterOpen, setFastChapterOpen] = useState(() => localStorage.getItem('reader_fastChapterOpen') === 'true');
  // Predictive next-chapter pre-extraction. Default ON for users who had
  // `reader_prefetchPages` on (today's implicit behaviour: the prefetch hook
  // already fired getPages(next.id) for them). Default OFF for users who had
  // prefetchPages off (today's behaviour was no next-chapter prefetch). See
  // `resolveInitialPredictNextChapter` above for the migration rationale.
  const [predictNextChapter, setPredictNextChapter] = useState(resolveInitialPredictNextChapter);
  // `extracting: true` from the server means Phase 2 is still running. The
  // Reader schedules one delayed re-fetch to pick up the late dim values
  // (in case the Phase 1 probe failed for some entries) and the freshly-
  // landed page rows. Kept off the localStorage path on purpose — it's
  // session-only state, not a preference.
  const [extracting, setExtracting] = useState(false);
  // Distinguished error state for HTTP 410 from /api/pages/:id/image and
  // /api/chapters/:id/pages — the chapter (or its archive) was removed
  // while the reader was open. Different copy than a network error so the
  // user knows to navigate back, not retry.
  const [gone, setGone] = useState(false);

  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  // On native shells (Electron AppImage, Android APK) the reader enters
  // window-level fullscreen via enableImmersive() on mount, so seed the
  // state accordingly. The HTML Fullscreen API used by browsers doesn't
  // fire `fullscreenchange` for that path, so we must track it manually.
  const [isFullscreen, setIsFullscreen] = useState(() => isNativeShell());
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
  // Active touch counter — set in window touchstart, cleared in touchend/cancel.
  // Used by the pointermove auto-show handler to hard-block synthesised mouse
  // events while a finger is on the screen (event-dispatch order between
  // touch* and pointermove is implementation-defined, so a timestamp gate
  // would race; a counter that opens on touchstart can't).
  const activeTouches      = useRef(0);
  const lastTouchActivity  = useRef(0);  // ms timestamp — guards a short post-touch tail
  const isFullscreenRef    = useRef(false);  // mirror of isFullscreen for ref-stable handlers
  const [hintsSuppressed, setHintsSuppressed] = useState(false);

  // Derived
  const isPaged = readingMode === 'ltr' || readingMode === 'rtl';
  const isRtl = readingMode === 'rtl';
  const isWebtoon = readingMode === 'webtoon';

  // Spread map for Double Page (Manga): array of [pageIdx] or [pageIdx, pageIdx+1]
  // Page 0 is always solo (title/cover). Wide pages are always solo.
  // After any solo page, the next normal page starts a fresh pair.
  //
  // Unknown dims (`is_wide === null`) are treated as **wide** here — the page
  // renders solo until the real value lands. This matters under fast chapter
  // open: Phase 1's 256 KB header probe can fail for a corrupt header or an
  // unusual codec, leaving is_wide=null until Phase 2's re-probe (or the
  // cache-hit heal on a later re-fetch) corrects it. If we treated null as
  // not-wide (the old default), a genuinely wide spread would get crammed
  // into half the screen alongside its neighbour — visibly broken. Treating
  // unknown as wide → render solo means the worst outcome is a normal page
  // briefly rendered alone, which is suboptimal but never wrong. The dim
  // correction triggers a mangaSpreads recompute and the paired layout
  // appears within seconds. Full-mode CBZ and folder chapters always have
  // dims populated, so this branch only changes behaviour for fast-mode
  // probe failures.
  const mangaSpreads = useMemo(() => {
    if (!isPaged || pageLayout !== 'double-manga' || pages.length === 0) return null;
    const spreads = [];
    let i = 0;
    while (i < pages.length) {
      const isCover        = i === 0;
      const isWideOrUnknown = pages[i]?.is_wide !== false; // null OR true → solo
      if (isCover || isWideOrUnknown) {
        spreads.push([i]);
        i++;
      } else if (i + 1 < pages.length && pages[i + 1]?.is_wide === false) {
        // Pair only when BOTH the current page AND the next page are
        // explicitly known not-wide. Unknown next-page also stays solo so
        // we never pair a normal page with a possibly-wide neighbour.
        spreads.push([i, i + 1]);
        i += 2;
      } else {
        // Last page, or next page is wide / unknown — stay solo
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

  // Backup dim-probe: fires when any rendered or prefetched <img> finishes
  // decoding and the corresponding page row's `is_wide` is still null.
  // Patches the local pages array (so mangaSpreads recomputes within one
  // render cycle and Double Page (Manga) self-corrects) AND fires a
  // batched POST via api.reportPageDimensions so the fix persists to the
  // server for the next chapter open.
  //
  // The setPages updater is defensive: it only mutates if the row still
  // has null is_wide, preventing a stale onLoad from clobbering dims
  // that Phase 2's server-side hook just landed via the 6 s re-fetch.
  // The api helper has its own dedupe at the buffer level, so duplicate
  // reports from the displayed <img> + prefetch Image() pair are cheap.
  const handlePageDimsLearned = useCallback((pageId, width, height) => {
    setPages(prev => {
      let changed = false;
      const next = prev.map(p => {
        if (p.id !== pageId) return p;
        if (p.is_wide !== null && p.is_wide !== undefined) return p;
        changed = true;
        return { ...p, width, height, is_wide: width > height };
      });
      return changed ? next : prev;
    });
    api.reportPageDimensions(pageId, width, height);
  }, []);

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
    predictNextChapter,
    fastChapterOpen,
    onPageDimsLearned: handlePageDimsLearned,
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
  useEffect(() => { localStorage.setItem('reader_fastChapterOpen', String(fastChapterOpen)); }, [fastChapterOpen]);
  useEffect(() => { localStorage.setItem('reader_predictNextChapter', String(predictNextChapter)); }, [predictNextChapter]);

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
    // On native shells the HTML Fullscreen API is a no-op — the BrowserWindow
    // (Electron) or the Activity (Android) is the source of truth. Route the
    // toggle through the immersive bridge so the button actually changes the
    // window/system-bar state, and mirror it into local state since neither
    // path fires `fullscreenchange`.
    if (isNativeShell()) {
      if (isFullscreen) {
        disableImmersive();
        setIsFullscreen(false);
      } else {
        enableImmersive();
        setIsFullscreen(true);
      }
      return;
    }
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

  // ── Encryption gate ────────────────────────────────────────────────────
  // When the user has at-rest encryption enabled and the chapter being
  // opened was downloaded with it active, we need an unlocked store to
  // render anything. `needsUnlock` drives the inline passphrase prompt
  // below; reload (`reloadKey`) bumps the chapter-load effect after a
  // successful unlock so it re-fetches with a working key.
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [reloadKey,   setReloadKey]   = useState(0);

  // Load chapter data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      // Inspect the local chapter row before any decrypt-on-read happens
      // so we can show the inline unlock prompt instead of broken-image
      // icons. We only check on native shells with a stored chapter row;
      // online sessions and pure-PWA paths skip this check.
      try {
        const enabled = await offlineIsEncryptionEnabled();
        if (enabled && !offlineIsUnlocked()) {
          const row = await getOfflineChapterRow(chapterId);
          if (row && row.encrypted) {
            if (!cancelled) {
              setNeedsUnlock(true);
              setLoading(false);
            }
            return;
          }
        }
      } catch { /* IDB unavailable — fall through to the normal path */ }

      if (!cancelled) setNeedsUnlock(false);
      try {
        // Capture the resume page once before either fetch starts. When fast
        // mode is on, we forward it as ?resume_page= so the server extracts
        // a small window around it during Phase 1 — otherwise the user's
        // deep-link landing at page 50 would block for seconds waiting on
        // Phase 2 to reach it.
        const urlPage = searchParams.get('page');
        const initialResume =
          urlPage !== null
            ? parseInt(urlPage, 10) || 0
            : (getResumePageForChapter(mangaId, chapterId) ?? 0);

        const pagesPromise = fastChapterOpen
          ? api.getPagesWithMeta(chapterId, { fast: true, resumePage: initialResume })
          : api.getPages(chapterId);

        const [ch, pagesResult] = await Promise.all([
          api.getChapter(chapterId),
          pagesPromise,
        ]);
        if (cancelled) return;

        // getPagesWithMeta returns { data, extracting, total_pages }; the
        // legacy getPages returns the plain array.
        const pgs = Array.isArray(pagesResult) ? pagesResult : pagesResult.data;
        const stillExtracting = !Array.isArray(pagesResult) && !!pagesResult.extracting;

        setChapter(ch);
        setPages(pgs);
        setExtracting(stillExtracting);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        if (err.status === 410) {
          setGone(true);
          setLoading(false);
        } else {
          setError(err.message);
          setLoading(false);
        }
      }
    }

    load();

    // When the user has at-rest encryption enabled, `offlineApi.getPages`
    // populates the per-page URL map with `blob:` URLs created from the
    // decrypted bytes. Release those when leaving the chapter so we don't
    // accumulate memory across long reading sessions. No-op when
    // encryption is off (the cache is plain file:// URLs in that case).
    //
    // Skip the dynamic import on PWA / regular browsers — the offline
    // subsystem can't create encrypted downloads there (no filesystem),
    // so the blob-URL set is provably empty and pulling in the
    // offlineApi chunk just to call a no-op cleanup costs ~15 KB
    // gzipped (offlineApi + offlineDb + idb) on first chapter open.
    return () => {
      cancelled = true;
      const isNative = typeof window !== 'undefined'
                    && window.Capacitor
                    && typeof window.Capacitor.isNativePlatform === 'function'
                    && window.Capacitor.isNativePlatform();
      if (!isNative) return;
      import('../api/offlineApi.js')
        .then(m => m.releasePageBlobs && m.releasePageBlobs())
        .catch(() => { /* shim not loaded — fine */ });
    };
  }, [chapterId, reloadKey]);

  // Late-dim re-fetch for fast-open extractions.
  //
  // When the server returns extracting:true the first response contains the
  // full pages array (so the reader paints immediately) but page width/height
  // may be NULL for entries whose probe failed. After ~6s Phase 2 has either
  // finished or come close, so re-fetch once to pick up real dims and any
  // newly-landed page metadata.
  //
  // CRITICAL for Double Page (Manga): mangaSpreads recomputes from `pages`,
  // so when dims update the spread groupings can shift. We capture the
  // user's *page index* before applying the new pages and re-anchor to that
  // same page index afterwards — never the spread index, which would jump
  // the user to an unrelated page.
  // Hold the latest currentPage in a ref so the refetch can read it without
  // having to put currentPage in the effect's deps array (which would reset
  // the timer on every page flip).
  const currentPageRef = useRef(currentPage);
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);

  useEffect(() => {
    if (!extracting) return;
    if (!fastChapterOpen) return;
    let cancelled = false;
    let timer = null;
    let stillExtracting = true;

    async function refetchOnce() {
      try {
        const anchor = currentPageRef.current;
        const result = await api.getPagesWithMeta(chapterId, { fast: true });
        if (cancelled) return;
        const pgs = result.data;
        setPages(pgs);
        stillExtracting = !!result.extracting;
        setExtracting(stillExtracting);
        // Re-anchor by *page index*, never by spread index. mangaSpreads will
        // recompute from the new pages on the next render; if dims for a
        // previously-misclassified page just arrived, the spread layout may
        // shift slightly, but `currentPage` still references the same image
        // the user was looking at.
        if (anchor >= pgs.length) setCurrentPage(Math.max(0, pgs.length - 1));
        // If Phase 2 still hasn't finished (rare — implies a very long
        // chapter or a slow disk), arm another wait.
        if (stillExtracting && !cancelled) {
          timer = setTimeout(refetchOnce, 6000);
        }
      } catch (err) {
        if (cancelled) return;
        if (err.status === 410) setGone(true);
        // Other errors are non-fatal — keep showing what we already have.
      }
    }

    timer = setTimeout(refetchOnce, 6000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [extracting, fastChapterOpen, chapterId]);

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

  // Keep the isFullscreen mirror in sync for ref-stable handlers below.
  useEffect(() => { isFullscreenRef.current = isFullscreen; }, [isFullscreen]);

  // Mouse movement auto-shows controls in windowed mode. In fullscreen the
  // user expects the reader UI to appear only on a center tap, so the entire
  // auto-show path is disabled there — swipes, side taps, *and* trackpad/
  // mouse movement all stay distraction-free until the user taps the centre
  // explicitly. The "side taps and swipes should never trigger the UI" rule
  // is enforced two ways at once:
  //   1) Active-touch counter: window touchstart increments, touchend/cancel
  //      decrement. While any finger is on the screen, the pointermove
  //      handler hard-bails. touchstart reliably fires *before* the first
  //      pointermove of the same gesture, so unlike a timestamp gate this
  //      can't race with event-dispatch order — long swipes that produce
  //      many pointermove events between touchmoves still see counter > 0.
  //   2) Post-touch tail: lastTouchActivity is stamped on every touch event,
  //      and a 1.0 s window after the last touch keeps the gate closed so
  //      the trailing synthesised mouse events Chromium fires after a
  //      touchend can't slip through.
  // Real mouse users (separate trackpad / external mouse) recover
  // hover-to-show in windowed mode as soon as touch goes idle.
  useEffect(() => {
    function onStart(e) {
      activeTouches.current += e.changedTouches.length;
      lastTouchActivity.current = Date.now();
    }
    function onEnd(e) {
      activeTouches.current = Math.max(0, activeTouches.current - e.changedTouches.length);
      lastTouchActivity.current = Date.now();
    }
    function onMove() { lastTouchActivity.current = Date.now(); }
    window.addEventListener('touchstart',  onStart, { passive: true });
    window.addEventListener('touchmove',   onMove,  { passive: true });
    window.addEventListener('touchend',    onEnd,   { passive: true });
    window.addEventListener('touchcancel', onEnd,   { passive: true });
    return () => {
      window.removeEventListener('touchstart',  onStart);
      window.removeEventListener('touchmove',   onMove);
      window.removeEventListener('touchend',    onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  useEffect(() => {
    function onPointerMove(e) {
      if (e.pointerType !== 'mouse') return;
      // In fullscreen the user reveals the UI only via the center-tap
      // gesture. No exceptions — not even a real mouse hover.
      if (isFullscreenRef.current) return;
      // Windowed mode: still block while a touch is active, and for a
      // 1.0 s tail after the last touch event.
      if (activeTouches.current > 0) return;
      if (Date.now() - lastTouchActivity.current < 1000) return;
      showControlsAndReset();
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
      const nextStart = mangaSpreads[spreadIdx + 1][0];
      setAnimDir('next');
      setAnimKey(k => k + 1);
      setCurrentPage(nextStart);
      saveProgress(nextStart);
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
      const prevStart = mangaSpreads[spreadIdx - 1][0];
      setAnimDir('prev');
      setAnimKey(k => k + 1);
      setCurrentPage(prevStart);
      saveProgress(prevStart);
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

    // Fast-open priority hint: when Phase 2 is still running and the user
    // jumped ahead of the natural extraction order (scrubber, deep link),
    // ask the server to extract the target pages next. No-op when Phase 2
    // already passed these indices, when the chapter isn't a CBZ, or when
    // fast mode is off — the endpoint just returns 200 with touched:0.
    if (extracting && fastChapterOpen) {
      // Cover the target spread plus a small lookahead so the user can flip
      // forward one or two pages while the rest of Phase 2 catches up.
      const targets = new Set();
      for (let off = 0; off <= 4; off++) {
        const i = snapped + off;
        if (i >= 0 && i < pages.length) targets.add(i);
      }
      api.prioritizePages(chapterId, Array.from(targets));
    }
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

  if (needsUnlock) return (
    <ReaderUnlockGate
      mangaId={mangaId}
      onUnlocked={() => {
        // Wake the download queue too — any chapters that were sitting
        // in the locked-and-queued state can now drain.
        try { downloaderResumeAfterUnlock(); } catch { /* non-fatal */ }
        setNeedsUnlock(false);
        setReloadKey(k => k + 1);
      }}
    />
  );

  if (gone) return (
    <div className="reader-loading">
      <h2>This chapter is no longer available</h2>
      <p style={{ maxWidth: 420, textAlign: 'center', color: 'var(--text-muted)' }}>
        The chapter or its archive was removed or renamed. Return to the
        manga page to see the current chapter list.
      </p>
      <Link to={mangaId ? `/manga/${mangaId}` : '/'} className="btn btn-primary" style={{ marginTop: 16 }}>
        Back to manga
      </Link>
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
      fastChapterOpen={fastChapterOpen}
      predictNextChapter={predictNextChapter}
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
      onFastChapterOpenChange={setFastChapterOpen}
      onPredictNextChapterChange={setPredictNextChapter}
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
          onPageDimsLearned={handlePageDimsLearned}
        />
      ) : (
        <ReaderScroll
          ref={scrollerRef}
          pages={pages}
          initialPage={currentPage}
          onPageChange={handlePageChange}
          zoom={zoom}
          isWebtoon={isWebtoon}
          onPageDimsLearned={handlePageDimsLearned}
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
