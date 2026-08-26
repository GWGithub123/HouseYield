/**
 * Shelly Device Polling Service
 * Periodically checks device status and creates alerts
 */
import cron from 'node-cron';
import shellyService from './shellyService.js';

class ShellyPoller {
  constructor() {
    this.pollInterval = null;
    this.isRunning = false;
    this.alertCallbacks = [];
  }

  /**
   * Register a callback for when alerts are detected
   * @param {Function} callback - Function to call with alert data
   */
  onAlert(callback) {
    this.alertCallbacks.push(callback);
  }

  /**
   * Trigger all registered alert callbacks
   */
  triggerAlertCallbacks(alert) {
    this.alertCallbacks.forEach(callback => {
      try {
        callback(alert);
      } catch (error) {
        console.error('Error in alert callback:', error);
      }
    });
  }

  /**
   * Start polling Shelly devices
   * @param {number} intervalSeconds - How often to poll (default: 30 seconds)
   */
  start(intervalSeconds = 30) {
    if (this.isRunning) {
      console.log('⚠️  Shelly poller already running');
      return;
    }

    console.log(`🔄 Starting Shelly device polling (every ${intervalSeconds}s)...`);
    
    // Run once immediately
    this.poll();
    
    // Then schedule recurring polls
    // Cron format: */30 * * * * * means every 30 seconds
    const cronExpression = `*/${intervalSeconds} * * * * *`;
    
    this.pollInterval = cron.schedule(cronExpression, async () => {
      await this.poll();
    });
    
    this.isRunning = true;
    console.log('✅ Shelly poller started');
  }

  /**
   * Perform a single poll of all devices
   */
  async poll() {
    try {
      const devices = await shellyService.getAllDevicesStatus();
      
      if (devices.length === 0) {
        return; // No devices configured
      }

      // Check each device for alert conditions
      devices.forEach(device => {
        // FLOOD DETECTED
        if (device.isFlooded) {
          const alert = {
            id: `alert-flood-${device.id}-${Date.now()}`,
            type: 'flood',
            sensorId: device.id,
            sensorName: device.name,
            sensorLocation: device.location,
            level: 'critical',
            message: `💧 WATER DETECTED at ${device.location}!`,
            timestamp: new Date().toISOString(),
            acknowledged: false,
            deviceData: {
              batteryLevel: device.batteryLevel,
              temperature: device.temperature,
              rssi: device.rssi
            }
          };

          console.log('🚨 FLOOD ALERT:', alert);
          this.triggerAlertCallbacks(alert);
        }

        // LOW BATTERY WARNING
        if (device.batteryLevel < 20 && device.batteryLevel > 0) {
          const alert = {
            id: `alert-battery-${device.id}-${Date.now()}`,
            type: 'low_battery',
            sensorId: device.id,
            sensorName: device.name,
            sensorLocation: device.location,
            level: device.batteryLevel < 10 ? 'critical' : 'warning',
            message: `🔋 Low battery (${device.batteryLevel}%) - ${device.name}`,
            timestamp: new Date().toISOString(),
            acknowledged: false,
            deviceData: {
              batteryLevel: device.batteryLevel,
              batteryVoltage: device.batteryVoltage
            }
          };

          console.log('⚠️  LOW BATTERY:', alert);
          this.triggerAlertCallbacks(alert);
        }

        // DEVICE OFFLINE
        if (device.status === 'offline') {
          const alert = {
            id: `alert-offline-${device.id}-${Date.now()}`,
            type: 'offline',
            sensorId: device.id,
            sensorName: device.name,
            sensorLocation: device.location,
            level: 'warning',
            message: `📡 Sensor offline - ${device.name}`,
            timestamp: new Date().toISOString(),
            acknowledged: false
          };

          console.log('⚠️  OFFLINE:', alert);
          this.triggerAlertCallbacks(alert);
        }

        // WEAK SIGNAL
        if (device.rssi && device.rssi < -80) {
          const alert = {
            id: `alert-signal-${device.id}-${Date.now()}`,
            type: 'weak_signal',
            sensorId: device.id,
            sensorName: device.name,
            sensorLocation: device.location,
            level: 'info',
            message: `📶 Weak Wi-Fi signal (${device.rssi} dBm) - ${device.name}`,
            timestamp: new Date().toISOString(),
            acknowledged: false,
            deviceData: {
              rssi: device.rssi
            }
          };

          console.log('ℹ️  WEAK SIGNAL:', alert);
          this.triggerAlertCallbacks(alert);
        }
      });

      // Log status summary
      const summary = {
        total: devices.length,
        online: devices.filter(d => d.status === 'online').length,
        flooded: devices.filter(d => d.isFlooded).length,
        lowBattery: devices.filter(d => d.batteryLevel < 20).length
      };

      console.log('📊 Shelly Status:', summary);

    } catch (error) {
      console.error('❌ Polling error:', error.message);
    }
  }

  /**
   * Stop polling
   */
  stop() {
    if (this.pollInterval) {
      this.pollInterval.stop();
      this.isRunning = false;
      console.log('⏹️  Shelly poller stopped');
    }
  }

  /**
   * Check if poller is running
   */
  status() {
    return {
      running: this.isRunning,
      callbackCount: this.alertCallbacks.length
    };
  }
}

export default new ShellyPoller();
