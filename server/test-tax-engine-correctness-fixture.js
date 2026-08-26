/**
 * Tax engine correctness regression fixture
 * ==========================================
 * Covers the two production-readiness fixes:
 *   1. IRC §280A mixed-use proration (on / off / low-confidence gating)
 *   2. State withholding application (applied vs absent, manual vs derived source)
 *
 * Follows the same standalone-script pattern as server/test-tax-export-fixture.js:
 * runs with plain node, throws on mismatch, exits non-zero on failure.
 */

import { getTaxRulesetPackage } from '../src/shared/taxRules.js';
import {
  calculateDepreciation,
  calculateQuarterlyEstimate,
  calculateTaxLiability,
  generateScheduleE,
} from './tax-engine.js';

const TAX_YEAR = 2025;
const ruleset = getTaxRulesetPackage(TAX_YEAR);

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function assertEqual(actual, expected, label) {
  const normalize = (value) => (typeof value === 'number' ? roundCurrency(value) : value);
  if (normalize(actual) !== normalize(expected)) {
    throw new Error(`Tax engine fixture mismatch: ${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertTrue(condition, label) {
  if (!condition) {
    throw new Error(`Tax engine fixture mismatch: ${label}`);
  }
}

function buildEntries(propertyId) {
  return [
    { date: `${TAX_YEAR}-01-05`, amount: 24000, type: 'income', category: 'Rental Income', description: 'Annual rent', vendor: '', propertyId },
    { date: `${TAX_YEAR}-03-10`, amount: 1000, type: 'expense', category: 'Repairs', description: 'Repairs', vendor: 'Fixture Repairs Co', propertyId },
    { date: `${TAX_YEAR}-06-15`, amount: 2000, type: 'expense', category: 'Utilities', description: 'Utilities', vendor: 'Fixture Utility Co', propertyId },
    { date: `${TAX_YEAR}-09-20`, amount: 3000, type: 'expense', category: 'Property Taxes', description: 'Property taxes', vendor: 'County', propertyId },
  ];
}

function buildProperty(overrides = {}) {
  return {
    id: 'fixture-prop-1',
    propertyName: '101 Fixture Lane',
    address: '101 Fixture Lane',
    state: 'MD',
    purchasePrice: 300000,
    landValue: 60000,
    purchaseDate: '2020-01-15',
    fairRentalDays: 365,
    personalUseDays: 0,
    ...overrides,
  };
}

// ─── Scenario A: §280A OFF (no personal use) ────────────────────────────────
function testPersonalUseOff() {
  const property = buildProperty();
  const entries = buildEntries(property.id);
  const scheduleE = generateScheduleE(entries, TAX_YEAR, null, [property], ruleset);

  assertEqual(scheduleE.personalUseAdjustment.applied, false, 'A: personalUseAdjustment.applied');
  assertEqual(scheduleE.personalUseAdjustment.lowConfidence, false, 'A: personalUseAdjustment.lowConfidence');
  assertEqual(scheduleE.summary.totalIncome, 24000, 'A: summary.totalIncome');
  assertEqual(scheduleE.summary.totalExpenses, 6000, 'A: summary.totalExpenses');
  assertEqual(scheduleE.summary.netIncomeOrLoss, 18000, 'A: summary.netIncomeOrLoss');
  assertEqual(scheduleE.scheduleELines.REPAIRS.amount, 1000, 'A: REPAIRS untouched');
  assertEqual(scheduleE.propertySummaries[0].personalUseRule.applies, false, 'A: property rule does not apply');

  const depreciation = calculateDepreciation([property], TAX_YEAR, ruleset);
  const liability = calculateTaxLiability(
    { taxYear: TAX_YEAR, filingStatus: 'single', otherIncome: 90000, homeState: 'MD' },
    scheduleE,
    depreciation,
    ruleset,
  );

  assertEqual(liability.personalUseAdjustment.applies, false, 'A: liability personalUseAdjustment.applies');
  assertEqual(liability.income.depreciation, liability.income.depreciationBeforePersonalUse, 'A: depreciation not prorated');
  assertEqual(liability.personalUseAdjustment.depreciation.disallowed, 0, 'A: no depreciation disallowed');
  assertTrue(
    !liability.modelingReadiness.blockers.some((blocker) => blocker.includes('280A')),
    'A: no §280A readiness blocker',
  );
}

// ─── Scenario B: §280A ON with explicit day counts (high confidence) ────────
function testPersonalUseOnHighConfidence() {
  // 30 personal days > 14 and > 10% of 270 fair rental days → rule applies.
  // Rental-use fraction = 270 / (270 + 30) = 0.90.
  const property = buildProperty({ fairRentalDays: 270, personalUseDays: 30 });
  const entries = buildEntries(property.id);
  const scheduleE = generateScheduleE(entries, TAX_YEAR, null, [property], ruleset);

  assertEqual(scheduleE.personalUseAdjustment.applied, true, 'B: personalUseAdjustment.applied');
  assertEqual(scheduleE.personalUseAdjustment.lowConfidence, false, 'B: high confidence with explicit days');
  assertEqual(scheduleE.personalUseAdjustment.properties[0].rentalUsePct, 90, 'B: rentalUsePct');

  // Income is never prorated; expenses are prorated to 90%.
  assertEqual(scheduleE.scheduleELines.RENTS_RECEIVED.amount, 24000, 'B: income untouched');
  assertEqual(scheduleE.scheduleELines.REPAIRS.amount, 900, 'B: REPAIRS prorated');
  assertEqual(scheduleE.scheduleELines.UTILITIES.amount, 1800, 'B: UTILITIES prorated');
  assertEqual(scheduleE.scheduleELines.TAXES.amount, 2700, 'B: TAXES prorated');
  assertEqual(scheduleE.summary.totalExpenses, 5400, 'B: prorated totalExpenses');
  assertEqual(scheduleE.summary.netIncomeOrLoss, 18600, 'B: prorated netIncomeOrLoss');
  assertEqual(scheduleE.personalUseAdjustment.totalDisallowedExpenses, 600, 'B: total disallowed expenses');
  assertEqual(scheduleE.personalUseAdjustment.byLine.REPAIRS.before, 1000, 'B: byLine before amount');
  assertEqual(scheduleE.personalUseAdjustment.byLine.REPAIRS.after, 900, 'B: byLine after amount');
  assertTrue(scheduleE.personalUseAdjustment.notes.length > 0, 'B: proration notes present');
  assertTrue(
    scheduleE.scheduleELines.REPAIRS.entries.every((entry) => entry.personalUseProrated && entry.fullAmount > entry.amount),
    'B: entry-level proration flags present',
  );

  const depreciation = calculateDepreciation([property], TAX_YEAR, ruleset);
  const liability = calculateTaxLiability(
    { taxYear: TAX_YEAR, filingStatus: 'single', otherIncome: 90000, homeState: 'MD' },
    scheduleE,
    depreciation,
    ruleset,
  );

  const depreciationBefore = depreciation.summary.totalCurrentYearDepreciation;
  assertTrue(depreciationBefore > 0, 'B: fixture produces depreciation');
  assertEqual(liability.income.depreciationBeforePersonalUse, depreciationBefore, 'B: depreciation before proration');
  assertEqual(liability.income.depreciation, roundCurrency(depreciationBefore * 0.9), 'B: depreciation prorated to 90%');
  assertEqual(
    liability.personalUseAdjustment.depreciation.disallowed,
    roundCurrency(depreciationBefore - roundCurrency(depreciationBefore * 0.9)),
    'B: depreciation disallowed amount',
  );
  assertTrue(
    liability.modelingReadiness.warnings.some((warning) => warning.includes('280A')),
    'B: §280A proration surfaced as readiness warning',
  );
  assertTrue(liability.modelingReadiness.status !== 'estimate_only', 'B: high-confidence proration is not gated');
  assertTrue(
    liability.personalUseAdjustment.notes.some((note) => note.includes('Depreciation was prorated')),
    'B: explicit depreciation proration note',
  );
}

// ─── Scenario C: §280A ON with defaulted rental days (low confidence gate) ──
function testPersonalUseLowConfidenceGate() {
  // No explicit fairRentalDays → engine falls back to the 365-day default, so
  // the allocation is low confidence and the output must be hard-gated.
  const property = buildProperty({ fairRentalDays: undefined, personalUseDays: 60 });
  const entries = buildEntries(property.id);
  const scheduleE = generateScheduleE(entries, TAX_YEAR, null, [property], ruleset);

  assertEqual(scheduleE.personalUseAdjustment.applied, true, 'C: proration still applied');
  assertEqual(scheduleE.personalUseAdjustment.lowConfidence, true, 'C: defaulted days flagged low confidence');

  const depreciation = calculateDepreciation([property], TAX_YEAR, ruleset);
  const liability = calculateTaxLiability(
    { taxYear: TAX_YEAR, filingStatus: 'single', otherIncome: 90000, homeState: 'MD' },
    scheduleE,
    depreciation,
    ruleset,
  );

  assertEqual(liability.modelingReadiness.status, 'estimate_only', 'C: readiness gated to estimate_only');
  assertTrue(
    liability.modelingReadiness.blockers.some((blocker) => blocker.includes('280A') && blocker.includes('low confidence')),
    'C: explicit low-confidence §280A blocker',
  );
}

// ─── Scenario D: state withholding applied vs absent (liability) ────────────
function testStateWithholdingLiability() {
  const property = buildProperty();
  const entries = buildEntries(property.id);
  const scheduleE = generateScheduleE(entries, TAX_YEAR, null, [property], ruleset);
  const depreciation = calculateDepreciation([property], TAX_YEAR, ruleset);
  const baseParams = { taxYear: TAX_YEAR, filingStatus: 'single', otherIncome: 90000, homeState: 'MD', withholdingYtd: 5000 };

  // Absent: nothing applied, payload says so explicitly.
  const withoutState = calculateTaxLiability(baseParams, scheduleE, depreciation, ruleset);
  assertEqual(withoutState.stateWithholding.provided, false, 'D: absent → provided false');
  assertEqual(withoutState.stateWithholding.source, null, 'D: absent → source null');
  assertEqual(withoutState.taxes.stateWithholdingApplied, 0, 'D: absent → nothing applied');
  assertEqual(withoutState.taxes.stateNetDue, withoutState.taxes.state, 'D: absent → state net due equals state tax');
  assertTrue(withoutState.taxes.state > 1000, 'D: fixture produces meaningful MD state tax');

  // Applied (partial): reduces the state portion and the combined netDue.
  const withState = calculateTaxLiability(
    { ...baseParams, stateWithholdingYtd: 1000, stateWithholdingSource: 'manual_input' },
    scheduleE,
    depreciation,
    ruleset,
  );
  assertEqual(withState.stateWithholding.provided, true, 'D: provided true');
  assertEqual(withState.stateWithholding.source, 'manual_input', 'D: source recorded');
  assertEqual(withState.stateWithholding.appliedAgainst, 'state_tax_only', 'D: applied against state tax only');
  assertEqual(withState.taxes.stateWithholdingApplied, 1000, 'D: full 1000 applied to state portion');
  assertEqual(withState.taxes.stateNetDue, roundCurrency(withState.taxes.state - 1000), 'D: state net due reduced');
  assertEqual(withState.taxes.netDue, roundCurrency(Math.max(0, withoutState.taxes.netDue - 1000)), 'D: combined netDue reduced by exactly the applied state withholding');
  assertEqual(withState.taxes.federal, withoutState.taxes.federal, 'D: federal tax unchanged by state withholding');
  assertEqual(withState.taxes.withholdingApplied, withoutState.taxes.withholdingApplied, 'D: federal withholding application unchanged');

  // Applied (overflow): capped at the state tax, remainder reported as state overpayment.
  const overflow = calculateTaxLiability(
    { ...baseParams, stateWithholdingYtd: 999999, stateWithholdingSource: 'confirmed_w2_documents' },
    scheduleE,
    depreciation,
    ruleset,
  );
  assertEqual(overflow.taxes.stateWithholdingApplied, overflow.taxes.state, 'D: overflow capped at state tax');
  assertEqual(overflow.taxes.stateNetDue, 0, 'D: overflow → zero state net due');
  assertEqual(overflow.taxes.stateOverpayment, roundCurrency(999999 - overflow.taxes.state), 'D: overflow reported as state overpayment');
  assertEqual(overflow.stateWithholding.source, 'confirmed_w2_documents', 'D: derived source propagated');
}

// ─── Scenario E: state withholding in the quarterly estimate ────────────────
function testStateWithholdingQuarterly() {
  const property = buildProperty();
  const entries = buildEntries(property.id);
  const depreciation = calculateDepreciation([property], TAX_YEAR, ruleset);
  const baseParams = {
    filingStatus: 'single',
    otherIncome: 90000,
    homeState: 'MD',
    withholdingYtd: 4000,
    annualDepreciation: depreciation.summary.totalCurrentYearDepreciation,
    projectionQuarter: 4,
  };

  const withoutState = calculateQuarterlyEstimate(entries, TAX_YEAR, 4, baseParams, ruleset);
  assertEqual(withoutState.stateWithholding.provided, false, 'E: absent → provided false');
  assertEqual(withoutState.annualized.projectedAnnualStateWithholding, 0, 'E: absent → zero state projection');
  assertEqual(withoutState.assumptions.stateWithholdingYtd, null, 'E: absent → null assumption echoed');

  const withState = calculateQuarterlyEstimate(
    entries,
    TAX_YEAR,
    4,
    { ...baseParams, stateWithholdingYtd: 800, stateWithholdingSource: 'draft_profile' },
    ruleset,
  );
  const expectedStateProjection = roundCurrency(Math.min(800, withState.estimatedTax.state * 4));
  assertEqual(withState.stateWithholding.provided, true, 'E: provided true');
  assertEqual(withState.stateWithholding.source, 'draft_profile', 'E: source recorded');
  assertEqual(withState.stateWithholding.treatment, 'tracked_separately_from_federal_1040es', 'E: separate federal voucher treatment is explicit');
  assertEqual(withState.assumptions.stateWithholdingYtd, 800, 'E: assumption echoed');
  assertEqual(withState.annualized.projectedAnnualStateWithholding, expectedStateProjection, 'E: state projection capped at state-tax layer');
  assertEqual(
    withState.annualized.projectedAnnualWithholding,
    withState.annualized.projectedAnnualFederalWithholding,
    'E: federal projected withholding excludes state withholding',
  );
  assertEqual(
    withState.annualized.combinedProjectedAnnualWithholding,
    roundCurrency(withState.annualized.projectedAnnualFederalWithholding + expectedStateProjection),
    'E: combined projected withholding is still reported for planning context',
  );
  assertEqual(
    withState.safeHarbor.requiredEstimatedPaymentsAnnual,
    roundCurrency(Math.max(0, withState.safeHarbor.selectedAnnualRequiredPayment - withState.annualized.projectedAnnualWithholding)),
    'E: required federal estimated payments net federal withholding only',
  );
  assertTrue(
    withState.safeHarbor.requiredEstimatedPaymentsAnnual === withoutState.safeHarbor.requiredEstimatedPaymentsAnnual,
    'E: state withholding does not change federal voucher requirement',
  );

  // §280A readiness flag on the quarterly path.
  const mixedUse = calculateQuarterlyEstimate(
    entries,
    TAX_YEAR,
    4,
    { ...baseParams, personalUseLimitedPropertyCount: 1 },
    ruleset,
  );
  assertTrue(
    mixedUse.readiness.warnings.some((warning) => warning.includes('280A')),
    'E: quarterly readiness warns about §280A mixed use',
  );
}

// ─── Scenario F: multi-state rental allocation is surfaced and gated ─────────
function testMultiStateRentalGating() {
  const marylandProperty = buildProperty();
  const virginiaProperty = buildProperty({
    id: 'fixture-prop-2',
    propertyName: '202 Example Road',
    address: '202 Example Road',
    state: 'VA',
    purchasePrice: 360000,
    landValue: 70000,
    purchaseDate: '2021-02-01',
  });
  const entries = [
    ...buildEntries(marylandProperty.id),
    ...buildEntries(virginiaProperty.id),
  ];
  const scheduleE = generateScheduleE(entries, TAX_YEAR, null, [marylandProperty, virginiaProperty], ruleset);
  const depreciation = calculateDepreciation([marylandProperty, virginiaProperty], TAX_YEAR, ruleset);
  const liability = calculateTaxLiability(
    { taxYear: TAX_YEAR, filingStatus: 'single', otherIncome: 90000, homeState: 'MD' },
    scheduleE,
    depreciation,
    ruleset,
  );

  assertEqual(liability.modelingReadiness.status, 'estimate_only', 'F: multi-state readiness gated to estimate_only');
  assertTrue(
    liability.modelingReadiness.blockers.some((blocker) => blocker.includes('multi-state filing footprint')),
    'F: multi-state blocker is explicit',
  );
  assertTrue(
    Array.isArray(liability.taxes.propertyStateAllocations) && liability.taxes.propertyStateAllocations.length === 2,
    'F: property state allocations are returned',
  );
  assertTrue(
    liability.taxes.propertyStateAllocations.some((state) => state.stateCode === 'MD'),
    'F: Maryland allocation present',
  );
  assertTrue(
    liability.taxes.propertyStateAllocations.some((state) => state.stateCode === 'VA'),
    'F: Virginia allocation present',
  );
}

try {
  testPersonalUseOff();
  testPersonalUseOnHighConfidence();
  testPersonalUseLowConfidenceGate();
  testStateWithholdingLiability();
  testStateWithholdingQuarterly();
  testMultiStateRentalGating();
  console.log('Tax engine correctness fixture passed: §280A proration on/off/gated, state withholding applied/absent, multi-state gating');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
