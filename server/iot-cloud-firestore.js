/**
 * Firestore access for Shelly IoT cloud data.
 * Sensor webhooks write to the IoT Firebase project, which may differ from the
 * main app Firebase project configured in FIREBASE_PROJECT_ID.
 */

import admin from 'firebase-admin';
import { resolveIotFirebaseProjectId } from './utils/iotProjectConfig.js';
import { getFirestore as getMainFirestore } from './firebase-admin.js';

const IOT_PROJECT_ID = resolveIotFirebaseProjectId();
const MAIN_PROJECT_ID = process.env.FIREBASE_PROJECT_ID
  || process.env.GOOGLE_CLOUD_PROJECT
  || 'houseyield';

let iotApp = null;

function getIotApp() {
  if (iotApp) {
    return iotApp;
  }

  const existing = admin.apps.find((app) => app?.name === 'iot-cloud');
  if (existing) {
    iotApp = existing;
    return iotApp;
  }

  if (IOT_PROJECT_ID === MAIN_PROJECT_ID) {
    iotApp = admin.apps.find((app) => app?.name !== 'iot-cloud' && app) || admin.app();
    return iotApp;
  }

  iotApp = admin.initializeApp({ projectId: IOT_PROJECT_ID }, 'iot-cloud');
  return iotApp;
}

export function getIotFirestore() {
  if (IOT_PROJECT_ID === MAIN_PROJECT_ID) {
    return getMainFirestore();
  }
  return getIotApp().firestore();
}

export function getIotProjectId() {
  return IOT_PROJECT_ID;
}

export function bleAddrToCloudDeviceId(addr) {
  const normalized = String(addr || '').replace(/:/g, '').trim().toLowerCase();
  if (!normalized) return null;
  return `blu-ht-${normalized}`;
}

export function getShellyDeviceIdAliases(deviceId) {
  const raw = String(deviceId || '').trim();
  if (!raw) return [];

  const normalized = raw.replace(/:/g, '').toLowerCase();
  const aliases = new Set([raw, normalized]);

  if (normalized.startsWith('blu-ht-')) {
    aliases.add(`shellyhtg3-${normalized.slice('blu-ht-'.length)}`);
  } else if (normalized.startsWith('shellyhtg3-')) {
    aliases.add(`blu-ht-${normalized.slice('shellyhtg3-'.length)}`);
  } else if (/^[a-f0-9]{8,}$/i.test(normalized)) {
    aliases.add(`blu-ht-${normalized}`);
    aliases.add(`shellyhtg3-${normalized}`);
  }

  return Array.from(aliases).filter(Boolean);
}

export async function clearShellyDeviceDeleted(deviceId) {
  if (!deviceId) return;
  const db = getIotFirestore();
  const aliases = getShellyDeviceIdAliases(deviceId);
  await Promise.all(
    aliases.map((alias) => db.collection('shelly_deleted_devices').doc(String(alias)).delete().catch(() => null)),
  );
}

/**
 * Update lastSeen / live readings without creating a sensor_readings doc.
 * Used when the cloud function already stored the reading but local ingest
 * must keep the dashboard fresh.
 */
export async function registerCloudDevice(deviceId, fields = {}, options = {}) {
  if (!deviceId) return;

  const db = getIotFirestore();
  // Only clear tombstones for intentional setup/register flows.
  // Auto-saves must not resurrect deleted H&T/gateway aliases.
  if (options.clearTombstone) {
    await clearShellyDeviceDeleted(deviceId);
  } else {
    const aliases = getShellyDeviceIdAliases(deviceId);
    for (const alias of aliases) {
      const snap = await db.collection('shelly_deleted_devices').doc(String(alias)).get();
      if (snap.exists) {
        console.log(`⏭️ Skipping cloud save for tombstoned device ${deviceId}`);
        return;
      }
    }
  }

  const cleanData = Object.fromEntries(
    Object.entries({
      deviceId,
      ...fields,
      lastSeen: admin.firestore.FieldValue.serverTimestamp(),
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      status: fields.status || 'registered',
    }).filter(([_, value]) => value !== undefined),
  );

  await db.collection('shelly_devices').doc(deviceId).set(cleanData, { merge: true });
}

