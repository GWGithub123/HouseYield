import { getNoTaxStates, getStateRateSummary, STATE_TAX_RATES } from './stateTaxRates.js';

export const TAX_RULES_VERSION = '2026.1';
export const CURRENT_TAX_RULESET_TAX_YEAR = 2026;
export const CURRENT_TAX_RULESET_APPROVAL_STATUS = 'approved';
export const DEPRECIATION_RULES = {
  defaultLandValuePercent: 0.2,
  residentialRentalUsefulLifeMonths: 330,
  method: 'Straight-Line (GDS)',
  convention: 'Mid-Month'
};

const TAX_1099_RULES = {
  baseThreshold: 600,
  raisedThreshold: 2000,
  raisedThresholdEffectiveTaxYear: 2026,
  baseThresholdSummary: 'current $600',
  raisedThresholdSummary: 'OBBBA $2,000'
};

const HOUSEYIELD_TAX_RULES_LAST_REVIEWED_AT = '2026-06-08';
const HOUSEYIELD_STATE_RATE_DATA_LAST_REVIEWED_AT = '2026-06-08';
const IRS_FORM_1040_ES_PAGE_UPDATED_AT = '2026-04-15';
const IRS_FORM_8582_PAGE_UPDATED_AT = '2026-03-30';
const TAX_RULESET_STALE_AFTER_DAYS = 120;
const SOURCE_PAGE_STALE_AFTER_DAYS = 400;

export const SCHEDULE_E_LINE_MAP = {
  3: { key: 'RENTS_RECEIVED', name: 'Rents Received', type: 'income', categories: ['Rent Income', 'Rental Income', 'Late Fees', 'Security Deposit Forfeited', 'Lease Cancellation Fee', 'Tenant-Paid Expenses', 'Services in Lieu of Rent', 'Advance Rent', 'Other Rental Income', 'Other Income', 'Application Fees', 'Pet Fees'] },
  4: { key: 'OTHER_INCOME', name: 'Royalties Received', type: 'income', categories: ['Royalties', 'Royalty Income'] },
  5: { key: 'ADVERTISING', name: 'Advertising', type: 'expense', categories: ['Advertising'] },
  6: { key: 'AUTO_TRAVEL', name: 'Auto and Travel', type: 'expense', categories: ['Auto & Travel', 'Gas & Fuel', 'Parking & Tolls'] },
  7: { key: 'CLEANING_MAINTENANCE', name: 'Cleaning and Maintenance', type: 'expense', categories: ['Cleaning & Maintenance', 'Cleaning', 'Janitorial'] },
  8: { key: 'COMMISSIONS', name: 'Commissions', type: 'expense', categories: ['Commissions'] },
  9: { key: 'INSURANCE', name: 'Insurance', type: 'expense', categories: ['Insurance'] },
  10: { key: 'LEGAL_PROFESSIONAL', name: 'Legal and Other Professional Fees', type: 'expense', categories: ['Legal & Professional', 'Accounting & Bookkeeping', 'Legal Fees'] },
  11: { key: 'MANAGEMENT_FEES', name: 'Management Fees', type: 'expense', categories: ['Management Fees', 'Property Management', 'Software & Subscriptions'] },
  12: { key: 'MORTGAGE_INTEREST', name: 'Mortgage Interest Paid to Banks', type: 'expense', categories: ['Mortgage Interest'] },
  13: { key: 'OTHER_INTEREST', name: 'Other Interest', type: 'expense', categories: ['Other Interest', 'Bank Fees'] },
  14: { key: 'REPAIRS', name: 'Repairs', type: 'expense', categories: ['Repairs', 'Repairs & Maintenance', 'Plumbing', 'Electrical', 'HVAC', 'Appliance Repair', 'Roof Repair'] },
  15: { key: 'SUPPLIES', name: 'Supplies', type: 'expense', categories: ['Supplies', 'Office Supplies', 'Hardware & Tools'] },
  16: { key: 'TAXES', name: 'Taxes', type: 'expense', categories: ['Property Taxes', 'Property Tax'] },
  17: { key: 'UTILITIES', name: 'Utilities', type: 'expense', categories: ['Utilities', 'Electric', 'Natural Gas', 'Water & Sewer', 'Trash & Recycling', 'Internet & Cable'] },
  18: { key: 'DEPRECIATION', name: 'Depreciation Expense or Depletion', type: 'expense', categories: ['Depreciation', 'Depreciation Expense'] },
  19: { key: 'OTHER', name: 'Other', type: 'expense', categories: ['HOA Fees', 'Landscaping', 'Pest Control', 'Security', 'Tenant Screening', 'Other Expenses'] }
};

