/**
 * DealReport — the single unified analysis report used by both the
 * individual analyzer and the regional screener underwrite.
 *
 * Every scenario & renovation choice answers the same three questions:
 * what it costs, what it changes (price + rent), what it returns.
 */

import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { StreetViewImage } from '../StreetViewImage';
import {
  AdditionalAnalyticsChartsGrid,
  type AvmGranularity,
  type MetricTimeframe,
  type ProjectionGranularity,
  type TaxHistoryRange,
} from '../property/PropertyAnalyticsGraphs';
import { dealEngine, type DealReportData, type DealScenario, type RenovationProject } from '../../services/dealEngineClient';

const RentalSankeyDiagramLazy = lazy(() =>
  import('../AdvancedPropertyAnalysisModal').then((m) => ({ default: m.RentalSankeyDiagram })),
);

interface DealReportProps {
  report: DealReportData;
  onClose: () => void;
  onSave?: (report: DealReportData) => void;
  isFlagged?: boolean;
  onToggleFlag?: (report: DealReportData, flagged: boolean) => void;
}

const SCENARIO_COLORS: Record<string, string> = {
  buyHold: '#2563eb',
  renovateHold: '#d97706',
  brrrr: '#7c3aed',
};

function fmtMoney(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'from-emerald-500 to-green-600';
    case 'B': return 'from-lime-500 to-emerald-600';
    case 'C': return 'from-amber-500 to-orange-500';
    case 'D': return 'from-orange-500 to-rose-500';
    default: return 'from-rose-500 to-red-600';
  }
}

function SectionCard({ title, subtitle, children, right }: { title: string; subtitle?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  prefix,
  step = 1,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (value: number) => void;
  suffix?: string;
  prefix?: string;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-1 flex items-center overflow-hidden rounded-lg border border-slate-200 bg-white">
        {prefix && <span className="border-r border-slate-200 px-2 text-xs text-slate-400">{prefix}</span>}
        <input
          type="number"
          step={step}
          value={Number.isFinite(Number(value)) ? Number(value) : 0}
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm font-semibold text-slate-800 outline-none"
        />
        {suffix && <span className="border-l border-slate-200 px-2 text-xs text-slate-400">{suffix}</span>}
      </div>
    </label>
  );
}

