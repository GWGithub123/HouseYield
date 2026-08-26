/**
 * DealFinderPage — map-centric BRRRR / buy-and-hold deal finder.
 *
 * Left: screener criteria + ranked results. Center: full-bleed map with
 * deal-score pins, coverage overlay, flag stars. Right drawer: unified
 * DealReport. Top: "Analyze a Property" (individual photo flow).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DealFinderMap } from '../components/deal-finder/DealFinderMap';
import { ScreenerPanel } from '../components/deal-finder/ScreenerPanel';
import { AnalyzePropertyModal } from '../components/deal-finder/AnalyzePropertyModal';
import { DealReport } from '../components/deal-finder/DealReport';
import {
  dealEngine,
  type ScreenedListing,
  type ScreenerCriteria,
  type ScreenerResponse,
  type DealReportData,
  type CoverageArea,
  type PropertyFlag,
} from '../services/dealEngineClient';

function cachedCoverageListingToScreened(area: CoverageArea, listing: any): ScreenedListing {
  return {
    id: listing.id ?? listing.address ?? null,
    formattedAddress: listing.address ?? null,
    city: area.search?.city ?? null,
    state: area.search?.state ?? null,
    zipCode: listing.zipCode ?? null,
    latitude: listing.latitude ?? null,
    longitude: listing.longitude ?? null,
    propertyType: listing.propertyType ?? null,
    bedrooms: listing.bedrooms ?? null,
    bathrooms: listing.bathrooms ?? null,
    squareFootage: listing.squareFootage ?? null,
    yearBuilt: listing.yearBuilt ?? null,
    price: listing.price ?? null,
    daysOnMarket: listing.daysOnMarket ?? null,
    pricePerSqft: null,
    screen: listing.screen ?? {
      score: 0,
      passes: false,
      failReasons: [],
      dataMissing: true,
      valuationEdgePct: null,
      estRent: null,
      estPiti: null,
      estMonthlyCashFlow: null,
      grossYieldPct: null,
      priceToRent: null,
      domSignal: null,
      zipMedianPricePerSqft: null,
      zipMedianRent: null,
      zipGrossYieldPct: null,
    },
  };
}

export const DealFinderPage: React.FC = () => {
  const [screenerResult, setScreenerResult] = useState<ScreenerResponse | null>(null);
  const [screenerLoading, setScreenerLoading] = useState(false);
  const [screenerError, setScreenerError] = useState<string | null>(null);
  const [underwriting, setUnderwriting] = useState(false);
  const [reports, setReports] = useState<Record<string, DealReportData>>({});
  const [openReport, setOpenReport] = useState<DealReportData | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [coverage, setCoverage] = useState<CoverageArea[]>([]);
  const [showCoverage, setShowCoverage] = useState(true);
  const [flags, setFlags] = useState<PropertyFlag[]>([]);
  const [centerQuery, setCenterQuery] = useState<string | null>(null);
  const [lastCriteria, setLastCriteria] = useState<ScreenerCriteria | null>(null);

  const refreshCoverageAndFlags = useCallback(async () => {
    try {
      const [coverageResp, flagsResp] = await Promise.all([
        dealEngine.listCoverage(),
        dealEngine.listFlags(),
      ]);
      setCoverage(coverageResp.coverage);
      setFlags(flagsResp.flags);
    } catch (err) {
      console.warn('[DealFinder] Coverage/flags load failed:', err);
    }
  }, []);

  useEffect(() => {
    refreshCoverageAndFlags();
  }, [refreshCoverageAndFlags]);

  const mapListings = useMemo(() => {
    const byAddress = new Map<string, ScreenedListing>();
    coverage.forEach((area) => {
      (area.topListings || []).forEach((listing) => {
        const normalized = cachedCoverageListingToScreened(area, listing);
        if (normalized.formattedAddress) byAddress.set(normalized.formattedAddress, normalized);
      });
    });
    (screenerResult?.listings || []).forEach((listing) => {
      if (listing.formattedAddress) byAddress.set(listing.formattedAddress, listing);
    });
    return Array.from(byAddress.values());
  }, [coverage, screenerResult]);

  const handleSearch = useCallback(async (criteria: ScreenerCriteria) => {
    setScreenerLoading(true);
    setScreenerError(null);
    setSelectedAddress(null);
    setLastCriteria(criteria);
    setCenterQuery(criteria.city && criteria.state ? `${criteria.city}, ${criteria.state}` : (criteria.zipCode || null));
    try {
      const result = await dealEngine.screenerSearch(criteria);
      setScreenerResult(result);
      refreshCoverageAndFlags();
    } catch (err: any) {
      setScreenerError(err?.message || 'Search failed');
      setScreenerResult(null);
    } finally {
      setScreenerLoading(false);
    }
  }, [refreshCoverageAndFlags]);

  const handleUnderwrite = useCallback(async (listings: ScreenedListing[]) => {
    setUnderwriting(true);
    try {
      const result = await dealEngine.underwrite(listings, {
        maxCount: 15,
        assumptions: lastCriteria?.assumptions,
        buyBox: lastCriteria?.buyBox,
      });
      setReports((prev) => {
        const next = { ...prev };
        result.reports.forEach((r) => {
          if (r?.address) next[r.address] = r;
        });
        return next;
      });
    } catch (err: any) {
      alert(`Underwrite failed: ${err?.message || err}`);
    } finally {
      setUnderwriting(false);
    }
  }, [lastCriteria]);

  const handleListingClick = useCallback((listing: ScreenedListing) => {
    const address = listing.formattedAddress;
    setSelectedAddress(address);
    if (address && reports[address]) {
      setOpenReport(reports[address]);
      return;
    }
    // Not yet underwritten — underwrite this single listing on demand
    if (address) {
      setUnderwriting(true);
      dealEngine.underwrite([listing], {
        maxCount: 1,
        assumptions: lastCriteria?.assumptions,
        buyBox: lastCriteria?.buyBox,
      })
        .then((result) => {
          const report = result.reports[0];
          if (report) {
            setReports((prev) => ({ ...prev, [report.address]: report }));
            setOpenReport(report);
          } else {
            alert(`Could not underwrite ${address}: ${result.errors?.[0]?.error || 'no data'}`);
          }
        })
        .catch((err) => alert(`Underwrite failed: ${err?.message || err}`))
        .finally(() => setUnderwriting(false));
    }
  }, [reports, lastCriteria]);

  const handleCoverageClick = useCallback(async (area: CoverageArea) => {
    try {
      const { area: full } = await dealEngine.getCoverage(area.key);
      if (!full) return;
      setLastCriteria(full.criteria ?? null);
      if (full.cachedReports && typeof full.cachedReports === 'object') {
        setReports((prev) => ({ ...prev, ...full.cachedReports }));
      }
      // Re-display cached listings instantly (no API spend)
      setScreenerResult({
        ok: true,
        search: full.search,
        fromCache: true,
        mortgageRate: full.criteria?.assumptions?.interestRate ?? 0,
        assumptions: full.criteria?.assumptions ?? undefined,
        funnel: full.funnel,
        buyBox: full.criteria?.buyBox ?? {},
        listings: (full.topListings || []).map((l: any) => ({
          id: l.id,
          formattedAddress: l.address,
          city: null,
          state: null,
          zipCode: l.zipCode,
          latitude: l.latitude,
          longitude: l.longitude,
          propertyType: l.propertyType,
          bedrooms: l.bedrooms,
          bathrooms: l.bathrooms,
          squareFootage: l.squareFootage,
          yearBuilt: l.yearBuilt,
          price: l.price,
          daysOnMarket: l.daysOnMarket,
          pricePerSqft: null,
          screen: l.screen ?? { score: 0, passes: false, failReasons: [], dataMissing: true },
        })),
      } as ScreenerResponse);
      setPanelOpen(true);
      if (area.ageDays >= 1) {
        console.log(`[DealFinder] Coverage area is ${Math.round(area.ageDays)}d old — re-screen for fresh data.`);
      }
    } catch (err) {
      console.warn('[DealFinder] Coverage load failed:', err);
    }
  }, []);

  const handleToggleFlag = useCallback(async (report: DealReportData, flagged: boolean) => {
    try {
      await dealEngine.setFlag({
        address: report.address,
        latitude: report.subject?.latitude ?? null,
        longitude: report.subject?.longitude ?? null,
        price: report.valuation?.listPrice ?? report.valuation?.fairValue ?? null,
        dealScore: report.dealScore?.score ?? null,
        flagged,
      });
      refreshCoverageAndFlags();
    } catch (err) {
      console.warn('[DealFinder] Flag failed:', err);
    }
  }, [refreshCoverageAndFlags]);

  return (
    <div className="relative flex h-screen w-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-lg">🏘️</span>
          <div>
            <div className="text-sm font-bold text-slate-900 leading-tight">Deal Finder</div>
            <div className="text-[10px] text-slate-500 leading-tight">BRRRR & buy-and-hold screener</div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setPanelOpen(!panelOpen)}
          className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          {panelOpen ? '◀ Hide Screener' : '▶ Screener'}
        </button>

        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showCoverage} onChange={(e) => setShowCoverage(e.target.checked)} />
          Searched areas
          {coverage.length > 0 && <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold">{coverage.length}</span>}
        </label>

        {screenerError && <span className="text-xs text-rose-600">{screenerError}</span>}
        {underwriting && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-blue-600">
            <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Underwriting…
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {flags.length > 0 && (
            <span className="text-xs text-slate-500">⭐ {flags.length} flagged</span>
          )}
          <button
            type="button"
            onClick={() => setAnalyzeOpen(true)}
            className="rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-xs font-bold text-white shadow hover:from-blue-700 hover:to-indigo-700"
          >
            🔍 Analyze a Property
          </button>
        </div>
      </div>

      {/* Body: panel + map */}
      <div className="relative flex flex-1 overflow-hidden">
        {panelOpen && (
          <div className="z-10 w-[380px] shrink-0 border-r bg-white shadow-lg">
            <ScreenerPanel
              result={screenerResult}
              loading={screenerLoading}
              error={screenerError}
              underwriting={underwriting}
              underwrittenAddresses={new Set(Object.keys(reports))}
              dealScores={Object.fromEntries(Object.entries(reports).map(([addr, r]) => [addr, { score: r.dealScore.score, grade: r.dealScore.grade }]))}
              onSearch={handleSearch}
              onUnderwrite={handleUnderwrite}
              onListingClick={handleListingClick}
              selectedAddress={selectedAddress}
            />
          </div>
        )}

        <div className="flex-1 p-2">
          <DealFinderMap
            listings={mapListings}
            coverage={coverage}
            flags={flags}
            showCoverage={showCoverage}
            selectedAddress={selectedAddress}
            centerQuery={centerQuery}
            onListingClick={handleListingClick}
            onCoverageClick={handleCoverageClick}
          />
        </div>

        {/* Deal Report drawer */}
        {openReport && (
          <div className="absolute inset-y-0 right-0 z-20 w-full max-w-3xl border-l bg-white shadow-2xl">
            <DealReport
              report={openReport}
              onClose={() => setOpenReport(null)}
              isFlagged={flags.some((f) => f.address === openReport.address)}
              onToggleFlag={handleToggleFlag}
            />
          </div>
        )}
      </div>

      {/* Individual analysis modal */}
      <AnalyzePropertyModal
        isOpen={analyzeOpen}
        onClose={() => setAnalyzeOpen(false)}
        onComplete={(report) => {
          setAnalyzeOpen(false);
          setReports((prev) => ({ ...prev, [report.address]: report }));
          setOpenReport(report);
        }}
      />
    </div>
  );
};

export default DealFinderPage;
