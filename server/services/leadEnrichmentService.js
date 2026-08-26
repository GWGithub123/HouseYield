/**
 * Enrich absentee owner leads with RentCast rental confidence and leak risk scoring.
 */

import {
  getRentEstimate,
  getRentalListingComparables,
  getRentalListingByAddress,
  getRentalListingHistoryByAddress,
  getPropertyRecordByAddress,
  geocodeLocation,
  haversineMiles,
} from '../rentcast.js';
import { isRentcastLimitError } from '../rentcast-usage-limiter.js';
import { getCachedDoc, setCachedDoc, hashCacheKey } from '../firestore-doc-cache.js';
import { fetchAttom } from '../attom-usage-limiter.js';
import { enrichLeadTaxOverAssessment } from './taxOverAssessmentService.js';

const ENRICHMENT_CACHE_COLLECTION = 'lead_enrichment_cache';
const ENRICHMENT_TTL_HOURS = 24 * 30;
const PLUMBING_KEYWORDS = /plumb|pipe|water|sewer|mold|leak|flood|mitigation|supply/i;
const ATTOM_API_KEY = process.env.ATTOM_API_KEY || '';
const ATTOM_BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const ATTOM_HEADERS = { accept: 'application/json', apikey: ATTOM_API_KEY };

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeAddressKey(lead) {
  return String(lead.attomId || lead.address || '').trim().toLowerCase();
}

function computeGrossYield(monthlyRent, propertyValue) {
  const rent = Number(monthlyRent);
  const value = Number(propertyValue);
  if (!Number.isFinite(rent) || rent <= 0 || !Number.isFinite(value) || value <= 0) return null;
  return Number(((rent * 12) / value * 100).toFixed(2));
}

function rentalConfidenceLabel(score, { listedForRent = false } = {}) {
  if (listedForRent) return 'listed_for_rent';
  if (score >= 70) return 'likely_rental';
  if (score >= 45) return 'possible_rental';
  return 'unlikely_rental';
}

