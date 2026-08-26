import type { PropertyDashboard } from '../types/attom';
import type { PropertyHealthAsset } from '../types/propertyHealth';
import type { HealthDocumentIngestResult } from './propertyHealthDocuments';
import type { ComponentModelProfile } from './propertyHealthForecast';
import type { HealthPhotoAnalysisResult } from './propertyHealthPhotos';
import type { SavedProperty } from '../utils/savedProperties';
import {
  buildOwnerFinanceQuery,
  buildOwnerFinanceUrl,
  getOwnerFinanceHeaders,
} from './ownerFinanceApi';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type OwnerPropertyApiRecord = {
  id: string;
  ownerId?: string;
  address?: string;
  createdAt?: string;
  updatedAt?: string;
  image?: string | null;
  financials?: Record<string, unknown> | null;
  tenantId?: string | null;
  tenant?: Record<string, unknown> | null;
  tenants?: Array<Record<string, unknown>>;
  tenantCount?: number;
  property_data?: PropertyDashboard;
  propertyData?: PropertyDashboard;
  healthAssets?: PropertyHealthAsset[];
};

export type OwnerTenantApiRecord = {
  id: string;
  propertyId: string;
  propertyAddress: string;
  firebaseUid: string | null;
  name: string;
  email: string;
  phone: string;
  status?: string;
  unit?: string;
  leaseStart?: string;
  leaseEnd?: string;
  monthlyRent?: number;
  rawTenant: Record<string, unknown>;
};

