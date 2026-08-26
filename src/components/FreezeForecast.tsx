/**
 * FreezeForecast — Freeze & Pipe Burst Risk Dashboard Component
 * 
 * Shows per-room freeze countdown timers, projected temperature curves,
 * cumulative pipe burst risk gauges, recovery analysis, and weather
 * forecast overlay — all derived from sensor data + OpenWeather API.
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
  ReferenceArea,
} from 'recharts';
import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';
import {
  analyzeFreezeForecast,
  fetchWeatherForecast,
  FREEZE_THRESHOLDS,
  DEFAULT_FREEZE_CONFIG,
  BURST_RISK_COLORS,
  PIPE_MATERIAL_LABELS,
  type FreezeForecastResult,
  type FreezeForecastConfig,
  type RoomFreezeProfile,
  type PipeMaterial,
  type ForecastPoint,
} from '../services/freezeForecastService';

// Device color palette (matches SensorCharts)
const DEVICE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

interface FreezeForecastProps {
  devices: ShellyDevice[];
  readings: SensorReading[];
  properties: { id: string; address: string; propertyData?: { summary?: { latitude?: number; longitude?: number } } }[];
  selectedProperty: string;
}

// ─── Sub-Components ──────────────────────────────────────────────

const RiskBadge: React.FC<{ risk: RoomFreezeProfile['burstRisk']; size?: 'sm' | 'lg' }> = ({ risk, size = 'sm' }) => {
  const color = BURST_RISK_COLORS[risk];
  const icons: Record<RoomFreezeProfile['burstRisk'], string> = {
    none: '✅',
    low: '🟡',
    moderate: '🟠',
    high: '🔴',
    critical: '🧊',
  };
  const sizeClass = size === 'lg' ? 'px-3 py-1.5 text-sm' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`${sizeClass} rounded-lg font-semibold inline-flex items-center gap-1`}
      style={{ background: `${color}22`, border: `1px solid ${color}55`, color }}
    >
      {icons[risk]} {risk === 'none' ? 'Safe' : risk.charAt(0).toUpperCase() + risk.slice(1)}
    </span>
  );
};

const CountdownTimer: React.FC<{ hours: number | null; label: string; threshold: string; color: string }> = ({
  hours, label, threshold, color,
}) => {
  if (hours == null) {
    return (
      <div className="flex items-center gap-2 py-1">
        <div className="w-2 h-2 rounded-full bg-slate-100" />
        <span className="text-xs text-slate-500">{label}</span>
        <span className="text-xs text-slate-400 ml-auto">—</span>
      </div>
    );
  }

  const urgent = hours < 6;
  const display = hours === 0
    ? 'NOW'
    : hours < 1
      ? `${Math.round(hours * 60)}m`
      : hours < 24
        ? `${hours.toFixed(1)}h`
        : `${(hours / 24).toFixed(1)}d`;

  return (
    <div className="flex items-center gap-2 py-1">
      <div className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: urgent ? `0 0 8px ${color}` : undefined }} />
      <span className="text-xs text-slate-600">{label}</span>
      <span className="text-xs font-semibold ml-auto" style={{ color }}>
        {display}
      </span>
    </div>
  );
};

const ConfidenceMeter: React.FC<{ confidence: number }> = ({ confidence }) => {
  const color = confidence >= 70 ? '#22c55e' : confidence >= 45 ? '#eab308' : '#ef4444';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-slate-50 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${confidence}%`, background: color }} />
      </div>
      <span className="text-xs" style={{ color }}>{confidence}%</span>
    </div>
  );
};

/** Circular pipe burst risk gauge */
const BurstRiskGauge: React.FC<{ fdh: number; risk: RoomFreezeProfile['burstRisk']; pipeMaterial: PipeMaterial; size?: number }> = ({
  fdh, risk, pipeMaterial, size = 64,
}) => {
  // Max scale depends on pipe material (critical threshold × 1.5)
  const maxScale = pipeMaterial === 'pex' ? 650 : pipeMaterial === 'cpvc' ? 324 : 216;
  const pct = Math.min(100, (fdh / maxScale) * 100);
  const color = BURST_RISK_COLORS[risk];
  const r = (size - 8) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pct / 100);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(15,23,42,0.08)" strokeWidth={5} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={5} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={dashOffset}
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xs font-bold" style={{ color }}>{fdh.toFixed(0)}</span>
        <span className="text-[9px] text-slate-400">°F·hr</span>
      </div>
    </div>
  );
};

