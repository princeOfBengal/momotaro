import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useConnectivity } from '../context/ConnectivityContext';
import OfflineLockedPanel from './settings/OfflineLockedPanel';
import { AdminSetupForm, AdminLoginForm } from './settings/AdminAuthForms';
import './Settings.css';

// ── Per-section lazy loading ─────────────────────────────────────────────────
//
// Each Settings section ships as its own chunk. The default landing section
// (`anilist`) is the only one whose chunk is fetched up-front during the
// router's `lazy(() => import('./pages/Settings'))` resolution; every other
// section is fetched on first visit. The sidebar pre-warms a section's chunk
// on hover / focus so the click-through swap is invisible on typical
// hardware.
//
// `OfflineLockedPanel`, `AdminAuthForms`, and the router shell itself stay
// eager — together they're ~150 LOC and they need to be available even when
// the network is unreliable (offline panel) or before any section chunk has
// resolved (admin gate).
//
// `SECTION_LOADERS` is the single source of truth: changing a section's
// home means editing one line here and one line in `SECTIONS` below.

const SECTION_LOADERS = {
  account:        () => import('../components/AccountSection'),
  statistics:     () => import('./settings/StatisticsSection'),
  anilist:        () => import('./settings/AnilistSection'),
  myanimelist:    () => import('./settings/MyAnimeListSection'),
  doujinshi:      () => import('./settings/DoujinshiSection'),
  homepage:       () => import('./settings/HomepageSection'),
  reading:        () => import('./settings/ReadingSection'),
  libraries:      () => import('./settings/LibrariesSection'),
  clients:        () => import('./settings/ClientManagementSection'),
  portforwarding: () => import('./settings/PortForwardingSection'),
  sourcing:       () => import('./settings/ThirdPartySourcingSection'),
  scheduling:     () => import('./settings/SchedulingSection'),
  database:       () => import('./settings/DatabaseSection'),
  logs:           () => import('./settings/SystemLogsSection'),
  android:        () => import('./settings/AndroidSection'),
  linux:          () => import('./settings/LinuxSection'),
  offline:        () => import('./settings/OfflineDownloadsSection'),
};

const LazySection = Object.fromEntries(
  Object.entries(SECTION_LOADERS).map(([id, loader]) => [id, lazy(loader)]),
);

// Sections whose API surface requires the admin password. Used both by the
// dispatch below (wraps in AdminGuard) and by the prefetch step (the chunk
// is still worth warming even if AdminGuard ends up showing the login form,
// since the user is likely to authenticate immediately after).
const ADMIN_GATED_SECTIONS = new Set([
  'libraries', 'sourcing', 'scheduling', 'database', 'logs',
]);

// Fire-and-forget chunk fetch. Webpack/Vite cache the import promise, so
// repeated calls collapse to a no-op after the first one resolves.
function prefetchSection(id) {
  const loader = SECTION_LOADERS[id];
  if (loader) { try { loader(); } catch { /* prefetch is best-effort */ } }
}

// ── Section skeleton ─────────────────────────────────────────────────────────
//
// Section-shaped fallback rendered by Suspense while the chunk is in flight.
// Matches the height of a typical section header + one card so the layout
// doesn't reflow when the real content swaps in. Far less jarring than a
// global spinner inside an already-painted Settings shell.
function SectionSkeleton() {
  return (
    <div className="sp-section-skeleton" aria-hidden="true">
      <div className="sp-skeleton-head">
        <div className="sp-skeleton-title" />
        <div className="sp-skeleton-desc" />
      </div>
      <div className="sp-skeleton-card">
        <div className="sp-skeleton-line long" />
        <div className="sp-skeleton-line med" />
        <div className="sp-skeleton-line short" />
      </div>
      <div className="sp-skeleton-card">
        <div className="sp-skeleton-line med" />
        <div className="sp-skeleton-line short" />
      </div>
    </div>
  );
}

