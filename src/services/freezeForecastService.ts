/**
 * Freeze & Pipe Burst Forecast Service
 * 
 * Predicts when rooms will reach freezing thresholds using:
 *   1. Linear regression on recent sensor readings (temperature trend)
 *   2. Newton's law of cooling with a per-room cooling constant derived from data
 *   3. OpenWeather 5-day/3-hour forecast for outside temperature projection
 *   4. Cumulative freezing-degree-hours for pipe burst risk scoring
 * 
 * Data sources:
 *   - Indoor: Shelly BLU H&T sensors (per-room temp every ~5 min)
 *   - Outdoor current: OpenWeather current weather API
 *   - Outdoor forecast: OpenWeather 5-day/3-hour forecast API
 *   - History: Firestore sensor_readings collection
 */

import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';

// ─── Types ────────────────────────────────────────────────────────

export type PipeMaterial = 'copper' | 'pex' | 'cpvc' | 'galvanized_steel';

export interface FreezeForecastConfig {
  /** Pipe material — affects burst risk thresholds */
  pipeMaterial: PipeMaterial;
  /** HVAC thermostat setpoint in °F (used for recovery analysis) */
  thermostatSetpointF: number;
  /** Hours of history to use for trend regression (default 6) */
  trendWindowHours: number;
  /** Hours to project forward (default 24) */
  forecastHoursAhead: number;
  /** Pipe age in years — older pipes are more vulnerable (default 0 = unknown) */
  pipeAgeYears: number;
}

export interface FreezeThresholds {
  warningF: number;      // 38°F — time to prepare
  freezingF: number;     // 32°F — water freezes
  pipeBurstF: number;    // 20°F — IBHS pipe burst territory
  extremeColdF: number;  // 10°F — extreme cold, rapid burst risk
}

export interface ForecastPoint {
  timestamp: number;
  tempF: number;
}

export interface RoomFreezeProfile {
  deviceId: string;
  deviceName: string;
  /** Current temperature (°F) */
  currentTempF: number;
  /** Temperature trend: °F per hour (negative = cooling) */
  trendPerHourF: number;
  /** R² of the trend regression (0–1, higher = more confident in trend) */
  trendR2: number;
  /** Cooling constant k (higher = room cools faster, worse insulation) */
  coolingConstantK: number;
  /** Hours until warning threshold (38°F), null if not trending down or already below */
  hoursToWarning: number | null;
  /** Hours until freezing (32°F), null if not trending or already below */
  hoursToFreezing: number | null;
  /** Hours until pipe burst zone (20°F), null if not trending */
  hoursToPipeBurst: number | null;
  /** Hours until extreme cold zone (10°F), null if not trending */
  hoursToExtremeCold: number | null;
  /** Is this room currently below freezing? */
  isFreezing: boolean;
  /** Is this room currently in pipe burst zone? */
  isPipeBurstZone: boolean;
  /** Is this room in extreme cold territory? */
  isExtremeCold: boolean;
  /** Pipe age multiplier applied to burst risk (1.0 = no effect) */
  pipeAgeMultiplier: number;
  /** Cumulative freezing-degree-hours (sustained exposure) */
  freezingDegreeHours: number;
  /** Pipe burst risk level from cumulative exposure */
  burstRisk: 'none' | 'low' | 'moderate' | 'high' | 'critical';
  /** Projected temperature curve (actual + forecast) */
  projectedCurve: { timestamp: number; time: string; actualF?: number; projectedF?: number }[];
  /** Recovery rate: °F/hr during last warm-up event (null if none detected) */
  recoveryRateF: number | null;
  /** Minutes to recover from last cold dip to setpoint */
  recoveryMinutes: number | null;
  /** Confidence 0–100 */
  confidence: number;
  /** Data points used */
  dataPoints: number;
  /** Recommendation text */
  recommendation: string;
}

