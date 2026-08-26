/**
 * Sales Comparison ARV / AR Rent Engine
 *
 * Appraiser-style reconciliation for renovation underwriting:
 * - Time-adjust sold comps to present market
 * - Equalize comp features to subject as-completed profile
 * - Reconcile weighted adjusted values into ARV low/base/high
 * - Build AR-rent low/base/high from rent comps (when available)
 *
 * NOTE: This is the primary underwriting valuation output.
 * Per-category comp uplift remains advisory/explanatory only.
 */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(v => (v - m) ** 2)));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function monthsBetween(dateA, dateB) {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (a - b) / (1000 * 60 * 60 * 24 * 30.4375);
}

function weightedMean(values, weights) {
  if (!values.length || values.length !== weights.length) return 0;
  let s = 0;
  let w = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i] * weights[i];
    w += weights[i];
  }
  return w > 0 ? s / w : mean(values);
}

function weightedPercentile(values, weights, p = 0.5) {
  if (!values.length || values.length !== weights.length) return 0;
  const zipped = values.map((v, i) => ({ v, w: Math.max(0, weights[i]) }))
    .sort((a, b) => a.v - b.v);
  const totalW = zipped.reduce((s, z) => s + z.w, 0);
  if (totalW <= 0) return median(values);
  const target = totalW * clamp(p, 0, 1);
  let acc = 0;
  for (const z of zipped) {
    acc += z.w;
    if (acc >= target) return z.v;
  }
  return zipped[zipped.length - 1]?.v || 0;
}

function deriveMonthlyMarketRate(upliftResults = []) {
  const monthlyRates = [];
  for (const r of upliftResults) {
    const ap = safeNum(r?.marketAppreciation?.appreciationPercent, NaN);
    const hm = safeNum(r?.holdingMonths, NaN);
    if (!Number.isFinite(ap) || !Number.isFinite(hm) || hm <= 0) continue;
    const mRate = Math.pow(1 + ap / 100, 1 / hm) - 1;
    if (Number.isFinite(mRate) && Math.abs(mRate) < 0.1) monthlyRates.push(mRate);
  }
  if (monthlyRates.length === 0) return 0;
  return median(monthlyRates);
}

export function deriveLocalCalibration(upliftResults = []) {
  const ratios = [];

  for (const result of upliftResults) {
    const observed = safeNum(result?.renovationAttributedUplift, 0);
    if (observed <= 0) continue;

    const expectedConsensus = (result?.renovationBreakdown || []).reduce((sum, r) => {
      return sum + safeNum(r?.consensusUplift, 0);
    }, 0);

    if (expectedConsensus > 0) {
      const ratio = observed / expectedConsensus;
      if (Number.isFinite(ratio) && ratio > 0.2 && ratio < 4.0) ratios.push(ratio);
    }
  }

  if (ratios.length < 3) {
    return {
      available: false,
      sampleSize: ratios.length,
      localFactorRaw: 1,
      localFactorClipped: 1,
      clipMin: 0.75,
      clipMax: 1.3,
      driftStdDev: 0,
      driftPct: 0,
      quality: 'insufficient_samples'
    };
  }

  const raw = median(ratios);
  const clipped = clamp(raw, 0.75, 1.3);
  const driftStd = stdDev(ratios);
  const driftPct = raw > 0 ? (driftStd / raw) * 100 : 0;
  const quality = driftPct <= 15 ? 'stable' : driftPct <= 30 ? 'moderate_drift' : 'high_drift';

  return {
    available: true,
    sampleSize: ratios.length,
    localFactorRaw: Math.round(raw * 1000) / 1000,
    localFactorClipped: Math.round(clipped * 1000) / 1000,
    clipMin: 0.75,
    clipMax: 1.3,
    driftStdDev: Math.round(driftStd * 1000) / 1000,
    driftPct: Math.round(driftPct * 10) / 10,
    quality
  };
}

