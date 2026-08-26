import React, { useMemo, useState } from 'react';
import SidebarLiquidGlassShell from '../SidebarLiquidGlassShell';
import {
  AdditionalAnalyticsChartsGrid,
  type AvmGranularity,
  type MetricTimeframe,
  type ProjectionGranularity,
  type PropertyAnalyticsChartData,
  type PropertyAnalyticsMetricKey,
  type TaxHistoryRange,
} from './PropertyAnalyticsGraphs';
import type { PropertyDashboard } from '../../types/attom';

export type PropertyAnalyticsSurfaceFinancialInputs = {
  avm: number;
  taxAmount: number;
  originalLoanAmount?: number;
  currentLoanBalance?: number;
  remainingLoanTermMonths?: number;
  monthlyDebtService?: number;
  monthlyRent: number;
  otherIncome: number;
  vacancyRate: number;
  rentGrowth: number;
  insurance: number;
  utilities: number;
  hoa: number;
  repairsCapEx: number;
  managementPct: number;
  expenseInflation: number;
  taxGrowth: number;
  interestRate: number;
  loanTerm: number;
  isInterestOnly: boolean;
  downPayment: number;
  closingCosts: number;
  initialRehab: number;
  appreciationRate?: number;
};

type AnalyticsSurfaceFinancialInputs = PropertyAnalyticsSurfaceFinancialInputs;

export type PropertyAnalyticsMiniPoint = {
  x: number;
  y: number;
};

type MiniPoint = PropertyAnalyticsMiniPoint;

export type PropertyAnalyticsTaxHistorySeries = {
  values: number[];
  labels: string[];
};

type TaxHistorySeries = PropertyAnalyticsTaxHistorySeries;

type PropertyAnalyticsMetricSurfaceProps = {
  metric: PropertyAnalyticsMetricKey;
  propertyDashboard?: PropertyDashboard | null;
  financialInputs: AnalyticsSurfaceFinancialInputs | null;
  scopeLabel?: string;
  showScopeHeader?: boolean;
  dashboardCardMode?: boolean;
};

const PROJECTION_PERIODS_PER_YEAR: Record<ProjectionGranularity, number> = {
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_RUN_RENT_GROWTH_CAP = 2.75;
const LONG_RUN_APPRECIATION_CAP = 2.25;
const GROWTH_FADE_START_YEAR = 3;
const GROWTH_FADE_END_YEAR = 12;

function getProjectionPeriodsPerYear(granularity: ProjectionGranularity) {
  return PROJECTION_PERIODS_PER_YEAR[granularity];
}

function buildProjectionLabels(totalPeriods: number, granularity: ProjectionGranularity, startYear: number = new Date().getFullYear()) {
  if (granularity === 'annual') {
    return Array.from({ length: totalPeriods }, (_, index) => `${startYear + index}`);
  }

  if (granularity === 'quarterly') {
    return Array.from({ length: totalPeriods }, (_, index) => {
      const quarter = (index % 4) + 1;
      const year = startYear + Math.floor(index / 4);
      return `Q${quarter} ${year}`;
    });
  }

  return Array.from({ length: totalPeriods }, (_, index) => {
    const monthIndex = index % 12;
    const year = startYear + Math.floor(index / 12);
    return `${MONTH_LABELS[monthIndex]} ${year}`;
  });
}

/** Expand annual series into monthly/quarterly periods.
 *  - `flow`: dollar amounts for the period (annual ÷ periodsPerYear)
 *  - `level`: rates, ratios, and stock levels (no divide) */
function interpolateSeries(
  values: number[],
  granularity: ProjectionGranularity,
  mode: 'flow' | 'level' = 'level',
) {
  if (granularity === 'annual' || values.length <= 1) return values.slice();

  const periodsPerYear = getProjectionPeriodsPerYear(granularity);
  const periodScale = mode === 'flow' ? 1 / periodsPerYear : 1;
  const expanded: number[] = [];

  for (let yearIndex = 0; yearIndex < values.length; yearIndex += 1) {
    const currentValue = values[yearIndex];
    const nextValue = values[Math.min(yearIndex + 1, values.length - 1)];

    for (let periodIndex = 0; periodIndex < periodsPerYear; periodIndex += 1) {
      if (yearIndex === values.length - 1) {
        expanded.push(currentValue * periodScale);
        continue;
      }

      const ratio = periodIndex / periodsPerYear;
      const interpolated = currentValue + ((nextValue - currentValue) * ratio);
      expanded.push(interpolated * periodScale);
    }
  }

  return expanded;
}

export function buildTaxHistorySeries(history: Array<{ year?: number | string; tax_amount?: number | string }> | undefined, range: TaxHistoryRange): TaxHistorySeries {
  if (!history?.length) return { values: [], labels: [] };

  const sorted = [...history]
    .filter((entry) => entry && entry.year != null)
    .sort((left, right) => Number(left.year) - Number(right.year));

  if (!sorted.length) return { values: [], labels: [] };

  let filtered = sorted;
  if (range !== 'all') {
    const years = parseInt(range.replace('Y', ''), 10);
    filtered = sorted.slice(-years);
    if (filtered.length < 2 && sorted.length >= 2) filtered = sorted.slice(-2);
  }

  return {
    values: filtered.map((entry) => (Number(entry.tax_amount) || 0) / 1000),
    labels: filtered.map((entry) => String(entry.year)),
  };
}

function getLoanProjectionBasis(inputs: AnalyticsSurfaceFinancialInputs) {
  return {
    principal: inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0),
    termMonths: inputs.remainingLoanTermMonths ?? inputs.loanTerm,
  };
}