const TrendArrow: React.FC<{ trendPerHourF: number }> = ({ trendPerHourF }) => {
  if (Math.abs(trendPerHourF) < 0.1) {
    return <span className="text-xs text-slate-500">→ Stable</span>;
  }
  if (trendPerHourF < 0) {
    const color = trendPerHourF < -1 ? '#ef4444' : trendPerHourF < -0.3 ? '#f97316' : '#eab308';
    return <span className="text-xs" style={{ color }}>↓ {trendPerHourF.toFixed(2)}°F/hr</span>;
  }
  return <span className="text-xs text-green-600">↑ +{trendPerHourF.toFixed(2)}°F/hr</span>;
};

/** Custom tooltip for the projected temperature chart */
const FreezeChartTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl p-3 border border-slate-300" style={{
      background: 'linear-gradient(180deg, rgba(15,23,42,0.95), rgba(10,15,30,0.95))',
      backdropFilter: 'blur(12px)',
    }}>
      <p className="text-slate-600 text-xs mb-2">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs py-0.5">
          <div className="w-2 h-2 rounded-full" style={{ background: entry.color || entry.stroke }} />
          <span className="text-slate-700">{entry.name}:</span>
          <span className="font-semibold text-slate-900">{typeof entry.value === 'number' ? `${entry.value.toFixed(1)}°F` : '—'}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────

