/**
 * Predictive Maintenance Service
 * 
 * Analyzes continuous temperature and humidity sensor data to detect
 * patterns that predict maintenance issues before they occur:
 * 
 * - Mold Risk: Sustained humidity above 60% for 4+ hours
 * - Freeze Risk: Temperature dropping toward freezing
 * - Pipe Burst Risk: Extreme cold that could cause pipes to burst
 * - Insulation Failure: One room significantly colder than others
 * - HVAC Malfunction: Abnormal temp patterns
 * - Humidity Damage: Sustained very high humidity
 * - Rapid Temperature Change: Temperature swings indicating drafts/issues
 * - Ventilation Issue: Humidity not normalizing after peaks
 */

import type { 
  PredictiveMaintenanceRisk, 
  PredictiveThresholds, 
  PredictiveRiskType,
  SensorChartData 
} from '../types/iot';
import type { ShellyDevice, SensorReading } from '../hooks/useShellyFirestore';

// Default thresholds (can be customized per property)
// See src/types/iot.ts for full research-based documentation
export const DEFAULT_THRESHOLDS: PredictiveThresholds = {
  moldHumidityPercent: 60,           // EPA: mold spores germinate above 60% RH
  moldSustainedMinutes: 240,         // 4 hours — early warning before 24-48hr growth
  freezeWarningTempF: 38,            // Industry standard warning level
  freezeCriticalTempF: 32,           // Water freezing point
  pipeBurstTempF: 20,               // IBHS: most pipe bursts occur at/below 20°F
  insulationDiffTempF: 15,          // 15°F diff = significant thermal bridge
  rapidTempChangePerHourF: 10,      // 10°F/hr indicates draft or HVAC failure
  highHumidityPercent: 70,           // Material damage begins above 70%
  lowHumidityPercent: 25,            // Below 25% can cause wood cracking
  ventilationHumidityMinutes: 120,   // 2 hours for humidity to normalize
};

// Risk type metadata for UI display
export const RISK_METADATA: Record<PredictiveRiskType, {
  icon: string;
  color: string;
  category: string;
}> = {
  mold_risk: { icon: '🦠', color: '#22c55e', category: 'Moisture' },
  freeze_risk: { icon: '🥶', color: '#3b82f6', category: 'Temperature' },
  pipe_burst_risk: { icon: '💥', color: '#ef4444', category: 'Temperature' },
  insulation_failure: { icon: '🏠', color: '#f59e0b', category: 'Temperature' },
  hvac_malfunction: { icon: '❄️', color: '#8b5cf6', category: 'HVAC' },
  humidity_damage: { icon: '💧', color: '#06b6d4', category: 'Moisture' },
  rapid_temp_change: { icon: '📈', color: '#f97316', category: 'Temperature' },
  ventilation_issue: { icon: '🌬️', color: '#64748b', category: 'Air Quality' },
};

/**
 * Convert Celsius to Fahrenheit
 */
function cToF(c: number): number {
  return (c * 9 / 5) + 32;
}

/**
 * Generate a unique risk ID
 */
function generateRiskId(deviceId: string, riskType: PredictiveRiskType): string {
  return `risk-${deviceId}-${riskType}-${Date.now()}`;
}

/**
 * Analyze readings for mold risk (sustained high humidity)
 */
