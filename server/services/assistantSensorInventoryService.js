/**
 * Owner sensor inventory for the assistant — always reads the IoT Firestore
 * project (same source as Predictive Maintenance), not the main app DB.
 */

import { getIotFirestore } from '../iot-cloud-firestore.js';

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value?.toDate === 'function') {
    const parsed = value.toDate();
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value?.seconds === 'number') {
    const parsed = new Date(value.seconds * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function normalizeDeviceType(rawType) {
  const type = safeString(rawType).toLowerCase();
  if (type === 'flood' || type === 'water_leak') return 'water_leak';
  if (type === 'ht' || type === 'temperature_humidity') return 'temperature_humidity';
  if (type === 'temperature') return 'temperature';
  if (type === 'humidity') return 'humidity';
  if (type === 'gateway' || type === 'ble_gateway' || type === 'bluetooth_gateway') return 'gateway';
  if (type === 'relay' || type === 'relay_controller') return 'automatic_shutoff_controller';
  return type || 'sensor';
}

export function inferAssistantDeviceType(data = {}, docId = '') {
  const id = safeString(data.deviceId, docId).toLowerCase();
  const declared = normalizeDeviceType(data.type || data.deviceType);
  if (id.includes('flood')) return 'water_leak';
  if (id.includes('1g4') || data.capabilities?.includes?.('water_shutoff')) return 'automatic_shutoff_controller';
  if (id.includes('blugw') || id.includes('sngw') || id.includes('gateway')) return 'gateway';
  if (id.startsWith('blu-ht-') || id.includes('shellyht')) return 'temperature_humidity';
  return declared;
}

export function canonicalAssistantDeviceKey(data = {}, docId = '') {
  const id = safeString(data.deviceId, docId).replace(/:/g, '').toLowerCase();
  if (id.startsWith('blu-ht-')) return `ht-${id.slice('blu-ht-'.length)}`;
  if (id.startsWith('shellyhtg3-')) return `ht-${id.slice('shellyhtg3-'.length)}`;
  return id;
}

function deviceKindLabel(type) {
  switch (type) {
    case 'temperature_humidity':
    case 'temperature':
    case 'humidity':
      return 'Temperature & humidity';
    case 'water_leak':
      return 'Flood / leak';
    case 'automatic_shutoff_controller':
      return 'Water shutoff valve';
    case 'gateway':
      return 'Bluetooth gateway';
    default:
      return 'Sensor';
  }
}

function extractClimate(data = {}) {
  const lastReading = data.lastReading || {};
  const tempData = lastReading['temperature:0'] || {};
  const humidityData = lastReading['humidity:0'] || {};
  const floodData = lastReading['flood:0'] || {};

  const tempC = safeNumber(
    tempData.tC
    ?? lastReading.temperatureC
    ?? lastReading.temperature
    ?? data.temperature,
  );
  const tempF = safeNumber(
    tempData.tF
    ?? data.temperatureF
    ?? (tempC != null ? (tempC * 9) / 5 + 32 : null),
  );
  const humidity = safeNumber(
    humidityData.rh
    ?? lastReading.humidity
    ?? data.humidity,
  );
  const flooded = Boolean(
    floodData.alarm
    ?? data.isFlooded
    ?? data.flood
    ?? lastReading.flood,
  );

  return {
    temperatureF: tempF != null ? Math.round(tempF * 10) / 10 : null,
    humidityPercent: humidity != null ? Math.round(humidity) : null,
    flooded,
  };
}

function extractValve(data = {}) {
  const lastReading = data.lastReading || {};
  const relayData = lastReading['switch:0'] || {};
  const valveState = safeString(data.valveState || data.lastValveState, '').toLowerCase()
    || (relayData.output === true ? 'open' : relayData.output === false ? 'closed' : 'unknown');
  return {
    valveState: valveState || 'unknown',
    relayOutputOn: typeof data.relayOutputOn === 'boolean'
      ? data.relayOutputOn
      : typeof relayData.output === 'boolean'
        ? relayData.output
        : null,
    lastValveCommand: data.lastValveCommand || null,
    lastValveCommandAt: toIso(data.lastValveCommandAt),
  };
}

function normalizeStatus(data = {}, type) {
  const raw = safeString(data.status, 'unknown').toLowerCase();
  if (raw === 'online' || raw === 'offline' || raw === 'sleeping') return raw;
  // BLE H&T often sleeps between reports — treat recent lastSeen as online.
  const lastSeen = toIso(data.lastSeen || data.updatedAt || data.lastUpdate);
  if (lastSeen) {
    const ageMs = Date.now() - new Date(lastSeen).getTime();
    if (type === 'temperature_humidity' && ageMs < 2 * 60 * 60 * 1000) return 'online';
    if (ageMs < 15 * 60 * 1000) return 'online';
    if (ageMs > 24 * 60 * 60 * 1000) return 'offline';
  }
  return raw || 'unknown';
}

export function mapAssistantSensorDevice(doc) {
  const data = doc.data ? (doc.data() || {}) : (doc || {});
  const docId = doc.id || data.id || data.deviceId || 'unknown';
  const type = inferAssistantDeviceType(data, docId);
  const climate = extractClimate(data);
  const valve = type === 'automatic_shutoff_controller' ? extractValve(data) : null;
  const name = safeString(data.name, safeString(data.location, docId));
  const location = safeString(data.location, '');
  const status = normalizeStatus(data, type);

  let readingLabel = null;
  if (climate.temperatureF != null || climate.humidityPercent != null) {
    const parts = [];
    if (climate.temperatureF != null) parts.push(`${climate.temperatureF}°F`);
    if (climate.humidityPercent != null) parts.push(`${climate.humidityPercent}% RH`);
    readingLabel = parts.join(' · ');
  } else if (type === 'water_leak') {
    readingLabel = climate.flooded ? 'Leak detected' : 'Dry';
  } else if (valve) {
    readingLabel = `Valve ${valve.valveState}`;
  } else if (type === 'gateway') {
    readingLabel = status === 'online' ? 'Bridging BLE sensors' : 'Gateway offline';
  }

  return {
    id: docId,
    deviceId: safeString(data.deviceId, docId),
    canonicalKey: canonicalAssistantDeviceKey(data, docId),
    name,
    location: location || null,
    type,
    kindLabel: deviceKindLabel(type),
    status,
    online: status === 'online' || status === 'sleeping',
    propertyId: safeString(data.propertyId) || null,
    batteryPercent: safeNumber(data.batteryPercent ?? data.lastReading?.batteryPercent),
    temperatureF: climate.temperatureF,
    humidityPercent: climate.humidityPercent,
    flooded: climate.flooded,
    valveState: valve?.valveState || null,
    relayOutputOn: valve?.relayOutputOn ?? null,
    lastValveCommand: valve?.lastValveCommand || null,
    lastSeen: toIso(data.lastSeen || data.updatedAt || data.lastUpdate),
    readingLabel,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
  };
}

function preferDevice(current, next) {
  if (!current) return next;
  // Prefer blu-ht over shellyhtg3 aliases, and fresher lastSeen otherwise.
  const currentIsBle = String(current.deviceId || current.id || '').startsWith('blu-ht-');
  const nextIsBle = String(next.deviceId || next.id || '').startsWith('blu-ht-');
  if (nextIsBle && !currentIsBle) return next;
  if (currentIsBle && !nextIsBle) return current;
  const currentSeen = new Date(current.lastSeen || 0).getTime();
  const nextSeen = new Date(next.lastSeen || 0).getTime();
  return nextSeen >= currentSeen ? next : current;
}

async function queryOwnerDevices(iotDb, field, userId) {
  const snap = await iotDb.collection('shelly_devices').where(field, '==', userId).limit(80).get();
  return snap.docs.map(mapAssistantSensorDevice);
}

export async function loadOwnerSensorInventory(userId) {
  if (!userId) {
    return { devices: [], alerts: [], counts: emptyCounts() };
  }

  const iotDb = getIotFirestore();
  let devices = [];
  try {
    devices = await queryOwnerDevices(iotDb, 'ownerId', userId);
    if (!devices.length) {
      devices = await queryOwnerDevices(iotDb, 'userId', userId);
    }
  } catch (error) {
    console.warn('[AssistantSensors] Failed to load IoT devices:', error.message);
    devices = [];
  }

  const byKey = new Map();
  for (const device of devices) {
    byKey.set(device.canonicalKey, preferDevice(byKey.get(device.canonicalKey), device));
  }
  const deduped = Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));

  let alerts = [];
  try {
    const alertSnap = await iotDb.collection('alerts').where('ownerId', '==', userId).limit(30).get();
    alerts = alertSnap.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        deviceId: safeString(data.deviceId || data.sensorId),
        deviceName: safeString(data.deviceName || data.sensorName, 'Sensor'),
        type: safeString(data.type || data.alertType, 'alert'),
        severity: safeString(data.severity, 'info'),
        message: safeString(data.message, 'Alert'),
        acknowledged: Boolean(data.acknowledged),
        timestamp: toIso(data.timestamp || data.createdAt),
      };
    });
  } catch (error) {
    console.warn('[AssistantSensors] Failed to load IoT alerts:', error.message);
  }

  return {
    devices: deduped,
    alerts,
    counts: buildCounts(deduped, alerts),
  };
}

