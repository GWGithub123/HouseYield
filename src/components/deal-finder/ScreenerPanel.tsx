/**
 * ScreenerPanel — regional deal screener: criteria + buy box form, the
 * search funnel, and the ranked results list of deal cards.
 */

import React, { useState } from 'react';
import { StreetViewImage } from '../StreetViewImage';
import type { ScreenedListing, ScreenerCriteria, ScreenerResponse, BuyBox } from '../../services/dealEngineClient';

interface ScreenerPanelProps {
  result: ScreenerResponse | null;
  loading: boolean;
  error: string | null;
  underwriting: boolean;
  underwrittenAddresses: Set<string>;
  dealScores: Record<string, { score: number; grade: string }>;
  onSearch: (criteria: ScreenerCriteria) => void;
  onUnderwrite: (listings: ScreenedListing[]) => void;
  onListingClick: (listing: ScreenedListing) => void;
  selectedAddress: string | null;
}

const inputCls = 'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300';
const labelCls = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500';

function fmtMoney(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export const ScreenerPanel: React.FC<ScreenerPanelProps> = ({
  result,
  loading,
  error,
  underwriting,
  underwrittenAddresses,
  dealScores,
  onSearch,
  onUnderwrite,
  onListingClick,
  selectedAddress,
}) => {
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minBeds, setMinBeds] = useState('');
  const [minBaths, setMinBaths] = useState('');
  const [propertyType, setPropertyType] = useState('');
  const [showBuyBox, setShowBuyBox] = useState(true);
  const [minCashFlow, setMinCashFlow] = useState('100');
  const [minCoc, setMinCoc] = useState('');
  const [minDscr, setMinDscr] = useState('');
  const [maxPriceToRent, setMaxPriceToRent] = useState('');
  const [minEdge, setMinEdge] = useState('');
  const [showFinancing, setShowFinancing] = useState(true);
  const [downPaymentPercent, setDownPaymentPercent] = useState('20');
  const [interestRate, setInterestRate] = useState('7');
  const [loanTermYears, setLoanTermYears] = useState('30');
  const [closingCostPercent, setClosingCostPercent] = useState('3');
  const [vacancyRate, setVacancyRate] = useState('7');
  const [managementFee, setManagementFee] = useState('8');
  const [propertyTaxPercent, setPropertyTaxPercent] = useState('1.1');
  const [insurancePercent, setInsurancePercent] = useState('0.5');
  const [maintenancePercent, setMaintenancePercent] = useState('0.8');
  const [otherCostsPercent, setOtherCostsPercent] = useState('0.5');
  const [showFailing, setShowFailing] = useState(false);

  const hasCitySearch = Boolean(city.trim() && state.trim());
  const hasZipSearch = Boolean(zipCode.trim());

  const handleSearch = () => {
    const buyBox: BuyBox = {};
    if (minCashFlow) buyBox.minMonthlyCashFlow = parseFloat(minCashFlow);
    if (minCoc) buyBox.minCocPct = parseFloat(minCoc);
    if (minDscr) buyBox.minDscr = parseFloat(minDscr);
    if (maxPriceToRent) buyBox.maxPriceToRent = parseFloat(maxPriceToRent);
    if (minEdge) buyBox.minValuationEdgePct = parseFloat(minEdge);

    const criteria: ScreenerCriteria = {
      buyBox,
      limit: 300,
      assumptions: {
        downPaymentPercent: parseFloat(downPaymentPercent) || 20,
        interestRate: parseFloat(interestRate) || 7,
        loanTermYears: parseFloat(loanTermYears) || 30,
        closingCostPercent: parseFloat(closingCostPercent) || 3,
        vacancyRate: parseFloat(vacancyRate) || 7,
        managementFee: parseFloat(managementFee) || 8,
        propertyTaxPercent: parseFloat(propertyTaxPercent) || 1.1,
        insurancePercent: parseFloat(insurancePercent) || 0.5,
        maintenancePercent: parseFloat(maintenancePercent) || 0.8,
        otherCostsPercent: parseFloat(otherCostsPercent) || 0.5,
      },
    };
    // If both are filled, prefer the explicit city/state area search instead
    // of silently reusing an older ZIP from another market.
    if (hasCitySearch) {
      criteria.city = city.trim();
      criteria.state = state.trim();
    } else if (hasZipSearch) {
      criteria.zipCode = zipCode.trim();
    } else {
      alert('Enter a city + state, or a ZIP code.');
      return;
    }
    if (minPrice) criteria.minPrice = parseFloat(minPrice);
    if (maxPrice) criteria.maxPrice = parseFloat(maxPrice);
    if (minBeds) criteria.minBeds = parseFloat(minBeds);
    if (minBaths) criteria.minBaths = parseFloat(minBaths);
    if (propertyType) criteria.propertyType = propertyType;

    onSearch(criteria);
  };

  const listings = result?.listings ?? [];
  const passing = listings.filter((l) => l.screen.passes);
  const visible = showFailing ? listings : passing.length ? passing : listings;

  return (
    <div className="flex h-full flex-col">
      {/* Criteria form */}
      <div className="border-b bg-white p-3 space-y-2.5">
        <div className="grid grid-cols-[1fr,64px,92px] gap-2">
          <div>
            <div className={labelCls}>City</div>
            <input
              className={inputCls}
              placeholder="e.g., Columbus"
              value={city}
              onChange={(e) => {
                setCity(e.target.value);
                if (e.target.value.trim()) setZipCode('');
              }}
            />
          </div>
          <div>
            <div className={labelCls}>State</div>
            <input
              className={inputCls}
              placeholder="OH"
              maxLength={2}
              value={state}
              onChange={(e) => {
                const nextState = e.target.value.toUpperCase();
                setState(nextState);
                if (nextState.trim()) setZipCode('');
              }}
            />
          </div>
          <div>
            <div className={labelCls}>or ZIP</div>
            <input
              className={inputCls}
              placeholder="43004"
              value={zipCode}
              onChange={(e) => {
                setZipCode(e.target.value);
                if (e.target.value.trim()) {
                  setCity('');
                  setState('');
                }
              }}
            />
          </div>
        </div>
        {hasCitySearch && hasZipSearch && (
          <div className="text-[11px] text-amber-600">Using city/state search. The ZIP is ignored when both are filled.</div>
        )}

        <div className="grid grid-cols-4 gap-2">
          <div>
            <div className={labelCls}>Min $</div>
            <input className={inputCls} placeholder="100k" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
          </div>
          <div>
            <div className={labelCls}>Max $</div>
            <input className={inputCls} placeholder="400k" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
          </div>
          <div>
            <div className={labelCls}>Beds+</div>
            <input className={inputCls} placeholder="3" value={minBeds} onChange={(e) => setMinBeds(e.target.value)} />
          </div>
          <div>
            <div className={labelCls}>Baths+</div>
            <input className={inputCls} placeholder="2" value={minBaths} onChange={(e) => setMinBaths(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 items-end">
          <div>
            <div className={labelCls}>Property Type</div>
            <select className={inputCls} value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
              <option value="">All Types</option>
              <option value="Single Family">Single Family</option>
              <option value="Multi Family">Multi Family</option>
              <option value="Townhouse">Townhouse</option>
              <option value="Condo">Condo</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => setShowBuyBox(!showBuyBox)}
            className="text-left text-xs font-semibold text-emerald-700 hover:text-emerald-900 pb-2"
          >
            {showBuyBox ? '▾' : '▸'} Buy Box (investor filters)
          </button>
        </div>

        {showBuyBox && (
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-emerald-50/70 border border-emerald-100 p-2">
            <div>
              <div className={labelCls}>Min CF $/mo</div>
              <input className={inputCls} placeholder="100" value={minCashFlow} onChange={(e) => setMinCashFlow(e.target.value)} />
            </div>
            <div>
              <div className={labelCls}>Min CoC %</div>
              <input className={inputCls} placeholder="6" value={minCoc} onChange={(e) => setMinCoc(e.target.value)} />
            </div>
            <div>
              <div className={labelCls}>Min DSCR</div>
              <input className={inputCls} placeholder="1.15" value={minDscr} onChange={(e) => setMinDscr(e.target.value)} />
            </div>
            <div>
              <div className={labelCls}>Max P/R</div>
              <input className={inputCls} placeholder="15" value={maxPriceToRent} onChange={(e) => setMaxPriceToRent(e.target.value)} />
            </div>
            <div>
              <div className={labelCls}>Min Edge %</div>
              <input className={inputCls} placeholder="0" value={minEdge} onChange={(e) => setMinEdge(e.target.value)} />
            </div>
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowFinancing(!showFinancing)}
            className="text-left text-xs font-semibold text-blue-700 hover:text-blue-900"
          >
            {showFinancing ? '▾' : '▸'} Financing & expense assumptions
          </button>
          {showFinancing && (
            <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-blue-100 bg-blue-50/60 p-2">
              <div>
                <div className={labelCls}>Down %</div>
                <input className={inputCls} value={downPaymentPercent} onChange={(e) => setDownPaymentPercent(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Rate %</div>
                <input className={inputCls} value={interestRate} onChange={(e) => setInterestRate(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Term</div>
                <input className={inputCls} value={loanTermYears} onChange={(e) => setLoanTermYears(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Close %</div>
                <input className={inputCls} value={closingCostPercent} onChange={(e) => setClosingCostPercent(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Vacancy %</div>
                <input className={inputCls} value={vacancyRate} onChange={(e) => setVacancyRate(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Mgmt %</div>
                <input className={inputCls} value={managementFee} onChange={(e) => setManagementFee(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Tax %</div>
                <input className={inputCls} value={propertyTaxPercent} onChange={(e) => setPropertyTaxPercent(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Ins %</div>
                <input className={inputCls} value={insurancePercent} onChange={(e) => setInsurancePercent(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Maint %</div>
                <input className={inputCls} value={maintenancePercent} onChange={(e) => setMaintenancePercent(e.target.value)} />
              </div>
              <div>
                <div className={labelCls}>Other %</div>
                <input className={inputCls} value={otherCostsPercent} onChange={(e) => setOtherCostsPercent(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleSearch}
          disabled={loading}
          className="w-full rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50 transition-all"
        >
          {loading ? 'Screening live listings…' : 'Search & Screen Listings'}
        </button>
      </div>

      {/* Funnel */}
      {result && (
        <div className="border-b bg-slate-50 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span className="rounded-full bg-slate-200 px-2.5 py-1 text-slate-700">{result.funnel.totalListings} listings</span>
            <span className="text-slate-400">→</span>
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">{result.funnel.screened} screened</span>
            <span className="text-slate-400">→</span>
            <span className="rounded-full bg-green-100 px-2.5 py-1 text-green-800">{result.funnel.positiveCashFlow ?? 0} positive FCF</span>
            <span className="text-slate-400">→</span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-800">{result.funnel.passing} pass buy box</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <input type="checkbox" checked={showFailing} onChange={(e) => setShowFailing(e.target.checked)} />
              Show filtered-out listings
            </label>
            {result.fromCache && <span className="text-[10px] text-slate-400">cached results</span>}
          </div>
          {passing.length > 0 && (
            <button
              type="button"
              onClick={() => onUnderwrite(passing.slice(0, 15))}
              disabled={underwriting}
              className="mt-2 w-full rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50"
            >
              {underwriting ? 'Underwriting…' : `Deep Underwrite Top ${Math.min(passing.length, 15)} (full analysis)`}
            </button>
          )}
        </div>
      )}

      {/* Results list */}
      <div className="flex-1 overflow-y-auto bg-slate-50/60">
        {error && !loading && (
          <div className="m-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}
        {!result && !loading && (
          <div className="p-6 text-center text-sm text-slate-500">
            <div className="text-3xl mb-2">🗺️</div>
            Search a market to screen live for-sale listings against your buy box.
          </div>
        )}
        {result && !loading && result.listings.length === 0 && (
          <div className="p-6 text-center text-sm text-slate-500">
            <div className="text-3xl mb-2">0</div>
            No listings matched this search.
            <div className="mt-2 text-xs text-slate-400">
              Check the city spelling, try a ZIP, or widen the filters.
            </div>
          </div>
        )}
        {visible.map((listing) => {
          const isSelected = selectedAddress === listing.formattedAddress;
          const isUnderwritten = listing.formattedAddress ? underwrittenAddresses.has(listing.formattedAddress) : false;
          const deal = listing.formattedAddress ? dealScores[listing.formattedAddress] : undefined;
          const s = listing.screen;
          return (
            <button
              key={listing.id || listing.formattedAddress}
              type="button"
              onClick={() => onListingClick(listing)}
              className={`w-full border-b bg-white text-left transition-colors hover:bg-emerald-50/40 ${isSelected ? 'ring-2 ring-inset ring-emerald-500' : ''} ${!s.passes ? 'opacity-60' : ''}`}
            >
              <div className="flex gap-2.5 p-2.5">
                <div className="h-[72px] w-[96px] shrink-0 overflow-hidden rounded-lg">
                  <StreetViewImage address={listing.formattedAddress || ''} width={192} height={144} className="h-full w-full" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-1">
                    <div className="truncate text-[13px] font-semibold text-slate-900">{listing.formattedAddress}</div>
                    <div className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${deal ? (deal.score >= 65 ? 'bg-emerald-600' : deal.score >= 50 ? 'bg-amber-500' : 'bg-rose-500') : s.positiveCashFlow ? 'bg-emerald-600' : s.passes ? 'bg-slate-600' : 'bg-slate-400'}`}>
                      {deal ? `${deal.grade} ${deal.score}` : s.positiveCashFlow ? '+FCF' : s.passes ? `~${s.score}` : 'NO'}
                    </div>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-sm font-bold text-slate-900">{fmtMoney(listing.price)}</span>
                    <span className="text-[11px] text-slate-500">
                      {listing.bedrooms ?? '?'}bd · {listing.bathrooms ?? '?'}ba · {listing.squareFootage ? `${listing.squareFootage.toLocaleString()}sf` : '?sf'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                    <span className={s.estMonthlyCashFlow != null && s.estMonthlyCashFlow >= 0 ? 'text-emerald-700 font-medium' : 'text-rose-600 font-medium'}>
                      CF {s.estMonthlyCashFlow != null ? `${s.estMonthlyCashFlow >= 0 ? '+' : ''}${fmtMoney(s.estMonthlyCashFlow)}/mo` : '—'}
                    </span>
                    {s.cashFlowStatus === 'near_break_even' && <span className="font-medium text-amber-600">near break-even</span>}
                    <span className={s.valuationEdgePct != null && s.valuationEdgePct > 0 ? 'text-emerald-700' : 'text-slate-500'}>
                      Edge {s.valuationEdgePct != null ? `${s.valuationEdgePct > 0 ? '+' : ''}${s.valuationEdgePct}%` : '—'}
                    </span>
                    <span className="text-slate-500">Rent ~{fmtMoney(s.estRent)}</span>
                    {s.estCocPct != null && <span className={s.estCocPct >= 0 ? 'text-emerald-700' : 'text-rose-600'}>CoC {s.estCocPct}%</span>}
                    {s.estDscr != null && <span className={s.estDscr >= 1.15 ? 'text-emerald-700' : 'text-rose-600'}>DSCR {s.estDscr}</span>}
                    {s.domSignal === 'stale' && <span className="text-amber-600 font-medium">stale listing</span>}
                  </div>
                  {!s.passes && s.failReasons.length > 0 && (
                    <div className="mt-0.5 truncate text-[10px] text-rose-500">{s.failReasons.join('; ')}</div>
                  )}
                  {s.estMonthlyCashFlow != null && s.estMonthlyCashFlow < 0 && s.breakEvenRent != null && (
                    <div className="mt-0.5 text-[10px] text-slate-400">Break-even rent ~{fmtMoney(s.breakEvenRent)}/mo under these assumptions</div>
                  )}
                  {isUnderwritten && <div className="mt-0.5 text-[10px] font-semibold text-blue-600">✓ Fully underwritten — click to open report</div>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
