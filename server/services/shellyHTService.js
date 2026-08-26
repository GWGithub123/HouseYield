/**
 * Shelly H&T Gen3 Temperature & Humidity Sensor Service
 * 
 * Manages Shelly H&T Gen3 sensors which provide:
 *   - Temperature readings (°C/°F) via temperature:0 component
 *   - Humidity readings (% RH) via humidity:0 component
 *   - Battery status via devicepower:0 component
 *   - Connection via WiFi direct OR Bluetooth through BLU Gateway
 * 
 * Data Flow:
 *   H&T Gen3 → [BLE → BLU Gateway → WiFi] OR [Direct WiFi] → 
 *   Webhook/Poll → This Service → Firestore → Frontend
 * 
 * Polling Strategy:
 *   - The H&T Gen3 is battery-operated and sleeps between reports
 *   - It sends temperature.measurement and humidity.measurement events every 60s when awake
 *   - We configure webhooks on the device/gateway for real-time data
 *   - We also poll via Cloud API or Gateway RPC every 2 minutes as backup
 *   - All readings are stored in Firestore for trend analysis
 */

import { EventEmitter } from 'events';
import cron from 'node-cron';
import shellyBluGateway from './shellyBluGateway.js';

function isShellyCloudEnabled() {
  return process.env.SHELLY_CLOUD_ENABLED !== 'false';
}

// Dynamic Firestore import
let firestoreService = null;

function normalizeBleToken(value) {
  return String(value || '').replace(/:/g, '').trim().toLowerCase();
}

function buildCanonicalBleHtDeviceId(value) {
  const normalized = normalizeBleToken(value);
  if (!normalized) return '';
  if (normalized.startsWith('shellyhtg3-')) return normalized;
  if (normalized.startsWith('blu-ht-')) return `shellyhtg3-${normalized.slice('blu-ht-'.length)}`;
  return `shellyhtg3-${normalized}`;
}

function buildLegacyBleHtDeviceId(value) {
  const normalized = normalizeBleToken(value);
  if (!normalized) return '';
  if (normalized.startsWith('blu-ht-')) return normalized;
  if (normalized.startsWith('shellyhtg3-')) return `blu-ht-${normalized.slice('shellyhtg3-'.length)}`;
  return `blu-ht-${normalized}`;
}

function resolveBleHtDeviceId(data) {
  const explicitId = String(data?.deviceId || '').trim();
  if (explicitId.startsWith('shellyhtg3-')) {
    return explicitId;
  }
  if (explicitId.startsWith('blu-ht-')) {
    return buildCanonicalBleHtDeviceId(explicitId);
  }
  if (data?.addr) {
    return buildCanonicalBleHtDeviceId(data.addr);
  }
  return explicitId || String(data?.component || 'unknown');
}

class ShellyHTService extends EventEmitter {
  constructor() {
    super();
    this.sensors = new Map(); // deviceId -> sensor config & state
    this.pollingInterval = null;
    this.isPolling = false;
    this.initialized = false;
    
    // Polling config — poll every 60s for continuous chart data
    this.pollIntervalSeconds = parseInt(process.env.HT_POLL_INTERVAL_SECONDS || '60', 10); // 1 min default
    this.trendStorageIntervalSeconds = parseInt(process.env.HT_TREND_INTERVAL_SECONDS || '120', 10); // 2 min trend storage
    
    // Connection preference
    this.preferBluetooth = true; // BLE via gateway is preferred over direct WiFi
  }

  /**
   * Initialize the H&T service
   */
  async initialize() {
    if (this.initialized) return true;

    // Load Firestore
    try {
      const module = await import('../../backend/services/firestore-service.cjs');
      firestoreService = module.default || module;
      console.log('✅ [H&T] Firestore service loaded');
    } catch (err) {
      console.log('ℹ️  [H&T] Firestore not available:', err.message);
    }

    // Load configured H&T sensors from environment
    const sensorIds = (process.env.SHELLY_HT_DEVICE_IDS || '').split(',').filter(Boolean);
    const sensorIps = (process.env.SHELLY_HT_DEVICE_IPS || '').split(',').filter(Boolean);
    const sensorBleAddrs = (process.env.SHELLY_HT_BLE_ADDRESSES || '').split(',').filter(Boolean);

    for (let i = 0; i < Math.max(sensorIds.length, sensorIps.length, sensorBleAddrs.length); i++) {
      const sensorConfig = {
        deviceId: sensorIds[i] || `ht-sensor-${i}`,
        ip: sensorIps[i] || null,
        bleAddress: sensorBleAddrs[i] || null,
        connectionType: sensorBleAddrs[i] ? 'bluetooth' : (sensorIps[i] ? 'wifi' : 'cloud'),
        lastReading: null,
        lastTrendSave: null,
      };
      this.sensors.set(sensorConfig.deviceId, sensorConfig);
      console.log(`🌡️  [H&T] Registered sensor: ${sensorConfig.deviceId} via ${sensorConfig.connectionType}`);
    }

    // Listen for BLU Gateway sensor events (preferred path)
    this.setupGatewayListeners();

    this.initialized = true;
    console.log(`✅ [H&T] Service initialized with ${this.sensors.size} sensor(s)`);

    // Check for data gaps from when the server was offline and backfill
    this.backfillFromCloudOnStartup().catch(err => {
      console.warn('[H&T] Startup backfill failed (non-critical):', err.message);
    });

    return true;
  }

