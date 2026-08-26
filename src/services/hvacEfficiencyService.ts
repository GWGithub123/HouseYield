/**
 * HVAC Efficiency Tracker Service
 *
 * Analyzes HVAC performance from indoor sensor data + outside temperature:
 *   1. Cycle Detection — frequency, amplitude, duty cycle, short-cycling detection
 *   2. Setpoint Deviation & Comfort Score — inferred setpoint, time-of-day breakdown
 *   3. Load-Performance Curve — performance vs. thermal load, capacity knee-point
 *   4. Response Time & Recovery — lag, recovery °F/hr, overshoot
 *   5. Cost & Degradation — degree-day cost model, week-over-week health trend
 *
 * Data sources:
 *   - Indoor: Shelly BLU H&T sensors (per-room temp every ~5 min)
 *   - Outdoor: OpenWeather API (current + historical daily)
 *   - History: Firestore sensor_readings collection
 */

import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';

// ─── Types ────────────────────────────────────────────────────────

export type HvacSystemType = 'electric_resistance' | 'heat_pump' | 'gas_furnace' | 'oil_furnace';

export interface HvacEfficiencyConfig {
  /** HVAC system type — affects COP and cost model */
  hvacSystemType: HvacSystemType;
  /** Electricity rate $/kWh */
  electricRate: number;
  /** Gas rate $/therm */
  gasRate: number;
  /** Comfort band: ± °F from inferred setpoint that counts as "comfortable" */
  comfortBandF: number;
  /** Short-cycling threshold: cycles per hour to flag */
  shortCycleThreshold: number;
  /** Minimum cycle duration to detect (minutes) — shorter than this is noise */
  minCycleDurationMin: number;
  /** Manual thermostat setpoint override (°F). When set, replaces inferred setpoint for all analysis. */
  setpointOverrideF?: number;
}

export interface CycleInfo {
  /** Start timestamp of the cycle */
  startTs: number;
  /** End timestamp */
  endTs: number;
  /** Duration in minutes */
  durationMin: number;
  /** Peak temperature in the cycle (°F) */
  peakF: number;
  /** Trough temperature in the cycle (°F) */
  troughF: number;
  /** Amplitude (peak - trough) */
  amplitudeF: number;
  /** Phase: 'heating' = rising, 'cooling' = falling */
  phase: 'heating' | 'cooling';
}

export interface CycleProfile {
  /** Detected cycles */
  cycles: CycleInfo[];
  /** Average cycles per hour */
  cyclesPerHour: number;
  /** Average amplitude (°F swing per cycle) */
  avgAmplitudeF: number;
  /** Duty cycle: fraction of time HVAC appears to be active (0–1) */
  dutyCycle: number;
  /** Standard deviation of cycle period (minutes) — regularity metric */
  periodStdDevMin: number;
  /** Is the system short-cycling? */
  isShortCycling: boolean;
  /** Short-cycling severity description */
  shortCyclingNote: string;
}

export interface ComfortBucket {
  label: string;
  /** Start hour (24h) */
  startHour: number;
  /** End hour (24h) */
  endHour: number;
  /** Comfort score 0–100 for this bucket */
  score: number;
  /** Average deviation from setpoint °F */
  avgDeviationF: number;
  /** Minutes in this bucket */
  totalMinutes: number;
  /** Minutes within comfort band */
  comfortMinutes: number;
}

export interface ComfortAnalysis {
  /** Inferred thermostat setpoint (°F) — mode of temperature distribution */
  inferredSetpointF: number;
  /** Overall comfort score 0–100 */
  overallScore: number;
  /** Time-of-day comfort breakdown */
  buckets: ComfortBucket[];
  /** Comfort score by hour (0–23) for heatmap */
  hourlyScores: number[];
  /** Daily comfort scores (for trend) */
  dailyScores: { date: string; score: number }[];
}

export interface LoadPerformancePoint {
  /** Outside-inside delta (°F) — the thermal load */
  loadDeltaF: number;
  /** Performance score 0–100 (how well setpoint is maintained) */
  performance: number;
  /** Time bucket this point represents */
  timestamp: number;
}

export interface LoadPerformanceCurve {
  /** Raw data points */
  points: LoadPerformancePoint[];
  /** The "knee point" — ΔT where performance starts dropping below 80% */
  kneePointDeltaF: number | null;
  /** Performance at maximum observed load */
  performanceAtMaxLoad: number;
  /** Maximum observed load ΔT */
  maxLoadDeltaF: number;
  /** Capacity rating description */
  capacityRating: string;
}

export interface RecoveryEvent {
  /** Timestamp of the recovery start (cold/hot dip) */
  startTs: number;
  /** Timestamp of recovery completion (back to setpoint) */
  endTs: number;
  /** Temperature at start of recovery (°F) */
  startTempF: number;
  /** Temperature at end of recovery (°F) */
  endTempF: number;
  /** Recovery rate °F/hr */
  rateF: number;
  /** Duration in minutes */
  durationMin: number;
  /** Overshoot beyond setpoint (°F) — 0 if none */
  overshootF: number;
}

export interface RecoveryAnalysis {
  /** Detected recovery events */
  events: RecoveryEvent[];
  /** Average recovery rate °F/hr */
  avgRecoveryRateF: number;
  /** Average overshoot °F */
  avgOvershootF: number;
  /** Average thermal lag (minutes from outside temp drop to inside response) */
  avgThermalLagMin: number;
}

export interface DegradationPoint {
  /** Date string YYYY-MM-DD */
  date: string;
  /** Health score for that day */
  healthScore: number;
  /** Duty cycle for that day */
  dutyCycle: number;
  /** Comfort score for that day */
  comfortScore: number;
  /** Outside avg temp for that day */
  outsideAvgF: number | null;
}

