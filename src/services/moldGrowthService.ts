/**
 * Mold Growth Prediction Service
 * 
 * Implements a simplified VTT mold growth model to predict mold risk
 * from continuous temperature + humidity sensor data.
 * 
 * Model basis (Hukka & Viitanen, 1999 — VTT Technical Research Centre of Finland):
 *   Mold growth is modeled as a cumulative index (0–6) that advances when
 *   conditions are favorable (RH > critical RH at a given temperature) and
 *   recedes when conditions dry out. The critical RH threshold varies with
 *   temperature — warmer air needs less humidity for mold to grow.
 * 
 * Key insight: a room that touches 65% RH for 30 minutes is very different
 * from one that stays at 65% for 12 hours straight. This model captures that
 * cumulative exposure effect.
 * 
 * Data sources:
 *   - Room humidity: Shelly BLU H&T sensors (per-room, every ~5 min)
 *   - Room temperature: Shelly BLU H&T sensors
 *   - History: Firestore sensor_readings (up to 30 days)
 */

import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';

// ─── Types ────────────────────────────────────────────────────────

export type SurfaceType = 'painted_drywall' | 'bare_drywall' | 'wood' | 'concrete' | 'tile';

export interface MoldGrowthConfig {
  /** Surface material sensitivity (affects growth rate) */
  surfaceType: SurfaceType;
  /** Custom alert threshold on the 0–6 mold index (default: 1.0 — microscopic growth) */
  alertThreshold: number;
  /** Hours of favorable conditions before generating a warning (default: 48) */
  warningHoursThreshold: number;
}

export interface MoldGrowthRoomProfile {
  deviceId: string;
  deviceName: string;
  /** Current mold growth index (0–6 scale) */
  moldIndex: number;
  /** Severity label derived from index */
  severity: 'none' | 'low' | 'moderate' | 'high' | 'critical';
  /** Color for the severity level */
  severityColor: string;
  /** Growth rate: index change per day at current conditions */
  growthRatePerDay: number;
  /** Estimated days until visible mold (index 3) at current rate, or null if not trending */
  daysToVisible: number | null;
  /** Total hours in the favorable zone in the analysis window */
  favorableHours: number;
  /** Percentage of time in the analysis window spent in favorable conditions */
  favorablePercent: number;
  /** Current humidity (%RH) */
  currentHumidity: number | null;
  /** Current temperature (°F) */
  currentTempF: number | null;
  /** Current dew point (°F) */
  currentDewPointF: number | null;
  /** Critical RH threshold at current temperature */
  criticalRH: number | null;
  /** How far above/below critical RH the current reading is */
  rhMargin: number | null;
  /** Confidence 0–100 */
  confidence: number;
  /** Number of readings analyzed */
  dataPoints: number;
  /** Trend over the analysis window */
  trend: 'accelerating' | 'growing' | 'stable' | 'receding' | 'insufficient_data';
  /** Recommendation text */
  recommendation: string;
  /** Composite risk score for ranking (higher = more at risk) */
  riskScore: number;
  /** Forecast: days until mold index reaches 1.0 (microscopic) at current conditions, null if not at risk */
  daysToMicroscopic: number | null;
  /** Fraction of observed time spent in mold-favorable conditions (0–1) */
  favorableDuty: number;
  /** Current growth intensity (0–1 scale, based on how far above critical RH + temp) */
  currentGrowthIntensity: number;
  /** Hours-until-mold predictions at sustained current conditions */
  hoursUntilMold: HoursUntilMold;
  /** Current streak of consecutive favorable hours */
  currentFavorableStreakHours: number;
}

export interface MoldTimeSeriesPoint {
  timestamp: number;
  time: string;
  /** Per-device mold index at this time bucket */
  deviceIndex: Record<string, number>;
  /** Per-device humidity at this time bucket */
  deviceHumidity: Record<string, number>;
  /** Per-device: was this bucket favorable for mold? */
  deviceFavorable: Record<string, boolean>;
}

export interface MoldDailyProfile {
  /** Hour of day (0–23) */
  hour: number;
  /** Per-device average humidity at this hour */
  deviceAvgHumidity: Record<string, number>;
  /** Per-device average favorable % at this hour */
  deviceFavorablePercent: Record<string, number>;
}

export interface MoldForecastPoint {
  /** Days from now */
  day: number;
  /** Per-device projected mold index if current conditions continue */
  deviceIndexCurrent: Record<string, number>;
  /** Per-device projected mold index if the recent net spike-and-dry-out pattern repeats */
  deviceIndexRepeatPattern: Record<string, number>;
  /** Per-device projected mold index under sustained peak-RH stress test */
  deviceIndexWorst: Record<string, number>;
  /** Per-device projected mold index if conditions improve (drop below critical) */
  deviceIndexImproved: Record<string, number>;
}

// ─── Humidity Health Index Types ───────────────────────────────

export type HumidityZone = 'too_dry' | 'ideal' | 'elevated' | 'risky' | 'dangerous';

export interface HumidityZoneBreakdown {
  /** Percentage of time in each zone */
  too_dry: number;   // <25% RH
  ideal: number;     // 30-50% RH
  elevated: number;  // 50-60% RH
  risky: number;     // 60-70% RH
  dangerous: number; // >70% RH
}

export interface CondensationRiskPoint {
  timestamp: number;
  time: string;
  indoorDewPointF: number;
  outsideTempF: number | null;
  condensationRisk: boolean;
}

export interface MaterialDamagePoint {
  timestamp: number;
  time: string;
  tempF: number;
  humidity: number;
  dewPointF: number;
  condensationRisk: boolean;
  paintScore: number;
  drywallScore: number;
}

export type MaterialDamageLevel = 'none' | 'low' | 'moderate' | 'high';

export interface MaterialThresholdProjection {
  level: Exclude<MaterialDamageLevel, 'none'>;
  threshold: number;
  days: number | null;
  alreadyReached: boolean;
}

export interface MaterialDamageEstimate {
  riskLevel: MaterialDamageLevel;
  riskScore: number;
  currentScore: number;
  estimatedCostLow: number;
  estimatedCostHigh: number;
  drivers: string[];
  recommendation: string;
  basisWindowDays: number;
  projectedScorePerDay: number;
  projectionBasis: 'recent_pattern' | 'no_recent_growth' | 'already_reached';
  thresholdProjections: MaterialThresholdProjection[];
}

export interface MaterialImpactEstimate {
  paint: MaterialDamageEstimate;
  drywall: MaterialDamageEstimate;
  totalEstimatedCostLow: number;
  totalEstimatedCostHigh: number;
  elevatedHumidityHours: number;
  highHumidityHours: number;
  dangerousHumidityHours: number;
  condensationHours: number;
  peakHumidity: number;
}

export interface HumidityHealthProfile {
  deviceId: string;
  deviceName: string;
  /** Current dew point (°F) */
  dewPointF: number | null;
  /** Condensation risk: dew point > outside temp */
  condensationRisk: boolean;
  /** Time spent in each humidity zone */
  zoneBreakdown: HumidityZoneBreakdown;
  /** Current humidity zone */
  currentZone: HumidityZone;
  /** Material damage score — cumulative RH×time exposure */
  materialDamageScore: number;
  /** Material weight factor used */
  materialWeight: number;
  /** Paint and drywall damage risk/cost estimates from humidity exposure */
  materialImpact: MaterialImpactEstimate;
  /** Time-series of dew point vs cold surface temp for condensation chart */
  condensationTimeSeries: CondensationRiskPoint[];
  /** Time-series of cumulative paint/drywall exposure score */
  materialDamageTimeSeries: MaterialDamagePoint[];
}

// ─── Ventilation Adequacy Types ───────────────────────────────

export interface HumiditySpike {
  /** When spike started (timestamp) */
  startTime: number;
  /** Peak humidity during spike */
  peakHumidity: number;
  /** Baseline humidity before spike */
  baselineHumidity: number;
  /** Recovery time in minutes (time to return within 5% of baseline), null if didn't recover */
  recoveryMinutes: number | null;
  /** Whether recovery was acceptable for room type */
  recoveryOk: boolean;
}

export type VentilationGrade = 'good' | 'moderate' | 'poor';

export interface VentilationProfile {
  deviceId: string;
  deviceName: string;
  /** Detected humidity spikes */
  spikes: HumiditySpike[];
  /** Average recovery time in minutes */
  avgRecoveryMinutes: number | null;
  /** Estimated air changes per hour */
  estimatedACH: number | null;
  /** Ventilation grade */
  grade: VentilationGrade;
  /** Expected recovery time for this room type (minutes) */
  expectedRecoveryMinutes: number;
}

// ─── Hours Until Mold Type ────────────────────────────────────

export interface HoursUntilMold {
  /** Hours until mold index reaches 0.5 (early favorable) at sustained current conditions */
  hoursToEarlyRisk: number | null;
  /** Hours until mold index reaches 1.0 (microscopic growth) */
  hoursToMicroscopic: number | null;
  /** Hours until mold index reaches 3.0 (visible mold) */
  hoursToVisible: number | null;
  /** Current sustained favorable streak (hours at or above critical RH) */
  currentFavorableStreak: number;
  /** Whether current conditions would sustain mold growth if maintained */
  wouldSustainGrowth: boolean;
  /** Effective growth rate at current conditions (index/hour) */
  effectiveGrowthRate: number;
  /** What the countdown is based on */
  projectionBasis: 'current_conditions' | 'observed_pattern' | 'hypothetical_elevated' | 'none';
}

export interface MoldGrowthAnalysisResult {
  analyzedAt: Date;
  rooms: MoldGrowthRoomProfile[];
  /** Time-series of mold index progression */
  timeSeries: MoldTimeSeriesPoint[];
  /** Daily humidity profile (hour-by-hour average) */
  dailyProfile: MoldDailyProfile[];
  /** Forward-looking mold index projection (30-day) */
  forecast: MoldForecastPoint[];
  /** Room with highest risk */
  highestRiskRoom: string | null;
  /** Overall house mold risk: worst room's severity */
  overallSeverity: MoldGrowthRoomProfile['severity'];
  /** How many rooms are in the favorable zone right now */
  roomsCurrentlyFavorable: number;
  /** Hours of data analyzed */
  hoursAnalyzed: number;
  /** Total sensor count used */
  sensorCount: number;
  /** Per-room hours-until-mold predictions */
  hoursUntilMold: Map<string, HoursUntilMold>;
  /** Per-room humidity health index */
  humidityHealth: HumidityHealthProfile[];
  /** Per-room ventilation adequacy */
  ventilation: VentilationProfile[];
}

