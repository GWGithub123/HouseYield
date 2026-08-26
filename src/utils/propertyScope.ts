/**
 * Canonical bookkeeping / tax property scope ids used by Management, Tax, and enrich-mortgage routes.
 */
export function buildBookkeepingPropertyId(
  ownerId: string | undefined,
  property: { id: string } | null | undefined,
): string | undefined {
  if (!ownerId || !property?.id) return undefined;
  return `${ownerId}_${property.id}`;
}

export function resolveBookkeepingPropertyId(
  ownerId: string | undefined,
  address: string | undefined,
  properties: Array<{ id: string; address?: string | null }>,
): string | undefined {
  if (!ownerId || !address) return undefined;
  const normalized = address.trim().toLowerCase();
  const match = properties.find((property) => {
    const candidate = (property.address || '').trim().toLowerCase();
    return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
  });
  return match ? buildBookkeepingPropertyId(ownerId, match) : undefined;
}
