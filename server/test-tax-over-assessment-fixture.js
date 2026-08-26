/**
 * Fixture tests for tax over-assessment engine (pure, no API calls).
 *
 * Run: node server/test-tax-over-assessment-fixture.js
 */

import {
  analyzeOverAssessment,
  detectPhaseIn,
  estimateMarketValue,
  selectEquityComps,
} from './services/taxOverAssessmentEngine.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

function makeComp(overrides = {}) {
  return {
    address: overrides.address || '100 Comp St',
    assessed: overrides.assessed ?? 300000,
    mvEst: overrides.mvEst ?? 400000,
    sqft: overrides.sqft ?? 1500,
    yearBuilt: overrides.yearBuilt ?? 1970,
    distanceMiles: overrides.distanceMiles ?? 0.5,
    propertyType: overrides.propertyType || 'SINGLE FAMILY RESIDENCE',
    sameJurisdiction: overrides.sameJurisdiction !== false,
  };
}

console.log('\n1. Phase-in detection must suppress when final not excessive');
{
  // Mid-cycle phase-in: two equal steps so far; one more projected.
  // Final target (~340k) matches comp median ratio → suppress.
  const history = [
    { year: 2023, assessed_total: 300000 },
    { year: 2024, assessed_total: 320000 },
  ];
  const phase = detectPhaseIn(history, 3);
  assert(phase.phaseIn === true, 'detects equal-step phase-in');

  const comps = Array.from({ length: 8 }, (_, i) => makeComp({
    address: `${100 + i} Comp St`,
    assessed: 340000,
    mvEst: 400000, // ratio 0.85 — matches projected final 340k / 400k
    distanceMiles: 0.3 + i * 0.1,
  }));

  const result = analyzeOverAssessment({
    state: 'MD',
    fips: '24033',
    subject: {
      address: '1 Subject St',
      assessedValue: 320000,
      taxAmount: 3200,
      sqft: 1500,
      yearBuilt: 1970,
      propertyType: 'SINGLE FAMILY RESIDENCE',
      taxHistory: history,
    },
    marketValueEstimators: {
      attomAvm: 400000,
      attomAvmLow: 380000,
      attomAvmHigh: 420000,
      rentcastEstimate: 405000,
    },
    comps,
  });

  assert(
    result.suppression_reasons.includes('phase_in_not_excessive_at_final'),
    'phase-in suppresses when final not excessive',
  );
  assert(result.flag === 'none', 'phase-in property flag is none');
}

console.log('\n2. Property assessed below comp median must never flag');
{
  const comps = Array.from({ length: 8 }, (_, i) => makeComp({
    address: `${200 + i} Comp St`,
    assessed: 400000, // high assessed vs MV → high ratio
    mvEst: 400000,
    distanceMiles: 0.4 + i * 0.05,
  }));

  const result = analyzeOverAssessment({
    state: 'MD',
    fips: '24033',
    subject: {
      address: '2 Subject St',
      assessedValue: 280000, // BELOW comps
      taxAmount: 2800,
      sqft: 1500,
      yearBuilt: 1970,
      propertyType: 'SINGLE FAMILY RESIDENCE',
    },
    marketValueEstimators: {
      attomAvm: 400000,
      attomAvmHigh: 420000,
      rentcastEstimate: 400000,
    },
    comps,
  });

  assert(result.equity_excess_pct != null && result.equity_excess_pct <= 0, 'equity excess ≤ 0');
  assert(result.flag === 'none', 'below-median never flags');
  assert(result.annual_savings_low === 0 && result.annual_savings_high === 0, 'no savings when none');
}

console.log('\n3. Savings must floor at zero');
{
  const comps = Array.from({ length: 8 }, (_, i) => makeComp({
    address: `${300 + i} Comp St`,
    assessed: 350000,
    mvEst: 400000,
    distanceMiles: 0.5,
  }));

  const result = analyzeOverAssessment({
    state: 'MD',
    fips: '24033',
    subject: {
      address: '3 Subject St',
      assessedValue: 300000, // justified would be higher than assessed in some bands
      taxAmount: 3000,
      sqft: 1500,
      yearBuilt: 1970,
      propertyType: 'SINGLE FAMILY RESIDENCE',
    },
    marketValueEstimators: {
      attomAvm: 500000,
      attomAvmLow: 480000,
      attomAvmHigh: 520000,
      rentcastEstimate: 500000,
    },
    comps,
  });

  assert(result.annual_savings_low >= 0, 'annual_savings_low ≥ 0');
  assert(result.annual_savings_high >= 0, 'annual_savings_high ≥ 0');
}

