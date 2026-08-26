/**
 * Advanced Tax Calculator Module
 * TurboTax-style tax computation, deduction finder, and compliance checks
 */

import { getDb } from './connection.js';
import { getScheduleE, getTaxYearSummary, getDepreciationSchedule } from './tax-reports.js';
import { getTaxRulesetPackage } from '../../src/shared/taxRules.js';

// Self-employment tax rate (for active real estate professionals)
const SE_TAX_RATE = 0.153; // 15.3% (12.4% SS + 2.9% Medicare)
const SE_TAX_WAGE_BASE = 168600; // 2024 SS wage base

function getRulesetForYear(taxYear) {
  const ruleset = getTaxRulesetPackage(taxYear);
  if (ruleset.approvalStatus === 'unsupported') {
    throw new Error(`No approved tax ruleset is available for tax year ${taxYear}.`);
  }

  return ruleset;
}

/**
 * Calculate federal tax based on taxable income
 */
export function calculateFederalTax(taxableIncome, filingStatus = 'single', taxYear = 2025) {
  const ruleset = getRulesetForYear(taxYear);
  const bracketTable = ruleset.federalTaxBrackets || {};
  const brackets = bracketTable[filingStatus] || bracketTable.single || [];
  
  let tax = 0;
  let remainingIncome = taxableIncome;
  const breakdown = [];
  
  for (const bracket of brackets) {
    if (remainingIncome <= 0) break;
    
    const taxableInBracket = Math.min(remainingIncome, bracket.max - bracket.min);
    const taxInBracket = taxableInBracket * bracket.rate;
    
    if (taxableInBracket > 0) {
      breakdown.push({
        bracket: `${(bracket.rate * 100).toFixed(0)}%`,
        range: `$${bracket.min.toLocaleString()} - $${bracket.max === Infinity ? '∞' : bracket.max.toLocaleString()}`,
        taxableAmount: taxableInBracket,
        tax: taxInBracket
      });
    }
    
    tax += taxInBracket;
    remainingIncome -= taxableInBracket;
  }
  
  return {
    totalTax: tax,
    effectiveRate: taxableIncome > 0 ? (tax / taxableIncome * 100) : 0,
    marginalRate: brackets.find(b => taxableIncome <= b.max)?.rate * 100 || 37,
    breakdown
  };
}

/**
 * Calculate complete tax liability for rental property owner
 */
export function calculateTaxLiability(params) {
  const {
    taxYear,
    filingStatus = 'single',
    otherIncome = 0,        // W-2, 1099, etc.
    otherDeductions = 0,    // Itemized deductions beyond rental
    stateRate = 0.05,       // State income tax rate
    propertyId = null
  } = params;
  
  // Get rental income data
  const scheduleE = getScheduleE(taxYear, propertyId);
  const depreciation = getDepreciationSchedule(taxYear, propertyId);
  
  // Rental net income (can be negative = loss)
  const rentalNetIncome = scheduleE.summary.netIncomeOrLoss;
  
  // Check passive loss rules
  const passiveLossAnalysis = analyzePassiveLoss(rentalNetIncome, otherIncome, filingStatus);
  
  // Total income for tax purposes
  const grossIncome = otherIncome + passiveLossAnalysis.allowableRentalIncome;
  
  // Determine deduction method
  const ruleset = getRulesetForYear(taxYear);
  const standardDeduction = ruleset.standardDeduction?.[filingStatus] || ruleset.standardDeduction?.single || 0;
  const itemizedDeductions = otherDeductions; // User would add SALT, mortgage interest on primary home, etc.
  const useItemized = itemizedDeductions > standardDeduction;
  
  const totalDeductions = useItemized ? itemizedDeductions : standardDeduction;
  
  // Taxable income
  const taxableIncome = Math.max(0, grossIncome - totalDeductions);
  
  // Calculate federal tax
  const federalTax = calculateFederalTax(taxableIncome, filingStatus, taxYear);
  
  // Calculate state tax (simplified - most states use federal AGI as starting point)
  const stateTax = taxableIncome * stateRate;
  
  // NIIT - Net Investment Income Tax (3.8% for high earners)
  const niitThreshold = filingStatus === 'married_filing_jointly' ? 250000 : 200000;
  const niit = grossIncome > niitThreshold 
    ? Math.min(rentalNetIncome, grossIncome - niitThreshold) * 0.038 
    : 0;
  
  return {
    taxYear,
    filingStatus,
    income: {
      rental: rentalNetIncome,
      rentalAllowable: passiveLossAnalysis.allowableRentalIncome,
      carryforwardLoss: passiveLossAnalysis.carryforwardLoss,
      other: otherIncome,
      gross: grossIncome
    },
    deductions: {
      method: useItemized ? 'itemized' : 'standard',
      standardDeduction,
      itemizedDeductions,
      totalDeductions
    },
    taxableIncome,
    taxes: {
      federal: federalTax.totalTax,
      state: stateTax,
      niit,
      total: federalTax.totalTax + stateTax + niit
    },
    rates: {
      effectiveFederal: federalTax.effectiveRate,
      marginalFederal: federalTax.marginalRate,
      state: stateRate * 100,
      combined: taxableIncome > 0 
        ? ((federalTax.totalTax + stateTax + niit) / taxableIncome * 100) 
        : 0
    },
    passiveLoss: passiveLossAnalysis,
    depreciation: depreciation.summary,
    federalBreakdown: federalTax.breakdown
  };
}

