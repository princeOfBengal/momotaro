import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api/client';
import { appAlert, appConfirm } from '../../dialog/dialogService';
import UserManagementBlock from '../../components/UserManagementBlock';
import { formatRelativeTime, formatCountdown, formatAbsoluteTime } from '../../utils/format';
import { AdminSetupForm, AdminLoginForm } from './AdminAuthForms';
import '../Settings.css';

// ── Section: Client Management ────────────────────────────────────────────────
// Backed by the Phase 1 pairing + admin-auth API. Three discrete states:
//
//   1. Admin password not yet set → show first-run setup form
//   2. Password set but no valid admin session → show login form
//   3. Authenticated → show the management UI (pending pairings, paired
//      clients list, security toggles, change password)
//
// Pending-pairings list polls every 2 s while visible. Polling stops on
// unmount (cleanup) and pauses while a network request is in flight, so a
// slow API or tab-throttled timer can't stack overlapping fetches.

// ── Connection log helpers ──────────────────────────────────────────────────

const EVENT_LABELS = {
  pairing_request:           'Pairing requested',
  pin_correct:               'PIN correct (paired)',
  pin_wrong:                 'Wrong PIN',
  lockout:                   'IP locked out (24h)',
  lockout_blocked:           'Locked IP blocked',
  pair_rate_limited:         'Rate-limited PIN submit',
  request_rate_limited:      'Rate-limited pairing request',
  client_request:            'Client heartbeat',
  admin_login_ok:            'Admin login',
  admin_login_fail:          'Admin login failed',
  admin_login_rate_limited:  'Rate-limited admin login',
  connection_log_exported:   'Connection log CSV exported',
  admin_action:              'Admin action',
  request_denied:            'Request denied',
  request_error:             'Request error (4xx/5xx)',
};

const FAILURE_TYPES = new Set([
  'pin_wrong', 'lockout', 'lockout_blocked', 'pair_rate_limited',
  'request_rate_limited', 'admin_login_fail', 'admin_login_rate_limited',
  'request_denied', 'request_error',
]);

const SUCCESS_TYPES = new Set([
  'pairing_request', 'pin_correct', 'admin_login_ok', 'client_request',
  'admin_action', 'connection_log_exported',
]);

const TIME_WINDOWS = [
  { value: 'all',  label: 'All time' },
  { value: '1h',   label: 'Last hour',  seconds: 3600 },
  { value: '24h',  label: 'Last 24h',   seconds: 86400 },
  { value: '7d',   label: 'Last 7d',    seconds: 7 * 86400 },
  { value: '30d',  label: 'Last 30d',   seconds: 30 * 86400 },
];

function eventLabel(t)  { return EVENT_LABELS[t] || t; }
function eventColor(t)  {
  if (FAILURE_TYPES.has(t)) return '#e6a17a';
  if (SUCCESS_TYPES.has(t)) return '#7adba6';
  return undefined;
}

// ISO-2 country code → flag emoji. Falls back to the raw code on unknowns.
function countryFlag(code) {
  if (!code || typeof code !== 'string' || code.length !== 2) return '';
  const A = 0x1F1E6;
  const cc = code.toUpperCase();
  const a = cc.charCodeAt(0);
  const b = cc.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return '';
  return String.fromCodePoint(A + a - 65) + String.fromCodePoint(A + b - 65);
}

function summariseLocation(e) {
  const parts = [];
  if (e.city)    parts.push(e.city);
  if (e.region && e.region !== e.city) parts.push(e.region);
  if (e.country) parts.push(e.country);
  return parts.join(', ');
}

function tryParseClientHints(json) {
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    return typeof o === 'object' && o !== null ? o : null;
  } catch { return null; }
}

// Wrap filter-object construction in a stable reference so `load`'s
// useCallback doesn't recreate on every keystroke pass-through.
function useMemoFilters(args) {
  return React.useMemo(() => {
    const out = {};
    if (args.severity && args.severity !== 'all') out.severity = args.severity;
    if (args.ip)        out.ip = args.ip;
    if (args.q)         out.q  = args.q;
    if (args.eventTypes && args.eventTypes.length > 0) out.event_type = args.eventTypes.join(',');
    if (args.timeWindow && args.timeWindow !== 'all') {
      const def = TIME_WINDOWS.find(w => w.value === args.timeWindow);
      if (def?.seconds) out.since = Math.floor(Date.now() / 1000) - def.seconds;
    }
    return out;
  }, [args.severity, args.ip, args.q, args.timeWindow, args.eventTypes.join(',')]);
}

