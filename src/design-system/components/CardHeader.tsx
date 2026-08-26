import type { ReactNode } from 'react';
import { cn } from '../utils';
import { GlossaryTip } from './GlossaryTip';

/**
 * CardHeader — the standard header band inside a Card body (promoted from the
 * Bookkeeping/Tax pattern). Title + optional plain-English subtitle on the
 * left, actions on the right, hairline divider below.
 */
export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional label-token eyebrow above the title (e.g. "SCHEDULE E — 2025"). */
  eyebrow?: ReactNode;
  right?: ReactNode;
  /** Plain-English tooltip explaining the section's term of art. */
  info?: string;
  /** Term shown in the tooltip header; defaults to the title when a string. */
  infoTerm?: string;
  className?: string;
}

export function CardHeader({ title, subtitle, eyebrow, right, info, infoTerm, className }: CardHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-4', className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="ds-label mb-1">{eyebrow}</div> : null}
        <h3 className="inline-flex items-center gap-1.5 text-base font-semibold tracking-tight text-slate-900">
          {title}
          {info ? <GlossaryTip term={infoTerm ?? (typeof title === 'string' ? title : '')} explanation={info} /> : null}
        </h3>
        {subtitle ? <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-slate-500">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}

export default CardHeader;
