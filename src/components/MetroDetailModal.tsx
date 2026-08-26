import React, { useEffect, useState, useMemo } from 'react';
import ZipMarketDrilldown from './ZipMarketDrilldown';

/* ─────────────────────────────────────────────────────────────────────────────
 * MetroDetailModal – Displays historical economic trend charts for a metro
 * area (CBSA). Opened from the RegionalHeatMap when a user clicks a data
 * point on the map or a row in the metro rankings table.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Observation {
  date: string;
  value: number;
}

interface SeriesData {
  label: string;
  unit: string;
  observations: Observation[];
  latest: number;
  latestDate: string;
  earliest: number;
  earliestDate: string;
  yoyGrowth: number | null;
  count: number;
}

interface MetroHistoryData {
  cbsa: string;
  name: string;
  state: string;
  lat: number;
  lng: number;
  series: Record<string, SeriesData>;
  fetchedAt: string;
}

interface MetroDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  cbsaCode: string;
  metroName: string;
  initialZipCode?: string | null;
}

// ── Tiny inline SVG chart (sparkline / area chart) ──────────────────────────

const CHART_COLORS: Record<string, { stroke: string; fill: string }> = {
  housing:      { stroke: '#3b82f6', fill: '#dbeafe' },
  listings:     { stroke: '#8b5cf6', fill: '#ede9fe' },
  listingPrice: { stroke: '#059669', fill: '#d1fae5' },
  daysOnMarket: { stroke: '#f59e0b', fill: '#fef3c7' },
  newListings:  { stroke: '#6366f1', fill: '#e0e7ff' },
  priceReduced: { stroke: '#ef4444', fill: '#fee2e2' },
  unemployment: { stroke: '#ef4444', fill: '#fee2e2' },
  income:       { stroke: '#059669', fill: '#d1fae5' },
  permits:      { stroke: '#0ea5e9', fill: '#e0f2fe' },
  wages:        { stroke: '#f97316', fill: '#ffedd5' },
  gdp:          { stroke: '#8b5cf6', fill: '#ede9fe' },
  rentPrice:    { stroke: '#ec4899', fill: '#fce7f3' },
};

const METRIC_ICONS: Record<string, string> = {
  housing:      '🏠',
  listings:     '📋',
  listingPrice: '💲',
  daysOnMarket: '⏱️',
  newListings:  '🆕',
  priceReduced: '📉',
  unemployment: '📊',
  income:       '💰',
  permits:      '🏗️',
  wages:        '💵',
  gdp:          '📊',
  rentPrice:    '🏘️',
};

// Preferred display order
const METRIC_ORDER = [
  'housing', 'listingPrice', 'listings', 'daysOnMarket', 'unemployment',
  'wages', 'income', 'gdp', 'permits', 'newListings', 'priceReduced', 'rentPrice',
];

function formatVal(value: number, unit: string): string {
  switch (unit) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'usd':
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
      return `$${value.toFixed(0)}`;
    case 'millions':
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}T`;
      if (value >= 1000) return `$${(value / 1000).toFixed(1)}B`;
      return `$${value.toFixed(0)}M`;
    case 'days':
      return `${Math.round(value)} days`;
    case 'index':
      return value.toFixed(1);
    case 'count':
    default:
      return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
}

function MiniChart({ data, color, unit, height = 100 }: {
  data: Observation[];
  color: { stroke: string; fill: string };
  unit: string;
  height?: number;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const { path, areaPath, points, yLabels, xLabels } = useMemo(() => {
    if (data.length < 2) return { path: '', areaPath: '', points: [], yLabels: [], xLabels: [] };

    const W = 320;
    const H = height;
    const PAD_LEFT = 52;
    const PAD_RIGHT = 10;
    const PAD_TOP = 8;
    const PAD_BOTTOM = 22;
    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;

    const vals = data.map(d => d.value);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const range = maxV - minV || 1;

    const pts = data.map((d, i) => ({
      x: PAD_LEFT + (i / (data.length - 1)) * plotW,
      y: PAD_TOP + plotH - ((d.value - minV) / range) * plotH,
      date: d.date,
      value: d.value,
    }));

    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const area = `${linePath} L${pts[pts.length - 1].x},${PAD_TOP + plotH} L${pts[0].x},${PAD_TOP + plotH} Z`;

    // Y-axis labels (3 ticks)
    const yTicks = [minV, minV + range / 2, maxV];
    const yLbls = yTicks.map(v => ({
      y: PAD_TOP + plotH - ((v - minV) / range) * plotH,
      label: formatVal(v, unit),
    }));

    // X-axis labels (first, middle, last dates)
    const xIdxs = [0, Math.floor(data.length / 2), data.length - 1];
    const xLbls = xIdxs.map(i => ({
      x: pts[i].x,
      label: data[i].date.slice(0, 7),
    }));

    return { path: linePath, areaPath: area, points: pts, yLabels: yLbls, xLabels: xLbls };
  }, [data, height, unit]);

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-20 text-slate-400 text-xs">
        Insufficient data
      </div>
    );
  }

  return (
    <div className="relative">
      <svg
        viewBox="0 0 320 122"
        className="w-full"
        preserveAspectRatio="none"
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {/* Grid lines */}
        {yLabels.map((yl, i) => (
          <line key={i} x1="52" y1={yl.y} x2="310" y2={yl.y} stroke="#e2e8f0" strokeWidth="0.5" />
        ))}
        {/* Y-axis labels */}
        {yLabels.map((yl, i) => (
          <text key={`yl-${i}`} x="48" y={yl.y + 3} textAnchor="end" fill="#94a3b8" fontSize="8" fontFamily="system-ui">
            {yl.label}
          </text>
        ))}
        {/* X-axis labels */}
        {xLabels.map((xl, i) => (
          <text key={`xl-${i}`} x={xl.x} y="118" textAnchor="middle" fill="#94a3b8" fontSize="8" fontFamily="system-ui">
            {xl.label}
          </text>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill={color.fill} opacity="0.5" />
        {/* Line */}
        <path d={path} fill="none" stroke={color.stroke} strokeWidth="1.5" strokeLinejoin="round" />

        {/* Invisible hover rects */}
        {points.map((p, i) => (
          <rect
            key={i}
            x={p.x - (320 / data.length) / 2}
            y="0"
            width={320 / data.length}
            height="110"
            fill="transparent"
            onMouseEnter={() => setHoveredIdx(i)}
          />
        ))}

        {/* Hover dot + crosshair */}
        {hoveredIdx !== null && points[hoveredIdx] && (
          <>
            <line x1={points[hoveredIdx].x} y1="8" x2={points[hoveredIdx].x} y2="100" stroke={color.stroke} strokeWidth="0.5" strokeDasharray="3,3" opacity="0.5" />
            <circle cx={points[hoveredIdx].x} cy={points[hoveredIdx].y} r="3" fill={color.stroke} stroke="#fff" strokeWidth="1.5" />
          </>
        )}
      </svg>

      {/* Hover tooltip */}
      {hoveredIdx !== null && points[hoveredIdx] && (
        <div
          className="absolute top-0 bg-white/95 border border-slate-200 rounded-md px-2 py-1 text-xs shadow-md pointer-events-none z-10"
          style={{
            left: `${Math.min(Math.max((points[hoveredIdx].x / 320) * 100, 15), 85)}%`,
            transform: 'translateX(-50%)',
          }}
        >
          <span className="text-slate-500">{data[hoveredIdx].date}</span>
          <span className="ml-2 font-semibold text-slate-900">
            {formatVal(data[hoveredIdx].value, unit)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main Modal Component ────────────────────────────────────────────────────

const MetroDetailModal: React.FC<MetroDetailModalProps> = ({ isOpen, onClose, cbsaCode, metroName, initialZipCode = null }) => {
  const [data, setData] = useState<MetroHistoryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zipMarkets, setZipMarkets] = useState<any[]>([]);
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [selectedZipCode, setSelectedZipCode] = useState<string | null>(initialZipCode);

  useEffect(() => {
    setSelectedZipCode(initialZipCode);
  }, [initialZipCode, cbsaCode]);

  useEffect(() => {
    if (!isOpen || !cbsaCode) return;
    setLoading(true);
    setError(null);
    setData(null);

    fetch(`http://localhost:3001/api/fred/metro-history?cbsa=${cbsaCode}`)
      .then(res => res.json())
      .then(json => {
        if (!json.ok) throw new Error(json.error || 'Failed to load metro data');
        setData(json.data);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [isOpen, cbsaCode]);

  useEffect(() => {
    if (!isOpen || !cbsaCode) return;

    let cancelled = false;
    setZipLoading(true);
    setZipError(null);

    fetch(`http://localhost:3001/api/rentcast/metro-zips?metro=${cbsaCode}`)
      .then(res => res.json().then((json) => ({ ok: res.ok, json })))
      .then(({ ok, json }) => {
        if (!ok || !json.ok) throw new Error(json.error || 'Failed to load metro ZIP drilldown');
        if (cancelled) return;
        const markets = json.data?.markets || [];
        setZipMarkets(markets);
        setSelectedZipCode((currentZipCode) => {
          if (initialZipCode && markets.some((market: any) => market.zipCode === initialZipCode)) {
            return initialZipCode;
          }
          if (currentZipCode && markets.some((market: any) => market.zipCode === currentZipCode)) {
            return currentZipCode;
          }
          return markets[0]?.zipCode || null;
        });
      })
      .catch(err => {
        if (cancelled) return;
        setZipMarkets([]);
        setSelectedZipCode(null);
        setZipError(err.message);
      })
      .finally(() => {
        if (!cancelled) {
          setZipLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, cbsaCode, initialZipCode]);

  // Sort metrics in preferred order, filtering to ones with data
  const orderedMetrics = useMemo(() => {
    if (!data?.series) return [];
    const ordered: { key: string; series: SeriesData }[] = [];
    for (const key of METRIC_ORDER) {
      if (data.series[key]) ordered.push({ key, series: data.series[key] });
    }
    // Add any remaining metrics not in the preferred order
    for (const key of Object.keys(data.series)) {
      if (!METRIC_ORDER.includes(key)) ordered.push({ key, series: data.series[key] });
    }
    return ordered;
  }, [data]);

  if (!isOpen) return null;

  const displayName = metroName.split(',')[0];
  const statePart = metroName.includes(',') ? metroName.split(',').slice(1).join(',').trim() : '';

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden mx-4">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-start justify-between z-10 shrink-0">
          <div>
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              📍 {displayName}
            </h2>
            {statePart && <p className="text-sm text-slate-500 mt-0.5">{statePart} &nbsp;·&nbsp; CBSA {cbsaCode}</p>}
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded-lg hover:bg-slate-100"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="5" x2="15" y2="15" />
              <line x1="15" y1="5" x2="5" y2="15" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-4" />
              <p className="text-slate-500 text-sm">Fetching economic data for {displayName}…</p>
              <p className="text-slate-400 text-xs mt-1">This may take a moment on first load</p>
            </div>
          )}

          {error && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-700">
              <span className="font-medium">Error:</span> {error}
            </div>
          )}

          {data && !loading && (
            <>
              {/* KPI Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
                {orderedMetrics.slice(0, 8).map(({ key, series }) => {
                  const colors = CHART_COLORS[key] || { stroke: '#64748b', fill: '#f1f5f9' };
                  const icon = METRIC_ICONS[key] || '📈';
                  return (
                    <div key={key} className="bg-slate-50 rounded-xl border border-slate-200 p-3">
                      <div className="text-xs text-slate-500 flex items-center gap-1 mb-1">
                        <span>{icon}</span> {series.label}
                      </div>
                      <div className="text-lg font-bold text-slate-900">
                        {formatVal(series.latest, series.unit)}
                      </div>
                      {series.yoyGrowth !== null && (
                        <div className={`text-xs font-semibold mt-0.5 ${series.yoyGrowth >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {series.yoyGrowth >= 0 ? '▲' : '▼'} {series.yoyGrowth >= 0 ? '+' : ''}{series.yoyGrowth}% YoY
                        </div>
                      )}
                      <div className="text-[10px] text-slate-400 mt-0.5">as of {series.latestDate}</div>
                    </div>
                  );
                })}
              </div>

              {/* Trend Charts Grid */}
              <div className="mb-6">
                <ZipMarketDrilldown
                  title="ZIP-Level Market Drilldown"
                  description="RentCast ZIP aggregates are layered into the metro modal so you can move from metro trend context into neighborhood-level pricing, yield, and market-speed signals inside the same flow."
                  markets={zipMarkets}
                  selectedZipCode={selectedZipCode}
                  onSelectZip={setSelectedZipCode}
                  loading={zipLoading}
                  error={zipError}
                  emptyState="ZIP drilldown is not mapped for this metro yet."
                />
              </div>

              <h3 className="text-base font-semibold text-slate-900 mb-3">📈 Historical Trends</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {orderedMetrics.map(({ key, series }) => {
                  const colors = CHART_COLORS[key] || { stroke: '#64748b', fill: '#f1f5f9' };
                  const icon = METRIC_ICONS[key] || '📈';
                  return (
                    <div key={key} className="bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md transition-shadow">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                          <span>{icon}</span> {series.label}
                        </h4>
                        <div className="flex items-center gap-2">
                          {series.yoyGrowth !== null && (
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                              series.yoyGrowth >= 0
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-rose-50 text-rose-700'
                            }`}>
                              {series.yoyGrowth >= 0 ? '+' : ''}{series.yoyGrowth}%
                            </span>
                          )}
                          <span className="text-xs text-slate-400">{series.count} pts</span>
                        </div>
                      </div>

                      <MiniChart data={series.observations} color={colors} unit={series.unit} />

                      <div className="flex justify-between mt-1 text-[10px] text-slate-400">
                        <span>{series.earliestDate}: {formatVal(series.earliest, series.unit)}</span>
                        <span>{series.latestDate}: {formatVal(series.latest, series.unit)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              {data.fetchedAt && (
                <p className="text-xs text-slate-400 text-center mt-6">
                  Data sourced from FRED (Federal Reserve Economic Data) · Fetched {new Date(data.fetchedAt).toLocaleDateString()}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default MetroDetailModal;
