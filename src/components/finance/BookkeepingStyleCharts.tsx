import { chartColor } from '../../design-system';

/**
 * Shared bookkeeping-style chart primitives used by Bookkeeping Analytics and
 * Properties Overview so portfolio rollups match the ledger visual language.
 */

function fmtMoney(value: number | null | undefined) {
  const amount = Number(value || 0);
  const abs = Math.abs(amount);
  const formatted = abs >= 1000
    ? `$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`.replace(/\.0k$/, 'k')
    : `$${Math.round(abs).toLocaleString()}`;
  return amount < 0 ? `-${formatted}` : formatted;
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <div className="text-base font-semibold tracking-tight text-slate-900">{title}</div>
      {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
    </div>
  );
}

const DONUT_COLORS = [chartColor(0), chartColor(3), chartColor(7), chartColor(2), chartColor(5), chartColor(4)];

export type ExpenseBucket = { category: string; amount: number };

export function ExpenseCategoryDonut({
  buckets,
  total,
  title = 'Expense category breakdown',
  subtitle = 'Share of operating spend by category across the properties in scope.',
  emptyLabel = 'No expense categories available yet.',
}: {
  buckets: ExpenseBucket[];
  total: number;
  title?: string;
  subtitle?: string;
  emptyLabel?: string;
}) {
  const sorted = [...buckets].filter((bucket) => Number(bucket.amount || 0) > 0)
    .sort((left, right) => Number(right.amount || 0) - Number(left.amount || 0));
  const top = sorted.slice(0, 5);
  const otherAmount = Math.max(0, total - top.reduce((sum, bucket) => sum + bucket.amount, 0));
  const segments = [
    ...top.map((bucket, index) => ({ label: bucket.category, amount: bucket.amount, color: DONUT_COLORS[index] })),
    ...(otherAmount > 0 ? [{ label: 'Other', amount: otherAmount, color: DONUT_COLORS[5] }] : []),
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
    <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <SectionTitle title={title} subtitle={subtitle} />
      {segments.length === 0 ? (
        <div className="mt-4 flex flex-1 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
          {emptyLabel}
        </div>
      ) : (
        <div className="mt-5 flex flex-1 flex-col">
          <div className="flex justify-center">
            <svg viewBox={`0 0 ${size} ${size}`} className="h-44 w-44" role="img" aria-label={title}>
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
              <text x={size / 2} y={size / 2 - 4} textAnchor="middle" fontSize="15" fontWeight="700" fill="#0f172a">
                {fmtMoney(segmentTotal)}
              </text>
              <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fontSize="9" letterSpacing="0.08em" fill="#94a3b8">
                TOTAL EXPENSES
              </text>
            </svg>
          </div>
          <div className="mt-5 space-y-2.5 border-t border-slate-100 pt-4">
            {arcs.map((arc) => {
              const pct = segmentTotal > 0 ? Math.round((arc.amount / segmentTotal) * 100) : 0;
              return (
                <div key={`legend-${arc.label}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2.5 text-slate-700">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: arc.color }} />
                    <span className="truncate font-medium">{arc.label}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-semibold text-slate-900">{fmtMoney(arc.amount)}</span>
                    <span className="ml-2 text-xs font-medium text-slate-400">{pct}%</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function MoneyFlowMap({
  income,
  expenses,
  net,
  expenseBuckets,
  title = 'Money flow map',
  subtitle = 'How gross rental income splits into operating costs, debt service, and remaining cash flow.',
}: {
  income: number;
  expenses: number;
  net: number;
  expenseBuckets: ExpenseBucket[];
  title?: string;
  subtitle?: string;
}) {
  const topExpenseBuckets = [...expenseBuckets]
    .filter((bucket) => Number(bucket.amount || 0) > 0)
    .sort((left, right) => Number(right.amount || 0) - Number(left.amount || 0))
    .slice(0, 4);
  const otherExpenses = Math.max(0, expenses - topExpenseBuckets.reduce((sum, bucket) => sum + bucket.amount, 0));
  const segments = [
    ...topExpenseBuckets.map((bucket, index) => ({
      label: bucket.category,
      amount: bucket.amount,
      className: ['bg-rose-400', 'bg-orange-400', 'bg-amber-400', 'bg-fuchsia-400'][index] || 'bg-rose-300',
    })),
    ...(otherExpenses > 0 ? [{ label: 'Other expenses', amount: otherExpenses, className: 'bg-rose-300' }] : []),
    ...(net >= 0
      ? [{ label: 'Net cash flow', amount: net, className: 'bg-emerald-500' }]
      : [{ label: 'Cash deficit', amount: Math.abs(net), className: 'bg-amber-500' }]),
  ].filter((segment) => segment.amount > 0);
  const totalFlow = Math.max(segments.reduce((sum, segment) => sum + segment.amount, 0), 1);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <SectionTitle title={title} subtitle={subtitle} />
      <div className="mt-4 flex flex-1 flex-col rounded-xl border border-slate-100 bg-slate-50/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Gross rental income</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(income)}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Outflows</div>
            <div className="mt-1 font-semibold text-slate-900">{fmtMoney(expenses)}</div>
          </div>
        </div>
        {segments.length === 0 ? (
          <div className="mt-4 flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white text-sm text-slate-500">
            Cash-flow allocation will appear once rent and expenses are on file.
          </div>
        ) : (
          <>
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
            <div className="mt-4 grid flex-1 grid-cols-1 content-start gap-2 sm:grid-cols-2">
              {segments.map((segment) => (
                <div key={`legend-${segment.label}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${segment.className}`} />
                    <span className="truncate font-medium text-slate-700">{segment.label}</span>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums text-slate-900">{fmtMoney(segment.amount)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export type PropertyCashFlowBar = {
  id: string;
  label: string;
  color: string;
  income: number;
  expenses: number;
  cashFlow: number;
};

export function PropertyCashFlowBars({
  properties,
  title = 'Cash flow by property',
  subtitle = 'Annual rent, operating costs + debt, and remaining cash flow for every property in scope.',
}: {
  properties: PropertyCashFlowBar[];
  title?: string;
  subtitle?: string;
}) {
  const rows = properties.filter((property) => property.income > 0 || property.expenses > 0 || property.cashFlow !== 0);
  const maxAbs = Math.max(...rows.flatMap((row) => [row.income, row.expenses, Math.abs(row.cashFlow)]), 1);

  return (
    <div className="h-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <SectionTitle title={title} subtitle={subtitle} />
      {rows.length === 0 ? (
        <div className="mt-4 flex h-44 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
          Property cash-flow bars will appear once rent or expenses are on file.
        </div>
      ) : (
        <div className="mt-4 space-y-3.5">
          {rows.map((row) => {
            const shortLabel = row.label.split(',')[0] || row.label;
            return (
              <div key={row.id} className="space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2 font-medium text-slate-700">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                    <span className="truncate">{shortLabel}</span>
                  </span>
                  <span className={`shrink-0 font-semibold tabular-nums ${row.cashFlow >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {fmtMoney(row.cashFlow)}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200/80">
                      <div className="h-full rounded-full bg-emerald-400" style={{ width: `${(row.income / maxAbs) * 100}%` }} />
                    </div>
                    <div className="text-[10px] text-slate-500">Rent {fmtMoney(row.income)}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200/80">
                      <div className="h-full rounded-full bg-rose-400" style={{ width: `${(row.expenses / maxAbs) * 100}%` }} />
                    </div>
                    <div className="text-[10px] text-slate-500">Costs {fmtMoney(row.expenses)}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-200/80">
                      <div
                        className={`h-full rounded-full ${row.cashFlow >= 0 ? 'bg-teal-500' : 'bg-amber-500'}`}
                        style={{ width: `${(Math.abs(row.cashFlow) / maxAbs) * 100}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-slate-500">Net</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function portfolioExpenseBuckets(breakdown: {
  taxes: number;
  insurance: number;
  hoa: number;
  utilities: number;
  repairs: number;
  management: number;
  vacancy: number;
  other: number;
  debtService: number;
}): ExpenseBucket[] {
  return [
    { category: 'Property Taxes', amount: breakdown.taxes },
    { category: 'Insurance', amount: breakdown.insurance },
    { category: 'Debt Service', amount: breakdown.debtService },
    { category: 'Repairs / CapEx', amount: breakdown.repairs },
    { category: 'Management', amount: breakdown.management },
    { category: 'HOA', amount: breakdown.hoa },
    { category: 'Utilities', amount: breakdown.utilities },
    { category: 'Vacancy & Other', amount: breakdown.other + breakdown.vacancy },
  ].filter((bucket) => bucket.amount > 0);
}
