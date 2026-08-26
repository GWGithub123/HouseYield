import type { ReactNode } from 'react';
import { cn } from '../utils';

export type CardSurface = 'light' | 'glass';

export interface CardProps {
  children?: ReactNode;
  surface?: CardSurface;
  eyebrow?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  flushBody?: boolean;
  compact?: boolean;
  className?: string;
  bodyClassName?: string;
}

export function Card({
  children,
  surface = 'light',
  eyebrow,
  title,
  action,
  flushBody = false,
  compact = false,
  className,
  bodyClassName,
}: CardProps) {
  const hasHeader = Boolean(eyebrow || title || action);

  return (
    <section
      className={cn(
        'ds-card',
        compact && 'ds-card--compact',
        surface === 'glass' && 'ds-surface--glass border-0 shadow-none',
        className,
      )}
    >
      {hasHeader ? (
        <header className={cn('ds-card__header', hasHeader && !flushBody && children != null && 'ds-card__header--with-body')}>
          <div className="min-w-0">
            {eyebrow ? <div className="ds-card__eyebrow">{eyebrow}</div> : null}
            {title ? <div className="ds-card__title">{title}</div> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? (
        <div
          className={cn(
            'ds-card__body',
            flushBody && 'ds-card__body--flush',
            hasHeader && !flushBody && 'ds-card__body--bordered',
            bodyClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

export default Card;
