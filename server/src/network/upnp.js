/**
 * UPnP-based port forwarding for Momotaro remote access.
 *
 * Design notes — Jellyfin-inspired multi-device handling
 * ──────────────────────────────────────────────────────
 * The first version of this module used `nat-upnp-2`'s `findGateway()`, which
 * returns the *first* SSDP responder and discards every subsequent reply.
 * That works on a clean home network with one router and one NIC. It fails
 * silently on Windows hosts that have a dozen virtual adapters (Hyper-V,
 * WSL2, Docker, VPNs), because the "first" gateway is often a virtual
 * switch that has no idea what UPnP is.
 *
 * Jellyfin's UPnP plugin handles this by collecting *every* INatDevice that
 * responds to SSDP and pushing the mapping to all of them in parallel (see
 * `Jellyfin.Plugin.UPnP/UPnPPlugin.cs`, the `DeviceFound` handler that
 * appends to `_devices` and the `CreateRules → Task.WhenAll(CreatePortMaps)`
 * pattern). The wrong devices simply reject the mapping; the real one
 * accepts it. We do the same thing here, bypassing `findGateway()` and
 * driving `nat-upnp-2`'s SSDP layer directly.
 *
 * Mapping lifecycle:
 *   start() → SSDP discovery for DISCOVERY_WINDOW_MS → push mapping to
 *   every responder → refresh every REFRESH_INTERVAL → on stop, unmap from
 *   every tracked device.
 *
 * The `probePublicIp()` helper is deliberately separate from UPnP — it
 * hits a public echo service over HTTPS so Manual mode can show the user
 * their WAN IP without any of UPnP's failure modes.
 */

const nat = require('nat-upnp-2');
const natDevice = require('nat-upnp-2/lib/nat-upnp/device');
const https = require('https');

const LEASE_TTL_SECONDS  = 60 * 60;     // 1-hour lease; refreshed before it expires
const REFRESH_INTERVAL   = 30 * 60_000; // re-add every 30 min
const DISCOVERY_WINDOW_MS = 8_000;      // collect SSDP responders for this long
const PROTOCOL           = 'TCP';
const MAPPING_DESCRIPTION = 'Momotaro - Web UI';
const PUBLIC_IP_TIMEOUT_MS = 6_000;
const PUBLIC_IP_HOSTS = [
  // Both return a plain-text IP body. Try in order; the first to answer
  // wins. Behind CGNAT they all agree on the carrier-assigned address.
  'https://api.ipify.org',
  'https://icanhazip.com',
];

// Cached SSDP client — we keep one alive across discoveries to avoid the
// (mild) cost of re-binding every interface socket on each refresh.
let ssdp = null;
let refreshTimer = null;
let currentExternalPort = null;
let currentInternalPort = null;
let trackedDevices = []; // { device, location, address } per responder we mapped to
let status = {
  state: 'disabled',         // 'disabled' | 'mapped' | 'partial' | 'error'
  external_port: null,
  internal_port: null,
  public_ip: null,
  last_mapped_at: null,
  last_error: null,
  last_attempt_at: null,
  devices_found: 0,
  devices_mapped: 0,
};

function getStatus() {
  return { ...status };
}

function ensureSsdp() {
  if (!ssdp) ssdp = nat.ssdp.create();
  return ssdp;
}

function closeSsdp() {
  if (ssdp) {
    try { ssdp.close(); } catch { /* best-effort */ }
    ssdp = null;
  }
}

/**
 * Discover every responding IGD on the LAN. Returns an array of
 * `nat-upnp-2` device handles. Unlike `client.findGateway()`, this does
 * NOT stop at the first responder — Jellyfin's `DeviceFound` event handler
 * keeps collecting until it stops discovery itself.
 *
 * SSDP is best-effort by design: if no router answers within the window,
 * we return an empty array and let the caller surface a friendly error.
 */
function discoverDevices() {
  return new Promise((resolve) => {
    const seen = new Map(); // dedupe by location URL
    const search = ensureSsdp().search('urn:schemas-upnp-org:device:InternetGatewayDevice:1');

    const onDevice = (info, address) => {
      if (!info || !info.location) return;
      if (seen.has(info.location)) return;
      seen.set(info.location, true);
      try {
        const device = natDevice.create(info.location);
        trackedDevices.push({ device, location: info.location, address });
      } catch (err) {
        console.warn(`[UPnP] Skipping malformed gateway at ${info.location}: ${err.message}`);
      }
    };

    search.on('device', onDevice);
    setTimeout(() => {
      search.emit('end'); // detaches the ssdp listener
      resolve();
    }, DISCOVERY_WINDOW_MS);
  });
}

