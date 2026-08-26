/**
 * Shelly Direct WebSocket Server
 * 
 * This creates a WebSocket server that Shelly devices connect TO directly.
 * No cloud required - devices push data straight to your server.
 * 
 * Shelly Gen4 devices support "outbound WebSocket" where they maintain
 * a persistent connection to your server and push events in real-time.
 * 
 * Data format from device:
 * {
 *   "src": "shellyfloodg4-xxxxxxxxxxxx",
 *   "dst": "your-server",
 *   "method": "NotifyStatus",  // or "NotifyFullStatus", "NotifyEvent"
 *   "params": {
 *     "ts": 1704067200.00,
 *     "flood:0": { "flood": true },
 *     "temperature:0": { "tC": 22.5, "tF": 72.5 },
 *     "devicepower:0": { "battery": { "percent": 85, "V": 5.2 } }
 *   }
 * }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

class ShellyWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.wss = null;
    this.devices = new Map(); // deviceId -> WebSocket connection
    this.deviceStatus = new Map(); // deviceId -> latest status
    this.clientSubscribers = new Map(); // For frontend clients subscribing to updates
    this.pendingRpc = new Map(); // requestId -> { resolve, reject, timer, deviceId }
    this.manager = null; // Reference to shellyManager for getting all devices
    this._heartbeatTimer = null;
  }

  /**
   * Set reference to the manager
   */
  setManager(manager) {
    this.manager = manager;
  }

  /**
   * Start the WebSocket server
   * @param {number} port - Port to listen on (default: 8765)
   * @param {http.Server} existingServer - Optional: attach to existing HTTP server
   */
  start(portOrServer = 8765) {
    if (typeof portOrServer === 'number') {
      // Standalone WebSocket server
      this.wss = new WebSocketServer({ port: portOrServer });
      console.log(`🔌 Shelly WebSocket server listening on port ${portOrServer}`);
    } else {
      // Use noServer mode to avoid conflicting with other WebSocket servers
      // This is the same pattern used by the voice modules
      this.wss = new WebSocketServer({ noServer: true });
      
      // Register manual upgrade handler (same pattern as voice-call.js)
      portOrServer.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        
        if (pathname === '/shelly-ws') {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request);
          });
        }
        // Other paths will be handled by other WebSocket servers (voice, groq, phone)
      });
      
      console.log(`🔌 Shelly WebSocket server attached at /shelly-ws`);
    }

    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      console.log(`📱 New WebSocket connection from ${clientIp}`);

      // Determine if this is a Shelly device or a frontend client
      const isDevice = !req.url?.includes('subscribe');

      if (isDevice) {
        this.handleDeviceConnection(ws, clientIp);
      } else {
        this.handleClientSubscription(ws, req);
      }
    });

    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });

    // Detect half-open sockets after power loss (TCP close can lag for minutes).
    this.startHeartbeat(15 * 1000);

    return this;
  }

  startHeartbeat(intervalMs = 30 * 1000) {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      this.probeConnectedDevices().catch(() => {});
    }, intervalMs);
  }

  /**
   * RPC-ping every connected device. Unplugged relays leave zombie sockets that
   * still look OPEN — terminate them so device:disconnected fires promptly.
   */
  async probeConnectedDevices() {
    const deviceIds = [...this.devices.keys()];
    for (const deviceId of deviceIds) {
      const ws = this.devices.get(deviceId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        this.forceDisconnect(deviceId, 'socket_not_open');
        continue;
      }
      try {
        const result = await this.sendRpcToDevice(deviceId, 'Shelly.GetDeviceInfo', {}, 4000);
        if (result == null) {
          this.forceDisconnect(deviceId, 'rpc_null');
        }
      } catch (error) {
        console.warn(`📴 Heartbeat failed for ${deviceId}: ${error.message}`);
        this.forceDisconnect(deviceId, 'heartbeat_timeout');
      }
    }
  }

  /**
   * Tear down a device socket and emit disconnect (idempotent).
   */
  forceDisconnect(deviceId, reason = 'forced') {
    if (!deviceId) return;
    const ws = this.devices.get(deviceId);
    this.devices.delete(deviceId);
    this.rejectPendingForDevice(deviceId, new Error(`Device disconnected (${reason})`));
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    console.log(`📴 Shelly device force-disconnected: ${deviceId} (${reason})`);
    this.emit('device:disconnected', { deviceId, reason });
  }

  /**
   * Handle incoming Shelly device connection
   */
  handleDeviceConnection(ws, clientIp) {
    let deviceId = null;

    console.log(`🔌🔌🔌 NEW SHELLY DEVICE CONNECTION from ${clientIp} 🔌🔌🔌`);

    ws.on('message', (data) => {
      try {
        const rawMessage = data.toString();
        console.log(`📩 RAW WebSocket message from ${clientIp}:`, rawMessage);
        
        const message = JSON.parse(rawMessage);
        
        // Extract device ID from message source
        if (message.src) {
          deviceId = message.src;
          
          // Register device if first message
          if (!this.devices.has(deviceId)) {
            console.log(`✅✅✅ Shelly device REGISTERED: ${deviceId} from ${clientIp} ✅✅✅`);
            this.devices.set(deviceId, ws);
            ws.deviceId = deviceId;
            this.emit('device:connected', { deviceId, ip: clientIp });
          }
        }

        // RPC replies have id + result/error and no method
        if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
          this.resolvePendingRpc(message);
          return;
        }

        // Handle different message types
        console.log(`📨 Message method: ${message.method} from ${deviceId}`);
        this.handleDeviceMessage(deviceId, message);

      } catch (error) {
        console.error('Error parsing device message:', error);
      }
    });

    ws.on('close', () => {
      if (deviceId) {
        // forceDisconnect may have already cleaned up — avoid double offline marks.
        if (this.devices.get(deviceId) === ws) {
          console.log(`📴 Shelly device disconnected: ${deviceId}`);
          this.devices.delete(deviceId);
          this.rejectPendingForDevice(deviceId, new Error('Device disconnected'));
          this.emit('device:disconnected', { deviceId });
        }
      }
    });

    ws.on('error', (error) => {
      console.error(`Device WebSocket error (${deviceId}):`, error.message);
    });

    // Send initial handshake/acknowledgment
    ws.send(JSON.stringify({
      src: 'renaissance-server',
      dst: 'shelly-device',
      method: 'Ack',
      params: { connected: true, timestamp: Date.now() }
    }));
  }

  /**
   * Handle messages from Shelly devices
   */
  handleDeviceMessage(deviceId, message) {
    const { method, params } = message;

    switch (method) {
      case 'NotifyStatus':
      case 'NotifyFullStatus':
        this.handleStatusUpdate(deviceId, params);
        break;

      case 'NotifyEvent':
        this.handleEvent(deviceId, params);
        break;

      default:
        console.log(`📨 Device ${deviceId} sent: ${method}`, params);
    }
  }

  /**
   * Handle status updates from device
   */
  handleStatusUpdate(deviceId, params) {
    const timestamp = params.ts ? new Date(params.ts * 1000) : new Date();
    
    console.log(`🔔 STATUS UPDATE from ${deviceId}:`, JSON.stringify(params, null, 2));
    
    // Parse flood sensor data - Gen4 uses "alarm" field, not "flood"
    const flood = params['flood:0'] || {};
    const temp = params['temperature:0'] || {};
    const power = params['devicepower:0'] || {};
    const wifi = params.wifi || {};
    const sys = params.sys || {};

    // Shelly Flood Gen4 uses "alarm: true/false" for flood detection
    const isFlooded = flood.alarm === true || flood.flood === true;
    
    if (isFlooded) {
      console.log('🚨🚨🚨 FLOOD DETECTED via WebSocket! 🚨🚨🚨');
    }

    const status = {
      id: deviceId,
      timestamp: timestamp.toISOString(),
      type: 'water_leak',
      source: 'websocket',
      
      // Flood detection - check both "alarm" (Gen4) and "flood" (older models)
      isFlooded: isFlooded,
      lastAlarmTime: flood.last_alarm_ts ? new Date(flood.last_alarm_ts * 1000).toISOString() : null,
      
      // Temperature
      temperature: temp.tC || null,
      temperatureF: temp.tF || null,
      
      // Battery
      batteryLevel: power.battery?.percent ?? null,
      batteryPercent: power.battery?.percent ?? null,
      batteryVoltage: power.battery?.V ?? null,
      
      // Connectivity
      rssi: wifi.rssi || null,
      ssid: wifi.ssid || null,
      
      // System
      uptime: sys.uptime || 0,
      
      status: 'online',
      lastUpdate: new Date().toISOString()
    };

    // Store latest status
    this.deviceStatus.set(deviceId, status);

    // Emit event for listeners
    this.emit('status:update', status);

    // Broadcast to subscribed frontend clients
    this.broadcastToClients({
      type: 'status',
      deviceId,
      data: status
    });

    // Check for alert conditions
    if (status.isFlooded) {
      this.handleFloodAlert(deviceId, status);
    }

    if (status.batteryLevel < 20 && status.batteryLevel > 0) {
      this.handleLowBatteryAlert(deviceId, status);
    }
  }

  /**
   * Handle events from device (flood alarm, button press, etc.)
   */
  handleEvent(deviceId, params) {
    const events = params.events || [];

    events.forEach(event => {
      console.log(`⚡ Event from ${deviceId}:`, event);

      if (event.component === 'flood:0' && event.event === 'alarm') {
        this.handleFloodAlert(deviceId, {
          ...this.deviceStatus.get(deviceId),
          isFlooded: true,
          timestamp: new Date().toISOString()
        });
      }

      this.emit('device:event', { deviceId, event });
    });
  }

  /**
   * Handle flood detection alert
   */
  handleFloodAlert(deviceId, status) {
    const alert = {
      id: `alert-flood-${deviceId}-${Date.now()}`,
      type: 'flood',
      level: 'critical',
      deviceId,
      sensorName: status.name || deviceId,
      sensorLocation: status.location || 'Unknown',
      message: `🚨 WATER DETECTED! Flood sensor ${deviceId} triggered.`,
      timestamp: new Date().toISOString(),
      acknowledged: false,
      data: status
    };

    console.log('🚨 FLOOD ALERT:', alert);
    
    this.emit('alert:flood', alert);
    this.broadcastToClients({ type: 'alert', alert });
  }

  /**
   * Handle low battery alert
   */
  handleLowBatteryAlert(deviceId, status) {
    const alert = {
      id: `alert-battery-${deviceId}-${Date.now()}`,
      type: 'low_battery',
      level: 'warning',
      deviceId,
      message: `🔋 Low battery (${status.batteryLevel}%) on sensor ${deviceId}`,
      timestamp: new Date().toISOString(),
      acknowledged: false,
      data: status
    };

    console.log('🔋 LOW BATTERY ALERT:', alert);
    
    this.emit('alert:battery', alert);
    this.broadcastToClients({ type: 'alert', alert });
  }

  /**
   * Handle frontend client subscriptions
   */
  async handleClientSubscription(ws, req) {
    const subscriberId = `client-${Date.now()}`;
    this.clientSubscribers.set(subscriberId, ws);
    
    console.log(`👤 Frontend client subscribed: ${subscriberId}`);

    // Get devices from manager (if available) or fall back to local status
    let allDevices = [];
    if (this.manager) {
      try {
        allDevices = await this.manager.getAllDevices();
        console.log(`📡 Sending ${allDevices.length} devices to frontend`);
      } catch (error) {
        console.error('Error getting devices from manager:', error);
        allDevices = Array.from(this.deviceStatus.values());
      }
    } else {
      allDevices = Array.from(this.deviceStatus.values());
    }

    ws.send(JSON.stringify({
      type: 'init',
      devices: allDevices,
      connectedDevices: Array.from(this.devices.keys())
    }));

    ws.on('close', () => {
      this.clientSubscribers.delete(subscriberId);
      console.log(`👤 Frontend client unsubscribed: ${subscriberId}`);
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(subscriberId, message);
      } catch (error) {
        console.error('Error parsing client message:', error);
      }
    });
  }

  /**
   * Handle messages from frontend clients
   */
  handleClientMessage(subscriberId, message) {
    const { action, deviceId, params } = message;

    switch (action) {
      case 'getStatus':
        const status = this.deviceStatus.get(deviceId);
        const ws = this.clientSubscribers.get(subscriberId);
        if (ws && status) {
          ws.send(JSON.stringify({ type: 'status', deviceId, data: status }));
        }
        break;

      case 'sendCommand':
        this.sendCommandToDevice(deviceId, params);
        break;
    }
  }

  /**
   * Broadcast message to all subscribed frontend clients
   */
  broadcastToClients(message) {
    const payload = JSON.stringify(message);
    const clientCount = this.clientSubscribers.size;
    
    console.log(`📢 Broadcasting to ${clientCount} clients:`, message.type);
    
    this.clientSubscribers.forEach((ws, id) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        console.log(`   ✅ Sent to client ${id}`);
      } else {
        console.log(`   ⚠️ Client ${id} not ready (state: ${ws.readyState})`);
      }
    });
  }

  /**
   * Send RPC command to a connected device (fire-and-forget).
   */
  sendCommandToDevice(deviceId, params) {
    const ws = this.devices.get(deviceId);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`Device ${deviceId} not connected`);
      return false;
    }

    const message = {
      src: 'renaissance-server',
      dst: deviceId,
      id: Date.now(),
      ...params
    };

    ws.send(JSON.stringify(message));
    return true;
  }

  /**
   * Send an RPC and wait for the matching reply. Returns null if the socket
   * is not open; rejects on timeout / disconnect / device error.
   */
  sendRpcToDevice(deviceId, method, params = {}, timeoutMs = 4000) {
    const ws = this.devices.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(null);
    }

    const id = Date.now() + Math.floor(Math.random() * 1000);
    const message = {
      src: 'renaissance-server',
      dst: deviceId,
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC timeout waiting for ${method} from ${deviceId}`));
      }, timeoutMs);

      this.pendingRpc.set(id, { resolve, reject, timer, deviceId });
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(error);
      }
    });
  }

  resolvePendingRpc(message) {
    const pending = this.pendingRpc.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRpc.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  rejectPendingForDevice(deviceId, error) {
    for (const [id, pending] of this.pendingRpc.entries()) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timer);
      this.pendingRpc.delete(id);
      pending.reject(error);
    }
  }

  /**
   * Get all connected devices
   */
  getConnectedDevices() {
    return Array.from(this.devices.keys());
  }

  /**
   * Get latest status for all devices
   */
  getAllDeviceStatuses() {
    return Array.from(this.deviceStatus.values());
  }

  /**
   * Get status for specific device
   */
  getDeviceStatus(deviceId) {
    return this.deviceStatus.get(deviceId) || null;
  }

  /**
   * Check if device is connected
   */
  isDeviceConnected(deviceId) {
    const ws = this.devices.get(deviceId);
    return ws && ws.readyState === WebSocket.OPEN;
  }

  /**
   * Stop the WebSocket server
   */
  stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this.wss) {
      this.wss.close();
      console.log('🔌 Shelly WebSocket server stopped');
    }
  }
}

// Export singleton instance
const shellyWsServer = new ShellyWebSocketServer();
export default shellyWsServer;
