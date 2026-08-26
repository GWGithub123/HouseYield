import { resolveShellyApiBaseUrl } from './iotProjectConfig';

export interface RelayCommandPayload {
  deviceId: string;
  deviceDocId?: string;
  action: 'open' | 'close' | 'pulse';
  durationMs?: number;
}

export interface RelayCommandResult {
  success: boolean;
  error?: string;
  source?: string;
  action?: string;
  valveState?: 'open' | 'closed' | 'unknown';
  relayOutputOn?: boolean;
  message?: string;
}

export interface RelayStatusResult {
  success: boolean;
  valveState?: 'open' | 'closed' | 'unknown';
  relayOutputOn?: boolean;
  status?: string;
  online?: boolean;
  source?: string;
  lastValveCommand?: string | null;
  lastValveCommandAt?: string | null;
  lastSeen?: string;
  error?: string;
  reason?: string;
  message?: string;
  ip?: string;
}

function normalizeBaseUrl(value: string | undefined | null): string {
  if (!value) return '';
  return String(value).replace(/\/$/, '');
}

function isNgrokUrl(value: string): boolean {
  return /ngrok/i.test(value);
}

function isLocalDevBase(value: string): boolean {
  if (value === '') return true;
  return /localhost|127\.0\.0\.1/i.test(value);
}

/**
 * Relay control/status bases.
 *
 * The public backend is authoritative even during local development. Physical
 * devices maintain outbound connections to it, so the browser's network and
 * the property's network are deliberately unrelated. LAN control remains a
 * fallback for setup and internet outages.
 */
export function resolveRelayApiBases(): string[] {
  const bases: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined | null) => {
    const normalized = normalizeBaseUrl(value);
    if (isNgrokUrl(normalized)) return;
    const key = normalized === '' ? '__same_origin__' : normalized;
    if (seen.has(key)) return;
    seen.add(key);
    bases.push(normalized);
  };

  const onLocalhost = typeof window !== 'undefined'
    && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  if (onLocalhost) {
    add(import.meta.env.VITE_BACKEND_PUBLIC_URL);
    add(import.meta.env.VITE_PUSH_SERVER_URL);
    add(import.meta.env.VITE_SHELLY_SERVER_PUBLIC_URL);
    add(resolveShellyApiBaseUrl());
    // Same-origin is the Vite proxy to the local backend. One local fallback is
    // enough; explicitly adding :3001 as well used to execute the same failed
    // subnet scan twice before the cloud command was attempted.
    add('');
  } else {
    add(import.meta.env.VITE_BACKEND_PUBLIC_URL);
    add(import.meta.env.VITE_PUSH_SERVER_URL);
    add(import.meta.env.VITE_SHELLY_SERVER_PUBLIC_URL);
    add(resolveShellyApiBaseUrl());
  }

  if (bases.length === 0) {
    add('');
  }

  return bases;
}

async function postRelayCommand(baseUrl: string, payload: RelayCommandPayload): Promise<RelayCommandResult> {
  const response = await fetch(
    `${baseUrl}/api/shelly/relay/${encodeURIComponent(payload.deviceId)}/command`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: payload.action,
        deviceDocId: payload.deviceDocId,
        ...(payload.durationMs ? { durationMs: payload.durationMs } : {}),
      }),
    },
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw new Error(data?.error || data?.message || `Failed to send valve command (${response.status})`);
  }

  return data;
}

export async function sendRelayCommand(payload: RelayCommandPayload): Promise<RelayCommandResult> {
  const bases = resolveRelayApiBases();
  // Cloud first everywhere. The device initiates that connection, so it works
  // whether this browser is at the property, on cellular, or on another LAN.
  const ordered = [...bases].sort((a, b) => Number(isLocalDevBase(a)) - Number(isLocalDevBase(b)));
  const errors: string[] = [];

  for (const baseUrl of ordered) {
    try {
      return await postRelayCommand(baseUrl, payload);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Relay command failed');
    }
  }

  throw new Error(errors[0] || 'Failed to send valve command');
}

function normalizeStatus(data: Record<string, unknown>, online: boolean): RelayStatusResult {
  return {
    ...data,
    success: true,
    online,
    status: online ? 'online' : 'offline',
  } as RelayStatusResult;
}

