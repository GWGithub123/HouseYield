/**
 * Tax Benefits Analyzer for Rental Property Owners
 * ==================================================
 * Comprehensive analysis of all tax advantages available to real estate investors.
 * Goes beyond basic Schedule E to cover advanced strategies:
 *
 * - Per-category tax savings at user's marginal rate
 * - Cost Segregation analysis (5/7/15/27.5-year breakdowns)
 * - Bonus Depreciation eligibility (current year %)
 * - 1031 Exchange opportunity modeling
 * - QBI / §199A detailed calculator with Safe Harbor
 * - Safe Harbor De Minimis election ($2,500 threshold)
 * - Travel & mileage deduction calculator
 * - Tax-equivalent yield (rental vs. stocks/bonds)
 * - Depreciation recapture projection on future sale
 * - Year-by-year benefit timeline
 */

// ─── IRS Mileage Rates ──────────────────────────────────────────────────────
const IRS_MILEAGE_RATES = {
  2025: 0.70,
  2024: 0.67,
  2023: 0.655,
  2022: 0.625,  // H2 rate (H1 was 0.585)
};

// ─── Bonus Depreciation Phase-Out ────────────────────────────────────────────
// TCJA bonus depreciation phase-out schedule
const BONUS_DEPRECIATION_RATES = {
  2022: 1.00,    // 100%
  2023: 0.80,    // 80%
  2024: 0.60,    // 60%
  2025: 0.40,    // 40%
  2026: 0.20,    // 20%
  2027: 0.00,    // 0% — fully phased out
};

// ─── Cost Segregation Asset Classes ──────────────────────────────────────────
const COST_SEG_CLASSES = {
  personal5: {
    name: '5-Year Personal Property',
    life: 5,
    examples: 'Appliances, carpeting, window treatments, cabinetry, certain fixtures',
    typicalPercent: { low: 0.08, mid: 0.12, high: 0.18 }
  },
  personal7: {
    name: '7-Year Personal Property',
    life: 7,
    examples: 'Furniture, office equipment, security systems, outdoor signage',
    typicalPercent: { low: 0.03, mid: 0.05, high: 0.08 }
  },
  landImprovement15: {
    name: '15-Year Land Improvements',
    life: 15,
    examples: 'Sidewalks, driveways, fencing, landscaping, parking lots, outdoor lighting',
    typicalPercent: { low: 0.05, mid: 0.10, high: 0.15 }
  },
  building275: {
    name: '27.5-Year Residential Structure',
    life: 27.5,
    examples: 'Building shell, HVAC ducts in walls, plumbing in walls, electrical in walls',
    typicalPercent: { low: 0.60, mid: 0.73, high: 0.80 }
  }
};


// ─── Per-Category Tax Savings ────────────────────────────────────────────────

/**
 * Calculate actual dollar tax savings for each deduction category
 * at the user's marginal federal + state rate
 */
export function calculateDeductionSavings(scheduleE, marginalFederalRate, stateRate = 0, niitRate = 0) {
  const combinedRate = marginalFederalRate + stateRate + niitRate;

  const categories = [];
  let totalDeductions = 0;
  let totalSavings = 0;

  if (!scheduleE?.scheduleELines) return { categories: [], totalDeductions: 0, totalSavings: 0, combinedRate };

  for (const [key, data] of Object.entries(scheduleE.scheduleELines)) {
    if (data.type === 'expense' && data.amount > 0) {
      const savings = Math.round(data.amount * combinedRate * 100) / 100;
      categories.push({
        name: data.name,
        line: data.line,
        amount: data.amount,
        entries: data.entries,
        savings,
        savingsPercent: Math.round(combinedRate * 10000) / 100,
        effectiveRate: combinedRate
      });
      totalDeductions += data.amount;
      totalSavings += savings;
    }
  }

  // Sort by savings (largest first)
  categories.sort((a, b) => b.savings - a.savings);

  return {
    categories,
    totalDeductions: Math.round(totalDeductions * 100) / 100,
    totalSavings: Math.round(totalSavings * 100) / 100,
    combinedRate: Math.round(combinedRate * 10000) / 100,
    breakdown: {
      federalRate: Math.round(marginalFederalRate * 10000) / 100,
      stateRate: Math.round(stateRate * 10000) / 100,
      niitRate: Math.round(niitRate * 10000) / 100
    }
  };
}


