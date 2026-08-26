import { cn } from '../utils';

/**
 * Skeleton — the standard loading placeholder. Matches the card geometry so
 * content doesn't shift when data arrives. Never show a spinner-in-a-blank
 * area; render the skeleton of the layout that's coming.
 */
export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden className={cn('ds-skeleton', className)} />;
}

/** Skeleton in the shape of a standard card (header band + content lines). */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('ds-card', className)} aria-busy="true" aria-live="polite">
      <div className="border-b border-slate-100 px-5 py-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-5 w-48" />
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        {Array.from({ length: lines }).map((_, index) => (
          <Skeleton key={index} className={cn('h-4', index === lines - 1 ? 'w-2/3' : 'w-full')} />
        ))}
      </div>
    </div>
  );
}

/** Skeleton in the shape of a KpiStrip. */
export function SkeletonKpiStrip({ columns = 3, className }: { columns?: number; className?: string }) {
  return (
    <div
      className={cn('ds-kpi-strip rounded-2xl border border-slate-200/80', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      aria-busy="true"
    >
      {Array.from({ length: columns }).map((_, index) => (
        <div key={index} className="ds-kpi-strip__cell">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-1 h-7 w-28" />
          <Skeleton className="mt-1 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
