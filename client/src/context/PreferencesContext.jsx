import React, {
  createContext, useContext, useEffect, useState, useRef, useCallback,
} from 'react';
import { api } from '../api/client';
import { useUser } from './UserContext';

/**
 * Per-user, server-synced preferences. Replaces ad-hoc localStorage reads in
 * Settings + Home so a single account converges on one configuration across
 * every device. Reads are local-only after the initial fetch; writes are
 * optimistic + debounced 300 ms then sent to /api/user/preferences.
 *
 * Warm start: the last successful fetch is mirrored to a per-user
 * localStorage slot (`momotaro_prefs_cache_<userId>`), and the provider
 * hydrates from it synchronously on mount. Consumers therefore see
 * `loading: false` from the first render on return visits — Home fires
 * /api/home immediately with last-known prefs instead of waiting a network
 * round-trip — and the background fetch reconciles afterwards (identity-
 * preserving when nothing changed, so no spurious refetches downstream).
 *
 * Cross-device sync model: each device re-fetches on tab focus
 * (`visibilitychange`), so a change on Device A appears on Device B the next
 * time B's tab regains focus or reloads. Real-time push is out of scope.
 *
 * Migration: the first mount after upgrade reads any legacy `home_*` values
 * from localStorage, uploads them to the server, deletes them locally, and
 * sets `home_prefs_migrated` so the migration runs exactly once per browser.
 * The migration only ever runs against a *network* result — never against
 * the warm-start mirror — so a failed boot can't mark it complete.
 *
 * Failure modes:
 *   - Initial GET fails (offline, server down) → prefs keeps the warm-start
 *     mirror when one exists, else resolves to {} and consumers fall back to
 *     their hard-coded defaults. The optimistic local state still works;
 *     writes queue and retry on the next change.
 *   - PUT fails → the patch is requeued so the next debounced flush carries
 *     it back to the server.
 */

const PreferencesContext = createContext(null);

// ── localStorage warm-start mirror ──────────────────────────────────────────
// The last successful fetch's merged prefs, mirrored per user so a returning
// visit hydrates synchronously instead of holding /api/home behind the
// preferences round-trip. Keyed by the active user id (mirrored to
// localStorage by the login/register/getMe flows) so an account switch on a
// shared device never flashes another user's Discover filters.
const PREFS_CACHE_PREFIX = 'momotaro_prefs_cache_';

function prefsCacheKey() {
  let uid = null;
  try { uid = api.getActiveUserId(); } catch (_) { /* storage disabled */ }
  return PREFS_CACHE_PREFIX + (uid || 'default');
}

