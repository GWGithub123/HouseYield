import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const IoTSensorPreview: React.FC = () => {
  const navigate = useNavigate();
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [sensors, setSensors] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSensorData();
    const interval = setInterval(loadSensorData, 60000); // Update every minute
    return () => clearInterval(interval);
  }, []);

  const loadSensorData = async () => {
    try {
      const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
      const [statusRes, sensorsRes, alertsRes] = await Promise.all([
        fetch(`${baseUrl}/api/iot/system-status`),
        fetch(`${baseUrl}/api/iot/sensors`),
        fetch(`${baseUrl}/api/iot/alerts`)
      ]);

      if (statusRes.ok) setSystemStatus(await statusRes.json());
      if (sensorsRes.ok) setSensors(await sensorsRes.json());
      if (alertsRes.ok) setAlerts(await alertsRes.json());
    } catch (error) {
      console.error('Failed to load sensor data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getSensorIcon = (type: string) => {
    const icons: Record<string, string> = {
      water_leak: '💧',
      flood: '💧',
      temperature: '🌡️',
      humidity: '💨',
      temp_humidity: '🌡️',
      freeze: '❄️',
      motion: '👁️',
      door_window: '🚪',
      smoke: '🔥',
      carbon_monoxide: '⚠️',
      gateway: '📡',
      ble_gateway: '📡'
    };
    return icons[type] || '📡';
  };

  const getConnectionBadge = (sensor: any) => {
    const ct = sensor.connectionType || sensor.connection_type;
    if (ct === 'ble') return '🔵';
    if (ct === 'wifi') return '📶';
    if (ct === 'cloud') return '☁️';
    return '';
  };

  if (loading) {
    return (
      <div className="p-6 text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto"></div>
        <p className="text-xs text-gray-500 mt-2">Loading sensors...</p>
      </div>
    );
  }

  const activeAlerts = alerts.filter(a => !a.acknowledged);
  const criticalAlerts = activeAlerts.filter(a => a.level === 'critical');

  return (
    <div className="p-4">
      {/* Status Banner */}
      {systemStatus?.allSystemsOnline ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="text-2xl">✅</span>
              <div>
                <div className="text-sm font-semibold text-green-800">All Systems Online</div>
                <div className="text-xs text-green-600">{systemStatus.onlineSensors} sensors active</div>
              </div>
            </div>
            <button
              onClick={() => navigate('/insurance-discount')}
              className="px-4 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition"
            >
              Get Insurance Discount
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <div className="text-sm font-semibold text-yellow-800">
                {criticalAlerts.length > 0 ? 'Critical Alerts' : 'System Warnings'}
              </div>
              <div className="text-xs text-yellow-600">
                {criticalAlerts.length} critical • {activeAlerts.length} total alerts
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-gray-50 rounded-lg p-3 text-center">
          <div className="text-xs text-gray-500 mb-1">Total</div>
          <div className="text-xl font-bold text-gray-800">{systemStatus?.totalSensors || 0}</div>
        </div>
        <div className="bg-green-50 rounded-lg p-3 text-center">
          <div className="text-xs text-green-600 mb-1">Online</div>
          <div className="text-xl font-bold text-green-700">{systemStatus?.onlineSensors || 0}</div>
        </div>
        <div className="bg-yellow-50 rounded-lg p-3 text-center">
          <div className="text-xs text-yellow-600 mb-1">Alerts</div>
          <div className="text-xl font-bold text-yellow-700">{activeAlerts.length}</div>
        </div>
        <div className="bg-red-50 rounded-lg p-3 text-center">
          <div className="text-xs text-red-600 mb-1">Critical</div>
          <div className="text-xl font-bold text-red-700">{criticalAlerts.length}</div>
        </div>
      </div>

      {/* Recent Alerts */}
      {activeAlerts.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-medium text-gray-700 mb-2">Recent Alerts</div>
          <div className="space-y-2">
            {activeAlerts.slice(0, 2).map((alert) => (
              <div
                key={alert.id}
                className={`p-3 rounded-lg border text-xs ${
                  alert.level === 'critical'
                    ? 'bg-red-50 border-red-200 text-red-800'
                    : 'bg-yellow-50 border-yellow-200 text-yellow-800'
                }`}
              >
                <div className="font-medium">{alert.sensorName} - {alert.sensorLocation}</div>
                <div className="mt-1 opacity-90">{alert.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sensor Grid */}
      <div className="mb-4">
        <div className="text-xs font-medium text-gray-700 mb-2">Active Sensors</div>
        <div className="grid grid-cols-4 gap-2">
          {sensors.slice(0, 8).map((sensor) => (
            <div
              key={sensor.id}
              className="bg-gray-50 rounded-lg p-2 border border-gray-200 hover:border-blue-300 transition"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-lg">{getSensorIcon(sensor.type)}</span>
                <div className="flex items-center space-x-1">
                  {getConnectionBadge(sensor) && (
                    <span className="text-[9px]">{getConnectionBadge(sensor)}</span>
                  )}
                  <span
                    className={`w-2 h-2 rounded-full ${
                      sensor.status === 'online' ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  />
                </div>
              </div>
              <div className="text-[10px] text-gray-600 font-medium truncate">{sensor.location}</div>
              {/* Inline temp/humidity for H&T sensors */}
              {(sensor.type === 'temp_humidity' || sensor.type === 'temperature') && sensor.lastReading && (
                <div className="text-[9px] text-blue-600 mt-0.5 truncate">
                  {sensor.lastReading.temperature != null && `${sensor.lastReading.temperature}°F`}
                  {sensor.lastReading.humidity != null && ` · ${sensor.lastReading.humidity}%`}
                </div>
              )}
              {sensor.batteryLevel !== undefined && (
                <div className={`text-[9px] mt-1 ${sensor.batteryLevel < 20 ? 'text-red-600' : 'text-gray-500'}`}>
                  🔋 {sensor.batteryLevel}%
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2 border-t">
        <button
          onClick={() => navigate('/sensors')}
          className="flex-1 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition"
        >
          View Full Dashboard
        </button>
        {systemStatus?.allSystemsOnline && (
          <button
            onClick={() => navigate('/insurance-discount')}
            className="flex-1 px-3 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition"
          >
            Get Insurance Discount
          </button>
        )}
      </div>
    </div>
  );
};

export default IoTSensorPreview;
