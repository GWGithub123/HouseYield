import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export interface AssistantCanonicalContextResponse {
  ok?: boolean;
  promptContext?: string;
  generatedAt?: string;
  sections?: Record<string, unknown>;
  sourceStatus?: Record<string, unknown>;
}

export async function fetchAssistantCanonicalContext(options: {
  includeFinancialDetails?: boolean;
  includeGlobalContext?: boolean;
} = {}): Promise<AssistantCanonicalContextResponse> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/canonical-context'),
    {
      method: 'POST',
      body: JSON.stringify({
        includeFinancialDetails: options.includeFinancialDetails === true,
        includeGlobalContext: options.includeGlobalContext !== false,
      }),
    },
    { 'Content-Type': 'application/json' },
  );

  if (!response?._httpOk || response?.ok !== true) {
    throw new Error(response?.error || response?.message || 'Unable to load assistant canonical context');
  }

  return response as AssistantCanonicalContextResponse;
}