/**
 * Sample live climate metrics from shelly_devices into sensor_readings.
 *
 * Analytics charts read sensor_readings history. BLE/webhook paths often only
 * update the device doc (or get dropped by Cloud Run 429s), leaving the chart
 * with a single live point. This sampler writes a throttled history point from
 * whatever is already on the device doc — no LAN/BLE required.
 */

import {
  deleteCloudDevice,
  getIotFirestore,
  saveCloudSensorReading,
  touchCloudDevicePresence,
} from '../iot-cloud-firestore.js';
import { recordAutomatedWaterMitigationHealthChecks } from './waterMitigationCertificationService.js';

const DEFAULT_INTERVAL_MS = 60 * 1000;
let lastProbePurgeAt = 0;

/** Allow ops/tick?force=1 to re-run ghost purge immediately. */
export function resetClimateGhostPurgeThrottle() {
  lastProbePurgeAt = 0;
}

function isClimateDevice(data = {}, docId = '') {
  const id = String(data.deviceId || docId || '').toLowerCase();
  const type = String(data.type || data.deviceType || '').toLowerCase();
  if (type === 'relay_controller' || type === 'ble_gateway') return false;
  if (id.includes('1g4') || id.includes('blugw')) return false;
  return data.temperature != null
    || data.humidity != null
    || type.includes('humidity')
    || type.includes('temperature')
    || type === 'flood'
    || type === 'water_leak'
    || id.includes('blu-ht')
    || id.includes('shellyht')
    || id.includes('flood');
}

/** Prefer blu-ht-* over shellyhtg3-* for the same MAC so we don't double-write. */
function pickCanonicalClimateDocs(docs) {
  const byMac = new Map();

  for (const doc of docs) {
    const data = doc.data() || {};
    if (!isClimateDevice(data, doc.id)) continue;

    const deviceId = String(data.deviceId || doc.id).toLowerCase();
    let mac = null;
    if (deviceId.startsWith('blu-ht-')) mac = deviceId.slice('blu-ht-'.length);
    else if (deviceId.startsWith('shellyhtg3-')) mac = deviceId.slice('shellyhtg3-'.length);

    const key = mac || deviceId;
    const existing = byMac.get(key);
    if (!existing) {
      byMac.set(key, doc);
      continue;
    }

    const existingId = String(existing.data()?.deviceId || existing.id).toLowerCase();
    // Prefer blu-ht-* canonical cloud IDs.
    if (deviceId.startsWith('blu-ht-') && !existingId.startsWith('blu-ht-')) {
      byMac.set(key, doc);
    }
  }

  return [...byMac.values()];
}

class ClimateHistorySampler {
  constructor() {
    this._timer = null;
    this._running = false;
    this._inFlight = false;
    this._lastWriteByDevice = new Map();
    this._lastHealthCheckDate = null;
  }

