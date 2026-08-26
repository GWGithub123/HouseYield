const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TUNNEL_HOST_MARKERS = ['ngrok', 'trycloudflare.com'];

function shouldUseHostedScannerBackendInDev(configuredScannerBackend: string, scannerBackendIsLoopback: boolean): boolean {
  return import.meta.env.DEV
    && isLocalHost()
    && import.meta.env.VITE_SCANNER_USE_HOSTED_BACKEND_IN_DEV === 'true'
    && Boolean(configuredScannerBackend)
    && !scannerBackendIsLoopback;
}

function normalizeUrl(url?: string | null): string {
  return (url || '').trim().replace(/\/+$/g, '');
}

function isLoopbackUrl(url?: string | null): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;

  try {
    return isLocalHost(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

export function isLocalHost(hostname?: string): boolean {
  if (!hostname && typeof window !== 'undefined') {
    return LOCAL_HOSTS.has(window.location.hostname);
  }

  return LOCAL_HOSTS.has(hostname || '');
}

export function isTunnelHost(hostname?: string): boolean {
  const currentHostname = hostname || (typeof window !== 'undefined' ? window.location.hostname : '');
  return TUNNEL_HOST_MARKERS.some((marker) => currentHostname.includes(marker));
}

export function getScannerPublicBaseUrl(): string {
  return normalizeUrl(import.meta.env.VITE_SCANNER_PUBLIC_URL || import.meta.env.VITE_NGROK_URL);
}

export function buildScannerPublicUrl(pathname: string, baseOverride?: string | null): string {
  const baseUrl = normalizeUrl(baseOverride) || getScannerPublicBaseUrl();
  return baseUrl ? `${baseUrl}${pathname}` : pathname;
}

export function getScannerApiBaseUrl(): string {
  const configuredScannerBackend = normalizeUrl(import.meta.env.VITE_SCANNER_BACKEND_URL);
  const configuredBackend = normalizeUrl(import.meta.env.VITE_PUSH_SERVER_URL);
  const scannerBackendIsLoopback = isLoopbackUrl(configuredScannerBackend);
  const backendIsLoopback = isLoopbackUrl(configuredBackend);
  const useHostedScannerBackendInDev = shouldUseHostedScannerBackendInDev(configuredScannerBackend, scannerBackendIsLoopback);

  if (typeof window === 'undefined') {
    return configuredScannerBackend || configuredBackend || 'http://127.0.0.1:3001';
  }

  if (import.meta.env.VITE_SCANNER_FORCE_SAME_ORIGIN === 'true' || isTunnelHost()) {
    return '';
  }

  if (useHostedScannerBackendInDev) {
    return configuredScannerBackend;
  }

  if (import.meta.env.DEV && isLocalHost()) {
    return '';
  }

  if (!isLocalHost()) {
    if (configuredScannerBackend && !scannerBackendIsLoopback) {
      return configuredScannerBackend;
    }

    if (configuredBackend && !backendIsLoopback) {
      return configuredBackend;
    }

    return '';
  }

  if (configuredScannerBackend) {
    return configuredScannerBackend;
  }

  return configuredBackend || 'http://127.0.0.1:3001';
}

export function getMobileScanToken(): string | null {
  if (typeof window === 'undefined') return null;

  const stored = sessionStorage.getItem('mobileScanToken');
  if (stored) return stored;

  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      sessionStorage.setItem('mobileScanToken', token);
      return token;
    }
  } catch {
    return null;
  }

  return null;
}

export function getMobileScanAuthHeaders(): Record<string, string> {
  const token = getMobileScanToken();
  return token ? { 'X-Mobile-Token': token } : {};
}