// ─── Cost Segregation Analysis ───────────────────────────────────────────────

/**
 * Model the tax impact of a cost segregation study
 * Shows the difference between straight 27.5-year depreciation
 * vs. accelerated depreciation with cost seg
 */
export function analyzeCostSegregation(propertyValue, landPercent = 0.20, taxYear = 2025, marginalRate = 0.24) {
  const depreciableBasis = propertyValue * (1 - landPercent);
  const bonusRate = BONUS_DEPRECIATION_RATES[taxYear] ?? 0;

  // Without cost seg: straight-line 27.5 years
  const withoutCostSeg = {
    method: 'Standard 27.5-Year Straight Line',
    annualDepreciation: Math.round(depreciableBasis / 27.5 * 100) / 100,
    firstYearDepreciation: Math.round(depreciableBasis / 27.5 * 100) / 100,
    firstYearTaxSavings: Math.round(depreciableBasis / 27.5 * marginalRate * 100) / 100,
    totalOverLife: depreciableBasis,
    breakdownByClass: [{
      className: '27.5-Year Residential',
      basis: depreciableBasis,
      percent: 100,
      annualDepreciation: Math.round(depreciableBasis / 27.5 * 100) / 100
    }]
  };

  // With cost seg: accelerate portions into shorter-lived classes
  const allocations = {};
  let remainingBasis = depreciableBasis;

  for (const [classKey, classInfo] of Object.entries(COST_SEG_CLASSES)) {
    if (classKey === 'building275') continue; // Residual goes here
    const midPercent = classInfo.typicalPercent.mid;
    const classBasis = Math.round(depreciableBasis * midPercent * 100) / 100;
    allocations[classKey] = {
      className: classInfo.name,
      life: classInfo.life,
      basis: classBasis,
      percent: Math.round(midPercent * 100),
      examples: classInfo.examples,
      // Bonus depreciation applies to 5, 7, and 15-year property
      bonusEligible: true,
      bonusAmount: Math.round(classBasis * bonusRate * 100) / 100,
      remainingBasis: Math.round(classBasis * (1 - bonusRate) * 100) / 100,
      annualAfterBonus: Math.round(classBasis * (1 - bonusRate) / classInfo.life * 100) / 100,
      firstYearTotal: Math.round((classBasis * bonusRate + classBasis * (1 - bonusRate) / classInfo.life) * 100) / 100
    };
    remainingBasis -= classBasis;
  }

  // Remainder stays at 27.5 years (building shell)
  allocations.building275 = {
    className: '27.5-Year Residential Structure',
    life: 27.5,
    basis: Math.round(remainingBasis * 100) / 100,
    percent: Math.round((remainingBasis / depreciableBasis) * 100),
    examples: COST_SEG_CLASSES.building275.examples,
    bonusEligible: false,
    bonusAmount: 0,
    remainingBasis: Math.round(remainingBasis * 100) / 100,
    annualAfterBonus: Math.round(remainingBasis / 27.5 * 100) / 100,
    firstYearTotal: Math.round(remainingBasis / 27.5 * 100) / 100
  };

  const firstYearWithCostSeg = Object.values(allocations).reduce((sum, a) => sum + a.firstYearTotal, 0);

  const withCostSeg = {
    method: `Cost Segregation + ${Math.round(bonusRate * 100)}% Bonus Depreciation`,
    annualDepreciation: null, // Varies by year
    firstYearDepreciation: Math.round(firstYearWithCostSeg * 100) / 100,
    firstYearTaxSavings: Math.round(firstYearWithCostSeg * marginalRate * 100) / 100,
    totalOverLife: depreciableBasis, // Same total, just timing difference
    breakdownByClass: Object.values(allocations)
  };

  const benefit = {
    additionalFirstYearDepreciation: Math.round((firstYearWithCostSeg - withoutCostSeg.firstYearDepreciation) * 100) / 100,
    additionalFirstYearTaxSavings: Math.round((withCostSeg.firstYearTaxSavings - withoutCostSeg.firstYearTaxSavings) * 100) / 100,
    multiplier: Math.round((firstYearWithCostSeg / withoutCostSeg.firstYearDepreciation) * 10) / 10,
    bonusDepreciationRate: Math.round(bonusRate * 100),
    costSegStudyCost: propertyValue > 1000000 ? '$8,000 – $15,000' : '$5,000 – $10,000',
    breakEvenYear: withCostSeg.firstYearTaxSavings > 5000 ? 1 : 2,
    recommendation: firstYearWithCostSeg > withoutCostSeg.firstYearDepreciation * 2
      ? 'Strongly recommended — significant first-year tax savings'
      : firstYearWithCostSeg > withoutCostSeg.firstYearDepreciation * 1.3
        ? 'Worth considering — moderate first-year acceleration'
        : 'Marginal benefit — standard depreciation may be sufficient'
  };

  return {
    propertyValue,
    depreciableBasis,
    landPercent: Math.round(landPercent * 100),
    taxYear,
    marginalRate: Math.round(marginalRate * 100),
    withoutCostSeg,
    withCostSeg,
    benefit,
    note: 'Cost segregation studies must be performed by a qualified engineer. Amounts shown are estimates based on industry averages.'
  };
}


