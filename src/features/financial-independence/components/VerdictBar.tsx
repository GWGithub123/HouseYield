import { useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Sparkles, HelpCircle, Info, X, SlidersHorizontal } from 'lucide-react';
import type { FIVerdict } from '../types';

interface VerdictBarProps {
  verdict: FIVerdict;
  deltaYears?: number | null;
  lastSeenLabel?: string | null;
  /** Number of Monte Carlo simulations behind the confidence score. */
  drawCount?: number;
  /** Opens the plan assumptions editor (optional secondary link in the popover). */
  onAdjustAssumptions?: () => void;
  loading?: boolean;
}

function confidenceTone(p: number): { label: string; color: string; bar: string } {
  if (p >= 0.85) return { label: 'On track', color: '#059669', bar: '#10b981' };
  if (p >= 0.6) return { label: 'Likely', color: '#0284c7', bar: '#38bdf8' };
  if (p >= 0.35) return { label: 'At risk', color: '#d97706', bar: '#f59e0b' };
  return { label: 'Off track', color: '#dc2626', bar: '#ef4444' };
}

export default function VerdictBar({ verdict, deltaYears, lastSeenLabel, drawCount, onAdjustAssumptions, loading }: VerdictBarProps) {
  const [showWhy, setShowWhy] = useState(false);
  const headlineYear = verdict.fiYearMedian ?? verdict.fiYearDeterministic;
  const yearsAway = headlineYear !== null ? headlineYear - verdict.currentYear : null;
  const tone = confidenceTone(verdict.successProbability);
  const pct = Math.round(verdict.successProbability * 100);

  const deltaNode = (() => {
    if (deltaYears === null || deltaYears === undefined) return null;
    if (deltaYears === 0) {
      return (
        <span className="inline-flex items-center gap-1 text-slate-500">
          <Minus size={14} /> No change {lastSeenLabel ? `since ${lastSeenLabel}` : ''}
        </span>
      );
    }
    const earlier = deltaYears < 0;
    const Icon = earlier ? TrendingUp : TrendingDown;
    const color = earlier ? '#059669' : '#dc2626';
    const mag = Math.abs(deltaYears);
    return (
      <span className="inline-flex items-center gap-1 font-medium" style={{ color }}>
        <Icon size={14} /> {earlier ? '−' : '+'}{mag} {mag === 1 ? 'yr' : 'yrs'} {earlier ? 'sooner' : 'later'}
        {lastSeenLabel ? <span className="font-normal text-slate-400">vs {lastSeenLabel}</span> : null}
      </span>
    );
  })();

  return (
    <div
      className="relative overflow-hidden rounded-2xl px-6 py-5"
      style={{
        background: 'linear-gradient(120deg, rgba(15,23,42,0.97) 0%, rgba(30,41,59,0.96) 55%, rgba(13,42,74,0.97) 100%)',
        boxShadow: '0 18px 40px -24px rgba(15,23,42,0.7)',
      }}
    >
      <div
        className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.45), transparent 70%)' }}
      />
      <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-300/80">
            <Sparkles size={13} /> Financial Independence
          </div>
          {loading ? (
            <div className="h-8 w-72 animate-pulse rounded-md bg-white/10" />
          ) : headlineYear === null ? (
            <h2 className="text-2xl font-semibold text-white">
              Not reached within your projection horizon
            </h2>
          ) : (
            <h2 className="text-2xl font-semibold leading-tight text-white">
              You reach financial independence in{' '}
              <span className="text-sky-300">{headlineYear}</span>
              {verdict.ageAtFi ? <span className="text-slate-300"> (age {verdict.ageAtFi})</span> : null}
              {yearsAway !== null && yearsAway >= 0 ? (
                <span className="ml-2 align-middle text-sm font-normal text-slate-400">
                  {yearsAway === 0 ? 'this year' : `${yearsAway} ${yearsAway === 1 ? 'year' : 'years'} away`}
                </span>
              ) : null}
            </h2>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {deltaNode}
            {verdict.fiYearOptimistic && verdict.fiYearPessimistic ? (
              <span className="text-slate-400">
                Range {verdict.fiYearOptimistic}–{verdict.fiYearPessimistic}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-5">
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Confidence
              <button
                type="button"
                onClick={() => setShowWhy((v) => !v)}
                title="How is this calculated?"
                className="text-slate-400 transition-colors hover:text-sky-300"
              >
                <Info size={12} />
              </button>
            </div>
            <div className="flex items-center justify-end gap-2">
              <span className="text-2xl font-bold" style={{ color: tone.bar }}>{pct}%</span>
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ background: `${tone.bar}22`, color: tone.color }}
              >
                {tone.label}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-32 overflow-hidden rounded-full bg-white/15">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, background: tone.bar }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowWhy((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/10"
          >
            <HelpCircle size={15} /> Why?
          </button>
        </div>
      </div>

      {showWhy ? (
        <div className="relative mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4 text-sm text-slate-300">
          <button
            type="button"
            onClick={() => setShowWhy(false)}
            className="absolute right-3 top-3 text-slate-400 transition-colors hover:text-white"
            aria-label="Close"
          >
            <X size={14} />
          </button>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-sky-300/80">
            <Sparkles size={12} /> How we calculate confidence
          </div>
          <p className="leading-relaxed text-slate-300">
            We run{drawCount ? <strong className="text-white"> {drawCount.toLocaleString()} </strong> : ' '}Monte
            Carlo simulations of your plan. In each run, annual stock growth, dividends, inflation, and property
            appreciation are randomly varied around your assumptions, then your full projection is recomputed.
          </p>
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            <li className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
              <span className="text-slate-400">Reached FI in time</span>
              <span className="font-semibold" style={{ color: tone.bar }}>{pct}% of runs</span>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
              <span className="text-slate-400">Median FI year</span>
              <span className="font-semibold text-white">{verdict.fiYearMedian ?? '—'}</span>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
              <span className="text-slate-400">Favorable markets (P10)</span>
              <span className="font-semibold text-emerald-300">{verdict.fiYearOptimistic ?? '—'}</span>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
              <span className="text-slate-400">Poor markets (P90)</span>
              <span className="font-semibold text-amber-300">{verdict.fiYearPessimistic ?? '—'}</span>
            </li>
          </ul>
          {onAdjustAssumptions ? (
            <button
              type="button"
              onClick={onAdjustAssumptions}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 transition-colors hover:text-sky-200"
            >
              <SlidersHorizontal size={12} /> Adjust the underlying assumptions
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
