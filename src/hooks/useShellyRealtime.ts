/**
 * Shelly Real-time WebSocket Hook
 * 
 * React hook for connecting to the Shelly WebSocket server
 * and receiving real-time sensor updates.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface ShellyDevice {
  id: string;
  type: string;
  source: string;
  name: string;
  location: string;
  status: 'online' | 'offline';
  isFlooded: boolean;
  temperature?: number;
  temperatureF?: number;
  batteryLevel: number;
  batteryVoltage?: number;
  rssi?: number;
  lastUpdate: string;
}

export interface ShellyAlert {
  id: string;
  type: 'flood' | 'low_battery' | 'offline';
  level: 'critical' | 'warning' | 'info';
  deviceId: string;
  message: string;
  timestamp: string;
  acknowledged: boolean;
  data?: any;
}

interface WebSocketMessage {
  type: 'init' | 'status' | 'alert' | 'connected' | 'disconnected';
  devices?: ShellyDevice[];
  connectedDevices?: string[];
  deviceId?: string;
  data?: ShellyDevice;
  alert?: ShellyAlert;
}

interface UseShellyRealtimeOptions {
  autoConnect?: boolean;
  onFloodAlert?: (alert: ShellyAlert) => void;
  onDeviceUpdate?: (device: ShellyDevice) => void;
}

interface UseShellyRealtimeReturn {
  devices: ShellyDevice[];
  alerts: ShellyAlert[];
  connected: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  acknowledgeAlert: (alertId: string) => void;
  getDevice: (deviceId: string) => ShellyDevice | undefined;
}

export function useShellyRealtime(
  options: UseShellyRealtimeOptions = {}
): UseShellyRealtimeReturn {
  const { autoConnect = true, onFloodAlert, onDeviceUpdate } = options;

  const [devices, setDevices] = useState<ShellyDevice[]>([]);
  const [alerts, setAlerts] = useState<ShellyAlert[]>([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);

  const getWebSocketUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_PUSH_SERVER_URL?.replace(/^https?:\/\//, '') 
      || window.location.host;
    return `${protocol}//${host}/shelly-ws?subscribe=true`;
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      const url = getWebSocketUrl();
      console.log('🔌 Connecting to Shelly WebSocket:', url);
      
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('✅ Shelly WebSocket connected');
        setConnected(true);
        setConnecting(false);
        setError(null);
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          handleMessage(message);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onclose = (event) => {
        console.log('🔌 Shelly WebSocket disconnected', event.code);
        setConnected(false);
        setConnecting(false);
        wsRef.current = null;

        // Attempt reconnection with exponential backoff
        if (!event.wasClean && reconnectAttempts.current < 10) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
          console.log(`Reconnecting in ${delay}ms...`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttempts.current++;
            connect();
          }, delay);
        }
      };

      ws.onerror = (event) => {
        console.error('Shelly WebSocket error:', event);
        setError('Connection error');
        setConnecting(false);
      };

    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      setError('Failed to connect');
      setConnecting(false);
    }
  }, [getWebSocketUrl]);

  const handleMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case 'init':
        // Initial device list
        if (message.devices) {
          setDevices(message.devices);
        }
        break;

      case 'status':
        // Device status update
        if (message.data) {
          setDevices(prev => {
            const existing = prev.findIndex(d => d.id === message.data!.id);
            if (existing >= 0) {
              const updated = [...prev];
              updated[existing] = { ...updated[existing], ...message.data };
              return updated;
            } else {
              return [...prev, message.data!];
            }
          });
          
          if (onDeviceUpdate) {
            onDeviceUpdate(message.data);
          }
        }
        break;

      case 'alert':
        // New alert
        if (message.alert) {
          setAlerts(prev => [message.alert!, ...prev].slice(0, 50));
          
          if (message.alert.type === 'flood' && onFloodAlert) {
            onFloodAlert(message.alert);
          }

          // Play alert sound for critical alerts
          if (message.alert.level === 'critical') {
            playAlertSound();
          }
        }
        break;
    }
  }, [onFloodAlert, onDeviceUpdate]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setConnected(false);
  }, []);

  const acknowledgeAlert = useCallback((alertId: string) => {
    setAlerts(prev => 
      prev.map(a => 
        a.id === alertId 
          ? { ...a, acknowledged: true } 
          : a
      )
    );

    // Also notify server
    const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
    fetch(`${baseUrl}/api/shelly/alerts/${alertId}/acknowledge`, {
      method: 'POST'
    }).catch(console.error);
  }, []);

  const getDevice = useCallback((deviceId: string) => {
    return devices.find(d => d.id === deviceId);
  }, [devices]);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return {
    devices,
    alerts,
    connected,
    connecting,
    error,
    connect,
    disconnect,
    acknowledgeAlert,
    getDevice
  };
}

// Helper to play alert sound using Web Audio API
function playAlertSound() {
  try {
    // Create audio context for reliable alert sound
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContext();
    
    // Create a multi-tone alert sound
    const playTone = (frequency: number, startTime: number, duration: number) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      
      gainNode.gain.setValueAtTime(0.3, ctx.currentTime + startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + startTime + duration);
      
      oscillator.start(ctx.currentTime + startTime);
      oscillator.stop(ctx.currentTime + startTime + duration);
    };
    
    // Play urgent alert pattern: high-low-high
    playTone(880, 0, 0.15);      // A5
    playTone(660, 0.2, 0.15);    // E5
    playTone(880, 0.4, 0.15);    // A5
    playTone(660, 0.6, 0.15);    // E5
    playTone(1046, 0.8, 0.3);    // C6 (final high note)
    
    // Close context after sound finishes
    setTimeout(() => ctx.close(), 1500);
  } catch {
    // Audio not available
    console.log('Audio alert not available');
  }
}

/**
 * Custom hook to fetch Shelly devices via REST API
 * Use this as fallback when WebSocket is not available
 */
export function useShellyDevices() {
  const [devices, setDevices] = useState<ShellyDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
    
    try {
      const response = await fetch(`${baseUrl}/api/shelly/devices`);
      const data = await response.json();
      
      if (data.success) {
        setDevices(data.devices);
      } else {
        setError(data.error || 'Failed to fetch devices');
      }
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    
    // Poll every 30 seconds as fallback
    const interval = setInterval(fetchDevices, 30000);
    return () => clearInterval(interval);
  }, [fetchDevices]);

  return { devices, loading, error, refresh: fetchDevices };
}