function leakRiskLabel(score) {
  if (score >= 65) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

function ownerDistanceBand(miles) {
  if (!Number.isFinite(miles)) return 'unknown';
  if (miles >= 500 || miles === Infinity) return 'out_of_state_far';
  if (miles >= 50) return 'remote_50plus';
  if (miles >= 15) return 'nearby_remote';
  return 'local';
}

async function resolveOwnerDistance(lead) {
  const existingMiles = Number(lead.ownerDistanceMiles);
  if (Number.isFinite(existingMiles) && existingMiles >= 0) {
    return {
      ownerDistanceMiles: Math.round(existingMiles),
      ownerDistanceBand: lead.ownerDistanceBand || ownerDistanceBand(existingMiles),
    };
  }

  const propLat = Number(lead.latitude);
  const propLng = Number(lead.longitude);
  const mailing = lead.owner?.mailingAddress;
  if (!mailing || !Number.isFinite(propLat) || !Number.isFinite(propLng)) {
    return { ownerDistanceMiles: null, ownerDistanceBand: 'unknown' };
  }

  // Same-city mailing with no geocode yet — still try geocode for accuracy.
  try {
    const geo = await geocodeLocation(mailing);
    const mailLat = Number(geo?.location?.lat);
    const mailLng = Number(geo?.location?.lng);
    if (!Number.isFinite(mailLat) || !Number.isFinite(mailLng)) {
      return { ownerDistanceMiles: null, ownerDistanceBand: 'unknown' };
    }
    const miles = haversineMiles(propLat, propLng, mailLat, mailLng);
    return {
      ownerDistanceMiles: Math.round(miles),
      ownerDistanceBand: ownerDistanceBand(miles),
    };
  } catch (error) {
    console.warn('[LeadEnrichment] Owner distance geocode failed:', error.message);
    // Fallback: out-of-state without miles still counts as remote.
    if (lead.isOutOfState) {
      return { ownerDistanceMiles: null, ownerDistanceBand: 'out_of_state_far' };
    }
    return { ownerDistanceMiles: null, ownerDistanceBand: 'unknown' };
  }
}

async function fetchPlumbingPermitSignals(address) {
  if (!ATTOM_API_KEY || !address) {
    return { plumbingPermitCount: 0, recentPlumbingPermit: false, permitSignals: [] };
  }

  try {
    const url = `${ATTOM_BASE}/property/buildingpermits?address=${encodeURIComponent(address)}`;
    const response = await fetchAttom(url, { headers: ATTOM_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      return { plumbingPermitCount: 0, recentPlumbingPermit: false, permitSignals: [] };
    }

    const data = await response.json();
    const property = data?.property?.[0] || data?.property || {};
    const permits = property.buildingpermits
      || property.buildingPermits
      || property.permits
      || property.permit
      || [];

    const permitArray = Array.isArray(permits) ? permits : [permits].filter(Boolean);
    const tenYearsAgo = new Date();
    tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);

    const plumbingPermits = permitArray.filter((permit) => {
      const text = [
        permit.worktype,
        permit.workType,
        permit.description,
        permit.permitdescription,
        permit.type,
      ].filter(Boolean).join(' ');
      return PLUMBING_KEYWORDS.test(text);
    });

    const recentPlumbingPermit = plumbingPermits.some((permit) => {
      const dateValue = permit.effectivedate || permit.effectiveDate || permit.permitdate || permit.permitDate;
      if (!dateValue) return false;
      const permitDate = new Date(dateValue);
      return Number.isFinite(permitDate.getTime()) && permitDate >= tenYearsAgo;
    });

    return {
      plumbingPermitCount: plumbingPermits.length,
      recentPlumbingPermit,
      permitSignals: recentPlumbingPermit
        ? ['Recent plumbing permit on record']
        : plumbingPermits.length
          ? [`${plumbingPermits.length} plumbing-related permit(s) on record`]
          : [],
    };
  } catch (error) {
    console.warn('[LeadEnrichment] Permit lookup failed:', error.message);
    return { plumbingPermitCount: 0, recentPlumbingPermit: false, permitSignals: [] };
  }
}

function scoreRentalConfidence(lead, rentEstimate, listingMatch, propertyRecord = null, extras = {}) {
  // Absentee + different mailing address is already a strong rental signal for SFR
  // near campus markets. Start higher than a bare "unknown occupancy" baseline.
  let score = 35;
  const signals = ['Absentee owner (mailing address differs from property)'];
  const listedForRent = !!(listingMatch?.matched && listingMatch?.addressLevel);
  const listingHistory = extras.listingHistory || null;
  const ownerDistanceMiles = extras.ownerDistanceMiles;
  const ownerDistanceBandValue = extras.ownerDistanceBand || ownerDistanceBand(ownerDistanceMiles);
  const portfolioCount = Number(lead.ownerPortfolioCount);
  const portfolioBand = lead.ownerPortfolioBand || null;

  // Definitive marketing signal: active rental listing at this exact address.
  if (listedForRent) {
    score = Math.max(score, 92);
    signals.unshift(listingMatch.reason || 'Active RentCast rental listing at this address');
    if (listingMatch.listedRent) {
      signals.push(`Listed rent $${Math.round(listingMatch.listedRent).toLocaleString()}/mo`);
    }
  } else if (listingMatch?.matched) {
    score += 25;
    signals.push(listingMatch.reason);
  }

  // Historical listing — confirms rental even when not currently marketed.
  if (!listedForRent && listingHistory?.listedInLast90Days) {
    score = Math.max(score, 85);
    signals.unshift('RentCast rental listing in last 90 days (recent turnover / vacancy window)');
    if (listingHistory.lastListedRent) {
      signals.push(`Last listed rent $${Math.round(listingHistory.lastListedRent).toLocaleString()}/mo`);
    }
  } else if (!listedForRent && listingHistory?.listedInLast5Years) {
    score += 30;
    signals.unshift('RentCast rental listing history in last 5 years (confirmed rental)');
  } else if (!listedForRent && listingHistory && listingHistory.everListedForRent === false) {
    score -= 8;
    signals.push('No RentCast rental listing history found — possible second home (deprioritize, don’t discard)');
  }

  if (propertyRecord && propertyRecord.ownerOccupied === false) {
    score += 20;
    signals.push('RentCast ownerOccupied=false (not owner-occupied)');
  } else if (propertyRecord && propertyRecord.ownerOccupied === true) {
    score -= 25;
    signals.push('RentCast ownerOccupied=true (likely owner-occupied / second home)');
  }

  // Owner distance — remote anxious landlord is the wedge.
  if (ownerDistanceBandValue === 'out_of_state_far' || (lead.isOutOfState && ownerDistanceMiles == null)) {
    score += 18;
    signals.push(
      Number.isFinite(ownerDistanceMiles)
        ? `Owner ~${ownerDistanceMiles} miles away (out-of-state / far remote)`
        : `Out-of-state owner (${lead.owner?.mailingState || 'remote'})`,
    );
  } else if (ownerDistanceBandValue === 'remote_50plus') {
    score += 15;
    signals.push(`Owner ~${ownerDistanceMiles} miles away (50+ mile remote landlord)`);
  } else if (ownerDistanceBandValue === 'nearby_remote') {
    score += 6;
    signals.push(`Owner ~${ownerDistanceMiles} miles away`);
  } else if (ownerDistanceBandValue === 'local' && Number.isFinite(ownerDistanceMiles)) {
    signals.push(`Owner only ~${ownerDistanceMiles} miles away (local absentee)`);
  } else if (lead.isOutOfState) {
    score += 15;
    signals.push(`Out-of-state owner (${lead.owner?.mailingState || 'remote'})`);
  }

  // Portfolio band from search-batch ownership linkage.
  if (portfolioBand === '2-15' && Number.isFinite(portfolioCount)) {
    score += 10;
    signals.push(`${portfolioCount}-property portfolio in search (mom-and-pop sweet spot)`);
  } else if (portfolioBand === '16+' && Number.isFinite(portfolioCount)) {
    score -= 10;
    signals.push(`${portfolioCount}-property portfolio in search (professional landlord)`);
  } else if (portfolioBand === '1') {
    signals.push('Single property in search (possible accidental landlord)');
  }

  const monthlyRent = rentEstimate?.estimate ?? rentEstimate?.rentEstimate ?? rentEstimate?.rent
    ?? listingMatch?.listedRent
    ?? listingHistory?.lastListedRent;
  const propertyValue = Number(lead.marketValue || lead.assessedValue) || 0;
  const grossYield = computeGrossYield(monthlyRent, propertyValue);

  if (Number.isFinite(monthlyRent) && monthlyRent > 0 && !listingMatch?.listedRent && !listingHistory?.lastListedRent) {
    score += 15;
    signals.push(`RentCast rent estimate $${Math.round(monthlyRent).toLocaleString()}/mo`);
  } else if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
    signals.push('No RentCast rent estimate yet — score based on ownership/listing signals');
  }

  if (grossYield != null) {
    if (grossYield >= 4 && grossYield <= 14) {
      score += 15;
      signals.push(`Gross yield ${grossYield}% (typical rental range)`);
    } else if (grossYield > 14) {
      score += 8;
      signals.push(`Gross yield ${grossYield}% (high — may be room rental)`);
    } else if (grossYield > 0) {
      score += 4;
      signals.push(`Gross yield ${grossYield}%`);
    }
  }

  const beds = Number(lead.beds || propertyRecord?.bedrooms) || 0;
  if (beds >= 4) {
    score += 10;
    signals.push(`${beds}-bed property (common student rental near campus)`);
  } else if (beds >= 3) {
    score += 5;
    signals.push(`${beds}-bed SFR (common rental size)`);
  }

  const baths = Number(lead.baths || propertyRecord?.bathrooms) || 0;
  if (beds === 0 && baths >= 3) {
    score += 8;
    signals.push(`${baths} baths (high fixture count — likely multi-tenant / rental capacity)`);
  }

  const propertyType = String(lead.propertyType || lead.attomPropertyType || propertyRecord?.propertyType || '').toUpperCase();
  if (propertyType.includes('MFR') || propertyType.includes('MULTI')) {
    score += 15;
    signals.push('Multi-family property type');
  } else if (propertyType.includes('SINGLE') || propertyType.includes('SFR')) {
    score += 5;
    signals.push('Single-family absentee ownership (common landlord pattern)');
  }

  const finalScore = clamp(score, 0, 100);
  return {
    rentalConfidence: finalScore,
    rentalConfidenceLabel: rentalConfidenceLabel(finalScore, { listedForRent }),
    rentalSignals: signals,
    rentEstimate: Number.isFinite(Number(monthlyRent)) ? Math.round(Number(monthlyRent)) : null,
    grossYield,
    listedForRent,
    listingMatch: listingMatch || null,
    ownerOccupied: propertyRecord?.ownerOccupied ?? null,
    rentcastOwnerNames: propertyRecord?.ownerNames || null,
    rentcastMailingAddress: propertyRecord?.mailingAddress || null,
    everListedForRent: listingHistory?.everListedForRent ?? null,
    listedInLast90Days: listingHistory?.listedInLast90Days ?? null,
    listedInLast5Years: listingHistory?.listedInLast5Years ?? null,
    lastListedDate: listingHistory?.lastListedDate ?? null,
    ownerDistanceMiles: Number.isFinite(ownerDistanceMiles) ? ownerDistanceMiles : null,
    ownerDistanceBand: ownerDistanceBandValue,
  };
}

