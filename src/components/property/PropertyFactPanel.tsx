import type { ReactNode } from 'react';
import { cn } from '../../design-system/utils';

/**
 * Label/value rows for the Overview fact panels.
 *
 * The rows these replace were `flex justify-between` with a fixed-width truncate
 * on the value, which clipped long lender names mid-word and split AVM ranges
 * across the dash. Here the row is allowed to wrap: when the value cannot share a
 * line with its label it drops to its own full-width line instead of being cut.
 */

export function FactPanel({
  label,
  dotColor,
  children,
  className,
}: {
  label: ReactNode;
  dotColor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200/70 bg-slate-50/60 p-3 transition hover:border-slate-300',
        className,
      )}
    >
      <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-900">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dotColor }} />
        {label}
      </h4>
      <div className="text-[13px]">{children}</div>
    </div>
  );
}

export function FactRow({
  label,
  value,
  valueClassName,
  nowrap = false,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  valueClassName?: string;
  /** Keep the value on one line where splitting it would be wrong, like a range. */
  nowrap?: boolean;
  title?: string;
}) {
  const derivedTitle =
    title ?? (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 border-b border-dotted border-slate-200 py-1 last:border-b-0">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span
        title={derivedTitle}
        className={cn(
          'ml-auto min-w-0 text-right font-semibold text-slate-900',
          nowrap && 'whitespace-nowrap',
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function FactPanelEmpty({ children }: { children: ReactNode }) {
  return <p className="py-1 text-[13px] text-slate-400">{children}</p>;
}