function analyzeMoldRisk(
  device: ShellyDevice,
  readings: SensorReading[],
  thresholds: PredictiveThresholds,
  propertyAddress?: string
): PredictiveMaintenanceRisk | null {
  const humidityReadings = readings
    .filter(r => r.deviceId === device.deviceId && r.humidity != null)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (humidityReadings.length < 3) return null;

  // Check how long humidity has been above threshold
  const currentHumidity = humidityReadings[0].humidity!;
  if (currentHumidity < thresholds.moldHumidityPercent) return null;

  // Count consecutive readings above threshold
  let sustainedCount = 0;
  let earliestAbove: Date | null = null;
  for (const reading of humidityReadings) {
    if (reading.humidity != null && reading.humidity >= thresholds.moldHumidityPercent) {
      sustainedCount++;
      earliestAbove = reading.timestamp;
    } else {
      break;
    }
  }

  if (sustainedCount < 2) return null;

  const durationMs = humidityReadings[0].timestamp.getTime() - (earliestAbove?.getTime() || 0);
  const durationMinutes = durationMs / (1000 * 60);
  const isSustained = durationMinutes >= thresholds.moldSustainedMinutes;

  // Calculate severity based on level and duration
  let severity: PredictiveMaintenanceRisk['severity'] = 'low';
  if (currentHumidity >= 75 && isSustained) severity = 'critical';
  else if (currentHumidity >= 70 || isSustained) severity = 'high';
  else if (currentHumidity >= 65) severity = 'medium';

  const durationHours = Math.round(durationMinutes / 60);

  return {
    id: generateRiskId(device.deviceId, 'mold_risk'),
    deviceId: device.deviceId,
    deviceName: device.name,
    propertyId: device.propertyId,
    propertyAddress,
    riskType: 'mold_risk',
    severity,
    confidence: Math.min(95, 50 + sustainedCount * 5 + (currentHumidity - thresholds.moldHumidityPercent) * 2),
    title: 'Elevated Mold Risk Detected',
    description: `Humidity has been at ${currentHumidity.toFixed(0)}% for ${durationHours > 0 ? `${durationHours} hours` : `${Math.round(durationMinutes)} minutes`} in ${device.name}. Sustained humidity above ${thresholds.moldHumidityPercent}% creates conditions favorable for mold growth.`,
    recommendation: isSustained 
      ? 'Immediate action recommended: Check for water leaks, improve ventilation, and consider running a dehumidifier. Inspect area for visible mold.'
      : 'Monitor closely. Ensure proper ventilation in the area. Consider running exhaust fans or a dehumidifier.',
    detectedAt: new Date(),
    dataPoints: sustainedCount,
    thresholdValue: thresholds.moldHumidityPercent,
    currentValue: currentHumidity,
    trendDirection: humidityReadings.length >= 3 
      ? (humidityReadings[0].humidity! > humidityReadings[2].humidity! ? 'rising' : 
         humidityReadings[0].humidity! < humidityReadings[2].humidity! ? 'falling' : 'stable')
      : 'stable',
    estimatedTimeToIssue: isSustained ? '1-3 days' : '5-14 days',
    dismissed: false,
  };
}

/**
 * Analyze readings for freeze & pipe burst risk
 */
