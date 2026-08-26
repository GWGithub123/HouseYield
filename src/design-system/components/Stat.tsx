import type { ReactNode } from 'react';
import { cn } from '../utils';

/**
 * Stat — a standalone bordered stat tile (promoted from Bookkeeping / Tax).
 * For secondary metric grids; the hero pattern is KpiStrip.
 */
export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  /** Small element pinned to the top-right corner (e.g. an Explain chip). */
  corner?: ReactNode;
  className?: string;
}

export function Stat({ label, value, hint, onClick, active = false, corner, className }: StatProps) {
  const classes = cn(
    'relative rounded-xl border bg-white p-4 text-left transition',
    active ? 'border-slate-900 shadow-sm ring-2 ring-slate-900/10' : 'border-slate-200/80',
    onClick && 'ds-focus-ring hover:-translate-y-px hover:border-slate-300 hover:shadow-sm',
    className,
  );

  const content = (
    <>
      <div className="ds-label">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
      {corner ? (
        <div className="absolute right-2 top-2" onClick={(event) => event.stopPropagation()}>
          {corner}
        </div>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {content}
      </button>
    );
  }
  return <div className={classes}>{content}</div>;
}

export default Stat;