export interface CostAnalysis {
  /** Heating degree-days accumulated */
  heatingDegreeDays: number;
  /** Cooling degree-days accumulated */
  coolingDegreeDays: number;
  /** Estimated monthly cost at current rate ($/month) */
  estimatedMonthlyCost: number;
  /** Estimated cost for an "efficient" baseline system */
  efficientBaselineCost: number;
  /** The inefficiency tax $/month */
  inefficiencyTaxPerMonth: number;
  /** Annualized inefficiency cost */
  inefficiencyTaxPerYear: number;
}

export interface RoomHvacProfile {
  deviceId: string;
  deviceName: string;
  /** Current temperature °F */
  currentTempF: number;
  /** HVAC Health Score 0–100 */
  healthScore: number;
  /** Cycle detection results */
  cycleProfile: CycleProfile;
  /** Comfort analysis */
  comfort: ComfortAnalysis;
  /** Recovery analysis */
  recovery: RecoveryAnalysis;
  /** Cost analysis */
  cost: CostAnalysis;
  /** Data confidence 0–100 */
  confidence: number;
  /** Number of readings used */
  dataPoints: number;
  /** Top maintenance recommendation */
  recommendation: string;
  /** Recommendation urgency */
  urgency: 'info' | 'low' | 'moderate' | 'high' | 'critical';
}

export interface HvacEfficiencyResult {
  analyzedAt: Date;
  rooms: RoomHvacProfile[];
  /** Load-performance curve (aggregated across all rooms) */
  loadPerformance: LoadPerformanceCurve;
  /** Degradation trend (day-by-day health) */
  degradationTrend: DegradationPoint[];
  /** Overall HVAC health score (weighted average across rooms) */
  overallHealthScore: number;
  /** Overall monthly cost impact */
  overallInefficiencyCost: number;
  /** Combined cycle chart data */
  cycleChartData: CycleChartPoint[];
  /** Comfort heatmap data — [hour][dayOfWeek] → score */
  comfortHeatmap: number[][];
  /** Outside temperature used */
  outsideTempF: number | null;
  sensorCount: number;
  hoursAnalyzed: number;
  overallRisk: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
}

export interface CycleChartPoint {
  timestamp: number;
  time: string;
  /** Per device temperature */
  devices: Record<string, number>;
  /** Per device detected HVAC state: 1 = ON, 0 = OFF */
  hvacState: Record<string, number>;
}

// ─── Constants ────────────────────────────────────────────────────

export const DEFAULT_HVAC_CONFIG: HvacEfficiencyConfig = {
  hvacSystemType: 'heat_pump',
  electricRate: 0.16,
  gasRate: 1.20,
  comfortBandF: 1.5,
  shortCycleThreshold: 4,
  minCycleDurationMin: 5,
};

/** COP (Coefficient of Performance) by system type — how many BTU of heating per BTU of energy input */
const SYSTEM_COP: Record<HvacSystemType, number> = {
  electric_resistance: 1.0,
  heat_pump: 2.8,
  gas_furnace: 0.92, // AFUE
  oil_furnace: 0.85,
};

const SYSTEM_LABELS: Record<HvacSystemType, string> = {
  electric_resistance: 'Electric Resistance',
  heat_pump: 'Heat Pump',
  gas_furnace: 'Gas Furnace',
  oil_furnace: 'Oil Furnace',
};

const HEALTH_COLORS: Record<HvacEfficiencyResult['overallRisk'], string> = {
  excellent: '#22c55e',
  good: '#84cc16',
  fair: '#eab308',
  poor: '#f97316',
  critical: '#ef4444',
};

// ─── Helpers ──────────────────────────────────────────────────────

function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/**
 * Find the mode of a numeric array (most common value, rounded to 0.5°F bins).
 * Used to infer the thermostat setpoint.
 */
function tempMode(temps: number[]): number {
  const bins = new Map<number, number>();
  for (const t of temps) {
    const bin = Math.round(t * 2) / 2; // 0.5°F bins
    bins.set(bin, (bins.get(bin) || 0) + 1);
  }
  let maxCount = 0;
  let modeBin = temps[0] || 68;
  for (const [bin, count] of bins) {
    if (count > maxCount) {
      maxCount = count;
      modeBin = bin;
    }
  }
  return modeBin;
}

// ─── Layer 1: Cycle Detection ─────────────────────────────────────

/**
 * Detect local minima and maxima in a temperature series to identify HVAC cycles.
 * A cycle = one trough→peak (heating phase) or peak→trough (cooling phase).
 *
 * Filtering rules to reject non-HVAC events (showers, cooking, open doors):
 *  1. Amplitude must be between 0.5°F and 5°F (HVAC thermostat dead band)
 *  2. Extrema must stay within ±4°F of the inferred setpoint (mode temperature)
 *  3. Use 5-point smoothing to reduce noise
 *  4. Require a minimum 0.3°F prominence for extrema detection
 */
