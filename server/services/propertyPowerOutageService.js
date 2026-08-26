/**
 * Property power outage estimation from mains-powered Shelly devices,
 * optionally corroborated with ORNL ODIN county-level utility outage data.
 */

import shellyManager from './shellyManager.js';
import { fetchCloudDevicesHttp } from '../utils/iotCloudHttpApi.js';

const MONITOR_POLL_MS = 5 * 60 * 1000;
const ODIN_CACHE_MS = 10 * 60 * 1000;
const ODIN_BASE_URL = 'https://openenergyhub.ornl.gov/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/records';

const STATE_NAMES = {
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

const odinCache = new Map();
const recentPowerAlerts = new Map();
let monitorStarted = false;

function parseStateFromAddress(address = '') {
  const normalized = String(address).trim();
  const zipMatch = normalized.match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/i);
  if (zipMatch) return zipMatch[1].toUpperCase();

  const commaMatch = normalized.match(/,\s*([A-Z]{2})\b/i);
  if (commaMatch) return commaMatch[1].toUpperCase();

  return null;
}

function stateNameForCode(code) {
  if (!code) return null;
  return STATE_NAMES[code.toUpperCase()] || null;
}

function normalizeCounty(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\bcounty\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isDeviceOnline(device = {}) {
  if (device.status === 'online' || device.online === true) return true;
  if (device.status === 'offline' || device.online === false) return false;

  const lastSeen = device.lastSeen ? new Date(device.lastSeen).getTime() : 0;
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

export function isMainsPoweredDevice(device = {}) {
  const type = String(device.type || '').toLowerCase();
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];

  if (type === 'relay_controller' || type === 'shelly_relay_gen4' || type === 'relay') {
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

function scoreToEstimation(score) {
  if (score >= 85) return 'power_likely_on';
  if (score >= 50) return 'power_uncertain';
  if (score >= 25) return 'power_outage_suspected';
  return 'power_outage_likely';
}

function buildRecommendation(estimation, offlineNames, utilityOutageReported) {
  if (estimation === 'power_likely_on') {
    return 'Mains-powered monitoring devices are reporting normally. Property power appears to be on.';
  }
  if (estimation === 'power_uncertain') {
    return 'Some monitoring devices are quiet. This may be a connectivity blip, sleeping battery sensors, or partial equipment offline — verify before assuming a power outage.';
  }
  if (utilityOutageReported) {
    return `All mains-powered monitors are offline${offlineNames.length ? ` (${offlineNames.join(', ')})` : ''} and utility outage data has been reported in this area. Treat as a likely property power outage — check freeze and leak risk if heat or sump systems are affected.`;
  }
  return `All mains-powered monitors are offline${offlineNames.length ? ` (${offlineNames.join(', ')})` : ''}. This may indicate a property power outage or an internet/router failure. Confirm with the utility or a neighbor if possible.`;
}

export function evaluatePropertyPowerSignal({
  propertyId,
  propertyAddress = null,
  devices = [],
  utilityOutageReported = false,
  utilityOutageDetail = null,
} = {}) {
  const scopedDevices = devices.filter((device) => device.propertyId === propertyId);
  const mainsDevices = scopedDevices.filter(isMainsPoweredDevice);
  const mainsOnline = mainsDevices.filter(isDeviceOnline);
  const mainsOffline = mainsDevices.filter((device) => !isDeviceOnline(device));
  const offlineNames = mainsOffline.map((device) => device.name || device.deviceId || 'Monitor');

  let score = 50;
  let confidence = 40;

  if (mainsDevices.length === 0) {
    score = 50;
    confidence = 25;
  } else {
    const onlineRatio = mainsOnline.length / mainsDevices.length;
    score = Math.round(onlineRatio * 100);
    confidence = Math.round(40 + onlineRatio * 50);

    if (onlineRatio === 0) {
      score = utilityOutageReported ? 12 : 22;
      confidence = utilityOutageReported ? 88 : 72;
    } else if (onlineRatio < 1) {
      score = Math.min(score, 52);
      confidence = Math.min(confidence, 60);
    } else {
      confidence = 90;
    }

    if (utilityOutageReported && onlineRatio === 0) {
      score = Math.min(score, 10);
      confidence = Math.max(confidence, 92);
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
    utilityOutageDetail,
    recommendation: buildRecommendation(estimation, offlineNames, utilityOutageReported),
    detectedAt: new Date().toISOString(),
  };
}

export function evaluateAllPropertyPowerSignals(devices = [], propertyAddresses = {}, utilityStatusByState = {}) {
  const propertyIds = new Set(
    devices
      .map((device) => device.propertyId)
      .filter(Boolean),
  );

  const signals = [];
  for (const propertyId of propertyIds) {
    const address = propertyAddresses[propertyId] || null;
    const stateCode = parseStateFromAddress(address || '');
    const utilityStatus = stateCode ? utilityStatusByState[stateCode] : null;

    signals.push(evaluatePropertyPowerSignal({
      propertyId,
      propertyAddress: address,
      devices,
      utilityOutageReported: Boolean(utilityStatus?.activeOutages),
      utilityOutageDetail: utilityStatus?.summary || null,
    }));
  }

  return signals.sort((left, right) => left.score - right.score);
}

async function fetchOdinRecords(stateCode = null) {
  const cacheKey = stateCode || 'ALL';
  const cached = odinCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ODIN_CACHE_MS) {
    return cached.records;
  }

  const params = new URLSearchParams({ limit: '100' });
  const stateName = stateNameForCode(stateCode);
  if (stateName) {
    params.set('where', `state like "${stateName}"`);
  }

  const response = await fetch(`${ODIN_BASE_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`ODIN request failed (${response.status})`);
  }

  const payload = await response.json();
  const records = Array.isArray(payload?.results) ? payload.results : [];
  odinCache.set(cacheKey, { at: Date.now(), records });
  return records;
}

function summarizeOdinRecords(records = [], stateCode = null, countyHint = null) {
  const normalizedCounty = normalizeCounty(countyHint);
  const activeRecords = records.filter((record) => {
    const customersOut = Number(
      record.metersaffected
      ?? record.customers_out
      ?? record.customersOut
      ?? record.total_customers_out
      ?? record.outage_count
      ?? 0,
    );
    return customersOut > 0;
  });

  const countyMatches = normalizedCounty
    ? activeRecords.filter((record) => normalizeCounty(record.county).includes(normalizedCounty)
      || normalizedCounty.includes(normalizeCounty(record.county)))
    : [];

  const relevant = countyMatches.length > 0 ? countyMatches : activeRecords;
  if (relevant.length === 0) {
    return {
      activeOutages: false,
      outageCount: 0,
      customersAffected: 0,
      summary: stateCode
        ? `No active utility outages reported in ${stateNameForCode(stateCode) || stateCode} right now.`
        : 'No active utility outages reported in ODIN feed.',
    };
  }

  const customersAffected = relevant.reduce((sum, record) => (
    sum + Number(
      record.metersaffected
      ?? record.customers_out
      ?? record.customersOut
      ?? record.total_customers_out
      ?? 0,
    )
  ), 0);

  const counties = [...new Set(relevant.map((record) => record.county).filter(Boolean))];
  const summary = counties.length
    ? `Utility outages reported in ${counties.slice(0, 3).join(', ')}${counties.length > 3 ? '…' : ''} (${customersAffected.toLocaleString()} customers affected).`
    : `Utility outages reported (${customersAffected.toLocaleString()} customers affected).`;

  return {
    activeOutages: true,
    outageCount: relevant.length,
    customersAffected,
    counties,
    summary,
  };
}

export async function getUtilityOutageStatus({ stateCode = null, countyHint = null } = {}) {
  const normalizedState = stateCode ? stateCode.toUpperCase() : null;
  try {
    const records = await fetchOdinRecords(normalizedState);
    return {
      ok: true,
      source: 'odin',
      stateCode: normalizedState,
      stateName: stateNameForCode(normalizedState),
      ...summarizeOdinRecords(records, normalizedState, countyHint),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      source: 'odin',
      stateCode: normalizedState,
      stateName: stateNameForCode(normalizedState),
      activeOutages: false,
      outageCount: 0,
      customersAffected: 0,
      summary: 'Utility outage feed unavailable.',
      error: error.message,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function loadDevicesForPowerMonitor() {
  const devices = [];

  try {
    const cloudDevices = await fetchCloudDevicesHttp();
    devices.push(...cloudDevices);
  } catch {
    // Cloud HTTP may be unavailable locally.
  }

  try {
    const localDevices = await shellyManager.getAllDevices();
    for (const device of localDevices) {
      const deviceId = device.id || device.deviceId;
      if (!devices.some((entry) => (entry.deviceId || entry.id) === deviceId)) {
        devices.push({
          ...device,
          deviceId,
          id: deviceId,
        });
      }
    }
  } catch {
    // Local manager may be unavailable.
  }

  return devices;
}

function shouldEmitPowerAlert(propertyId, estimation) {
  if (estimation !== 'power_outage_suspected' && estimation !== 'power_outage_likely') {
    return false;
  }

  const last = recentPowerAlerts.get(propertyId);
  if (last && Date.now() - last.at < 30 * 60 * 1000) {
    return false;
  }

  return true;
}

async function pollPropertyPowerSignals() {
  try {
    const devices = await loadDevicesForPowerMonitor();
    if (devices.length === 0) return;

    const propertyAddresses = {};
    for (const device of devices) {
      if (device.propertyId && device.propertyAddress && !propertyAddresses[device.propertyId]) {
        propertyAddresses[device.propertyId] = device.propertyAddress;
      }
    }

    const states = [...new Set(
      Object.values(propertyAddresses)
        .map(parseStateFromAddress)
        .filter(Boolean),
    )];

    const utilityStatusByState = {};
    for (const stateCode of states) {
      utilityStatusByState[stateCode] = await getUtilityOutageStatus({ stateCode });
    }

    const signals = evaluateAllPropertyPowerSignals(devices, propertyAddresses, utilityStatusByState);

    for (const signal of signals) {
      if (!shouldEmitPowerAlert(signal.propertyId, signal.estimation)) continue;

      recentPowerAlerts.set(signal.propertyId, { at: Date.now(), estimation: signal.estimation });
      shellyManager.handleAlert({
        id: `alert-power-${signal.propertyId}-${Date.now()}`,
        type: 'power_outage',
        level: signal.estimation === 'power_outage_likely' ? 'critical' : 'warning',
        propertyId: signal.propertyId,
        message: signal.estimation === 'power_outage_likely'
          ? `⚡ Likely property power outage — ${signal.propertyAddress || signal.propertyId}`
          : `⚡ Possible property power outage — ${signal.propertyAddress || signal.propertyId}`,
        timestamp: new Date().toISOString(),
        acknowledged: false,
        metadata: signal,
      });
    }
  } catch (error) {
    console.warn('[PropertyPower] Monitor poll failed:', error.message);
  }
}

export function startPropertyPowerMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;

  console.log(`⚡ [PropertyPower] Monitoring mains device silence every ${MONITOR_POLL_MS / 1000}s`);
  pollPropertyPowerSignals().catch(() => {});
  setInterval(() => {
    pollPropertyPowerSignals().catch(() => {});
  }, MONITOR_POLL_MS);
}

export {
  parseStateFromAddress,
  stateNameForCode,
};
