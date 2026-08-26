/**
 * Active reachability checks for mains-powered Shelly relays (1 Gen4).
 *
 * Unlike Flood Gen4, relays stay on Wi‑Fi when powered. When unplugged, the
 * outbound WebSocket can linger half-open for minutes — so we periodically
 * RPC-probe every relay and mark offline on failure.
 */

import { getIotFirestore, touchCloudDevicePresence, markCloudDeviceOffline } from '../iot-cloud-firestore.js';
import shellyLocalApi from './shellyLocalApi.js';
import shellyWsServer from './shellyWebSocketServer.js';

const DEFAULT_INTERVAL_MS = 15 * 1000;
const RPC_TIMEOUT_MS = 4000;

function canProbeLan() {
  // Cloud Run / public hosts cannot reach private 192.168/10./mDNS addresses.
  // Marking relays offline there just because LAN failed causes false OFFLINE
  // when the device's outbound WS is on a different instance.
  if (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) return false;
  if (process.env.RELAY_PRESENCE_LAN === '0') return false;
  return true;
}

function isRelayDevice(data = {}, docId = '') {
  const id = String(data.deviceId || docId || '').toLowerCase();
  const type = String(data.type || data.deviceType || '').toLowerCase();
  return type === 'relay_controller'
    || type.includes('relay')
    || data.deviceType === 'shelly_relay_gen4'
    || (Array.isArray(data.capabilities) && data.capabilities.includes('water_shutoff'))
    || id.includes('1g4')
    || id.includes('shelly1');
}

class ShellyRelayPresencePoller {
  constructor() {
    this._timer = null;
    this._running = false;
    this._inFlight = false;
  }

  start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this._running) return;
    this._running = true;
    console.log(`🔌 Relay presence poller started (every ${Math.round(intervalMs / 1000)}s)`);
    this.poll().catch(() => {});
    this._timer = setInterval(() => {
      this.poll().catch(() => {});
    }, intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }

  status() {
    return { running: this._running, inFlight: this._inFlight };
  }

  async listRelayTargets() {
    const db = getIotFirestore();
    const snap = await db.collection('shelly_devices').get();
    const targets = [];

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (!isRelayDevice(data, doc.id)) continue;
      const id = String(data.deviceId || doc.id || '');
      const ip = data.localIp || data.ip || null;
      targets.push({
        deviceId: id,
        docId: doc.id,
        ip: ip && String(ip).trim() ? String(ip).trim() : null,
        mdns: id ? `${id.toLowerCase()}.local` : null,
        switchId: Number.isFinite(Number(data.switchId)) ? Number(data.switchId) : 0,
        relayCloseOn: data.relayCloseOn !== false,
      });
    }

    return targets;
  }

  async probeLan(host) {
    if (!host) return null;
    try {
      return await shellyLocalApi.rpc(host, 'Switch.GetStatus', { id: 0 }, RPC_TIMEOUT_MS);
    } catch {
      return null;
    }
  }

  async probeWs(deviceId, switchId = 0) {
    if (!shellyWsServer.isDeviceConnected(deviceId)) return null;
    try {
      const result = await shellyWsServer.sendRpcToDevice(
        deviceId,
        'Switch.GetStatus',
        { id: switchId },
        RPC_TIMEOUT_MS,
      );
      return result == null ? null : result;
    } catch (error) {
      console.warn(`[RelayPresence] WS probe failed for ${deviceId}:`, error.message);
      // Dead half-open socket — force disconnect so offline handlers fire.
      try {
        shellyWsServer.forceDisconnect(deviceId, 'presence_probe_failed');
      } catch {
        // ignore
      }
      return null;
    }
  }

  async markOffline(target, reason) {
    await markCloudDeviceOffline(target.deviceId, {
      presenceSource: 'relay_poll',
      offlineReason: reason,
    });
    if (target.docId !== target.deviceId) {
      await markCloudDeviceOffline(target.docId, {
        presenceSource: 'relay_poll',
        offlineReason: reason,
      });
    }
    console.log(`🔌 Relay ${target.deviceId} unreachable (${reason}) — marked offline`);
  }

  async markOnline(target, live, via) {
    const relayOutputOn = live?.output === true;
    const fields = {
      status: 'online',
      presenceSource: 'relay_poll',
      relayOutputOn,
      valveState: target.relayCloseOn
        ? (relayOutputOn ? 'closed' : 'open')
        : (relayOutputOn ? 'open' : 'closed'),
    };
    if (via && !String(via).endsWith('.local') && via !== 'websocket') {
      fields.localIp = via;
      fields.ip = via;
    }

    await touchCloudDevicePresence(target.deviceId, fields);
    if (target.docId !== target.deviceId) {
      await touchCloudDevicePresence(target.docId, fields);
    }
  }

  async poll() {
    if (this._inFlight) return { skipped: true, reason: 'in_flight' };
    this._inFlight = true;

    try {
      const targets = await this.listRelayTargets();
      if (targets.length === 0) return { ok: true, checked: 0, online: 0 };

      let online = 0;
      const results = [];

      for (const target of targets) {
        let live = null;
        let via = null;
        let wsFailed = false;

        if (shellyWsServer.isDeviceConnected(target.deviceId)) {
          live = await this.probeWs(target.deviceId, target.switchId);
          via = live ? 'websocket' : null;
          if (!live) wsFailed = true;
        }

        if (!live && canProbeLan()) {
          for (const host of [target.ip, target.mdns].filter(Boolean)) {
            live = await this.probeLan(host);
            if (live) {
              via = host;
              break;
            }
          }
        }

        if (!live) {
          // Only stamp offline when we had a local WS that failed RPC.
          // LAN misses are common when the Shelly is on the travel-router IoT
          // subnet that this host can't reach — don't fight reconnect.
          if (wsFailed) {
            await this.markOffline(target, 'ws_rpc_failed');
            results.push({ deviceId: target.deviceId, reachable: false });
          } else {
            results.push({ deviceId: target.deviceId, reachable: null, skipped: 'not_locally_reachable' });
          }
          continue;
        }

        await this.markOnline(target, live, via);
        online += 1;
        results.push({ deviceId: target.deviceId, reachable: true, via });
      }

      return { ok: true, checked: targets.length, online, results };
    } catch (error) {
      console.warn('[RelayPresencePoller] poll failed:', error.message);
      return { ok: false, error: error.message };
    } finally {
      this._inFlight = false;
    }
  }
}

const shellyRelayPresencePoller = new ShellyRelayPresencePoller();
export default shellyRelayPresencePoller;
