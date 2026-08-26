import React from 'react';

const formatCurrency = (value: number): string => {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(2)}MM`;
  } else if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(2)}k`;
  } else {
    return `${sign}$${absValue.toFixed(2)}`;
  }
};

const formatPercentage = (value: number): string => {
  return `${value.toFixed(1)}%`;
};

const generateYearLabels = (count: number, isQuarterly: boolean = false, startYear?: number): string[] => {
  const baseYear = startYear ?? new Date().getFullYear();
  const labels: string[] = [];
  if (isQuarterly) {
    for (let index = 0; index < count; index += 1) {
      const quarter = (index % 4) + 1;
      const year = baseYear + Math.floor(index / 4);
      labels.push(`${quarter}Q${year}`);
    }
  } else {
    for (let index = 0; index < count; index += 1) {
      labels.push(`${baseYear + index}`);
    }
  }
  return labels;
};

export interface AdditionalAnalyticsBarChartProps {
  data: number[];
  xLabels?: string[];
  color?: string;
  secondaryData?: number[];
  secondaryColor?: string;
  secondaryLabel?: string;
  tertiaryData?: number[];
  tertiaryColor?: string;
  tertiaryLabel?: string;
  allowNegative?: boolean;
  isPercentage?: boolean;
  isCurrency?: boolean;
  dataLabel?: string;
  dataInThousands?: boolean;
  formatValue?: (value: number) => string;
  formatAxisValue?: (value: number) => string;
  /** Multiplier for axis label font sizes (e.g. 1.25 in expanded views). */
  fontScale?: number;
}

