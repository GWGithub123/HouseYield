import { useEffect, useRef } from 'react';
import { RotateCcw, Zap } from 'lucide-react';
import type { FILever } from '../types';

interface LeversRailProps {
  levers: FILever[];
  /** Optional per-lever FI-year impact of nudging it favourably (negative = sooner). */
  impacts?: Record<string, number | null>;
  /** Render only the lever rows (no outer card / header) for embedding in a sheet. */
  frameless?: boolean;
}

function formatValue(value: number, format: FILever['format']): string {
  switch (format) {
    case 'currency':
      return `$${Math.round(value).toLocaleString()}`;
    case 'percent':
      return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
    case 'year':
      return String(Math.round(value));
    default:
      return String(value);
  }
}

function LeverRow({
  lever,
  baseline,
  impact,
}: {
  lever: FILever;
  baseline: number;
  impact?: number | null;
}) {
  const changed = Math.abs(lever.value - baseline) > lever.step / 2;
  const pct = ((lever.value - lever.min) / (lever.max - lever.min)) * 100;
  const ghostPct = ((baseline - lever.min) / (lever.max - lever.min)) * 100;

  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-slate-700">{lever.label}</span>
          {lever.connected ? (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-emerald-700">
              LIVE
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {impact !== null && impact !== undefined && Math.abs(impact) >= 1 ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
              style={
                impact < 0
                  ? { background: 'rgba(16,185,129,0.12)', color: '#059669' }
                  : { background: 'rgba(244,63,94,0.1)', color: '#e11d48' }
              }
              title="Estimated effect on your FI year if increased one step"
            >
              <Zap size={9} /> {impact < 0 ? '−' : '+'}{Math.abs(impact)}y
            </span>
          ) : null}
          <span className="font-mono text-sm font-semibold tabular-nums text-slate-900">
            {formatValue(lever.value, lever.format)}
          </span>
        </div>
      </div>

      <div className="relative">
        {/* ghost marker for the baseline (session start) value */}
        {changed ? (
          <div
            className="pointer-events-none absolute top-1/2 z-10 h-3 w-0.5 -translate-y-1/2 rounded-full bg-slate-300"
            style={{ left: `${Math.min(100, Math.max(0, ghostPct))}%` }}
            title={`Was ${formatValue(baseline, lever.format)}`}
          />
        ) : null}
        <input
          type="range"
          min={lever.min}
          max={lever.max}
          step={lever.step}
          value={lever.value}
          onChange={(e) => lever.onChange(Number(e.target.value))}
          className="fi-lever-slider h-1.5 w-full cursor-pointer appearance-none rounded-full"
          style={{
            background: `linear-gradient(to right, #0ea5e9 ${pct}%, #e2e8f0 ${pct}%)`,
          }}
        />
      </div>

      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">{lever.hint ?? ''}</span>
        {changed ? (
          <button
            type="button"
            onClick={() => lever.onChange(baseline)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-600"
          >
            <RotateCcw size={10} /> was {formatValue(baseline, lever.format)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function LeversRail({ levers, impacts, frameless = false }: LeversRailProps) {
  // Capture the session-start value of each lever once so we can show a ghost
  // marker + reset affordance as the user explores.
  const baselineRef = useRef<Record<string, number>>({});
  useEffect(() => {
    levers.forEach((lever) => {
      if (!(lever.id in baselineRef.current)) {
        baselineRef.current[lever.id] = lever.value;
      }
    });
  }, [levers]);

  const groups = levers.reduce<Record<string, FILever[]>>((acc, lever) => {
    const key = lever.group ?? 'Adjust';
    (acc[key] ||= []).push(lever);
    return acc;
  }, {});

  const rows = (
    <div className="divide-y divide-slate-100">
      {Object.entries(groups).map(([group, groupLevers]) => (
        <div key={group}>
          <div className="bg-slate-50/70 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {group}
          </div>
          {groupLevers.map((lever) => (
            <LeverRow
              key={lever.id}
              lever={lever}
              baseline={baselineRef.current[lever.id] ?? lever.value}
              impact={impacts?.[lever.id]}
            />
          ))}
        </div>
      ))}
    </div>
  );

  if (frameless) {
    return rows;
  }

  return (
    <div className="hy-glass-card overflow-hidden">
      <div className="border-b border-slate-200/70 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <span className="h-4 w-1 rounded-full bg-gradient-to-b from-sky-500 to-teal-500" />
          Levers
        </h3>
        <p className="text-xs text-slate-500">Drag to see your future move in real time.</p>
      </div>
      {rows}
    </div>
  );
}
