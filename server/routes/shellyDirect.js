/**
 * Shelly Direct Integration Routes
 * 
 * API endpoints for direct Shelly device communication.
 * No cloud dependency - all local/WebSocket/MQTT based.
 */

import express from 'express';
import axios from 'axios';
import shellyManager from '../services/shellyManager.js';
import shellyLocalApi from '../services/shellyLocalApi.js';
import shellyHTService from '../services/shellyHTService.js';
import { sensorAlertAutomation } from '../services/sensorAlertAutomation.js';
import { resolvePropertyInfoForAlert, pickCurrentTenant } from '../services/sensorAlertTenantResolver.js';
import { resolvePublicWebhookUrl, buildPublicWebhookUrlError } from '../utils/publicWebhookUrl.js';
import { getFirestore, verifyIdToken } from '../firebase-admin.js';
import {
  acknowledgeCloudAlert,
  clearShellyDeviceDeleted,
  deleteCloudDevice,
  getCloudAlert,
  getIotFirestore,
  getIotProjectId,
  getShellyDeviceIdAliases,
  listCloudAlerts,
  listCloudDevices,
  markCloudDeviceOffline,
  markShellyDeviceDeleted,
  touchCloudDevicePresence,
  updateCloudAlertNotification,
} from '../iot-cloud-firestore.js';
import { triggerAutoCloseForAlert, triggerAutoCloseForProperty, startLeakAutoShutoffMonitor } from '../services/waterShutoffAutomation.js';
import {
  evaluateAllPropertyPowerSignals,
  getUtilityOutageStatus,
  parseStateFromAddress,
} from '../services/propertyPowerOutageService.js';
import { fetchCloudAlertHttp, fetchCloudDevicesHttp } from '../utils/iotCloudHttpApi.js';
import { resolveShellyWebhookUrl } from '../utils/iotProjectConfig.js';
import { actuateShellyRelay, configureRelayCloudConnectivity, resolveReachableRelayIp, verifyRelayIp } from '../services/shellyRelayControl.js';
import {
  buildLocalRelayCloseUrl,
  configureFloodShutoffWebhooks,
  listRelayShutoffTargetsForProperty,
  syncPropertyLocalShutoff,
} from '../services/shellyLocalShutoff.js';
import { handleShellyCloudWebhook } from '../services/shellyCloudWebhookHandler.js';
import climateHistorySampler, { resetClimateGhostPurgeThrottle } from '../services/climateHistorySampler.js';
import shellyWsServer from '../services/shellyWebSocketServer.js';
import { buildPropertyInfoForSensorAlert } from '../utils/sensorAlertOwner.js';
import {
  buildOwnerDispatchKey,
  isOwnerDispatchClaimed,
} from '../utils/sensorAlertOwnerDispatchDedup.js';

// Dynamic import for Firestore service (for reconnect detection)
let firestoreService = null;
try {
  const module = await import('../../backend/services/firestore-service.cjs');
  firestoreService = module.default || module;
  console.log('✅ [ShellyDirect] Firestore service loaded for reconnect detection');
} catch (err) {
  console.log('ℹ️  [ShellyDirect] Firestore not available for reconnect detection:', err.message);
}

const router = express.Router();
const FIRESTORE_DELETE_BATCH_SIZE = 450;
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const locallyNotifiedAlertIds = new Set();

let sensorMaintenanceDispatchHandler = null;

export function setSensorMaintenanceDispatchHandler(handler) {
  sensorMaintenanceDispatchHandler = typeof handler === 'function' ? handler : null;
}

function shouldDispatchOwnerMaintenanceForAlert(alert = {}) {
  const type = String(alert.type || '').toLowerCase();
  return type === 'flood' || type === 'water_leak';
}

async function markAlertOwnerMaintenanceDispatched(alertId, ownerMaintenanceDispatch = null) {
  if (!alertId) {
    return;
  }

  locallyNotifiedAlertIds.add(String(alertId));

  await updateCloudAlertNotification(alertId, {
    notificationSent: true,
    tenantNotifiedAt: new Date().toISOString(),
    tenantNotification: {
      channel: 'owner_maintenance_sms',
      sentAt: new Date().toISOString(),
      requestId: ownerMaintenanceDispatch?.requestId || null,
      skipped: Boolean(ownerMaintenanceDispatch?.skipped),
    },
  }).catch((error) => {
    console.warn('[Shelly Alert Auto-Notify] Failed to mark alert notified:', alertId, error.message);
  });
}

async function maybeDispatchOwnerMaintenanceForAlert({
  alert,
  alertId,
  propertyInfo,
  practiceTestPhone = null,
  req = null,
  dispatchOwnerMaintenance = true,
  waterShutoffResult = null,
} = {}) {
  if (!dispatchOwnerMaintenance || !shouldDispatchOwnerMaintenanceForAlert(alert)) {
    return null;
  }

  const priorDispatch = waterShutoffResult?.ownerMaintenanceDispatch;
  if (priorDispatch?.ok || priorDispatch?.skipped) {
    return priorDispatch;
  }

  const dispatchKey = buildOwnerDispatchKey({
    alertId,
    propertyId: alert.propertyId,
    sensorDeviceId: alert.deviceId || alert.sensorId,
  });
  if (isOwnerDispatchClaimed(dispatchKey)) {
    return { ok: true, skipped: true, reason: 'already_dispatched', alertId };
  }

  if (typeof sensorMaintenanceDispatchHandler !== 'function') {
    return null;
  }

  const ownerMaintenanceDispatch = await sensorMaintenanceDispatchHandler({
    alert: buildAutomationAlert(alert),
    propertyInfo: buildPropertyInfoForSensorAlert(alert, propertyInfo),
    practiceTestPhone: practiceTestPhone || req?.body?.practiceTestPhone,
    req,
  }).catch((error) => ({
    ok: false,
    error: error.message,
  }));

  if (!ownerMaintenanceDispatch?.ok) {
    console.warn('[Shelly Alert Auto-Notify] Owner maintenance dispatch failed:', {
      alertId,
      error: ownerMaintenanceDispatch?.error || ownerMaintenanceDispatch?.reason,
    });
    return ownerMaintenanceDispatch;
  }

  await markAlertOwnerMaintenanceDispatched(alertId, ownerMaintenanceDispatch);
  return ownerMaintenanceDispatch;
}

function parseUrlOrNull(value) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

function getShellyPublicBaseUrl(req = null) {
  const candidates = [
    process.env.SHELLY_SERVER_PUBLIC_URL,
    process.env.BACKEND_PUBLIC_URL,
    process.env.HOUSEYIELD_BACKEND_URL,
    process.env.PUBLIC_BACKEND_URL,
    resolvePublicWebhookUrl(req),
  ];

  for (const candidate of candidates) {
    const parsed = parseUrlOrNull(candidate);
    if (parsed && !LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
      return parsed;
    }
  }

  return null;
}

function getShellyWebhookUrl(req = null) {
  const resolvedFromEnv = resolveShellyWebhookUrl();
  if (resolvedFromEnv) {
    return resolvedFromEnv;
  }

  const publicBaseUrl = getShellyPublicBaseUrl(req);
  if (publicBaseUrl) {
    return `${publicBaseUrl.toString().replace(/\/$/, '')}/api/shelly/webhook`;
  }

  return null;
}

function requireShellyWebhookUrl(req = null) {
  const webhookUrl = getShellyWebhookUrl(req);
  if (!webhookUrl) {
    throw new Error('Set BACKEND_PUBLIC_URL (or SHELLY_WEBHOOK_URL) before configuring Shelly devices.');
  }
  return webhookUrl;
}

function getShellyWebSocketUrl(req = null) {
  const baseUrl = getShellyPublicBaseUrl(req);
  if (!baseUrl || LOCALHOST_HOSTNAMES.has(baseUrl.hostname)) {
    return null;
  }

  const websocketUrl = new URL(baseUrl.toString());
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  websocketUrl.pathname = '/shelly-ws';
  websocketUrl.search = '';
  websocketUrl.hash = '';
  return websocketUrl.toString();
}

async function deleteDocumentRefsInChunks(db, refs) {
  for (let index = 0; index < refs.length; index += FIRESTORE_DELETE_BATCH_SIZE) {
    const batch = db.batch();
    refs.slice(index, index + FIRESTORE_DELETE_BATCH_SIZE).forEach((ref) => {
      batch.delete(ref);
    });
    await batch.commit();
  }
}

async function resolveShellyDeviceDoc(db, candidateDocIds, candidateDeviceIds) {
  for (const docId of candidateDocIds) {
    if (!docId) continue;
    const docRef = db.collection('shelly_devices').doc(docId);
    const snapshot = await docRef.get();
    if (snapshot.exists) {
      return { docRef, snapshot };
    }
  }

  for (const deviceId of candidateDeviceIds) {
    if (!deviceId) continue;
    const snapshot = await db.collection('shelly_devices').where('deviceId', '==', deviceId).limit(1).get();
    if (!snapshot.empty) {
      return { docRef: snapshot.docs[0].ref, snapshot: snapshot.docs[0] };
    }
  }

  return null;
}

async function withFirestoreTimeout(promise, timeoutMs = 4000, label = 'Firestore lookup') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function resolveFloodSensorDoc(db, deviceId) {
  const exact = await resolveShellyDeviceDoc(db, [deviceId], [deviceId]);
  if (exact) {
    return exact;
  }

  const floodCandidates = [];
  const byDeviceType = await db.collection('shelly_devices')
    .where('deviceType', '==', 'shelly_flood_gen4')
    .get();
  byDeviceType.docs.forEach((doc) => floodCandidates.push(doc));

  const byType = await db.collection('shelly_devices')
    .where('type', '==', 'flood')
    .get();
  byType.docs.forEach((doc) => floodCandidates.push(doc));

  const uniqueCandidates = Array.from(
    new Map(floodCandidates.map((doc) => [doc.ref.path, doc])).values()
  );

  if (uniqueCandidates.length === 1) {
    return { docRef: uniqueCandidates[0].ref, snapshot: uniqueCandidates[0] };
  }

  return null;
}

function isAutoDiscoveredBleDevice(deviceData = {}, canonicalDeviceId = '') {
  const deviceId = String(deviceData.deviceId || canonicalDeviceId || '').toLowerCase();
  return deviceId.startsWith('blu-ht-')
    || deviceData.autoDiscovered === true
    || deviceData.connectionType === 'bluetooth'
    || deviceData.connectionType === 'bluetooth_gateway';
}

async function canDeleteShellyDevice(deviceData, requester, bodyOwnerId, db, canonicalDeviceId = '') {
  if (!requester?.uid) return false;

  if (isAutoDiscoveredBleDevice(deviceData, canonicalDeviceId)) {
    return true;
  }

  const ownerId = typeof deviceData.ownerId === 'string' && deviceData.ownerId.trim()
    ? deviceData.ownerId.trim()
    : null;

  if (!ownerId) return true;
  if (ownerId === requester.uid) return true;
  if (bodyOwnerId && requester.uid === bodyOwnerId) return true;
  if (ownerId === 'owner-1') return true;

  const propertyId = typeof deviceData.propertyId === 'string' && deviceData.propertyId.trim()
    ? deviceData.propertyId.trim()
    : null;
  if (!propertyId || !db) {
    return false;
  }

  try {
    const propertySnap = await db.collection('properties').doc(propertyId).get();
    const propertyOwnerId = propertySnap.data()?.ownerId;
    if (propertyOwnerId === requester.uid) {
      return true;
    }
  } catch (error) {
    console.warn('[Shelly Delete] Property ownership lookup failed:', error.message);
  }

  return false;
}

async function resolveDeleteRequester(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const decodedToken = await verifyIdToken(authHeader.slice('Bearer '.length));
    if (decodedToken?.uid) {
      return { uid: decodedToken.uid, source: 'firebase' };
    }
  }

  const isLocalRequest = ['localhost', '127.0.0.1', '::1'].includes(req.hostname) || process.env.NODE_ENV !== 'production';
  const requestedOwnerId = typeof req.body?.ownerId === 'string' ? req.body.ownerId : null;
  if (isLocalRequest && requestedOwnerId) {
    return { uid: requestedOwnerId, source: 'dev-owner' };
  }

  return null;
}

function inferShellyDeviceType(device = {}) {
  const modelLower = String(device.model || '').toLowerCase();
  const appLower = String(device.app || '').toLowerCase();
  const profileLower = String(device.profile || '').toLowerCase();
  const idLower = String(device.id || '').toLowerCase();

  if (modelLower.includes('flood') || appLower.includes('flood') || idLower.includes('flood')) {
    return 'flood';
  }
  if (
    modelLower.includes('ht') ||
    modelLower.includes('temperature') ||
    modelLower.includes('humidity') ||
    appLower.includes('ht') ||
    idLower.includes('ht')
  ) {
    return 'ht';
  }
  if (
    modelLower.includes('gw') ||
    modelLower.includes('gateway') ||
    modelLower.includes('blu') ||
    appLower.includes('blugw') ||
    idLower.includes('blugw')
  ) {
    return 'gateway';
  }
  if (
    profileLower === 'switch' ||
    modelLower.includes('shelly1') ||
    modelLower.includes('shelly 1') ||
    modelLower.includes('1 gen4') ||
    appLower.includes('shelly1') ||
    appLower.includes('1g4')
  ) {
    return 'relay';
  }

  return 'unknown';
}

function toShellyFirestoreDeviceType(deviceType) {
  if (deviceType === 'flood') return 'shelly_flood_gen4';
  if (deviceType === 'ht') return 'shelly_ht';
  if (deviceType === 'gateway') return 'ble_gateway';
  if (deviceType === 'relay') return 'shelly_relay_gen4';
  return deviceType || 'unknown';
}

function buildShellyCapabilities(deviceType) {
  if (deviceType === 'flood') return ['flood', 'temperature', 'battery'];
  if (deviceType === 'ht') return ['temperature', 'humidity', 'battery'];
  if (deviceType === 'gateway') return ['ble_bridge'];
  if (deviceType === 'relay') return ['relay', 'water_shutoff'];
  return [];
}

// ==================== DEVICE MANAGEMENT ====================

/**
 * GET /api/shelly/devices
 * Get all registered Shelly devices with current status
 */