export interface FreezeForecastResult {
  analyzedAt: Date;
  rooms: RoomFreezeProfile[];
  /** Outside temperature now (°F) */
  outsideTempF: number | null;
  /** Outside forecast points */
  outsideForecast: ForecastPoint[];
  /** Lowest projected outside temp in forecast window */
  lowestForecastTempF: number | null;
  /** When the lowest temp is expected */
  lowestForecastTime: string | null;
  /** Room at most immediate risk */
  mostUrgentRoom: string | null;
  /** Shortest time to any critical threshold across all rooms */
  shortestTimeToFreeze: number | null;
  /** Overall risk level */
  overallRisk: 'none' | 'low' | 'moderate' | 'high' | 'critical';
  /** Hours of sensor data analyzed */
  hoursAnalyzed: number;
  sensorCount: number;
  /** Time-series for the combined chart */
  chartData: FreezeChartPoint[];
}

export interface FreezeChartPoint {
  timestamp: number;
  time: string;
  outsideF?: number;
  outsideForecastF?: number;
  /** Per-device actual temps */
  deviceActual: Record<string, number>;
  /** Per-device projected temps */
  deviceProjected: Record<string, number>;
}

// ─── Constants ────────────────────────────────────────────────────

export const FREEZE_THRESHOLDS: FreezeThresholds = {
  warningF: 38,
  freezingF: 32,
  pipeBurstF: 20,
  extremeColdF: 10,
};

/** Pipe burst risk from freezing-degree-hours, by pipe material.
 *  Format: [low, moderate, high, critical] thresholds in degree-hours. */
const BURST_RISK_THRESHOLDS: Record<PipeMaterial, [number, number, number, number]> = {
  copper:           [12, 48, 96, 144],
  galvanized_steel: [16, 56, 112, 168],
  cpvc:             [24, 72, 144, 216],
  pex:              [48, 144, 288, 432], // PEX is ~3× more tolerant
};

const BURST_RISK_COLORS: Record<RoomFreezeProfile['burstRisk'], string> = {
  none: '#22c55e',
  low: '#84cc16',
  moderate: '#eab308',
  high: '#f97316',
  critical: '#ef4444',
};

const PIPE_MATERIAL_LABELS: Record<PipeMaterial, string> = {
  copper: 'Copper',
  pex: 'PEX (Cross-linked Polyethylene)',
  cpvc: 'CPVC',
  galvanized_steel: 'Galvanized Steel',
};

// ─── Default Config ───────────────────────────────────────────────

export const DEFAULT_FREEZE_CONFIG: FreezeForecastConfig = {
  pipeMaterial: 'copper',
  thermostatSetpointF: 68,
  trendWindowHours: 6,
  forecastHoursAhead: 24,
  pipeAgeYears: 0,
};

/**
 * Pipe age multiplier: older pipes burst at fewer FDH.
 * 0–10 years: 1.0× (baseline)
 * 10–25 years: 1.0 + (age-10)*0.02 → up to 1.3×
 * 25–50 years: 1.3 + (age-25)*0.04 → up to 2.3×
 * 50+ years: 2.5×
 */
function pipeAgeMultiplier(ageYears: number): number {
  if (ageYears <= 0) return 1.0; // Unknown age = no adjustment
  if (ageYears <= 10) return 1.0;
  if (ageYears <= 25) return 1.0 + (ageYears - 10) * 0.02;
  if (ageYears <= 50) return 1.3 + (ageYears - 25) * 0.04;
  return 2.5;
}

// ─── Helpers ──────────────────────────────────────────────────────