const FreezeForecast: React.FC<FreezeForecastProps> = ({
  devices,
  readings,
  properties,
  selectedProperty,
}) => {
  const [config, setConfig] = useState<FreezeForecastConfig>({ ...DEFAULT_FREEZE_CONFIG });
  const [outsideTempF, setOutsideTempF] = useState<number | null>(null);
  const [outsideForecast, setOutsideForecast] = useState<ForecastPoint[]>([]);
  const [weatherDescription, setWeatherDescription] = useState('');
  const [weatherError, setWeatherError] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [expandedRoom, setExpandedRoom] = useState<string | null>(null);
  const [chartTab, setChartTab] = useState<'projected' | 'burst' | 'recovery'>('projected');
  const [manualTemp, setManualTemp] = useState('');

  // Fetch weather data
  useEffect(() => {
    const prop = selectedProperty !== 'all'
      ? properties.find(p => p.id === selectedProperty)
      : properties[0];
    const lat = prop?.propertyData?.summary?.latitude;
    const lng = prop?.propertyData?.summary?.longitude;
    const apiKey = (import.meta as any).env?.VITE_OPENWEATHER_API_KEY;

    if (!lat || !lng || !apiKey) {
      setWeatherError(true);
      return;
    }

    let cancelled = false;
    fetchWeatherForecast(lat, lng, apiKey).then(result => {
      if (cancelled) return;
      if (result) {
        setOutsideTempF(result.current.tempF);
        setOutsideForecast(result.forecast);
        setWeatherDescription(result.current.description);
        setWeatherError(false);
      } else {
        setWeatherError(true);
      }
    });

    return () => { cancelled = true; };
  }, [selectedProperty, properties]);

  // Handle manual temp override
  const effectiveOutside = manualTemp ? parseFloat(manualTemp) : outsideTempF;

  // Run analysis
  const result = useMemo<FreezeForecastResult | null>(() => {
    return analyzeFreezeForecast(
      devices,
      readings,
      effectiveOutside,
      outsideForecast,
      config,
      24
    );
  }, [devices, readings, effectiveOutside, outsideForecast, config]);

  if (!result || result.rooms.length === 0) {
    return (
      <div>
        <h4 className="text-lg font-semibold text-slate-900 mb-2">🧊 Freeze & Pipe Burst Forecast</h4>
        <p className="text-slate-500 text-sm">
          Insufficient temperature data. Ensure sensors are reporting temperature readings.
        </p>
      </div>
    );
  }

  // Sort rooms: most at-risk first
  const sortedRooms = [...result.rooms].sort((a, b) => {
    // Rooms already freezing first
    if (a.isFreezing !== b.isFreezing) return a.isFreezing ? -1 : 1;
    // Then by shortest time to freeze
    const aTime = a.hoursToFreezing ?? Infinity;
    const bTime = b.hoursToFreezing ?? Infinity;
    return aTime - bTime;
  });

  // Overall risk color
  const riskColors: Record<string, string> = {
    none: '#22c55e',
    low: '#84cc16',
    moderate: '#eab308',
    high: '#f97316',
    critical: '#ef4444',
  };
  const overallColor = riskColors[result.overallRisk];

  // ─── Build chart data ────────────────────────────────────────────

  const chartDeviceNames = result.rooms.map(r => r.deviceName.replace(/[^a-zA-Z0-9]/g, '_'));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h4 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            🧊 Freeze & Pipe Burst Forecast
            <span
              className="ml-2 px-2 py-0.5 rounded-lg text-xs font-bold"
              style={{ background: `${overallColor}22`, border: `1px solid ${overallColor}55`, color: overallColor }}
            >
              {result.overallRisk === 'none' ? 'All Clear' : result.overallRisk.toUpperCase()}
            </span>
          </h4>
          <p className="text-slate-500 text-sm mt-1">
            Analyzing {result.sensorCount} sensor{result.sensorCount > 1 ? 's' : ''} ·{' '}
            {result.hoursAnalyzed}h of data ·{' '}
            {outsideTempF != null
              ? `Outside: ${outsideTempF.toFixed(1)}°F${weatherDescription ? ` (${weatherDescription})` : ''}`
              : 'Outside temp unavailable'}
          </p>
        </div>

        {/* Alert banner if urgent */}
        {result.shortestTimeToFreeze != null && result.shortestTimeToFreeze < 12 && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm"
            style={{
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171',
            }}>
            <span className="text-lg">⚠️</span>
            {result.shortestTimeToFreeze === 0
              ? 'A room is at or below freezing RIGHT NOW'
              : `Freeze projected in ${result.shortestTimeToFreeze.toFixed(1)} hours`}
          </div>
        )}

        {/* Weather forecast summary */}
        {result.lowestForecastTempF != null && (
          <div className="text-xs text-slate-500">
            Forecast low: <span className="text-slate-700 font-semibold">{result.lowestForecastTempF}°F</span>{' '}
            at {result.lowestForecastTime}
          </div>
        )}
      </div>

      {/* Outside temp / manual input */}
      {(outsideTempF == null || weatherError) && (
        <div className="flex items-center gap-3 p-3 rounded-xl" style={{
          background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)',
        }}>
          <span className="text-yellow-600 text-sm">⚠️</span>
          <span className="text-yellow-600/80 text-xs flex-1">
            {weatherError
              ? 'Could not fetch weather data. Enter outside temperature manually for better accuracy.'
              : 'No weather API key configured. Set VITE_OPENWEATHER_API_KEY for automatic outside temp + forecast.'}
          </span>
          <input
            type="number"
            value={manualTemp}
            onChange={e => setManualTemp(e.target.value)}
            placeholder="°F"
            className="w-20 bg-slate-50 border border-slate-300 rounded-lg px-2 py-1 text-sm text-slate-900 text-center"
          />
        </div>
      )}

      {/* Per-room freeze cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {sortedRooms.map((room, idx) => {
          const isExpanded = expandedRoom === room.deviceId;
          const deviceColor = DEVICE_COLORS[idx % DEVICE_COLORS.length];

          return (
            <div
              key={room.deviceId}
              className="rounded-xl p-4 cursor-pointer transition-all duration-300 hover:scale-[1.01]"
              style={{
                background: room.isFreezing
                  ? 'linear-gradient(180deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05))'
                  : 'linear-gradient(180deg, rgba(15,23,42,0.08), rgba(15,23,42,0.03))',
                border: `1px solid ${room.isFreezing ? 'rgba(239,68,68,0.3)' : 'rgba(15,23,42,0.12)'}`,
              }}
              onClick={() => setExpandedRoom(isExpanded ? null : room.deviceId)}
            >
              {/* Card header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ background: deviceColor }} />
                  <span className="text-sm font-medium text-slate-900 truncate max-w-[140px]">{room.deviceName}</span>
                </div>
                <RiskBadge risk={room.burstRisk} />
              </div>

              {/* Current temp + trend */}
              <div className="flex items-end justify-between mb-3">
                <div>
                  <div className="text-3xl font-bold text-slate-900">
                    {room.currentTempF.toFixed(1)}
                    <span className="text-lg text-slate-500 ml-1">°F</span>
                  </div>
                  <TrendArrow trendPerHourF={room.trendPerHourF} />
                </div>
                <BurstRiskGauge
                  fdh={room.freezingDegreeHours}
                  risk={room.burstRisk}
                  pipeMaterial={config.pipeMaterial}
                  size={56}
                />
              </div>

              {/* Countdown timers */}
              <div className="space-y-0.5 mb-2">
                <CountdownTimer hours={room.hoursToWarning} label="Warning (38°F)" threshold="38" color="#eab308" />
                <CountdownTimer hours={room.hoursToFreezing} label="Freeze (32°F)" threshold="32" color="#3b82f6" />
                <CountdownTimer hours={room.hoursToPipeBurst} label="Pipe Burst (20°F)" threshold="20" color="#ef4444" />
                <CountdownTimer hours={room.hoursToExtremeCold} label="Extreme Cold (10°F)" threshold="10" color="#a855f7" />
              </div>

              {/* Confidence */}
              <ConfidenceMeter confidence={room.confidence} />

              {/* Expanded detail */}
              {isExpanded && (
                <div className="mt-4 pt-4 border-t border-slate-200 space-y-3 text-xs" onClick={e => e.stopPropagation()}>
                  {/* Data summary */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-slate-500">Trend R²</span>
                      <div className="text-slate-700 font-medium">{room.trendR2.toFixed(2)}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Cooling k</span>
                      <div className="text-slate-700 font-medium">{room.coolingConstantK.toFixed(4)}/hr</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Data Points</span>
                      <div className="text-slate-700 font-medium">{room.dataPoints}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Freeze °F·hr</span>
                      <div className="text-slate-700 font-medium">{room.freezingDegreeHours.toFixed(1)}</div>
                    </div>
                    {room.pipeAgeMultiplier > 1 && (
                      <div>
                        <span className="text-slate-500">Age Multiplier</span>
                        <div className="text-orange-600 font-medium">{room.pipeAgeMultiplier.toFixed(2)}×</div>
                      </div>
                    )}
                  </div>

                  {/* Recovery info */}
                  {room.recoveryRateF != null && (
                    <div className="p-2 rounded-lg" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
                      <div className="text-green-600 font-medium mb-0.5">🔄 Recovery Detected</div>
                      <div className="text-slate-600">
                        +{room.recoveryRateF}°F/hr · Recovered in {room.recoveryMinutes} min
                      </div>
                    </div>
                  )}

                  {/* Recommendation */}
                  <div className="p-2 rounded-lg" style={{
                    background: room.isFreezing ? 'rgba(239,68,68,0.08)' : 'rgba(59,130,246,0.08)',
                    border: `1px solid ${room.isFreezing ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)'}`,
                  }}>
                    <div className="text-slate-700 leading-relaxed">{room.recommendation}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Charts section */}
      <div>
        {/* Tab bar */}
        <div className="flex gap-2 mb-4">
          {[
            { id: 'projected' as const, label: '📈 Temperature Projection', icon: '' },
            { id: 'burst' as const, label: '🧊 Pipe Burst Risk', icon: '' },
            { id: 'recovery' as const, label: '🔄 Recovery Analysis', icon: '' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setChartTab(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                chartTab === tab.id
                  ? 'bg-blue-500/20 text-blue-600 border border-blue-500/30'
                  : 'bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Projected Temperature Chart */}
        {chartTab === 'projected' && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={result.chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <defs>
                  <linearGradient id="freezeZoneGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="burstZoneGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: 'rgba(15,23,42,0.4)', fontSize: 10 }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: 'rgba(15,23,42,0.4)', fontSize: 10 }}
                  tickLine={false}
                  domain={['auto', 'auto']}
                  label={{ value: '°F', angle: -90, position: 'insideLeft', fill: 'rgba(15,23,42,0.3)', fontSize: 11 }}
                />
                <Tooltip content={<FreezeChartTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: 'rgba(15,23,42,0.6)' }}
                />

                {/* Danger zone reference lines */}
                <ReferenceLine y={FREEZE_THRESHOLDS.warningF} stroke="#eab308" strokeDasharray="6 3" strokeOpacity={0.5}
                  label={{ value: '38°F Warning', fill: '#eab308', fontSize: 9, position: 'right' }} />
                <ReferenceLine y={FREEZE_THRESHOLDS.freezingF} stroke="#3b82f6" strokeDasharray="6 3" strokeOpacity={0.7}
                  label={{ value: '32°F Freeze', fill: '#60a5fa', fontSize: 9, position: 'right' }} />
                <ReferenceLine y={FREEZE_THRESHOLDS.pipeBurstF} stroke="#ef4444" strokeDasharray="6 3" strokeOpacity={0.7}
                  label={{ value: '20°F Burst', fill: '#f87171', fontSize: 9, position: 'right' }} />
                <ReferenceLine y={FREEZE_THRESHOLDS.extremeColdF} stroke="#a855f7" strokeDasharray="6 3" strokeOpacity={0.7}
                  label={{ value: '10°F Extreme', fill: '#c084fc', fontSize: 9, position: 'right' }} />

                {/* Outside temperature */}
                <Line
                  dataKey="outsideF"
                  name="Outside (Actual)"
                  stroke="rgba(15,23,42,0.25)"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="4 4"
                  connectNulls={false}
                />
                <Line
                  dataKey="outsideForecastF"
                  name="Outside (Forecast)"
                  stroke="rgba(15,23,42,0.15)"
                  strokeWidth={1.5}
                  dot={false}
                  strokeDasharray="2 4"
                  connectNulls={false}
                />

                {/* Per-device actual + projected lines */}
                {chartDeviceNames.map((name, idx) => (
                  <React.Fragment key={name}>
                    <Line
                      dataKey={`deviceActual.${name}`}
                      name={`${result.rooms[idx]?.deviceName || name} (Actual)`}
                      stroke={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                    />
                    <Line
                      dataKey={`deviceProjected.${name}`}
                      name={`${result.rooms[idx]?.deviceName || name} (Projected)`}
                      stroke={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      dot={false}
                      connectNulls={false}
                    />
                  </React.Fragment>
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Pipe Burst Risk Chart — Bar chart of freezing-degree-hours per room */}
        {chartTab === 'burst' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              Freezing-degree-hours (°F·hr) measure cumulative cold exposure. Higher values = greater pipe burst risk.
              Thresholds vary by pipe material ({PIPE_MATERIAL_LABELS[config.pipeMaterial]}).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {sortedRooms.map((room, idx) => {
                const color = DEVICE_COLORS[idx % DEVICE_COLORS.length];
                return (
                  <div key={room.deviceId} className="rounded-xl p-4" style={{
                    background: 'rgba(15,23,42,0.05)',
                    border: `1px solid ${BURST_RISK_COLORS[room.burstRisk]}33`,
                  }}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm text-slate-700 font-medium">{room.deviceName}</span>
                      <RiskBadge risk={room.burstRisk} />
                    </div>
                    <div className="flex items-center gap-4">
                      <BurstRiskGauge
                        fdh={room.freezingDegreeHours}
                        risk={room.burstRisk}
                        pipeMaterial={config.pipeMaterial}
                        size={72}
                      />
                      <div className="text-xs space-y-1 flex-1">
                        <div className="flex justify-between">
                          <span className="text-slate-500">Current Temp</span>
                          <span className="text-slate-700">{room.currentTempF.toFixed(1)}°F</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Trend</span>
                          <TrendArrow trendPerHourF={room.trendPerHourF} />
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Exposure</span>
                          <span className="text-slate-700">{room.freezingDegreeHours.toFixed(1)} °F·hr</span>
                        </div>
                        {room.hoursToPipeBurst != null && (
                          <div className="flex justify-between">
                            <span className="text-red-600/60">To Burst Zone</span>
                            <span className="text-red-600 font-semibold">{room.hoursToPipeBurst.toFixed(1)}h</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recovery Analysis */}
        {chartTab === 'recovery' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              Recovery rate shows how quickly each room warms back up after a cold dip. 
              Faster recovery indicates a responsive HVAC system and better insulation.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {sortedRooms.map((room, idx) => {
                const color = DEVICE_COLORS[idx % DEVICE_COLORS.length];
                const hasRecovery = room.recoveryRateF != null;
                return (
                  <div key={room.deviceId} className="rounded-xl p-4" style={{
                    background: hasRecovery ? 'rgba(34,197,94,0.05)' : 'rgba(15,23,42,0.05)',
                    border: `1px solid ${hasRecovery ? 'rgba(34,197,94,0.15)' : 'rgba(15,23,42,0.1)'}`,
                  }}>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-3 h-3 rounded-full" style={{ background: color }} />
                      <span className="text-sm text-slate-700 font-medium">{room.deviceName}</span>
                    </div>
                    {hasRecovery ? (
                      <div className="space-y-2">
                        <div className="flex items-end gap-3">
                          <div>
                            <div className="text-2xl font-bold text-green-600">+{room.recoveryRateF}
                              <span className="text-sm text-green-600/50 ml-1">°F/hr</span>
                            </div>
                            <div className="text-xs text-slate-500">Recovery rate</div>
                          </div>
                          <div className="text-right">
                            <div className="text-lg font-semibold text-slate-700">{room.recoveryMinutes}
                              <span className="text-xs text-slate-500 ml-1">min</span>
                            </div>
                            <div className="text-xs text-slate-500">to recover</div>
                          </div>
                        </div>
                        {/* Visual recovery bar */}
                        <div className="h-2 rounded-full bg-slate-50 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(100, (room.recoveryRateF! / 5) * 100)}%`,
                              background: 'linear-gradient(90deg, #22c55e, #86efac)',
                              transition: 'width 0.8s ease',
                            }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400">
                          <span>Slow</span>
                          <span>Fast</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-4 text-slate-400 text-xs">
                        No recovery event detected in this window.
                        <br />More data needed or room hasn't had a cold dip.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Settings panel */}
      <div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-700 transition-colors"
        >
          <span>{showSettings ? '▼' : '▶'}</span>
          <span>⚙️ Forecast Settings</span>
        </button>
        {showSettings && (
          <div className="mt-3 p-4 rounded-xl grid grid-cols-2 sm:grid-cols-5 gap-4" style={{
            background: 'rgba(15,23,42,0.05)',
            border: '1px solid rgba(15,23,42,0.1)',
          }}>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Pipe Material</label>
              <select
                value={config.pipeMaterial}
                onChange={e => setConfig({ ...config, pipeMaterial: e.target.value as PipeMaterial })}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-slate-900"
              >
                {(Object.keys(PIPE_MATERIAL_LABELS) as PipeMaterial[]).map(m => (
                  <option key={m} value={m}>{PIPE_MATERIAL_LABELS[m]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Thermostat Setpoint (°F)</label>
              <input
                type="number"
                value={config.thermostatSetpointF}
                onChange={e => setConfig({ ...config, thermostatSetpointF: parseFloat(e.target.value) || 68 })}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-slate-900 text-center"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Trend Window (hours)</label>
              <input
                type="number"
                value={config.trendWindowHours}
                onChange={e => setConfig({ ...config, trendWindowHours: parseInt(e.target.value) || 6 })}
                min={1}
                max={24}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-slate-900 text-center"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Forecast Ahead (hours)</label>
              <input
                type="number"
                value={config.forecastHoursAhead}
                onChange={e => setConfig({ ...config, forecastHoursAhead: parseInt(e.target.value) || 24 })}
                min={6}
                max={120}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-slate-900 text-center"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Pipe Age (years)</label>
              <input
                type="number"
                value={config.pipeAgeYears}
                onChange={e => setConfig({ ...config, pipeAgeYears: parseInt(e.target.value) || 0 })}
                min={0}
                max={100}
                placeholder="0 = unknown"
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-slate-900 text-center"
              />
            </div>
          </div>
        )}
      </div>

      {/* Methodology note */}
      <div className="text-[10px] text-slate-400 leading-relaxed">
        Projections use Newton's law of cooling with a per-room cooling constant derived from actual sensor data. 
        Pipe burst risk is calculated from cumulative freezing-degree-hours (°F·hr below 32°F). 
        Outside temperatures are from OpenWeather 5-day/3-hour forecast when available. 
        Actual outcomes depend on HVAC status, building construction, and environmental factors not captured by sensors.
      </div>
    </div>
  );
};

export default FreezeForecast;