const SECTIONS = [
  {
    id: 'account',
    label: 'Account',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: 'statistics',
    label: 'Statistics',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
      </svg>
    ),
  },
  {
    id: 'anilist',
    label: 'AniList',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
  {
    id: 'myanimelist',
    label: 'MyAnimeList',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M8 12h8M12 8v8" />
      </svg>
    ),
  },
  {
    id: 'doujinshi',
    label: 'Doujinshi.Info',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    ),
  },
  {
    id: 'homepage',
    label: 'Homepage Settings',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
      </svg>
    ),
  },
  {
    id: 'reading',
    label: 'Reading Settings',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.396 0 2.757.35 3.5 1.294zm1 0v10.49A7.969 7.969 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804z" />
      </svg>
    ),
  },
  {
    id: 'libraries',
    label: 'Library Management',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
      </svg>
    ),
  },
  {
    id: 'clients',
    label: 'Client Management',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <line x1="12" y1="18" x2="12" y2="18" />
      </svg>
    ),
  },
  {
    id: 'portforwarding',
    label: 'Port Forwarding',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="M12 5l7 7-7 7" />
        <circle cx="4" cy="12" r="1.5" />
      </svg>
    ),
  },
  {
    id: 'sourcing',
    label: 'Third Party Sourcing',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 3a1 1 0 011 1v6.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 111.414-1.414L9 10.586V4a1 1 0 011-1z" />
        <path d="M3 14a1 1 0 011 1v1a1 1 0 001 1h10a1 1 0 001-1v-1a1 1 0 112 0v1a3 3 0 01-3 3H5a3 3 0 01-3-3v-1a1 1 0 011-1z" />
      </svg>
    ),
  },
  {
    id: 'scheduling',
    label: 'Scheduling',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15 14" />
      </svg>
    ),
  },
  {
    id: 'database',
    label: 'Database',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.657-4.03 3-9 3S3 13.657 3 12" />
        <path d="M3 5v14c0 1.657 4.03 3 9 3s9-1.343 9-3V5" />
      </svg>
    ),
  },
  {
    id: 'logs',
    label: 'System Logs',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8M8 17h8M8 9h2" />
      </svg>
    ),
  },
  {
    id: 'android',
    label: 'Android',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="4" width="12" height="16" rx="2" />
        <line x1="11" y1="17" x2="13" y2="17" />
      </svg>
    ),
  },
  {
    id: 'linux',
    label: 'Linux',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'offline',
    label: 'Offline Downloads',
    icon: (
      <svg className="sp-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
  },
];

// Sections that require an active server connection. Each entry is the
// `s.id` from SECTIONS above. When the user is offline these sidebar
// items are greyed out and clicking them shows a "Reconnect to access"
// panel rather than the section that would otherwise hit dead API calls.
//
// Sections NOT in this set (reading, android, linux, offline) are fully usable
// offline because they only read/write client-side state — reader
// preferences in localStorage, APK/AppImage version checks (which themselves
// degrade gracefully), and the offline download manager.
const OFFLINE_LOCKED_SECTIONS = new Set([
  'statistics',
  'anilist',
  'myanimelist',
  'doujinshi',
  'homepage',
  'libraries',
  'clients',
  'portforwarding',
  'sourcing',
  'scheduling',
  'database',
  'logs',
]);

/**
 * Wraps an admin-only Settings section. Fetches the auth-status on mount; if
 * the admin password isn't configured yet, shows the AdminSetupForm; if it
 * is but the operator isn't signed in, shows the AdminLoginForm. Once the
 * caller is a logged-in admin, renders the section content unchanged.
 *
 * Used for the five operator-surface sections (Library Management, Third
 * Party Sourcing, Scheduling, Database Management, System Logs) so they're
 * locked behind the same admin password that already gates Client Management
 * and Port Forwarding. The server enforces the same boundary independently
 * via `requireAdmin` on every endpoint these sections drive.
 *
 * The lazy section chunk under `children` is only fetched once AdminGuard
 * decides to render it — so visiting an admin section without a session
 * doesn't download the section's code until the user actually authenticates.
 */