/**
 * Analyze passive activity loss rules
 * Rental real estate is generally passive unless you're a real estate professional
 */
export function analyzePassiveLoss(rentalNetIncome, otherIncome, filingStatus) {
  // If rental income is positive, no passive loss rules apply
  if (rentalNetIncome >= 0) {
    return {
      hasLoss: false,
      allowableRentalIncome: rentalNetIncome,
      disallowedLoss: 0,
      carryforwardLoss: 0,
      reason: 'Rental activity generated income, no loss limitation applies'
    };
  }
  
  const loss = Math.abs(rentalNetIncome);
  const magi = otherIncome; // Modified AGI (simplified)
  
  // Active participation allowance: up to $25,000 for MAGI under $100,000
  // Phases out between $100,000 and $150,000
  let activeParticipationAllowance = 0;
  
  if (magi < 100000) {
    activeParticipationAllowance = 25000;
  } else if (magi < 150000) {
    // Phase out: lose $1 for every $2 over $100,000
    activeParticipationAllowance = Math.max(0, 25000 - (magi - 100000) * 0.5);
  }
  
  // For married filing separately who lived together, allowance is $0
  if (filingStatus === 'married_filing_separately') {
    activeParticipationAllowance = 0;
  }
  
  const allowableLoss = Math.min(loss, activeParticipationAllowance);
  const disallowedLoss = loss - allowableLoss;
  
  return {
    hasLoss: true,
    totalLoss: loss,
    allowableRentalIncome: -allowableLoss, // Negative because it's a loss
    allowableLoss,
    disallowedLoss,
    carryforwardLoss: disallowedLoss, // Carries forward to future years
    magiLimit: magi >= 150000,
    activeParticipationAllowance,
    reason: disallowedLoss > 0 
      ? `Passive loss limited to $${allowableLoss.toLocaleString()}. $${disallowedLoss.toLocaleString()} carries forward.`
      : `Full loss of $${loss.toLocaleString()} allowed under active participation rules.`
  };
}

/**
 * Find potentially missed deductions
 */
