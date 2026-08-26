/**
 * dataAggregator.js — fans out to ATTOM, RentCast and FRED (all cached),
 * returning one normalized bundle for the underwriting engine.
 *
 * Cost profile per subject property:
 *  - ATTOM dashboard: Firestore-cached 90 days (1 reserve on miss)
 *  - RentCast value AVM + rent AVM: Firestore-cached 7 days
 *  - RentCast zip market: Firestore-cached 24h
 *  - FRED county: in-module cache
 */

import { fetchPropertyDashboard } from '../attom.js';
import { getCachedAttomData, cacheAttomData, isUsableAttomDashboardData } from '../attom-firestore-cache.js';
import { getZipMarketData, getValueEstimate, getRentEstimate } from '../rentcast.js';
import { getCountyFipsFromCoords, getCountyData } from '../fred.js';

function toNumber(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getAttomDashboardCached(address) {
  try {
    const cached = await getCachedAttomData(address);
    if (cached?.data && isUsableAttomDashboardData(cached.data)) {
      return { dashboard: cached.data, fromCache: true, stale: Boolean(cached.stale) };
    }
  } catch (err) {
    console.warn('[Engine Aggregator] ATTOM cache read failed:', err.message);
  }

  try {
    const dashboard = await fetchPropertyDashboard({ address, includeComponents: false });
    if (dashboard) {
      cacheAttomData(address, dashboard).catch(() => {});
      return { dashboard, fromCache: false, stale: false };
    }
  } catch (err) {
    console.warn('[Engine Aggregator] ATTOM live fetch failed:', err.message);
  }

  return { dashboard: null, fromCache: false, stale: false };
}

function extractSubject(dashboard, listingHints = {}) {
  const summary = dashboard?.summary || {};
  return {
    attomId: summary.attom_id || null,
    address: summary.address || listingHints.address || null,
    latitude: toNumber(summary.latitude) ?? toNumber(listingHints.latitude),
    longitude: toNumber(summary.longitude) ?? toNumber(listingHints.longitude),
    zipCode: summary.zip || listingHints.zipCode || null,
    city: summary.city || listingHints.city || null,
    state: summary.state || listingHints.state || null,
    beds: toNumber(summary.beds) ?? toNumber(listingHints.bedrooms),
    baths: toNumber(summary.baths) ?? toNumber(listingHints.bathrooms),
    sqft: toNumber(summary.living_sqft) ?? toNumber(listingHints.squareFootage),
    lotAcres: toNumber(summary.lot_acres),
    yearBuilt: toNumber(summary.year_built) ?? toNumber(listingHints.yearBuilt),
    age: toNumber(summary.age),
    propertyType: summary.property_type || listingHints.propertyType || null,
    avmValue: toNumber(summary.avm_value),
    avmLow: toNumber(summary.avm_low),
    avmHigh: toNumber(summary.avm_high),
    rentalAvm: toNumber(summary.rental_avm),
    rentalAvmLow: toNumber(summary.rental_avm_low),
    rentalAvmHigh: toNumber(summary.rental_avm_high),
    assessedValue: toNumber(summary.assessed_value),
    taxAmount: toNumber(summary.tax_amount ?? summary.taxes_annual ?? summary.tax_annual),
    pricePerSqft: toNumber(summary.price_per_sqft),
  };
}

function extractTaxAmount(dashboard) {
  const summary = dashboard?.summary || {};
  const direct = toNumber(summary.tax_amount ?? summary.taxes_annual ?? summary.tax_annual);
  if (direct) return direct;

  const taxHistory = dashboard?.tax_history || dashboard?.taxHistory || [];
  if (Array.isArray(taxHistory) && taxHistory.length) {
    const latest = [...taxHistory].sort((a, b) => (b.year || 0) - (a.year || 0))[0];
    return toNumber(latest?.tax_amount ?? latest?.amount ?? latest?.taxAmount);
  }
  return null;
}

/**
 * Aggregate all data sources for a subject property.
 *
 * @param {object} options
 *   address      — required street address
 *   listingHints — optional partial property facts (from a screener listing)
 *   include      — { attom, rentcastAvm, zipMarket, fred } toggles (all default true)
 */
export async function aggregatePropertyData({ address, listingHints = {}, include = {} }) {
  const wants = {
    attom: include.attom !== false,
    rentcastAvm: include.rentcastAvm !== false,
    zipMarket: include.zipMarket !== false,
    fred: include.fred !== false,
  };

  const sources = {
    attom: { ok: false, fromCache: false },
    rentcastValueAvm: { ok: false, fromCache: false },
    rentcastRentAvm: { ok: false, fromCache: false },
    zipMarket: { ok: false },
    fredCounty: { ok: false },
  };

  // 1. ATTOM dashboard (primary subject record)
  let dashboard = null;
  if (wants.attom) {
    const attomResult = await getAttomDashboardCached(address);
    dashboard = attomResult.dashboard;
    sources.attom = { ok: Boolean(dashboard), fromCache: attomResult.fromCache, stale: attomResult.stale };
  }

  const subject = extractSubject(dashboard, { address, ...listingHints });
  subject.taxAmount = extractTaxAmount(dashboard) ?? subject.taxAmount;

  // 2. RentCast AVMs + zip market + FRED county, in parallel
  const avmParams = {
    address,
    propertyType: subject.propertyType,
    bedrooms: subject.beds,
    bathrooms: subject.baths,
    squareFootage: subject.sqft,
  };

  const [valueAvmResult, rentAvmResult, zipMarketResult, fredResult] = await Promise.allSettled([
    wants.rentcastAvm ? getValueEstimate(avmParams) : Promise.resolve(null),
    wants.rentcastAvm ? getRentEstimate(avmParams) : Promise.resolve(null),
    wants.zipMarket && subject.zipCode ? getZipMarketData(subject.zipCode) : Promise.resolve(null),
    wants.fred && subject.latitude && subject.longitude
      ? getCountyFipsFromCoords(subject.latitude, subject.longitude)
          .then((fips) => (fips?.countyFips ? getCountyData(fips.countyFips, fips.countyName || 'Unknown') : null))
      : Promise.resolve(null),
  ]);

  const valueAvm = valueAvmResult.status === 'fulfilled' ? valueAvmResult.value : null;
  const rentAvm = rentAvmResult.status === 'fulfilled' ? rentAvmResult.value : null;
  const zipMarket = zipMarketResult.status === 'fulfilled' ? zipMarketResult.value : null;
  const fredCounty = fredResult.status === 'fulfilled' ? fredResult.value : null;

  sources.rentcastValueAvm = { ok: Boolean(valueAvm?.estimate), fromCache: Boolean(valueAvm?.fromCache) };
  sources.rentcastRentAvm = { ok: Boolean(rentAvm?.estimate), fromCache: Boolean(rentAvm?.fromCache) };
  sources.zipMarket = { ok: Boolean(zipMarket) };
  sources.fredCounty = { ok: Boolean(fredCounty) };

  if (valueAvmResult.status === 'rejected') console.warn('[Engine Aggregator] RentCast value AVM failed:', valueAvmResult.reason?.message);
  if (rentAvmResult.status === 'rejected') console.warn('[Engine Aggregator] RentCast rent AVM failed:', rentAvmResult.reason?.message);
  if (zipMarketResult.status === 'rejected') console.warn('[Engine Aggregator] Zip market failed:', zipMarketResult.reason?.message);
  if (fredResult.status === 'rejected') console.warn('[Engine Aggregator] FRED county failed:', fredResult.reason?.message);

  // Backfill coordinates from RentCast if ATTOM missed them
  if (!subject.latitude && valueAvm?.latitude) subject.latitude = valueAvm.latitude;
  if (!subject.longitude && valueAvm?.longitude) subject.longitude = valueAvm.longitude;

  const sourcesOkCount = Object.values(sources).filter((s) => s.ok).length;

  return {
    address,
    subject,
    dashboard,
    valueAvm,
    rentAvm,
    zipMarket,
    fredCounty,
    sources,
    confidence: sourcesOkCount >= 4 ? 'high' : sourcesOkCount >= 2 ? 'medium' : 'low',
  };
}
