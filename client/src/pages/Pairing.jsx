import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import './Pairing.css';

// First-run pairing wizard. Five steps:
//
//   1. welcome     — branding + start
//   2. server-url  — user types host:port, we probe `/api/health`
//   3. device-name — pre-fill from platform, user confirms
//   4. pin-entry   — server is generating a PIN; user types it from admin UI
//   5. done        — token persisted, app reloads into library
//
// The pairing_id is persisted across step transitions in component state.
// If the user closes the app mid-flow the pending pairing on the server
// expires after 5 minutes — the wizard handles "expired" gracefully by
// looping back to step 4 with a fresh request.

function detectPlatform() {
  const ua = navigator.userAgent || '';
  // Capacitor sets `Capacitor` global when running inside the WebView wrapper.
  if (typeof window !== 'undefined' && window.Capacitor) {
    return window.Capacitor.getPlatform() || 'capacitor';
  }
  if (/Android/i.test(ua))                       return 'android-web';
  if (/iPad|iPhone|iPod/.test(ua))               return 'ios-web';
  if (/Windows/i.test(ua))                       return 'windows-web';
  if (/Macintosh/.test(ua))                      return 'macos-web';
  if (/Linux/i.test(ua))                         return 'linux-web';
  return 'unknown';
}

/**
 * True when this code is running inside the Capacitor APK wrapper (or any
 * other non-browser shell that sets `window.Capacitor`). The Pairing
 * wizard uses this to decide whether to ask for a server URL. In the APK,
 * the WebView origin is `capacitor://localhost` so the user must point at
 * a real server. In a regular browser, the page was loaded *from* the
 * server we want to pair with — same-origin already works, and asking
 * the user to retype the URL would be confusing.
 */
function isNativeShell() {
  return typeof window !== 'undefined'
      && window.Capacitor
      && typeof window.Capacitor.isNativePlatform === 'function'
      && window.Capacitor.isNativePlatform();
}

function suggestedDeviceName(platform) {
  const ua = navigator.userAgent || '';
  // Heuristic — clients can edit before submitting.
  const m = ua.match(/\(([^)]+)\)/);
  if (m && m[1]) {
    const parts = m[1].split(';').map(s => s.trim());
    const phone = parts.find(p => /(SM-|Pixel|iPhone|iPad|OnePlus|Mi |Redmi)/i.test(p));
    if (phone) return phone;
  }
  if (platform.startsWith('android')) return 'Android device';
  if (platform.startsWith('ios'))     return 'iOS device';
  if (platform.startsWith('windows')) return 'Windows PC';
  if (platform.startsWith('macos'))   return 'Mac';
  if (platform.startsWith('linux'))   return 'Linux PC';
  return 'My device';
}

function normalizeServerUrl(raw) {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}

