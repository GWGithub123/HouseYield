import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export type AssistantDataLookupAction =
  | 'summarize_account_data'
  | 'list_accessible_collections'
  | 'list_top_level_collections'
  | 'list_subcollections'
  | 'get_document'
  | 'get_field'
  | 'query_collection'
  | 'query_collection_group'
  | 'query_azure_ledger';

export interface AssistantDataLookupFilter {
  field: string;
  op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'array-contains-any' | 'in' | 'not-in';
  value: unknown;
}

export interface AssistantDataLookupOrderBy {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface AssistantDataLookupRequest {
  action: AssistantDataLookupAction;
  documentPath?: string;
  fieldPath?: string;
  collectionPath?: string;
  collectionGroup?: string;
  filters?: AssistantDataLookupFilter[];
  orderBy?: AssistantDataLookupOrderBy[];
  limit?: number;
  propertyId?: string;
  propertyAddress?: string;
  address?: string;
  year?: number;
  taxYear?: number;
  startDate?: string;
  endDate?: string;
  category?: string;
}

export async function requestAssistantDataLookup(payload: AssistantDataLookupRequest) {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/data-lookup'),
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    { 'Content-Type': 'application/json' },
  );

  if (!response?._httpOk || response?.ok === false) {
    throw new Error(response?.error || `Assistant data lookup failed (${response?._httpStatus || 'unknown'})`);
  }

  return response;
}