/**
 * Data-loading wrapper for tax over-assessment analysis.
 * Pulls ATTOM subject + nearby assessed comps, RentCast value estimate,
 * then runs the pure engine. Caches results in Firestore.
 */

import { fetchPropertyDashboard, fetchAttomAVM } from '../attom.js';
import { fetchAttom } from '../attom-usage-limiter.js';
import {
  getCachedAttomData,
  cacheAttomData,
  isUsableAttomDashboardData,
} from '../attom-firestore-cache.js';
import { getValueEstimate, haversineMiles } from '../rentcast.js';
import { getCachedDoc, setCachedDoc, hashCacheKey } from '../firestore-doc-cache.js';
import {
  analyzeOverAssessment,
  toLeadTaxFields,
  num,
  round,
} from './taxOverAssessmentEngine.js';

const CACHE_COLLECTION = 'tax_over_assessment_cache';
const CACHE_TTL_HOURS = 24 * 14;
const ATTOM_BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const ATTOM_API_KEY = process.env.ATTOM_API_KEY || '';
const ATTOM_HEADERS = { Accept: 'application/json', apikey: ATTOM_API_KEY };

async function loadAttomDashboard(address) {
  const cached = await getCachedAttomData(address);
  if (cached?.data && isUsableAttomDashboardData(cached.data)) {
    return { dashboard: cached.data, fromCache: true };
  }
  const dashboard = await fetchPropertyDashboard({ address, includeComponents: false });
  if (dashboard) {
    cacheAttomData(address, dashboard).catch(() => {});
  }
  return { dashboard, fromCache: false };
}

/**
 * ATTOM uses mixed casing: assdTtlValue, assdttlvalue, assdTotalValue, assessedValueTotal.
 */
function extractAssessedFromAssessment(assessment = {}) {
  const assessed = assessment.assessed || {};
  const tax = assessment.tax || {};
  const calculations = assessment.calculations || {};
  return num(
    assessed.assdTtlValue
    || assessed.assdttlvalue
    || assessed.assdTotalValue
    || assessed.assessedValueTotal
    || assessed.value
    || assessment.assdTtlValue
    || assessment.assdttlvalue
    || assessment.assdTotalValue
    || assessment.assessedValueTotal
    || calculations.calcTtlValue
    || calculations.calcttlvalue
    || tax.assessedValueTotal
    || tax.assdTotalValue
    || tax.assdTtlValue,
  );
}

function extractAssessedFromProp(prop) {
  return extractAssessedFromAssessment(prop?.assessment || {});
}

function extractTaxFromProp(prop) {
  const tax = prop?.assessment?.tax || {};
  return num(tax.taxAmt || tax.taxamt || prop?.assessment?.taxAmt);
}

function extractMarketFromProp(prop) {
  const market = prop?.assessment?.market || {};
  return num(market.mktTtlValue || market.mktttlvalue || market.mktTotalValue);
}

