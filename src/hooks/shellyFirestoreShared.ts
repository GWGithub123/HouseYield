import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { getIotFirestore } from '../config/iotFirebase';
import { resolveShellyWebhookUrl } from '../utils/iotProjectConfig';
import type { ShellyAlert, ShellyDevice, SensorReading, ArchivedShellyDevice } from './useShellyFirestore';

const iotDb = getIotFirestore();

const ALERTS_LIMIT = 200;
const READINGS_HOURS = 168; // 7 days — covers Analytics 24h / 7d views
// H&T can emit ~every 11s; 2 sensors × 24h ≈ 16k raw points. Cap high enough
// that a 24h Conditions chart is not truncated to the last few minutes.
const READINGS_LIMIT = 8000;

type Listener = () => void;

interface SharedShellyState {
  devices: ShellyDevice[];
  archivedDevices: ArchivedShellyDevice[];
  alerts: ShellyAlert[];
  readings: SensorReading[];
  loading: boolean;
  error: string | null;
}

let sharedState: SharedShellyState = {
  devices: [],
  archivedDevices: [],
  alerts: [],
  readings: [],
  loading: true,
  error: null,
};

let deletedDeviceIds = new Set<string>();
let archivedDevicesById = new Map<string, ArchivedShellyDevice>();

