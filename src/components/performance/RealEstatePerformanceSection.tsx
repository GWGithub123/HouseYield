import { useMemo, useState } from 'react';
import RentalPricingPowerGraph from '../RentalPricingPowerGraph';
import PropertyAnalyticsMetricSurface, { type PropertyAnalyticsSurfaceFinancialInputs } from '../property/PropertyAnalyticsMetricSurface';
import type { CanonicalOwnerPropertyRecord } from '../../services/canonicalPortfolioService';

type RealEstatePerformanceSectionProps = {
  properties: CanonicalOwnerPropertyRecord[];
  userId?: string;
  sectionCardClassName: string;
  selectedPropertyId: string | null;
  onSelectProperty: (id: string) => void;
};

function extractZip(address: string | undefined): string | undefined {
  return address?.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || undefined;
}

function deriveSurfaceFinancialInputs(property: CanonicalOwnerPropertyRecord): PropertyAnalyticsSurfaceFinancialInputs | null {
  const propertyData = property.propertyData || property.property_data;
  const summary = propertyData?.summary || null;
  const financials = property.financials || null;
  const avm = Number(summary?.avm_value) || Number(property.derived?.currentValue) || 0;

  if (avm === 0) {
    return null;
  }

  const taxHistory = Array.isArray(propertyData?.tax_history) ? propertyData.tax_history : [];
  const latestTaxRecord = [...taxHistory].sort((left, right) => Number(right?.year || 0) - Number(left?.year || 0))[0];
  const taxAmount = Number(latestTaxRecord?.tax_amount) || Number(financials?.propertyTax) * 12 || 0;

  return {
    avm,
    taxAmount,
    monthlyRent: Number(financials?.monthlyRent) || Number(summary?.rental_avm) || 0,
    otherIncome: Number(financials?.otherIncome) || 0,
    vacancyRate: Number(financials?.vacancyRate ?? 5),
    rentGrowth: Number((financials as Record<string, unknown> | null)?.rentGrowth ?? 3),
    insurance: Number(financials?.insurance) || 0,
    utilities: Number(financials?.utilities) || 0,
    hoa: Number(financials?.hoa) || 0,
    repairsCapEx: Number(financials?.repairsCapEx) || 0,
    managementPct: Number(financials?.managementPct ?? 8),
    expenseInflation: Number((financials as Record<string, unknown> | null)?.expenseInflation ?? 3),
    taxGrowth: Number((financials as Record<string, unknown> | null)?.taxInflation ?? 3),
    interestRate: Number(financials?.interestRate) || 0,
    loanTerm: Number((financials as Record<string, unknown> | null)?.loanTerm) || 360,
    isInterestOnly: Boolean((financials as Record<string, unknown> | null)?.isInterestOnly),
    downPayment: Number(financials?.downPayment) || 0,
    closingCosts: Number((financials as Record<string, unknown> | null)?.closingCosts) || 0,
    initialRehab: Number((financials as Record<string, unknown> | null)?.initialRehab) || 0,
    appreciationRate: Number((financials as Record<string, unknown> | null)?.appreciationRate ?? 3),
    originalLoanAmount: Number(financials?.loanAmount) || undefined,
    currentLoanBalance: Number(financials?.currentLoanBalance) || undefined,
    monthlyDebtService: Number(financials?.monthlyDebtService) || undefined,
  };
}

/**
 * Dedicated real-estate performance comparisons for the Performance tab.
 * Real estate is benchmarked against its own market context instead of stock
 * indices: rental pricing power (RentCast regional mean vs actual rent) and
 * price history (property AVM vs area mean AVM).
 */
