/**
 * Tax Appeal Brief — assemble appeal-grade evidence from cached ATTOM + RentCast data.
 *
 * Uses assessor roll values (not AVMs) as the number to beat, and recent recorded
 * sale comps (RentCast /avm/value comparables) as primary market evidence.
 */

import { fetchPropertyDashboard } from '../attom.js';
import {
  getCachedAttomData,
  cacheAttomData,
  isUsableAttomDashboardData,
} from '../attom-firestore-cache.js';
import { getValueEstimate } from '../rentcast.js';

const DEFAULT_MAX_COMPS = 5;
const DEFAULT_MAX_SALE_AGE_MONTHS = 18;
const APPEAL_THRESHOLD_PCT = 10;

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function monthsBetween(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return null;
  return (now.getFullYear() - parsed.getFullYear()) * 12 + (now.getMonth() - parsed.getMonth());
}

function compSaleDate(comp) {
  return comp.removedDate || comp.listedDate || null;
}

function scoreComparable(subject, comp) {
  let score = 100;
  const subjectSqft = num(subject.sqft);
  const compSqft = num(comp.squareFootage);
  const subjectBeds = num(subject.beds);
  const compBeds = num(comp.bedrooms);
  const subjectBaths = num(subject.baths);
  const compBaths = num(comp.bathrooms);
  const subjectYear = num(subject.yearBuilt);
  const compYear = num(comp.yearBuilt);

  if (subjectSqft && compSqft) {
    score -= Math.min(Math.abs(compSqft - subjectSqft) / subjectSqft * 80, 35);
  }
  if (subjectBeds != null && compBeds != null) {
    score -= Math.min(Math.abs(compBeds - subjectBeds) * 12, 24);
  }
  if (subjectBaths != null && compBaths != null) {
    score -= Math.min(Math.abs(compBaths - subjectBaths) * 10, 20);
  }
  if (subjectYear && compYear) {
    score -= Math.min(Math.abs(compYear - subjectYear) / 2, 20);
  }
  if (num(comp.distance) != null) {
    score -= Math.min(num(comp.distance) * 5, 25);
  }

  const ageMonths = monthsBetween(compSaleDate(comp));
  if (ageMonths != null) {
    if (ageMonths > 24) score -= 30;
    else if (ageMonths > 18) score -= 20;
    else if (ageMonths > 12) score -= 10;
  } else {
    score -= 15;
  }

  return Math.max(score, 1);
}

function extractAssessedValue(dashboard) {
  const summary = dashboard?.summary || {};
  const direct = num(summary.assessed_value ?? summary.assessedValue);
  if (direct) return { value: direct, source: 'summary.assessed_value' };

  const latestTax = dashboard?.tax_history?.[0];
  const fromHistory = num(latestTax?.assessed_total ?? latestTax?.assessedTotal);
  if (fromHistory) return { value: fromHistory, source: 'tax_history.assessed_total' };

  return { value: null, source: null };
}

function extractSubject(dashboard, address) {
  const summary = dashboard?.summary || {};
  return {
    address: summary.address || address,
    attomId: summary.attom_id || null,
    zipCode: summary.zip || null,
    city: summary.city || null,
    state: summary.state || null,
    beds: num(summary.beds),
    baths: num(summary.baths),
    sqft: num(summary.living_sqft ?? summary.square_footage),
    yearBuilt: num(summary.year_built),
    propertyType: summary.property_type || null,
    latitude: num(summary.latitude),
    longitude: num(summary.longitude),
  };
}

function buildFactualIssues(subject, dashboard) {
  const issues = [];
  const summary = dashboard?.summary || {};

  if (!num(subject.sqft)) {
    issues.push({
      type: 'missing_data',
      severity: 'info',
      message: 'Living area (sqft) not found — verify against assessor property card before filing.',
    });
  }

  const lastSale = dashboard?.sales_history?.[0];
  if (lastSale?.sale_price && num(summary.avm_value)) {
    const gapPct = ((num(summary.avm_value) - lastSale.sale_price) / lastSale.sale_price) * 100;
    if (gapPct > 25) {
      issues.push({
        type: 'market_shift',
        severity: 'moderate',
        message: `Last recorded sale (${lastSale.sale_date}: $${Math.round(lastSale.sale_price).toLocaleString()}) is materially below current AVM — market decline or condition change may support lower assessment.`,
        lastSaleDate: lastSale.sale_date,
        lastSalePrice: lastSale.sale_price,
      });
    }
  }

  return issues;
}

