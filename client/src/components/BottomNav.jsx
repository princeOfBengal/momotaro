import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './BottomNav.css';

// Routes where the bottom nav must not render:
//   - /read/:chapterId   — full-screen reader, owns its own top/bottom bars
//   - /pairing           — first-launch device-trust wizard
//   - /login             — user auth gate
//   - /auth/anilist/...  — OAuth redirect target
//
// Using a startsWith check so dynamic segments under /read/ are caught too.
const HIDDEN_PREFIXES = ['/read/', '/pairing', '/login', '/auth/'];

function isHiddenPath(pathname) {
  return HIDDEN_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

// Each tab matches one route. `match` decides the active state:
//   - exact:    pathname must equal `to` exactly (Home is the only one — without
//               this guard "/library" or "/downloads" would all match "/" via
//               startsWith and Home would always look active)
//   - prefix:   pathname must start with `to`, so /manga/123 stays under Library
const TABS = [
  {
    to: '/',
    label: 'Home',
    match: 'exact',
    icon: (
      <svg className="bottom-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 11l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    to: '/library',
    label: 'Library',
    match: 'prefix',
    // /manga/:id and /manga/:id/edit also light up Library — they're library
    // detail pages, not their own tab. See `isLibraryArea` below.
    icon: (
      <svg className="bottom-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 19V6a2 2 0 0 1 2-2h3v16H6a2 2 0 0 1-2-2z" />
        <path d="M11 4h3v16h-3z" />
        <path d="M17 5l3 1-3 15-3-1z" />
      </svg>
    ),
  },
  {
    to: '/downloads',
    label: 'Downloads',
    match: 'prefix',
    icon: (
      <svg className="bottom-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 4v12" />
        <path d="M7 11l5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: 'Settings',
    match: 'prefix',
    icon: (
      <svg className="bottom-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

// Phone-only thumb-reach navigation rail. The CSS gates display on
// `max-width: 700px`, so on desktop the component renders but is `display:
// none`. We still bail in HIDDEN_PREFIXES so the reader's full-screen mode
// gets no nav DOM at all (a paint glitch is possible on route transition
// otherwise).
//
// Padding-bottom on scrolling containers is driven by `--bottom-nav-h`
// declared in global.css. The Reader overrides that token to 0 on
// .reader-page so its full-bleed layout isn't pushed by the nav even
// before the route-transition unmount completes.
export default function BottomNav() {
  const location = useLocation();
  if (isHiddenPath(location.pathname)) return null;

  // /manga/:id and /manga/:id/edit are library detail pages. Treat them as
  // part of the Library area so the Library tab stays highlighted when the
  // user drills into a series. The exact-or-slash check on /library avoids
  // a startsWith collision with /libraries (Library Management settings
  // page); without it, that page would falsely light the Library tab.
  const isLibraryArea =
    location.pathname === '/library'
    || location.pathname.startsWith('/library/')
    || location.pathname.startsWith('/manga/')
    || location.pathname.startsWith('/genres')
    || location.pathname.startsWith('/art-gallery');

  function isActive(tab) {
    if (tab.to === '/library') return isLibraryArea;
    if (tab.match === 'exact') return location.pathname === tab.to;
    return location.pathname.startsWith(tab.to);
  }

  return (
    <nav className="bottom-nav" aria-label="Primary">
      {TABS.map(tab => {
        const active = isActive(tab);
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={`bottom-nav-item${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {tab.icon}
            <span className="bottom-nav-label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