function readPrefsCache() {
  try {
    const raw = localStorage.getItem(prefsCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writePrefsCache(prefs) {
  try {
    localStorage.setItem(prefsCacheKey(), JSON.stringify(prefs));
  } catch (_) { /* quota / disabled storage — warm-start just won't happen */ }
}

// Reference-preserving merge: if `next` is content-identical to `prev`, keep
// `prev` so downstream hooks see the same object/array references. Without
// this, every fetch settling would mint fresh array identities for
// unchanged prefs, changing Home's `load` callback identity and firing a
// redundant /api/home request. Both sides come from JSON, so stringify
// equality is faithful; key order is stable in practice (same construction
// path), and a spurious mismatch merely costs one extra fetch.
function preferPrev(prev, next) {
  return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

// One-shot migration of the four pre-existing localStorage keys to the
// server. The mapping is intentionally identity — the key names already
// match `user_preferences.key`, so the keys can be copied verbatim.
const LEGACY_LOCAL_STORAGE_KEYS = [
  'home_default_sort',
  'home_discover_refresh_ms',
  'home_genre_score_threshold',
  'home_gallery_order',
];
const MIGRATION_FLAG_KEY = 'home_prefs_migrated';

// Best-effort type coercion for legacy values. localStorage stores everything
// as strings, but the new prefs system stores typed JSON. Each legacy key gets
// a specific coercion; unknown keys pass through as strings.
function coerceLegacyValue(key, raw) {
  if (key === 'home_discover_refresh_ms') {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : raw;
  }
  if (key === 'home_genre_score_threshold') {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw; // home_default_sort, home_gallery_order: plain strings
}

async function maybeMigrateLegacyLocalStorage(serverPrefs) {
  try {
    if (localStorage.getItem(MIGRATION_FLAG_KEY) === '1') return serverPrefs;
    // If the server already has prefs, the user has migrated on another
    // device — flip the flag locally and leave legacy keys alone for that
    // device's own consumers to clean up if it ever returns.
    if (serverPrefs && Object.keys(serverPrefs).length > 0) {
      localStorage.setItem(MIGRATION_FLAG_KEY, '1');
      return serverPrefs;
    }
    const carry = {};
    for (const k of LEGACY_LOCAL_STORAGE_KEYS) {
      const raw = localStorage.getItem(k);
      if (raw != null) carry[k] = coerceLegacyValue(k, raw);
    }
    if (Object.keys(carry).length > 0) {
      await api.putUserPreferences(carry);
      for (const k of LEGACY_LOCAL_STORAGE_KEYS) localStorage.removeItem(k);
    }
    localStorage.setItem(MIGRATION_FLAG_KEY, '1');
    return { ...serverPrefs, ...carry };
  } catch (_) {
    // Migration failures are non-fatal — keep going with whatever the server
    // returned. The next launch will retry.
    return serverPrefs || {};
  }
}

export function PreferencesProvider({ children }) {
  // Warm-started from the per-user localStorage mirror when available, so
  // `loading` is false from the very first render and Home can fire
  // /api/home immediately with the last-known prefs. `null` (no mirror yet
  // — first ever visit, or a fresh account on this device) preserves the
  // old "loading until the fetch settles" behaviour.
  const [prefs, setPrefs] = useState(() => readPrefsCache());
  const pendingRef = useRef({});         // batched writes since last flush
  const timerRef   = useRef(null);

  // Subscribe to UserContext purely as a re-render trigger: this provider is
  // passed to UserProvider as a `children` element, so without the context
  // subscription a login/logout state change would NOT re-render it (React's
  // children-as-prop bailout) and the token below would never be re-read.
  //
  // The fetch itself is keyed on the session TOKEN, not the resolved user
  // id: the token IS the identity and changes exactly on login / logout /
  // account switch. Keying on the user id (the previous design) re-ran this
  // effect when /api/users/me resolved on boot — null → id under the SAME
  // token — discarding an identical in-flight prefs fetch and serializing
  // /api/home behind the duplicate round-trip.
  useUser();
  const token = api.getUserToken();

  const firstRunRef = useRef(true);
  useEffect(() => {
    let cancelled = false;

    if (firstRunRef.current) {
      // Mount: state already warm-started by the useState initializer —
      // re-setting it here would mint a new object identity and re-fire
      // every consumer for no reason.
      firstRunRef.current = false;
    } else {
      // Account switch. Drop any writes queued under the previous user
      // (a patch made by user A within the 300 ms debounce window must not
      // land on B's preferences), then re-hydrate from the new identity's
      // mirror slot — `null` surfaces the loading state when this identity
      // has no cached prefs on this device yet.
      pendingRef.current = {};
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setPrefs(readPrefsCache());
    }

    // If multi-user is on but nobody is logged in yet, /api/user/preferences
    // would 401 — the catch below falls back to defaults. We allow the call
    // when there's no token AND no user (single-user mode resolves to the
    // default user server-side, which has its own prefs row).
    api.getUserPreferences()
      .then(async (server) => {
        if (cancelled) return;
        const merged = await maybeMigrateLegacyLocalStorage(server || {});
        if (!cancelled) setPrefs(prev => preferPrev(prev, merged));
      })
      .catch(() => {
        // Offline / unauthenticated — keep the warm-started value when we
        // have one (better than dropping to defaults mid-session); otherwise
        // fall back to empty prefs so consumers see their hard-coded
        // defaults. Writes still queue locally and retry on the next change.
        if (!cancelled) setPrefs(prev => prev ?? {});
      });

    return () => { cancelled = true; };
  }, [token]);

  // Write-through mirror: persist every settled prefs object (fetch results
  // and optimistic setPref updates alike) so the next boot warm-starts with
  // current data. Writing the just-hydrated value back is a harmless no-op.
  useEffect(() => {
    if (prefs) writePrefsCache(prefs);
  }, [prefs]);

  // Refetch on tab-visibility regain so a change made on another device
  // shows up without a full reload. Cheap when the prefs object is small.
  //
  // Merge precedence: server first, then pendingRef on top. Otherwise an
  // optimistic local change still inside the 300 ms debounce window would be
  // clobbered by a stale server value if the tab loses then regains focus
  // before the flush fires.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      api.getUserPreferences()
        .then(server => setPrefs(prev => preferPrev(prev, {
          ...prev,
          ...(server || {}),
          ...pendingRef.current,
        })))
        .catch(() => { /* keep showing whatever we have */ });
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const flush = useCallback(() => {
    const batch = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(batch).length === 0) return;
    api.putUserPreferences(batch)
      .catch(() => {
        // PUT failed (offline, server down, transient 5xx). Requeue so the
        // next change re-attempts. Don't overwrite newer entries already
        // staged in pendingRef.
        for (const [k, v] of Object.entries(batch)) {
          if (!(k in pendingRef.current)) pendingRef.current[k] = v;
        }
      });
  }, []);

  const setPref = useCallback((key, value) => {
    setPrefs(prev => ({ ...(prev || {}), [key]: value }));
    pendingRef.current[key] = value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 300);
  }, [flush]);

  // Flush any pending writes when the tab is about to unload so a setting
  // changed in the last 300 ms still makes it to the server.
  useEffect(() => {
    function onHide() {
      if (Object.keys(pendingRef.current).length > 0) {
        if (timerRef.current) clearTimeout(timerRef.current);
        flush();
      }
    }
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [flush]);

  return (
    <PreferencesContext.Provider value={{ prefs, setPref, loading: prefs === null }}>
      {children}
    </PreferencesContext.Provider>
  );
}

/**
 * Read + write a single preference with a default fallback.
 *
 * Usage:
 *   const [defaultSort, setDefaultSort] = useUserPref('home_default_sort', 'title');
 *
 * Behaviour:
 *   - Returns `defaultValue` until the initial fetch resolves (preserves
 *     today's UX where Home doesn't wait on settings to paint).
 *   - Writing is optimistic — the local value flips immediately and the
 *     server PUT is debounced.
 */
export function useUserPref(key, defaultValue) {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('useUserPref must be used within a PreferencesProvider');
  const { prefs, setPref } = ctx;
  const value = prefs && Object.prototype.hasOwnProperty.call(prefs, key)
    ? prefs[key]
    : defaultValue;
  const set = useCallback((v) => setPref(key, v), [key, setPref]);
  return [value, set];
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used within a PreferencesProvider');
  return ctx;
}
