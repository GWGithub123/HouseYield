import type { ReactNode } from 'react';
import { cn } from '../utils';

/**
 * KpiStrip — the hero number pattern (promoted from Bookkeeping / Tax Center).
 *
 * A gap-px grid with white cells: big bold tabular numbers over label-token
 * labels. This is the first and largest thing on every page/tab. Rules: one
 * strip per view, 3–4 numbers max, color only for meaning.
 *
 *   <KpiStrip
 *     items={[
 *       { label: 'Rental income', value: '$62,200.00', sub: '2025-01-01 – 2026-07-06' },
 *       { label: 'Total expenses', value: '$43,171.48', sub: 'Operating costs' },
 *       { label: 'Net income', value: '$19,028.52', sub: 'Profitable period', tone: 'positive', toneValue: true },
 *     ]}
 *   />
 */
export type KpiStripTone = 'default' | 'positive' | 'negative';

export interface KpiStripItem {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /**
   * Color for meaning (emerald / rose). By default this tints the sub/delta
   * line only — primary values stay slate so a negative yield never paints
   * "$3.3M" red. Set `toneValue` when the value itself is the signed metric
   * (e.g. Net Income / Net Cash Flow).
   */
  tone?: KpiStripTone;
  /** When true, also color the primary value with `tone`. Default false. */
  toneValue?: boolean;
  /** Optional small element rendered beside the label (e.g. an Explain chip). */
  labelExtra?: ReactNode;
  onClick?: () => void;
  active?: boolean;
}

export interface KpiStripProps {
  items: KpiStripItem[];
  /** Column count; defaults to the item count (capped at 4). */
  columns?: number;
  /** Wrap the strip in the standard card chrome. Defaults to true. */
  framed?: boolean;
  className?: string;
}

export function KpiStrip({ items, columns, framed = true, className }: KpiStripProps) {
  const cols = columns ?? Math.min(items.length, 4);

  const cells = items.map((item, index) => {
    const content = (
      <>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{item.label}</span>
          {item.labelExtra ?? null}
        </div>
        <div
          className={cn(
            'mt-1 text-2xl font-bold tabular-nums text-slate-900',
            item.toneValue && item.tone === 'positive' && 'text-emerald-600',
            item.toneValue && item.tone === 'negative' && 'text-rose-600',
          )}
        >
          {item.value}
        </div>
        {item.sub ? (
          <div
            className={cn(
              'mt-0.5 text-xs',
              item.tone === 'positive' && 'text-emerald-600',
              item.tone === 'negative' && 'text-rose-600',
              (!item.tone || item.tone === 'default') && 'text-slate-500',
            )}
          >
            {item.sub}
          </div>
        ) : null}
      </>
    );

    const cellClass = cn(
      'flex flex-col justify-center gap-0.5 bg-white px-5 py-4 text-left min-w-0',
      item.onClick && 'cursor-pointer transition hover:bg-slate-50 ds-focus-ring',
      item.active && 'shadow-[inset_0_-2px_0_#0f172a]',
    );

    if (item.onClick) {
      return (
        <button key={index} type="button" onClick={item.onClick} className={cellClass}>
          {content}
        </button>
      );
    }
    return (
      <div key={index} className={cellClass}>
        {content}
      </div>
    );
  });

  return (
    <div
      className={cn(
        'ds-kpi-strip',
        framed && 'border border-slate-200',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {cells}
    </div>
  );
}

export default KpiStrip;
