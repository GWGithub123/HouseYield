import type { ReactNode } from 'react';
import { cn } from '../utils';
import { GlossaryTip } from './GlossaryTip';

/**
 * SectionGroupHeader — the sharp labeled divider that starts every content
 * group (promoted from Bookkeeping / Tax; visual language matches the sidebar
 * section labels). Accent bar + label-token title + hairline rule.
 */
export type SectionGroupAccent =
  | 'slate'
  | 'emerald'
  | 'sky'
  | 'amber'
  | 'violet'
  | 'indigo'
  | 'rose';

const ACCENTS: Record<SectionGroupAccent, { bar: string; text: string; band: string }> = {
  slate: { bar: 'bg-slate-400', text: 'text-slate-700', band: 'from-slate-100/80' },
  emerald: { bar: 'bg-emerald-500', text: 'text-emerald-800', band: 'from-emerald-50/80' },
  sky: { bar: 'bg-sky-500', text: 'text-sky-800', band: 'from-sky-50/80' },
  amber: { bar: 'bg-amber-500', text: 'text-amber-800', band: 'from-amber-50/80' },
  violet: { bar: 'bg-violet-500', text: 'text-violet-800', band: 'from-violet-50/80' },
  indigo: { bar: 'bg-indigo-500', text: 'text-indigo-800', band: 'from-indigo-50/80' },
  rose: { bar: 'bg-rose-500', text: 'text-rose-800', band: 'from-rose-50/80' },
};

export interface SectionGroupHeaderProps {
  title: string;
  /** Plain-English hint shown in a glossary tooltip. */
  hint?: string;
  accent?: SectionGroupAccent;
  right?: ReactNode;
  className?: string;
}

export function SectionGroupHeader({ title, hint, accent = 'slate', right, className }: SectionGroupHeaderProps) {
  const classes = ACCENTS[accent];
  return (
    <div className={cn('flex items-center gap-3 rounded-xl bg-gradient-to-r to-transparent px-3 py-2', classes.band, className)}>
      <span className={cn('h-4 w-1 shrink-0 rounded-full', classes.bar)} />
      <h3 className={cn('text-[11px] font-bold uppercase tracking-[0.22em]', classes.text)}>{title}</h3>
      {hint ? <GlossaryTip term={title} explanation={hint} /> : null}
      <div className="h-px flex-1 bg-slate-200/80" />
      {right ? <div className="flex items-center gap-2 text-xs text-slate-500">{right}</div> : null}
    </div>
  );
}

export default SectionGroupHeader;
