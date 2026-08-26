import { Sparkles, ArrowRight, Lightbulb, Home, PiggyBank, Shuffle, Wallet } from 'lucide-react';
import type { FINudge } from '../types';

interface AINudgesProps {
  nudges: FINudge[];
  onApply: (nudge: FINudge) => void;
  onOpenPlanner?: () => void;
  loading?: boolean;
}

const CAPABILITIES = [
  { icon: Home, label: 'Buy / sell property' },
  { icon: PiggyBank, label: 'Tune contributions' },
  { icon: Shuffle, label: 'Reallocate portfolio' },
  { icon: Wallet, label: 'Plan big purchases' },
];

export default function AINudges({ nudges, onApply, onOpenPlanner, loading }: AINudgesProps) {
  return (
    <div className="hy-glass-card overflow-hidden">
      <div className="border-b border-slate-200/70 bg-gradient-to-br from-violet-50/80 to-sky-50/60 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-sky-500 text-white shadow-sm">
            <Sparkles size={15} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">AI Planner</h3>
            <p className="text-[11px] text-slate-500">Smart moves toward your FI date</p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {loading ? (
          <div className="space-y-2 p-4">
            <div className="h-4 w-3/4 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
          </div>
        ) : nudges.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-5 text-sm text-slate-400">
            <Lightbulb size={16} /> Your plan looks steady — no quick wins right now.
          </div>
        ) : (
          nudges.map((nudge) => (
            <div key={nudge.id} className="p-4">
              <div className="mb-1 flex items-start justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-800">{nudge.headline}</h4>
                {nudge.impactYears != null && Math.abs(nudge.impactYears) >= 1 ? (
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={
                      nudge.impactYears < 0
                        ? { background: 'rgba(16,185,129,0.12)', color: '#059669' }
                        : { background: 'rgba(244,63,94,0.1)', color: '#e11d48' }
                    }
                  >
                    {nudge.impactYears < 0 ? '−' : '+'}
                    {Math.abs(nudge.impactYears)}y FI
                  </span>
                ) : null}
              </div>
              <p className="mb-3 text-xs leading-relaxed text-slate-500">{nudge.detail}</p>
              <button
                type="button"
                onClick={() => onApply(nudge)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
              >
                {nudge.applyLabel ?? 'Apply as scenario'} <ArrowRight size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      {onOpenPlanner ? (
        <div className="border-t border-slate-100 p-4">
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {CAPABILITIES.map((cap) => (
              <span
                key={cap.label}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-500"
              >
                <cap.icon size={11} className="text-violet-500" /> {cap.label}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={onOpenPlanner}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-sky-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:from-violet-700 hover:to-sky-700"
          >
            <Sparkles size={15} /> Plan with AI <ArrowRight size={14} />
          </button>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            Ask anything — the planner drafts scenarios you can apply in one click.
          </p>
        </div>
      ) : null}
    </div>
  );
}