function analyzeFreezeRisk(
  device: ShellyDevice,
  readings: SensorReading[],
  thresholds: PredictiveThresholds,
  propertyAddress?: string
): PredictiveMaintenanceRisk | null {
  const tempReadings = readings
    .filter(r => r.deviceId === device.deviceId && r.temperature != null)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (tempReadings.length < 2) return null;

  const currentTempC = tempReadings[0].temperature!;
  const currentTempF = cToF(currentTempC);

  // Check for pipe burst risk first (most critical)
  if (currentTempF <= thresholds.pipeBurstTempF) {
    return {
      id: generateRiskId(device.deviceId, 'pipe_burst_risk'),
      deviceId: device.deviceId,
      deviceName: device.name,
      propertyId: device.propertyId,
      propertyAddress,
      riskType: 'pipe_burst_risk',
      severity: 'critical',
      confidence: 90,
      title: '🚨 Pipe Burst Risk — Extreme Cold',
      description: `Temperature at ${device.name} has dropped to ${currentTempF.toFixed(0)}°F (${currentTempC.toFixed(1)}°C). At these temperatures, water pipes are at severe risk of freezing and bursting, which can cause catastrophic water damage.`,
      recommendation: 'URGENT: Open cabinet doors under sinks. Let faucets drip slowly. If possible, increase heating to the area immediately. Consider shutting off water main if property is unoccupied. Inspect exposed pipes for frost.',
      detectedAt: new Date(),
      dataPoints: tempReadings.length,
      thresholdValue: thresholds.pipeBurstTempF,
      currentValue: currentTempF,
      trendDirection: tempReadings.length >= 3
        ? (cToF(tempReadings[0].temperature!) < cToF(tempReadings[2].temperature!) ? 'falling' : 'rising')
        : 'stable',
      estimatedTimeToIssue: 'Imminent (hours)',
      dismissed: false,
    };
  }

  // Check for freeze warning
  if (currentTempF <= thresholds.freezeCriticalTempF) {
    return {
      id: generateRiskId(device.deviceId, 'freeze_risk'),
      deviceId: device.deviceId,
      deviceName: device.name,
      propertyId: device.propertyId,
      propertyAddress,
      riskType: 'freeze_risk',
      severity: 'high',
      confidence: 80,
      title: 'Freezing Temperature Detected',
      description: `Temperature at ${device.name} is ${currentTempF.toFixed(0)}°F (${currentTempC.toFixed(1)}°C) — at or below freezing. Pipes and water fixtures are at risk.`,
      recommendation: 'Keep interior temperatures above 55°F. Open cabinet doors under sinks. Consider letting faucets drip to prevent pipe freezing. Check that heating is functioning properly.',
      detectedAt: new Date(),
      dataPoints: tempReadings.length,
      thresholdValue: thresholds.freezeCriticalTempF,
      currentValue: currentTempF,
      trendDirection: 'falling',
      estimatedTimeToIssue: '12-48 hours',
      dismissed: false,
    };
  }

  // Check for freeze warning (approaching freezing)
  if (currentTempF <= thresholds.freezeWarningTempF) {
    // Check if temperature is trending downward
    const isDropping = tempReadings.length >= 3 && 
      cToF(tempReadings[0].temperature!) < cToF(tempReadings[1].temperature!) &&
      cToF(tempReadings[1].temperature!) < cToF(tempReadings[2].temperature!);

    if (isDropping) {
      return {
        id: generateRiskId(device.deviceId, 'freeze_risk'),
        deviceId: device.deviceId,
        deviceName: device.name,
        propertyId: device.propertyId,
        propertyAddress,
        riskType: 'freeze_risk',
        severity: 'medium',
        confidence: 65,
        title: 'Temperature Approaching Freezing',
        description: `Temperature at ${device.name} is ${currentTempF.toFixed(0)}°F and dropping. If this trend continues, it could reach freezing within hours.`,
        recommendation: 'Ensure heating is on and set to at least 55°F. Check that windows and doors are fully closed. Monitor temperature trend.',
        detectedAt: new Date(),
        dataPoints: tempReadings.length,
        thresholdValue: thresholds.freezeWarningTempF,
        currentValue: currentTempF,
        trendDirection: 'falling',
        estimatedTimeToIssue: '2-5 days',
        dismissed: false,
      };
    }
  }

  return null;
}

/**
 * Analyze readings for insulation failure (room significantly colder than others)
 */
function analyzeInsulationFailure(
  device: ShellyDevice,
  allDevices: ShellyDevice[],
  readings: SensorReading[],
  thresholds: PredictiveThresholds,
  propertyAddress?: string
): PredictiveMaintenanceRisk | null {
  // Only compare devices at the same property
  const propertyDevices = allDevices.filter(d => 
    d.propertyId === device.propertyId && d.temperature != null && d.deviceId !== device.deviceId
  );

  if (propertyDevices.length < 1 || device.temperature == null) return null;

  const currentTempF = cToF(device.temperature);
  const otherTempsF = propertyDevices
    .filter(d => d.temperature != null)
    .map(d => cToF(d.temperature!));

  if (otherTempsF.length === 0) return null;

  const avgOtherTempF = otherTempsF.reduce((a, b) => a + b, 0) / otherTempsF.length;
  const tempDiff = avgOtherTempF - currentTempF;

  if (tempDiff >= thresholds.insulationDiffTempF) {
    const severity: PredictiveMaintenanceRisk['severity'] = 
      tempDiff >= 25 ? 'critical' : tempDiff >= 20 ? 'high' : 'medium';

    return {
      id: generateRiskId(device.deviceId, 'insulation_failure'),
      deviceId: device.deviceId,
      deviceName: device.name,
      propertyId: device.propertyId,
      propertyAddress,
      riskType: 'insulation_failure',
      severity,
      confidence: Math.min(90, 40 + tempDiff * 2),
      title: 'Possible Insulation or Draft Issue',
      description: `${device.name} is reading ${currentTempF.toFixed(0)}°F, which is ${tempDiff.toFixed(0)}°F colder than the average of other sensors at this property (${avgOtherTempF.toFixed(0)}°F). This could indicate poor insulation, an open window/vent, or a disconnected HVAC zone.`,
      recommendation: 'Check the area for open windows, doors, or vents. Inspect insulation around the room. Verify HVAC ducts are properly connected and registers are open. Look for drafts around windows and exterior walls.',
      detectedAt: new Date(),
      dataPoints: otherTempsF.length + 1,
      thresholdValue: thresholds.insulationDiffTempF,
      currentValue: tempDiff,
      trendDirection: 'stable',
      estimatedTimeToIssue: severity === 'critical' ? '1-3 days' : '1-2 weeks',
      dismissed: false,
    };
  }

  return null;
}