function rankAppealStrength({ overAssessmentPct, compCount, spreadPct }) {
  if (!compCount || compCount < 3) return 'insufficient';
  if (overAssessmentPct >= 15 && spreadPct != null && spreadPct < 20) return 'high';
  if (overAssessmentPct >= APPEAL_THRESHOLD_PCT) return 'medium';
  if (overAssessmentPct >= 5) return 'low';
  return 'insufficient';
}

async function loadAttomDashboard(address) {
  const cached = await getCachedAttomData(address);
  if (cached?.data && isUsableAttomDashboardData(cached.data)) {
    return { dashboard: cached.data, fromCache: true, stale: Boolean(cached.stale) };
  }

  const dashboard = await fetchPropertyDashboard({ address, includeComponents: false });
  if (dashboard) {
    cacheAttomData(address, dashboard).catch(() => {});
  }
  return { dashboard, fromCache: false, stale: false };
}

/**
 * @param {object} options
 * @param {string} options.address
 * @param {number} [options.maxComps]
 * @param {number} [options.maxSaleAgeMonths]
 * @param {boolean} [options.skipRentcast]
 */
export async function buildTaxAppealBrief(options = {}) {
  const address = String(options.address || '').trim();
  if (!address) {
    return { ok: false, error: 'missing_address' };
  }

  const maxComps = Math.min(Math.max(Number(options.maxComps) || DEFAULT_MAX_COMPS, 3), 8);
  const maxSaleAgeMonths = Math.min(Math.max(Number(options.maxSaleAgeMonths) || DEFAULT_MAX_SALE_AGE_MONTHS, 6), 36);

  const { dashboard, fromCache, stale } = await loadAttomDashboard(address);
  if (!dashboard?.summary) {
    return { ok: false, error: 'attom_dashboard_unavailable' };
  }

  const subject = extractSubject(dashboard, address);
  const assessed = extractAssessedValue(dashboard);
  const latestTaxRow = dashboard.tax_history?.[0] || null;
  const taxAmount = num(latestTaxRow?.tax_amount ?? dashboard.summary?.tax_amount ?? dashboard.summary?.tax_current);
  const taxYear = latestTaxRow?.year || null;

  const effectiveTaxRate = assessed.value && taxAmount
    ? round(taxAmount / assessed.value, 5)
    : null;

  let valueAvm = null;
  let rentcastError = null;
  if (options.skipRentcast !== true) {
    try {
      valueAvm = await getValueEstimate({
        address,
        propertyType: subject.propertyType,
        bedrooms: subject.beds,
        bathrooms: subject.baths,
        squareFootage: subject.sqft,
        compCount: 15,
      });
    } catch (error) {
      rentcastError = error.message;
    }
  }

  const rawComps = (valueAvm?.comparables || [])
    .filter((comp) => num(comp.price) > 10_000)
    .map((comp) => {
      const saleDate = compSaleDate(comp);
      const ageMonths = monthsBetween(saleDate);
      return {
        address: comp.formattedAddress,
        saleDate,
        salePrice: num(comp.price),
        bedrooms: num(comp.bedrooms),
        bathrooms: num(comp.bathrooms),
        squareFootage: num(comp.squareFootage),
        yearBuilt: num(comp.yearBuilt),
        distanceMiles: num(comp.distance),
        pricePerSqft: num(comp.squareFootage) > 0 ? round(num(comp.price) / num(comp.squareFootage), 0) : null,
        correlation: num(comp.correlation),
        ageMonths,
        compScore: scoreComparable(subject, comp),
        source: 'RentCast recorded sale comp',
        evidenceNote: 'Verify sale date and price against county recorder / assessor records before filing.',
      };
    })
    .filter((comp) => comp.ageMonths == null || comp.ageMonths <= maxSaleAgeMonths)
    .sort((a, b) => b.compScore - a.compScore);

  const comparables = rawComps.slice(0, maxComps);
  const compPrices = comparables.map((c) => c.salePrice).filter(Number.isFinite);
  const compMedian = median(compPrices);
  const compPpsfValues = comparables
    .map((c) => c.pricePerSqft)
    .filter(Number.isFinite);
  const compMedianPpsf = median(compPpsfValues);
  const compImpliedValue = compMedianPpsf && subject.sqft
    ? round(compMedianPpsf * subject.sqft)
    : compMedian;

  const opinionOfValue = compImpliedValue || compMedian;
  const overAssessmentAmount = assessed.value && opinionOfValue
    ? round(assessed.value - opinionOfValue)
    : null;
  const overAssessmentPct = assessed.value && opinionOfValue
    ? round((overAssessmentAmount / opinionOfValue) * 100, 1)
    : null;

  const annualSavings = overAssessmentAmount && effectiveTaxRate
    ? round(overAssessmentAmount * effectiveTaxRate)
    : null;
  const monthlySavings = annualSavings != null ? round(annualSavings / 12) : null;

  const compSpreadPct = compPrices.length >= 2 && compMedian
    ? round(((Math.max(...compPrices) - Math.min(...compPrices)) / compMedian) * 100, 1)
    : null;

  const appealStrength = rankAppealStrength({
    overAssessmentPct: overAssessmentPct || 0,
    compCount: comparables.length,
    spreadPct: compSpreadPct,
  });

  const disclaimers = [
    'This brief is for research and packet preparation — not legal or appraisal advice.',
    'Assessors and review boards require verified arm\'s-length comparable sales; confirm each comp against county recorder or assessor records.',
    'Automated valuations (ATTOM AVM, RentCast estimate) are not acceptable as standalone appeal evidence.',
    'Appeal deadlines, lien dates, and comp recency rules vary by jurisdiction — verify locally before filing.',
  ];

  const nextSteps = [
    'Download your assessor property record card and check beds, baths, sqft, and condition.',
    'Verify each comparable sale date and price on the county assessor or recorder site.',
    'Photograph deferred maintenance or condition issues that reduce market value.',
    'File by your jurisdiction\'s deadline with 3–5 comps and a requested corrected assessed value.',
  ];

  if (appealStrength === 'insufficient') {
    nextSteps.unshift('Gather at least 3 recent comparable sales within 12–18 months before filing.');
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    address,
    sources: {
      attom: { ok: true, fromCache, stale },
      rentcast: { ok: Boolean(valueAvm?.estimate), fromCache: Boolean(valueAvm?.fromCache), error: rentcastError },
    },
    subject: {
      ...subject,
      assessedValue: assessed.value,
      assessedValueSource: assessed.source,
      taxAmount,
      taxYear,
      effectiveTaxRate,
      lastRecordedSale: dashboard.sales_history?.[0] || null,
    },
    assessment: {
      assessedValue: assessed.value,
      opinionOfValue,
      opinionOfValueMethod: compImpliedValue ? 'median_comp_price_per_sqft_applied_to_subject_sqft' : 'median_comp_sale_price',
      compMedian,
      compMedianPricePerSqft: compMedianPpsf,
      overAssessmentAmount,
      overAssessmentPct,
      appealThresholdMet: overAssessmentPct != null && overAssessmentPct >= APPEAL_THRESHOLD_PCT,
      appealThresholdPct: APPEAL_THRESHOLD_PCT,
    },
    comparables,
    compSummary: {
      count: comparables.length,
      maxSaleAgeMonths,
      spreadPct: compSpreadPct,
    },
    projectedSavings: {
      annual: annualSavings,
      monthly: monthlySavings,
      note: effectiveTaxRate
        ? `Estimated using effective rate ${round(effectiveTaxRate * 100, 3)}% (tax ÷ assessed).`
        : 'Could not estimate savings — missing tax or assessed value.',
    },
    taxHistory: (dashboard.tax_history || []).slice(0, 8),
    taxMeta: dashboard.tax_meta || null,
    factualIssues: buildFactualIssues(subject, dashboard),
    appealStrength,
    disclaimers,
    nextSteps,
    // Internal screening only — do not print on appeal PDF as evidence
    screening: {
      attomAvm: num(dashboard.summary?.avm_value),
      rentcastAvm: num(valueAvm?.estimate),
    },
  };
}
