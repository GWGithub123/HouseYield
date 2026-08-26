import { List } from 'lucide-react';
import type { FinancialPlannerProjectionPoint } from '../../../services/aiFinancialPlannerService';
import type { FIMilestone } from '../types';

interface ProjectionBreakdownTableProps {
  points: FinancialPlannerProjectionPoint[];
  milestones: FIMilestone[];
  fiYear: number | null;
  retirementYear: number | null;
}

function currency(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

function signedCurrency(value: number): string {
  return `${value >= 0 ? '+' : '-'}$${Math.abs(Math.round(value)).toLocaleString()}`;
}

function compactAccount(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${Math.round(value).toLocaleString()}`;
}

const milestoneTone: Record<FIMilestone['kind'], string> = {
  fi: 'bg-sky-50 text-sky-700',
  retirement: 'bg-amber-50 text-amber-700',
  propertyPurchase: 'bg-blue-50 text-blue-700',
  propertySale: 'bg-violet-50 text-violet-700',
  bigPurchase: 'bg-rose-50 text-rose-700',
  scenario: 'bg-indigo-50 text-indigo-700',
};

export default function ProjectionBreakdownTable({
  points,
  milestones,
  fiYear,
  retirementYear,
}: ProjectionBreakdownTableProps) {
  const milestonesByYear = milestones.reduce<Record<number, FIMilestone[]>>((acc, milestone) => {
    if (!acc[milestone.year]) {
      acc[milestone.year] = [];
    }
    acc[milestone.year].push(milestone);
    return acc;
  }, {});

  return (
    <div className="hy-glass-card overflow-hidden">
      <div className="border-b border-slate-200/70 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <List size={16} className="text-sky-500" />
          Year-by-Year Breakdown
        </h3>
      </div>

      <div className="max-h-[24rem] overflow-y-auto">
        <table className="w-full table-fixed text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur">
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="w-[18%] px-3 py-2">Year</th>
              <th className="w-[16%] px-3 py-2 text-right">Expenses</th>
              <th className="w-[16%] px-3 py-2 text-right">Income</th>
              <th className="w-[16%] px-3 py-2 text-right">Gap</th>
              <th className="w-[14%] px-3 py-2 text-right">YoY</th>
              <th className="w-[14%] px-3 py-2 text-right">Acct</th>
              <th className="w-[12%] px-3 py-2 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {points.map((point, index) => {
              const previous = index > 0 ? points[index - 1] : null;
              const yoy = previous ? point.investmentIncome - previous.investmentIncome : null;
              const yoyPct = previous && previous.investmentIncome > 0 && yoy !== null
                ? (yoy / previous.investmentIncome) * 100
                : null;
              const yearMilestones = milestonesByYear[point.year] || [];
              const isRetirementStart = retirementYear !== null && point.year === retirementYear;
              const isRetired = retirementYear !== null && point.year > retirementYear;
              const isFiYear = fiYear !== null && point.year === fiYear;
              const statusLabel = isRetirementStart
                ? 'Retire'
                : isRetired
                  ? 'Retired'
                  : isFiYear
                    ? 'FI Year'
                    : point.canRetire
                      ? 'FI'
                      : 'Build';
              const statusClass = isRetirementStart
                ? 'bg-slate-700 text-white'
                : isRetired
                  ? 'bg-slate-100 text-slate-600'
                  : isFiYear
                    ? 'bg-emerald-100 text-emerald-700'
                    : point.canRetire
                      ? 'bg-emerald-50 text-emerald-600'
                      : 'bg-slate-100 text-slate-500';

              return (
                <tr
                  key={point.year}
                  className={`${isFiYear ? 'bg-emerald-50/60' : isRetirementStart ? 'bg-slate-100/80' : ''} hover:bg-slate-50`}
                >
                  <td className="px-3 py-2.5 align-top">
                    <div className="font-semibold text-slate-900">CY{point.year}</div>
                    <div className="text-[11px] text-slate-400">+{point.yearsFromNow} years</div>
                    {yearMilestones.length ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {yearMilestones.map((milestone, milestoneIndex) => (
                          <span
                            key={`${milestone.kind}-${milestone.year}-${milestoneIndex}`}
                            className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${milestoneTone[milestone.kind]}`}
                          >
                            {milestone.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium text-rose-500">{currency(point.costOfLiving)}</td>
                  <td className="px-3 py-2.5 text-right font-medium text-emerald-600">{currency(point.investmentIncome)}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${point.surplus >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                    {signedCurrency(point.surplus)}
                  </td>
                  <td className="px-3 py-2.5 text-right align-top">
                    {yoy === null ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <>
                        <div className={yoy >= 0 ? 'font-medium text-sky-600' : 'font-medium text-rose-500'}>
                          {signedCurrency(yoy)}
                        </div>
                        <div className="text-[11px] text-slate-400">{yoyPct === null ? '—' : `${yoyPct >= 0 ? '+' : ''}${yoyPct.toFixed(1)}%`}</div>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium text-violet-600">{compactAccount(point.accountValue)}</td>
                  <td className="px-3 py-2.5 text-center align-top">
                    <span className={`inline-flex justify-center rounded-full px-2 py-1 text-[10px] font-semibold whitespace-nowrap ${statusClass}`}>
                      {statusLabel}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}