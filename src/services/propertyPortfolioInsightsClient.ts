import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export type PropertyPortfolioAnalysisScope = 'overview' | 'personal' | 'investment' | 'combined';

export interface PropertyPortfolioRecommendation {
  id: string;
  title: string;
  summary: string;
  category: 'refinance' | 'cash_flow' | 'operating_efficiency' | 'rent' | 'concentration' | 'equity';
  severity: 'high' | 'medium' | 'low';
  impact: string;
  confidence: string;
  affectedProperties: string[];
  evidence: string[];
  followUpPrompt: string;
}

export interface PropertyPortfolioConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

const RECOMMENDATION_CATEGORIES = new Set<PropertyPortfolioRecommendation['category']>([
  'refinance',
  'cash_flow',
  'operating_efficiency',
  'rent',
  'concentration',
  'equity',
]);

const RECOMMENDATION_SEVERITIES = new Set<PropertyPortfolioRecommendation['severity']>([
  'high',
  'medium',
  'low',
]);

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function normalizePropertyPortfolioRecommendation(
  input: Partial<PropertyPortfolioRecommendation> & Record<string, unknown>,
): PropertyPortfolioRecommendation {
  const category = RECOMMENDATION_CATEGORIES.has(input.category as PropertyPortfolioRecommendation['category'])
    ? input.category as PropertyPortfolioRecommendation['category']
    : 'equity';
  const severity = RECOMMENDATION_SEVERITIES.has(input.severity as PropertyPortfolioRecommendation['severity'])
    ? input.severity as PropertyPortfolioRecommendation['severity']
    : 'medium';

  return {
    id: String(input.id || `rec-${Math.random().toString(36).slice(2, 10)}`),
    title: String(input.title || 'Portfolio recommendation'),
    summary: String(input.summary || ''),
    category,
    severity,
    impact: String(input.impact || ''),
    confidence: String(input.confidence || 'Medium'),
    affectedProperties: asStringArray(input.affectedProperties),
    evidence: asStringArray(input.evidence),
    followUpPrompt: String(input.followUpPrompt || 'Ask a follow-up question about this recommendation.'),
  };
}

export function normalizePropertyPortfolioAnalysis(
  analysis: PropertyPortfolioAnalysisResult,
): PropertyPortfolioAnalysisResult {
  return {
    ...analysis,
    recommendations: (Array.isArray(analysis.recommendations) ? analysis.recommendations : [])
      .map((recommendation) => normalizePropertyPortfolioRecommendation(recommendation)),
  };
}

export interface PropertyPortfolioAnalysisResult {
  generatedAt: string;
  scope: PropertyPortfolioAnalysisScope;
  summary: {
    propertyCount: number;
    totalValue: number;
    totalEquity: number;
    annualGrossIncome: number;
    annualNetCashFlow: number;
    averageMortgageRate: number;
    currentMarketMortgageRate: number | null;
  };
  narrative: string;
  recommendations: PropertyPortfolioRecommendation[];
  sourceStatus: {
    firestore: { ok: boolean; propertyCount: number };
    azure: { ok: boolean; propertyCount: number; ledgerEntries: number };
    openai: { ok: boolean; model?: string; warning?: string | null };
  };
}

export async function fetchPropertyPortfolioAnalysis(
  scope: PropertyPortfolioAnalysisScope,
): Promise<PropertyPortfolioAnalysisResult> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/property-portfolio-analysis'),
    {
      method: 'POST',
      body: JSON.stringify({ scope }),
    },
    { 'Content-Type': 'application/json' },
  );

  if (response.ok === false || response._httpOk === false) {
    throw new Error(response.error || 'Unable to load property portfolio analysis');
  }

  return normalizePropertyPortfolioAnalysis(response.analysis as PropertyPortfolioAnalysisResult);
}

export async function askPropertyPortfolioFollowUp(input: {
  scope: PropertyPortfolioAnalysisScope;
  question: string;
  recommendationId?: string | null;
  history?: PropertyPortfolioConversationTurn[];
}) {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/property-portfolio-analysis/follow-up'),
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    { 'Content-Type': 'application/json' },
  );

  if (response.ok === false || response._httpOk === false) {
    throw new Error(response.error || 'Unable to complete property portfolio follow-up');
  }

  return response;
}