function EventDetail({ event: e }) {
  const hints = tryParseClientHints(e.client_hints);
  const rows = [
    ['Occurred at',     formatAbsoluteTime(e.occurred_at)],
    ['Event type',      e.event_type],
    ['Auth kind',       e.auth_kind || '—'],
    ['IP (req.ip)',     e.ip],
    ['Real IP',         e.real_ip],
    ['Forwarded-For',   e.forwarded_for],
    ['Reverse DNS',     e.reverse_dns],
    ['Country',         e.country ? `${countryFlag(e.country)} ${e.country}` : ''],
    ['Region',          e.region],
    ['City',            e.city],
    ['Timezone',        e.timezone],
    ['OS',              e.os],
    ['Browser',         e.browser],
    ['Device type',     e.device_type],
    ['Platform',        e.platform],
    ['Device name',     e.device_name],
    ['Accept-Language', e.accept_language],
    ['DNT',             e.dnt == null ? '' : (e.dnt ? '1 (Do-Not-Track)' : '0')],
    ['Method',          e.method],
    ['Path',            e.path],
    ['Status code',     e.status_code == null ? '' : String(e.status_code)],
    ['Protocol',        e.protocol],
    ['Host',            e.host],
    ['Origin',          e.origin],
    ['Referer',         e.referer],
    ['Pairing ID',      e.pairing_id],
    ['Paired client',   e.paired_client_id == null ? '' : `#${e.paired_client_id}`],
    ['Detail',          e.detail],
    ['User agent',      e.user_agent],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <div className="cm-cl-detail">
      <dl className="cm-cl-detail-grid">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {hints && (
        <div className="cm-cl-detail-hints">
          <div className="cm-cl-detail-hints-title">Sec-CH-UA client hints</div>
          <pre className="cm-cl-detail-hints-pre">
            {JSON.stringify(hints, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ConnectionEventsView() {
  const [entries, setEntries] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  // Filters
  const [severity, setSeverity]   = useState('all');
  const [ip, setIp]               = useState('');
  const [q, setQ]                 = useState('');
  const [timeWindow, setTimeWindow] = useState('all');
  const [eventTypes, setEventTypes] = useState([]); // empty = all

  // Debounce text filters
  const [debouncedIp, setDebouncedIp] = useState('');
  const [debouncedQ,  setDebouncedQ]  = useState('');
  useEffect(() => { const t = setTimeout(() => setDebouncedIp(ip), 300); return () => clearTimeout(t); }, [ip]);
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q),   300); return () => clearTimeout(t); }, [q]);

  const filters = useMemoFilters({ severity, ip: debouncedIp, q: debouncedQ, timeWindow, eventTypes });

  const load = useCallback(async (cursor = null) => {
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const data = await api.getConnectionLog({
        ...filters,
        limit: 100,
        cursor: cursor || undefined,
      });
      const next = data?.entries || [];
      if (cursor) {
        setEntries(prev => [...prev, ...next]);
      } else {
        setEntries(next);
        setExpanded(new Set());
      }
      setNextCursor(data?.next_cursor || null);
      setTotal(data?.total || 0);
      setFilteredTotal(data?.filtered_total || 0);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      if (cursor) setLoadingMore(false); else setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(null); }, [load]);

  useEffect(() => {
    const onCleared = () => load(null);
    window.addEventListener('momotaro:connection-log-cleared', onCleared);
    return () => window.removeEventListener('momotaro:connection-log-cleared', onCleared);
  }, [load]);

  function toggleExpanded(id) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function toggleEventType(t) {
    setEventTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  }

  const allEventTypes = Object.keys(EVENT_LABELS);

  return (
    <>
      <div className="cm-cl-filters">
        <input
          type="text"
          className="settings-input cm-cl-input"
          placeholder="Filter by IP (substring, includes forwarded-for)"
          value={ip}
          onChange={e => setIp(e.target.value)}
        />
        <input
          type="text"
          className="settings-input cm-cl-input"
          placeholder="Search device name, user agent, country, path, referer…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={severity}
          onChange={e => setSeverity(e.target.value)}
        >
          <option value="all">All events</option>
          <option value="failures">Failures only</option>
          <option value="successes">Successes only</option>
        </select>
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={timeWindow}
          onChange={e => setTimeWindow(e.target.value)}
        >
          {TIME_WINDOWS.map(w => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>
      </div>

      <div className="cm-cl-chips">
        {allEventTypes.map(t => {
          const active = eventTypes.includes(t);
          return (
            <button
              key={t}
              type="button"
              className={`cm-cl-chip${active ? ' cm-cl-chip-on' : ''}`}
              onClick={() => toggleEventType(t)}
              style={active ? { borderColor: eventColor(t) || undefined, color: eventColor(t) || undefined } : undefined}
            >
              {eventLabel(t)}
            </button>
          );
        })}
        {eventTypes.length > 0 && (
          <button type="button" className="cm-cl-chip-clear" onClick={() => setEventTypes([])}>
            Clear ({eventTypes.length})
          </button>
        )}
      </div>

      {error && (
        <div className="cm-warning" style={{ marginBottom: 8 }}>
          Load failed: {error}
        </div>
      )}

      <div className="cm-cl-meta">
        {loading
          ? 'Loading…'
          : filteredTotal === total
            ? `${total.toLocaleString()} events`
            : `${filteredTotal.toLocaleString()} matching of ${total.toLocaleString()} total`}
      </div>

      {entries.length === 0 ? (
        <div className="cm-empty">
          {loading ? 'Loading…' : 'No events match these filters.'}
        </div>
      ) : (
        <div className="cm-cl-table-wrap">
          <table className="cm-cl-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Source</th>
                <th>Device</th>
                <th>Request</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => {
                const isOpen = expanded.has(e.id);
                const flag = countryFlag(e.country);
                const loc  = summariseLocation(e);
                return (
                  <React.Fragment key={e.id}>
                    <tr className={`cm-cl-row${isOpen ? ' cm-cl-row-open' : ''}`}>
                      <td title={formatAbsoluteTime(e.occurred_at)}>
                        {formatRelativeTime(e.occurred_at)}
                      </td>
                      <td style={{ color: eventColor(e.event_type) }}>
                        {eventLabel(e.event_type)}
                      </td>
                      <td>
                        <div className="cm-cl-mono">{e.real_ip || e.ip || '—'}</div>
                        {(loc || e.reverse_dns) && (
                          <div className="cm-cl-sub">
                            {flag && <span style={{ marginRight: 4 }}>{flag}</span>}
                            {loc}
                            {e.reverse_dns && <span className="cm-cl-rdns"> · {e.reverse_dns}</span>}
                          </div>
                        )}
                      </td>
                      <td>
                        <div>{[e.device_name, e.platform].filter(Boolean).join(' · ') || '—'}</div>
                        <div className="cm-cl-sub">
                          {[e.device_type, e.os, e.browser].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td>
                        {e.method && e.path ? (
                          <div className="cm-cl-mono cm-cl-path">
                            <span className="cm-cl-method">{e.method}</span> {e.path}
                            {e.status_code != null && (
                              <span className="cm-cl-status"> {e.status_code}</span>
                            )}
                          </div>
                        ) : e.detail ? (
                          <div className="cm-cl-sub">{e.detail}</div>
                        ) : (
                          <span className="cm-cl-sub">—</span>
                        )}
                      </td>
                      <td className="cm-cl-expand-col">
                        <button
                          type="button"
                          className="cm-cl-expand-btn"
                          onClick={() => toggleExpanded(e.id)}
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="cm-cl-detail-row">
                        <td colSpan={6}>
                          <EventDetail event={e} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => load(nextCursor)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

function ConnectionSourcesView() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [filter, setFilter]     = useState('');
  const [sort, setSort]             = useState('last_seen'); // last_seen | event_count | failure_count | first_seen
  const [timeWindow, setTimeWindow] = useState('30d');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const def = TIME_WINDOWS.find(w => w.value === timeWindow);
      const since = def?.seconds
        ? Math.floor(Date.now() / 1000) - def.seconds
        : undefined;
      const data = await api.getConnectionSources(since);
      setSources(data?.sources || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [timeWindow]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onCleared = () => load();
    window.addEventListener('momotaro:connection-log-cleared', onCleared);
    return () => window.removeEventListener('momotaro:connection-log-cleared', onCleared);
  }, [load]);

  const filtered = React.useMemo(() => {
    const f = filter.trim().toLowerCase();
    let rows = sources;
    if (f) {
      rows = rows.filter(s =>
        [s.source_ip, s.reverse_dns, s.country, s.city, s.region,
         s.device_name, s.user_agent, s.os, s.browser, s.platform]
          .some(v => v && String(v).toLowerCase().includes(f))
      );
    }
    const sorted = rows.slice().sort((a, b) => {
      const av = a[sort] ?? 0;
      const bv = b[sort] ?? 0;
      return bv - av;
    });
    return sorted;
  }, [sources, filter, sort]);

  return (
    <>
      <div className="cm-cl-filters">
        <input
          type="text"
          className="settings-input cm-cl-input"
          placeholder="Filter by IP, hostname, country, device, browser…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={sort}
          onChange={e => setSort(e.target.value)}
        >
          <option value="last_seen">Sort: most recent</option>
          <option value="first_seen">Sort: oldest</option>
          <option value="event_count">Sort: most events</option>
          <option value="failure_count">Sort: most failures</option>
        </select>
        <select
          className="settings-input cm-cl-input cm-cl-input-narrow"
          value={timeWindow}
          onChange={e => setTimeWindow(e.target.value)}
        >
          {TIME_WINDOWS.filter(w => w.value !== 'all').map(w => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="cm-warning" style={{ marginBottom: 8 }}>
          Load failed: {error}
        </div>
      )}

      <div className="cm-cl-meta">
        {loading ? 'Loading…' :
          `${filtered.length.toLocaleString()} unique source${filtered.length === 1 ? '' : 's'}` +
          (filter ? ` matching "${filter}"` : '')
        }
      </div>

      {filtered.length === 0 ? (
        <div className="cm-empty">
          {loading ? 'Loading…' : 'No sources in this window.'}
        </div>
      ) : (
        <div className="cm-cl-table-wrap">
          <table className="cm-cl-table">
            <thead>
              <tr>
                <th>Source IP / hostname</th>
                <th>Location</th>
                <th>Device</th>
                <th>Events</th>
                <th>First seen</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const flag = countryFlag(s.country);
                const loc  = summariseLocation(s);
                return (
                  <tr key={`${s.source_ip}|${s.paired_client_id ?? ''}|${s.user_agent ?? ''}`}>
                    <td>
                      <div className="cm-cl-mono">{s.source_ip || '—'}</div>
                      {s.reverse_dns && <div className="cm-cl-sub">{s.reverse_dns}</div>}
                      {s.paired_client_id && (
                        <div className="cm-cl-sub cm-cl-paired-badge">
                          Paired client #{s.paired_client_id}
                          {s.device_name ? ` · ${s.device_name}` : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {flag && <span style={{ marginRight: 4 }}>{flag}</span>}
                      {loc || <span className="cm-cl-sub">—</span>}
                      {s.timezone && <div className="cm-cl-sub">{s.timezone}</div>}
                    </td>
                    <td>
                      <div>{[s.device_type, s.platform].filter(Boolean).join(' · ') || '—'}</div>
                      <div className="cm-cl-sub">
                        {[s.os, s.browser].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      <div>{(s.event_count || 0).toLocaleString()} total</div>
                      {s.failure_count > 0 && (
                        <div className="cm-cl-sub" style={{ color: '#e6a17a' }}>
                          {s.failure_count} failure{s.failure_count === 1 ? '' : 's'}
                        </div>
                      )}
                      {s.pair_count > 0 && (
                        <div className="cm-cl-sub" style={{ color: '#7adba6' }}>
                          {s.pair_count} pair{s.pair_count === 1 ? '' : 's'}
                        </div>
                      )}
                      {s.admin_login_count > 0 && (
                        <div className="cm-cl-sub">
                          {s.admin_login_count} admin login{s.admin_login_count === 1 ? '' : 's'}
                        </div>
                      )}
                    </td>
                    <td title={formatAbsoluteTime(s.first_seen)}>
                      {formatRelativeTime(s.first_seen)}
                    </td>
                    <td title={formatAbsoluteTime(s.last_seen)}>
                      {formatRelativeTime(s.last_seen)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ConnectionLogBlock({ setStatusMsg }) {
  const [tab, setTab] = useState('events'); // 'events' | 'sources'
  const [downloading, setDownloading] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      await api.downloadConnectionLogCsv();
      setStatusMsg({ type: 'success', text: 'Connection log CSV downloaded.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Download failed: ' + err.message });
    } finally {
      setDownloading(false);
    }
  }

  async function handleClear() {
    if (!(await appConfirm('Delete every entry from the connection log? This cannot be undone — export the CSV first if you might need it later.', { danger: true, okLabel: 'Delete' }))) return;
    setClearing(true);
    try {
      await api.clearConnectionLog();
      setStatusMsg({ type: 'success', text: 'Connection log cleared.' });
      // Bump a refresh signal — pass through via a key on the inner views.
      window.dispatchEvent(new CustomEvent('momotaro:connection-log-cleared'));
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Clear failed: ' + err.message });
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="cm-block">
      <p className="cm-block-title">Connection log</p>
      <div className="cm-toggle-help" style={{ marginBottom: 10 }}>
        Every pairing attempt, wrong-PIN guess, lockout, denied API request,
        and admin action is logged. For each event we capture the IP, real
        IP (forwarded headers), reverse-DNS hostname, GeoIP country / city,
        OS, browser, device type, Accept-Language, Sec-CH-UA client hints,
        request method + path, response status, and how the request was
        authorised. Switch to <strong>Sources</strong> for a one-row-per-source
        rollup that surfaces unique visitors at a glance.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          className={`btn ${tab === 'events' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
          onClick={() => setTab('events')}
        >
          Events
        </button>
        <button
          className={`btn ${tab === 'sources' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
          onClick={() => setTab('sources')}
        >
          Sources
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-primary btn-sm"
          onClick={handleDownload}
          disabled={downloading}
        >
          {downloading ? 'Preparing CSV…' : 'Download full CSV'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleClear}
          disabled={clearing}
        >
          {clearing ? 'Clearing…' : 'Clear log'}
        </button>
      </div>

      {tab === 'events' ? <ConnectionEventsView /> : <ConnectionSourcesView />}
    </div>
  );
}

function PinLockoutControl({ settings, onChanged, setStatusMsg }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings && typeof settings.max_attempts === 'number') {
      setDraft(String(settings.max_attempts));
    }
  }, [settings?.max_attempts]);

  if (!settings) {
    return (
      <div className="cm-toggle-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div className="cm-toggle-label">Pairing PIN brute-force protection</div>
        <div className="cm-toggle-help">Loading…</div>
      </div>
    );
  }

  const min = settings.min_max_attempts || 1;
  const max = settings.max_max_attempts || 100;
  const def = settings.default_max_attempts || 5;
  const parsed = parseInt(draft, 10);
  const valid = Number.isFinite(parsed) && parsed >= min && parsed <= max;
  const dirty = String(settings.max_attempts) !== draft.trim();

  async function handleSave() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await api.savePairingPinSettings({ max_attempts: parsed });
      setStatusMsg({ type: 'success', text: `Pairing PIN attempt cap set to ${parsed}.` });
      onChanged();
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleClearLockout(ip) {
    if (!(await appConfirm(`Clear the 24-hour pairing lockout for ${ip}?`, { okLabel: 'Clear' }))) return;
    try {
      await api.clearPairingPinLockout(ip);
      setStatusMsg({ type: 'success', text: `Cleared lockout for ${ip}.` });
      onChanged();
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Clear failed: ' + err.message });
    }
  }

  const lockouts = Array.isArray(settings.active_lockouts) ? settings.active_lockouts : [];

  return (
    <>
      <div className="cm-toggle-row" style={{ flexWrap: 'wrap', rowGap: 10 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="cm-toggle-label">Max wrong PIN attempts before lockout</div>
          <div className="cm-toggle-help">
            After this many wrong PIN guesses from the same IP, pairing is
            blocked from that IP for 24 hours. Default is {def}.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            className="pf-port-input"
            value={draft}
            min={min}
            max={max}
            onChange={e => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            style={{ width: 80 }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={!valid || !dirty || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {!valid && draft !== '' && (
        <div className="cm-warning" style={{ marginTop: -2 }}>
          Enter an integer between {min} and {max}.
        </div>
      )}

      {lockouts.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="cm-toggle-help" style={{ marginBottom: 6 }}>
            Currently locked out:
          </div>
          {lockouts.map(l => {
            const remaining = Math.max(0, l.locked_until - Math.floor(Date.now() / 1000));
            const hrs = Math.floor(remaining / 3600);
            const mins = Math.floor((remaining % 3600) / 60);
            return (
              <div key={l.ip} className="cm-card">
                <div className="cm-card-main">
                  <div className="cm-device-name">{l.ip}</div>
                  <div className="cm-device-meta">
                    <span>{l.failed_attempts} wrong attempts</span>
                    <span>unlocks in {hrs}h {mins}m</span>
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleClearLockout(l.ip)}
                >
                  Clear
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function ChangePasswordForm({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext]       = useState('');
  const [next2, setNext2]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (next !== next2)  { setError('New passwords do not match.'); return; }
    setSaving(true);
    try {
      await api.changeAdminPassword(current, next);
      onDone({ type: 'success', text: 'Password changed.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card" style={{ marginTop: 12 }}>
      <form className="settings-token-form" onSubmit={handleSubmit}>
        <label className="settings-label">Current password</label>
        <input
          type="password"
          className="settings-input"
          value={current}
          onChange={e => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <label className="settings-label" style={{ marginTop: 8 }}>New password</label>
        <input
          type="password"
          className="settings-input"
          value={next}
          onChange={e => setNext(e.target.value)}
          autoComplete="new-password"
        />
        <label className="settings-label" style={{ marginTop: 8 }}>Confirm new password</label>
        <input
          type="password"
          className="settings-input"
          value={next2}
          onChange={e => setNext2(e.target.value)}
          autoComplete="new-password"
        />
        {error && <p className="lp-form-error" style={{ marginTop: 8 }}>{error}</p>}
        <div className="settings-token-actions">
          <button type="submit" className="btn btn-primary" disabled={saving || !current || !next || !next2}>
            {saving ? 'Saving...' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ClientManagementAuthed({ authStatus, onAuthChange, setStatusMsg }) {
  const [pending, setPending] = useState([]);
  const [clients, setClients] = useState([]);
  const [, setNow]            = useState(() => Math.floor(Date.now() / 1000));
  const [savingToggle, setSavingToggle] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [pinSettings, setPinSettings] = useState(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [p, c, ps] = await Promise.all([
        api.listPendingPairings().catch(() => []),
        api.listPairedClients().catch(() => []),
        api.getPairingPinSettings().catch(() => null),
      ]);
      setPending(Array.isArray(p) ? p : []);
      setClients(Array.isArray(c) ? c : []);
      if (ps) setPinSettings(ps);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 2000);
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [refresh]);

  async function handleCancelPending(id) {
    try {
      await api.cancelPendingPairing(id);
      setPending(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Cancel failed: ' + err.message });
    }
  }

  async function handleRevoke(id, deviceName) {
    if (!(await appConfirm(`Revoke access for "${deviceName}"? They will be signed out immediately.`, { danger: true, okLabel: 'Revoke' }))) return;
    try {
      await api.revokePairedClient(id);
      setClients(prev => prev.map(c => c.id === id ? { ...c, revoked: 1 } : c));
      setStatusMsg({ type: 'success', text: `Revoked "${deviceName}".` });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Revoke failed: ' + err.message });
    }
  }

  async function handleToggle(key, next) {
    setSavingToggle(true);
    try {
      await api.saveSecuritySettings({ [key]: next });
      onAuthChange();
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSavingToggle(false);
    }
  }

  async function handleLogout() {
    if (!(await appConfirm('Sign out of admin? Your saved password still works for next time.', { okLabel: 'Sign out' }))) return;
    try {
      await api.adminLogout();
      onAuthChange();
      setStatusMsg({ type: 'success', text: 'Signed out.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Sign-out failed: ' + err.message });
    }
  }

  const activeClients  = clients.filter(c => !c.revoked);
  const revokedClients = clients.filter(c =>  c.revoked);

  return (
    <>
      {/* ── User accounts (admin) ───────────────────────────────────── */}
      <UserManagementBlock
        authStatus={authStatus}
        setStatusMsg={setStatusMsg}
        onAuthChange={onAuthChange}
      />

      {/* ── Security toggles ────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">Security</p>

        {!authStatus.auth_enabled && (
          <div className="cm-warning">
            Authentication is currently <strong>off</strong>. Anyone who can
            reach this server can read your library. Turn it on once you have
            paired at least one device — otherwise you may lock yourself out.
          </div>
        )}

        {authStatus.auth_enabled
          && typeof window !== 'undefined'
          && window.location.protocol === 'http:' && (
          <div className="cm-warning">
            Authentication is on, but this server is being served over plain
            HTTP. Tokens are sent in the <code>Authorization</code> header in
            cleartext — fine on a trusted LAN, dangerous over the open
            internet. Front Momotaro with a TLS-terminating reverse proxy
            (Caddy, nginx, Cloudflare Tunnel) before exposing the port.
          </div>
        )}

        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Require authentication on all API requests</div>
            <div className="cm-toggle-help">
              When on, every request must present a paired-client token, an
              admin session, or come from a LAN address (if LAN bypass is on).
            </div>
          </div>
          <button
            className={`toggle-switch ${authStatus.auth_enabled ? 'on' : ''}`}
            onClick={() => handleToggle('auth_enabled', !authStatus.auth_enabled)}
            role="switch"
            aria-checked={!!authStatus.auth_enabled}
            disabled={savingToggle}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Allow LAN devices to skip pairing</div>
            <div className="cm-toggle-help">
              Devices on your home network (RFC1918 / loopback) connect
              without a token. Turn this off if you're on an untrusted LAN
              (e.g. shared office Wi-Fi).
            </div>
          </div>
          <button
            className={`toggle-switch ${authStatus.lan_bypass_enabled ? 'on' : ''}`}
            onClick={() => handleToggle('lan_bypass_enabled', !authStatus.lan_bypass_enabled)}
            role="switch"
            aria-checked={!!authStatus.lan_bypass_enabled}
            disabled={savingToggle}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <PinLockoutControl
          settings={pinSettings}
          onChanged={() => { refresh(); }}
          setStatusMsg={setStatusMsg}
        />
      </div>

      <div className="cm-divider" />

      {/* ── Pending pairings ────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">
          Pending pairings
          <span className="cm-block-count">{pending.length ? `(${pending.length})` : ''}</span>
        </p>

        {pending.length === 0 ? (
          <div className="cm-empty">
            No devices are waiting to pair. Open the Momotaro app on a new
            device and follow the on-screen instructions — a request will
            show up here automatically.
          </div>
        ) : (
          pending.map(p => (
            <div key={p.id} className="cm-card">
              <div className="cm-card-main">
                <div className="cm-device-name">{p.device_name}</div>
                <div className="cm-device-meta">
                  <span>{p.platform || 'unknown platform'}</span>
                  <span>from {p.ip || 'unknown IP'}</span>
                  {p.attempts > 0 && <span>{p.attempts} wrong attempts</span>}
                </div>
                <div className="cm-pin-row">
                  <span className="cm-pin">{p.pin}</span>
                  <span className="cm-pin-countdown">expires in {formatCountdown(p.expires_at)}</span>
                </div>
                <div className="cm-toggle-help">
                  Read this PIN to whoever is holding the device — they enter
                  it on the device's pairing screen.
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => handleCancelPending(p.id)}>
                Cancel
              </button>
            </div>
          ))
        )}
      </div>

      <div className="cm-divider" />

      {/* ── Paired clients ──────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">
          Paired devices
          <span className="cm-block-count">{activeClients.length ? `(${activeClients.length})` : ''}</span>
        </p>

        {activeClients.length === 0 ? (
          <div className="cm-empty">No paired devices yet.</div>
        ) : (
          activeClients.map(c => (
            <div key={c.id} className="cm-card">
              <div className="cm-card-main">
                <div className="cm-device-name">{c.device_name}</div>
                <div className="cm-device-meta">
                  <span>{c.platform || c.device_type || 'unknown platform'}</span>
                  {c.os && <span>{c.os}</span>}
                  {c.browser && <span>{c.browser}</span>}
                  <span>last seen {formatRelativeTime(c.last_seen_at)}</span>
                  {c.last_seen_ip && <span>from {c.last_seen_ip}</span>}
                  {typeof c.request_count === 'number' && (
                    <span>{c.request_count.toLocaleString()} requests</span>
                  )}
                  {c.first_seen_ip && c.first_seen_ip !== c.last_seen_ip && (
                    <span>first IP {c.first_seen_ip}</span>
                  )}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => handleRevoke(c.id, c.device_name)}
              >
                Revoke
              </button>
            </div>
          ))
        )}

        {revokedClients.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
              {revokedClients.length} revoked device{revokedClients.length === 1 ? '' : 's'}
            </summary>
            <div style={{ marginTop: 10 }}>
              {revokedClients.map(c => (
                <div key={c.id} className="cm-card" style={{ opacity: 0.6 }}>
                  <div className="cm-card-main">
                    <div className="cm-device-name">{c.device_name}</div>
                    <div className="cm-device-meta cm-device-meta-revoked">
                      <span>revoked</span>
                      {c.os && <span>{c.os}</span>}
                      {c.browser && <span>{c.browser}</span>}
                      {c.last_seen_ip && <span>last IP {c.last_seen_ip}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="cm-divider" />

      {/* ── Connection log (forensic CSV export) ────────────────────── */}
      <ConnectionLogBlock setStatusMsg={setStatusMsg} />

      <div className="cm-divider" />

      {/* ── Admin account ───────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">Admin account</p>
        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Signed in</div>
            <div className="cm-toggle-help">Sessions last 12 hours of inactivity, then you sign in again.</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Sign out</button>
        </div>
        <div className="cm-toggle-row">
          <div>
            <div className="cm-toggle-label">Password</div>
            <div className="cm-toggle-help">
              Changing your password signs out every other admin browser.
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowPasswordForm(v => !v)}
          >
            {showPasswordForm ? 'Cancel' : 'Change password'}
          </button>
        </div>

        {showPasswordForm && (
          <ChangePasswordForm
            onDone={(msg) => { setShowPasswordForm(false); setStatusMsg(msg); }}
          />
        )}
      </div>
    </>
  );
}

export default function ClientManagementSection() {
  const [authStatus, setAuthStatus] = useState(null); // null = loading
  const [statusMsg, setStatusMsg] = useState(null);

  const refreshAuthStatus = useCallback(async () => {
    try {
      const data = await api.getAuthStatus();
      setAuthStatus(data);
    } catch (err) {
      setAuthStatus({ configured: false, logged_in: false, auth_enabled: false, lan_bypass_enabled: false });
    }
  }, []);

  useEffect(() => { refreshAuthStatus(); }, [refreshAuthStatus]);

  if (authStatus === null) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  return (
    <div>
      <div className="sp-section-head">
        <div>
          <h2 className="sp-section-title">Client Management</h2>
          <p className="sp-section-desc">
            Pair external devices with this server using a one-time PIN and
            revoke access at any time. When auth enforcement is turned on,
            paired clients (or LAN devices, if you allow LAN bypass) are the
            only ones that can read your library.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      {!authStatus.configured && (
        <AdminSetupForm
          onDone={(msg) => { setStatusMsg(msg); refreshAuthStatus(); }}
        />
      )}

      {authStatus.configured && !authStatus.logged_in && (
        <AdminLoginForm
          onDone={(msg) => { setStatusMsg(msg); refreshAuthStatus(); }}
        />
      )}

      {authStatus.configured && authStatus.logged_in && (
        <ClientManagementAuthed
          authStatus={authStatus}
          onAuthChange={refreshAuthStatus}
          setStatusMsg={setStatusMsg}
        />
      )}
    </div>
  );
}
