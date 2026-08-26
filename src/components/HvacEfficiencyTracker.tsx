/**
 * HvacEfficiencyTracker — HVAC Performance Dashboard Component
 *
 * Shows per-room HVAC health scores, cycle analysis, comfort heatmap,
 * load-performance curve, recovery analysis, cost impact, and
 * degradation trend — all from sensor data + outside temperature.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  AreaChart,
  Area,
  ComposedChart,
  LineChart,
  Line,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts';
import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';
import {
  analyzeHvacEfficiency,
  DEFAULT_HVAC_CONFIG,
  SYSTEM_LABELS,
  HEALTH_COLORS,
  type HvacEfficiencyResult,
  type HvacEfficiencyConfig,
  type RoomHvacProfile,
  type HvacSystemType,
} from '../services/hvacEfficiencyService';
import { fetchOutsideTemperature } from '../services/thermalLeakService';

// Device color palette (matches SensorCharts)
const DEVICE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

interface HvacEfficiencyTrackerProps {
  devices: ShellyDevice[];
  readings: SensorReading[];
  properties: { id: string; address: string; propertyData?: { summary?: { latitude?: number; longitude?: number } } }[];
  selectedProperty: string;
}

// ─── Sub-Components ──────────────────────────────────────────────

const HealthGauge: React.FC<{ score: number; size?: number }> = ({ score, size = 72 }) => {
  const pct = clampLocal(score, 0, 100);
  const color = score >= 85 ? '#22c55e' : score >= 70 ? '#84cc16' : score >= 55 ? '#eab308' : score >= 35 ? '#f97316' : '#ef4444';
  const r = (size - 8) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pct / 100);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={5} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={5} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={dashOffset}
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold" style={{ color }}>{score}</span>
        <span className="text-[9px] text-white/30">Health</span>
      </div>
    </div>
  );
};

function clampLocal(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const UrgencyBadge: React.FC<{ urgency: RoomHvacProfile['urgency'] }> = ({ urgency }) => {
  const styles: Record<RoomHvacProfile['urgency'], { bg: string; border: string; color: string; icon: string; label: string }> = {
    info: { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.3)', color: '#60a5fa', icon: 'ℹ️', label: 'Info' },
    low: { bg: 'rgba(132,204,22,0.12)', border: 'rgba(132,204,22,0.3)', color: '#84cc16', icon: '🟢', label: 'Low' },
    moderate: { bg: 'rgba(234,179,8,0.12)', border: 'rgba(234,179,8,0.3)', color: '#eab308', icon: '🟡', label: 'Moderate' },
    high: { bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.3)', color: '#f97316', icon: '🟠', label: 'High' },
    critical: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', color: '#ef4444', icon: '🔴', label: 'Critical' },
  };
  const s = styles[urgency];
  return (
    <span className="px-2 py-0.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
      {s.icon} {s.label}
    </span>
  );
};

const ConfidenceMeter: React.FC<{ confidence: number }> = ({ confidence }) => {
  const color = confidence >= 70 ? '#22c55e' : confidence >= 45 ? '#eab308' : '#ef4444';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${confidence}%`, background: color }} />
      </div>
      <span className="text-xs" style={{ color }}>{confidence}%</span>
    </div>
  );
};

const ComfortBar: React.FC<{ label: string; score: number }> = ({ label, score }) => {
  const color = score >= 85 ? '#22c55e' : score >= 70 ? '#84cc16' : score >= 55 ? '#eab308' : score >= 35 ? '#f97316' : '#ef4444';
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50 w-20 text-right">{label}</span>
      <div className="flex-1 h-4 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="text-xs font-semibold w-10 text-right" style={{ color }}>{score}%</span>
    </div>
  );
};

/** Custom tooltip for charts */
const HvacTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl p-3 border border-white/20" style={{
      background: 'linear-gradient(180deg, rgba(15,23,42,0.95), rgba(10,15,30,0.95))',
      backdropFilter: 'blur(12px)',
    }}>
      <p className="text-white/60 text-xs mb-2">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs py-0.5">
          <div className="w-2 h-2 rounded-full" style={{ background: entry.color || entry.stroke }} />
          <span className="text-white/80">{entry.name}:</span>
          <span className="font-semibold text-white">
            {typeof entry.value === 'number' ? entry.value.toFixed(1) : '—'}
            {entry.name?.includes('°F') || entry.name?.includes('Temp') ? '°F' : ''}
          </span>
        </div>
      ))}
    </div>
  );
};