function emptyCounts() {
  return {
    total: 0,
    online: 0,
    offline: 0,
    ht: 0,
    flood: 0,
    gateway: 0,
    shutoff: 0,
    flooded: 0,
    openAlerts: 0,
  };
}

function buildCounts(devices, alerts) {
  return {
    total: devices.length,
    online: devices.filter((device) => device.online).length,
    offline: devices.filter((device) => device.status === 'offline').length,
    ht: devices.filter((device) => device.type === 'temperature_humidity' || device.type === 'temperature' || device.type === 'humidity').length,
    flood: devices.filter((device) => device.type === 'water_leak').length,
    gateway: devices.filter((device) => device.type === 'gateway').length,
    shutoff: devices.filter((device) => device.type === 'automatic_shutoff_controller').length,
    flooded: devices.filter((device) => device.flooded).length,
    openAlerts: alerts.filter((alert) => !alert.acknowledged).length,
  };
}

/** Match devices named in the owner's question (e.g. upstairs, laundry). */
export function focusDevicesFromQuery(devices, query = '') {
  const haystack = String(query || '').toLowerCase();
  if (!haystack.trim() || !devices.length) return [];

  const matches = devices.filter((device) => {
    const name = `${device.name || ''} ${device.location || ''}`.toLowerCase();
    if (!name.trim()) return false;
    // Direct phrase match on full name/location
    if (haystack.includes(name) || name.split(/\s+/).some((token) => token.length > 3 && haystack.includes(token))) {
      return true;
    }
    // Common room words
    const roomHints = ['upstairs', 'downstairs', 'laundry', 'basement', 'kitchen', 'bath', 'bedroom', 'living', 'garage', 'attic', 'utility'];
    return roomHints.some((hint) => haystack.includes(hint) && name.includes(hint));
  });

  return matches;
}

export function buildSensorSpeakableAnswer(devices, focused, counts) {
  if (!devices.length) {
    return 'I could not find linked sensors yet on Predictive Maintenance.';
  }

  if (focused.length) {
    const lines = focused.map((device) => {
      if (device.temperatureF != null || device.humidityPercent != null) {
        return `${device.name} is ${device.readingLabel || 'reporting'}${device.status === 'offline' ? ' (may be offline)' : ''}`;
      }
      if (device.type === 'automatic_shutoff_controller') {
        return `${device.name} valve is ${device.valveState || 'unknown'}`;
      }
      return `${device.name} (${device.kindLabel}) is ${device.status}`;
    });
    return lines.join('. ') + '.';
  }

  const parts = [
    `You have ${counts.total} device${counts.total === 1 ? '' : 's'}`,
    counts.ht ? `${counts.ht} temp/humidity` : null,
    counts.flood ? `${counts.flood} flood` : null,
    counts.shutoff ? `${counts.shutoff} water shutoff` : null,
    counts.gateway ? `${counts.gateway} gateway` : null,
  ].filter(Boolean);
  return `${parts.join(' · ')}. ${counts.online} online, ${counts.offline} offline, ${counts.openAlerts} open alerts.`;
}