router.get('/devices', async (req, res) => {
  try {
    const devices = await shellyManager.getAllDevices();
    res.json({
      success: true,
      count: devices.length,
      devices
    });
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

/**
 * GET /api/shelly/devices/:deviceId
 * Get specific device status
 */
router.get('/devices/:deviceId', async (req, res) => {
  try {
    const device = await shellyManager.getDevice(req.params.deviceId);
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    res.json({ success: true, device });
  } catch (error) {
    console.error('Error fetching device:', error);
    res.status(500).json({ error: 'Failed to fetch device' });
  }
});

/**
 * POST /api/shelly/devices/:deviceId/refresh
 * Force refresh device status via local API
 */
router.post('/devices/:deviceId/refresh', async (req, res) => {
  try {
    const data = await shellyManager.refreshDeviceStatus(req.params.deviceId);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shelly/devices/:deviceId/reboot
 * Reboot a device
 */
router.post('/devices/:deviceId/reboot', async (req, res) => {
  try {
    await shellyManager.rebootDevice(req.params.deviceId);
    res.json({ success: true, message: 'Device rebooting' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shelly/devices/register
 * Manually register a device (for devices that can't be auto-discovered)
 */
router.post('/devices/register', async (req, res) => {
  try {
    const { deviceId, name, location, propertyId, ip } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }
    
    // Register in memory
    await shellyManager.registerDevice(deviceId, {
      source: 'manual',
      name: name || deviceId,
      location: location || 'Unknown',
      propertyId,
      ip
    });
    
    res.json({ 
      success: true, 
      message: `Device ${deviceId} registered and saved`,
      deviceId 
    });
  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/shelly/devices/:deviceId
 * POST /api/shelly/devices/:deviceId/delete
 * Unregister a device
 */
async function handleDeleteShellyDevice(req, res) {
  try {
    const requester = await resolveDeleteRequester(req);
    if (!requester?.uid) {
      return res.status(401).json({
        success: false,
        error: 'You must be signed in to delete this sensor',
      });
    }

    const db = getFirestore();
    const requestedDeviceId = req.params.deviceId;
    const requestedDeviceDocId = typeof req.body?.deviceDocId === 'string' ? req.body.deviceDocId : null;
    let resolvedDevice = await resolveShellyDeviceDoc(
      getIotFirestore(),
      [requestedDeviceDocId, requestedDeviceId],
      [typeof req.body?.deviceId === 'string' ? req.body.deviceId : null, requestedDeviceId]
    );
    let targetDb = getIotFirestore();

    if (!resolvedDevice) {
      resolvedDevice = await resolveShellyDeviceDoc(
        db,
        [requestedDeviceDocId, requestedDeviceId],
        [typeof req.body?.deviceId === 'string' ? req.body.deviceId : null, requestedDeviceId]
      );
      targetDb = db;
    }

    if (!resolvedDevice) {
      return res.status(404).json({ success: false, error: 'Sensor not found' });
    }

    const { docRef, snapshot } = resolvedDevice;
    const deviceData = snapshot.data() || {};
    const canonicalDeviceId = typeof deviceData.deviceId === 'string' && deviceData.deviceId
      ? deviceData.deviceId
      : requestedDeviceId;
    const bodyOwnerId = typeof req.body?.ownerId === 'string' ? req.body.ownerId : null;
    const allowed = await canDeleteShellyDevice(deviceData, requester, bodyOwnerId, db, canonicalDeviceId);

    if (!allowed) {
      return res.status(403).json({ success: false, error: 'You do not have permission to delete this sensor' });
    }

    if (targetDb === getIotFirestore()) {
      const deletedCount = await deleteCloudDevice(snapshot.id, canonicalDeviceId, {
        deletedBy: requester.uid,
        source: requester.source || 'api',
      });
      for (const alias of getShellyDeviceIdAliases(canonicalDeviceId)) {
        shellyManager.devices.delete(alias);
        if (typeof shellyHTService?.unregisterSensor === 'function') {
          shellyHTService.unregisterSensor(alias);
        }
      }
      return res.json({
        success: true,
        message: 'Sensor removed. Historical alerts and analytics were kept for this property.',
        deletedCount,
      });
    }

    await markShellyDeviceDeleted(canonicalDeviceId, {
      deletedBy: requester.uid,
      source: requester.source || 'api',
      propertyId: deviceData.propertyId || null,
      ownerId: deviceData.ownerId || null,
      name: deviceData.name || deviceData.location || canonicalDeviceId,
      location: deviceData.location || null,
      type: deviceData.type || deviceData.deviceType || null,
    });

    const aliasIds = getShellyDeviceIdAliases(canonicalDeviceId);
    const refsToDelete = new Map([[docRef.path, docRef]]);
    for (const alias of aliasIds) {
      const aliasRef = targetDb.collection('shelly_devices').doc(String(alias));
      const aliasSnap = await aliasRef.get();
      if (aliasSnap.exists) {
        refsToDelete.set(aliasRef.path, aliasRef);
      }
      const byDeviceId = await targetDb.collection('shelly_devices')
        .where('deviceId', '==', String(alias))
        .limit(5)
        .get();
      byDeviceId.docs.forEach((docSnap) => {
        refsToDelete.set(docSnap.ref.path, docSnap.ref);
      });
    }

    await deleteDocumentRefsInChunks(targetDb, Array.from(refsToDelete.values()));
    for (const alias of aliasIds) {
      shellyManager.devices.delete(alias);
      if (typeof shellyHTService?.unregisterSensor === 'function') {
        shellyHTService.unregisterSensor(alias);
      }
    }

    res.json({
      success: true,
      message: 'Sensor removed. Historical alerts and analytics were kept for this property.',
      deletedCount: refsToDelete.size,
    });
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

router.delete('/devices/:deviceId', express.json(), handleDeleteShellyDevice);
router.post('/devices/:deviceId/delete', express.json(), handleDeleteShellyDevice);

/**
 * POST /api/shelly/devices/:deviceId/restore
 * Clear a deletion tombstone and ensure the device document is visible again.
 * Used when a device was accidentally tombstoned during cleanup/reconfiguration.
 */
router.post('/devices/:deviceId/restore', express.json(), async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const body = req.body || {};
    await clearShellyDeviceDeleted(deviceId);

    const db = getIotFirestore();
    const docRef = db.collection('shelly_devices').doc(String(deviceId));
    const existing = await docRef.get();
    const existingData = existing.exists ? (existing.data() || {}) : {};

    const payload = {
      deviceId,
      name: body.name || existingData.name || deviceId,
      location: body.location || existingData.location || null,
      propertyId: body.propertyId || existingData.propertyId || null,
      type: body.type || existingData.type || 'relay_controller',
      deviceType: body.deviceType || existingData.deviceType || 'shelly_relay_gen4',
      model: body.model || existingData.model || null,
      connectionType: body.connectionType || existingData.connectionType || 'wifi',
      capabilities: body.capabilities || existingData.capabilities || ['relay', 'water_shutoff'],
      webhookUrl: body.webhookUrl || existingData.webhookUrl || null,
      status: 'online',
      lastSeen: new Date().toISOString(),
    };

    await shellyManager.saveDevice(deviceId, { ...payload, clearTombstone: true });
    await shellyManager.registerDevice(deviceId, {
      source: 'restore',
      name: payload.name,
      location: payload.location,
      propertyId: payload.propertyId,
      type: payload.type,
    });

    res.json({ success: true, deviceId, message: 'Device restored and visible again' });
  } catch (error) {
    console.error('Device restore error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== DEVICE SETUP ====================

/**
 * POST /api/shelly/setup/scan
 * Scan network for Shelly devices (auto-detects network range)
 */
router.post('/setup/scan', async (req, res) => {
  try {
    const { baseIp, startRange = 2, endRange = 20 } = req.body;
    
    console.log('🔍 Starting network scan...');
    const devices = await shellyLocalApi.scanNetwork(baseIp, startRange, endRange);
    
    // Enrich discovered devices with Firestore data (detect reconnections)
    const enrichedDevices = [];
    for (const device of devices) {
      let previouslyRegistered = false;
      let existingData = null;
      try {
        if (firestoreService && typeof firestoreService.getSensor === 'function') {
          existingData = await firestoreService.getSensor(device.id);
          if (existingData) {
            previouslyRegistered = true;
            console.log(`   🔄 Discovered device ${device.id} was previously registered (old IP: ${existingData.ip || existingData.localIp || 'unknown'})`);
          }
        }
      } catch (e) { /* ignore */ }

      const deviceType = inferShellyDeviceType(device);

      enrichedDevices.push({
        ...device,
        deviceType,
        isBatteryPowered: deviceType === 'flood' || deviceType === 'ht',
        previouslyRegistered,
        existingName: existingData?.name || null,
        existingLocation: existingData?.location || null,
        previousIp: previouslyRegistered ? (existingData?.ip || existingData?.localIp || null) : null,
      });
    }

    res.json({
      success: true,
      count: enrichedDevices.length,
      devices: enrichedDevices
    });
  } catch (error) {
    console.error('Scan error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shelly/setup/ap-configure
 * Configure device in AP mode
 * User must be connected to device's WiFi network
 */
router.post('/setup/ap-configure', async (req, res) => {
  try {
    const { 
      wifiSsid, 
      wifiPassword, 
      deviceName, 
      location, 
      propertyId,
      serverUrl,
      webhookUrl,
      networkType 
    } = req.body;

    if (!wifiSsid) {
      return res.status(400).json({ 
        error: 'WiFi SSID is required' 
      });
    }

    // Password is optional for public/open networks
    if (networkType !== 'public' && !wifiPassword) {
      return res.status(400).json({ 
        error: 'WiFi password required for private networks' 
      });
    }

    console.log(`📱 Configuring device for ${networkType || 'private'} network: ${wifiSsid}`);
    console.log(`   WebSocket URL: ${serverUrl}`);

    // Guard: BLU Gateway must use /setup/ap-configure-gateway, not flood setup.
    try {
      const apInfo = await shellyLocalApi.getDeviceInfo('192.168.33.1', 8000);
      const haystack = [apInfo?.id, apInfo?.model, apInfo?.app, apInfo?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const looksLikeGateway = (
        haystack.includes('blugw')
        || haystack.includes('sngw')
        || haystack.includes('gateway')
        || haystack.includes('gwf-kz')
      );
      if (looksLikeGateway) {
        return res.status(400).json({
          success: false,
          error: `Device ${apInfo.id || apInfo.model} is a Shelly BLU Gateway. Use Add Device → BLU Gateway (or /api/shelly/setup/ap-configure-gateway), not Flood Gen4 setup.`,
          deviceType: 'gateway',
          device: apInfo,
        });
      }
    } catch {
      // If AP is unreachable here, setupDeviceFromAP will surface the real error.
    }

    // Always program Cloud Run (or BACKEND_PUBLIC_URL) — never the legacy
    // cloudfunctions.net shellyWebhook which is currently IAM-locked (403).
    const firebaseWebhookUrl = requireShellyWebhookUrl(req);
    if (/cloudfunctions\.net\/shellyWebhook/i.test(firebaseWebhookUrl)) {
      return res.status(500).json({
        success: false,
        error: 'Flood setup is still pointed at the legacy Firebase shellyWebhook function (403). Set SHELLY_WEBHOOK_URL / VITE_SHELLY_WEBHOOK_URL to your Cloud Run /api/shelly/webhook URL and retry.',
      });
    }
    console.log(`   Flood webhook URL (Cloud): ${firebaseWebhookUrl}`);

    const result = await shellyManager.setupDeviceFromAP(
      wifiSsid, 
      wifiPassword || '', // Empty string for open networks
      {
        name: deviceName,
        location,
        propertyId,
        serverUrl,
        webhookUrl: firebaseWebhookUrl
      }
    );

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shelly/setup/check-ap
 * Check if we can connect to device in AP mode
 */
router.post('/setup/check-ap', async (req, res) => {
  try {
    const apIp = '192.168.33.1';
    const info = await shellyLocalApi.getDeviceInfo(apIp);
    
    res.json({
      success: true,
      connected: true,
      device: info
    });
  } catch (error) {
    res.json({
      success: false,
      connected: false,
      message: 'Not connected to Shelly device AP. Please connect to the ShellyFloodG4-XXXX WiFi network.'
    });
  }
});

/**
 * POST /api/shelly/setup/configure-local
 * Configure a device that's already on the network
 */
router.post('/setup/configure-local', async (req, res) => {
  try {
    const { 
      deviceIp, 
      deviceName, 
      location, 
      propertyId,
      enableWebSocket,
      websocketUrl,
      webhookUrl 
    } = req.body;

    if (!deviceIp) {
      return res.status(400).json({ error: 'Device IP required' });
    }

    // Get device info
    const info = await shellyLocalApi.getDeviceInfo(deviceIp);
    
    // Set name if provided
    if (deviceName) {
      await shellyLocalApi.setDeviceName(deviceIp, deviceName);
    }

    // Configure WebSocket
    if (enableWebSocket && websocketUrl) {
      await shellyManager.configureDeviceWebSocket(deviceIp, websocketUrl);
    }

    // Configure webhook
    if (webhookUrl) {
      await shellyLocalApi.configureWebhook(deviceIp, webhookUrl);
    }

    // Register device
    shellyManager.registerDevice(info.id, {
      source: 'local',
      ip: deviceIp,
      name: deviceName || info.name,
      location,
      propertyId
    });

    // Save to database
    await shellyManager.saveDevice(info.id, {
      localIp: deviceIp,
      name: deviceName || info.name,
      location,
      propertyId
    });

    res.json({
      success: true,
      deviceId: info.id,
      device: info
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shelly/relay/register
 * Register a Shelly relay controller already connected to the local network.
 */
router.post('/relay/register', async (req, res) => {
  try {
    const {
      deviceIp,
      deviceId,
      deviceName,
      location,
      propertyId,
      pulseDurationMs = 20000,
      valveTravelMs = 15000,
      actuationMode = 'maintained',
      relayCloseOn = true,
      defaultValveState = 'unknown',
    } = req.body || {};

    if (!deviceIp) {
      return res.status(400).json({ success: false, error: 'deviceIp is required' });
    }

    const info = await shellyLocalApi.getDeviceInfo(deviceIp);
    const inferredType = inferShellyDeviceType(info);
    if (inferredType !== 'relay') {
      return res.status(400).json({
        success: false,
        error: `Device ${info.id} is not a supported Shelly relay controller`,
      });
    }

    const finalDeviceId = deviceId || info.id;
    const finalName = deviceName || info.name || `Water Shutoff Relay ${finalDeviceId.slice(-4)}`;
    const finalLocation = location || 'Main water shutoff';
    const relayStatus = await shellyLocalApi.getRelayStatus(deviceIp).catch(() => ({ output: false }));

    if (deviceName) {
      try {
        await shellyLocalApi.setDeviceName(deviceIp, deviceName);
      } catch (error) {
        console.warn('[Shelly Relay] Failed to set device name:', error.message);
      }
    }

    await shellyManager.registerDevice(finalDeviceId, {
      source: 'local',
      ip: deviceIp,
      name: finalName,
      location: finalLocation,
      propertyId,
      type: 'relay_controller',
    });
    shellyManager.updateDeviceData(finalDeviceId, {
      relayOutputOn: relayStatus.output === true,
      valveState: defaultValveState,
      lastValveCommand: null,
      pulseDurationMs: Math.max(250, Math.min(Number(pulseDurationMs) || 20000, 60000)),
      valveTravelMs: Math.max(5000, Math.min(Number(valveTravelMs) || 15000, 45000)),
      actuationMode: actuationMode === 'momentary' ? 'momentary' : 'maintained',
      relayCloseOn: relayCloseOn !== false,
    });

    await shellyManager.saveDevice(finalDeviceId, {
      localIp: deviceIp,
      ip: deviceIp,
      name: finalName,
      location: finalLocation,
      propertyId,
      type: 'relay_controller',
      deviceType: 'shelly_relay_gen4',
      model: info.model || 'Shelly 1 Gen4',
      mac: info.mac,
      firmware: info.firmware,
      connectionType: 'wifi',
      capabilities: ['relay', 'water_shutoff'],
      valveState: defaultValveState,
      pulseDurationMs: Math.max(250, Math.min(Number(pulseDurationMs) || 20000, 60000)),
      valveTravelMs: Math.max(5000, Math.min(Number(valveTravelMs) || 15000, 45000)),
      actuationMode: actuationMode === 'momentary' ? 'momentary' : 'maintained',
      relayCloseOn: relayCloseOn !== false,
      relayOutputOn: relayStatus.output === true,
      clearTombstone: true,
    });

    const firebaseWebhookUrl = getShellyWebhookUrl(req);
    const outboundWebSocketUrl = getShellyWebSocketUrl(req);
    let cloudConnectivity = null;
    if (firebaseWebhookUrl || outboundWebSocketUrl) {
      cloudConnectivity = await configureRelayCloudConnectivity(deviceIp, finalDeviceId, {
        webhookBaseUrl: firebaseWebhookUrl,
        websocketUrl: outboundWebSocketUrl,
      });
      if (outboundWebSocketUrl && cloudConnectivity?.websocket) {
        console.log(`[Shelly Relay] Outbound WebSocket configured -> ${outboundWebSocketUrl}`);
      }
      if (cloudConnectivity?.webhooks?.length) {
        console.log('[Shelly Relay] Firebase relay status webhooks configured');
      }
    } else {
      console.warn('[Shelly Relay] Cloud connectivity skipped — set SHELLY_SERVER_PUBLIC_URL and SHELLY_FIREBASE_WEBHOOK_URL');
    }

    if (firebaseWebhookUrl) {
      const registerUrl = new URL(firebaseWebhookUrl);
      registerUrl.searchParams.set('action', 'register');
      if (process.env.SHELLY_WEBHOOK_SECRET) {
        registerUrl.searchParams.set('secret', process.env.SHELLY_WEBHOOK_SECRET);
      }

      fetch(registerUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          action: 'register',
          deviceId: finalDeviceId,
          name: finalName,
          location: finalLocation,
          ip: deviceIp,
          model: info.model || 'Shelly 1 Gen4',
          mac: info.mac,
          firmware: info.firmware,
          propertyId,
          type: 'relay_controller',
          deviceType: 'shelly_relay_gen4',
          connectionType: 'wifi',
          capabilities: ['relay', 'water_shutoff'],
          valveState: defaultValveState,
          pulseDurationMs: Math.max(250, Math.min(Number(pulseDurationMs) || 20000, 60000)),
          valveTravelMs: Math.max(5000, Math.min(Number(valveTravelMs) || 15000, 45000)),
          actuationMode: actuationMode === 'momentary' ? 'momentary' : 'maintained',
          relayCloseOn: relayCloseOn !== false,
          relayOutputOn: relayStatus.output === true,
        }),
      }).catch((error) => {
        console.warn('[Shelly Relay] Cloud registration failed:', error.message);
      });
    }

    let localShutoffSync = null;
    if (propertyId) {
      localShutoffSync = await syncPropertyLocalShutoff(propertyId, {
        cloudWebhookUrl: requireShellyWebhookUrl(req),
      }).catch((error) => ({
        ok: false,
        error: error.message,
      }));
    }

    res.json({
      success: true,
      deviceId: finalDeviceId,
      device: {
        id: finalDeviceId,
        name: finalName,
        model: info.model || 'Shelly 1 Gen4',
        mac: info.mac || '',
        ip: deviceIp,
      },
      cloudConnectivity,
      localShutoffUrl: buildLocalRelayCloseUrl(finalDeviceId, {
        relayCloseOn: relayCloseOn !== false,
        actuationMode: actuationMode === 'momentary' ? 'momentary' : 'maintained',
      }),
      localShutoffSync,
      message: cloudConnectivity?.websocket
        ? 'Shelly relay registered. Flood sensors on this property will close the valve locally over the IoT LAN during internet outages.'
        : 'Shelly relay controller registered. Sync local shutoff after all flood sensors are on the same GL.iNet network.',
    });
  } catch (error) {
    console.error('[Shelly Relay] Registration failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function valveStateFromRelayOutput(relayOutputOn, relayCloseOn = true) {
  if (relayCloseOn) {
    return relayOutputOn ? 'closed' : 'open';
  }
  return relayOutputOn ? 'open' : 'closed';
}

async function resolveRelayController(
  deviceId,
  candidateDocId = null,
  { allowNetworkScan = false, skipLanResolution = false } = {},
) {
  const localDb = getFirestore();
  let resolved = null;
  let targetDb = localDb;

  resolved = await withFirestoreTimeout(
    resolveShellyDeviceDoc(localDb, [candidateDocId, deviceId], [deviceId]),
    4000,
    'Local relay lookup',
  ).catch((error) => {
    console.warn('[Shelly Relay] Local device lookup failed:', error.message);
    return null;
  });

  if (!resolved) {
    try {
      resolved = await withFirestoreTimeout(
        resolveShellyDeviceDoc(getIotFirestore(), [candidateDocId, deviceId], [deviceId]),
        4000,
        'Cloud relay lookup',
      );
      if (resolved) {
        targetDb = getIotFirestore();
      }
    } catch (error) {
      console.warn('[Shelly Relay] Cloud device lookup unavailable, falling back to local Firestore:', error.message);
    }
  }

  let deviceData = resolved?.snapshot?.data() || {};
  const mdnsHost = deviceId ? `${String(deviceId).trim().toLowerCase()}.local` : null;
  const candidateIps = [...new Set([
    shellyManager.devices?.get?.(deviceId)?.ip,
    deviceData.localIp,
    deviceData.ip,
    mdnsHost,
  ].filter(Boolean))];

  // A live outbound socket is already proof that the device is reachable. Do
  // not touch stale private IPs from a public backend before using it: Cloud Run
  // cannot route to those addresses, and each failed probe delays a command.
  let deviceIp = null;
  if (!skipLanResolution) {
    for (const candidateIp of candidateIps) {
      deviceIp = await verifyRelayIp(deviceId, candidateIp, 1500);
      if (deviceIp) break;
    }
  }

  if (!deviceIp && !skipLanResolution) {
    try {
      let cloudDevices = [];
      try {
        cloudDevices = await listCloudDevices();
      } catch {
        cloudDevices = await fetchCloudDevicesHttp();
      }
      const cloudDevice = cloudDevices.find((entry) => (
        entry.deviceId === deviceId || entry.id === deviceId
      ));
      if (cloudDevice) {
        deviceData = { ...deviceData, ...cloudDevice };
        deviceIp = await verifyRelayIp(deviceId, cloudDevice.ip || cloudDevice.localIp, 1500);
      }
    } catch (error) {
      console.warn('[Shelly Relay] Cloud device lookup failed:', error.message);
    }
  }

  // Full subnet scan only for explicit setup/reconfigure — status polls must stay fast
  // so an unplugged relay flips offline within seconds, not after a multi-minute scan.
  if (!deviceIp && allowNetworkScan && !skipLanResolution) {
    try {
      const scannedIp = await shellyLocalApi.findDeviceOnNetwork(deviceId, null, 30);
      if (scannedIp) {
        deviceIp = scannedIp;
        shellyManager.registerDevice(deviceId, {
          source: 'scan',
          ip: scannedIp,
          type: 'relay_controller',
        });
        console.log(`[Shelly Relay] Resolved ${deviceId} at ${scannedIp} via local network scan`);
      }
    } catch (error) {
      console.warn('[Shelly Relay] Network scan lookup failed:', error.message);
    }
  }

  return {
    resolved,
    targetDb,
    deviceData,
    deviceIp,
  };
}

/**
 * GET /api/shelly/relay/:deviceId/status
 * Read live relay/valve state — fast reachability only (no subnet scan).
 */
router.get('/relay/:deviceId/status', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const candidateDocId = typeof req.query.deviceDocId === 'string' ? req.query.deviceDocId : null;
    const { deviceData, deviceIp } = await resolveRelayController(deviceId, candidateDocId, {
      allowNetworkScan: false,
    });

    const relayCloseOn = deviceData.relayCloseOn !== false;
    const respondOnline = (source, relayOutputOn, extra = {}) => {
      // Clear sticky Firestore offline so the dashboard can go LIVE again.
      const onlineFields = {
        status: 'online',
        presenceSource: source,
        relayOutputOn,
        valveState: valveStateFromRelayOutput(relayOutputOn, relayCloseOn),
      };
      if (extra.ip) {
        onlineFields.localIp = extra.ip;
        onlineFields.ip = extra.ip;
      }
      touchCloudDevicePresence(deviceId, onlineFields).catch(() => {});
      try {
        shellyManager.updateDeviceStatus(deviceId, 'online');
        if (extra.ip) {
          shellyManager.registerDevice(deviceId, {
            source,
            ip: extra.ip,
            type: 'relay_controller',
          });
        }
      } catch {
        // ignore
      }

      return res.json({
        success: true,
        online: true,
        source,
        deviceId,
        valveState: valveStateFromRelayOutput(relayOutputOn, relayCloseOn),
        relayOutputOn,
        actuationMode: deviceData.actuationMode === 'momentary' ? 'momentary' : 'maintained',
        relayCloseOn,
        lastSeen: new Date().toISOString(),
        status: 'online',
        ...extra,
      });
    };

    const parseDeviceTimestamp = (value) => {
      if (!value) return null;
      if (typeof value.toDate === 'function') {
        const d = value.toDate();
        return Number.isNaN(d.getTime()) ? null : d;
      }
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const respondOffline = (reason, message) => {
      // Do not write Firestore offline here. This host often cannot reach the
      // travel-router IoT LAN, and Cloud Run instances without the device WS
      // would keep overwriting a real reconnect. Offline persistence belongs to
      // WS disconnect + the presence poller (LAN-aware).
      //
      // Soft-online: when another Cloud Run instance already refreshed lastSeen,
      // don't tell the dashboard "offline" just because THIS process has no
      // LAN/WS path — that flicker is what made the valve drop every few polls.
      const lastSeenDate = parseDeviceTimestamp(deviceData.lastSeen);
      const wentOfflineAt = parseDeviceTimestamp(deviceData.wentOfflineAt);
      const lastSeenAgeMs = lastSeenDate ? Date.now() - lastSeenDate.getTime() : Number.POSITIVE_INFINITY;
      const stickyOffline = String(deviceData.status || '') === 'offline'
        && wentOfflineAt
        && (!lastSeenDate || wentOfflineAt.getTime() >= lastSeenDate.getTime());
      const FRESH_PRESENCE_MS = 3 * 60 * 1000;
      const relayOutputOn = deviceData.relayOutputOn === true;
      if (!stickyOffline && lastSeenDate && lastSeenAgeMs <= FRESH_PRESENCE_MS) {
        return res.json({
          success: true,
          online: true,
          status: 'online',
          source: 'cached_presence',
          deviceId,
          valveState: deviceData.valveState || valveStateFromRelayOutput(relayOutputOn, relayCloseOn),
          relayOutputOn,
          actuationMode: deviceData.actuationMode === 'momentary' ? 'momentary' : 'maintained',
          relayCloseOn,
          lastValveCommand: deviceData.lastValveCommand || null,
          lastValveCommandAt: deviceData.lastValveCommandAt || null,
          lastSeen: lastSeenDate.toISOString(),
          reason: 'cached_presence',
          message: message || 'Using recent cloud presence (no live path on this host).',
        });
      }

      return res.json({
        success: true,
        online: false,
        status: 'offline',
        source: 'cached',
        deviceId,
        valveState: deviceData.valveState || valveStateFromRelayOutput(relayOutputOn, relayCloseOn),
        relayOutputOn,
        actuationMode: deviceData.actuationMode === 'momentary' ? 'momentary' : 'maintained',
        relayCloseOn,
        lastValveCommand: deviceData.lastValveCommand || null,
        lastValveCommandAt: deviceData.lastValveCommandAt || null,
        lastSeen: lastSeenDate ? lastSeenDate.toISOString() : (deviceData.lastSeen || null),
        reason,
        message,
      });
    };

    // 1) LAN RPC when we already know a live IP / mDNS host
    if (deviceIp) {
      try {
        const relayStatus = await shellyLocalApi.getRelayStatus(deviceIp);
        let resolvedIp = deviceIp;
        if (String(deviceIp).endsWith('.local')) {
          try {
            const full = await shellyLocalApi.getStatus(deviceIp);
            if (full?.wifi?.sta_ip) resolvedIp = full.wifi.sta_ip;
          } catch {
            // keep mDNS host
          }
        }
        return respondOnline('local_http', relayStatus.output === true, {
          ip: resolvedIp,
          valveTravelMs: Math.max(5000, Math.min(Number(deviceData.valveTravelMs) || 15000, 45000)),
          lastValveCommand: deviceData.lastValveCommand || null,
          lastValveCommandAt: deviceData.lastValveCommandAt || null,
        });
      } catch (error) {
        console.warn(`[Shelly Relay] LAN status failed for ${deviceId} @ ${deviceIp}:`, error.message);
      }
    }

    // 1b) Explicit mDNS retry — common after power-cycle when Firestore IP is stale
    const mdnsHost = `${String(deviceId).trim().toLowerCase()}.local`;
    if (!deviceIp || deviceIp !== mdnsHost) {
      try {
        const relayStatus = await shellyLocalApi.getRelayStatus(mdnsHost);
        let resolvedIp = mdnsHost;
        try {
          const full = await shellyLocalApi.getStatus(mdnsHost);
          if (full?.wifi?.sta_ip) resolvedIp = full.wifi.sta_ip;
        } catch {
          // keep mDNS host
        }
        console.log(`[Shelly Relay] Recovered ${deviceId} via mDNS → ${resolvedIp}`);
        return respondOnline('local_http', relayStatus.output === true, {
          ip: resolvedIp,
          valveTravelMs: Math.max(5000, Math.min(Number(deviceData.valveTravelMs) || 15000, 45000)),
          lastValveCommand: deviceData.lastValveCommand || null,
          lastValveCommandAt: deviceData.lastValveCommandAt || null,
        });
      } catch {
        // mDNS miss is normal when the relay is unplugged / different LAN
      }
    }

    // 2) Outbound WebSocket — require a real RPC reply (half-open TCP is not "online")
    if (shellyWsServer.isDeviceConnected(deviceId)) {
      try {
        const live = await shellyWsServer.sendRpcToDevice(deviceId, 'Switch.GetStatus', { id: 0 }, 3000);
        if (live == null || typeof live.output !== 'boolean') {
          throw new Error('RPC returned no switch status');
        }
        return respondOnline('websocket', live.output === true);
      } catch (error) {
        console.warn(`[Shelly Relay] WS probe failed for ${deviceId}:`, error.message);
        try {
          shellyWsServer.forceDisconnect(deviceId, 'status_probe_failed');
        } catch {
          // ignore
        }
      }
    }

    return respondOffline(
      'relay_unreachable',
      'Relay is not reachable over LAN or WebSocket. Plug it back in or reconfigure outbound WebSocket.',
    );
  } catch (error) {
    console.error('[Shelly Relay] Status read failed:', error);
    res.status(503).json({
      success: false,
      online: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/shelly/relay/:deviceId/command
 * Send an open/close pulse to a Shelly relay controller.
 */
router.post('/relay/:deviceId/command', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { action, durationMs } = req.body || {};
    const normalizedAction = String(action || '').toLowerCase();

    if (!['open', 'close', 'pulse'].includes(normalizedAction)) {
      return res.status(400).json({
        success: false,
        error: 'action must be one of open, close, or pulse',
      });
    }

    const candidateDocId = typeof req.body?.deviceDocId === 'string' ? req.body.deviceDocId : null;
    const hasCloudSocket = shellyWsServer.isDeviceConnected(deviceId);
    const { resolved, targetDb, deviceData, deviceIp } = await resolveRelayController(deviceId, candidateDocId, {
      allowNetworkScan: !hasCloudSocket,
      skipLanResolution: hasCloudSocket,
    });

    const actuationMode = deviceData.actuationMode === 'momentary' ? 'momentary' : 'maintained';
    const relayCloseOn = deviceData.relayCloseOn !== false;
    const pulseMs = Math.max(
      250,
      Math.min(
        Number(durationMs) || Number(deviceData.pulseDurationMs) || 20000,
        60000
      )
    );

    const actuation = await actuateShellyRelay({
      deviceId,
      action: normalizedAction,
      ip: deviceIp,
      candidateIps: [deviceData.localIp, deviceData.ip, deviceIp],
      actuationMode,
      pulseDurationMs: pulseMs,
      relayCloseOn,
    });

    const finalIp = actuation.ip || deviceIp || null;
    const commandUpdate = {
      localIp: finalIp,
      ip: finalIp,
      lastSeen: new Date().toISOString(),
      status: 'online',
      relayOutputOn: actuation.relayOutputOn === true,
      valveState: normalizedAction === 'pulse'
        ? (deviceData.valveState || 'unknown')
        : normalizedAction === 'close'
          ? 'closed'
          : 'open',
      lastValveCommand: normalizedAction,
      lastValveCommandAt: new Date().toISOString(),
      pulseDurationMs: pulseMs,
      actuationMode,
      relayCloseOn,
      lastCommandSource: actuation.source || 'unknown',
    };

    const localDb = getFirestore();
    const updateWrites = [];

    if (resolved?.snapshot?.id) {
      updateWrites.push(
        targetDb.collection('shelly_devices').doc(resolved.snapshot.id).set(commandUpdate, { merge: true }).catch((error) => {
          console.warn('[Shelly Relay] Primary device state write failed:', error.message);
        })
      );
    }

    updateWrites.push(
      localDb.collection('shelly_devices').doc(deviceId).set(commandUpdate, { merge: true }).catch((error) => {
        console.warn('[Shelly Relay] Local fallback state write failed:', error.message);
      })
    );

    try {
      updateWrites.push(
        getIotFirestore().collection('shelly_devices').doc(deviceId).set(commandUpdate, { merge: true }).catch((error) => {
          console.warn('[Shelly Relay] Cloud mirror state write failed:', error.message);
        })
      );
    } catch (error) {
      console.warn('[Shelly Relay] Cloud mirror unavailable during command:', error.message);
    }

    shellyManager.registerDevice(deviceId, {
      source: 'command',
      ip: finalIp,
      type: 'relay_controller',
    });
    shellyManager.updateDeviceData(deviceId, commandUpdate);

    await Promise.all(updateWrites);

    res.json({
      success: true,
      deviceId,
      ip: finalIp,
      source: actuation.source,
      action: normalizedAction,
      pulseDurationMs: pulseMs,
      actuationMode,
      valveState: commandUpdate.valveState,
      relayOutputOn: commandUpdate.relayOutputOn,
      message: normalizedAction === 'close'
        ? actuationMode === 'maintained'
          ? 'Valve close command sent — relay held energized until you open the valve.'
          : 'Valve close command sent.'
        : normalizedAction === 'open'
          ? actuationMode === 'maintained'
            ? 'Valve open command sent — relay released to idle position.'
            : 'Valve open command sent.'
          : 'Relay pulse sent.',
    });
  } catch (error) {
    console.error('[Shelly Relay] Command failed:', error);
    const failedId = req.params?.deviceId;
    if (failedId) {
      markCloudDeviceOffline(failedId, { offlineReason: 'command_failed' }).catch(() => {});
      try {
        shellyManager.updateDeviceStatus(failedId, 'offline');
      } catch {
        // ignore
      }
    }
    res.status(503).json({ success: false, online: false, error: error.message });
  }
});

/**
 * POST /api/shelly/relay/reconfigure-cloud
 * Reconfigure outbound WebSocket + Firebase status webhooks on a relay after network change.
 */
router.post('/relay/reconfigure-cloud', async (req, res) => {
  try {
    const { deviceId, deviceIp } = req.body || {};
    if (!deviceId && !deviceIp) {
      return res.status(400).json({ success: false, error: 'deviceId or deviceIp is required' });
    }

    const firebaseWebhookUrl = requireShellyWebhookUrl(req);
    const outboundWebSocketUrl = getShellyWebSocketUrl(req);
    if (!outboundWebSocketUrl) {
      return res.status(400).json({
        success: false,
        error: 'Set SHELLY_SERVER_PUBLIC_URL (or run with a public tunnel) so the relay can connect outbound to HouseYield.',
      });
    }

    let relayIp = deviceIp;
    let info;
    if (relayIp) {
      info = await shellyLocalApi.getDeviceInfo(relayIp);
    } else {
      relayIp = await shellyLocalApi.findDeviceOnNetwork(deviceId, null, 30);
      if (!relayIp) {
        return res.status(404).json({
          success: false,
          error: 'Relay not found on the local network. Connect your laptop to the same WiFi as the relay and try again.',
        });
      }
      info = await shellyLocalApi.getDeviceInfo(relayIp);
    }

    const finalDeviceId = info.id || deviceId;
    const cloudConnectivity = await configureRelayCloudConnectivity(relayIp, finalDeviceId, {
      webhookBaseUrl: firebaseWebhookUrl,
      websocketUrl: outboundWebSocketUrl,
    });

    const touchUpdate = {
      localIp: relayIp,
      ip: relayIp,
      lastSeen: new Date().toISOString(),
      status: 'online',
    };

    await shellyManager.saveDevice(finalDeviceId, touchUpdate);
    let propertyId = null;
    try {
      const iotDb = getIotFirestore();
      await iotDb.collection('shelly_devices').doc(finalDeviceId).set(touchUpdate, { merge: true });
      const existing = await iotDb.collection('shelly_devices').doc(finalDeviceId).get();
      propertyId = existing.exists ? (existing.data()?.propertyId || null) : null;
    } catch (error) {
      console.warn('[Shelly Relay] Cloud mirror update failed during reconfigure:', error.message);
    }

    // Re-program flood → relay LAN shutoff so offline protection uses the fresh IP.
    let localShutoffSync = null;
    if (propertyId) {
      try {
        localShutoffSync = await syncPropertyLocalShutoff(propertyId, {
          cloudWebhookUrl: firebaseWebhookUrl,
        });
      } catch (error) {
        console.warn('[Shelly Relay] Local shutoff sync after reconnect failed:', error.message);
        localShutoffSync = { ok: false, error: error.message };
      }
    }

    res.json({
      success: true,
      deviceId: finalDeviceId,
      ip: relayIp,
      cloudConnectivity,
      localShutoffSync,
      message: localShutoffSync?.ok
        ? 'Relay reconnected to HouseYield and offline LAN shutoff webhooks were refreshed.'
        : 'Relay reconfigured for HouseYield cloud control — valve commands work from any network.',
    });
  } catch (error) {
    console.error('[Shelly Relay] Cloud reconfigure failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/setup/instructions
 * Get setup instructions for frontend
 */
router.get('/setup/instructions', (req, res) => {
  res.json({
    steps: [
      {
        step: 1,
        title: 'Power On Device',
        description: 'Insert 4 AA batteries into the Shelly Flood Gen4. The LED will start flashing.',
        image: '/images/shelly-battery.png'
      },
      {
        step: 2,
        title: 'Connect to Device WiFi',
        description: 'On your phone/computer, connect to the WiFi network named "ShellyFloodG4-XXXX" (no password needed).',
        note: 'The device creates its own WiFi network for initial setup.',
        image: '/images/shelly-wifi.png'
      },
      {
        step: 3,
        title: 'Configure Device',
        description: 'Once connected, click "Configure Device" below to set up WiFi and connect to your property.',
        action: 'configure'
      },
      {
        step: 4,
        title: 'Place Sensor',
        description: 'Position the sensor where you want to detect water leaks. The sensor cable should touch the floor.',
        tips: [
          'Near water heater',
          'Under sinks',
          'Basement floor',
          'Near washing machine',
          'Near HVAC drain pan'
        ]
      }
    ],
    troubleshooting: {
      'LED not flashing': 'Check battery orientation. Press and hold button for 5 seconds.',
      'Can\'t find WiFi network': 'Press device button to restart AP mode. WiFi name starts with ShellyFloodG4-',
      'Configuration failed': 'Ensure you\'re connected to the device WiFi, not your home WiFi.'
    }
  });
});

// ==================== ALERTS ====================

/**
 * GET /api/shelly/alerts
 * Get all alerts
 */
router.get('/alerts', (req, res) => {
  const unacknowledgedOnly = req.query.unacknowledged === 'true';
  const alerts = shellyManager.getAlerts(unacknowledgedOnly);
  
  res.json({
    success: true,
    count: alerts.length,
    alerts
  });
});

/**
 * GET /api/shelly/cloud/alerts
 * Read live alerts from the IoT Firebase project used by Shelly webhooks.
 */
router.get('/cloud/alerts', async (req, res) => {
  try {
    const alerts = await listCloudAlerts(50);
    res.json({
      success: true,
      projectId: getIotProjectId(),
      count: alerts.length,
      alerts,
    });
  } catch (error) {
    console.error('Cloud alerts fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/cloud/devices
 * Read live Shelly devices from the IoT Firebase project.
 */
router.get('/cloud/devices', async (req, res) => {
  try {
    const devices = await listCloudDevices();
    res.json({
      success: true,
      projectId: getIotProjectId(),
      count: devices.length,
      devices,
    });
  } catch (error) {
    console.error('Cloud devices fetch error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/cloud/alerts/:alertId/acknowledge
 */
router.post('/cloud/alerts/:alertId/acknowledge', async (req, res) => {
  try {
    const acknowledged = await acknowledgeCloudAlert(req.params.alertId);
    if (!acknowledged) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }
    res.json({ success: true, alertId: req.params.alertId });
  } catch (error) {
    console.error('Cloud alert acknowledge error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/alerts/:alertId/acknowledge
 * Acknowledge an alert
 */
router.post('/alerts/:alertId/acknowledge', (req, res) => {
  const success = shellyManager.acknowledgeAlert(req.params.alertId);
  
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Alert not found' });
  }
});

// ==================== WEBHOOKS ====================

router.options('/webhook', (req, res) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Shelly-Webhook-Secret');
  res.status(204).send('');
});

/**
 * POST /api/shelly/webhook
 * Receive webhook from Shelly device
 * Device POSTs here when flood detected, battery low, etc.
 */
router.post('/webhook', express.json(), (req, res) => {
  handleShellyCloudWebhook(req, res);
});

/**
 * GET /api/shelly/webhook
 * Dashboard read API and webhook verification endpoint
 */
router.get('/webhook', (req, res) => {
  handleShellyCloudWebhook(req, res);
});

// ==================== HEALTH & STATUS ====================

/**
 * GET /api/shelly/health
 * Get system health status
 */
router.get('/health', (req, res) => {
  const health = shellyManager.getHealthStatus();
  res.json(health);
});

/**
 * GET /api/shelly/websocket-url
 * Get WebSocket URL for frontend to connect
 */
router.get('/websocket-url', (req, res) => {
  const protocol = req.secure ? 'wss' : 'ws';
  const host = req.get('host');
  
  res.json({
    url: `${protocol}://${host}/shelly-ws?subscribe=true`,
    note: 'Connect to this WebSocket to receive real-time updates'
  });
});

// ==================== DIRECT LOCAL API ====================

/**
 * POST /api/shelly/local/rpc
 * Send direct RPC command to device on local network
 */
router.post('/local/rpc', async (req, res) => {
  try {
    const { ip, method, params = {} } = req.body;
    
    if (!ip || !method) {
      return res.status(400).json({ error: 'IP and method required' });
    }

    const result = await shellyLocalApi.rpc(ip, method, params);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FIREBASE WEBHOOK CONFIGURATION ====================

/**
 * POST /api/shelly/setup/configure-firebase-webhook
 * Configure a device to send webhooks to Firebase Cloud Function
 * This is the key endpoint for remote monitoring - device sends to Firebase from ANY network
 */
router.post('/setup/configure-firebase-webhook', async (req, res) => {
  try {
    const { deviceIp, deviceId, deviceName, location, propertyId } = req.body;

    if (!deviceIp) {
      return res.status(400).json({ 
        success: false, 
        error: 'Device IP is required. You must be on the same network as the sensor.' 
      });
    }

    console.log(`🔧 Configuring Firebase webhook for device at ${deviceIp}`);

    const firebaseWebhookUrl = requireShellyWebhookUrl(req);

    // ── 1. Check Firestore for existing device (reconnection detection) ──
    let previouslyRegistered = false;
    let existingDevice = null;
    try {
      if (firestoreService && typeof firestoreService.getSensor === 'function') {
        // Check by deviceId if provided
        if (deviceId) {
          existingDevice = await firestoreService.getSensor(deviceId);
        }
        // Also try to find any device with this IP
        if (!existingDevice) {
          const allSensors = await firestoreService.getAllSensors();
          existingDevice = allSensors.find(s => s.ip === deviceIp || s.localIp === deviceIp);
        }
        if (existingDevice) {
          previouslyRegistered = true;
          console.log(`   🔄 Previously registered device found: ${existingDevice.id} (was at IP: ${existingDevice.ip || existingDevice.localIp || 'unknown'})`);
        }
      }
    } catch (err) {
      console.log('   Could not check Firestore for existing device:', err.message);
    }

    // ── 2. Contact the physical device ──
    let info;
    try {
      info = await shellyLocalApi.getDeviceInfo(deviceIp);
      console.log(`   Found device: ${info.id} (${info.model})`);
    } catch (err) {
      // Device unreachable — check if it's a known battery device
      const isBatteryDevice = previouslyRegistered && 
        (existingDevice?.model?.toLowerCase().includes('flood') || 
         existingDevice?.type === 'flood' ||
         existingDevice?.deviceType?.includes('flood'));
      
      return res.status(400).json({
        success: false,
        previouslyRegistered,
        existingDevice: existingDevice ? { 
          id: existingDevice.id, 
          name: existingDevice.name, 
          type: existingDevice.type || existingDevice.deviceType,
          lastIp: existingDevice.ip || existingDevice.localIp
        } : null,
        error: isBatteryDevice
          ? `Cannot reach device at ${deviceIp}. This is a battery-powered sensor — press the button on the device to wake it up, then try again within 30 seconds.`
          : `Cannot reach device at ${deviceIp}. Make sure you're on the same network and the device is powered on.`,
        hint: 'battery_sleep'
      });
    }

    const finalDeviceId = deviceId || info.id;

    // ── 3. Derive device type from model ──
    const deviceType = inferShellyDeviceType(info) === 'unknown' ? 'flood' : inferShellyDeviceType(info);

    if (deviceType === 'relay') {
      return res.status(400).json({
        success: false,
        error: 'This Shelly device is a relay controller, not a sensor. Register it from the water shutoff flow instead of the sensor webhook flow.',
      });
    }

    // Re-check Firestore with the actual device ID
    if (!previouslyRegistered && firestoreService && typeof firestoreService.getSensor === 'function') {
      try {
        existingDevice = await firestoreService.getSensor(finalDeviceId);
        if (existingDevice) {
          previouslyRegistered = true;
          console.log(`   🔄 Found existing registration for ${finalDeviceId} after device ID lookup`);
        }
      } catch (e) { /* ignore */ }
    }

    if (previouslyRegistered) {
      console.log(`   🔄 RECONNECTING previously registered sensor on new network`);
      console.log(`   Old IP: ${existingDevice?.ip || existingDevice?.localIp || 'unknown'} → New IP: ${deviceIp}`);
    }

    // ── 4. Delete existing webhooks (clean slate) ──
    try {
      const hooks = await shellyLocalApi.rpc(deviceIp, 'Webhook.List');
      if (hooks.hooks && hooks.hooks.length > 0) {
        for (const hook of hooks.hooks) {
          await shellyLocalApi.rpc(deviceIp, 'Webhook.Delete', { id: hook.id });
          console.log(`   Deleted existing webhook: ${hook.id}`);
        }
      }
    } catch (err) {
      console.log('   No existing webhooks to delete');
    }

    // ── 5. Configure webhooks based on device type ──
    const configuredWebhooks = [];

    if (deviceType === 'flood') {
      const relayTargets = propertyId ? await listRelayShutoffTargetsForProperty(propertyId) : [];
      const hooks = await configureFloodShutoffWebhooks(deviceIp, finalDeviceId, {
        cloudWebhookUrl: firebaseWebhookUrl,
        relayTargets,
      });
      configuredWebhooks.push(...hooks.map((hook) => hook.event));
      console.log(`   ✅ Flood webhooks configured (${hooks.length} hook(s), ${relayTargets.length} local relay target(s))`);
    } else if (deviceType === 'ht') {
      // Temperature webhook
      try {
        const tempWebhook = `${firebaseWebhookUrl}?device_id=${finalDeviceId}&event=temperature.change`;
        await shellyLocalApi.rpc(deviceIp, 'Webhook.Create', {
          cid: 0,
          enable: true,
          event: 'temperature:0.change',
          name: 'firebase_temperature',
          urls: [tempWebhook]
        });
        configuredWebhooks.push('temperature:0.change');
        console.log(`   ✅ Webhook configured: temperature -> Firebase`);
      } catch (err) {
        console.log('   Temperature webhook not supported');
      }
      // Humidity webhook
      try {
        const humWebhook = `${firebaseWebhookUrl}?device_id=${finalDeviceId}&event=humidity.change`;
        await shellyLocalApi.rpc(deviceIp, 'Webhook.Create', {
          cid: 1,
          enable: true,
          event: 'humidity:0.change',
          name: 'firebase_humidity',
          urls: [humWebhook]
        });
        configuredWebhooks.push('humidity:0.change');
        console.log(`   ✅ Webhook configured: humidity -> Firebase`);
      } catch (err) {
        console.log('   Humidity webhook not supported');
      }
    }

    // Outbound WebSocket (all device types)
    const outboundWebSocketUrl = getShellyWebSocketUrl(req);
    if (outboundWebSocketUrl) {
      try {
        await shellyLocalApi.rpc(deviceIp, 'Ws.SetConfig', {
          config: {
            enable: true,
            server: outboundWebSocketUrl,
            ssl_ca: '*'
          }
        });
        console.log(`   ✅ Outbound WebSocket configured -> ${outboundWebSocketUrl}`);
      } catch (err) {
        console.log('   Outbound WebSocket not supported, using webhooks only');
      }
    } else {
      console.log('   Outbound WebSocket skipped - no public Shelly WebSocket URL configured');
    }

    // ── 6. Set device name if provided ──
    if (deviceName) {
      try {
        await shellyLocalApi.setDeviceName(deviceIp, deviceName);
        console.log(`   ✅ Device name set: ${deviceName}`);
      } catch (err) {
        console.log('   Failed to set device name');
      }
    }

    // ── 7. Register / update in Firebase Cloud Function ──
    try {
      const registerUrl = new URL(firebaseWebhookUrl);
      registerUrl.searchParams.set('action', 'register');
      if (process.env.SHELLY_WEBHOOK_SECRET) {
        registerUrl.searchParams.set('secret', process.env.SHELLY_WEBHOOK_SECRET);
      }
      const registerResponse = await fetch(registerUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'register',
          deviceId: finalDeviceId,
          name: deviceName || info.name || `${deviceType === 'flood' ? 'Flood' : deviceType === 'ht' ? 'H&T' : ''} Sensor ${finalDeviceId.slice(-4)}`,
          location: location || (existingDevice?.location) || 'Unknown',
          ip: deviceIp,
          model: info.model,
          mac: info.mac,
          firmware: info.fw_id,
          propertyId: propertyId || (existingDevice?.propertyId),
          type: deviceType
        })
      });
      const regData = await registerResponse.json();
      console.log(`   ✅ Device registered in Firebase: ${regData.success}`);
    } catch (err) {
      console.error('   Failed to register in Firebase:', err.message);
    }

    // ── 8. Also update local Firestore with full correct data ──
    try {
      if (firestoreService && typeof firestoreService.registerSensor === 'function') {
        await firestoreService.registerSensor(finalDeviceId, {
          deviceId: finalDeviceId,
          name: deviceName || info.name || existingDevice?.name || `Sensor ${finalDeviceId.slice(-4)}`,
          location: location || existingDevice?.location || 'Unknown',
          ip: deviceIp,
          localIp: deviceIp,
          model: info.model,
          mac: info.mac,
          type: deviceType,
          deviceType: toShellyFirestoreDeviceType(deviceType),
          webhookUrl: firebaseWebhookUrl,
          webhooksConfigured: configuredWebhooks,
          webhooksConfiguredAt: new Date().toISOString(),
          propertyId: propertyId || existingDevice?.propertyId || null,
          ownerId: existingDevice?.ownerId || null,
          capabilities: buildShellyCapabilities(deviceType),
          manufacturer: 'Shelly',
          isFlooded: deviceType === 'flood' ? false : undefined,
        });
        console.log(`   ✅ Firestore updated with correct type, IP, and webhook config`);
      }
    } catch (err) {
      console.error('   Firestore local update failed:', err.message);
    }

    // ── 9. Verify webhook configuration on device ──
    let finalHooks = { hooks: [] };
    try {
      finalHooks = await shellyLocalApi.rpc(deviceIp, 'Webhook.List');
    } catch (err) {
      console.log('   Could not verify webhooks (device may have gone to sleep)');
    }

    const firebaseHooks = (finalHooks.hooks || []).filter(h => 
      h.urls?.some(u => u.includes('cloudfunctions.net'))
    );
    
    const message = previouslyRegistered
      ? `🔄 Sensor ${finalDeviceId} reconnected on new network! Webhooks reconfigured for Firebase alerts.`
      : `✅ Device ${finalDeviceId} is now configured to send alerts to Firebase! It will work from any WiFi network.`;

    console.log(`   🎉 ${message}`);

    res.json({
      success: true,
      previouslyRegistered,
      deviceId: finalDeviceId,
      deviceType,
      device: {
        id: finalDeviceId,
        name: deviceName || info.name,
        model: info.model,
        mac: info.mac,
        ip: deviceIp
      },
      webhooks: finalHooks.hooks || [],
      firebaseWebhooks: firebaseHooks.length,
      configuredWebhooks,
      message
    });

  } catch (error) {
    console.error('Firebase webhook configuration error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/shelly/setup/verify-firebase
 * Verify that a device's webhook is properly configured for Firebase
 */
router.post('/setup/verify-firebase', async (req, res) => {
  try {
    const { deviceIp } = req.body;

    if (!deviceIp) {
      return res.status(400).json({ success: false, error: 'Device IP required' });
    }

    const hooks = await shellyLocalApi.rpc(deviceIp, 'Webhook.List');
    const firebaseHooks = (hooks.hooks || []).filter(h => 
      h.urls?.some(u => u.includes('cloudfunctions.net'))
    );

    res.json({
      success: true,
      configured: firebaseHooks.length > 0,
      webhooks: hooks.hooks || [],
      firebaseWebhooks: firebaseHooks
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/local/status/:ip
 * Get device status via local network
 */
router.get('/local/status/:ip', async (req, res) => {
  try {
    const data = await shellyLocalApi.getCompleteSensorData(req.params.ip);
    
    if (data) {
      res.json({ success: true, data });
    } else {
      res.status(404).json({ error: 'Device not reachable' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SENSOR ALERT AUTOMATION ====================

function buildAutomationAlert(alert) {
  return {
    id: alert.id,
    type: alert.type || 'flood',
    level: alert.severity || 'critical',
    severity: alert.severity || 'critical',
    deviceId: alert.deviceId || alert.id,
    deviceName: alert.deviceName,
    sensorLocation: alert.location || alert.deviceName || 'Unknown',
    message: alert.message || 'Sensor alert detected',
    timestamp: alert.timestamp instanceof Date
      ? alert.timestamp.toISOString()
      : alert.timestamp || new Date().toISOString(),
    acknowledged: alert.acknowledged || false,
    data: alert.data,
  };
}

async function autoNotifyTenantForAlert(alertId, {
  req = null,
  force = false,
  sendEmail = true,
  sendSMS = true,
  makePhoneCall = true,
  practiceTestPhone = null,
  dispatchOwnerMaintenance = true,
} = {}) {
  let cloudAlert = null;
  try {
    cloudAlert = await getCloudAlert(alertId);
  } catch (error) {
    console.warn('[Shelly Alert Auto-Notify] Cloud Firestore lookup failed, trying HTTP API:', error.message);
  }

  if (!cloudAlert) {
    cloudAlert = await fetchCloudAlertHttp(alertId);
  }

  const alerts = shellyManager.getAlerts(false);
  const memoryAlert = alerts.find((entry) => entry.id === alertId);
  const alert = cloudAlert || memoryAlert;

  if (!alert) {
    return { ok: false, status: 404, error: 'Alert not found' };
  }

  let waterShutoffResult = null;
  if (alert.type === 'flood') {
    waterShutoffResult = await triggerAutoCloseForProperty({
      propertyId: alert.propertyId,
      triggerId: alertId,
      sensorDeviceId: alert.deviceId || alert.sensorId,
      source: 'auto_notify',
      reason: 'leak',
    }).catch((error) => ({
      ok: false,
      error: error.message,
    }));
  } else if (alert.type === 'freeze_risk' || alert.type === 'pipe_burst' || alert.type === 'rapid_temp_change') {
    waterShutoffResult = await triggerAutoCloseForProperty({
      propertyId: alert.propertyId,
      triggerId: alertId,
      sensorDeviceId: alert.deviceId || alert.sensorId,
      source: 'auto_notify_freeze',
      reason: 'freeze',
    }).catch((error) => ({
      ok: false,
      error: error.message,
    }));
  }

  if (waterShutoffResult?.ownerMaintenanceDispatch?.ok) {
    await markAlertOwnerMaintenanceDispatched(alertId, waterShutoffResult.ownerMaintenanceDispatch);
  }

  if ((alert.notificationSent || locallyNotifiedAlertIds.has(String(alertId))) && !force) {
    return {
      ok: true,
      skipped: true,
      reason: 'Tenant already notified',
      alertId,
      tenantNotification: alert.tenantNotification || null,
      waterShutoff: waterShutoffResult,
    };
  }

  let propertyInfo = null;
  if (alert.propertyId) {
    propertyInfo = await resolvePropertyInfoForAlert({
      propertyId: alert.propertyId,
      ownerId: alert.ownerId,
    });
  }

  if (!propertyInfo && alert.deviceId) {
    const mapped = await shellyManager.getPropertyForSensor(alert.deviceId);
    if (mapped?.tenants?.length) {
      propertyInfo = mapped;
    } else if (mapped?.propertyId || mapped?.id) {
      propertyInfo = await resolvePropertyInfoForAlert({
        propertyId: mapped.propertyId || mapped.id,
        ownerId: mapped.ownerId || alert.ownerId,
      });
    }
  }

  if (!propertyInfo?.tenants?.length) {
    const ownerMaintenanceDispatch = await maybeDispatchOwnerMaintenanceForAlert({
      alert,
      alertId,
      propertyInfo,
      practiceTestPhone,
      req,
      dispatchOwnerMaintenance,
      waterShutoffResult,
    });

    if (ownerMaintenanceDispatch?.ok) {
      return {
        ok: true,
        alertId,
        ownerMaintenanceDispatch,
        waterShutoff: waterShutoffResult,
      };
    }

    return {
      ok: Boolean(waterShutoffResult?.ok || ownerMaintenanceDispatch?.ok),
      status: waterShutoffResult?.ok || ownerMaintenanceDispatch?.ok ? 200 : 400,
      error: waterShutoffResult?.ok || ownerMaintenanceDispatch?.ok
        ? undefined
        : ownerMaintenanceDispatch?.error || 'No tenant found for the property linked to this sensor',
      alertId,
      waterShutoff: waterShutoffResult,
      ownerMaintenanceDispatch,
    };
  }

  const currentTenant = pickCurrentTenant(propertyInfo);
  if (!currentTenant?.email && !currentTenant?.phone) {
    const ownerMaintenanceDispatch = await maybeDispatchOwnerMaintenanceForAlert({
      alert,
      alertId,
      propertyInfo,
      practiceTestPhone,
      req,
      dispatchOwnerMaintenance,
      waterShutoffResult,
    });

    if (ownerMaintenanceDispatch?.ok) {
      return {
        ok: true,
        alertId,
        ownerMaintenanceDispatch,
        waterShutoff: waterShutoffResult,
      };
    }

    return {
      ok: Boolean(waterShutoffResult?.ok || ownerMaintenanceDispatch?.ok),
      status: waterShutoffResult?.ok || ownerMaintenanceDispatch?.ok ? 200 : 400,
      error: waterShutoffResult?.ok || ownerMaintenanceDispatch?.ok
        ? undefined
        : ownerMaintenanceDispatch?.error || 'Tenant contact info is missing for this property',
      alertId,
      waterShutoff: waterShutoffResult,
      ownerMaintenanceDispatch,
    };
  }

  const publicUrl = resolvePublicWebhookUrl(req);
  const ownerMaintenanceDispatch = await maybeDispatchOwnerMaintenanceForAlert({
    alert,
    alertId,
    propertyInfo,
    practiceTestPhone,
    req,
    dispatchOwnerMaintenance,
    waterShutoffResult,
  });

  const result = await sensorAlertAutomation.processAlert(
    buildAutomationAlert(alert),
    propertyInfo,
    {
      sendEmail,
      sendSMS,
      makePhoneCall,
      createMaintenanceRequest: true,
      publicUrl,
    }
  );

  return {
    ok: true,
    alertId,
    propertyInfo: {
      id: propertyInfo.id,
      address: propertyInfo.address,
      tenantName: currentTenant?.name,
    },
    waterShutoff: waterShutoffResult,
    ownerMaintenanceDispatch,
    result,
  };
}

/**
 * POST /api/shelly/local-shutoff/sync
 * Program flood sensors to close the property relay directly over the LAN (GL.iNet IoT network).
 * Run from the bench when all devices are on the same IoT Wi-Fi.
 */
router.post('/local-shutoff/sync', async (req, res) => {
  try {
    const { propertyId } = req.body || {};
    if (!propertyId) {
      return res.status(400).json({ success: false, error: 'propertyId is required' });
    }

    const result = await syncPropertyLocalShutoff(propertyId, {
      cloudWebhookUrl: getShellyWebhookUrl(req),
    });

    res.json({
      success: result.ok || Boolean(result.skipped),
      ...result,
      message: result.skipped
        ? `Local shutoff sync skipped: ${result.reason}`
        : 'Flood sensors now close the water relay locally over the IoT LAN during internet outages.',
    });
  } catch (error) {
    console.error('[LocalShutoff] Sync failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/water-shutoff/auto-close
 * Close the property valve when a leak is detected (does not require Firestore alert lookup).
 */
router.post('/water-shutoff/auto-close', async (req, res) => {
  try {
    const { propertyId, alertId, sensorDeviceId, source, reason } = req.body || {};
    const result = await triggerAutoCloseForProperty({
      propertyId,
      triggerId: alertId,
      sensorDeviceId,
      source: source || 'api',
      reason: reason === 'freeze' ? 'freeze' : 'leak',
    });

    res.json({
      success: result.ok || Boolean(result.skipped),
      ...result,
    });
  } catch (error) {
    console.error('[WaterShutoff] Auto-close API failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/power-outage/utility-status
 * County/state utility outage corroboration via ORNL ODIN.
 */
router.get('/power-outage/utility-status', async (req, res) => {
  try {
    const stateCode = typeof req.query.state === 'string' ? req.query.state : null;
    const countyHint = typeof req.query.county === 'string' ? req.query.county : null;
    const status = await getUtilityOutageStatus({ stateCode, countyHint });
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('[PropertyPower] Utility status lookup failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/power-outage/signals
 * Evaluate property-level power estimation from registered devices.
 */
router.get('/power-outage/signals', async (req, res) => {
  try {
    const propertyId = typeof req.query.propertyId === 'string' ? req.query.propertyId : null;
    const propertyAddress = typeof req.query.propertyAddress === 'string' ? req.query.propertyAddress : null;

    let devices = [];
    try {
      devices = await fetchCloudDevicesHttp();
    } catch {
      devices = [];
    }

    try {
      const localDevices = await shellyManager.getAllDevices();
      for (const device of localDevices) {
        const deviceId = device.id || device.deviceId;
        if (!devices.some((entry) => (entry.deviceId || entry.id) === deviceId)) {
          devices.push({ ...device, deviceId, id: deviceId });
        }
      }
    } catch {
      // Local manager may be unavailable.
    }

    if (propertyId) {
      devices = devices.filter((device) => device.propertyId === propertyId);
    }

    const propertyAddresses = {};
    if (propertyId && propertyAddress) {
      propertyAddresses[propertyId] = propertyAddress;
    }
    for (const device of devices) {
      if (device.propertyId && device.propertyAddress && !propertyAddresses[device.propertyId]) {
        propertyAddresses[device.propertyId] = device.propertyAddress;
      }
    }

    const states = [...new Set(
      Object.values(propertyAddresses)
        .map(parseStateFromAddress)
        .filter(Boolean),
    )];

    const utilityStatusByState = {};
    for (const stateCode of states) {
      utilityStatusByState[stateCode] = await getUtilityOutageStatus({ stateCode });
    }

    const signals = evaluateAllPropertyPowerSignals(devices, propertyAddresses, utilityStatusByState);
    res.json({
      success: true,
      count: signals.length,
      signals,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[PropertyPower] Signal evaluation failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/alerts/:alertId/auto-shutoff
 * Automatically close the property water valve when a leak alert fires.
 */
router.post('/alerts/:alertId/auto-shutoff', async (req, res) => {
  try {
    let alert = null;
    try {
      alert = await getCloudAlert(req.params.alertId);
    } catch (error) {
      console.warn('[Shelly Alert Auto-Shutoff] Cloud Firestore lookup failed, trying HTTP API:', error.message);
    }

    if (!alert) {
      alert = await fetchCloudAlertHttp(req.params.alertId);
    }

    if (!alert) {
      alert = shellyManager.getAlerts(false).find((entry) => entry.id === req.params.alertId) || null;
    }

    if (!alert) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    const result = await triggerAutoCloseForAlert({
      ...alert,
      id: req.params.alertId,
    });

    res.json({
      success: result.ok || Boolean(result.skipped),
      alertId: req.params.alertId,
      ...result,
    });
  } catch (error) {
    console.error('[Shelly Alert Auto-Shutoff] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/alerts/:alertId/auto-notify
 * Automatically notify the tenant linked to the alert's property/unit.
 */
router.post('/alerts/:alertId/auto-notify', async (req, res) => {
  try {
    const { force = false, sendEmail = true, sendSMS = true, makePhoneCall = true, practiceTestPhone = null, dispatchOwnerMaintenance = true } = req.body || {};
    const outcome = await autoNotifyTenantForAlert(req.params.alertId, {
      req,
      force,
      sendEmail,
      sendSMS,
      makePhoneCall,
      practiceTestPhone,
      dispatchOwnerMaintenance,
    });

    if (!outcome.ok) {
      return res.status(outcome.status || 500).json({
        success: false,
        error: outcome.error,
        alertId: outcome.alertId,
      });
    }

    res.json({
      success: true,
      skipped: outcome.skipped || false,
      reason: outcome.reason || null,
      alertId: outcome.alertId,
      propertyInfo: outcome.propertyInfo || null,
      result: outcome.result || null,
      ownerMaintenanceDispatch: outcome.ownerMaintenanceDispatch || null,
      waterShutoff: outcome.waterShutoff || null,
      tenantNotification: outcome.result?.tenantNotification || outcome.tenantNotification || null,
    });
  } catch (error) {
    console.error('[Shelly Alert Auto-Notify] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/shelly/alerts/:alertId/communications
 * Return tenant notification delivery details for an alert.
 */
router.get('/alerts/:alertId/communications', async (req, res) => {
  try {
    const alertId = req.params.alertId;
    const cloudAlert = await getCloudAlert(alertId);
    const automationRecord = sensorAlertAutomation.getAlertRecord(alertId);

    if (!cloudAlert && !automationRecord) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    res.json({
      success: true,
      alertId,
      notificationSent: Boolean(cloudAlert?.notificationSent || automationRecord?.tenantNotification),
      tenantNotifiedAt: cloudAlert?.tenantNotifiedAt || automationRecord?.tenantNotification?.sentAt || null,
      tenantNotification: cloudAlert?.tenantNotification || automationRecord?.tenantNotification || null,
      channels: cloudAlert?.tenantNotification?.channels || automationRecord?.notifications || null,
      maintenanceRequest: automationRecord?.maintenanceRequest || null,
    });
  } catch (error) {
    console.error('[Shelly Alert Communications] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/alerts/:alertId/notify
 * Manually trigger notifications for an alert
 * Sends email, SMS, and optionally makes an AI phone call to the tenant
 */
router.post('/alerts/:alertId/notify', async (req, res) => {
  try {
    const { alertId } = req.params;
    let {
      propertyInfo,
      sendEmail = true,
      sendSMS = true,
      makePhoneCall = false,
      alert: alertFromBody  // Allow passing alert data directly from frontend
    } = req.body;

    // Try to get alert from request body first (for Firestore alerts)
    // Then fall back to in-memory alerts
    let alert = alertFromBody;
    
    if (!alert) {
      // Get the alert from the manager's in-memory store
      const alerts = shellyManager.getAlerts(false);
      alert = alerts.find(a => a.id === alertId);
    }

    // If still no alert, create one from the alertId and available data
    if (!alert) {
      // Construct a minimal alert from the alertId for notification purposes
      alert = {
        id: alertId,
        type: 'flood',
        level: 'critical',
        severity: 'critical',
        deviceId: alertId,
        sensorLocation: 'Unknown',
        message: 'Sensor alert detected - immediate attention required',
        timestamp: new Date().toISOString(),
        acknowledged: false
      };
      console.log('[Shelly Alert Notify] Created alert from alertId:', alertId);
    }

    if (!propertyInfo || !propertyInfo.tenants?.length) {
      const resolvedPropertyInfo = await resolvePropertyInfoForAlert({
        propertyId: propertyInfo?.id || alert.propertyId,
        ownerId: propertyInfo?.ownerId || alert.ownerId,
        unit: propertyInfo?.unit || alert.unit,
      }) || await shellyManager.getPropertyForSensor(alert.deviceId || alertId);

      if (resolvedPropertyInfo?.tenants?.length) {
        propertyInfo = resolvedPropertyInfo;
      }
    }

    if (!propertyInfo || !propertyInfo.tenants?.length) {
      return res.status(400).json({ 
        success: false, 
        error: 'Property info with tenant data is required' 
      });
    }

    const publicUrl = resolvePublicWebhookUrl(req);
    if (makePhoneCall && !publicUrl) {
      return res.status(400).json({
        success: false,
        error: buildPublicWebhookUrlError(req.headers.host ? `${req.protocol}://${req.get('host')}` : null),
      });
    }

    const result = await sensorAlertAutomation.processAlert(alert, propertyInfo, {
      sendEmail,
      sendSMS,
      makePhoneCall,
      createMaintenanceRequest: true,
      publicUrl: publicUrl || resolvePublicWebhookUrl() || 'http://localhost:3001'
    });

    res.json({
      success: true,
      result
    });

  } catch (error) {
    console.error('[Shelly Alert Notify] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/shelly/test-alert-automation
 * Test the alert automation system with mock data
 * Useful for verifying email, SMS, and phone integrations work
 */
router.post('/test-alert-automation', async (req, res) => {
  try {
    const { 
      tenantName = 'Test Tenant',
      tenantEmail,
      tenantPhone,
      propertyAddress = '123 Test Street',
      unit = '1',
      alertType = 'flood',
      sensorLocation = 'Laundry Room',
      sendEmail = true,
      sendSMS = true,
      makePhoneCall = false
    } = req.body;

    if (!tenantEmail && !tenantPhone) {
      return res.status(400).json({
        success: false,
        error: 'Either tenantEmail or tenantPhone is required for testing'
      });
    }

    // Create a mock alert
    const mockAlert = {
      id: `test-alert-${Date.now()}`,
      type: alertType,
      level: 'critical',
      deviceId: `test-sensor-${Date.now()}`,
      sensorName: 'Test Flood Sensor',
      sensorLocation: sensorLocation,
      message: `🚨 TEST ALERT: ${alertType.toUpperCase()} detected at ${sensorLocation}!`,
      timestamp: new Date().toISOString(),
      acknowledged: false,
      data: {
        temperature: 22.5,
        batteryLevel: 85
      }
    };

    // Create mock property info with tenant
    const mockPropertyInfo = {
      id: 'test-property',
      address: propertyAddress,
      tenants: [{
        name: tenantName,
        email: tenantEmail,
        phone: tenantPhone,
        unit: unit,
        status: 'Current'
      }]
    };

    const publicUrl = resolvePublicWebhookUrl(req);
    if (makePhoneCall && !publicUrl) {
      return res.status(400).json({
        success: false,
        error: buildPublicWebhookUrlError(req.headers.host ? `${req.protocol}://${req.get('host')}` : null),
      });
    }

    const result = await sensorAlertAutomation.processAlert(mockAlert, mockPropertyInfo, {
      sendEmail,
      sendSMS,
      makePhoneCall,
      createMaintenanceRequest: true,
      publicUrl: publicUrl || 'http://localhost:3001'
    });

    res.json({
      success: true,
      message: 'Test alert automation triggered',
      result
    });

  } catch (error) {
    console.error('[Shelly Test Alert] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/shelly/alert-automation/records
 * Get history of alert automation records
 */
router.get('/alert-automation/records', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const records = sensorAlertAutomation.getAlertRecords(limit);
  
  res.json({
    success: true,
    count: records.length,
    records
  });
});

/**
 * GET /api/shelly/alert-automation/records/:alertId
 * Get a specific alert automation record
 */
router.get('/alert-automation/records/:alertId', (req, res) => {
  const record = sensorAlertAutomation.getAlertRecord(req.params.alertId);
  
  if (record) {
    res.json({ success: true, record });
  } else {
    res.status(404).json({ success: false, error: 'Record not found' });
  }
});

/**
 * POST /api/shelly/devices/:deviceId/set-property
 * Associate a sensor with a property (for automatic tenant notifications)
 */
router.post('/devices/:deviceId/set-property', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { propertyInfo } = req.body;

    if (!propertyInfo) {
      return res.status(400).json({
        success: false,
        error: 'Property info is required'
      });
    }

    // Set the mapping in the manager
    shellyManager.setPropertyForSensor(deviceId, propertyInfo);

    res.json({
      success: true,
      message: `Sensor ${deviceId} associated with property`,
      propertyAddress: propertyInfo.address
    });

  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== BLU GATEWAY ROUTES ====================

/**
 * POST /api/shelly/setup/check-ap-gateway
 * Check if connected to a BLU Gateway AP
 * Tries multiple methods since different Shelly devices may respond differently
 */
router.post('/setup/check-ap-gateway', async (req, res) => {
  const apIp = '192.168.33.1';
  console.log(`📡 [Gateway AP Check] Trying to reach gateway at ${apIp}...`);
  
  // Method 1: Standard Gen2+ JSON-RPC via POST /rpc
  try {
    const info = await shellyLocalApi.getDeviceInfo(apIp);
    console.log(`✅ [Gateway AP Check] Found via /rpc:`, info.id, info.model);
    
    const haystack = [info.model, info.app, info.id, info.name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const isGateway = (
      haystack.includes('gateway')
      || haystack.includes('blugw')
      || haystack.includes('sngw')
      || haystack.includes('gwf')
    );
    
    return res.json({
      success: true,
      connected: true,
      isGateway,
      device: info,
      method: 'rpc'
    });
  } catch (err1) {
    console.log(`⚠️  [Gateway AP Check] /rpc POST failed: ${err1.message}`);
  }

  // Method 2: Try GET /rpc/Shelly.GetDeviceInfo (some devices prefer GET)
  try {
    const { data } = await axios.get(`http://${apIp}/rpc/Shelly.GetDeviceInfo`, { timeout: 8000 });
    console.log(`✅ [Gateway AP Check] Found via GET /rpc/Shelly.GetDeviceInfo:`, data);
    
    const info = {
      id: data.id,
      name: data.name || `Shelly ${data.model}`,
      model: data.model,
      mac: data.mac,
      firmware: data.fw_id,
      app: data.app,
      gen: data.gen
    };
    
    return res.json({
      success: true,
      connected: true,
      isGateway: true,
      device: info,
      method: 'rpc-get'
    });
  } catch (err2) {
    console.log(`⚠️  [Gateway AP Check] GET /rpc/... failed: ${err2.message}`);
  }

  // Method 3: Try Gen1-style /shelly endpoint
  try {
    const { data } = await axios.get(`http://${apIp}/shelly`, { timeout: 8000 });
    console.log(`✅ [Gateway AP Check] Found via /shelly (Gen1):`, data);
    
    const info = {
      id: data.mac || data.id || 'unknown',
      name: data.name || 'BLU Gateway',
      model: data.type || data.model || 'BLU Gateway',
      mac: data.mac || '',
      firmware: data.fw || '',
      app: data.app || ''
    };
    
    return res.json({
      success: true,
      connected: true,
      isGateway: true,
      device: info,
      method: 'gen1'
    });
  } catch (err3) {
    console.log(`⚠️  [Gateway AP Check] /shelly failed: ${err3.message}`);
  }

  // Method 4: Just try to reach the IP at all (basic HTTP)
  try {
    const { status } = await axios.get(`http://${apIp}/`, { timeout: 8000, maxRedirects: 3 });
    console.log(`⚠️  [Gateway AP Check] IP reachable (HTTP ${status}) but no known API responded`);
    
    return res.json({
      success: true,
      connected: true,
      isGateway: true,
      device: {
        id: 'unknown',
        name: 'BLU Gateway',
        model: 'Shelly BLU Gateway',
        mac: '',
        firmware: ''
      },
      method: 'http-fallback',
      note: 'Device responded to HTTP but not to Shelly API. Proceeding anyway.'
    });
  } catch (err4) {
    console.log(`❌ [Gateway AP Check] IP completely unreachable: ${err4.message}`);
  }

  res.json({
    success: false,
    connected: false,
    message: 'Cannot reach device at 192.168.33.1. Make sure you are connected to the ShellyBluGw-XXXX WiFi network and try again in a few seconds.'
  });
});

/**
 * POST /api/shelly/setup/ap-configure-gateway
 * Configure a BLU Gateway from AP mode:
 *  1. Set WiFi credentials so it joins your home network
 *  2. Enable BLE observer mode
 *  3. Set up webhooks for sensor events
 *  4. Reboot the device
 */
router.post('/setup/ap-configure-gateway', async (req, res) => {
  try {
    const { wifiSsid, wifiPassword, deviceName, propertyId, networkType } = req.body;
    
    if (!wifiSsid) {
      return res.status(400).json({ error: 'WiFi SSID is required' });
    }
    if (networkType !== 'public' && !wifiPassword) {
      return res.status(400).json({ error: 'WiFi password required for private networks' });
    }

    const apIp = '192.168.33.1';
    
    // 1. Get device info (try multiple methods)
    let info = null;
    try {
      info = await shellyLocalApi.getDeviceInfo(apIp);
    } catch (e) {
      // Fallback: try GET endpoint
      try {
        const { data } = await axios.get(`http://${apIp}/rpc/Shelly.GetDeviceInfo`, { timeout: 8000 });
        info = {
          id: data.id, name: data.name || 'BLU Gateway',
          model: data.model, mac: data.mac, firmware: data.fw_id, app: data.app
        };
      } catch (e2) {
        // Last resort: try Gen1
        try {
          const { data } = await axios.get(`http://${apIp}/shelly`, { timeout: 8000 });
          info = {
            id: data.mac || 'blugw-unknown', name: 'BLU Gateway',
            model: data.type || 'BLU Gateway', mac: data.mac || '', firmware: data.fw || ''
          };
        } catch (e3) {
          throw new Error('Cannot communicate with gateway at 192.168.33.1. Make sure you are connected to its WiFi.');
        }
      }
    }
    console.log(`📡 Found BLU Gateway: ${info.id} (${info.model})`);

    // 2. Configure WiFi (gateway reboot/AP handoff can be slow on travel routers)
    await shellyLocalApi.configureWifi(apIp, wifiSsid, wifiPassword || '', 30000);
    console.log('✅ Gateway WiFi configured');

    // 3. Set device name
    if (deviceName) {
      await shellyLocalApi.setDeviceName(apIp, deviceName);
    }

    // 4. Enable BLE so it can bridge BLE sensors
    //    Per Shelly docs: 'observer' is obsolete since 1.5.0 — just use enable + rpc
    try {
      await shellyLocalApi.rpc(apIp, 'BLE.SetConfig', {
        config: {
          enable: true,
          rpc: { enable: true }
        }
      });
      console.log('✅ BLE enabled on gateway');
    } catch (bleErr) {
      console.warn('⚠️ BLE config may already be set:', bleErr.message);
    }

    // 5. Save to Firestore — webhooks will be created AFTER sensors are 
    //    registered (the gateway only supports webhook events for components 
    //    that exist, e.g. bthomesensor events appear after BTHome.AddSensor)

    // 6. Register gateway in shellyManager + persist to Firestore before reboot
    shellyManager.registerDevice(info.id, {
      source: 'setup',
      name: deviceName || 'BLU Gateway',
      type: 'ble_gateway',
      propertyId
    });

    await shellyManager.saveDevice(info.id, {
      name: deviceName || info.name || 'BLU Gateway',
      propertyId: propertyId || null,
      type: 'ble_gateway',
      deviceType: 'ble_gateway',
      model: info.model || 'SNGW-BT01',
      connectionType: 'wifi',
      capabilities: ['ble_bridge'],
      mac: info.mac || null,
      status: 'online',
      clearTombstone: true,
    });

    // 7. Save gateway ID to env reference (in-memory for now)
    process.env.SHELLY_BLU_GATEWAY_ID = info.id;
    
    // 8. Store the MAC so we can find it on the network after reboot
    const gatewayMac = info.mac;
    
    // 9. Send success response BEFORE reboot — because the reboot disconnects
    //    the user from the Shelly AP WiFi, killing the HTTP connection
    res.json({
      success: true,
      gatewayId: info.id,
      mac: gatewayMac,
      model: info.model,
      message: 'BLU Gateway configured! It will reboot and connect to HouseYield-IoT / your WiFi shortly.'
    });

    // 10. Reboot AFTER response is sent (small delay to ensure response arrives)
    setTimeout(async () => {
      try {
        await shellyLocalApi.rpc(apIp, 'Shelly.Reboot');
        console.log('✅ Gateway reboot triggered');
      } catch (e) { 
        // Connection drops during reboot — that's expected
        console.log('📡 Gateway rebooting (connection dropped as expected)');
      }

      // 11. After reboot, scan the home network to find the gateway's new IP
      //     Gateway needs ~15-25s to boot + connect to WiFi + get DHCP lease
      console.log('🔍 Will scan for gateway on home network in 25 seconds...');
      setTimeout(async () => {
        try {
          const newIp = await shellyLocalApi.findDeviceOnNetwork(info.id);
          if (newIp) {
            console.log(`✅ Gateway found on home network at ${newIp}`);
            // Update the gateway service with the real IP
            const gateway = shellyManager.getBluGateway();
            gateway.gatewayIp = newIp;
            // Re-initialize with local connection
            gateway.initialized = false;
            await gateway.initialize();
            // Save the IP to Firestore
            await shellyManager.saveDevice(info.id, { localIp: newIp });
            console.log(`💾 Gateway IP ${newIp} saved to Firestore`);
          } else {
            console.log('⚠️ Gateway not found on network yet — it may need more time or a different subnet.');
          }
        } catch (scanErr) {
          console.log('ℹ️ Post-reboot network scan failed:', scanErr.message);
        }
      }, 25000);
    }, 500);

  } catch (error) {
    console.error('Gateway AP setup failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/gateway/find-on-network
 * Scan the local network to locate the BLU Gateway by its device ID.
 * Use this after AP-mode setup when the gateway has rebooted onto home WiFi.
 */
router.post('/gateway/find-on-network', async (req, res) => {
  try {
    const { gatewayId, subnet } = req.body;
    const gateway = shellyManager.getBluGateway();
    const targetId = gatewayId || gateway.gatewayId;

    if (!targetId) {
      return res.status(400).json({ success: false, error: 'No gateway ID to search for' });
    }

    console.log(`🔍 Manual network scan for gateway: ${targetId}`);
    const foundIp = await shellyLocalApi.findDeviceOnNetwork(targetId, subnet || null);

    if (foundIp) {
      // Update the gateway service
      gateway.gatewayIp = foundIp;
      gateway.initialized = false;
      await gateway.initialize();
      // Persist to Firestore
      await shellyManager.saveDevice(targetId, { localIp: foundIp });
      
      res.json({ 
        success: true, 
        ip: foundIp, 
        gatewayId: targetId,
        message: `Gateway found at ${foundIp} and connected locally!`
      });
    } else {
      res.json({ 
        success: false, 
        message: 'Gateway not found on network. It may still be booting — try again in 15 seconds.' 
      });
    }
  } catch (error) {
    console.error('Gateway network scan failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/gateway/status
 * Get BLU Gateway status and connected BLE devices
 */
router.get('/gateway/status', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    const status = await gateway.getGatewayStatus();
    const health = await gateway.healthCheck();
    
    res.json({
      success: true,
      gateway: { ...status, ...health },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/gateway/discover
 * Start BLE device discovery on the gateway
 */
router.post('/gateway/discover', async (req, res) => {
  try {
    const { duration = 30 } = req.body;
    const gateway = shellyManager.getBluGateway();
    
    if (!gateway.initialized) {
      return res.status(400).json({ success: false, error: 'BLU Gateway not initialized' });
    }

    // Start discovery (non-blocking response)
    gateway.discoverDevices(duration).then(devices => {
      console.log(`Discovery found ${devices.length} devices`);
    });
    
    res.json({
      success: true,
      message: `BLE discovery started for ${duration}s`,
      tip: 'Check GET /api/shelly/gateway/discovered for results',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/gateway/discovered
 * Get list of discovered BLE devices
 */
router.get('/gateway/discovered', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    res.json({
      success: true,
      discovering: gateway.isDiscovering,
      devices: gateway.getDiscoveredDevices(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/gateway/ble-devices
 * List all BLE devices discovered by the gateway's BLE scanner
 */
router.get('/gateway/ble-devices', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    const scriptStatus = await gateway.getScriptStatus();
    const discoveredDevices = gateway.getDiscoveredDevices();
    
    res.json({
      success: true,
      scriptStatus,
      discoveredDevices,
      deviceCount: discoveredDevices.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/gateway/deploy-script
 * Deploy or re-deploy the BLE scanner script on the gateway
 */
router.post('/gateway/deploy-script', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    const result = await gateway.deployBLEScript();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/gateway/ensure-cloud-webhook
 * Verify the on-device BLE script posts to Cloud Run (not only local).
 */
router.post('/gateway/ensure-cloud-webhook', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    if (typeof gateway.ensureCloudPrimaryWebhook !== 'function') {
      return res.status(500).json({ success: false, error: 'ensure_not_supported' });
    }
    const result = await gateway.ensureCloudPrimaryWebhook();
    res.status(result.ok ? 200 : 503).json({ success: result.ok, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET|POST /api/shelly/climate-history/tick
 * Keep Cloud Run warm and sample live shelly_devices → sensor_readings.
 * Intended for Cloud Scheduler every 1–2 minutes so Analytics history does
 * not depend on a laptop running `npm run push-server`.
 *
 * Auth: SHELLY_WEBHOOK_SECRET (header/query) when configured; open otherwise
 * (same model as device webhooks).
 */
async function climateHistoryTickHandler(req, res) {
  try {
    const expected = process.env.SHELLY_WEBHOOK_SECRET || '';
    if (expected) {
      const provided = req.headers['x-shelly-webhook-secret']
        || req.query.secret
        || req.body?.secret;
      if (provided !== expected) {
        return res.status(401).json({ success: false, error: 'unauthorized' });
      }
    }
    if (req.query.force === '1' || req.query.force === 'true') {
      resetClimateGhostPurgeThrottle();
    }
    const result = await climateHistorySampler.sample();
    // Drop purged ghosts from the in-memory Shelly manager so /devices matches Firestore.
    try {
      for (const [id] of shellyManager.devices) {
        const lower = String(id).toLowerCase();
        if (lower.includes('probe') || lower.includes('blu-ht-test') || lower.startsWith('shellyhtg3-')) {
          const device = shellyManager.devices.get(id);
          if (lower.includes('probe') || lower.includes('blu-ht-test') || !device?.propertyId) {
            shellyManager.devices.delete(id);
          }
        }
      }
    } catch {
      // non-fatal
    }
    res.json({
      success: true,
      ...result,
      webhookUrl: resolveShellyWebhookUrl(),
      ts: Date.now(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
router.get('/climate-history/tick', climateHistoryTickHandler);
router.post('/climate-history/tick', climateHistoryTickHandler);

/**
 * DELETE /api/shelly/gateway/deploy-script
 * Remove the BLE scanner script from the gateway
 */
router.delete('/gateway/deploy-script', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    await gateway.removeBLEScript();
    res.json({ success: true, message: 'BLE scanner script removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/gateway/script-status
 * Check the status of the BLE scanner script
 */
router.get('/gateway/script-status', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    const status = await gateway.getScriptStatus();
    res.json({ success: true, script: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/ble/data
 * Receive BLE sensor data from the gateway's scanner script.
 * This is the endpoint the on-device script HTTP POSTs to.
 */
router.post('/ble/data', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    gateway.handleBleData(req.body);
    res.json({ ok: true });
  } catch (error) {
    console.error('BLE data ingest error:', error);
    res.status(500).json({ ok: false });
  }
});

/**
 * POST /api/shelly/gateway/webhook
 * Receive webhook events from the BLU Gateway (legacy)
 */
router.post('/gateway/webhook', async (req, res) => {
  try {
    const gateway = shellyManager.getBluGateway();
    gateway.handleWebhookEvent(req.body);
    res.json({ success: true });
  } catch (error) {
    console.error('Gateway webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== H&T SENSOR ROUTES ====================

/**
 * GET /api/shelly/ht/status
 * Get status of all H&T temperature/humidity sensors
 */
router.get('/ht/status', async (req, res) => {
  try {
    const htService = shellyManager.getHTService();
    res.json({
      success: true,
      ...htService.getStatus(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/setup/check-ap-ht
 * Check if we can connect to H&T Gen3 device in AP mode
 * H&T Gen3 creates AP at 192.168.33.1 (same as all Shelly Gen3 devices)
 */
router.post('/setup/check-ap-ht', async (req, res) => {
  try {
    const apIp = '192.168.33.1';
    const info = await shellyLocalApi.getDeviceInfo(apIp);
    
    res.json({
      success: true,
      connected: true,
      device: info
    });
  } catch (error) {
    res.json({
      success: false,
      connected: false,
      message: 'Not connected to Shelly H&T device AP. Please connect to the ShellyHTG3-XXXX WiFi network.'
    });
  }
});

/**
 * POST /api/shelly/setup/ap-configure-relay
 * Configure Shelly 1 Gen4 relay from AP mode — sends WiFi credentials and registers device
 */
router.post('/setup/ap-configure-relay', async (req, res) => {
  try {
    const {
      wifiSsid,
      wifiPassword,
      deviceName,
      location,
      propertyId,
      networkType,
      pulseDurationMs = 20000,
      valveTravelMs = 15000,
      actuationMode = 'maintained',
      relayCloseOn = true,
      defaultValveState = 'unknown',
    } = req.body;

    if (!wifiSsid) {
      return res.status(400).json({ success: false, error: 'WiFi SSID is required' });
    }
    if (networkType !== 'public' && !wifiPassword) {
      return res.status(400).json({ success: false, error: 'WiFi password required for private networks' });
    }

    const apIp = '192.168.33.1';
    console.log(`🚰 Configuring Shelly 1 relay for ${networkType || 'private'} network: ${wifiSsid}`);

    // Use longer timeouts — AP mode over a travel-router laptop hop is often slow.
    const info = await shellyLocalApi.getDeviceInfo(apIp, 15000);
    const inferredType = inferShellyDeviceType(info);
    if (inferredType !== 'relay') {
      return res.status(400).json({
        success: false,
        error: `Device ${info.id} is not a Shelly relay controller`,
      });
    }

    const finalDeviceId = info.id;
    const finalName = deviceName || info.name || `Water Shutoff Relay ${finalDeviceId.slice(-4)}`;
    const finalLocation = location || 'Main water shutoff';

    if (deviceName) {
      try {
        await shellyLocalApi.setDeviceName(apIp, deviceName, 15000);
      } catch (error) {
        console.warn('[Shelly Relay AP] Failed to set device name:', error.message);
      }
    }

    // Persist the dashboard record BEFORE WiFi handoff. Once Wifi.SetConfig runs,
    // the relay leaves 192.168.33.1 and follow-up RPCs commonly time out.
    await shellyManager.registerDevice(finalDeviceId, {
      source: 'setup',
      name: finalName,
      location: finalLocation,
      propertyId,
      type: 'relay_controller',
    });
    shellyManager.updateDeviceData(finalDeviceId, {
      valveState: defaultValveState,
      pulseDurationMs: Math.max(250, Math.min(Number(pulseDurationMs) || 20000, 60000)),
      valveTravelMs: Math.max(5000, Math.min(Number(valveTravelMs) || 15000, 45000)),
      actuationMode: actuationMode === 'momentary' ? 'momentary' : 'maintained',
      relayCloseOn: relayCloseOn !== false,
    });

    await shellyManager.saveDevice(finalDeviceId, {
      name: finalName,
      location: finalLocation,
      propertyId,
      type: 'relay_controller',
      deviceType: 'shelly_relay_gen4',
      model: info.model || 'Shelly 1 Gen4',
      mac: info.mac,
      firmware: info.firmware,
      connectionType: 'wifi',
      capabilities: ['relay', 'water_shutoff'],
      valveState: defaultValveState,
      pulseDurationMs: Math.max(250, Math.min(Number(pulseDurationMs) || 20000, 60000)),
      valveTravelMs: Math.max(5000, Math.min(Number(valveTravelMs) || 15000, 45000)),
      actuationMode: actuationMode === 'momentary' ? 'momentary' : 'maintained',
      relayCloseOn: relayCloseOn !== false,
      clearTombstone: true,
    });

    // Best-effort cloud hooks while still on AP. Never block WiFi join on this.
    let cloudConnectivity = null;
    try {
      cloudConnectivity = await configureRelayCloudConnectivity(apIp, finalDeviceId, {
        webhookBaseUrl: getShellyWebhookUrl(req),
        websocketUrl: getShellyWebSocketUrl(req),
        timeoutMs: 8000,
      });
    } catch (error) {
      console.warn('[Shelly Relay AP] Cloud connectivity skipped:', error.message);
    }

    try {
      await shellyLocalApi.configureWifi(apIp, wifiSsid, wifiPassword || '', 30000);
      console.log('   ✓ WiFi configured');
    } catch (error) {
      // Shelly often drops the AP connection immediately after accepting Wifi.SetConfig.
      // Treat timeout/network errors as success if we already persisted the device.
      console.warn('[Shelly Relay AP] WiFi RPC ended after handoff (usually expected):', error.message);
    }

    let localShutoffSync = null;
    if (propertyId) {
      localShutoffSync = await syncPropertyLocalShutoff(propertyId, {
        cloudWebhookUrl: getShellyWebhookUrl(req),
      }).catch((error) => ({
        ok: false,
        error: error.message,
      }));
    }

    res.json({
      success: true,
      deviceId: finalDeviceId,
      model: info.model || 'Shelly 1 Gen4',
      mac: info.mac || '',
      cloudConnectivity,
      localShutoffUrl: buildLocalRelayCloseUrl(finalDeviceId, {
        relayCloseOn: relayCloseOn !== false,
        actuationMode: actuationMode === 'momentary' ? 'momentary' : 'maintained',
      }),
      localShutoffSync,
      message: 'Shelly 1 relay saved and WiFi credentials sent. Switch back to your normal WiFi, then Scan Network once to capture its HouseYield-IoT IP.',
    });
  } catch (error) {
    console.error('Relay AP configure error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/setup/ap-configure-ht
 * Configure H&T Gen3 from AP mode — sends WiFi credentials, sets webhook, registers device
 */
router.post('/setup/ap-configure-ht', async (req, res) => {
  try {
    const { wifiSsid, wifiPassword, deviceName, location, propertyId, networkType } = req.body;

    if (!wifiSsid) {
      return res.status(400).json({ error: 'WiFi SSID is required' });
    }
    if (networkType !== 'public' && !wifiPassword) {
      return res.status(400).json({ error: 'WiFi password required for private networks' });
    }

    const apIp = '192.168.33.1';
    console.log(`🌡️ Configuring H&T Gen3 for ${networkType || 'private'} network: ${wifiSsid}`);

    // 1. Get device info from AP
    const info = await shellyLocalApi.getDeviceInfo(apIp);
    console.log(`   Device: ${info.id} (${info.model || 'H&T Gen3'})`);

    // 2. Set WiFi credentials
    await shellyLocalApi.configureWifi(apIp, wifiSsid, wifiPassword || '');
    console.log('   ✓ WiFi configured');

    // 3. Set device name if provided
    if (deviceName) {
      try {
        await shellyLocalApi.setDeviceName(apIp, deviceName);
        console.log('   ✓ Name set');
      } catch (e) {
        console.log('   ⚠ Name set skipped:', e.message);
      }
    }

    // 4. Configure Firebase webhooks for H&T events (temperature + humidity)
    const webhookUrl = requireShellyWebhookUrl(req);
    const deviceId = info.id || `shellyhtg3-${(info.mac || '').replace(/:/g, '').toLowerCase()}`;
    try {
      const webhookResults = await shellyLocalApi.configureHTWebhooks(apIp, webhookUrl, deviceId);
      console.log('   ✓ H&T webhooks configured:', webhookResults);
    } catch (e) {
      console.log('   ⚠ Webhook config skipped (device may not support it in AP mode):', e.message);
    }

    // 5. Register in H&T service
    const htService = shellyManager.getHTService();
    await htService.registerSensor({
      deviceId,
      name: deviceName || `H&T Sensor - ${location || 'Unknown'}`,
      location: location || 'Unknown',
      propertyId,
      connectionType: 'wifi',
    });

    // 6. Save to Firestore
    try {
      await shellyManager.saveDevice(deviceId, {
        name: deviceName || `H&T Sensor - ${location || 'Unknown'}`,
        model: info.model || 'Shelly H&T Gen3',
        mac: info.mac || '',
        location,
        propertyId,
        type: 'ht',
        connectionType: 'wifi',
      });
    } catch (e) {
      console.log('   ⚠ Firestore save skipped:', e.message);
    }

    res.json({
      success: true,
      deviceId,
      model: info.model || 'Shelly H&T Gen3',
      mac: info.mac || '',
      message: 'H&T sensor configured! It will reboot and connect to your WiFi.',
    });
  } catch (error) {
    console.error('H&T AP configure error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/shelly/setup/configure-ht-webhook
 * Configure an already-networked H&T Gen3 sensor to push temperature & humidity
 * webhooks directly to the Firebase Cloud Function.
 * You must be on the same network as the sensor to call this.
 * After this one-time setup, the sensor pushes to Firebase from ANY network.
 */
router.post('/setup/configure-ht-webhook', async (req, res) => {
  try {
    const { deviceIp, deviceId, deviceName, location, propertyId } = req.body;

    if (!deviceIp) {
      return res.status(400).json({
        success: false,
        error: 'deviceIp is required. You must be on the same network as the H&T sensor.'
      });
    }

    console.log(`🌡️ Configuring H&T webhooks for device at ${deviceIp}`);

    const firebaseWebhookUrl = requireShellyWebhookUrl(req);

    // Get device info
    let info;
    try {
      info = await shellyLocalApi.getDeviceInfo(deviceIp);
      console.log(`   Found device: ${info.id} (${info.model || 'H&T Gen3'})`);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: `Cannot reach device at ${deviceIp}. Make sure you're on the same network and the sensor is awake (press the button on the sensor to wake it).`,
      });
    }

    const finalDeviceId = deviceId || info.id;

    // Configure H&T-specific webhooks (temperature.change + humidity.change
    // + temperature.measurement + humidity.measurement for periodic data)
    const webhookResults = await shellyLocalApi.configureHTWebhooks(deviceIp, firebaseWebhookUrl, finalDeviceId);
    console.log('   Webhook results:', webhookResults);

    // Set report thresholds — this is the KEY setting for battery devices.
    // Without this, the sensor uses defaults (1.0°C / 5.0%) which may be
    // too coarse for your use case. Lower thresholds = more frequent wake-ups.
    let thresholdResults = null;
    try {
      const tempThr = req.body.tempThreshold !== undefined ? parseFloat(req.body.tempThreshold) : 0.5;
      const humThr = req.body.humidityThreshold !== undefined ? parseFloat(req.body.humidityThreshold) : 2.0;
      thresholdResults = await shellyLocalApi.configureHTThresholds(deviceIp, tempThr, humThr);
      console.log('   Threshold results:', thresholdResults);
    } catch (e) {
      console.log('   ⚠ Threshold config failed:', e.message);
    }

    // Verify webhooks were created
    let verifiedHooks = [];
    try {
      const hookList = await shellyLocalApi.rpc(deviceIp, 'Webhook.List');
      verifiedHooks = hookList.hooks || [];
      console.log(`   Verified ${verifiedHooks.length} webhook(s) on device`);
    } catch (e) {
      console.log('   Could not verify webhooks');
    }

    // Set device name if provided
    if (deviceName) {
      try {
        await shellyLocalApi.setDeviceName(deviceIp, deviceName);
      } catch (e) {}
    }

    // Register in H&T service
    try {
      const htService = shellyManager.getHTService();
      await htService.registerSensor({
        deviceId: finalDeviceId,
        name: deviceName || `H&T Sensor - ${location || 'Unknown'}`,
        location: location || 'Unknown',
        propertyId,
        connectionType: 'wifi',
        ip: deviceIp,
        webhookUrl: firebaseWebhookUrl,
      });
    } catch (e) {
      console.log('   H&T service registration skipped:', e.message);
    }

    // Save to Firestore
    try {
      await shellyManager.saveDevice(finalDeviceId, {
        name: deviceName || `H&T Sensor - ${location || 'Unknown'}`,
        model: info.model || 'Shelly H&T Gen3',
        mac: info.mac || '',
        ip: deviceIp,
        location,
        propertyId,
        type: 'ht',
        connectionType: 'wifi',
        webhookUrl: firebaseWebhookUrl,
        webhooksConfigured: true,
      });
    } catch (e) {
      console.log('   Firestore save skipped:', e.message);
    }

    // Register device in Firebase Cloud Function
    try {
      const registerUrl = new URL(firebaseWebhookUrl);
      registerUrl.searchParams.set('action', 'register');
      if (process.env.SHELLY_WEBHOOK_SECRET) {
        registerUrl.searchParams.set('secret', process.env.SHELLY_WEBHOOK_SECRET);
      }
      await fetch(registerUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'register',
          deviceId: finalDeviceId,
          name: deviceName || `H&T Sensor`,
          location: location || 'Unknown',
          ip: deviceIp,
          model: info.model || 'Shelly H&T Gen3',
          mac: info.mac || '',
          propertyId,
        }),
      });
    } catch (e) {
      console.log('   Firebase registration skipped:', e.message);
    }

    res.json({
      success: true,
      deviceId: finalDeviceId,
      model: info.model || 'Shelly H&T Gen3',
      mac: info.mac || '',
      webhooks: webhookResults,
      thresholds: thresholdResults,
      verifiedHooks: verifiedHooks.map(h => ({ id: h.id, event: h.event, name: h.name, enabled: h.enable })),
      message: 'H&T webhooks + thresholds configured! The sensor will wake up and push data when temp/humidity changes exceed the configured thresholds.',
    });
  } catch (error) {
    console.error('H&T webhook configure error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/setup/configure-ht-thresholds
 * Set wake-up sensitivity thresholds for H&T sensors on battery power.
 * 
 * The sensor internally measures every ~60s. If the change since the last
 * REPORTED value exceeds the threshold, it wakes WiFi, fires the webhook,
 * then goes back to sleep. Lower thresholds = more reports = more battery use.
 * 
 * Also returns the current config so you can see what was set.
 */
router.post('/setup/configure-ht-thresholds', async (req, res) => {
  try {
    const { deviceIp, tempThreshold, humidityThreshold } = req.body;

    if (!deviceIp) {
      return res.status(400).json({
        success: false,
        error: 'deviceIp is required. You must be on the same network and the sensor must be awake (press button).'
      });
    }

    // Validate ranges per Shelly docs
    const t = tempThreshold !== undefined ? parseFloat(tempThreshold) : 0.5;
    const h = humidityThreshold !== undefined ? parseFloat(humidityThreshold) : 2.0;

    if (t < 0.5 || t > 5.0) {
      return res.status(400).json({
        success: false,
        error: `tempThreshold must be between 0.5 and 5.0°C (got ${t})`
      });
    }
    if (h < 1.0 || h > 20.0) {
      return res.status(400).json({
        success: false,
        error: `humidityThreshold must be between 1.0 and 20.0% (got ${h})`
      });
    }

    console.log(`🌡️ Setting H&T thresholds at ${deviceIp}: temp=${t}°C, humidity=${h}%`);

    const thresholdResults = await shellyLocalApi.configureHTThresholds(deviceIp, t, h);

    // Read back config to confirm
    let currentConfig = null;
    try {
      currentConfig = await shellyLocalApi.getHTConfig(deviceIp);
    } catch (e) {
      console.log('   Could not read back config:', e.message);
    }

    res.json({
      success: true,
      thresholds: thresholdResults,
      currentConfig,
      message: `Thresholds set to ${t}°C / ${h}%. Sensor will wake and report when changes exceed these values.`
    });
  } catch (error) {
    console.error('H&T threshold config error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/setup/ht-config/:ip
 * Read current threshold configuration from an H&T sensor.
 * Sensor must be awake (press button first).
 */
router.get('/setup/ht-config/:ip', async (req, res) => {
  try {
    const config = await shellyLocalApi.getHTConfig(req.params.ip);
    const status = await shellyLocalApi.getStatus(req.params.ip);
    const hooks = await shellyLocalApi.rpc(req.params.ip, 'Webhook.List').catch(() => ({ hooks: [] }));

    res.json({
      success: true,
      config,
      currentReadings: {
        temperature: status['temperature:0'] || null,
        humidity: status['humidity:0'] || null,
        battery: status['devicepower:0']?.battery || null,
      },
      webhooks: (hooks.hooks || []).map(h => ({
        id: h.id, event: h.event, name: h.name, enabled: h.enable,
        urls: h.urls
      })),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Is the sensor awake? Press the button on the device and try again within 10 seconds.'
    });
  }
});

/**
 * POST /api/shelly/ht/register
 * Register a new H&T Gen3 sensor
 */
router.post('/ht/register', async (req, res) => {
  try {
    const { deviceId, propertyId, location, bleAddress, ip, name } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'deviceId is required' });
    }

    const htService = shellyManager.getHTService();
    const result = await htService.registerSensor({
      deviceId, propertyId, location, bleAddress, ip, name,
    });
    
    res.json({ success: true, sensor: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/ht/register-via-gateway
 * Register an H&T sensor discovered through the BLU Gateway (BLE)
 * No explicit BTHome pairing needed — the gateway script passively scans.
 */
router.post('/ht/register-via-gateway', async (req, res) => {
  try {
    const { bleAddress, propertyId, location, name } = req.body;
    
    if (!bleAddress) {
      return res.status(400).json({ success: false, error: 'bleAddress is required' });
    }

    const gateway = shellyManager.getBluGateway();
    const deviceId = `shellyhtg3-${bleAddress.replace(/:/g, '').toLowerCase()}`;

    // Register in our system
    const htService = shellyManager.getHTService();
    const sensorResult = await htService.registerSensor({
      deviceId,
      bleAddress,
      propertyId,
      location,
      name: name || `H&T Sensor - ${location || bleAddress}`,
      connectionType: 'bluetooth',
      gatewayIp: gateway.gatewayIp,
      gatewayId: gateway.gatewayId,
    });

    res.json({
      success: true,
      deviceId,
      sensor: sensorResult,
      message: 'Sensor registered. Data will flow automatically via BLE scanner.',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/flood/register-via-gateway
 * Register a Flood Gen4 sensor discovered through the BLU Gateway (BLE)
 * No explicit pairing needed — the gateway script passively scans.
 */
router.post('/flood/register-via-gateway', async (req, res) => {
  try {
    const { bleAddress, propertyId, location, name } = req.body;

    if (!bleAddress) {
      return res.status(400).json({ success: false, error: 'bleAddress is required' });
    }

    const gateway = shellyManager.getBluGateway();
    const deviceId = `shellyfloodg4-${bleAddress.replace(/:/g, '').toLowerCase()}`;

    // Save to Firestore
    await shellyManager.saveDevice(deviceId, {
      type: 'shelly_flood_gen4',
      bleAddress,
      propertyId,
      location,
      name: name || `Flood Sensor - ${location || bleAddress}`,
      connectionType: 'bluetooth',
      gatewayIp: gateway.gatewayIp,
      gatewayId: gateway.gatewayId,
    });

    res.json({
      success: true,
      deviceId,
      message: 'Flood sensor registered. Data will flow automatically via BLE scanner.',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/ht/poll
 * Force an immediate poll of all H&T sensors
 */
router.post('/ht/poll', async (req, res) => {
  try {
    const htService = shellyManager.getHTService();
    const results = await htService.pollAllSensors();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/shelly/ht/webhook
 * Receive webhook events from H&T sensors
 */
router.post('/ht/webhook', async (req, res) => {
  try {
    const htService = shellyManager.getHTService();
    await htService.handleWebhook(req.body);
    res.json({ success: true });
  } catch (error) {
    console.error('H&T webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/shelly/ht/readings/:deviceId
 * Get historical readings for a specific H&T sensor
 */
router.get('/ht/readings/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { hours = 24, limit: maxResults = 500 } = req.query;
    
    // Query Firestore for readings
    const admin = (await import('firebase-admin')).default;
    const db = admin.firestore();
    const cutoff = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    
    const snapshot = await db.collection('sensor_readings')
      .where('deviceId', '==', deviceId)
      .where('timestamp', '>=', cutoff)
      .orderBy('timestamp', 'desc')
      .limit(parseInt(maxResults))
      .get();
    
    const readings = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp,
    }));
    
    res.json({
      success: true,
      deviceId,
      hoursBack: parseInt(hours),
      count: readings.length,
      readings,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

async function resolveFloodTargetDeviceId(requestedDeviceId, propertyId = null) {
  if (requestedDeviceId) {
    return requestedDeviceId;
  }

  const matchesProperty = (device) => {
    if (!propertyId) return true;
    return device.propertyId === propertyId;
  };

  try {
    const cloudDevices = await fetchCloudDevicesHttp();
    const floodDevices = cloudDevices.filter((device) => (
      (device.type === 'flood' || device.deviceType === 'shelly_flood_gen4')
      && matchesProperty(device)
    ));
    if (floodDevices.length === 1) {
      return floodDevices[0].deviceId || floodDevices[0].id;
    }
    if (floodDevices.length > 1) {
      throw new Error('Multiple flood sensors found. Pass deviceId in the request body.');
    }
  } catch (error) {
    if (error.message.includes('Multiple flood sensors')) {
      throw error;
    }
    console.warn('[Shelly Flood] Cloud device lookup failed during reconfigure:', error.message);
  }

  const lookupDbs = [];
  try { lookupDbs.push(getFirestore()); } catch { /* ignore */ }
  try { lookupDbs.push(getIotFirestore()); } catch { /* ignore */ }

  const floodDocs = [];
  for (const db of lookupDbs) {
    try {
      const snapshot = await db.collection('shelly_devices').where('type', '==', 'flood').get();
      snapshot.docs.forEach((doc) => {
        const data = doc.data() || {};
        if (matchesProperty(data)) {
          floodDocs.push({ id: doc.id, ...data });
        }
      });
    } catch (error) {
      console.warn('[Shelly Flood] Firestore flood lookup failed:', error.message);
    }
  }

  const uniqueDevices = Array.from(
    new Map(floodDocs.map((device) => [device.deviceId || device.id, device])).values()
  );

  if (uniqueDevices.length === 1) {
    return uniqueDevices[0].deviceId || uniqueDevices[0].id;
  }
  if (uniqueDevices.length > 1) {
    throw new Error('Multiple flood sensors found. Pass deviceId in the request body.');
  }

  throw new Error('No flood sensor registered yet. Register a flood sensor before reconfiguring webhooks.');
}

/**
 * POST /api/shelly/flood/reconfigure-webhooks
 * Reconfigure webhooks on a flood sensor after WiFi network change.
 * Can auto-discover the sensor or use a provided IP.
 * The user must press the button on the sensor to wake it before calling this.
 */
router.post('/flood/reconfigure-webhooks', async (req, res) => {
  try {
    const { deviceId, deviceIp, propertyId } = req.body;
    let targetDeviceId;
    try {
      targetDeviceId = await resolveFloodTargetDeviceId(deviceId, propertyId || null);
    } catch (error) {
      return res.status(error.message.includes('No flood sensor') ? 404 : 400).json({
        success: false,
        error: error.message,
      });
    }
    const firebaseWebhookUrl = requireShellyWebhookUrl(req);

    let sensorIp = deviceIp;
    let info;

    // Step 1: Try mDNS hostname first (fastest)
    if (!sensorIp) {
      const mdnsHost = `${targetDeviceId}.local`;
      console.log(`🔍 Trying mDNS: ${mdnsHost}`);
      try {
        info = await shellyLocalApi.getDeviceInfo(mdnsHost);
        sensorIp = mdnsHost;
        console.log(`✅ Found sensor via mDNS at ${mdnsHost}`);
      } catch (e) {
        console.log('   mDNS not responding, scanning network...');
      }
    }

    // Step 2: Network scan if mDNS failed
    if (!sensorIp) {
      console.log(`🔍 Scanning network for ${targetDeviceId}...`);
      sensorIp = await shellyLocalApi.findDeviceOnNetwork(targetDeviceId);
    }

    if (!sensorIp) {
      return res.status(404).json({
        success: false,
        error: 'Flood sensor not found on the network. Make sure: 1) The sensor is on the same WiFi network. 2) Press the button on the sensor to wake it (it sleeps to save battery). 3) Try again within 30 seconds of pressing the button.',
        tip: 'Battery-powered flood sensors sleep between events. Press the button to wake it, then retry immediately.'
      });
    }

    // Step 3: Get device info if not already fetched
    if (!info) {
      try {
        info = await shellyLocalApi.getDeviceInfo(sensorIp);
        console.log(`📱 Connected to ${info.id} (${info.model}) at ${sensorIp}`);
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: `Found sensor IP ${sensorIp} but cannot communicate. It may have gone back to sleep. Press the button and retry immediately.`
        });
      }
    }

    // Step 4: Get current WiFi info
    let wifiInfo = {};
    try {
      const status = await shellyLocalApi.rpc(sensorIp, 'Wifi.GetStatus');
      wifiInfo = { ssid: status.ssid, ip: status.sta_ip, rssi: status.rssi };
      console.log(`   WiFi: ${status.ssid} (${status.sta_ip}, RSSI: ${status.rssi})`);
    } catch (e) {
      console.log('   Could not get WiFi status');
    }

    // Step 5: Delete existing webhooks (clean slate)
    try {
      const hooks = await shellyLocalApi.rpc(sensorIp, 'Webhook.List');
      if (hooks.hooks && hooks.hooks.length > 0) {
        for (const hook of hooks.hooks) {
          await shellyLocalApi.rpc(sensorIp, 'Webhook.Delete', { id: hook.id });
          console.log(`   Deleted old webhook: ${hook.id} (${hook.name})`);
        }
      }
    } catch (e) {
      console.log('   No existing webhooks to delete');
    }

    // Step 6: Create flood alarm webhook -> Firebase Cloud Function
    const finalDeviceId = info.id || targetDeviceId;
    const floodWebhookUrl = `${firebaseWebhookUrl}?device_id=${finalDeviceId}&event=flood.alarm`;
    const relayTargets = propertyId ? await listRelayShutoffTargetsForProperty(propertyId) : [];
    const configuredHooks = await configureFloodShutoffWebhooks(sensorIp, finalDeviceId, {
      cloudWebhookUrl: firebaseWebhookUrl,
      relayTargets,
    });
    console.log(`   ✅ Webhooks configured (${configuredHooks.length} hook(s))`);

    // Step 8: Verify final webhook config
    const finalHooks = await shellyLocalApi.rpc(sensorIp, 'Webhook.List');
    console.log(`   Webhooks configured: ${(finalHooks.hooks || []).length}`);

    // Step 9: Update IoT Firestore with correct data
    const db = getIotFirestore();
    const resolvedIp = wifiInfo.ip || sensorIp;
    const existingFloodDoc = await resolveFloodSensorDoc(db, finalDeviceId);
    const existingFloodData = existingFloodDoc?.snapshot?.data?.() || {};

    await db.collection('shelly_devices').doc(finalDeviceId).set({
      deviceId: finalDeviceId,
      name: existingFloodData.name || info.name || finalDeviceId,
      location: existingFloodData.location || null,
      propertyId: propertyId || existingFloodData.propertyId || null,
      ownerId: existingFloodData.ownerId || null,
      manufacturer: existingFloodData.manufacturer || 'Shelly',
      model: existingFloodData.model || info.model || 'Flood Gen4',
      ip: resolvedIp,
      localIp: resolvedIp,
      webhookUrl: floodWebhookUrl,
      type: 'flood',
      deviceType: 'shelly_flood_gen4',
      connectionType: 'wifi',
      status: 'active',
      isFlooded: false,
      hasActiveAlert: false,
      lastSeen: new Date(),
      updatedAt: new Date(),
      wifiSsid: wifiInfo.ssid || null,
      wifiRssi: wifiInfo.rssi || null,
      capabilities: ['flood', 'temperature', 'battery'],
    }, { merge: true });

    if (existingFloodDoc?.docRef?.id && existingFloodDoc.docRef.id !== finalDeviceId) {
      await existingFloodDoc.docRef.set({
        deviceId: finalDeviceId,
        type: 'flood',
        deviceType: 'shelly_flood_gen4',
        connectionType: 'wifi',
        propertyId: propertyId || existingFloodData.propertyId || null,
        ip: resolvedIp,
        localIp: resolvedIp,
        webhookUrl: floodWebhookUrl,
        updatedAt: new Date(),
      }, { merge: true });
    }
    console.log(`   ✅ Firestore updated: IP=${resolvedIp}, type=flood`);

    res.json({
      success: true,
      deviceId: finalDeviceId,
      ip: resolvedIp,
      wifi: wifiInfo,
      webhooks: finalHooks.hooks || [],
      message: `Flood sensor ${finalDeviceId} is now configured! Flood alerts will be sent to Firebase from any network.`
    });

  } catch (error) {
    console.error('Flood webhook reconfiguration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/shelly/device/:deviceId
 * Update a device's name, location, property assignment, or twin room.
 * Used by the frontend to let users rename auto-discovered BLE sensors and to
 * drag device pins into the right room on the cutaway property twin.
 */
router.patch('/device/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { name, location, propertyId, valveTravelMs, twinRoomId, twinUnitId } = req.body;

    if (
      !name
      && !location
      && !propertyId
      && valveTravelMs == null
      && twinRoomId === undefined
      && twinUnitId === undefined
    ) {
      return res.status(400).json({ success: false, error: 'At least one of name, location, propertyId, valveTravelMs, twinRoomId, or twinUnitId is required' });
    }

    const db = getIotFirestore();
    const docRef = db.collection('shelly_devices').doc(deviceId);

    const updateData = { deviceId };
    if (name) updateData.name = name;
    if (location) updateData.location = location;
    if (propertyId) updateData.propertyId = propertyId;
    if (req.body.ownerId) updateData.ownerId = req.body.ownerId;
    if (valveTravelMs != null) {
      updateData.valveTravelMs = Math.max(5000, Math.min(Number(valveTravelMs) || 15000, 45000));
    }
    // Null clears the assignment and hands the pin back to keyword inference.
    if (twinRoomId !== undefined) {
      updateData.twinRoomId = twinRoomId ? String(twinRoomId).slice(0, 64) : null;
    }
    /*
     * Which apartment the device is in, for multifamily twins.
     *
     * Stored alongside `twinRoomId` rather than replacing it: in a building the
     * unit is what identifies the space, and the room within that unit is a
     * separate, finer question. A device can legitimately have one, both, or
     * neither, so they are independent fields.
     */
    if (twinUnitId !== undefined) {
      updateData.twinUnitId = twinUnitId ? String(twinUnitId).slice(0, 64) : null;
    }
    updateData.updatedAt = new Date().toISOString();

    await docRef.set(updateData, { merge: true });
    shellyManager.updateDeviceData(deviceId, updateData);

    res.json({ success: true, deviceId, updated: updateData });
  } catch (error) {
    console.error('Device update error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
