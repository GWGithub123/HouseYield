/**
 * Resolve property + tenant contact info for a sensor alert.
 */

let getPropertyById = null;
let getPropertiesWithTenants = null;

try {
  const propertyModule = await import('../property-firestore-service.js');
  getPropertyById = propertyModule.getPropertyById;
  getPropertiesWithTenants = propertyModule.getPropertiesWithTenants;
} catch (error) {
  console.warn('[SensorAlertTenantResolver] Property service unavailable:', error.message);
}

function tenantDisplayName(tenant) {
  if (!tenant) return 'Tenant';
  const explicit = typeof tenant.name === 'string' ? tenant.name.trim() : '';
  if (explicit) return explicit;
  const combined = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim();
  return combined || 'Tenant';
}

function normalizeTenantRecord(tenant, index = 0) {
  if (!tenant) return null;
  const statusRaw = String(tenant.status || 'active').toLowerCase();
  const status = statusRaw === 'active' || statusRaw === 'current' ? 'Current' : tenant.status || 'Current';

  return {
    id: tenant.id || `tenant-${index}`,
    name: tenantDisplayName(tenant),
    email: tenant.email || '',
    phone: tenant.phone || '',
    unit: tenant.unit || '1',
    status,
  };
}

function buildPropertyInfo(property, tenants = []) {
  const normalizedTenants = tenants
    .map((tenant, index) => normalizeTenantRecord(tenant, index))
    .filter(Boolean);

  return {
    id: property.id,
    address: property.address || property.id,
    ownerId: property.ownerId || null,
    tenants: normalizedTenants,
  };
}

export async function resolvePropertyInfoForAlert({
  propertyId,
  ownerId,
  unit,
} = {}) {
  if (!propertyId) {
    return null;
  }

  if (ownerId && getPropertiesWithTenants) {
    const result = await getPropertiesWithTenants(ownerId);
    if (result?.ok && Array.isArray(result.properties)) {
      const match = result.properties.find((property) => property.id === propertyId);
      if (match) {
        let tenants = Array.isArray(match.tenants) ? match.tenants : [];
        if (tenants.length === 0 && match.tenant) {
          tenants = [match.tenant];
        }
        if (unit) {
          const unitMatch = tenants.find((tenant) => String(tenant.unit || '1') === String(unit));
          if (unitMatch) {
            tenants = [unitMatch, ...tenants.filter((tenant) => tenant !== unitMatch)];
          }
        }
        return buildPropertyInfo(match, tenants);
      }
    }
  }

  if (getPropertyById) {
    const result = await getPropertyById(propertyId);
    if (result?.ok && result.property) {
      const property = result.property;
      const tenants = property.tenant ? [property.tenant] : [];
      return buildPropertyInfo(property, tenants);
    }
  }

  return null;
}

export function pickCurrentTenant(propertyInfo) {
  const tenants = propertyInfo?.tenants || [];
  return tenants.find((tenant) => tenant.status === 'Current')
    || tenants.find((tenant) => String(tenant.status || '').toLowerCase() === 'active')
    || tenants[0]
    || null;
}