  /**
   * On startup, check Firestore for the last recorded reading for each known sensor.
   * If there's a gap (last reading was > 5 min ago), poll the Shelly Cloud API to 
   * get the current state immediately so the chart data doesn't have holes.
   * 
   * This handles the case where the backend server was offline but the sensors
   * kept reporting to Shelly Cloud — we can recover the latest reading at minimum.
   */
  async backfillFromCloudOnStartup() {
    if (!firestoreService) {
      console.log('ℹ️  [H&T] Skipping startup backfill — Firestore not available');
      return;
    }

    if (!isShellyCloudEnabled()) {
      console.log('ℹ️  [H&T] Skipping startup backfill — Shelly Cloud disabled');
      return;
    }

    const authKey = process.env.SHELLY_CLOUD_AUTH_KEY;
    if (!authKey) {
      console.log('ℹ️  [H&T] Skipping startup backfill — no Shelly Cloud auth key');
      return;
    }

    console.log('🔄 [H&T] Checking for data gaps while server was offline...');

    try {
      const admin = (await import('firebase-admin')).default;
      const db = admin.firestore();

      // Find all H&T devices in Firestore
      const devicesSnapshot = await db.collection('shelly_devices').get();
      const htDevices = [];
      devicesSnapshot.forEach(doc => {
        const data = doc.data();
        const id = doc.id;
        if (id.includes('ht') || id.startsWith('blu-ht-') || 
            data.deviceType?.includes('ht') || data.type?.includes('temperature') ||
            data.model?.toLowerCase().includes('h&t') || data.model?.toLowerCase().includes('ht')) {
          htDevices.push({ id, ...data });
        }
      });

      if (htDevices.length === 0) {
        console.log('ℹ️  [H&T] No H&T devices found in Firestore for backfill');
        return;
      }

      const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();
      let backfillCount = 0;

      for (const device of htDevices) {
        try {
          // Get the most recent reading for this device
          const readingsQuery = await db.collection('sensor_readings')
            .where('deviceId', '==', device.id)
            .orderBy('timestamp', 'desc')
            .limit(1)
            .get();

          let lastReadingTime = null;
          if (!readingsQuery.empty) {
            const lastReading = readingsQuery.docs[0].data();
            const ts = lastReading.timestamp;
            lastReadingTime = ts?.toDate?.() ? ts.toDate().getTime() : 
                             ts?._seconds ? ts._seconds * 1000 : 
                             new Date(ts).getTime();
          }

          const gap = lastReadingTime ? now - lastReadingTime : Infinity;
          const gapMinutes = Math.round(gap / 60000);

          if (gap > GAP_THRESHOLD_MS) {
            console.log(`⏳ [H&T] ${device.id}: last reading was ${gapMinutes} min ago — backfilling from Cloud API`);

            // Try to get current reading from Shelly Cloud
            const reading = await this.pollViaCloudApi({ deviceId: device.id });
            if (reading && (reading.temperature != null || reading.humidity != null)) {
              await this.saveSensorReading(device.id, {
                temperature: reading.temperature,
                temperatureF: reading.temperatureF,
                humidity: reading.humidity,
                batteryPercent: reading.batteryPercent,
                timestamp: new Date(),
                source: 'startup_backfill',
              });
              backfillCount++;
              console.log(`✅ [H&T] Backfilled ${device.id}: ${reading.temperature?.toFixed(1)}°C, ${reading.humidity?.toFixed(0)}%`);
            } else {
              console.log(`ℹ️  [H&T] ${device.id}: Cloud API returned no data — sensor may only be BLE`);
            }
          } else {
            console.log(`✅ [H&T] ${device.id}: last reading ${gapMinutes} min ago — no backfill needed`);
          }
        } catch (deviceErr) {
          console.warn(`[H&T] Backfill check failed for ${device.id}:`, deviceErr.message);
        }
      }

      if (backfillCount > 0) {
        console.log(`✅ [H&T] Startup backfill complete: ${backfillCount} device(s) refreshed`);
      } else {
        console.log('✅ [H&T] No data gaps detected — all sensors up to date');
      }
    } catch (err) {
      console.error('[H&T] Startup backfill error:', err.message);
    }
  }

  /**
   * Listen for real-time sensor data from the BLU Gateway
   */
  setupGatewayListeners() {
    shellyBluGateway.on('sensor:temperature', (data) => {
      this.handleTemperatureReading(data);
    });

    shellyBluGateway.on('sensor:humidity', (data) => {
      this.handleHumidityReading(data);
    });

    shellyBluGateway.on('sensor:battery', (data) => {
      this.handleBatteryReading(data);
    });

    shellyBluGateway.on('sensor:update', (data) => {
      // Generic sensor update - process any combined readings
      if (data.temperature !== undefined || data.tC !== undefined) {
        this.handleTemperatureReading(data);
      }
      if (data.humidity !== undefined || data.rh !== undefined) {
        this.handleHumidityReading(data);
      }
    });
  }

