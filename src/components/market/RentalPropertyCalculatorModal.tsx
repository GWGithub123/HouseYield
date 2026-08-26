import React, { useMemo, useState } from 'react';
import { ChartModal, SegmentedToggle } from '../charts/AnalyticsFrame';
import {
  AdditionalAnalyticsChartsGrid,
  type AvmGranularity,
  type MetricTimeframe,
  type ProjectionGranularity,
  type PropertyAnalyticsChartData,
  type TaxHistoryRange,
} from '../property/PropertyAnalyticsGraphs';

type RentalPropertyCalculatorModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

type ToggleValue = 'yes' | 'no';

type RentalCalculatorInputs = {
  purchasePrice: number;
  useLoan: ToggleValue;
  downPaymentPercent: number;
  interestRate: number;
  loanTermYears: number;
  closingCost: number;
  needRepairs: ToggleValue;
  repairCost: number;
  valueAfterRepairs: number;
  propertyTax: number;
  propertyTaxIncrease: number;
  insurance: number;
  insuranceIncrease: number;
  hoaFee: number;
  hoaIncrease: number;
  maintenance: number;
  maintenanceIncrease: number;
  otherCosts: number;
  otherCostsIncrease: number;
  monthlyRent: number;
  monthlyRentIncrease: number;
  otherMonthlyIncome: number;
  otherMonthlyIncomeIncrease: number;
  vacancyRate: number;
  managementFee: number;
  knowSellPrice: ToggleValue;
  valueAppreciation: number;
  sellPrice: number;
  holdingLengthYears: number;
  costToSell: number;
};

type MortgageYear = {
  principalPaid: number;
  interestPaid: number;
  endingBalance: number;
};

type ProjectionRow = {
  year: number;
  annualIncome: number;
  grossPotentialIncome: number;
  vacancyLoss: number;
  mortgage: number;
  propertyTax: number;
  insurance: number;
  hoaFee: number;
  maintenance: number;
  otherCosts: number;
  management: number;
  operatingExpenses: number;
  cashFlow: number;
  cashOnCashReturn: number;
  equityAccumulated: number;
  cashToReceive: number;
  irr: number;
  netOperatingIncome: number;
  propertyValue: number;
  loanBalance: number;
};

type SummaryMetric = {
  label: string;
  value: string;
};

type ProjectionOutput = {
  initialInvestment: number;
  purchaseBasis: number;
  mortgagePayment: number;
  mortgageYears: MortgageYear[];
  holdingRows: ProjectionRow[];
  projectionRows: ProjectionRow[];
  summaryMetrics: SummaryMetric[];
  expenseBreakdown: Array<{ label: string; value: number; color: string }>;
  chartData: PropertyAnalyticsChartData;
  avmPoints: Array<{ x: number; y: number }>;
  avmLabels: string[];
  taxHistorySeries: { values: number[]; labels: string[] };
};

const DEFAULT_INPUTS: RentalCalculatorInputs = {
  purchasePrice: 200000,
  useLoan: 'yes',
  downPaymentPercent: 20,
  interestRate: 6,
  loanTermYears: 30,
  closingCost: 6000,
  needRepairs: 'no',
  repairCost: 20000,
  valueAfterRepairs: 260000,
  propertyTax: 3000,
  propertyTaxIncrease: 3,
  insurance: 1200,
  insuranceIncrease: 3,
  hoaFee: 0,
  hoaIncrease: 3,
  maintenance: 2000,
  maintenanceIncrease: 3,
  otherCosts: 500,
  otherCostsIncrease: 3,
  monthlyRent: 2000,
  monthlyRentIncrease: 3,
  otherMonthlyIncome: 0,
  otherMonthlyIncomeIncrease: 3,
  vacancyRate: 5,
  managementFee: 0,
  knowSellPrice: 'no',
  valueAppreciation: 3,
  sellPrice: 400000,
  holdingLengthYears: 20,
  costToSell: 8,
};

const EXPENSE_COLORS = ['#3b82f6', '#84cc16', '#b91c1c', '#06b6d4', '#7c3aed', '#ec4899', '#f97316', '#14b8a6'];

function roundMoney(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function formatCurrency(value: number, digits: number = 2) {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value: number, digits: number = 2) {
  return `${value.toFixed(digits)}%`;
}

function formatCompactCurrency(value: number) {
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000) {
    return `${value < 0 ? '-' : ''}$${(absValue / 1_000_000).toFixed(2)}M`;
  }
  if (absValue >= 1_000) {
    return `${value < 0 ? '-' : ''}$${(absValue / 1_000).toFixed(1)}k`;
  }
  return formatCurrency(value);
}

