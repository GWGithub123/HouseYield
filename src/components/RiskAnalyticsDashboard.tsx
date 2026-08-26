/**
 * RiskAnalyticsDashboard — Unified Environmental Risk Analytics
 *
 * Humidity-first mold / moisture analytics with exposure-based room scoring
 * and AI-powered recommendations.
 */

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
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
  ReferenceArea,
} from 'recharts';
import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';
import {
  computeRiskTimeSeries,
  type RoomRiskSnapshot,
} from '../services/predictiveMaintenanceService';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEVICE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

const OVERLAY_COLORS: Record<OverlayMetric, string> = {
  moldRiskIndex: '#ef4444',
  materialDamageIndex: '#f97316',
  ventilationScore: '#22c55e',
};

const OVERLAY_LABELS: Record<OverlayMetric, string> = {
  moldRiskIndex: 'Mold Risk',
  materialDamageIndex: 'Material Damage',
  ventilationScore: 'Ventilation',
};

const OVERLAY_ICONS: Record<OverlayMetric, string> = {
  moldRiskIndex: '🦠',
  materialDamageIndex: '🧱',
  ventilationScore: '🌬️',
};

type OverlayMetric = 'moldRiskIndex' | 'materialDamageIndex' | 'ventilationScore';
type TimeRange = '24h' | '7d';

// ─── Props ──────────────────────────────────────────────────────────────────

interface RiskAnalyticsDashboardProps {
  devices: ShellyDevice[];
  readings: SensorReading[];
  properties: { id: string; address: string }[];
  selectedProperty: string;
  autoAnalyze?: boolean;
}

// ─── AI Insight types ────────────────────────────────────────────────────────

interface AIRecommendation {
  room: string;
  issue: string;
  recommendation: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  estimatedCost: string;
}

interface AIInsightsResult {
  recommendations: AIRecommendation[];
  overallScore: number | null;
  summary: string;
  analyzedAt: string;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const ToggleButton: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}> = ({ active, onClick, children, color }) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all border ${
      active
        ? 'text-slate-900 border-transparent'
        : 'text-slate-500 border-slate-200 hover:text-slate-700 hover:bg-slate-50'
    }`}
    style={active && color ? { background: `${color}30`, borderColor: `${color}60`, color } : {}}
  >
    {children}
  </button>
);

const RiskGauge: React.FC<{
  label: string;
  value: number;
  icon: string;
  color: string;
  inverted?: boolean; // if true, high value = good
}> = ({ label, value, icon, color, inverted = false }) => {
  const displayValue = inverted ? value : value;
  const pct = Math.min(100, Math.max(0, displayValue));
  const isGood = inverted ? pct >= 70 : pct <= 30;
  const isBad = inverted ? pct <= 30 : pct >= 70;
  const statusColor = isGood ? '#22c55e' : isBad ? '#ef4444' : '#f59e0b';

  return (
    <div className="rounded-xl p-4 border border-slate-200 bg-slate-50 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span>{icon}</span>
          <span className="text-slate-600 text-xs">{label}</span>
        </div>
        <span className="text-xs font-semibold" style={{ color: statusColor }}>
          {inverted
            ? pct >= 70 ? 'Good' : pct >= 40 ? 'Fair' : 'Poor'
            : pct <= 30 ? 'Low' : pct <= 60 ? 'Moderate' : 'High'}
        </span>
      </div>
      <div className="text-2xl font-bold" style={{ color }}>{pct}</div>
      <div className="h-1.5 rounded-full bg-slate-50 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
};

const PriorityBadge: React.FC<{ priority: AIRecommendation['priority'] }> = ({ priority }) => {
  const styles: Record<AIRecommendation['priority'], { bg: string; text: string; border: string }> = {
    urgent:  { bg: 'bg-red-500/20',    text: 'text-red-600',    border: 'border-red-400/40' },
    high:    { bg: 'bg-orange-500/20', text: 'text-orange-600', border: 'border-orange-400/40' },
    medium:  { bg: 'bg-yellow-500/20', text: 'text-yellow-600', border: 'border-yellow-400/40' },
    low:     { bg: 'bg-blue-500/20',   text: 'text-blue-600',   border: 'border-blue-400/40' },
  };
  const s = styles[priority];
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${s.bg} ${s.text} ${s.border}`}>
      {priority}
    </span>
  );
};

