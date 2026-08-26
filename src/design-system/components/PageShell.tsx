import type { ReactNode } from 'react';
import { cn } from '../utils';

/**
 * PageShell — the standard page layout for all production pages.
 *
 * Implements the pinned-header mechanism from Market Insights: a flex column
 * that fills the viewport, with the header rendered OUTSIDE the scroll
 * container so it stays visible while the body scrolls.
 *
 * Usage:
 *   <PageShell header={<WorkspaceTabsHeader ... />}>
 *     ...page content...
 *   </PageShell>
 *
 * One content max-width platform-wide (max-w-7xl). Pass `wide` only when a
 * page genuinely needs edge-to-edge content (maps, canvases).
 */
export interface PageShellProps {
  /** Pinned header region (WorkspaceTabsHeader and/or KPI strip, filters). */
  header?: ReactNode;
  children: ReactNode;
  /** Extra pinned content below the header (e.g. a property filter row). */
  subHeader?: ReactNode;
  /** Use the full width instead of the standard max-w-7xl column. */
  wide?: boolean;
  className?: string;
  /** Class for the scrollable main region. */
  mainClassName?: string;
  /** Class for the inner content column. */
  contentClassName?: string;
}

export function PageShell({
  header,
  subHeader,
  children,
  wide = false,
  className,
  mainClassName,
  contentClassName,
}: PageShellProps) {
  return (
    <div className={cn('flex h-screen min-h-0 flex-col overflow-hidden ds-surface', className)}>
      {header ? <div className="shrink-0">{header}</div> : null}
      {subHeader ? <div className="shrink-0">{subHeader}</div> : null}
      <main className={cn('min-h-0 flex-1 overflow-y-auto', mainClassName)}>
        <div
          className={cn(
            'mx-auto w-full px-6 py-6',
            wide ? 'max-w-none' : 'max-w-7xl',
            contentClassName,
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export default PageShell;
