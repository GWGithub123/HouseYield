/**
 * Read IoT cloud devices/alerts via the public shellyWebhook HTTP API.
 * Used when direct IoT Firestore access is unavailable locally.
 */

import { resolveShellyWebhookUrl } from './iotProjectConfig.js';

function getIotCloudApiBaseUrl() {
  return resolveShellyWebhookUrl();
}

async function fetchJson(pathAndQuery) {
  const baseUrl = getIotCloudApiBaseUrl();
  const response = await fetch(`${baseUrl}${pathAndQuery}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`IoT cloud HTTP ${response.status} for ${pathAndQuery}`);
  }

  return response.json();
}

export async function fetchCloudDevicesHttp() {
  const payload = await fetchJson('?action=devices');
  return Array.isArray(payload.devices) ? payload.devices : [];
}

export async function fetchCloudAlertsHttp(limit = 50) {
  const payload = await fetchJson(`?action=alerts&limit=${encodeURIComponent(String(limit))}`);
  return Array.isArray(payload.alerts) ? payload.alerts : [];
}

export async function fetchCloudAlertHttp(alertId) {
  if (!alertId) return null;
  const alerts = await fetchCloudAlertsHttp(100);
  return alerts.find((alert) => alert.id === alertId) || null;
}

export async function fetchCloudReadingsHttp(hours = 168, limit = 500) {
  const payload = await fetchJson(
    `?action=readings&hours=${encodeURIComponent(String(hours))}&limit=${encodeURIComponent(String(limit))}`
  );
  return Array.isArray(payload.readings) ? payload.readings : [];
}

export { getIotCloudApiBaseUrl };
