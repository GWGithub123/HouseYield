/**
 * Finance audit assistant client.
 *
 * Talks to the server-side finance audit assistant
 * (server/finance-audit-assistant.js, mounted at /api/finance-audit):
 *   GET  /api/finance-audit/rules-sources?year=YYYY
 *   POST /api/finance-audit/ask
 *
 * The rules-sources call has a full static fallback built from
 * src/shared/taxRules.js so the audit rail can always render the rules
 * package even when the backend route is unreachable.
 */

import {
  getTaxRulesetPackage,
  getTaxRulesGovernanceStatus,
} from '../shared/taxRules.js';
import { buildOwnerFinanceUrl, getOwnerFinanceHeaders } from './ownerFinanceApi';

export type FinanceAuditSurface = 'tax' | 'bookkeeping';

export interface FinanceAuditRuleSource {
  id?: string;
  title: string;
  url?: string | null;
  authority?: string;
  appliesTo?: string | null;
  lastUpdated?: string | null;
}

export interface FinanceAuditRulesGovernance {
  stalenessStatus?: string;
  freshnessStatus?: string;
  approvalStatus?: string;
  lastReviewed?: string | null;
  notes?: string[];
  warnings?: string[];
  coverageStatus?: string;
}

export interface FinanceAuditRulesSources {
  taxYear: number;
  rulesVersion: string;
  approvalStatus: string;
  governance: FinanceAuditRulesGovernance;
  sources: FinanceAuditRuleSource[];
  disclaimer?: string;
  /** Where this payload came from: live endpoint or static client fallback. */
  origin: 'endpoint' | 'static-fallback';
}

export interface FinanceAuditAction {
  type: 'scrollTo';
  sectionId: string;
}

export interface FinanceAuditSectionRef {
  id: string;
  title: string;
  description?: string;
}

export interface FinanceAuditAnswer {
  answer: string;
  bullets: string[];
  sources: FinanceAuditRuleSource[];
  /** Navigation actions referencing sections the page registered with the ask call. */
  actions: FinanceAuditAction[];
  rulesVersion?: string;
  taxYear?: number;
  confidence?: 'high' | 'medium' | 'low';
  disclaimer?: string;
  /** Human-readable summaries of the canonical ledger queries the assistant ran. */
  dataUsed?: string[];
  /** Whether the answer was verified against the canonical Azure ledger. */
  ledgerStatus?: 'checked' | 'not_needed' | 'unavailable' | 'not_connected';
}

export class FinanceAuditAskError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'FinanceAuditAskError';
    this.code = code;
  }
}

function buildStaticRulesSources(year: number): FinanceAuditRulesSources {
  const pkg = getTaxRulesetPackage(year) as Record<string, any>;
  const governance = (pkg?.governance || getTaxRulesGovernanceStatus(year)) as Record<string, any>;
  const sourceDocuments = Array.isArray(pkg?.sourceDocuments) ? pkg.sourceDocuments : [];

  return {
    taxYear: Number(pkg?.taxYear) || year,
    rulesVersion: String(pkg?.rulesVersion || 'unknown'),
    approvalStatus: String(pkg?.approvalStatus || 'unknown'),
    governance: {
      freshnessStatus: governance?.freshnessStatus,
      coverageStatus: governance?.coverageStatus,
      approvalStatus: governance?.approvalStatus,
      lastReviewed: governance?.lastReviewedAt || pkg?.lastReviewedAt || null,
      warnings: Array.isArray(governance?.warnings) ? governance.warnings : [],
    },
    sources: sourceDocuments.map((doc: Record<string, any>) => ({
      id: doc.id,
      title: doc.title,
      url: doc.url || null,
      authority: doc.authority || 'IRS',
      appliesTo: doc.scope || null,
      lastUpdated: doc.pageUpdatedAt || doc.lastReviewedAt || null,
    })),
    origin: 'static-fallback',
  };
}

/**
 * Fetch the structured IRS rules source list (with governance/freshness) for
 * the audit rail. Falls back to the static taxRules.js package when the
 * endpoint is unavailable, so callers always get a renderable payload.
 */
export async function getFinanceAuditRulesSources(year: number): Promise<FinanceAuditRulesSources> {
  try {
    const headers = await getOwnerFinanceHeaders().catch(() => null);
    const response = await fetch(
      buildOwnerFinanceUrl(`/api/finance-audit/rules-sources?year=${encodeURIComponent(year)}`),
      headers ? { headers } : undefined,
    );
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok || !Array.isArray(payload.sources) || payload.sources.length === 0) {
      return buildStaticRulesSources(year);
    }

    const governance = payload.governance || {};
    return {
      taxYear: Number(payload.taxYear) || year,
      rulesVersion: String(payload.rulesVersion || 'unknown'),
      approvalStatus: String(payload.approvalStatus || governance.approvalStatus || 'unknown'),
      governance: {
        stalenessStatus: governance.stalenessStatus,
        freshnessStatus: governance.freshnessStatus,
        approvalStatus: governance.approvalStatus,
        lastReviewed: governance.lastReviewed || null,
        notes: Array.isArray(governance.notes) ? governance.notes : [],
        warnings: Array.isArray(governance.warnings) ? governance.warnings : [],
      },
      sources: payload.sources.map((source: Record<string, any>) => ({
        id: source.id,
        title: source.title,
        url: source.url || null,
        authority: source.authority || 'IRS',
        appliesTo: source.appliesTo || null,
        lastUpdated: source.lastUpdated || null,
      })),
      disclaimer: payload.disclaimer,
      origin: 'endpoint',
    };
  } catch {
    return buildStaticRulesSources(year);
  }
}

