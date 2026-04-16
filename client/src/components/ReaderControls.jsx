import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import './ReaderControls.css';

function ToggleSetting({ label, desc, value, onChange }) {
  return (
    <div className="setting-row">
      <div className="setting-row-info">
        <span className="setting-row-label">{label}</span>
        {desc && <span className="setting-row-desc">{desc}</span>}
      </div>
      <button
        className={`toggle-switch ${value ? 'on' : ''}`}
        onClick={e => { e.stopPropagation(); onChange(!value); }}
        role="switch"
        aria-checked={value}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

function IconFullscreenEnter() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 1h4v1.5h-2.5v2.5h-1.5zm9 0h4v4h-1.5v-2.5h-2.5v-1.5zm-9 9h1.5v2.5h2.5v1.5h-4zm11.5 2.5v-2.5h1.5v4h-4v-1.5z"/>
    </svg>
  );
}

function IconFullscreenExit() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M5.5 0v1.5h-4v4h-1.5v-5.5zm5 0h5.5v5.5h-1.5v-4h-4v-1.5zm-10.5 10.5h5.5v5.5h-1.5v-4h-4v-1.5zm9 0h1.5v4h4v1.5h-5.5z"/>
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0"/>
      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z"/>
    </svg>
  );
}

export default function ReaderControls({
  show,
  chapter,
  manga,
  currentPage,
  totalPages,
  readingMode,
  zoom,
  animateTransitions,
  gesturesEnabled,
  alwaysFullscreen,
  bgColor,
  grayscale,
  brightness,
  scaleType,
  pageLayout,
  showSettings,
  hasPrevChapter,
  hasNextChapter,
  mangaId,
  isFullscreen,
  onReadingModeChange,
  onZoomChange,
  onAnimateTransitionsChange,
  onGesturesChange,
  onAlwaysFullscreenChange,
  onBgColorChange,
  onGrayscaleChange,
  onBrightnessChange,
  onScaleTypeChange,
  onPageLayoutChange,
  readingOrientation,
  onReadingOrientationChange,
  onSetPageAsThumbnail,
  onToggleSettings,
  onToggleFullscreen,
  onPrevChapter,
  // onToggleControls unused — controls are toggled via center tap in ReaderPaged
  onNextChapter,
  onPageChange,
  onScrubStart,
  onScrubEnd,
}) {
  const [activeTab, setActiveTab] = useState('general');
  const [thumbStatus, setThumbStatus] = useState('idle'); // idle | loading | done | error

  async function handleSetThumbnail() {
    setThumbStatus('loading');
    try {
      await onSetPageAsThumbnail();
      setThumbStatus('done');
      setTimeout(() => setThumbStatus('idle'), 2000);
    } catch {
      setThumbStatus('error');
      setTimeout(() => setThumbStatus('idle'), 2000);
    }
  }
  const backUrl = mangaId ? `/manga/${mangaId}` : '/';
  const unitLabel = manga?.track_volumes ? 'Volume' : 'Chapter';
  const chapterTitle = chapter
    ? (chapter.volume !== null && chapter.number !== null)
        ? `Vol. ${chapter.volume} Ch. ${chapter.number}`
        : chapter.volume !== null
          ? `Volume ${chapter.volume}`
          : chapter.number !== null
            ? `${unitLabel} ${chapter.number}`
            : chapter.folder_name
    : '';

  return (
    <>
      {/* Top bar */}
      <div className={`reader-bar reader-bar-top ${show ? 'visible' : ''}`} onClick={e => e.stopPropagation()}>
        <Link to={backUrl} className="reader-btn">← Back</Link>
        <div className="reader-bar-titles">
          {manga && <span className="reader-manga-title">{manga.title}</span>}
          <span className="reader-chapter-title">{chapterTitle}</span>
        </div>
        <div className="reader-top-actions">
          <button
            className="reader-btn reader-btn-icon"
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            {isFullscreen ? <IconFullscreenExit /> : <IconFullscreenEnter />}
          </button>
          <button
            className={`reader-btn reader-btn-icon ${showSettings ? 'active' : ''}`}
            onClick={onToggleSettings}
            title="Reader Settings"
          >
            <IconGear />
          </button>
        </div>
      </div>

      {/* Bottom bar */}
      <div className={`reader-bar reader-bar-bottom ${show ? 'visible' : ''}`} onClick={e => e.stopPropagation()}>
        <button className="reader-btn" disabled={!hasPrevChapter} onClick={onPrevChapter}>
          ‹ Prev
        </button>

        <div className="reader-page-info">
          <span>{currentPage + 1} / {totalPages}</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, totalPages - 1)}
            value={currentPage}
            onChange={e => onPageChange(parseInt(e.target.value, 10))}
            onPointerDown={onScrubStart}
            onPointerUp={onScrubEnd}
            className="reader-scrubber"
          />
        </div>

        <div className="reader-zoom-bar">
          <button
            className="reader-btn reader-btn-icon"
            onClick={() => onZoomChange(Math.max(25, zoom - 25))}
            title="Zoom out"
          >−</button>
          <input
            type="range"
            min={25}
            max={200}
            step={25}
            value={zoom}
            onChange={e => onZoomChange(Number(e.target.value))}
            className="reader-zoom-slider"
          />
          <button
            className="reader-btn reader-btn-icon"
            onClick={() => onZoomChange(Math.min(200, zoom + 25))}
            title="Zoom in"
          >+</button>
          <span className="reader-zoom-label">{zoom}%</span>
        </div>

        <button className="reader-btn" disabled={!hasNextChapter} onClick={onNextChapter}>
          Next ›
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="reader-settings" onClick={e => e.stopPropagation()}>
          <div className="settings-tabs">
            <button
              className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
              onClick={() => setActiveTab('general')}
            >General</button>
            <button
              className={`settings-tab ${activeTab === 'display' ? 'active' : ''}`}
              onClick={() => setActiveTab('display')}
            >Display</button>
            <button
              className={`settings-tab ${activeTab === 'paged' ? 'active' : ''}`}
              onClick={() => setActiveTab('paged')}
            >Paged</button>
          </div>

          <div className="settings-tab-content">
            {activeTab === 'general' && (
              <>
                <div className="setting-group">
                  <label className="setting-group-label">Reading Mode</label>
                  <div className="setting-options setting-options-grid">
                    {[
                      { value: 'ltr', label: 'Left to Right' },
                      { value: 'rtl', label: 'Right to Left' },
                      { value: 'vertical', label: 'Vertical' },
                      { value: 'webtoon', label: 'Webtoon' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        className={`setting-btn ${readingMode === value ? 'active' : ''}`}
                        onClick={() => onReadingModeChange(value)}
                      >{label}</button>
                    ))}
                  </div>
                </div>

                <div className="setting-group">
                  <label className="setting-group-label">Reading Orientation</label>
                  <div className="setting-options">
                    {[
                      { value: 'ltr', label: 'Left to Right' },
                      { value: 'rtl', label: 'Right to Left' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        className={`setting-btn ${readingOrientation === value ? 'active' : ''}`}
                        onClick={() => onReadingOrientationChange(value)}
                      >{label}</button>
                    ))}
                  </div>
                </div>

                <ToggleSetting
                  label="Animate Page Transition"
                  value={animateTransitions}
                  onChange={onAnimateTransitionsChange}
                />
                <ToggleSetting
                  label="Gestures"
                  desc="Touch swipe, double-tap to zoom"
                  value={gesturesEnabled}
                  onChange={onGesturesChange}
                />
                <ToggleSetting
                  label="Always Full Screen"
                  value={alwaysFullscreen}
                  onChange={onAlwaysFullscreenChange}
                />

                <button
                  className={`setting-btn setting-btn-full ${thumbStatus === 'done' ? 'setting-btn-success' : thumbStatus === 'error' ? 'setting-btn-error' : ''}`}
                  disabled={thumbStatus === 'loading' || !mangaId}
                  onClick={handleSetThumbnail}
                >
                  {thumbStatus === 'loading' ? 'Saving…'
                    : thumbStatus === 'done'    ? 'Thumbnail saved!'
                    : thumbStatus === 'error'   ? 'Failed — try again'
                    : 'Make Current Image Thumbnail'}
                </button>
              </>
            )}

            {activeTab === 'display' && (
              <>
                <div className="setting-group">
                  <label className="setting-group-label">Background Color</label>
                  <div className="setting-options">
                    {[
                      { value: 'black', label: 'Black' },
                      { value: 'gray', label: 'Gray' },
                      { value: 'white', label: 'White' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        className={`setting-btn setting-btn-color setting-btn-color-${value} ${bgColor === value ? 'active' : ''}`}
                        onClick={() => onBgColorChange(value)}
                      >{label}</button>
                    ))}
                  </div>
                </div>

                <ToggleSetting
                  label="Grayscale"
                  desc="Render pages without color"
                  value={grayscale}
                  onChange={onGrayscaleChange}
                />

                <div className="setting-group">
                  <label className="setting-group-label">Brightness</label>
                  <div className="setting-slider-row">
                    <input
                      type="range"
                      min={10}
                      max={100}
                      step={5}
                      value={brightness}
                      onChange={e => onBrightnessChange(Number(e.target.value))}
                      className="setting-slider"
                    />
                    <span className="setting-slider-label">{brightness}%</span>
                  </div>
                </div>
              </>
            )}

            {activeTab === 'paged' && (
              <>
                <div className="setting-group">
                  <label className="setting-group-label">Scale Type</label>
                  <select
                    className="setting-select"
                    value={scaleType}
                    onChange={e => onScaleTypeChange(e.target.value)}
                    onClick={e => e.stopPropagation()}
                  >
                    <option value="screen">Screen</option>
                    <option value="fit-width">Fit Width</option>
                    <option value="fit-width-shrink">Fit Width (Shrink Only)</option>
                    <option value="fit-height">Fit Height</option>
                    <option value="original">Original</option>
                  </select>
                </div>

                <div className="setting-group">
                  <label className="setting-group-label">Page Layout</label>
                  <select
                    className="setting-select"
                    value={pageLayout}
                    onChange={e => onPageLayoutChange(e.target.value)}
                    onClick={e => e.stopPropagation()}
                  >
                    <option value="single">Single Page</option>
                    <option value="double">Double Page</option>
                    <option value="double-manga">Double Page (Manga)</option>
                  </select>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