export const TAX_BRACKETS_2023 = {
  single: [
    { min: 0, max: 11000, rate: 0.10 },
    { min: 11000, max: 44725, rate: 0.12 },
    { min: 44725, max: 95375, rate: 0.22 },
    { min: 95375, max: 182100, rate: 0.24 },
    { min: 182100, max: 231250, rate: 0.32 },
    { min: 231250, max: 578125, rate: 0.35 },
    { min: 578125, max: Infinity, rate: 0.37 }
  ],
  married_filing_jointly: [
    { min: 0, max: 22000, rate: 0.10 },
    { min: 22000, max: 89450, rate: 0.12 },
    { min: 89450, max: 190750, rate: 0.22 },
    { min: 190750, max: 364200, rate: 0.24 },
    { min: 364200, max: 462500, rate: 0.32 },
    { min: 462500, max: 693750, rate: 0.35 },
    { min: 693750, max: Infinity, rate: 0.37 }
  ],
  married_filing_separately: [
    { min: 0, max: 11000, rate: 0.10 },
    { min: 11000, max: 44725, rate: 0.12 },
    { min: 44725, max: 95375, rate: 0.22 },
    { min: 95375, max: 182100, rate: 0.24 },
    { min: 182100, max: 231250, rate: 0.32 },
    { min: 231250, max: 346875, rate: 0.35 },
    { min: 346875, max: Infinity, rate: 0.37 }
  ],
  head_of_household: [
    { min: 0, max: 15700, rate: 0.10 },
    { min: 15700, max: 59850, rate: 0.12 },
    { min: 59850, max: 95350, rate: 0.22 },
    { min: 95350, max: 182100, rate: 0.24 },
    { min: 182100, max: 231250, rate: 0.32 },
    { min: 231250, max: 578100, rate: 0.35 },
    { min: 578100, max: Infinity, rate: 0.37 }
  ]
};

export const TAX_BRACKETS_2024 = {
  single: [
    { min: 0, max: 11600, rate: 0.10 },
    { min: 11600, max: 47150, rate: 0.12 },
    { min: 47150, max: 100525, rate: 0.22 },
    { min: 100525, max: 191950, rate: 0.24 },
    { min: 191950, max: 243725, rate: 0.32 },
    { min: 243725, max: 609350, rate: 0.35 },
    { min: 609350, max: Infinity, rate: 0.37 }
  ],
  married_filing_jointly: [
    { min: 0, max: 23200, rate: 0.10 },
    { min: 23200, max: 94300, rate: 0.12 },
    { min: 94300, max: 201050, rate: 0.22 },
    { min: 201050, max: 383900, rate: 0.24 },
    { min: 383900, max: 487450, rate: 0.32 },
    { min: 487450, max: 731200, rate: 0.35 },
    { min: 731200, max: Infinity, rate: 0.37 }
  ],
  married_filing_separately: [
    { min: 0, max: 11600, rate: 0.10 },
    { min: 11600, max: 47150, rate: 0.12 },
    { min: 47150, max: 100525, rate: 0.22 },
    { min: 100525, max: 191950, rate: 0.24 },
    { min: 191950, max: 243725, rate: 0.32 },
    { min: 243725, max: 365600, rate: 0.35 },
    { min: 365600, max: Infinity, rate: 0.37 }
  ],
  head_of_household: [
    { min: 0, max: 16550, rate: 0.10 },
    { min: 16550, max: 63100, rate: 0.12 },
    { min: 63100, max: 100500, rate: 0.22 },
    { min: 100500, max: 191950, rate: 0.24 },
    { min: 191950, max: 243700, rate: 0.32 },
    { min: 243700, max: 609350, rate: 0.35 },
    { min: 609350, max: Infinity, rate: 0.37 }
  ]
};

export const TAX_BRACKETS_2025 = {
  single: [
    { min: 0, max: 11925, rate: 0.10 },
    { min: 11925, max: 48475, rate: 0.12 },
    { min: 48475, max: 103350, rate: 0.22 },
    { min: 103350, max: 197300, rate: 0.24 },
    { min: 197300, max: 250525, rate: 0.32 },
    { min: 250525, max: 626350, rate: 0.35 },
    { min: 626350, max: Infinity, rate: 0.37 }
  ],
  married_filing_jointly: [
    { min: 0, max: 23850, rate: 0.10 },
    { min: 23850, max: 96950, rate: 0.12 },
    { min: 96950, max: 206700, rate: 0.22 },
    { min: 206700, max: 394600, rate: 0.24 },
    { min: 394600, max: 501050, rate: 0.32 },
    { min: 501050, max: 751600, rate: 0.35 },
    { min: 751600, max: Infinity, rate: 0.37 }
  ],
  married_filing_separately: [
    { min: 0, max: 11925, rate: 0.10 },
    { min: 11925, max: 48475, rate: 0.12 },
    { min: 48475, max: 103350, rate: 0.22 },
    { min: 103350, max: 197300, rate: 0.24 },
    { min: 197300, max: 250525, rate: 0.32 },
    { min: 250525, max: 375800, rate: 0.35 },
    { min: 375800, max: Infinity, rate: 0.37 }
  ],
  head_of_household: [
    { min: 0, max: 17000, rate: 0.10 },
    { min: 17000, max: 64850, rate: 0.12 },
    { min: 64850, max: 103350, rate: 0.22 },
    { min: 103350, max: 197300, rate: 0.24 },
    { min: 197300, max: 250500, rate: 0.32 },
    { min: 250500, max: 626350, rate: 0.35 },
    { min: 626350, max: Infinity, rate: 0.37 }
  ]
};

