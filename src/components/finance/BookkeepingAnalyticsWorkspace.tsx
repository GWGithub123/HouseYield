import React, { useMemo } from 'react';
import type { BookkeepingSummary, CashflowTrend, Transaction } from '../../hooks/useFirestoreBookkeeping';
import { chartColor } from '../../design-system/tokens';
import MetricExplainButton from './MetricExplainButton';
import {
  buildFinanceSourceBreakdown,
  buildFinanceSourceMix,
  classifyFinanceSource,
  type SourceKind,
} from './FinanceSourceTruth';

interface ReconExceptionLike {
  id: string;
  occurredAt?: string | null;
  amount?: number | null;
  reason?: string | null;
  status?: string | null;
}

interface BookkeepingAnalyticsWorkspaceProps {
  summary: BookkeepingSummary | null;
  cashflowTrend: CashflowTrend[];
  transactions: Transaction[];
  cashBalance?: number | null;
  propertyCashBalances?: Record<string, number>;
  reconExceptions: ReconExceptionLike[];
  evidenceTotalCount: number;
  evidencePendingCount: number;
  pendingFinanceDocumentsCount: number;
  onSelectCategory?: (type: 'income' | 'expense', category: string) => void;
  onSelectVendor?: (vendor: string) => void;
  focusAsset?: BookkeepingAnalyticsAssetId;
}

export type BookkeepingAnalyticsAssetId =
  | 'cashflow-trend'
  | 'cash-balance-history'
  | 'cash-balance-metric'
  | 'reserve-runway-metric'
  | 'average-net-metric'
  | 'data-quality-metric'
  | 'analytics-explanations'
  | 'reserve-posture';

