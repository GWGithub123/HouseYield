import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import FedMeetingSummary from '../components/FedMeetingSummary';
import MarketAIAnalysis from '../components/MarketAIAnalysis';
import MyRegionTab from '../components/MyRegionTab';
import RegionalHeatMap, { preloadRegionalHeatMap } from '../components/RegionalHeatMap';
import WorkspaceTabsHeader from '../components/WorkspaceTabsHeader';
import RentalPropertyCalculatorModal from '../components/market/RentalPropertyCalculatorModal';
import {
  MARKET_INSIGHTS_ASSET_METADATA,
  inferMarketInsightsTabFromAsset,
  isMarketInsightsAssetId,
  type MarketInsightsAssetId,
  type MarketInsightsTabId,
} from '../components/market/marketInsightsAssets';
import { AnalyticsCard, ChartModal, ExpandButton, SegmentedToggle } from '../components/charts/AnalyticsFrame';
import { Card, KpiStrip, PageShell, SectionHeader as DsSectionHeader, SubTabs } from '../design-system';
import { loadGoogleMaps } from '../utils/googleMaps';
import { formatCurrency, formatPercentage } from '../utils/formatting';
import { useVoiceActionHandler } from '../contexts/VoiceCommandContext';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

type ChartVariant = 'compact' | 'expanded';

type StockChartTimePeriod = 'quarterly' | 'annual' | 'ttm';

type OverviewChartLookback = '1y' | '5y' | '10y' | 'max';
const OVERVIEW_CHART_LOOKBACK_OPTIONS: Array<{ value: OverviewChartLookback; label: string }> = [
  { value: '1y', label: '1Y' },
  { value: '5y', label: '5Y' },
  { value: '10y', label: '10Y' },
  { value: 'max', label: 'Max' },
];
function getVisibleAxisIndices(length: number, maxLabels: number): number[] {
  if (length <= maxLabels) return Array.from({ length }, (_, index) => index);
  const indices = new Set<number>();
  for (let index = 0; index < maxLabels; index++) {
    indices.add(Math.round(((length - 1) * index) / (maxLabels - 1)));
  }
  return Array.from(indices).sort((left, right) => left - right);
}

function formatCompactCurrency(value: number): string {
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue >= 1_000_000_000_000) {
    return `${sign}$${(absValue / 1_000_000_000_000).toFixed(absValue >= 10_000_000_000_000 ? 1 : 2)}T`;
  }
  if (absValue >= 1_000_000_000) {
    return `${sign}$${(absValue / 1_000_000_000).toFixed(absValue >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (absValue >= 1_000_000) {
    return `${sign}$${(absValue / 1_000_000).toFixed(absValue >= 10_000_000 ? 0 : 1)}M`;
  }
  if (absValue >= 1_000) {
    return `${sign}$${(absValue / 1_000).toFixed(absValue >= 10_000 ? 0 : 1)}k`;
  }
  return `${sign}$${absValue.toFixed(0)}`;
}

function formatStockBarTooltipValue(
  value: number,
  options: { isPercentage: boolean; isCurrency: boolean; dataInThousands: boolean }
): string {
  if (options.isPercentage) return formatPercentage(value);
  if (options.isCurrency) {
    const actualValue = options.dataInThousands ? value * 1000 : value;
    if (Math.abs(actualValue) >= 1_000_000) return formatCompactCurrency(actualValue);
    return formatCurrency(actualValue);
  }
  return value.toFixed(2);
}

function formatStockBarAxisValue(
  value: number,
  options: { isPercentage: boolean; isCurrency: boolean; dataInThousands: boolean }
): string {
  if (options.isPercentage) return `${value.toFixed(0)}%`;
  if (options.isCurrency) {
    const actualValue = options.dataInThousands ? value * 1000 : value;
    return formatCompactCurrency(actualValue);
  }
  return value.toFixed(0);
}

const generateYearLabels = (count: number, isQuarterly: boolean = false, startYear?: number): string[] => {
  const baseYear = startYear ?? new Date().getFullYear();
  const labels: string[] = [];
  if (isQuarterly) {
    for (let i = 0; i < count; i++) {
      const q = (i % 4) + 1;
      const y = baseYear + Math.floor(i / 4);
      labels.push(`${q}Q${y}`);
    }
  } else {
    for (let i = 0; i < count; i++) labels.push(`${baseYear + i}`);
  }
  return labels;
};
function getNiceContinuousAxis(
  minValue: number,
  maxValue: number,
  targetTickCount: number = 6,
  options: { minFloor?: number; paddingRatio?: number } = {},
) {
  const { minFloor, paddingRatio = 0.08 } = options;
  const safeMin = Number.isFinite(minValue) ? minValue : 0;
  const safeMax = Number.isFinite(maxValue) ? maxValue : safeMin + 1;

  if (safeMin === safeMax) {
    const padding = safeMin === 0 ? 1 : Math.abs(safeMin) * 0.12;
    const niceMin = minFloor !== undefined ? Math.max(minFloor, safeMin - padding) : safeMin - padding;
    const niceMax = safeMax + padding;
    const step = (niceMax - niceMin) / Math.max(targetTickCount - 1, 1);
    return {
      niceMin,
      niceMax,
      ticks: Array.from({ length: targetTickCount }, (_, index) => niceMin + index * step),
    };
  }

  const paddedMin = minFloor !== undefined
    ? Math.max(minFloor, safeMin - (safeMax - safeMin) * paddingRatio)
    : safeMin - (safeMax - safeMin) * paddingRatio;
  const paddedMax = safeMax + (safeMax - safeMin) * paddingRatio;
  const roughStep = Math.max((paddedMax - paddedMin) / Math.max(targetTickCount - 1, 1), 1e-6);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;

  let niceStep = 1;
  if (normalized > 1) niceStep = 2;
  if (normalized > 2) niceStep = 2.5;
  if (normalized > 2.5) niceStep = 5;
  if (normalized > 5) niceStep = 10;
  niceStep *= magnitude;

  const niceMin = minFloor !== undefined
    ? Math.max(minFloor, Math.floor(paddedMin / niceStep) * niceStep)
    : Math.floor(paddedMin / niceStep) * niceStep;
  const niceMax = Math.ceil(paddedMax / niceStep) * niceStep;
  const tickCount = Math.max(2, Math.round((niceMax - niceMin) / niceStep) + 1);

  return {
    niceMin,
    niceMax,
    ticks: Array.from({ length: tickCount }, (_, index) => niceMin + index * niceStep),
  };
}
const SurfaceCard = ({ children, className = '' }: { children: React.ReactNode; className?: string; accent?: string }) => (
  <Card surface="light" className={className}>
    {children}
  </Card>
);

const MacroMetricCard = ({
  eyebrow,
  title,
  value,
  meta,
  accent,
  deltas,
  note,
}: {
  eyebrow: string;
  title: string;
  value: string;
  meta: string;
  accent: string;
  deltas: Array<{ label: string; value: string; toneClass: string }>;
  note?: string;
}) => (
  <Card surface="light" className="w-full" compact>
    <div className="flex items-start justify-between gap-2.5">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{eyebrow}</div>
        <div className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-slate-900">{title}</div>
      </div>
      <span className="mt-1 h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
    </div>
    <div className="mt-2.5 flex items-end justify-between gap-2.5">
      <div className="text-[30px] font-semibold leading-none tracking-[-0.04em] text-slate-950">{value}</div>
      <div className="max-w-[7rem] text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">{meta}</div>
    </div>
    {deltas.length > 0 && (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {deltas.map((delta) => (
          <div key={delta.label} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${delta.toneClass}`}>
            {delta.label}: {delta.value}
          </div>
        ))}
      </div>
    )}
    {note && <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] leading-relaxed text-slate-500">{note}</div>}
  </Card>
);