// ─── 1031 Exchange Modeling ──────────────────────────────────────────────────

/**
 * Model a 1031 like-kind exchange scenario
 * Shows tax deferred vs. selling outright
 */
export function model1031Exchange(params) {
  const {
    currentPropertyValue,
    originalPurchasePrice,
    accumulatedDepreciation = 0,
    holdingPeriodYears = 1,
    replacementPropertyValue = null,
    marginalRate = 0.24,
    stateRate = 0.05,
    capitalGainsRate = 0.15  // LTCG rate
  } = params;

  const adjustedBasis = originalPurchasePrice - accumulatedDepreciation;
  const totalGain = currentPropertyValue - adjustedBasis;
  const capitalGain = currentPropertyValue - originalPurchasePrice;
  const depreciationRecapture = accumulatedDepreciation; // Taxed at 25% max

  // Tax if selling outright (no 1031)
  const capitalGainsTax = Math.max(0, capitalGain) * capitalGainsRate;
  const recaptureTax = depreciationRecapture * 0.25; // §1250 recapture rate
  const stateTaxOnSale = totalGain * stateRate;
  // NIIT on gain if applicable
  const niitOnSale = totalGain * 0.038;
  const totalTaxWithoutExchange = Math.round((capitalGainsTax + recaptureTax + stateTaxOnSale + niitOnSale) * 100) / 100;

  // With 1031 exchange — all tax deferred
  const replacementValue = replacementPropertyValue || currentPropertyValue * 1.1; // Default: trade up 10%
  const newBasis = replacementValue - totalGain; // Carry over gain into new basis
  const boot = Math.max(0, currentPropertyValue - replacementValue); // Cash out = taxable "boot"
  const bootTax = boot > 0 ? Math.round(boot * capitalGainsRate * 100) / 100 : 0;

  return {
    currentProperty: {
      currentValue: currentPropertyValue,
      originalPrice: originalPurchasePrice,
      accumulatedDepreciation,
      adjustedBasis,
      totalGain: Math.round(totalGain * 100) / 100,
      capitalGain: Math.round(capitalGain * 100) / 100,
      depreciationRecapture
    },
    withoutExchange: {
      capitalGainsTax: Math.round(capitalGainsTax * 100) / 100,
      depreciationRecaptureTax: Math.round(recaptureTax * 100) / 100,
      stateTax: Math.round(stateTaxOnSale * 100) / 100,
      niit: Math.round(niitOnSale * 100) / 100,
      totalTax: totalTaxWithoutExchange,
      netProceeds: Math.round((currentPropertyValue - totalTaxWithoutExchange) * 100) / 100
    },
    with1031: {
      replacementPropertyValue: replacementValue,
      taxDeferred: totalTaxWithoutExchange - bootTax,
      boot,
      bootTax,
      newAdjustedBasis: Math.round(newBasis * 100) / 100,
      netReinvested: Math.round((currentPropertyValue - bootTax) * 100) / 100
    },
    savings: {
      immediateTaxSavings: Math.round((totalTaxWithoutExchange - bootTax) * 100) / 100,
      additionalCapitalAtWork: Math.round((totalTaxWithoutExchange - bootTax) * 100) / 100,
      // If reinvested capital earns 8% annually
      projectedGrowth5yr: Math.round((totalTaxWithoutExchange - bootTax) * Math.pow(1.08, 5) * 100) / 100,
      projectedGrowth10yr: Math.round((totalTaxWithoutExchange - bootTax) * Math.pow(1.08, 10) * 100) / 100
    },
    rules: {
      identificationPeriod: '45 days after sale to identify replacement properties',
      closingPeriod: '180 days after sale to close on replacement',
      qualifiedIntermediary: 'Must use a Qualified Intermediary (QI) — cannot touch proceeds',
      likeKind: 'Any real property held for investment → any real property held for investment',
      personalUse: 'Cannot be primary residence or vacation home used >14 days/year'
    },
    holdingPeriodYears,
    isLongTermCapGains: holdingPeriodYears >= 1
  };
}


