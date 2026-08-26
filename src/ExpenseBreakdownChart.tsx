/**
 * ExpenseBreakdownChart - Vertical stacked expense breakdown with donut chart
 * Dark theme design matching the reference image
 * Shows categorized expenses from bank transaction data
 * Supports time period toggles: This Month, Last Month, X-Mo Avg
 */

import { useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ExpenseCategory, ExpenseData, CategorizedTransaction } from './CheckingAccountConnect';
import { getCategoryColor, getCategoryIcon } from './CheckingAccountConnect';

type ExpensePeriod = 'this-month' | 'last-month' | 'avg';

interface ExpenseBreakdownChartProps {
  expenseData: ExpenseData | null;
  onCategoryClick?: (category: string) => void;
  footerContent?: ReactNode;
}

function parseTransactionDate(dateValue: string): Date {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  return new Date(dateValue);
}

function getReferenceMonthDate(transactions: CategorizedTransaction[]): Date {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const currentMonthHasData = transactions.some((transaction) => {
    const transactionDate = parseTransactionDate(transaction.date);
    return transactionDate.getFullYear() === currentYear && transactionDate.getMonth() === currentMonth;
  });

  if (currentMonthHasData) {
    return new Date(currentYear, currentMonth, 1);
  }

  let latestDate: Date | null = null;
  transactions.forEach((transaction) => {
    const transactionDate = parseTransactionDate(transaction.date);
    if (!Number.isNaN(transactionDate.getTime()) && (!latestDate || transactionDate > latestDate)) {
      latestDate = transactionDate;
    }
  });

  return latestDate ? new Date(latestDate.getFullYear(), latestDate.getMonth(), 1) : new Date(currentYear, currentMonth, 1);
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians))
  };
}

function describeArc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

  return [
    'M', start.x, start.y,
    'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y
  ].join(' ');
}

function getSliceOffset(distance: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
  return {
    x: Math.cos(angleInRadians) * distance,
    y: Math.sin(angleInRadians) * distance,
  };
}

/**
 * Given an array of categorized transactions and a time period,
 * filter and aggregate into expense categories.
 */
