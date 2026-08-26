/**
 * Thermal Leak Cost Engine
 * 
 * Calculates the "insulation efficiency tax" — how much extra money a
 * poorly-insulated room costs in heating/cooling energy — using real
 * sensor data from multiple rooms plus outside temperature.
 * 
 * Physics basis:
 *   In steady state, room temp settles where HVAC heat input = heat loss through walls.
 *   Heat loss rate Q = A × ΔT / R  (where R = insulation R-value).
 *   If two rooms get the same HVAC input but one is colder, its R-value is lower.
 *   The ratio of (T_room - T_outside) between rooms directly reflects relative R-values.
 * 
 * Data sources:
 *   - Indoor: Shelly BLU H&T sensors (per-room temp every ~5 min)
 *   - Outdoor: OpenWeather API (fetched client-side)
 *   - Historical: Firestore sensor_readings collection
 */

import type { SensorChartData } from '../types/iot';
import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';

// ─── Types ────────────────────────────────────────────────────────

export type HvacType = 'electric_resistance' | 'heat_pump' | 'gas_furnace' | 'oil_furnace';
export type HeatingCoolingMode = 'heating' | 'cooling' | 'idle';

export interface ThermalLeakConfig {
  /** HVAC system type — affects efficiency conversion */
  hvacType: HvacType;
  /** Electricity rate in $/kWh (US avg ~0.16) */
  electricRate: number;
  /** Gas rate in $/therm (US avg ~1.20) */
  gasRate: number;
  /** Estimated room floor area in sq ft (default 150) */
  defaultRoomSqFt: number;
  /** Ceiling height in ft (default 8) */
  ceilingHeightFt: number;
  /** Threshold °F diff from median to flag as leak (default 5) */
  leakThresholdF: number;
  /** Override room sizes: deviceId → sq ft */
  roomSizes?: Record<string, number>;
}

export interface RoomThermalProfile {
  deviceId: string;
  deviceName: string;
  /** Average temperature over the analysis window (°F) */
  avgTempF: number;
  /** How many °F this room deviates from the house median */
  deviationF: number;
  /** Thermal resistance ratio vs baseline (1.0 = same as avg, <1 = leakier) */
  rRatio: number;
  /** Insulation grade A–F */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Extra BTU/hr this room demands vs a baseline room */
  excessBtuPerHour: number;
  /** Estimated extra $/month this room costs */
  excessCostPerMonth: number;
  /** Estimated extra $/year (seasonal projection) */
  excessCostPerYear: number;
  /** Whether this room is classified as a "leak" */
  isLeak: boolean;
  /** Data confidence 0-100% */
  confidence: number;
  /** Number of readings used */
  dataPoints: number;
  /** Trend: is the leak getting worse, better, or stable? */
  trend: 'worsening' | 'improving' | 'stable' | 'insufficient_data';
}

export interface ThermalLeakAnalysisResult {
  /** Timestamp of analysis */
  analyzedAt: Date;
  /** Detected HVAC mode based on outside vs inside temps */
  mode: HeatingCoolingMode;
  /** Outside temperature used (°F) */
  outsideTempF: number;
  /** House median temperature (°F) — the "baseline" */
  houseMedianTempF: number;
  /** Per-room profiles */
  rooms: RoomThermalProfile[];
  /** Total extra monthly cost across all leak rooms */
  totalExcessMonthly: number;
  /** Total extra annual cost (seasonal projection) */
  totalExcessAnnual: number;
  /** Overall confidence in the analysis */
  confidence: number;
  /** How many sensors contributed */
  sensorCount: number;
  /** Hours of data analyzed (actual data span, not a fixed window) */
  hoursAnalyzed: number;
  /** Total sensor readings used across all devices */
  totalReadingsUsed: number;
  /** Potential annual savings if all rooms matched best room */
  potentialAnnualSavings: number;
  /** Time-series data for the thermal gap chart */
  timeSeriesGap: ThermalGapPoint[];
}

export interface ThermalGapPoint {
  timestamp: number;
  time: string;
  outsideTempF: number;
  medianIndoorF: number;
  /** Per-device temps at this timestamp */
  deviceTemps: Record<string, number>;
}

// ─── Constants ────────────────────────────────────────────────────

/** Volumetric heat capacity of air: BTU per cubic foot per °F */
const AIR_HEAT_CAPACITY = 0.018;