// ─── QBI / §199A Deduction Calculator ────────────────────────────────────────

/**
 * Calculate Qualified Business Income deduction for rental activities
 * Requires Safe Harbor: 250+ hours of rental services per year
 */
export function calculateQBIDeduction(params) {
  const {
    netRentalIncome,
    rentalHoursPerYear = 0,
    filingStatus = 'single',
    totalTaxableIncome = 0,
    w2WagesFromRental = 0,         // W-2 wages paid (for SSTB/wage limit)
    unadjustedBasisOfProperty = 0   // UBIA for QBI limits
  } = params;

  // Safe Harbor requirements (Rev. Proc. 2019-38)
  const meetsHourRequirement = rentalHoursPerYear >= 250;
  const hasSeparateBooks = true; // Assume yes if they're using this software
  const safeHarborMet = meetsHourRequirement && hasSeparateBooks;

  if (netRentalIncome <= 0) {
    return {
      eligible: false,
      deduction: 0,
      reason: 'Net rental income must be positive to claim QBI deduction',
      safeHarborMet,
      details: null
    };
  }

  // QBI is 20% of qualified business income
  const rawQBI = netRentalIncome * 0.20;

  // Taxable income limits for full QBI
  const thresholds = {
    single: { lower: 191950, upper: 241950 },
    married_filing_jointly: { lower: 383900, upper: 483900 },
    married_filing_separately: { lower: 191950, upper: 241950 },
    head_of_household: { lower: 191950, upper: 241950 }
  };

  const threshold = thresholds[filingStatus] || thresholds.single;
  let qbiDeduction;
  let limitation = 'none';

  if (totalTaxableIncome <= threshold.lower) {
    // Below threshold — full 20% deduction
    qbiDeduction = rawQBI;
    limitation = 'none — below income threshold';
  } else if (totalTaxableIncome >= threshold.upper) {
    // Above threshold — subject to W-2 wages / UBIA limit
    const wageLimit = Math.max(
      w2WagesFromRental * 0.50,
      w2WagesFromRental * 0.25 + unadjustedBasisOfProperty * 0.025
    );
    qbiDeduction = Math.min(rawQBI, wageLimit);
    limitation = 'W-2 wages / UBIA limitation applies';
  } else {
    // Phase-in range
    const phaseInPct = (totalTaxableIncome - threshold.lower) / (threshold.upper - threshold.lower);
    const wageLimit = Math.max(
      w2WagesFromRental * 0.50,
      w2WagesFromRental * 0.25 + unadjustedBasisOfProperty * 0.025
    );
    const reduction = (rawQBI - Math.min(rawQBI, wageLimit)) * phaseInPct;
    qbiDeduction = rawQBI - reduction;
    limitation = `Phase-in range (${Math.round(phaseInPct * 100)}% through phase-out)`;
  }

  // Final cap: QBI cannot exceed 20% of total taxable income (before QBI deduction)
  const finalQBI = Math.min(qbiDeduction, totalTaxableIncome * 0.20);

  return {
    eligible: safeHarborMet && netRentalIncome > 0,
    deduction: Math.round(finalQBI * 100) / 100,
    safeHarborMet,
    reason: !safeHarborMet 
      ? `Need ${250 - rentalHoursPerYear} more rental service hours to meet Safe Harbor (250 required)`
      : `QBI deduction of 20% on $${netRentalIncome.toLocaleString()} net rental income`,
    details: {
      netRentalIncome,
      rawQBI: Math.round(rawQBI * 100) / 100,
      limitation,
      rentalHoursPerYear,
      hoursNeeded: Math.max(0, 250 - rentalHoursPerYear),
      taxSavings: null // Will be filled by caller with marginal rate
    },
    safeHarborRequirements: [
      { requirement: '250+ hours of rental services per year', met: meetsHourRequirement, hours: rentalHoursPerYear },
      { requirement: 'Separate books and records maintained', met: hasSeparateBooks },
      { requirement: 'Services documented with dates, hours, description', met: null, note: 'Must maintain contemporaneous records' }
    ]
  };
}