export type { OwnerPropertyApiRecord };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeAddress(address: string): string {
  return String(address || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getPropertyDashboard(property: OwnerPropertyApiRecord): PropertyDashboard {
  return (property.property_data || property.propertyData || { summary: {} }) as PropertyDashboard;
}

function normalizeOwnerPropertyRecord(
  property: OwnerPropertyApiRecord,
): OwnerPropertyApiRecord & { tenants: Array<Record<string, unknown>> } {
  const dashboard = getPropertyDashboard(property);
  const tenants = Array.isArray(property.tenants)
    ? property.tenants
    : property.tenant
      ? [property.tenant]
      : [];

  return {
    ...property,
    financials: property.financials || {},
    propertyData: dashboard,
    property_data: dashboard,
    tenants,
    tenantCount: typeof property.tenantCount === 'number' ? property.tenantCount : tenants.length,
  };
}

function normalizeOwnerTenantRecord(
  property: OwnerPropertyApiRecord,
  tenantValue: Record<string, unknown>,
  index: number,
): OwnerTenantApiRecord | null {
  const tenant = asRecord(tenantValue);
  const propertyId = optionalString(property.id);

  if (!propertyId) {
    return null;
  }

  const tenantId = optionalString(tenant.id)
    || optionalString(property.tenantId)
    || `${propertyId}:tenant:${index}`;
  const firstName = optionalString(tenant.firstName) || '';
  const lastName = optionalString(tenant.lastName) || '';
  const fullName = `${firstName} ${lastName}`.trim();

  return {
    id: tenantId,
    propertyId,
    propertyAddress: optionalString(property.address) || propertyId,
    firebaseUid: optionalString(tenant.firebaseUid) || null,
    name: optionalString(tenant.name) || fullName || 'Unknown',
    email: optionalString(tenant.email) || '',
    phone: optionalString(tenant.phone) || '',
    status: optionalString(tenant.status),
    unit: optionalString(tenant.unit),
    leaseStart: optionalString(tenant.leaseStart),
    leaseEnd: optionalString(tenant.leaseEnd),
    monthlyRent: optionalNumber(tenant.monthlyRent) ?? optionalNumber(tenant.rent),
    rawTenant: tenant,
  };
}

export function extractOwnerPropertyTenants(
  properties: OwnerPropertyApiRecord[],
): OwnerTenantApiRecord[] {
  const seen = new Set<string>();

  return properties.flatMap((property) => {
    const normalizedProperty = normalizeOwnerPropertyRecord(property);
    return normalizedProperty.tenants
      .map((tenant, index) => normalizeOwnerTenantRecord(normalizedProperty, asRecord(tenant), index))
      .filter((tenant): tenant is OwnerTenantApiRecord => Boolean(tenant))
      .filter((tenant) => {
        const key = `${tenant.propertyId}:${tenant.id}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  });
}

function mapOwnerPropertyToSavedProperty(property: OwnerPropertyApiRecord): SavedProperty {
  const normalized = normalizeOwnerPropertyRecord(property);

  return {
    id: normalized.id,
    address: normalized.address || normalized.id,
    savedAt: normalized.createdAt || normalized.updatedAt || new Date().toISOString(),
    data: getPropertyDashboard(normalized),
    thumbnail: normalized.image || undefined,
  };
}

async function requestOwnerPropertiesJson(
  url: string,
  init: Omit<RequestInit, 'headers'> = {},
  extraHeaders: Record<string, string> = {},
) {
  const authHeaders = await getOwnerFinanceHeaders(extraHeaders);
  const headers = authHeaders || (Object.keys(extraHeaders).length ? extraHeaders : undefined);

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }

  return payload;
}

export const ownerPropertiesClient = {
  async listDetailed(
    ownerId: string,
    options: { withTenants?: boolean } = {},
  ): Promise<OwnerPropertyApiRecord[]> {
    if (!ownerId) {
      return [];
    }

    const payload = await requestOwnerPropertiesJson(
      buildOwnerFinanceUrl(
        `/api/owner-properties${buildOwnerFinanceQuery({ ownerId, withTenants: options.withTenants ? 'true' : undefined })}`,
      ),
    );

    return Array.isArray(payload.properties)
      ? payload.properties.map(normalizeOwnerPropertyRecord)
      : [];
  },

  async list(ownerId: string): Promise<SavedProperty[]> {
    if (!ownerId) {
      return [];
    }

    const properties = await this.listDetailed(ownerId);
    return properties.map(mapOwnerPropertyToSavedProperty);
  },

  async listTenants(ownerId: string): Promise<OwnerTenantApiRecord[]> {
    const properties = await this.listDetailed(ownerId, { withTenants: true });
    return extractOwnerPropertyTenants(properties);
  },

  async findByAddress(ownerId: string, address: string): Promise<SavedProperty | null> {
    const properties = await this.list(ownerId);
    const target = normalizeAddress(address);
    return properties.find((property) => normalizeAddress(property.address) === target) || null;
  },

  async save({
    ownerId,
    address,
    propertyData,
    financials,
    tenantId,
    image,
  }: {
    ownerId: string;
    address: string;
    propertyData: PropertyDashboard;
    financials?: Record<string, unknown>;
    tenantId?: string | null;
    image?: string | null;
  }) {
    return requestOwnerPropertiesJson(
      buildOwnerFinanceUrl('/api/owner-properties'),
      {
        method: 'POST',
        body: JSON.stringify({
          ownerId,
          address,
          propertyData,
          financials,
          tenantId,
          image,
        }),
      },
      JSON_HEADERS,
    );
  },

  async remove(ownerId: string, propertyId: string) {
    return requestOwnerPropertiesJson(
      buildOwnerFinanceUrl(
        `/api/owner-properties/${encodeURIComponent(propertyId)}${buildOwnerFinanceQuery({ ownerId })}`,
      ),
      { method: 'DELETE' },
    );
  },

  async clearTenant(ownerId: string, propertyId: string, tenantId?: string) {
    return requestOwnerPropertiesJson(
      buildOwnerFinanceUrl(
        `/api/owner-properties/${encodeURIComponent(propertyId)}/tenant${buildOwnerFinanceQuery({ ownerId, tenantId })}`,
      ),
      { method: 'DELETE' },
    );
  },

  async getHealthAssets(ownerId: string, propertyId: string): Promise<PropertyHealthAsset[]> {
    if (!ownerId || !propertyId) {
      return [];
    }

    const payload = await requestOwnerPropertiesJson(
      buildOwnerFinanceUrl(
        `/api/owner-properties/${encodeURIComponent(propertyId)}${buildOwnerFinanceQuery({ ownerId })}`,
      ),
    );

    const property = payload?.property as OwnerPropertyApiRecord | undefined;
    return Array.isArray(property?.healthAssets) ? property.healthAssets : [];
  },

  async saveHealthAssets(
    ownerId: string,
    propertyId: string,
    healthAssets: PropertyHealthAsset[],
  ) {
    return requestOwnerPropertiesJson(
      buildOwnerFinanceUrl(
        `/api/owner-properties/${encodeURIComponent(propertyId)}/health-assets`,
      ),
      {
        method: 'PUT',
        body: JSON.stringify({ ownerId, healthAssets }),
      },
      JSON_HEADERS,
    );
  },

  /**
   * Reads an already-uploaded receipt or record into health proposals.
   *
   * Returns proposals for review rather than writing: applying them is a
   * separate `saveHealthAssets` call once the owner has accepted them.
   */
  async ingestHealthDocument(input: {
    ownerId: string;
    propertyId: string;
    storagePath?: string;
    fileUrl?: string;
    fileName?: string;
    mimeType?: string;
    documentId?: string;
  }): Promise<HealthDocumentIngestResult> {
    return requestOwnerPropertiesJson(
      buildOwnerFinanceUrl('/api/property-health/ingest-document'),
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      JSON_HEADERS,
    ) as Promise<HealthDocumentIngestResult>;
  },

  async getComponentModelProfile(input: {
    category: PropertyHealthAsset['category'];
    make: string;
    model: string;
    force?: boolean;
  }): Promise<{
    ok: boolean;
    status: string;
    error?: string;
    warning?: string;
    profile: ComponentModelProfile | null;
  }> {
    return requestOwnerPropertiesJson(
      buildOwnerFinanceUrl('/api/property-health/component-model'),
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      JSON_HEADERS,
    );
  },

  async analyzeHealthPhoto(input: {
    ownerId: string;
    propertyId: string;
    storagePath?: string;
    fileUrl?: string;
    category: PropertyHealthAsset['category'];
    name: string;
    make?: string;
    model?: string;
    sourceKind?: 'owner_photo' | 'aerial';
  }): Promise<HealthPhotoAnalysisResult> {
    return requestOwnerPropertiesJson(
      buildOwnerFinanceUrl('/api/property-health/analyze-photo'),
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      JSON_HEADERS,
    );
  },
};