export default function Pairing() {
  const navigate = useNavigate();
  // PWA visitors loaded the page *from* the server they're pairing with, so
  // same-origin already works — skip the server-URL step and start on the
  // welcome screen, going straight to device-name from there.
  const inBrowser = !isNativeShell();
  const [step, setStep] = useState('welcome');
  const [serverUrlInput, setServerUrlInput] = useState(() => api.getServerUrl() || '');
  const [serverProbe, setServerProbe] = useState(null); // null | 'probing' | 'ok' | 'error'
  const [serverProbeMsg, setServerProbeMsg] = useState('');

  const [platform] = useState(detectPlatform);
  const [deviceName, setDeviceName] = useState(() => suggestedDeviceName(detectPlatform()));

  const [pairingId, setPairingId] = useState(null);
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pinError, setPinError] = useState(null);
  const pollRef = useRef(null);

  // Stop polling on unmount.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Step transitions ───────────────────────────────────────────────────

  async function probeServer() {
    setServerProbe('probing');
    setServerProbeMsg('');
    const url = normalizeServerUrl(serverUrlInput);
    if (!url) {
      setServerProbe('error');
      setServerProbeMsg('Enter a URL like http://192.168.1.10:3000');
      return;
    }
    try {
      // Temporarily swap the base URL for the health check, but only on
      // success do we persist it. If the user typed a wrong host we don't
      // want subsequent unrelated API calls hitting the wrong server.
      const prev = api.getServerUrl();
      api.setServerUrl(url);
      try {
        const data = await api.healthCheck();
        if (data?.status !== 'ok') throw new Error('Not a Momotaro server');
        setServerProbe('ok');
        setServerProbeMsg(`Connected · version ${data.version || 'unknown'}`);
      } catch (err) {
        api.setServerUrl(prev);
        throw err;
      }
    } catch (err) {
      setServerProbe('error');
      setServerProbeMsg(
        'Could not reach a Momotaro server at that address. ' +
        (err.message || '') + ' Check the URL and that the server is running.'
      );
    }
  }

  async function startPairing() {
    setPinError(null);
    setPin('');
    try {
      const data = await api.pairingRequest(deviceName.trim() || 'My device', platform);
      setPairingId(data.pairing_id);
      setStep('pin-entry');

      // Poll the status endpoint so if the admin approves on the server side
      // (or if pairing expires), the UI reacts without the user clicking.
      // The PIN submit happens client-side here, so this poll is mostly a
      // safety net for the expiry case.
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          await api.pairingStatus(data.pairing_id);
        } catch (err) {
          if (/expired/i.test(err.message)) {
            clearInterval(pollRef.current);
            setPinError('The pairing request expired. Tap "Restart pairing" below.');
          }
        }
      }, 5000);
    } catch (err) {
      setPinError('Could not start pairing: ' + err.message);
    }
  }

  async function submitPin() {
    if (pin.length !== 6) return;
    setSubmitting(true);
    setPinError(null);
    try {
      await api.pairingSubmitPin(pairingId, pin);
      if (pollRef.current) clearInterval(pollRef.current);
      setStep('done');
    } catch (err) {
      // Server returns 401 with `attempts_remaining` when the PIN is wrong;
      // we read the message it already formatted.
      setPinError(err.message || 'Wrong PIN. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function finish() {
    // Reload via full navigation so the route guard sees the new token and
    // every cached fetch resolves against the new base URL. This is the
    // first moment the app should feel like the normal Library page.
    window.location.assign('/');
  }

  function restartPairing() {
    if (pollRef.current) clearInterval(pollRef.current);
    setPairingId(null);
    setPin('');
    setPinError(null);
    setStep('device-name');
  }

  function resetToServerUrl() {
    if (pollRef.current) clearInterval(pollRef.current);
    setPairingId(null);
    setPin('');
    setPinError(null);
    setServerProbe(null);
    setStep('server-url');
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="pw-page">
      <div className="pw-card">
        {step === 'welcome' && (
          <>
            <img src="/logo.png" alt="" className="pw-logo" />
            <p className="pw-step">Welcome</p>
            <h1 className="pw-title">Pair this device</h1>
            <p className="pw-subtitle">
              {inBrowser ? (
                <>
                  You're connecting from outside the local network, so this
                  device needs to be paired before it can use the library.
                  You'll name the device and then enter a 6-digit PIN shown
                  in the server's admin page.
                </>
              ) : (
                <>
                  Connect this device to your Momotaro server. You'll enter
                  the server's address and a one-time PIN shown in the
                  server's admin page.
                </>
              )}
            </p>
            <div className="pw-actions">
              <button
                className="btn btn-primary"
                onClick={() => setStep(inBrowser ? 'device-name' : 'server-url')}
              >
                Get started
              </button>
            </div>
          </>
        )}

        {step === 'server-url' && (
          <>
            <p className="pw-step">Step 1 of 3</p>
            <h1 className="pw-title">Server address</h1>
            <p className="pw-subtitle">
              Where is your Momotaro server running? Use the LAN IP and port
              for home access, or the public URL for remote access.
            </p>
            <div className="pw-field">
              <label className="pw-label">Server URL</label>
              <input
                className="pw-input"
                type="url"
                inputMode="url"
                placeholder="http://192.168.1.10:3000"
                value={serverUrlInput}
                onChange={e => { setServerUrlInput(e.target.value); setServerProbe(null); }}
                autoFocus
              />
              {serverProbe && (
                <div className={`pw-server-status ${serverProbe === 'ok' ? 'ok' : serverProbe === 'error' ? 'error' : ''}`}>
                  <span className="pw-server-status-dot" />
                  <span>
                    {serverProbe === 'probing' && 'Testing connection...'}
                    {serverProbe !== 'probing' && serverProbeMsg}
                  </span>
                </div>
              )}
              <p className="pw-hint">
                Don't include the path — just <code>scheme://host:port</code>.
              </p>
            </div>
            <div className="pw-actions">
              <button className="btn btn-ghost" onClick={() => setStep('welcome')}>Back</button>
              {serverProbe !== 'ok' ? (
                <button className="btn btn-primary" onClick={probeServer} disabled={!serverUrlInput || serverProbe === 'probing'}>
                  {serverProbe === 'probing' ? 'Testing...' : 'Test connection'}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => setStep('device-name')}>
                  Continue
                </button>
              )}
            </div>
          </>
        )}

        {step === 'device-name' && (
          <>
            <p className="pw-step">Step {inBrowser ? '1 of 2' : '2 of 3'}</p>
            <h1 className="pw-title">Name this device</h1>
            <p className="pw-subtitle">
              This is how this device appears in your server's Client
              Management list, so you can identify it later if you need to
              revoke access.
            </p>
            <div className="pw-field">
              <label className="pw-label">Device name</label>
              <input
                className="pw-input"
                type="text"
                value={deviceName}
                onChange={e => setDeviceName(e.target.value.slice(0, 64))}
                maxLength={64}
                autoFocus
              />
            </div>
            <div className="pw-actions">
              <button
                className="btn btn-ghost"
                onClick={inBrowser ? () => setStep('welcome') : resetToServerUrl}
              >
                Back
              </button>
              <button className="btn btn-primary" onClick={startPairing} disabled={!deviceName.trim()}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'pin-entry' && (
          <>
            <p className="pw-step">Step {inBrowser ? '2 of 2' : '3 of 3'}</p>
            <h1 className="pw-title">Enter the PIN</h1>
            <p className="pw-subtitle">
              Open Momotaro on your computer, go to{' '}
              <strong>Settings → Client Management</strong>, and copy the
              6-digit PIN shown there.
            </p>
            <div className="pw-field">
              <label className="pw-label">PIN</label>
              <input
                className="pw-input pw-pin-input"
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                autoFocus
              />
              {pinError && <p className="pw-error">{pinError}</p>}
              <p className="pw-hint">
                The PIN expires after 5 minutes. After too many wrong tries
                this device's network address is locked out of pairing for
                24 hours — check Client Management on the server for the
                exact attempt limit.
              </p>
            </div>
            <div className="pw-actions">
              <button className="btn btn-ghost" onClick={restartPairing}>Restart pairing</button>
              <button className="btn btn-primary" onClick={submitPin} disabled={pin.length !== 6 || submitting}>
                {submitting ? 'Pairing...' : 'Pair device'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <div className="pw-success-icon">✓</div>
            <h1 className="pw-title">All set</h1>
            <p className="pw-subtitle">
              This device is paired with your Momotaro server. You can revoke
              access from the server's Client Management section at any time.
            </p>
            <div className="pw-actions">
              <button className="btn btn-primary" onClick={finish}>
                Open library
              </button>
            </div>
          </>
        )}

        {/* Escape hatch — visible on every step except the success screen */}
        {step !== 'done' && step !== 'welcome' && (
          <button
            className="pw-reset-link"
            onClick={() => {
              api.clearClientToken();
              api.clearServerUrl();
              setStep('welcome');
              setServerUrlInput('');
              setServerProbe(null);
            }}
          >
            Start over
          </button>
        )}
      </div>
    </div>
  );
}