function AdminGuard({ children }) {
  const [authStatus, setAuthStatus] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getAuthStatus();
      setAuthStatus(s);
    } catch (_) {
      setAuthStatus({ configured: false, logged_in: false });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (!authStatus) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  if (!authStatus.configured) {
    return (
      <div>
        <div className="sp-section-head">
          <div>
            <h2 className="sp-section-title">Admin password required</h2>
            <p className="sp-section-desc">
              This section is operator-only. Set an admin password to enable it —
              the same password unlocks Library Management, Third Party Sourcing,
              Scheduling, Database Management, System Logs, Client Management,
              and Port Forwarding.
            </p>
          </div>
        </div>
        {statusMsg && <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>}
        <AdminSetupForm onDone={(msg) => { setStatusMsg(msg); refresh(); }} />
      </div>
    );
  }

  if (!authStatus.logged_in) {
    return (
      <div>
        <div className="sp-section-head">
          <div>
            <h2 className="sp-section-title">Admin sign-in required</h2>
            <p className="sp-section-desc">
              This section is operator-only. Sign in with the admin password to continue.
            </p>
          </div>
        </div>
        {statusMsg && <div className={`sp-status sp-status-${statusMsg.type}`}>{statusMsg.text}</div>}
        <AdminLoginForm onDone={(msg) => { setStatusMsg(msg); refresh(); }} />
      </div>
    );
  }

  return children;
}

function SectionContent({ section }) {
  const Component = LazySection[section];
  if (!Component) return null;
  const guarded = ADMIN_GATED_SECTIONS.has(section);
  const rendered = <Component />;
  return guarded ? <AdminGuard>{rendered}</AdminGuard> : rendered;
}

export default function Settings() {
  const location = useLocation();
  const { online } = useConnectivity();
  const [section, setSection] = useState(location.state?.section || 'anilist');

  function isLocked(id) {
    return !online && OFFLINE_LOCKED_SECTIONS.has(id);
  }

  function selectSection(id) {
    // Even though the sidebar button is disabled when locked, keep this
    // guard so deep-links (location.state.section) that land on a locked
    // section also render the locked panel rather than crashing the
    // section component on dead API calls.
    setSection(id);
  }

  return (
    <div className="sp-page">
      <nav className="navbar">
        <Link to="/library" className="btn btn-ghost">← Library</Link>
        <Link to="/" className="navbar-brand"><img src="/logo.png" alt="Momotaro" className="navbar-logo" /></Link>
      </nav>

      <div className="sp-layout">
        <aside className="sp-sidebar">
          <p className="sp-sidebar-heading">Settings</p>
          {SECTIONS.map(s => {
            const locked = isLocked(s.id);
            // Warm the chunk as soon as the user's pointer or focus lands
            // on a sidebar item — by the time they click, the chunk is
            // either already cached or actively downloading. No-op for the
            // section they're currently on; safe to call repeatedly.
            const warm = locked ? undefined : () => prefetchSection(s.id);
            return (
              <button
                key={s.id}
                className={`sp-nav-item${section === s.id ? ' active' : ''}${locked ? ' sp-nav-item-locked' : ''}`}
                onClick={() => selectSection(s.id)}
                onMouseEnter={warm}
                onFocus={warm}
                disabled={locked}
                title={locked ? 'Unavailable offline' : undefined}
                aria-disabled={locked}
              >
                {s.icon}
                {s.label}
                {locked && <span className="sp-nav-item-lock" aria-hidden="true">·</span>}
              </button>
            );
          })}
        </aside>

        <main className="sp-content">
          {isLocked(section) ? (
            <OfflineLockedPanel
              label={SECTIONS.find(s => s.id === section)?.label || 'Section'}
            />
          ) : (
            <Suspense fallback={<SectionSkeleton />}>
              <SectionContent section={section} />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}
