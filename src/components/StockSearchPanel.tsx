import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchTickers, type TickerSearchResult } from '../services/polygonService';
import {
  getCompanyDetails,
  getStockQuote,
  getFinancials,
  type StockFinancials,
} from '../services/portfolioService';

// ============================================================================
// Types
// ============================================================================

interface StockCardData {
  ticker: string;
  name: string;
  logoUrl: string;
  price: number;
  changePercent: number;
  marketCap: number;
}

interface DcfStockStats {
  ticker: string;
  name: string;
  logoUrl: string;
  currentPrice: number;
  ttmEPS: number;
  ttmFCFPerShare: number;
  peTTM: number;
  fcfYieldTTM: number; // percent
  epsGrowthHist: number | null; // percent CAGR from annual financials
  fcfGrowthHist: number | null; // percent CAGR from annual financials
}

export interface StockSearchPanelProps {
  onOpenStock: (stock: { ticker: string; name: string }) => void;
  sectionCardClassName?: string;
}

// ============================================================================
// Curated quick-access categories (Polygon has no trending/screener API on
// this plan, so these are hand-picked lists per theme)
// ============================================================================

const QUICK_ACCESS_CATEGORIES: Array<{ id: string; label: string; tickers: string[] }> = [
  { id: 'sp500', label: 'S&P 500', tickers: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AVGO', 'TSLA', 'BRK.B', 'LLY', 'JPM', 'V'] },
  { id: 'trending', label: 'Most Trending', tickers: ['NVDA', 'TSLA', 'PLTR', 'AMD', 'COIN', 'MU', 'NFLX', 'HOOD', 'SHOP', 'ARM', 'UBER', 'SMCI'] },
  { id: 'growth', label: 'Growth', tickers: ['NVDA', 'AMZN', 'META', 'NOW', 'SHOP', 'CRWD', 'DDOG', 'PANW', 'INTU', 'ISRG', 'AXON', 'MELI'] },
  { id: 'dividend-growth', label: 'Dividend Growth', tickers: ['ASML', 'COST', 'SPGI', 'UNH', 'MSFT', 'AVGO', 'LOW', 'HD', 'V', 'MA', 'ABBV', 'TXN'] },
  { id: 'buybacks', label: 'Buyback Machines', tickers: ['AAPL', 'GOOGL', 'META', 'MA', 'V', 'MCO', 'AZO', 'ORLY', 'LMT', 'BKNG', 'MAR', 'ADBE'] },
  { id: 'ai', label: 'Artificial Intelligence', tickers: ['NVDA', 'MSFT', 'GOOGL', 'META', 'AMD', 'AVGO', 'PLTR', 'SNOW', 'MRVL', 'TSM', 'ANET', 'VRT'] },
  { id: 'cloud', label: 'Cloud', tickers: ['MSFT', 'AMZN', 'GOOGL', 'SNOW', 'DDOG', 'NET', 'MDB', 'CRWD', 'ZS', 'ORCL', 'NOW', 'TEAM'] },
];

// ============================================================================
// Helpers
// ============================================================================

const formatCompactMarketCap = (value: number): string => {
  if (!value || !Number.isFinite(value)) return '—';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}t`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}b`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}m`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};

const sumLastFourQuarters = (financials: StockFinancials[], selector: (f: StockFinancials) => number): number => {
  const quarters = financials.filter((f) => f.fiscalPeriod !== 'FY').slice(0, 4);
  if (quarters.length === 0) return 0;
  const total = quarters.reduce((sum, f) => sum + (selector(f) || 0), 0);
  // Annualize when fewer than 4 quarters are available
  return quarters.length < 4 ? (total / quarters.length) * 4 : total;
};

const computeCagrPercent = (oldest: number, latest: number, years: number): number | null => {
  if (!Number.isFinite(oldest) || !Number.isFinite(latest) || oldest <= 0 || latest <= 0 || years <= 0) return null;
  return (Math.pow(latest / oldest, 1 / years) - 1) * 100;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

async function fetchDcfStockStats(ticker: string, fallbackName?: string): Promise<DcfStockStats | null> {
  const [quote, company, quarterly, annual] = await Promise.all([
    getStockQuote(ticker),
    getCompanyDetails(ticker),
    getFinancials(ticker, 'quarterly', 8),
    getFinancials(ticker, 'annual', 6),
  ]);
  if (!quote || quote.currentPrice <= 0) return null;

  const ttmEPS = sumLastFourQuarters(quarterly, (f) => f.earningsPerShareDiluted || f.earningsPerShare);
  const sharesOutstanding = company?.marketCap && quote.currentPrice > 0
    ? company.marketCap / quote.currentPrice
    : 0;
  const ttmFCF = sumLastFourQuarters(quarterly, (f) => f.freeCashFlow);
  const ttmFCFPerShare = sharesOutstanding > 0 ? ttmFCF / sharesOutstanding : 0;

  // Historical growth from annual filings (oldest -> latest CAGR)
  const annualSorted = [...annual].sort((a, b) => Number(a.fiscalYear) - Number(b.fiscalYear));
  let epsGrowthHist: number | null = null;
  let fcfGrowthHist: number | null = null;
  if (annualSorted.length >= 2) {
    const years = annualSorted.length - 1;
    const oldest = annualSorted[0];
    const latest = annualSorted[annualSorted.length - 1];
    epsGrowthHist = computeCagrPercent(
      oldest.earningsPerShareDiluted || oldest.earningsPerShare,
      latest.earningsPerShareDiluted || latest.earningsPerShare,
      years,
    );
    fcfGrowthHist = computeCagrPercent(oldest.freeCashFlow, latest.freeCashFlow, years);
  }

  const peTTM = ttmEPS > 0 ? quote.currentPrice / ttmEPS : 0;
  const fcfYieldTTM = ttmFCFPerShare > 0 ? (ttmFCFPerShare / quote.currentPrice) * 100 : 0;

  return {
    ticker,
    name: company?.name || fallbackName || ticker,
    logoUrl: company?.logoUrl || '',
    currentPrice: quote.currentPrice,
    ttmEPS,
    ttmFCFPerShare,
    peTTM,
    fcfYieldTTM,
    epsGrowthHist,
    fcfGrowthHist,
  };
}

// ============================================================================
// DCF projection math (Qualtrim-style)
// ============================================================================

interface DcfResult {
  points: Array<{ year: number; label: string; price: number; perShare: number }>;
  finalPrice: number;
  annualizedReturnFromToday: number | null; // percent
  entryPriceForDesiredReturn: number | null;
}

const PROJECTION_YEARS = 5;

function computeDcfProjection(
  perShareTTM: number,
  growthRatePercent: number,
  priceFromPerShare: (perShare: number) => number,
  currentPrice: number,
  desiredReturnPercent: number,
): DcfResult | null {
  if (!Number.isFinite(perShareTTM) || perShareTTM <= 0) return null;
  const growth = growthRatePercent / 100;
  const baseYear = new Date().getFullYear();
  const points: DcfResult['points'] = [];
  for (let year = 0; year <= PROJECTION_YEARS; year++) {
    const perShare = perShareTTM * Math.pow(1 + growth, year);
    points.push({
      year,
      label: `Q1 ${baseYear + year}`,
      perShare,
      price: priceFromPerShare(perShare),
    });
  }
  const finalPrice = points[points.length - 1].price;
  const annualizedReturnFromToday = currentPrice > 0 && finalPrice > 0
    ? (Math.pow(finalPrice / currentPrice, 1 / PROJECTION_YEARS) - 1) * 100
    : null;
  const desired = desiredReturnPercent / 100;
  const entryPriceForDesiredReturn = desired > -1 && finalPrice > 0
    ? finalPrice / Math.pow(1 + desired, PROJECTION_YEARS)
    : null;
  return { points, finalPrice, annualizedReturnFromToday, entryPriceForDesiredReturn };
}

// ============================================================================
// Reusable ticker search box with dropdown results
// ============================================================================

const TickerSearchBox: React.FC<{
  placeholder?: string;
  onSelect: (ticker: string, name: string) => void;
  autoFocus?: boolean;
  voiceId?: string;
}> = ({ placeholder = 'Search stocks...', onSelect, autoFocus = false, voiceId }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TickerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 1) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++seqRef.current;
    const timeout = setTimeout(async () => {
      try {
        const found = await searchTickers(trimmed);
        if (seq === seqRef.current) {
          setResults(found.filter((r) => r.market === 'stocks'));
          setOpen(true);
        }
      } catch {
        if (seq === seqRef.current) setResults([]);
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timeout);
  }, [query]);

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_2px_10px_rgba(15,23,42,0.05)] transition focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-slate-400">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          data-voice-id={voiceId}
          className="w-full bg-transparent text-[15px] text-slate-900 outline-none placeholder:text-slate-400"
        />
        {searching && (
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-blue-500" />
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-80 overflow-auto rounded-2xl border border-slate-200 bg-white py-1 shadow-[0_16px_44px_rgba(15,23,42,0.16)]">
          {results.map((result) => (
            <button
              key={result.ticker}
              type="button"
              onClick={() => {
                setOpen(false);
                setQuery('');
                onSelect(result.ticker, result.name);
              }}
              className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50"
            >
              <div className="min-w-0">
                <span className="text-[15px] font-semibold text-slate-900">{result.ticker}</span>
                <span className="ml-2 truncate text-sm text-slate-500">{result.name}</span>
              </div>
              <span className="shrink-0 text-xs uppercase tracking-wide text-slate-400">{result.primary_exchange}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Projection chart (SVG)
// ============================================================================

const DcfProjectionChart: React.FC<{ points: DcfResult['points'] }> = ({ points }) => {
  const [hovered, setHovered] = useState<number | null>(null);
  const width = 560;
  const height = 320;
  const margin = { top: 20, right: 24, bottom: 36, left: 56 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const maxPrice = Math.max(...points.map((p) => p.price));
  const niceMax = Math.ceil((maxPrice * 1.1) / 100) * 100 || 100;

  const x = (i: number) => margin.left + (i / (points.length - 1)) * plotW;
  const y = (price: number) => margin.top + plotH - (price / niceMax) * plotH;

  const gridSteps = 5;
  const gridLines = Array.from({ length: gridSteps + 1 }, (_, i) => (niceMax / gridSteps) * i);
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="DCF projected stock price">
      {gridLines.map((value) => (
        <g key={value}>
          <line x1={margin.left} x2={width - margin.right} y1={y(value)} y2={y(value)} stroke="#e2e8f0" strokeWidth="1" />
          <text x={margin.left - 8} y={y(value) + 4} textAnchor="end" fontSize="11" fill="#94a3b8">
            ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </text>
        </g>
      ))}
      <path d={linePath} fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={p.year}>
          <circle
            cx={x(i)}
            cy={y(p.price)}
            r={hovered === i ? 6 : 4.5}
            fill="#16a34a"
            stroke="#fff"
            strokeWidth="1.5"
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
          <text x={x(i)} y={height - margin.bottom + 18} textAnchor="middle" fontSize="11" fill="#94a3b8">
            {p.label}
          </text>
          {hovered === i && (
            <g>
              <rect
                x={clamp(x(i) - 52, margin.left, width - margin.right - 104)}
                y={y(p.price) - 38}
                width="104"
                height="26"
                rx="6"
                fill="#0f172a"
              />
              <text
                x={clamp(x(i) - 52, margin.left, width - margin.right - 104) + 52}
                y={y(p.price) - 20}
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                fill="#fff"
              >
                ${p.price.toFixed(2)}
              </text>
            </g>
          )}
        </g>
      ))}
    </svg>
  );
};

// ============================================================================
// Quick-access stock card
// ============================================================================

const StockQuickCard: React.FC<{ stock: StockCardData; onClick: () => void }> = ({ stock, onClick }) => {
  const positive = stock.changePercent >= 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between gap-3 rounded-[18px] border border-slate-200 bg-white p-4 text-left shadow-[0_2px_10px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]"
    >
      <div className="flex min-w-0 items-center gap-3">
        {stock.logoUrl ? (
          <img
            src={stock.logoUrl}
            alt={stock.ticker}
            className="h-10 w-10 shrink-0 rounded-lg border border-slate-100 bg-slate-50 object-contain p-1"
            loading="lazy"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-bold text-slate-500">
            {stock.ticker[0]}
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-tight text-slate-900">{stock.ticker}</div>
          <div className="truncate text-xs text-slate-500">{stock.name}</div>
          <div className="truncate text-[11px] text-slate-400">Market Cap: {formatCompactMarketCap(stock.marketCap)}</div>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[15px] font-semibold tracking-tight text-slate-900">
          ${stock.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div className={`mt-1 inline-block rounded-md px-1.5 py-0.5 text-xs font-medium ${positive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
          {positive ? '+' : ''}{stock.changePercent.toFixed(2)}%
        </div>
      </div>
    </button>
  );
};

