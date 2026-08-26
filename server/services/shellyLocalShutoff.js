/**
 * Local LAN auto-shutoff — flood sensors close the water relay directly over
 * the GL.iNet / property IoT network without requiring cloud internet.
 *
 * Shelly Flood Gen4 webhooks support multiple URLs per hook. We program:
 *   1. Cloud webhook (HouseYield backend — when internet is up)
 *   2. Local RPC URL to the relay's mDNS hostname (works offline on LAN)
 */

import shellyLocalApi from './shellyLocalApi.js';
import { getFirestore } from '../firebase-admin.js';
import { getIotFirestore } from '../iot-cloud-firestore.js';

const MAX_URLS_PER_HOOK = 2;

function normalizePropertyId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRelayController(data = {}) {
  return data.type === 'relay_controller'
    || data.deviceType === 'shelly_relay_gen4'
    || (Array.isArray(data.capabilities) && data.capabilities.includes('water_shutoff'));
}

function isFloodSensor(data = {}) {
  const type = String(data.type || '').toLowerCase();
  return type === 'flood'
    || data.deviceType === 'shelly_flood_gen4'
    || (Array.isArray(data.capabilities) && data.capabilities.includes('flood'));
}

export function buildRelayMdnsHost(relayDeviceId) {
  const normalized = String(relayDeviceId || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('relayDeviceId is required');
  }
  return `${normalized}.local`;
}

/**
 * HTTP GET URL Shelly flood webhooks can call directly on the LAN.
 * Maintained close: hold relay in the shutoff position.
 *
 * Prefer a stable LAN IP when known — mDNS (*.local) is flaky on some
 * GL.iNet / client stacks after Wi‑Fi flaps.
 */
export function buildLocalRelayCloseUrl(relayDeviceId, options = {}) {
  const {
    relayCloseOn = true,
    switchId = 0,
    actuationMode = 'maintained',
    host = null,
  } = options;

  if (actuationMode === 'momentary') {
    throw new Error('Offline local shutoff requires maintained actuation mode');
  }

  const resolvedHost = String(host || '').trim() || buildRelayMdnsHost(relayDeviceId);
  const relayOn = relayCloseOn !== false;
  const params = new URLSearchParams({
    id: String(switchId),
    on: relayOn ? 'true' : 'false',
  });

  return `http://${resolvedHost}/rpc/Switch.Set?${params.toString()}`;
}

function relayLanHosts(relay = {}) {
  const hosts = [];
  const ip = String(relay.localIp || relay.ip || '').trim();
  if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) hosts.push(ip);
  try {
    hosts.push(buildRelayMdnsHost(relay.deviceId));
  } catch {
    // ignore
  }
  return [...new Set(hosts)];
}

async function listDevicesForProperty(propertyId, predicate) {
  const normalizedPropertyId = normalizePropertyId(propertyId);
  if (!normalizedPropertyId) {
    return [];
  }

  const devices = new Map();
  const databases = [];

  try { databases.push(getFirestore()); } catch { /* ignore */ }
  try { databases.push(getIotFirestore()); } catch { /* ignore */ }

  for (const db of databases) {
    try {
      const snapshot = await db.collection('shelly_devices')
        .where('propertyId', '==', normalizedPropertyId)
        .get();

      for (const doc of snapshot.docs) {
        const data = doc.data() || {};
        if (!predicate(data)) continue;
        const deviceId = data.deviceId || doc.id;
        devices.set(deviceId, {
          docId: doc.id,
          deviceId,
          ...data,
        });
      }
    } catch (error) {
      console.warn('[LocalShutoff] Property device lookup failed:', error.message);
    }
  }

  return [...devices.values()];
}

export async function listRelayShutoffTargetsForProperty(propertyId) {
  return listDevicesForProperty(propertyId, isRelayController);
}

export async function listFloodSensorsForProperty(propertyId) {
  return listDevicesForProperty(propertyId, isFloodSensor);
}

function chunkUrls(urls, chunkSize = MAX_URLS_PER_HOOK) {
  const chunks = [];
  for (let index = 0; index < urls.length; index += chunkSize) {
    chunks.push(urls.slice(index, index + chunkSize));
  }
  return chunks;
}

