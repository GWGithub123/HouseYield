/**
 * Pure property tax over-assessment analysis.
 *
 * Two tests (Fable / domain-correct):
 *  1. Equity — subject assessment ratio vs comps in the SAME taxing area
 *  2. Market — subject assessed vs estimated market value (only meaningful
 *     where the jurisdiction assesses near market, after normalizing by
 *     assessmentLevel)
 *
 * Outputs are screening estimates for owner review — never guarantees or tax advice.
 */

import { getTaxAssessmentConfig } from '../config/taxAssessmentConfig.js';

export function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function median(values) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

/**
 * Detect MD-style 3-year phase-in: assessments stepping up in roughly equal increments.
 * Accepts a full cycle (phaseInYears rows) or a mid-cycle window (phaseInYears - 1 rows).
 */
export function detectPhaseIn(taxHistory = [], phaseInYears = 3) {
  if (!phaseInYears || phaseInYears < 2) {
    return { phaseIn: false, reason: null };
  }

  const rows = [...(taxHistory || [])]
    .map((row) => ({
      year: num(row.year),
      assessed: num(row.assessed_total ?? row.assessedTotal ?? row.assessed),
    }))
    .filter((row) => row.year != null && row.assessed != null && row.assessed > 0)
    .sort((a, b) => a.year - b.year);

  const minWindow = Math.max(phaseInYears - 1, 2); // mid-cycle still detectable
  if (rows.length < minWindow) {
    return { phaseIn: false, reason: null, history: rows };
  }

  // Prefer the most recent full cycle; fall back to mid-cycle window
  const windowSize = rows.length >= phaseInYears ? phaseInYears : minWindow;
  const window = rows.slice(-windowSize);
  const yearsConsecutive = window.every((row, i) => (
    i === 0 || row.year === window[i - 1].year + 1
  ));
  if (!yearsConsecutive) {
    return { phaseIn: false, reason: null, history: rows };
  }

  const increments = [];
  for (let i = 1; i < window.length; i += 1) {
    increments.push(window[i].assessed - window[i - 1].assessed);
  }
  if (increments.some((inc) => inc <= 0)) {
    return { phaseIn: false, reason: null, history: rows };
  }

  const avgInc = increments.reduce((a, b) => a + b, 0) / increments.length;
  const withinTolerance = increments.every((inc) => Math.abs(inc - avgInc) / avgInc <= 0.12);
  if (!withinTolerance) {
    return { phaseIn: false, reason: null, history: rows };
  }

  const maxIncrements = phaseInYears - 1;
  const stepsObserved = increments.length;
  const remainingSteps = Math.max(maxIncrements - stepsObserved, 0);
  const projectedFinal = window[window.length - 1].assessed + avgInc * remainingSteps;

  return {
    phaseIn: true,
    reason: `Assessment appears to be phasing in over ${phaseInYears} years (~$${Math.round(avgInc).toLocaleString()}/yr steps)`,
    averageIncrement: round(avgInc),
    projectedFinalAssessment: round(projectedFinal),
    currentAssessment: window[window.length - 1].assessed,
    remainingSteps,
    history: window,
  };
}

/**
 * Median of available market-value estimators + uncertainty band.
 * Suppress flagging when ATTOM confidence is low AND estimators disagree >20%.
 */
export function estimateMarketValue({
  attomAvm = null,
  attomAvmLow = null,
  attomAvmHigh = null,
  attomAvmConfidence = null,
  rentcastEstimate = null,
  rentcastLow = null,
  rentcastHigh = null,
  salePriceTimeAdjusted = null,
} = {}) {
  const estimators = [
    num(attomAvm),
    num(rentcastEstimate),
    num(salePriceTimeAdjusted),
  ].filter((v) => v != null && v > 0);

  if (!estimators.length) {
    return {
      mv: null,
      mvLow: null,
      mvHigh: null,
      estimatorCount: 0,
      spreadPct: null,
      lowConfidence: true,
      sources: [],
    };
  }

  const mv = median(estimators);
  const bandLows = [num(attomAvmLow), num(rentcastLow)].filter((v) => v != null && v > 0);
  const bandHighs = [num(attomAvmHigh), num(rentcastHigh)].filter((v) => v != null && v > 0);
  const mvLow = bandLows.length ? Math.min(...bandLows, ...estimators) : Math.min(...estimators);
  const mvHigh = bandHighs.length ? Math.max(...bandHighs, ...estimators) : Math.max(...estimators);

  const minEst = Math.min(...estimators);
  const maxEst = Math.max(...estimators);
  const spreadPct = mv > 0 ? ((maxEst - minEst) / mv) * 100 : null;

  const attomConfidenceLow = attomAvmConfidence != null
    && (String(attomAvmConfidence).toLowerCase() === 'low'
      || (Number.isFinite(Number(attomAvmConfidence)) && Number(attomAvmConfidence) < 50));

  const lowConfidence = Boolean(
    (attomConfidenceLow && spreadPct != null && spreadPct > 20)
    || (estimators.length >= 2 && spreadPct != null && spreadPct > 35),
  );

  const sources = [];
  if (num(attomAvm)) sources.push({ name: 'ATTOM AVM', value: num(attomAvm) });
  if (num(rentcastEstimate)) sources.push({ name: 'RentCast value estimate', value: num(rentcastEstimate) });
  if (num(salePriceTimeAdjusted)) sources.push({ name: 'Time-adjusted recent sale', value: num(salePriceTimeAdjusted) });

  return {
    mv: round(mv),
    mvLow: round(mvLow),
    mvHigh: round(mvHigh),
    estimatorCount: estimators.length,
    spreadPct: spreadPct != null ? round(spreadPct, 1) : null,
    lowConfidence,
    sources,
  };
}

