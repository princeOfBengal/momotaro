// In-app replacement for window.alert / window.confirm / window.prompt.
//
// React-free imperative API so any module (utility, async hook, catch
// handler) can pop a dialog without having to thread context through every
// caller. `DialogProvider` registers itself on mount via `__attachDialogHost`
// and stays attached until unmount; calls made before attach (e.g. during
// the very first render tick) are queued and dispatched as soon as the host
// is ready, then fall through to the native browser primitives only if no
// provider ever shows up.
//
// The promise contract mirrors the legacy globals:
//   appAlert(msg)        → Promise<void>
//   appConfirm(msg)      → Promise<boolean>   (true = OK, false = cancel)
//   appPrompt(msg, def)  → Promise<string|null>  (null = cancel)
//
// One dialog at a time. Concurrent calls queue FIFO and resolve in order.

let _host = null;          // function (config, resolve) => void
let _busy = false;
const _queue = [];

function flushQueue() {
  if (_busy || _queue.length === 0 || !_host) return;
  _busy = true;
  const { config, resolve } = _queue.shift();
  _host(config, (result) => {
    _busy = false;
    resolve(result);
    flushQueue();
  });
}

function enqueue(config) {
  return new Promise((resolve) => {
    // No host registered after a tick → fall back to the native browser
    // primitive so a misconfigured tree still shows *something* rather
    // than swallowing the prompt. The provider should always be mounted
    // in App.jsx, so this is purely a defensive fallback.
    if (!_host) {
      setTimeout(() => {
        if (!_host) {
          resolve(nativeFallback(config));
          return;
        }
        _queue.push({ config, resolve });
        flushQueue();
      }, 0);
      return;
    }
    _queue.push({ config, resolve });
    flushQueue();
  });
}

function nativeFallback(config) {
  if (config.type === 'alert')   { try { window.alert(config.message); } catch {} return undefined; }
  if (config.type === 'confirm') { try { return window.confirm(config.message); } catch { return false; } }
  if (config.type === 'prompt')  { try { return window.prompt(config.message, config.defaultValue ?? ''); } catch { return null; } }
  return undefined;
}

export function __attachDialogHost(fn) {
  _host = fn;
  flushQueue();
  return () => { if (_host === fn) _host = null; };
}

export function appAlert(message, opts = {}) {
  return enqueue({ type: 'alert', message: String(message ?? ''), ...opts });
}

export function appConfirm(message, opts = {}) {
  return enqueue({ type: 'confirm', message: String(message ?? ''), ...opts });
}

export function appPrompt(message, defaultValue = '', opts = {}) {
  return enqueue({
    type: 'prompt',
    message: String(message ?? ''),
    defaultValue: defaultValue == null ? '' : String(defaultValue),
    ...opts,
  });
}

// ── Admin-access gate ──────────────────────────────────────────────────────
//
// Imperative companion to <RequireAdminAccess>: pop the admin password
// modal when a button needs admin-only authority. Resolves true once the
// user has authenticated (either because they already had a token or
// because they entered the password just now), false on cancel.
//
// Action-level callers use it like:
//   if (!(await ensureAdminAccess())) return;
//   doTheGatedThing();

const ADMIN_TOKEN_KEY = 'momotaro_admin_token';
let _adminHost = null;

export function __attachAdminHost(fn) {
  _adminHost = fn;
  return () => { if (_adminHost === fn) _adminHost = null; };
}

function hasAdminToken() {
  try {
    return !!(typeof window !== 'undefined'
      && window.localStorage
      && window.localStorage.getItem(ADMIN_TOKEN_KEY));
  } catch {
    return false;
  }
}

export function ensureAdminAccess() {
  // Fast path: a token already exists. We trust it; if it's stale the
  // gated API call will 401 and the caller surfaces the error normally.
  // Checking localStorage directly (instead of importing from `api/client`)
  // avoids a circular dep between the dialog layer and the API layer.
  if (hasAdminToken()) return Promise.resolve(true);
  if (!_adminHost) return Promise.resolve(false);
  return new Promise((resolve) => { _adminHost(resolve); });
}
