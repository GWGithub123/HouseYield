import React, { useEffect, useMemo, useState } from 'react';
import { AnalyticsCard, ChartModal, ExpandButton, SegmentedToggle } from '../charts/AnalyticsFrame';

type ChartVariant = 'overview' | 'card' | 'modal';
export type ProjectionGranularity = 'monthly' | 'quarterly' | 'annual';
export type TaxHistoryRange = '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | 'all';
export type AvmGranularity = 'quarterly' | 'annual';
export type MetricTimeframe = '6M' | '1Y' | '2Y' | '3Y' | '5Y' | '10Y' | '20Y' | '30Y';
type ExpandedChartKey =
  | 'priceHistory'
  | 'cashFlow'
  | 'taxHistory'
  | 'incomeExpenses'
  | 'cocReturn'
  | 'mortgageAmortization'
  | 'capRate'
  | 'noi'
  | 'equity'
  | 'totalReturn'
  | 'ratios'
  | 'irr';

export type PropertyAnalyticsMetricKey = ExpandedChartKey;
export type PropertyOverviewAssetId =
  | 'overview-price-history'
  | 'overview-cash-flow'
  | 'overview-tax-history'
  | 'tenant-correspondence-summary';

type MiniPoint = { x: number; y: number };

interface ExpenseBreakdownSeries {
  taxes: number[];
  insurance: number[];
  utilities: number[];
  hoa: number[];
  repairs: number[];
  management: number[];
  debtService: number[];
}

export interface PropertyAnalyticsChartData {
  projectionLabels: string[];
  mortgageLabels: string[];
  cashFlow: number[];
  annualIncome?: {
    gross: number[];
    collected: number[];
  };
  incomeExpenses: {
    income: number[];
    expenseBreakdown: ExpenseBreakdownSeries;
  };
  cocReturn: number[];
  capRate: number[];
  noi: number[];
  dscr: number[];
  mortgageAmortization: {
    principal: number[];
    interest: number[];
    loanBalance: number[];
  };
  propertyAppreciation: {
    loan: number[];
    equity: number[];
    value: number[];
  };
  totalReturn: {
    cumulative: number[];
  };
  rollingIrr: number[];
  irr?: number;
  breakEvenOccupancy: number;
  grm: number;
}

type RatioMarginMetricKey =
  | 'noiMargin'
  | 'operatingExpenseRatio'
  | 'cashFlowMargin'
  | 'collectionRate'
  | 'dscr'
  | 'breakEvenOccupancy';

type RatioMarginMetricConfig = {
  label: string;
  shortLabel: string;
  color: string;
  dataLabel: string;
  description: string;
  isPercentage: boolean;
  allowNegative?: boolean;
  auditKey?: string;
};

export interface TaxHistorySeries {
  values: number[];
  labels: string[];
}

interface PropertyOverviewAnalyticsGridProps {
  avmGranularity: AvmGranularity;
  avmRange: string;
  avmPoints: MiniPoint[];
  avmComparisonPoints?: MiniPoint[];
  avmLabels: string[];
  chartData: PropertyAnalyticsChartData | null;
  analyticsGranularity: ProjectionGranularity;
  propertyDashLoading: boolean;
  taxHistoryRange: TaxHistoryRange;
  taxHistorySeries: TaxHistorySeries;
  tenantCorrespondenceSummary: string[];
  summaryLoading: boolean;
  onAvmGranularityChange: (value: AvmGranularity) => void;
  onAvmRangeChange: (value: string) => void;
  onTaxHistoryRangeChange: (value: TaxHistoryRange) => void;
  onRefreshTenantSummary: () => void;
  onOpenMessaging?: () => void;
  hasCurrentTenant: boolean;
  compact?: boolean;
  dense?: boolean;
  focusAsset?: PropertyOverviewAssetId;
}

interface AdditionalAnalyticsChartsGridProps {
  avmGranularity: AvmGranularity;
  avmRange: string;
  avmPoints: MiniPoint[];
  avmComparisonPoints?: MiniPoint[];
  avmLabels: string[];
  chartData: PropertyAnalyticsChartData | null;
  analyticsGranularity: ProjectionGranularity;
  taxHistoryRange: TaxHistoryRange;
  taxHistorySeries: TaxHistorySeries;
  mortgageAmortRange: MetricTimeframe;
  onAnalyticsGranularityChange: (value: ProjectionGranularity) => void;
  onAvmGranularityChange: (value: AvmGranularity) => void;
  onAvmRangeChange: (value: string) => void;
  onTaxHistoryRangeChange: (value: TaxHistoryRange) => void;
  onMortgageAmortRangeChange: (value: MetricTimeframe) => void;
  /** Optional rental pricing power data for rent optimization projection lines */
  rentalPricingData?: {
    currentRent?: number;
    marketPotentialRent?: number;
    recommendedRent?: number;
    currentVacancyRate?: number;
    benchmarkVacancyRate?: number;
    recommendedVacancyRate?: number;
    projectedRentGrowth?: number;
    currentProjectedRentGrowth?: number;
    benchmarkProjectedRentGrowth?: number;
    recommendedProjectedRentGrowth?: number;
    annualRevenueUpside?: number;
    benchmarkAnnualRevenueUpside?: number;
    recommendedAnnualRevenueUpside?: number;
    pricingPowerScore?: number;
    customRent?: number;
    customVacancyRate?: number;
    customProjectedRentGrowth?: number;
    customAnnualRevenueUpside?: number;
  } | null;
  pricingProjectionMode?: 'none' | 'market' | 'recommended' | 'custom';
  optimizedChartData?: PropertyAnalyticsChartData | null;
  /** AI scenario overlay projections */
  aiScenarioChartData?: PropertyAnalyticsChartData | null;
  aiScenarioLabel?: string;
  /** Metric audit data for info popovers on each chart card */
  analyticsAudit?: Array<{
    key: string;
    title: string;
    result: string;
    formula: string;
    substitutions: string[];
  }>;
  metricFilter?: PropertyAnalyticsMetricKey[];
  showHeader?: boolean;
  dashboardCardMode?: boolean;
  /** Shorter cards that reflow into one grid, for embedding a filtered subset. */
  compact?: boolean;
}

const ALL_PROPERTY_ANALYTICS_METRICS: PropertyAnalyticsMetricKey[] = [
  'priceHistory',
  'cashFlow',
  'incomeExpenses',
  'taxHistory',
  'cocReturn',
  'mortgageAmortization',
  'capRate',
  'noi',
  'equity',
  'totalReturn',
  'ratios',
  'irr',
];

const RATIO_MARGIN_METRIC_CONFIG: Record<RatioMarginMetricKey, RatioMarginMetricConfig> = {
  noiMargin: {
    label: 'NOI Margin',
    shortLabel: 'NOI',
    color: '#0f766e',
    dataLabel: 'NOI Margin',
    description: 'NOI as a share of effective revenue',
    isPercentage: true,
  },
  operatingExpenseRatio: {
    label: 'OpEx Ratio',
    shortLabel: 'OpEx',
    color: '#dc2626',
    dataLabel: 'Operating Expense Ratio',
    description: 'Operating costs before debt service',
    isPercentage: true,
  },
  cashFlowMargin: {
    label: 'Cash Flow Margin',
    shortLabel: 'CF',
    color: '#2563eb',
    dataLabel: 'Cash Flow Margin',
    description: 'Free cash flow after debt service',
    isPercentage: true,
    allowNegative: true,
  },
  collectionRate: {
    label: 'Collection Rate',
    shortLabel: 'Collect',
    color: '#7c3aed',
    dataLabel: 'Collection Rate',
    description: 'Collected income versus gross billed income',
    isPercentage: true,
  },
  dscr: {
    label: 'DSCR',
    shortLabel: 'DSCR',
    color: '#ea580c',
    dataLabel: 'Debt Service Coverage',
    description: 'NOI divided by annual debt service',
    isPercentage: false,
    auditKey: 'dscr',
  },
  breakEvenOccupancy: {
    label: 'Break-Even Occupancy',
    shortLabel: 'B/E',
    color: '#0891b2',
    dataLabel: 'Break-Even Occupancy',
    description: 'Occupancy needed to cover all costs',
    isPercentage: true,
    auditKey: 'break-even',
  },
};

const RATIO_MARGIN_METRIC_OPTIONS = (Object.entries(RATIO_MARGIN_METRIC_CONFIG) as Array<[RatioMarginMetricKey, RatioMarginMetricConfig]>).map(([value, config]) => ({
  value,
  label: config.shortLabel,
}));

const DISPLAY_WINDOW: Record<ChartVariant, Record<ProjectionGranularity, number | null>> = {
  overview: {
    monthly: 15,
    quarterly: 15,
    annual: 10,
  },
  card: {
    monthly: 15,
    quarterly: 15,
    annual: 10,
  },
  modal: {
    monthly: 18,
    quarterly: 16,
    annual: null,
  },
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const METRIC_TIMEFRAME_OPTIONS: MetricTimeframe[] = ['6M', '1Y', '2Y', '3Y', '5Y', '10Y', '20Y', '30Y'];
const TIMEFRAME_MONTHS: Record<MetricTimeframe, number> = {
  '6M': 6,
  '1Y': 12,
  '2Y': 24,
  '3Y': 36,
  '5Y': 60,
  '10Y': 120,
  '20Y': 240,
  '30Y': 360,
};
const PROPERTY_ANALYTICS_CARD_CHART_HEIGHT = 340;
const PROPERTY_ANALYTICS_CARD_AXIS_FONT = 14;
const PROPERTY_ANALYTICS_CARD_PAD_BOTTOM = 46;
const PROPERTY_ANALYTICS_CARD_PRICE_HISTORY_PAD_BOTTOM = 76;

function getVisibleAxisIndices(length: number, maxLabels: number): number[] {
  if (length <= maxLabels) {
    return Array.from({ length }, (_, index) => index);
  }

  const indices = new Set<number>();
  for (let index = 0; index < maxLabels; index++) {
    indices.add(Math.round(((length - 1) * index) / (maxLabels - 1)));
  }

  return Array.from(indices).sort((left, right) => left - right);
}

function isYearOnlyLabels(labels: string[]): boolean {
  return labels.length > 0 && labels.every((label) => /^\d{4}$/.test(label.trim()));
}

function isQuarterlyLabels(labels: string[]): boolean {
  return labels.length > 0 && labels.every((label) => /^Q[1-4]\s+\d{4}$/.test(label.trim()));
}

function isMonthlyLabels(labels: string[]): boolean {
  return labels.length > 0 && labels.every((label) => /^[A-Za-z]{3}\s+\d{4}$/.test(label.trim()));
}

function getChartVisibleAxisIndices(labels: string[], maxLabels: number): number[] {
  if (isYearOnlyLabels(labels)) {
    return getVisibleAxisIndices(labels.length, maxLabels);
  }

  return getVisibleAxisIndices(labels.length, maxLabels);
}

function getPriceHistoryVisibleAxisIndices(labels: string[], maxLabels: number): number[] {
  if (!isQuarterlyLabels(labels)) {
    return getChartVisibleAxisIndices(labels, maxLabels);
  }

  if (labels.length <= maxLabels) {
    return Array.from({ length: labels.length }, (_, index) => index);
  }

  const indices = new Set<number>();
  const desiredStep = Math.max(1, Math.ceil((labels.length - 1) / Math.max(maxLabels - 1, 1)));
  const quarterStep = desiredStep <= 4 ? 4 : Math.ceil(desiredStep / 4) * 4;

  for (let index = 0; index < labels.length; index += quarterStep) {
    indices.add(index);
  }

  indices.add(labels.length - 1);
  return Array.from(indices).sort((left, right) => left - right);
}

function getNicePositiveTicks(minValue: number, maxValue: number, targetTickCount: number): { niceMin: number; niceMax: number; ticks: number[] } {
  const safeMin = Number.isFinite(minValue) ? minValue : 0;
  const safeMax = Number.isFinite(maxValue) ? maxValue : safeMin;
  const rawSpan = Math.max(safeMax - safeMin, Math.max(Math.abs(safeMax), 1) * 0.1, 1);
  const paddedMin = Math.max(0, safeMin - rawSpan * 0.08);
  const paddedMax = safeMax + rawSpan * 0.08;
  const roughStep = Math.max((paddedMax - paddedMin) / Math.max(targetTickCount - 1, 1), 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;

  let niceStep = magnitude;
  if (normalized > 1) niceStep = 2 * magnitude;
  if (normalized > 2) niceStep = 2.5 * magnitude;
  if (normalized > 2.5) niceStep = 5 * magnitude;
  if (normalized > 5) niceStep = 10 * magnitude;

  let niceMin = Math.floor(paddedMin / niceStep) * niceStep;
  let niceMax = Math.ceil(paddedMax / niceStep) * niceStep;

  if (niceMin === niceMax) {
    niceMax = niceMin + niceStep;
  }

  const tickCount = Math.max(2, Math.round((niceMax - niceMin) / niceStep) + 1);
  const ticks = Array.from({ length: tickCount }, (_, index) => niceMin + index * niceStep);

  return { niceMin, niceMax, ticks };
}

function getAxisLabelCount(labels: string[], variant: ChartVariant, innerWidth: number): number {
  if (variant === 'overview') {
    if (isMonthlyLabels(labels) || isQuarterlyLabels(labels)) return Math.min(labels.length, 6);
    if (isYearOnlyLabels(labels)) return Math.min(labels.length, 6);
    return Math.min(labels.length, 6);
  }

  if (variant === 'card') {
    if (isMonthlyLabels(labels) || isQuarterlyLabels(labels)) return Math.min(labels.length, 8);
    if (isYearOnlyLabels(labels)) return labels.length;
    return Math.min(labels.length, 8);
  }

  if (isMonthlyLabels(labels)) {
    return Math.min(labels.length, Math.max(10, Math.floor(innerWidth / 150)));
  }

  if (isQuarterlyLabels(labels)) {
    return Math.min(labels.length, Math.max(12, Math.floor(innerWidth / 120)));
  }

  if (isYearOnlyLabels(labels)) {
    return Math.min(labels.length, Math.max(12, Math.floor(innerWidth / 96)));
  }

  return Math.min(labels.length, Math.max(10, Math.floor(innerWidth / 120)));
}

function shouldRotateAxisLabels(labels: string[], variant: ChartVariant): boolean {
  if (variant === 'modal') {
    return labels.length > 6;
  }

  if (variant === 'overview') {
    if (isYearOnlyLabels(labels)) {
      return false;
    }

    return labels.length > 5;
  }

  if (isYearOnlyLabels(labels)) {
    return labels.length > 7;
  }

  return true;
}

function formatTooltipCurrency(value: number): string {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue >= 1_000_000_000) {
    return `${sign}$${(absValue / 1_000_000_000).toFixed(absValue >= 10_000_000_000 ? 0 : 2)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(absValue >= 10_000_000 ? 0 : 2)}MM`;
  }
  if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(absValue >= 10_000 ? 0 : 1)}k`;
  }

  return `${sign}$${absValue.toFixed(0)}`;
}

function formatAxisCurrency(value: number): string {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue >= 1_000_000_000) {
    return `${sign}$${(absValue / 1_000_000_000).toFixed(absValue >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(absValue >= 10_000_000 ? 0 : 1)}MM`;
  }
  if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(absValue >= 10_000 ? 0 : 1)}k`;
  }

  return `${sign}$${absValue.toFixed(0)}`;
}

function formatPriceHistoryAxisCurrency(value: number): string {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue >= 1_000_000_000) {
    return `${sign}$${(absValue / 1_000_000_000).toFixed(2)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(2)}MM`;
  }
  if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(2)}k`;
  }

  return `${sign}$${absValue.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function hasMeaningfulSeries(values?: number[] | null): values is number[] {
  return Array.isArray(values) && values.some((value) => Math.abs(value) > 1e-6);
}

function safeRatio(numerator: number, denominator: number, multiplier: number = 1): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return 0;
  }

  return (numerator / denominator) * multiplier;
}

