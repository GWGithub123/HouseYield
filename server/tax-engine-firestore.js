/**
 * Tax Engine for Firestore Backend
 * ================================
 * Unified tax calculation engine that works with Firestore journal entries.
 * Ports all functionality from SQLite-based tax-reports.js + tax-calculator.js
 * into the production Firestore backend with enhancements:
 * 
 * - Schedule E generation from Firestore journal entries
 * - Depreciation schedule with ATTOM auto-population
 * - Federal tax brackets with per-bracket breakdown
 * - State tax lookup (50 states + DC) 
 * - Passive loss analysis (§469)
 * - NIIT calculation (3.8%)
 * - Quarterly estimates using real brackets
 * - Missed deduction finder
 * - Year-over-year comparison
 * - Tax calendar with smart deadlines
 * - Dynamic mortgage interest/principal split
 */

import { STATE_TAX_RATES } from './state-tax-rates.js';
import { calculateQBIDeduction } from './tax-benefits-analyzer.js';
import {
  adjustTaxDeadlineToBusinessDay,
  DEPRECIATION_RULES,
  formatTax1099Threshold,
  getTaxRulesetPackage,
  getTax1099ThresholdSummary,
  getTaxDeadlineTemplates,
  SCHEDULE_E_LINE_MAP,
  STANDARD_DEDUCTION_2025,
  TAX_BRACKETS_2025
} from '../src/shared/taxRules.js';

function resolveTaxRuleset(taxYear, ruleset = null) {
  if (ruleset && typeof ruleset === 'object') {
    return ruleset;
  }

  return getTaxRulesetPackage(taxYear);
}

function getScheduleELineMapForRuleset(ruleset = null) {
  return ruleset?.scheduleELineMap || SCHEDULE_E_LINE_MAP;
}

function buildCategoryToLineMap(scheduleELineMap = SCHEDULE_E_LINE_MAP) {
  const categoryToLine = {};
  for (const [line, info] of Object.entries(scheduleELineMap)) {
    for (const category of info.categories || []) {
      categoryToLine[category] = parseInt(line, 10);
    }
  }

  return categoryToLine;
}

function getDepreciationRulesForRuleset(ruleset = null) {
  return ruleset?.depreciation || DEPRECIATION_RULES;
}

function getFederalTaxBracketsForRuleset(ruleset = null) {
  return ruleset?.federalTaxBrackets || TAX_BRACKETS_2025;
}

function getStandardDeductionForRuleset(ruleset = null) {
  return ruleset?.standardDeduction || STANDARD_DEDUCTION_2025;
}

function getDeadlineTemplatesForRuleset(ruleset, taxYear) {
  return ruleset?.deadlineTemplates || getTaxDeadlineTemplates(taxYear);
}

function formatTax1099ThresholdFromRuleset(ruleset, taxYear) {
  const threshold = Number(ruleset?.tax1099?.activeThreshold);
  if (Number.isFinite(threshold) && threshold > 0) {
    return `$${threshold.toLocaleString('en-US')}`;
  }

  return formatTax1099Threshold(taxYear);
}

function getTax1099ThresholdSummaryFromRuleset(ruleset, taxYear) {
  return ruleset?.tax1099?.activeThresholdSummary || getTax1099ThresholdSummary(taxYear);
}

function parseCalendarDateParts(value, fallback = '2020-01-01') {
  const candidate = String(value || fallback);
  const isoDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);

  if (isoDateMatch) {
    return {
      year: Number(isoDateMatch[1]),
      monthIndex: Number(isoDateMatch[2]) - 1,
      day: Number(isoDateMatch[3])
    };
  }

  const parsed = new Date(candidate);

  if (Number.isNaN(parsed.getTime())) {
    return parseCalendarDateParts(fallback, fallback);
  }

  return {
    year: parsed.getUTCFullYear(),
    monthIndex: parsed.getUTCMonth(),
    day: parsed.getUTCDate()
  };
}

function compareCalendarDateParts(left, right) {
  if (left.year !== right.year) {
    return left.year - right.year;
  }

  if (left.monthIndex !== right.monthIndex) {
    return left.monthIndex - right.monthIndex;
  }

  return left.day - right.day;
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeQuarterNumber(value, fallback = 4) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 4) {
    return fallback;
  }

  return numeric;
}

function normalizeStateCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function getQuarterDateRange(taxYear, quarter) {
  return {
    1: { start: `${taxYear}-01-01`, end: `${taxYear}-03-31` },
    2: { start: `${taxYear}-04-01`, end: `${taxYear}-06-30` },
    3: { start: `${taxYear}-07-01`, end: `${taxYear}-09-30` },
    4: { start: `${taxYear}-10-01`, end: `${taxYear}-12-31` }
  }[normalizeQuarterNumber(quarter, 4)];
}

function filterEntriesByDateRange(entries = [], start, end) {
  return entries.filter((entry) => {
    const date = entry?.date || entry?.entryDate || '';
    return date >= start && date <= end;
  });
}

function buildScheduleEPeriodSnapshot({
  entries = [],
  taxYear,
  start,
  end,
  propertyId = null,
  properties = [],
  ruleset = null,
}) {
  const periodEntries = filterEntriesByDateRange(entries, start, end);
  const scheduleE = generateScheduleE(periodEntries, taxYear, propertyId, properties, ruleset);

  return {
    entries: periodEntries,
    scheduleE,
    income: roundCurrency(scheduleE?.summary?.totalIncome || 0),
    expenses: roundCurrency(scheduleE?.summary?.totalExpenses || 0),
    netIncome: roundCurrency(scheduleE?.summary?.netIncomeOrLoss || 0),
  };
}

/**
 * IRC §280A mixed-use evaluation for a single property.
 * The personal-use rule applies when personal use exceeds the greater of
 * 14 days or 10% of fair rental days. When it applies, Schedule E expense
 * deductions must be prorated by the rental-use percentage.
 */
function evaluatePersonalUseRule({ personalUseDays = 0, fairRentalDays = 365, hasExplicitRentalDays = false }) {
  const normalizedPersonalUseDays = Math.max(0, Number(personalUseDays) || 0);
  const normalizedFairRentalDays = Math.max(0, Number(fairRentalDays) || 0) || 365;
  const personalUseExceeds14Days = normalizedPersonalUseDays > 14;
  const personalUseExceeds10Pct = normalizedPersonalUseDays > (normalizedFairRentalDays * 0.10);
  const applies = personalUseExceeds14Days && personalUseExceeds10Pct;
  const rentalUseFraction = applies
    ? normalizedFairRentalDays / (normalizedFairRentalDays + normalizedPersonalUseDays)
    : 1.0;

  // Allocation confidence is low when the rule applies but fair rental days
  // were never explicitly entered (the engine fell back to the 365-day
  // default), because the rental-use percentage is then a guess.
  const lowConfidence = applies && !hasExplicitRentalDays;

  return {
    applies,
    personalUseDays: normalizedPersonalUseDays,
    fairRentalDays: normalizedFairRentalDays,
    rentalUseFraction,
    lowConfidence,
  };
}

function getPriorYearSafeHarborPercent(filingStatus, priorYearAdjustedGrossIncome) {
  const priorYearAgi = normalizeOptionalNumber(priorYearAdjustedGrossIncome);
  const threshold = filingStatus === 'married_filing_separately' ? 75000 : 150000;
  return priorYearAgi !== null && priorYearAgi > threshold ? 1.1 : 1.0;
}

function sumQualifiedPropertyBasisFromDepreciation(depreciation) {
  return roundCurrency(
    (depreciation?.assets || []).reduce(
      (sum, asset) => sum + Math.max(0, Number(asset?.depreciableBasis || 0)),
      0,
    ),
  );
}

function buildPropertyDepreciationMap(depreciation = null, rentalUseFractionByProperty = {}) {
  const depreciationByProperty = new Map();
  for (const asset of depreciation?.assets || []) {
    const propertyId = asset?.propertyId || null;
    if (!propertyId) {
      continue;
    }
    const rentalUseFraction = rentalUseFractionByProperty[propertyId] ?? 1;
    const currentYearDepreciation = Math.max(0, Number(asset?.currentYearDepreciation || 0)) * rentalUseFraction;
    depreciationByProperty.set(
      propertyId,
      roundCurrency((depreciationByProperty.get(propertyId) || 0) + currentYearDepreciation),
    );
  }
  return depreciationByProperty;
}

function buildDerivedPropertyStates({
  scheduleE,
  depreciation = null,
  rentalUseFractionByProperty = {},
  scheduleEIncludesDepreciation = false,
}) {
  const depreciationByProperty = buildPropertyDepreciationMap(depreciation, rentalUseFractionByProperty);
  const stateMap = new Map();

  for (const property of scheduleE?.propertySummaries || []) {
    const stateCode = normalizeStateCode(property?.state || property?.propertyState);
    if (!stateCode) {
      continue;
    }

    const propertyId = property?.id || property?.propertyId || stateCode;
    const allowedExpenseTotal = property?.personalUseRule?.applies
      ? Number(property?.personalUseRule?.allowedExpenseTotal || 0)
      : Number(property?.totalExpenses || 0);
    const rentalNetBeforeDepreciation = roundCurrency(Number(property?.income || 0) - allowedExpenseTotal);
    const allocatedDepreciation = scheduleEIncludesDepreciation
      ? 0
      : roundCurrency(depreciationByProperty.get(propertyId) || 0);
    const incomeFromState = roundCurrency(rentalNetBeforeDepreciation - allocatedDepreciation);

    if (!stateMap.has(stateCode)) {
      stateMap.set(stateCode, {
        stateCode,
        incomeFromState: 0,
        propertyCount: 0,
        propertyIds: [],
        propertyNames: [],
      });
    }

    const current = stateMap.get(stateCode);
    current.incomeFromState = roundCurrency(current.incomeFromState + incomeFromState);
    current.propertyCount += 1;
    current.propertyIds.push(propertyId);
    current.propertyNames.push(property?.name || property?.address || propertyId);
  }

  return Array.from(stateMap.values()).map((state) => ({
    ...state,
    propertyIds: Array.from(new Set(state.propertyIds)),
    propertyNames: Array.from(new Set(state.propertyNames)),
  }));
}

function buildQbiComputation({
  netRentalIncome = 0,
  filingStatus = 'single',
  taxableIncomeBeforeQbi = 0,
  rentalServiceHours = null,
  qualifiedPropertyBasis = 0,
}) {
  const normalizedRentalHours = Math.max(0, Number(rentalServiceHours || 0));
  const normalizedTaxableIncome = Math.max(0, Number(taxableIncomeBeforeQbi || 0));
  const normalizedQualifiedPropertyBasis = Math.max(0, Number(qualifiedPropertyBasis || 0));
  const rawQbi = calculateQBIDeduction({
    netRentalIncome: Math.max(0, Number(netRentalIncome || 0)),
    rentalHoursPerYear: normalizedRentalHours,
    filingStatus,
    totalTaxableIncome: normalizedTaxableIncome,
    unadjustedBasisOfProperty: normalizedQualifiedPropertyBasis,
  });
  const appliedDeduction = rawQbi?.eligible ? roundCurrency(rawQbi.deduction) : 0;

  return {
    ...rawQbi,
    applied: appliedDeduction > 0,
    deduction: appliedDeduction,
    details: {
      ...(rawQbi?.details || {}),
      rentalHoursPerYear: normalizedRentalHours,
      taxableIncomeBeforeQbi: roundCurrency(normalizedTaxableIncome),
      taxableIncomeAfterQbi: roundCurrency(Math.max(0, normalizedTaxableIncome - appliedDeduction)),
      ubiaQualifiedProperty: roundCurrency(normalizedQualifiedPropertyBasis),
    },
  };
}

