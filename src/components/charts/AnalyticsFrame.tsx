import React from 'react';
import SidebarLiquidGlassShell, { SIDEBAR_GLASS_BUTTON_CLASS } from '../SidebarLiquidGlassShell';

export function ExpandButton({ onClick, sidebarGlass = false }: { onClick: () => void; sidebarGlass?: boolean }) {
  const className = sidebarGlass
    ? `analytics-glass-expand-btn ${SIDEBAR_GLASS_BUTTON_CLASS} p-2`
    : 'analytics-glass-expand-btn rounded-md bg-slate-50 p-2 text-slate-800 transition-colors hover:bg-slate-100 hover:text-slate-950';

  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      title="Expand chart"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="square" strokeLinejoin="miter" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
      </svg>
    </button>
  );
}

export function AnalyticsCard({
  title,
  controls,
  children,
  className = '',
  compact = false,
  dense = false,
  lockAspectRatio = true,
  sidebarGlass = false,
}: {
  title: React.ReactNode;
  controls?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  compact?: boolean;
  dense?: boolean;
  lockAspectRatio?: boolean;
  sidebarGlass?: boolean;
}) {
  const sizingClasses = compact
    ? dense
      ? `h-full min-h-[182px] ${lockAspectRatio ? 'xl:aspect-square xl:min-h-0' : ''}`
      : 'h-full min-h-[200px] xl:min-h-[220px]'
    : `h-full min-h-[430px] ${lockAspectRatio ? 'xl:aspect-square xl:min-h-0' : ''}`;
  const headerPadding = compact ? (dense ? 'px-4 py-2.5' : 'px-4 py-3') : 'px-6 py-5';
  const titleSize = compact
    ? dense
      ? 'text-[14px] font-semibold leading-[1.2] tracking-[-0.01em] text-slate-800'
      : 'text-[15px] font-semibold leading-[1.25] tracking-[-0.01em] text-slate-800'
    : 'text-[18px] font-semibold leading-[1.25] tracking-[-0.02em] text-slate-800 sm:text-[19px]';
  const bodyPadding = compact ? (dense ? 'px-2 pb-1.5 pt-1.5' : 'px-2 pb-2 pt-2') : 'px-3 pb-3 pt-3 sm:px-4 sm:pb-4';

  if (sidebarGlass) {
    return (
      <div className="analytics-card-halo-wrap">
        <SidebarLiquidGlassShell className={`analytics-sidebar-glass flex flex-col ${sizingClasses} ${className}`} contentClassName="flex h-full flex-col">
          <div className={`analytics-glass-header flex items-start justify-between gap-4 ${headerPadding}`}>
            <div className={`analytics-glass-title ${titleSize}`}>{title}</div>
            <div className="flex shrink-0 items-center gap-2">{controls}</div>
          </div>
          <div className={`analytics-glass-body analytics-glass-divider flex-1 border-t border-slate-200 ${bodyPadding}`}>
            <div className="h-full min-h-0 w-full">{children}</div>
          </div>
        </SidebarLiquidGlassShell>
      </div>
    );
  }

  return (
    <div className={`analytics-glass-card flex flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_42px_rgba(15,23,42,0.10)] ${sizingClasses} ${className}`}>
      <div className={`analytics-glass-header flex items-start justify-between gap-4 ${headerPadding}`}>
        <div className={`analytics-glass-title ${titleSize}`}>{title}</div>
        <div className="flex shrink-0 items-center gap-2">{controls}</div>
      </div>
      <div className={`analytics-glass-body analytics-glass-divider flex-1 border-t border-slate-200/70 ${bodyPadding}`}>
        <div className="h-full min-h-0 w-full">{children}</div>
      </div>
    </div>
  );
}

export function ChartModal({
  title,
  controls,
  wide = false,
  onClose,
  children,
}: {
  title: React.ReactNode;
  controls?: React.ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-y-0 right-0 z-[10001] flex items-center justify-center" style={{ left: '248px' }}>
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className={`relative max-h-[92vh] overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.22)] ${wide ? 'w-[min(1600px,calc(100vw-256px))]' : 'w-[min(1500px,calc(100vw-256px))]'}`}>
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-7 py-5">
          <div className="flex items-center gap-4">{title}</div>
          <div className="flex items-center gap-3">
            {controls}
            <button onClick={onClose} className="rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-800">
              Close
            </button>
          </div>
        </div>
        <div className="h-[76vh] px-2 py-2 sm:px-3 sm:py-3">{children}</div>
      </div>
    </div>
  );
}

export function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="analytics-glass-toggle inline-flex items-center rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-xl px-5 py-2 text-sm font-medium transition-colors ${value === option.value ? 'bg-indigo-500 text-white shadow-sm' : 'text-slate-700 hover:bg-slate-100'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}