function buildConstantSeries(value: number, length: number): number[] {
  return Array.from({ length }, () => value);
}

function buildRatioMarginSeriesSet(chartData: PropertyAnalyticsChartData | null | undefined): Record<RatioMarginMetricKey, number[]> | null {
  if (!chartData) return null;

  const labelsLength = chartData.projectionLabels.length;
  const revenueSeries = chartData.incomeExpenses.income;
  const expenseBreakdown = chartData.incomeExpenses.expenseBreakdown;
  const operatingExpenseSeries = Array.from({ length: labelsLength }, (_, index) => (
    (expenseBreakdown.taxes[index] || 0)
    + (expenseBreakdown.insurance[index] || 0)
    + (expenseBreakdown.utilities[index] || 0)
    + (expenseBreakdown.hoa[index] || 0)
    + (expenseBreakdown.repairs[index] || 0)
    + (expenseBreakdown.management[index] || 0)
  ));
  const grossIncomeSeries = chartData.annualIncome?.gross?.length === labelsLength
    ? chartData.annualIncome.gross
    : revenueSeries;
  const collectedIncomeSeries = chartData.annualIncome?.collected?.length === labelsLength
    ? chartData.annualIncome.collected
    : revenueSeries;

  return {
    noiMargin: revenueSeries.map((revenue, index) => safeRatio(chartData.noi[index] || 0, revenue, 100)),
    operatingExpenseRatio: revenueSeries.map((revenue, index) => safeRatio(operatingExpenseSeries[index] || 0, revenue, 100)),
    cashFlowMargin: revenueSeries.map((revenue, index) => safeRatio(chartData.cashFlow[index] || 0, revenue, 100)),
    collectionRate: grossIncomeSeries.map((grossIncome, index) => Math.min(Math.max(safeRatio(collectedIncomeSeries[index] || 0, grossIncome, 100), 0), 100)),
    dscr: chartData.dscr,
    breakEvenOccupancy: buildConstantSeries(chartData.breakEvenOccupancy, labelsLength),
  };
}

function windowRatioMetricSeries(chartData: PropertyAnalyticsChartData | null | undefined, metric: RatioMarginMetricKey, granularity: ProjectionGranularity, variant: ChartVariant) {
  if (!chartData) return null;

  const seriesSet = buildRatioMarginSeriesSet(chartData);
  if (!seriesSet) return null;

  return windowSeries(seriesSet[metric], chartData.projectionLabels, granularity, variant);
}

function windowRatioMetricSeriesByTimeframe(chartData: PropertyAnalyticsChartData | null | undefined, metric: RatioMarginMetricKey, granularity: ProjectionGranularity, timeframe: MetricTimeframe) {
  if (!chartData) return null;

  const seriesSet = buildRatioMarginSeriesSet(chartData);
  if (!seriesSet) return null;

  return windowSeriesByTimeframe(seriesSet[metric], chartData.projectionLabels, granularity, timeframe);
}

function formatRatioMetricValue(config: RatioMarginMetricConfig, value: number): string {
  if (config.isPercentage) {
    return formatPercent(value);
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)}x`;
}

function formatAxisLabel(label: string, variant: ChartVariant): string {
  const quarterMatch = label.match(/^Q([1-4])\s+(\d{4})$/);
  if (quarterMatch) {
    return `Q${quarterMatch[1]} '${quarterMatch[2].slice(-2)}`;
  }

  const monthMatch = label.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (monthMatch) {
    return `${monthMatch[1]} '${monthMatch[2].slice(-2)}`;
  }

  return label;
}

function buildHoldingPeriodLabels(totalPeriods: number, granularity: ProjectionGranularity): string[] {
  const suffix = granularity === 'monthly' ? 'M' : granularity === 'quarterly' ? 'Q' : 'Y';
  return Array.from({ length: totalPeriods }, (_, index) => `${index + 1}${suffix}`);
}

