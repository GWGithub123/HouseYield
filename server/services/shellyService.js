/**
 * Shelly Flood Gen4 Integration Service
 * Handles communication with Shelly Cloud API
 */
import axios from 'axios';
import firestoreService from '../../backend/services/firestore-service.cjs';

function isShellyCloudEnabled() {
  return process.env.SHELLY_CLOUD_ENABLED !== 'false';
}

class ShellyService {
  constructor() {
    this.authKey = process.env.SHELLY_CLOUD_AUTH_KEY;
    this.cloudEnabled = isShellyCloudEnabled();
    this.server = process.env.SHELLY_CLOUD_SERVER || 'us';
    this.baseUrl = `https://shelly-${this.server}.shelly.cloud`;
    this.initialized = false;
  }

  /**
   * Initialize and validate credentials
   */
  async initialize() {
    if (!this.cloudEnabled) {
      console.log('ℹ️  Shelly Cloud disabled via SHELLY_CLOUD_ENABLED=false');
      return false;
    }

    if (!this.authKey) {
      console.warn('⚠️  Shelly Cloud auth key not configured. Set SHELLY_CLOUD_AUTH_KEY in .env');
      return false;
    }

    try {
      // Test connection with a simple API call
      await axios.get(`${this.baseUrl}/user/info`, {
        params: { auth_key: this.authKey },
        timeout: 5000
      });
      
      this.initialized = true;
      console.log('✅ Shelly Cloud service initialized');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Shelly Cloud:', error.message);
      return false;
    }
  }

  /**
   * Get status of all registered Shelly devices
   */
  async getAllDevicesStatus() {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.initialized) {
      return [];
    }

