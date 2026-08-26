/**
 * ThermalLeakAnalysis — "Insulation Efficiency Tax" Dashboard Component
 * 
 * Shows per-room insulation grades, excess energy cost estimates,
 * thermal gap chart, and ROI recommendations — all derived from
 * real sensor data + outside temperature.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';
import {
  analyzeThermalLeaks,
  fetchOutsideTemperature,
  getInsulationRecommendation,
  gradeColor,
  DEFAULT_THERMAL_CONFIG,
  type ThermalLeakAnalysisResult,
  type ThermalLeakConfig,
  type RoomThermalProfile,
  type HvacType,
} from '../services/thermalLeakService';

// Device color palette (matches SensorCharts)
const DEVICE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

interface ThermalLeakAnalysisProps {
  devices: ShellyDevice[];
  readings: SensorReading[];
  properties: { id: string; address: string; propertyData?: { summary?: { latitude?: number; longitude?: number; living_sqft?: number } } }[];
  selectedProperty: string;
}

// ─── Sub-Components ──────────────────────────────────────────────

const GradeBadge: React.FC<{ grade: RoomThermalProfile['grade']; size?: 'sm' | 'lg' }> = ({ grade, size = 'sm' }) => {
  const color = gradeColor(grade);
  const sizeClass = size === 'lg' ? 'w-12 h-12 text-xl' : 'w-8 h-8 text-sm';
  return (
    <div
      className={`${sizeClass} rounded-xl font-bold flex items-center justify-center`}
      style={{
        background: `${color}22`,
        border: `2px solid ${color}66`,
        color,
      }}
    >
      {grade}
    </div>
  );
};

const TrendIndicator: React.FC<{ trend: RoomThermalProfile['trend'] }> = ({ trend }) => {
  switch (trend) {
    case 'worsening':
      return <span className="text-red-600 text-xs flex items-center gap-1">📈 Worsening</span>;
    case 'improving':
      return <span className="text-green-600 text-xs flex items-center gap-1">📉 Improving</span>;
    case 'stable':
      return <span className="text-slate-500 text-xs flex items-center gap-1">➡️ Stable</span>;
    default:
      return <span className="text-slate-400 text-xs">—</span>;
  }
};

const ConfidenceMeter: React.FC<{ confidence: number }> = ({ confidence }) => {
  const color = confidence >= 70 ? '#22c55e' : confidence >= 45 ? '#eab308' : '#ef4444';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-slate-50 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${confidence}%`, background: color }}
        />
      </div>
      <span className="text-xs" style={{ color }}>{confidence}%</span>
    </div>
  );
};

/** Custom tooltip for thermal gap chart */
const ThermalGapTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl p-3 border border-slate-300" style={{
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(12px)',
    }}>
      <p className="text-slate-600 text-xs mb-2">{label}</p>
      {payload.map((entry: any, idx: number) => (
        <div key={idx} className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full" style={{ background: entry.color || entry.stroke }} />
          <span className="text-slate-600">{entry.name}:</span>
          <span className="text-slate-900 font-medium">{entry.value?.toFixed(1)}°F</span>
        </div>
      ))}
    </div>
  );
};

// ─── Settings Panel ──────────────────────────────────────────────

