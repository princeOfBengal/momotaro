import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

// Source of truth for "are we online and the server is reachable". Three
// independent signals are combined:
//
//   1. `navigator.onLine` — fastest, OS-driven, but only knows about the
//       link layer (Wi-Fi on / off). Doesn't catch "Wi-Fi up but the server
//       is unreachable".
//   2. @capacitor/network — same as (1) but reliable on Android (the WebView
//       `online`/`offline` events don't always fire).
//   3. Periodic ping to `/api/health` — the only signal that catches a dead
//       server. Polled every PING_INTERVAL_MS, with a short timeout so a
//       blip doesn't stall any UI consumer.
//
// In addition the user can force offline mode (`forceOffline(true)`) for
// e.g. metered-data scenarios. That setting persists across launches.
//
// Modes:
//   'online'           — reachable, not forced
//   'offline-auto'     — unreachable
//   'offline-forced'   — user toggled offline mode

const LS_FORCE_OFFLINE_KEY = 'momotaro_force_offline';
const LS_WIFI_ONLY_KEY     = 'momotaro_wifi_only_downloads';
const PING_INTERVAL_MS_ONLINE  = 30_000;
const PING_INTERVAL_MS_OFFLINE = 7_500;
const PING_TIMEOUT_MS          = 5_000;

const Ctx = createContext({
  mode:           'online',
  online:         true,
  forced:         false,
  // Network type as reported by @capacitor/network: 'wifi' | 'cellular' |
  // 'ethernet' | 'unknown' | 'none'. 'unknown' on PWA where the platform
  // doesn't expose it.
  networkType:    'unknown',
  // User setting — "only download over Wi-Fi". Persists across launches.
  wifiOnly:       false,
  // Derived: true when the queue is currently allowed to make network
  // calls (online + (networkType==='wifi' || !wifiOnly)).
  downloadsAllowed: true,
  forceOffline:   () => {},
  setWifiOnly:    () => {},
  retry:          () => {},
});

export function useConnectivity() {
  return useContext(Ctx);
}

function readStoredForce() {
  try { return localStorage.getItem(LS_FORCE_OFFLINE_KEY) === '1'; }
  catch { return false; }
}

function writeStoredForce(v) {
  try {
    if (v) localStorage.setItem(LS_FORCE_OFFLINE_KEY, '1');
    else   localStorage.removeItem(LS_FORCE_OFFLINE_KEY);
  } catch { /* ignore */ }
}

function readStoredWifiOnly() {
  try { return localStorage.getItem(LS_WIFI_ONLY_KEY) === '1'; }
  catch { return false; }
}

function writeStoredWifiOnly(v) {
  try {
    if (v) localStorage.setItem(LS_WIFI_ONLY_KEY, '1');
    else   localStorage.removeItem(LS_WIFI_ONLY_KEY);
  } catch { /* ignore */ }
}

