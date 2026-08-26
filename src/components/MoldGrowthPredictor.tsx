/**
 * MoldGrowthPredictor — Predictive Mold Risk Dashboard Component
 * 
 * Shows per-room mold growth index (VTT 0–6 scale), time-series of
 * mold index progression, daily humidity profiles, and actionable
 * prevention recommendations — all derived from continuous H&T sensor data.
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  ComposedChart,
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
  analyzeMoldGrowth,
  moldIndexDescription,
  getMoldPreventionActions,
  criticalRH,
  dewPointF,
  DEFAULT_MOLD_CONFIG,
  SEVERITY_COLORS,
  HUMIDITY_ZONES,
  classifyHumidityZone,
  type MoldGrowthAnalysisResult,
  type MoldGrowthConfig,
  type MoldGrowthRoomProfile,
  type MoldForecastPoint,
  type SurfaceType,
  type HoursUntilMold,
  type HumidityHealthProfile,
  type VentilationProfile,
  type HumidityZone,
  type VentilationGrade,
  type CondensationRiskPoint,
  type MaterialDamageEstimate,
  type MaterialDamagePoint,
} from '../services/moldGrowthService';
import { fetchOutsideTemperature } from '../services/thermalLeakService';

// Device color palette (matches SensorCharts)
const DEVICE_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

interface MoldGrowthPredictorProps {
  devices: ShellyDevice[];
  readings: SensorReading[];
  properties: { id: string; address: string; propertyData?: { summary?: { latitude?: number; longitude?: number } } }[];
  selectedProperty: string;
}

// ─── Sub-Components ──────────────────────────────────────────────

const SeverityBadge: React.FC<{ severity: MoldGrowthRoomProfile['severity']; size?: 'sm' | 'lg' }> = ({ severity, size = 'sm' }) => {
  const color = SEVERITY_COLORS[severity];
  const icons: Record<MoldGrowthRoomProfile['severity'], string> = {
    none: '✅',
    low: '🟡',
    moderate: '🟠',
    high: '🔴',
    critical: '🦠',
  };
  const sizeClass = size === 'lg' ? 'px-3 py-1.5 text-sm' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`${sizeClass} rounded-lg font-semibold inline-flex items-center gap-1`}
      style={{ background: `${color}22`, border: `1px solid ${color}55`, color }}
    >
      {icons[severity]} {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
  );
};

const TrendIndicator: React.FC<{ trend: MoldGrowthRoomProfile['trend'] }> = ({ trend }) => {
  const labels: Record<MoldGrowthRoomProfile['trend'], { icon: string; text: string; color: string }> = {
    accelerating: { icon: '⚡', text: 'Accelerating', color: '#ef4444' },
    growing: { icon: '📈', text: 'Growing', color: '#f97316' },
    stable: { icon: '➡️', text: 'Stable', color: 'rgba(15,23,42,0.4)' },
    receding: { icon: '📉', text: 'Receding', color: '#22c55e' },
    insufficient_data: { icon: '—', text: 'N/A', color: 'rgba(15,23,42,0.25)' },
  };
  const l = labels[trend];
  return <span className="text-xs flex items-center gap-1" style={{ color: l.color }}>{l.icon} {l.text}</span>;
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

function moldProjectionLabel(hoursUntilMold: HoursUntilMold): string {
  switch (hoursUntilMold.projectionBasis) {
    case 'current_conditions':
      return '(conditions active!)';
    case 'observed_pattern':
      return '(recent pattern repeats)';
    case 'hypothetical_elevated':
      return '(if humidity sustained)';
    default:
      return '(if humidity sustained)';
  }
}

function maxNestedForecastValue(
  forecast: MoldForecastPoint[],
  key: 'deviceIndexCurrent' | 'deviceIndexRepeatPattern' | 'deviceIndexWorst' | 'deviceIndexImproved',
): number {
  return forecast.reduce((max, point) => {
    const values = Object.values(point[key]);
    return Math.max(max, ...values, 0);
  }, 0);
}

function maxFinalForecastValue(
  forecast: MoldForecastPoint[],
  key: 'deviceIndexCurrent' | 'deviceIndexRepeatPattern' | 'deviceIndexWorst' | 'deviceIndexImproved',
): number {
  const finalPoint = forecast[forecast.length - 1];
  return finalPoint ? Math.max(...Object.values(finalPoint[key]), 0) : 0;
}

function firstForecastThresholdDay(
  forecast: MoldForecastPoint[],
  key: 'deviceIndexCurrent' | 'deviceIndexRepeatPattern' | 'deviceIndexWorst' | 'deviceIndexImproved',
  threshold: number,
): number | null {
  for (const point of forecast) {
    if (Math.max(...Object.values(point[key]), 0) >= threshold) return point.day;
  }
  return null;
}

function maxObservedIndex(timeSeries: MoldGrowthAnalysisResult['timeSeries']): number {
  return timeSeries.reduce((max, point) => Math.max(max, ...Object.values(point.deviceIndex), 0), 0);
}

function costRange(low: number, high: number): string {
  if (low <= 0 && high <= 0) return '$0';
  if (low <= 0) return `up to $${high.toLocaleString()}`;
  return `$${low.toLocaleString()}-$${high.toLocaleString()}`;
}

function formatMoldScore(value: number): string {
  if (value === 0) return '0';
  if (value > 0 && value < 0.1) return value.toFixed(3);
  if (value < 1) return value.toFixed(2);
  return value.toFixed(1);
}

function formatHistoryWindow(days: number): string {
  if (days <= 0) return 'the available sensor history';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 10) return `${days.toFixed(1)} days`;
  return `${Math.round(days)} days`;
}

const MOLD_SCORE_SCALE = [
  { value: '0', label: 'No modeled growth', color: '#22c55e' },
  { value: '0.5', label: 'Early risk starts', color: '#84cc16' },
  { value: '1.0', label: 'Microscopic growth', color: '#eab308' },
  { value: '3.0+', label: 'Visible mold likely', color: '#ef4444' },
];

function MoldScoreGuide({ currentMax, zoomMax, maxLabel = 'Max observed' }: { currentMax: number; zoomMax: number; maxLabel?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-slate-700 text-sm font-semibold">Modeled mold growth score</div>
          <div className="text-slate-500 text-xs mt-1 leading-relaxed">
            This is not a humidity reading or a percent chance. It is a cumulative 0-6 growth score that rises when temperature and RH stay mold-friendly, then slowly recedes when conditions dry out.
          </div>
        </div>
        <div className="text-right text-xs shrink-0">
          <div className="text-slate-500">{maxLabel}</div>
          <div className="text-green-600 font-semibold">{formatMoldScore(currentMax)} / 6</div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {MOLD_SCORE_SCALE.map(level => (
          <div key={level.value} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <div className="text-xs font-semibold" style={{ color: level.color }}>{level.value}</div>
            <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">{level.label}</div>
          </div>
        ))}
      </div>
      {currentMax < 0.1 && (
        <div className="text-[11px] text-green-700/75 leading-relaxed">
          Current values are extremely low, so the chart is zoomed to 0-{formatMoldScore(zoomMax)} instead of the full 0-6 scale.
        </div>
      )}
    </div>
  );
}

function ScenarioValueCard({
  label,
  value,
  description,
  color,
}: {
  label: string;
  value: number;
  description: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-slate-600 text-xs font-medium">{label}</div>
        <div className="text-sm font-semibold" style={{ color }}>{formatMoldScore(value)} / 6</div>
      </div>
      <div className="text-[10px] text-slate-400 mt-1 leading-relaxed">{description}</div>
    </div>
  );
}

function ProjectionMarkerCard({
  label,
  threshold,
  day,
  color,
}: {
  label: string;
  threshold: number;
  day: number | null;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-slate-600 text-xs font-medium">{label}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">score {threshold}</div>
        </div>
        <div className="text-sm font-semibold" style={{ color }}>
          {day == null ? 'Not in 30d' : day === 0 ? 'Now' : `Day ${day}`}
        </div>
      </div>
    </div>
  );
}

function damageStyle(riskLevel: MaterialDamageEstimate['riskLevel']): { color: string; label: string } {
  switch (riskLevel) {
    case 'high': return { color: '#ef4444', label: 'High' };
    case 'moderate': return { color: '#f97316', label: 'Moderate' };
    case 'low': return { color: '#eab308', label: 'Low' };
    default: return { color: '#22c55e', label: 'None' };
  }
}

function materialThresholdLabel(level: 'low' | 'moderate' | 'high'): string {
  switch (level) {
    case 'low':
      return 'Inspection';
    case 'moderate':
      return 'Significant';
    case 'high':
      return 'High';
  }
}

const MATERIAL_DAMAGE_SCALE = [
  {
    range: '0-9',
    label: 'Trace moisture wear',
    description: 'Minor accumulation. Watch the trend, but there is not a strong damage signal yet.',
    color: '#22c55e',
  },
  {
    range: '10+',
    label: 'Inspection threshold',
    description: 'Inspect paint edges, seams, corners, and surfaces near windows or exterior walls.',
    color: '#eab308',
  },
  {
    range: '30+',
    label: 'Significant damage',
    description: 'Repeated wetting pattern where bubbling, staining, or drywall paper softening becomes materially more plausible.',
    color: '#f97316',
  },
  {
    range: '65+',
    label: 'High repair risk',
    description: 'Heavy recurring moisture or condensation. Hidden moisture checks and localized repair are likely.',
    color: '#ef4444',
  },
] as const;

function formatDamageIndex(value: number): string {
  if (value <= 0) return '0';
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toString();
}

function formatDamageProjectionDays(days: number | null): string {
  if (days == null) return 'Not in trend';
  if (days === 0) return 'Now';
  if (days < 1) return '<1 day';
  if (days < 7) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

function findMaterialThreshold(
  estimate: MaterialDamageEstimate,
  level: 'low' | 'moderate' | 'high',
) {
  return estimate.thresholdProjections.find(projection => projection.level === level) ?? null;
}

function earliestMaterialThreshold(
  rooms: HumidityHealthProfile[],
  material: 'paint' | 'drywall',
  level: 'low' | 'moderate' | 'high',
): { roomName: string; estimate: MaterialDamageEstimate; days: number | null; alreadyReached: boolean } | null {
  const candidates = rooms
    .map(room => {
      const estimate = room.materialImpact[material];
      const projection = findMaterialThreshold(estimate, level);
      if (!projection) return null;
      return {
        roomName: room.deviceName,
        estimate,
        days: projection.days,
        alreadyReached: projection.alreadyReached,
      };
    })
    .filter((candidate): candidate is { roomName: string; estimate: MaterialDamageEstimate; days: number | null; alreadyReached: boolean } => candidate != null)
    .filter(candidate => candidate.alreadyReached || candidate.days != null)
    .sort((a, b) => (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY));

  return candidates[0] ?? null;
}

function MaterialProjectionCard({
  label,
  material,
  projection,
  color,
}: {
  label: string;
  material: 'paint' | 'drywall';
  projection: { roomName: string; estimate: MaterialDamageEstimate; days: number | null; alreadyReached: boolean } | null;
  color: string;
}) {
  const basis = projection?.estimate.basisWindowDays ? formatHistoryWindow(projection.estimate.basisWindowDays) : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-slate-600 text-xs font-medium">{label}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">{material === 'paint' ? 'Paint finish stress' : 'Drywall paper/core stress'}</div>
        </div>
        <div className="text-sm font-semibold" style={{ color }}>
          {projection ? formatDamageProjectionDays(projection.days) : 'N/A'}
        </div>
      </div>
      <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
        {projection
          ? projection.alreadyReached
            ? `${projection.roomName} is already at the significant threshold.`
            : `${projection.roomName} reaches it first if the recent moisture pattern repeats.`
          : 'No room is climbing toward this threshold in the recent trend.'}
      </div>
      <div className="text-[10px] text-slate-400 mt-1 leading-relaxed">
        Significant means damage index 30: a repeated moisture pattern where paint failure or drywall paper softening becomes meaningfully more likely if conditions keep repeating.
      </div>
      {projection && basis && (
        <div className="text-[9px] text-slate-400 mt-1">
          Based on the last {basis} at {projection.estimate.projectedScorePerDay.toFixed(1)} score/day.
        </div>
      )}
    </div>
  );
}

function MaterialDamageGuide({ currentMax }: { currentMax: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3 mb-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-slate-700 text-sm font-semibold">Material damage index</div>
          <div className="text-slate-500 text-xs mt-1 leading-relaxed">
            This is a 0-100 screening score built from time above 55/65/70% RH, dew point, and condensation risk. It is not dollars, not a percent chance, and not confirmed physical damage.
          </div>
        </div>
        <div className="text-right text-xs shrink-0">
          <div className="text-slate-500">Peak observed</div>
          <div className="text-orange-600 font-semibold">{formatDamageIndex(currentMax)} / 100</div>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
        {MATERIAL_DAMAGE_SCALE.map(level => (
          <div key={level.range} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <div className="text-xs font-semibold" style={{ color: level.color }}>{level.range}</div>
            <div className="text-[11px] text-slate-600 mt-0.5">{level.label}</div>
            <div className="text-[10px] text-slate-400 mt-1 leading-relaxed">{level.description}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-slate-400">
        <span>Solid lines = paint damage index</span>
        <span>Dashed lines = drywall damage index</span>
      </div>
    </div>
  );
}

function DamageEstimateCard({ label, estimate }: { label: string; estimate: MaterialDamageEstimate }) {
  const style = damageStyle(estimate.riskLevel);
  const nextThreshold = estimate.thresholdProjections.find(projection => !projection.alreadyReached) ?? null;
  const significantThreshold = findMaterialThreshold(estimate, 'moderate');
  const basis = estimate.basisWindowDays > 0 ? formatHistoryWindow(estimate.basisWindowDays) : null;

  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-slate-500 text-[10px]">{label}</span>
        <span
          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
          style={{ color: style.color, background: `${style.color}18`, border: `1px solid ${style.color}35` }}
        >
          {style.label}
        </span>
      </div>
      <div className="text-slate-900 font-semibold text-xs">{costRange(estimate.estimatedCostLow, estimate.estimatedCostHigh)}</div>
      <div className="text-slate-400 text-[9px] mt-0.5">Damage index {formatDamageIndex(estimate.currentScore)} / 100</div>
      <div className="text-slate-400 text-[9px] mt-1 leading-tight">10 = inspect, 30 = significant damage, 65 = high repair risk</div>
      <div className="text-[10px] text-slate-500 mt-1 leading-tight">
        {nextThreshold
          ? `${materialThresholdLabel(nextThreshold.level)} threshold: ${formatDamageProjectionDays(nextThreshold.days)}`
          : 'All plotted thresholds already reached'}
      </div>
      <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">
        {significantThreshold?.alreadyReached
          ? 'Significant threshold already reached'
          : significantThreshold?.days != null
            ? `Significant threshold: ${formatDamageProjectionDays(significantThreshold.days)}`
            : 'No recent rise toward significant damage'}
      </div>
      <div className="text-slate-400 text-[9px] mt-1 leading-tight">
        {estimate.projectionBasis === 'recent_pattern' && basis
          ? `${estimate.projectedScorePerDay.toFixed(1)} score/day if last ${basis} repeats`
          : estimate.projectionBasis === 'already_reached'
            ? 'Already beyond the charted thresholds'
            : basis
              ? `Flat over the last ${basis}`
              : 'Not enough history for a timing estimate'}
      </div>
    </div>
  );
}

/** Mold index gauge — circular progress showing 0–6 */
const MoldIndexGauge: React.FC<{ index: number; size?: number }> = ({ index, size = 64 }) => {
  const pct = Math.min(100, (index / 6) * 100);
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  const color = index >= 3 ? '#ef4444' : index >= 2 ? '#f97316' : index >= 1 ? '#eab308' : index >= 0.5 ? '#84cc16' : '#22c55e';

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke="rgba(15,23,42,0.08)" strokeWidth="6" fill="none"
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke={color} strokeWidth="6" fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-bold text-sm" style={{ color }}>{formatMoldScore(index)}</div>
        <div className="text-slate-400 text-[9px]">/6</div>
      </div>
    </div>
  );
};