const MacroTrendCard = ({
  title,
  description,
  accent,
  controls,
  children,
}: {
  title: string;
  description: string;
  accent: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <Card surface="light" className="min-h-[292px]" compact>
    <div className="flex items-start justify-between gap-2.5">
      <div>
        <div className="text-[15px] font-semibold tracking-[-0.02em] text-slate-900">{title}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{description}</div>
      </div>
      <div className="shrink-0">{controls}</div>
    </div>
    <div className="mt-2.5 h-[215px]">{children}</div>
  </Card>
);
const MarketInsightsPage = () => {
  const [searchParams] = useSearchParams();
  const [housingData, setHousingData] = useState<any>(null);
  const [regionalData, setRegionalData] = useState<any>(null);
  const [predictions, setPredictions] = useState<any>(null); // Polymarket predictions
  const [treasuryYields, setTreasuryYields] = useState<any>(null);
  const [macroData, setMacroData] = useState<any>(null);
  const [zipMarketZipCode, setZipMarketZipCode] = useState('');
  const [zipMarketData, setZipMarketData] = useState<any>(null);
  const [zipMarketLoading, setZipMarketLoading] = useState(false);
  const [zipMarketError, setZipMarketError] = useState<string | null>(null);
  const [beveridgeRegion, setBeveridgeRegion] = useState<string>('national');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'your-area' | 'economy-fed'>('overview');
  const [yourAreaSubTab, setYourAreaSubTab] = useState<'my-location' | 'compare-metros'>('my-location');
  const [segmentDetailsOpen, setSegmentDetailsOpen] = useState(false);
  const [expandedOverviewChart, setExpandedOverviewChart] = useState<'home-price' | 'market-mortgage' | 'inventory' | 'ten-year' | 'thirty-year' | 'yield-spread' | null>(null);
  const [overviewChartGranularity, setOverviewChartGranularity] = useState<'quarterly' | 'annual'>('quarterly');
  const [overviewChartLookback, setOverviewChartLookback] = useState<OverviewChartLookback>('5y');
  const [showRentalCalculatorModal, setShowRentalCalculatorModal] = useState(false);
  const [economyChartGranularity, setEconomyChartGranularity] = useState<'quarterly' | 'annual'>('quarterly');
  const [expandedEconomyChart, setExpandedEconomyChart] = useState<string | null>(null);
  const [showAdvancedAnalytics, setShowAdvancedAnalytics] = useState(false);

  const focusMortgageRate = useCallback(() => {
    setActiveTab('overview');
    setExpandedOverviewChart('thirty-year');
  }, []);

  const focusTreasuryYields = useCallback(() => {
    setActiveTab('overview');
    setExpandedOverviewChart('ten-year');
  }, []);

  const focusFedSummary = useCallback(() => {
    setActiveTab('economy-fed');
    setExpandedOverviewChart(null);
    setExpandedEconomyChart(null);
  }, []);

  useVoiceActionHandler('view-mortgage-rate', focusMortgageRate, [focusMortgageRate]);
  useVoiceActionHandler('view-treasury-yields', focusTreasuryYields, [focusTreasuryYields]);
  useVoiceActionHandler('view-fed-meeting', focusFedSummary, [focusFedSummary]);
  
  // Regional search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<any>(null);
  const [regionLoading, setRegionLoading] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [metroZips, setMetroZips] = useState<any>(null);
  const marketEmbed = ['1', 'true', 'yes'].includes((searchParams.get('marketEmbed') || searchParams.get('embed') || '').toLowerCase());
  const requestedMarketAsset = searchParams.get('marketAsset');
  const focusedMarketAsset = isMarketInsightsAssetId(requestedMarketAsset) ? requestedMarketAsset : null;
  const requestedMarketTab = searchParams.get('marketTab');
  // Legacy deep-links may still request the pre-merge tab ids (economy/fed/regional/my-region);
  // map those onto the merged Your Area / Economy & Fed tabs.
  const legacyTabToMergedTab: Record<string, 'overview' | 'your-area' | 'economy-fed'> = {
    overview: 'overview',
    economy: 'economy-fed',
    fed: 'economy-fed',
    regional: 'your-area',
    'my-region': 'your-area',
  };
  const forcedMarketTab = requestedMarketTab && legacyTabToMergedTab[requestedMarketTab]
    ? legacyTabToMergedTab[requestedMarketTab]
    : (() => {
        const assetTab = inferMarketInsightsTabFromAsset(focusedMarketAsset);
        return assetTab ? legacyTabToMergedTab[assetTab] : null;
      })();
  const assetOnlyMode = marketEmbed && Boolean(focusedMarketAsset);
  const resolvedActiveTab = (forcedMarketTab ?? activeTab) as 'overview' | 'your-area' | 'economy-fed';

  const matchesFocusedMarketAsset = (...assetIds: MarketInsightsAssetId[]) => (
    !assetOnlyMode || (focusedMarketAsset ? assetIds.includes(focusedMarketAsset) : false)
  );

  useEffect(() => {
    preloadRegionalHeatMap('housing');
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchMarketData = async () => {
      try {
        setLoading(true);
        const [housingRes, regionalRes, yieldsRes, macroRes] = await Promise.all([
          fetch(`${API_BASE}/api/fred/housing-market`),
          fetch(`${API_BASE}/api/fred/regional-market`),
          fetch(`${API_BASE}/api/fred/treasury-yields?days=3650`),
          fetch(`${API_BASE}/api/fred/macro-indicators`)
        ]);

        if (!housingRes.ok || !regionalRes.ok) {
          throw new Error('Failed to fetch market data');
        }

        const housingJson = await housingRes.json();
        const regionalJson = await regionalRes.json();
        const yieldsJson = await yieldsRes.json();
        const macroJson = await macroRes.json();

        if (!housingJson.ok || !regionalJson.ok) {
          throw new Error(housingJson.error || regionalJson.error || 'API error');
        }

        if (cancelled) {
          return;
        }

        setHousingData(housingJson.data);
        setRegionalData(regionalJson.data);

        if (yieldsJson.ok) {
          setTreasuryYields(yieldsJson.data);
        }

        if (macroJson.ok) {
          setMacroData(macroJson.data);
        }
      } catch (err: any) {
        console.error('Error fetching FRED data:', err);
        if (!cancelled) {
          setError(err.message || 'Failed to load market data');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    const fetchPredictions = async () => {
      try {
        const predictionsRes = await fetch(`${API_BASE}/api/polymarket/predictions`);
        const predictionsJson = await predictionsRes.json();
        if (!cancelled && predictionsJson.ok) {
          setPredictions(predictionsJson.predictions);
        }
      } catch (err) {
        console.error('Error fetching market predictions:', err);
      }
    };

    fetchMarketData();
    void fetchPredictions();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSearchChange = async (value: string) => {
    setSearchQuery(value);
    if (value.trim().length < 2) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/fred/regions/search?q=${encodeURIComponent(value)}`);
      const json = await res.json();
      if (json.ok) {
        setSearchResults(json.data);
        setShowSearchResults(true);
      }
    } catch (err) {
      console.error('Search error:', err);
    }
  };

  const handleSelectRegion = async (regionCode: string) => {
    setRegionLoading(true);
    setShowSearchResults(false);
    setMetroZips(null);
    try {
      const res = await fetch(`${API_BASE}/api/fred/regions/${regionCode}`);
      const json = await res.json();
      if (json.ok) {
        setSelectedRegion(json.data);
      }
    } catch (err) {
      console.error('Region load error:', err);
    } finally {
      setRegionLoading(false);
    }

    fetch(`${API_BASE}/api/rentcast/metro-zips?metro=${encodeURIComponent(regionCode)}`)
      .then((response) => response.json())
      .then((json) => { if (json.ok) setMetroZips(json.data); })
      .catch(() => {});
  };

  const formatCurrency = (value: string | number) => {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(num);
  };

  const formatPercentChange = (value: string | number | null) => {
    if (value === null || value === undefined || value === 'N/A') return 'N/A';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return 'N/A';
    const sign = num >= 0 ? '+' : '';
    return `${sign}${num}%`;
  };

  const formatNumber = (value: string | number) => {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return 'N/A';
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(num);
  };

  const formatThousandsDisplay = (value: string | number | null) => {
    if (value === null || value === undefined || value === 'N/A') return 'N/A';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (!Number.isFinite(num)) return 'N/A';
    if (num >= 1000) {
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(num / 1000)}k`;
    }
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(num);
  };

  const formatDecimal = (value: string | number | null, digits = 2) => {
    if (value === null || value === undefined || value === 'N/A') return 'N/A';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(num);
  };

  const buildMacroDelta = (
    label: string,
    value: string | number | null | undefined,
    options?: { digits?: number; suffix?: string; positiveIsGood?: boolean }
  ) => {
    if (value === null || value === undefined || value === 'N/A') return null;
    const numericValue = typeof value === 'string' ? parseFloat(value) : value;
    if (!Number.isFinite(numericValue)) return null;

    const digits = options?.digits ?? 1;
    const suffix = options?.suffix ? ` ${options.suffix}` : '';
    const positiveIsGood = options?.positiveIsGood ?? true;
    const isPositive = numericValue >= 0;
    const toneClass = positiveIsGood
      ? (isPositive ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')
      : (isPositive ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700');

    return {
      label,
      value: `${numericValue >= 0 ? '+' : ''}${numericValue.toFixed(digits)}${suffix}`,
      toneClass,
    };
  };

  const isNonNull = <T,>(value: T | null | undefined): value is T => value != null;

  const buildBucketLabel = (date: Date, granularity: 'quarterly' | 'annual') => {
    if (granularity === 'annual') {
      return `${date.getFullYear()}`;
    }
    const quarter = Math.floor(date.getMonth() / 3) + 1;
    return `Q${quarter} '${String(date.getFullYear()).slice(-2)}`;
  };

  const filterMarketSeriesByLookback = (series: any[] | undefined, lookback: OverviewChartLookback) => {
    if (!Array.isArray(series) || lookback === 'max') return series;

    const lookbackYears = lookback === '1y' ? 1 : lookback === '5y' ? 5 : 10;
    const validTimestamps = series
      .map((point: any) => {
        const parsedDate = new Date(point?.date);
        return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.getTime();
      })
      .filter((timestamp: number | null): timestamp is number => timestamp !== null);

    if (validTimestamps.length === 0) return series;

    const latestTimestamp = Math.max(...validTimestamps);
    const cutoffDate = new Date(latestTimestamp);
    cutoffDate.setFullYear(cutoffDate.getFullYear() - lookbackYears);
    const cutoffTimestamp = cutoffDate.getTime();

    return series.filter((point: any) => {
      const parsedDate = new Date(point?.date);
      return !Number.isNaN(parsedDate.getTime()) && parsedDate.getTime() >= cutoffTimestamp;
    });
  };

  const aggregateMarketSeries = (series: any[] | undefined, granularity: 'quarterly' | 'annual') => {
    if (!Array.isArray(series)) return { values: [] as number[], labels: [] as string[] };

    const buckets = new Map<string, { label: string; value: number; timestamp: number }>();
    series.forEach((point: any) => {
      const numericValue = typeof point?.value === 'string' ? parseFloat(point.value) : Number(point?.value);
      if (!Number.isFinite(numericValue)) return;

      const parsedDate = new Date(point.date);
      if (Number.isNaN(parsedDate.getTime())) return;

      const bucketKey = granularity === 'annual'
        ? `${parsedDate.getFullYear()}`
        : `${parsedDate.getFullYear()}-Q${Math.floor(parsedDate.getMonth() / 3) + 1}`;

      const existing = buckets.get(bucketKey);
      if (!existing || parsedDate.getTime() >= existing.timestamp) {
        buckets.set(bucketKey, {
          label: buildBucketLabel(parsedDate, granularity),
          value: numericValue,
          timestamp: parsedDate.getTime(),
        });
      }
    });

    const ordered = Array.from(buckets.values()).sort((left, right) => left.timestamp - right.timestamp);
    return {
      values: ordered.map((entry) => entry.value),
      labels: ordered.map((entry) => entry.label),
    };
  };

  const loadZipMarketData = async (zipCode: string) => {
    const normalizedZipCode = zipCode.trim();
    if (!/^\d{5}$/.test(normalizedZipCode)) {
      setZipMarketError('Enter a valid 5-digit ZIP code.');
      return;
    }

    setZipMarketLoading(true);
    setZipMarketError(null);

    try {
      const response = await fetch(`${API_BASE}/api/rentcast/markets?zipCode=${encodeURIComponent(normalizedZipCode)}`);
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json.error || 'Failed to load ZIP market data');
      }
      setZipMarketData(json.data);
      setZipMarketZipCode(normalizedZipCode);
    } catch (err: any) {
      console.error('ZIP market load error:', err);
      setZipMarketData(null);
      setZipMarketError(err.message || 'Failed to load ZIP market data');
    } finally {
      setZipMarketLoading(false);
    }
  };

  // Thin alias — prefer Card + SectionHeader directly; keeps data-* attrs on wrapper when needed.
  const GlassCard = ({ children, className = '', gradient: _g, accent: _a, ...rest }: { children: React.ReactNode; className?: string; gradient?: boolean; accent?: string } & React.HTMLAttributes<HTMLDivElement>) => (
    <div {...rest}>
      <Card surface="light" className={className?.replace(/\bp-\d+\b/g, '').replace(/\s+/g, ' ').trim() || undefined}>
        {children}
      </Card>
    </div>
  );

  const StatCard = ({ label, value, change, changeLabel = 'YoY', positive = true }: {
    label: string; value: string; change?: string | number | null; changeLabel?: string; positive?: boolean; icon?: string
  }) => {
    const changeNum = change ? (typeof change === 'string' ? parseFloat(change) : change) : null;
    const isPositive = changeNum !== null && !isNaN(changeNum) && changeNum >= 0;
    const changeColor = positive
      ? (isPositive ? 'text-emerald-600' : 'text-rose-600')
      : (isPositive ? 'text-rose-600' : 'text-emerald-600');

    return (
      <Card surface="light" compact>
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
        <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{value}</div>
        {changeNum !== null && !isNaN(changeNum) && (
          <div className={`mt-1.5 text-xs font-medium ${changeColor}`}>
            {isPositive ? '↑' : '↓'} {formatPercentChange(change ?? null)} {changeLabel}
          </div>
        )}
      </Card>
    );
  };

  const SectionHeader = ({ title, description, badge }: { title: string; description?: string; badge?: string }) => (
    <DsSectionHeader
      label={title}
      description={description}
      action={badge ? (
        <div className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          {badge}
        </div>
      ) : undefined}
    />
  );

  const renderMarketLoadingState = () => (
    <div className="text-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
      <p className="text-slate-600">Loading market data from FRED...</p>
    </div>
  );

  const renderMarketErrorState = () => (
    <div className="text-center">
      <div className="text-rose-600 text-lg font-medium mb-2">Error Loading Data</div>
      <p className="text-slate-600">{error}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
      >
        Retry
      </button>
    </div>
  );

  const tabs: Array<{ id: 'overview' | 'your-area' | 'economy-fed'; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'your-area', label: 'Your Area' },
    { id: 'economy-fed', label: 'Economy & Fed' },
  ];

  const renderMarketShellState = (content: React.ReactNode) => (
    <PageShell
      header={
        <WorkspaceTabsHeader
          eyebrow="Market Insights"
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab)}
          tabs={tabs}
        />
      }
    >
      <div className="flex min-h-[50vh] items-center justify-center py-6">
        {content}
      </div>
    </PageShell>
  );

  if (loading) {
    if (marketEmbed) {
      return <div className="flex items-center justify-center p-6">{renderMarketLoadingState()}</div>;
    }

    return renderMarketShellState(renderMarketLoadingState());
  }

  if (error) {
    if (marketEmbed) {
      return <div className="flex items-center justify-center p-6">{renderMarketErrorState()}</div>;
    }

    return renderMarketShellState(renderMarketErrorState());
  }

  const overview = housingData?.overview || {};
  const trends = housingData?.trends || {};
  const metros = regionalData?.metros || [];
  const overviewMetricCards = [
    {
      assetId: 'overview-metric-median-home-price' as const,
      label: 'Median Home Price',
      value: formatCurrency(overview.medianPrice?.value || 'N/A'),
      change: overview.medianPrice?.yoy,
      changeLabel: `YoY${overview.medianPrice?.date ? ` · ${overview.medianPrice.date}` : ''}`,
    },
    {
      assetId: 'overview-metric-inventory-months' as const,
      label: 'Inventory (Months)',
      value: overview.inventory?.value || 'N/A',
      change: overview.inventory?.yoy,
      changeLabel: `YoY${overview.inventory?.date ? ` · ${overview.inventory.date}` : ''}`,
      positive: false,
    },
    {
      assetId: 'overview-metric-days-on-market' as const,
      label: 'Days on Market',
      value: overview.daysOnMarket?.value ? parseFloat(overview.daysOnMarket.value).toLocaleString() : 'N/A',
      change: overview.daysOnMarket?.yoy,
      changeLabel: `YoY${overview.daysOnMarket?.date ? ` · ${overview.daysOnMarket.date}` : ''}`,
      positive: false,
    },
    {
      assetId: 'overview-metric-30-year-mortgage' as const,
      label: '30-Year Mortgage',
      value: overview.mortgageRate?.value ? `${parseFloat(overview.mortgageRate.value).toFixed(2)}%` : 'N/A',
      change: overview.mortgageRate?.change,
      changeLabel: `this period${overview.mortgageRate?.date ? ` · ${overview.mortgageRate.date}` : ''}`,
      positive: false,
    },
  ];
  const mortgageRateValue = parseFloat(overview.mortgageRate?.value ?? 0);
  const tenYearValue = parseFloat(treasuryYields?.yields?.tenYear?.current ?? 0);
  const twoYearValue = parseFloat(treasuryYields?.yields?.twoYear?.current ?? 0);
  const curveValue = parseFloat(treasuryYields?.yields?.yieldSpread?.current ?? 0);
  const mortgageMonthlyChange = parseFloat(treasuryYields?.yields?.mortgageRate?.changes?.['1month']?.absolute ?? overview.mortgageRate?.change ?? 0);
  const tenYearMonthlyChange = parseFloat(treasuryYields?.yields?.tenYear?.changes?.['1month']?.absolute ?? 0);
  const mortgageSpreadBps = mortgageRateValue && tenYearValue ? Math.round((mortgageRateValue - tenYearValue) * 100) : null;

  const financingRegime = (() => {
    if (mortgageRateValue >= 6.75 || (mortgageSpreadBps !== null && mortgageSpreadBps >= 240)) {
      return {
        label: 'Restrictive',
        tone: 'rose',
        summary: `Financing is still restrictive. The 30-year mortgage rate sits at ${mortgageRateValue.toFixed(2)}%, and the all-in borrowing cost remains a headwind for affordability and leveraged acquisition yields.`,
      };
    }
    if (mortgageRateValue >= 5.75 || (mortgageSpreadBps !== null && mortgageSpreadBps >= 180)) {
      return {
        label: 'Tight but functional',
        tone: 'amber',
        summary: `Financing is available, but not easy. Mortgage pricing is elevated enough that debt-service math is still constraining buyer demand even though lender spreads are no longer distressed.`,
      };
    }
    return {
      label: 'Supportive',
      tone: 'emerald',
      summary: `Financing is comparatively supportive. Base rates and mortgage spreads are both in a range that materially improves affordability and acquisition underwriting.`,
    };
  })();

  const financingToneClasses = financingRegime.tone === 'rose'
    ? 'border-rose-200 bg-rose-50/80 text-rose-700'
    : financingRegime.tone === 'amber'
      ? 'border-amber-200 bg-amber-50/80 text-amber-700'
      : 'border-emerald-200 bg-emerald-50/80 text-emerald-700';

  const financingHighlights = [
    {
      assetId: 'overview-financing-30-year-mortgage' as const,
      label: '30-Year Mortgage',
      value: mortgageRateValue ? `${mortgageRateValue.toFixed(2)}%` : 'N/A',
      note: Number.isFinite(mortgageMonthlyChange)
        ? `${mortgageMonthlyChange >= 0 ? '+' : ''}${mortgageMonthlyChange.toFixed(2)} pts over the last month`
        : 'Monthly move unavailable',
    },
    {
      assetId: 'overview-financing-10y-2y-spread' as const,
      label: 'Mortgage Spread',
      value: mortgageSpreadBps !== null ? `${mortgageSpreadBps} bps` : 'N/A',
      note: mortgageSpreadBps !== null
        ? `${mortgageSpreadBps > 200 ? 'Above' : 'Near'} the ~170 bps long-run average`
        : 'Spread unavailable',
    },
    {
      assetId: 'overview-financing-10-year-treasury' as const,
      label: 'Curve Signal',
      value: Number.isFinite(curveValue) ? `${curveValue.toFixed(2)}%` : 'N/A',
      note: Number.isFinite(twoYearValue) && Number.isFinite(tenYearValue)
        ? `10Y ${tenYearValue.toFixed(2)}% vs 2Y ${twoYearValue.toFixed(2)}%`
        : 'Treasury curve unavailable',
    },
  ];

  const financingBulletPoints = [
    Number.isFinite(tenYearMonthlyChange)
      ? `The 10-year Treasury moved ${tenYearMonthlyChange >= 0 ? 'up' : 'down'} ${Math.abs(tenYearMonthlyChange).toFixed(2)} points over the past month, which is the main driver behind mortgage repricing.`
      : 'The latest Treasury move is unavailable.',
    mortgageSpreadBps !== null
      ? `At ${mortgageSpreadBps} bps, the mortgage-to-Treasury spread suggests today’s financing drag is being driven more by the absolute level of rates than by lender dislocation.`
      : 'Mortgage spread data is unavailable.',
    Number.isFinite(curveValue)
      ? `${curveValue >= 0 ? 'The curve is positively sloped again' : 'The curve remains inverted'}, which matters for recession risk, bank funding conditions, and how much refinancing relief the market can realistically expect.`
      : 'Treasury curve signal is unavailable.',
  ];

  const overviewChartControls = (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">View</span>
        <SegmentedToggle
          value={overviewChartGranularity}
          onChange={setOverviewChartGranularity}
          options={[
            { value: 'quarterly', label: 'Quarterly' },
            { value: 'annual', label: 'Annually' },
          ]}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Range</span>
        <SegmentedToggle
          value={overviewChartLookback}
          onChange={setOverviewChartLookback}
          options={OVERVIEW_CHART_LOOKBACK_OPTIONS}
        />
      </div>
    </div>
  );

  const overviewChartDefinitions = [
    {
      assetId: 'overview-chart-10-year-treasury-history' as const,
      key: 'ten-year' as const,
      title: '10-Year Treasury History',
      description: 'Base rate path feeding directly into discount rates and mortgage pricing.',
      color: '#2563eb',
      dataLabel: '10-Year Treasury',
      isPercentage: true,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(filterMarketSeriesByLookback(treasuryYields?.yields?.tenYear?.history, overviewChartLookback), overviewChartGranularity),
    },
    {
      assetId: 'overview-chart-30-year-mortgage-history' as const,
      key: 'thirty-year' as const,
      title: '30-Year Mortgage History',
      description: 'Retail mortgage pricing trend for owner-occupier affordability.',
      color: '#059669',
      dataLabel: '30-Year Mortgage',
      isPercentage: true,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(filterMarketSeriesByLookback(treasuryYields?.yields?.mortgageRate?.history, overviewChartLookback), overviewChartGranularity),
    },
    {
      assetId: 'overview-chart-10y-2y-spread-history' as const,
      key: 'yield-spread' as const,
      title: '10Y-2Y Spread History',
      description: 'Curve shape indicates whether the Treasury term structure is normalizing or flattening again.',
      color: '#7c3aed',
      dataLabel: 'Yield Spread',
      isPercentage: true,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(filterMarketSeriesByLookback(treasuryYields?.yields?.yieldSpread?.history, overviewChartLookback), overviewChartGranularity),
    },
    {
      assetId: 'overview-chart-median-home-price-trend' as const,
      key: 'home-price' as const,
      title: 'Median Home Price Trend',
      description: 'End-of-period national pricing trend based on the freshest housing series available.',
      color: '#0f766e',
      dataLabel: 'Median Home Price',
      isPercentage: false,
      isCurrency: true,
      showArea: true,
      series: aggregateMarketSeries(filterMarketSeriesByLookback(housingData?.charts?.medianPrice, overviewChartLookback), overviewChartGranularity),
    },
    {
      assetId: 'overview-chart-mortgage-rate-trend' as const,
      key: 'market-mortgage' as const,
      title: 'Mortgage Rate Trend',
      description: 'Financing drag or relief as it filters through to household payment burden.',
      color: '#dc2626',
      dataLabel: 'Mortgage Rate',
      isPercentage: true,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(filterMarketSeriesByLookback(housingData?.charts?.mortgageRate, overviewChartLookback), overviewChartGranularity),
    },
    {
      assetId: 'overview-chart-months-supply-of-inventory' as const,
      key: 'inventory' as const,
      title: 'Months Supply of Inventory',
      description: 'Supply pressure is the cleanest direct read on buyer vs seller leverage.',
      color: '#d97706',
      dataLabel: 'Months Supply',
      isPercentage: false,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(filterMarketSeriesByLookback(housingData?.charts?.inventory, overviewChartLookback), overviewChartGranularity),
    },
  ];

  const selectedOverviewChart = overviewChartDefinitions.find((chart) => chart.key === expandedOverviewChart) || null;

  type EconomyMetricCard = {
    assetId:
      | 'economy-metric-initial-jobless-claims'
      | 'economy-metric-consumer-sentiment'
      | 'economy-metric-homeownership-rate'
      | 'economy-metric-core-pce-price-index'
      | 'economy-metric-10y-breakeven-inflation'
      | 'economy-metric-15-year-mortgage-rate'
      | 'economy-metric-new-home-sales'
      | 'economy-metric-rental-vacancy-rate'
      | 'economy-metric-construction-cost-index';
    eyebrow: string;
    title: string;
    value: string;
    meta: string;
    accent: string;
    deltas: Array<NonNullable<ReturnType<typeof buildMacroDelta>>>;
    note: string;
  };

  type EconomyCardSection = {
    key: 'labor' | 'inflation' | 'supply';
    title: string;
    description: string;
    cards: EconomyMetricCard[];
  };

  const economyCardSections: EconomyCardSection[] = macroData ? [
    {
      key: 'labor',
      title: 'Labor Market & Consumer Health',
      description: 'A tighter card treatment keeps the labor-demand and consumer read in one compact row.',
      cards: [
        macroData.joblessClaims?.value ? {
          assetId: 'economy-metric-initial-jobless-claims' as const,
          eyebrow: 'Labor Demand',
          title: 'Initial Jobless Claims',
          value: formatThousandsDisplay(macroData.joblessClaims.value),
          meta: `Weekly update · ${macroData.joblessClaims.date}`,
          accent: '#ef4444',
          deltas: [
            buildMacroDelta('WoW', macroData.joblessClaims.mom, { digits: 1, positiveIsGood: false }),
            buildMacroDelta('YoY', macroData.joblessClaims.yoy, { digits: 1, positiveIsGood: false }),
          ].filter(isNonNull),
          note: 'Lower weekly claims indicate fewer fresh layoffs and a firmer labor market.',
        } : null,
        macroData.consumerSentiment?.value ? {
          assetId: 'economy-metric-consumer-sentiment' as const,
          eyebrow: 'Consumer Pulse',
          title: 'Consumer Sentiment',
          value: formatDecimal(macroData.consumerSentiment.value, 1),
          meta: `Michigan survey · ${macroData.consumerSentiment.date}`,
          accent: '#2563eb',
          deltas: [
            buildMacroDelta('MoM', macroData.consumerSentiment.mom, { digits: 1 }),
            buildMacroDelta('YoY', macroData.consumerSentiment.yoy, { digits: 1 }),
          ].filter(isNonNull),
          note: 'Confidence drives discretionary spending, turnover, and household formation.',
        } : null,
        macroData.homeownershipRate?.value ? {
          assetId: 'economy-metric-homeownership-rate' as const,
          eyebrow: 'Household Mix',
          title: 'Homeownership Rate',
          value: `${formatDecimal(macroData.homeownershipRate.value, 2)}%`,
          meta: `Quarterly read · ${macroData.homeownershipRate.date}`,
          accent: '#16a34a',
          deltas: [
            buildMacroDelta('YoY', macroData.homeownershipRate.yoy, { digits: 2, suffix: 'pp' }),
          ].filter(isNonNull),
          note: 'Higher owner occupancy can reduce turnover in the for-sale market and tighten resale inventory.',
        } : null,
      ].filter(isNonNull),
    },
    {
      key: 'inflation',
      title: 'Inflation & Fed Watch',
      description: 'Inflation, market expectations, and financing cost sit in one tighter policy row.',
      cards: [
        macroData.corePCE?.value ? {
          assetId: 'economy-metric-core-pce-price-index' as const,
          eyebrow: 'Inflation Anchor',
          title: 'Core PCE Price Index',
          value: formatDecimal(macroData.corePCE.value, 1),
          meta: `Index level · ${macroData.corePCE.date}`,
          accent: '#f59e0b',
          deltas: [
            buildMacroDelta('MoM', macroData.corePCE.mom, { digits: 1, positiveIsGood: false }),
            buildMacroDelta('YoY', macroData.corePCE.yoy, { digits: 1, positiveIsGood: false }),
          ].filter(isNonNull),
          note: 'The Fed targets roughly 2.0% annual Core PCE inflation.',
        } : null,
        macroData.breakeven10Y?.value ? {
          assetId: 'economy-metric-10y-breakeven-inflation' as const,
          eyebrow: 'Market Pricing',
          title: '10Y Breakeven Inflation',
          value: `${formatDecimal(macroData.breakeven10Y.value, 2)}%`,
          meta: `Market implied · ${macroData.breakeven10Y.date}`,
          accent: '#7c3aed',
          deltas: [
            buildMacroDelta('MoM', macroData.breakeven10Y.mom, { digits: 2, suffix: 'pp', positiveIsGood: false }),
            buildMacroDelta('YoY', macroData.breakeven10Y.yoy, { digits: 2, suffix: 'pp', positiveIsGood: false }),
          ].filter(isNonNull),
          note: 'This is the bond market’s inflation expectation over the next decade.',
        } : null,
        macroData.mortgage15?.value ? {
          assetId: 'economy-metric-15-year-mortgage-rate' as const,
          eyebrow: 'Financing Cost',
          title: '15-Year Mortgage Rate',
          value: `${formatDecimal(macroData.mortgage15.value, 2)}%`,
          meta: `Weekly rate · ${macroData.mortgage15.date}`,
          accent: '#0f766e',
          deltas: [
            buildMacroDelta('MoM', macroData.mortgage15.mom, { digits: 2, suffix: 'pp', positiveIsGood: false }),
            buildMacroDelta('YoY', macroData.mortgage15.yoy, { digits: 2, suffix: 'pp', positiveIsGood: false }),
          ].filter(isNonNull),
          note: treasuryYields?.yields?.mortgageRate?.current
            ? `30-year spread: ${(parseFloat(treasuryYields.yields.mortgageRate.current) - parseFloat(macroData.mortgage15.value)).toFixed(2)}pp.`
            : 'Shorter mortgage duration shows how much rate relief buyers gain by shortening term.',
        } : null,
      ].filter(isNonNull),
    },
    {
      key: 'supply',
      title: 'Housing Supply & Demand',
      description: 'Supply, vacancy, and cost pressure stay on one line so housing conditions read faster.',
      cards: [
        macroData.newHomeSales?.value ? {
          assetId: 'economy-metric-new-home-sales' as const,
          eyebrow: 'New Supply',
          title: 'New Home Sales',
          value: formatThousandsDisplay(macroData.newHomeSales.value),
          meta: `Annualized units · ${macroData.newHomeSales.date}`,
          accent: '#0891b2',
          deltas: [
            buildMacroDelta('MoM', macroData.newHomeSales.mom, { digits: 1 }),
            buildMacroDelta('YoY', macroData.newHomeSales.yoy, { digits: 1 }),
          ].filter(isNonNull),
          note: 'Sales volume is a direct read on builder demand and new-home absorption.',
        } : null,
        macroData.rentalVacancy?.value ? {
          assetId: 'economy-metric-rental-vacancy-rate' as const,
          eyebrow: 'Rental Tightness',
          title: 'Rental Vacancy Rate',
          value: `${formatDecimal(macroData.rentalVacancy.value, 2)}%`,
          meta: `Quarterly rate · ${macroData.rentalVacancy.date}`,
          accent: '#ea580c',
          deltas: [
            buildMacroDelta('YoY', macroData.rentalVacancy.yoy, { digits: 2, suffix: 'pp', positiveIsGood: false }),
          ].filter(isNonNull),
          note: 'Lower vacancy usually means stronger pricing power for rental owners.',
        } : null,
        macroData.constructionPPI?.value ? {
          assetId: 'economy-metric-construction-cost-index' as const,
          eyebrow: 'Build Cost',
          title: 'Construction Cost Index',
          value: formatDecimal(macroData.constructionPPI.value, 1),
          meta: `Materials PPI · ${macroData.constructionPPI.date}`,
          accent: '#65a30d',
          deltas: [
            buildMacroDelta('MoM', macroData.constructionPPI.mom, { digits: 1, positiveIsGood: false }),
            buildMacroDelta('YoY', macroData.constructionPPI.yoy, { digits: 1, positiveIsGood: false }),
          ].filter(isNonNull),
          note: 'Rising input costs compress renovation margins and new-build feasibility.',
        } : null,
      ].filter(isNonNull),
    },
  ] : [];

  const economyChartDefinitions = macroData ? [
    {
      assetId: 'economy-trend-chart-initial-jobless-claims' as const,
      key: 'jobless-claims',
      title: 'Initial Jobless Claims',
      description: 'Weekly layoffs proxy shown as quarter-end or year-end snapshots across the full stored history.',
      color: '#ef4444',
      dataLabel: 'Claims',
      isPercentage: false,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(macroData.joblessClaims?.history, economyChartGranularity),
    },
    {
      assetId: 'economy-trend-chart-consumer-sentiment' as const,
      key: 'consumer-sentiment',
      title: 'Consumer Sentiment',
      description: 'Michigan confidence trend, rebucketed without collapsing the longer lookback window.',
      color: '#2563eb',
      dataLabel: 'Sentiment',
      isPercentage: false,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(macroData.consumerSentiment?.history, economyChartGranularity),
    },
    {
      assetId: 'economy-trend-chart-core-pce-index' as const,
      key: 'core-pce',
      title: 'Core PCE Index',
      description: 'Inflation gauge most closely tracked by the Fed.',
      color: '#f59e0b',
      dataLabel: 'Core PCE',
      isPercentage: false,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(macroData.corePCE?.history, economyChartGranularity),
    },
    {
      assetId: 'economy-trend-chart-10y-breakeven-inflation' as const,
      key: 'breakeven-10y',
      title: '10Y Breakeven Inflation',
      description: 'Market inflation expectation rather than reported realized inflation.',
      color: '#7c3aed',
      dataLabel: 'Breakeven Rate',
      isPercentage: true,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(macroData.breakeven10Y?.history, economyChartGranularity),
    },
    {
      assetId: 'economy-trend-chart-new-home-sales' as const,
      key: 'new-home-sales',
      title: 'New Home Sales',
      description: 'Builder demand and sales absorption, shown at the chosen reporting cadence.',
      color: '#0891b2',
      dataLabel: 'Sales',
      isPercentage: false,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(macroData.newHomeSales?.history, economyChartGranularity),
    },
    {
      assetId: 'economy-trend-chart-construction-cost-index' as const,
      key: 'construction-cost',
      title: 'Construction Cost Index',
      description: 'Materials input cost pressure relevant for both rehab and development underwriting.',
      color: '#65a30d',
      dataLabel: 'Cost Index',
      isPercentage: false,
      isCurrency: false,
      showArea: false,
      series: aggregateMarketSeries(macroData.constructionPPI?.history, economyChartGranularity),
    },
  ] : [];

  const selectedEconomyChart = economyChartDefinitions.find((chart) => chart.key === expandedEconomyChart) || null;

  type OverviewSignalCard = {
    assetId:
      | 'overview-signal-supply-pressure'
      | 'overview-signal-rate-environment'
      | 'overview-signal-price-momentum'
      | 'overview-signal-credit-spread';
    title: string;
    signal: {
      label: string;
      color: string;
      bg: string;
      dot: string;
      note: string;
    };
  };

  const overviewSignalCards: OverviewSignalCard[] = (() => {
    const invMonths = parseFloat(overview.inventory?.value ?? 0);
    const mortRate = parseFloat(overview.mortgageRate?.value ?? 0);
    const t10y = parseFloat(treasuryYields?.yields?.tenYear?.current ?? 0);
    const priceYoy = parseFloat(overview.medianPrice?.yoy ?? 0);
    const spread = mortRate && t10y ? Math.round((mortRate - t10y) * 100) : null;

    const supplySignal = invMonths <= 0 ? null
      : invMonths < 3 ? { label: 'Shortage', color: 'text-rose-700', bg: 'bg-rose-50 border-rose-200', dot: 'bg-rose-500', note: `${invMonths.toFixed(1)} mo, well below a balanced market.` }
      : invMonths < 5 ? { label: 'Tight', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500', note: `${invMonths.toFixed(1)} mo, still below the 6-month equilibrium line.` }
      : invMonths < 7 ? { label: 'Balanced', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `${invMonths.toFixed(1)} mo, close to equilibrium.` }
      : { label: 'Oversupplied', color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200', dot: 'bg-indigo-500', note: `${invMonths.toFixed(1)} mo, buyer leverage remains elevated.` };

    const spreadSignal = spread === null ? null
      : spread < 150 ? { label: 'Compressed', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `+${spread} bps, tighter than normal lender spread.` }
      : spread < 200 ? { label: 'Normal', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `+${spread} bps, near the historical ~170 bps average.` }
      : spread < 260 ? { label: 'Elevated', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500', note: `+${spread} bps, lenders are still pricing extra caution.` }
      : { label: 'Stressed', color: 'text-rose-700', bg: 'bg-rose-50 border-rose-200', dot: 'bg-rose-500', note: `+${spread} bps, financing remains materially impaired.` };

    const momentumSignal = Number.isNaN(priceYoy) ? null
      : priceYoy > 8 ? { label: 'Overheating', color: 'text-rose-700', bg: 'bg-rose-50 border-rose-200', dot: 'bg-rose-500', note: `+${priceYoy.toFixed(1)}% YoY, affordability is eroding too quickly.` }
      : priceYoy > 3 ? { label: 'Healthy', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `+${priceYoy.toFixed(1)}% YoY, appreciation is still orderly.` }
      : priceYoy >= 0 ? { label: 'Cooling', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500', note: `+${priceYoy.toFixed(1)}% YoY, momentum is fading.` }
      : { label: 'Correcting', color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200', dot: 'bg-indigo-500', note: `${priceYoy.toFixed(1)}% YoY, prices are still resetting lower.` };

    const rateSignal = mortRate <= 0 ? null
      : mortRate < 5.5 ? { label: 'Accessible', color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', note: `${mortRate.toFixed(2)}%, below long-run affordability pressure.` }
      : mortRate < 6.5 ? { label: 'Stretched', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500', note: `${mortRate.toFixed(2)}%, financing is still constraining buyers.` }
      : mortRate < 7.5 ? { label: 'Stressed', color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200', dot: 'bg-orange-500', note: `${mortRate.toFixed(2)}%, debt service remains a material headwind.` }
      : { label: 'Critical', color: 'text-rose-700', bg: 'bg-rose-50 border-rose-200', dot: 'bg-rose-500', note: `${mortRate.toFixed(2)}%, leverage math breaks for most buyers.` };

    return [
      supplySignal ? { assetId: 'overview-signal-supply-pressure' as const, title: 'Supply Pressure', signal: supplySignal } : null,
      rateSignal ? { assetId: 'overview-signal-rate-environment' as const, title: 'Rate Environment', signal: rateSignal } : null,
      momentumSignal ? { assetId: 'overview-signal-price-momentum' as const, title: 'Price Momentum', signal: momentumSignal } : null,
      spreadSignal ? { assetId: 'overview-signal-credit-spread' as const, title: 'Credit Spread', signal: spreadSignal } : null,
    ].filter(isNonNull);
  })();

  const investorRatioCards = macroData?.investorRatios ? [
    macroData.investorRatios.rateVsPrice ? {
      assetId: 'economy-investor-chart-mortgage-vs-median-price' as const,
      accent: '#f59e0b',
      title: '30Y Mortgage vs Median Price',
      description: 'Quarterly pricing sensitivity as financing costs move.',
      content: (
        <InvestorScatterChart
          points={macroData.investorRatios.rateVsPrice}
          xKey="mortgageRate"
          yKey="medianPrice"
          xLabel="30Y Mortgage"
          yLabel="Median Price"
          formatX={(v: number) => v.toFixed(1) + '%'}
          formatY={(v: number) => '$' + (v / 1000).toFixed(0) + 'k'}
          color="#f59e0b"
        />
      ),
    } : null,
    macroData.investorRatios.startsVsPermits ? {
      assetId: 'economy-investor-chart-housing-starts-vs-permits' as const,
      accent: '#06b6d4',
      title: 'Housing Starts vs Permits',
      description: 'Supply pipeline read where permit divergence often leads starts.',
      content: (
        <InvestorScatterChart
          points={macroData.investorRatios.startsVsPermits}
          xKey="permits"
          yKey="starts"
          xLabel="Permits"
          yLabel="Starts"
          formatX={(v: number) => v.toFixed(0) + 'k'}
          formatY={(v: number) => v.toFixed(0) + 'k'}
          color="#06b6d4"
        />
      ),
    } : null,
    macroData.investorRatios.priceVsRent ? {
      assetId: 'economy-investor-chart-case-shiller-vs-rent-cpi' as const,
      accent: '#8b5cf6',
      title: 'Case-Shiller vs Rent CPI',
      description: 'Price-to-rent slope shows when home values outrun rent fundamentals.',
      content: (
        <InvestorScatterChart
          points={macroData.investorRatios.priceVsRent}
          xKey="rentIndex"
          yKey="homePriceIndex"
          xLabel="Rent CPI"
          yLabel="Case-Shiller"
          formatX={(v: number) => v.toFixed(1)}
          formatY={(v: number) => v.toFixed(1)}
          color="#8b5cf6"
        />
      ),
    } : null,
    macroData.investorRatios.capRateSpread ? {
      assetId: 'economy-investor-chart-rent-growth-vs-10y-treasury' as const,
      accent: '#10b981',
      title: 'Rent Growth vs 10Y Treasury',
      description: 'Real estate income premium versus the risk-free rate.',
      content: (
        <InvestorScatterChart
          points={macroData.investorRatios.capRateSpread}
          xKey="treasury10Y"
          yKey="rentGrowthYoY"
          xLabel="10Y Treasury"
          yLabel="Rent Growth YoY"
          formatX={(v: number) => v.toFixed(1) + '%'}
          formatY={(v: number) => v.toFixed(1) + '%'}
          color="#10b981"
          showDiagonal={true}
        />
      ),
    } : null,
    macroData.investorRatios.vacancyVsPrice ? {
      assetId: 'economy-investor-chart-rental-vacancy-vs-median-price' as const,
      accent: '#ef4444',
      title: 'Rental Vacancy vs Median Price',
      description: 'Vacancy pressure against pricing to flag tightness or correction risk.',
      content: (
        <InvestorScatterChart
          points={macroData.investorRatios.vacancyVsPrice}
          xKey="rentalVacancy"
          yKey="medianPrice"
          xLabel="Rental Vacancy"
          yLabel="Median Price"
          formatX={(v: number) => v.toFixed(1) + '%'}
          formatY={(v: number) => '$' + (v / 1000).toFixed(0) + 'k'}
          color="#ef4444"
        />
      ),
    } : null,
    macroData.beveridgeCurve && macroData.beveridgeCurve.points?.length >= 6 ? {
      assetId: 'economy-investor-chart-beveridge-curve' as const,
      accent: '#4f46e5',
      title: 'Beveridge Curve',
      description: 'Vacancy rate versus unemployment, with upper-left indicating tighter labor conditions.',
      content: (
        <>
          {macroData.beveridgeCurve.regions && Object.keys(macroData.beveridgeCurve.regions).length > 1 && (
            <div className="flex items-center gap-1 flex-wrap mb-2">
              {Object.entries(macroData.beveridgeCurve.regions as Record<string, any>).map(([key, region]: [string, any]) => (
                <button
                  key={key}
                  onClick={() => setBeveridgeRegion(key)}
                  className={`px-2 py-1 text-[10px] font-medium rounded-full transition-all ${
                    beveridgeRegion === key
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {region.label}
                </button>
              ))}
            </div>
          )}
          {(() => {
            const selectedCurve = macroData.beveridgeCurve.regions?.[beveridgeRegion] || macroData.beveridgeCurve;
            return selectedCurve?.points?.length >= 6 ? (
              <BeveridgeCurveChart
                points={selectedCurve.points}
                latest={selectedCurve.latest}
                direction={selectedCurve.direction}
              />
            ) : null;
          })()}
        </>
      ),
    } : null,
  ].filter(isNonNull) : [];

  const fedPredictionCards = [
    { assetId: 'fed-prediction-fed-rate-cut' as const, prediction: predictions?.fedRateCut },
    { assetId: 'fed-prediction-mortgage-rate' as const, prediction: predictions?.mortgageRate },
    { assetId: 'fed-prediction-housing-market' as const, prediction: predictions?.housingMarket },
    { assetId: 'fed-prediction-gdp-growth' as const, prediction: predictions?.gdpGrowth },
    { assetId: 'fed-prediction-recession' as const, prediction: predictions?.recession },
    { assetId: 'fed-prediction-inflation' as const, prediction: predictions?.inflation },
    { assetId: 'fed-prediction-unemployment' as const, prediction: predictions?.unemployment },
  ].filter((entry) => entry.prediction && entry.prediction.probability !== null);

  const focusedMarketAssetMetadata = focusedMarketAsset ? MARKET_INSIGHTS_ASSET_METADATA[focusedMarketAsset] : null;

  const fedFocusedSection = focusedMarketAssetMetadata?.tab === 'fed' && 'fedFocusSection' in focusedMarketAssetMetadata
    ? focusedMarketAssetMetadata.fedFocusSection
    : undefined;

  const renderOverviewSignalCard = (entry: OverviewSignalCard, compact = false) => (
    <div
      key={entry.assetId}
      className={`rounded-2xl border ${entry.signal.bg} ${compact ? 'px-3 py-2.5' : 'p-5'}`}
    >
      <div className={`flex items-center gap-2 ${compact ? 'mb-1.5' : 'mb-3'}`}>
        <span className={`inline-block rounded-full ${entry.signal.dot} ${compact ? 'h-2 w-2' : 'h-3 w-3'}`} />
        <span className={`font-semibold uppercase tracking-[0.14em] text-slate-500 ${compact ? 'text-[10px]' : 'text-xs tracking-[0.18em]'}`}>
          {entry.title}
        </span>
      </div>
      <div className={`font-semibold tracking-[-0.02em] ${entry.signal.color} ${compact ? 'text-base mb-0.5' : 'text-[18px] mb-2'}`}>
        {entry.signal.label}
      </div>
      <div className={`text-slate-600 leading-snug ${compact ? 'text-[11px]' : 'text-sm leading-relaxed'}`}>
        {entry.signal.note}
      </div>
    </div>
  );

  const renderFinancingHighlightCard = (item: (typeof financingHighlights)[number]) => (
    <GlassCard key={item.assetId} className="p-5" accent={
      item.assetId === 'overview-financing-10-year-treasury' ? '#3b82f6'
      : item.assetId === 'overview-financing-30-year-mortgage' ? '#10b981'
      : '#a855f7'
    }>
      <div className="text-sm font-medium text-slate-600 mb-3">{item.label}</div>
      <div className="text-4xl font-bold text-slate-900 mb-3">{item.value}</div>
      <div className="text-sm text-slate-600">{item.note}</div>
    </GlassCard>
  );

  const renderOverviewChartCard = (chart: (typeof overviewChartDefinitions)[number], allowExpand: boolean) => (
    <AnalyticsCard
      key={chart.assetId}
      compact
      dense
      lockAspectRatio={false}
      className="min-h-[260px]"
      title={
        <div>
          <div>{chart.title}</div>
          <div className="mt-1 text-xs font-normal text-slate-500 max-w-[32rem]">{chart.description}</div>
        </div>
      }
      controls={allowExpand ? <ExpandButton onClick={() => setExpandedOverviewChart(chart.key)} /> : undefined}
    >
      <div className="h-[200px] min-h-[200px] px-1 pb-1 pt-0">
        <ProfessionalLineChart
          data={chart.series.values}
          xLabels={chart.series.labels}
          color={chart.color}
          dataLabel={chart.dataLabel}
          isPercentage={chart.isPercentage}
          isCurrency={chart.isCurrency}
          showArea={chart.showArea}
          showPoints={false}
          variant="compact"
        />
      </div>
    </AnalyticsCard>
  );

  const renderEconomyMetricCard = (card: EconomyMetricCard) => (
    <MacroMetricCard
      key={card.assetId}
      eyebrow={card.eyebrow}
      title={card.title}
      value={card.value}
      meta={card.meta}
      accent={card.accent}
      deltas={card.deltas}
      note={card.note}
    />
  );

  const renderInvestorRatioCard = (card: NonNullable<(typeof investorRatioCards)[number]>) => (
    <SurfaceCard key={card.assetId} accent={card.accent}>
      <h4 className="text-[15px] font-semibold text-slate-900 mb-1">{card.title}</h4>
      <p className="text-[11px] leading-relaxed text-slate-500 mb-2.5">{card.description}</p>
      {card.content}
    </SurfaceCard>
  );

  const renderEconomyTrendChartCard = (chart: (typeof economyChartDefinitions)[number], allowExpand: boolean) => (
    <MacroTrendCard
      key={chart.assetId}
      title={chart.title}
      description={chart.description}
      accent={chart.color}
      controls={allowExpand ? <ExpandButton onClick={() => setExpandedEconomyChart(chart.key)} /> : undefined}
    >
      <ProfessionalLineChart
        data={chart.series.values}
        xLabels={chart.series.labels}
        color={chart.color}
        dataLabel={chart.dataLabel}
        isPercentage={chart.isPercentage}
        isCurrency={chart.isCurrency}
        showArea={chart.showArea}
        showPoints={false}
        variant="compact"
      />
    </MacroTrendCard>
  );

  const renderFedPredictionCard = (entry: NonNullable<(typeof fedPredictionCards)[number]>) => {
    const probability = parseFloat(entry.prediction.probability);
    const percentValue = (probability * 100).toFixed(1);

    return (
      <div key={entry.assetId} className="bg-white/60 rounded-xl p-4 border border-slate-200/60">
        <div className="text-sm font-medium text-slate-900 mb-3">
          {entry.prediction.question}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="w-full bg-slate-200 rounded-full h-2.5 mb-1">
              <div
                className="bg-gradient-to-r from-purple-500 to-blue-500 h-2.5 rounded-full transition-all"
                style={{ width: `${percentValue}%` }}
              ></div>
            </div>
          </div>
          <div className="text-lg font-bold text-purple-700 min-w-[60px] text-right">
            {percentValue}%
          </div>
        </div>
        {entry.prediction.url && (
          <a
            href={entry.prediction.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-purple-600 hover:text-purple-700 mt-2 inline-block"
          >
            View market →
          </a>
        )}
      </div>
    );
  };

  return (
    <PageShell
      className={marketEmbed ? 'h-auto' : 'flex-1'}
      header={!marketEmbed ? (
        <WorkspaceTabsHeader
          eyebrow="Market Insights"
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab)}
          tabs={tabs}
          rightContent={
            resolvedActiveTab === 'overview' ? (
              <button
                type="button"
                onClick={() => setShowRentalCalculatorModal(true)}
                className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
              >
                Open Rental Property Calculator
              </button>
            ) : undefined
          }
        />
      ) : undefined}
      contentClassName="space-y-6"
    >
      {!marketEmbed && resolvedActiveTab === 'overview' && (
        <div className="space-y-3" data-voice-id="market-overview-cards">
          <DsSectionHeader
            label="Live market data"
            description={
              overview.mortgageRate?.date
                ? `Mortgage rate as of ${overview.mortgageRate.date}${overview.medianPrice?.date && overview.medianPrice.date !== overview.mortgageRate.date ? ` · Home price as of ${overview.medianPrice.date}` : ''}`
                : 'Live data from Federal Reserve Economic Data (FRED)'
            }
          />
          <KpiStrip
            items={overviewMetricCards.map((card) => {
              const changeNum = card.change != null ? Number(card.change) : null;
              const prefersLower = card.positive === false;
              let tone: 'default' | 'positive' | 'negative' = 'default';
              if (changeNum != null && !Number.isNaN(changeNum)) {
                const isUp = changeNum >= 0;
                tone = prefersLower
                  ? (isUp ? 'negative' : 'positive')
                  : (isUp ? 'positive' : 'negative');
              }
              return {
                label: card.label,
                value: card.value,
                sub: card.change != null
                  ? `${formatPercentChange(card.change)} ${card.changeLabel || 'YoY'}`
                  : undefined,
                tone,
              };
            })}
            columns={4}
          />
        </div>
      )}

        {/* Tab Content */}
        <div className={assetOnlyMode ? '' : ''}>
          <div className={assetOnlyMode ? '' : ''}>
            
            {/* Overview Tab — continuous denser workspace (same pattern as Economy & Fed) */}
            {resolvedActiveTab === 'overview' && (
              <div className={assetOnlyMode ? '' : 'space-y-4'} data-voice-id="overview-tab">
                {assetOnlyMode && overviewMetricCards.some((card) => card.assetId === focusedMarketAsset) && (
                  <div className="grid grid-cols-1 gap-4" data-voice-id="market-overview-cards">
                    {overviewMetricCards.filter((card) => matchesFocusedMarketAsset(card.assetId)).map((card) => (
                      <StatCard
                        key={card.assetId}
                        label={card.label}
                        value={card.value}
                        change={card.change}
                        changeLabel={card.changeLabel}
                        positive={card.positive}
                      />
                    ))}
                  </div>
                )}

                {!assetOnlyMode ? (
                  <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                    <div className="min-w-0 space-y-4">
                      {(overviewSignalCards.length > 0 || treasuryYields) && (
                        <Card surface="light">
                          <SectionHeader
                            title="What changed"
                            description="Signals and financing that matter for rental underwriting."
                          />
                          {overviewSignalCards.length > 0 ? (
                            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                              {overviewSignalCards.map((card) => renderOverviewSignalCard(card, true))}
                            </div>
                          ) : null}
                          {treasuryYields ? (
                            <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${financingToneClasses}`}>
                                  {financingRegime.label}
                                </span>
                                <span className="text-sm font-semibold text-slate-900">Rates & financing</span>
                              </div>
                              <p className="mt-2 text-sm leading-snug text-slate-600">{financingRegime.summary}</p>
                              <div className="mt-3 grid grid-cols-3 gap-2">
                                {financingHighlights.map((item) => (
                                  <div key={item.label} className="rounded-xl border border-slate-200 bg-white px-2.5 py-2">
                                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{item.label}</div>
                                    <div className="mt-0.5 text-base font-bold tabular-nums text-slate-950">{item.value}</div>
                                    <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{item.note}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </Card>
                      )}

                      {(treasuryYields || housingData?.charts) && (
                        <div className="space-y-3">
                          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <SectionHeader
                              title="Market charts"
                              description="Primary rate and housing trends — expand any chart for detail."
                            />
                            {overviewChartControls}
                          </div>
                          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-voice-id="market-overview-charts-grid">
                            {overviewChartDefinitions
                              .filter((chart) => chart.series.values.length > 1)
                              .slice(0, 4)
                              .map((chart) => renderOverviewChartCard(chart, true))}
                          </div>
                          {overviewChartDefinitions.filter((chart) => chart.series.values.length > 1).length === 0 ? (
                            <Card surface="light" compact>
                              <p className="py-8 text-center text-sm text-slate-500">
                                Chart series are still loading from FRED. KPI and signal values above use the latest snapshots.
                              </p>
                            </Card>
                          ) : null}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 xl:sticky xl:top-4">
                      <MarketAIAnalysis
                        surface="light"
                        endpoint="/api/market/ai-analysis"
                        payload={{
                          housingData: {
                            mortgageRate: overview?.mortgageRate?.value,
                            priceTrend: overview?.medianPrice?.yoy,
                            inventoryMonths: overview?.inventory?.value,
                            medianHomePrice: overview?.medianPrice?.value,
                            newListings: overview?.newListings?.value,
                            daysOnMarket: overview?.daysOnMarket?.value,
                            histories: {
                              medianPrice: housingData?.charts?.medianPrice?.slice(-12),
                              inventory: housingData?.charts?.inventory?.slice(-12),
                              mortgageRate: housingData?.charts?.mortgageRate?.slice(-24),
                            },
                          },
                          treasuryYields: treasuryYields ? {
                            t2y: treasuryYields.yields?.twoYear?.current,
                            t10y: treasuryYields.yields?.tenYear?.current,
                            t30y: treasuryYields.yields?.thirtyYear?.current,
                            spread: treasuryYields.yields?.yieldSpread?.current,
                            tenYearMonthlyChange: treasuryYields.yields?.tenYear?.changes?.['1month']?.absolute,
                            mortgageMonthlyChange: treasuryYields.yields?.mortgageRate?.changes?.['1month']?.absolute,
                            spreadMonthlyChange: treasuryYields.yields?.yieldSpread?.changes?.['1month']?.absolute,
                            histories: {
                              tenYear: treasuryYields.yields?.tenYear?.history?.slice(-12),
                              mortgageRate: treasuryYields.yields?.mortgageRate?.history?.slice(-12),
                              yieldSpread: treasuryYields.yields?.yieldSpread?.history?.slice(-12),
                            },
                          } : undefined,
                          macroData: macroData ? {
                            corePCE: macroData.corePCE,
                            unemployment: macroData.unemployment,
                            consumerSentiment: macroData.consumerSentiment,
                            gdpGrowth: macroData.gdpGrowth,
                            fedFundsRate: macroData.fedFundsRate,
                            joblessClaims: macroData.joblessClaims,
                            jobOpenings: macroData.jobOpenings,
                            breakeven10Y: macroData.breakeven10Y,
                            oilPrice: macroData.oilPrice,
                            newHomeSales: macroData.newHomeSales,
                            constructionPPI: macroData.constructionPPI,
                          } : undefined,
                          predictions: predictions ? {
                            fedRateCut: predictions.fedRateCut?.probability,
                            recession: predictions.recession?.probability,
                          } : undefined,
                        }}
                        title="AI Market Outlook"
                        subtitle="What this means for your rentals"
                        icon="AI"
                        autoRun={false}
                        cacheKey="market-overview-ai-outlook"
                        cacheMode="local"
                        manualRefreshOnly={true}
                        collapsible={true}
                        defaultExpanded={true}
                        compact={true}
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    {overviewSignalCards.some((card) => matchesFocusedMarketAsset(card.assetId)) && (
                      <div className="grid grid-cols-1 gap-4">
                        {overviewSignalCards.filter((card) => matchesFocusedMarketAsset(card.assetId)).map((card) => renderOverviewSignalCard(card))}
                      </div>
                    )}
                    {treasuryYields && matchesFocusedMarketAsset(
                      'overview-financing-regime',
                      'overview-financing-10-year-treasury',
                      'overview-financing-30-year-mortgage',
                      'overview-financing-10y-2y-spread',
                    ) && (
                      <div className="grid grid-cols-1 gap-4">
                        {matchesFocusedMarketAsset('overview-financing-regime') && (
                          <GlassCard className="p-6">
                            <h4 className="text-[22px] font-semibold tracking-[-0.03em] text-slate-900">{financingRegime.summary}</h4>
                          </GlassCard>
                        )}
                        {financingHighlights.filter((item) => matchesFocusedMarketAsset(item.assetId)).map(renderFinancingHighlightCard)}
                      </div>
                    )}
                    {matchesFocusedMarketAsset('overview-ai-market-outlook') && (
                      <MarketAIAnalysis
                        surface="light"
                        endpoint="/api/market/ai-analysis"
                        payload={{
                          housingData: {
                            mortgageRate: overview?.mortgageRate?.value,
                            priceTrend: overview?.medianPrice?.yoy,
                            inventoryMonths: overview?.inventory?.value,
                            medianHomePrice: overview?.medianPrice?.value,
                            newListings: overview?.newListings?.value,
                            daysOnMarket: overview?.daysOnMarket?.value,
                          },
                        }}
                        title="AI Market Outlook"
                        subtitle="AI-powered macro analysis with projections"
                        icon="AI"
                        autoRun={false}
                        cacheKey="market-overview-ai-outlook"
                        cacheMode="local"
                        manualRefreshOnly={true}
                        collapsible={true}
                        defaultExpanded={true}
                        compact={true}
                      />
                    )}
                    <div className="grid grid-cols-1 gap-4">
                      {overviewChartDefinitions
                        .filter((chart) => chart.series.values.length > 1 && matchesFocusedMarketAsset(chart.assetId))
                        .map((chart) => renderOverviewChartCard(chart, false))}
                    </div>
                  </>
                )}

                {!assetOnlyMode && (
                    <div className="space-y-4">
                      <button
                        type="button"
                        onClick={() => setSegmentDetailsOpen((v) => !v)}
                        className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-left transition hover:bg-slate-100"
                      >
                        <div>
                          <div className="text-sm font-semibold text-slate-900">Segment & metro detail</div>
                          <p className="mt-0.5 text-xs text-slate-500">Property-type trends and top metro tables — secondary to the signals and charts above.</p>
                        </div>
                        <span className="text-xs font-semibold text-slate-500">{segmentDetailsOpen ? 'Hide' : 'Show'}</span>
                      </button>
                      {segmentDetailsOpen && (
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        {housingData?.charts?.singleFamily?.length > 0 && (
                          <GlassCard className="p-5 min-h-[360px]">
                            <h4 className="font-semibold text-slate-900 mb-1">Single Family Price Index</h4>
                            <p className="text-sm text-slate-500 mb-4">Single-family pricing remains the cleanest proxy for owner-occupier demand pressure.</p>
                            <ProfessionalLineChart
                              data={housingData.charts.singleFamily.map((d: any) => d.value)}
                              xLabels={housingData.charts.singleFamily.map((d: any) => d.date.substring(0, 7))}
                              color="#3b82f6"
                              dataLabel="Index"
                              isPercentage={false}
                              isCurrency={false}
                            />
                          </GlassCard>
                        )}

                        <GlassCard className="p-6 min-h-[360px]" data-voice-id="market-trends-section">
                          <h3 className="text-base font-semibold text-slate-900 mb-3">Market Trends by Property Type</h3>
                          <div className="divide-y divide-slate-100" data-voice-id="property-type-trends">
                            {[
                              { name: 'Single Family', value: trends.singleFamily?.value, yoy: trends.singleFamily?.yoy },
                              { name: 'Condos/Townhomes', value: trends.condos?.value, yoy: trends.condos?.yoy },
                              { name: 'Multi-Family', value: trends.multiFamily?.value, yoy: trends.multiFamily?.yoy },
                            ].map((item, idx) => (
                              <div key={idx} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                                <div>
                                  <div className="font-medium text-slate-900 text-sm">{item.name}</div>
                                  <div className="text-xs text-slate-500">Index: {item.value || 'N/A'}</div>
                                </div>
                                <div className={`text-sm font-semibold ${item.yoy && parseFloat(item.yoy) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                  {formatPercentChange(item.yoy)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </GlassCard>

                        <GlassCard className="p-6 min-h-[360px]" data-voice-id="top-markets-section">
                          <h3 className="text-base font-semibold text-slate-900 mb-3">Top Metro Markets</h3>
                          <div className="overflow-x-auto" data-voice-id="top-markets-table">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-slate-200">
                                  <th className="text-left py-2 px-2 font-semibold text-xs text-slate-600">Metro</th>
                                  <th className="text-left py-2 px-2 font-semibold text-xs text-slate-600">Price</th>
                                  <th className="text-left py-2 px-2 font-semibold text-xs text-slate-600">YoY</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {metros.slice(0, 8).map((metro: any, idx: number) => (
                                  <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                                    <td className="py-2 px-2 font-medium text-slate-900 text-xs">{metro.name}</td>
                                    <td className="py-2 px-2 text-slate-700 text-xs">{formatCurrency(metro.price)}</td>
                                    <td className={`py-2 px-2 font-medium text-xs ${metro.yoy && parseFloat(metro.yoy) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                      {formatPercentChange(metro.yoy)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </GlassCard>
                      </div>
                      )}
                    </div>
                )}
              </div>
            )}

            {/* Economy & Fed — one continuous denser workspace */}
            {resolvedActiveTab === 'economy-fed' && (
              <div className="space-y-4" data-voice-id="economy-tab">
                {!assetOnlyMode && macroData && (
                  <>
                    <KpiStrip
                      columns={4}
                      items={[
                        {
                          label: 'Fed funds',
                          value: macroData.fedFundsRate?.value != null
                            ? `${Number(macroData.fedFundsRate.value).toFixed(2)}%`
                            : '—',
                          sub: macroData.fedFundsRate?.date || undefined,
                        },
                        {
                          label: '30Y mortgage',
                          value: overview.mortgageRate?.value
                            ? `${parseFloat(overview.mortgageRate.value).toFixed(2)}%`
                            : '—',
                          sub: overview.mortgageRate?.date || undefined,
                        },
                        {
                          label: 'Core PCE YoY',
                          value: macroData.corePCE?.yoy != null ? `${Number(macroData.corePCE.yoy).toFixed(1)}%` : '—',
                          sub: macroData.corePCE?.date || undefined,
                          tone: macroData.corePCE?.yoy != null && Number(macroData.corePCE.yoy) > 3 ? 'negative' : 'default',
                        },
                        {
                          label: 'Unemployment',
                          value: macroData.unemployment?.value != null
                            ? `${Number(macroData.unemployment.value).toFixed(1)}%`
                            : '—',
                          sub: macroData.unemployment?.date || undefined,
                        },
                      ]}
                    />

                    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                      <div className="min-w-0 space-y-4">
                        <FedMeetingSummary />

                        {economyCardSections.map((section) => (
                          <Card key={section.key} surface="light">
                            <SectionHeader title={section.title} description={section.description} />
                            <div className="mt-2 divide-y divide-slate-100">
                              {section.cards.map((card: any) => (
                                <div key={card.assetId} className="grid grid-cols-[minmax(0,1.4fr)_auto_minmax(5rem,auto)] items-center gap-3 py-2.5">
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-slate-900">{card.title}</div>
                                    <div className="text-[11px] text-slate-500 truncate">{card.meta}</div>
                                  </div>
                                  <div className="text-right text-base font-semibold tabular-nums text-slate-900">{card.value}</div>
                                  <div className="flex flex-wrap justify-end gap-1">
                                    {card.deltas.slice(0, 2).map((delta: any) => (
                                      <span key={delta.label} className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${delta.toneClass}`}>
                                        {delta.label} {delta.value}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </Card>
                        ))}
                      </div>

                      <div className="min-w-0 space-y-4 xl:sticky xl:top-4">
                        <MarketAIAnalysis
                          surface="light"
                          endpoint="/api/market/ai-analysis"
                          payload={{
                            macroData: {
                              corePCE: macroData.corePCE,
                              unemployment: macroData.unemployment,
                              consumerSentiment: macroData.consumerSentiment,
                              gdpGrowth: macroData.gdpGrowth,
                              fedFundsRate: macroData.fedFundsRate,
                              joblessClaims: macroData.joblessClaims,
                              jobOpenings: macroData.jobOpenings,
                              breakeven10Y: macroData.breakeven10Y,
                              oilPrice: macroData.oilPrice,
                              newHomeSales: macroData.newHomeSales,
                              constructionPPI: macroData.constructionPPI,
                            },
                            treasuryYields: treasuryYields ? {
                              t2y: treasuryYields.yields?.twoYear?.current,
                              t10y: treasuryYields.yields?.tenYear?.current,
                              t30y: treasuryYields.yields?.thirtyYear?.current,
                              spread: treasuryYields.yields?.yieldSpread?.current,
                            } : undefined,
                            housingData: {
                              mortgageRate: overview?.mortgageRate?.value,
                              inventoryMonths: overview?.inventory?.value,
                            },
                            predictions: predictions ? {
                              fedRateCut: predictions.fedRateCut?.probability,
                              recession: predictions.recession?.probability,
                            } : undefined,
                          }}
                          title="Rates & Fed brief"
                          subtitle="What policy and macro mean for landlords"
                          icon="AI"
                          autoRun={false}
                          cacheKey="market-economy-fed-ai-read"
                          cacheMode="local"
                          manualRefreshOnly={true}
                          collapsible={true}
                          defaultExpanded={true}
                          compact={true}
                        />

                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <SectionHeader title="Key rate & housing charts" description="Two primary trends; more under Advanced." />
                            <SegmentedToggle
                              value={economyChartGranularity}
                              onChange={setEconomyChartGranularity}
                              options={[
                                { value: 'quarterly', label: 'Q' },
                                { value: 'annual', label: 'Y' },
                              ]}
                            />
                          </div>
                          <div className="grid grid-cols-1 gap-3">
                            {economyChartDefinitions
                              .filter((chart) => ['core-pce', 'new-home-sales', 'breakeven-10y', 'jobless-claims'].includes(chart.key))
                              .filter((chart) => chart.series.values.length > 1)
                              .slice(0, 2)
                              .map((chart) => renderEconomyTrendChartCard(chart, true))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={() => setShowAdvancedAnalytics((value) => !value)}
                        className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-left transition hover:bg-slate-100"
                        data-voice-id="advanced-analytics-toggle"
                      >
                        <div>
                          <div className="text-sm font-semibold text-slate-900">Advanced analytics</div>
                          <p className="mt-0.5 text-xs text-slate-500">Extra trend charts, Beveridge curve, and investor ratio scatters.</p>
                        </div>
                        <span className="text-xs font-semibold text-slate-500">{showAdvancedAnalytics ? 'Hide' : 'Show'}</span>
                      </button>
                      {showAdvancedAnalytics && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
                            {economyChartDefinitions.filter((chart) => chart.series.values.length > 1).map((chart) => renderEconomyTrendChartCard(chart, true))}
                          </div>
                          {investorRatioCards.length > 0 && (
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                              {investorRatioCards.map((card) => renderInvestorRatioCard(card))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {fedPredictionCards.length > 0 && (
                      <div data-voice-id="polymarket-predictions-section"><Card surface="light">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <h3 className="text-base font-semibold text-slate-900">Market predictions</h3>
                            <p className="text-sm text-slate-500">Polymarket odds — contained detail band</p>
                          </div>
                          <a href="https://polymarket.com" target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-slate-600 hover:text-slate-900">
                            View all →
                          </a>
                        </div>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                          {fedPredictionCards.slice(0, 3).map((entry) => renderFedPredictionCard(entry))}
                        </div>
                      </Card></div>
                    )}
                  </>
                )}

                {assetOnlyMode && macroData && (
                  <div className="grid grid-cols-1 gap-4">
                    {economyCardSections
                      .flatMap((section) => section.cards)
                      .filter((card: any) => matchesFocusedMarketAsset(card.assetId))
                      .map((card: any) => renderEconomyMetricCard(card))}
                    {investorRatioCards.filter((card) => matchesFocusedMarketAsset(card.assetId)).map((card) => renderInvestorRatioCard(card))}
                    {economyChartDefinitions
                      .filter((chart) => chart.series.values.length > 1 && matchesFocusedMarketAsset(chart.assetId))
                      .map((chart) => renderEconomyTrendChartCard(chart, false))}
                    {Boolean(fedFocusedSection) && <FedMeetingSummary focusSection={fedFocusedSection} />}
                    {fedPredictionCards.filter((entry) => matchesFocusedMarketAsset(entry.assetId)).map((entry) => renderFedPredictionCard(entry))}
                  </div>
                )}
              </div>
            )}

            {/* Your Area Tab */}
            {resolvedActiveTab === 'your-area' && (
              <div className="space-y-5" data-voice-id="regional-tab">
                <SubTabs
                  activeId={yourAreaSubTab}
                  onChange={setYourAreaSubTab}
                  tabs={[
                    { id: 'my-location', label: 'My location', shortLabel: 'My location', description: 'Local KPIs, map, and comps around your properties', accent: 'slate' },
                    { id: 'compare-metros', label: 'Compare metros', shortLabel: 'Compare', description: 'National heat map and metro search', accent: 'sky' },
                  ]}
                />

                {yourAreaSubTab === 'my-location' && (
                  <MyRegionTab showAiBrief={true} />
                )}

                {yourAreaSubTab === 'compare-metros' && (
                  <div className="space-y-5">
                    <GlassCard className="p-5" data-voice-id="regional-search-card">
                      <h3 className="text-base font-semibold text-slate-900 mb-3">Search metros</h3>
                      <div className="relative mb-3">
                        <input
                          type="text"
                          placeholder="Search a metro (e.g., San Francisco, Miami, Chicago)..."
                          value={searchQuery}
                          onChange={(e) => handleSearchChange(e.target.value)}
                          onFocus={() => searchResults.length > 0 && setShowSearchResults(true)}
                          className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-300 transition-all"
                          data-voice-id="regional-search-input"
                        />
                        {showSearchResults && searchResults.length > 0 && (
                          <div className="absolute z-50 w-full mt-2 bg-white border border-slate-200 rounded-xl shadow-xl max-h-64 overflow-y-auto">
                            {searchResults.map((result) => (
                              <button
                                key={result.code}
                                onClick={() => {
                                  handleSelectRegion(result.code);
                                  setSearchQuery(result.name);
                                }}
                                className="w-full text-left px-4 py-3 hover:bg-slate-50 border-b border-slate-100 last:border-b-0 transition-colors"
                              >
                                <div className="font-medium text-slate-900">{result.name}</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2" data-voice-id="quick-select-metros">
                        <span className="text-sm text-slate-600 mr-1">Quick picks:</span>
                        {[
                          { name: 'San Francisco', code: 'san-francisco' },
                          { name: 'New York', code: 'new-york' },
                          { name: 'Chicago', code: 'chicago' },
                          { name: 'Miami', code: 'miami' },
                          { name: 'Dallas', code: 'dallas' },
                          { name: 'Seattle', code: 'seattle' },
                        ].map((metro) => (
                          <button
                            key={metro.code}
                            onClick={() => {
                              handleSelectRegion(metro.code);
                              setSearchQuery(metro.name);
                            }}
                            className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
                          >
                            {metro.name}
                          </button>
                        ))}
                      </div>
                    </GlassCard>

                    <div data-voice-id="regional-heat-map">
                      <Card surface="light">
                        <SectionHeader
                          title="National metro heat map"
                          description="Compare landlord-relevant metrics across major US metros."
                        />
                        <div className="mt-3">
                          <RegionalHeatMap loadGoogleMaps={loadGoogleMaps} />
                        </div>
                      </Card>
                    </div>

                    {regionLoading && (
                      <div className="text-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-700 mx-auto mb-3"></div>
                        <p className="text-slate-600 text-sm">Loading regional data...</p>
                      </div>
                    )}

                    {selectedRegion && !regionLoading && (
                      <div className="space-y-4" data-voice-id="selected-region-section">
                        <div className="flex items-center justify-between">
                          <h3 className="text-lg font-semibold text-slate-900">{selectedRegion.name}</h3>
                          <button
                            onClick={() => setSelectedRegion(null)}
                            className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1 rounded-lg hover:bg-slate-100 transition-colors"
                            data-voice-id="clear-region-btn"
                          >
                            Clear
                          </button>
                        </div>

                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-voice-id="regional-overview-cards">
                          <StatCard
                            label="Housing Price Index"
                            value={formatNumber(selectedRegion.overview.housingPrice.value)}
                            change={selectedRegion.overview.housingPrice.yoy}
                            changeLabel={`YoY${selectedRegion.overview.housingPrice.date ? ` · ${selectedRegion.overview.housingPrice.date}` : ''}`}
                          />
                          <StatCard
                            label="Median Household Income"
                            value={`$${formatNumber(selectedRegion.overview.medianIncome?.value || 'N/A')}`}
                            change={selectedRegion.overview.medianIncome?.growth}
                            changeLabel={`growth${selectedRegion.overview.medianIncome?.date ? ` · ${selectedRegion.overview.medianIncome.date}` : ''}`}
                          />
                          <StatCard
                            label="Unemployment Rate"
                            value={`${selectedRegion.overview.unemployment.value}%`}
                            change={selectedRegion.overview.unemployment.change}
                            changeLabel={`change${selectedRegion.overview.unemployment.date ? ` · ${selectedRegion.overview.unemployment.date}` : ''}`}
                            positive={false}
                          />
                          <StatCard
                            label="Active Listings"
                            value={formatNumber(selectedRegion.overview.activeListings?.value || 'N/A')}
                            change={selectedRegion.overview.activeListings?.yoy}
                            changeLabel={`YoY${selectedRegion.overview.activeListings?.date ? ` · ${selectedRegion.overview.activeListings.date}` : ''}`}
                          />
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-voice-id="regional-charts-grid">
                          <GlassCard className="p-5" data-voice-id="regional-housing-price-chart">
                            <h4 className="font-semibold text-slate-900 mb-4">Housing Price Index Trend</h4>
                            <ProfessionalLineChart
                              data={selectedRegion.charts.housing.map((d: any) => d.value)}
                              xLabels={selectedRegion.charts.housing.map((d: any) => d.date.substring(0, 7))}
                              color="#10b981"
                              dataLabel="Price Index"
                              isPercentage={false}
                              isCurrency={false}
                            />
                          </GlassCard>
                          <GlassCard className="p-5" data-voice-id="regional-unemployment-chart">
                            <h4 className="font-semibold text-slate-900 mb-4">Unemployment Rate</h4>
                            <ProfessionalLineChart
                              data={selectedRegion.charts.unemployment.map((d: any) => d.value)}
                              xLabels={selectedRegion.charts.unemployment.map((d: any) => d.date.substring(0, 7))}
                              color="#ef4444"
                              dataLabel="Unemployment %"
                              isPercentage={true}
                              isCurrency={false}
                            />
                          </GlassCard>
                        </div>

                        <GlassCard className="p-5" data-voice-id="zip-market-card">
                          <h3 className="text-base font-semibold text-slate-900 mb-1">ZIP market depth</h3>
                          <p className="text-sm text-slate-500 mb-3">Optional RentCast ZIP drill-down for the selected metro.</p>
                          <div className="flex flex-col md:flex-row gap-3">
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={5}
                              placeholder="Enter ZIP code"
                              value={zipMarketZipCode}
                              onChange={(e) => setZipMarketZipCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
                              className="w-full md:w-48 px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-300"
                              data-voice-id="zip-market-input"
                            />
                            <button
                              onClick={() => loadZipMarketData(zipMarketZipCode)}
                              disabled={zipMarketLoading}
                              className="px-5 py-3 rounded-xl bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-60"
                              data-voice-id="zip-market-load-btn"
                            >
                              {zipMarketLoading ? 'Loading…' : 'Load ZIP market'}
                            </button>
                          </div>
                          {zipMarketError && (
                            <div className="mt-3 text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3">{zipMarketError}</div>
                          )}
                          {zipMarketData && (
                            <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
                              <StatCard label="Median Asking Rent" value={formatCurrency(zipMarketData.derived?.medianAskingRent || 'N/A')} change={null} />
                              <StatCard label="Median Listing Price" value={formatCurrency(zipMarketData.derived?.medianSalePrice || 'N/A')} change={null} />
                              <StatCard label="Gross Yield Proxy" value={zipMarketData.derived?.grossYieldPct != null ? `${formatDecimal(zipMarketData.derived.grossYieldPct, 2)}%` : 'N/A'} change={null} />
                              <StatCard label="Price-To-Rent" value={zipMarketData.derived?.priceToRentRatio != null ? `${formatDecimal(zipMarketData.derived.priceToRentRatio, 2)}x` : 'N/A'} change={null} />
                            </div>
                          )}
                        </GlassCard>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {!marketEmbed && selectedOverviewChart && (
              <ChartModal
                onClose={() => setExpandedOverviewChart(null)}
                title={
                  <div>
                    <div className="text-[22px] font-semibold tracking-[-0.025em] text-slate-900">{selectedOverviewChart.title}</div>
                    <div className="mt-1 text-sm text-slate-500">{selectedOverviewChart.description}</div>
                  </div>
                }
                controls={
                  overviewChartControls
                }
              >
                <div className="h-full">
                  <ProfessionalLineChart
                    data={selectedOverviewChart.series.values}
                    xLabels={selectedOverviewChart.series.labels}
                    color={selectedOverviewChart.color}
                    dataLabel={selectedOverviewChart.dataLabel}
                    isPercentage={selectedOverviewChart.isPercentage}
                    isCurrency={selectedOverviewChart.isCurrency}
                    showArea={selectedOverviewChart.showArea}
                    showPoints={false}
                    variant="expanded"
                  />
                </div>
              </ChartModal>
            )}
            {!marketEmbed && showRentalCalculatorModal && (
              <RentalPropertyCalculatorModal
                isOpen={showRentalCalculatorModal}
                onClose={() => setShowRentalCalculatorModal(false)}
              />
            )}

            {!marketEmbed && selectedEconomyChart && (
              <ChartModal
                onClose={() => setExpandedEconomyChart(null)}
                title={
                  <div>
                    <div className="text-[22px] font-semibold tracking-[-0.025em] text-slate-900">{selectedEconomyChart.title}</div>
                    <div className="mt-1 text-sm text-slate-500">{selectedEconomyChart.description}</div>
                  </div>
                }
                controls={
                  <SegmentedToggle
                    value={economyChartGranularity}
                    onChange={setEconomyChartGranularity}
                    options={[
                      { value: 'quarterly', label: 'Quarterly' },
                      { value: 'annual', label: 'Annually' },
                    ]}
                  />
                }
              >
                <div className="h-full">
                  <ProfessionalLineChart
                    data={selectedEconomyChart.series.values}
                    xLabels={selectedEconomyChart.series.labels}
                    color={selectedEconomyChart.color}
                    dataLabel={selectedEconomyChart.dataLabel}
                    isPercentage={selectedEconomyChart.isPercentage}
                    isCurrency={selectedEconomyChart.isCurrency}
                    showArea={selectedEconomyChart.showArea}
                    showPoints={false}
                    variant="expanded"
                  />
                </div>
              </ChartModal>
            )}

          </div>
        </div>
    </PageShell>
  );
};
interface ProfessionalBarChartProps {
  data: number[];
  xLabels?: string[];
  color?: string;
  secondaryData?: number[];
  secondaryColor?: string;
  secondaryLabel?: string;
  tertiaryData?: number[];
  tertiaryColor?: string;
  tertiaryLabel?: string;
  allowNegative?: boolean;
  isPercentage?: boolean;
  isCurrency?: boolean;
  dataLabel?: string;
  isQuarterly?: boolean;
  stackFirstTwo?: boolean; // Stack primary and secondary data, show tertiary separately
  dataInThousands?: boolean; // If true, data is already divided by 1000
  useDualAxis?: boolean; // If true, tertiary data uses separate right Y-axis
  tertiaryAsLine?: boolean; // If true, render tertiary data as line instead of bar
  variant?: ChartVariant;
}

const ProfessionalBarChart: React.FC<ProfessionalBarChartProps> = ({
  data,
  xLabels,
  color = '#3b82f6',
  secondaryData,
  secondaryColor = '#10b981',
  secondaryLabel = 'Secondary',
  tertiaryData,
  tertiaryColor = '#f59e0b',
  tertiaryLabel = 'Tertiary',
  allowNegative = false,
  isPercentage = false,
  isCurrency = true,
  dataLabel = 'Value',
  isQuarterly = false,
  stackFirstTwo = false,
  dataInThousands = false,
  useDualAxis = false,
  tertiaryAsLine = false,
  variant = 'compact'
}) => {
  const chartId = React.useId().replace(/:/g, '');
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const sanitizeColor = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '');
  const primaryGradientId = `${chartId}-primary-${sanitizeColor(color)}`;
  const secondaryGradientId = `${chartId}-secondary-${sanitizeColor(secondaryColor)}`;
  const tertiaryGradientId = `${chartId}-tertiary-${sanitizeColor(tertiaryColor)}`;
  const shadowId = `${chartId}-shadow`;
  const hoverBandId = `${chartId}-hover-band`;
  
  // For dual axis, calculate separate ranges for left (stacked) and right (tertiary)
  let max, min, tertiaryMax, tertiaryMin;
  
  if (useDualAxis && tertiaryData) {
    // Left axis: stacked data
    const stackedData = stackFirstTwo && secondaryData 
      ? data.map((v, i) => v + (secondaryData[i] || 0))
      : [...data, ...(secondaryData || [])];
    max = Math.max(...stackedData, 0);
    min = allowNegative ? Math.min(...stackedData, 0) : 0;
    
    // Right axis: tertiary data
    tertiaryMax = Math.max(...tertiaryData, 0);
    tertiaryMin = 0;
  } else {
    // Single axis: all data together
    const allData = stackFirstTwo && secondaryData 
      ? [...data.map((v, i) => v + (secondaryData[i] || 0)), ...(tertiaryData || [])]
      : [...data, ...(secondaryData || []), ...(tertiaryData || [])];
    max = Math.max(...allData, 0);
    min = allowNegative ? Math.min(...allData, 0) : 0;
  }
  
  // Build a 6-tick axis including 0; signed checks not needed.
  const calcNiceMax = (target: number) => {
    if (target <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(target)));
    const steps = [1, 2, 2.5, 5, 7.5, 10];
    for (const s of steps) {
      const n = s * mag;
      if (n >= target) return n;
    }
    return target;
  };
  // Choose a nice step and symmetric bounds so that with 6 ticks, 0 is always one of them.
  const niceStep = (target: number) => {
    if (target <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(target)));
    const steps = [1, 2, 2.5, 5, 7.5, 10];
    for (const s of steps) {
      const n = s * mag;
      if (n >= target) return n;
    }
    return target;
  };

  const posExtent = Math.max(0, max);
  const negExtent = allowNegative ? Math.max(0, -min) : 0;
  let stepGuess = niceStep(Math.max((posExtent + negExtent) / 5, 1e-6));
  let j = 0; // number of steps below zero (0..5)
  for (let iter = 0; iter < 12; iter++) {
    j = Math.min(5, Math.ceil(negExtent / stepGuess));
    const needAbove = Math.ceil(posExtent / stepGuess);
    if ((5 - j) < needAbove) {
      stepGuess = niceStep(stepGuess * 1.1);
      continue;
    }
    break;
  }
  const niceMin = -j * stepGuess;
  const niceMax = (5 - j) * stepGuess;
  
  // Calculate tertiary axis if dual axis
  let niceMaxTertiary = 0, niceMinTertiary = 0, tertiaryTicks: number[] = [];
  if (useDualAxis && tertiaryData) {
    const tertiaryPad = ((tertiaryMax || 0) - (tertiaryMin || 0)) * 0.15;
    niceMaxTertiary = calcNiceMax((tertiaryMax || 0) + tertiaryPad);
    niceMinTertiary = 0;
    
    for (let i = 0; i < 6; i++) {
      tertiaryTicks.push(niceMinTertiary + (niceMaxTertiary - niceMinTertiary) * (i / 5));
    }
  }
  
  const W = variant === 'compact' ? 520 : 1080;
  const H = variant === 'compact' ? 270 : 560;
  const LP = variant === 'compact' ? 48 : 72;
  const RP = useDualAxis ? (variant === 'compact' ? 84 : 110) : (variant === 'compact' ? 18 : 28);
  const TP = variant === 'compact' ? 16 : 24;
  const BP = variant === 'compact' ? 54 : 84;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;
  
  // Always 6 Y ticks, evenly spaced, with 0 guaranteed as a tick
  const ticks = 6;
  const yTicks: number[] = [];
  for (let i = 0; i < ticks; i++) {
    yTicks.push(niceMin + (niceMax - niceMin) * (i / (ticks - 1)));
  }
  
  const zeroY = niceMin === 0 ? TP + innerH : TP + innerH - ((-niceMin) / (niceMax - niceMin)) * innerH;
  
  const labels = xLabels || generateYearLabels(data.length, isQuarterly);
  const xTickIndices = getVisibleAxisIndices(labels.length, variant === 'compact' ? 6 : 10);
  const rotateLabels = xTickIndices.length > 5 || xTickIndices.some((index) => labels[index]?.length > 5);
  
  const gap = 8;
  const groupWidth = (innerW - gap * (data.length - 1)) / data.length;
  // If dual axis with stacked bars, we only have 1 bar (line doesn't count)
  // If stacking first two normally, we have 2 bars (stacked + tertiary)
  // Otherwise 3 separate bars
  const numBars = (stackFirstTwo && useDualAxis) ? 1 : (stackFirstTwo && tertiaryData ? 2 : (1 + (secondaryData ? 1 : 0) + (tertiaryData ? 1 : 0)));
  const barGap = 3;
  const rawBarWidth = (groupWidth - barGap * (numBars - 1)) / numBars;
  const bw = Math.min(rawBarWidth, variant === 'compact' ? 22 : 30);
  const contentWidth = (bw * numBars) + (barGap * (numBars - 1));
  
  const formatValue = (v: number) => {
    if (isPercentage) return formatPercentage(v);
    if (isCurrency) {
      // If data is in thousands, multiply back to get actual value
      const actualValue = dataInThousands ? v * 1000 : v;
      return formatCurrency(actualValue);
    }
    return v.toFixed(2);
  };
  
  const formatAxisValue = (v: number) => {
    if (isPercentage) return `${v.toFixed(0)}%`;
    if (isCurrency) {
      // If data is in thousands, multiply back to get actual value
      const actualValue = dataInThousands ? v * 1000 : v;
      return formatCompactCurrency(actualValue);
    }
    return v.toFixed(0);
  };
  
  return (
    <div className="h-full w-full relative">
      <svg 
        viewBox={`0 0 ${W} ${H}`} 
        className="w-full h-full"
      >
        <defs>
          <linearGradient id={primaryGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.72" />
          </linearGradient>
          <linearGradient id={secondaryGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={secondaryColor} stopOpacity="1" />
            <stop offset="100%" stopColor={secondaryColor} stopOpacity="0.72" />
          </linearGradient>
          <linearGradient id={tertiaryGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tertiaryColor} stopOpacity="1" />
            <stop offset="100%" stopColor={tertiaryColor} stopOpacity="0.76" />
          </linearGradient>
          <filter id={shadowId} x="-20%" y="-20%" width="140%" height="160%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#0f172a" floodOpacity="0.12" />
          </filter>
          <linearGradient id={hoverBandId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e2e8f0" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#e2e8f0" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        {/* Horizontal grid lines */}
        {yTicks.map(tick => {
          const y = TP + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <line
              key={tick}
              x1={LP}
              x2={LP + innerW}
              y1={y}
              y2={y}
              stroke="#e2e8f0"
              strokeWidth={1}
              strokeDasharray="4 6"
            />
          );
        })}
        
        {/* Subtle baseline */}
        <line x1={LP} x2={LP + innerW} y1={TP + innerH} y2={TP + innerH} stroke="#cbd5e1" strokeOpacity={0.9} strokeWidth={1.25} />
        
        {/* Zero line for negative values */}
        {allowNegative && niceMin < 0 && niceMax > 0 && (
          <line x1={LP} x2={LP + innerW} y1={zeroY} y2={zeroY} stroke="#94a3b8" strokeOpacity={0.85} strokeWidth={1.25} />
        )}
        
        {/* Bars */}
        {data.map((val, i) => {
          const xGroup = LP + i * (groupWidth + gap) + Math.max((groupWidth - contentWidth) / 2, 0);
          const isHovered = hoveredIndex === i;
          const hoverX = xGroup - 4;
          const hoverWidth = Math.max(contentWidth + 8, bw + 8);
          
          if (stackFirstTwo && secondaryData && useDualAxis) {
            // For dual axis mortgage chart: normalize to 100% height
            const interestVal = val;
            const principalVal = secondaryData[i] || 0;
            const totalPayment = interestVal + principalVal;
            
            // Calculate percentages
            const interestPct = totalPayment > 0 ? interestVal / totalPayment : 0;
            const principalPct = totalPayment > 0 ? principalVal / totalPayment : 0;
            
            // Heights based on percentage (always fills to 100%)
            const principalHeightPx = principalPct * innerH;
            const interestHeightPx = interestPct * innerH;
            
            // Y positions: Principal on bottom, Interest on top
            const yPrincipal = TP + innerH - principalHeightPx; // Principal starts from bottom
            const yInterest = TP; // Interest starts at top
            
            return (
              <g key={i}>
                {isHovered && (
                  <rect x={hoverX} y={TP - 2} width={hoverWidth} height={innerH + 6} rx={10} fill={`url(#${hoverBandId})`} />
                )}
                {/* Principal (bottom part) */}
                <rect 
                  x={xGroup} 
                  y={yPrincipal} 
                  width={bw} 
                  height={principalHeightPx} 
                  rx={5}
                  fill={`url(#${secondaryGradientId})`}
                  opacity={isHovered ? 1 : 0.88}
                  filter={isHovered ? `url(#${shadowId})` : undefined}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
                {/* Interest (top part, stacked on principal) */}
                <rect 
                  x={xGroup} 
                  y={yInterest} 
                  width={bw} 
                  height={interestHeightPx} 
                  rx={5}
                  fill={`url(#${primaryGradientId})`}
                  opacity={isHovered ? 1 : 0.9}
                  filter={isHovered ? `url(#${shadowId})` : undefined}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              </g>
            );
          } else if (stackFirstTwo && secondaryData) {
            // Stacked bar: data (bottom) + secondaryData (top)
            const interestVal = val; // primary value
            const principalVal = secondaryData[i] || 0; // secondary value

            // Helper to map value to Y
            const toY = (v: number) => TP + innerH - ((v - niceMin) / (niceMax - niceMin)) * innerH;
            const zeroYLocal = toY(0);

            // Heights from zero baseline
            const interestHeightPx = Math.abs(toY(interestVal) - zeroYLocal);
            const principalHeightPx = Math.abs(toY(principalVal) - zeroYLocal);

            // Y positions: start at zero baseline and stack upward
            const yInterest = zeroYLocal - interestHeightPx;
            const yPrincipal = yInterest - principalHeightPx;
            
            return (
              <g key={i}>
                {isHovered && (
                  <rect x={hoverX} y={TP - 2} width={hoverWidth + bw + barGap} height={innerH + 6} rx={10} fill={`url(#${hoverBandId})`} />
                )}
                {/* Interest (bottom part in red) */}
                <rect 
                  x={xGroup} 
                  y={yInterest} 
                  width={bw} 
                  height={interestHeightPx} 
                  rx={5}
                  fill={`url(#${primaryGradientId})`}
                  opacity={isHovered ? 1 : 0.9}
                  filter={isHovered ? `url(#${shadowId})` : undefined}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
                {/* Principal (top part in green, stacked on interest) */}
                <rect 
                  x={xGroup} 
                  y={yPrincipal} 
                  width={bw} 
                  height={principalHeightPx} 
                  rx={5}
                  fill={`url(#${secondaryGradientId})`}
                  opacity={isHovered ? 1 : 0.9}
                  filter={isHovered ? `url(#${shadowId})` : undefined}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
                {/* Tertiary data (separate bar or line, may use dual axis) - only render bar if not tertiaryAsLine */}
                {tertiaryData && !tertiaryAsLine && (
                  <rect
                    x={xGroup + bw + barGap}
                    y={useDualAxis 
                      ? TP + innerH - ((tertiaryData[i] / (niceMaxTertiary - niceMinTertiary)) * innerH)
                      : TP + innerH - ((tertiaryData[i] / (niceMax - niceMin)) * innerH)
                    }
                    width={bw}
                    height={useDualAxis
                      ? (tertiaryData[i] / (niceMaxTertiary - niceMinTertiary)) * innerH
                      : (tertiaryData[i] / (niceMax - niceMin)) * innerH
                    }
                    rx={5}
                    fill={`url(#${tertiaryGradientId})`}
                    opacity={isHovered ? 1 : 0.9}
                    filter={isHovered ? `url(#${shadowId})` : undefined}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  />
                )}
              </g>
            );
          } else {
            // Regular separate bars anchored at zero baseline
            const toY = (v: number) => TP + innerH - ((v - niceMin) / (niceMax - niceMin)) * innerH;
            const yZero = toY(0);
            const yVal = toY(val);
            const h = Math.abs(yVal - yZero);
            const y = Math.min(yZero, yVal);
            
            return (
              <g key={i}>
                {isHovered && (
                  <rect x={hoverX} y={TP - 2} width={groupWidth + 8} height={innerH + 6} rx={10} fill={`url(#${hoverBandId})`} />
                )}
                <rect 
                  x={xGroup} 
                  y={y} 
                  width={bw} 
                  height={h} 
                  rx={5} 
                  fill={`url(#${primaryGradientId})`}
                  opacity={isHovered ? 1 : 0.88}
                  filter={isHovered ? `url(#${shadowId})` : undefined}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
                {secondaryData && (
                  (() => {
                    const sVal = secondaryData[i] || 0;
                    const sY = toY(sVal);
                    const sH = Math.abs(sY - yZero);
                    const sRectY = Math.min(yZero, sY);
                    return (
                      <rect
                        x={xGroup + bw + barGap}
                        y={sRectY}
                        width={bw}
                        height={sH}
                        rx={5}
                        fill={`url(#${secondaryGradientId})`}
                        opacity={isHovered ? 1 : 0.88}
                        filter={isHovered ? `url(#${shadowId})` : undefined}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={() => setHoveredIndex(i)}
                        onMouseLeave={() => setHoveredIndex(null)}
                      />
                    );
                  })()
                )}
                {tertiaryData && (
                  (() => {
                    const tVal = tertiaryData[i] || 0;
                    const tY = toY(tVal);
                    const tH = Math.abs(tY - yZero);
                    const tRectY = Math.min(yZero, tY);
                    return (
                      <rect
                        x={xGroup + (bw + barGap) * 2}
                        y={tRectY}
                        width={bw}
                        height={tH}
                        rx={5}
                        fill={`url(#${tertiaryGradientId})`}
                        opacity={isHovered ? 1 : 0.88}
                        filter={isHovered ? `url(#${shadowId})` : undefined}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={() => setHoveredIndex(i)}
                        onMouseLeave={() => setHoveredIndex(null)}
                      />
                    );
                  })()
                )}
              </g>
            );
          }
        })}
        
        {/* Tertiary Data Line (for dual axis when tertiaryAsLine is true) */}
        {useDualAxis && tertiaryData && tertiaryAsLine && (
          <>
            {/* Line path */}
            <path
              d={tertiaryData.map((val, i) => {
                const x = LP + i * (groupWidth + gap) + groupWidth / 2;
                const y = TP + innerH - ((val - niceMinTertiary) / (niceMaxTertiary - niceMinTertiary)) * innerH;
                return `${i === 0 ? 'M' : 'L'}${x},${y}`;
              }).join(' ')}
              stroke={tertiaryColor}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter={`url(#${shadowId})`}
            />
            {/* Data points on line */}
            {tertiaryData.map((val, i) => {
              const x = LP + i * (groupWidth + gap) + groupWidth / 2;
              const y = TP + innerH - ((val - niceMinTertiary) / (niceMaxTertiary - niceMinTertiary)) * innerH;
              return (
                <circle
                  key={`point-${i}`}
                  cx={x}
                  cy={y}
                  r={4}
                  fill={tertiaryColor}
                  stroke="white"
                  strokeWidth={2}
                  filter={`url(#${shadowId})`}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              );
            })}
          </>
        )}
        
        {/* Y-axis labels (left) */}
        {yTicks.map(tick => {
          const y = TP + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <text
              key={`y-${tick}`}
              x={LP - 10}
              y={y + 4}
              textAnchor="end"
              fontSize={variant === 'compact' ? 10 : 12}
              fill="#64748b"
              fontWeight="500"
            >
              {formatAxisValue(tick)}
            </text>
          );
        })}
        {/* Fallback 0 label to guarantee visibility when ticks miss it */}
        {((niceMin === 0) || (niceMin < 0 && niceMax > 0)) && !yTicks.some(t => Math.abs(t) < 1e-6) && (
          <text
            x={LP - 10}
            y={zeroY + 4}
            textAnchor="end"
            fontSize={10}
            fill="#64748b"
            fontWeight="500"
          >
            {formatAxisValue(0)}
          </text>
        )}
        
        {/* Y-axis labels (right) for dual axis */}
        {useDualAxis && tertiaryTicks.map(tick => {
          const y = TP + innerH - ((tick - niceMinTertiary) / (niceMaxTertiary - niceMinTertiary)) * innerH;
          return (
            <text
              key={`y-right-${tick}`}
              x={LP + innerW + 10}
              y={y + 4}
              textAnchor="start"
              fontSize={variant === 'compact' ? 10 : 12}
              fill="#64748b"
              fontWeight="500"
            >
              {formatAxisValue(tick)}
            </text>
          );
        })}
        
        {/* Right Y-axis line for dual axis */}
        {useDualAxis && (
          <line 
            x1={LP + innerW} 
            y1={TP} 
            x2={LP + innerW} 
            y2={TP + innerH} 
            stroke="#cbd5e1" 
            strokeWidth={1.25} 
          />
        )}
        
        {/* X-axis labels */}
        {xTickIndices.map((i) => {
          const label = labels[i];
          const xGroup = LP + i * (groupWidth + gap);
          const xCenter = xGroup + groupWidth / 2;
          return (
            <text
              key={`x-${i}`}
              x={xCenter}
              y={H - 12}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              fontSize={variant === 'compact' ? 10 : 12}
              fill="#64748b"
              fontWeight="500"
              transform={rotateLabels ? `rotate(-34 ${xCenter} ${H - 12})` : undefined}
            >
              {label}
            </text>
          );
        })}
      </svg>
      
      {/* Tooltip */}
      {hoveredIndex !== null && (
        <div 
          className="absolute z-50 rounded-xl border border-slate-700/40 bg-slate-900/95 px-4 py-3 text-sm text-white shadow-xl backdrop-blur-sm pointer-events-none"
          style={{
            left: '50%',
            top: '8px',
            transform: 'translateX(-50%)',
          }}
        >
          <div className="font-semibold mb-1.5 text-slate-100">{labels[hoveredIndex]}</div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }}></div>
            <span className="text-slate-300">{dataLabel}:</span>
            <span className="font-medium">{formatValue(data[hoveredIndex])}</span>
          </div>
          {secondaryData && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: secondaryColor }}></div>
              <span className="text-slate-300">{secondaryLabel}:</span>
              <span className="font-medium">{formatValue(secondaryData[hoveredIndex])}</span>
            </div>
          )}
          {tertiaryData && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: tertiaryColor }}></div>
              <span className="text-slate-300">{tertiaryLabel}:</span>
              <span className="font-medium">{formatValue(tertiaryData[hoveredIndex])}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
/* ── Beveridge Curve Scatter Plot ── */
interface BeveridgeCurvePoint { date: string; unemployment: number; vacancyRate: number; }
interface BeveridgeCurveChartProps {
  points: BeveridgeCurvePoint[];
  latest: BeveridgeCurvePoint;
  direction: string;
}

const BeveridgeCurveChart: React.FC<BeveridgeCurveChartProps> = ({ points, latest, direction }) => {
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);

  if (!points || points.length < 4) return null;

  // Chart dimensions
  const W = 560, H = 400, LP = 62, RP = 24, TP = 24, BP = 56;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;

  // Axis ranges with padding
  const allU = points.map(p => p.unemployment);
  const allV = points.map(p => p.vacancyRate);
  const uMin = Math.floor(Math.min(...allU) * 2) / 2;
  const uMax = Math.ceil(Math.max(...allU) * 2) / 2;
  const vMin = Math.floor(Math.min(...allV) * 2) / 2;
  const vMax = Math.ceil(Math.max(...allV) * 2) / 2;
  const uRange = uMax - uMin || 1;
  const vRange = vMax - vMin || 1;

  const toX = (u: number) => LP + ((u - uMin) / uRange) * innerW;
  const toY = (v: number) => TP + innerH - ((v - vMin) / vRange) * innerH;

  // Generate tick arrays
  const uStep = uRange <= 4 ? 0.5 : uRange <= 8 ? 1 : 2;
  const vStep = vRange <= 4 ? 0.5 : vRange <= 8 ? 1 : 2;
  const uTicks: number[] = [];
  for (let t = uMin; t <= uMax + 0.01; t += uStep) uTicks.push(Math.round(t * 10) / 10);
  const vTicks: number[] = [];
  for (let t = vMin; t <= vMax + 0.01; t += vStep) vTicks.push(Math.round(t * 10) / 10);

  // Build path (chronological line connecting dots)
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.unemployment)},${toY(p.vacancyRate)}`).join(' ');

  // Color gradient: older points are dim, newer are bright
  const pointColor = (idx: number) => {
    const t = idx / (points.length - 1); // 0 → oldest, 1 → newest
    const r = Math.round(99 + (59 - 99) * t);
    const g = Math.round(102 + (130 - 102) * t);
    const b = Math.round(241 + (246 - 241) * t);
    return `rgb(${r},${g},${b})`;
  };

  const dirLabel = direction === 'tightening' ? 'Labor market tightening' :
                   direction === 'loosening' ? 'Labor market loosening' : 'Shifting dynamics';

  return (
    <div className="w-full relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 420 }}>
        {/* Grid lines */}
        {uTicks.map(t => (
          <line key={`ug-${t}`} x1={toX(t)} x2={toX(t)} y1={TP} y2={TP + innerH} stroke="#e5e7eb" strokeWidth={0.7} />
        ))}
        {vTicks.map(t => (
          <line key={`vg-${t}`} x1={LP} x2={LP + innerW} y1={toY(t)} y2={toY(t)} stroke="#e5e7eb" strokeWidth={0.7} />
        ))}

        {/* Axes */}
        <line x1={LP} x2={LP} y1={TP} y2={TP + innerH} stroke="#94a3b8" strokeWidth={1.2} />
        <line x1={LP} x2={LP + innerW} y1={TP + innerH} y2={TP + innerH} stroke="#94a3b8" strokeWidth={1.2} />

        {/* Axis labels */}
        <text x={LP + innerW / 2} y={H - 8} textAnchor="middle" fontSize={12} fill="#475569" fontWeight={600}>
          Unemployment Rate (%)
        </text>
        <text x={14} y={TP + innerH / 2} textAnchor="middle" fontSize={12} fill="#475569" fontWeight={600}
          transform={`rotate(-90, 14, ${TP + innerH / 2})`}>
          Job Vacancy Rate (%)
        </text>

        {/* X tick labels */}
        {uTicks.map(t => (
          <text key={`ul-${t}`} x={toX(t)} y={TP + innerH + 18} textAnchor="middle" fontSize={10} fill="#64748b">
            {t.toFixed(1)}%
          </text>
        ))}
        {/* Y tick labels */}
        {vTicks.map(t => (
          <text key={`vl-${t}`} x={LP - 8} y={toY(t) + 4} textAnchor="end" fontSize={10} fill="#64748b">
            {t.toFixed(1)}%
          </text>
        ))}

        {/* Connecting path — faint so dots dominate */}
        <path d={pathD} fill="none" stroke="#a5b4fc" strokeWidth={1.5} strokeOpacity={0.5} strokeLinejoin="round" />

        {/* Arrow head on newest end */}
        {points.length >= 2 && (() => {
          const p1 = points[points.length - 2];
          const p2 = points[points.length - 1];
          const x1 = toX(p1.unemployment), y1 = toY(p1.vacancyRate);
          const x2 = toX(p2.unemployment), y2 = toY(p2.vacancyRate);
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const aLen = 10;
          const spread = 0.45;
          return (
            <polygon
              points={`${x2},${y2} ${x2 - aLen * Math.cos(angle - spread)},${y2 - aLen * Math.sin(angle - spread)} ${x2 - aLen * Math.cos(angle + spread)},${y2 - aLen * Math.sin(angle + spread)}`}
              fill="#4f46e5"
            />
          );
        })()}

        {/* Data points */}
        {points.map((p, i) => {
          const cx = toX(p.unemployment);
          const cy = toY(p.vacancyRate);
          const isLatest = i === points.length - 1;
          const isHovered = hoveredIdx === i;
          return (
            <g key={i}>
              <circle
                cx={cx}
                cy={cy}
                r={isLatest ? 7 : isHovered ? 6 : 4}
                fill={isLatest ? '#4f46e5' : pointColor(i)}
                stroke={isLatest ? '#fff' : 'none'}
                strokeWidth={isLatest ? 2 : 0}
                style={{ cursor: 'pointer', transition: 'r 0.15s' }}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              />
              {isLatest && (
                <text x={cx + 10} y={cy - 6} fontSize={10} fill="#4f46e5" fontWeight={700}>Now</text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredIdx !== null && (() => {
        const p = points[hoveredIdx];
        const cx = toX(p.unemployment);
        const cy = toY(p.vacancyRate);
        // Position tooltip so it doesn't clip
        const ttLeft = cx > W / 2 ? cx - 170 : cx + 16;
        const ttTop = cy > H / 2 ? cy - 70 : cy + 8;
        return (
          <div
            className="absolute pointer-events-none bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs z-20"
            style={{
              left: `${(ttLeft / W) * 100}%`,
              top: `${(ttTop / H) * 100}%`,
              minWidth: 150
            }}
          >
            <div className="font-semibold text-slate-800 mb-1">{p.date}</div>
            <div className="text-slate-600">Unemployment: <span className="font-medium text-slate-900">{p.unemployment.toFixed(1)}%</span></div>
            <div className="text-slate-600">Vacancy Rate: <span className="font-medium text-slate-900">{p.vacancyRate.toFixed(1)}%</span></div>
          </div>
        );
      })()}

      {/* Direction badge */}
      <div className="mt-3 flex items-center gap-2">
        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${
          direction === 'tightening' ? 'bg-amber-100 text-amber-800' :
          direction === 'loosening' ? 'bg-blue-100 text-blue-800' :
          'bg-slate-100 text-slate-700'
        }`}>
          {dirLabel}
        </span>
        <span className="text-xs text-slate-500">
          Latest: U={latest.unemployment.toFixed(1)}%, V={latest.vacancyRate.toFixed(1)}%
        </span>
      </div>
    </div>
  );
};

/* ── Generic Investor Scatter Chart ── */
interface InvestorScatterChartProps {
  points: any[];
  xKey: string;
  yKey: string;
  xLabel: string;
  yLabel: string;
  formatX: (v: number) => string;
  formatY: (v: number) => string;
  color: string;
  showDiagonal?: boolean;
}

const InvestorScatterChart: React.FC<InvestorScatterChartProps> = ({
  points, xKey, yKey, xLabel, yLabel, formatX, formatY, color, showDiagonal
}) => {
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);

  if (!points || points.length < 4) return null;

  const W = 520, H = 310, LP = 44, RP = 10, TP = 10, BP = 30;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;

  const allX = points.map((p: any) => p[xKey]);
  const allY = points.map((p: any) => p[yKey]);
  const xMin = Math.min(...allX);
  const xMax = Math.max(...allX);
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);
  const xPad = (xMax - xMin) * 0.08 || 1;
  const yPad = (yMax - yMin) * 0.08 || 1;
  const { niceMin: xLo, niceMax: xHi, ticks: xTicks } = getNiceContinuousAxis(xMin - xPad, xMax + xPad, 6);
  const { niceMin: yLo, niceMax: yHi, ticks: yTicks } = getNiceContinuousAxis(yMin - yPad, yMax + yPad, 6);
  const xRange = xHi - xLo;
  const yRange = yHi - yLo;

  const toX = (v: number) => LP + ((v - xLo) / xRange) * innerW;
  const toY = (v: number) => TP + innerH - ((v - yLo) / yRange) * innerH;

  // Build chronological path
  const pathD = points.map((p: any, i: number) =>
    `${i === 0 ? 'M' : 'L'}${toX(p[xKey])},${toY(p[yKey])}`
  ).join(' ');

  // Color gradient by age
  const pointFill = (idx: number) => {
    const t = idx / (points.length - 1);
    // Parse the base color's hex
    const r0 = 200, g0 = 200, b0 = 200; // old: gray
    const matches = color.match(/\w\w/g);
    const [r1, g1, b1] = matches
      ? [parseInt(matches[0], 16), parseInt(matches[1], 16), parseInt(matches[2], 16)]
      : [79, 70, 229]; // fallback indigo
    return `rgb(${Math.round(r0 + (r1 - r0) * t)},${Math.round(g0 + (g1 - g0) * t)},${Math.round(b0 + (b1 - b0) * t)})`;
  };

  return (
    <div className="w-full relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
        {/* Grid */}
        {xTicks.map((t, i) => (
          <line key={`xg${i}`} x1={toX(t)} x2={toX(t)} y1={TP} y2={TP + innerH} stroke="#e5e7eb" strokeWidth={0.6} />
        ))}
        {yTicks.map((t, i) => (
          <line key={`yg${i}`} x1={LP} x2={LP + innerW} y1={toY(t)} y2={toY(t)} stroke="#e5e7eb" strokeWidth={0.6} />
        ))}

        {/* Diagonal reference line (for cap rate spread chart) */}
        {showDiagonal && (
          <line
            x1={toX(Math.max(xLo, yLo))} y1={toY(Math.max(xLo, yLo))}
            x2={toX(Math.min(xHi, yHi))} y2={toY(Math.min(xHi, yHi))}
            stroke="#94a3b8" strokeWidth={1} strokeDasharray="6,4" opacity={0.5}
          />
        )}

        {/* Axes */}
        <line x1={LP} x2={LP} y1={TP} y2={TP + innerH} stroke="#cbd5e1" strokeWidth={1} />
        <line x1={LP} x2={LP + innerW} y1={TP + innerH} y2={TP + innerH} stroke="#cbd5e1" strokeWidth={1} />

        {/* Axis labels */}
        <text x={LP + innerW / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="#111827" fontWeight={700}>{xLabel}</text>
        <text x={12} y={TP + innerH / 2} textAnchor="middle" fontSize={11} fill="#111827" fontWeight={700}
          transform={`rotate(-90, 12, ${TP + innerH / 2})`}>{yLabel}</text>

        {/* Tick labels */}
        {xTicks.map((t, i) => (
          <text key={`xl${i}`} x={toX(t)} y={TP + innerH + 15} textAnchor="middle" fontSize={9} fill="#111827" fontWeight={600}>{formatX(t)}</text>
        ))}
        {yTicks.map((t, i) => (
          <text key={`yl${i}`} x={LP - 6} y={toY(t) + 3} textAnchor="end" fontSize={9} fill="#111827" fontWeight={600}>{formatY(t)}</text>
        ))}

        {/* Path */}
        <path d={pathD} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.3} strokeLinejoin="round" />

        {/* Arrow head */}
        {points.length >= 2 && (() => {
          const p1 = points[points.length - 2];
          const p2 = points[points.length - 1];
          const x1 = toX(p1[xKey]), y1 = toY(p1[yKey]);
          const x2 = toX(p2[xKey]), y2 = toY(p2[yKey]);
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const aLen = 9;
          const spread = 0.4;
          return (
            <polygon
              points={`${x2},${y2} ${x2 - aLen * Math.cos(angle - spread)},${y2 - aLen * Math.sin(angle - spread)} ${x2 - aLen * Math.cos(angle + spread)},${y2 - aLen * Math.sin(angle + spread)}`}
              fill={color}
            />
          );
        })()}

        {/* Data points */}
        {points.map((p: any, i: number) => {
          const cx = toX(p[xKey]);
          const cy = toY(p[yKey]);
          const isLatest = i === points.length - 1;
          const isHovered = hoveredIdx === i;
          return (
            <g key={i}>
              <circle
                cx={cx} cy={cy}
                r={isLatest ? 6 : isHovered ? 5 : 3.5}
                fill={isLatest ? color : pointFill(i)}
                stroke={isLatest ? '#fff' : 'none'}
                strokeWidth={isLatest ? 2 : 0}
                style={{ cursor: 'pointer', transition: 'r 0.15s' }}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              />
              {isLatest && (
                <text x={cx + 9} y={cy - 5} fontSize={9} fill={color} fontWeight={700}>Latest</text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredIdx !== null && (() => {
        const p = points[hoveredIdx];
        const cx = toX(p[xKey]);
        const cy = toY(p[yKey]);
        const ttLeft = cx > W / 2 ? cx - 160 : cx + 14;
        const ttTop = cy > H / 2 ? cy - 60 : cy + 8;
        return (
          <div
            className="absolute pointer-events-none bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs z-20"
            style={{
              left: `${(ttLeft / W) * 100}%`,
              top: `${(ttTop / H) * 100}%`,
              minWidth: 140
            }}
          >
            <div className="font-semibold text-slate-800 mb-1">{p.date}</div>
            <div className="text-slate-600">{xLabel.split('(')[0].trim()}: <span className="font-medium text-slate-900">{formatX(p[xKey])}</span></div>
            <div className="text-slate-600">{yLabel.split('(')[0].trim()}: <span className="font-medium text-slate-900">{formatY(p[yKey])}</span></div>
          </div>
        );
      })()}

      {/* Latest badge */}
      <div className="mt-2 text-[11px] text-slate-500">
        Latest {points[points.length - 1].date}: {xLabel} {formatX(points[points.length - 1][xKey])} · {yLabel} {formatY(points[points.length - 1][yKey])}
      </div>
    </div>
  );
};

interface ProfessionalLineChartProps {
  data: number[];
  xLabels?: string[];
  color?: string;
  secondaryData?: number[];
  secondaryColor?: string;
  secondaryLabel?: string;
  tertiaryData?: number[];
  tertiaryColor?: string;
  tertiaryLabel?: string;
  showArea?: boolean;
  isPercentage?: boolean;
  isCurrency?: boolean;
  dataLabel?: string;
  isQuarterly?: boolean;
  dataInThousands?: boolean; // If true, data is already divided by 1000
  variant?: ChartVariant;
  showPoints?: boolean;
}

const ProfessionalLineChart: React.FC<ProfessionalLineChartProps> = ({
  data,
  xLabels,
  color = '#0ea5e9',
  secondaryData,
  secondaryColor = '#10b981',
  secondaryLabel = 'Secondary',
  tertiaryData,
  tertiaryColor = '#ef4444',
  tertiaryLabel = 'Tertiary',
  showArea = false,
  isPercentage = false,
  isCurrency = true,
  dataLabel = 'Value',
  isQuarterly = false,
  dataInThousands = false,
  variant = 'compact',
  showPoints = true,
}) => {
  const chartId = React.useId().replace(/:/g, '');
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const areaGradientId = `${chartId}-area`;
  const shadowId = `${chartId}-line-shadow`;
  
  const allData = [...data, ...(secondaryData || []), ...(tertiaryData || [])];
  const max = Math.max(...allData, 0);
  const min = Math.min(...allData, 0);

  // Choose a nice step so there are exactly 6 ticks and 0 is one of them
  const niceStep = (target: number) => {
    if (target <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(target)));
    const steps = [1, 2, 2.5, 5, 7.5, 10];
    for (const s of steps) {
      const n = s * mag;
      if (n >= target) return n;
    }
    return target;
  };
  const posExtent = Math.max(0, max);
  const negExtent = Math.max(0, -min);
  let stepGuess = niceStep(Math.max((posExtent + negExtent) / 5, 1e-6));
  let j = 0; // # ticks below zero (0..5)
  for (let iter = 0; iter < 12; iter++) {
    j = Math.min(5, Math.ceil(negExtent / stepGuess));
    const needAbove = Math.ceil(posExtent / stepGuess);
    if ((5 - j) < needAbove) {
      stepGuess = niceStep(stepGuess * 1.1);
      continue;
    }
    break;
  }
  const niceMin = -j * stepGuess;
  const niceMax = (5 - j) * stepGuess;
  
  const W = variant === 'compact' ? 560 : 1080;
  const H = variant === 'compact' ? 290 : 560;
  const LP = variant === 'compact' ? 32 : 72;
  const RP = variant === 'compact' ? 8 : 28;
  const TP = variant === 'compact' ? 8 : 24;
  const BP = variant === 'compact' ? 28 : 84;
  const innerW = W - LP - RP;
  const innerH = H - TP - BP;
  
  const ticks = 6;
  const yTicks: number[] = [];
  for (let i = 0; i < ticks; i++) {
    yTicks.push(niceMin + (niceMax - niceMin) * (i / (ticks - 1)));
  }
  
  const createPath = (arr: number[]) => {
    const pts = arr.map((v, i) => {
      const x = LP + (i / (arr.length - 1)) * innerW;
      const y = TP + innerH - ((v - niceMin) / (niceMax - niceMin)) * innerH;
      return `${x},${y}`;
    });
    return `M${pts.join(' L')}`;
  };
  
  const labels = xLabels || generateYearLabels(data.length, isQuarterly);
  const xTickIndices = getVisibleAxisIndices(labels.length, variant === 'compact' ? 6 : 10);
  const rotateLabels = xTickIndices.length > 5 || xTickIndices.some((index) => labels[index]?.length > 5);
  
  const formatValue = (v: number) => {
    if (isPercentage) return formatPercentage(v);
    if (isCurrency) {
      // If data is in thousands, multiply back to get actual value
      const actualValue = dataInThousands ? v * 1000 : v;
      return formatCurrency(actualValue);
    }
    return v.toFixed(2);
  };
  
  const formatAxisValue = (v: number) => {
    if (isPercentage) return `${v.toFixed(0)}%`;
    if (isCurrency) {
      // If data is in thousands, multiply back to get actual value
      const actualValue = dataInThousands ? v * 1000 : v;
      return formatCompactCurrency(actualValue);
    }
    return v.toFixed(0);
  };
  
  return (
    <div className="h-full w-full relative">
      <svg 
        viewBox={`0 0 ${W} ${H}`} 
        className="w-full h-full"
      >
        <defs>
          <linearGradient id={areaGradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.24" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
          <filter id={shadowId} x="-20%" y="-20%" width="140%" height="160%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#0f172a" floodOpacity="0.1" />
          </filter>
        </defs>
        {/* Horizontal grid lines */}
        {yTicks.map(tick => {
          const y = TP + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <line
              key={tick}
              x1={LP}
              x2={LP + innerW}
              y1={y}
              y2={y}
              stroke="#e2e8f0"
              strokeWidth={1}
              strokeDasharray="4 6"
            />
          );
        })}
        <line x1={LP} x2={LP + innerW} y1={TP + innerH} y2={TP + innerH} stroke="#cbd5e1" strokeWidth={1.25} />
        
        {/* Area fill */}
        {showArea && (
          <path
            d={`${createPath(data)} L${LP + innerW},${TP + innerH} L${LP},${TP + innerH} Z`}
            fill={`url(#${areaGradientId})`}
          />
        )}
        
        {/* Lines */}
        <path d={createPath(data)} stroke={color} strokeWidth={3} fill="none" strokeLinejoin="round" strokeLinecap="round" filter={`url(#${shadowId})`} />
        {secondaryData && (
          <path d={createPath(secondaryData)} stroke={secondaryColor} strokeWidth={3} fill="none" strokeLinejoin="round" strokeLinecap="round" filter={`url(#${shadowId})`} />
        )}
        {tertiaryData && (
          <path d={createPath(tertiaryData)} stroke={tertiaryColor} strokeWidth={3} fill="none" strokeLinejoin="round" strokeLinecap="round" filter={`url(#${shadowId})`} />
        )}
        
        {/* Data points with hover */}
        {data.map((v, i) => {
          const x = LP + (i / (data.length - 1)) * innerW;
          const y = TP + innerH - ((v - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <circle 
              key={i} 
              cx={x} 
              cy={y} 
              r={showPoints ? (hoveredIndex === i ? 6 : 4) : 7}
              fill={showPoints ? color : 'transparent'}
              stroke={showPoints ? 'white' : 'transparent'}
              strokeWidth={showPoints ? (hoveredIndex === i ? 2.5 : 2) : 0}
              filter={showPoints ? `url(#${shadowId})` : undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          );
        })}
        {secondaryData && secondaryData.map((v, i) => {
          const x = LP + (i / (secondaryData.length - 1)) * innerW;
          const y = TP + innerH - ((v - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <circle 
              key={`s-${i}`} 
              cx={x} 
              cy={y} 
              r={showPoints ? (hoveredIndex === i ? 6 : 4) : 7}
              fill={showPoints ? secondaryColor : 'transparent'}
              stroke={showPoints ? 'white' : 'transparent'}
              strokeWidth={showPoints ? (hoveredIndex === i ? 2.5 : 2) : 0}
              filter={showPoints ? `url(#${shadowId})` : undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          );
        })}
        {tertiaryData && tertiaryData.map((v, i) => {
          const x = LP + (i / (tertiaryData.length - 1)) * innerW;
          const y = TP + innerH - ((v - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <circle 
              key={`t-${i}`} 
              cx={x} 
              cy={y} 
              r={showPoints ? (hoveredIndex === i ? 6 : 4) : 7}
              fill={showPoints ? tertiaryColor : 'transparent'}
              stroke={showPoints ? 'white' : 'transparent'}
              strokeWidth={showPoints ? (hoveredIndex === i ? 2.5 : 2) : 0}
              filter={showPoints ? `url(#${shadowId})` : undefined}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          );
        })}
        
        {/* Y-axis labels */}
        {yTicks.map(tick => {
          const y = TP + innerH - ((tick - niceMin) / (niceMax - niceMin)) * innerH;
          return (
            <text
              key={`y-${tick}`}
              x={LP - 10}
              y={y + 4}
              textAnchor="end"
              fontSize={variant === 'compact' ? 10 : 12}
              fill="#111827"
              fontWeight="600"
            >
              {formatAxisValue(tick)}
            </text>
          );
        })}
        
        {/* X-axis labels */}
        {xTickIndices.map((i) => {
          const label = labels[i];
          const x = LP + (i / (labels.length - 1)) * innerW;
          return (
            <text
              key={`x-${i}`}
              x={x}
              y={H - 14}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              fontSize={variant === 'compact' ? 10 : 12}
              fill="#111827"
              fontWeight="600"
              transform={rotateLabels ? `rotate(-34 ${x} ${H - 14})` : undefined}
            >
              {label}
            </text>
          );
        })}
      </svg>
      
      {/* Tooltip */}
      {hoveredIndex !== null && (
        <div 
          className="absolute z-50 rounded-xl border border-slate-700/40 bg-slate-900/95 px-4 py-3 text-sm text-white shadow-xl backdrop-blur-sm pointer-events-none"
          style={{
            left: '50%',
            top: '8px',
            transform: 'translateX(-50%)',
          }}
        >
          <div className="font-semibold mb-1.5 text-slate-100">{labels[hoveredIndex]}</div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }}></div>
            <span className="text-slate-300">{dataLabel}:</span>
            <span className="font-medium">{formatValue(data[hoveredIndex])}</span>
          </div>
          {secondaryData && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: secondaryColor }}></div>
              <span className="text-slate-300">{secondaryLabel}:</span>
              <span className="font-medium">{formatValue(secondaryData[hoveredIndex])}</span>
            </div>
          )}
          {tertiaryData && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: tertiaryColor }}></div>
              <span className="text-slate-300">{tertiaryLabel}:</span>
              <span className="font-medium">{formatValue(tertiaryData[hoveredIndex])}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MarketInsightsPage;