/**
 * Filter comps to same jurisdiction + similarity, expanding radius until enough.
 * Input comps must already include assessed + mvEst + sqft + distanceMiles + sameJurisdiction.
 */
export function selectEquityComps(subject, comps = [], {
  minComps = 7,
  absoluteMinComps = 5,
  radii = [1, 2, 3],
  sqftTolerance = 0.25,
  yearBuiltTolerance = 15,
} = {}) {
  const subjectSqft = num(subject.sqft);
  const subjectYear = num(subject.yearBuilt);
  const subjectType = String(subject.propertyType || '').toUpperCase();

  const eligible = (comps || []).filter((comp) => {
    if (comp.sameJurisdiction === false) return false;
    const assessed = num(comp.assessed);
    const mv = num(comp.mvEst ?? comp.mv);
    const sqft = num(comp.sqft);
    if (!(assessed > 0) || !(mv > 0) || !(sqft > 0)) return false;

    if (subjectSqft > 0) {
      const delta = Math.abs(sqft - subjectSqft) / subjectSqft;
      if (delta > sqftTolerance) return false;
    }
    if (subjectYear > 0 && num(comp.yearBuilt) > 0) {
      if (Math.abs(num(comp.yearBuilt) - subjectYear) > yearBuiltTolerance) return false;
    }
    if (subjectType && comp.propertyType) {
      const compType = String(comp.propertyType).toUpperCase();
      const subjectSfr = /SINGLE|SFR|RESIDENCE/.test(subjectType);
      const compSfr = /SINGLE|SFR|RESIDENCE/.test(compType);
      if (subjectSfr !== compSfr && !subjectType.includes(compType) && !compType.includes(subjectType)) {
        return false;
      }
    }
    return true;
  });

  let selected = [];
  let usedRadius = null;
  for (const radius of radii) {
    selected = eligible
      .filter((c) => num(c.distanceMiles) == null || num(c.distanceMiles) <= radius)
      .sort((a, b) => (num(a.distanceMiles) || 99) - (num(b.distanceMiles) || 99));
    usedRadius = radius;
    if (selected.length >= minComps) break;
  }

  const insufficient = selected.length < absoluteMinComps;
  return {
    comps: selected,
    count: selected.length,
    usedRadius,
    insufficientComps: insufficient,
  };
}

function assessmentRatio(assessed, mv) {
  const a = num(assessed);
  const m = num(mv);
  if (!(a > 0) || !(m > 0)) return null;
  return a / m;
}

function assessmentPerSqft(assessed, sqft) {
  const a = num(assessed);
  const s = num(sqft);
  if (!(a > 0) || !(s > 0)) return null;
  return a / s;
}

/**
 * Core analysis. Accepts a fully-hydrated subject + comps payload (no I/O).
 */
