/**
 * Shelly Flood Sensor Dashboard
 * 
 * Real-time dashboard showing all connected Shelly flood sensors
 * with live status updates via Firestore (Firebase) or WebSocket fallback.
 */

import { useState } from 'react';
import { useShellyFirestore, ShellyDevice, ShellyAlert } from '../hooks/useShellyFirestore';
import ShellySetupWizard from './ShellySetupWizard';

interface ShellySensorCardProps {
  device: ShellyDevice;
}

function ShellySensorCard({ device }: ShellySensorCardProps) {
  const isOnline = device.status === 'online';
  const batteryLevel = typeof device.batteryPercent === 'number' ? device.batteryPercent : null;
  const batteryLow = batteryLevel != null && batteryLevel < 20;

  return (
    <div 
      className={`bg-white rounded-xl shadow-md overflow-hidden border-2 transition-all ${
        device.isFlooded 
          ? 'border-red-500 animate-pulse' 
          : isOnline 
            ? 'border-green-200' 
            : 'border-gray-200'
      }`}
    >
      {/* Header */}
      <div className={`px-4 py-3 ${device.isFlooded ? 'bg-red-500' : 'bg-gradient-to-r from-blue-500 to-blue-600'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-2xl">{device.isFlooded ? '🚨' : '💧'}</span>
            <div>
              <h3 className="font-semibold text-white">{device.name}</h3>
              <p className="text-xs text-white/80">{device.location}</p>
            </div>
          </div>
          <div className={`px-2 py-1 rounded-full text-xs font-medium ${
            isOnline ? 'bg-green-400/20 text-green-100' : 'bg-gray-400/20 text-gray-200'
          }`}>
            {isOnline ? '● Online' : '○ Offline'}
          </div>
        </div>
      </div>

      {/* Flood Alert Banner */}
      {device.isFlooded && (
        <div className="bg-red-100 border-b border-red-200 px-4 py-2">
          <div className="flex items-center space-x-2 text-red-700">
            <span className="text-xl">⚠️</span>
            <span className="font-bold">WATER DETECTED!</span>
          </div>
        </div>
      )}

      {/* Status Grid */}
      <div className="p-4 grid grid-cols-2 gap-4">
        {/* Flood Status */}
        <div className="text-center p-3 bg-gray-50 rounded-lg">
          <div className={`text-3xl mb-1 ${device.isFlooded ? 'animate-bounce' : ''}`}>
            {device.isFlooded ? '💦' : '✅'}
          </div>
          <div className="text-xs text-gray-500">Status</div>
          <div className={`font-semibold ${device.isFlooded ? 'text-red-600' : 'text-green-600'}`}>
            {device.isFlooded ? 'FLOOD!' : 'Dry'}
          </div>
        </div>

        {/* Battery */}
        <div className="text-center p-3 bg-gray-50 rounded-lg">
          <div className="text-3xl mb-1">
            {batteryLevel == null ? '🔋' : batteryLow ? '🪫' : '🔋'}
          </div>
          <div className="text-xs text-gray-500">Battery</div>
          <div className={`font-semibold ${batteryLow ? 'text-orange-600' : 'text-gray-700'}`}>
            {batteryLevel == null ? '—' : `${batteryLevel}%`}
          </div>
        </div>

        {/* Temperature */}
        {device.temperatureF !== undefined && (
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <div className="text-3xl mb-1">🌡️</div>
            <div className="text-xs text-gray-500">Temperature</div>
            <div className="font-semibold text-gray-700">
              {device.temperatureF?.toFixed(1)}°F
            </div>
          </div>
        )}

        {/* Signal Strength */}
        {device.wifiRssi !== undefined && (
          <div className="text-center p-3 bg-gray-50 rounded-lg">
            <div className="text-3xl mb-1">
              {device.wifiRssi > -50 ? '📶' : device.wifiRssi > -70 ? '📶' : '📵'}
            </div>
            <div className="text-xs text-gray-500">Signal</div>
            <div className="font-semibold text-gray-700">
              {device.wifiRssi} dBm
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 bg-gray-50 border-t text-xs text-gray-500 flex justify-between items-center">
        <span>
          Updated: {device.lastSeen ? new Date(device.lastSeen).toLocaleTimeString() : 'Never'}
        </span>
        <span className="text-gray-400">
          🔥 Firebase
        </span>
      </div>
    </div>
  );
}

interface AlertCardProps {
  alert: ShellyAlert;
  onAcknowledge: (id: string) => void;
}

function AlertCard({ alert, onAcknowledge }: AlertCardProps) {
  const levelColors = {
    critical: 'bg-red-50 border-red-300 text-red-800',
    warning: 'bg-yellow-50 border-yellow-300 text-yellow-800',
    info: 'bg-blue-50 border-blue-300 text-blue-800'
  };

  const levelIcons = {
    critical: '🚨',
    warning: '⚠️',
    info: 'ℹ️'
  };

  if (alert.acknowledged) return null;

  return (
    <div className={`rounded-lg border-2 p-4 ${levelColors[alert.severity] || levelColors.info}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start space-x-3">
          <span className="text-2xl">{levelIcons[alert.severity] || levelIcons.info}</span>
          <div>
            <p className="font-semibold">{alert.message}</p>
            <p className="text-sm opacity-75">
              {new Date(alert.timestamp).toLocaleString()}
            </p>
          </div>
        </div>
        <button
          onClick={() => onAcknowledge(alert.id)}
          className="px-3 py-1 bg-white/50 hover:bg-white rounded text-sm font-medium"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function ShellyDashboard() {
  const [showSetup, setShowSetup] = useState(false);

  const { 
    devices, 
    alerts, 
    loading,
    error,
    acknowledgeAlert,
    refreshDevices
  } = useShellyFirestore();

  // Request notification permission
  const requestNotifications = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  };

  // Stats
  const onlineDevices = devices.filter(d => d.status === 'online').length;
  const floodingDevices = devices.filter(d => d.isFlooded).length;
  const lowBatteryDevices = devices.filter(d => typeof d.batteryPercent === 'number' && d.batteryPercent < 20).length;
  const unacknowledgedAlerts = alerts.filter(a => !a.acknowledged).length;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 flex items-center space-x-3">
            <span>💧</span>
            <span>Flood Sensors</span>
          </h1>
          <p className="text-gray-500 mt-1">
            Real-time water leak detection • Powered by Firebase Cloud
          </p>
        </div>
        
        <div className="flex items-center space-x-4">
          {/* Connection Status */}
          <div className={`flex items-center space-x-2 px-3 py-2 rounded-lg ${
            !loading && !error
              ? 'bg-green-100 text-green-700' 
              : loading 
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-red-100 text-red-700'
          }`}>
            <div className={`w-2 h-2 rounded-full ${
              !loading && !error ? 'bg-green-500' : loading ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
            }`} />
            <span className="text-sm font-medium">
              {loading ? 'Loading...' : error ? 'Error' : '🔥 Firebase Live'}
            </span>
          </div>

          {/* Refresh Button */}
          <button
            onClick={refreshDevices}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition"
            title="Refresh"
          >
            🔄
          </button>

          {/* Add Sensor Button */}
          <button
            onClick={() => setShowSetup(true)}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            <span>+</span>
            <span>Add Sensor</span>
          </button>
        </div>
      </div>

      {/* Alert for flood detection */}
      {floodingDevices > 0 && (
        <div className="bg-red-600 text-white rounded-xl p-4 animate-pulse">
          <div className="flex items-center space-x-3">
            <span className="text-4xl">🚨</span>
            <div>
              <h2 className="text-xl font-bold">WATER LEAK DETECTED!</h2>
              <p>{floodingDevices} sensor(s) detecting water</p>
            </div>
          </div>
        </div>
      )}

      {/* Alerts */}
      {unacknowledgedAlerts > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold text-gray-700">Active Alerts</h2>
          {alerts.filter(a => !a.acknowledged).map(alert => (
            <AlertCard 
              key={alert.id} 
              alert={alert} 
              onAcknowledge={acknowledgeAlert}
            />
          ))}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow p-4">
          <div className="text-3xl mb-2">📡</div>
          <div className="text-2xl font-bold">{devices.length}</div>
          <div className="text-gray-500 text-sm">Total Sensors</div>
        </div>
        
        <div className="bg-white rounded-xl shadow p-4">
          <div className="text-3xl mb-2">✅</div>
          <div className="text-2xl font-bold text-green-600">{onlineDevices}</div>
          <div className="text-gray-500 text-sm">Online</div>
        </div>
        
        <div className={`rounded-xl shadow p-4 ${floodingDevices > 0 ? 'bg-red-50' : 'bg-white'}`}>
          <div className="text-3xl mb-2">{floodingDevices > 0 ? '🚨' : '💧'}</div>
          <div className={`text-2xl font-bold ${floodingDevices > 0 ? 'text-red-600' : 'text-gray-800'}`}>
            {floodingDevices}
          </div>
          <div className="text-gray-500 text-sm">Flooding</div>
        </div>
        
        <div className={`rounded-xl shadow p-4 ${lowBatteryDevices > 0 ? 'bg-yellow-50' : 'bg-white'}`}>
          <div className="text-3xl mb-2">🔋</div>
          <div className={`text-2xl font-bold ${lowBatteryDevices > 0 ? 'text-yellow-600' : 'text-gray-800'}`}>
            {lowBatteryDevices}
          </div>
          <div className="text-gray-500 text-sm">Low Battery</div>
        </div>
      </div>

      {/* Enable Notifications Prompt */}
      {'Notification' in window && Notification.permission === 'default' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">🔔</span>
            <div>
              <p className="font-medium text-blue-800">Enable Notifications</p>
              <p className="text-sm text-blue-600">Get instant alerts when water is detected</p>
            </div>
          </div>
          <button
            onClick={requestNotifications}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Enable
          </button>
        </div>
      )}

      {/* No Devices State */}
      {devices.length === 0 && !loading && (
        <div className="text-center py-16 bg-gray-50 rounded-xl">
          <div className="text-6xl mb-4">💧</div>
          <h2 className="text-xl font-semibold text-gray-700 mb-2">
            No Sensors Connected
          </h2>
          <p className="text-gray-500 mb-6">
            Add your first Shelly Flood sensor to start monitoring for water leaks.
          </p>
          <button
            onClick={() => setShowSetup(true)}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            Add Your First Sensor
          </button>
        </div>
      )}

      {/* Sensor Grid */}
      {devices.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {devices.map(device => (
            <ShellySensorCard key={device.id} device={device} />
          ))}
        </div>
      )}

      {/* Setup Wizard Modal */}
      {showSetup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <ShellySetupWizard
              onComplete={() => {
                setShowSetup(false);
                // Device will appear via WebSocket
              }}
              onCancel={() => setShowSetup(false)}
            />
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          <p className="font-medium">Connection Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}
    </div>
  );
}