function buildTaxModelingReadiness({
  scheduleE,
  depreciation,
  homeState,
  rentalStates = [],
  propertyStateAllocations = [],
  passiveLoss = null,
  adjustedRentalIncome = 0,
  qbi = null,
}) {
  const blockers = [];
  const warnings = [];
  const normalizedHomeState = normalizeStateCode(homeState);
  const distinctRentalStates = Array.from(new Set(
    (propertyStateAllocations || [])
      .map((state) => normalizeStateCode(state?.stateCode))
      .filter(Boolean)
  ));
  if (distinctRentalStates.length === 0) {
    distinctRentalStates.push(...Array.from(new Set((rentalStates || []).map(normalizeStateCode).filter(Boolean))));
  }
  const hasCrossJurisdictionExposure = distinctRentalStates.length > 1
    || (distinctRentalStates.length === 1 && normalizedHomeState && distinctRentalStates[0] !== normalizedHomeState);

  if ((scheduleE?.summary?.totalIncome || 0) > 0 && (depreciation?.summary?.assetCount || 0) === 0) {
    blockers.push('No rental property basis is on file for depreciation, so landlord tax output should remain estimate-only until the property setup is completed.');
  }

  if (!homeState) {
    warnings.push('Home state is missing, so the total tax picture does not yet include a resident-state baseline.');
  }

  if (hasCrossJurisdictionExposure) {
    blockers.push(`Rental activity spans a multi-state filing footprint (${distinctRentalStates.join(', ')}${normalizedHomeState ? ` with resident home state ${normalizedHomeState}` : ''}), but resident credits, apportionment, conformity differences, and local taxes are not yet modeled well enough for filing-grade output.`);
  }

  const personalUseLimitedProperties = (scheduleE?.propertySummaries || []).filter((property) => property?.personalUseRule?.applies);
  const personalUseAdjustment = scheduleE?.personalUseAdjustment || null;
  if (personalUseLimitedProperties.length > 0) {
    if (personalUseAdjustment?.lowConfidence) {
      blockers.push(
        `Section 280A applies to ${personalUseLimitedProperties.length} propert${personalUseLimitedProperties.length === 1 ? 'y' : 'ies'} but the rental-use allocation is low confidence (missing explicit fair-rental days or unattributed expense entries), so output is gated to estimate-only until the day counts are confirmed.`
      );
    } else if (personalUseAdjustment?.applied) {
      warnings.push(
        `Section 280A mixed-use proration was applied: $${personalUseAdjustment.totalDisallowedExpenses.toLocaleString()} of expenses were excluded as the personal-use share. The personal portion of mortgage interest and property taxes may still be deductible on Schedule A. The §280A(c)(5) income limitation on vacation-home losses is not yet modeled.`
      );
    } else {
      warnings.push(`${personalUseLimitedProperties.length} property has mixed rental/personal use, so Section 280A allocation limits still need manual review.`);
    }
  }

  if (passiveLoss?.hasLoss) {
    warnings.push('Passive-loss carryforwards are still simplified and should be tied back to Form 8582 support before filing.');
  }

  if (
    Number(adjustedRentalIncome || 0) > 0
    && Number(qbi?.details?.rawQBI || 0) > 0
    && Number(qbi?.details?.taxableIncomeBeforeQbi || 0) > 0
    && !qbi?.applied
  ) {
    warnings.push(
      qbi?.details?.rentalHoursPerYear
        ? `QBI is not applied in the main liability preview. ${qbi.reason}`
        : 'Profitable rental activity exists, but rental service hours are missing, so QBI is conservatively excluded from the main liability preview.',
    );
  }

  return {
    status: blockers.length > 0
      ? 'estimate_only'
      : warnings.length > 0
        ? 'usable_with_warnings'
        : 'ready_for_supported_scope',
    blockers,
    warnings,
  };
}

function buildEstimatedTaxReadiness({
  homeState,
  priorYearTotalTax,
  rentalStates = [],
  annualDepreciation = 0,
  annualizedRentalIncomeBeforeDepreciation = 0,
  annualizedRentalIncome = 0,
  qbi = null,
  personalUseLimitedPropertyCount = 0,
}) {
  const blockers = [];
  const warnings = [];
  const missingInputs = [];

  if (Number(personalUseLimitedPropertyCount || 0) > 0) {
    warnings.push(`${personalUseLimitedPropertyCount} propert${Number(personalUseLimitedPropertyCount) === 1 ? 'y has' : 'ies have'} mixed rental/personal use (§280A). Quarterly estimates now follow the same Schedule E proration path, but the vacation-home loss limitation and supporting day-count review still need manual confirmation before filing.`);
  }

  if (!homeState) {
    warnings.push('Home state is blank, so the estimate excludes the resident-state overlay.');
  }

  if ((rentalStates || []).length > 1) {
    warnings.push(`Rental activity spans ${rentalStates.length} states, but state resident-credit and apportionment rules are not fully modeled in the estimate engine.`);
  }

  if (normalizeOptionalNumber(priorYearTotalTax) === null) {
    missingInputs.push('Prior-year total tax is needed to prove the 100% or 110% safe-harbor method.');
  }

  if (Number(annualizedRentalIncomeBeforeDepreciation || 0) > 0 && Number(annualDepreciation || 0) <= 0) {
    warnings.push('Annual depreciation was not provided to the estimate engine, so quarterly results may overstate taxable rental income.');
  }

  if (
    Number(annualizedRentalIncome || 0) > 0
    && Number(qbi?.details?.rawQBI || 0) > 0
    && Number(qbi?.details?.taxableIncomeBeforeQbi || 0) > 0
    && !qbi?.applied
  ) {
    warnings.push(
      qbi?.details?.rentalHoursPerYear
        ? `QBI is not applied in the estimated-payment preview. ${qbi.reason}`
        : 'Rental service hours are missing, so QBI is conservatively excluded from the estimated-payment preview.',
    );
  }

  return {
    status: blockers.length > 0
      ? 'blocked_missing_inputs'
      : missingInputs.length > 0
        ? 'projection_only'
        : warnings.length > 0
          ? 'safe_harbor_ready_with_warnings'
          : 'safe_harbor_ready',
    blockers,
    warnings,
    missingInputs,
  };
}

// Build reverse lookup: category name → Schedule E line
const CATEGORY_TO_LINE = buildCategoryToLineMap(SCHEDULE_E_LINE_MAP);

// ─── Schedule E Generator ────────────────────────────────────────────────────

/**
 * Generate IRS Schedule E from Firestore journal entries
 * @param {Array} entries - Journal entries from Firestore
 * @param {number} taxYear - Tax year
 * @param {string|null} propertyId - Optional property filter
 * @param {Array} properties - User properties for name/address resolution
 */
