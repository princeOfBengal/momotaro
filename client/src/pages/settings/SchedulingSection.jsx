import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { appAlert, appConfirm } from '../../dialog/dialogService';
import '../Settings.css';

// ── Section: Scheduling ───────────────────────────────────────────────────────
//
// One row per scheduled manga, with the recorded source URLs inline so the
// user can see what each schedule will check. Add / edit / delete is done in
// place — same shape as the per-manga editor on MangaDetail, just without
// the URL-management surface (URLs continue to be edited from MangaDetail's
// Third Party Sources modal, since adding a URL needs the per-manga
// search/auto-record flow there).

const SCHED_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatScheduleSummary(s) {
  if (!s.frequency || !s.time_of_day) return '—';
  if (s.frequency === 'daily')  return `Daily at ${s.time_of_day}`;
  if (s.frequency === 'weekly') return `Weekly on ${SCHED_DAY_NAMES[s.day_of_week] || '?'} at ${s.time_of_day}`;
  return s.frequency;
}

function ScheduleEditForm({ initial, onSave, onCancel, busy }) {
  const [enabled,   setEnabled]   = useState(initial?.enabled !== 0);
  const [frequency, setFrequency] = useState(initial?.frequency   || 'daily');
  const [dayOfWeek, setDayOfWeek] = useState(initial?.day_of_week ?? 0);
  const [timeOfDay, setTimeOfDay] = useState(initial?.time_of_day || '09:00');

  function handleSubmit(e) {
    e.preventDefault();
    onSave({
      enabled,
      frequency,
      time_of_day: timeOfDay,
      day_of_week: frequency === 'weekly' ? dayOfWeek : null,
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Enabled
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Frequency</label>
        <select className="setting-select" value={frequency} onChange={e => setFrequency(e.target.value)} style={{ minWidth: 110 }}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      {frequency === 'weekly' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Day</label>
          <select className="setting-select" value={dayOfWeek} onChange={e => setDayOfWeek(parseInt(e.target.value, 10))} style={{ minWidth: 130 }}>
            {SCHED_DAY_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
          </select>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Time (server local)</label>
        <input className="setting-select" type="time" value={timeOfDay} onChange={e => setTimeOfDay(e.target.value)} style={{ minWidth: 110 }} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ScheduleAddForm({ existingMangaIds, onAdded, onCancel }) {
  const [query, setQuery]     = useState('');
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [pickedManga, setPickedManga] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState(null);

  // Debounced search against the FTS5-backed match-existing endpoint.
  useEffect(() => {
    if (pickedManga) return;
    if (!query.trim()) { setMatches([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.matchExistingManga(query.trim())
        .then(rows => {
          if (cancelled) return;
          // Filter out manga that already have a schedule (the caller passed
          // the set of currently-scheduled IDs).
          setMatches(rows.filter(r => !existingMangaIds.has(r.id)));
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, pickedManga, existingMangaIds]);

  async function handleSave(scheduleBody) {
    if (!pickedManga) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveMangaSchedule(pickedManga.id, scheduleBody);
      onAdded();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>Add a schedule</h3>

      {!pickedManga && (
        <>
          <input
            className="setting-select"
            type="text"
            placeholder="Search your library by title…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ width: '100%', maxWidth: 420 }}
            autoFocus
          />
          {searching && <p className="rs-setting-hint" style={{ marginTop: 6 }}>Searching…</p>}
          {!searching && query && matches.length === 0 && (
            <p className="rs-setting-hint" style={{ marginTop: 6 }}>
              No matches in your library{existingMangaIds.size > 0 ? ' (already-scheduled titles are hidden)' : ''}.
            </p>
          )}
          {matches.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {matches.map(m => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setPickedManga(m)}
                  >
                    {m.title}{m.library_name ? ` — ${m.library_name}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}

      {pickedManga && (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Adding schedule for <strong>{pickedManga.title}</strong>{' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPickedManga(null)}
              style={{ marginLeft: 6 }}
            >Pick a different manga</button>
          </p>
          <ScheduleEditForm
            initial={null}
            onSave={handleSave}
            onCancel={onCancel}
            busy={saving}
          />
          {error && <p className="sp-status sp-status-error" style={{ marginTop: 6 }}>{error}</p>}
          <p className="rs-setting-hint" style={{ marginTop: 8 }}>
            URLs to check are managed from this manga's <em>Third Party Sources</em> modal
            (manga detail page → top-bar icon next to Optimize).
          </p>
        </>
      )}
    </div>
  );
}

function ScheduleRow({ schedule, onChange }) {
  const [editing,   setEditing]   = useState(false);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState(null);
  const [running,   setRunning]   = useState(false);
  const [runResult, setRunResult] = useState(null);

  async function handleSave(body) {
    setBusy(true);
    setError(null);
    try {
      await api.saveMangaSchedule(schedule.manga_id, body);
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRunNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const r = await api.runMangaScheduleNow(schedule.manga_id);
      setRunResult(r);
      onChange();
    } catch (err) {
      setRunResult({ ok: false, summary: err.message });
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!(await appConfirm(`Remove the schedule for "${schedule.manga.title}"?`, { okLabel: 'Remove' }))) return;
    try {
      await api.deleteMangaSchedule(schedule.manga_id);
      onChange();
    } catch (err) {
      appAlert(err.message);
    }
  }

  return (
    <div className="settings-card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {schedule.manga.cover_url && (
          <img
            src={schedule.manga.cover_url}
            alt=""
            style={{ width: 48, height: 70, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Link to={`/manga/${schedule.manga.id}`} style={{ fontWeight: 600, fontSize: 15 }}>
              {schedule.manga.title}
            </Link>
            <span
              className="sp-status"
              style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 4,
                background: schedule.enabled ? 'var(--accent-dim, rgba(106,166,255,0.18))' : 'var(--bg-elev)',
                color: schedule.enabled ? 'var(--accent, #6aa6ff)' : 'var(--text-muted)',
              }}
            >
              {schedule.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>
            {formatScheduleSummary(schedule)}
            {schedule.next_run_at && schedule.enabled && (
              <> · next: {new Date(schedule.next_run_at * 1000).toLocaleString()}</>
            )}
          </p>
          {schedule.last_checked_at && (
            <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>
              Last run: {new Date(schedule.last_checked_at * 1000).toLocaleString()}
              {schedule.last_result && ` — ${schedule.last_result}`}
            </p>
          )}
        </div>
        {!editing && (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button className="btn btn-ghost btn-sm" onClick={handleRunNow} disabled={running}>
              {running ? 'Checking…' : 'Run now'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-ghost btn-sm" onClick={handleDelete}>Remove</button>
          </div>
        )}
      </div>

      {editing && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <ScheduleEditForm
            initial={schedule}
            onSave={handleSave}
            onCancel={() => { setEditing(false); setError(null); }}
            busy={busy}
          />
          {error && <p className="sp-status sp-status-error" style={{ marginTop: 6 }}>{error}</p>}
        </div>
      )}

      {runResult && (
        <p
          className="rs-setting-hint"
          style={{
            marginTop: 8,
            color: runResult.ok ? 'var(--success, #6c6)' : 'var(--danger, #f55)',
          }}
        >
          {runResult.summary}
          {runResult.enqueued > 0 && ' — see Downloads in Third Party Sourcing.'}
        </p>
      )}

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <div style={{
          fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
          color: 'var(--text-muted)', marginBottom: 6,
        }}>
          URLs that will be checked ({schedule.urls.length})
        </div>
        {schedule.urls.length === 0 && (
          <p className="rs-setting-hint" style={{ margin: 0 }}>
            No URLs recorded — the schedule will run but find nothing to check.
            Add a URL from the manga's <em>Third Party Sources</em> modal.
          </p>
        )}
        {schedule.urls.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {schedule.urls.map(u => (
              <li key={u.id} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{
                  fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
                  color: 'var(--text-muted)', minWidth: 70,
                }}>
                  {u.source}
                </span>
                <a href={u.url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                  {u.url}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function SchedulingSection() {
  const [schedules, setSchedules] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [adding,    setAdding]    = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    api.listSchedules()
      .then(setSchedules)
      .catch(err => setLoadError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const existingMangaIds = new Set((schedules || []).map(s => s.manga_id));

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Scheduling</h2>
          <p className="sp-section-desc">
            Auto-checks for new chapters from the third-party sources you've
            linked to each manga. Schedules fire on the server at the time
            shown (server local time); the poll cadence is one minute, so
            real fire time is the configured minute give or take 60 seconds.
          </p>
        </div>
        {!adding && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            Add schedule
          </button>
        )}
      </div>

      {loadError && (
        <div className="sp-status sp-status-error">Failed to load schedules: {loadError}</div>
      )}

      {adding && (
        <ScheduleAddForm
          existingMangaIds={existingMangaIds}
          onAdded={() => { setAdding(false); load(); }}
          onCancel={() => setAdding(false)}
        />
      )}

      {schedules === null && !loadError && (
        <div className="loading-center" style={{ minHeight: 100 }}><div className="spinner" /></div>
      )}

      {schedules && schedules.length === 0 && !adding && (
        <div className="settings-card">
          <p className="settings-hint" style={{ margin: 0 }}>
            No schedules yet. Click <strong>Add schedule</strong>, or open a
            manga and use the <em>Third Party Sources</em> button in the top
            bar to set one up there.
          </p>
        </div>
      )}

      {schedules && schedules.length > 0 && (
        <>
          <p className="rs-setting-hint" style={{ marginBottom: 10 }}>
            {schedules.length} scheduled manga.
          </p>
          {schedules.map(s => (
            <ScheduleRow key={s.id} schedule={s} onChange={load} />
          ))}
        </>
      )}
    </div>
  );
}
