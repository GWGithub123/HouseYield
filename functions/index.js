/**
 * Firebase Cloud Functions for Shelly IoT Sensor Integration
 * Version: 2.0.0 - Added device registration support
 * 
 * This provides a 24/7 webhook endpoint that Shelly devices can POST to.
 * Data is stored in Firestore and triggers real-time updates to all clients.
 * 
 * Architecture:
 * [Shelly Sensor] → HTTP POST → [Cloud Function] → [Firestore] → [Frontend Real-time Listener]
 *                                      ↓
 *                               [FCM Push Notification] → [Mobile App]
 */

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const https = require('https');

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();

function hasValidShellyWebhookSecret(req, query = {}, data = {}) {
  const expected = process.env.SHELLY_WEBHOOK_SECRET || '';
  if (!expected) {
    return true;
  }

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
  if (Array.isArray(capabilities)) {
    return capabilities;
  }
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

/**
 * Main webhook endpoint for Shelly devices
 * URL: https://us-central1-YOUR-PROJECT.cloudfunctions.net/shellyWebhook
 * 
 * Accepts both:
 * 1. Direct webhooks from Shelly devices (flood.alarm, etc.)
 * 2. Outbound WebSocket-style NotifyStatus/NotifyEvent messages
 */
exports.shellyWebhook = onRequest({
  cors: true,
  maxInstances: 10,
  invoker: 'public',
}, async (req, res) => {
  console.log('🚨 Shelly webhook received');
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));
  console.log('Query:', JSON.stringify(req.query));

  try {
    const data = req.body || {};
    const query = req.query || {};

    // Dashboard read API for the frontend (IoT Firestore lives in this project).
    if (req.method === 'GET') {
      if (query.action === 'alerts') {
        return await listAlertsForDashboard(res);
      }
      if (query.action === 'devices') {
        return await listDevicesForDashboard(res);
      }
      if (query.action === 'readings') {
        return await listReadingsForDashboard(query, res);
      }
    }

    if ((req.method === 'POST' || req.method === 'PATCH') && query.action === 'acknowledge') {
      return await acknowledgeAlertForDashboard(query.alertId || data.alertId, res);
    }

    if (req.method === 'POST' && query.action === 'relayCommand') {
      return await relayCommandForDashboard(data, res);
    }

    if ((req.method === 'POST' || req.method === 'DELETE') && query.action === 'deleteDevice') {
      return await deleteDeviceForDashboard(query, res);
    }
    
    // Handle different webhook formats
    
    // Handle device registration from setup wizard
    if (query.action === 'register' || data.action === 'register') {
      if (!hasValidShellyWebhookSecret(req, query, data)) {
        return res.status(403).json({ success: false, error: 'Invalid webhook secret' });
      }
      return await handleDeviceRegistration(data, res);
    }
    
    // Extract device ID from various sources
    let deviceId = data.src || data.device_id || query.device_id || query.src || data.deviceId;
    
    // Handle Shelly's RPC-style messages (NotifyStatus, NotifyEvent, NotifyFullStatus)
    if (data.method === 'NotifyStatus' || data.method === 'NotifyFullStatus') {
      return await handleStatusUpdate(deviceId, data, res);
    }
    
    if (data.method === 'NotifyEvent') {
      return await handleEvent(deviceId, data, res);
    }
    
    // Handle direct webhook (flood.alarm, etc.)
    if (query.event || data.event) {
      return await handleDirectWebhook(deviceId, query, data, res);
    }

    // Legacy bare-URL flood webhooks from older setup flows that only stored the
    // base Firebase URL without ?device_id=...&event=flood.alarm query params.
    const legacyFloodDeviceId = await resolveLegacyBareFloodWebhookDevice(deviceId);
    if (legacyFloodDeviceId) {
      console.log(`📣 Legacy bare flood webhook mapped to ${legacyFloodDeviceId}`);
      return await handleDirectWebhook(
        legacyFloodDeviceId,
        { ...query, event: 'flood.alarm' },
        data,
        res,
      );
    }
    
    // Acknowledge unknown format
    console.log('Unknown webhook format, storing raw data');
    await storeRawWebhook(deviceId, { query, body: data });
    
    res.status(200).json({ success: true, message: 'Webhook received' });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Handle device registration from setup wizard
 */
async function handleDeviceRegistration(data, res) {
  try {
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
    } = data;
    
    if (!deviceId) {
      return res.status(400).json({ success: false, error: 'Device ID required' });
    }
    
    console.log(`📝 Registering device: ${deviceId} (model: ${model}, type: ${type})`);
    
    // Derive device type from model string if not explicitly provided
    const deviceType = normalizeRegisteredDeviceType(type || explicitDeviceType, model, deviceId);

    // Check if this is a re-registration (reconnection)
    const existingDoc = await db.collection('shelly_devices').doc(deviceId).get();
    const isReconnection = existingDoc.exists;
    
    if (isReconnection) {
      const existing = existingDoc.data();
      console.log(`   🔄 Re-registering existing device (was at IP: ${existing.ip || 'unknown'})`);
    }

    // Build update data — don't overwrite user-configured fields on re-registration
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

    // Only set these on initial registration, not reconnection
    if (!isReconnection) {
      updateData.registeredAt = FieldValue.serverTimestamp();
      updateData.isFlooded = false;
      updateData.propertyId = propertyId || null;
      updateData.location = location || 'Unknown';
    } else {
      // On reconnection, update location/propertyId only if explicitly provided
      if (location) updateData.location = location;
      if (propertyId) updateData.propertyId = propertyId;
      updateData.reconnectedAt = FieldValue.serverTimestamp();
      updateData.previousIp = existingDoc.data().ip || null;
    }

    // Always set type if we have one — fixes the 'ht' mistype issue
    if (deviceType) {
      updateData.type = deviceType;
    }
    if (connectionType) {
      updateData.connectionType = connectionType;
    }
    if (capabilities) {
      updateData.capabilities = normalizeCloudDeviceCapabilities(deviceType, capabilities);
    }
    if (deviceType === 'relay_controller') {
      updateData.valveState = valveState || (isReconnection ? undefined : 'unknown');
      updateData.pulseDurationMs = pulseDurationMs || (isReconnection ? undefined : 20000);
      updateData.valveTravelMs = valveTravelMs || (isReconnection ? undefined : 15000);
      updateData.actuationMode = actuationMode === 'momentary' ? 'momentary' : (isReconnection ? undefined : 'maintained');
      updateData.relayCloseOn = relayCloseOn === false ? false : (isReconnection ? undefined : true);
      updateData.relayOutputOn = relayOutputOn === true;
    }

    // Remove undefined values to prevent Firestore errors
    const cleanData = Object.fromEntries(
      Object.entries(updateData).filter(([_, v]) => v !== undefined)
    );
    
    // Store device in Firestore
    await db.collection('shelly_devices').doc(deviceId).set(cleanData, { merge: true });
    
    console.log(`✅ Device ${deviceId} ${isReconnection ? 'reconnected' : 'registered'} successfully (type: ${deviceType || 'unknown'})`);
    
    res.status(200).json({ 
      success: true, 
      message: isReconnection ? 'Device reconnected' : 'Device registered',
      deviceId,
      type: deviceType,
      isReconnection
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Handle NotifyStatus / NotifyFullStatus messages
 */
async function handleStatusUpdate(deviceId, data, res) {
  const params = data.params || {};
  const timestamp = params.ts ? new Date(params.ts * 1000) : new Date();
  
  // Parse flood sensor data
  const flood = params['flood:0'] || {};
  const temp = params['temperature:0'] || {};
  const humidity = params['humidity:0'] || {};
  const power = params['devicepower:0'] || {};
  const wifi = params.wifi || {};
  const sys = params.sys || {};
  
  // Check for flood alarm - Gen4 uses "alarm" field
  const isFlooded = flood.alarm === true || flood.flood === true;
  
  console.log(`📊 Status update from ${deviceId}: alarm=${isFlooded}, temp=${temp.tF}°F, humidity=${humidity.rh}%`);
  
  // Prepare sensor reading
  const reading = {
    deviceId,
    timestamp: FieldValue.serverTimestamp(),
    localTimestamp: timestamp.toISOString(),
    type: 'status_update',
    
    // Flood status
    isFlooded,
    alarm: flood.alarm || false,
    mute: flood.mute || false,
    
    // Temperature (save as both field names for compatibility)
    temperature: temp.tC || null,
    temperatureC: temp.tC || null,
    temperatureF: temp.tF || null,
    
    // Humidity
    humidity: humidity.rh || null,
    
    // Battery
    batteryPercent: power.battery?.percent || null,
    batteryVoltage: power.battery?.V || null,
    
    // Connectivity
    wifiRssi: wifi.rssi || null,
    wifiSsid: wifi.ssid || null,
    wifiIp: wifi.sta_ip || null,
    
    // System
    uptime: sys.uptime || null,
    mac: sys.mac || null,
    
    // Raw data for debugging
    rawParams: params
  };
  
  // Store reading in Firestore
  await db.collection('sensor_readings').add(reading);
  
  // Update sensor document with latest status
  const deviceUpdate = {
    deviceId,
    lastReading: reading,
    lastSeen: FieldValue.serverTimestamp(),
    status: 'online',
    isFlooded,
    flood: isFlooded,
    batteryPercent: power.battery?.percent || null,
    wifiRssi: wifi.rssi || null,
    temperature: temp.tC || null,
    temperatureF: temp.tF || null,
  };
  // Add humidity if present
  if (humidity.rh != null) {
    deviceUpdate.humidity = humidity.rh;
    deviceUpdate['lastReading.humidity:0'] = { rh: humidity.rh };
  }
  await db.collection('shelly_devices').doc(deviceId).set(deviceUpdate, { merge: true });
  
  // If flood detected, create alert and send notification
  if (isFlooded) {
    console.log(`🚨 CREATING FLOOD ALERT for ${deviceId}`);
    await createFloodAlert(deviceId, reading);
  } else {
    console.log(`✅ Status OK - no flood detected for ${deviceId}`);
  }
  
  res.status(200).json({ success: true, isFlooded });
}

/**
 * Handle NotifyEvent messages (alarm triggers, button presses, etc.)
 */
async function handleEvent(deviceId, data, res) {
  const params = data.params || {};
  const events = params.events || [];
  
  console.log(`⚡ Event from ${deviceId}:`, events);
  
  for (const event of events) {
    // Check for flood alarm event
    if (event.component === 'flood:0' && event.event === 'alarm') {
      await createFloodAlert(deviceId, {
        deviceId,
        timestamp: new Date(event.ts * 1000).toISOString(),
        isFlooded: true,
        source: 'event'
      });
    }
    
    // Store all events
    await db.collection('sensor_events').add({
      deviceId,
      timestamp: FieldValue.serverTimestamp(),
      eventTimestamp: event.ts ? new Date(event.ts * 1000) : null,
      component: event.component,
      event: event.event,
      rawEvent: event
    });
  }
  
  res.status(200).json({ success: true, eventsProcessed: events.length });
}

/**
 * Handle direct webhook (flood.alarm, temperature.change, humidity.change from Webhook.Create)
 */
async function isShellyDeviceDeleted(deviceId) {
  if (!deviceId) return false;
  const snap = await db.collection('shelly_deleted_devices').doc(String(deviceId)).get();
  return snap.exists;
}

async function handleDirectWebhook(deviceId, query, body, res) {
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
  
  console.log(`📣 Direct webhook: ${event} from ${deviceId}`);
  
  if (event === 'flood.alarm') {
    await createFloodAlert(deviceId, {
      deviceId,
      timestamp: new Date().toISOString(),
      isFlooded: true,
      source: 'webhook'
    });
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

    // Local LAN auto-shutoff closes the relay without the command API —
    // stamp lastValveCommand so clients play the travel animation.
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
    console.log(`🔌 Relay status webhook for ${deviceId}: output=${relayOutputOn}, valve=${valveState}`);
  }
  
  // Handle H&T temperature/humidity change events
  if (event === 'temperature.change' || event === 'humidity.change' || event === 'temperature.measurement' || event === 'humidity.measurement' || event === 'temperature_humidity') {
    // Determine the source — BLE gateway sensors use 'ble_gateway' source
    const isBleGateway = (query.source === 'ble_gateway' || body.source === 'ble_gateway' ||
                          body.source === 'ble_gateway_fallback' ||
                          (deviceId && deviceId.startsWith('blu-ht-')));
    const reading = {
      deviceId,
      timestamp: FieldValue.serverTimestamp(),
      type: 'ht_reading',
      source: isBleGateway ? 'ble_gateway' : 'webhook',
    };
    
    // Shelly H&T sends data as URL template variables in query params
    // e.g. ?tC=22.3&tF=72.1 or ?rh=45.2
    // Also check body for other firmware versions
    const tC = parseMaybeNumber(query.tC, body.tC);
    const tF = parseMaybeNumber(query.tF, body.tF);
    const rh = parseMaybeNumber(query.rh, body.rh);
    const battery = parseMaybeNumber(query.battery, body.battery);
    
    if (tC != null) {
      reading.temperatureC = tC;
      reading.temperatureF = tF || (tC * 9/5 + 32);
      reading.temperature = tC;
    } else if (tF != null) {
      reading.temperatureF = tF;
      reading.temperatureC = (tF - 32) * 5/9;
      reading.temperature = reading.temperatureC;
    }
    if (rh != null) {
      reading.humidity = rh;
    }
    if (battery != null) {
      reading.batteryPercent = battery;
    }
    
    // Also check for nested params (some firmware versions)
    const params = body.params || body.status || {};
    const temp = params['temperature:0'] || {};
    const hum = params['humidity:0'] || {};
    const pwr = params['devicepower:0'] || {};
    if (temp.tC != null && reading.temperatureC == null) {
      reading.temperatureC = temp.tC;
      reading.temperatureF = temp.tF || (temp.tC * 9/5 + 32);
      reading.temperature = temp.tC;
    }
    if (hum.rh != null && reading.humidity == null) {
      reading.humidity = hum.rh;
    }
    if (pwr.battery?.percent != null && reading.batteryPercent == null) {
      reading.batteryPercent = pwr.battery.percent;
      reading.batteryVoltage = pwr.battery.V || null;
    }
    
    console.log(`🌡️ H&T webhook: temp=${reading.temperatureC}°C, humidity=${reading.humidity}%, battery=${reading.batteryPercent}%`);
    
    // Only save if we got actual data
    if (reading.temperatureC != null || reading.humidity != null) {
      if (await isShellyDeviceDeleted(deviceId)) {
        console.log(`⏭️ Skipping deleted BLE/H&T device update for ${deviceId}`);
        return res.status(200).json({ success: true, skipped: true, reason: 'device_deleted' });
      }

      const BLE_HISTORY_WRITE_INTERVAL_MS = Math.max(
        60_000,
        Number(process.env.BLE_HISTORY_WRITE_INTERVAL_MS || 60_000),
      );
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
      
      // Update device doc (creates it if first time seeing this device)
      const deviceUpdate = {
        lastSeen: FieldValue.serverTimestamp(),
        status: 'online',
      };
      if (shouldWriteHistory) {
        deviceUpdate.lastHistoryWriteAt = FieldValue.serverTimestamp();
      }
      if (reading.temperatureC != null) {
        deviceUpdate.temperature = reading.temperatureC;
        deviceUpdate.temperatureF = reading.temperatureF;
        deviceUpdate['lastReading.temperature:0'] = {
          tC: reading.temperatureC,
          tF: reading.temperatureF,
        };
      }
      if (reading.humidity != null) {
        deviceUpdate.humidity = reading.humidity;
        deviceUpdate['lastReading.humidity:0'] = { rh: reading.humidity };
      }
      if (reading.batteryPercent != null) {
        deviceUpdate.batteryPercent = reading.batteryPercent;
        deviceUpdate.batteryUpdatedAt = FieldValue.serverTimestamp();
      }
      
      // For BLU H&T sensors (BLE), set device type info so dashboard recognizes them
      if (isBleGateway || (deviceId && deviceId.startsWith('blu-ht-'))) {
        deviceUpdate.type = 'temperature_humidity';
        deviceUpdate.connectionType = 'bluetooth_gateway';
        deviceUpdate.capabilities = ['temperature', 'humidity', 'battery'];
        deviceUpdate.model = deviceUpdate.model || 'Shelly BLU H&T';
      }
      
      await deviceRef.set(deviceUpdate, { merge: true });
      console.log(`✅ H&T reading saved for ${deviceId}${shouldWriteHistory ? '' : ' (live only, history throttled)'}`);

      if (isBleGateway || (deviceId && deviceId.startsWith('blu-ht-'))) {
        await touchBleGatewayForProperty(deviceId);
      }
    }
  }
  
  // Store webhook
  await db.collection('sensor_webhooks').add({
    deviceId,
    timestamp: FieldValue.serverTimestamp(),
    event,
    rawEvent: rawEvent || null,
    query,
    body
  });
  
  res.status(200).json({ success: true, event });
}

/**
 * Keep the BLU Gateway device doc fresh when any of its BLE sensors report.
 */
async function touchBleGatewayForProperty(sensorDeviceId) {
  const sensorDoc = await db.collection('shelly_devices').doc(sensorDeviceId).get();
  const sensor = sensorDoc.exists ? (sensorDoc.data() || {}) : {};
  const propertyId = sensor.propertyId || null;

  const snapshot = await db.collection('shelly_devices').get();
  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const isGateway = doc.id.includes('blugw')
      || data.type === 'ble_gateway'
      || data.deviceType === 'ble_gateway';
    if (!isGateway) continue;
    if (propertyId && data.propertyId && data.propertyId !== propertyId) continue;

    await doc.ref.set({
      lastSeen: FieldValue.serverTimestamp(),
      status: 'online',
    }, { merge: true });
  }
}

const BLE_STALE_MS = 30 * 60 * 1000;
const BLE_GATEWAY_STALE_MS = 2 * 60 * 60 * 1000;
const OFFLINE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function hasRecentOfflineAlert(deviceId) {
  const snapshot = await db.collection('alerts')
    .where('deviceId', '==', deviceId)
    .limit(20)
    .get();

  const cutoff = Date.now() - OFFLINE_ALERT_COOLDOWN_MS;
  return snapshot.docs.some((docSnap) => {
    const alert = docSnap.data() || {};
    if (alert.type !== 'offline' || alert.acknowledged) return false;
    const timestamp = alert.timestamp?.toDate?.()?.getTime?.() || 0;
    return timestamp >= cutoff;
  });
}

async function createOfflineAlert(deviceId, data, staleMinutes) {
  if (await hasRecentOfflineAlert(deviceId)) return false;

  await db.collection('alerts').add({
    deviceId,
    sensorId: deviceId,
    sensorName: data.name || data.location || deviceId,
    deviceName: data.name || data.location || deviceId,
    location: data.location || null,
    propertyId: data.propertyId || null,
    ownerId: data.ownerId || null,
    type: 'offline',
    severity: 'warning',
    message: `📡 Sensor offline — no readings for ${staleMinutes}+ minutes (${data.name || deviceId})`,
    timestamp: FieldValue.serverTimestamp(),
    acknowledged: false,
  });

  await db.collection('shelly_devices').doc(deviceId).set({ status: 'offline' }, { merge: true });
  return true;
}

/**
 * Alert when BLE sensors or the BLU Gateway stop reporting.
 */
exports.checkStaleBleSensors = onSchedule({
  schedule: 'every 15 minutes',
  timeoutSeconds: 60,
  memory: '256MiB',
}, async () => {
  console.log('🔍 Checking for stale BLE sensors...');
  const now = Date.now();
  const snapshot = await db.collection('shelly_devices').get();
  let staleCount = 0;

  for (const doc of snapshot.docs) {
    const id = doc.id;
    const data = doc.data() || {};
    const lastSeen = data.lastSeen?.toDate?.() || null;
    if (!lastSeen) continue;

    const ageMs = now - lastSeen.getTime();
    const isGateway = id.includes('blugw') || data.type === 'ble_gateway' || data.deviceType === 'ble_gateway';
    const isBleSensor = id.startsWith('blu-ht-') || data.connectionType === 'bluetooth_gateway';

    if (!isGateway && !isBleSensor) continue;

    const thresholdMs = isGateway ? BLE_GATEWAY_STALE_MS : BLE_STALE_MS;
    if (ageMs <= thresholdMs) continue;

    const staleMinutes = Math.floor(ageMs / 60000);
    const created = await createOfflineAlert(id, data, staleMinutes);
    if (created) {
      staleCount += 1;
      console.log(`⚠️  Stale BLE device: ${id} (${staleMinutes}m since last reading)`);
    }
  }

  console.log(`🔍 Stale BLE check complete (${staleCount} new alert(s))`);
});

async function resolveLegacyBareFloodWebhookDevice(hintDeviceId) {
  if (hintDeviceId) {
    return hintDeviceId;
  }

  const snap = await db.collection('shelly_devices').where('type', '==', 'flood').get();
  if (snap.empty) {
    return null;
  }

  if (snap.size === 1) {
    return snap.docs[0].id;
  }

  return null;
}

async function listAlertsForDashboard(res) {
  const snapshot = await db.collection('alerts')
    .orderBy('timestamp', 'desc')
    .limit(50)
    .get();

  const alerts = snapshot.docs.map((docSnap) => {
    const alertData = docSnap.data() || {};
    const reading = alertData.reading || {};
    const isFlood = reading.isFlooded || alertData.type === 'flood';

    return {
      id: docSnap.id,
      deviceId: alertData.deviceId || alertData.sensorId || '',
      deviceName: alertData.sensorName || alertData.deviceName || 'Unknown',
      type: alertData.type || (isFlood ? 'flood' : 'info'),
      severity: alertData.severity || (isFlood ? 'critical' : 'info'),
      message: alertData.message || (isFlood
        ? `🚨 FLOOD DETECTED at ${alertData.sensorName || alertData.deviceName || 'sensor'}!`
        : `Alert from ${alertData.sensorName || alertData.deviceName || 'sensor'}`),
      timestamp: alertData.timestamp?.toDate?.()?.toISOString?.() || reading.timestamp || null,
      acknowledged: Boolean(alertData.acknowledged),
      notificationSent: Boolean(alertData.notificationSent),
      tenantNotifiedAt: alertData.tenantNotifiedAt?.toDate?.()?.toISOString?.() || alertData.tenantNotifiedAt || null,
      tenantNotification: alertData.tenantNotification || null,
      data: reading,
      propertyId: alertData.propertyId || null,
      ownerId: alertData.ownerId || null,
      location: alertData.location || null,
    };
  });

  return res.status(200).json({ success: true, count: alerts.length, alerts });
}

async function listDevicesForDashboard(res) {
  const snapshot = await db.collection('shelly_devices').get();
  const devices = snapshot.docs.map((docSnap) => {
    const deviceData = docSnap.data() || {};
    const lastReading = deviceData.lastReading || {};
    const floodData = lastReading['flood:0'] || {};
    const tempData = lastReading['temperature:0'] || {};
    const humidityData = lastReading['humidity:0'] || {};
    const relayData = lastReading['switch:0'] || {};
    const tempC = tempData.tC ?? lastReading.temperatureC ?? deviceData.temperature;
    const tempF = tempC != null ? (tempC * 9 / 5) + 32 : deviceData.temperatureF;
    const humidityValue = humidityData.rh ?? deviceData.humidity ?? lastReading.humidity;
    const isFlooded = floodData.alarm === true || deviceData.isFlooded === true || deviceData.flood === true;
    const normalizedType = deviceData.type === 'ht'
      ? 'temperature_humidity'
      : deviceData.type === 'relay' || deviceData.type === 'relay_controller'
        ? 'relay_controller'
        : (deviceData.type || 'flood');

    return {
      id: docSnap.id,
      deviceId: deviceData.deviceId || docSnap.id,
      name: deviceData.name || deviceData.location || 'Unknown Device',
      location: deviceData.location || null,
      type: normalizedType,
      deviceType: deviceData.deviceType || null,
      ip: deviceData.ip || deviceData.localIp || null,
      model: deviceData.model || null,
      status: deviceData.status || 'unknown',
      batteryPercent: deviceData.batteryPercent ?? lastReading.batteryPercent ?? null,
      wifiRssi: deviceData.wifiRssi ?? lastReading.wifiRssi ?? null,
      temperature: tempC ?? null,
      temperatureF: tempF ?? null,
      humidity: humidityValue ?? null,
      flood: isFlooded,
      isFlooded,
      lastSeen: deviceData.lastSeen?.toDate?.()?.toISOString?.() || deviceData.lastSeen || null,
      propertyId: deviceData.propertyId || null,
      ownerId: deviceData.ownerId || null,
      connectionType: deviceData.connectionType || (deviceData.bleAddress ? 'bluetooth' : 'wifi'),
      bleAddress: deviceData.bleAddress || null,
      capabilities: normalizeCloudDeviceCapabilities(deviceData.type, deviceData.capabilities),
      hasActiveAlert: Boolean(deviceData.hasActiveAlert),
      relayOutputOn: relayData.output === true || deviceData.relayOutputOn === true,
      valveState: deviceData.valveState || 'unknown',
      lastValveCommand: deviceData.lastValveCommand || null,
      lastValveCommandAt: deviceData.lastValveCommandAt?.toDate?.()?.toISOString?.() || deviceData.lastValveCommandAt || null,
      pulseDurationMs: deviceData.pulseDurationMs ?? null,
      valveTravelMs: deviceData.valveTravelMs ?? null,
      actuationMode: deviceData.actuationMode === 'momentary' ? 'momentary' : 'maintained',
      relayCloseOn: deviceData.relayCloseOn !== false,
    };
  });

  const hasCanonicalWifiFlood = devices.some((device) => (
    String(device.deviceId || '').startsWith('shellyfloodg4-')
    || String(device.id || '').startsWith('shellyfloodg4-')
  ));

  const filteredDevices = devices.filter((device) => {
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

  return res.status(200).json({ success: true, count: filteredDevices.length, devices: filteredDevices });
}

async function acknowledgeAlertForDashboard(alertId, res) {
  if (!alertId) {
    return res.status(400).json({ success: false, error: 'alertId is required' });
  }

  const ref = db.collection('alerts').doc(String(alertId));
  const doc = await ref.get();
  if (!doc.exists) {
    return res.status(404).json({ success: false, error: 'Alert not found' });
  }

  await ref.update({
    acknowledged: true,
    acknowledgedAt: FieldValue.serverTimestamp(),
  });

  return res.status(200).json({ success: true, alertId });
}

async function listReadingsForDashboard(query, res) {
  const hours = Math.min(Math.max(parseInt(query.hours, 10) || 168, 1), 8760);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 1000);
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

  return res.status(200).json({
    success: true,
    count: readings.length,
    hours,
    readings,
  });
}

async function deleteFirestoreRefsInChunks(refs) {
  const uniqueRefs = Array.from(new Map(refs.map((ref) => [ref.path, ref])).values());
  const batchSize = 450;

  for (let index = 0; index < uniqueRefs.length; index += batchSize) {
    const batch = db.batch();
    uniqueRefs.slice(index, index + batchSize).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  return uniqueRefs.length;
}

async function deleteDeviceForDashboard(query, res) {
  const docId = query.docId || query.deviceDocId;
  const deviceId = query.deviceId || docId;

  if (!docId && !deviceId) {
    return res.status(400).json({ success: false, error: 'docId or deviceId is required' });
  }

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
    return res.status(404).json({ success: false, error: 'Sensor not found' });
  }

  const deviceData = snapshot.data() || {};
  const canonicalDeviceId = deviceData.deviceId || snapshot.id || deviceId;
  await db.collection('shelly_deleted_devices').doc(String(canonicalDeviceId)).set({
    deviceId: String(canonicalDeviceId),
    deletedAt: FieldValue.serverTimestamp(),
    propertyId: deviceData.propertyId || null,
    ownerId: deviceData.ownerId || null,
    name: deviceData.name || deviceData.location || canonicalDeviceId,
    location: deviceData.location || null,
    type: deviceData.type || deviceData.deviceType || null,
    source: 'cloud_dashboard_delete',
  }, { merge: true });

  const deletedCount = await deleteFirestoreRefsInChunks([docRef]);

  return res.status(200).json({
    success: true,
    message: 'Sensor removed. Historical alerts and analytics were kept for this property.',
    deviceId: canonicalDeviceId,
    docId: snapshot.id,
    deletedCount,
  });
}

async function resolveShellySensorDocument(deviceId) {
  if (!deviceId) {
    return { ref: null, data: null };
  }

  const exactRef = db.collection('shelly_devices').doc(deviceId);
  const exactDoc = await exactRef.get();
  if (exactDoc.exists) {
    return { ref: exactRef, data: exactDoc.data() || {} };
  }

  const byDeviceId = await db.collection('shelly_devices')
    .where('deviceId', '==', deviceId)
    .limit(1)
    .get();
  if (!byDeviceId.empty) {
    const match = byDeviceId.docs[0];
    return { ref: match.ref, data: match.data() || {} };
  }

  if (deviceId.startsWith('shellyfloodg4-')) {
    const floodCandidates = [];

    const floodTypeMatches = await db.collection('shelly_devices')
      .where('deviceType', '==', 'shelly_flood_gen4')
      .get();
    floodTypeMatches.docs.forEach((doc) => floodCandidates.push(doc));

    const legacyFloodTypeMatches = await db.collection('shelly_devices')
      .where('type', '==', 'flood')
      .get();
    legacyFloodTypeMatches.docs.forEach((doc) => floodCandidates.push(doc));

    const uniqueCandidates = Array.from(
      new Map(floodCandidates.map((doc) => [doc.ref.path, doc])).values()
    );

    if (uniqueCandidates.length === 1) {
      const match = uniqueCandidates[0];
      return { ref: match.ref, data: match.data() || {} };
    }
  }

  return { ref: exactRef, data: null };
}

/**
 * Create flood alert and send push notification
 */
async function createFloodAlert(deviceId, reading) {
  console.log(`🚨🚨🚨 FLOOD ALERT from ${deviceId} 🚨🚨🚨`);
  
  // Resolve sensor metadata even if the flood sensor was previously stored
  // under a legacy/non-canonical Firestore doc id.
  const { ref: sensorRef, data: sensorData } = await resolveShellySensorDocument(deviceId);
  const sensor = sensorData || {};
  
  const alert = {
    deviceId,
    sensorId: deviceId,
    sensorName: sensor.name || sensor.location || deviceId,
    deviceName: sensor.name || sensor.location || deviceId,
    location: sensor.location || sensor.name || 'Unknown',
    propertyId: sensor.propertyId || null,
    ownerId: sensor.ownerId || null,
    type: 'flood',
    severity: 'critical',
    message: `🚨 FLOOD DETECTED at ${sensor.name || sensor.location || deviceId}!`,
    timestamp: FieldValue.serverTimestamp(),
    reading,
    acknowledged: false,
    notificationSent: false
  };
  
  // Store alert
  const alertRef = await db.collection('alerts').add(alert);
  console.log(`✅ Alert created: ${alertRef.id}`);
  
  // Heal/create the canonical flood sensor doc so future lookups resolve directly.
  await db.collection('shelly_devices').doc(deviceId).set({
    deviceId,
    type: sensor.type || 'flood',
    deviceType: sensor.deviceType || 'shelly_flood_gen4',
    manufacturer: sensor.manufacturer || 'Shelly',
    model: sensor.model || 'Flood Gen4',
    name: sensor.name || sensor.location || deviceId,
    location: sensor.location || null,
    propertyId: sensor.propertyId || null,
    ownerId: sensor.ownerId || null,
    webhookUrl: sensor.webhookUrl || null,
    status: 'online',
    hasActiveAlert: true,
    lastAlertId: alertRef.id,
    lastAlertTime: FieldValue.serverTimestamp(),
    isFlooded: true,
    flood: true,
    lastSeen: FieldValue.serverTimestamp(),
  }, { merge: true });

  // Update the originally resolved device record too if it was stored under a
  // legacy id, so existing dashboard references stay in sync.
  if (sensorRef && sensorRef.id !== deviceId) {
    await sensorRef.set({
      deviceId,
      type: sensor.type || 'flood',
      deviceType: sensor.deviceType || 'shelly_flood_gen4',
      hasActiveAlert: true,
      lastAlertId: alertRef.id,
      lastAlertTime: FieldValue.serverTimestamp(),
      isFlooded: true,
      flood: true,
      lastSeen: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // Update shelly_devices with active alert and isFlooded flag
  await db.collection('shelly_devices').doc(deviceId).set({
    hasActiveAlert: true,
    lastAlertId: alertRef.id,
    lastAlertTime: FieldValue.serverTimestamp(),
    isFlooded: true,
    flood: true
  }, { merge: true });
  
  // Send push notification if property has FCM tokens
  if (sensor.propertyId) {
    await sendPushNotification(sensor.propertyId, {
      title: '🚨 Water Leak Detected!',
      body: `${sensor.name || sensor.location || 'Sensor'} detected water!`,
      data: {
        type: 'flood_alert',
        deviceId,
        alertId: alertRef.id
      }
    });
  }

  await triggerTenantAutoNotification(alertRef.id, {
    propertyId: sensor.propertyId || null,
    ownerId: sensor.ownerId || null,
    deviceId,
  });

  await triggerAutoWaterShutoff(alertRef.id, {
    propertyId: sensor.propertyId || null,
    ownerId: sensor.ownerId || null,
    deviceId,
  });
  
  return alertRef.id;
}

/**
 * Ask the HouseYield backend to immediately close the property water valve.
 */
function getHouseYieldBackendUrl() {
  return (
    process.env.HOUSEYIELD_BACKEND_URL
    || process.env.BACKEND_PUBLIC_URL
    || process.env.BACKEND_NOTIFY_URL
    || process.env.PUBLIC_BACKEND_URL
    || process.env.PUBLIC_URL
    || ''
  ).replace(/\/$/, '');
}

async function relayCommandForDashboard(data, res) {
  const backendUrl = getHouseYieldBackendUrl();
  if (!backendUrl) {
    return res.status(503).json({
      success: false,
      error: 'Remote valve control is not configured. Set HOUSEYIELD_BACKEND_URL on the Firebase function to your public HouseYield backend URL.',
    });
  }

  const deviceId = data.deviceId || data.device_id;
  const action = String(data.action || '').toLowerCase();
  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'deviceId is required' });
  }
  if (!['open', 'close', 'pulse'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be one of open, close, or pulse' });
  }

  const payload = JSON.stringify({
    action,
    deviceDocId: data.deviceDocId || data.device_doc_id || null,
    durationMs: data.durationMs || data.duration_ms || null,
  });

  try {
    const responseBody = await new Promise((resolve, reject) => {
      const url = new URL(`${backendUrl}/api/shelly/relay/${encodeURIComponent(deviceId)}/command`);
      const request = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 20000,
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          resolve({ statusCode: response.statusCode || 500, body });
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('Relay command request timed out'));
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });

    let parsed = {};
    try {
      parsed = JSON.parse(responseBody.body || '{}');
    } catch {
      parsed = { success: false, error: responseBody.body || 'Invalid backend response' };
    }

    return res.status(responseBody.statusCode).json(parsed);
  } catch (error) {
    console.error('[RelayCommand] Backend relay command failed:', error.message);
    return res.status(502).json({
      success: false,
      error: `Could not reach HouseYield backend for relay command: ${error.message}`,
    });
  }
}

async function triggerAutoWaterShutoff(alertId, context = {}) {
  const backendUrl = getHouseYieldBackendUrl();

  if (!backendUrl) {
    console.log('[FloodAlert] Backend auto-shutoff URL not configured; skipping automatic valve close');
    return;
  }

  const payload = JSON.stringify(context);

  await new Promise((resolve) => {
    try {
      const url = new URL(`${backendUrl}/api/shelly/alerts/${encodeURIComponent(alertId)}/auto-shutoff`);
      const request = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 15000,
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          console.log(`[FloodAlert] Auto-shutoff response ${response.statusCode}:`, body.slice(0, 500));
          resolve(null);
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('Auto-shutoff request timed out'));
      });
      request.on('error', (error) => {
        console.error('[FloodAlert] Auto-shutoff request failed:', error.message);
        resolve(null);
      });

      request.write(payload);
      request.end();
    } catch (error) {
      console.error('[FloodAlert] Auto-shutoff setup failed:', error.message);
      resolve(null);
    }
  });
}

/**
 * Ask the HouseYield backend to immediately notify the tenant linked to this alert.
 */
async function triggerTenantAutoNotification(alertId, context = {}) {
  const backendUrl = getHouseYieldBackendUrl();

  if (!backendUrl) {
    console.log('[FloodAlert] Backend auto-notify URL not configured; skipping tenant notification');
    return;
  }

  const payload = JSON.stringify({
    sendEmail: true,
    sendSMS: true,
    makePhoneCall: true,
    ...context,
  });

  await new Promise((resolve) => {
    try {
      const url = new URL(`${backendUrl}/api/shelly/alerts/${encodeURIComponent(alertId)}/auto-notify`);
      const request = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 15000,
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          console.log(`[FloodAlert] Auto-notify response ${response.statusCode}:`, body.slice(0, 500));
          resolve(null);
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('Auto-notify request timed out'));
      });
      request.on('error', (error) => {
        console.error('[FloodAlert] Auto-notify request failed:', error.message);
        resolve(null);
      });

      request.write(payload);
      request.end();
    } catch (error) {
      console.error('[FloodAlert] Auto-notify setup failed:', error.message);
      resolve(null);
    }
  });
}