function parseNumberInput(value: string) {
  if (!value.trim()) return 0;
  const normalized = value.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function solveIRR(cashFlows: number[]) {
  let irr = 0.1;
  const maxIterations = 100;
  const tolerance = 0.0000001;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let npv = 0;
    let dnpv = 0;

    for (let period = 0; period < cashFlows.length; period += 1) {
      const divisor = Math.pow(1 + irr, period);
      npv += cashFlows[period] / divisor;
      dnpv += (-period * cashFlows[period]) / Math.pow(1 + irr, period + 1);
    }

    if (!Number.isFinite(dnpv) || Math.abs(dnpv) < 1e-9) {
      break;
    }

    const nextIrr = irr - (npv / dnpv);
    if (!Number.isFinite(nextIrr)) {
      break;
    }
    if (Math.abs(nextIrr - irr) < tolerance) {
      return nextIrr * 100;
    }
    irr = nextIrr;
  }

  return Number.isFinite(irr) ? irr * 100 : 0;
}

function getMonthlyMortgagePayment(loanAmount: number, annualRatePercent: number, termMonths: number) {
  if (loanAmount <= 0 || termMonths <= 0) return 0;
  if (annualRatePercent <= 0) return loanAmount / termMonths;
  const monthlyRate = annualRatePercent / 100 / 12;
  return (monthlyRate * loanAmount) / (1 - Math.pow(1 + monthlyRate, -termMonths));
}

function buildAnnualMortgageSchedule(loanAmount: number, annualRatePercent: number, termMonths: number, years: number): MortgageYear[] {
  const schedule: MortgageYear[] = [];
  let balance = Math.max(loanAmount, 0);
  const monthlyPayment = getMonthlyMortgagePayment(loanAmount, annualRatePercent, termMonths);
  const monthlyRate = annualRatePercent / 100 / 12;
  const totalMonths = Math.max(termMonths, 0);

  for (let year = 0; year < years; year += 1) {
    let principalPaid = 0;
    let interestPaid = 0;

    for (let month = 0; month < 12; month += 1) {
      const absoluteMonth = (year * 12) + month;
      if (absoluteMonth >= totalMonths || balance <= 0) {
        break;
      }

      if (annualRatePercent <= 0) {
        const principalPortion = Math.min(monthlyPayment, balance);
        principalPaid += principalPortion;
        balance -= principalPortion;
        continue;
      }

      const interestPortion = balance * monthlyRate;
      const principalPortion = Math.min(monthlyPayment - interestPortion, balance);
      interestPaid += interestPortion;
      principalPaid += principalPortion;
      balance = Math.max(balance - principalPortion, 0);
    }

    schedule.push({
      principalPaid: roundMoney(principalPaid),
      interestPaid: roundMoney(interestPaid),
      endingBalance: roundMoney(balance),
    });
  }

  return schedule;
}

