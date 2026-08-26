/**
 * Shelly MQTT Bridge
 * 
 * Runs a local MQTT broker that Shelly devices can publish to directly.
 * No cloud required - all data stays on your network.
 * 
 * Shelly MQTT Topics:
 * - shellyfloodg4-xxxx/status/flood:0 → { "flood": true/false }
 * - shellyfloodg4-xxxx/status/temperature:0 → { "tC": 22.5, "tF": 72.5 }
 * - shellyfloodg4-xxxx/status/devicepower:0 → { "battery": { "percent": 85 } }
 * - shellyfloodg4-xxxx/events/rpc → Event notifications
 * 
 * Command Topics (send commands to device):
 * - shellyfloodg4-xxxx/rpc → Send RPC commands
 */

import Aedes from 'aedes';
import { createServer } from 'net';
import { EventEmitter } from 'events';

class ShellyMqttBridge extends EventEmitter {
  constructor() {
    super();
    this.broker = null;
    this.server = null;
    this.devices = new Map(); // deviceId -> { lastSeen, status }
    this.port = 1883;
  }

  /**
   * Start the MQTT broker
   * @param {number} port - Port to listen on (default: 1883)
   */
  start(port = 1883) {
    this.port = port;
    
    // Create Aedes MQTT broker
    this.broker = Aedes();
    this.server = createServer(this.broker.handle);

    // Handle client connections
    this.broker.on('client', (client) => {
      console.log(`📱 MQTT client connected: ${client.id}`);
      
      // Check if it's a Shelly device
      if (client.id?.startsWith('shelly')) {
        this.devices.set(client.id, {
          connectedAt: new Date(),
          lastSeen: new Date(),
          status: 'online'
        });
        this.emit('device:connected', { deviceId: client.id });
      }
    });

    this.broker.on('clientDisconnect', (client) => {
      console.log(`📴 MQTT client disconnected: ${client.id}`);
      
      if (client.id?.startsWith('shelly')) {
        const device = this.devices.get(client.id);
        if (device) {
          device.status = 'offline';
          device.disconnectedAt = new Date();
        }
        this.emit('device:disconnected', { deviceId: client.id });
      }
    });

    // Handle published messages
    this.broker.on('publish', (packet, client) => {
      if (!client) return; // System message
      
      const topic = packet.topic;
      const payload = packet.payload.toString();
      
      this.handleMessage(topic, payload, client.id);
    });

    // Handle subscriptions
    this.broker.on('subscribe', (subscriptions, client) => {
      console.log(`📩 Client ${client.id} subscribed to:`, 
        subscriptions.map(s => s.topic).join(', '));
    });

    // Start listening
    this.server.listen(port, () => {
      console.log(`📡 Shelly MQTT broker listening on port ${port}`);
      console.log(`   Configure your Shelly devices to connect to: mqtt://<your-server-ip>:${port}`);
    });

    return this;
  }

  /**
   * Handle incoming MQTT messages
   */
  handleMessage(topic, payload, clientId) {
    // Parse topic: shellyfloodg4-xxxx/status/component
    const parts = topic.split('/');
    const deviceId = parts[0];
    const messageType = parts[1]; // status, events, online, etc.
    const component = parts[2]; // flood:0, temperature:0, etc.

    // Update last seen
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = new Date();
    }