function inferStateFromAddress(address) {
  const match = String(address || '').match(/,\s*([A-Z]{2})\s+\d{5}/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Live assessment/detail when cached dashboard lacks assessed value (common on older caches).
 * Results are cached so Prestwick-style properties don't re-burn ATTOM on every lookup.
 */
async function fetchSubjectAssessment(address, { skipCache = false } = {}) {
  if (!ATTOM_API_KEY || !address) return null;

  const cacheKey = hashCacheKey({ v: 1, kind: 'subject_assessment', address: address.toLowerCase() });
  if (!skipCache) {
    const cached = await getCachedDoc(CACHE_COLLECTION, cacheKey, CACHE_TTL_HOURS);
    if (cached?.data?.assessed > 0) {
      return { ...cached.data, fromCache: true };
    }
  }

  try {
    const url = `${ATTOM_BASE}/assessment/detail?address=${encodeURIComponent(address)}`;
    const response = await fetchAttom(url, {
      headers: ATTOM_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const prop = data?.property?.[0] || data?.property || {};
    const assessment = prop.assessment || {};
    const result = {
      assessed: extractAssessedFromAssessment(assessment),
      taxAmount: extractTaxFromProp(prop),
      marketValue: extractMarketFromProp(prop),
      taxYear: num(assessment.tax?.taxYear || assessment.tax?.taxyear),
      fips: prop.identifier?.fips || null,
      latitude: num(prop.location?.latitude),
      longitude: num(prop.location?.longitude),
      sqft: num(prop.building?.size?.livingSize || prop.building?.size?.livingsize),
      yearBuilt: num(prop.summary?.yearBuilt || prop.summary?.yearbuilt),
      propertyType: prop.summary?.propertyType || prop.summary?.propclass || null,
      beds: num(prop.building?.rooms?.beds),
      baths: num(prop.building?.rooms?.bathsTotal || prop.building?.rooms?.bathstotal),
    };

    if (result.assessed > 0) {
      setCachedDoc(CACHE_COLLECTION, cacheKey, result, {
        kind: 'subject_assessment',
        address,
      }).catch(() => {});
    }
    return result;
  } catch (error) {
    console.warn('[TaxOverAssessment] assessment/detail failed:', error.message);
    return null;
  }
}

/**
 * Fill missing assessed_total on tax history rows from assessmenthistory/detail.
 */
async function fetchAssessmentHistoryRows(address, { skipCache = false } = {}) {
  if (!ATTOM_API_KEY || !address) return [];

  const cacheKey = hashCacheKey({ v: 1, kind: 'assessment_history', address: address.toLowerCase() });
  if (!skipCache) {
    const cached = await getCachedDoc(CACHE_COLLECTION, cacheKey, CACHE_TTL_HOURS);
    if (Array.isArray(cached?.data?.rows) && cached.data.rows.length) {
      return cached.data.rows;
    }
  }

  try {
    const url = `${ATTOM_BASE}/assessmenthistory/detail?address=${encodeURIComponent(address)}`;
    const response = await fetchAttom(url, {
      headers: ATTOM_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const hist = data?.property?.[0]?.assessmenthistory || [];
    const rows = hist.map((row) => ({
      year: num(row.tax?.taxYear || row.tax?.taxYearAssessed || row.tax?.assessorYear),
      tax_amount: num(row.tax?.taxAmt),
      assessed_total: num(
        row.assessed?.assdTtlValue
        || row.assessed?.assdttlvalue
        || row.assessed?.assdTotalValue
        || row.calculations?.calcTtlValue,
      ),
    })).filter((row) => row.year != null);

    if (rows.length) {
      setCachedDoc(CACHE_COLLECTION, cacheKey, { rows }, {
        kind: 'assessment_history',
        address,
      }).catch(() => {});
    }
    return rows;
  } catch (error) {
    console.warn('[TaxOverAssessment] assessmenthistory failed:', error.message);
    return [];
  }
}

/**
 * Patch an existing ATTOM dashboard cache with assessed value / tax history so
 * future tax lookups (and other features) reuse it instead of re-calling ATTOM.
 */
async function backfillAttomDashboardCache(address, dashboard, {
  assessed,
  taxAmount,
  taxHistory,
} = {}) {
  if (!dashboard?.summary || !(assessed > 0)) return;
  if (num(dashboard.summary.assessed_value) > 0
    && Array.isArray(dashboard.tax_history)
    && dashboard.tax_history.some((row) => num(row.assessed_total) > 0)) {
    return;
  }

  const patched = {
    ...dashboard,
    summary: {
      ...dashboard.summary,
      assessed_value: num(dashboard.summary.assessed_value) > 0
        ? dashboard.summary.assessed_value
        : assessed,
      tax_current: num(dashboard.summary.tax_current) > 0
        ? dashboard.summary.tax_current
        : (taxAmount || dashboard.summary.tax_current),
    },
    tax_history: Array.isArray(taxHistory) && taxHistory.length
      ? taxHistory
      : (dashboard.tax_history || []),
  };

  cacheAttomData(address, patched, dashboard.summary?.attom_id).catch(() => {});
}

/**
 * Nearby properties with assessed values from ATTOM expandedprofile.
 */
async function fetchNearbyAssessedComps({ latitude, longitude, radiusMiles = 3 }) {
  if (!ATTOM_API_KEY || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return [];
  }

  const cacheKey = hashCacheKey({
    v: 2, // bumped: assdTtlValue field mapping
    kind: 'nearby_assessed',
    lat: round(latitude, 4),
    lng: round(longitude, 4),
    radius: radiusMiles,
  });
  const cached = await getCachedDoc(CACHE_COLLECTION, `nearby_${cacheKey}`, CACHE_TTL_HOURS);
  if (cached?.data?.comps?.length) {
    return cached.data.comps;
  }

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    radius: String(radiusMiles),
    pagesize: '100',
    orderby: 'distance',
  });

  try {
    const response = await fetchAttom(`${ATTOM_BASE}/property/expandedprofile?${params}`, {
      headers: ATTOM_HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return [];

    const data = await response.json();
    const properties = Array.isArray(data.property) ? data.property : [];

    const comps = properties.map((prop) => {
      const address = prop.address?.oneLine || null;
      const building = prop.building || {};
      const size = building.size || {};
      const rooms = building.rooms || {};
      const summary = prop.summary || {};
      const location = prop.location || {};
      const assessed = extractAssessedFromProp(prop);
      const sqft = num(size.livingSize || size.livingsize || size.universalSize || size.universalsize);
      const yearBuilt = num(summary.yearBuilt || summary.yearbuilt);
      const lat = num(location.latitude);
      const lng = num(location.longitude);
      let distanceMiles = num(location.distance || prop.location?.distance);
      if (distanceMiles == null && Number.isFinite(lat) && Number.isFinite(lng)) {
        distanceMiles = round(haversineMiles(latitude, longitude, lat, lng), 2);
      }

      return {
        address,
        assessed,
        sqft,
        yearBuilt,
        beds: num(rooms.beds || rooms.bedsTotal),
        baths: num(rooms.bathstotal || rooms.bathsTotal || rooms.bathsFull),
        propertyType: summary.propertyType || summary.propclass || null,
        latitude: lat,
        longitude: lng,
        distanceMiles,
        fips: prop.identifier?.fips || null,
        sameJurisdiction: true,
        taxAmount: extractTaxFromProp(prop),
        marketValue: extractMarketFromProp(prop),
        attomId: prop.identifier?.attomId || prop.identifier?.id || null,
      };
    }).filter((c) => c.address && c.assessed > 0 && c.sqft > 0);

    setCachedDoc(CACHE_COLLECTION, `nearby_${cacheKey}`, { comps }, {
      kind: 'nearby_assessed_comps',
    }).catch(() => {});

    return comps;
  } catch (error) {
    console.warn('[TaxOverAssessment] Nearby comps failed:', error.message);
    return [];
  }
}

async function attachCompMarketValues(comps, subjectMv, subjectSqft, {
  maxAvmFetches = 12,
  skipCache = false,
} = {}) {
  const sorted = [...comps].sort((a, b) => (a.distanceMiles || 99) - (b.distanceMiles || 99));
  const withMv = [];
  let avmFetches = 0;

  for (const comp of sorted) {
    let mvEst = null;
    let mvSource = null;

    // Prefer market value already on the expandedprofile roll — no extra ATTOM call.
    if (num(comp.marketValue) > 0) {
      mvEst = num(comp.marketValue);
      mvSource = 'attom_market_roll';
    }

    if (!(mvEst > 0) && avmFetches < maxAvmFetches && comp.address) {
      try {
        const avm = await fetchAttomAVM({ address: comp.address, skipCache });
        avmFetches += avm?.fromCache ? 0 : 1;
        mvEst = num(avm?.value);
        if (mvEst > 0) mvSource = avm?.fromCache ? 'attom_avm_cache' : 'attom_avm';
      } catch {
        mvEst = null;
      }
    }

    if (!(mvEst > 0) && subjectMv > 0 && comp.sqft > 0 && subjectSqft > 0) {
      mvEst = round(subjectMv * (comp.sqft / subjectSqft));
      mvSource = 'sqft_scaled_subject_mv';
    }

    if (mvEst > 0) {
      withMv.push({ ...comp, mvEst, mv: mvEst, mvSource });
    }
  }

  return withMv;
}

function detectRecentSaleOrRenovation(dashboard) {
  const sale = dashboard?.sales_history?.[0];
  if (!sale?.sale_date) return false;
  const saleDate = new Date(sale.sale_date);
  if (!Number.isFinite(saleDate.getTime())) return false;
  const months = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return months <= 18;
}

function timeAdjustedSale(dashboard) {
  const sale = dashboard?.sales_history?.[0];
  const price = num(sale?.sale_price);
  const date = sale?.sale_date ? new Date(sale.sale_date) : null;
  if (!(price > 0) || !date || !Number.isFinite(date.getTime())) return null;
  const years = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (years > 3) return null;
  return round(price);
}

function mergeTaxHistory(existing = [], fresh = []) {
  const byYear = new Map();
  for (const row of [...existing, ...fresh]) {
    const year = num(row.year);
    if (year == null) continue;
    const prev = byYear.get(year) || {};
    byYear.set(year, {
      year,
      tax_amount: num(row.tax_amount) ?? num(prev.tax_amount),
      assessed_total: num(row.assessed_total) ?? num(prev.assessed_total),
    });
  }
  return [...byYear.values()].sort((a, b) => b.year - a.year);
}

/**
 * Full analysis for an address (or pre-hydrated lead fields).
 */
export async function analyzePropertyTaxOverAssessment(options = {}) {
  const address = String(options.address || options.lead?.address || '').trim();
  if (!address) {
    return { ok: false, error: 'missing_address' };
  }

  const skipCache = options.skipCache === true;
  const cacheKey = hashCacheKey({ v: 2, address: address.toLowerCase() });

  if (!skipCache) {
    const cached = await getCachedDoc(CACHE_COLLECTION, cacheKey, CACHE_TTL_HOURS);
    if (cached?.data?.analysis?.assessed_value > 0) {
      // Heal older ATTOM dashboard caches that omitted assessed_value — no new ATTOM calls.
      try {
        const { dashboard } = await loadAttomDashboard(address);
        if (dashboard && !(num(dashboard.summary?.assessed_value) > 0)) {
          await backfillAttomDashboardCache(address, dashboard, {
            assessed: cached.data.analysis.assessed_value,
            taxAmount: cached.data.analysis.inputs_log?.taxAmount
              || (cached.data.analysis.effective_tax_rate && cached.data.analysis.assessed_value
                ? cached.data.analysis.assessed_value * cached.data.analysis.effective_tax_rate
                : null),
            taxHistory: cached.data.analysis.inputs_log?.taxHistory || dashboard.tax_history,
          });
        }
      } catch {
        // non-fatal
      }

      return {
        ok: true,
        fromCache: true,
        analysis: cached.data.analysis,
        leadFields: toLeadTaxFields(cached.data.analysis),
      };
    }
  }

  const lead = options.lead || {};
  const { dashboard } = await loadAttomDashboard(address);
  if (!dashboard?.summary && !lead.assessedValue) {
    return { ok: false, error: 'attom_dashboard_unavailable' };
  }

  const summary = dashboard?.summary || {};
  let taxHistory = dashboard?.tax_history || [];
  const latestTax = taxHistory[0] || null;

  let assessed = num(
    lead.assessedValue
    || summary.assessed_value
    || latestTax?.assessed_total,
  );
  let taxAmount = num(latestTax?.tax_amount || summary.tax_current || summary.tax_amount);
  let sqft = num(lead.sqft || summary.living_sqft || summary.square_footage);
  let yearBuilt = num(lead.yearBuilt || summary.year_built);
  let latitude = num(lead.latitude || summary.latitude);
  let longitude = num(lead.longitude || summary.longitude);
  let state = lead.state || summary.state || inferStateFromAddress(address);
  let fips = lead.fips || summary.fips || null;
  let propertyType = lead.propertyType || summary.property_type || null;
  let beds = num(lead.beds || summary.beds);
  let baths = num(lead.baths || summary.baths);

  // Older ATTOM dashboard caches often omit assessed_value — pull assessment/detail once, then backfill.
  let subjectAssessment = null;
  if (!(assessed > 0) || !taxHistory.some((row) => num(row.assessed_total) > 0)) {
    subjectAssessment = await fetchSubjectAssessment(address, { skipCache });
    if (subjectAssessment?.assessed > 0) assessed = subjectAssessment.assessed;
    if (!(taxAmount > 0) && subjectAssessment?.taxAmount > 0) taxAmount = subjectAssessment.taxAmount;
    if (!(sqft > 0) && subjectAssessment?.sqft > 0) sqft = subjectAssessment.sqft;
    if (!(yearBuilt > 0) && subjectAssessment?.yearBuilt > 0) yearBuilt = subjectAssessment.yearBuilt;
    if (!Number.isFinite(latitude) && subjectAssessment?.latitude) latitude = subjectAssessment.latitude;
    if (!Number.isFinite(longitude) && subjectAssessment?.longitude) longitude = subjectAssessment.longitude;
    if (!fips && subjectAssessment?.fips) fips = subjectAssessment.fips;
    if (!propertyType && subjectAssessment?.propertyType) propertyType = subjectAssessment.propertyType;
    if (!(beds > 0) && subjectAssessment?.beds) beds = subjectAssessment.beds;
    if (!(baths > 0) && subjectAssessment?.baths) baths = subjectAssessment.baths;
  }

  if (!taxHistory.some((row) => num(row.assessed_total) > 0)) {
    const historyRows = await fetchAssessmentHistoryRows(address, { skipCache });
    taxHistory = mergeTaxHistory(taxHistory, historyRows);
  }

  // Persist assessed into the existing ATTOM dashboard cache so Prestwick-style
  // properties don't keep re-fetching assessment/detail on every feature.
  if (dashboard && assessed > 0) {
    try {
      await backfillAttomDashboardCache(address, dashboard, { assessed, taxAmount, taxHistory });
    } catch {
      // non-fatal
    }
  }

  let rentcast = null;
  try {
    rentcast = await getValueEstimate({
      address,
      propertyType,
      bedrooms: beds,
      bathrooms: baths,
      squareFootage: sqft,
      compCount: 10,
    });
  } catch (error) {
    console.warn('[TaxOverAssessment] RentCast value failed:', error.message);
  }

  const attomAvm = num(summary.avm_value);
  const attomAvmLow = num(summary.avm_low);
  const attomAvmHigh = num(summary.avm_high);

  let avmFallback = null;
  if (!attomAvm) {
    try {
      avmFallback = await fetchAttomAVM({ address });
    } catch {
      avmFallback = null;
    }
  }

  const marketValueEstimators = {
    attomAvm: attomAvm || num(avmFallback?.value),
    attomAvmLow: attomAvmLow || num(avmFallback?.low),
    attomAvmHigh: attomAvmHigh || num(avmFallback?.high),
    attomAvmConfidence: summary.avm_confidence || null,
    rentcastEstimate: num(rentcast?.estimate),
    rentcastLow: num(rentcast?.estimateLow),
    rentcastHigh: num(rentcast?.estimateHigh),
    salePriceTimeAdjusted: timeAdjustedSale(dashboard),
  };

  const subjectMv = num(marketValueEstimators.attomAvm)
    || num(marketValueEstimators.rentcastEstimate)
    || num(subjectAssessment?.marketValue)
    || assessed;

  let nearby = await fetchNearbyAssessedComps({ latitude, longitude, radiusMiles: 3 });
  const subjectStreet = address.toLowerCase().split(',')[0].trim();
  nearby = nearby.filter((c) => {
    const compStreet = String(c.address || '').toLowerCase().split(',')[0].trim();
    return compStreet !== subjectStreet;
  });

  if (fips) {
    const sameFips = nearby.filter((c) => !c.fips || String(c.fips) === String(fips));
    if (sameFips.length >= 5) nearby = sameFips;
  }

  const comps = await attachCompMarketValues(nearby, subjectMv, sqft, {
    maxAvmFetches: options.maxCompAvms ?? 10,
    skipCache,
  });

  const analysis = analyzeOverAssessment({
    state,
    fips,
    subject: {
      address,
      assessedValue: assessed,
      taxAmount,
      sqft,
      yearBuilt,
      propertyType,
      beds,
      baths,
      state,
      fips,
      taxHistory,
    },
    marketValueEstimators,
    comps,
    recentSaleOrRenovation: detectRecentSaleOrRenovation(dashboard),
    homesteadCreditActive: options.homesteadCreditActive === true,
  });

  const payload = { analysis, address, generatedAt: analysis.generated_at };
  setCachedDoc(CACHE_COLLECTION, cacheKey, payload, {
    kind: 'tax_over_assessment',
    address,
    flag: analysis.flag,
  }).catch(() => {});

  return {
    ok: true,
    fromCache: false,
    analysis,
    leadFields: toLeadTaxFields(analysis),
  };
}

/**
 * Lightweight entry for absentee lead enrichment (uses lead fields + cached APIs).
 */
export async function enrichLeadTaxOverAssessment(lead, options = {}) {
  if (!lead?.address) return null;
  try {
    const result = await analyzePropertyTaxOverAssessment({
      address: lead.address,
      lead,
      maxCompAvms: options.maxCompAvms ?? 8,
      skipCache: options.skipCache,
      homesteadCreditActive: false,
    });
    if (!result.ok) return null;
    return {
      ...result.leadFields,
      taxOverAssessment: result.analysis,
    };
  } catch (error) {
    console.warn('[TaxOverAssessment] Lead enrich failed:', error.message);
    return null;
  }
}