function scoreLeakRisk(lead, rentalConfidence, permitSignals = []) {
  let score = 0;
  const signals = [...permitSignals];

  if (rentalConfidence >= 60) {
    score += 25;
    signals.push('Absentee rental — owner off-site while tenants occupy property');
  } else if (rentalConfidence >= 40) {
    score += 12;
    signals.push('Possible rental occupancy');
  }

  const propertyAge = Number(lead.propertyAge) || (
    lead.yearBuilt ? new Date().getFullYear() - Number(lead.yearBuilt) : 0
  );

  if (propertyAge >= 40) {
    score += 15;
    signals.push(`${propertyAge}-year-old property (aging plumbing systems)`);
  } else if (propertyAge >= 25) {
    score += 10;
    signals.push(`${propertyAge}-year-old property`);
  }

  const beds = Number(lead.beds) || 0;
  if (beds >= 4) {
    score += 10;
    signals.push(`${beds} bedrooms — more fixtures, more leak points`);
  }

  const propertyType = String(lead.propertyType || '').toUpperCase();
  if (propertyType.includes('MFR') || propertyType.includes('MULTI')) {
    score += 10;
    signals.push('Multi-unit property');
  }

  return {
    leakRiskScore: clamp(score, 0, 100),
    leakRiskLabel: leakRiskLabel(clamp(score, 0, 100)),
    leakRiskSignals: signals,
  };
}

