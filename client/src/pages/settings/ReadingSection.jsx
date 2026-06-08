import React, { useState, useEffect } from 'react';
import ToggleRow from '../../components/ToggleRow';
import { isAndroid } from '../../api/volumeButtons';
import '../Settings.css';

// Mirrors Reader.jsx — keep the migration logic identical so opening Settings
// before the reader still translates the legacy boolean key correctly.
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

// Mirrors Reader.jsx — see that file for the rationale. Inherits from the
// pre-existing `reader_prefetchPages` setting on first read so a user who
// turned image prefetch off doesn't suddenly start getting background
// next-chapter pre-extraction requests after this feature ships.
function resolveInitialPredictNextChapter() {
  const stored = localStorage.getItem('reader_predictNextChapter');
  if (stored !== null) return stored !== 'false';
  const inherited = localStorage.getItem('reader_prefetchPages') !== 'false';
  try { localStorage.setItem('reader_predictNextChapter', String(inherited)); }
  catch { /* private browsing — fine */ }
  return inherited;
}

export default function ReadingSection() {
  const [readingMode, setReadingMode]             = useState(() => localStorage.getItem('reader_readingMode') || 'rtl');
  const [readingOrientation, setReadingOrientation] = useState(() => localStorage.getItem('reader_orientation') || 'ltr');
  const [pageAnimation, setPageAnimation]         = useState(resolveInitialPageAnimation);
  const [pageAnimSpeed, setPageAnimSpeed]         = useState(() => clampAnimSpeed(Number(localStorage.getItem('reader_pageAnimSpeed')) || 1));
  const [showEdgeHints, setShowEdgeHints]         = useState(() => localStorage.getItem('reader_edgeHints') === 'true');
  // Fast CBZ open — see [server/src/scanner/cbzCache.js]. Default off so
  // existing users see no behaviour change until they opt in.
  const [fastChapterOpen, setFastChapterOpen]     = useState(() => localStorage.getItem('reader_fastChapterOpen') === 'true');
  // Predictive next-chapter pre-extraction. Initial value migrates from
  // `reader_prefetchPages` on first read (see resolveInitialPredictNextChapter
  // above) so existing users keep today's implicit coupling. When
  // fastChapterOpen is also on, the prefetch routes through the fast-mode
  // endpoint so the next chapter opens nearly instantly. See
  // [client/src/hooks/useReaderPrefetch.js].
  const [predictNextChapter, setPredictNextChapter] = useState(resolveInitialPredictNextChapter);
  const [gesturesEnabled, setGesturesEnabled]     = useState(() => localStorage.getItem('reader_gestures') !== 'false');
  const [alwaysFullscreen, setAlwaysFullscreen]   = useState(() => localStorage.getItem('reader_alwaysFS') === 'true');
  const [bgColor, setBgColor]                     = useState(() => localStorage.getItem('reader_bgColor') || 'black');
  const [grayscale, setGrayscale]                 = useState(() => localStorage.getItem('reader_grayscale') === 'true');
  const [scaleType, setScaleType]                 = useState(() => localStorage.getItem('reader_scaleType') || 'screen');
  const [pageLayout, setPageLayout]               = useState(() => localStorage.getItem('reader_pageLayout') || 'single');
  const [prefetchPages, setPrefetchPages]         = useState(() => localStorage.getItem('reader_prefetchPages') !== 'false');
  // Volume-button page turning (Android only) — the toggles below only render
  // on Android and the native bridge no-ops elsewhere.
  const [volumeButtonNav, setVolumeButtonNav]         = useState(() => localStorage.getItem('reader_volumeButtonNav') === 'true');
  const [volumeButtonReverse, setVolumeButtonReverse] = useState(() => localStorage.getItem('reader_volumeButtonReverse') === 'true');
  const [resetHintsMsg, setResetHintsMsg]         = useState(null);

  useEffect(() => { localStorage.setItem('reader_readingMode',  readingMode); },         [readingMode]);
  useEffect(() => { localStorage.setItem('reader_orientation',  readingOrientation); },  [readingOrientation]);
  useEffect(() => { localStorage.setItem('reader_pageAnimation', pageAnimation); },      [pageAnimation]);
  useEffect(() => { localStorage.setItem('reader_pageAnimSpeed', String(pageAnimSpeed)); }, [pageAnimSpeed]);
  useEffect(() => { localStorage.setItem('reader_edgeHints',    String(showEdgeHints)); }, [showEdgeHints]);
  useEffect(() => { localStorage.setItem('reader_fastChapterOpen', String(fastChapterOpen)); }, [fastChapterOpen]);
  useEffect(() => { localStorage.setItem('reader_predictNextChapter', String(predictNextChapter)); }, [predictNextChapter]);
  useEffect(() => { localStorage.setItem('reader_gestures',     gesturesEnabled); },     [gesturesEnabled]);
  useEffect(() => { localStorage.setItem('reader_alwaysFS',     alwaysFullscreen); },    [alwaysFullscreen]);
  useEffect(() => { localStorage.setItem('reader_bgColor',      bgColor); },             [bgColor]);
  useEffect(() => { localStorage.setItem('reader_grayscale',    grayscale); },           [grayscale]);
  useEffect(() => { localStorage.setItem('reader_scaleType',    scaleType); },           [scaleType]);
  useEffect(() => { localStorage.setItem('reader_pageLayout',   pageLayout); },          [pageLayout]);
  useEffect(() => { localStorage.setItem('reader_prefetchPages', String(prefetchPages)); }, [prefetchPages]);
  useEffect(() => { localStorage.setItem('reader_volumeButtonNav', String(volumeButtonNav)); }, [volumeButtonNav]);
  useEffect(() => { localStorage.setItem('reader_volumeButtonReverse', String(volumeButtonReverse)); }, [volumeButtonReverse]);

  // One-time cleanup of the legacy boolean key.
  useEffect(() => {
    if (localStorage.getItem('reader_animTrans') !== null) {
      localStorage.removeItem('reader_animTrans');
    }
  }, []);

  function handleResetHints() {
    try { localStorage.removeItem('reader_hintsSeen'); } catch (_) {}
    setResetHintsMsg('Hint will replay on the next chapter open.');
    setTimeout(() => setResetHintsMsg(null), 3000);
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Reading Settings</h2>
          <p className="sp-section-desc">
            Default settings used when opening the reader. All of these can also be changed
            from within the reader itself.
          </p>
        </div>
      </div>

      {/* General */}
      <div className="rs-group">
        <p className="rs-group-title">General</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Reading Mode</label>
            <div className="setting-options setting-options-grid">
              {[
                { value: 'ltr',      label: 'Left to Right' },
                { value: 'rtl',      label: 'Right to Left' },
                { value: 'vertical', label: 'Vertical' },
                { value: 'webtoon',  label: 'Webtoon' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${readingMode === value ? ' active' : ''}`}
                  onClick={() => setReadingMode(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Reading Orientation</label>
            <p className="rs-setting-hint">Controls which side the next page appears on in double-page mode.</p>
            <div className="setting-options">
              {[
                { value: 'ltr', label: 'Left to Right' },
                { value: 'rtl', label: 'Right to Left' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${readingOrientation === value ? ' active' : ''}`}
                  onClick={() => setReadingOrientation(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Page Transition</label>
            <p className="rs-setting-hint">Animation played when turning pages in paged modes.</p>
            <div className="setting-options setting-options-grid">
              {[
                { value: 'off',   label: 'Off' },
                { value: 'slide', label: 'Slide' },
                { value: 'fade',  label: 'Fade' },
                { value: 'curl',  label: 'Curl' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn${pageAnimation === value ? ' active' : ''}`}
                  onClick={() => setPageAnimation(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Animation Speed</label>
            <p className="rs-setting-hint">
              {pageAnimation === 'off'
                ? 'Choose a transition style above to adjust speed.'
                : 'Multiplier applied to the page-turn animation duration.'}
            </p>
            <div className="setting-slider-row">
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.25}
                value={pageAnimSpeed}
                disabled={pageAnimation === 'off'}
                onChange={e => setPageAnimSpeed(clampAnimSpeed(Number(e.target.value)))}
                className="setting-slider"
              />
              <span className="setting-slider-label">{pageAnimSpeed}×</span>
            </div>
          </div>

          <div className="rs-divider" />

          <ToggleRow
            label="Show edge hints"
            desc="Faint arrows on screen edges show tap zones"
            value={showEdgeHints}
            onChange={setShowEdgeHints}
          />
          <ToggleRow
            label="Gestures"
            desc="Touch swipe, double-tap to zoom"
            value={gesturesEnabled}
            onChange={setGesturesEnabled}
          />
          <ToggleRow
            label="Always Full Screen"
            value={alwaysFullscreen}
            onChange={setAlwaysFullscreen}
          />

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Reset reader hints</label>
            <p className="rs-setting-hint">
              Replays the one-time edge-hint pulse the next time you open a chapter.
            </p>
            <button className="btn" onClick={handleResetHints} style={{ alignSelf: 'flex-start' }}>
              Reset hints
            </button>
            {resetHintsMsg && (
              <p className="rs-setting-hint" style={{ marginTop: 8, color: 'var(--accent, #4caf50)' }}>
                {resetHintsMsg}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Display */}
      <div className="rs-group">
        <p className="rs-group-title">Display</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Background Color</label>
            <div className="setting-options">
              {[
                { value: 'black', label: 'Black' },
                { value: 'gray',  label: 'Gray' },
                { value: 'white', label: 'White' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`setting-btn setting-btn-color setting-btn-color-${value}${bgColor === value ? ' active' : ''}`}
                  onClick={() => setBgColor(value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="rs-divider" />

          <ToggleRow
            label="Grayscale"
            desc="Render pages without color"
            value={grayscale}
            onChange={setGrayscale}
          />
        </div>
      </div>

      {/* Paged Mode */}
      <div className="rs-group">
        <p className="rs-group-title">Paged Mode</p>
        <div className="settings-card">
          <div className="setting-group">
            <label className="setting-group-label">Scale Type</label>
            <select
              className="setting-select"
              value={scaleType}
              onChange={e => setScaleType(e.target.value)}
            >
              <option value="screen">Screen</option>
              <option value="fit-width">Fit Width</option>
              <option value="fit-width-shrink">Fit Width (Shrink Only)</option>
              <option value="fit-height">Fit Height</option>
              <option value="original">Original</option>
            </select>
          </div>

          <div className="rs-divider" />

          <div className="setting-group">
            <label className="setting-group-label">Page Layout</label>
            <select
              className="setting-select"
              value={pageLayout}
              onChange={e => setPageLayout(e.target.value)}
            >
              <option value="single">Single Page</option>
              <option value="double">Double Page</option>
              <option value="double-manga">Double Page (Manga)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Advanced */}
      <div className="rs-group">
        <p className="rs-group-title">Advanced</p>
        <div className="settings-card">
          <ToggleRow
            label="Preload upcoming pages"
            desc="Warm the next few page images of the CURRENT chapter into the browser cache so tapping forward feels instant. Skipped on metered (Save-Data) connections. Does not download images you don't read — it only nudges the browser to fetch the next few in parallel."
            value={prefetchPages}
            onChange={setPrefetchPages}
          />
          <ToggleRow
            label="Fast chapter open"
            desc="Open CBZ chapters as soon as the first few pages are extracted; the rest of the archive extracts in the background. Cuts the wait on the first page noticeably for large volumes. Only affects CBZ chapters — folder-based chapters open instantly either way."
            value={fastChapterOpen}
            onChange={setFastChapterOpen}
          />
          <ToggleRow
            label="Pre-load next chapter"
            desc="Start preparing the next chapter on the server as you near the end of the current one, so navigating to it is near-instant. Combine with Fast chapter open for the biggest improvement. Skipped on metered (Save-Data) connections."
            value={predictNextChapter}
            onChange={setPredictNextChapter}
          />
          {isAndroid() && (
            <>
              <ToggleRow
                label="Volume buttons turn pages"
                desc="Use the device's volume keys to turn pages in paged modes: Volume Up = next page, Volume Down = previous page. Same effect as tapping the side of the screen. Has no effect in webtoon / continuous-scroll mode."
                value={volumeButtonNav}
                onChange={setVolumeButtonNav}
              />
              {volumeButtonNav && (
                <ToggleRow
                  label="Reverse volume buttons"
                  desc="Swap the mapping so Volume Down = next page and Volume Up = previous page."
                  value={volumeButtonReverse}
                  onChange={setVolumeButtonReverse}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
