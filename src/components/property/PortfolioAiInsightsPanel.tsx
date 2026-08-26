import React, { useEffect, useMemo, useState } from 'react';
import {
  askPropertyPortfolioFollowUp,
  fetchPropertyPortfolioAnalysis,
  type PropertyPortfolioAnalysisResult,
  type PropertyPortfolioAnalysisScope,
  type PropertyPortfolioConversationTurn,
  type PropertyPortfolioRecommendation,
  normalizePropertyPortfolioAnalysis,
  normalizePropertyPortfolioRecommendation,
} from '../../services/propertyPortfolioInsightsClient';
import type { PropertyPortfolioOverview } from '../../services/canonicalPortfolioService';
import { formatCurrency } from '../../utils/formatting';
import { requestAssistantChatCompletion } from '../../services/aiChatProxy';
import { X } from 'lucide-react';

const toneClasses: Record<PropertyPortfolioRecommendation['severity'], string> = {
  high: 'bg-rose-100 text-rose-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-emerald-100 text-emerald-700',
};

function buildFallbackRecommendations(overview: PropertyPortfolioOverview): PropertyPortfolioRecommendation[] {
  const recommendations: PropertyPortfolioRecommendation[] = [];
  const highestExpense = [...overview.properties]
    .sort((left, right) => right.derived.monthlyExpenses - left.derived.monthlyExpenses)[0];
  const weakestCashFlow = [...overview.properties]
    .sort((left, right) => left.derived.monthlyCashFlow - right.derived.monthlyCashFlow)[0];
  const refinanceCandidate = [...overview.properties]
    .filter((property) => property.derived.mortgageBalance > 0 && property.financials.interestRate > 0)
    .sort((left, right) => right.financials.interestRate - left.financials.interestRate)[0];

  if (refinanceCandidate) {
    recommendations.push({
      id: `fallback-refi-${refinanceCandidate.id}`,
      title: `Review refinance options for ${refinanceCandidate.address || 'this property'}`,
      summary: `${refinanceCandidate.address || 'This property'} carries the highest modeled interest rate in the current portfolio set.`,
      category: 'refinance',
      severity: 'medium',
      impact: `${refinanceCandidate.financials.interestRate.toFixed(2)}% current rate on ${formatCurrency(refinanceCandidate.derived.mortgageBalance)} of debt.`,
      confidence: 'Medium',
      affectedProperties: [refinanceCandidate.address || 'Property'],
      evidence: [
        `${formatCurrency(refinanceCandidate.derived.mortgageBalance)} mortgage balance`,
        `${refinanceCandidate.financials.interestRate.toFixed(2)}% interest rate`,
        `${formatCurrency(refinanceCandidate.derived.monthlyMortgage)}/mo debt service`,
      ],
      followUpPrompt: `Would refinancing ${refinanceCandidate.address || 'this property'} improve cash flow enough to matter?`,
    });
  }

  if (weakestCashFlow && weakestCashFlow.derived.monthlyCashFlow <= 0) {
    recommendations.push({
      id: `fallback-cashflow-${weakestCashFlow.id}`,
      title: `Stabilize cash flow at ${weakestCashFlow.address || 'this property'}`,
      summary: `${weakestCashFlow.address || 'This property'} is the weakest cash-flow performer in the current portfolio.`,
      category: 'cash_flow',
      severity: 'high',
      impact: `${formatCurrency(weakestCashFlow.derived.monthlyCashFlow)}/mo current cash flow after debt service.`,
      confidence: 'High',
      affectedProperties: [weakestCashFlow.address || 'Property'],
      evidence: [
        `${formatCurrency(weakestCashFlow.derived.monthlyIncome)}/mo gross income`,
        `${formatCurrency(weakestCashFlow.derived.monthlyExpenses)}/mo operating expenses`,
        `${formatCurrency(weakestCashFlow.derived.monthlyMortgage)}/mo debt service`,
      ],
      followUpPrompt: `What are the fastest ways to improve cash flow at ${weakestCashFlow.address || 'this property'}?`,
    });
  }

  if (highestExpense) {
    recommendations.push({
      id: `fallback-opex-${highestExpense.id}`,
      title: `Audit operating costs at ${highestExpense.address || 'this property'}`,
      summary: `${highestExpense.address || 'This property'} contributes the largest operating cost load in the portfolio.`,
      category: 'operating_efficiency',
      severity: 'medium',
      impact: `${formatCurrency(highestExpense.derived.monthlyExpenses)}/mo in recurring operating expenses.`,
      confidence: 'Medium',
      affectedProperties: [highestExpense.address || 'Property'],
      evidence: [
        `${formatCurrency(highestExpense.derived.annualPropertyTax)} annual taxes`,
        `${formatCurrency(highestExpense.derived.annualInsurance)} annual insurance`,
        `${formatCurrency(highestExpense.derived.annualOperatingReserve)} annual reserve / repair estimate`,
      ],
      followUpPrompt: `Which expense categories at ${highestExpense.address || 'this property'} look most actionable?`,
    });
  }

  return recommendations.slice(0, 4);
}

