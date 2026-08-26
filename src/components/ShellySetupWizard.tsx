/**
 * Shelly Sensor Setup Wizard
 * 
 * Step-by-step guide to connect Shelly devices to your platform:
 * - Flood Gen4 (WiFi direct)
 * - H&T Gen3 (temp/humidity via BLE gateway or WiFi)
 * - BLU Gateway (BLE bridge for all Shelly BLE devices)
 * 
 * No cloud or app required - direct device-to-server integration.
 */

import { useState, useEffect, useCallback } from 'react';
import { resolveShellyApiBaseUrl, resolveShellyWebhookUrl } from '../utils/iotProjectConfig';

type DeviceType = 'flood' | 'ht' | 'gateway' | 'relay';
type ConnectionMode = 'wifi' | 'ble' | 'auto';

interface DeviceInfo {
  id: string;
  name: string;
  model: string;
  mac: string;
  firmware: string;
  app?: string;
}

function isBluGatewayDevice(device: Partial<DeviceInfo> | null | undefined): boolean {
  if (!device) return false;
  const haystack = [device.id, device.model, device.name, device.app]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    haystack.includes('blugw')
    || haystack.includes('blu gw')
    || haystack.includes('blu gateway')
    || haystack.includes('sngw')
    || haystack.includes('gwf-kz')
    || haystack.includes('ble_gateway')
  );
}

interface ShellySetupWizardProps {
  propertyId?: string;
  initialDeviceType?: DeviceType;
  onComplete?: (device: DeviceInfo) => void;
  onCancel?: () => void;
}

