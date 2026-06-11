import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { useMountedRef } from '../../hooks/useMountedRef';
import '../Settings.css';

// ── Section: Third Party Sourcing ─────────────────────────────────────────────
//
// Exposes the two knobs the in-process download queue reads: how many
// chapters can run concurrently, and how long to sleep between page fetches
// inside one chapter. Both are saved server-side; the queue hot-reloads.

// Bounds mirror the documented ranges (and the server's own clamp). HTML
// min/max only constrains the spinner arrows — typed values can still exceed
// them — so we clamp on save, matching DatabaseSection / PortForwardingSection.
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;
const PAGE_DELAY_MIN  = 0;
const PAGE_DELAY_MAX  = 60_000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export default function ThirdPartySourcingSection() {
  const [concurrency, setConcurrency] = useState(1);
  const [pageDelay,   setPageDelay]   = useState(500);
  const [savedFlash,  setSavedFlash]  = useState(null);
  const [error,       setError]       = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [loaded,      setLoaded]      = useState(false);
  const mounted = useMountedRef();

  useEffect(() => {
    api.getSettings().then(s => {
      if (s.tps_max_concurrent_chapters !== undefined) {
        setConcurrency(s.tps_max_concurrent_chapters);
      }
      if (s.tps_page_delay_ms !== undefined) {
        setPageDelay(s.tps_page_delay_ms);
      }
      setLoaded(true);
    }).catch(err => setError(err.message));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedFlash(null);
    // Clamp to the documented ranges before persisting, and reflect the
    // clamped values back into the inputs so the user sees what was saved.
    const safeConcurrency = clamp(concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX);
    const safePageDelay   = clamp(pageDelay, PAGE_DELAY_MIN, PAGE_DELAY_MAX);
    setConcurrency(safeConcurrency);
    setPageDelay(safePageDelay);
    try {
      await api.saveSettings({
        tps_max_concurrent_chapters: safeConcurrency,
        tps_page_delay_ms:           safePageDelay,
      });
      setSavedFlash('Saved.');
      setTimeout(() => { if (mounted.current) setSavedFlash(null); }, 1800);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Third Party Sourcing</h2>
          <p className="sp-section-desc">
            Tunes the in-app downloader that fetches chapters from MangaDex (and
            future sources). Defaults are intentionally polite to avoid getting
            rate-limited; raise them only if you've checked the source's terms.
          </p>
        </div>
      </div>

      {!loaded && (
        <div className="loading-center" style={{ minHeight: 80 }}><div className="spinner" /></div>
      )}

      {loaded && (
        <>
          <div className="settings-card" style={{ marginBottom: 16 }}>
            <div className="setting-group">
              <label className="setting-group-label" htmlFor="tps-concurrency">
                Concurrent chapters
              </label>
              <p className="rs-setting-hint">
                How many chapters the downloader works on at the same time.
                Conservative default is <strong>1</strong> — increase if you're
                downloading large backlogs and your network can handle it.
              </p>
              <input
                id="tps-concurrency"
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={e => setConcurrency(parseInt(e.target.value, 10) || 1)}
                className="setting-select"
                style={{ maxWidth: 120 }}
              />
            </div>
          </div>

          <div className="settings-card" style={{ marginBottom: 16 }}>
            <div className="setting-group">
              <label className="setting-group-label" htmlFor="tps-page-delay">
                Delay between page requests (ms)
              </label>
              <p className="rs-setting-hint">
                Pause inserted between consecutive image fetches inside a single
                chapter. <strong>500&nbsp;ms</strong> is a polite default for
                MangaDex@Home. Set to <code>0</code> to disable; the upper limit
                is <code>60000</code>.
              </p>
              <input
                id="tps-page-delay"
                type="number"
                min={0}
                max={60_000}
                step={50}
                value={pageDelay}
                onChange={e => setPageDelay(parseInt(e.target.value, 10) || 0)}
                className="setting-select"
                style={{ maxWidth: 160 }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {savedFlash && <span className="sp-status sp-status-success">{savedFlash}</span>}
            {error      && <span className="sp-status sp-status-error">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
}