console.log('\n4. N < 5 comps must suppress');
{
  const comps = Array.from({ length: 3 }, (_, i) => makeComp({
    address: `${400 + i} Comp St`,
    assessed: 450000,
    mvEst: 400000,
    distanceMiles: 0.5,
  }));

  const result = analyzeOverAssessment({
    state: 'MD',
    fips: '24033',
    subject: {
      address: '4 Subject St',
      assessedValue: 500000,
      taxAmount: 5000,
      sqft: 1500,
      yearBuilt: 1970,
      propertyType: 'SINGLE FAMILY RESIDENCE',
    },
    marketValueEstimators: {
      attomAvm: 400000,
      attomAvmHigh: 410000,
      rentcastEstimate: 400000,
    },
    comps,
  });

  assert(result.suppression_reasons.includes('insufficient_comps'), 'insufficient_comps suppression');
  assert(result.flag === 'none', 'flag none when N < 5');
}

console.log('\n5. Strong equity excess with enough comps can flag moderate/strong');
{
  // Subject heavily over-assessed vs comps
  const comps = Array.from({ length: 8 }, (_, i) => makeComp({
    address: `${500 + i} Comp St`,
    assessed: 300000,
    mvEst: 400000, // ratio 0.75
    sqft: 1500,
    distanceMiles: 0.3 + i * 0.1,
  }));

  const result = analyzeOverAssessment({
    state: 'MD',
    fips: '24033',
    subject: {
      address: '5 Subject St',
      assessedValue: 480000, // ratio 480/400 = 1.2 → excess 60%
      taxAmount: 4800,
      sqft: 1500,
      yearBuilt: 1970,
      propertyType: 'SINGLE FAMILY RESIDENCE',
    },
    marketValueEstimators: {
      attomAvm: 400000,
      attomAvmLow: 380000,
      attomAvmHigh: 420000,
      rentcastEstimate: 400000,
    },
    comps,
  });

  assert(result.equity_excess_pct >= 15, `equity excess ≥ 15% (got ${result.equity_excess_pct})`);
  assert(result.flag === 'strong' || result.flag === 'moderate', `flags strong/moderate (got ${result.flag})`);
  assert(result.annual_savings_low > 0, 'savings low > 0 when flagged');
  assert(result.annual_savings_low <= result.annual_savings_high, 'savings low ≤ high');
  assert(result.narrative.includes('Flagged for review'), 'narrative says flagged for review');
  assert(result.disclaimer.includes('not legal or tax advice'), 'disclaimer present');
}

console.log('\n6. Low-confidence MV disagreement suppresses');
{
  const comps = Array.from({ length: 8 }, (_, i) => makeComp({
    address: `${600 + i} Comp St`,
    assessed: 300000,
    mvEst: 400000,
    distanceMiles: 0.4,
  }));

  const mv = estimateMarketValue({
    attomAvm: 300000,
    attomAvmConfidence: 'low',
    rentcastEstimate: 450000, // >20% disagreement
  });
  assert(mv.lowConfidence === true, 'estimators disagree → lowConfidence');

  const result = analyzeOverAssessment({
    state: 'MD',
    fips: '24033',
    subject: {
      address: '6 Subject St',
      assessedValue: 500000,
      taxAmount: 5000,
      sqft: 1500,
      yearBuilt: 1970,
      propertyType: 'SINGLE FAMILY RESIDENCE',
    },
    marketValueEstimators: {
      attomAvm: 300000,
      attomAvmConfidence: 'low',
      rentcastEstimate: 450000,
    },
    comps,
  });

  assert(result.suppression_reasons.includes('low_confidence_market_value'), 'low confidence suppresses');
  assert(result.flag === 'none', 'no flag when low confidence');
}

console.log('\n7. Comp selection expands radius and filters jurisdiction');
{
  const comps = [
    makeComp({ address: 'Near', distanceMiles: 0.5, assessed: 300000, mvEst: 400000 }),
    makeComp({ address: 'Far', distanceMiles: 2.5, assessed: 300000, mvEst: 400000 }),
    makeComp({ address: 'Other county', distanceMiles: 0.5, sameJurisdiction: false, assessed: 300000, mvEst: 400000 }),
  ];
  // pad to get enough at 3mi
  for (let i = 0; i < 6; i += 1) {
    comps.push(makeComp({
      address: `Pad ${i}`,
      distanceMiles: 2.2,
      assessed: 310000,
      mvEst: 400000,
    }));
  }

  const selected = selectEquityComps(
    { sqft: 1500, yearBuilt: 1970, propertyType: 'SINGLE FAMILY RESIDENCE' },
    comps,
    { minComps: 7, absoluteMinComps: 5 },
  );
  assert(selected.count >= 7, `expanded to ≥7 comps (got ${selected.count})`);
  assert(!selected.comps.some((c) => c.address === 'Other county'), 'excludes other jurisdiction');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Tax over-assessment fixtures: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