export function analyzeOverAssessment(input = {}) {
  const config = getTaxAssessmentConfig({
    state: input.state || input.subject?.state,
    fips: input.fips || input.subject?.fips,
    countyFips: input.countyFips,
  });

  const subject = input.subject || {};
  const assessed = num(subject.assessedValue ?? subject.assessed);
  const taxAmount = num(subject.taxAmount ?? subject.annualTax);
  const effectiveRate = assessed > 0 && taxAmount > 0 ? taxAmount / assessed : num(input.effectiveTaxRate);

  const suppressionReasons = [];
  const phase = detectPhaseIn(subject.taxHistory || input.taxHistory || [], config.phaseInYears);

  const mvResult = estimateMarketValue(input.marketValueEstimators || {});
  const mv = mvResult.mv;

  const equitySelection = selectEquityComps(subject, input.comps || [], {
    minComps: config.minCompsStrong,
    absoluteMinComps: config.minCompsAny,
  });

  const arSubj = assessmentRatio(assessed, mv);
  const apsSubj = assessmentPerSqft(assessed, subject.sqft);

  const compRatios = equitySelection.comps
    .map((c) => assessmentRatio(c.assessed, c.mvEst ?? c.mv))
    .filter((v) => v != null);
  const compAps = equitySelection.comps
    .map((c) => assessmentPerSqft(c.assessed, c.sqft))
    .filter((v) => v != null);

  const arMed = median(compRatios);
  const apsMed = median(compAps);

  let equityExcessPct = null;
  if (arSubj != null && arMed != null && arMed > 0) {
    const arExcess = (arSubj / arMed) - 1;
    const apsExcess = (apsSubj != null && apsMed != null && apsMed > 0)
      ? (apsSubj / apsMed) - 1
      : arExcess;
    // Conservative: use the smaller excess
    equityExcessPct = round(Math.min(arExcess, apsExcess) * 100, 1);
  }

  // Market test — normalize by county assessment level
  let marketExcessPct = null;
  if (assessed != null && mv != null && mv > 0) {
    const normalizedAssessed = assessed / (config.assessmentLevel || 1);
    marketExcessPct = round(((normalizedAssessed / mv) - 1) * 100, 1);
  }

  // Suppressions
  if (mvResult.lowConfidence) {
    suppressionReasons.push('low_confidence_market_value');
  }
  if (equitySelection.insufficientComps) {
    suppressionReasons.push('insufficient_comps');
  }
  if (phase.phaseIn) {
    // Suppress if final-year target is not excessive vs equity median
    const finalAssessed = phase.projectedFinalAssessment || assessed;
    const finalAr = assessmentRatio(finalAssessed, mv);
    const finalExcess = finalAr != null && arMed != null && arMed > 0
      ? ((finalAr / arMed) - 1) * 100
      : null;
    if (finalExcess == null || finalExcess < config.moderateEquityExcessPct) {
      suppressionReasons.push('phase_in_not_excessive_at_final');
    }
  }
  if (input.homesteadCreditActive === true) {
    suppressionReasons.push('homestead_credit_active');
  }
  if (input.recentSaleOrRenovation === true) {
    suppressionReasons.push('recent_sale_or_renovation');
  }

  // Flag tiers
  let flag = 'none';
  const strongThreshold = config.strongEquityExcessPct;
  const moderateThreshold = config.moderateEquityExcessPct;
  const aboveAvmHigh = mvResult.mvHigh != null && assessed != null && assessed > mvResult.mvHigh;
  const canFlag = suppressionReasons.length === 0 && equityExcessPct != null;

  if (canFlag && equityExcessPct > 0 && equityExcessPct >= moderateThreshold) {
    const meetsStrong = equityExcessPct >= strongThreshold
      && aboveAvmHigh
      && equitySelection.count >= config.minCompsStrong
      && !mvResult.lowConfidence;
    flag = meetsStrong ? 'strong' : 'moderate';
  }

  const justifiedAssessment = (arMed != null && mv != null)
    ? round(arMed * mv)
    : null;

  const savingsBase = (assessed != null && justifiedAssessment != null && effectiveRate != null)
    ? Math.max(0, assessed - justifiedAssessment) * effectiveRate
    : 0;

  // Range using MV uncertainty: higher MV → lower justified gap sometimes;
  // present LOW end prominently (under-promise).
  let annualSavingsLow = 0;
  let annualSavingsHigh = 0;
  if (arMed != null && effectiveRate != null && assessed != null) {
    const justLow = mvResult.mvHigh != null ? arMed * mvResult.mvHigh : justifiedAssessment;
    const justHigh = mvResult.mvLow != null ? arMed * mvResult.mvLow : justifiedAssessment;
    const saveFromHighMv = Math.max(0, assessed - justLow) * effectiveRate; // smaller savings
    const saveFromLowMv = Math.max(0, assessed - justHigh) * effectiveRate; // larger savings
    annualSavingsLow = round(Math.min(saveFromHighMv, saveFromLowMv, savingsBase));
    annualSavingsHigh = round(Math.max(saveFromHighMv, saveFromLowMv, savingsBase));
    if (annualSavingsLow < 0) annualSavingsLow = 0;
    if (annualSavingsHigh < 0) annualSavingsHigh = 0;
  }

  if (flag === 'none') {
    annualSavingsLow = 0;
    annualSavingsHigh = 0;
  }

  const confidence = mvResult.lowConfidence || equitySelection.insufficientComps
    ? 'low'
    : (mvResult.estimatorCount >= 2 && equitySelection.count >= config.minCompsStrong ? 'high' : 'medium');

  const narrative = buildNarrative({
    flag,
    equityExcessPct,
    annualSavingsLow,
    annualSavingsHigh,
    assessed,
    justifiedAssessment,
    suppressionReasons,
    address: subject.address,
  });

  const compsOut = equitySelection.comps.slice(0, 12).map((c) => ({
    address: c.address || '',
    assessed: round(num(c.assessed)),
    mv_est: round(num(c.mvEst ?? c.mv)),
    sqft: round(num(c.sqft)),
    ratio: round(assessmentRatio(c.assessed, c.mvEst ?? c.mv), 3),
    distance_miles: num(c.distanceMiles) != null ? round(num(c.distanceMiles), 2) : null,
  }));

  return {
    flag,
    annual_savings_low: annualSavingsLow || 0,
    annual_savings_high: annualSavingsHigh || 0,
    equity_excess_pct: equityExcessPct,
    market_excess_pct: marketExcessPct,
    justified_assessment: justifiedAssessment,
    assessed_value: assessed,
    market_value_est: mv,
    market_value_low: mvResult.mvLow,
    market_value_high: mvResult.mvHigh,
    effective_tax_rate: effectiveRate != null ? round(effectiveRate, 5) : null,
    assessment_ratio_subject: arSubj != null ? round(arSubj, 3) : null,
    assessment_ratio_comp_median: arMed != null ? round(arMed, 3) : null,
    comps: compsOut,
    comp_count: equitySelection.count,
    comp_radius_miles: equitySelection.usedRadius,
    suppression_reasons: suppressionReasons,
    phase_in: phase.phaseIn,
    phase_in_detail: phase.phaseIn ? phase : null,
    appeal_deadline: config.appealWindow?.typicalMonths || config.appealWindow?.label || null,
    appeal_instructions: config.appealWindow?.instructions || null,
    appeal_url: config.appealWindow?.url || null,
    narrative,
    confidence,
    generated_at: new Date().toISOString(),
    disclaimer: 'Estimate for owner review — not legal or tax advice. Flagged for review only; not a determination that the property is overtaxed.',
    config_key: config.fips ? `${config.state}-${config.fips}` : (config.state || 'default'),
    inputs_log: {
      assessed,
      taxAmount,
      effectiveRate,
      mvEstimators: mvResult.sources,
      mvSpreadPct: mvResult.spreadPct,
      lowConfidence: mvResult.lowConfidence,
      compCount: equitySelection.count,
      equityExcessPct,
      marketExcessPct,
      phaseIn: phase.phaseIn,
      suppressionReasons,
    },
  };
}

