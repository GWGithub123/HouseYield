import { useMemo, useState, type ReactNode } from 'react';
import { Bot, X, Flag, Layers3, SlidersHorizontal, Sparkles } from 'lucide-react';
import VerdictBar from './components/VerdictBar';
import SimulationCanvas from './components/SimulationCanvas';
import LeversRail from './components/LeversRail';
import AINudges from './components/AINudges';
import ScenarioTray from './components/ScenarioTray';
import ProjectionBreakdownTable from './components/ProjectionBreakdownTable';
import { runMonteCarloFI } from './engine/monteCarlo';
import { computeFISpectrum } from './engine/fiSpectrum';
import { buildFinancialPlannerProjection } from '../../services/financialPlannerProjectionService';
import type { FinancialPlannerProjectionInput } from '../../services/financialPlannerProjectionService';
import type { AIAction, RetirementScenario } from '../../services/aiFinancialPlannerService';
import { useFIDelta } from './hooks/useFIDelta';
import { useFIScenarios } from './hooks/useFIScenarios';
import type { FILever, FIMilestone, FINudge, FIVerdict, FIScenarioSummary } from './types';

const LIVE_SCENARIO_ID = '__live__';

/** Origin-style eyebrow section header with a fading divider and optional actions. */
function ZoneHeader({ label, hint, actions }: { label: string; hint?: string; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="h-3.5 w-1 shrink-0 rounded-full bg-gradient-to-b from-sky-500 to-indigo-500" />
        <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          {label}
        </span>
        {hint ? <span className="hidden truncate text-xs text-slate-400 md:inline">· {hint}</span> : null}
      </div>
      <span className="h-px min-w-6 flex-1 bg-gradient-to-r from-slate-200/90 to-transparent" />
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

interface FinancialIndependencePageProps {
  /** The base projection input (already shaped by App's financialPlannerContext). */
  projectionInput: FinancialPlannerProjectionInput;
  /** Adjustable levers, fully wired to App state setters. */
  levers: FILever[];
  /** Timeline milestones (retirement, property events, FI). */
  milestones: FIMilestone[];
  userId?: string | null;
  /** Current age, used to project the user's age at FI. */
  currentAge?: number | null;
  /** Parameters snapshot used when saving the live plan as a scenario. */
  scenarioParameters: RetirementScenario['parameters'];
  scenarioTimelineHints?: RetirementScenario['timelineHints'];
  activeScenarioId: string | null;
  /** The full active scenario object, for the applied-scenario breakdown banner. */
  activeScenario?: RetirementScenario | null;
  appliedScenarioIds?: string[];
  baselineFiYear?: number | null;
  baselineProjectionInput?: FinancialPlannerProjectionInput;
  onLoadScenario: (scenario: RetirementScenario) => void;
  onApplyScenarioStack?: (scenarios: RetirementScenario[]) => void;
  onClearScenario: () => void;
  /** Apply AI nudge actions through App's existing handler. */
  onApplyActions: (actions: AIAction[]) => void;
  onOpenPlanner?: () => void;
  onOpenSettings?: () => void;
  /** AI Financial Planner chat, shown in a floating glass panel when plannerOpen. */
  plannerSlot?: ReactNode;
  /** Whether the AI planner panel is open (owned by App's showAIPlanner state). */
  plannerOpen?: boolean;
  /** Expense breakdown card (donut + category list + checking-account feed), right rail. */
  expenseSlot?: ReactNode;
}

/** Step a single field of the projection input for marginal-impact analysis. */
const IMPACT_MUTATORS: Record<
  string,
  (input: FinancialPlannerProjectionInput, step: number) => FinancialPlannerProjectionInput
> = {
  spend: (i, step) => ({ ...i, monthlyCostOfLiving: i.monthlyCostOfLiving + step }),
  contribution: (i, step) => ({ ...i, retirementMonthlyContribution: i.retirementMonthlyContribution + step }),
  spendingReduction: (i, step) => ({ ...i, spendingReduction: i.spendingReduction + step }),
  stockGrowth: (i, step) => ({ ...i, expectedStockGrowth: i.expectedStockGrowth + step }),
  inflation: (i, step) => ({ ...i, costOfLivingInflation: i.costOfLivingInflation + step }),
};

export default function FinancialIndependencePage({
  projectionInput,
  levers,
  milestones,
  userId,
  currentAge,
  scenarioParameters,
  scenarioTimelineHints,
  activeScenarioId,
  activeScenario,
  appliedScenarioIds = [],
  baselineFiYear = null,
  baselineProjectionInput,
  onLoadScenario,
  onApplyScenarioStack,
  onClearScenario,
  onApplyActions,
  onOpenPlanner,
  onOpenSettings,
  plannerSlot,
  plannerOpen = false,
  expenseSlot,
}: FinancialIndependencePageProps) {
  const [view, setView] = useState<'income' | 'account'>('income');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [leversOpen, setLeversOpen] = useState(false);

  const formatCurrency = (value: number) => `$${Math.round(value).toLocaleString()}`;
  const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const findChartFiYear = (bands: Array<{ year: number; incomeP50: number; costOfLiving: number }>) => {
    for (let index = 0; index < bands.length; index += 1) {
      const candidate = bands[index];
      if (candidate.incomeP50 < candidate.costOfLiving) {
        continue;
      }
      const remainsIndependent = bands.slice(index).every((band) => band.incomeP50 >= band.costOfLiving);
      if (remainsIndependent) {
        return candidate.year;
      }
    }
    return null;
  };

  const monteCarlo = useMemo(() => runMonteCarloFI(projectionInput), [projectionInput]);
  const effectiveBaselineProjectionInput = baselineProjectionInput ?? projectionInput;
  const baselineMonteCarlo = useMemo(
    () => runMonteCarloFI(effectiveBaselineProjectionInput),
    [effectiveBaselineProjectionInput],
  );
  const detPoints = monteCarlo.deterministic.points;
  const baselineDetPoints = baselineMonteCarlo.deterministic.points;
  const currentYear = monteCarlo.deterministic.summary.currentYear;
  const baseFiYear = monteCarlo.deterministic.summary.fiYear;
  const baselineDeterministicFiYear = baselineMonteCarlo.deterministic.summary.fiYear;

  const spectrum = useMemo(() => {
    const annualExpenses =
      projectionInput.monthlyCostOfLiving * (1 - projectionInput.spendingReduction) * 12;
    return computeFISpectrum(detPoints, {
      annualExpenses,
      safeWithdrawalRate: 0.04,
      growthRate: projectionInput.expectedStockGrowth || 0.05,
      coastTargetYear: projectionInput.plannedRetirementYear ?? currentYear + 25,
      currentYear,
    });
  }, [detPoints, projectionInput, currentYear]);

  // Canonical FI year for the chart: the year the plotted median income line
  // actually crosses the cost-of-living line. Using this for BOTH the vertical
  // marker and the headline guarantees the line sits exactly on the visual
  // crossing (no separate, slightly-offset deterministic FI dot).
  const chartFiYear = useMemo(() => findChartFiYear(monteCarlo.bands), [monteCarlo.bands]);
  const baselineChartFiYear = useMemo(
    () => findChartFiYear(baselineMonteCarlo.bands) ?? baselineDeterministicFiYear,
    [baselineDeterministicFiYear, baselineMonteCarlo.bands],
  );

  const headlineFiYear = chartFiYear ?? baseFiYear;
  const ageAtFi =
    currentAge != null && headlineFiYear != null
      ? currentAge + (headlineFiYear - currentYear)
      : null;

  const verdict: FIVerdict = {
    currentYear,
    fiYearDeterministic: baseFiYear,
    fiYearMedian: headlineFiYear,
    fiYearOptimistic: monteCarlo.fiYearOptimistic,
    fiYearPessimistic: monteCarlo.fiYearPessimistic,
    successProbability: monteCarlo.successProbability,
    ageAtFi,
  };

  const delta = useFIDelta({
    userId,
    fiYear: headlineFiYear,
    successProbability: monteCarlo.successProbability,
    ready: detPoints.length > 0,
  });

  // Marginal impact per lever: re-run the deterministic projection with one
  // lever stepped up, compare the resulting FI year. Cheap (5 projections).
  const impacts = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    for (const lever of levers) {
      const mutate = IMPACT_MUTATORS[lever.id];
      if (!mutate || baseFiYear == null) {
        out[lever.id] = null;
        continue;
      }
      const stepped = buildFinancialPlannerProjection(mutate(projectionInput, lever.step));
      const fi = stepped.summary.fiYear;
      out[lever.id] = fi == null ? null : Math.round(fi - baseFiYear);
    }
    return out;
  }, [levers, projectionInput, baseFiYear]);

  // Deterministic, locally-computed nudges with measured FI-year impact.
  const nudges = useMemo<FINudge[]>(() => {
    if (baseFiYear == null) return [];
    const fiOf = (input: FinancialPlannerProjectionInput) =>
      buildFinancialPlannerProjection(input).summary.fiYear;
    const result: FINudge[] = [];

    if (projectionInput.spendingReduction < 0.1) {
      const fi = fiOf({ ...projectionInput, spendingReduction: 0.1 });
      const monthlySaved = Math.round(projectionInput.monthlyCostOfLiving * 0.1);
      result.push({
        id: 'trim-spending',
        headline: 'Trim spending by 10%',
        detail: `Cutting about $${monthlySaved.toLocaleString()}/mo redirects more into your portfolio.`,
        impactYears: fi == null ? null : Math.round(fi - baseFiYear),
        actions: [{ type: 'adjustSpending', reductionPercent: 10 }],
        applyLabel: 'Apply cut',
      });
    }

    const extra = 500;
    const fiContrib = fiOf({
      ...projectionInput,
      retirementMonthlyContribution: projectionInput.retirementMonthlyContribution + extra,
    });
    result.push({
      id: 'boost-contributions',
      headline: `Invest $${extra}/mo more`,
      detail: 'Increasing automatic contributions compounds your path to independence.',
      impactYears: fiContrib == null ? null : Math.round(fiContrib - baseFiYear),
      actions: [
        {
          type: 'adjustContributions',
          newMonthlyContribution: projectionInput.retirementMonthlyContribution + extra,
        },
      ],
      applyLabel: 'Add $500/mo',
    });

    return result
      .filter((n) => n.impactYears == null || n.impactYears <= 0)
      .slice(0, 3);
  }, [projectionInput, baseFiYear]);

  const scenariosStore = useFIScenarios(userId);

  const appliedScenarios = useMemo(() => {
    return appliedScenarioIds
      .map((id) => scenariosStore.scenarios.find((scenario) => scenario.id === id) ?? null)
      .filter((scenario): scenario is RetirementScenario => Boolean(scenario));
  }, [appliedScenarioIds, scenariosStore.scenarios]);

  const scenarioSummaries: FIScenarioSummary[] = scenariosStore.scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    fiYear: s.fiYear,
    source: s.source,
    applied: appliedScenarioIds.includes(s.id),
    active: s.id === activeScenarioId,
  }));

  const handleSelectScenario = (id: string) => {
    if (id === LIVE_SCENARIO_ID) {
      onClearScenario();
      return;
    }
    const scenario = scenariosStore.scenarios.find((s) => s.id === id);
    if (scenario) onLoadScenario(scenario);
  };

  const handleToggleAppliedScenario = (id: string) => {
    const nextIds = appliedScenarioIds.includes(id)
      ? appliedScenarioIds.filter((scenarioId) => scenarioId !== id)
      : [...appliedScenarioIds, id];
    const nextScenarios = nextIds
      .map((scenarioId) => scenariosStore.scenarios.find((scenario) => scenario.id === scenarioId) ?? null)
      .filter((scenario): scenario is RetirementScenario => Boolean(scenario));

    if (nextScenarios.length === 0) {
      onClearScenario();
      return;
    }

    if (onApplyScenarioStack) {
      onApplyScenarioStack(nextScenarios);
      return;
    }

    const lastScenario = nextScenarios[nextScenarios.length - 1];
    if (lastScenario) {
      handleSelectScenario(lastScenario.id);
    }
  };

  const handleSaveScenario = () => {
    void scenariosStore.save({
      name: `Plan ${scenariosStore.scenarios.length + 1}`,
      parameters: scenarioParameters,
      timelineHints: scenarioTimelineHints,
      fiYear: headlineFiYear,
    });
  };

  const handleDeleteScenario = (id: string) => {
    setCompareIds((prev) => prev.filter((c) => c !== id));
    if (appliedScenarioIds.includes(id)) {
      const remainingScenarios = appliedScenarioIds
        .filter((scenarioId) => scenarioId !== id)
        .map((scenarioId) => scenariosStore.scenarios.find((scenario) => scenario.id === scenarioId) ?? null)
        .filter((scenario): scenario is RetirementScenario => Boolean(scenario));
      if (remainingScenarios.length === 0) {
        onClearScenario();
      } else if (onApplyScenarioStack) {
        onApplyScenarioStack(remainingScenarios);
      }
    }
    void scenariosStore.remove(id);
  };

  const comparisonYear = projectionInput.plannedRetirementYear ?? effectiveBaselineProjectionInput.plannedRetirementYear ?? null;
  const comparisonCurrentPoint = comparisonYear != null ? detPoints.find((point) => point.year === comparisonYear) ?? null : null;
  const comparisonBaselinePoint = comparisonYear != null ? baselineDetPoints.find((point) => point.year === comparisonYear) ?? null : null;
  const currentFinalPoint = detPoints[detPoints.length - 1] ?? null;
  const baselineFinalPoint = baselineDetPoints[baselineDetPoints.length - 1] ?? null;
  const hasScenarioStack = appliedScenarios.length > 0;
  const scenarioImpactBaseline = baselineChartFiYear ?? baselineFiYear;
  const scenarioImpact = hasScenarioStack && headlineFiYear != null && scenarioImpactBaseline != null
    ? headlineFiYear - scenarioImpactBaseline
    : null;
  const scenarioMoves = milestones.filter((milestone) => milestone.kind !== 'fi');
  const activeScenarioSummary = activeScenario?.summary?.trim()
    || activeScenario?.notes?.find((note) => note.trim())
    || null;
  const aiNotes = Array.from(new Set((activeScenario?.notes || []).map((note) => note.trim()).filter(Boolean)));
  const financialBenefits = useMemo(() => {
    const benefits: string[] = [];

    if (scenarioImpact != null && scenarioImpact < 0) {
      benefits.push(`Projected FI moves ${Math.abs(scenarioImpact)} ${Math.abs(scenarioImpact) === 1 ? 'year' : 'years'} sooner on the same simulation basis.`);
    }

    if (comparisonCurrentPoint && comparisonBaselinePoint) {
      const incomeDelta = comparisonCurrentPoint.investmentIncome - comparisonBaselinePoint.investmentIncome;
      const surplusDelta = comparisonCurrentPoint.surplus - comparisonBaselinePoint.surplus;
      if (incomeDelta > 500) {
        benefits.push(`Projected investment income in ${comparisonYear} rises by ${formatCurrency(incomeDelta)} per year.`);
      }
      if (surplusDelta > 500) {
        benefits.push(`Annual cash-flow cushion in ${comparisonYear} improves by ${formatCurrency(surplusDelta)}.`);
      }
    }

    if (currentFinalPoint && baselineFinalPoint) {
      const accountDelta = currentFinalPoint.accountValue - baselineFinalPoint.accountValue;
      if (accountDelta > 10_000) {
        benefits.push(`Projected portfolio value is ${formatCurrency(accountDelta)} higher by ${currentFinalPoint.year}.`);
      }
    }

    if (activeScenario?.parameters.portfolioReallocation?.enabled) {
      const targetName = activeScenario.parameters.portfolioReallocation.targetTicker
        || activeScenario.parameters.portfolioReallocation.targetAssetName;
      benefits.push(`Reallocation targets ${targetName} around ${formatPercent(activeScenario.parameters.portfolioReallocation.targetYield)} yield.`);
    }

    if (benefits.length === 0 && activeScenarioSummary) {
      benefits.push(activeScenarioSummary);
    }

    return benefits.slice(0, 4);
  }, [activeScenario, activeScenarioSummary, baselineFinalPoint, comparisonBaselinePoint, comparisonCurrentPoint, comparisonYear, currentFinalPoint, scenarioImpact]);
  const scenarioRisks = useMemo(() => {
    const risks: string[] = [];

    if (scenarioImpact != null && scenarioImpact > 0) {
      risks.push(`Projected FI moves ${scenarioImpact} ${scenarioImpact === 1 ? 'year' : 'years'} later on the current simulation path.`);
    }

    if (comparisonCurrentPoint && comparisonCurrentPoint.surplus < 0) {
      risks.push(`At ${comparisonYear}, passive income still trails expenses by ${formatCurrency(Math.abs(comparisonCurrentPoint.surplus))} per year.`);
    }

    if (
      projectionInput.plannedRetirementYear != null
      && effectiveBaselineProjectionInput.plannedRetirementYear != null
      && projectionInput.plannedRetirementYear > effectiveBaselineProjectionInput.plannedRetirementYear
    ) {
      risks.push(`The plan delays retirement from ${effectiveBaselineProjectionInput.plannedRetirementYear} to ${projectionInput.plannedRetirementYear}.`);
    }

    if (projectionInput.expectedStockGrowth > effectiveBaselineProjectionInput.expectedStockGrowth + 0.0025) {
      risks.push(`It leans on a higher stock-growth assumption (${formatPercent(projectionInput.expectedStockGrowth)} vs ${formatPercent(effectiveBaselineProjectionInput.expectedStockGrowth)}).`);
    }

    if (projectionInput.expectedDividendGrowth > effectiveBaselineProjectionInput.expectedDividendGrowth + 0.0025) {
      risks.push(`It also assumes faster dividend growth (${formatPercent(projectionInput.expectedDividendGrowth)} vs ${formatPercent(effectiveBaselineProjectionInput.expectedDividendGrowth)}).`);
    }

    if (activeScenario?.parameters.portfolioReallocation?.enabled) {
      const targetName = activeScenario.parameters.portfolioReallocation.targetTicker
        || activeScenario.parameters.portfolioReallocation.targetAssetName;
      risks.push(`The reallocation concentrates more capital into ${targetName}, which adds single-name and sector risk.`);
    }

    if (risks.length === 0) {
      risks.push('Results are still sensitive to market returns, inflation, and dividend growth across the confidence band.');
    }

    return risks.slice(0, 4);
  }, [activeScenario, comparisonCurrentPoint, comparisonYear, effectiveBaselineProjectionInput.expectedDividendGrowth, effectiveBaselineProjectionInput.expectedStockGrowth, effectiveBaselineProjectionInput.plannedRetirementYear, formatPercent, projectionInput.expectedDividendGrowth, projectionInput.expectedStockGrowth, projectionInput.plannedRetirementYear, scenarioImpact]);
  return (
    <div className="flex flex-col gap-5">
      <VerdictBar
        verdict={verdict}
        deltaYears={delta.deltaYears}
        lastSeenLabel={delta.lastSeenLabel}
        drawCount={monteCarlo.draws}
        onAdjustAssumptions={onOpenSettings}
      />

      {hasScenarioStack ? (
        <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
                {appliedScenarios.length > 1 ? <Layers3 size={18} /> : activeScenario?.source === 'ai' ? <Bot size={18} /> : <Flag size={18} />}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-500">
                    {appliedScenarios.length > 1 ? 'Scenario stack applied' : 'Scenario applied'}
                  </span>
                  {activeScenario?.source === 'ai' && appliedScenarios.length === 1 ? (
                    <span className="rounded-md bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600">
                      AI
                    </span>
                  ) : null}
                </div>
                <h3 className="text-base font-semibold text-slate-900">
                  {appliedScenarios.length > 1
                    ? `${appliedScenarios.length} scenarios stacked`
                    : activeScenario?.name}
                </h3>
                {appliedScenarios.length > 1 ? (
                  <p className="mt-0.5 max-w-2xl text-sm text-slate-600">
                    Applied in order. Later scenarios override earlier ones where they touch the same control.
                  </p>
                ) : activeScenarioSummary ? (
                  <p className="mt-0.5 max-w-2xl text-sm text-slate-600">
                    {activeScenarioSummary}
                  </p>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={onClearScenario}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
            >
              <X size={13} /> Return to live plan
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {appliedScenarios.length > 1
              ? appliedScenarios.map((scenario, index) => (
                  <span
                    key={scenario.id}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-sm shadow-sm"
                  >
                    <span className="text-indigo-500">#{index + 1}</span>
                    <span className="font-medium text-slate-900">{scenario.name}</span>
                    {scenario.fiYear ? <span className="text-slate-400">FI {scenario.fiYear}</span> : null}
                  </span>
                ))
              : null}
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-sm shadow-sm">
              <span className="text-slate-500">Current FI year</span>
              <span className="font-semibold text-slate-900">{headlineFiYear ?? activeScenario?.fiYear ?? '—'}</span>
            </span>
            {scenarioImpact != null ? (
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium shadow-sm ${
                  scenarioImpact < 0
                    ? 'bg-emerald-50 text-emerald-700'
                    : scenarioImpact > 0
                      ? 'bg-rose-50 text-rose-600'
                      : 'bg-slate-50 text-slate-600'
                }`}
              >
                {scenarioImpact === 0
                  ? 'No change to FI year'
                  : `FI ${Math.abs(scenarioImpact)} ${Math.abs(scenarioImpact) === 1 ? 'year' : 'years'} ${scenarioImpact < 0 ? 'sooner' : 'later'} than baseline`}
              </span>
            ) : null}
          </div>

          {scenarioMoves.length ? (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                What shows on the graph
              </div>
              <div className="flex flex-wrap gap-1.5">
                {scenarioMoves.map((move, idx) => (
                  <span
                    key={`${move.year}-${idx}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600"
                  >
                    <span className="font-semibold text-slate-800">{move.year}</span>
                    {move.label}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-white/70 bg-white/80 p-3 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">AI breakdown</div>
              {activeScenarioSummary ? <p className="mt-2 text-sm leading-relaxed text-slate-700">{activeScenarioSummary}</p> : null}
              {aiNotes.length ? (
                <div className="mt-2 space-y-1.5 text-xs text-slate-500">
                  {aiNotes.map((note, index) => (
                    <div key={`${note}-${index}`} className="rounded-lg bg-slate-50 px-2.5 py-2 leading-relaxed">
                      {note}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">Financial benefits</div>
              <div className="mt-2 space-y-1.5 text-sm text-emerald-900">
                {financialBenefits.map((benefit, index) => (
                  <div key={`${benefit}-${index}`} className="rounded-lg bg-white/70 px-2.5 py-2 leading-relaxed">
                    {benefit}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-amber-100 bg-amber-50/70 p-3 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">Risks and tradeoffs</div>
              <div className="mt-2 space-y-1.5 text-sm text-amber-900">
                {scenarioRisks.map((risk, index) => (
                  <div key={`${risk}-${index}`} className="rounded-lg bg-white/70 px-2.5 py-2 leading-relaxed">
                    {risk}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ZONE: living projection — chart with the expense breakdown as its right-hand companion */}
      <section>
        <ZoneHeader
          label="Living projection"
          hint="Median path with 80% confidence band"
          actions={(
            <>
              <button
                type="button"
                onClick={() => setLeversOpen((open) => !open)}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  leversOpen
                    ? 'border-sky-300 bg-sky-50 text-sky-700'
                    : 'border-slate-200 bg-white/80 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                <SlidersHorizontal size={13} /> Adjust levers
              </button>
              {onOpenPlanner ? (
                <button
                  type="button"
                  onClick={onOpenPlanner}
                  className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-white shadow-[0_4px_14px_rgba(99,102,241,0.35)] transition-transform hover:scale-[1.02]"
                  style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 55%, #a855f7 100%)' }}
                >
                  <Sparkles size={13} /> Plan with AI
                </button>
              ) : null}
            </>
          )}
        />
        <div className={`grid grid-cols-1 gap-5 ${expenseSlot ? 'xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] xl:items-start' : ''}`}>
          <div className="min-w-0">
            <SimulationCanvas
              bands={monteCarlo.bands}
              points={detPoints}
              spectrum={spectrum}
              milestones={milestones}
              fiYear={headlineFiYear}
              view={view}
              onViewChange={setView}
            />
          </div>
          {expenseSlot ? <div className="min-w-0">{expenseSlot}</div> : null}
        </div>
      </section>

      {/* ZONE: scenarios */}
      <section>
        <ZoneHeader label="Scenarios" hint="Apply to stack · pin to compare" />
        <ScenarioTray
          scenarios={scenarioSummaries}
          activeId={activeScenarioId}
          appliedIds={appliedScenarioIds}
          compareIds={compareIds}
          liveFiYear={baselineFiYear ?? headlineFiYear}
          currentFiYear={headlineFiYear}
          onResetToLive={onClearScenario}
          onToggleApplied={handleToggleAppliedScenario}
          onToggleCompare={(id) =>
            setCompareIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]))
          }
          onSave={handleSaveScenario}
          onDelete={handleDeleteScenario}
          saving={scenariosStore.saving}
        />
      </section>

      {/* ZONE: plan details — year-by-year breakdown beside AI nudges */}
      <section>
        <ZoneHeader label="Plan details" hint="Year-by-year breakdown and smart moves" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3 lg:items-start">
          <div className="min-w-0 lg:col-span-2">
            <ProjectionBreakdownTable
              points={detPoints}
              milestones={milestones}
              fiYear={headlineFiYear}
              retirementYear={projectionInput.plannedRetirementYear ?? null}
            />
          </div>
          <div className="min-w-0">
            <AINudges nudges={nudges} onApply={(n) => onApplyActions(n.actions)} onOpenPlanner={onOpenPlanner} />
          </div>
        </div>
      </section>

      {/* Floating levers sheet: anchored right so the simulation chart stays visible while dragging */}
      {leversOpen ? (
        <div className="fixed bottom-4 right-4 top-24 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col">
          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl"
            style={{
              background: 'linear-gradient(150deg, rgba(255,255,255,0.96) 0%, rgba(248,250,252,0.94) 100%)',
              backdropFilter: 'blur(28px) saturate(170%)',
              WebkitBackdropFilter: 'blur(28px) saturate(170%)',
              border: '1px solid rgba(255,255,255,0.85)',
              boxShadow: '0 0 0 1px rgba(15,23,42,0.05), 0 24px 60px -24px rgba(15,23,42,0.35)',
            }}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 px-4 py-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <span className="h-4 w-1 rounded-full bg-gradient-to-b from-sky-500 to-teal-500" />
                  Levers
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">Drag a slider — the simulation updates live.</p>
              </div>
              <button
                type="button"
                onClick={() => setLeversOpen(false)}
                aria-label="Close levers"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:text-slate-900"
              >
                <X size={15} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <LeversRail levers={levers} impacts={impacts} frameless />
            </div>
          </div>
        </div>
      ) : null}

      {/* Floating AI planner: collapsed it is a launcher pill, expanded a glass chat panel.
          Bottom-right anchored so the charts remain visible and update live. */}
      {plannerSlot && plannerOpen ? (
        <div className="fixed bottom-5 right-5 z-[70] flex max-h-[calc(100vh-6rem)] w-[min(430px,calc(100vw-2.5rem))] flex-col justify-end overflow-y-auto">
          <div className="w-full drop-shadow-2xl">{plannerSlot}</div>
        </div>
      ) : null}
    </div>
  );
}