  /**
   * Handle an incoming temperature reading
   */
  async handleTemperatureReading(data) {
    const tempC = data.temperature ?? data.tC;
    const tempF = data.temperatureF ?? data.tF ?? (tempC != null ? (tempC * 9/5) + 32 : null);
    const deviceId = resolveBleHtDeviceId(data);
    const timestamp = data.timestamp || new Date();

    console.log(`🌡️  [H&T] Temperature: ${tempF?.toFixed(1)}°F (${tempC?.toFixed(1)}°C) from ${deviceId}`);

    // Auto-register BLE-discovered sensors that aren't in our map yet
    if (data.addr && !this.findSensorByAny(deviceId)) {
      await this.autoRegisterBleSensor(deviceId, data.addr);
    }

    // Update in-memory state
    const sensor = this.findSensorByAny(deviceId);
    if (sensor) {
      sensor.lastReading = {
        ...sensor.lastReading,
        temperature: tempC,
        temperatureF: tempF,
        timestamp,
      };
    }

    // Save to Firestore — but skip if the Cloud Function already stored this reading
    // (v3.0: gateway script sends to Firebase first, then local server)
    if (!data.skipFirestore) {
      await this.saveSensorReading(deviceId, {
        temperature: tempC,
        temperatureF: tempF,
        timestamp,
        source: data.source || 'gateway',
      });
    }

    // Emit for real-time subscribers
    this.emit('temperature', { deviceId, tempC, tempF, timestamp });
  }

  /**
   * Handle an incoming humidity reading
   */
  async handleHumidityReading(data) {
    const humidity = data.humidity ?? data.rh;
    const deviceId = resolveBleHtDeviceId(data);
    const timestamp = data.timestamp || new Date();

    console.log(`💧 [H&T] Humidity: ${humidity?.toFixed(1)}% from ${deviceId}`);

    // Auto-register BLE-discovered sensors that aren't in our map yet
    if (data.addr && !this.findSensorByAny(deviceId)) {
      await this.autoRegisterBleSensor(deviceId, data.addr);
    }

    const sensor = this.findSensorByAny(deviceId);
    if (sensor) {
      sensor.lastReading = {
        ...sensor.lastReading,
        humidity,
        timestamp,
      };
    }

    // Save to Firestore — but skip if the Cloud Function already stored this reading
    // (v3.0: gateway script sends to Firebase first, then local server)
    if (!data.skipFirestore) {
      await this.saveSensorReading(deviceId, {
        humidity,
        timestamp,
        source: data.source || 'gateway',
      });
    }

    this.emit('humidity', { deviceId, humidity, timestamp });
  }

  /**
   * Handle battery level reading
   */
  async handleBatteryReading(data) {
    const deviceId = resolveBleHtDeviceId(data);
    const batteryPercent = data.batteryPercent ?? data.battery;

    const sensor = this.findSensorByAny(deviceId);
    if (sensor) {
      sensor.lastReading = {
        ...sensor.lastReading,
        batteryPercent,
        batteryUpdatedAt: new Date().toISOString(),
      };
    }

    // Update device record in Firestore — only on a real battery object from BTHome
    if (firestoreService && batteryPercent != null) {
      try {
        await firestoreService.db.collection('shelly_devices').doc(deviceId).set({
          batteryPercent,
          batteryLevel: batteryPercent,
          batteryUpdatedAt: new Date().toISOString(),
        }, { merge: true });
      } catch (err) {
        // Non-critical, just log
      }
    }
  }