async function buildAssistantFallbackAnalysis(
  overview: PropertyPortfolioOverview,
  scope: PropertyPortfolioAnalysisScope,
): Promise<PropertyPortfolioAnalysisResult> {
  const propertyPayload = overview.properties.map((property) => ({
    address: property.address || property.propertyData.summary?.address || property.id,
    currentValue: property.derived.currentValue,
    mortgageBalance: property.derived.mortgageBalance,
    equity: property.derived.equity,
    monthlyRent: property.derived.monthlyRent,
    monthlyIncome: property.derived.monthlyIncome,
    monthlyExpenses: property.derived.monthlyExpenses,
    monthlyDebtService: property.derived.monthlyMortgage,
    monthlyCashFlow: property.derived.monthlyCashFlow,
    interestRate: property.financials.interestRate,
    tenantCount: property.tenantCount,
  }));

  const heuristicRecommendations = buildFallbackRecommendations(overview);

  try {
    const response = await requestAssistantChatCompletion(
      {
        model: 'gpt-4.1-mini',
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a real estate portfolio analyst. Return strict JSON with keys: narrative, recommendations. recommendations must be an array of objects with keys id,title,summary,category,severity,impact,confidence,affectedProperties,evidence,followUpPrompt. Stay grounded in the provided data only.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              scope,
              portfolioSummary: overview.summary,
              properties: propertyPayload,
            }),
          },
        ],
      },
      { includeFinancialDetails: true, includeGlobalContext: true },
    );

    const rawText = String(response?.choices?.[0]?.message?.content || '{}');
    const parsed = JSON.parse(rawText);
    const aiRecommendations = Array.isArray(parsed?.recommendations) && parsed.recommendations.length > 0
      ? parsed.recommendations.map((recommendation: Record<string, unknown>) => normalizePropertyPortfolioRecommendation(recommendation))
      : heuristicRecommendations;

    return normalizePropertyPortfolioAnalysis({
      generatedAt: new Date().toISOString(),
      scope,
      summary: {
        propertyCount: overview.summary.count,
        totalValue: overview.summary.totalValue,
        totalEquity: overview.summary.totalEquity,
        annualGrossIncome: overview.summary.annualGrossIncome,
        annualNetCashFlow: overview.summary.annualNetCashFlow,
        averageMortgageRate: overview.summary.avgInterestRate,
        currentMarketMortgageRate: null,
      },
      narrative: String(parsed?.narrative || 'The portfolio recommendations below were generated from the currently loaded property performance data.'),
      recommendations: aiRecommendations,
      sourceStatus: {
        firestore: { ok: true, propertyCount: overview.summary.count },
        azure: { ok: false, propertyCount: 0, ledgerEntries: 0 },
        openai: { ok: true, model: String(response?.model || 'canonical-assistant'), warning: 'Fallback analysis path in use' },
      },
    });
  } catch {
    return normalizePropertyPortfolioAnalysis({
      generatedAt: new Date().toISOString(),
      scope,
      summary: {
        propertyCount: overview.summary.count,
        totalValue: overview.summary.totalValue,
        totalEquity: overview.summary.totalEquity,
        annualGrossIncome: overview.summary.annualGrossIncome,
        annualNetCashFlow: overview.summary.annualNetCashFlow,
        averageMortgageRate: overview.summary.avgInterestRate,
        currentMarketMortgageRate: null,
      },
      narrative: 'The portfolio analysis fallback is using currently loaded property metrics because the dedicated backend analysis route is unavailable in this session.',
      recommendations: heuristicRecommendations,
      sourceStatus: {
        firestore: { ok: true, propertyCount: overview.summary.count },
        azure: { ok: false, propertyCount: 0, ledgerEntries: 0 },
        openai: { ok: false, warning: 'Fallback heuristic analysis in use' },
      },
    });
  }
}

