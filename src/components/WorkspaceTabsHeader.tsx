import React from 'react';

export type WorkspaceTabsHeaderTab<T extends string = string> = {
  id: T;
  label: React.ReactNode;
  description?: string;
  badge?: React.ReactNode;
  buttonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
};

type WorkspaceTabsHeaderProps<T extends string = string> = {
  eyebrow: React.ReactNode;
  heading?: React.ReactNode;
  subheading?: React.ReactNode;
  rightContent?: React.ReactNode;
  tabs: WorkspaceTabsHeaderTab<T>[];
  activeTab: T;
  onTabChange: (nextTab: T) => void;
  sectionProps?: React.HTMLAttributes<HTMLElement>;
  tabsWrapperProps?: React.HTMLAttributes<HTMLDivElement>;
  contentClassName?: string;
  sectionClassName?: string;
  topRowClassName?: string;
  tabsRowClassName?: string;
  activeTabClassName?: string;
  inactiveTabClassName?: string;
};

function mergeClassNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export default function WorkspaceTabsHeader<T extends string>({
  eyebrow,
  heading,
  subheading,
  rightContent,
  tabs,
  activeTab,
  onTabChange,
  sectionProps,
  tabsWrapperProps,
  contentClassName = 'max-w-7xl',
  sectionClassName = 'border-b border-slate-200 bg-white/70 px-2 pb-4 pt-1 backdrop-blur-sm',
  topRowClassName = 'mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between',
  tabsRowClassName = 'flex flex-wrap items-end justify-center gap-x-7 gap-y-2',
  activeTabClassName = 'border-slate-900 text-slate-900',
  inactiveTabClassName = 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900',
}: WorkspaceTabsHeaderProps<T>) {
  const { className: sectionPropsClassName, ...restSectionProps } = sectionProps ?? {};
  const { className: tabsWrapperPropsClassName, ...restTabsWrapperProps } = tabsWrapperProps ?? {};

  return (
    <section
      {...restSectionProps}
      className={mergeClassNames(sectionClassName, sectionPropsClassName)}
    >
      <div className={mergeClassNames('mx-auto', contentClassName)}>
        <div className={topRowClassName}>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">{eyebrow}</div>
            {heading ? <div className="mt-2 text-[28px] font-semibold tracking-tight text-slate-900 sm:text-[34px]">{heading}</div> : null}
            {subheading ? <div className="mt-1 text-sm text-slate-600 sm:text-base">{subheading}</div> : null}
          </div>
          {rightContent ? rightContent : null}
        </div>

        <div className="flex justify-center border-b border-slate-200">
          <div
            {...restTabsWrapperProps}
            className={mergeClassNames(tabsRowClassName, tabsWrapperPropsClassName)}
          >
            {tabs.map((tab) => {
              const isActive = tab.id === activeTab;
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
                  aria-selected={isActive}
                  onClick={(event) => {
                    onClick?.(event);
                    if (!event.defaultPrevented) {
                      onTabChange(tab.id);
                    }
                  }}
                  className={mergeClassNames(
                    'border-b-2 px-1 pb-3 text-[15px] font-semibold tracking-tight transition sm:text-base',
                    isActive ? activeTabClassName : inactiveTabClassName,
                    buttonPropsClassName,
                  )}
                  {...restButtonProps}
                >
                  <span className="inline-flex items-center gap-2">
                    <span>{tab.label}</span>
                    {tab.badge ? tab.badge : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}