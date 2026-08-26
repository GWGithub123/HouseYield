/**
 * Automatically close water shutoff valves when leak or freeze risk is detected.
 */

import shellyLocalApi from './shellyLocalApi.js';
import shellyManager from './shellyManager.js';
import { actuateShellyRelay, resolveReachableRelayIp, verifyRelayIp } from './shellyRelayControl.js';
import { getFirestore } from '../firebase-admin.js';
import {
  getIotFirestore,
  listCloudAlerts,
  listCloudDevices,
  listCloudReadings,
} from '../iot-cloud-firestore.js';
import {
  fetchCloudDevicesHttp,
} from '../utils/iotCloudHttpApi.js';
import { buildPropertyInfoForSensorAlert } from '../utils/sensorAlertOwner.js';
import {
  buildOwnerDispatchKey,
  isOwnerDispatchClaimed,
  tryClaimOwnerDispatch,
} from '../utils/sensorAlertOwnerDispatchDedup.js';
import { markWaterMitigationRecertificationRequired } from './waterMitigationCertificationService.js';

const AUTO_CLOSE_COOLDOWN_MS = 5 * 60 * 1000;
// Prefer direct IoT Firestore (see loadCloud* below). Keep HTTP as fallback only,
// and poll slowly so we don't 429 the shared Cloud Function used by device webhooks.
const CLOUD_MONITOR_POLL_MS = 60 * 1000;
const FREEZE_CRITICAL_TEMP_F = 32;
const FREEZE_TREND_MAX_TEMP_F = 40;
const FREEZE_TREND_MAX_HOURS = 8;
const FREEZE_READING_LOOKBACK_HOURS = 6;

const recentAutoCloses = new Map();
const processedCloudAlertIds = new Set();
const processedFreezeTriggers = new Set();
let cloudMonitorStarted = false;
let sensorMaintenanceDispatchHandler = null;

export function setSensorMaintenanceDispatchHandler(handler) {
  sensorMaintenanceDispatchHandler = typeof handler === 'function' ? handler : null;
}

async function maybeDispatchOwnerMaintenanceForLeak({
  propertyId,
  triggerId,
  sensorDeviceId,
  practiceTestPhone = null,
} = {}) {
  if (!sensorMaintenanceDispatchHandler || !propertyId) {
    return null;
  }

  const dedupeKey = buildOwnerDispatchKey({
    alertId: triggerId,
    propertyId,
    sensorDeviceId,
  });
  if (isOwnerDispatchClaimed(dedupeKey)) {
    return { ok: true, skipped: true, reason: 'already_dispatched' };
  }

  const claim = tryClaimOwnerDispatch(dedupeKey);
  if (!claim.claimed) {
    return { ok: true, skipped: true, reason: claim.reason || 'already_dispatched' };
  }

  const alert = {
    id: triggerId || dedupeKey,
    type: 'flood',
    propertyId,
    deviceId: sensorDeviceId,
    sensorId: sensorDeviceId,
    message: 'Water leak detected — valve auto-closed',
    timestamp: new Date().toISOString(),
  };

  const result = await sensorMaintenanceDispatchHandler({
    alert,
    propertyInfo: buildPropertyInfoForSensorAlert(alert),
    practiceTestPhone,
  }).catch((error) => ({
    ok: false,
    error: error.message,
  }));

  if (!result?.ok) {
    console.warn('[WaterShutoff] Owner maintenance SMS dispatch failed:', {
      dedupeKey,
      error: result?.error || result?.reason,
    });
  } else {
    console.log('[WaterShutoff] Owner maintenance SMS dispatch started:', dedupeKey, result?.requestId || '');
  }

  return result;
}

function isRelayController(data = {}) {
  return data.type === 'relay_controller'
    || data.deviceType === 'shelly_relay_gen4'
    || (Array.isArray(data.capabilities) && data.capabilities.includes('water_shutoff'));
}