function getAnnualDebtService(inputs: AnalyticsSurfaceFinancialInputs) {
  if (inputs.monthlyDebtService != null && inputs.monthlyDebtService > 0) {
    return inputs.monthlyDebtService * 12;
  }

  if (inputs.interestRate <= 0) return 0;

  const { principal, termMonths } = getLoanProjectionBasis(inputs);
  const monthlyRate = inputs.interestRate / 100 / 12;
  if (principal <= 0 || termMonths <= 0) return 0;

  if (inputs.isInterestOnly) {
    return 12 * monthlyRate * principal;
  }

  const monthlyPayment = (monthlyRate * principal) / (1 - Math.pow(1 + monthlyRate, -termMonths));
  return 12 * monthlyPayment;
}

function getCurrentEquityBasis(inputs: AnalyticsSurfaceFinancialInputs) {
  const { principal } = getLoanProjectionBasis(inputs);
  return Math.max(inputs.avm - principal, 0);
}

function getForwardReturnCapitalBasis(inputs: AnalyticsSurfaceFinancialInputs) {
  const currentEquity = getCurrentEquityBasis(inputs);
  const currentNetSaleProceeds = Math.max(currentEquity - (inputs.avm * 0.06), 0);

  if (currentNetSaleProceeds > 0 && (inputs.currentLoanBalance != null || inputs.originalLoanAmount != null)) {
    return currentNetSaleProceeds;
  }

  return inputs.downPayment + inputs.closingCosts + inputs.initialRehab;
}

function getFadedAnnualGrowthRate(initialRatePercent: number, yearIndex: number, steadyStateCapPercent: number) {
  const steadyStateRate = Math.min(initialRatePercent, steadyStateCapPercent);

  if (yearIndex < GROWTH_FADE_START_YEAR) {
    return initialRatePercent;
  }

  if (yearIndex >= GROWTH_FADE_END_YEAR) {
    return steadyStateRate;
  }

  const ratio = (yearIndex - GROWTH_FADE_START_YEAR) / Math.max(GROWTH_FADE_END_YEAR - GROWTH_FADE_START_YEAR, 1);
  return initialRatePercent + ((steadyStateRate - initialRatePercent) * ratio);
}

function buildGrowthFactor(initialRatePercent: number, yearsElapsed: number, steadyStateCapPercent: number) {
  let factor = 1;

  for (let yearIndex = 0; yearIndex < yearsElapsed; yearIndex += 1) {
    factor *= 1 + (getFadedAnnualGrowthRate(initialRatePercent, yearIndex, steadyStateCapPercent) / 100);
  }

  return factor;
}

function getRentGrowthFactor(inputs: AnalyticsSurfaceFinancialInputs, yearsElapsed: number) {
  return buildGrowthFactor(inputs.rentGrowth, yearsElapsed, LONG_RUN_RENT_GROWTH_CAP);
}

