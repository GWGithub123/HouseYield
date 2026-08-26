import {
  getCurrentUserProfile,
  updateUserProfileFields,
} from './firebaseService';
import type {
  FinancialContext,
  FinancialPlannerDraftScenario,
} from './aiFinancialPlannerService';

export interface FinancialPlannerSnapshot {
  financialContext: FinancialContext;
  projectionSummary?: FinancialContext['projectionSummary'];
  projectionPoints?: FinancialContext['projectionPoints'];
  cachedAt: number;
}

export interface FinancialPlannerWorkspace {
  snapshot: FinancialPlannerSnapshot | null;
  draftScenarios: FinancialPlannerDraftScenario[];
  updatedAt: string | null;
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined)
      .map((entry) => stripUndefinedDeep(entry)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((accumulator, [key, entry]) => {
      if (entry === undefined) {
        return accumulator;
      }

      accumulator[key] = stripUndefinedDeep(entry);
      return accumulator;
    }, {}) as T;
  }

  return value;
}

export async function loadFinancialPlannerWorkspace(): Promise<FinancialPlannerWorkspace> {
  const profile = await getCurrentUserProfile();

  return {
    snapshot: (profile?.financialPlannerSnapshot as unknown as FinancialPlannerSnapshot | null) || null,
    draftScenarios: Array.isArray(profile?.financialPlannerDraftScenarios)
      ? (profile?.financialPlannerDraftScenarios as unknown as FinancialPlannerDraftScenario[])
      : [],
    updatedAt: profile?.financialPlannerWorkspaceUpdatedAt || null,
  };
}

export async function saveFinancialPlannerSnapshot(
  userId: string,
  snapshot: FinancialPlannerSnapshot,
): Promise<{ success: boolean; error?: string }> {
  return updateUserProfileFields(userId, {
    financialPlannerSnapshot: stripUndefinedDeep(snapshot) as unknown as Record<string, unknown>,
    financialPlannerWorkspaceUpdatedAt: new Date().toISOString(),
  });
}

export async function saveFinancialPlannerDraftScenarios(
  userId: string,
  draftScenarios: FinancialPlannerDraftScenario[],
): Promise<{ success: boolean; error?: string }> {
  return updateUserProfileFields(userId, {
    financialPlannerDraftScenarios: stripUndefinedDeep(draftScenarios) as unknown as Array<Record<string, unknown>>,
    financialPlannerWorkspaceUpdatedAt: new Date().toISOString(),
  });
}