export async function touchCloudDevicePresence(deviceId, fields = {}) {
  if (!deviceId) return;

  const db = getIotFirestore();
  const update = {
    ...fields,
    lastSeen: admin.firestore.FieldValue.serverTimestamp(),
    status: 'online',
  };

  if (fields.temperature != null) {
    update.temperatureF = fields.temperatureF ?? ((fields.temperature * 9) / 5) + 32;
    update['lastReading.temperature:0'] = {
      tC: fields.temperature,
      tF: update.temperatureF,
    };
  }
  if (fields.humidity != null) {
    update['lastReading.humidity:0'] = { rh: fields.humidity };
  }

  await db.collection('shelly_devices').doc(deviceId).set(update, { merge: true });
}

/**
 * Persist offline presence when a device drops its outbound WebSocket / MQTT link.
 * Does not bump lastSeen — the last real check-in stays as-is for age-based UI.
 */
export async function markCloudDeviceOffline(deviceId, fields = {}) {
  if (!deviceId) return;

  const db = getIotFirestore();
  const update = {
    ...fields,
    status: 'offline',
    wentOfflineAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('shelly_devices').doc(deviceId).set(update, { merge: true });
}

/**
 * Full BLE fallback write to the IoT Firebase project (not the main app project).
 * @param {object} [options]
 * @param {boolean} [options.readingOnly] - Only append sensor_readings (no device doc mutation).
 * @param {boolean} [options.skipBluHtMetadata] - Update temp/humidity/presence without forcing BLU H&T type.
 */
export async function saveCloudSensorReading(deviceId, reading = {}, options = {}) {
  if (!deviceId) return;

  const db = getIotFirestore();
  const readingDoc = {
    deviceId,
    propertyId: reading.propertyId || null,
    temperature: reading.temperature ?? null,
    temperatureC: reading.temperature ?? null,
    temperatureF: reading.temperatureF ?? (reading.temperature != null ? (reading.temperature * 9) / 5 + 32 : null),
    humidity: reading.humidity ?? null,
    batteryPercent: reading.batteryPercent ?? null,
    source: reading.source || 'ble_gateway_fallback',
    type: 'ht_reading',
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('sensor_readings').add(readingDoc);

  if (options.readingOnly) return;

  const deviceUpdate = {};
  const skipMeta = options.skipBluHtMetadata
    || reading.source === 'climate_history_sampler'
    || reading.source === 'ht_trend';
  if (!skipMeta) {
    deviceUpdate.type = 'temperature_humidity';
    deviceUpdate.connectionType = 'bluetooth_gateway';
    deviceUpdate.model = 'Shelly BLU H&T';
    deviceUpdate.capabilities = ['temperature', 'humidity', 'battery'];
  }
  if (reading.temperature != null) deviceUpdate.temperature = reading.temperature;
  if (reading.temperatureF != null) deviceUpdate.temperatureF = reading.temperatureF;
  if (reading.humidity != null) deviceUpdate.humidity = reading.humidity;
  if (reading.batteryPercent != null) deviceUpdate.batteryPercent = reading.batteryPercent;
  if (reading.bleAddress) deviceUpdate.bleAddress = reading.bleAddress;

  // Sampler already copies live values — only bump lastSeen via presence when
  // we have something to write (avoids empty touch for reading-only paths).
  if (Object.keys(deviceUpdate).length > 0) {
    await touchCloudDevicePresence(deviceId, deviceUpdate);
  }
}

function serializeTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && typeof value._seconds === 'number') {
    return new Date(value._seconds * 1000).toISOString();
  }
  return null;
}

function normalizeCloudCapabilities(type, capabilities) {
  if (Array.isArray(capabilities)) return capabilities;
  if (capabilities && typeof capabilities === 'object') {
    return Object.entries(capabilities)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key);
  }
  if (type === 'relay_controller') return ['relay', 'water_shutoff'];
  if (type === 'temperature_humidity') return ['temperature', 'humidity', 'battery'];
  if (type === 'flood') return ['flood', 'temperature', 'battery'];
  return [];
}

export async function listCloudAlerts(limit = 200) {
  const db = getIotFirestore();
  const snapshot = await db.collection('alerts')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    const reading = data.reading || {};
    const isFlood = reading.isFlooded || data.type === 'flood';

    return {
      id: docSnap.id,
      deviceId: data.deviceId || data.sensorId || '',
      deviceName: data.sensorName || data.deviceName || 'Unknown',
      type: data.type || (isFlood ? 'flood' : 'info'),
      severity: data.severity || (isFlood ? 'critical' : 'info'),
      message: data.message || (isFlood
        ? `🚨 FLOOD DETECTED at ${data.sensorName || data.deviceName || 'sensor'}!`
        : `Alert from ${data.sensorName || data.deviceName || 'sensor'}`),
      timestamp: serializeTimestamp(data.timestamp) || serializeTimestamp(reading.timestamp) || new Date().toISOString(),
      acknowledged: Boolean(data.acknowledged),
      notificationSent: Boolean(data.notificationSent),
      tenantNotifiedAt: serializeTimestamp(data.tenantNotifiedAt),
      tenantNotification: data.tenantNotification || null,
      data: reading,
      propertyId: data.propertyId || null,
      ownerId: data.ownerId || null,
      location: data.location || null,
    };
  });
}