export const AdditionalAnalyticsBarChart: React.FC<AdditionalAnalyticsBarChartProps> = ({
  data,
  xLabels,
  color = '#3b82f6',
  secondaryData,
  secondaryColor = '#10b981',
  secondaryLabel = 'Secondary',
  tertiaryData,
  tertiaryColor = '#f59e0b',
  tertiaryLabel = 'Tertiary',
  allowNegative = false,
  isPercentage = false,
  isCurrency = true,
  dataLabel = 'Value',
  dataInThousands = false,
  formatValue,
  formatAxisValue,
  fontScale = 1,
}) => {
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const chartId = React.useId().replace(/:/g, '');
  const sanitizeColor = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '');
  const primaryGradientId = `${chartId}-primary-${sanitizeColor(color)}`;
  const secondaryGradientId = `${chartId}-secondary-${sanitizeColor(secondaryColor)}`;
  const tertiaryGradientId = `${chartId}-tertiary-${sanitizeColor(tertiaryColor)}`;
  const shadowId = `${chartId}-shadow`;

  const allData = [...data, ...(secondaryData || []), ...(tertiaryData || [])];
  const max = Math.max(...allData, 0);
  const min = allowNegative ? Math.min(...allData, 0) : 0;

  const niceStep = (target: number) => {
    if (target <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    const steps = [1, 2, 2.5, 5, 7.5, 10];
    for (const step of steps) {
      const next = step * magnitude;
      if (next >= target) return next;
    }
    return target;
  };

  const positiveExtent = Math.max(0, max);
  const negativeExtent = allowNegative ? Math.max(0, -min) : 0;
  let stepGuess = niceStep(Math.max((positiveExtent + negativeExtent) / 5, 1e-6));
  let negativeSteps = 0;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    negativeSteps = Math.min(5, Math.ceil(negativeExtent / stepGuess));
    const positiveSteps = Math.ceil(positiveExtent / stepGuess);
    if ((5 - negativeSteps) < positiveSteps) {
      stepGuess = niceStep(stepGuess * 1.1);
      continue;
    }
    break;
  }

  const niceMin = -negativeSteps * stepGuess;
  const niceMax = (5 - negativeSteps) * stepGuess;

  const renderValue = formatValue ?? ((value: number) => {
    if (isPercentage) return formatPercentage(value);
    if (isCurrency) {
      const actualValue = dataInThousands ? value * 1000 : value;
      return formatCurrency(actualValue);
    }
    return value.toFixed(2);
  });

  const renderAxisValue = formatAxisValue ?? ((value: number) => {
    if (isPercentage) return `${value.toFixed(0)}%`;
    if (isCurrency) {
      const actualValue = dataInThousands ? value * 1000 : value;
      const absValue = Math.abs(actualValue);
      const sign = actualValue < 0 ? '-' : '';
      if (absValue >= 1_000_000) return `${sign}$${(absValue / 1_000_000).toFixed(0)}MM`;
      if (absValue >= 1_000) return `${sign}$${(absValue / 1_000).toFixed(0)}k`;
      return `${sign}$${absValue.toFixed(0)}`;
    }
    return value.toFixed(0);
  });

  const yFontSize = 10 * fontScale;
  const xFontSize = 10 * fontScale;

  const ticks = 6;
  const yTicks: number[] = [];
  for (let index = 0; index < ticks; index += 1) {
    yTicks.push(niceMin + (niceMax - niceMin) * (index / (ticks - 1)));
  }

  const labels = xLabels || generateYearLabels(data.length);

  // Size the gutters to the actual labels so nothing gets clipped
  const maxAxisLabelChars = yTicks.reduce((longest, tick) => Math.max(longest, renderAxisValue(tick).length), 0);
  const maxXLabelChars = labels.reduce((longest, label) => Math.max(longest, (label || '').length), 0);
  const W = 400;
  const H = 200;
  const LP = Math.min(120, Math.max(42, 12 + maxAxisLabelChars * yFontSize * 0.62));
  const RP = 10;
  const TP = 10;
  // Rotated -45° labels drop below their anchor by ~0.707x their rendered length
  const BP = Math.min(72, Math.max(32, 14 + maxXLabelChars * xFontSize * 0.62 * 0.707));
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;

  const zeroY = niceMin === 0 ? TP + innerH : TP + innerH - ((-niceMin) / (niceMax - niceMin)) * innerH;
  const safeLength = Math.max(data.length, 1);
  const gap = 6;
  // Slots always span the full plot width so bars stay evenly spaced edge to
  // edge, but each bar's width is capped at dense-chart proportions so sparse
  // series (e.g. 5 annual bars) don't become wide and stumpy
  const slotWidth = innerW / safeLength;
  const barCount = 1 + (secondaryData ? 1 : 0) + (tertiaryData ? 1 : 0);
  const barGap = 2;
  const maxGroupWidth = barCount * (innerW / 12);
  const groupWidth = Math.max(Math.min(slotWidth - gap, maxGroupWidth), 4);
  const barWidth = (groupWidth - barGap * (barCount - 1)) / barCount;
  const barRadius = Math.min(4, barWidth * 0.22);

  return (
    <div className="relative h-full w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
        <defs>
          <linearGradient id={primaryGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id={secondaryGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={secondaryColor} stopOpacity="1" />
            <stop offset="100%" stopColor={secondaryColor} stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id={tertiaryGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={tertiaryColor} stopOpacity="1" />
            <stop offset="100%" stopColor={tertiaryColor} stopOpacity="0.7" />
          </linearGradient>
          <filter id={shadowId} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.1" />
          </filter>
        </defs>

        {yTicks.map((tick) => {
          const y = TP + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <line key={tick} x1={LP} x2={LP + innerW} y1={y} y2={y} stroke="#f0f0f0" strokeWidth={1} strokeDasharray="4 4" />
          );
        })}

        {allowNegative && niceMin < 0 && niceMax > 0 && (
          <line x1={LP} x2={LP + innerW} y1={zeroY} y2={zeroY} stroke="#cbd5e1" strokeWidth={1.5} />
        )}

        {data.map((value, index) => {
          const xGroup = LP + index * slotWidth + (slotWidth - groupWidth) / 2;
          const toY = (nextValue: number) => TP + innerH - ((nextValue - niceMin) / (niceMax - niceMin)) * innerH;
          const yZero = toY(0);
          const isHovered = hoveredIndex === index;

          const renderBar = (barValue: number, x: number, fill: string) => {
            const yValue = toY(barValue);
            const barHeight = Math.abs(yValue - yZero);
            const y = Math.min(yZero, yValue);
            return (
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={barRadius}
                ry={barRadius}
                fill={fill}
                opacity={isHovered ? 1 : 0.85}
                filter={isHovered ? `url(#${shadowId})` : undefined}
                style={{
                  cursor: 'pointer',
                  transition: 'all 0.15s ease-out',
                  transform: isHovered ? 'translateY(-1px)' : 'translateY(0)',
                }}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            );
          };

          return (
            <g key={`${labels[index] || 'bar'}-${index}`} style={{ transition: 'all 0.2s ease-out' }}>
              {renderBar(value, xGroup, `url(#${primaryGradientId})`)}
              {secondaryData ? renderBar(secondaryData[index] || 0, xGroup + barWidth + barGap, `url(#${secondaryGradientId})`) : null}
              {tertiaryData ? renderBar(tertiaryData[index] || 0, xGroup + (barWidth + barGap) * 2, `url(#${tertiaryGradientId})`) : null}
            </g>
          );
        })}

        {yTicks.map((tick) => {
          const y = TP + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <text key={`y-${tick}`} x={LP - 8} y={y + yFontSize * 0.36} textAnchor="end" fontSize={yFontSize} fill="#475569" fontWeight="600" fontFamily="Inter, system-ui, sans-serif">
              {renderAxisValue(tick)}
            </text>
          );
        })}

        {data.map((_, index) => {
          const xCenter = LP + index * slotWidth + slotWidth / 2;
          const labelY = TP + innerH + 14;
          return (
            <text
              key={`x-${index}`}
              x={xCenter}
              y={labelY}
              textAnchor="end"
              fontSize={xFontSize}
              fill="#475569"
              fontWeight="600"
              fontFamily="Inter, system-ui, sans-serif"
              transform={`rotate(-45 ${xCenter} ${labelY})`}
            >
              {labels[index]}
            </text>
          );
        })}
      </svg>

      {hoveredIndex !== null && (
        <div
          className="pointer-events-none absolute z-50 rounded-xl border border-gray-700/50 bg-gray-900/95 px-4 py-3 text-sm text-white shadow-xl backdrop-blur-sm"
          style={{ left: '50%', top: '8px', transform: 'translateX(-50%)' }}
        >
          <div className="mb-1.5 font-semibold text-gray-100">{labels[hoveredIndex]}</div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded" style={{ backgroundColor: color }}></div>
            <span className="text-gray-300">{dataLabel}:</span>
            <span className="font-medium">{renderValue(data[hoveredIndex])}</span>
          </div>
          {secondaryData && (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-3 w-3 rounded" style={{ backgroundColor: secondaryColor }}></div>
              <span className="text-gray-300">{secondaryLabel}:</span>
              <span className="font-medium">{renderValue(secondaryData[hoveredIndex])}</span>
            </div>
          )}
          {tertiaryData && (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-3 w-3 rounded" style={{ backgroundColor: tertiaryColor }}></div>
              <span className="text-gray-300">{tertiaryLabel}:</span>
              <span className="font-medium">{renderValue(tertiaryData[hoveredIndex])}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};