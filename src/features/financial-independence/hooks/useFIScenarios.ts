import { useCallback, useEffect, useState } from 'react';
import {
  type RetirementScenario,
  getScenarios,
  saveScenario,
  deleteScenario,
  generateScenarioId,
} from '../../../services/aiFinancialPlannerService';

interface UseFIScenariosResult {
  scenarios: RetirementScenario[];
  loading: boolean;
  saving: boolean;
  save: (params: {
    name: string;
    parameters: RetirementScenario['parameters'];
    timelineHints?: RetirementScenario['timelineHints'];
    fiYear: number | null;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/**
 * Loads and mutates the user's saved retirement scenarios via the existing
 * aiFinancialPlannerService. Mirrors the persistence used by
 * RetirementScenarioSelector so both stay in sync on next mount.
 */
export function useFIScenarios(userId: string | null | undefined): UseFIScenariosResult {
  const [scenarios, setScenarios] = useState<RetirementScenario[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setScenarios([]);
      return;
    }
    setLoading(true);
    void getScenarios(userId)
      .then((stored) => {
        if (!cancelled) setScenarios(stored);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const save = useCallback<UseFIScenariosResult['save']>(
    async ({ name, parameters, timelineHints, fiYear }) => {
      if (!userId || !name.trim()) return;
      setSaving(true);
      try {
        const scenario: RetirementScenario = {
          id: generateScenarioId(),
          name: name.trim(),
          createdAt: Date.now(),
          timelineHints: (timelineHints ?? []).map((hint) => ({ ...hint })),
          parameters: { ...parameters },
          fiYear,
          source: 'manual',
        };
        const updated = await saveScenario(userId, scenario);
        setScenarios(updated);
      } finally {
        setSaving(false);
      }
    },
    [userId],
  );

  const remove = useCallback<UseFIScenariosResult['remove']>(
    async (id) => {
      if (!userId) return;
      const updated = await deleteScenario(userId, id);
      setScenarios(updated);
    },
    [userId],
  );

  return { scenarios, loading, saving, save, remove };
}
