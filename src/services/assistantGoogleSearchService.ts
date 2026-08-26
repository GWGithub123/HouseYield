import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export interface AssistantGoogleSearchRequest {
  query: string;
  limit?: number;
}

export async function requestAssistantGoogleSearch(payload: AssistantGoogleSearchRequest) {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/google-search'),
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    { 'Content-Type': 'application/json' },
  );

  if (!response?._httpOk || response?.ok === false) {
    throw new Error(response?.error || `Assistant Google search failed (${response?._httpStatus || 'unknown'})`);
  }

  return response;
}