/**
 * EnvironmentalAnalytics — the consolidated Analytics tab for Predictive
 * Maintenance.
 *
 * Design: ONE central temperature + humidity chart, with the risk models
 * rendered as selectable analytics layers on top of it instead of separate
 * stacked modules:
 *
 *   - Conditions  — property-wide overview: every room's humidity + temperature.
 *   - Mold        — emphasizes humidity; green gradient bands mark every
 *                   period the room sat in the mold-growth zone (≥60% RH).
 *   - Freeze      — emphasizes temperature; blue freeze band, outside
 *                   temperature + forecast line, and the projected room
 *                   temperature curve (Newton's-law model from
 *                   freezeForecastService).
 *   - Insulation  — all rooms' temperature lines against the house median,
 *                   with per-room letter grades.
 *   - Weather     — outdoor extreme-weather assessment (shared with the
 *                   live property twin): forecast temp / RH / wind / precip.
 *
 * Each layer has a one-line readout strip (level chip + headline + action)
 * replacing the old three risk cards, and an "AI analysis" button opens a
 * side rail (SensorInsightsPanel) with an AI overview + follow-up Q&A,
 * mirroring the document/tax audit pattern.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { Sparkles } from 'lucide-react';

/** Small static dot, or a pulsing ring on the newest non-null point in a series. */
function ConditionsSeriesDot(props: {
  cx?: number;
  cy?: number;
  stroke?: string;
  fill?: string;
  index?: number;
  dataKey?: string;
  payload?: Record<string, number | null>;
  latestIndexByKey?: Record<string, number>;
}): ReactElement | null {
  const { cx, cy, stroke, fill, index, dataKey, payload, latestIndexByKey } = props;
  if (cx == null || cy == null || dataKey == null || index == null) return null;
  const value = payload?.[dataKey];
  if (value == null || Number.isNaN(Number(value))) return null;

  const color = stroke || fill || '#64748b';
  const isLatest = latestIndexByKey?.[dataKey] === index;
  // Only mark the newest sample — intermediate dots make dense 1‑min series look bold.
  if (!isLatest) return null;

  return (
    <g>
      <circle cx={cx} cy={cy} r={4} fill="none" stroke={color} strokeWidth={1} opacity={0.35}>
        <animate attributeName="r" values="3;5.5;3" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.45;0;0.45" dur="2s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx} cy={cy} r={2.5} fill={color} stroke="none" />
    </g>
  );
}
import type { ShellyDevice, SensorReading, ArchivedShellyDevice } from '../hooks/useShellyFirestore';
import {
  analyzeFreezeForecast,
  fetchWeatherForecast,
  DEFAULT_FREEZE_CONFIG,
  interpolateOutsideTemp,
  type ForecastPoint,
  type FreezeForecastResult,
  type RoomFreezeProfile,
} from '../services/freezeForecastService';
import {
  analyzeMoldGrowth,
  DEFAULT_MOLD_CONFIG,
  type MoldGrowthAnalysisResult,
  type MoldGrowthRoomProfile,
} from '../services/moldGrowthService';
import {
  analyzeThermalLeaks,
  getInsulationRecommendation,
  DEFAULT_THERMAL_CONFIG,
  type ThermalLeakAnalysisResult,
} from '../services/thermalLeakService';
import { SubTabs } from '../design-system';
import SensorInsightsPanel from './SensorInsightsPanel';
import {
  fetchPropertyWeatherAssessment,
  weatherRiskLabel,
  type ExtremeWeatherAssessment,
} from '../services/propertyWeatherClient';

// ─── Thresholds (single source for this view) ────────────────────────────────

const MOLD_ZONE_RH = 60; // EPA: mold spores germinate at/above 60% RH
const FREEZE_WARN_F = 38;
const FREEZE_CRIT_F = 32;
/** Monotone cubic — smooth corners without overshooting past the axis bounds
 *  (Recharts `natural` splines routinely shoot past the last X/Y sample). */
const CLIMATE_LINE_CURVE = 'monotone' as const;

type RiskLevel = 'low' | 'watch' | 'high';
type Layer = 'conditions' | 'mold' | 'freeze' | 'insulation' | 'weather';
type ChartRange = '24h' | '7d' | '30d';

function weatherRiskToLevel(risk: ExtremeWeatherAssessment['overallRisk'] | undefined): RiskLevel {
  if (risk === 'critical' || risk === 'high') return 'high';
  if (risk === 'moderate' || risk === 'low') return 'watch';
  return 'low';
}

const RANGE_MS: Record<ChartRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const ROOM_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#f43f5e', '#84cc16'];

interface PropertyRef {
  id: string;
  address: string;
  propertyData?: {
    summary?: {
      latitude?: number;
      longitude?: number;
    };
  };
}

interface EnvironmentalAnalyticsProps {
  devices: ShellyDevice[];
  archivedDevices?: ArchivedShellyDevice[];
  readings: SensorReading[];
  properties: PropertyRef[];
  selectedProperty: string;
  initialLayer?: Layer;
  onLayerChange?: (layer: Layer) => void;
}

// ─── Simple, explainable per-room stats ──────────────────────────────────────

function tempF(reading: { temperature?: number }): number | null {
  return reading.temperature != null ? (reading.temperature * 9) / 5 + 32 : null;
}

/** Match blu-ht-* ↔ shellyhtg3-* (and bare MAC) so chart joins don't miss live H&T docs. */
function getDeviceIdAliases(deviceId: string | null | undefined): string[] {
  const raw = String(deviceId || '').trim();
  if (!raw) return [];
  const normalized = raw.replace(/:/g, '').toLowerCase();
  const aliases = new Set([raw, normalized]);
  if (normalized.startsWith('blu-ht-')) {
    aliases.add(`shellyhtg3-${normalized.slice('blu-ht-'.length)}`);
  } else if (normalized.startsWith('shellyhtg3-')) {
    aliases.add(`blu-ht-${normalized.slice('shellyhtg3-'.length)}`);
  } else if (/^[a-f0-9]{8,}$/i.test(normalized)) {
    aliases.add(`blu-ht-${normalized}`);
    aliases.add(`shellyhtg3-${normalized}`);
  }
  return Array.from(aliases).filter(Boolean);
}

function readingMatchesDevice(readingDeviceId: string, device: ShellyDevice): boolean {
  const readingIds = new Set(getDeviceIdAliases(readingDeviceId));
  return getDeviceIdAliases(device.deviceId).some((id) => readingIds.has(id))
    || getDeviceIdAliases(device.id).some((id) => readingIds.has(id));
}

/** Prefer human room labels over raw Shelly device IDs in UI copy. */
function displayRoomName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /^unknown device$/i.test(trimmed)) return 'Unnamed sensor';
  if (/^(shelly|blu-ht-|shellyht)/i.test(trimmed)) return 'Unnamed sensor';
  if (/^[a-f0-9-]{8,}$/i.test(trimmed)) return 'Unnamed sensor';
  return trimmed
    .replace(/^H&T Sensor\s*-\s*/i, '')
    .replace(/^BLU H&T\s*/i, 'BLU ')
    .trim();
}

function climateDeviceMac(deviceId: string | null | undefined): string | null {
  const id = String(deviceId || '').replace(/:/g, '').toLowerCase();
  if (id.startsWith('blu-ht-')) return id.slice('blu-ht-'.length) || null;
  if (id.startsWith('shellyhtg3-')) return id.slice('shellyhtg3-'.length) || null;
  return null;
}

function isProbeOrTestClimateDevice(device: ShellyDevice): boolean {
  const id = String(device.deviceId || device.id || '').toLowerCase();
  const name = String(device.name || '').toLowerCase();
  return id.includes('probe') || name.includes('probe') || id.includes('blu-ht-test');
}

function isFloodOrLeakDevice(device: ShellyDevice): boolean {
  const type = String(device.type || '').toLowerCase();
  const id = String(device.deviceId || device.id || '').toLowerCase();
  const name = String(device.name || '').toLowerCase();
  const caps = (device.capabilities || []).map((c) => String(c).toLowerCase());
  return (
    type.includes('flood')
    || type.includes('water_leak')
    || type.includes('leak')
    || id.includes('flood')
    || id.includes('waterleak')
    || name.includes('flood')
    || name.includes('leak sensor')
    || caps.includes('flood')
    || caps.includes('water_leak')
  );
}

/** H&T / climate rooms only — never flood, relays, or gateways. */
function isChartableClimateDevice(device: ShellyDevice): boolean {
  if (isFloodOrLeakDevice(device) || isProbeOrTestClimateDevice(device)) return false;
  const type = String(device.type || '').toLowerCase();
  const id = String(device.deviceId || device.id || '').toLowerCase();
  if (type === 'relay_controller' || type === 'ble_gateway') return false;
  if (id.includes('1g4') || id.includes('blugw')) return false;
  return (
    type.includes('humidity')
    || type === 'temperature_humidity'
    || type === 'temperature'
    || id.includes('blu-ht')
    || id.includes('shellyht')
    || (device.humidity != null && device.temperature != null)
  );
}

/** Evenly spaced bucket timestamps so null cells become real chart gaps. */
function buildBucketTimeGrid(windowStart: number, windowEnd: number, bucketMs: number): number[] {
  const start = Math.floor(windowStart / bucketMs) * bucketMs;
  const times: number[] = [];
  for (let t = start; t <= windowEnd; t += bucketMs) times.push(t);
  return times;
}

/**
 * Bridge short holes in `sourceKey` (keeps the solid line continuous while
 * sensors are online) and write a separate linear estimate into `fillKey`
 * across long outages so the trend stays visible as a faint dashed line.
 */
function applyClimateGapFills(
  rows: Array<Record<string, number | null>>,
  sourceKey: string,
  fillKey: string,
  outageGapMs: number,
): void {
  const samples: Array<{ index: number; time: number; value: number }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const value = rows[i][sourceKey];
    if (typeof value === 'number' && Number.isFinite(value)) {
      samples.push({ index: i, time: rows[i].time as number, value });
    }
    rows[i][fillKey] = null;
  }

  for (let s = 0; s < samples.length - 1; s += 1) {
    const left = samples[s];
    const right = samples[s + 1];
    const gapMs = right.time - left.time;
    if (gapMs <= outageGapMs) {
      // Minor missing buckets while collection is healthy — stitch the real series.
      for (let i = left.index + 1; i < right.index; i += 1) {
        if (rows[i][sourceKey] != null) continue;
        const t = rows[i].time as number;
        const frac = (t - left.time) / gapMs;
        rows[i][sourceKey] = Math.round((left.value + (right.value - left.value) * frac) * 10) / 10;
      }
      continue;
    }

    // Long outage — leave the real series broken; draw an estimate on fillKey.
    for (let i = left.index; i <= right.index; i += 1) {
      const t = rows[i].time as number;
      const frac = (t - left.time) / gapMs;
      rows[i][fillKey] = Math.round((left.value + (right.value - left.value) * frac) * 10) / 10;
    }
  }
}

/** Max age of last indoor reading before freeze projections are suppressed. */
const FREEZE_PROJECTION_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * One series per physical H&T: prefer named blu-ht-* on a property over
 * shellyhtg3-* aliases / probe leftovers that otherwise show as "Unknown Device".
 */
function pickCanonicalClimateDevices(devices: ShellyDevice[]): ShellyDevice[] {
  const byKey = new Map<string, ShellyDevice>();

  const score = (device: ShellyDevice) => {
    const id = String(device.deviceId || device.id || '').toLowerCase();
    let value = 0;
    if (device.propertyId) value += 8;
    if (device.name && !/^(unknown device|unnamed|shelly|blu-ht-)/i.test(device.name.trim())) value += 4;
    if (id.startsWith('blu-ht-')) value += 2;
    if (id.startsWith('shellyhtg3-')) value -= 2;
    if (isProbeOrTestClimateDevice(device)) value -= 20;
    return value;
  };

  for (const device of devices) {
    if (isProbeOrTestClimateDevice(device)) continue;
    const id = String(device.deviceId || device.id || '');
    const mac = climateDeviceMac(id);
    const key = mac || id.toLowerCase();
    const existing = byKey.get(key);
    if (!existing || score(device) > score(existing)) {
      byKey.set(key, device);
    }
  }

  return [...byKey.values()];
}

