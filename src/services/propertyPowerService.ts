import type { PropertyPowerEstimation, PropertyPowerSignal } from '../types/iot';
import type { ShellyDevice } from '../hooks/useShellyFirestore';

const SHELLY_API_BASE = import.meta.env.VITE_PUSH_SERVER_URL
  || import.meta.env.VITE_API_URL
  || 'http://localhost:3001';

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

export interface PropertyRef {
  id: string;
  address?: string;
}

export interface UtilityOutageStatus {
  ok: boolean;
  stateCode?: string | null;
  stateName?: string | null;
  activeOutages: boolean;
  outageCount?: number;
  customersAffected?: number;
  summary?: string;
  error?: string;
  checkedAt?: string;
}

export const POWER_ESTIMATION_META: Record<PropertyPowerEstimation, {
  label: string;
  shortLabel: string;
  icon: string;
  color: string;
  barClass: string;
}> = {
  power_likely_on: {
    label: 'Power Likely On',
    shortLabel: 'Likely On',
    icon: '⚡',
    color: '#22c55e',
    barClass: 'bg-emerald-400',
  },
  power_uncertain: {
    label: 'Power Uncertain',
    shortLabel: 'Uncertain',
    icon: '⚠️',
    color: '#eab308',
    barClass: 'bg-yellow-400',
  },
  power_outage_suspected: {
    label: 'Outage Suspected',
    shortLabel: 'Suspected',
    icon: '🔌',
    color: '#f97316',
    barClass: 'bg-orange-400',
  },
  power_outage_likely: {
    label: 'Outage Likely',
    shortLabel: 'Likely Out',
    icon: '🛑',
    color: '#ef4444',
    barClass: 'bg-red-400',
  },
};

export function parseStateFromAddress(address = ''): string | null {
  const normalized = address.trim();
  const zipMatch = normalized.match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/i);
  if (zipMatch) return zipMatch[1].toUpperCase();

  const commaMatch = normalized.match(/,\s*([A-Z]{2})\b/i);
  if (commaMatch) return commaMatch[1].toUpperCase();

  return null;
}

export function stateNameForCode(code?: string | null): string | null {
  if (!code) return null;
  return STATE_NAMES[code.toUpperCase()] || null;
}

export function isMainsPoweredDevice(device: ShellyDevice): boolean {
  const type = String(device.type || '').toLowerCase();
  const capabilities = device.capabilities || [];

  if (type === 'relay_controller' || type === 'relay' || type === 'shelly_relay_gen4') {
    return true;
  }
  if (type === 'ble_gateway' || type === 'gateway') {
    return true;
  }
  if (capabilities.includes('water_shutoff') || capabilities.includes('ble_bridge')) {
    return true;
  }

  const connectionType = String(device.connectionType || '').toLowerCase();
  const hasBattery = device.batteryPercent != null || device.batteryLevel != null;
  if (connectionType === 'wifi' && !hasBattery && !device.bleAddress) {
    return true;
  }

  return false;
}

function isDeviceOnline(device: ShellyDevice): boolean {
  if (device.status === 'online' || device.online === true) return true;
  if (device.status === 'offline' || device.online === false) return false;

  const lastSeen = device.lastSeen instanceof Date
    ? device.lastSeen.getTime()
    : device.lastSeen
      ? new Date(device.lastSeen).getTime()
      : 0;

  if (!lastSeen || Number.isNaN(lastSeen)) return false;

  const type = String(device.type || '').toLowerCase();
  const connectionType = String(device.connectionType || '').toLowerCase();
  const isBle = connectionType.includes('bluetooth') || Boolean(device.bleAddress);
  const thresholdMs = isBle
    ? 2 * 60 * 60 * 1000
    : (type.includes('temperature') || type.includes('humidity') || type === 'ht')
      ? 20 * 60 * 1000
      : 30 * 60 * 1000;

  return Date.now() - lastSeen <= thresholdMs;
}

function scoreToEstimation(score: number): PropertyPowerEstimation {
  if (score >= 85) return 'power_likely_on';
  if (score >= 50) return 'power_uncertain';
  if (score >= 25) return 'power_outage_suspected';
  return 'power_outage_likely';
}

function buildRecommendation(
  estimation: PropertyPowerEstimation,
  offlineNames: string[],
  utilityOutageReported?: boolean,
): string {
  if (estimation === 'power_likely_on') {
    if (offlineNames.length > 0) {
      return `Power is confirmed on — at least one mains-powered device is reporting. ${offlineNames.join(', ')} ${offlineNames.length === 1 ? 'is' : 'are'} offline, which is a device or Wi-Fi issue, not a power outage.`;
    }
    return 'Mains-powered monitoring devices are reporting normally. Property power appears to be on.';
  }
  if (estimation === 'power_uncertain') {
    return 'The only mains-powered monitor is quiet. This may be a connectivity blip, a router failure, or a power outage — verify before assuming an outage.';
  }
  if (utilityOutageReported) {
    return `All mains-powered monitors are offline${offlineNames.length ? ` (${offlineNames.join(', ')})` : ''} and utility outage data has been reported in this area. Treat as a likely property power outage.`;
  }
  return `All mains-powered monitors are offline${offlineNames.length ? ` (${offlineNames.join(', ')})` : ''}. This may indicate a property power outage or an internet/router failure.`;
}