export const TAX_BRACKETS_2026 = {
  single: [
    { min: 0, max: 12400, rate: 0.10 },
    { min: 12400, max: 50400, rate: 0.12 },
    { min: 50400, max: 105700, rate: 0.22 },
    { min: 105700, max: 201775, rate: 0.24 },
    { min: 201775, max: 256225, rate: 0.32 },
    { min: 256225, max: 640600, rate: 0.35 },
    { min: 640600, max: Infinity, rate: 0.37 }
  ],
  married_filing_jointly: [
    { min: 0, max: 24800, rate: 0.10 },
    { min: 24800, max: 100800, rate: 0.12 },
    { min: 100800, max: 211400, rate: 0.22 },
    { min: 211400, max: 403550, rate: 0.24 },
    { min: 403550, max: 512450, rate: 0.32 },
    { min: 512450, max: 768700, rate: 0.35 },
    { min: 768700, max: Infinity, rate: 0.37 }
  ],
  married_filing_separately: [
    { min: 0, max: 12400, rate: 0.10 },
    { min: 12400, max: 50400, rate: 0.12 },
    { min: 50400, max: 105700, rate: 0.22 },
    { min: 105700, max: 201775, rate: 0.24 },
    { min: 201775, max: 256225, rate: 0.32 },
    { min: 256225, max: 384350, rate: 0.35 },
    { min: 384350, max: Infinity, rate: 0.37 }
  ],
  head_of_household: [
    { min: 0, max: 17700, rate: 0.10 },
    { min: 17700, max: 67450, rate: 0.12 },
    { min: 67450, max: 105700, rate: 0.22 },
    { min: 105700, max: 201750, rate: 0.24 },
    { min: 201750, max: 256200, rate: 0.32 },
    { min: 256200, max: 640600, rate: 0.35 },
    { min: 640600, max: Infinity, rate: 0.37 }
  ]
};

export const STANDARD_DEDUCTION_2023 = {
  single: 13850,
  married_filing_jointly: 27700,
  married_filing_separately: 13850,
  head_of_household: 20800
};

export const STANDARD_DEDUCTION_2024 = {
  single: 14600,
  married_filing_jointly: 29200,
  married_filing_separately: 14600,
  head_of_household: 21900
};

export const STANDARD_DEDUCTION_2025 = {
  single: 15750,
  married_filing_jointly: 31500,
  married_filing_separately: 15750,
  head_of_household: 23625
};

export const STANDARD_DEDUCTION_2026 = {
  single: 16100,
  married_filing_jointly: 32200,
  married_filing_separately: 16100,
  head_of_household: 24150
};