function isTemperatureSensor(data = {}) {
  const type = String(data.type || '').toLowerCase();
  return type === 'temperature_humidity'
    || type === 'ht'
    || type === 'temperature'
    || (Array.isArray(data.capabilities) && (
      data.capabilities.includes('temperature')
      || data.capabilities.includes('humidity')
    ));
}

function normalizePropertyId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cToF(celsius) {
  return (celsius * 9 / 5) + 32;
}

function readingTempF(reading = {}) {
  if (reading.temperatureF != null) return Number(reading.temperatureF);
  if (reading.temperature != null) return cToF(Number(reading.temperature));
  if (reading.temperatureC != null) return cToF(Number(reading.temperatureC));
  return null;
}

function deviceTempF(device = {}) {
  if (device.temperatureF != null) return Number(device.temperatureF);
  if (device.temperature != null) return cToF(Number(device.temperature));
  return null;
}

async function resolveShellyDeviceDoc(db, candidateDocIds, candidateDeviceIds) {
  for (const docId of candidateDocIds) {
    if (!docId) continue;
    const snapshot = await db.collection('shelly_devices').doc(docId).get();
    if (snapshot.exists) {
      return { docRef: snapshot.ref, snapshot };
    }
  }

  for (const deviceId of candidateDeviceIds) {
    if (!deviceId) continue;
    const snapshot = await db.collection('shelly_devices').where('deviceId', '==', deviceId).limit(1).get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      return { docRef: doc.ref, snapshot: doc };
    }
  }

  return null;
}

async function listRelayControllersFromHttp(propertyId) {
  const normalizedPropertyId = normalizePropertyId(propertyId);
  if (!normalizedPropertyId) {
    return [];
  }

  try {
    const devices = await fetchCloudDevicesHttp();
    return devices
      .filter((device) => {
        const devicePropertyId = normalizePropertyId(device.propertyId);
        if (devicePropertyId !== normalizedPropertyId) return false;
        return isRelayController(device);
      })
      .map((device) => ({
        docId: device.id || device.deviceId,
        deviceId: device.deviceId || device.id,
        db: null,
        source: 'cloud-http',
        ...device,
        localIp: device.localIp || device.ip || null,
        ip: device.ip || device.localIp || null,
      }));
  } catch (error) {
    console.warn('[WaterShutoff] Cloud HTTP relay lookup failed:', error.message);
    return [];
  }
}

async function listRelayControllersForProperty(propertyId) {
  const normalizedPropertyId = normalizePropertyId(propertyId);
  if (!normalizedPropertyId) {
    return [];
  }

  const relays = new Map();
  const databases = [];

  try {
    databases.push(getFirestore());
  } catch {
    // Local Firestore may be unavailable in some environments.
  }

  try {
    databases.push(getIotFirestore());
  } catch {
    // IoT Firestore may be unavailable locally.
  }

  for (const db of databases) {
    try {
      const snapshot = await db.collection('shelly_devices')
        .where('propertyId', '==', normalizedPropertyId)
        .get();

      for (const doc of snapshot.docs) {
        const data = doc.data() || {};
        if (!isRelayController(data)) continue;
        const deviceId = data.deviceId || doc.id;
        relays.set(deviceId, {
          docId: doc.id,
          deviceId,
          db,
          ...data,
        });
      }
    } catch (error) {
      console.warn('[WaterShutoff] Relay lookup failed:', error.message);
    }
  }

  try {
    const devices = await shellyManager.getAllDevices();
    for (const device of devices) {
      if (device.propertyId !== normalizedPropertyId) continue;
      if (device.type !== 'relay_controller') continue;
      relays.set(device.id, {
        docId: device.id,
        deviceId: device.id,
        db: null,
        name: device.name,
        location: device.location,
        propertyId: device.propertyId,
        localIp: device.ip,
        ip: device.ip,
        actuationMode: device.actuationMode,
        relayCloseOn: device.relayCloseOn,
        pulseDurationMs: device.pulseDurationMs,
        valveState: device.valveState,
      });
    }
  } catch (error) {
    console.warn('[WaterShutoff] In-memory relay lookup failed:', error.message);
  }

  for (const relay of await listRelayControllersFromHttp(normalizedPropertyId)) {
    relays.set(relay.deviceId, relay);
  }

  return Array.from(relays.values());
}