/**
 * Send push notification via FCM
 */
async function sendPushNotification(propertyId, notification) {
  try {
    // Get FCM tokens for property owners
    const tokensDoc = await db.collection('fcm_tokens')
      .where('propertyId', '==', propertyId)
      .get();
    
    if (tokensDoc.empty) {
      console.log('No FCM tokens found for property:', propertyId);
      return;
    }
    
    const tokens = tokensDoc.docs.map(doc => doc.data().token);
    
    const message = {
      notification: {
        title: notification.title,
        body: notification.body
      },
      data: notification.data,
      tokens
    };
    
    const response = await getMessaging().sendEachForMulticast(message);
    console.log(`Push notifications sent: ${response.successCount} success, ${response.failureCount} failed`);
    
  } catch (error) {
    console.error('Push notification error:', error);
  }
}

/**
 * Store raw webhook for debugging unknown formats
 */
async function storeRawWebhook(deviceId, data) {
  await db.collection('raw_webhooks').add({
    deviceId: deviceId || 'unknown',
    timestamp: FieldValue.serverTimestamp(),
    ...data
  });
}

/**
 * Health check endpoint
 */
exports.health = onRequest({ invoker: 'public' }, (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'shelly-webhook',
    timestamp: new Date().toISOString()
  });
});

/**
 * Get sensor status (for testing)
 */