// ─── Constants ────────────────────────────────────────────────────

/** Surface sensitivity multipliers (higher = mold grows faster) */
const SURFACE_SENSITIVITY: Record<SurfaceType, number> = {
  bare_drywall: 1.4,     // Paper-faced — most susceptible
  wood: 1.2,             // Natural organic substrate
  painted_drywall: 1.0,  // Paint slows but doesn't prevent growth
  concrete: 0.6,         // Inorganic, but dust/dirt on surface can support mold
  tile: 0.3,             // Very resistant, mold only on grout
};

/** Mold index severity thresholds (VTT scale 0–6) */
const SEVERITY_THRESHOLDS = {
  none: 0,
  low: 0.5,       // Early conditions favorable
  moderate: 1.0,  // Microscopic mold starting
  high: 2.0,      // Moderate microscopic coverage
  critical: 3.0,  // Visible to naked eye
};

const SEVERITY_COLORS: Record<MoldGrowthRoomProfile['severity'], string> = {
  none: '#22c55e',
  low: '#84cc16',
  moderate: '#eab308',
  high: '#f97316',
  critical: '#ef4444',
};

/** Time bucket size in ms (15 minutes) */
const BUCKET_MS = 15 * 60 * 1000;

/** Growth rate coefficient (index units per hour) — base rate for painted drywall
 *  at optimal conditions (77–86°F, >80% RH). Lower temps/RH give slower growth.
 *
 *  Calibrated to EPA real-world timelines:
 *    - At 90%+ RH, optimal temp: index 0.5 in ~20h, 1.0 in ~40h, 3.0 (visible) in ~5 days
 *    - At 77% RH, 66°F: index 0.5 in ~1.5 days, 3.0 (visible) in ~10 days
 *    - At >70% RH: mold can develop (begin germinating) within 24 hours
 *  Per Viitanen (2010), Johansson (2012), and EPA residential guidance. */
const BASE_GROWTH_RATE = 0.025; // ~0.6 index per day at optimal conditions

/** Recession rate (index units per hour) — mold recedes ~5× slower than it grows.
 *  Once colonized, mold doesn't disappear easily even when conditions improve. */
const BASE_RECESSION_RATE = 0.003;

/** Fast recession rate for transient spikes that never reached germination.
 *  Spores that weren't wet long enough to germinate reset more quickly. */
const FAST_RECESSION_RATE = 0.012;

/** Partial growth multiplier for humidity events that haven't yet reached full
 *  germination. Spores absorb moisture even during short spikes (showers),
 *  contributing partial risk — they don't fully reset between events.
 *  ASHRAE Fundamentals: repeated wetting events are cumulative even if individual
 *  events are short. This captures shower/cooking spike responsiveness. */
const PARTIAL_GROWTH_MULTIPLIER = 0.25;

/** Minimum consecutive hours of favorable conditions before mold spores
 *  reach FULL germination rate. Below this threshold, growth still occurs
 *  at PARTIAL_GROWTH_MULTIPLIER rate (capturing shower/cooking humidity).
 *  Based on ASHRAE research: full germination in ~2 hours, but surface
 *  wetting and spore activation begin almost immediately. */
const GERMINATION_DELAY_HOURS = 2.0;

/** Accumulated wetting hours tracker — even if individual spikes are short,
 *  repeated exposure accumulates. If accumulated wetting > this threshold
 *  within a 24-hour window, treat as if germination delay is met.
 *  Based on Johansson et al. (2012): intermittent wetting still supports growth
 *  if total wet time exceeds ~4 hours in 24 hours. */
const ACCUMULATED_WETTING_THRESHOLD_24H = 4.0;

/** Material weight factors for humidity damage score calculation.
 *  Higher = more susceptible to humidity damage. */
const MATERIAL_DAMAGE_WEIGHTS: Record<SurfaceType, number> = {
  bare_drywall: 1.0,
  wood: 1.3,
  painted_drywall: 0.9,
  concrete: 0.5,
  tile: 0.3,
};

const MATERIAL_DAMAGE_THRESHOLDS = [
  { level: 'low', threshold: 10 },
  { level: 'moderate', threshold: 30 },
  { level: 'high', threshold: 65 },
] as const;

/** Expected humidity recovery times by room type (minutes).
 *  Based on ASHRAE 62.2 ventilation standards. */
const EXPECTED_RECOVERY_MINUTES: Record<string, number> = {
  bathroom: 30,
  kitchen: 45,
  laundry: 45,
  bedroom: 60,
  default: 60,
};

/** Humidity zone thresholds (% RH) — aligned to EPA prevention guidance.
 *  EPA recommends keeping indoor RH between 30–50%. Above 55% promotes mold.
 *  Above 70% is dangerous — mold can colonize within 24–48 hours. */
const HUMIDITY_ZONES = {
  TOO_DRY: 25,
  IDEAL_LOW: 30,
  IDEAL_HIGH: 50,
  ELEVATED: 55,   // Was 60 — EPA says mold starts at 55%
  RISKY: 65,      // Was 70 — consistent elevated humidity, active mold risk
  DANGEROUS: 70,  // Added — per EPA, rapid mold growth above 70%
};

/** Maximum mold index */
const MAX_INDEX = 6.0;

/** Minimum index (can't go below 0) */
const MIN_INDEX = 0.0;

// ─── Default Config ───────────────────────────────────────────────

export const DEFAULT_MOLD_CONFIG: MoldGrowthConfig = {
  surfaceType: 'painted_drywall',
  alertThreshold: 1.0,
  warningHoursThreshold: 48,
};

// ─── Helpers ──────────────────────────────────────────────────────

function cToF(c: number): number {
  return (c * 9 / 5) + 32;
}

function fToC(f: number): number {
  return (f - 32) * 5 / 9;
}

/**
 * Calculate critical relative humidity threshold for mold growth at a given temperature.
 * 
 * Calibrated to EPA + ASHRAE real-world residential guidance:
 * - Mold begins growing when indoor RH exceeds 55–60% (EPA).
 * - Above 70% RH, mold can develop within 24–48 hours (multiple sources).
 * - At optimal mold temperatures (77–86°F / 25–30°C), critical RH is ~55%.
 * - At typical room temps (65–77°F), critical RH is ~58–62%.
 * - At cooler temps, mold needs higher RH.
 * - Below ~41°F (5°C), mold growth essentially stops.
 * 
 * Returns critical RH in % (0–100).
 */
export function criticalRH(tempF: number): number {
  const tempC = fToC(tempF);

  // Below 5°C (41°F): no mold growth possible
  if (tempC < 5) return 100;

  // Piecewise linear curve aligned to EPA residential guidance:
  //   5–10°C (41–50°F):  85% → 75%   (cold — mold needs very high moisture)
  //  10–15°C (50–59°F):  75% → 65%   (cool — still needs elevated moisture)
  //  15–20°C (59–68°F):  65% → 58%   (moderate — approaching room temp)
  //  20–25°C (68–77°F):  58% → 55%   (warm room temp — mold thrives easily)
  //  25–30°C (77–86°F):  55%          (optimal mold range)
  //  30–40°C (86–104°F): 55% → 70%   (too hot — mold needs more moisture)
  //  >40°C:              100%         (too hot for most mold)
  if (tempC < 10) return 85 - (tempC - 5) * 2;        // 85→75
  if (tempC < 15) return 75 - (tempC - 10) * 2;       // 75→65
  if (tempC < 20) return 65 - (tempC - 15) * 1.4;     // 65→58
  if (tempC < 25) return 58 - (tempC - 20) * 0.6;     // 58→55
  if (tempC <= 30) return 55;                          // Optimal range
  if (tempC <= 40) return 55 + (tempC - 30) * 1.5;    // 55→70
  return 100;
}

/**
 * Calculate growth intensity factor based on how far above critical RH we are,
 * and how close to optimal temperature.
 * Returns a multiplier 0–1 (0 = no growth, 1 = maximum growth rate).
 */
function growthIntensity(tempF: number, rh: number): number {
  const rhCrit = criticalRH(tempF);
  if (rh < rhCrit) return 0;

  // RH factor: linear from 0 at critical to 1 at critical+20%
  const rhExcess = rh - rhCrit;
  const rhFactor = Math.min(1, rhExcess / 20);

  // Temperature factor: optimal 77–86°F (25–30°C), drops outside that range.
  // Most indoor mold species (Aspergillus, Penicillium, Stachybotrys) grow well
  // between 59–86°F. Room temperature (65–75°F) should still give high growth rates.
  const tempC = fToC(tempF);
  let tempFactor: number;
  if (tempC >= 25 && tempC <= 30) {
    tempFactor = 1.0;                                  // Optimal range
  } else if (tempC >= 20 && tempC < 25) {
    tempFactor = 0.85 + 0.03 * (tempC - 20);           // 0.85→1.0 (warm room temp)
  } else if (tempC > 30 && tempC <= 40) {
    tempFactor = 1.0 - 0.06 * (tempC - 30);            // 1.0→0.4  (too hot)
  } else if (tempC >= 15 && tempC < 20) {
    tempFactor = 0.55 + 0.06 * (tempC - 15);           // 0.55→0.85 (moderate room temp)
  } else if (tempC >= 10 && tempC < 15) {
    tempFactor = 0.25 + 0.06 * (tempC - 10);           // 0.25→0.55 (cool)
  } else if (tempC >= 5 && tempC < 10) {
    tempFactor = 0.05 + 0.04 * (tempC - 5);            // 0.05→0.25 (cold)
  } else {
    tempFactor = 0;                                    // Below 41°F: no growth
  }

  return rhFactor * tempFactor;
}

/**
 * Calculate dew point from temperature (°F) and relative humidity (%).
 * Magnus formula approximation.
 */