  /**
   * Auto-register a BLE-discovered sensor that was picked up by the gateway
   * but never manually registered by the user.
   */
  async autoRegisterBleSensor(deviceId, bleAddress) {
    const canonicalDeviceId = buildCanonicalBleHtDeviceId(deviceId || bleAddress) || deviceId;
    const legacyDeviceId = buildLegacyBleHtDeviceId(canonicalDeviceId);

    // Avoid duplicate registration
    if (this.findSensorByAny(canonicalDeviceId)) return;
    if (this._pendingAutoRegister?.has(canonicalDeviceId)) return;
    if (!this._pendingAutoRegister) this._pendingAutoRegister = new Set();
    this._pendingAutoRegister.add(canonicalDeviceId);

    try {
      const shortAddr = bleAddress.replace(/:/g, '').slice(-6).toUpperCase();
      console.log(`🔵 [H&T] Auto-registering BLE sensor: ${canonicalDeviceId} (addr: ${bleAddress})`);

      const sensorConfig = {
        deviceId: canonicalDeviceId,
        ip: null,
        bleAddress: bleAddress.toLowerCase(),
        connectionType: 'bluetooth',
        lastReading: null,
        lastTrendSave: null,
      };
      this.sensors.set(canonicalDeviceId, sensorConfig);

      // Save to Firestore so it shows up in the frontend
      if (firestoreService) {
        try {
          // Check if device already has a custom name in Firestore — don't overwrite it
          const existingDoc = await firestoreService.getSensor(canonicalDeviceId)
            || (legacyDeviceId && legacyDeviceId !== canonicalDeviceId
              ? await firestoreService.getSensor(legacyDeviceId)
              : null);
          const existingName = existingDoc?.name;
          const defaultName = `BLU H&T ${shortAddr}`;
          const isCustomName = existingName && existingName !== defaultName && !existingName.startsWith('BLU H&T ');

          const sensorData = {
            deviceType: 'shelly_ht_gen3',
            manufacturer: 'Shelly',
            model: 'BLU H&T',
            type: 'temperature_humidity',
            connectionType: 'bluetooth',
            bleAddress: bleAddress.toLowerCase(),
            capabilities: ['temperature', 'humidity', 'battery'],
            autoDiscovered: true,
            lastSeen: new Date().toISOString(),
            status: 'online',
          };
          if (existingDoc?.location) {
            sensorData.location = existingDoc.location;
          }
          if (existingDoc?.propertyId) {
            sensorData.propertyId = existingDoc.propertyId;
          }
          if (existingDoc?.ownerId) {
            sensorData.ownerId = existingDoc.ownerId;
          }
          // Only set name if there isn't already a custom name
          if (!isCustomName) {
            sensorData.name = defaultName;
          }
          // Only set discoveredAt on first registration
          if (!existingDoc) {
            sensorData.discoveredAt = new Date().toISOString();
          }

          await firestoreService.registerSensor(canonicalDeviceId, sensorData);
          console.log(`✅ [H&T] Auto-registered BLE sensor in Firestore: ${canonicalDeviceId}`);
        } catch (err) {
          console.error(`[H&T] Firestore auto-register failed for ${canonicalDeviceId}:`, err.message);
        }
      }

      // Always mirror into IoT cloud with correct H&T typing (and clear stale tombstones).
      try {
        const { registerCloudDevice } = await import('../iot-cloud-firestore.js');
        let propertyId = sensorConfig.propertyId || null;
        try {
          const gateway = (await import('./shellyBluGateway.js')).default;
          // Prefer gateway property if sensor has none yet
          if (!propertyId && gateway?.gatewayId) {
            const { getIotFirestore } = await import('../iot-cloud-firestore.js');
            const gwDoc = await getIotFirestore().collection('shelly_devices').doc(gateway.gatewayId).get();
            if (gwDoc.exists) propertyId = gwDoc.data()?.propertyId || null;
          }
        } catch {
          // gateway lookup is best-effort
        }

        await registerCloudDevice(canonicalDeviceId, {
          name: `BLU H&T ${shortAddr}`,
          type: 'temperature_humidity',
          deviceType: 'shelly_ht_gen3',
          model: 'BLU H&T',
          connectionType: 'bluetooth',
          bleAddress: bleAddress.toLowerCase(),
          capabilities: ['temperature', 'humidity', 'battery'],
          propertyId,
          status: 'online',
          autoDiscovered: true,
        }, { clearTombstone: true });

        if (legacyDeviceId && legacyDeviceId !== canonicalDeviceId) {
          await registerCloudDevice(legacyDeviceId, {
            name: `BLU H&T ${shortAddr}`,
            type: 'temperature_humidity',
            deviceType: 'shelly_ht_gen3',
            model: 'BLU H&T',
            connectionType: 'bluetooth',
            bleAddress: bleAddress.toLowerCase(),
            capabilities: ['temperature', 'humidity', 'battery'],
            propertyId,
            status: 'online',
            autoDiscovered: true,
          }, { clearTombstone: true });
        }
      } catch (cloudErr) {
        console.warn(`[H&T] IoT cloud auto-register failed for ${canonicalDeviceId}:`, cloudErr.message);
      }

      this.emit('sensor:registered', sensorConfig);
    } finally {
      this._pendingAutoRegister?.delete(canonicalDeviceId);
    }
  }

  /**
   * Find a sensor config by deviceId, IP, or BLE address
   */
  findSensorByAny(identifier) {
    const normalizedIdentifier = String(identifier || '').trim().toLowerCase();
    const canonicalId = buildCanonicalBleHtDeviceId(normalizedIdentifier);
    const legacyId = buildLegacyBleHtDeviceId(normalizedIdentifier);

    // Direct deviceId match
    if (this.sensors.has(identifier)) {
      return this.sensors.get(identifier);
    }
    if (canonicalId && this.sensors.has(canonicalId)) {
      return this.sensors.get(canonicalId);
    }
    if (legacyId && this.sensors.has(legacyId)) {
      return this.sensors.get(legacyId);
    }

    // Search by IP, BLE address, or component key
    for (const [, sensor] of this.sensors) {
      const normalizedSensorBle = normalizeBleToken(sensor.bleAddress);
      if (sensor.ip === identifier
          || sensor.bleAddress === normalizedIdentifier
          || (normalizedSensorBle && normalizedSensorBle === normalizeBleToken(identifier))
          || sensor.deviceId === canonicalId
          || sensor.deviceId === legacyId
          || normalizedIdentifier.includes(sensor.deviceId)) {
        return sensor;
      }
    }
    return null;
  }