function buildProjectionLabels(totalPeriods: number, granularity: ProjectionGranularity, startYear: number = new Date().getFullYear()): string[] {
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

function windowSeries<T>(values: T[], labels: string[], granularity: ProjectionGranularity, variant: ChartVariant): { values: T[]; labels: string[] } {
  const limit = DISPLAY_WINDOW[variant][granularity];
  if (!limit || values.length <= limit) {
    return { values, labels };
  }

  return {
    values: values.slice(0, limit),
    labels: labels.slice(0, limit),
  };
}

function getTimeframePeriods(timeframe: MetricTimeframe, granularity: ProjectionGranularity): number {
  const months = TIMEFRAME_MONTHS[timeframe];

  if (granularity === 'monthly') return Math.max(1, months);
  if (granularity === 'quarterly') return Math.max(1, Math.round(months / 3));
  return Math.max(1, Math.round(months / 12));
}

function windowSeriesByTimeframe<T>(values: T[], labels: string[], granularity: ProjectionGranularity, timeframe: MetricTimeframe): { values: T[]; labels: string[] } {
  const limit = getTimeframePeriods(timeframe, granularity);
  return {
    values: values.slice(0, limit),
    labels: labels.slice(0, limit),
  };
}

function scaleTickTarget(maxValue: number, allowNegative: boolean, minValue: number = 0): { niceMin: number; niceMax: number; ticks: number[] } {
  const posExtent = Math.max(0, maxValue);
  const negExtent = allowNegative ? Math.max(0, -minValue) : 0;

  const niceStep = (target: number) => {
    if (target <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    const steps = [1, 2, 2.5, 5, 7.5, 10];
    for (const step of steps) {
      const candidate = step * magnitude;
      if (candidate >= target) return candidate;
    }
    return target;
  };

  let stepGuess = niceStep(Math.max((posExtent + negExtent) / 5, 1e-6));
  let negativeSteps = 0;
  for (let iteration = 0; iteration < 12; iteration++) {
    negativeSteps = Math.min(5, Math.ceil(negExtent / stepGuess));
    const neededAbove = Math.ceil(posExtent / stepGuess);
    if ((5 - negativeSteps) < neededAbove) {
      stepGuess = niceStep(stepGuess * 1.1);
      continue;
    }
    break;
  }

  const niceMin = -negativeSteps * stepGuess;
  const niceMax = (5 - negativeSteps) * stepGuess;
  const ticks = Array.from({ length: 6 }, (_, index) => niceMin + (niceMax - niceMin) * (index / 5));

  return { niceMin, niceMax, ticks };
}

function AnalyticsGranularityToggle({ value, onChange }: { value: ProjectionGranularity; onChange: (value: ProjectionGranularity) => void }) {
  return (
    <SegmentedToggle
      value={value}
      onChange={onChange}
      options={[
        { value: 'monthly', label: 'Monthly' },
        { value: 'quarterly', label: 'Quarterly' },
        { value: 'annual', label: 'Annually' },
      ]}
    />
  );
}

function hasAlignedPriceHistoryComparison(points: MiniPoint[], comparisonPoints?: MiniPoint[]): comparisonPoints is MiniPoint[] {
  return Array.isArray(comparisonPoints) && comparisonPoints.length === points.length && comparisonPoints.length > 1;
}

function PriceHistoryComparisonToggle({
  value,
  onChange,
  compact = false,
  sidebarGlass = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
  sidebarGlass?: boolean;
}) {
  const className = sidebarGlass
    ? `analytics-glass-info-btn inline-flex items-center gap-2 rounded-lg border border-white/15 ${value ? 'bg-[#2a5080]/75 text-white' : 'bg-[#1a3a5c]/50 text-white/85'} px-3 py-2 text-sm font-semibold transition-colors backdrop-blur-sm hover:bg-[#2a5080]/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40`
    : `inline-flex items-center gap-2 rounded-xl border px-${compact ? '2.5' : '3'} py-${compact ? '1.5' : '2'} ${compact ? 'text-[11px]' : 'text-sm'} font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-200 ${value ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-800'}`;

  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      className={className}
      title="Toggle area mean AVM comparison overlay"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${value ? (sidebarGlass ? 'bg-emerald-300' : 'bg-sky-500') : (sidebarGlass ? 'bg-white/35' : 'bg-slate-300')}`} />
      Market Comparison
    </button>
  );
}

function PriceHistoryChart({
  points,
  comparisonPoints,
  labels,
  variant = 'card',
}: {
  points: MiniPoint[];
  comparisonPoints?: MiniPoint[];
  labels: string[];
  variant?: ChartVariant;
}) {
  const chartId = React.useId().replace(/:/g, '');
  const isOverview = variant === 'overview';
  const isCard = variant === 'card';

  if (!points.length) {
    return <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No price history data</div>;
  }

  const width = isOverview ? 560 : isCard ? 620 : 1540;
  const height = isOverview ? 290 : isCard ? PROPERTY_ANALYTICS_CARD_CHART_HEIGHT : 760;
  const padL = isOverview ? 52 : isCard ? 72 : 76;
  const padR = isOverview ? 12 : 20;
  const padT = isOverview ? 10 : isCard ? 12 : 18;
  const padB = isOverview ? 38 : isCard ? PROPERTY_ANALYTICS_CARD_PRICE_HISTORY_PAD_BOTTOM : 100;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const axisFontSize = isOverview ? 11 : isCard ? PROPERTY_ANALYTICS_CARD_AXIS_FONT : 20;

  const yValues = points.map((point) => point.y);
  const hasComparison = hasAlignedPriceHistoryComparison(points, comparisonPoints);
  const comparisonYValues = hasComparison ? comparisonPoints.map((point) => point.y) : [];
  const minRaw = Math.min(...yValues, ...(hasComparison ? comparisonYValues : []));
  const maxRaw = Math.max(...yValues, ...(hasComparison ? comparisonYValues : []));
  const tickTarget = isOverview ? 4 : isCard ? 5 : 7;
  const { niceMin: yMin, niceMax: yMax, ticks } = getNicePositiveTicks(minRaw, maxRaw, tickTarget);

  const xScale = (index: number) => (points.length === 1 ? padL + innerW / 2 : padL + (index / (points.length - 1)) * innerW);
  const yScale = (value: number) => padT + innerH - ((value - yMin) / (yMax - yMin)) * innerH;

  const visibleIndices = getPriceHistoryVisibleAxisIndices(labels, getAxisLabelCount(labels, variant, innerW));
  const rotateLabels = shouldRotateAxisLabels(labels, variant);
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xScale(index)},${yScale(point.y)}`).join(' ');
  const areaPath = `${linePath} L${xScale(points.length - 1)},${yScale(yMin)} L${xScale(0)},${yScale(yMin)} Z`;
  const comparisonLinePath = hasComparison
    ? comparisonPoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${xScale(index)},${yScale(point.y)}`).join(' ')
    : '';
  const fillSegments = hasComparison
    ? points.slice(0, -1).flatMap((point, index) => {
        const nextPoint = points[index + 1];
        const comparisonPoint = comparisonPoints[index];
        const nextComparisonPoint = comparisonPoints[index + 1];
        const gap = comparisonPoint.y - point.y;
        const nextGap = nextComparisonPoint.y - nextPoint.y;
        const x1 = xScale(index);
        const x2 = xScale(index + 1);
        const subjectY1 = yScale(point.y);
        const subjectY2 = yScale(nextPoint.y);
        const comparisonY1 = yScale(comparisonPoint.y);
        const comparisonY2 = yScale(nextComparisonPoint.y);

        if (gap === 0 && nextGap === 0) {
          return [];
        }

        if (gap === 0 || nextGap === 0 || Math.sign(gap) === Math.sign(nextGap)) {
          return [{
            key: `segment-${index}`,
            fill: gap >= 0 ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.16)',
            path: `M${x1},${subjectY1} L${x2},${subjectY2} L${x2},${comparisonY2} L${x1},${comparisonY1} Z`,
          }];
        }

        const denominator = gap - nextGap;
        const intersectionRatio = denominator === 0 ? 0.5 : gap / denominator;
        const clampedRatio = Math.min(1, Math.max(0, intersectionRatio));
        const crossoverX = x1 + (x2 - x1) * clampedRatio;
        const crossoverSubjectY = subjectY1 + (subjectY2 - subjectY1) * clampedRatio;
        const crossoverComparisonY = comparisonY1 + (comparisonY2 - comparisonY1) * clampedRatio;
        const crossoverY = (crossoverSubjectY + crossoverComparisonY) / 2;
        const firstIsPositive = gap > 0;

        return [
          {
            key: `segment-${index}-a`,
            fill: firstIsPositive ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.16)',
            path: `M${x1},${subjectY1} L${crossoverX},${crossoverSubjectY} L${crossoverX},${crossoverY} L${x1},${comparisonY1} Z`,
          },
          {
            key: `segment-${index}-b`,
            fill: firstIsPositive ? 'rgba(239,68,68,0.16)' : 'rgba(34,197,94,0.18)',
            path: `M${crossoverX},${crossoverSubjectY} L${x2},${subjectY2} L${x2},${comparisonY2} L${crossoverX},${crossoverY} Z`,
          },
        ];
      })
    : [];
  const latestPoint = points[points.length - 1];
  const latestComparisonPoint = hasComparison ? comparisonPoints[comparisonPoints.length - 1] : null;
  const latestComparisonGap = latestComparisonPoint ? latestComparisonPoint.y - latestPoint.y : null;
  const latestComparisonPercent = latestComparisonPoint && latestComparisonGap != null && latestComparisonPoint.y > 0
    ? (latestComparisonGap / latestComparisonPoint.y) * 100
    : null;

  return (
    <div className="h-full w-full overflow-visible">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id={`${chartId}-price-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.07" />
          </linearGradient>
        </defs>
        {ticks.map((tick, index) => (
          <line key={`grid-${index}`} x1={padL} x2={padL + innerW} y1={yScale(tick)} y2={yScale(tick)} stroke="rgba(148,163,184,0.28)" strokeWidth={1} strokeDasharray="4 4" />
        ))}
        <line x1={padL} x2={padL} y1={padT} y2={padT + innerH} stroke="rgba(148,163,184,0.45)" strokeWidth={1} />
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="rgba(148,163,184,0.45)" strokeWidth={1} />
        {hasComparison
          ? fillSegments.map((segment) => (
              <path key={segment.key} d={segment.path} fill={segment.fill} />
            ))
          : <path d={areaPath} fill={`url(#${chartId}-price-area)`} />}
        {hasComparison ? (
          <>
            <path d={comparisonLinePath} fill="none" stroke="#7c3aed" strokeWidth={isOverview ? 2.2 : isCard ? 2.8 : 3.6} strokeLinecap="round" strokeLinejoin="round" />
            <path d={linePath} fill="none" stroke="#0f766e" strokeWidth={isOverview ? 2.5 : isCard ? 3 : 4} strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : (
          <path d={linePath} fill="none" stroke="#15803d" strokeWidth={isOverview ? 2.4 : isCard ? 3 : 4} strokeLinecap="round" strokeLinejoin="round" />
        )}
        {points.length < 120 && points.map((point, index) => (
          <circle key={index} cx={xScale(index)} cy={yScale(point.y)} r={isOverview ? 2.2 : isCard ? 2.8 : 4} fill={hasComparison ? '#0f766e' : '#15803d'} fillOpacity={0.18} />
        ))}
        {hasComparison && comparisonPoints.length < 120 && comparisonPoints.map((point, index) => (
          <circle key={`comparison-${index}`} cx={xScale(index)} cy={yScale(point.y)} r={isOverview ? 2.1 : isCard ? 2.6 : 3.6} fill="#7c3aed" fillOpacity={0.18} />
        ))}
        {ticks.map((tick, index) => (
          <text key={`tick-${index}`} x={padL - 10} y={yScale(tick) + 5} textAnchor="end" fontSize={axisFontSize} fill="#94a3b8" fontWeight="600">
            {formatPriceHistoryAxisCurrency(tick)}
          </text>
        ))}
        {hasComparison ? (
          <>
            <circle cx={padL + 6} cy={padT + 12} r={isOverview ? 3 : 4} fill="#0f766e" />
            <text x={padL + 16} y={padT + 16} fontSize={isOverview ? 10 : isCard ? 11 : 18} fill="#0f172a" fontWeight="700">
              Subject AVM
            </text>
            <circle cx={padL + (isOverview ? 104 : isCard ? 120 : 156)} cy={padT + 12} r={isOverview ? 3 : 4} fill="#7c3aed" />
            <text x={padL + (isOverview ? 114 : isCard ? 130 : 166)} y={padT + 16} fontSize={isOverview ? 10 : isCard ? 11 : 18} fill="#0f172a" fontWeight="700">
              Area mean AVM
            </text>
            {latestComparisonPercent != null ? (
              <text
                x={padL + innerW}
                y={padT + 16}
                textAnchor="end"
                fontSize={isOverview ? 10 : isCard ? 12 : 18}
                fill={latestComparisonGap != null && latestComparisonGap >= 0 ? '#15803d' : '#dc2626'}
                fontWeight="800"
              >
                {`${latestComparisonGap != null && latestComparisonGap >= 0 ? '+' : '-'}${Math.abs(latestComparisonPercent).toFixed(1)}% vs mean`}
              </text>
            ) : null}
          </>
        ) : null}
        {visibleIndices.map((index) => {
          const x = xScale(index);
          const y = padT + innerH + (rotateLabels ? (isOverview ? 16 : isCard ? 20 : 24) : (isOverview ? 12 : isCard ? 14 : 18));
          return (
            <text
              key={`x-${index}`}
              x={x}
              y={y}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              fontSize={axisFontSize}
              fill="#94a3b8"
              fontWeight="600"
              dominantBaseline="hanging"
              transform={rotateLabels ? `rotate(-34 ${x} ${y})` : undefined}
            >
              {formatAxisLabel(labels[index], variant)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function ProfessionalBarChart({
  data,
  labels,
  color,
  dataLabel,
  secondaryData,
  secondaryColor,
  secondaryLabel,
  tertiaryData,
  tertiaryColor,
  tertiaryLabel,
  dataInThousands = false,
  isCurrency = true,
  isPercentage = false,
  allowNegative = false,
  stackFirstTwo = false,
  useDualAxis = false,
  tertiaryAsLine = false,
  variant = 'card',
}: {
  data: number[];
  labels: string[];
  color: string;
  dataLabel: string;
  secondaryData?: number[];
  secondaryColor?: string;
  secondaryLabel?: string;
  tertiaryData?: number[];
  tertiaryColor?: string;
  tertiaryLabel?: string;
  dataInThousands?: boolean;
  isCurrency?: boolean;
  isPercentage?: boolean;
  allowNegative?: boolean;
  stackFirstTwo?: boolean;
  useDualAxis?: boolean;
  tertiaryAsLine?: boolean;
  variant?: ChartVariant;
}) {
  const chartId = React.useId().replace(/:/g, '');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const isOverview = variant === 'overview';
  const isCard = variant === 'card';

  const height = isOverview ? 290 : isCard ? PROPERTY_ANALYTICS_CARD_CHART_HEIGHT : 760;
  const padL = isOverview ? 48 : isCard ? 58 : 56;
  const padR = useDualAxis ? (isOverview ? 58 : isCard ? 70 : 72) : (isOverview ? 10 : isCard ? 10 : 8);
  const padT = isOverview ? 10 : isCard ? 12 : 18;
  const padB = isOverview ? 40 : isCard ? PROPERTY_ANALYTICS_CARD_PAD_BOTTOM : 60;
  const baseWidth = isOverview ? 560 : isCard ? 620 : 1540;
  const modalMinGroupWidth = stackFirstTwo ? 18 : secondaryData || tertiaryData ? 18 : 9;
  const width = variant !== 'modal'
    ? baseWidth
    : Math.max(baseWidth, padL + padR + data.length * modalMinGroupWidth + Math.max(data.length - 1, 0) * 4);
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const axisFontSize = isOverview ? 11 : isCard ? PROPERTY_ANALYTICS_CARD_AXIS_FONT : 19;
  const labelCount = getAxisLabelCount(labels, variant, innerW);

  let primaryMax = Math.max(...data, ...(secondaryData || []), 0);
  let primaryMin = allowNegative ? Math.min(...data, ...(secondaryData || []), 0) : 0;

  if (stackFirstTwo && secondaryData) {
    const stacked = data.map((value, index) => value + (secondaryData[index] || 0));
    primaryMax = Math.max(...stacked, ...(tertiaryData || []), 0);
    primaryMin = allowNegative ? Math.min(...stacked, ...(tertiaryData || []), 0) : 0;
  }

  const { niceMin, niceMax, ticks } = scaleTickTarget(primaryMax * 1.04, allowNegative, primaryMin);
  const zeroY = padT + innerH - ((0 - niceMin) / (niceMax - niceMin)) * innerH;

  let tertiaryNiceMax = 0;
  const tertiaryTicks: number[] = [];
  if (useDualAxis && tertiaryData?.length) {
    const maxTertiary = Math.max(...tertiaryData, 0);
    tertiaryNiceMax = scaleTickTarget(maxTertiary * 1.04, false, 0).niceMax;
    for (let index = 0; index < 6; index++) {
      tertiaryTicks.push((tertiaryNiceMax * index) / 5);
    }
  }

  const gap = isOverview ? 6 : isCard ? 8 : 4;
  const groupWidth = data.length > 0 ? (innerW - gap * Math.max(data.length - 1, 0)) / data.length : innerW;
  const barCount = stackFirstTwo ? (tertiaryData && !tertiaryAsLine ? 2 : 1) : 1 + (secondaryData ? 1 : 0) + (tertiaryData && !tertiaryAsLine ? 1 : 0);
  const barGap = variant === 'card' ? 3 : 3;
  const barWidth = Math.min((groupWidth - barGap * Math.max(barCount - 1, 0)) / Math.max(barCount, 1), isOverview ? 26 : isCard ? 36 : 48);
  const contentWidth = barWidth * barCount + barGap * Math.max(barCount - 1, 0);
  const visibleIndices = getChartVisibleAxisIndices(labels, labelCount);
  const rotateLabels = shouldRotateAxisLabels(labels, variant);

  const formatValue = (value: number) => {
    if (isPercentage) return formatPercent(value);
    if (!isCurrency) return value.toFixed(2);
    return formatTooltipCurrency(dataInThousands ? value * 1000 : value);
  };

  const formatAxis = (value: number) => {
    if (isPercentage) return `${value.toFixed(0)}%`;
    if (!isCurrency) return value.toFixed(0);
    return formatAxisCurrency(dataInThousands ? value * 1000 : value);
  };

  return (
    <div className={`relative h-full w-full ${variant === 'modal' ? 'overflow-x-auto overflow-y-hidden' : ''}`}>
      <svg viewBox={`0 0 ${width} ${height}`} className={variant === 'modal' ? 'block h-full min-w-full w-auto' : 'h-full w-full'}>
        <defs>
          <linearGradient id={`${chartId}-primary`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.76" />
          </linearGradient>
          <linearGradient id={`${chartId}-secondary`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={secondaryColor || '#10b981'} stopOpacity="1" />
            <stop offset="100%" stopColor={secondaryColor || '#10b981'} stopOpacity="0.76" />
          </linearGradient>
          <linearGradient id={`${chartId}-tertiary`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tertiaryColor || '#f59e0b'} stopOpacity="1" />
            <stop offset="100%" stopColor={tertiaryColor || '#f59e0b'} stopOpacity="0.78" />
          </linearGradient>
        </defs>
        {ticks.map((tick, index) => {
          const y = padT + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return <line key={`grid-${index}`} x1={padL} x2={padL + innerW} y1={y} y2={y} stroke="rgba(148,163,184,0.28)" strokeWidth={1} strokeDasharray="4 4" />;
        })}
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="rgba(148,163,184,0.45)" strokeWidth={1} />
        {allowNegative && niceMin < 0 && niceMax > 0 && <line x1={padL} x2={padL + innerW} y1={zeroY} y2={zeroY} stroke="#94a3b8" strokeWidth={1.3} />}

        {data.map((value, index) => {
          const xGroup = padL + index * (groupWidth + gap) + Math.max((groupWidth - contentWidth) / 2, 0);
          const yForValue = (seriesValue: number, rangeMin: number, rangeMax: number) => padT + innerH - ((seriesValue - rangeMin) / (rangeMax - rangeMin)) * innerH;
          const hovered = hoveredIndex === index;
          const highlightWidth = Math.max(contentWidth + 10, barWidth + 10);

          if (stackFirstTwo && secondaryData && useDualAxis) {
            const primaryValue = value;
            const secondaryValue = secondaryData[index] || 0;
            const total = primaryValue + secondaryValue;
            const primaryHeight = total > 0 ? (primaryValue / total) * innerH : 0;
            const secondaryHeight = total > 0 ? (secondaryValue / total) * innerH : 0;
            const secondaryY = padT + innerH - secondaryHeight;

            return (
              <g key={index}>
                {hovered && <rect x={xGroup - 5} y={padT - 2} width={highlightWidth} height={innerH + 8} rx={12} fill="rgba(99,102,241,0.10)" opacity="0.9" />}
                <rect x={xGroup} y={secondaryY} width={barWidth} height={secondaryHeight} rx={Math.min(6, barWidth / 2.5)} fill={`url(#${chartId}-secondary)`} opacity={hovered ? 1 : 0.9} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />
                <rect x={xGroup} y={padT} width={barWidth} height={primaryHeight} rx={Math.min(6, barWidth / 2.5)} fill={`url(#${chartId}-primary)`} opacity={hovered ? 1 : 0.9} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />
              </g>
            );
          }

          if (stackFirstTwo && secondaryData) {
            const primaryY = yForValue(value, niceMin, niceMax);
            const secondaryY = yForValue(value + (secondaryData[index] || 0), niceMin, niceMax);
            const primaryHeight = Math.abs(primaryY - zeroY);
            const secondaryHeight = Math.abs(secondaryY - primaryY);

            return (
              <g key={index}>
                {hovered && <rect x={xGroup - 5} y={padT - 2} width={highlightWidth + barWidth + barGap} height={innerH + 8} rx={12} fill="rgba(99,102,241,0.10)" opacity="0.9" />}
                <rect x={xGroup} y={Math.min(primaryY, zeroY)} width={barWidth} height={primaryHeight} rx={Math.min(6, barWidth / 2.5)} fill={`url(#${chartId}-primary)`} opacity={hovered ? 1 : 0.9} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />
                <rect x={xGroup} y={secondaryY} width={barWidth} height={secondaryHeight} rx={Math.min(6, barWidth / 2.5)} fill={`url(#${chartId}-secondary)`} opacity={hovered ? 1 : 0.9} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />
                {tertiaryData && !tertiaryAsLine && (
                  <rect
                    x={xGroup + barWidth + barGap}
                    y={useDualAxis ? yForValue(tertiaryData[index], 0, tertiaryNiceMax) : yForValue(tertiaryData[index], niceMin, niceMax)}
                    width={barWidth}
                    height={Math.abs((useDualAxis ? yForValue(0, 0, tertiaryNiceMax) : zeroY) - (useDualAxis ? yForValue(tertiaryData[index], 0, tertiaryNiceMax) : yForValue(tertiaryData[index], niceMin, niceMax)))}
                    rx={Math.min(6, barWidth / 2.5)}
                    fill={`url(#${chartId}-tertiary)`}
                    opacity={hovered ? 1 : 0.9}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  />
                )}
              </g>
            );
          }

          return (
            <g key={index}>
              {hovered && <rect x={xGroup - 5} y={padT - 2} width={Math.max(groupWidth + 10, highlightWidth)} height={innerH + 8} rx={12} fill="rgba(99,102,241,0.10)" opacity="0.9" />}
              <rect
                x={xGroup}
                y={Math.min(yForValue(value, niceMin, niceMax), zeroY)}
                width={barWidth}
                height={Math.abs(yForValue(value, niceMin, niceMax) - zeroY)}
                rx={Math.min(6, barWidth / 2.5)}
                fill={`url(#${chartId}-primary)`}
                opacity={hovered ? 1 : 0.9}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
              {secondaryData && (
                <rect
                  x={xGroup + barWidth + barGap}
                  y={Math.min(yForValue(secondaryData[index] || 0, niceMin, niceMax), zeroY)}
                  width={barWidth}
                  height={Math.abs(yForValue(secondaryData[index] || 0, niceMin, niceMax) - zeroY)}
                  rx={Math.min(6, barWidth / 2.5)}
                  fill={`url(#${chartId}-secondary)`}
                  opacity={hovered ? 1 : 0.9}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              )}
              {tertiaryData && !tertiaryAsLine && (
                <rect
                  x={xGroup + (barWidth + barGap) * (secondaryData ? 2 : 1)}
                  y={Math.min((useDualAxis ? padT + innerH - ((tertiaryData[index] || 0) / tertiaryNiceMax) * innerH : yForValue(tertiaryData[index] || 0, niceMin, niceMax)), useDualAxis ? padT + innerH : zeroY)}
                  width={barWidth}
                  height={Math.abs((useDualAxis ? padT + innerH : zeroY) - (useDualAxis ? padT + innerH - ((tertiaryData[index] || 0) / tertiaryNiceMax) * innerH : yForValue(tertiaryData[index] || 0, niceMin, niceMax)))}
                  rx={Math.min(6, barWidth / 2.5)}
                  fill={`url(#${chartId}-tertiary)`}
                  opacity={hovered ? 1 : 0.9}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              )}
            </g>
          );
        })}

        {useDualAxis && tertiaryAsLine && tertiaryData && tertiaryNiceMax > 0 && (
          <>
            <path
              d={tertiaryData.map((value, index) => {
                const x = padL + index * (groupWidth + gap) + groupWidth / 2;
                const y = padT + innerH - (value / tertiaryNiceMax) * innerH;
                return `${index === 0 ? 'M' : 'L'}${x},${y}`;
              }).join(' ')}
              stroke={tertiaryColor || '#f59e0b'}
              strokeWidth={isOverview ? 2.4 : isCard ? 3 : 4}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {tertiaryData.map((value, index) => {
              const x = padL + index * (groupWidth + gap) + groupWidth / 2;
              const y = padT + innerH - (value / tertiaryNiceMax) * innerH;
              return <circle key={`line-${index}`} cx={x} cy={y} r={isOverview ? 3 : isCard ? 4 : 5} fill={tertiaryColor || '#f59e0b'} stroke="#ffffff" strokeWidth={2} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />;
            })}
          </>
        )}

        {ticks.map((tick, index) => {
          const y = padT + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <text key={`left-${index}`} x={padL - 9} y={y + 5} textAnchor="end" fontSize={axisFontSize} fill="#94a3b8" fontWeight="600">
              {formatAxis(tick)}
            </text>
          );
        })}

        {useDualAxis && tertiaryTicks.map((tick, index) => {
          const y = padT + innerH - (tick / tertiaryNiceMax) * innerH;
          return (
            <text key={`right-${index}`} x={padL + innerW + 9} y={y + 5} textAnchor="start" fontSize={axisFontSize} fill="#94a3b8" fontWeight="600">
              {formatAxis(tick)}
            </text>
          );
        })}

        {visibleIndices.map((index) => {
          const x = padL + index * (groupWidth + gap) + groupWidth / 2;
          const y = padT + innerH + (rotateLabels ? (isOverview ? 16 : isCard ? 20 : 24) : (isOverview ? 12 : isCard ? 14 : 18));
          return (
            <text
              key={`x-${index}`}
              x={x}
              y={y}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              fontSize={axisFontSize}
              fill="#94a3b8"
              fontWeight="600"
              dominantBaseline="hanging"
              transform={rotateLabels ? `rotate(-34 ${x} ${y})` : undefined}
            >
              {formatAxisLabel(labels[index], variant)}
            </text>
          );
        })}
      </svg>

      {hoveredIndex !== null && (() => {
        const barCenterX = padL + hoveredIndex * (groupWidth + gap) + groupWidth / 2;
        const pct = (barCenterX / width) * 100;
        const isRightHalf = hoveredIndex >= data.length / 2;
        return (
          <div
            className="pointer-events-none absolute top-4 z-20 rounded-lg border border-slate-700/40 bg-slate-900/95 px-3.5 py-2.5 text-sm text-white shadow-xl backdrop-blur-sm"
            style={isRightHalf ? { right: `${100 - pct + 3}%` } : { left: `${pct + 3}%` }}
          >
            <div className="mb-1 font-semibold text-slate-100">{labels[hoveredIndex]}</div>
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: color }} />
              <span className="text-slate-300">{dataLabel}:</span>
              <span className="font-medium">{formatValue(data[hoveredIndex])}</span>
            </div>
            {secondaryData && secondaryColor && secondaryLabel && (
              <div className="mt-0.5 flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: secondaryColor }} />
                <span className="text-slate-300">{secondaryLabel}:</span>
                <span className="font-medium">{formatValue(secondaryData[hoveredIndex])}</span>
              </div>
            )}
            {tertiaryData && tertiaryColor && tertiaryLabel && (
              <div className="mt-0.5 flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: tertiaryColor }} />
                <span className="text-slate-300">{tertiaryLabel}:</span>
                <span className="font-medium">{formatValue(tertiaryData[hoveredIndex])}</span>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function ProfessionalLineChart({
  data,
  labels,
  color,
  dataLabel,
  secondaryData,
  secondaryColor,
  secondaryLabel,
  isCurrency = false,
  isPercentage = false,
  dataInThousands = false,
  showArea = false,
  variant = 'card',
}: {
  data: number[];
  labels: string[];
  color: string;
  dataLabel: string;
  secondaryData?: number[];
  secondaryColor?: string;
  secondaryLabel?: string;
  isCurrency?: boolean;
  isPercentage?: boolean;
  dataInThousands?: boolean;
  showArea?: boolean;
  variant?: ChartVariant;
}) {
  const chartId = React.useId().replace(/:/g, '');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const height = variant === 'card' ? PROPERTY_ANALYTICS_CARD_CHART_HEIGHT : 760;
  const padL = variant === 'card' ? 58 : 56;
  const padR = variant === 'card' ? 10 : 8;
  const padT = variant === 'card' ? 12 : 18;
  const padB = variant === 'card' ? PROPERTY_ANALYTICS_CARD_PAD_BOTTOM : 60;
  const baseWidth = variant === 'card' ? 620 : 1540;
  const width = variant === 'card'
    ? baseWidth
    : Math.max(baseWidth, padL + padR + data.length * 10 + Math.max(data.length - 1, 0) * 3);
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const axisFontSize = variant === 'card' ? PROPERTY_ANALYTICS_CARD_AXIS_FONT : 19;
  const visibleIndices = getChartVisibleAxisIndices(labels, getAxisLabelCount(labels, variant, innerW));
  const rotateLabels = shouldRotateAxisLabels(labels, variant);

  const allValues = secondaryData ? [...data, ...secondaryData] : data;
  const maxValue = Math.max(...allValues, 0);
  const minValue = Math.min(...allValues, 0);
  const { niceMin, niceMax, ticks } = scaleTickTarget(maxValue * 1.04, minValue < 0, minValue);

  const xScale = (index: number) => (data.length === 1 ? padL + innerW / 2 : padL + (index / (data.length - 1)) * innerW);
  const yScale = (value: number) => padT + innerH - ((value - niceMin) / (niceMax - niceMin)) * innerH;

  const linePath = data.map((value, index) => `${index === 0 ? 'M' : 'L'}${xScale(index)},${yScale(value)}`).join(' ');
  const secondaryLinePath = secondaryData?.map((value, index) => `${index === 0 ? 'M' : 'L'}${xScale(index)},${yScale(value)}`).join(' ');
  const areaPath = `${linePath} L${xScale(data.length - 1)},${padT + innerH} L${xScale(0)},${padT + innerH} Z`;

  const formatValue = (value: number) => {
    if (isPercentage) return formatPercent(value);
    if (isCurrency) return formatTooltipCurrency(dataInThousands ? value * 1000 : value);
    return value.toFixed(2);
  };

  const formatAxis = (value: number) => {
    if (isPercentage) return `${value.toFixed(0)}%`;
    if (isCurrency) return formatAxisCurrency(dataInThousands ? value * 1000 : value);
    return value.toFixed(0);
  };

  return (
    <div className={`relative h-full w-full ${variant === 'modal' ? 'overflow-x-auto overflow-y-hidden' : ''}`}>
      <svg viewBox={`0 0 ${width} ${height}`} className={variant === 'modal' ? 'block h-full min-w-full w-auto' : 'h-full w-full'}>
        <defs>
          <linearGradient id={`${chartId}-line-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {ticks.map((tick, index) => {
          const y = yScale(tick);
          return <line key={`grid-${index}`} x1={padL} x2={padL + innerW} y1={y} y2={y} stroke="rgba(148,163,184,0.28)" strokeWidth={1} strokeDasharray="4 4" />;
        })}
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="rgba(148,163,184,0.45)" strokeWidth={1} />
        {showArea && <path d={areaPath} fill={`url(#${chartId}-line-area)`} />}
        {secondaryLinePath && secondaryColor && <path d={secondaryLinePath} fill="none" stroke={secondaryColor} strokeWidth={variant === 'card' ? 3 : 4} strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />}
        <path d={linePath} fill="none" stroke={color} strokeWidth={variant === 'card' ? 3 : 4} strokeLinecap="round" strokeLinejoin="round" />
        {secondaryData && secondaryColor && secondaryData.map((value, index) => (
          <circle key={`secondary-${index}`} cx={xScale(index)} cy={yScale(value)} r={hoveredIndex === index ? (variant === 'card' ? 5 : 6) : (variant === 'card' ? 4 : 5)} fill={secondaryColor} stroke="#ffffff" strokeWidth={2} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />
        ))}
        {data.map((value, index) => (
          <circle key={index} cx={xScale(index)} cy={yScale(value)} r={hoveredIndex === index ? (variant === 'card' ? 5 : 6) : (variant === 'card' ? 4 : 5)} fill={color} stroke="#ffffff" strokeWidth={2} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />
        ))}
        {ticks.map((tick, index) => (
          <text key={`axis-${index}`} x={padL - 9} y={yScale(tick) + 5} textAnchor="end" fontSize={axisFontSize} fill="#94a3b8" fontWeight="600">
            {formatAxis(tick)}
          </text>
        ))}
        {visibleIndices.map((index) => {
          const x = xScale(index);
          const y = padT + innerH + (rotateLabels ? (variant === 'card' ? 20 : 24) : (variant === 'card' ? 14 : 18));
          return (
            <text
              key={`x-${index}`}
              x={x}
              y={y}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              fontSize={axisFontSize}
              fill="#94a3b8"
              fontWeight="600"
              dominantBaseline="hanging"
              transform={rotateLabels ? `rotate(-34 ${x} ${y})` : undefined}
            >
              {formatAxisLabel(labels[index], variant)}
            </text>
          );
        })}
      </svg>

      {hoveredIndex !== null && (() => {
        const pointX = xScale(hoveredIndex);
        const pct = (pointX / width) * 100;
        const isRightHalf = hoveredIndex >= data.length / 2;
        return (
          <div
            className="pointer-events-none absolute top-4 z-20 rounded-lg border border-slate-700/40 bg-slate-900/95 px-3.5 py-2.5 text-sm text-white shadow-xl backdrop-blur-sm"
            style={isRightHalf ? { right: `${100 - pct + 3}%` } : { left: `${pct + 3}%` }}
          >
            <div className="mb-1 font-semibold text-slate-100">{labels[hoveredIndex]}</div>
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-slate-300">{dataLabel}:</span>
              <span className="font-medium">{formatValue(data[hoveredIndex])}</span>
            </div>
            {secondaryData && secondaryColor && secondaryLabel && secondaryData[hoveredIndex] != null && (
              <div className="mt-1 flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: secondaryColor }} />
                <span className="text-slate-300">{secondaryLabel}:</span>
                <span className="font-medium">{formatValue(secondaryData[hoveredIndex])}</span>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function ItemizedIncomeExpensesChart({ income, expenseBreakdown, labels, variant = 'card' }: { income: number[]; expenseBreakdown: ExpenseBreakdownSeries; labels: string[]; variant?: ChartVariant }) {
  const chartId = React.useId().replace(/:/g, '');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const height = variant === 'card' ? PROPERTY_ANALYTICS_CARD_CHART_HEIGHT : 760;
  const padL = variant === 'card' ? 58 : 56;
  const padR = variant === 'card' ? 10 : 8;
  const padT = variant === 'card' ? 18 : 24;
  const padB = variant === 'card' ? PROPERTY_ANALYTICS_CARD_PAD_BOTTOM : 60;
  const baseWidth = variant === 'card' ? 620 : 1540;
  const width = variant === 'card'
    ? baseWidth
    : Math.max(baseWidth, padL + padR + income.length * 20 + Math.max(income.length - 1, 0) * 4);
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const axisFontSize = variant === 'card' ? PROPERTY_ANALYTICS_CARD_AXIS_FONT : 19;
  const visibleIndices = getChartVisibleAxisIndices(labels, getAxisLabelCount(labels, variant, innerW));
  const rotateLabels = shouldRotateAxisLabels(labels, variant);

  const totals = income.map((_, index) => income[index] + expenseBreakdown.taxes[index] + expenseBreakdown.insurance[index] + expenseBreakdown.utilities[index] + expenseBreakdown.hoa[index] + expenseBreakdown.repairs[index] + expenseBreakdown.management[index] + expenseBreakdown.debtService[index]);
  const niceMax = scaleTickTarget(Math.max(...totals, 1) * 1.04, false).niceMax;
  const ticks = Array.from({ length: 6 }, (_, index) => (niceMax * index) / 5);
  const gap = variant === 'card' ? 8 : 4;
  const groupWidth = income.length > 0 ? (innerW - gap * Math.max(income.length - 1, 0)) / income.length : innerW;
  const pairGap = variant === 'card' ? 10 : 14;
  const barWidth = Math.min((groupWidth - pairGap) / 2, variant === 'card' ? 32 : 42);
  const contentWidth = barWidth * 2 + pairGap;
  const colors = {
    taxes: '#fbbf24',
    insurance: '#f472b6',
    utilities: '#a78bfa',
    hoa: '#fb923c',
    repairs: '#ef4444',
    management: '#06b6d4',
    debtService: '#b45309',
  } as const;
  const expenseOrder: Array<keyof ExpenseBreakdownSeries> = ['debtService', 'taxes', 'repairs', 'management', 'insurance', 'utilities', 'hoa'];
  const hoverBreakdownItems = hoveredIndex === null
    ? null
    : [
        { label: 'Income', color: '#10b981', value: formatTooltipCurrency(income[hoveredIndex] * 1000) },
        { label: 'Debt', color: '#b45309', value: formatTooltipCurrency(expenseBreakdown.debtService[hoveredIndex] * 1000) },
        { label: 'Taxes', color: '#fbbf24', value: formatTooltipCurrency(expenseBreakdown.taxes[hoveredIndex] * 1000) },
        { label: 'Repairs', color: '#ef4444', value: formatTooltipCurrency(expenseBreakdown.repairs[hoveredIndex] * 1000) },
        { label: 'Mgmt', color: '#06b6d4', value: formatTooltipCurrency(expenseBreakdown.management[hoveredIndex] * 1000) },
        { label: 'Insurance', color: '#f472b6', value: formatTooltipCurrency(expenseBreakdown.insurance[hoveredIndex] * 1000) },
        { label: 'Utilities', color: '#a78bfa', value: formatTooltipCurrency(expenseBreakdown.utilities[hoveredIndex] * 1000) },
        { label: 'HOA', color: '#fb923c', value: formatTooltipCurrency(expenseBreakdown.hoa[hoveredIndex] * 1000) },
      ];

  return (
    <div className={`relative h-full w-full ${variant === 'modal' ? 'overflow-x-auto overflow-y-hidden' : ''}`}>
      <svg viewBox={`0 0 ${width} ${height}`} className={variant === 'modal' ? 'block h-full min-w-full w-auto' : 'h-full w-full'}>
        <defs>
          <linearGradient id={`${chartId}-income`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="1" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.78" />
          </linearGradient>
        </defs>
        {ticks.map((tick, index) => {
          const y = padT + innerH - (tick / niceMax) * innerH;
          return <line key={`grid-${index}`} x1={padL} x2={padL + innerW} y1={y} y2={y} stroke="rgba(148,163,184,0.28)" strokeWidth={1} strokeDasharray="4 4" />;
        })}
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="rgba(148,163,184,0.45)" strokeWidth={1} />

        {income.map((value, index) => {
          const xGroup = padL + index * (groupWidth + gap) + Math.max((groupWidth - contentWidth) / 2, 0);
          const incomeHeight = (value / niceMax) * innerH;
          const incomeY = padT + innerH - incomeHeight;
          let stackedY = padT + innerH;

          return (
            <g key={index}>
              {hoveredIndex === index && <rect x={xGroup - 5} y={padT - 2} width={contentWidth + 10} height={innerH + 8} rx={12} fill="rgba(99,102,241,0.10)" opacity="0.9" />}
              <rect x={xGroup} y={incomeY} width={barWidth} height={incomeHeight} rx={Math.min(6, barWidth / 2.5)} fill={`url(#${chartId}-income)`} opacity={hoveredIndex === index ? 1 : 0.9} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />
              {expenseOrder.map((category) => {
                const categoryHeight = ((expenseBreakdown[category][index] || 0) / niceMax) * innerH;
                stackedY -= categoryHeight;
                return <rect key={`${category}-${index}`} x={xGroup + barWidth + pairGap} y={stackedY} width={barWidth} height={categoryHeight} rx={Math.min(6, barWidth / 2.5)} fill={colors[category]} opacity={hoveredIndex === index ? 1 : 0.9} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} />;
              })}
            </g>
          );
        })}

        {ticks.map((tick, index) => {
          const y = padT + innerH - (tick / niceMax) * innerH;
          return (
            <text key={`axis-${index}`} x={padL - 9} y={y + 5} textAnchor="end" fontSize={axisFontSize} fill="#94a3b8" fontWeight="600">
              {tick === 0 ? '$0' : formatAxisCurrency(tick * 1000)}
            </text>
          );
        })}

        {visibleIndices.map((index) => {
          const x = padL + index * (groupWidth + gap) + groupWidth / 2;
          const y = padT + innerH + (rotateLabels ? (variant === 'card' ? 20 : 24) : (variant === 'card' ? 14 : 18));
          return (
            <text
              key={`x-${index}`}
              x={x}
              y={y}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              fontSize={axisFontSize}
              fill="#94a3b8"
              fontWeight="600"
              dominantBaseline="hanging"
              transform={rotateLabels ? `rotate(-34 ${x} ${y})` : undefined}
            >
              {formatAxisLabel(labels[index], variant)}
            </text>
          );
        })}

        <g transform={`translate(${padL}, ${variant === 'card' ? 4 : 6})`}>
          <rect x={0} y={0} width={10} height={8} fill="#10b981" />
          <text x={14} y={8} fontSize={variant === 'card' ? 10 : 12} fill="#64748b" fontWeight="600">Income</text>
          <rect x={66} y={0} width={10} height={8} fill="#b45309" />
          <text x={80} y={8} fontSize={variant === 'card' ? 10 : 12} fill="#64748b" fontWeight="600">Debt</text>
          <rect x={118} y={0} width={10} height={8} fill="#fbbf24" />
          <text x={132} y={8} fontSize={variant === 'card' ? 10 : 12} fill="#64748b" fontWeight="600">Tax</text>
          <rect x={166} y={0} width={10} height={8} fill="#ef4444" />
          <text x={180} y={8} fontSize={variant === 'card' ? 10 : 12} fill="#64748b" fontWeight="600">Repair</text>
          <rect x={228} y={0} width={10} height={8} fill="#06b6d4" />
          <text x={242} y={8} fontSize={variant === 'card' ? 10 : 12} fill="#64748b" fontWeight="600">Mgmt</text>
        </g>
      </svg>

      {hoverBreakdownItems && hoveredIndex !== null && (
        <div
          className="pointer-events-none absolute z-50 rounded-lg border border-white/10 bg-gray-900/75 shadow-xl backdrop-blur-md overflow-hidden"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            maxWidth: variant === 'card' ? '220px' : '280px',
          }}
        >
          <div className={variant === 'card' ? 'px-3 py-2' : 'px-3.5 py-2.5'}>
            <div className={`${variant === 'card' ? 'text-[12px]' : 'text-[13px]'} font-bold text-white mb-1.5`}>
              {labels[hoveredIndex]}
            </div>
            <div className="space-y-0.5">
              {hoverBreakdownItems.map((item, idx) => (
                <React.Fragment key={item.label}>
                  {idx === 1 && <div className="border-t border-white/15 my-1" />}
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2.5 h-2.5 flex-shrink-0" style={{ backgroundColor: item.color }} />
                    <span className={`${variant === 'card' ? 'text-[11px]' : 'text-[12px]'} text-gray-300`}>{item.label}:</span>
                    <span className={`${variant === 'card' ? 'text-[11px]' : 'text-[12px]'} font-semibold text-white`}>{item.value}</span>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaxHistoryBarChart({ values, labels, variant = 'card' }: { values: number[]; labels: string[]; variant?: ChartVariant }) {
  return (
    <ProfessionalBarChart
      data={values}
      labels={labels}
      color="#fbbf24"
      dataLabel="Taxes"
      dataInThousands={true}
      isCurrency={true}
      variant={variant}
    />
  );
}

function PriceHistoryControls({
  avmGranularity,
  avmRange,
  showMarketComparison,
  hasMarketComparison,
  onAvmGranularityChange,
  onAvmRangeChange,
  onMarketComparisonChange,
}: {
  avmGranularity: AvmGranularity;
  avmRange: string;
  showMarketComparison: boolean;
  hasMarketComparison: boolean;
  onAvmGranularityChange: (value: AvmGranularity) => void;
  onAvmRangeChange: (value: string) => void;
  onMarketComparisonChange: (value: boolean) => void;
}) {
  return (
    <>
      {hasMarketComparison ? (
        <PriceHistoryComparisonToggle value={showMarketComparison} onChange={onMarketComparisonChange} />
      ) : null}
      <div className="flex rounded-xl bg-slate-100 p-0.5">
        <button type="button" onClick={() => onAvmGranularityChange('quarterly')} className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${avmGranularity === 'quarterly' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}>
          Qtr
        </button>
        <button type="button" onClick={() => onAvmGranularityChange('annual')} className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${avmGranularity === 'annual' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}>
          Yr
        </button>
      </div>
      <select value={avmRange} onChange={(event) => onAvmRangeChange(event.target.value)} className="analytics-glass-select rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-600">
        <option value="2Q">2Q</option>
        <option value="1Y">1Y</option>
        <option value="2Y">2Y</option>
        <option value="3Y">3Y</option>
        <option value="5Y">5Y</option>
        <option value="10Y">10Y</option>
        <option value="all">All</option>
      </select>
    </>
  );
}

function TaxHistoryControls({ value, onChange, sidebarGlass = false }: { value: TaxHistoryRange; onChange: (value: TaxHistoryRange) => void; sidebarGlass?: boolean }) {
  const className = sidebarGlass
    ? 'analytics-glass-select rounded-lg border border-white/15 bg-[#1a3a5c]/50 px-4 py-2 text-sm font-semibold text-white/85 backdrop-blur-sm transition-colors hover:bg-[#2a5080]/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
    : 'analytics-glass-select rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-600';

  return (
    <select value={value} onChange={(event) => onChange(event.target.value as TaxHistoryRange)} className={className}>
      <option value="1Y">1Y</option>
      <option value="2Y">2Y</option>
      <option value="3Y">3Y</option>
      <option value="5Y">5Y</option>
      <option value="10Y">10Y</option>
      <option value="all">All</option>
    </select>
  );
}

function TimeframeControl({ value, onChange }: { value: MetricTimeframe; onChange: (value: MetricTimeframe) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as MetricTimeframe)} className="analytics-glass-select rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-600">
      {METRIC_TIMEFRAME_OPTIONS.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}

function RatioMetricToggle({ value, onChange }: { value: RatioMarginMetricKey; onChange: (value: RatioMarginMetricKey) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {RATIO_MARGIN_METRIC_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${value === option.value ? 'bg-sky-500 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-800'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function useEscapeToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, onClose]);
}

function OverviewExpandedModal({
  expandedChart,
  onClose,
  avmPoints,
  avmComparisonPoints,
  showMarketComparison,
  onMarketComparisonChange,
  avmLabels,
  avmGranularity,
  avmRange,
  onAvmGranularityChange,
  onAvmRangeChange,
  chartData,
  analyticsGranularity,
  cashFlowTimeframe,
  onCashFlowTimeframeChange,
  taxHistorySeries,
  taxHistoryRange,
  onTaxHistoryRangeChange,
}: {
  expandedChart: ExpandedChartKey | null;
  onClose: () => void;
  avmPoints: MiniPoint[];
  avmComparisonPoints?: MiniPoint[];
  showMarketComparison: boolean;
  onMarketComparisonChange: (value: boolean) => void;
  avmLabels: string[];
  avmGranularity: AvmGranularity;
  avmRange: string;
  onAvmGranularityChange: (value: AvmGranularity) => void;
  onAvmRangeChange: (value: string) => void;
  chartData: PropertyAnalyticsChartData | null;
  analyticsGranularity: ProjectionGranularity;
  cashFlowTimeframe: MetricTimeframe;
  onCashFlowTimeframeChange: (value: MetricTimeframe) => void;
  taxHistorySeries: TaxHistorySeries;
  taxHistoryRange: TaxHistoryRange;
  onTaxHistoryRangeChange: (value: TaxHistoryRange) => void;
}) {
  useEscapeToClose(Boolean(expandedChart), onClose);

  if (!expandedChart) return null;

  const cashFlowSeries = chartData
    ? windowSeriesByTimeframe(chartData.cashFlow, chartData.projectionLabels, analyticsGranularity, cashFlowTimeframe)
    : null;
  const hasMarketComparison = hasAlignedPriceHistoryComparison(avmPoints, avmComparisonPoints);

  if (expandedChart === 'priceHistory') {
    return (
      <ChartModal
        title="Price History (AVM)"
        onClose={onClose}
        controls={<PriceHistoryControls avmGranularity={avmGranularity} avmRange={avmRange} showMarketComparison={showMarketComparison} hasMarketComparison={hasMarketComparison} onAvmGranularityChange={onAvmGranularityChange} onAvmRangeChange={onAvmRangeChange} onMarketComparisonChange={onMarketComparisonChange} />}
      >
        <PriceHistoryChart points={avmPoints} comparisonPoints={showMarketComparison ? avmComparisonPoints : undefined} labels={avmLabels} variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'cashFlow' && cashFlowSeries) {
    return (
      <ChartModal title="Cash Flow" onClose={onClose} controls={<TimeframeControl value={cashFlowTimeframe} onChange={onCashFlowTimeframeChange} />}>
        <ProfessionalBarChart data={cashFlowSeries.values} labels={cashFlowSeries.labels} color="#3b82f6" dataLabel="Cash Flow" allowNegative isCurrency dataInThousands variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'taxHistory') {
    return (
      <ChartModal title="Tax History" onClose={onClose} controls={<TaxHistoryControls value={taxHistoryRange} onChange={onTaxHistoryRangeChange} />}>
        <TaxHistoryBarChart values={taxHistorySeries.values} labels={taxHistorySeries.labels} variant="modal" />
      </ChartModal>
    );
  }

  return null;
}

function AdditionalExpandedModal({
  expandedChart,
  onClose,
  chartData,
  optimizedChartData,
  appliedScenarioLabel,
  analyticsGranularity,
  avmPoints,
  avmComparisonPoints,
  showMarketComparison,
  onMarketComparisonChange,
  avmLabels,
  avmGranularity,
  avmRange,
  onAvmGranularityChange,
  onAvmRangeChange,
  taxHistorySeries,
  taxHistoryRange,
  onTaxHistoryRangeChange,
  mortgageAmortRange,
  onMortgageAmortRangeChange,
  selectedRatioMetric,
  onSelectedRatioMetricChange,
  metricTimeframes,
  onMetricTimeframeChange,
}: {
  expandedChart: ExpandedChartKey | null;
  onClose: () => void;
  chartData: PropertyAnalyticsChartData | null;
  optimizedChartData?: PropertyAnalyticsChartData | null;
  appliedScenarioLabel: string;
  analyticsGranularity: ProjectionGranularity;
  avmPoints: MiniPoint[];
  avmComparisonPoints?: MiniPoint[];
  showMarketComparison: boolean;
  onMarketComparisonChange: (value: boolean) => void;
  avmLabels: string[];
  avmGranularity: AvmGranularity;
  avmRange: string;
  onAvmGranularityChange: (value: AvmGranularity) => void;
  onAvmRangeChange: (value: string) => void;
  taxHistorySeries: TaxHistorySeries;
  taxHistoryRange: TaxHistoryRange;
  onTaxHistoryRangeChange: (value: TaxHistoryRange) => void;
  mortgageAmortRange: MetricTimeframe;
  onMortgageAmortRangeChange: (value: MetricTimeframe) => void;
  selectedRatioMetric: RatioMarginMetricKey;
  onSelectedRatioMetricChange: (value: RatioMarginMetricKey) => void;
  metricTimeframes: Record<ExpandedChartKey, MetricTimeframe>;
  onMetricTimeframeChange: (key: ExpandedChartKey, value: MetricTimeframe) => void;
}) {
  useEscapeToClose(Boolean(expandedChart), onClose);

  if (!expandedChart) return null;

  const projectionSeries = chartData
    ? windowSeriesByTimeframe(chartData.cashFlow, chartData.projectionLabels, analyticsGranularity, metricTimeframes.cashFlow)
    : null;
  const incomeSeries = chartData
    ? windowSeriesByTimeframe(chartData.incomeExpenses.income, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses)
    : null;
  const cocSeries = chartData
    ? windowSeriesByTimeframe(chartData.cocReturn, chartData.projectionLabels, analyticsGranularity, metricTimeframes.cocReturn)
    : null;
  const capRateSeries = chartData
    ? windowSeriesByTimeframe(chartData.capRate, chartData.projectionLabels, analyticsGranularity, metricTimeframes.capRate)
    : null;
  const noiSeries = chartData
    ? windowSeriesByTimeframe(chartData.noi, chartData.projectionLabels, analyticsGranularity, metricTimeframes.noi)
    : null;
  const totalReturnSeries = chartData
    ? windowSeriesByTimeframe(chartData.totalReturn.cumulative, chartData.projectionLabels, analyticsGranularity, metricTimeframes.totalReturn)
    : null;
  const irrLabels = chartData ? buildHoldingPeriodLabels(chartData.rollingIrr.length, analyticsGranularity) : [];
  const irrSeries = chartData ? windowSeriesByTimeframe(chartData.rollingIrr, irrLabels, analyticsGranularity, metricTimeframes.irr) : null;
  const optimizedIrrSeries = optimizedChartData ? windowSeriesByTimeframe(optimizedChartData.rollingIrr, irrLabels, analyticsGranularity, metricTimeframes.irr) : null;
  const optimizedCapRateSeries = optimizedChartData
    ? windowSeriesByTimeframe(optimizedChartData.capRate, optimizedChartData.projectionLabels, analyticsGranularity, metricTimeframes.capRate)
    : null;
  const mortgageSeries = chartData
    ? windowSeriesByTimeframe(chartData.mortgageAmortization.interest, chartData.mortgageLabels, analyticsGranularity, metricTimeframes.mortgageAmortization)
    : null;
  const propertyLoanSeries = chartData
    ? windowSeriesByTimeframe(chartData.propertyAppreciation.loan, chartData.projectionLabels, analyticsGranularity, metricTimeframes.equity)
    : null;
  const ratioMetricConfig = RATIO_MARGIN_METRIC_CONFIG[selectedRatioMetric];
  const ratioMetricSeries = windowRatioMetricSeriesByTimeframe(chartData, selectedRatioMetric, analyticsGranularity, metricTimeframes.ratios);
  const optimizedRatioMetricSeries = windowRatioMetricSeriesByTimeframe(optimizedChartData, selectedRatioMetric, analyticsGranularity, metricTimeframes.ratios);
  const hasMarketComparison = hasAlignedPriceHistoryComparison(avmPoints, avmComparisonPoints);

  if (expandedChart === 'priceHistory') {
    return (
      <ChartModal
        title="Price History (AVM)"
        onClose={onClose}
        controls={<PriceHistoryControls avmGranularity={avmGranularity} avmRange={avmRange} showMarketComparison={showMarketComparison} hasMarketComparison={hasMarketComparison} onAvmGranularityChange={onAvmGranularityChange} onAvmRangeChange={onAvmRangeChange} onMarketComparisonChange={onMarketComparisonChange} />}
      >
        <PriceHistoryChart points={avmPoints} comparisonPoints={showMarketComparison ? avmComparisonPoints : undefined} labels={avmLabels} variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'taxHistory') {
    return (
      <ChartModal title="Tax History" onClose={onClose} controls={<TaxHistoryControls value={taxHistoryRange} onChange={onTaxHistoryRangeChange} />}>
        <TaxHistoryBarChart values={taxHistorySeries.values} labels={taxHistorySeries.labels} variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'cashFlow' && projectionSeries) {
    return (
      <ChartModal title="Cash Flow" onClose={onClose} controls={<TimeframeControl value={metricTimeframes.cashFlow} onChange={(value) => onMetricTimeframeChange('cashFlow', value)} />}>
        <ProfessionalBarChart data={projectionSeries.values} labels={projectionSeries.labels} color="#3b82f6" dataLabel="Cash Flow" allowNegative isCurrency dataInThousands variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'incomeExpenses' && chartData && incomeSeries) {
    const expenseBreakdown: ExpenseBreakdownSeries = {
      taxes: windowSeriesByTimeframe(chartData.incomeExpenses.expenseBreakdown.taxes, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses).values,
      insurance: windowSeriesByTimeframe(chartData.incomeExpenses.expenseBreakdown.insurance, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses).values,
      utilities: windowSeriesByTimeframe(chartData.incomeExpenses.expenseBreakdown.utilities, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses).values,
      hoa: windowSeriesByTimeframe(chartData.incomeExpenses.expenseBreakdown.hoa, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses).values,
      repairs: windowSeriesByTimeframe(chartData.incomeExpenses.expenseBreakdown.repairs, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses).values,
      management: windowSeriesByTimeframe(chartData.incomeExpenses.expenseBreakdown.management, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses).values,
      debtService: windowSeriesByTimeframe(chartData.incomeExpenses.expenseBreakdown.debtService, chartData.projectionLabels, analyticsGranularity, metricTimeframes.incomeExpenses).values,
    };
    return (
      <ChartModal title="Income - Expenses" onClose={onClose} wide controls={<TimeframeControl value={metricTimeframes.incomeExpenses} onChange={(value) => onMetricTimeframeChange('incomeExpenses', value)} />}>
        <ItemizedIncomeExpensesChart income={incomeSeries.values} expenseBreakdown={expenseBreakdown} labels={incomeSeries.labels} variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'cocReturn' && cocSeries) {
    return (
      <ChartModal title="Cash on Cash Return" onClose={onClose} controls={<TimeframeControl value={metricTimeframes.cocReturn} onChange={(value) => onMetricTimeframeChange('cocReturn', value)} />}>
        <ProfessionalBarChart data={cocSeries.values} labels={cocSeries.labels} color="#f97316" dataLabel="CoC Return" isCurrency={false} isPercentage allowNegative variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'capRate' && capRateSeries) {
    return (
      <ChartModal title="Cap Rate" onClose={onClose} controls={<TimeframeControl value={metricTimeframes.capRate} onChange={(value) => onMetricTimeframeChange('capRate', value)} />}>
        <ProfessionalBarChart data={capRateSeries.values} labels={capRateSeries.labels} color="#f59e0b" dataLabel="Cap Rate" secondaryData={optimizedCapRateSeries?.values} secondaryColor="#10b981" secondaryLabel={appliedScenarioLabel} isCurrency={false} isPercentage variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'mortgageAmortization' && chartData && mortgageSeries) {
    const principalSeries = windowSeriesByTimeframe(chartData.mortgageAmortization.principal, chartData.mortgageLabels, analyticsGranularity, metricTimeframes.mortgageAmortization).values;
    const loanBalanceSeries = windowSeriesByTimeframe(chartData.mortgageAmortization.loanBalance, chartData.mortgageLabels, analyticsGranularity, metricTimeframes.mortgageAmortization).values;
    return (
      <ChartModal title="Mortgage Amortization - Loan Balance" onClose={onClose} wide controls={<TimeframeControl value={mortgageAmortRange} onChange={onMortgageAmortRangeChange} />}>
        <ProfessionalBarChart
          data={mortgageSeries.values}
          labels={mortgageSeries.labels}
          color="#ef4444"
          dataLabel="Interest"
          secondaryData={principalSeries}
          secondaryColor="#10b981"
          secondaryLabel="Principal"
          tertiaryData={loanBalanceSeries}
          tertiaryColor="#f97316"
          tertiaryLabel="Loan Balance"
          stackFirstTwo
          useDualAxis
          tertiaryAsLine
          isCurrency
          dataInThousands
          variant="modal"
        />
      </ChartModal>
    );
  }

  if (expandedChart === 'noi' && noiSeries) {
    return (
      <ChartModal title="Net Operating Income" onClose={onClose} controls={<TimeframeControl value={metricTimeframes.noi} onChange={(value) => onMetricTimeframeChange('noi', value)} />}>
        <ProfessionalBarChart data={noiSeries.values} labels={noiSeries.labels} color="#10b981" dataLabel="NOI" allowNegative={noiSeries.values.some((value) => value < 0)} isCurrency dataInThousands variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'equity' && chartData && propertyLoanSeries) {
    const equitySeries = windowSeriesByTimeframe(chartData.propertyAppreciation.equity, chartData.projectionLabels, analyticsGranularity, metricTimeframes.equity).values;
    const propertyValueSeries = windowSeriesByTimeframe(chartData.propertyAppreciation.value, chartData.projectionLabels, analyticsGranularity, metricTimeframes.equity).values;
    return (
      <ChartModal title="Equity & Appreciation" onClose={onClose} wide controls={<TimeframeControl value={metricTimeframes.equity} onChange={(value) => onMetricTimeframeChange('equity', value)} />}>
        <ProfessionalBarChart
          data={propertyLoanSeries.values}
          labels={propertyLoanSeries.labels}
          color="#ef4444"
          dataLabel="Loan Balance"
          secondaryData={equitySeries}
          secondaryColor="#10b981"
          secondaryLabel="Equity"
          tertiaryData={propertyValueSeries}
          tertiaryColor="#14b8a6"
          tertiaryLabel="Property Value"
          stackFirstTwo
          useDualAxis
          tertiaryAsLine
          isCurrency
          dataInThousands
          variant="modal"
        />
      </ChartModal>
    );
  }

  if (expandedChart === 'totalReturn' && totalReturnSeries) {
    return (
      <ChartModal title="Total Return" onClose={onClose} controls={<TimeframeControl value={metricTimeframes.totalReturn} onChange={(value) => onMetricTimeframeChange('totalReturn', value)} />}>
        <ProfessionalBarChart data={totalReturnSeries.values} labels={totalReturnSeries.labels} color="#14b8a6" dataLabel="Total Return" allowNegative isCurrency dataInThousands variant="modal" />
      </ChartModal>
    );
  }

  if (expandedChart === 'ratios' && ratioMetricSeries) {
    return (
      <ChartModal
        title={
          <div className="flex min-w-0 flex-col gap-1">
            <span>Ratios & Margins</span>
            <span className="text-sm font-medium text-slate-500">{ratioMetricConfig.description}</span>
          </div>
        }
        onClose={onClose}
        controls={
          <div className="flex items-center gap-3">
            <RatioMetricToggle value={selectedRatioMetric} onChange={onSelectedRatioMetricChange} />
            <TimeframeControl value={metricTimeframes.ratios} onChange={(value) => onMetricTimeframeChange('ratios', value)} />
          </div>
        }
        wide
      >
        <ProfessionalLineChart
          data={ratioMetricSeries.values}
          labels={ratioMetricSeries.labels}
          color={ratioMetricConfig.color}
          dataLabel={ratioMetricConfig.dataLabel}
          secondaryData={optimizedRatioMetricSeries?.values}
          secondaryColor="#10b981"
          secondaryLabel={appliedScenarioLabel}
          isPercentage={ratioMetricConfig.isPercentage}
          isCurrency={false}
          showArea
          variant="modal"
        />
      </ChartModal>
    );
  }

  if (expandedChart === 'irr' && irrSeries) {
    return (
      <ChartModal title="IRR by Holding Period" onClose={onClose} controls={<TimeframeControl value={metricTimeframes.irr} onChange={(value) => onMetricTimeframeChange('irr', value)} />}>
        <ProfessionalLineChart data={irrSeries.values} labels={irrSeries.labels} color="#2563eb" dataLabel="Current Plan" secondaryData={optimizedIrrSeries?.values} secondaryColor="#10b981" secondaryLabel={appliedScenarioLabel} isPercentage isCurrency={false} variant="modal" />
      </ChartModal>
    );
  }

  return null;
}

export function PropertyOverviewAnalyticsGrid({
  avmGranularity,
  avmRange,
  avmPoints,
  avmComparisonPoints,
  avmLabels,
  chartData,
  analyticsGranularity,
  propertyDashLoading,
  taxHistoryRange,
  taxHistorySeries,
  tenantCorrespondenceSummary,
  summaryLoading,
  onAvmGranularityChange,
  onAvmRangeChange,
  onTaxHistoryRangeChange,
  onRefreshTenantSummary,
  onOpenMessaging,
  hasCurrentTenant,
  compact = false,
  dense = false,
  focusAsset,
}: PropertyOverviewAnalyticsGridProps) {
  const [expandedChart, setExpandedChart] = useState<ExpandedChartKey | null>(null);
  const [cashFlowExpandedTimeframe, setCashFlowExpandedTimeframe] = useState<MetricTimeframe>('10Y');
  const [showMarketComparison, setShowMarketComparison] = useState(false);
  const gridGapClass = dense ? 'gap-2.5' : 'gap-3';
  const denseCardClassName = dense ? 'rounded-[18px]' : '';
  const overviewCardClassName = [denseCardClassName, compact ? '' : 'min-h-[360px] xl:aspect-auto'].filter(Boolean).join(' ');
  const overviewChartVariant: ChartVariant = 'card';
  const hasMarketComparison = hasAlignedPriceHistoryComparison(avmPoints, avmComparisonPoints);

  useEffect(() => {
    if (!hasMarketComparison) {
      setShowMarketComparison(false);
    }
  }, [hasMarketComparison]);

  const cashFlowSeries = useMemo(() => {
    if (!chartData) return null;
    return windowSeries(chartData.cashFlow, chartData.projectionLabels, analyticsGranularity, overviewChartVariant);
  }, [chartData, analyticsGranularity, overviewChartVariant]);

  const priceHistoryCard = (
    <AnalyticsCard
      title="Price History (AVM)"
      compact={compact}
      dense={dense}
      className={overviewCardClassName}
      controls={<>{hasMarketComparison ? <PriceHistoryComparisonToggle value={showMarketComparison} onChange={setShowMarketComparison} compact={compact || dense} /> : null}<ExpandButton onClick={() => setExpandedChart('priceHistory')} /></>}
    >
      {propertyDashLoading ? (
        <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">Loading...</div>
      ) : avmPoints.length > 0 ? (
        <PriceHistoryChart points={avmPoints} comparisonPoints={showMarketComparison ? avmComparisonPoints : undefined} labels={avmLabels} variant={overviewChartVariant} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No data</div>
      )}
    </AnalyticsCard>
  );

  const cashFlowCard = (
    <AnalyticsCard
      title="Cash Flow"
      compact={compact}
      dense={dense}
      className={overviewCardClassName}
      controls={<ExpandButton onClick={() => setExpandedChart('cashFlow')} />}
    >
      {cashFlowSeries ? (
        <ProfessionalBarChart data={cashFlowSeries.values} labels={cashFlowSeries.labels} color="#3b82f6" dataLabel="Cash Flow" allowNegative isCurrency dataInThousands variant={overviewChartVariant} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No cash flow data</div>
      )}
    </AnalyticsCard>
  );

  const taxHistoryCard = (
    <AnalyticsCard
      title="Tax History"
      compact={compact}
      dense={dense}
      className={overviewCardClassName}
      controls={
        <>
          <TaxHistoryControls value={taxHistoryRange} onChange={onTaxHistoryRangeChange} />
          <ExpandButton onClick={() => setExpandedChart('taxHistory')} />
        </>
      }
    >
      {taxHistorySeries.values.length > 0 ? (
        <TaxHistoryBarChart values={taxHistorySeries.values} labels={taxHistorySeries.labels} variant={overviewChartVariant} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No tax data</div>
      )}
    </AnalyticsCard>
  );

  const tenantCorrespondenceCard = (
    <AnalyticsCard
      title="Tenant Correspondence Summary"
      compact={compact}
      dense={dense}
      className={overviewCardClassName}
      controls={
        <button
          type="button"
          onClick={onRefreshTenantSummary}
          className="rounded-xl px-3 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700"
          disabled={summaryLoading}
        >
          {summaryLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      }
    >
      {summaryLoading ? (
        <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">Generating summary...</div>
      ) : tenantCorrespondenceSummary.length > 0 ? (
        <div className={`h-full overflow-y-auto text-slate-700 ${dense ? 'px-3 py-1.5 text-[13px] leading-5' : 'px-3 py-2 text-sm leading-6'}`}>
          <ul className={dense ? 'space-y-1.5' : 'space-y-2'}>
            {tenantCorrespondenceSummary.map((item, index) => (
              <li key={index} className="flex gap-2">
                <span className="font-bold text-blue-600">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={`flex h-full flex-col items-center justify-center text-center text-sm text-slate-400 ${dense ? 'gap-2' : 'gap-3'}`}>
          <div>No tenant messages yet</div>
          {hasCurrentTenant && onOpenMessaging && (
            <button type="button" onClick={onOpenMessaging} className="text-sm font-medium text-blue-600 hover:text-blue-700">
              Open messaging to fetch messages
            </button>
          )}
        </div>
      )}
    </AnalyticsCard>
  );

  if (focusAsset) {
    const focusedCard = focusAsset === 'overview-price-history'
      ? priceHistoryCard
      : focusAsset === 'overview-cash-flow'
        ? cashFlowCard
        : focusAsset === 'overview-tax-history'
          ? taxHistoryCard
          : tenantCorrespondenceCard;

    return (
      <>
        {focusedCard}
        <OverviewExpandedModal
          expandedChart={expandedChart}
          onClose={() => setExpandedChart(null)}
          avmPoints={avmPoints}
          avmComparisonPoints={avmComparisonPoints}
          showMarketComparison={showMarketComparison}
          onMarketComparisonChange={setShowMarketComparison}
          avmLabels={avmLabels}
          avmGranularity={avmGranularity}
          avmRange={avmRange}
          onAvmGranularityChange={onAvmGranularityChange}
          onAvmRangeChange={onAvmRangeChange}
          chartData={chartData}
          analyticsGranularity={analyticsGranularity}
          cashFlowTimeframe={cashFlowExpandedTimeframe}
          onCashFlowTimeframeChange={setCashFlowExpandedTimeframe}
          taxHistorySeries={taxHistorySeries}
          taxHistoryRange={taxHistoryRange}
          onTaxHistoryRangeChange={onTaxHistoryRangeChange}
        />
      </>
    );
  }

  return (
    <>
      <div className={`${compact ? '' : 'col-span-12 lg:col-span-9 '}grid grid-cols-1 ${gridGapClass} xl:grid-cols-2`}>
        {priceHistoryCard}
        {cashFlowCard}
        {taxHistoryCard}
        {tenantCorrespondenceCard}
      </div>

      <OverviewExpandedModal
        expandedChart={expandedChart}
        onClose={() => setExpandedChart(null)}
        avmPoints={avmPoints}
        avmComparisonPoints={avmComparisonPoints}
        showMarketComparison={showMarketComparison}
        onMarketComparisonChange={setShowMarketComparison}
        avmLabels={avmLabels}
        avmGranularity={avmGranularity}
        avmRange={avmRange}
        onAvmGranularityChange={onAvmGranularityChange}
        onAvmRangeChange={onAvmRangeChange}
        chartData={chartData}
        analyticsGranularity={analyticsGranularity}
        cashFlowTimeframe={cashFlowExpandedTimeframe}
        onCashFlowTimeframeChange={setCashFlowExpandedTimeframe}
        taxHistorySeries={taxHistorySeries}
        taxHistoryRange={taxHistoryRange}
        onTaxHistoryRangeChange={onTaxHistoryRangeChange}
      />
    </>
  );
}

export function AdditionalAnalyticsChartsGrid({
  avmGranularity,
  avmRange,
  avmPoints,
  avmComparisonPoints,
  avmLabels,
  chartData,
  analyticsGranularity,
  taxHistoryRange,
  taxHistorySeries,
  mortgageAmortRange,
  onAnalyticsGranularityChange,
  onAvmGranularityChange,
  onAvmRangeChange,
  onTaxHistoryRangeChange,
  onMortgageAmortRangeChange,
  rentalPricingData,
  pricingProjectionMode = 'none',
  optimizedChartData,
  aiScenarioChartData,
  aiScenarioLabel = 'AI Scenario',
  analyticsAudit,
  metricFilter,
  showHeader = true,
  dashboardCardMode = false,
  compact = false,
}: AdditionalAnalyticsChartsGridProps) {
  const [expandedChart, setExpandedChart] = useState<ExpandedChartKey | null>(null);
  const [openAuditKey, setOpenAuditKey] = useState<string | null>(null);
  const [showMarketComparison, setShowMarketComparison] = useState(false);
  const [selectedRatioMetric, setSelectedRatioMetric] = useState<RatioMarginMetricKey>('noiMargin');
  const [metricTimeframes, setMetricTimeframes] = useState<Record<ExpandedChartKey, MetricTimeframe>>({
    priceHistory: '10Y',
    cashFlow: '10Y',
    taxHistory: '10Y',
    incomeExpenses: '10Y',
    cocReturn: '10Y',
    mortgageAmortization: mortgageAmortRange,
    capRate: '10Y',
    noi: '10Y',
    equity: '10Y',
    totalReturn: '10Y',
    ratios: '10Y',
    irr: '10Y',
  });
  const hasMarketComparison = hasAlignedPriceHistoryComparison(avmPoints, avmComparisonPoints);

  useEffect(() => {
    if (!hasMarketComparison) {
      setShowMarketComparison(false);
    }
  }, [hasMarketComparison]);

  useEffect(() => {
    setMetricTimeframes((previous) => ({
      ...previous,
      mortgageAmortization: mortgageAmortRange,
    }));
  }, [mortgageAmortRange]);

  const setMetricTimeframe = (key: ExpandedChartKey, value: MetricTimeframe) => {
    setMetricTimeframes((previous) => ({
      ...previous,
      [key]: value,
    }));

    if (key === 'mortgageAmortization') {
      onMortgageAmortRangeChange(value);
    }
  };

  const cashFlowSeries = chartData ? windowSeries(chartData.cashFlow, chartData.projectionLabels, analyticsGranularity, 'card') : null;
  const incomeSeries = chartData ? windowSeries(chartData.incomeExpenses.income, chartData.projectionLabels, analyticsGranularity, 'card') : null;
  const cocSeries = chartData ? windowSeries(chartData.cocReturn, chartData.projectionLabels, analyticsGranularity, 'card') : null;
  const mortgageSeries = chartData ? windowSeries(chartData.mortgageAmortization.interest, chartData.mortgageLabels, analyticsGranularity, 'card') : null;
  const capRateSeries = chartData ? windowSeries(chartData.capRate, chartData.projectionLabels, analyticsGranularity, 'card') : null;
  const noiSeries = chartData ? windowSeries(chartData.noi, chartData.projectionLabels, analyticsGranularity, 'card') : null;
  const equitySeries = chartData ? windowSeries(chartData.propertyAppreciation.loan, chartData.projectionLabels, analyticsGranularity, 'card') : null;
  const totalReturnSeries = chartData ? windowSeries(chartData.totalReturn.cumulative, chartData.projectionLabels, analyticsGranularity, 'card') : null;
  const irrLabels = chartData ? buildHoldingPeriodLabels(chartData.rollingIrr.length, analyticsGranularity) : [];
  const irrSeries = chartData ? windowSeries(chartData.rollingIrr, irrLabels, analyticsGranularity, 'card') : null;
  const optimizedIrrSeries = optimizedChartData ? windowSeries(optimizedChartData.rollingIrr, irrLabels, analyticsGranularity, 'card') : null;
  const optimizedCashFlowSeries = optimizedChartData ? windowSeries(optimizedChartData.cashFlow, optimizedChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const optimizedCocSeries = optimizedChartData ? windowSeries(optimizedChartData.cocReturn, optimizedChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const optimizedCapRateSeries = optimizedChartData ? windowSeries(optimizedChartData.capRate, optimizedChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const optimizedNoiSeries = optimizedChartData ? windowSeries(optimizedChartData.noi, optimizedChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const optimizedTotalReturnSeries = optimizedChartData ? windowSeries(optimizedChartData.totalReturn.cumulative, optimizedChartData.projectionLabels, analyticsGranularity, 'card') : null;

  // AI Scenario overlay series
  const aiScenarioCashFlowSeries = aiScenarioChartData ? windowSeries(aiScenarioChartData.cashFlow, aiScenarioChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const aiScenarioCocSeries = aiScenarioChartData ? windowSeries(aiScenarioChartData.cocReturn, aiScenarioChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const aiScenarioCapRateSeries = aiScenarioChartData && hasMeaningfulSeries(aiScenarioChartData.capRate)
    ? windowSeries(aiScenarioChartData.capRate, aiScenarioChartData.projectionLabels, analyticsGranularity, 'card')
    : null;
  const aiScenarioNoiSeries = aiScenarioChartData ? windowSeries(aiScenarioChartData.noi, aiScenarioChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const aiScenarioIrrSeries = aiScenarioChartData ? windowSeries(aiScenarioChartData.rollingIrr, irrLabels, analyticsGranularity, 'card') : null;
  const aiScenarioTotalReturnSeries = aiScenarioChartData ? windowSeries(aiScenarioChartData.totalReturn.cumulative, aiScenarioChartData.projectionLabels, analyticsGranularity, 'card') : null;
  const ratioMetricConfig = RATIO_MARGIN_METRIC_CONFIG[selectedRatioMetric];
  const ratioMetricSeries = windowRatioMetricSeries(chartData, selectedRatioMetric, analyticsGranularity, 'card');
  const optimizedRatioMetricSeries = windowRatioMetricSeries(optimizedChartData, selectedRatioMetric, analyticsGranularity, 'card');
  const aiScenarioRatioMetricSeries = aiScenarioChartData ? windowRatioMetricSeries(aiScenarioChartData, selectedRatioMetric, analyticsGranularity, 'card') : null;

  // Helper: pick overlay secondary data — AI scenario takes priority over pricing optimization
  const getSecondaryData = (aiSeries: typeof aiScenarioCashFlowSeries, pricingSeries: typeof optimizedCashFlowSeries) =>
    aiSeries?.values ?? (hasAppliedOptimization ? pricingSeries?.values : undefined);
  const getSecondaryLabel = (hasAi: boolean, pricingLabel: string) =>
    hasAi ? aiScenarioLabel : pricingLabel;
  const getSecondaryColor = (hasAi: boolean) =>
    hasAi ? '#8b5cf6' : '#10b981';

  // Audit helpers
  const getAudit = (key: string) => analyticsAudit?.find((a) => a.key === key);
  const InfoButton = ({ auditKey }: { auditKey: string }) => {
    const hasAudit = !!getAudit(auditKey);
    if (!hasAudit) return null;

    const className = dashboardCardMode
      ? 'analytics-glass-info-btn flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-[#1a3a5c]/50 text-white/85 transition-colors backdrop-blur-sm hover:bg-[#2a5080]/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
      : 'analytics-glass-info-btn flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600';

    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpenAuditKey(openAuditKey === auditKey ? null : auditKey); }}
        className={className}
        title="View metric audit"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
    );
  };
  const hasAppliedOptimization = !!optimizedChartData;
  const appliedScenarioLabel = pricingProjectionMode === 'market'
    ? 'Benchmark Plan'
    : pricingProjectionMode === 'custom'
      ? 'Slider Plan'
      : 'Return-Optimal Plan';
  const appliedScenarioRent = pricingProjectionMode === 'market'
    ? rentalPricingData?.marketPotentialRent
    : pricingProjectionMode === 'custom'
      ? rentalPricingData?.customRent
      : rentalPricingData?.recommendedRent;
  const appliedScenarioVacancy = pricingProjectionMode === 'market'
    ? rentalPricingData?.benchmarkVacancyRate
    : pricingProjectionMode === 'custom'
      ? rentalPricingData?.customVacancyRate
      : rentalPricingData?.recommendedVacancyRate;
  const appliedScenarioGrowth = pricingProjectionMode === 'market'
    ? rentalPricingData?.benchmarkProjectedRentGrowth
    : pricingProjectionMode === 'custom'
      ? rentalPricingData?.customProjectedRentGrowth
      : rentalPricingData?.recommendedProjectedRentGrowth;

  const expenseBreakdown = chartData && incomeSeries
    ? {
        taxes: windowSeries(chartData.incomeExpenses.expenseBreakdown.taxes, chartData.projectionLabels, analyticsGranularity, 'card').values,
        insurance: windowSeries(chartData.incomeExpenses.expenseBreakdown.insurance, chartData.projectionLabels, analyticsGranularity, 'card').values,
        utilities: windowSeries(chartData.incomeExpenses.expenseBreakdown.utilities, chartData.projectionLabels, analyticsGranularity, 'card').values,
        hoa: windowSeries(chartData.incomeExpenses.expenseBreakdown.hoa, chartData.projectionLabels, analyticsGranularity, 'card').values,
        repairs: windowSeries(chartData.incomeExpenses.expenseBreakdown.repairs, chartData.projectionLabels, analyticsGranularity, 'card').values,
        management: windowSeries(chartData.incomeExpenses.expenseBreakdown.management, chartData.projectionLabels, analyticsGranularity, 'card').values,
        debtService: windowSeries(chartData.incomeExpenses.expenseBreakdown.debtService, chartData.projectionLabels, analyticsGranularity, 'card').values,
      }
    : null;

  const mortgagePrincipalSeries = chartData && mortgageSeries ? windowSeries(chartData.mortgageAmortization.principal, chartData.mortgageLabels, analyticsGranularity, 'card').values : null;
  const mortgageLoanBalanceSeries = chartData && mortgageSeries ? windowSeries(chartData.mortgageAmortization.loanBalance, chartData.mortgageLabels, analyticsGranularity, 'card').values : null;
  const propertyEquitySeries = chartData && equitySeries ? windowSeries(chartData.propertyAppreciation.equity, chartData.projectionLabels, analyticsGranularity, 'card').values : null;
  const propertyValueSeries = chartData && equitySeries ? windowSeries(chartData.propertyAppreciation.value, chartData.projectionLabels, analyticsGranularity, 'card').values : null;
  const effectiveRevenueDelta = pricingProjectionMode === 'market'
    ? (rentalPricingData?.benchmarkAnnualRevenueUpside ?? null)
    : pricingProjectionMode === 'custom'
      ? (rentalPricingData?.customAnnualRevenueUpside ?? null)
      : (rentalPricingData?.recommendedAnnualRevenueUpside ?? rentalPricingData?.annualRevenueUpside ?? null);
  const collectedIncomeDelta = chartData?.annualIncome?.collected && optimizedChartData?.annualIncome?.collected
    ? optimizedChartData.annualIncome.collected[0] - chartData.annualIncome.collected[0]
    : null;
  const cocDelta = chartData && optimizedChartData ? optimizedChartData.cocReturn[0] - chartData.cocReturn[0] : null;
  const capRateDelta = chartData && optimizedChartData ? optimizedChartData.capRate[0] - chartData.capRate[0] : null;
  const noiDelta = chartData && optimizedChartData ? optimizedChartData.noi[0] - chartData.noi[0] : null;
  const totalReturnDelta = totalReturnSeries && optimizedTotalReturnSeries && totalReturnSeries.values.length > 0 && optimizedTotalReturnSeries.values.length > 0
    ? optimizedTotalReturnSeries.values[optimizedTotalReturnSeries.values.length - 1] - totalReturnSeries.values[totalReturnSeries.values.length - 1]
    : null;
  const irrDelta = chartData?.irr != null && optimizedChartData?.irr != null ? optimizedChartData.irr - chartData.irr : null;
  const ratioMetricCurrentValue = ratioMetricSeries?.values?.[0] ?? null;
  const visibleMetrics = useMemo(
    () => new Set(metricFilter && metricFilter.length > 0 ? metricFilter : ALL_PROPERTY_ANALYTICS_METRICS),
    [metricFilter],
  );

  const shouldRenderMetric = (metric: PropertyAnalyticsMetricKey) => visibleMetrics.has(metric);
  const getVisibleMetricCount = (...metrics: PropertyAnalyticsMetricKey[]) => metrics.filter((metric) => shouldRenderMetric(metric)).length;
  const lockMetricCardAspectRatio = dashboardCardMode;
  const metricCardClassName = dashboardCardMode
    ? 'dashboard-balanced-analytics-card'
    : compact
      ? 'min-h-[260px] xl:aspect-auto'
      : 'min-h-[360px] xl:aspect-auto';
  const useSingleMetricDashboardLayout = dashboardCardMode && visibleMetrics.size === 1;
  /*
   * The rows below are fixed groupings, so filtering down to a couple of metrics
   * used to leave one chart alone in each row at full width and full height.
   * In compact mode the rows collapse to `contents` and every visible card
   * becomes a direct child of one grid, so a filtered set reflows into columns.
   */
  const getRowClassName = (metricCount: number) => {
    if (compact) return 'contents';
    if (metricCount <= 1) return useSingleMetricDashboardLayout ? 'grid h-full grid-cols-1' : 'grid grid-cols-1 gap-4';
    if (metricCount === 2) return 'grid grid-cols-1 gap-4 xl:grid-cols-2';
    return 'grid grid-cols-1 gap-4 xl:grid-cols-3';
  };
  const topRowMetricCount = getVisibleMetricCount('priceHistory', 'cashFlow', 'incomeExpenses');
  const middleRowMetricCount = getVisibleMetricCount('taxHistory', 'cocReturn', 'mortgageAmortization');
  const lowerRowMetricCount = getVisibleMetricCount('noi', 'equity', 'totalReturn');
  const efficiencyRowMetricCount = getVisibleMetricCount('capRate', 'ratios', 'irr');

  return (
    <>
      {showHeader ? (
        <div className="mb-6 flex items-center justify-between">
          <AnalyticsGranularityToggle value={analyticsGranularity} onChange={onAnalyticsGranularityChange} />
          {aiScenarioChartData && (
            <div className="flex items-center gap-2 rounded-full border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              AI Scenario: {aiScenarioLabel}
            </div>
          )}
        </div>
      ) : null}

      <div
        className={
          compact
            ? 'grid grid-cols-1 gap-3 xl:grid-cols-2'
            : useSingleMetricDashboardLayout
              ? 'flex h-full flex-col'
              : 'space-y-4'
        }
      >
        {topRowMetricCount > 0 ? (
          <div className={getRowClassName(topRowMetricCount)}>
            {shouldRenderMetric('priceHistory') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title="Price History (AVM)"
                controls={<>{hasMarketComparison ? <PriceHistoryComparisonToggle value={showMarketComparison} onChange={setShowMarketComparison} compact sidebarGlass={dashboardCardMode} /> : null}<InfoButton auditKey="avm" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('priceHistory')} /></>}
              >
                {avmPoints.length > 0 ? <PriceHistoryChart points={avmPoints} comparisonPoints={showMarketComparison ? avmComparisonPoints : undefined} labels={avmLabels} variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No price history data</div>}
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('cashFlow') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title={<div className="flex items-center gap-2"><span>Cash Flow</span>{!aiScenarioChartData && hasAppliedOptimization && appliedScenarioRent != null && <span className="text-[10px] font-medium px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">{appliedScenarioLabel} ${Math.round(appliedScenarioRent).toLocaleString()}/mo</span>}{!aiScenarioChartData && hasAppliedOptimization && rentalPricingData?.currentVacancyRate != null && appliedScenarioVacancy != null && <span className="text-[10px] font-medium px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">Vacancy {rentalPricingData.currentVacancyRate.toFixed(1)}% → {appliedScenarioVacancy.toFixed(1)}%</span>}</div>}
                controls={<><InfoButton auditKey="cash-flow" /><InfoButton auditKey="dscr" /><InfoButton auditKey="break-even" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('cashFlow')} /></>}
              >
                {cashFlowSeries ? <ProfessionalBarChart data={cashFlowSeries.values} labels={cashFlowSeries.labels} color="#3b82f6" dataLabel="Current Plan" secondaryData={getSecondaryData(aiScenarioCashFlowSeries, optimizedCashFlowSeries)} secondaryColor={getSecondaryColor(!!aiScenarioCashFlowSeries)} secondaryLabel={getSecondaryLabel(!!aiScenarioCashFlowSeries, appliedScenarioLabel)} allowNegative isCurrency dataInThousands variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No cash flow data</div>}
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('incomeExpenses') ? (
              <AnalyticsCard className={metricCardClassName} lockAspectRatio={lockMetricCardAspectRatio} sidebarGlass={dashboardCardMode} title={<div className="flex items-center gap-2"><span>Income - Expenses</span>{collectedIncomeDelta != null && <span className="text-[10px] font-medium px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">Collected +${collectedIncomeDelta.toFixed(1)}k/yr</span>}{effectiveRevenueDelta != null && <span className="text-[10px] font-medium px-1.5 py-0.5 bg-sky-100 text-sky-700 rounded">Effective {effectiveRevenueDelta >= 0 ? '+' : '-'}${(Math.abs(effectiveRevenueDelta) / 1000).toFixed(1)}k/yr</span>}{hasAppliedOptimization && appliedScenarioGrowth != null && <span className="text-[10px] font-medium px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">Growth {appliedScenarioGrowth.toFixed(1)}%</span>}</div>} controls={<><InfoButton auditKey="income-expenses" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('incomeExpenses')} /></>}>
                {incomeSeries && expenseBreakdown ? <ItemizedIncomeExpensesChart income={incomeSeries.values} expenseBreakdown={expenseBreakdown} labels={incomeSeries.labels} variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No income data</div>}
              </AnalyticsCard>
            ) : null}
          </div>
        ) : null}

        {middleRowMetricCount > 0 ? (
          <div className={getRowClassName(middleRowMetricCount)}>
            {shouldRenderMetric('taxHistory') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title="Tax History"
                controls={
                  <>
                    <TaxHistoryControls value={taxHistoryRange} onChange={onTaxHistoryRangeChange} sidebarGlass={dashboardCardMode} />
                    <InfoButton auditKey="tax-history" />
                    <ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('taxHistory')} />
                  </>
                }
              >
                {taxHistorySeries.values.length > 0 ? <TaxHistoryBarChart values={taxHistorySeries.values} labels={taxHistorySeries.labels} variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No tax data</div>}
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('cocReturn') ? (
              <AnalyticsCard className={metricCardClassName} lockAspectRatio={lockMetricCardAspectRatio} sidebarGlass={dashboardCardMode} title={<div className="flex items-center gap-2"><span>CoC Return</span>{!aiScenarioCocSeries && hasAppliedOptimization && cocDelta != null && <span className="text-[10px] font-medium px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">+{cocDelta.toFixed(1)} pts</span>}</div>} controls={<><InfoButton auditKey="coc" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('cocReturn')} /></>}>
                {cocSeries ? <ProfessionalBarChart data={cocSeries.values} labels={cocSeries.labels} color="#f97316" dataLabel="Current Plan" secondaryData={getSecondaryData(aiScenarioCocSeries, optimizedCocSeries)} secondaryColor={getSecondaryColor(!!aiScenarioCocSeries)} secondaryLabel={getSecondaryLabel(!!aiScenarioCocSeries, appliedScenarioLabel)} isCurrency={false} isPercentage allowNegative variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No return data</div>}
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('mortgageAmortization') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title="Mortgage Amortization"
                controls={<><InfoButton auditKey="mortgage" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('mortgageAmortization')} /></>}
              >
                {mortgageSeries && mortgagePrincipalSeries && mortgageLoanBalanceSeries ? (
                  <ProfessionalBarChart
                    data={mortgageSeries.values}
                    labels={mortgageSeries.labels}
                    color="#ef4444"
                    dataLabel="Interest"
                    secondaryData={mortgagePrincipalSeries}
                    secondaryColor="#10b981"
                    secondaryLabel="Principal"
                    tertiaryData={mortgageLoanBalanceSeries}
                    tertiaryColor="#f97316"
                    tertiaryLabel="Loan Balance"
                    stackFirstTwo
                    useDualAxis
                    tertiaryAsLine
                    isCurrency
                    dataInThousands
                    variant="card"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No amortization data</div>
                )}
              </AnalyticsCard>
            ) : null}
          </div>
        ) : null}

        {lowerRowMetricCount > 0 ? (
          <div className={getRowClassName(lowerRowMetricCount)}>
            {shouldRenderMetric('noi') ? (
              <AnalyticsCard className={metricCardClassName} lockAspectRatio={lockMetricCardAspectRatio} sidebarGlass={dashboardCardMode} title={<div className="flex items-center gap-2"><span>Net Operating Income</span>{!aiScenarioNoiSeries && hasAppliedOptimization && noiDelta != null && <span className="text-[10px] font-medium px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">+${noiDelta.toFixed(1)}k/yr</span>}</div>} controls={<><InfoButton auditKey="cap-rate" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('noi')} /></>}>
                {noiSeries ? <ProfessionalBarChart data={noiSeries.values} labels={noiSeries.labels} color="#10b981" dataLabel="Current Plan" secondaryData={getSecondaryData(aiScenarioNoiSeries, optimizedNoiSeries)} secondaryColor={getSecondaryColor(!!aiScenarioNoiSeries)} secondaryLabel={getSecondaryLabel(!!aiScenarioNoiSeries, appliedScenarioLabel)} allowNegative={noiSeries.values.some((value) => value < 0)} isCurrency dataInThousands variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No NOI data</div>}
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('equity') ? (
              <AnalyticsCard className={metricCardClassName} lockAspectRatio={lockMetricCardAspectRatio} sidebarGlass={dashboardCardMode} title="Equity & Appreciation" controls={<><InfoButton auditKey="equity" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('equity')} /></>}>
                {equitySeries && propertyEquitySeries && propertyValueSeries ? (
                  <ProfessionalBarChart
                    data={equitySeries.values}
                    labels={equitySeries.labels}
                    color="#ef4444"
                    dataLabel="Loan Balance"
                    secondaryData={propertyEquitySeries}
                    secondaryColor="#10b981"
                    secondaryLabel="Equity"
                    tertiaryData={propertyValueSeries}
                    tertiaryColor="#14b8a6"
                    tertiaryLabel="Property Value"
                    stackFirstTwo
                    useDualAxis
                    tertiaryAsLine
                    isCurrency
                    dataInThousands
                    variant="card"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No equity data</div>
                )}
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('totalReturn') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title={
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span>Total Return</span>
                    <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-slate-500">
                      <span>Cumulative</span>
                      {!aiScenarioTotalReturnSeries && hasAppliedOptimization && totalReturnDelta != null && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">Window +${totalReturnDelta.toFixed(1)}k</span>
                      )}
                    </div>
                  </div>
                }
                controls={<><InfoButton auditKey="total-return" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('totalReturn')} /></>}
              >
                {totalReturnSeries ? <ProfessionalBarChart data={totalReturnSeries.values} labels={totalReturnSeries.labels} color="#14b8a6" dataLabel="Current Plan" secondaryData={getSecondaryData(aiScenarioTotalReturnSeries, optimizedTotalReturnSeries)} secondaryColor="#fb923c" secondaryLabel={getSecondaryLabel(!!aiScenarioTotalReturnSeries, appliedScenarioLabel)} allowNegative isCurrency dataInThousands variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No total return data</div>}
              </AnalyticsCard>
            ) : null}
          </div>
        ) : null}

        {efficiencyRowMetricCount > 0 ? (
          <div className={getRowClassName(efficiencyRowMetricCount)}>
            {shouldRenderMetric('capRate') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title={
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span>Cap Rate</span>
                    <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-slate-500">
                      <span>Unlevered yield</span>
                      {!aiScenarioCapRateSeries && hasAppliedOptimization && capRateDelta != null && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">+{capRateDelta.toFixed(2)} pts</span>
                      )}
                    </div>
                  </div>
                }
                controls={<><InfoButton auditKey="cap-rate" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('capRate')} /></>}
              >
                {capRateSeries ? (
                  <ProfessionalBarChart
                    data={capRateSeries.values}
                    labels={capRateSeries.labels}
                    color="#f59e0b"
                    dataLabel="Current Plan"
                    secondaryData={hasMeaningfulSeries(aiScenarioCapRateSeries?.values) ? aiScenarioCapRateSeries?.values : hasAppliedOptimization ? optimizedCapRateSeries?.values : undefined}
                    secondaryColor={hasMeaningfulSeries(aiScenarioCapRateSeries?.values) ? '#8b5cf6' : '#10b981'}
                    secondaryLabel={hasMeaningfulSeries(aiScenarioCapRateSeries?.values) ? aiScenarioLabel : appliedScenarioLabel}
                    isCurrency={false}
                    isPercentage
                    variant="card"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No cap rate data</div>
                )}
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('ratios') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title={
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span>Ratios & Margins</span>
                    <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-slate-500">
                      <span>{ratioMetricConfig.label}</span>
                      {ratioMetricCurrentValue != null && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded">{formatRatioMetricValue(ratioMetricConfig, ratioMetricCurrentValue)}</span>
                      )}
                    </div>
                  </div>
                }
                controls={<>{ratioMetricConfig.auditKey ? <InfoButton auditKey={ratioMetricConfig.auditKey} /> : null}<ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('ratios')} /></>}
              >
                <div className="flex h-full flex-col gap-4">
                  <RatioMetricToggle value={selectedRatioMetric} onChange={setSelectedRatioMetric} />
                  <div className="min-h-0 flex-1">
                    {ratioMetricSeries ? (
                      <ProfessionalLineChart
                        data={ratioMetricSeries.values}
                        labels={ratioMetricSeries.labels}
                        color={ratioMetricConfig.color}
                        dataLabel={ratioMetricConfig.dataLabel}
                        secondaryData={hasMeaningfulSeries(aiScenarioRatioMetricSeries?.values) ? aiScenarioRatioMetricSeries?.values : hasAppliedOptimization ? optimizedRatioMetricSeries?.values : undefined}
                        secondaryColor={hasMeaningfulSeries(aiScenarioRatioMetricSeries?.values) ? '#8b5cf6' : '#10b981'}
                        secondaryLabel={hasMeaningfulSeries(aiScenarioRatioMetricSeries?.values) ? aiScenarioLabel : appliedScenarioLabel}
                        isCurrency={false}
                        isPercentage={ratioMetricConfig.isPercentage}
                        showArea
                        variant="card"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No ratio data</div>
                    )}
                  </div>
                </div>
              </AnalyticsCard>
            ) : null}

            {shouldRenderMetric('irr') ? (
              <AnalyticsCard
                className={metricCardClassName}
                lockAspectRatio={lockMetricCardAspectRatio}
                sidebarGlass={dashboardCardMode}
                title={
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span>IRR by Holding Period</span>
                    <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-slate-500">
                      <span>Exit-Year IRR</span>
                      {!aiScenarioIrrSeries && hasAppliedOptimization && irrDelta != null && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">Target +{irrDelta.toFixed(2)} pts</span>
                      )}
                    </div>
                  </div>
                }
                controls={<><InfoButton auditKey="irr" /><ExpandButton sidebarGlass={dashboardCardMode} onClick={() => setExpandedChart('irr')} /></>}
              >
                {irrSeries ? <ProfessionalLineChart data={irrSeries.values} labels={irrSeries.labels} color="#2563eb" dataLabel="Current Plan" secondaryData={getSecondaryData(aiScenarioIrrSeries, optimizedIrrSeries)} secondaryColor="#fb923c" secondaryLabel={getSecondaryLabel(!!aiScenarioIrrSeries, appliedScenarioLabel)} isCurrency={false} isPercentage variant="card" /> : <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No IRR data</div>}
              </AnalyticsCard>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Metric Audit Modal (frosted backdrop) */}
      {openAuditKey && analyticsAudit && (() => {
        const item = analyticsAudit.find((a) => a.key === openAuditKey);
        if (!item) return null;

        const renderAuditChart = () => {
          const chartStyle = { aspectRatio: '2.2' } as const;
          switch (openAuditKey) {
            case 'avm':
              return avmPoints.length > 0
                ? <div style={chartStyle}><PriceHistoryChart points={avmPoints} comparisonPoints={showMarketComparison ? avmComparisonPoints : undefined} labels={avmLabels} variant="card" /></div>
                : null;
            case 'cash-flow':
            case 'dscr':
            case 'break-even':
              return cashFlowSeries
                ? <div style={chartStyle}><ProfessionalBarChart data={cashFlowSeries.values} labels={cashFlowSeries.labels} color="#3b82f6" dataLabel="Cash Flow" allowNegative isCurrency dataInThousands variant="card" /></div>
                : null;
            case 'income-expenses':
              return incomeSeries && expenseBreakdown
                ? <div style={chartStyle}><ItemizedIncomeExpensesChart income={incomeSeries.values} expenseBreakdown={expenseBreakdown} labels={incomeSeries.labels} variant="card" /></div>
                : null;
            case 'tax-history':
              return taxHistorySeries.values.length > 0
                ? <div style={chartStyle}><TaxHistoryBarChart values={taxHistorySeries.values} labels={taxHistorySeries.labels} variant="card" /></div>
                : null;
            case 'coc':
              return cocSeries
                ? <div style={chartStyle}><ProfessionalBarChart data={cocSeries.values} labels={cocSeries.labels} color="#f97316" dataLabel="CoC Return" isCurrency={false} isPercentage allowNegative variant="card" /></div>
                : null;
            case 'mortgage':
              return mortgageSeries && mortgagePrincipalSeries && mortgageLoanBalanceSeries
                ? <div style={chartStyle}><ProfessionalBarChart data={mortgageSeries.values} labels={mortgageSeries.labels} color="#ef4444" dataLabel="Interest" secondaryData={mortgagePrincipalSeries} secondaryColor="#10b981" secondaryLabel="Principal" tertiaryData={mortgageLoanBalanceSeries} tertiaryColor="#f97316" tertiaryLabel="Loan Balance" stackFirstTwo useDualAxis tertiaryAsLine isCurrency dataInThousands variant="card" /></div>
                : null;
            case 'cap-rate':
              return capRateSeries
                ? <div style={chartStyle}><ProfessionalBarChart data={capRateSeries.values} labels={capRateSeries.labels} color="#f59e0b" dataLabel="Cap Rate" isCurrency={false} isPercentage variant="card" /></div>
                : null;
            case 'equity':
              return equitySeries && propertyEquitySeries && propertyValueSeries
                ? <div style={chartStyle}><ProfessionalBarChart data={equitySeries.values} labels={equitySeries.labels} color="#ef4444" dataLabel="Loan Balance" secondaryData={propertyEquitySeries} secondaryColor="#10b981" secondaryLabel="Equity" tertiaryData={propertyValueSeries} tertiaryColor="#14b8a6" tertiaryLabel="Property Value" stackFirstTwo useDualAxis tertiaryAsLine isCurrency dataInThousands variant="card" /></div>
                : null;
            case 'total-return':
              return totalReturnSeries
                ? <div style={chartStyle}><ProfessionalBarChart data={totalReturnSeries.values} labels={totalReturnSeries.labels} color="#14b8a6" dataLabel="Total Return" allowNegative isCurrency dataInThousands variant="card" /></div>
                : null;
            case 'irr':
              return irrSeries
                ? <div style={chartStyle}><ProfessionalLineChart data={irrSeries.values} labels={irrSeries.labels} color="#2563eb" dataLabel="IRR" isCurrency={false} isPercentage variant="card" /></div>
                : null;
            default:
              return null;
          }
        };

        return (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => setOpenAuditKey(null)}>
            {/* Frosted backdrop */}
            <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[6px]" />
            {/* Modal */}
            <div
              className="relative w-[min(680px,calc(100vw-80px))] max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.25)]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-100 bg-white/95 backdrop-blur-sm px-6 py-4 rounded-t-2xl">
                <div className="min-w-0">
                  <div className="text-base font-bold text-slate-900">{item.title}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{item.formula}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-lg font-bold text-slate-900 whitespace-nowrap">{item.result}</span>
                  <button type="button" onClick={() => setOpenAuditKey(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              </div>
              {/* Chart */}
              <div className="px-6 pt-4 pb-2">
                {renderAuditChart()}
              </div>
              {/* Formula Trace */}
              <div className="px-6 pb-5 pt-2 space-y-2">
                <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Metric Audit — Formula Trace</div>
                {item.substitutions.map((line, idx) => (
                  <div key={idx} className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-2.5 text-[12px] leading-relaxed text-slate-700">{line}</div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      <AdditionalExpandedModal
        expandedChart={expandedChart}
        onClose={() => setExpandedChart(null)}
        chartData={chartData}
        optimizedChartData={aiScenarioChartData ?? optimizedChartData}
        appliedScenarioLabel={aiScenarioChartData ? aiScenarioLabel : appliedScenarioLabel}
        analyticsGranularity={analyticsGranularity}
        avmPoints={avmPoints}
        avmComparisonPoints={avmComparisonPoints}
        showMarketComparison={showMarketComparison}
        onMarketComparisonChange={setShowMarketComparison}
        avmLabels={avmLabels}
        avmGranularity={avmGranularity}
        avmRange={avmRange}
        onAvmGranularityChange={onAvmGranularityChange}
        onAvmRangeChange={onAvmRangeChange}
        taxHistorySeries={taxHistorySeries}
        taxHistoryRange={taxHistoryRange}
        onTaxHistoryRangeChange={onTaxHistoryRangeChange}
        mortgageAmortRange={mortgageAmortRange}
        onMortgageAmortRangeChange={onMortgageAmortRangeChange}
        selectedRatioMetric={selectedRatioMetric}
        onSelectedRatioMetricChange={setSelectedRatioMetric}
        metricTimeframes={metricTimeframes}
        onMetricTimeframeChange={setMetricTimeframe}
      />
    </>
  );
}