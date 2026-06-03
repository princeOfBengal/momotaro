import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api/client';
import { formatRelativeTime } from '../../utils/format';
import { AdminSetupForm, AdminLoginForm } from './AdminAuthForms';
import '../Settings.css';

// ── Section: Port Forwarding ──────────────────────────────────────────────────
// UPnP-driven port mapping. Like Client Management, it's gated behind the
// admin password — un-authed users see the login/setup flow. When live the
// section polls `/api/admin/network/status` every 5 s so the mapping state
// reflects the actual UPnP loop, not just what we last persisted.

function UpnpStatusCard({ upnp, cfg, publicUrl }) {
  let dotClass = 'idle';
  let title = 'Idle';
  let detail = 'Waiting for first mapping attempt...';

  if (upnp.state === 'mapped') {
    dotClass = 'mapped';
    title = 'Mapped';
    detail = publicUrl
      ? <>Reachable at <span className="pf-public-url">{publicUrl}</span></>
      : `External port ${upnp.external_port} forwarded to internal ${upnp.internal_port}.`;
  } else if (upnp.state === 'partial') {
    // Multi-device discovery found N gateways but only some accepted the
    // mapping (typical on Windows hosts with virtual NICs — Hyper-V's
    // "gateway" rejects, the real router accepts). This is a success
    // state, not a failure.
    dotClass = 'mapped';
    title = `Mapped on ${upnp.devices_mapped} of ${upnp.devices_found} gateways`;
    detail = publicUrl
      ? <>Reachable at <span className="pf-public-url">{publicUrl}</span>. Virtual adapters that rejected the mapping are expected and harmless.</>
      : `External port ${upnp.external_port} forwarded on the working router. Other gateways (likely VPN / Hyper-V / WSL virtual adapters) rejected the mapping — that's expected.`;
  } else if (upnp.state === 'error') {
    dotClass = 'error';
    title = 'Mapping failed';
    detail = upnp.last_error || 'Router refused the mapping.';
  } else if (upnp.state === 'disabled') {
    dotClass = 'idle';
    title = 'Disabled';
    detail = `Configured external port: ${cfg.external_port}. Switch mode to UPnP to start mapping.`;
  }

  return (
    <div className="pf-status-card">
      <span className={`pf-status-dot ${dotClass}`} />
      <div className="pf-status-body">
        <div className="pf-status-title">{title}</div>
        <div className="pf-status-detail">{detail}</div>
        {upnp.last_attempt_at && (
          <div className="pf-status-detail" style={{ marginTop: 4 }}>
            Last attempt {formatRelativeTime(upnp.last_attempt_at)}
            {upnp.last_mapped_at && ` · last success ${formatRelativeTime(upnp.last_mapped_at)}`}
            {upnp.devices_found > 0 && ` · ${upnp.devices_mapped}/${upnp.devices_found} gateways accepted`}
          </div>
        )}
      </div>
    </div>
  );
}

