import { useEffect, useState } from 'react';

// Returns false once the app is backgrounded or its document is hidden, and
// true again when it's foregrounded/visible. Use it to pause heavy, always-on
// work (infinite CSS animations, polling, rAF loops) when the user switches
// away, so a backgrounded WebView isn't holding live GPU layers / timers that
// Android reclaims under memory pressure.
//
// Driven by two independent listeners, each covering a gap in the other; we
// apply whichever fires last rather than AND-ing their current states, so a
// missed/stale visibility read can't veto a real native foreground event (see
// the appStateChange handler below). Because every event reflects a genuine
// transition, the two converge on the correct state:
//   1. Page Visibility API (`visibilitychange`) — works in the browser/PWA and
//      usually on Android WebView, but historically fires late or not at all on
//      some Android WebView builds when the whole Activity is backgrounded.
//   2. Capacitor App `appStateChange` — the reliable native foreground/background
//      signal on Android, but native-only (no-op on web). Dynamically imported
//      with the same graceful fallback ConnectivityContext uses, so a build that
//      hasn't installed @capacitor/app yet (or the PWA) still works on signal 1.
//
//   const active = useAppActive();
//   const paused = !active || userPaused;
export function useAppActive() {
  const [active, setActive] = useState(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState !== 'hidden';
  });

  useEffect(() => {
    const onVisibility = () => setActive(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);

    // Native backstop. On Android the WebView's visibilitychange can miss an
    // app switch; App.appStateChange ({ isActive }) does not.
    let unlisten = null;
    let cancelled = false;
    const isNative = typeof window !== 'undefined'
                  && window.Capacitor
                  && window.Capacitor.isNativePlatform
                  && window.Capacitor.isNativePlatform();
    if (isNative) {
      (async () => {
        try {
          const { App } = await import('@capacitor/app');
          if (cancelled) return;
          const handle = await App.addListener('appStateChange', ({ isActive }) => {
            // Mirror the native foreground/background state directly. We
            // deliberately do NOT AND-in document.visibilityState here: that
            // would re-couple foreground recovery to visibilitychange — the
            // signal this listener exists to back up — so a missed or stale
            // 'visible' on resume could strand us paused forever. The separate
            // visibilitychange listener still handles doc-hidden-while-app-
            // active; between the two, the last real transition wins.
            setActive(isActive);
          });
          // The component may have unmounted while addListener was in flight
          // (two awaits — the `cancelled` check above only guards the first).
          // Remove immediately so we don't leak a listener the cleanup missed.
          if (cancelled) {
            handle.remove();
            return;
          }
          unlisten = () => handle.remove();
        } catch {
          // @capacitor/app not installed yet (e.g. first build before npm
          // install / cap sync). The visibilitychange listener still covers us.
        }
      })();
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (unlisten) unlisten();
    };
  }, []);

  return active;
}