function getAppreciationGrowthFactor(inputs: AnalyticsSurfaceFinancialInputs, yearsElapsed: number) {
  return buildGrowthFactor(inputs.appreciationRate ?? 3, yearsElapsed, LONG_RUN_APPRECIATION_CAP);
}

function calculateCashFlow(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30) {
  const results: number[] = [];

  for (let year = 0; year < years; year += 1) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, year);
    const rent = inputs.monthlyRent * rentGrowthFactor;
    const otherIncome = inputs.otherIncome * rentGrowthFactor;
    const effectiveGrossIncome = 12 * (rent + otherIncome) * (1 - inputs.vacancyRate / 100);

    const expenseInflation = inputs.expenseInflation / 100;
    const insurance = inputs.insurance * Math.pow(1 + expenseInflation, year);
    const utilities = inputs.utilities * Math.pow(1 + expenseInflation, year);
    const hoa = inputs.hoa * Math.pow(1 + expenseInflation, year);
    const repairs = inputs.repairsCapEx * Math.pow(1 + expenseInflation, year);
    const taxes = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, year);
    const management = (inputs.managementPct / 100) * effectiveGrossIncome;
    const operatingExpenses = taxes + insurance + utilities + hoa + repairs + management;
    const noi = effectiveGrossIncome - operatingExpenses;

    let debtService = 0;
    if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal, termMonths } = getLoanProjectionBasis(inputs);
      const monthlyRate = inputs.interestRate / 100 / 12;
      const monthlyPayment = (monthlyRate * principal) / (1 - Math.pow(1 + monthlyRate, -termMonths));
      debtService = 12 * monthlyPayment;
    } else if (inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal } = getLoanProjectionBasis(inputs);
      const monthlyRate = inputs.interestRate / 100 / 12;
      debtService = 12 * monthlyRate * principal;
    }

    results.push((noi - debtService) / 1000);
  }

  return results;
}

function calculateIncomeExpenses(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30) {
  const income: number[] = [];
  const expenses: number[] = [];
  const expenseBreakdown = {
    taxes: [] as number[],
    insurance: [] as number[],
    utilities: [] as number[],
    hoa: [] as number[],
    repairs: [] as number[],
    management: [] as number[],
    debtService: [] as number[],
  };

  for (let year = 0; year < years; year += 1) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, year);
    const rent = inputs.monthlyRent * rentGrowthFactor;
    const otherIncome = inputs.otherIncome * rentGrowthFactor;
    const effectiveGrossIncome = 12 * (rent + otherIncome) * (1 - inputs.vacancyRate / 100);

    const expenseInflation = inputs.expenseInflation / 100;
    const insurance = inputs.insurance * Math.pow(1 + expenseInflation, year);
    const utilities = inputs.utilities * Math.pow(1 + expenseInflation, year);
    const hoa = inputs.hoa * Math.pow(1 + expenseInflation, year);
    const repairs = inputs.repairsCapEx * Math.pow(1 + expenseInflation, year);
    const taxes = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, year);
    const management = (inputs.managementPct / 100) * effectiveGrossIncome;
    let debtService = 0;

    if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal, termMonths } = getLoanProjectionBasis(inputs);
      const monthlyRate = inputs.interestRate / 100 / 12;
      const monthlyPayment = (monthlyRate * principal) / (1 - Math.pow(1 + monthlyRate, -termMonths));
      debtService = 12 * monthlyPayment;
    } else if (inputs.isInterestOnly && inputs.interestRate > 0) {
      const { principal } = getLoanProjectionBasis(inputs);
      const monthlyRate = inputs.interestRate / 100 / 12;
      debtService = 12 * monthlyRate * principal;
    }

    income.push(effectiveGrossIncome / 1000);
    expenses.push((taxes + insurance + utilities + hoa + repairs + management + debtService) / 1000);
    expenseBreakdown.taxes.push(taxes / 1000);
    expenseBreakdown.insurance.push(insurance / 1000);
    expenseBreakdown.utilities.push(utilities / 1000);
    expenseBreakdown.hoa.push(hoa / 1000);
    expenseBreakdown.repairs.push(repairs / 1000);
    expenseBreakdown.management.push(management / 1000);
    expenseBreakdown.debtService.push(debtService / 1000);
  }

  return { income, expenses, expenseBreakdown };
}

