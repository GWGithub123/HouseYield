/**
 * Opportunistic Flood Gen4 presence polling.
 *
 * Battery Flood Gen4 turns Wi‑Fi off while sleeping, so we cannot wake it by
 * polling. When the sensor IS awake (button press / alarm / brief check-in),
 * a short Shelly.GetStatus succeeds and we refresh lastSeen so the dashboard
 * flips Sleeping → Online without requiring a new button webhook.
 *
 * This only works from a backend that can reach the property LAN (local
 * HouseYield server on the GL.iNet / same network). Cloud Run cannot poll
 * private 192.168.x addresses.
 */

import { getIotFirestore, touchCloudDevicePresence } from '../iot-cloud-firestore.js';
import shellyLocalApi from './shellyLocalApi.js';

const DEFAULT_INTERVAL_MS = 60 * 1000;
const RPC_TIMEOUT_MS = 2500;

class ShellyFloodPresencePoller {
  constructor() {
    this._timer = null;
    this._running = false;
    this._inFlight = false;
  }

  start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this._running) return;
    this._running = true;
    console.log(`🌊 Flood presence poller started (every ${Math.round(intervalMs / 1000)}s, LAN-only)`);
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

  async listFloodTargets() {
    const db = getIotFirestore();
    const snap = await db.collection('shelly_devices').get();
    const targets = [];

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const id = String(data.deviceId || doc.id || '');
      const idLower = id.toLowerCase();
      const type = String(data.type || data.deviceType || '').toLowerCase();
      const isFlood = type.includes('flood')
        || type.includes('water_leak')
        || idLower.includes('flood');
      if (!isFlood) continue;

      const ip = data.localIp || data.ip || null;
      targets.push({
        deviceId: id,
        docId: doc.id,
        ip: ip && String(ip).trim() ? String(ip).trim() : null,
        mdns: id ? `${idLower}.local` : null,
      });
    }

    return targets;
  }

  async probe(host) {
    if (!host) return null;
    try {
      const status = await shellyLocalApi.rpc(host, 'Shelly.GetStatus', {}, RPC_TIMEOUT_MS);
      return status || null;
    } catch {
      return null;
    }
  }

  async poll() {
    if (this._inFlight) return { skipped: true, reason: 'in_flight' };
    this._inFlight = true;

    try {
      const targets = await this.listFloodTargets();
      if (targets.length === 0) return { ok: true, checked: 0, awake: 0 };

      let awake = 0;
      const results = [];

      for (const target of targets) {
        const hosts = [target.ip, target.mdns].filter(Boolean);
        let status = null;
        let reachedVia = null;

        for (const host of hosts) {
          status = await this.probe(host);
          if (status) {
            reachedVia = host;
            break;
          }
        }

        if (!status) {
          results.push({ deviceId: target.deviceId, reachable: false });
          continue;
        }

        const flood = status['flood:0'] || {};
        const temp = status['temperature:0'] || {};
        const power = status['devicepower:0'] || {};
        const wifi = status.wifi || {};
        const isFlooded = flood.alarm === true || flood.flood === true;

        const fields = {
          status: 'online',
          isFlooded,
          flood: isFlooded,
          presenceSource: 'lan_poll',
        };
        if (temp.tC != null) {
          fields.temperature = temp.tC;
          fields.temperatureF = temp.tF ?? ((temp.tC * 9) / 5 + 32);
        }
        if (power.battery?.percent != null) {
          fields.batteryPercent = power.battery.percent;
          fields.batteryLevel = power.battery.percent;
        }
        if (power.battery?.V != null) fields.batteryVoltage = power.battery.V;
        if (wifi.rssi != null) fields.wifiRssi = wifi.rssi;
        if (wifi.sta_ip) fields.ip = wifi.sta_ip;
        if (reachedVia && !String(reachedVia).endsWith('.local')) fields.localIp = reachedVia;

        await touchCloudDevicePresence(target.deviceId, fields);
        if (target.docId !== target.deviceId) {
          await touchCloudDevicePresence(target.docId, fields);
        }

        awake += 1;
        results.push({ deviceId: target.deviceId, reachable: true, via: reachedVia });
        console.log(`🌊 Flood ${target.deviceId} reachable via ${reachedVia} — marked online`);
      }

      return { ok: true, checked: targets.length, awake, results };
    } catch (error) {
      console.warn('[FloodPresencePoller] poll failed:', error.message);
      return { ok: false, error: error.message };
    } finally {
      this._inFlight = false;
    }
  }
}

const shellyFloodPresencePoller = new ShellyFloodPresencePoller();
export default shellyFloodPresencePoller;