  /**
   * Save a sensor reading to Firestore for trend analysis
   */
  async saveSensorReading(deviceId, reading) {
    const deviceKey = String(deviceId || '');
    const sensor = this.findSensorByAny(deviceId);
    const isBleCloudDevice = deviceKey.startsWith('blu-ht-')
      || Boolean(sensor?.bleAddress)
      || sensor?.connectionType === 'bluetooth'
      || ['ble_gateway', 'ble_gateway_fallback', 'bluetooth_gateway'].includes(String(reading.source || ''));

    if (isBleCloudDevice) {
      try {
        const {
          bleAddrToCloudDeviceId,
          saveCloudSensorReading,
        } = await import('../iot-cloud-firestore.js');

        let cloudDeviceId = deviceKey.startsWith('blu-ht-')
          ? deviceKey
          : (sensor?.bleAddress ? bleAddrToCloudDeviceId(sensor.bleAddress) : null)
            || buildLegacyBleHtDeviceId(sensor?.bleAddress || deviceKey.split('-').pop());

        if (cloudDeviceId) {
          await saveCloudSensorReading(cloudDeviceId, {
            temperature: reading.temperature ?? null,
            temperatureF: reading.temperatureF ?? null,
            humidity: reading.humidity ?? null,
            batteryPercent: reading.batteryPercent ?? null,
            bleAddress: sensor?.bleAddress || null,
            source: reading.source || 'poll',
          });
          return;
        }
      } catch (error) {
        console.warn(`[H&T] IoT Firestore save failed for ${deviceId}, falling back:`, error.message);
      }
    }

    if (!firestoreService) return;

    try {
      const readingDoc = {
        deviceId,
        temperature: reading.temperature ?? null,
        temperatureC: reading.temperature ?? null,
        temperatureF: reading.temperatureF ?? null,
        humidity: reading.humidity ?? null,
        batteryPercent: reading.batteryPercent ?? null,
        source: reading.source || 'unknown',
        timestamp: reading.timestamp || new Date(),
        type: 'ht_reading',
      };

      // Save to sensor_readings collection for trend analysis
      await firestoreService.saveSensorReading(deviceId, readingDoc);

      // Also update the device's lastReading in shelly_devices
      const updateData = {
        lastSeen: new Date(),
        status: 'online',
      };
      
      if (reading.temperature != null) {
        updateData.temperature = reading.temperature;
        updateData['lastReading.temperature:0'] = {
          tC: reading.temperature,
          tF: reading.temperatureF,
        };
      }
      if (reading.humidity != null) {
        updateData.humidity = reading.humidity;
        updateData['lastReading.humidity:0'] = {
          rh: reading.humidity,
        };
      }

      await firestoreService.updateDevice(deviceId, updateData);
    } catch (error) {
      console.error(`[H&T] Failed to save reading for ${deviceId}:`, error.message);
    }
  }

  /**
   * Start periodic polling of H&T sensors
   * This runs every pollIntervalSeconds to fetch current readings
   */
  startPolling() {
    if (this.isPolling) {
      console.log('⚠️  [H&T] Polling already active');
      return;
    }

    if (this.sensors.size === 0) {
      console.log('⚠️  [H&T] No sensors registered — skipping polling start');
      return;
    }

    console.log(`🔄 [H&T] Starting periodic polling every ${this.pollIntervalSeconds}s for ${this.sensors.size} sensor(s)...`);
    this.isPolling = true;

    // Initial poll immediately
    this.pollAllSensors().then(results => {
      const successCount = results.filter(r => r.status === 'ok').length;
      console.log(`✅ [H&T] Initial poll complete: ${successCount}/${results.length} sensors returned data`);
    });

    // Use setInterval for reliable sub-minute polling (cron only supports 1-min minimum)
    this.pollingInterval = setInterval(async () => {
      try {
        const results = await this.pollAllSensors();
        const successCount = results.filter(r => r.status === 'ok').length;
        if (successCount > 0) {
          console.log(`🔄 [H&T] Poll: ${successCount}/${results.length} sensors returned data`);
        }
      } catch (err) {
        console.error('[H&T] Poll cycle error:', err.message);
      }
    }, this.pollIntervalSeconds * 1000);

    // Also start the trend data storage interval
    this.startTrendStorage();
    
    console.log('✅ [H&T] Polling started');
  }