export function RealEstatePerformanceSection({
  properties,
  userId,
  sectionCardClassName,
  selectedPropertyId,
  onSelectProperty,
}: RealEstatePerformanceSectionProps) {
  const [pricingProjectionMode, setPricingProjectionMode] = useState<'none' | 'market' | 'recommended' | 'custom'>('none');

  const eligibleProperties = useMemo(
    () => properties.filter((property) => Boolean(property?.id && (property.address || property.propertyData?.summary?.address))),
    [properties],
  );

  const activeProperty = useMemo(() => {
    if (eligibleProperties.length === 0) return null;
    return eligibleProperties.find((property) => property.id === selectedPropertyId) ?? eligibleProperties[0];
  }, [eligibleProperties, selectedPropertyId]);

  const financialInputs = useMemo(
    () => (activeProperty ? deriveSurfaceFinancialInputs(activeProperty) : null),
    [activeProperty],
  );

  if (!activeProperty) {
    return null;
  }

  const propertyData = activeProperty.propertyData || null;
  const summary = propertyData?.summary || null;
  const address = summary?.address || activeProperty.address || activeProperty.id;
  const zipCode = extractZip(address);
  const monthlyRent = Number(activeProperty.financials?.monthlyRent) || Number(summary?.rental_avm) || undefined;
  const monthlyExpenses = Number(activeProperty.financials?.monthlyExpenses) || undefined;
  const monthlyMortgage = Number(activeProperty.financials?.monthlyDebtService)
    || Number(activeProperty.financials?.monthlyMortgage)
    || undefined;

  return (
    <div className={`${sectionCardClassName} mt-6 p-5 sm:p-6`} data-voice-id="real-estate-performance-section">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="h-5 w-1 rounded-full bg-gradient-to-b from-amber-500 via-orange-500 to-rose-500" />
          <div>
            <h2 className="text-base font-semibold tracking-tight text-slate-900">Real Estate Performance</h2>
            <p className="text-xs text-slate-500">
              Benchmarked against its own market — rent vs regional comps and value vs area AVM — instead of stock indices.
            </p>
          </div>
        </div>

        {eligibleProperties.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {eligibleProperties.map((property) => {
              const label = (property.propertyData?.summary?.address || property.address || property.id).split(',')[0];
              const isActive = property.id === activeProperty.id;
              return (
                <button
                  key={property.id}
                  onClick={() => onSelectProperty(property.id)}
                  title={property.address}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                    isActive
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'border border-slate-200 bg-white/80 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
        {/* Rental pricing power: RentCast regional mean vs actual rent */}
        <div className="min-w-0">
          <RentalPricingPowerGraph
            key={`pricing-${activeProperty.id}`}
            propertyId={address}
            currentRent={monthlyRent}
            bedrooms={Number(summary?.beds) || undefined}
            bathrooms={Number(summary?.baths) || undefined}
            squareFeet={Number(summary?.living_sqft) || undefined}
            zipCode={zipCode}
            userId={userId}
            cachePropertyId={activeProperty.id || address}
            latitude={Number(summary?.latitude) || undefined}
            longitude={Number(summary?.longitude) || undefined}
            propertyType={summary?.property_type || undefined}
            yearBuilt={Number(summary?.year_built) || undefined}
            attomRentAvm={Number(summary?.rental_avm) || undefined}
            attomRentLow={Number(summary?.rental_avm_low) || undefined}
            attomRentHigh={Number(summary?.rental_avm_high) || undefined}
            monthlyExpenses={monthlyExpenses}
            monthlyMortgage={monthlyMortgage}
            vacancyRate={Number(activeProperty.financials?.vacancyRate) || undefined}
            pricingProjectionMode={pricingProjectionMode}
            onPricingProjectionModeChange={setPricingProjectionMode}
          />
        </div>

        {/* Price history: property AVM vs area mean AVM */}
        <div className="min-w-0">
          <PropertyAnalyticsMetricSurface
            key={`price-history-${activeProperty.id}`}
            metric="priceHistory"
            propertyDashboard={propertyData}
            financialInputs={financialInputs}
            scopeLabel={address}
            showScopeHeader={false}
            dashboardCardMode
          />
        </div>
      </div>
    </div>
  );
}

export default RealEstatePerformanceSection;