let subscriberCount = 0;
let unsubscribeAll: (() => void) | null = null;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const converted = (value as Timestamp).toDate?.();
    return converted instanceof Date && !Number.isNaN(converted.getTime()) ? converted : null;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeDevice(id: string, data: Record<string, unknown>): ShellyDevice {
  const lastReading = (data.lastReading as Record<string, unknown> | undefined) || {};
  const floodData = (lastReading['flood:0'] as Record<string, unknown> | undefined) || {};
  const tempData = (lastReading['temperature:0'] as Record<string, unknown> | undefined) || {};
  const humidityData = (lastReading['humidity:0'] as Record<string, unknown> | undefined) || {};
  const relayData = (lastReading['switch:0'] as Record<string, unknown> | undefined) || {};
  const tempC = (tempData.tC as number | undefined)
    ?? (lastReading.temperatureC as number | undefined)
    ?? (data.temperature as number | undefined);
  const tempF = tempC != null ? (tempC * 9 / 5) + 32 : (data.temperatureF as number | undefined);
  const humidityValue = (humidityData.rh as number | undefined)
    ?? (data.humidity as number | undefined)
    ?? (lastReading.humidity as number | undefined);
  const isFlooded = floodData.alarm === true || data.isFlooded === true || data.flood === true;
  const idLower = String(id || data.deviceId || '').toLowerCase();
  const typeLower = String(data.type || '').toLowerCase();
  const normalizedType = (
    typeLower === 'ht'
    || typeLower === 'temperature_humidity'
    || typeLower.includes('ht')
    || idLower.startsWith('blu-ht-')
    || idLower.includes('shellyht')
    || Boolean(data.bleAddress && (humidityValue != null || tempC != null) && !idLower.includes('flood'))
  )
    ? 'temperature_humidity'
    : data.type === 'relay' || data.type === 'relay_controller' || idLower.includes('1g4')
      ? 'relay_controller'
      : typeLower === 'gateway' || typeLower === 'ble_gateway' || idLower.includes('blugw') || idLower.includes('sngw')
        ? 'ble_gateway'
        : ((data.type as string) || (idLower.includes('flood') ? 'flood' : 'flood'));
  const lastSeenDate = toDate(data.lastSeen);
  const inferredConnectionType = (data.connectionType as ShellyDevice['connectionType'])
    || (data.bleAddress || idLower.startsWith('blu-ht-') ? 'bluetooth' : 'wifi');
  const isBleDevice = inferredConnectionType === 'bluetooth'
    || inferredConnectionType === 'bluetooth_gateway'
    || Boolean(data.bleAddress)
    || idLower.startsWith('blu-ht-');
  const isFlood = normalizedType === 'flood' || normalizedType === 'water_leak' || idLower.includes('flood');
  const isGateway = normalizedType === 'ble_gateway' || idLower.includes('blugw') || idLower.includes('sngw');
  const isMainsAlwaysOn = normalizedType === 'relay_controller'
    || isGateway
    || idLower.includes('1g4')
    || idLower.includes('blugw');
  const offlineThresholdMs = isBleDevice
    ? 2 * 60 * 60 * 1000
    : (normalizedType === 'temperature_humidity' || normalizedType === 'temperature' || normalizedType === 'humidity')
      ? 20 * 60 * 1000
      : isFlood
        // Flood Gen4 sleeps for long stretches. "Online/LIVE" must mean a recent
        // real check-in — not "seen sometime in the last 12 hours."
        ? 12 * 60 * 60 * 1000
        : isGateway
          // Gateway presence is often inferred from BLE traffic (LAN may be
          // unreachable from this host when devices sit on the travel-router IoT subnet).
          ? 30 * 60 * 1000
          : isMainsAlwaysOn
            ? 60 * 1000
            : 30 * 60 * 1000;
  // Recent contact window for flood "LIVE" (button press, status webhook, or alarm).
  const floodLiveWindowMs = 45 * 60 * 1000;
  let status: ShellyDevice['status'] = 'offline';
  if (lastSeenDate) {
    const ageMs = Date.now() - lastSeenDate.getTime();
    if (ageMs <= offlineThresholdMs) {
      if (isFlood && ageMs > floodLiveWindowMs) {
        // Still enrolled / likely sleeping on battery — not actively reachable.
        status = 'unknown';
      } else {
        status = 'online';
      }
    }
  }
  // Explicit offline from a dropped WebSocket/MQTT link / presence probe wins
  // over a still-fresh lastSeen (power-loss leaves lastSeen recent).
  const wentOfflineAt = toDate(data.wentOfflineAt);
  if (data.status === 'offline') {
    if (isMainsAlwaysOn) {
      // Sticky offline only when a real wentOfflineAt is newer than lastSeen.
      // Legacy stale-jobs set status=offline without wentOfflineAt — trust lastSeen.
      if (lastSeenDate && wentOfflineAt && lastSeenDate.getTime() > wentOfflineAt.getTime()) {
        const ageMs = Date.now() - lastSeenDate.getTime();
        status = ageMs <= offlineThresholdMs ? 'online' : 'offline';
      } else if (lastSeenDate && !wentOfflineAt) {
        const ageMs = Date.now() - lastSeenDate.getTime();
        status = ageMs <= offlineThresholdMs ? 'online' : 'offline';
      } else {
        status = 'offline';
      }
    } else if (!lastSeenDate || !wentOfflineAt || wentOfflineAt.getTime() >= lastSeenDate.getTime()) {
      status = 'offline';
    }
  }

  // Never invent a battery reading — only pass through a real reported value.
  // Prefer batteryUpdatedAt so we can hide stale install-time 100% readings.
  const rawBattery = (data.batteryPercent as number | undefined)
    ?? (lastReading.batteryPercent as number | undefined);
  const batteryUpdatedAt = toDate(data.batteryUpdatedAt as Parameters<typeof toDate>[0])
    ?? toDate((lastReading as { batteryUpdatedAt?: unknown }).batteryUpdatedAt);
  const batteryAgeMs = batteryUpdatedAt ? Date.now() - batteryUpdatedAt.getTime() : null;
  // BLU packets often omit battery; without batteryUpdatedAt the stored % is
  // usually an install-time reading that got re-cached — don't present as live.
  const batteryStale = isBleDevice && (
    batteryAgeMs == null
    || batteryAgeMs > 14 * 24 * 60 * 60 * 1000
  );
  const batteryPercent = (typeof rawBattery === 'number' && Number.isFinite(rawBattery) && !batteryStale)
    ? rawBattery
    : undefined;

  return {
    id,
    deviceId: (data.deviceId as string) || id,
    name: (data.name as string) || (data.location as string) || 'Unknown Device',
    location: (data.location as string | undefined) || undefined,
    type: normalizedType,
    ip: (data.ip as string | undefined) || (data.localIp as string | undefined),
    mac: data.mac as string | undefined,
    firmware: data.firmware as string | undefined,
    model: data.model as string | undefined,
    status,
    batteryPercent,
    batteryLevel: batteryPercent,
    wifiRssi: (data.wifiRssi as number | undefined) ?? (lastReading.wifiRssi as number | undefined),
    rssi: (data.wifiRssi as number | undefined) ?? (lastReading.wifiRssi as number | undefined),
    temperature: tempC ?? undefined,
    temperatureF: tempF ?? undefined,
    humidity: humidityValue ?? undefined,
    flood: isFlooded,
    isFlooded,
    lastSeen: lastSeenDate,
    lastUpdate: lastSeenDate?.toISOString(),
    registeredAt: toDate(data.registeredAt),
    webhookUrl: data.webhookUrl as string | undefined,
    propertyId: data.propertyId as string | undefined,
    ownerId: data.ownerId as string | undefined,
    connectionType: inferredConnectionType,
    connectionPreference: data.connectionPreference as ShellyDevice['connectionPreference'],
    bleAddress: data.bleAddress as string | undefined,
    lastCloudIngestAt: toDate(data.lastCloudIngestAt),
    lastLocalIngestAt: toDate(data.lastLocalIngestAt),
    lastIngestSource: data.lastIngestSource as ShellyDevice['lastIngestSource'],
    cloudDeliveryConfirmed: data.cloudDeliveryConfirmed === true,
    collectorVersion: (data.collectorVersion as string | null) ?? null,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities as string[] : undefined,
    relayOutputOn: relayData.output === true || data.relayOutputOn === true,
    valveState: (data.valveState as ShellyDevice['valveState']) || 'unknown',
    lastValveCommand: (data.lastValveCommand as ShellyDevice['lastValveCommand']) || null,
    lastValveCommandAt: (data.lastValveCommandAt as string | null) || null,
    pulseDurationMs: (data.pulseDurationMs as number | null) ?? null,
    valveTravelMs: (data.valveTravelMs as number | null) ?? null,
    actuationMode: data.actuationMode === 'momentary' ? 'momentary' : 'maintained',
    relayCloseOn: data.relayCloseOn !== false,
    twinRoomId: (data.twinRoomId as string | undefined) || undefined,
    twinUnitId: (data.twinUnitId as string | undefined) || undefined,
  };
}