export function findMissedDeductions(taxYear, propertyId = null) {
  const db = getDb();
  const scheduleE = getScheduleE(taxYear, propertyId);
  const suggestions = [];
  
  // Check for common missed deductions
  const expenseChecks = [
    { line: 'ADVERTISING', threshold: 0, suggestion: 'Did you advertise your rental? Zillow, Apartments.com, Craigslist ads are deductible.' },
    { line: 'AUTO_TRAVEL', threshold: 0, suggestion: 'Track mileage to properties, hardware stores, tenant meetings. Standard rate: $0.67/mile for 2024.' },
    { line: 'LEGAL_PROFESSIONAL', threshold: 0, suggestion: 'CPA fees for tax prep, attorney fees for lease review, evictions are deductible.' },
    { line: 'INSURANCE', threshold: 0, suggestion: 'Landlord insurance, umbrella policy, flood insurance - all deductible.' },
    { line: 'DEPRECIATION', threshold: 0, suggestion: 'Residential rental property depreciates over 27.5 years. Add properties to track this.' }
  ];
  
  for (const check of expenseChecks) {
    const lineData = scheduleE.scheduleELines[check.line];
    if (lineData && lineData.amount <= check.threshold) {
      suggestions.push({
        category: lineData.name,
        currentAmount: lineData.amount,
        line: lineData.line,
        suggestion: check.suggestion,
        priority: lineData.amount === 0 ? 'high' : 'medium'
      });
    }
  }
  
  // Check for home office deduction (if applicable)
  suggestions.push({
    category: 'Home Office',
    currentAmount: 0,
    suggestion: 'If you manage properties from home, you may qualify for a home office deduction. Simplified method: $5/sq ft up to 300 sq ft = $1,500.',
    priority: 'medium'
  });
  
  // Check depreciation
  const depreciation = getDepreciationSchedule(taxYear, propertyId);
  if (depreciation.assets.length === 0) {
    suggestions.push({
      category: 'Property Depreciation',
      currentAmount: 0,
      suggestion: 'No properties set up for depreciation. This is typically the largest tax deduction for rental owners. Add your property purchase info to claim ~3.6% of building value annually.',
      priority: 'critical'
    });
  }
  
  // Safe Harbor for small landlords
  suggestions.push({
    category: 'Safe Harbor Deduction',
    currentAmount: 0,
    suggestion: 'If rental hours exceed 250/year, you may qualify for the 20% QBI deduction under Safe Harbor rules. Track your hours!',
    priority: 'medium'
  });
  
  return {
    taxYear,
    suggestions: suggestions.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }),
    potentialSavings: 'Could range from $500 to $5,000+ depending on tax bracket'
  };
}

/**
 * Tax calendar and important deadlines
 */
export function getTaxCalendar(taxYear) {
  const nextYear = taxYear + 1;
  
  const deadlines = [
    {
      date: `${taxYear}-01-15`,
      event: 'Q4 Estimated Tax Due',
      description: `Fourth quarter estimated tax payment for ${taxYear - 1}`,
      form: '1040-ES',
      status: new Date() > new Date(`${taxYear}-01-15`) ? 'past' : 'upcoming'
    },
    {
      date: `${taxYear}-01-31`,
      event: '1099 Forms Due',
      description: 'Send 1099-NEC to contractors paid $600+',
      form: '1099-NEC',
      status: new Date() > new Date(`${taxYear}-01-31`) ? 'past' : 'upcoming'
    },
    {
      date: `${taxYear}-04-15`,
      event: 'Tax Return Due / Q1 Estimated Due',
      description: `File ${taxYear - 1} return or extension. Q1 ${taxYear} estimated payment due.`,
      form: '1040 + Schedule E',
      status: new Date() > new Date(`${taxYear}-04-15`) ? 'past' : 'upcoming'
    },
    {
      date: `${taxYear}-06-15`,
      event: 'Q2 Estimated Tax Due',
      description: `Second quarter estimated tax payment for ${taxYear}`,
      form: '1040-ES',
      status: new Date() > new Date(`${taxYear}-06-15`) ? 'past' : 'upcoming'
    },
    {
      date: `${taxYear}-09-15`,
      event: 'Q3 Estimated Tax Due',
      description: `Third quarter estimated tax payment for ${taxYear}`,
      form: '1040-ES',
      status: new Date() > new Date(`${taxYear}-09-15`) ? 'past' : 'upcoming'
    },
    {
      date: `${taxYear}-10-15`,
      event: 'Extended Return Due',
      description: `Final deadline for ${taxYear - 1} returns with extension`,
      form: '1040',
      status: new Date() > new Date(`${taxYear}-10-15`) ? 'past' : 'upcoming'
    },
    {
      date: `${nextYear}-01-15`,
      event: 'Q4 Estimated Tax Due',
      description: `Fourth quarter estimated tax payment for ${taxYear}`,
      form: '1040-ES',
      status: new Date() > new Date(`${nextYear}-01-15`) ? 'past' : 'upcoming'
    }
  ];
  
  // Find next upcoming deadline
  const today = new Date();
  const nextDeadline = deadlines.find(d => new Date(d.date) > today);
  
  return {
    taxYear,
    deadlines,
    nextDeadline,
    daysUntilNextDeadline: nextDeadline 
      ? Math.ceil((new Date(nextDeadline.date) - today) / (1000 * 60 * 60 * 24))
      : null
  };
}

/**
 * Quarterly estimated tax payment tracker
 */