    try {
      const data = JSON.parse(payload);
      
      switch (messageType) {
        case 'status':
          this.handleStatusMessage(deviceId, component, data);
          break;
          
        case 'events':
          this.handleEventMessage(deviceId, data);
          break;
          
        case 'online':
          console.log(`📱 Device ${deviceId} online status: ${data}`);
          break;
          
        default:
          // Log unknown message types for debugging
          console.log(`📨 MQTT [${topic}]:`, data);
      }
    } catch (error) {
      // Non-JSON payload
      console.log(`📨 MQTT [${topic}]: ${payload}`);
    }
  }

  /**
   * Handle status updates from device
   */
  handleStatusMessage(deviceId, component, data) {
    const device = this.devices.get(deviceId) || {};
    
    switch (component) {
      case 'flood:0':
        const floodStatus = {
          deviceId,
          type: 'flood',
          isFlooded: data.flood || false,
          lastAlarmTime: data.last_alarm_ts ? new Date(data.last_alarm_ts * 1000) : null,
          timestamp: new Date()
        };
        
        device.flood = floodStatus;
        this.emit('status:flood', floodStatus);
        
        // Create alert if flood detected
        if (data.flood) {
          this.handleFloodAlert(deviceId, floodStatus);
        }
        break;
        
      case 'temperature:0':
        const tempStatus = {
          deviceId,
          type: 'temperature',
          celsius: data.tC,
          fahrenheit: data.tF,
          timestamp: new Date()
        };
        
        device.temperature = tempStatus;
        this.emit('status:temperature', tempStatus);
        break;
        
      case 'devicepower:0':
        const powerStatus = {
          deviceId,
          type: 'power',
          batteryPercent: data.battery?.percent || 0,
          batteryVoltage: data.battery?.V || null,
          timestamp: new Date()
        };
        
        device.power = powerStatus;
        this.emit('status:power', powerStatus);
        
        // Low battery warning
        if (powerStatus.batteryPercent < 20 && powerStatus.batteryPercent > 0) {
          this.emit('alert:battery', {
            deviceId,
            level: 'warning',
            message: `Low battery: ${powerStatus.batteryPercent}%`,
            timestamp: new Date()
          });
        }
        break;
        
      default:
        console.log(`📊 Status update [${deviceId}/${component}]:`, data);
    }
    
    this.devices.set(deviceId, device);
  }

  /**
   * Handle event notifications from device
   */
  handleEventMessage(deviceId, data) {
    const events = data.events || [data];
    
    events.forEach(event => {
      console.log(`⚡ Event from ${deviceId}:`, event);
      
      // Flood alarm event
      if (event.component === 'flood:0' && event.event === 'alarm') {
        this.handleFloodAlert(deviceId, {
          isFlooded: true,
          timestamp: new Date()
        });
      }
      
      this.emit('device:event', { deviceId, event });
    });
  }

  /**
   * Handle flood alert
   */
  handleFloodAlert(deviceId, status) {
    const alert = {
      id: `mqtt-flood-${deviceId}-${Date.now()}`,
      type: 'flood',
      level: 'critical',
      deviceId,
      message: `🚨 WATER DETECTED! Sensor ${deviceId} triggered flood alarm.`,
      timestamp: new Date().toISOString(),
      data: status
    };
    
    console.log('🚨 MQTT FLOOD ALERT:', alert);
    this.emit('alert:flood', alert);
  }

  /**
   * Send RPC command to device via MQTT
   */
  sendCommand(deviceId, method, params = {}) {
    const topic = `${deviceId}/rpc`;
    const payload = JSON.stringify({
      id: Date.now(),
      src: 'renaissance-server',
      method,
      params
    });
    
    this.broker.publish({
      topic,
      payload: Buffer.from(payload),
      qos: 1,
      retain: false
    });
    
    console.log(`📤 Sent command to ${deviceId}: ${method}`);
  }

  /**
   * Get combined status for a device
   */
  getDeviceStatus(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    
    return {
      id: deviceId,
      type: 'water_leak',
      source: 'mqtt',
      status: device.status,
      connectedAt: device.connectedAt,
      lastSeen: device.lastSeen,
      isFlooded: device.flood?.isFlooded || false,
      temperature: device.temperature?.celsius || null,
      temperatureF: device.temperature?.fahrenheit || null,
      batteryLevel: device.power?.batteryPercent || 0,
      batteryVoltage: device.power?.batteryVoltage || null,
      lastUpdate: device.lastSeen?.toISOString()
    };
  }

  /**
   * Get all connected devices
   */
  getAllDevices() {
    return Array.from(this.devices.keys());
  }

  /**
   * Get status for all devices
   */
  getAllDeviceStatuses() {
    return this.getAllDevices().map(id => this.getDeviceStatus(id)).filter(Boolean);
  }

  /**
   * Stop the MQTT broker
   */
  stop() {
    if (this.server) {
      this.server.close();
      console.log('📡 Shelly MQTT broker stopped');
    }
    if (this.broker) {
      this.broker.close();
    }
  }
}

// Export singleton
const shellyMqttBridge = new ShellyMqttBridge();
export default shellyMqttBridge;
