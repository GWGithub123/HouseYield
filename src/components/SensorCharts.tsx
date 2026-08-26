/**
 * SensorCharts - Real-time temperature & humidity charting for IoT sensors
 * 
 * Displays interactive time-series charts for continuous sensor data
 * with per-device color coding, threshold lines, and time range selection.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  AreaChart,
  Brush,
} from 'recharts';
import type { SensorReading, ShellyDevice } from '../hooks/useShellyFirestore';
import { prepareChartData, DEFAULT_THRESHOLDS } from '../services/predictiveMaintenanceService';
import { propertyIdsMatch } from '../utils/sensorPropertyMatching';

// Device color palette for multi-line charts
const DEVICE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

interface SensorChartsProps {
  readings: SensorReading[];
  devices: ShellyDevice[];
  propertyFilter?: string; // Filter by property ID
}

type TimeRange = '1h' | '6h' | '12h' | '24h' | '7d' | '30d' | '3m' | '6m';

const TIME_RANGE_HOURS: Record<TimeRange, number> = {
  '1h': 1,
  '6h': 6,
  '12h': 12,
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '3m': 2160,
  '6m': 4320,
};

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  '1h': '1 Hour',
  '6h': '6 Hours',
  '12h': '12 Hours',
  '24h': '24 Hours',
  '7d': '7 Days',
  '30d': '1 Month',
  '3m': '3 Months',
  '6m': '6 Months',
};

/**
 * Custom tooltip for the charts
 */
const ChartTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl p-3 border border-slate-300" style={{
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(12px)',
    }}>
      <p className="text-slate-600 text-xs mb-2">{label}</p>
      {payload.map((entry: any, idx: number) => (
        <div key={idx} className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-slate-600">{entry.name}:</span>
          <span className="text-slate-900 font-medium">
            {entry.value?.toFixed(1)}{entry.unit || (entry.dataKey?.startsWith('hum_') ? '%RH' : '°F')}
          </span>
        </div>
      ))}
    </div>
  );
};

