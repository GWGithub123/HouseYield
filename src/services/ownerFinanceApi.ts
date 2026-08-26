import { auth } from '../config/firebase';

export type OwnerFinanceQueryValue = string | number | boolean | null | undefined;

function normalizeSubpath(path: string): string {
  if (!path) {
    return '';
  }

  return path.startsWith('/') ? path : `/${path}`;
}

export function getOwnerFinanceBaseUrl(): string {
  const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
  const useProxy = import.meta.env.MODE === 'development' && !baseEnv;
  return useProxy ? '' : (baseEnv || '');
}

export function buildOwnerFinanceUrl(path: string): string {
  return `${getOwnerFinanceBaseUrl()}${normalizeSubpath(path)}`;
}

export function buildBookkeepingUrl(path = ''): string {
  return buildOwnerFinanceUrl(`/api/bookkeeping/firestore${normalizeSubpath(path)}`);
}

export function buildBookkeepingTaxUrl(path = ''): string {
  return buildBookkeepingUrl(`/tax${normalizeSubpath(path)}`);
}

export function buildQuickBooksUrl(path = ''): string {
  return buildOwnerFinanceUrl(`/api/quickbooks/firestore${normalizeSubpath(path)}`);
}

export function buildOwnerFinanceQuery(
  params: Record<string, OwnerFinanceQueryValue>,
): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

export async function getOwnerFinanceAuthToken(): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) {
    return null;
  }

  try {
    return await user.getIdToken();
  } catch (error) {
    console.error('[OwnerFinanceApi] Error getting auth token:', error);
    return null;
  }
}

export async function getOwnerFinanceHeaders(
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, string> | null> {
  const token = await getOwnerFinanceAuthToken();
  if (!token) {
    return null;
  }

  return {
    ...extraHeaders,
    Authorization: `Bearer ${token}`,
  };
}

export async function requestOwnerFinanceJson(
  url: string,
  init: Omit<RequestInit, 'headers'> = {},
  extraHeaders: Record<string, string> = {},
): Promise<any> {
  const headers = await getOwnerFinanceHeaders(extraHeaders);
  if (!headers) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const payload = await response.json().catch(() => ({}));
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      _httpOk: response.ok,
      _httpStatus: response.status,
      ...payload,
    };
  }

  return {
    _httpOk: response.ok,
    _httpStatus: response.status,
    data: payload,
  };
}

export async function requestOwnerFinanceBlob(
  url: string,
  init: Omit<RequestInit, 'headers'> = {},
  extraHeaders: Record<string, string> = {},
): Promise<Blob> {
  const headers = await getOwnerFinanceHeaders(extraHeaders);
  if (!headers) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const payload = await response.clone().json().catch(() => null);
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }

  return response.blob();
}