function isRelayValveClosedFromData(relay = {}) {
  if (relay.valveState === 'closed') {
    return true;
  }

  if (relay.relayOutputOn === true || relay.relayOutputOn === false) {
    const relayCloseOn = relay.relayCloseOn !== false;
    return relayCloseOn ? relay.relayOutputOn === true : relay.relayOutputOn === false;
  }

  return false;
}

function relayOutputIndicatesClosed(relayOutputOn, relayCloseOn = true) {
  return relayCloseOn ? relayOutputOn === true : relayOutputOn === false;
}

function shouldSkipAutoClose(propertyId, triggerId, relay) {
  // Only dedupe rapid repeats for the same alert — do not skip based on stale Firestore
  // valveState. executeRelayClose verifies live relay output before actuating.
  const key = `${propertyId}:${relay.deviceId}`;
  const last = recentAutoCloses.get(key);
  if (!last) {
    return false;
  }

  const withinCooldown = Date.now() - last.at < AUTO_CLOSE_COOLDOWN_MS;
  const sameTrigger = triggerId && last.triggerId === triggerId;

  return withinCooldown && sameTrigger;
}

async function touchRelayClosedState(relay, relayStatus, deviceIp = null, { stampCommand = false } = {}) {
  const deviceId = relay.deviceId;
  const touchUpdate = {
    lastSeen: new Date().toISOString(),
    status: 'online',
    relayOutputOn: relayStatus.output === true,
    valveState: 'closed',
    ...(deviceIp ? { ip: deviceIp, localIp: deviceIp } : {}),
  };

  if (stampCommand) {
    const travelMs = Number(relay.valveTravelMs) >= 5000 ? Number(relay.valveTravelMs) : 15000;
    const lastAtMs = relay.lastValveCommandAt ? new Date(relay.lastValveCommandAt).getTime() : NaN;
    const recentClose = relay.lastValveCommand === 'close'
      && Number.isFinite(lastAtMs)
      && (Date.now() - lastAtMs) < travelMs;
    if (!recentClose) {
      touchUpdate.lastValveCommand = 'close';
      touchUpdate.lastValveCommandAt = new Date().toISOString();
      touchUpdate.lastCommandSource = 'auto_shutoff_observed';
    }
  }

  const localDb = getFirestore();
  const updateWrites = [
    localDb.collection('shelly_devices').doc(deviceId).set(touchUpdate, { merge: true }).catch((error) => {
      console.warn('[WaterShutoff] Local relay touch write failed:', error.message);
    }),
  ];

  if (relay.db) {
    updateWrites.push(
      relay.db.collection('shelly_devices').doc(relay.docId || deviceId).set(touchUpdate, { merge: true }).catch((error) => {
        console.warn('[WaterShutoff] Primary relay touch write failed:', error.message);
      })
    );
  }

  try {
    updateWrites.push(
      getIotFirestore().collection('shelly_devices').doc(deviceId).set(touchUpdate, { merge: true }).catch((error) => {
        console.warn('[WaterShutoff] Cloud relay touch write failed:', error.message);
      })
    );
  } catch {
    // Cloud mirror is optional locally.
  }

  await Promise.all(updateWrites);
  shellyManager.updateDeviceData(deviceId, touchUpdate);

  return touchUpdate;
}