export default function ShellySetupWizard({ 
  propertyId, 
  initialDeviceType,
  onComplete, 
  onCancel 
}: ShellySetupWizardProps) {
  // Device type selection (shown before main flow)
  const [deviceType, setDeviceType] = useState<DeviceType | null>(initialDeviceType || null);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('auto');
  
  const [currentStep, setCurrentStep] = useState(0); // Start at 0 for discovery
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  // Discovery state
  const [discovering, setDiscovering] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<any[]>([]);
  
  // BLE discovery state (for H&T via gateway)
  const [bleDiscovering, setBleDiscovering] = useState(false);
  const [bleDiscoveredDevices, setBleDiscoveredDevices] = useState<any[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<any>(null);
  
  // Device state
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [selectedDeviceIp, setSelectedDeviceIp] = useState('');
  const [relayApMode, setRelayApMode] = useState(false);
  
  // Form state — default IoT SSID for kit installs on GL.iNet
  const [wifiSsid, setWifiSsid] = useState(
    initialDeviceType === 'gateway' || initialDeviceType === 'flood' || initialDeviceType === 'relay'
      ? 'HouseYield-IoT'
      : '',
  );
  const [wifiPassword, setWifiPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [location, setLocation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [networkType, setNetworkType] = useState<'private' | 'public'>('private');

  const baseUrl = resolveShellyApiBaseUrl();
  // AP-mode setup must hit the local backend. Cloud Run cannot reach 192.168.33.1,
  // and the Shelly AP WiFi has no internet — so public API calls fail with
  // ERR_INTERNET_DISCONNECTED. Prefer same-origin (Vite proxy) on localhost,
  // otherwise talk to the local push-server directly.
  const localSetupBaseUrl = (() => {
    if (typeof window === 'undefined') return 'http://127.0.0.1:3001';
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return '';
    return 'http://127.0.0.1:3001';
  })();
  // Always prefer Cloud Run (/api/shelly/webhook). Do NOT prefer the legacy
  // VITE_SHELLY_FIREBASE_WEBHOOK_URL cloud function — it currently 403s.
  const configuredWebhookUrl = resolveShellyWebhookUrl();
  const publicUrl =
    import.meta.env.VITE_SHELLY_SERVER_PUBLIC_URL ||
    import.meta.env.VITE_BACKEND_PUBLIC_URL ||
    import.meta.env.VITE_PUSH_SERVER_URL ||
    '';

  const getPublicOrigin = () => {
    if (publicUrl) {
      try {
        return new URL(publicUrl).origin;
      } catch {
        /* fall through */
      }
    }

    if (configuredWebhookUrl) {
      try {
        const origin = new URL(configuredWebhookUrl).origin;
        // Never treat the legacy cloudfunctions host as the Shelly WS/public origin.
        if (!/cloudfunctions\.net/i.test(origin)) return origin;
      } catch {
        return '';
      }
    }

    return '';
  };
  
  const getWebhookUrl = () => configuredWebhookUrl;

  const setupFetch = async (path: string, init?: RequestInit) => {
    const url = `${localSetupBaseUrl}${path}`;
    try {
      return await fetch(url, init);
    } catch (err) {
      const offlineHint =
        'Local setup backend unreachable. Stay on the ShellyFlood Wi‑Fi, keep `npm run push-server` running, and open the app at http://localhost:5173 (not the production site).';
      throw new Error(
        err instanceof TypeError ? offlineHint : (err instanceof Error ? err.message : offlineHint),
      );
    }
  };

  const getServerWsUrl = () => {
    const publicOrigin = getPublicOrigin();

    if (networkType === 'public' && publicOrigin) {
      const wsUrl = publicOrigin.replace('https://', 'wss://').replace('http://', 'ws://');
      return `${wsUrl}/shelly-ws`;
    }
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${window.location.host}/shelly-ws`;
  };

  // Discover devices on network
  const discoverDevices = async () => {
    setDiscovering(true);
    setError('');
    setDiscoveredDevices([]);
    
    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      const data = await response.json();
      
      if (data.success && data.devices.length > 0) {
        setDiscoveredDevices(data.devices);
        setSuccess(`Found ${data.devices.length} device(s)!`);
      } else {
        setError('No Shelly devices found. Make sure they are powered on and connected to the same network.');
      }
    } catch (err) {
      setError('Failed to scan network. Make sure backend is running.');
    } finally {
      setDiscovering(false);
    }
  };

  const discoverRelayDevices = async () => {
    setDiscovering(true);
    setError('');
    setSuccess('');
    setDiscoveredDevices([]);
    setRelayApMode(false);

    // 1. If connected to the Shelly AP WiFi, the relay lives at 192.168.33.1 — not on a normal scan range.
    try {
      const apResponse = await fetch(`${baseUrl}/api/shelly/setup/check-ap`, {
        method: 'POST',
        signal: AbortSignal.timeout(4000),
      });
      const apData = await apResponse.json();

      if (apData.connected && apData.device) {
        const apDevice = apData.device;
        const isRelay = inferRelayDeviceType(apDevice);
        if (isRelay) {
          setRelayApMode(true);
          setDeviceConnected(true);
          setDeviceInfo(apDevice);
          setSelectedDeviceIp('192.168.33.1');
          setSuccess(`Connected to ${apDevice.name || apDevice.id} in setup mode. Enter your home WiFi below, then configure it.`);
          setDiscovering(false);
          return;
        }
      }
    } catch {
      // Not on Shelly AP — fall through to network scan
    }

    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const data = await response.json();
      const relayDevices = (data.devices || []).filter((device: any) => isRelayDevice(device));

      if (data.success && relayDevices.length > 0) {
        setDiscoveredDevices(relayDevices);
        setSuccess(`Found ${relayDevices.length} Shelly relay controller(s).`);
      } else {
        setError('No Shelly 1 relay controllers found. If you are connected to Shelly1G4-XXXX WiFi, tap Scan again — or enter its IP below (192.168.33.1 in setup mode).');
      }
    } catch (err) {
      setError('Failed to scan for relay controllers. Make sure the backend is running.');
    } finally {
      setDiscovering(false);
    }
  };

  const isRelayDevice = (device: any) => (
    device.deviceType === 'relay'
    || (device.model || '').toLowerCase().includes('shelly 1')
    || (device.app || '').toLowerCase().includes('shelly1')
    || (device.id || '').toLowerCase().includes('shelly1')
  );

  const inferRelayDeviceType = (device: any) => {
    const model = (device.model || '').toLowerCase();
    const app = (device.app || '').toLowerCase();
    const id = (device.id || '').toLowerCase();
    return model.includes('shelly 1') || app.includes('shelly1') || app.includes('1g4') || id.includes('shelly1');
  };

  const configureRelayFromAP = async () => {
    if (!wifiSsid) {
      setError('WiFi network name is required');
      return;
    }
    if (networkType === 'private' && !wifiPassword) {
      setError('WiFi password is required for private networks');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/ap-configure-relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wifiSsid,
          wifiPassword: wifiPassword || '',
          deviceName: deviceName || deviceInfo?.name || 'Water Shutoff Relay',
          location: location || 'Main water shutoff',
          propertyId,
          networkType,
        }),
      });
      const data = await response.json();

      if (data.success) {
        setSuccess(data.message || 'Shelly relay configured. Switch back to your home WiFi, then scan once more to capture its IP.');
        setDeviceInfo({
          id: data.deviceId,
          name: deviceName || deviceInfo?.name || 'Water Shutoff Relay',
          model: data.model || 'Shelly 1 Gen4',
          mac: data.mac || deviceInfo?.mac || '',
          firmware: deviceInfo?.firmware || '',
        });
        setRelayApMode(false);
        setCurrentStep(4);

        if (onComplete) {
          onComplete({
            id: data.deviceId,
            name: deviceName || deviceInfo?.name || 'Water Shutoff Relay',
            model: data.model || 'Shelly 1 Gen4',
            mac: data.mac || deviceInfo?.mac || '',
            firmware: deviceInfo?.firmware || '',
          });
        }
      } else {
        setError(data.error || 'Failed to configure relay from setup WiFi');
      }
    } catch (err: any) {
      setError(`Relay setup failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const registerRelayController = async (deviceIp: string, device?: any) => {
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const response = await fetch(`${baseUrl}/api/shelly/relay/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIp,
          deviceId: device?.id,
          deviceName: deviceName || device?.existingName || device?.name || 'Water Shutoff Relay',
          location: location || device?.existingLocation || 'Main water shutoff',
          propertyId,
        })
      });
      const data = await response.json();

      if (data.success) {
        setSuccess(data.message || 'Shelly relay controller registered.');
        setDeviceInfo({
          id: data.deviceId,
          name: data.device?.name || deviceName || 'Water Shutoff Relay',
          model: data.device?.model || device?.model || 'Shelly 1 Gen4',
          mac: data.device?.mac || device?.mac || '',
          firmware: device?.firmware || ''
        });
        setCurrentStep(4);

        if (onComplete) {
          onComplete({
            id: data.deviceId,
            name: data.device?.name || deviceName || 'Water Shutoff Relay',
            model: data.device?.model || device?.model || 'Shelly 1 Gen4',
            mac: data.device?.mac || device?.mac || '',
            firmware: device?.firmware || ''
          });
        }
      } else {
        setError(data.error || 'Failed to register relay controller');
      }
    } catch (err: any) {
      setError(`Relay registration failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // ─── BLE Gateway Functions ───

  // Check if connected to gateway's AP WiFi
  const checkGatewayAP = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/check-ap-gateway`, { method: 'POST' });
      const data = await response.json();
      if (data.connected) {
        setDeviceConnected(true);
        setDeviceInfo(data.device);
        setGatewayStatus(data);
        return data;
      }
    } catch (err) {
      console.error('Gateway AP check failed:', err);
    }
    setDeviceConnected(false);
    return null;
  };

  // Check if BLU Gateway is reachable on the network (post-setup)
  const checkGatewayStatus = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/shelly/gateway/status`);
      if (response.ok) {
        const data = await response.json();
        setGatewayStatus(data);
        return data;
      }
    } catch (err) {
      console.error('Gateway status check failed:', err);
    }
    setGatewayStatus(null);
    return null;
  };

  // Configure gateway from AP mode (send WiFi creds, enable BLE, set webhooks)
  const configureGatewayFromAP = async () => {
    if (!wifiSsid) {
      setError('WiFi network name is required');
      return;
    }
    if (networkType === 'private' && !wifiPassword) {
      setError('WiFi password is required for private networks');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/ap-configure-gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wifiSsid,
          wifiPassword: wifiPassword || '',
          deviceName: deviceName || 'BLU Gateway',
          propertyId,
          networkType
        })
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(data.message);
        setDeviceInfo({
          id: data.gatewayId,
          name: deviceName || 'BLU Gateway',
          model: data.model || 'Shelly BLU Gateway GWF-KZ01',
          mac: data.mac || '',
          firmware: ''
        });
        setCurrentStep(4); // Completion

        if (onComplete) {
          onComplete({
            id: data.gatewayId,
            name: deviceName || 'BLU Gateway',
            model: data.model || 'Shelly BLU Gateway GWF-KZ01',
            mac: data.mac || '',
            firmware: ''
          });
        }
      } else {
        setError(data.error || 'Gateway configuration failed');
      }
    } catch (err: any) {
      // When the gateway reboots, it disconnects us from its AP WiFi.
      // This causes the fetch to fail with a network error — but the
      // configuration was likely already applied successfully.
      // If we previously detected the device, treat this as success.
      if (deviceConnected && deviceInfo) {
        setSuccess('Gateway configured! It is rebooting and will connect to your WiFi shortly. Reconnect to your home WiFi now.');
        setCurrentStep(4);
      } else {
        setError(
          'Lost connection — the gateway may have rebooted (which means setup succeeded!). ' +
          'Reconnect to your home WiFi and check the Sensors dashboard.'
        );
      }
    } finally {
      setLoading(false);
    }
  };

  // Discover BLE devices via the gateway
  const discoverBleDevices = async () => {
    setBleDiscovering(true);
    setError('');
    setBleDiscoveredDevices([]);
    
    try {
      // Start discovery
      const response = await fetch(`${baseUrl}/api/shelly/gateway/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 30 })
      });
      const data = await response.json();
      
      if (!data.success) {
        setError(data.error || 'BLE discovery failed');
        return;
      }

      // Wait a moment then fetch discovered devices
      await new Promise(r => setTimeout(r, 5000));
      
      const devicesRes = await fetch(`${baseUrl}/api/shelly/gateway/discovered`);
      const devicesData = await devicesRes.json();
      
      if (devicesData.success && devicesData.devices?.length > 0) {
        setBleDiscoveredDevices(devicesData.devices);
        setSuccess(`Found ${devicesData.devices.length} BLE device(s)!`);
      } else {
        setError('No BLE devices found. Make sure your H&T sensor is nearby and powered on.');
      }
    } catch (err) {
      setError('BLE discovery failed. Check that the gateway is online.');
    } finally {
      setBleDiscovering(false);
    }
  };

  // Add a BLE H&T sensor through the gateway
  const addBleHTSensor = async (bleDevice: any) => {
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch(`${baseUrl}/api/shelly/ht/register-via-gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bleAddress: bleDevice.addr || bleDevice.address,
          name: deviceName || `H&T Sensor ${(bleDevice.addr || '').slice(-5)}`,
          location: location || 'Living Room',
          propertyId
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        setSuccess('✅ H&T sensor registered via BLE gateway!');
        setDeviceInfo({
          id: data.deviceId || bleDevice.addr,
          name: deviceName || `H&T Sensor`,
          model: 'Shelly H&T Gen3',
          mac: bleDevice.addr || '',
          firmware: ''
        });
        setCurrentStep(4); // Success
        
        if (onComplete) {
          onComplete({
            id: data.deviceId || bleDevice.addr,
            name: deviceName || `H&T Sensor`,
            model: 'Shelly H&T Gen3',
            mac: bleDevice.addr || '',
            firmware: ''
          });
        }
      } else {
        setError(data.error || 'Failed to register sensor');
      }
    } catch (err: any) {
      setError(`Registration failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Check H&T AP connection
  const checkHTDeviceAP = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/check-ap-ht`, { method: 'POST' });
      const data = await response.json();
      if (data.connected) {
        setDeviceConnected(true);
        setDeviceInfo(data.device);
        return data;
      }
    } catch (err) {
      console.error('H&T AP check failed:', err);
    }
    setDeviceConnected(false);
    return null;
  };

  // Configure H&T from AP mode
  const configureHTFromAP = async () => {
    if (!wifiSsid) {
      setError('WiFi network name is required');
      return;
    }
    if (networkType === 'private' && !wifiPassword) {
      setError('WiFi password is required for private networks');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/ap-configure-ht`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wifiSsid,
          wifiPassword: wifiPassword || '',
          deviceName: deviceName || `H&T Sensor - ${location || 'Home'}`,
          location: location || 'Living Room',
          propertyId,
          networkType
        })
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(data.message);
        setDeviceInfo({
          id: data.deviceId,
          name: deviceName || `H&T Sensor - ${location || 'Home'}`,
          model: data.model || 'Shelly H&T Gen3',
          mac: data.mac || '',
          firmware: ''
        });
        setCurrentStep(4);

        if (onComplete) {
          onComplete({
            id: data.deviceId,
            name: deviceName || `H&T Sensor - ${location || 'Home'}`,
            model: data.model || 'Shelly H&T Gen3',
            mac: data.mac || '',
            firmware: ''
          });
        }
      } else {
        setError(data.error || 'H&T configuration failed');
      }
    } catch (err: any) {
      // When the device reboots, it disconnects us from its AP WiFi.
      if (deviceConnected && deviceInfo) {
        setSuccess('H&T sensor configured! It is rebooting and will connect to your WiFi shortly. Reconnect to your home WiFi now.');
        setCurrentStep(4);
      } else {
        setError(
          'Lost connection — the sensor may have rebooted (which means setup succeeded!). ' +
          'Reconnect to your home WiFi and check the Sensors dashboard.'
        );
      }
    } finally {
      setLoading(false);
    }
  };

  // Discover H&T sensors — first check if we're on the sensor's AP WiFi,
  // then fall back to network scan (same pattern as Flood's check-ap)
  const discoverHTDevices = async () => {
    setDiscovering(true);
    setError('');
    setDiscoveredDevices([]);
    
    // 1. First, check if we're already on the sensor's AP (192.168.33.1)
    //    This is how Flood handles it — direct AP detection
    try {
      const apResponse = await fetch(`${baseUrl}/api/shelly/setup/check-ap-ht`, { 
        method: 'POST',
        signal: AbortSignal.timeout(4000)
      });
      const apData = await apResponse.json();
      
      if (apData.connected && apData.device) {
        // We're on the sensor's AP WiFi! Skip straight to configure.
        setDeviceConnected(true);
        setDeviceInfo(apData.device);
        setSuccess(`Found H&T sensor: ${apData.device.name || apData.device.id}! Jumping to configuration...`);
        setConnectionMode('wifi');
        setDiscovering(false);
        setCurrentStep(3); // Go straight to WiFi config step
        return;
      }
    } catch {
      // AP check failed — we're probably on our home network, try scan
      console.log('Not on sensor AP, trying network scan...');
    }

    // 2. Fall back to network scan for sensors already on the network
    try {
      const response = await fetch(`${baseUrl}/api/shelly/setup/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      const data = await response.json();
      
      if (data.success && data.devices.length > 0) {
        // Filter to show H&T devices (or show all and let user pick)
        const htDevices = data.devices.filter((d: any) => 
          (d.model || '').toLowerCase().includes('ht') || 
          (d.id || '').toLowerCase().includes('ht') ||
          (d.name || '').toLowerCase().includes('ht') ||
          (d.model || '').toLowerCase().includes('temperature')
        );
        const allDevices = htDevices.length > 0 ? htDevices : data.devices;
        setDiscoveredDevices(allDevices);
        setSuccess(`Found ${allDevices.length} device(s)!`);
      } else {
        setError('No Shelly devices found. If this is a new sensor, connect to its WiFi (ShellyHTG3-XXXX) first, then tap "Scan Network" again — or use "Set up new sensor" below.');
      }
    } catch {
      setError('Can\'t reach backend server. If you\'re on the sensor\'s WiFi (ShellyHTG3-XXXX), tap "Scan Network" again — the server will detect it via AP mode.');
    } finally {
      setDiscovering(false);
    }
  };

  // Quick-register H&T sensor found on network
  const quickSetupHTDevice = async (device: any) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${baseUrl}/api/shelly/ht/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: device.id,
          ip: device.ip,
          name: deviceName || device.name || `H&T Sensor`,
          location: location || 'Living Room',
          propertyId
        })
      });
      const data = await response.json();
      if (data.success) {
        // Also configure Firebase webhook
        try {
          await fetch(`${baseUrl}/api/shelly/setup/configure-ht-webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceIp: device.ip,
              deviceId: device.id,
              deviceName: deviceName || device.name || `H&T Sensor`,
              location: location || 'Living Room',
              propertyId
            })
          });
        } catch (e) {
          console.log('Webhook config optional:', e);
        }
        setSuccess('✅ H&T sensor registered!');
        setDeviceInfo({
          id: data.sensor?.deviceId || device.id,
          name: deviceName || device.name || 'H&T Sensor',
          model: device.model || 'Shelly H&T Gen3',
          mac: device.mac || '',
          firmware: device.firmware || ''
        });
        setCurrentStep(4);
        if (onComplete) {
          onComplete({
            id: data.sensor?.deviceId || device.id,
            name: deviceName || device.name || 'H&T Sensor',
            model: device.model || 'Shelly H&T Gen3',
            mac: device.mac || '',
            firmware: device.firmware || ''
          });
        }
      } else {
        setError(data.error || 'Registration failed');
      }
    } catch (err: any) {
      setError(`Failed to register: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Deploy BLE scanner script to gateway
  const setupGatewayWebhooks = async () => {
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch(`${baseUrl}/api/shelly/gateway/deploy-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      const data = await response.json();
      
      if (data.success) {
        setSuccess('✅ BLU Gateway BLE scanner script deployed! Sensors will be auto-discovered.');
        setDeviceInfo({
          id: data.gatewayId || 'blu-gateway',
          name: 'BLU Gateway',
          model: 'Shelly BLU Gateway',
          mac: '',
          firmware: ''
        });
        setCurrentStep(4);
        
        if (onComplete) {
          onComplete({
            id: data.gatewayId || 'blu-gateway',
            name: 'BLU Gateway',
            model: 'Shelly BLU Gateway',
            mac: '',
            firmware: ''
          });
        }
      } else {
        setError(data.error || 'Script deployment failed');
      }
    } catch (err: any) {
      setError(`Gateway setup failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Configure Firebase webhook via backend (avoids CORS issues)
  const configureFirebaseWebhook = async (device: any) => {
    setLoading(true);
    setError('');
    setSuccess('');
    
    try {
      console.log(`🔧 Configuring Firebase webhook for ${device.id} at ${device.ip}`);
      const isHTDevice =
        (device.type || '').toLowerCase() === 'ht' ||
        (device.type || '').toLowerCase() === 'temperature_humidity' ||
        (device.model || '').toLowerCase().includes('ht') ||
        (device.model || '').toLowerCase().includes('temperature') ||
        (device.model || '').toLowerCase().includes('humidity') ||
        (device.id || '').toLowerCase().includes('ht');
      const endpoint = isHTDevice
        ? '/api/shelly/setup/configure-ht-webhook'
        : '/api/shelly/setup/configure-firebase-webhook';
      
      // Use backend endpoint which can talk to the device directly
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIp: device.ip,
          deviceId: device.id,
          deviceName: deviceName || device.name || device.existingName || `Sensor ${device.id.slice(-4)}`,
          location: location || device.existingLocation || 'Bathroom',
          propertyId
        })
      });

      const data = await response.json();
      console.log('Configure response:', data);

      if (data.success) {
        const isReconnect = data.previouslyRegistered;
        setSuccess(isReconnect
          ? `🔄 ${data.message || 'Sensor reconnected! Webhooks reconfigured for the new network.'}`
          : `✅ ${data.message || 'Device configured for Firebase alerts!'}`
        );
        setDeviceInfo({
          id: data.deviceId,
          name: deviceName || device.name || data.device?.name,
          model: data.device?.model || device.model,
          mac: data.device?.mac || device.mac,
          firmware: device.firmware
        });
        setCurrentStep(4); // Go to success step
        
        if (onComplete) {
          onComplete({
            id: data.deviceId,
            name: deviceName || device.name || data.device?.name,
            model: data.device?.model || device.model,
            mac: data.device?.mac || device.mac,
            firmware: device.firmware
          });
        }
      } else {
        // Check if the device is sleeping (battery sensor)
        if (data.hint === 'battery_sleep') {
          setError(`⚡ ${data.error}\n\nTip: Battery-powered sensors go to sleep after ~30 seconds. Press the button on the sensor, then immediately click "Configure" again.`);
        } else {
          setError(data.error || 'Failed to configure device');
        }
      }
    } catch (err: any) {
      console.error('Configuration error:', err);
      setError(`Failed to configure device: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Quick setup with discovered device - now uses Firebase webhook configuration
  const quickSetupDevice = async (device: any) => {
    await configureFirebaseWebhook(device);
  };

  // Check if connected to device AP
  const checkDeviceConnection = useCallback(async () => {
    setLoading(true);
    setError('');
    
    try {
      const response = await setupFetch('/api/shelly/setup/check-ap', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      
      if (data.connected) {
        setDeviceConnected(true);
        setDeviceInfo(data.device);
        if (isBluGatewayDevice(data.device)) {
          setDeviceType('gateway');
          setCurrentStep(1);
          setWifiSsid((prev) => prev || 'HouseYield-IoT');
          setSuccess(`Detected BLU Gateway ${data.device.model || data.device.id}. Continue with gateway Wi‑Fi setup.`);
          setError('');
        } else {
          setSuccess(`Found device: ${data.device.name || data.device.id}`);
        }
      } else {
        setDeviceConnected(false);
        setError(data.message || 'Not connected to Shelly device AP. Connect to ShellyFloodG4-XXXX Wi‑Fi first.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot reach server. Make sure the backend is running.');
    } finally {
      setLoading(false);
    }
  }, [localSetupBaseUrl]);

  // Configure the device
  const configureDevice = async () => {
    if (isBluGatewayDevice(deviceInfo) || deviceType === 'gateway') {
      setDeviceType('gateway');
      setCurrentStep(1);
      setError('');
      setSuccess('Detected Shelly BLU Gateway — use the gateway setup flow instead of Flood Gen4.');
      return;
    }

    if (!wifiSsid) {
      setError('WiFi name is required');
      return;
    }
    
    // Password not required for public/open networks
    if (networkType === 'private' && !wifiPassword) {
      setError('WiFi password is required for private networks');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Use the appropriate URLs based on network type
      const serverUrl = getServerWsUrl();
      const webhookUrl = getWebhookUrl();
      
      console.log('Configuring device with:', { networkType, serverUrl, webhookUrl, localSetupBaseUrl });

      // Verify the Shelly AP is reachable via the local backend before Wi‑Fi handoff.
      const apCheck = await setupFetch('/api/shelly/setup/check-ap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const apCheckData = await apCheck.json().catch(() => ({}));
      if (!apCheckData?.connected) {
        setError(
          'Cannot reach the Flood Gen4 at 192.168.33.1. Stay connected to ShellyFloodG4-XXXX Wi‑Fi (not HouseYield-IoT yet), keep the local backend running, then try Configure again.',
        );
        return;
      }

      const response = await setupFetch('/api/shelly/setup/ap-configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wifiSsid,
          wifiPassword: wifiPassword || '', // Empty for open networks
          deviceName: deviceName || `Flood Sensor - ${location}`,
          location,
          propertyId,
          serverUrl,
          webhookUrl,
          networkType // Send to backend for logging
        }),
        signal: AbortSignal.timeout(180000),
      });

      const data = await response.json();

      if (data.success) {
        setSuccess(data.message || 'Device configured successfully!');
        setCurrentStep(4); // Now step 4 is the completion step (was 4, now shifted)
        
        if (onComplete) {
          onComplete({
            ...(deviceInfo || {}),
            id: data.deviceId || deviceInfo?.id,
            name: deviceName || deviceInfo?.name || data.deviceId,
          });
        }
      } else {
        const errMsg = data.error || 'Configuration failed';
        if (/timeout/i.test(errMsg)) {
          setError(`${errMsg}\n\nThe sensor may have already joined your Wi‑Fi. Connect your laptop to "${wifiSsid}", wake the sensor, then use Discover → Scan Network → Configure for Firebase instead.`);
        } else {
          setError(errMsg);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to configure device. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Auto-check connection when on step 2 (Connect to Device WiFi)
  useEffect(() => {
    if (currentStep === 2) {
      const interval = setInterval(() => {
        if (!deviceConnected) {
          checkDeviceConnection();
        }
      }, 3000);

      return () => clearInterval(interval);
    }
  }, [currentStep, deviceConnected, checkDeviceConnection]);

  return (
    <div className="max-w-2xl mx-auto bg-white rounded-xl shadow-lg overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="text-3xl">
              {deviceType === 'gateway' ? '📡' : deviceType === 'ht' ? '🌡️' : deviceType === 'flood' ? '💧' : deviceType === 'relay' ? '🚰' : '🏠'}
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">
                {deviceType === 'gateway' ? 'BLU Gateway Setup' 
                  : deviceType === 'ht' ? 'H&T Sensor Setup'
                  : deviceType === 'flood' ? 'Flood Sensor Setup'
                  : deviceType === 'relay' ? 'Water Shutoff Relay Setup'
                  : 'Shelly Sensor Setup'}
              </h2>
              <p className="text-blue-100 text-sm">
                {deviceType === 'gateway' ? 'BLE bridge for all Shelly sensors'
                  : deviceType === 'ht' ? 'Temperature & humidity monitoring'
                  : deviceType === 'relay' ? 'Register a Shelly 1 Gen4 valve relay already on WiFi'
                  : 'Direct integration - No cloud required'}
              </p>
            </div>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-white/80 hover:text-white"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Device Type Selection (before steps) ── */}
      {!deviceType && (
        <div className="p-6 space-y-6">
          <div className="text-center">
            <h3 className="text-xl font-semibold mb-2">What device are you setting up?</h3>
            <p className="text-gray-600 text-sm">Select your Shelly device type to begin</p>
          </div>

          <div className="grid grid-cols-1 gap-3">
            {/* BLU Gateway */}
            <button
              onClick={() => { setDeviceType('gateway'); setCurrentStep(0); }}
              className="flex items-start space-x-4 p-4 border-2 border-gray-200 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition text-left"
            >
              <span className="text-4xl">📡</span>
              <div>
                <div className="font-semibold text-gray-800">BLU Gateway (GWF-KZ01)</div>
                <div className="text-sm text-gray-500 mt-1">
                  USB-A BLE bridge — connects all Bluetooth Shelly sensors to your WiFi network. 
                  <span className="text-blue-600 font-medium"> Set this up first.</span>
                </div>
                <div className="flex gap-2 mt-2">
                  <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">BLE → WiFi</span>
                  <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full">USB Powered</span>
                </div>
              </div>
            </button>

            {/* H&T Gen3 */}
            <button
              onClick={() => { setDeviceType('ht'); setCurrentStep(0); }}
              className="flex items-start space-x-4 p-4 border-2 border-gray-200 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition text-left"
            >
              <span className="text-4xl">🌡️</span>
              <div>
                <div className="font-semibold text-gray-800">H&T Gen3 (Temperature & Humidity)</div>
                <div className="text-sm text-gray-500 mt-1">
                  Battery-powered sensor for mold prevention, pipe burst detection, and energy monitoring. 
                  Works via BLE gateway or direct WiFi.
                </div>
                <div className="flex gap-2 mt-2">
                  <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full">BLE Preferred</span>
                  <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full">WiFi Fallback</span>
                  <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">Battery</span>
                </div>
              </div>
            </button>

            {/* Flood Gen4 */}
            <button
              onClick={() => { setDeviceType('flood'); setCurrentStep(0); }}
              className="flex items-start space-x-4 p-4 border-2 border-gray-200 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition text-left"
            >
              <span className="text-4xl">💧</span>
              <div>
                <div className="font-semibold text-gray-800">Flood Gen4 (Water Leak)</div>
                <div className="text-sm text-gray-500 mt-1">
                  Water leak detection sensor. Instant alerts via Firebase webhook.
                </div>
                <div className="flex gap-2 mt-2">
                  <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">WiFi Direct</span>
                  <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">Battery</span>
                </div>
              </div>
            </button>

            <button
              onClick={() => { setDeviceType('relay'); setCurrentStep(0); }}
              className="flex items-start space-x-4 p-4 border-2 border-gray-200 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition text-left"
            >
              <span className="text-4xl">🚰</span>
              <div>
                <div className="font-semibold text-gray-800">Shelly 1 Gen4 (Water Shutoff Relay)</div>
                <div className="text-sm text-gray-500 mt-1">
                  Dry-contact relay controller for the Bulldog automatic water shutoff valve.
                </div>
                <div className="flex gap-2 mt-2">
                  <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">WiFi Relay</span>
                  <span className="text-xs px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">Water Shutoff</span>
                </div>
              </div>
            </button>
          </div>
        </div>
      )}

      {deviceType === 'relay' && currentStep !== 4 && (
        <div className="p-6">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
          {success && !error && (
            <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{success}</div>
          )}

          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">🚰</div>
              <h3 className="text-xl font-semibold mb-2">Register Your Shelly 1 Gen4</h3>
              <p className="text-gray-600">
                If you already finished WiFi setup in the Shelly app, HouseYield still needs to register the controller before it can appear in the dashboard and receive valve commands.
              </p>
            </div>

            <div className="rounded-lg bg-blue-50 p-4">
              <h4 className="mb-2 font-medium text-blue-800">Two setup paths</h4>
              <ul className="space-y-1 text-sm text-blue-700">
                <li>• <strong>New / factory reset:</strong> connect to <strong>Shelly1G4-XXXX</strong> WiFi, tap Scan, enter your <strong>GL.iNet IoT SSID</strong> (e.g. HouseYield-IoT), then Configure</li>
                <li>• <strong>Already on the IoT network:</strong> connect your laptop to that same GL.iNet WiFi, tap Scan, then Register</li>
                <li>• <strong>Offline safety:</strong> after the relay is registered, flood sensors on the same property are programmed to close this valve locally over the GL.iNet LAN during internet outages</li>
              </ul>
            </div>

            <div className="rounded-lg bg-blue-50 p-4">
              <h4 className="mb-2 font-medium text-blue-800">Why it was missing</h4>
              <p className="text-sm text-blue-700">
                The HouseYield Shelly flow previously only onboarded flood sensors, H&amp;T sensors, and BLU gateways. A Shelly 1 relay configured outside HouseYield never created a dashboard device record on its own.
              </p>
            </div>

            <div className="rounded-lg bg-gray-50 p-4 space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Controller Name</label>
                <input
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g., Main Water Shutoff Relay"
                  className="w-full rounded-lg border px-3 py-2 focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Location</label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g., Basement main shutoff"
                  className="w-full rounded-lg border px-3 py-2 focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Manual IP (optional)</label>
                <input
                  type="text"
                  value={selectedDeviceIp}
                  onChange={(e) => setSelectedDeviceIp(e.target.value)}
                  placeholder="192.168.33.1 in setup mode, or home-network IP"
                  className="w-full rounded-lg border px-3 py-2 focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {relayApMode && (
              <div className="space-y-4 rounded-lg border border-green-200 bg-green-50 p-4">
                <div>
                  <h4 className="font-medium text-green-800">Setup mode detected</h4>
                  <p className="mt-1 text-sm text-green-700">
                    You are connected to <strong>{deviceInfo?.name || deviceInfo?.id || 'Shelly 1 Gen4'}</strong> at <strong>192.168.33.1</strong>.
                    Enter the <strong>GL.iNet IoT WiFi</strong> it should join permanently (for example <strong>HouseYield-IoT</strong>).
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Target WiFi Network Name *</label>
                  <input
                    type="text"
                    value={wifiSsid}
                    onChange={(e) => setWifiSsid(e.target.value)}
                    placeholder="e.g., HouseYield-IoT"
                    className="w-full rounded-lg border px-3 py-2 focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Target WiFi Password {networkType === 'private' ? '*' : '(optional)'}
                  </label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={wifiPassword}
                    onChange={(e) => setWifiPassword(e.target.value)}
                    placeholder="WiFi password"
                    className="w-full rounded-lg border px-3 py-2 focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={networkType === 'private'}
                      onChange={() => setNetworkType('private')}
                    />
                    Private network
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={networkType === 'public'}
                      onChange={() => setNetworkType('public')}
                    />
                    Open network
                  </label>
                </div>

                <button
                  onClick={configureRelayFromAP}
                  disabled={loading || !wifiSsid || (networkType === 'private' && !wifiPassword)}
                  className="w-full rounded-lg bg-green-600 py-3 font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
                >
                  {loading ? 'Configuring relay...' : 'Configure WiFi & Register Relay'}
                </button>
              </div>
            )}

            {discoveredDevices.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-medium text-gray-700">Found relay controllers</h4>
                {discoveredDevices.map((device: any) => (
                  <div key={device.id} className="rounded-lg border p-4 transition hover:border-blue-500">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="font-medium text-gray-800">{device.name || device.id}</div>
                        <div className="text-sm text-gray-500">{device.model || 'Shelly 1 Gen4'} • {device.ip}</div>
                        <div className="text-xs text-gray-400">MAC: {device.mac}</div>
                      </div>
                      <button
                        onClick={() => registerRelayController(device.ip, device)}
                        disabled={loading}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {loading ? 'Registering...' : 'Register Relay'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={discoverRelayDevices}
              disabled={discovering}
              className="w-full rounded-lg bg-blue-600 py-3 font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {discovering ? 'Scanning local network...' : '🔍 Scan Network for Shelly 1'}
            </button>

            <button
              onClick={() => registerRelayController(selectedDeviceIp)}
              disabled={loading || !selectedDeviceIp}
              className={`w-full rounded-lg py-3 font-medium transition ${
                !loading && selectedDeviceIp
                  ? 'border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                  : 'cursor-not-allowed border border-gray-200 bg-gray-100 text-gray-400'
              }`}
            >
              {loading ? 'Registering...' : 'Register Using Manual IP'}
            </button>

            <button
              onClick={() => { setDeviceType(null); setCurrentStep(0); setError(''); setSuccess(''); }}
              className="w-full py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              ← Change device type
            </button>
          </div>
        </div>
      )}

      {/* ── Gateway Setup Flow (AP Mode) ── */}
      {deviceType === 'gateway' && (
        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
          )}
          {success && !error && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{success}</div>
          )}

          {/* Step 0: Plug in & connect to gateway WiFi */}
          {currentStep === 0 && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="text-6xl mb-4">📡</div>
                <h3 className="text-xl font-semibold mb-2">Set Up BLU Gateway</h3>
                <p className="text-gray-600">
                  No app needed — we'll configure it directly.
                </p>
              </div>

              <div className="bg-blue-50 rounded-lg p-4">
                <h4 className="font-medium text-blue-800 mb-2">Step 1: Plug it in</h4>
                <ul className="text-blue-700 text-sm space-y-1">
                  <li>• Plug the BLU Gateway into any <strong>USB-A</strong> power source</li>
                  <li>• Wait ~10 seconds for the LED to start blinking</li>
                  <li>• It creates its own WiFi hotspot automatically</li>
                </ul>
              </div>

              <div className="bg-gray-100 rounded-lg p-4">
                <h4 className="font-medium mb-2">Step 2: Connect to its WiFi</h4>
                <p className="text-sm text-gray-600 mb-2">On your phone/computer, open WiFi settings and connect to:</p>
                <div className="font-mono text-lg bg-white px-4 py-2 rounded border text-center">
                  ShellyBluGw-XXXXXXXXXXXX
                </div>
                <div className="mt-3 p-3 bg-yellow-50 border border-yellow-300 rounded-lg">
                  <h5 className="font-medium text-yellow-800 mb-1">📋 Password:</h5>
                  <p className="text-sm text-yellow-700">
                    Check the <strong>label on the gateway</strong> for the password. 
                    It's usually the Device ID (the XXXX part) or printed on the sticker.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-center space-x-2">
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                    <span className="text-gray-600">Looking for gateway...</span>
                  </>
                ) : deviceConnected ? (
                  <>
                    <div className="text-green-500 text-xl">✓</div>
                    <span className="text-green-600 font-medium">
                      Connected to {deviceInfo?.name || deviceInfo?.id || 'BLU Gateway'}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="text-gray-400 text-xl">○</div>
                    <span className="text-gray-500">Not connected to gateway</span>
                  </>
                )}
              </div>

              <button
                onClick={async () => {
                  setLoading(true);
                  setError('');
                  const result = await checkGatewayAP();
                  setLoading(false);
                  if (result?.connected) {
                    setCurrentStep(1);
                  } else {
                    setError('Cannot reach gateway. Make sure you\'re connected to the ShellyBluGw-XXXX WiFi network and wait a few seconds before trying again.');
                  }
                }}
                disabled={loading}
                className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
              >
                {loading ? 'Checking...' : deviceConnected ? 'Continue →' : 'Check Connection'}
              </button>

              <button
                onClick={() => { setDeviceType(null); setCurrentStep(0); setError(''); }}
                className="w-full py-2 text-sm text-gray-600 hover:text-gray-800"
              >
                ← Change device type
              </button>
            </div>
          )}

          {/* Step 1: Enter home WiFi credentials */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="text-6xl mb-4">📶</div>
                <h3 className="text-xl font-semibold mb-2">Configure Gateway WiFi</h3>
                <p className="text-gray-600">
                  Join the gateway to <strong>HouseYield-IoT</strong> (GL.iNet). That router uplinks to the home Wi‑Fi and Cloud Run.
                </p>
              </div>

              {deviceInfo && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-center space-x-2">
                    <span className="text-green-500">✓</span>
                    <span className="font-medium text-green-800">
                      Gateway: {deviceInfo.model || 'BLU Gateway'} ({deviceInfo.id?.slice(-6) || ''})
                    </span>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                {/* Network Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Network Type</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setNetworkType('private')}
                      className={`p-3 rounded-lg border-2 text-left transition ${
                        networkType === 'private' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <span className="text-xl">🏠</span>
                        <div>
                          <div className="font-medium">Private WiFi</div>
                          <div className="text-xs text-gray-500">Home/Office</div>
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNetworkType('public')}
                      className={`p-3 rounded-lg border-2 text-left transition ${
                        networkType === 'public' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        <span className="text-xl">🌐</span>
                        <div>
                          <div className="font-medium">Open/Public</div>
                          <div className="text-xs text-gray-500">No password</div>
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">WiFi Network Name *</label>
                  <input
                    type="text"
                    value={wifiSsid}
                    onChange={(e) => setWifiSsid(e.target.value)}
                    placeholder="HouseYield-IoT"
                    className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Use HouseYield-IoT (2.4GHz), not the tenant home SSID directly</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    WiFi Password {networkType === 'private' ? '*' : '(optional)'}
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={wifiPassword}
                      onChange={(e) => setWifiPassword(e.target.value)}
                      placeholder={networkType === 'public' ? 'Leave empty for open network' : 'HouseYield-IoT password'}
                      className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                    >
                      {showPassword ? '🙈' : '👁️'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Gateway Name (Optional)</label>
                  <input
                    type="text"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="e.g., Living Room Gateway"
                    className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="bg-blue-50 rounded-lg p-4">
                <h4 className="font-medium text-blue-800 mb-1">What happens next:</h4>
                <ul className="text-blue-700 text-sm space-y-1">
                  <li>• Gateway joins HouseYield-IoT (GL.iNet)</li>
                  <li>• GL.iNet uplinks to home Wi‑Fi → Cloud Run</li>
                  <li>• BLE sensor bridging is enabled</li>
                  <li>• Your laptop will disconnect from the ShellyBluGw hotspot (normal)</li>
                </ul>
              </div>

              <div className="flex space-x-3">
                <button
                  onClick={() => { setCurrentStep(0); setDeviceConnected(false); setError(''); }}
                  className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
                >
                  ← Back
                </button>
                <button
                  onClick={configureGatewayFromAP}
                  disabled={loading || !wifiSsid || (networkType === 'private' && !wifiPassword)}
                  className={`flex-1 py-3 rounded-lg font-medium transition ${
                    !loading && wifiSsid && (networkType === 'public' || wifiPassword)
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  }`}
                >
                  {loading ? 'Configuring...' : '🚀 Configure Gateway'}
                </button>
              </div>
            </div>
          )}

          {/* Gateway completion — reuses shared step 4 below */}
        </div>
      )}

      {/* ── H&T Sensor Setup Flow (unified wizard like Flood) ── */}
      {deviceType === 'ht' && (
        <>
      {/* Progress Steps */}
      <div className="px-6 py-4 bg-gray-50 border-b">
        <div className="flex items-center justify-between">
          {[0, 1, 2, 3, 4].map((step) => (
            <div key={step} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step < currentStep
                    ? 'bg-green-500 text-white'
                    : step === currentStep
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {step < currentStep ? '✓' : step === 0 ? '🔍' : step}
              </div>
              {step < 4 && (
                <div
                  className={`w-12 h-1 mx-1 ${
                    step < currentStep ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between mt-2 text-xs text-gray-500">
          <span>Discover</span>
          <span>Power On</span>
          <span>Connect</span>
          <span>Configure</span>
          <span>Done</span>
        </div>
      </div>

      {/* Step Content */}
      <div className="p-6">
        {/* Error/Success Messages */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}
        {success && !error && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            {success}
          </div>
        )}

        {/* Step 0: Auto-Discovery */}
        {currentStep === 0 && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">🔍</div>
              <h3 className="text-xl font-semibold mb-2">Find Your H&T Sensor</h3>
              <p className="text-gray-600">
                Let's scan your network for Shelly H&T sensors.
              </p>
            </div>

            <div className="bg-blue-50 rounded-lg p-4">
              <h4 className="font-medium text-blue-800 mb-2">How it works:</h4>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>• <strong>Already on sensor WiFi?</strong> Connect to <code className="bg-blue-100 px-1 rounded">ShellyHTG3-XXXX</code> first, then tap Scan — we'll detect it automatically</li>
                <li>• <strong>Sensor already on your home WiFi?</strong> Just tap Scan to find it on the network</li>
                <li>• <strong>Brand new sensor?</strong> Use <strong>"Set up new sensor"</strong> below for step-by-step WiFi setup</li>
              </ul>
            </div>

            {discoveredDevices.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-medium text-gray-700">Found {discoveredDevices.length} device(s):</h4>
                
                {/* Device name and location fields */}
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Sensor Name</label>
                    <input
                      type="text"
                      value={deviceName}
                      onChange={(e) => setDeviceName(e.target.value)}
                      placeholder="e.g., Basement Temp/Humidity"
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                    <select
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select location...</option>
                      <option value="Basement">Basement</option>
                      <option value="Bathroom">Bathroom</option>
                      <option value="Bedroom">Bedroom</option>
                      <option value="Kitchen">Kitchen</option>
                      <option value="Living Room">Living Room</option>
                      <option value="Attic">Attic</option>
                      <option value="Garage">Garage</option>
                      <option value="Crawl Space">Crawl Space</option>
                      <option value="HVAC">HVAC / Utility</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </div>

                {discoveredDevices.map((device: any) => (
                  <div key={device.id} className={`border rounded-lg p-4 transition ${
                    device.previouslyRegistered
                      ? 'border-amber-300 bg-amber-50 hover:border-amber-500'
                      : 'hover:border-blue-500'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          🌡️ {device.name || device.id}
                          {device.previouslyRegistered && (
                            <span className="text-xs px-2 py-0.5 bg-amber-200 text-amber-800 rounded-full font-normal">
                              🔄 Previously Registered
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-500">{device.model} • {device.ip}</div>
                        <div className="text-xs text-gray-400">MAC: {device.mac}</div>
                        {device.previouslyRegistered && device.previousIp && device.previousIp !== device.ip && (
                          <div className="text-xs text-amber-600 mt-1">
                            📍 Was at {device.previousIp} → Now at {device.ip}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => quickSetupHTDevice(device)}
                        disabled={loading}
                        className={`px-4 py-2 rounded-lg disabled:opacity-50 flex items-center space-x-2 ${
                          device.previouslyRegistered
                            ? 'bg-amber-600 text-white hover:bg-amber-700'
                            : 'bg-blue-600 text-white hover:bg-blue-700'
                        }`}
                      >
                        {loading ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                            <span>{device.previouslyRegistered ? 'Reconnecting...' : 'Registering...'}</span>
                          </>
                        ) : (
                          <span>{device.previouslyRegistered ? '🔄 Reconnect Sensor' : 'Register Sensor'}</span>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
                
                <div className="text-sm text-gray-500 bg-blue-50 p-3 rounded-lg">
                  <strong>💡 What happens next:</strong>
                  <ul className="mt-1 space-y-1">
                    <li>• Sensor will be registered in your dashboard</li>
                    <li>• Temperature & humidity data polled automatically</li>
                    <li>• Firebase alerts for mold risk, freeze warnings</li>
                  </ul>
                </div>
              </div>
            )}

            <button
              onClick={discoverHTDevices}
              disabled={discovering}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              {discovering ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  <span>Scanning network...</span>
                </>
              ) : (
                <>
                  <span>🔍 Scan Network / Detect Sensor</span>
                </>
              )}
            </button>

            {/* Alternative setup paths */}
            <div className="border-t pt-4 space-y-3">
              <button
                onClick={() => { setConnectionMode('wifi'); setCurrentStep(1); }}
                className="w-full py-3 border-2 border-blue-200 bg-blue-50 text-blue-700 rounded-lg font-medium hover:bg-blue-100 transition"
              >
                📶 Set up new sensor (step-by-step WiFi setup) →
              </button>
              <button
                onClick={async () => {
                  setConnectionMode('ble');
                  setError('');
                  setLoading(true);
                  const status = await checkGatewayStatus();
                  setLoading(false);
                  if (status) {
                    setCurrentStep(1);
                  } else {
                    setError('BLU Gateway not found. Set up the gateway first, or use WiFi setup above.');
                  }
                }}
                disabled={loading}
                className="w-full py-2 text-sm text-blue-600 hover:text-blue-800 font-medium"
              >
                {loading ? 'Checking gateway...' : '🔵 Add via BLE Gateway instead'}
              </button>
            </div>

            <button
              onClick={() => { setDeviceType(null); setCurrentStep(0); setError(''); }}
              className="w-full py-2 text-sm text-gray-400 hover:text-gray-600"
            >
              ← Change device type
            </button>
          </div>
        )}

        {/* Step 1: BLE Discovery via Gateway (only if BLE mode selected) */}
        {currentStep === 1 && connectionMode === 'ble' && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">🔍</div>
              <h3 className="text-xl font-semibold mb-2">Discover BLE Sensors</h3>
              <p className="text-gray-600">Scanning via your BLU Gateway for nearby H&T sensors.</p>
            </div>

            <div className="bg-blue-50 rounded-lg p-4">
              <h4 className="font-medium text-blue-800 mb-2">Preparation:</h4>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>• Insert batteries into your H&T Gen3 sensor</li>
                <li>• Place it within 10 meters of the BLU Gateway</li>
                <li>• The E-ink display should show readings</li>
              </ul>
            </div>

            {/* Name & location fields */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Sensor Name</label>
                <input
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g., Basement H&T"
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select location...</option>
                  <option value="Basement">Basement</option>
                  <option value="Bathroom">Bathroom</option>
                  <option value="Bedroom">Bedroom</option>
                  <option value="Kitchen">Kitchen</option>
                  <option value="Living Room">Living Room</option>
                  <option value="Attic">Attic</option>
                  <option value="Garage">Garage</option>
                  <option value="Crawl Space">Crawl Space</option>
                  <option value="HVAC">HVAC / Utility</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            {bleDiscoveredDevices.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-medium text-gray-700">Found {bleDiscoveredDevices.length} BLE device(s):</h4>
                {bleDiscoveredDevices.map((device: any, idx: number) => (
                  <div key={idx} className="border rounded-lg p-4 hover:border-blue-500 transition">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">🌡️ {device.name || 'Shelly H&T'}</div>
                        <div className="text-sm text-gray-500">BLE: {device.addr || device.address}</div>
                        {device.rssi && <div className="text-xs text-gray-400">Signal: {device.rssi} dBm</div>}
                      </div>
                      <button
                        onClick={() => addBleHTSensor(device)}
                        disabled={loading}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                      >
                        {loading ? 'Adding...' : 'Add Sensor'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={discoverBleDevices}
              disabled={bleDiscovering}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              {bleDiscovering ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  <span>Scanning for BLE devices...</span>
                </>
              ) : (
                <span>🔍 Start BLE Scan</span>
              )}
            </button>

            <button
              onClick={() => { setCurrentStep(0); setConnectionMode('auto'); setBleDiscoveredDevices([]); setError(''); }}
              className="w-full py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              ← Back
            </button>
          </div>
        )}

        {/* Step 1: Power On (WiFi manual mode) */}
        {currentStep === 1 && connectionMode === 'wifi' && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">🔋</div>
              <h3 className="text-xl font-semibold mb-2">Step 1: Power On Sensor</h3>
              <p className="text-gray-600">
                Insert batteries or connect USB-C to the Shelly H&T Gen3.
              </p>
            </div>

            <div className="bg-blue-50 rounded-lg p-4">
              <h4 className="font-medium text-blue-800 mb-2">What to look for:</h4>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>• Insert 4× AA batteries or plug in USB-C cable</li>
                <li>• The E-ink display will show "SEt AP" with a Bluetooth icon</li>
                <li>• The sensor creates its own WiFi network for setup</li>
              </ul>
            </div>

            <div className="bg-yellow-50 rounded-lg p-4">
              <h4 className="font-medium text-yellow-800 mb-2">💡 Tip:</h4>
              <p className="text-yellow-700 text-sm">
                If the display doesn't show "SEt AP", press and hold the reset button for 5+ seconds to enter setup mode.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => { setCurrentStep(0); setConnectionMode('auto'); setError(''); }}
                className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
              >
                ← Back
              </button>
              <button
                onClick={() => setCurrentStep(2)}
                className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition"
              >
                Sensor is Powered On →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Connect to Device WiFi (WiFi manual mode) */}
        {currentStep === 2 && connectionMode === 'wifi' && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">📶</div>
              <h3 className="text-xl font-semibold mb-2">Step 2: Connect to Sensor WiFi</h3>
              <p className="text-gray-600">
                Connect your phone/computer to the H&T sensor's WiFi network.
              </p>
            </div>

            <div className="bg-gray-100 rounded-lg p-4">
              <h4 className="font-medium mb-2">Look for a WiFi network named:</h4>
              <div className="font-mono text-lg bg-white px-4 py-2 rounded border text-center">
                ShellyHTG3-XXXXXXXXXXXX
              </div>
              <div className="mt-3 p-3 bg-yellow-50 border border-yellow-300 rounded-lg">
                <h5 className="font-medium text-yellow-800 mb-1">📋 Password:</h5>
                <p className="text-sm text-yellow-700">
                  Check the <strong>label on the sensor</strong> for the password.
                  It's usually the Device ID or printed on the sticker.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-center space-x-2">
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                  <span className="text-gray-600">Looking for sensor...</span>
                </>
              ) : deviceConnected ? (
                <>
                  <div className="text-green-500 text-xl">✓</div>
                  <span className="text-green-600 font-medium">
                    Connected to {deviceInfo?.name || deviceInfo?.id || 'H&T Gen3'}
                  </span>
                </>
              ) : (
                <>
                  <div className="text-gray-400 text-xl">○</div>
                  <span className="text-gray-500">Not connected to sensor</span>
                </>
              )}
            </div>

            <button
              onClick={async () => {
                setLoading(true);
                setError('');
                const result = await checkHTDeviceAP();
                setLoading(false);
                if (result?.connected) {
                  setCurrentStep(3);
                } else {
                  setError('Cannot reach sensor. Make sure you\'re connected to the ShellyHTG3-XXXX WiFi network and wait a few seconds.');
                }
              }}
              disabled={loading}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
            >
              {loading ? 'Checking...' : deviceConnected ? 'Continue →' : 'Check Connection'}
            </button>

            <div className="flex space-x-3">
              <button
                onClick={() => { setCurrentStep(1); setDeviceConnected(false); setError(''); }}
                className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
              >
                ← Back
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Configure Device (WiFi manual mode) */}
        {currentStep === 3 && connectionMode === 'wifi' && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">⚙️</div>
              <h3 className="text-xl font-semibold mb-2">Step 3: Configure Sensor</h3>
              <p className="text-gray-600">
                Enter your WiFi credentials and sensor details.
              </p>
            </div>

            {deviceInfo && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center space-x-2">
                  <span className="text-green-500">✓</span>
                  <span className="font-medium text-green-800">
                    Sensor: {deviceInfo.model || 'H&T Gen3'} ({(deviceInfo.id || '').slice(-6)})
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {/* Network Type Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Network Type</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setNetworkType('private')}
                    className={`p-3 rounded-lg border-2 text-left transition ${
                      networkType === 'private' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-xl">🏠</span>
                      <div>
                        <div className="font-medium">Private WiFi</div>
                        <div className="text-xs text-gray-500">Home/Office</div>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNetworkType('public')}
                    className={`p-3 rounded-lg border-2 text-left transition ${
                      networkType === 'public' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-xl">🌐</span>
                      <div>
                        <div className="font-medium">Open/Public</div>
                        <div className="text-xs text-gray-500">No password</div>
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">WiFi Network Name *</label>
                <input
                  type="text"
                  value={wifiSsid}
                  onChange={(e) => setWifiSsid(e.target.value)}
                  placeholder="e.g., HouseYield-IoT"
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Use your GL.iNet IoT SSID (2.4 GHz). Flood sensors also get a local LAN webhook to close the water relay during internet outages.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  WiFi Password {networkType === 'private' ? '*' : '(optional)'}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={wifiPassword}
                    onChange={(e) => setWifiPassword(e.target.value)}
                    placeholder={networkType === 'public' ? 'Leave empty for open network' : 'Enter WiFi password'}
                    className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                  >
                    {showPassword ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Sensor Name (Optional)</label>
                <input
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g., Basement Temp Sensor"
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select location...</option>
                  <option value="Basement">Basement</option>
                  <option value="Bathroom">Bathroom</option>
                  <option value="Bedroom">Bedroom</option>
                  <option value="Kitchen">Kitchen</option>
                  <option value="Living Room">Living Room</option>
                  <option value="Attic">Attic</option>
                  <option value="Garage">Garage</option>
                  <option value="Crawl Space">Crawl Space</option>
                  <option value="HVAC">HVAC / Utility</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => { setCurrentStep(2); setError(''); }}
                className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
              >
                ← Back
              </button>
              <button
                onClick={configureHTFromAP}
                disabled={loading || !wifiSsid || (networkType === 'private' && !wifiPassword)}
                className={`flex-1 py-3 rounded-lg font-medium transition ${
                  !loading && wifiSsid && (networkType === 'public' || wifiPassword)
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                {loading ? 'Configuring...' : '🚀 Configure Sensor'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4 completion handled by shared completion step below */}
      </div>
        </>
      )}

      {/* ── Flood Sensor Setup Flow (original) ── */}
      {deviceType === 'flood' && (
        <>
      {/* Progress Steps */}
      <div className="px-6 py-4 bg-gray-50 border-b">
        <div className="flex items-center justify-between">
          {[0, 1, 2, 3, 4].map((step) => (
            <div key={step} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step < currentStep
                    ? 'bg-green-500 text-white'
                    : step === currentStep
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {step < currentStep ? '✓' : step === 0 ? '🔍' : step}
              </div>
              {step < 4 && (
                <div
                  className={`w-12 h-1 mx-1 ${
                    step < currentStep ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between mt-2 text-xs text-gray-500">
          <span>Discover</span>
          <span>Power On</span>
          <span>Connect</span>
          <span>Configure</span>
          <span>Done</span>
        </div>
      </div>

      {/* Step Content */}
      <div className="p-6">
        {/* Error/Success Messages */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}
        {success && !error && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            {success}
          </div>
        )}

        {/* Step 0: Auto-Discovery */}
        {currentStep === 0 && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">🔍</div>
              <h3 className="text-xl font-semibold mb-2">Find Your Shelly Device</h3>
              <p className="text-gray-600">
                Let's scan your network for Shelly Flood sensors.
              </p>
            </div>

            <div className="bg-blue-50 rounded-lg p-4">
              <h4 className="font-medium text-blue-800 mb-2">Before scanning:</h4>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>• Make sure your Shelly device is powered on (green LED)</li>
                <li>• Device should be connected to the same WiFi as your computer</li>
                <li>• <strong>⚡ Battery sensors:</strong> Press the button to wake the device before scanning — it sleeps after ~30 seconds</li>
                <li>• This will scan IPs .2 through .20 on your network</li>
              </ul>
            </div>

            {discoveredDevices.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-medium text-gray-700">Found {discoveredDevices.length} device(s):</h4>
                
                {/* Battery sensor warning */}
                {discoveredDevices.some((d: any) => d.isBatteryPowered || d.deviceType === 'flood') && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                    <strong className="text-amber-800">⚡ Battery Sensor Detected</strong>
                    <p className="text-amber-700 mt-1">
                      Press the button on the sensor to keep it awake, then click "Configure" within 30 seconds. 
                      The sensor goes back to sleep automatically.
                    </p>
                  </div>
                )}

                {/* Device name and location fields */}
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Device Name</label>
                    <input
                      type="text"
                      value={deviceName}
                      onChange={(e) => setDeviceName(e.target.value)}
                      placeholder="e.g., Bathroom Sensor"
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                    <select
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select location...</option>
                      <option value="Bathroom">Bathroom</option>
                      <option value="Kitchen">Kitchen</option>
                      <option value="Basement">Basement</option>
                      <option value="Laundry Room">Laundry Room</option>
                      <option value="Water Heater">Water Heater</option>
                      <option value="Under Sink">Under Sink</option>
                      <option value="HVAC">HVAC / AC Unit</option>
                      <option value="Garage">Garage</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </div>

                {discoveredDevices.map((device: any) => (
                  <div key={device.id} className={`border rounded-lg p-4 transition ${
                    device.previouslyRegistered 
                      ? 'border-amber-300 bg-amber-50 hover:border-amber-500' 
                      : 'hover:border-blue-500'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          {device.name || device.id}
                          {device.previouslyRegistered && (
                            <span className="text-xs px-2 py-0.5 bg-amber-200 text-amber-800 rounded-full font-normal">
                              🔄 Previously Registered
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-500">{device.model} • {device.ip}</div>
                        <div className="text-xs text-gray-400">MAC: {device.mac}</div>
                        {device.previouslyRegistered && device.previousIp && device.previousIp !== device.ip && (
                          <div className="text-xs text-amber-600 mt-1">
                            📍 Was at {device.previousIp} → Now at {device.ip}
                          </div>
                        )}
                        {device.isBatteryPowered && (
                          <div className="text-xs text-amber-600 mt-1">⚡ Battery-powered — press button to keep awake</div>
                        )}
                      </div>
                      <button
                        onClick={() => quickSetupDevice(device)}
                        disabled={loading}
                        className={`px-4 py-2 rounded-lg disabled:opacity-50 flex items-center space-x-2 ${
                          device.previouslyRegistered
                            ? 'bg-amber-600 text-white hover:bg-amber-700'
                            : 'bg-blue-600 text-white hover:bg-blue-700'
                        }`}
                      >
                        {loading ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                            <span>{device.previouslyRegistered ? 'Reconnecting...' : 'Configuring...'}</span>
                          </>
                        ) : (
                          <span>{device.previouslyRegistered ? '🔄 Reconnect & Configure' : 'Configure for Firebase'}</span>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
                
                <div className="text-sm text-gray-500 bg-blue-50 p-3 rounded-lg">
                  <strong>💡 What happens next:</strong>
                  <ul className="mt-1 space-y-1">
                    <li>• Device will be configured to send alerts to Firebase</li>
                    <li>• Works from any WiFi network with internet</li>
                    <li>• You'll receive alerts even when away from home</li>
                  </ul>
                </div>
              </div>
            )}

            <button
              onClick={discoverDevices}
              disabled={discovering}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              {discovering ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  <span>Scanning network...</span>
                </>
              ) : (
                <>
                  <span>🔍 Scan Network</span>
                </>
              )}
            </button>

            <div className="border-t pt-4">
              <button
                onClick={() => setCurrentStep(1)}
                className="w-full py-2 text-sm text-gray-600 hover:text-gray-800"
              >
                Or set up manually →
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Power On */}
        {currentStep === 1 && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">🔋</div>
              <h3 className="text-xl font-semibold mb-2">Step 1: Power On Device</h3>
              <p className="text-gray-600">
                Insert 4 AA batteries into the Shelly Flood Gen4 sensor.
              </p>
            </div>

            <div className="bg-blue-50 rounded-lg p-4">
              <h4 className="font-medium text-blue-800 mb-2">What to look for:</h4>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>• Remove the back cover by pressing and sliding</li>
                <li>• Insert 4x AA batteries (included in box)</li>
                <li>• The LED will start flashing blue</li>
                <li>• Device creates its own WiFi network</li>
              </ul>
            </div>

            <div className="bg-yellow-50 rounded-lg p-4">
              <h4 className="font-medium text-yellow-800 mb-2">💡 Tip:</h4>
              <p className="text-yellow-700 text-sm">
                If the LED doesn't flash, press and hold the button for 5 seconds to enter setup mode.
              </p>
            </div>

            <button
              onClick={() => setCurrentStep(2)}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition"
            >
              Device is Powered On →
            </button>
          </div>
        )}

        {/* Step 2: Connect to Device WiFi */}
        {currentStep === 2 && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">📶</div>
              <h3 className="text-xl font-semibold mb-2">Step 2: Connect to Device WiFi</h3>
              <p className="text-gray-600">
                Connect your computer/phone to the Shelly device's WiFi network.
              </p>
            </div>

            <div className="bg-gray-100 rounded-lg p-4">
              <h4 className="font-medium mb-2">Look for a WiFi network named:</h4>
              <div className="font-mono text-lg bg-white px-4 py-2 rounded border text-center">
                ShellyFloodG4-XXXXXXXXXXXX
              </div>
              <div className="mt-3 p-3 bg-yellow-50 border border-yellow-300 rounded-lg">
                <h5 className="font-medium text-yellow-800 mb-1">📋 Default Password:</h5>
                <p className="text-sm text-yellow-700 mb-2">
                  Look on the <strong>back of your sensor</strong> for the password. It's printed on the device label.
                </p>
                <p className="text-xs text-yellow-600">
                  Typically the password is the <strong>Device ID</strong> (the XXXXXXXXXXXX part of the network name) or printed separately on the sticker.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-center space-x-2">
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                  <span className="text-gray-600">Looking for device...</span>
                </>
              ) : deviceConnected ? (
                <>
                  <div className="text-green-500 text-xl">✓</div>
                  <span className="text-green-600 font-medium">
                    Connected to {deviceInfo?.name || deviceInfo?.id}
                  </span>
                </>
              ) : (
                <>
                  <div className="text-gray-400 text-xl">○</div>
                  <span className="text-gray-500">Not connected to device</span>
                </>
              )}
            </div>

            <button
              onClick={checkDeviceConnection}
              disabled={loading}
              className="w-full py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
            >
              {loading ? 'Checking...' : 'Check Connection'}
            </button>

            <div className="flex space-x-3">
              <button
                onClick={() => setCurrentStep(1)}
                className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
              >
                ← Back
              </button>
              <button
                onClick={() => setCurrentStep(3)}
                disabled={!deviceConnected}
                className={`flex-1 py-3 rounded-lg font-medium transition ${
                  deviceConnected
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Configure Device */}
        {currentStep === 3 && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="text-6xl mb-4">⚙️</div>
              <h3 className="text-xl font-semibold mb-2">Step 3: Configure Device</h3>
              <p className="text-gray-600">
                Enter your WiFi credentials and sensor details.
              </p>
            </div>

            {deviceInfo && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center space-x-2">
                  <span className="text-green-500">✓</span>
                  <span className="font-medium text-green-800">
                    Device: {deviceInfo.model} ({deviceInfo.id.slice(-6)})
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {/* Network Type Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Network Type
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setNetworkType('private')}
                    className={`p-3 rounded-lg border-2 text-left transition ${
                      networkType === 'private'
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-xl">🏠</span>
                      <div>
                        <div className="font-medium">Private WiFi</div>
                        <div className="text-xs text-gray-500">Home/Office network</div>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNetworkType('public')}
                    className={`p-3 rounded-lg border-2 text-left transition ${
                      networkType === 'public'
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-xl">🌐</span>
                      <div>
                        <div className="font-medium">Public/Open</div>
                        <div className="text-xs text-gray-500">Café, hotel, open network</div>
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              {networkType === 'public' && !publicUrl && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
                  ⚠️ Public network mode requires a tunnel URL. Make sure your server is accessible via ngrok or cloudflare tunnel.
                </div>
              )}

              {networkType === 'public' && publicUrl && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                  ✓ Device will connect via: <span className="font-mono text-xs">{publicUrl}</span>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  WiFi Network Name *
                </label>
                <input
                  type="text"
                  value={wifiSsid}
                  onChange={(e) => setWifiSsid(e.target.value)}
                  placeholder="Enter WiFi name (SSID)"
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Must be 2.4GHz network (not 5GHz)
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  WiFi Password {networkType === 'private' ? '*' : '(leave empty for open networks)'}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={wifiPassword}
                    onChange={(e) => setWifiPassword(e.target.value)}
                    placeholder={networkType === 'public' ? 'Leave empty if open network' : 'Enter WiFi password'}
                    className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                  >
                    {showPassword ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sensor Name (Optional)
                </label>
                <input
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g., Kitchen Sink Sensor"
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Location
                </label>
                <select
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Select location...</option>
                  <option value="Kitchen">Kitchen</option>
                  <option value="Bathroom">Bathroom</option>
                  <option value="Basement">Basement</option>
                  <option value="Laundry Room">Laundry Room</option>
                  <option value="Water Heater">Water Heater</option>
                  <option value="HVAC">HVAC Unit</option>
                  <option value="Garage">Garage</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h4 className="font-medium text-amber-900 mb-1">Before you tap Configure:</h4>
              <ul className="text-amber-900 text-sm space-y-1">
                <li>• Stay on <strong>ShellyFloodG4-…</strong> Wi‑Fi (red Cloud Run / Firestore errors are normal — no internet on that network)</li>
                <li>• Keep this page on <strong>http://localhost:5173</strong> with the local backend running</li>
                <li>• <strong>Press the sensor button</strong>, then tap Configure within ~20 seconds (it sleeps fast)</li>
                <li>• After success, switch your Mac to <strong>HouseYield-IoT</strong></li>
              </ul>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setCurrentStep(2)}
                className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
              >
                ← Back
              </button>
              <button
                onClick={configureDevice}
                disabled={loading || !wifiSsid || (networkType === 'private' && !wifiPassword)}
                className={`flex-1 py-3 rounded-lg font-medium transition ${
                  !loading && wifiSsid && (networkType === 'public' || wifiPassword)
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                {loading ? 'Configuring...' : 'Configure Device'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Complete (flood) */}
        {currentStep === 4 && (
          <div className="space-y-6 text-center">
            <div className="text-6xl mb-4">🎉</div>
            <h3 className="text-xl font-semibold mb-2">
              {success?.includes('Reconnect') || success?.includes('reconnect') || success?.includes('🔄')
                ? 'Sensor Reconnected!'
                : 'Setup Complete!'}
            </h3>
            <p className="text-gray-600">
              {success?.includes('Reconnect') || success?.includes('reconnect') || success?.includes('🔄')
                ? 'Your flood sensor has been reconnected on the new network with webhooks reconfigured.'
                : 'Your flood sensor is now configured to send alerts via Firebase Cloud.'}
            </p>

            {success && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm text-left">
                {success}
              </div>
            )}

            {deviceInfo && (
              <div className="bg-gray-50 border rounded-lg p-4 text-left">
                <h4 className="font-medium text-gray-700 mb-2">Device Details:</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Name:</span>
                    <span className="font-medium">{deviceInfo.name || 'Flood Sensor'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">ID:</span>
                    <span className="font-mono text-xs">{deviceInfo.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Model:</span>
                    <span>{deviceInfo.model}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-left">
              <h4 className="font-medium text-green-800 mb-2">✅ What's configured:</h4>
              <ul className="text-green-700 text-sm space-y-1">
                <li>✓ Flood alerts → Firebase Cloud Function</li>
                <li>✓ Works from <strong>any WiFi network</strong> with internet</li>
                <li>✓ Real-time monitoring on your dashboard</li>
                <li>✓ Alerts appear instantly when water is detected</li>
              </ul>
            </div>

            <div className="bg-blue-50 rounded-lg p-4 text-left">
              <h4 className="font-medium text-blue-800 mb-2">🧪 Test it now:</h4>
              <ol className="text-blue-700 text-sm space-y-1 list-decimal list-inside">
                <li>Place a few drops of water on the sensor probe</li>
                <li>Wait 2-3 seconds for detection</li>
                <li>Check the Alerts tab on your dashboard</li>
                <li>Dry the sensor to clear the alert</li>
              </ol>
            </div>

            <button
              onClick={() => {
                if (onComplete && deviceInfo) {
                  onComplete(deviceInfo);
                } else if (onCancel) {
                  onCancel();
                }
              }}
              className="w-full py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition"
            >
              Go to Dashboard →
            </button>
          </div>
        )}
      </div>
        </>
      )}

      {/* ── Shared Completion Step for Gateway & H&T ── */}
      {(deviceType === 'gateway' || deviceType === 'ht' || deviceType === 'relay') && currentStep === 4 && (
        <div className="p-6 space-y-6 text-center">
          <div className="text-6xl mb-4">🎉</div>
          <h3 className="text-xl font-semibold mb-2">Setup Complete!</h3>
          <p className="text-gray-600">
            {deviceType === 'gateway'
              ? 'Your BLU Gateway is configured and rebooting onto your home WiFi.'
              : deviceType === 'relay'
                ? 'Your Shelly 1 Gen4 relay controller is now registered for remote water shutoff control.'
              : `Your H&T sensor is registered and will report via ${connectionMode === 'ble' ? 'BLE gateway' : 'WiFi direct'}.`
            }
          </p>

          {deviceInfo && (
            <div className="bg-gray-50 border rounded-lg p-4 text-left">
              <h4 className="font-medium text-gray-700 mb-2">Device Details:</h4>
              <div className="text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">Name:</span>
                  <span className="font-medium">{deviceInfo.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Model:</span>
                  <span>{deviceInfo.model}</span>
                </div>
                {deviceInfo.mac && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">MAC:</span>
                    <span className="font-mono text-xs">{deviceInfo.mac}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">Connection:</span>
                  <span className="font-medium">
                    {deviceType === 'gateway' ? '📡 WiFi Bridge' : deviceType === 'relay' ? '🚰 WiFi Relay' : connectionMode === 'ble' ? '🔵 BLE via Gateway' : '📶 WiFi Direct'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Gateway-specific: reconnect to home WiFi & find gateway */}
          {deviceType === 'gateway' && (
            <>
              <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 text-left">
                <h4 className="font-medium text-yellow-800 mb-2">📶 Reconnect to your home WiFi</h4>
                <p className="text-yellow-700 text-sm">
                  Your phone/computer is still on the gateway's hotspot. 
                  <strong> Switch back to your home WiFi network now</strong>, then tap 
                  the button below to verify the gateway is online.
                </p>
              </div>

              <button
                onClick={async () => {
                  setLoading(true);
                  setError('');
                  setSuccess('');
                  try {
                    const response = await fetch(`${baseUrl}/api/shelly/gateway/find-on-network`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ gatewayId: deviceInfo?.id })
                    });
                    const data = await response.json();
                    if (data.success) {
                      setSuccess(`✅ Gateway found at ${data.ip} — connected locally!`);
                    } else {
                      setError(data.message || 'Gateway not found yet. It may still be booting — wait 15 seconds and try again.');
                    }
                  } catch (err: any) {
                    setError('Cannot reach your backend server. Make sure you are back on your home WiFi.');
                  } finally {
                    setLoading(false);
                  }
                }}
                disabled={loading}
                className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center justify-center space-x-2">
                    <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span>
                    <span>Scanning network...</span>
                  </span>
                ) : '🔍 Find Gateway on Network'}
              </button>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
              )}
              {success && (
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{success}</div>
              )}
            </>
          )}

          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-left">
            <h4 className="font-medium text-green-800 mb-2">✅ What's active:</h4>
            <ul className="text-green-700 text-sm space-y-1">
              {deviceType === 'gateway' ? (
                <>
                  <li>✓ BLE → WiFi bridging active</li>
                  <li>✓ Webhooks configured for sensor events</li>
                  <li>✓ Ready to onboard BLE sensors (H&T, Flood, etc.)</li>
                  <li>✓ Server auto-discovers gateway IP on restart</li>
                </>
              ) : deviceType === 'relay' ? (
                <>
                  <li>✓ Relay controller added to the dashboard</li>
                  <li>✓ Water shutoff commands available from the new Water Shutoff tab</li>
                  <li>✓ Last command and valve state tracked in the device record</li>
                  <li>✓ Local IP stored for future open/close requests</li>
                </>
              ) : (
                <>
                  <li>✓ Temperature & humidity monitoring active</li>
                  <li>✓ Readings polled every 2 minutes</li>
                  <li>✓ Trend data stored every 5 minutes</li>
                  <li>✓ Predictive alerts: mold risk, pipe burst, insulation gaps</li>
                </>
              )}
            </ul>
          </div>

          {deviceType === 'ht' && (
            <div className="bg-blue-50 rounded-lg p-4 text-left">
              <h4 className="font-medium text-blue-800 mb-2">📊 What it monitors:</h4>
              <ul className="text-blue-700 text-sm space-y-1">
                <li>🌡️ Temperature — freeze / pipe burst risk below 35°F</li>
                <li>💧 Humidity — mold growth risk above 60% sustained</li>
                <li>🏠 Insulation — cold spots vs. other rooms</li>
                <li>⚡ Energy — HVAC anomaly detection</li>
              </ul>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => {
                setDeviceType(null);
                setCurrentStep(0);
                setDeviceInfo(null);
                setSuccess('');
                setError('');
              }}
              className="flex-1 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition font-medium"
            >
              + Add Another Device
            </button>
            <button
              onClick={() => {
                if (onComplete && deviceInfo) {
                  onComplete(deviceInfo);
                } else if (onCancel) {
                  onCancel();
                }
              }}
              className="flex-1 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition"
            >
              Go to Dashboard →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