export function getEstimatedPaymentStatus(taxYear) {
  const db = getDb();
  
  // Create payments tracking table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS estimated_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tax_year INTEGER NOT NULL,
      quarter INTEGER NOT NULL,
      amount_due REAL NOT NULL,
      amount_paid REAL DEFAULT 0,
      paid_date DATE,
      confirmation_number VARCHAR(50),
      payment_method VARCHAR(50),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tax_year, quarter)
    )
  `);
  
  const quarters = [1, 2, 3, 4];
  const dueDates = {
    1: `${taxYear}-04-15`,
    2: `${taxYear}-06-15`,
    3: `${taxYear}-09-15`,
    4: `${taxYear + 1}-01-15`
  };
  
  const payments = [];
  
  for (const q of quarters) {
    const existing = db.prepare(`
      SELECT * FROM estimated_payments WHERE tax_year = ? AND quarter = ?
    `).get(taxYear, q);
    
    const today = new Date();
    const dueDate = new Date(dueDates[q]);
    
    let status = 'upcoming';
    if (existing?.amount_paid >= existing?.amount_due) {
      status = 'paid';
    } else if (today > dueDate) {
      status = 'overdue';
    } else if (today > new Date(dueDate.getTime() - 30 * 24 * 60 * 60 * 1000)) {
      status = 'due_soon';
    }
    
    payments.push({
      quarter: q,
      dueDate: dueDates[q],
      amountDue: existing?.amount_due || 0,
      amountPaid: existing?.amount_paid || 0,
      paidDate: existing?.paid_date,
      confirmationNumber: existing?.confirmation_number,
      status
    });
  }
  
  return {
    taxYear,
    payments,
    totalDue: payments.reduce((sum, p) => sum + p.amountDue, 0),
    totalPaid: payments.reduce((sum, p) => sum + p.amountPaid, 0)
  };
}

/**
 * Record an estimated tax payment
 */
export function recordEstimatedPayment(taxYear, quarter, amount, paidDate, confirmationNumber = null, paymentMethod = null) {
  const db = getDb();
  
  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS estimated_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tax_year INTEGER NOT NULL,
      quarter INTEGER NOT NULL,
      amount_due REAL NOT NULL,
      amount_paid REAL DEFAULT 0,
      paid_date DATE,
      confirmation_number VARCHAR(50),
      payment_method VARCHAR(50),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tax_year, quarter)
    )
  `);
  
  const existing = db.prepare(`
    SELECT * FROM estimated_payments WHERE tax_year = ? AND quarter = ?
  `).get(taxYear, quarter);
  
  if (existing) {
    db.prepare(`
      UPDATE estimated_payments 
      SET amount_paid = ?, paid_date = ?, confirmation_number = ?, payment_method = ?
      WHERE tax_year = ? AND quarter = ?
    `).run(amount, paidDate, confirmationNumber, paymentMethod, taxYear, quarter);
  } else {
    db.prepare(`
      INSERT INTO estimated_payments (tax_year, quarter, amount_due, amount_paid, paid_date, confirmation_number, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taxYear, quarter, amount, amount, paidDate, confirmationNumber, paymentMethod);
  }
  
  return { recorded: true, taxYear, quarter, amount };
}

/**
 * Real Estate Professional status analysis
 */
export function analyzeREProStatus(hoursData) {
  const {
    rentalHours = 0,           // Hours spent on rental activities
    otherWorkHours = 0,        // Hours at regular job
    materialParticipation = false
  } = hoursData;
  
  const qualifies = rentalHours > 750 && rentalHours > otherWorkHours / 2;
  
  return {
    qualifiesAsREPro: qualifies,
    rentalHours,
    otherWorkHours,
    hourRequirement: {
      met: rentalHours > 750,
      required: 750,
      actual: rentalHours
    },
    moreHalfRequirement: {
      met: rentalHours > otherWorkHours / 2,
      threshold: Math.floor(otherWorkHours / 2),
      actual: rentalHours
    },
    benefits: qualifies ? [
      'Rental losses are no longer passive - can offset W-2/other income',
      'No $25,000 passive loss limitation',
      'Depreciation not subject to passive rules'
    ] : [],
    recommendation: qualifies 
      ? 'You may qualify as a Real Estate Professional. Consult a CPA to document your hours.'
      : `You need ${750 - rentalHours} more rental hours or ${rentalHours * 2 - otherWorkHours} fewer work hours to qualify.`
  };
}
