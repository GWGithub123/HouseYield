import React, { useMemo } from 'react';

interface ZipMarketBreakdownItem {
  label: string;
  median: number | null;
  totalListings: number | null;
}

interface ZipMarketEntry {
  zipCode: string;
  label?: string;
  derived?: {
    medianSalePrice?: number | null;
    medianAskingRent?: number | null;
    grossYieldPct?: number | null;
    priceToRentRatio?: number | null;
    rentalListings?: number | null;
    saleListings?: number | null;
  };
  saleData?: {
    medianDaysOnMarket?: number | null;
    byPropertyType?: ZipMarketBreakdownItem[];
    byBedrooms?: ZipMarketBreakdownItem[];
  };
  rentalData?: {
    medianDaysOnMarket?: number | null;
    byPropertyType?: ZipMarketBreakdownItem[];
    byBedrooms?: ZipMarketBreakdownItem[];
  };
}

interface ZipMarketDrilldownProps {
  title: string;
  description: string;
  markets: ZipMarketEntry[];
  selectedZipCode: string | null;
  onSelectZip: (zipCode: string) => void;
  loading?: boolean;
  error?: string | null;
  emptyState?: string;
}

function formatCurrency(value: number | null | undefined) {
  if (!Number.isFinite(value ?? null)) return 'N/A';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(value as number);
}

function formatNumber(value: number | null | undefined, suffix = '') {
  if (!Number.isFinite(value ?? null)) return 'N/A';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value as number)}${suffix}`;
}

function formatDecimal(value: number | null | undefined, suffix = '') {
  if (!Number.isFinite(value ?? null)) return 'N/A';
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value as number)}${suffix}`;
}

function BreakdownBars({
  title,
  items,
  currency
}: {
  title: string;
  items: ZipMarketBreakdownItem[];
  currency: boolean;
}) {
  const validItems = items.filter((item) => Number.isFinite(item.median ?? null)).slice(0, 5);
  const maxValue = Math.max(...validItems.map((item) => item.median || 0), 0);

  if (!validItems.length) {
    return null;
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
      <h5 className="text-sm font-semibold text-slate-900 mb-3">{title}</h5>
      <div className="space-y-3">
        {validItems.map((item) => {
          const value = item.median || 0;
          const width = maxValue > 0 ? Math.max((value / maxValue) * 100, 8) : 8;
          return (
            <div key={item.label}>
              <div className="flex items-center justify-between gap-3 text-xs mb-1">
                <span className="font-medium text-slate-700">{item.label}</span>
                <span className="text-slate-500">
                  {currency ? formatCurrency(item.median) : formatNumber(item.median)}
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-blue-500"
                  style={{ width: `${width}%` }}
                />
              </div>
              {Number.isFinite(item.totalListings ?? null) && (
                <div className="text-[11px] text-slate-400 mt-1">{formatNumber(item.totalListings)} active listings</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ZipMarketDrilldown: React.FC<ZipMarketDrilldownProps> = ({
  title,
  description,
  markets,
  selectedZipCode,
  onSelectZip,
  loading = false,
  error = null,
  emptyState = 'ZIP market drilldown is not available for this metro yet.'
}) => {
  const selectedMarket = useMemo(() => {
    if (!markets.length) return null;
    return markets.find((market) => market.zipCode === selectedZipCode) || markets[0];
  }, [markets, selectedZipCode]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h4 className="text-lg font-semibold text-slate-900">{title}</h4>
          <p className="text-sm text-slate-500 mt-1">{description}</p>
        </div>
        {markets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {markets.map((market) => {
              const isSelected = market.zipCode === selectedMarket?.zipCode;
              return (
                <button
                  key={market.zipCode}
                  onClick={() => onSelectZip(market.zipCode)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isSelected
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white border border-slate-200 text-slate-700 hover:bg-emerald-50 hover:text-emerald-700'
                  }`}
                >
                  {market.zipCode}
                  {market.label ? ` · ${market.label}` : ''}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {loading && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-slate-500">
          Loading ZIP market drilldown...
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!loading && !error && !selectedMarket && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-sm text-slate-500">
          {emptyState}
        </div>
      )}

      {!loading && !error && selectedMarket && (
        <div className="space-y-4">
          <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xl font-bold text-slate-900">ZIP {selectedMarket.zipCode}</div>
              {selectedMarket.label && <div className="text-sm text-slate-500">{selectedMarket.label}</div>}
            </div>
            <div className="text-xs text-slate-500">
              RentCast ZIP market aggregates layered into metro analysis
            </div>
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Median Asking Rent</div>
              <div className="text-lg font-bold text-slate-900">{formatCurrency(selectedMarket.derived?.medianAskingRent)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Median Sale Price</div>
              <div className="text-lg font-bold text-slate-900">{formatCurrency(selectedMarket.derived?.medianSalePrice)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Gross Yield Proxy</div>
              <div className="text-lg font-bold text-slate-900">{formatDecimal(selectedMarket.derived?.grossYieldPct, '%')}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Price To Rent</div>
              <div className="text-lg font-bold text-slate-900">{formatDecimal(selectedMarket.derived?.priceToRentRatio, 'x')}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Rental Median DOM</div>
              <div className="text-lg font-bold text-slate-900">{formatNumber(selectedMarket.rentalData?.medianDaysOnMarket, ' days')}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Sale Median DOM</div>
              <div className="text-lg font-bold text-slate-900">{formatNumber(selectedMarket.saleData?.medianDaysOnMarket, ' days')}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Rental Listings</div>
              <div className="text-lg font-bold text-slate-900">{formatNumber(selectedMarket.derived?.rentalListings)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500 mb-1">Sale Listings</div>
              <div className="text-lg font-bold text-slate-900">{formatNumber(selectedMarket.derived?.saleListings)}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <BreakdownBars
              title="Rent By Property Type"
              items={selectedMarket.rentalData?.byPropertyType || []}
              currency={true}
            />
            <BreakdownBars
              title="Sale Price By Property Type"
              items={selectedMarket.saleData?.byPropertyType || []}
              currency={true}
            />
            <BreakdownBars
              title="Rent By Bedroom Count"
              items={selectedMarket.rentalData?.byBedrooms || []}
              currency={true}
            />
            <BreakdownBars
              title="Sale Price By Bedroom Count"
              items={selectedMarket.saleData?.byBedrooms || []}
              currency={true}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ZipMarketDrilldown;