function normalizeComp(r) {
  const salePrice = safeNum(r?.afterSalePrice, 0);
  const sqft = safeNum(r?.sqft, 0);
  if (salePrice <= 0) return null;

  return {
    address: r?.address || '',
    salePrice,
    saleDate: r?.afterDate || r?.analyzedAt || new Date().toISOString(),
    propertyType: r?.propertyType || 'Residential',
    zipCode: r?.zipCode || r?.zip || null,
    state: r?.state || null,
    city: r?.city || null,
    sqft,
    beds: safeNum(r?.beds, 0),
    baths: safeNum(r?.baths, 0),
    yearBuilt: safeNum(r?.yearBuilt, 0),
    lotSizeSqFt: safeNum(r?.lotSizeSqFt || r?.lotSqft || r?.lotSize, 0),
    garageSpaces: safeNum(r?.garageSpaces, 0),
    hasBasement: !!r?.hasBasement,
    conditionScore: safeNum(r?.beforeCondition?.overall || r?.conditionScore, 0),
    confidence: clamp(safeNum(r?.confidence?.score, 50) / 100, 0.2, 1),
    rentAfter: safeNum(r?.rentAnalysis?.rentAfter, 0),
    rentBefore: safeNum(r?.rentAnalysis?.rentBefore, 0),
  };
}

function resolveSubjectProfile(comps = [], subjectProfile = null) {
  const valid = comps.filter(Boolean);
  const sqfts = valid.map(c => c.sqft).filter(v => v > 0);
  const beds = valid.map(c => c.beds).filter(v => v > 0);
  const baths = valid.map(c => c.baths).filter(v => v > 0);
  const years = valid.map(c => c.yearBuilt).filter(v => v > 1800);
  const prices = valid.map(c => c.salePrice).filter(v => v > 0);

  return {
    sqft: safeNum(subjectProfile?.sqft, median(sqfts) || 1800),
    beds: safeNum(subjectProfile?.beds, median(beds) || 3),
    baths: safeNum(subjectProfile?.baths, median(baths) || 2),
    yearBuilt: safeNum(subjectProfile?.yearBuilt, median(years) || 1990),
    propertyType: subjectProfile?.propertyType || valid[0]?.propertyType || 'Residential',
    zipCode: subjectProfile?.zipCode || valid[0]?.zipCode || null,
    state: subjectProfile?.state || valid[0]?.state || null,
    city: subjectProfile?.city || valid[0]?.city || null,
    lotSizeSqFt: safeNum(subjectProfile?.lotSizeSqFt, median(valid.map(c => c.lotSizeSqFt).filter(v => v > 0)) || 0),
    garageSpaces: safeNum(subjectProfile?.garageSpaces, median(valid.map(c => c.garageSpaces).filter(v => v >= 0)) || 0),
    hasBasement: subjectProfile?.hasBasement ?? null,
    conditionScore: safeNum(subjectProfile?.conditionScore, median(valid.map(c => c.conditionScore).filter(v => v > 0)) || 0),
    currentValue: safeNum(subjectProfile?.currentValue, median(prices) || 0),
    currentRent: safeNum(subjectProfile?.currentRent, 0),
    purchasePrice: safeNum(subjectProfile?.purchasePrice, 0),
    rehabBudget: safeNum(subjectProfile?.rehabBudget, 0),
    acquisitionCosts: safeNum(subjectProfile?.acquisitionCosts, 0),
    holdingCosts: safeNum(subjectProfile?.holdingCosts, 0),
    financingCosts: safeNum(subjectProfile?.financingCosts, 0),
    sellingCosts: safeNum(subjectProfile?.sellingCosts, 0),
  };
}

