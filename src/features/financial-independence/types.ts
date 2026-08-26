/**
 * Shared view-model contracts for the redesigned Financial Independence feature.
 * Presentational components depend only on these, so the App.tsx wiring layer
 * can shape data however it likes without coupling the UI to App state.
 */

import type {
  FinancialPlannerProjectionPoint,
  FinancialPlannerProjectionSummary,
  AIAction,
  RetirementScenario,
} from '../../services/aiFinancialPlannerService';
import type { MonteCarloBandPoint } from './engine/monteCarlo';
import type { FISpectrumThreshold } from './engine/fiSpectrum';

export type { MonteCarloBandPoint, FISpectrumThreshold };

/** Headline "when do I reach FI" verdict. */
export interface FIVerdict {
  currentYear: number;
  fiYearDeterministic: number | null;
  fiYearMedian: number | null;
  fiYearOptimistic: number | null;
  fiYearPessimistic: number | null;
  successProbability: number; // 0..1
  ageAtFi: number | null;
}

/** A single adjustable lever in the right rail. */
export interface FILever {
  id: string;
  label: string;
  /** Optional grouping header (e.g. "Spending", "Growth", "Timing"). */
  group?: string;
  /** Raw underlying value (e.g. dollars, or a fraction like 0.07). */
  value: number;
  min: number;
  max: number;
  step: number;
  /** How to render the value to the user. */
  format: 'currency' | 'percent' | 'year' | 'number';
  /** Optional helper line. */
  hint?: string;
  /** Marks the value as coming from a live connected data source. */
  connected?: boolean;
  onChange: (next: number) => void;
}

/** Milestone pinned on the simulation timeline. */
export interface FIMilestone {
  year: number;
  label: string;
  kind: 'retirement' | 'propertyPurchase' | 'propertySale' | 'bigPurchase' | 'scenario' | 'fi';
  description?: string;
}

/** A proactive AI nudge card. */
export interface FINudge {
  id: string;
  headline: string;
  detail: string;
  /** Estimated FI-year delta if applied (negative = sooner). */
  impactYears?: number | null;
  actions: AIAction[];
  applyLabel?: string;
}

export interface FIScenarioSummary {
  id: string;
  name: string;
  fiYear: number | null;
  source: RetirementScenario['source'];
  applied: boolean;
  active: boolean;
}

export interface FISimulation {
  bands: MonteCarloBandPoint[];
  points: FinancialPlannerProjectionPoint[];
  summary: FinancialPlannerProjectionSummary;
  spectrum: FISpectrumThreshold[];
  verdict: FIVerdict;
}