function buildProjectionOutput(inputs: RentalCalculatorInputs): ProjectionOutput {
  const holdingLength = Math.max(1, Math.round(inputs.holdingLengthYears || 0));
  const projectionYears = Math.max(30, holdingLength);
  const purchasePrice = roundMoney(inputs.purchasePrice);
  const repairCost = inputs.needRepairs === 'yes' ? roundMoney(inputs.repairCost) : 0;
  const repairedValue = inputs.needRepairs === 'yes'
    ? Math.max(roundMoney(inputs.valueAfterRepairs), purchasePrice)
    : purchasePrice;
  const purchaseBasis = purchasePrice;
  const loanAmount = inputs.useLoan === 'yes'
    ? purchasePrice * (1 - clamp(inputs.downPaymentPercent, 0, 100) / 100)
    : 0;
  const downPayment = inputs.useLoan === 'yes' ? purchasePrice - loanAmount : purchasePrice;
  const monthlyMortgagePayment = inputs.useLoan === 'yes'
    ? getMonthlyMortgagePayment(loanAmount, inputs.interestRate, Math.round(inputs.loanTermYears * 12))
    : 0;
  const mortgageYears = inputs.useLoan === 'yes'
    ? buildAnnualMortgageSchedule(loanAmount, inputs.interestRate, Math.round(inputs.loanTermYears * 12), projectionYears)
    : Array.from({ length: projectionYears }, () => ({
        principalPaid: 0,
        interestPaid: 0,
        endingBalance: 0,
      }));

  const initialInvestment = roundMoney(downPayment + inputs.closingCost + repairCost);
  const annualGrowthRate = (() => {
    if (inputs.knowSellPrice !== 'yes') {
      return inputs.valueAppreciation / 100;
    }
    if (repairedValue <= 0 || inputs.sellPrice <= 0) {
      return 0;
    }
    return Math.pow(inputs.sellPrice / repairedValue, 1 / holdingLength) - 1;
  })();

  const projectionRows: ProjectionRow[] = [];
  const cumulativeCashFlows: number[] = [];

  for (let year = 1; year <= projectionYears; year += 1) {
    const rentGrowthFactor = Math.pow(1 + (inputs.monthlyRentIncrease / 100), year - 1);
    const otherIncomeGrowthFactor = Math.pow(1 + (inputs.otherMonthlyIncomeIncrease / 100), year - 1);
    const annualRent = (inputs.monthlyRent * rentGrowthFactor) * 12;
    const annualOtherIncome = (inputs.otherMonthlyIncome * otherIncomeGrowthFactor) * 12;
    const grossPotentialIncome = annualRent + annualOtherIncome;
    const vacancyLoss = grossPotentialIncome * (inputs.vacancyRate / 100);
    const annualIncome = grossPotentialIncome - vacancyLoss;

    const propertyTax = inputs.propertyTax * Math.pow(1 + (inputs.propertyTaxIncrease / 100), year - 1);
    const insurance = inputs.insurance * Math.pow(1 + (inputs.insuranceIncrease / 100), year - 1);
    const hoaFee = inputs.hoaFee * Math.pow(1 + (inputs.hoaIncrease / 100), year - 1);
    const maintenance = inputs.maintenance * Math.pow(1 + (inputs.maintenanceIncrease / 100), year - 1);
    const otherCosts = inputs.otherCosts * Math.pow(1 + (inputs.otherCostsIncrease / 100), year - 1);
    const management = annualIncome * (inputs.managementFee / 100);
    const operatingExpenses = propertyTax + insurance + hoaFee + maintenance + otherCosts + management;
    const mortgage = (mortgageYears[year - 1]?.principalPaid || 0) + (mortgageYears[year - 1]?.interestPaid || 0);
    const netOperatingIncome = annualIncome - operatingExpenses;
    const cashFlow = netOperatingIncome - mortgage;
    cumulativeCashFlows.push(cashFlow);

    const propertyValue = repairedValue * Math.pow(1 + annualGrowthRate, year);
    const loanBalance = mortgageYears[year - 1]?.endingBalance || 0;
    const cashToReceive = propertyValue - loanBalance - (propertyValue * (inputs.costToSell / 100));
    const annualizedCashFlowSeries = cumulativeCashFlows.slice(0, Math.max(year - 1, 0));
    const irr = solveIRR([
      -initialInvestment,
      ...annualizedCashFlowSeries.slice(0, -1),
      (annualizedCashFlowSeries[annualizedCashFlowSeries.length - 1] || cashFlow) + cashToReceive,
    ]);

    projectionRows.push({
      year,
      annualIncome: roundMoney(annualIncome),
      grossPotentialIncome: roundMoney(grossPotentialIncome),
      vacancyLoss: roundMoney(vacancyLoss),
      mortgage: roundMoney(mortgage),
      propertyTax: roundMoney(propertyTax),
      insurance: roundMoney(insurance),
      hoaFee: roundMoney(hoaFee),
      maintenance: roundMoney(maintenance),
      otherCosts: roundMoney(otherCosts),
      management: roundMoney(management),
      operatingExpenses: roundMoney(operatingExpenses),
      cashFlow: roundMoney(cashFlow),
      cashOnCashReturn: initialInvestment > 0 ? (cashFlow / initialInvestment) * 100 : 0,
      equityAccumulated: roundMoney(propertyValue - loanBalance),
      cashToReceive: roundMoney(cashToReceive),
      irr: Number.isFinite(irr) ? irr : 0,
      netOperatingIncome: roundMoney(netOperatingIncome),
      propertyValue: roundMoney(propertyValue),
      loanBalance: roundMoney(loanBalance),
    });
  }

  const holdingRows = projectionRows.slice(0, holdingLength);
  const firstYear = holdingRows[0];
  const finalYear = holdingRows[holdingRows.length - 1];
  const totalAnnualIncome = holdingRows.reduce((sum, row) => sum + row.annualIncome, 0);
  const totalMortgage = holdingRows.reduce((sum, row) => sum + row.mortgage, 0);
  const totalExpenses = holdingRows.reduce((sum, row) => sum + row.operatingExpenses, 0);
  const totalNoi = holdingRows.reduce((sum, row) => sum + row.netOperatingIncome, 0);
  const totalCashFlow = holdingRows.reduce((sum, row) => sum + row.cashFlow, 0);
  const totalProfitWhenSold = totalCashFlow + finalYear.cashToReceive - initialInvestment;
  const capRateBasis = inputs.needRepairs === 'yes' ? repairedValue : purchaseBasis;
  const summaryMetrics: SummaryMetric[] = [
    { label: `Return (IRR)`, value: formatPercent(finalYear.irr) },
    { label: `Total Profit when Sold`, value: formatCurrency(totalProfitWhenSold) },
    { label: `Cash on Cash Return`, value: formatPercent(initialInvestment > 0 ? (totalProfitWhenSold / initialInvestment) * 100 : 0) },
    { label: `Capitalization Rate`, value: formatPercent(capRateBasis > 0 ? (firstYear.netOperatingIncome / capRateBasis) * 100 : 0) },
    { label: `Total Rental Income`, value: formatCurrency(totalAnnualIncome) },
    { label: `Total Mortgage Payments`, value: formatCurrency(totalMortgage) },
    { label: `Total Expenses`, value: formatCurrency(totalExpenses) },
    { label: `Total Net Operating Income`, value: formatCurrency(totalNoi) },
  ];

  const expenseBreakdownBase = [
    { label: 'Mortgage', value: firstYear.mortgage },
    { label: 'Vacancy', value: firstYear.vacancyLoss },
    { label: 'Property Tax', value: firstYear.propertyTax },
    { label: 'Insurance', value: firstYear.insurance },
    { label: 'HOA', value: firstYear.hoaFee },
    { label: 'Maintenance', value: firstYear.maintenance },
    { label: 'Other Cost', value: firstYear.otherCosts },
    { label: 'Management', value: firstYear.management },
  ].filter((item) => item.value > 0);
  const expenseBreakdown = expenseBreakdownBase.map((item, index) => ({
    ...item,
    color: EXPENSE_COLORS[index % EXPENSE_COLORS.length],
  }));

  const rollingIrr = projectionRows.map((row) => row.irr);
  const cashOnCashSeries = projectionRows.map((row) => row.cashOnCashReturn);
  const capRateSeries = projectionRows.map((row) => (row.propertyValue > 0 ? (row.netOperatingIncome / row.propertyValue) * 100 : 0));
  const dscrSeries = projectionRows.map((row) => (row.mortgage > 0 ? row.netOperatingIncome / row.mortgage : 0));
  const totalReturnSeries = projectionRows.map((row, index) => {
    const cumulativeCashFlow = projectionRows.slice(0, index + 1).reduce((sum, entry) => sum + entry.cashFlow, 0);
    return (cumulativeCashFlow + row.cashToReceive - initialInvestment) / 1000;
  });
  const firstYearGrossIncome = firstYear.grossPotentialIncome;
  const firstYearBreakEvenOccupancy = firstYearGrossIncome > 0
    ? clamp(((firstYear.operatingExpenses + firstYear.mortgage) / firstYearGrossIncome) * 100, 0, 100)
    : 0;
  const chartData: PropertyAnalyticsChartData = {
    projectionLabels: projectionRows.map((row) => `${new Date().getFullYear() + row.year - 1}`),
    mortgageLabels: projectionRows.map((row) => `${new Date().getFullYear() + row.year - 1}`),
    cashFlow: projectionRows.map((row) => row.cashFlow / 1000),
    annualIncome: {
      gross: projectionRows.map((row) => row.grossPotentialIncome / 1000),
      collected: projectionRows.map((row) => row.annualIncome / 1000),
    },
    incomeExpenses: {
      income: projectionRows.map((row) => row.annualIncome / 1000),
      expenseBreakdown: {
        taxes: projectionRows.map((row) => row.propertyTax / 1000),
        insurance: projectionRows.map((row) => row.insurance / 1000),
        utilities: projectionRows.map(() => 0),
        hoa: projectionRows.map((row) => row.hoaFee / 1000),
        repairs: projectionRows.map((row) => (row.maintenance + row.otherCosts) / 1000),
        management: projectionRows.map((row) => row.management / 1000),
        debtService: projectionRows.map((row) => row.mortgage / 1000),
      },
    },
    cocReturn: cashOnCashSeries,
    capRate: capRateSeries,
    noi: projectionRows.map((row) => row.netOperatingIncome / 1000),
    dscr: dscrSeries,
    mortgageAmortization: {
      principal: mortgageYears.map((row) => row.principalPaid / 1000),
      interest: mortgageYears.map((row) => row.interestPaid / 1000),
      loanBalance: mortgageYears.map((row) => row.endingBalance / 1000),
    },
    propertyAppreciation: {
      loan: projectionRows.map((row) => row.loanBalance / 1000),
      equity: projectionRows.map((row) => row.equityAccumulated / 1000),
      value: projectionRows.map((row) => row.propertyValue / 1000),
    },
    totalReturn: {
      cumulative: totalReturnSeries,
    },
    rollingIrr,
    irr: finalYear.irr,
    breakEvenOccupancy: firstYearBreakEvenOccupancy,
    grm: firstYearGrossIncome > 0 ? purchaseBasis / firstYearGrossIncome : 0,
  };

  return {
    initialInvestment,
    purchaseBasis,
    mortgagePayment: monthlyMortgagePayment,
    mortgageYears,
    holdingRows,
    projectionRows,
    summaryMetrics,
    expenseBreakdown,
    chartData,
    avmPoints: projectionRows.map((row, index) => ({ x: index, y: row.propertyValue })),
    avmLabels: projectionRows.map((row) => `${new Date().getFullYear() + row.year - 1}`),
    taxHistorySeries: {
      values: projectionRows.map((row) => row.propertyTax / 1000),
      labels: projectionRows.map((row) => `${new Date().getFullYear() + row.year - 1}`),
    },
  };
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  step = 'any',
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  step?: string;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="flex items-center overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <input
          type="number"
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(event) => onChange(parseNumberInput(event.target.value))}
          className="w-full bg-transparent px-3 py-2.5 text-sm text-slate-900 outline-none"
        />
        {suffix ? <span className="border-l border-slate-200 px-3 text-sm text-slate-500">{suffix}</span> : null}
      </div>
    </label>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <h3 className="mb-4 text-base font-semibold text-slate-900">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function SummaryGrid({ metrics }: { metrics: SummaryMetric[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {metrics.map((metric) => (
        <div key={metric.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-medium text-slate-500">{metric.label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-emerald-600">{metric.value}</div>
        </div>
      ))}
    </div>
  );
}

function ExpenseDonut({
  items,
}: {
  items: Array<{ label: string; value: number; color: string }>;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const gradient = useMemo(() => {
    if (total <= 0 || items.length === 0) return 'conic-gradient(#e2e8f0 0deg 360deg)';
    let current = 0;
    const stops = items.map((item) => {
      const start = current;
      const angle = (item.value / total) * 360;
      current += angle;
      return `${item.color} ${start}deg ${current}deg`;
    });
    return `conic-gradient(${stops.join(', ')})`;
  }, [items, total]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px,minmax(0,1fr)]">
      <div className="flex flex-col items-center justify-center">
        <div
          className="relative h-48 w-48 rounded-full"
          style={{ backgroundImage: gradient }}
        >
          <div className="absolute inset-7 rounded-full bg-white shadow-inner" />
          <div className="absolute inset-0 flex items-center justify-center text-center">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Year 1 Total</div>
              <div className="mt-2 text-xl font-semibold text-slate-900">{formatCompactCurrency(total)}</div>
            </div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800">{item.label}</div>
              <div className="text-xs text-slate-500">{formatPercent(total > 0 ? (item.value / total) * 100 : 0)}</div>
            </div>
            <div className="text-sm font-semibold text-slate-900">{formatCurrency(item.value)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalculatorResults({
  output,
}: {
  output: ProjectionOutput;
}) {
  const firstYear = output.holdingRows[0];
  const totalProfitWhenSold = output.holdingRows.reduce((sum, row) => sum + row.cashFlow, 0)
    + output.holdingRows[output.holdingRows.length - 1].cashToReceive
    - output.initialInvestment;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="space-y-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">For the {output.holdingRows.length} Years Invested</div>
            <h3 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Modeled Return Summary</h3>
          </div>
          <SummaryGrid metrics={output.summaryMetrics} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">First Year Income and Expense</div>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">Year 1 Cash Flow</h3>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="text-left text-slate-600">
                  <th className="px-4 py-3 font-semibold">Line Item</th>
                  <th className="px-4 py-3 font-semibold">Monthly</th>
                  <th className="px-4 py-3 font-semibold">Annual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {[
                  ['Income', firstYear.grossPotentialIncome / 12, firstYear.grossPotentialIncome],
                  ['Mortgage Pay', firstYear.mortgage / 12, firstYear.mortgage],
                  ['Vacancy', firstYear.vacancyLoss / 12, firstYear.vacancyLoss],
                  ['Property Tax', firstYear.propertyTax / 12, firstYear.propertyTax],
                  ['Total Insurance', firstYear.insurance / 12, firstYear.insurance],
                  ['HOA Fee', firstYear.hoaFee / 12, firstYear.hoaFee],
                  ['Maintenance Cost', firstYear.maintenance / 12, firstYear.maintenance],
                  ['Other Cost', firstYear.otherCosts / 12, firstYear.otherCosts],
                  ['Management Fee', firstYear.management / 12, firstYear.management],
                  ['Cash Flow', firstYear.cashFlow / 12, firstYear.cashFlow],
                  ['Net Operating Income (NOI)', firstYear.netOperatingIncome / 12, firstYear.netOperatingIncome],
                ]
                  .filter(([, monthly, annual]) => monthly !== 0 || annual !== 0)
                  .map(([label, monthly, annual]) => (
                    <tr key={String(label)}>
                      <td className="px-4 py-3 font-medium text-slate-800">{label}</td>
                      <td className="px-4 py-3 text-slate-700">{formatCurrency(Number(monthly))}</td>
                      <td className="px-4 py-3 text-slate-700">{formatCurrency(Number(annual))}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">First Year Expense Breakdown</div>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">Operating Mix</h3>
        </div>
        <ExpenseDonut items={output.expenseBreakdown} />
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Breakdown Over Time</div>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">Holding Period Table</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-3 font-semibold">Year</th>
                <th className="px-3 py-3 font-semibold">Annual Income</th>
                <th className="px-3 py-3 font-semibold">Mortgage</th>
                <th className="px-3 py-3 font-semibold">Expenses</th>
                <th className="px-3 py-3 font-semibold">Cash Flow</th>
                <th className="px-3 py-3 font-semibold">Cash on Cash Return</th>
                <th className="px-3 py-3 font-semibold">Equity Accumulated</th>
                <th className="px-3 py-3 font-semibold">Cash to Receive</th>
                <th className="px-3 py-3 font-semibold">Return (IRR)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              <tr className="bg-slate-50/70">
                <td className="px-3 py-3 font-semibold text-slate-800">Begin</td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 font-semibold text-rose-600">{formatCurrency(-output.initialInvestment)}</td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 text-slate-500">-</td>
              </tr>
              {output.holdingRows.map((row) => (
                <tr key={row.year} className="hover:bg-slate-50/60">
                  <td className="px-3 py-3 font-medium text-slate-900">{row.year}.</td>
                  <td className="px-3 py-3 text-slate-700">{formatCurrency(row.annualIncome)}</td>
                  <td className="px-3 py-3 text-slate-700">{formatCurrency(row.mortgage)}</td>
                  <td className="px-3 py-3 text-slate-700">{formatCurrency(row.operatingExpenses)}</td>
                  <td className="px-3 py-3 font-medium text-slate-900">{formatCurrency(row.cashFlow)}</td>
                  <td className="px-3 py-3 text-slate-700">{formatPercent(row.cashOnCashReturn)}</td>
                  <td className="px-3 py-3 text-slate-700">{formatCurrency(row.equityAccumulated)}</td>
                  <td className="px-3 py-3 text-slate-700">{formatCurrency(row.cashToReceive)}</td>
                  <td className="px-3 py-3 text-slate-700">{formatPercent(row.irr)}</td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold">
                <td className="px-3 py-3 text-slate-900">Total</td>
                <td className="px-3 py-3 text-slate-900">{formatCurrency(output.holdingRows.reduce((sum, row) => sum + row.annualIncome, 0))}</td>
                <td className="px-3 py-3 text-slate-900">{formatCurrency(output.holdingRows.reduce((sum, row) => sum + row.mortgage, 0))}</td>
                <td className="px-3 py-3 text-slate-900">{formatCurrency(output.holdingRows.reduce((sum, row) => sum + row.operatingExpenses, 0))}</td>
                <td className="px-3 py-3 text-slate-900">{formatCurrency(totalProfitWhenSold)}</td>
                <td className="px-3 py-3 text-slate-900">
                  {formatPercent(output.initialInvestment > 0 ? (totalProfitWhenSold / output.initialInvestment) * 100 : 0)}
                </td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 text-slate-500">-</td>
                <td className="px-3 py-3 text-slate-900">{formatPercent(output.holdingRows[output.holdingRows.length - 1].irr)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function RentalPropertyCalculatorModal({
  isOpen,
  onClose,
}: RentalPropertyCalculatorModalProps) {
  const [draftInputs, setDraftInputs] = useState<RentalCalculatorInputs>(DEFAULT_INPUTS);
  const [calculatedInputs, setCalculatedInputs] = useState<RentalCalculatorInputs>(DEFAULT_INPUTS);
  const [analyticsGranularity, setAnalyticsGranularity] = useState<ProjectionGranularity>('annual');
  const [avmGranularity, setAvmGranularity] = useState<AvmGranularity>('annual');
  const [avmRange, setAvmRange] = useState('all');
  const [taxHistoryRange, setTaxHistoryRange] = useState<TaxHistoryRange>('10Y');
  const [mortgageAmortRange, setMortgageAmortRange] = useState<MetricTimeframe>('10Y');

  const output = useMemo(() => buildProjectionOutput(calculatedInputs), [calculatedInputs]);

  if (!isOpen) {
    return null;
  }

  const setField = <K extends keyof RentalCalculatorInputs>(field: K, value: RentalCalculatorInputs[K]) => {
    setDraftInputs((current) => ({
      ...current,
      [field]: value,
    }));
  };

  return (
    <ChartModal
      wide
      onClose={onClose}
      title={
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Market Insights</div>
          <div className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-slate-900">Rental Property Calculator</div>
          <div className="mt-1 text-sm text-slate-500">
            Recreated rental-property underwriting flow with the same core outputs, plus your expanded analytics visualizations.
          </div>
        </div>
      }
      controls={
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setDraftInputs(DEFAULT_INPUTS);
              setCalculatedInputs(DEFAULT_INPUTS);
            }}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setCalculatedInputs(draftInputs)}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            Calculate
          </button>
        </div>
      }
    >
      <div className="h-full overflow-y-auto px-2 py-2 sm:px-4 sm:py-4">
        <div className="space-y-8">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <SectionCard title="Purchase">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <NumberField label="Purchase Price" value={draftInputs.purchasePrice} onChange={(value) => setField('purchasePrice', value)} />
                <NumberField label="Closing Cost" value={draftInputs.closingCost} onChange={(value) => setField('closingCost', value)} />
              </div>
              <div className="space-y-3">
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700">Use Loan?</div>
                  <SegmentedToggle
                    value={draftInputs.useLoan}
                    onChange={(value) => setField('useLoan', value)}
                    options={[
                      { value: 'yes', label: 'Yes' },
                      { value: 'no', label: 'No' },
                    ]}
                  />
                </div>
                {draftInputs.useLoan === 'yes' && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <NumberField label="Down Payment" value={draftInputs.downPaymentPercent} onChange={(value) => setField('downPaymentPercent', value)} suffix="%" />
                    <NumberField label="Interest Rate" value={draftInputs.interestRate} onChange={(value) => setField('interestRate', value)} suffix="%" />
                    <NumberField label="Loan Term" value={draftInputs.loanTermYears} onChange={(value) => setField('loanTermYears', value)} suffix="years" />
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700">Need Repairs?</div>
                  <SegmentedToggle
                    value={draftInputs.needRepairs}
                    onChange={(value) => setField('needRepairs', value)}
                    options={[
                      { value: 'yes', label: 'Yes' },
                      { value: 'no', label: 'No' },
                    ]}
                  />
                </div>
                {draftInputs.needRepairs === 'yes' && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <NumberField label="Repair Cost" value={draftInputs.repairCost} onChange={(value) => setField('repairCost', value)} />
                    <NumberField label="Value After Repairs" value={draftInputs.valueAfterRepairs} onChange={(value) => setField('valueAfterRepairs', value)} />
                  </div>
                )}
              </div>
            </SectionCard>

            <SectionCard title="Recurring Operating Expenses">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <NumberField label="Property Tax" value={draftInputs.propertyTax} onChange={(value) => setField('propertyTax', value)} />
                <NumberField label="Property Tax Increase" value={draftInputs.propertyTaxIncrease} onChange={(value) => setField('propertyTaxIncrease', value)} suffix="%" />
                <NumberField label="Total Insurance" value={draftInputs.insurance} onChange={(value) => setField('insurance', value)} />
                <NumberField label="Insurance Increase" value={draftInputs.insuranceIncrease} onChange={(value) => setField('insuranceIncrease', value)} suffix="%" />
                <NumberField label="HOA Fee" value={draftInputs.hoaFee} onChange={(value) => setField('hoaFee', value)} />
                <NumberField label="HOA Increase" value={draftInputs.hoaIncrease} onChange={(value) => setField('hoaIncrease', value)} suffix="%" />
                <NumberField label="Maintenance" value={draftInputs.maintenance} onChange={(value) => setField('maintenance', value)} />
                <NumberField label="Maintenance Increase" value={draftInputs.maintenanceIncrease} onChange={(value) => setField('maintenanceIncrease', value)} suffix="%" />
                <NumberField label="Other Costs" value={draftInputs.otherCosts} onChange={(value) => setField('otherCosts', value)} />
                <NumberField label="Other Costs Increase" value={draftInputs.otherCostsIncrease} onChange={(value) => setField('otherCostsIncrease', value)} suffix="%" />
              </div>
            </SectionCard>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <SectionCard title="Income">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <NumberField label="Monthly Rent" value={draftInputs.monthlyRent} onChange={(value) => setField('monthlyRent', value)} />
                <NumberField label="Rent Increase" value={draftInputs.monthlyRentIncrease} onChange={(value) => setField('monthlyRentIncrease', value)} suffix="%" />
                <NumberField label="Other Monthly Income" value={draftInputs.otherMonthlyIncome} onChange={(value) => setField('otherMonthlyIncome', value)} />
                <NumberField label="Other Income Increase" value={draftInputs.otherMonthlyIncomeIncrease} onChange={(value) => setField('otherMonthlyIncomeIncrease', value)} suffix="%" />
                <NumberField label="Vacancy Rate" value={draftInputs.vacancyRate} onChange={(value) => setField('vacancyRate', value)} suffix="%" />
                <NumberField label="Management Fee" value={draftInputs.managementFee} onChange={(value) => setField('managementFee', value)} suffix="%" />
              </div>
            </SectionCard>

            <SectionCard title="Sell">
              <div className="space-y-3">
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700">Do You Know the Sell Price?</div>
                  <SegmentedToggle
                    value={draftInputs.knowSellPrice}
                    onChange={(value) => setField('knowSellPrice', value)}
                    options={[
                      { value: 'yes', label: 'Yes' },
                      { value: 'no', label: 'No' },
                    ]}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {draftInputs.knowSellPrice === 'yes' ? (
                    <NumberField label="Sell Price" value={draftInputs.sellPrice} onChange={(value) => setField('sellPrice', value)} />
                  ) : (
                    <NumberField label="Value Appreciation" value={draftInputs.valueAppreciation} onChange={(value) => setField('valueAppreciation', value)} suffix="% / yr" />
                  )}
                  <NumberField label="Holding Length" value={draftInputs.holdingLengthYears} onChange={(value) => setField('holdingLengthYears', value)} suffix="years" />
                  <NumberField label="Cost to Sell" value={draftInputs.costToSell} onChange={(value) => setField('costToSell', value)} suffix="%" />
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Scenario Basis</div>
                    <div className="mt-3 space-y-1 text-sm text-slate-700">
                      <div>Initial Cash In: {formatCurrency(output.initialInvestment)}</div>
                      <div>Monthly Mortgage: {formatCurrency(output.mortgagePayment)}</div>
                      <div>Purchase Basis: {formatCurrency(output.purchaseBasis)}</div>
                    </div>
                  </div>
                </div>
              </div>
            </SectionCard>
          </div>

          <CalculatorResults output={output} />

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Expanded Analytics</div>
              <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">Additional Visualizations</h3>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">
                These are the same style of visual analytics used in the expanded property modal, driven by the calculator scenario above.
              </p>
            </div>
            <AdditionalAnalyticsChartsGrid
              avmGranularity={avmGranularity}
              avmRange={avmRange}
              avmPoints={output.avmPoints}
              avmLabels={output.avmLabels}
              chartData={output.chartData}
              analyticsGranularity={analyticsGranularity}
              taxHistoryRange={taxHistoryRange}
              taxHistorySeries={output.taxHistorySeries}
              mortgageAmortRange={mortgageAmortRange}
              onAnalyticsGranularityChange={setAnalyticsGranularity}
              onAvmGranularityChange={setAvmGranularity}
              onAvmRangeChange={setAvmRange}
              onTaxHistoryRangeChange={setTaxHistoryRange}
              onMortgageAmortRangeChange={setMortgageAmortRange}
            />
          </div>
        </div>
      </div>
    </ChartModal>
  );
}
