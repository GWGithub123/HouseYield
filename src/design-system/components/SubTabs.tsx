import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../utils';

// Re-export for callers that pass buttonProps without importing React types.
type ReactButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * SubTabs — segmented sub-navigation inside a page tab (promoted from the
 * Bookkeeping/Tax WorkspaceSubTabs). Controlled component; pair with the
 * page's own state or URL params.
 *
 * Page-level tabs live in WorkspaceTabsHeader (pinned by PageShell); SubTabs
 * organize content *within* a tab into 2–3 task-focused views.
 */
export type SubTabAccent = 'slate' | 'emerald' | 'sky' | 'amber' | 'violet' | 'indigo' | 'rose';

const ACCENTS: Record<SubTabAccent, { active: string; hover: string; dot: string }> = {
  slate: { active: 'border-slate-400 bg-slate-100 text-slate-900', hover: 'hover:border-slate-300 hover:text-slate-800', dot: 'bg-slate-400' },
  emerald: { active: 'border-emerald-300 bg-emerald-50 text-emerald-900', hover: 'hover:border-emerald-200 hover:text-emerald-800', dot: 'bg-emerald-500' },
  sky: { active: 'border-sky-300 bg-sky-50 text-sky-900', hover: 'hover:border-sky-200 hover:text-sky-800', dot: 'bg-sky-500' },
  amber: { active: 'border-amber-300 bg-amber-50 text-amber-900', hover: 'hover:border-amber-200 hover:text-amber-800', dot: 'bg-amber-500' },
  violet: { active: 'border-violet-300 bg-violet-50 text-violet-900', hover: 'hover:border-violet-200 hover:text-violet-800', dot: 'bg-violet-500' },
  indigo: { active: 'border-indigo-300 bg-indigo-50 text-indigo-900', hover: 'hover:border-indigo-200 hover:text-indigo-800', dot: 'bg-indigo-500' },
  rose: { active: 'border-rose-300 bg-rose-50 text-rose-900', hover: 'hover:border-rose-200 hover:text-rose-800', dot: 'bg-rose-500' },
};

export interface SubTabDef<T extends string = string> {
  id: T;
  label: ReactNode;
  /** Short label for narrow screens; falls back to label. */
  shortLabel?: ReactNode;
  icon?: LucideIcon;
  accent?: SubTabAccent;
  /** Plain-English description shown as the button title. */
  description?: string;
  /** Extra button attributes (e.g. data-voice-id for the assistant). */
  buttonProps?: ReactButtonProps;
}

export interface SubTabsProps<T extends string = string> {
  tabs: SubTabDef<T>[];
  activeId: T;
  onChange: (id: T) => void;
  /** Stick below the pinned page header while the body scrolls. */
  sticky?: boolean;
  className?: string;
}

export function SubTabs<T extends string>({ tabs, activeId, onChange, sticky = false, className }: SubTabsProps<T>) {
  return (
    <div className={cn(sticky && 'sticky top-2 z-30', className)}>
      <div className="overflow-x-auto rounded-2xl border border-slate-200/90 bg-white/90 p-1.5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] backdrop-blur">
        <div className="flex min-w-max items-center gap-1.5" role="tablist">
          {tabs.map((tab) => {
            const accent = ACCENTS[tab.accent ?? 'slate'];
            const active = tab.id === activeId;
            const Icon = tab.icon;
            const {
              className: buttonPropsClassName,
              onClick,
              type,
              ...restButtonProps
            } = tab.buttonProps ?? {};
            return (
              <button
                key={tab.id}
                type={type ?? 'button'}
                role="tab"
                aria-selected={active}
                title={tab.description}
                onClick={(event) => {
                  onClick?.(event);
                  if (!event.defaultPrevented) onChange(tab.id);
                }}
                className={cn(
                  'ds-focus-ring inline-flex items-center gap-2 whitespace-nowrap rounded-xl border px-3.5 py-2 text-sm font-semibold transition',
                  active ? cn(accent.active, 'shadow-sm') : cn('border-transparent text-slate-600 hover:bg-slate-50', accent.hover),
                  buttonPropsClassName,
                )}
                {...restButtonProps}
              >
                {Icon ? <Icon size={15} className={active ? '' : 'text-slate-400'} /> : null}
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.shortLabel ?? tab.label}</span>
                {active ? <span className={cn('h-1.5 w-1.5 rounded-full', accent.dot)} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default SubTabs;