export function dewPointF(tempF: number, rh: number): number {
  const tempC = fToC(tempF);
  const a = 17.27;
  const b = 237.7;
  const alpha = (a * tempC) / (b + tempC) + Math.log(rh / 100);
  const dewC = (b * alpha) / (a - alpha);
  return cToF(dewC);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function severityFromIndex(index: number): MoldGrowthRoomProfile['severity'] {
  if (index >= SEVERITY_THRESHOLDS.critical) return 'critical';
  if (index >= SEVERITY_THRESHOLDS.high) return 'high';
  if (index >= SEVERITY_THRESHOLDS.moderate) return 'moderate';
  if (index >= SEVERITY_THRESHOLDS.low) return 'low';
  return 'none';
}

// ─── Core Analysis ────────────────────────────────────────────────

/**
 * Group sensor readings by device within a time window.
 * Returns readings with both temp (°F) and humidity available.
 */
function groupReadingsByDevice(
  readings: SensorReading[],
  devices: ShellyDevice[],
  hoursBack: number
): Map<string, { tempF: number; humidity: number; timestamp: number }[]> {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const deviceMap = new Map(devices.map(d => [d.deviceId, d]));
  const groups = new Map<string, { tempF: number; humidity: number; timestamp: number }[]>();

  for (const r of readings) {
    if (r.temperature == null || r.humidity == null) continue;
    const ts = r.timestamp.getTime();
    if (ts < cutoff) continue;
    if (!deviceMap.has(r.deviceId)) continue;

    if (!groups.has(r.deviceId)) groups.set(r.deviceId, []);
    groups.get(r.deviceId)!.push({
      tempF: cToF(r.temperature),
      humidity: r.humidity,
      timestamp: ts,
    });
  }

  for (const arr of groups.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }

  return groups;
}

/**
 * Main mold growth analysis function.
 */
export function analyzeMoldGrowth(
  devices: ShellyDevice[],
  readings: SensorReading[],
  config: MoldGrowthConfig = DEFAULT_MOLD_CONFIG,
  hoursBack: number = 168, // Default 7 days — mold analysis needs longer windows
  outsideTempF: number | null = null,
): MoldGrowthAnalysisResult | null {

  const groups = groupReadingsByDevice(readings, devices, hoursBack);
  const humidDevices = devices.filter(d =>
    groups.has(d.deviceId) && groups.get(d.deviceId)!.length >= 3
  );

  if (humidDevices.length === 0) return null;

  const surfaceMultiplier = SURFACE_SENSITIVITY[config.surfaceType];

  // ─── Per-device: simulate mold index over time ──────────────────

  const deviceResults = new Map<string, {
    indexOverTime: { timestamp: number; index: number; favorable: boolean; humidity: number }[];
    finalIndex: number;
    favorableHours: number;
    totalHours: number;
    latestReading: { tempF: number; humidity: number; timestamp: number };
    currentFavorableStreakHours: number;
    /** Time-weighted average growth intensity during favorable periods */
    avgFavorableIntensity: number;
    /** Observed net growth rate (index units/hour) from actual simulation */
    observedGrowthRatePerHour: number;
    /** Number of distinct humidity spikes detected (for pattern-based projection) */
    spikeCount: number;
    /** Average growth contribution per spike event */
    avgGrowthPerSpike: number;
  }>();

  for (const device of humidDevices) {
    const deviceReadings = groups.get(device.deviceId)!;
    if (deviceReadings.length < 2) continue;

    let moldIndex = 0;
    const indexHistory: { timestamp: number; index: number; favorable: boolean; humidity: number }[] = [];
    let favorableMs = 0;

    // Track consecutive favorable streak duration (hours).
    let consecutiveFavorableHours = 0;
    // Track the peak consecutive streak (affects recession speed).
    let peakStreakHours = 0;

    // Track weighted intensity for cumulative average calculation.
    // This captures the average growth pressure from ALL favorable periods,
    // not just the current moment — critical for spike-pattern projections.
    let totalIntensityWeightedDt = 0; // sum of (intensity × dt) during favorable periods
    let totalFavorableDt = 0;         // sum of dt during favorable periods
    let spikeCount = 0;               // number of favorable→unfavorable transitions
    let indexAtLastSpikeStart = 0;    // mold index when current spike began
    let totalSpikeGrowth = 0;         // total mold index growth across all spikes
    let wasInSpike = false;           // tracking spike transitions

    // Accumulated wetting: track total favorable hours in sliding 24h window.
    // Even short repeated spikes (multiple showers/day) accumulate wetting
    // and eventually trigger full germination. Per Johansson et al. (2012).
    const wettingEvents: { timestamp: number; hours: number }[] = [];

    for (let i = 0; i < deviceReadings.length; i++) {
      const r = deviceReadings[i];

      // Time delta from previous reading (in hours)
      const dtHours = i > 0
        ? (r.timestamp - deviceReadings[i - 1].timestamp) / (1000 * 60 * 60)
        : 0;

      // Cap dt at 2 hours to avoid huge jumps from data gaps
      const effectiveDt = Math.min(dtHours, 2);

      // Is this reading in the favorable zone?
      const rhCrit = criticalRH(r.tempF);
      const isFavorable = r.humidity >= rhCrit;
      const intensity = growthIntensity(r.tempF, r.humidity);

      // Prune wetting events older than 24 hours
      const dayAgo = r.timestamp - 24 * 60 * 60 * 1000;
      while (wettingEvents.length > 0 && wettingEvents[0].timestamp < dayAgo) {
        wettingEvents.shift();
      }

      // Calculate accumulated wetting in last 24h
      const accumulatedWetting24h = wettingEvents.reduce((sum, e) => sum + e.hours, 0);
      const accumulatedGerminationMet = accumulatedWetting24h >= ACCUMULATED_WETTING_THRESHOLD_24H;

      if (isFavorable && effectiveDt > 0) {
        // Accumulate streak duration
        consecutiveFavorableHours += effectiveDt;
        peakStreakHours = Math.max(peakStreakHours, consecutiveFavorableHours);
        favorableMs += effectiveDt * 60 * 60 * 1000;

        // Track weighted intensity for cumulative projections
        totalIntensityWeightedDt += intensity * effectiveDt;
        totalFavorableDt += effectiveDt;

        // Track spike start
        if (!wasInSpike) {
          wasInSpike = true;
          indexAtLastSpikeStart = moldIndex;
        }

        // Track wetting event
        wettingEvents.push({ timestamp: r.timestamp, hours: effectiveDt });

        // Growth logic — more responsive to elevated humidity:
        if (consecutiveFavorableHours >= GERMINATION_DELAY_HOURS || accumulatedGerminationMet) {
          // Full growth: sustained wetting OR accumulated 4+ hours in 24h window
          const delta = BASE_GROWTH_RATE * surfaceMultiplier * intensity * effectiveDt;
          moldIndex = Math.min(MAX_INDEX, moldIndex + delta);
        } else {
          // PARTIAL growth: spores are absorbing moisture even during short spikes.
          // This makes the model responsive to shower/cooking humidity events.
          // Partial growth scales up as the streak approaches germination.
          const streakFraction = consecutiveFavorableHours / GERMINATION_DELAY_HOURS;
          const partialMultiplier = PARTIAL_GROWTH_MULTIPLIER + (1 - PARTIAL_GROWTH_MULTIPLIER) * streakFraction;
          const delta = BASE_GROWTH_RATE * surfaceMultiplier * intensity * effectiveDt * partialMultiplier;
          moldIndex = Math.min(MAX_INDEX, moldIndex + delta);
        }
      } else if (!isFavorable && effectiveDt > 0) {
        // Track spike completion: favorable → unfavorable transition
        if (wasInSpike) {
          spikeCount++;
          totalSpikeGrowth += Math.max(0, moldIndex - indexAtLastSpikeStart);
          wasInSpike = false;
        }

        // Conditions dropped below critical — reset the favorable streak
        const recentStreakWasShort = consecutiveFavorableHours < GERMINATION_DELAY_HOURS;
        consecutiveFavorableHours = 0;

        // Recession rate: fast if spike never reached germination, slow if it did.
        // Also slow if accumulated wetting has been high (spores are primed).
        const recessionRate = (recentStreakWasShort && peakStreakHours < GERMINATION_DELAY_HOURS && !accumulatedGerminationMet)
          ? FAST_RECESSION_RATE
          : BASE_RECESSION_RATE;
        const delta = recessionRate * effectiveDt;
        moldIndex = Math.max(MIN_INDEX, moldIndex - delta);

        // Reset peak streak once fully receded (new episode)
        if (moldIndex <= MIN_INDEX) {
          peakStreakHours = 0;
        }
      }

      indexHistory.push({
        timestamp: r.timestamp,
        index: Math.round(moldIndex * 1000) / 1000,
        favorable: isFavorable,
        humidity: r.humidity,
      });
    }

    const totalMs = deviceReadings[deviceReadings.length - 1].timestamp - deviceReadings[0].timestamp;
    const totalHours = totalMs / (1000 * 60 * 60);

    // Compute cumulative averages for pattern-based projections
    const avgFavorableIntensity = totalFavorableDt > 0
      ? totalIntensityWeightedDt / totalFavorableDt
      : 0;

    // Observed net growth rate: how fast the index actually grew over the full window,
    // naturally incorporating all spike-and-recovery cycles. This is the moving average
    // the user needs — it captures daily shower spikes compounding over days/weeks.
    const observedGrowthRatePerHour = totalHours > 0 ? moldIndex / totalHours : 0;

    const avgGrowthPerSpike = spikeCount > 0 ? totalSpikeGrowth / spikeCount : 0;

    deviceResults.set(device.deviceId, {
      indexOverTime: indexHistory,
      finalIndex: moldIndex,
      favorableHours: favorableMs / (1000 * 60 * 60),
      totalHours,
      latestReading: deviceReadings[deviceReadings.length - 1],
      currentFavorableStreakHours: consecutiveFavorableHours,
      avgFavorableIntensity,
      observedGrowthRatePerHour,
      spikeCount,
      avgGrowthPerSpike,
    });
  }

  // ─── Build per-room profiles ────────────────────────────────────

  const rooms: MoldGrowthRoomProfile[] = humidDevices
    .filter(d => deviceResults.has(d.deviceId))
    .map(device => {
      const result = deviceResults.get(device.deviceId)!;
      const { finalIndex, favorableHours, totalHours, latestReading, indexOverTime } = result;

      const severity = severityFromIndex(finalIndex);
      const favorablePercent = totalHours > 0 ? (favorableHours / totalHours) * 100 : 0;

      // Growth rate: compare last quarter vs first quarter of the index history
      const quarterLen = Math.floor(indexOverTime.length / 4);
      let growthRatePerDay = 0;
      let trend: MoldGrowthRoomProfile['trend'] = 'insufficient_data';

      if (indexOverTime.length >= 8) {
        const firstQ = indexOverTime.slice(0, quarterLen);
        const lastQ = indexOverTime.slice(-quarterLen);
        const firstAvgIdx = firstQ.reduce((s, p) => s + p.index, 0) / firstQ.length;
        const lastAvgIdx = lastQ.reduce((s, p) => s + p.index, 0) / lastQ.length;
        const timeSpanDays = totalHours / 24;

        growthRatePerDay = timeSpanDays > 0 ? (lastAvgIdx - firstAvgIdx) / timeSpanDays : 0;

        // Determine trend from recent vs overall rate
        const midpoint = Math.floor(indexOverTime.length / 2);
        const secondHalf = indexOverTime.slice(midpoint);
        const recentRate = secondHalf.length >= 2
          ? (secondHalf[secondHalf.length - 1].index - secondHalf[0].index) /
            ((secondHalf[secondHalf.length - 1].timestamp - secondHalf[0].timestamp) / (1000 * 60 * 60 * 24))
          : 0;

        if (recentRate > growthRatePerDay * 1.5 && recentRate > 0.005) {
          trend = 'accelerating';
        } else if (growthRatePerDay > 0.002) {
          trend = 'growing';
        } else if (growthRatePerDay < -0.001) {
          trend = 'receding';
        } else {
          trend = 'stable';
        }
      }

      // Days to visible mold (index 3.0)
      let daysToVisible: number | null = null;
      if (growthRatePerDay > 0.001 && finalIndex < 3.0) {
        daysToVisible = Math.round((3.0 - finalIndex) / growthRatePerDay);
        if (daysToVisible > 365) daysToVisible = null; // Too far out to be meaningful
      }

      // Current conditions
      const currentRhCrit = criticalRH(latestReading.tempF);
      const rhMargin = latestReading.humidity - currentRhCrit;

      // Confidence
      let confidence = 15;
      confidence += Math.min(25, indexOverTime.length * 0.3);
      confidence += totalHours >= 168 ? 25 : totalHours >= 48 ? 15 : 5;
      confidence += humidDevices.length >= 2 ? 10 : 0;
      confidence += favorableHours > 4 ? 15 : favorableHours > 1 ? 8 : 0;
      confidence += Math.abs(rhMargin) > 10 ? 10 : 3;
      confidence = clamp(Math.round(confidence), 10, 95);

      // ─── Mold-centric forecast metrics ──────────────────────────

      // Current growth intensity (how fast mold would grow RIGHT NOW)
      const currentGrowthIntensity = growthIntensity(latestReading.tempF, latestReading.humidity);

      // Favorable duty cycle: what fraction of observed time was favorable?
      const favorableDuty = totalHours > 0 ? favorableHours / totalHours : 0;

      // ─── Cumulative growth rate from observed spike-and-recovery patterns ──
      // Instead of using the instantaneous growth intensity (which is 0 when
      // the current reading is below critical RH), use the OBSERVED net growth
      // rate from the entire analysis window. This captures the cumulative effect
      // of daily humidity spikes (e.g., showers) compounding over time, even though
      // humidity drops back down between events.
      const { observedGrowthRatePerHour, spikeCount: deviceSpikeCount, avgGrowthPerSpike: deviceAvgGrowthPerSpike } = result;

      // Use the observed cumulative rate if we have enough data (>24h),
      // otherwise fall back to instantaneous-based calculation
      const hasSufficientHistory = totalHours >= 24;

      // Effective projection rate for the recent-pattern-repeat scenario.
      const observedBasedRate = hasSufficientHistory ? observedGrowthRatePerHour : 0;

      // Spike fallback: if we see N spikes per day each contributing
      // X growth, project that forward even when the current reading is safe.
      const spikesPerDay = totalHours >= 24 && deviceSpikeCount > 0
        ? deviceSpikeCount / (totalHours / 24)
        : 0;
      const spikeBasedRatePerHour = spikesPerDay > 0
        ? (spikesPerDay * deviceAvgGrowthPerSpike) / 24
        : 0;

      // Use the net observed rate for repeat-pattern projections. It already
      // includes both growth during humid spikes and recession during dry periods.
      // Spike-only growth is a fallback for short/partial windows where the net
      // rate is not yet measurable.
      const cumulativeProjectionRate = observedBasedRate > 0 ? observedBasedRate : spikeBasedRatePerHour;

      // Recommendation — consider current RH proximity even when moldIndex is 0,
      // AND factor in cumulative spike patterns from historical data
      let recommendation: string;
      if (severity === 'critical') {
        recommendation = 'URGENT: Inspect for visible mold immediately. Run a dehumidifier. Check for water leaks or plumbing issues behind walls. Consider professional mold remediation.';
      } else if (severity === 'high') {
        recommendation = 'High mold risk. Run a dehumidifier and improve ventilation. Check for sources of moisture — leaks, poor drainage, or inadequate bathroom/kitchen exhaust. Clean affected surfaces with mold-killing solution.';
      } else if (severity === 'moderate') {
        recommendation = 'Moderate mold risk building. Increase ventilation — run exhaust fans after showers and cooking. Consider a dehumidifier if humidity stays above 60% regularly.';
      } else if (severity === 'low') {
        recommendation = 'Early mold-favorable conditions detected. Monitor humidity levels and ensure rooms have adequate airflow. This is a good time for preventive action.';
      } else if (hasSufficientHistory && cumulativeProjectionRate > 0.0005) {
        // Severity is "none" but recurring spikes are driving cumulative mold growth
        const dailyGrowthFromSpikes = cumulativeProjectionRate * 24;
        const approxDaysToMicroscopic = dailyGrowthFromSpikes > 0 ? Math.round(1.0 / dailyGrowthFromSpikes) : null;
        recommendation = `Recurring humidity spikes (${deviceSpikeCount} events in ${Math.round(totalHours / 24)}d) are driving cumulative mold risk. While humidity is safe between events, repeated exposure compounds. ${approxDaysToMicroscopic ? `At this pattern, microscopic mold could appear in ~${approxDaysToMicroscopic} days.` : ''} Improve ventilation during and after moisture events.`;
      } else if (rhMargin > -2) {
        recommendation = `Humidity is near the critical threshold for mold growth (${Math.round(currentRhCrit)}% RH). If sustained, spores could begin germinating within ${GERMINATION_DELAY_HOURS} hours. Improve ventilation or run a dehumidifier.`;
      } else {
        recommendation = 'No significant mold risk. Conditions are within safe ranges.';
      }

      // Days until mold index reaches 1.0 (microscopic)
      // Uses cumulative pattern rather than instantaneous reading
      let daysToMicroscopic: number | null = null;
      if (finalIndex >= 1.0) {
        daysToMicroscopic = 0;
      } else if (cumulativeProjectionRate > 0) {
        daysToMicroscopic = Math.round(((1.0 - finalIndex) / (cumulativeProjectionRate * 24)) * 10) / 10;
        if (daysToMicroscopic > 365) daysToMicroscopic = null;
      } else if (currentGrowthIntensity > 0 && finalIndex < 1.0) {
        // Fallback: not enough history, use instantaneous rate
        const effectiveRate = BASE_GROWTH_RATE * surfaceMultiplier * currentGrowthIntensity * Math.max(favorableDuty, rhMargin >= 0 ? 0.8 : 0);
        if (effectiveRate > 0) {
          daysToMicroscopic = Math.round(((1.0 - finalIndex) / effectiveRate / 24) * 10) / 10;
          if (daysToMicroscopic > 365) daysToMicroscopic = null;
        }
      }

      // ─── Hours-Until-Mold predictions ───────────────────────────
      // Uses CUMULATIVE observed growth rates from the analysis window,
      // not just the current instantaneous reading. This ensures that
      // rooms with recurring humidity spikes (showers, cooking) show
      // realistic mold timelines even when the current reading is safe.

      const currentStreakHours = result.currentFavorableStreakHours;
      const wouldSustainGrowth = currentGrowthIntensity > 0 && latestReading.humidity >= currentRhCrit;

      // For the countdown, prioritize the observed cumulative rate.
      // This captures the real-world pattern of spike-and-recovery cycles.
      let effectiveCountdownRate: number;
      let projectionBasis: HoursUntilMold['projectionBasis'];
      if (hasSufficientHistory && cumulativeProjectionRate > 0) {
        // Use the recent pattern from historical data — this is the most
        // accurate projection because it naturally incorporates:
        // - Spike frequency (how often showers/cooking happen)
        // - Spike intensity (how high humidity goes)
        // - Recovery speed (how fast ventilation brings humidity back down)
        // - Baseline conditions between spikes
        effectiveCountdownRate = cumulativeProjectionRate;
        projectionBasis = 'observed_pattern';
      } else if (wouldSustainGrowth) {
        // Currently above critical — use real instantaneous growth rate
        effectiveCountdownRate = BASE_GROWTH_RATE * surfaceMultiplier * currentGrowthIntensity;
        projectionBasis = 'current_conditions';
      } else if (latestReading.humidity >= 50) {
        // Elevated but below critical — compute hypothetical: what if this persisted?
        const proximityFactor = Math.max(0, 1 - (currentRhCrit - latestReading.humidity) / 30);
        const hypotheticalIntensity = proximityFactor * 0.3;
        effectiveCountdownRate = BASE_GROWTH_RATE * surfaceMultiplier * hypotheticalIntensity;
        projectionBasis = effectiveCountdownRate > 0 ? 'hypothetical_elevated' : 'none';
      } else {
        // Well below any risk — no meaningful countdown
        effectiveCountdownRate = 0;
        projectionBasis = 'none';
      }

      let hoursToEarlyRisk: number | null = null;
      let hoursToMicroscopic: number | null = null;
      let hoursToVisibleMold: number | null = null;

      if (effectiveCountdownRate > 0) {
        // When using the cumulative observed rate (from historical spike patterns),
        // the germination delay is already baked into the rate — it reflects the
        // real-world growth that happened including partial growth during spikes,
        // full growth during sustained periods, and recession between events.
        // Only apply germination delay for instantaneous-based rates.
        const usingCumulativeRate = hasSufficientHistory && cumulativeProjectionRate > 0;

        let effectiveRateForCountdown: number;
        let startingIndex: number;

        if (usingCumulativeRate) {
          // Cumulative rate already accounts for spike-recovery cycles,
          // germination delay, and recession — use directly
          effectiveRateForCountdown = effectiveCountdownRate;
          startingIndex = finalIndex;
        } else {
          // Instantaneous-based: apply germination delay model
          const remainingGerminationHours = wouldSustainGrowth
            ? Math.max(0, GERMINATION_DELAY_HOURS - currentStreakHours)
            : GERMINATION_DELAY_HOURS;
          const partialGrowthDuringDelay = remainingGerminationHours > 0
            ? effectiveCountdownRate * PARTIAL_GROWTH_MULTIPLIER * remainingGerminationHours
            : 0;
          effectiveRateForCountdown = effectiveCountdownRate;
          startingIndex = finalIndex + partialGrowthDuringDelay;
        }

        // Hours to index 0.5 (early favorable)
        if (finalIndex < 0.5) {
          const remaining = 0.5 - startingIndex;
          if (remaining <= 0) {
            hoursToEarlyRisk = 0;
          } else {
            hoursToEarlyRisk = remaining / effectiveRateForCountdown;
          }
          if (hoursToEarlyRisk != null && hoursToEarlyRisk > 8760) hoursToEarlyRisk = null;
        }

        // Hours to index 1.0 (microscopic)
        if (finalIndex < 1.0) {
          const remaining = 1.0 - startingIndex;
          if (remaining <= 0) {
            hoursToMicroscopic = 0;
          } else {
            hoursToMicroscopic = remaining / effectiveRateForCountdown;
          }
          if (hoursToMicroscopic != null && hoursToMicroscopic > 8760) hoursToMicroscopic = null;
        }

        // Hours to index 3.0 (visible)
        if (finalIndex < 3.0) {
          const remaining = 3.0 - startingIndex;
          if (remaining <= 0) {
            hoursToVisibleMold = 0;
          } else {
            hoursToVisibleMold = remaining / effectiveRateForCountdown;
          }
          if (hoursToVisibleMold != null && hoursToVisibleMold > 8760) hoursToVisibleMold = null;
        }
      }

      const hoursUntilMoldData: HoursUntilMold = {
        hoursToEarlyRisk: hoursToEarlyRisk != null ? Math.round(hoursToEarlyRisk * 10) / 10 : null,
        hoursToMicroscopic: hoursToMicroscopic != null ? Math.round(hoursToMicroscopic * 10) / 10 : null,
        hoursToVisible: hoursToVisibleMold != null ? Math.round(hoursToVisibleMold * 10) / 10 : null,
        currentFavorableStreak: Math.round(currentStreakHours * 10) / 10,
        // Flag as sustaining growth if EITHER currently above critical OR
        // historical pattern shows recurring spikes that compound growth
        wouldSustainGrowth: wouldSustainGrowth || (hasSufficientHistory && cumulativeProjectionRate > 0.0001),
        effectiveGrowthRate: Math.round(effectiveCountdownRate * 100000) / 100000,
        projectionBasis,
      };

      // Composite risk score — factor in cumulative spike pattern risk
      const cumulativeRiskBonus = hasSufficientHistory && cumulativeProjectionRate > 0
        ? cumulativeProjectionRate * 24 * 100  // Scale: daily growth rate × 100
        : 0;
      const riskScore = (finalIndex * 1000) + (rhMargin * 10) + ((latestReading.humidity ?? 0) * 0.1) + (currentGrowthIntensity * 50) + cumulativeRiskBonus;

      return {
        deviceId: device.deviceId,
        deviceName: device.name,
        moldIndex: Math.round(finalIndex * 100) / 100,
        severity,
        severityColor: SEVERITY_COLORS[severity],
        growthRatePerDay: Math.round(growthRatePerDay * 10000) / 10000,
        daysToVisible,
        favorableHours: Math.round(favorableHours * 10) / 10,
        favorablePercent: Math.round(favorablePercent * 10) / 10,
        currentHumidity: latestReading.humidity,
        currentTempF: Math.round(latestReading.tempF * 10) / 10,
        currentDewPointF: Math.round(dewPointF(latestReading.tempF, latestReading.humidity) * 10) / 10,
        criticalRH: Math.round(currentRhCrit * 10) / 10,
        rhMargin: Math.round(rhMargin * 10) / 10,
        confidence,
        dataPoints: indexOverTime.length,
        trend,
        recommendation,
        riskScore: Math.round(riskScore * 100) / 100,
        daysToMicroscopic,
        favorableDuty: Math.round(favorableDuty * 1000) / 1000,
        currentGrowthIntensity: Math.round(currentGrowthIntensity * 1000) / 1000,
        hoursUntilMold: hoursUntilMoldData,
        currentFavorableStreakHours: Math.round(currentStreakHours * 10) / 10,
      };
    });

  // ─── Build time-series for charts ───────────────────────────────

  // Bucket all device data into 15-min intervals
  const allBuckets = new Set<number>();
  for (const [, result] of deviceResults) {
    for (const point of result.indexOverTime) {
      allBuckets.add(Math.floor(point.timestamp / BUCKET_MS) * BUCKET_MS);
    }
  }

  const sortedBuckets = Array.from(allBuckets).sort();
  const timeSeries: MoldTimeSeriesPoint[] = sortedBuckets.map(bucket => {
    const deviceIndex: Record<string, number> = {};
    const deviceHumidity: Record<string, number> = {};
    const deviceFavorable: Record<string, boolean> = {};

    for (const device of humidDevices) {
      const result = deviceResults.get(device.deviceId);
      if (!result) continue;

      // Find closest point to this bucket
      let closest: (typeof result.indexOverTime)[0] | null = null;
      let closestDist = Infinity;
      for (const p of result.indexOverTime) {
        const dist = Math.abs(p.timestamp - bucket);
        if (dist < closestDist) {
          closestDist = dist;
          closest = p;
        }
      }

      if (closest && closestDist < BUCKET_MS * 2) {
        const safeName = device.name.replace(/[^a-zA-Z0-9]/g, '_');
        deviceIndex[safeName] = Math.round(closest.index * 100) / 100;
        deviceHumidity[safeName] = Math.round(closest.humidity * 10) / 10;
        deviceFavorable[safeName] = closest.favorable;
      }
    }

    return {
      timestamp: bucket,
      time: new Date(bucket).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      deviceIndex,
      deviceHumidity,
      deviceFavorable,
    };
  });

  // ─── Build daily humidity profile (hour-by-hour) ────────────────

  const hourBuckets = new Map<number, Map<string, { humSum: number; favCount: number; total: number }>>();

  for (const device of humidDevices) {
    const result = deviceResults.get(device.deviceId);
    if (!result) continue;
    const safeName = device.name.replace(/[^a-zA-Z0-9]/g, '_');

    for (const point of result.indexOverTime) {
      const hour = new Date(point.timestamp).getHours();
      if (!hourBuckets.has(hour)) hourBuckets.set(hour, new Map());
      const hourMap = hourBuckets.get(hour)!;
      if (!hourMap.has(safeName)) hourMap.set(safeName, { humSum: 0, favCount: 0, total: 0 });
      const entry = hourMap.get(safeName)!;
      entry.humSum += point.humidity;
      entry.favCount += point.favorable ? 1 : 0;
      entry.total += 1;
    }
  }

  const dailyProfile: MoldDailyProfile[] = Array.from({ length: 24 }, (_, hour) => {
    const hourMap = hourBuckets.get(hour);
    const deviceAvgHumidity: Record<string, number> = {};
    const deviceFavorablePercent: Record<string, number> = {};

    if (hourMap) {
      for (const [safeName, entry] of hourMap) {
        deviceAvgHumidity[safeName] = entry.total > 0 ? Math.round(entry.humSum / entry.total * 10) / 10 : 0;
        deviceFavorablePercent[safeName] = entry.total > 0 ? Math.round(entry.favCount / entry.total * 100) : 0;
      }
    }

    return { hour, deviceAvgHumidity, deviceFavorablePercent };
  });

  // ─── Build 30-day mold index projection ─────────────────────────
  //
  // Four scenarios per room:
  //  1. "Current" — current conditions continue from now. If RH is currently
  //     below critical, the modeled score recedes rather than growing.
  //  2. "Repeat pattern" — projects forward using the OBSERVED cumulative growth
  //     pattern from the analysis window. This captures daily spike-and-
  //     recovery cycles (showers, cooking) and naturally accounts for
  //     how well humidity is managed between events.
  //  3. "Worst"   — if worst observed conditions persist 100% of the time
  //  4. "Improved" — if RH drops below critical (recession only)

  const FORECAST_DAYS = 30;
  const forecast: MoldForecastPoint[] = [];

  // Pre-compute per-room forecast parameters
  const roomForecastParams = rooms.map(room => {
    const safeName = room.deviceName.replace(/[^a-zA-Z0-9]/g, '_');
    const intensity = room.currentGrowthIntensity;

    const result = deviceResults.get(room.deviceId);

    // Use observed cumulative rate from historical data when available.
    // This rate already captures the net effect of recurring humidity spikes,
    // including how much recession occurs between events.
    const observedRate = result && result.totalHours >= 24
      ? result.observedGrowthRatePerHour
      : 0;

    // Spike-pattern based rate: extrapolate from detected spike events
    const spikeRate = result && result.totalHours >= 24 && result.spikeCount > 0
      ? (result.spikeCount / (result.totalHours / 24)) * result.avgGrowthPerSpike / 24
      : 0;

    // Repeat-pattern scenario: prefer the net observed rate because it includes
    // the dry-out/recession that happens between humidity spikes. Spike-only
    // growth is a fallback when the analysis window is too short to show a net rate.
    const repeatPatternRate = observedRate > 0 ? observedRate : spikeRate;

    // Current-condition scenario: use the current reading only. If current RH is
    // below critical, the modeled score should not creep upward.
    const currentRate = intensity > 0
      ? BASE_GROWTH_RATE * surfaceMultiplier * intensity
      : -BASE_RECESSION_RATE;

    // Worst-case: use peak intensity × 100% duty
    let peakIntensity = intensity;
    if (result) {
      const refTempF = result.latestReading.tempF;
      for (const pt of result.indexOverTime) {
        const ptIntensity = growthIntensity(refTempF, pt.humidity);
        peakIntensity = Math.max(peakIntensity, ptIntensity);
      }
    }

    return {
      safeName,
      startIndex: room.moldIndex,
      currentRate,
      repeatPatternRate,
      // Worst scenario: peak observed intensity at 100% duty
      worstRate: BASE_GROWTH_RATE * surfaceMultiplier * peakIntensity,
      // Improved scenario: recession rate (no growth)
      improvedRecession: BASE_RECESSION_RATE,
    };
  });

  for (let day = 0; day <= FORECAST_DAYS; day++) {
    const deviceIndexCurrent: Record<string, number> = {};
    const deviceIndexRepeatPattern: Record<string, number> = {};
    const deviceIndexWorst: Record<string, number> = {};
    const deviceIndexImproved: Record<string, number> = {};

    for (const params of roomForecastParams) {
      const hours = day * 24;

      // Current-condition scenario
      const currentIdx = Math.min(MAX_INDEX, params.startIndex + params.currentRate * hours);
      deviceIndexCurrent[params.safeName] = Math.round(Math.max(MIN_INDEX, currentIdx) * 100) / 100;

      // Recent pattern repeats
      const repeatIdx = Math.min(MAX_INDEX, params.startIndex + params.repeatPatternRate * hours);
      deviceIndexRepeatPattern[params.safeName] = Math.round(Math.max(MIN_INDEX, repeatIdx) * 100) / 100;

      // Worst case
      const worstIdx = Math.min(MAX_INDEX, params.startIndex + params.worstRate * hours);
      deviceIndexWorst[params.safeName] = Math.round(worstIdx * 100) / 100;

      // Improved (recession)
      const improvedIdx = Math.max(MIN_INDEX, params.startIndex - params.improvedRecession * hours);
      deviceIndexImproved[params.safeName] = Math.round(improvedIdx * 100) / 100;
    }

    forecast.push({ day, deviceIndexCurrent, deviceIndexRepeatPattern, deviceIndexWorst, deviceIndexImproved });
  }

  // ─── Aggregate results ──────────────────────────────────────────

  const worstRoom = rooms.reduce((worst, r) =>
    r.riskScore > worst.riskScore ? r : worst, rooms[0]);

  const roomsCurrentlyFavorable = rooms.filter(r =>
    r.rhMargin != null && r.rhMargin > 0
  ).length;

  // Override overallSeverity: if any room is currently above or near critical RH
  // but moldIndex hasn't advanced yet, flag it so the UI shows a warning.
  // Also flag if cumulative spike patterns show compounding risk.
  let overallSeverity = worstRoom?.severity || 'none';
  if (overallSeverity === 'none' && worstRoom) {
    // Check for cumulative spike-driven risk
    const worstResult = deviceResults.get(worstRoom.deviceId);
    const hasCumulativeRisk = worstResult &&
      worstResult.totalHours >= 24 &&
      worstResult.observedGrowthRatePerHour > 0.0001;

    if ((worstRoom.rhMargin ?? -50) >= 0) {
      overallSeverity = 'low'; // At or above critical
    } else if ((worstRoom.rhMargin ?? -50) > -3) {
      overallSeverity = 'low'; // Very near critical
    } else if (hasCumulativeRisk) {
      overallSeverity = 'low'; // Spike pattern causing cumulative growth
    }
  }

  return {
    analyzedAt: new Date(),
    rooms,
    timeSeries,
    dailyProfile,
    forecast,
    highestRiskRoom: worstRoom?.deviceId || null,
    overallSeverity,
    roomsCurrentlyFavorable,
    hoursAnalyzed: hoursBack,
    sensorCount: humidDevices.length,
    hoursUntilMold: new Map(rooms.map(r => [r.deviceId, r.hoursUntilMold])),
    humidityHealth: analyzeHumidityHealth(humidDevices, groups, config, outsideTempF),
    ventilation: analyzeVentilation(humidDevices, groups),
  };
}

// ─── Humidity Health Index Analysis ───────────────────────────────

function classifyHumidityZone(rh: number): HumidityZone {
  if (rh < HUMIDITY_ZONES.TOO_DRY) return 'too_dry';
  if (rh <= HUMIDITY_ZONES.IDEAL_HIGH) return 'ideal';
  if (rh <= HUMIDITY_ZONES.ELEVATED) return 'elevated';
  if (rh <= HUMIDITY_ZONES.RISKY) return 'risky';
  return 'dangerous';  // >70% (was >70% before too, threshold alignment is the key change)
}

function emptyMaterialDamageEstimate(recommendation: string): MaterialDamageEstimate {
  return {
    riskLevel: 'none',
    riskScore: 0,
    currentScore: 0,
    estimatedCostLow: 0,
    estimatedCostHigh: 0,
    drivers: [],
    recommendation,
    basisWindowDays: 0,
    projectedScorePerDay: 0,
    projectionBasis: 'no_recent_growth',
    thresholdProjections: MATERIAL_DAMAGE_THRESHOLDS.map(({ level, threshold }) => ({
      level,
      threshold,
      days: null,
      alreadyReached: false,
    })),
  };
}

function emptyMaterialImpact(): MaterialImpactEstimate {
  return {
    paint: emptyMaterialDamageEstimate('No paint damage expected from the current humidity pattern.'),
    drywall: emptyMaterialDamageEstimate('No drywall damage expected from the current humidity pattern.'),
    totalEstimatedCostLow: 0,
    totalEstimatedCostHigh: 0,
    elevatedHumidityHours: 0,
    highHumidityHours: 0,
    dangerousHumidityHours: 0,
    condensationHours: 0,
    peakHumidity: 0,
  };
}

function materialDamageIncrement(
  tempF: number,
  humidity: number,
  dewPoint: number,
  condensationRisk: boolean,
  dtHours: number,
  materialWeight: number,
): { paint: number; drywall: number } {
  if (dtHours <= 0) return { paint: 0, drywall: 0 };

  const tempFactor = tempF < 55 ? 0.85 : tempF > 82 ? 1.1 : 1;
  const dewPointFactor = dewPoint >= 65 ? 1.2 : dewPoint >= 60 ? 1.08 : 1;
  const surfaceFactor = Math.max(0.6, Math.min(1.4, materialWeight));

  const elevatedRh = Math.max(0, humidity - 55);
  const highRh = Math.max(0, humidity - 65);
  const dangerousRh = Math.max(0, humidity - 70);
  const condensationPaint = condensationRisk ? 0.7 : 0;
  const condensationDrywall = condensationRisk ? 1.3 : 0;

  const paintPressure = elevatedRh * 0.035 + highRh * 0.12 + dangerousRh * 0.16 + condensationPaint;
  const drywallPressure = elevatedRh * 0.025 + highRh * 0.1 + dangerousRh * 0.22 + condensationDrywall;

  return {
    paint: paintPressure * tempFactor * dewPointFactor * surfaceFactor * dtHours,
    drywall: drywallPressure * tempFactor * dewPointFactor * surfaceFactor * dtHours,
  };
}

function damageLevel(score: number): MaterialDamageLevel {
  if (score >= 65) return 'high';
  if (score >= 30) return 'moderate';
  if (score >= 10) return 'low';
  return 'none';
}

function buildMaterialThresholdProjections(
  points: MaterialDamagePoint[],
  material: 'paint' | 'drywall',
): Pick<MaterialDamageEstimate, 'currentScore' | 'basisWindowDays' | 'projectedScorePerDay' | 'projectionBasis' | 'thresholdProjections'> {
  if (!points.length) {
    return {
      currentScore: 0,
      basisWindowDays: 0,
      projectedScorePerDay: 0,
      projectionBasis: 'no_recent_growth',
      thresholdProjections: MATERIAL_DAMAGE_THRESHOLDS.map(({ level, threshold }) => ({
        level,
        threshold,
        days: null,
        alreadyReached: false,
      })),
    };
  }

  const scoreKey = material === 'paint' ? 'paintScore' : 'drywallScore';
  const latest = points[points.length - 1];
  const earliest = points[0];
  const totalSpanMs = Math.max(0, latest.timestamp - earliest.timestamp);
  const targetWindowMs = Math.min(totalSpanMs, 24 * 60 * 60 * 1000);

  let basisPoint = earliest;
  if (targetWindowMs > 0) {
    const targetStart = latest.timestamp - targetWindowMs;
    for (const point of points) {
      if (point.timestamp <= targetStart) {
        basisPoint = point;
        continue;
      }
      break;
    }

    if (basisPoint.timestamp === latest.timestamp && points.length > 1) {
      basisPoint = points[points.length - 2];
    }
  }

  const basisWindowDays = Math.max(0, (latest.timestamp - basisPoint.timestamp) / (1000 * 60 * 60 * 24));
  const currentScore = Math.round(latest[scoreKey] * 10) / 10;
  const basisScore = basisPoint[scoreKey];
  const projectedScorePerDay = basisWindowDays > 0
    ? Math.max(0, Math.round(((latest[scoreKey] - basisScore) / basisWindowDays) * 10) / 10)
    : 0;

  const thresholdProjections: MaterialThresholdProjection[] = MATERIAL_DAMAGE_THRESHOLDS.map(({ level, threshold }) => {
    const alreadyReached = currentScore >= threshold;
    if (alreadyReached) {
      return { level, threshold, days: 0, alreadyReached: true };
    }

    if (projectedScorePerDay <= 0) {
      return { level, threshold, days: null, alreadyReached: false };
    }

    const rawDays = (threshold - currentScore) / projectedScorePerDay;
    return {
      level,
      threshold,
      days: rawDays <= 180 ? Math.max(0, rawDays) : null,
      alreadyReached: false,
    };
  });

  const projectionBasis = thresholdProjections.every(projection => projection.alreadyReached)
    ? 'already_reached'
    : projectedScorePerDay > 0
      ? 'recent_pattern'
      : 'no_recent_growth';

  return {
    currentScore,
    basisWindowDays: Math.round(basisWindowDays * 10) / 10,
    projectedScorePerDay,
    projectionBasis,
    thresholdProjections,
  };
}

function scaleCost(value: number, multiplier: number): number {
  return Math.round(value * multiplier / 25) * 25;
}

function roomCostMultiplier(roomName: string): number {
  const roomType = detectRoomType(roomName);
  if (roomType === 'bathroom') return 1.2;
  if (roomType === 'laundry' || roomType === 'kitchen') return 1.1;
  return 1;
}

function buildMaterialDamageEstimate(
  material: 'paint' | 'drywall',
  score: number,
  costMultiplier: number,
  drivers: string[],
  projection: Pick<MaterialDamageEstimate, 'currentScore' | 'basisWindowDays' | 'projectedScorePerDay' | 'projectionBasis' | 'thresholdProjections'>,
): MaterialDamageEstimate {
  const riskLevel = damageLevel(score);
  const costs = material === 'paint'
    ? {
        none: [0, 0],
        low: [35, 125],
        moderate: [125, 450],
        high: [350, 1_000],
      }
    : {
        none: [0, 0],
        low: [0, 200],
        moderate: [250, 900],
        high: [900, 2_500],
      };

  const recommendation = material === 'paint'
    ? riskLevel === 'none'
      ? 'No paint damage expected from the current humidity pattern.'
      : riskLevel === 'low'
        ? 'Watch for paint softening, bubbling, or staining near vents, windows, and corners.'
        : riskLevel === 'moderate'
          ? 'Inspect painted surfaces and plan localized touch-up or moisture-resistant repainting if marks appear.'
          : 'Inspect for active moisture before repainting; paint failure is likely unless humidity is controlled.'
    : riskLevel === 'none'
      ? 'No drywall damage expected from the current humidity pattern.'
      : riskLevel === 'low'
        ? 'Check drywall seams, corners, and wall areas behind fixtures for softness or staining.'
        : riskLevel === 'moderate'
          ? 'Inspect for softened paper face, stains, or swelling; localized drywall repair may be needed if moisture repeats.'
          : 'High drywall damage risk; inspect behind finish surfaces and address moisture before patching.';

  const [low, high] = costs[riskLevel];
  return {
    riskLevel,
    riskScore: Math.min(100, Math.round(score)),
    currentScore: Math.round(score * 10) / 10,
    estimatedCostLow: scaleCost(low, costMultiplier),
    estimatedCostHigh: scaleCost(high, costMultiplier),
    drivers,
    recommendation,
    basisWindowDays: projection.basisWindowDays,
    projectedScorePerDay: projection.projectedScorePerDay,
    projectionBasis: projection.projectionBasis,
    thresholdProjections: projection.thresholdProjections,
  };
}

function estimateMaterialImpact(
  deviceName: string,
  elevatedHumidityHours: number,
  highHumidityHours: number,
  dangerousHumidityHours: number,
  condensationHours: number,
  peakHumidity: number,
  paintScore: number,
  drywallScore: number,
  materialDamageTimeSeries: MaterialDamagePoint[],
): MaterialImpactEstimate {
  const drivers: string[] = [];
  if (elevatedHumidityHours >= 0.5) drivers.push(`${Math.round(elevatedHumidityHours * 10) / 10}h above 55% RH`);
  if (highHumidityHours >= 0.5) drivers.push(`${Math.round(highHumidityHours * 10) / 10}h above 65% RH`);
  if (dangerousHumidityHours >= 0.5) drivers.push(`${Math.round(dangerousHumidityHours * 10) / 10}h above 70% RH`);
  if (condensationHours >= 0.25) drivers.push(`${Math.round(condensationHours * 10) / 10}h condensation risk`);
  if (peakHumidity >= 70) drivers.push(`peak ${Math.round(peakHumidity)}% RH`);

  const multiplier = roomCostMultiplier(deviceName);
  const paintProjection = buildMaterialThresholdProjections(materialDamageTimeSeries, 'paint');
  const drywallProjection = buildMaterialThresholdProjections(materialDamageTimeSeries, 'drywall');

  const paint = buildMaterialDamageEstimate('paint', paintScore, multiplier, drivers, paintProjection);
  const drywall = buildMaterialDamageEstimate('drywall', drywallScore, multiplier, drivers, drywallProjection);

  return {
    paint,
    drywall,
    totalEstimatedCostLow: paint.estimatedCostLow + drywall.estimatedCostLow,
    totalEstimatedCostHigh: paint.estimatedCostHigh + drywall.estimatedCostHigh,
    elevatedHumidityHours: Math.round(elevatedHumidityHours * 10) / 10,
    highHumidityHours: Math.round(highHumidityHours * 10) / 10,
    dangerousHumidityHours: Math.round(dangerousHumidityHours * 10) / 10,
    condensationHours: Math.round(condensationHours * 10) / 10,
    peakHumidity: Math.round(peakHumidity * 10) / 10,
  };
}

function analyzeHumidityHealth(
  devices: ShellyDevice[],
  groups: Map<string, { tempF: number; humidity: number; timestamp: number }[]>,
  config: MoldGrowthConfig,
  outsideTempF: number | null = null,
): HumidityHealthProfile[] {
  const materialWeight = MATERIAL_DAMAGE_WEIGHTS[config.surfaceType];

  return devices
    .filter(d => groups.has(d.deviceId))
    .map(device => {
      const readings = groups.get(device.deviceId)!;
      if (readings.length < 2) {
        return {
          deviceId: device.deviceId,
          deviceName: device.name,
          dewPointF: null,
          condensationRisk: false,
          zoneBreakdown: { too_dry: 0, ideal: 0, elevated: 0, risky: 0, dangerous: 0 },
          currentZone: 'ideal' as HumidityZone,
          materialDamageScore: 0,
          materialWeight,
          materialImpact: emptyMaterialImpact(),
          condensationTimeSeries: [],
          materialDamageTimeSeries: [],
        };
      }

      // Zone breakdown: count time in each zone
      const zoneCounts = { too_dry: 0, ideal: 0, elevated: 0, risky: 0, dangerous: 0 };
      let materialDamageScore = 0;
      let elevatedHumidityHours = 0;
      let highHumidityHours = 0;
      let dangerousHumidityHours = 0;
      let condensationHours = 0;
      let peakHumidity = 0;
      let paintDamageScore = 0;
      let drywallDamageScore = 0;

      // Build condensation time-series (sample every ~6th reading for chart)
      const condensationTimeSeries: CondensationRiskPoint[] = [];
      const materialDamageTimeSeries: MaterialDamagePoint[] = [];
      const sampleStep = Math.max(1, Math.floor(readings.length / 80));

      for (let i = 0; i < readings.length; i++) {
        const r = readings[i];
        const dtHours = i > 0
          ? Math.min(2, (r.timestamp - readings[i - 1].timestamp) / (1000 * 60 * 60))
          : 0;

        const zone = classifyHumidityZone(r.humidity);
        zoneCounts[zone] += dtHours;
        peakHumidity = Math.max(peakHumidity, r.humidity);

        if (dtHours > 0) {
          if (r.humidity > 55) elevatedHumidityHours += dtHours;
          if (r.humidity > 65) highHumidityHours += dtHours;
          if (r.humidity > 70) dangerousHumidityHours += dtHours;
        }

        const dp = dewPointF(r.tempF, r.humidity);
        const coldSurface = outsideTempF != null ? outsideTempF + 10 : 45;
        const condensationRisk = dp > coldSurface;
        if (condensationRisk && dtHours > 0) {
          condensationHours += dtHours;
        }

        // Material damage score: cumulative exposure above 55% RH
        if (r.humidity > 55 && dtHours > 0) {
          materialDamageScore += Math.max(0, r.humidity - 55) * dtHours * materialWeight;
        }

        const damageDelta = materialDamageIncrement(r.tempF, r.humidity, dp, condensationRisk, dtHours, materialWeight);
        paintDamageScore = Math.min(100, paintDamageScore + damageDelta.paint);
        drywallDamageScore = Math.min(100, drywallDamageScore + damageDelta.drywall);

        // Sample time-series for chart
        if (i % sampleStep === 0) {
          condensationTimeSeries.push({
            timestamp: r.timestamp,
            time: new Date(r.timestamp).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
            indoorDewPointF: Math.round(dp * 10) / 10,
            outsideTempF: outsideTempF != null ? Math.round((outsideTempF + 10) * 10) / 10 : null,
            condensationRisk,
          });
          materialDamageTimeSeries.push({
            timestamp: r.timestamp,
            time: new Date(r.timestamp).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
            tempF: Math.round(r.tempF * 10) / 10,
            humidity: Math.round(r.humidity * 10) / 10,
            dewPointF: Math.round(dp * 10) / 10,
            condensationRisk,
            paintScore: Math.round(paintDamageScore * 10) / 10,
            drywallScore: Math.round(drywallDamageScore * 10) / 10,
          });
        }
      }

      const latestSample = readings[readings.length - 1];
      if (materialDamageTimeSeries[materialDamageTimeSeries.length - 1]?.timestamp !== latestSample.timestamp) {
        const dp = dewPointF(latestSample.tempF, latestSample.humidity);
        const coldSurface = outsideTempF != null ? outsideTempF + 10 : 45;
        materialDamageTimeSeries.push({
          timestamp: latestSample.timestamp,
          time: new Date(latestSample.timestamp).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          tempF: Math.round(latestSample.tempF * 10) / 10,
          humidity: Math.round(latestSample.humidity * 10) / 10,
          dewPointF: Math.round(dp * 10) / 10,
          condensationRisk: dp > coldSurface,
          paintScore: Math.round(paintDamageScore * 10) / 10,
          drywallScore: Math.round(drywallDamageScore * 10) / 10,
        });
      }

      const totalHours = Object.values(zoneCounts).reduce((s, v) => s + v, 0);
      const zoneBreakdown: HumidityZoneBreakdown = {
        too_dry: totalHours > 0 ? Math.round(zoneCounts.too_dry / totalHours * 100) : 0,
        ideal: totalHours > 0 ? Math.round(zoneCounts.ideal / totalHours * 100) : 0,
        elevated: totalHours > 0 ? Math.round(zoneCounts.elevated / totalHours * 100) : 0,
        risky: totalHours > 0 ? Math.round(zoneCounts.risky / totalHours * 100) : 0,
        dangerous: totalHours > 0 ? Math.round(zoneCounts.dangerous / totalHours * 100) : 0,
      };

      const latest = readings[readings.length - 1];
      const currentDewPoint = dewPointF(latest.tempF, latest.humidity);
      const currentZone = classifyHumidityZone(latest.humidity);
      const roundedMaterialDamageScore = Math.round(materialDamageScore * 10) / 10;

      // Condensation risk: dew point > estimated cold surface temp
      // Cold surface temp = outside temp + 10°F (single-pane window approximation)
      // Falls back to 45°F when outside temp isn't available
      const coldSurfaceTemp = outsideTempF != null ? outsideTempF + 10 : 45;
      const condensationRisk = currentDewPoint > coldSurfaceTemp;

      return {
        deviceId: device.deviceId,
        deviceName: device.name,
        dewPointF: Math.round(currentDewPoint * 10) / 10,
        condensationRisk,
        zoneBreakdown,
        currentZone,
        materialDamageScore: roundedMaterialDamageScore,
        materialWeight,
        materialImpact: estimateMaterialImpact(
          device.name,
          elevatedHumidityHours,
          highHumidityHours,
          dangerousHumidityHours,
          condensationHours,
          peakHumidity,
          paintDamageScore,
          drywallDamageScore,
          materialDamageTimeSeries,
        ),
        condensationTimeSeries,
        materialDamageTimeSeries,
      };
    });
}

// ─── Ventilation Adequacy Analysis ────────────────────────────────

function detectRoomType(deviceName: string): string {
  const lower = deviceName.toLowerCase();
  if (lower.includes('bath') || lower.includes('shower')) return 'bathroom';
  if (lower.includes('kitchen') || lower.includes('cook')) return 'kitchen';
  if (lower.includes('laundry') || lower.includes('wash')) return 'laundry';
  if (lower.includes('bed') || lower.includes('master')) return 'bedroom';
  return 'default';
}

function analyzeVentilation(
  devices: ShellyDevice[],
  groups: Map<string, { tempF: number; humidity: number; timestamp: number }[]>,
): VentilationProfile[] {
  return devices
    .filter(d => groups.has(d.deviceId))
    .map(device => {
      const readings = groups.get(device.deviceId)!;
      const roomType = detectRoomType(device.name);
      const expectedRecovery = EXPECTED_RECOVERY_MINUTES[roomType] || EXPECTED_RECOVERY_MINUTES.default;

      if (readings.length < 10) {
        return {
          deviceId: device.deviceId,
          deviceName: device.name,
          spikes: [],
          avgRecoveryMinutes: null,
          estimatedACH: null,
          grade: 'moderate' as VentilationGrade,
          expectedRecoveryMinutes: expectedRecovery,
        };
      }

      // Detect humidity spikes: >10% RH increase within 30 minutes
      const spikes: HumiditySpike[] = [];

      // Compute a rolling baseline (median of last ~6 readings)
      for (let i = 2; i < readings.length; i++) {
        const current = readings[i];
        const prev = readings[i - 1];

        // Look back up to 6 readings for baseline
        const baselineWindow = readings.slice(Math.max(0, i - 6), i);
        const baselineHumidity = baselineWindow.reduce((s, r) => s + r.humidity, 0) / baselineWindow.length;

        const timeDiffMin = (current.timestamp - prev.timestamp) / (1000 * 60);

        // Spike detection: sudden rise of >10% RH within 30 min
        if (current.humidity - baselineHumidity > 10 && timeDiffMin < 30) {
          // Track the peak of this spike
          let peakHumidity = current.humidity;
          let peakIdx = i;

          // Walk forward to find the actual peak
          for (let j = i + 1; j < readings.length && j < i + 20; j++) {
            if (readings[j].humidity > peakHumidity) {
              peakHumidity = readings[j].humidity;
              peakIdx = j;
            } else if (readings[j].humidity < peakHumidity - 3) {
              break; // Peak has passed
            }
          }

          // Measure recovery time: how long until humidity returns within 5% of baseline
          let recoveryMinutes: number | null = null;
          const recoveryThreshold = baselineHumidity + 5;

          for (let j = peakIdx + 1; j < readings.length; j++) {
            if (readings[j].humidity <= recoveryThreshold) {
              recoveryMinutes = (readings[j].timestamp - readings[peakIdx].timestamp) / (1000 * 60);
              break;
            }
            // Give up if >4 hours pass without recovery
            if ((readings[j].timestamp - readings[peakIdx].timestamp) / (1000 * 60) > 240) break;
          }

          spikes.push({
            startTime: current.timestamp,
            peakHumidity,
            baselineHumidity: Math.round(baselineHumidity * 10) / 10,
            recoveryMinutes: recoveryMinutes != null ? Math.round(recoveryMinutes) : null,
            recoveryOk: recoveryMinutes != null && recoveryMinutes <= expectedRecovery,
          });

          // Skip past this spike to avoid double-counting
          i = peakIdx + 2;
        }
      }

      // Average recovery time
      const recoveredSpikes = spikes.filter(s => s.recoveryMinutes != null);
      const avgRecoveryMinutes = recoveredSpikes.length > 0
        ? Math.round(recoveredSpikes.reduce((s, sp) => s + sp.recoveryMinutes!, 0) / recoveredSpikes.length)
        : null;

      // Estimate ACH from humidity decay rate
      let estimatedACH: number | null = null;
      if (recoveredSpikes.length > 0) {
        const achValues = recoveredSpikes.map(sp => {
          const decayHours = sp.recoveryMinutes! / 60;
          if (decayHours > 0 && sp.peakHumidity > sp.baselineHumidity) {
            return Math.log(sp.peakHumidity / sp.baselineHumidity) / decayHours;
          }
          return null;
        }).filter((v): v is number => v != null);

        if (achValues.length > 0) {
          estimatedACH = Math.round(achValues.reduce((s, v) => s + v, 0) / achValues.length * 10) / 10;
        }
      }

      // Grade
      let grade: VentilationGrade;
      if (avgRecoveryMinutes != null && avgRecoveryMinutes <= 45) {
        grade = 'good';
      } else if (avgRecoveryMinutes != null && avgRecoveryMinutes <= 90) {
        grade = 'moderate';
      } else {
        grade = 'poor';
      }

      return {
        deviceId: device.deviceId,
        deviceName: device.name,
        spikes,
        avgRecoveryMinutes,
        estimatedACH,
        grade,
        expectedRecoveryMinutes: expectedRecovery,
      };
    });
}

// ─── Exports for UI ───────────────────────────────────────────────

export { SEVERITY_COLORS, HUMIDITY_ZONES, classifyHumidityZone };

/**
 * Human-readable mold index descriptions (VTT scale).
 */
export function moldIndexDescription(index: number): string {
  if (index < 0.5) return 'No growth — conditions are safe';
  if (index < 1.0) return 'Early favorable conditions — microscopic spores may begin germinating';
  if (index < 2.0) return 'Microscopic mold starting on surface — not yet visible';
  if (index < 3.0) return 'Moderate microscopic coverage — approaching visibility threshold';
  if (index < 4.0) return 'Visible mold growth detectable by eye';
  if (index < 5.0) return 'Significant visible coverage (>10% of surface)';
  return 'Extensive/heavy mold coverage — professional remediation needed';
}

/**
 * Get mold prevention actions based on severity.
 */
export function getMoldPreventionActions(severity: MoldGrowthRoomProfile['severity']): {
  actions: string[];
  urgency: string;
  estimatedCost: string;
} {
  switch (severity) {
    case 'none':
      return {
        actions: ['Continue monitoring', 'Maintain humidity below 55%'],
        urgency: 'None',
        estimatedCost: '$0',
      };
    case 'low':
      return {
        actions: [
          'Improve ventilation — run bathroom exhaust fans 15+ min after showers',
          'Open windows periodically for cross-ventilation',
          'Check that dryer vents to outside, not crawlspace',
        ],
        urgency: 'Within 2 weeks',
        estimatedCost: '$0–$50',
      };
    case 'moderate':
      return {
        actions: [
          'Run a dehumidifier in affected rooms (set to 45–50%)',
          'Check for hidden water leaks behind walls or under sinks',
          'Clean HVAC filters and inspect ductwork for moisture',
          'Apply mold-resistant paint to affected areas',
        ],
        urgency: 'Within 1 week',
        estimatedCost: '$50–$300',
      };
    case 'high':
      return {
        actions: [
          'Run dehumidifier continuously until RH drops below 50%',
          'Inspect for active water intrusion — roof, foundation, plumbing',
          'Clean visible condensation on windows and cold surfaces',
          'Consider professional moisture assessment',
          'Check crawlspace vapor barrier if applicable',
        ],
        urgency: 'Within 48 hours',
        estimatedCost: '$200–$800',
      };
    case 'critical':
      return {
        actions: [
          'URGENT: Engage professional mold remediation',
          'Inspect behind drywall for hidden mold colonies',
          'Address water source immediately — leaks, condensation, flooding',
          'Consider air quality testing (spore count)',
          'Affected materials (drywall, carpet) may need removal',
          'Notify tenants of health risk if applicable',
        ],
        urgency: 'Immediate',
        estimatedCost: '$500–$5,000+',
      };
  }
}
