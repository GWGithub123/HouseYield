/**
 * Shelly Unified Manager
 * 
 * Central service that coordinates all Shelly integration methods:
 * - Local HTTP/RPC API (direct device communication)
 * - WebSocket Server (devices push to us)
 * - MQTT Bridge (publish/subscribe)
 * - Webhook endpoints (HTTP POST from devices)
 * 
 * This provides a single interface regardless of connection method.
 */

import { EventEmitter } from 'events';
import shellyLocalApi from './shellyLocalApi.js';
import shellyWsServer from './shellyWebSocketServer.js';
import shellyMqttBridge from './shellyMqttBridge.js';
import shellyBluGateway from './shellyBluGateway.js';
import shellyHTService from './shellyHTService.js';
import { sensorAlertAutomation } from './sensorAlertAutomation.js';
import { resolvePropertyInfoForAlert } from './sensorAlertTenantResolver.js';
import { triggerAutoCloseForProperty, startLeakAutoShutoffMonitor } from './waterShutoffAutomation.js';
import {
  configureFloodShutoffWebhooks,
  listRelayShutoffTargetsForProperty,
} from './shellyLocalShutoff.js';
import { startPropertyPowerMonitor } from './propertyPowerOutageService.js';
import { resolvePublicWebhookUrl } from '../utils/publicWebhookUrl.js';
import { registerCloudDevice, touchCloudDevicePresence, markCloudDeviceOffline } from '../iot-cloud-firestore.js';
import { persistFloodAlertToCloud } from './shellyCloudWebhookHandler.js';
import shellyFloodPresencePoller from './shellyFloodPresencePoller.js';
import shellyRelayPresencePoller from './shellyRelayPresencePoller.js';
import climateHistorySampler from './climateHistorySampler.js';

// Dynamic import for Firestore (loaded at initialization time)
let firestoreService = null;

// Store for property-to-sensor mappings
let propertySensorMappings = new Map();

/** Avoid writing duplicate flood alert docs on every WS status tick while wet. */
const recentFloodPersistAt = new Map();
const FLOOD_PERSIST_COOLDOWN_MS = 5 * 60 * 1000;

function normalizeBleToken(value) {
  return String(value || '').replace(/:/g, '').trim().toLowerCase();
}

function toCanonicalBleHtDeviceId(value) {
  const normalized = normalizeBleToken(value);
  if (!normalized) return '';
  if (normalized.startsWith('shellyhtg3-')) return normalized;
  if (normalized.startsWith('blu-ht-')) return `shellyhtg3-${normalized.slice('blu-ht-'.length)}`;
  return `shellyhtg3-${normalized}`;
}

class ShellyManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // deviceId -> { source, status, config }
    this.alerts = [];
    this.initialized = false;
    this.config = {
      enableWebSocket: true,
      enableMqtt: false, // Enable if you want MQTT
      enableBluGateway: true, // BLU Gateway for BLE sensors
      enableHTSensors: true,  // H&T Gen3 temperature/humidity sensors
      wsPort: 8765,
      mqttPort: 1883,
      webhookSecret: process.env.SHELLY_WEBHOOK_SECRET || 'shelly-secret-key'
    };
  }

  /**
   * Initialize all Shelly services
   */
  async initialize(httpServer = null, options = {}) {
    if (this.initialized) {
      console.log('⚠️  Shelly Manager already initialized');
      return;
    }

    this.config = { ...this.config, ...options };
    console.log('🚀 Initializing Shelly Manager (Direct Integration - No Cloud)...');

    // Load Firestore service dynamically
    try {
      const module = await import('../../backend/services/firestore-service.cjs');
      firestoreService = module.default || module;
      console.log('✅ [Shelly] Firestore service loaded');
    } catch (err) {
      console.log('ℹ️  [Shelly] Firestore not available:', err.message);
    }

    // Setup WebSocket server
    if (this.config.enableWebSocket) {
      if (httpServer) {
        shellyWsServer.start(httpServer);
      } else {
        shellyWsServer.start(this.config.wsPort);
      }
      // Give WebSocket server reference to manager for device data
      shellyWsServer.setManager(this);
      this.setupWebSocketHandlers();
    }

    // Setup MQTT broker (optional)
    if (this.config.enableMqtt) {
      shellyMqttBridge.start(this.config.mqttPort);
      this.setupMqttHandlers();
    }

    // Initialize BLU Gateway (Bluetooth bridge)
    if (this.config.enableBluGateway) {
      try {
        const gatewayOk = await shellyBluGateway.initialize();
        if (gatewayOk) {
          this.setupBluGatewayHandlers();
          console.log('✅ [Shelly] BLU Gateway initialized');
        }
      } catch (err) {
        console.log('ℹ️  [Shelly] BLU Gateway not available:', err.message);
      }
    }

    // Initialize H&T Gen3 sensor service (polling started after device load)
    if (this.config.enableHTSensors) {
      try {
        await shellyHTService.initialize();
        this.setupHTServiceHandlers();
        console.log('✅ [Shelly] H&T sensor service initialized (polling starts after device load)');
      } catch (err) {
        console.log('ℹ️  [Shelly] H&T service not available:', err.message);
      }
    }

    // Load saved device configurations from database
    await this.loadSavedDevices();

    // Start H&T polling AFTER devices are loaded from Firestore
    if (this.config.enableHTSensors && shellyHTService.initialized) {
      shellyHTService.startPolling();
      console.log(`✅ [Shelly] H&T polling started with ${shellyHTService.sensors.size} sensor(s)`);
    }

    // Opportunistic Flood Gen4 LAN presence (only succeeds while sensor is awake)
    shellyFloodPresencePoller.start(60 * 1000);
    // Mains relays: active RPC probe so unplug flips offline within ~30s
    shellyRelayPresencePoller.start(60 * 1000);
    // Analytics charts need sensor_readings history — sample live device docs.
    climateHistorySampler.start(60 * 1000);

    this.initialized = true;
    console.log('✅ Shelly Manager initialized');
    startLeakAutoShutoffMonitor();
    startPropertyPowerMonitor();
    console.log(`   WebSocket: ${this.config.enableWebSocket ? 'Enabled' : 'Disabled'}`);
    console.log(`   MQTT: ${this.config.enableMqtt ? 'Enabled' : 'Disabled'}`);
    console.log(`   BLU Gateway: ${this.config.enableBluGateway ? (shellyBluGateway.initialized ? 'Connected' : 'Configured (not connected)') : 'Disabled'}`);
    console.log(`   H&T Sensors: ${this.config.enableHTSensors ? `${shellyHTService.sensors.size} registered` : 'Disabled'}`);
    console.log('   Flood presence poller: Enabled (LAN, every 60s)');
    console.log('   Relay presence poller: Enabled (every 60s)');
    console.log('   Climate history sampler: Enabled (every 60s)');
    
    return this;
  }

  /**
   * Setup WebSocket event handlers
   */
  setupWebSocketHandlers() {
    shellyWsServer.on('device:connected', async ({ deviceId, ip }) => {
      await this.registerDevice(deviceId, { source: 'websocket', ip });
      this.emit('device:connected', { deviceId, source: 'websocket' });
    });

    shellyWsServer.on('device:disconnected', ({ deviceId }) => {
      this.updateDeviceStatus(deviceId, 'offline');
      this.emit('device:disconnected', { deviceId });
    });

    shellyWsServer.on('status:update', (status) => {
      this.updateDeviceData(status.id, status);
      this.emit('status:update', status);
    });

    shellyWsServer.on('alert:flood', (alert) => {
      this.handleAlert(alert);
    });

    shellyWsServer.on('alert:battery', (alert) => {
      this.handleAlert(alert);
    });
  }

  /**
   * Setup MQTT event handlers
   */
  setupMqttHandlers() {
    shellyMqttBridge.on('device:connected', async ({ deviceId }) => {
      await this.registerDevice(deviceId, { source: 'mqtt' });
      this.emit('device:connected', { deviceId, source: 'mqtt' });
    });

    shellyMqttBridge.on('device:disconnected', ({ deviceId }) => {
      this.updateDeviceStatus(deviceId, 'offline');
      this.emit('device:disconnected', { deviceId });
    });

    shellyMqttBridge.on('status:flood', (status) => {
      this.updateDeviceData(status.deviceId, { isFlooded: status.isFlooded });
      this.emit('status:update', status);
    });

    shellyMqttBridge.on('status:temperature', (status) => {
      this.updateDeviceData(status.deviceId, { 
        temperature: status.celsius,
        temperatureF: status.fahrenheit 
      });
    });

    shellyMqttBridge.on('status:power', (status) => {
      this.updateDeviceData(status.deviceId, { 
        batteryLevel: status.batteryPercent,
        batteryPercent: status.batteryPercent,
        batteryVoltage: status.batteryVoltage
      });
    });

    shellyMqttBridge.on('alert:flood', (alert) => {
      this.handleAlert(alert);
    });

    shellyMqttBridge.on('alert:battery', (alert) => {
      this.handleAlert(alert);
    });
  }

  /**
   * Register a new device
   */
  async registerDevice(deviceId, config = {}) {
    const existing = this.devices.get(deviceId);
    
    const deviceData = {
      id: deviceId,
      source: config.source || 'unknown',
      ip: config.ip || null,
      type: config.type || existing?.type || null,
      name: config.name || deviceId,
      location: config.location || 'Unknown',
      propertyId: config.propertyId || null,
      status: 'online',
      registeredAt: existing?.registeredAt || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      data: existing?.data || {}
    };
    
    this.devices.set(deviceId, deviceData);

    console.log(`📱 Device registered: ${deviceId} via ${config.source}`);
    
    // Auto-save to database (fire and forget, don't block)
    if (!existing) {
      this.saveDevice(deviceId, {
        localIp: config.ip,
        name: config.name || deviceId,
        location: config.location,
        propertyId: config.propertyId
      }).catch(err => console.error(`Failed to auto-save device ${deviceId}:`, err.message));
    }
  }

  /**
   * Update device status. Offline is persisted to Firestore so the dashboard
   * does not keep treating a dead WebSocket as a live relay.
   */
  updateDeviceStatus(deviceId, status) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.status = status;
      if (status !== 'offline') {
        device.lastSeen = new Date().toISOString();
      }
    }

    if (status === 'offline') {
      const offlineUpdate = {
        status: 'offline',
        wentOfflineAt: new Date().toISOString(),
      };
      markCloudDeviceOffline(deviceId).catch((err) => {
        console.warn(`[ShellyManager] Cloud offline write failed for ${deviceId}:`, err.message);
      });
      if (firestoreService?.db) {
        firestoreService.db.collection('shelly_devices').doc(deviceId).set(offlineUpdate, { merge: true }).catch((err) => {
          console.warn(`[ShellyManager] Local offline write failed for ${deviceId}:`, err.message);
        });
      }
    }
  }

  /**
   * Update device data
   */
  updateDeviceData(deviceId, data) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.data = { ...device.data, ...data };
      device.lastSeen = new Date().toISOString();
      if (data.isFlooded != null) device.isFlooded = data.isFlooded;
      if (data.status) device.status = data.status;
    } else {
      // Auto-register if device sends data but wasn't registered
      this.registerDevice(deviceId, { source: 'auto' }).catch(err => 
        console.error(`Failed to auto-register ${deviceId}:`, err.message)
      );
      // Continue updating data immediately
      this.devices.set(deviceId, {
        id: deviceId,
        source: 'auto',
        status: 'online',
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        data
      });
    }

    // Keep IoT Firestore in sync so the dashboard (which reads Firestore, not
    // in-memory WS state) shows online / flood status for local detections.
    const cloudFields = { status: 'online' };
    if (data.isFlooded != null) {
      cloudFields.isFlooded = data.isFlooded;
      cloudFields.flood = data.isFlooded;
    }
    if (data.temperature != null) cloudFields.temperature = data.temperature;
    if (data.temperatureF != null) cloudFields.temperatureF = data.temperatureF;
    if (data.humidity != null) cloudFields.humidity = data.humidity;
    if (data.batteryLevel != null) {
      cloudFields.batteryPercent = data.batteryLevel;
      cloudFields.batteryLevel = data.batteryLevel;
    }
    if (data.batteryPercent != null) {
      cloudFields.batteryPercent = data.batteryPercent;
      cloudFields.batteryLevel = data.batteryPercent;
    }
    touchCloudDevicePresence(deviceId, cloudFields).catch((err) => {
      console.warn(`[Shelly] Cloud presence update failed for ${deviceId}:`, err.message);
    });
  }

  /**
   * Handle incoming alert
   */
  handleAlert(alert) {
    // Add to alerts list
    this.alerts.unshift(alert);
    
    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(0, 100);
    }

    // Emit for external handlers (notifications, database, etc.)
    this.emit('alert', alert);
    
    // Broadcast to all connected WebSocket clients
    shellyWsServer.broadcastToClients({ type: 'alert', alert });
    
    console.log(`🚨 Alert [${alert.type}]: ${alert.message}`);

    // Persist flood alerts to IoT Firestore so the Alerts tab (Firestore listener) sees them.
    if (alert.type === 'flood' && (alert.deviceId || alert.sensorId)) {
      const floodDeviceId = alert.deviceId || alert.sensorId;
      const lastPersist = recentFloodPersistAt.get(floodDeviceId) || 0;
      if (Date.now() - lastPersist >= FLOOD_PERSIST_COOLDOWN_MS) {
        recentFloodPersistAt.set(floodDeviceId, Date.now());
        persistFloodAlertToCloud(floodDeviceId, {
          source: alert.source || 'local_alert',
          isFlooded: true,
          ...(alert.data || {}),
        }).catch((err) => {
          console.error(`[Shelly] Failed to persist flood alert for ${floodDeviceId}:`, err.message);
        });
      }
    }

    // Trigger automated notifications for critical alerts
    if (alert.level === 'critical' || alert.type === 'flood') {
      if (alert.type === 'flood') {
        triggerAutoCloseForProperty({
          propertyId: alert.propertyId,
          triggerId: alert.id,
          sensorDeviceId: alert.deviceId || alert.sensorId,
          source: 'local_alert',
          reason: 'leak',
        }).catch((error) => {
          console.error('[Shelly] Auto water shutoff error:', error.message);
        });
      }

      this.triggerAlertAutomation(alert).catch(err => {
        console.error('[Shelly] Alert automation error:', err.message);
      });
    } else if (alert.type === 'freeze_risk' || alert.type === 'pipe_burst' || alert.type === 'rapid_temp_change') {
      triggerAutoCloseForProperty({
        propertyId: alert.propertyId,
        triggerId: alert.id,
        sensorDeviceId: alert.deviceId || alert.sensorId,
        source: 'local_freeze_alert',
        reason: 'freeze',
      }).catch((error) => {
        console.error('[Shelly] Auto freeze shutoff error:', error.message);
      });
    }
  }

  /**
   * Trigger automated alert notifications (email, SMS, phone call)
   */
  async triggerAlertAutomation(alert) {
    // Get property info for this sensor
    const propertyInfo = await this.getPropertyForSensor(alert.deviceId);
    
    if (!propertyInfo || !propertyInfo.tenants?.length) {
      console.log('[Shelly] No property/tenant found for sensor:', alert.deviceId);
      return;
    }

    const publicUrl = resolvePublicWebhookUrl() || 'http://localhost:3001';

    // Process the alert through the automation service
    const result = await sensorAlertAutomation.processAlert(alert, propertyInfo, {
      sendEmail: true,
      sendSMS: true,
      makePhoneCall: alert.level === 'critical' || alert.type === 'flood',
      createMaintenanceRequest: true,
      publicUrl
    });

    console.log('[Shelly] Alert automation result:', {
      alertId: result.alertId,
      email: result.notifications.email?.ok,
      sms: result.notifications.sms?.ok,
      phoneCall: result.notifications.phoneCall?.ok,
      maintenanceRequest: result.maintenanceRequest?.id
    });

    // Emit the automation result for tracking
    this.emit('alert:automated', result);
    
    return result;
  }

  /**
   * Get property information for a sensor
   * This looks up what property a sensor belongs to and gets tenant info
   */
  async getPropertyForSensor(deviceId) {
    const cached = propertySensorMappings.get(deviceId);
    if (cached?.tenants?.length) {
      return cached;
    }

    const device = this.devices.get(deviceId);
    const propertyId = device?.propertyId || cached?.id || cached?.propertyId || null;
    const ownerId = device?.ownerId || cached?.ownerId || null;

    if (propertyId) {
      try {
        const resolved = await resolvePropertyInfoForAlert({ propertyId, ownerId });
        if (resolved?.tenants?.length) {
          propertySensorMappings.set(deviceId, resolved);
          return resolved;
        }
      } catch (err) {
        console.error('[Shelly] Error resolving property/tenant info:', err.message);
      }
    }

    if (cached) {
      return cached;
    }

    if (device?.propertyId && firestoreService) {
      try {
        const property = await firestoreService.getPropertyById(device.propertyId);
        if (property) {
          propertySensorMappings.set(deviceId, property);
          return property;
        }
      } catch (err) {
        console.error('[Shelly] Error loading property:', err.message);
      }
    }

    return null;
  }

  /**
   * Set property mapping for a sensor
   * Call this when adding/configuring sensors
   */
  setPropertyForSensor(deviceId, propertyInfo) {
    propertySensorMappings.set(deviceId, propertyInfo);
    console.log(`[Shelly] Mapped sensor ${deviceId} to property:`, propertyInfo.address || propertyInfo.id);
  }

  /**
   * Manually trigger alert automation for testing
   */
  async testAlertAutomation(alert, propertyInfo) {
    return sensorAlertAutomation.processAlert(alert, propertyInfo, {
      sendEmail: true,
      sendSMS: true,
      makePhoneCall: true,
      createMaintenanceRequest: true,
      publicUrl: resolvePublicWebhookUrl() || 'http://localhost:3001'
    });
  }

  /**
   * Handle webhook POST from device
   */
  handleWebhook(payload, headers = {}) {
    const { 
      device_id,
      component,
      event,
      flood,
      battery,
      temperature,
      ts
    } = payload;

    const deviceId = device_id || payload.src;
    
    if (!deviceId) {
      console.warn('Webhook received without device ID');
      return { success: false, error: 'Missing device ID' };
    }

    console.log(`📨 Webhook from ${deviceId}:`, { component, event, flood, battery });

    // Update device data
    const updates = {
      lastWebhook: new Date().toISOString()
    };

    if (flood !== undefined) {
      updates.isFlooded = flood;
      
      if (flood) {
        this.handleAlert({
          id: `webhook-flood-${deviceId}-${Date.now()}`,
          type: 'flood',
          level: 'critical',
          deviceId,
          message: `🚨 WATER DETECTED from ${deviceId}!`,
          timestamp: new Date().toISOString(),
          data: payload
        });
      }
    }

    if (battery !== undefined) {
      const pct = typeof battery === 'object' ? battery?.percent : battery;
      if (pct != null && Number.isFinite(Number(pct))) {
        updates.batteryLevel = Number(pct);
        updates.batteryPercent = Number(pct);
      }
    }

    if (temperature !== undefined) {
      updates.temperature = temperature.tC || temperature;
      updates.temperatureF = temperature.tF;
    }

    this.updateDeviceData(deviceId, updates);
    this.emit('webhook', { deviceId, payload });

    // Save temperature/humidity readings to sensor_readings for chart time-series data
    if (temperature !== undefined || payload.humidity !== undefined) {
      const tempC = temperature?.tC ?? temperature;
      const tempF = temperature?.tF ?? (tempC != null ? (tempC * 9/5) + 32 : null);
      const humidity = payload.humidity?.rh ?? payload.humidity;
      
      if (firestoreService && (tempC != null || humidity != null)) {
        firestoreService.saveSensorReading(deviceId, {
          deviceId,
          temperature: tempC ?? null,
          temperatureF: tempF ?? null,
          humidity: humidity ?? null,
          batteryPercent: battery?.percent ?? battery ?? null,
          source: 'webhook',
          type: 'ht_reading',
        }).catch(err => {
          console.error(`[Webhook] Failed to save reading for ${deviceId}:`, err.message);
        });
      }
    }

    return { success: true, deviceId };
  }

  // ==================== DEVICE SETUP ====================

  /**
   * Configure a device in AP mode
   * User must be connected to device's WiFi (e.g., ShellyFloodG4-XXXX)
   */
  async setupDeviceFromAP(wifiSsid, wifiPassword, deviceConfig = {}) {
    const apIp = '192.168.33.1'; // Default Shelly AP IP
    // Flood Gen4 is battery-powered and slow in AP mode; keep RPCs generous
    // but never block on cloud/Firestore while the laptop is on the Shelly AP
    // (that network has no internet).
    const apTimeoutMs = 25000;

    const withTimeout = async (promise, ms, label) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    const isTimeoutError = (error) => /timeout/i.test(String(error?.message || error || ''));

    try {
      const info = await shellyLocalApi.getDeviceInfo(apIp, apTimeoutMs);
      console.log(`📱 Found device: ${info.id} (${info.model})`);

      if (deviceConfig.name) {
        try {
          await shellyLocalApi.setDeviceName(apIp, deviceConfig.name, apTimeoutMs);
        } catch (error) {
          console.warn('[Flood AP] setDeviceName skipped:', error.message);
        }
      }

      // Prefer in-memory relays (instant, works offline on Shelly AP).
      // Firestore lookups hang with ENETUNREACH while the laptop has no internet.
      let relayTargets = [];
      if (deviceConfig.propertyId) {
        for (const [deviceId, device] of this.devices) {
          const type = String(device.type || device.data?.type || '').toLowerCase();
          const deviceType = String(device.data?.deviceType || device.deviceType || '').toLowerCase();
          const caps = device.data?.capabilities || device.capabilities || [];
          const isRelay = type === 'relay_controller'
            || deviceType.includes('relay')
            || (Array.isArray(caps) && caps.includes('water_shutoff'));
          if (!isRelay) continue;
          if (device.propertyId && device.propertyId !== deviceConfig.propertyId) continue;
          relayTargets.push({
            deviceId,
            relayCloseOn: device.data?.relayCloseOn !== false,
            switchId: 0,
            actuationMode: device.data?.actuationMode || 'maintained',
          });
        }

        try {
          const cloudTargets = await withTimeout(
            listRelayShutoffTargetsForProperty(deviceConfig.propertyId),
            1500,
            'Relay lookup',
          );
          if (Array.isArray(cloudTargets) && cloudTargets.length) {
            const byId = new Map(relayTargets.map((t) => [t.deviceId, t]));
            for (const target of cloudTargets) {
              byId.set(target.deviceId, target);
            }
            relayTargets = [...byId.values()];
          }
        } catch (error) {
          console.warn('[Flood AP] Skipping cloud relay lookup (expected offline on Shelly AP):', error.message);
        }
      }

      // Configure cloud + local LAN shutoff webhooks BEFORE WiFi — device drops AP once WiFi is set.
      let configuredWebhooks = [];
      if (deviceConfig.webhookUrl) {
        configuredWebhooks = await configureFloodShutoffWebhooks(
          apIp,
          info.id,
          {
            cloudWebhookUrl: deviceConfig.webhookUrl.split('?')[0],
            relayTargets,
            timeoutMs: apTimeoutMs,
          },
        );
        console.log(
          relayTargets.length
            ? `✅ Cloud + local LAN shutoff webhooks configured (${relayTargets.length} relay target(s))`
            : '✅ Cloud webhooks configured (no relay on property yet — run sync after relay is added)',
        );
      }

      const serverUrl = deviceConfig.serverUrl || '';
      const isLocalServer = /localhost|127\.0\.0\.1|\[::1\]/i.test(serverUrl);
      if (this.config.enableWebSocket && serverUrl && !isLocalServer) {
        try {
          await this.configureDeviceWebSocket(apIp, serverUrl);
        } catch (error) {
          console.warn('[Flood AP] WebSocket config skipped:', error.message);
        }
      } else if (isLocalServer) {
        console.log('ℹ️  Skipping WebSocket config — localhost URL cannot be reached by the sensor');
      }

      // Persist dashboard record before WiFi handoff (best-effort — may be offline).
      await this.registerDevice(info.id, {
        source: 'setup',
        name: deviceConfig.name || info.name,
        location: deviceConfig.location,
        propertyId: deviceConfig.propertyId,
        type: 'flood',
      });

      const savePromise = this.saveDevice(info.id, {
        name: deviceConfig.name || info.name,
        location: deviceConfig.location,
        propertyId: deviceConfig.propertyId,
        type: 'flood',
        deviceType: 'shelly_flood_gen4',
        model: info.model || 'Flood Gen4',
        mac: info.mac,
        firmware: info.firmware,
        connectionType: 'wifi',
        capabilities: ['flood', 'temperature', 'battery'],
        webhookUrl: deviceConfig.webhookUrl
          ? `${deviceConfig.webhookUrl.split('?')[0]}?device_id=${encodeURIComponent(info.id)}&event=flood.alarm`
          : deviceConfig.webhookUrl,
        webhooksConfigured: configuredWebhooks,
        webhooksConfiguredAt: new Date().toISOString(),
        clearTombstone: true,
      }).catch((err) => {
        console.warn('[Flood AP] Firestore save deferred (no internet on Shelly AP):', err.message);
      });
      // Don't wait long for cloud while on the sensor AP.
      await Promise.race([savePromise, new Promise((resolve) => setTimeout(resolve, 2000))]);

      // WiFi last — device reboots and joins the target network after this step.
      let wifiConfigured = false;
      try {
        await shellyLocalApi.configureWifi(apIp, wifiSsid, wifiPassword, apTimeoutMs);
        wifiConfigured = true;
        console.log('✅ WiFi configured');
      } catch (error) {
        // Shelly Flood often drops the AP immediately after accepting Wifi.SetConfig.
        if (isTimeoutError(error)) {
          wifiConfigured = true;
          console.warn('[Flood AP] WiFi SetConfig timed out after accept — treating as success (device likely left AP)');
        } else {
          throw error;
        }
      }

      if (deviceConfig.webhookUrl) {
        try {
          const registerUrl = new URL(deviceConfig.webhookUrl);
          registerUrl.searchParams.set('action', 'register');
          if (process.env.SHELLY_WEBHOOK_SECRET) {
            registerUrl.searchParams.set('secret', process.env.SHELLY_WEBHOOK_SECRET);
          }
          await withTimeout(fetch(registerUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'register',
              deviceId: info.id,
              name: deviceConfig.name || info.name || `Flood Sensor ${info.id.slice(-4)}`,
              location: deviceConfig.location || 'Unknown',
              model: info.model,
              mac: info.mac,
              firmware: info.firmware,
              propertyId: deviceConfig.propertyId || null,
              type: 'flood',
            }),
          }), 2500, 'Cloud register');
          console.log('✅ Device registered in Firebase cloud');
        } catch (registerErr) {
          console.warn('Firebase cloud register skipped (reconnect to HouseYield-IoT to finalize):', registerErr.message);
        }
      }

      return {
        success: true,
        deviceId: info.id,
        configuredWebhooks,
        wifiConfigured,
        message: `Device configured${wifiConfigured ? '' : ' (WiFi handoff uncertain)'}. Switch your computer back to "${wifiSsid}" — the sensor is joining now. Then wake it and use Reconfigure flood webhooks if alerts do not appear.`,
      };

    } catch (error) {
      console.error('Device setup failed:', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Configure device to connect via outbound WebSocket
   */
  async configureDeviceWebSocket(ip, serverWsUrl) {
    try {
      await shellyLocalApi.rpc(ip, 'Ws.SetConfig', {
        config: {
          enable: true,
          server: serverWsUrl,
          ssl_ca: '*' // Accept any SSL cert (use proper cert in production)
        }
      });
      console.log(`✅ WebSocket configured: ${serverWsUrl}`);
      return true;
    } catch (error) {
      console.error('Failed to configure WebSocket:', error.message);
      return false;
    }
  }

  /**
   * Configure device MQTT settings
   */
  async configureDeviceMqtt(ip, mqttServer, options = {}) {
    try {
      await shellyLocalApi.rpc(ip, 'Mqtt.SetConfig', {
        config: {
          enable: true,
          server: mqttServer,
          client_id: options.clientId,
          user: options.username,
          pass: options.password,
          topic_prefix: options.topicPrefix
        }
      });
      console.log(`✅ MQTT configured: ${mqttServer}`);
      return true;
    } catch (error) {
      console.error('Failed to configure MQTT:', error.message);
      return false;
    }
  }

  // ==================== DATA ACCESS ====================

  /**
   * Get all devices with current status
   */
  async getAllDevices() {
    const devices = [];

    // Get devices from all sources
    for (const [deviceId, device] of this.devices) {
      let currentData = device.data;

      // Try to get fresh data from WebSocket
      if (device.source === 'websocket') {
        const wsStatus = shellyWsServer.getDeviceStatus(deviceId);
        if (wsStatus) {
          currentData = { ...currentData, ...wsStatus };
        }
      }

      // Try to get fresh data from MQTT
      if (device.source === 'mqtt' && this.config.enableMqtt) {
        const mqttStatus = shellyMqttBridge.getDeviceStatus(deviceId);
        if (mqttStatus) {
          currentData = { ...currentData, ...mqttStatus };
        }
      }

      devices.push({
        id: deviceId,
        type: (() => {
          const t = String(device.type || '').toLowerCase();
          const id = String(deviceId || '').toLowerCase();
          if (t === 'relay_controller' || t === 'shelly_relay_gen4' || id.includes('1g4')) return 'relay_controller';
          if (t === 'ble_gateway' || t === 'gateway' || id.includes('blugw') || id.includes('sngw')) return 'ble_gateway';
          if (
            t === 'temperature_humidity'
            || t === 'ht'
            || t.includes('ht')
            || id.startsWith('blu-ht-')
            || id.includes('shellyht')
          ) return 'temperature_humidity';
          if (t === 'flood' || t === 'water_leak' || id.includes('flood')) return 'water_leak';
          return t || 'unknown';
        })(),
        source: device.source,
        ip: device.ip || null,
        name: device.name || deviceId,
        location: device.location || 'Unknown',
        propertyId: device.propertyId,
        status: device.status,
        isFlooded: currentData.isFlooded || false,
        temperature: currentData.temperature,
        temperatureF: currentData.temperatureF,
        humidity: currentData.humidity,
        batteryLevel: currentData.batteryLevel ?? currentData.batteryPercent ?? null,
        rssi: currentData.rssi,
        connectionType: device.connectionType || currentData.connectionType || null,
        bleAddress: device.bleAddress || currentData.bleAddress || null,
        relayOutputOn: currentData.relayOutputOn === true,
        valveState: currentData.valveState || 'unknown',
        lastValveCommand: currentData.lastValveCommand || null,
        lastValveCommandAt: currentData.lastValveCommandAt || null,
        pulseDurationMs: currentData.pulseDurationMs ?? null,
        actuationMode: currentData.actuationMode === 'momentary' ? 'momentary' : 'maintained',
        relayCloseOn: currentData.relayCloseOn !== false,
        lastUpdate: device.lastSeen,
        registeredAt: device.registeredAt
      });
    }

    return devices;
  }

  /**
   * Get single device status
   */
  async getDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;

    // Try to get fresh data via local API if we have IP
    if (device.ip) {
      try {
        const liveData = await shellyLocalApi.getCompleteSensorData(device.ip);
        if (liveData) {
          return { ...device, ...liveData, source: 'local' };
        }
      } catch (error) {
        // Fall back to cached data
      }
    }

    return {
      id: deviceId,
      ...device,
      ...device.data
    };
  }

  /**
   * Get all alerts
   */
  getAlerts(unacknowledgedOnly = false) {
    if (unacknowledgedOnly) {
      return this.alerts.filter(a => !a.acknowledged);
    }
    return this.alerts;
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  /**
   * Load saved devices from database
   * Auto-discovers gateways and H&T sensors — no .env config needed
   */
  async loadSavedDevices() {
    try {
      if (!firestoreService || typeof firestoreService.getAllSensors !== 'function') {
        console.log('ℹ️  Firestore getAllSensors not available');
        return;
      }

      const savedDevices = await firestoreService.getAllSensors();
      let isDeleted = null;
      try {
        ({ isShellyDeviceDeleted: isDeleted } = await import('../iot-cloud-firestore.js'));
      } catch {
        isDeleted = null;
      }
      
      let loadedCount = 0;
      for (const sensor of savedDevices) {
        if (typeof isDeleted === 'function' && await isDeleted(sensor.id)) {
          console.log(`⏭️  Skipping tombstoned device on load: ${sensor.id}`);
          continue;
        }

        let type = sensor.deviceType || '';
        
        // Auto-detect device type from ID if saved with wrong type
        if (sensor.id.includes('blugw')) type = 'ble_gateway';
        else if (sensor.id.includes('shellyhtg3') || sensor.id.includes('shellyht')) type = 'shelly_ht';
        else if (!type) type = 'shelly_flood_gen4';
        
        // Fix mistyped records in Firestore (one-time correction)
        if (type !== sensor.deviceType && sensor.deviceType) {
          console.log(`🔧 Correcting device type for ${sensor.id}: ${sensor.deviceType} → ${type}`);
          this.saveDevice(sensor.id, { deviceType: type }).catch(() => {});
        }

        // Register in memory
        this.devices.set(sensor.id, {
          id: sensor.id,
          source: 'database',
          type: type,
          ip: sensor.localIp || null,
          name: sensor.name || sensor.location || sensor.id,
          location: sensor.location || 'Unknown',
          propertyId: sensor.propertyId || null,
          status: 'online',
          registeredAt: sensor.registeredAt || new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          data: {}
        });
        loadedCount++;
        console.log(`📱 Loaded device from DB: ${sensor.id} (${type})`);

        // Auto-init BLU Gateway if found in DB but not yet initialized
        if (type === 'ble_gateway' && !shellyBluGateway.initialized) {
          console.log(`📡 Auto-discovered BLU Gateway from Firestore: ${sensor.id}`);
          try {
            shellyBluGateway.gatewayId = sensor.id;
            if (sensor.localIp) {
              shellyBluGateway.gatewayIp = sensor.localIp;
            }
            const ok = await shellyBluGateway.initialize();
            if (ok) {
              this.setupBluGatewayHandlers();
              console.log('✅ [Shelly] BLU Gateway auto-initialized from Firestore');
            }
            // Always try to find the local IP if we don't have one —
            // even if cloud-mode init "succeeded", we need local IP for RPC calls
            if (!sensor.localIp && !shellyBluGateway.gatewayIp) {
              console.log('🔍 No local IP for gateway — scanning network in background...');
              this._backgroundFindGateway(sensor.id);
            }
          } catch (err) {
            console.log('ℹ️  BLU Gateway found in DB but not reachable yet:', err.message);
            if (!sensor.localIp) {
              this._backgroundFindGateway(sensor.id);
            }
          }
        }

        // Auto-register H&T sensors
        if (type === 'shelly_ht' && this.config.enableHTSensors) {
          try {
            shellyHTService.registerSensor({
              deviceId: sensor.id,
              ip: sensor.localIp || sensor.ip,
              bleAddress: sensor.bleAddress,
              name: sensor.name,
              location: sensor.location,
              propertyId: sensor.propertyId,
            });
          } catch (err) {
            // Already registered or service not ready — fine
          }
        }
      }

      console.log(`📂 Loaded ${loadedCount} saved Shelly devices from Firestore`);
    } catch (error) {
      console.log('ℹ️  Error loading saved devices:', error.message);
    }
  }

  /**
   * Save device to database
   */
  async saveDevice(deviceId, data) {
    try {
      const clearTombstone = data?.clearTombstone === true;
      const payload = { ...data };
      delete payload.clearTombstone;

      const idLower = String(deviceId || '').toLowerCase();
      const modelLower = String(payload.model || '').toLowerCase();
      const inferredType = payload.type || payload.deviceType || (
        idLower.includes('blugw') || idLower.includes('sngw') || modelLower.includes('sngw') || modelLower.includes('gateway')
          ? 'ble_gateway'
          : idLower.includes('1g4') || idLower.includes('shelly1') ? 'relay_controller'
          : idLower.includes('ht') ? 'shelly_ht'
          : idLower.includes('flood') ? 'shelly_flood_gen4'
          : 'unknown'
      );
      const normalizedType = inferredType === 'shelly_flood_gen4' ? 'flood'
        : inferredType === 'shelly_ht' || inferredType === 'shelly_ht_gen3' ? 'temperature_humidity'
        : inferredType === 'shelly_relay_gen4' ? 'relay_controller'
        : inferredType;
      const inferredModel = payload.model || (
        inferredType === 'ble_gateway' ? 'BLU Gateway GWF-KZ01' :
        inferredType === 'shelly_ht' ? 'H&T Gen3' :
        inferredType === 'shelly_relay_gen4' || inferredType === 'relay_controller' ? 'Shelly 1 Gen4' :
        'Flood Gen4'
      );

      const cleanData = Object.fromEntries(
        Object.entries({
          deviceType: inferredType,
          type: normalizedType,
          manufacturer: 'Shelly',
          model: inferredModel,
          connectionType: payload.connectionType || (deviceId.includes('ht') ? 'bluetooth_gateway' : 'wifi'),
          capabilities: payload.capabilities || (
            normalizedType === 'flood' ? ['flood', 'temperature', 'battery'] : undefined
          ),
          ...payload,
        }).filter(([_, value]) => value !== undefined),
      );

      await registerCloudDevice(deviceId, cleanData, { clearTombstone });
      console.log(`💾 Device ${deviceId} saved to IoT cloud database`);

      if (firestoreService && typeof firestoreService.registerSensor === 'function') {
        await firestoreService.registerSensor(deviceId, cleanData).catch((error) => {
          console.warn(`Legacy Firestore mirror failed for ${deviceId}:`, error.message);
        });
      }
    } catch (error) {
      console.error('Failed to save device:', error.message);
    }
  }

  // ==================== DIRECT DEVICE CONTROL ====================

  /**
   * Get fresh status from device via local API
   */
  async refreshDeviceStatus(deviceId) {
    const device = this.devices.get(deviceId);
    
    if (!device?.ip) {
      throw new Error('Device IP not known. Device must be on local network.');
    }

    const data = await shellyLocalApi.getCompleteSensorData(device.ip);
    
    if (data) {
      this.updateDeviceData(deviceId, data);
      return data;
    }

    throw new Error('Could not reach device');
  }

  /**
   * Reboot a device
   */
  async rebootDevice(deviceId) {
    const device = this.devices.get(deviceId);
    
    if (!device?.ip) {
      throw new Error('Device IP not known');
    }

    await shellyLocalApi.reboot(device.ip);
    return true;
  }

  /**
   * Get system health status
   */
  getHealthStatus() {
    const connectedWs = this.config.enableWebSocket ? 
      shellyWsServer.getConnectedDevices().length : 0;
    const connectedMqtt = this.config.enableMqtt ? 
      shellyMqttBridge.getAllDevices().length : 0;

    return {
      initialized: this.initialized,
      totalDevices: this.devices.size,
      websocket: {
        enabled: this.config.enableWebSocket,
        connectedDevices: connectedWs
      },
      mqtt: {
        enabled: this.config.enableMqtt,
        connectedDevices: connectedMqtt
      },
      bluGateway: {
        enabled: this.config.enableBluGateway,
        initialized: shellyBluGateway.initialized,
        ip: shellyBluGateway.gatewayIp,
        discoveredBleDevices: shellyBluGateway.discoveredDevices.size,
        scriptDeployed: shellyBluGateway.scriptDeployed,
      },
      htSensors: {
        enabled: this.config.enableHTSensors,
        ...shellyHTService.getStatus(),
      },
      alerts: {
        total: this.alerts.length,
        unacknowledged: this.alerts.filter(a => !a.acknowledged).length
      }
    };
  }

  /**
   * Background scan to find gateway IP on local network
   */
  _backgroundFindGateway(gatewayId) {
    // Run in background — don't await
    (async () => {
      try {
        // Wait a bit for the network to be ready
        await new Promise(r => setTimeout(r, 5000));
        console.log(`🔍 Background scan: looking for gateway ${gatewayId} on local network...`);
        
        const foundIp = await shellyLocalApi.findDeviceOnNetwork(gatewayId);
        if (foundIp) {
          console.log(`✅ Background scan found gateway at ${foundIp}`);
          shellyBluGateway.gatewayIp = foundIp;
          
          // Update Firestore with the discovered IP
          try {
            const admin = require('firebase-admin');
            const db = admin.firestore();
            await db.collection('shelly_devices').doc(gatewayId).set({
              localIp: foundIp,
              ip: foundIp,
              lastSeen: new Date().toISOString(),
              status: 'online'
            }, { merge: true });
            console.log(`💾 Saved gateway IP ${foundIp} to Firestore`);
          } catch (dbErr) {
            console.log('⚠️  Could not save gateway IP to Firestore:', dbErr.message);
          }

          // Re-initialize with local connection
          shellyBluGateway.initialized = false;
          const ok = await shellyBluGateway.initialize();
          if (ok) {
            this.setupBluGatewayHandlers();
            console.log('✅ [Shelly] BLU Gateway re-initialized with local IP after network scan');
          }

          // Update in-memory device record
          const dev = this.devices.get(gatewayId);
          if (dev) {
            dev.ip = foundIp;
            dev.status = 'online';
          }
        } else {
          console.log('ℹ️  Background scan: gateway not found on network (may be offline or on different subnet)');
        }
      } catch (err) {
        console.log('ℹ️  Background gateway scan failed:', err.message);
      }
    })();
  }

  /**
   * Setup BLU Gateway event handlers
   * Note: The Script-based scanner emits events with 'addr' (BLE MAC address)
   * rather than 'deviceId', since devices are discovered passively.
   */
  setupBluGatewayHandlers() {
    // Prevent duplicate handler registration
    if (this._bluGatewayHandlersSet) return;
    this._bluGatewayHandlersSet = true;

    shellyBluGateway.on('sensor:temperature', async (data) => {
      const deviceId = toCanonicalBleHtDeviceId(data.deviceId || data.addr) || data.deviceId || null;
      if (!deviceId) return;
      this.updateDeviceData(deviceId, {
        temperature: data.temperature,
        connectionType: 'bluetooth',
      });
      this.emit('status:update', { ...data, deviceId, source: 'bluetooth_gateway' });
    });

    shellyBluGateway.on('sensor:humidity', async (data) => {
      const deviceId = toCanonicalBleHtDeviceId(data.deviceId || data.addr) || data.deviceId || null;
      if (!deviceId) return;
      this.updateDeviceData(deviceId, {
        humidity: data.humidity,
        connectionType: 'bluetooth',
      });
      this.emit('status:update', { ...data, deviceId, source: 'bluetooth_gateway' });
    });

    shellyBluGateway.on('sensor:battery', async (data) => {
      const deviceId = toCanonicalBleHtDeviceId(data.deviceId || data.addr) || data.deviceId || null;
      if (!deviceId) return;
      this.updateDeviceData(deviceId, {
        batteryLevel: data.battery,
        connectionType: 'bluetooth',
      });
    });

    // sensor:update fires for every BLE broadcast received — update Firestore lastSeen
    shellyBluGateway.on('sensor:update', async (device) => {
      if (!device?.addr) return;
      // Update the gateway's own lastSeen in Firestore (keeps it "online")
      const gwDocId = shellyBluGateway.gatewayId;
      if (gwDocId) {
        this._throttledGatewayLastSeen(gwDocId);
      }
    });

    shellyBluGateway.on('gateway:connected', () => {
      console.log('🟢 BLU Gateway connected');
      this.emit('gateway:online');
    });

    shellyBluGateway.on('gateway:unreachable', () => {
      console.warn('⚠️  BLU Gateway became unreachable');
      this.emit('gateway:offline');
    });
  }

  /**
   * Throttled update of gateway lastSeen in Firestore (max once per 30s)
   * to avoid excessive writes when BLE data is streaming in.
   */
  _throttledGatewayLastSeen(docId) {
    const now = Date.now();
    if (this._lastGatewayFirestoreUpdate && now - this._lastGatewayFirestoreUpdate < 30000) return;
    this._lastGatewayFirestoreUpdate = now;

    (async () => {
      try {
        await touchCloudDevicePresence(docId, {
          type: 'ble_gateway',
          connectionType: 'wifi',
          scriptDeployed: shellyBluGateway.scriptDeployed,
          localIp: shellyBluGateway.gatewayIp,
          ip: shellyBluGateway.gatewayIp,
        });
      } catch (err) {
        // ignore
      }
    })();
  }

  /**
   * Setup H&T sensor service event handlers
   */
  setupHTServiceHandlers() {
    shellyHTService.on('temperature', async (data) => {
      // Broadcast to WebSocket clients
      shellyWsServer.broadcastToClients({
        type: 'status',
        source: 'ht_sensor',
        data: {
          deviceId: data.deviceId,
          temperature: data.tempC,
          temperatureF: data.tempF,
          timestamp: data.timestamp,
        }
      });

      // Check for freeze/pipe burst alerts
      const tempF = data.tempF;
      if (tempF != null && tempF <= 38) {
        const deviceRecord = this.devices.get(data.deviceId);
        this.handleAlert({
          id: `alert-freeze-${data.deviceId}-${Date.now()}`,
          type: tempF <= 20 ? 'pipe_burst' : 'freeze_risk',
          level: tempF <= 20 ? 'critical' : (tempF <= 32 ? 'critical' : 'warning'),
          deviceId: data.deviceId,
          propertyId: deviceRecord?.propertyId || null,
          message: tempF <= 20
            ? `🚨 PIPE BURST RISK: ${tempF.toFixed(0)}°F at ${data.deviceId}`
            : tempF <= 32
              ? `🥶 Freeze detected: ${tempF.toFixed(0)}°F at ${data.deviceId}`
              : `🥶 Freeze warning: ${tempF.toFixed(0)}°F at ${data.deviceId}`,
          timestamp: new Date().toISOString(),
          data: { temperature: data.tempC, temperatureF: tempF },
        });
      }
    });

    shellyHTService.on('humidity', async (data) => {
      // Broadcast to WebSocket clients
      shellyWsServer.broadcastToClients({
        type: 'status',
        source: 'ht_sensor',
        data: {
          deviceId: data.deviceId,
          humidity: data.humidity,
          timestamp: data.timestamp,
        }
      });

      // Check for sustained high humidity (mold risk)
      if (data.humidity >= 75) {
        this.handleAlert({
          id: `alert-humidity-${data.deviceId}-${Date.now()}`,
          type: 'mold_risk',
          level: data.humidity >= 85 ? 'critical' : 'warning',
          deviceId: data.deviceId,
          message: `💧 High humidity: ${data.humidity.toFixed(0)}% at ${data.deviceId}`,
          timestamp: new Date().toISOString(),
          data: { humidity: data.humidity },
        });
      }
    });

    shellyHTService.on('sensor:registered', (config) => {
      console.log(`🌡️ H&T sensor registered in manager: ${config.deviceId}`);
      this.registerDevice(config.deviceId, {
        source: config.connectionType === 'bluetooth' ? 'bluetooth' : 'wifi',
        type: 'temperature_humidity',
      });
    });
  }

  /**
   * Get BLU Gateway service reference
   */
  getBluGateway() {
    return shellyBluGateway;
  }

  /**
   * Get H&T service reference
   */
  getHTService() {
    return shellyHTService;
  }

  /**
   * Shutdown all services
   */
  shutdown() {
    if (this.config.enableWebSocket) {
      shellyWsServer.stop();
    }
    if (this.config.enableMqtt) {
      shellyMqttBridge.stop();
    }
    if (this.config.enableBluGateway) {
      shellyBluGateway.shutdown();
    }
    if (this.config.enableHTSensors) {
      shellyHTService.shutdown();
    }
    console.log('🛑 Shelly Manager shutdown complete');
  }
}

// Export singleton
const shellyManager = new ShellyManager();
export default shellyManager;
