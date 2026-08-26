import { cn } from '../utils';

export interface SectionDividerProps {
  label?: string;
  className?: string;
}

export function SectionDivider({ label, className }: SectionDividerProps) {
  if (!label) {
    return <hr className={cn('h-0 border-0 border-t border-slate-200', className)} aria-hidden />;
  }

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
        {label}
      </span>
      <hr className="h-0 flex-1 border-0 border-t border-slate-200" aria-hidden />
    </div>
  );
}

export default SectionDivider;