const TAX_YEAR_RULE_TABLE = {
  2023: {
    rulesVersion: '2023.1',
    approvalStatus: 'approved',
    brackets: TAX_BRACKETS_2023,
    standardDeduction: STANDARD_DEDUCTION_2023,
    lastReviewedAt: '2026-06-22',
    primaryAuthority: 'Rev. Proc. 2022-38 / 2023 IRS forms and instructions'
  },
  2024: {
    rulesVersion: '2024.1',
    approvalStatus: 'approved',
    brackets: TAX_BRACKETS_2024,
    standardDeduction: STANDARD_DEDUCTION_2024,
    lastReviewedAt: '2026-06-22',
    primaryAuthority: 'Rev. Proc. 2023-34 / 2024 IRS forms and instructions'
  },
  2025: {
    rulesVersion: '2025.1',
    approvalStatus: 'approved',
    brackets: TAX_BRACKETS_2025,
    standardDeduction: STANDARD_DEDUCTION_2025,
    lastReviewedAt: '2026-06-22',
    primaryAuthority: '2025 IRS brackets and OBBBA standard deduction updates'
  },
  2026: {
    rulesVersion: '2026.1',
    approvalStatus: 'approved',
    brackets: TAX_BRACKETS_2026,
    standardDeduction: STANDARD_DEDUCTION_2026,
    lastReviewedAt: '2026-06-22',
    primaryAuthority: 'Rev. Proc. 2025-32 / 2026 IRS inflation adjustments'
  }
};

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function getTaxDeadlineTemplates(taxYear) {
  const filingTaxYear = normalizeTaxYear(taxYear) - 1;
  const currentTaxYear = normalizeTaxYear(taxYear);

  return [
    {
      date: `${currentTaxYear}-01-15`,
      event: 'Q4 Estimated Tax Due',
      description: `Fourth quarter estimated payment for ${currentTaxYear - 1}`,
      form: '1040-ES',
      icon: '💰',
      actions: ['Record payment', 'Calculate estimate'],
      relatedTab: 'overview'
    },
    {
      date: `${currentTaxYear}-01-31`,
      event: '1099-NEC Filing Deadline',
      description: `E-file 1099-NEC forms for contractors paid ${formatTax1099Threshold(filingTaxYear)}+. Must furnish to recipients and file with the IRS by this date.`,
      form: '1099-NEC',
      icon: '📋',
      actions: ['Review 1099s', 'E-file via Tax1099', 'Send W-9 requests'],
      relatedTab: 'export'
    },
    {
      date: `${currentTaxYear}-04-15`,
      event: 'Tax Return Due + Q1 Estimated',
      description: `File ${currentTaxYear - 1} return (or extension). Q1 ${currentTaxYear} estimated payment due.`,
      form: '1040 + Schedule E',
      icon: '📅',
      actions: ['Download Schedule E PDF', 'Export TXF for TurboTax', 'Record Q1 payment'],
      relatedTab: 'export'
    },
    {
      date: `${currentTaxYear}-06-15`,
      event: 'Q2 Estimated Tax Due',
      description: `Second quarter estimated payment for ${currentTaxYear}`,
      form: '1040-ES',
      icon: '💰',
      actions: ['Record payment', 'Calculate estimate'],
      relatedTab: 'overview'
    },
    {
      date: `${currentTaxYear}-09-15`,
      event: 'Q3 Estimated Tax Due',
      description: `Third quarter estimated payment for ${currentTaxYear}`,
      form: '1040-ES',
      icon: '💰',
      actions: ['Record payment', 'Calculate estimate'],
      relatedTab: 'overview'
    },
    {
      date: `${currentTaxYear}-10-15`,
      event: 'Extended Return Deadline',
      description: `Final deadline for ${currentTaxYear - 1} returns with extension`,
      form: '1040',
      icon: '⚠️',
      actions: ['Download Schedule E PDF', 'Export CSV'],
      relatedTab: 'export'
    },
    {
      date: `${currentTaxYear + 1}-01-15`,
      event: 'Q4 Estimated Tax Due',
      description: `Fourth quarter estimated payment for ${currentTaxYear}`,
      form: '1040-ES',
      icon: '💰',
      actions: ['Record payment', 'Calculate estimate'],
      relatedTab: 'overview'
    }
  ];
}

export function getTaxDeadlineHolidayDates(year) {
  const normalizedYear = normalizeTaxYear(year);
  const holidays = [
    `${normalizedYear}-01-01`,
    `${normalizedYear}-04-16`,
    `${normalizedYear}-07-04`,
    `${normalizedYear}-11-11`,
    `${normalizedYear}-12-25`
  ];

  const mlk = new Date(Date.UTC(normalizedYear, 0, 1));
  mlk.setUTCDate(1 + ((8 - mlk.getUTCDay()) % 7) + 14);
  holidays.push(toIsoDate(mlk));

  const presidentsDay = new Date(Date.UTC(normalizedYear, 1, 1));
  presidentsDay.setUTCDate(1 + ((8 - presidentsDay.getUTCDay()) % 7) + 14);
  holidays.push(toIsoDate(presidentsDay));

  return holidays;
}

export function adjustTaxDeadlineToBusinessDay(dateStr) {
  const adjustedDate = new Date(`${dateStr}T12:00:00Z`);
  const holidays = getTaxDeadlineHolidayDates(adjustedDate.getUTCFullYear());

  function isNonBusinessDay(date) {
    const dayOfWeek = date.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return true;
    }

    const isoDate = toIsoDate(date);
    if (holidays.includes(isoDate)) {
      return true;
    }

    for (const holiday of holidays) {
      const holidayDate = new Date(`${holiday}T12:00:00Z`);
      if (holidayDate.getUTCDay() === 6) {
        const fridayObserved = new Date(holidayDate);
        fridayObserved.setUTCDate(fridayObserved.getUTCDate() - 1);
        if (isoDate === toIsoDate(fridayObserved)) {
          return true;
        }
      }

      if (holidayDate.getUTCDay() === 0) {
        const mondayObserved = new Date(holidayDate);
        mondayObserved.setUTCDate(mondayObserved.getUTCDate() + 1);
        if (isoDate === toIsoDate(mondayObserved)) {
          return true;
        }
      }
    }

    return false;
  }

  while (isNonBusinessDay(adjustedDate)) {
    adjustedDate.setUTCDate(adjustedDate.getUTCDate() + 1);
  }

  return toIsoDate(adjustedDate);
}

