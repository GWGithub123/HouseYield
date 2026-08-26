import { useMemo, useState } from 'react';

type AllocationTooltipPlacement = 'top' | 'right' | 'bottom' | 'left';

export type AllocationBreakdownItem = {
  id: string;
  name: string;
  subtitle: string;
  value: number;
  weight: number;
  primaryMeta: string;
  secondaryMeta?: string;
  badgeText: string;
  logoUrl?: string;
  interactiveType?: 'stock';
};

export type AllocationClassDetail = {
  label: string;
  color: string;
  value: number;
  percentage: number;
  description: string;
  stats: Array<{ label: string; value: string }>;
  holdings: AllocationBreakdownItem[];
};

export type AllocationSlice = {
  label: string;
  value: number;
  percentage: number;
  color: string;
};

type AllocationTooltipData = {
  label: string;
  percentage: number;
  placement: AllocationTooltipPlacement;
  cardX: number;
  cardY: number;
  width: number;
  height: number;
  pointerOffset: number;
};

type NetWorthAllocationPanelProps = {
  allocations: AllocationSlice[];
  totalValue: number;
  totalLiabilities: number;
  viewMode: 'assets' | 'equity';
  hasRealEstateHoldings: boolean;
  classDetails: Record<string, AllocationClassDetail>;
  formatCurrency: (value: number) => string;
  onSwitchToAssetView?: () => void;
  onOpenInteractiveHolding?: (holding: AllocationBreakdownItem, classDetail: AllocationClassDetail) => void;
  highlightedLabels?: string[];
  sectionCardClassName?: string;
  layout?: 'horizontal' | 'vertical';
  showAllocationTable?: boolean;
  sectionTitle?: string;
  segmentCountLabel?: 'class' | 'property';
  embedded?: boolean;
};

export type { NetWorthAllocationPanelProps };

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians)),
  };
}

function describeArc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return [
    'M', start.x, start.y,
    'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y,
  ].join(' ');
}