export default function PortfolioAiInsightsPanel({
  scope,
  overview,
  compact = false,
  onClose,
}: {
  scope: PropertyPortfolioAnalysisScope;
  overview: PropertyPortfolioOverview;
  /** Render as a narrow side-rail panel instead of the full two-column layout. */
  compact?: boolean;
  onClose?: () => void;
}) {
  const [analysis, setAnalysis] = useState<PropertyPortfolioAnalysisResult | null>(null);
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<PropertyPortfolioConversationTurn[]>([]);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setConversation([]);
    setSelectedRecommendationId(null);

    fetchPropertyPortfolioAnalysis(scope)
      .then((nextAnalysis) => {
        if (!cancelled) {
          const normalizedAnalysis = normalizePropertyPortfolioAnalysis(nextAnalysis);
          setAnalysis(normalizedAnalysis);
          setSelectedRecommendationId(normalizedAnalysis.recommendations[0]?.id || null);
        }
      })
      .catch(async (nextError) => {
        if (cancelled) return;

        const message = String(nextError?.message || '');
        if (message.toLowerCase().includes('not found') || message.includes('404')) {
          const fallbackAnalysis = normalizePropertyPortfolioAnalysis(await buildAssistantFallbackAnalysis(overview, scope));
          if (!cancelled) {
            setAnalysis(fallbackAnalysis);
            setSelectedRecommendationId(fallbackAnalysis.recommendations[0]?.id || null);
          }
          return;
        }

        if (!cancelled) {
          setError(nextError.message || 'Unable to load AI portfolio analysis.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [overview, scope]);

  const selectedRecommendation = useMemo(
    () => analysis?.recommendations.find((item) => item.id === selectedRecommendationId) || analysis?.recommendations[0] || null,
    [analysis, selectedRecommendationId],
  );

  const handleAsk = async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      return;
    }

    setAsking(true);
    setError(null);
    const nextHistory = [...conversation, { role: 'user' as const, content: trimmed }];
    setConversation(nextHistory);
    setQuestion('');

    try {
      let answer = '';
      try {
        const response = await askPropertyPortfolioFollowUp({
          scope,
          question: trimmed,
          recommendationId: selectedRecommendation?.id || null,
          history: nextHistory,
        });
        answer = String(response.answer || 'No answer returned.');
      } catch (routeError: any) {
        const message = String(routeError?.message || '');
        if (message.toLowerCase().includes('not found') || message.includes('404')) {
          const response = await requestAssistantChatCompletion(
            {
              model: 'gpt-4.1-mini',
              temperature: 0.2,
              max_tokens: 700,
              messages: [
                {
                  role: 'system',
                  content: 'You are a real estate portfolio analyst. Answer the follow-up question using the provided property portfolio analysis context only. Be concise and grounded.',
                },
                {
                  role: 'user',
                  content: JSON.stringify({
                    question: trimmed,
                    selectedRecommendation,
                    portfolioSummary: overview.summary,
                    properties: overview.properties.map((property) => ({
                      address: property.address || property.propertyData.summary?.address || property.id,
                      currentValue: property.derived.currentValue,
                      equity: property.derived.equity,
                      monthlyIncome: property.derived.monthlyIncome,
                      monthlyExpenses: property.derived.monthlyExpenses,
                      monthlyDebtService: property.derived.monthlyMortgage,
                      monthlyCashFlow: property.derived.monthlyCashFlow,
                      interestRate: property.financials.interestRate,
                    })),
                  }),
                },
              ],
            },
            { includeFinancialDetails: true, includeGlobalContext: true },
          );
          answer = String(response?.choices?.[0]?.message?.content || 'No answer returned.');
        } else {
          throw routeError;
        }
      }

      setConversation([
        ...nextHistory,
        {
          role: 'assistant',
          content: answer,
        },
      ]);
    } catch (nextError: any) {
      setError(nextError?.message || 'Unable to complete follow-up analysis.');
    } finally {
      setAsking(false);
    }
  };

  if (compact) {
    return (
      <section className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[24px] border border-slate-200 bg-white p-4 shadow-[0_18px_44px_rgba(15,23,42,0.08)]">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">AI portfolio analysis</div>
            <h2 className="mt-1 text-base font-semibold tracking-[-0.02em] text-slate-900">Cross-property recommendations</h2>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              aria-label="Close AI analysis"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {loading ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            Building AI portfolio analysis...
          </div>
        ) : error ? (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>
        ) : analysis ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm leading-6 text-slate-600">{analysis.narrative}</p>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Net cash flow</div>
                <div className="mt-0.5 text-sm font-semibold text-slate-900">{formatCurrency(analysis.summary.annualNetCashFlow)}</div>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Avg debt rate</div>
                <div className="mt-0.5 text-sm font-semibold text-slate-900">
                  {analysis.summary.averageMortgageRate > 0 ? `${analysis.summary.averageMortgageRate.toFixed(2)}%` : 'N/A'}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              {analysis.recommendations.map((recommendation) => {
                const selected = recommendation.id === selectedRecommendation?.id;
                return (
                  <button
                    key={recommendation.id}
                    type="button"
                    onClick={() => setSelectedRecommendationId(recommendation.id)}
                    className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                      selected ? 'border-indigo-300 bg-indigo-50/60' : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${toneClasses[recommendation.severity]}`}>
                        {recommendation.severity}
                      </span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold text-slate-900">{recommendation.title}</div>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{recommendation.summary}</p>
                  </button>
                );
              })}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Ask a follow-up</div>

              <div className="mt-2.5 max-h-[220px] space-y-2 overflow-auto rounded-xl bg-slate-50 p-2">
                {conversation.length === 0 ? (
                  <div className="text-xs text-slate-500">
                    Try: "{selectedRecommendation?.followUpPrompt || 'Which property should I focus on first?'}"
                  </div>
                ) : conversation.map((turn, index) => (
                  <div
                    key={`${turn.role}-${index}`}
                    className={`rounded-xl px-2.5 py-1.5 text-xs leading-5 ${
                      turn.role === 'user' ? 'ml-4 bg-indigo-600 text-white' : 'mr-4 bg-white text-slate-700 shadow-sm'
                    }`}
                  >
                    {turn.content}
                  </div>
                ))}
              </div>

              <div className="mt-2.5 flex flex-col gap-2">
                <textarea
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Ask a follow-up question"
                  className="min-h-[56px] flex-1 rounded-xl border border-slate-200 px-2.5 py-2 text-xs text-slate-800 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                />
                <button
                  type="button"
                  onClick={handleAsk}
                  disabled={asking}
                  className="self-end rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {asking ? 'Thinking...' : 'Ask AI'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_18px_44px_rgba(15,23,42,0.08)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">AI Portfolio Analysis</div>
          <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-slate-900">Cross-property recommendations</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            OpenAI-backed analysis grounded in owner properties, current calculations, and available Azure bookkeeping context.
          </p>
        </div>
        {analysis && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Portfolio in scope</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{analysis.summary.propertyCount} properties</div>
            <div className="text-sm text-slate-500">{formatCurrency(analysis.summary.totalValue)} of value</div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">
          Building AI portfolio analysis...
        </div>
      ) : error ? (
        <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : analysis ? (
        <div className="mt-5 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Narrative</div>
              <p className="mt-2 text-sm leading-6 text-slate-700">{analysis.narrative}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Annual net cash flow</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{formatCurrency(analysis.summary.annualNetCashFlow)}</div>
                </div>
                <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Current market mortgage</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    {analysis.summary.currentMarketMortgageRate != null ? `${analysis.summary.currentMarketMortgageRate.toFixed(2)}%` : 'Unavailable'}
                  </div>
                </div>
                <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Avg portfolio debt rate</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    {analysis.summary.averageMortgageRate > 0 ? `${analysis.summary.averageMortgageRate.toFixed(2)}%` : 'N/A'}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-3">
              {analysis.recommendations.map((recommendation) => {
                const selected = recommendation.id === selectedRecommendation?.id;
                return (
                  <button
                    key={recommendation.id}
                    type="button"
                    onClick={() => setSelectedRecommendationId(recommendation.id)}
                    className={`rounded-2xl border px-4 py-4 text-left transition ${
                      selected ? 'border-indigo-300 bg-indigo-50/60 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${toneClasses[recommendation.severity]}`}>
                        {recommendation.severity}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                        {recommendation.category.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="mt-3 text-base font-semibold text-slate-900">{recommendation.title}</div>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{recommendation.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                      <span>Impact: {recommendation.impact}</span>
                      <span>Confidence: {recommendation.confidence}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Selected recommendation</div>
              {selectedRecommendation ? (
                <>
                  <h3 className="mt-2 text-lg font-semibold text-slate-900">{selectedRecommendation.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{selectedRecommendation.summary}</p>
                  <div className="mt-4 space-y-2">
                    {selectedRecommendation.evidence.map((evidence) => (
                      <div key={evidence} className="rounded-xl bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                        {evidence}
                      </div>
                    ))}
                  </div>
                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Affected properties</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedRecommendation.affectedProperties.map((property) => (
                        <span key={property} className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm">
                          {property}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No recommendations are available for this portfolio slice yet.</p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Follow-up analysis</div>
                  <div className="mt-1 text-sm text-slate-600">
                    Ask follow-up questions about any suggestion, refinance idea, or property-specific efficiency gap.
                  </div>
                </div>
              </div>

              <div className="mt-4 max-h-[280px] space-y-3 overflow-auto rounded-2xl bg-slate-50 p-3">
                {conversation.length === 0 ? (
                  <div className="text-sm text-slate-500">
                    Try: "{selectedRecommendation?.followUpPrompt || 'Which property should I focus on first?'}"
                  </div>
                ) : conversation.map((turn, index) => (
                  <div
                    key={`${turn.role}-${index}`}
                    className={`rounded-2xl px-3 py-2 text-sm leading-6 ${
                      turn.role === 'user'
                        ? 'ml-8 bg-indigo-600 text-white'
                        : 'mr-8 bg-white text-slate-700 shadow-sm'
                    }`}
                  >
                    {turn.content}
                  </div>
                ))}
              </div>

              <div className="mt-4 flex gap-2">
                <textarea
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder={selectedRecommendation?.followUpPrompt || 'Ask a follow-up question'}
                  className="min-h-[84px] flex-1 rounded-2xl border border-slate-200 px-3 py-3 text-sm text-slate-800 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                />
                <button
                  type="button"
                  onClick={handleAsk}
                  disabled={asking}
                  className="self-end rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {asking ? 'Thinking...' : 'Ask AI'}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Data sources</div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                  <div className="text-xs font-semibold text-slate-800">Firestore</div>
                  <div className="mt-1 text-sm text-slate-500">{analysis.sourceStatus.firestore.propertyCount} properties in scope</div>
                </div>
                <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                  <div className="text-xs font-semibold text-slate-800">Azure bookkeeping</div>
                  <div className="mt-1 text-sm text-slate-500">{analysis.sourceStatus.azure.ledgerEntries} ledger entries sampled</div>
                </div>
                <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
                  <div className="text-xs font-semibold text-slate-800">OpenAI</div>
                  <div className="mt-1 text-sm text-slate-500">{analysis.sourceStatus.openai.model || 'Narrative fallback only'}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
