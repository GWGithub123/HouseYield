import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ChartModal, ExpandButton } from './charts/AnalyticsFrame';
import { Card } from '../design-system';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface MarketAIAnalysisProps {
  endpoint: string;
  payload: object;
  title?: string;
  subtitle?: string;
  icon?: string;
  onHotZones?: (zones: string[]) => void;
  showHeadlineSources?: boolean;
  showNewsCatalysts?: boolean;
  autoRun?: boolean;
  cacheKey?: string;
  cacheMode?: 'none' | 'local';
  manualRefreshOnly?: boolean;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  compact?: boolean;
  /** Canonical light Card surface for Market Insights (default). Legacy dark header when "dark". */
  surface?: 'light' | 'dark';
}

type Status = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

interface CachedAnalysisEntry {
  streamText: string;
  analysisContext?: {
    macroHeadlines?: Array<{ title?: string; source?: string; publishedAt?: string; summary?: string }>;
    polygonNews?: Array<{ title?: string; source?: string; publishedAt?: string; summary?: string }>;
    finnhubNews?: Array<{ title?: string; source?: string; publishedAt?: string; summary?: string }>;
    eventRegistryNews?: Array<{ title?: string; source?: string; publishedAt?: string; summary?: string }>;
    macroSignals?: string[];
    newsTransmissionSignals?: string[];
  };
  lastRun: string;
}

const SECTION_COLORS: Record<string, string> = {
  'MARKET OVERVIEW': 'text-blue-700',
  'NEIGHBORHOOD OVERVIEW': 'text-blue-700',
  'REGION OVERVIEW': 'text-blue-700',
  '3-MONTH OUTLOOK': 'text-indigo-700',
  '6-MONTH OUTLOOK': 'text-indigo-700',
  '12-MONTH OUTLOOK': 'text-indigo-700',
  '3-YEAR OUTLOOK': 'text-indigo-700',
  'REAL ESTATE IMPLICATIONS': 'text-emerald-700',
  'INVESTMENT THESIS': 'text-emerald-700',
  'KEY RISKS': 'text-rose-700',
  'RISKS': 'text-rose-700',
  'BUY SIGNALS': 'text-emerald-700',
  'HOT ZONES': 'text-emerald-700',
  'WATCH ZONES': 'text-amber-700',
  'MARKET PHASE': 'text-amber-700',
  'MARKET ATTRACTIVENESS': 'text-amber-700',
  'RENT SIGNALS': 'text-teal-700',
  'OPPORTUNITIES': 'text-purple-700',
};

