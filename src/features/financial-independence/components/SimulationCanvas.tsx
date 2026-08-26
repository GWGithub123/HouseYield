import { useMemo, useState } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
  ResponsiveContainer,
} from 'recharts';
import { Flag, TrendingUp, Wallet } from 'lucide-react';
import type { MonteCarloBandPoint, FISpectrumThreshold, FIMilestone } from '../types';
import type { FinancialPlannerProjectionPoint } from '../../../services/aiFinancialPlannerService';

interface SimulationCanvasProps {
  bands: MonteCarloBandPoint[];
  points: FinancialPlannerProjectionPoint[];
  spectrum: FISpectrumThreshold[];
  milestones: FIMilestone[];
  fiYear: number | null;
  view: 'income' | 'account';
  onViewChange: (view: 'income' | 'account') => void;
}

interface ChartRow {
  year: number;
  yearsFromNow: number;
  costOfLiving: number;
  incomeP50: number;
  incomeBand: [number, number];
  accountP50: number;
  accountBand: [number, number];
  surplus: number;
}

function compactCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function fullCurrency(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

const MILESTONE_COLOR: Record<FIMilestone['kind'], string> = {
  fi: '#0ea5e9',
  retirement: '#8b5cf6',
  propertyPurchase: '#059669',
  propertySale: '#f59e0b',
  bigPurchase: '#ec4899',
  scenario: '#64748b',
};

export default function SimulationCanvas({
  bands,
  points,
  spectrum,
  milestones,
  fiYear,
  view,
  onViewChange,
}: SimulationCanvasProps) {
  const [hoverYear, setHoverYear] = useState<number | null>(null);

  const rows = useMemo<ChartRow[]>(() => {
    const pointByYear = new Map(points.map((p) => [p.year, p]));
    return bands.map((band) => {
      const point = pointByYear.get(band.year);
      return {
        year: band.year,
        yearsFromNow: band.yearsFromNow,
        costOfLiving: band.costOfLiving,
        incomeP50: band.incomeP50,
        incomeBand: [band.incomeP10, band.incomeP90],
        accountP50: band.accountP50,
        accountBand: [band.accountP10, band.accountP90],
        surplus: point?.surplus ?? band.incomeP50 - band.costOfLiving,
      };
    });
  }, [bands, points]);

  const isIncome = view === 'income';
  const bandKey = isIncome ? 'incomeBand' : 'accountBand';
  const medianKey = isIncome ? 'incomeP50' : 'accountP50';
  const accentColor = isIncome ? '#10b981' : '#0ea5e9';
  const milestoneLines = useMemo(() => {
    const seen = new Set<string>();
    return milestones.filter((milestone) => {
      const key = `${milestone.kind}-${milestone.year}-${milestone.label}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [milestones]);
  const milestonesByYear = useMemo(() => {
    return milestoneLines.reduce<Record<number, FIMilestone[]>>((acc, milestone) => {
      if (!acc[milestone.year]) {
        acc[milestone.year] = [];
      }
      acc[milestone.year].push(milestone);
      return acc;
    }, {});
  }, [milestoneLines]);

  const activeRow = hoverYear !== null ? rows.find((r) => r.year === hoverYear) : null;
  const readoutRow = activeRow ?? rows[rows.length - 1] ?? null;
  const readoutMilestones = readoutRow ? milestonesByYear[readoutRow.year] || [] : [];

  // Spectrum threshold lines only make sense against portfolio value.
  const spectrumLines = !isIncome
    ? spectrum.filter((s) => s.targetPortfolio > 0)
    : [];

  return (
    <div className="hy-glass-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
              <TrendingUp size={18} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">Living Simulation</h3>
              <p className="text-xs text-slate-500">
                Median path with 80% confidence band ({isIncome ? 'income vs expenses' : 'portfolio value'})
              </p>
            </div>
          </div>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm">
          <button
            type="button"
            onClick={() => onViewChange('income')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
              isIncome ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <TrendingUp size={14} /> Income
          </button>
          <button
            type="button"
            onClick={() => onViewChange('account')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
              !isIncome ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Wallet size={14} /> Portfolio
          </button>
        </div>
      </div>

      {/* Scrubber readout */}
      {readoutRow ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl bg-slate-50 px-4 py-2.5 text-sm">
          <span className="font-semibold text-slate-900">
            {readoutRow.year}
            <span className="ml-1 text-xs font-normal text-slate-400">
              (+{readoutRow.yearsFromNow}y)
            </span>
          </span>
          {isIncome ? (
            <>
              <span className="text-emerald-600">
                Income <strong>{compactCurrency(readoutRow.incomeP50)}</strong>
                <span className="text-slate-400"> ({compactCurrency(readoutRow.incomeBand[0])}–{compactCurrency(readoutRow.incomeBand[1])})</span>
              </span>
              <span className="text-rose-500">Expenses <strong>{compactCurrency(readoutRow.costOfLiving)}</strong></span>
              <span className={readoutRow.surplus >= 0 ? 'text-emerald-600' : 'text-rose-500'}>
                Surplus <strong>{compactCurrency(readoutRow.surplus)}</strong>
              </span>
            </>
          ) : (
            <span className="text-sky-600">
              Portfolio <strong>{compactCurrency(readoutRow.accountP50)}</strong>
              <span className="text-slate-400"> ({compactCurrency(readoutRow.accountBand[0])}–{compactCurrency(readoutRow.accountBand[1])})</span>
            </span>
          )}
          {readoutMilestones.map((milestone, index) => (
            <span
              key={`${milestone.kind}-${milestone.year}-readout-${index}`}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
              style={{
                background: `${MILESTONE_COLOR[milestone.kind]}14`,
                color: MILESTONE_COLOR[milestone.kind],
              }}
            >
              <Flag size={11} /> {milestone.label}
            </span>
          ))}
        </div>
      ) : null}

      <div style={{ width: '100%', height: 360 }}>
        <ResponsiveContainer>
          <ComposedChart
            data={rows}
            margin={{ top: 12, right: 16, bottom: 8, left: 8 }}
            onMouseMove={(state: any) => {
              const label = state?.activeLabel;
              setHoverYear(typeof label === 'number' ? label : label ? Number(label) : null);
            }}
            onMouseLeave={() => setHoverYear(null)}
          >
            <defs>
              <linearGradient id="fiBandGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accentColor} stopOpacity={0.20} />
                <stop offset="60%" stopColor={accentColor} stopOpacity={0.07} />
                <stop offset="100%" stopColor={accentColor} stopOpacity={0} />
              </linearGradient>
              <filter id="fiMedianGlow" x="-20%" y="-60%" width="140%" height="260%">
                <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor={accentColor} floodOpacity="0.28" />
              </filter>
            </defs>
            <CartesianGrid stroke="#eef2f7" strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="year"
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 10.5, fill: '#94a3b8', fontWeight: 500 }}
              tickLine={false}
              axisLine={{ stroke: '#e2e8f0' }}
              allowDecimals={false}
            />
            <YAxis
              tickFormatter={compactCurrency}
              tick={{ fontSize: 10.5, fill: '#94a3b8', fontWeight: 500 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <Tooltip
              cursor={{ stroke: accentColor, strokeOpacity: 0.45, strokeWidth: 1.25 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as ChartRow | undefined;
                if (!row) return null;
                return (
                  <div className="rounded-xl border border-slate-800/80 bg-slate-900/95 px-3 py-2.5 text-xs text-white shadow-[0_16px_36px_rgba(15,23,42,0.25)]">
                    <div className="mb-1 text-[11px] font-medium text-slate-300">{label}</div>
                    {isIncome ? (
                      <>
                        <div className="text-[13px] font-semibold text-emerald-300">Income {fullCurrency(row.incomeP50)}</div>
                        <div className="text-slate-400">Range {fullCurrency(row.incomeBand[0])} – {fullCurrency(row.incomeBand[1])}</div>
                        <div className="mt-0.5 text-rose-300">Expenses {fullCurrency(row.costOfLiving)}</div>
                      </>
                    ) : (
                      <>
                        <div className="text-[13px] font-semibold text-sky-300">Portfolio {fullCurrency(row.accountP50)}</div>
                        <div className="text-slate-400">Range {fullCurrency(row.accountBand[0])} – {fullCurrency(row.accountBand[1])}</div>
                      </>
                    )}
                  </div>
                );
              }}
            />

            {/* Confidence band */}
            <Area
              type="monotone"
              dataKey={bandKey}
              stroke="none"
              fill="url(#fiBandGradient)"
              isAnimationActive={false}
              activeDot={false}
              legendType="none"
            />

            {/* Median line */}
            <Line
              type="monotone"
              dataKey={medianKey}
              stroke={accentColor}
              strokeWidth={2.5}
              strokeLinecap="round"
              dot={false}
              isAnimationActive={false}
              filter="url(#fiMedianGlow)"
            />

            {/* Expenses line (income view only) */}
            {isIncome ? (
              <Line
                type="monotone"
                dataKey="costOfLiving"
                stroke="#f43f5e"
                strokeWidth={1.75}
                strokeDasharray="5 4"
                strokeOpacity={0.85}
                dot={false}
                isAnimationActive={false}
              />
            ) : null}

            {/* FI spectrum thresholds (portfolio view) */}
            {spectrumLines.map((s) => (
              <ReferenceLine
                key={s.id}
                y={s.targetPortfolio}
                stroke="#cbd5e1"
                strokeDasharray="2 4"
                label={{ value: s.label, position: 'right', fontSize: 10, fill: '#94a3b8' }}
              />
            ))}

            {milestoneLines
              .filter((milestone) => milestone.kind !== 'fi')
              .map((milestone, index) => (
                <ReferenceLine
                  key={`${milestone.kind}-${milestone.year}-${index}-line`}
                  x={milestone.year}
                  stroke={MILESTONE_COLOR[milestone.kind]}
                  strokeOpacity={0.45}
                  strokeWidth={1.2}
                  strokeDasharray={milestone.kind === 'scenario' ? '2 5' : '3 4'}
                  label={{
                    value: `${milestone.label} ${milestone.year}`,
                    position: 'top',
                    fontSize: 10,
                    fill: MILESTONE_COLOR[milestone.kind],
                    fontWeight: 600,
                  }}
                />
              ))}

            {/* FI crossover marker */}
            {fiYear !== null ? (
              <ReferenceLine
                x={fiYear}
                stroke="#0ea5e9"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                label={{ value: `FI ${fiYear}`, position: 'top', fontSize: 11, fill: '#0284c7', fontWeight: 600 }}
              />
            ) : null}

            {/* Milestone pins */}
            {milestoneLines.map((m, i) => {
              const row = rows.find((r) => r.year === m.year);
              if (!row) return null;
              const yValue = isIncome ? row.incomeP50 : row.accountP50;
              return (
                <ReferenceDot
                  key={`${m.kind}-${m.year}-${i}`}
                  x={m.year}
                  y={yValue}
                  r={5}
                  fill={MILESTONE_COLOR[m.kind]}
                  stroke="#fff"
                  strokeWidth={2}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Milestone legend */}
      {milestones.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500">
          {milestones.map((m, i) => (
            <span key={`${m.kind}-${m.year}-legend-${i}`} className="inline-flex items-center gap-1.5">
              <Flag size={12} style={{ color: MILESTONE_COLOR[m.kind] }} />
              {m.label} <span className="text-slate-400">{m.year}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