function fmtMoney(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function shortMonthLabel(input: string, year?: number | null) {
  if (!input) return '—';
  const normalized = /^\d{4}-\d{2}$/.test(input)
    ? `${input}-01T00:00:00`
    : year && /^[A-Za-z]+$/.test(input)
      ? `${input} 1, ${year}`
      : input;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return input;
  return parsed.toLocaleDateString('en-US', { month: 'short' });
}

function fullMonthLabel(input: string, year?: number | null) {
  if (!input) return '—';
  const normalized = /^\d{4}-\d{2}$/.test(input)
    ? `${input}-01T00:00:00`
    : year && /^[A-Za-z]+$/.test(input)
      ? `${input} 1, ${year}`
      : input;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return input;
  return parsed.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function safeDate(input?: string | null) {
  if (!input) return null;
  const dateOnlyMatch = String(input).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function monthKey(input?: string | null) {
  const parsed = safeDate(input);
  if (!parsed) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function roundMoney(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function isEmptyTrendMonth(item?: CashflowTrend | null) {
  if (!item) return true;
  return Number(item.income || 0) === 0
    && Number(item.expenses || 0) === 0
    && Number(item.net || 0) === 0;
}

function trimTrailingEmptyTrendMonths(data: CashflowTrend[]) {
  const trimmed = [...data];
  while (trimmed.length > 1 && isEmptyTrendMonth(trimmed[trimmed.length - 1])) {
    trimmed.pop();
  }
  return trimmed;
}

function buildCashflowTrendFromTransactions(transactions: Transaction[]): CashflowTrend[] {
  const datedTransactions = transactions
    .map((transaction) => ({ transaction, parsed: safeDate(transaction.date) }))
    .filter((entry): entry is { transaction: Transaction; parsed: Date } => Boolean(entry.parsed));

  if (datedTransactions.length === 0) {
    return [];
  }

  datedTransactions.sort((left, right) => left.parsed.getTime() - right.parsed.getTime());

  const buckets = new Map<string, { month: string; year: number; income: number; expenses: number }>();

  for (const { transaction, parsed } of datedTransactions) {
    const year = parsed.getFullYear();
    const month = parsed.getMonth();
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    const existing = buckets.get(key) || {
      month: parsed.toLocaleDateString('en-US', { month: 'long' }),
      year,
      income: 0,
      expenses: 0,
    };
    const amount = Math.abs(Number(transaction.amount || 0));

    if (transaction.type === 'income') {
      existing.income = roundMoney(existing.income + amount);
    } else if (transaction.type === 'expense') {
      existing.expenses = roundMoney(existing.expenses + amount);
    }

    buckets.set(key, existing);
  }

  const firstMonth = new Date(
    datedTransactions[0].parsed.getFullYear(),
    datedTransactions[0].parsed.getMonth(),
    1,
  );
  const lastMonth = new Date(
    datedTransactions[datedTransactions.length - 1].parsed.getFullYear(),
    datedTransactions[datedTransactions.length - 1].parsed.getMonth(),
    1,
  );

  const trend: CashflowTrend[] = [];
  const cursor = new Date(firstMonth);

  while (cursor.getTime() <= lastMonth.getTime()) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    const bucket = buckets.get(key);
    const income = roundMoney(bucket?.income || 0);
    const expenses = roundMoney(bucket?.expenses || 0);

    trend.push({
      month: cursor.toLocaleDateString('en-US', { month: 'long' }),
      year,
      income,
      expenses,
      net: roundMoney(income - expenses),
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return trend;
}

function buildCashBalanceHistory(trend: CashflowTrend[], currentCashBalance?: number | null) {
  if (currentCashBalance === null || currentCashBalance === undefined || trend.length === 0) {
    return [] as Array<{ label: string; value: number }>;
  }

  const visibleTrend = trimTrailingEmptyTrendMonths(trend);
  if (visibleTrend.length === 0) {
    return [] as Array<{ label: string; value: number }>;
  }

  const balances: Array<{ label: string; value: number }> = new Array(visibleTrend.length);
  let runningCash = roundMoney(Number(currentCashBalance || 0));

  for (let index = visibleTrend.length - 1; index >= 0; index -= 1) {
    const item = visibleTrend[index];
    balances[index] = {
      label: shortMonthLabel(item.month, item.year),
      value: runningCash,
    };
    runningCash = roundMoney(runningCash - Number(item.net || 0));
  }

  return balances;
}

function deltaTone(value: number) {
  if (value > 0) return 'text-emerald-700';
  if (value < 0) return 'text-rose-700';
  return 'text-slate-500';
}

function reserveTone(runwayMonths: number | null) {
  if (runwayMonths === null) return 'text-slate-500';
  if (runwayMonths >= 6) return 'text-emerald-700';
  if (runwayMonths >= 3) return 'text-amber-700';
  return 'text-rose-700';
}

function syncTone(daysSinceLastLiveFeed: number | null) {
  if (daysSinceLastLiveFeed === null) return 'text-slate-500';
  if (daysSinceLastLiveFeed <= 7) return 'text-emerald-700';
  if (daysSinceLastLiveFeed <= 21) return 'text-amber-700';
  return 'text-rose-700';
}

function needsCategorizationAttention(transaction: Transaction) {
  const category = String(transaction.category || 'Uncategorized');
  return !transaction.scheduleELine
    || !transaction.accountCode
    || category === 'Other Expenses'
    || category === 'Other Income'
    || category === 'Uncategorized';
}

function normalizeVendorAlias(vendor?: string | null) {
  return String(vendor || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function sourceMixSegmentClass(kind: SourceKind) {
  switch (kind) {
    case 'sample':
      return 'bg-amber-400';
    case 'stripe':
      return 'bg-violet-500';
    case 'bank':
      return 'bg-sky-500';
    case 'manual':
      return 'bg-slate-500';
    case 'qbo':
      return 'bg-emerald-500';
    case 'receipt':
      return 'bg-indigo-500';
    default:
      return 'bg-slate-300';
  }
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <div className="text-base font-semibold text-slate-900">{title}</div>
      {subtitle && <div className="mt-1 text-xs text-slate-500">{subtitle}</div>}
    </div>
  );
}

function AnalyticsMetric({
  label,
  value,
  hint,
  explain,
}: {
  label: string;
  value: string;
  hint: string;
  /** When provided, renders a small "Explain" trigger grounded in these citations. */
  explain?: { metricId: string; detail: string; citations: string[] };
}) {
  return (
    <div className="relative rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
        {explain && (
          <MetricExplainButton
            surface="bookkeeping"
            metricId={explain.metricId}
            label={label}
            value={value}
            detail={explain.detail}
            citations={explain.citations}
          />
        )}
      </div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
      <div className="mt-1 text-[11px] text-slate-500">{hint}</div>
    </div>
  );
}

function SimpleLineChart({
  points,
  color,
  emptyText,
  formatLabel,
}: {
  points: Array<{ label: string; value: number }>;
  color: string;
  emptyText: string;
  formatLabel?: (value: number) => string;
}) {
  if (points.length === 0) {
    return (
      <div className="flex h-44 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        {emptyText}
      </div>
    );
  }

  const width = 520;
  const height = 180;
  const padLeft = 36;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 28;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const maxValue = Math.max(...points.map((point) => point.value), 0, 1);
  const minValue = Math.min(...points.map((point) => point.value), 0);
  const range = maxValue - minValue || 1;
  const path = points.map((point, index) => {
    const x = padLeft + (index / Math.max(points.length - 1, 1)) * plotWidth;
    const y = padTop + ((maxValue - point.value) / range) * plotHeight;
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full">
      {[maxValue, maxValue - range / 2, minValue].map((tick, index) => {
        const y = padTop + ((maxValue - tick) / range) * plotHeight;
        return (
          <g key={`line-tick-${index}`}>
            <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />
            <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
              {formatLabel ? formatLabel(tick) : fmtMoney(tick)}
            </text>
          </g>
        );
      })}
      <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((point, index) => {
        const x = padLeft + (index / Math.max(points.length - 1, 1)) * plotWidth;
        const y = padTop + ((maxValue - point.value) / range) * plotHeight;
        const showLabel = points.length <= 6 || index === 0 || index === points.length - 1 || index % 4 === 0;
        return (
          <g key={`point-${point.label}`}>
            <circle cx={x} cy={y} r="3.5" fill={color} />
            {showLabel && (
              <text x={x} y={height - 8} textAnchor="middle" fontSize="10" fill="#64748b">
                {point.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

const DONUT_COLORS = [chartColor(0), chartColor(3), chartColor(7), chartColor(2), chartColor(5), chartColor(4)];

function ExpenseCategoryDonut({
  buckets,
  total,
  onSelectCategory,
}: {
  buckets: Array<{ category: string; amount: number }>;
  total: number;
  onSelectCategory?: (type: 'income' | 'expense', category: string) => void;
}) {
  const top = buckets.slice(0, 5);
  const otherAmount = Math.max(0, total - top.reduce((sum, bucket) => sum + bucket.amount, 0));
  const segments = [
    ...top.map((bucket, index) => ({ label: bucket.category, amount: bucket.amount, color: DONUT_COLORS[index], selectable: true })),
    ...(otherAmount > 0 ? [{ label: 'Other', amount: otherAmount, color: DONUT_COLORS[5], selectable: false }] : []),
  ].filter((segment) => segment.amount > 0);
  const segmentTotal = segments.reduce((sum, segment) => sum + segment.amount, 0);

  const size = 168;
  const radius = 58;
  const strokeWidth = 24;
  const circumference = 2 * Math.PI * radius;

  let cumulative = 0;
  const arcs = segments.map((segment) => {
    const fraction = segmentTotal > 0 ? segment.amount / segmentTotal : 0;
    const arc = { ...segment, fraction, offset: cumulative };
    cumulative += fraction;
    return arc;
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Expense category breakdown"
        subtitle="Share of posted expense spend by canonical category in this ledger window."
      />
      {segments.length === 0 ? (
        <div className="mt-4 flex h-44 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white text-sm text-slate-500">
          No posted expense categories in this ledger window yet.
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-white bg-white p-4">
          <div className="flex flex-wrap items-center justify-center gap-5">
            <svg viewBox={`0 0 ${size} ${size}`} className="h-40 w-40" role="img" aria-label="Expense category donut chart">
              <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
                {arcs.map((arc) => (
                  <circle
                    key={`arc-${arc.label}`}
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={arc.color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${Math.max(arc.fraction * circumference - 1.5, 0)} ${circumference}`}
                    strokeDashoffset={-arc.offset * circumference}
                  />
                ))}
              </g>
              <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fontSize="13" fontWeight="600" fill="#0f172a">
                {fmtMoney(segmentTotal)}
              </text>
              <text x={size / 2} y={size / 2 + 13} textAnchor="middle" fontSize="9" fill="#94a3b8">
                TOTAL EXPENSES
              </text>
            </svg>
            <div className="min-w-[11rem] flex-1 space-y-1.5">
              {arcs.map((arc) => {
                const pct = segmentTotal > 0 ? Math.round((arc.amount / segmentTotal) * 100) : 0;
                const row = (
                  <>
                    <span className="flex items-center gap-2 text-slate-700">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: arc.color }} />
                      <span className="truncate font-medium">{arc.label}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-slate-900">
                      {fmtMoney(arc.amount)}
                      <span className="ml-1.5 text-[11px] font-semibold text-slate-400">{pct}%</span>
                    </span>
                  </>
                );
                return arc.selectable && onSelectCategory ? (
                  <button
                    key={`legend-${arc.label}`}
                    type="button"
                    onClick={() => onSelectCategory('expense', arc.label)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1 text-left text-xs transition hover:bg-slate-50"
                  >
                    {row}
                  </button>
                ) : (
                  <div key={`legend-${arc.label}`} className="flex items-center justify-between gap-3 px-2 py-1 text-xs">
                    {row}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NetCashflowBarChart({ data }: { data: CashflowTrend[] }) {
  const series = trimTrailingEmptyTrendMonths(data).slice(-12);

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Net cash flow by month"
        subtitle="Month-over-month posted net movement; green months added cash, red months burned it."
      />
      {series.length === 0 ? (
        <div className="mt-4 flex h-44 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white text-sm text-slate-500">
          Net cash-flow bars will populate once monthly ledger periods are in scope.
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-white bg-white p-4">
          {(() => {
            const width = 520;
            const height = 180;
            const padLeft = 44;
            const padRight = 14;
            const padTop = 14;
            const padBottom = 26;
            const plotWidth = width - padLeft - padRight;
            const plotHeight = height - padTop - padBottom;
            const maxValue = Math.max(...series.map((item) => item.net), 0, 1);
            const minValue = Math.min(...series.map((item) => item.net), 0);
            const range = maxValue - minValue || 1;
            const zeroY = padTop + (maxValue / range) * plotHeight;
            const groupWidth = plotWidth / series.length;
            const barWidth = Math.min(26, groupWidth * 0.6);

            return (
              <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full" role="img" aria-label="Net cash flow by month bar chart">
                {[maxValue, 0, minValue].filter((tick, index, ticks) => ticks.indexOf(tick) === index).map((tick) => {
                  const y = padTop + ((maxValue - tick) / range) * plotHeight;
                  return (
                    <g key={`net-tick-${tick}`}>
                      <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke={tick === 0 ? '#cbd5e1' : '#e2e8f0'} strokeWidth={tick === 0 ? 1.2 : 1} />
                      <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                        {fmtMoney(tick)}
                      </text>
                    </g>
                  );
                })}
                {series.map((item, index) => {
                  const x = padLeft + groupWidth * index + (groupWidth - barWidth) / 2;
                  const valueY = padTop + ((maxValue - item.net) / range) * plotHeight;
                  const barTop = Math.min(valueY, zeroY);
                  const barHeight = Math.max(Math.abs(valueY - zeroY), 1.5);
                  const showLabel = series.length <= 7 || index === 0 || index === series.length - 1 || index % 2 === 0;
                  return (
                    <g key={`net-bar-${item.month}-${item.year}`}>
                      <rect
                        x={x}
                        y={barTop}
                        width={barWidth}
                        height={barHeight}
                        rx="4"
                        fill={item.net >= 0 ? '#10b981' : '#fb7185'}
                        opacity="0.9"
                      />
                      {showLabel && (
                        <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" fontSize="10" fill="#64748b">
                          {shortMonthLabel(item.month, item.year)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function CumulativeFlowChart({ data }: { data: CashflowTrend[] }) {
  const series = trimTrailingEmptyTrendMonths(data).slice(-12);
  let runningIncome = 0;
  let runningExpenses = 0;
  const points = series.map((item) => {
    runningIncome = roundMoney(runningIncome + Number(item.income || 0));
    runningExpenses = roundMoney(runningExpenses + Number(item.expenses || 0));
    return {
      label: shortMonthLabel(item.month, item.year),
      income: runningIncome,
      expenses: runningExpenses,
    };
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Cumulative income vs expenses"
        subtitle="Running totals across the visible ledger window; the gap between the lines is cumulative net."
      />
      {points.length === 0 ? (
        <div className="mt-4 flex h-44 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white text-sm text-slate-500">
          Cumulative lines will populate once monthly ledger periods are in scope.
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-white bg-white p-4">
          <div className="mb-2 flex flex-wrap items-center gap-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <span className="inline-flex items-center gap-2"><span className="h-0.5 w-4 rounded-full bg-emerald-500" />Income</span>
            <span className="inline-flex items-center gap-2"><span className="h-0.5 w-4 rounded-full bg-rose-400" />Expenses</span>
          </div>
          {(() => {
            const width = 520;
            const height = 180;
            const padLeft = 44;
            const padRight = 14;
            const padTop = 12;
            const padBottom = 26;
            const plotWidth = width - padLeft - padRight;
            const plotHeight = height - padTop - padBottom;
            const maxValue = Math.max(...points.map((point) => Math.max(point.income, point.expenses)), 1);
            const xFor = (index: number) => padLeft + (index / Math.max(points.length - 1, 1)) * plotWidth;
            const yFor = (value: number) => padTop + ((maxValue - value) / maxValue) * plotHeight;
            const incomePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point.income)}`).join(' ');
            const expensePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point.expenses)}`).join(' ');
            const incomeArea = `${incomePath} L ${xFor(points.length - 1)} ${yFor(0)} L ${xFor(0)} ${yFor(0)} Z`;

            return (
              <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full" role="img" aria-label="Cumulative income versus expenses line chart">
                {[maxValue, maxValue / 2, 0].map((tick) => {
                  const y = yFor(tick);
                  return (
                    <g key={`cumulative-tick-${tick}`}>
                      <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />
                      <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                        {fmtMoney(tick)}
                      </text>
                    </g>
                  );
                })}
                <path d={incomeArea} fill="#10b981" opacity="0.08" />
                <path d={incomePath} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d={expensePath} fill="none" stroke="#fb7185" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                {points.map((point, index) => {
                  const showLabel = points.length <= 7 || index === 0 || index === points.length - 1 || index % 2 === 0;
                  return (
                    <g key={`cumulative-point-${point.label}-${index}`}>
                      <circle cx={xFor(index)} cy={yFor(point.income)} r="3" fill="#10b981" />
                      <circle cx={xFor(index)} cy={yFor(point.expenses)} r="3" fill="#fb7185" />
                      {showLabel && (
                        <text x={xFor(index)} y={height - 8} textAnchor="middle" fontSize="10" fill="#64748b">
                          {point.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function CashflowTrendChart({ data }: { data: CashflowTrend[] }) {
  const trimmedSeries = trimTrailingEmptyTrendMonths(data);
  const series = trimmedSeries.slice(-6);

  if (series.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        Monthly cash-flow charts will populate once canonical ledger periods are in scope.
      </div>
    );
  }

  const width = 640;
  const height = 240;
  const padLeft = 40;
  const padRight = 20;
  const padTop = 18;
  const padBottom = 34;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const maxValue = Math.max(...series.map((item) => Math.max(item.income, item.expenses, item.net, 0)), 1);
  const minValue = Math.min(...series.map((item) => Math.min(item.net, 0)), 0);
  const range = maxValue - minValue || 1;
  const zeroY = padTop + ((maxValue - 0) / range) * plotHeight;
  const groupWidth = plotWidth / series.length;
  const barWidth = Math.min(18, groupWidth * 0.22);

  const netPath = series.map((item, index) => {
    const x = padLeft + groupWidth * index + groupWidth / 2;
    const y = padTop + ((maxValue - item.net) / range) * plotHeight;
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  const ticks = Array.from({ length: 4 }, (_, index) => maxValue - (range / 3) * index);
  if (minValue < 0) ticks.push(minValue);

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />Income</span>
        <span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-rose-400" />Expenses</span>
        <span className="inline-flex items-center gap-2"><span className="h-0.5 w-4 rounded-full bg-slate-800" />Net</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full">
        {ticks.map((tick, index) => {
          const y = padTop + ((maxValue - tick) / range) * plotHeight;
          return (
            <g key={`tick-${index}`}>
              <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={padLeft - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                {fmtMoney(tick)}
              </text>
            </g>
          );
        })}
        <line x1={padLeft} x2={width - padRight} y1={zeroY} y2={zeroY} stroke="#cbd5e1" strokeWidth="1.2" />
        {series.map((item, index) => {
          const groupX = padLeft + groupWidth * index;
          const incomeHeight = Math.max(0, zeroY - (padTop + ((maxValue - item.income) / range) * plotHeight));
          const expenseHeight = Math.max(0, zeroY - (padTop + ((maxValue - item.expenses) / range) * plotHeight));
          return (
            <g key={item.month}>
              <rect
                x={groupX + groupWidth * 0.18}
                y={zeroY - incomeHeight}
                width={barWidth}
                height={incomeHeight}
                rx="4"
                fill="#10b981"
                opacity="0.9"
              />
              <rect
                x={groupX + groupWidth * 0.52}
                y={zeroY - expenseHeight}
                width={barWidth}
                height={expenseHeight}
                rx="4"
                fill="#fb7185"
                opacity="0.85"
              />
              <text
                x={groupX + groupWidth / 2}
                y={height - 10}
                textAnchor="middle"
                fontSize="10"
                fill="#64748b"
              >
                {shortMonthLabel(item.month, item.year)}
              </text>
            </g>
          );
        })}
        <path d={netPath} fill="none" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {series.map((item, index) => {
          const x = padLeft + groupWidth * index + groupWidth / 2;
          const y = padTop + ((maxValue - item.net) / range) * plotHeight;
          return <circle key={`net-${item.month}`} cx={x} cy={y} r="3.5" fill="#0f172a" />;
        })}
      </svg>
    </div>
  );
}

function CashBalanceHistoryChart({
  points,
}: {
  points: Array<{ label: string; value: number }>;
}) {
  const series = points.slice(-6);

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionTitle
          title="Cash balance by month"
          subtitle="Ending operating cash reconstructed from the current balance and each visible month's posted net movement."
        />
        {series.length > 0 && (
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {fmtMoney(series[0].value)} to {fmtMoney(series[series.length - 1].value)}
          </div>
        )}
      </div>
      <div className="rounded-2xl border border-white bg-white p-4">
        <SimpleLineChart
          points={series}
          color="#0f766e"
          emptyText="Cash history needs a current cash balance plus posted monthly periods in scope."
        />
      </div>
      <div className="mt-3 text-xs text-slate-500">
        One-off non-operating cash movements stay embedded in the opening level unless they are represented in the visible ledger trend.
      </div>
    </div>
  );
}

function CategoryMixList({
  title,
  total,
  colorClass,
  items,
  emptyText,
  type,
  onSelectCategory,
}: {
  title: string;
  total: number;
  colorClass: string;
  items: Array<{ category: string; amount: number }>;
  emptyText: string;
  type: 'income' | 'expense';
  onSelectCategory?: (type: 'income' | 'expense', category: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle title={title} subtitle={`Top canonical ${type} categories in this window`} />
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">{fmtMoney(total)}</div>
      </div>
      <div className="mt-4 space-y-3">
        {items.length === 0 && <div className="text-sm text-slate-500">{emptyText}</div>}
        {items.map((item) => {
          const pct = total > 0 ? Math.round((item.amount / total) * 100) : 0;
          return (
            <button
              key={`${type}-${item.category}`}
              type="button"
              onClick={() => onSelectCategory?.(type, item.category)}
              className="w-full rounded-xl border border-white bg-white px-3 py-3 text-left transition hover:border-slate-200 hover:bg-slate-50"
            >
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-slate-900">{item.category}</span>
                <span className="font-semibold tabular-nums text-slate-700">{fmtMoney(item.amount)}</span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${Math.max(pct, 6)}%` }} />
                </div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{pct}%</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BaselineComparison({
  current,
  baseline,
}: {
  current: CashflowTrend | null;
  baseline: { income: number; expenses: number; net: number } | null;
}) {
  const rows = [
    { key: 'income', label: 'Income', tone: 'bg-emerald-500' },
    { key: 'expenses', label: 'Expenses', tone: 'bg-rose-400' },
    { key: 'net', label: 'Net', tone: 'bg-slate-800' },
  ] as const;

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Baseline vs actual"
        subtitle="Derived operating baseline from the prior months in this ledger window until explicit budgets are added."
      />
      {!current || !baseline ? (
        <div className="mt-4 text-sm text-slate-500">Need at least two months of trend data to compare actuals to a baseline.</div>
      ) : (
        <div className="mt-4 space-y-4">
          {rows.map((row) => {
            const actual = current[row.key];
            const target = baseline[row.key];
            const delta = actual - target;
            const width = target === 0 ? 100 : Math.min(160, Math.max(8, (Math.abs(actual) / Math.abs(target || 1)) * 100));
            return (
              <div key={row.key}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-slate-900">{row.label}</span>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums text-slate-900">{fmtMoney(actual)}</div>
                    <div className={`text-[11px] font-semibold ${deltaTone(delta)}`}>
                      {delta >= 0 ? '+' : ''}{fmtMoney(delta)} vs baseline {fmtMoney(target)}
                    </div>
                  </div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className={`h-full rounded-full ${row.tone}`} style={{ width: `${width}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FlowMap({
  income,
  expenses,
  net,
  expenseBuckets,
}: {
  income: number;
  expenses: number;
  net: number;
  expenseBuckets: Array<{ category: string; amount: number }>;
}) {
  const topExpenseBuckets = expenseBuckets.slice(0, 4);
  const otherExpenses = Math.max(0, expenses - topExpenseBuckets.reduce((sum, bucket) => sum + bucket.amount, 0));
  const segments = [
    ...topExpenseBuckets.map((bucket) => ({
      label: bucket.category,
      amount: bucket.amount,
      className: 'bg-rose-400',
    })),
    ...(otherExpenses > 0 ? [{ label: 'Other expenses', amount: otherExpenses, className: 'bg-rose-300' }] : []),
    ...(net >= 0
      ? [{ label: 'Retained cash', amount: net, className: 'bg-emerald-500' }]
      : [{ label: 'Operating gap', amount: Math.abs(net), className: 'bg-amber-400' }]),
  ].filter((segment) => segment.amount > 0);
  const totalFlow = Math.max(segments.reduce((sum, segment) => sum + segment.amount, 0), 1);

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Money flow map"
        subtitle="Sankey-style allocation of posted income into expense outflows and retained cash for this window."
      />
      <div className="mt-4 rounded-xl border border-white bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Posted income</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(income)}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Expense outflow</div>
            <div className="mt-1 font-semibold text-slate-900">{fmtMoney(expenses)}</div>
          </div>
        </div>
        <div className="mt-4 flex h-5 overflow-hidden rounded-full bg-slate-200">
          {segments.map((segment) => (
            <div
              key={segment.label}
              className={segment.className}
              style={{ width: `${(segment.amount / totalFlow) * 100}%` }}
              title={`${segment.label}: ${fmtMoney(segment.amount)}`}
            />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {segments.map((segment) => (
            <div key={`legend-${segment.label}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${segment.className}`} />
                <span className="font-medium text-slate-700">{segment.label}</span>
              </div>
              <span className="font-semibold tabular-nums text-slate-900">{fmtMoney(segment.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ForecastPanel({
  forecastPoints,
  startingCash,
  weeklyIncome,
  weeklyExpenses,
}: {
  forecastPoints: Array<{ label: string; value: number }>;
  startingCash: number;
  weeklyIncome: number;
  weeklyExpenses: number;
}) {
  const endingCash = forecastPoints.length > 0 ? forecastPoints[forecastPoints.length - 1].value : startingCash;

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="13-week cash forecast"
        subtitle="Run-rate projection from posted income and expense history in this canonical ledger window."
      />
      <div className="mt-4 grid grid-cols-3 gap-3">
        <AnalyticsMetric label="Start cash" value={fmtMoney(startingCash)} hint="Current operating cash" />
        <AnalyticsMetric label="Weekly inflow" value={fmtMoney(weeklyIncome)} hint="Run-rate income assumption" />
        <AnalyticsMetric label="Week 13 cash" value={fmtMoney(endingCash)} hint="Projected ending cash" />
      </div>
      <div className="mt-4 rounded-2xl border border-white bg-white p-4">
        <SimpleLineChart
          points={forecastPoints}
          color="#0f766e"
          emptyText="Need posted ledger history before a 13-week forecast can be estimated."
        />
      </div>
      <div className="mt-3 text-xs text-slate-500">
        Assumes weekly expense pace of {fmtMoney(weeklyExpenses)} and weekly income pace of {fmtMoney(weeklyIncome)} until a dedicated forecast model is added.
      </div>
    </div>
  );
}

function ScheduleEForecastPanel({
  observedMonths,
  ytdIncome,
  ytdExpenses,
  projectedIncome,
  projectedExpenses,
  projectedNet,
  mappedExpenseCoverage,
}: {
  observedMonths: number;
  ytdIncome: number;
  ytdExpenses: number;
  projectedIncome: number;
  projectedExpenses: number;
  projectedNet: number;
  mappedExpenseCoverage: number | null;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Year-end Schedule E forecast"
        subtitle="Ledger-derived rental forecast using observed year-to-date activity and current tax mapping coverage."
      />
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AnalyticsMetric label="Observed months" value={String(observedMonths)} hint="Months with posted current-year activity" />
        <AnalyticsMetric label="Projected rents" value={fmtMoney(projectedIncome)} hint={`${fmtMoney(ytdIncome)} posted year-to-date`} />
        <AnalyticsMetric label="Projected expenses" value={fmtMoney(projectedExpenses)} hint={`${fmtMoney(ytdExpenses)} posted year-to-date`} />
        <AnalyticsMetric label="Projected net" value={fmtMoney(projectedNet)} hint={mappedExpenseCoverage !== null ? `${mappedExpenseCoverage.toFixed(0)}% expense-line tax mapping coverage` : 'No mapped current-year expense lines yet'} />
      </div>
      <div className="mt-4 rounded-xl border border-white bg-white px-4 py-3 text-sm text-slate-600">
        This projection annualizes the current rental ledger run rate for the remaining months of the year. It is a planning diagnostic, not a filed tax result.
      </div>
    </div>
  );
}

function VariancePanel({
  latestMonth,
  comparisons,
  onSelectCategory,
}: {
  latestMonth: string | null;
  comparisons: Array<{ category: string; current: number; baseline: number; delta: number }>;
  onSelectCategory?: (type: 'expense', category: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Expense variance"
        subtitle={latestMonth ? `Current month compared with the prior three-month average for ${fullMonthLabel(latestMonth)}.` : 'Need a current month plus prior months to surface variance.'}
      />
      <div className="mt-4 space-y-3">
        {comparisons.length === 0 && <div className="text-sm text-slate-500">No expense variance diagnostics available yet.</div>}
        {comparisons.map((comparison) => (
          <button
            key={`variance-${comparison.category}`}
            type="button"
            onClick={() => onSelectCategory?.('expense', comparison.category)}
            className="w-full rounded-xl border border-white bg-white px-4 py-3 text-left transition hover:border-slate-200 hover:bg-slate-50"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-medium text-slate-900">{comparison.category}</span>
              <span className={`font-semibold tabular-nums ${deltaTone(comparison.delta)}`}>{comparison.delta >= 0 ? '+' : ''}{fmtMoney(comparison.delta)}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Current {fmtMoney(comparison.current)} vs baseline {fmtMoney(comparison.baseline)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SpendSpikePanel({
  latestMonth,
  alerts,
  onSelectCategory,
}: {
  latestMonth: string | null;
  alerts: Array<{
    category: string;
    current: number;
    baseline: number;
    delta: number;
    multiplier: number | null;
    isNewCategory: boolean;
  }>;
  onSelectCategory?: (type: 'expense', category: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Unusual spend spikes"
        subtitle={latestMonth ? `Flags categories with materially elevated spend in ${fullMonthLabel(latestMonth)}.` : 'Need a current month plus prior months to detect spend spikes.'}
      />
      <div className="mt-4 space-y-3">
        {alerts.length === 0 && <div className="text-sm text-slate-500">No unusual expense spikes crossed the current alert thresholds.</div>}
        {alerts.map((alert) => (
          <button
            key={`spike-${alert.category}`}
            type="button"
            onClick={() => onSelectCategory?.('expense', alert.category)}
            className="w-full rounded-xl border border-white bg-white px-4 py-3 text-left transition hover:border-slate-200 hover:bg-slate-50"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-medium text-slate-900">{alert.category}</span>
              <span className="font-semibold tabular-nums text-rose-700">+{fmtMoney(alert.delta)}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Current {fmtMoney(alert.current)} vs baseline {fmtMoney(alert.baseline)}
              {alert.isNewCategory ? ' · new spend pattern' : alert.multiplier != null ? ` · ${alert.multiplier.toFixed(1)}x run rate` : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="mt-3 text-xs text-slate-500">
        Alerts trigger when a category lands at least 60% above baseline with a meaningful dollar jump, or when a newly active category posts a large first-month spend.
      </div>
    </div>
  );
}

function VendorConcentrationPanel({
  totalExpenses,
  vendors,
  onSelectVendor,
}: {
  totalExpenses: number;
  vendors: Array<{ vendor: string; amount: number }>;
  onSelectVendor?: (vendor: string) => void;
}) {
  const topThreeShare = totalExpenses > 0
    ? vendors.slice(0, 3).reduce((sum, vendor) => sum + vendor.amount, 0) / totalExpenses
    : 0;

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Vendor concentration"
        subtitle={`Top three vendors represent ${(topThreeShare * 100).toFixed(0)}% of posted expense spend in this window.`}
      />
      <div className="mt-4 space-y-3">
        {vendors.length === 0 && <div className="text-sm text-slate-500">No vendor-tagged expense activity is in scope yet.</div>}
        {vendors.map((vendor) => {
          const pct = totalExpenses > 0 ? (vendor.amount / totalExpenses) * 100 : 0;
          return (
            <button
              key={`vendor-${vendor.vendor}`}
              type="button"
              onClick={() => onSelectVendor?.(vendor.vendor)}
              className="w-full rounded-xl border border-white bg-white px-4 py-3 text-left transition hover:border-slate-200 hover:bg-slate-50"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span className="font-medium text-slate-900">{vendor.vendor}</span>
                <span className="font-semibold tabular-nums text-slate-700">{fmtMoney(vendor.amount)}</span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.max(pct, 6)}%` }} />
                </div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{pct.toFixed(0)}%</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AgingPanel({
  buckets,
  evidenceCoveragePct,
  evidenceTotalCount,
  evidencePendingCount,
  pendingFinanceDocumentsCount,
}: {
  buckets: Array<{ label: string; count: number }>;
  evidenceCoveragePct: number | null;
  evidenceTotalCount: number;
  evidencePendingCount: number;
  pendingFinanceDocumentsCount: number;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Exception aging and evidence coverage"
        subtitle="Open reconciliation timing plus coverage quality across receipts and bookkeeping finance documents."
      />
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {buckets.map((bucket) => (
          <AnalyticsMetric key={bucket.label} label={bucket.label} value={String(bucket.count)} hint="Open reconciliation exceptions" />
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-white bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">Evidence coverage</div>
            <div className="mt-1 text-xs text-slate-500">
              {evidenceCoveragePct !== null
                ? `${evidenceCoveragePct.toFixed(0)}% of indexed evidence is out of pending status.`
                : 'Coverage will appear once evidence records are indexed.'}
            </div>
          </div>
          <div className="text-right text-sm text-slate-700">
            <div className="font-semibold">{evidenceCoveragePct !== null ? `${evidenceCoveragePct.toFixed(0)}%` : '—'}</div>
            <div className="text-xs text-slate-500">{evidenceTotalCount} indexed · {evidencePendingCount} pending · {pendingFinanceDocumentsCount} docs in follow-up</div>
          </div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(evidenceCoveragePct || 0, 4)}%` }} />
        </div>
      </div>
    </div>
  );
}

function ProvenanceQualityPanel({
  sourceMix,
  uncategorizedCount,
  duplicateVendorClusters,
  daysSinceLastLiveFeed,
  lastLiveFeedDate,
}: {
  sourceMix: ReturnType<typeof buildFinanceSourceMix>;
  uncategorizedCount: number;
  duplicateVendorClusters: Array<{ key: string; variants: string[]; amount: number }>;
  daysSinceLastLiveFeed: number | null;
  lastLiveFeedDate: string | null;
}) {
  const sourceKinds: SourceKind[] = ['sample', 'stripe', 'bank', 'manual', 'qbo', 'receipt', 'other'];
  const duplicateRiskHint = duplicateVendorClusters.length > 0
    ? duplicateVendorClusters[0].variants.join(' / ')
    : 'No alias clusters detected in vendor-tagged expense rows';
  const freshnessValue = daysSinceLastLiveFeed === null
    ? '—'
    : daysSinceLastLiveFeed === 0
      ? 'Today'
      : `${daysSinceLastLiveFeed}d`;

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Source truth and data quality"
        subtitle="Persistent provenance plus the operational cleanup signals that still need human attention."
      />
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AnalyticsMetric
          label="Source mix"
          value={sourceMix.hasSample && sourceMix.hasLive ? 'Mixed' : sourceMix.hasSample ? 'Sample' : 'Live'}
          hint={buildFinanceSourceBreakdown(sourceMix) || 'No sourced rows in scope'}
        />
        <AnalyticsMetric
          label="Needs mapping"
          value={String(uncategorizedCount)}
          hint="Rows still missing a strong account or Schedule E mapping"
        />
        <AnalyticsMetric
          label="Vendor alias risk"
          value={String(duplicateVendorClusters.length)}
          hint={duplicateRiskHint}
        />
        <AnalyticsMetric
          label="Feed freshness"
          value={freshnessValue}
          hint={lastLiveFeedDate ? `Latest bank/Stripe/QBO row ${lastLiveFeedDate}` : 'No bank, Stripe, or QuickBooks-import rows in scope'}
        />
      </div>
      <div className="mt-4 rounded-xl border border-white bg-white px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">Provenance breakdown</div>
            <div className="mt-1 text-xs text-slate-500">{sourceMix.headline}</div>
          </div>
          <div className={`text-sm font-semibold ${syncTone(daysSinceLastLiveFeed)}`}>
            {daysSinceLastLiveFeed === null
              ? 'No live feed rows'
              : daysSinceLastLiveFeed <= 7
                ? 'Feed looks fresh'
                : daysSinceLastLiveFeed <= 21
                  ? 'Feed needs review soon'
                  : 'Feed may be stale'}
          </div>
        </div>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-200">
          {sourceKinds.filter((kind) => sourceMix.mix[kind] > 0).map((kind) => (
            <div
              key={kind}
              className={sourceMixSegmentClass(kind)}
              style={{ width: `${Math.max((sourceMix.mix[kind] / Math.max(sourceMix.total, 1)) * 100, 4)}%` }}
              title={`${kind}: ${sourceMix.mix[kind]}`}
            />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {duplicateVendorClusters.slice(0, 4).map((cluster) => (
            <div key={cluster.key} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
              <div className="font-semibold text-slate-900">Possible duplicate vendor</div>
              <div className="mt-1">{cluster.variants.join(' / ')}</div>
              <div className="mt-1 text-slate-500">{fmtMoney(cluster.amount)} combined spend in scope</div>
            </div>
          ))}
          {duplicateVendorClusters.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500 md:col-span-2">
              Vendor naming looks internally consistent in the current ledger window.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PortfolioBreakdownPanel({
  properties,
}: {
  properties: Array<{
    propertyId: string;
    income: number;
    expenses: number;
    net: number;
    repairs: number;
    repairBurdenPct: number | null;
    netContributionPct: number | null;
    cashBalance: number | null;
    reserveCoverageMonths: number | null;
  }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle
        title="Portfolio breakdown"
        subtitle="Property-tagged net contribution, repair burden, and cash coverage from the current canonical ledger window and property-scoped balance sheet."
      />
      <div className="mt-4 space-y-3">
        {properties.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-4 text-sm text-slate-500">
            Property ranking will appear once transactions are consistently tagged with property IDs.
          </div>
        )}
        {properties.map((property) => (
          <div key={property.propertyId} className="rounded-xl border border-white bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium text-slate-900">{property.propertyId}</div>
                <div className="mt-1 text-xs text-slate-500">
                  Income {fmtMoney(property.income)} · Expenses {fmtMoney(property.expenses)} · Repairs {fmtMoney(property.repairs)}
                </div>
              </div>
              <div className="text-right">
                <div className={`text-lg font-semibold ${deltaTone(property.net)}`}>{fmtMoney(property.net)}</div>
                <div className="text-[11px] text-slate-500">
                  {property.netContributionPct !== null
                    ? `${property.netContributionPct.toFixed(0)}% of portfolio net`
                    : 'No portfolio net share yet'}
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 text-xs text-slate-600 md:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="font-semibold text-slate-900">Repair burden</div>
                <div className="mt-1">{property.repairBurdenPct !== null ? `${property.repairBurdenPct.toFixed(0)}% of expenses` : 'No repair expense in scope'}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="font-semibold text-slate-900">Reserve coverage</div>
                <div className="mt-1">
                  {property.reserveCoverageMonths !== null
                    ? `${property.reserveCoverageMonths.toFixed(1)} months from ${fmtMoney(property.cashBalance)}`
                    : property.cashBalance !== null
                      ? 'Need expense pace before coverage can be estimated'
                      : 'Property cash balance is still loading'}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="font-semibold text-slate-900">Current net contribution</div>
                <div className="mt-1">Tracks which properties are driving the current ledger result.</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReservePosturePanel({
  reserveRunwayMonths,
  cashBalance,
  averageMonthlyExpenses,
}: {
  reserveRunwayMonths: number | null;
  cashBalance: number | null | undefined;
  averageMonthlyExpenses: number;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <SectionTitle title="Reserve posture" subtitle="Current cash coverage against the expense pace implied by the ledger trend." />
      <div className="mt-4 flex items-end justify-between gap-4">
        <div>
          <div className={`text-2xl font-semibold ${reserveTone(reserveRunwayMonths)}`}>
            {reserveRunwayMonths !== null ? `${reserveRunwayMonths.toFixed(1)} months` : 'No runway yet'}
          </div>
          <div className="mt-1 text-sm text-slate-500">
            {reserveRunwayMonths === null
              ? 'Need recurring expense history before reserve coverage can be estimated.'
              : reserveRunwayMonths >= 6
                ? 'Healthy reserve coverage relative to the current expense pace.'
                : reserveRunwayMonths >= 3
                  ? 'Usable reserve coverage, but tighter if new repairs or vacancies hit.'
                  : 'Reserve coverage is tight compared with recent expense burn.'}
          </div>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>{fmtMoney(cashBalance)} cash on hand</div>
          <div>{fmtMoney(averageMonthlyExpenses)} monthly burn baseline</div>
        </div>
      </div>
    </div>
  );
}

export default function BookkeepingAnalyticsWorkspace({
  summary,
  cashflowTrend,
  transactions,
  cashBalance,
  propertyCashBalances = {},
  reconExceptions,
  evidenceTotalCount,
  evidencePendingCount,
  pendingFinanceDocumentsCount,
  onSelectCategory,
  onSelectVendor,
  focusAsset,
}: BookkeepingAnalyticsWorkspaceProps) {
  const ledgerDerivedTrend = useMemo(
    () => buildCashflowTrendFromTransactions(transactions),
    [transactions],
  );
  const normalizedServerTrend = useMemo(
    () => trimTrailingEmptyTrendMonths(cashflowTrend),
    [cashflowTrend],
  );
  const analyticsTrend = useMemo(() => {
    if (ledgerDerivedTrend.length > 0) {
      return ledgerDerivedTrend;
    }

    return normalizedServerTrend;
  }, [ledgerDerivedTrend, normalizedServerTrend]);
  const cashBalanceHistory = useMemo(
    () => buildCashBalanceHistory(analyticsTrend, cashBalance),
    [analyticsTrend, cashBalance],
  );
  const expenseBuckets = useMemo(
    () => [...(summary?.expensesByCategory || [])]
      .filter((bucket) => Number(bucket.amount || 0) > 0)
      .sort((left, right) => Number(right.amount || 0) - Number(left.amount || 0)),
    [summary?.expensesByCategory],
  );
  const incomeBuckets = useMemo(
    () => [...(summary?.incomeByCategory || [])]
      .filter((bucket) => Number(bucket.amount || 0) > 0)
      .sort((left, right) => Number(right.amount || 0) - Number(left.amount || 0)),
    [summary?.incomeByCategory],
  );
  const currentMonth = analyticsTrend.length > 0 ? analyticsTrend[analyticsTrend.length - 1] : null;
  const baselineWindow = analyticsTrend.length > 1 ? analyticsTrend.slice(Math.max(0, analyticsTrend.length - 4), -1) : [];
  const baseline = baselineWindow.length > 0 ? {
    income: baselineWindow.reduce((sum, item) => sum + item.income, 0) / baselineWindow.length,
    expenses: baselineWindow.reduce((sum, item) => sum + item.expenses, 0) / baselineWindow.length,
    net: baselineWindow.reduce((sum, item) => sum + item.net, 0) / baselineWindow.length,
  } : null;
  const averageMonthlyExpenses = baseline?.expenses || (analyticsTrend.length > 0
    ? analyticsTrend.reduce((sum, item) => sum + item.expenses, 0) / analyticsTrend.length
    : 0);
  const averageMonthlyIncome = baseline?.income || (analyticsTrend.length > 0
    ? analyticsTrend.reduce((sum, item) => sum + item.income, 0) / analyticsTrend.length
    : 0);
  const averageMonthlyNet = baseline?.net || (analyticsTrend.length > 0
    ? analyticsTrend.reduce((sum, item) => sum + item.net, 0) / analyticsTrend.length
    : 0);
  const reserveRunwayMonths = cashBalance !== null && cashBalance !== undefined && averageMonthlyExpenses > 0
    ? cashBalance / averageMonthlyExpenses
    : null;
  const analysisYear = useMemo(() => {
    const transactionYears = transactions
      .map((transaction) => safeDate(transaction.date)?.getFullYear() ?? null)
      .filter((year): year is number => year !== null);

    if (transactionYears.length > 0) {
      return Math.max(...transactionYears);
    }

    const trendYears = analyticsTrend
      .map((item) => Number(item.year || 0))
      .filter((year) => Number.isFinite(year) && year > 0);

    if (trendYears.length > 0) {
      return Math.max(...trendYears);
    }

    return new Date().getFullYear();
  }, [analyticsTrend, transactions]);
  const currentYearTransactions = useMemo(
    () => transactions.filter((transaction) => safeDate(transaction.date)?.getFullYear() === analysisYear),
    [analysisYear, transactions],
  );
  const observedMonths = useMemo(
    () => Array.from(new Set(currentYearTransactions.map((transaction) => monthKey(transaction.date)).filter(Boolean))).sort(),
    [currentYearTransactions],
  );
  const monthsObservedCount = observedMonths.length;
  const ytdIncome = useMemo(
    () => currentYearTransactions
      .filter((transaction) => transaction.type === 'income')
      .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0),
    [currentYearTransactions],
  );
  const ytdExpenses = useMemo(
    () => currentYearTransactions
      .filter((transaction) => transaction.type === 'expense')
      .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0),
    [currentYearTransactions],
  );
  const remainingMonths = Math.max(0, 12 - monthsObservedCount);
  const currentYearMonthlyIncome = monthsObservedCount > 0 ? ytdIncome / monthsObservedCount : averageMonthlyIncome;
  const currentYearMonthlyExpenses = monthsObservedCount > 0 ? ytdExpenses / monthsObservedCount : averageMonthlyExpenses;
  const projectedYearIncome = ytdIncome + currentYearMonthlyIncome * remainingMonths;
  const projectedYearExpenses = ytdExpenses + currentYearMonthlyExpenses * remainingMonths;
  const projectedYearNet = projectedYearIncome - projectedYearExpenses;
  const mappedCurrentYearExpenses = useMemo(
    () => currentYearTransactions.filter((transaction) => transaction.type === 'expense' && transaction.scheduleELine),
    [currentYearTransactions],
  );
  const mappedExpenseCoverage = ytdExpenses > 0 && currentYearTransactions.filter((transaction) => transaction.type === 'expense').length > 0
    ? (mappedCurrentYearExpenses.length / currentYearTransactions.filter((transaction) => transaction.type === 'expense').length) * 100
    : null;
  const weeklyIncome = currentYearMonthlyIncome * 12 / 52;
  const weeklyExpenses = currentYearMonthlyExpenses * 12 / 52;
  const forecastPoints = useMemo(() => {
    const points: Array<{ label: string; value: number }> = [];
    let runningCash = Number(cashBalance || 0);
    for (let week = 1; week <= 13; week += 1) {
      runningCash += weeklyIncome - weeklyExpenses;
      points.push({ label: `W${week}`, value: Number(runningCash.toFixed(2)) });
    }
    return points;
  }, [cashBalance, weeklyExpenses, weeklyIncome]);
  const expenseTransactions = useMemo(
    () => transactions.filter((transaction) => transaction.type === 'expense'),
    [transactions],
  );
  const vendorSpend = useMemo(() => {
    const totals = new Map<string, number>();
    for (const transaction of expenseTransactions) {
      const vendor = String(transaction.vendor || '').trim();
      if (!vendor) continue;
      totals.set(vendor, (totals.get(vendor) || 0) + Math.abs(Number(transaction.amount || 0)));
    }
    return Array.from(totals.entries())
      .map(([vendor, amount]) => ({ vendor, amount }))
      .sort((left, right) => right.amount - left.amount)
      .slice(0, 5);
  }, [expenseTransactions]);
  const latestExpenseMonth = useMemo(() => {
    const keys = expenseTransactions.map((transaction) => monthKey(transaction.date)).filter(Boolean).sort();
    return keys.length > 0 ? keys[keys.length - 1] : null;
  }, [expenseTransactions]);
  const expenseVarianceComparisons = useMemo(() => {
    if (!latestExpenseMonth) return [];
    const latestMonthKey = latestExpenseMonth;
    const previousMonths = Array.from(new Set(
      expenseTransactions
        .map((transaction) => monthKey(transaction.date))
        .filter((key): key is string => Boolean(key) && key < latestMonthKey),
    )).sort().slice(-3);
    if (previousMonths.length === 0) return [];

    const currentTotals = new Map<string, number>();
    const baselineTotals = new Map<string, number>();

    for (const transaction of expenseTransactions) {
      const key = monthKey(transaction.date);
      if (!key) continue;
      const category = String(transaction.category || 'Uncategorized');
      const amount = Math.abs(Number(transaction.amount || 0));
      if (key === latestExpenseMonth) {
        currentTotals.set(category, (currentTotals.get(category) || 0) + amount);
      }
      if (previousMonths.includes(key)) {
        baselineTotals.set(category, (baselineTotals.get(category) || 0) + amount);
      }
    }

    const categories = Array.from(new Set([...currentTotals.keys(), ...baselineTotals.keys()]));
    return categories
      .map((category) => {
        const current = currentTotals.get(category) || 0;
        const baseline = (baselineTotals.get(category) || 0) / previousMonths.length;
        return {
          category,
          current,
          baseline,
          delta: current - baseline,
        };
      })
      .filter((comparison) => comparison.current > 0 || comparison.baseline > 0)
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
      .slice(0, 5);
  }, [expenseTransactions, latestExpenseMonth]);
  const spendSpikeAlerts = useMemo(() => {
    return expenseVarianceComparisons
      .map((comparison) => {
        const multiplier = comparison.baseline > 0 ? comparison.current / comparison.baseline : null;
        const isNewCategory = comparison.baseline === 0 && comparison.current >= 500;
        const exceedsRunRate = comparison.baseline > 0 && comparison.current >= comparison.baseline * 1.6 && comparison.delta >= 250;
        return {
          ...comparison,
          multiplier,
          isNewCategory,
          isSpike: isNewCategory || exceedsRunRate,
        };
      })
      .filter((alert) => alert.isSpike)
      .slice(0, 4);
  }, [expenseVarianceComparisons]);
  const exceptionAgingBuckets = useMemo(() => {
    const now = new Date();
    const buckets = [
      { label: '0-7 days', count: 0 },
      { label: '8-30 days', count: 0 },
      { label: '31-60 days', count: 0 },
      { label: '61+ days', count: 0 },
    ];

    for (const exception of reconExceptions) {
      const occurredAt = safeDate(exception.occurredAt);
      if (!occurredAt) {
        buckets[3].count += 1;
        continue;
      }
      const ageDays = Math.max(0, Math.floor((now.getTime() - occurredAt.getTime()) / (1000 * 60 * 60 * 24)));
      if (ageDays <= 7) buckets[0].count += 1;
      else if (ageDays <= 30) buckets[1].count += 1;
      else if (ageDays <= 60) buckets[2].count += 1;
      else buckets[3].count += 1;
    }

    return buckets;
  }, [reconExceptions]);
  const evidenceCoveragePct = evidenceTotalCount > 0
    ? ((evidenceTotalCount - evidencePendingCount) / evidenceTotalCount) * 100
    : null;
  const sourceMix = useMemo(() => buildFinanceSourceMix(transactions), [transactions]);
  const uncategorizedCount = useMemo(
    () => transactions.filter(needsCategorizationAttention).length,
    [transactions],
  );
  const duplicateVendorClusters = useMemo(() => {
    const clusters = new Map<string, { variants: Set<string>; amount: number }>();
    for (const transaction of expenseTransactions) {
      const rawVendor = String(transaction.vendor || '').trim();
      if (!rawVendor) continue;
      const key = normalizeVendorAlias(rawVendor);
      if (!key) continue;
      const current = clusters.get(key) || { variants: new Set<string>(), amount: 0 };
      current.variants.add(rawVendor);
      current.amount += Math.abs(Number(transaction.amount || 0));
      clusters.set(key, current);
    }
    return Array.from(clusters.entries())
      .map(([key, value]) => ({
        key,
        variants: Array.from(value.variants).sort(),
        amount: value.amount,
      }))
      .filter((cluster) => cluster.variants.length > 1)
      .sort((left, right) => right.amount - left.amount || right.variants.length - left.variants.length);
  }, [expenseTransactions]);
  const lastLiveFeedDate = useMemo(() => {
    const feedDates = transactions
      .filter((transaction) => {
        const kind = classifyFinanceSource(transaction.source).kind;
        return kind === 'stripe' || kind === 'bank' || kind === 'qbo';
      })
      .map((transaction) => safeDate(transaction.date))
      .filter((date): date is Date => Boolean(date))
      .sort((left, right) => right.getTime() - left.getTime());
    return feedDates.length > 0 ? feedDates[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  }, [transactions]);
  const daysSinceLastLiveFeed = useMemo(() => {
    const feedDates = transactions
      .filter((transaction) => {
        const kind = classifyFinanceSource(transaction.source).kind;
        return kind === 'stripe' || kind === 'bank' || kind === 'qbo';
      })
      .map((transaction) => safeDate(transaction.date))
      .filter((date): date is Date => Boolean(date))
      .sort((left, right) => right.getTime() - left.getTime());
    if (feedDates.length === 0) return null;
    return Math.max(0, Math.floor((Date.now() - feedDates[0].getTime()) / (1000 * 60 * 60 * 24)));
  }, [transactions]);
  const propertyBreakdown = useMemo(() => {
    const totals = new Map<string, { income: number; expenses: number; repairs: number; expenseMonths: Set<string> }>();
    for (const transaction of transactions) {
      const propertyKey = String(transaction.propertyId || '').trim();
      if (!propertyKey) continue;
      const current = totals.get(propertyKey) || { income: 0, expenses: 0, repairs: 0, expenseMonths: new Set<string>() };
      const amount = Math.abs(Number(transaction.amount || 0));
      if (transaction.type === 'income') {
        current.income += amount;
      } else {
        current.expenses += amount;
        const expenseMonth = monthKey(transaction.date);
        if (expenseMonth) {
          current.expenseMonths.add(expenseMonth);
        }
        const category = String(transaction.category || '').toLowerCase();
        if (transaction.scheduleELine === 14 || category.includes('repair')) {
          current.repairs += amount;
        }
      }
      totals.set(propertyKey, current);
    }

    const rows = Array.from(totals.entries()).map(([propertyId, value]) => {
      const cashBalanceForProperty = Object.prototype.hasOwnProperty.call(propertyCashBalances, propertyId)
        ? Number(propertyCashBalances[propertyId] || 0)
        : null;
      const monthlyExpensePace = value.expenseMonths.size > 0
        ? value.expenses / value.expenseMonths.size
        : null;

      return {
        propertyId,
        income: value.income,
        expenses: value.expenses,
        net: value.income - value.expenses,
        repairs: value.repairs,
        repairBurdenPct: value.expenses > 0 ? (value.repairs / value.expenses) * 100 : null,
        cashBalance: cashBalanceForProperty,
        reserveCoverageMonths: cashBalanceForProperty !== null && monthlyExpensePace && monthlyExpensePace > 0
          ? cashBalanceForProperty / monthlyExpensePace
          : null,
        netContributionPct: null as number | null,
      };
    });
    const portfolioNet = rows.reduce((sum, row) => sum + row.net, 0);

    return rows
      .map((row) => ({
        ...row,
        netContributionPct: portfolioNet !== 0 ? (row.net / portfolioNet) * 100 : null,
      }))
      .sort((left, right) => right.net - left.net)
      .slice(0, 6);
  }, [propertyCashBalances, transactions]);
  const analyticsExplanations = useMemo(() => {
    const dataQualityTotal = reconExceptions.length + evidencePendingCount + pendingFinanceDocumentsCount;
    return [
      {
        id: 'cash-balance',
        title: 'Why cash balance is this number',
        detail: `${fmtMoney(cashBalance)} reflects the canonical operating-cash balance in this analytics scope.`,
        citations: [
          sourceMix.headline,
          currentMonth ? `Latest visible month ${fullMonthLabel(currentMonth.month, currentMonth.year)} netted ${fmtMoney(currentMonth.net)}.` : 'No trailing month is available yet in the current chart window.',
          `${fmtMoney(summary?.totalIncome || 0)} income and ${fmtMoney(summary?.totalExpenses || 0)} expenses are in the current ledger-backed analytics scope.`,
        ],
      },
      {
        id: 'reserve-runway',
        title: 'Why reserve runway looks like this',
        detail: reserveRunwayMonths !== null
          ? `${reserveRunwayMonths.toFixed(1)} months of runway is derived from ${fmtMoney(cashBalance)} cash divided by ${fmtMoney(averageMonthlyExpenses)} monthly expense pace.`
          : 'Reserve runway is unavailable because the current scope does not have enough expense history to estimate monthly burn.',
        citations: [
          baseline ? `Baseline expense pace uses the trailing comparison window around ${fullMonthLabel(currentMonth?.month || '')}.` : 'The calculation falls back to the full visible cashflow trend because no shorter baseline window exists.',
          `${fmtMoney(averageMonthlyExpenses)} average monthly expenses in scope.`,
          reserveRunwayMonths !== null ? `Current reserve posture is ${reserveRunwayMonths >= 6 ? 'healthy' : reserveRunwayMonths >= 3 ? 'watch' : 'tight'}.` : 'No runway classification is available yet.',
        ],
      },
      {
        id: 'average-net',
        title: 'Why average net is this number',
        detail: `${fmtMoney(averageMonthlyNet)} is the trailing average monthly net derived from the visible cashflow history.`,
        citations: [
          `${fmtMoney(averageMonthlyIncome)} average monthly income in scope.`,
          `${fmtMoney(averageMonthlyExpenses)} average monthly expenses in scope.`,
          averageMonthlyIncome > 0 ? `${((averageMonthlyNet / averageMonthlyIncome) * 100).toFixed(1)}% trailing margin.` : 'There is no income trend yet to derive a meaningful trailing margin.',
        ],
      },
      {
        id: 'data-quality',
        title: 'Why data quality is flagged this way',
        detail: `${dataQualityTotal} total quality items are currently open across reconciliation, evidence, and finance documents.`,
        citations: [
          `${reconExceptions.length} reconciliation exception(s) are open.`,
          `${evidencePendingCount} evidence item(s) are still pending follow-up out of ${evidenceTotalCount}.`,
          `${pendingFinanceDocumentsCount} finance document(s) still need OCR or evidence completion.`,
        ],
      },
    ];
  }, [averageMonthlyExpenses, averageMonthlyIncome, averageMonthlyNet, baseline, cashBalance, currentMonth, evidencePendingCount, evidenceTotalCount, pendingFinanceDocumentsCount, reconExceptions.length, reserveRunwayMonths, sourceMix.headline, summary?.totalExpenses, summary?.totalIncome]);
  const explainFor = useMemo(() => {
    const byId = new Map(analyticsExplanations.map((item) => [item.id, item]));
    return (id: string) => {
      const item = byId.get(id);
      return item ? { metricId: item.id, detail: item.detail, citations: item.citations } : undefined;
    };
  }, [analyticsExplanations]);

  if (focusAsset) {
    switch (focusAsset) {
      case 'cashflow-trend':
        return <CashflowTrendChart data={analyticsTrend} />;
      case 'cash-balance-history':
        return <CashBalanceHistoryChart points={cashBalanceHistory} />;
      case 'cash-balance-metric':
        return (
          <AnalyticsMetric
            label="Cash balance"
            value={fmtMoney(cashBalance)}
            hint="Operating cash from account 1000"
            explain={explainFor('cash-balance')}
          />
        );
      case 'reserve-runway-metric':
        return (
          <AnalyticsMetric
            label="Reserve runway"
            value={reserveRunwayMonths !== null ? `${reserveRunwayMonths.toFixed(1)} mo` : '—'}
            hint={reserveRunwayMonths !== null ? `${fmtMoney(averageMonthlyExpenses)} avg monthly expense burn` : 'Need expense history to estimate runway'}
            explain={explainFor('reserve-runway')}
          />
        );
      case 'average-net-metric':
        return (
          <AnalyticsMetric
            label="Average net"
            value={fmtMoney(averageMonthlyNet)}
            hint={averageMonthlyIncome > 0 ? `${((averageMonthlyNet / averageMonthlyIncome) * 100).toFixed(1)}% trailing margin` : 'No income trend yet'}
            explain={explainFor('average-net')}
          />
        );
      case 'data-quality-metric':
        return (
          <AnalyticsMetric
            label="Data quality"
            value={`${reconExceptions.length + evidencePendingCount + pendingFinanceDocumentsCount}`}
            hint={`${reconExceptions.length} recon · ${evidencePendingCount} evidence · ${pendingFinanceDocumentsCount} docs`}
            explain={explainFor('data-quality')}
          />
        );
      case 'analytics-explanations':
        return (
          <div className="grid grid-cols-2 gap-3">
            <AnalyticsMetric
              label="Cash balance"
              value={fmtMoney(cashBalance)}
              hint="Operating cash from account 1000"
              explain={explainFor('cash-balance')}
            />
            <AnalyticsMetric
              label="Reserve runway"
              value={reserveRunwayMonths !== null ? `${reserveRunwayMonths.toFixed(1)} mo` : '—'}
              hint={reserveRunwayMonths !== null ? `${fmtMoney(averageMonthlyExpenses)} avg monthly expense burn` : 'Need expense history to estimate runway'}
              explain={explainFor('reserve-runway')}
            />
            <AnalyticsMetric
              label="Average net"
              value={fmtMoney(averageMonthlyNet)}
              hint={averageMonthlyIncome > 0 ? `${((averageMonthlyNet / averageMonthlyIncome) * 100).toFixed(1)}% trailing margin` : 'No income trend yet'}
              explain={explainFor('average-net')}
            />
            <AnalyticsMetric
              label="Data quality"
              value={`${reconExceptions.length + evidencePendingCount + pendingFinanceDocumentsCount}`}
              hint={`${reconExceptions.length} recon · ${evidencePendingCount} evidence · ${pendingFinanceDocumentsCount} docs`}
              explain={explainFor('data-quality')}
            />
          </div>
        );
      case 'reserve-posture':
        return (
          <ReservePosturePanel
            reserveRunwayMonths={reserveRunwayMonths}
            cashBalance={cashBalance}
            averageMonthlyExpenses={averageMonthlyExpenses}
          />
        );
      default:
        break;
    }
  }

  return (
    <Card>
      <div className="border-b border-slate-100 px-5 py-4">
        <SectionTitle
          title="Analytics foundation"
          subtitle="Canonical finance visuals rebuilt directly from posted ledger output, current cash position, and close-quality signals."
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 p-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.9fr)]">
        <div className="space-y-4">
          <CashflowTrendChart data={analyticsTrend} />
          <CashBalanceHistoryChart points={cashBalanceHistory} />
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <AnalyticsMetric
              label="Cash balance"
              value={fmtMoney(cashBalance)}
              hint="Operating cash from account 1000"
              explain={explainFor('cash-balance')}
            />
            <AnalyticsMetric
              label="Reserve runway"
              value={reserveRunwayMonths !== null ? `${reserveRunwayMonths.toFixed(1)} mo` : '—'}
              hint={reserveRunwayMonths !== null ? `${fmtMoney(averageMonthlyExpenses)} avg monthly expense burn` : 'Need expense history to estimate runway'}
              explain={explainFor('reserve-runway')}
            />
            <AnalyticsMetric
              label="Average net"
              value={fmtMoney(averageMonthlyNet)}
              hint={averageMonthlyIncome > 0 ? `${((averageMonthlyNet / averageMonthlyIncome) * 100).toFixed(1)}% trailing margin` : 'No income trend yet'}
              explain={explainFor('average-net')}
            />
            <AnalyticsMetric
              label="Data quality"
              value={`${reconExceptions.length + evidencePendingCount + pendingFinanceDocumentsCount}`}
              hint={`${reconExceptions.length} recon · ${evidencePendingCount} evidence · ${pendingFinanceDocumentsCount} docs`}
              explain={explainFor('data-quality')}
            />
          </div>

          <ReservePosturePanel
            reserveRunwayMonths={reserveRunwayMonths}
            cashBalance={cashBalance}
            averageMonthlyExpenses={averageMonthlyExpenses}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 lg:grid-cols-2 xl:grid-cols-3">
        <ExpenseCategoryDonut
          buckets={expenseBuckets}
          total={summary?.totalExpenses || 0}
          onSelectCategory={onSelectCategory}
        />
        <NetCashflowBarChart data={analyticsTrend} />
        <CumulativeFlowChart data={analyticsTrend} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <BaselineComparison current={currentMonth} baseline={baseline} />
        <FlowMap
          income={summary?.totalIncome || 0}
          expenses={summary?.totalExpenses || 0}
          net={summary?.netIncome || 0}
          expenseBuckets={expenseBuckets}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-2">
        <ForecastPanel
          forecastPoints={forecastPoints}
          startingCash={Number(cashBalance || 0)}
          weeklyIncome={weeklyIncome}
          weeklyExpenses={weeklyExpenses}
        />
        <ScheduleEForecastPanel
          observedMonths={monthsObservedCount}
          ytdIncome={ytdIncome}
          ytdExpenses={ytdExpenses}
          projectedIncome={projectedYearIncome}
          projectedExpenses={projectedYearExpenses}
          projectedNet={projectedYearNet}
          mappedExpenseCoverage={mappedExpenseCoverage}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 lg:grid-cols-2">
        <CategoryMixList
          title="Expense category mix"
          total={summary?.totalExpenses || 0}
          colorClass="bg-rose-400"
          items={expenseBuckets.slice(0, 6)}
          emptyText="No posted expense categories in this ledger window."
          type="expense"
          onSelectCategory={onSelectCategory}
        />
        <CategoryMixList
          title="Income category mix"
          total={summary?.totalIncome || 0}
          colorClass="bg-emerald-500"
          items={incomeBuckets.slice(0, 6)}
          emptyText="No posted income categories in this ledger window."
          type="income"
          onSelectCategory={onSelectCategory}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <ProvenanceQualityPanel
          sourceMix={sourceMix}
          uncategorizedCount={uncategorizedCount}
          duplicateVendorClusters={duplicateVendorClusters}
          daysSinceLastLiveFeed={daysSinceLastLiveFeed}
          lastLiveFeedDate={lastLiveFeedDate}
        />
        <PortfolioBreakdownPanel properties={propertyBreakdown} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-2">
        <VariancePanel
          latestMonth={latestExpenseMonth}
          comparisons={expenseVarianceComparisons}
          onSelectCategory={onSelectCategory}
        />
        <SpendSpikePanel
          latestMonth={latestExpenseMonth}
          alerts={spendSpikeAlerts}
          onSelectCategory={onSelectCategory}
        />
        <VendorConcentrationPanel
          totalExpenses={summary?.totalExpenses || 0}
          vendors={vendorSpend}
          onSelectVendor={onSelectVendor}
        />
        <AgingPanel
          buckets={exceptionAgingBuckets}
          evidenceCoveragePct={evidenceCoveragePct}
          evidenceTotalCount={evidenceTotalCount}
          evidencePendingCount={evidencePendingCount}
          pendingFinanceDocumentsCount={pendingFinanceDocumentsCount}
        />
      </div>
    </Card>
  );
}