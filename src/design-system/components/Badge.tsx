import type { ReactNode } from 'react';
import { cn } from '../utils';

export type BadgeTone = 'neutral' | 'success' | 'warn' | 'danger' | 'info';

export interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot = false, className, children }: BadgeProps) {
  return (
    <span className={cn('ds-badge', `ds-badge--${tone}`, className)}>
      {dot ? <span className="ds-badge__dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export default Badge;