export function generateScheduleE(entries, taxYear, propertyId = null, properties = [], ruleset = null) {
  const resolvedRuleset = resolveTaxRuleset(taxYear, ruleset);
  const scheduleELineMap = getScheduleELineMapForRuleset(resolvedRuleset);
  const categoryToLine = buildCategoryToLineMap(scheduleELineMap);
  // Build property lookup map: id → { name, address, type }
  const propertyLookup = {};
  for (const p of properties) {
    propertyLookup[p.id] = {
      name: p.propertyName || p.name || p.address || p.id,
      address: p.address || p.street || '',
      type: p.propertyType || p.type || 'Single Family',
      state: p.state || p.attomState || p.mailingState || null,
      fairRentalDays: p.fairRentalDays || 365,
      personalUseDays: p.personalUseDays || 0,
      hasExplicitRentalDays: p.fairRentalDays !== undefined && p.fairRentalDays !== null && p.fairRentalDays !== ''
    };
  }
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;

  // Filter entries for the tax year and optional property
  const filtered = entries.filter(e => {
    const date = e.date || e.entryDate || '';
    const inRange = date >= startDate && date <= endDate;
    const matchesProperty = !propertyId || e.propertyId === propertyId;
    return inRange && matchesProperty;
  });

  // Initialize Schedule E lines
  const scheduleELines = {};
  for (const [lineNum, info] of Object.entries(scheduleELineMap)) {
    scheduleELines[info.key] = {
      line: parseInt(lineNum),
      name: info.name,
      amount: 0,
      entries: []
    };
  }

  // Classify each entry into the correct Schedule E line
  for (const entry of filtered) {
    const category = entry.category || '';
    const amount = Math.abs(parseFloat(entry.amount) || 0);
    const scheduleELine = categoryToLine[category];
    
    if (scheduleELine) {
      const lineInfo = scheduleELineMap[scheduleELine];
      if (lineInfo && scheduleELines[lineInfo.key]) {
        scheduleELines[lineInfo.key].amount += amount;
        scheduleELines[lineInfo.key].entries.push({
          entryId: entry.id || null,
          date: entry.date || entry.entryDate || '',
          description: entry.description,
          category,
          amount,
          vendor: entry.vendor,
          propertyId: entry.propertyId || null,
          source: entry.source || null,
          sourceRef: entry.sourceRef || null,
          financeEventType: entry.financeEventType || null
        });
      }
    }
  }

  // ── Mortgage Interest / Principal Split ──────────────────────────────────
  // IRS Schedule E Line 12 only allows deducting the interest portion of
  // mortgage payments. Keep entries already categorized as mortgage interest
  // intact; only split generic mortgage-payment rows that include principal.
  if (scheduleELines.MORTGAGE_INTEREST.entries.length > 0 && properties.length > 0) {
    // Find the first property with mortgage data
    const mortgageProp = properties.find(p =>
      (p.attomMortgageAmount || p.mortgageAmount) &&
      (p.attomMortgageRate || p.mortgageRate)
    );

    if (mortgageProp) {
      const loanAmount = parseFloat(mortgageProp.attomMortgageAmount || mortgageProp.mortgageAmount);
      const rate = parseFloat(mortgageProp.attomMortgageRate || mortgageProp.mortgageRate);
      const termMonths = parseInt(mortgageProp.mortgageTermMonths || mortgageProp.attomMortgageTerm || 360);
      const originationDate = mortgageProp.attomLastSaleDate || mortgageProp.purchaseDate || mortgageProp.mortgageDate || `${taxYear - 3}-01-01`;

      const shouldSplitMortgageEntry = (entry) => {
        const categoryText = String(entry.category || '').toLowerCase();
        const descriptionText = String(entry.description || '').toLowerCase();
        const combinedText = `${categoryText} ${descriptionText}`;

        if (categoryText.includes('mortgage interest')) {
          return false;
        }

        return /mortgage payment|loan payment|principal|escrow/.test(combinedText);
      };

      if (loanAmount > 0 && rate > 0) {
        let totalInterest = 0;
        let totalPrincipal = 0;
        const updatedEntries = [];
        let splitApplied = false;

        for (const entry of scheduleELines.MORTGAGE_INTEREST.entries) {
          if (!shouldSplitMortgageEntry(entry)) {
            totalInterest += entry.amount;
            updatedEntries.push(entry);
            continue;
          }

          const split = calculateMortgageSplit(loanAmount, rate, termMonths, originationDate, entry.date);
          totalInterest += split.interest;
          totalPrincipal += split.principal;
          splitApplied = true;
          updatedEntries.push({
            ...entry,
            amount: split.interest,
            originalFullPayment: entry.amount,
            principalPortion: split.principal
          });
        }

        scheduleELines.MORTGAGE_INTEREST.amount = Math.round(totalInterest * 100) / 100;
        scheduleELines.MORTGAGE_INTEREST.entries = updatedEntries;
        scheduleELines.MORTGAGE_INTEREST.mortgageSplitApplied = splitApplied;
        scheduleELines.MORTGAGE_INTEREST.principalExcluded = Math.round(totalPrincipal * 100) / 100;
      }
    }
  }

  // When ledger rows are missing, derive annual mortgage interest from cached ATTOM terms.
  if (scheduleELines.MORTGAGE_INTEREST.amount <= 0 && properties.length > 0) {
    let attomEstimatedInterest = 0;
    const attomEstimateEntries = [];

    for (const property of properties) {
      const estimatedAnnualInterest = estimateAnnualMortgageInterestFromProperty(property, taxYear);
      if (estimatedAnnualInterest <= 0) {
        continue;
      }

      attomEstimatedInterest += estimatedAnnualInterest;
      attomEstimateEntries.push({
        entryId: null,
        date: `${taxYear}-12-31`,
        description: `Estimated annual mortgage interest (${property.propertyName || property.name || property.address || 'rental property'})`,
        category: 'Mortgage Interest',
        amount: estimatedAnnualInterest,
        vendor: null,
        propertyId: property.id || null,
        source: 'attom_mortgage_estimate',
        sourceRef: 'attom-cache',
        financeEventType: 'mortgage_interest_estimate',
      });
    }

    if (attomEstimatedInterest > 0) {
      scheduleELines.MORTGAGE_INTEREST.amount = Math.round(attomEstimatedInterest * 100) / 100;
      scheduleELines.MORTGAGE_INTEREST.entries = attomEstimateEntries;
      scheduleELines.MORTGAGE_INTEREST.attomEstimateApplied = true;
    }
  }

  // ── IRC §280A Mixed-Use Proration ────────────────────────────────────────
  // When a property's personal use exceeds the 14-day / 10% threshold,
  // Schedule E expense deductions must be prorated by the rental-use
  // percentage. Rental income is never prorated. The personal-use portion of
  // mortgage interest and property taxes may still be deductible on
  // Schedule A — that is surfaced via notes rather than silently dropped.
  const personalUseByProperty = {};
  for (const p of properties) {
    personalUseByProperty[p.id] = evaluatePersonalUseRule(propertyLookup[p.id] || {});
  }
  const personalUseLimitedIds = Object.entries(personalUseByProperty)
    .filter(([, info]) => info.applies)
    .map(([id]) => id);

  const personalUseAdjustment = {
    applied: false,
    lowConfidence: false,
    properties: [],
    byLine: {},
    totalExpensesBefore: 0,
    totalExpensesAfter: 0,
    totalDisallowedExpenses: 0,
    notes: [],
  };

  if (personalUseLimitedIds.length > 0) {
    const incomeLineKeys = new Set(['RENTS_RECEIVED', 'OTHER_INCOME']);
    let sawUnassignedExpenseEntries = false;

    for (const [key, line] of Object.entries(scheduleELines)) {
      if (incomeLineKeys.has(key) || line.entries.length === 0) {
        continue;
      }

      const amountBefore = roundCurrency(line.entries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0));
      let lineDisallowed = 0;
      let lineTouched = false;

      for (const entry of line.entries) {
        const info = entry.propertyId ? personalUseByProperty[entry.propertyId] : null;
        if (entry.propertyId && !info) {
          // Entry references a property the engine knows nothing about.
          sawUnassignedExpenseEntries = true;
          continue;
        }
        if (!entry.propertyId) {
          sawUnassignedExpenseEntries = true;
          continue;
        }
        if (!info.applies) {
          continue;
        }

        const fullAmount = Number(entry.amount) || 0;
        const allowedAmount = roundCurrency(fullAmount * info.rentalUseFraction);
        entry.fullAmount = roundCurrency(fullAmount);
        entry.amount = allowedAmount;
        entry.personalUsePortionExcluded = roundCurrency(fullAmount - allowedAmount);
        entry.personalUseProrated = true;
        lineDisallowed += fullAmount - allowedAmount;
        lineTouched = true;
      }

      if (lineTouched) {
        line.amount = line.entries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
        line.personalUseProrated = true;
        line.personalUseDisallowed = roundCurrency(lineDisallowed);
        personalUseAdjustment.byLine[key] = {
          line: line.line,
          name: line.name,
          before: amountBefore,
          after: roundCurrency(line.amount),
          disallowed: roundCurrency(lineDisallowed),
        };
      }
    }

    const totalBefore = Object.values(personalUseAdjustment.byLine).reduce((sum, l) => sum + l.before, 0);
    const totalAfter = Object.values(personalUseAdjustment.byLine).reduce((sum, l) => sum + l.after, 0);
    personalUseAdjustment.applied = Object.keys(personalUseAdjustment.byLine).length > 0;
    personalUseAdjustment.totalExpensesBefore = roundCurrency(totalBefore);
    personalUseAdjustment.totalExpensesAfter = roundCurrency(totalAfter);
    personalUseAdjustment.totalDisallowedExpenses = roundCurrency(totalBefore - totalAfter);
    personalUseAdjustment.properties = personalUseLimitedIds.map((id) => {
      const info = personalUseByProperty[id];
      return {
        propertyId: id,
        propertyName: propertyLookup[id]?.name || id,
        personalUseDays: info.personalUseDays,
        fairRentalDays: info.fairRentalDays,
        rentalUsePct: Math.round(info.rentalUseFraction * 1000) / 10,
        lowConfidence: info.lowConfidence,
      };
    });
    personalUseAdjustment.lowConfidence = personalUseAdjustment.properties.some((p) => p.lowConfidence)
      || (personalUseAdjustment.applied && sawUnassignedExpenseEntries);

    if (personalUseAdjustment.applied) {
      personalUseAdjustment.notes.push(
        `Section 280A mixed-use proration applied: Schedule E expense deductions for ${personalUseLimitedIds.length} propert${personalUseLimitedIds.length === 1 ? 'y' : 'ies'} were reduced to the rental-use percentage of total use days. Rental income was not reduced.`
      );
      personalUseAdjustment.notes.push(
        'The personal-use portion of mortgage interest and property taxes excluded here may still be deductible on Schedule A (itemized deductions); it was not silently discarded.'
      );
    }
    if (sawUnassignedExpenseEntries) {
      personalUseAdjustment.notes.push(
        'Some expense entries could not be attributed to a registered property, so §280A proration could not be evaluated for them. They were left at full amount.'
      );
    }
    for (const property of personalUseAdjustment.properties) {
      if (property.lowConfidence) {
        personalUseAdjustment.notes.push(
          `${property.propertyName}: fair rental days were never explicitly entered (365-day default), so the ${property.rentalUsePct}% rental-use allocation is low confidence.`
        );
      }
    }
  }

  // Round all amounts
  for (const key of Object.keys(scheduleELines)) {
    scheduleELines[key].amount = Math.round(scheduleELines[key].amount * 100) / 100;
  }

  // Calculate totals
  const totalIncome = scheduleELines.RENTS_RECEIVED.amount + scheduleELines.OTHER_INCOME.amount;
  const totalExpenses = Object.entries(scheduleELines)
    .filter(([key]) => !['RENTS_RECEIVED', 'OTHER_INCOME'].includes(key))
    .reduce((sum, [, data]) => sum + data.amount, 0);

  // Build per-property breakdowns (IRS Schedule E requires separate columns per property)
  // Pre-seed with ALL registered properties so they appear even with $0 income
  const propertyMap = {};
  for (const p of properties) {
    const lookup = propertyLookup[p.id] || {};
    propertyMap[p.id] = {
      id: p.id,
      name: lookup.name || p.name || p.address || p.id,
      address: lookup.address || p.address || '',
      state: lookup.state || p.state || p.attomState || p.mailingState || null,
      propertyType: lookup.type || p.propertyType || 'Residential Rental Property',
      fairRentalDays: lookup.fairRentalDays || 365,
      personalUseDays: lookup.personalUseDays || 0,
      income: 0,
      totalExpenses: 0,
      expenses: {}
    };
  }
  for (const entry of filtered) {
    const pid = entry.propertyId || entry.propertyName || 'unassigned';
    const lookup = propertyLookup[pid] || {};
    if (!propertyMap[pid]) {
      propertyMap[pid] = {
        id: pid,
        name: lookup.name || entry.propertyName || (pid === 'unassigned' ? 'Unassigned' : pid),
        address: lookup.address || entry.propertyAddress || '',
        state: lookup.state || entry.propertyState || null,
        propertyType: lookup.type || entry.propertyType || 'Single Family',
        fairRentalDays: lookup.fairRentalDays || 365,
        personalUseDays: lookup.personalUseDays || 0,
        income: 0,
        totalExpenses: 0,
        expenses: {}
      };
    }
    const p = propertyMap[pid];
    const amount = Math.abs(parseFloat(entry.amount) || 0);
    const type = entry.transactionType
      || entry.type
      || (entry.isExpense === true ? 'expense' : entry.isExpense === false ? 'income' : '');
    if (type === 'income' || type === 'revenue') {
      p.income += amount;
    } else if (type === 'expense') {
      p.totalExpenses += amount;
      const cat = entry.category || 'Other';
      p.expenses[cat] = (p.expenses[cat] || 0) + amount;
    }
  }
  const propertySummaries = Object.values(propertyMap).map(p => {
    // IRS 14-day / 10% personal use rule (IRC §280A)
    // If personal use > 14 days AND > 10% of fair rental days, deductions are limited
    const ruleInfo = personalUseByProperty[p.id] || evaluatePersonalUseRule({
      personalUseDays: p.personalUseDays || 0,
      fairRentalDays: p.fairRentalDays || 365,
      hasExplicitRentalDays: Boolean(propertyLookup[p.id]?.hasExplicitRentalDays),
    });
    const { applies: personalUseRuleApplies, personalUseDays, fairRentalDays, rentalUseFraction: rentalUsePct } = ruleInfo;
    const totalExpenses = Math.round(p.totalExpenses * 100) / 100;
    const allowedExpenseTotal = personalUseRuleApplies
      ? roundCurrency(p.totalExpenses * rentalUsePct)
      : totalExpenses;

    return {
      ...p,
      income: Math.round(p.income * 100) / 100,
      totalExpenses,
      expenses: Object.fromEntries(Object.entries(p.expenses).map(([k, v]) => [k, Math.round(Number(v) * 100) / 100])),
      personalUseRule: {
        applies: personalUseRuleApplies,
        personalUseDays,
        fairRentalDays,
        rentalUsePct: Math.round(rentalUsePct * 1000) / 10, // e.g. 85.7%
        lowConfidence: ruleInfo.lowConfidence,
        allowedExpenseTotal,
        disallowedExpenseTotal: roundCurrency(totalExpenses - allowedExpenseTotal),
        deductionLimit: personalUseRuleApplies
          ? `Deductions limited to ${Math.round(rentalUsePct * 100)}% (${fairRentalDays} rental ÷ ${fairRentalDays + personalUseDays} total days)`
          : null
      }
    };
  });

  return {
    taxYear,
    propertyId,
    scheduleELines,
    propertySummaries,
    personalUseAdjustment,
    summary: {
      totalIncome: Math.round(totalIncome * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      netIncomeOrLoss: Math.round((totalIncome - totalExpenses) * 100) / 100,
      line20Total: Math.round(totalExpenses * 100) / 100,
      line21Income: Math.round((totalIncome - totalExpenses) * 100) / 100
    },
    entryCount: filtered.length,
    generatedAt: new Date().toISOString()
  };
}

// ─── Depreciation Schedule ───────────────────────────────────────────────────

/**
 * Calculate depreciation schedule for rental properties
 * @param {Array} properties - Property data (can include ATTOM-sourced values)
 * @param {number} taxYear - Tax year
 */