function normalizeTaxYear(taxYear) {
  const parsed = Number(taxYear);
  if (!Number.isFinite(parsed)) {
    return new Date().getFullYear();
  }

  return Math.trunc(parsed);
}

export function isSupportedTaxRulesYear(taxYear) {
  return Boolean(TAX_YEAR_RULE_TABLE[normalizeTaxYear(taxYear)]);
}

function getTaxYearRuleConfig(taxYear) {
  return TAX_YEAR_RULE_TABLE[normalizeTaxYear(taxYear)] || null;
}

function priorYearPdf(fileBase, taxYear) {
  return `https://www.irs.gov/pub/irs-prior/${fileBase}--${taxYear}.pdf`;
}

function currentPdf(fileBase) {
  return `https://www.irs.gov/pub/irs-pdf/${fileBase}.pdf`;
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function diffCalendarDays(from, to = new Date()) {
  const start = from instanceof Date ? from : parseIsoDate(from);
  const end = to instanceof Date ? to : parseIsoDate(to);

  if (!start || !end) {
    return null;
  }

  return Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

export function getTax1099ThresholdForTaxYear(taxYear) {
  const normalizedTaxYear = normalizeTaxYear(taxYear);
  return normalizedTaxYear >= TAX_1099_RULES.raisedThresholdEffectiveTaxYear
    ? TAX_1099_RULES.raisedThreshold
    : TAX_1099_RULES.baseThreshold;
}

export function formatTax1099Threshold(taxYear) {
  return `$${getTax1099ThresholdForTaxYear(taxYear).toLocaleString('en-US')}`;
}

export function getTax1099ThresholdSummary(taxYear) {
  return getTax1099ThresholdForTaxYear(taxYear) === TAX_1099_RULES.raisedThreshold
    ? TAX_1099_RULES.raisedThresholdSummary
    : TAX_1099_RULES.baseThresholdSummary;
}

export function getTaxRuleSourceDocuments(taxYear = CURRENT_TAX_RULESET_TAX_YEAR) {
  const normalizedTaxYear = normalizeTaxYear(taxYear);
  const config = getTaxYearRuleConfig(normalizedTaxYear);

  if (!config) {
    return [];
  }

  const yearPdf = (fileBase) => (
    normalizedTaxYear >= 2025 ? currentPdf(fileBase) : priorYearPdf(fileBase, normalizedTaxYear)
  );
  const scheduleEUrl = normalizedTaxYear === 2026
    ? 'https://www.irs.gov/pub/irs-dft/f1040se--dft.pdf'
    : yearPdf('i1040se');
  const scheduleETitle = normalizedTaxYear === 2026
    ? '2026 draft Schedule E (Form 1040), Supplemental Income and Loss'
    : `${normalizedTaxYear} Instructions for Schedule E (Form 1040)`;
  const inflationAuthority = normalizedTaxYear === 2026
    ? {
        id: 'irs-federal-tax-rates',
        authority: 'IRS',
        title: 'Internal Revenue Bulletin 2025-45, Revenue Procedure 2025-32',
        url: 'https://www.irs.gov/irb/2025-45_IRB',
        category: 'federal-brackets',
        applicableYear: normalizedTaxYear,
        publishedLabel: '2026 revenue procedure',
        pageUpdatedAt: '2025-10-09',
        lastReviewedAt: config.lastReviewedAt,
        scope: 'Federal income tax brackets, standard deduction inflation adjustments, and other annual tax parameters for tax year 2026.'
      }
    : {
        id: 'irs-federal-tax-rates',
        authority: 'IRS',
        title: `${normalizedTaxYear} Publication 17 / inflation-adjustment authority`,
        url: normalizedTaxYear === 2023
          ? priorYearPdf('p17', 2023)
          : normalizedTaxYear === 2024
            ? 'https://www.irs.gov/pub/irs-irbs/irb23-48.pdf'
            : 'https://www.irs.gov/filing/federal-income-tax-rates-and-brackets',
        category: 'federal-brackets',
        applicableYear: normalizedTaxYear,
        publishedLabel: `${normalizedTaxYear} federal rates and standard deduction`,
        pageUpdatedAt: normalizedTaxYear === 2025 ? '2026-07-04' : null,
        lastReviewedAt: config.lastReviewedAt,
        scope: 'Federal income tax brackets and standard deduction amounts for the selected tax year.'
      };

  return [
    inflationAuthority,
    {
      id: 'irs-schedule-e-instructions',
      authority: 'IRS',
      title: scheduleETitle,
      url: scheduleEUrl,
      category: 'federal-rental',
      applicableYear: normalizedTaxYear,
      publishedLabel: normalizedTaxYear === 2026 ? '2026 draft form' : `${normalizedTaxYear} instructions`,
      pageUpdatedAt: normalizedTaxYear === 2026 ? '2026-05-06' : null,
      lastReviewedAt: config.lastReviewedAt,
      scope: 'Rental income and expense reporting, passive-loss references, business-interest references, and Schedule E line treatment.'
    },
    {
      id: 'irs-publication-527',
      authority: 'IRS',
      title: normalizedTaxYear === 2026
        ? 'Publication 527 current revision status (final 2026 publication not yet cited)'
        : `Publication 527 (${normalizedTaxYear}), Residential Rental Property`,
      url: normalizedTaxYear === 2026
        ? 'https://www.irs.gov/publications/p527'
        : normalizedTaxYear === 2025
          ? currentPdf('p527')
          : priorYearPdf('p527', normalizedTaxYear),
      category: 'property',
      applicableYear: normalizedTaxYear,
      publishedLabel: normalizedTaxYear === 2026 ? 'current IRS publication status' : `${normalizedTaxYear} publication`,
      pageUpdatedAt: null,
      lastReviewedAt: config.lastReviewedAt,
      scope: 'Residential rental depreciation, basis allocation, repairs versus improvements, and rental-use rules.'
    },
    {
      id: 'irs-form-1040-es',
      authority: 'IRS',
      title: `${normalizedTaxYear} Form 1040-ES, Estimated Tax for Individuals`,
      url: normalizedTaxYear >= 2025 ? currentPdf('f1040es') : priorYearPdf('f1040es', normalizedTaxYear),
      category: 'estimated-tax',
      applicableYear: normalizedTaxYear,
      publishedLabel: `${normalizedTaxYear} form package`,
      pageUpdatedAt: normalizedTaxYear >= 2025 ? IRS_FORM_1040_ES_PAGE_UPDATED_AT : null,
      lastReviewedAt: config.lastReviewedAt,
      scope: 'Quarterly estimated-tax due dates, withholding interaction, safe-harbor framing, and current form revision links.'
    },
    {
      id: 'irs-publication-1099',
      authority: 'IRS',
      title: normalizedTaxYear === 2026
        ? 'Publication 1099 (2026), General Instructions for Certain Information Returns'
        : `${normalizedTaxYear} General Instructions for Certain Information Returns`,
      url: normalizedTaxYear >= 2026
        ? 'https://www.irs.gov/publications/p1099'
        : priorYearPdf('i1099gi', normalizedTaxYear),
      category: 'information-reporting',
      applicableYear: normalizedTaxYear,
      publishedLabel: normalizedTaxYear === 2026 ? '2026 Publication 1099' : `${normalizedTaxYear} information-return instructions`,
      pageUpdatedAt: normalizedTaxYear === 2026 ? '2026-06-11' : null,
      lastReviewedAt: config.lastReviewedAt,
      scope: 'Annual information-return thresholds for Forms 1099-NEC and 1099-MISC, including statutory threshold changes and inflation-indexed reporting requirements.'
    },
    {
      id: 'irs-form-8582',
      authority: 'IRS',
      title: normalizedTaxYear === 2026
        ? 'Form 8582 instruction current revision status (final 2026 instruction not yet cited)'
        : `Instructions for Form 8582 (${normalizedTaxYear})`,
      url: normalizedTaxYear === 2026
        ? 'https://www.irs.gov/forms-pubs/about-form-8582'
        : normalizedTaxYear === 2025
          ? currentPdf('i8582')
          : priorYearPdf('i8582', normalizedTaxYear),
      category: 'passive-loss',
      applicableYear: normalizedTaxYear,
      publishedLabel: normalizedTaxYear === 2026 ? 'current IRS instruction status' : `${normalizedTaxYear} instructions`,
      pageUpdatedAt: normalizedTaxYear >= 2025 ? IRS_FORM_8582_PAGE_UPDATED_AT : null,
      lastReviewedAt: config.lastReviewedAt,
      scope: 'Passive activity loss limits, special rental-real-estate allowance, prior-year PAL carryforwards, and activity-level allocations.'
    },
    {
      id: 'irs-form-8995',
      authority: 'IRS',
      title: normalizedTaxYear === 2026
        ? 'Form 8995 instruction current revision status (final 2026 instruction not yet cited)'
        : `Instructions for Form 8995 (${normalizedTaxYear})`,
      url: normalizedTaxYear === 2026
        ? 'https://www.irs.gov/forms-pubs/about-form-8995'
        : normalizedTaxYear === 2025
          ? currentPdf('i8995')
          : priorYearPdf('i8995', normalizedTaxYear),
      category: 'qbi',
      applicableYear: normalizedTaxYear,
      publishedLabel: normalizedTaxYear === 2026 ? 'current IRS instruction status' : `${normalizedTaxYear} instructions`,
      pageUpdatedAt: null,
      lastReviewedAt: config.lastReviewedAt,
      scope: 'Qualified business income deduction thresholds and simplified computation rules.'
    },
    {
      id: 'irs-form-8995a',
      authority: 'IRS',
      title: normalizedTaxYear === 2026
        ? 'Form 8995-A instruction current revision status (final 2026 instruction not yet cited)'
        : `Instructions for Form 8995-A (${normalizedTaxYear})`,
      url: normalizedTaxYear === 2026
        ? 'https://www.irs.gov/forms-pubs/about-form-8995-a'
        : normalizedTaxYear === 2025
          ? currentPdf('i8995a')
          : priorYearPdf('i8995a', normalizedTaxYear),
      category: 'qbi',
      applicableYear: normalizedTaxYear,
      publishedLabel: normalizedTaxYear === 2026 ? 'current IRS instruction status' : `${normalizedTaxYear} instructions`,
      pageUpdatedAt: null,
      lastReviewedAt: config.lastReviewedAt,
      scope: 'QBI wage and UBIA limitations, aggregation, and carryforward rules for higher-income taxpayers.'
    },
    {
      id: 'houseyield-state-rate-table',
      authority: 'HouseYield',
      title: 'HouseYield state income tax rate table',
      url: null,
      category: 'state',
      applicableYear: normalizedTaxYear,
      publishedLabel: 'curated state-rate reference',
      pageUpdatedAt: HOUSEYIELD_STATE_RATE_DATA_LAST_REVIEWED_AT,
      lastReviewedAt: HOUSEYIELD_STATE_RATE_DATA_LAST_REVIEWED_AT,
      scope: 'Top-rate and bracket reference only; resident credits, local taxes, and conformity overlays are not encoded here.'
    }
  ];
}

export function getTaxRulesGovernanceStatus(taxYear = CURRENT_TAX_RULESET_TAX_YEAR, asOfDate = new Date()) {
  const requestedTaxYear = normalizeTaxYear(taxYear);
  const config = getTaxYearRuleConfig(requestedTaxYear);
  const supportedTaxYear = config ? requestedTaxYear : null;
  const sourceDocuments = getTaxRuleSourceDocuments(requestedTaxYear);
  const lastReviewedAt = config?.lastReviewedAt || null;
  const rulesReviewAgeDays = lastReviewedAt ? diffCalendarDays(lastReviewedAt, asOfDate) : null;
  const staleSourcePages = sourceDocuments
    .filter((document) => document.pageUpdatedAt)
    .map((document) => ({
      id: document.id,
      title: document.title,
      ageDays: diffCalendarDays(document.pageUpdatedAt, asOfDate)
    }))
    .filter((document) => Number.isFinite(document.ageDays) && document.ageDays > SOURCE_PAGE_STALE_AFTER_DAYS);

  let coverageStatus = config ? 'supported' : 'unsupported';

  const warnings = [];
  if (coverageStatus === 'unsupported') {
    warnings.push(
      `No approved HouseYield rules package is available for tax year ${requestedTaxYear}; filing outputs must remain blocked until a year-specific ruleset is ingested, validated, and activated.`
    );
  }

  if (CURRENT_TAX_RULESET_APPROVAL_STATUS !== 'approved') {
    warnings.push('The active rules package is not marked approved, so filing outputs should remain review-only.');
  }

  if (Number.isFinite(rulesReviewAgeDays) && rulesReviewAgeDays > TAX_RULESET_STALE_AFTER_DAYS) {
    warnings.push(
      `HouseYield tax rules were last reviewed ${rulesReviewAgeDays} days ago, which is beyond the freshness target of ${TAX_RULESET_STALE_AFTER_DAYS} days.`
    );
  }

  if (staleSourcePages.length > 0) {
    warnings.push(
      `${staleSourcePages.length} cited source page${staleSourcePages.length === 1 ? ' is' : 's are'} older than ${SOURCE_PAGE_STALE_AFTER_DAYS} days and should be revalidated.`
    );
  }

  return {
    requestedTaxYear,
    supportedTaxYear,
    rulesVersion: config?.rulesVersion || null,
    approvalStatus: config?.approvalStatus || 'unsupported',
    coverageStatus,
    isRequestedTaxYearFullySupported: coverageStatus === 'supported',
    lastReviewedAt,
    rulesReviewAgeDays,
    freshnessStatus: warnings.length === 0 ? 'current' : (
      warnings.some((warning) => warning.includes('No approved HouseYield rules package'))
        ? 'unsupported'
        : warnings.some((warning) => warning.includes('beyond the freshness target'))
          ? 'stale'
          : 'attention_needed'
    ),
    staleAfterDays: TAX_RULESET_STALE_AFTER_DAYS,
    sourceDocumentCount: sourceDocuments.length,
    staleSourcePageCount: staleSourcePages.length,
    staleSourcePages,
    warnings,
  };
}

export function getTaxRulesetPackage(taxYear = CURRENT_TAX_RULESET_TAX_YEAR) {
  const config = getTaxYearRuleConfig(taxYear);
  if (!config) {
    const normalizedTaxYear = normalizeTaxYear(taxYear);
    const governance = getTaxRulesGovernanceStatus(normalizedTaxYear);
    return {
      taxYear: normalizedTaxYear,
      referenceTaxYear: null,
      rulesVersion: null,
      approvalStatus: 'unsupported',
      sourceCitations: [],
      sourceDocuments: [],
      lastReviewedAt: null,
      governance,
      scopeSummary: `No approved HouseYield rules package exists for tax year ${normalizedTaxYear}.`,
      estimatedTaxMethodology: null,
      stateTaxMethodology: null,
      scheduleELineMap: null,
      federalTaxBrackets: null,
      standardDeduction: null,
      depreciation: null,
      deadlineTemplates: [],
      deadlineHolidayDates: [],
      stateTaxRates: null,
      noIncomeTaxStates: [],
      stateRateSummary: null,
      tax1099: null,
    };
  }
  const sourceDocuments = getTaxRuleSourceDocuments(taxYear);
  const governance = getTaxRulesGovernanceStatus(taxYear);
  return {
    taxYear: normalizeTaxYear(taxYear),
    referenceTaxYear: normalizeTaxYear(taxYear),
    rulesVersion: config.rulesVersion,
    approvalStatus: config.approvalStatus,
    sourceCitations: sourceDocuments.map((document) => document.title),
    sourceDocuments,
    lastReviewedAt: config.lastReviewedAt,
    governance,
    scopeSummary: 'Federal rental-income reporting, depreciation, estimated-tax timing, 1099 thresholds, and baseline state-rate lookups.',
    sourceAuditRequirements: [
      {
        id: 'federal-brackets',
        label: 'Federal income tax brackets',
        sourceDocumentIds: ['irs-federal-tax-rates'],
        auditType: 'numeric_amount_presence',
        requiredForActivation: true
      },
      {
        id: 'standard-deduction',
        label: 'Standard deduction',
        sourceDocumentIds: ['irs-federal-tax-rates'],
        auditType: 'numeric_amount_presence',
        requiredForActivation: true
      },
      {
        id: '1099-nec-threshold',
        label: '1099-NEC / 1099-MISC reporting threshold',
        sourceDocumentIds: ['irs-publication-1099'],
        auditType: 'numeric_extract_or_match',
        requiredForActivation: true
      },
      {
        id: 'schedule-e-line-map',
        label: 'Schedule E line mappings',
        sourceDocumentIds: ['irs-schedule-e-instructions'],
        auditType: 'source_presence',
        requiredForActivation: true
      },
      {
        id: 'estimated-tax',
        label: '1040-ES estimated-tax timing and safe harbor',
        sourceDocumentIds: ['irs-form-1040-es'],
        auditType: 'source_presence',
        requiredForActivation: true
      },
      {
        id: 'depreciation',
        label: 'Rental property depreciation assumptions',
        sourceDocumentIds: ['irs-publication-527'],
        auditType: 'source_presence',
        requiredForActivation: true
      }
    ],
    estimatedTaxMethodology: 'Current implementation annualizes current-year rental activity, can layer annual depreciation into the estimate, models the 90% current-year safe harbor, and compares against the 100% or 110% prior-year safe harbor when prior-year total tax and AGI are supplied. Without prior-year inputs, quarterly output remains a current-year projection only.',
    stateTaxMethodology: 'Current implementation uses home-state or baseline state-rate lookups as a planning layer and does not embed resident-credit, conformity, or local-tax adjustments.',
    scheduleELineMap: SCHEDULE_E_LINE_MAP,
    federalTaxBrackets: config.brackets,
    standardDeduction: config.standardDeduction,
    depreciation: DEPRECIATION_RULES,
    deadlineTemplates: getTaxDeadlineTemplates(taxYear),
    deadlineHolidayDates: getTaxDeadlineHolidayDates(taxYear),
    stateTaxRates: STATE_TAX_RATES,
    noIncomeTaxStates: getNoTaxStates(),
    stateRateSummary: getStateRateSummary(),
    tax1099: {
      ...TAX_1099_RULES,
      activeThreshold: getTax1099ThresholdForTaxYear(taxYear),
      activeThresholdSummary: getTax1099ThresholdSummary(taxYear)
    }
  };
}