function calculateCoCReturn(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30) {
  const cashFlows = calculateCashFlow(inputs, years);
  const initialCashIn = inputs.downPayment + inputs.closingCosts + inputs.initialRehab;

  return cashFlows.map((cashFlow) => (initialCashIn > 0 ? ((cashFlow * 1000) / initialCashIn) * 100 : 0));
}

function calculateNOI(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30) {
  const results: number[] = [];

  for (let year = 0; year < years; year += 1) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, year);
    const rent = inputs.monthlyRent * rentGrowthFactor;
    const otherIncome = inputs.otherIncome * rentGrowthFactor;
    const effectiveGrossIncome = 12 * (rent + otherIncome) * (1 - inputs.vacancyRate / 100);

    const expenseInflation = inputs.expenseInflation / 100;
    const insurance = inputs.insurance * Math.pow(1 + expenseInflation, year);
    const utilities = inputs.utilities * Math.pow(1 + expenseInflation, year);
    const hoa = inputs.hoa * Math.pow(1 + expenseInflation, year);
    const repairs = inputs.repairsCapEx * Math.pow(1 + expenseInflation, year);
    const taxes = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, year);
    const management = (inputs.managementPct / 100) * effectiveGrossIncome;

    results.push((effectiveGrossIncome - taxes - insurance - utilities - hoa - repairs - management) / 1000);
  }

  return results;
}

function calculateAnnualIncome(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30) {
  const gross: number[] = [];
  const collected: number[] = [];

  for (let year = 0; year < years; year += 1) {
    const rentGrowthFactor = getRentGrowthFactor(inputs, year);
    const rent = inputs.monthlyRent * rentGrowthFactor;
    const otherIncome = inputs.otherIncome * rentGrowthFactor;
    const grossIncome = 12 * (rent + otherIncome);
    const collectedIncome = grossIncome * (1 - inputs.vacancyRate / 100);

    gross.push(grossIncome / 1000);
    collected.push(collectedIncome / 1000);
  }

  return { gross, collected };
}

function calculateMortgageAmortization(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30, periodsPerYear: number = 1) {
  const principal: number[] = [];
  const interest: number[] = [];
  const loanBalance: number[] = [];
  const { principal: startingBalance, termMonths } = getLoanProjectionBasis(inputs);
  const monthlyRate = inputs.interestRate / 100 / 12;
  const monthsPerPeriod = Math.max(1, Math.round(12 / periodsPerYear));
  const totalPeriods = years * periodsPerYear;

  if (startingBalance <= 0 || inputs.interestRate === 0) {
    for (let index = 0; index < totalPeriods; index += 1) {
      principal.push(0);
      interest.push(0);
      loanBalance.push(startingBalance / 1000);
    }
    return { principal, interest, loanBalance };
  }

  if (inputs.isInterestOnly) {
    const periodInterest = (monthsPerPeriod * monthlyRate * startingBalance) / 1000;
    for (let index = 0; index < totalPeriods; index += 1) {
      principal.push(0);
      interest.push(periodInterest);
      loanBalance.push(startingBalance / 1000);
    }
    return { principal, interest, loanBalance };
  }

  const monthlyPayment = inputs.monthlyDebtService && inputs.monthlyDebtService > 0
    ? inputs.monthlyDebtService
    : (monthlyRate * startingBalance) / (1 - Math.pow(1 + monthlyRate, -termMonths));
  let currentBalance = startingBalance;

  for (let periodIndex = 0; periodIndex < totalPeriods; periodIndex += 1) {
    let periodPrincipal = 0;
    let periodInterest = 0;

    for (let monthIndex = 0; monthIndex < monthsPerPeriod; monthIndex += 1) {
      const monthNumber = (periodIndex * monthsPerPeriod) + monthIndex + 1;
      if (monthNumber > termMonths || currentBalance <= 0.01) break;

      const monthlyInterest = monthlyRate * currentBalance;
      const monthlyPrincipal = Math.min(Math.max(monthlyPayment - monthlyInterest, 0), currentBalance);

      periodInterest += monthlyInterest;
      periodPrincipal += monthlyPrincipal;
      currentBalance = Math.max(currentBalance - monthlyPrincipal, 0);
    }

    principal.push(periodPrincipal / 1000);
    interest.push(periodInterest / 1000);
    loanBalance.push(currentBalance / 1000);
  }

  return { principal, interest, loanBalance };
}

