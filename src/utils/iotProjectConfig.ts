function normalizeWebhookUrl(value: string | undefined): string | null {
  if (!value) return null;
  return String(value).split('?')[0].replace(/\/$/, '');
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost'
    || lower === '0.0.0.0'
    || lower === '::1'
    || lower.endsWith('.localhost')
    || /^127\./.test(lower)
    || /^10\./.test(lower)
    || /^192\.168\./.test(lower)
  ) {
    return true;
  }

  const private172 = lower.match(/^172\.(\d{1,3})\./);
  if (private172) {
    const secondOctet = Number(private172[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }

  return false;
}

function isLoopbackOrPrivateUrl(value: string | undefined): boolean {
  const normalized = normalizeWebhookUrl(value);
  if (!normalized) return false;

  try {
    return isLoopbackOrPrivateHost(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

function resolveCurrentBrowserOrigin(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const origin = normalizeWebhookUrl(window.location.origin);
  if (!origin) {
    return null;
  }

  try {
    const hostname = new URL(origin).hostname;
    return isLoopbackOrPrivateHost(hostname) ? null : origin;
  } catch {
    return null;
  }
}

function resolveBackendPublicBaseUrl(): string | null {
  const candidates = [
    import.meta.env.VITE_BACKEND_PUBLIC_URL,
    import.meta.env.VITE_PUSH_SERVER_URL,
    import.meta.env.VITE_SHELLY_SERVER_PUBLIC_URL,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeWebhookUrl(candidate);
    if (
      normalized
      && !isLoopbackOrPrivateUrl(normalized)
    ) {
      return normalized;
    }
  }

  const currentOrigin = resolveCurrentBrowserOrigin();
  if (currentOrigin) {
    return currentOrigin;
  }

  return null;
}

export function resolveIotFirebaseProjectId(): string {
  return import.meta.env.VITE_IOT_FIREBASE_PROJECT_ID
    || import.meta.env.VITE_SHELLY_FIREBASE_PROJECT_ID
    || import.meta.env.VITE_FIREBASE_PROJECT_ID
    || 'houseyield';
}

function isEphemeralTunnelUrl(value: string | null): boolean {
  if (!value) return false;
  return /ngrok|trycloudflare\.com/i.test(value);
}

export function resolveShellyWebhookUrl(): string {
  const cloudRunOrPublic = normalizeWebhookUrl(import.meta.env.VITE_SHELLY_WEBHOOK_URL);
  if (cloudRunOrPublic && !isEphemeralTunnelUrl(cloudRunOrPublic)) {
    return cloudRunOrPublic;
  }

  const legacyFirebase = normalizeWebhookUrl(import.meta.env.VITE_SHELLY_FIREBASE_WEBHOOK_URL);
  // Only use the legacy cloud function if nothing else is configured. It often
  // returns 403 when IAM invoker is locked down.
  if (legacyFirebase && !isEphemeralTunnelUrl(legacyFirebase) && !/cloudfunctions\.net\/shellyWebhook/i.test(legacyFirebase)) {
    return legacyFirebase;
  }

  const backendBase = resolveBackendPublicBaseUrl();
  if (backendBase && !isEphemeralTunnelUrl(backendBase)) {
    return `${backendBase}/api/shelly/webhook`;
  }

  const projectId = resolveIotFirebaseProjectId();
  return `https://us-central1-${projectId}.cloudfunctions.net/shellyWebhook`;
}

export function resolveShellyApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const onLocalDev = hostname === 'localhost' || hostname === '127.0.0.1';
    if (onLocalDev) {
      return '';
    }
  }

  const explicitPublicBase = resolveBackendPublicBaseUrl();
  if (explicitPublicBase) {
    return explicitPublicBase;
  }

  return normalizeWebhookUrl(
    import.meta.env.VITE_PUSH_SERVER_URL
    || import.meta.env.VITE_API_URL,
  ) || '';
}