/**
 * Analyze rapid temperature changes (drafts, HVAC issues)
 */
function analyzeRapidTempChange(
  device: ShellyDevice,
  readings: SensorReading[],
  thresholds: PredictiveThresholds,
  propertyAddress?: string
): PredictiveMaintenanceRisk | null {
  const tempReadings = readings
    .filter(r => r.deviceId === device.deviceId && r.temperature != null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()); // Oldest first

  if (tempReadings.length < 3) return null;

  // Look for rapid changes in the last few readings
  for (let i = 1; i < tempReadings.length; i++) {
    const timeDiffMs = tempReadings[i].timestamp.getTime() - tempReadings[i - 1].timestamp.getTime();
    const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
    if (timeDiffHours <= 0) continue;

    const tempChangeF = Math.abs(cToF(tempReadings[i].temperature!) - cToF(tempReadings[i - 1].temperature!));
    const changePerHour = tempChangeF / timeDiffHours;

    if (changePerHour >= thresholds.rapidTempChangePerHourF) {
      const direction = cToF(tempReadings[i].temperature!) > cToF(tempReadings[i - 1].temperature!) ? 'rising' : 'falling';

      return {
        id: generateRiskId(device.deviceId, 'rapid_temp_change'),
        deviceId: device.deviceId,
        deviceName: device.name,
        propertyId: device.propertyId,
        propertyAddress,
        riskType: 'rapid_temp_change',
        severity: changePerHour >= 20 ? 'high' : 'medium',
        confidence: Math.min(85, 50 + changePerHour * 2),
        title: 'Rapid Temperature Change Detected',
        description: `Temperature at ${device.name} changed by ${tempChangeF.toFixed(0)}°F in ${(timeDiffHours * 60).toFixed(0)} minutes (${changePerHour.toFixed(0)}°F/hr). This could indicate a sudden draft, HVAC failure, or a door/window left open.`,
        recommendation: direction === 'falling' 
          ? 'Check for open windows or doors. Verify heating system is operating. Inspect for draft sources.'
          : 'Check if heating/cooling is cycling properly. Verify thermostat settings. Ensure vents aren\'t blocked.',
        detectedAt: new Date(),
        dataPoints: tempReadings.length,
        thresholdValue: thresholds.rapidTempChangePerHourF,
        currentValue: changePerHour,
        trendDirection: direction,
        estimatedTimeToIssue: 'Immediate attention',
        dismissed: false,
      };
    }
  }

  return null;
}

/**
 * Analyze humidity damage risk (very high sustained humidity)
 */
function analyzeHumidityDamage(
  device: ShellyDevice,
  readings: SensorReading[],
  thresholds: PredictiveThresholds,
  propertyAddress?: string
): PredictiveMaintenanceRisk | null {
  const humidityReadings = readings
    .filter(r => r.deviceId === device.deviceId && r.humidity != null)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (humidityReadings.length < 2) return null;

  const currentHumidity = humidityReadings[0].humidity!;
  if (currentHumidity < thresholds.highHumidityPercent) return null;

  // Count sustained high readings
  let sustainedCount = 0;
  for (const reading of humidityReadings) {
    if (reading.humidity != null && reading.humidity >= thresholds.highHumidityPercent) {
      sustainedCount++;
    } else {
      break;
    }
  }

  return {
    id: generateRiskId(device.deviceId, 'humidity_damage'),
    deviceId: device.deviceId,
    deviceName: device.name,
    propertyId: device.propertyId,
    propertyAddress,
    riskType: 'humidity_damage',
    severity: currentHumidity >= 85 ? 'critical' : currentHumidity >= 80 ? 'high' : 'medium',
    confidence: Math.min(90, 55 + sustainedCount * 3),
    title: 'High Humidity — Material Damage Risk',
    description: `Humidity at ${device.name} is ${currentHumidity.toFixed(0)}%, well above the safe range. Prolonged exposure can damage wood, drywall, electronics, and promote mold growth.`,
    recommendation: 'Run a dehumidifier immediately. Check for active water leaks or plumbing issues. Ensure bathrooms and kitchens have proper exhaust ventilation. Inspect HVAC drain lines.',
    detectedAt: new Date(),
    dataPoints: sustainedCount,
    thresholdValue: thresholds.highHumidityPercent,
    currentValue: currentHumidity,
    trendDirection: humidityReadings.length >= 3
      ? (humidityReadings[0].humidity! > humidityReadings[2].humidity! ? 'rising' : 'falling')
      : 'stable',
    estimatedTimeToIssue: currentHumidity >= 80 ? '1-3 days' : '1-2 weeks',
    dismissed: false,
  };
}

