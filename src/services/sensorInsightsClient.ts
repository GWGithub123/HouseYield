/**
 * Sensor insights assistant client.
 *
 * Talks to server/routes/sensor-insights.js (mounted at /api/sensor-insights):
 *   POST /api/sensor-insights/ask
 *
 * Same transport pattern as financeAuditClient: page builds a context
 * snapshot of what the user is looking at, and the assistant answers
 * grounded in that snapshot.
 */

import { buildOwnerFinanceUrl, getOwnerFinanceHeaders } from './ownerFinanceApi';

export interface SensorInsightsTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface SensorInsightsAnswer {
  answer: string;
  bullets: string[];
  confidence?: 'high' | 'medium' | 'low';
}

export class SensorInsightsError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SensorInsightsError';
    this.code = code;
  }
}

function extractJson(text: string) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeAnswerPayload(payload: any): SensorInsightsAnswer {
  let answer = String(payload?.answer || '');
  let bullets = Array.isArray(payload?.bullets)
    ? payload.bullets.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
    : [];

  // Defensive fallback: if the backend answer still contains a JSON blob,
  // unwrap it before rendering so the UI never shows raw object text.
  const nested = extractJson(answer);
  if (nested) {
    answer = typeof nested.answer === 'string' ? nested.answer : answer;
    bullets = Array.isArray(nested.bullets)
      ? nested.bullets.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      : bullets;
  }

  // If a partial JSON fragment still slips through, strip the common wrapper.
  answer = answer
    .replace(/^\s*\{\s*"answer"\s*:\s*/i, '')
    .replace(/,\s*"bullets"\s*:\s*\[[\s\S]*$/i, '')
    .replace(/^"+|"+$/g, '')
    .trim();

  return {
    answer,
    bullets,
    confidence: ['high', 'medium', 'low'].includes(payload?.confidence) ? payload.confidence : undefined,
  };
}

export async function askSensorInsights({
  mode,
  question,
  context = {},
  history = [],
}: {
  mode: 'overview' | 'qa';
  question?: string;
  context?: Record<string, unknown>;
  history?: SensorInsightsTurn[];
}): Promise<SensorInsightsAnswer> {
  const headers = await getOwnerFinanceHeaders({ 'Content-Type': 'application/json' }).catch(() => null);

  let response: Response;
  try {
    response = await fetch(buildOwnerFinanceUrl('/api/sensor-insights/ask'), {
      method: 'POST',
      headers: headers || { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, question, context, history }),
    });
  } catch {
    throw new SensorInsightsError(
      'Could not reach the AI assistant. Check that the server is running and try again.',
      'network_error',
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    const code = payload?.code as string | undefined;
    const message = response.status === 404
      ? 'The AI assistant route is not loaded on the backend yet. Restart the local backend/dev server and try again.'
      : code === 'gemini_not_configured'
        ? 'The AI assistant is not configured on this server yet (missing Gemini API key).'
        : payload?.error || `The AI assistant request failed (${response.status}).`;
    throw new SensorInsightsError(message, code);
  }

  return normalizeAnswerPayload(payload);
}

export default { askSensorInsights };