function detectCycles(
  readings: { tempF: number; timestamp: number }[],
  minCycleDurationMin: number
): CycleInfo[] {
  if (readings.length < 10) return [];

  // Infer the thermostat setpoint as the temperature mode
  const setpoint = tempMode(readings.map(r => r.tempF));

  // Smooth with a 5-point moving average to reduce sensor noise
  const smoothed: { tempF: number; timestamp: number }[] = [];
  for (let i = 2; i < readings.length - 2; i++) {
    smoothed.push({
      tempF: (readings[i - 2].tempF + readings[i - 1].tempF + readings[i].tempF + readings[i + 1].tempF + readings[i + 2].tempF) / 5,
      timestamp: readings[i].timestamp,
    });
  }

  // Find local extrema (min/max) with tighter prominence threshold
  type Extremum = { type: 'min' | 'max'; tempF: number; timestamp: number };
  const extrema: Extremum[] = [];
  const PROMINENCE = 0.3; // Minimum °F change to qualify as an extremum

  for (let i = 1; i < smoothed.length - 1; i++) {
    const prev = smoothed[i - 1].tempF;
    const curr = smoothed[i].tempF;
    const next = smoothed[i + 1].tempF;

    if (curr <= prev && curr <= next && curr < prev - PROMINENCE) {
      extrema.push({ type: 'min', tempF: curr, timestamp: smoothed[i].timestamp });
    } else if (curr >= prev && curr >= next && curr > prev + PROMINENCE) {
      extrema.push({ type: 'max', tempF: curr, timestamp: smoothed[i].timestamp });
    }
  }

  // Merge adjacent same-type extrema (keep the more extreme one)
  const filtered: Extremum[] = [];
  for (const ex of extrema) {
    if (filtered.length === 0 || filtered[filtered.length - 1].type !== ex.type) {
      filtered.push(ex);
    } else {
      const last = filtered[filtered.length - 1];
      if (ex.type === 'min' && ex.tempF < last.tempF) {
        filtered[filtered.length - 1] = ex;
      } else if (ex.type === 'max' && ex.tempF > last.tempF) {
        filtered[filtered.length - 1] = ex;
      }
    }
  }

  // Build cycles from alternating min/max pairs with HVAC-specific filters
  const MIN_HVAC_AMPLITUDE = 0.5;  // HVAC dead band is at least 0.5°F
  const MAX_HVAC_AMPLITUDE = 5.0;  // Larger swings are external events (showers, doors)
  const MAX_SETPOINT_DEVIATION = 4.0; // Both peak & trough must be near setpoint

  const cycles: CycleInfo[] = [];
  for (let i = 0; i < filtered.length - 1; i++) {
    const a = filtered[i];
    const b = filtered[i + 1];
    const durationMin = (b.timestamp - a.timestamp) / (1000 * 60);
    if (durationMin < minCycleDurationMin) continue;

    const amplitude = Math.abs(b.tempF - a.tempF);

    // Reject if amplitude is outside HVAC range
    if (amplitude < MIN_HVAC_AMPLITUDE || amplitude > MAX_HVAC_AMPLITUDE) continue;

    // Reject if either extremum is too far from setpoint (external event)
    if (Math.abs(a.tempF - setpoint) > MAX_SETPOINT_DEVIATION) continue;
    if (Math.abs(b.tempF - setpoint) > MAX_SETPOINT_DEVIATION) continue;

    const isHeating = (a.type === 'min' && b.type === 'max');
    const peakF = isHeating ? b.tempF : a.tempF;
    const troughF = isHeating ? a.tempF : b.tempF;

    cycles.push({
      startTs: a.timestamp,
      endTs: b.timestamp,
      durationMin: Math.round(durationMin * 10) / 10,
      peakF: Math.round(peakF * 100) / 100,
      troughF: Math.round(troughF * 100) / 100,
      amplitudeF: Math.round(amplitude * 100) / 100,
      phase: isHeating ? 'heating' : 'cooling',
    });
  }

  return cycles;
}

function buildCycleProfile(
  cycles: CycleInfo[],
  totalHours: number,
  shortCycleThreshold: number
): CycleProfile {
  if (cycles.length === 0) {
    return {
      cycles: [],
      cyclesPerHour: 0,
      avgAmplitudeF: 0,
      dutyCycle: 0,
      periodStdDevMin: 0,
      isShortCycling: false,
      shortCyclingNote: 'Insufficient cycle data to analyze.',
    };
  }

  const cyclesPerHour = totalHours > 0 ? cycles.length / totalHours : 0;
  const amplitudes = cycles.map(c => c.amplitudeF);
  const avgAmplitude = mean(amplitudes);

  // Duty cycle: fraction of time in "heating" phase (approximation)
  const heatingCycles = cycles.filter(c => c.phase === 'heating');
  const heatingTime = heatingCycles.reduce((s, c) => s + c.durationMin, 0);
  const totalCycleTime = cycles.reduce((s, c) => s + c.durationMin, 0);
  const dutyCycle = totalCycleTime > 0 ? heatingTime / totalCycleTime : 0.5;

  // Period regularity
  const periods: number[] = [];
  for (let i = 0; i < cycles.length - 1; i++) {
    // Period from one cycle start to the next
    periods.push((cycles[i + 1].startTs - cycles[i].startTs) / (1000 * 60));
  }
  const periodStdDev = stdDev(periods);

  const isShortCycling = cyclesPerHour >= shortCycleThreshold;
  let shortCyclingNote: string;
  if (isShortCycling) {
    shortCyclingNote = `Short-cycling detected: ${cyclesPerHour.toFixed(1)} cycles/hr (threshold: ${shortCycleThreshold}). This accelerates compressor wear, increases energy bills by 10–20%, and reduces comfort.`;
  } else if (cyclesPerHour >= shortCycleThreshold * 0.75) {
    shortCyclingNote = `Borderline cycling rate: ${cyclesPerHour.toFixed(1)} cycles/hr. Monitor for increase.`;
  } else if (cyclesPerHour > 0) {
    shortCyclingNote = `Normal cycling: ${cyclesPerHour.toFixed(1)} cycles/hr.`;
  } else {
    shortCyclingNote = 'No clear HVAC cycles detected in the data window.';
  }

  return {
    cycles,
    cyclesPerHour: Math.round(cyclesPerHour * 100) / 100,
    avgAmplitudeF: Math.round(avgAmplitude * 100) / 100,
    dutyCycle: Math.round(dutyCycle * 1000) / 1000,
    periodStdDevMin: Math.round(periodStdDev * 10) / 10,
    isShortCycling,
    shortCyclingNote,
  };
}