function computeProtectionLeadScore(lead, enrichment) {
  const motivation = Number(lead.motivationScore) || 0;
  const rental = Number(enrichment.rentalConfidence) || 0;
  const leak = Number(enrichment.leakRiskScore) || 0;
  const protectionLeadScore = Math.round(motivation * 0.35 + rental * 0.35 + leak * 0.30);
  return clamp(protectionLeadScore, 0, 100);
}

async function findActiveRentalListingMatch(lead) {
  // 1) Strongest: exact-address RentCast rental listing
  if (lead.address) {
    try {
      const addressListing = await getRentalListingByAddress(lead.address, { status: 'Active' });
      if (addressListing?.matched) {
        return {
          matched: true,
          addressLevel: true,
          reason: addressListing.reason,
          listedRent: addressListing.listedRent,
          listedDate: addressListing.listedDate,
          daysOnMarket: addressListing.daysOnMarket,
          listingAgent: addressListing.listingAgent || null,
          listingOffice: addressListing.listingOffice || null,
          listing: addressListing,
        };
      }
    } catch (error) {
      if (isRentcastLimitError(error)) throw error;
      console.warn('[LeadEnrichment] Address listing lookup failed:', error.message);
    }
  }

  // 2) Fallback: nearby comps in ZIP/radius (weaker)
  const latitude = lead.latitude;
  const longitude = lead.longitude;
  const zipCode = lead.zipCode;

  if (!zipCode && !(latitude && longitude)) {
    return { matched: false, addressLevel: false };
  }

  try {
    const result = await getRentalListingComparables({
      zipCode,
      latitude,
      longitude,
      bedrooms: lead.beds,
      bathrooms: lead.baths,
      squareFeet: lead.sqft,
      yearBuilt: lead.yearBuilt,
      propertyType: lead.propertyType,
      limit: 40,
    });

    const street = String(lead.streetAddress || lead.address || '').toLowerCase();
    const streetNumber = street.match(/^\d+/)?.[0];

    for (const listing of result.comparables || []) {
      const listingAddress = String(listing.formattedAddress || '').toLowerCase();
      if (street && listingAddress.includes(street.split(',')[0].trim())) {
        return {
          matched: true,
          addressLevel: false,
          reason: 'Nearby RentCast rental listing matches street address',
          listedRent: listing.price || listing.listedRent || null,
          listing,
        };
      }

      if (
        streetNumber
        && listingAddress.startsWith(streetNumber)
        && listing.distanceMiles != null
        && listing.distanceMiles <= 0.15
        && listing.bedrooms === lead.beds
      ) {
        return {
          matched: true,
          addressLevel: false,
          reason: `Nearby active rental listing (${listing.distanceMiles} mi)`,
          listedRent: listing.price || listing.listedRent || null,
          listing,
        };
      }
    }
  } catch (error) {
    if (isRentcastLimitError(error)) throw error;
    console.warn('[LeadEnrichment] Rental listing match failed:', error.message);
  }

  return { matched: false, addressLevel: false };
}