  /**
   * Poll all registered H&T sensors for current data
   */
  async pollAllSensors() {
    const results = [];
    let isDeleted = null;
    try {
      ({ isShellyDeviceDeleted: isDeleted } = await import('../iot-cloud-firestore.js'));
    } catch {
      isDeleted = null;
    }

    for (const [deviceId, sensor] of this.sensors) {
      try {
        if (typeof isDeleted === 'function' && await isDeleted(deviceId)) {
          console.log(`⏭️  [H&T] Skipping deleted sensor ${deviceId}`);
          this.unregisterSensor(deviceId);
          continue;
        }

        let reading = null;

        // Prefer BLE via gateway
        if (this.preferBluetooth && sensor.bleAddress && shellyBluGateway.initialized) {
          reading = await this.pollViaBluGateway(sensor);
        }
        
        // Fallback to direct WiFi if gateway read failed
        if (!reading && sensor.ip) {
          reading = await this.pollViaDirectWifi(sensor);
        }

        // Fallback to Cloud API
        if (!reading && sensor.deviceId && isShellyCloudEnabled()) {
          reading = await this.pollViaCloudApi(sensor);
        }

        if (reading) {
          // Update in-memory state with combined reading
          const sensor_ref = this.findSensorByAny(deviceId);
          if (sensor_ref) {
            sensor_ref.lastReading = {
              ...sensor_ref.lastReading,
              temperature: reading.temperature ?? sensor_ref.lastReading?.temperature,
              temperatureF: reading.temperatureF ?? sensor_ref.lastReading?.temperatureF,
              humidity: reading.humidity ?? sensor_ref.lastReading?.humidity,
              timestamp: reading.timestamp || new Date(),
            };
          }

          // Save a single combined reading to Firestore (not separate temp/humidity docs)
          await this.saveSensorReading(deviceId, {
            temperature: reading.temperature ?? null,
            temperatureF: reading.temperatureF ?? null,
            humidity: reading.humidity ?? null,
            batteryPercent: reading.batteryPercent ?? null,
            timestamp: reading.timestamp || new Date(),
            source: reading.source || 'poll',
          });

          // Also update the device's lastReading in shelly_devices
          const updateData = {
            lastSeen: new Date(),
            status: 'online',
          };
          if (reading.temperature != null) {
            updateData.temperature = reading.temperature;
            updateData['lastReading.temperature:0'] = {
              tC: reading.temperature,
              tF: reading.temperatureF,
            };
          }
          if (reading.humidity != null) {
            updateData.humidity = reading.humidity;
            updateData['lastReading.humidity:0'] = {
              rh: reading.humidity,
            };
          }
          if (firestoreService) {
            try { await firestoreService.updateDevice(deviceId, updateData); } catch (e) { /* non-critical */ }
          }

          // Emit events for real-time subscribers
          if (reading.temperature != null) {
            this.emit('temperature', { deviceId, tempC: reading.temperature, tempF: reading.temperatureF, timestamp: reading.timestamp });
          }
          if (reading.humidity != null) {
            this.emit('humidity', { deviceId, humidity: reading.humidity, timestamp: reading.timestamp });
          }

          results.push({ deviceId, reading, status: 'ok' });
        } else {
          results.push({ deviceId, reading: null, status: 'no_data' });
        }
      } catch (error) {
        console.error(`[H&T] Poll failed for ${deviceId}:`, error.message);
        results.push({ deviceId, reading: null, status: 'error', error: error.message });
      }
    }

    return results;
  }

  /**
   * Poll a sensor via BLU Gateway (preferred path)
   */
  async pollViaBluGateway(sensor) {
    try {
      const allReadings = await shellyBluGateway.pollAllSensors();
      
      // Find readings matching this sensor's BLE address or component key
      let tempReading = null;
      let humidityReading = null;

      for (const reading of allReadings) {
        if (reading.type === 'bthome_sensor') {
          // Match by stored component association
          if (reading.componentId?.includes('temperature') || reading.value?.tC !== undefined) {
            tempReading = reading;
          }
          if (reading.componentId?.includes('humidity') || reading.value?.rh !== undefined) {
            humidityReading = reading;
          }
        }
        // Also check direct temperature/humidity components
        if (reading.type === 'temperature' && reading.tC != null) {
          tempReading = reading;
        }
        if (reading.type === 'humidity' && reading.rh != null) {
          humidityReading = reading;
        }
      }

      if (tempReading || humidityReading) {
        return {
          temperature: tempReading?.tC ?? tempReading?.value?.tC ?? null,
          temperatureF: tempReading?.tF ?? (tempReading?.tC ? (tempReading.tC * 9/5) + 32 : null),
          humidity: humidityReading?.rh ?? humidityReading?.value?.rh ?? null,
          timestamp: tempReading?.timestamp || humidityReading?.timestamp || new Date(),
          source: 'bluetooth_gateway',
          connectionType: 'bluetooth',
        };
      }
      return null;
    } catch (error) {
      console.error(`[H&T] BLE gateway poll failed:`, error.message);
      return null;
    }
  }