export function NetWorthAllocationPanel({
  allocations,
  totalValue,
  totalLiabilities,
  viewMode,
  hasRealEstateHoldings,
  classDetails,
  formatCurrency,
  onSwitchToAssetView,
  onOpenInteractiveHolding,
  highlightedLabels,
  sectionCardClassName = 'rounded-[28px] border border-slate-200 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.08)]',
  layout = 'horizontal',
  showAllocationTable = true,
  sectionTitle = 'Asset class',
  segmentCountLabel = 'class',
  embedded = false,
}: NetWorthAllocationPanelProps) {
  const isVertical = layout === 'vertical';
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [selectedAllocationClass, setSelectedAllocationClass] = useState<string | null>(null);

  const activeAllocationClassDetail = selectedAllocationClass
    ? classDetails[selectedAllocationClass] || null
    : null;

  const segments = useMemo(() => {
    let cumulativePercentage = 0;
    return allocations.map((item) => {
      const startPercentage = cumulativePercentage;
      cumulativePercentage += item.percentage;
      return { ...item, startPercentage };
    });
  }, [allocations]);

  const radius = 100;
  const strokeWidth = 30;
  const center = 145;
  const hasHighlights = Boolean(highlightedLabels && highlightedLabels.length > 0);
  const nonZeroSegmentCount = allocations.filter((item) => item.percentage > 0).length;

  const hoveredAllocationTooltip = useMemo<AllocationTooltipData | null>(() => {
    if (hoveredSegment === null) {
      return null;
    }

    const segment = segments[hoveredSegment];
    if (!segment || segment.percentage <= 0) {
      return null;
    }

    const startAngle = (segment.startPercentage / 100) * 360;
    const endAngle = startAngle + (segment.percentage / 100) * 360;
    const midAngle = (startAngle + endAngle) / 2;
    const anchor = polarToCartesian(center, center, radius + (strokeWidth / 2) + 12, midAngle);
    const dx = anchor.x - center;
    const dy = anchor.y - center;
    const placement: AllocationTooltipPlacement = Math.abs(dy) > 72 && Math.abs(dx) < 70
      ? (dy >= 0 ? 'bottom' : 'top')
      : 'left';
    const width = segment.label.length > 18 ? 172 : 152;
    const height = 56;
    const gap = 24;
    const chartBounds = 290;
    const edgeInset = 8;
    const leftOverflowAllowance = 118;
    const topOverflowAllowance = 96;
    const bottomOverflowAllowance = 36;
    const outerEdge = radius + (strokeWidth / 2) + 10;

    let cardX = anchor.x;
    let cardY = anchor.y;
    let pointerOffset = 0;

    if (placement === 'left') {
      cardX = center - outerEdge - gap - width;
      cardY = Math.max(-topOverflowAllowance, Math.min(chartBounds - height + bottomOverflowAllowance, anchor.y - (height / 2)));
      pointerOffset = anchor.y - cardY;
    } else if (placement === 'top') {
      cardX = Math.max(-leftOverflowAllowance, Math.min(chartBounds - width - edgeInset, anchor.x - (width / 2)));
      cardY = center - outerEdge - gap - height;
      pointerOffset = anchor.x - cardX;
    } else {
      cardX = Math.max(-leftOverflowAllowance, Math.min(chartBounds - width - edgeInset, anchor.x - (width / 2)));
      cardY = center + outerEdge + gap;
      pointerOffset = anchor.x - cardX;
    }

    return {
      label: segment.label,
      percentage: segment.percentage,
      placement,
      cardX,
      cardY,
      width,
      height,
      pointerOffset,
    };
  }, [center, hoveredSegment, radius, segments, strokeWidth]);

  return (
    <>
      {viewMode === 'equity' && totalLiabilities > 0 && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" />
                <path d="M7 14l3-3 3 3 4-5" />
              </svg>
            </span>
            <span className="text-sm text-slate-600">
              Showing <strong className="font-semibold text-slate-900">equity values</strong> (assets minus liabilities). Total debt: <span className="font-semibold text-slate-900">${totalLiabilities.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
            </span>
          </div>
          {onSwitchToAssetView ? (
            <button
              onClick={onSwitchToAssetView}
              className="flex-shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold text-indigo-600 transition-colors hover:bg-white hover:text-indigo-700"
            >
              Switch to asset view
            </button>
          ) : null}
        </div>
      )}

      {viewMode === 'equity' && totalLiabilities === 0 && hasRealEstateHoldings && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-100 bg-amber-50/70 px-4 py-3">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-white text-amber-500 shadow-sm">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z" />
              <path d="M9 21h6" />
            </svg>
          </span>
          <span className="text-sm text-slate-600">
            <strong className="font-semibold text-slate-900">No synced mortgages found yet.</strong> Properties added to the platform flow in automatically here; add or update the property mortgage details to show true equity.
          </span>
        </div>
      )}

      <div
        className={embedded ? undefined : `${sectionCardClassName} p-6 ${showAllocationTable ? '' : 'flex h-full flex-col justify-center'}`}
        data-voice-id="allocation-table-card"
      >
        {!embedded ? (
        <div className={`mb-2 flex items-center gap-2 ${showAllocationTable ? '' : 'justify-center'}`}>
          <span className="h-5 w-1 rounded-full bg-gradient-to-b from-teal-500 via-indigo-500 to-violet-500" />
          <h2 className="text-base font-semibold text-slate-900" data-voice-id="asset-class-header">{sectionTitle}</h2>
        </div>
        ) : null}

        <div className={`relative flex ${showAllocationTable ? `gap-8 ${isVertical ? 'flex-col items-center' : 'items-center'}` : 'items-center justify-center'}`}>
          {showAllocationTable ? (
          <div className={`${isVertical ? 'order-2 w-full' : 'w-2/3'}`} data-voice-id="allocation-table-container">
            <table className="w-full" data-voice-id="allocation-table">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Asset class</th>
                  <th className="py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Portfolio %</th>
                  <th className="py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Market value $</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-200 font-semibold">
                  <td className="py-2.5 text-sm text-slate-900">Total market value</td>
                  <td className="text-right text-sm tabular-nums text-slate-900">100.0%</td>
                  <td className="text-right text-sm tabular-nums text-slate-900">${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
                {allocations.map((item, idx) => {
                  const isHighlighted = !hasHighlights || (highlightedLabels ?? []).includes(item.label);
                  const isHovered = hoveredSegment === idx;
                  const isExpanded = expandedCategory === item.label;
                  const classDetail = classDetails[item.label] || {
                    label: item.label,
                    color: item.color,
                    value: item.value,
                    percentage: item.percentage,
                    description: '',
                    stats: [],
                    holdings: [],
                  };
                  const rowVoiceId = item.label.toLowerCase().replace(/\s+/g, '-');

                  return (
                    <>
                      <tr
                        data-voice-id={`asset-class-row-${rowVoiceId}`}
                        className={`border-b border-slate-100 cursor-pointer transition-colors ${isHovered || isExpanded ? 'bg-slate-50' : 'hover:bg-slate-50/70'} ${isHighlighted ? '' : 'opacity-40'}`}
                        onClick={() => setExpandedCategory(isExpanded ? null : item.label)}
                      >
                        <td className="py-2.5">
                          <div className="flex items-center gap-2.5">
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="text-slate-400 transition-transform"
                              style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                            >
                              <path d="M4 2.5L8 6L4 9.5" />
                            </svg>
                            <span
                              className="h-4 w-[3px] flex-shrink-0 rounded-full transition-transform"
                              style={{ backgroundColor: item.color, transform: isHovered ? 'scaleY(1.25)' : 'scaleY(1)' }}
                            />
                            <span className={`text-sm text-slate-800 ${isHovered || isExpanded ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
                          </div>
                        </td>
                        <td className="text-right text-sm tabular-nums font-medium text-slate-700">{item.percentage.toFixed(1)}%</td>
                        <td className="text-right text-sm tabular-nums text-slate-700">${item.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      </tr>

                      {isExpanded && (
                        classDetail.holdings.length > 0 ? (
                          classDetail.holdings.map((holding, holdingIdx) => {
                            const isInteractiveStock = holding.interactiveType === 'stock' && Boolean(onOpenInteractiveHolding);

                            return (
                              <tr
                                key={holding.id}
                                data-voice-id={`allocation-holding-row-${rowVoiceId}-${holdingIdx}`}
                                className={`border-b border-slate-100 bg-slate-50/60 transition-colors ${isInteractiveStock ? 'cursor-pointer hover:bg-slate-100/70' : ''}`}
                                onClick={(event) => {
                                  if (!isInteractiveStock) {
                                    return;
                                  }

                                  event.stopPropagation();
                                  onOpenInteractiveHolding?.(holding, classDetail);
                                }}
                              >
                                <td className="py-2 pl-5">
                                  <div className="flex items-center gap-2.5">
                                    <div className="flex-shrink-0">
                                      {holding.logoUrl ? (
                                        <img
                                          src={holding.logoUrl}
                                          alt={holding.subtitle}
                                          className="h-9 w-9 rounded-xl border border-slate-200 bg-white p-1 object-contain shadow-sm"
                                          onError={(event) => {
                                            (event.target as HTMLImageElement).style.display = 'none';
                                          }}
                                        />
                                      ) : (
                                        <div
                                          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-[10px] font-semibold tracking-[0.12em] text-slate-500 shadow-sm"
                                          style={{ color: item.color }}
                                        >
                                          {holding.badgeText}
                                        </div>
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-semibold text-slate-900">{holding.name}</div>
                                      <div className="mb-1 text-xs text-slate-500">{holding.subtitle}</div>
                                      <div className="h-1.5 w-40 overflow-hidden rounded-full bg-slate-200">
                                        <div
                                          className="h-full rounded-full transition-all duration-300"
                                          style={{
                                            width: `${Math.min(holding.weight, 100)}%`,
                                            backgroundColor: item.color,
                                          }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <span className="text-sm font-medium tabular-nums text-slate-700">{holding.weight.toFixed(2)}%</span>
                                </td>
                                <td className="py-2 text-right">
                                  <div className="flex flex-col items-end gap-0.5">
                                    <span className="text-sm font-medium tabular-nums text-slate-900">{formatCurrency(holding.value)}</span>
                                    <span className="text-xs text-slate-500">{holding.primaryMeta}</span>
                                    {holding.secondaryMeta && (
                                      <span className="text-xs text-slate-400">{holding.secondaryMeta}</span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        ) : (
                          <tr className="border-b border-slate-100 bg-slate-50/60">
                            <td colSpan={3} className="px-6 py-4 text-sm text-slate-500">
                              No positions are currently grouped into {item.label}.
                            </td>
                          </tr>
                        )
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
          ) : null}

          <div className={`relative flex-shrink-0 overflow-visible ${isVertical && showAllocationTable ? 'order-1' : ''}`} style={{ width: 290, height: 290 }} data-voice-id="allocation-donut-chart">
            <svg width="290" height="290" viewBox="0 0 290 290" data-voice-id="allocation-pie-chart-svg">
              <defs>
                <filter id="allocation-donut-shadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="6" stdDeviation="7" floodColor="#0f172a" floodOpacity="0.12" />
                </filter>
              </defs>

              {/* Background track ring */}
              <circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke="#eef2f7"
                strokeWidth={strokeWidth}
              />

              {segments.map((segment, idx) => {
                if (segment.percentage <= 0) {
                  return null;
                }
                const rawStart = (segment.startPercentage / 100) * 360;
                const rawEnd = rawStart + (segment.percentage / 100) * 360;
                // Hairline gap between flat-cut segments; skip gaps when a single class fills the ring.
                const gapDeg = nonZeroSegmentCount > 1 ? Math.min(1.4, (rawEnd - rawStart) / 4) : 0;
                const startAngle = rawStart + gapDeg / 2;
                const endAngle = Math.max(startAngle + 0.01, rawEnd - gapDeg / 2);
                const isHovered = hoveredSegment === idx;
                const currentStrokeWidth = isHovered ? strokeWidth + 7 : strokeWidth;
                const isHighlighted = !hasHighlights || (highlightedLabels ?? []).includes(segment.label);
                const d = describeArc(center, center, radius, startAngle, endAngle);

                return (
                  <g key={segment.label}>
                    <path
                      d={d}
                      fill="none"
                      stroke={segment.color}
                      strokeWidth={currentStrokeWidth}
                      strokeLinecap="butt"
                      style={{
                        cursor: 'pointer',
                        transition: 'stroke-width 0.2s ease, opacity 0.2s ease',
                        opacity: isHighlighted ? 1 : 0.28,
                        filter: isHovered ? 'url(#allocation-donut-shadow)' : undefined,
                      }}
                      onMouseEnter={() => setHoveredSegment(idx)}
                      onMouseLeave={() => setHoveredSegment(null)}
                      onClick={() => {
                        if (segment.percentage > 0) {
                          setSelectedAllocationClass(segment.label);
                        }
                      }}
                      role="button"
                      tabIndex={segment.percentage > 0 ? 0 : -1}
                      aria-label={`Open ${segment.label} overview`}
                      onKeyDown={(event) => {
                        if (segment.percentage <= 0) {
                          return;
                        }

                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedAllocationClass(segment.label);
                        }
                      }}
                    />
                  </g>
                );
              })}

              <text
                x={center}
                y={center - 12}
                textAnchor="middle"
                fontSize="10"
                fontWeight="600"
                letterSpacing="1.4"
                fill="#94a3b8"
              >
                {(viewMode === 'equity' ? 'NET WORTH' : 'MARKET VALUE')}
              </text>
              <text
                x={center}
                y={center + 10}
                textAnchor="middle"
                fontSize="21"
                fontWeight="700"
                letterSpacing="-0.5"
                fill="#0f172a"
              >
                ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </text>
              <text
                x={center}
                y={center + 28}
                textAnchor="middle"
                fontSize="11"
                fill="#94a3b8"
              >
                across {nonZeroSegmentCount} {segmentCountLabel === 'property'
                  ? (nonZeroSegmentCount === 1 ? 'property' : 'properties')
                  : (nonZeroSegmentCount === 1 ? 'class' : 'classes')}
              </text>
            </svg>

            {hoveredAllocationTooltip && (
              <div
                className="pointer-events-none absolute left-0 top-0 z-20 overflow-visible"
                style={{ transform: `translate(${hoveredAllocationTooltip.cardX}px, ${hoveredAllocationTooltip.cardY}px)` }}
              >
                <div
                  className="relative rounded-[16px] border border-slate-800/80 bg-slate-900/95 px-3 py-2.5 text-white shadow-[0_16px_36px_rgba(15,23,42,0.2)]"
                  style={{ width: hoveredAllocationTooltip.width, minHeight: hoveredAllocationTooltip.height }}
                >
                  <div className="text-[11px] font-medium leading-snug tracking-[0.01em] text-slate-300">{hoveredAllocationTooltip.label}</div>
                  <div className="mt-1 text-[22px] font-semibold leading-none tracking-[-0.03em] text-white">{hoveredAllocationTooltip.percentage.toFixed(1)}%</div>
                  <div
                    className="absolute h-2.5 w-2.5 rotate-45 border-slate-800/80 bg-slate-900/95"
                    style={
                      hoveredAllocationTooltip.placement === 'left'
                        ? {
                            right: 0,
                            top: `${Math.max(12, Math.min(hoveredAllocationTooltip.height - 12, hoveredAllocationTooltip.pointerOffset))}px`,
                            transform: 'translate(50%, -50%) rotate(45deg)',
                          }
                        : hoveredAllocationTooltip.placement === 'top'
                          ? {
                              bottom: 0,
                              left: `${Math.max(18, Math.min(hoveredAllocationTooltip.width - 18, hoveredAllocationTooltip.pointerOffset))}px`,
                              transform: 'translate(-50%, 50%) rotate(45deg)',
                            }
                          : {
                              top: 0,
                              left: `${Math.max(18, Math.min(hoveredAllocationTooltip.width - 18, hoveredAllocationTooltip.pointerOffset))}px`,
                              transform: 'translate(-50%, -50%) rotate(45deg)',
                            }
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {activeAllocationClassDetail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
          data-voice-id="allocation-overview-modal-overlay"
          onClick={() => setSelectedAllocationClass(null)}
        >
          <div
            className="max-h-[92vh] w-[min(1100px,calc(100vw-2rem))] overflow-auto rounded-[28px] border border-slate-200 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.22)]"
            data-voice-id="allocation-overview-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white/95 px-6 py-5 backdrop-blur-sm">
              <div className="flex items-start gap-4">
                <div
                  className="mt-1 h-12 w-12 rounded-2xl border border-slate-200 shadow-[0_8px_24px_rgba(15,23,42,0.08)]"
                  style={{ backgroundColor: activeAllocationClassDetail.color }}
                />
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">Asset class overview</div>
                  <h2 className="text-[30px] font-semibold tracking-[-0.03em] text-slate-900">{activeAllocationClassDetail.label}</h2>
                  <p className="max-w-3xl text-sm leading-6 text-slate-500">{activeAllocationClassDetail.description}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedAllocationClass(null)}
                className="rounded-xl bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                data-voice-id="close-allocation-overview-modal-btn"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-6 p-6 sm:p-7">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {[
                  { label: viewMode === 'equity' ? 'Sleeve value' : 'Market value', value: formatCurrency(activeAllocationClassDetail.value) },
                  { label: 'Portfolio share', value: `${activeAllocationClassDetail.percentage.toFixed(2)}%` },
                  ...activeAllocationClassDetail.stats,
                ].map((stat) => (
                  <div key={`${activeAllocationClassDetail.label}-${stat.label}`} className="rounded-[22px] border border-slate-200 bg-slate-50/80 p-4 shadow-[0_4px_14px_rgba(15,23,42,0.04)]">
                    <div className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-slate-400">{stat.label}</div>
                    <div className="text-[26px] font-semibold tracking-[-0.03em] text-slate-900">{stat.value}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_4px_14px_rgba(15,23,42,0.04)]">
                <div className="mb-4 flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-slate-900">Underlying positions</h3>
                    <p className="text-sm text-slate-500">The sleeve breakdown below mirrors the table expansion, with the same holdings ordered from largest to smallest.</p>
                  </div>
                  <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600">
                    {activeAllocationClassDetail.holdings.length} holding{activeAllocationClassDetail.holdings.length === 1 ? '' : 's'}
                  </div>
                </div>

                {activeAllocationClassDetail.holdings.length > 0 ? (
                  <div className="space-y-3">
                    {activeAllocationClassDetail.holdings.map((holding) => {
                      const isInteractiveStock = holding.interactiveType === 'stock' && Boolean(onOpenInteractiveHolding);

                      return (
                        <div
                          key={`${activeAllocationClassDetail.label}-${holding.id}`}
                          className={`flex flex-col gap-4 rounded-[22px] border border-slate-200 bg-slate-50/80 p-4 transition-colors md:flex-row md:items-center md:justify-between ${isInteractiveStock ? 'cursor-pointer hover:border-slate-300 hover:bg-slate-100/80' : ''}`}
                          onClick={() => {
                            if (!isInteractiveStock) {
                              return;
                            }

                            setSelectedAllocationClass(null);
                            onOpenInteractiveHolding?.(holding, activeAllocationClassDetail);
                          }}
                        >
                          <div className="min-w-0 flex items-center gap-3">
                            {holding.logoUrl ? (
                              <img
                                src={holding.logoUrl}
                                alt={holding.subtitle}
                                className="h-12 w-12 rounded-xl border border-slate-200 bg-white p-1 object-contain shadow-sm"
                                onError={(event) => {
                                  (event.target as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            ) : (
                              <div
                                className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-white text-xs font-semibold tracking-[0.12em] text-slate-500 shadow-sm"
                                style={{ color: activeAllocationClassDetail.color }}
                              >
                                {holding.badgeText}
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="truncate text-base font-semibold text-slate-900">{holding.name}</div>
                              <div className="text-sm text-slate-500">{holding.subtitle}</div>
                            </div>
                          </div>

                          <div className="grid gap-3 text-sm text-slate-600 md:grid-cols-3 md:items-center md:text-right">
                            <div>
                              <div className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400">Sleeve weight</div>
                              <div className="text-base font-semibold text-slate-900">{holding.weight.toFixed(2)}%</div>
                            </div>
                            <div>
                              <div className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400">Market value</div>
                              <div className="text-base font-semibold text-slate-900">{formatCurrency(holding.value)}</div>
                            </div>
                            <div>
                              <div className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400">Context</div>
                              <div className="text-sm font-medium text-slate-700">{holding.primaryMeta}</div>
                              {holding.secondaryMeta && (
                                <div className="text-xs text-slate-500">{holding.secondaryMeta}</div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-[22px] border border-dashed border-slate-300 bg-slate-50/80 px-5 py-10 text-center text-sm text-slate-500">
                    No positions are currently grouped into {activeAllocationClassDetail.label}.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default NetWorthAllocationPanel;