export async function enrichAbsenteeLead(lead, options = {}) {
  const {
    includeRentcast = true,
    includeLeakRisk = true,
    includePermits = true,
    includeTaxOverAssessment = false,
    skipCache = false,
  } = options;

  const cacheKey = hashCacheKey({
    v: 5,
    attomId: lead.attomId,
    address: lead.address,
    includeRentcast,
    includeLeakRisk,
    includePermits,
    includeTaxOverAssessment,
    portfolio: lead.ownerPortfolioCount ?? null,
  });

  if (!skipCache) {
    const cached = await getCachedDoc(ENRICHMENT_CACHE_COLLECTION, cacheKey, ENRICHMENT_TTL_HOURS);
    if (cached?.data) {
      return { ...cached.data, fromCache: true };
    }
  }

  let rentEstimate = null;
  let listingMatch = { matched: false, addressLevel: false };
  let listingHistory = null;
  let propertyRecord = null;
  let permitData = { plumbingPermitCount: 0, recentPlumbingPermit: false, permitSignals: [] };
  let taxFields = null;
  let distance = {
    ownerDistanceMiles: lead.ownerDistanceMiles ?? null,
    ownerDistanceBand: lead.ownerDistanceBand || 'unknown',
  };

  if (includeRentcast) {
    try {
      // Prefer definitive occupancy signals first (listing + history + ownerOccupied), then AVM.
      const [listingResult, historyResult, recordResult, distanceResult] = await Promise.all([
        findActiveRentalListingMatch(lead),
        getRentalListingHistoryByAddress(lead.address).catch((error) => {
          if (isRentcastLimitError(error)) throw error;
          console.warn('[LeadEnrichment] Listing history failed:', error.message);
          return null;
        }),
        getPropertyRecordByAddress(lead.address).catch((error) => {
          if (isRentcastLimitError(error)) throw error;
          console.warn('[LeadEnrichment] Property record failed:', error.message);
          return null;
        }),
        resolveOwnerDistance(lead),
      ]);
      listingMatch = listingResult;
      listingHistory = historyResult;
      propertyRecord = recordResult;
      distance = distanceResult;

      // Fill missing beds/baths/sqft/year from RentCast property record when ATTOM omitted them.
      if (propertyRecord?.found) {
        if (!lead.beds && propertyRecord.bedrooms) lead.beds = propertyRecord.bedrooms;
        if (!lead.baths && propertyRecord.bathrooms) lead.baths = propertyRecord.bathrooms;
        if (!lead.sqft && propertyRecord.squareFootage) lead.sqft = propertyRecord.squareFootage;
        if (!lead.yearBuilt && propertyRecord.yearBuilt) {
          lead.yearBuilt = propertyRecord.yearBuilt;
          lead.propertyAge = new Date().getFullYear() - propertyRecord.yearBuilt;
        }
      }

      rentEstimate = await getRentEstimate({
        address: lead.address,
        propertyType: lead.propertyType,
        bedrooms: lead.beds,
        bathrooms: lead.baths,
        squareFootage: lead.sqft,
      });
    } catch (error) {
      if (isRentcastLimitError(error)) throw error;
      console.warn('[LeadEnrichment] RentCast failed for', lead.address, error.message);
    }
  } else {
    distance = await resolveOwnerDistance(lead);
  }

  if (includePermits && includeLeakRisk) {
    permitData = await fetchPlumbingPermitSignals(lead.address);
  }

  const rental = scoreRentalConfidence(lead, rentEstimate, listingMatch, propertyRecord, {
    listingHistory,
    ownerDistanceMiles: distance.ownerDistanceMiles,
    ownerDistanceBand: distance.ownerDistanceBand,
  });
  const leak = includeLeakRisk
    ? scoreLeakRisk(lead, rental.rentalConfidence, permitData.permitSignals)
    : { leakRiskScore: 0, leakRiskLabel: 'low', leakRiskSignals: [] };

  if (includeTaxOverAssessment && lead.address) {
    taxFields = await enrichLeadTaxOverAssessment(lead, {
      skipCache,
      maxCompAvms: options.maxTaxCompAvms ?? 6,
    });
  }

  const enrichment = {
    ...rental,
    ...leak,
    plumbingPermitCount: permitData.plumbingPermitCount,
    recentPlumbingPermit: permitData.recentPlumbingPermit,
    ownerPortfolioCount: lead.ownerPortfolioCount ?? null,
    ownerPortfolioBand: lead.ownerPortfolioBand ?? null,
    ...(taxFields || {}),
    protectionLeadScore: computeProtectionLeadScore(lead, {
      rentalConfidence: rental.rentalConfidence,
      leakRiskScore: leak.leakRiskScore,
    }),
    enrichedAt: new Date().toISOString(),
    fromCache: false,
  };

  setCachedDoc(ENRICHMENT_CACHE_COLLECTION, cacheKey, enrichment, {
    attomId: lead.attomId || null,
    address: lead.address || null,
  }).catch(() => {});

  return enrichment;
}

