import { getOwnerFinanceHeaders } from './ownerFinanceApi';

const isAccessedViaTunnel = typeof window !== 'undefined' && (
  window.location.hostname.includes('ngrok') ||
  window.location.hostname.includes('trycloudflare.com')
);

const BACKEND_URL = isAccessedViaTunnel ? '' : (import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001');

export interface AiChatRequest {
  model?: string;
  messages: unknown[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: string };
  assistantContext?: {
    mode?: 'canonical';
    includeGlobalContext?: boolean;
    includeFinancialDetails?: boolean;
  };
}

export async function requestAiChatCompletion(
  payload: AiChatRequest,
  options: {
    authenticated?: boolean;
  } = {},
) {
  const requiresAuth = options.authenticated === true || payload.assistantContext?.mode === 'canonical';
  const headers = requiresAuth
    ? await getOwnerFinanceHeaders({ 'Content-Type': 'application/json' })
    : { 'Content-Type': 'application/json' };

  if (!headers) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(`${BACKEND_URL}/api/ai/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `AI chat request failed with status ${response.status}`);
  }

  return response.json();
}

export async function requestAssistantChatCompletion(
  payload: AiChatRequest,
  assistantContext: {
    includeGlobalContext?: boolean;
    includeFinancialDetails?: boolean;
  } = {},
) {
  return requestAiChatCompletion(
    {
      ...payload,
      assistantContext: {
        mode: 'canonical',
        includeGlobalContext: assistantContext.includeGlobalContext !== false,
        includeFinancialDetails: assistantContext.includeFinancialDetails === true,
      },
    },
    { authenticated: true },
  );
}