export function calculateDepreciation(properties, taxYear, ruleset = null) {
  const resolvedRuleset = resolveTaxRuleset(taxYear, ruleset);
  const depreciationRules = getDepreciationRulesForRuleset(resolvedRuleset);
  const yearEnd = { year: taxYear, monthIndex: 11, day: 31 };
  const yearStart = { year: taxYear, monthIndex: 0, day: 1 };

  const assets = properties.map(prop => {
    const purchasePrice = parseFloat(prop.purchasePrice || prop.cost || 0);
    // Use ATTOM land value if available, otherwise default to 20% of purchase price
    const landValue = parseFloat(prop.landValue || prop.attomLandValue || (purchasePrice * depreciationRules.defaultLandValuePercent));
    const improvementValue = parseFloat(prop.improvementValue || prop.attomImprovementValue || (purchasePrice - landValue));
    const depreciableBasis = Math.max(0, improvementValue);
    
    // Residential rental = 27.5 years (330 months)
    const usefulLifeMonths = parseInt(prop.usefulLifeMonths || depreciationRules.residentialRentalUsefulLifeMonths);
    const usefulLifeYears = usefulLifeMonths / 12;
    const monthlyDepreciation = depreciableBasis / usefulLifeMonths;
    const annualDepreciation = monthlyDepreciation * 12;

    // Calculate months in service during this tax year
    const placedInService = parseCalendarDateParts(
      prop.purchaseDate || prop.dateAcquired || prop.placedInService || '2020-01-01'
    );
    const placedAfterYearEnd = compareCalendarDateParts(placedInService, yearEnd) > 0;
    let monthsInService = 0;

    if (!placedAfterYearEnd) {
      monthsInService = compareCalendarDateParts(placedInService, yearStart) > 0
        ? 12 - placedInService.monthIndex
        : 12;
    }

    const totalMonthsSincePlaced = placedAfterYearEnd
      ? 0
      : Math.max(
          0,
          (yearEnd.year - placedInService.year) * 12 +
            (yearEnd.monthIndex - placedInService.monthIndex) +
            1
        );
    
    const accumulatedDepreciation = Math.min(
      monthlyDepreciation * totalMonthsSincePlaced,
      depreciableBasis
    );
    
    const remainingBasis = Math.max(0, depreciableBasis - accumulatedDepreciation);
    const currentYearDepreciation = remainingBasis > 0 
      ? Math.min(monthlyDepreciation * monthsInService, remainingBasis) 
      : 0;
    
    const yearsRemaining = annualDepreciation > 0 
      ? Math.ceil(remainingBasis / annualDepreciation) 
      : 0;

    return {
      propertyId: prop.id || prop.propertyId,
      propertyName: prop.name || prop.address || 'Property',
      propertyAddress: prop.address || '',
      state: prop.state || prop.attomState || null,
      description: prop.description || 'Residential Rental Property',
      dateAcquired: prop.purchaseDate || prop.dateAcquired || null,
      cost: purchasePrice,
      landValue,
      improvementValue,
      depreciableBasis,
      usefulLifeMonths,
      usefulLifeYears,
      method: depreciationRules.method,
      convention: depreciationRules.convention,
      monthlyDepreciation: Math.round(monthlyDepreciation * 100) / 100,
      annualDepreciation: Math.round(annualDepreciation * 100) / 100,
      currentYearDepreciation: Math.round(currentYearDepreciation * 100) / 100,
      monthsInService,
      accumulatedDepreciation: Math.round(accumulatedDepreciation * 100) / 100,
      remainingBasis: Math.round(remainingBasis * 100) / 100,
      yearsRemaining,
      // Source tracking
      landValueSource: prop.attomLandValue ? 'ATTOM (Assessed)' : 'User Entered',
      improvementValueSource: prop.attomImprovementValue ? 'ATTOM (Assessed)' : 'Calculated'
    };
  });

  return {
    taxYear,
    assets,
    summary: {
      assetCount: assets.length,
      totalCost: assets.reduce((sum, a) => sum + a.cost, 0),
      totalDepreciableBasis: assets.reduce((sum, a) => sum + a.depreciableBasis, 0),
      totalCurrentYearDepreciation: Math.round(assets.reduce((sum, a) => sum + a.currentYearDepreciation, 0) * 100) / 100,
      totalAccumulatedDepreciation: Math.round(assets.reduce((sum, a) => sum + a.accumulatedDepreciation, 0) * 100) / 100
    },
    formNumber: 'Form 4562 - Depreciation and Amortization',
    generatedAt: new Date().toISOString()
  };
}

// ─── Federal Tax Calculator ──────────────────────────────────────────────────

/**
 * Calculate federal income tax with per-bracket breakdown
 */
export function calculateFederalTax(taxableIncome, filingStatus = 'single', ruleset = null) {
  const federalTaxBrackets = getFederalTaxBracketsForRuleset(ruleset);
  const brackets = federalTaxBrackets[filingStatus] || federalTaxBrackets.single;

  let tax = 0;
  let remainingIncome = Math.max(0, taxableIncome);
  const breakdown = [];

  for (const bracket of brackets) {
    if (remainingIncome <= 0) break;
    const taxableInBracket = Math.min(remainingIncome, bracket.max - bracket.min);
    const taxInBracket = taxableInBracket * bracket.rate;

    if (taxableInBracket > 0) {
      breakdown.push({
        bracket: `${(bracket.rate * 100).toFixed(0)}%`,
        range: `$${bracket.min.toLocaleString()} – $${bracket.max === Infinity ? '∞' : bracket.max.toLocaleString()}`,
        taxableAmount: Math.round(taxableInBracket * 100) / 100,
        tax: Math.round(taxInBracket * 100) / 100
      });
    }

    tax += taxInBracket;
    remainingIncome -= taxableInBracket;
  }

  return {
    totalTax: Math.round(tax * 100) / 100,
    effectiveRate: taxableIncome > 0 ? Math.round((tax / taxableIncome * 100) * 100) / 100 : 0,
    marginalRate: (brackets.find(b => taxableIncome <= b.max)?.rate || 0.37) * 100,
    breakdown
  };
}

// ─── State Tax Calculator ────────────────────────────────────────────────────

/**
 * Calculate state income tax for rental income
 * Supports per-state rates and multi-state property owners
 * @param {number} taxableIncome - Taxable income
 * @param {string} stateCode - 2-letter state code (e.g., 'NC', 'FL', 'CA')
 * @param {string} filingStatus - Filing status
 */
export function calculateStateTax(taxableIncome, stateCode, filingStatus = 'single') {
  const stateInfo = STATE_TAX_RATES[stateCode?.toUpperCase()];
  
  if (!stateInfo || stateInfo.rate === 0) {
    return {
      state: stateCode,
      stateName: stateInfo?.name || stateCode,
      tax: 0,
      effectiveRate: 0,
      type: stateInfo?.type || 'none',
      note: stateInfo?.rate === 0 ? 'No state income tax' : 'State not found'
    };
  }

  let tax = 0;
  
  if (stateInfo.type === 'flat') {
    tax = taxableIncome * stateInfo.rate;
  } else if (stateInfo.type === 'graduated' && stateInfo.brackets) {
    // Use state-specific brackets if available
    const brackets = stateInfo.brackets[filingStatus] || stateInfo.brackets.single || stateInfo.brackets;
    let remaining = Math.max(0, taxableIncome);
    
    for (const bracket of brackets) {
      if (remaining <= 0) break;
      const taxable = Math.min(remaining, (bracket.max || Infinity) - (bracket.min || 0));
      tax += taxable * bracket.rate;
      remaining -= taxable;
    }
  } else {
    // Fallback to flat rate
    tax = taxableIncome * stateInfo.rate;
  }

  return {
    state: stateCode,
    stateName: stateInfo.name,
    tax: Math.round(tax * 100) / 100,
    effectiveRate: taxableIncome > 0 ? Math.round((tax / taxableIncome * 100) * 100) / 100 : 0,
    type: stateInfo.type,
    note: null
  };
}

/**
 * Calculate multi-state tax for owners with properties in multiple states
 * @param {number} totalTaxableIncome - Total taxable income
 * @param {Array} propertyStates - Array of { stateCode, incomeFromState }
 * @param {string} homeState - Owner's home state
 * @param {string} filingStatus - Filing status
 */
export function calculateMultiStateTax(totalTaxableIncome, propertyStates, homeState, filingStatus = 'single') {
  const stateResults = new Map();
  let totalStateTax = 0;

  const mergeStateResult = (result, extra = {}) => {
    const stateCode = normalizeStateCode(result?.state || extra?.stateCode);
    if (!stateCode) {
      return;
    }

    const existing = stateResults.get(stateCode) || {
      ...result,
      state: stateCode,
      incomeFromState: 0,
      propertyCount: 0,
      propertyIds: [],
      propertyNames: [],
      isHomeState: false,
    };
    const mergedIncome = roundCurrency((existing.incomeFromState || 0) + Number(extra.incomeFromState || 0));
    const mergedTax = roundCurrency((existing.tax || 0) + Number(result?.tax || 0));
    const propertyIds = Array.from(new Set([...(existing.propertyIds || []), ...(extra.propertyIds || [])]));
    const propertyNames = Array.from(new Set([...(existing.propertyNames || []), ...(extra.propertyNames || [])]));
    stateResults.set(stateCode, {
      ...existing,
      ...result,
      state: stateCode,
      incomeFromState: mergedIncome,
      tax: mergedTax,
      effectiveRate: mergedIncome > 0 ? roundCurrency((mergedTax / mergedIncome) * 100) : 0,
      propertyCount: Math.max(existing.propertyCount || 0, 0) + Math.max(0, Number(extra.propertyCount || 0)),
      propertyIds,
      propertyNames,
      isHomeState: Boolean(existing.isHomeState || extra.isHomeState),
    });
  };

  // Calculate tax for each state with rental income
  for (const ps of propertyStates) {
    const result = calculateStateTax(ps.incomeFromState, ps.stateCode, filingStatus);
    mergeStateResult(result, {
      incomeFromState: ps.incomeFromState,
      propertyCount: ps.propertyCount || 1,
      propertyIds: ps.propertyIds || [],
      propertyNames: ps.propertyNames || [],
    });
    totalStateTax += result.tax;
  }

  // If home state taxes worldwide income, add home state on remaining
  const homeStateInfo = STATE_TAX_RATES[homeState?.toUpperCase()];
  const propertyStateIncome = propertyStates.reduce((sum, ps) => sum + ps.incomeFromState, 0);
  const remainingIncome = totalTaxableIncome - propertyStateIncome;
  
  if (homeStateInfo && homeStateInfo.rate > 0 && remainingIncome > 0) {
    const homeResult = calculateStateTax(remainingIncome, homeState, filingStatus);
    mergeStateResult(homeResult, {
      incomeFromState: remainingIncome,
      isHomeState: true,
    });
    totalStateTax += homeResult.tax;
  }

  return {
    states: Array.from(stateResults.values()),
    totalStateTax: Math.round(totalStateTax * 100) / 100,
    homeState,
    filingStatus
  };
}

// ─── Full Tax Liability Calculator ───────────────────────────────────────────

/**
 * Calculate complete tax liability for a rental property owner
 * @param {Object} params - All tax calculation parameters
 * @param {Object} scheduleE - Pre-computed Schedule E data
 * @param {Object} depreciation - Pre-computed depreciation data
 */
