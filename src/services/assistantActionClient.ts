import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';
import type { AssistantBackendActionResponse } from './assistantActionResultTypes';

export async function requestAssistantActionExecute(payload: {
  actionId: string;
  parameters?: Record<string, unknown>;
  runId?: string;
  requestId?: string;
  idempotencyKey?: string;
}): Promise<AssistantBackendActionResponse> {
  const requestId = payload.requestId || payload.idempotencyKey || payload.runId;
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/actions/execute'),
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    {
      'Content-Type': 'application/json',
      ...(requestId ? { 'x-request-id': requestId, 'idempotency-key': payload.idempotencyKey || requestId } : {}),
    },
  );

  if (!response?._httpOk && response?.ok === false) {
    throw new Error(response?.error || `Assistant action failed (${response?._httpStatus || 'unknown'})`);
  }

  return response as AssistantBackendActionResponse;
}

export async function listAssistantBackendActions(): Promise<string[]> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/actions'),
    { method: 'GET' },
  );

  return Array.isArray(response?.actions) ? response.actions : [];
}
