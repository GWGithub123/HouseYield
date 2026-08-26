/**
 * Shelly IoT cloud webhook handler — runs on the public Cloud Run backend.
 * Replaces the Firebase Gen2 shellyWebhook function for device POSTs and dashboard reads.
 */

import admin from 'firebase-admin';
import {
  acknowledgeCloudAlert,
  deleteCloudDevice,
  getIotFirestore,
  listCloudAlerts,
  listCloudDevices,
} from '../iot-cloud-firestore.js';
import { actuateShellyRelay } from './shellyRelayControl.js';
import { triggerAutoCloseForAlert } from './waterShutoffAutomation.js';

const FieldValue = admin.firestore.FieldValue;
const BLE_HISTORY_WRITE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.BLE_HISTORY_WRITE_INTERVAL_MS || 60_000),
);

function hasValidShellyWebhookSecret(req, query = {}, data = {}) {
  const expected = process.env.SHELLY_WEBHOOK_SECRET || '';
  if (!expected) return true;

  const headerSecret = req.headers['x-shelly-webhook-secret'];
  const querySecret = query.secret;
  const bodySecret = data.secret;
  return headerSecret === expected || querySecret === expected || bodySecret === expected;
}

function normalizeRegisteredDeviceType(value, model = '', deviceId = '') {
  const raw = String(value || '').toLowerCase();
  if (raw === 'relay' || raw === 'relay_controller') return 'relay_controller';
  if (raw === 'gateway' || raw === 'ble_gateway') return 'gateway';
  if (raw === 'ht' || raw === 'temperature_humidity') return 'ht';
  if (raw === 'flood' || raw === 'water_leak') return 'flood';

  const modelLower = String(model || '').toLowerCase();
  const idLower = String(deviceId || '').toLowerCase();
  if (modelLower.includes('flood') || idLower.includes('flood')) return 'flood';
  if (modelLower.includes('ht') || modelLower.includes('temperature') || modelLower.includes('humidity') || idLower.includes('ht')) return 'ht';
  if (modelLower.includes('gateway') || modelLower.includes('blu') || idLower.includes('blugw')) return 'gateway';
  if (modelLower.includes('shelly1') || modelLower.includes('shelly 1') || modelLower.includes('1 gen4')) return 'relay_controller';
  return null;
}

function normalizeCloudDeviceCapabilities(type, capabilities) {
  if (Array.isArray(capabilities)) return capabilities;
  if (capabilities && typeof capabilities === 'object') {
    return Object.entries(capabilities)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key);
  }
  if (type === 'relay_controller') return ['relay', 'water_shutoff'];
  if (type === 'ht') return ['temperature', 'humidity', 'battery'];
  if (type === 'gateway') return ['ble_bridge'];
  if (type === 'flood') return ['flood', 'temperature', 'battery'];
  return [];
}

/** Button / wake / presence events from Flood Gen4 (and similar). */
function isDeviceWakeEvent(eventName = '', component = '') {
  const event = String(eventName || '').toLowerCase();
  const comp = String(component || '').toLowerCase();
  if (
    event === 'wake'
    || event === 'button'
    || event === 'button_push'
    || event === 'single_push'
    || event === 'long_push'
    || event === 'double_push'
    || event === 'btn_down'
    || event === 'btn_up'
    || event.endsWith('.button_push')
    || event.endsWith('.single_push')
    || event.endsWith('.long_push')
    || event.endsWith('.button_longpush')
    || event.includes('button_push')
    || event.includes('single_push')
  ) return true;
  if (comp.startsWith('input') && (
    event === 'single_push'
    || event === 'long_push'
    || event === 'double_push'
    || event === 'btn_down'
    || event === 'btn_up'
    || event === 'button_push'
  )) return true;
  return false;
}

/** Refresh lastSeen so the dashboard flips Sleeping → Online / Awake. */
async function markDevicePresent(db, deviceId, extra = {}) {
  if (!deviceId) return;
  await db.collection('shelly_devices').doc(String(deviceId)).set({
    lastSeen: FieldValue.serverTimestamp(),
    status: 'online',
    ...extra,
  }, { merge: true });
}