export function evaluatePropertyPowerSignal(
  propertyId: string,
  devices: ShellyDevice[],
  propertyAddress?: string,
  utilityOutageReported = false,
  utilityOutageDetail?: string | null,
): PropertyPowerSignal {
  const scopedDevices = devices.filter((device) => device.propertyId === propertyId);
  const mainsDevices = scopedDevices.filter(isMainsPoweredDevice);
  const mainsOnline = mainsDevices.filter(isDeviceOnline);
  const mainsOffline = mainsDevices.filter((device) => !isDeviceOnline(device));
  const offlineNames = mainsOffline.map((device) => device.name || device.deviceId);

  let score = 50;
  let confidence = 40;

  if (mainsDevices.length === 0) {
    score = 50;
    confidence = 25;
  } else if (mainsOnline.length > 0) {
    // Any mains-powered device actively reporting PROVES grid power is on —
    // an outage would take down every mains device simultaneously. Other
    // offline mains devices are device/Wi-Fi problems, not power problems.
    score = 100;
    confidence = mainsOnline.length > 1 ? 95 : 90;
  } else {
    // Every mains-powered device is silent. With only one monitor this is
    // ambiguous (router vs power); with several silent at once, an outage
    // or full internet failure is much more likely.
    if (mainsDevices.length === 1) {
      // One silent monitor alone never escalates past "uncertain" unless the
      // utility feed corroborates an area outage.
      score = utilityOutageReported ? 30 : 50;
      confidence = utilityOutageReported ? 80 : 55;
    } else {
      score = utilityOutageReported ? 10 : 22;
      confidence = utilityOutageReported ? 92 : 72;
    }
  }

  const estimation = scoreToEstimation(score);

  return {
    propertyId,
    propertyAddress,
    estimation,
    score,
    confidence,
    mainsDeviceCount: mainsDevices.length,
    mainsOnlineCount: mainsOnline.length,
    mainsOfflineCount: mainsOffline.length,
    offlineMainsDevices: offlineNames,
    utilityOutageReported,
    utilityOutageDetail: utilityOutageDetail || undefined,
    recommendation: buildRecommendation(estimation, offlineNames, utilityOutageReported),
    detectedAt: new Date(),
  };
}

export function analyzePropertyPowerSignals(
  devices: ShellyDevice[],
  properties: PropertyRef[] = [],
  propertyMap?: Map<string, string>,
  utilityStatusByState: Record<string, UtilityOutageStatus> = {},
): PropertyPowerSignal[] {
  const propertyIds = new Set<string>();
  properties.forEach((property) => propertyIds.add(property.id));
  devices.forEach((device) => {
    if (device.propertyId) propertyIds.add(device.propertyId);
  });

  const addressById = new Map<string, string>();
  properties.forEach((property) => {
    if (property.address) addressById.set(property.id, property.address);
  });
  propertyMap?.forEach((address, propertyId) => {
    if (!addressById.has(propertyId)) addressById.set(propertyId, address);
  });

  const signals = Array.from(propertyIds).map((propertyId) => {
    const address = addressById.get(propertyId);
    const stateCode = parseStateFromAddress(address || '');
    const utilityStatus = stateCode ? utilityStatusByState[stateCode] : undefined;

    return evaluatePropertyPowerSignal(
      propertyId,
      devices,
      address,
      Boolean(utilityStatus?.activeOutages),
      utilityStatus?.summary || null,
    );
  });

  return signals.sort((left, right) => left.score - right.score);
}

export async function fetchUtilityOutageStatuses(states: string[]): Promise<Record<string, UtilityOutageStatus>> {
  const uniqueStates = [...new Set(states.filter(Boolean))];
  if (uniqueStates.length === 0) return {};

  const results = await Promise.all(uniqueStates.map(async (stateCode) => {
    try {
      const response = await fetch(
        `${SHELLY_API_BASE}/api/shelly/power-outage/utility-status?state=${encodeURIComponent(stateCode)}`,
      );
      const data = await response.json();
      return [stateCode, data as UtilityOutageStatus] as const;
    } catch (error) {
      return [stateCode, {
        ok: false,
        stateCode,
        activeOutages: false,
        summary: 'Utility outage feed unavailable.',
        error: error instanceof Error ? error.message : 'Request failed',
      } satisfies UtilityOutageStatus] as const;
    }
  }));

  return Object.fromEntries(results);
}

export function getPowerScoreLabel(score: number): string {
  if (score >= 85) return 'Healthy';
  if (score >= 50) return 'Watch';
  if (score >= 25) return 'At Risk';
  return 'Critical';
}