function normalizeAlert(id: string, data: Record<string, unknown>): ShellyAlert {
  const reading = (data.reading as Record<string, unknown> | undefined) || {};
  const isFlood = reading.isFlooded === true || data.type === 'flood';

  return {
    id,
    deviceId: (data.deviceId as string) || (data.sensorId as string) || '',
    deviceName: (data.sensorName as string) || (data.deviceName as string) || 'Unknown',
    type: (data.type as ShellyAlert['type']) || (isFlood ? 'flood' : 'info'),
    severity: (data.severity as ShellyAlert['severity']) || (isFlood ? 'critical' : 'info'),
    message: (data.message as string) || (isFlood
      ? `Flood detected at ${(data.sensorName as string) || (data.deviceName as string) || 'sensor'}`
      : `Alert from ${(data.sensorName as string) || (data.deviceName as string) || 'sensor'}`),
    timestamp: toDate(data.timestamp) || toDate(reading.timestamp) || new Date(),
    acknowledged: Boolean(data.acknowledged),
    notificationSent: Boolean(data.notificationSent),
    tenantNotifiedAt: (data.tenantNotifiedAt as string | null) || null,
    tenantNotification: (data.tenantNotification as ShellyAlert['tenantNotification']) || null,
    data: reading,
    propertyId: data.propertyId as string | undefined,
    ownerId: data.ownerId as string | undefined,
  };
}