/**
 * Configure flood sensor webhooks with cloud + local LAN shutoff URLs.
 */
export async function configureFloodShutoffWebhooks(
  floodIp,
  floodDeviceId,
  {
    cloudWebhookUrl = null,
    relayTargets = [],
    timeoutMs = 15000,
  } = {},
) {
  const rpc = (method, params) => shellyLocalApi.rpc(floodIp, method, params, timeoutMs);
  const configured = [];

  // Prefer IP URLs first (reliable on GL.iNet), then mDNS as fallback.
  const localUrls = [];
  for (const relay of relayTargets) {
    const base = {
      relayCloseOn: relay.relayCloseOn !== false,
      switchId: relay.switchId ?? 0,
      actuationMode: relay.actuationMode || 'maintained',
    };
    for (const host of relayLanHosts(relay)) {
      localUrls.push(buildLocalRelayCloseUrl(relay.deviceId, { ...base, host }));
    }
  }

  const buildCloudUrl = (event) => (cloudWebhookUrl
    ? shellyLocalApi.buildFloodCloudWebhookUrl(cloudWebhookUrl, floodDeviceId, event)
    : null);
  const cloudUrl = buildCloudUrl('flood.alarm');
  // Some Flood Gen4 firmwares emit component-style events instead of flood.alarm.
  const cloudUrlAlt = buildCloudUrl('flood:0.alarm');

  const alarmUrls = [
    ...(cloudUrl ? [cloudUrl] : []),
    ...localUrls,
  ];

  if (alarmUrls.length === 0) {
    return configured;
  }

  try {
    const hooks = await rpc('Webhook.List');
    for (const hook of hooks.hooks || []) {
      if (
        hook.event === 'flood.alarm'
        || hook.event === 'flood:0.alarm'
        || hook.name === 'firebase_flood_alert'
        || hook.name === 'houseyield_flood_alert'
        || hook.name === 'houseyield_flood_alert_alt'
        || hook.name?.startsWith('local_shutoff')
      ) {
        await rpc('Webhook.Delete', { id: hook.id });
      }
    }
  } catch (error) {
    console.log('[LocalShutoff] No existing flood webhooks to clear:', error.message);
  }

  const alarmChunks = chunkUrls(alarmUrls);
  alarmChunks.forEach((urls, index) => {
    configured.push({
      event: 'flood.alarm',
      urls,
      name: index === 0 ? 'houseyield_flood_alert' : `local_shutoff_${index}`,
    });
  });

  for (const [index, entry] of configured.entries()) {
    await rpc('Webhook.Create', {
      cid: 0,
      enable: true,
      event: entry.event,
      name: entry.name,
      urls: entry.urls,
      // Cloud Run uses a public CA; battery firmwares sometimes fail TLS verify.
      // '*' disables peer validation so flood.alarm can reach HouseYield.
      ssl_ca: '*',
    });
    console.log(`   ✅ ${entry.event} webhook ${index + 1}: ${entry.urls.join(' + ')}`);
  }

  // Best-effort alternate Gen4 event name (ignored if firmware rejects it).
  if (cloudUrlAlt) {
    try {
      await rpc('Webhook.Create', {
        cid: 0,
        enable: true,
        event: 'flood:0.alarm',
        name: 'houseyield_flood_alert_alt',
        urls: [cloudUrlAlt, ...localUrls].slice(0, 2),
        ssl_ca: '*',
      });
      configured.push({ event: 'flood:0.alarm', urls: [cloudUrlAlt] });
      console.log(`   ✅ flood:0.alarm webhook: ${cloudUrlAlt}`);
    } catch (error) {
      console.log('[LocalShutoff] flood:0.alarm webhook not supported:', error.message);
    }
  }

  if (cloudUrl) {
    try {
      const statusWebhook = buildCloudUrl('status');
      await rpc('Webhook.Create', {
        cid: 1,
        enable: true,
        event: 'flood:0.status',
        name: 'firebase_status',
        urls: [statusWebhook],
        ssl_ca: '*',
      });
      configured.push({ event: 'flood:0.status', urls: [statusWebhook] });
      console.log(`   ✅ flood:0.status webhook (with battery): ${statusWebhook}`);
    } catch (error) {
      console.log('[LocalShutoff] Status webhook not supported:', error.message);
    }

    // Button press wakes the Flood Gen4 and should flip Sleeping → Online + refresh battery %.
    const buttonEvents = [
      { event: 'input:0.button_push', name: 'houseyield_button_push' },
      { event: 'input.button_push', name: 'houseyield_button_push_alt' },
      { event: 'input:0.single_push', name: 'houseyield_single_push' },
    ];
    for (const entry of buttonEvents) {
      try {
        const wakeWebhook = buildCloudUrl(entry.event);
        await rpc('Webhook.Create', {
          cid: 0,
          enable: true,
          event: entry.event,
          name: entry.name,
          urls: [wakeWebhook],
          ssl_ca: '*',
        });
        configured.push({ event: entry.event, urls: [wakeWebhook] });
        console.log(`   ✅ ${entry.event} webhook (with battery): ${wakeWebhook}`);
        break; // one successful button hook is enough
      } catch (error) {
        console.log(`[LocalShutoff] ${entry.event} webhook not supported:`, error.message);
      }
    }
  }

  return configured;
}