export async function listCloudDevices() {
  const db = getIotFirestore();
  const snapshot = await db.collection('shelly_devices').get();

  const devices = snapshot.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    const lastReading = data.lastReading || {};
    const floodData = lastReading['flood:0'] || {};
    const tempData = lastReading['temperature:0'] || {};
    const humidityData = lastReading['humidity:0'] || {};
    const relayData = lastReading['switch:0'] || {};
    const idLower = String(docSnap.id || '').toLowerCase();
    const deviceIdLower = String(data.deviceId || '').toLowerCase();
    const typeLower = String(data.type || '').toLowerCase();
    const deviceTypeLower = String(data.deviceType || '').toLowerCase();
    const normalizedDeviceType = (
      typeLower === 'ht'
      || typeLower === 'temperature_humidity'
      || deviceTypeLower.includes('ht')
      || idLower.startsWith('blu-ht-')
      || idLower.includes('shellyht')
      || deviceIdLower.startsWith('blu-ht-')
      || deviceIdLower.includes('shellyht')
      || Boolean(data.bleAddress && (data.humidity != null || data.temperature != null) && !idLower.includes('flood'))
    )
      ? 'temperature_humidity'
      : data.type === 'relay'
        || data.type === 'relay_controller'
        || data.deviceType === 'shelly_relay_gen4'
        || idLower.includes('1g4')
        || deviceIdLower.includes('1g4')
        ? 'relay_controller'
        : data.type === 'gateway'
          || data.deviceType === 'ble_gateway'
          || idLower.includes('blugw')
          || idLower.includes('sngw')
          ? 'ble_gateway'
          : (data.type || (idLower.includes('flood') ? 'flood' : 'unknown'));
    const normalizedConnectionType = data.connectionType === 'ble'
      ? 'bluetooth_gateway'
      : data.connectionType;
    const tempC = tempData.tC ?? lastReading.temperatureC ?? data.temperature;
    const tempF = tempC != null ? (tempC * 9 / 5) + 32 : data.temperatureF;
    const humidityValue = humidityData.rh ?? data.humidity ?? lastReading.humidity;
    const lastSeen = serializeTimestamp(data.lastSeen);
    const isFlooded = floodData.alarm === true || data.isFlooded === true || data.flood === true;

    return {
      id: docSnap.id,
      deviceId: data.deviceId || docSnap.id,
      name: data.name || data.location || 'Unknown Device',
      location: data.location,
      type: normalizedDeviceType,
      ip: data.ip || data.localIp,
      mac: lastReading.mac || data.mac,
      firmware: data.firmware,
      model: data.model,
      status: data.status || 'unknown',
      batteryPercent: data.batteryPercent ?? lastReading.batteryPercent,
      wifiRssi: data.wifiRssi ?? lastReading.wifiRssi,
      temperature: tempC,
      temperatureF: tempF,
      humidity: humidityValue,
      flood: isFlooded,
      isFlooded,
      lastSeen,
      lastUpdate: lastSeen,
      batteryLevel: data.batteryPercent ?? lastReading.batteryPercent,
      rssi: data.wifiRssi ?? lastReading.wifiRssi,
      registeredAt: serializeTimestamp(data.registeredAt),
      webhookUrl: data.webhookUrl,
      propertyId: data.propertyId,
      ownerId: data.ownerId,
      connectionType: normalizedConnectionType || (data.bleAddress ? 'bluetooth' : 'wifi'),
      connectionPreference: data.connectionPreference || (data.bleAddress ? 'bluetooth_preferred' : 'wifi_preferred'),
      bleAddress: data.bleAddress,
      capabilities: normalizeCloudCapabilities(normalizedDeviceType, data.capabilities),
      hasActiveAlert: Boolean(data.hasActiveAlert),
      relayOutputOn: relayData.output === true || data.relayOutputOn === true,
      valveState: data.valveState || 'unknown',
      lastValveCommand: data.lastValveCommand || null,
      lastValveCommandAt: serializeTimestamp(data.lastValveCommandAt) || null,
      pulseDurationMs: data.pulseDurationMs ?? null,
      actuationMode: data.actuationMode === 'momentary' ? 'momentary' : 'maintained',
      relayCloseOn: data.relayCloseOn !== false,
    };
  });

  const hasCanonicalWifiFlood = devices.some((device) => (
    String(device.deviceId || '').startsWith('shellyfloodg4-')
    || String(device.id || '').startsWith('shellyfloodg4-')
  ));

  return devices.filter((device) => {
    const docId = String(device.id || '');
    const isLegacyMacDoc = docId.includes(':');
    const isLegacyFlood = device.deviceType === 'shelly_flood_gen4'
      || device.type === 'flood'
      || docId.includes('flood');

    if (hasCanonicalWifiFlood && isLegacyMacDoc && isLegacyFlood) {
      return false;
    }

    return true;
  });
}