function calculatePropertyAppreciation(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30) {
  const value: number[] = [];
  const equity: number[] = [];
  const loan: number[] = [];
  const { principal: startingBalance, termMonths } = getLoanProjectionBasis(inputs);
  const monthlyRate = inputs.interestRate / 100 / 12;
  const monthlyPayment = inputs.interestRate > 0 && !inputs.isInterestOnly
    ? (monthlyRate * startingBalance) / (1 - Math.pow(1 + monthlyRate, -termMonths))
    : 0;

  for (let year = 0; year < years; year += 1) {
    const propertyValue = inputs.avm * getAppreciationGrowthFactor(inputs, year);
    let remainingBalance = startingBalance;

    if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const monthCount = (year + 1) * 12;
      remainingBalance = startingBalance * Math.pow(1 + monthlyRate, monthCount)
        - (monthlyPayment * ((Math.pow(1 + monthlyRate, monthCount) - 1) / monthlyRate));
    }

    const currentEquity = Math.max(propertyValue - remainingBalance, 0);

    value.push(propertyValue / 1000);
    equity.push(currentEquity / 1000);
    loan.push(remainingBalance / 1000);
  }

  return { value, equity, loan };
}

function solveIRR(cashFlows: number[]) {
  let irr = 0.1;
  const maxIterations = 100;
  const tolerance = 0.0001;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let npv = 0;
    let dnpv = 0;

    for (let period = 0; period < cashFlows.length; period += 1) {
      npv += cashFlows[period] / Math.pow(1 + irr, period);
      dnpv += (-period * cashFlows[period]) / Math.pow(1 + irr, period + 1);
    }

    if (!Number.isFinite(dnpv) || Math.abs(dnpv) < 1e-9) break;

    const nextIrr = irr - (npv / dnpv);
    if (!Number.isFinite(nextIrr)) break;
    if (Math.abs(nextIrr - irr) < tolerance) return nextIrr * 100;
    irr = nextIrr;
  }

  return Number.isFinite(irr) ? irr * 100 : 0;
}

function calculateIRR(inputs: AnalyticsSurfaceFinancialInputs, holdingPeriod: number = 30) {
  const cashFlows = calculateCashFlow(inputs, holdingPeriod);
  const appreciation = calculatePropertyAppreciation(inputs, holdingPeriod);
  const initialCashFlow = -getForwardReturnCapitalBasis(inputs);
  const annualCashFlows = cashFlows.slice(0, Math.max(holdingPeriod - 1, 0)).map((value) => value * 1000);
  const lastIndex = Math.max(holdingPeriod - 1, 0);
  const finalCashFlow = (cashFlows[lastIndex] || 0) * 1000;
  const salePrice = (appreciation.value[lastIndex] || 0) * 1000;
  const loanBalance = (appreciation.loan[lastIndex] || 0) * 1000;
  const netSaleProceeds = salePrice - loanBalance - (salePrice * 0.06);

  return solveIRR([initialCashFlow, ...annualCashFlows, finalCashFlow + netSaleProceeds]);
}

function calculateRollingIRR(inputs: AnalyticsSurfaceFinancialInputs, maxHoldingPeriod: number = 30) {
  return Array.from({ length: maxHoldingPeriod }, (_, index) => {
    const irr = calculateIRR(inputs, index + 1);
    return Number.isFinite(irr) ? irr : 0;
  });
}