/** Custom tooltip for mold index chart */
const MoldChartTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl p-3 border border-slate-300" style={{
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(12px)',
      maxWidth: 280,
    }}>
      <p className="text-slate-600 text-xs mb-2">{label}</p>
      {payload.map((entry: any, idx: number) => (
        <div key={idx} className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: entry.color || entry.stroke }} />
          <span className="text-slate-600 truncate">{entry.name}:</span>
          <span className="text-slate-900 font-medium">
            {typeof entry.value === 'number' ? formatMoldScore(entry.value) : entry.value}
          </span>
        </div>
      ))}
      <div className="text-[10px] text-slate-400 mt-2">Score scale: 0 none, 0.5 early risk, 1 microscopic, 3 visible.</div>
    </div>
  );
};

/** Custom tooltip for humidity chart */
const HumidityTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl p-3 border border-slate-300" style={{
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(12px)',
      maxWidth: 280,
    }}>
      <p className="text-slate-600 text-xs mb-2">{label}</p>
      {payload.map((entry: any, idx: number) => (
        <div key={idx} className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: entry.color || entry.stroke }} />
          <span className="text-slate-600 truncate">{entry.name}:</span>
          <span className="text-slate-900 font-medium">{entry.value?.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
};

const MaterialDamageTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl p-3 border border-slate-300" style={{
      background: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(12px)',
      maxWidth: 320,
    }}>
      <p className="text-slate-600 text-xs mb-2">{label}</p>
      {payload
        .filter((entry: any) => typeof entry.value === 'number')
        .map((entry: any, idx: number) => (
          <div key={idx} className="flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: entry.color || entry.stroke }} />
            <span className="text-slate-600 truncate">{entry.name}</span>
            <span className="text-slate-900 font-medium">{entry.value.toFixed(1)}</span>
          </div>
        ))}
        <div className="text-[10px] text-slate-400 mt-2 leading-relaxed">Damage index scale: 10 inspect, 30 significant damage, 65 high repair risk. This is a screening score, not dollars or percent probability.</div>
    </div>
  );
};

// ─── Settings Panel ──────────────────────────────────────────────