/** HVAC efficiency factors (COP or AFUE) */
const HVAC_EFFICIENCY: Record<HvacType, number> = {
  electric_resistance: 1.0,   // 100% efficient (but expensive per BTU)
  heat_pump: 2.5,             // COP 2.5 typical
  gas_furnace: 0.95,          // 95% AFUE
  oil_furnace: 0.85,          // 85% AFUE
};

/** BTU per kWh */
const BTU_PER_KWH = 3_412;

/** BTU per therm */
const BTU_PER_THERM = 100_000;

/** Hours per month (average) */
const HOURS_PER_MONTH = 730;

/** Seasonal multiplier — rough estimate of what fraction of the year
 *  requires active heating or cooling. Varies by climate zone. */
const SEASONAL_ACTIVE_FRACTION = 0.55; // ~6.5 months of heating+cooling season

/** Minimum ΔT between outside and inside to produce meaningful analysis */
const MIN_DELTA_T_F = 8;

/** Reference indoor-outdoor ΔT for stable cost projections (°F).
 *  Represents a typical seasonal average during active HVAC months.
 *  Used instead of the current spot outside temp so that annual cost
 *  estimates don't swing wildly between day (small ΔT) and night (large ΔT),
 *  or between mild and extreme weather days.
 *  Based on US average: ~4500 HDD + ~1200 CDD ≈ 20°F avg ΔT during active months. */
const REFERENCE_DESIGN_DELTA_T_F = 20;

// ─── Default Config ───────────────────────────────────────────────

export const DEFAULT_THERMAL_CONFIG: ThermalLeakConfig = {
  hvacType: 'heat_pump',
  electricRate: 0.16,
  gasRate: 1.20,
  defaultRoomSqFt: 150,
  ceilingHeightFt: 8,
  leakThresholdF: 5,
};

// ─── Helpers ──────────────────────────────────────────────────────

function cToF(c: number): number {
  return (c * 9 / 5) + 32;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gradeFromRatio(rRatio: number): RoomThermalProfile['grade'] {
  // rRatio: 1.0 = perfect match to baseline, lower = leakier
  if (rRatio >= 0.97) return 'A';
  if (rRatio >= 0.92) return 'B';
  if (rRatio >= 0.85) return 'C';
  if (rRatio >= 0.75) return 'D';
  return 'F';
}

function gradeColor(grade: RoomThermalProfile['grade']): string {
  switch (grade) {
    case 'A': return '#22c55e';
    case 'B': return '#84cc16';
    case 'C': return '#eab308';
    case 'D': return '#f97316';
    case 'F': return '#ef4444';
  }
}

// ─── Core Analysis ────────────────────────────────────────────────

/**
 * Group sensor readings by device, converting to °F, within a time window.
 * Pass hoursBack = 0 to include ALL available readings (no cutoff).
 */
function groupReadingsByDevice(
  readings: SensorReading[],
  devices: ShellyDevice[],
  hoursBack: number
): Map<string, { tempF: number; timestamp: number }[]> {
  const cutoff = hoursBack > 0 ? Date.now() - hoursBack * 60 * 60 * 1000 : 0;
  const deviceMap = new Map(devices.map(d => [d.deviceId, d]));
  const groups = new Map<string, { tempF: number; timestamp: number }[]>();

  for (const r of readings) {
    if (r.temperature == null) continue;
    const ts = r.timestamp.getTime();
    if (ts < cutoff) continue;

    const device = deviceMap.get(r.deviceId);
    if (!device) continue;

    const key = r.deviceId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({
      tempF: cToF(r.temperature),
      timestamp: ts,
    });
  }

  // Sort each group by time
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
  }

  return groups;
}

/**
 * Compute the trend of a room's deviation over time.
 * Splits the data into first half and second half and compares avg deviation.
 */
