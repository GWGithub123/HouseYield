export function resolveOwnerIdFromPropertyId(propertyId) {
  if (typeof propertyId !== 'string' || !propertyId.trim()) {
    return '';
  }

  const trimmed = propertyId.trim();
  const separatorIndex = trimmed.indexOf('_');
  if (separatorIndex <= 0) {
    return '';
  }

  return trimmed.slice(0, separatorIndex);
}

export function resolveAddressFromPropertyId(propertyId) {
  if (typeof propertyId !== 'string' || !propertyId.includes('_')) {
    return '';
  }

  const encoded = propertyId.split('_').slice(1).join('_');
  if (!encoded) {
    return '';
  }

  try {
    return Buffer.from(encoded, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
}

export function resolveOwnerIdForSensorAlert(alert = {}, propertyInfo = null) {
  const directOwnerId = propertyInfo?.ownerId || alert.ownerId || alert.ownerUID;
  if (directOwnerId) {
    return String(directOwnerId);
  }

  return resolveOwnerIdFromPropertyId(
    propertyInfo?.id || alert.propertyId || alert.propertyScopeId || '',
  );
}

export function buildPropertyInfoForSensorAlert(alert = {}, propertyInfo = null) {
  const ownerId = resolveOwnerIdForSensorAlert(alert, propertyInfo);
  const id = propertyInfo?.id || alert.propertyId || '';
  const decodedAddress = resolveAddressFromPropertyId(id || alert.propertyId || '');
  const address = propertyInfo?.address
    || alert.propertyAddress
    || decodedAddress
    || alert.location
    || 'Property';

  return {
    id,
    address,
    ownerId: ownerId || null,
    tenants: Array.isArray(propertyInfo?.tenants) ? propertyInfo.tenants : [],
  };
}