async function executeRelayClose(relay, { triggerId, source, reason }) {
  const deviceId = relay.deviceId;
  const actuationMode = relay.actuationMode === 'momentary' ? 'momentary' : 'maintained';
  const relayCloseOn = relay.relayCloseOn !== false;
  const pulseMs = Math.max(
    250,
    Math.min(Number(relay.pulseDurationMs) || 20000, 60000)
  );

  const candidateIps = [
    shellyManager.devices?.get?.(deviceId)?.ip,
    relay.localIp,
    relay.ip,
  ].filter(Boolean);
  const deviceIp = await resolveReachableRelayIp(deviceId, candidateIps);

  if (deviceIp) {
    const initialRelayStatus = await shellyLocalApi.getRelayStatus(deviceIp).catch(() => null);
    if (
      initialRelayStatus
      && relayOutputIndicatesClosed(initialRelayStatus.output === true, relayCloseOn)
    ) {
      // Local LAN shutoff may have just closed the valve before this cloud
      // path ran — stamp lastValveCommand when Firestore still showed open
      // so the topology map plays the normal travel animation.
      const wasOpenInFirestore = !isRelayValveClosedFromData(relay);
      const touchUpdate = await touchRelayClosedState(relay, initialRelayStatus, deviceIp, {
        stampCommand: wasOpenInFirestore,
      });
      return {
        ok: true,
        skipped: true,
        deviceId,
        deviceName: relay.name || deviceId,
        valveState: 'closed',
        relayOutputOn: touchUpdate.relayOutputOn,
        reason: 'already_closed',
        message: 'Valve is already closed.',
      };
    }
  }

  try {
    const actuation = await actuateShellyRelay({
      deviceId,
      action: 'close',
      ip: deviceIp,
      candidateIps,
      actuationMode,
      pulseDurationMs: pulseMs,
      relayCloseOn,
    });

    const commandUpdate = {
      localIp: actuation.ip || deviceIp || null,
      ip: actuation.ip || deviceIp || null,
      lastSeen: new Date().toISOString(),
      status: 'online',
      relayOutputOn: actuation.relayOutputOn === true,
      valveState: 'closed',
      lastValveCommand: 'close',
      lastValveCommandAt: new Date().toISOString(),
      lastAutoCloseTriggerId: triggerId || null,
      lastAutoCloseSource: source || 'auto_shutoff',
      lastAutoCloseReason: reason || null,
      pulseDurationMs: pulseMs,
      actuationMode,
      relayCloseOn,
      lastCommandSource: actuation.source || 'unknown',
    };

    const localDb = getFirestore();
    const updateWrites = [
      localDb.collection('shelly_devices').doc(deviceId).set(commandUpdate, { merge: true }).catch((error) => {
        console.warn('[WaterShutoff] Local relay state write failed:', error.message);
      }),
    ];

    if (relay.db) {
      updateWrites.push(
        relay.db.collection('shelly_devices').doc(relay.docId || deviceId).set(commandUpdate, { merge: true }).catch((error) => {
          console.warn('[WaterShutoff] Primary relay state write failed:', error.message);
        })
      );
    }

    try {
      updateWrites.push(
        getIotFirestore().collection('shelly_devices').doc(deviceId).set(commandUpdate, { merge: true }).catch((error) => {
          console.warn('[WaterShutoff] Cloud relay state write failed:', error.message);
        })
      );
    } catch {
      // Cloud mirror is optional locally.
    }

    await Promise.all(updateWrites);
    shellyManager.updateDeviceData(deviceId, commandUpdate);

    return {
      ok: true,
      deviceId,
      deviceName: relay.name || deviceId,
      valveState: 'closed',
      relayOutputOn: commandUpdate.relayOutputOn,
      source: actuation.source,
      message: reason === 'freeze'
        ? 'Valve auto-closed due to freeze risk.'
        : 'Valve auto-closed due to leak detection.',
    };
  } catch (error) {
    return {
      ok: false,
      deviceId,
      error: error.message,
    };
  }
}

export function isFloodLikeAlert(alert = {}) {
  const type = String(alert.type || '').toLowerCase();
  return type === 'flood' || type === 'water_leak';
}

export function isFreezeLikeAlert(alert = {}) {
  const type = String(alert.type || '').toLowerCase();
  return type === 'freeze_risk' || type === 'pipe_burst' || type === 'rapid_temp_change';
}

export function isAutoShutoffAlert(alert = {}) {
  return isFloodLikeAlert(alert) || isFreezeLikeAlert(alert);
}