/**
 * Main analysis function — runs all predictive checks against current sensor data
 */
export function analyzeAllRisks(
  devices: ShellyDevice[],
  readings: SensorReading[],
  thresholds: PredictiveThresholds = DEFAULT_THRESHOLDS,
  propertyMap?: Map<string, string> // propertyId -> address
): PredictiveMaintenanceRisk[] {
  const risks: PredictiveMaintenanceRisk[] = [];

  for (const device of devices) {
    const propertyAddress = device.propertyId ? propertyMap?.get(device.propertyId) : undefined;

    // Run each analysis
    const moldRisk = analyzeMoldRisk(device, readings, thresholds, propertyAddress);
    if (moldRisk) risks.push(moldRisk);

    const freezeRisk = analyzeFreezeRisk(device, readings, thresholds, propertyAddress);
    if (freezeRisk) risks.push(freezeRisk);

    const insulationRisk = analyzeInsulationFailure(device, devices, readings, thresholds, propertyAddress);
    if (insulationRisk) risks.push(insulationRisk);

    const rapidTempRisk = analyzeRapidTempChange(device, readings, thresholds, propertyAddress);
    if (rapidTempRisk) risks.push(rapidTempRisk);

    const humidityDamageRisk = analyzeHumidityDamage(device, readings, thresholds, propertyAddress);
    if (humidityDamageRisk) risks.push(humidityDamageRisk);
  }

  // Sort by severity (critical first) then confidence
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  risks.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.confidence - a.confidence;
  });

  return risks;
}

/**
 * Prepare sensor readings for chart display
 * Groups readings by device and formats timestamps
 */