  start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this._running) return;
    this._running = true;
    console.log(`📈 Climate history sampler started (every ${Math.round(intervalMs / 1000)}s)`);
    this.sample().catch(() => {});
    this._timer = setInterval(() => {
      this.sample().catch(() => {});
    }, intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }

  async purgeProbeAndAliasGhosts(_db, docs) {
    // At most once per 15 minutes — cleans webhook test probes + unassigned shellyhtg3
    // aliases that duplicate a named blu-ht-* sensor.
    if (Date.now() - lastProbePurgeAt < 15 * 60 * 1000) return { purged: 0 };
    lastProbePurgeAt = Date.now();

    const bluByMac = new Map();
    for (const doc of docs) {
      const data = doc.data() || {};
      const id = String(data.deviceId || doc.id || '').toLowerCase();
      if (!id.startsWith('blu-ht-') || id.includes('probe') || !data.propertyId) continue;
      const mac = id.slice('blu-ht-'.length);
      if (mac) bluByMac.set(mac, { id, name: data.name || null });
    }

    let purged = 0;
    for (const doc of docs) {
      const data = doc.data() || {};
      const id = String(data.deviceId || doc.id || '').toLowerCase();
      const isProbe = id.includes('probe') || id.includes('blu-ht-test');
      const mac = id.startsWith('shellyhtg3-') ? id.slice('shellyhtg3-'.length) : null;
      const isUnassignedAlias = Boolean(
        mac
        && bluByMac.has(mac)
        && !data.propertyId,
      );
      if (!isProbe && !isUnassignedAlias) continue;

      try {
        const deletedCount = await deleteCloudDevice(doc.id, id, {
          deletedBy: 'system',
          source: 'climate_history_sampler_purge',
          name: data.name || id,
          type: data.type || 'temperature_humidity',
        });
        if (deletedCount > 0) {
          purged += 1;
          console.log(`🧹 Purged ghost climate device ${id}${isProbe ? ' (probe)' : ' (alias)'} (${deletedCount} docs)`);
        } else {
          console.warn(`[ClimateHistorySampler] purge found no docs for ${id}`);
        }
      } catch (error) {
        console.warn(`[ClimateHistorySampler] purge failed for ${id}:`, error.message);
      }
    }
    return { purged };
  }

  async sample() {
    if (this._inFlight) return { skipped: true };
    this._inFlight = true;
    try {
      const db = getIotFirestore();
      const snap = await db.collection('shelly_devices').get();
      await this.purgeProbeAndAliasGhosts(db, snap.docs);
      let written = 0;
      let liveBlePropertyIds = new Set();
      let sawUnscopedLiveBle = false;

      for (const doc of pickCanonicalClimateDocs(snap.docs)) {
        const data = doc.data() || {};

        const temperature = data.temperature ?? data.temperatureC ?? null;
        const humidity = data.humidity ?? null;
        if (temperature == null && humidity == null) continue;

        const deviceId = String(data.deviceId || doc.id);
        if (/probe|blu-ht-test/i.test(deviceId)) continue;
        const lastSeenMs = data.lastSeen?.toDate?.()?.getTime?.()
          || (data.lastSeen ? new Date(data.lastSeen).getTime() : NaN);
        // Skip devices that haven't checked in recently (sleeping flood, etc.)
        if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > 3 * 60 * 60 * 1000) {
          continue;
        }

        const idLower = deviceId.toLowerCase();
        const isBleHt = idLower.startsWith('blu-ht-')
          || data.connectionType === 'bluetooth'
          || data.connectionType === 'bluetooth_gateway'
          || Boolean(data.bleAddress);
        if (isBleHt && Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < 30 * 60 * 1000) {
          if (data.propertyId) liveBlePropertyIds.add(String(data.propertyId));
          else sawUnscopedLiveBle = true;
        }

        const lastWrite = this._lastWriteByDevice.get(deviceId) || 0;
        if (Date.now() - lastWrite < 55_000) continue;

        // Prefer the device-doc throttle stamp when BLE webhooks already wrote history.
        const lastHistoryMs = data.lastHistoryWriteAt?.toDate?.()?.getTime?.()
          || (data.lastHistoryWriteAt ? new Date(data.lastHistoryWriteAt).getTime() : 0);
        if (lastHistoryMs && Date.now() - lastHistoryMs < 55_000) {
          this._lastWriteByDevice.set(deviceId, lastHistoryMs);
          continue;
        }

        const temperatureF = data.temperatureF
          ?? (temperature != null ? (temperature * 9) / 5 + 32 : null);

        // readingOnly: device docs already have live values; don't rewrite type/model.
        await saveCloudSensorReading(deviceId, {
          temperature,
          temperatureF,
          humidity,
          batteryPercent: data.batteryPercent ?? null,
          bleAddress: data.bleAddress || null,
          propertyId: data.propertyId || null,
          source: 'climate_history_sampler',
        }, { readingOnly: true });

        this._lastWriteByDevice.set(deviceId, Date.now());
        try {
          await doc.ref.set({ lastHistoryWriteAt: new Date().toISOString() }, { merge: true });
        } catch {
          // Non-fatal — history row already written.
        }
        written += 1;
        console.log(
          `📈 Climate history: ${deviceId} `
          + `${temperatureF != null ? `${Number(temperatureF).toFixed(1)}°F` : '—'} `
          + `${humidity != null ? `${Number(humidity).toFixed(0)}%` : '—'}`,
        );
      }

      // Mirror BLE child liveness onto the gateway doc so the map doesn't show
      // an offline bridge while H&Ts are clearly reporting.
      if (sawUnscopedLiveBle || liveBlePropertyIds.size > 0) {
        for (const doc of snap.docs) {
          const data = doc.data() || {};
          const id = String(data.deviceId || doc.id).toLowerCase();
          const isGateway = data.type === 'ble_gateway'
            || data.deviceType === 'ble_gateway'
            || id.includes('blugw')
            || id.includes('sngw');
          if (!isGateway) continue;
          if (
            !sawUnscopedLiveBle
            && data.propertyId
            && !liveBlePropertyIds.has(String(data.propertyId))
          ) {
            continue;
          }
          await touchCloudDevicePresence(doc.id, {
            type: 'ble_gateway',
            connectionType: 'wifi',
          });
        }
      }

      const healthCheckDate = new Date().toISOString().slice(0, 10);
      if (this._lastHealthCheckDate !== healthCheckDate) {
        const deviceRows = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
        await recordAutomatedWaterMitigationHealthChecks(deviceRows);
        this._lastHealthCheckDate = healthCheckDate;
      }

      return { ok: true, written };
    } catch (error) {
      console.warn('[ClimateHistorySampler] sample failed:', error.message);
      return { ok: false, error: error.message };
    } finally {
      this._inFlight = false;
    }
  }
}

const climateHistorySampler = new ClimateHistorySampler();
export default climateHistorySampler;