interface RoomStats {
  deviceId: string;
  name: string;
  /** % of humidity readings in the last 7 days at/above the mold zone. */
  moldZonePercent7d: number | null;
  currentHumidity: number | null;
  /** Lowest °F reading in the last 48 hours. */
  minTempF48h: number | null;
  currentTempF: number | null;
  /** Average °F over the last 24 hours (for insulation grading). */
  avgTempF24h: number | null;
}

function computeRoomStats(devices: ShellyDevice[], readings: SensorReading[]): RoomStats[] {
  const now = Date.now();
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
  const cutoff48h = now - 48 * 60 * 60 * 1000;
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  return devices
    .filter((device) => device.temperature != null || device.humidity != null)
    .map((device) => {
      const deviceReadings = readings.filter((r) => readingMatchesDevice(r.deviceId, device));

      const humidity7d = deviceReadings.filter((r) => r.humidity != null && r.timestamp.getTime() >= cutoff7d);
      const inZone = humidity7d.filter((r) => (r.humidity as number) >= MOLD_ZONE_RH).length;
      const moldZonePercent7d = humidity7d.length >= 3 ? (inZone / humidity7d.length) * 100 : null;

      const temps48h = deviceReadings
        .filter((r) => r.temperature != null && r.timestamp.getTime() >= cutoff48h)
        .map((r) => tempF(r) as number);
      const currentDeviceTempF = device.temperatureF ?? (device.temperature != null ? (device.temperature * 9) / 5 + 32 : null);
      if (currentDeviceTempF != null) temps48h.push(currentDeviceTempF);
      const minTempF48h = temps48h.length > 0 ? Math.min(...temps48h) : null;

      const temps24h = deviceReadings
        .filter((r) => r.temperature != null && r.timestamp.getTime() >= cutoff24h)
        .map((r) => tempF(r) as number);
      const avgTempF24h = temps24h.length >= 3
        ? temps24h.reduce((sum, value) => sum + value, 0) / temps24h.length
        : null;

      return {
        deviceId: device.deviceId,
        name: displayRoomName(device.name),
        moldZonePercent7d,
        currentHumidity: device.humidity ?? null,
        minTempF48h,
        currentTempF: currentDeviceTempF,
        avgTempF24h,
      };
    });
}

// ─── Risk assessments (one sentence each) ────────────────────────────────────

interface RiskAssessment {
  level: RiskLevel;
  room: string | null;
  headline: string;
  action: string;
}

function assessMold(rooms: RoomStats[]): RiskAssessment {
  const withData = rooms.filter((room) => room.moldZonePercent7d != null || room.currentHumidity != null);
  if (withData.length === 0) {
    return { level: 'low', room: null, headline: 'No humidity data yet.', action: 'Add an H&T sensor to monitor mold conditions.' };
  }

  const worst = [...withData].sort((a, b) => (b.moldZonePercent7d ?? 0) - (a.moldZonePercent7d ?? 0))[0];
  const percent = worst.moldZonePercent7d ?? 0;
  const currentlyInZone = (worst.currentHumidity ?? 0) >= MOLD_ZONE_RH;

  if (percent >= 25 || (worst.currentHumidity ?? 0) >= 70) {
    return {
      level: 'high',
      room: worst.name,
      headline: `${worst.name} spent ${Math.round(percent)}% of the last week in the mold zone (≥${MOLD_ZONE_RH}% RH).`,
      action: 'Run the exhaust fan or add a dehumidifier in this room now.',
    };
  }
  if (percent >= 10 || currentlyInZone) {
    return {
      level: 'watch',
      room: worst.name,
      headline: `${worst.name} touched the mold zone ${Math.round(percent)}% of the last week${currentlyInZone ? ' and is in it right now' : ''}.`,
      action: 'Improve ventilation after showers/cooking and re-check in a few days.',
    };
  }
  return {
    level: 'low',
    room: null,
    headline: 'All rooms stayed below the mold-growth humidity zone this week.',
    action: 'No action needed.',
  };
}

function assessFreeze(rooms: RoomStats[]): RiskAssessment {
  const withData = rooms.filter((room) => room.minTempF48h != null);
  if (withData.length === 0) {
    return { level: 'low', room: null, headline: 'No temperature data yet.', action: 'Add a temperature sensor near plumbing to monitor freeze risk.' };
  }

  const worst = [...withData].sort((a, b) => (a.minTempF48h as number) - (b.minTempF48h as number))[0];
  const min = worst.minTempF48h as number;

  if (min <= FREEZE_CRIT_F + 3) {
    return {
      level: 'high',
      room: worst.name,
      headline: `${worst.name} dropped to ${min.toFixed(0)}°F in the last 48 hours — pipes can freeze at 32°F.`,
      action: 'Keep heat on, open cabinet doors near pipes, and let faucets drip tonight.',
    };
  }
  if (min <= FREEZE_WARN_F + 7) {
    return {
      level: 'watch',
      room: worst.name,
      headline: `${worst.name} got down to ${min.toFixed(0)}°F in the last 48 hours.`,
      action: 'Keep thermostats at 55°F or higher, especially overnight.',
    };
  }
  return {
    level: 'low',
    room: null,
    headline: `Lowest reading in the last 48 hours was ${min.toFixed(0)}°F — well clear of freezing.`,
    action: 'No action needed.',
  };
}

/** Letter grade from |deviation| of a room's 24h average vs the house median. */
function insulationGrade(deviationF: number): string {
  const d = Math.abs(deviationF);
  if (d <= 3) return 'A';
  if (d <= 6) return 'B';
  if (d <= 10) return 'C';
  if (d <= 15) return 'D';
  return 'F';
}

function gradeTone(grade: string): string {
  if (grade === 'A') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (grade === 'B') return 'bg-emerald-50 text-emerald-600 border-emerald-200';
  if (grade === 'C') return 'bg-amber-100 text-amber-700 border-amber-200';
  if (grade === 'D') return 'bg-orange-100 text-orange-700 border-orange-200';
  return 'bg-rose-100 text-rose-700 border-rose-200';
}

interface InsulationResult extends RiskAssessment {
  grades: Array<{ name: string; grade: string; deviationF: number }>;
}

function assessInsulation(rooms: RoomStats[]): InsulationResult {
  const withData = rooms.filter((room) => room.avgTempF24h != null);
  if (withData.length < 2) {
    return {
      level: 'low', room: null, grades: [],
      headline: 'Need 2+ rooms with temperature data to compare insulation.',
      action: 'Add temperature sensors in more rooms.',
    };
  }

  const temps = withData.map((room) => room.avgTempF24h as number).sort((a, b) => a - b);
  const median = temps[Math.floor(temps.length / 2)];

  const grades = withData
    .map((room) => {
      const deviationF = (room.avgTempF24h as number) - median;
      return { name: room.name, grade: insulationGrade(deviationF), deviationF };
    })
    .sort((a, b) => Math.abs(b.deviationF) - Math.abs(a.deviationF));

  const worst = grades[0];
  if (worst.grade === 'F' || worst.grade === 'D') {
    return {
      level: worst.grade === 'F' ? 'high' : 'watch',
      room: worst.name,
      grades,
      headline: `${worst.name} runs ${Math.abs(worst.deviationF).toFixed(0)}°F ${worst.deviationF < 0 ? 'colder' : 'warmer'} than the rest of the house.`,
      action: 'Check that room for drafts, open vents, or missing insulation.',
    };
  }
  if (worst.grade === 'C') {
    return {
      level: 'watch',
      room: worst.name,
      grades,
      headline: `${worst.name} drifts ${Math.abs(worst.deviationF).toFixed(0)}°F from the rest of the house.`,
      action: 'Worth a quick check for drafts next time you are there.',
    };
  }
  return {
    level: 'low',
    room: null,
    grades,
    headline: 'All rooms hold temperature within a few degrees of each other.',
    action: 'No action needed.',
  };
}

// ─── UI atoms ────────────────────────────────────────────────────────────────

