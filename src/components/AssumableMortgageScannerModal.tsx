/**
 * Assumable Mortgage Scanner Modal
 * Bulk scan ZIP codes for FHA/VA/USDA assumable mortgages.
 * Prioritizes multifamily (2-4 units) with government-backed low-rate loans.
 * Renders as a full-screen modal within the Property Search page.
 */

import React, { useState, useCallback } from 'react';

const BACKEND_URL = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';

// Types
interface DealTier {
  tier: number;
  label: string;
  color: string;
  description: string;
}

interface AssumabilityDetail {
  assumable: string;
  confidence: string;
  reason: string;
  attractiveness: string;
  nextSteps: string[];
  disclaimer: string;
}

interface OwnerInfo {
  name: string;
  name2?: string | null;
  isCorporate: boolean;
  mailingAddress: string;
  isAbsentee: boolean;
}

interface AssumableDeal {
  dealTier: DealTier;
  attomId?: string;
  apn?: string;
  address: string;
  streetAddress?: string;
  city: string;
  state: string;
  zipCode: string;
  county?: string;
  propertyType: string;
  isMultifamily: boolean;
  beds: number;
  baths: number;
  sqft: number;
  lotSizeAcres?: number;
  yearBuilt: number;
  units: number;
  marketValue: number;
  assessedValue: number;
  lastSalePrice?: number;
  lastSaleDate?: string;
  loanType: string;
  originalAmount: number;
  remainingBalance: number;
  estimatedRate: number;
  rateEstimated: boolean;
  currentMarketRate: number;
  rateSavings: number;
  loanDate: string;
  termMonths: number;
  monthsRemaining: number;
  percentPaid: number;
  lender: string;
  assumedPayment: number;
  marketPayment: number;
  monthlySavings: number;
  annualSavings: number;
  lifetimeSavings: number;
  gapPayment: number;
  estimatedMIP: number;
  effectiveMonthlySavings: number;
  owner: OwnerInfo;
  ownershipYears: number;
  latitude?: number;
  longitude?: number;
  assumability: AssumabilityDetail;
}

interface ScanStats {
  totalScanned: number;
  totalWithMortgage: number;
  totalAssumable: number;
  loanTypeBreakdown: Record<string, number>;
  elapsedSeconds: number;
  pagesScanned: number;
}

interface ScanFilters {
  zipCode: string;
  county: string;
  propertyTypes: string[];
  minRateSavings: string;
  minBalance: string;
  maxPages: string;
  originatedAfter: string;
  originatedBefore: string;
  sortBy: string;
}

interface AssumableMortgageScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function getTierBadge(tier: DealTier) {
  const colors: Record<string, string> = {
    purple: 'bg-purple-100 text-purple-800 border-purple-300',
    red: 'bg-red-100 text-red-800 border-red-300',
    gold: 'bg-amber-100 text-amber-800 border-amber-300',
    green: 'bg-green-100 text-green-800 border-green-300',
    gray: 'bg-gray-100 text-gray-700 border-gray-300'
  };
  return (
    <span className={`px-2 py-0.5 text-xs font-bold rounded-full border ${colors[tier.color] || colors.gray}`}>
      {tier.label}
    </span>
  );
}

/** Safely convert any value to string — handles ATTOM objects like {lastname, companycode} */
function safeStr(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    return String(obj.lastname || obj.fullname || obj.companyname || obj.companycode || obj.name || obj.oneLine || JSON.stringify(val));
  }
  return String(val);
}

function formatCurrency(amount: number): string {
  if (!amount) return '$0';
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

function formatFullCurrency(amount: number): string {
  return `$${(amount || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function getLoanTypeBadge(type: string) {
  const map: Record<string, string> = {
    VA: 'bg-blue-100 text-blue-800',
    FHA: 'bg-orange-100 text-orange-800',
    USDA: 'bg-green-100 text-green-800',
    RHS: 'bg-green-100 text-green-800',
  };
  return <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${map[type] || 'bg-gray-100 text-gray-700'}`}>{type}</span>;
}