function buildNarrative({
  flag,
  equityExcessPct,
  annualSavingsLow,
  annualSavingsHigh,
  assessed,
  justifiedAssessment,
  suppressionReasons,
  address,
}) {
  const where = address ? ` at ${address}` : '';
  if (suppressionReasons.includes('phase_in_not_excessive_at_final')) {
    return `Assessment${where} appears to be phasing in under Maryland's triennial cycle. The projected final assessment does not look excessive versus nearby comps — no appeal flag.`;
  }
  if (suppressionReasons.includes('insufficient_comps')) {
    return `Not enough same-jurisdiction comps to defend an equity argument${where}. No flag surfaced.`;
  }
  if (suppressionReasons.includes('low_confidence_market_value')) {
    return `Market-value estimators disagree too much${where} to defend an over-assessment claim. No flag surfaced.`;
  }
  if (flag === 'none') {
    return `No material over-assessment signal${where} versus nearby comps (below screening threshold).`;
  }

  const excess = equityExcessPct != null ? `~${equityExcessPct}%` : 'materially';
  const savings = annualSavingsLow > 0
    ? ` Estimated annual tax impact if equalized: roughly $${annualSavingsLow.toLocaleString()}–$${Math.max(annualSavingsHigh, annualSavingsLow).toLocaleString()} (low end emphasized — verify before any outreach).`
    : '';
  const justified = justifiedAssessment && assessed
    ? ` Assessed $${Math.round(assessed).toLocaleString()} vs equity-justified ~$${Math.round(justifiedAssessment).toLocaleString()}.`
    : '';

  return `Flagged for review${where}: assessment ratio appears ${excess} above the median of nearby same-jurisdiction comps.${justified}${savings} This is a screening estimate for owner review — not tax advice.`;
}

/**
 * Compact lead-card fields from a full analysis result.
 */
export function toLeadTaxFields(analysis) {
  if (!analysis) return null;
  return {
    taxOverAssessmentFlag: analysis.flag,
    taxEquityExcessPct: analysis.equity_excess_pct,
    taxMarketExcessPct: analysis.market_excess_pct,
    taxAnnualSavingsLow: analysis.annual_savings_low,
    taxAnnualSavingsHigh: analysis.annual_savings_high,
    taxJustifiedAssessment: analysis.justified_assessment,
    taxAppealDeadline: analysis.appeal_deadline,
    taxOverAssessmentNarrative: analysis.narrative,
    taxOverAssessmentConfidence: analysis.confidence,
    taxCompCount: analysis.comp_count,
    taxSuppressionReasons: analysis.suppression_reasons,
  };
}