exports.getSensorStatus = onRequest({ invoker: 'private' }, async (req, res) => {
  const deviceId = req.query.deviceId;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId required' });
  }
  
  const sensorDoc = await db.collection('sensors').doc(deviceId).get();
  
  if (!sensorDoc.exists) {
    return res.status(404).json({ error: 'Sensor not found' });
  }
  
  res.json({ 
    id: sensorDoc.id,
    ...sensorDoc.data()
  });
});

// ==================== SCHEDULED H&T SENSOR POLLING ====================

/**
 * Helper: make an HTTPS POST request (no external dependencies needed)
 */
function httpsPost(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Try the deprecated Shelly Cloud API: POST /device/status
 * Docs: https://shelly-api-docs.shelly.cloud/cloud-control-api/communication
 * 
 * Uses the hex MAC portion of the device ID (e.g. "d0cf13c27f04")
 * Auth via auth_key parameter in POST body
 */
async function pollViaDeprecatedApi(serverHost, authKey, hexDeviceId) {
  const url = `https://${serverHost}/device/status`;
  const body = `id=${hexDeviceId}&auth_key=${authKey}`;
  const result = await httpsPost(url, body, 'application/x-www-form-urlencoded');

  if (result.status !== 200 || !result.data?.isok) {
    throw new Error(`API returned status=${result.status} isok=${result.data?.isok} errors=${JSON.stringify(result.data?.errors || [])}`);
  }

  return result.data.data?.device_status || null;
}

/**
 * Try the v2 Shelly Cloud API: POST /v2/devices/api/get
 * Docs: https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2
 * 
 * Uses hex device ID in an array. Returns full device status.
 * Rate limit: 1 request/second
 */
async function pollViaV2Api(serverHost, authKey, hexDeviceId) {
  const url = `https://${serverHost}/v2/devices/api/get?auth_key=${authKey}`;
  const body = {
    ids: [hexDeviceId],
    select: ['status'],
  };
  const result = await httpsPost(url, JSON.stringify(body), 'application/json');

  if (result.status !== 200) {
    throw new Error(`V2 API returned status=${result.status}`);
  }

  // v2 returns an array of device states
  const devices = Array.isArray(result.data) ? result.data : result.data?.data || [];
  const device = devices.find(d => d.id === hexDeviceId);
  return device?.status || null;
}

/**
 * Extract temperature/humidity/battery from a Gen2/Gen3 device status object
 * Works with both deprecated API (device_status) and v2 API (status) responses
 */
function extractHTReadings(status) {
  if (!status) return null;

  const temp = status['temperature:0'] || {};
  const humidity = status['humidity:0'] || {};
  const power = status['devicepower:0'] || {};

  // For the deprecated API, data might be nested differently
  // Gen2/3 H&T returns: temperature:0.tC, humidity:0.rh, devicepower:0.battery
  const tC = temp.tC ?? null;
  const tF = temp.tF ?? (tC != null ? tC * 9/5 + 32 : null);
  const rh = humidity.rh ?? null;

  if (tC == null && rh == null) {
    return null; // No useful data
  }

  return {
    temperature: tC,
    temperatureC: tC,
    temperatureF: tF != null ? Math.round(tF * 10) / 10 : null,
    humidity: rh,
    batteryPercent: power.battery?.percent ?? null,
    batteryVoltage: power.battery?.V ?? null,
  };
}

/**
 * Scheduled Cloud Function: Poll H&T sensors every 2 minutes
 * 
 * This runs on Google's infrastructure where DNS works reliably.
 * It reads sensor configs from Firestore, polls the Shelly Cloud API,
 * and saves readings back to Firestore for the frontend to pick up in real-time.
 * 
 * Polling strategy (per Shelly docs):
 * - Uses deprecated API first (simpler, well-tested): POST /device/status
 * - Falls back to v2 API: POST /v2/devices/api/get
 * - Tries multiple known Shelly Cloud server hostnames if the configured one fails
 * - Device ID: uses hex MAC (e.g. "d0cf13c27f04"), NOT "shellyhtg3-d0cf13c27f04"
 * - Rate limit: 1 req/sec (safe at 2min intervals)
 * - Battery devices return last-known status even when sleeping
 */
exports.pollHTSensors = onSchedule({
  schedule: 'every 30 minutes',
  timeoutSeconds: 30,
  memory: '256MiB',
}, async (event) => {
  console.log('🌡️ Scheduled H&T poll starting...');

  // 1. Get auth key and server from Firestore config (or use defaults)
  let authKey, serverHost;
  try {
    const configDoc = await db.collection('app_config').doc('shelly').get();
    const config = configDoc.exists ? configDoc.data() : {};
    authKey = config.authKey || config.auth_key || process.env.SHELLY_CLOUD_AUTH_KEY;
    serverHost = config.serverHost || config.server_host;
  } catch (e) {
    console.log('No app_config/shelly doc, using env defaults');
  }

  if (!authKey) {
    // Hardcoded fallback - the auth key from .env
    authKey = 'M2EyY2Q0dWlk7176A646AB3D0017AE88FCCA0296B04891C6476455D12495F309F18863C7830BD50D66AF855B891A';
  }

  // 2. Get all H&T sensors from shelly_devices collection
  const devicesSnap = await db.collection('shelly_devices').get();
  const htSensors = [];

  devicesSnap.docs.forEach(doc => {
    const d = doc.data();
    const id = doc.id;
    // Match H&T devices by ID prefix or model field
    if (id.startsWith('shellyhtg3') || id.startsWith('shellyht-') ||
        (d.model && d.model.toLowerCase().includes('ht'))) {
      // Extract hex MAC from device ID: "shellyhtg3-d0cf13c27f04" -> "d0cf13c27f04"
      const hexId = id.includes('-') ? id.split('-').pop() : id;
      htSensors.push({
        docId: id,
        hexId,
        name: d.name || d.location || id,
        propertyId: d.propertyId || null,
      });
    }
  });

  if (htSensors.length === 0) {
    console.log('No H&T sensors found in shelly_devices');
    return;
  }

  console.log(`Found ${htSensors.length} H&T sensor(s): ${htSensors.map(s => s.docId).join(', ')}`);

  // 3. Try polling with server discovery (try multiple hostnames)
  // Shelly Cloud servers: the server URI is shown in the Shelly app
  // Common patterns: shelly-27-eu.shelly.cloud, shelly-103-eu.shelly.cloud, etc.
  const serversToTry = serverHost ? [serverHost] : [
    'shelly-us.shelly.cloud',
    'shelly-1-us.shelly.cloud',
    'shelly-27-us.shelly.cloud',
    'shelly-100-us.shelly.cloud',
    'shelly-103-us.shelly.cloud',
    'shelly-27-eu.shelly.cloud',
    'shelly-103-eu.shelly.cloud',
    'shelly-1-eu.shelly.cloud',
    'shelly-100-eu.shelly.cloud',
    'shelly-3-eu.shelly.cloud',
    'control.shelly.cloud',
  ];

  for (const sensor of htSensors) {
    let readings = null;
    let usedServer = null;

    // Try each server until one works
    for (const server of serversToTry) {
      try {
        // Try deprecated API first (simpler)
        console.log(`Trying deprecated API: ${server} for ${sensor.hexId}`);
        const status = await pollViaDeprecatedApi(server, authKey, sensor.hexId);
        readings = extractHTReadings(status);
        if (readings) {
          usedServer = server;
          break;
        }
      } catch (err) {
        console.log(`Deprecated API failed on ${server}: ${err.message}`);
      }

      try {
        // Fall back to v2 API
        console.log(`Trying v2 API: ${server} for ${sensor.hexId}`);
        const status = await pollViaV2Api(server, authKey, sensor.hexId);
        readings = extractHTReadings(status);
        if (readings) {
          usedServer = server;
          break;
        }
      } catch (err) {
        console.log(`V2 API failed on ${server}: ${err.message}`);
      }
    }

    if (!readings) {
      console.log(`❌ Could not get readings for ${sensor.docId} from any server`);
      continue;
    }

    console.log(`✅ Got readings from ${usedServer}: temp=${readings.temperatureC}°C (${readings.temperatureF}°F), humidity=${readings.humidity}%, battery=${readings.batteryPercent}%`);

    // 4. Save to Firestore sensor_readings collection
    const reading = {
      deviceId: sensor.docId,
      timestamp: FieldValue.serverTimestamp(),
      type: 'ht_reading',
      source: 'cloud_poll',
      temperature: readings.temperatureC,
      temperatureC: readings.temperatureC,
      temperatureF: readings.temperatureF,
      humidity: readings.humidity,
      batteryPercent: readings.batteryPercent,
      batteryVoltage: readings.batteryVoltage,
      polledFrom: usedServer,
    };

    await db.collection('sensor_readings').add(reading);

    // 5. Update the device doc with latest readings
    await db.collection('shelly_devices').doc(sensor.docId).set({
      lastSeen: FieldValue.serverTimestamp(),
      status: 'online',
      temperature: readings.temperatureC,
      temperatureF: readings.temperatureF,
      humidity: readings.humidity,
      batteryPercent: readings.batteryPercent,
      lastReading: reading,
    }, { merge: true });

    // 6. If we found the right server, save it for next time
    if (usedServer && !serverHost) {
      await db.collection('app_config').doc('shelly').set({
        serverHost: usedServer,
        authKey,
        lastUpdated: FieldValue.serverTimestamp(),
      }, { merge: true });
      // Use this server for remaining sensors
      serversToTry.length = 0;
      serversToTry.push(usedServer);
    }
  }

  console.log('🌡️ Scheduled H&T poll complete');
});

/**
 * Manual trigger endpoint for testing the poll (call once to verify it works)
 * URL: https://us-central1-YOUR-PROJECT.cloudfunctions.net/manualPollHT
 */
exports.manualPollHT = onRequest({
  cors: true,
  timeoutSeconds: 60,
  invoker: 'private',
}, async (req, res) => {
  console.log('🔧 Manual H&T poll triggered');
  try {
    const authKey = 'M2EyY2Q0dWlk7176A646AB3D0017AE88FCCA0296B04891C6476455D12495F309F18863C7830BD50D66AF855B891A';
    const hexDeviceId = 'd0cf13c27f04';
    const decDeviceId = '229587808321284';
    const deviceDocId = 'shellyhtg3-d0cf13c27f04';

    // Try to get cached server
    let serverHost = null;
    try {
      const configDoc = await db.collection('app_config').doc('shelly').get();
      serverHost = configDoc.exists ? configDoc.data()?.serverHost : null;
    } catch (e) {}

    const servers = serverHost ? [serverHost] : [
      'shelly-27-eu.shelly.cloud',
      'shelly-103-eu.shelly.cloud',
      'shelly-1-eu.shelly.cloud',
      'shelly-100-eu.shelly.cloud',
      'shelly-3-eu.shelly.cloud',
      'control.shelly.cloud',
    ];

    // Step 1: Try /device/all_status to discover ALL devices in the account
    // This finds the right server and device ID format
    let discoveredDevices = null;
    let discoveryServer = null;
    for (const server of servers) {
      try {
        console.log(`Discovery: trying ${server}/device/all_status`);
        const url = `https://${server}/device/all_status`;
        const body = `show_info=true&auth_key=${authKey}`;
        const result = await httpsPost(url, body, 'application/x-www-form-urlencoded');
        console.log(`Discovery raw on ${server}:`, JSON.stringify(result.data).substring(0, 500));
        if (result.status === 200 && result.data?.isok && result.data?.data?.devices_status) {
          discoveredDevices = result.data.data.devices_status;
          discoveryServer = server;
          console.log(`Discovery on ${server}: found ${Object.keys(discoveredDevices).length} device(s)`);
          break;
        } else if (result.status === 200 && result.data?.isok) {
          // Maybe the response structure is different
          discoveredDevices = result.data.data || {};
          discoveryServer = server;
          console.log(`Discovery alt on ${server}: keys=${Object.keys(result.data.data || {})}`);
          break;
        } else {
          console.log(`Discovery on ${server}: status=${result.status} isok=${result.data?.isok}`);
        }
      } catch (err) {
        console.log(`Discovery failed on ${server}: ${err.message}`);
      }
    }

    if (discoveredDevices) {
      const deviceList = Object.entries(discoveredDevices).map(([key, val]) => ({
        key,
        devInfo: val._dev_info || {},
        temp: val['temperature:0'] || val.tmp,
        humidity: val['humidity:0'] || val.hum,
        battery: val['devicepower:0'] || val.bat,
      }));

      // Try to find the H&T sensor
      let htDevice = null;
      let htKey = null;
      for (const [key, val] of Object.entries(discoveredDevices)) {
        const info = val._dev_info || {};
        if (key.includes('d0cf13c27f04') || key === hexDeviceId || key === decDeviceId ||
            info.id?.includes('d0cf13c27f04') || (info.code && info.code.includes('HT'))) {
          htDevice = val;
          htKey = key;
          break;
        }
      }

      if (htDevice) {
        const readings = extractHTReadings(htDevice);
        if (readings) {
          const reading = {
            deviceId: deviceDocId,
            timestamp: FieldValue.serverTimestamp(),
            type: 'ht_reading',
            source: 'manual_poll',
            temperature: readings.temperatureC,
            temperatureC: readings.temperatureC,
            temperatureF: readings.temperatureF,
            humidity: readings.humidity,
            batteryPercent: readings.batteryPercent,
            batteryVoltage: readings.batteryVoltage,
            polledFrom: discoveryServer,
          };
          const docRef = await db.collection('sensor_readings').add(reading);
          await db.collection('shelly_devices').doc(deviceDocId).set({
            lastSeen: FieldValue.serverTimestamp(), status: 'online',
            temperature: readings.temperatureC, temperatureF: readings.temperatureF,
            humidity: readings.humidity, batteryPercent: readings.batteryPercent,
          }, { merge: true });
          await db.collection('app_config').doc('shelly').set({
            serverHost: discoveryServer, authKey, cloudDeviceId: htKey,
            lastUpdated: FieldValue.serverTimestamp(),
          }, { merge: true });
          return res.json({ success: true, server: discoveryServer, cloudDeviceId: htKey, readingId: docRef.id, readings });
        }
      }

      return res.json({
        success: false,
        message: 'Connected to Shelly Cloud but H&T sensor not found in account',
        server: discoveryServer,
        devicesFound: deviceList,
        rawKeys: Object.keys(discoveredDevices),
        deviceCount: Object.keys(discoveredDevices).length,
      });
    }

    // Step 2: Fallback - try individual /device/status with multiple ID formats
    let readings = null;
    let usedServer = null;
    const errors = [];
    const idsToTry = [hexDeviceId, decDeviceId, deviceDocId];

    for (const server of servers) {
      for (const devId of idsToTry) {
        try {
          const status = await pollViaDeprecatedApi(server, authKey, devId);
          readings = extractHTReadings(status);
          if (readings) { usedServer = server; break; }
        } catch (err) {
          errors.push(`${server}/${devId}: ${err.message}`);
        }
      }
      if (readings) break;
    }

    if (!readings) {
      return res.status(502).json({ success: false, message: 'Could not find device on any server', errors });
    }

    const reading = {
      deviceId: deviceDocId, timestamp: FieldValue.serverTimestamp(),
      type: 'ht_reading', source: 'manual_poll',
      temperature: readings.temperatureC, temperatureC: readings.temperatureC,
      temperatureF: readings.temperatureF, humidity: readings.humidity,
      batteryPercent: readings.batteryPercent, batteryVoltage: readings.batteryVoltage,
      polledFrom: usedServer,
    };
    const docRef = await db.collection('sensor_readings').add(reading);
    res.json({ success: true, server: usedServer, readingId: docRef.id, readings });
  } catch (error) {
    console.error('Manual poll error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