export function evaluateFreezeShutoffTrigger(device, readings = []) {
  const deviceId = device.deviceId || device.id;
  const deviceReadings = readings
    .filter((reading) => (reading.deviceId || reading.sensorId) === deviceId)
    .map((reading) => ({
      ...reading,
      tempF: readingTempF(reading),
      at: reading.timestamp ? new Date(reading.timestamp).getTime() : 0,
    }))
    .filter((reading) => reading.tempF != null && reading.at > 0)
    .sort((a, b) => b.at - a.at);

  const currentTempF = deviceTempF(device) ?? deviceReadings[0]?.tempF ?? null;
  if (currentTempF == null) {
    return null;
  }

  if (currentTempF <= FREEZE_CRITICAL_TEMP_F) {
    return {
      reason: 'below_freezing',
      currentTempF,
      deviceId,
      deviceName: device.name || deviceId,
      propertyId: device.propertyId,
    };
  }

  if (deviceReadings.length < 2) {
    return null;
  }

  const newest = deviceReadings[0];
  const oldest = deviceReadings[deviceReadings.length - 1];
  const hours = (newest.at - oldest.at) / (60 * 60 * 1000);
  if (hours < 0.25) {
    return null;
  }

  const slopePerHour = (newest.tempF - oldest.tempF) / hours;
  if (slopePerHour >= -0.05) {
    return null;
  }

  const hoursToFreeze = (newest.tempF - FREEZE_CRITICAL_TEMP_F) / Math.abs(slopePerHour);
  if (
    newest.tempF <= FREEZE_TREND_MAX_TEMP_F
    && hoursToFreeze <= FREEZE_TREND_MAX_HOURS
  ) {
    return {
      reason: 'trending_to_freeze',
      currentTempF: newest.tempF,
      hoursToFreeze,
      slopePerHour,
      deviceId,
      deviceName: device.name || deviceId,
      propertyId: device.propertyId,
    };
  }

  return null;
}

