import type { ReactNode } from 'react';
import { cn } from '../../design-system/utils';

/**
 * The framed card the Predictive Maintenance twin uses: eyebrow and title on the
 * left, chips and status pills on the right, an optional toolbar strip, then the
 * body beside an optional fixed-width rail.
 *
 * Extracted so Properties and Predictive Maintenance draw the same shell from one
 * place. Copying the classes between the two pages is how they drifted apart in
 * the first place.
 */

export type TwinCardTone = 'blue' | 'slate';

const TONE: Record<TwinCardTone, { border: string; eyebrow: string; shell: string }> = {
  blue: {
    border: 'border-blue-100',
    eyebrow: 'text-blue-700',
    shell: 'border-blue-200/70 shadow-[0_14px_40px_rgba(30,64,175,0.08)]',
  },
  slate: {
    border: 'border-slate-200',
    eyebrow: 'text-slate-600',
    shell: 'border-slate-200/70 shadow-[0_10px_30px_rgba(15,23,42,0.06)]',
  },
};

export interface TwinCardProps {
  icon?: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
  /** Chips and status pills. Wraps under the title on narrow viewports. */
  headerRight?: ReactNode;
  /** Segmented controls and toggles. Sits above the body, never over it. */
  toolbar?: ReactNode;
  /** Fixed 300px column beside the body on xl and up, stacked below it otherwise. */
  rail?: ReactNode;
  tone?: TwinCardTone;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function TwinCard({
  icon,
  eyebrow,
  title,
  headerRight,
  toolbar,
  rail,
  tone = 'slate',
  children,
  className,
  bodyClassName,
}: TwinCardProps) {
  const palette = TONE[tone];

  return (
    <section className={cn('rounded-2xl border bg-white p-4 sm:p-5', palette.shell, className)}>
      <header
        className={cn(
          'flex flex-col gap-3 border-b pb-3 lg:flex-row lg:items-start lg:justify-between',
          palette.border,
        )}
      >
        <div className="min-w-0">
          <div className={cn('flex items-center gap-2', palette.eyebrow)}>
            {icon}
            <span className="text-[11px] font-bold uppercase tracking-[0.18em]">{eyebrow}</span>
          </div>
          <h2 className="mt-0.5 truncate text-lg font-bold text-slate-950">{title}</h2>
        </div>
        {headerRight ? (
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold lg:justify-end">
            {headerRight}
          </div>
        ) : null}
      </header>

      {toolbar ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">{toolbar}</div>
      ) : null}

      <div className={cn('mt-3', rail ? 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]' : '', bodyClassName)}>
        <div className="min-w-0">{children}</div>
        {rail ? <aside className="flex min-w-0 flex-col gap-2.5">{rail}</aside> : null}
      </div>
    </section>
  );
}

/* ── header pills ──────────────────────────────────────────────────── */

export type TwinPillTone = 'neutral' | 'positive' | 'warn' | 'danger' | 'info';

const PILL_TONE: Record<TwinPillTone, string> = {
  neutral: 'border-slate-200 bg-white text-slate-600',
  positive: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-rose-200 bg-rose-50 text-rose-700',
  info: 'border-cyan-200 bg-cyan-50 text-cyan-800',
};

export function TwinPill({
  icon,
  children,
  tone = 'neutral',
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: TwinPillTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
        PILL_TONE[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/* ── toolbar segmented control ─────────────────────────────────────── */

export function TwinSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ id: T; label: ReactNode; title?: string; disabled?: boolean }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex flex-wrap items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm"
    >
      {options.map((option) => {
        const isActive = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.id)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-[10.5px] font-bold transition-colors',
              isActive
                ? 'bg-slate-800 text-white'
                : option.disabled
                  ? 'cursor-not-allowed text-slate-300'
                  : 'text-slate-600 hover:bg-slate-100',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── rail sections ─────────────────────────────────────────────────── */

export function TwinRailSection({
  title,
  action,
  tone = 'neutral',
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  tone?: TwinPillTone;
  children: ReactNode;
}) {
  const accent =
    tone === 'danger'
      ? 'border-rose-200 bg-rose-50/70'
      : tone === 'warn'
        ? 'border-amber-200 bg-amber-50/70'
        : tone === 'positive'
          ? 'border-emerald-200 bg-emerald-50/70'
          : 'border-slate-200 bg-white';

  return (
    <div className={cn('rounded-xl border p-3', accent)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-slate-800">{title}</span>
        {action}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

export default TwinCard;