export function calculateTaxLiability(params, scheduleE, depreciation, ruleset = null) {
  const {
    taxYear,
    filingStatus = 'single',
    otherIncome = 0,
    otherDeductions = 0,
    taxCredits = 0,
    withholdingYtd = 0,
    stateWithholdingYtd = null,
    stateWithholdingSource = null,
    rentalServiceHours = null,
    homeState = null,
    propertyStates = [],
    propertyId = null,
    priorYearTotalTax = null,
    priorYearAdjustedGrossIncome = null,
    rentalStates = [],
  } = params;
  const resolvedRuleset = resolveTaxRuleset(taxYear, ruleset);

  // Rental net income (can be negative = loss)
  const rentalNetIncome = scheduleE.summary.netIncomeOrLoss;

  // §280A: depreciation must also be prorated by rental-use percentage for
  // mixed-use properties. Build a per-property rental-use lookup from the
  // Schedule E personal-use evaluation.
  const rentalUseFractionByProperty = {};
  for (const summary of scheduleE.propertySummaries || []) {
    if (summary?.personalUseRule?.applies) {
      rentalUseFractionByProperty[summary.id] = Math.min(1, Math.max(0, Number(summary.personalUseRule.rentalUsePct || 100) / 100));
    }
  }
  const hasPersonalUseLimitedProperties = Object.keys(rentalUseFractionByProperty).length > 0;
  const scheduleEIncludesDepreciation = Number(scheduleE?.scheduleELines?.DEPRECIATION?.amount || 0) > 0;

  // Add depreciation if not already in Schedule E
  const fullDepreciationAmount = depreciation?.summary?.totalCurrentYearDepreciation || 0;
  let depreciationAmount = fullDepreciationAmount;
  let depreciationDisallowed = 0;
  if (hasPersonalUseLimitedProperties && (depreciation?.assets || []).length > 0) {
    depreciationAmount = roundCurrency((depreciation.assets || []).reduce((sum, asset) => {
      const fraction = rentalUseFractionByProperty[asset?.propertyId] ?? 1;
      return sum + Math.max(0, Number(asset?.currentYearDepreciation || 0)) * fraction;
    }, 0));
    depreciationDisallowed = roundCurrency(fullDepreciationAmount - depreciationAmount);
  }
  const adjustedRentalIncome = rentalNetIncome - (
    scheduleE.scheduleELines.DEPRECIATION?.amount > 0 ? 0 : depreciationAmount
  );

  // Check passive loss rules
  const passiveLoss = analyzePassiveLoss(adjustedRentalIncome, otherIncome, filingStatus);

  // Total income for tax purposes
  const grossIncome = otherIncome + passiveLoss.allowableRentalIncome;

  // Determine deduction method
  const standardDeductionTable = getStandardDeductionForRuleset(resolvedRuleset);
  const standardDeduction = standardDeductionTable[filingStatus] || standardDeductionTable.single;
  const useItemized = otherDeductions > standardDeduction;
  const totalDeductions = useItemized ? otherDeductions : standardDeduction;

  // Taxable income before below-the-line QBI treatment.
  const taxableIncomeBeforeQbi = Math.max(0, grossIncome - totalDeductions);
  const qbi = buildQbiComputation({
    netRentalIncome: adjustedRentalIncome,
    filingStatus,
    taxableIncomeBeforeQbi,
    rentalServiceHours,
    qualifiedPropertyBasis: sumQualifiedPropertyBasisFromDepreciation(depreciation),
  });
  const taxableIncome = Math.max(0, taxableIncomeBeforeQbi - qbi.deduction);
  const stateTaxableIncome = taxableIncomeBeforeQbi;
  const derivedPropertyStates = buildDerivedPropertyStates({
    scheduleE,
    depreciation,
    rentalUseFractionByProperty,
    scheduleEIncludesDepreciation,
  });
  const normalizedPropertyStates = Array.isArray(propertyStates) && propertyStates.length > 0
    ? propertyStates
    : derivedPropertyStates;
  const distinctPropertyStates = Array.from(new Set(
    (normalizedPropertyStates || [])
      .map((state) => normalizeStateCode(state?.stateCode))
      .filter(Boolean)
  ));
  const normalizedHomeState = normalizeStateCode(homeState);
  const shouldUseMultiStateModel = distinctPropertyStates.length > 1
    || (distinctPropertyStates.length === 1 && normalizedHomeState && distinctPropertyStates[0] !== normalizedHomeState);

  // Federal tax
  const federalTax = calculateFederalTax(taxableIncome, filingStatus, resolvedRuleset);

  // State tax (use multi-state if property states provided, otherwise use home state)
  let stateTaxResult;
  if (shouldUseMultiStateModel && normalizedPropertyStates.length > 0) {
    stateTaxResult = calculateMultiStateTax(stateTaxableIncome, normalizedPropertyStates, homeState, filingStatus);
  } else {
    const singleState = calculateStateTax(stateTaxableIncome, homeState, filingStatus);
    stateTaxResult = {
      states: [singleState],
      totalStateTax: singleState.tax,
      homeState,
      filingStatus
    };
  }

  // NIIT — Net Investment Income Tax (3.8% for high earners)
  const niitThreshold = filingStatus === 'married_filing_jointly' ? 250000 : 200000;
  const niit = grossIncome > niitThreshold
    ? Math.round(Math.min(Math.max(0, adjustedRentalIncome), grossIncome - niitThreshold) * 0.038 * 100) / 100
    : 0;

  const totalTax = Math.round((federalTax.totalTax + stateTaxResult.totalStateTax + niit) * 100) / 100;
  const normalizedCredits = Math.max(0, Number(taxCredits) || 0);
  const normalizedWithholding = Math.max(0, Number(withholdingYtd) || 0);
  const creditsApplied = Math.round(Math.min(totalTax, normalizedCredits) * 100) / 100;
  const taxAfterCredits = Math.round(Math.max(0, totalTax - creditsApplied) * 100) / 100;
  const withholdingApplied = Math.round(Math.min(taxAfterCredits, normalizedWithholding) * 100) / 100;

  // State withholding is applied strictly against the state-tax portion so it
  // never offsets federal liability. A null input means "not provided".
  const normalizedStateWithholding = stateWithholdingYtd === null || stateWithholdingYtd === undefined
    ? null
    : Math.max(0, Number(stateWithholdingYtd) || 0);
  const stateTaxTotal = stateTaxResult.totalStateTax;
  const stateWithholdingApplied = roundCurrency(Math.min(stateTaxTotal, normalizedStateWithholding || 0));
  const stateNetDue = roundCurrency(Math.max(0, stateTaxTotal - stateWithholdingApplied));
  const stateOverpayment = roundCurrency(Math.max(0, (normalizedStateWithholding || 0) - stateTaxTotal));

  const netDue = Math.round(Math.max(0, taxAfterCredits - withholdingApplied - stateWithholdingApplied) * 100) / 100;
  const overpayment = Math.round(Math.max(0, normalizedWithholding - taxAfterCredits) * 100) / 100;
  const modelingReadiness = buildTaxModelingReadiness({
    scheduleE,
    depreciation,
    homeState,
    rentalStates,
    propertyStateAllocations: normalizedPropertyStates,
    passiveLoss,
    adjustedRentalIncome,
    qbi,
  });

  return {
    taxYear,
    filingStatus,
    income: {
      rental: Math.round(adjustedRentalIncome * 100) / 100,
      rentalBeforeDepreciation: Math.round(rentalNetIncome * 100) / 100,
      depreciation: Math.round(depreciationAmount * 100) / 100,
      depreciationBeforePersonalUse: Math.round(fullDepreciationAmount * 100) / 100,
      rentalAllowable: passiveLoss.allowableRentalIncome,
      carryforwardLoss: passiveLoss.carryforwardLoss,
      other: otherIncome,
      gross: Math.round(grossIncome * 100) / 100
    },
    deductions: {
      method: useItemized ? 'itemized' : 'standard',
      standardDeduction,
      itemizedDeductions: otherDeductions,
      totalDeductions,
      qbiDeduction: qbi.deduction,
    },
    taxableIncome: Math.round(taxableIncome * 100) / 100,
    taxableIncomeBeforeQbi: Math.round(taxableIncomeBeforeQbi * 100) / 100,
    stateTaxableIncome: Math.round(stateTaxableIncome * 100) / 100,
    taxes: {
      federal: federalTax.totalTax,
      state: stateTaxResult.totalStateTax,
      stateDetails: stateTaxResult.states,
      propertyStateAllocations: normalizedPropertyStates,
      niit,
      total: totalTax,
      creditsApplied,
      withholdingApplied,
      stateWithholdingApplied,
      stateNetDue,
      stateOverpayment,
      afterCredits: taxAfterCredits,
      netDue,
      overpayment
    },
    stateWithholding: {
      provided: normalizedStateWithholding !== null,
      input: normalizedStateWithholding,
      applied: stateWithholdingApplied,
      source: normalizedStateWithholding !== null ? (stateWithholdingSource || 'manual_input') : null,
      appliedAgainst: 'state_tax_only',
      stateNetDue,
      stateOverpayment,
      note: normalizedStateWithholding !== null
        ? 'State withholding is applied only against the calculated state-tax portion; it never reduces federal liability. Combined netDue reflects both federal and state withholding.'
        : 'No state withholding was provided or derived, so the state portion of netDue assumes zero state payments to date.'
    },
    personalUseAdjustment: {
      applies: hasPersonalUseLimitedProperties,
      scheduleE: scheduleE.personalUseAdjustment || null,
      depreciation: {
        before: roundCurrency(fullDepreciationAmount),
        after: roundCurrency(depreciationAmount),
        disallowed: depreciationDisallowed,
      },
      notes: hasPersonalUseLimitedProperties
        ? [
            ...(scheduleE.personalUseAdjustment?.notes || []),
            depreciationDisallowed > 0
              ? `Depreciation was prorated by the rental-use percentage for mixed-use properties: $${depreciationDisallowed.toLocaleString()} of current-year depreciation was excluded as the personal-use share.`
              : null,
          ].filter(Boolean)
        : [],
    },
    rates: {
      effectiveFederal: federalTax.effectiveRate,
      marginalFederal: federalTax.marginalRate,
      effectiveState: stateTaxableIncome > 0 ? Math.round((stateTaxResult.totalStateTax / stateTaxableIncome * 100) * 100) / 100 : 0,
      effectiveTotal: taxableIncomeBeforeQbi > 0 ? Math.round((totalTax / taxableIncomeBeforeQbi * 100) * 100) / 100 : 0
    },
    modelingReadiness,
    rulesGovernance: resolvedRuleset?.governance || null,
    priorYearContext: {
      priorYearTotalTax: normalizeOptionalNumber(priorYearTotalTax),
      priorYearAdjustedGrossIncome: normalizeOptionalNumber(priorYearAdjustedGrossIncome),
      priorYearSafeHarborPercent: getPriorYearSafeHarborPercent(filingStatus, priorYearAdjustedGrossIncome),
    },
    passiveLoss,
    qbi,
    depreciation: depreciation?.summary || null,
    federalBreakdown: federalTax.breakdown,
    generatedAt: new Date().toISOString()
  };
}

// ─── Passive Loss Analysis ───────────────────────────────────────────────────

/**
 * Analyze passive activity loss rules (IRC §469)
 */
export function analyzePassiveLoss(rentalNetIncome, otherIncome, filingStatus = 'single') {
  if (rentalNetIncome >= 0) {
    return {
      hasLoss: false,
      allowableRentalIncome: rentalNetIncome,
      disallowedLoss: 0,
      carryforwardLoss: 0,
      reason: 'Rental activity generated net income — no loss limitation applies'
    };
  }

  const loss = Math.abs(rentalNetIncome);
  const magi = otherIncome;

  // Active participation: up to $25K deductible for MAGI < $100K
  // Phases out $1 for every $2 of MAGI over $100K, fully phased out at $150K
  let activeParticipationAllowance = 0;

  if (filingStatus === 'married_filing_separately') {
    activeParticipationAllowance = 0; // MFS gets no allowance if lived together
  } else if (magi < 100000) {
    activeParticipationAllowance = 25000;
  } else if (magi < 150000) {
    activeParticipationAllowance = Math.max(0, 25000 - (magi - 100000) * 0.5);
  }

  const allowableLoss = Math.min(loss, activeParticipationAllowance);
  const disallowedLoss = loss - allowableLoss;

  return {
    hasLoss: true,
    totalLoss: loss,
    allowableRentalIncome: -allowableLoss,
    allowableLoss,
    disallowedLoss,
    carryforwardLoss: disallowedLoss,
    activeParticipationAllowance,
    magiLimit: magi >= 150000,
    reason: disallowedLoss > 0
      ? `Passive loss limited to $${allowableLoss.toLocaleString()}. $${disallowedLoss.toLocaleString()} carries forward to future years.`
      : `Full loss of $${loss.toLocaleString()} allowed under active participation rules.`
  };
}

// ─── Quarterly Estimate Calculator ───────────────────────────────────────────

/**
 * Calculate quarterly estimated tax using real bracket calculations
 * @param {Array} entries - All journal entries for the year
 * @param {number} taxYear - Tax year
 * @param {number} quarter - Quarter (1-4)
 * @param {Object} params - Tax parameters (filingStatus, otherIncome, homeState)
 */
