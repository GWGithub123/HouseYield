import type { PropertyDashboard } from '../types/attom';
import type { CanonicalPropertyProfile, CanonicalSourceReference } from '../types/renovationPipeline';

interface BuildCanonicalPropertyProfileOptions {
  marketContextReferences?: CanonicalSourceReference[];
  existingRentBaselineReferences?: CanonicalSourceReference[];
}

function extractZip(address?: string): string | null {
  if (!address) return null;
  const match = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildCanonicalPropertyProfile(
  dashboard: PropertyDashboard,
  options: BuildCanonicalPropertyProfileOptions = {}
): CanonicalPropertyProfile {
  const summary = dashboard.summary || {};
  const latestTax = dashboard.tax_history?.[0];

  return {
    address: summary.address || '',
    zip: extractZip(summary.address),
    latitude: toNullableNumber(summary.latitude ?? dashboard.location?.latitude),
    longitude: toNullableNumber(summary.longitude ?? dashboard.location?.longitude),
    yearBuilt: toNullableNumber(summary.year_built),
    beds: toNullableNumber(summary.beds),
    baths: toNullableNumber(summary.baths),
    livingSqft: toNullableNumber(summary.living_sqft),
    propertyType: summary.property_type || null,
    rawAttomFacts: (dashboard.raw as Record<string, unknown>) || (summary as Record<string, unknown>) || null,
    livingAreaContext: {
      sqft: toNullableNumber(summary.living_sqft),
      source: 'attom.summary.living_sqft',
    },
    lotContext: {
      acres: toNullableNumber(summary.lot_acres),
      sqft: typeof summary.lot_acres === 'number' ? Math.round(summary.lot_acres * 43560) : null,
      source: 'attom.summary.lot_acres',
    },
    ageContext: {
      actualAge: toNullableNumber(summary.age),
      effectiveAge: toNullableNumber(summary.age),
      source: 'attom.summary.age',
    },
    hazardContext: {
      flood: toNullableNumber((dashboard.environmental as any)?.flood?.score ?? (dashboard as any)?.hazard_scores?.flood),
      fire: toNullableNumber((dashboard.environmental as any)?.fire?.score ?? (dashboard as any)?.hazard_scores?.fire),
      earthquake: toNullableNumber((dashboard.environmental as any)?.earthquake?.score ?? (dashboard as any)?.hazard_scores?.earthquake),
      source: 'attom.environmental',
    },
    taxContext: {
      assessedValue: toNullableNumber(summary.assessed_value),
      latestTaxAmount: toNullableNumber(latestTax?.tax_amount),
      taxHistoryYears: dashboard.tax_history?.length || 0,
      source: 'attom.tax_history',
    },
    avmContext: {
      avmValue: toNullableNumber(summary.avm_value),
      avmLow: toNullableNumber(summary.avm_low),
      avmHigh: toNullableNumber(summary.avm_high),
      source: 'attom.summary.avm_*',
    },
    marketContextReferences: options.marketContextReferences || [],
    existingRentBaselineReferences: options.existingRentBaselineReferences || [],
  };
}