export async function listCloudReadings(hours = 168, limit = 5000) {
  const db = getIotFirestore();
  const safeHours = Math.min(Math.max(Number(hours) || 168, 1), 8760);
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 8000);
  const cutoff = new Date(Date.now() - safeHours * 60 * 60 * 1000);

  const snapshot = await db.collection('sensor_readings')
    .where('timestamp', '>=', cutoff)
    .orderBy('timestamp', 'desc')
    .limit(safeLimit)
    .get();

  return snapshot.docs
    .map((docSnap) => {
      const readingData = docSnap.data() || {};
      return {
        id: docSnap.id,
        deviceId: readingData.deviceId || readingData.sensorId || '',
        temperature: readingData.temperature ?? readingData.temperatureC ?? null,
        humidity: readingData.humidity ?? null,
        flood: readingData.flood ?? null,
        batteryPercent: readingData.batteryPercent ?? null,
        timestamp: serializeTimestamp(readingData.timestamp),
        source: readingData.source || null,
      };
    })
    .filter((reading) => reading.temperature != null || reading.humidity != null);
}

export async function getCloudAlert(alertId) {
  const db = getIotFirestore();
  const doc = await db.collection('alerts').doc(String(alertId)).get();
  if (!doc.exists) {
    return null;
  }

  const data = doc.data() || {};
  const reading = data.reading || {};
  const isFlood = reading.isFlooded || data.type === 'flood';

  return {
    id: doc.id,
    deviceId: data.deviceId || data.sensorId || '',
    deviceName: data.sensorName || data.deviceName || 'Unknown',
    type: data.type || (isFlood ? 'flood' : 'info'),
    severity: data.severity || (isFlood ? 'critical' : 'info'),
    message: data.message || (isFlood
      ? `🚨 FLOOD DETECTED at ${data.sensorName || data.deviceName || 'sensor'}!`
      : `Alert from ${data.sensorName || data.deviceName || 'sensor'}`),
    timestamp: serializeTimestamp(data.timestamp) || serializeTimestamp(reading.timestamp) || new Date().toISOString(),
    acknowledged: Boolean(data.acknowledged),
    notificationSent: Boolean(data.notificationSent),
    tenantNotifiedAt: serializeTimestamp(data.tenantNotifiedAt),
    tenantNotification: data.tenantNotification || null,
    data: reading,
    propertyId: data.propertyId || null,
    ownerId: data.ownerId || null,
    location: data.location || null,
  };
}

export async function updateCloudAlertNotification(alertId, payload = {}) {
  const db = getIotFirestore();
  const ref = db.collection('alerts').doc(String(alertId));
  const doc = await ref.get();
  if (!doc.exists) {
    return false;
  }

  await ref.set({
    notificationSent: Boolean(payload.notificationSent),
    tenantNotifiedAt: payload.tenantNotifiedAt || admin.firestore.FieldValue.serverTimestamp(),
    tenantNotification: payload.tenantNotification || null,
  }, { merge: true });

  return true;
}

