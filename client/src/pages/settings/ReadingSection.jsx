import React, { useState } from 'react';
import ToggleRow from '../../components/ToggleRow';
import { isAndroid } from '../../api/volumeButtons';
import { useReaderSettings } from '../../hooks/useReaderSettings';
import {
  READING_MODE_OPTIONS,
  ORIENTATION_OPTIONS,
  PAGE_TRANSITION_OPTIONS,
  BG_COLOR_OPTIONS,
} from '../../constants/readerOptions';
import '../Settings.css';

export default function ReadingSection() {
  // All reader preferences come from the shared hook (keys, defaults, legacy
  // migrations, and persistence live there — see useReaderSettings). This page
  // surfaces the subset below; the reader itself uses the full set.
  const {
    readingMode, setReadingMode,
    readingOrientation, setReadingOrientation,
    pageAnimation, setPageAnimation,
    pageAnimSpeed, setPageAnimSpeed,
    showEdgeHints, setShowEdgeHints,
    fastChapterOpen, setFastChapterOpen,
    predictNextChapter, setPredictNextChapter,
    gesturesEnabled, setGesturesEnabled,
    alwaysFullscreen, setAlwaysFullscreen,
    bgColor, setBgColor,
    grayscale, setGrayscale,
    scaleType, setScaleType,
    pageLayout, setPageLayout,
    prefetchPages, setPrefetchPages,
    volumeButtonNav, setVolumeButtonNav,
    volumeButtonReverse, setVolumeButtonReverse,
  } = useReaderSettings();
  const [resetHintsMsg, setResetHintsMsg]         = useState(null);

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
              {READING_MODE_OPTIONS.map(({ value, label }) => (
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
              {ORIENTATION_OPTIONS.map(({ value, label }) => (
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
              {PAGE_TRANSITION_OPTIONS.map(({ value, label }) => (
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
                onChange={e => setPageAnimSpeed(Number(e.target.value))}
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
              {BG_COLOR_OPTIONS.map(({ value, label }) => (
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