async function resolveShellySensorDocument(db, deviceId) {
  if (!deviceId) return { ref: null, data: null };

  const exactRef = db.collection('shelly_devices').doc(deviceId);
  const exactDoc = await exactRef.get();
  if (exactDoc.exists) {
    return { ref: exactRef, data: exactDoc.data() || {} };
  }

  const byDeviceId = await db.collection('shelly_devices').where('deviceId', '==', deviceId).limit(1).get();
  if (!byDeviceId.empty) {
    const match = byDeviceId.docs[0];
    return { ref: match.ref, data: match.data() || {} };
  }

  if (deviceId.startsWith('shellyfloodg4-')) {
    const floodCandidates = [];
    const floodTypeMatches = await db.collection('shelly_devices').where('deviceType', '==', 'shelly_flood_gen4').get();
    floodTypeMatches.docs.forEach((doc) => floodCandidates.push(doc));
    const legacyFloodTypeMatches = await db.collection('shelly_devices').where('type', '==', 'flood').get();
    legacyFloodTypeMatches.docs.forEach((doc) => floodCandidates.push(doc));
    const uniqueCandidates = Array.from(new Map(floodCandidates.map((doc) => [doc.ref.path, doc])).values());
    if (uniqueCandidates.length === 1) {
      const match = uniqueCandidates[0];
      return { ref: match.ref, data: match.data() || {} };
    }
  }

  return { ref: exactRef, data: null };
}

async function resolveLegacyBareFloodWebhookDevice(db, hintDeviceId) {
  if (hintDeviceId) return hintDeviceId;

  const snap = await db.collection('shelly_devices').where('type', '==', 'flood').get();
  if (snap.empty) return null;
  if (snap.size === 1) return snap.docs[0].id;
  return null;
}