function calculateTotalReturn(inputs: AnalyticsSurfaceFinancialInputs, years: number = 30) {
  const cashFlows = calculateCashFlow(inputs, years);
  const appreciation = calculatePropertyAppreciation(inputs, years);
  const cumulative: number[] = [];
  const annualPercent: number[] = [];
  const initialInvestment = getForwardReturnCapitalBasis(inputs);
  const initialEquity = getCurrentEquityBasis(inputs);
  let cumulativeCashFlow = 0;

  for (let year = 0; year < years; year += 1) {
    cumulativeCashFlow += (cashFlows[year] || 0) * 1000;
    const currentEquity = (appreciation.equity[year] || 0) * 1000;
    const totalReturn = cumulativeCashFlow + (currentEquity - initialEquity);

    cumulative.push(totalReturn / 1000);
    annualPercent.push(initialInvestment > 0 ? (totalReturn / initialInvestment) * 100 : 0);
  }

  return { cumulative, annualPercent };
}

export function buildAnalyticsChartData(inputs: AnalyticsSurfaceFinancialInputs, analyticsGranularity: ProjectionGranularity): PropertyAnalyticsChartData {
  const periodsPerYear = getProjectionPeriodsPerYear(analyticsGranularity);
  const projectionYears = 30;
  const incomeExpenses = calculateIncomeExpenses(inputs, projectionYears);
  const propertyAppreciation = calculatePropertyAppreciation(inputs, projectionYears);
  const totalReturn = calculateTotalReturn(inputs, projectionYears);
  const annualIncome = calculateAnnualIncome(inputs, projectionYears);

  const annualNoi = calculateNOI(inputs, projectionYears);
  const noiSeries = interpolateSeries(annualNoi, analyticsGranularity, 'flow');
  const annualNoiForRatios = interpolateSeries(annualNoi, analyticsGranularity, 'level');
  const propertyValueSeries = interpolateSeries(propertyAppreciation.value, analyticsGranularity, 'level');
  const annualDebtService = getAnnualDebtService(inputs);

  // capRate and dscr use annual-equivalent NOI so ratios stay period-invariant.
  const capRate = annualNoiForRatios.map((noiThousands, index) => {
    const valueThousands = propertyValueSeries[index] || 0;
    return valueThousands > 0 ? (noiThousands / valueThousands) * 100 : 0;
  });
  const dscr = annualNoiForRatios.map((noiThousands) => (
    annualDebtService > 0 ? (noiThousands * 1000) / annualDebtService : 0
  ));

  const grossPotentialIncomeYearOne = 12 * (inputs.monthlyRent + inputs.otherIncome);
  const operatingExpensesYearOne = inputs.taxAmount + inputs.insurance + inputs.utilities
    + inputs.hoa + inputs.repairsCapEx
    + ((inputs.managementPct / 100) * grossPotentialIncomeYearOne * (1 - inputs.vacancyRate / 100));
  const breakEvenOccupancy = grossPotentialIncomeYearOne > 0
    ? Math.min(Math.max(((operatingExpensesYearOne + annualDebtService) / grossPotentialIncomeYearOne) * 100, 0), 100)
    : 0;
  const grm = grossPotentialIncomeYearOne > 0 ? inputs.avm / grossPotentialIncomeYearOne : 0;

  return {
    projectionLabels: buildProjectionLabels(projectionYears * periodsPerYear, analyticsGranularity),
    mortgageLabels: buildProjectionLabels(projectionYears * periodsPerYear, analyticsGranularity),
    cashFlow: interpolateSeries(calculateCashFlow(inputs, projectionYears), analyticsGranularity, 'flow'),
    annualIncome: {
      gross: interpolateSeries(annualIncome.gross, analyticsGranularity, 'flow'),
      collected: interpolateSeries(annualIncome.collected, analyticsGranularity, 'flow'),
    },
    incomeExpenses: {
      income: interpolateSeries(incomeExpenses.income, analyticsGranularity, 'flow'),
      expenseBreakdown: {
        taxes: interpolateSeries(incomeExpenses.expenseBreakdown.taxes, analyticsGranularity, 'flow'),
        insurance: interpolateSeries(incomeExpenses.expenseBreakdown.insurance, analyticsGranularity, 'flow'),
        utilities: interpolateSeries(incomeExpenses.expenseBreakdown.utilities, analyticsGranularity, 'flow'),
        hoa: interpolateSeries(incomeExpenses.expenseBreakdown.hoa, analyticsGranularity, 'flow'),
        repairs: interpolateSeries(incomeExpenses.expenseBreakdown.repairs, analyticsGranularity, 'flow'),
        management: interpolateSeries(incomeExpenses.expenseBreakdown.management, analyticsGranularity, 'flow'),
        debtService: interpolateSeries(incomeExpenses.expenseBreakdown.debtService, analyticsGranularity, 'flow'),
      },
    },
    cocReturn: interpolateSeries(calculateCoCReturn(inputs, projectionYears), analyticsGranularity, 'level'),
    capRate,
    noi: noiSeries,
    dscr,
    mortgageAmortization: calculateMortgageAmortization(inputs, projectionYears, periodsPerYear),
    propertyAppreciation: {
      value: propertyValueSeries,
      equity: interpolateSeries(propertyAppreciation.equity, analyticsGranularity, 'level'),
      loan: interpolateSeries(propertyAppreciation.loan, analyticsGranularity, 'level'),
    },
    totalReturn: {
      cumulative: interpolateSeries(totalReturn.cumulative, analyticsGranularity, 'level'),
    },
    rollingIrr: interpolateSeries(calculateRollingIRR(inputs, projectionYears), analyticsGranularity, 'level'),
    irr: calculateIRR(inputs, 9),
    breakEvenOccupancy,
    grm,
  };
}