/**
 * True when the backend proved reachability with a real RPC (not a zombie socket).
 * Older Cloud Run builds returned online:true for half-open WS with no lastSeen.
 */
function isVerifiedOnline(data: Record<string, unknown> | null | undefined): boolean {
  if (!data || data.online !== true) return false;
  if (data.source === 'local_http') return true;
  if (data.source === 'websocket' && data.lastSeen) return true;
  // Another Cloud Run instance owns the live WS — trust fresh Firestore presence.
  if (data.source === 'cached_presence' && data.lastSeen) return true;
  if (data.lastSeen && data.status === 'online') return true;
  return false;
}

async function fetchStatusFromBase(
  baseUrl: string,
  deviceId: string,
  query: string,
): Promise<{ baseUrl: string; data: Record<string, unknown> | null; error?: string }> {
  try {
    const response = await fetch(
      `${baseUrl}/api/shelly/relay/${encodeURIComponent(deviceId)}/status${query ? `?${query}` : ''}`,
    );
    const data = await response.json().catch(() => null);
    if (data?.error && /too many requests/i.test(String(data.error))) {
      return { baseUrl, data: null, error: String(data.error) };
    }
    if (data && data.online === false) {
      return { baseUrl, data };
    }
    if (!response.ok || !data?.success) {
      return {
        baseUrl,
        data: null,
        error: data?.error || `Relay status failed (${response.status})`,
      };
    }
    return { baseUrl, data };
  } catch (error) {
    return {
      baseUrl,
      data: null,
      error: error instanceof Error ? error.message : 'Relay status failed',
    };
  }
}

export async function fetchRelayStatus(deviceId: string, deviceDocId?: string): Promise<RelayStatusResult> {
  const bases = resolveRelayApiBases();
  const params = new URLSearchParams();
  if (deviceDocId) params.set('deviceDocId', deviceDocId);
  const query = params.toString();

  const localBases = bases.filter((base) => isLocalDevBase(base));
  const remoteBases = bases.filter((base) => !isLocalDevBase(base));
  const results: Array<{ baseUrl: string; data: Record<string, unknown> | null; error?: string }> = [];

  // 1) Local first — property LAN / mDNS. Skip further local duplicates once answered.
  for (const baseUrl of localBases) {
    const result = await fetchStatusFromBase(baseUrl, deviceId, query);
    results.push(result);
    if (result.data?.online === true && (
      isVerifiedOnline(result.data) || result.data.source === 'local_http'
    )) {
      return normalizeStatus(result.data, true);
    }
    // Local offline (travel-router LAN miss) is NOT final — always try Cloud Run.
    // Soft cached_presence from the local backend is also a valid online.
    if (result.data?.online === true && result.data.source === 'cached_presence') {
      return normalizeStatus(result.data, true);
    }
    if (result.data?.online === false) break;
  }

  // 2) Cloud — Shelly outbound WS usually lands here when this Mac can't reach
  //    the travel-router IoT LAN. Multi-instance Cloud Run may miss the socket
  //    on one revision and still return cached_presence from Firestore.
  for (const baseUrl of remoteBases) {
    const result = await fetchStatusFromBase(baseUrl, deviceId, query);
    results.push(result);
    if (!result.data) continue;
    if (result.data.online === true && isVerifiedOnline(result.data)) {
      return normalizeStatus(result.data, true);
    }
    if (result.data.online === true && (
      result.data.source === 'websocket' || result.data.source === 'cached_presence'
    )) {
      return normalizeStatus(result.data, true);
    }
    // Keep scanning remotes — one instance without the WS is not conclusive.
  }

  const softOnline = results.find((entry) => (
    entry.data?.online === true && (
      isVerifiedOnline(entry.data) || entry.data.source === 'cached_presence'
    )
  ));
  if (softOnline?.data) return normalizeStatus(softOnline.data, true);

  const offline = results.find((entry) => entry.data?.online === false);
  if (offline?.data) return normalizeStatus(offline.data, false);

  const errors = results.map((entry) => entry.error).filter(Boolean);
  throw new Error(errors[0] || 'Failed to fetch relay status');
}