/** Comfort heatmap (24h × 7 days) */
const ComfortHeatmap: React.FC<{ heatmap: number[][] }> = ({ heatmap }) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cellColor = (score: number) => {
    if (score >= 90) return 'rgba(34,197,94,0.6)';
    if (score >= 70) return 'rgba(132,204,22,0.5)';
    if (score >= 50) return 'rgba(234,179,8,0.4)';
    if (score >= 30) return 'rgba(249,115,22,0.4)';
    if (score > 0) return 'rgba(239,68,68,0.4)';
    return 'rgba(255,255,255,0.03)';
  };

  return (
    <div className="overflow-x-auto">
      <div className="inline-grid gap-[2px]" style={{ gridTemplateColumns: `40px repeat(7, 1fr)` }}>
        {/* Header row */}
        <div />
        {days.map(d => (
          <div key={d} className="text-[10px] text-white/40 text-center px-1">{d}</div>
        ))}
        {/* Hour rows */}
        {Array.from({ length: 24 }, (_, h) => (
          <React.Fragment key={h}>
            <div className="text-[10px] text-white/30 text-right pr-2 leading-5">
              {h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`}
            </div>
            {Array.from({ length: 7 }, (_, d) => (
              <div
                key={d}
                className="w-8 h-5 rounded-sm transition-colors"
                style={{ background: cellColor(heatmap[h]?.[d] ?? 0) }}
                title={`${days[d]} ${h}:00 — Comfort: ${heatmap[h]?.[d] ?? 0}%`}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────

const HvacEfficiencyTracker: React.FC<HvacEfficiencyTrackerProps> = ({
  devices,
  readings,
  properties,
  selectedProperty,
}) => {
  const [config, setConfig] = useState<HvacEfficiencyConfig>({ ...DEFAULT_HVAC_CONFIG });
  const [outsideTempF, setOutsideTempF] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [expandedRoom, setExpandedRoom] = useState<string | null>(null);
  const [chartTab, setChartTab] = useState<'cycles' | 'comfort' | 'loadperf' | 'recovery' | 'degradation' | 'energy'>('cycles');
  const [manualTemp, setManualTemp] = useState('');
  const [weatherError, setWeatherError] = useState(false);

  // Fetch outside temperature (reuse the thermal leak service fetcher)
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
    fetchOutsideTemperature(lat, lng, apiKey).then(result => {
      if (cancelled) return;
      if (result != null) {
        setOutsideTempF(result.tempF);
        setWeatherError(false);
      } else {
        setWeatherError(true);
      }
    });
    return () => { cancelled = true; };
  }, [selectedProperty, properties]);

  const effectiveOutside = manualTemp ? parseFloat(manualTemp) : outsideTempF;

  // Run analysis
  const result = useMemo<HvacEfficiencyResult | null>(() => {
    return analyzeHvacEfficiency(devices, readings, effectiveOutside, config, 24);
  }, [devices, readings, effectiveOutside, config]);

  if (!result || result.rooms.length === 0) {
    return (
      <div>
        <h4 className="text-lg font-semibold text-white mb-2">🔥 HVAC Efficiency Tracker</h4>
        <p className="text-white/40 text-sm">
          Insufficient temperature data. At least 10 readings per sensor are needed for cycle analysis.
        </p>
      </div>
    );
  }

  // Sort rooms: lowest health first
  const sortedRooms = [...result.rooms].sort((a, b) => a.healthScore - b.healthScore);
  const overallColor = HEALTH_COLORS[result.overallRisk];

  // Chart device names
  const chartDeviceNames = result.rooms.map(r => r.deviceName.replace(/[^a-zA-Z0-9]/g, '_'));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h4 className="text-lg font-semibold text-white flex items-center gap-2">
            🔥 HVAC Efficiency Tracker
            <span
              className="ml-2 px-2 py-0.5 rounded-lg text-xs font-bold"
              style={{ background: `${overallColor}22`, border: `1px solid ${overallColor}55`, color: overallColor }}
            >
              {result.overallRisk === 'excellent' ? 'Excellent' : result.overallRisk.charAt(0).toUpperCase() + result.overallRisk.slice(1)}
            </span>
          </h4>
          <p className="text-white/40 text-sm mt-1">
            Analyzing {result.sensorCount} sensor{result.sensorCount > 1 ? 's' : ''} ·{' '}
            {result.hoursAnalyzed}h of data ·{' '}
            Overall Health: <span className="font-semibold" style={{ color: overallColor }}>{result.overallHealthScore}/100</span>
            {result.overallInefficiencyCost > 0 && (
              <> · Inefficiency Cost: <span className="text-orange-400 font-semibold">${result.overallInefficiencyCost.toFixed(0)}/mo</span></>
            )}
          </p>
        </div>

        {/* Short-cycling alert */}
        {result.rooms.some(r => r.cycleProfile.isShortCycling) && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm" style={{
            background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.3)', color: '#fb923c',
          }}>
            <span className="text-lg">⚠️</span>
            Short-cycling detected in {result.rooms.filter(r => r.cycleProfile.isShortCycling).length} room(s)
          </div>
        )}
      </div>

      {/* Outside temp / manual input */}
      {(outsideTempF == null || weatherError) && (
        <div className="flex items-center gap-3 p-3 rounded-xl" style={{
          background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)',
        }}>
          <span className="text-yellow-400 text-sm">⚠️</span>
          <span className="text-yellow-300/80 text-xs flex-1">
            {weatherError
              ? 'Could not fetch weather. Enter outside temp manually for load-performance analysis.'
              : 'No weather API key. Set VITE_OPENWEATHER_API_KEY for automatic outside temperature.'}
          </span>
          <input
            type="number"
            value={manualTemp}
            onChange={e => setManualTemp(e.target.value)}
            placeholder="°F"
            className="w-20 bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-sm text-white text-center"
          />
        </div>
      )}

      {/* Per-room health cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {sortedRooms.map((room, idx) => {
          const isExpanded = expandedRoom === room.deviceId;
          const deviceColor = DEVICE_COLORS[idx % DEVICE_COLORS.length];

          return (
            <div
              key={room.deviceId}
              className="rounded-xl p-4 cursor-pointer transition-all duration-300 hover:scale-[1.01]"
              style={{
                background: room.healthScore < 40
                  ? 'linear-gradient(180deg, rgba(239,68,68,0.12), rgba(239,68,68,0.04))'
                  : 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))',
                border: `1px solid ${room.healthScore < 40 ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.12)'}`,
              }}
              onClick={() => setExpandedRoom(isExpanded ? null : room.deviceId)}
            >
              {/* Card header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ background: deviceColor }} />
                  <span className="text-sm font-medium text-white truncate max-w-[140px]">{room.deviceName}</span>
                </div>
                <UrgencyBadge urgency={room.urgency} />
              </div>

              {/* Health gauge + key metrics */}
              <div className="flex items-center gap-4 mb-3">
                <HealthGauge score={room.healthScore} size={64} />
                <div className="flex-1 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-white/40">Setpoint</span>
                    <span className="text-white/80">{room.comfort.inferredSetpointF}°F</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/40">Comfort</span>
                    <span className="text-white/80">{room.comfort.overallScore}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/40">Cycles/hr</span>
                    <span className={`${room.cycleProfile.isShortCycling ? 'text-orange-400' : 'text-white/80'}`}>
                      {room.cycleProfile.cyclesPerHour.toFixed(1)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/40">Duty</span>
                    <span className="text-white/80">{(room.cycleProfile.dutyCycle * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>

              {/* Comfort time-of-day */}
              <div className="space-y-1 mb-2">
                {room.comfort.buckets.map(bucket => (
                  <ComfortBar key={bucket.label} label={bucket.label} score={bucket.score} />
                ))}
              </div>

              {/* Confidence */}
              <ConfidenceMeter confidence={room.confidence} />

              {/* Expanded detail */}
              {isExpanded && (
                <div className="mt-4 pt-4 border-t border-white/10 space-y-3 text-xs" onClick={e => e.stopPropagation()}>
                  {/* Cycle metrics */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-white/40">Avg Amplitude</span>
                      <div className="text-white/80 font-medium">{room.cycleProfile.avgAmplitudeF.toFixed(2)}°F</div>
                    </div>
                    <div>
                      <span className="text-white/40">Period Regularity</span>
                      <div className="text-white/80 font-medium">±{room.cycleProfile.periodStdDevMin.toFixed(1)} min</div>
                    </div>
                    <div>
                      <span className="text-white/40">Recovery Rate</span>
                      <div className="text-white/80 font-medium">
                        {room.recovery.avgRecoveryRateF > 0 ? `+${room.recovery.avgRecoveryRateF}°F/hr` : '—'}
                      </div>
                    </div>
                    <div>
                      <span className="text-white/40">Overshoot</span>
                      <div className="text-white/80 font-medium">
                        {room.recovery.avgOvershootF > 0 ? `${room.recovery.avgOvershootF}°F` : 'None'}
                      </div>
                    </div>
                    <div>
                      <span className="text-white/40">Thermal Lag</span>
                      <div className="text-white/80 font-medium">
                        {room.recovery.avgThermalLagMin > 0 ? `${room.recovery.avgThermalLagMin} min` : '—'}
                      </div>
                    </div>
                    <div>
                      <span className="text-white/40">Data Points</span>
                      <div className="text-white/80 font-medium">{room.dataPoints}</div>
                    </div>
                  </div>

                  {/* Cost impact */}
                  {room.cost.inefficiencyTaxPerMonth > 0 && (
                    <div className="p-2 rounded-lg" style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.2)' }}>
                      <div className="text-orange-400 font-medium mb-0.5">💰 Cost Impact</div>
                      <div className="text-white/60">
                        Est. HVAC cost: ${room.cost.estimatedMonthlyCost.toFixed(0)}/mo ·
                        Efficient baseline: ${room.cost.efficientBaselineCost.toFixed(0)}/mo ·
                        Inefficiency tax: <span className="text-orange-400 font-semibold">${room.cost.inefficiencyTaxPerMonth.toFixed(0)}/mo</span> (${room.cost.inefficiencyTaxPerYear.toFixed(0)}/yr)
                      </div>
                    </div>
                  )}

                  {/* Short cycling note */}
                  {room.cycleProfile.isShortCycling && (
                    <div className="p-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                      <div className="text-red-400 font-medium mb-0.5">⚡ Short-Cycling</div>
                      <div className="text-white/60">{room.cycleProfile.shortCyclingNote}</div>
                    </div>
                  )}

                  {/* Recommendation */}
                  <div className="p-2 rounded-lg" style={{
                    background: room.urgency === 'high' || room.urgency === 'critical'
                      ? 'rgba(249,115,22,0.08)' : 'rgba(59,130,246,0.08)',
                    border: `1px solid ${room.urgency === 'high' || room.urgency === 'critical'
                      ? 'rgba(249,115,22,0.2)' : 'rgba(59,130,246,0.2)'}`,
                  }}>
                    <div className="text-white/80 leading-relaxed">{room.recommendation}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Charts section */}
      <div>
        <div className="flex gap-2 mb-4 flex-wrap">
          {[
            { id: 'cycles' as const, label: '🌡️ HVAC Cycles' },
            { id: 'comfort' as const, label: '🏠 Comfort Heatmap' },
            { id: 'loadperf' as const, label: '📊 Load vs Performance' },
            { id: 'recovery' as const, label: '🔄 Recovery' },
            { id: 'degradation' as const, label: '📉 Health Trend' },
            { id: 'energy' as const, label: '💰 Energy' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setChartTab(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                chartTab === tab.id
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* HVAC Cycle Chart */}
        {chartTab === 'cycles' && (
          <div>
            <p className="text-xs text-white/40 mb-2">
              Temperature oscillations reveal HVAC on/off cycles. Shaded regions indicate detected heating phases.
            </p>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={result.cycleChartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="time"
                    tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="temp"
                    tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                    tickLine={false}
                    domain={['auto', 'auto']}
                    label={{ value: '°F', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.3)', fontSize: 11 }}
                  />
                  {/* Hidden Y-axis for HVAC state (0/1) */}
                  <YAxis yAxisId="state" domain={[0, 1]} hide />
                  <Tooltip content={<HvacTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }} />

                  {/* Shaded regions for detected HVAC-on phases (rendered first = behind lines) */}
                  {chartDeviceNames.map((name, idx) => (
                    <Area
                      key={`shade-${name}`}
                      yAxisId="state"
                      dataKey={`hvacState.${name}`}
                      name={`${result.rooms[idx]?.deviceName || name} (heating)`}
                      fill={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                      fillOpacity={0.12}
                      stroke="none"
                      dot={false}
                      activeDot={false}
                      legendType="none"
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  ))}

                  {/* Temperature lines (rendered on top of shading) */}
                  {chartDeviceNames.map((name, idx) => (
                    <Line
                      key={name}
                      yAxisId="temp"
                      dataKey={`devices.${name}`}
                      name={result.rooms[idx]?.deviceName || name}
                      stroke={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* Legend for shading */}
            <div className="flex items-center gap-4 mt-2 text-[10px] text-white/40 justify-center">
              <span>Shaded = detected heating phase</span>
              {chartDeviceNames.map((name, idx) => (
                <div key={name} className="flex items-center gap-1">
                  <div className="w-3 h-2 rounded-sm" style={{
                    background: DEVICE_COLORS[idx % DEVICE_COLORS.length],
                    opacity: 0.25,
                  }} />
                  <span>{result.rooms[idx]?.deviceName || name}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Comfort Heatmap */}
        {chartTab === 'comfort' && (
          <div className="space-y-4">
            <p className="text-xs text-white/40">
              Each cell shows the comfort score (% of readings within ±{config.comfortBandF}°F of setpoint) for that hour and day of week.
              Green = comfortable, red = significant deviation.
            </p>
            <ComfortHeatmap heatmap={result.comfortHeatmap} />
            <div className="flex items-center gap-4 text-[10px] text-white/30 justify-center">
              <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(239,68,68,0.4)' }} /> 0–30%</div>
              <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(249,115,22,0.4)' }} /> 30–50%</div>
              <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(234,179,8,0.4)' }} /> 50–70%</div>
              <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(132,204,22,0.5)' }} /> 70–90%</div>
              <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm" style={{ background: 'rgba(34,197,94,0.6)' }} /> 90–100%</div>
            </div>
          </div>
        )}

        {/* Load-Performance Curve */}
        {chartTab === 'loadperf' && (
          <div className="space-y-3">
            <p className="text-xs text-white/40">
              Each dot represents one hour of data. X-axis = thermal load (|setpoint − outside|), Y-axis = how well setpoint was maintained.
              The "knee point" is where your HVAC starts losing the battle.
            </p>
            {result.loadPerformance.points.length > 0 ? (
              <>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis
                        dataKey="loadDeltaF"
                        name="Load (ΔT °F)"
                        tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                        tickLine={false}
                        label={{ value: 'Thermal Load (ΔT °F)', position: 'bottom', fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                      />
                      <YAxis
                        dataKey="performance"
                        name="Performance %"
                        domain={[0, 100]}
                        tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                        tickLine={false}
                        label={{ value: 'Performance %', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                      />
                      <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<HvacTooltip />} />
                      <ReferenceLine y={80} stroke="#eab308" strokeDasharray="6 3" strokeOpacity={0.4}
                        label={{ value: '80% threshold', fill: '#eab308', fontSize: 9, position: 'right' }} />
                      {result.loadPerformance.kneePointDeltaF != null && (
                        <ReferenceLine x={result.loadPerformance.kneePointDeltaF} stroke="#f97316" strokeDasharray="6 3" strokeOpacity={0.6}
                          label={{ value: `Knee: ${result.loadPerformance.kneePointDeltaF}°F`, fill: '#fb923c', fontSize: 9, position: 'top' }} />
                      )}
                      <Scatter name="Hourly Performance" data={result.loadPerformance.points} fill="#3b82f6" fillOpacity={0.6} r={4}>
                        {result.loadPerformance.points.map((p, i) => (
                          <Cell key={i} fill={p.performance >= 80 ? '#3b82f6' : p.performance >= 50 ? '#eab308' : '#ef4444'} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <div className="p-3 rounded-xl text-xs text-white/60" style={{
                  background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
                }}>
                  📊 {result.loadPerformance.capacityRating}
                </div>
              </>
            ) : (
              <div className="text-center py-8 text-white/30 text-sm">
                Need outside temperature data to build the load-performance curve.
              </div>
            )}
          </div>
        )}

        {/* Recovery Analysis Bar Chart */}
        {chartTab === 'recovery' && (() => {
          // Build per-room recovery comparison data
          const hasRecoveryData = result.rooms.some(r => r.recovery.events.length > 0);
          const roomCompare = result.rooms.map((room, idx) => ({
            name: room.deviceName.length > 14 ? room.deviceName.slice(0, 12) + '…' : room.deviceName,
            fullName: room.deviceName,
            recoveryRate: room.recovery.avgRecoveryRateF,
            overshoot: room.recovery.avgOvershootF,
            thermalLag: room.recovery.avgThermalLagMin,
            events: room.recovery.events.length,
            color: DEVICE_COLORS[idx % DEVICE_COLORS.length],
          }));

          // Build timeline of individual recovery events for the scatter overlay
          const eventScatter = result.rooms.flatMap((room, idx) =>
            room.recovery.events.map(ev => ({
              timestamp: ev.startTs,
              time: new Date(ev.startTs).toLocaleTimeString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              }),
              durationMin: ev.durationMin,
              rateF: ev.rateF,
              overshootF: ev.overshootF,
              room: room.deviceName,
              color: DEVICE_COLORS[idx % DEVICE_COLORS.length],
            }))
          ).sort((a, b) => a.timestamp - b.timestamp);

          return (
            <div className="space-y-5">
              <p className="text-xs text-white/40">
                How quickly each room recovers from temperature dips. Faster recovery = better HVAC
                delivery to that zone. Large differences between rooms suggest ductwork or insulation issues.
              </p>

              {hasRecoveryData ? (
                <>
                  {/* Recovery rate comparison bar chart */}
                  <div>
                    <h4 className="text-xs font-medium text-white/60 mb-2">Recovery Rate by Room (°F/hr)</h4>
                    <div className="h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={roomCompare} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis
                            dataKey="name"
                            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }}
                            tickLine={false}
                          />
                          <YAxis
                            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                            tickLine={false}
                            label={{ value: '°F/hr', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                          />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (!active || !payload?.length) return null;
                              const d = payload[0].payload;
                              return (
                                <div className="rounded-lg p-3 text-xs shadow-xl" style={{
                                  background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.15)',
                                }}>
                                  <div className="font-medium text-white mb-1">{d.fullName}</div>
                                  <div className="text-white/60">Recovery Rate: <span className="text-emerald-400 font-medium">+{d.recoveryRate}°F/hr</span></div>
                                  <div className="text-white/60">Overshoot: <span className="text-amber-400">{d.overshoot > 0 ? `${d.overshoot}°F` : 'None'}</span></div>
                                  <div className="text-white/60">Thermal Lag: <span className="text-blue-400">{d.thermalLag > 0 ? `${d.thermalLag} min` : '—'}</span></div>
                                  <div className="text-white/40 mt-1">Based on {d.events} recovery event{d.events !== 1 ? 's' : ''}</div>
                                </div>
                              );
                            }}
                          />
                          <Bar dataKey="recoveryRate" name="Recovery Rate" radius={[4, 4, 0, 0]}>
                            {roomCompare.map((entry, i) => (
                              <Cell key={i} fill={entry.color} fillOpacity={0.7} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Thermal lag + overshoot grouped comparison */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <h4 className="text-xs font-medium text-white/60 mb-2">Thermal Lag (minutes)</h4>
                      <div className="h-44">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={roomCompare} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 60 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                            <XAxis
                              type="number"
                              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                              tickLine={false}
                            />
                            <YAxis
                              type="category"
                              dataKey="name"
                              tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }}
                              tickLine={false}
                              width={55}
                            />
                            <Tooltip
                              content={({ active, payload }) => {
                                if (!active || !payload?.length) return null;
                                const d = payload[0].payload;
                                return (
                                  <div className="rounded-lg p-2 text-xs shadow-xl" style={{
                                    background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.15)',
                                  }}>
                                    <div className="text-white">{d.fullName}: <span className="text-blue-400">{d.thermalLag} min</span> lag</div>
                                  </div>
                                );
                              }}
                            />
                            <Bar dataKey="thermalLag" name="Thermal Lag" radius={[0, 4, 4, 0]}>
                              {roomCompare.map((entry, i) => (
                                <Cell key={i} fill={entry.color} fillOpacity={0.5} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div>
                      <h4 className="text-xs font-medium text-white/60 mb-2">Overshoot (°F above setpoint)</h4>
                      <div className="h-44">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={roomCompare} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 60 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                            <XAxis
                              type="number"
                              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                              tickLine={false}
                            />
                            <YAxis
                              type="category"
                              dataKey="name"
                              tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }}
                              tickLine={false}
                              width={55}
                            />
                            <Tooltip
                              content={({ active, payload }) => {
                                if (!active || !payload?.length) return null;
                                const d = payload[0].payload;
                                return (
                                  <div className="rounded-lg p-2 text-xs shadow-xl" style={{
                                    background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.15)',
                                  }}>
                                    <div className="text-white">{d.fullName}: <span className="text-amber-400">{d.overshoot > 0 ? `+${d.overshoot}°F` : 'No overshoot'}</span></div>
                                  </div>
                                );
                              }}
                            />
                            <Bar dataKey="overshoot" name="Overshoot" radius={[0, 4, 4, 0]}>
                              {roomCompare.map((entry, i) => (
                                <Cell key={i} fill={entry.color} fillOpacity={0.5} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>

                  {/* Individual recovery event scatter timeline */}
                  {eventScatter.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-white/60 mb-2">Recovery Events Timeline</h4>
                      <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                            <XAxis
                              dataKey="time"
                              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 9 }}
                              tickLine={false}
                              interval="preserveStartEnd"
                            />
                            <YAxis
                              dataKey="durationMin"
                              name="Duration (min)"
                              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                              tickLine={false}
                              label={{ value: 'min', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                            />
                            <Tooltip
                              content={({ active, payload }) => {
                                if (!active || !payload?.length) return null;
                                const d = payload[0].payload;
                                return (
                                  <div className="rounded-lg p-2 text-xs shadow-xl" style={{
                                    background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(255,255,255,0.15)',
                                  }}>
                                    <div className="font-medium text-white mb-1">{d.room}</div>
                                    <div className="text-white/60">Duration: {d.durationMin} min</div>
                                    <div className="text-white/60">Rate: +{d.rateF}°F/hr</div>
                                    {d.overshootF > 0 && (
                                      <div className="text-amber-400">Overshoot: +{d.overshootF}°F</div>
                                    )}
                                  </div>
                                );
                              }}
                            />
                            <Scatter name="Recovery Events" data={eventScatter}>
                              {eventScatter.map((entry, i) => (
                                <Cell key={i} fill={entry.color} fillOpacity={0.7} r={6} />
                              ))}
                            </Scatter>
                          </ScatterChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  {/* Insight callout */}
                  {(() => {
                    const rates = roomCompare.filter(r => r.recoveryRate > 0);
                    if (rates.length < 2) return null;
                    const fastest = rates.reduce((a, b) => a.recoveryRate > b.recoveryRate ? a : b);
                    const slowest = rates.reduce((a, b) => a.recoveryRate < b.recoveryRate ? a : b);
                    const ratio = fastest.recoveryRate / Math.max(0.1, slowest.recoveryRate);
                    if (ratio < 1.5) return null;
                    return (
                      <div className="p-3 rounded-xl text-xs text-white/60" style={{
                        background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.2)',
                      }}>
                        ⚡ <span className="text-orange-300 font-medium">{slowest.fullName}</span> recovers{' '}
                        <span className="text-orange-400 font-semibold">{ratio.toFixed(1)}× slower</span> than{' '}
                        <span className="text-emerald-300 font-medium">{fastest.fullName}</span>{' '}
                        ({slowest.recoveryRate}°F/hr vs {fastest.recoveryRate}°F/hr). This may indicate restricted airflow, undersized ductwork, or poor insulation in that zone.
                      </div>
                    );
                  })()}
                </>
              ) : (
                <div className="text-center py-8 text-white/30 text-sm">
                  No recovery events detected yet. Recovery analysis requires temperature dips of at least 2°F below the inferred setpoint.
                </div>
              )}
            </div>
          );
        })()}

        {/* Degradation Trend */}
        {chartTab === 'degradation' && (
          <div className="space-y-3">
            <p className="text-xs text-white/40">
              Day-by-day HVAC health score. A downward trend may indicate filter clogging, refrigerant loss, or mechanical wear.
            </p>
            {result.degradationTrend.length > 1 ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={result.degradationTrend} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <defs>
                      <linearGradient id="healthGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                      tickLine={false}
                    />
                    <Tooltip content={<HvacTooltip />} />
                    <ReferenceLine y={70} stroke="#84cc16" strokeDasharray="4 4" strokeOpacity={0.3} />
                    <ReferenceLine y={40} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.3} />
                    <Area
                      dataKey="healthScore"
                      name="Health Score"
                      stroke="#3b82f6"
                      fill="url(#healthGrad)"
                      strokeWidth={2}
                    />
                    <Line
                      dataKey="comfortScore"
                      name="Comfort Score"
                      stroke="#22c55e"
                      strokeWidth={1.5}
                      dot={false}
                      strokeDasharray="4 4"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="text-center py-8 text-white/30 text-sm">
                Need multiple days of data to show degradation trend.
              </div>
            )}
          </div>
        )}

        {/* Energy Proportionality: cost vs degree-days per day */}
        {chartTab === 'energy' && (
          <div className="space-y-3">
            <p className="text-xs text-white/40">
              Plots estimated daily cost against degree-days. A linear relationship indicates proportional energy use;
              outliers above the trend line suggest inefficiency spikes (stuck dampers, aux heat, etc.).
            </p>
            {(() => {
              // Build energy scatter data from degradation trend (has outsideAvgF per day)
              const energyData = result.degradationTrend
                .filter(d => d.outsideAvgF != null)
                .map(d => {
                  const setpoint = result.rooms[0]?.comfort?.inferredSetpointF ?? 68;
                  const dd = Math.max(0, setpoint - (d.outsideAvgF ?? setpoint));
                  // Rough daily cost estimate: DD × duty × rate scaling
                  const dutyCostScale = d.dutyCycle * (config.hvacSystemType === 'gas_furnace' || config.hvacSystemType === 'oil_furnace'
                    ? config.gasRate * 0.6
                    : config.electricRate * 3.5
                  );
                  const dailyCost = Math.round(dd * dutyCostScale * 100) / 100;
                  return {
                    date: d.date,
                    degreeDays: Math.round(dd * 10) / 10,
                    cost: dailyCost,
                    healthScore: d.healthScore,
                    dutyCycle: Math.round(d.dutyCycle * 100),
                  };
                });

              if (energyData.length < 2) {
                return (
                  <div className="text-center py-8 text-white/30 text-sm">
                    Need multiple days of data with outside temperature to show energy analysis.
                  </div>
                );
              }

              return (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis
                        dataKey="degreeDays"
                        type="number"
                        name="Degree-Days"
                        tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                        label={{ value: 'Degree-Days (°F·day)', position: 'bottom', offset: -5, fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                      />
                      <YAxis
                        dataKey="cost"
                        type="number"
                        name="Est. Cost"
                        tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                        label={{ value: 'Est. Daily Cost ($)', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                      />
                      <Tooltip
                        content={<HvacTooltip />}
                      />
                      <Scatter data={energyData} name="Daily Energy">
                        {energyData.map((entry, idx) => (
                          <Cell
                            key={idx}
                            fill={entry.healthScore >= 70 ? '#22c55e' : entry.healthScore >= 50 ? '#eab308' : '#ef4444'}
                            opacity={0.75}
                          />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                  <div className="flex justify-center gap-4 text-[9px] text-white/30 mt-1">
                    <span>🟢 Health ≥70</span>
                    <span>🟡 Health 50-69</span>
                    <span>🔴 Health &lt;50</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Settings panel */}
      <div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 transition-colors"
        >
          <span>{showSettings ? '▼' : '▶'}</span>
          <span>⚙️ Efficiency Settings</span>
        </button>
        {showSettings && (
          <div className="mt-3 p-4 rounded-xl grid grid-cols-2 sm:grid-cols-3 gap-4" style={{
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
          }}>
            <div>
              <label className="text-xs text-white/40 block mb-1">HVAC System Type</label>
              <select
                value={config.hvacSystemType}
                onChange={e => setConfig({ ...config, hvacSystemType: e.target.value as HvacSystemType })}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm text-white"
              >
                {(Object.keys(SYSTEM_LABELS) as HvacSystemType[]).map(t => (
                  <option key={t} value={t}>{SYSTEM_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-white/40 block mb-1">Electric Rate ($/kWh)</label>
              <input
                type="number"
                step="0.01"
                value={config.electricRate}
                onChange={e => setConfig({ ...config, electricRate: parseFloat(e.target.value) || 0.16 })}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm text-white text-center"
              />
            </div>
            <div>
              <label className="text-xs text-white/40 block mb-1">Gas Rate ($/therm)</label>
              <input
                type="number"
                step="0.01"
                value={config.gasRate}
                onChange={e => setConfig({ ...config, gasRate: parseFloat(e.target.value) || 1.20 })}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm text-white text-center"
              />
            </div>
            <div>
              <label className="text-xs text-white/40 block mb-1">Comfort Band (±°F)</label>
              <input
                type="number"
                step="0.5"
                value={config.comfortBandF}
                onChange={e => setConfig({ ...config, comfortBandF: parseFloat(e.target.value) || 1.5 })}
                min={0.5}
                max={5}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm text-white text-center"
              />
            </div>
            <div>
              <label className="text-xs text-white/40 block mb-1">Short-Cycle Threshold (cycles/hr)</label>
              <input
                type="number"
                value={config.shortCycleThreshold}
                onChange={e => setConfig({ ...config, shortCycleThreshold: parseInt(e.target.value) || 4 })}
                min={2}
                max={10}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm text-white text-center"
              />
            </div>
            <div>
              <label className="text-xs text-white/40 block mb-1">Min Cycle Duration (min)</label>
              <input
                type="number"
                value={config.minCycleDurationMin}
                onChange={e => setConfig({ ...config, minCycleDurationMin: parseInt(e.target.value) || 5 })}
                min={2}
                max={30}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm text-white text-center"
              />
            </div>
            <div>
              <label className="text-xs text-white/40 block mb-1">Setpoint Override (°F)</label>
              <input
                type="number"
                step="0.5"
                placeholder="Auto"
                value={config.setpointOverrideF ?? ''}
                onChange={e => {
                  const val = e.target.value.trim();
                  setConfig({ ...config, setpointOverrideF: val ? parseFloat(val) : undefined });
                }}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-2 py-1.5 text-sm text-white text-center"
              />
              <span className="text-[9px] text-white/30 mt-0.5 block">
                {config.setpointOverrideF ? `Using ${config.setpointOverrideF}°F` : 'Auto-inferred from data'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Methodology note */}
      <div className="text-[10px] text-white/20 leading-relaxed">
        Cycle detection uses local minima/maxima in smoothed temperature data. Setpoint is inferred from the statistical mode.
        Comfort score = % time within ±{config.comfortBandF}°F of setpoint. Load-performance curve uses |setpoint − outside ΔT| with a diurnal temperature approximation.
        Cost model uses degree-days × inferred UA / (COP × energy density) × rate. Short-cycling threshold: {config.shortCycleThreshold}+ cycles/hr.
        Actual HVAC performance depends on system age, refrigerant levels, ductwork, and factors beyond sensor measurements.
      </div>
    </div>
  );
};

export default HvacEfficiencyTracker;