function normalizeReading(id: string, data: Record<string, unknown>): SensorReading | null {
  const temperature = (data.temperature as number | undefined)
    ?? (data.temperatureC as number | undefined);
  const humidity = data.humidity as number | undefined;
  if (temperature == null && humidity == null) {
    return null;
  }

  return {
    id,
    deviceId: (data.deviceId as string) || (data.sensorId as string) || '',
    temperature,
    humidity,
    flood: data.flood as boolean | undefined,
    batteryPercent: data.batteryPercent as number | undefined,
    timestamp: toDate(data.timestamp) || new Date(),
  };
}

function mapDocs<T>(
  docs: QueryDocumentSnapshot[],
  mapper: (id: string, data: Record<string, unknown>) => T | null,
): T[] {
  return docs.flatMap((docSnap) => {
    const mapped = mapper(docSnap.id, docSnap.data() as Record<string, unknown>);
    return mapped ? [mapped] : [];
  });
}

function filterLegacyDevices(devices: ShellyDevice[]): ShellyDevice[] {
  const hasCanonicalWifiFlood = devices.some((device) => (
    String(device.deviceId || '').startsWith('shellyfloodg4-')
    || String(device.id || '').startsWith('shellyfloodg4-')
  ));

  // Prefer blu-ht-* docs when both blu-ht and shellyhtg3 aliases exist for the same MAC.
  const bluHtMacs = new Set(
    devices
      .map((device) => String(device.id || device.deviceId || '').toLowerCase())
      .filter((id) => id.startsWith('blu-ht-'))
      .map((id) => id.slice('blu-ht-'.length)),
  );

  return devices.filter((device) => {
    const docId = String(device.id || '');
    const docIdLower = docId.toLowerCase();
    const isLegacyMacDoc = docId.includes(':');
    const isLegacyFlood = device.type === 'flood' || docId.includes('flood');
    if (hasCanonicalWifiFlood && isLegacyMacDoc && isLegacyFlood) {
      return false;
    }
    if (docIdLower.startsWith('shellyhtg3-')) {
      const mac = docIdLower.slice('shellyhtg3-'.length);
      if (bluHtMacs.has(mac)) return false;
    }
    return true;
  });
}

function normalizeArchivedDevice(docId: string, data: Record<string, unknown>): ArchivedShellyDevice {
  const deviceId = String(data.deviceId || docId);
  return {
    deviceId,
    name: String(data.name || data.location || deviceId),
    propertyId: data.propertyId as string | undefined,
    ownerId: data.ownerId as string | undefined,
    location: data.location as string | undefined,
    type: data.type as string | undefined,
    deletedAt: toDate(data.deletedAt),
  };
}

function getArchivedDevicesList(): ArchivedShellyDevice[] {
  return Array.from(archivedDevicesById.values());
}

function filterDeletedDevices(devices: ShellyDevice[], tombstoneIds: Set<string>): ShellyDevice[] {
  if (tombstoneIds.size === 0) {
    return devices;
  }

  return devices.filter((device) => {
    const docId = String(device.id || '');
    const canonicalId = String(device.deviceId || docId);
    return !tombstoneIds.has(docId) && !tombstoneIds.has(canonicalId);
  });
}

/**
 * If BLE H&Ts are actively reporting, their Wi-Fi⇄BLE bridge is online even when
 * this host can't LAN-ping the gateway (common on travel-router IoT subnets).
 */
