import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export type PersistedAssistantActivity = {
  runId: string;
  actionId: string;
  sequence: number;
  requestSummary?: string;
  status: 'queued' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled';
  needsInput?: boolean;
  result?: unknown;
  actions?: unknown[];
  artifacts?: unknown[];
  error?: string | null;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
};

export async function listAssistantActivities(limit = 50): Promise<PersistedAssistantActivity[]> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl(`/api/assistant/activities?limit=${Math.min(Math.max(limit, 1), 100)}`),
    { method: 'GET' },
  );
  if (!response?._httpOk && response?.ok === false) {
    throw new Error(response?.error || 'Could not load assistant activity.');
  }
  return Array.isArray(response?.activities) ? response.activities : [];
}

export async function updateAssistantActivity(
  runId: string,
  updates: Partial<PersistedAssistantActivity>,
) {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl(`/api/assistant/activities/${encodeURIComponent(runId)}`),
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    },
    { 'Content-Type': 'application/json' },
  );
  if (!response?._httpOk && response?.ok === false) {
    throw new Error(response?.error || 'Could not update assistant activity.');
  }
  return response?.activity as PersistedAssistantActivity | undefined;
}