export function buildSalesComparisonValuation({
  upliftResults = [],
  subjectProfile = null,
  capRateData = null,
  applyLocalCalibration = false,
} = {}) {
  const comps = upliftResults.map(normalizeComp).filter(Boolean);

  if (comps.length === 0) {
    return {
      primaryMethod: 'sales_comparison',
      available: false,
      reason: 'no_comp_sales',
      compCountRaw: 0,
      compCountUsed: 0,
      advisory: 'Use ARV from an as-completed appraisal when available.'
    };
  }

  const subject = resolveSubjectProfile(comps, subjectProfile);
  const monthlyMarketRate = deriveMonthlyMarketRate(upliftResults);
  const localCalibration = deriveLocalCalibration(upliftResults);

  const psfValues = comps
    .filter(c => c.sqft > 0)
    .map(c => c.salePrice / c.sqft);
  const medianPsf = median(psfValues) || 180;

  // Adjustment coefficients (conservative defaults)
  const sqftAdjPerFt = clamp(medianPsf * 0.35, 20, 180);
  const bedAdj = 12000;
  const bathAdj = 15000;
  const yearAdj = 700;

  const now = new Date();
  const dated = comps.map(c => ({ ...c, monthsAgo: Math.max(0, monthsBetween(now, c.saleDate)) }));

  // Recency policy (Phase 3): prefer 90-180 day comps, widen only when samples are thin.
  const within180 = dated.filter(c => c.monthsAgo <= 6);
  const within365 = dated.filter(c => c.monthsAgo <= 12);
  const recencyPreferred = within180.length >= 5
    ? within180
    : within365.length >= 5
      ? within365
      : dated;

  const adjusted = recencyPreferred.map(c => {
    const monthsAgo = Math.max(0, monthsBetween(now, c.saleDate));
    const timeFactor = Math.pow(1 + monthlyMarketRate, monthsAgo);
    const timeAdjustedPrice = c.salePrice * timeFactor;

    const sqftAdj = (subject.sqft - c.sqft) * sqftAdjPerFt;
    const bedAdjVal = (subject.beds - c.beds) * bedAdj;
    const bathAdjVal = (subject.baths - c.baths) * bathAdj;
    const yearAdjVal = clamp(subject.yearBuilt - c.yearBuilt, -30, 30) * yearAdj;

    // Expanded equalization factors (Phase 2)
    const lotAdjPerFt = clamp(medianPsf * 0.04, 1, 20);
    const lotAdjVal = (subject.lotSizeSqFt > 0 && c.lotSizeSqFt > 0)
      ? clamp(subject.lotSizeSqFt - c.lotSizeSqFt, -8000, 8000) * lotAdjPerFt
      : 0;
    const garageAdjVal = (subject.garageSpaces - c.garageSpaces) * 7000;
    const basementAdjVal = (subject.hasBasement == null || c.hasBasement == null)
      ? 0
      : (subject.hasBasement === c.hasBasement ? 0 : (subject.hasBasement ? 12000 : -12000));
    const conditionAdjVal = (subject.conditionScore > 0 && c.conditionScore > 0)
      ? clamp(subject.conditionScore - c.conditionScore, -4, 4) * 4500
      : 0;
    const locationAdjVal = (subject.zipCode && c.zipCode && subject.zipCode !== c.zipCode) ? -8000 : 0;

    const adjustedPrice = Math.max(10000, timeAdjustedPrice + sqftAdj + bedAdjVal + bathAdjVal + yearAdjVal + lotAdjVal + garageAdjVal + basementAdjVal + conditionAdjVal + locationAdjVal);

    const sqftSimilarity = c.sqft > 0 && subject.sqft > 0
      ? Math.min(subject.sqft, c.sqft) / Math.max(subject.sqft, c.sqft)
      : 0.7;
    const bedSimilarity = 1 - Math.min(1, Math.abs(subject.beds - c.beds) * 0.25);
    const bathSimilarity = 1 - Math.min(1, Math.abs(subject.baths - c.baths) * 0.20);
    const recencyWeight = Math.exp(-0.18 * (monthsAgo / 12));
    const similarity = clamp((sqftSimilarity * 0.45) + (bedSimilarity * 0.25) + (bathSimilarity * 0.30), 0.2, 1);
    const weight = clamp(recencyWeight * similarity * c.confidence, 0.05, 1.0);

    return {
      address: c.address,
      salePrice: Math.round(c.salePrice),
      timeAdjustedPrice: Math.round(timeAdjustedPrice),
      adjustedPrice: Math.round(adjustedPrice),
      saleDate: c.saleDate,
      sqft: c.sqft,
      beds: c.beds,
      baths: c.baths,
      yearBuilt: c.yearBuilt,
      adjustments: {
        sqft: Math.round(sqftAdj),
        beds: Math.round(bedAdjVal),
        baths: Math.round(bathAdjVal),
        yearBuilt: Math.round(yearAdjVal),
        lotSize: Math.round(lotAdjVal),
        garage: Math.round(garageAdjVal),
        basement: Math.round(basementAdjVal),
        condition: Math.round(conditionAdjVal),
        location: Math.round(locationAdjVal),
      },
      weight: Math.round(weight * 1000) / 1000,
      similarity: Math.round(similarity * 1000) / 1000,
      recencyWeight: Math.round(recencyWeight * 1000) / 1000,
    };
  });

  // Use highest quality comps in final reconciliation
  const finalComps = [...adjusted]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.min(12, Math.max(5, adjusted.length)));

  const values = finalComps.map(c => c.adjustedPrice);
  const weights = finalComps.map(c => c.weight);

  const baseUncal = weightedMean(values, weights);
  const p20Uncal = weightedPercentile(values, weights, 0.2);
  const p80Uncal = weightedPercentile(values, weights, 0.8);

  // Phase 5: expose the consensus/local calibration factor for diagnostics and
  // controlled backtests. Do not apply it to the core ARV by default because
  // the comp-adjusted sale prices already encode realized local renovation lift.
  const k = applyLocalCalibration
    ? (localCalibration.localFactorClipped || 1)
    : 1;
  let base = baseUncal;
  let p20 = p20Uncal;
  let p80 = p80Uncal;

  if (subject.currentValue > 0) {
    const premiumBase = baseUncal - subject.currentValue;
    const premiumLow = p20Uncal - subject.currentValue;
    const premiumHigh = p80Uncal - subject.currentValue;
    base = subject.currentValue + (premiumBase * k);
    p20 = subject.currentValue + (premiumLow * k);
    p80 = subject.currentValue + (premiumHigh * k);
  } else {
    // Without subject current value, apply a dampened global calibration.
    const dampened = 1 + ((k - 1) * 0.35);
    base = baseUncal * dampened;
    p20 = p20Uncal * dampened;
    p80 = p80Uncal * dampened;
  }

  const confidenceScore = clamp(
    Math.round(
      40
      + Math.min(25, finalComps.length * 2.2)
      + Math.min(20, mean(finalComps.map(c => c.similarity)) * 20)
      + Math.min(15, mean(finalComps.map(c => c.recencyWeight)) * 15)
    ),
    25,
    95
  );

  const confidenceLevel = confidenceScore >= 78 ? 'high' : confidenceScore >= 55 ? 'medium' : 'low';

  // AR Rent model (when rental comps are available)
  const rentComps = comps.filter(c => c.rentAfter > 0 && c.sqft > 0);
  let arRent = {
    available: false,
    low: null,
    base: null,
    high: null,
    confidenceScore: 0,
    sampleSize: rentComps.length,
    method: 'rent_comp_psf'
  };

  if (rentComps.length >= 3) {
    const rentPsf = rentComps.map(c => c.rentAfter / c.sqft).filter(v => v > 0);
    const baseRentPsf = median(rentPsf);
    const estBase = baseRentPsf * Math.max(subject.sqft, 1);
    const spreadPct = rentComps.length >= 8 ? 0.08 : 0.12;
    arRent = {
      available: true,
      low: Math.round(estBase * (1 - spreadPct)),
      base: Math.round(estBase),
      high: Math.round(estBase * (1 + spreadPct)),
      confidenceScore: clamp(45 + rentComps.length * 4, 45, 88),
      sampleSize: rentComps.length,
      method: 'rent_comp_psf'
    };
  } else if (capRateData?.overall && base > 0) {
    // Fallback proxy from cap rate when rent comps are sparse
    const annualGross = base * capRateData.overall;
    const monthly = annualGross / 12;
    arRent = {
      available: true,
      low: Math.round(monthly * 0.9),
      base: Math.round(monthly),
      high: Math.round(monthly * 1.1),
      confidenceScore: 35,
      sampleSize: rentComps.length,
      method: 'cap_rate_proxy'
    };
  }

  const coreArv = {
    available: true,
    low: Math.round(Math.min(p20, base)),
    base: Math.round(base),
    high: Math.round(Math.max(p80, base)),
    uncalibratedLow: Math.round(Math.min(p20Uncal, baseUncal)),
    uncalibratedBase: Math.round(baseUncal),
    uncalibratedHigh: Math.round(Math.max(p80Uncal, baseUncal)),
    confidenceScore,
    confidenceLevel,
    compCountRaw: comps.length,
    compCountUsed: finalComps.length,
    recencyPolicy: {
      preferredWindowDays: 180,
      fallbackWindowDays: within180.length >= 5 ? 180 : (within365.length >= 5 ? 365 : null),
      preferredComps: within180.length,
      fallbackComps: within365.length,
      selectedComps: recencyPreferred.length,
    },
    monthlyMarketRate: Math.round(monthlyMarketRate * 100000) / 100000,
    medianPricePerSqFt: Math.round(medianPsf),
    localCalibrationApplied: applyLocalCalibration,
    localCalibrationFactor: Math.round(k * 1000) / 1000,
    localCalibration,
    adjustmentCoefficients: {
      sqftAdjPerFt: Math.round(sqftAdjPerFt),
      bedAdj,
      bathAdj,
      yearAdj,
      lotAdjPerFt: Math.round(clamp(medianPsf * 0.04, 1, 20)),
      garageAdj: 7000,
      basementAdj: 12000,
      conditionPointAdj: 4500,
      crossZipPenalty: -8000,
    },
    adjustedComps: finalComps,
    subjectProfile: {
      sqft: subject.sqft,
      beds: subject.beds,
      baths: subject.baths,
      yearBuilt: subject.yearBuilt,
      propertyType: subject.propertyType,
    }
  };

  // Optional underwriting metrics (only when purchase/rehab inputs provided)
  const totalProjectCost = subject.purchasePrice
    + subject.rehabBudget
    + subject.acquisitionCosts
    + subject.holdingCosts
    + subject.financingCosts
    + subject.sellingCosts;

  let underwriting = {
    available: false,
    totalProjectCost: null,
    instantEquity: null,
    roiPercent: null,
    grossRentYieldPercent: null,
  };

  if (totalProjectCost > 0) {
    const instantEquity = coreArv.base - totalProjectCost;
    const roiPercent = (instantEquity / totalProjectCost) * 100;
    const grossRentYieldPercent = arRent.available ? ((arRent.base * 12) / totalProjectCost) * 100 : null;

    underwriting = {
      available: true,
      totalProjectCost: Math.round(totalProjectCost),
      instantEquity: Math.round(instantEquity),
      roiPercent: Math.round(roiPercent * 10) / 10,
      grossRentYieldPercent: grossRentYieldPercent != null ? Math.round(grossRentYieldPercent * 10) / 10 : null,
    };
  }

  return {
    primaryMethod: 'sales_comparison',
    available: true,
    coreArv,
    arRent,
    underwriting,
    notes: [
      'Core valuation uses sales comparison adjustments and recency weighting.',
      'Per-category comp uplift is advisory-only and excluded from core ARV underwriting.',
      applyLocalCalibration
        ? 'Phase 5 local calibration is applied to the ARV premium when sufficient samples exist.'
        : 'Phase 5 local calibration is disabled for this valuation run.'
    ]
  };
}

export default {
  buildSalesComparisonValuation,
};