function pAddMapping(device, externalPort, internalPort) {
  return new Promise((resolve, reject) => {
    device.run(
      'AddPortMapping',
      [
        ['NewRemoteHost', ''],
        ['NewExternalPort', externalPort],
        ['NewProtocol', PROTOCOL],
        ['NewInternalPort', internalPort],
        ['NewInternalClient', ''], // empty → router infers from packet source
        ['NewEnabled', 1],
        ['NewPortMappingDescription', MAPPING_DESCRIPTION],
        ['NewLeaseDuration', LEASE_TTL_SECONDS],
      ],
      (err, data) => err ? reject(err) : resolve(data)
    );
  });
}

function pDeleteMapping(device, externalPort) {
  return new Promise((resolve, reject) => {
    device.run(
      'DeletePortMapping',
      [
        ['NewRemoteHost', ''],
        ['NewExternalPort', externalPort],
        ['NewProtocol', PROTOCOL],
      ],
      (err, data) => err ? reject(err) : resolve(data)
    );
  });
}

function pExternalIp(device) {
  return new Promise((resolve, reject) => {
    device.run('GetExternalIPAddress', [], (err, data) => {
      if (err) return reject(err);
      // Response shape: { 'u:GetExternalIPAddressResponse': { NewExternalIPAddress: '1.2.3.4' } }
      const key = Object.keys(data || {}).find(k => /:GetExternalIPAddressResponse$/.test(k));
      if (!key) return reject(new Error('No external IP in response'));
      resolve(data[key].NewExternalIPAddress);
    });
  });
}

/**
 * Translate the cryptic library-level errors into something the user can
 * act on. Borrowed in spirit from Jellyfin's "Searching..." / "Active on
 * <device>" / "<gateway> is not responding" status strings.
 */
function explainError(msg) {
  const m = String(msg || '').toLowerCase();
  if (m === 'timeout' || m.includes('timeout')) {
    return 'No router responded to UPnP discovery within the window. ' +
           'Most common cause: UPnP is disabled in your router admin panel, ' +
           'or this server is on a network adapter (VPN/WSL/Hyper-V) that ' +
           "can't reach the router. Manual mode is the reliable workaround.";
  }
  if (m.includes('econnrefused') || m.includes('socket')) {
    return 'Could not open a socket to the router. Check for firewall ' +
           'rules blocking outbound UDP 1900 (SSDP).';
  }
  return msg || 'Unknown UPnP error';
}

/**
 * Apply (or re-apply) the mapping across every discovered gateway. Each
 * device is attempted in parallel with its own error capture — failures on
 * virtual-adapter gateways don't block the real one.
 */
