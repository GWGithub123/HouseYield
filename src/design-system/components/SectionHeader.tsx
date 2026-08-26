import type { ReactNode } from 'react';
import { cn } from '../utils';

export interface SectionHeaderProps {
  label: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function SectionHeader({ label, description, action, className }: SectionHeaderProps) {
  return (
    <div className={cn('ds-section-header', className)}>
      <div className="min-w-0">
        <div className="ds-section-header__label">{label}</div>
        {description ? (
          <div className="ds-section-header__description">{description}</div>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export default SectionHeader;