function computeTrend(
  roomReadings: { tempF: number; timestamp: number }[],
  medianByTimestamp: Map<number, number>
): RoomThermalProfile['trend'] {
  if (roomReadings.length < 10) return 'insufficient_data';

  const deviations = roomReadings
    .map(r => {
      // Find closest median timestamp
      let closestMedian = 0;
      let closestDist = Infinity;
      for (const [ts, med] of medianByTimestamp) {
        const dist = Math.abs(ts - r.timestamp);
        if (dist < closestDist) {
          closestDist = dist;
          closestMedian = med;
        }
      }
      return Math.abs(r.tempF - closestMedian);
    });

  const mid = Math.floor(deviations.length / 2);
  const firstHalfAvg = deviations.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const secondHalfAvg = deviations.slice(mid).reduce((a, b) => a + b, 0) / (deviations.length - mid);

  const change = secondHalfAvg - firstHalfAvg;
  if (change > 1.5) return 'worsening';
  if (change < -1.5) return 'improving';
  return 'stable';
}

/**
 * Main analysis function.
 * 
 * Uses ALL available sensor data for cost/grade calculations (ΔT-weighted),
 * and a separate chart window for the time-series display.
 * 
 * @param devices - All Shelly devices (filtered by property already)
 * @param readings - Historical sensor readings
 * @param outsideTempF - Current outside temperature in °F
 * @param config - User-configurable parameters
 * @param chartHoursBack - How many hours of data to show in the chart (default 24)
 */