const SkeletonCard = () => (
  <div className="rounded-xl p-4 border border-slate-200 bg-slate-50 animate-pulse space-y-2">
    <div className="h-3 bg-slate-50 rounded w-1/3" />
    <div className="h-4 bg-slate-50 rounded w-3/4" />
    <div className="h-10 bg-slate-50 rounded" />
  </div>
);

const ChartTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl p-3 border border-slate-300" style={{
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(12px)',
      minWidth: 160,
    }}>
      <p className="text-slate-600 text-xs mb-2">{label}</p>
      {payload.map((entry: any, idx: number) => (
        <div key={idx} className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: entry.color }} />
          <span className="text-slate-600 truncate max-w-[120px]">{entry.name}:</span>
          <span className="text-slate-900 font-medium ml-auto">{entry.value}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────────────────

const RiskAnalyticsDashboard: React.FC<RiskAnalyticsDashboardProps> = ({
  devices,
  readings,
  properties,
  selectedProperty,
  autoAnalyze = false,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [focusedRoomId, setFocusedRoomId] = useState<string | null>(null);
  const [showOverlays, setShowOverlays] = useState<Record<OverlayMetric, boolean>>({
    moldRiskIndex: true,
    materialDamageIndex: false,
    ventilationScore: true,
  });
  const [aiInsights, setAiInsights] = useState<AIInsightsResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiCacheTimestamp = useRef<number>(0);
  const AI_CACHE_MS = 10 * 60 * 1000; // 10 minutes

  const hoursBack = timeRange === '24h' ? 24 : 168;

  // Filter devices by property
  const filteredDevices = useMemo(() => {
    if (!selectedProperty || selectedProperty === 'all') return devices;
    return devices.filter(d => d.propertyId === selectedProperty);
  }, [devices, selectedProperty]);

  // Compute risk time series
  const timeSeries = useMemo(() => {
    return computeRiskTimeSeries(filteredDevices, readings, hoursBack);
  }, [filteredDevices, readings, hoursBack]);

  // Unique devices in the time series
  const seriesDevices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of timeSeries) {
      if (!seen.has(s.deviceId)) seen.set(s.deviceId, s.deviceName);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [timeSeries]);

  const currentRisks = useMemo(() => {
    const latestByDevice = new Map<string, RoomRiskSnapshot>();
    for (const snap of timeSeries) {
      const existing = latestByDevice.get(snap.deviceId);
      if (!existing || snap.timestamp > existing.timestamp) {
        latestByDevice.set(snap.deviceId, snap);
      }
    }
    return Array.from(latestByDevice.values())
      .sort((a, b) => (
        b.moldRiskIndex - a.moldRiskIndex
        || b.materialDamageIndex - a.materialDamageIndex
        || a.ventilationScore - b.ventilationScore
      ));
  }, [timeSeries]);

  useEffect(() => {
    if (currentRisks.length === 0) {
      setFocusedRoomId(null);
      return;
    }
    if (!focusedRoomId || !currentRisks.some(room => room.deviceId === focusedRoomId)) {
      setFocusedRoomId(currentRisks[0].deviceId);
    }
  }, [currentRisks, focusedRoomId]);

  const focusedRoom = useMemo(
    () => currentRisks.find(room => room.deviceId === focusedRoomId) || currentRisks[0] || null,
    [currentRisks, focusedRoomId]
  );

  const chartData = useMemo(() => {
    const buckets = new Map<number, Record<string, number | string | null>>();
    for (const snap of timeSeries) {
      if (!buckets.has(snap.timestamp)) {
        buckets.set(snap.timestamp, { time: snap.time, timestamp: snap.timestamp });
      }
      const row = buckets.get(snap.timestamp)!;
      row[snap.deviceName] = snap.currentHumidity;
      if (snap.deviceId === focusedRoomId) {
        row[OVERLAY_LABELS.moldRiskIndex] = snap.moldRiskIndex;
        row[OVERLAY_LABELS.materialDamageIndex] = snap.materialDamageIndex;
        row[OVERLAY_LABELS.ventilationScore] = snap.ventilationScore;
      }
    }
    return Array.from(buckets.values()).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }, [timeSeries, focusedRoomId]);

  // Aggregate summary for AI
  const aggregatedForAI = useMemo(() => {
    return currentRisks.map(r => ({
      name: r.deviceName,
      moldRiskIndex: r.moldRiskIndex,
      moldRisk: r.moldRiskIndex,
      materialDamageIndex: r.materialDamageIndex,
      ventilationScore: r.ventilationScore,
      currentTempF: r.currentTempF,
      currentHumidity: r.currentHumidity,
      peakHumidity: r.peakHumidity,
      hoursAbove60: r.hoursAbove60,
      hoursAbove70: r.hoursAbove70,
      hoursAbove80: r.hoursAbove80,
      humidityCycles: r.humidityCycles,
      avgRecoveryMinutes: r.avgRecoveryMinutes,
      statusSummary: r.statusSummary,
      recentReadings: readings.filter(
        rd => rd.deviceId === r.deviceId &&
              rd.timestamp.getTime() > Date.now() - 24 * 60 * 60 * 1000
      ).length,
    }));
  }, [currentRisks, readings]);

  // Selected property address
  const propertyAddress = useMemo(() => {
    if (!selectedProperty || selectedProperty === 'all') return 'All Properties';
    return properties.find(p => p.id === selectedProperty)?.address || 'Property';
  }, [properties, selectedProperty]);

  // Fetch AI insights
  const fetchAIInsights = useCallback(async (force = false) => {
    if (!force && Date.now() - aiCacheTimestamp.current < AI_CACHE_MS && aiInsights) return;
    if (aggregatedForAI.length === 0) return;

    setAiLoading(true);
    setAiError(null);

    try {
      const res = await fetch('/api/sensor-insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rooms: aggregatedForAI,
          propertyAddress,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Unknown error');

      setAiInsights(data);
      aiCacheTimestamp.current = Date.now();
    } catch (err: any) {
      setAiError(err.message || 'Failed to fetch AI insights');
    } finally {
      setAiLoading(false);
    }
  }, [aggregatedForAI, propertyAddress, aiInsights]);

  useEffect(() => {
    if (!autoAnalyze || aggregatedForAI.length === 0) {
      return;
    }
    void fetchAIInsights();
  }, [autoAnalyze, aggregatedForAI, propertyAddress, fetchAIInsights]);

  const hasData = timeSeries.length > 0;
  const activeRooms = currentRisks.filter(room =>
    room.moldRiskIndex >= 40 || room.materialDamageIndex >= 45 || room.ventilationScore <= 45
  ).length;
  const worstMoldRisk = currentRisks.length > 0 ? Math.max(...currentRisks.map(r => r.moldRiskIndex)) : 0;
  const worstMaterialDamage = currentRisks.length > 0 ? Math.max(...currentRisks.map(r => r.materialDamageIndex)) : 0;
  const worstVentilation = currentRisks.length > 0 ? Math.min(...currentRisks.map(r => r.ventilationScore)) : 0;

  if (filteredDevices.length === 0) {
    return (
      <div className="space-y-4">
        <DashboardHeader />
        <div className="text-center py-12 text-slate-500">
          <div className="text-4xl mb-3">📡</div>
          <p className="text-lg font-medium mb-1">No Sensors Available</p>
          <p className="text-sm">Connect H&amp;T sensors to see risk analytics.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DashboardHeader />

      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-50 border border-slate-200 flex-wrap">
          {(['moldRiskIndex', 'materialDamageIndex', 'ventilationScore'] as const).map(metric => (
            <ToggleButton
              key={metric}
              active={showOverlays[metric]}
              onClick={() => setShowOverlays(prev => ({ ...prev, [metric]: !prev[metric] }))}
              color={OVERLAY_COLORS[metric]}
            >
              {OVERLAY_ICONS[metric]} {OVERLAY_LABELS[metric]}
            </ToggleButton>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Time range */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-50 border border-slate-200">
            {(['24h', '7d'] as const).map(range => (
              <ToggleButton
                key={range}
                active={timeRange === range}
                onClick={() => setTimeRange(range)}
                color="#6366f1"
              >
                {range}
              </ToggleButton>
            ))}
          </div>
        </div>
      </div>

      {currentRisks.length > 1 && (
        <div className="rounded-xl p-4 border border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h5 className="text-slate-600 text-sm font-medium">Focused Room Overlay</h5>
              <p className="text-slate-400 text-xs mt-0.5">Humidity lines stay by room; overlays track one selected room for clarity.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {currentRisks.map((room, index) => (
                <ToggleButton
                  key={room.deviceId}
                  active={focusedRoomId === room.deviceId}
                  onClick={() => setFocusedRoomId(room.deviceId)}
                  color={DEVICE_COLORS[index % DEVICE_COLORS.length]}
                >
                  {room.deviceName}
                </ToggleButton>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Current Risk Summary Gauges ── */}
      {currentRisks.length > 0 && (
        <div>
          <h5 className="text-slate-600 text-sm font-medium mb-3">Current Moisture Snapshot — {propertyAddress}</h5>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <RiskGauge label="Mold Risk" value={worstMoldRisk} icon="🦠" color={OVERLAY_COLORS.moldRiskIndex} inverted={false} />
            <RiskGauge label="Material Stress" value={worstMaterialDamage} icon="🧱" color={OVERLAY_COLORS.materialDamageIndex} inverted={false} />
            <RiskGauge label="Ventilation" value={worstVentilation} icon="🌬️" color={OVERLAY_COLORS.ventilationScore} inverted={true} />
            <div className="rounded-xl p-4 border border-slate-200 bg-slate-50 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span>🚿</span>
                  <span className="text-slate-600 text-xs">Active Rooms</span>
                </div>
                <span className={`text-xs font-semibold ${activeRooms > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {activeRooms > 0 ? 'Watch' : 'Stable'}
                </span>
              </div>
              <div className="text-2xl font-bold text-slate-900">{activeRooms}</div>
              <div className="text-slate-400 text-xs">
                Rooms with elevated mold/material risk or poor recovery
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Mold / Moisture Chart ── */}
      <div className="rounded-xl p-5 border border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h5 className="text-slate-900 font-semibold flex items-center gap-2">
              <span>📈</span>
              Mold / Moisture History
            </h5>
            <p className="text-slate-500 text-xs mt-0.5">
              Humidity remains the primary signal. Background bands show mold-favorable RH zones; optional overlays track the focused room.
            </p>
          </div>
          <span className="text-slate-400 text-xs">
            {focusedRoom ? `Focused: ${focusedRoom.deviceName}` : `${chartData.length} data points`}
          </span>
        </div>

        {!hasData ? (
          <div className="text-center py-16 text-slate-400">
            <div className="text-3xl mb-2">📊</div>
            <p>Not enough sensor readings yet. Data appears as sensors report.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 5, right: 24, left: 0, bottom: 5 }}>
              <ReferenceArea y1={20} y2={55} fill="#22c55e" fillOpacity={0.06} />
              <ReferenceArea y1={55} y2={60} fill="#84cc16" fillOpacity={0.08} />
              <ReferenceArea y1={60} y2={70} fill="#eab308" fillOpacity={0.08} />
              <ReferenceArea y1={70} y2={80} fill="#f97316" fillOpacity={0.09} />
              <ReferenceArea y1={80} y2={100} fill="#ef4444" fillOpacity={0.10} />
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
              <XAxis
                dataKey="time"
                stroke="rgba(15,23,42,0.2)"
                tick={{ fill: 'rgba(15,23,42,0.45)', fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="humidity"
                domain={[20, 100]}
                stroke="rgba(15,23,42,0.2)"
                tick={{ fill: 'rgba(15,23,42,0.45)', fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                yAxisId="risk"
                orientation="right"
                domain={[0, 100]}
                stroke="rgba(15,23,42,0.2)"
                tick={{ fill: 'rgba(15,23,42,0.45)', fontSize: 11 }}
                tickFormatter={(v) => `${v}`}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                wrapperStyle={{ color: 'rgba(15,23,42,0.6)', fontSize: 11 }}
                iconType="circle"
                iconSize={7}
              />

              <ReferenceLine yAxisId="humidity" y={60} stroke="rgba(234,179,8,0.45)" strokeDasharray="4 2" label={{ value: '60% RH', fill: 'rgba(234,179,8,0.7)', fontSize: 10, position: 'insideRight' }} />
              <ReferenceLine yAxisId="humidity" y={70} stroke="rgba(249,115,22,0.45)" strokeDasharray="4 2" label={{ value: '70% RH', fill: 'rgba(249,115,22,0.7)', fontSize: 10, position: 'insideRight' }} />
              <ReferenceLine yAxisId="humidity" y={80} stroke="rgba(239,68,68,0.45)" strokeDasharray="4 2" label={{ value: '80% RH', fill: 'rgba(239,68,68,0.7)', fontSize: 10, position: 'insideRight' }} />

              {seriesDevices.map((device, idx) => (
                <Line
                  key={device.id}
                  type="monotone"
                  yAxisId="humidity"
                  dataKey={device.name}
                  name={device.name}
                  stroke={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  connectNulls
                />
              ))}

              {focusedRoom && (['moldRiskIndex', 'materialDamageIndex', 'ventilationScore'] as const).map(metric => (
                showOverlays[metric] ? (
                  <Line
                    key={metric}
                    type="monotone"
                    yAxisId="risk"
                    dataKey={OVERLAY_LABELS[metric]}
                    name={`${focusedRoom.deviceName} — ${OVERLAY_LABELS[metric]}`}
                    stroke={OVERLAY_COLORS[metric]}
                    strokeWidth={2.5}
                    strokeDasharray={metric === 'ventilationScore' ? '6 4' : metric === 'materialDamageIndex' ? '3 3' : undefined}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                    connectNulls
                  />
                ) : null
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Per-Room Cards ── */}
      {currentRisks.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h5 className="text-slate-900 font-semibold text-sm">Room-by-Room Breakdown</h5>
            <span className="text-slate-400 text-xs">Primary metric: exposure-based mold risk index</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {currentRisks.map((room) => (
              <button
                key={room.deviceId}
                type="button"
                onClick={() => setFocusedRoomId(room.deviceId)}
                className={`text-left rounded-xl p-4 border transition-all ${
                  focusedRoomId === room.deviceId
                    ? 'border-indigo-400/40 bg-indigo-500/10'
                    : 'border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-slate-900 font-medium text-sm">{room.deviceName}</div>
                    <div className="text-slate-500 text-xs mt-0.5">
                      {room.currentHumidity != null ? `${room.currentHumidity.toFixed(0)}% RH` : '—'}
                      {room.currentTempF != null ? ` · ${room.currentTempF.toFixed(0)}°F` : ''}
                      {room.peakHumidity != null ? ` · peak ${room.peakHumidity}%` : ''}
                    </div>
                  </div>
                  {focusedRoomId === room.deviceId && (
                    <span className="px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-indigo-500/15 border border-indigo-400/30 text-indigo-600">
                      Focused
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 mt-3">
                  <div className="rounded-lg bg-slate-50 p-2">
                    <div className="text-slate-500 text-[10px] mb-1">Mold Risk</div>
                    <RiskPill value={room.moldRiskIndex} color={OVERLAY_COLORS.moldRiskIndex} inverted={false} />
                  </div>
                  <div className="rounded-lg bg-slate-50 p-2">
                    <div className="text-slate-500 text-[10px] mb-1">Material</div>
                    <RiskPill value={room.materialDamageIndex} color={OVERLAY_COLORS.materialDamageIndex} inverted={false} />
                  </div>
                  <div className="rounded-lg bg-slate-50 p-2">
                    <div className="text-slate-500 text-[10px] mb-1">Ventilation</div>
                    <RiskPill value={room.ventilationScore} color={OVERLAY_COLORS.ventilationScore} inverted={true} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-slate-400">Exposure</div>
                    <div className="text-slate-600 mt-0.5">
                      {room.hoursAbove60.toFixed(1)}h &gt;60% · {room.hoursAbove70.toFixed(1)}h &gt;70%
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-slate-400">Cycles</div>
                    <div className="text-slate-600 mt-0.5">
                      {room.humidityCycles} spike{room.humidityCycles === 1 ? '' : 's'}
                      {room.avgRecoveryMinutes != null ? ` · ${room.avgRecoveryMinutes}m recovery` : ' · no full recovery seen'}
                    </div>
                  </div>
                </div>

                <p className="text-slate-600 text-xs leading-relaxed mt-3">
                  {room.statusSummary}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── AI Insights Panel ── */}
      <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-indigo-400/10">
          <div className="flex items-center gap-3">
            <span className="text-xl">🤖</span>
            <div>
              <h5 className="text-slate-900 font-semibold">AI Environmental Insights</h5>
              <p className="text-slate-500 text-xs mt-0.5">GPT-powered analysis of your sensor data</p>
            </div>
            {aiInsights && (
              <span className="text-slate-400 text-xs ml-2">
                · updated {new Date(aiInsights.analyzedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          <button
            onClick={() => fetchAIInsights(true)}
            disabled={aiLoading || aggregatedForAI.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-600 border border-indigo-400/30 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {aiLoading ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-indigo-400/40 border-t-indigo-300 rounded-full animate-spin" />
                Analyzing…
              </>
            ) : (
              <>✨ {aiInsights ? 'Refresh Analysis' : 'Analyze Now'}</>
            )}
          </button>
        </div>

        <div className="p-5 space-y-4">
          {aiError && (
            <div className="rounded-xl px-4 py-3 border border-red-400/20 bg-red-500/10 text-red-600 text-sm">
              ⚠️ {aiError}
            </div>
          )}

          {!aiInsights && !aiLoading && !aiError && (
            <div className="text-center py-8 text-slate-500">
              <div className="text-3xl mb-3">💡</div>
              <p className="text-sm">Click "Analyze Now" to get AI-powered recommendations for this property.</p>
              <p className="text-xs mt-1 text-slate-400">Results are cached for 10 minutes.</p>
            </div>
          )}

          {aiLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
            </div>
          )}

          {aiInsights && !aiLoading && (
            <>
              {/* Overall score + summary */}
              {(aiInsights.overallScore != null || aiInsights.summary) && (
                <div className="rounded-xl p-4 border border-slate-200 bg-slate-50 flex flex-col sm:flex-row gap-4">
                  {aiInsights.overallScore != null && (
                    <div className="flex-shrink-0 text-center">
                      <div className="text-3xl font-bold" style={{
                        color: aiInsights.overallScore >= 70 ? '#22c55e' : aiInsights.overallScore >= 40 ? '#f59e0b' : '#ef4444'
                      }}>
                        {aiInsights.overallScore}
                      </div>
                      <div className="text-slate-500 text-xs">Overall Score</div>
                    </div>
                  )}
                  {aiInsights.summary && (
                    <p className="text-slate-600 text-sm leading-relaxed flex-1">{aiInsights.summary}</p>
                  )}
                </div>
              )}

              {/* Recommendation cards */}
              {aiInsights.recommendations.length > 0 ? (
                <div className="space-y-3">
                  {[...aiInsights.recommendations]
                    .sort((a, b) => {
                      const order = { urgent: 0, high: 1, medium: 2, low: 3 };
                      return order[a.priority] - order[b.priority];
                    })
                    .map((rec, idx) => (
                      <div key={idx} className="rounded-xl p-4 border border-slate-200 bg-slate-50">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-slate-900 font-medium text-sm">{rec.room}</span>
                          <span className="text-slate-400 text-xs">·</span>
                          <span className="text-slate-600 text-xs">{rec.issue}</span>
                          <PriorityBadge priority={rec.priority} />
                          {rec.estimatedCost && (
                            <span className="ml-auto text-green-600 text-xs font-medium">{rec.estimatedCost}</span>
                          )}
                        </div>
                        <p className="text-slate-600 text-sm leading-relaxed">{rec.recommendation}</p>
                      </div>
                    ))}
                </div>
              ) : (
                <div className="text-center py-6 text-slate-500 text-sm">
                  No specific recommendations — property conditions look healthy!
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Methodology note ── */}
      <div className="rounded-xl p-4 border border-slate-200 bg-slate-50">
        <details>
          <summary className="text-slate-500 text-xs cursor-pointer hover:text-slate-700 select-none">
            ℹ️ How risk indexes are calculated
          </summary>
          <div className="text-slate-400 text-xs mt-3 space-y-1.5 leading-relaxed">
            <p><strong className="text-slate-500">Mold Risk Index (0-100):</strong> Exposure-based blend of current RH, time above 60/70/80% RH, temperature support for growth, and repeated humid spike recovery behavior. This intentionally stays elevated after repeated bathroom spikes instead of dropping straight to zero when RH briefly falls.</p>
            <p><strong className="text-slate-500">Material Damage Index (0-100):</strong> Moisture-stress score for paint, drywall, and other finishes using cumulative time above 55/60/70/80% RH plus repeated slow-drying events.</p>
            <p><strong className="text-slate-500">Ventilation Score (0-100, higher=better):</strong> Measures whether shower-like humidity spikes recover within room-appropriate targets. Bathrooms are expected to dry much faster than bedrooms.</p>
          </div>
        </details>
      </div>
    </div>
  );
};

// ─── Small helpers ────────────────────────────────────────────────────────────

const DashboardHeader = () => (
  <div className="flex items-center gap-3">
    <span className="text-2xl">📊</span>
    <div>
      <h4 className="text-lg font-semibold text-slate-900">Risk Analytics Dashboard</h4>
      <p className="text-slate-500 text-sm">Mold · Moisture Stress · Ventilation</p>
    </div>
  </div>
);

const RiskPill: React.FC<{ value: number; color: string; inverted: boolean }> = ({ value, color, inverted }) => {
  const isGood = inverted ? value >= 70 : value <= 30;
  const isBad = inverted ? value <= 30 : value >= 70;
  const bg = isGood ? 'rgba(34,197,94,0.12)' : isBad ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)';
  const textColor = isGood ? '#22c55e' : isBad ? '#ef4444' : '#f59e0b';

  return (
    <span
      className="inline-block rounded-lg px-2 py-0.5 text-xs font-semibold"
      style={{ background: bg, color: textColor }}
    >
      {value}
    </span>
  );
};

export default RiskAnalyticsDashboard;