async function applyMapping(externalPort, internalPort) {
  status.last_attempt_at = Math.floor(Date.now() / 1000);
  currentExternalPort = externalPort;
  currentInternalPort = internalPort;

  // Reset the tracked-device list; discoverDevices() will re-populate it.
  // Re-use the cached SSDP client so we don't re-bind on every refresh.
  trackedDevices = [];

  await discoverDevices();

  if (trackedDevices.length === 0) {
    status = {
      ...status,
      state: 'error',
      external_port: externalPort,
      internal_port: internalPort,
      last_error: explainError('timeout'),
      devices_found: 0,
      devices_mapped: 0,
    };
    console.warn('[UPnP] No gateways responded to SSDP discovery');
    return getStatus();
  }

  // Parallel attempts on every responder. Mirrors Jellyfin's
  // `Task.WhenAll(CreatePortMaps(device))` — one failure per device, never
  // one failure for the whole operation.
  const results = await Promise.allSettled(
    trackedDevices.map(({ device, address }) =>
      pAddMapping(device, externalPort, internalPort).then(() => address)
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled');
  const failed    = results.filter(r => r.status === 'rejected');

  // Best-effort public-IP fetch from any successful device, then fall
  // back to HTTP if no device gave us one.
  let publicIp = null;
  for (const { device } of trackedDevices) {
    try { publicIp = await pExternalIp(device); if (publicIp) break; } catch { /* keep trying */ }
  }
  if (!publicIp) {
    try { publicIp = await probePublicIp(); } catch { /* leave null */ }
  }

  if (succeeded.length === 0) {
    const firstError = failed[0]?.reason?.message || 'all gateways rejected the mapping';
    status = {
      ...status,
      state: 'error',
      external_port: externalPort,
      internal_port: internalPort,
      public_ip: publicIp,
      last_error: explainError(firstError),
      devices_found: trackedDevices.length,
      devices_mapped: 0,
    };
    console.warn(
      `[UPnP] All ${trackedDevices.length} gateway(s) rejected the mapping. ` +
      `First error: ${firstError}`
    );
    return getStatus();
  }

  const allOk = failed.length === 0;
  status = {
    state: allOk ? 'mapped' : 'partial',
    external_port: externalPort,
    internal_port: internalPort,
    public_ip: publicIp,
    last_mapped_at: Math.floor(Date.now() / 1000),
    last_error: allOk ? null : `${failed.length} of ${trackedDevices.length} gateways rejected the mapping (expected on hosts with virtual adapters; the working router accepted it).`,
    last_attempt_at: status.last_attempt_at,
    devices_found: trackedDevices.length,
    devices_mapped: succeeded.length,
  };
  console.log(
    `[UPnP] Mapped external ${externalPort}/${PROTOCOL} → internal ${internalPort} ` +
    `on ${succeeded.length}/${trackedDevices.length} gateway(s)` +
    (publicIp ? ` (public IP ${publicIp})` : '')
  );
  return getStatus();
}

function start({ externalPort, internalPort }) {
  stop(); // idempotent
  status.state = 'disabled';
  status.last_error = null;

  applyMapping(externalPort, internalPort).catch(() => { /* swallowed in applyMapping */ });

  refreshTimer = setInterval(() => {
    applyMapping(externalPort, internalPort).catch(() => {});
  }, REFRESH_INTERVAL);
  refreshTimer.unref();
}

async function stop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const portToRemove = currentExternalPort;
  const devicesToClean = trackedDevices.slice();
  currentExternalPort = null;
  currentInternalPort = null;
  trackedDevices = [];

  if (portToRemove !== null && devicesToClean.length > 0) {
    // Iterate every tracked device, same as Jellyfin's `RemoveRules(device)`
    // for each item in `_devices`. Best-effort — a router that's already
    // expired the lease will throw, and that's fine.
    await Promise.allSettled(
      devicesToClean.map(({ device }) => pDeleteMapping(device, portToRemove))
    );
    console.log(`[UPnP] Removed mapping for external ${portToRemove}/${PROTOCOL} from ${devicesToClean.length} gateway(s)`);
  }

  closeSsdp();
  status = {
    state: 'disabled',
    external_port: null,
    internal_port: null,
    public_ip: null,
    last_mapped_at: null,
    last_error: null,
    last_attempt_at: status.last_attempt_at,
    devices_found: 0,
    devices_mapped: 0,
  };
}

/**
 * Probe for any responsive gateway without mutating state. Used by the
 * admin UI's "Probe router" button in UPnP mode. Returns a structured
 * report rather than the legacy { supported, public_ip } shape.
 */
async function probe() {
  trackedDevices = [];
  await discoverDevices();
  const devices = trackedDevices.slice();

  if (devices.length === 0) {
    closeSsdp();
    return {
      supported: false,
      devices: [],
      error: explainError('timeout'),
    };
  }

  let publicIp = null;
  for (const { device } of devices) {
    try { publicIp = await pExternalIp(device); if (publicIp) break; } catch { /* try next */ }
  }

  closeSsdp();
  trackedDevices = [];
  return {
    supported: true,
    devices: devices.map(d => ({ address: d.address, location: d.location })),
    public_ip: publicIp,
  };
}

/**
 * Get the WAN-facing public IP via an external HTTP echo service. Has
 * nothing to do with UPnP — it works whether the router supports UPnP or
 * not, whether you've forwarded a port or not. Used by Manual mode and as
 * a fallback inside `applyMapping`.
 */
function probePublicIp() {
  return new Promise((resolve, reject) => {
    const errors = [];
    let resolved = false;

    function tryNext(idx) {
      if (resolved) return;
      if (idx >= PUBLIC_IP_HOSTS.length) {
        return reject(new Error('All public-IP services failed: ' + errors.join('; ')));
      }

      const url = PUBLIC_IP_HOSTS[idx];
      const req = https.get(url, { timeout: PUBLIC_IP_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          errors.push(`${url} returned HTTP ${res.statusCode}`);
          return tryNext(idx + 1);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          const ip = body.trim();
          // Crude IPv4/IPv6 sanity check — protect against an HTML error page
          // sneaking through with a 200 response code.
          if (/^[\d.]{7,15}$/.test(ip) || /^[a-f0-9:]{2,39}$/i.test(ip)) {
            resolved = true;
            resolve(ip);
          } else {
            errors.push(`${url} returned unparseable body`);
            tryNext(idx + 1);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        errors.push(`${url} timed out`);
        tryNext(idx + 1);
      });
      req.on('error', (err) => {
        errors.push(`${url}: ${err.message}`);
        tryNext(idx + 1);
      });
    }

    tryNext(0);
  });
}

module.exports = { start, stop, applyMapping, probe, probePublicIp, getStatus };