function enrichGatewaysFromBleChildren(devices: ShellyDevice[]): ShellyDevice[] {
  const bleOnlineCutoff = Date.now() - (30 * 60 * 1000);
  const liveBle = devices.filter((device) => {
    const id = String(device.deviceId || device.id || '').toLowerCase();
    const isBleHt = id.startsWith('blu-ht-')
      || device.connectionType === 'bluetooth'
      || device.connectionType === 'bluetooth_gateway'
      || Boolean(device.bleAddress);
    if (!isBleHt || device.status !== 'online' || !device.lastSeen) return false;
    return device.lastSeen.getTime() >= bleOnlineCutoff;
  });

  if (liveBle.length === 0) return devices;

  return devices.map((device) => {
    const id = String(device.deviceId || device.id || '').toLowerCase();
    const isGateway = device.type === 'ble_gateway'
      || id.includes('blugw')
      || id.includes('sngw');
    if (!isGateway || device.status === 'online') return device;

    const bridged = liveBle.some((ht) => (
      !device.propertyId || !ht.propertyId || ht.propertyId === device.propertyId
    ));
    if (!bridged) return device;

    return {
      ...device,
      status: 'online' as const,
      lastSeen: device.lastSeen && device.lastSeen.getTime() >= bleOnlineCutoff
        ? device.lastSeen
        : new Date(),
    };
  });
}

function finalizeDevices(devices: ShellyDevice[], tombstoneIds: Set<string>): ShellyDevice[] {
  return enrichGatewaysFromBleChildren(
    filterDeletedDevices(filterLegacyDevices(devices), tombstoneIds),
  );
}

function getIotCloudApiBaseUrl(): string {
  return resolveShellyWebhookUrl();
}