export async function triggerAutoCloseForProperty({
  propertyId,
  triggerId = null,
  sensorDeviceId = null,
  source = 'auto_shutoff',
  reason = 'leak',
} = {}) {
  let resolvedPropertyId = normalizePropertyId(propertyId);

  if (!resolvedPropertyId && sensorDeviceId) {
    const lookupDbs = [];
    try { lookupDbs.push(getFirestore()); } catch { /* ignore */ }
    try { lookupDbs.push(getIotFirestore()); } catch { /* ignore */ }

    for (const db of lookupDbs) {
      const resolved = await resolveShellyDeviceDoc(db, [sensorDeviceId], [sensorDeviceId]);
      if (resolved?.snapshot?.exists) {
        resolvedPropertyId = normalizePropertyId(resolved.snapshot.data()?.propertyId);
        if (resolvedPropertyId) break;
      }
    }

    if (!resolvedPropertyId) {
      try {
        const devices = await fetchCloudDevicesHttp();
        const sensor = devices.find((device) => (
          device.deviceId === sensorDeviceId || device.id === sensorDeviceId
        ));
        resolvedPropertyId = normalizePropertyId(sensor?.propertyId);
      } catch (error) {
        console.warn('[WaterShutoff] Cloud HTTP sensor lookup failed:', error.message);
      }
    }
  }

  if (!resolvedPropertyId) {
    console.warn('[WaterShutoff] No propertyId available for auto-close', { triggerId, sensorDeviceId, reason });
    return {
      ok: false,
      skipped: true,
      reason: 'missing_property',
      triggerId,
      sensorDeviceId,
    };
  }

  const relays = await listRelayControllersForProperty(resolvedPropertyId);
  if (relays.length === 0) {
    console.warn('[WaterShutoff] No relay controller registered for property', resolvedPropertyId);
    return {
      ok: false,
      skipped: true,
      reason: 'no_relay_controller',
      propertyId: resolvedPropertyId,
      triggerId,
      sensorDeviceId,
    };
  }

  const logLabel = reason === 'freeze' ? 'Freeze risk' : 'Leak detected';
  console.log(`🚰 [WaterShutoff] ${logLabel} — closing ${relays.length} valve controller(s) for property ${resolvedPropertyId}`);

  const results = [];
  for (const relay of relays) {
    const cooldownKey = `${resolvedPropertyId}:${relay.deviceId}`;
    if (shouldSkipAutoClose(resolvedPropertyId, triggerId, relay)) {
      results.push({
        ok: true,
        skipped: true,
        deviceId: relay.deviceId,
        valveState: isRelayValveClosedFromData(relay) ? 'closed' : undefined,
        reason: isRelayValveClosedFromData(relay) ? 'already_closed' : 'recent_auto_close',
      });
      continue;
    }

    try {
      const result = await executeRelayClose(relay, { triggerId, source, reason });
      results.push(result);
      if (result.ok) {
        recentAutoCloses.set(cooldownKey, {
          at: Date.now(),
          triggerId,
          action: 'close',
        });
        if (!result.skipped) {
          console.log(`✅ [WaterShutoff] Auto-close succeeded for ${relay.deviceId}`);
        }
      } else {
        console.warn(`[WaterShutoff] Auto-close did not actuate ${relay.deviceId}:`, result.error || result.reason || 'unknown');
      }
    } catch (error) {
      console.error(`[WaterShutoff] Auto-close failed for ${relay.deviceId}:`, error.message);
      results.push({
        ok: false,
        deviceId: relay.deviceId,
        error: error.message,
      });
    }
  }

  const anySucceeded = results.some((entry) => entry.ok && !entry.skipped);
  const firstFailure = results.find((entry) => !entry.ok && !entry.skipped);
  if (!anySucceeded && firstFailure) {
    console.warn('[WaterShutoff] Auto-close did not actuate valve:', firstFailure.error || firstFailure.reason || 'unknown');
  }
  let ownerMaintenanceDispatch = null;
  if (anySucceeded && reason === 'leak') {
    ownerMaintenanceDispatch = await maybeDispatchOwnerMaintenanceForLeak({
      propertyId: resolvedPropertyId,
      triggerId,
      sensorDeviceId,
    });
  }
  if (anySucceeded) {
    let ownerId = relays.find((relay) => relay.ownerId || relay.userId)?.ownerId
      || relays.find((relay) => relay.ownerId || relay.userId)?.userId
      || null;
    if (!ownerId) {
      const propertySnapshot = await getFirestore().collection('properties').doc(resolvedPropertyId).get().catch(() => null);
      const property = propertySnapshot?.exists ? propertySnapshot.data() : null;
      ownerId = property?.ownerId || property?.userId || property?.landlordId || null;
    }
    if (ownerId) {
      await markWaterMitigationRecertificationRequired({
        ownerId,
        propertyId: resolvedPropertyId,
        reason: 'automatic_shutoff_event',
        sourceId: triggerId || null,
        details: { triggerReason: reason, source, sensorDeviceId },
      }).catch((error) => {
        console.warn('[WaterShutoff] Could not require post-event recertification:', error.message);
      });
    }
  }

  return {
    ok: anySucceeded,
    propertyId: resolvedPropertyId,
    triggerId,
    sensorDeviceId,
    reason,
    results,
    ownerMaintenanceDispatch,
  };
}

/** @deprecated Use triggerAutoCloseForProperty */
export async function triggerAutoCloseForLeak(args = {}) {
  return triggerAutoCloseForProperty({
    ...args,
    triggerId: args.alertId ?? args.triggerId ?? null,
    reason: 'leak',
  });
}

export async function triggerAutoCloseForAlert(alert = {}) {
  if (!isAutoShutoffAlert(alert)) {
    return { ok: false, skipped: true, reason: 'not_auto_shutoff_alert' };
  }

  return triggerAutoCloseForProperty({
    propertyId: alert.propertyId,
    triggerId: alert.id,
    sensorDeviceId: alert.deviceId || alert.sensorId,
    source: isFreezeLikeAlert(alert) ? 'freeze_alert' : 'flood_alert',
    reason: isFreezeLikeAlert(alert) ? 'freeze' : 'leak',
  });
}