/**
 * Ask the finance audit assistant a free-form question, grounded in the audit
 * snapshot context the calling page already has.
 */
export async function askFinanceAudit({
  surface,
  question,
  context = {},
  sections,
}: {
  surface: FinanceAuditSurface;
  question: string;
  context?: Record<string, unknown>;
  /** Navigable page sections; lets the assistant return scrollTo actions. */
  sections?: FinanceAuditSectionRef[];
}): Promise<FinanceAuditAnswer> {
  const headers = await getOwnerFinanceHeaders({ 'Content-Type': 'application/json' }).catch(() => null);

  let response: Response;
  try {
    response = await fetch(buildOwnerFinanceUrl('/api/finance-audit/ask'), {
      method: 'POST',
      headers: headers || { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface, question, context, sections }),
    });
  } catch {
    throw new FinanceAuditAskError(
      'Could not reach the audit assistant. Check that the server is running and try again.',
      'network_error',
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    const code = payload?.code as string | undefined;
    const message = code === 'gemini_not_configured'
      ? 'The AI assistant is not configured on this server yet (missing Gemini API key). Ask your administrator to set GEMINI_API_KEY.'
      : payload?.error || `The audit assistant request failed (${response.status}).`;
    throw new FinanceAuditAskError(message, code);
  }

  return {
    answer: String(payload.answer || ''),
    bullets: Array.isArray(payload.bullets) ? payload.bullets.filter(Boolean) : [],
    sources: Array.isArray(payload.sources)
      ? payload.sources
        .filter((source: Record<string, any>) => source && (source.title || source.url))
        .map((source: Record<string, any>) => ({
          id: source.id,
          title: source.title || source.url,
          url: source.url || null,
          authority: source.authority || 'Source',
          appliesTo: source.appliesTo || null,
          lastUpdated: source.lastUpdated || null,
        }))
      : [],
    actions: Array.isArray(payload.actions)
      ? payload.actions
        .filter((action: Record<string, any>) => action && action.type === 'scrollTo' && typeof action.sectionId === 'string')
        .map((action: Record<string, any>) => ({ type: 'scrollTo' as const, sectionId: action.sectionId }))
      : [],
    rulesVersion: payload.rulesVersion,
    taxYear: payload.taxYear,
    confidence: payload.confidence,
    disclaimer: payload.disclaimer,
    dataUsed: Array.isArray(payload.dataUsed)
      ? payload.dataUsed.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      : [],
    ledgerStatus: ['checked', 'not_needed', 'unavailable', 'not_connected'].includes(payload.ledgerStatus)
      ? payload.ledgerStatus
      : undefined,
  };
}

/**
 * Fetch a one-line AI page summary for the assistant header. Returns null on
 * any failure so callers can fall back to a deterministic local summary.
 */
export async function fetchFinanceAuditSummary({
  surface,
  context = {},
}: {
  surface: FinanceAuditSurface;
  context?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const headers = await getOwnerFinanceHeaders({ 'Content-Type': 'application/json' }).catch(() => null);
    const response = await fetch(buildOwnerFinanceUrl('/api/finance-audit/ask'), {
      method: 'POST',
      headers: headers || { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface, context, mode: 'summary', question: 'summary' }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || typeof payload.summary !== 'string' || !payload.summary.trim()) {
      return null;
    }
    return payload.summary.trim();
  } catch {
    return null;
  }
}

export interface FinanceMetricExplanation {
  explanation: string;
  bullets: string[];
  confidence?: 'high' | 'medium' | 'low';
  aiGenerated: boolean;
  disclaimer?: string;
  warning?: string;
}

function buildStaticMetricExplanation(detail: string, citations: string[]): FinanceMetricExplanation {
  return {
    explanation: detail,
    bullets: citations.slice(0, 4),
    confidence: 'medium',
    aiGenerated: false,
  };
}

/**
 * Ask the server to explain one KPI/metric card. Always returns a usable
 * payload — callers should treat null as "keep the local static copy."
 */
export async function explainFinanceMetric({
  surface,
  metricId,
  label,
  value,
  detail,
  citations,
}: {
  surface: FinanceAuditSurface;
  metricId: string;
  label: string;
  value: string;
  detail: string;
  citations: string[];
}): Promise<FinanceMetricExplanation | null> {
  const staticFallback = buildStaticMetricExplanation(detail, citations);

  const headers = await getOwnerFinanceHeaders({ 'Content-Type': 'application/json' }).catch(() => null);
  if (!headers) {
    return staticFallback;
  }

  let response: Response;
  try {
    response = await fetch(buildOwnerFinanceUrl('/api/bookkeeping/firestore/explain-metric'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        surface,
        metricId,
        label,
        value,
        detail,
        citations,
      }),
    });
  } catch {
    return staticFallback;
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || typeof payload.explanation !== 'string' || !payload.explanation.trim()) {
    return staticFallback;
  }

  return {
    explanation: payload.explanation.trim(),
    bullets: Array.isArray(payload.bullets)
      ? payload.bullets.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 4)
      : staticFallback.bullets,
    confidence: ['high', 'medium', 'low'].includes(payload.confidence) ? payload.confidence : 'medium',
    aiGenerated: Boolean(payload.aiGenerated),
    disclaimer: typeof payload.disclaimer === 'string' ? payload.disclaimer : undefined,
    warning: typeof payload.warning === 'string' ? payload.warning : undefined,
  };
}

export default {
  getFinanceAuditRulesSources,
  askFinanceAudit,
  fetchFinanceAuditSummary,
  explainFinanceMetric,
};
