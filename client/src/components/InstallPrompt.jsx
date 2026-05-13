import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import './InstallPrompt.css';

// Mobile-only PWA install affordance.
//
// Why this exists: even with a perfectly-formed manifest the browser-built-in
// install hook is invisible on mobile.
//   - Android Chrome's auto "install banner" only fires after an engagement
//     heuristic (~30s of interaction), and many users never tap the 3-dot
//     menu where the alternative install option lives.
//   - iOS Safari has NO auto-prompt at all and no install button anywhere
//     in chrome — the only path is Share → "Add to Home Screen", which
//     non-technical users don't discover.
//
// This component listens for `beforeinstallprompt` (Chromium-based browsers
// where the native prompt is wired up) and otherwise falls back to inline
// instructions for iOS Safari. It only shows on phones, hides itself when
// the app is already running standalone, and remembers a dismissal in
// localStorage for 30 days so it doesn't nag.

const DISMISS_KEY  = 'momotaro_install_dismissed_at';
const DISMISS_TTL  = 30 * 24 * 60 * 60 * 1000; // 30 days
const MOBILE_QUERY = '(max-width: 820px), (pointer: coarse)';

function isStandalone() {
  // `display-mode: standalone` covers Android Chrome installed PWA + desktop
  // Chrome installed PWA. iOS Safari doesn't honour display-mode, so the
  // legacy `navigator.standalone` is the iOS-specific signal.
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true
    || window.navigator.standalone === true
  );
}

function isIosSafari() {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  // iOS UA includes 'iPhone'/'iPad'/'iPod'. iPadOS 13+ reports as Mac in
  // userAgent — fall through to maxTouchPoints to catch those.
  const ios =
    /iPhone|iPad|iPod/i.test(ua)
    || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  // Exclude in-app browsers (Instagram/FB/Line) — Add-to-Home-Screen isn't
  // available there and the instructions would mislead.
  if (/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram|Line/i.test(ua)) return false;
  return true;
}

function isMobile() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.(MOBILE_QUERY)?.matches === true;
}

function recentlyDismissed() {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_TTL;
  } catch { return false; }
}

export default function InstallPrompt() {
  const location = useLocation();
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  // 'hidden' | 'android' | 'ios' | 'ios-instructions'
  const [mode, setMode] = useState('hidden');

  // Suppress the banner inside the reader so it doesn't sit on top of
  // page-turn taps. The reader is the only full-screen route in the app.
  const onReaderRoute = location.pathname.startsWith('/read/');

  useEffect(() => {
    // Server-side bail
    if (typeof window === 'undefined') return;
    // Already installed — never show
    if (isStandalone()) return;
    // Desktop — the browser already shows an install icon in the URL bar
    // for installable sites; the bottom banner would be visual noise.
    if (!isMobile()) return;
    // Recently dismissed — back off
    if (recentlyDismissed()) return;

    // Capture the Chromium native prompt. Stash the event; we'll fire it
    // when the user taps our button. preventDefault() stops Chrome from
    // showing its own (less prominent) banner so we control the UX.
    function onBeforeInstallPrompt(e) {
      e.preventDefault();
      setDeferredPrompt(e);
      setMode('android');
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);

    // Hide the banner the moment the user actually installs (handled by
    // Chrome firing this event after a successful install via any path —
    // ours OR the 3-dot menu).
    function onAppInstalled() {
      setMode('hidden');
      setDeferredPrompt(null);
    }
    window.addEventListener('appinstalled', onAppInstalled);

    // Chromium fires `beforeinstallprompt` on its own engagement schedule
    // (~30s typically, sometimes immediately, sometimes never on this run).
    // For iOS we just check after mount — no event-driven trigger exists.
    if (isIosSafari()) setMode('ios');

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  function dismiss() {
    try { window.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (_) {}
    setMode('hidden');
  }

  async function handleAndroidInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        setMode('hidden');
      } else {
        // User said no — back off for the dismissal window.
        dismiss();
      }
    } catch (_) {
      dismiss();
    } finally {
      // The prompt is single-shot — Chromium destroys the event after use.
      setDeferredPrompt(null);
    }
  }

  if (mode === 'hidden') return null;
  if (onReaderRoute) return null;

  if (mode === 'ios-instructions') {
    return (
      <div className="install-modal-backdrop" onClick={() => setMode('ios')}>
        <div className="install-modal" onClick={e => e.stopPropagation()}>
          <h3 className="install-modal-title">Install Momotaro</h3>
          <p className="install-modal-step">
            <strong>1.</strong> Tap the Share button{' '}
            <span aria-hidden="true" className="install-modal-icon">
              <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                <path d="M10 2a1 1 0 01.7.29l3 3a1 1 0 11-1.4 1.42L11 5.41V13a1 1 0 11-2 0V5.41L7.7 6.71A1 1 0 016.3 5.29l3-3A1 1 0 0110 2z"/>
                <path d="M4 11a1 1 0 011 1v3a1 1 0 001 1h8a1 1 0 001-1v-3a1 1 0 112 0v3a3 3 0 01-3 3H6a3 3 0 01-3-3v-3a1 1 0 011-1z"/>
              </svg>
            </span>{' '}
            in Safari's bottom toolbar.
          </p>
          <p className="install-modal-step">
            <strong>2.</strong> Scroll down and tap{' '}
            <strong>Add to Home Screen</strong>.
          </p>
          <p className="install-modal-step">
            <strong>3.</strong> Tap <strong>Add</strong> in the top-right.
          </p>
          <button
            className="install-modal-close"
            onClick={() => setMode('ios')}
          >Got it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="install-banner" role="region" aria-label="Install Momotaro">
      <div className="install-banner-inner">
        <div className="install-banner-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        <div className="install-banner-text">
          <p className="install-banner-title">Install Momotaro</p>
          <p className="install-banner-sub">
            {mode === 'ios'
              ? 'Add to your home screen for full-screen reading'
              : 'Get the full-screen app for faster access'}
          </p>
        </div>
        {mode === 'android' && (
          <button
            className="install-banner-cta"
            onClick={handleAndroidInstall}
          >Install</button>
        )}
        {mode === 'ios' && (
          <button
            className="install-banner-cta"
            onClick={() => setMode('ios-instructions')}
          >How?</button>
        )}
        <button
          className="install-banner-close"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
        >✕</button>
      </div>
    </div>
  );
}