/**
 * Push local shutoff webhooks to every flood sensor on a property.
 * Call after provisioning relays or floods, or when relay settings change.
 */
export async function syncPropertyLocalShutoff(propertyId, options = {}) {
  const normalizedPropertyId = normalizePropertyId(propertyId);
  if (!normalizedPropertyId) {
    return { ok: false, error: 'propertyId is required' };
  }

  const relayTargets = await listRelayShutoffTargetsForProperty(normalizedPropertyId);
  const floodSensors = await listFloodSensorsForProperty(normalizedPropertyId);

  if (relayTargets.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_relay_controller',
      propertyId: normalizedPropertyId,
      floodSensors: floodSensors.length,
    };
  }

  if (floodSensors.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_flood_sensors',
      propertyId: normalizedPropertyId,
      relayTargets: relayTargets.map((relay) => relay.deviceId),
    };
  }

  const results = [];
  for (const flood of floodSensors) {
    let floodIp = flood.localIp || flood.ip || null;

    if (!floodIp) {
      try {
        floodIp = await shellyLocalApi.findDeviceOnNetwork(flood.deviceId, null, 20);
      } catch {
        floodIp = null;
      }
    }

    if (!floodIp) {
      floodIp = `${String(flood.deviceId).toLowerCase()}.local`;
    }

    try {
      const configured = await configureFloodShutoffWebhooks(floodIp, flood.deviceId, {
        cloudWebhookUrl: options.cloudWebhookUrl || flood.webhookUrl?.split('?')[0] || null,
        relayTargets,
        timeoutMs: options.timeoutMs || 15000,
      });

      results.push({
        ok: true,
        deviceId: flood.deviceId,
        floodIp,
        relayTargets: relayTargets.map((relay) => relay.deviceId),
        localShutoffUrls: relayTargets.map((relay) => buildLocalRelayCloseUrl(relay.deviceId, relay)),
        configured,
      });
      console.log(`✅ [LocalShutoff] Synced offline shutoff for flood ${flood.deviceId} → ${relayTargets.map((r) => r.deviceId).join(', ')}`);
    } catch (error) {
      console.warn(`[LocalShutoff] Failed to sync flood ${flood.deviceId}:`, error.message);
      results.push({
        ok: false,
        deviceId: flood.deviceId,
        floodIp,
        error: error.message,
      });
    }
  }

  const anySucceeded = results.some((entry) => entry.ok);
  return {
    ok: anySucceeded,
    propertyId: normalizedPropertyId,
    relayTargets: relayTargets.map((relay) => ({
      deviceId: relay.deviceId,
      localUrl: buildLocalRelayCloseUrl(relay.deviceId, relay),
    })),
    results,
  };
}