// ─── Travel & Mileage Calculator ─────────────────────────────────────────────

/**
 * Calculate travel deductions for rental property management
 */
export function calculateTravelDeduction(params) {
  const {
    taxYear = 2025,
    trips = [],       // Array of { purpose, miles, date }
    totalMiles = 0,   // Alternative: just provide total miles
    otherTravelExpenses = 0  // Hotels, flights, meals (50% for meals)
  } = params;

  const mileageRate = IRS_MILEAGE_RATES[taxYear] || IRS_MILEAGE_RATES[2025];
  const miles = trips.length > 0 ? trips.reduce((sum, t) => sum + (t.miles || 0), 0) : totalMiles;
  const mileageDeduction = Math.round(miles * mileageRate * 100) / 100;

  // Common trip examples for landlords
  const commonTrips = [
    { purpose: 'Property inspection / showing', estimatedMilesPerTrip: 20 },
    { purpose: 'Hardware store for supplies/repairs', estimatedMilesPerTrip: 15 },
    { purpose: 'Meeting with contractor', estimatedMilesPerTrip: 25 },
    { purpose: 'Bank / mortgage company', estimatedMilesPerTrip: 12 },
    { purpose: 'Tenant move-in / move-out walkthrough', estimatedMilesPerTrip: 20 },
    { purpose: 'CPA / attorney meeting', estimatedMilesPerTrip: 15 },
    { purpose: 'Real estate investing seminar / REIA', estimatedMilesPerTrip: 30 }
  ];

  return {
    taxYear,
    mileageRate,
    totalMiles: miles,
    mileageDeduction,
    otherTravelExpenses,
    totalTravelDeduction: Math.round((mileageDeduction + otherTravelExpenses) * 100) / 100,
    trips: trips.length > 0 ? trips.map(t => ({
      ...t,
      deduction: Math.round(t.miles * mileageRate * 100) / 100
    })) : [],
    commonTripExamples: commonTrips,
    tips: [
      `Use a mileage tracking app (MileIQ, Everlance) to log every trip automatically.`,
      `The ${taxYear} IRS standard mileage rate is $${mileageRate}/mile.`,
      `You can deduct mileage OR actual expenses (gas, insurance, depreciation) — not both.`,
      `Keep a log with: date, destination, business purpose, and miles driven.`,
      `Trips between your home and a rental property are deductible if you have a home office.`
    ]
  };
}


// ─── Safe Harbor De Minimis ──────────────────────────────────────────────────

/**
 * Analyze whether expenses qualify for the de minimis safe harbor
 * election (Reg. §1.263(a)-1(f))
 */
