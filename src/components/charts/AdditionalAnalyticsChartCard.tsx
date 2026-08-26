import React from 'react';

type BadgeColor = 'blue' | 'orange' | 'green' | 'red' | 'purple' | 'cyan';

function ExpandButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all duration-200"
      title="Expand chart"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
      </svg>
    </button>
  );
}

export function AdditionalAnalyticsChartCard({
  children,
  title,
  badge,
  badgeColor = 'blue',
  subtitle,
  rightContent,
  className = '',
  contentClassName = 'h-44',
  onExpand,
  hideExpand = false,
}: {
  children: React.ReactNode;
  title: string;
  badge?: string;
  badgeColor?: BadgeColor;
  subtitle?: string;
  rightContent?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  onExpand?: () => void;
  hideExpand?: boolean;
}) {
  const badgeColors: Record<BadgeColor, string> = {
    blue: 'bg-blue-100 text-blue-700',
    orange: 'bg-orange-100 text-orange-700',
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-red-100 text-red-700',
    purple: 'bg-purple-100 text-purple-700',
    cyan: 'bg-cyan-100 text-cyan-700',
  };

  return (
    <div className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow duration-300 overflow-hidden ${className}`}>
      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            {badge && (
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${badgeColors[badgeColor]}`}>
                {badge}
              </span>
            )}
            <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
            {subtitle && (
              <span className="text-xs text-gray-500 font-medium">{subtitle}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {rightContent}
            {!hideExpand && <ExpandButton onClick={onExpand} />}
          </div>
        </div>
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
}