function normalizeCloudDevice(device: Record<string, unknown>): ShellyDevice {
  const lastSeenDate = device.lastSeen ? new Date(String(device.lastSeen)) : null;
  const idLower = String(device.id || device.deviceId || '').toLowerCase();
  const typeLower = String(device.type || '').toLowerCase();
  const deviceType = (
    typeLower === 'ht'
    || typeLower === 'temperature_humidity'
    || idLower.startsWith('blu-ht-')
    || idLower.includes('shellyht')
    || Boolean(device.bleAddress && (device.humidity != null || device.temperature != null) && !idLower.includes('flood'))
  )
    ? 'temperature_humidity'
    : typeLower === 'relay' || typeLower === 'relay_controller' || idLower.includes('1g4')
      ? 'relay_controller'
      : typeLower === 'gateway' || typeLower === 'ble_gateway' || idLower.includes('blugw') || idLower.includes('sngw')
        ? 'ble_gateway'
        : ((device.type as string) || (idLower.includes('flood') ? 'flood' : 'flood'));
  const inferredConnectionType = (device.connectionType as ShellyDevice['connectionType'])
    || (device.bleAddress || idLower.startsWith('blu-ht-') ? 'bluetooth' : 'wifi');
  const isBleDevice = inferredConnectionType === 'bluetooth'
    || inferredConnectionType === 'bluetooth_gateway'
    || Boolean(device.bleAddress)
    || idLower.startsWith('blu-ht-');
  const offlineThresholdMs = isBleDevice
    ? 2 * 60 * 60 * 1000
    : (deviceType === 'temperature_humidity' || deviceType === 'temperature' || deviceType === 'humidity')
      ? 20 * 60 * 1000
      : (deviceType === 'flood' || deviceType === 'water_leak' || idLower.includes('flood'))
        ? 12 * 60 * 60 * 1000
        : (deviceType === 'ble_gateway' || idLower.includes('blugw') || idLower.includes('sngw'))
          ? 30 * 60 * 1000
          : (deviceType === 'relay_controller' || idLower.includes('1g4'))
            ? 60 * 1000
            : 30 * 60 * 1000;
  const isFlood = deviceType === 'flood' || deviceType === 'water_leak' || idLower.includes('flood');
  const floodLiveWindowMs = 45 * 60 * 1000;
  let status: ShellyDevice['status'] = 'offline';
  if (lastSeenDate) {
    const ageMs = Date.now() - lastSeenDate.getTime();
    if (ageMs <= offlineThresholdMs) {
      status = isFlood && ageMs > floodLiveWindowMs ? 'unknown' : 'online';
    }
  }
  const wentOfflineAt = device.wentOfflineAt ? new Date(String(device.wentOfflineAt)) : null;
  const isMainsAlwaysOn = deviceType === 'relay_controller'
    || deviceType === 'ble_gateway'
    || idLower.includes('1g4')
    || idLower.includes('blugw');
  if (device.status === 'offline') {
    if (isMainsAlwaysOn) {
      if (lastSeenDate && wentOfflineAt && !Number.isNaN(wentOfflineAt.getTime())
        && lastSeenDate.getTime() > wentOfflineAt.getTime()) {
        const ageMs = Date.now() - lastSeenDate.getTime();
        status = ageMs <= offlineThresholdMs ? 'online' : 'offline';
      } else if (lastSeenDate && (!wentOfflineAt || Number.isNaN(wentOfflineAt.getTime()))) {
        const ageMs = Date.now() - lastSeenDate.getTime();
        status = ageMs <= offlineThresholdMs ? 'online' : 'offline';
      } else {
        status = 'offline';
      }
    } else if (!lastSeenDate || !wentOfflineAt || Number.isNaN(wentOfflineAt.getTime()) || wentOfflineAt.getTime() >= lastSeenDate.getTime()) {
      status = 'offline';
    }
  }

  const rawBattery = typeof device.batteryPercent === 'number'
    ? device.batteryPercent
    : (typeof device.batteryLevel === 'number' ? device.batteryLevel : undefined);
  const batteryUpdatedAt = device.batteryUpdatedAt ? new Date(String(device.batteryUpdatedAt)) : null;
  const batteryAgeMs = batteryUpdatedAt && !Number.isNaN(batteryUpdatedAt.getTime())
    ? Date.now() - batteryUpdatedAt.getTime()
    : null;
  const batteryStale = isBleDevice && (
    batteryAgeMs == null
    || batteryAgeMs > 14 * 24 * 60 * 60 * 1000
  );
  const batteryPercent = (typeof rawBattery === 'number' && Number.isFinite(rawBattery) && !batteryStale)
    ? rawBattery
    : undefined;

  return {
    id: String(device.id || device.deviceId || ''),
    deviceId: String(device.deviceId || device.id || ''),
    name: String(device.name || device.location || 'Unknown Device'),
    location: device.location as string | undefined,
    type: deviceType,
    ip: device.ip as string | undefined,
    mac: device.mac as string | undefined,
    firmware: device.firmware as string | undefined,
    model: device.model as string | undefined,
    status,
    batteryPercent,
    batteryLevel: batteryPercent,
    wifiRssi: device.wifiRssi as number | undefined,
    rssi: device.wifiRssi as number | undefined,
    temperature: device.temperature as number | undefined,
    temperatureF: device.temperatureF as number | undefined,
    humidity: device.humidity as number | undefined,
    flood: device.flood as boolean | undefined,
    isFlooded: device.isFlooded as boolean | undefined,
    lastSeen: lastSeenDate,
    lastUpdate: lastSeenDate?.toISOString(),
    registeredAt: device.registeredAt ? new Date(String(device.registeredAt)) : null,
    webhookUrl: device.webhookUrl as string | undefined,
    propertyId: device.propertyId as string | undefined,
    ownerId: device.ownerId as string | undefined,
    connectionType: inferredConnectionType,
    connectionPreference: device.connectionPreference as ShellyDevice['connectionPreference'],
    bleAddress: device.bleAddress as string | undefined,
    lastCloudIngestAt: device.lastCloudIngestAt ? new Date(String(device.lastCloudIngestAt)) : null,
    lastLocalIngestAt: device.lastLocalIngestAt ? new Date(String(device.lastLocalIngestAt)) : null,
    lastIngestSource: device.lastIngestSource as ShellyDevice['lastIngestSource'],
    cloudDeliveryConfirmed: device.cloudDeliveryConfirmed === true,
    collectorVersion: (device.collectorVersion as string | null) ?? null,
    capabilities: Array.isArray(device.capabilities) ? device.capabilities as string[] : undefined,
    relayOutputOn: device.relayOutputOn as boolean | undefined,
    valveState: (device.valveState as ShellyDevice['valveState']) || 'unknown',
    lastValveCommand: (device.lastValveCommand as ShellyDevice['lastValveCommand']) || null,
    lastValveCommandAt: (device.lastValveCommandAt as string | null) || null,
    pulseDurationMs: (device.pulseDurationMs as number | null) ?? null,
    valveTravelMs: (device.valveTravelMs as number | null) ?? null,
    actuationMode: device.actuationMode === 'momentary' ? 'momentary' : 'maintained',
    relayCloseOn: device.relayCloseOn !== false,
    twinRoomId: (device.twinRoomId as string | undefined) || undefined,
    twinUnitId: (device.twinUnitId as string | undefined) || undefined,
  };
}