export function buildAvmHistorySeries(propertyDashboard: PropertyDashboard | null | undefined, avmGranularity: AvmGranularity, avmRange: string): { avmPoints: MiniPoint[]; avmLabels: string[] } {
  if (!propertyDashboard?.avm_history) {
    return { avmPoints: [], avmLabels: [] };
  }

  const normalizedHistory = propertyDashboard.avm_history
    .filter((item) => item?.date && Number.isFinite(Number(item?.value)))
    .map((item) => ({
      date: new Date(item.date),
      value: Number(item.value),
    }))
    .filter((item) => !Number.isNaN(item.date.getTime()))
    .sort((left, right) => left.date.getTime() - right.date.getTime());

  const latestHistoryDate = [...normalizedHistory].sort((left, right) => right.date.getTime() - left.date.getTime())[0]?.date;
  const referenceDate = latestHistoryDate || new Date();

  let cutoffDate: Date;
  switch (avmRange) {
    case '2Q': cutoffDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 6, referenceDate.getDate()); break;
    case '1Y': cutoffDate = new Date(referenceDate.getFullYear() - 1, referenceDate.getMonth(), referenceDate.getDate()); break;
    case '2Y': cutoffDate = new Date(referenceDate.getFullYear() - 2, referenceDate.getMonth(), referenceDate.getDate()); break;
    case '3Y': cutoffDate = new Date(referenceDate.getFullYear() - 3, referenceDate.getMonth(), referenceDate.getDate()); break;
    case '5Y': cutoffDate = new Date(referenceDate.getFullYear() - 5, referenceDate.getMonth(), referenceDate.getDate()); break;
    case '10Y': cutoffDate = new Date(referenceDate.getFullYear() - 10, referenceDate.getMonth(), referenceDate.getDate()); break;
    case 'all': cutoffDate = new Date(1900, 0, 1); break;
    default: cutoffDate = new Date(referenceDate.getFullYear() - 10, referenceDate.getMonth(), referenceDate.getDate()); break;
  }

  const filtered = normalizedHistory.filter((item) => item.date >= cutoffDate);
  const avmPoints: MiniPoint[] = [];
  const avmLabels: string[] = [];

  if (avmGranularity === 'annual') {
    const yearMap = new Map<number, number>();
    filtered.forEach((item) => {
      yearMap.set(item.date.getFullYear(), item.value);
    });

    Array.from(yearMap.entries())
      .sort(([leftYear], [rightYear]) => leftYear - rightYear)
      .forEach(([year, value], index) => {
        avmPoints.push({ x: index, y: value });
        avmLabels.push(`${year}`);
      });

    return { avmPoints, avmLabels };
  }

  const quarterMap = new Map<string, { value: number; sortKey: number; label: string }>();
  filtered.forEach((item) => {
    const year = item.date.getFullYear();
    const quarter = Math.floor(item.date.getMonth() / 3) + 1;
    const key = `${year}-Q${quarter}`;
    quarterMap.set(key, {
      value: item.value,
      sortKey: year * 10 + quarter,
      label: `Q${quarter} ${year}`,
    });
  });

  Array.from(quarterMap.values())
    .sort((left, right) => left.sortKey - right.sortKey)
    .forEach((entry, index) => {
      avmPoints.push({ x: index, y: entry.value });
      avmLabels.push(entry.label);
    });

  return { avmPoints, avmLabels };
}