export function calculateQuarterlyEstimate(entries, taxYear, quarter, params = {}, ruleset = null) {
  const {
    filingStatus = 'single',
    otherIncome = 0,
    otherDeductions = 0,
    taxCredits = 0,
    withholdingYtd = 0,
    stateWithholdingYtd = null,
    stateWithholdingSource = null,
    rentalServiceHours = null,
    homeState = null,
    annualDepreciation = 0,
    qualifiedPropertyBasis = 0,
    priorYearTotalTax = null,
    priorYearAdjustedGrossIncome = null,
    projectionQuarter = quarter,
    rentalStates = [],
    personalUseLimitedPropertyCount = 0,
    properties = [],
    propertyId = null,
  } = params;
  const resolvedRuleset = resolveTaxRuleset(taxYear, ruleset);
  const normalizedQuarter = normalizeQuarterNumber(quarter, Math.ceil((new Date().getMonth() + 1) / 3));
  const withholdingProjectionQuarter = normalizeQuarterNumber(projectionQuarter, normalizedQuarter);
  const { start, end } = getQuarterDateRange(taxYear, normalizedQuarter);
  const dueDates = {
    1: adjustTaxDeadlineToBusinessDay(`${taxYear}-04-15`),
    2: adjustTaxDeadlineToBusinessDay(`${taxYear}-06-15`),
    3: adjustTaxDeadlineToBusinessDay(`${taxYear}-09-15`),
    4: adjustTaxDeadlineToBusinessDay(`${taxYear + 1}-01-15`)
  };
  const ytdStart = `${taxYear}-01-01`;
  const quarterSnapshot = buildScheduleEPeriodSnapshot({
    entries,
    taxYear,
    start,
    end,
    propertyId,
    properties,
    ruleset: resolvedRuleset,
  });
  const ytdSnapshot = buildScheduleEPeriodSnapshot({
    entries,
    taxYear,
    start: ytdStart,
    end,
    propertyId,
    properties,
    ruleset: resolvedRuleset,
  });
  const income = quarterSnapshot.income;
  const expenses = quarterSnapshot.expenses;
  const netIncome = quarterSnapshot.netIncome;
  const annualDepreciationAmount = Math.max(0, Number(annualDepreciation) || 0);
  const annualizationFactor = 4 / normalizedQuarter;

  // Annualize year-to-date Schedule E-consistent rental results so the
  // estimated-payment preview matches the same tax treatment used elsewhere.
  const annualizedRentalIncomeBeforeDepreciation = roundCurrency(ytdSnapshot.netIncome * annualizationFactor);
  const annualizedRentalIncome = annualizedRentalIncomeBeforeDepreciation - annualDepreciationAmount;
  const passiveLoss = analyzePassiveLoss(annualizedRentalIncome, otherIncome, filingStatus);
  const annualizedIncome = otherIncome + passiveLoss.allowableRentalIncome;
  const standardDeductionTable = getStandardDeductionForRuleset(resolvedRuleset);
  const standardDeduction = standardDeductionTable[filingStatus] || standardDeductionTable.single;
  const deductionsUsed = Math.max(standardDeduction, Math.max(0, Number(otherDeductions) || 0));
  const annualizedTaxableBeforeQbi = Math.max(0, annualizedIncome - deductionsUsed);
  const qbi = buildQbiComputation({
    netRentalIncome: annualizedRentalIncome,
    filingStatus,
    taxableIncomeBeforeQbi: annualizedTaxableBeforeQbi,
    rentalServiceHours,
    qualifiedPropertyBasis,
  });
  const annualizedTaxable = Math.max(0, annualizedTaxableBeforeQbi - qbi.deduction);

  // Calculate annual tax layers, then compute the estimated-payment safe-harbor target.
  const federalTax = calculateFederalTax(annualizedTaxable, filingStatus, resolvedRuleset);
  const stateTax = calculateStateTax(annualizedTaxableBeforeQbi, homeState, filingStatus);
  const niitThreshold = filingStatus === 'married_filing_jointly' ? 250000 : 200000;
  const niit = annualizedIncome > niitThreshold
    ? roundCurrency(Math.min(Math.max(0, annualizedRentalIncome), annualizedIncome - niitThreshold) * 0.038)
    : 0;

  const annualTaxBeforeAdjustments = federalTax.totalTax + stateTax.tax + niit;
  const normalizedCredits = Math.max(0, Number(taxCredits) || 0);
  const normalizedWithholdingYtd = Math.max(0, Number(withholdingYtd) || 0);
  const creditsApplied = Math.min(annualTaxBeforeAdjustments, normalizedCredits);
  const taxAfterCredits = Math.max(0, annualTaxBeforeAdjustments - creditsApplied);
  const withholdingProjectionFactor = 4 / withholdingProjectionQuarter;
  const projectedAnnualFederalWithholding = roundCurrency(normalizedWithholdingYtd * withholdingProjectionFactor);
  // Keep state withholding visible for planning context, but do not net it
  // against the federal 1040-ES voucher requirement. The voucher output is a
  // federal estimated-payment schedule; state withholding may reduce a state
  // balance due, but it should not zero out the federal voucher itself.
  const normalizedStateWithholdingYtd = stateWithholdingYtd === null || stateWithholdingYtd === undefined
    ? null
    : Math.max(0, Number(stateWithholdingYtd) || 0);
  const projectedAnnualStateWithholding = roundCurrency(
    Math.min(
      (normalizedStateWithholdingYtd || 0) * withholdingProjectionFactor,
      Math.max(0, stateTax.tax)
    )
  );
  const projectedAnnualWithholding = roundCurrency(projectedAnnualFederalWithholding);
  const combinedProjectedAnnualWithholding = roundCurrency(projectedAnnualFederalWithholding + projectedAnnualStateWithholding);
  const currentYearSafeHarborAnnual = roundCurrency(taxAfterCredits * 0.9);
  const normalizedPriorYearTotalTax = normalizeOptionalNumber(priorYearTotalTax);
  const normalizedPriorYearAgi = normalizeOptionalNumber(priorYearAdjustedGrossIncome);
  const priorYearSafeHarborPercent = getPriorYearSafeHarborPercent(filingStatus, normalizedPriorYearAgi);
  const priorYearSafeHarborAnnual = normalizedPriorYearTotalTax === null
    ? null
    : roundCurrency(Math.max(0, normalizedPriorYearTotalTax) * priorYearSafeHarborPercent);
  const selectedAnnualRequiredPayment = priorYearSafeHarborAnnual === null
    ? currentYearSafeHarborAnnual
    : Math.min(currentYearSafeHarborAnnual, priorYearSafeHarborAnnual);
  const safeHarborMethod = priorYearSafeHarborAnnual === null
    ? 'current_year_only'
    : priorYearSafeHarborAnnual <= currentYearSafeHarborAnnual
      ? `prior_year_${Math.round(priorYearSafeHarborPercent * 100)}pct`
      : 'current_year_90pct';
  const remainingAnnualTax = Math.max(0, taxAfterCredits - projectedAnnualWithholding);
  const requiredEstimatedPaymentsAnnual = Math.max(0, selectedAnnualRequiredPayment - projectedAnnualWithholding);
  const quarterlyTax = roundCurrency(requiredEstimatedPaymentsAnnual / 4);
  const readiness = buildEstimatedTaxReadiness({
    homeState,
    priorYearTotalTax: normalizedPriorYearTotalTax,
    rentalStates,
    annualDepreciation: annualDepreciationAmount,
    annualizedRentalIncomeBeforeDepreciation,
    annualizedRentalIncome,
    qbi,
    personalUseLimitedPropertyCount,
  });

  return {
    taxYear,
    quarter: normalizedQuarter,
    period: { start, end },
    income: roundCurrency(income),
    expenses: roundCurrency(expenses),
    netIncome: roundCurrency(netIncome),
    estimatedTax: {
      federal: roundCurrency(federalTax.totalTax / 4),
      state: roundCurrency(stateTax.tax / 4),
      niit: roundCurrency(niit / 4),
      credits: roundCurrency(creditsApplied / 4),
      withholding: roundCurrency(projectedAnnualWithholding / 4),
      projectedCurrentYearTotal: roundCurrency(remainingAnnualTax / 4),
      total: quarterlyTax
    },
    annualized: {
      income: roundCurrency(annualizedIncome),
      annualizationFactor: roundCurrency(annualizationFactor),
      observedYtdRentalNetIncome: roundCurrency(ytdSnapshot.netIncome),
      rentalIncomeBeforeDepreciation: roundCurrency(annualizedRentalIncomeBeforeDepreciation),
      rentalIncomeAfterDepreciation: roundCurrency(annualizedRentalIncome),
      annualDepreciation: roundCurrency(annualDepreciationAmount),
      taxableIncomeBeforeQbi: roundCurrency(annualizedTaxableBeforeQbi),
      taxableIncome: roundCurrency(annualizedTaxable),
      qbiDeduction: roundCurrency(qbi.deduction),
      deductionsUsed,
      creditsApplied: roundCurrency(creditsApplied),
      projectedAnnualWithholding: roundCurrency(projectedAnnualWithholding),
      combinedProjectedAnnualWithholding: roundCurrency(combinedProjectedAnnualWithholding),
      projectedAnnualFederalWithholding: roundCurrency(projectedAnnualFederalWithholding),
      projectedAnnualStateWithholding: roundCurrency(projectedAnnualStateWithholding),
      remainingAnnualTax: roundCurrency(remainingAnnualTax),
      currentYearSafeHarborAnnual: roundCurrency(currentYearSafeHarborAnnual),
      priorYearSafeHarborAnnual: priorYearSafeHarborAnnual === null ? null : roundCurrency(priorYearSafeHarborAnnual),
      selectedAnnualRequiredPayment: roundCurrency(selectedAnnualRequiredPayment),
      requiredEstimatedPaymentsAnnual: roundCurrency(requiredEstimatedPaymentsAnnual),
      federalRate: federalTax.effectiveRate,
      stateRate: stateTax.effectiveRate
    },
    assumptions: {
      otherIncome: Math.round((Number(otherIncome) || 0) * 100) / 100,
      otherDeductions: Math.round((Number(otherDeductions) || 0) * 100) / 100,
      taxCredits: Math.round(normalizedCredits * 100) / 100,
      withholdingYtd: Math.round(normalizedWithholdingYtd * 100) / 100,
      stateWithholdingYtd: normalizedStateWithholdingYtd === null ? null : roundCurrency(normalizedStateWithholdingYtd),
      rentalServiceHours: Math.round(Math.max(0, Number(rentalServiceHours || 0)) * 100) / 100,
      projectionQuarter: withholdingProjectionQuarter,
      priorYearTotalTax: normalizedPriorYearTotalTax,
      priorYearAdjustedGrossIncome: normalizedPriorYearAgi,
    },
    safeHarbor: {
      methodUsed: safeHarborMethod,
      priorYearSafeHarborPercent: roundCurrency(priorYearSafeHarborPercent * 100),
      currentYearSafeHarborAnnual: roundCurrency(currentYearSafeHarborAnnual),
      priorYearSafeHarborAnnual: priorYearSafeHarborAnnual === null ? null : roundCurrency(priorYearSafeHarborAnnual),
      selectedAnnualRequiredPayment: roundCurrency(selectedAnnualRequiredPayment),
      requiredEstimatedPaymentsAnnual: roundCurrency(requiredEstimatedPaymentsAnnual),
      requiredQuarterlyPayment: roundCurrency(quarterlyTax),
      projectedAnnualWithholding: roundCurrency(projectedAnnualWithholding),
      combinedProjectedAnnualWithholding: roundCurrency(combinedProjectedAnnualWithholding),
      projectedAnnualFederalWithholding: roundCurrency(projectedAnnualFederalWithholding),
      projectedAnnualStateWithholding: roundCurrency(projectedAnnualStateWithholding),
      priorYearInputsComplete: normalizedPriorYearTotalTax !== null,
      priorYearHighIncomeThresholdTriggered: normalizedPriorYearTotalTax !== null && priorYearSafeHarborPercent > 1,
    },
    stateWithholding: {
      provided: normalizedStateWithholdingYtd !== null,
      ytdInput: normalizedStateWithholdingYtd,
      projectedAnnual: roundCurrency(projectedAnnualStateWithholding),
      source: normalizedStateWithholdingYtd !== null ? (stateWithholdingSource || 'manual_input') : null,
      treatment: 'tracked_separately_from_federal_1040es',
      note: normalizedStateWithholdingYtd !== null
        ? 'State withholding is tracked for planning context, but federal 1040-ES vouchers only net federal withholding. This state amount may still reduce a separate state balance due.'
        : 'No state withholding was provided or derived for this estimate.'
    },
    readiness,
    passiveLoss,
    qbi,
    rulesGovernance: resolvedRuleset?.governance || null,
    dueDate: dueDates[normalizedQuarter],
    formNumber: '1040-ES'
  };
}

