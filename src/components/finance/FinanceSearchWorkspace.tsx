import React, { useEffect, useMemo, useState } from 'react';
import { bookkeepingClient } from '../../services/canonicalBookkeepingClient';

type SearchProvider = 'sql_like' | 'local_filter' | null;

interface FinanceSearchOverview {
  provider?: string | null;
  status?: string | null;
  summary?: string | null;
  bullets?: string[];
  confidence?: string | null;
  error?: string | null;
}

interface FinanceSearchLink {
  entityType: string;
  entityId: string;
  linkRole?: string;
}

interface FinanceSearchEvidenceRecord {
  evidenceId: string;
  propertyId?: string | null;
  sourceSystem?: string | null;
  sourceRef?: string | null;
  evidenceType?: string | null;
  title: string;
  vendorName?: string | null;
  amount?: number | null;
  documentDate?: string | null;
  digitizationStatus?: string | null;
  externalUrl?: string | null;
  storagePath?: string | null;
  summary?: Record<string, unknown> | null;
  extractedText?: string | null;
  links?: FinanceSearchLink[];
}

interface FinanceSearchResponse {
  ok?: boolean;
  status?: string;
  evidence?: FinanceSearchEvidenceRecord[];
  search?: {
    provider?: SearchProvider;
    status?: string;
    usedQuery?: string | null;
    hitCount?: number | null;
    error?: string | null;
  } | null;
  overview?: FinanceSearchOverview | null;
  error?: string;
}

interface FinanceAiCitation {
  slot: string;
  evidenceId: string;
  title: string;
  sourceSystem?: string | null;
  sourceRef?: string | null;
  documentDate?: string | null;
  amount?: number | null;
  vendorName?: string | null;
  evidenceType?: string | null;
  excerpt?: string | null;
}

interface FinanceAiResponse {
  ok?: boolean;
  status?: string;
  answer?: string | null;
  bullets?: string[];
  citations?: FinanceAiCitation[];
  followUps?: string[];
  confidence?: string | null;
  retrieval?: {
    provider?: SearchProvider;
    status?: string | null;
    usedQuery?: string | null;
    hitCount?: number | null;
    evidenceCount?: number | null;
  } | null;
  financeContext?: {
    year?: number | null;
    propertyId?: string | null;
    propertyLabel?: string | null;
    ledgerSummary?: {
      entryCount?: number;
      totalIncome?: number;
      totalExpenses?: number;
      netCashFlow?: number;
      topCategories?: Array<{ category: string; amount: number }>;
    } | null;
    scheduleE?: {
      totalIncome?: number;
      totalExpenses?: number;
      netIncomeOrLoss?: number;
    } | null;
    depreciation?: {
      totalCurrentYearDepreciation?: number;
      assetCount?: number;
    } | null;
    rulesRuntime?: {
      status?: string | null;
      source?: string | null;
      error?: string | null;
    } | null;
  } | null;
  answering?: {
    provider?: string | null;
    model?: string | null;
    status?: string | null;
  } | null;
  error?: string;
}

interface FinanceSearchWorkspaceProps {
  title: string;
  subtitle: string;
  propertyId?: string;
  year?: number | null;
  initialQuery?: string;
  placeholder?: string;
  presetQueries?: string[];
  indexedCount?: number;
  pendingCount?: number;
}

const SOURCE_SYSTEM_OPTIONS = [
  { value: 'all', label: 'All sources' },
  { value: 'bookkeeping_finance_document', label: 'Finance docs' },
  { value: 'bookkeeping_firestore_receipt', label: 'Receipt uploads' },
  { value: 'STRIPE', label: 'Stripe' },
  { value: 'HOUSEYIELD', label: 'HouseYield' },
];

function fmtMoney(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function fmtDate(input: string | null | undefined) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function searchStatusClass(status?: string | null) {
  const value = String(status || '').toLowerCase();
  if (value === 'searched' || value === 'loaded') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  if (value.includes('fallback') || value === 'not_configured') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (value === 'failed') return 'border-rose-300 bg-rose-50 text-rose-900';
  return 'border-slate-300 bg-slate-50 text-slate-700';
}

function sourceSystemLabel(value?: string | null) {
  if (!value) return 'Unknown source';
  const match = SOURCE_SYSTEM_OPTIONS.find((option) => option.value === value);
  return match?.label || value.replace(/_/g, ' ');
}

function evidenceSummarySnippet(evidence: FinanceSearchEvidenceRecord) {
  const summary = evidence.summary || {};
  const summaryText = [summary.summary, summary.description, summary.notes]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)[0];
  if (summaryText) return summaryText;
  if (typeof evidence.extractedText === 'string' && evidence.extractedText.trim()) {
    return `${evidence.extractedText.trim().slice(0, 180)}${evidence.extractedText.length > 180 ? '…' : ''}`;
  }
  return 'No OCR summary or extracted text is attached to this evidence row yet.';
}