export async function enrichAbsenteeLeads(leads, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
  const sorted = [...leads].sort((a, b) => (b.motivationScore || 0) - (a.motivationScore || 0));
  const targets = sorted.slice(0, limit);
  const enrichedByKey = new Map();
  let enrichmentCacheHits = 0;

  for (const lead of targets) {
    try {
      const enrichment = await enrichAbsenteeLead(lead, options);
      if (enrichment?.fromCache) enrichmentCacheHits += 1;
      enrichedByKey.set(normalizeAddressKey(lead), enrichment);
    } catch (error) {
      if (isRentcastLimitError(error)) {
        console.warn('[LeadEnrichment] RentCast monthly limit reached; returning partial enrichments');
        break;
      }
      console.warn('[LeadEnrichment] Failed for', lead.address, error.message);
    }
  }

  const merged = leads.map((lead) => {
    const enrichment = enrichedByKey.get(normalizeAddressKey(lead));
    if (!enrichment) return lead;
    return {
      ...lead,
      ...enrichment,
    };
  });

  // Keep processed-lead cache warm with enrichment so re-searches skip RentCast/ATTOM work.
  try {
    const { setCachedProcessedLead } = await import('./absenteeSearchCacheService.js');
    for (const lead of merged) {
      if (lead.attomId && enrichedByKey.has(normalizeAddressKey(lead))) {
        setCachedProcessedLead(lead.attomId, lead).catch(() => {});
      }
    }
  } catch {
    // non-fatal
  }

  const sortBy = options.sortBy || 'protectionLeadScore';
  merged.sort((a, b) => (b[sortBy] || b.motivationScore || 0) - (a[sortBy] || a.motivationScore || 0));

  return {
    leads: merged,
    enrichedCount: enrichedByKey.size,
    enrichmentCacheHits,
    limit,
  };
}

