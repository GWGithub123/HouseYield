export function getPropertyMatchKey(propertyId?: string | null): string {
  if (!propertyId) return '';
  const separatorIndex = propertyId.indexOf('_');
  return separatorIndex >= 0 ? propertyId.slice(separatorIndex + 1) : propertyId;
}

export function propertyIdsMatch(
  left?: string | null,
  right?: string | null
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return getPropertyMatchKey(left) === getPropertyMatchKey(right);
}

export function alertMatchesProperty(
  alert: { deviceId?: string; propertyId?: string | null },
  propertyId: string,
  devices: Array<{ deviceId?: string; propertyId?: string | null }>,
  archivedDevices: Array<{ deviceId?: string; propertyId?: string | null }> = [],
): boolean {
  if (propertyIdsMatch(alert.propertyId, propertyId)) {
    return true;
  }

  const device = devices.find((candidate) => candidate.deviceId === alert.deviceId)
    || archivedDevices.find((candidate) => candidate.deviceId === alert.deviceId);
  return propertyIdsMatch(device?.propertyId, propertyId);
}
