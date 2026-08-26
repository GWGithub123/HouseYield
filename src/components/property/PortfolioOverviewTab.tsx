import React, { useId, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type {
  PropertyPortfolioAllocationItem,
  PropertyPortfolioHistoryGranularity,
  PropertyPortfolioOverview,
} from '../../services/canonicalPortfolioService';
import { formatCurrency } from '../../utils/formatting';
import { Card, KpiStrip, SectionHeader } from '../../design-system';
import {
  ExpenseCategoryDonut,
  MoneyFlowMap,
  PropertyCashFlowBars,
  portfolioExpenseBuckets,
} from '../finance/BookkeepingStyleCharts';
import PortfolioAiInsightsPanel from './PortfolioAiInsightsPanel';
import { isMaintenanceProduct } from '../../product/productMode';

function buildLinearSvgPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 px-3 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

export function PortfolioValueHistoryCard({
  overview,
  granularity,
  onGranularityChange,
  compact = false,
  showSummary = true,
  showEquity = !isMaintenanceProduct(),
  chartHeight,
  bare = false,
}: {
  overview: PropertyPortfolioOverview;
  granularity: PropertyPortfolioHistoryGranularity;
  onGranularityChange: (next: PropertyPortfolioHistoryGranularity) => void;
  compact?: boolean;
  showSummary?: boolean;
  /** When false, only the portfolio value series is drawn. Defaults off in maintenance mode. */
  showEquity?: boolean;
  /**
   * Plot height in CSS pixels. Drives the viewBox too — the SVG is drawn with
   * `preserveAspectRatio="none"`, so setting a CSS height without matching the
   * viewBox stretches the whole chart vertically.
   */
  chartHeight?: number;
  /** Drops the Card chrome so the caller can supply its own shell. */
  bare?: boolean;
  /** @deprecated Dark theme removed — light Card is the platform standard. */
  theme?: 'light' | 'dark';
}) {
  const [showMarketComparison, setShowMarketComparison] = useState(false);
  const gradientId = `portfolio-value-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const equityGradientId = `portfolio-equity-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const points = granularity === 'quarterly' ? overview.valueTrendQuarterly : overview.valueTrendAnnual;
  const hasMarketComparison = points.some((point) => point.marketValue != null && Number.isFinite(point.marketValue) && (point.marketValue as number) > 0);
  const width = 860;
  const height = chartHeight ?? (compact ? 220 : 360);
  const padding = { top: 22, right: 22, bottom: 32, left: 66 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const values = points.map((point) => point.value);
  const equityValues = showEquity
    ? points.map((point) => point.equity ?? Math.max(point.value, 0))
    : [];
  const marketValues = showMarketComparison
    ? points.map((point) => (point.marketValue != null && point.marketValue > 0 ? point.marketValue : point.value))
    : [];
  const minValue = Math.min(...values, ...(equityValues.length ? equityValues : [Infinity]), ...(marketValues.length ? marketValues : [Infinity]), overview.summary.totalValue || 0);
  const maxValue = Math.max(...values, ...(equityValues.length ? equityValues : [0]), ...(marketValues.length ? marketValues : [0]), overview.summary.totalValue || 1);
  const domainMin = minValue === maxValue ? Math.max(0, minValue * 0.9) : Math.max(0, minValue - (maxValue - minValue) * 0.08);
  const domainMax = minValue === maxValue ? maxValue * 1.1 : maxValue + (maxValue - minValue) * 0.08;
  const chartPoints = points.map((point, index) => ({
    x: padding.left + ((innerWidth / Math.max(points.length - 1, 1)) * index),
    y: padding.top + innerHeight - (((point.value - domainMin) / Math.max(domainMax - domainMin, 1)) * innerHeight),
  }));
  const equityPoints = showEquity
    ? points.map((point, index) => ({
        x: padding.left + ((innerWidth / Math.max(points.length - 1, 1)) * index),
        y: padding.top + innerHeight - ((((point.equity ?? 0) - domainMin) / Math.max(domainMax - domainMin, 1)) * innerHeight),
      }))
    : [];
  const marketPoints = showMarketComparison
    ? points.map((point, index) => {
        const market = point.marketValue != null && point.marketValue > 0 ? point.marketValue : point.value;
        return {
          x: padding.left + ((innerWidth / Math.max(points.length - 1, 1)) * index),
          y: padding.top + innerHeight - (((market - domainMin) / Math.max(domainMax - domainMin, 1)) * innerHeight),
        };
      })
    : [];
  const linePath = buildLinearSvgPath(chartPoints);
  const equityLinePath = buildLinearSvgPath(equityPoints);
  const marketLinePath = buildLinearSvgPath(marketPoints);
  const areaPath = chartPoints.length > 0
    ? `${linePath} L ${padding.left + innerWidth} ${padding.top + innerHeight} L ${padding.left} ${padding.top + innerHeight} Z`
    : '';
  const equityAreaPath = equityPoints.length > 0
    ? `${equityLinePath} L ${padding.left + innerWidth} ${padding.top + innerHeight} L ${padding.left} ${padding.top + innerHeight} Z`
    : '';
  const yTicks = Array.from({ length: 3 }, (_, index) => domainMin + ((domainMax - domainMin) / 2) * index).reverse();
  const xLabelModulo = points.length > 12 ? Math.ceil(points.length / 6) : 1;
  const latestValue = points[points.length - 1]?.value ?? overview.summary.totalValue;
  const latestEquity = points[points.length - 1]?.equity ?? overview.summary.totalEquity;
  const latestMarket = points[points.length - 1]?.marketValue;
  const vsMarketPct = latestMarket && latestMarket > 0
    ? ((latestValue - latestMarket) / latestMarket) * 100
    : null;

  const marketToggle = hasMarketComparison ? (
    <button
      type="button"
      onClick={() => setShowMarketComparison((value) => !value)}
      aria-pressed={showMarketComparison}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10.5px] font-bold transition-colors ${
        showMarketComparison
          ? 'border-sky-500 bg-sky-50 text-sky-700'
          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
      }`}
      title="Toggle area mean AVM comparison overlay"
    >
      <span className={`h-2 w-2 rounded-full ${showMarketComparison ? 'bg-sky-500' : 'bg-slate-300'}`} />
      Market comparison
    </button>
  ) : null;

  const body = (
    <>
      {!compact && showSummary ? (
        <p className="mb-4 text-[13px] leading-relaxed text-[color:var(--ds-text-muted)]">
          {showEquity
            ? 'Combined estimated value and equity history across the properties currently in scope.'
            : 'Combined estimated value history across the properties currently in scope.'}
        </p>
      ) : null}
      {showSummary ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-baseline gap-2">
              <div className={`${compact ? 'text-2xl' : 'text-[36px]'} font-semibold tracking-[-0.04em] text-slate-900`}>
                {formatCurrency(overview.summary.totalValue)}
              </div>
              <div
                className={`rounded-full px-2.5 py-0.5 ${compact ? 'text-xs' : 'text-sm'} font-semibold ${
                  overview.summary.annualNetCashFlow >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                }`}
              >
                {overview.summary.netYield >= 0 ? '+' : ''}
                {overview.summary.netYield.toFixed(2)}% net yield
              </div>
            </div>
            {!compact ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <SummaryChip label="Monthly Rent" value={`${formatCurrency(overview.summary.monthlyRent)}/mo`} />
                <SummaryChip label="Properties" value={String(overview.summary.count)} />
              </div>
            ) : (
              <div className="mt-1 text-xs text-slate-500">
                Across {overview.summary.count} {overview.summary.count === 1 ? 'property' : 'properties'}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className={`${showSummary ? 'mt-3' : 'mt-1'} ${bare ? '' : 'rounded-2xl border border-slate-100 bg-gradient-to-b from-slate-50/80 to-white'} overflow-hidden px-1 pt-2`}>
        <div className="flex flex-wrap items-center gap-3 px-3 pb-1 text-[11px] font-semibold text-slate-500">
          {bare ? marketToggle : null}
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-teal-700" />
            Portfolio value
          </span>
          {showEquity ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-sky-600" />
              Equity
            </span>
          ) : null}
          {showMarketComparison ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-violet-600" />
              Area mean AVM
            </span>
          ) : null}
          {showMarketComparison && vsMarketPct != null ? (
            <span className={`ml-auto ${vsMarketPct >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {vsMarketPct >= 0 ? '+' : ''}{vsMarketPct.toFixed(1)}% vs mean
            </span>
          ) : showEquity ? (
            <span className="ml-auto text-slate-500">
              Equity {formatCurrency(latestEquity)}
            </span>
          ) : (
            <span className="ml-auto text-slate-500">
              {formatCurrency(latestValue)}
            </span>
          )}
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          style={{ height: chartHeight ?? (compact ? 190 : 240) }}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={equityGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {yTicks.map((tick) => {
            const y = padding.top + innerHeight - (((tick - domainMin) / Math.max(domainMax - domainMin, 1)) * innerHeight);
            return (
              <g key={tick}>
                <line x1={padding.left} x2={padding.left + innerWidth} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="4 8" />
                <text x={padding.left - 14} y={y + 4} textAnchor="end" fontSize="12" fill="#94a3b8">
                  {formatCurrency(tick)}
                </text>
              </g>
            );
          })}

          {areaPath ? <path d={areaPath} fill={`url(#${gradientId})`} /> : null}
          {showEquity && equityAreaPath ? <path d={equityAreaPath} fill={`url(#${equityGradientId})`} /> : null}
          {showMarketComparison && marketLinePath ? (
            <path d={marketLinePath} fill="none" stroke="#7c3aed" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 5" />
          ) : null}
          {showEquity && equityLinePath ? (
            <path d={equityLinePath} fill="none" stroke="#0284c7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
          {linePath ? (
            <path d={linePath} fill="none" stroke="#0f766e" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
          {chartPoints.length > 0 ? (
            <>
              <circle
                cx={chartPoints[chartPoints.length - 1].x}
                cy={chartPoints[chartPoints.length - 1].y}
                r="8"
                fill="#ccfbf1"
                stroke="#0f766e"
                strokeWidth="2"
              />
              <circle
                cx={chartPoints[chartPoints.length - 1].x}
                cy={chartPoints[chartPoints.length - 1].y}
                r="3"
                fill="#0f766e"
              />
              {showEquity && equityPoints.length > 0 ? (
                <circle
                  cx={equityPoints[equityPoints.length - 1].x}
                  cy={equityPoints[equityPoints.length - 1].y}
                  r="5"
                  fill="#e0f2fe"
                  stroke="#0284c7"
                  strokeWidth="2"
                />
              ) : null}
            </>
          ) : null}

          {points.map((point, index) => {
            if (index % xLabelModulo !== 0 && index !== points.length - 1) {
              return null;
            }
            const x = padding.left + ((innerWidth / Math.max(points.length - 1, 1)) * index);
            return (
              <text
                key={point.periodKey}
                x={x}
                y={height - 12}
                textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
                fontSize="12"
                fill="#94a3b8"
              >
                {point.label}
              </text>
            );
          })}
        </svg>
      </div>
    </>
  );

  if (bare) return body;

  return (
    <Card
      surface="light"
      compact={compact}
      eyebrow="Portfolio Trend"
      title="Total property value"
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {marketToggle}
          <div className="inline-flex rounded-2xl border border-slate-200 bg-slate-50 p-1">
            {(['quarterly', 'annual'] as PropertyPortfolioHistoryGranularity[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onGranularityChange(option)}
                className={`rounded-xl ${compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} font-semibold transition ${
                  granularity === option ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {option === 'quarterly' ? 'Quarterly' : 'Annually'}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {body}
    </Card>
  );
}

function AllocationByPropertyCard({ allocations }: { allocations: PropertyPortfolioAllocationItem[] }) {
  const total = allocations.reduce((sum, item) => sum + item.value, 0);

  return (
    <Card surface="light" eyebrow="Allocation by property" title="Share of portfolio value" className="h-full">
      <div className="space-y-3">
        {allocations.slice(0, 5).map((allocation) => (
          <div key={allocation.id} className="rounded-2xl border border-slate-200/80 bg-slate-50/70 px-3 py-3">
            <div className="flex items-center justify-between gap-3 text-sm text-slate-700">
              <span className="truncate">{allocation.label}</span>
              <span className="font-semibold">{total > 0 ? `${((allocation.value / total) * 100).toFixed(1)}%` : '0.0%'}</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-slate-200">
              <div
                className="h-2 rounded-full"
                style={{ width: `${total > 0 ? (allocation.value / total) * 100 : 0}%`, backgroundColor: allocation.color }}
              />
            </div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{formatCurrency(allocation.value)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ReturnsSnapshotCard({ overview }: { overview: PropertyPortfolioOverview }) {
  const metrics = [
    { label: 'Cap Rate', value: `${overview.summary.capRate.toFixed(2)}%` },
    { label: 'Gross Yield', value: `${overview.summary.grossYield.toFixed(2)}%` },
    { label: 'LTV', value: `${overview.summary.ltv.toFixed(1)}%` },
    { label: 'Properties', value: String(overview.summary.count) },
  ];

  return (
    <Card surface="light" eyebrow="Portfolio returns" title="Rollup snapshot" className="h-full">
      <p className="mb-4 text-sm text-slate-500">A quick read on yield, leverage, and portfolio breadth.</p>
      <div className="grid grid-cols-2 gap-2.5">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{metric.label}</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{metric.value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OperatingPerformanceCharts({ overview }: { overview: PropertyPortfolioOverview }) {
  const expenseBuckets = portfolioExpenseBuckets(overview.expenseBreakdown);
  const expenseTotal = expenseBuckets.reduce((sum, bucket) => sum + bucket.amount, 0);
  const annualIncome = overview.summary.monthlyRent * 12;
  const annualOutflows = overview.summary.annualOperatingExpenses + overview.summary.annualDebtService;
  const annualNet = overview.summary.annualNetCashFlow;
  const propertyBars = overview.allocations.map((allocation) => ({
    id: allocation.id,
    label: allocation.label,
    color: allocation.color,
    income: Math.max(allocation.monthlyIncome * 12, 0),
    expenses: Math.max((allocation.monthlyExpenses + allocation.monthlyMortgage) * 12, 0),
    cashFlow: allocation.monthlyCashFlow * 12,
  }));

  return (
    <div className="space-y-4">
      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <MoneyFlowMap
          income={annualIncome}
          expenses={annualOutflows}
          net={annualNet}
          expenseBuckets={expenseBuckets}
        />
        <ExpenseCategoryDonut
          buckets={expenseBuckets}
          total={expenseTotal}
          subtitle="Modeled annual carrying costs across every property currently in scope."
          emptyLabel="Add taxes, insurance, and other operating costs on each property to see the breakdown."
        />
      </div>
      <PropertyCashFlowBars properties={propertyBars} />
    </div>
  );
}

export default function PortfolioOverviewTab({
  overview,
  scope,
  hideValueHistory = false,
}: {
  overview: PropertyPortfolioOverview;
  scope: 'overview' | 'personal' | 'investment' | 'combined';
  hideValueHistory?: boolean;
}) {
  const [granularity, setGranularity] = useState<PropertyPortfolioHistoryGranularity>('quarterly');
  const [aiOpen, setAiOpen] = useState(false);

  if (!hideValueHistory) {
    return (
      <div className="space-y-4">
        <KpiStrip
          items={[
            {
              label: 'Gross Annual Rent',
              value: formatCurrency(overview.summary.monthlyRent * 12),
              sub: `${formatCurrency(overview.summary.monthlyRent)} / month`,
            },
            {
              label: 'Operating Expenses',
              value: formatCurrency(overview.summary.annualOperatingExpenses),
              sub: `${overview.summary.expenseRatio.toFixed(1)}% of gross income`,
            },
            {
              label: 'Debt Service',
              value: formatCurrency(overview.summary.annualDebtService),
              sub: `${formatCurrency(overview.summary.monthlyMortgage)} / month`,
            },
            {
              label: 'Net Cash Flow',
              value: formatCurrency(overview.summary.annualNetCashFlow),
              sub: `${overview.summary.cashFlowMargin >= 0 ? '+' : ''}${overview.summary.cashFlowMargin.toFixed(1)}% margin`,
              tone: overview.summary.annualNetCashFlow >= 0 ? 'positive' : 'negative',
              toneValue: true,
            },
          ]}
        />

        <PortfolioValueHistoryCard overview={overview} granularity={granularity} onGranularityChange={setGranularity} />

        <OperatingPerformanceCharts overview={overview} />

        <div className="grid items-stretch gap-4 lg:grid-cols-2">
          <AllocationByPropertyCard allocations={overview.allocations} />
          <ReturnsSnapshotCard overview={overview} />
        </div>

        <PortfolioAiInsightsPanel scope={scope} overview={overview} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader
          label="Operating performance"
          description="Cash flow, expenses, and allocation detail for every property in scope."
        />
        {!aiOpen && (
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            <Sparkles size={15} />
            AI analysis
          </button>
        )}
      </div>

      <div className={aiOpen ? 'grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]' : ''}>
        <div className="min-w-0 space-y-4">
          <OperatingPerformanceCharts overview={overview} />
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            <AllocationByPropertyCard allocations={overview.allocations} />
            <ReturnsSnapshotCard overview={overview} />
          </div>
        </div>

        {aiOpen && <PortfolioAiInsightsPanel scope={scope} overview={overview} compact onClose={() => setAiOpen(false)} />}
      </div>
    </div>
  );
}