const AssumableMortgageScannerModal: React.FC<AssumableMortgageScannerModalProps> = ({ isOpen, onClose }) => {
  const [filters, setFilters] = useState<ScanFilters>({
    zipCode: '',
    county: '',
    propertyTypes: ['SFR', 'MFR'],
    minRateSavings: '0.5',
    minBalance: '50000',
    maxPages: '5',
    originatedAfter: '2019-01-01',
    originatedBefore: '2024-01-01',
    sortBy: 'tier'
  });

  const [deals, setDeals] = useState<AssumableDeal[]>([]);
  const [stats, setStats] = useState<ScanStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedDeal, setExpandedDeal] = useState<string | null>(null);
  const [showTierLegend, setShowTierLegend] = useState(false);

  const handleScan = useCallback(async () => {
    if (!filters.zipCode && !filters.county) {
      setError('Enter a ZIP code or county FIPS to scan');
      return;
    }
    setLoading(true);
    setError(null);
    setDeals([]);
    setStats(null);

    try {
      const params = new URLSearchParams();
      if (filters.zipCode) params.set('zipCode', filters.zipCode);
      if (filters.county) params.set('county', filters.county);
      params.set('propertyTypes', filters.propertyTypes.join(','));
      params.set('minRateSavings', filters.minRateSavings);
      params.set('minBalance', filters.minBalance);
      params.set('maxPages', filters.maxPages);
      params.set('originatedAfter', filters.originatedAfter);
      params.set('originatedBefore', filters.originatedBefore);
      params.set('sortBy', filters.sortBy);

      const response = await fetch(`${BACKEND_URL}/api/attom/assumable-scan?${params.toString()}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Scan failed');
      setDeals(data.deals || []);
      setStats(data.stats || null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const exportCSV = useCallback(() => {
    if (!deals.length) return;
    const headers = [
      'Tier','Address','City','State','ZIP','Type','Multifamily','Beds','Baths','SqFt','Units','Year Built',
      'Loan Type','Original Amount','Remaining Balance','Rate','Rate Est.','Market Rate','Rate Savings',
      'Loan Date','Mo. Remaining','Assumed Pmt','Market Pmt','Mo. Savings','Annual Savings','Lifetime Savings',
      'Gap Payment','MIP/mo','Eff. Mo. Savings','Market Value','Lender','Owner','Absentee','Yrs Owned'
    ];
    const rows = deals.map(d => [
      d.dealTier.label.replace(/[^\w\s]/g,'').trim(), d.address, d.city, d.state, d.zipCode,
      d.propertyType, d.isMultifamily?'Yes':'No', d.beds, d.baths, d.sqft, d.units, d.yearBuilt,
      d.loanType, d.originalAmount, d.remainingBalance, d.estimatedRate, d.rateEstimated?'Yes':'No',
      d.currentMarketRate, d.rateSavings.toFixed(2), d.loanDate, d.monthsRemaining,
      d.assumedPayment, d.marketPayment, d.monthlySavings, d.annualSavings, d.lifetimeSavings,
      d.gapPayment, d.estimatedMIP, d.effectiveMonthlySavings,
      d.marketValue, safeStr(d.lender), safeStr(d.owner.name), d.owner.isAbsentee?'Yes':'No', d.ownershipYears
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `assumable-deals-${filters.zipCode || filters.county}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [deals, filters]);

  const togglePropertyType = (type: string) => {
    setFilters(prev => ({
      ...prev,
      propertyTypes: prev.propertyTypes.includes(type)
        ? prev.propertyTypes.filter(t => t !== type)
        : [...prev.propertyTypes, type]
    }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-50 overflow-hidden">
      <div className="h-full flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-7xl h-[92vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b bg-gradient-to-r from-purple-700 via-indigo-700 to-blue-700 flex-shrink-0">
            <div>
              <h2 className="text-xl font-bold text-white">🏦 Assumable Mortgage Scanner</h2>
              <p className="text-purple-200 text-sm">Find FHA/VA/USDA loans with below-market rates · Multifamily prioritized</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowTierLegend(!showTierLegend)}
                className="text-white/80 hover:text-white text-xs border border-white/30 rounded-lg px-3 py-1.5 hover:bg-white/10 transition"
              >
                {showTierLegend ? 'Hide' : 'Show'} Tier Guide
              </button>
              <button onClick={onClose} className="text-white hover:bg-white/20 rounded-full p-2 transition">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Tier Legend (collapsible) */}
          {showTierLegend && (
            <div className="px-6 py-3 bg-indigo-50 border-b text-sm flex-shrink-0">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <div className="flex items-center gap-1.5"><span className="text-base">🏆</span><span><b className="text-purple-800">Tier 1</b> VA MFR — No MI, best deal</span></div>
                <div className="flex items-center gap-1.5"><span className="text-base">🔥</span><span><b className="text-red-800">Tier 2</b> FHA MFR — House-hack play</span></div>
                <div className="flex items-center gap-1.5"><span className="text-base">⭐</span><span><b className="text-amber-800">Tier 3</b> VA SFR — No MI, occupy 12mo</span></div>
                <div className="flex items-center gap-1.5"><span className="text-base">✅</span><span><b className="text-green-800">Tier 4</b> FHA SFR — MIP for life</span></div>
                <div className="flex items-center gap-1.5"><span className="text-base">🌾</span><span><b className="text-gray-700">Tier 5</b> USDA — Rural, income cap</span></div>
              </div>
            </div>
          )}

          {/* Search Controls */}
          <div className="px-6 py-4 border-b bg-gray-50 flex-shrink-0">
            <div className="flex flex-wrap gap-3 items-end">
              {/* ZIP */}
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-700 mb-1">ZIP Code</label>
                <input
                  type="text"
                  placeholder="e.g. 20854"
                  value={filters.zipCode}
                  onChange={e => setFilters(f => ({ ...f, zipCode: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && handleScan()}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              {/* County FIPS */}
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-700 mb-1">County FIPS</label>
                <input
                  type="text"
                  placeholder="e.g. 24031"
                  value={filters.county}
                  onChange={e => setFilters(f => ({ ...f, county: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && handleScan()}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              {/* Property Types */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Property Types</label>
                <div className="flex gap-1">
                  {[
                    { value: 'MFR', label: '🏘️ MFR', tip: '2-4 Units' },
                    { value: 'SFR', label: '🏠 SFR', tip: 'Single Family' },
                    { value: 'CONDO', label: '🏢 Condo', tip: 'Condo/TH' },
                  ].map(type => (
                    <button
                      key={type.value}
                      title={type.tip}
                      onClick={() => togglePropertyType(type.value)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition ${
                        filters.propertyTypes.includes(type.value)
                          ? type.value === 'MFR'
                            ? 'bg-purple-100 text-purple-800 border-purple-300'
                            : 'bg-indigo-100 text-indigo-700 border-indigo-300'
                          : 'bg-white text-gray-400 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Min Rate Savings */}
              <div className="w-32">
                <label className="block text-xs font-medium text-gray-700 mb-1">Min Rate Savings</label>
                <select
                  value={filters.minRateSavings}
                  onChange={e => setFilters(f => ({ ...f, minRateSavings: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm"
                >
                  <option value="0">Any</option>
                  <option value="0.5">≥ 0.5%</option>
                  <option value="1.0">≥ 1.0%</option>
                  <option value="1.5">≥ 1.5%</option>
                  <option value="2.0">≥ 2.0%</option>
                  <option value="3.0">≥ 3.0%</option>
                </select>
              </div>
              {/* Min Balance */}
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-700 mb-1">Min Balance</label>
                <select
                  value={filters.minBalance}
                  onChange={e => setFilters(f => ({ ...f, minBalance: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm"
                >
                  <option value="0">Any</option>
                  <option value="50000">$50K+</option>
                  <option value="100000">$100K+</option>
                  <option value="200000">$200K+</option>
                  <option value="300000">$300K+</option>
                </select>
              </div>
              {/* Originated range */}
              <div className="w-32">
                <label className="block text-xs font-medium text-gray-700 mb-1">Originated After</label>
                <input
                  type="date"
                  value={filters.originatedAfter}
                  onChange={e => setFilters(f => ({ ...f, originatedAfter: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm"
                />
              </div>
              <div className="w-32">
                <label className="block text-xs font-medium text-gray-700 mb-1">Originated Before</label>
                <input
                  type="date"
                  value={filters.originatedBefore}
                  onChange={e => setFilters(f => ({ ...f, originatedBefore: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm"
                />
              </div>
              {/* Depth */}
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-700 mb-1">Scan Depth</label>
                <select
                  value={filters.maxPages}
                  onChange={e => setFilters(f => ({ ...f, maxPages: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm"
                >
                  <option value="2">200 props</option>
                  <option value="5">500 props</option>
                  <option value="10">1,000 props</option>
                  <option value="20">2,000 props</option>
                </select>
              </div>
              {/* Sort */}
              <div className="w-32">
                <label className="block text-xs font-medium text-gray-700 mb-1">Sort By</label>
                <select
                  value={filters.sortBy}
                  onChange={e => setFilters(f => ({ ...f, sortBy: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm"
                >
                  <option value="tier">Best Tier</option>
                  <option value="rateSavings">Rate Savings</option>
                  <option value="monthlySavings">Monthly Savings</option>
                  <option value="balance">Balance</option>
                </select>
              </div>
              {/* Scan Button */}
              <button
                onClick={handleScan}
                disabled={loading || (!filters.zipCode && !filters.county)}
                className="px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-semibold rounded-lg hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md flex items-center gap-2 text-sm"
              >
                {loading ? (
                  <><svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/><path d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" fill="currentColor" className="opacity-75"/></svg> Scanning...</>
                ) : (
                  <>🔍 Scan</>
                )}
              </button>
              {/* Export */}
              {deals.length > 0 && (
                <button
                  onClick={exportCSV}
                  className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center gap-1"
                >
                  📥 Export CSV
                </button>
              )}
            </div>
            {/* Tip */}
            <p className="text-xs text-purple-600 mt-2">
              💡 Target loans originated 2020–2023 at 2.25–4%. Multifamily = highest FHA/VA concentration — house-hack one unit, rent the rest.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mx-6 mt-3 bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-sm flex-shrink-0">
              <span className="text-red-500">⚠️</span>
              <span className="text-red-700">{error}</span>
            </div>
          )}

          {/* Stats Bar */}
          {stats && (
            <div className="px-6 py-3 border-b bg-white flex-shrink-0">
              <div className="flex items-center gap-6 text-sm">
                <span className="text-gray-500">{stats.totalScanned.toLocaleString()} scanned</span>
                <span className="text-gray-500">{stats.totalWithMortgage.toLocaleString()} mortgaged</span>
                <span className="font-semibold text-purple-700">{stats.totalAssumable} assumable deals</span>
                <span className="text-blue-600">VA: {stats.loanTypeBreakdown.VA || 0}</span>
                <span className="text-orange-600">FHA: {stats.loanTypeBreakdown.FHA || 0}</span>
                <span className="text-green-600">USDA: {stats.loanTypeBreakdown.USDA || 0}</span>
                <span className="text-gray-400">CNV: {stats.loanTypeBreakdown.CNV || 0}</span>
                <span className="text-gray-400 ml-auto">{stats.elapsedSeconds}s</span>
              </div>
              {/* Mini bar chart */}
              {stats.totalWithMortgage > 0 && (
                <div className="flex h-2 rounded-full overflow-hidden bg-gray-100 mt-2">
                  {stats.loanTypeBreakdown.FHA > 0 && <div className="bg-orange-400" style={{ width: `${(stats.loanTypeBreakdown.FHA / stats.totalWithMortgage) * 100}%` }} />}
                  {stats.loanTypeBreakdown.VA > 0 && <div className="bg-blue-500" style={{ width: `${(stats.loanTypeBreakdown.VA / stats.totalWithMortgage) * 100}%` }} />}
                  {stats.loanTypeBreakdown.USDA > 0 && <div className="bg-green-500" style={{ width: `${(stats.loanTypeBreakdown.USDA / stats.totalWithMortgage) * 100}%` }} />}
                  {stats.loanTypeBreakdown.CNV > 0 && <div className="bg-gray-300" style={{ width: `${(stats.loanTypeBreakdown.CNV / stats.totalWithMortgage) * 100}%` }} />}
                </div>
              )}
            </div>
          )}

          {/* Results List */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {/* Loading State */}
            {loading && (
              <div className="flex flex-col items-center justify-center py-20">
                <div className="w-12 h-12 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin mb-4" />
                <p className="text-gray-600 font-medium">Scanning for assumable mortgages...</p>
                <p className="text-gray-400 text-sm mt-1">Fetching 100 properties per page from ATTOM API</p>
              </div>
            )}

            {/* Empty state before search */}
            {!loading && !stats && deals.length === 0 && (
              <div className="text-center py-16">
                <div className="text-5xl mb-4">🏦</div>
                <h3 className="text-lg font-semibold text-gray-800">Scan for Assumable Mortgages</h3>
                <p className="text-gray-500 text-sm mt-2 max-w-lg mx-auto">
                  Enter a ZIP code and hit Scan. The scanner will page through ATTOM property records,
                  identify FHA/VA/USDA loans originated during the low-rate era (2020–2023),
                  calculate remaining balances, and rank deals by tier.
                </p>
                <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl mx-auto text-left">
                  <div className="p-3 bg-purple-50 rounded-lg border border-purple-200">
                    <p className="font-semibold text-purple-800 text-sm">🏆 Best: VA Multifamily</p>
                    <p className="text-xs text-gray-600 mt-1">No mortgage insurance. Anyone can assume. House-hack 2-4 units.</p>
                  </div>
                  <div className="p-3 bg-red-50 rounded-lg border border-red-200">
                    <p className="font-semibold text-red-800 text-sm">🔥 Great: FHA Multifamily</p>
                    <p className="text-xs text-gray-600 mt-1">Most common. Has MIP but massive rate lock. Live in 1, rent the rest.</p>
                  </div>
                  <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="font-semibold text-blue-800 text-sm">💰 The Math</p>
                    <p className="text-xs text-gray-600 mt-1">2.75% assumed vs 6.5% market on $400K = ~$930/mo savings = $11K/yr.</p>
                  </div>
                </div>
              </div>
            )}

            {/* No results after search */}
            {!loading && stats && deals.length === 0 && (
              <div className="text-center py-16">
                <div className="text-4xl mb-3">🔍</div>
                <h3 className="text-lg font-semibold text-gray-700">No Assumable Deals Found</h3>
                <p className="text-gray-500 text-sm mt-2">
                  Scanned {stats.totalScanned} properties. Try lowering rate savings threshold, widening the date range, or a different ZIP.
                </p>
              </div>
            )}

            {/* Deal Cards */}
            {deals.map((deal, index) => {
              const isExpanded = expandedDeal === (deal.attomId || deal.address);
              const borderColor = deal.dealTier.tier <= 1 ? 'border-purple-300' :
                deal.dealTier.tier <= 2 ? 'border-red-200' :
                deal.dealTier.tier <= 3 ? 'border-amber-200' : 'border-gray-200';

              return (
                <div key={deal.attomId || deal.address || index} className={`mb-3 rounded-xl border ${borderColor} bg-white shadow-sm transition-all ${deal.dealTier.tier <= 1 ? 'ring-1 ring-purple-100' : ''}`}>
                  {/* Row */}
                  <div
                    className="px-4 py-3 cursor-pointer hover:bg-gray-50/50 flex items-center gap-4"
                    onClick={() => setExpandedDeal(isExpanded ? null : (deal.attomId || deal.address))}
                  >
                    {/* Tier + Type */}
                    <div className="flex flex-col items-center gap-1 w-20 flex-shrink-0">
                      {getTierBadge(deal.dealTier)}
                      {getLoanTypeBadge(deal.loanType)}
                    </div>

                    {/* Address & property info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-gray-900 truncate">{deal.address}</h3>
                        {deal.isMultifamily && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-50 text-purple-700 border border-purple-200 flex-shrink-0">
                            {deal.units}+ Units
                          </span>
                        )}
                        {deal.owner.isAbsentee && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-yellow-50 text-yellow-700 border border-yellow-200 flex-shrink-0">
                            Absentee
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {deal.beds}bd/{deal.baths}ba · {deal.sqft.toLocaleString()}sf · {deal.yearBuilt}
                        {deal.isMultifamily ? ` · ${deal.propertyType}` : ''}
                      </p>
                    </div>

                    {/* Key metrics */}
                    <div className="text-right flex-shrink-0 hidden sm:block">
                      <p className="text-lg font-bold text-green-600">{deal.estimatedRate?.toFixed(2)}%</p>
                      <p className="text-[10px] text-gray-400">vs {deal.currentMarketRate}% mkt</p>
                    </div>
                    <div className="text-right flex-shrink-0 hidden md:block w-24">
                      <p className="text-sm font-bold text-purple-700">{formatFullCurrency(deal.effectiveMonthlySavings)}<span className="text-xs font-normal">/mo</span></p>
                      <p className="text-[10px] text-gray-400">{formatFullCurrency(deal.annualSavings)}/yr</p>
                    </div>
                    <div className="text-right flex-shrink-0 hidden lg:block w-20">
                      <p className="text-sm font-semibold text-gray-800">{formatCurrency(deal.remainingBalance)}</p>
                      <p className="text-[10px] text-gray-400">{deal.percentPaid?.toFixed(0)}% paid</p>
                    </div>
                    <div className="text-right flex-shrink-0 hidden lg:block w-20">
                      <p className="text-sm font-medium text-gray-600">{formatCurrency(deal.gapPayment)}</p>
                      <p className="text-[10px] text-gray-400">gap</p>
                    </div>

                    <svg className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <div className="border-t border-gray-100 px-4 pb-4">
                      {/* Summary banner */}
                      <div className={`mt-3 p-3 rounded-lg text-sm ${deal.dealTier.tier <= 2 ? 'bg-purple-50 border border-purple-200' : 'bg-indigo-50 border border-indigo-200'}`}>
                        <p className="font-medium text-gray-800">{deal.dealTier.description}</p>
                        <p className="text-xs text-gray-600 mt-0.5">{deal.assumability.reason}</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 text-sm">
                        {/* Mortgage */}
                        <div>
                          <h4 className="font-semibold text-gray-700 mb-2">🏦 Mortgage</h4>
                          <div className="space-y-1 text-xs">
                            <div className="flex justify-between"><span className="text-gray-500">Type</span><span className="font-medium">{deal.loanType}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Lender</span><span>{safeStr(deal.lender)}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Original</span><span>{formatFullCurrency(deal.originalAmount)}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Remaining</span><span className="font-semibold">{formatFullCurrency(deal.remainingBalance)}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Rate</span><span className="font-semibold text-green-600">{deal.estimatedRate?.toFixed(2)}%{deal.rateEstimated ? ' (est.)' : ''}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Originated</span><span>{deal.loanDate ? new Date(deal.loanDate).toLocaleDateString() : 'N/A'}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Remaining</span><span>{deal.monthsRemaining} mo ({(deal.monthsRemaining/12).toFixed(1)} yr)</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Paid Off</span><span>{deal.percentPaid?.toFixed(1)}%</span></div>
                          </div>
                        </div>

                        {/* Financials */}
                        <div>
                          <h4 className="font-semibold text-gray-700 mb-2">💰 Financial Analysis</h4>
                          <div className="space-y-1 text-xs">
                            <div className="flex justify-between"><span className="text-gray-500">Assumed P&I</span><span className="font-semibold text-green-600">{formatFullCurrency(deal.assumedPayment)}/mo</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Market P&I</span><span className="text-red-400 line-through">{formatFullCurrency(deal.marketPayment)}/mo</span></div>
                            {deal.estimatedMIP > 0 && (
                              <div className="flex justify-between"><span className="text-gray-500">FHA MIP</span><span className="text-amber-600">+{formatFullCurrency(deal.estimatedMIP)}/mo</span></div>
                            )}
                            <div className="border-t border-gray-200 my-1" />
                            <div className="flex justify-between"><span className="text-gray-500 font-medium">Net Savings</span><span className="font-bold text-purple-700">{formatFullCurrency(deal.effectiveMonthlySavings)}/mo</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Annual</span><span className="font-semibold">{formatFullCurrency(deal.annualSavings)}/yr</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Lifetime</span><span className="font-semibold text-green-700">{formatFullCurrency(deal.lifetimeSavings)}</span></div>
                            <div className="border-t border-gray-200 my-1" />
                            <div className="flex justify-between"><span className="text-gray-500">Rate Savings</span><span className="font-bold">{deal.rateSavings.toFixed(2)}% ↓</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Gap Payment</span><span className="font-medium">{formatFullCurrency(deal.gapPayment)}</span></div>
                            <p className="text-[10px] text-gray-400 mt-1">Gap = market value − remaining balance (equity at close)</p>
                          </div>
                        </div>

                        {/* Property & Owner */}
                        <div>
                          <h4 className="font-semibold text-gray-700 mb-2">🏠 Property & Owner</h4>
                          <div className="space-y-1 text-xs">
                            <div className="flex justify-between"><span className="text-gray-500">Value</span><span>{formatFullCurrency(deal.marketValue)}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Last Sale</span><span>{formatFullCurrency(deal.lastSalePrice || 0)} ({deal.lastSaleDate ? new Date(deal.lastSaleDate).toLocaleDateString() : '—'})</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Type</span><span>{deal.propertyType}{deal.isMultifamily ? ` (${deal.units}+ units)` : ''}</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Lot</span><span>{deal.lotSizeAcres?.toFixed(2)} ac</span></div>
                            <div className="border-t border-gray-200 my-1" />
                            <div className="flex justify-between"><span className="text-gray-500">Owner</span><span className="font-medium">{safeStr(deal.owner.name)}</span></div>
                            {deal.owner.name2 && <div className="flex justify-between"><span className="text-gray-500">Owner 2</span><span>{safeStr(deal.owner.name2)}</span></div>}
                            <div className="flex justify-between"><span className="text-gray-500">Owned</span><span>{deal.ownershipYears} yr</span></div>
                            <div className="flex justify-between"><span className="text-gray-500">Absentee</span><span>{deal.owner.isAbsentee ? '✅ Yes' : 'No'}</span></div>
                            {deal.owner.mailingAddress && <div className="flex justify-between"><span className="text-gray-500">Mailing</span><span className="text-[10px] truncate max-w-[140px]">{safeStr(deal.owner.mailingAddress)}</span></div>}
                          </div>
                        </div>
                      </div>

                      {/* Next Steps */}
                      {deal.assumability.nextSteps?.length > 0 && (
                        <div className="mt-3 p-3 bg-gray-50 rounded-lg text-xs">
                          <p className="font-semibold text-gray-700 mb-1">📋 Next Steps</p>
                          <ol className="list-decimal list-inside text-gray-600 space-y-0.5">
                            {deal.assumability.nextSteps.map((step: string, i: number) => (
                              <li key={i}>{step}</li>
                            ))}
                            {deal.isMultifamily && (
                              <li className="text-purple-700 font-medium">House-hack: Occupy one unit 12 months, rent others from day one</li>
                            )}
                          </ol>
                          <p className="text-[10px] text-gray-400 mt-1.5 italic">{deal.assumability.disclaimer}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AssumableMortgageScannerModal;