const SettingsPanel: React.FC<{
  config: MoldGrowthConfig;
  onChange: (c: MoldGrowthConfig) => void;
  isOpen: boolean;
  onToggle: () => void;
}> = ({ config, onChange, isOpen, onToggle }) => {
  if (!isOpen) return null;

  return (
    <div className="rounded-xl p-4 border border-slate-200 bg-slate-50 space-y-4 mt-4">
      <div className="flex items-center justify-between">
        <h5 className="text-slate-700 text-sm font-semibold">⚙️ Mold Analysis Settings</h5>
        <button onClick={onToggle} className="text-slate-500 hover:text-slate-700 text-xs">Close</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-slate-500 text-xs mb-1">Predominant Wall Surface</label>
          <select
            value={config.surfaceType}
            onChange={(e) => onChange({ ...config, surfaceType: e.target.value as SurfaceType })}
            className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
          >
            <option value="painted_drywall">Painted Drywall</option>
            <option value="bare_drywall">Bare Drywall (Paper-faced)</option>
            <option value="wood">Wood / OSB</option>
            <option value="concrete">Concrete / Masonry</option>
            <option value="tile">Tile / Ceramic</option>
          </select>
        </div>
        <div>
          <label className="block text-slate-500 text-xs mb-1">Alert Threshold (Index)</label>
          <input
            type="number" step="0.5" min="0.5" max="4"
            value={config.alertThreshold}
            onChange={(e) => onChange({ ...config, alertThreshold: parseFloat(e.target.value) || 1.0 })}
            className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
          />
        </div>
        <div>
          <label className="block text-slate-500 text-xs mb-1">Warning After (hours)</label>
          <input
            type="number" step="12" min="12" max="168"
            value={config.warningHoursThreshold}
            onChange={(e) => onChange({ ...config, warningHoursThreshold: parseInt(e.target.value) || 48 })}
            className="w-full rounded-lg bg-slate-50 border border-slate-200 text-slate-900 text-sm p-2 focus:outline-none focus:border-blue-400/50"
          />
        </div>
      </div>
      <p className="text-slate-400 text-xs">
        💡 Surface type affects how fast mold grows — paper-faced drywall is most susceptible, tile is most resistant.
      </p>
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────

const MoldGrowthPredictor: React.FC<MoldGrowthPredictorProps> = ({ devices, readings, properties, selectedProperty }) => {
  const [config, setConfig] = useState<MoldGrowthConfig>(DEFAULT_MOLD_CONFIG);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<number>(168); // 7 days default
  const [chartView, setChartView] = useState<'index' | 'humidity' | 'forecast' | 'daily'>('index');
  const [outsideTempF, setOutsideTempF] = useState<number | null>(null);

  // Fetch outside temperature for condensation risk calculation
  useEffect(() => {
    const prop = selectedProperty !== 'all'
      ? properties.find(p => p.id === selectedProperty)
      : properties[0];
    const lat = prop?.propertyData?.summary?.latitude;
    const lng = prop?.propertyData?.summary?.longitude;
    const apiKey = (import.meta as any).env?.VITE_OPENWEATHER_API_KEY;
    if (!lat || !lng || !apiKey) return;

    let cancelled = false;
    fetchOutsideTemperature(lat, lng, apiKey).then(result => {
      if (!cancelled && result) setOutsideTempF(result.tempF);
    });
    return () => { cancelled = true; };
  }, [selectedProperty, properties]);

  // Run analysis
  const analysis = useMemo(() => {
    return analyzeMoldGrowth(devices, readings, config, timeRange, outsideTempF);
  }, [devices, readings, config, timeRange, outsideTempF]);

  // Selected room details
  const selectedRoomProfile = analysis?.rooms.find(r => r.deviceId === selectedRoom) || null;
  const selectedRoomActions = selectedRoomProfile ? getMoldPreventionActions(selectedRoomProfile.severity) : null;

  // Device names for charting
  const deviceNamesList = useMemo(() => analysis?.rooms.map(r => r.deviceName) || [], [analysis]);

  // Enhanced humidity chart data: adds a 'favorableMarker' field (100 when any device is in
  // mold-favorable zone, 0 otherwise) so we can render vertical green bars on the chart.
  const humidityChartData = useMemo(() => {
    if (!analysis) return [];
    return analysis.timeSeries.map(point => {
      const anyFavorable = Object.values(point.deviceFavorable).some(v => v);
      return {
        ...point,
        favorableMarker: anyFavorable ? 100 : 0,
      };
    });
  }, [analysis]);

  const observedIndexMax = useMemo(() => analysis ? maxObservedIndex(analysis.timeSeries) : 0, [analysis]);
  const observedIndexDomainMax = observedIndexMax < 0.1
    ? 0.1
    : observedIndexMax < 0.5
      ? 0.5
      : Math.min(6, Math.max(1, Math.ceil(observedIndexMax + 0.25)));

  const repeatPatternProjectionMax = useMemo(() => analysis ? maxNestedForecastValue(analysis.forecast, 'deviceIndexRepeatPattern') : 0, [analysis]);
  const sustainedPeakProjectionMax = useMemo(() => analysis ? maxNestedForecastValue(analysis.forecast, 'deviceIndexWorst') : 0, [analysis]);
  const repeatPatternStartMax = useMemo(() => {
    const firstPoint = analysis?.forecast[0];
    return firstPoint ? Math.max(...Object.values(firstPoint.deviceIndexRepeatPattern), 0) : 0;
  }, [analysis]);
  const repeatPatternDay30 = useMemo(() => analysis ? maxFinalForecastValue(analysis.forecast, 'deviceIndexRepeatPattern') : 0, [analysis]);
  const microscopicThresholdDay = useMemo(() => analysis ? firstForecastThresholdDay(analysis.forecast, 'deviceIndexRepeatPattern', 1) : null, [analysis]);
  const visibleThresholdDay = useMemo(() => analysis ? firstForecastThresholdDay(analysis.forecast, 'deviceIndexRepeatPattern', 3) : null, [analysis]);
  const observedDataWindowDays = useMemo(() => {
    if (!analysis || analysis.timeSeries.length < 2) return 0;
    const first = analysis.timeSeries[0].timestamp;
    const last = analysis.timeSeries[analysis.timeSeries.length - 1].timestamp;
    return Math.max(0, (last - first) / (1000 * 60 * 60 * 24));
  }, [analysis]);
  const repeatPatternDailyChange = Math.max(0, (repeatPatternDay30 - repeatPatternStartMax) / 30);
  const forecastDomainMax = repeatPatternProjectionMax > 3
    ? Math.min(6, Math.ceil(repeatPatternProjectionMax + 0.25))
    : 3.2;

  // ─── No data state ─────────────────────────────────────────────

  const humidDevices = devices.filter(d => d.humidity != null && d.temperature != null);
  if (humidDevices.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🦠</span>
          <h4 className="text-lg font-semibold text-slate-900">Mold Growth Predictor</h4>
        </div>
        <div className="text-center py-10 text-slate-500">
          <div className="text-4xl mb-3">💧</div>
          <p className="text-lg font-medium mb-1">Need Humidity Sensors</p>
          <p className="text-sm max-w-md mx-auto">
            This analysis uses temperature + humidity data to model mold growth risk over time.
            Connect at least one H&T sensor to enable it.
          </p>
        </div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🦠</span>
          <h4 className="text-lg font-semibold text-slate-900">Mold Growth Predictor</h4>
        </div>
        <div className="text-center py-10 text-slate-500">
          <div className="text-4xl mb-3 animate-pulse">📊</div>
          <p className="text-sm">Insufficient data — need at least 3 readings per sensor.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🦠</span>
          <div>
            <h4 className="text-lg font-semibold text-slate-900">Mold Growth Predictor</h4>
            <p className="text-slate-500 text-sm">VTT model — cumulative risk from humidity exposure</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Time Range */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-50 border border-slate-200">
            {[
              { label: '24h', value: 24 },
              { label: '7d', value: 168 },
              { label: '30d', value: 720 },
            ].map(({ label, value }) => (
              <button
                key={value}
                onClick={() => setTimeRange(value)}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  timeRange === value
                    ? 'bg-green-500/30 text-green-600 border border-green-400/40'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2 rounded-lg transition-all ${
              showSettings ? 'bg-green-500/20 text-green-600' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
            title="Mold Analysis Settings"
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* Settings */}
      <SettingsPanel config={config} onChange={setConfig} isOpen={showSettings} onToggle={() => setShowSettings(false)} />

      {/* Overall Status Banner */}
      {analysis.overallSeverity !== 'none' && (
        <div className={`rounded-xl p-4 border ${
          analysis.overallSeverity === 'critical' ? 'border-red-400/40 bg-red-500/10' :
          analysis.overallSeverity === 'high' ? 'border-orange-400/40 bg-orange-500/10' :
          analysis.overallSeverity === 'moderate' ? 'border-yellow-400/40 bg-yellow-500/10' :
          'border-lime-400/30 bg-lime-500/5'
        }`}>
          <div className="flex items-center gap-3">
            <span className="text-2xl">
              {analysis.overallSeverity === 'critical' ? '🚨' : analysis.overallSeverity === 'high' ? '⚠️' : '💡'}
            </span>
            <div className="flex-1">
              <div className="text-slate-900 font-semibold text-sm">
                {analysis.overallSeverity === 'critical' ? 'Critical Mold Risk — Immediate Action Required' :
                 analysis.overallSeverity === 'high' ? 'High Mold Risk Detected' :
                 analysis.overallSeverity === 'moderate' ? 'Moderate Mold Risk Building' :
                 'Early Mold-Favorable Conditions'}
              </div>
              <div className="text-slate-500 text-xs mt-0.5">
                {analysis.roomsCurrentlyFavorable} of {analysis.sensorCount} room{analysis.sensorCount !== 1 ? 's' : ''} currently in the mold-favorable humidity zone
              </div>
            </div>
            <SeverityBadge severity={analysis.overallSeverity} size="lg" />
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-green-500/10 to-green-600/5 text-center">
          <div className="text-slate-500 text-xs mb-1">Highest Score</div>
          <div className="text-2xl font-bold" style={{ color: SEVERITY_COLORS[analysis.overallSeverity] }}>
            {formatMoldScore(analysis.rooms.reduce((max, r) => Math.max(max, r.moldIndex), 0))}
          </div>
          <div className="text-slate-400 text-xs mt-0.5">of 6.0</div>
        </div>
        <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 text-center">
          <div className="text-slate-500 text-xs mb-1">Rooms at Risk</div>
          <div className="text-2xl font-bold text-cyan-600">
            {analysis.rooms.filter(r => r.severity !== 'none').length}
          </div>
          <div className="text-slate-400 text-xs mt-0.5">of {analysis.sensorCount}</div>
        </div>
        <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-yellow-500/10 to-yellow-600/5 text-center">
          <div className="text-slate-500 text-xs mb-1">Worst Room</div>
          <div className="text-sm font-bold text-yellow-600 truncate">
            {(() => {
              const worst = analysis.rooms.find(r => r.deviceId === analysis.highestRiskRoom);
              // Only call out a "worst room" when it actually carries risk —
              // otherwise this contradicts a near-zero Highest Score.
              if (!worst || (worst.severity === 'none' && worst.moldIndex < 0.05)) return 'None at risk';
              return worst.deviceName;
            })()}
          </div>
          <div className="text-slate-400 text-xs mt-0.5">highest current risk</div>
        </div>
        <div className="rounded-xl p-4 border border-slate-200 bg-gradient-to-br from-purple-500/10 to-purple-600/5 text-center">
          <div className="text-slate-500 text-xs mb-1">Favorable Now</div>
          <div className="text-2xl font-bold text-purple-600">
            {analysis.roomsCurrentlyFavorable}
          </div>
          <div className="text-slate-400 text-xs mt-0.5">rooms in danger zone</div>
        </div>
      </div>

      {/* Per-Room Cards */}
      <div>
        <h5 className="text-slate-900 font-semibold mb-3 flex items-center gap-2">
          <span>🏠</span> Room-by-Room Risk
        </h5>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {analysis.rooms
            .sort((a, b) => b.riskScore - a.riskScore) // Highest risk first
            .map((room, idx) => (
              <div
                key={room.deviceId}
                onClick={() => setSelectedRoom(selectedRoom === room.deviceId ? null : room.deviceId)}
                className={`rounded-xl p-4 border transition-all cursor-pointer hover:scale-[1.01] ${
                  selectedRoom === room.deviceId
                    ? 'border-green-400/50 bg-green-500/10'
                    : room.severity !== 'none' || (room.rhMargin != null && room.rhMargin > -5)
                      ? `border-slate-200 bg-slate-50`
                      : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <MoldIndexGauge index={room.moldIndex} size={56} />
                  <div className="flex-1 min-w-0">
                    <div className="text-slate-900 font-medium text-sm truncate">{room.deviceName}</div>
                    <div className="text-slate-500 text-xs mt-0.5">
                      {room.currentHumidity?.toFixed(0)}% RH · {room.currentTempF?.toFixed(0)}°F
                    </div>
                  </div>
                  {room.rhMargin != null && room.rhMargin >= 0 ? (
                    <span
                      className="px-2 py-0.5 text-xs rounded-lg font-semibold bg-red-500/20 border border-red-400/40 text-red-600"
                      title="Current humidity is at/above the mold-critical level for this room. Growth score accumulates over time, so it can still read near zero."
                    >
                      ⚠️ Humidity Critical Now
                    </span>
                  ) : room.rhMargin != null && room.rhMargin > -5 ? (
                    <span className="px-2 py-0.5 text-xs rounded-lg font-semibold bg-yellow-500/20 border border-yellow-400/40 text-yellow-600">
                      ⚡ Near Critical
                    </span>
                  ) : (
                    <SeverityBadge severity={room.severity} />
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 text-center mb-2">
                  <div>
                    <div className="text-slate-500 text-[10px]">Favorable</div>
                    <div className="text-slate-900 font-semibold text-xs">
                      {room.favorablePercent.toFixed(0)}%
                      <span className="text-slate-400 font-normal"> of time</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-[10px]">RH Margin</div>
                    <div className={`font-semibold text-xs ${
                      room.rhMargin != null && room.rhMargin > 0 ? 'text-red-600' :
                      room.rhMargin != null && room.rhMargin > -5 ? 'text-yellow-600' : 'text-green-600'
                    }`}>
                      {room.rhMargin != null ? `${room.rhMargin > 0 ? '+' : ''}${room.rhMargin.toFixed(0)}%` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-[10px]">Trend</div>
                    <TrendIndicator trend={room.trend} />
                  </div>
                </div>

                {/* Hours Until Mold countdown — always shown */}
                <div className={`rounded-lg p-2.5 mb-2 border ${
                  room.hoursUntilMold.wouldSustainGrowth
                    ? 'bg-gradient-to-r from-orange-500/10 to-red-500/10 border-orange-400/20'
                    : 'bg-slate-50 border-slate-200'
                }`}>
                  <div className={`text-[10px] font-medium mb-1 ${
                    room.hoursUntilMold.wouldSustainGrowth ? 'text-orange-600/70' : 'text-slate-500'
                  }`}>
                    ⏱ Hours Until Mold {moldProjectionLabel(room.hoursUntilMold)}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="text-[10px] text-slate-500">Early Risk</div>
                      <div className={`text-sm font-bold ${
                        room.moldIndex >= 0.5 ? 'text-red-600' :
                        room.hoursUntilMold.hoursToEarlyRisk != null && room.hoursUntilMold.hoursToEarlyRisk <= 24 ? 'text-red-600' :
                        room.hoursUntilMold.hoursToEarlyRisk != null && room.hoursUntilMold.hoursToEarlyRisk <= 72 ? 'text-orange-600' :
                        room.hoursUntilMold.hoursToEarlyRisk != null ? 'text-yellow-600' : 'text-green-600'
                      }`}>
                        {room.moldIndex >= 0.5 ? '⚠️ Now'
                          : room.hoursUntilMold.hoursToEarlyRisk != null
                            ? room.hoursUntilMold.hoursToEarlyRisk < 1 ? '<1h' : `${Math.round(room.hoursUntilMold.hoursToEarlyRisk)}h`
                            : '✅ Safe'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">Microscopic</div>
                      <div className={`text-sm font-bold ${
                        room.moldIndex >= 1.0 ? 'text-red-600' :
                        room.hoursUntilMold.hoursToMicroscopic != null && room.hoursUntilMold.hoursToMicroscopic <= 48 ? 'text-red-600' :
                        room.hoursUntilMold.hoursToMicroscopic != null && room.hoursUntilMold.hoursToMicroscopic <= 168 ? 'text-orange-600' :
                        room.hoursUntilMold.hoursToMicroscopic != null ? 'text-yellow-600' : 'text-green-600'
                      }`}>
                        {room.moldIndex >= 1.0 ? '⚠️ Now'
                          : room.hoursUntilMold.hoursToMicroscopic != null
                            ? room.hoursUntilMold.hoursToMicroscopic < 1 ? '<1h'
                              : room.hoursUntilMold.hoursToMicroscopic < 48 ? `${Math.round(room.hoursUntilMold.hoursToMicroscopic)}h`
                              : `${Math.round(room.hoursUntilMold.hoursToMicroscopic / 24)}d`
                            : '✅ Safe'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">Visible</div>
                      <div className={`text-sm font-bold ${
                        room.moldIndex >= 3.0 ? 'text-red-600' :
                        room.hoursUntilMold.hoursToVisible != null && room.hoursUntilMold.hoursToVisible <= 168 ? 'text-red-600' :
                        room.hoursUntilMold.hoursToVisible != null && room.hoursUntilMold.hoursToVisible <= 720 ? 'text-orange-600' :
                        room.hoursUntilMold.hoursToVisible != null ? 'text-yellow-600' : 'text-green-600'
                      }`}>
                        {room.moldIndex >= 3.0 ? '🚨 Now'
                          : room.hoursUntilMold.hoursToVisible != null
                            ? room.hoursUntilMold.hoursToVisible < 48 ? `${Math.round(room.hoursUntilMold.hoursToVisible)}h`
                              : `${Math.round(room.hoursUntilMold.hoursToVisible / 24)}d`
                            : '✅ Safe'}
                      </div>
                    </div>
                  </div>
                  {room.hoursUntilMold.wouldSustainGrowth && room.hoursUntilMold.currentFavorableStreak > 0 && (
                    <div className="text-[10px] text-orange-600/50 mt-1 text-center">
                      🔥 Favorable for {room.hoursUntilMold.currentFavorableStreak.toFixed(1)}h continuously
                    </div>
                  )}
                  {!room.hoursUntilMold.wouldSustainGrowth && room.rhMargin != null && (
                    <div className="text-[10px] text-slate-400 mt-1 text-center">
                      {Math.abs(room.rhMargin).toFixed(0)}% below critical RH — not currently at risk
                    </div>
                  )}
                </div>
                {room.daysToMicroscopic === 0 && (
                  <div className="text-xs px-2 py-1.5 rounded-md bg-red-500/15 text-red-600 border border-red-400/25 text-center mb-1">
                    🚨 Mold score already ≥1.0 — microscopic growth detected
                  </div>
                )}

                {room.daysToVisible != null && (
                  <div className="text-xs px-2 py-1 rounded-md bg-red-500/10 text-red-600 border border-red-400/20 text-center">
                    ⏱ Visible mold in ~{room.daysToVisible} day{room.daysToVisible !== 1 ? 's' : ''} at current rate
                  </div>
                )}

                <div className="mt-2">
                  <ConfidenceMeter confidence={room.confidence} />
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* Expanded Room Detail */}
      {selectedRoomProfile && selectedRoomActions && (
        <div className="rounded-xl p-5 border border-green-400/30 bg-green-500/5 space-y-4">
          <div className="flex items-center justify-between">
            <h5 className="text-slate-900 font-semibold flex items-center gap-2">
              <MoldIndexGauge index={selectedRoomProfile.moldIndex} size={40} />
              <span>{selectedRoomProfile.deviceName} — Detailed Analysis</span>
            </h5>
            <button onClick={() => setSelectedRoom(null)} className="text-slate-500 hover:text-slate-700 text-sm">✕</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Metrics */}
            <div className="space-y-2.5">
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Modeled Mold Score</span>
                <span className="text-slate-900 font-medium">{selectedRoomProfile.moldIndex.toFixed(3)} / 6.0</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Status</span>
                <span className="text-slate-600 text-sm">{moldIndexDescription(selectedRoomProfile.moldIndex)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Current Humidity</span>
                <span className="text-slate-900 font-medium">{selectedRoomProfile.currentHumidity?.toFixed(1)}% RH</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Critical RH at Current Temp</span>
                <span className="text-slate-900 font-medium">{selectedRoomProfile.criticalRH?.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Margin from Critical</span>
                <span className={`font-medium ${
                  selectedRoomProfile.rhMargin != null && selectedRoomProfile.rhMargin > 0 ? 'text-red-600' : 'text-green-600'
                }`}>
                  {selectedRoomProfile.rhMargin != null
                    ? `${selectedRoomProfile.rhMargin > 0 ? '+' : ''}${selectedRoomProfile.rhMargin.toFixed(1)}%`
                    : '—'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Dew Point</span>
                <span className="text-slate-900 font-medium">{selectedRoomProfile.currentDewPointF?.toFixed(1)}°F</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Time in Favorable Zone</span>
                <span className="text-slate-900 font-medium">{selectedRoomProfile.favorableHours.toFixed(1)} hrs ({selectedRoomProfile.favorablePercent.toFixed(0)}%)</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Growth Rate</span>
                <span className="text-slate-900 font-medium">{selectedRoomProfile.growthRatePerDay.toFixed(4)} /day</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Growth Intensity</span>
                <span className={`font-medium ${
                  selectedRoomProfile.currentGrowthIntensity > 0.5 ? 'text-red-600' :
                  selectedRoomProfile.currentGrowthIntensity > 0 ? 'text-orange-600' : 'text-green-600'
                }`}>
                  {selectedRoomProfile.currentGrowthIntensity > 0
                    ? `${(selectedRoomProfile.currentGrowthIntensity * 100).toFixed(0)}% active`
                    : 'Dormant'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Favorable Duty Cycle</span>
                <span className={`font-medium ${
                  selectedRoomProfile.favorableDuty > 0.5 ? 'text-red-600' :
                  selectedRoomProfile.favorableDuty > 0.2 ? 'text-orange-600' : 'text-green-600'
                }`}>
                  {(selectedRoomProfile.favorableDuty * 100).toFixed(0)}% of time
                </span>
              </div>

              {/* Hours Until Mold detail */}
              {selectedRoomProfile.hoursUntilMold.wouldSustainGrowth && (
                <div className="rounded-lg p-3 bg-orange-500/10 border border-orange-400/20 mt-2 space-y-1.5">
                  <div className="text-orange-600 text-xs font-semibold">⏱ Hours Until Mold {moldProjectionLabel(selectedRoomProfile.hoursUntilMold)}</div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-xs">→ Early Risk (index 0.5)</span>
                    <span className="text-orange-600 font-medium text-xs">
                      {selectedRoomProfile.hoursUntilMold.hoursToEarlyRisk != null
                        ? `${selectedRoomProfile.hoursUntilMold.hoursToEarlyRisk.toFixed(1)} hours`
                        : selectedRoomProfile.moldIndex >= 0.5 ? '⚠️ Already reached' : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-xs">→ Microscopic (index 1.0)</span>
                    <span className="text-orange-600 font-medium text-xs">
                      {selectedRoomProfile.hoursUntilMold.hoursToMicroscopic != null
                        ? `${selectedRoomProfile.hoursUntilMold.hoursToMicroscopic.toFixed(1)} hours`
                        : selectedRoomProfile.moldIndex >= 1.0 ? '⚠️ Already reached' : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-xs">→ Visible (index 3.0)</span>
                    <span className="text-red-600 font-medium text-xs">
                      {selectedRoomProfile.hoursUntilMold.hoursToVisible != null
                        ? selectedRoomProfile.hoursUntilMold.hoursToVisible > 48
                          ? `${Math.round(selectedRoomProfile.hoursUntilMold.hoursToVisible / 24)} days`
                          : `${selectedRoomProfile.hoursUntilMold.hoursToVisible.toFixed(1)} hours`
                        : selectedRoomProfile.moldIndex >= 3.0 ? '🚨 Already visible' : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-xs">Current Favorable Streak</span>
                    <span className="text-slate-600 text-xs">
                      {selectedRoomProfile.hoursUntilMold.currentFavorableStreak.toFixed(1)} hrs
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 text-xs">Growth Rate (sustained)</span>
                    <span className="text-slate-600 text-xs">
                      {selectedRoomProfile.hoursUntilMold.effectiveGrowthRate.toFixed(5)} /hr
                    </span>
                  </div>
                </div>
              )}
              {selectedRoomProfile.daysToMicroscopic != null && (
                <div className="flex justify-between items-center">
                  <span className="text-slate-600 text-sm">Time to Microscopic Mold</span>
                  <span className={`font-medium ${
                    selectedRoomProfile.daysToMicroscopic === 0 ? 'text-red-600' :
                    selectedRoomProfile.daysToMicroscopic <= 7 ? 'text-orange-600' : 'text-yellow-600'
                  }`}>
                    {selectedRoomProfile.daysToMicroscopic === 0 ? '⚠️ Already There' :
                     selectedRoomProfile.daysToMicroscopic < 1 ? `~${Math.round(selectedRoomProfile.daysToMicroscopic * 24)} hrs` :
                     `~${selectedRoomProfile.daysToMicroscopic.toFixed(0)} days`}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center">
                <span className="text-slate-600 text-sm">Data Points</span>
                <span className="text-slate-600">{selectedRoomProfile.dataPoints} readings</span>
              </div>
            </div>

            {/* Prevention Actions */}
            <div className="rounded-xl p-4 border border-slate-200 bg-slate-50">
              <h6 className="text-slate-900 font-semibold text-sm mb-2">💡 Prevention Actions</h6>
              <div className="flex items-center gap-4 mb-3">
                <div>
                  <span className="text-slate-500 text-xs">Urgency:</span>
                  <span className={`ml-1 text-xs font-medium ${
                    selectedRoomActions.urgency === 'Immediate' ? 'text-red-600' :
                    selectedRoomActions.urgency.includes('48') ? 'text-orange-600' :
                    selectedRoomActions.urgency.includes('week') ? 'text-yellow-600' : 'text-green-600'
                  }`}>
                    {selectedRoomActions.urgency}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 text-xs">Est. Cost:</span>
                  <span className="ml-1 text-xs text-slate-600 font-medium">{selectedRoomActions.estimatedCost}</span>
                </div>
              </div>
              <ul className="space-y-1.5">
                {selectedRoomActions.actions.map((action, i) => (
                  <li key={i} className="text-slate-500 text-xs flex items-start gap-2">
                    <span className="text-green-600 mt-0.5">•</span>
                    <span>{action}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Charts */}
      {analysis.timeSeries.length > 3 && (
        <div className="rounded-xl p-5 border border-slate-200 bg-slate-50">
          {/* Chart Tab Selector */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-50 border border-slate-200">
              <button
                onClick={() => setChartView('index')}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  chartView === 'index' ? 'bg-green-500/30 text-green-600 border border-green-400/40' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                🦠 Mold Score
              </button>
              <button
                onClick={() => setChartView('humidity')}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  chartView === 'humidity' ? 'bg-cyan-500/30 text-cyan-600 border border-cyan-400/40' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                💧 Humidity
              </button>
              <button
                onClick={() => setChartView('forecast')}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  chartView === 'forecast' ? 'bg-orange-500/30 text-orange-600 border border-orange-400/40' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                🔮 30d Scenarios
              </button>
              <button
                onClick={() => setChartView('daily')}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                  chartView === 'daily' ? 'bg-purple-500/30 text-purple-600 border border-purple-400/40' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                📊 Daily Profile
              </button>
            </div>
            <span className="text-slate-500 text-xs">
              {chartView === 'daily' ? '24-hour average' : `${analysis.timeSeries.length} data points`}
            </span>
          </div>

          {/* Mold Score Chart */}
          {chartView === 'index' && (
            <div className="space-y-2">
              <MoldScoreGuide currentMax={observedIndexMax} zoomMax={observedIndexDomainMax} />
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={analysis.timeSeries} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                <XAxis
                  dataKey="time"
                  stroke="rgba(15,23,42,0.3)"
                  tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 10 }}
                />
                <YAxis
                  stroke="rgba(15,23,42,0.3)"
                  tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                  domain={[0, observedIndexDomainMax]}
                />
                <Tooltip content={<MoldChartTooltip />} />
                <Legend wrapperStyle={{ color: 'rgba(15,23,42,0.7)', fontSize: 12 }} iconType="circle" iconSize={8} />

                {/* Severity threshold lines */}
                {observedIndexDomainMax >= 0.5 && (
                  <ReferenceLine y={0.5} stroke="#84cc16" strokeDasharray="5 5" strokeOpacity={0.5}
                    label={{ value: 'Early', fill: '#84cc16', fontSize: 10, position: 'right' }} />
                )}
                {observedIndexDomainMax >= 1 && (
                  <ReferenceLine y={1.0} stroke="#eab308" strokeDasharray="5 5" strokeOpacity={0.5}
                    label={{ value: 'Microscopic', fill: '#eab308', fontSize: 10, position: 'right' }} />
                )}
                {observedIndexDomainMax >= 3 && (
                  <ReferenceLine y={3.0} stroke="#ef4444" strokeDasharray="5 5" strokeOpacity={0.5}
                    label={{ value: 'Visible', fill: '#ef4444', fontSize: 10, position: 'right' }} />
                )}

                {deviceNamesList.map((name, i) => {
                  const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                  return (
                    <Line
                      key={safeName}
                      type="monotone"
                      dataKey={`deviceIndex.${safeName}`}
                      name={name}
                      stroke={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 2 }}
                      connectNulls
                    />
                  );
                })}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Humidity Chart with Vertical Mold-Favorable Green Bars */}
          {chartView === 'humidity' && (
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={humidityChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="favorableBarGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.30} />
                    <stop offset="50%" stopColor="#22c55e" stopOpacity={0.12} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                <XAxis
                  dataKey="time"
                  stroke="rgba(15,23,42,0.3)"
                  tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 10 }}
                />
                <YAxis
                  stroke="rgba(15,23,42,0.3)"
                  tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                  domain={[20, 100]}
                  label={{ value: '%RH', position: 'insideLeft', style: { fill: 'rgba(15,23,42,0.4)' } }}
                />
                <Tooltip content={<HumidityTooltip />} />
                <Legend wrapperStyle={{ color: 'rgba(15,23,42,0.7)', fontSize: 12 }} iconType="circle" iconSize={8} />

                {/* Vertical green bars: full-height bars appear when ANY sensor enters mold-favorable zone */}
                <Area
                  type="step"
                  dataKey="favorableMarker"
                  name="Mold-Favorable Zone"
                  fill="url(#favorableBarGrad)"
                  stroke="#22c55e"
                  strokeWidth={0}
                  fillOpacity={1}
                  dot={false}
                  activeDot={false}
                  legendType="square"
                  isAnimationActive={false}
                />

                {/* Humidity zone threshold lines */}
                <ReferenceLine y={60} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5}
                  label={{ value: 'Mold Risk (60%)', fill: '#22c55e', fontSize: 9, position: 'right' }} />
                <ReferenceLine y={70} stroke="#f97316" strokeDasharray="3 3" strokeOpacity={0.5}
                  label={{ value: 'High Risk (70%)', fill: '#f97316', fontSize: 9, position: 'right' }} />

                {deviceNamesList.map((name, i) => {
                  const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                  return (
                    <Line
                      key={safeName}
                      type="monotone"
                      dataKey={`deviceHumidity.${safeName}`}
                      name={name}
                      stroke={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls
                    />
                  );
                })}
              </ComposedChart>
            </ResponsiveContainer>
          )}

          {/* 30-Day Mold Score Projection */}
          {chartView === 'forecast' && (
            <div className="space-y-3">
              <MoldScoreGuide currentMax={repeatPatternDay30} zoomMax={forecastDomainMax} maxLabel="30d projected score" />
              <p className="text-xs text-slate-500">
                This projection carries forward the recent temperature/RH pattern for 30 days, including humid spikes and dry-out periods. Threshold markers show where microscopic and visible mold would begin on the same score scale.
              </p>
              <div className="rounded-xl border border-cyan-400/15 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/70 leading-relaxed">
                Based on {formatHistoryWindow(observedDataWindowDays)} of sensor history, the recent pattern adds about {formatMoldScore(repeatPatternDailyChange)} score/day after dry-out. Day 30 projects to {formatMoldScore(repeatPatternDay30)} / 6.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <ScenarioValueCard
                  label="Projected day 30"
                  value={repeatPatternDay30}
                  color="#67e8f9"
                  description="Recent humid spikes and recovery repeated over 30 days."
                />
                <ProjectionMarkerCard
                  label="Microscopic marker"
                  threshold={1}
                  day={microscopicThresholdDay}
                  color="#fb923c"
                />
                <ProjectionMarkerCard
                  label="Visible mold marker"
                  threshold={3}
                  day={visibleThresholdDay}
                  color="#ef4444"
                />
              </div>

              {/* Scenario selector */}
              <div className="flex items-center gap-3 text-xs">
                <span className="text-slate-500">Line:</span>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-0.5 rounded-full bg-slate-200 inline-block" />
                  <span className="text-slate-600">Projected mold growth</span>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={360}>
                <LineChart data={analysis.forecast} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                  <XAxis
                    dataKey="day"
                    stroke="rgba(15,23,42,0.3)"
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 10 }}
                    tickFormatter={(d) => d === 0 ? 'Now' : `Day ${d}`}
                  />
                  <YAxis
                    stroke="rgba(15,23,42,0.3)"
                    tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                    domain={[0, forecastDomainMax]}
                  />

                  <ReferenceLine y={0.5} stroke="#84cc16" strokeDasharray="8 4" strokeOpacity={0.4}
                    label={{ value: '0.5 early risk', fill: '#84cc16', fontSize: 9, position: 'right' }} />
                  <ReferenceLine y={1} stroke="#f59e0b" strokeDasharray="8 4" strokeOpacity={0.55}
                    label={{ value: '1.0 microscopic', fill: '#f59e0b', fontSize: 9, position: 'right' }} />
                  <ReferenceLine y={3} stroke="#ef4444" strokeDasharray="8 4" strokeOpacity={0.55}
                    label={{ value: '3.0 visible', fill: '#ef4444', fontSize: 9, position: 'right' }} />
                  {microscopicThresholdDay != null && (
                    <ReferenceLine x={microscopicThresholdDay} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.5}
                      label={{ value: `Microscopic day ${microscopicThresholdDay}`, fill: '#f59e0b', fontSize: 9, position: 'top' }} />
                  )}
                  {visibleThresholdDay != null && (
                    <ReferenceLine x={visibleThresholdDay} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5}
                      label={{ value: `Visible day ${visibleThresholdDay}`, fill: '#ef4444', fontSize: 9, position: 'top' }} />
                  )}

                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const dayLabel = label === 0 ? 'Current' : `Day ${label}`;
                      const projectionEntries = payload.filter((e: any) => e.dataKey?.includes('deviceIndexRepeatPattern'));
                      return (
                        <div className="rounded-xl p-3 border border-slate-300" style={{
                          background: 'rgba(15, 23, 42, 0.95)',
                          backdropFilter: 'blur(12px)',
                          maxWidth: 320,
                        }}>
                          <p className="text-slate-600 text-xs mb-2">{dayLabel}</p>
                          {projectionEntries.map((entry: any, idx: number) => {
                            const deviceKey = (entry.dataKey as string).replace('deviceIndexRepeatPattern.', '');
                            const stressVal = (entry.payload as any)?.deviceIndexWorst?.[deviceKey];
                            const displayName = deviceKey.replace(/_/g, ' ');
                            return (
                              <div key={idx} className="mb-1.5 last:mb-0">
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: entry.color || entry.stroke }} />
                                  <span className="text-slate-600 truncate">{displayName}</span>
                                  <span className="text-slate-900 font-medium">{typeof entry.value === 'number' ? formatMoldScore(entry.value) : entry.value}</span>
                                </div>
                                <div className="ml-4 text-[10px] text-slate-400">
                                  Peak-RH stress test: {typeof stressVal === 'number' ? formatMoldScore(stressVal) : '—'}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ color: 'rgba(15,23,42,0.7)', fontSize: 11 }} iconType="circle" iconSize={8} />

                  {/* Per-device: recent pattern projection */}
                  {deviceNamesList.map((name, i) => {
                    const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                    return (
                      <Line
                        key={`projection_${safeName}`}
                        type="monotone"
                        dataKey={`deviceIndexRepeatPattern.${safeName}`}
                        name={`${name} projected`}
                        stroke={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                        strokeWidth={2.5}
                        dot={false}
                        activeDot={{ r: 4, fill: DEVICE_COLORS[i % DEVICE_COLORS.length] }}
                        connectNulls
                      />
                    );
                  })}

                </LineChart>
              </ResponsiveContainer>

              <div className="rounded-xl border border-orange-400/15 bg-orange-500/5 px-3 py-2 text-xs text-orange-100/70 leading-relaxed">
                Peak-RH stress test reaches {formatMoldScore(sustainedPeakProjectionMax)} / 6 only if the worst observed humidity stays on continuously. That is not what the sensors are currently doing.
              </div>

              {/* Projection insight callouts */}
              <div className="space-y-2">
                {analysis.rooms
                  .filter(r => r.currentGrowthIntensity > 0 || r.moldIndex >= 0.5)
                  .sort((a, b) => b.riskScore - a.riskScore)
                  .slice(0, 3)
                  .map(room => {
                    const isMicroscopic = room.moldIndex >= 1.0;
                    const isVisible = room.moldIndex >= 3.0;
                    const isActive = room.currentGrowthIntensity > 0;

                    return (
                      <div
                        key={room.deviceId}
                        className="p-3 rounded-xl text-xs flex items-start gap-2"
                        style={{
                          background: isVisible ? 'rgba(239,68,68,0.1)' :
                                     isMicroscopic ? 'rgba(249,115,22,0.08)' :
                                     isActive ? 'rgba(234,179,8,0.06)' : 'rgba(34,197,94,0.05)',
                          border: `1px solid ${isVisible ? 'rgba(239,68,68,0.25)' :
                                               isMicroscopic ? 'rgba(249,115,22,0.2)' :
                                               isActive ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.15)'}`,
                        }}
                      >
                        <span className="text-lg">
                          {isVisible ? '🚨' : isMicroscopic ? '🔬' : isActive ? '⚡' : '✅'}
                        </span>
                        <div className="flex-1">
                          <span className="text-slate-900 font-medium">{room.deviceName}</span>
                          {isVisible ? (
                            <span className="text-red-600 ml-1">
                              — visible mold detected (index {room.moldIndex.toFixed(2)}). Professional assessment recommended.
                            </span>
                          ) : isMicroscopic ? (
                            <span className="text-orange-600 ml-1">
                              — microscopic growth active (index {room.moldIndex.toFixed(2)}).
                              Conditions are favorable {Math.round(room.favorableDuty * 100)}% of the time.
                              {room.daysToVisible != null ? ` Visible mold in ~${room.daysToVisible} day${room.daysToVisible !== 1 ? 's' : ''} if unchecked.` : ''}
                            </span>
                          ) : isActive ? (
                            <span className="text-yellow-600 ml-1">
                              — growth conditions active now (intensity {Math.round(room.currentGrowthIntensity * 100)}%).
                              {room.daysToMicroscopic != null && room.daysToMicroscopic > 0
                                ? ` Microscopic mold in ~${room.daysToMicroscopic < 1 ? `${Math.round(room.daysToMicroscopic * 24)} hours` : `${room.daysToMicroscopic.toFixed(0)} days`} at current pace.`
                                : ' Currently below risk threshold.'}
                            </span>
                          ) : (
                            <span className="text-green-600 ml-1">
                              — index elevated ({room.moldIndex.toFixed(2)}) but conditions currently unfavorable. Index receding.
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                {/* If no rooms are at risk */}
                {analysis.rooms.every(r => r.currentGrowthIntensity === 0 && r.moldIndex < 0.5) && repeatPatternProjectionMax < 0.5 && (
                  <div className="p-3 rounded-xl text-xs flex items-start gap-2"
                    style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
                    <span className="text-lg">✅</span>
                    <div className="flex-1">
                      <span className="text-green-600">
                        All rooms show low mold risk. No rooms are currently in mold-favorable conditions.
                        The 30-day projection stays below the early-risk threshold. Peak-RH is shown only as a stress test.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Daily Humidity Profile */}
          {chartView === 'daily' && (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={analysis.dailyProfile} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                <XAxis
                  dataKey="hour"
                  stroke="rgba(15,23,42,0.3)"
                  tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                  tickFormatter={(h) => {
                    if (h === 0) return '12a';
                    if (h === 12) return '12p';
                    return h < 12 ? `${h}a` : `${h - 12}p`;
                  }}
                />
                <YAxis
                  stroke="rgba(15,23,42,0.3)"
                  tick={{ fill: 'rgba(15,23,42,0.5)', fontSize: 11 }}
                  domain={[0, 100]}
                  label={{ value: 'Avg %RH', position: 'insideLeft', style: { fill: 'rgba(15,23,42,0.4)' } }}
                />
                <Tooltip content={<HumidityTooltip />} />
                <Legend wrapperStyle={{ color: 'rgba(15,23,42,0.7)', fontSize: 12 }} iconType="circle" iconSize={8} />

                <ReferenceLine y={60} stroke="#22c55e" strokeDasharray="5 5" strokeOpacity={0.4}
                  label={{ value: 'Mold Risk', fill: '#22c55e', fontSize: 10, position: 'right' }} />

                {deviceNamesList.map((name, i) => {
                  const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
                  return (
                    <Bar
                      key={safeName}
                      dataKey={`deviceAvgHumidity.${safeName}`}
                      name={name}
                      fill={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                      opacity={0.7}
                      radius={[2, 2, 0, 0]}
                    />
                  );
                })}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* Humidity Health Index */}
      {analysis.humidityHealth.length > 0 && (
        <div className="rounded-xl p-5 border border-slate-200 bg-slate-50 space-y-4">
          <h5 className="text-slate-900 font-semibold flex items-center gap-2">
            <span>💧</span> Humidity Health Index & Condensation Risk
          </h5>
          <p className="text-slate-500 text-xs">
            Tracks humidity zones per room, dew point, condensation risk, and cumulative material damage from excess moisture exposure.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {analysis.humidityHealth.map((room) => {
              const zoneColors: Record<HumidityZone, string> = {
                too_dry: '#3b82f6',
                ideal: '#22c55e',
                elevated: '#eab308',
                risky: '#f97316',
                dangerous: '#ef4444',
              };
              const zoneLabels: Record<HumidityZone, string> = {
                too_dry: '🔵 Too Dry (<25%)',
                ideal: '🟢 Ideal (30-50%)',
                elevated: '🟡 Elevated (50-55%)',
                risky: '🟠 Risky (55-65%)',
                dangerous: '🔴 Dangerous (>65%)',
              };
              const zoneEmoji: Record<HumidityZone, string> = {
                too_dry: '🔵',
                ideal: '🟢',
                elevated: '🟡',
                risky: '🟠',
                dangerous: '🔴',
              };

              return (
                <div key={room.deviceId} className="rounded-xl p-4 border border-slate-200 bg-slate-50">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-slate-900 font-medium text-sm truncate">{room.deviceName}</span>
                    <span className="text-xs px-2 py-0.5 rounded-lg font-medium" style={{
                      color: zoneColors[room.currentZone],
                      background: `${zoneColors[room.currentZone]}15`,
                      border: `1px solid ${zoneColors[room.currentZone]}30`,
                    }}>
                      {zoneEmoji[room.currentZone]} {room.currentZone.replace('_', ' ')}
                    </span>
                  </div>

                  {/* Dew Point & Condensation */}
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="text-center p-2 rounded-lg bg-slate-50">
                      <div className="text-slate-500 text-[10px]">Dew Point</div>
                      <div className="text-slate-900 font-semibold text-sm">
                        {room.dewPointF?.toFixed(1) ?? '—'}°F
                      </div>
                    </div>
                    <div className={`text-center p-2 rounded-lg ${room.condensationRisk ? 'bg-blue-500/10 border border-blue-400/20' : 'bg-slate-50'}`}>
                      <div className="text-slate-500 text-[10px]">Condensation</div>
                      <div className={`font-semibold text-sm ${room.condensationRisk ? 'text-blue-600' : 'text-green-600'}`}>
                        {room.condensationRisk ? '⚠️ Risk' : '✅ OK'}
                      </div>
                    </div>
                  </div>

                  {/* Humidity Zone Breakdown Bar */}
                  <div className="mb-2">
                    <div className="text-slate-500 text-[10px] mb-1">Time in Zone</div>
                    <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
                      {(['too_dry', 'ideal', 'elevated', 'risky', 'dangerous'] as HumidityZone[]).map(zone => {
                        const pct = room.zoneBreakdown[zone];
                        if (pct <= 0) return null;
                        return (
                          <div
                            key={zone}
                            className="h-full rounded-sm transition-all"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: zoneColors[zone],
                              opacity: 0.7,
                            }}
                            title={`${zoneLabels[zone]}: ${pct}%`}
                          />
                        );
                      })}
                    </div>
                    <div className="flex justify-between mt-1 text-[9px] text-slate-400">
                      <span>🔵{room.zoneBreakdown.too_dry}%</span>
                      <span>🟢{room.zoneBreakdown.ideal}%</span>
                      <span>🟡{room.zoneBreakdown.elevated}%</span>
                      <span>🟠{room.zoneBreakdown.risky}%</span>
                      <span>🔴{room.zoneBreakdown.dangerous}%</span>
                    </div>
                  </div>

                  {/* Material Damage Score */}
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">Material Damage Score</span>
                    <span className={`font-medium ${
                      room.materialDamageScore > 500 ? 'text-red-600' :
                      room.materialDamageScore > 100 ? 'text-orange-600' :
                      room.materialDamageScore > 25 ? 'text-yellow-600' : 'text-green-600'
                    }`}>
                      {room.materialDamageScore.toFixed(1)}
                      <span className="text-slate-400 ml-1">({room.materialWeight}× {config.surfaceType.replace('_', ' ')})</span>
                    </span>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-slate-500">Paint & Drywall Impact</span>
                      <span className="text-slate-600 font-medium">
                        {costRange(room.materialImpact.totalEstimatedCostLow, room.materialImpact.totalEstimatedCostHigh)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <DamageEstimateCard label="Paint" estimate={room.materialImpact.paint} />
                      <DamageEstimateCard label="Drywall" estimate={room.materialImpact.drywall} />
                    </div>
                    <div className="text-[10px] text-slate-400 leading-relaxed">
                      Peak {room.materialImpact.peakHumidity.toFixed(0)}% RH · {room.materialImpact.elevatedHumidityHours.toFixed(1)}h above 55%
                      {room.materialImpact.condensationHours > 0 ? ` · ${room.materialImpact.condensationHours.toFixed(1)}h condensation risk` : ''}
                    </div>
                    {(room.materialImpact.paint.drivers.length > 0 || room.materialImpact.drywall.drivers.length > 0) && (
                      <div className="text-[10px] text-slate-400 leading-relaxed">
                        {room.materialImpact.paint.recommendation}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Paint & Drywall Damage Accumulation Chart */}
          {(() => {
            const allMaterialDamage: Array<MaterialDamagePoint & { deviceName: string }> = analysis.humidityHealth.flatMap(room =>
              room.materialDamageTimeSeries.map(pt => ({
                ...pt,
                deviceName: room.deviceName,
              }))
            );
            if (allMaterialDamage.length === 0) return null;

            const timeMap = new Map<number, any>();
            for (const pt of allMaterialDamage) {
              const safeName = pt.deviceName.replace(/[^a-zA-Z0-9]/g, '_');
              const existing = timeMap.get(pt.timestamp) || { timestamp: pt.timestamp, time: pt.time };
              existing[`paint_${safeName}`] = pt.paintScore;
              existing[`drywall_${safeName}`] = pt.drywallScore;
              existing[`humidity_${safeName}`] = pt.humidity;
              existing[`dew_${safeName}`] = pt.dewPointF;
              timeMap.set(pt.timestamp, existing);
            }
            const chartData = Array.from(timeMap.values()).sort((a, b) => a.timestamp - b.timestamp);
            const roomNames = [...new Set(analysis.humidityHealth.map(r => r.deviceName.replace(/[^a-zA-Z0-9]/g, '_')))];
            const earliestPaintSignificant = earliestMaterialThreshold(analysis.humidityHealth, 'paint', 'moderate');
            const earliestDrywallSignificant = earliestMaterialThreshold(analysis.humidityHealth, 'drywall', 'moderate');
            const maxMaterialDamageIndex = allMaterialDamage.reduce(
              (max, pt) => Math.max(max, pt.paintScore, pt.drywallScore),
              0,
            );

            return (
              <div className="mt-4">
                <h6 className="text-slate-600 text-xs font-medium mb-2">Paint & Drywall Damage Index Over Time</h6>
                <p className="text-slate-400 text-[10px] mb-1 leading-relaxed">
                  EPA guidance keeps indoor RH below 60% and ideally 30-50%, and damp materials should be dried within 24-48 hours. This screening score climbs faster when readings spend time above 55/65/70% RH and when dew point rises above an estimated cold-surface temperature, because repeated surface condensation is what usually starts paint failure and drywall paper wetting.
                </p>
                <p className="text-slate-400 text-[10px] mb-3 leading-relaxed">
                  Timing cards below assume the recent accumulation rate repeats. Treat them as inspection forecasts, not guaranteed failure dates.
                </p>
                <MaterialDamageGuide currentMax={maxMaterialDamageIndex} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                  <MaterialProjectionCard
                    label="Earliest significant paint risk"
                    material="paint"
                    projection={earliestPaintSignificant}
                    color="#f59e0b"
                  />
                  <MaterialProjectionCard
                    label="Earliest significant drywall risk"
                    material="drywall"
                    projection={earliestDrywallSignificant}
                    color="#f97316"
                  />
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartData} margin={{ top: 8, right: 20, left: 12, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                    <XAxis dataKey="time" tick={{ fill: 'rgba(15,23,42,0.3)', fontSize: 10 }} />
                    <YAxis
                      domain={[0, (dataMax: number) => Math.min(100, Math.max(15, Math.ceil((dataMax || 0) + 5)))]}
                      tick={{ fill: 'rgba(15,23,42,0.3)', fontSize: 10 }}
                      label={{ value: 'Damage index', angle: -90, position: 'insideLeft', fill: 'rgba(15,23,42,0.38)', fontSize: 10, dx: -6 }}
                    />
                    <Tooltip content={<MaterialDamageTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <ReferenceLine y={10} stroke="#eab308" strokeDasharray="5 5" strokeOpacity={0.35}
                      label={{ value: '10 inspect', fill: '#eab308', fontSize: 9, position: 'right' }} />
                    <ReferenceLine y={30} stroke="#f97316" strokeDasharray="5 5" strokeOpacity={0.4}
                      label={{ value: '30 significant', fill: '#f97316', fontSize: 9, position: 'right' }} />
                    <ReferenceLine y={65} stroke="#ef4444" strokeDasharray="5 5" strokeOpacity={0.45}
                      label={{ value: '65 high repair', fill: '#ef4444', fontSize: 9, position: 'right' }} />
                    {roomNames.map((name, idx) => (
                      <Line
                        key={`paint_${name}`}
                        dataKey={`paint_${name}`}
                        name={`${name.replace(/_/g, ' ')} paint`}
                        stroke={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    ))}
                    {roomNames.map((name, idx) => (
                      <Line
                        key={`drywall_${name}`}
                        dataKey={`drywall_${name}`}
                        name={`${name.replace(/_/g, ' ')} drywall`}
                        stroke={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                        strokeWidth={1.5}
                        strokeDasharray="5 4"
                        strokeOpacity={0.75}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })()}

          {/* Condensation Risk Time-Series Chart */}
          {(() => {
            // Aggregate condensation time-series from all rooms
            const allCondensation = analysis.humidityHealth.flatMap(room =>
              room.condensationTimeSeries.map(pt => ({
                ...pt,
                deviceName: room.deviceName,
              }))
            );
            if (allCondensation.length === 0) return null;

            // Build merged timeline (keyed by timestamp)
            const timeMap = new Map<number, any>();
            for (const pt of allCondensation) {
              const safeName = pt.deviceName.replace(/[^a-zA-Z0-9]/g, '_');
              const existing = timeMap.get(pt.timestamp) || { timestamp: pt.timestamp, time: pt.time, coldSurface: pt.outsideTempF };
              existing[`dew_${safeName}`] = pt.indoorDewPointF;
              existing.coldSurface = pt.outsideTempF;
              if (pt.condensationRisk) existing.riskMarker = Math.max(existing.riskMarker || 0, pt.indoorDewPointF);
              timeMap.set(pt.timestamp, existing);
            }
            const chartData = Array.from(timeMap.values()).sort((a, b) => a.timestamp - b.timestamp);
            const roomNames = [...new Set(analysis.humidityHealth.map(r => r.deviceName.replace(/[^a-zA-Z0-9]/g, '_')))];

            return (
              <div className="mt-4">
                <h6 className="text-slate-600 text-xs font-medium mb-2">🌡️ Dew Point vs Cold Surface Temperature</h6>
                <p className="text-slate-400 text-[10px] mb-2">
                  When indoor dew point rises above the cold surface temperature (outside temp + 10°F), condensation forms on windows and walls.
                </p>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                    <XAxis dataKey="time" tick={{ fill: 'rgba(15,23,42,0.3)', fontSize: 10 }} />
                    <YAxis tick={{ fill: 'rgba(15,23,42,0.3)', fontSize: 10 }} unit="°F" />
                    <Tooltip
                      contentStyle={{ background: '#ffffff', border: '1px solid rgba(15,23,42,0.1)', borderRadius: 8 }}
                      labelStyle={{ color: 'rgba(15,23,42,0.5)' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {/* Cold surface temperature line */}
                    <Line
                      dataKey="coldSurface"
                      name="Cold Surface"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                      dot={false}
                    />
                    {/* Per-room dew point lines */}
                    {roomNames.map((name, idx) => (
                      <Line
                        key={name}
                        dataKey={`dew_${name}`}
                        name={`${name.replace(/_/g, ' ')} Dew Pt`}
                        stroke={DEVICE_COLORS[idx % DEVICE_COLORS.length]}
                        strokeWidth={1.5}
                        dot={false}
                      />
                    ))}
                    {/* Risk marker area: shade where condensation is occurring */}
                    <Area
                      dataKey="riskMarker"
                      name="Condensation Zone"
                      fill="#3b82f6"
                      fillOpacity={0.15}
                      stroke="none"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            );
          })()}
        </div>
      )}

      {/* Ventilation Adequacy Score */}
      {analysis.ventilation.length > 0 && (
        <div className="rounded-xl p-5 border border-slate-200 bg-slate-50 space-y-4">
          <h5 className="text-slate-900 font-semibold flex items-center gap-2">
            <span>📈</span> Ventilation Adequacy Score
          </h5>
          <p className="text-slate-500 text-xs">
            Measures how quickly humidity spikes (showers, cooking) dissipate. Good ventilation recovers within 30–45 min. 
            Based on ASHRAE 62.2 residential ventilation standards.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {analysis.ventilation.map((room) => {
              const gradeConfig: Record<VentilationGrade, { color: string; label: string; icon: string }> = {
                good: { color: '#22c55e', label: 'Good', icon: '✅' },
                moderate: { color: '#eab308', label: 'Moderate', icon: '🟡' },
                poor: { color: '#ef4444', label: 'Poor', icon: '🔴' },
              };
              const gc = gradeConfig[room.grade];

              return (
                <div key={room.deviceId} className="rounded-xl p-4 border border-slate-200 bg-slate-50">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-slate-900 font-medium text-sm truncate">{room.deviceName}</span>
                    <span className="text-xs px-2 py-0.5 rounded-lg font-medium" style={{
                      color: gc.color,
                      background: `${gc.color}15`,
                      border: `1px solid ${gc.color}30`,
                    }}>
                      {gc.icon} {gc.label}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center mb-3">
                    <div className="p-2 rounded-lg bg-slate-50">
                      <div className="text-slate-500 text-[10px]">Avg Recovery</div>
                      <div className={`font-semibold text-sm ${
                        room.avgRecoveryMinutes != null && room.avgRecoveryMinutes <= 45 ? 'text-green-600' :
                        room.avgRecoveryMinutes != null && room.avgRecoveryMinutes <= 90 ? 'text-yellow-600' : 'text-red-600'
                      }`}>
                        {room.avgRecoveryMinutes != null ? `${room.avgRecoveryMinutes}m` : '—'}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-slate-50">
                      <div className="text-slate-500 text-[10px]">Est. ACH</div>
                      <div className="text-slate-900 font-semibold text-sm">
                        {room.estimatedACH?.toFixed(1) ?? '—'}
                      </div>
                    </div>
                    <div className="p-2 rounded-lg bg-slate-50">
                      <div className="text-slate-500 text-[10px]">Spikes Found</div>
                      <div className="text-slate-900 font-semibold text-sm">
                        {room.spikes.length}
                      </div>
                    </div>
                  </div>

                  {/* Expected vs actual recovery */}
                  {room.avgRecoveryMinutes != null && (
                    <div className="text-xs mb-2">
                      <div className="flex justify-between text-slate-500 mb-1">
                        <span>Recovery vs Expected ({room.expectedRecoveryMinutes}m)</span>
                        <span className={
                          room.avgRecoveryMinutes <= room.expectedRecoveryMinutes ? 'text-green-600' : 'text-red-600'
                        }>
                          {room.avgRecoveryMinutes <= room.expectedRecoveryMinutes ? '✓ On Target' : '✗ Slow'}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-50 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, (room.expectedRecoveryMinutes / Math.max(1, room.avgRecoveryMinutes)) * 100)}%`,
                            backgroundColor: room.avgRecoveryMinutes <= room.expectedRecoveryMinutes ? '#22c55e' : '#ef4444',
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Spike list (last 3) */}
                  {room.spikes.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-slate-500 text-[10px]">Recent Spikes</div>
                      {room.spikes.slice(-3).reverse().map((spike, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-[10px]">
                          <span className="text-slate-400">{new Date(spike.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          <span className="text-slate-500">Peak {spike.peakHumidity.toFixed(0)}%</span>
                          <span className={spike.recoveryOk ? 'text-green-600' : 'text-red-600'}>
                            {spike.recoveryMinutes != null ? `${spike.recoveryMinutes}m recovery` : 'No recovery'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {room.spikes.length === 0 && (
                    <div className="text-slate-400 text-[10px] text-center py-2">
                      No humidity spikes detected in this period
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Ventilation Recovery Time-Series Chart */}
          {(() => {
            // Build scatter data: each spike becomes a point with timestamp + recovery time
            const scatterData: { time: string; timestamp: number; recovery: number; peak: number; deviceName: string; ok: boolean }[] = [];
            for (const room of analysis.ventilation) {
              for (const spike of room.spikes) {
                if (spike.recoveryMinutes != null) {
                  scatterData.push({
                    time: new Date(spike.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                    timestamp: spike.startTime,
                    recovery: spike.recoveryMinutes,
                    peak: spike.peakHumidity,
                    deviceName: room.deviceName,
                    ok: spike.recoveryOk,
                  });
                }
              }
            }
            if (scatterData.length < 2) return null;
            scatterData.sort((a, b) => a.timestamp - b.timestamp);

            return (
              <div className="mt-4">
                <h6 className="text-slate-600 text-xs font-medium mb-2">⏱️ Recovery Time Trend</h6>
                <p className="text-slate-400 text-[10px] mb-2">
                  Each dot is a humidity spike event. Green = recovered within target, red = slow recovery. Increasing recovery times may indicate degrading ventilation.
                </p>
                <ResponsiveContainer width="100%" height={180}>
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                    <XAxis dataKey="time" tick={{ fill: 'rgba(15,23,42,0.3)', fontSize: 9 }} />
                    <YAxis
                      dataKey="recovery"
                      tick={{ fill: 'rgba(15,23,42,0.3)', fontSize: 10 }}
                      label={{ value: 'Recovery (min)', angle: -90, position: 'insideLeft', fill: 'rgba(15,23,42,0.3)', fontSize: 10 }}
                    />
                    <Tooltip
                      contentStyle={{ background: '#ffffff', border: '1px solid rgba(15,23,42,0.1)', borderRadius: 8 }}
                      formatter={(value: any, name?: string) => {
                        if (name === 'recovery') return [`${value} min`, 'Recovery'];
                        return [value, name ?? ''];
                      }}
                      labelFormatter={(label) => label}
                    />
                    <ReferenceLine y={45} stroke="#22c55e" strokeDasharray="6 3" label={{ value: '45m target', fill: '#22c55e', fontSize: 9, position: 'right' }} />
                    <Scatter data={scatterData} name="Recovery">
                      {scatterData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.ok ? '#22c55e' : '#ef4444'} opacity={0.75} r={5} />
                      ))}
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            );
          })()}
        </div>
      )}

      {/* Methodology */}
      <div className="rounded-xl p-4 border border-slate-200 bg-slate-50">
        <details>
          <summary className="text-slate-500 text-xs cursor-pointer hover:text-slate-700 select-none">
            ℹ️ How the mold growth model works
          </summary>
          <div className="text-slate-400 text-xs mt-3 space-y-2 leading-relaxed">
            <p>
              <strong className="text-slate-500">VTT Mold Growth Model:</strong> Based on research by Hukka & Viitanen (VTT
              Technical Research Centre of Finland), mold growth is modeled as a cumulative index (0–6) that advances when
              both temperature and humidity exceed critical thresholds simultaneously, and recedes (slowly) when conditions
              dry out. Growth rates and critical RH thresholds are calibrated to EPA residential guidance: mold begins at
              55–60% RH, and can develop within 24–48 hours above 70% RH.
            </p>
            <p>
              <strong className="text-slate-500">Critical RH Curve:</strong> The minimum humidity needed for mold growth varies
              with temperature. At optimal mold temps (77–86°F), critical RH is ~55% (EPA). At typical room temps (65–75°F),
              critical RH is ~58–62%. At cooler temps (50°F), mold needs ~75% RH. Below 41°F, mold growth essentially stops.
            </p>
            <p>
              <strong className="text-slate-500">Shower/Spike Responsiveness:</strong> Unlike simple threshold models, this system
              captures partial growth from short humidity events (showers, cooking). Spores absorb moisture even during brief 
              spikes — repeated wetting events accumulate per Johansson et al. (2012). If total wet time exceeds ~4 hours in 
              a 24-hour window, full germination activates even without continuous exposure.
            </p>
            <p>
              <strong className="text-slate-500">Hours Until Mold:</strong> When current humidity exceeds critical RH, we calculate
              how many hours until each growth milestone assuming conditions are sustained. This accounts for the germination
              delay, partial growth during initial wetting, and the surface sensitivity of your wall material.
            </p>
            <p>
              <strong className="text-slate-500">Humidity Health Index:</strong> Tracks dew point per room (Magnus formula),
              condensation risk, and time spent in each humidity zone (Too Dry &lt;25%, Ideal 30–50%, Elevated 50–55%, 
              Risky 55–65%, Dangerous &gt;65%). Per EPA, keep RH between 30–50% to prevent mold. Material damage score
              accumulates based on exposure above 55% RH weighted by surface type (1.3× for hardwood, 0.3× for tile),
              then maps that exposure into conservative paint and drywall inspection/repair ranges. The paint/drywall chart
              accumulates a separate 0–100 inspection-priority score from RH, room temperature, computed dew point, and
              whether dew point exceeds the estimated cold surface temperature.
            </p>
            <p>
              <strong className="text-slate-500">Ventilation Score:</strong> Detects humidity spikes (&gt;10% RH rise in &lt;30 min)
              and measures recovery time. Good ventilation recovers in &lt;45 min (ASHRAE 62.2). Air changes per hour (ACH)
              estimated from humidity decay rate. Bathrooms should recover in ~30 min; if slower, exhaust fan may be broken.
            </p>
            <p>
              <strong className="text-slate-500">Surface Sensitivity:</strong> Bare paper-faced drywall grows mold ~40% faster
              than painted surfaces. Tile is ~70% more resistant. The model adjusts growth rate by material type.
            </p>
          </div>
        </details>
      </div>
    </div>
  );
};

export default MoldGrowthPredictor;
