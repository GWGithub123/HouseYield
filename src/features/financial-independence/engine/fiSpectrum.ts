/**
 * FI spectrum — the different "flavours" of financial independence.
 *
 * Rather than a single FI number, modern FI planning recognises a spectrum:
 *  - Coast FI   : enough invested today that growth alone reaches Full FI by a
 *                 target year, with no further contributions.
 *  - Barista FI : portfolio covers part of expenses; part-time work covers rest.
 *  - Lean FI    : Full FI on a frugal (reduced) expense budget.
 *  - Full FI    : the classic 4%-rule number for current expenses.
 *  - Fat FI     : a comfortable cushion above Full FI.
 *
 * All numbers are portfolio (4%-rule) based, complementing the income-based
 * crossover the deterministic engine already computes.
 */

import type { FinancialPlannerProjectionPoint } from '../../../services/aiFinancialPlannerService';

export type FISpectrumId = 'coast' | 'barista' | 'lean' | 'full' | 'fat';

export interface FISpectrumThreshold {
  id: FISpectrumId;
  label: string;
  description: string;
  /** Portfolio (account) value required to satisfy this threshold today. */
  targetPortfolio: number;
  /** First projected year the account value reaches the target, else null. */
  crossedYear: number | null;
  /** Years from now until crossed, else null. */
  yearsAway: number | null;
  reached: boolean;
}

export interface FISpectrumInput {
  /** Current annual cost of living (already reduced by any spending cut). */
  annualExpenses: number;
  /** Safe withdrawal rate (e.g. 0.04). */
  safeWithdrawalRate: number;
  /** Expected real portfolio growth used for the Coast FI discount. */
  growthRate: number;
  /** Year Coast FI is measured against (e.g. a traditional retirement year). */
  coastTargetYear: number;
  /** Current calendar year. */
  currentYear: number;
  /** Fraction of expenses a Barista FI portfolio should cover (default 0.5). */
  baristaCoverage?: number;
  /** Fraction of expenses Lean FI targets (default 0.7). */
  leanFraction?: number;
  /** Multiple of Full FI for Fat FI (default 1.5). */
  fatMultiple?: number;
}

const FALLBACK_SWR = 0.04;

function firstCrossingYear(
  points: FinancialPlannerProjectionPoint[],
  targetPortfolio: number,
): { crossedYear: number | null; yearsAway: number | null } {
  if (targetPortfolio <= 0) {
    const first = points[0];
    return first
      ? { crossedYear: first.year, yearsAway: 0 }
      : { crossedYear: null, yearsAway: null };
  }
  for (const point of points) {
    if (point.accountValue >= targetPortfolio) {
      return { crossedYear: point.year, yearsAway: point.yearsFromNow };
    }
  }
  return { crossedYear: null, yearsAway: null };
}

export function computeFISpectrum(
  points: FinancialPlannerProjectionPoint[],
  input: FISpectrumInput,
): FISpectrumThreshold[] {
  const swr = input.safeWithdrawalRate > 0 ? input.safeWithdrawalRate : FALLBACK_SWR;
  const annualExpenses = Math.max(0, input.annualExpenses);
  const baristaCoverage = input.baristaCoverage ?? 0.5;
  const leanFraction = input.leanFraction ?? 0.7;
  const fatMultiple = input.fatMultiple ?? 1.5;

  const fullTarget = annualExpenses / swr;
  const leanTarget = (annualExpenses * leanFraction) / swr;
  const baristaTarget = (annualExpenses * baristaCoverage) / swr;
  const fatTarget = fullTarget * fatMultiple;

  // Coast FI: the amount today that, compounding at growthRate until the
  // coast target year, equals the Full FI number.
  const yearsToCoastTarget = Math.max(0, input.coastTargetYear - input.currentYear);
  const growth = Number.isFinite(input.growthRate) ? input.growthRate : 0.05;
  const coastTarget = fullTarget / Math.pow(1 + Math.max(-0.5, growth), yearsToCoastTarget);

  const definitions: Array<Omit<FISpectrumThreshold, 'crossedYear' | 'yearsAway' | 'reached'>> = [
    {
      id: 'coast',
      label: 'Coast FI',
      description: 'Invested enough that growth alone reaches Full FI by your target — no new contributions needed.',
      targetPortfolio: coastTarget,
    },
    {
      id: 'barista',
      label: 'Barista FI',
      description: `Portfolio covers ${Math.round(baristaCoverage * 100)}% of expenses; light part-time work covers the rest.`,
      targetPortfolio: baristaTarget,
    },
    {
      id: 'lean',
      label: 'Lean FI',
      description: `Full independence on a frugal budget (${Math.round(leanFraction * 100)}% of current spend).`,
      targetPortfolio: leanTarget,
    },
    {
      id: 'full',
      label: 'Full FI',
      description: 'The classic 4%-rule number covering your current expenses indefinitely.',
      targetPortfolio: fullTarget,
    },
    {
      id: 'fat',
      label: 'Fat FI',
      description: `A comfortable ${fatMultiple}× cushion above Full FI.`,
      targetPortfolio: fatTarget,
    },
  ];

  return definitions.map((definition) => {
    const { crossedYear, yearsAway } = firstCrossingYear(points, definition.targetPortfolio);
    return {
      ...definition,
      crossedYear,
      yearsAway,
      reached: crossedYear !== null,
    };
  });
}
