import type { ReactNode } from 'react';
import { cn } from '../../design-system/utils';
import { TwinSegmented } from './TwinCard';

/**
 * The Overview shell for Properties.
 *
 * Previously the page stacked three full-width slabs — portfolio map, value
 * trend, then the property card — so the eye had to travel past two portfolio
 * boxes to reach the property being looked at. Here they are one card: the
 * toolbar swaps what occupies the centre, and the property facts stay pinned
 * beside it in the rail so they never move.
 *
 * The visual frame is `flex-1` inside a stretched grid row, so it grows to
 * whatever height the fact rail needs. That is what keeps the dead space out:
 * the column that runs short is always the one that stretches.
 */

export type PropertyVisualView = 'street' | 'map' | 'trend';

export interface PropertyTwinCardProps {
  eyebrow?: ReactNode;
  /** Usually the street address. Truncates rather than wrapping the header. */
  title: ReactNode;
  headerRight?: ReactNode;
  views: Array<{ id: PropertyVisualView; label: ReactNode; title?: string; disabled?: boolean }>;
  view: PropertyVisualView;
  onViewChange: (next: PropertyVisualView) => void;
  /** Granularity switches and similar controls, right of the view switcher. */
  toolbarExtra?: ReactNode;
  /** Fills the centre frame. Expected to be `h-full w-full`. */
  visual: ReactNode;
  /** Absolutely positioned controls over the visual, such as an expand button. */
  visualOverlay?: ReactNode;
  /** A caption strip under the visual: upload control, counts, legend. */
  visualFooter?: ReactNode;
  /** Fact panels. Two-up below the visual until xl, then a single rail column. */
  facts: ReactNode;
  /** Full-width rows under both columns, such as the tenant and community strips. */
  footer?: ReactNode;
  className?: string;
}

export function PropertyTwinCard({
  eyebrow = 'Property',
  title,
  headerRight,
  views,
  view,
  onViewChange,
  toolbarExtra,
  visual,
  visualOverlay,
  visualFooter,
  facts,
  footer,
  className,
}: PropertyTwinCardProps) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-slate-200/70 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)]',
        className,
      )}
      data-testid="property-twin-card"
    >
      <header className="flex flex-col gap-2 border-b border-slate-200 pb-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
            {eyebrow}
          </div>
          <h2 className="mt-0.5 truncate text-[17px] font-bold leading-tight text-slate-950" title={typeof title === 'string' ? title : undefined}>
            {title}
          </h2>
        </div>
        {headerRight ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold lg:justify-end">
            {headerRight}
          </div>
        ) : null}
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <TwinSegmented options={views} value={view} onChange={onViewChange} ariaLabel="Overview visual" />
        {toolbarExtra}
      </div>

      <div className="mt-3 grid items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="relative min-h-[360px] flex-1 overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
            {visual}
            {visualOverlay}
          </div>
          {visualFooter}
        </div>

        <aside className="grid min-w-0 content-start gap-2.5 sm:grid-cols-2 xl:grid-cols-1">
          {facts}
        </aside>
      </div>

      {footer ? <div className="mt-3 space-y-2">{footer}</div> : null}
    </section>
  );
}

export default PropertyTwinCard;