const SettingsPanel: React.FC<{
  config: ThermalLeakConfig;
  onChange: (config: ThermalLeakConfig) => void;
  isOpen: boolean;
  onToggle: () => void;
}> = ({ config, onChange, isOpen, onToggle }) => {
  if (!isOpen) return null;

  return (
    <div className="rounded-xl p-4 border border-slate-200 bg-slate-50 space-y-4 mt-4">
      <div className="flex items-center justify-between">
        <h5 className="text-slate-700 text-sm font-semibold">⚙️ Analysis Settings</h5>
        <button onClick={onToggle} className="text-slate-500 hover:text-slate-700 text-xs">Close</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* HVAC Type */}
        <div>
          <label className="block text-slate-500 text-xs mb-1">HVAC System Type</label>
          <select
            value={config.hvacType}
            onChange={(e) => onChange({ ...config, hvacType: e.target.value as HvacType })}
            className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
          >
            <option value="heat_pump">Heat Pump (COP ~2.5)</option>
            <option value="electric_resistance">Electric Resistance</option>
            <option value="gas_furnace">Gas Furnace (95% AFUE)</option>
            <option value="oil_furnace">Oil Furnace (85% AFUE)</option>
          </select>
        </div>

        {/* Electric Rate */}
        <div>
          <label className="block text-slate-500 text-xs mb-1">Electricity Rate ($/kWh)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={config.electricRate}
            onChange={(e) => onChange({ ...config, electricRate: parseFloat(e.target.value) || 0.16 })}
            className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
          />
        </div>

        {/* Gas Rate */}
        {(config.hvacType === 'gas_furnace' || config.hvacType === 'oil_furnace') && (
          <div>
            <label className="block text-slate-500 text-xs mb-1">Gas Rate ($/therm)</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={config.gasRate}
              onChange={(e) => onChange({ ...config, gasRate: parseFloat(e.target.value) || 1.20 })}
              className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
            />
          </div>
        )}

        {/* Default Room Size */}
        <div>
          <label className="block text-slate-500 text-xs mb-1">Avg Room Size (sq ft)</label>
          <input
            type="number"
            step="10"
            min="50"
            value={config.defaultRoomSqFt}
            onChange={(e) => onChange({ ...config, defaultRoomSqFt: parseInt(e.target.value) || 150 })}
            className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
          />
        </div>

        {/* Leak Threshold */}
        <div>
          <label className="block text-slate-500 text-xs mb-1">Leak Threshold (°F diff)</label>
          <input
            type="number"
            step="1"
            min="2"
            max="20"
            value={config.leakThresholdF}
            onChange={(e) => onChange({ ...config, leakThresholdF: parseInt(e.target.value) || 5 })}
            className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
          />
        </div>
      </div>

      <p className="text-slate-400 text-xs">
        💡 Default rates are US averages. Adjust to your local utility rates for more accurate cost estimates.
      </p>
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────

const ThermalLeakAnalysis: React.FC<ThermalLeakAnalysisProps> = ({
  devices,
  readings,
  properties,
  selectedProperty,
}) => {
  const [config, setConfig] = useState<ThermalLeakConfig>(DEFAULT_THERMAL_CONFIG);
  const [outsideTemp, setOutsideTemp] = useState<{ tempF: number; humidity: number; description: string; icon: string } | null>(null);
  const [outsideLoading, setOutsideLoading] = useState(false);
  const [outsideError, setOutsideError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<number>(24);
  const [manualOutsideTemp, setManualOutsideTemp] = useState<string>('');

  // Get property coordinates for OpenWeather
  const propertyCoords = useMemo(() => {
    const prop = selectedProperty !== 'all'
      ? properties.find(p => p.id === selectedProperty)
      : properties[0];
    const lat = prop?.propertyData?.summary?.latitude;
    const lng = prop?.propertyData?.summary?.longitude;
    if (lat && lng) return { lat, lng };
    return null;
  }, [properties, selectedProperty]);

  // Fetch outside temperature
  useEffect(() => {
    const apiKey = (import.meta as any).env?.VITE_OPENWEATHER_API_KEY;

    if (!propertyCoords || !apiKey) {
      // Try geocoding the address as fallback
      if (!apiKey) {
        setOutsideError('OpenWeather API key not configured');
      }
      return;
    }

    let cancelled = false;
    setOutsideLoading(true);
    setOutsideError(null);

    fetchOutsideTemperature(propertyCoords.lat, propertyCoords.lng, apiKey)
      .then(result => {
        if (cancelled) return;
        if (result) {
          setOutsideTemp(result);
        } else {
          setOutsideError('Failed to fetch outside temperature');
        }
      })
      .finally(() => {
        if (!cancelled) setOutsideLoading(false);
      });

    // Refresh every 15 minutes
    const interval = setInterval(() => {
      fetchOutsideTemperature(propertyCoords.lat, propertyCoords.lng, apiKey)
        .then(result => {
          if (!cancelled && result) setOutsideTemp(result);
        });
    }, 15 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [propertyCoords]);

  // Effective outside temperature (API or manual fallback)
  const effectiveOutsideTempF = outsideTemp?.tempF ?? (manualOutsideTemp ? parseFloat(manualOutsideTemp) : null);

  // Run the analysis (uses ALL available data for grades/costs; timeRange controls chart only)
  const analysis = useMemo(() => {
    if (effectiveOutsideTempF == null) return null;
    return analyzeThermalLeaks(devices, readings, effectiveOutsideTempF, config, timeRange);
  }, [devices, readings, effectiveOutsideTempF, config, timeRange]);

  // Selected room detail
  const selectedRoomProfile = analysis?.rooms.find(r => r.deviceId === selectedRoom) || null;
  const selectedRoomRec = selectedRoomProfile ? getInsulationRecommendation(selectedRoomProfile.grade, config.defaultRoomSqFt) : null;

  // Get device names for chart
  const deviceNamesList = useMemo(() => {
    return analysis?.rooms.map(r => r.deviceName) || [];
  }, [analysis]);

  // ─── No data / loading states ──────────────────────────────────

  const tempDevices = devices.filter(d => d.temperature != null);
  if (tempDevices.length < 2) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-2xl">🏠</span>
          <h4 className="text-lg font-semibold text-slate-900">Room Insulation Analysis</h4>
        </div>
        <div className="text-center py-10 text-slate-500">
          <div className="text-4xl mb-3">🌡️</div>
          <p className="text-lg font-medium mb-1">Need 2+ Temperature Sensors</p>
          <p className="text-sm max-w-md mx-auto">
            This analysis compares temperature readings across rooms to detect insulation issues.
            Connect at least 2 temperature sensors in different rooms to enable it.
          </p>
          <p className="text-xs text-slate-400 mt-3">
            Currently detecting {tempDevices.length} sensor{tempDevices.length !== 1 ? 's' : ''} with temperature data
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🏠</span>
          <div>
            <h4 className="text-lg font-semibold text-slate-900">Room Insulation Analysis</h4>
            <p className="text-slate-500 text-sm">Energy cost impact from thermal leaks</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Chart Time Range (grades & costs use ALL available data) */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-50 border border-slate-200" title="Chart display window — grades and costs use all available data">
            {[
              { label: '6h', value: 6 },
              { label: '24h', value: 24 },
              { label: '7d', value: 168 },
            ].map(({ label, value }) => (
              <button
                key={value}
                onClick={() => setTimeRange(value)}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  timeRange === value
                    ? 'bg-blue-500/30 text-blue-600 border border-blue-400/40'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Settings Gear */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2 rounded-lg transition-all ${
              showSettings ? 'bg-blue-500/20 text-blue-600' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
            title="Analysis Settings"
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* Settings Panel */}
      <SettingsPanel
        config={config}
        onChange={setConfig}
        isOpen={showSettings}
        onToggle={() => setShowSettings(false)}
      />

      {/* Outside Temperature Status */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl p-3 border border-slate-200 bg-slate-50">
        <div className="flex items-center gap-2">
          <span className="text-lg">🌤️</span>
          <span className="text-slate-600 text-sm">Outside:</span>
          {outsideLoading ? (
            <span className="text-slate-500 text-sm animate-pulse">Loading...</span>
          ) : outsideTemp ? (
            <span className="text-slate-900 font-semibold">
              {outsideTemp.tempF.toFixed(0)}°F
              <span className="text-slate-500 font-normal ml-1">({outsideTemp.description})</span>
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder="Enter °F"
                value={manualOutsideTemp}
                onChange={(e) => setManualOutsideTemp(e.target.value)}
                className="w-24 rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-1.5 focus:outline-none focus:border-blue-400/50"
              />
              <span className="text-slate-400 text-xs">{outsideError || 'Enter outside temp manually'}</span>
            </div>
          )}
        </div>

        {analysis && (
          <>
            <div className="h-4 w-px bg-slate-50" />
            <div className="flex items-center gap-2">
              <span className="text-slate-600 text-sm">Mode:</span>
              <span className={`text-sm font-medium px-2 py-0.5 rounded-md ${
                analysis.mode === 'heating' ? 'bg-orange-500/20 text-orange-600' :
                analysis.mode === 'cooling' ? 'bg-blue-500/20 text-blue-600' :
                'bg-slate-50 text-slate-500'
              }`}>
                {analysis.mode === 'heating' ? '🔥 Heating' : analysis.mode === 'cooling' ? '❄️ Cooling' : '⏸️ Idle'}
              </span>
            </div>
            <div className="h-4 w-px bg-slate-50" />
            <div className="flex items-center gap-2">
              <span className="text-slate-600 text-sm">House Avg:</span>
              <span className="text-slate-900 font-semibold">{analysis.houseMedianTempF.toFixed(0)}°F</span>
            </div>
            <div className="h-4 w-px bg-slate-50" />
            <div className="flex items-center gap-1">
              <span className="text-slate-600 text-sm">Confidence:</span>
              <div className="w-24">
                <ConfidenceMeter confidence={analysis.confidence} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Analysis Not Available */}
      {effectiveOutsideTempF == null && (
        <div className="text-center py-8 text-slate-500">
          <p className="text-sm">Enter the outside temperature above to begin analysis.</p>
        </div>
      )}

      {analysis && analysis.mode === 'idle' && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-amber-700/80 text-sm">
          <span className="text-xl">🌤️</span>
          <span>
            Mild weather ({analysis.outsideTempF.toFixed(0)}°F outside) — insulation differences are less pronounced.
            Costs shown are annual averages based on typical seasonal conditions, not current weather.
          </span>
        </div>
      )}

      {analysis && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Monthly Extra Cost */}
            <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-red-500/10 to-red-600/5">
              <div className="text-slate-500 text-xs mb-1">Monthly Efficiency Tax</div>
              <div className="text-2xl font-bold text-red-600">
                ${analysis.totalExcessMonthly.toFixed(2)}
              </div>
              <div className="text-slate-400 text-xs mt-1">Extra cost from underperforming rooms</div>
            </div>

            {/* Annual Projection */}
            <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-orange-500/10 to-orange-600/5">
              <div className="text-slate-500 text-xs mb-1">Annual Projection</div>
              <div className="text-2xl font-bold text-orange-600">
                ${analysis.totalExcessAnnual.toFixed(0)}
              </div>
              <div className="text-slate-400 text-xs mt-1">Seasonally averaged estimate</div>
            </div>

            {/* Potential Savings */}
            <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-green-500/10 to-green-600/5">
              <div className="text-slate-500 text-xs mb-1">Potential Savings</div>
              <div className="text-2xl font-bold text-green-600">
                ${analysis.potentialAnnualSavings.toFixed(0)}/yr
              </div>
              <div className="text-slate-400 text-xs mt-1">If all rooms matched best</div>
            </div>

            {/* Sensors Analyzed */}
            <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-blue-500/10 to-blue-600/5">
              <div className="text-slate-500 text-xs mb-1">Sensors Analyzed</div>
              <div className="text-2xl font-bold text-blue-600">
                {analysis.sensorCount}
              </div>
              <div className="text-slate-400 text-xs mt-1">
                {analysis.rooms.filter(r => r.isLeak).length} leak{analysis.rooms.filter(r => r.isLeak).length !== 1 ? 's' : ''} detected
              </div>
            </div>
          </div>

          {/* Per-Room Insulation Grades */}
          <div>
            <h5 className="text-slate-900 font-semibold mb-3 flex items-center gap-2">
              <span>📊</span> Room Insulation Grades
            </h5>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {analysis.rooms
                .sort((a, b) => a.rRatio - b.rRatio) // Worst first
                .map((room, idx) => (
                  <div
                    key={room.deviceId}
                    onClick={() => setSelectedRoom(selectedRoom === room.deviceId ? null : room.deviceId)}
                    className={`rounded-xl p-4 border transition-all cursor-pointer hover:scale-[1.01] ${
                      selectedRoom === room.deviceId
                        ? 'border-blue-400/50 bg-blue-500/10'
                        : room.isLeak
                          ? 'border-orange-400/30 bg-orange-500/5'
                          : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-3 mb-3">
                      <GradeBadge grade={room.grade} size="lg" />
                      <div className="flex-1 min-w-[140px]">
                        <div className="text-slate-900 font-medium text-sm truncate">{room.deviceName}</div>
                        <div className="text-slate-500 text-xs whitespace-nowrap">
                          Avg: {room.avgTempF.toFixed(1)}°F
                          <span className={`ml-2 ${
                            room.deviationF > 0 ? 'text-red-600' : room.deviationF < -3 ? 'text-blue-600' : 'text-slate-500'
                          }`}>
                            ({room.deviationF > 0 ? '+' : ''}{room.deviationF.toFixed(1)}°F from avg)
                          </span>
                        </div>
                      </div>
                      {room.isLeak && (
                        <span className="text-xs px-2 py-1 rounded-md bg-orange-500/20 text-orange-600 font-medium whitespace-nowrap">
                          ⚠️ Leak
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="text-slate-500 text-xs">R-Ratio</div>
                        <div className="text-slate-900 font-semibold text-sm">{room.rRatio.toFixed(2)}</div>
                      </div>
                      <div>
                        <div className="text-slate-500 text-xs">Extra/mo</div>
                        <div className={`font-semibold text-sm ${room.excessCostPerMonth > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {room.excessCostPerMonth > 0 ? `+$${room.excessCostPerMonth.toFixed(2)}` : '$0'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500 text-xs">Trend</div>
                        <TrendIndicator trend={room.trend} />
                      </div>
                    </div>

                    <div className="mt-2">
                      <ConfidenceMeter confidence={room.confidence} />
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Expanded Room Detail */}
          {selectedRoomProfile && selectedRoomRec && (
            <div className="rounded-xl p-5 border border-blue-400/30 bg-blue-500/5 space-y-4">
              <div className="flex items-center justify-between">
                <h5 className="text-slate-900 font-semibold flex items-center gap-2">
                  <GradeBadge grade={selectedRoomProfile.grade} />
                  <span>{selectedRoomProfile.deviceName} — Detailed Analysis</span>
                </h5>
                <button
                  onClick={() => setSelectedRoom(null)}
                  className="text-slate-500 hover:text-slate-700 text-sm"
                >✕</button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Metrics */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-sm">Average Temperature</span>
                    <span className="text-slate-900 font-medium">{selectedRoomProfile.avgTempF.toFixed(1)}°F</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-sm">Deviation from House Avg</span>
                    <span className={`font-medium ${selectedRoomProfile.deviationF < -3 ? 'text-blue-600' : selectedRoomProfile.deviationF > 3 ? 'text-red-600' : 'text-slate-900'}`}>
                      {selectedRoomProfile.deviationF > 0 ? '+' : ''}{selectedRoomProfile.deviationF.toFixed(1)}°F
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-sm">Thermal Resistance Ratio</span>
                    <span className="text-slate-900 font-medium">{selectedRoomProfile.rRatio.toFixed(3)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-sm">Excess Heat Loss</span>
                    <span className="text-orange-600 font-medium">{selectedRoomProfile.excessBtuPerHour} BTU/hr</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-sm">Monthly Extra Cost</span>
                    <span className="text-red-600 font-medium">${selectedRoomProfile.excessCostPerMonth.toFixed(2)}/mo</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-sm">Annual Extra Cost</span>
                    <span className="text-red-600 font-medium">${selectedRoomProfile.excessCostPerYear.toFixed(0)}/yr</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-sm">Data Points</span>
                    <span className="text-slate-600">{selectedRoomProfile.dataPoints} readings</span>
                  </div>
                </div>

                {/* Recommendation */}
                <div className="rounded-xl p-4 border border-slate-200 bg-slate-50">
                  <h6 className="text-slate-900 font-semibold text-sm mb-2">💡 Recommendation</h6>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-600 text-sm">Action</span>
                      <span className="text-slate-900 font-medium text-sm text-right">{selectedRoomRec.action}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600 text-sm">Estimated Cost</span>
                      <span className="text-green-600 font-medium text-sm">{selectedRoomRec.estimatedCost}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600 text-sm">Payback Period</span>
                      <span className="text-blue-600 font-medium text-sm">{selectedRoomRec.paybackPeriod}</span>
                    </div>
                    <p className="text-slate-500 text-xs mt-2 leading-relaxed">
                      {selectedRoomRec.description}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Thermal Gap Chart */}
          {analysis.timeSeriesGap.length > 3 && (
            <div className="rounded-xl p-5 border border-slate-200 bg-slate-50">
              <div className="flex items-center justify-between mb-4">
                <h5 className="text-slate-900 font-semibold flex items-center gap-2">
                  <span>📈</span> Thermal Gap Over Time
                </h5>
                <span className="text-slate-500 text-xs">{analysis.timeSeriesGap.length} data points</span>
              </div>

              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={analysis.timeSeriesGap} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                  <XAxis
                    dataKey="time"
                    stroke="rgba(15,23,42,0.3)"
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                  />
                  <YAxis
                    stroke="rgba(15,23,42,0.3)"
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                    label={{ value: '°F', position: 'insideLeft', style: { fill: 'rgba(15,23,42,0.4)' } }}
                  />
                  <Tooltip content={<ThermalGapTooltip />} />
                  <Legend
                    wrapperStyle={{ color: 'rgba(15,23,42,0.7)', fontSize: 12 }}
                    iconType="circle"
                    iconSize={8}
                  />

                  {/* Outside temperature line */}
                  <Line
                    type="monotone"
                    dataKey="outsideTempF"
                    name="Outside"
                    stroke="#94a3b8"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    dot={false}
                  />

                  {/* House median line */}
                  <Line
                    type="monotone"
                    dataKey="medianIndoorF"
                    name="House Median"
                    stroke="#a78bfa"
                    strokeWidth={2}
                    strokeDasharray="4 2"
                    dot={false}
                  />

                  {/* Per-device temperature lines */}
                  {deviceNamesList.map((name, i) => {
                    const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                    const room = analysis.rooms.find(r => r.deviceName === name);
                    const isLeakRoom = room?.isLeak;
                    return (
                      <Line
                        key={safeName}
                        type="monotone"
                        dataKey={`deviceTemps.${safeName}`}
                        name={name}
                        stroke={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                        strokeWidth={isLeakRoom ? 3 : 1.5}
                        dot={false}
                        activeDot={{ r: 4 }}
                        connectNulls
                      />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Methodology Note */}
          <div className="rounded-xl p-4 border border-slate-200 bg-slate-50">
            <details>
              <summary className="text-slate-500 text-xs cursor-pointer hover:text-slate-700 select-none">
                ℹ️ How this analysis works — {analysis.totalReadingsUsed?.toLocaleString() ?? '?'} readings over {analysis.hoursAnalyzed >= 24 ? `${Math.round(analysis.hoursAnalyzed / 24)} days` : `${analysis.hoursAnalyzed}h`}
              </summary>
              <div className="text-slate-400 text-xs mt-3 space-y-2 leading-relaxed">
                <p>
                  <strong className="text-slate-500">All Available Data:</strong> Grades and cost estimates use ALL sensor data in the database
                  (up to 12 months), not just the chart window. The chart time selector (6h/24h/7d) only controls the graph display.
                  More data = more accurate results.
                </p>
                <p>
                  <strong className="text-slate-500">ΔT-Weighted Averaging:</strong> Readings taken when the indoor-outdoor temperature gap
                  is large are weighted more heavily, because insulation differences are most measurable during extreme weather.
                  Mild-weather readings still contribute but carry less weight.
                </p>
                <p>
                  <strong className="text-slate-500">Thermal Resistance Ratio:</strong> We compare each room's weighted average temperature
                  to the house median. The ratio uses a reference design ΔT (20°F) for stability, so results don't swing with current weather.
                </p>
                <p>
                  <strong className="text-slate-500">Seasonal Projection:</strong> Annual costs use a standardized seasonal average
                  (typical ~20°F average indoor-outdoor differential during active HVAC months × 55% of the year).
                  The cost model only charges rooms drifting in the costly HVAC direction: warmer-than-house rooms while cooling,
                  or colder-than-house rooms while heating.
                </p>
                <p>
                  <strong className="text-slate-500">Limitations:</strong> Accuracy improves with more sensors and longer data windows.
                  Historical outside temperature per reading is not yet available — the current outside temp is used as a weighting proxy.
                  A professional energy audit can provide exact figures.
                </p>
              </div>
            </details>
          </div>
        </>
      )}
    </div>
  );
};

export default ThermalLeakAnalysis;
