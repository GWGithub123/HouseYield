import type { ReactNode } from 'react';
import { cn } from '../utils';

/**
 * ShowcaseSurface — the one sanctioned accent surface: a dark panel with the
 * sharp illuminated border ring (same beveled-light treatment as the sidebar
 * shell), or its light lit-edge counterpart.
 *
 * Rules:
 * - At most ONE showcase surface per view (the hero chart or featured KPI cluster).
 * - Never for tables, forms, or text-heavy content.
 * - This is the only place dark surfaces are allowed in page content.
 */
export interface ShowcaseSurfaceProps {
  children: ReactNode;
  /** 'dark' (default) — dark panel; 'light' — white card with lit edge. */
  tone?: 'dark' | 'light';
  eyebrow?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function ShowcaseSurface({
  children,
  tone = 'dark',
  eyebrow,
  title,
  action,
  className,
  bodyClassName,
}: ShowcaseSurfaceProps) {
  const hasHeader = Boolean(eyebrow || title || action);
  return (
    <section className={cn('ds-showcase', tone === 'light' && 'ds-showcase--light', className)}>
      {hasHeader ? (
        <header className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="min-w-0">
            {eyebrow ? <div className="ds-label mb-1">{eyebrow}</div> : null}
            {title ? (
              <div
                className={cn(
                  'text-lg font-semibold tracking-tight',
                  tone === 'dark' ? 'text-white' : 'text-slate-900',
                )}
              >
                {title}
              </div>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={cn('px-6 py-5', hasHeader && 'pt-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export default ShowcaseSurface;