function answerProviderLabel(response?: FinanceAiResponse | null) {
  if (response?.answering?.provider === 'gemini') return 'Gemini answer';
  return 'Grounded answer';
}

function searchProviderLabel(provider?: SearchProvider) {
  if (provider === 'sql_like') return 'Local evidence search';
  if (provider === 'local_filter') return 'Local document search';
  return 'Browse';
}

function overviewProviderLabel(overview?: FinanceSearchOverview | null) {
  if (overview?.provider === 'gemini') return 'Gemini overview';
  return 'Local overview';
}

function confidenceBadgeClass(confidence?: string | null) {
  const value = String(confidence || '').toLowerCase();
  if (value === 'high') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  if (value === 'medium') return 'border-amber-300 bg-amber-50 text-amber-900';
  return 'border-slate-300 bg-slate-50 text-slate-700';
}

export default function FinanceSearchWorkspace({
  title,
  subtitle,
  propertyId,
  year = null,
  initialQuery = '',
  placeholder = 'Search receipts, vendor names, OCR text, source refs, or packet evidence',
  presetQueries = [],
  indexedCount,
  pendingCount,
}: FinanceSearchWorkspaceProps) {
  const [query, setQuery] = useState(initialQuery);
  const [committedQuery, setCommittedQuery] = useState(initialQuery);
  const [sourceSystem, setSourceSystem] = useState('all');
  const [results, setResults] = useState<FinanceSearchEvidenceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<FinanceAiResponse | null>(null);
  const [searchOverview, setSearchOverview] = useState<FinanceSearchOverview | null>(null);
  const [searchMeta, setSearchMeta] = useState<NonNullable<FinanceSearchResponse['search']>>({
    provider: null,
    status: 'not_requested',
    usedQuery: initialQuery || null,
    hitCount: null,
  });

  useEffect(() => {
    setAiError(null);
    setAiResult(null);
  }, [propertyId, sourceSystem, year]);

  async function runAiQuery(nextQuestion?: string) {
    const activeQuestion = String(nextQuestion ?? query).trim();
    if (!activeQuestion) {
      setAiError('Enter a finance question first.');
      setAiResult(null);
      return;
    }

    setAiLoading(true);
    setAiError(null);
    setCommittedQuery(activeQuestion);

    try {
      const data = await bookkeepingClient.askFinanceQuestion({
        question: activeQuestion,
        propertyId: propertyId || undefined,
        year: year ?? undefined,
        sourceSystem: sourceSystem === 'all' ? undefined : sourceSystem,
        limit: 8,
      }) as FinanceAiResponse;

      if (data.ok === false) {
        setAiResult(null);
        setAiError(data.error || 'Finance AI query failed.');
        return;
      }

      setAiResult(data);
    } catch (err: any) {
      setAiResult(null);
      setAiError(err?.message || 'Finance AI query failed.');
    } finally {
      setAiLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadSearch() {
      setLoading(true);
      setError(null);
      try {
        const data = await bookkeepingClient.searchEvidence({
          q: committedQuery.trim() || undefined,
          propertyId: propertyId || undefined,
          year: year ?? undefined,
          sourceSystem: sourceSystem === 'all' ? undefined : sourceSystem,
          limit: 12,
        }) as FinanceSearchResponse;

        if (cancelled) return;

        if (data.ok === false) {
          setResults([]);
          setSearchOverview(null);
          setError(data.error || 'Finance search failed.');
          setSearchMeta({
            provider: data.search?.provider || null,
            status: data.search?.status || 'failed',
            usedQuery: data.search?.usedQuery || committedQuery || null,
            hitCount: data.search?.hitCount ?? null,
            error: data.search?.error || data.error || null,
          });
          return;
        }

        setResults(data.evidence || []);
        setSearchOverview(data.overview || null);
        setSearchMeta({
          provider: data.search?.provider || null,
          status: data.search?.status || data.status || 'loaded',
          usedQuery: data.search?.usedQuery || committedQuery || null,
          hitCount: data.search?.hitCount ?? (data.evidence || []).length,
          error: data.search?.error || null,
        });
      } catch (err: any) {
        if (cancelled) return;
        setResults([]);
        setSearchOverview(null);
        setError(err?.message || 'Finance search failed.');
        setSearchMeta({
          provider: null,
          status: 'failed',
          usedQuery: committedQuery || null,
          hitCount: null,
          error: err?.message || 'Finance search failed.',
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSearch();

    return () => {
      cancelled = true;
    };
  }, [committedQuery, propertyId, sourceSystem, year]);

  const activeScopeText = useMemo(() => {
    const parts = [];
    if (propertyId) parts.push(`Property ${propertyId}`);
    if (year) parts.push(`Year ${year}`);
    if (sourceSystem !== 'all') parts.push(sourceSystemLabel(sourceSystem));
    return parts.join(' · ');
  }, [propertyId, sourceSystem, year]);

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <div className="mt-0.5 text-xs text-slate-500">{subtitle}</div>
          <div className="mt-1 text-[11px] text-slate-400">
            Read-only, citation-heavy search over local finance evidence and linked entities.
            {activeScopeText ? ` ${activeScopeText}.` : ''}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {indexedCount != null && <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">{indexedCount} evidence</span>}
          {pendingCount != null && <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">{pendingCount} pending</span>}
          <span className={`rounded-full border px-2 py-0.5 ${searchStatusClass(searchMeta.status)}`}>
            {searchProviderLabel(searchMeta.provider)}
          </span>
        </div>
      </div>

      {presetQueries.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {presetQueries.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                setQuery(preset);
                setCommittedQuery(preset);
                setAiError(null);
                setAiResult(null);
              }}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
            >
              {preset}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_180px_auto_auto_auto]">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setCommittedQuery(query);
            }
          }}
          placeholder={placeholder}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <select
          value={sourceSystem}
          onChange={(event) => setSourceSystem(event.target.value)}
          className="rounded-md border border-slate-300 px-2 py-2 text-sm"
        >
          {SOURCE_SYSTEM_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCommittedQuery(query)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
        <button
          type="button"
          onClick={() => void runAiQuery()}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          {aiLoading ? 'Answering…' : 'Ask AI'}
        </button>
        <button
          type="button"
          onClick={() => {
            setQuery('');
            setCommittedQuery('');
            setSourceSystem('all');
            setAiError(null);
            setAiResult(null);
          }}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
        >
          Clear
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span>{searchMeta.hitCount ?? results.length} result(s)</span>
        {searchMeta.usedQuery && <span>Query: {searchMeta.usedQuery}</span>}
        {activeScopeText && <span>{activeScopeText}</span>}
      </div>

      {(searchOverview?.summary || (searchOverview?.bullets && searchOverview.bullets.length > 0)) && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">Search overview</div>
              <div className="mt-0.5 text-xs text-slate-500">
                Snapshot of the current local search results in this finance scope.
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <span className={`rounded-full border px-2 py-0.5 ${searchStatusClass(searchOverview?.status)}`}>
                {overviewProviderLabel(searchOverview)}
              </span>
              {searchOverview?.confidence && (
                <span className={`rounded-full border px-2 py-0.5 ${confidenceBadgeClass(searchOverview.confidence)}`}>
                  {searchOverview.confidence} confidence
                </span>
              )}
            </div>
          </div>

          {searchOverview?.summary && (
            <div className="mt-3 text-sm leading-6 text-slate-700 whitespace-pre-wrap">{searchOverview.summary}</div>
          )}

          {searchOverview?.bullets && searchOverview.bullets.length > 0 && (
            <ul className="mt-3 space-y-2 text-sm text-slate-600">
              {searchOverview.bullets.map((bullet) => (
                <li key={bullet} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  {bullet}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(aiLoading || aiError || aiResult) && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">Ask finance AI</div>
              <div className="mt-0.5 text-xs text-slate-500">
                Grounded answer over the current finance scope. Retrieval uses the same local finance evidence search that powers this workspace.
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {aiResult?.answering?.status && (
                <span className={`rounded-full border px-2 py-0.5 ${searchStatusClass(aiResult.answering.status)}`}>
                  {answerProviderLabel(aiResult)}
                </span>
              )}
              {aiResult?.retrieval?.provider && (
                <span className={`rounded-full border px-2 py-0.5 ${searchStatusClass(aiResult.retrieval.status)}`}>
                  Local retrieval
                </span>
              )}
              {aiResult?.confidence && (
                <span className={`rounded-full border px-2 py-0.5 ${confidenceBadgeClass(aiResult.confidence)}`}>
                  {aiResult.confidence} confidence
                </span>
              )}
            </div>
          </div>

          {aiLoading && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
              Building a grounded answer from the current finance scope…
            </div>
          )}

          {aiError && (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
              {aiError}
            </div>
          )}

          {aiResult?.answer && (
            <div className="mt-3 text-sm leading-6 text-slate-700 whitespace-pre-wrap">{aiResult.answer}</div>
          )}

          {aiResult?.bullets && aiResult.bullets.length > 0 && (
            <ul className="mt-3 space-y-2 text-sm text-slate-600">
              {aiResult.bullets.map((bullet) => (
                <li key={bullet} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  {bullet}
                </li>
              ))}
            </ul>
          )}

          {aiResult?.financeContext?.ledgerSummary && (
            <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                {aiResult.financeContext.ledgerSummary.entryCount || 0} entries in scope
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                Income {fmtMoney(aiResult.financeContext.ledgerSummary.totalIncome)}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                Expenses {fmtMoney(aiResult.financeContext.ledgerSummary.totalExpenses)}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                Net {fmtMoney(aiResult.financeContext.ledgerSummary.netCashFlow)}
              </span>
              {aiResult.financeContext.propertyLabel && (
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                  {aiResult.financeContext.propertyLabel}
                </span>
              )}
            </div>
          )}

          {aiResult?.citations && aiResult.citations.length > 0 && (
            <div className="mt-4 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Citations</div>
              {aiResult.citations.map((citation) => (
                <div key={`${citation.slot}-${citation.evidenceId}`} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 font-semibold text-slate-700">{citation.slot}</span>
                    <span>{citation.title}</span>
                    {citation.vendorName && <span>{citation.vendorName}</span>}
                    {fmtMoney(citation.amount) && <span>{fmtMoney(citation.amount)}</span>}
                    {fmtDate(citation.documentDate) && <span>{fmtDate(citation.documentDate)}</span>}
                  </div>
                  {citation.excerpt && (
                    <div className="mt-2 text-sm text-slate-600">{citation.excerpt}</div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    {citation.sourceRef && <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">source ref {citation.sourceRef}</span>}
                    {citation.sourceSystem && <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">{sourceSystemLabel(citation.sourceSystem)}</span>}
                    {citation.evidenceType && <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5">{citation.evidenceType.replace(/_/g, ' ')}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {aiResult?.followUps && aiResult.followUps.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {aiResult.followUps.map((followUp) => (
                <button
                  key={followUp}
                  type="button"
                  onClick={() => {
                    setQuery(followUp);
                    void runAiQuery(followUp);
                  }}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                >
                  {followUp}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="mt-3 space-y-3">
        {results.length === 0 && !loading && !error && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-4 text-sm text-slate-500">
            {committedQuery.trim()
              ? 'No indexed evidence matched this search in the current scope.'
              : 'Showing the current scoped evidence feed. Enter a query or use a preset to narrow it.'}
          </div>
        )}

        {results.map((evidence) => {
          const amount = fmtMoney(evidence.amount);
          const documentDate = fmtDate(evidence.documentDate);
          return (
            <div key={evidence.evidenceId} className="rounded-xl border border-white bg-white px-4 py-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium text-slate-900">{evidence.title || evidence.vendorName || evidence.evidenceType || 'Evidence item'}</div>
                    {evidence.evidenceType && (
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700">
                        {evidence.evidenceType.replace(/_/g, ' ')}
                      </span>
                    )}
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700">
                      {sourceSystemLabel(evidence.sourceSystem)}
                    </span>
                    {evidence.digitizationStatus && (
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${searchStatusClass(evidence.digitizationStatus)}`}>
                        {evidence.digitizationStatus}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {[evidence.vendorName, amount, documentDate, evidence.propertyId].filter(Boolean).join(' · ') || 'No vendor, amount, or property metadata attached'}
                  </div>
                  <div className="mt-2 text-sm text-slate-600">{evidenceSummarySnippet(evidence)}</div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    {evidence.sourceRef && <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">source ref {evidence.sourceRef}</span>}
                    {evidence.links?.slice(0, 3).map((link) => (
                      <span key={`${evidence.evidenceId}-${link.entityType}-${link.entityId}`} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                        {link.entityType.replace(/_/g, ' ')} {link.entityId}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 text-xs">
                  {evidence.externalUrl ? (
                    <a
                      href={evidence.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Open document
                    </a>
                  ) : evidence.storagePath ? (
                    <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 font-semibold text-slate-500">
                      Stored evidence
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}