import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export type AssistantScheduledTaskStatus =
  | 'scheduled'
  | 'paused'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface AssistantScheduledTask {
  id: string;
  title: string;
  notes?: string;
  runAt: string;
  timeZone?: string;
  status: AssistantScheduledTaskStatus;
  kind?: 'action' | 'reminder' | string;
  actionId?: string | null;
  parameters?: Record<string, unknown>;
  propertyId?: string | null;
  propertyAddress?: string | null;
  tenantId?: string | null;
  tenantName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  lastError?: string | null;
  resultSummary?: string | null;
}

export type AssistantScheduledTaskUpdate = {
  title?: string;
  notes?: string;
  status?: AssistantScheduledTaskStatus;
  runAt?: string;
  when?: string;
  scheduledFor?: string;
  date?: string;
  time?: string;
  timeZone?: string;
  actionId?: string | null;
  parameters?: Record<string, unknown>;
  resultSummary?: string | null;
  lastError?: string | null;
};

async function parseTaskResponse(response: any, fallbackError: string): Promise<AssistantScheduledTask> {
  if (!response?.ok || !response?.task) {
    throw new Error(response?.error || fallbackError);
  }
  return response.task as AssistantScheduledTask;
}

export async function listAssistantScheduledTasks(options: {
  includeCompleted?: boolean;
  limit?: number;
} = {}): Promise<AssistantScheduledTask[]> {
  const params = new URLSearchParams();
  if (options.includeCompleted) params.set('includeCompleted', 'true');
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl(`/api/assistant/scheduled-tasks${query ? `?${query}` : ''}`),
    { method: 'GET' },
  );
  if (response?.ok === false) {
    throw new Error(response?.error || 'Failed to load scheduled tasks');
  }
  return Array.isArray(response?.tasks) ? response.tasks : [];
}

export async function createAssistantScheduledTask(payload: {
  title: string;
  notes?: string;
  when?: string;
  runAt?: string;
  date?: string;
  time?: string;
  actionId?: string | null;
  parameters?: Record<string, unknown>;
  propertyAddress?: string;
  propertyId?: string;
  tenantName?: string;
  tenantId?: string;
  kind?: string;
}): Promise<AssistantScheduledTask> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/scheduled-tasks'),
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    { 'Content-Type': 'application/json' },
  );
  return parseTaskResponse(response, 'Failed to create scheduled task');
}

export async function updateAssistantScheduledTask(
  taskId: string,
  updates: AssistantScheduledTaskUpdate,
): Promise<AssistantScheduledTask> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl(`/api/assistant/scheduled-tasks/${encodeURIComponent(taskId)}`),
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    },
    { 'Content-Type': 'application/json' },
  );
  return parseTaskResponse(response, 'Failed to update scheduled task');
}

export async function pauseAssistantScheduledTask(taskId: string): Promise<AssistantScheduledTask> {
  return updateAssistantScheduledTask(taskId, { status: 'paused' });
}

export async function resumeAssistantScheduledTask(taskId: string): Promise<AssistantScheduledTask> {
  return updateAssistantScheduledTask(taskId, { status: 'scheduled', lastError: null });
}

export async function retryAssistantScheduledTask(taskId: string): Promise<AssistantScheduledTask> {
  return updateAssistantScheduledTask(taskId, {
    status: 'scheduled',
    lastError: null,
    resultSummary: null,
  });
}

export async function rescheduleAssistantScheduledTask(
  taskId: string,
  when: string,
): Promise<AssistantScheduledTask> {
  return updateAssistantScheduledTask(taskId, {
    when,
    status: 'scheduled',
    lastError: null,
  });
}

export async function cancelAssistantScheduledTask(taskId: string): Promise<AssistantScheduledTask> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl(`/api/assistant/scheduled-tasks/${encodeURIComponent(taskId)}/cancel`),
    { method: 'POST', body: JSON.stringify({}) },
    { 'Content-Type': 'application/json' },
  );
  return parseTaskResponse(response, 'Failed to cancel task');
}

export async function deleteAssistantScheduledTask(taskId: string): Promise<void> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl(`/api/assistant/scheduled-tasks/${encodeURIComponent(taskId)}`),
    { method: 'DELETE' },
  );
  if (response?.ok === false) {
    throw new Error(response?.error || 'Failed to delete task');
  }
}

export function formatScheduledTaskWhen(runAt: string): string {
  const date = new Date(runAt);
  if (Number.isNaN(date.getTime())) return runAt;
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