const SensorCharts: React.FC<SensorChartsProps> = ({ readings, devices, propertyFilter }) => {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [chartType, setChartType] = useState<'temperature' | 'humidity' | 'both'>('both');
  const [tempUnit, setTempUnit] = useState<'F' | 'C'>('F');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter devices by property if specified
  const filteredDevices = useMemo(() => {
    if (!propertyFilter || propertyFilter === 'all') return devices;
    return devices.filter((device) => propertyIdsMatch(device.propertyId, propertyFilter));
  }, [devices, propertyFilter]);

  const effectiveReadings = useMemo(() => {
    const hours = TIME_RANGE_HOURS[timeRange];
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const filteredDeviceIds = new Set(
      filteredDevices.flatMap((device) => [device.id, device.deviceId].filter(Boolean))
    );

    const scopedReadings = readings.filter((reading) => filteredDeviceIds.has(reading.deviceId));
    const readingsByDeviceId = new Set(scopedReadings.map((reading) => reading.deviceId));

    const syntheticLatestReadings: SensorReading[] = filteredDevices
      .filter((device) => {
        if (device.temperature == null && device.humidity == null) return false;
        if (!device.lastSeen || device.lastSeen < cutoff) return false;
        return !readingsByDeviceId.has(device.deviceId) && !readingsByDeviceId.has(device.id);
      })
      .map((device) => ({
        id: `snapshot-${device.id}`,
        deviceId: device.deviceId || device.id,
        temperature: device.temperature,
        humidity: device.humidity,
        batteryPercent: device.batteryPercent,
        timestamp: device.lastSeen || new Date(),
      }));

    return [...scopedReadings, ...syntheticLatestReadings];
  }, [filteredDevices, readings, timeRange]);

  // Format time labels based on selected range
  const formatTimeLabel = (timestamp: Date): string => {
    const hours = TIME_RANGE_HOURS[timeRange];
    if (hours <= 24) {
      return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (hours <= 168) {
      return timestamp.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } else if (hours <= 720) {
      return timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } else {
      return timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  // Prepare chart data
  const chartData = useMemo(() => {
    const hours = TIME_RANGE_HOURS[timeRange];
    return prepareChartData(effectiveReadings, filteredDevices, hours, formatTimeLabel);
  }, [effectiveReadings, filteredDevices, timeRange]);

  // Group data by timestamp for multi-device overlay
  const mergedData = useMemo(() => {
    const timeMap = new Map<string, any>();
    
    chartData.forEach(point => {
      const key = point.time;
      if (!timeMap.has(key)) {
        timeMap.set(key, { time: key, timestamp: point.timestamp });
      }
      const entry = timeMap.get(key)!;
      const safeName = point.deviceName.replace(/[^a-zA-Z0-9]/g, '_');
      if (point.temperature != null) {
        entry[`temp_${safeName}`] = tempUnit === 'F' ? point.temperature : point.temperatureC;
      }
      if (point.humidity != null) {
        entry[`hum_${safeName}`] = point.humidity;
      }
    });

    return Array.from(timeMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }, [chartData, tempUnit]);

  // Get unique device names that have data
  const deviceNames = useMemo(() => {
    const names = new Set<string>();
    chartData.forEach(p => names.add(p.deviceName));
    return Array.from(names);
  }, [chartData]);

  const hasTemperatureData = chartData.some(d => d.temperature != null);
  const hasHumidityData = chartData.some(d => d.humidity != null);
  const hasAnyData = hasTemperatureData || hasHumidityData;

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Time Range Dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-50 transition-all text-sm font-medium text-slate-700"
          >
            <span className="text-blue-600">🕐</span>
            <span>{TIME_RANGE_LABELS[timeRange]}</span>
            <svg
              className={`w-4 h-4 text-slate-500 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {dropdownOpen && (
            <div
              className="absolute top-full left-0 mt-2 w-48 rounded-xl border border-slate-200 shadow-2xl z-50 overflow-hidden"
              style={{
                background: 'rgba(15, 23, 42, 0.95)',
                backdropFilter: 'blur(20px)',
              }}
            >
              <div className="py-1">
                {(['1h', '6h', '12h', '24h', '7d', '30d', '3m', '6m'] as TimeRange[]).map((range) => (
                  <button
                    key={range}
                    onClick={() => {
                      setTimeRange(range);
                      setDropdownOpen(false);
                    }}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-all flex items-center justify-between ${
                      timeRange === range
                        ? 'bg-blue-500/20 text-blue-600'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                    }`}
                  >
                    <span>{TIME_RANGE_LABELS[range]}</span>
                    {timeRange === range && (
                      <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Chart Type Toggle */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-50 border border-slate-200">
            {hasTemperatureData && (
              <button
                onClick={() => setChartType(chartType === 'temperature' ? 'both' : 'temperature')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  chartType === 'temperature'
                    ? 'bg-orange-500/30 text-orange-600 border border-orange-400/40'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                🌡️ Temp
              </button>
            )}
            {hasHumidityData && (
              <button
                onClick={() => setChartType(chartType === 'humidity' ? 'both' : 'humidity')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  chartType === 'humidity'
                    ? 'bg-cyan-500/30 text-cyan-600 border border-cyan-400/40'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                💧 Humidity
              </button>
            )}
            {hasTemperatureData && hasHumidityData && (
              <button
                onClick={() => setChartType('both')}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  chartType === 'both'
                    ? 'bg-purple-500/30 text-purple-600 border border-purple-400/40'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Both
              </button>
            )}
          </div>

          {/* Temp Unit Toggle */}
          {(chartType === 'temperature' || chartType === 'both') && hasTemperatureData && (
            <button
              onClick={() => setTempUnit(u => u === 'F' ? 'C' : 'F')}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-50 border border-slate-200 text-slate-600 hover:text-slate-700 transition"
            >
              °{tempUnit === 'F' ? 'F → °C' : 'C → °F'}
            </button>
          )}
        </div>
      </div>

      {!hasAnyData ? (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-3">📊</div>
          <p className="text-lg font-medium mb-1">No Sensor Data Yet</p>
          <p className="text-sm">Temperature and humidity readings will appear here once your sensors start reporting data.</p>
        </div>
      ) : (
        <>
          {/* Temperature Chart */}
          {(chartType === 'temperature' || chartType === 'both') && hasTemperatureData && (
            <div className="rounded-2xl p-5 border border-slate-200" style={{
              background: 'linear-gradient(180deg, rgba(15,23,42,0.08) 0%, rgba(15,23,42,0.03) 100%)',
              backdropFilter: 'blur(16px)',
            }}>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-slate-900 font-semibold flex items-center gap-2">
                  <span className="text-xl">🌡️</span> Temperature Over Time
                </h4>
                <span className="text-slate-500 text-sm">{mergedData.length} data points</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={mergedData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <defs>
                    {deviceNames.map((name, i) => {
                      const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                      return (
                        <linearGradient key={safeName} id={`tempGrad_${safeName}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={DEVICE_COLORS[i % DEVICE_COLORS.length]} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={DEVICE_COLORS[i % DEVICE_COLORS.length]} stopOpacity={0.02} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                  <XAxis 
                    dataKey="time" 
                    stroke="rgba(15,23,42,0.3)" 
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                    tickLine={{ stroke: 'rgba(15,23,42,0.1)' }}
                  />
                  <YAxis 
                    stroke="rgba(15,23,42,0.3)"
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                    tickLine={{ stroke: 'rgba(15,23,42,0.1)' }}
                    label={{ 
                      value: `°${tempUnit}`, 
                      position: 'insideLeft', 
                      style: { fill: 'rgba(15,23,42,0.4)' } 
                    }}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend 
                    wrapperStyle={{ color: 'rgba(15,23,42,0.7)', fontSize: 12 }}
                    iconType="circle"
                    iconSize={8}
                  />

                  {/* Freeze threshold reference line */}
                  <ReferenceLine 
                    y={tempUnit === 'F' ? DEFAULT_THRESHOLDS.freezeCriticalTempF : 0} 
                    stroke="#3b82f6" 
                    strokeDasharray="5 5" 
                    strokeOpacity={0.5}
                    label={{ value: 'Freezing', fill: '#3b82f6', fontSize: 10, position: 'right' }}
                  />
                  {/* Pipe burst threshold */}
                  <ReferenceLine 
                    y={tempUnit === 'F' ? DEFAULT_THRESHOLDS.pipeBurstTempF : -6.7} 
                    stroke="#ef4444" 
                    strokeDasharray="5 5" 
                    strokeOpacity={0.4}
                    label={{ value: 'Pipe Risk', fill: '#ef4444', fontSize: 10, position: 'right' }}
                  />

                  {deviceNames.map((name, i) => {
                    const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                    return (
                      <Area
                        key={`temp_${safeName}`}
                        type="monotone"
                        dataKey={`temp_${safeName}`}
                        name={`${name}`}
                        stroke={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                        fill={`url(#tempGrad_${safeName})`}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 2 }}
                        connectNulls
                      />
                    );
                  })}

                  {mergedData.length > 20 && (
                    <Brush 
                      dataKey="time" 
                      height={24} 
                      stroke="rgba(15,23,42,0.2)"
                      fill="rgba(15,23,42,0.03)"
                      tickFormatter={() => ''}
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Humidity Chart */}
          {(chartType === 'humidity' || chartType === 'both') && hasHumidityData && (
            <div className="rounded-2xl p-5 border border-slate-200" style={{
              background: 'linear-gradient(180deg, rgba(15,23,42,0.08) 0%, rgba(15,23,42,0.03) 100%)',
              backdropFilter: 'blur(16px)',
            }}>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-slate-900 font-semibold flex items-center gap-2">
                  <span className="text-xl">💧</span> Humidity Over Time
                </h4>
                <span className="text-slate-500 text-sm">{mergedData.length} data points</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={mergedData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <defs>
                    {deviceNames.map((name, i) => {
                      const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                      return (
                        <linearGradient key={safeName} id={`humGrad_${safeName}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={DEVICE_COLORS[i % DEVICE_COLORS.length]} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={DEVICE_COLORS[i % DEVICE_COLORS.length]} stopOpacity={0.02} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                  <XAxis 
                    dataKey="time" 
                    stroke="rgba(15,23,42,0.3)" 
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                    tickLine={{ stroke: 'rgba(15,23,42,0.1)' }}
                  />
                  <YAxis 
                    stroke="rgba(15,23,42,0.3)"
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                    tickLine={{ stroke: 'rgba(15,23,42,0.1)' }}
                    domain={[0, 100]}
                    label={{ 
                      value: '%RH', 
                      position: 'insideLeft', 
                      style: { fill: 'rgba(15,23,42,0.4)' } 
                    }}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend 
                    wrapperStyle={{ color: 'rgba(15,23,42,0.7)', fontSize: 12 }}
                    iconType="circle"
                    iconSize={8}
                  />

                  {/* Mold risk threshold */}
                  <ReferenceLine 
                    y={DEFAULT_THRESHOLDS.moldHumidityPercent} 
                    stroke="#22c55e" 
                    strokeDasharray="5 5" 
                    strokeOpacity={0.5}
                    label={{ value: 'Mold Risk', fill: '#22c55e', fontSize: 10, position: 'right' }}
                  />
                  {/* High humidity threshold */}
                  <ReferenceLine 
                    y={DEFAULT_THRESHOLDS.highHumidityPercent} 
                    stroke="#ef4444" 
                    strokeDasharray="5 5" 
                    strokeOpacity={0.4}
                    label={{ value: 'Damage Risk', fill: '#ef4444', fontSize: 10, position: 'right' }}
                  />

                  {deviceNames.map((name, i) => {
                    const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                    return (
                      <Area
                        key={`hum_${safeName}`}
                        type="monotone"
                        dataKey={`hum_${safeName}`}
                        name={`${name}`}
                        stroke={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                        fill={`url(#humGrad_${safeName})`}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 2 }}
                        connectNulls
                      />
                    );
                  })}

                  {mergedData.length > 20 && (
                    <Brush 
                      dataKey="time" 
                      height={24} 
                      stroke="rgba(15,23,42,0.2)"
                      fill="rgba(15,23,42,0.03)"
                      tickFormatter={() => ''}
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Live Readings Grid */}
          <div className="rounded-2xl p-5 border border-slate-200" style={{
            background: 'linear-gradient(180deg, rgba(15,23,42,0.08) 0%, rgba(15,23,42,0.03) 100%)',
            backdropFilter: 'blur(16px)',
          }}>
            <h4 className="text-slate-900 font-semibold mb-4 flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-400" />
              </span>
              Live Readings
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredDevices.filter(d => d.temperature != null || d.humidity != null).map((device, idx) => (
                <div 
                  key={device.id}
                  className="rounded-xl p-4 border border-slate-200 bg-slate-50 hover:bg-slate-50 transition"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-slate-900 font-medium text-sm truncate">{device.name}</span>
                    <span className={`w-2 h-2 rounded-full ${device.status === 'online' ? 'bg-green-400' : 'bg-red-400'}`} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {device.temperature != null && (
                      <div>
                        <div className="text-slate-500 text-xs mb-0.5">Temperature</div>
                        <div className="text-lg font-bold" style={{ color: DEVICE_COLORS[idx % DEVICE_COLORS.length] }}>
                          {tempUnit === 'F' 
                            ? `${((device.temperature * 9/5) + 32).toFixed(1)}°F`
                            : `${device.temperature.toFixed(1)}°C`
                          }
                        </div>
                      </div>
                    )}
                    {device.humidity != null && (
                      <div>
                        <div className="text-slate-500 text-xs mb-0.5">Humidity</div>
                        <div className="text-lg font-bold" style={{ color: DEVICE_COLORS[idx % DEVICE_COLORS.length] }}>
                          {device.humidity.toFixed(0)}%
                        </div>
                      </div>
                    )}
                  </div>
                  {device.lastSeen && (
                    <div className="text-slate-400 text-xs mt-2">
                      Updated {device.lastSeen.toLocaleTimeString()}
                    </div>
                  )}
                </div>
              ))}
              {filteredDevices.filter(d => d.temperature != null || d.humidity != null).length === 0 && (
                <div className="col-span-full text-center py-6 text-slate-500">
                  <p>No temperature or humidity sensors online.</p>
                  <p className="text-sm mt-1">Connect temperature/humidity sensors to see live data.</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default SensorCharts;