const LEVEL_META: Record<RiskLevel, { label: string; chip: string; dot: string }> = {
  low: { label: 'Low', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  watch: { label: 'Watch', chip: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  high: { label: 'High', chip: 'bg-rose-50 text-rose-700 border-rose-200', dot: 'bg-rose-500' },
};

function LevelChip({ level }: { level: RiskLevel }) {
  const meta = LEVEL_META[level];
  return (
    <span className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${meta.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function layerTabLabel(text: string, level?: RiskLevel) {
  if (!level) return text;
  return (
    <span className="inline-flex items-center gap-1.5">
      {text}
      <span className={`h-1.5 w-1.5 rounded-full ${LEVEL_META[level].dot}`} />
    </span>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-slate-900">{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

// ─── Weather ─────────────────────────────────────────────────────────────────

type WeatherState =
  | { status: 'idle' | 'loading' }
  | { status: 'no-key' }
  | { status: 'no-location' }
  | { status: 'error' }
  | { status: 'ok'; tempF: number; description: string; forecast: ForecastPoint[]; source: 'coords' | 'address'; locationLabel: string };

async function geocodePropertyAddress(
  address: string,
  apiKey: string,
): Promise<{ lat: number; lng: number; label: string } | null> {
  const zipMatch = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  const stateZipMatch = address.match(/,\s*([A-Za-z .]+),\s*([A-Z]{2})\s+(\d{5})/);
  const queries = [
    address,
    stateZipMatch ? `${stateZipMatch[1].trim()}, ${stateZipMatch[2]} ${stateZipMatch[3]}, US` : null,
    zipMatch ? `${zipMatch[1]}, US` : null,
  ].filter((query): query is string => Boolean(query?.trim()));

  for (const query of [...new Set(queries)]) {
    try {
      const geoRes = await fetch(
        `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=1&appid=${apiKey}`,
      );
      if (!geoRes.ok) continue;
      const geoData = await geoRes.json();
      const match = Array.isArray(geoData) ? geoData[0] : null;
      if (match && typeof match.lat === 'number' && typeof match.lon === 'number') {
        const label = [match.name, match.state, match.country].filter(Boolean).join(', ');
        return { lat: match.lat, lng: match.lon, label: label || query };
      }
    } catch {
      // try next query shape
    }
  }
  return null;
}

async function fetchWeatherForecastByAddress(
  address: string,
  apiKey: string,
): Promise<{
  current: { tempF: number; description: string };
  forecast: ForecastPoint[];
  locationLabel: string;
} | null> {
  const geocoded = await geocodePropertyAddress(address, apiKey);
  if (!geocoded) return null;
  const forecast = await fetchWeatherForecast(geocoded.lat, geocoded.lng, apiKey);
  if (!forecast) return null;
  return { ...forecast, locationLabel: geocoded.label };
}

function formatHoursAway(hours: number): string {
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `~${Math.round(hours)}h`;
  return `~${Math.round(hours / 24)}d`;
}

/**
 * X-axis always spans the selected range (24h / 7d / 30d).
 * Zooming to sparse recent points made "24h" look like a 5-minute chart.
 */
function resolveChartTimeDomain(
  _rows: Array<Record<string, number | null>>,
  range: ChartRange,
  layer: Layer,
): [number, number] {
  const now = Date.now();
  const windowStart = now - RANGE_MS[range];
  if (layer === 'freeze') {
    // Freeze layer draws a 24h projection past "now".
    return [windowStart, now + 24 * 60 * 60 * 1000];
  }
  if (layer === 'weather') {
    // Outdoor assessment looks ~72h ahead.
    return [now - 3 * 60 * 60 * 1000, now + 72 * 60 * 60 * 1000];
  }
  // Small right pad so the newest samples aren't glued to the axis edge.
  const endPadMs = range === '24h' ? 8 * 60 * 1000 : range === '7d' ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  return [windowStart, now + endPadMs];
}

function bucketMsForRange(range: ChartRange, layer: Layer): number {
  // Match the ~60s BLE history cadence so Conditions doesn't smear points into 5‑min buckets.
  if (range === '24h') return layer === 'conditions' ? 60 * 1000 : 10 * 60 * 1000;
  if (range === '7d') return layer === 'conditions' ? 30 * 60 * 1000 : 60 * 60 * 1000;
  return layer === 'conditions' ? 3 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
}

/** Darker vertical band as humidity climbs above the 60% mold threshold. */
function moldBandOpacity(humidity: number): number {
  const aboveThreshold = Math.max(0, humidity - MOLD_ZONE_RH);
  const t = Math.min(1, aboveThreshold / 35); // 60% → light, 95%+ → darkest
  return 0.1 + t * 0.28;
}

/** Linear interpolation time where humidity crosses the mold threshold between two readings. */
function moldZoneCrossingTime(
  earlier: { time: number; humidity: number },
  later: { time: number; humidity: number },
  threshold: number,
): number {
  const delta = later.humidity - earlier.humidity;
  if (delta === 0) return earlier.time;
  const ratio = (threshold - earlier.humidity) / delta;
  return earlier.time + ratio * (later.time - earlier.time);
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function EnvironmentalAnalytics({
  devices,
  archivedDevices = [],
  readings,
  properties,
  selectedProperty,
  initialLayer,
  onLayerChange,
}: EnvironmentalAnalyticsProps) {
  const [layer, setLayerState] = useState<Layer>(initialLayer || 'conditions');
  const [range, setRange] = useState<ChartRange>('24h');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [weather, setWeather] = useState<WeatherState>({ status: 'idle' });
  const [extremeWeather, setExtremeWeather] = useState<ExtremeWeatherAssessment | null>(null);
  const [extremeWeatherStatus, setExtremeWeatherStatus] = useState<'idle' | 'loading' | 'error' | 'ok'>('idle');
  const [extremeWeatherError, setExtremeWeatherError] = useState<string | null>(null);

  useEffect(() => {
    if (initialLayer) setLayerState(initialLayer);
  }, [initialLayer]);

  const setLayer = useCallback((next: Layer) => {
    setLayerState(next);
    onLayerChange?.(next);
  }, [onLayerChange]);

  const analyticsDevices = useMemo(() => {
    const deviceById = new Map(devices.map((device) => [device.deviceId, device]));
    const archivedById = new Map(archivedDevices.map((device) => [device.deviceId, device]));
    const readingDeviceIds = Array.from(new Set(
      readings
        .filter((reading) => reading.humidity != null || reading.temperature != null)
        .map((reading) => reading.deviceId)
        .filter(Boolean),
    ));

    // Prefer currently enrolled devices. Only keep historical series for
    // intentionally archived sensors — never invent "Unnamed sensor" ghosts
    // from orphaned readings that are still being written by stale pollers.
    const preferredIds = devices.length > 0
      ? devices.map((device) => device.deviceId)
      : readingDeviceIds.filter((deviceId) => archivedById.has(deviceId) || deviceById.has(deviceId));

    return preferredIds.map((deviceId) => {
      const active = deviceById.get(deviceId);
      if (active) return active;

      const archived = archivedById.get(deviceId);
      if (archived) {
        return {
          id: archived.deviceId,
          deviceId: archived.deviceId,
          name: archived.name,
          location: archived.location,
          type: archived.type || 'temperature_humidity',
          status: 'offline' as const,
          propertyId: archived.propertyId,
          ownerId: archived.ownerId,
          lastSeen: archived.deletedAt,
          registeredAt: null,
        } satisfies ShellyDevice;
      }

      return null;
    }).filter((device): device is ShellyDevice => Boolean(device));
  }, [archivedDevices, devices, readings]);

  // Charts read sensor_readings; live Overview cards read shelly_devices.
  // Always merge the current device snapshot so the chart isn't stuck on a
  // single stale history point while rooms already show live temp/RH.
  const effectiveReadings = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range];
    const htDevices = analyticsDevices.filter(
      (device) => device.temperature != null || device.humidity != null,
    );

    const byKey = new Map<string, SensorReading>();
    const readingKey = (deviceId: string, ts: number) => `${deviceId}:${Math.floor(ts / 60_000)}`;

    const mergeReading = (reading: SensorReading) => {
      if (reading.timestamp.getTime() < cutoff) return;
      if (reading.temperature == null && reading.humidity == null) return;
      const key = readingKey(reading.deviceId, reading.timestamp.getTime());
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, reading);
        return;
      }
      // Temp-only and humidity-only packets often land in the same minute —
      // merge instead of letting the later one wipe the other metric.
      byKey.set(key, {
        ...existing,
        ...reading,
        temperature: reading.temperature ?? existing.temperature,
        humidity: reading.humidity ?? existing.humidity,
        batteryPercent: reading.batteryPercent ?? existing.batteryPercent,
        timestamp: reading.timestamp.getTime() >= existing.timestamp.getTime()
          ? reading.timestamp
          : existing.timestamp,
      });
    };

    for (const reading of readings) mergeReading(reading);

    for (const device of htDevices) {
      if (!device.lastSeen || device.lastSeen.getTime() < cutoff) continue;
      mergeReading({
        id: `snapshot-${device.id}`,
        deviceId: device.deviceId || device.id,
        temperature: device.temperature,
        humidity: device.humidity,
        batteryPercent: device.batteryPercent,
        timestamp: device.lastSeen,
      });
    }

    return [...byKey.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }, [analyticsDevices, readings, range]);

  // Conditions / mold / insulation / freeze: H&T climate only — not relays, gateways, or flood.
  const climateDevices = useMemo(
    () => pickCanonicalClimateDevices(analyticsDevices.filter(isChartableClimateDevice)),
    [analyticsDevices],
  );

  const chartableDevices = climateDevices;

  const rooms = useMemo(() => computeRoomStats(chartableDevices, effectiveReadings), [chartableDevices, effectiveReadings]);
  const mold = useMemo(() => assessMold(rooms), [rooms]);
  const freeze = useMemo(() => assessFreeze(rooms), [rooms]);
  const simpleInsulation = useMemo(() => assessInsulation(rooms), [rooms]);

  const activeDeviceId = selectedDeviceId && chartableDevices.some((d) => d.deviceId === selectedDeviceId)
    ? selectedDeviceId
    : chartableDevices[0]?.deviceId ?? null;
  const activeDevice = chartableDevices.find((d) => d.deviceId === activeDeviceId) ?? null;

  const activeProperty = useMemo(() => {
    if (selectedProperty !== 'all') {
      return properties.find((property) => property.id === selectedProperty) ?? null;
    }
    if (activeDevice?.propertyId) {
      return properties.find((property) => property.id === activeDevice.propertyId) ?? null;
    }
    return null;
  }, [activeDevice?.propertyId, properties, selectedProperty]);

  const weatherScopeLabel = useMemo(() => {
    if (selectedProperty !== 'all') return activeProperty?.address?.trim() || null;
    if (activeProperty?.address?.trim()) return activeProperty.address.trim();
    return null;
  }, [activeProperty?.address, selectedProperty]);

  // ── Weather: prefer the street address (more reliable than stale saved
  //    coordinates for user-facing current conditions), then fall back to
  //    saved coordinates if geocoding isn't available. ──
  const coords = useMemo(() => {
    const withCoords = (p: PropertyRef | undefined) => {
      const lat = p?.propertyData?.summary?.latitude;
      const lng = p?.propertyData?.summary?.longitude;
      return lat != null && lng != null ? { lat, lng } : null;
    };
    return withCoords(activeProperty ?? undefined);
  }, [activeProperty]);

  const weatherAddress = activeProperty?.address?.trim() || '';

  useEffect(() => {
    const apiKey = (import.meta as any).env?.VITE_OPENWEATHER_API_KEY;
    if (!apiKey) {
      setWeather({ status: 'no-key' });
      return;
    }
    if (!coords && !weatherAddress) {
      setWeather({ status: 'no-location' });
      return;
    }

    let cancelled = false;
    setWeather({ status: 'loading' });
    const request = weatherAddress
      ? fetchWeatherForecastByAddress(weatherAddress, apiKey)
          .then((result) => result ? { ...result, source: 'address' as const } : null)
          .then((result) => result ?? (
            coords
              ? fetchWeatherForecast(coords.lat, coords.lng, apiKey).then((fallback) => fallback ? {
                ...fallback,
                source: 'coords' as const,
                locationLabel: weatherAddress,
              } : null)
              : null
          ))
      : coords
        ? fetchWeatherForecast(coords.lat, coords.lng, apiKey).then((result) => result ? {
          ...result,
          source: 'coords' as const,
          locationLabel: weatherAddress || 'Saved coordinates',
        } : null)
        : Promise.resolve(null);
    request.then((result) => {
      if (cancelled) return;
      if (!result) {
        setWeather({ status: 'error' });
        return;
      }
      setWeather({
        status: 'ok',
        tempF: result.current.tempF,
        description: result.current.description,
        forecast: result.forecast,
        source: result.source,
        locationLabel: result.locationLabel,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [coords, weatherAddress]);

  const outsideTempF = weather.status === 'ok' ? weather.tempF : null;
  const outsideForecast = weather.status === 'ok' ? weather.forecast : [];

  // ── Extreme weather assessment (shared with live property twin) ──
  useEffect(() => {
    const propertyId = activeProperty?.id;
    if (!propertyId) {
      setExtremeWeather(null);
      setExtremeWeatherStatus('idle');
      setExtremeWeatherError(null);
      return undefined;
    }
    let cancelled = false;
    setExtremeWeatherStatus('loading');
    setExtremeWeatherError(null);
    fetchPropertyWeatherAssessment({
      propertyId,
      latitude: coords?.lat,
      longitude: coords?.lng,
      address: weatherAddress,
    })
      .then((assessment) => {
        if (cancelled) return;
        setExtremeWeather(assessment);
        setExtremeWeatherStatus('ok');
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setExtremeWeather(null);
        setExtremeWeatherStatus('error');
        setExtremeWeatherError(error?.message || 'Weather assessment unavailable');
      });
    return () => { cancelled = true; };
  }, [activeProperty?.id, coords?.lat, coords?.lng, weatherAddress]);

  const weatherAssessmentView: RiskAssessment | null = useMemo(() => {
    if (!extremeWeather) return null;
    const level = weatherRiskToLevel(extremeWeather.overallRisk);
    return {
      level,
      room: null,
      headline: extremeWeather.recommendation,
      action: extremeWeather.actions?.[0]?.label
        || (extremeWeather.mostUrgentHazard
          ? `Watch ${extremeWeather.mostUrgentHazard.replace(/_/g, ' ')}`
          : 'No prep actions right now.'),
    };
  }, [extremeWeather]);

  // ── Freeze model (only computed when the layer needs it) ──
  const freezeResult: FreezeForecastResult | null = useMemo(() => {
    if (layer !== 'freeze') return null;
    const hoursBack = RANGE_MS[range] / (60 * 60 * 1000);
    return analyzeFreezeForecast(chartableDevices, effectiveReadings, outsideTempF, outsideForecast, DEFAULT_FREEZE_CONFIG, hoursBack);
  }, [layer, range, chartableDevices, effectiveReadings, outsideTempF, outsideForecast]);

  const activeFreezeRoom = freezeResult?.rooms.find((room) => room.deviceId === activeDeviceId) ?? null;

  // ── Mold model: VTT growth index, damage cost, ventilation (7-day window) ──
  const moldModel: MoldGrowthAnalysisResult | null = useMemo(() => {
    if (layer !== 'mold') return null;
    return analyzeMoldGrowth(chartableDevices, effectiveReadings, DEFAULT_MOLD_CONFIG, 168, outsideTempF);
  }, [layer, chartableDevices, effectiveReadings, outsideTempF]);

  // ── Insulation cost model: thermal leak engine (needs outside temp) ──
  const thermalModel: ThermalLeakAnalysisResult | null = useMemo(() => {
    if (layer !== 'insulation' || outsideTempF == null) return null;
    return analyzeThermalLeaks(chartableDevices, effectiveReadings, outsideTempF, DEFAULT_THERMAL_CONFIG);
  }, [layer, chartableDevices, effectiveReadings, outsideTempF]);

  // Prefer the thermal cost engine for insulation headlines when available.
  const insulation = useMemo(() => {
    if (thermalModel && thermalModel.rooms.length >= 2) {
      const grades = thermalModel.rooms
        .map((room) => ({
          name: displayRoomName(room.deviceName),
          grade: room.grade,
          deviationF: room.deviationF,
        }))
        .sort((a, b) => Math.abs(b.deviationF) - Math.abs(a.deviationF));
      const worst = grades[0];
      if (worst.grade === 'F' || worst.grade === 'D') {
        return {
          level: worst.grade === 'F' ? 'high' as const : 'watch' as const,
          room: worst.name,
          grades,
          headline: `${worst.name} runs ${Math.abs(worst.deviationF).toFixed(0)}°F ${worst.deviationF < 0 ? 'colder' : 'warmer'} than the rest of the house.`,
          action: 'Check that room for drafts, open vents, or missing insulation.',
        };
      }
      if (worst.grade === 'C') {
        return {
          level: 'watch' as const,
          room: worst.name,
          grades,
          headline: `${worst.name} drifts ${Math.abs(worst.deviationF).toFixed(0)}°F from the rest of the house.`,
          action: 'Worth a quick check for drafts next time you are there.',
        };
      }
      return {
        level: 'low' as const,
        room: null,
        grades,
        headline: 'All rooms hold temperature within a few degrees of each other.',
        action: 'No action needed.',
      };
    }
    return simpleInsulation;
  }, [simpleInsulation, thermalModel]);

  // ── Chart data ──
  const singleRoomData = useMemo(() => {
    if (!activeDeviceId || !activeDevice) return [];
    const cutoff = Date.now() - RANGE_MS[range];
    const points = effectiveReadings
      .filter((r) => readingMatchesDevice(r.deviceId, activeDevice) && r.timestamp.getTime() >= cutoff && (r.humidity != null || r.temperature != null))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      .map((r) => ({
        time: r.timestamp.getTime(),
        humidity: r.humidity ?? null,
        tempF: tempF(r),
        projectedF: null as number | null,
        outsideF: null as number | null,
      }));

    const maxPoints = 400;
    const thinned = points.length <= maxPoints
      ? points
      : points.filter((_, index) => index % Math.ceil(points.length / maxPoints) === 0);

    // Insert null separators so connectNulls=false breaks overnight outages.
    const maxConnectGapMs = range === '24h' ? 45 * 60 * 1000 : range === '7d' ? 4 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    const withGaps: typeof thinned = [];
    for (let i = 0; i < thinned.length; i += 1) {
      if (i > 0 && thinned[i].time - thinned[i - 1].time > maxConnectGapMs) {
        withGaps.push({
          time: thinned[i - 1].time + 1,
          humidity: null,
          tempF: null,
          projectedF: null,
          outsideF: null,
        });
      }
      withGaps.push(thinned[i]);
    }
    return withGaps;
  }, [activeDevice, activeDeviceId, range, effectiveReadings]);

  // Conditions: all sensors — each room gets a temp line (solid) + humidity line (dashed).
  const conditionsChartData = useMemo(() => {
    if (layer !== 'conditions') {
      return { rows: [] as Array<Record<string, number | null>>, deviceKeys: [] as Array<{ key: string; humKey: string; tempKey: string; name: string; color: string }> };
    }

    const now = Date.now();
    const windowStart = now - RANGE_MS[range];
    const bucketMs = bucketMsForRange(range, 'conditions');

    const deviceKeys = chartableDevices.map((device, index) => ({
      key: `room${index}`,
      humKey: `room${index}Hum`,
      tempKey: `room${index}Temp`,
      deviceId: device.deviceId,
      name: displayRoomName(device.name),
      color: ROOM_COLORS[index % ROOM_COLORS.length],
    }));

    const bucketSums = new Map<string, { humSum: number; humCount: number; tempSum: number; tempCount: number }>();
    for (const r of effectiveReadings) {
      const ts = r.timestamp.getTime();
      if (ts < windowStart || ts > now) continue;
      const device = chartableDevices.find((d) => readingMatchesDevice(r.deviceId, d));
      const entry = device ? deviceKeys.find((d) => d.deviceId === device.deviceId) : undefined;
      if (!entry) continue;
      const bucket = Math.floor(ts / bucketMs) * bucketMs;
      const mapKey = `${entry.key}:${bucket}`;
      const agg = bucketSums.get(mapKey) ?? { humSum: 0, humCount: 0, tempSum: 0, tempCount: 0 };
      if (r.humidity != null) {
        agg.humSum += r.humidity;
        agg.humCount += 1;
      }
      if (r.temperature != null) {
        agg.tempSum += tempF(r) as number;
        agg.tempCount += 1;
      }
      bucketSums.set(mapKey, agg);
    }

    // Dense time grid + connectNulls=false: empty overnight buckets stay empty
    // on the real series; long gaps get a separate estimated fill series.
    const outageGapMs = range === '24h' ? 45 * 60 * 1000 : range === '7d' ? 4 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    const rows = buildBucketTimeGrid(windowStart, now, bucketMs).map((time) => {
      const row: Record<string, number | null> = { time };
      for (const entry of deviceKeys) {
        const agg = bucketSums.get(`${entry.key}:${time}`);
        row[entry.humKey] = agg && agg.humCount > 0 ? Math.round((agg.humSum / agg.humCount) * 10) / 10 : null;
        row[entry.tempKey] = agg && agg.tempCount > 0 ? Math.round((agg.tempSum / agg.tempCount) * 10) / 10 : null;
      }
      return row;
    });
    for (const entry of deviceKeys) {
      applyClimateGapFills(rows, entry.humKey, `${entry.humKey}Fill`, outageGapMs);
      applyClimateGapFills(rows, entry.tempKey, `${entry.tempKey}Fill`, outageGapMs);
    }

    return { rows, deviceKeys };
  }, [layer, range, effectiveReadings, chartableDevices]);

  const conditionsLatestIndexByKey = useMemo(() => {
    const latest: Record<string, number> = {};
    const { rows, deviceKeys } = conditionsChartData;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      for (const entry of deviceKeys) {
        if (row[entry.humKey] != null) latest[entry.humKey] = i;
        if (row[entry.tempKey] != null) latest[entry.tempKey] = i;
      }
    }
    return latest;
  }, [conditionsChartData]);

  // Freeze chart: ALL rooms' temperature lines (bucketed like insulation),
  // each room's projected curve continuing past "now", plus the outside line.
  const freezeChartData = useMemo(() => {
    if (layer !== 'freeze') return { rows: [] as Array<Record<string, number | null>>, deviceKeys: [] as Array<{ key: string; deviceId: string; name: string; color: string }> };
    const now = Date.now();
    const cutoff = now - RANGE_MS[range];
    const bucketMs = range === '24h' ? 20 * 60 * 1000 : range === '7d' ? 2 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;

    const deviceKeys = chartableDevices.map((device, index) => ({
      key: `room${index}`,
      deviceId: device.deviceId,
      name: displayRoomName(device.name),
      color: ROOM_COLORS[index % ROOM_COLORS.length],
    }));

    const rowsByTime = new Map<number, Record<string, number | null>>();
    const rowAt = (time: number): Record<string, number | null> => {
      if (!rowsByTime.has(time)) rowsByTime.set(time, { time });
      return rowsByTime.get(time)!;
    };

    // Actual readings on a dense grid so overnight outages are gaps, not diagonals.
    const bucketSums = new Map<string, { sum: number; count: number }>();
    const lastReadingByDevice = new Map<string, number>();
    for (const r of effectiveReadings) {
      const ts = r.timestamp.getTime();
      if (r.temperature == null || ts < cutoff) continue;
      const device = chartableDevices.find((d) => readingMatchesDevice(r.deviceId, d));
      const entry = device ? deviceKeys.find((d) => d.deviceId === device.deviceId) : undefined;
      if (!entry) continue;
      const prev = lastReadingByDevice.get(entry.deviceId) ?? 0;
      if (ts > prev) lastReadingByDevice.set(entry.deviceId, ts);
      const bucket = Math.floor(ts / bucketMs) * bucketMs;
      const mapKey = `${entry.key}:${bucket}`;
      const agg = bucketSums.get(mapKey) ?? { sum: 0, count: 0 };
      agg.sum += tempF(r) as number;
      agg.count += 1;
      bucketSums.set(mapKey, agg);
    }
    for (const time of buildBucketTimeGrid(cutoff, now, bucketMs)) {
      const row = rowAt(time);
      for (const entry of deviceKeys) {
        const agg = bucketSums.get(`${entry.key}:${time}`);
        row[entry.key] = agg && agg.count > 0 ? Math.round((agg.sum / agg.count) * 10) / 10 : null;
      }
    }

    // Per-room projected curves — only when the room has a fresh reading.
    if (freezeResult) {
      for (const room of freezeResult.rooms) {
        const entry = deviceKeys.find((d) => d.deviceId === room.deviceId);
        if (!entry) continue;
        const lastTs = lastReadingByDevice.get(entry.deviceId) ?? 0;
        if (now - lastTs > FREEZE_PROJECTION_STALE_MS) continue;
        const nowRow = rowAt(now);
        const anchorTemp = typeof nowRow[entry.key] === 'number'
          ? nowRow[entry.key] as number
          : room.currentTempF;
        nowRow[`${entry.key}Proj`] = anchorTemp;
        const horizon = now + 24 * 60 * 60 * 1000;
        for (const p of room.projectedCurve) {
          if (p.projectedF != null && p.timestamp >= now && p.timestamp <= horizon) {
            rowAt(p.timestamp)[`${entry.key}Proj`] = Math.round(p.projectedF * 10) / 10;
          }
        }
      }
    }

    // Outside temperature: sample continuously across the same timestamps used
    // by the projected curves so the line doesn't "jump" only at sparse
    // 3-hour forecast anchors.
    const horizon = now + 24 * 60 * 60 * 1000;
    for (const fp of outsideForecast) {
      if (fp.timestamp >= cutoff && fp.timestamp <= horizon) {
        rowAt(fp.timestamp).outsideF = interpolateOutsideTemp(fp.timestamp, now, outsideTempF ?? fp.tempF, outsideForecast);
      }
    }
    if (outsideTempF != null) rowAt(now).outsideF = outsideTempF;
    if (freezeResult) {
      for (const room of freezeResult.rooms) {
        for (const p of room.projectedCurve) {
          if (p.timestamp >= now && p.timestamp <= horizon && outsideTempF != null) {
            rowAt(p.timestamp).outsideF = interpolateOutsideTemp(p.timestamp, now, outsideTempF, outsideForecast);
          }
        }
      }
    }

    const rows = [...rowsByTime.values()]
      .filter((row) => {
        const t = row.time as number;
        return t >= cutoff && t <= horizon;
      })
      .sort((a, b) => (a.time as number) - (b.time as number));
    return { rows, deviceKeys };
  }, [layer, range, effectiveReadings, chartableDevices, freezeResult, outsideForecast, outsideTempF]);

  const insulationChartData = useMemo(() => {
    if (layer !== 'insulation') {
      return {
        rows: [] as Array<Record<string, number | null>>,
        deviceKeys: [] as Array<{ key: string; deviceId: string; name: string; color: string }>,
        houseMedianF: null as number | null,
        dataSpanHours: 0,
      };
    }

    const now = Date.now();
    const windowStart = now - RANGE_MS[range];
    const bucketMs = bucketMsForRange(range, 'insulation');

    const deviceKeys = chartableDevices.map((device, index) => ({
      key: `room${index}`,
      deviceId: device.deviceId,
      name: displayRoomName(device.name),
      color: ROOM_COLORS[index % ROOM_COLORS.length],
    }));

    const bucketSums = new Map<string, { sum: number; count: number }>();
    let oldestReading = now;

    for (const r of effectiveReadings) {
      if (r.temperature == null) continue;
      const ts = r.timestamp.getTime();
      if (ts < windowStart || ts > now) continue;
      const device = chartableDevices.find((d) => readingMatchesDevice(r.deviceId, d));
      const entry = device ? deviceKeys.find((d) => d.deviceId === device.deviceId) : undefined;
      if (!entry) continue;
      oldestReading = Math.min(oldestReading, ts);
      const bucket = Math.floor(ts / bucketMs) * bucketMs;
      const mapKey = `${entry.key}:${bucket}`;
      const agg = bucketSums.get(mapKey) ?? { sum: 0, count: 0 };
      agg.sum += tempF(r) as number;
      agg.count += 1;
      bucketSums.set(mapKey, agg);
    }

    // Only buckets that have readings — axis zooms to data, not empty window.
    const bucketTimes = new Set<number>();
    for (const mapKey of bucketSums.keys()) {
      bucketTimes.add(Number(mapKey.split(':')[1]));
    }

    const rows = [...bucketTimes]
      .sort((a, b) => a - b)
      .map((bucket) => {
        const row: Record<string, number | null> = { time: bucket };
        for (const entry of deviceKeys) {
          const agg = bucketSums.get(`${entry.key}:${bucket}`);
          row[entry.key] = agg ? Math.round((agg.sum / agg.count) * 10) / 10 : null;
        }
        return row;
      });

    // Flat reference line: median of each room's average over the window.
    const roomWindowAvgs = deviceKeys
      .map((entry) => {
        const temps: number[] = [];
        for (const [mapKey, agg] of bucketSums) {
          if (mapKey.startsWith(`${entry.key}:`)) temps.push(agg.sum / agg.count);
        }
        return temps.length > 0 ? temps.reduce((s, v) => s + v, 0) / temps.length : null;
      })
      .filter((value): value is number => value != null);

    const sortedAvgs = [...roomWindowAvgs].sort((a, b) => a - b);
    const houseMedianF = sortedAvgs.length > 0
      ? Math.round(sortedAvgs[Math.floor(sortedAvgs.length / 2)] * 10) / 10
      : thermalModel?.houseMedianTempF ?? null;

    const dataSpanHours = oldestReading < now
      ? Math.round((now - oldestReading) / (60 * 60 * 1000) * 10) / 10
      : 0;

    return { rows, deviceKeys, houseMedianF, dataSpanHours };
  }, [layer, range, effectiveReadings, chartableDevices, thermalModel]);

  const weatherChartData = useMemo(() => {
    if (!extremeWeather?.chartData?.length) return [] as Array<Record<string, number | null>>;
    return extremeWeather.chartData.map((row) => ({
      time: row.time,
      tempF: row.tempF ?? null,
      humidity: row.humidity ?? null,
      windMph: row.windMph ?? null,
      precipIn: row.precipIn ?? null,
    }));
  }, [extremeWeather]);

  const chartData: Array<Record<string, number | null>> = layer === 'insulation'
    ? insulationChartData.rows
    : layer === 'freeze'
      ? freezeChartData.rows
      : layer === 'conditions'
        ? conditionsChartData.rows
        : layer === 'weather'
          ? weatherChartData
          : (singleRoomData as unknown as Array<Record<string, number | null>>);

  const hasPlottableChartData = chartData.some((row) => (
    Object.entries(row).some(([key, value]) => key !== 'time' && typeof value === 'number')
  ));

  // Full-height vertical bands only on the Mold layer (single-room view).
  const moldBands = useMemo(() => {
    if (layer !== 'mold') return [];
    const points = singleRoomData;
    if (points.length === 0) return [];

    const visibleStart = points[0].time;
    const visibleEnd = points[points.length - 1].time;
    const fallbackHalfWidth = Math.max(RANGE_MS[range] / Math.max(points.length * 2, 24), 60_000);

    return points.flatMap((point, index) => {
      if (point.humidity == null || point.humidity < MOLD_ZONE_RH) return [];

      const prev = index > 0 ? points[index - 1] : null;
      const next = index < points.length - 1 ? points[index + 1] : null;

      let start: number;
      if (prev?.humidity != null && prev.humidity >= MOLD_ZONE_RH) {
        start = (prev.time + point.time) / 2;
      } else if (prev?.humidity != null && prev.humidity < MOLD_ZONE_RH) {
        start = moldZoneCrossingTime(
          { time: prev.time, humidity: prev.humidity },
          { time: point.time, humidity: point.humidity },
          MOLD_ZONE_RH,
        );
      } else {
        start = point.time - fallbackHalfWidth;
      }

      let end: number;
      if (next?.humidity != null && next.humidity >= MOLD_ZONE_RH) {
        end = (point.time + next.time) / 2;
      } else if (next?.humidity != null && next.humidity < MOLD_ZONE_RH) {
        end = moldZoneCrossingTime(
          { time: point.time, humidity: point.humidity },
          { time: next.time, humidity: next.humidity },
          MOLD_ZONE_RH,
        );
      } else {
        end = point.time + fallbackHalfWidth;
      }

      start = Math.max(visibleStart, start);
      end = Math.min(visibleEnd, end);
      if (end <= start) return [];

      return [{
        start,
        end,
        fillOpacity: moldBandOpacity(point.humidity),
      }];
    });
  }, [layer, singleRoomData, range]);

  const chartTimeDomain = useMemo(
    () => resolveChartTimeDomain(chartData, range, layer),
    [chartData, range, layer],
  );

  const isTempSeriesKey = (key: string) => (
    key !== 'time'
    && key !== 'humidity'
    && key !== 'windMph'
    && key !== 'precipIn'
    && !key.includes('Hum')
    && !key.endsWith('Proj')
    && key !== 'outsideF'
    && key !== 'medianF'
  );

  const tempDomain = useMemo(() => {
    const temps: number[] = [];
    for (const row of chartData) {
      for (const [key, value] of Object.entries(row)) {
        if (isTempSeriesKey(key) && typeof value === 'number') temps.push(value);
      }
    }
    if (layer === 'insulation' && insulationChartData.houseMedianF != null) {
      temps.push(insulationChartData.houseMedianF);
    }
    if (temps.length === 0) return [20, 90];
    const min = Math.min(...temps, layer === 'freeze' ? FREEZE_CRIT_F - 8 : Math.min(...temps));
    const max = Math.max(...temps) + 4;
    return [Math.floor(min - 3), Math.ceil(max)];
  }, [chartData, layer, insulationChartData.houseMedianF]);

  const tickFormatter = (value: number) => new Date(value).toLocaleString([], range === '24h'
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' });

  const showHumidity = layer === 'conditions' || layer === 'mold' || layer === 'weather';
  const showRoomChips = layer === 'mold';
  const multiRoomKeys = layer === 'freeze'
    ? freezeChartData.deviceKeys
    : layer === 'insulation'
      ? insulationChartData.deviceKeys
      : layer === 'conditions'
        ? conditionsChartData.deviceKeys
        : [];

  // ── AI context snapshot ──
  const aiContext = useMemo(() => ({
    property: selectedProperty === 'all'
      ? 'All properties'
      : properties.find((p) => p.id === selectedProperty)?.address ?? selectedProperty,
    activeLayer: layer,
    chartRange: range,
    activeRoom: activeDevice?.name ?? null,
    activePropertyAddress: activeProperty?.address ?? null,
    outsideWeather: weather.status === 'ok'
      ? {
        tempF: Math.round(weather.tempF),
        description: weather.description,
        source: weather.source,
      }
      : `unavailable (${weather.status})`,
    rooms: rooms.map((room) => ({
      name: room.name,
      currentTempF: room.currentTempF != null ? Math.round(room.currentTempF * 10) / 10 : null,
      currentHumidityPercent: room.currentHumidity,
      percentOfLastWeekInMoldZone: room.moldZonePercent7d != null ? Math.round(room.moldZonePercent7d) : null,
      lowestTempLast48hF: room.minTempF48h != null ? Math.round(room.minTempF48h * 10) / 10 : null,
      avgTempLast24hF: room.avgTempF24h != null ? Math.round(room.avgTempF24h * 10) / 10 : null,
    })),
    assessments: {
      mold: { level: mold.level, headline: mold.headline, recommendedAction: mold.action },
      freeze: { level: freeze.level, headline: freeze.headline, recommendedAction: freeze.action },
      insulation: {
        level: insulation.level,
        headline: insulation.headline,
        recommendedAction: insulation.action,
        roomGrades: insulation.grades.map((g) => ({ room: g.name, grade: g.grade, deviationFromHouseMedianF: Math.round(g.deviationF * 10) / 10 })),
      },
      weather: extremeWeather
        ? {
          overallRisk: extremeWeather.overallRisk,
          mostUrgentHazard: extremeWeather.mostUrgentHazard,
          hoursToNextEvent: extremeWeather.hoursToNextEvent,
          recommendation: extremeWeather.recommendation,
          actions: extremeWeather.actions?.slice(0, 5),
        }
        : `unavailable (${extremeWeatherStatus})`,
    },
    freezeModel: freezeResult
      ? {
        overallRisk: freezeResult.overallRisk,
        mostUrgentRoom: freezeResult.mostUrgentRoom,
        hoursToFirstFreeze: freezeResult.shortestTimeToFreeze,
        lowestOutsideForecastF: freezeResult.lowestForecastTempF,
        rooms: freezeResult.rooms.map((room) => ({
          room: room.deviceName,
          currentTempF: room.currentTempF,
          trendFPerHour: room.trendPerHourF,
          hoursToFreezing: room.hoursToFreezing,
          burstRisk: room.burstRisk,
        })),
      }
      : null,
    moldModel: moldModel
      ? {
        overallSeverity: moldModel.overallSeverity,
        highestRiskRoom: moldModel.highestRiskRoom,
        rooms: moldModel.rooms.map((room) => {
          const impact = moldModel.humidityHealth.find((h) => h.deviceId === room.deviceId)?.materialImpact;
          return {
            room: room.deviceName,
            vttGrowthScore0to6: room.moldIndex,
            severity: room.severity,
            percentTimeFavorable7d: Math.round(room.favorablePercent),
            hoursToVisibleMoldAtCurrentConditions: room.hoursUntilMold?.hoursToVisible ?? null,
            estimatedDamageCostRange: impact && impact.totalEstimatedCostHigh > 0
              ? `$${Math.round(impact.totalEstimatedCostLow)}-$${Math.round(impact.totalEstimatedCostHigh)}`
              : null,
          };
        }),
      }
      : null,
    insulationCostModel: thermalModel
      ? {
        totalExtraCostPerYear: Math.round(thermalModel.totalExcessAnnual),
        potentialAnnualSavings: Math.round(thermalModel.potentialAnnualSavings),
        confidencePercent: thermalModel.confidence,
        rooms: thermalModel.rooms.map((room) => ({
          room: room.deviceName,
          grade: room.grade,
          deviationFromMedianF: room.deviationF,
          extraCostPerYear: Math.round(room.excessCostPerYear),
          recommendedFix: getInsulationRecommendation(room.grade).action,
        })),
      }
      : null,
  }), [selectedProperty, properties, layer, range, activeDevice, activeProperty, weather, rooms, mold, freeze, insulation, freezeResult, moldModel, thermalModel, extremeWeather, extremeWeatherStatus]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const detail = aiContext;
    (window as unknown as { __houseyieldSensorAnalyticsContext?: typeof aiContext }).__houseyieldSensorAnalyticsContext = detail;
    window.dispatchEvent(new CustomEvent('houseyield:sensor-analytics-context', { detail }));
    return () => {
      const current = (window as unknown as { __houseyieldSensorAnalyticsContext?: typeof aiContext }).__houseyieldSensorAnalyticsContext;
      if (current === detail) {
        delete (window as unknown as { __houseyieldSensorAnalyticsContext?: typeof aiContext }).__houseyieldSensorAnalyticsContext;
      }
    };
  }, [aiContext]);

  const currentAssessment: RiskAssessment | null =
    layer === 'mold' ? mold
      : layer === 'freeze' ? freeze
        : layer === 'insulation' ? insulation
          : layer === 'weather' ? weatherAssessmentView
            : null;

  if (chartableDevices.length === 0 && layer !== 'weather') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500" data-voice-id="sensor-analytics-content">
        <p>No sensor readings yet. Analytics appear once H&T sensors start reporting, and historical data stays available after a sensor is removed.</p>
        {activeProperty?.id && (
          <button
            type="button"
            onClick={() => setLayer('weather')}
            className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-800 hover:bg-sky-100"
          >
            View outdoor weather risk
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={aiOpen ? 'grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]' : ''}
      data-voice-id="sensor-analytics-content"
    >
      <div className="min-w-0 space-y-4">
        {/* ── Weather scope for the selected property ── */}
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-500">
          {weather.status === 'ok' && (
            <span>
              Weather for <span className="font-semibold text-slate-800">{weatherScopeLabel || weather.locationLabel}</span>
              {' · '}Outside {Math.round(weather.tempF)}°F · {weather.description}
              {selectedProperty === 'all' && activeProperty?.address && (
                <span className="text-slate-400"> (from active room&apos;s property)</span>
              )}
            </span>
          )}
          {weather.status === 'loading' && 'Loading weather for selected property…'}
          {weather.status === 'no-location' && (weatherScopeLabel
            ? `No weather for ${weatherScopeLabel} — check the property address in your portfolio.`
            : 'Select a property in the header to load local weather.')}
          {weather.status === 'no-key' && 'Weather off: no API key configured.'}
          {weather.status === 'error' && (weatherScopeLabel
            ? `Weather unavailable for ${weatherScopeLabel}.`
            : 'Weather unavailable for this property.')}
        </div>

        {/* ── Header: layer tabs + AI button ── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SubTabs<Layer>
            tabs={[
              { id: 'conditions', label: 'Conditions', accent: 'slate', description: 'All rooms — humidity + temperature overview', buttonProps: { 'data-voice-id': 'sensor-layer-conditions' } },
              { id: 'mold', label: layerTabLabel('Mold', mold.level), accent: 'emerald', description: 'Time spent in the mold-growth humidity zone', buttonProps: { 'data-voice-id': 'sensor-layer-mold' } },
              { id: 'freeze', label: layerTabLabel('Freeze', freeze.level), accent: 'sky', description: 'Freeze risk with outside weather + projection', buttonProps: { 'data-voice-id': 'sensor-layer-freeze' } },
              { id: 'insulation', label: layerTabLabel('Insulation', simpleInsulation.level), accent: 'amber', description: 'All rooms vs the house median temperature', buttonProps: { 'data-voice-id': 'sensor-layer-insulation' } },
              {
                id: 'weather',
                label: layerTabLabel('Weather', weatherAssessmentView?.level),
                accent: 'indigo',
                description: 'Outdoor storms, wind, rain, heat, and humidity surge risk',
                buttonProps: { 'data-voice-id': 'sensor-layer-weather' },
              },
            ]}
            activeId={layer}
            onChange={setLayer}
          />
          {!aiOpen && (
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700"
            >
              <Sparkles size={15} />
              AI analysis
            </button>
          )}
        </div>

        {/* ── Layer readout: replaces the old three risk cards ── */}
        {currentAssessment && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <LevelChip level={currentAssessment.level} />
            <p className="min-w-0 flex-1 text-sm text-slate-700">
              {currentAssessment.headline}
              {currentAssessment.level !== 'low' && (
                <span className="text-slate-500"> — {currentAssessment.action}</span>
              )}
            </p>
          </div>
        )}

        {/* ── Central chart card ── */}
        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            {showRoomChips ? (
              <div className="flex flex-wrap gap-1.5">
                {chartableDevices.map((device) => (
                  <button
                    key={device.deviceId}
                    type="button"
                    onClick={() => setSelectedDeviceId(device.deviceId)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                      device.deviceId === activeDeviceId
                        ? 'bg-slate-900 text-white'
                        : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {device.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                {multiRoomKeys.map((entry) => (
                  <span key={entry.key} className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded" style={{ background: entry.color }} />
                    {entry.name}
                  </span>
                ))}
                {layer === 'conditions' && (
                  <span className="text-slate-400">solid = temp · dashed = humidity · faint = estimated gap</span>
                )}
                {layer === 'insulation' && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded border-b border-dashed border-slate-500" />
                    House median
                  </span>
                )}
                {layer === 'freeze' && (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-4 rounded border-b border-dashed border-slate-400" />
                      Projected (dashed)
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-4 rounded border-b-2 border-dashed border-sky-500" />
                      Outside
                    </span>
                  </>
                )}
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="max-w-[280px] text-right text-[11px] leading-snug text-slate-500">
                {weather.status === 'ok' && (
                  <>
                    <span className="block font-medium text-slate-700">{weatherScopeLabel || weather.locationLabel}</span>
                    Outside {Math.round(weather.tempF)}°F · {weather.description}
                  </>
                )}
                {weather.status === 'loading' && 'Loading weather…'}
                {weather.status === 'no-location' && 'Select a property for local weather'}
                {weather.status === 'no-key' && 'Weather off: no API key'}
                {weather.status === 'error' && 'Weather unavailable'}
              </span>
              <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
                {(['24h', '7d', '30d'] as ChartRange[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setRange(option)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                      range === option ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!hasPlottableChartData ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              {layer === 'weather'
                ? (extremeWeatherStatus === 'loading'
                  ? 'Loading outdoor forecast…'
                  : extremeWeatherError || 'Outdoor forecast unavailable for this property.')
                : `Not enough readings in the last ${range} yet. History builds about every 2 minutes while sensors are online.`}
            </div>
          ) : (
            <div className="p-4">
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
                    <XAxis
                      dataKey="time"
                      type="number"
                      scale="time"
                      domain={chartTimeDomain}
                      allowDataOverflow={false}
                      tickFormatter={tickFormatter}
                      stroke="rgba(15,23,42,0.2)"
                      tick={{ fill: 'rgba(15,23,42,0.45)', fontSize: 11 }}
                      minTickGap={56}
                    />
                    {showHumidity && (
                      <YAxis
                        yAxisId="hum"
                        domain={[0, 100]}
                        allowDataOverflow={false}
                        stroke="rgba(15,23,42,0.2)"
                        tick={{ fill: 'rgba(15,23,42,0.45)', fontSize: 11 }}
                        label={{ value: '% RH', angle: -90, position: 'insideLeft', style: { fill: 'rgba(15,23,42,0.4)', fontSize: 11 } }}
                      />
                    )}
                    <YAxis
                      yAxisId="temp"
                      orientation={showHumidity ? 'right' : 'left'}
                      domain={tempDomain}
                      allowDataOverflow={false}
                      stroke="rgba(15,23,42,0.2)"
                      tick={{ fill: 'rgba(15,23,42,0.45)', fontSize: 11 }}
                      label={{ value: '°F', angle: showHumidity ? 90 : -90, position: showHumidity ? 'insideRight' : 'insideLeft', style: { fill: 'rgba(15,23,42,0.4)', fontSize: 11 } }}
                    />
                    <Tooltip
                      contentStyle={{ background: '#ffffff', border: '1px solid rgba(15,23,42,0.1)', borderRadius: 10, fontSize: 12 }}
                      labelFormatter={(value) => new Date(value as number).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      formatter={(value, name) => {
                        if (typeof value !== 'number') return ['—', String(name)];
                        const label = String(name);
                        if (label === 'Humidity' || label.toLowerCase().includes('humidity')) {
                          return [`${value.toFixed(0)}% RH`, label];
                        }
                        return [`${value.toFixed(1)}°F`, label];
                      }}
                    />

                    {/* Vertical bands show the time periods humidity entered the mold zone */}
                    {showHumidity && layer === 'mold' && moldBands.map((interval, index) => (
                      <ReferenceArea
                        key={`mold-${index}`}
                        yAxisId="hum"
                        x1={interval.start}
                        x2={interval.end}
                        y1={0}
                        y2={100}
                        fill="#22c55e"
                        fillOpacity={interval.fillOpacity}
                        ifOverflow="visible"
                      />
                    ))}
                    {showHumidity && layer === 'mold' && (
                      <ReferenceLine
                        yAxisId="hum"
                        y={MOLD_ZONE_RH}
                        stroke="#22c55e"
                        strokeDasharray="4 4"
                        label={{ value: 'Mold zone ≥60%', position: 'insideTopLeft', fill: '#16a34a', fontSize: 10 }}
                      />
                    )}

                    {/* Freeze layer: blue band + thresholds */}
                    {layer === 'freeze' && (
                      <ReferenceArea yAxisId="temp" y1={tempDomain[0]} y2={FREEZE_CRIT_F} fill="#3b82f6" fillOpacity={0.08} />
                    )}
                    {layer === 'freeze' && (
                      <ReferenceLine
                        yAxisId="temp"
                        y={FREEZE_WARN_F}
                        stroke="#93c5fd"
                        strokeDasharray="4 4"
                        label={{ value: 'Warning 38°F', position: 'insideBottomLeft', fill: '#60a5fa', fontSize: 10 }}
                      />
                    )}
                    {layer === 'freeze' && (
                      <ReferenceLine
                        yAxisId="temp"
                        y={FREEZE_CRIT_F}
                        stroke="#3b82f6"
                        strokeDasharray="4 4"
                        label={{ value: 'Freeze 32°F', position: 'insideBottomRight', fill: '#2563eb', fontSize: 10 }}
                      />
                    )}
                    {layer === 'freeze' && (
                      <ReferenceLine
                        x={Date.now()}
                        stroke="rgba(15,23,42,0.25)"
                        strokeDasharray="2 4"
                        label={{ value: 'Now', position: 'insideTop', fill: 'rgba(15,23,42,0.45)', fontSize: 10 }}
                      />
                    )}

                    {/* Series */}
                    {layer === 'mold' && (
                      <Line
                        yAxisId="hum"
                        type={CLIMATE_LINE_CURVE}
                        dataKey="humidity"
                        name="Humidity"
                        stroke="#10b981"
                        strokeWidth={2.5}
                        dot={false}
                        connectNulls={false}
                      />
                    )}
                    {layer === 'conditions' && conditionsChartData.deviceKeys.map((entry) => (
                      <Line
                        key={`${entry.humKey}Fill`}
                        yAxisId="hum"
                        type={CLIMATE_LINE_CURVE}
                        dataKey={`${entry.humKey}Fill`}
                        name={`${entry.name} humidity (estimated)`}
                        stroke={entry.color}
                        strokeWidth={1}
                        strokeDasharray="2 5"
                        strokeOpacity={0.35}
                        dot={false}
                        activeDot={false}
                        connectNulls
                        legendType="none"
                        isAnimationActive={false}
                      />
                    ))}
                    {layer === 'conditions' && conditionsChartData.deviceKeys.map((entry) => (
                      <Line
                        key={entry.humKey}
                        yAxisId="hum"
                        type={CLIMATE_LINE_CURVE}
                        dataKey={entry.humKey}
                        name={`${entry.name} humidity`}
                        stroke={entry.color}
                        strokeWidth={1.25}
                        strokeDasharray="4 3"
                        strokeOpacity={0.85}
                        dot={(dotProps) => (
                          <ConditionsSeriesDot
                            {...dotProps}
                            latestIndexByKey={conditionsLatestIndexByKey}
                          />
                        )}
                        activeDot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                    {layer === 'mold' && (
                      <Line
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey="tempF"
                        name="Temperature"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        strokeOpacity={0.45}
                        dot={false}
                        connectNulls={false}
                      />
                    )}
                    {layer === 'conditions' && conditionsChartData.deviceKeys.map((entry) => (
                      <Line
                        key={`${entry.tempKey}Fill`}
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey={`${entry.tempKey}Fill`}
                        name={`${entry.name} temp (estimated)`}
                        stroke={entry.color}
                        strokeWidth={1.25}
                        strokeDasharray="2 5"
                        strokeOpacity={0.4}
                        dot={false}
                        activeDot={false}
                        connectNulls
                        legendType="none"
                        isAnimationActive={false}
                      />
                    ))}
                    {layer === 'conditions' && conditionsChartData.deviceKeys.map((entry) => (
                      <Line
                        key={entry.tempKey}
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey={entry.tempKey}
                        name={`${entry.name} temp`}
                        stroke={entry.color}
                        strokeWidth={1.5}
                        strokeOpacity={0.95}
                        dot={(dotProps) => (
                          <ConditionsSeriesDot
                            {...dotProps}
                            latestIndexByKey={conditionsLatestIndexByKey}
                          />
                        )}
                        activeDot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                    {layer === 'freeze' && freezeChartData.deviceKeys.map((entry) => (
                      <Line
                        key={entry.key}
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey={entry.key}
                        name={entry.name}
                        stroke={entry.color}
                        strokeWidth={2}
                        dot={false}
                        connectNulls={false}
                      />
                    ))}
                    {layer === 'freeze' && freezeChartData.deviceKeys.map((entry) => (
                      <Line
                        key={`${entry.key}Proj`}
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey={`${entry.key}Proj`}
                        name={`${entry.name} (projected)`}
                        stroke={entry.color}
                        strokeWidth={1.5}
                        strokeDasharray="6 4"
                        strokeOpacity={0.7}
                        dot={false}
                        connectNulls
                      />
                    ))}
                    {layer === 'freeze' && (
                      <Line
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey="outsideF"
                        name="Outside"
                        stroke="#0ea5e9"
                        strokeWidth={1.5}
                        strokeDasharray="3 3"
                        dot={false}
                        connectNulls
                      />
                    )}
                    {layer === 'insulation' && insulationChartData.deviceKeys.map((entry) => (
                      <Line
                        key={entry.key}
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey={entry.key}
                        name={entry.name}
                        stroke={entry.color}
                        strokeWidth={2}
                        dot={false}
                        connectNulls={false}
                      />
                    ))}
                    {layer === 'weather' && (
                      <Line
                        yAxisId="hum"
                        type={CLIMATE_LINE_CURVE}
                        dataKey="humidity"
                        name="Outdoor humidity"
                        stroke="#6366f1"
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        dot={false}
                        connectNulls
                      />
                    )}
                    {layer === 'weather' && (
                      <Line
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey="tempF"
                        name="Outdoor temp"
                        stroke="#0ea5e9"
                        strokeWidth={2.5}
                        dot={false}
                        connectNulls
                      />
                    )}
                    {layer === 'weather' && (
                      <Line
                        yAxisId="temp"
                        type={CLIMATE_LINE_CURVE}
                        dataKey="windMph"
                        name="Wind (mph)"
                        stroke="#64748b"
                        strokeWidth={1.5}
                        strokeDasharray="2 4"
                        dot={false}
                        connectNulls
                      />
                    )}
                    {layer === 'insulation' && insulationChartData.houseMedianF != null && (
                      <ReferenceLine
                        yAxisId="temp"
                        y={insulationChartData.houseMedianF}
                        stroke="#334155"
                        strokeDasharray="6 4"
                        label={{
                          value: `House median ${insulationChartData.houseMedianF}°F`,
                          position: 'insideTopRight',
                          fill: '#475569',
                          fontSize: 10,
                        }}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {layer === 'insulation' && (
                <div className="mt-2 space-y-1 text-[11px] text-slate-500">
                  <div className="flex flex-wrap items-center gap-4">
                    {insulationChartData.deviceKeys.map((entry) => (
                      <span key={entry.key} className="inline-flex items-center gap-1.5">
                        <span className="h-0.5 w-4 rounded" style={{ background: entry.color }} />
                        {entry.name}
                      </span>
                    ))}
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-4 rounded border-b border-dashed border-slate-500" />
                      House median (24h avg)
                    </span>
                  </div>
                  {range === '24h' && insulationChartData.dataSpanHours > 0 && insulationChartData.dataSpanHours < 20 && (
                    <p className="text-amber-600">
                      Sensor history only spans ~{insulationChartData.dataSpanHours}h in this window — more readings will extend the chart.
                    </p>
                  )}
                </div>
              )}
              {layer === 'conditions' && (
                <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
                  {conditionsChartData.deviceKeys.map((entry) => (
                    <span key={entry.key} className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-4 rounded" style={{ background: entry.color }} />
                      {entry.name}
                    </span>
                  ))}
                  <span className="text-slate-400">solid = temp · dashed = humidity · faint dots = estimated during outage</span>
                </div>
              )}
              {layer === 'mold' && (
                <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-emerald-500" /> Humidity</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-amber-500" /> Temperature</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-emerald-500/15 ring-1 ring-emerald-200" /> Time in mold zone (≥60%)</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-emerald-500/35 ring-1 ring-emerald-400" /> Higher humidity (darker)</span>
                </div>
              )}
              {layer === 'weather' && (
                <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-sky-500" /> Outdoor temp</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded border-b border-dashed border-indigo-500" /> Outdoor humidity</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded border-b border-dashed border-slate-500" /> Wind (mph)</span>
                  <span className="text-slate-400">Pipe freeze physics stays on the Freeze layer</span>
                </div>
              )}
            </div>
          )}

          {/* ── Layer stats footer ── */}
          <div className="grid grid-cols-2 gap-2 border-t border-slate-100 px-4 py-3 sm:grid-cols-4">
            {layer === 'conditions' && (() => {
              const temps = rooms.map((r) => r.currentTempF).filter((v): v is number => v != null);
              const hums = rooms.map((r) => r.currentHumidity).filter((v): v is number => v != null);
              const tempRange = temps.length > 0
                ? (temps.length === 1 || Math.min(...temps) === Math.max(...temps)
                  ? `${temps[0].toFixed(1)}°F`
                  : `${Math.min(...temps).toFixed(1)}–${Math.max(...temps).toFixed(1)}°F`)
                : '—';
              const humRange = hums.length > 0
                ? (hums.length === 1 || Math.min(...hums) === Math.max(...hums)
                  ? `${Math.round(hums[0])}%`
                  : `${Math.round(Math.min(...hums))}–${Math.round(Math.max(...hums))}%`)
                : '—';
              return (
                <>
                  <StatTile label="Temp range" value={tempRange} sub="across rooms now" />
                  <StatTile label="Humidity range" value={humRange} sub="across rooms now" />
                  <StatTile label="Outside now" value={weather.status === 'ok' ? `${Math.round(weather.tempF)}°F` : '—'} sub={weather.status === 'ok' ? weather.description : undefined} />
                  <StatTile label="Rooms monitored" value={String(chartableDevices.length)} />
                </>
              );
            })()}
            {layer === 'mold' && (() => {
              const activeMoldRoom = moldModel?.rooms.find((r) => r.deviceId === activeDeviceId) ?? null;
              const worstMoldRoom = moldModel?.rooms.reduce((worst, r) => (r.riskScore > (worst?.riskScore ?? -1) ? r : worst), null as MoldGrowthRoomProfile | null) ?? null;
              return (
                <>
                  <StatTile
                    label="Growth score"
                    value={activeMoldRoom ? `${activeMoldRoom.moldIndex.toFixed(2)} / 6` : '—'}
                    sub={activeDevice ? `${activeDevice.name} · 1 = microscopic, 3 = visible` : undefined}
                  />
                  <StatTile
                    label="Time in mold zone"
                    value={rooms.find((r) => r.deviceId === activeDeviceId)?.moldZonePercent7d != null ? `${Math.round(rooms.find((r) => r.deviceId === activeDeviceId)!.moldZonePercent7d as number)}%` : '—'}
                    sub="of the last 7 days"
                  />
                  <StatTile
                    label="Margin to critical RH"
                    value={activeMoldRoom?.rhMargin != null ? `${activeMoldRoom.rhMargin > 0 ? '+' : ''}${activeMoldRoom.rhMargin.toFixed(0)}%` : '—'}
                    sub={activeMoldRoom?.criticalRH != null ? `growth starts at ${activeMoldRoom.criticalRH.toFixed(0)}% RH at this temp` : undefined}
                  />
                  <StatTile
                    label="Worst room"
                    value={worstMoldRoom?.deviceName ?? mold.room ?? 'None'}
                    sub={worstMoldRoom ? `severity: ${worstMoldRoom.severity}` : undefined}
                  />
                </>
              );
            })()}
            {layer === 'freeze' && (() => {
              const coldestRoom = [...rooms].filter((r) => r.minTempF48h != null).sort((a, b) => (a.minTempF48h as number) - (b.minTempF48h as number))[0] ?? null;
              const urgentRoom = freezeResult?.rooms
                .filter((r) => r.hoursToFreezing != null)
                .sort((a, b) => (a.hoursToFreezing as number) - (b.hoursToFreezing as number))[0] ?? null;
              const worstBurst = freezeResult?.rooms.reduce((worst, r) => {
                const order = ['none', 'low', 'moderate', 'high', 'critical'];
                return order.indexOf(r.burstRisk) > order.indexOf(worst?.burstRisk ?? 'none') ? r : worst;
              }, null as RoomFreezeProfile | null) ?? null;
              return (
                <>
                  <StatTile
                    label="Coldest room (48h)"
                    value={coldestRoom?.minTempF48h != null ? `${(coldestRoom.minTempF48h as number).toFixed(0)}°F` : '—'}
                    sub={coldestRoom?.name}
                  />
                  <StatTile
                    label="First room to freeze"
                    value={urgentRoom?.hoursToFreezing != null ? formatHoursAway(urgentRoom.hoursToFreezing) : 'Not trending'}
                    sub={urgentRoom ? urgentRoom.deviceName : 'no room is cooling toward 32°F'}
                  />
                  <StatTile
                    label="Outside low (5d)"
                    value={freezeResult?.lowestForecastTempF != null ? `${Math.round(freezeResult.lowestForecastTempF)}°F` : '—'}
                    sub={freezeResult?.lowestForecastTime ?? undefined}
                  />
                  <StatTile
                    label="Worst burst risk"
                    value={worstBurst ? worstBurst.burstRisk : '—'}
                    sub={worstBurst && worstBurst.burstRisk !== 'none' ? worstBurst.deviceName : 'cumulative cold exposure'}
                  />
                </>
              );
            })()}
            {layer === 'insulation' && (
              <>
                <StatTile
                  label="Extra energy cost"
                  value={thermalModel ? `$${Math.round(thermalModel.totalExcessAnnual)}/yr` : '—'}
                  sub={thermalModel ? `$${Math.round(thermalModel.totalExcessMonthly)}/mo across ${thermalModel.sensorCount} rooms` : 'needs outside temperature'}
                />
                <StatTile
                  label="Potential savings"
                  value={thermalModel ? `$${Math.round(thermalModel.potentialAnnualSavings)}/yr` : '—'}
                  sub="if every room matched the best one"
                />
                <StatTile
                  label="House median"
                  value={thermalModel ? `${thermalModel.houseMedianTempF.toFixed(1)}°F` : '—'}
                  sub={thermalModel ? `outside ${Math.round(thermalModel.outsideTempF)}°F · ${thermalModel.mode}` : undefined}
                />
                <StatTile
                  label="Confidence"
                  value={thermalModel ? `${thermalModel.confidence}%` : '—'}
                  sub={thermalModel ? `${thermalModel.totalReadingsUsed} readings over ${thermalModel.hoursAnalyzed}h` : undefined}
                />
              </>
            )}
            {layer === 'weather' && (
              <>
                <StatTile
                  label="Overall risk"
                  value={extremeWeather ? weatherRiskLabel(extremeWeather.overallRisk) : '—'}
                  sub={extremeWeather?.mostUrgentHazard?.replace(/_/g, ' ') || 'no urgent hazard'}
                />
                <StatTile
                  label="Outdoor now"
                  value={extremeWeather?.current?.tempF != null ? `${Math.round(extremeWeather.current.tempF)}°F` : '—'}
                  sub={extremeWeather?.current?.description || undefined}
                />
                <StatTile
                  label="Wind / gust"
                  value={extremeWeather?.current?.windMph != null
                    ? `${Math.round(extremeWeather.current.windMph)}${extremeWeather.current.windGustMph != null ? ` / ${Math.round(extremeWeather.current.windGustMph)}` : ''} mph`
                    : '—'}
                  sub={extremeWeather?.current?.humidity != null ? `${Math.round(extremeWeather.current.humidity)}% outdoor RH` : undefined}
                />
                <StatTile
                  label="Next event"
                  value={extremeWeather?.hoursToNextEvent != null
                    ? `~${Math.round(extremeWeather.hoursToNextEvent)}h`
                    : 'None'}
                  sub={extremeWeather?.events?.[0]?.peakLabel || 'within 48–72h'}
                />
              </>
            )}
          </div>
        </div>

        {layer === 'weather' && extremeWeather?.actions && extremeWeather.actions.length > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-sm font-semibold text-slate-900">Prep checklist</div>
            <ul className="mt-2 space-y-1.5">
              {extremeWeather.actions.map((action) => (
                <li key={action.id} className="text-sm text-slate-700">
                  <span className="font-medium">{action.label}</span>
                  <span className="text-slate-500"> — {action.reason}</span>
                </li>
              ))}
            </ul>
            {extremeWeather.disclaimer && (
              <p className="mt-2 text-[11px] text-slate-400">{extremeWeather.disclaimer}</p>
            )}
          </div>
        )}

        {/* ── Per-room detail: mold growth model ── */}
        {layer === 'mold' && moldModel && moldModel.rooms.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-900">Room-by-room mold model</div>
              <div className="text-xs text-slate-500">Cumulative VTT growth score from the last 7 days of temperature + humidity. 1 = microscopic growth starting, 3 = visible mold.</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">Room</th>
                    <th className="px-3 py-2">Growth score</th>
                    <th className="px-3 py-2">Favorable time (7d)</th>
                    <th className="px-3 py-2">Time to visible mold</th>
                    <th className="px-3 py-2">Ventilation</th>
                    <th className="px-3 py-2">Damage exposure</th>
                  </tr>
                </thead>
                <tbody>
                  {[...moldModel.rooms]
                    .sort((a, b) => b.riskScore - a.riskScore)
                    .map((room) => {
                      const vent = moldModel.ventilation.find((v) => v.deviceId === room.deviceId);
                      const health = moldModel.humidityHealth.find((h) => h.deviceId === room.deviceId);
                      const impact = health?.materialImpact;
                      const hoursVisible = room.hoursUntilMold?.hoursToVisible;
                      return (
                        <tr key={room.deviceId} className="border-b border-slate-50 last:border-0">
                          <td className="px-4 py-2.5 font-medium text-slate-800">{room.deviceName}</td>
                          <td className="px-3 py-2.5">
                            <span className={`font-semibold ${room.moldIndex >= 1 ? 'text-rose-600' : room.moldIndex >= 0.5 ? 'text-amber-600' : 'text-slate-700'}`}>
                              {room.moldIndex.toFixed(2)}
                            </span>
                            <span className="text-slate-400"> / 6 · {room.severity}</span>
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">{Math.round(room.favorablePercent)}%</td>
                          <td className="px-3 py-2.5 text-slate-600">
                            {hoursVisible != null
                              ? `${formatHoursAway(hoursVisible)} at current conditions`
                              : room.daysToVisible != null
                                ? `~${Math.round(room.daysToVisible)}d at current rate`
                                : 'Not trending toward growth'}
                          </td>
                          <td className="px-3 py-2.5">
                            {vent ? (
                              <span className={vent.grade === 'poor' ? 'font-medium text-rose-600' : vent.grade === 'moderate' ? 'text-amber-600' : 'text-emerald-600'}>
                                {vent.grade}
                                {vent.avgRecoveryMinutes != null && <span className="text-slate-400"> · dries out in ~{Math.round(vent.avgRecoveryMinutes)}min</span>}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">
                            {impact && impact.totalEstimatedCostHigh > 0
                              ? `$${Math.round(impact.totalEstimatedCostLow)}–$${Math.round(impact.totalEstimatedCostHigh)} paint/drywall risk`
                              : 'None accrued'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Per-room detail: freeze model ── */}
        {layer === 'freeze' && freezeResult && freezeResult.rooms.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-900">Room-by-room freeze model</div>
              <div className="text-xs text-slate-500">Newton's-law cooling projection per room, pulled toward the outside forecast. Burst risk accumulates from sustained time below 32°F.</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-2">Room</th>
                    <th className="px-3 py-2">Now</th>
                    <th className="px-3 py-2">Trend</th>
                    <th className="px-3 py-2">Time to 38°F</th>
                    <th className="px-3 py-2">Time to 32°F</th>
                    <th className="px-3 py-2">Burst risk</th>
                    <th className="px-3 py-2">Heat recovery</th>
                  </tr>
                </thead>
                <tbody>
                  {[...freezeResult.rooms]
                    .sort((a, b) => (a.hoursToFreezing ?? Infinity) - (b.hoursToFreezing ?? Infinity))
                    .map((room) => (
                      <tr key={room.deviceId} className="border-b border-slate-50 last:border-0">
                        <td className="px-4 py-2.5 font-medium text-slate-800">{room.deviceName}</td>
                        <td className="px-3 py-2.5 text-slate-700">{room.currentTempF.toFixed(1)}°F</td>
                        <td className={`px-3 py-2.5 ${room.trendPerHourF < -0.5 ? 'text-sky-600' : 'text-slate-600'}`}>
                          {room.trendPerHourF > 0 ? '+' : ''}{room.trendPerHourF.toFixed(1)}°F/hr
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{room.hoursToWarning != null ? formatHoursAway(room.hoursToWarning) : '—'}</td>
                        <td className={`px-3 py-2.5 ${room.hoursToFreezing != null && room.hoursToFreezing < 24 ? 'font-semibold text-rose-600' : 'text-slate-600'}`}>
                          {room.isFreezing ? 'Below now' : room.hoursToFreezing != null ? formatHoursAway(room.hoursToFreezing) : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={room.burstRisk === 'none' ? 'text-emerald-600' : room.burstRisk === 'low' ? 'text-lime-600' : room.burstRisk === 'moderate' ? 'text-amber-600' : 'font-semibold text-rose-600'}>
                            {room.burstRisk}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {room.recoveryRateF != null ? `${room.recoveryRateF.toFixed(1)}°F/hr` : 'No recent cold dip'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Per-room detail: insulation cost model ── */}
        {layer === 'insulation' && (
          thermalModel && thermalModel.rooms.length > 0 ? (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="text-sm font-semibold text-slate-900">Room-by-room insulation cost</div>
                <div className="text-xs text-slate-500">Rooms that can't hold the house temperature make your HVAC work harder. Costs assume a heat pump at $0.16/kWh over a typical heating + cooling season.</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-4 py-2">Room</th>
                      <th className="px-3 py-2">Grade</th>
                      <th className="px-3 py-2">Vs house median</th>
                      <th className="px-3 py-2">Extra cost</th>
                      <th className="px-3 py-2">Recommended fix</th>
                      <th className="px-3 py-2">Fix cost / payback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...thermalModel.rooms]
                      .sort((a, b) => b.excessCostPerYear - a.excessCostPerYear)
                      .map((room) => {
                        const rec = getInsulationRecommendation(room.grade);
                        return (
                          <tr key={room.deviceId} className="border-b border-slate-50 last:border-0">
                            <td className="px-4 py-2.5 font-medium text-slate-800">{room.deviceName}</td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${gradeTone(room.grade)}`}>{room.grade}</span>
                            </td>
                            <td className="px-3 py-2.5 text-slate-600">
                              {room.deviationF > 0 ? '+' : ''}{room.deviationF.toFixed(1)}°F
                              {room.trend === 'worsening' && <span className="text-rose-500"> · worsening</span>}
                              {room.trend === 'improving' && <span className="text-emerald-500"> · improving</span>}
                            </td>
                            <td className={`px-3 py-2.5 ${room.excessCostPerYear >= 100 ? 'font-semibold text-rose-600' : 'text-slate-600'}`}>
                              {room.excessCostPerYear > 0 ? `$${Math.round(room.excessCostPerYear)}/yr` : '$0'}
                            </td>
                            <td className="px-3 py-2.5 text-slate-600">{rec.action}</td>
                            <td className="px-3 py-2.5 text-slate-600">{room.grade === 'A' ? '—' : `${rec.estimatedCost} · pays back in ${rec.paybackPeriod}`}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
              {insulation.grades.length > 0 && (
                <span className="mr-2 inline-flex flex-wrap gap-1.5 align-middle">
                  {insulation.grades.map((entry) => (
                    <span key={entry.name} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${gradeTone(entry.grade)}`}>
                      <span className="font-bold">{entry.grade}</span>
                      <span className="max-w-[130px] truncate">{entry.name}</span>
                    </span>
                  ))}
                </span>
              )}
              Cost estimates need the outside temperature — {weather.status === 'ok' ? 'not enough sensor data yet.' : 'weather is currently unavailable for this property.'}
            </div>
          )
        )}

        {/* How-is-this-calculated footnote per layer */}
        <p className="px-1 text-[11px] leading-relaxed text-slate-400">
          {layer === 'conditions' && 'Property-wide sensor overview. Each room gets a solid temperature line and a dashed humidity line in the same color. Switch to Mold for single-room mold-zone detail.'}
          {layer === 'mold' && `The growth score is the research-standard VTT mold index (0–6): it accumulates while temperature and humidity stay mold-friendly and slowly recedes when conditions dry out — 1 means microscopic growth is starting, 3 means visible mold. Time-in-zone counts readings at/above ${MOLD_ZONE_RH}% RH over the last 7 days. Damage exposure screens cumulative humidity stress on paint and drywall; it is a repair-cost range, not confirmed damage.`}
          {layer === 'freeze' && 'Each room\'s dashed line extends its recent temperature trend with Newton\'s law of cooling (cooling constant fit from your sensor data), pulled toward the outside forecast. Burst risk accumulates from sustained hours below 32°F; heat recovery shows how fast the room re-warmed after its last cold dip.'}
          {layer === 'insulation' && 'Each room gets a letter grade from how far it drifts from the house median temperature (ΔT-weighted so extreme-weather readings count more). The dollar figures convert that extra heat loss into energy cost over a typical heating + cooling season — they are estimates for prioritizing fixes, not utility-bill predictions.'}
        </p>
      </div>

      {/* ── AI analysis side rail ── */}
      {aiOpen && <SensorInsightsPanel context={aiContext} onClose={() => setAiOpen(false)} />}
    </div>
  );
}
