import { getDevApiBaseUrl } from '../utils/devApiBase';
import type { ProviderReviewAnalysis } from '../components/maintenance/ticketTypes';

export interface ProviderNetworkStats {
  jobsCompleted: number;
  totalSpend: number;
  avgCost: number | null;
  avgResponseHours: number | null;
  repeatIssueCount: number;
  repeatIssueRate: number | null;
  firstVisitResolutionRate: number | null;
  avgOwnerRating: number | null;
  lastUsedAt: string | null;
}

export interface NetworkProvider {
  id: string;
  placeId?: string;
  name: string;
  phone?: string;
  address?: string;
  website?: string;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  reviewCount: number | null;
  aiScore: number | null;
  aiAnalysis: ProviderReviewAnalysis | null;
  categories: string[];
  status?: string;
  networkStats: ProviderNetworkStats | null;
  timesShortlisted?: number;
  distanceMiles?: number | null;
  firstSeenAt?: string;
  updatedAt?: string;
}

export interface PropertyServiceRecord {
  id: string;
  requestId: string;
  propertyAddress?: string;
  category?: string;
  providerName?: string;
  completedAt?: string;
  workPerformed?: string;
  totals?: { parts: number | null; labor: number | null; total: number | null } | null;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export async function fetchProviderNetwork(params: {
  category?: string;
  lat?: number | null;
  lng?: number | null;
  radiusMiles?: number | null;
  limit?: number;
} = {}) {
  const query = new URLSearchParams();
  if (params.category) query.set('category', params.category);
  if (params.lat !== null && params.lat !== undefined) query.set('lat', String(params.lat));
  if (params.lng !== null && params.lng !== undefined) query.set('lng', String(params.lng));
  if (params.radiusMiles) query.set('radiusMiles', String(params.radiusMiles));
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.toString() ? `?${query.toString()}` : '';
  const response = await fetch(`${getDevApiBaseUrl()}/api/maintenance/providers${suffix}`);
  return readJson<{ ok: boolean; providers: NetworkProvider[]; total: number }>(response);
}

export async function fetchPropertyServiceHistory(propertyId: string) {
  const response = await fetch(
    `${getDevApiBaseUrl()}/api/maintenance/properties/${encodeURIComponent(propertyId)}/service-history`,
  );
  return readJson<{
    ok: boolean;
    records: PropertyServiceRecord[];
    summary: { visits: number; totalSpend: number; categories: string[] };
  }>(response);
}