function computeCategoriesForPeriod(
  transactions: CategorizedTransaction[],
  period: ExpensePeriod,
  monthsCovered: number,
  referenceMonthDate: Date
): { categories: (ExpenseCategory & { color: string; icon: string })[]; total: number; periodLabel: string; incomeTotal: number } {
  let filtered: CategorizedTransaction[];
  let periodLabel: string;
  let divisor = 1;

  if (period === 'this-month') {
    const thisYear = referenceMonthDate.getFullYear();
    const thisMonth = referenceMonthDate.getMonth();
    filtered = transactions.filter(t => {
      const d = parseTransactionDate(t.date);
      return d.getFullYear() === thisYear && d.getMonth() === thisMonth;
    });
    periodLabel = referenceMonthDate.toLocaleDateString('en-US', { month: 'long' });
  } else if (period === 'last-month') {
    const last = new Date(referenceMonthDate.getFullYear(), referenceMonthDate.getMonth() - 1, 1);
    const lastYear = last.getFullYear();
    const lastMonth = last.getMonth();
    filtered = transactions.filter(t => {
      const d = parseTransactionDate(t.date);
      return d.getFullYear() === lastYear && d.getMonth() === lastMonth;
    });
    periodLabel = last.toLocaleDateString('en-US', { month: 'long' });
  } else {
    // Full average across all months
    filtered = transactions;
    divisor = Math.max(monthsCovered, 1);
    periodLabel = `${monthsCovered}-Mo Avg`;
  }

  // Separate expenses (exclude transfers)
  const expenses = filtered.filter(t => !t.isTransfer && (t.amount < 0 || t.type === 'expense'));
  const income = filtered.filter(t => !t.isTransfer && t.amount > 0 && t.type === 'income');

  // Aggregate by category
  const byCategory: Record<string, { total: number; count: number }> = {};
  expenses.forEach(t => {
    const cat = t.aiCategory || 'Miscellaneous';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, count: 0 };
    byCategory[cat].total += Math.abs(t.amount);
    byCategory[cat].count += 1;
  });

  const totalExpenses = Object.values(byCategory).reduce((sum, c) => sum + c.total, 0);
  const displayTotal = totalExpenses / divisor;

  const categories = Object.entries(byCategory)
    .map(([category, data], i) => ({
      category,
      totalAmount: data.total / divisor,
      monthlyAverage: data.total / divisor,
      transactionCount: data.count,
      percentage: totalExpenses > 0 ? (data.total / totalExpenses) * 100 : 0,
      color: getCategoryColor(category, i),
      icon: getCategoryIcon(category),
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount);

  const incomeTotal = income.reduce((sum, t) => sum + t.amount, 0) / divisor;

  return { categories, total: displayTotal, periodLabel, incomeTotal };
}

export default function ExpenseBreakdownChart({ expenseData, onCategoryClick, footerContent }: ExpenseBreakdownChartProps) {
  const [activeTab, setActiveTab] = useState<'expenses' | 'budget'>('expenses');
  const [showAll, setShowAll] = useState(false);
  const [period, setPeriod] = useState<ExpensePeriod>('this-month');
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);

  // Whether we have raw transaction data for period filtering
  const hasTransactions = expenseData?.categorizedTransactions && expenseData.categorizedTransactions.length > 0;
  const monthsCovered = expenseData?.summary?.monthsCovered || 1;
  const referenceMonthDate = useMemo(
    () => hasTransactions ? getReferenceMonthDate(expenseData!.categorizedTransactions!) : new Date(),
    [expenseData, hasTransactions]
  );

  const filteredTransactionsForPeriod = useMemo(() => {
    if (!expenseData?.categorizedTransactions?.length) return [];

    if (period === 'avg') {
      return expenseData.categorizedTransactions.filter(
        (transaction) => !transaction.isTransfer && (transaction.amount < 0 || transaction.type === 'expense')
      );
    }

    const targetMonthDate = period === 'last-month'
      ? new Date(referenceMonthDate.getFullYear(), referenceMonthDate.getMonth() - 1, 1)
      : referenceMonthDate;

    return expenseData.categorizedTransactions.filter((transaction) => {
      const transactionDate = parseTransactionDate(transaction.date);
      return !transaction.isTransfer
        && (transaction.amount < 0 || transaction.type === 'expense')
        && transactionDate.getFullYear() === targetMonthDate.getFullYear()
        && transactionDate.getMonth() === targetMonthDate.getMonth();
    });
  }, [expenseData, period, referenceMonthDate]);

  const categoryTransactionMap = useMemo(() => {
    const grouped: Record<string, CategorizedTransaction[]> = {};
    filteredTransactionsForPeriod.forEach((transaction) => {
      const category = transaction.aiCategory || 'Miscellaneous';
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(transaction);
    });

    Object.values(grouped).forEach((transactions) => {
      transactions.sort((left, right) => parseTransactionDate(right.date).getTime() - parseTransactionDate(left.date).getTime());
    });

    return grouped;
  }, [filteredTransactionsForPeriod]);

  // Compute period-specific categories from raw transactions (or fall back to aggregate data)
  const { categories, totalForPeriod, periodLabel, incomeForPeriod } = useMemo(() => {
    if (!expenseData) return { categories: [], totalForPeriod: 0, periodLabel: '', incomeForPeriod: 0 };

    if (hasTransactions) {
      const result = computeCategoriesForPeriod(
        expenseData.categorizedTransactions!,
        period,
        monthsCovered,
        referenceMonthDate
      );
      return {
        categories: result.categories,
        totalForPeriod: result.total,
        periodLabel: result.periodLabel,
        incomeForPeriod: result.incomeTotal,
      };
    }

    // Fallback: no raw transactions, use the pre-aggregated averages
    const cats = expenseData.expenseCategories.map((cat, i) => ({
      ...cat,
      color: cat.color || getCategoryColor(cat.category, i),
      icon: getCategoryIcon(cat.category),
    }));
    return {
      categories: cats,
      totalForPeriod: expenseData.summary.monthlyExpenseTotal,
      periodLabel: `${monthsCovered}-Mo Avg`,
      incomeForPeriod: expenseData.summary.monthlyIncomeTotal,
    };
  }, [expenseData, period, hasTransactions, monthsCovered, referenceMonthDate]);

  if (!expenseData) {
    return (
      <div
        className="h-full rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: 'linear-gradient(180deg, #1a1b2e 0%, #151623 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex-1 flex items-center justify-center px-6 py-8">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-800/50 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4l2 2" />
              </svg>
            </div>
            <h3 className="text-gray-400 text-sm font-medium mb-1">No Expense Data</h3>
            <p className="text-gray-600 text-xs">Connect your checking account to see expense breakdown</p>
          </div>
        </div>

        {footerContent && (
          <div className="border-t border-white/5 px-5 py-4">
            {footerContent}
          </div>
        )}
        </div>
    );
  }

  const displayCategories = showAll ? categories : categories.slice(0, 6);
  const shouldExpandList = showAll || expandedCategory !== null;
  const donutSegments = categories
    .slice(0, 8)
    .reduce((acc: Array<ExpenseCategory & { icon: string; color: string; startAngle: number; endAngle: number; pct: number; idx: number }>, cat, idx) => {
      const total = totalForPeriod || 1;
      const pct = (cat.totalAmount / total) * 100;
      const startAngle = acc.length > 0 ? acc[acc.length - 1].endAngle : 0;
      const endAngle = startAngle + (pct * 3.6);
      acc.push({ ...cat, startAngle, endAngle, pct, idx });
      return acc;
    }, []);

  const centerLabel = period === 'avg' ? 'Monthly Avg' : 'Total expenses';
  const donutRadius = 42;
  const donutCenter = 50;

  return (
    <div
      className={`rounded-2xl overflow-hidden flex flex-col ${shouldExpandList ? 'h-auto' : 'h-full'}`}
      style={{
        background: 'linear-gradient(180deg, #1a1b2e 0%, #151623 100%)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wider text-gray-400 uppercase">
          Category Breakdown
        </h3>
        <button className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {/* Expenses / Budget Tabs */}
      <div className="px-5 pb-2">
        <div className="flex bg-white/5 rounded-xl p-1">
          <button
            onClick={() => setActiveTab('expenses')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
              activeTab === 'expenses'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            Expenses
          </button>
          <button
            onClick={() => setActiveTab('budget')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
              activeTab === 'budget'
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            Budget
          </button>
        </div>
      </div>

      {/* Time Period Toggles */}
      {hasTransactions && activeTab === 'expenses' && (
        <div className="px-5 pb-4">
          <div className="flex bg-white/5 rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => setPeriod('this-month')}
              className={`flex-1 py-1.5 text-[11px] font-semibold rounded-md transition-all ${
                period === 'this-month'
                  ? 'bg-violet-600/80 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              This Month
            </button>
            <button
              onClick={() => setPeriod('last-month')}
              className={`flex-1 py-1.5 text-[11px] font-semibold rounded-md transition-all ${
                period === 'last-month'
                  ? 'bg-violet-600/80 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              Last Month
            </button>
            <button
              onClick={() => setPeriod('avg')}
              className={`flex-1 py-1.5 text-[11px] font-semibold rounded-md transition-all ${
                period === 'avg'
                  ? 'bg-violet-600/80 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {monthsCovered}-Mo Avg
            </button>
          </div>
        </div>
      )}

      {/* Donut Chart */}
      <div className="flex items-center justify-center pb-5 px-5">
        <div className="relative w-52 h-52">
          <svg viewBox="0 0 100 100" className="w-full h-full">
            <defs>
              {categories.slice(0, 8).map((_, idx) => {
                const gradColors = ['#8B5CF6', '#06B6D4', '#10B981', '#F97316', '#EC4899', '#6366F1', '#EF4444', '#0EA5E9'];
                return (
                  <linearGradient key={idx} id={`retCatGrad${idx}`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor={gradColors[idx % gradColors.length]} stopOpacity="1" />
                    <stop offset="100%" stopColor={gradColors[idx % gradColors.length]} stopOpacity="0.8" />
                  </linearGradient>
                );
              })}
            </defs>
            {/* Donut segments */}
            {donutSegments.map((seg) => {
                const isHovered = hoveredSegment === seg.idx;
                const strokeWidth = isHovered ? 13 : 8;
                const d = describeArc(donutCenter, donutCenter, donutRadius, seg.startAngle, seg.endAngle);
                const midAngle = (seg.startAngle + seg.endAngle) / 2;
                const sliceOffset = isHovered ? getSliceOffset(4.5, midAngle) : { x: 0, y: 0 };
                const tooltipRadius = donutRadius + strokeWidth / 2 + 24;
                const tooltipShift = getSliceOffset(5, midAngle);
                const tooltipPos = polarToCartesian(donutCenter, donutCenter, tooltipRadius, midAngle);
                const tooltipWidth = 22;
                const tooltipHeight = 12;
                const clampedX = Math.max(tooltipWidth / 2 + 2, Math.min(100 - tooltipWidth / 2 - 2, tooltipPos.x + tooltipShift.x));
                const clampedY = Math.max(tooltipHeight / 2 + 2, Math.min(100 - tooltipHeight / 2 - 2, tooltipPos.y + tooltipShift.y));
                return (
                  <g
                    key={seg.idx}
                    transform={`translate(${sliceOffset.x}, ${sliceOffset.y})`}
                    style={{ transition: 'transform 0.18s ease' }}
                  >
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={18}
                      strokeLinecap="butt"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredSegment(seg.idx)}
                      onMouseLeave={() => setHoveredSegment(null)}
                      onClick={() => onCategoryClick?.(seg.category)}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={`url(#retCatGrad${seg.idx})`}
                      strokeWidth={strokeWidth}
                      strokeLinecap="butt"
                      pointerEvents="none"
                      style={{
                        transition: 'stroke-width 0.2s ease, opacity 0.2s ease',
                        opacity: isHovered ? 1 : 0.95,
                      }}
                    />
                    {isHovered && seg.pct > 0 && (
                      <g>
                        <rect
                          x={clampedX - tooltipWidth / 2}
                          y={clampedY - tooltipHeight / 2}
                          width={tooltipWidth}
                          height={tooltipHeight}
                          rx="3"
                          fill="rgba(15, 23, 42, 0.92)"
                        />
                        <text
                          x={clampedX}
                          y={clampedY + 2.5}
                          textAnchor="middle"
                          fontSize="5"
                          fontWeight="700"
                          fill="white"
                        >
                          {seg.pct.toFixed(0)}%
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
          </svg>
          {/* Center text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-3xl font-bold text-white">
              ${totalForPeriod >= 1000
                ? totalForPeriod.toLocaleString('en-US', { maximumFractionDigits: 0 })
                : totalForPeriod.toFixed(0)}
            </span>
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider mt-1">{centerLabel}</span>
          </div>
        </div>
      </div>

      {/* Category List */}
      <div className={`${shouldExpandList ? 'overflow-visible pb-2' : 'flex-1 overflow-y-auto'} px-5 space-y-1`}>
        {displayCategories.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-500 text-sm">No expenses for {periodLabel}</p>
          </div>
        ) : displayCategories.map((cat) => {
          const isExpanded = expandedCategory === cat.category;
          const matchingTransactions = categoryTransactionMap[cat.category] || [];

          return (
          <div
            key={cat.category}
            className="rounded-xl overflow-hidden"
          >
            <div
              className="relative flex items-center gap-3 p-3 hover:bg-white/[0.04] transition-colors cursor-pointer group"
              onClick={() => setExpandedCategory(isExpanded ? null : cat.category)}
            >
            {/* Percentage background bar */}
            <div
              className="absolute inset-y-1 left-1 rounded-2xl transition-all duration-500"
              style={{
                width: `${Math.max(cat.percentage, 4)}%`,
                background: `linear-gradient(90deg, ${cat.color}50, ${cat.color}30)`,
              }}
            />
            {/* Icon with color ring */}
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0 relative z-10"
              style={{ backgroundColor: `${cat.color}20`, border: `2px solid ${cat.color}` }}
            >
              {cat.icon}
            </div>
            {/* Name and percentage */}
            <div className="flex-1 min-w-0 relative z-10">
              <div className="text-sm font-medium text-white truncate">{cat.category}</div>
              <div className="text-xs text-slate-500">{cat.percentage.toFixed(0)}% of expenses</div>
            </div>
            {/* Amount */}
            <div className="text-right relative z-10">
              <div className="text-sm font-semibold text-white">
                ${cat.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            {/* Expand arrow */}
            <svg
              className={`w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-all relative z-10 ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            </div>

            {isExpanded && (
              <div className="px-3 pb-3 pt-1 ml-[52px] mr-2 rounded-b-xl bg-white/[0.03] border border-white/[0.05]">
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2 uppercase tracking-wide">
                  <span>{matchingTransactions.length} transaction{matchingTransactions.length === 1 ? '' : 's'}</span>
                  <button
                    type="button"
                    className="text-slate-300 hover:text-white transition-colors"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCategoryClick?.(cat.category);
                    }}
                  >
                    Filter category
                  </button>
                </div>

                {matchingTransactions.length > 0 ? (
                  <div className="space-y-2">
                    {matchingTransactions.slice(0, 4).map((transaction) => (
                      <div key={transaction.id} className="flex items-start justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="text-slate-100 truncate">{transaction.description}</div>
                          <div className="text-slate-500">{parseTransactionDate(transaction.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                        </div>
                        <div className="shrink-0 font-medium text-slate-200">
                          ${Math.abs(transaction.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                      </div>
                    ))}
                    {matchingTransactions.length > 4 && (
                      <div className="text-[11px] text-slate-500">
                        +{matchingTransactions.length - 4} more in this period
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">
                    No saved transactions available for this category in {periodLabel}.
                  </div>
                )}
              </div>
            )}
          </div>
        )})}
      </div>

      {/* See More */}
      {categories.length > 6 && (
        <div className="px-5 py-3">
          <button
            onClick={() => setShowAll(!showAll)}
            className="w-full py-2.5 rounded-xl border border-white/10 text-sm font-medium text-gray-400 hover:text-white hover:border-white/20 transition-all"
          >
            {showAll ? 'Show less' : `See more (${categories.length - 6})`}
          </button>
        </div>
      )}

      {/* Income Summary */}
      <div className="px-5 py-4 border-t border-white/5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold tracking-wider text-gray-400 uppercase">
            Income {period === 'this-month' ? 'This Month' : period === 'last-month' ? 'Last Month' : `${monthsCovered}-Mo Avg`} &gt;
          </span>
          <button className="w-6 h-6 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="mt-2">
          <div className="text-xs text-gray-500">Total income</div>
          <div className="text-xl font-bold text-white">
            $ {incomeForPeriod.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </div>
        </div>
        {expenseData.incomeCategories.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Next Paycheck</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </div>
        )}
      </div>

      {footerContent && (
        <div className="border-t border-white/5 px-5 py-4">
          {footerContent}
        </div>
      )}
    </div>
  );
}