export async function acknowledgeCloudAlert(alertId) {
  const db = getIotFirestore();
  const ref = db.collection('alerts').doc(alertId);
  const docSnap = await ref.get();
  if (!docSnap.exists) {
    return false;
  }

  const alertData = docSnap.data() || {};
  const deviceId = alertData.deviceId || alertData.sensorId;
  const isFlood = alertData.type === 'flood' || alertData.reading?.isFlooded;

  await ref.update({
    acknowledged: true,
    acknowledgedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Clear sibling open flood alerts for the same device so dismiss stops the twin pulse.
  if (isFlood && deviceId) {
    try {
      const openFlood = await db.collection('alerts')
        .where('deviceId', '==', deviceId)
        .where('type', '==', 'flood')
        .where('acknowledged', '==', false)
        .get();
      await Promise.all(openFlood.docs.map((sibling) => (
        sibling.ref.update({
          acknowledged: true,
          acknowledgedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      )));
    } catch (err) {
      console.warn(`[IoT] Sibling flood-alert acknowledge skipped: ${err.message}`);
    }

    const aliases = getShellyDeviceIdAliases(deviceId);
    await Promise.all(aliases.map((alias) => (
      db.collection('shelly_devices').doc(String(alias)).set({
        isFlooded: false,
        flood: false,
        hasActiveAlert: false,
        lastAlertClearedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true })
    )));
  }

  return true;
}

export async function markShellyDeviceDeleted(deviceId, metadata = {}) {
  const db = getIotFirestore();
  const aliases = getShellyDeviceIdAliases(deviceId);
  const payload = {
    deviceId: String(deviceId),
    deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...metadata,
  };
  await Promise.all(
    aliases.map((alias) => db.collection('shelly_deleted_devices').doc(String(alias)).set({
      ...payload,
      deviceId: String(alias),
      canonicalDeviceId: String(deviceId),
    }, { merge: true })),
  );
}

function buildShellyDeleteMetadata(deviceData = {}, overrides = {}) {
  const canonicalDeviceId = String(deviceData.deviceId || overrides.deviceId || '');
  return {
    deviceId: canonicalDeviceId,
    propertyId: deviceData.propertyId || overrides.propertyId || null,
    ownerId: deviceData.ownerId || overrides.ownerId || null,
    name: deviceData.name || deviceData.location || overrides.name || canonicalDeviceId,
    location: deviceData.location || overrides.location || null,
    type: deviceData.type || deviceData.deviceType || overrides.type || null,
    ...overrides,
  };
}

export async function isShellyDeviceDeleted(deviceId) {
  if (!deviceId) return false;
  const db = getIotFirestore();
  const aliases = getShellyDeviceIdAliases(deviceId);
  for (const alias of aliases) {
    const snap = await db.collection('shelly_deleted_devices').doc(String(alias)).get();
    if (snap.exists) return true;
  }
  return false;
}

export async function deleteCloudDevice(docId, deviceId, metadata = {}) {
  const db = getIotFirestore();
  let docRef = null;
  let snapshot = null;

  if (docId) {
    const directRef = db.collection('shelly_devices').doc(String(docId));
    const directDoc = await directRef.get();
    if (directDoc.exists) {
      docRef = directRef;
      snapshot = directDoc;
    }
  }

  if (!docRef && deviceId) {
    const exactRef = db.collection('shelly_devices').doc(String(deviceId));
    const exactDoc = await exactRef.get();
    if (exactDoc.exists) {
      docRef = exactRef;
      snapshot = exactDoc;
    }
  }

  if (!docRef && deviceId) {
    const byDeviceId = await db.collection('shelly_devices')
      .where('deviceId', '==', String(deviceId))
      .limit(1)
      .get();
    if (!byDeviceId.empty) {
      docRef = byDeviceId.docs[0].ref;
      snapshot = byDeviceId.docs[0];
    }
  }

  if (!docRef || !snapshot) {
    return 0;
  }

  const deviceData = snapshot.data() || {};
  const canonicalDeviceId = deviceData.deviceId || snapshot.id || deviceId;
  await markShellyDeviceDeleted(
    canonicalDeviceId,
    buildShellyDeleteMetadata(deviceData, metadata),
  );

  const aliasIds = getShellyDeviceIdAliases(canonicalDeviceId);
  const refsToDelete = new Map([[docRef.path, docRef]]);

  for (const alias of aliasIds) {
    const aliasRef = db.collection('shelly_devices').doc(String(alias));
    const aliasSnap = await aliasRef.get();
    if (aliasSnap.exists) {
      refsToDelete.set(aliasRef.path, aliasRef);
    }

    const byDeviceId = await db.collection('shelly_devices')
      .where('deviceId', '==', String(alias))
      .limit(5)
      .get();
    byDeviceId.docs.forEach((docSnap) => {
      refsToDelete.set(docSnap.ref.path, docSnap.ref);
    });
  }

  const uniqueRefs = Array.from(refsToDelete.values());
  for (let index = 0; index < uniqueRefs.length; index += 450) {
    const batch = db.batch();
    uniqueRefs.slice(index, index + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  return uniqueRefs.length;
}