export function prepareChartData(
  readings: SensorReading[],
  devices: ShellyDevice[],
  hoursBack: number = 24,
  timeFormatter?: (timestamp: Date) => string
): SensorChartData[] {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  const deviceMap = new Map(devices.map(d => [d.deviceId, d]));
  // Also index by document id (Firestore doc id)
  devices.forEach(d => {
    if (d.id && !deviceMap.has(d.id)) deviceMap.set(d.id, d);
    // Also index by lowercase variants for fuzzy matching
    if (d.deviceId) deviceMap.set(d.deviceId.toLowerCase(), d);
  });

  // Default time formatter based on range
  const formatTime = timeFormatter || ((ts: Date) => {
    if (hoursBack <= 24) {
      return ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (hoursBack <= 168) {
      return ts.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } else {
      return ts.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  });

  return readings
    .filter(r => r.timestamp >= cutoff && (r.temperature != null || r.humidity != null))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map(r => {
      const device = deviceMap.get(r.deviceId) || deviceMap.get(r.deviceId?.toLowerCase?.() || '');
      const tempC = r.temperature;
      const tempF = tempC != null ? cToF(tempC) : undefined;

      return {
        time: formatTime(r.timestamp),
        timestamp: r.timestamp.getTime(),
        temperature: tempF != null ? Math.round(tempF * 10) / 10 : undefined,
        temperatureC: tempC != null ? Math.round(tempC * 10) / 10 : undefined,
        humidity: r.humidity != null ? Math.round(r.humidity * 10) / 10 : undefined,
        deviceId: r.deviceId,
        deviceName: device?.name || (r.deviceId?.startsWith('blu-ht-') ? `BLU H&T ${r.deviceId.slice(-6).toUpperCase()}` : r.deviceId?.includes('ht') ? 'H&T Sensor' : r.deviceId?.includes('flood') ? 'Flood Sensor' : r.deviceId || 'Sensor'),
      };
    });
}

/**
 * Get a human-readable severity badge color
 */
export function getSeverityColor(severity: PredictiveMaintenanceRisk['severity']): string {
  switch (severity) {
    case 'critical': return '#ef4444';
    case 'high': return '#f97316';
    case 'medium': return '#eab308';
    case 'low': return '#3b82f6';
  }
}

/**
 * Get severity background class for Tailwind
 */
export function getSeverityBgClass(severity: PredictiveMaintenanceRisk['severity']): string {
  switch (severity) {
    case 'critical': return 'bg-red-500/20 border-red-400/40 text-red-300';
    case 'high': return 'bg-orange-500/20 border-orange-400/40 text-orange-300';
    case 'medium': return 'bg-yellow-500/20 border-yellow-400/40 text-yellow-300';
    case 'low': return 'bg-blue-500/20 border-blue-400/40 text-blue-300';
  }
}

export type RoomRiskSnapshot = {
  deviceId: string;
  deviceName: string;
  timestamp: number;
  time: string;
  currentHumidity: number | null;
  currentTempF: number | null;
  moldRiskIndex: number;
  materialDamageIndex: number;
  ventilationScore: number;
  peakHumidity: number | null;
  hoursAbove60: number;
  hoursAbove70: number;
  hoursAbove80: number;
  humidityCycles: number;
  avgRecoveryMinutes: number | null;
  statusSummary: string;
};

const RISK_BUCKET_MS = 15 * 60 * 1000;

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readingTempF(reading: SensorReading) {
  return reading.temperature != null ? cToF(reading.temperature) : null;
}

function formatRiskTime(timestamp: number, hoursBack: number) {
  const date = new Date(timestamp);
  if (hoursBack <= 24) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function estimateReadingGapHours(previous: SensorReading | null, current: SensorReading) {
  if (!previous) return 0.25;
  const gapMs = current.timestamp.getTime() - previous.timestamp.getTime();
  if (gapMs <= 0) return 0;
  return Math.min(gapMs / (1000 * 60 * 60), 0.5);
}

function countHumidityCycles(readings: SensorReading[]) {
  let cycles = 0;
  let inSpike = false;

  for (const reading of readings) {
    const humidity = reading.humidity;
    if (humidity == null) continue;
    if (!inSpike && humidity >= 65) {
      inSpike = true;
    } else if (inSpike && humidity <= 55) {
      cycles += 1;
      inSpike = false;
    }
  }

  return cycles;
}

function averageRecoveryMinutes(readings: SensorReading[]) {
  const recoveries: number[] = [];
  let spikeStart: number | null = null;

  for (const reading of readings) {
    const humidity = reading.humidity;
    if (humidity == null) continue;

    if (spikeStart == null && humidity >= 70) {
      spikeStart = reading.timestamp.getTime();
      continue;
    }

    if (spikeStart != null && humidity <= 60) {
      recoveries.push((reading.timestamp.getTime() - spikeStart) / (1000 * 60));
      spikeStart = null;
    }
  }

  if (recoveries.length === 0) return null;
  return Math.round(recoveries.reduce((sum, value) => sum + value, 0) / recoveries.length);
}

function buildStatusSummary(
  deviceName: string,
  moldRiskIndex: number,
  materialDamageIndex: number,
  ventilationScore: number,
  currentHumidity: number | null,
) {
  if (moldRiskIndex >= 70 || materialDamageIndex >= 70) {
    return `${deviceName} shows sustained moisture exposure. Ventilation and drying should be prioritized.`;
  }
  if (ventilationScore <= 40) {
    return `${deviceName} is slow to recover after humidity spikes, suggesting weak ventilation or airflow.`;
  }
  if (moldRiskIndex >= 40 || (currentHumidity != null && currentHumidity >= 65)) {
    return `${deviceName} has moderate moisture exposure. Monitor showers, laundry, and drying patterns.`;
  }
  return `${deviceName} is within a healthy humidity range with acceptable recovery behavior.`;
}

function buildRoomRiskSnapshot(
  device: ShellyDevice,
  readings: SensorReading[],
  timestamp: number,
  hoursBack: number,
): RoomRiskSnapshot | null {
  const scopedReadings = readings
    .filter((reading) => reading.timestamp.getTime() <= timestamp && reading.humidity != null)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

  if (scopedReadings.length === 0) {
    return null;
  }

  let hoursAbove60 = 0;
  let hoursAbove70 = 0;
  let hoursAbove80 = 0;
  let peakHumidity = 0;

  for (let index = 0; index < scopedReadings.length; index += 1) {
    const reading = scopedReadings[index];
    const humidity = reading.humidity!;
    const gapHours = estimateReadingGapHours(scopedReadings[index - 1] || null, reading);
    peakHumidity = Math.max(peakHumidity, humidity);
    if (humidity >= 60) hoursAbove60 += gapHours;
    if (humidity >= 70) hoursAbove70 += gapHours;
    if (humidity >= 80) hoursAbove80 += gapHours;
  }

  const latest = scopedReadings[scopedReadings.length - 1];
  const currentHumidity = latest.humidity ?? null;
  const currentTempF = readingTempF(latest);
  const humidityCycles = countHumidityCycles(scopedReadings);
  const avgRecoveryMinutes = averageRecoveryMinutes(scopedReadings);

  const moldRiskIndex = clampScore(
    (currentHumidity ?? 0) * 0.35
    + hoursAbove60 * 8
    + hoursAbove70 * 12
    + hoursAbove80 * 18
    + humidityCycles * 4,
  );

  const materialDamageIndex = clampScore(
    hoursAbove60 * 6
    + hoursAbove70 * 10
    + hoursAbove80 * 16
    + humidityCycles * 5,
  );

  const ventilationPenalty = (avgRecoveryMinutes ?? 0) * 0.8 + humidityCycles * 8 + hoursAbove70 * 4;
  const ventilationScore = clampScore(100 - ventilationPenalty);

  return {
    deviceId: device.deviceId,
    deviceName: device.name || device.deviceId,
    timestamp,
    time: formatRiskTime(timestamp, hoursBack),
    currentHumidity,
    currentTempF,
    moldRiskIndex,
    materialDamageIndex,
    ventilationScore,
    peakHumidity: peakHumidity || null,
    hoursAbove60: Math.round(hoursAbove60 * 10) / 10,
    hoursAbove70: Math.round(hoursAbove70 * 10) / 10,
    hoursAbove80: Math.round(hoursAbove80 * 10) / 10,
    humidityCycles,
    avgRecoveryMinutes,
    statusSummary: buildStatusSummary(
      device.name || device.deviceId,
      moldRiskIndex,
      materialDamageIndex,
      ventilationScore,
      currentHumidity,
    ),
  };
}

export function computeRiskTimeSeries(
  devices: ShellyDevice[],
  readings: SensorReading[],
  hoursBack: number = 24,
): RoomRiskSnapshot[] {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const filteredReadings = readings.filter((reading) => reading.timestamp.getTime() >= cutoff);
  const snapshots: RoomRiskSnapshot[] = [];

  for (const device of devices) {
    const deviceReadings = filteredReadings
      .filter((reading) => reading.deviceId === device.deviceId || reading.deviceId === device.id)
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

    if (deviceReadings.length === 0) {
      continue;
    }

    const bucketStarts = new Set<number>();
    for (const reading of deviceReadings) {
      bucketStarts.add(Math.floor(reading.timestamp.getTime() / RISK_BUCKET_MS) * RISK_BUCKET_MS);
    }

    const sortedBuckets = Array.from(bucketStarts).sort((left, right) => left - right);
    for (const bucketStart of sortedBuckets) {
      const snapshot = buildRoomRiskSnapshot(
        device,
        deviceReadings,
        bucketStart + RISK_BUCKET_MS,
        hoursBack,
      );
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    const latestSnapshot = buildRoomRiskSnapshot(
      device,
      deviceReadings,
      deviceReadings[deviceReadings.length - 1].timestamp.getTime(),
      hoursBack,
    );
    if (latestSnapshot && !snapshots.some((entry) => entry.timestamp === latestSnapshot.timestamp)) {
      snapshots.push(latestSnapshot);
    }
  }

  return snapshots.sort((left, right) => left.timestamp - right.timestamp);
}