function parseStreamText(text: string): Array<{ heading?: string; content: string }> {
  const parts = text.split(/\n##\s+/);
  return parts.map((part, idx) => {
    if (idx === 0 && !text.startsWith('## ')) {
      return { content: part };
    }
    const newline = part.indexOf('\n');
    if (newline === -1) {
      return { heading: part.replace(/^##\s+/, '').trim(), content: '' };
    }
    return {
      heading: part.slice(0, newline).replace(/^##\s+/, '').trim(),
      content: part.slice(newline + 1).trim(),
    };
  }).filter(p => p.content || p.heading);
}

function getStorageKey(cacheKey: string) {
  return `market-ai-analysis:${cacheKey}`;
}

function loadCachedAnalysis(cacheKey?: string): CachedAnalysisEntry | null {
  if (!cacheKey || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(getStorageKey(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAnalysisEntry;
    if (!parsed?.streamText || !parsed?.lastRun) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedAnalysis(cacheKey: string | undefined, entry: CachedAnalysisEntry) {
  if (!cacheKey || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(getStorageKey(cacheKey), JSON.stringify(entry));
  } catch {
    // Ignore storage failures and fall back to live-only behavior.
  }
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function buildProjectionBullets(content: string, targetCount = 4) {
  const explicitBullets = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^([-*•]|\d+\.)\s+/, '').trim());

  const sentenceBullets = explicitBullets.length > 0
    ? explicitBullets
    : content
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);

  return sentenceBullets.slice(0, targetCount);
}

function buildVisibleHeadlines(
  analysisContext?: CachedAnalysisEntry['analysisContext'] | null,
  includeSources: boolean = true
) {
  if (!analysisContext) return [];

  const items = [
    ...(analysisContext.polygonNews || []),
    ...(analysisContext.macroHeadlines || []),
    ...(analysisContext.finnhubNews || []),
    ...(analysisContext.eventRegistryNews || []),
  ]
    .map((item) => {
      const title = (item.title || (item as any).headline || (item as any).name || '').trim();
      if (!title) return null;
      const source = (item.source || (item as any).publisher || (item as any).topic || '').trim();
      return includeSources && source ? `${title} (${source})` : title;
    })
    .filter((item): item is string => Boolean(item));

  return Array.from(new Set(items)).slice(0, 8);
}

function isProjectionDetailSection(heading?: string) {
  return Boolean(heading && /(3-MONTH|6-MONTH|12-MONTH|3-YEAR) DETAIL/.test(heading));
}

function getProjectionDetailHeading(heading?: string) {
  return heading ? heading.replace('OUTLOOK', 'DETAIL') : undefined;
}

function getProjectionSummaryHeading(heading?: string) {
  return heading ? heading.replace('DETAIL', 'OUTLOOK') : undefined;
}

function formatSignedNumber(value: number, digits = 1) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function parsePayloadNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const numeric = Number.parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function buildFallbackProjectionDetail(heading: string, payload: any) {
  const housing = payload?.housingData || {};
  const treasury = payload?.treasuryYields || {};
  const macro = payload?.macroData || {};
  const predictions = payload?.predictions || {};

  const mortgageRate = parsePayloadNumber(housing.mortgageRate);
  const inventoryMonths = parsePayloadNumber(housing.inventoryMonths);
  const priceTrend = parsePayloadNumber(housing.priceTrend);
  const medianHomePrice = parsePayloadNumber(housing.medianHomePrice);
  const t10y = parsePayloadNumber(treasury.t10y);
  const t2y = parsePayloadNumber(treasury.t2y);
  const mortgageMonthlyChange = parsePayloadNumber(treasury.mortgageMonthlyChange);
  const tenYearMonthlyChange = parsePayloadNumber(treasury.tenYearMonthlyChange);
  const fedFundsRate = parsePayloadNumber(macro.fedFundsRate?.value ?? macro.fedFundsRate);
  const corePceYoy = parsePayloadNumber(macro.corePCE?.yoy);
  const corePceMom = parsePayloadNumber(macro.corePCE?.mom);
  const unemployment = parsePayloadNumber(macro.unemployment?.value ?? macro.unemployment);
  const joblessClaims = parsePayloadNumber(macro.joblessClaims?.value ?? macro.joblessClaims);
  const joblessClaimsYoy = parsePayloadNumber(macro.joblessClaims?.yoy);
  const jobOpenings = parsePayloadNumber(macro.jobOpenings?.value ?? macro.jobOpenings);
  const jobOpeningsYoy = parsePayloadNumber(macro.jobOpenings?.yoy);
  const oilPrice = parsePayloadNumber(macro.oilPrice?.value ?? macro.oilPrice);
  const oilPriceYoy = parsePayloadNumber(macro.oilPrice?.yoy);
  const consumerSentiment = parsePayloadNumber(macro.consumerSentiment?.value ?? macro.consumerSentiment);
  const gdpGrowth = parsePayloadNumber(macro.gdpGrowth?.value ?? macro.gdpGrowth);
  const fedCutOdds = parsePayloadNumber(predictions.fedRateCut);
  const recessionOdds = parsePayloadNumber(predictions.recession);
  const mortgageSpreadBps = mortgageRate !== null && t10y !== null ? Math.round((mortgageRate - t10y) * 100) : null;
  const curveSpread = t10y !== null && t2y !== null ? t10y - t2y : null;

  const timeframeLabel = heading.replace('OUTLOOK', '').trim();
  const lines = [
    `${timeframeLabel} logic fallback: this view is being built directly from the live market payload because the model response did not include a dedicated DETAIL section for this timeframe.`,
    mortgageRate !== null && t10y !== null
      ? `Rates setup: the 30-year mortgage rate is ${mortgageRate.toFixed(2)}% versus the 10-year Treasury at ${t10y.toFixed(2)}%, leaving a mortgage spread of about ${mortgageSpreadBps} bps${mortgageMonthlyChange !== null ? ` and a one-month mortgage move of ${formatSignedNumber(mortgageMonthlyChange, 2)} pts` : ''}${tenYearMonthlyChange !== null ? ` while the 10-year moved ${formatSignedNumber(tenYearMonthlyChange, 2)} pts` : ''}.`
      : 'Rates setup: mortgage and Treasury inputs are partially missing, so rate logic is being inferred from the available macro indicators.',
    fedFundsRate !== null || corePceYoy !== null || corePceMom !== null
      ? `Policy and inflation: Fed funds are ${fedFundsRate !== null ? `${fedFundsRate.toFixed(2)}%` : 'unavailable'} while Core PCE is ${corePceYoy !== null ? `${corePceYoy.toFixed(1)}% YoY` : 'unavailable'}${corePceMom !== null ? ` and ${formatSignedNumber(corePceMom, 1)}% MoM` : ''}, so any financing relief depends on whether inflation continues cooling rather than reaccelerating.`
      : 'Policy and inflation: inflation detail is limited, so the policy path is less grounded than it should be.',
    unemployment !== null || joblessClaims !== null || jobOpenings !== null
      ? `Labor read: unemployment is ${unemployment !== null ? `${unemployment.toFixed(2)}%` : 'unavailable'}, jobless claims are ${joblessClaims !== null ? Math.round(joblessClaims).toLocaleString() : 'unavailable'}${joblessClaimsYoy !== null ? ` (${formatSignedNumber(joblessClaimsYoy, 1)}% YoY)` : ''}, and job openings are ${jobOpenings !== null ? `${jobOpenings.toFixed(3)} million` : 'unavailable'}${jobOpeningsYoy !== null ? ` (${formatSignedNumber(jobOpeningsYoy, 1)}% YoY)` : ''}; together these are the core labor-demand signals feeding the housing demand view.`
      : 'Labor read: labor indicators are partially missing, so demand logic is relying more heavily on housing and rates.',
    inventoryMonths !== null || priceTrend !== null || medianHomePrice !== null
      ? `Housing setup: inventory is running at ${inventoryMonths !== null ? `${inventoryMonths.toFixed(1)} months of supply` : 'an unknown supply level'}${priceTrend !== null ? ` while median prices are ${priceTrend >= 0 ? 'up' : 'down'} ${Math.abs(priceTrend).toFixed(1)}% YoY` : ''}${medianHomePrice !== null ? ` around a ${medianHomePrice.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} median` : ''}, so the price path mainly depends on whether supply can normalize before demand weakens further.`
      : 'Housing setup: supply and price trend detail is limited, so the near-term housing call is less specific than intended.',
    oilPrice !== null || consumerSentiment !== null || gdpGrowth !== null || curveSpread !== null
      ? `Broader macro and news channels: oil is ${oilPrice !== null ? `$${oilPrice.toFixed(1)}` : 'unavailable'}${oilPriceYoy !== null ? ` (${formatSignedNumber(oilPriceYoy, 1)}% YoY)` : ''}, consumer sentiment is ${consumerSentiment !== null ? consumerSentiment.toFixed(1) : 'unavailable'}, GDP growth is ${gdpGrowth !== null ? `${gdpGrowth.toFixed(2)}%` : 'unavailable'}, and the 10Y-2Y curve is ${curveSpread !== null ? `${formatSignedNumber(curveSpread, 2)} pts` : 'unavailable'}; this is where oil shocks, shipping disruptions, and geopolitical inflation risk should pressure the financing outlook.`
      : 'Broader macro and news channels: this analysis should also be informed by energy, growth, and geopolitical catalysts, but those fields are not fully populated in the current fallback.',
    fedCutOdds !== null || recessionOdds !== null
      ? `Market-implied calibration: fed-cut odds are ${fedCutOdds !== null ? `${fedCutOdds}%` : 'unavailable'} and recession odds are ${recessionOdds !== null ? `${recessionOdds}%` : 'unavailable'}, which should be treated as probability inputs rather than hard forecasts.`
      : 'Market-implied calibration: prediction-market probabilities were not available in this response.',
  ];

  return lines.filter(Boolean).join('\n\n');
}

const MarketAIAnalysis: React.FC<MarketAIAnalysisProps> = ({
  endpoint,
  payload,
  title = 'AI Market Analysis',
  subtitle = 'AI-powered analysis using current market data',
  icon = 'AI',
  onHotZones,
  showHeadlineSources = true,
  showNewsCatalysts = true,
  autoRun = false,
  cacheKey,
  cacheMode = 'none',
  manualRefreshOnly = false,
  collapsible = false,
  defaultExpanded = true,
  compact = false,
  surface = 'light',
}) => {
  const isLight = surface === 'light';
  const [status, setStatus] = useState<Status>('idle');
  const [streamText, setStreamText] = useState('');
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysisContext, setAnalysisContext] = useState<CachedAnalysisEntry['analysisContext'] | null>(null);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [hasCachedContent, setHasCachedContent] = useState(false);
  const [expandedProjectionHeading, setExpandedProjectionHeading] = useState<string | null>(null);
  const [showFullDetail, setShowFullDetail] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastAutoRunKey = useRef<string | null>(null);
  const autoRunKey = useMemo(() => JSON.stringify({ endpoint, payload }), [endpoint, payload]);
  const localCacheKey = cacheMode === 'local' ? cacheKey : undefined;

  const sections = useMemo(() => parseStreamText(streamText), [streamText]);
  const projectionDetailMap = useMemo(() => {
    const detailEntries = sections
      .filter((section) => isProjectionDetailSection(section.heading))
      .map((section) => [getProjectionSummaryHeading(section.heading) || '', section.content] as const);

    return new Map(detailEntries);
  }, [sections]);
  const summaryText = useMemo(() => {
    const prioritySection = sections.find((section) => section.heading?.includes('3-MONTH OUTLOOK'))
      || sections.find((section) => section.heading?.includes('MARKET OVERVIEW'))
      || sections.find((section) => section.content.trim().length > 0);

    if (!prioritySection?.content) {
      if (hasCachedContent) return 'Cached outlook ready.';
      return manualRefreshOnly
        ? 'Cached outlook will appear here after you generate it once.'
        : subtitle;
    }

    return truncateText(prioritySection.content.replace(/\s+/g, ' ').trim(), compact ? 150 : 220);
  }, [compact, hasCachedContent, manualRefreshOnly, sections, subtitle]);

  useEffect(() => {
    setIsExpanded(defaultExpanded);
  }, [defaultExpanded]);

  useEffect(() => {
    if (!localCacheKey) {
      setHasCachedContent(false);
      return;
    }

    const cached = loadCachedAnalysis(localCacheKey);
    if (!cached) {
      setHasCachedContent(false);
      setStatus('idle');
      setStreamText('');
      setLastRun(null);
      return;
    }

    setStreamText(cached.streamText);
    setAnalysisContext(cached.analysisContext || null);
    setLastRun(new Date(cached.lastRun));
    setHasCachedContent(true);
    setStatus('done');
    setError(null);
  }, [localCacheKey]);

  const runAnalysis = async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const hadExistingContent = streamText.trim().length > 0;

    setStatus(hadExistingContent ? 'streaming' : 'loading');
    setError(null);
    setAnalysisContext(null);

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('No response body');

      setStatus('streaming');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let completed = false;
      let streamedContext: CachedAnalysisEntry['analysisContext'] | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === 'delta' && parsed.text) {
              accumulated += parsed.text;
              setStreamText(accumulated);
            } else if (parsed.type === 'context' && parsed.context) {
              streamedContext = parsed.context;
              setAnalysisContext(parsed.context);
            } else if (parsed.type === 'done') {
              completed = true;
              const completedAt = new Date();
              setStatus('done');
              setLastRun(completedAt);
              setHasCachedContent(true);
              saveCachedAnalysis(localCacheKey, {
                streamText: accumulated,
                analysisContext: streamedContext || undefined,
                lastRun: completedAt.toISOString(),
              });
              // Extract hot zones if callback provided
              if (onHotZones) {
                const hotSection = accumulated.match(/## HOT ZONES\n([\s\S]*?)(?=\n##|$)/i);
                if (hotSection) {
                  const zones = hotSection[1].split('\n')
                    .filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'))
                    .map(l => l.replace(/^[-•]\s*/, '').trim())
                    .filter(Boolean);
                  if (zones.length) onHotZones(zones);
                }
              }
            } else if (parsed.type === 'error') {
              throw new Error(parsed.error || 'Analysis failed');
            }
          } catch {}
        }
      }
      if (!completed) {
        const completedAt = new Date();
        setStatus('done');
        setLastRun(completedAt);
        setHasCachedContent(accumulated.trim().length > 0 || hadExistingContent);
        if (accumulated.trim().length > 0) {
          saveCachedAnalysis(localCacheKey, {
            streamText: accumulated,
            analysisContext: streamedContext || undefined,
            lastRun: completedAt.toISOString(),
          });
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Analysis failed');
      setStatus(hadExistingContent ? 'done' : 'error');
    }
  };

  useEffect(() => {
    if (autoRun && !manualRefreshOnly && autoRunKey !== lastAutoRunKey.current) {
      lastAutoRunKey.current = autoRunKey;
      runAnalysis();
    }
    return () => { abortRef.current?.abort(); };
  }, [autoRun, autoRunKey, manualRefreshOnly]);

  const isProjectionSection = (h?: string) =>
    Boolean(h && (h.includes('MONTH') || h.includes('YEAR')) && !h.includes('DETAIL'));

  const projectionColors: Record<string, string> = {
    '3-MONTH OUTLOOK':  'border-blue-200 bg-blue-50',
    '6-MONTH OUTLOOK':  'border-indigo-200 bg-indigo-50',
    '12-MONTH OUTLOOK': 'border-purple-200 bg-purple-50',
    '3-YEAR OUTLOOK':   'border-amber-200 bg-amber-50',
  };

  const projectionBulletStyle: React.CSSProperties = {
    minHeight: '3.25rem',
  };

  const showContent = !collapsible || isExpanded;
  const isBusy = status === 'loading' || status === 'streaming';
  const showCachedBody = sections.length > 0;
  const lastRunLabel = lastRun
    ? lastRun.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  const expandedProjectionDetail = expandedProjectionHeading
    ? projectionDetailMap.get(expandedProjectionHeading)
    : null;
  const marketOverviewSection = sections.find((section) => section.heading === 'MARKET OVERVIEW');
  const newsCatalystsSection = sections.find((section) => section.heading === 'NEWS & CATALYSTS');
  const realEstateImplicationsSection = sections.find((section) => section.heading === 'REAL ESTATE IMPLICATIONS');
  const keyRisksSection = sections.find((section) => section.heading === 'KEY RISKS');
  const visibleHeadlines = buildVisibleHeadlines(analysisContext, showHeadlineSources);
  const visibleSignals = (analysisContext?.macroSignals || []).slice(0, 4);
  const visibleTransmissionSignals = (analysisContext?.newsTransmissionSignals || []).slice(0, 4);
  const shouldShowNewsCatalysts = showNewsCatalysts && (
    Boolean(newsCatalystsSection) ||
    visibleHeadlines.length > 0 ||
    visibleSignals.length > 0 ||
    visibleTransmissionSignals.length > 0
  );

  const renderBody = () => (
    <>
      {status === 'idle' && (
        <div className="text-center py-8 text-slate-500">
          <div className="font-medium text-slate-700 mb-1">Ready to analyze</div>
          <p className="text-sm">
            {manualRefreshOnly
              ? 'Use Generate to create the first cached outlook. After that it will load instantly until you refresh it.'
              : 'Click Generate to get an AI-powered market outlook based on current data.'}
          </p>
        </div>
      )}

      {status === 'loading' && !showCachedBody && (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-slate-700 mx-auto mb-3" />
          <p className="text-slate-600 text-sm">Analyzing market data...</p>
        </div>
      )}

      {status === 'error' && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
          <div className="font-medium text-rose-700 mb-1">Analysis Failed</div>
          <p className="text-rose-600 text-sm">{error}</p>
        </div>
      )}

      {(status === 'streaming' || status === 'done') && sections.length > 0 && (
        <div className="space-y-5">
          {error && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              Showing the last cached analysis. Refresh failed: {error}
            </div>
          )}

          {sections.some(s => isProjectionSection(s.heading)) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {sections
                .filter(s => isProjectionSection(s.heading))
                .map((s, i) => {
                  const colorClass = projectionColors[s.heading!] || 'border-slate-200 bg-slate-50';
                  const bullets = buildProjectionBullets(s.content, showFullDetail ? 3 : 1)
                    .map((bullet) => (showFullDetail ? bullet : truncateText(bullet, 140)));
                  return (
                    <div key={i} className={`rounded-xl border p-4 ${colorClass}`}>
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <div className={`text-xs font-bold uppercase tracking-wider ${SECTION_COLORS[s.heading!] || 'text-slate-600'}`}>
                          {s.heading}
                        </div>
                        <ExpandButton onClick={() => setExpandedProjectionHeading(s.heading || null)} />
                      </div>
                      <ul className="space-y-2 text-slate-700 text-sm leading-relaxed">
                        {bullets.map((bullet, bulletIndex) => (
                          <li key={bulletIndex} className="flex gap-2">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
                            <span style={showFullDetail ? projectionBulletStyle : undefined}>{bullet}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
            </div>
          )}

          {!showFullDetail && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setShowFullDetail(true)}
                className="rounded-full border border-slate-200 bg-slate-50 px-4 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
              >
                Show full analysis
              </button>
            </div>
          )}

          {showFullDetail && shouldShowNewsCatalysts && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <h4 className="font-bold text-sm uppercase tracking-wide mb-2 text-slate-700">
                News & Catalysts Used
              </h4>

              {newsCatalystsSection && (
                <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-line">
                  {newsCatalystsSection.content}
                </div>
              )}

              {visibleHeadlines.length > 0 && (
                <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                  {visibleHeadlines.map((headline) => (
                    <div
                      key={headline}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                    >
                      {headline}
                    </div>
                  ))}
                </div>
              )}

              {visibleTransmissionSignals.length > 0 && (
                <div className="mt-4 space-y-2">
                  {visibleTransmissionSignals.map((signal) => (
                    <div
                      key={signal}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
                    >
                      {signal}
                    </div>
                  ))}
                </div>
              )}

              {visibleSignals.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {visibleSignals.map((signal) => (
                    <span
                      key={signal}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700"
                    >
                      {signal}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {showFullDetail && sections
            .filter(s => !isProjectionSection(s.heading) && !isProjectionDetailSection(s.heading) && s.heading !== 'NEWS & CATALYSTS')
            .map((s, i) => (
              <div key={i}>
                {s.heading && (
                  <h4 className={`font-bold text-sm uppercase tracking-wide mb-2 ${SECTION_COLORS[s.heading] || 'text-slate-700'}`}>
                    {s.heading}
                  </h4>
                )}
                <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-line">
                  {s.content}
                </div>
              </div>
            ))}

          {showFullDetail && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setShowFullDetail(false)}
                className="rounded-full border border-slate-200 bg-slate-50 px-4 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
              >
                Show less
              </button>
            </div>
          )}

          {status === 'streaming' && (
            <span className="inline-block w-2 h-4 bg-slate-500 rounded-sm animate-pulse ml-0.5" />
          )}
        </div>
      )}

      {lastRun && status === 'done' && (
        <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
          <span>Last analyzed: {lastRun.toLocaleTimeString()}</span>
          <button onClick={runAnalysis} className="text-slate-600 hover:text-slate-900 font-medium">
            Refresh →
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className={isLight ? undefined : 'rounded-2xl overflow-hidden'} style={isLight ? undefined : {
      boxShadow: '0 4px 24px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
    }}>
      {isLight ? (
        <Card surface="light" className="overflow-hidden">
          <div className={`flex items-center justify-between gap-4 border-b border-slate-100 ${compact ? 'px-4 py-3' : 'px-5 py-4'}`}>
            <div className="min-w-0 flex-1 flex items-center gap-3">
              {icon && icon !== 'AI' ? <span className={`${compact ? 'text-xl' : 'text-2xl'} shrink-0`}>{icon}</span> : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className={`font-semibold tracking-[-0.02em] text-slate-900 leading-tight ${compact ? 'text-base' : 'text-lg'}`}>{title}</h3>
                  {hasCachedContent && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      Cached
                    </span>
                  )}
                  {isBusy && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      Refreshing
                    </span>
                  )}
                </div>
                <p className={`truncate text-slate-500 ${compact ? 'text-sm mt-0.5' : 'text-sm'}`}>{summaryText}</p>
                {lastRunLabel && (
                  <p className="text-xs text-slate-400 mt-1">Last updated {lastRunLabel}</p>
                )}
              </div>
              {collapsible && (
                <button
                  type="button"
                  onClick={() => setIsExpanded((current) => !current)}
                  className="shrink-0 rounded-xl border border-slate-200 bg-white p-2 text-slate-600 transition hover:bg-slate-50"
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? 'Collapse analysis' : 'Expand analysis'}
                >
                  <svg
                    className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              )}
            </div>
            <button
              onClick={runAnalysis}
              disabled={isBusy}
              className={`shrink-0 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                isBusy
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-slate-900 hover:bg-slate-800 text-white'
              }`}
            >
              {status === 'loading' ? 'Starting...' :
               status === 'streaming' ? 'Refreshing...' :
               status === 'done' ? 'Refresh' : 'Generate'}
            </button>
          </div>
          {showContent && (
            <div className={compact ? 'p-4' : 'p-5'}>
              {renderBody()}
            </div>
          )}
        </Card>
      ) : (
        <>
      {/* Header */}
      <div className={`bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white ${compact ? 'px-4 py-3' : 'p-5'} flex items-center justify-between gap-4`}>
        <div className="min-w-0 flex-1 flex items-center gap-3">
          <span className={`${compact ? 'text-xl' : 'text-2xl'} shrink-0`}>{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={`font-bold leading-tight ${compact ? 'text-base' : 'text-lg'}`}>{title}</h3>
              {hasCachedContent && (
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-200">
                  Cached
                </span>
              )}
              {isBusy && (
                <span className="rounded-full bg-indigo-400/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-100">
                  Refreshing
                </span>
              )}
            </div>
            <p className={`truncate text-slate-300 ${compact ? 'text-sm mt-0.5' : 'text-sm'}`}>{summaryText}</p>
            {lastRunLabel && (
              <p className="text-xs text-slate-400 mt-1">Last updated {lastRunLabel}</p>
            )}
          </div>
          {collapsible && (
            <button
              type="button"
              onClick={() => setIsExpanded((current) => !current)}
              className="shrink-0 rounded-xl border border-white/10 bg-white/5 p-2 text-slate-200 transition hover:bg-white/10"
              aria-expanded={isExpanded}
              aria-label={isExpanded ? 'Collapse analysis' : 'Expand analysis'}
            >
              <svg
                className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}
        </div>
        <button
          onClick={runAnalysis}
          disabled={isBusy}
          className={`shrink-0 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
            isBusy
              ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
              : 'bg-indigo-500 hover:bg-indigo-400 text-white shadow-lg shadow-indigo-900/40'
          }`}
        >
          {status === 'loading' ? 'Starting...' :
           status === 'streaming' ? 'Refreshing...' :
           status === 'done' ? 'Refresh' : 'Generate'}
        </button>
      </div>

      {/* Body */}
      {showContent && (
      <div className="bg-white/95 backdrop-blur-sm p-5">
        {renderBody()}
      </div>
      )}
        </>
      )}

      {expandedProjectionHeading && (
        <ChartModal
          wide={true}
          onClose={() => setExpandedProjectionHeading(null)}
          title={
            <div>
              <div className="text-[22px] font-semibold tracking-[-0.025em] text-slate-900">{expandedProjectionHeading}</div>
              <div className="mt-1 text-sm text-slate-500">Expanded logic, supporting data, and catalyst context for this timeframe.</div>
            </div>
          }
        >
          <div className="h-full overflow-y-auto px-4 py-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Summary Bullets</div>
                <ul className="mt-4 space-y-3 text-sm leading-relaxed text-slate-700">
                  {buildProjectionBullets(sections.find((section) => section.heading === expandedProjectionHeading)?.content || '', 3).map((bullet, index) => (
                    <li key={index} className="flex gap-3">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">Full Logic</div>
                <div className="mt-4 whitespace-pre-line text-sm leading-7 text-slate-800">
                  {expandedProjectionDetail || buildFallbackProjectionDetail(expandedProjectionHeading, payload)}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
              {showNewsCatalysts && (visibleHeadlines.length > 0 || visibleSignals.length > 0 || visibleTransmissionSignals.length > 0) && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 xl:col-span-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">News & Catalysts Used</div>
                  {visibleHeadlines.length > 0 && (
                    <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                      {visibleHeadlines.map((headline) => (
                        <div
                          key={headline}
                          className="rounded-xl border border-amber-200 bg-white/80 px-3 py-2 text-sm text-slate-700"
                        >
                          {headline}
                        </div>
                      ))}
                    </div>
                  )}
                  {visibleTransmissionSignals.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {visibleTransmissionSignals.map((signal) => (
                        <div
                          key={signal}
                          className="rounded-xl border border-orange-200 bg-white/80 px-3 py-2 text-sm text-slate-700"
                        >
                          {signal}
                        </div>
                      ))}
                    </div>
                  )}
                  {visibleSignals.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {visibleSignals.map((signal) => (
                        <span
                          key={signal}
                          className="rounded-full border border-amber-300 bg-white/80 px-3 py-1 text-xs font-medium text-amber-900"
                        >
                          {signal}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {marketOverviewSection && (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">Market Overview</div>
                  <div className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-700">{marketOverviewSection.content}</div>
                </div>
              )}

              {realEstateImplicationsSection && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Real Estate Implications</div>
                  <div className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-700">{realEstateImplicationsSection.content}</div>
                </div>
              )}

              {keyRisksSection && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">Key Risks</div>
                  <div className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-700">{keyRisksSection.content}</div>
                </div>
              )}
            </div>
          </div>
        </ChartModal>
      )}
    </div>
  );
};

export default MarketAIAnalysis;