// ─── Year-over-Year Comparison ───────────────────────────────────────────────

/**
 * Compare tax data between two years
 */
export function yearOverYearComparison(currentYearEntries, priorYearEntries, taxYear) {
  const currentScheduleE = generateScheduleE(currentYearEntries, taxYear);
  const priorScheduleE = generateScheduleE(priorYearEntries, taxYear - 1);

  const current = currentScheduleE.summary;
  const prior = priorScheduleE.summary;

  const pctChange = (curr, prev) => prev !== 0 ? Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10 : 0;

  // Line-by-line comparison
  const lineComparison = {};
  for (const key of Object.keys(currentScheduleE.scheduleELines)) {
    const currAmt = currentScheduleE.scheduleELines[key].amount;
    const priorAmt = priorScheduleE.scheduleELines[key].amount;
    lineComparison[key] = {
      name: currentScheduleE.scheduleELines[key].name,
      current: currAmt,
      prior: priorAmt,
      change: Math.round((currAmt - priorAmt) * 100) / 100,
      changePercent: pctChange(currAmt, priorAmt)
    };
  }

  return {
    currentYear: { year: taxYear, ...current },
    previousYear: { year: taxYear - 1, ...prior },
    changes: {
      income: {
        amount: Math.round((current.totalIncome - prior.totalIncome) * 100) / 100,
        percent: pctChange(current.totalIncome, prior.totalIncome)
      },
      expenses: {
        amount: Math.round((current.totalExpenses - prior.totalExpenses) * 100) / 100,
        percent: pctChange(current.totalExpenses, prior.totalExpenses)
      },
      netIncome: {
        amount: Math.round((current.netIncomeOrLoss - prior.netIncomeOrLoss) * 100) / 100,
        percent: pctChange(current.netIncomeOrLoss, prior.netIncomeOrLoss)
      }
    },
    lineComparison
  };
}

// ─── Missed Deductions Finder ────────────────────────────────────────────────

/**
 * Analyze Schedule E for commonly missed deductions
 * Fully data-driven — only suggests deductions based on what's actually missing from the user's data.
 * Includes entry details for drill-down in frontend.
 */
export function findMissedDeductions(scheduleE, depreciation, entries = []) {
  const suggestions = [];

  const checks = [
    { key: 'ADVERTISING', suggestion: 'Did you advertise your rental? Zillow, Apartments.com, Craigslist, yard signs — all deductible.', priority: 'high' },
    { key: 'AUTO_TRAVEL', suggestion: 'Track mileage to properties, hardware stores, tenant showings. 2025 rate: $0.70/mile.', priority: 'high' },
    { key: 'LEGAL_PROFESSIONAL', suggestion: 'CPA/accountant fees for tax prep, attorney fees for lease review or evictions — deductible.', priority: 'medium' },
    { key: 'INSURANCE', suggestion: 'Landlord insurance, umbrella policy, flood insurance, loss-of-rent coverage — all Schedule E deductions.', priority: 'medium' },
    { key: 'SUPPLIES', suggestion: 'Cleaning supplies, hardware, paint, light bulbs, smoke detectors, locksets — often forgotten.', priority: 'medium' },
    { key: 'MANAGEMENT_FEES', suggestion: 'Property management software subscriptions (Buildium, AppFolio, Renaissance Realty) are deductible.', priority: 'low' }
  ];

  for (const check of checks) {
    const lineData = scheduleE.scheduleELines[check.key];
    if (lineData && lineData.amount === 0) {
      suggestions.push({
        category: lineData.name,
        line: lineData.line,
        currentAmount: 0,
        suggestion: check.suggestion,
        priority: check.priority,
        estimatedSavings: null,
        entries: [] // No entries for $0 categories
      });
    }
  }

  // Depreciation check — only show if they have properties but no depreciation set up
  if (!depreciation || depreciation.summary?.assetCount === 0) {
    // Check if they have rental income — if they do, depreciation is almost certainly missing
    const hasRentalIncome = (scheduleE.summary?.totalIncome || 0) > 0;
    if (hasRentalIncome) {
      suggestions.push({
        category: 'Property Depreciation',
        line: 18,
        currentAmount: 0,
        suggestion: 'No properties set up for depreciation. This is typically the LARGEST deduction for landlords — approximately $13,000+/year for a $400K property. Add your property purchase details.',
        priority: 'critical',
        estimatedSavings: 'Varies — typically $3,000-$8,000+ in tax savings',
        entries: []
      });
    }
  }

  // Home Office — only suggest if they have enough expenses to suggest active management
  const totalExpenses = scheduleE.summary?.totalExpenses || 0;
  const hasMultipleCategories = Object.values(scheduleE.scheduleELines).filter(l => l.amount > 0).length >= 3;
  if (totalExpenses > 1000 && hasMultipleCategories) {
    const otherLine = scheduleE.scheduleELines.OTHER;
    const hasHomeOffice = otherLine?.entries?.some(e =>
      (e.description || '').toLowerCase().includes('home office') ||
      (e.description || '').toLowerCase().includes('office')
    );
    if (!hasHomeOffice) {
      suggestions.push({
        category: 'Home Office Deduction',
        line: 19,
        currentAmount: 0,
        suggestion: 'If you manage rentals from home, simplified method: $5/sq ft × up to 300 sq ft = $1,500 deduction.',
        priority: 'medium',
        estimatedSavings: 'Up to $1,500',
        entries: []
      });
    }
  }

  // QBI — only suggest if net income is positive (QBI only applies to profitable rentals)
  const netIncome = scheduleE.summary?.netIncomeOrLoss || 0;
  if (netIncome > 5000) {
    suggestions.push({
      category: 'QBI Deduction (§199A)',
      line: null,
      currentAmount: 0,
      suggestion: `With ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(netIncome)} net rental income, you may qualify for a 20% QBI deduction (up to ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(netIncome * 0.2))}). Requires 250+ hours/year in rental activities under Safe Harbor.`,
      priority: 'medium',
      estimatedSavings: `Up to ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(netIncome * 0.2))}`,
      entries: []
    });
  }

  // Add populated categories with their entries for drill-down
  const populatedCategories = [];
  for (const [key, lineData] of Object.entries(scheduleE.scheduleELines)) {
    if (lineData.amount > 0 && lineData.entries?.length > 0) {
      populatedCategories.push({
        category: lineData.name,
        line: lineData.line,
        currentAmount: lineData.amount,
        entryCount: lineData.entries.length,
        entries: lineData.entries.slice(0, 10) // Cap at 10 for response size
      });
    }
  }

  return {
    suggestions: suggestions.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.priority] || 9) - (order[b.priority] || 9);
    }),
    populatedCategories,
    potentialSavingsRange: suggestions.length > 0 ? '$500 – $10,000+ depending on tax bracket and property values' : 'All common deductions appear to be captured!'
  };
}

// ─── Tax Calendar ────────────────────────────────────────────────────────────

/**
 * Generate tax deadline calendar
 */
export function getTaxCalendar(taxYear, ruleset = null) {
  const now = new Date();
  const resolvedRuleset = resolveTaxRuleset(taxYear, ruleset);
  const rawDeadlines = getDeadlineTemplatesForRuleset(resolvedRuleset, taxYear);

  // Apply IRS weekend/holiday adjustment to all dates
  const deadlines = rawDeadlines.map(d => {
    const adjusted = adjustTaxDeadlineToBusinessDay(d.date);
    return {
      ...d,
      date: adjusted,
      originalDate: d.date !== adjusted ? d.date : undefined,
      wasAdjusted: d.date !== adjusted
    };
  });

  const enriched = deadlines.map(d => {
    const deadlineDate = new Date(d.date);
    const daysUntil = Math.ceil((deadlineDate - now) / (1000 * 60 * 60 * 24));
    let status = 'upcoming';
    if (daysUntil < 0) status = 'past';
    else if (daysUntil <= 7) status = 'urgent';
    else if (daysUntil <= 30) status = 'soon';

    return { ...d, daysUntil, status };
  });

  const nextDeadline = enriched.find(d => d.status !== 'past');
  
  return {
    taxYear,
    deadlines: enriched,
    nextDeadline,
    daysUntilNextDeadline: nextDeadline?.daysUntil ?? null
  };
}

// ─── ATTOM Mortgage / Form 1098 helpers ──────────────────────────────────────

export function resolvePropertyMortgageFields(property = {}) {
  const meta = property.metadata || {};
  return {
    propertyId: property.id || property.propertyId || null,
    propertyName: property.name || property.address || 'Rental property',
    propertyAddress: property.address || '',
    lender: property.mortgageLender
      || property.attomMortgageLender
      || meta.mortgageLender
      || meta.attomMortgageLender
      || null,
    loanAmount: parseFloat(property.attomMortgageAmount || property.mortgageAmount || meta.attomMortgageAmount || meta.mortgageAmount) || null,
    rate: parseFloat(property.attomMortgageRate || property.mortgageRate || meta.attomMortgageRate || meta.mortgageRate) || null,
    termMonths: parseInt(property.mortgageTermMonths || property.attomMortgageTerm || meta.mortgageTermMonths || meta.mortgageTermMonths || 360, 10),
    originationDate: property.mortgageDate || property.attomLastSaleDate || property.purchaseDate || meta.mortgageDate || null,
  };
}

export function estimateAnnualMortgageInterestForYear(mortgage, taxYear) {
  const { loanAmount, rate, termMonths, originationDate } = mortgage || {};
  if (!loanAmount || !rate || !originationDate || !taxYear) return null;

  let totalInterest = 0;
  for (let month = 1; month <= 12; month += 1) {
    const paymentDate = `${taxYear}-${String(month).padStart(2, '0')}-15`;
    const split = calculateMortgageSplit(loanAmount, rate, termMonths, originationDate, paymentDate);
    totalInterest += split.interest;
  }

  return Math.round(totalInterest * 100) / 100;
}

export function estimateOutstandingMortgagePrincipal(mortgage, taxYear) {
  const { loanAmount, rate, termMonths, originationDate } = mortgage || {};
  if (!loanAmount || !rate || !originationDate || !taxYear) return null;

  const split = calculateMortgageSplit(loanAmount, rate, termMonths, originationDate, `${taxYear}-12-31`);
  return split.remainingBalance;
}

export function buildMortgage1098Summaries(properties = [], scheduleE = null, taxYear = null) {
  const resolvedYear = taxYear || scheduleE?.taxYear || new Date().getFullYear();
  const ledgerInterest = scheduleE?.scheduleELines?.MORTGAGE_INTEREST?.amount || 0;
  const propertyProfiles = (properties || []).map((property) => {
    const fields = resolvePropertyMortgageFields(property);
    const attomEstimatedInterest = estimateAnnualMortgageInterestForYear(fields, resolvedYear);
    const outstandingPrincipal = estimateOutstandingMortgagePrincipal(fields, resolvedYear);
    return {
      ...fields,
      attomEstimatedInterest,
      outstandingPrincipal,
      hasAttomData: Boolean(fields.lender && fields.loanAmount && fields.rate && fields.originationDate),
    };
  });

  const attomEstimatedTotal = Math.round(
    propertyProfiles.reduce((sum, profile) => sum + (profile.attomEstimatedInterest || 0), 0) * 100,
  ) / 100;
  const lenderLabel = [...new Set(propertyProfiles.map((profile) => profile.lender).filter(Boolean))].join(' · ') || null;

  return {
    taxYear: resolvedYear,
    ledgerInterest,
    attomEstimatedTotal,
    lenderLabel,
    properties: propertyProfiles,
  };
}

