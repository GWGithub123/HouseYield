/**
 * RiskFluctuationGraph - SVG line chart showing monthly environmental risk levels
 * Displays risk fluctuation across 12 months with color-coded zones
 */
import React, { useMemo, useEffect, useRef } from 'react';

type RiskType = 'airQuality' | 'flood' | 'wildfire';

interface RiskFluctuationGraphProps {
  riskType: RiskType;
  latitude: number;
  longitude: number;
  /** Current raw value from the heat map (AQI, flood risk 0-10, wildfire score 0-10) */
  currentValue?: number;
  /** Called once with the computed monthly data so parent can pass it to the mitigation panel */
  onDataReady?: (data: { monthly: number[]; peakMonth: number; peakValue: number; currentMonth: number; currentValue: number }) => void;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const RISK_CONFIG: Record<RiskType, {
  label: string;
  unit: string;
  zones: { label: string; min: number; max: number; color: string; bgColor: string }[];
  maxValue: number;
}> = {
  airQuality: {
    label: 'Air Quality Index (AQI)',
    unit: 'AQI',
    zones: [
      { label: 'Good', min: 0, max: 50, color: '#16a34a', bgColor: 'rgba(22,163,74,0.08)' },
      { label: 'Moderate', min: 50, max: 100, color: '#ca8a04', bgColor: 'rgba(202,138,4,0.08)' },
      { label: 'Unhealthy (SG)', min: 100, max: 150, color: '#ea580c', bgColor: 'rgba(234,88,12,0.08)' },
      { label: 'Unhealthy', min: 150, max: 200, color: '#dc2626', bgColor: 'rgba(220,38,38,0.08)' },
    ],
    maxValue: 200,
  },
  flood: {
    label: 'Flood Risk Level',
    unit: 'Risk',
    zones: [
      { label: 'Minimal', min: 0, max: 2.5, color: '#16a34a', bgColor: 'rgba(22,163,74,0.08)' },
      { label: 'Moderate', min: 2.5, max: 5, color: '#ca8a04', bgColor: 'rgba(202,138,4,0.08)' },
      { label: 'High', min: 5, max: 7.5, color: '#ea580c', bgColor: 'rgba(234,88,12,0.08)' },
      { label: 'Severe', min: 7.5, max: 10, color: '#dc2626', bgColor: 'rgba(220,38,38,0.08)' },
    ],
    maxValue: 10,
  },
  wildfire: {
    label: 'Wildfire Risk Score',
    unit: 'Risk',
    zones: [
      { label: 'Low', min: 0, max: 2.5, color: '#16a34a', bgColor: 'rgba(22,163,74,0.08)' },
      { label: 'Moderate', min: 2.5, max: 5, color: '#ca8a04', bgColor: 'rgba(202,138,4,0.08)' },
      { label: 'High', min: 5, max: 7.5, color: '#ea580c', bgColor: 'rgba(234,88,12,0.08)' },
      { label: 'Extreme', min: 7.5, max: 10, color: '#dc2626', bgColor: 'rgba(220,38,38,0.08)' },
    ],
    maxValue: 10,
  },
};

/** Season-to-monthly multiplier interpolation: maps 4 seasonal values to 12 months */
function interpolateSeasonalToMonthly(seasonMultipliers: { spring: number; summer: number; fall: number; winter: number }): number[] {
  // Season midpoints: spring=Mar(2), summer=Jun(5), fall=Sep(8), winter=Dec(11)
  const anchors = [
    { month: 1, value: (seasonMultipliers.winter + seasonMultipliers.spring) / 2 },  // Feb
    { month: 2, value: seasonMultipliers.spring },  // Mar
    { month: 3, value: (seasonMultipliers.spring * 2 + seasonMultipliers.summer) / 3 }, // Apr
    { month: 4, value: (seasonMultipliers.spring + seasonMultipliers.summer) / 2 }, // May
    { month: 5, value: seasonMultipliers.summer }, // Jun
    { month: 6, value: (seasonMultipliers.summer * 2 + seasonMultipliers.fall) / 3 }, // Jul
    { month: 7, value: (seasonMultipliers.summer + seasonMultipliers.fall) / 2 }, // Aug
    { month: 8, value: seasonMultipliers.fall }, // Sep
    { month: 9, value: (seasonMultipliers.fall * 2 + seasonMultipliers.winter) / 3 }, // Oct
    { month: 10, value: (seasonMultipliers.fall + seasonMultipliers.winter) / 2 }, // Nov
    { month: 11, value: seasonMultipliers.winter }, // Dec
    { month: 0, value: (seasonMultipliers.winter * 2 + seasonMultipliers.spring) / 3 }, // Jan
  ];

  const monthly: number[] = [];
  for (let i = 0; i < 12; i++) {
    const anchor = anchors.find(a => a.month === i);
    monthly.push(anchor?.value ?? 1.0);
  }
  return monthly;
}

/** Region detection (mirrors PortfolioPage patterns) */
function getRegionCode(lat: number, lng: number): string {
  if (lng < -115 && lat > 32 && lat < 42) return 'westCoast';
  if (lng < -120 && lat > 42) return 'pacificNW';
  if (lng < -104 && lat < 37 && lat > 25) return 'southwest';
  if (lat < 31 && lng > -88 && lng < -80) return 'florida';
  if (lat < 37 && lng > -94 && lng < -75) return 'southeast';
  if (lat > 37 && lng > -94 && lng < -87) return 'midwest';
  return 'northeast';
}

function getAirQualitySeasonalMultipliers(region: string): { spring: number; summer: number; fall: number; winter: number } {
  const data: Record<string, { spring: number; summer: number; fall: number; winter: number }> = {
    westCoast: { spring: 0.9, summer: 1.3, fall: 1.8, winter: 0.7 },
    southeast: { spring: 1.1, summer: 1.3, fall: 0.9, winter: 0.8 },
    southwest: { spring: 1.1, summer: 1.4, fall: 1.0, winter: 0.8 },
    midwest: { spring: 1.0, summer: 1.2, fall: 1.0, winter: 0.9 },
    northeast: { spring: 1.0, summer: 1.3, fall: 0.9, winter: 0.9 },
    pacificNW: { spring: 0.8, summer: 1.4, fall: 1.5, winter: 0.6 },
    florida: { spring: 1.0, summer: 0.9, fall: 0.8, winter: 1.0 },
  };
  return data[region] || data.northeast;
}

function getFloodSeasonalMultipliers(region: string): { spring: number; summer: number; fall: number; winter: number } {
  const data: Record<string, { spring: number; summer: number; fall: number; winter: number }> = {
    westCoast: { spring: 1.3, summer: 0.3, fall: 0.5, winter: 1.5 },
    southeast: { spring: 1.0, summer: 1.4, fall: 1.5, winter: 0.7 },
    southwest: { spring: 0.5, summer: 1.6, fall: 1.0, winter: 0.5 },
    midwest: { spring: 1.6, summer: 1.0, fall: 0.6, winter: 0.8 },
    northeast: { spring: 1.4, summer: 1.0, fall: 1.2, winter: 0.7 },
    pacificNW: { spring: 1.2, summer: 0.3, fall: 1.0, winter: 1.6 },
    florida: { spring: 0.6, summer: 1.5, fall: 1.8, winter: 0.4 },
  };
  return data[region] || data.northeast;
}

function getWildfireSeasonalMultipliers(region: string): { spring: number; summer: number; fall: number; winter: number } {
  const data: Record<string, { spring: number; summer: number; fall: number; winter: number }> = {
    westCoast: { spring: 0.6, summer: 1.8, fall: 2.0, winter: 0.3 },
    pacificNW: { spring: 0.4, summer: 1.5, fall: 1.2, winter: 0.2 },
    southwest: { spring: 1.4, summer: 1.0, fall: 1.2, winter: 0.5 },
    florida: { spring: 1.4, summer: 0.5, fall: 0.7, winter: 1.2 },
    southeast: { spring: 1.1, summer: 0.7, fall: 1.0, winter: 0.8 },
    midwest: { spring: 0.8, summer: 0.6, fall: 1.0, winter: 0.2 },
    northeast: { spring: 0.8, summer: 0.6, fall: 1.0, winter: 0.2 },
  };
  return data[region] || data.northeast;
}

const RiskFluctuationGraph: React.FC<RiskFluctuationGraphProps> = ({
  riskType,
  latitude,
  longitude,
  currentValue,
  onDataReady,
}) => {
  const config = RISK_CONFIG[riskType];
  const currentMonth = new Date().getMonth();

  const monthlyData = useMemo(() => {
    const region = getRegionCode(latitude, longitude);
    let seasonalMultipliers: { spring: number; summer: number; fall: number; winter: number };

    if (riskType === 'airQuality') {
      seasonalMultipliers = getAirQualitySeasonalMultipliers(region);
    } else if (riskType === 'flood') {
      seasonalMultipliers = getFloodSeasonalMultipliers(region);
    } else {
      seasonalMultipliers = getWildfireSeasonalMultipliers(region);
    }

    const multipliers = interpolateSeasonalToMonthly(seasonalMultipliers);

    // Use currentValue as the baseline, apply multipliers
    let baseValue: number;
    if (currentValue && currentValue > 0) {
      // Normalize: currentValue is the value for the current month
      // baseValue = currentValue / currentMonthMultiplier
      const currentMultiplier = multipliers[currentMonth] || 1;
      baseValue = currentValue / currentMultiplier;
    } else {
      // Default baselines
      if (riskType === 'airQuality') baseValue = 55;
      else if (riskType === 'flood') baseValue = 3;
      else baseValue = 3;
    }

    return multipliers.map((m, i) => {
      const val = Math.max(0, Math.min(config.maxValue, baseValue * m));
      return { month: i, label: MONTH_LABELS[i], value: Math.round(val * 10) / 10 };
    });
  }, [riskType, latitude, longitude, currentValue, currentMonth, config.maxValue]);

  // Report monthly data to parent via stable ref
  const onDataReadyRef = useRef(onDataReady);
  onDataReadyRef.current = onDataReady;
  useEffect(() => {
    if (onDataReadyRef.current && monthlyData.length === 12) {
      const peak = monthlyData.reduce((max, d) => d.value > max.value ? d : max, monthlyData[0]);
      onDataReadyRef.current({
        monthly: monthlyData.map(d => d.value),
        peakMonth: peak.month,
        peakValue: peak.value,
        currentMonth,
        currentValue: monthlyData[currentMonth]?.value ?? 0,
      });
    }
  }, [monthlyData, currentMonth]);

  // SVG chart dimensions
  const width = 400;
  const height = 140;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const maxVal = config.maxValue;
  const xScale = (i: number) => padL + (i / 11) * innerW;
  const yScale = (v: number) => padT + innerH - (v / maxVal) * innerH;

  // Build line path
  const linePath = monthlyData
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(d.value).toFixed(1)}`)
    .join(' ');

  // Build area path
  const areaPath = linePath +
    ` L${xScale(11).toFixed(1)},${(padT + innerH).toFixed(1)}` +
    ` L${padL.toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  // Get color for value
  const getValueColor = (v: number) => {
    for (let i = config.zones.length - 1; i >= 0; i--) {
      if (v >= config.zones[i].min) return config.zones[i].color;
    }
    return config.zones[0].color;
  };

  // Current month value
  const currentMonthData = monthlyData[currentMonth];
  const peakMonth = monthlyData.reduce((max, d) => d.value > max.value ? d : max, monthlyData[0]);

  // Gradient stop colors based on values
  const gradientStops = monthlyData.map((d, i) => ({
    offset: `${(i / 11) * 100}%`,
    color: getValueColor(d.value),
  }));

  return (
    <div className="mt-2 rounded-2xl border border-slate-200/70 bg-white p-3 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h6 className="text-xs font-semibold tracking-tight text-slate-700">{config.label} — Monthly Trend</h6>
        <div className="flex flex-wrap items-center gap-1.5">
          {config.zones.map((zone, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500 shadow-sm">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: zone.color }} />
              {zone.label}
            </span>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: 140 }}>
        <defs>
          <linearGradient id={`risk-grad-${riskType}`} x1="0" x2="1" y1="0" y2="0">
            {gradientStops.map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={0.15} />
            ))}
          </linearGradient>
          <linearGradient id={`risk-line-${riskType}`} x1="0" x2="1" y1="0" y2="0">
            {gradientStops.map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>

        {/* Zone backgrounds */}
        {config.zones.map((zone, i) => {
          const y1 = yScale(zone.max);
          const y2 = yScale(zone.min);
          return (
            <rect
              key={i}
              x={padL}
              y={y1}
              width={innerW}
              height={Math.max(0, y2 - y1)}
              fill={zone.bgColor}
            />
          );
        })}

        {/* Grid lines */}
        {config.zones.map((zone, i) => (
          <React.Fragment key={i}>
            <line
              x1={padL}
              x2={padL + innerW}
              y1={yScale(zone.max)}
              y2={yScale(zone.max)}
              stroke="#e5e7eb"
              strokeWidth={0.5}
              strokeDasharray="3,3"
            />
            <text
              x={padL - 4}
              y={yScale(zone.max) + 3}
              textAnchor="end"
              className="text-[8px]"
              fill="#9ca3af"
            >
              {zone.max}
            </text>
          </React.Fragment>
        ))}
        <line x1={padL} x2={padL + innerW} y1={yScale(0)} y2={yScale(0)} stroke="#d1d5db" strokeWidth={1} />
        <line x1={padL} x2={padL} y1={padT} y2={padT + innerH} stroke="#d1d5db" strokeWidth={1} />

        {/* Area fill */}
        <path d={areaPath} fill={`url(#risk-grad-${riskType})`} />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke={`url(#risk-line-${riskType})`}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data points */}
        {monthlyData.map((d, i) => (
          <circle
            key={i}
            cx={xScale(i)}
            cy={yScale(d.value)}
            r={i === currentMonth ? 4 : 2}
            fill={i === currentMonth ? getValueColor(d.value) : 'white'}
            stroke={getValueColor(d.value)}
            strokeWidth={i === currentMonth ? 2 : 1.5}
          />
        ))}

        {/* Current month indicator */}
        <line
          x1={xScale(currentMonth)}
          x2={xScale(currentMonth)}
          y1={padT}
          y2={padT + innerH}
          stroke={getValueColor(currentMonthData.value)}
          strokeWidth={1}
          strokeDasharray="4,2"
          opacity={0.5}
        />

        {/* Current month value label */}
        <text
          x={xScale(currentMonth)}
          y={yScale(currentMonthData.value) - 8}
          textAnchor="middle"
          className="text-[9px] font-bold"
          fill={getValueColor(currentMonthData.value)}
        >
          {currentMonthData.value}
        </text>

        {/* Peak month annotation (if different from current) */}
        {peakMonth.month !== currentMonth && (
          <text
            x={xScale(peakMonth.month)}
            y={yScale(peakMonth.value) - 8}
            textAnchor="middle"
            className="text-[8px]"
            fill={getValueColor(peakMonth.value)}
          >
            Peak: {peakMonth.value}
          </text>
        )}

        {/* Month labels */}
        {monthlyData.map((d, i) => (
          <text
            key={i}
            x={xScale(i)}
            y={padT + innerH + 14}
            textAnchor="middle"
            className={`text-[8px] ${i === currentMonth ? 'font-bold' : ''}`}
            fill={i === currentMonth ? getValueColor(d.value) : '#9ca3af'}
          >
            {d.label}
          </text>
        ))}
      </svg>

      <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500">
        <span>
          Now: <span className="font-semibold" style={{ color: getValueColor(currentMonthData.value) }}>
            {currentMonthData.value} {config.unit}
          </span> ({MONTH_LABELS[currentMonth]})
        </span>
        <span>
          Peak: <span className="font-semibold" style={{ color: getValueColor(peakMonth.value) }}>
            {peakMonth.value} {config.unit}
          </span> ({peakMonth.label})
        </span>
      </div>
    </div>
  );
};

export default RiskFluctuationGraph;
