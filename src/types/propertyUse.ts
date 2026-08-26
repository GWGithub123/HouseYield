/**
 * How an owner actually uses a property, which is a different question from its
 * structure (`propertyType`: single family, condo, townhouse).
 *
 * This drives which analytics are worth showing. Rental cash-flow modelling on a
 * second home is not merely irrelevant, it is misleading — it reports rent and
 * cash flow for income that does not exist.
 *
 * ATTOM `rental_avm` is not owner rental evidence. Every house has a market rent
 * estimate; treating it as "this is a rental" would put Analytics on a primary
 * residence. Owner-saved monthly rent, a tenant, or an explicit rental use type
 * are what count.
 */

export type PropertyUseType =
  | 'long_term_rental'
  | 'short_term_rental'
  | 'second_home'
  | 'primary_residence';

export const PROPERTY_USE_TYPE_META: Record<
  PropertyUseType,
  { label: string; description: string; rental: boolean }
> = {
  long_term_rental: {
    label: 'Long-term rental',
    description: 'Leased to a tenant on a term lease',
    rental: true,
  },
  short_term_rental: {
    label: 'Short-term rental',
    description: 'Vacation or nightly rental, may also be used personally',
    rental: true,
  },
  second_home: {
    label: 'Second home / vacation home',
    description: 'Personal use, not rented out',
    rental: false,
  },
  primary_residence: {
    label: 'Primary residence',
    description: 'Where you live',
    rental: false,
  },
};

export const PROPERTY_USE_TYPES = Object.keys(PROPERTY_USE_TYPE_META) as PropertyUseType[];

/**
 * Conservative default. An unset property shows the smaller, always-true set of
 * analytics rather than fabricating rent and cash-flow figures for it — unless
 * the owner already saved rent or a tenant on that record.
 */
export const DEFAULT_PROPERTY_USE_TYPE: PropertyUseType = 'second_home';

const LEGACY_ALIASES: Record<string, PropertyUseType> = {
  rental: 'long_term_rental',
  long_term: 'long_term_rental',
  longterm: 'long_term_rental',
  ltr: 'long_term_rental',
  short_term: 'short_term_rental',
  shortterm: 'short_term_rental',
  str: 'short_term_rental',
  airbnb: 'short_term_rental',
  vacation: 'second_home',
  vacation_home: 'second_home',
  secondary: 'second_home',
  primary: 'primary_residence',
  owner_occupied: 'primary_residence',
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function parseUseType(value: unknown): PropertyUseType | null {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return null;
  if (raw in PROPERTY_USE_TYPE_META) return raw as PropertyUseType;
  return LEGACY_ALIASES[raw] ?? null;
}

function isPositiveAmount(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function tenantsOf(record: Record<string, any>): Record<string, any>[] {
  if (Array.isArray(record.tenants)) {
    return record.tenants.filter((tenant) => tenant && typeof tenant === 'object');
  }
  if (record.tenant && typeof record.tenant === 'object') {
    return [record.tenant];
  }
  return [];
}

function firstUseTypeCandidate(record: Record<string, any>): unknown {
  return (
    record.useType
    ?? record.use_type
    ?? record.property_data?.summary?.useType
    ?? record.property_data?.summary?.use_type
    ?? record.propertyData?.summary?.useType
    ?? record.propertyData?.summary?.use_type
    ?? record.data?.summary?.useType
    ?? record.data?.summary?.use_type
    ?? record.summary?.useType
    ?? record.summary?.use_type
    ?? record.financial_data?.useType
    ?? record.financials?.useType
  );
}

export function normalizePropertyUseType(value: unknown): PropertyUseType {
  return parseUseType(value) ?? DEFAULT_PROPERTY_USE_TYPE;
}

export function isRentalUseType(value: unknown): boolean {
  const parsed = parseUseType(value);
  if (!parsed) return false;
  return PROPERTY_USE_TYPE_META[parsed].rental;
}

/** Explicit use type written on the record, or null if it was never set. */
export function readStoredUseType(property: unknown): PropertyUseType | null {
  return parseUseType(firstUseTypeCandidate(asRecord(property)));
}

/**
 * Owner-entered rental facts only. Does not read ATTOM rental AVM / market rent.
 */
export function propertyHasOwnerRentalEvidence(property: unknown): boolean {
  const record = asRecord(property);
  if (isPositiveAmount(record.financial_data?.monthlyRent)) return true;
  if (isPositiveAmount(record.financials?.monthlyRent)) return true;
  if (isPositiveAmount(record.tenant?.monthlyRent) || isPositiveAmount(record.tenant?.rent)) return true;
  if (Number(record.tenantCount) > 0) return true;

  return tenantsOf(record).some((tenant) => {
    const status = String(tenant.status || '').toLowerCase();
    return (
      isPositiveAmount(tenant.monthlyRent)
      || isPositiveAmount(tenant.rent)
      || status === 'current'
      || status === 'active'
      || status === 'leased'
    );
  });
}

/**
 * Pulls the use type off a saved property regardless of which layer it was
 * written at — onboarding writes it into `property_data.summary`, later edits
 * land on the record itself. When it was never stored, infer a rental if the
 * owner already saved rent or a tenant.
 */
export function resolvePropertyUseType(property: unknown): PropertyUseType {
  const stored = readStoredUseType(property);
  if (stored) return stored;
  if (propertyHasOwnerRentalEvidence(property)) return 'long_term_rental';
  return DEFAULT_PROPERTY_USE_TYPE;
}

export function shouldShowRentalWorkspace(
  property: unknown,
  extras: { occupied?: boolean; monthlyRent?: number } = {},
): boolean {
  const stored = readStoredUseType(property);
  if (stored && PROPERTY_USE_TYPE_META[stored].rental) return true;
  if (propertyHasOwnerRentalEvidence(property)) return true;
  if (extras.occupied) return true;
  if (isPositiveAmount(extras.monthlyRent)) return true;
  return false;
}
