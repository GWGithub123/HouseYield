import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export type AssistantComputedMetric =
  | 'noi'
  | 'cash_flow'
  | 'cap_rate'
  | 'gross_rent'
  | 'operating_expenses'
  | 'expense_breakdown'
  | 'debt_service'
  | 'equity'
  | 'portfolio_summary';

export interface AssistantComputedAnalyticsRequest {
  metric: AssistantComputedMetric;
  propertyId?: string;
  year?: number;
  taxYear?: number;
  startDate?: string;
  endDate?: string;
}

export async function requestAssistantComputedAnalytics(payload: AssistantComputedAnalyticsRequest) {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/computed-analytics'),
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    { 'Content-Type': 'application/json' },
  );

  if (!response?._httpOk || response?.ok === false) {
    throw new Error(response?.error || `Assistant computed analytics failed (${response?._httpStatus || 'unknown'})`);
  }

  return response;
}
