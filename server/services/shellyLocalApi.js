/**
 * Shelly Flood Gen4 - Local API Service
 * 
 * Direct HTTP/RPC communication with Shelly devices on local network.
 * This bypasses the cloud for faster response times and offline capability.
 * 
 * Shelly Gen4 devices use JSON-RPC 2.0 over HTTP for local control.
 * Default device IP when in AP mode: 192.168.33.1
 * 
 * @see https://shelly-api-docs.shelly.cloud/gen2/
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import os from 'os';
import { execSync } from 'child_process';

class ShellyLocalApi extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // deviceId -> { ip, name, lastSeen, status }
    this.discoveryInterval = null;
  }

  /**
   * Get device status via local HTTP RPC
   * @param {string} ip - Device IP address
   * @param {string} method - RPC method name
   * @param {object} params - RPC parameters
   */
  async rpc(ip, method, params = {}, timeoutMs = 5000) {
    try {
      const response = await axios.post(
        `http://${ip}/rpc`,
        {
          id: Date.now(),
          method,
          params
        },
        {
          timeout: timeoutMs,
          headers: { 'Content-Type': 'application/json' }
        }
      );
      return response.data.result;
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        throw new Error(`Device at ${ip} is not reachable`);
      }
      throw error;
    }
  }

  /**
   * Get basic device info
   */
  async getDeviceInfo(ip, timeoutMs = 5000) {
    const info = await this.rpc(ip, 'Shelly.GetDeviceInfo', {}, timeoutMs);
    return {
      id: info.id,
      name: info.name || `Shelly ${info.model}`,
      model: info.model,
      mac: info.mac,
      firmware: info.fw_id,
      app: info.app,
      gen: info.gen,
      profile: info.profile
    };
  }

  /**
   * Get comprehensive device status (all components)
   */
  async getStatus(ip) {
    const status = await this.rpc(ip, 'Shelly.GetStatus');
    return status;
  }

  /**
   * Get flood sensor specific status
   * Returns: { flood: boolean, last_alarm_ts: number }
   */
  async getFloodStatus(ip) {
    try {
      const status = await this.rpc(ip, 'Flood.GetStatus', { id: 0 });
      return {
        isFlooded: status.flood || false,
        lastAlarmTime: status.last_alarm_ts ? new Date(status.last_alarm_ts * 1000) : null
      };
    } catch (error) {
      // Fallback to full status if Flood component not available
      const fullStatus = await this.getStatus(ip);
      const flood = fullStatus['flood:0'] || {};
      return {
        isFlooded: flood.flood || false,
        lastAlarmTime: flood.last_alarm_ts ? new Date(flood.last_alarm_ts * 1000) : null
      };
    }
  }

  /**
   * Get battery/power status
   */
  async getPowerStatus(ip) {
    try {
      const status = await this.rpc(ip, 'DevicePower.GetStatus', { id: 0 });
      return {
        batteryPercent: status.battery?.percent ?? null,
        batteryVoltage: status.battery?.V || null,
        external: status.external || null
      };
    } catch (error) {
      const fullStatus = await this.getStatus(ip);
      const power = fullStatus['devicepower:0'] || {};
      return {
        batteryPercent: power.battery?.percent ?? null,
        batteryVoltage: power.battery?.V || null,
        external: power.external || null
      };
    }
  }

  /**
   * Get temperature reading
   */
  async getTemperature(ip) {
    try {
      const status = await this.rpc(ip, 'Temperature.GetStatus', { id: 0 });
      return {
        celsius: status.tC,
        fahrenheit: status.tF
      };
    } catch (error) {
      const fullStatus = await this.getStatus(ip);
      const temp = fullStatus['temperature:0'] || {};
      return {
        celsius: temp.tC || null,
        fahrenheit: temp.tF || null
      };
    }
  }

  /**
   * Get WiFi status
   */
  async getWifiStatus(ip) {
    const status = await this.getStatus(ip);
    const wifi = status.wifi || {};
    return {
      connected: wifi.sta_ip !== null,
      ssid: wifi.ssid,
      ip: wifi.sta_ip,
      rssi: wifi.rssi,
      apEnabled: wifi.ap_client_count !== undefined
    };
  }

  /**
   * Get complete sensor data formatted for dashboard
   */
  async getCompleteSensorData(ip) {
    try {
      const [info, status] = await Promise.all([
        this.getDeviceInfo(ip),
        this.getStatus(ip)
      ]);

      const flood = status['flood:0'] || {};
      const power = status['devicepower:0'] || {};
      const temp = status['temperature:0'] || {};
      const relay = status['switch:0'] || {};
      const wifi = status.wifi || {};
      const sys = status.sys || {};
      const inferredType = this.inferDeviceType(info);

      return {
        id: info.id,
        type: inferredType === 'relay_controller' ? 'relay_controller' : 'water_leak',
        source: 'local',
        name: info.name,
        model: info.model,
        firmware: info.firmware,
        mac: info.mac,
        ip: ip,
        
        // Flood detection
        isFlooded: flood.flood || false,
        lastAlarmTime: flood.last_alarm_ts ? new Date(flood.last_alarm_ts * 1000).toISOString() : null,
        
        // Battery
        batteryLevel: power.battery?.percent ?? null,
        batteryVoltage: power.battery?.V || null,
        
        // Temperature
        temperature: temp.tC || null,
        temperatureF: temp.tF || null,

        // Relay output status
        relayOutputOn: relay.output === true,
        relayApower: relay.apower ?? null,
        
        // Connectivity
        rssi: wifi.rssi || null,
        ssid: wifi.ssid || null,
        localIp: wifi.sta_ip || ip,
        
        // System
        uptime: sys.uptime || 0,
        availableUpdates: sys.available_updates || null,
        
        // Status
        status: wifi.sta_ip ? 'online' : 'offline',
        lastUpdate: new Date().toISOString(),
        
        // Raw data for debugging
        _raw: { info, status }
      };
    } catch (error) {
      console.error(`Error getting sensor data from ${ip}:`, error.message);
      return null;
    }
  }

  // ==================== DEVICE CONFIGURATION ====================

  /**
   * Configure device WiFi settings (used during initial setup)
   * Call this when connected to device's AP mode
   * Per Shelly docs: method is 'Wifi.SetConfig' (lowercase 'f')
   */
  async configureWifi(ip, ssid, password, timeoutMs = 5000) {
    try {
      // Set WiFi station config — Shelly docs: Wifi.SetConfig (not WiFi)
      await this.rpc(ip, 'Wifi.SetConfig', {
        config: {
          sta: {
            ssid: ssid,
            pass: password,
            enable: true
          },
          ap: {
            enable: false  // Disable AP after setup
          }
        }
      }, timeoutMs);

      console.log(`✅ WiFi configured for device at ${ip}`);
      return true;
    } catch (error) {
      console.error('Failed to configure WiFi:', error.message);
      throw error;
    }
  }

  /**
   * Set device name
   */
  async setDeviceName(ip, name, timeoutMs = 5000) {
    await this.rpc(ip, 'Sys.SetConfig', {
      config: {
        device: { name }
      }
    }, timeoutMs);
    return true;
  }

  /**
   * Build a Flood Gen4 cloud webhook URL with Shelly status templates.
   * Battery comes from devicepower:0 (same as H&T) — without these templates
   * the backend never receives a real percent on alarm/status/wake.
   */
  buildFloodCloudWebhookUrl(baseUrl, deviceId, event) {
    const base = String(baseUrl || '').split('?')[0];
    const id = encodeURIComponent(deviceId);
    const ev = encodeURIComponent(event);
    // Do not encode ${...} — Shelly expands these on the device before the HTTP call.
    return `${base}?device_id=${id}&event=${ev}`
      + `&battery=\${status["devicepower:0"].battery.percent}`
      + `&battery_v=\${status["devicepower:0"].battery.V}`
      + `&tC=\${status["temperature:0"].tC}`
      + `&tF=\${status["temperature:0"].tF}`
      + `&alarm=\${status["flood:0"].alarm}`;
  }

  /**
   * Configure Firebase webhooks for Flood Gen4 (must run before WiFi.SetConfig).
   */
  async configureFirebaseFloodWebhooks(ip, deviceId, firebaseWebhookUrl, options = {}) {
    const timeoutMs = options.timeout || 15000;
    const rpc = (method, params) => this.rpc(ip, method, params, timeoutMs);
    const configuredWebhooks = [];
    const buildUrl = (event) => this.buildFloodCloudWebhookUrl(firebaseWebhookUrl, deviceId, event);

    try {
      const hooks = await rpc('Webhook.List');
      if (hooks.hooks?.length) {
        for (const hook of hooks.hooks) {
          await rpc('Webhook.Delete', { id: hook.id });
          console.log(`   Deleted existing webhook: ${hook.id}`);
        }
      }
    } catch (err) {
      console.log('   No existing webhooks to delete');
    }

    const floodWebhook = buildUrl('flood.alarm');
    await rpc('Webhook.Create', {
      cid: 0,
      enable: true,
      event: 'flood.alarm',
      name: 'firebase_flood_alert',
      urls: [floodWebhook],
    });
    configuredWebhooks.push('flood.alarm');
    console.log(`   ✅ Webhook configured: flood.alarm -> Firebase (with battery)`);

    try {
      const statusWebhook = buildUrl('status');
      await rpc('Webhook.Create', {
        cid: 1,
        enable: true,
        event: 'flood:0.status',
        name: 'firebase_status',
        urls: [statusWebhook],
      });
      configuredWebhooks.push('flood:0.status');
      console.log(`   ✅ Webhook configured: status -> Firebase (with battery)`);
    } catch (err) {
      console.log('   Status webhook not supported, skipping');
    }

    // Button wake → refresh lastSeen so UI leaves "Sleeping" + refresh battery %
    const buttonEvents = [
      { event: 'input:0.button_push', name: 'firebase_button_push' },
      { event: 'input.button_push', name: 'firebase_button_push_alt' },
      { event: 'input:0.single_push', name: 'firebase_single_push' },
    ];
    for (const entry of buttonEvents) {
      try {
        const wakeWebhook = buildUrl(entry.event);
        await rpc('Webhook.Create', {
          cid: 0,
          enable: true,
          event: entry.event,
          name: entry.name,
          urls: [wakeWebhook],
        });
        configuredWebhooks.push(entry.event);
        console.log(`   ✅ Webhook configured: ${entry.event} -> Firebase (with battery)`);
        break;
      } catch (err) {
        console.log(`   ${entry.event} webhook not supported, trying next`);
      }
    }

    return configuredWebhooks;
  }

  /**
   * Configure webhook for flood alerts
   * This makes the device push alerts to your server
   */
  async configureWebhook(ip, webhookUrl, deviceId = null) {
    if (deviceId && webhookUrl) {
      return this.configureFirebaseFloodWebhooks(ip, deviceId, webhookUrl.split('?')[0]);
    }

    try {
      // Create webhook for flood detection
      await this.rpc(ip, 'Webhook.Create', {
        cid: 0,  // Component ID (flood:0)
        enable: true,
        event: 'flood.alarm',
        name: 'flood_alert',
        urls: [webhookUrl]
      });

      console.log(`✅ Webhook configured for flood alerts -> ${webhookUrl}`);
      return true;
    } catch (error) {
      // Webhook might already exist, try to update
      try {
        const hooks = await this.rpc(ip, 'Webhook.List');
        const existing = hooks.hooks?.find(h => h.name === 'flood_alert');
        
        if (existing) {
          await this.rpc(ip, 'Webhook.Update', {
            id: existing.id,
            enable: true,
            urls: [webhookUrl]
          });
          console.log(`✅ Webhook updated for flood alerts`);
          return true;
        }
      } catch (updateError) {
        console.error('Failed to configure webhook:', updateError.message);
      }
      throw error;
    }
  }

  /**
   * Configure webhooks specifically for H&T Gen3 sensors
   * Creates webhooks for temperature.change and humidity.change events
   */
  async configureHTWebhooks(ip, webhookUrl, deviceId) {
    const results = [];
    const baseUrl = webhookUrl.includes('?') ? webhookUrl : webhookUrl;
    
    // Delete any existing webhooks first (clean slate)
    try {
      const hooks = await this.rpc(ip, 'Webhook.List');
      if (hooks.hooks && hooks.hooks.length > 0) {
        for (const hook of hooks.hooks) {
          await this.rpc(ip, 'Webhook.Delete', { id: hook.id });
          console.log(`   Deleted existing webhook: ${hook.id} (${hook.name})`);
        }
      }
    } catch (err) {
      console.log('   No existing webhooks to delete');
    }
    
    // Webhook events for H&T sensor
    // Use Shelly URL token replacement (${ev.tC}, ${ev.rh}, etc.) to include
    // actual sensor values in the webhook URL — the device replaces these at
    // invocation time so our server gets real data in query params.
    //
    // NOTE: temperature.measurement / humidity.measurement are NOT supported
    // on H&T Gen3 firmware — only temperature.change and humidity.change are
    // available (confirmed via Webhook.ListSupported). We query the supported
    // events first and only create webhooks for what the device actually has.
    
    // Query supported events so we don't try to create unsupported ones
    let supportedEvents = [];
    try {
      const supported = await this.rpc(ip, 'Webhook.ListSupported');
      supportedEvents = Object.keys(supported.types || {});
      console.log(`   Supported webhook events: ${supportedEvents.join(', ')}`);
    } catch (err) {
      // Fallback: assume at least the .change events are supported
      supportedEvents = ['temperature.change', 'humidity.change'];
      console.log('   Could not query supported events, using defaults');
    }

    const allWebhookConfigs = [
      {
        event: 'temperature.change',
        name: 'firebase_temp',
        url: `${baseUrl}?device_id=${deviceId}&event=temperature.change&tC=\${ev.tC}&tF=\${ev.tF}&rh=\${status["humidity:0"].rh}&battery=\${status["devicepower:0"].battery.percent}`,
      },
      {
        event: 'humidity.change',
        name: 'firebase_humidity',
        url: `${baseUrl}?device_id=${deviceId}&event=humidity.change&rh=\${ev.rh}&tC=\${status["temperature:0"].tC}&tF=\${status["temperature:0"].tF}&battery=\${status["devicepower:0"].battery.percent}`,
      },
      {
        // temperature.measurement fires every 60s measurement cycle regardless
        // of threshold — guarantees periodic data even if temp is stable
        // NOTE: Not supported on H&T Gen3 firmware as of 2026-02
        event: 'temperature.measurement',
        name: 'firebase_temp_periodic',
        url: `${baseUrl}?device_id=${deviceId}&event=temperature.measurement&tC=\${ev.tC}&tF=\${ev.tF}&rh=\${status["humidity:0"].rh}&battery=\${status["devicepower:0"].battery.percent}`,
      },
      {
        // humidity.measurement fires every 60s measurement cycle
        // NOTE: Not supported on H&T Gen3 firmware as of 2026-02
        event: 'humidity.measurement',
        name: 'firebase_hum_periodic',
        url: `${baseUrl}?device_id=${deviceId}&event=humidity.measurement&rh=\${ev.rh}&tC=\${status["temperature:0"].tC}&tF=\${status["temperature:0"].tF}&battery=\${status["devicepower:0"].battery.percent}`,
      },
    ];

    // Only create webhooks for events the device actually supports
    const webhookConfigs = allWebhookConfigs.filter(c => supportedEvents.includes(c.event));
    const skipped = allWebhookConfigs.filter(c => !supportedEvents.includes(c.event));
    for (const s of skipped) {
      console.log(`   ⏭ Skipping unsupported event: ${s.event}`);
      results.push({ event: s.event, status: 'skipped', reason: 'not supported by device firmware' });
    }
    
    for (const config of webhookConfigs) {
      try {
        await this.rpc(ip, 'Webhook.Create', {
          cid: 0,
          enable: true,
          event: config.event,
          name: config.name,
          urls: [config.url]
        });
        console.log(`   ✅ Webhook configured: ${config.event} -> Firebase`);
        results.push({ event: config.event, status: 'ok' });
      } catch (err) {
        console.log(`   ⚠ Webhook ${config.event} failed: ${err.message}`);
        results.push({ event: config.event, status: 'failed', error: err.message });
      }
    }
    
    return results;
  }

  /**
   * Configure H&T Sensor Reporting Thresholds
   * 
   * These thresholds control when the battery-powered sensor wakes up from
   * sleep to send data. The sensor measures internally on a ~60s cycle. If
   * the delta since the last REPORTED value exceeds the threshold, a
   * `temperature.change` / `humidity.change` webhook fires.
   * 
   * IMPORTANT for battery devices:
   * - Lower thresholds = more wake-ups = more battery drain
   * - The sensor ALSO wakes on `wakeup_period` (default ~12hrs) regardless
   * - `temperature.measurement` / `humidity.measurement` fire every 60s
   *   measurement cycle when the device is already awake
   * 
   * @param {string} ip - Device IP
   * @param {number} tempThresholdC - Temp delta in °C to trigger report (min 0.5, default 1.0)
   * @param {number} humidityThreshold - Humidity % delta to trigger report (min 1.0, default 5.0)
   */
  async configureHTThresholds(ip, tempThresholdC = 0.5, humidityThreshold = 2.0) {
    const results = { temperature: null, humidity: null };

    // Set Temperature Threshold (report_thr_C)
    // Per Shelly docs: accepted range is device-specific, default [0.5..5.0]°C
    try {
      const tempResult = await this.rpc(ip, 'Temperature.SetConfig', {
        id: 0,
        config: {
          report_thr_C: tempThresholdC
        }
      });
      console.log(`   ✅ Temperature threshold set to ${tempThresholdC}°C`);
      results.temperature = { success: true, threshold: tempThresholdC, result: tempResult };
    } catch (error) {
      console.error(`   ❌ Failed to set temp threshold: ${error.message}`);
      results.temperature = { success: false, error: error.message };
    }

    // Set Humidity Threshold (report_thr)
    // Per Shelly docs: accepted range is device-specific, default [1.0..20.0]%
    try {
      const humResult = await this.rpc(ip, 'Humidity.SetConfig', {
        id: 0,
        config: {
          report_thr: humidityThreshold
        }
      });
      console.log(`   ✅ Humidity threshold set to ${humidityThreshold}%`);
      results.humidity = { success: true, threshold: humidityThreshold, result: humResult };
    } catch (error) {
      console.error(`   ❌ Failed to set humidity threshold: ${error.message}`);
      results.humidity = { success: false, error: error.message };
    }

    return results;
  }

  /**
   * Get current H&T sensor threshold configuration
   * @param {string} ip - Device IP
   */
  async getHTConfig(ip) {
    const [tempConfig, humConfig, sysStatus] = await Promise.all([
      this.rpc(ip, 'Temperature.GetConfig', { id: 0 }).catch(e => ({ error: e.message })),
      this.rpc(ip, 'Humidity.GetConfig', { id: 0 }).catch(e => ({ error: e.message })),
      this.rpc(ip, 'Sys.GetStatus').catch(e => ({ error: e.message }))
    ]);

    return {
      temperature: tempConfig,
      humidity: humConfig,
      wakeup_period: sysStatus.wakeup_period || null,
      wakeup_reason: sysStatus.wakeup_reason || null
    };
  }

  /**
   * Reboot the device
   */
  async reboot(ip) {
    await this.rpc(ip, 'Shelly.Reboot');
    return true;
  }

  /**
   * Factory reset the device
   */
  async factoryReset(ip) {
    await this.rpc(ip, 'Shelly.FactoryReset');
    return true;
  }

  /**
   * Get relay output status for a Shelly switch/relay device.
   */
  async getRelayStatus(ip, switchId = 0) {
    try {
      const status = await this.rpc(ip, 'Switch.GetStatus', { id: switchId });
      return {
        output: status.output === true,
        source: 'switch-status',
      };
    } catch (error) {
      const fullStatus = await this.getStatus(ip);
      const relay = fullStatus[`switch:${switchId}`] || {};
      return {
        output: relay.output === true,
        source: 'full-status',
      };
    }
  }

  /**
   * Set relay output state for Shelly relay/switch devices.
   */
  async setRelayOutput(ip, on, switchId = 0) {
    await this.rpc(ip, 'Switch.Set', {
      id: switchId,
      on: Boolean(on),
    });
    return this.getRelayStatus(ip, switchId);
  }

  /**
   * Momentarily close the dry contact, then release it.
   */
  async pulseRelay(ip, durationMs = 1000, switchId = 0) {
    const safeDurationMs = Math.max(250, Math.min(Number(durationMs) || 1000, 60000));
    await this.setRelayOutput(ip, true, switchId);
    await new Promise((resolve) => setTimeout(resolve, safeDurationMs));
    return this.setRelayOutput(ip, false, switchId);
  }

  /**
   * Actuate a valve via Shelly dry-contact relay.
   *
   * Bulldog controllers ship with a maintained toggle switch — the relay contact
   * must stay in position (not pulse). A short pulse starts travel (~18 s full
   * stroke) but releasing the contact triggers the opposite direction.
   */
  async actuateValve(ip, action, options = {}) {
    const {
      actuationMode = 'maintained',
      pulseDurationMs = 20000,
      relayCloseOn = true,
      switchId = 0,
    } = options;

    const normalizedAction = String(action || '').toLowerCase();
    const safeDurationMs = Math.max(
      250,
      Math.min(Number(pulseDurationMs) || 20000, 60000)
    );

    if (normalizedAction === 'pulse') {
      return this.pulseRelay(ip, safeDurationMs, switchId);
    }

    const wantClose = normalizedAction === 'close';
    const relayOn = relayCloseOn ? wantClose : !wantClose;

    if (actuationMode === 'momentary') {
      await this.setRelayOutput(ip, relayOn, switchId);
      await new Promise((resolve) => setTimeout(resolve, safeDurationMs));
      return this.setRelayOutput(ip, !relayOn, switchId);
    }

    return this.setRelayOutput(ip, relayOn, switchId);
  }

  // ==================== DEVICE DISCOVERY ====================

  /**
   * Register a known device by IP
   */
  registerDevice(deviceId, ip, metadata = {}) {
    this.devices.set(deviceId, {
      ip,
      lastSeen: new Date(),
      status: 'unknown',
      ...metadata
    });
    console.log(`📱 Registered Shelly device: ${deviceId} at ${ip}`);
  }

  /**
   * Get all registered devices with current status
   */
  async getAllDevicesStatus() {
    const results = [];
    
    for (const [deviceId, device] of this.devices) {
      try {
        const data = await this.getCompleteSensorData(device.ip);
        if (data) {
          device.lastSeen = new Date();
          device.status = 'online';
          results.push(data);
        } else {
          device.status = 'offline';
        }
      } catch (error) {
        device.status = 'offline';
        results.push({
          id: deviceId,
          ip: device.ip,
          status: 'offline',
          lastSeen: device.lastSeen?.toISOString(),
          error: error.message
        });
      }
    }
    
    return results;
  }

  /**
   * Check if a device is reachable
   */
  async ping(ip) {
    try {
      await this.getDeviceInfo(ip);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scan local network for Shelly devices
   * Auto-detects network range from server's IP
   */
  async scanNetwork(baseIp = null, startRange = 2, endRange = 254) {
    // Auto-detect local network if not specified
    if (!baseIp) {
      baseIp = this.detectLocalSubnet();
    }
    
    baseIp = baseIp || '192.168.1';
    console.log(`🔍 Scanning ${baseIp}.${startRange}-${endRange} for Shelly devices...`);
    
    const found = [];
    const scanPromises = [];

    // Shelly AP mode hosts the device at .1 — normal scans start at .2 and miss it.
    if (baseIp === '192.168.33') {
      scanPromises.push(
        Promise.race([
          this.getDeviceInfo('192.168.33.1')
            .then(info => {
              const type = this.inferDeviceType(info);
              found.push({ ip: '192.168.33.1', type, ...info });
              console.log(`✅ Found Shelly ${type} at 192.168.33.1 (AP mode): ${info.name || info.id}`);
            }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 1500)
          )
        ]).catch(() => {})
      );
    }
    
    for (let i = startRange; i <= endRange; i++) {
      const ip = `${baseIp}.${i}`;
      scanPromises.push(
        Promise.race([
          this.getDeviceInfo(ip)
            .then(info => {
              const type = this.inferDeviceType(info);
              found.push({ ip, type, ...info });
              console.log(`✅ Found Shelly ${type} at ${ip}: ${info.name || info.id}`);
            }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 800)
          )
        ])
        .catch(() => {}) // Ignore unreachable/timeout
      );
    }
    
    // Run in small batches for faster results
    const batchSize = 20;
    for (let i = 0; i < scanPromises.length; i += batchSize) {
      await Promise.all(scanPromises.slice(i, i + batchSize));
    }
    
    console.log(`🔍 Scan complete. Found ${found.length} Shelly device(s).`);
    return found;
  }

  /**
   * Find a specific Shelly device on the local network by its device ID.
   * Useful after AP-mode setup when the device reboots onto the home WiFi.
   * Scans a wide range and returns the IP when found.
   */
  async findDeviceOnNetwork(targetDeviceId, baseIp = null, endRange = 254) {
    const subnetsToScan = baseIp ? [baseIp] : this.detectAllSubnets();
    if (subnetsToScan.length === 0) {
      subnetsToScan.push('192.168.1'); // fallback
    }

    const targetLower = targetDeviceId.toLowerCase();

    for (const subnet of subnetsToScan) {
      console.log(`🔍 Looking for device ${targetDeviceId} on ${subnet}.x ...`);
      let foundIp = null;

      // Scan in batches of 30 for speed
      const batchSize = 30;
      for (let start = 2; start <= endRange && !foundIp; start += batchSize) {
        const batch = [];
        const end = Math.min(start + batchSize - 1, endRange);
        for (let i = start; i <= end; i++) {
          const ip = `${subnet}.${i}`;
          batch.push(
            Promise.race([
              this.getDeviceInfo(ip)
                .then(info => {
                  const id = (info.id || '').toLowerCase();
                  const mac = (info.mac || '').toLowerCase().replace(/:/g, '');
                  if (id === targetLower || id.includes(targetLower) || mac.includes(targetLower.replace(/[^a-f0-9]/g, ''))) {
                    console.log(`✅ Found ${targetDeviceId} at ${ip}`);
                    foundIp = ip;
                    return { ip, ...info };
                  }
                }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200))
            ]).catch(() => {})
          );
        }
        await Promise.all(batch);
      }

      if (foundIp) return foundIp;
    }

    console.log(`❌ Device ${targetDeviceId} not found on any network`);
    return null;
  }

  /**
   * Detect all local subnet prefixes (e.g. ['10.2.11', '192.168.1'])
   * Returns all non-internal IPv4 subnets, excluding VPN/tunnel interfaces
   */
  detectAllSubnets() {
    const subnets = [];
    try {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            const parts = net.address.split('.');
            const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
            // Skip point-to-point (VPN) and link-local
            if (net.address.startsWith('169.254')) continue;
            if (net.netmask === '255.255.255.255') continue;
            subnets.push(subnet);
          }
        }
      }
    } catch (err) {
      console.error('Failed to detect networks:', err.message);
    }
    if (subnets.length > 0) {
      console.log(`🔍 Auto-detected networks: ${subnets.map(s => s + '.x').join(', ')}`);
    }
    return subnets;
  }

  /**
   * Detect the primary local subnet prefix (e.g. '10.2.11')
   */
  detectLocalSubnet() {
    const subnets = this.detectAllSubnets();
    return subnets.length > 0 ? subnets[0] : null;
  }

  /**
   * Infer device type from Shelly.GetDeviceInfo response
   */
  inferDeviceType(info) {
    const id = (info.id || '').toLowerCase();
    const app = (info.app || '').toLowerCase();
    const model = (info.model || '').toLowerCase();
    const profile = (info.profile || '').toLowerCase();
    if (id.includes('blugw') || app.includes('blugw') || model.includes('sngw')) return 'ble_gateway';
    if (id.includes('ht') || app.includes('ht')) return 'shelly_ht';
    if (id.includes('flood') || app.includes('flood')) return 'shelly_flood_gen4';
    if (
      profile === 'switch' ||
      app.includes('shelly1') ||
      app.includes('1g4') ||
      model.includes('shelly1') ||
      model.includes('shelly 1') ||
      model.includes('1 gen4')
    ) {
      return 'relay_controller';
    }
    return 'unknown';
  }
}

export default new ShellyLocalApi();
