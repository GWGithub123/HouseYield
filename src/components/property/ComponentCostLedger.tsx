import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ComponentCostSummary } from '../../services/propertyHealthDocuments';

/**
 * What each component has cost, and where repairing has stopped paying.
 *
 * Placed beside the inventory rather than in the financial pages because the
 * decision it informs is about the component: a furnace whose repairs are
 * closing on the price of a new one is a maintenance judgement, not a
 * bookkeeping line.
 */
export default function ComponentCostLedger({ summaries }: { summaries: ComponentCostSummary[] }) {
  const total = summaries.reduce((sum, item) => sum + item.lifetimeSpendUsd, 0);
  const flagged = summaries.filter((item) => item.replaceSignal);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
            Cost of ownership
          </div>
          <h5 className="mt-0.5 text-[15px] font-bold text-slate-950">
            What each system has cost you
          </h5>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Recorded to date
          </div>
          <div className="text-lg font-bold tabular-nums text-slate-900">
            ${Math.round(total).toLocaleString()}
          </div>
        </div>
      </div>

      {flagged.map((item) => (
        <div
          key={`signal-${item.assetId}`}
          className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <div className="text-[12px] font-bold text-amber-900">
              Consider replacing the {item.name.toLowerCase()}
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-amber-800">
              {item.replaceSignal!.reason}
            </p>
          </div>
        </div>
      ))}

      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Component</th>
              <th className="px-3 py-2 text-right">Spent</th>
              <th className="px-3 py-2 text-right">Of that, repairs</th>
              <th
                className="px-3 py-2 text-right"
                title="Replacement cost spread over the life it buys, plus the observed rate of upkeep"
              >
                Cost per year
              </th>
              <th className="px-3 py-2 text-right">Records</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {summaries.map((item) => (
              <tr key={item.assetId} className="bg-white">
                <td className="px-3 py-2 font-semibold text-slate-900">{item.name}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-900">
                  ${Math.round(item.lifetimeSpendUsd).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                  {item.repairSpendUsd > 0 ? `$${Math.round(item.repairSpendUsd).toLocaleString()}` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                  {item.annualizedUsd != null ? `$${Math.round(item.annualizedUsd).toLocaleString()}` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{item.eventCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