export function analyzeDeMinimis(expenses) {
  const THRESHOLD = 2500; // Per invoice / per item
  
  const qualifying = [];
  const capitalizing = [];

  for (const expense of expenses) {
    if (expense.amount <= THRESHOLD) {
      qualifying.push({
        ...expense,
        treatment: 'Deduct immediately under de minimis safe harbor',
        benefit: 'Full deduction in current year'
      });
    } else {
      capitalizing.push({
        ...expense,
        treatment: 'Must capitalize and depreciate',
        depreciationLife: expense.category === 'appliance' ? 5 : expense.category === 'improvement' ? 27.5 : 7,
        benefit: `Deduct over ${expense.category === 'appliance' ? 5 : expense.category === 'improvement' ? 27.5 : 7} years`
      });
    }
  }

  return {
    threshold: THRESHOLD,
    totalExpenses: expenses.length,
    qualifyingCount: qualifying.length,
    capitalizingCount: capitalizing.length,
    immediateDeduction: Math.round(qualifying.reduce((sum, q) => sum + q.amount, 0) * 100) / 100,
    mustCapitalize: Math.round(capitalizing.reduce((sum, c) => sum + c.amount, 0) * 100) / 100,
    qualifying,
    capitalizing,
    electionNote: 'The de minimis safe harbor election must be made annually on your tax return. Attach a statement to your return or include in your tax prep notes.',
    irsCitation: 'Reg. §1.263(a)-1(f)(1)(ii) — $2,500 threshold for taxpayers without applicable financial statements'
  };
}


// ─── Tax-Equivalent Yield ────────────────────────────────────────────────────

/**
 * Compare rental property returns to traditional investments
 * on an after-tax basis, accounting for all tax benefits
 */
export function calculateTaxEquivalentYield(params) {
  const {
    propertyValue,
    annualRentalIncome,
    annualExpenses,
    annualDepreciation,
    mortgageInterest = 0,
    propertyAppreciationRate = 0.03,
    marginalTaxRate = 0.24,
    stateRate = 0.05,
    capitalGainsRate = 0.15
  } = params;

  const combinedRate = marginalTaxRate + stateRate;
  const netOperatingIncome = annualRentalIncome - annualExpenses;

  // Pre-tax return
  const preTaxCashReturn = netOperatingIncome;
  const preTaxAppreciation = propertyValue * propertyAppreciationRate;
  const preTaxTotalReturn = preTaxCashReturn + preTaxAppreciation;
  const preTaxYield = (preTaxTotalReturn / propertyValue) * 100;

  // Tax benefits reduce effective tax burden
  const depreciationTaxSavings = annualDepreciation * combinedRate;
  const mortgageInterestTaxSavings = mortgageInterest * combinedRate;
  const totalTaxBenefits = depreciationTaxSavings + mortgageInterestTaxSavings;

  // After-tax rental return
  const taxableIncome = Math.max(0, netOperatingIncome - annualDepreciation - mortgageInterest);
  const incomeTaxOwed = taxableIncome * combinedRate;
  const afterTaxCashFlow = preTaxCashReturn - incomeTaxOwed;
  // Appreciation is tax-deferred (only taxed at sale)
  const afterTaxTotalReturn = afterTaxCashFlow + preTaxAppreciation;
  const afterTaxYield = (afterTaxTotalReturn / propertyValue) * 100;

  // What stock/bond yield would equal this after-tax return?
  const taxEquivalentYield = afterTaxYield / (1 - combinedRate);

  // Comparison investments (after-tax)
  const comparisons = [
    {
      name: 'Savings Account (5% APY)',
      preTaxYield: 5.0,
      afterTaxYield: Math.round(5.0 * (1 - combinedRate) * 100) / 100,
      annualAfterTax: Math.round(propertyValue * 0.05 * (1 - combinedRate) * 100) / 100
    },
    {
      name: 'S&P 500 Index (avg 10%)',
      preTaxYield: 10.0,
      afterTaxYield: Math.round(10.0 * (1 - capitalGainsRate) * 100) / 100,
      annualAfterTax: Math.round(propertyValue * 0.10 * (1 - capitalGainsRate) * 100) / 100
    },
    {
      name: 'Corporate Bond (6%)',
      preTaxYield: 6.0,
      afterTaxYield: Math.round(6.0 * (1 - combinedRate) * 100) / 100,
      annualAfterTax: Math.round(propertyValue * 0.06 * (1 - combinedRate) * 100) / 100
    },
    {
      name: 'This Rental Property',
      preTaxYield: Math.round(preTaxYield * 100) / 100,
      afterTaxYield: Math.round(afterTaxYield * 100) / 100,
      annualAfterTax: Math.round(afterTaxTotalReturn * 100) / 100
    }
  ];

  return {
    propertyValue,
    preTax: {
      cashReturn: Math.round(preTaxCashReturn * 100) / 100,
      appreciation: Math.round(preTaxAppreciation * 100) / 100,
      totalReturn: Math.round(preTaxTotalReturn * 100) / 100,
      yield: Math.round(preTaxYield * 100) / 100
    },
    taxBenefits: {
      depreciationSavings: Math.round(depreciationTaxSavings * 100) / 100,
      mortgageInterestSavings: Math.round(mortgageInterestTaxSavings * 100) / 100,
      total: Math.round(totalTaxBenefits * 100) / 100
    },
    afterTax: {
      taxableIncome: Math.round(taxableIncome * 100) / 100,
      taxOwed: Math.round(incomeTaxOwed * 100) / 100,
      cashFlow: Math.round(afterTaxCashFlow * 100) / 100,
      totalReturn: Math.round(afterTaxTotalReturn * 100) / 100,
      yield: Math.round(afterTaxYield * 100) / 100
    },
    taxEquivalentYield: Math.round(taxEquivalentYield * 100) / 100,
    comparisons: comparisons.sort((a, b) => b.afterTaxYield - a.afterTaxYield),
    insight: afterTaxYield > 5.0 * (1 - combinedRate)
      ? `Your rental property's after-tax yield (${Math.round(afterTaxYield * 100) / 100}%) outperforms a 5% savings account (${Math.round(5.0 * (1 - combinedRate) * 100) / 100}% after tax). Tax benefits like depreciation add ${Math.round(totalTaxBenefits)} in annual savings.`
      : `Consider ways to increase your yield through expense reduction or rent optimization.`
  };
}


