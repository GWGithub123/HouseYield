import type { AVMHistory, PropertyDashboard } from '../types/attom';
import type { CanonicalPropertyProfile } from '../types/renovationPipeline';
import { buildCanonicalPropertyProfile } from '../utils/canonicalPropertyProfile';
import type { OwnerPropertyApiRecord } from './ownerPropertiesClient';
import type { Asset, Liability } from './portfolioService';
import type { RealEstateHolding } from './realEstatePerformanceService';

type GenericRecord = Record<string, unknown>;

export interface CanonicalPropertyDerivedMetrics {
  currentValue: number;
  mortgageBalance: number;
  equity: number;
  monthlyRent: number;
  monthlyOtherIncome: number;
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyMortgage: number;
  monthlyCashFlow: number;
  annualPropertyTax: number;
  annualInsurance: number;
  annualHoa: number;
  annualOperatingReserve: number;
}

export interface CanonicalOwnerPropertyRecord extends OwnerPropertyApiRecord {
  financials: GenericRecord & {
    monthlyRent: number;
    otherIncome: number;
    propertyTax: number;
    insurance: number;
    hoa: number;
    maintenance: number;
    utilities: number;
    repairsCapEx: number;
    managementPct: number;
    vacancyRate: number;
    monthlyExpenses: number;
    monthlyMortgage: number;
    monthlyDebtService: number;
    purchasePrice: number;
    purchaseDate: string;
    interestRate: number;
    loanAmount: number;
    currentLoanBalance: number;
    downPayment: number;
  };
  propertyData: PropertyDashboard;
  property_data: PropertyDashboard;
  tenants: Array<Record<string, unknown>>;
  tenantCount: number;
  canonicalPropertyProfile: CanonicalPropertyProfile;
  derived: CanonicalPropertyDerivedMetrics;
}

export interface CanonicalPortfolioProjection {
  ownerProperties: CanonicalOwnerPropertyRecord[];
  realEstateAssets: Asset[];
  liabilities: Liability[];
  realEstateHoldings: RealEstateHolding[];
  matchedManualRealEstateIds: string[];
}

function sanitizeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/[$,%\s,]/g, '').trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function pickNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = sanitizeNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return 0;
}

function pickOptionalNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = sanitizeNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function normalizeAddressKey(address: unknown): string {
  return String(address || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeDashboard(property: OwnerPropertyApiRecord): PropertyDashboard {
  const raw = (property.property_data || property.propertyData || {}) as Partial<PropertyDashboard>;
  const summary = (raw.summary || {}) as PropertyDashboard['summary'];

  return {
    summary: {
      ...summary,
      address: summary.address || property.address || '',
    },
    tax_history: Array.isArray(raw.tax_history) ? raw.tax_history : [],
    tax_meta: raw.tax_meta || { count: Array.isArray(raw.tax_history) ? raw.tax_history.length : 0 },
    avm_history: Array.isArray(raw.avm_history) ? raw.avm_history : [],
    environmental: raw.environmental,
    building_permits: raw.building_permits,
    schools: raw.schools,
    school_district: raw.school_district,
    community: raw.community,
    parcel_geometry: raw.parcel_geometry,
    transportation_noise: raw.transportation_noise,
    location: raw.location,
    components: raw.components,
    raw: raw.raw,
  };
}

function getTenants(property: OwnerPropertyApiRecord): Array<Record<string, unknown>> {
  if (Array.isArray(property.tenants)) {
    return property.tenants;
  }

  if (property.tenant && typeof property.tenant === 'object') {
    return [property.tenant];
  }

  return [];
}

function buildManualRealEstateHolding(asset: Asset, liabilities: Liability[]): RealEstateHolding {
  const matchingLiability = liabilities.find((liability) => liability.type === 'mortgage' && liability.linkedAssetId === asset.id);
  const currentValue = asset.value || 0;
  const loanAmount = matchingLiability?.balance || 0;

  return {
    id: asset.id,
    address: asset.name || 'Property',
    purchasePrice: currentValue,
    purchaseDate: (asset as unknown as { createdAt?: string }).createdAt || new Date().toISOString(),
    currentValue,
    downPayment: currentValue - loanAmount > 0 ? currentValue - loanAmount : currentValue * 0.2,
    loanAmount,
    interestRate: matchingLiability?.interestRate || 7,
    monthlyRent: 0,
    monthlyExpenses: 0,
    monthlyPayment: matchingLiability?.monthlyPayment,
    avmHistory: [],
  };
}

export function normalizeOwnerPropertiesForCanonicalPortfolio(
  ownerProperties: OwnerPropertyApiRecord[],
): CanonicalOwnerPropertyRecord[] {
  return ownerProperties.map((property) => {
    const propertyData = normalizeDashboard(property);
    const financials = ((property.financials || {}) as GenericRecord);
    const summary = (propertyData.summary || {}) as GenericRecord;
    const mortgage = ((summary.mortgage || {}) as GenericRecord);
    const taxHistory = Array.isArray(propertyData.tax_history) ? propertyData.tax_history : [];
    const latestTax = taxHistory[0] as unknown as GenericRecord | undefined;
    const tenants = getTenants(property);

    const tenantMonthlyRent = tenants.reduce((sum, tenant) => {
      const rent = pickNumber((tenant as GenericRecord).monthlyRent, (tenant as GenericRecord).rent);
      return sum + rent;
    }, 0);

    const monthlyRent = tenantMonthlyRent > 0
      ? tenantMonthlyRent
      : pickNumber(financials.monthlyRent, summary.rental_avm, summary.market_rent);
    const monthlyOtherIncome = pickNumber(financials.otherIncome);
    const monthlyIncome = monthlyRent + monthlyOtherIncome;

    const annualPropertyTax = pickNumber(
      financials.propertyTax,
      summary.tax_current,
      latestTax?.tax_amount,
      pickOptionalNumber((mortgage.payment_breakdown as GenericRecord | undefined)?.property_tax) !== null
        ? pickNumber((mortgage.payment_breakdown as GenericRecord | undefined)?.property_tax) * 12
        : null,
    );

    const currentValue = pickNumber(
      financials.currentValue,
      financials.marketValue,
      summary.avm_value,
      summary.market_value,
      summary.value,
      financials.purchasePrice,
    );

    // When owners only have tax on file, still surface a full carrying-cost mix
    // using conservative landlord defaults so the Overview donut is not taxes-only.
    const annualInsurance = pickNumber(
      financials.insurance,
      financials.annualInsurance,
      currentValue > 0 ? currentValue * 0.004 : null,
    );
    const annualHoa = pickNumber(financials.hoa, financials.annualHoa);
    const annualUtilities = pickNumber(financials.utilities, financials.annualUtilities);
    const annualRepairs = pickNumber(
      financials.repairsCapEx,
      financials.repairs,
      financials.annualRepairs,
      financials.capex,
      monthlyIncome > 0 ? monthlyIncome * 12 * 0.05 : null,
    );
    const managementPct = pickNumber(financials.managementPct);
    const vacancyRate = pickNumber(financials.vacancyRate);
    const monthlyManagement = monthlyIncome * (managementPct / 100);
    const monthlyVacancyReserve = monthlyIncome * (vacancyRate / 100);
    const monthlyOtherExpenses = pickNumber(
      financials.otherMonthlyExpenses,
      financials.monthlyMaintenance,
      financials.capexReserveMonthly,
    );

    const computedMonthlyExpenses =
      (annualPropertyTax / 12) +
      (annualInsurance / 12) +
      (annualHoa / 12) +
      (annualUtilities / 12) +
      (annualRepairs / 12) +
      monthlyManagement +
      monthlyVacancyReserve +
      monthlyOtherExpenses;
    const monthlyExpenses = pickNumber(financials.monthlyExpenses, computedMonthlyExpenses);
    const originalLoanAmount = pickNumber(financials.originalLoanAmount, mortgage.amount);
    const currentLoanBalance = pickNumber(
      financials.currentLoanBalance,
      financials.mortgageBalance,
      financials.loanAmount,
      originalLoanAmount,
    );
    const monthlyMortgage = pickNumber(
      financials.monthlyDebtService,
      financials.monthlyMortgage,
      financials.monthlyPayment,
      mortgage.estimated_monthly_payment_pi,
    );
    const purchasePrice = pickNumber(financials.purchasePrice, summary.last_sale_price, currentValue);
    const purchaseDate = pickString(
      financials.purchaseDate,
      financials.loanOriginationDate,
      mortgage.date,
      summary.last_sale_date,
      property.createdAt,
      property.updatedAt,
    ) || new Date().toISOString();
    const interestRate = pickNumber(financials.interestRate, mortgage.estimated_interest_rate);
    const downPayment = pickNumber(
      financials.downPayment,
      purchasePrice > 0 && originalLoanAmount > 0 ? purchasePrice - originalLoanAmount : null,
      currentValue > currentLoanBalance ? currentValue - currentLoanBalance : null,
      purchasePrice * 0.2,
    );

    const annualOperatingReserve = Math.max(
      (monthlyExpenses * 12) - annualPropertyTax - annualInsurance - annualHoa,
      0,
    );
    const equity = currentValue - currentLoanBalance;
    const monthlyCashFlow = monthlyIncome - monthlyExpenses - monthlyMortgage;
    const canonicalPropertyProfile = buildCanonicalPropertyProfile(propertyData);

    return {
      ...property,
      propertyData,
      property_data: propertyData,
      tenants,
      tenantCount: tenants.length,
      financials: {
        ...financials,
        monthlyRent,
        otherIncome: monthlyOtherIncome,
        propertyTax: annualPropertyTax,
        insurance: annualInsurance,
        hoa: annualHoa,
        maintenance: annualOperatingReserve,
        utilities: annualUtilities,
        repairsCapEx: annualRepairs,
        managementPct,
        vacancyRate,
        monthlyExpenses,
        monthlyMortgage,
        monthlyDebtService: monthlyMortgage,
        purchasePrice,
        purchaseDate,
        interestRate,
        loanAmount: currentLoanBalance,
        currentLoanBalance,
        downPayment,
      },
      canonicalPropertyProfile,
      derived: {
        currentValue,
        mortgageBalance: currentLoanBalance,
        equity,
        monthlyRent,
        monthlyOtherIncome,
        monthlyIncome,
        monthlyExpenses,
        monthlyMortgage,
        monthlyCashFlow,
        annualPropertyTax,
        annualInsurance,
        annualHoa,
        annualOperatingReserve,
      },
    };
  });
}

export function buildCanonicalPortfolioProjection({
  ownerProperties,
  manualRealEstateAssets,
  manualLiabilities,
}: {
  ownerProperties: OwnerPropertyApiRecord[];
  manualRealEstateAssets: Asset[];
  manualLiabilities: Liability[];
}): CanonicalPortfolioProjection {
  const normalizedProperties = normalizeOwnerPropertiesForCanonicalPortfolio(ownerProperties);
  const canonicalPropertiesWithValue = normalizedProperties.filter((property) => property.derived.currentValue > 0);
  const canonicalAddressKeys = new Set(
    canonicalPropertiesWithValue.map((property) => normalizeAddressKey(property.address || property.propertyData.summary?.address || property.id)),
  );

  const matchedManualRealEstateIds = manualRealEstateAssets
    .filter((asset) => canonicalAddressKeys.has(normalizeAddressKey(asset.name)) || canonicalPropertiesWithValue.some((property) => property.id === asset.id))
    .map((asset) => asset.id);
  const matchedManualRealEstateIdSet = new Set(matchedManualRealEstateIds);

  const unmatchedManualRealEstateAssets = manualRealEstateAssets.filter((asset) => !matchedManualRealEstateIdSet.has(asset.id));
  const unmatchedManualLiabilities = manualLiabilities.filter((liability) => {
    if (liability.type !== 'mortgage' || !liability.linkedAssetId) {
      return true;
    }

    return !matchedManualRealEstateIdSet.has(liability.linkedAssetId);
  });

  const canonicalRealEstateAssets: Asset[] = canonicalPropertiesWithValue.map((property) => ({
    id: property.id,
    name: property.address || property.propertyData.summary?.address || property.id,
    type: 'realEstate',
    value: property.derived.currentValue,
    createdAt: property.createdAt || property.updatedAt || new Date().toISOString(),
    updatedAt: property.updatedAt || property.createdAt || new Date().toISOString(),
  }));

  const canonicalLiabilities: Liability[] = canonicalPropertiesWithValue
    .filter((property) => property.derived.mortgageBalance > 0)
    .map((property) => ({
      id: `canonical-mortgage-${property.id}`,
      name: `Mortgage - ${property.address || property.propertyData.summary?.address || property.id}`,
      type: 'mortgage',
      balance: property.derived.mortgageBalance,
      originalAmount: pickNumber((property.financials as GenericRecord).originalLoanAmount, property.derived.mortgageBalance),
      interestRate: property.financials.interestRate,
      monthlyPayment: property.financials.monthlyMortgage,
      linkedAssetId: property.id,
      lenderName: pickString(((property.propertyData.summary as GenericRecord).mortgage as GenericRecord | undefined)?.lender_name) || undefined,
      createdAt: property.createdAt || property.updatedAt || new Date().toISOString(),
      updatedAt: property.updatedAt || property.createdAt || new Date().toISOString(),
    }));

  const canonicalHoldings: RealEstateHolding[] = canonicalPropertiesWithValue.map((property) => ({
    id: property.id,
    address: property.address || property.propertyData.summary?.address || property.id,
    purchasePrice: property.financials.purchasePrice,
    purchaseDate: property.financials.purchaseDate,
    currentValue: property.derived.currentValue,
    downPayment: property.financials.downPayment,
    loanAmount: property.derived.mortgageBalance,
    originalLoanAmount: pickOptionalNumber((property.financials as GenericRecord).originalLoanAmount) || undefined,
    interestRate: property.financials.interestRate,
    monthlyRent: property.derived.monthlyIncome,
    monthlyExpenses: property.derived.monthlyExpenses,
    monthlyPayment: property.derived.monthlyMortgage,
    avmHistory: (property.propertyData.avm_history || []) as AVMHistory[],
  }));

  const manualHoldings = unmatchedManualRealEstateAssets.map((asset) => buildManualRealEstateHolding(asset, unmatchedManualLiabilities));

  return {
    ownerProperties: normalizedProperties,
    realEstateAssets: [...canonicalRealEstateAssets, ...unmatchedManualRealEstateAssets],
    liabilities: [...canonicalLiabilities, ...unmatchedManualLiabilities],
    realEstateHoldings: [...canonicalHoldings, ...manualHoldings],
    matchedManualRealEstateIds,
  };
}

export type PropertyPortfolioTab = 'overview' | 'personal' | 'investment' | 'combined';
export type PropertyPortfolioUsage = 'personal' | 'investment';
export type PropertyPortfolioHistoryGranularity = 'quarterly' | 'annual';

export interface PropertyPortfolioTrendPoint {
  periodKey: string;
  label: string;
  date: string;
  value: number;
  /** Estimated equity using period value minus current loan balance (debt held constant). */
  equity: number;
  /** Area-mean / comps aggregate, scaled to portfolio size when some holdings lack comps. */
  marketValue: number | null;
}

export interface PropertyPortfolioAllocationItem {
  id: string;
  label: string;
  address: string;
  usage: PropertyPortfolioUsage;
  color: string;
  value: number;
  equity: number;
  mortgageBalance: number;
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyMortgage: number;
  monthlyCashFlow: number;
  percentage: number;
}

export interface PropertyPortfolioExpenseBreakdown {
  taxes: number;
  insurance: number;
  hoa: number;
  utilities: number;
  repairs: number;
  management: number;
  vacancy: number;
  other: number;
  debtService: number;
}

export interface PropertyPortfolioSummary {
  count: number;
  totalValue: number;
  totalEquity: number;
  totalMortgageBalance: number;
  monthlyRent: number;
  monthlyOtherIncome: number;
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyMortgage: number;
  monthlyCashFlow: number;
  annualGrossIncome: number;
  annualOperatingExpenses: number;
  annualDebtService: number;
  annualNetCashFlow: number;
  grossYield: number;
  netYield: number;
  capRate: number;
  avgPricePerSqft: number;
  ltv: number;
  equityRatio: number;
  expenseRatio: number;
  cashFlowMargin: number;
  avgInterestRate: number;
  estimatedRefinanceHeadroom75Ltv: number;
  estimatedHelocHeadroom85Cltv: number;
}

export interface PropertyPortfolioOverview {
  tab: PropertyPortfolioTab;
  usageFilter: PropertyPortfolioUsage | 'all';
  properties: CanonicalOwnerPropertyRecord[];
  summary: PropertyPortfolioSummary;
  expenseBreakdown: PropertyPortfolioExpenseBreakdown;
  valueTrendQuarterly: PropertyPortfolioTrendPoint[];
  valueTrendAnnual: PropertyPortfolioTrendPoint[];
  allocations: PropertyPortfolioAllocationItem[];
}

function normalizeLookupText(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function inferPropertyUsage(property: CanonicalOwnerPropertyRecord): PropertyPortfolioUsage {
  const summary = (property.propertyData?.summary || {}) as GenericRecord;
  const financials = (property.financials || {}) as GenericRecord;
  const owner = (summary.owner || {}) as GenericRecord;
  const candidates = [
    financials.portfolioType,
    financials.propertyUse,
    financials.useType,
    financials.occupancyStatus,
    financials.occupancyType,
    financials.classification,
    financials.assetClass,
    owner.relationship_type,
    owner.absentee_status,
  ]
    .map((value) => normalizeLookupText(value))
    .filter(Boolean);

  if ((financials.isPrimaryResidence as boolean | undefined) === true || (financials.ownerOccupied as boolean | undefined) === true) {
    return 'personal';
  }

  if (Number(financials.personalUseDays || 0) > 14) {
    return 'personal';
  }

  if (candidates.some((value) => (
    value.includes('investment')
    || value.includes('rental')
    || value.includes('landlord')
    || value.includes('income')
    || value.includes('absentee')
  ))) {
    return 'investment';
  }

  if (candidates.some((value) => (
    value.includes('primary')
    || value.includes('personal')
    || value.includes('owner occupied')
    || value.includes('owner-occupied')
    || value.includes('homestead')
    || value.includes('second home')
    || value.includes('vacation')
  ))) {
    return 'personal';
  }

  if ((property.tenantCount || 0) > 0 || property.derived.monthlyIncome > 0 || property.derived.monthlyCashFlow !== 0) {
    return 'investment';
  }

  return 'personal';
}

function getUsageFilterForTab(tab: PropertyPortfolioTab): PropertyPortfolioUsage | 'all' {
  if (tab === 'personal') return 'personal';
  if (tab === 'investment') return 'investment';
  return 'all';
}

function buildPaletteColor(index: number) {
  const palette = ['#ec4899', '#f97316', '#8b5cf6', '#3b82f6', '#14b8a6', '#eab308', '#f43f5e', '#6366f1'];
  return palette[index % palette.length];
}

function getQuarterPeriodKey(date: Date) {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
}

function getAnnualPeriodKey(date: Date) {
  return `${date.getUTCFullYear()}`;
}

function formatPeriodLabel(periodKey: string, granularity: PropertyPortfolioHistoryGranularity) {
  if (granularity === 'annual') {
    return periodKey;
  }

  const [year, quarter] = periodKey.split('-');
  return `${quarter} '${year.slice(-2)}`;
}

function createStableDate(periodKey: string, granularity: PropertyPortfolioHistoryGranularity) {
  if (granularity === 'annual') {
    return `${periodKey}-12-31`;
  }

  const [yearPart, quarterPart] = periodKey.split('-Q');
  const quarter = Math.max(1, Math.min(4, Number(quarterPart) || 1));
  const month = String(quarter * 3).padStart(2, '0');
  return `${yearPart}-${month}-01`;
}

function buildPropertyTrend(
  properties: CanonicalOwnerPropertyRecord[],
  granularity: PropertyPortfolioHistoryGranularity,
): PropertyPortfolioTrendPoint[] {
  const propertyPeriodMaps = properties.map((property) => {
    const avmHistory = Array.isArray(property.propertyData?.avm_history) ? property.propertyData.avm_history : [];
    const comparableHistory = Array.isArray(property.propertyData?.avm_comparable_history)
      ? property.propertyData.avm_comparable_history
      : [];
    const periodValues = new Map<string, number>();
    const comparablePeriodValues = new Map<string, number>();

    avmHistory.forEach((entry) => {
      const rawDate = String(entry?.date || '');
      const parsedDate = new Date(rawDate);
      if (Number.isNaN(parsedDate.getTime())) {
        return;
      }

      const value = pickNumber(entry?.value, property.derived.currentValue);
      if (!(value > 0)) {
        return;
      }

      const key = granularity === 'annual' ? getAnnualPeriodKey(parsedDate) : getQuarterPeriodKey(parsedDate);
      periodValues.set(key, value);
    });

    comparableHistory.forEach((entry) => {
      const rawDate = String(entry?.date || '');
      const parsedDate = new Date(rawDate);
      if (Number.isNaN(parsedDate.getTime())) {
        return;
      }

      const value = pickNumber(entry?.value);
      if (!(value > 0)) {
        return;
      }

      const key = granularity === 'annual' ? getAnnualPeriodKey(parsedDate) : getQuarterPeriodKey(parsedDate);
      comparablePeriodValues.set(key, value);
    });

    if (periodValues.size === 0 && property.derived.currentValue > 0) {
      const fallbackDate = new Date(property.updatedAt || property.createdAt || Date.now());
      const key = granularity === 'annual' ? getAnnualPeriodKey(fallbackDate) : getQuarterPeriodKey(fallbackDate);
      periodValues.set(key, property.derived.currentValue);
    }

    return {
      property,
      periodValues,
      comparablePeriodValues,
      loanBalance: Math.max(property.derived.mortgageBalance || 0, 0),
    };
  });

  const allPeriodKeys = Array.from(new Set(
    propertyPeriodMaps.flatMap(({ periodValues, comparablePeriodValues }) => [
      ...Array.from(periodValues.keys()),
      ...Array.from(comparablePeriodValues.keys()),
    ]),
  )).sort();

  if (allPeriodKeys.length === 0) {
    return [];
  }

  const latestPeriodKey = allPeriodKeys[allPeriodKeys.length - 1];
  propertyPeriodMaps.forEach(({ property, periodValues }) => {
    if (!periodValues.has(latestPeriodKey) && property.derived.currentValue > 0) {
      periodValues.set(latestPeriodKey, property.derived.currentValue);
    }
  });

  return allPeriodKeys.map((periodKey) => {
    let total = 0;
    let equityTotal = 0;
    let marketPartial = 0;
    let subjectWithComps = 0;

    propertyPeriodMaps.forEach(({ property, periodValues, comparablePeriodValues, loanBalance }) => {
      const orderedKeys = Array.from(periodValues.keys()).sort();
      let lastValue = 0;
      orderedKeys.forEach((key) => {
        if (key <= periodKey) {
          lastValue = periodValues.get(key) || lastValue;
        }
      });

      if (!(lastValue > 0) && periodKey === latestPeriodKey) {
        lastValue = property.derived.currentValue;
      }

      total += lastValue;
      equityTotal += Math.max(lastValue - loanBalance, 0);

      if (comparablePeriodValues.size > 0) {
        const orderedCompKeys = Array.from(comparablePeriodValues.keys()).sort();
        let lastComp = 0;
        orderedCompKeys.forEach((key) => {
          if (key <= periodKey) {
            lastComp = comparablePeriodValues.get(key) || lastComp;
          }
        });
        if (lastComp > 0 && lastValue > 0) {
          marketPartial += lastComp;
          subjectWithComps += lastValue;
        }
      }
    });

    const marketValue = subjectWithComps > 0 && total > 0
      ? marketPartial * (total / subjectWithComps)
      : null;

    return {
      periodKey,
      label: formatPeriodLabel(periodKey, granularity),
      date: createStableDate(periodKey, granularity),
      value: total,
      equity: equityTotal,
      marketValue,
    };
  }).filter((point) => point.value > 0);
}

export function buildPropertyPortfolioOverview(
  ownerProperties: OwnerPropertyApiRecord[],
  tab: PropertyPortfolioTab = 'combined',
): PropertyPortfolioOverview {
  const normalized = normalizeOwnerPropertiesForCanonicalPortfolio(ownerProperties);
  const usageFilter = getUsageFilterForTab(tab);
  const filteredProperties = normalized.filter((property) => {
    if (usageFilter === 'all') {
      return true;
    }

    return inferPropertyUsage(property) === usageFilter;
  });

  let totalValue = 0;
  let totalEquity = 0;
  let totalMortgageBalance = 0;
  let monthlyRent = 0;
  let monthlyOtherIncome = 0;
  let monthlyIncome = 0;
  let monthlyExpenses = 0;
  let monthlyMortgage = 0;
  let monthlyCashFlow = 0;
  let sqftValueSum = 0;
  let sqftSum = 0;
  let weightedInterestRateSum = 0;
  let weightedInterestRateBase = 0;
  const expenseBreakdown: PropertyPortfolioExpenseBreakdown = {
    taxes: 0,
    insurance: 0,
    hoa: 0,
    utilities: 0,
    repairs: 0,
    management: 0,
    vacancy: 0,
    other: 0,
    debtService: 0,
  };

  const allocations = filteredProperties
    .map((property, index) => {
      const summary = (property.propertyData?.summary || {}) as GenericRecord;
      const usage = inferPropertyUsage(property);
      const annualPropertyTax = pickNumber(property.derived.annualPropertyTax);
      const annualInsurance = pickNumber(property.derived.annualInsurance);
      const annualHoa = pickNumber(property.derived.annualHoa);
      const annualUtilities = pickNumber(property.financials.utilities, (property.financials as GenericRecord).annualUtilities);
      const annualRepairs = pickNumber(property.financials.repairsCapEx, property.financials.maintenance);
      const monthlyManagement = property.derived.monthlyIncome * (pickNumber(property.financials.managementPct) / 100);
      const monthlyVacancy = property.derived.monthlyIncome * (pickNumber(property.financials.vacancyRate) / 100);
      const monthlyOther = Math.max(
        property.derived.monthlyExpenses
        - ((annualPropertyTax + annualInsurance + annualHoa + annualUtilities + annualRepairs) / 12)
        - monthlyManagement
        - monthlyVacancy,
        0,
      );

      totalValue += property.derived.currentValue;
      totalEquity += Math.max(property.derived.equity, 0);
      totalMortgageBalance += Math.max(property.derived.mortgageBalance, 0);
      monthlyRent += property.derived.monthlyRent;
      monthlyOtherIncome += property.derived.monthlyOtherIncome;
      monthlyIncome += property.derived.monthlyIncome;
      monthlyExpenses += property.derived.monthlyExpenses;
      monthlyMortgage += property.derived.monthlyMortgage;
      monthlyCashFlow += property.derived.monthlyCashFlow;

      const sqft = pickNumber(summary.living_sqft);
      if (sqft > 0 && property.derived.currentValue > 0) {
        sqftSum += sqft;
        sqftValueSum += property.derived.currentValue;
      }

      if (property.financials.interestRate > 0 && property.derived.mortgageBalance > 0) {
        weightedInterestRateSum += property.financials.interestRate * property.derived.mortgageBalance;
        weightedInterestRateBase += property.derived.mortgageBalance;
      }

      expenseBreakdown.taxes += annualPropertyTax;
      expenseBreakdown.insurance += annualInsurance;
      expenseBreakdown.hoa += annualHoa;
      expenseBreakdown.utilities += annualUtilities;
      expenseBreakdown.repairs += annualRepairs;
      expenseBreakdown.management += monthlyManagement * 12;
      expenseBreakdown.vacancy += monthlyVacancy * 12;
      expenseBreakdown.other += monthlyOther * 12;
      expenseBreakdown.debtService += property.derived.monthlyMortgage * 12;

      return {
        id: property.id,
        label: property.address || property.propertyData.summary?.address || `Property ${index + 1}`,
        address: property.address || property.propertyData.summary?.address || property.id,
        usage,
        color: buildPaletteColor(index),
        value: property.derived.currentValue,
        equity: Math.max(property.derived.equity, 0),
        mortgageBalance: Math.max(property.derived.mortgageBalance, 0),
        monthlyIncome: property.derived.monthlyIncome,
        monthlyExpenses: property.derived.monthlyExpenses,
        monthlyMortgage: property.derived.monthlyMortgage,
        monthlyCashFlow: property.derived.monthlyCashFlow,
        percentage: 0,
      };
    })
    .filter((item) => item.value > 0 || item.monthlyIncome > 0 || item.monthlyCashFlow !== 0);

  const annualGrossIncome = monthlyIncome * 12;
  const annualOperatingExpenses = monthlyExpenses * 12;
  const annualDebtService = monthlyMortgage * 12;
  const annualNetCashFlow = monthlyCashFlow * 12;
  const grossYield = totalValue > 0 ? (monthlyRent * 12 / totalValue) * 100 : 0;
  const netYield = totalValue > 0 ? (annualNetCashFlow / totalValue) * 100 : 0;
  const capRate = totalValue > 0 ? (((annualGrossIncome - annualOperatingExpenses) / totalValue) * 100) : 0;
  const avgPricePerSqft = sqftSum > 0 ? sqftValueSum / sqftSum : 0;
  const ltv = totalValue > 0 ? (totalMortgageBalance / totalValue) * 100 : 0;
  const equityRatio = totalValue > 0 ? (totalEquity / totalValue) * 100 : 0;
  const expenseRatio = annualGrossIncome > 0 ? (annualOperatingExpenses / annualGrossIncome) * 100 : 0;
  const cashFlowMargin = annualGrossIncome > 0 ? (annualNetCashFlow / annualGrossIncome) * 100 : 0;
  const avgInterestRate = weightedInterestRateBase > 0 ? weightedInterestRateSum / weightedInterestRateBase : 0;
  const estimatedRefinanceHeadroom75Ltv = Math.max((totalValue * 0.75) - totalMortgageBalance, 0);
  const estimatedHelocHeadroom85Cltv = Math.max((totalValue * 0.85) - totalMortgageBalance, 0);
  const totalAllocationValue = allocations.reduce((sum, item) => sum + Math.max(item.value, 0), 0);
  const normalizedAllocations = allocations.map((item) => ({
    ...item,
    percentage: totalAllocationValue > 0 ? (item.value / totalAllocationValue) * 100 : 0,
  })).sort((left, right) => right.value - left.value);

  return {
    tab,
    usageFilter,
    properties: filteredProperties,
    summary: {
      count: filteredProperties.length,
      totalValue,
      totalEquity,
      totalMortgageBalance,
      monthlyRent,
      monthlyOtherIncome,
      monthlyIncome,
      monthlyExpenses,
      monthlyMortgage,
      monthlyCashFlow,
      annualGrossIncome,
      annualOperatingExpenses,
      annualDebtService,
      annualNetCashFlow,
      grossYield,
      netYield,
      capRate,
      avgPricePerSqft,
      ltv,
      equityRatio,
      expenseRatio,
      cashFlowMargin,
      avgInterestRate,
      estimatedRefinanceHeadroom75Ltv,
      estimatedHelocHeadroom85Cltv,
    },
    expenseBreakdown,
    valueTrendQuarterly: buildPropertyTrend(filteredProperties, 'quarterly'),
    valueTrendAnnual: buildPropertyTrend(filteredProperties, 'annual'),
    allocations: normalizedAllocations,
  };
}