export function analyzeThermalLeaks(
  devices: ShellyDevice[],
  readings: SensorReading[],
  outsideTempF: number,
  config: ThermalLeakConfig = DEFAULT_THERMAL_CONFIG,
  chartHoursBack: number = 24
): ThermalLeakAnalysisResult | null {

  // Step 0: Group ALL readings by device (no time cutoff) for analysis
  const allGroups = groupReadingsByDevice(readings, devices, 0);
  // Separate chart-windowed groups for time-series display
  const chartGroups = groupReadingsByDevice(readings, devices, chartHoursBack);

  const tempDevices = devices.filter(d => allGroups.has(d.deviceId) && (allGroups.get(d.deviceId)!.length >= 3));

  if (tempDevices.length < 2) return null; // Need at least 2 sensors

  // Step 1: Compute per-device ΔT-weighted average temperature.
  // Readings taken when indoor-outdoor ΔT is large carry more weight,
  // because that's when insulation differences are most measurable.
  // We compute a time-aligned house median for each reading, then weight
  // by the absolute difference between that median and the outside temp.
  
  // First, build a time-bucketed house median for weighting
  const ALL_BUCKET_MS = 15 * 60 * 1000;
  const allBuckets = new Map<number, number[]>();
  for (const device of tempDevices) {
    for (const r of allGroups.get(device.deviceId)!) {
      const bucket = Math.floor(r.timestamp / ALL_BUCKET_MS) * ALL_BUCKET_MS;
      if (!allBuckets.has(bucket)) allBuckets.set(bucket, []);
      allBuckets.get(bucket)!.push(r.tempF);
    }
  }
  const allMedianByTimestamp = new Map<number, number>();
  for (const [bucket, temps] of allBuckets) {
    allMedianByTimestamp.set(bucket, median(temps));
  }

  // Compute overall house median from all data
  const allDeviceAvgs: number[] = [];
  for (const device of tempDevices) {
    const deviceReadings = allGroups.get(device.deviceId)!;
    const avg = deviceReadings.reduce((s, r) => s + r.tempF, 0) / deviceReadings.length;
    allDeviceAvgs.push(avg);
  }
  const overallHouseMedianF = median(allDeviceAvgs);

  // Now compute ΔT-weighted averages per device.
  // Weight = max(1, abs(bucketMedian - outsideTempF))
  // This ensures readings during extreme weather (large ΔT) dominate.
  // We use a minimum weight of 1 so mild-weather readings still contribute.
  const deviceAvgs = new Map<string, number>();
  const deviceDataSpanHours = new Map<string, number>();
  for (const device of tempDevices) {
    const deviceReadings = allGroups.get(device.deviceId)!;
    let weightedSum = 0;
    let totalWeight = 0;
    for (const r of deviceReadings) {
      const bucket = Math.floor(r.timestamp / ALL_BUCKET_MS) * ALL_BUCKET_MS;
      const bucketMedian = allMedianByTimestamp.get(bucket) ?? overallHouseMedianF;
      const deltaT = Math.abs(bucketMedian - outsideTempF);
      // Use the actual indoor-outdoor gap as weight. We don't have historical
      // outside temps, so we use the current outside temp as a proxy. When the
      // HVAC is active (large gap), the reading is more diagnostic.
      // TODO: If historical outside temps become available, use per-reading outside temp.
      const weight = Math.max(1, deltaT);
      weightedSum += r.tempF * weight;
      totalWeight += weight;
    }
    const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;
    deviceAvgs.set(device.deviceId, weightedAvg);

    // Track data span for confidence
    const oldest = deviceReadings[0].timestamp;
    const newest = deviceReadings[deviceReadings.length - 1].timestamp;
    deviceDataSpanHours.set(device.deviceId, (newest - oldest) / (1000 * 60 * 60));
  }

  // House median from ΔT-weighted averages
  const weightedAllAvgs = Array.from(deviceAvgs.values());
  const houseMedianF = median(weightedAllAvgs);

  // Determine heating or cooling mode
  const mode: HeatingCoolingMode =
    outsideTempF < houseMedianF - 5 ? 'heating' :
    outsideTempF > houseMedianF + 5 ? 'cooling' : 'idle';

  // Check ΔT between outside and inside.
  const deltaT = Math.abs(houseMedianF - outsideTempF);
  const isMildWeather = deltaT < MIN_DELTA_T_F;

  // Use the reference ΔT for all cost and R-ratio calculations
  const effectiveDeltaT = REFERENCE_DESIGN_DELTA_T_F;

  // Compute the actual hours of data analyzed (max span across devices)
  const maxDataSpanHours = Math.max(...Array.from(deviceDataSpanHours.values()), 0);
  const totalReadingsUsed = tempDevices.reduce((sum, d) => sum + (allGroups.get(d.deviceId)?.length ?? 0), 0);

  // Step 2: Build time-bucketed median map for CHART window only (for trend + chart)
  const BUCKET_MS = 15 * 60 * 1000;
  const buckets = new Map<number, number[]>();
  for (const device of tempDevices) {
    const chartDeviceReadings = chartGroups.get(device.deviceId);
    if (!chartDeviceReadings) continue;
    for (const r of chartDeviceReadings) {
      const bucket = Math.floor(r.timestamp / BUCKET_MS) * BUCKET_MS;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(r.tempF);
    }
  }
  const medianByTimestamp = new Map<number, number>();
  for (const [bucket, temps] of buckets) {
    medianByTimestamp.set(bucket, median(temps));
  }

  // Step 3: Compute per-room thermal profile
  const efficiency = HVAC_EFFICIENCY[config.hvacType];
  const isGasFuel = config.hvacType === 'gas_furnace' || config.hvacType === 'oil_furnace';
  const costPerBtu = isGasFuel
    ? config.gasRate / BTU_PER_THERM / efficiency
    : config.electricRate / BTU_PER_KWH / efficiency;

  const rooms: RoomThermalProfile[] = tempDevices.map(device => {
    const avgTempF = deviceAvgs.get(device.deviceId)!;
    const deviceReadings = allGroups.get(device.deviceId)!;
    const roomSqFt = config.roomSizes?.[device.deviceId] || config.defaultRoomSqFt;
    const roomVolume = roomSqFt * config.ceilingHeightFt;

    // Deviation from median (positive = warmer, negative = colder)
    const deviationF = avgTempF - houseMedianF;

    // Thermal resistance ratio — uses reference ΔT for stability.
    // R_ratio = (referenceΔT + deviation) / referenceΔT
    // A room at the house median gets ratio 1.0.
    // Heating: colder room = leakier (< 1.0). Cooling: warmer room = leakier.
    // Idle: any drift from the house median counts against the room, so the
    // grade agrees with the cost model (which also penalizes absolute drift).
    const absDeviation = Math.abs(deviationF);
    const gradeDeviation = mode === 'heating'
      ? deviationF
      : mode === 'cooling'
        ? -deviationF
        : -absDeviation;
    const rRatio = clamp(
      (effectiveDeltaT + gradeDeviation) / effectiveDeltaT,
      0.3, 1.5
    );
    const leakLoadF = mode === 'cooling'
      ? Math.max(0, deviationF)
      : mode === 'heating'
        ? Math.max(0, -deviationF)
        : absDeviation;
    const isLeak = leakLoadF > config.leakThresholdF;

    // Excess BTU/hr:
    // Only the costly side of the room-to-house gap should be charged.
    // In cooling, a warmer room is underperforming; in heating, a colder room is underperforming.
    // Approximate exterior wall area: assume 2 exterior walls per room
    const wallHeight = config.ceilingHeightFt;
    const wallLength = Math.sqrt(roomSqFt);
    const exteriorWallArea = 2 * wallLength * wallHeight;
    
    // Using simplified conduction: Q = U × A × ΔT
    // The extra heat loss = the gap the HVAC fails to close × area × U_differential
    // Simplified to: BTU/hr ≈ exteriorWallArea × directional gap × 0.5 (empirical correction)
    const excessBtuPerHour = leakLoadF > 0.5
      ? exteriorWallArea * leakLoadF * 0.5
      : 0;

    // Cost projections use the reference ΔT to produce stable annual estimates.
    // Instead of extrapolating from the current outside temperature (which causes
    // costs to swing from $0 during mild afternoons to $1000+ on cold nights),
    // we use a degree-day normalized approach:
    //
    //   Annual cost = excessBtuPerHour × active_HVAC_hours_per_year × costPerBtu
    //   Where active_HVAC_hours_per_year ≈ HOURS_PER_MONTH × 12 × SEASONAL_ACTIVE_FRACTION
    //
    // The excessBtuPerHour is based on room deviation from median (measured from
    // sensor averages over the analysis window), so it's already a moving average.
    const annualActiveHours = HOURS_PER_MONTH * 12 * SEASONAL_ACTIVE_FRACTION;
    const excessCostPerYear = excessBtuPerHour * annualActiveHours * costPerBtu;
    const excessCostPerMonth = excessCostPerYear / 12;

    // Confidence scoring — rewards more data points and longer data spans
    let confidence = 20;
    confidence += Math.min(30, deviceReadings.length * 0.1); // up to 30 for 300+ readings
    confidence += Math.min(20, absDeviation * 2);
    confidence += tempDevices.length >= 3 ? 15 : 5;
    // Reward longer data spans: 7+ days = full 15 pts
    const deviceSpanHours = deviceDataSpanHours.get(device.deviceId) ?? 0;
    confidence += deviceSpanHours >= 168 ? 15 : deviceSpanHours >= 24 ? 10 : 3;
    // Reduce confidence when current ΔT is small (insulation differences less detectable)
    if (isMildWeather) confidence -= 15;
    confidence = clamp(Math.round(confidence), 10, 95);

    // Trend analysis (uses chart window readings for recent trend display)
    const chartDeviceReadings = chartGroups.get(device.deviceId) || deviceReadings;
    const trend = computeTrend(chartDeviceReadings, medianByTimestamp);

    // Insulation grade based on R-ratio (already computed with reference ΔT)
    const grade = gradeFromRatio(clamp(rRatio, 0.3, 1.1));

    return {
      deviceId: device.deviceId,
      deviceName: device.name,
      avgTempF: Math.round(avgTempF * 10) / 10,
      deviationF: Math.round(deviationF * 10) / 10,
      rRatio: Math.round(rRatio * 1000) / 1000,
      grade,
      excessBtuPerHour: Math.round(excessBtuPerHour),
      excessCostPerMonth: Math.round(excessCostPerMonth * 100) / 100,
      excessCostPerYear: Math.round(excessCostPerYear * 100) / 100,
      isLeak,
      confidence,
      dataPoints: deviceReadings.length,
      trend,
    };
  });

  // Step 4: Build time-series for the thermal gap chart (chart window only)
  const sortedBuckets = Array.from(buckets.keys()).sort();
  const timeSeriesGap: ThermalGapPoint[] = sortedBuckets.map(bucket => {
    const temps: Record<string, number> = {};
    for (const device of tempDevices) {
      const chartDeviceReadings = chartGroups.get(device.deviceId);
      if (!chartDeviceReadings) continue;
      // Find reading closest to this bucket
      let closest: { tempF: number; timestamp: number } | null = null;
      let closestDist = Infinity;
      for (const r of chartDeviceReadings) {
        const dist = Math.abs(r.timestamp - bucket);
        if (dist < closestDist) {
          closestDist = dist;
          closest = r;
        }
      }
      if (closest && closestDist < BUCKET_MS * 2) {
        const safeName = device.name.replace(/[^a-zA-Z0-9]/g, '_');
        temps[safeName] = Math.round(closest.tempF * 10) / 10;
      }
    }
    const medianF = medianByTimestamp.get(bucket) || houseMedianF;
    return {
      timestamp: bucket,
      time: new Date(bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      outsideTempF: outsideTempF, // Constant for now; could be time-series in future
      medianIndoorF: Math.round(medianF * 10) / 10,
      deviceTemps: temps,
    };
  });

  // Totals — sum excess cost across rooms with a directional HVAC penalty, not high-performing comparators
  const totalExcessMonthly = rooms.reduce((s, r) => s + r.excessCostPerMonth, 0);
  const totalExcessAnnual = rooms.reduce((s, r) => s + r.excessCostPerYear, 0);

  // Potential savings = what if all rooms were as good as the best?
  const bestGrade = rooms.reduce((best, r) => r.rRatio > best ? r.rRatio : best, 0);
  const potentialAnnualSavings = rooms
    .filter(r => r.rRatio < bestGrade * 0.95)
    .reduce((s, r) => s + r.excessCostPerYear, 0);

  // Overall confidence
  const avgConfidence = rooms.length > 0
    ? Math.round(rooms.reduce((s, r) => s + r.confidence, 0) / rooms.length)
    : 0;

  return {
    analyzedAt: new Date(),
    mode,
    outsideTempF: Math.round(outsideTempF * 10) / 10,
    houseMedianTempF: Math.round(houseMedianF * 10) / 10,
    rooms,
    totalExcessMonthly: Math.round(totalExcessMonthly * 100) / 100,
    totalExcessAnnual: Math.round(totalExcessAnnual * 100) / 100,
    confidence: avgConfidence,
    sensorCount: tempDevices.length,
    hoursAnalyzed: Math.round(maxDataSpanHours),
    totalReadingsUsed,
    potentialAnnualSavings: Math.round(potentialAnnualSavings * 100) / 100,
    timeSeriesGap,
  };
}

// ─── Exports for UI ───────────────────────────────────────────────

export { gradeColor };

/**
 * Get the recommended insulation fix and estimated cost for a room grade.
 */
export function getInsulationRecommendation(grade: RoomThermalProfile['grade'], roomSqFt: number = 150): {
  action: string;
  estimatedCost: string;
  paybackPeriod: string;
  description: string;
} {
  switch (grade) {
    case 'A':
      return {
        action: 'No action needed',
        estimatedCost: '$0',
        paybackPeriod: 'N/A',
        description: 'This room is well-insulated and performing at or above average.',
      };
    case 'B':
      return {
        action: 'Weatherstrip doors & windows',
        estimatedCost: '$50–$150',
        paybackPeriod: '6–18 months',
        description: 'Minor air sealing around doors and windows could eliminate the small thermal gap.',
      };
    case 'C':
      return {
        action: 'Seal air leaks + add window film',
        estimatedCost: '$150–$400',
        paybackPeriod: '1–2 years',
        description: 'Check for gaps around outlets, baseboards, and windows. Low-e window film or cellular shades can help.',
      };
    case 'D':
      return {
        action: 'Add insulation + seal ductwork',
        estimatedCost: '$500–$2,000',
        paybackPeriod: '2–4 years',
        description: 'This room is losing significant heat. Consider blown-in insulation, sealing duct connections, and checking for disconnected HVAC zones.',
      };
    case 'F':
      return {
        action: 'Major insulation upgrade needed',
        estimatedCost: `$1,500–$4,000`,
        paybackPeriod: '3–6 years',
        description: 'This room has serious insulation deficiencies — possibly missing wall insulation, single-pane windows, or major air infiltration. A professional energy audit is recommended.',
      };
  }
}

/**
 * Fetch current outside temperature from OpenWeather API.
 * Returns temperature in °F, or null on failure.
 */
export async function fetchOutsideTemperature(
  lat: number,
  lng: number,
  apiKey: string
): Promise<{ tempF: number; humidity: number; description: string; icon: string } | null> {
  try {
    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}&units=imperial`
    );
    if (!response.ok) return null;
    const data = await response.json();
    return {
      tempF: data.main?.temp ?? null,
      humidity: data.main?.humidity ?? null,
      description: data.weather?.[0]?.description ?? '',
      icon: data.weather?.[0]?.icon ?? '',
    };
  } catch {
    return null;
  }
}