async function createFloodAlert(db, deviceId, reading) {
  console.log(`🚨 FLOOD ALERT from ${deviceId}`);

  // Dedupe: skip if an open flood alert for this device was written in the last 5 minutes.
  const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);
  try {
    const recent = await db.collection('alerts')
      .where('deviceId', '==', deviceId)
      .where('type', '==', 'flood')
      .where('acknowledged', '==', false)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    if (!recent.empty) {
      const lastTs = recent.docs[0].data()?.timestamp?.toDate?.() || null;
      if (lastTs && lastTs.getTime() >= recentCutoff.getTime()) {
        await db.collection('shelly_devices').doc(deviceId).set({
          status: 'online',
          isFlooded: true,
          flood: true,
          lastSeen: FieldValue.serverTimestamp(),
        }, { merge: true });
        console.log(`⏭️ Skipping duplicate flood alert for ${deviceId} (recent open alert exists)`);
        return recent.docs[0].id;
      }
    }
  } catch (err) {
    // Missing composite index should not block alert creation.
    console.warn(`[ShellyCloudWebhook] Flood dedupe check skipped: ${err.message}`);
  }

  const { ref: sensorRef, data: sensor } = await resolveShellySensorDocument(db, deviceId);
  const sensorData = sensor || {};

  const alert = {
    deviceId,
    sensorId: deviceId,
    sensorName: sensorData.name || sensorData.location || deviceId,
    deviceName: sensorData.name || sensorData.location || deviceId,
    location: sensorData.location || sensorData.name || 'Unknown',
    propertyId: sensorData.propertyId || null,
    ownerId: sensorData.ownerId || null,
    type: 'flood',
    severity: 'critical',
    message: `🚨 FLOOD DETECTED at ${sensorData.name || sensorData.location || deviceId}!`,
    timestamp: FieldValue.serverTimestamp(),
    reading,
    acknowledged: false,
    notificationSent: false,
  };

  const alertRef = await db.collection('alerts').add(alert);

  await db.collection('shelly_devices').doc(deviceId).set({
    deviceId,
    type: sensorData.type || 'flood',
    deviceType: sensorData.deviceType || 'shelly_flood_gen4',
    manufacturer: sensorData.manufacturer || 'Shelly',
    model: sensorData.model || 'Flood Gen4',
    name: sensorData.name || sensorData.location || deviceId,
    location: sensorData.location || null,
    propertyId: sensorData.propertyId || null,
    ownerId: sensorData.ownerId || null,
    webhookUrl: sensorData.webhookUrl || null,
    status: 'online',
    hasActiveAlert: true,
    lastAlertId: alertRef.id,
    lastAlertTime: FieldValue.serverTimestamp(),
    isFlooded: true,
    flood: true,
    lastSeen: FieldValue.serverTimestamp(),
  }, { merge: true });

  if (sensorRef && sensorRef.id !== deviceId) {
    await sensorRef.set({
      deviceId,
      hasActiveAlert: true,
      lastAlertId: alertRef.id,
      lastAlertTime: FieldValue.serverTimestamp(),
      isFlooded: true,
      flood: true,
      lastSeen: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await triggerAutoCloseForAlert({
    id: alertRef.id,
    ...alert,
    timestamp: new Date().toISOString(),
  }).catch((error) => {
    console.error('[ShellyCloudWebhook] Auto-shutoff failed:', error.message);
  });

  return alertRef.id;
}

/** Persist a flood alert from local WS/MQTT paths into the IoT Firestore project. */
export async function persistFloodAlertToCloud(deviceId, reading = {}) {
  if (!deviceId) return null;
  const db = getIotFirestore();
  return createFloodAlert(db, deviceId, {
    deviceId,
    timestamp: new Date().toISOString(),
    isFlooded: true,
    source: reading.source || 'local',
    ...reading,
  });
}

async function handleDeviceRegistration(db, data, res) {
  const {
    deviceId,
    name,
    location,
    ip,
    model,
    mac,
    firmware,
    propertyId,
    type,
    deviceType: explicitDeviceType,
    connectionType,
    capabilities,
    valveState,
    pulseDurationMs,
    valveTravelMs,
    relayOutputOn,
    actuationMode,
    relayCloseOn,
    webhookUrl,
  } = data;

  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Device ID required' });
  }

  const deviceType = normalizeRegisteredDeviceType(type || explicitDeviceType, model, deviceId);
  const existingDoc = await db.collection('shelly_devices').doc(deviceId).get();
  const isReconnection = existingDoc.exists;

  const updateData = {
    deviceId,
    name: name || (isReconnection ? undefined : `Sensor ${deviceId.slice(-4)}`),
    ip: ip || null,
    model: model || (isReconnection ? undefined : 'Unknown'),
    mac: mac || (isReconnection ? undefined : null),
    firmware: firmware || undefined,
    lastSeen: FieldValue.serverTimestamp(),
    status: 'registered',
  };

  if (!isReconnection) {
    updateData.registeredAt = FieldValue.serverTimestamp();
    updateData.isFlooded = false;
    updateData.propertyId = propertyId || null;
    updateData.location = location || 'Unknown';
  } else {
    if (location) updateData.location = location;
    if (propertyId) updateData.propertyId = propertyId;
    updateData.reconnectedAt = FieldValue.serverTimestamp();
    updateData.previousIp = existingDoc.data()?.ip || null;
  }

  if (deviceType) updateData.type = deviceType;
  if (connectionType) updateData.connectionType = connectionType;
  if (capabilities) updateData.capabilities = normalizeCloudDeviceCapabilities(deviceType, capabilities);
  if (webhookUrl) updateData.webhookUrl = String(webhookUrl);
  if (deviceType === 'relay_controller') {
    updateData.valveState = valveState || (isReconnection ? undefined : 'unknown');
    updateData.pulseDurationMs = pulseDurationMs || (isReconnection ? undefined : 20000);
    updateData.valveTravelMs = valveTravelMs || (isReconnection ? undefined : 15000);
    updateData.actuationMode = actuationMode === 'momentary' ? 'momentary' : (isReconnection ? undefined : 'maintained');
    updateData.relayCloseOn = relayCloseOn === false ? false : (isReconnection ? undefined : true);
    updateData.relayOutputOn = relayOutputOn === true;
  }

  const cleanData = Object.fromEntries(Object.entries(updateData).filter(([, value]) => value !== undefined));
  await db.collection('shelly_devices').doc(deviceId).set(cleanData, { merge: true });

  return res.status(200).json({
    success: true,
    message: isReconnection ? 'Device reconnected' : 'Device registered',
    deviceId,
    type: deviceType,
    isReconnection,
  });
}

async function handleStatusUpdate(db, deviceId, data, res) {
  const params = data.params || {};
  const timestamp = params.ts ? new Date(params.ts * 1000) : new Date();
  const flood = params['flood:0'] || {};
  const temp = params['temperature:0'] || {};
  const humidity = params['humidity:0'] || {};
  const power = params['devicepower:0'] || {};
  const wifi = params.wifi || {};
  const sys = params.sys || {};
  const isFlooded = flood.alarm === true || flood.flood === true;

  const reading = {
    deviceId,
    timestamp: FieldValue.serverTimestamp(),
    localTimestamp: timestamp.toISOString(),
    type: 'status_update',
    isFlooded,
    alarm: flood.alarm || false,
    mute: flood.mute || false,
    temperature: temp.tC || null,
    temperatureC: temp.tC || null,
    temperatureF: temp.tF || null,
    humidity: humidity.rh || null,
    batteryPercent: power.battery?.percent ?? null,
    batteryVoltage: power.battery?.V ?? null,
    wifiRssi: wifi.rssi || null,
    wifiSsid: wifi.ssid || null,
    wifiIp: wifi.sta_ip || null,
    uptime: sys.uptime || null,
    mac: sys.mac || null,
    rawParams: params,
  };

  await db.collection('sensor_readings').add(reading);

  const deviceUpdate = {
    deviceId,
    lastReading: reading,
    lastSeen: FieldValue.serverTimestamp(),
    status: 'online',
    isFlooded,
    flood: isFlooded,
    batteryPercent: power.battery?.percent ?? null,
    batteryLevel: power.battery?.percent ?? null,
    wifiRssi: wifi.rssi ?? null,
    temperature: temp.tC ?? null,
    temperatureF: temp.tF ?? null,
  };
  if (humidity.rh != null) {
    deviceUpdate.humidity = humidity.rh;
    deviceUpdate['lastReading.humidity:0'] = { rh: humidity.rh };
  }
  await db.collection('shelly_devices').doc(deviceId).set(deviceUpdate, { merge: true });

  if (isFlooded) {
    await createFloodAlert(db, deviceId, reading);
  }

  return res.status(200).json({ success: true, isFlooded });
}

async function handleEvent(db, deviceId, data, res) {
  const params = data.params || {};
  const events = params.events || [];
  let woke = false;

  for (const event of events) {
    if (event.component === 'flood:0' && event.event === 'alarm') {
      await createFloodAlert(db, deviceId, {
        deviceId,
        timestamp: new Date(event.ts * 1000).toISOString(),
        isFlooded: true,
        source: 'event',
      });
      woke = true;
    }

    if (isDeviceWakeEvent(event.event, event.component)) {
      await markDevicePresent(db, deviceId, { lastWakeEvent: event.event || 'button' });
      woke = true;
      console.log(`[ShellyCloudWebhook] Wake/button event from ${deviceId}: ${event.component}.${event.event}`);
    }

    await db.collection('sensor_events').add({
      deviceId,
      timestamp: FieldValue.serverTimestamp(),
      eventTimestamp: event.ts ? new Date(event.ts * 1000) : null,
      component: event.component,
      event: event.event,
      rawEvent: event,
    });
  }

  // Any NotifyEvent from a flood sensor means it is awake on the network.
  if (!woke && deviceId && events.length > 0) {
    await markDevicePresent(db, deviceId);
  }

  return res.status(200).json({ success: true, eventsProcessed: events.length, woke });
}

async function handleDirectWebhook(db, deviceId, query, body, res) {
  const rawEvent = query.event || body.event;
  const eventAliases = {
    temperature: 'temperature.change',
    humidity: 'humidity.change',
  };
  const event = eventAliases[rawEvent] || rawEvent;
  const parseMaybeNumber = (...values) => {
    for (const value of values) {
      if (value == null || value === '') continue;
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  };

  if (event === 'flood.alarm' || event === 'flood:0.alarm' || event === 'flood.alarm.on') {
    const battery = parseMaybeNumber(query.battery, body.battery, body?.['devicepower:0']?.battery?.percent);
    const batteryV = parseMaybeNumber(query.battery_v, body.battery_v, body?.['devicepower:0']?.battery?.V);
    const tC = parseMaybeNumber(query.tC, body.tC, body?.['temperature:0']?.tC);
    const tF = parseMaybeNumber(query.tF, body.tF, body?.['temperature:0']?.tF);
    await createFloodAlert(db, deviceId, {
      deviceId,
      timestamp: new Date().toISOString(),
      isFlooded: true,
      source: 'webhook',
      batteryPercent: battery,
      batteryVoltage: batteryV,
      temperature: tC,
      temperatureF: tF,
    });
    const alarmDeviceUpdate = {
      lastSeen: FieldValue.serverTimestamp(),
      status: 'online',
      isFlooded: true,
      flood: true,
    };
    if (battery != null) {
      alarmDeviceUpdate.batteryPercent = battery;
      alarmDeviceUpdate.batteryLevel = battery;
    }
    if (batteryV != null) alarmDeviceUpdate.batteryVoltage = batteryV;
    if (tC != null) {
      alarmDeviceUpdate.temperature = tC;
      alarmDeviceUpdate.temperatureF = tF ?? ((tC * 9) / 5 + 32);
    }
    await db.collection('shelly_devices').doc(deviceId).set(alarmDeviceUpdate, { merge: true });
  }

  // Physical button wake on Flood Gen4 — must refresh lastSeen or UI stays "Sleeping".
  if (isDeviceWakeEvent(event)) {
    const battery = parseMaybeNumber(query.battery, body.battery, body?.['devicepower:0']?.battery?.percent);
    const batteryV = parseMaybeNumber(query.battery_v, body.battery_v, body?.['devicepower:0']?.battery?.V);
    const tC = parseMaybeNumber(query.tC, body.tC, body?.['temperature:0']?.tC);
    const tF = parseMaybeNumber(query.tF, body.tF, body?.['temperature:0']?.tF);
    const wakeExtra = {
      lastWakeEvent: event,
      lastWakeAt: FieldValue.serverTimestamp(),
    };
    if (battery != null) {
      wakeExtra.batteryPercent = battery;
      wakeExtra.batteryLevel = battery;
    }
    if (batteryV != null) wakeExtra.batteryVoltage = batteryV;
    if (tC != null) {
      wakeExtra.temperature = tC;
      wakeExtra.temperatureF = tF ?? ((tC * 9) / 5 + 32);
    }
    await markDevicePresent(db, deviceId, wakeExtra);
    console.log(`[ShellyCloudWebhook] Button/wake webhook from ${deviceId} event=${event} battery=${battery}`);
    return res.status(200).json({ success: true, event, awake: true, battery });
  }

  // Periodic flood:0.status / event=status check-ins — refresh presence + flood state
  // without requiring a full NotifyStatus RPC body.
  if (event === 'status' || event === 'flood:0.status' || event === 'flood.status') {
    const alarmRaw = query.alarm ?? query.flood ?? body.alarm ?? body.flood
      ?? body?.['flood:0']?.alarm ?? body?.['flood:0']?.flood;
    const isFlooded = alarmRaw === true || alarmRaw === 'true' || alarmRaw === '1' || alarmRaw === 1;
    const tC = parseMaybeNumber(query.tC, body.tC, body?.['temperature:0']?.tC);
    const tF = parseMaybeNumber(query.tF, body.tF, body?.['temperature:0']?.tF);
    const battery = parseMaybeNumber(query.battery, body.battery, body?.['devicepower:0']?.battery?.percent);

    const reading = {
      deviceId,
      timestamp: FieldValue.serverTimestamp(),
      localTimestamp: new Date().toISOString(),
      type: 'status_update',
      source: 'webhook_status',
      isFlooded,
      alarm: isFlooded,
      temperature: tC,
      temperatureC: tC,
      temperatureF: tF ?? (tC != null ? (tC * 9) / 5 + 32 : null),
      batteryPercent: battery,
    };

    await db.collection('sensor_readings').add(reading);

    const deviceUpdate = {
      deviceId,
      lastSeen: FieldValue.serverTimestamp(),
      status: 'online',
      isFlooded,
      flood: isFlooded,
      lastReading: reading,
    };
    if (tC != null) {
      deviceUpdate.temperature = tC;
      deviceUpdate.temperatureF = reading.temperatureF;
    }
    if (battery != null) {
      deviceUpdate.batteryPercent = battery;
      deviceUpdate.batteryLevel = battery;
    }

    await db.collection('shelly_devices').doc(deviceId).set(deviceUpdate, { merge: true });

    if (isFlooded) {
      await createFloodAlert(db, deviceId, reading);
    }

    return res.status(200).json({ success: true, event, isFlooded, battery });
  }

  if (event === 'relay.status' || event === 'switch.on' || event === 'switch.off') {
    const relayOutputOn = event === 'switch.on'
      ? true
      : event === 'switch.off'
        ? false
        : query.output === '1'
          || query.output === 'true'
          || body.output === true
          || body.output === 'true'
          || body.output === 1;

    const deviceDoc = await db.collection('shelly_devices').doc(deviceId).get();
    const prev = deviceDoc.exists ? (deviceDoc.data() || {}) : {};
    const relayCloseOn = prev.relayCloseOn !== false;
    const valveState = relayCloseOn
      ? (relayOutputOn ? 'closed' : 'open')
      : (relayOutputOn ? 'open' : 'closed');

    const update = {
      lastSeen: FieldValue.serverTimestamp(),
      status: 'online',
      relayOutputOn,
      valveState,
    };

    // Local LAN auto-shutoff closes the relay without going through the
    // command API — stamp lastValveCommand so the UI plays the travel animation.
    const prevValve = prev.valveState;
    const travelMs = Number(prev.valveTravelMs) >= 5000 ? Number(prev.valveTravelMs) : 15000;
    const lastAtMs = prev.lastValveCommandAt?.toDate?.()?.getTime?.()
      || (prev.lastValveCommandAt ? new Date(prev.lastValveCommandAt).getTime() : NaN);
    const expectedCmd = valveState === 'closed' ? 'close' : 'open';
    const recentCmd = prev.lastValveCommand === expectedCmd
      && Number.isFinite(lastAtMs)
      && (Date.now() - lastAtMs) < travelMs;
    if (!recentCmd && prevValve && prevValve !== valveState && (valveState === 'closed' || valveState === 'open')) {
      update.lastValveCommand = expectedCmd;
      update.lastValveCommandAt = new Date().toISOString();
      update.lastCommandSource = 'relay_status_webhook';
    }

    await db.collection('shelly_devices').doc(deviceId).set(update, { merge: true });
  }

  if (
    event === 'temperature.change'
    || event === 'humidity.change'
    || event === 'temperature.measurement'
    || event === 'humidity.measurement'
    || event === 'temperature_humidity'
  ) {
    const isBleGateway = (
      query.source === 'ble_gateway'
      || body.source === 'ble_gateway'
      || body.source === 'ble_gateway_fallback'
      || (deviceId && deviceId.startsWith('blu-ht-'))
    );
    const reading = {
      deviceId,
      timestamp: FieldValue.serverTimestamp(),
      type: 'ht_reading',
      source: isBleGateway ? 'ble_gateway' : 'webhook',
    };

    const tC = parseMaybeNumber(query.tC, body.tC);
    const tF = parseMaybeNumber(query.tF, body.tF);
    const rh = parseMaybeNumber(query.rh, body.rh);
    const battery = parseMaybeNumber(query.battery, body.battery);
    const collectorVersion = query.collector_version
      || body.collectorVersion
      || body.collector_version
      || null;
    reading.collectorVersion = collectorVersion;

    if (tC != null) {
      reading.temperatureC = tC;
      reading.temperatureF = tF || (tC * 9 / 5 + 32);
      reading.temperature = tC;
    } else if (tF != null) {
      reading.temperatureF = tF;
      reading.temperatureC = (tF - 32) * 5 / 9;
      reading.temperature = reading.temperatureC;
    }
    if (rh != null) reading.humidity = rh;
    if (battery != null) reading.batteryPercent = battery;

    if (reading.temperatureC != null || reading.humidity != null) {
      const idLower = String(deviceId || '').toLowerCase();
      if (idLower.includes('probe') || idLower.includes('blu-ht-test')) {
        console.log(`⏭️ Skipping probe/test H&T device ${deviceId}`);
        return res.status(200).json({ success: true, skipped: true, reason: 'probe_device' });
      }

      const deletedSnap = await db.collection('shelly_deleted_devices').doc(String(deviceId)).get();
      if (deletedSnap.exists) {
        console.log(`⏭️ Skipping deleted BLE/H&T device update for ${deviceId}`);
        return res.status(200).json({ success: true, skipped: true, reason: 'device_deleted' });
      }

      const deviceRef = db.collection('shelly_devices').doc(deviceId);
      const existingSnap = await deviceRef.get();
      const existing = existingSnap.exists ? (existingSnap.data() || {}) : {};
      const lastHistoryMs = existing.lastHistoryWriteAt?.toDate?.()?.getTime?.()
        || (existing.lastHistoryWriteAt ? new Date(existing.lastHistoryWriteAt).getTime() : 0);
      const shouldWriteHistory = !isBleGateway
        || !lastHistoryMs
        || (Date.now() - lastHistoryMs) >= BLE_HISTORY_WRITE_INTERVAL_MS;

      if (shouldWriteHistory) {
        await db.collection('sensor_readings').add(reading);
      }

      const deviceUpdate = {
        lastSeen: FieldValue.serverTimestamp(),
        status: 'online',
        // This timestamp is only written by the public webhook path. It is the
        // authoritative proof that collection survives without a LAN server.
        lastCloudIngestAt: FieldValue.serverTimestamp(),
        lastIngestSource: 'cloud_webhook',
        cloudDeliveryConfirmed: true,
      };
      if (collectorVersion) deviceUpdate.collectorVersion = collectorVersion;
      if (shouldWriteHistory) {
        deviceUpdate.lastHistoryWriteAt = FieldValue.serverTimestamp();
      }
      if (reading.temperatureC != null) {
        deviceUpdate.temperature = reading.temperatureC;
        deviceUpdate.temperatureF = reading.temperatureF;
        deviceUpdate['lastReading.temperature:0'] = { tC: reading.temperatureC, tF: reading.temperatureF };
      }
      if (reading.humidity != null) {
        deviceUpdate.humidity = reading.humidity;
        deviceUpdate['lastReading.humidity:0'] = { rh: reading.humidity };
      }
      if (reading.batteryPercent != null) deviceUpdate.batteryPercent = reading.batteryPercent;
      if (isBleGateway || (deviceId && deviceId.startsWith('blu-ht-'))) {
        deviceUpdate.type = 'temperature_humidity';
        deviceUpdate.connectionType = 'bluetooth_gateway';
        deviceUpdate.capabilities = ['temperature', 'humidity', 'battery'];
        deviceUpdate.model = deviceUpdate.model || 'Shelly BLU H&T';
      }
      await deviceRef.set(deviceUpdate, { merge: true });

      if (isBleGateway || (deviceId && deviceId.startsWith('blu-ht-'))) {
        const sensorSnap = await db.collection('shelly_devices').doc(deviceId).get();
        const sensorPropertyId = sensorSnap.exists ? (sensorSnap.data()?.propertyId || null) : null;
        const snap = await db.collection('shelly_devices').get();
        for (const doc of snap.docs) {
          const data = doc.data() || {};
          const isGateway = doc.id.includes('blugw')
            || data.type === 'ble_gateway'
            || data.deviceType === 'ble_gateway';
          if (!isGateway) continue;
          if (sensorPropertyId && data.propertyId && data.propertyId !== sensorPropertyId) continue;
          await doc.ref.set({
            lastSeen: FieldValue.serverTimestamp(),
            status: 'online',
            lastCloudIngestAt: FieldValue.serverTimestamp(),
            lastIngestSource: 'cloud_webhook',
            cloudDeliveryConfirmed: true,
            ...(collectorVersion ? { collectorVersion } : {}),
          }, { merge: true });
        }
      }
    }
  }

  return res.status(200).json({ success: true, event });
}

async function listReadingsForDashboard(db, query, res) {
  const hours = Math.min(Math.max(parseInt(query.hours, 10) || 168, 1), 8760);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 2000);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const snapshot = await db.collection('sensor_readings')
    .where('timestamp', '>=', cutoff)
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  const readings = snapshot.docs
    .map((docSnap) => {
      const readingData = docSnap.data() || {};
      const timestamp = readingData.timestamp?.toDate?.() || (
        readingData.timestamp ? new Date(readingData.timestamp) : null
      );

      return {
        id: docSnap.id,
        deviceId: readingData.deviceId || readingData.sensorId || '',
        temperature: readingData.temperature ?? readingData.temperatureC ?? null,
        humidity: readingData.humidity ?? null,
        flood: readingData.flood ?? null,
        batteryPercent: readingData.batteryPercent ?? null,
        timestamp: timestamp?.toISOString?.() || null,
        source: readingData.source || null,
      };
    })
    .filter((reading) => reading.temperature != null || reading.humidity != null);

  return res.status(200).json({ success: true, count: readings.length, hours, readings });
}

async function relayCommandForDashboard(data, res) {
  const deviceId = data.deviceId || data.device_id;
  const action = String(data.action || '').toLowerCase();
  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'deviceId is required' });
  }
  if (!['open', 'close', 'pulse'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be one of open, close, or pulse' });
  }

  try {
    const db = getIotFirestore();
    const deviceDoc = await db.collection('shelly_devices').doc(String(data.deviceDocId || deviceId)).get();
    const deviceData = deviceDoc.exists ? deviceDoc.data() || {} : {};
    const result = await actuateShellyRelay({
      deviceId,
      action,
      ip: deviceData.ip || deviceData.localIp || null,
      candidateIps: [deviceData.ip, deviceData.localIp, deviceData.lastKnownIp].filter(Boolean),
      actuationMode: deviceData.actuationMode || 'maintained',
      pulseDurationMs: data.durationMs || data.duration_ms || deviceData.pulseDurationMs || 20000,
      relayCloseOn: deviceData.relayCloseOn !== false,
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(502).json({ success: false, error: error.message });
  }
}

async function storeRawWebhook(db, deviceId, data) {
  await db.collection('webhook_logs').add({
    deviceId: deviceId || 'unknown',
    timestamp: FieldValue.serverTimestamp(),
    data,
  });
}

export async function handleShellyCloudWebhook(req, res) {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Shelly-Webhook-Secret');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  const db = getIotFirestore();
  const data = req.body || {};
  const query = req.query || {};

  try {
    if (req.method === 'GET') {
      if (query.action === 'alerts') {
        const alerts = await listCloudAlerts(parseInt(query.limit, 10) || 200);
        return res.status(200).json({ success: true, count: alerts.length, alerts });
      }
      if (query.action === 'devices') {
        const devices = await listCloudDevices();
        return res.status(200).json({ success: true, count: devices.length, devices });
      }
      if (query.action === 'readings') {
        return listReadingsForDashboard(db, query, res);
      }

      // Shelly Gen2/Gen4 URL webhooks invoke URLs with HTTP GET by default.
      // A bare health response here silently dropped every flood.alarm from the device.
      const getDeviceId = query.device_id || query.src || query.deviceId;
      const getEvent = query.event;
      if (getEvent || getDeviceId) {
        console.log(`[ShellyCloudWebhook] GET device webhook device=${getDeviceId} event=${getEvent}`);
        if (getEvent) {
          return handleDirectWebhook(db, getDeviceId, query, data, res);
        }
        const legacyFloodDeviceId = await resolveLegacyBareFloodWebhookDevice(db, getDeviceId);
        if (legacyFloodDeviceId) {
          return handleDirectWebhook(
            db,
            legacyFloodDeviceId,
            { ...query, event: 'flood.alarm' },
            data,
            res,
          );
        }
      }

      return res.status(200).json({ status: 'ok', message: 'Shelly cloud webhook endpoint active' });
    }

    if ((req.method === 'POST' || req.method === 'PATCH') && query.action === 'acknowledge') {
      const alertId = query.alertId || data.alertId;
      if (!alertId) {
        return res.status(400).json({ success: false, error: 'alertId is required' });
      }
      const ok = await acknowledgeCloudAlert(alertId);
      return res.status(ok ? 200 : 404).json({ success: ok });
    }

    if (req.method === 'POST' && query.action === 'relayCommand') {
      return relayCommandForDashboard(data, res);
    }

    if ((req.method === 'POST' || req.method === 'DELETE') && query.action === 'deleteDevice') {
      const deletedCount = await deleteCloudDevice(
        query.docId || query.deviceDocId,
        query.deviceId || data.deviceId,
        { source: 'cloud_run_dashboard_delete' },
      );
      return res.status(deletedCount ? 200 : 404).json({
        success: deletedCount > 0,
        deletedCount,
        message: deletedCount > 0 ? 'Sensor removed' : 'Sensor not found',
      });
    }

    if (query.action === 'register' || data.action === 'register') {
      if (!hasValidShellyWebhookSecret(req, query, data)) {
        return res.status(403).json({ success: false, error: 'Invalid webhook secret' });
      }
      return handleDeviceRegistration(db, data, res);
    }

    let deviceId = data.src || data.device_id || query.device_id || query.src || data.deviceId;

    if (data.method === 'NotifyStatus' || data.method === 'NotifyFullStatus') {
      return handleStatusUpdate(db, deviceId, data, res);
    }

    if (data.method === 'NotifyEvent') {
      return handleEvent(db, deviceId, data, res);
    }

    if (query.event || data.event) {
      return handleDirectWebhook(db, deviceId, query, data, res);
    }

    const legacyFloodDeviceId = await resolveLegacyBareFloodWebhookDevice(db, deviceId);
    if (legacyFloodDeviceId) {
      return handleDirectWebhook(
        db,
        legacyFloodDeviceId,
        { ...query, event: 'flood.alarm' },
        data,
        res,
      );
    }

    await storeRawWebhook(db, deviceId, { query, body: data });
    return res.status(200).json({ success: true, message: 'Webhook received' });
  } catch (error) {
    console.error('[ShellyCloudWebhook] Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