// ─── Layer 2: Comfort Analysis ────────────────────────────────────

function analyzeComfort(
  readings: { tempF: number; timestamp: number }[],
  comfortBandF: number
): ComfortAnalysis {
  if (readings.length < 5) {
    return {
      inferredSetpointF: 68,
      overallScore: 0,
      buckets: [],
      hourlyScores: new Array(24).fill(0),
      dailyScores: [],
    };
  }

  const temps = readings.map(r => r.tempF);
  const setpoint = tempMode(temps);

  // Overall comfort
  const withinBand = readings.filter(r => Math.abs(r.tempF - setpoint) <= comfortBandF).length;
  const overallScore = Math.round((withinBand / readings.length) * 100);

  // Time-of-day buckets
  const bucketDefs = [
    { label: 'Overnight', startHour: 0, endHour: 6 },
    { label: 'Morning', startHour: 6, endHour: 12 },
    { label: 'Afternoon', startHour: 12, endHour: 18 },
    { label: 'Evening', startHour: 18, endHour: 24 },
  ];

  const buckets: ComfortBucket[] = bucketDefs.map(def => {
    const inBucket = readings.filter(r => {
      const h = new Date(r.timestamp).getHours();
      return h >= def.startHour && h < def.endHour;
    });
    const comfortCount = inBucket.filter(r => Math.abs(r.tempF - setpoint) <= comfortBandF).length;
    const deviations = inBucket.map(r => Math.abs(r.tempF - setpoint));

    return {
      ...def,
      score: inBucket.length > 0 ? Math.round((comfortCount / inBucket.length) * 100) : 0,
      avgDeviationF: deviations.length > 0 ? Math.round(mean(deviations) * 100) / 100 : 0,
      totalMinutes: inBucket.length * 5, // ~5min per reading
      comfortMinutes: comfortCount * 5,
    };
  });

  // Hourly scores
  const hourlyScores: number[] = [];
  for (let h = 0; h < 24; h++) {
    const inHour = readings.filter(r => new Date(r.timestamp).getHours() === h);
    const comf = inHour.filter(r => Math.abs(r.tempF - setpoint) <= comfortBandF).length;
    hourlyScores.push(inHour.length > 0 ? Math.round((comf / inHour.length) * 100) : 0);
  }

  // Daily scores
  const dayMap = new Map<string, { total: number; comfort: number }>();
  for (const r of readings) {
    const day = new Date(r.timestamp).toISOString().slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, { total: 0, comfort: 0 });
    const d = dayMap.get(day)!;
    d.total++;
    if (Math.abs(r.tempF - setpoint) <= comfortBandF) d.comfort++;
  }
  const dailyScores = Array.from(dayMap.entries())
    .map(([date, d]) => ({ date, score: Math.round((d.comfort / d.total) * 100) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    inferredSetpointF: setpoint,
    overallScore,
    buckets,
    hourlyScores,
    dailyScores,
  };
}

// ─── Layer 3: Load-Performance Curve ──────────────────────────────

/**
 * Build load-performance points: each hour-bucket gets a load (|setpoint - outside|)
 * and a performance score (100 - avg deviation from setpoint within that hour).
 */
function buildLoadPerformanceCurve(
  roomGroups: { readings: { tempF: number; timestamp: number }[]; setpointF: number }[],
  outsideTempF: number | null
): LoadPerformanceCurve {
  const totalReadings = roomGroups.reduce((s, g) => s + g.readings.length, 0);
  if (outsideTempF == null || totalReadings < 20) {
    return {
      points: [],
      kneePointDeltaF: null,
      performanceAtMaxLoad: 0,
      maxLoadDeltaF: 0,
      capacityRating: 'Insufficient data — need outside temperature and more sensor readings.',
    };
  }

  // Build per-room, per-hour points so each room is scored against its OWN
  // setpoint. This prevents a bathroom shower spike from dragging down the
  // kitchen's performance score.
  const points: LoadPerformancePoint[] = [];

  for (const { readings, setpointF } of roomGroups) {
    // Bucket this room's readings by hour
    const hourBuckets = new Map<number, number[]>();
    for (const r of readings) {
      const hourKey = Math.floor(r.timestamp / (1000 * 60 * 60));
      if (!hourBuckets.has(hourKey)) hourBuckets.set(hourKey, []);
      hourBuckets.get(hourKey)!.push(r.tempF);
    }

    for (const [hourKey, temps] of hourBuckets) {
      const ts = hourKey * 1000 * 60 * 60;
      const hour = new Date(ts).getHours();

      // Diurnal approximation: coldest at 5am, warmest at 3pm
      const diurnalOffset = -5 * Math.cos(((hour - 15) / 24) * 2 * Math.PI);
      const approxOutside = outsideTempF + diurnalOffset;

      const load = Math.abs(setpointF - approxOutside);

      // Performance: what fraction of readings are within the comfort band?
      // Within 1°F = 100%, linearly degrades to 0% at 5°F off setpoint.
      const scores = temps.map(t => {
        const dev = Math.abs(t - setpointF);
        if (dev <= 1.0) return 100;            // within thermostat dead band
        return clamp(100 - ((dev - 1) / 4) * 100, 0, 100);  // 0% at 5°F off
      });
      const perf = scores.reduce((a, b) => a + b, 0) / scores.length;

      points.push({
        loadDeltaF: Math.round(load * 10) / 10,
        performance: Math.round(perf * 10) / 10,
        timestamp: ts,
      });
    }
  }

  // Sort by load
  points.sort((a, b) => a.loadDeltaF - b.loadDeltaF);

  // Find knee point: first load value where performance drops below 80
  let kneePointDeltaF: number | null = null;
  // Use a rolling average of 3 points to reduce noise
  for (let i = 2; i < points.length; i++) {
    const avgPerf = (points[i - 2].performance + points[i - 1].performance + points[i].performance) / 3;
    if (avgPerf < 80) {
      kneePointDeltaF = points[i - 1].loadDeltaF;
      break;
    }
  }

  const maxLoadPoint = points.length > 0 ? points[points.length - 1] : null;

  let capacityRating: string;
  if (kneePointDeltaF != null) {
    capacityRating = `System maintains comfort up to ~${kneePointDeltaF.toFixed(0)}°F differential. Beyond that, performance degrades.`;
  } else if (points.length > 5) {
    capacityRating = 'System maintains comfort across all observed conditions — well-sized for this climate.';
  } else {
    capacityRating = 'Not enough data variation to determine capacity limit.';
  }

  return {
    points,
    kneePointDeltaF,
    performanceAtMaxLoad: maxLoadPoint?.performance ?? 0,
    maxLoadDeltaF: maxLoadPoint?.loadDeltaF ?? 0,
    capacityRating,
  };
}

// ─── Layer 4: Recovery Analysis ───────────────────────────────────

function analyzeRecovery(
  readings: { tempF: number; timestamp: number }[],
  setpointF: number
): RecoveryAnalysis {
  if (readings.length < 10) {
    return { events: [], avgRecoveryRateF: 0, avgOvershootF: 0, avgThermalLagMin: 0 };
  }

  const events: RecoveryEvent[] = [];

  // Find dips: points where temp is at least 2°F below setpoint
  let inDip = false;
  let dipStart = -1;

  for (let i = 0; i < readings.length; i++) {
    const dev = readings[i].tempF - setpointF;
    if (!inDip && dev < -2) {
      inDip = true;
      dipStart = i;
    } else if (inDip && dev >= -0.5) {
      // Recovery complete — back within 0.5°F of setpoint
      if (dipStart >= 0) {
        const startR = readings[dipStart];
        const endR = readings[i];
        const tempRise = endR.tempF - startR.tempF;
        const durationMin = (endR.timestamp - startR.timestamp) / (1000 * 60);

        if (durationMin >= 5 && tempRise > 1) {
          // Check overshoot: look ahead for max above setpoint
          let maxOvershoot = 0;
          for (let j = i; j < Math.min(i + 10, readings.length); j++) {
            const over = readings[j].tempF - setpointF;
            if (over > maxOvershoot) maxOvershoot = over;
            if (over < 0) break; // Dropped back
          }

          events.push({
            startTs: startR.timestamp,
            endTs: endR.timestamp,
            startTempF: Math.round(startR.tempF * 10) / 10,
            endTempF: Math.round(endR.tempF * 10) / 10,
            rateF: Math.round((tempRise / (durationMin / 60)) * 10) / 10,
            durationMin: Math.round(durationMin),
            overshootF: Math.round(maxOvershoot * 10) / 10,
          });
        }
      }
      inDip = false;
      dipStart = -1;
    }
  }

  const rates = events.map(e => e.rateF);
  const overshoots = events.map(e => e.overshootF);

  // Thermal lag: rough estimate from how long after a dip starts before temp begins rising
  // (This is simplified — ideally we'd correlate with outside temp changes)
  const lagEstimates: number[] = [];
  for (const ev of events) {
    // Find the lowest point in the dip window
    const dipReadings = readings.filter(r => r.timestamp >= ev.startTs && r.timestamp <= ev.endTs);
    const minIdx = dipReadings.reduce((mi, r, i) => r.tempF < dipReadings[mi].tempF ? i : mi, 0);
    const lagMin = (dipReadings[minIdx].timestamp - ev.startTs) / (1000 * 60);
    if (lagMin > 0) lagEstimates.push(lagMin);
  }

  return {
    events,
    avgRecoveryRateF: rates.length > 0 ? Math.round(mean(rates) * 10) / 10 : 0,
    avgOvershootF: overshoots.length > 0 ? Math.round(mean(overshoots) * 10) / 10 : 0,
    avgThermalLagMin: lagEstimates.length > 0 ? Math.round(mean(lagEstimates)) : 0,
  };
}

// ─── Layer 5: Cost & Degradation ──────────────────────────────────

function analyzeCost(
  readings: { tempF: number; timestamp: number }[],
  outsideTempF: number | null,
  config: HvacEfficiencyConfig,
  dutyCycle: number
): CostAnalysis {
  if (outsideTempF == null || readings.length < 10) {
    return {
      heatingDegreeDays: 0,
      coolingDegreeDays: 0,
      estimatedMonthlyCost: 0,
      efficientBaselineCost: 0,
      inefficiencyTaxPerMonth: 0,
      inefficiencyTaxPerYear: 0,
    };
  }

  // Approximate degree-days from the analysis window
  const hoursSpanned = (readings[readings.length - 1].timestamp - readings[0].timestamp) / (1000 * 60 * 60);
  const daysSpanned = Math.max(hoursSpanned / 24, 0.5);

  // Use diurnal estimate to get average outside temp
  const avgOutside = outsideTempF; // Simplified — single observation

  const hdd = Math.max(0, 65 - avgOutside) * daysSpanned;
  const cdd = Math.max(0, avgOutside - 65) * daysSpanned;

  // Estimate UA from duty cycle + observed conditions
  // UA ≈ Q / ΔT, and Q is proportional to duty cycle × rated capacity
  // We use a simplified model: assume a typical 36,000 BTU/hr system
  const typicalCapacityBTU = 36_000;
  const deltaT = Math.abs(mean(readings.map(r => r.tempF)) - avgOutside);
  const inferredUA = deltaT > 2
    ? (dutyCycle * typicalCapacityBTU) / deltaT
    : 500; // Default fallback

  // Monthly heating cost: HDD_monthly × UA × 24 / (COP × BTU_per_unit) × rate
  const cop = SYSTEM_COP[config.hvacSystemType];
  const isGas = config.hvacSystemType === 'gas_furnace' || config.hvacSystemType === 'oil_furnace';
  const btuPerUnit = isGas ? 100_000 : 3_412; // therm or kWh
  const rate = isGas ? config.gasRate : config.electricRate;

  const monthlyHDD = daysSpanned > 0 ? (hdd / daysSpanned) * 30 : 0;
  const monthlyCDD = daysSpanned > 0 ? (cdd / daysSpanned) * 30 : 0;
  const monthlyDD = monthlyHDD + monthlyCDD;

  const estimatedMonthlyCost = (monthlyDD * inferredUA * 24) / (cop * btuPerUnit) * rate;

  // Efficient baseline: assume COP is 20% better (well-maintained system)
  const efficientCOP = cop * 1.2;
  const efficientBaselineCost = (monthlyDD * inferredUA * 24) / (efficientCOP * btuPerUnit) * rate;

  const tax = Math.max(0, estimatedMonthlyCost - efficientBaselineCost);

  return {
    heatingDegreeDays: Math.round(hdd * 10) / 10,
    coolingDegreeDays: Math.round(cdd * 10) / 10,
    estimatedMonthlyCost: Math.round(estimatedMonthlyCost * 100) / 100,
    efficientBaselineCost: Math.round(efficientBaselineCost * 100) / 100,
    inefficiencyTaxPerMonth: Math.round(tax * 100) / 100,
    inefficiencyTaxPerYear: Math.round(tax * 12 * 100) / 100,
  };
}

/**
 * Build day-by-day degradation trend: health score for each day.
 */
function buildDegradationTrend(
  readings: { tempF: number; timestamp: number }[],
  setpointF: number,
  config: HvacEfficiencyConfig
): DegradationPoint[] {
  // Group readings by date
  const dayMap = new Map<string, { tempF: number; timestamp: number }[]>();
  for (const r of readings) {
    const day = new Date(r.timestamp).toISOString().slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day)!.push(r);
  }

  const trend: DegradationPoint[] = [];
  for (const [date, dayReadings] of dayMap) {
    if (dayReadings.length < 10) continue;

    const dayCycles = detectCycles(dayReadings, config.minCycleDurationMin);
    const dayHours = (dayReadings[dayReadings.length - 1].timestamp - dayReadings[0].timestamp) / (1000 * 60 * 60);
    const dayProfile = buildCycleProfile(dayCycles, dayHours, config.shortCycleThreshold);

    const dayComfort = analyzeComfort(dayReadings, config.comfortBandF);

    // Day health score: weighted blend
    let health = 50;
    health += dayComfort.overallScore * 0.35;     // Up to 35 from comfort
    health -= dayProfile.isShortCycling ? 20 : 0; // Penalty for short cycling
    health -= Math.min(15, dayProfile.avgAmplitudeF * 5); // Penalty for large swings
    health = clamp(Math.round(health), 0, 100);

    trend.push({
      date,
      healthScore: health,
      dutyCycle: dayProfile.dutyCycle,
      comfortScore: dayComfort.overallScore,
      outsideAvgF: null, // Would need per-day outside data
    });
  }

  return trend.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Recommendation Engine ────────────────────────────────────────

function generateRecommendation(
  room: Omit<RoomHvacProfile, 'recommendation' | 'urgency'>
): { recommendation: string; urgency: RoomHvacProfile['urgency'] } {
  const issues: { msg: string; urgency: RoomHvacProfile['urgency'] }[] = [];

  if (room.cycleProfile.isShortCycling) {
    issues.push({
      msg: `Short-cycling detected (${room.cycleProfile.cyclesPerHour.toFixed(1)} cycles/hr). This can indicate an oversized unit, low refrigerant, dirty filter, or a failing thermostat. Schedule an HVAC inspection.`,
      urgency: 'high',
    });
  }

  if (room.comfort.overallScore < 60) {
    issues.push({
      msg: `Low comfort score (${room.comfort.overallScore}%). Temperature deviates significantly from the inferred ${room.comfort.inferredSetpointF}°F setpoint. Check thermostat calibration and ductwork for this zone.`,
      urgency: 'moderate',
    });
  }

  if (room.cycleProfile.avgAmplitudeF > 3) {
    issues.push({
      msg: `Large temperature swings (${room.cycleProfile.avgAmplitudeF.toFixed(1)}°F per cycle). Consider a thermostat with better anticipator settings or PID control. Rule out stuck dampers.`,
      urgency: 'moderate',
    });
  }

  if (room.recovery.avgOvershootF > 2) {
    issues.push({
      msg: `Consistent overshoot of ${room.recovery.avgOvershootF.toFixed(1)}°F past setpoint. The HVAC runs too long after reaching target. Check thermostat anticipator or consider a smart thermostat.`,
      urgency: 'low',
    });
  }

  if (room.cycleProfile.dutyCycle > 0.85) {
    issues.push({
      msg: `HVAC running ${(room.cycleProfile.dutyCycle * 100).toFixed(0)}% of the time. The system may be undersized for this space, or insulation is inadequate. Consider a load calculation (Manual J).`,
      urgency: 'moderate',
    });
  }

  if (room.cost.inefficiencyTaxPerMonth > 30) {
    issues.push({
      msg: `Estimated $${room.cost.inefficiencyTaxPerMonth.toFixed(0)}/month in excess HVAC cost vs. an efficient baseline. A tune-up, filter change, or duct sealing could recover some of this.`,
      urgency: room.cost.inefficiencyTaxPerMonth > 60 ? 'high' : 'moderate',
    });
  }

  // Best comfort bucket analysis
  const worstBucket = room.comfort.buckets.reduce((w, b) => b.score < w.score ? b : w, room.comfort.buckets[0]);
  if (worstBucket && worstBucket.score < 50) {
    issues.push({
      msg: `Comfort drops to ${worstBucket.score}% during ${worstBucket.label} hours. Consider adjusting the schedule or checking if the system can keep up during this period.`,
      urgency: 'low',
    });
  }

  if (issues.length === 0) {
    return {
      recommendation: 'HVAC is performing well. No issues detected. Continue regular filter changes and annual maintenance.',
      urgency: 'info',
    };
  }

  // Return highest urgency issue
  const urgencyOrder: RoomHvacProfile['urgency'][] = ['critical', 'high', 'moderate', 'low', 'info'];
  issues.sort((a, b) => urgencyOrder.indexOf(a.urgency) - urgencyOrder.indexOf(b.urgency));

  return {
    recommendation: issues[0].msg,
    urgency: issues[0].urgency,
  };
}

// ─── Core Analysis ────────────────────────────────────────────────

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
 * Main HVAC efficiency analysis function.
 */
export function analyzeHvacEfficiency(
  devices: ShellyDevice[],
  readings: SensorReading[],
  outsideTempF: number | null,
  config: HvacEfficiencyConfig = DEFAULT_HVAC_CONFIG,
  hoursBack: number = 24
): HvacEfficiencyResult | null {
  const groups = groupReadingsByDevice(readings, devices, hoursBack);
  const tempDevices = devices.filter(d =>
    groups.has(d.deviceId) && groups.get(d.deviceId)!.length >= 10
  );

  if (tempDevices.length === 0) return null;

  const now = Date.now();

  // ─── Per-room analysis ──────────────────────────────────────

  const rooms: RoomHvacProfile[] = tempDevices.map(device => {
    const deviceReadings = groups.get(device.deviceId)!;
    const currentTempF = deviceReadings[deviceReadings.length - 1].tempF;
    const totalHours = (deviceReadings[deviceReadings.length - 1].timestamp - deviceReadings[0].timestamp) / (1000 * 60 * 60);

    // Layer 1: Cycle detection
    const cycles = detectCycles(deviceReadings, config.minCycleDurationMin);
    const cycleProfile = buildCycleProfile(cycles, totalHours, config.shortCycleThreshold);

    // Layer 2: Comfort analysis
    const comfort = analyzeComfort(deviceReadings, config.comfortBandF);

    // Apply setpoint override if user configured one
    if (config.setpointOverrideF != null) {
      comfort.inferredSetpointF = config.setpointOverrideF;
      // Re-score comfort buckets against the override setpoint
      for (const bucket of comfort.buckets) {
        const bucketReadings = deviceReadings.filter(r => {
          const h = new Date(r.timestamp).getHours();
          return h >= bucket.startHour && h < bucket.endHour;
        });
        if (bucketReadings.length > 0) {
          const inBand = bucketReadings.filter(r =>
            Math.abs(r.tempF - config.setpointOverrideF!) <= config.comfortBandF
          ).length;
          bucket.score = Math.round((inBand / bucketReadings.length) * 100);
          bucket.avgDeviationF = Math.round(
            (bucketReadings.reduce((s, r) => s + Math.abs(r.tempF - config.setpointOverrideF!), 0) / bucketReadings.length) * 10
          ) / 10;
        }
      }
      comfort.overallScore = Math.round(comfort.buckets.reduce((s, b) => s + b.score, 0) / Math.max(1, comfort.buckets.length));
    }

    // Layer 4: Recovery analysis
    const recovery = analyzeRecovery(deviceReadings, comfort.inferredSetpointF);

    // Layer 5: Cost
    const cost = analyzeCost(deviceReadings, outsideTempF, config, cycleProfile.dutyCycle);

    // Confidence
    let confidence = 10;
    confidence += Math.min(25, deviceReadings.length * 0.5);
    confidence += totalHours >= 12 ? 15 : totalHours >= 6 ? 8 : 0;
    confidence += outsideTempF != null ? 15 : 0;
    confidence += cycles.length >= 4 ? 15 : cycles.length >= 2 ? 8 : 0;
    confidence += comfort.overallScore > 0 ? 10 : 0;
    confidence += recovery.events.length >= 1 ? 10 : 0;
    confidence = clamp(Math.round(confidence), 10, 95);

    // Health score
    let healthScore = 50;
    healthScore += comfort.overallScore * 0.3; // up to 30
    healthScore -= cycleProfile.isShortCycling ? 20 : 0;
    healthScore -= Math.min(10, cycleProfile.avgAmplitudeF * 3);
    healthScore += recovery.avgRecoveryRateF > 1 ? 5 : 0;
    healthScore -= recovery.avgOvershootF > 2 ? 5 : 0;
    healthScore -= cycleProfile.dutyCycle > 0.85 ? 10 : 0;
    healthScore = clamp(Math.round(healthScore), 0, 100);

    const partial = {
      deviceId: device.deviceId,
      deviceName: device.name,
      currentTempF: Math.round(currentTempF * 10) / 10,
      healthScore,
      cycleProfile,
      comfort,
      recovery,
      cost,
      confidence,
      dataPoints: deviceReadings.length,
    };

    const { recommendation, urgency } = generateRecommendation(partial as any);

    return { ...partial, recommendation, urgency } as RoomHvacProfile;
  });

  // ─── Aggregate load-performance curve (per-room scoring) ──

  // Build per-room groups so each room is scored against its own setpoint.
  // This prevents cross-room contamination (e.g., bathroom shower spike
  // dragging down the kitchen's performance score).
  const roomGroups = rooms.map(room => {
    const devReadings = groups.get(room.deviceId);
    return {
      readings: devReadings ? [...devReadings].sort((a, b) => a.timestamp - b.timestamp) : [],
      setpointF: room.comfort.inferredSetpointF,
    };
  });
  const loadPerformance = buildLoadPerformanceCurve(roomGroups, outsideTempF);

  // Aggregate readings for degradation trend + cycle chart
  const allReadings: { tempF: number; timestamp: number }[] = [];
  for (const arr of groups.values()) {
    allReadings.push(...arr);
  }
  allReadings.sort((a, b) => a.timestamp - b.timestamp);
  const aggregateSetpoint = tempMode(allReadings.map(r => r.tempF));

  // ─── Degradation trend ──────────────────────────────────────

  const degradationTrend = buildDegradationTrend(allReadings, aggregateSetpoint, config);

  // ─── Cycle chart data ───────────────────────────────────────

  // Build time-series with per-device temp + detected HVAC state
  const allTimestamps = new Set<number>();
  for (const arr of groups.values()) {
    for (const r of arr) allTimestamps.add(r.timestamp);
  }
  const sortedTs = Array.from(allTimestamps).sort();
  const step = Math.max(1, Math.floor(sortedTs.length / 120));
  const chartTs = sortedTs.filter((_, i) => i % step === 0);

  const cycleChartData: CycleChartPoint[] = chartTs.map(ts => {
    const deviceTemps: Record<string, number> = {};
    const hvacState: Record<string, number> = {};

    for (const room of rooms) {
      const safeName = room.deviceName.replace(/[^a-zA-Z0-9]/g, '_');
      const devReadings = groups.get(room.deviceId)!;
      // Find closest reading
      let closest: { tempF: number; timestamp: number } | null = null;
      let closestDist = Infinity;
      for (const r of devReadings) {
        const dist = Math.abs(r.timestamp - ts);
        if (dist < closestDist) { closestDist = dist; closest = r; }
      }
      if (closest && closestDist < 30 * 60 * 1000) {
        deviceTemps[safeName] = Math.round(closest.tempF * 10) / 10;

        // Determine if HVAC was "on" at this point — within a heating phase cycle
        const isOn = room.cycleProfile.cycles.some(c =>
          c.phase === 'heating' && ts >= c.startTs && ts <= c.endTs
        );
        hvacState[safeName] = isOn ? 1 : 0;
      }
    }

    return {
      timestamp: ts,
      time: new Date(ts).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      devices: deviceTemps,
      hvacState,
    };
  });

  // ─── Comfort heatmap: [hour 0-23][dayOfWeek 0-6] → score ──

  const heatmap: number[][] = Array.from({ length: 24 }, () => new Array(7).fill(0));
  const heatmapCounts: number[][] = Array.from({ length: 24 }, () => new Array(7).fill(0));

  for (const r of allReadings) {
    const d = new Date(r.timestamp);
    const h = d.getHours();
    const dow = d.getDay();
    const deviation = Math.abs(r.tempF - aggregateSetpoint);
    heatmap[h][dow] += deviation <= config.comfortBandF ? 100 : 0;
    heatmapCounts[h][dow]++;
  }

  for (let h = 0; h < 24; h++) {
    for (let d = 0; d < 7; d++) {
      heatmap[h][d] = heatmapCounts[h][d] > 0
        ? Math.round(heatmap[h][d] / heatmapCounts[h][d])
        : 0;
    }
  }

  // ─── Overall metrics ───────────────────────────────────────

  const overallHealth = Math.round(mean(rooms.map(r => r.healthScore)));
  const totalInefficiency = rooms.reduce((s, r) => s + r.cost.inefficiencyTaxPerMonth, 0);

  let overallRisk: HvacEfficiencyResult['overallRisk'];
  if (overallHealth >= 85) overallRisk = 'excellent';
  else if (overallHealth >= 70) overallRisk = 'good';
  else if (overallHealth >= 55) overallRisk = 'fair';
  else if (overallHealth >= 35) overallRisk = 'poor';
  else overallRisk = 'critical';

  return {
    analyzedAt: new Date(),
    rooms,
    loadPerformance,
    degradationTrend,
    overallHealthScore: overallHealth,
    overallInefficiencyCost: Math.round(totalInefficiency * 100) / 100,
    cycleChartData,
    comfortHeatmap: heatmap,
    outsideTempF,
    sensorCount: tempDevices.length,
    hoursAnalyzed: hoursBack,
    overallRisk,
  };
}

// ─── Exports for UI ───────────────────────────────────────────────

export { SYSTEM_LABELS, HEALTH_COLORS, SYSTEM_COP };