function resolve1098InterestAmount(profile, mortgage1098 = {}) {
  const ledgerTotal = mortgage1098.ledgerInterest || 0;
  const attomTotal = mortgage1098.attomEstimatedTotal || 0;
  const profiles = mortgage1098.properties || [];

  if (profiles.length <= 1) {
    return ledgerTotal > 0 ? ledgerTotal : (profile.attomEstimatedInterest || 0);
  }

  if (ledgerTotal > 0 && attomTotal > 0 && profile.attomEstimatedInterest) {
    return Math.round((ledgerTotal * (profile.attomEstimatedInterest / attomTotal)) * 100) / 100;
  }

  return profile.attomEstimatedInterest || 0;
}

// ─── Tax Document Checklist ──────────────────────────────────────────────────

/**
 * Generate tax document readiness checklist
 */
export function getTaxDocumentChecklist(scheduleE, depreciation, vendors1099, ruleset = null, properties = []) {
  const taxYear = scheduleE.taxYear;
  const resolvedRuleset = resolveTaxRuleset(taxYear, ruleset);
  const mortgage1098 = buildMortgage1098Summaries(properties, scheduleE, taxYear);
  const lenderLabel = mortgage1098.lenderLabel;
  const ledgerInterest = scheduleE.scheduleELines.MORTGAGE_INTEREST?.amount || 0;
  const hasMortgageDocument = ledgerInterest > 0 || mortgage1098.attomEstimatedTotal > 0;

  const documents = [
    {
      name: 'Schedule E – Supplemental Income and Loss',
      required: scheduleE.summary.totalIncome > 0 || scheduleE.summary.totalExpenses > 0,
      status: 'data_ready',
      dueDate: `${taxYear + 1}-04-15`,
      icon: '📊',
      preview: {
        income: scheduleE.summary.totalIncome,
        expenses: scheduleE.summary.totalExpenses,
        netIncomeOrLoss: scheduleE.summary.netIncomeOrLoss
      }
    },
    {
      name: 'Form 4562 – Depreciation and Amortization',
      required: depreciation.summary.assetCount > 0,
      status: depreciation.summary.assetCount > 0 ? 'data_ready' : 'action_required',
      dueDate: `${taxYear + 1}-04-15`,
      icon: '🏠',
      dataSource: 'generated',
      preview: {
        assetCount: depreciation.summary.assetCount,
        totalDepreciation: depreciation.summary.totalCurrentYearDepreciation,
        note: 'Filled from rental property depreciation schedules using official IRS Form 4562 template.',
      }
    },
    {
      name: '1099-NEC Forms (for contractors)',
      required: (vendors1099?.totalForms || 0) > 0,
      status: (vendors1099?.formsReady || 0) === (vendors1099?.totalForms || 0) && (vendors1099?.totalForms || 0) > 0
        ? 'data_ready'
        : (vendors1099?.totalForms || 0) > 0 ? 'action_required' : 'not_applicable',
      dueDate: `${taxYear + 1}-01-31`,
      icon: '📋',
      preview: {
        vendorCount: vendors1099?.totalForms || 0,
        totalReportable: vendors1099?.totalAmount || 0,
        formsReady: vendors1099?.formsReady || 0,
        formsMissingInfo: vendors1099?.formsWithMissingInfo || 0,
        threshold: `${formatTax1099ThresholdFromRuleset(resolvedRuleset, taxYear)} (${getTax1099ThresholdSummaryFromRuleset(resolvedRuleset, taxYear)})`,
        filingMethod: 'Tax1099.com API',
        penalties: 'Late: $60–$340/form; Intentional disregard: $680/form (no cap)'
      }
    },
    {
      name: 'Form 1098 – Mortgage Interest Statement',
      required: hasMortgageDocument,
      status: hasMortgageDocument && (ledgerInterest > 0 || mortgage1098.attomEstimatedTotal > 0)
        ? 'data_ready'
        : hasMortgageDocument ? 'awaiting_lender' : 'not_applicable',
      dueDate: `${taxYear + 1}-01-31`,
      icon: '🏦',
      dataSource: mortgage1098.attomEstimatedTotal > 0 ? 'attom' : 'ledger',
      preview: {
        interestReported: ledgerInterest,
        attomEstimatedInterest: mortgage1098.attomEstimatedTotal,
        lenderOnFile: lenderLabel,
        mortgageProperties: mortgage1098.properties
          .filter((profile) => profile.hasAttomData || profile.lender)
          .map((profile) => ({
            propertyName: profile.propertyName,
            propertyAddress: profile.propertyAddress,
            lender: profile.lender,
            loanAmount: profile.loanAmount,
            rate: profile.rate,
            attomEstimatedInterest: profile.attomEstimatedInterest,
            outstandingPrincipal: profile.outstandingPrincipal,
            reportableInterest: resolve1098InterestAmount(profile, mortgage1098),
          })),
        note: lenderLabel
          ? `Lender ${lenderLabel} on file from ATTOM property records. We estimate ${taxYear} mortgage interest from the ATTOM loan amount/rate and compare it to the bookkeeping ledger (Schedule E Line 12). Your lender will mail the official Form 1098 in January — use that for filing and keep this draft as a CPA workpaper until then.`
          : 'Mortgage interest is captured in the bookkeeping ledger (Schedule E Line 12). Add ATTOM mortgage data on the property record for lender name and estimated interest, or wait for the lender-issued Form 1098 in January.'
      }
    },
    {
      name: 'Property Tax Records',
      required: scheduleE.scheduleELines.TAXES?.amount > 0,
      status: scheduleE.scheduleELines.TAXES?.amount > 0 ? 'data_ready' : 'not_applicable',
      dueDate: `${taxYear + 1}-04-15`,
      icon: '🏛️',
      dataSource: 'ledger',
      preview: {
        taxesPaid: scheduleE.scheduleELines.TAXES?.amount || 0,
        note: 'Property taxes paid are captured in the bookkeeping ledger (Schedule E Line 16). Provide county tax receipts or statements to your CPA as backup documentation.'
      }
    },
    {
      name: 'Insurance Premium Records',
      required: scheduleE.scheduleELines.INSURANCE?.amount > 0,
      status: scheduleE.scheduleELines.INSURANCE?.amount > 0 ? 'data_ready' : 'not_applicable',
      dueDate: `${taxYear + 1}-04-15`,
      icon: '🛡️',
      dataSource: 'ledger',
      preview: {
        premiumsPaid: scheduleE.scheduleELines.INSURANCE?.amount || 0,
        note: 'Insurance premiums are captured in the bookkeeping ledger (Schedule E Line 9). Provide policy declarations or premium invoices to your CPA as backup documentation.'
      }
    }
  ];

  return {
    taxYear,
    documents,
    summary: {
      total: documents.length,
      required: documents.filter(d => d.required).length,
      ready: documents.filter(d => d.status === 'data_ready').length,
      actionRequired: documents.filter(d => d.status === 'action_required').length,
      nextDeadline: documents.filter(d => d.required).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate
    }
  };
}

// ─── Mortgage Amortization Calculator ────────────────────────────────────────

/**
 * Calculate real interest/principal split for a mortgage payment
 * Replaces the hardcoded 60/30/10 split in classifier.js
 * 
 * @param {number} originalBalance - Original loan amount
 * @param {number} annualRate - Annual interest rate as percentage (e.g., 5.25)
 * @param {number} termMonths - Loan term in months (e.g., 360)
 * @param {string} originationDate - Loan origination date (YYYY-MM-DD)
 * @param {string} paymentDate - Date of this payment (YYYY-MM-DD)
 */
export function calculateMortgageSplit(originalBalance, annualRate, termMonths, originationDate, paymentDate) {
  const monthlyRate = annualRate / 100 / 12;
  
  // Calculate fixed monthly P&I payment
  const monthlyPayment = originalBalance *
    (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) /
    (Math.pow(1 + monthlyRate, termMonths) - 1);

  // Calculate how many months since origination
  const origDate = new Date(originationDate);
  const payDate = new Date(paymentDate);
  const monthsElapsed = (payDate.getFullYear() - origDate.getFullYear()) * 12 +
    (payDate.getMonth() - origDate.getMonth());

  // Calculate remaining balance at this point
  let balance = originalBalance;
  for (let i = 0; i < monthsElapsed; i++) {
    const interestPortion = balance * monthlyRate;
    const principalPortion = monthlyPayment - interestPortion;
    balance -= principalPortion;
  }

  // This month's split
  const interestPortion = balance * monthlyRate;
  const principalPortion = monthlyPayment - interestPortion;

  return {
    totalPayment: Math.round(monthlyPayment * 100) / 100,
    interest: Math.round(interestPortion * 100) / 100,
    principal: Math.round(principalPortion * 100) / 100,
    interestPercent: Math.round((interestPortion / monthlyPayment * 100) * 10) / 10,
    principalPercent: Math.round((principalPortion / monthlyPayment * 100) * 10) / 10,
    remainingBalance: Math.round(balance * 100) / 100,
    monthsElapsed,
    monthsRemaining: termMonths - monthsElapsed,
    // Annual totals for the year containing this payment
    estimatedAnnualInterest: Math.round(interestPortion * 12 * 100) / 100,
    estimatedAnnualPrincipal: Math.round(principalPortion * 12 * 100) / 100
  };
}

function estimateAnnualMortgageInterestFromProperty(property, taxYear) {
  const loanAmount = parseFloat(property?.attomMortgageAmount || property?.mortgageAmount || 0);
  const rate = parseFloat(property?.attomMortgageRate || property?.mortgageRate || 0);
  if (!(loanAmount > 0 && rate > 0)) {
    return 0;
  }

  const termMonths = parseInt(property?.mortgageTermMonths || property?.attomMortgageTerm || 360, 10);
  const originationDate = property?.attomLastSaleDate
    || property?.purchaseDate
    || property?.mortgageDate
    || `${taxYear - 3}-01-01`;

  let totalInterest = 0;
  for (let month = 1; month <= 12; month += 1) {
    const paymentDate = `${taxYear}-${String(month).padStart(2, '0')}-15`;
    const split = calculateMortgageSplit(loanAmount, rate, termMonths, originationDate, paymentDate);
    totalInterest += split.interest;
  }

  return Math.round(totalInterest * 100) / 100;
}

// ─── Real Estate Professional Analysis ───────────────────────────────────────

/**
 * Analyze whether user qualifies as a Real Estate Professional
 */
export function analyzeREProStatus(hoursData) {
  const { rentalHours = 0, otherWorkHours = 0 } = hoursData;
  const qualifies = rentalHours > 750 && rentalHours > otherWorkHours / 2;

  return {
    qualifiesAsREPro: qualifies,
    rentalHours,
    otherWorkHours,
    hourRequirement: { met: rentalHours > 750, required: 750, actual: rentalHours },
    moreHalfRequirement: { met: rentalHours > otherWorkHours / 2, threshold: Math.floor(otherWorkHours / 2), actual: rentalHours },
    benefits: qualifies ? [
      'Rental losses are non-passive — can offset W-2 and other income with no $25K cap',
      'No passive activity loss limitations',
      'Depreciation deductions fully usable against all income types'
    ] : [],
    recommendation: qualifies
      ? 'You may qualify as a Real Estate Professional. Document your hours carefully and consult a CPA.'
      : `You need ${Math.max(0, 751 - rentalHours)} more rental hours${otherWorkHours > 0 ? ` or ${Math.max(0, rentalHours * 2 - otherWorkHours + 1)} fewer W-2 hours` : ''} to qualify.`
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export {
  SCHEDULE_E_LINE_MAP,
  CATEGORY_TO_LINE,
  TAX_BRACKETS_2025,
  STANDARD_DEDUCTION_2025
};