// ─── Depreciation Recapture Projection ───────────────────────────────────────

/**
 * Project the depreciation recapture tax when eventually selling
 */
export function projectDepreciationRecapture(params) {
  const {
    originalBasis,
    totalDepreciationTaken,
    estimatedSalePrice,
    holdingPeriodYears,
    marginalRate = 0.24,
    stateRate = 0.05
  } = params;

  const adjustedBasis = originalBasis - totalDepreciationTaken;
  const totalGain = estimatedSalePrice - adjustedBasis;
  const capitalGain = Math.max(0, estimatedSalePrice - originalBasis);
  const recaptureAmount = Math.min(totalDepreciationTaken, totalGain);

  // Recapture taxed at max 25% (§1250 unrecaptured gain)
  const recaptureTaxRate = 0.25;
  const recaptureTax = recaptureAmount * recaptureTaxRate;

  // Capital gains taxed at LTCG rate (assume 15%)
  const ltcgRate = holdingPeriodYears >= 1 ? 0.15 : marginalRate;
  const capitalGainsTax = capitalGain * ltcgRate;

  // State tax on total gain
  const stateTax = totalGain * stateRate;

  // Net benefit: tax savings from depreciation over the years vs. recapture
  const annualDepreciationSavings = (totalDepreciationTaken / holdingPeriodYears) * (marginalRate + stateRate);
  const totalDepreciationSavings = annualDepreciationSavings * holdingPeriodYears;
  // Time value of money — savings were received earlier
  const pvOfSavings = annualDepreciationSavings * ((Math.pow(1.05, holdingPeriodYears) - 1) / 0.05);

  return {
    originalBasis,
    totalDepreciationTaken,
    adjustedBasis,
    estimatedSalePrice,
    totalGain: Math.round(totalGain * 100) / 100,
    recapture: {
      amount: recaptureAmount,
      taxRate: recaptureTaxRate * 100,
      tax: Math.round(recaptureTax * 100) / 100
    },
    capitalGains: {
      amount: Math.round(capitalGain * 100) / 100,
      taxRate: ltcgRate * 100,
      tax: Math.round(capitalGainsTax * 100) / 100
    },
    stateTax: Math.round(stateTax * 100) / 100,
    totalTaxOnSale: Math.round((recaptureTax + capitalGainsTax + stateTax) * 100) / 100,
    netBenefit: {
      totalDepreciationSavingsOverHoldPeriod: Math.round(totalDepreciationSavings * 100) / 100,
      pvOfDepreciationSavings: Math.round(pvOfSavings * 100) / 100,
      recaptureTax: Math.round(recaptureTax * 100) / 100,
      netBenefit: Math.round((pvOfSavings - recaptureTax) * 100) / 100,
      verdict: pvOfSavings > recaptureTax
        ? `Net positive: Depreciation saved ~$${Math.round(pvOfSavings - recaptureTax).toLocaleString()} more than recapture costs (time-value adjusted)`
        : 'Recapture exceeds time-value of depreciation savings — unusual scenario'
    },
    avoidanceStrategies: [
      '1031 Exchange — defer all gain and recapture into replacement property',
      'Installment Sale (§453) — spread gain recognition over multiple years',
      'Die holding the property — heirs get stepped-up basis, eliminating recapture',
      'Convert to primary residence (2 of 5 years) — $250K/$500K exclusion on capital gains (recapture still applies)',
      'Opportunity Zone investment — reinvest gains for potential exclusion after 10 years'
    ]
  };
}


