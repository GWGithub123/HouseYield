import { calculateQuarterlyEstimate } from './tax-engine.js';

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeAsOfDate(asOfDate) {
  if (asOfDate instanceof Date) {
    return asOfDate;
  }

  if (typeof asOfDate === 'string' && asOfDate.trim()) {
    return new Date(`${asOfDate}T23:59:59`);
  }

  return new Date();
}

function getQuarterFromDate(asOfDate) {
  const normalized = normalizeAsOfDate(asOfDate);
  return Math.min(4, Math.max(1, Math.ceil((normalized.getMonth() + 1) / 3)));
}

export function determineEstimatedPaymentStatus({ asOfDate, taxYear, quarter, due, paid, dueDate }) {
  const asOf = normalizeAsOfDate(asOfDate);
  const quarterEndDates = {
    1: `${taxYear}-03-31`,
    2: `${taxYear}-06-30`,
    3: `${taxYear}-09-30`,
    4: `${taxYear}-12-31`,
  };
  const quarterEnd = new Date(`${quarterEndDates[quarter]}T23:59:59`);
  const dueAt = new Date(`${dueDate}T23:59:59`);
  const quarterHasEnded = asOf > quarterEnd;
  const isPastDue = asOf > dueAt;

  if (paid > 0 && paid >= due) {
    return 'paid';
  }

  if (paid > 0) {
    return 'partial';
  }

  if (due === 0 && !quarterHasEnded) {
    return 'upcoming';
  }

  if (due === 0 && quarterHasEnded) {
    return 'no_tax_due';
  }

  if (isPastDue) {
    return 'overdue';
  }

  return 'unpaid';
}

export function buildEstimatedTaxQuarterData({
  entries = [],
  payments = [],
  taxYear,
  taxParams = {},
  ruleset = null,
  asOfDate = new Date(),
} = {}) {
  const numericTaxYear = Number(taxYear);

  if (!Number.isInteger(numericTaxYear)) {
    throw new Error('taxYear must be an integer when building estimated tax quarter data');
  }

  const projectionQuarter = getQuarterFromDate(asOfDate);

  return [1, 2, 3, 4].map((quarter) => {
    const estimate = calculateQuarterlyEstimate(entries, numericTaxYear, quarter, {
      ...taxParams,
      projectionQuarter,
    }, ruleset);
    const paid = roundCurrency(
      payments
        .filter((payment) => Number(payment.quarter) === quarter)
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
    );
    const estimatedDue = roundCurrency(estimate.estimatedTax.total);

    return {
      quarter,
      estimatedDue,
      paid,
      remaining: roundCurrency(Math.max(0, estimatedDue - paid)),
      dueDate: estimate.dueDate,
      status: determineEstimatedPaymentStatus({
        asOfDate,
        taxYear: numericTaxYear,
        quarter,
        due: estimatedDue,
        paid,
        dueDate: estimate.dueDate,
      }),
      breakdown: {
        income: estimate.income,
        expenses: estimate.expenses,
        netIncome: estimate.netIncome,
        federal: estimate.estimatedTax.federal,
        state: estimate.estimatedTax.state,
        annualizedIncome: estimate.annualized.income,
        annualizedTaxable: estimate.annualized.taxableIncome,
        annualDepreciation: estimate.annualized.annualDepreciation,
        effectiveFederalRate: estimate.annualized.federalRate,
        effectiveStateRate: estimate.annualized.stateRate,
        period: estimate.period,
        formNumber: estimate.formNumber,
      },
      readiness: estimate.readiness,
      safeHarbor: estimate.safeHarbor,
    };
  });
}