function cToF(c: number): number {
  return (c * 9 / 5) + 32;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Simple linear regression on (x, y) pairs.
 * Returns { slope, intercept, r2 }.
 */
function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y || 0, r2: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: sumY / n, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² (coefficient of determination)
  const yMean = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (const p of points) {
    const yPred = slope * p.x + intercept;
    ssRes += (p.y - yPred) ** 2;
    ssTot += (p.y - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2: Math.max(0, r2) };
}

/**
 * Estimate the cooling constant k from sensor readings and outside temperature.
 * 
 * Newton's law of cooling: dT/dt = -k × (T_inside - T_outside)
 * Rearranged: k = -dT/dt / (T_inside - T_outside)
 * 
 * IMPORTANT: We use the 25th percentile (lower quartile) of measured k values,
 * not the median, because most observed cooling is from HVAC off-cycles which
 * are much faster than the building envelope's natural heat loss. The lower
 * quartile better represents true building-envelope cooling. We also cap k
 * at MAX_BUILDING_K to prevent unrealistic projections.
 */

// A typical well-insulated building loses ~2–3% of its inside-outside ΔT per hour.
// Poorly insulated might be 5–8%. We cap at 0.04/hr so that a 70°F room with
// 30°F outside (ΔT=40) drops at most ~1.6°F/hr from envelope loss alone.
const MAX_BUILDING_K = 0.04;

function estimateCoolingConstant(
  readings: { tempF: number; timestamp: number }[],
  outsideTempF: number
): number {
  if (readings.length < 3) return 0.015; // Conservative default

  const kValues: number[] = [];
  for (let i = 1; i < readings.length; i++) {
    const dtHours = (readings[i].timestamp - readings[i - 1].timestamp) / (1000 * 60 * 60);
    if (dtHours <= 0 || dtHours > 2) continue; // Skip gaps

    const dT = readings[i].tempF - readings[i - 1].tempF;
    const avgInside = (readings[i].tempF + readings[i - 1].tempF) / 2;
    const deltaFromOutside = avgInside - outsideTempF;

    if (Math.abs(deltaFromOutside) < 5) continue; // Need meaningful ΔT
    
    const ratePerHour = dT / dtHours;
    const k = -ratePerHour / deltaFromOutside;
    // Only keep positive k (actual cooling when inside > outside)
    if (k > 0.001 && k < 0.5) {
      kValues.push(k);
    }
  }

  if (kValues.length === 0) return 0.015;

  // Use 25th percentile — lower values better represent the building envelope,
  // while higher values are HVAC off-cycle artifacts
  kValues.sort((a, b) => a - b);
  const q1Idx = Math.floor(kValues.length * 0.25);
  const rawK = kValues[q1Idx];

  // Cap at realistic building value
  return Math.min(rawK, MAX_BUILDING_K);
}

/**
 * Interpolate outside temperature at a given timestamp from forecast data.
 *
 * Important edge case: before the first forecast anchor, blend from the
 * current outside temperature to that first anchor instead of extrapolating
 * across the whole forecast horizon. That avoids fake jumps a few hours into
 * the night when the first 3-hour forecast point arrives.
 */
export function interpolateOutsideTemp(
  ts: number,
  currentTimestamp: number,
  outsideNowF: number,
  outsideForecast: ForecastPoint[]
): number {
  if (outsideForecast.length === 0) return outsideNowF;

  const first = outsideForecast[0];
  const last = outsideForecast[outsideForecast.length - 1];

  if (ts <= currentTimestamp) return outsideNowF;

  if (ts <= first.timestamp) {
    const span = first.timestamp - currentTimestamp;
    if (span <= 0) return first.tempF;
    const frac = clamp((ts - currentTimestamp) / span, 0, 1);
    return outsideNowF + frac * (first.tempF - outsideNowF);
  }

  if (ts >= last.timestamp) return last.tempF;

  for (let j = 0; j < outsideForecast.length - 1; j++) {
    const before = outsideForecast[j];
    const after = outsideForecast[j + 1];
    if (before.timestamp <= ts && after.timestamp >= ts) {
      const span = after.timestamp - before.timestamp;
      if (span <= 0) return before.tempF;
      const frac = clamp((ts - before.timestamp) / span, 0, 1);
      return before.tempF + frac * (after.tempF - before.tempF);
    }
  }

  return last.tempF;
}

/**
 * Project room temperature forward using a blended HVAC-aware model.
 *
 * The key insight: pure Newton's cooling (T → T_outside) models a room
 * where the HVAC has FAILED. But in reality the HVAC is running and
 * actively maintaining temperature. The observed linear trend already
 * reflects the HVAC's real-world ability to keep up.
 *
 * Strategy:
 *   • Near-term (0–6h): primarily use the observed trend (°F/hr).
 *     If the room is stable, the projection stays stable.
 *   • Mid-term (6–12h): blend in the outside forecast's influence.
 *     If outside is forecast to drop 15°F overnight, we model a mild
 *     pull downward (HVAC has to work harder), but NOT a free-fall.
 *   • Long-term (12–24h): stronger weather influence, still bounded.
 *
 * The projection floor is clamped to:
 *     T_floor = T_outside + HVAC_MARGIN
 * because even a struggling HVAC maintains some margin above outside.
 * (HVAC_MARGIN = 15°F, representing a worst-case undersized system.)
 */
const HVAC_MARGIN_F = 15; // Even a struggling HVAC keeps rooms this far above outside

function projectTemperature(
  currentTempF: number,
  currentTimestamp: number,
  k: number,
  hoursAhead: number,
  outsideNowF: number,
  outsideForecast: ForecastPoint[],
  trendPerHourF: number = 0,
  trendR2: number = 0
): { timestamp: number; tempF: number }[] {
  const points: { timestamp: number; tempF: number }[] = [];
  const stepMs = 30 * 60 * 1000; // 30-minute steps
  const steps = Math.ceil(hoursAhead * 2);
  // Freeze forecasting only cares about downward risk. If the recent
  // regression is positive (room warming up), don't extrapolate that upward
  // into an overnight "heat spike" — treat it as stable instead.
  const coolingTrendPerHourF = Math.min(trendPerHourF, 0);
  // When it's warm outside there is no freeze scenario — AC holds the setpoint.
  // Weather-pull physics only run when outside is actually cold enough to matter.
  const freezeSeason = outsideNowF <= 45;

  for (let i = 1; i <= steps; i++) {
    const ts = currentTimestamp + i * stepMs;
    const tHours = (i * stepMs) / (1000 * 60 * 60);

    const trendDamping = Math.exp(-tHours / 8);
    const trendProjectedF = currentTempF + coolingTrendPerHourF * tHours * trendDamping;

    if (!freezeSeason) {
      // Warm weather: hold at the current indoor reading. Do not invent a
      // multi-degree overnight cool-down from a noisy regression slope
      // (common after history gaps when the laptop/push-server was offline).
      points.push({ timestamp: ts, tempF: Math.round(currentTempF * 10) / 10 });
      continue;
    }

    const outsideF = interpolateOutsideTemp(ts, currentTimestamp, outsideNowF, outsideForecast);

    const coldOutside = outsideF < currentTempF;
    const newtonRawF = outsideF + (currentTempF - outsideF) * Math.exp(-k * tHours);
    const newtonF = coldOutside
      ? Math.max(newtonRawF, outsideF + HVAC_MARGIN_F)
      : Math.min(newtonRawF, currentTempF + 1);

    const trendConfidence = clamp(trendR2, 0.1, 1.0);
    const trendWeight = trendConfidence * Math.exp(-tHours / 10);
    const weatherWeight = 1 - trendWeight;

    let blendedF = trendWeight * trendProjectedF + weatherWeight * newtonF;

    if (coldOutside) {
      const hardFloor = outsideF + (coolingTrendPerHourF < -0.5 ? 5 : HVAC_MARGIN_F);
      // Floor only prevents dropping too low — never push the room UP.
      if (hardFloor <= currentTempF) {
        blendedF = Math.max(blendedF, hardFloor);
      }
    } else {
      blendedF = Math.min(blendedF, Math.max(currentTempF, trendProjectedF) + 2);
    }

    points.push({ timestamp: ts, tempF: Math.round(blendedF * 10) / 10 });
  }

  return points;
}

/**
 * Calculate hours until temperature reaches a threshold, given current temp and trend.
 * Uses the projected curve (Newton's cooling) if available, else linear extrapolation.
 */
function hoursToThreshold(
  currentTempF: number,
  thresholdF: number,
  projectedCurve: { timestamp: number; tempF: number }[],
  currentTimestamp: number
): number | null {
  // Already at or below threshold
  if (currentTempF <= thresholdF) return 0;

  // Walk the projected curve to find when it crosses
  for (const point of projectedCurve) {
    if (point.tempF <= thresholdF) {
      const hours = (point.timestamp - currentTimestamp) / (1000 * 60 * 60);
      return Math.round(hours * 10) / 10;
    }
  }

  // Never reaches threshold in forecast window
  return null;
}

/**
 * Calculate cumulative freezing-degree-hours from readings.
 * FDH = Σ max(0, 32 - T) × Δt_hours
 */
function calculateFreezingDegreeHours(
  readings: { tempF: number; timestamp: number }[]
): number {
  let fdh = 0;
  for (let i = 1; i < readings.length; i++) {
    const dtHours = (readings[i].timestamp - readings[i - 1].timestamp) / (1000 * 60 * 60);
    if (dtHours <= 0 || dtHours > 2) continue;
    const avgTemp = (readings[i].tempF + readings[i - 1].tempF) / 2;
    if (avgTemp < 32) {
      fdh += (32 - avgTemp) * dtHours;
    }
  }
  return Math.round(fdh * 10) / 10;
}

/**
 * Determine burst risk level from freezing-degree-hours and pipe material.
 */
function burstRiskLevel(fdh: number, material: PipeMaterial): RoomFreezeProfile['burstRisk'] {
  const [low, mod, high, crit] = BURST_RISK_THRESHOLDS[material];
  if (fdh >= crit) return 'critical';
  if (fdh >= high) return 'high';
  if (fdh >= mod) return 'moderate';
  if (fdh >= low) return 'low';
  return 'none';
}

/**
 * Detect recovery events: periods where temperature rose from a cold dip
 * back toward the setpoint. Returns the most recent recovery rate.
 */
function detectRecovery(
  readings: { tempF: number; timestamp: number }[],
  setpointF: number
): { rateF: number; minutes: number } | null {
  if (readings.length < 5) return null;

  // Find the most recent local minimum (cold dip)
  let minIdx = -1;
  let minTemp = Infinity;

  for (let i = readings.length - 2; i >= 1; i--) {
    if (readings[i].tempF < readings[i - 1].tempF && readings[i].tempF < readings[i + 1].tempF) {
      if (readings[i].tempF < minTemp) {
        minIdx = i;
        minTemp = readings[i].tempF;
        break; // Most recent dip
      }
    }
  }

  if (minIdx < 0 || minTemp >= setpointF - 2) return null; // No meaningful dip

  // Walk forward from the dip to find recovery
  let peakIdx = minIdx;
  for (let i = minIdx + 1; i < readings.length; i++) {
    if (readings[i].tempF > readings[peakIdx].tempF) {
      peakIdx = i;
    }
    if (readings[i].tempF >= setpointF - 1) break; // Recovered to near setpoint
  }

  if (peakIdx <= minIdx) return null;

  const tempRise = readings[peakIdx].tempF - readings[minIdx].tempF;
  const timeMinutes = (readings[peakIdx].timestamp - readings[minIdx].timestamp) / (1000 * 60);
  if (tempRise < 2 || timeMinutes < 5) return null;

  const rateF = tempRise / (timeMinutes / 60); // °F/hr
  return { rateF: Math.round(rateF * 10) / 10, minutes: Math.round(timeMinutes) };
}

// ─── Core Analysis ────────────────────────────────────────────────

/**
 * Group sensor readings by device, converting to °F, within a time window.
 */
function groupReadingsByDevice(
  readings: SensorReading[],
  devices: ShellyDevice[],
  hoursBack: number
): Map<string, { tempF: number; timestamp: number }[]> {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const deviceMap = new Map(devices.map(d => [d.deviceId, d]));
  const groups = new Map<string, { tempF: number; timestamp: number }[]>();

  for (const r of readings) {
    if (r.temperature == null) continue;
    const ts = r.timestamp.getTime();
    if (ts < cutoff) continue;
    if (!deviceMap.has(r.deviceId)) continue;

    if (!groups.has(r.deviceId)) groups.set(r.deviceId, []);
    groups.get(r.deviceId)!.push({ tempF: cToF(r.temperature), timestamp: ts });
  }

  for (const arr of groups.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }

  return groups;
}

/**
 * Main freeze forecast analysis function.
 */
export function analyzeFreezeForecast(
  devices: ShellyDevice[],
  readings: SensorReading[],
  outsideTempF: number | null,
  outsideForecast: ForecastPoint[] = [],
  config: FreezeForecastConfig = DEFAULT_FREEZE_CONFIG,
  hoursBack: number = 24
): FreezeForecastResult | null {
  const groups = groupReadingsByDevice(readings, devices, hoursBack);
  const tempDevices = devices.filter(d =>
    groups.has(d.deviceId) && groups.get(d.deviceId)!.length >= 3
  );

  if (tempDevices.length === 0) return null;

  const effectiveOutside = outsideTempF ?? 40; // Fallback if no weather data
  const now = Date.now();

  // ─── Per-room analysis ──────────────────────────────────────────

  const rooms: RoomFreezeProfile[] = tempDevices.map(device => {
    const deviceReadings = groups.get(device.deviceId)!;
    const latestReading = deviceReadings[deviceReadings.length - 1];
    const currentTempF = latestReading.tempF;

    // 1. Linear regression for trend — only use recent, fairly dense samples
    // so an overnight outage doesn't become a fake °F/hr cool-down.
    const trendWindow = config.trendWindowHours * 60 * 60 * 1000;
    const trendCutoff = now - trendWindow;
    const trendReadings = deviceReadings.filter(r => r.timestamp >= trendCutoff);
    const latestReadingAgeMs = now - latestReading.timestamp;
    const trendSpanMs = trendReadings.length >= 2
      ? trendReadings[trendReadings.length - 1].timestamp - trendReadings[0].timestamp
      : 0;
    const trendUsable = latestReadingAgeMs <= 2 * 60 * 60 * 1000
      && trendReadings.length >= 4
      && trendSpanMs >= 45 * 60 * 1000;
    const regressionPoints = trendUsable
      ? trendReadings.map(r => ({
        x: (r.timestamp - trendCutoff) / (1000 * 60 * 60), // hours since cutoff
        y: r.tempF,
      }))
      : [];
    const regression = trendUsable
      ? linearRegression(regressionPoints)
      : { slope: 0, intercept: currentTempF, r2: 0 };

    // 2. Cooling constant from Newton's law
    const k = estimateCoolingConstant(deviceReadings, effectiveOutside);

    // 3. Project temperature forward (HVAC-aware blended model)
    const projected = projectTemperature(
      currentTempF,
      now,
      k,
      config.forecastHoursAhead,
      effectiveOutside,
      outsideForecast,
      regression.slope,  // observed °F/hr trend
      regression.r2       // trend confidence
    );

    // 4. Hours to thresholds
    const hToWarning = hoursToThreshold(currentTempF, FREEZE_THRESHOLDS.warningF, projected, now);
    const hToFreezing = hoursToThreshold(currentTempF, FREEZE_THRESHOLDS.freezingF, projected, now);
    const hToBurst = hoursToThreshold(currentTempF, FREEZE_THRESHOLDS.pipeBurstF, projected, now);
    const hToExtreme = hoursToThreshold(currentTempF, FREEZE_THRESHOLDS.extremeColdF, projected, now);

    // 5. Freezing-degree-hours (with pipe age multiplier)
    const rawFdh = calculateFreezingDegreeHours(deviceReadings);
    const ageMultiplier = pipeAgeMultiplier(config.pipeAgeYears);
    const fdh = rawFdh * ageMultiplier;
    const burstRisk = burstRiskLevel(fdh, config.pipeMaterial);

    // 6. Recovery analysis
    const recovery = detectRecovery(deviceReadings, config.thermostatSetpointF);

    // 7. Build projected curve (actual + forecast)
    const projectedCurve: RoomFreezeProfile['projectedCurve'] = [
      // Actual readings (sampled for chart)
      ...deviceReadings
        .filter((_, i) => i % Math.max(1, Math.floor(deviceReadings.length / 60)) === 0)
        .map(r => ({
          timestamp: r.timestamp,
          time: new Date(r.timestamp).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          actualF: Math.round(r.tempF * 10) / 10,
          projectedF: undefined as number | undefined,
        })),
      // Projected readings
      ...projected.map(p => ({
        timestamp: p.timestamp,
        time: new Date(p.timestamp).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        actualF: undefined as number | undefined,
        projectedF: p.tempF,
      })),
    ];

    // 8. Confidence
    let confidence = 15;
    confidence += Math.min(20, trendReadings.length * 1.5);
    confidence += regression.r2 * 25; // Higher R² = more confident trend
    confidence += outsideTempF != null ? 10 : 0;
    confidence += outsideForecast.length > 0 ? 15 : 0;
    confidence += k > 0.01 && k < 0.5 ? 10 : 0; // Reasonable cooling constant
    confidence += hoursBack >= 12 ? 5 : 0;
    confidence = clamp(Math.round(confidence), 10, 95);

    // 9. Recommendation
    let recommendation: string;
    if (currentTempF <= FREEZE_THRESHOLDS.extremeColdF) {
      recommendation = 'EXTREME COLD: Pipes are in imminent burst danger. Shut off water main NOW. Open all faucets to relieve pressure. If occupied, increase heat to maximum and use space heaters near exposed pipes. Call a plumber immediately.';
    } else if (currentTempF <= FREEZE_THRESHOLDS.pipeBurstF) {
      recommendation = 'EMERGENCY: Pipes may already be freezing. Shut off the water main immediately if possible. Open all faucets to relieve pressure. Call a plumber. If property is occupied, increase heat to maximum.';
    } else if (currentTempF <= FREEZE_THRESHOLDS.freezingF) {
      recommendation = 'URGENT: Temperature is at or below freezing. Open cabinet doors under sinks. Let all faucets drip slowly (both hot and cold). Increase thermostat to 65°F+. Check that heating is running.';
    } else if (hToFreezing != null && hToFreezing < 6) {
      recommendation = `Freezing projected in ~${hToFreezing.toFixed(1)} hours. Increase heating now. Open cabinet doors to expose pipes. Let faucets drip. If leaving the property, do NOT set thermostat below 55°F.`;
    } else if (hToWarning != null && hToWarning < 12) {
      recommendation = 'Temperature trending toward warning zone. Ensure heating system is operational. Check that all windows and doors are sealed. Consider increasing thermostat by a few degrees overnight.';
    } else if (fdh > 0) {
      recommendation = `Pipes have accumulated ${fdh.toFixed(0)} freezing-degree-hours. Monitor closely. Even if temperature has recovered, residual ice in pipes may still cause issues during the next freeze.`;
    } else {
      recommendation = 'No freeze risk detected. Temperatures are well above freezing thresholds.';
    }

    return {
      deviceId: device.deviceId,
      deviceName: device.name,
      currentTempF: Math.round(currentTempF * 10) / 10,
      trendPerHourF: Math.round(regression.slope * 100) / 100,
      trendR2: Math.round(regression.r2 * 100) / 100,
      coolingConstantK: Math.round(k * 10000) / 10000,
      hoursToWarning: hToWarning,
      hoursToFreezing: hToFreezing,
      hoursToPipeBurst: hToBurst,
      hoursToExtremeCold: hToExtreme,
      isFreezing: currentTempF <= FREEZE_THRESHOLDS.freezingF,
      isPipeBurstZone: currentTempF <= FREEZE_THRESHOLDS.pipeBurstF,
      isExtremeCold: currentTempF <= FREEZE_THRESHOLDS.extremeColdF,
      pipeAgeMultiplier: ageMultiplier,
      freezingDegreeHours: fdh,
      burstRisk,
      projectedCurve,
      recoveryRateF: recovery?.rateF ?? null,
      recoveryMinutes: recovery?.minutes ?? null,
      confidence,
      dataPoints: deviceReadings.length,
      recommendation,
    };
  });

  // ─── Build combined chart data ──────────────────────────────────

  // Collect all timestamps (actual + projected) across all rooms
  const allTimestamps = new Set<number>();
  for (const room of rooms) {
    for (const p of room.projectedCurve) {
      allTimestamps.add(p.timestamp);
    }
  }
  // Add outside forecast points
  for (const fp of outsideForecast) {
    allTimestamps.add(fp.timestamp);
  }

  const sortedTimestamps = Array.from(allTimestamps).sort();

  // Bucket to ~100 chart points max
  const step = Math.max(1, Math.floor(sortedTimestamps.length / 100));
  const chartTimestamps = sortedTimestamps.filter((_, i) => i % step === 0);

  const chartData: FreezeChartPoint[] = chartTimestamps.map(ts => {
    const deviceActual: Record<string, number> = {};
    const deviceProjected: Record<string, number> = {};

    for (const room of rooms) {
      const safeName = room.deviceName.replace(/[^a-zA-Z0-9]/g, '_');
      // Find closest curve point
      let closest: (typeof room.projectedCurve)[0] | null = null;
      let closestDist = Infinity;
      for (const p of room.projectedCurve) {
        const dist = Math.abs(p.timestamp - ts);
        if (dist < closestDist) {
          closestDist = dist;
          closest = p;
        }
      }
      if (closest && closestDist < 60 * 60 * 1000) { // Within 1 hour
        if (closest.actualF != null) deviceActual[safeName] = closest.actualF;
        if (closest.projectedF != null) deviceProjected[safeName] = closest.projectedF;
      }
    }

    // Outside temp
    let outsideF: number | undefined;
    let outsideForecastF: number | undefined;
    if (ts <= now && outsideTempF != null) {
      outsideF = outsideTempF; // Constant for past (simplified)
    }
    if (outsideForecast.length > 0) {
      let closestFP: ForecastPoint | null = null;
      let closestDist = Infinity;
      for (const fp of outsideForecast) {
        const dist = Math.abs(fp.timestamp - ts);
        if (dist < closestDist) {
          closestDist = dist;
          closestFP = fp;
        }
      }
      if (closestFP && closestDist < 3 * 60 * 60 * 1000) {
        outsideForecastF = closestFP.tempF;
      }
    }

    return {
      timestamp: ts,
      time: new Date(ts).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      outsideF,
      outsideForecastF,
      deviceActual,
      deviceProjected,
    };
  });

  // ─── Aggregate results ──────────────────────────────────────────

  const urgentRooms = rooms.filter(r => r.hoursToFreezing != null).sort((a, b) =>
    (a.hoursToFreezing ?? Infinity) - (b.hoursToFreezing ?? Infinity)
  );
  const mostUrgent = urgentRooms[0] || null;

  const allTimes = rooms
    .map(r => r.hoursToFreezing)
    .filter((t): t is number => t != null);
  const shortestTime = allTimes.length > 0 ? Math.min(...allTimes) : null;

  const worstBurst = rooms.reduce((w, r) => {
    const order = ['none', 'low', 'moderate', 'high', 'critical'];
    return order.indexOf(r.burstRisk) > order.indexOf(w) ? r.burstRisk : w;
  }, 'none' as RoomFreezeProfile['burstRisk']);

  let overallRisk: FreezeForecastResult['overallRisk'] = 'none';
  if (rooms.some(r => r.isPipeBurstZone) || worstBurst === 'critical') overallRisk = 'critical';
  else if (rooms.some(r => r.isFreezing) || worstBurst === 'high') overallRisk = 'high';
  else if (shortestTime != null && shortestTime < 12) overallRisk = 'moderate';
  else if (shortestTime != null && shortestTime < 24) overallRisk = 'low';

  // Outside forecast min
  let lowestForecastTempF: number | null = null;
  let lowestForecastTime: string | null = null;
  if (outsideForecast.length > 0) {
    const lowest = outsideForecast.reduce((min, p) => p.tempF < min.tempF ? p : min, outsideForecast[0]);
    lowestForecastTempF = Math.round(lowest.tempF * 10) / 10;
    lowestForecastTime = new Date(lowest.timestamp).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  return {
    analyzedAt: new Date(),
    rooms,
    outsideTempF: outsideTempF != null ? Math.round(outsideTempF * 10) / 10 : null,
    outsideForecast,
    lowestForecastTempF,
    lowestForecastTime,
    mostUrgentRoom: mostUrgent?.deviceId ?? null,
    shortestTimeToFreeze: shortestTime,
    overallRisk,
    hoursAnalyzed: hoursBack,
    sensorCount: tempDevices.length,
    chartData,
  };
}

// ─── Weather Fetch ────────────────────────────────────────────────

/**
 * Fetch current outside temperature + 5-day/3-hour forecast from OpenWeather.
 */
export async function fetchWeatherForecast(
  lat: number,
  lng: number,
  apiKey: string
): Promise<{
  current: { tempF: number; description: string };
  forecast: ForecastPoint[];
} | null> {
  try {
    // Fetch current + forecast in parallel
    const [currentRes, forecastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}&units=imperial`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&appid=${apiKey}&units=imperial`),
    ]);

    if (!currentRes.ok || !forecastRes.ok) return null;

    const [currentData, forecastData] = await Promise.all([currentRes.json(), forecastRes.json()]);

    const current = {
      tempF: currentData.main?.temp ?? 40,
      description: currentData.weather?.[0]?.description ?? '',
    };

    const forecast: ForecastPoint[] = (forecastData.list || []).map((entry: any) => ({
      timestamp: entry.dt * 1000, // Convert unix seconds to ms
      tempF: entry.main?.temp ?? 40,
    }));

    return { current, forecast };
  } catch {
    return null;
  }
}

// ─── Exports for UI ───────────────────────────────────────────────

export { BURST_RISK_COLORS, PIPE_MATERIAL_LABELS };