// ─── Comprehensive Benefits Summary ─────────────────────────────────────────

/**
 * Generate a full tax benefits summary combining all analyses
 */
export function generateBenefitsSummary(params) {
  const {
    scheduleE,
    depreciation,
    taxCalc,
    propertyValue = 0,
    originalPurchasePrice = 0,
    rentalHoursPerYear = 0,
    totalMiles = 0,
    taxYear = 2025
  } = params;

  const marginalRate = (taxCalc?.rates?.marginalFederal || 24) / 100;
  const stateRate = (taxCalc?.rates?.effectiveState || 5) / 100;
  const netRentalIncome = scheduleE?.summary?.netIncomeOrLoss || 0;
  const totalDepreciation = depreciation?.summary?.totalCurrentYearDepreciation || 0;

  // 1. Deduction savings
  const deductionSavings = calculateDeductionSavings(scheduleE, marginalRate, stateRate);

  // 2. QBI analysis
  const qbi = calculateQBIDeduction({
    netRentalIncome: Math.max(0, netRentalIncome),
    rentalHoursPerYear,
    filingStatus: taxCalc?.filingStatus || 'single',
    totalTaxableIncome: taxCalc?.taxableIncome || 0
  });
  if (qbi.eligible && qbi.deduction > 0) {
    qbi.details.taxSavings = Math.round(qbi.deduction * (marginalRate + stateRate) * 100) / 100;
  }

  // 3. Travel deduction
  const travel = calculateTravelDeduction({ taxYear, totalMiles });

  // 4. Cost seg (if property value known)
  let costSeg = null;
  if (propertyValue > 0) {
    costSeg = analyzeCostSegregation(propertyValue, 0.20, taxYear, marginalRate);
  }

  // Total annual tax benefits
  const benefitItems = [
    { name: 'Schedule E Deductions', amount: deductionSavings.totalSavings, type: 'savings' },
    { name: 'Depreciation', amount: Math.round(totalDepreciation * (marginalRate + stateRate) * 100) / 100, type: 'savings' },
    { name: 'QBI Deduction (§199A)', amount: qbi.details?.taxSavings || 0, type: 'savings' },
    { name: 'Travel / Mileage', amount: Math.round(travel.totalTravelDeduction * (marginalRate + stateRate) * 100) / 100, type: 'savings' }
  ].filter(b => b.amount > 0);

  const totalAnnualBenefit = benefitItems.reduce((sum, b) => sum + b.amount, 0);

  return {
    taxYear,
    totalAnnualTaxBenefit: Math.round(totalAnnualBenefit * 100) / 100,
    benefitItems,
    deductionSavings,
    qbi,
    travel,
    costSeg,
    marginalRate: Math.round(marginalRate * 100),
    stateRate: Math.round(stateRate * 100),
    combinedRate: Math.round((marginalRate + stateRate) * 100),
    monthlyTaxBenefit: Math.round(totalAnnualBenefit / 12 * 100) / 100,
    headline: totalAnnualBenefit > 0
      ? `Your rental properties save you ~$${Math.round(totalAnnualBenefit).toLocaleString()} per year in taxes`
      : 'Add property and expense data to calculate your tax benefits'
  };
}
