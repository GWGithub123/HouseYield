/**
 * Monte Carlo financial-independence engine.
 *
 * Wraps the trusted deterministic projection (buildFinancialPlannerProjection)
 * and runs it across many randomized draws of the uncertain growth assumptions
 * to produce confidence bands (P10/P50/P90), a success probability, and an
 * optimistic / median / pessimistic FI year.
 *
 * Pure and deterministic given a seed, so it is safe to memoize and unit test.
 */

import {
  buildFinancialPlannerProjection,
  type FinancialPlannerProjectionInput,
  type FinancialPlannerProjectionResult,
} from '../../../services/financialPlannerProjectionService';

export interface MonteCarloVolatility {
  /** Annual stdev applied to the expected stock growth rate (e.g. 0.15 = 15%). */
  stockGrowth: number;
  /** Annual stdev applied to expected dividend growth. */
  dividendGrowth: number;
  /** Annual stdev applied to cost-of-living inflation. */
  inflation: number;
  /** Annual stdev applied to property appreciation. */
  propertyAppreciation: number;
  /** Annual stdev applied to expected bond yield. */
  bondYield: number;
}

export interface MonteCarloConfig {
  /** Number of randomized draws. */
  draws: number;
  /** Seed for reproducible output. */
  seed: number;
  /** Per-assumption volatility. */
  volatility: MonteCarloVolatility;
}

export interface MonteCarloBandPoint {
  year: number;
  yearsFromNow: number;
  /** Deterministic cost-of-living line (no randomness on the expense side). */
  costOfLiving: number;
  incomeP10: number;
  incomeP50: number;
  incomeP90: number;
  accountP10: number;
  accountP50: number;
  accountP90: number;
}

export interface MonteCarloResult {
  /** The deterministic ("expected") projection used as the centre reference. */
  deterministic: FinancialPlannerProjectionResult;
  /** Per-year aggregated percentile bands across all draws. */
  bands: MonteCarloBandPoint[];
  /** Fraction (0-1) of draws that reach FI within the projection horizon. */
  successProbability: number;
  /** Median FI year across successful draws (null if < 50% succeed). */
  fiYearMedian: number | null;
  /** Optimistic (P10 = early) FI year. */
  fiYearOptimistic: number | null;
  /** Pessimistic (P90 = late) FI year. */
  fiYearPessimistic: number | null;
  /** Number of draws executed. */
  draws: number;
}

// NOTE: each draw samples ONE constant rate held for the whole horizon, so the
// correct dispersion is the *long-run annualized* stdev (≈ single-year vol /
// sqrt(horizon)), not the much larger single-year volatility. Using single-year
// vol here would massively overstate the tails. True per-year sequence-of-returns
// sampling is a planned follow-up that will use larger single-year volatilities.
export const DEFAULT_MONTE_CARLO_VOLATILITY: MonteCarloVolatility = {
  stockGrowth: 0.03,
  dividendGrowth: 0.015,
  inflation: 0.01,
  propertyAppreciation: 0.02,
  bondYield: 0.01,
};

export const DEFAULT_MONTE_CARLO_CONFIG: MonteCarloConfig = {
  draws: 400,
  seed: 1337,
  volatility: DEFAULT_MONTE_CARLO_VOLATILITY,
};

/** Mulberry32 — small, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box-Muller. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Clamp a sampled rate to a sane band so a single tail draw cannot explode. */
function clampRate(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  if (sortedAscending.length === 1) return sortedAscending[0];
  const rank = (p / 100) * (sortedAscending.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedAscending[low];
  const weight = rank - low;
  return sortedAscending[low] * (1 - weight) + sortedAscending[high] * weight;
}

/**
 * Run the Monte Carlo simulation.
 *
 * Each draw perturbs the long-run growth assumptions by a normal sample scaled
 * by the configured volatility, then runs the deterministic engine. Aggregating
 * the resulting income/account paths yields the confidence bands.
 */
export function runMonteCarloFI(
  baseInput: FinancialPlannerProjectionInput,
  config: MonteCarloConfig = DEFAULT_MONTE_CARLO_CONFIG,
): MonteCarloResult {
  const deterministic = buildFinancialPlannerProjection(baseInput);
  const horizon = deterministic.points.length;
  const draws = Math.max(1, Math.round(config.draws));
  const rng = mulberry32(config.seed >>> 0);
  const vol = config.volatility;

  // incomeByYear[i] / accountByYear[i] collect every draw's value at year i.
  const incomeByYear: number[][] = Array.from({ length: horizon }, () => []);
  const accountByYear: number[][] = Array.from({ length: horizon }, () => []);
  const fiYears: number[] = [];
  let successes = 0;

  for (let d = 0; d < draws; d += 1) {
    const drawInput: FinancialPlannerProjectionInput = {
      ...baseInput,
      expectedStockGrowth: clampRate(
        baseInput.expectedStockGrowth + gaussian(rng) * vol.stockGrowth,
        -0.04,
        0.16,
      ),
      expectedDividendGrowth: clampRate(
        baseInput.expectedDividendGrowth + gaussian(rng) * vol.dividendGrowth,
        -0.05,
        0.15,
      ),
      costOfLivingInflation: clampRate(
        baseInput.costOfLivingInflation + gaussian(rng) * vol.inflation,
        -0.01,
        0.1,
      ),
      expectedPropertyAppreciation: clampRate(
        baseInput.expectedPropertyAppreciation + gaussian(rng) * vol.propertyAppreciation,
        -0.05,
        0.12,
      ),
      expectedBondYield: clampRate(
        baseInput.expectedBondYield + gaussian(rng) * vol.bondYield,
        0,
        0.1,
      ),
    };

    const result = buildFinancialPlannerProjection(drawInput);
    result.points.forEach((point, i) => {
      if (i < horizon) {
        incomeByYear[i].push(point.investmentIncome);
        accountByYear[i].push(point.accountValue);
      }
    });

    if (result.summary.fiYear !== null) {
      successes += 1;
      fiYears.push(result.summary.fiYear);
    }
  }

  const bands: MonteCarloBandPoint[] = deterministic.points.map((point, i) => {
    const incomes = [...incomeByYear[i]].sort((a, b) => a - b);
    const accounts = [...accountByYear[i]].sort((a, b) => a - b);
    return {
      year: point.year,
      yearsFromNow: point.yearsFromNow,
      costOfLiving: point.costOfLiving,
      incomeP10: percentile(incomes, 10),
      incomeP50: percentile(incomes, 50),
      incomeP90: percentile(incomes, 90),
      accountP10: percentile(accounts, 10),
      accountP50: percentile(accounts, 50),
      accountP90: percentile(accounts, 90),
    };
  });

  const sortedFiYears = [...fiYears].sort((a, b) => a - b);
  // Optimistic = earliest decile, pessimistic = latest decile.
  const fiYearOptimistic = sortedFiYears.length
    ? Math.round(percentile(sortedFiYears, 10))
    : null;
  const fiYearPessimistic = sortedFiYears.length
    ? Math.round(percentile(sortedFiYears, 90))
    : null;
  const successProbability = successes / draws;
  const fiYearMedian = successProbability >= 0.5 && sortedFiYears.length
    ? Math.round(percentile(sortedFiYears, 50))
    : null;

  return {
    deterministic,
    bands,
    successProbability,
    fiYearMedian,
    fiYearOptimistic,
    fiYearPessimistic,
    draws,
  };
}