  /**
   * Poll a sensor via direct WiFi connection (fallback)
   */
  async pollViaDirectWifi(sensor) {
    if (!sensor.ip) return null;

    try {
      const axios = (await import('axios')).default;
      
      // Get full status from H&T Gen3 directly
      const response = await axios.get(`http://${sensor.ip}/rpc/Shelly.GetStatus`, {
        timeout: 8000,
      });

      const status = response.data;
      
      return {
        temperature: status['temperature:0']?.tC ?? null,
        temperatureF: status['temperature:0']?.tF ?? null,
        humidity: status['humidity:0']?.rh ?? null,
        batteryPercent: status['devicepower:0']?.battery?.percent ?? null,
        batteryVoltage: status['devicepower:0']?.battery?.V ?? null,
        rssi: status.wifi?.rssi ?? null,
        timestamp: new Date(),
        source: 'direct_wifi',
        connectionType: 'wifi',
      };
    } catch (error) {
      // H&T is battery-operated and may be asleep
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        // Normal for sleeping battery devices
        return null;
      }
      console.error(`[H&T] Direct WiFi poll failed for ${sensor.ip}:`, error.message);
      return null;
    }
  }

  /**
   * Poll a sensor via Shelly Cloud API (last resort fallback)
   */
  async pollViaCloudApi(sensor) {
    if (!isShellyCloudEnabled()) return null;

    const authKey = process.env.SHELLY_CLOUD_AUTH_KEY;
    const server = process.env.SHELLY_CLOUD_SERVER || 'us';
    
    if (!authKey || !sensor.deviceId) return null;

    try {
      const axios = (await import('axios')).default;
      const response = await axios.get(
        `https://shelly-${server}.shelly.cloud/device/status`,
        {
          params: { id: sensor.deviceId, auth_key: authKey },
          timeout: 8000,
        }
      );

      const deviceStatus = response.data?.data?.device_status;
      if (!deviceStatus) return null;

      return {
        temperature: deviceStatus['temperature:0']?.tC ?? null,
        temperatureF: deviceStatus['temperature:0']?.tF ?? null,
        humidity: deviceStatus['humidity:0']?.rh ?? null,
        batteryPercent: deviceStatus['devicepower:0']?.battery?.percent ?? null,
        rssi: deviceStatus.wifi?.rssi ?? null,
        timestamp: new Date(),
        source: 'cloud_api',
        connectionType: 'cloud',
      };
    } catch (error) {
      console.error(`[H&T] Cloud API poll failed:`, error.message);
      return null;
    }
  }

  /**
   * Start storing trend data at regular intervals for long-term analysis
   * This stores aggregated readings in a separate collection for charts
   */
  startTrendStorage() {
    const intervalMinutes = Math.max(1, Math.floor(this.trendStorageIntervalSeconds / 60));
    
    console.log(`📈 [H&T] Starting trend storage every ${intervalMinutes} min`);

    this.trendInterval = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
      await this.storeTrendData();
    });
  }

  /**
   * Store current readings as a trend data point
   * Saved to a dedicated collection for efficient time-series queries
   */
  async storeTrendData() {
    let isDeleted = null;
    let saveCloudSensorReading = null;
    let bleAddrToCloudDeviceId = null;
    try {
      ({
        isShellyDeviceDeleted: isDeleted,
        saveCloudSensorReading,
        bleAddrToCloudDeviceId,
      } = await import('../iot-cloud-firestore.js'));
    } catch (error) {
      console.warn('[H&T] IoT Firestore unavailable for trend storage:', error.message);
      return;
    }
    if (typeof saveCloudSensorReading !== 'function') return;

    for (const [deviceId, sensor] of this.sensors) {
      if (!sensor.lastReading) continue;

      if (typeof isDeleted === 'function' && await isDeleted(deviceId)) {
        this.unregisterSensor(deviceId);
        continue;
      }

      const { temperature, temperatureF, humidity, timestamp } = sensor.lastReading;
      if (temperature == null && humidity == null) continue;

      // Only save if the reading is fresh (within 2x the trend interval)
      const readingAge = Date.now() - new Date(timestamp).getTime();
      const maxAge = this.trendStorageIntervalSeconds * 2 * 1000;
      if (readingAge > maxAge) {
        console.log(`📈 [H&T] Skipping stale trend for ${deviceId} (reading is ${Math.round(readingAge / 1000)}s old)`);
        continue;
      }

      try {
        // Analytics reads IoT cloud blu-ht-* docs — never the main app project.
        const cloudDeviceId = (sensor.bleAddress && bleAddrToCloudDeviceId)
          ? bleAddrToCloudDeviceId(sensor.bleAddress)
          : (buildLegacyBleHtDeviceId(deviceId) || deviceId);

        await saveCloudSensorReading(cloudDeviceId, {
          temperature: temperature ?? null,
          temperatureF: temperatureF ?? null,
          humidity: humidity ?? null,
          batteryPercent: sensor.lastReading.batteryPercent ?? null,
          bleAddress: sensor.bleAddress || null,
          source: 'ht_trend',
        });
        sensor.lastTrendSave = new Date();

        console.log(`📈 [H&T] Trend point saved for ${cloudDeviceId}: ${temperatureF?.toFixed(1)}°F, ${humidity?.toFixed(0)}%`);
      } catch (error) {
        console.error(`[H&T] Failed to save trend data for ${deviceId}:`, error.message);
      }
    }
  }

  /**
   * Handle incoming webhook from H&T sensor or gateway
   */
  async handleWebhook(webhookData) {
    const { deviceId, event, data } = webhookData;

    console.log(`📥 [H&T] Webhook received: ${event} from ${deviceId}`);

    switch (event) {
      case 'temperature.change':
      case 'temperature.measurement':
        await this.handleTemperatureReading({
          deviceId,
          temperature: data.tC,
          temperatureF: data.tF,
          timestamp: new Date(),
          source: 'webhook',
        });
        break;

      case 'humidity.change':
      case 'humidity.measurement':
        await this.handleHumidityReading({
          deviceId,
          humidity: data.rh,
          timestamp: new Date(),
          source: 'webhook',
        });
        break;

      default:
        console.log(`[H&T] Unhandled webhook event: ${event}`);
    }
  }

  /**
   * Unregister an H&T sensor from in-memory polling (and optional aliases).
   */
  unregisterSensor(deviceId) {
    const aliases = new Set([String(deviceId || '').trim()].filter(Boolean));
    const normalized = String(deviceId || '').replace(/:/g, '').toLowerCase();
    if (normalized.startsWith('blu-ht-')) {
      aliases.add(`shellyhtg3-${normalized.slice('blu-ht-'.length)}`);
    } else if (normalized.startsWith('shellyhtg3-')) {
      aliases.add(`blu-ht-${normalized.slice('shellyhtg3-'.length)}`);
    }

    let removed = 0;
    for (const alias of aliases) {
      if (this.sensors.delete(alias)) removed += 1;
    }

    if (removed > 0) {
      console.log(`🗑️  [H&T] Unregistered ${removed} in-memory sensor alias(es) for ${deviceId}`);
    }

    if (this.sensors.size === 0) {
      this.stopPolling();
    }

    return removed;
  }

  /**
   * Register a new H&T sensor
   */
  async registerSensor(config) {
    const { deviceId, propertyId, location, bleAddress, ip, name } = config;

    try {
      const { clearShellyDeviceDeleted } = await import('../iot-cloud-firestore.js');
      await clearShellyDeviceDeleted(deviceId);
    } catch {
      // Optional — registration should still succeed if tombstone clear fails.
    }

    const sensorConfig = {
      deviceId,
      ip: ip || null,
      bleAddress: bleAddress || null,
      connectionType: bleAddress ? 'bluetooth' : (ip ? 'wifi' : 'cloud'),
      lastReading: null,
      lastTrendSave: null,
    };

    this.sensors.set(deviceId, sensorConfig);

    // Save to Firestore (filter out undefined values to prevent Firestore errors)
    if (firestoreService) {
      try {
        // Check if device already has a custom name — preserve it
        const existingDoc = await firestoreService.getSensor(deviceId);
        const existingName = existingDoc?.name;
        const defaultName = name || `H&T Sensor - ${location || deviceId}`;
        // Keep existing name if it was user-customized (not a default pattern)
        const isDefaultName = !existingName || 
          existingName.startsWith('H&T Sensor - ') || 
          existingName.startsWith('BLU H&T ') || 
          existingName === deviceId;
        
        const sensorData = {
          name: isDefaultName ? defaultName : existingName,
          deviceType: 'shelly_ht_gen3',
          manufacturer: 'Shelly',
          model: 'H&T Gen3',
          type: 'temperature_humidity',
          connectionType: sensorConfig.connectionType,
          capabilities: ['temperature', 'humidity', 'battery'],
        };
        // Only add optional fields if they have values
        if (propertyId) sensorData.propertyId = propertyId;
        if (location) sensorData.location = location;
        if (bleAddress) sensorData.bleAddress = bleAddress;
        if (ip) sensorData.ip = ip;

        await firestoreService.registerSensor(deviceId, sensorData);
        
        console.log(`✅ [H&T] Sensor registered: ${deviceId} at ${location}`);
      } catch (error) {
        console.error(`[H&T] Failed to register sensor in Firestore:`, error.message);
      }
    }

    // BLE sensors are auto-discovered by the gateway's scanner script.
    // No explicit gateway registration needed — data flows automatically.
    if (bleAddress && shellyBluGateway.initialized) {
      console.log(`ℹ️  [H&T] Sensor ${bleAddress} will be auto-detected by BLU Gateway scanner`);
    }

    this.emit('sensor:registered', sensorConfig);

    // Auto-start polling if not already running and we have sensors
    if (!this.isPolling && this.sensors.size > 0) {
      console.log(`🔄 [H&T] Auto-starting polling for newly registered sensor ${deviceId}`);
      this.startPolling();
    }

    return sensorConfig;
  }

  /**
   * Get current status of all H&T sensors
   */
  getStatus() {
    const sensors = [];
    for (const [deviceId, sensor] of this.sensors) {
      sensors.push({
        deviceId,
        connectionType: sensor.connectionType,
        lastReading: sensor.lastReading,
        lastTrendSave: sensor.lastTrendSave,
        hasData: sensor.lastReading != null,
      });
    }

    return {
      initialized: this.initialized,
      polling: this.isPolling,
      pollIntervalSeconds: this.pollIntervalSeconds,
      trendIntervalSeconds: this.trendStorageIntervalSeconds,
      sensorCount: this.sensors.size,
      sensors,
    };
  }

  /**
   * Stop polling and cleanup
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.trendInterval) {
      this.trendInterval.stop?.() || clearInterval(this.trendInterval);
      this.trendInterval = null;
    }
    this.isPolling = false;
    console.log('⏹️  [H&T] Polling stopped');
  }

  /**
   * Shutdown the service
   */
  shutdown() {
    this.stopPolling();
    this.sensors.clear();
    this.initialized = false;
    console.log('🔌 [H&T] Service shut down');
  }
}

export default new ShellyHTService();