function normalizeCloudAlert(alert: Record<string, unknown>): ShellyAlert {
  return {
    id: String(alert.id || ''),
    deviceId: String(alert.deviceId || ''),
    deviceName: String(alert.deviceName || 'Unknown'),
    type: (alert.type as ShellyAlert['type']) || 'info',
    severity: (alert.severity as ShellyAlert['severity']) || 'info',
    message: String(alert.message || `Alert from ${alert.deviceName || 'sensor'}`),
    timestamp: alert.timestamp ? new Date(String(alert.timestamp)) : new Date(),
    acknowledged: Boolean(alert.acknowledged),
    notificationSent: Boolean(alert.notificationSent),
    tenantNotifiedAt: (alert.tenantNotifiedAt as string | null) || null,
    tenantNotification: (alert.tenantNotification as ShellyAlert['tenantNotification']) || null,
    data: alert.data as Record<string, unknown> | undefined,
    propertyId: alert.propertyId as string | undefined,
    ownerId: alert.ownerId as string | undefined,
  };
}

async function bootstrapFromHttp() {
  const cloudBaseUrl = getIotCloudApiBaseUrl();

  try {
    const [devicesResponse, alertsResponse, readingsResponse] = await Promise.all([
      fetch(`${cloudBaseUrl}?action=devices`),
      fetch(`${cloudBaseUrl}?action=alerts&limit=${ALERTS_LIMIT}`),
      fetch(`${cloudBaseUrl}?action=readings&hours=${READINGS_HOURS}&limit=${READINGS_LIMIT}`),
    ]);

    if (devicesResponse.ok) {
      const devicesPayload = await devicesResponse.json();
      const deviceList = Array.isArray(devicesPayload.devices)
        ? devicesPayload.devices.map((device: Record<string, unknown>) => normalizeCloudDevice(device))
        : [];
      sharedState = {
        ...sharedState,
        devices: finalizeDevices(deviceList, deletedDeviceIds),
        error: null,
      };
      emit();
    }

    if (alertsResponse.ok) {
      const alertsPayload = await alertsResponse.json();
      const alertList = Array.isArray(alertsPayload.alerts)
        ? alertsPayload.alerts.map((alert: Record<string, unknown>) => normalizeCloudAlert(alert))
        : [];
      sharedState = { ...sharedState, alerts: alertList, error: null };
      emit();
    }

    if (readingsResponse.ok) {
      const readingsPayload = await readingsResponse.json();
      const readingList = Array.isArray(readingsPayload.readings)
        ? readingsPayload.readings.flatMap((reading: Record<string, unknown>) => {
          const normalized = normalizeReading(String(reading.id || ''), reading);
          return normalized ? [normalized] : [];
        })
        : [];
      sharedState = { ...sharedState, readings: readingList, error: null };
      emit();
    }
  } catch (error) {
    console.warn('[ShellyFirestore] HTTP bootstrap failed:', error);
  }
}