export function buildEnrichmentContext(enrichment = {}) {
  const parts = [];
  if (enrichment.listedForRent || enrichment.rentalConfidenceLabel === 'listed_for_rent') {
    parts.push('DEFINITIVE: Active RentCast rental listing at this address (listed for rent)');
  }
  if (enrichment.listedInLast90Days) {
    parts.push('Recent RentCast rental listing in last 90 days (turnover / vacancy window)');
  } else if (enrichment.listedInLast5Years || enrichment.everListedForRent) {
    parts.push('Confirmed rental via RentCast listing history');
  }
  if (enrichment.rentalConfidenceLabel) {
    parts.push(`Rental confidence: ${enrichment.rentalConfidenceLabel} (${enrichment.rentalConfidence}/100)`);
  }
  if (Number.isFinite(enrichment.ownerDistanceMiles)) {
    parts.push(`Owner lives ~${enrichment.ownerDistanceMiles} miles from property`);
  }
  if (enrichment.ownerPortfolioBand === '2-15') {
    parts.push(`Mom-and-pop portfolio band (${enrichment.ownerPortfolioCount} properties in search)`);
  }
  if (enrichment.taxOverAssessmentFlag === 'strong' || enrichment.taxOverAssessmentFlag === 'moderate') {
    parts.push(
      `Tax assessment flagged for review (${enrichment.taxOverAssessmentFlag}): `
      + `equity excess ~${enrichment.taxEquityExcessPct}%`
      + (enrichment.taxAnnualSavingsLow
        ? `, est. annual impact ~$${Number(enrichment.taxAnnualSavingsLow).toLocaleString()}+ (low end)`
        : ''),
    );
    if (enrichment.taxOverAssessmentNarrative) {
      parts.push(enrichment.taxOverAssessmentNarrative);
    }
  }
  if (enrichment.rentalSignals?.length) {
    parts.push(`Signals: ${enrichment.rentalSignals.join('; ')}`);
  }
  if (enrichment.rentEstimate) {
    parts.push(`Est. rent $${enrichment.rentEstimate}/mo`);
  }
  if (enrichment.grossYield != null) {
    parts.push(`Gross yield ${enrichment.grossYield}%`);
  }
  if (enrichment.leakRiskLabel) {
    parts.push(`Leak risk: ${enrichment.leakRiskLabel} (${enrichment.leakRiskScore}/100)`);
  }
  if (enrichment.leakRiskSignals?.length) {
    parts.push(`Risk factors: ${enrichment.leakRiskSignals.join('; ')}`);
  }
  return parts.join('. ');
}