// ============================================================================
// DCF Calculator modal
// ============================================================================

const DcfCalculatorModal: React.FC<{
  open: boolean;
  onClose: () => void;
  prefillTicker: { ticker: string; name: string } | null;
}> = ({ open, onClose, prefillTicker }) => {
  const [dcfStats, setDcfStats] = useState<DcfStockStats | null>(null);
  const [dcfLoading, setDcfLoading] = useState(false);
  const [dcfMethod, setDcfMethod] = useState<'earnings' | 'cashflow'>('earnings');
  const [epsInput, setEpsInput] = useState(0);
  const [epsGrowthInput, setEpsGrowthInput] = useState(12);
  const [epsMultipleInput, setEpsMultipleInput] = useState(20);
  const [fcfInput, setFcfInput] = useState(0);
  const [fcfGrowthInput, setFcfGrowthInput] = useState(12);
  const [fcfYieldInput, setFcfYieldInput] = useState(4);
  const [fcfMultipleInput, setFcfMultipleInput] = useState(25);
  const [useFcfMultiple, setUseFcfMultiple] = useState(false);
  const [desiredReturnInput, setDesiredReturnInput] = useState(15);
  const loadSeqRef = useRef(0);

  const loadStock = useCallback(async (ticker: string, name?: string) => {
    const seq = ++loadSeqRef.current;
    setDcfLoading(true);
    try {
      const stats = await fetchDcfStockStats(ticker, name);
      if (seq !== loadSeqRef.current) return;
      setDcfStats(stats);
      if (stats) {
        setEpsInput(Number(Math.max(0, stats.ttmEPS).toFixed(2)));
        setFcfInput(Number(Math.max(0, stats.ttmFCFPerShare).toFixed(2)));
        setEpsGrowthInput(Number(clamp(stats.epsGrowthHist ?? 12, 0, 30).toFixed(1)));
        setFcfGrowthInput(Number(clamp(stats.fcfGrowthHist ?? 12, 0, 30).toFixed(1)));
        setEpsMultipleInput(Number(clamp(stats.peTTM > 0 ? stats.peTTM : 20, 5, 60).toFixed(0)));
        setFcfYieldInput(Number(clamp(stats.fcfYieldTTM > 0 ? stats.fcfYieldTTM : 4, 1, 15).toFixed(1)));
        setFcfMultipleInput(Number(clamp(stats.ttmFCFPerShare > 0 ? stats.currentPrice / stats.ttmFCFPerShare : 25, 5, 80).toFixed(0)));
      }
    } catch (error) {
      console.error(`Error loading DCF data for ${ticker}:`, error);
      if (seq === loadSeqRef.current) setDcfStats(null);
    } finally {
      if (seq === loadSeqRef.current) setDcfLoading(false);
    }
  }, []);

  // When the modal opens with a stock recently selected on the page, prefill it
  useEffect(() => {
    if (open && prefillTicker && prefillTicker.ticker !== dcfStats?.ticker && !dcfLoading) {
      void loadStock(prefillTicker.ticker, prefillTicker.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillTicker?.ticker]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const dcfResult = useMemo<DcfResult | null>(() => {
    if (!dcfStats) return null;
    if (dcfMethod === 'earnings') {
      return computeDcfProjection(
        epsInput,
        epsGrowthInput,
        (eps) => eps * epsMultipleInput,
        dcfStats.currentPrice,
        desiredReturnInput,
      );
    }
    const priceFromFcf = useFcfMultiple
      ? (fcf: number) => fcf * fcfMultipleInput
      : (fcf: number) => (fcfYieldInput > 0 ? (fcf / fcfYieldInput) * 100 : 0);
    return computeDcfProjection(fcfInput, fcfGrowthInput, priceFromFcf, dcfStats.currentPrice, desiredReturnInput);
  }, [dcfStats, dcfMethod, epsInput, epsGrowthInput, epsMultipleInput, fcfInput, fcfGrowthInput, fcfYieldInput, fcfMultipleInput, useFcfMultiple, desiredReturnInput]);

  const numberInputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[15px] font-medium text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100';
  const inputLabelClass = 'mb-1 block text-sm font-medium text-slate-700';
  const inputHelpClass = 'mt-1 text-xs leading-5 text-slate-400';

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm"
      data-voice-id="dcf-calculator-modal-overlay"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-[min(1100px,calc(100vw-2rem))] overflow-auto rounded-[28px] border border-slate-200 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.22)]"
        data-voice-id="dcf-calculator-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-6 py-5 backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3.5">
              {dcfStats && (
                dcfStats.logoUrl ? (
                  <img
                    src={dcfStats.logoUrl}
                    alt={dcfStats.ticker}
                    className="h-11 w-11 rounded-xl border border-slate-200 bg-slate-50 object-contain p-1"
                    data-voice-id="dcf-stock-logo"
                  />
                ) : (
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-200 text-base font-bold text-slate-500">
                    {dcfStats.ticker[0]}
                  </div>
                )
              )}
              <div>
                <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-slate-900">DCF Calculator</h2>
                <p className="text-sm text-slate-500">
                  {dcfStats
                    ? `${dcfStats.ticker} · ${dcfStats.name} · $${dcfStats.currentPrice.toFixed(2)}`
                    : 'Search for a stock to load its earnings and cash flow.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex rounded-xl bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setDcfMethod('earnings')}
                  className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${dcfMethod === 'earnings' ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  Earnings
                </button>
                <button
                  type="button"
                  onClick={() => setDcfMethod('cashflow')}
                  className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${dcfMethod === 'cashflow' ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  Cash Flow
                </button>
              </div>
              <button
                type="button"
                onClick={onClose}
                data-voice-id="close-dcf-calculator-btn"
                className="rounded-xl bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="mt-4 max-w-xl">
            <TickerSearchBox
              placeholder="Search a stock to value..."
              onSelect={(ticker, name) => { void loadStock(ticker, name); }}
              voiceId="dcf-calculator-search-input"
            />
          </div>
        </div>

        {/* Body */}
        <div className="p-6">
          {dcfLoading ? (
            <div className="flex items-center justify-center gap-3 py-20 text-slate-500">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-blue-500" />
              Loading financials...
            </div>
          ) : !dcfStats ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 py-20 text-center text-sm text-slate-500">
              Search for a stock above to auto-fill EPS, free cash flow, growth, and multiples from its latest filings.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* --- Assumptions --- */}
              <div className="rounded-2xl border border-slate-200 p-5">
                <h3 className="text-[17px] font-semibold text-slate-900">Assumptions</h3>

                {/* Current stats strip */}
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="mb-2 text-center text-sm font-medium text-slate-600">
                    {dcfMethod === 'earnings' ? 'Current Earnings' : 'Current Cash Flow'}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {dcfMethod === 'earnings' ? (
                      <>
                        <div>
                          <div className="text-xs text-slate-400">EPS (TTM)</div>
                          <div className="text-[15px] font-semibold text-slate-900">${dcfStats.ttmEPS.toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">PE (TTM)</div>
                          <div className="text-[15px] font-semibold text-slate-900">{dcfStats.peTTM > 0 ? dcfStats.peTTM.toFixed(2) : '—'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">EPS Growth</div>
                          <div className="text-[15px] font-semibold text-slate-900">{dcfStats.epsGrowthHist !== null ? `${dcfStats.epsGrowthHist.toFixed(1)}%` : '—'}</div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <div className="text-xs text-slate-400">FCF/Share (TTM)</div>
                          <div className="text-[15px] font-semibold text-slate-900">${dcfStats.ttmFCFPerShare.toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">FCF Yield (TTM)</div>
                          <div className="text-[15px] font-semibold text-slate-900">{dcfStats.fcfYieldTTM > 0 ? `${dcfStats.fcfYieldTTM.toFixed(2)}%` : '—'}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">FCF Growth</div>
                          <div className="text-[15px] font-semibold text-slate-900">{dcfStats.fcfGrowthHist !== null ? `${dcfStats.fcfGrowthHist.toFixed(1)}%` : '—'}</div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-5 space-y-5">
                  {dcfMethod === 'earnings' ? (
                    <>
                      <div>
                        <label className={inputLabelClass}>EPS (TTM)</label>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-400">$</span>
                          <input type="number" step="0.01" value={epsInput} onChange={(e) => setEpsInput(Number(e.target.value))} className={numberInputClass} />
                        </div>
                        <p className={inputHelpClass}>The Earnings Per Share over the last 12 months.</p>
                      </div>
                      <div>
                        <label className={inputLabelClass}>EPS Growth Rate</label>
                        <div className="flex items-center gap-2">
                          <input type="number" step="0.5" value={epsGrowthInput} onChange={(e) => setEpsGrowthInput(Number(e.target.value))} className={numberInputClass} />
                          <span className="text-sm font-medium text-slate-400">%</span>
                        </div>
                        <p className={inputHelpClass}>Your assumption of the company's expected yearly EPS growth rate as a percentage (e.g., 10 for 10% per year).</p>
                      </div>
                      <div>
                        <label className={inputLabelClass}>Appropriate EPS Multiple</label>
                        <input type="number" step="1" value={epsMultipleInput} onChange={(e) => setEpsMultipleInput(Number(e.target.value))} className={numberInputClass} />
                        <p className={inputHelpClass}>The PE ratio you consider appropriate for the stock to trade at.</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className={inputLabelClass}>FCF/Share (TTM)</label>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-400">$</span>
                          <input type="number" step="0.01" value={fcfInput} onChange={(e) => setFcfInput(Number(e.target.value))} className={numberInputClass} />
                        </div>
                        <p className={inputHelpClass}>Trailing Free Cash Flow - the company's cash flow after capital expenditures over the last 12 months.</p>
                      </div>
                      <div>
                        <label className={inputLabelClass}>FCF/Share Growth Rate</label>
                        <div className="flex items-center gap-2">
                          <input type="number" step="0.5" value={fcfGrowthInput} onChange={(e) => setFcfGrowthInput(Number(e.target.value))} className={numberInputClass} />
                          <span className="text-sm font-medium text-slate-400">%</span>
                        </div>
                        <p className={inputHelpClass}>Expected annual growth rate of free cash flow, expressed as a percentage.</p>
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <label className={inputLabelClass}>{useFcfMultiple ? 'FCF Multiple' : 'FCF Yield (TTM)'}</label>
                          <button
                            type="button"
                            onClick={() => setUseFcfMultiple((v) => !v)}
                            className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-700"
                          >
                            <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${useFcfMultiple ? 'bg-blue-500' : 'bg-slate-300'}`}>
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition ${useFcfMultiple ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                            </span>
                            Use FCF Multiple
                          </button>
                        </div>
                        {useFcfMultiple ? (
                          <input type="number" step="1" value={fcfMultipleInput} onChange={(e) => setFcfMultipleInput(Number(e.target.value))} className={numberInputClass} />
                        ) : (
                          <div className="flex items-center gap-2">
                            <input type="number" step="0.1" value={fcfYieldInput} onChange={(e) => setFcfYieldInput(Number(e.target.value))} className={numberInputClass} />
                            <span className="text-sm font-medium text-slate-400">%</span>
                          </div>
                        )}
                        <p className={inputHelpClass}>
                          {useFcfMultiple
                            ? 'The price-to-FCF multiple you consider appropriate for the stock to trade at.'
                            : 'The Free Cash Flow Yield you consider appropriate for the stock to trade at.'}
                        </p>
                      </div>
                    </>
                  )}
                  <div>
                    <label className={inputLabelClass}>Desired Return</label>
                    <div className="flex items-center gap-2">
                      <input type="number" step="0.5" value={desiredReturnInput} onChange={(e) => setDesiredReturnInput(Number(e.target.value))} className={numberInputClass} />
                      <span className="text-sm font-medium text-slate-400">%</span>
                    </div>
                    <p className={inputHelpClass}>The annualized return you aim to achieve from the stock. The calculator will determine the price you need to pay to attain this return based on your assumptions.</p>
                  </div>
                </div>
              </div>

              {/* --- 5-Year Projection --- */}
              <div className="rounded-2xl border border-slate-200 p-5">
                <h3 className="text-[17px] font-semibold text-slate-900">5-Year Projection</h3>
                {dcfResult ? (
                  <>
                    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                      <div className="mb-2 text-center text-sm font-medium text-slate-600">Calculation Results</div>
                      <div className="grid grid-cols-2 gap-3 text-center">
                        <div>
                          <div className="text-xs text-slate-400">Return from today's price</div>
                          <div className={`text-lg font-semibold ${(dcfResult.annualizedReturnFromToday ?? 0) >= desiredReturnInput ? 'text-green-600' : 'text-slate-900'}`}>
                            {dcfResult.annualizedReturnFromToday !== null ? `${dcfResult.annualizedReturnFromToday.toFixed(2)}%` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">Entry Price for {desiredReturnInput}% Return</div>
                          <div className="text-lg font-semibold text-slate-900">
                            {dcfResult.entryPriceForDesiredReturn !== null ? `$${dcfResult.entryPriceForDesiredReturn.toFixed(2)}` : '—'}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4">
                      <DcfProjectionChart points={dcfResult.points} />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-center text-sm">
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <span className="text-slate-400">{dcfMethod === 'earnings' ? 'Year 5 EPS: ' : 'Year 5 FCF/Share: '}</span>
                        <span className="font-semibold text-slate-900">${dcfResult.points[dcfResult.points.length - 1].perShare.toFixed(2)}</span>
                      </div>
                      <div className="rounded-lg bg-slate-50 px-3 py-2">
                        <span className="text-slate-400">Year 5 Price: </span>
                        <span className="font-semibold text-slate-900">${dcfResult.finalPrice.toFixed(2)}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 py-12 text-center text-sm text-slate-500">
                    {dcfMethod === 'earnings'
                      ? 'EPS must be positive to project earnings-based value. Try the Cash Flow method or enter a manual EPS.'
                      : 'FCF/Share must be positive to project cash-flow-based value. Try the Earnings method or enter a manual FCF/Share.'}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main panel
// ============================================================================

const defaultSectionCardClass = 'rounded-[24px] border border-slate-200 bg-white shadow-[0_4px_14px_rgba(15,23,42,0.04)]';

export const StockSearchPanel: React.FC<StockSearchPanelProps> = ({ onOpenStock, sectionCardClassName }) => {
  const cardClass = sectionCardClassName || defaultSectionCardClass;

  // --- Quick-access cards state ---
  const [activeCategory, setActiveCategory] = useState(QUICK_ACCESS_CATEGORIES[0].id);
  const [cardCache, setCardCache] = useState<Record<string, StockCardData>>({});
  const [loadingCategory, setLoadingCategory] = useState(false);

  // --- DCF modal state ---
  const [dcfOpen, setDcfOpen] = useState(false);
  const [lastSelectedStock, setLastSelectedStock] = useState<{ ticker: string; name: string } | null>(null);

  // Load quick-access card data for the active category
  useEffect(() => {
    const category = QUICK_ACCESS_CATEGORIES.find((c) => c.id === activeCategory);
    if (!category) return;
    const missing = category.tickers.filter((t) => !cardCache[t]);
    if (missing.length === 0) return;

    let cancelled = false;
    setLoadingCategory(true);
    (async () => {
      const loaded: Record<string, StockCardData> = {};
      // Small batches to stay friendly to the cached API
      const batchSize = 4;
      for (let i = 0; i < missing.length; i += batchSize) {
        const batch = missing.slice(i, i + batchSize);
        await Promise.all(batch.map(async (ticker) => {
          try {
            const [company, quote] = await Promise.all([getCompanyDetails(ticker), getStockQuote(ticker)]);
            if (!quote) return;
            loaded[ticker] = {
              ticker,
              name: company?.name || ticker,
              logoUrl: company?.logoUrl || '',
              price: quote.currentPrice,
              changePercent: quote.changePercent,
              marketCap: company?.marketCap || 0,
            };
          } catch {
            // Skip tickers that fail to load
          }
        }));
        if (cancelled) return;
        setCardCache((prev) => ({ ...prev, ...loaded }));
      }
      if (!cancelled) setLoadingCategory(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory]);

  const handleSelectStock = useCallback((ticker: string, name: string) => {
    setLastSelectedStock({ ticker, name });
    onOpenStock({ ticker, name });
  }, [onOpenStock]);

  const activeCategoryDef = QUICK_ACCESS_CATEGORIES.find((c) => c.id === activeCategory) || QUICK_ACCESS_CATEGORIES[0];
  const visibleCards = activeCategoryDef.tickers
    .map((t) => cardCache[t])
    .filter((c): c is StockCardData => Boolean(c));

  return (
    <div className="space-y-6" data-voice-id="stock-search-panel">
      {/* ===== Hero search ===== */}
      <div className={`${cardClass} relative px-6 py-12 sm:py-16`} data-voice-id="stock-search-hero">
        <button
          type="button"
          onClick={() => setDcfOpen(true)}
          data-voice-id="open-dcf-calculator-btn"
          className="absolute right-5 top-5 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-[0_2px_10px_rgba(15,23,42,0.05)] transition hover:border-slate-300 hover:text-slate-900 hover:shadow-[0_6px_18px_rgba(15,23,42,0.08)]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="2" width="16" height="20" rx="2" />
            <path d="M8 6h8M8 10h2M14 10h2M8 14h2M14 14h2M8 18h2M14 18h2" />
          </svg>
          DCF Calculator
        </button>
        <h1 className="text-center text-[34px] font-semibold tracking-[-0.03em] text-slate-900">Stock Search</h1>
        <p className="mx-auto mt-2 max-w-md text-center text-sm text-slate-500">
          Look up any stock for live quotes, financial history, and a DCF valuation.
        </p>
        <div className="mx-auto mt-6 max-w-xl">
          <TickerSearchBox
            placeholder="Search stocks..."
            onSelect={handleSelectStock}
            voiceId="stock-search-input"
          />
        </div>
      </div>

      {/* ===== Quick-access category cards ===== */}
      <div className={`${cardClass} p-6`} data-voice-id="stock-quick-access-card">
        <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 pb-px">
          {QUICK_ACCESS_CATEGORIES.map((category) => {
            const isActive = category.id === activeCategory;
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => setActiveCategory(category.id)}
                className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition ${isActive ? 'border-slate-900 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-900'}`}
              >
                {category.label}
              </button>
            );
          })}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleCards.map((stock) => (
            <StockQuickCard
              key={stock.ticker}
              stock={stock}
              onClick={() => handleSelectStock(stock.ticker, stock.name)}
            />
          ))}
          {loadingCategory && visibleCards.length < activeCategoryDef.tickers.length && (
            Array.from({ length: activeCategoryDef.tickers.length - visibleCards.length }).map((_, i) => (
              <div key={`skeleton-${i}`} className="h-[78px] animate-pulse rounded-[18px] border border-slate-100 bg-slate-50" />
            ))
          )}
        </div>
      </div>

      {/* ===== DCF Calculator modal ===== */}
      <DcfCalculatorModal
        open={dcfOpen}
        onClose={() => setDcfOpen(false)}
        prefillTicker={lastSelectedStock}
      />
    </div>
  );
};

export default StockSearchPanel;