function ensureSubscriptions() {
  if (unsubscribeAll) return;

  sharedState = { ...sharedState, loading: true, error: null };
  emit();

  void bootstrapFromHttp().then(() => {
    if (sharedState.devices.length > 0 && sharedState.loading) {
      sharedState = { ...sharedState, loading: false };
      emit();
    }
  });

  const readingsCutoff = Timestamp.fromDate(new Date(Date.now() - READINGS_HOURS * 60 * 60 * 1000));
  const unsubs: Array<() => void> = [];
  let devicesReady = false;
  let alertsReady = false;
  let readingsReady = false;

  const markReady = () => {
    if (devicesReady && alertsReady && readingsReady) {
      sharedState = { ...sharedState, loading: false };
      emit();
    }
  };

  unsubs.push(onSnapshot(
    collection(iotDb, 'shelly_deleted_devices'),
    (snapshot) => {
      deletedDeviceIds = new Set(
        snapshot.docs.flatMap((docSnap) => {
          const data = docSnap.data() as Record<string, unknown>;
          const ids = [docSnap.id, String(data.deviceId || '')].filter(Boolean);
          return ids;
        }),
      );
      archivedDevicesById = new Map(
        snapshot.docs.map((docSnap) => {
          const archived = normalizeArchivedDevice(docSnap.id, docSnap.data() as Record<string, unknown>);
          return [archived.deviceId, archived] as const;
        }),
      );
      sharedState = {
        ...sharedState,
        archivedDevices: getArchivedDevicesList(),
        devices: finalizeDevices(sharedState.devices, deletedDeviceIds),
      };
      emit();
    },
    (error) => {
      console.warn('[ShellyFirestore] Deleted-device listener failed:', error);
    },
  ));

  unsubs.push(onSnapshot(
    collection(iotDb, 'shelly_devices'),
    (snapshot) => {
      const devices = finalizeDevices(
        mapDocs(snapshot.docs, (id, data) => normalizeDevice(id, data)),
        deletedDeviceIds,
      );
      sharedState = { ...sharedState, devices, error: null };
      devicesReady = true;
      markReady();
      emit();
    },
    (error) => {
      sharedState = { ...sharedState, error: error.message, loading: false };
      emit();
    },
  ));

  unsubs.push(onSnapshot(
    query(
      collection(iotDb, 'alerts'),
      orderBy('timestamp', 'desc'),
      limit(ALERTS_LIMIT),
    ),
    (snapshot) => {
      sharedState = {
        ...sharedState,
        alerts: mapDocs(snapshot.docs, (id, data) => normalizeAlert(id, data)),
        error: null,
      };
      alertsReady = true;
      markReady();
      emit();
    },
    (error) => {
      sharedState = { ...sharedState, error: error.message, loading: false };
      emit();
    },
  ));

  unsubs.push(onSnapshot(
    query(
      collection(iotDb, 'sensor_readings'),
      where('timestamp', '>=', readingsCutoff),
      orderBy('timestamp', 'desc'),
      limit(READINGS_LIMIT),
    ),
    (snapshot) => {
      sharedState = {
        ...sharedState,
        readings: mapDocs(snapshot.docs, (id, data) => normalizeReading(id, data)),
        error: null,
      };
      readingsReady = true;
      markReady();
      emit();
    },
    (error) => {
      sharedState = { ...sharedState, error: error.message, loading: false };
      emit();
    },
  ));

  unsubscribeAll = () => {
    unsubs.forEach((unsub) => unsub());
    unsubscribeAll = null;
  };
}

function teardownSubscriptions() {
  unsubscribeAll?.();
  unsubscribeAll = null;
  sharedState = {
    devices: [],
    archivedDevices: [],
    alerts: [],
    readings: [],
    loading: true,
    error: null,
  };
  deletedDeviceIds = new Set<string>();
  archivedDevicesById = new Map<string, ArchivedShellyDevice>();
}

export function subscribeShellyFirestore(listener: Listener): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  ensureSubscriptions();
  listener();

  return () => {
    listeners.delete(listener);
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) {
      teardownSubscriptions();
    }
  };
}

export function getShellyFirestoreSnapshot(): SharedShellyState {
  return sharedState;
}