function PortForwardingAuthed({ setStatusMsg }) {
  const [data, setData]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [probing, setProbing] = useState(false);
  // The configured-port input is a controlled string so the user can type
  // freely. Apply only re-validates on submit.
  const [portInput, setPortInput] = useState('');
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api.getNetworkStatus();
      setData(next);
      // Don't clobber an in-progress edit — only seed the input on first load.
      setPortInput(prev => prev === '' ? String(next.config.external_port) : prev);
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Failed to load network status: ' + err.message });
    } finally {
      inFlight.current = false;
    }
  }, [setStatusMsg]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => clearInterval(poll);
  }, [refresh]);

  async function handleModeChange(mode) {
    if (!data || saving) return;
    setSaving(true);
    try {
      const next = await api.saveNetworkConfig({ mode });
      setData(next);
      setStatusMsg({ type: 'success', text: `Mode set to "${mode}".` });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePort() {
    const n = parseInt(portInput, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) {
      setStatusMsg({ type: 'error', text: 'External port must be between 1 and 65535.' });
      return;
    }
    setSaving(true);
    try {
      const next = await api.saveNetworkConfig({ external_port: n });
      setData(next);
      setStatusMsg({ type: 'success', text: 'External port updated.' });
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Save failed: ' + err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const next = await api.refreshUpnpMapping();
      setData(prev => ({ ...prev, upnp: next }));
      if (next.state === 'mapped') {
        setStatusMsg({ type: 'success', text: 'Mapping re-applied.' });
      } else {
        setStatusMsg({ type: 'error', text: next.last_error || 'Mapping failed. Check router UPnP settings.' });
      }
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Refresh failed: ' + err.message });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleProbeUpnp() {
    setProbing(true);
    try {
      const result = await api.probeUpnp();
      if (result.supported) {
        const n = result.devices?.length || 0;
        const ipPart = result.public_ip ? ` Public IP: ${result.public_ip}.` : '';
        setStatusMsg({
          type: 'success',
          text: `Found ${n} gateway${n === 1 ? '' : 's'} responding to UPnP.${ipPart}`,
        });
      } else {
        setStatusMsg({ type: 'error', text: result.error || 'No router responded to UPnP discovery.' });
      }
    } catch (err) {
      setStatusMsg({ type: 'error', text: 'Probe failed: ' + err.message });
    } finally {
      setProbing(false);
    }
  }

  // Used by Manual mode — does NOT touch UPnP. Calls an external HTTPS
  // echo service via the server (so the server's view of its own WAN IP
  // is what's reported, not the admin browser's).
  async function handleDetectPublicIp() {
    setProbing(true);
    try {
      const result = await api.detectPublicIp();
      setStatusMsg({ type: 'success', text: `Public IP: ${result.public_ip}` });
    } catch (err) {
      setStatusMsg({ type: 'error', text: err.message });
    } finally {
      setProbing(false);
    }
  }

  if (!data) {
    return <div className="loading-center"><div className="spinner" /></div>;
  }

  const { config: cfg, upnp: upnpStatus } = data;
  const publicUrl = upnpStatus.public_ip
    ? `http://${upnpStatus.public_ip}:${upnpStatus.external_port || cfg.external_port}`
    : null;

  // Cleartext-over-WAN warning. Trigger when the admin UI itself is being
  // served over plain HTTP *and* port forwarding is on — in that combo,
  // every paired-client request crosses the open internet with the auth
  // token visible to anyone on the path. Same-host check matters because
  // the admin might be on the LAN (via the server's local IP) but external
  // clients are not. We err on the side of warning.
  const onHttp = typeof window !== 'undefined' && window.location.protocol === 'http:';
  const showHttpsWarning = onHttp && cfg.mode !== 'off';

  return (
    <>
      {showHttpsWarning && (
        <div className="cm-warning" style={{ marginBottom: 20 }}>
          <strong>This server is reachable over plain HTTP.</strong> Once
          the port is forwarded, every request — including paired-client
          auth tokens — travels in cleartext. Front the server with a
          reverse proxy that terminates TLS ({' '}
          <a href="https://caddyserver.com/" target="_blank" rel="noreferrer">Caddy</a>,{' '}
          <a href="https://nginxproxymanager.com/" target="_blank" rel="noreferrer">nginx Proxy Manager</a>,{' '}
          or <a href="https://www.cloudflare.com/products/tunnel/" target="_blank" rel="noreferrer">Cloudflare Tunnel</a>)
          before exposing it to the internet.
        </div>
      )}

      {/* ── Mode picker ─────────────────────────────────────────────── */}
      <div className="cm-block">
        <p className="cm-block-title">Forwarding mode</p>
        <div className="pf-mode-group">
          {[
            { id: 'off',    label: 'Local only', desc: 'Reject every non-LAN request at the app, regardless of router forwards.' },
            { id: 'upnp',   label: 'UPnP',       desc: 'Ask the router to forward automatically and accept external traffic.' },
            { id: 'manual', label: 'Manual',     desc: "You've forwarded the port yourself or run a reverse proxy." },
          ].map(opt => (
            <button
              key={opt.id}
              className={`pf-mode-btn${cfg.mode === opt.id ? ' active' : ''}`}
              onClick={() => handleModeChange(opt.id)}
              disabled={saving}
            >
              <div className="pf-mode-label">{opt.label}</div>
              <div className="pf-mode-desc">{opt.desc}</div>
            </button>
          ))}
        </div>
        {cfg.mode === 'off' && (
          <div className="pf-status-card" style={{ marginTop: 14 }}>
            <span className="pf-status-dot mapped" />
            <div className="pf-status-body">
              <div className="pf-status-title">External access blocked</div>
              <div className="pf-status-detail">
                The server is now rejecting every request from outside your LAN
                with a 403, even if a router port-forward rule still points at
                it. To fully close the port, also remove the rule in your
                router admin panel — Momotaro can't reach in there to delete
                it for you.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Port configuration ─────────────────────────────────────── */}
      {cfg.mode !== 'off' && (
        <div className="cm-block">
          <p className="cm-block-title">Ports</p>
          <div className="pf-port-row">
            <input
              type="number"
              className="pf-port-input"
              value={portInput}
              onChange={e => setPortInput(e.target.value)}
              min="1"
              max="65535"
            />
            <span className="pf-port-arrow">external →</span>
            <input
              type="number"
              className="pf-port-input"
              value={cfg.internal_port}
              disabled
              title="The server's listen port is fixed at startup via the PORT env var."
            />
            <span className="pf-mode-desc" style={{ marginLeft: 4 }}>internal</span>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSavePort}
              disabled={saving || portInput === String(cfg.external_port)}
            >
              {saving ? 'Saving...' : 'Apply'}
            </button>
          </div>
        </div>
      )}

      {/* ── Live status ─────────────────────────────────────────────── */}
      {cfg.mode === 'upnp' && (
        <div className="cm-block">
          <p className="cm-block-title">Status</p>
          <UpnpStatusCard upnp={upnpStatus} cfg={cfg} publicUrl={publicUrl} />

          <div className="pf-action-row">
            <button className="btn btn-ghost btn-sm" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Re-apply mapping'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleProbeUpnp} disabled={probing}>
              {probing ? 'Probing...' : 'Probe router'}
            </button>
          </div>
        </div>
      )}

      {cfg.mode === 'manual' && (
        <div className="cm-block">
          <p className="cm-block-title">Manual setup</p>
          <div className="pf-status-card">
            <span className="pf-status-dot idle" />
            <div className="pf-status-body">
              <div className="pf-status-title">Manual mode</div>
              <div className="pf-status-detail">
                Configure your router to forward TCP port{' '}
                <strong>{cfg.external_port}</strong> to this server on internal
                port <strong>{cfg.internal_port}</strong>. We won't try UPnP and
                won't display a live status here — once you've forwarded the
                port, test from a phone on cellular data to confirm it works.
              </div>
            </div>
          </div>
          <div className="pf-action-row">
            <button className="btn btn-ghost btn-sm" onClick={handleDetectPublicIp} disabled={probing}>
              {probing ? 'Detecting...' : 'Detect public IP'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function PortForwardingSection() {
  const [authStatus, setAuthStatus] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  const refreshAuthStatus = useCallback(async () => {
    try {
      const data = await api.getAuthStatus();
      setAuthStatus(data);
    } catch {
      setAuthStatus({ configured: false, logged_in: false });
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
          <h2 className="sp-section-title">Port Forwarding</h2>
          <p className="sp-section-desc">
            Open this server to the internet. UPnP asks your router to forward
            a port automatically; Manual mode is for when you've forwarded the
            port yourself (or use a reverse proxy like Caddy / Cloudflare
            Tunnel). Combine with paired-client auth in Client Management to
            keep your library private.
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
        <PortForwardingAuthed setStatusMsg={setStatusMsg} />
      )}
    </div>
  );
}
