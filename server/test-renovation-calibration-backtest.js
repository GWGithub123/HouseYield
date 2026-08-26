import 'dotenv/config';

import {
  buildSalesComparisonValuation,
  deriveLocalCalibration,
} from './renovation/salesComparisonArvEngine.js';

const DEFAULT_LIMIT = 12;
const MIN_SAMPLE_SIZE = 6;

function safeNum(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatCurrency(value) {
  return `$${Math.round(safeNum(value)).toLocaleString()}`;
}

function formatPercent(value, digits = 1) {
  return `${safeNum(value).toFixed(digits)}%`;
}

function parseArgs(argv) {
  const options = {
    zipCodes: [],
    limit: DEFAULT_LIMIT,
    fixtureOnly: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--zip' || arg === '--zipcode') {
      const next = argv[index + 1];
      if (next) {
        options.zipCodes.push(next);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith('--zip=')) {
      options.zipCodes.push(arg.split('=')[1]);
      continue;
    }

    if (arg === '--limit') {
      const next = safeNum(argv[index + 1], DEFAULT_LIMIT);
      options.limit = Math.max(MIN_SAMPLE_SIZE, Math.round(next));
      index += 1;
      continue;
    }

    if (arg.startsWith('--limit=')) {
      options.limit = Math.max(MIN_SAMPLE_SIZE, Math.round(safeNum(arg.split('=')[1], DEFAULT_LIMIT)));
      continue;
    }

    if (arg === '--fixture-only') {
      options.fixtureOnly = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

function splitConsensusUplift(totalConsensusUplift, categories) {
  const weights = [0.46, 0.34, 0.2];
  const parts = categories.slice(0, 3).map((category, index) => ({
    category,
    description: `${category.replace(/_/g, ' ')} upgrade`,
    consensusUplift: Math.round(totalConsensusUplift * weights[index]),
  }));

  const allocated = parts.reduce((sum, part) => sum + part.consensusUplift, 0);
  if (parts.length > 0 && allocated !== totalConsensusUplift) {
    parts[0].consensusUplift += totalConsensusUplift - allocated;
  }

  return parts.map((part) => ({
    ...part,
    allocatedUplift: part.consensusUplift,
    confidence: 0.82,
  }));
}

function buildFixtureComparable({
  address,
  zipCode,
  state,
  city,
  propertyType = 'SFH',
  sqft,
  beds,
  baths,
  yearBuilt,
  lotSizeSqFt,
  garageSpaces,
  hasBasement,
  beforeSalePrice,
  consensusUplift,
  upliftRatio,
  appreciationPercent,
  holdingMonths,
  afterDate,
  categories,
  conditionScore,
  rentYield,
  rentLift,
}) {
  const afterDateValue = new Date(afterDate);
  const beforeDateValue = new Date(afterDateValue);
  beforeDateValue.setMonth(beforeDateValue.getMonth() - holdingMonths);

  const appreciationAmount = Math.round(beforeSalePrice * (appreciationPercent / 100));
  const renovationAttributedUplift = Math.round(consensusUplift * upliftRatio);
  const afterSalePrice = Math.round(beforeSalePrice + appreciationAmount + renovationAttributedUplift);

  const rentBefore = Math.round((beforeSalePrice * rentYield) / 12);
  const rentIncrease = Math.round(rentLift);
  const rentAfter = rentBefore + rentIncrease;

  return {
    address,
    zipCode,
    state,
    city,
    propertyType,
    sqft,
    beds,
    baths,
    yearBuilt,
    lotSizeSqFt,
    garageSpaces,
    hasBasement,
    beforeSalePrice,
    afterSalePrice,
    beforeDate: beforeDateValue.toISOString(),
    afterDate: afterDateValue.toISOString(),
    holdingMonths,
    renovationAttributedUplift,
    totalRenovationCost: Math.round(consensusUplift * 0.72),
    overallValueROI: Math.round(((renovationAttributedUplift / Math.max(consensusUplift * 0.72, 1)) * 100) * 10) / 10,
    marketAppreciation: {
      appreciationPercent,
    },
    renovationBreakdown: splitConsensusUplift(consensusUplift, categories),
    rentAnalysis: {
      rentBefore,
      rentAfter,
      rentIncrease,
      rentIncreasePercent: Math.round((rentIncrease / Math.max(rentBefore, 1)) * 1000) / 10,
    },
    confidence: {
      score: 86,
      level: 'high',
    },
    beforeCondition: {
      overall: conditionScore,
    },
  };
}

function buildFixtureCohorts() {
  return [
    {
      label: 'fixture-potomac-20854',
      source: 'fixture',
      zipCode: '20854',
      records: [
        buildFixtureComparable({ address: '10301 Glen Rd', zipCode: '20854', state: 'MD', city: 'Potomac', sqft: 2380, beds: 4, baths: 2.5, yearBuilt: 1995, lotSizeSqFt: 11200, garageSpaces: 2, hasBasement: true, beforeSalePrice: 650000, consensusUplift: 84000, upliftRatio: 1.09, appreciationPercent: 7.2, holdingMonths: 14, afterDate: '2026-02-15T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'flooring'], conditionScore: 5.8, rentYield: 0.050, rentLift: 235 }),
        buildFixtureComparable({ address: '10412 Falls Reach Dr', zipCode: '20854', state: 'MD', city: 'Potomac', sqft: 2490, beds: 4, baths: 3, yearBuilt: 1993, lotSizeSqFt: 9800, garageSpaces: 2, hasBasement: true, beforeSalePrice: 682000, consensusUplift: 92000, upliftRatio: 1.12, appreciationPercent: 7.2, holdingMonths: 16, afterDate: '2026-01-20T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'windows'], conditionScore: 5.6, rentYield: 0.049, rentLift: 255 }),
        buildFixtureComparable({ address: '9808 Hollow Brook Way', zipCode: '20854', state: 'MD', city: 'Potomac', sqft: 2310, beds: 4, baths: 2.5, yearBuilt: 1989, lotSizeSqFt: 10550, garageSpaces: 2, hasBasement: true, beforeSalePrice: 628000, consensusUplift: 78000, upliftRatio: 1.08, appreciationPercent: 7.2, holdingMonths: 13, afterDate: '2025-12-10T00:00:00.000Z', categories: ['bathroom', 'flooring', 'paint_interior'], conditionScore: 5.9, rentYield: 0.050, rentLift: 225 }),
        buildFixtureComparable({ address: '10711 Meadowhill Ct', zipCode: '20854', state: 'MD', city: 'Potomac', sqft: 2610, beds: 5, baths: 3.5, yearBuilt: 2001, lotSizeSqFt: 11800, garageSpaces: 2, hasBasement: true, beforeSalePrice: 708000, consensusUplift: 99500, upliftRatio: 1.14, appreciationPercent: 7.2, holdingMonths: 15, afterDate: '2026-03-05T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'deck_patio'], conditionScore: 5.4, rentYield: 0.048, rentLift: 285 }),
        buildFixtureComparable({ address: '10907 Candlelight Ln', zipCode: '20854', state: 'MD', city: 'Potomac', sqft: 2725, beds: 5, baths: 3, yearBuilt: 1998, lotSizeSqFt: 12150, garageSpaces: 2, hasBasement: true, beforeSalePrice: 734000, consensusUplift: 106000, upliftRatio: 1.11, appreciationPercent: 7.2, holdingMonths: 17, afterDate: '2026-04-09T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'roof'], conditionScore: 5.5, rentYield: 0.048, rentLift: 298 }),
        buildFixtureComparable({ address: '9815 Bentcross Dr', zipCode: '20854', state: 'MD', city: 'Potomac', sqft: 2515, beds: 4, baths: 3, yearBuilt: 1996, lotSizeSqFt: 10920, garageSpaces: 2, hasBasement: true, beforeSalePrice: 691000, consensusUplift: 90500, upliftRatio: 1.13, appreciationPercent: 7.2, holdingMonths: 14, afterDate: '2026-01-28T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'hvac'], conditionScore: 5.7, rentYield: 0.049, rentLift: 262 }),
        buildFixtureComparable({ address: '9801 Hall Rd', zipCode: '20854', state: 'MD', city: 'Potomac', sqft: 2340, beds: 4, baths: 2.5, yearBuilt: 1994, lotSizeSqFt: 10140, garageSpaces: 2, hasBasement: true, beforeSalePrice: 644000, consensusUplift: 81500, upliftRatio: 1.1, appreciationPercent: 7.2, holdingMonths: 12, afterDate: '2025-11-22T00:00:00.000Z', categories: ['bathroom', 'flooring', 'paint_interior'], conditionScore: 6.0, rentYield: 0.050, rentLift: 232 }),
      ],
    },
    {
      label: 'fixture-austin-78704',
      source: 'fixture',
      zipCode: '78704',
      records: [
        buildFixtureComparable({ address: '1803 Eva St', zipCode: '78704', state: 'TX', city: 'Austin', sqft: 1680, beds: 3, baths: 2, yearBuilt: 1988, lotSizeSqFt: 7200, garageSpaces: 1, hasBasement: false, beforeSalePrice: 432000, consensusUplift: 56000, upliftRatio: 1.06, appreciationPercent: 5.8, holdingMonths: 11, afterDate: '2026-02-18T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'paint_exterior'], conditionScore: 6.1, rentYield: 0.057, rentLift: 180 }),
        buildFixtureComparable({ address: '2207 Thornton Rd', zipCode: '78704', state: 'TX', city: 'Austin', sqft: 1745, beds: 3, baths: 2, yearBuilt: 1991, lotSizeSqFt: 6900, garageSpaces: 1, hasBasement: false, beforeSalePrice: 448000, consensusUplift: 59000, upliftRatio: 1.09, appreciationPercent: 5.8, holdingMonths: 12, afterDate: '2026-01-11T00:00:00.000Z', categories: ['kitchen', 'flooring', 'paint_interior'], conditionScore: 5.9, rentYield: 0.058, rentLift: 195 }),
        buildFixtureComparable({ address: '2609 Del Curto Rd', zipCode: '78704', state: 'TX', city: 'Austin', sqft: 1820, beds: 3, baths: 2.5, yearBuilt: 1994, lotSizeSqFt: 7050, garageSpaces: 2, hasBasement: false, beforeSalePrice: 469000, consensusUplift: 64000, upliftRatio: 1.07, appreciationPercent: 5.8, holdingMonths: 13, afterDate: '2026-03-14T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'windows'], conditionScore: 5.7, rentYield: 0.057, rentLift: 205 }),
        buildFixtureComparable({ address: '1705 South 2nd St', zipCode: '78704', state: 'TX', city: 'Austin', sqft: 1910, beds: 4, baths: 2.5, yearBuilt: 1986, lotSizeSqFt: 7600, garageSpaces: 1, hasBasement: false, beforeSalePrice: 488000, consensusUplift: 68000, upliftRatio: 1.11, appreciationPercent: 5.8, holdingMonths: 10, afterDate: '2025-12-19T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'deck_patio'], conditionScore: 5.6, rentYield: 0.056, rentLift: 212 }),
        buildFixtureComparable({ address: '2406 Bluebonnet Ln', zipCode: '78704', state: 'TX', city: 'Austin', sqft: 1995, beds: 4, baths: 3, yearBuilt: 1998, lotSizeSqFt: 7800, garageSpaces: 2, hasBasement: false, beforeSalePrice: 512000, consensusUplift: 72000, upliftRatio: 1.1, appreciationPercent: 5.8, holdingMonths: 14, afterDate: '2026-04-02T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'hvac'], conditionScore: 5.5, rentYield: 0.055, rentLift: 228 }),
        buildFixtureComparable({ address: '1508 Hether St', zipCode: '78704', state: 'TX', city: 'Austin', sqft: 1865, beds: 3, baths: 2.5, yearBuilt: 1990, lotSizeSqFt: 7150, garageSpaces: 1, hasBasement: false, beforeSalePrice: 456000, consensusUplift: 61500, upliftRatio: 1.08, appreciationPercent: 5.8, holdingMonths: 12, afterDate: '2026-02-08T00:00:00.000Z', categories: ['bathroom', 'flooring', 'paint_interior'], conditionScore: 5.8, rentYield: 0.057, rentLift: 188 }),
        buildFixtureComparable({ address: '2002 Rabb Rd', zipCode: '78704', state: 'TX', city: 'Austin', sqft: 2050, beds: 4, baths: 3, yearBuilt: 1996, lotSizeSqFt: 8050, garageSpaces: 2, hasBasement: false, beforeSalePrice: 538000, consensusUplift: 74500, upliftRatio: 1.09, appreciationPercent: 5.8, holdingMonths: 15, afterDate: '2026-03-29T00:00:00.000Z', categories: ['kitchen', 'bathroom', 'roof'], conditionScore: 5.4, rentYield: 0.055, rentLift: 236 }),
      ],
    },
  ];
}

function getConsensusUplift(record) {
  return (record.renovationBreakdown || []).reduce(
    (sum, item) => sum + safeNum(item?.consensusUplift, 0),
    0,
  );
}

function buildSubjectProfile(record) {
  return {
    sqft: safeNum(record.sqft, 0),
    beds: safeNum(record.beds, 0),
    baths: safeNum(record.baths, 0),
    yearBuilt: safeNum(record.yearBuilt, 0),
    propertyType: record.propertyType || 'Residential',
    zipCode: record.zipCode || null,
    state: record.state || null,
    city: record.city || null,
    lotSizeSqFt: safeNum(record.lotSizeSqFt, 0),
    garageSpaces: safeNum(record.garageSpaces, 0),
    hasBasement: Boolean(record.hasBasement),
    conditionScore: safeNum(record.beforeCondition?.overall, 0),
    currentValue: safeNum(record.beforeSalePrice, 0),
    currentRent: safeNum(record.rentAnalysis?.rentBefore, 0),
  };
}

function createMetricAccumulator(samples, actualKey, uncalKey, calKey, options = {}) {
  const withActual = samples.filter((sample) => Number.isFinite(sample[actualKey]));
  if (withActual.length === 0) {
    return {
      count: 0,
      uncalibratedMae: null,
      calibratedMae: null,
      maeImprovementPct: null,
      uncalibratedMape: null,
      calibratedMape: null,
      mapeImprovementPct: null,
      uncalibratedCoveragePct: null,
      calibratedCoveragePct: null,
    };
  }

  const mae = (predictionKey) => {
    const errors = withActual.map((sample) => Math.abs(sample[predictionKey] - sample[actualKey]));
    return errors.reduce((sum, value) => sum + value, 0) / errors.length;
  };

  const mape = (predictionKey) => {
    const ratios = withActual
      .filter((sample) => Math.abs(sample[actualKey]) > 0)
      .map((sample) => Math.abs(sample[predictionKey] - sample[actualKey]) / Math.abs(sample[actualKey]));
    if (ratios.length === 0) return null;
    return (ratios.reduce((sum, value) => sum + value, 0) / ratios.length) * 100;
  };

  const coverage = (lowKey, highKey) => {
    if (!lowKey || !highKey) return null;
    const hits = withActual.filter((sample) => sample[actualKey] >= sample[lowKey] && sample[actualKey] <= sample[highKey]);
    return (hits.length / withActual.length) * 100;
  };

  const uncalibratedMae = mae(uncalKey);
  const calibratedMae = mae(calKey);
  const uncalibratedMape = mape(uncalKey);
  const calibratedMape = mape(calKey);

  return {
    count: withActual.length,
    uncalibratedMae,
    calibratedMae,
    maeImprovementPct: uncalibratedMae > 0
      ? ((uncalibratedMae - calibratedMae) / uncalibratedMae) * 100
      : null,
    uncalibratedMape,
    calibratedMape,
    mapeImprovementPct: uncalibratedMape && uncalibratedMape > 0
      ? ((uncalibratedMape - calibratedMape) / uncalibratedMape) * 100
      : null,
    uncalibratedCoveragePct: coverage(options.uncalibratedLowKey, options.uncalibratedHighKey),
    calibratedCoveragePct: coverage(options.calibratedLowKey, options.calibratedHighKey),
  };
}

function summarizeCohort(cohort) {
  const validRecords = cohort.records.filter((record) => (
    safeNum(record.afterSalePrice, 0) > 0
    && safeNum(record.beforeSalePrice, 0) > 0
    && Array.isArray(record.renovationBreakdown)
    && record.renovationBreakdown.length > 0
  ));

  const holdoutSamples = [];

  for (let index = 0; index < validRecords.length; index += 1) {
    const subject = validRecords[index];
    const training = validRecords.filter((_, candidateIndex) => candidateIndex !== index);
    if (training.length < 5) {
      continue;
    }

    const calibration = deriveLocalCalibration(training);
    const consensusUplift = getConsensusUplift(subject);
    const actualUplift = safeNum(subject.renovationAttributedUplift, 0);
    const calibrationFactor = safeNum(calibration.localFactorClipped, 1);

    const uncalibratedValuation = buildSalesComparisonValuation({
      upliftResults: training,
      subjectProfile: buildSubjectProfile(subject),
      applyLocalCalibration: false,
    });

    const calibratedValuation = buildSalesComparisonValuation({
      upliftResults: training,
      subjectProfile: buildSubjectProfile(subject),
      applyLocalCalibration: true,
    });

    const actualPremium = safeNum(subject.afterSalePrice, 0) - safeNum(subject.beforeSalePrice, 0);

    holdoutSamples.push({
      address: subject.address,
      actualUplift,
      directUncalibratedUplift: consensusUplift,
      directCalibratedUplift: consensusUplift * calibrationFactor,
      actualPremium,
      valuationUncalibratedPremium: safeNum(uncalibratedValuation?.coreArv?.base, 0) - safeNum(subject.beforeSalePrice, 0),
      valuationCalibratedPremium: safeNum(calibratedValuation?.coreArv?.base, 0) - safeNum(subject.beforeSalePrice, 0),
      valuationUncalibratedPremiumLow: safeNum(uncalibratedValuation?.coreArv?.low, 0) - safeNum(subject.beforeSalePrice, 0),
      valuationUncalibratedPremiumHigh: safeNum(uncalibratedValuation?.coreArv?.high, 0) - safeNum(subject.beforeSalePrice, 0),
      valuationCalibratedPremiumLow: safeNum(calibratedValuation?.coreArv?.low, 0) - safeNum(subject.beforeSalePrice, 0),
      valuationCalibratedPremiumHigh: safeNum(calibratedValuation?.coreArv?.high, 0) - safeNum(subject.beforeSalePrice, 0),
      actualAfterSalePrice: safeNum(subject.afterSalePrice, 0),
      valuationUncalibratedArv: safeNum(uncalibratedValuation?.coreArv?.base, 0),
      valuationCalibratedArv: safeNum(calibratedValuation?.coreArv?.base, 0),
      calibrationFactor,
      calibrationAvailable: Boolean(calibration.available),
      calibrationQuality: calibration.quality,
      trainingSampleSize: training.length,
    });
  }

  const directUplift = createMetricAccumulator(
    holdoutSamples,
    'actualUplift',
    'directUncalibratedUplift',
    'directCalibratedUplift',
  );

  const valuationPremium = createMetricAccumulator(
    holdoutSamples,
    'actualPremium',
    'valuationUncalibratedPremium',
    'valuationCalibratedPremium',
    {
      uncalibratedLowKey: 'valuationUncalibratedPremiumLow',
      uncalibratedHighKey: 'valuationUncalibratedPremiumHigh',
      calibratedLowKey: 'valuationCalibratedPremiumLow',
      calibratedHighKey: 'valuationCalibratedPremiumHigh',
    },
  );

  const valuationArv = createMetricAccumulator(
    holdoutSamples,
    'actualAfterSalePrice',
    'valuationUncalibratedArv',
    'valuationCalibratedArv',
  );

  const factorValues = holdoutSamples.map((sample) => sample.calibrationFactor).filter((value) => Number.isFinite(value));
  const avgFactor = factorValues.length > 0
    ? factorValues.reduce((sum, value) => sum + value, 0) / factorValues.length
    : null;

  const stableOrModerateCount = holdoutSamples.filter((sample) => sample.calibrationQuality === 'stable' || sample.calibrationQuality === 'moderate_drift').length;

  return {
    label: cohort.label,
    source: cohort.source,
    zipCode: cohort.zipCode || null,
    comparableCount: validRecords.length,
    holdoutCount: holdoutSamples.length,
    averageCalibrationFactor: avgFactor,
    calibrationAvailableCount: holdoutSamples.filter((sample) => sample.calibrationAvailable).length,
    calibrationStableOrModerateCount: stableOrModerateCount,
    directUplift,
    valuationPremium,
    valuationArv,
    worstHoldouts: [...holdoutSamples]
      .sort((left, right) => Math.abs(right.valuationCalibratedPremium - right.actualPremium) - Math.abs(left.valuationCalibratedPremium - left.actualPremium))
      .slice(0, 3)
      .map((sample) => ({
        address: sample.address,
        actualPremium: sample.actualPremium,
        uncalibratedPremium: sample.valuationUncalibratedPremium,
        calibratedPremium: sample.valuationCalibratedPremium,
        calibrationFactor: sample.calibrationFactor,
      })),
  };
}

async function loadLiveCohorts(zipCodes, limit) {
  if (!zipCodes.length) {
    return { cohorts: [], warnings: [] };
  }

  try {
    const processorModule = await import('./renovation/processor.js');
    const cohorts = [];
    const warnings = [];

    for (const zipCode of zipCodes) {
      const rows = await processorModule.getAreaComparables(zipCode, { limit });
      if (rows.length < MIN_SAMPLE_SIZE) {
        warnings.push(`ZIP ${zipCode}: only ${rows.length} comparable(s) available; need at least ${MIN_SAMPLE_SIZE}`);
        continue;
      }

      cohorts.push({
        label: `live-${zipCode}`,
        source: 'firestore',
        zipCode,
        records: rows,
      });
    }

    return { cohorts, warnings };
  } catch (error) {
    return {
      cohorts: [],
      warnings: [`Live comparable load failed: ${error.message}`],
    };
  }
}

function printMetricBlock(label, metrics, currency = true, includeCoverage = false) {
  if (!metrics || metrics.count === 0) {
    console.log(`  ${label}: insufficient samples`);
    return;
  }

  const formatter = currency ? formatCurrency : (value) => formatPercent(value, 1);
  console.log(`  ${label}:`);
  console.log(`    Uncalibrated MAE: ${formatter(metrics.uncalibratedMae)} | Calibrated MAE: ${formatter(metrics.calibratedMae)} | Improvement: ${formatPercent(metrics.maeImprovementPct ?? 0, 1)}`);
  if (metrics.uncalibratedMape != null && metrics.calibratedMape != null) {
    console.log(`    Uncalibrated MAPE: ${formatPercent(metrics.uncalibratedMape, 1)} | Calibrated MAPE: ${formatPercent(metrics.calibratedMape, 1)} | Improvement: ${formatPercent(metrics.mapeImprovementPct ?? 0, 1)}`);
  }
  if (includeCoverage && metrics.uncalibratedCoveragePct != null && metrics.calibratedCoveragePct != null) {
    console.log(`    Coverage: ${formatPercent(metrics.uncalibratedCoveragePct, 1)} -> ${formatPercent(metrics.calibratedCoveragePct, 1)}`);
  }
}

function printSummary(results, warnings) {
  console.log('Phase 5 renovation calibration and backtesting');
  console.log('============================================');

  if (warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
    console.log('');
  }

  for (const result of results) {
    console.log(`${result.label} (${result.source}${result.zipCode ? `, ZIP ${result.zipCode}` : ''})`);
    console.log(`  Comparables: ${result.comparableCount} | Holdout runs: ${result.holdoutCount}`);
    console.log(`  Average calibration factor: ${result.averageCalibrationFactor ? result.averageCalibrationFactor.toFixed(3) : 'n/a'}`);
    console.log(`  Calibration available: ${result.calibrationAvailableCount}/${result.holdoutCount} | Stable/moderate drift: ${result.calibrationStableOrModerateCount}/${result.holdoutCount}`);
    printMetricBlock('Direct uplift holdout', result.directUplift, true, false);
    printMetricBlock('Valuation premium holdout', result.valuationPremium, true, true);
    printMetricBlock('Valuation ARV holdout', result.valuationArv, true, false);
    if (result.worstHoldouts.length > 0) {
      console.log('  Largest calibrated premium misses:');
      for (const sample of result.worstHoldouts) {
        console.log(`    ${sample.address}: actual ${formatCurrency(sample.actualPremium)}, calibrated ${formatCurrency(sample.calibratedPremium)}, uncalibrated ${formatCurrency(sample.uncalibratedPremium)}, factor ${sample.calibrationFactor.toFixed(3)}`);
      }
    }
    console.log('');
  }

  const aggregate = results.reduce((accumulator, result) => {
    accumulator.holdoutCount += result.holdoutCount;
    accumulator.directUncalibratedMae += safeNum(result.directUplift.uncalibratedMae, 0) * result.directUplift.count;
    accumulator.directCalibratedMae += safeNum(result.directUplift.calibratedMae, 0) * result.directUplift.count;
    accumulator.premiumUncalibratedMae += safeNum(result.valuationPremium.uncalibratedMae, 0) * result.valuationPremium.count;
    accumulator.premiumCalibratedMae += safeNum(result.valuationPremium.calibratedMae, 0) * result.valuationPremium.count;
    accumulator.arvUncalibratedMae += safeNum(result.valuationArv.uncalibratedMae, 0) * result.valuationArv.count;
    accumulator.arvCalibratedMae += safeNum(result.valuationArv.calibratedMae, 0) * result.valuationArv.count;
    accumulator.directCount += result.directUplift.count;
    accumulator.premiumCount += result.valuationPremium.count;
    accumulator.arvCount += result.valuationArv.count;
    return accumulator;
  }, {
    holdoutCount: 0,
    directUncalibratedMae: 0,
    directCalibratedMae: 0,
    premiumUncalibratedMae: 0,
    premiumCalibratedMae: 0,
    arvUncalibratedMae: 0,
    arvCalibratedMae: 0,
    directCount: 0,
    premiumCount: 0,
    arvCount: 0,
  });

  if (aggregate.holdoutCount > 0) {
    const overallDirectUncalibratedMae = aggregate.directCount > 0 ? aggregate.directUncalibratedMae / aggregate.directCount : 0;
    const overallDirectCalibratedMae = aggregate.directCount > 0 ? aggregate.directCalibratedMae / aggregate.directCount : 0;
    const overallPremiumUncalibratedMae = aggregate.premiumCount > 0 ? aggregate.premiumUncalibratedMae / aggregate.premiumCount : 0;
    const overallPremiumCalibratedMae = aggregate.premiumCount > 0 ? aggregate.premiumCalibratedMae / aggregate.premiumCount : 0;
    const overallArvUncalibratedMae = aggregate.arvCount > 0 ? aggregate.arvUncalibratedMae / aggregate.arvCount : 0;
    const overallArvCalibratedMae = aggregate.arvCount > 0 ? aggregate.arvCalibratedMae / aggregate.arvCount : 0;

    console.log('Overall');
    console.log(`  Total holdout runs: ${aggregate.holdoutCount}`);
    console.log(`  Direct uplift MAE: ${formatCurrency(overallDirectUncalibratedMae)} -> ${formatCurrency(overallDirectCalibratedMae)}`);
    console.log(`  Valuation premium MAE: ${formatCurrency(overallPremiumUncalibratedMae)} -> ${formatCurrency(overallPremiumCalibratedMae)}`);
    console.log(`  Valuation ARV MAE: ${formatCurrency(overallArvUncalibratedMae)} -> ${formatCurrency(overallArvCalibratedMae)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const warnings = [];
  let cohorts = [];

  if (!options.fixtureOnly && options.zipCodes.length > 0) {
    const live = await loadLiveCohorts(options.zipCodes, options.limit);
    cohorts = live.cohorts;
    warnings.push(...live.warnings);
  }

  if (cohorts.length === 0) {
    cohorts = buildFixtureCohorts();
    if (options.zipCodes.length > 0 && !options.fixtureOnly) {
      warnings.push('Falling back to local fixtures because no live cohort met the minimum comparable threshold.');
    }
  }

  const summaries = cohorts
    .map(summarizeCohort)
    .filter((summary) => summary.holdoutCount > 0);

  if (summaries.length === 0) {
    console.error('No cohorts produced enough holdout samples to backtest.');
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({ warnings, summaries }, null, 2));
    return;
  }

  printSummary(summaries, warnings);
}

main().catch((error) => {
  console.error('Backtest failed:', error.message);
  process.exit(1);
});