function MetricSurfaceEmptyState({
  description,
  dashboardCardMode = false,
}: {
  description: string;
  dashboardCardMode?: boolean;
}) {
  if (!dashboardCardMode) {
    return (
      <div className="flex h-full min-h-[220px] items-center justify-center rounded-[24px] border border-slate-200 bg-slate-50/80 px-6 text-center text-sm font-medium text-slate-500">
        {description}
      </div>
    );
  }

  return (
    <div className="analytics-card-halo-wrap">
      <SidebarLiquidGlassShell className="analytics-sidebar-glass flex h-full min-h-[220px]" contentClassName="flex h-full w-full">
        <div className="analytics-glass-body flex h-full w-full items-center justify-center px-8 py-10 text-center text-sm font-medium text-slate-500">
          {description}
        </div>
      </SidebarLiquidGlassShell>
    </div>
  );
}

export default function PropertyAnalyticsMetricSurface({
  metric,
  propertyDashboard,
  financialInputs,
  scopeLabel,
  showScopeHeader = true,
  dashboardCardMode = false,
}: PropertyAnalyticsMetricSurfaceProps) {
  const [analyticsGranularity, setAnalyticsGranularity] = useState<ProjectionGranularity>('annual');
  const [avmGranularity, setAvmGranularity] = useState<AvmGranularity>('annual');
  const [avmRange, setAvmRange] = useState<string>('10Y');
  const [taxHistoryRange, setTaxHistoryRange] = useState<TaxHistoryRange>('10Y');
  const [mortgageAmortRange, setMortgageAmortRange] = useState<MetricTimeframe>('10Y');

  const chartData = useMemo(
    () => (financialInputs ? buildAnalyticsChartData(financialInputs, analyticsGranularity) : null),
    [analyticsGranularity, financialInputs],
  );
  const { avmPoints, avmLabels } = useMemo(
    () => buildAvmHistorySeries(propertyDashboard, avmGranularity, avmRange),
    [avmGranularity, avmRange, propertyDashboard],
  );
  const taxHistorySeries = useMemo(
    () => buildTaxHistorySeries(propertyDashboard?.tax_history as Array<{ year?: number | string; tax_amount?: number | string }> | undefined, taxHistoryRange),
    [propertyDashboard, taxHistoryRange],
  );

  const needsAvmHistory = metric === 'priceHistory';
  const needsTaxHistory = metric === 'taxHistory';
  const hasRenderableData = needsAvmHistory
    ? avmPoints.length > 0
    : needsTaxHistory
      ? taxHistorySeries.values.length > 0
      : chartData !== null;

  if (!hasRenderableData) {
    return <MetricSurfaceEmptyState description="This property does not have enough source data yet to render that analytics card." dashboardCardMode={dashboardCardMode} />;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {showScopeHeader ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Property analytics</div>
            <div className="truncate text-sm font-semibold text-slate-900">{scopeLabel || 'Selected property'}</div>
          </div>
          <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-medium text-slate-600">Exact source card</div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <AdditionalAnalyticsChartsGrid
          avmGranularity={avmGranularity}
          avmRange={avmRange}
          avmPoints={avmPoints}
          avmLabels={avmLabels}
          chartData={chartData}
          analyticsGranularity={analyticsGranularity}
          taxHistoryRange={taxHistoryRange}
          taxHistorySeries={taxHistorySeries}
          mortgageAmortRange={mortgageAmortRange}
          onAnalyticsGranularityChange={setAnalyticsGranularity}
          onAvmGranularityChange={setAvmGranularity}
          onAvmRangeChange={setAvmRange}
          onTaxHistoryRangeChange={setTaxHistoryRange}
          onMortgageAmortRangeChange={setMortgageAmortRange}
          metricFilter={[metric]}
          showHeader={false}
          dashboardCardMode={dashboardCardMode}
        />
      </div>
    </div>
  );
}