    try {
      const deviceIds = process.env.SHELLY_DEVICE_IDS?.split(',') || [];
      
      if (deviceIds.length === 0) {
        console.warn('⚠️  No Shelly device IDs configured. Set SHELLY_DEVICE_IDS in .env');
        return [];
      }

      const devices = await Promise.all(
        deviceIds.map(id => this.getDeviceStatus(id.trim()))
      );
      
      return devices.filter(d => d !== null);
    } catch (error) {
      console.error('Error fetching Shelly devices:', error.message);
      return [];
    }
  }

  /**
   * Get status of a specific device
   */
  async getDeviceStatus(deviceId) {
    if (!this.initialized) {
      return null;
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/device/status`,
        {
          params: { 
            id: deviceId, 
            auth_key: this.authKey 
          },
          timeout: 5000
        }
      );

      const data = response.data.data;
      const deviceStatus = data.device_status;
      
      // Parse Shelly Flood Gen4 specific data
      const sensorData = {
        id: deviceId,
        type: 'water_leak',
        name: data.device?.name || `Flood Sensor ${deviceId.slice(-4)}`,
        location: data.device?.location || 'Unknown Location',
        status: deviceStatus.cloud?.connected ? 'online' : 'offline',
        
        // Flood detection
        isFlooded: deviceStatus['flood:0']?.flood || false,
        
        // Battery info
        batteryLevel: deviceStatus['devicepower:0']?.battery?.percent ?? null,
        batteryVoltage: deviceStatus['devicepower:0']?.battery?.V || null,
        
        // Temperature
        temperature: deviceStatus['temperature:0']?.tC || null,
        temperatureF: deviceStatus['temperature:0']?.tF || null,
        
        // Wi-Fi signal strength
        rssi: deviceStatus['wifi']?.rssi || null,
        
        // Timestamps
        lastUpdate: deviceStatus._updated || new Date().toISOString(),
        installedDate: data.device?.created_at || new Date().toISOString(),
        
        // Additional metadata
        firmwareVersion: data.device?.fw_version || 'unknown',
        macAddress: data.device?.mac || null
      };

      // Save reading to Firestore
      try {
        await firestoreService.saveSensorReading(deviceId, {
          isFlooded: sensorData.isFlooded,
          batteryLevel: sensorData.batteryLevel,
          batteryVoltage: sensorData.batteryVoltage,
          temperature: sensorData.temperature,
          temperatureF: sensorData.temperatureF,
          rssi: sensorData.rssi,
          status: sensorData.status
        });

        // Create alert if flood detected
        if (sensorData.isFlooded) {
          const sensor = await firestoreService.getSensor(deviceId);
          if (sensor && sensor.propertyId) {
            await firestoreService.createAlert({
              sensorId: deviceId,
              propertyId: sensor.propertyId,
              alertType: 'flood_detected',
              severity: 'high',
              message: `Water leak detected at ${sensorData.location}`,
              metadata: {
                temperature: sensorData.temperature,
                batteryLevel: sensorData.batteryLevel
              }
            });
          }
        }
      } catch (firestoreError) {
        console.error('Error saving to Firestore:', firestoreError.message);
      }

      return sensorData;
    } catch (error) {
      if (error.response?.status === 404) {
        console.error(`Device ${deviceId} not found`);
      } else {
        console.error(`Error fetching device ${deviceId}:`, error.message);
      }
      return null;
    }
  }

  /**
   * Setup webhook to receive real-time alerts
   * @param {string} webhookUrl - Your server's webhook endpoint URL
   */
  async setupWebhook(webhookUrl) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.initialized) {
      return false;
    }

    try {
      const deviceIds = process.env.SHELLY_DEVICE_IDS?.split(',') || [];
      
      for (const deviceId of deviceIds) {
        try {
          await axios.post(
            `${this.baseUrl}/device/settings`,
            {
              id: deviceId.trim(),
              auth_key: this.authKey,
              actions: [
                {
                  name: 'flood_detected',
                  urls: [webhookUrl],
                  enabled: true
                },
                {
                  name: 'battery_low',
                  urls: [webhookUrl],
                  enabled: true
                }
              ]
            }
          );
          
          console.log(`✅ Webhook configured for device ${deviceId}`);
        } catch (error) {
          console.error(`Failed to setup webhook for ${deviceId}:`, error.message);
        }
      }
      
      return true;
    } catch (error) {
      console.error('Error setting up webhooks:', error.message);
      return false;
    }
  }

  /**
   * Register a new device to a property
   * Saves to Firestore database
   */
  async registerDevice(deviceId, propertyId, location, metadata = {}) {
    try {
      const registration = {
        deviceId: deviceId.trim(),
        propertyId,
        location,
        type: 'shelly_flood_gen4',
        ...metadata,
        registeredAt: new Date().toISOString(),
        isActive: true
      };

      // Save to Firestore
      await firestoreService.registerSensor(deviceId, {
        propertyId,
        location,
        deviceType: 'shelly_flood_gen4',
        manufacturer: 'Shelly',
        model: 'Flood Gen4',
        ...metadata
      });
      
      console.log('✅ Device registered to Firestore:', registration);
      return registration;
    } catch (error) {
      console.error('Error registering device:', error.message);
      throw error;
    }
  }

  /**
   * Get device history/readings
   */
  async getDeviceHistory(deviceId, startDate, endDate) {
    if (!this.initialized) {
      return [];
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/device/history`,
        {
          params: {
            id: deviceId,
            auth_key: this.authKey,
            start: startDate,
            end: endDate
          },
          timeout: 10000
        }
      );

      return response.data.data?.history || [];
    } catch (error) {
      console.error(`Error fetching history for ${deviceId}:`, error.message);
      return [];
    }
  }

  /**
   * Test if service is configured and working
   */
  async healthCheck() {
    if (!this.cloudEnabled) {
      return {
        status: 'disabled',
        message: 'Shelly Cloud disabled via SHELLY_CLOUD_ENABLED=false',
        configured: false
      };
    }

    if (!this.authKey) {
      return {
        status: 'not_configured',
        message: 'Shelly Cloud auth key not set',
        configured: false
      };
    }

    try {
      await this.initialize();
      
      if (!this.initialized) {
        return {
          status: 'error',
          message: 'Failed to connect to Shelly Cloud',
          configured: true
        };
      }

      const devices = await this.getAllDevicesStatus();
      
      return {
        status: 'ok',
        message: 'Shelly Cloud connected',
        configured: true,
        deviceCount: devices.length,
        onlineDevices: devices.filter(d => d.status === 'online').length
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        configured: true
      };
    }
  }
}

export default new ShellyService();