/** AVM history line chart in the "Market Comparison" style. */
function AvmHistoryChart({ avmHistory, fairValue, listPrice }: { avmHistory: any; fairValue: number | null; listPrice: number | null }) {
  const points = useMemo(() => {
    const items = (Array.isArray(avmHistory) ? avmHistory : [])
      .map((p: any) => ({ date: new Date(p.date), value: Number(p.value) }))
      .filter((p: any) => !Number.isNaN(p.date.getTime()) && Number.isFinite(p.value))
      .sort((a: any, b: any) => a.date.getTime() - b.date.getTime());
    return items;
  }, [avmHistory]);

  if (points.length < 2) {
    return (
      <div className="flex h-44 items-center justify-center rounded-xl bg-slate-50 text-xs text-slate-400">
        AVM history unavailable for this property
      </div>
    );
  }

  const width = 640;
  const height = 180;
  const pad = { l: 52, r: 12, t: 12, b: 22 };
  const values = points.map((p: any) => p.value);
  const allValues = [...values, fairValue, listPrice].filter((v): v is number => Number.isFinite(v as number));
  const minV = Math.min(...allValues) * 0.97;
  const maxV = Math.max(...allValues) * 1.03;
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - minV) / (maxV - minV)) * (height - pad.t - pad.b);
  const path = points.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const latest = points[points.length - 1];
  const first = points[0];
  const changePct = ((latest.value - first.value) / first.value) * 100;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={pad.l} x2={width - pad.r} y1={pad.t + t * (height - pad.t - pad.b)} y2={pad.t + t * (height - pad.t - pad.b)} stroke="#e2e8f0" strokeDasharray="3,3" />
        ))}
        {Number.isFinite(listPrice as number) && (
          <>
            <line x1={pad.l} x2={width - pad.r} y1={y(listPrice!)} y2={y(listPrice!)} stroke="#dc2626" strokeWidth={1.5} strokeDasharray="6,4" />
            <text x={width - pad.r - 4} y={y(listPrice!) - 4} textAnchor="end" fontSize={10} fill="#dc2626" fontWeight={700}>List {fmtMoney(listPrice)}</text>
          </>
        )}
        {Number.isFinite(fairValue as number) && (
          <>
            <line x1={pad.l} x2={width - pad.r} y1={y(fairValue!)} y2={y(fairValue!)} stroke="#059669" strokeWidth={1.5} strokeDasharray="6,4" />
            <text x={pad.l + 4} y={y(fairValue!) - 4} fontSize={10} fill="#059669" fontWeight={700}>Fair {fmtMoney(fairValue)}</text>
          </>
        )}
        {Number.isFinite(fairValue as number) && Number.isFinite(listPrice as number) && (
          <rect
            x={pad.l}
            width={width - pad.l - pad.r}
            y={Math.min(y(fairValue!), y(listPrice!))}
            height={Math.abs(y(fairValue!) - y(listPrice!))}
            fill={fairValue! > listPrice! ? '#05966914' : '#dc262614'}
          />
        )}
        <path d={path} fill="none" stroke="#2563eb" strokeWidth={2.5} />
        <circle cx={x(points.length - 1)} cy={y(latest.value)} r={4} fill="#2563eb" stroke="#fff" strokeWidth={2} />
        <text x={pad.l - 6} y={y(maxV * 0.99) + 8} textAnchor="end" fontSize={9} fill="#94a3b8">{fmtMoney(maxV)}</text>
        <text x={pad.l - 6} y={y(minV * 1.01)} textAnchor="end" fontSize={9} fill="#94a3b8">{fmtMoney(minV)}</text>
        <text x={pad.l} y={height - 6} fontSize={9} fill="#94a3b8">{first.date.getFullYear()}</text>
        <text x={width - pad.r} y={height - 6} textAnchor="end" fontSize={9} fill="#94a3b8">{latest.date.getFullYear()}</text>
      </svg>
      <div className="mt-1 flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-600" /> Subject AVM</span>
        <span className={`rounded-full px-2 py-0.5 font-semibold ${changePct >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
          {changePct >= 0 ? '+' : ''}{changePct.toFixed(1)}% over period
        </span>
      </div>
    </div>
  );
}

/** Multi-scenario overlay chart (one metric, all selected scenarios). */
function ScenarioOverlayChart({
  title,
  scenarios,
  selector,
  format,
  refiMarkers = true,
}: {
  title: string;
  scenarios: DealScenario[];
  selector: (s: DealScenario) => number[];
  format: (v: number) => string;
  refiMarkers?: boolean;
}) {
  const width = 420;
  const height = 170;
  const pad = { l: 48, r: 10, t: 14, b: 20 };
  const seriesList = scenarios.map((s) => ({ key: s.key, label: s.label, values: selector(s).slice(0, 30) }));
  const allValues = seriesList.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!allValues.length) return null;
  const minV = Math.min(...allValues, 0);
  const maxV = Math.max(...allValues);
  const range = maxV - minV || 1;
  const n = Math.max(...seriesList.map((s) => s.values.length));
  const x = (i: number) => pad.l + (i / Math.max(n - 1, 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - minV) / range) * (height - pad.t - pad.b);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3">
      <div className="mb-1 text-xs font-bold text-slate-700">{title}</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        {minV < 0 && <line x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} stroke="#94a3b8" strokeWidth={1} />}
        {[0.33, 0.66].map((t) => (
          <line key={t} x1={pad.l} x2={width - pad.r} y1={pad.t + t * (height - pad.t - pad.b)} y2={pad.t + t * (height - pad.t - pad.b)} stroke="#e2e8f0" strokeDasharray="2,3" />
        ))}
        {seriesList.map((s) => {
          const color = SCENARIO_COLORS[s.key] || '#64748b';
          const path = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
          return <path key={s.key} d={path} fill="none" stroke={color} strokeWidth={2} opacity={0.9} />;
        })}
        {refiMarkers && scenarios.map((s) => {
          if (!s.refiEvent) return null;
          const i = s.refiEvent.year;
          return (
            <g key={`refi-${s.key}`}>
              <line x1={x(i - 1)} x2={x(i - 1)} y1={pad.t} y2={height - pad.b} stroke={SCENARIO_COLORS[s.key]} strokeDasharray="4,3" opacity={0.5} />
              <text x={x(i - 1) + 3} y={pad.t + 9} fontSize={8.5} fill={SCENARIO_COLORS[s.key]} fontWeight={700}>refi</text>
            </g>
          );
        })}
        <text x={pad.l - 5} y={y(maxV) + 8} textAnchor="end" fontSize={8.5} fill="#94a3b8">{format(maxV)}</text>
        <text x={pad.l - 5} y={y(minV)} textAnchor="end" fontSize={8.5} fill="#94a3b8">{format(minV)}</text>
        <text x={pad.l} y={height - 5} fontSize={8.5} fill="#94a3b8">Yr 1</text>
        <text x={width - pad.r} y={height - 5} textAnchor="end" fontSize={8.5} fill="#94a3b8">Yr {n}</text>
      </svg>
    </div>
  );
}

export const DealReport: React.FC<DealReportProps> = ({ report, onClose, onSave, isFlagged = false, onToggleFlag }) => {
  // Scenario / renovation interaction state
  const [scenarios, setScenarios] = useState<DealScenario[]>(report.scenarios);
  const [stressTest, setStressTest] = useState<any>(report.stressTest);
  const [offerSolver, setOfferSolver] = useState<any>(report.offerSolver);
  const [refiGrid, setRefiGrid] = useState<any>(report.refiGrid);
  const [selectedScenario, setSelectedScenario] = useState<string>(report.scenarios[0]?.key ?? 'buyHold');
  const [compareMode, setCompareMode] = useState(report.scenarios.length > 1);
  const [enabledProjects, setEnabledProjects] = useState<Set<number>>(
    () => new Set((report.renovation?.projects ?? []).map((_, i) => i)),
  );
  const [assumptionDraft, setAssumptionDraft] = useState<any>(() => ({
    ...report.assumptions,
    refiAtYear: report.assumptions?.refiAtYear ?? 2,
    refiLtvPercent: report.assumptions?.refiLtvPercent ?? 75,
    refiRate: report.assumptions?.refiRate ?? ((report.assumptions?.interestRate ?? 7) + 0.25),
    refiLoanTermYears: report.assumptions?.refiLoanTermYears ?? 30,
    refiClosingCostPercent: report.assumptions?.refiClosingCostPercent ?? 1.5,
  }));
  const [rentOverride, setRentOverride] = useState<number | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [flagged, setFlagged] = useState(isFlagged);

  // Chart grid controls
  const [analyticsGranularity, setAnalyticsGranularity] = useState<ProjectionGranularity>('annual');
  const [avmGranularity, setAvmGranularity] = useState<AvmGranularity>('annual');
  const [avmRange, setAvmRange] = useState('all');
  const [taxHistoryRange, setTaxHistoryRange] = useState<TaxHistoryRange>('10Y');
  const [mortgageAmortRange, setMortgageAmortRange] = useState<MetricTimeframe>('10Y');

  const projects = report.renovation?.projects ?? [];

  // Selected-renovation totals
  const selectedTotals = useMemo(() => {
    return projects.reduce(
      (acc, p, i) => (enabledProjects.has(i)
        ? { cost: acc.cost + p.cost, valueUplift: acc.valueUplift + p.valueUplift, rentUpliftMonthly: acc.rentUpliftMonthly + p.rentUpliftMonthly }
        : acc),
      { cost: 0, valueUplift: 0, rentUpliftMonthly: 0 },
    );
  }, [projects, enabledProjects]);

  const baseRent = rentOverride ?? assumptionDraft?.monthlyRent ?? report.operating?.monthlyRent ?? report.assumptions?.monthlyRent;
  const fairValue = report.valuation?.fairValue ?? null;
  const setAssumption = (field: string, value: number) => {
    setAssumptionDraft((current: any) => ({ ...current, [field]: Number.isFinite(value) ? value : 0 }));
    if (field === 'monthlyRent') setRentOverride(value);
  };

  // Live recompute when renovation selection or rent changes
  const recomputeTimer = useRef<any>(null);
  const initialRender = useRef(true);
  useEffect(() => {
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    recomputeTimer.current = setTimeout(async () => {
      setRecomputing(true);
      try {
        const assumptions = { ...assumptionDraft, monthlyRent: baseRent };
        const renovation = selectedTotals.cost > 0 ? {
          repairCost: selectedTotals.cost,
          valueAfterRepairs: (fairValue ?? report.assumptions.purchasePrice) + selectedTotals.valueUplift,
          monthlyRentAfter: baseRent + selectedTotals.rentUpliftMonthly,
        } : null;
        const result = await dealEngine.recompute(assumptions, renovation, { minMonthlyCashFlow: 100, minCocPct: 6 });
        setScenarios(result.scenarios);
        setStressTest(result.stressTest);
        setOfferSolver(result.offerSolver ?? offerSolver);
        setRefiGrid(result.refiGrid);
        if (!result.scenarios.find((s) => s.key === selectedScenario)) {
          setSelectedScenario(result.scenarios[0]?.key ?? 'buyHold');
        }
      } catch (err) {
        console.error('[DealReport] Recompute failed:', err);
      } finally {
        setRecomputing(false);
      }
    }, 450);
    return () => clearTimeout(recomputeTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTotals.cost, selectedTotals.valueUplift, selectedTotals.rentUpliftMonthly, rentOverride, assumptionDraft]);

  const activeScenario = scenarios.find((s) => s.key === selectedScenario) ?? scenarios[0];
  const baselineScenario = scenarios.find((s) => s.key === 'buyHold') ?? scenarios[0];
  const activeRows = activeScenario?.holdingRows ?? [];
  const holdingLength = Math.max(1, Math.round(assumptionDraft?.holdingLengthYears ?? activeRows.length ?? 10));
  const holdingRows = activeRows.slice(0, Math.min(holdingLength, 20));
  const firstYearRow = activeRows[0] ?? null;
  const finalHoldRow = activeRows[Math.min(holdingLength, activeRows.length) - 1] ?? activeRows[activeRows.length - 1] ?? null;
  const operatingCashFlowFor = (row: any) => row?.operatingCashFlow ?? ((row?.cashFlow ?? 0) - (row?.refiCashOut ?? 0));
  const holdTotals = useMemo(() => {
    const rows = activeRows.slice(0, holdingLength);
    return rows.reduce((acc: any, row: any) => ({
      income: acc.income + (row.annualIncome ?? 0),
      mortgage: acc.mortgage + (row.mortgage ?? 0),
      expenses: acc.expenses + (row.operatingExpenses ?? 0),
      noi: acc.noi + (row.netOperatingIncome ?? 0),
      cashFlow: acc.cashFlow + operatingCashFlowFor(row),
    }), { income: 0, mortgage: 0, expenses: 0, noi: 0, cashFlow: 0 });
  }, [activeRows, holdingLength]);

  // Compare-mode overlays for the analytics grid
  const overlayA = compareMode ? scenarios.find((s) => s.key === 'renovateHold') : null;
  const overlayB = compareMode ? scenarios.find((s) => s.key === 'brrrr') : null;
  const gridChartData = compareMode ? baselineScenario?.chartData : activeScenario?.chartData;

  // As-is vs renovated strip numbers
  const asIsCf = baselineScenario?.summary?.monthlyCashFlowYear1;
  const renoScenario = scenarios.find((s) => s.key === 'renovateHold') ?? scenarios.find((s) => s.key === 'brrrr');
  const renoCf = renoScenario?.summary?.monthlyCashFlowYear1;

  // AVM points for the grid's price-history chart
  const avmPoints = useMemo(() => {
    const rows = activeScenario?.chartData?.propertyAppreciation?.value ?? [];
    return rows.map((v: number, i: number) => ({ x: i, y: v * 1000 }));
  }, [activeScenario]);
  const avmLabels = activeScenario?.chartData?.projectionLabels ?? [];

  // Sankey inputs mapped from assumptions
  const sankeyInputs = useMemo(() => {
    const a = assumptionDraft;
    if (!a) return null;
    const loanAmount = a.purchasePrice * (1 - (a.downPaymentPercent ?? 20) / 100);
    return {
      avm: fairValue ?? a.purchasePrice,
      taxAmount: a.propertyTax ?? 0,
      monthlyRent: (activeScenario?.key !== 'buyHold' && selectedTotals.rentUpliftMonthly > 0) ? baseRent + selectedTotals.rentUpliftMonthly : baseRent,
      otherIncome: a.otherMonthlyIncome ?? 0,
      vacancyRate: a.vacancyRate ?? 7,
      rentGrowth: a.monthlyRentIncrease ?? 3,
      insurance: a.insurance ?? 0,
      utilities: 0,
      hoa: a.hoaFee ?? 0,
      repairsCapEx: (a.maintenance ?? 0) + (a.otherCosts ?? 0),
      managementPct: a.managementFee ?? 8,
      expenseInflation: 3,
      taxGrowth: a.propertyTaxIncrease ?? 3,
      interestRate: a.interestRate ?? 7,
      loanTerm: a.loanTermYears ?? 30,
      isInterestOnly: false,
      extraPrincipal: 0,
      downPayment: a.purchasePrice * ((a.downPaymentPercent ?? 20) / 100),
      closingCosts: a.closingCost ?? 0,
      initialRehab: selectedTotals.cost,
      appreciationRate: a.valueAppreciation ?? 3,
      originalLoanAmount: loanAmount,
    } as any;
  }, [assumptionDraft, fairValue, baseRent, selectedTotals, activeScenario]);

  const v = report.valuation;
  const score = report.dealScore;

  const handleFlag = () => {
    const next = !flagged;
    setFlagged(next);
    onToggleFlag?.(report, next);
  };

  return (
    <div className="flex h-full flex-col bg-slate-50">
      {/* ============ Verdict header ============ */}
      <div className="border-b bg-white">
        <div className="flex items-start gap-4 p-4">
          <div className="h-24 w-36 shrink-0 overflow-hidden rounded-xl">
            <StreetViewImage address={report.address} width={288} height={192} className="h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="truncate text-lg font-bold text-slate-900">{report.address}</h2>
                <div className="text-xs text-slate-500">
                  {report.subject?.beds ?? '?'}bd · {report.subject?.baths ?? '?'}ba · {report.subject?.sqft ? `${Number(report.subject.sqft).toLocaleString()}sf` : '?sf'} · built {report.subject?.yearBuilt ?? '?'} · {report.subject?.propertyType ?? ''}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {score.signals.map((sig) => (
                    <span key={sig} className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${sig.includes('Undervalued') || sig.includes('positive') || sig.includes('BRRRR') ? 'bg-emerald-100 text-emerald-700' : sig.includes('Over') || sig.includes('Negative') ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
                      {sig}
                    </span>
                  ))}
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">{report.confidence} confidence</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className={`flex h-16 w-16 flex-col items-center justify-center rounded-2xl bg-gradient-to-br ${gradeColor(score.grade)} text-white shadow-lg`}>
                  <div className="text-2xl font-black leading-none">{score.score}</div>
                  <div className="text-[10px] font-bold opacity-90">GRADE {score.grade}</div>
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={handleFlag}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${flagged ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                  >
                    {flagged ? '⭐ Flagged' : '☆ Flag'}
                  </button>
                  {onSave && (
                    <button
                      type="button"
                      onClick={() => onSave(report)}
                      className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      Save Deal
                    </button>
                  )}
                  <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50">Close</button>
                </div>
              </div>
            </div>
            {/* Score breakdown chips */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {score.parts.map((p) => (
                <span key={p.key} className="rounded-md bg-slate-50 border border-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500" title={p.detail}>
                  {p.key === 'valuationEdge' ? 'Value' : p.key === 'cashFlow' ? 'Cash flow' : p.key === 'brrrrEquity' ? 'BRRRR' : p.key === 'marketHeat' ? 'Market' : 'Risk'}: <b className="text-slate-700">{p.points}/{p.weight}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* ============ Valuation ============ */}
        <SectionCard
          title="Valuation"
          subtitle="Blended fair value from ATTOM AVM, RentCast AVM, and correlation-weighted sale comps"
          right={v?.signal && (
            <div className={`rounded-xl px-3 py-1.5 text-sm font-bold ${v.signal === 'undervalued' ? 'bg-emerald-100 text-emerald-700' : v.signal === 'overvalued' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
              {v.signal === 'undervalued' ? '▼ Under list' : v.signal === 'overvalued' ? '▲ Over list' : '≈ Fairly priced'}
              {v.variancePct != null && <span className="ml-1">{v.variancePct > 0 ? '+' : ''}{v.variancePct}%</span>}
            </div>
          )}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-3">
              <div className="text-[10px] font-semibold uppercase text-slate-500">Fair Value</div>
              <div className="text-lg font-bold text-slate-900">{fmtMoney(v?.fairValue)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <div className="text-[10px] font-semibold uppercase text-slate-500">List Price</div>
              <div className="text-lg font-bold text-slate-900">{fmtMoney(v?.listPrice)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <div className="text-[10px] font-semibold uppercase text-slate-500">$ / sqft (comps)</div>
              <div className="text-lg font-bold text-slate-900">{fmtMoney(v?.comps?.weightedPricePerSqft)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3">
              <div className="text-[10px] font-semibold uppercase text-slate-500">Comps Used</div>
              <div className="text-lg font-bold text-slate-900">{v?.comps?.count ?? 0}</div>
            </div>
          </div>

          {/* Component blend bars */}
          {v?.components?.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {v.components.map((c: any) => {
                const maxValue = Math.max(...v.components.map((x: any) => x.value));
                return (
                  <div key={c.key} className="flex items-center gap-2 text-xs">
                    <div className="w-32 shrink-0 text-slate-500">{c.label}</div>
                    <div className="h-4 flex-1 rounded bg-slate-100">
                      <div className="h-full rounded bg-blue-500/80" style={{ width: `${(c.value / maxValue) * 100}%` }} />
                    </div>
                    <div className="w-20 shrink-0 text-right font-semibold text-slate-700">{fmtMoney(c.value)}</div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-4">
            <AvmHistoryChart avmHistory={report.avmHistory} fairValue={v?.fairValue} listPrice={v?.listPrice} />
          </div>

          {/* Comps table */}
          {v?.comps?.items?.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-blue-600">View {v.comps.items.length} sale comps</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Address</th>
                      <th className="px-2 py-1.5 font-semibold">Price</th>
                      <th className="px-2 py-1.5 font-semibold">$/sf</th>
                      <th className="px-2 py-1.5 font-semibold">Bd/Ba</th>
                      <th className="px-2 py-1.5 font-semibold">Sqft</th>
                      <th className="px-2 py-1.5 font-semibold">Dist</th>
                      <th className="px-2 py-1.5 font-semibold">Match</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {v.comps.items.map((c: any, i: number) => (
                      <tr key={i}>
                        <td className="px-2 py-1.5 text-slate-700">{c.address}</td>
                        <td className="px-2 py-1.5 font-semibold text-slate-900">{fmtMoney(c.price)}</td>
                        <td className="px-2 py-1.5 text-slate-600">{fmtMoney(c.pricePerSqft)}</td>
                        <td className="px-2 py-1.5 text-slate-600">{c.bedrooms ?? '?'}/{c.bathrooms ?? '?'}</td>
                        <td className="px-2 py-1.5 text-slate-600">{c.squareFootage?.toLocaleString() ?? '—'}</td>
                        <td className="px-2 py-1.5 text-slate-600">{c.distanceMiles != null ? `${c.distanceMiles}mi` : '—'}</td>
                        <td className="px-2 py-1.5 text-slate-600">{c.correlation != null ? `${Math.round(c.correlation * 100)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </SectionCard>

        {/* ============ Assumptions and debt stack ============ */}
        <SectionCard
          title="Underwriting Assumptions"
          subtitle="These assumptions drive every cash-flow, return, and refinance number below"
          right={recomputing ? <span className="text-xs font-semibold text-blue-600">Recomputing…</span> : null}
        >
          <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-400">Purchase price</div>
                <div className="text-sm font-bold text-slate-900">{fmtMoney(assumptionDraft.purchasePrice)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-400">Loan amount</div>
                <div className="text-sm font-bold text-slate-900">{fmtMoney(activeScenario?.summary?.loanAmount)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-400">Monthly P&I</div>
                <div className="text-sm font-bold text-slate-900">{fmtMoney(activeScenario?.summary?.monthlyMortgagePayment)}/mo</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-400">Year-1 debt service</div>
                <div className="text-sm font-bold text-slate-900">{fmtMoney(activeScenario?.summary?.annualDebtServiceYear1)}/yr</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-100 bg-white p-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">Purchase & Loan</h4>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Down payment" value={assumptionDraft.downPaymentPercent} suffix="%" step={0.25} onChange={(v) => setAssumption('downPaymentPercent', v)} />
                <NumberField label="Interest rate" value={assumptionDraft.interestRate} suffix="%" step={0.125} onChange={(v) => setAssumption('interestRate', v)} />
                <NumberField label="Loan term" value={assumptionDraft.loanTermYears} suffix="yr" onChange={(v) => setAssumption('loanTermYears', v)} />
                <NumberField label="Closing costs" value={assumptionDraft.closingCostPercent} suffix="%" step={0.25} onChange={(v) => setAssumption('closingCostPercent', v)} />
              </div>
            </div>

            <div className="rounded-xl border border-slate-100 bg-white p-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-600">Rent & OpEx</h4>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Monthly rent" value={baseRent} prefix="$" onChange={(v) => setAssumption('monthlyRent', v)} />
                <NumberField label="Vacancy" value={assumptionDraft.vacancyRate} suffix="%" step={0.25} onChange={(v) => setAssumption('vacancyRate', v)} />
                <NumberField label="Management" value={assumptionDraft.managementFee} suffix="%" step={0.25} onChange={(v) => setAssumption('managementFee', v)} />
                <NumberField label="Rent growth" value={assumptionDraft.monthlyRentIncrease} suffix="%/yr" step={0.25} onChange={(v) => setAssumption('monthlyRentIncrease', v)} />
                <NumberField label="Property tax" value={assumptionDraft.propertyTax} prefix="$" onChange={(v) => setAssumption('propertyTax', v)} />
                <NumberField label="Insurance" value={assumptionDraft.insurance} prefix="$" onChange={(v) => setAssumption('insurance', v)} />
                <NumberField label="Maintenance" value={assumptionDraft.maintenance} prefix="$" onChange={(v) => setAssumption('maintenance', v)} />
                <NumberField label="CapEx/other" value={assumptionDraft.otherCosts} prefix="$" onChange={(v) => setAssumption('otherCosts', v)} />
              </div>
            </div>

            <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-indigo-700">BRRRR Refinance</h4>
              <div className="grid grid-cols-2 gap-2">
                <NumberField label="Refi year" value={assumptionDraft.refiAtYear} suffix="yr" onChange={(v) => setAssumption('refiAtYear', v)} />
                <NumberField label="Refi LTV" value={assumptionDraft.refiLtvPercent} suffix="%" step={0.5} onChange={(v) => setAssumption('refiLtvPercent', v)} />
                <NumberField label="Refi rate" value={assumptionDraft.refiRate} suffix="%" step={0.125} onChange={(v) => setAssumption('refiRate', v)} />
                <NumberField label="Refi term" value={assumptionDraft.refiLoanTermYears} suffix="yr" onChange={(v) => setAssumption('refiLoanTermYears', v)} />
              </div>
              <p className="mt-2 text-[11px] leading-snug text-indigo-700">
                Refinance trades equity and monthly cash flow for returned capital. A higher refi loan can lower FCF because debt service rises.
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4">
            {[
              ['Gross rent', fmtMoney(activeScenario?.summary?.grossPotentialIncomeYear1)],
              ['Operating expenses', fmtMoney(activeScenario?.summary?.operatingExpensesYear1)],
              ['NOI', fmtMoney(activeScenario?.summary?.noiYear1)],
              ['Debt service', fmtMoney(activeScenario?.summary?.annualDebtServiceYear1)],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">{label}</div>
                <div className="text-sm font-bold text-slate-900">{String(value)}/yr</div>
              </div>
            ))}
          </div>
          <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            Why FCF is negative here: with the current assumptions, Year-1 NOI is {fmtMoney(activeScenario?.summary?.noiYear1)} but annual debt service is {fmtMoney(activeScenario?.summary?.annualDebtServiceYear1)}. That spread is the main cash-flow drag.
          </div>
        </SectionCard>

        {/* ============ Calculator-style finance report ============ */}
        <SectionCard
          title="Rental Calculator View"
          subtitle={`${activeScenario?.label ?? 'Selected'} scenario shown with the same plain-language calculator outputs`}
        >
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
                For the {holdingLength} years invested
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Return (IRR)', fmtPct(activeScenario?.summary?.irrAtHoldPct), activeScenario?.summary?.irrAtHoldPct],
                  ['Total profit when sold', fmtMoney(activeScenario?.summary?.totalProfitWhenSold), activeScenario?.summary?.totalProfitWhenSold],
                  ['Cash on cash return', fmtPct(activeScenario?.summary?.cocYear1Pct), activeScenario?.summary?.cocYear1Pct],
                  ['Capitalization rate', fmtPct(activeScenario?.summary?.capRatePct), activeScenario?.summary?.capRatePct],
                  ['Total rental income', fmtMoney(holdTotals.income), holdTotals.income],
                  ['Total mortgage payments', fmtMoney(holdTotals.mortgage), -holdTotals.mortgage],
                  ['Total expenses', fmtMoney(holdTotals.expenses), -holdTotals.expenses],
                  ['Total NOI', fmtMoney(holdTotals.noi), holdTotals.noi],
                ].map(([label, value, signal]) => (
                  <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
                    <div className={`mt-1 text-lg font-black ${Number(signal) >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{String(value)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
                First year income and expense
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Line item</th>
                      <th className="px-3 py-2 text-right font-semibold">Monthly</th>
                      <th className="px-3 py-2 text-right font-semibold">Annual</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {firstYearRow && ([
                      ['Gross income', firstYearRow.grossPotentialIncome],
                      ['Vacancy', -firstYearRow.vacancyLoss],
                      ['Effective income', firstYearRow.annualIncome],
                      ['Property tax', -firstYearRow.propertyTax],
                      ['Insurance', -firstYearRow.insurance],
                      ['HOA', -firstYearRow.hoaFee],
                      ['Maintenance', -firstYearRow.maintenance],
                      ['Management', -firstYearRow.management],
                      ['Other / CapEx', -firstYearRow.otherCosts],
                      ['Net operating income', firstYearRow.netOperatingIncome],
                      ['Mortgage pay', -firstYearRow.mortgage],
                      ['Free cash flow', operatingCashFlowFor(firstYearRow)],
                    ] as Array<[string, number]>).map(([label, annual]) => (
                      <tr key={label}>
                        <td className="px-3 py-2 font-medium text-slate-700">{label}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${annual >= 0 ? 'text-slate-900' : 'text-rose-600'}`}>{fmtMoney(annual / 12)}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${annual >= 0 ? 'text-slate-900' : 'text-rose-600'}`}>{fmtMoney(annual)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {firstYearRow && (
            <div className="mt-4">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">First year operating mix</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {[
                  ['Mortgage', firstYearRow.mortgage, 'bg-blue-500'],
                  ['Vacancy', firstYearRow.vacancyLoss, 'bg-lime-500'],
                  ['Property tax', firstYearRow.propertyTax, 'bg-red-500'],
                  ['Insurance', firstYearRow.insurance, 'bg-cyan-500'],
                  ['Maintenance', firstYearRow.maintenance, 'bg-purple-500'],
                  ['Management', firstYearRow.management, 'bg-indigo-500'],
                  ['Other / CapEx', firstYearRow.otherCosts, 'bg-pink-500'],
                ].filter(([, value]) => Number(value) > 0).map(([label, value, color]) => {
                  const total = (firstYearRow.mortgage ?? 0) + (firstYearRow.vacancyLoss ?? 0) + (firstYearRow.operatingExpenses ?? 0);
                  const pct = total > 0 ? (Number(value) / total) * 100 : 0;
                  return (
                    <div key={String(label)} className="rounded-lg border border-slate-200 bg-white p-2">
                      <div className="mb-1 flex justify-between text-[11px]">
                        <span className="font-semibold text-slate-600">{label}</span>
                        <span className="font-bold text-slate-900">{fmtMoney(Number(value))} · {pct.toFixed(1)}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full ${String(color)}`} style={{ width: `${Math.max(pct, 2)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <details className="mt-4" open>
            <summary className="cursor-pointer text-xs font-semibold text-blue-600">Holding period table</summary>
            <div className="mt-2 max-h-80 overflow-auto rounded-xl border border-slate-200">
              <table className="min-w-[900px] w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Year</th>
                    <th className="px-3 py-2 text-right font-semibold">Annual income</th>
                    <th className="px-3 py-2 text-right font-semibold">Mortgage</th>
                    <th className="px-3 py-2 text-right font-semibold">Expenses</th>
                    <th className="px-3 py-2 text-right font-semibold">Cash flow</th>
                    <th className="px-3 py-2 text-right font-semibold">CoC return</th>
                    <th className="px-3 py-2 text-right font-semibold">Equity accumulated</th>
                    <th className="px-3 py-2 text-right font-semibold">Cash to receive</th>
                    <th className="px-3 py-2 text-right font-semibold">Return (IRR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  <tr className="bg-slate-50/60">
                    <td className="px-3 py-2 font-semibold text-slate-700">Begin</td>
                    <td className="px-3 py-2 text-right text-slate-400">-</td>
                    <td className="px-3 py-2 text-right text-slate-400">-</td>
                    <td className="px-3 py-2 text-right text-slate-400">-</td>
                    <td className="px-3 py-2 text-right font-semibold text-rose-600">{fmtMoney(-(activeScenario?.summary?.cashIn ?? 0))}</td>
                    <td className="px-3 py-2 text-right text-slate-400">-</td>
                    <td className="px-3 py-2 text-right text-slate-400">-</td>
                    <td className="px-3 py-2 text-right text-slate-400">-</td>
                    <td className="px-3 py-2 text-right text-slate-400">-</td>
                  </tr>
                  {holdingRows.map((row: any) => {
                    const cashFlow = operatingCashFlowFor(row);
                    return (
                      <tr key={row.year}>
                        <td className="px-3 py-2 font-semibold text-slate-700">{row.year}.</td>
                        <td className="px-3 py-2 text-right text-slate-700">{fmtMoney(row.annualIncome)}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{fmtMoney(row.mortgage)}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{fmtMoney(row.operatingExpenses)}</td>
                        <td className={`px-3 py-2 text-right font-bold ${cashFlow >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{fmtMoney(cashFlow)}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.cashOnCashReturn >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{fmtPct(row.cashOnCashReturn)}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{fmtMoney(row.equityAccumulated)}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{fmtMoney(row.cashToReceive)}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.irr >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{fmtPct(row.irr)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {finalHoldRow && (
              <div className="mt-2 text-[11px] text-slate-500">
                End-of-hold snapshot: equity {fmtMoney(finalHoldRow.equityAccumulated)}, sale cash to receive {fmtMoney(finalHoldRow.cashToReceive)}, modeled IRR {fmtPct(finalHoldRow.irr)}.
              </div>
            )}
          </details>
        </SectionCard>

        {/* ============ Stress test + offer solver ============ */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SectionCard title="Stress Test" subtitle="How wrong can you be and still cash flow?">
            {stressTest ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold">
                  <span className="text-slate-600">Baseline</span>
                  <span className={stressTest.baseline.monthlyCashFlow >= 0 ? 'text-emerald-700' : 'text-rose-600'}>
                    {fmtMoney(stressTest.baseline.monthlyCashFlow)}/mo · CoC {fmtPct(stressTest.baseline.cocPct)}
                  </span>
                </div>
                {stressTest.rows.map((row: any) => (
                  <div key={row.key} className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-600">{row.label}</span>
                    <span className="flex items-center gap-2">
                      <span className={row.stillPositive ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-600'}>
                        {fmtMoney(row.monthlyCashFlow)}/mo
                      </span>
                      <span className={`h-2 w-2 rounded-full ${row.stillPositive ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                    </span>
                  </div>
                ))}
                <div className={`mt-1 rounded-lg px-3 py-2 text-xs font-bold ${stressTest.survivesAllAdverse ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                  {stressTest.survivesAllAdverse ? '✓ Survives the all-adverse case' : '✗ Goes negative if everything moves against you'}
                </div>
              </div>
            ) : <div className="text-xs text-slate-400">Unavailable</div>}
          </SectionCard>

          <SectionCard title="Offer Price Solver" subtitle="What price makes this deal hit your buy box?">
            {offerSolver ? (
              <div>
                <div className={`rounded-xl p-4 ${offerSolver.meetsBoxAtAsking ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                  {offerSolver.maxOfferPrice != null ? (
                    <>
                      <div className="text-2xl font-black text-slate-900">{fmtMoney(offerSolver.maxOfferPrice)}</div>
                      <div className="mt-1 text-xs text-slate-600">
                        Max offer to hit {fmtMoney(offerSolver.buyBox.minMonthlyCashFlow)}/mo FCF + {fmtPct(offerSolver.buyBox.minCocPct, 0)} CoC
                        {offerSolver.discountFromAskingPct != null && offerSolver.discountFromAskingPct > 0 && (
                          <span className="font-semibold"> — {offerSolver.discountFromAskingPct}% below asking</span>
                        )}
                      </div>
                      <div className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${offerSolver.meetsBoxAtAsking ? 'bg-emerald-200 text-emerald-800' : 'bg-amber-200 text-amber-800'}`}>
                        {offerSolver.meetsBoxAtAsking ? 'Already meets your buy box at asking price' : 'Needs negotiation to meet your buy box'}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm font-semibold text-rose-700">{offerSolver.note || 'No realistic price meets the buy box.'}</div>
                  )}
                </div>
                {offerSolver.atAskingMetrics && (
                  <div className="mt-2 text-xs text-slate-500">
                    At asking: {fmtMoney(offerSolver.atAskingMetrics.monthlyCashFlow)}/mo · CoC {fmtPct(offerSolver.atAskingMetrics.cocPct)}
                  </div>
                )}
              </div>
            ) : <div className="text-xs text-slate-400">Provide a list price to solve for an offer.</div>}
          </SectionCard>
        </div>

        {/* ============ Renovation uplift ============ */}
        {report.renovation && projects.length > 0 && (
          <SectionCard
            title="Renovation Uplift"
            subtitle={report.renovation.source === 'gpt-4o-vision-v1'
              ? `AI photo analysis (${report.renovation.photosAnalyzed} photos) — condition ${report.renovation.conditionGrade ?? '?'}${report.renovation.conditionScore ? ` (${report.renovation.conditionScore}/100)` : ''}`
              : 'Market-level estimate — upload photos in the individual analyzer for a property-specific plan'}
          >
            {report.renovation.conditionNotes && (
              <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{report.renovation.conditionNotes}</p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p: RenovationProject, i: number) => {
                const enabled = enabledProjects.has(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setEnabledProjects((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      });
                    }}
                    className={`rounded-xl border-2 p-3 text-left transition-all ${enabled ? 'border-amber-400 bg-amber-50/60 shadow-sm' : 'border-slate-200 bg-white opacity-60 hover:opacity-90'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold text-slate-900">{p.name}</span>
                      <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${enabled ? 'bg-amber-500' : 'bg-slate-300'}`}>
                        <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : ''}`} />
                      </span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-3 gap-1 text-center">
                      <div>
                        <div className="text-[9px] font-semibold uppercase text-slate-400">Cost</div>
                        <div className="text-xs font-bold text-slate-800">{fmtMoney(p.cost)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] font-semibold uppercase text-slate-400">Value +</div>
                        <div className="text-xs font-bold text-emerald-700">{fmtMoney(p.valueUplift)}</div>
                      </div>
                      <div>
                        <div className="text-[9px] font-semibold uppercase text-slate-400">Rent +</div>
                        <div className="text-xs font-bold text-emerald-700">{fmtMoney(p.rentUpliftMonthly)}/mo</div>
                      </div>
                    </div>
                    {p.description && <div className="mt-1.5 text-[10px] leading-snug text-slate-500">{p.description}</div>}
                  </button>
                );
              })}
            </div>

            {/* Sticky as-is vs renovated strip */}
            <div className="sticky bottom-0 mt-3 grid grid-cols-3 gap-2 rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 p-3 shadow-sm">
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-500">Value: As-Is → Renovated</div>
                <div className="text-sm font-bold text-slate-900">
                  {fmtMoney(fairValue)} → <span className="text-emerald-700">{fmtMoney((fairValue ?? 0) + selectedTotals.valueUplift)}</span>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-500">Rent: As-Is → Renovated</div>
                <div className="text-sm font-bold text-slate-900">
                  {fmtMoney(baseRent)} → <span className="text-emerald-700">{fmtMoney((baseRent ?? 0) + selectedTotals.rentUpliftMonthly)}</span>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-500">Monthly FCF: As-Is → Reno</div>
                <div className="text-sm font-bold text-slate-900">
                  {fmtMoney(asIsCf)} → <span className={renoCf != null && renoCf >= 0 ? 'text-emerald-700' : 'text-rose-600'}>{fmtMoney(renoCf)}</span>
                  {recomputing && <span className="ml-1 text-[10px] text-slate-400">updating…</span>}
                </div>
              </div>
            </div>
          </SectionCard>
        )}

        {/* ============ Scenario comparison ============ */}
        <SectionCard
          title="Deal Scenarios"
          subtitle="Identical metric rows for every strategy — costs, changes, returns"
          right={
            <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
              {scenarios.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => { setSelectedScenario(s.key); setCompareMode(false); }}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${!compareMode && selectedScenario === s.key ? 'bg-white text-slate-900 shadow' : 'text-slate-500'}`}
                >
                  {s.label}
                </button>
              ))}
              {scenarios.length > 1 && (
                <button
                  type="button"
                  onClick={() => setCompareMode(true)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-colors ${compareMode ? 'bg-indigo-600 text-white shadow' : 'text-indigo-500'}`}
                >
                  Compare
                </button>
              )}
            </div>
          }
        >
          {/* Scenario metric table */}
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="px-2 py-1.5 font-semibold">Metric</th>
                  {scenarios.map((s) => (
                    <th key={s.key} className="px-2 py-1.5 font-bold" style={{ color: SCENARIO_COLORS[s.key] }}>{s.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {([
                  ['Cash in', (s: DealScenario) => fmtMoney(s.summary.cashIn)],
                  ['Cash left after refi', (s: DealScenario) => s.summary.refiCashOut != null ? fmtMoney(s.summary.cashLeftInDeal) : '—'],
                  ['Refi cash-out', (s: DealScenario) => s.summary.refiCashOut != null ? fmtMoney(s.summary.refiCashOut) : '—'],
                  ['Monthly FCF (yr 1)', (s: DealScenario) => fmtMoney(s.summary.monthlyCashFlowYear1)],
                  ['Monthly FCF (post-refi)', (s: DealScenario) => s.summary.postRefiMonthlyCashFlow != null ? fmtMoney(s.summary.postRefiMonthlyCashFlow) : '—'],
                  ['Cash-on-cash (yr 1)', (s: DealScenario) => fmtPct(s.summary.cocYear1Pct)],
                  ['Cap rate', (s: DealScenario) => fmtPct(s.summary.capRatePct)],
                  ['DSCR', (s: DealScenario) => s.summary.dscrYear1 != null ? String(s.summary.dscrYear1) : '—'],
                  ['IRR (5 yr)', (s: DealScenario) => fmtPct(s.summary.irr5yrPct)],
                  ['IRR (10 yr)', (s: DealScenario) => fmtPct(s.summary.irr10yrPct)],
                  ['Equity at hold end', (s: DealScenario) => fmtMoney(s.summary.equityAtHold)],
                  ['Total profit if sold', (s: DealScenario) => fmtMoney(s.summary.totalProfitWhenSold)],
                ] as Array<[string, (s: DealScenario) => string]>).map(([label, fn]) => (
                  <tr key={label}>
                    <td className="px-2 py-1.5 text-slate-500">{label}</td>
                    {scenarios.map((s) => (
                      <td key={s.key} className="px-2 py-1.5 font-semibold text-slate-800">{fn(s)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Scenario plan details */}
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            {scenarios.map((scenario) => {
              const refi = scenario.refiEvent;
              const inputs = scenario.financing?.inputs ?? {};
              return (
                <div key={scenario.key} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: SCENARIO_COLORS[scenario.key] }} />
                    <h4 className="text-sm font-bold text-slate-900">{scenario.label}</h4>
                  </div>
                  <p className="mb-2 min-h-[32px] text-[11px] leading-snug text-slate-500">{scenario.description}</p>
                  <div className="space-y-1 text-[11px] text-slate-600">
                    <div className="flex justify-between gap-2"><span>Purchase loan</span><b>{fmtMoney(scenario.summary.loanAmount)} @ {fmtPct(inputs.interestRate, 2)}</b></div>
                    <div className="flex justify-between gap-2"><span>Down + closing + rehab</span><b>{fmtMoney(scenario.summary.cashIn)}</b></div>
                    {inputs.repairCost > 0 && (
                      <>
                        <div className="flex justify-between gap-2"><span>Rehab budget</span><b>{fmtMoney(inputs.repairCost)}</b></div>
                        <div className="flex justify-between gap-2"><span>Modeled ARV</span><b>{fmtMoney(inputs.repairedValue)}</b></div>
                      </>
                    )}
                    {refi ? (
                      <div className="mt-2 rounded-lg border border-indigo-100 bg-white p-2">
                        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-indigo-600">Refinance event</div>
                        <div className="flex justify-between gap-2"><span>Timing</span><b>End of year {refi.year}</b></div>
                        <div className="flex justify-between gap-2"><span>New loan</span><b>{fmtMoney(refi.newLoanAmount)}</b></div>
                        <div className="flex justify-between gap-2"><span>Old balance paid off</span><b>{fmtMoney(refi.priorBalance)}</b></div>
                        <div className="flex justify-between gap-2"><span>Refi costs</span><b>{fmtMoney(refi.closingCost)}</b></div>
                        <div className="flex justify-between gap-2"><span>Cash returned</span><b className="text-indigo-700">{fmtMoney(refi.cashOut)}</b></div>
                        <div className="flex justify-between gap-2"><span>New payment</span><b>{fmtMoney(refi.newMonthlyPayment)}/mo</b></div>
                        <div className="flex justify-between gap-2"><span>Cash left in deal</span><b>{fmtMoney(scenario.summary.cashLeftInDeal)}</b></div>
                      </div>
                    ) : (
                      <div className="mt-2 rounded-lg bg-white p-2 text-[11px] text-slate-500">
                        No refinance modeled. Original loan stays in place through the hold period.
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Scenario overlay projections */}
          {scenarios.length > 1 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center gap-3 text-[11px]">
                {scenarios.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1 font-semibold" style={{ color: SCENARIO_COLORS[s.key] }}>
                    <span className="h-2 w-4 rounded-sm" style={{ background: SCENARIO_COLORS[s.key] }} /> {s.label}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <ScenarioOverlayChart
                  title="Annual Cash Flow (operating, $)"
                  scenarios={scenarios}
                  selector={(s) => (s.chartData?.cashFlow ?? []).map((value: number) => value * 1000)}
                  format={(value) => fmtMoney(value)}
                />
                <ScenarioOverlayChart
                  title="Equity Accumulated ($)"
                  scenarios={scenarios}
                  selector={(s) => (s.chartData?.propertyAppreciation?.equity ?? []).map((value: number) => value * 1000)}
                  format={(value) => fmtMoney(value)}
                />
                <ScenarioOverlayChart
                  title="IRR by Hold Period (%)"
                  scenarios={scenarios}
                  selector={(s) => s.chartData?.rollingIrr ?? []}
                  format={(value) => `${value.toFixed(0)}%`}
                />
                <ScenarioOverlayChart
                  title="Loan Balance ($)"
                  scenarios={scenarios}
                  selector={(s) => (s.chartData?.propertyAppreciation?.loan ?? []).map((value: number) => value * 1000)}
                  format={(value) => fmtMoney(value)}
                />
              </div>
            </div>
          )}

          {/* Refi grid */}
          {refiGrid && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-indigo-600">BRRRR refinance sensitivity grid (rate × LTV)</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-[11px]">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="px-2 py-1 text-left font-semibold">LTV \ Rate</th>
                      {refiGrid.rates.map((r: number) => <th key={r} className="px-2 py-1 font-semibold">{r}%</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {refiGrid.cells.map((row: any[], i: number) => (
                      <tr key={i}>
                        <td className="px-2 py-1 font-bold text-slate-700">{refiGrid.ltvs[i]}%</td>
                        {row.map((cell: any, j: number) => (
                          <td key={j} className="px-2 py-1 text-center">
                            <div className={`font-semibold ${cell.postRefiMonthlyCashFlow >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{fmtMoney(cell.postRefiMonthlyCashFlow)}/mo</div>
                            <div className="text-slate-400">out {fmtMoney(cell.cashOut)}</div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </SectionCard>

        {/* ============ Rental pricing power ============ */}
        {report.pricingPower && (
          <SectionCard title="Rental Pricing Power" subtitle="Where your rent sits vs the market — drag to test pricing">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl bg-slate-50 p-2.5 text-center">
                <div className="text-[10px] font-semibold uppercase text-slate-500">Benchmark</div>
                <div className="text-sm font-bold text-slate-900">{fmtMoney(report.pricingPower.benchmarkRent)}</div>
              </div>
              <div className="rounded-xl bg-emerald-50 p-2.5 text-center">
                <div className="text-[10px] font-semibold uppercase text-emerald-600">Recommended</div>
                <div className="text-sm font-bold text-emerald-700">{fmtMoney(report.pricingPower.recommendedRent)}</div>
              </div>
              <div className="rounded-xl bg-amber-50 p-2.5 text-center">
                <div className="text-[10px] font-semibold uppercase text-amber-600">Supported Ceiling</div>
                <div className="text-sm font-bold text-amber-700">{fmtMoney(report.pricingPower.supportedCeiling)}</div>
              </div>
              <div className="rounded-xl bg-rose-50 p-2.5 text-center">
                <div className="text-[10px] font-semibold uppercase text-rose-600">Rejection Point</div>
                <div className="text-sm font-bold text-rose-700">{fmtMoney(report.pricingPower.marketRejectionPoint)}</div>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-600">Test rent: <span className="text-base font-bold text-slate-900">{fmtMoney(baseRent)}</span>/mo</span>
                <span className="text-slate-400">All projections below update live</span>
              </div>
              <input
                type="range"
                min={Math.round((report.pricingPower.benchmarkRent ?? 1000) * 0.6)}
                max={report.pricingPower.marketRejectionPoint ?? 5000}
                step={25}
                value={baseRent ?? 0}
                onChange={(e) => setRentOverride(parseInt(e.target.value, 10))}
                className="mt-1 w-full accent-emerald-600"
              />
              {/* Vacancy response readout */}
              {(() => {
                const point = (report.pricingPower.curve ?? []).reduce((best: any, p: any) =>
                  (Math.abs(p.rent - (baseRent ?? 0)) < Math.abs((best?.rent ?? Infinity) - (baseRent ?? 0)) ? p : best), null);
                if (!point) return null;
                return (
                  <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                    <span>Est. vacancy at this rent: <b className={point.vacancyPct > 20 ? 'text-rose-600' : 'text-slate-700'}>{point.vacancyPct}%</b></span>
                    <span>Effective annual income: <b className="text-slate-700">{fmtMoney(point.effectiveAnnualIncome)}</b></span>
                  </div>
                );
              })()}
            </div>

            {/* Rent comps */}
            {report.rent?.comps?.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-blue-600">View {report.rent.comps.length} rental comps</summary>
                <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {report.rent.comps.map((c: any, i: number) => (
                    <div key={i} className="flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
                      <span className="truncate text-slate-600">{c.address}</span>
                      <span className="ml-2 shrink-0 font-bold text-slate-900">{fmtMoney(c.rent)}/mo</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </SectionCard>
        )}

        {/* ============ Full projection grid ============ */}
        <SectionCard
          title="Cash Flow & Returns Projections"
          subtitle={compareMode
            ? 'Compare mode — Buy & Hold baseline with Renovate & Hold and BRRRR overlaid in each chart'
            : `${activeScenario?.label ?? ''} scenario — full 30-year projection set`}
        >
          {gridChartData && <AdditionalAnalyticsChartsGrid
            avmGranularity={avmGranularity}
            avmRange={avmRange}
            avmPoints={avmPoints}
            avmLabels={avmLabels}
            chartData={gridChartData}
            analyticsGranularity={analyticsGranularity}
            taxHistoryRange={taxHistoryRange}
            taxHistorySeries={{
              values: (gridChartData?.incomeExpenses?.expenseBreakdown?.taxes ?? []),
              labels: gridChartData?.projectionLabels ?? [],
            }}
            mortgageAmortRange={mortgageAmortRange}
            onAnalyticsGranularityChange={setAnalyticsGranularity}
            onAvmGranularityChange={setAvmGranularity}
            onAvmRangeChange={setAvmRange}
            onTaxHistoryRangeChange={setTaxHistoryRange}
            onMortgageAmortRangeChange={setMortgageAmortRange}
            optimizedChartData={overlayA?.chartData ?? null}
            aiScenarioChartData={overlayB?.chartData ?? null}
            aiScenarioLabel={overlayB?.label ?? 'BRRRR'}
          />}
        </SectionCard>

        {/* ============ Cash flow Sankey ============ */}
        {sankeyInputs && (
          <SectionCard title="Cash Flow Waterfall" subtitle="Gross rent → vacancy → NOI → debt service → free cash flow">
            <Suspense fallback={<div className="flex h-40 items-center justify-center text-xs text-slate-400">Loading diagram…</div>}>
              <RentalSankeyDiagramLazy inputs={sankeyInputs} />
            </Suspense>
          </SectionCard>
        )}

        {/* ============ Market context + environmental ============ */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SectionCard title="Market Context" subtitle={`ZIP ${report.marketContext?.zipCode ?? '—'}${report.marketContext?.county?.name ? ` · ${report.marketContext.county.name}` : ''}`}>
            <div className="grid grid-cols-2 gap-2">
              {[
                ['Median sale price', fmtMoney(report.marketContext?.medianSalePrice)],
                ['Median asking rent', fmtMoney(report.marketContext?.medianAskingRent)],
                ['Gross yield', fmtPct(report.marketContext?.grossYieldPct)],
                ['Price-to-rent', report.marketContext?.priceToRentRatio ?? '—'],
                ['Sale DOM (median)', report.marketContext?.saleMedianDaysOnMarket != null ? `${report.marketContext.saleMedianDaysOnMarket}d` : '—'],
                ['Rental DOM (median)', report.marketContext?.rentalMedianDaysOnMarket != null ? `${report.marketContext.rentalMedianDaysOnMarket}d` : '—'],
                ['Active sale listings', report.marketContext?.saleListings ?? '—'],
                ['Active rentals', report.marketContext?.rentalListings ?? '—'],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg bg-slate-50 px-2.5 py-2">
                  <div className="text-[10px] font-semibold uppercase text-slate-400">{label}</div>
                  <div className="text-sm font-bold text-slate-800">{String(value)}</div>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard
            title="Environmental & Location Risk"
            right={report.environmental?.combinedRiskScore != null && (
              <div className={`rounded-xl px-3 py-1.5 text-sm font-bold ${report.environmental.combinedRiskScore < 30 ? 'bg-emerald-100 text-emerald-700' : report.environmental.combinedRiskScore < 60 ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                {report.environmental.combinedRiskScore}/100
              </div>
            )}
          >
            {(report as any).environmental ? (
              <div className="grid grid-cols-2 gap-2">
                {(report as any).environmental.hazards && Object.entries((report as any).environmental.hazards).map(([k, val]: [string, any]) => (
                  <div key={k} className="rounded-lg bg-slate-50 px-2.5 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-400">{k} risk</div>
                    <div className={`text-sm font-bold ${Number(val) < 30 ? 'text-emerald-700' : Number(val) < 60 ? 'text-amber-600' : 'text-rose-600'}`}>{val}/100</div>
                  </div>
                ))}
                {(report as any).environmental.noiseLevelDb != null && (
                  <div className="rounded-lg bg-slate-50 px-2.5 py-2">
                    <div className="text-[10px] font-semibold uppercase text-slate-400">Transit noise</div>
                    <div className="text-sm font-bold text-slate-800">{(report as any).environmental.noiseLevelDb} dB</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-slate-400">No hazard data available from ATTOM for this property.</div>
            )}
            <div className="mt-2 text-[10px] text-slate-400">Risk feeds into the deal score's risk component. Full mitigation planning lives in the Portfolio → Environmental Risk tab.</div>
          </SectionCard>
        </div>

        <div className="pb-2 text-center text-[10px] text-slate-400">
          Generated {new Date(report.generatedAt).toLocaleString()} · sources: ATTOM {report.sources?.attom?.ok ? '✓' : '✗'}{report.sources?.attom?.fromCache ? ' (cached)' : ''} · RentCast AVM {report.sources?.rentcastValueAvm?.ok ? '✓' : '✗'} · Market {report.sources?.zipMarket?.ok ? '✓' : '✗'} · FRED {report.sources?.fredCounty?.ok ? '✓' : '✗'}
        </div>
      </div>
    </div>
  );
};
