/**
 * Shared IoT Firebase / Shelly webhook project resolution.
 * IoT data now lives in the main houseyield Firebase project by default.
 * Device webhooks target the public Cloud Run backend, not Firebase Functions.
 */

function normalizeWebhookUrl(value) {
  if (!value) return null;
  return String(value).split('?')[0].replace(/\/$/, '');
}

function resolveBackendPublicBaseUrl() {
  const candidates = [
    process.env.BACKEND_PUBLIC_URL,
    process.env.HOUSEYIELD_BACKEND_URL,
    process.env.PUBLIC_BACKEND_URL,
    process.env.PUBLIC_URL,
    process.env.SHELLY_SERVER_PUBLIC_URL,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeWebhookUrl(candidate);
    if (normalized && !normalized.includes('localhost') && !normalized.includes('127.0.0.1')) {
      return normalized;
    }
  }

  return null;
}

export function resolveIotFirebaseProjectId() {
  return process.env.IOT_FIREBASE_PROJECT_ID
    || process.env.SHELLY_FIREBASE_PROJECT_ID
    || process.env.FIREBASE_PROJECT_ID
    || process.env.GOOGLE_CLOUD_PROJECT
    || 'houseyield';
}

export function resolveShellyWebhookUrl() {
  const candidates = [
    process.env.SHELLY_WEBHOOK_URL,
    process.env.VITE_SHELLY_WEBHOOK_URL,
    process.env.BACKEND_PUBLIC_URL ? `${String(process.env.BACKEND_PUBLIC_URL).replace(/\/$/, '')}/api/shelly/webhook` : null,
    // Legacy cloud function last — often IAM-locked (403) and must not win.
    process.env.SHELLY_FIREBASE_WEBHOOK_URL,
    process.env.FIREBASE_SHELLY_WEBHOOK_URL,
    process.env.VITE_SHELLY_FIREBASE_WEBHOOK_URL,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeWebhookUrl(candidate);
    if (!normalized) continue;
    if (/cloudfunctions\.net\/shellyWebhook/i.test(normalized)) {
      // Skip unless nothing else is available (handled after loop).
      continue;
    }
    return normalized;
  }

  const backendBase = resolveBackendPublicBaseUrl();
  if (backendBase) {
    return `${backendBase}/api/shelly/webhook`;
  }

  const legacyFirebase = [
    process.env.SHELLY_FIREBASE_WEBHOOK_URL,
    process.env.FIREBASE_SHELLY_WEBHOOK_URL,
    process.env.VITE_SHELLY_FIREBASE_WEBHOOK_URL,
  ].map(normalizeWebhookUrl).find(Boolean);

  if (legacyFirebase) {
    return legacyFirebase;
  }

  const projectId = resolveIotFirebaseProjectId();
  return `https://us-central1-${projectId}.cloudfunctions.net/shellyWebhook`;
}

export function resolveShellyWebhookBaseUrl() {
  return resolveShellyWebhookUrl();
}

export { resolveBackendPublicBaseUrl };