async function pollCloudShutoffAlerts() {
  try {
    // Direct IoT Firestore — avoids hammering the shared Cloud Function (429s).
    let alerts = [];
    try {
      alerts = await listCloudAlerts(30);
    } catch (directError) {
      console.warn('[WaterShutoff] Direct alert poll failed, skipping HTTP fallback this cycle:', directError.message);
      return;
    }

    for (const alert of alerts) {
      if (!isAutoShutoffAlert(alert)) continue;
      if (alert.acknowledged) continue;
      if (processedCloudAlertIds.has(alert.id)) continue;

      const alertTime = alert.timestamp ? new Date(alert.timestamp).getTime() : 0;
      const alertAgeMs = alertTime ? Date.now() - alertTime : Number.MAX_SAFE_INTEGER;
      if (alertAgeMs > 30 * 60 * 1000) {
        processedCloudAlertIds.add(alert.id);
        continue;
      }

      processedCloudAlertIds.add(alert.id);
      console.log(`🚰 [WaterShutoff] New cloud ${alert.type} alert ${alert.id} — triggering auto-close`);

      await triggerAutoCloseForAlert(alert).catch((error) => {
        console.error('[WaterShutoff] Cloud alert poll auto-close failed:', error.message);
      });
    }

    if (processedCloudAlertIds.size > 500) {
      processedCloudAlertIds.clear();
    }
  } catch (error) {
    console.warn('[WaterShutoff] Cloud alert poll failed:', error.message);
  }
}

async function pollCloudFreezeConditions() {
  try {
    let devices = [];
    let readings = [];
    try {
      [devices, readings] = await Promise.all([
        listCloudDevices(),
        listCloudReadings(FREEZE_READING_LOOKBACK_HOURS, 5000),
      ]);
    } catch (directError) {
      console.warn('[WaterShutoff] Direct freeze poll failed:', directError.message);
      return;
    }

    for (const device of devices) {
      if (!isTemperatureSensor(device)) continue;
      const propertyId = normalizePropertyId(device.propertyId);
      if (!propertyId) continue;

      const trigger = evaluateFreezeShutoffTrigger(device, readings);
      if (!trigger) continue;

      const triggerKey = `${propertyId}:${trigger.deviceId}:${trigger.reason}`;
      if (processedFreezeTriggers.has(triggerKey)) continue;
      processedFreezeTriggers.add(triggerKey);

      console.log(
        `🥶 [WaterShutoff] Freeze trigger on ${trigger.deviceName}: ${trigger.reason}`
        + (trigger.currentTempF != null ? ` (${trigger.currentTempF.toFixed(1)}°F)` : '')
        + (trigger.hoursToFreeze != null ? `, ~${trigger.hoursToFreeze.toFixed(1)}h to 32°F` : '')
      );

      await triggerAutoCloseForProperty({
        propertyId,
        triggerId: triggerKey,
        sensorDeviceId: trigger.deviceId,
        source: 'freeze_temp_poll',
        reason: 'freeze',
      }).catch((error) => {
        console.error('[WaterShutoff] Freeze poll auto-close failed:', error.message);
      });
    }

    if (processedFreezeTriggers.size > 500) {
      processedFreezeTriggers.clear();
    }
  } catch (error) {
    console.warn('[WaterShutoff] Freeze condition poll failed:', error.message);
  }
}

async function pollCloudAutoShutoffConditions() {
  await pollCloudShutoffAlerts();
  await pollCloudFreezeConditions();
}

export function startLeakAutoShutoffMonitor() {
  if (cloudMonitorStarted) {
    return;
  }

  cloudMonitorStarted = true;
  console.log(`🚰 [WaterShutoff] Monitoring leak/freeze shutoff triggers every ${CLOUD_MONITOR_POLL_MS / 1000}s`);

  pollCloudAutoShutoffConditions().catch(() => {});
  setInterval(() => {
    pollCloudAutoShutoffConditions().catch(() => {});
  }, CLOUD_MONITOR_POLL_MS);
}