// Health check. Bypasses our `apiFetch` wrapper so the timeout is dedicated
// and we don't get caught by the offline-router (this is the source of
// truth for whether we're online — it can't depend on itself).
async function pingServer(getServerUrl, signal) {
  const base = getServerUrl();
  // PWA: base = '' so the ping hits same-origin /api/health. Native shell
  // with no paired server: we treat as offline because there's nothing to
  // talk to anyway.
  if (typeof window !== 'undefined' && window.Capacitor
      && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
      && !base) {
    return false;
  }
  try {
    const resp = await fetch(`${base}/api/health`, {
      signal,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export function ConnectivityProvider({ children, getServerUrl }) {
  const [reachable, setReachable] = useState(true);
  const [forced, setForced]       = useState(readStoredForce);
  const [networkType, setNetworkType] = useState('unknown');
  const [wifiOnly, setWifiOnlyState]  = useState(readStoredWifiOnly);
  const pingAbortRef = useRef(null);

  // Single ping helper, abortable so a manual retry cancels any in-flight
  // ping before re-running.
  const doPing = useCallback(async () => {
    if (pingAbortRef.current) pingAbortRef.current.abort();
    const ctrl = new AbortController();
    pingAbortRef.current = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    try {
      const ok = await pingServer(getServerUrl, ctrl.signal);
      setReachable(ok);
      return ok;
    } finally {
      clearTimeout(timeout);
    }
  }, [getServerUrl]);

  // OS-level connectivity. On native we prefer @capacitor/network because
  // the WebView `online`/`offline` events don't fire reliably on Android.
  useEffect(() => {
    let unlisten = null;
    let cancelled = false;

    async function wireNetworkListener() {
      const isNative = typeof window !== 'undefined'
                    && window.Capacitor
                    && window.Capacitor.isNativePlatform
                    && window.Capacitor.isNativePlatform();
      if (isNative) {
        try {
          const { Network } = await import('@capacitor/network');
          if (cancelled) return;
          const handle = await Network.addListener('networkStatusChange', (s) => {
            setNetworkType(s.connectionType || (s.connected ? 'unknown' : 'none'));
            if (s.connected) {
              // Link came back — re-ping to confirm the server is reachable.
              doPing();
            } else {
              setReachable(false);
            }
          });
          unlisten = () => handle.remove();
          // Seed the initial state too.
          const status = await Network.getStatus();
          setNetworkType(status.connectionType || (status.connected ? 'unknown' : 'none'));
          if (!status.connected) setReachable(false);
        } catch {
          // @capacitor/network not installed yet (e.g. first build before
          // npm install). Fall through to the navigator path.
          wireWebFallback();
        }
      } else {
        wireWebFallback();
      }
    }

    function wireWebFallback() {
      const onOnline  = () => doPing();
      const onOffline = () => setReachable(false);
      window.addEventListener('online',  onOnline);
      window.addEventListener('offline', onOffline);
      unlisten = () => {
        window.removeEventListener('online',  onOnline);
        window.removeEventListener('offline', onOffline);
      };
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setReachable(false);
      }
    }

    wireNetworkListener();
    // First ping on mount.
    doPing();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (pingAbortRef.current) pingAbortRef.current.abort();
    };
  }, [doPing]);

  // Periodic ping. Tighter cadence when we *think* we're offline so we
  // bounce back faster when the network returns.
  useEffect(() => {
    const interval = reachable ? PING_INTERVAL_MS_ONLINE : PING_INTERVAL_MS_OFFLINE;
    const t = setInterval(() => { doPing(); }, interval);
    return () => clearInterval(t);
  }, [reachable, doPing]);

  const forceOffline = useCallback((v) => {
    const next = Boolean(v);
    writeStoredForce(next);
    setForced(next);
    // Re-ping immediately after the user turns *off* forced offline, so the
    // banner flips back the moment the toggle moves.
    if (!next) doPing();
  }, [doPing]);

  const setWifiOnly = useCallback((v) => {
    const next = Boolean(v);
    writeStoredWifiOnly(next);
    setWifiOnlyState(next);
  }, []);

  const mode    = forced ? 'offline-forced' : (reachable ? 'online' : 'offline-auto');
  const online  = mode === 'online';

  // True when the download queue is allowed to use the network. Online +
  // network-type passes the Wi-Fi-only gate. Cellular on a Wi-Fi-only
  // device blocks. On PWA / `unknown` network type we let downloads
  // proceed because we can't reliably tell metered from unmetered.
  const downloadsAllowed = online
    && (!wifiOnly || networkType === 'wifi' || networkType === 'ethernet' || networkType === 'unknown');

  // Push the gate to the downloader. This is the only place the
  // ConnectivityContext talks to the queue layer — keeps the dependency
  // one-way (context → downloader, never the other way).
  useEffect(() => {
    let cancelled = false;
    import('../api/downloader').then(({ setNetworkAllowed }) => {
      if (!cancelled) setNetworkAllowed(downloadsAllowed);
    }).catch(() => { /* downloader module failed to load — non-fatal */ });
    return () => { cancelled = true; };
  }, [downloadsAllowed]);

  const value = useMemo(() => ({
    mode,
    online,
    forced,
    networkType,
    wifiOnly,
    downloadsAllowed,
    forceOffline,
    setWifiOnly,
    retry: doPing,
  }), [mode, online, forced, networkType, wifiOnly, downloadsAllowed, forceOffline, setWifiOnly, doPing]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── Banner ──────────────────────────────────────────────────────────────────
// Renders a slim bar at the top of the app whenever the user is offline,
// either by force-toggle or because the server is unreachable. Mounted in
// App.jsx beneath the existing AdminTaskBanner.

export function ConnectivityBanner() {
  const { mode, retry, forceOffline } = useConnectivity();
  const location = useLocation();
  if (mode === 'online') return null;
  // Suppress on the Reader. It's the only full-screen route in the app;
  // a thin status ribbon overlapping the top of every page disrupts the
  // reading flow and clips the leading edge of the chapter title. Same
  // self-gating pattern InstallPrompt uses for the same reason.
  if (location.pathname.startsWith('/read/')) return null;

  const isForced = mode === 'offline-forced';
  const label = isForced
    ? 'Offline mode is on — only downloaded content is available.'
    : 'You are offline — server unreachable. Downloaded content is still available.';
  return (
    <div className="connectivity-banner" role="status" aria-live="polite">
      <span className="connectivity-banner-dot" aria-hidden="true" />
      <span className="connectivity-banner-label">{label}</span>
      {isForced ? (
        <button
          type="button"
          className="connectivity-banner-action"
          onClick={() => forceOffline(false)}
        >
          Turn off
        </button>
      ) : (
        <button
          type="button"
          className="connectivity-banner-action"
          onClick={() => retry()}
        >
          Try again
        </button>
      )}
    </div>
  );
}
