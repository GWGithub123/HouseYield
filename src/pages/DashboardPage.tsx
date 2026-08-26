import React, {
  useCallback,
  startTransition,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as d3 from 'd3';
import { useNavigate } from 'react-router-dom';
import { CreditCard, UserPlus, Wrench, RefreshCw, Percent, Hammer, FileUp, MessageSquare, HousePlus, Trophy, Flame, TrendingUp, Landmark, Sparkles } from 'lucide-react';
import ComprehensiveAssetSankey from '../components/ComprehensiveAssetSankey';
import {
  INCOME_PROJECTION_ASSET_METADATA,
  INCOME_PROJECTION_DASHBOARD_ASSETS,
  isIncomeProjectionAssetId,
  type IncomeProjectionAssetId,
  type IncomeProjectionsTabId,
} from '../components/finance/incomeProjectionAssets';
import {
  MARKET_INSIGHTS_ASSET_METADATA,
  MARKET_INSIGHTS_DASHBOARD_ASSETS,
  isMarketInsightsAssetId,
  type MarketInsightsAssetId,
} from '../components/market/marketInsightsAssets';
import DashboardAssistantMemoriesModal from '../components/DashboardAssistantMemoriesModal';
import SidebarLiquidGlassShell from '../components/SidebarLiquidGlassShell';
import { PropertyDetailsModal, type PropertyDetailsFocusSection } from '../components/PropertyDetailsModal';
import { buildBookkeepingPropertyId } from '../utils/propertyScope';
import { getDevApiBaseUrl } from '../utils/devApiBase';
import BookkeepingAnalyticsWorkspace, { type BookkeepingAnalyticsAssetId } from '../components/finance/BookkeepingAnalyticsWorkspace';
import NetWorthAllocationPanel, { type AllocationClassDetail } from '../components/NetWorthAllocationPanel';
import RentalPricingPowerGraph, { type RentalPricingPowerAssetId } from '../components/RentalPricingPowerGraph';
import PropertyAnalyticsMetricSurface, {
  buildAnalyticsChartData,
  buildAvmHistorySeries as buildPropertyAnalyticsAvmHistorySeries,
  buildTaxHistorySeries as buildPropertyAnalyticsTaxHistorySeries,
  type PropertyAnalyticsSurfaceFinancialInputs,
} from '../components/property/PropertyAnalyticsMetricSurface';
import {
  PropertyOverviewAnalyticsGrid,
  type AvmGranularity,
  type ProjectionGranularity,
  type PropertyAnalyticsMetricKey,
  type PropertyOverviewAssetId,
  type TaxHistoryRange,
} from '../components/property/PropertyAnalyticsGraphs';
import { StreetViewImage } from '../components/StreetViewImage';
import IrsDraftFormWorkspace, { type TaxpayerDraftProfile } from '../components/tax/IrsDraftFormWorkspace';
import { useAuth } from '../contexts/AuthContext';
import {
  getDefaultBookkeepingDateRange,
  useFirestoreBookkeeping,
  type BookkeepingSummary,
  type Transaction as BookkeepingTransaction,
} from '../hooks/useFirestoreBookkeeping';
import {
  useShellyFirestore,
  type SensorReading,
  type ShellyAlert,
  type ShellyDevice,
} from '../hooks/useShellyFirestore';
import {
  getAssets,
  getDateRangeForPeriod,
  getLiabilities,
  getPortfolioSnapshots,
  getStockBasicInfo,
  type Liability,
  type PortfolioData,
  type PortfolioSnapshot,
} from '../services/portfolioService';
import {
  buildCanonicalPortfolioProjection,
  buildPropertyPortfolioOverview,
  type CanonicalOwnerPropertyRecord,
  type PropertyPortfolioHistoryGranularity,
  type PropertyPortfolioOverview,
} from '../services/canonicalPortfolioService';
import { PortfolioValueHistoryCard } from '../components/property/PortfolioOverviewTab';
import taxClient from '../services/canonicalTaxClient';
import { useTenantCorrespondenceSummary } from '../hooks/useTenantCorrespondenceSummary';
import { ownerPropertiesClient, type OwnerPropertyApiRecord } from '../services/ownerPropertiesClient';
import {
  emitAssistantActionProgress,
  websiteControl,
  WEBSITE_ACTIONS,
  type ControlAction,
} from '../services/websiteControlService';
import type {
  AssistantDailyBriefingResult,
  AssistantPadAction,
} from '../services/assistantActionResultTypes';
import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from '../services/ownerFinanceApi';
import { previewWeeklyDigest, type WeeklyDigest } from '../services/weeklyDigestClient';
import YourWeekRecapCard from '../components/dashboard/YourWeekRecapCard';
import PortfolioConstellationMap, {
  type ConstellationHealth,
  type ConstellationProperty,
} from '../components/dashboard/PortfolioConstellationMap';
import { Card } from '../design-system';
import type { PropertyDashboard } from '../types/attom';
import { buildVoiceUiAttrs } from '../utils/voiceUi';

type FinancialInputs = {
  avm: number;
  taxAmount: number;
  originalLoanAmount?: number;
  currentLoanBalance?: number;
  remainingLoanTermMonths?: number;
  monthlyDebtService?: number;
  monthlyRent: number;
  otherIncome: number;
  vacancyRate: number;
  rentGrowth: number;
  insurance: number;
  utilities: number;
  hoa: number;
  repairsCapEx: number;
  managementPct: number;
  expenseInflation: number;
  taxGrowth: number;
  interestRate: number;
  loanTerm: number;
  isInterestOnly: boolean;
  downPayment: number;
  closingCosts: number;
  initialRehab: number;
  appreciationRate?: number;
};

type DashboardTaxScheduleSummary = {
  totalIncome?: number;
  totalExpenses?: number;
  netIncomeOrLoss?: number;
};

type DashboardTaxScheduleLineDetail = {
  line?: number | null;
  name?: string;
  amount?: number;
};

type DashboardPropertyCashFlowSnapshot = {
  surfaceId: string;
  propertyId?: string;
  propertyLabel: string;
  yearlyValues: Array<{
    year: string;
    value: number;
    formatted: string;
  }>;
};

const EMPTY_DASHBOARD_TAXPAYER_DRAFT_PROFILE: TaxpayerDraftProfile = {
  primaryName: '',
  spouseName: '',
  tinLast4: '',
  mailingStreet: '',
  mailingCity: '',
  mailingState: '',
  mailingZip: '',
};

function normalizeDashboardDraftFormProfile(profile?: Partial<TaxpayerDraftProfile> | null, fallbackState = ''): TaxpayerDraftProfile {
  return {
    primaryName: String(profile?.primaryName || '').trim(),
    spouseName: String(profile?.spouseName || '').trim(),
    tinLast4: String(profile?.tinLast4 || '').replace(/\D/g, '').slice(0, 4),
    mailingStreet: String(profile?.mailingStreet || '').trim(),
    mailingCity: String(profile?.mailingCity || '').trim(),
    mailingState: String(profile?.mailingState || fallbackState || '').trim().toUpperCase().slice(0, 2),
    mailingZip: String(profile?.mailingZip || '').trim(),
  };
}

function hasRenderableDashboardTaxSummary(summary?: DashboardTaxScheduleSummary | null) {
  return ['totalIncome', 'totalExpenses', 'netIncomeOrLoss'].some((key) => Math.abs(Number(summary?.[key as keyof DashboardTaxScheduleSummary] || 0)) > 0);
}

function hasRenderableDashboardTaxLineAmounts(scheduleDetail?: { scheduleELines?: Record<string, DashboardTaxScheduleLineDetail> } | null) {
  return Object.values(scheduleDetail?.scheduleELines || {}).some((line) => Math.abs(Number(line.amount || 0)) > 0);
}

function hasRenderableDashboardTaxDataset(
  summary?: DashboardTaxScheduleSummary | null,
  scheduleDetail?: { scheduleELines?: Record<string, DashboardTaxScheduleLineDetail> } | null,
) {
  return hasRenderableDashboardTaxSummary(summary) || hasRenderableDashboardTaxLineAmounts(scheduleDetail);
}

type NetWorthTimePeriod = '1d' | '1w' | '1m' | 'YTD' | '3m' | '6m' | '1y' | '2y' | '3y';
type NetWorthChartSeriesPoint = {
  label: string;
  fullLabel: string;
  value: number;
};

type PropertyValueHistoryPoint = {
  label: string;
  fullLabel: string;
  value: number;
  low?: number | null;
  high?: number | null;
};

type PropertyTaxHistoryPoint = {
  label: string;
  fullLabel: string;
  amount: number;
  yoy: number | null;
};

type PortfolioAssets = PortfolioData['assets'];
type PortfolioLiabilities = Liability[];

type PortfolioAllocationSlice = {
  key: string;
  label: string;
  value: number;
  color: string;
  percent: number;
  assetList: Array<{
    name: string;
    value: number;
  }>;
};

type DashboardStockBasicInfoEntry = {
  name?: string;
  logoUrl: string;
  change: number;
  changePercent: number;
};

type DashboardStockBasicInfoMap = Record<string, DashboardStockBasicInfoEntry>;

type BookkeepingTrendPoint = {
  label: string;
  fullLabel: string;
  income: number;
  expense: number;
  net: number;
};

type IncomeExpenseAnalytics = {
  income: number[];
  expenses: number[];
  expenseBreakdown: {
    taxes: number[];
    operations: number[];
    repairs: number[];
    management: number[];
    debtService: number[];
  };
};

type MortgageAmortizationAnalytics = {
  principal: number[];
  interest: number[];
  loanBalance: number[];
};

type DashboardSurfaceId =
  | 'property-overview'
  | 'net-worth-graph'
  | 'avm-history'
  | 'portfolio-overview-price-history'
  | 'portfolio-overview-cash-flow'
  | 'portfolio-overview-tax-history'
  | 'portfolio-overview-tenant-correspondence-summary'
  | 'portfolio-allocation'
  | 'allocation-flow'
  | 'cash-flow-graph'
  | 'income-expenses'
  | 'tax-history'
  | 'coc-return'
  | 'mortgage-amortization'
  | 'net-operating-income'
  | 'equity-appreciation'
  | 'total-return'
  | 'irr-holding-period'
  | 'reserve-summary'
  | 'property-image'
  | 'property-details-overview'
  | 'property-details-tax-history'
  | 'property-details-mortgage'
  | 'property-details-owner'
  | 'property-details-environmental'
  | 'property-details-schools'
  | 'property-details-building-permits'
  | 'property-details-sale-history'
  | 'property-details-location'
  | 'rental-pricing-power'
  | 'rental-pricing-power-bar-comparison'
  | 'rental-pricing-power-comparable-listings-map'
  | 'rental-pricing-power-strategy'
  | 'rental-pricing-power-rent-sweep'
  | 'rental-pricing-power-model-metrics'
  | 'rental-pricing-power-vacancy-cutoff'
  | 'rental-pricing-power-renovation-separation'
  | 'rental-pricing-power-market-conditions'
  | 'rental-pricing-power-local-leasing-signals'
  | 'rental-pricing-power-renovation-analysis-link'
  | 'tax-pdf-viewer'
  | 'irs-draft-forms'
  | 'maintenance-summary'
  | 'bookkeeping-cash-balance-history'
  | 'bookkeeping-cash-balance'
  | 'bookkeeping-reserve-runway'
  | 'bookkeeping-average-net'
  | 'bookkeeping-data-quality'
  | 'bookkeeping-analytics-explanations'
  | 'bookkeeping-reserve-posture'
  | 'bookkeeping-analytics-foundation'
  | 'bookkeeping-trend'
  | 'workflow-shortcuts'
  | 'weekly-recap'
  | MarketInsightsAssetId
  | IncomeProjectionAssetId;

type DashboardSurfaceDefinition = {
  id: DashboardSurfaceId;
  title: string;
  source: string;
  gridClass?: string;
  cardClass: string;
  defaultSize: DashboardSurfaceSize;
  defaultHeight: DashboardSurfaceHeight;
  keywords: string[];
};

type DashboardSurfaceSize = 'full' | 'wide' | 'half' | 'third';
type DashboardSurfaceHeight = 'compact' | 'standard' | 'tall' | 'hero';
type DashboardAnnotationPlacement =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'right'
  | 'bottom-right'
  | 'bottom'
  | 'bottom-left'
  | 'left'
  | 'center';
type DashboardAnnotationTone = 'neutral' | 'info' | 'success' | 'warning';
type DashboardAnnotationWidth = 'sm' | 'md' | 'lg';

type DashboardSurfaceLayoutState = {
  order: number;
  size: DashboardSurfaceSize;
  height: DashboardSurfaceHeight;
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  emphasis: boolean;
  visible: boolean;
};

type DashboardSurfaceLayoutPatch = {
  id: DashboardSurfaceId;
  visible?: boolean;
  order?: number;
  size?: DashboardSurfaceSize;
  height?: DashboardSurfaceHeight;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  zIndex?: number;
  emphasis?: boolean;
};

type DashboardAnnotation = {
  id: string;
  text: string;
  title?: string;
  surfaceId?: DashboardSurfaceId | null;
  placement: DashboardAnnotationPlacement;
  tone: DashboardAnnotationTone;
  width: DashboardAnnotationWidth;
  x?: number;
  y?: number;
  persistent?: boolean;
  arrow?: 'up' | 'down' | 'left' | 'right';
};

type DashboardSegmentHighlight = {
  surfaceId: DashboardSurfaceId;
  keys: string[];
};

type DashboardAssistantMode = 'add' | 'replace' | 'remove' | 'clear' | 'reset' | 'arrange' | 'annotate';

type DashboardAssistantPlan = {
  nextIds: DashboardSurfaceId[];
  highlightId: DashboardSurfaceId | null;
  message: string;
  answer?: string;
  actionId?: string | null;
  layout?: DashboardSurfaceLayoutPatch[];
  annotations?: DashboardAnnotation[];
  clearAnnotations?: boolean;
  segmentHighlights?: DashboardSegmentHighlight[];
};

type CommandPlan = DashboardAssistantPlan;
type RealtimeResponseModality = 'audio' | 'text';
type DashboardRealtimeResponseDetail = {
  requestId?: string;
  prompt?: string;
  text?: string;
  error?: string;
};

type DashboardPropertyFinancialData = {
  monthlyRent?: number;
  otherIncome?: number;
  vacancyRate?: number;
  rentGrowth?: number;
  insurance?: number;
  utilities?: number;
  hoa?: number;
  repairsCapEx?: number;
  managementPct?: number;
  expenseInflation?: number;
  taxInflation?: number;
  interestRate?: number;
  loanTerm?: number;
  originalLoanAmount?: number;
  currentLoanBalance?: number;
  remainingLoanTermMonths?: number;
  monthlyDebtService?: number;
  isInterestOnly?: boolean;
  downPayment?: number;
  closingCosts?: number;
  initialRehab?: number;
  appreciationRate?: number;
};

type DashboardProperty = {
  id: string;
  address: string;
  data: PropertyDashboard | null;
  financialData?: DashboardPropertyFinancialData | null;
  tenantCount?: number;
  savedAt?: string;
  updatedAt?: string;
  source: 'portfolio' | 'saved';
};

type PortfolioAnalyticsContext = {
  label: string;
  financialInputs: FinancialInputs | null;
  avmHistory: PropertyValueHistoryPoint[];
  avmHistoryMode: 'historical' | 'modeled';
  taxHistory: PropertyTaxHistoryPoint[];
  taxHistoryMode: 'historical' | 'modeled';
};

type DashboardPropertyAnalyticsSurfaceId =
  | 'avm-history'
  | 'cash-flow-graph'
  | 'income-expenses'
  | 'tax-history'
  | 'coc-return'
  | 'mortgage-amortization'
  | 'net-operating-income'
  | 'equity-appreciation'
  | 'total-return'
  | 'irr-holding-period';

type DashboardAnalyticsSurfaceScope = {
  key: string;
  property: DashboardProperty | null;
  isPortfolioScope: boolean;
  usingPortfolioFallback: boolean;
  label: string;
};

const DASHBOARD_PROPERTY_ANALYTICS_SURFACE_METRICS: Record<DashboardPropertyAnalyticsSurfaceId, PropertyAnalyticsMetricKey> = {
  'avm-history': 'priceHistory',
  'cash-flow-graph': 'cashFlow',
  'income-expenses': 'incomeExpenses',
  'tax-history': 'taxHistory',
  'coc-return': 'cocReturn',
  'mortgage-amortization': 'mortgageAmortization',
  'net-operating-income': 'noi',
  'equity-appreciation': 'equity',
  'total-return': 'totalReturn',
  'irr-holding-period': 'irr',
};

type DashboardPortfolioOverviewSurfaceId =
  | 'portfolio-overview-price-history'
  | 'portfolio-overview-cash-flow'
  | 'portfolio-overview-tax-history'
  | 'portfolio-overview-tenant-correspondence-summary';

const DASHBOARD_PORTFOLIO_OVERVIEW_SURFACE_ASSETS: Record<DashboardPortfolioOverviewSurfaceId, PropertyOverviewAssetId> = {
  'portfolio-overview-price-history': 'overview-price-history',
  'portfolio-overview-cash-flow': 'overview-cash-flow',
  'portfolio-overview-tax-history': 'overview-tax-history',
  'portfolio-overview-tenant-correspondence-summary': 'tenant-correspondence-summary',
};

type DashboardPropertyDetailsSurfaceId =
  | 'property-details-overview'
  | 'property-details-tax-history'
  | 'property-details-mortgage'
  | 'property-details-owner'
  | 'property-details-environmental'
  | 'property-details-schools'
  | 'property-details-building-permits'
  | 'property-details-sale-history'
  | 'property-details-location';

const DASHBOARD_PROPERTY_DETAILS_SURFACE_SECTIONS: Record<DashboardPropertyDetailsSurfaceId, PropertyDetailsFocusSection> = {
  'property-details-overview': 'overview',
  'property-details-tax-history': 'tax-history',
  'property-details-mortgage': 'mortgage',
  'property-details-owner': 'owner',
  'property-details-environmental': 'environmental',
  'property-details-schools': 'schools',
  'property-details-building-permits': 'building-permits',
  'property-details-sale-history': 'sale-history',
  'property-details-location': 'location',
};

type DashboardRentalPricingSurfaceId =
  | 'rental-pricing-power'
  | 'rental-pricing-power-bar-comparison'
  | 'rental-pricing-power-comparable-listings-map'
  | 'rental-pricing-power-strategy'
  | 'rental-pricing-power-rent-sweep'
  | 'rental-pricing-power-model-metrics'
  | 'rental-pricing-power-vacancy-cutoff'
  | 'rental-pricing-power-renovation-separation'
  | 'rental-pricing-power-market-conditions'
  | 'rental-pricing-power-local-leasing-signals'
  | 'rental-pricing-power-renovation-analysis-link';

type DashboardRentalPricingFocusedSurfaceId = Exclude<DashboardRentalPricingSurfaceId, 'rental-pricing-power'>;

const DASHBOARD_RENTAL_PRICING_SURFACE_ASSETS: Record<DashboardRentalPricingFocusedSurfaceId, RentalPricingPowerAssetId> = {
  'rental-pricing-power-bar-comparison': 'bar-comparison',
  'rental-pricing-power-comparable-listings-map': 'comparable-listings-map',
  'rental-pricing-power-strategy': 'pricing-strategy',
  'rental-pricing-power-rent-sweep': 'interactive-rent-sweep',
  'rental-pricing-power-model-metrics': 'pricing-model-metrics',
  'rental-pricing-power-vacancy-cutoff': 'vacancy-cutoff',
  'rental-pricing-power-renovation-separation': 'renovation-separation',
  'rental-pricing-power-market-conditions': 'market-conditions',
  'rental-pricing-power-local-leasing-signals': 'local-leasing-signals',
  'rental-pricing-power-renovation-analysis-link': 'renovation-analysis-link',
};

type DashboardBookkeepingAnalyticsSurfaceId =
  | 'bookkeeping-trend'
  | 'bookkeeping-cash-balance-history'
  | 'bookkeeping-cash-balance'
  | 'bookkeeping-reserve-runway'
  | 'bookkeeping-average-net'
  | 'bookkeeping-data-quality'
  | 'bookkeeping-analytics-explanations'
  | 'bookkeeping-reserve-posture'
  | 'bookkeeping-analytics-foundation';

const DASHBOARD_BOOKKEEPING_ANALYTICS_SURFACE_ASSETS: Record<DashboardBookkeepingAnalyticsSurfaceId, BookkeepingAnalyticsAssetId | null> = {
  'bookkeeping-trend': 'cashflow-trend',
  'bookkeeping-cash-balance-history': 'cash-balance-history',
  'bookkeeping-cash-balance': 'cash-balance-metric',
  'bookkeeping-reserve-runway': 'reserve-runway-metric',
  'bookkeeping-average-net': 'average-net-metric',
  'bookkeeping-data-quality': 'data-quality-metric',
  'bookkeeping-analytics-explanations': 'analytics-explanations',
  'bookkeeping-reserve-posture': 'reserve-posture',
  'bookkeeping-analytics-foundation': null,
};

const DASHBOARD_MARKET_INSIGHTS_TAB_SOURCES = {
  overview: 'Market insights overview',
  economy: 'Economic indicators',
  fed: 'Fed & predictions',
} as const;

function getDashboardMarketInsightsTabAliases(tab: keyof typeof DASHBOARD_MARKET_INSIGHTS_TAB_SOURCES) {
  if (tab === 'overview') {
    return ['market overview', 'market insights overview', 'overview tab'];
  }

  if (tab === 'economy') {
    return ['economic indicators', 'economy tab', 'market insights economy'];
  }

  return ['fed and predictions', 'fed predictions', 'market predictions', 'fed tab'];
}

const DASHBOARD_MARKET_INSIGHTS_SURFACE_ALIASES = Object.fromEntries(
  MARKET_INSIGHTS_DASHBOARD_ASSETS.map((asset) => [
    asset.id,
    [
      asset.title,
      `${DASHBOARD_MARKET_INSIGHTS_TAB_SOURCES[asset.tab]} ${asset.title}`,
      ...getDashboardMarketInsightsTabAliases(asset.tab),
      ...asset.keywords,
    ],
  ]),
) as Record<MarketInsightsAssetId, string[]>;

const DASHBOARD_MARKET_INSIGHTS_SURFACE_MIN_HEIGHTS = Object.fromEntries(
  MARKET_INSIGHTS_DASHBOARD_ASSETS.map((asset) => [asset.id, asset.minHeight]),
) as Record<MarketInsightsAssetId, number>;

const DASHBOARD_INCOME_PROJECTIONS_TAB_SOURCES: Record<IncomeProjectionsTabId, string> = {
  income: 'Income & projections income tab',
  dividend: 'Income & projections dividend tab',
  retirement: 'Income & projections financial independence tab',
} as const;

function getDashboardIncomeProjectionTabAliases(tab: keyof typeof DASHBOARD_INCOME_PROJECTIONS_TAB_SOURCES) {
  if (tab === 'income') {
    return ['income and projections income', 'income projections income tab', 'rental and dividend income'];
  }

  if (tab === 'dividend') {
    return ['income and projections dividend', 'income projections dividend tab', 'dividend income', 'stock dividend income'];
  }

  return [
    'income and projections financial independence',
    'income projections financial independence tab',
    'financial independence',
    'income and projections retirement',
    'income projections retirement tab',
    'retirement planning',
  ];
}

const DASHBOARD_INCOME_PROJECTIONS_SURFACE_ALIASES = Object.fromEntries(
  INCOME_PROJECTION_DASHBOARD_ASSETS.map((asset) => [
    asset.id,
    [
      asset.title,
      `${DASHBOARD_INCOME_PROJECTIONS_TAB_SOURCES[asset.tab]} ${asset.title}`,
      ...getDashboardIncomeProjectionTabAliases(asset.tab),
      ...asset.keywords,
    ],
  ]),
) as Record<IncomeProjectionAssetId, string[]>;

const DASHBOARD_INCOME_PROJECTIONS_SURFACE_MIN_HEIGHTS = Object.fromEntries(
  INCOME_PROJECTION_DASHBOARD_ASSETS.map((asset) => [asset.id, asset.minHeight]),
) as Record<IncomeProjectionAssetId, number>;

const DASHBOARD_PROPERTY_COMPARISON_MAX = 2;
const PROPERTY_ADDRESS_STOPWORDS = new Set([
  'st',
  'street',
  'ave',
  'avenue',
  'rd',
  'road',
  'dr',
  'drive',
  'ln',
  'lane',
  'ct',
  'court',
  'cir',
  'circle',
  'blvd',
  'boulevard',
  'way',
  'pkwy',
  'parkway',
  'apt',
  'unit',
]);
const PROPERTY_COMPARISON_PROMPT_PATTERN = /\b(compare|comparison|versus|vs\b|against|side by side|side-by-side)\b/i;
const PORTFOLIO_SCOPE_PROMPT_PATTERN = /\b(portfolio|account(?:\s|-)?wide|overall|all properties|entire account)\b/i;

function isPropertyAnalyticsSurfaceId(surfaceId: DashboardSurfaceId): surfaceId is DashboardPropertyAnalyticsSurfaceId {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_PROPERTY_ANALYTICS_SURFACE_METRICS, surfaceId);
}

function isPortfolioOverviewSurfaceId(surfaceId: DashboardSurfaceId): surfaceId is DashboardPortfolioOverviewSurfaceId {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_PORTFOLIO_OVERVIEW_SURFACE_ASSETS, surfaceId);
}

function isPropertyDetailsSurfaceId(surfaceId: DashboardSurfaceId): surfaceId is DashboardPropertyDetailsSurfaceId {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_PROPERTY_DETAILS_SURFACE_SECTIONS, surfaceId);
}

function isRentalPricingSurfaceId(surfaceId: DashboardSurfaceId): surfaceId is DashboardRentalPricingSurfaceId {
  return surfaceId === 'rental-pricing-power'
    || Object.prototype.hasOwnProperty.call(DASHBOARD_RENTAL_PRICING_SURFACE_ASSETS, surfaceId);
}

function isBookkeepingAnalyticsSurfaceId(surfaceId: DashboardSurfaceId): surfaceId is DashboardBookkeepingAnalyticsSurfaceId {
  return Object.prototype.hasOwnProperty.call(DASHBOARD_BOOKKEEPING_ANALYTICS_SURFACE_ASSETS, surfaceId);
}

function isMarketInsightsSurfaceId(surfaceId: DashboardSurfaceId): surfaceId is MarketInsightsAssetId {
  return isMarketInsightsAssetId(surfaceId);
}

function isIncomeProjectionSurfaceId(surfaceId: DashboardSurfaceId): surfaceId is IncomeProjectionAssetId {
  return isIncomeProjectionAssetId(surfaceId);
}

function isStandaloneDashboardSurfaceId(surfaceId: DashboardSurfaceId) {
  return isPropertyAnalyticsSurfaceId(surfaceId)
    || isPortfolioOverviewSurfaceId(surfaceId)
    || isPropertyDetailsSurfaceId(surfaceId)
    || isRentalPricingSurfaceId(surfaceId)
    || isMarketInsightsSurfaceId(surfaceId)
    || isIncomeProjectionSurfaceId(surfaceId)
    || isBookkeepingAnalyticsSurfaceId(surfaceId)
    || surfaceId === 'irs-draft-forms';
}

function normalizeDashboardPropertyPromptText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreDashboardPropertyPromptMatch(prompt: string, property: DashboardProperty) {
  const normalizedPrompt = normalizeDashboardPropertyPromptText(prompt);
  const normalizedAddress = normalizeDashboardPropertyPromptText(property.data?.summary?.address || property.address || '');

  if (!normalizedPrompt || !normalizedAddress) {
    return 0;
  }

  if (normalizedPrompt.includes(normalizedAddress)) {
    return 400 + normalizedAddress.length;
  }

  const addressTokens = normalizedAddress.split(/\s+/).filter(Boolean);
  const meaningfulTokens = addressTokens.filter((token, index) => (
    token.length > 2 && !PROPERTY_ADDRESS_STOPWORDS.has(token)
  ) || (index === 0 && /^\d+[a-z]?$/i.test(token)));
  const matchedTokenCount = meaningfulTokens.filter((token) => normalizedPrompt.includes(token)).length;
  const houseNumber = addressTokens.find((token) => /^\d+[a-z]?$/i.test(token)) || null;
  const primaryPhrase = meaningfulTokens.slice(0, 3).join(' ');

  if (primaryPhrase && normalizedPrompt.includes(primaryPhrase)) {
    return 260 + primaryPhrase.length;
  }

  if (houseNumber && normalizedPrompt.includes(houseNumber) && matchedTokenCount >= 2) {
    return 220 + (matchedTokenCount * 24);
  }

  if (matchedTokenCount >= 2) {
    return 140 + (matchedTokenCount * 20);
  }

  return 0;
}

function findDashboardPromptPropertyMatches(prompt: string, properties: DashboardProperty[]) {
  return properties
    .map((property) => ({
      property,
      score: scoreDashboardPropertyPromptMatch(prompt, property),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.property.address.localeCompare(right.property.address);
    })
    .map((entry) => entry.property);
}

const PORTFOLIO_SCOPE_ID = '__portfolio__';
const NET_WORTH_PERIOD: NetWorthTimePeriod = '1m';

const dashboardStyles = `
  .dashboard-shell {
    background: linear-gradient(180deg, #f8fafc 0%, #f3f6fa 100%);
  }

  .dashboard-login-splash {
    position: fixed;
    inset: 0;
    z-index: 160;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
  }

  .dashboard-login-splash-brand {
    color: #0f172a;
    font-size: clamp(2.8rem, 5vw, 4.8rem);
    font-weight: 700;
    letter-spacing: -0.06em;
    line-height: 1;
  }

  .dashboard-fixed-header {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
  }

  .dashboard-fixed-header::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.5), rgba(248, 250, 252, 0.32));
    pointer-events: none;
    z-index: 0;
  }

  .dashboard-fixed-header > * {
    position: relative;
    z-index: 1;
  }

  .dashboard-header-panel {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.94) 0%, rgba(249, 251, 253, 0.9) 100%);
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
  }

  .dashboard-agent-shell {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.98);
    box-shadow:
      0 14px 34px rgba(15, 23, 42, 0.07),
      inset 0 1px 0 rgba(255, 255, 255, 0.94);
  }

  .dashboard-agent-shell::before {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    background: linear-gradient(90deg, rgba(33, 66, 104, 0.06), rgba(46, 184, 180, 0.05));
    opacity: 1;
    pointer-events: none;
    z-index: 0;
  }

  .dashboard-agent-shell > * {
    position: relative;
    z-index: 1;
  }

  .dashboard-agent-shell:focus-within {
    border-color: rgba(99, 102, 241, 0.34);
    box-shadow:
      0 22px 54px rgba(99, 102, 241, 0.18),
      0 18px 40px rgba(20, 184, 166, 0.10),
      inset 0 1px 0 rgba(255, 255, 255, 0.95);
  }

  .dashboard-analyzing-shell {
    --dashboard-analyzing-stroke-width: 1.3px;
    --dashboard-analyzing-corner-radius: 20px;
    --dashboard-analyzing-bleed: 3px;
    position: relative;
    isolation: isolate;
    overflow: visible;
  }

  .dashboard-analyzing-shell::before {
    content: '';
    position: absolute;
    inset: calc(var(--dashboard-analyzing-bleed) * -0.8);
    border-radius: calc(var(--dashboard-analyzing-corner-radius) + var(--dashboard-analyzing-bleed));
    background: radial-gradient(circle at 50% 50%, rgba(6, 182, 212, 0.08) 0%, rgba(34, 197, 94, 0.06) 34%, rgba(245, 158, 11, 0.05) 68%, rgba(124, 58, 237, 0.06) 100%);
    filter: blur(12px);
    opacity: 0;
    transition: opacity 180ms ease;
    pointer-events: none;
    z-index: 0;
  }

  .dashboard-analyzing-shell.is-analyzing::before {
    opacity: 1;
  }

  .dashboard-analyzing-content {
    position: relative;
    z-index: 1;
  }

  .dashboard-analyzing-frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    opacity: 0;
    transition: opacity 180ms ease;
    z-index: 3;
  }

  .dashboard-analyzing-shell.is-analyzing .dashboard-analyzing-frame {
    opacity: 1;
  }

  .dashboard-analyzing-path-ambient {
    fill: none;
    stroke-width: var(--dashboard-analyzing-stroke-width);
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.16;
  }

  .dashboard-analyzing-path-trail-outer {
    fill: none;
    stroke-width: calc(var(--dashboard-analyzing-stroke-width) * 1.05);
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.22;
    filter: drop-shadow(0 0 4px rgba(6, 182, 212, 0.16));
  }

  .dashboard-analyzing-path-trail-mid {
    fill: none;
    stroke-width: calc(var(--dashboard-analyzing-stroke-width) * 1.35);
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.34;
    filter:
      drop-shadow(0 0 4px rgba(34, 197, 94, 0.2))
      drop-shadow(0 0 8px rgba(6, 182, 212, 0.14));
  }

  .dashboard-analyzing-path-runner {
    fill: none;
    stroke-width: calc(var(--dashboard-analyzing-stroke-width) * 1.65);
    stroke-linecap: round;
    stroke-linejoin: round;
    filter:
      drop-shadow(0 0 5px rgba(34, 197, 94, 0.28))
      drop-shadow(0 0 9px rgba(6, 182, 212, 0.18))
      drop-shadow(0 0 14px rgba(124, 58, 237, 0.14));
  }

  .dashboard-analyzing-path-lead {
    fill: none;
    stroke: rgba(249, 250, 251, 0.98);
    stroke-width: calc(var(--dashboard-analyzing-stroke-width) * 0.72);
    stroke-linecap: round;
    stroke-linejoin: round;
    filter:
      drop-shadow(0 0 3px rgba(255, 255, 255, 0.82))
      drop-shadow(0 0 7px rgba(255, 255, 255, 0.28));
  }

  .dashboard-agent-analysis-frame {
    --dashboard-analyzing-corner-radius: 24px;
    --dashboard-analyzing-bleed: 2px;
  }

  .dashboard-fluid-analysis-frame {
    --dashboard-analyzing-corner-radius: 36px;
    --dashboard-analyzing-bleed: 3px;
  }

  .dashboard-fluid-canvas {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    min-height: clamp(380px, 44vh, 560px);
    border-radius: 34px;
    background:
      radial-gradient(120% 120% at 50% 0%, rgba(99, 102, 241, 0.35), transparent 45%),
      radial-gradient(85% 70% at 50% -4%, rgba(20, 184, 166, 0.14), transparent 52%),
      radial-gradient(70% 60% at 50% 116%, rgba(139, 92, 246, 0.20), transparent 56%),
      linear-gradient(180deg, #0b1220 0%, #131c33 55%, #0b1220 100%);
  }

  .dashboard-fluid-canvas.is-analyzing {
    box-shadow:
      inset 0 0 0 1px rgba(194, 255, 246, 0.08),
      inset 0 18px 46px rgba(8, 18, 36, 0.12);
  }

  .dashboard-fluid-canvas.is-searching-empty {
    height: clamp(420px, 48vh, 580px);
    min-height: clamp(420px, 48vh, 580px);
  }

  .dashboard-dot-ripple-field {
    position: absolute;
    inset: 0;
    z-index: 1;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    opacity: 0;
    pointer-events: none;
    mix-blend-mode: screen;
    transition: opacity 260ms ease;
  }

  .dashboard-dot-ripple-field.is-active {
    opacity: 0.88;
  }

  .dashboard-fluid-shell {
    box-shadow: 0 28px 72px rgba(7, 18, 36, 0.24);
  }

  .dashboard-fluid-canvas::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, rgba(255, 255, 255, 0) 10%, rgba(10, 20, 39, 0.14) 34%, rgba(7, 16, 34, 0.26) 66%, rgba(5, 12, 26, 0.34) 100%);
    pointer-events: none;
    z-index: 0;
  }

  .dashboard-fluid-canvas-inner {
    position: relative;
    z-index: 2;
  }

  .dashboard-surface {
    animation: dashboard-surface-enter 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  .dashboard-surface:nth-child(2) { animation-delay: 70ms; }
  .dashboard-surface:nth-child(3) { animation-delay: 120ms; }
  .dashboard-surface:nth-child(4) { animation-delay: 170ms; }
  .dashboard-surface:nth-child(5) { animation-delay: 220ms; }
  .dashboard-surface:nth-child(6) { animation-delay: 270ms; }
  .dashboard-surface:nth-child(7) { animation-delay: 320ms; }
  .dashboard-surface:nth-child(8) { animation-delay: 370ms; }
  .dashboard-surface:nth-child(9) { animation-delay: 420ms; }
  .dashboard-surface:nth-child(10) { animation-delay: 470ms; }
  .dashboard-surface:nth-child(11) { animation-delay: 520ms; }
  .dashboard-surface:nth-child(12) { animation-delay: 570ms; }

  .dashboard-card-shell {
    position: relative;
    isolation: isolate;
    background:
      linear-gradient(140deg, rgba(255, 255, 255, 0.42) 0%, rgba(246, 250, 255, 0.24) 46%, rgba(237, 246, 255, 0.44) 100%),
      radial-gradient(circle at 100% 10%, rgba(125, 211, 252, 0.12), transparent 34%);
    box-shadow:
      0 22px 42px rgba(15, 23, 42, 0.07),
      inset 0 1px 0 rgba(255, 255, 255, 0.72);
    backdrop-filter: blur(24px) saturate(140%);
    -webkit-backdrop-filter: blur(24px) saturate(140%);
  }

  .dashboard-card-shell::before {
    display: none;
  }

  .dashboard-card-shell::after {
    display: none;
  }

  .dashboard-card-shell > :not(.dashboard-shell-border-bevel):not(.dashboard-shell-inner-bevel):not(.dashboard-shell-top-edge):not(.dashboard-shell-side-edge) {
    position: relative;
    z-index: 2;
  }

  .dashboard-shell-border-bevel {
    border-radius: inherit;
    background: linear-gradient(135deg, rgba(200, 230, 255, 0.95) 0%, rgba(150, 200, 250, 0.6) 25%, rgba(110, 170, 230, 0.35) 50%, rgba(150, 200, 250, 0.6) 75%, rgba(200, 230, 255, 0.9) 100%);
    padding: 1.5px;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    z-index: 0;
  }

  .dashboard-shell-inner-bevel {
    border-radius: inherit;
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.35), inset 0 -1px 1px rgba(0,0,0,0.2);
    z-index: 0;
  }

  .dashboard-shell-top-edge {
    background: linear-gradient(90deg, transparent, rgba(210, 235, 255, 0.85) 15%, rgba(240, 250, 255, 0.95) 50%, rgba(210, 235, 255, 0.85) 85%, transparent);
    z-index: 0;
  }

  .dashboard-shell-side-edge-left {
    background: linear-gradient(180deg, transparent, rgba(180, 220, 255, 0.8) 15%, rgba(160, 205, 250, 0.7) 50%, rgba(180, 220, 255, 0.8) 85%, transparent);
    z-index: 0;
  }

  .dashboard-shell-side-edge-right {
    background: linear-gradient(180deg, transparent, rgba(180, 220, 255, 0.7) 15%, rgba(160, 205, 250, 0.6) 50%, rgba(180, 220, 255, 0.7) 85%, transparent);
    z-index: 0;
  }

  .dashboard-card-shell:has(.analytics-sidebar-glass) .dashboard-shell-border-bevel,
  .dashboard-card-shell:has(.analytics-sidebar-glass) .dashboard-shell-inner-bevel,
  .dashboard-card-shell:has(.analytics-sidebar-glass) .dashboard-shell-top-edge,
  .dashboard-card-shell:has(.analytics-sidebar-glass) .dashboard-shell-side-edge {
    display: none;
  }

  .dashboard-standalone-shell {
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .dashboard-standalone-shell::before,
  .dashboard-standalone-shell::after {
    display: none;
  }

  .dashboard-card-stage {
    position: relative;
    overflow: visible;
    border-radius: 28px;
    background: transparent;
    box-shadow: none;
  }

  .dashboard-card-stage::before {
    display: none;
  }

  .dashboard-card-stage > * {
    position: relative;
    z-index: 1;
  }

  .dashboard-card-stage-standalone {
    padding: 0;
    background: transparent;
  }

  .dashboard-insight-tray {
    position: relative;
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 10px;
    padding-top: 0;
  }

  .dashboard-insight-tray::before {
    display: none;
  }

  .dashboard-insight-tray-standalone {
    margin-top: 12px;
    padding-inline: 0;
  }

  .dashboard-insight-card {
    position: relative;
    width: auto;
    max-width: min(100%, 320px);
    flex: 0 1 320px;
    overflow: hidden;
    border-radius: 18px;
    padding: 12px 14px;
    backdrop-filter: blur(16px) saturate(145%);
    -webkit-backdrop-filter: blur(16px) saturate(145%);
  }

  .dashboard-standalone-shell .dashboard-insight-card {
    border-color: rgba(255, 255, 255, 0.14) !important;
    border-radius: 24px !important;
    background:
      radial-gradient(circle at 10% 0%, rgba(255, 255, 255, 0.14), transparent 26%),
      linear-gradient(145deg, rgba(72, 72, 74, 0.58) 0%, rgba(40, 40, 43, 0.72) 30%, rgba(22, 22, 24, 0.84) 100%) !important;
    box-shadow:
      0 24px 40px rgba(12, 12, 12, 0.18),
      inset 0 1px 0 rgba(255, 255, 255, 0.12),
      inset 0 -14px 20px rgba(0, 0, 0, 0.08) !important;
    backdrop-filter: blur(24px) saturate(125%) !important;
    -webkit-backdrop-filter: blur(24px) saturate(125%) !important;
  }

  .dashboard-standalone-shell .dashboard-insight-card::before {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0.03) 54%, transparent 100%) !important;
  }

  .dashboard-standalone-shell .dashboard-insight-card .text-slate-500,
  .dashboard-standalone-shell .dashboard-insight-card .text-slate-700,
  .dashboard-standalone-shell .dashboard-insight-card .text-slate-800,
  .dashboard-standalone-shell .dashboard-insight-card .text-slate-900 {
    color: rgba(242, 243, 245, 0.9) !important;
  }

  .dashboard-standalone-shell .dashboard-insight-card .bg-sky-400\/75 {
    background: rgba(125, 211, 252, 0.95) !important;
    box-shadow: 0 0 16px rgba(125, 211, 252, 0.45) !important;
  }

  .dashboard-standalone-shell .dashboard-insight-card .border-white\/70 {
    border-color: rgba(255, 255, 255, 0.14) !important;
  }

  .dashboard-standalone-shell .dashboard-insight-card .bg-white\/60 {
    background: rgba(255, 255, 255, 0.08) !important;
  }

  .dashboard-standalone-shell .dashboard-insight-card .text-\[8px\] {
    color: rgba(228, 231, 236, 0.62) !important;
  }

  .dashboard-insight-card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.02));
    pointer-events: none;
  }

  .dashboard-insight-card > * {
    position: relative;
    z-index: 1;
  }

  @media (hover: hover) {
    .dashboard-card-shell:hover {
      transform: translateY(-1px);
      box-shadow:
        0 24px 48px rgba(15, 23, 42, 0.08),
        inset 0 1px 0 rgba(255, 255, 255, 0.78);
    }
  }

  .dashboard-greeting-svg {
    display: block;
      width: min(100%, 860px);
    height: auto;
    overflow: visible;
    contain: paint;
    isolation: isolate;
  }

  .dashboard-greeting-svg-primed {
    opacity: 0;
  }

  .dashboard-greeting-svg-active {
    opacity: 1;
  }

  .dashboard-greeting-letter {
    font-family: ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
      font-size: 120px;
    font-weight: 700;
    letter-spacing: -0.06em;
    text-rendering: geometricPrecision;
  }

  .dashboard-greeting-reveal-rect {
    transform-box: fill-box;
    transform-origin: center top;
    transform: translateY(-10px) scaleY(0.06);
    opacity: 0;
    will-change: transform, opacity;
  }

  .dashboard-greeting-sheen-rect {
    transform-box: fill-box;
    transform-origin: center center;
    transform: translateX(-34px) scaleX(0.82);
    opacity: 0;
    will-change: transform, opacity;
  }

  .dashboard-greeting-sheen-rect-name {
    transform: translateX(-46px) scaleX(0.9);
  }

  .dashboard-deferred-body {
    animation: dashboard-body-enter 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
    contain: layout paint style;
  }

  .dashboard-deferred-body-priority {
    animation: none;
  }

  .dashboard-deferred-body-priority .dashboard-surface {
    animation: none;
  }

  @keyframes dashboard-surface-enter {
    from {
      opacity: 0;
      transform: translateY(16px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @keyframes dashboard-body-enter {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes dashboard-greeting-vertical-reveal {
    from {
      transform: translateY(-10px) scaleY(0.06);
      opacity: 0;
    }
    to {
      transform: translateY(0) scaleY(1);
      opacity: 1;
    }
  }

  @keyframes dashboard-greeting-sheen-pass {
    0% {
      transform: translateX(-40px) scaleX(0.78);
      opacity: 0;
    }
    14% {
      opacity: 0.18;
    }
    38% {
      opacity: 0.42;
    }
    62% {
      opacity: 0.3;
    }
    100% {
      transform: translateX(42px) scaleX(1.22);
      opacity: 0;
    }
  }

  @keyframes dashboard-greeting-sheen-pass-name {
    0% {
      transform: translateX(-56px) scaleX(0.88);
      opacity: 0;
    }
    12% {
      opacity: 0.2;
    }
    36% {
      opacity: 0.5;
    }
    68% {
      opacity: 0.34;
    }
    86% {
      opacity: 0.12;
    }
    100% {
      transform: translateX(60px) scaleX(1.34);
      opacity: 0;
    }
  }

  /* ── Analytics Chart Cards: Sidebar Liquid Glass (dashboard context) ── */
  .dashboard-card-shell:has(.analytics-sidebar-glass) {
    background: transparent !important;
    box-shadow: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  .dashboard-card-shell:has(.analytics-sidebar-glass)::before,
  .dashboard-card-shell:has(.analytics-sidebar-glass)::after {
    display: none !important;
  }

  .dashboard-card-shell .analytics-card-halo-wrap {
    position: relative;
    isolation: isolate;
    overflow: visible;
  }

  .dashboard-card-shell .analytics-card-halo-wrap::before {
    content: '';
    position: absolute;
    inset: -14px;
    border-radius: 33px;
    background: radial-gradient(closest-side, rgba(7, 18, 36, 0.22) 0%, rgba(7, 18, 36, 0.12) 50%, rgba(7, 18, 36, 0.04) 68%, transparent 82%);
    filter: blur(14px);
    opacity: 0.8;
    pointer-events: none;
    z-index: 0;
  }

  .dashboard-card-shell .analytics-card-halo-wrap > .analytics-sidebar-glass {
    position: relative;
    z-index: 1;
    background-color: #28456f !important;
    background-image:
      linear-gradient(315deg, rgba(85, 114, 170, 0.72) 0%, rgba(50, 80, 129, 0.8) 42%, rgba(31, 51, 90, 0.88) 100%),
      radial-gradient(circle at 82% 12%, rgba(255, 255, 255, 0.05) 0%, transparent 28%),
      radial-gradient(circle at 0% 100%, rgba(154, 197, 255, 0.06) 0%, transparent 34%) !important;
    box-shadow: 0 12px 24px -28px rgba(7, 18, 36, 0.32);
  }

  .dashboard-card-shell .analytics-card-halo-wrap > .analytics-sidebar-glass::after {
    display: none;
  }

  /* Brighten ONLY the dashboard card shell overlays (sidebar shell stays untouched) */
  .analytics-sidebar-glass > [aria-hidden]:nth-of-type(1) {
    background: conic-gradient(
      from 45deg at 50% 50%,
      rgba(255, 255, 255, 0.02) 0deg,
      rgba(185, 217, 247, 0.1) 32deg,
      rgba(250, 253, 255, 0.97) 88deg,
      rgba(188, 220, 248, 0.16) 132deg,
      rgba(255, 255, 255, 0.02) 180deg,
      rgba(185, 217, 247, 0.12) 212deg,
      rgba(247, 251, 255, 0.9) 268deg,
      rgba(185, 217, 247, 0.12) 316deg,
      rgba(255, 255, 255, 0.02) 360deg
    ) !important;
    padding: 0.9px !important;
  }

  .analytics-sidebar-glass > [aria-hidden]:nth-of-type(2) {
    display: none !important;
  }

  .analytics-sidebar-glass > [aria-hidden]:nth-of-type(3) {
    display: none !important;
  }

  .analytics-sidebar-glass > [aria-hidden]:nth-of-type(4) {
    display: none !important;
  }

  .analytics-sidebar-glass > [aria-hidden]:nth-of-type(5) {
    display: none !important;
  }

  .dashboard-card-shell .dashboard-balanced-analytics-card {
    min-height: 360px !important;
  }

  @media (min-width: 1280px) {
    .dashboard-card-shell .dashboard-balanced-analytics-card {
      min-height: 0 !important;
      aspect-ratio: 1.1 / 1 !important;
    }
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-header {
    padding-top: 1.9rem !important;
    padding-left: 1.95rem !important;
    padding-right: 1.8rem !important;
    padding-bottom: 0.7rem !important;
    background: transparent !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-body {
    padding-top: 0.15rem !important;
    padding-left: 1.2rem !important;
    padding-right: 1.2rem !important;
    padding-bottom: 1.35rem !important;
    background: transparent !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-title {
    color: rgba(248, 250, 252, 0.96) !important;
    text-shadow: 0 1px 0 rgba(8, 21, 41, 0.3);
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-title [class*="text-slate-"],
  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-title [class*="text-gray-"] {
    color: rgba(221, 235, 250, 0.74) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass [class*="bg-emerald-100"],
  .dashboard-card-shell .analytics-sidebar-glass [class*="bg-sky-100"],
  .dashboard-card-shell .analytics-sidebar-glass [class*="bg-blue-100"],
  .dashboard-card-shell .analytics-sidebar-glass [class*="bg-purple-100"] {
    border: 1px solid rgba(255, 255, 255, 0.16) !important;
    background: rgba(26, 58, 92, 0.52) !important;
    color: rgba(255, 255, 255, 0.92) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
    backdrop-filter: blur(4px) !important;
    -webkit-backdrop-filter: blur(4px) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-divider {
    border-top-color: rgba(200, 230, 255, 0.28) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .text-slate-400,
  .dashboard-card-shell .analytics-sidebar-glass .text-slate-500,
  .dashboard-card-shell .analytics-sidebar-glass .text-slate-600,
  .dashboard-card-shell .analytics-sidebar-glass .text-slate-700,
  .dashboard-card-shell .analytics-sidebar-glass .text-slate-800 {
    color: rgba(230, 239, 250, 0.74) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass svg text {
    fill: rgba(232, 241, 251, 0.76) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass svg line {
    stroke: rgba(214, 233, 255, 0.2) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass svg rect[fill="#eff6ff"] {
    fill: rgba(255, 255, 255, 0.08) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass svg circle[stroke="#ffffff"] {
    stroke: rgba(255, 255, 255, 0.82) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-expand-btn,
  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-info-btn,
  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-select {
    border-color: rgba(255, 255, 255, 0.15) !important;
    background: rgba(26, 58, 92, 0.50) !important;
    color: rgba(255, 255, 255, 0.86) !important;
    box-shadow: none !important;
    backdrop-filter: blur(4px) !important;
    -webkit-backdrop-filter: blur(4px) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-expand-btn:hover,
  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-info-btn:hover {
    background: rgba(42, 80, 128, 0.60) !important;
    color: rgba(255, 255, 255, 0.96) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-select:hover,
  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-select:focus {
    border-color: rgba(255, 255, 255, 0.24) !important;
    background: rgba(42, 80, 128, 0.60) !important;
    color: rgba(255, 255, 255, 0.96) !important;
    outline: none;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-select option {
    background: #1a3a5c !important;
    color: #f8fafc !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-toggle {
    border-color: rgba(255, 255, 255, 0.15) !important;
    background: rgba(26, 58, 92, 0.50) !important;
    box-shadow: none !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-toggle button {
    color: rgba(255, 255, 255, 0.82) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-toggle button[class*="bg-sky"] {
    border: 1px solid rgba(255, 255, 255, 0.22) !important;
    background: rgba(59, 110, 168, 0.92) !important;
    color: rgba(255, 255, 255, 0.96) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18) !important;
  }

  .dashboard-card-shell .analytics-sidebar-glass .analytics-glass-toggle button:hover:not([class*="bg-sky"]) {
    background: rgba(42, 80, 128, 0.60) !important;
    color: rgba(255, 255, 255, 0.88) !important;
  }

  .dashboard-overview {
    animation: dashboard-surface-enter 560ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  /*
   * Edge-lit liquid-glass treatment shared by EVERY card/chip on the dark fluid
   * canvas. The illuminated gradient border ring + inset bevel are replicated
   * 1:1 from the loved "Additional Analytics" card (.dashboard-shell-border-bevel
   * + .dashboard-shell-inner-bevel) so all fluid-UI cards match exactly.
   */
  .dashboard-overview-glass {
    position: relative;
    isolation: isolate;
    border-radius: 24px;
    border: 0;
    background:
      linear-gradient(150deg, rgba(255, 255, 255, 0.13) 0%, rgba(255, 255, 255, 0.05) 52%, rgba(148, 163, 184, 0.05) 100%);
    box-shadow:
      0 22px 48px rgba(5, 12, 26, 0.36),
      inset 0 1px 2px rgba(255, 255, 255, 0.35),
      inset 0 -1px 1px rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    transition: transform 360ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 360ms ease;
  }

  /* Illuminated gradient border ring (padding + mask-composite exclude) — the
     exact edge-lighting from the Additional Analytics cards. */
  .dashboard-overview-glass::before,
  .dashboard-overview-chip::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1.5px;
    background: linear-gradient(135deg, rgba(200, 230, 255, 0.95) 0%, rgba(150, 200, 250, 0.6) 25%, rgba(110, 170, 230, 0.35) 50%, rgba(150, 200, 250, 0.6) 75%, rgba(200, 230, 255, 0.9) 100%);
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    pointer-events: none;
    z-index: 0;
  }

  .dashboard-overview-glass::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(120% 90% at 50% -10%, rgba(255, 255, 255, 0.10), transparent 60%);
    opacity: 0.8;
    pointer-events: none;
    z-index: 0;
  }

  .dashboard-overview-glass > * {
    position: relative;
    z-index: 1;
  }

  .dashboard-overview-glass-interactive {
    cursor: pointer;
  }

  .dashboard-overview-glass-interactive:hover {
    transform: translateY(-3px);
    box-shadow:
      0 30px 60px rgba(5, 12, 26, 0.46),
      inset 0 1px 2px rgba(255, 255, 255, 0.45),
      inset 0 -1px 1px rgba(0, 0, 0, 0.22);
  }

  .dashboard-overview-glass-interactive:hover::before,
  .dashboard-overview-chip:hover::before {
    background: linear-gradient(135deg, rgba(216, 240, 255, 1) 0%, rgba(168, 212, 255, 0.78) 25%, rgba(128, 188, 242, 0.5) 50%, rgba(168, 212, 255, 0.78) 75%, rgba(216, 240, 255, 1) 100%);
  }

  .dashboard-overview-chip {
    position: relative;
    isolation: isolate;
    border: 0;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(226, 232, 240, 0.92);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.24),
      inset 0 -1px 1px rgba(0, 0, 0, 0.18);
    transition: background 220ms ease, color 220ms ease, transform 220ms ease;
  }

  .dashboard-overview-chip > * {
    position: relative;
    z-index: 1;
  }

  .dashboard-overview-chip:hover {
    background: rgba(255, 255, 255, 0.16);
    color: #ffffff;
    transform: translateY(-1px);
  }

  .dashboard-overview-action {
    position: relative;
    isolation: isolate;
    border: 0;
    background: rgba(255, 255, 255, 0.06);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.22),
      inset 0 -1px 1px rgba(0, 0, 0, 0.18);
    transition: background 220ms ease, transform 220ms ease, box-shadow 220ms ease;
  }

  .dashboard-overview-action:hover {
    background: rgba(255, 255, 255, 0.12);
    transform: translateY(-2px);
    box-shadow:
      0 16px 32px rgba(5, 12, 26, 0.32),
      inset 0 1px 1px rgba(255, 255, 255, 0.28),
      inset 0 -1px 1px rgba(0, 0, 0, 0.2);
  }

  .dashboard-overview-action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    transition: transform 220ms ease;
  }

  .dashboard-overview-action:hover .dashboard-overview-action-icon {
    transform: scale(1.06);
  }

  .dashboard-overview-sparkline-fill {
    animation: dashboard-overview-fade 720ms ease both;
  }

  @keyframes dashboard-overview-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
`;

const SURFACE_LIBRARY: DashboardSurfaceDefinition[] = [
  {
    id: 'property-overview',
    title: 'Property Overview',
    source: 'Portfolio overview',
    gridClass: 'xl:col-span-6',
    cardClass: 'min-h-[260px] xl:min-h-[280px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['property overview', 'overview details', 'overview card', 'property details', 'valuation', 'mortgage', 'context', 'avm'],
  },
  {
    id: 'avm-history',
    title: 'Estimated Value History',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['price history', 'avm history', 'price history avm', 'valuation history', 'avm trend', 'property value', 'property values', 'total property value', 'real estate value', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'cash-flow-graph',
    title: 'Cash Flow Graph',
    source: 'Analysis cash flow',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['cash flow', 'cash flow graph', 'property cash flow', 'rental cash flow', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'income-expenses',
    title: 'Income - Expenses',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['income expenses', 'income - expenses', 'income vs expenses', 'expense breakdown', 'operating expenses', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'tax-history',
    title: 'Tax History',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['tax history', 'property taxes', 'tax trend', 'tax graph', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'coc-return',
    title: 'Cash-on-Cash Return',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['coc return', 'cash on cash', 'cash on cash return', 'coc', 'roi graph', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'mortgage-amortization',
    title: 'Mortgage Amortization',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['mortgage amortization', 'loan balance', 'principal interest', 'amortization', 'mortgage chart', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'net-operating-income',
    title: 'Net Operating Income',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['net operating income', 'noi', 'cap rate', 'operating income', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'equity-appreciation',
    title: 'Equity & Appreciation',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['equity appreciation', 'equity and appreciation', 'property value', 'equity graph', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'total-return',
    title: 'Total Return',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['total return', 'cumulative return', 'wealth creation', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'irr-holding-period',
    title: 'IRR by Holding Period',
    source: 'Additional analytics',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['irr', 'holding period irr', 'internal rate of return', 'exit year irr', 'property analytics', 'additional analytics', 'analytics'],
  },
  {
    id: 'reserve-summary',
    title: 'Reserve Summary',
    source: 'Bookkeeping',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['cash reserves', 'reserves', 'reserve summary', 'bookkeeping', 'liquidity'],
  },
  {
    id: 'portfolio-overview-price-history',
    title: 'Portfolio Value History',
    source: 'Portfolio overview card',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['portfolio overview price history', 'overview avm', 'overview price history', 'compact avm card', 'estimated value history'],
  },
  {
    id: 'portfolio-overview-cash-flow',
    title: 'Portfolio Cash Flow',
    source: 'Portfolio overview card',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['portfolio overview cash flow', 'overview cash flow', 'compact cash flow card'],
  },
  {
    id: 'portfolio-overview-tax-history',
    title: 'Property Tax History',
    source: 'Portfolio overview card',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['portfolio overview tax history', 'overview tax history', 'compact tax card'],
  },
  {
    id: 'portfolio-overview-tenant-correspondence-summary',
    title: 'Tenant Correspondence Summary',
    source: 'Portfolio overview card',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['tenant correspondence summary', 'tenant message summary', 'tenant communication summary', 'portfolio tenant summary'],
  },
  {
    id: 'property-image',
    title: 'Property Image',
    source: 'Property media',
    gridClass: 'md:col-span-6 xl:col-span-4',
    cardClass: 'min-h-[360px] xl:min-h-[420px]',
    defaultSize: 'third',
    defaultHeight: 'tall',
    keywords: ['property image', 'property photo', 'street view', 'listing image', 'property exterior'],
  },
  {
    id: 'property-details-overview',
    title: 'Property Details Overview',
    source: 'Property workspace',
    cardClass: 'min-h-[520px] xl:min-h-[620px]',
    defaultSize: 'wide',
    defaultHeight: 'hero',
    keywords: ['property details overview', 'expanded property overview', 'property modal overview'],
  },
  {
    id: 'property-details-tax-history',
    title: 'Property Details Tax History',
    source: 'Property workspace',
    cardClass: 'min-h-[560px] xl:min-h-[660px]',
    defaultSize: 'wide',
    defaultHeight: 'hero',
    keywords: ['property details tax history', 'expanded tax history', 'property modal taxes'],
  },
  {
    id: 'property-details-mortgage',
    title: 'Property Details Mortgage',
    source: 'Property workspace',
    cardClass: 'min-h-[460px] xl:min-h-[560px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['property details mortgage', 'expanded mortgage info', 'assumability'],
  },
  {
    id: 'property-details-owner',
    title: 'Property Details Owner Information',
    source: 'Property workspace',
    cardClass: 'min-h-[360px] xl:min-h-[420px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['property owner', 'owner information', 'owner details', 'absentee owner'],
  },
  {
    id: 'property-details-environmental',
    title: 'Property Details Environmental Risks',
    source: 'Property workspace',
    cardClass: 'min-h-[360px] xl:min-h-[420px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['environmental risks', 'expanded environmental risks', 'property risks'],
  },
  {
    id: 'property-details-schools',
    title: 'Property Details Nearby Schools',
    source: 'Property workspace',
    cardClass: 'min-h-[560px] xl:min-h-[680px]',
    defaultSize: 'wide',
    defaultHeight: 'hero',
    keywords: ['nearby schools', 'property details schools', 'school district'],
  },
  {
    id: 'property-details-building-permits',
    title: 'Property Details Building Permits',
    source: 'Property workspace',
    cardClass: 'min-h-[560px] xl:min-h-[680px]',
    defaultSize: 'wide',
    defaultHeight: 'hero',
    keywords: ['building permits', 'property permits', 'permit history'],
  },
  {
    id: 'property-details-sale-history',
    title: 'Property Details Last Sale',
    source: 'Property workspace',
    cardClass: 'min-h-[280px] xl:min-h-[320px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['last sale', 'property sale history', 'expanded last sale'],
  },
  {
    id: 'property-details-location',
    title: 'Property Details Location',
    source: 'Property workspace',
    cardClass: 'min-h-[280px] xl:min-h-[320px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['location details', 'property location details', 'zoning county municipality'],
  },
  {
    id: 'rental-pricing-power',
    title: 'Rental Pricing Power',
    source: 'Portfolio rental pricing',
    gridClass: 'md:col-span-12',
    cardClass: 'min-h-[920px] xl:min-h-[1120px]',
    defaultSize: 'full',
    defaultHeight: 'hero',
    keywords: ['rental pricing power', 'rent pricing', 'pricing power', 'recommended rent', 'market supported pricing'],
  },
  {
    id: 'rental-pricing-power-bar-comparison',
    title: 'Rental Pricing Comparison',
    source: 'Rental pricing power',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['rental pricing comparison', 'current vs market rent', 'recommended rent bars'],
  },
  {
    id: 'rental-pricing-power-comparable-listings-map',
    title: 'Rental Pricing Comparable Listings Map',
    source: 'Rental pricing power',
    cardClass: 'min-h-[460px] xl:min-h-[520px]',
    defaultSize: 'half',
    defaultHeight: 'hero',
    keywords: ['rental pricing comp map', 'comparable listings map', 'rent comp map'],
  },
  {
    id: 'rental-pricing-power-strategy',
    title: 'Rental Pricing Strategy',
    source: 'Rental pricing power',
    cardClass: 'min-h-[220px] xl:min-h-[260px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['rental pricing strategy', 'market supported pricing strategy', 'pricing power score'],
  },
  {
    id: 'rental-pricing-power-rent-sweep',
    title: 'Rental Pricing Rent Sweep',
    source: 'Rental pricing power',
    cardClass: 'min-h-[280px] xl:min-h-[340px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['rent sweep', 'interactive rent sweep', 'pricing slider'],
  },
  {
    id: 'rental-pricing-power-model-metrics',
    title: 'Rental Pricing Model Metrics',
    source: 'Rental pricing power',
    cardClass: 'min-h-[300px] xl:min-h-[340px]',
    defaultSize: 'half',
    defaultHeight: 'tall',
    keywords: ['pricing model metrics', 'vacancy target metrics', 'pricing outputs'],
  },
  {
    id: 'rental-pricing-power-vacancy-cutoff',
    title: 'Rental Pricing Vacancy Cutoff',
    source: 'Rental pricing power',
    cardClass: 'min-h-[180px] xl:min-h-[220px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['vacancy cutoff', 'market rejection point', 'vacancy logic'],
  },
  {
    id: 'rental-pricing-power-renovation-separation',
    title: 'Rental Pricing Renovation Guidance',
    source: 'Rental pricing power',
    cardClass: 'min-h-[180px] xl:min-h-[220px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['renovation guidance', 'renovation analysis is separate', 'pricing renovation guidance'],
  },
  {
    id: 'rental-pricing-power-market-conditions',
    title: 'Rental Pricing Market Conditions',
    source: 'Rental pricing power',
    cardClass: 'min-h-[420px] xl:min-h-[540px]',
    defaultSize: 'wide',
    defaultHeight: 'hero',
    keywords: ['rental pricing market conditions', 'market conditions', 'pricing macro signals'],
  },
  {
    id: 'rental-pricing-power-local-leasing-signals',
    title: 'Rental Pricing Local Leasing Signals',
    source: 'Rental pricing power',
    cardClass: 'min-h-[280px] xl:min-h-[340px]',
    defaultSize: 'wide',
    defaultHeight: 'tall',
    keywords: ['local leasing signals', 'leasing signals', 'rental pricing local signals'],
  },
  {
    id: 'rental-pricing-power-renovation-analysis-link',
    title: 'Rental Pricing Renovation CTA',
    source: 'Rental pricing power',
    cardClass: 'min-h-[180px] xl:min-h-[220px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['renovation cta', 'go to renovation analysis', 'pricing renovation link'],
  },
  {
    id: 'tax-pdf-viewer',
    title: 'Tax PDF Viewer',
    source: 'Tax center',
    gridClass: 'md:col-span-12 xl:col-span-8',
    cardClass: 'min-h-[420px] xl:min-h-[500px]',
    defaultSize: 'wide',
    defaultHeight: 'hero',
    keywords: ['tax pdf', 'pdf viewer', 'cpa pdf', 'schedule e pdf', 'tax packet'],
  },
  {
    id: 'irs-draft-forms',
    title: 'IRS Draft Forms',
    source: 'Tax workspace',
    gridClass: 'md:col-span-12',
    cardClass: 'min-h-[620px] xl:min-h-[760px]',
    defaultSize: 'full',
    defaultHeight: 'hero',
    keywords: ['irs draft forms', 'schedule e draft', 'taxpayer profile', 'irs preview'],
  },
  {
    id: 'maintenance-summary',
    title: 'Maintenance Snapshot',
    source: 'Predictive maintenance',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'third',
    defaultHeight: 'standard',
    keywords: ['predictive maintenance', 'maintenance', 'maintenance snapshot', 'sensor', 'alerts', 'hvac'],
  },
  {
    id: 'bookkeeping-trend',
    title: 'Income, Expenses, and Net',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'wide',
    defaultHeight: 'tall',
    keywords: ['bookkeeping trend', 'cash flow trend', 'income trend', 'expense trend', 'trend graph', 'monthly trend', 'income expenses net'],
  },
  {
    id: 'bookkeeping-cash-balance-history',
    title: 'Cash Balance by Month',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'wide',
    defaultHeight: 'tall',
    keywords: ['cash balance by month', 'cash balance history', 'cash history', 'ending cash chart'],
  },
  {
    id: 'bookkeeping-cash-balance',
    title: 'Cash Balance',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[120px] xl:min-h-[140px]',
    defaultSize: 'third',
    defaultHeight: 'compact',
    keywords: ['cash balance', 'operating cash', 'account 1000 cash'],
  },
  {
    id: 'bookkeeping-reserve-runway',
    title: 'Reserve Runway',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[120px] xl:min-h-[140px]',
    defaultSize: 'third',
    defaultHeight: 'compact',
    keywords: ['reserve runway', 'runway', 'months of reserve', 'reserve coverage'],
  },
  {
    id: 'bookkeeping-average-net',
    title: 'Average Net',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[120px] xl:min-h-[140px]',
    defaultSize: 'third',
    defaultHeight: 'compact',
    keywords: ['average net', 'trailing average net', 'average monthly net'],
  },
  {
    id: 'bookkeeping-data-quality',
    title: 'Data Quality',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[120px] xl:min-h-[140px]',
    defaultSize: 'third',
    defaultHeight: 'compact',
    keywords: ['data quality', 'bookkeeping data quality', 'recon evidence docs'],
  },
  {
    id: 'bookkeeping-analytics-explanations',
    title: 'Analytics Explanations',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[420px] xl:min-h-[560px]',
    defaultSize: 'half',
    defaultHeight: 'hero',
    keywords: ['analytics explanations', 'explain analytics snapshot', 'bookkeeping citations', 'why cash balance'],
  },
  {
    id: 'bookkeeping-reserve-posture',
    title: 'Reserve Posture',
    source: 'Bookkeeping analytics',
    cardClass: 'min-h-[220px] xl:min-h-[260px]',
    defaultSize: 'half',
    defaultHeight: 'standard',
    keywords: ['reserve posture', 'cash coverage posture', 'reserve health'],
  },
  {
    id: 'bookkeeping-analytics-foundation',
    title: 'Bookkeeping Analytics Foundation',
    source: 'Bookkeeping analytics',
    gridClass: 'md:col-span-12',
    cardClass: 'min-h-[620px] xl:min-h-[760px]',
    defaultSize: 'full',
    defaultHeight: 'hero',
    keywords: ['bookkeeping analytics foundation', 'bookkeeping analytics', 'ledger analytics', 'finance analytics', 'bookkeeping overview'],
  },
  ...INCOME_PROJECTION_DASHBOARD_ASSETS.map((asset) => ({
    id: asset.id,
    title: asset.title,
    source: DASHBOARD_INCOME_PROJECTIONS_TAB_SOURCES[asset.tab],
    cardClass: asset.cardClass,
    defaultSize: asset.defaultSize,
    defaultHeight: asset.defaultHeight,
    keywords: asset.keywords,
  })),
  ...MARKET_INSIGHTS_DASHBOARD_ASSETS.map((asset) => ({
    id: asset.id,
    title: asset.title,
    source: DASHBOARD_MARKET_INSIGHTS_TAB_SOURCES[asset.tab],
    cardClass: asset.cardClass,
    defaultSize: asset.defaultSize,
    defaultHeight: asset.defaultHeight,
    keywords: asset.keywords,
  })),
  {
    id: 'workflow-shortcuts',
    title: 'Workflow Shortcuts',
    source: 'Website controls',
    gridClass: 'md:col-span-12 xl:col-span-8',
    cardClass: 'min-h-[240px] xl:min-h-[260px]',
    defaultSize: 'wide',
    defaultHeight: 'standard',
    keywords: ['workflow', 'workflow shortcuts', 'control center', 'controls', 'collect payment', 'add tenant', 'quickbooks', 'mortgage rate', 'renovation planner'],
  },
  {
    id: 'weekly-recap',
    title: 'Your Week',
    source: 'Weekly recap',
    gridClass: 'md:col-span-12 xl:col-span-4',
    cardClass: 'min-h-[320px] xl:min-h-[360px]',
    defaultSize: 'wide',
    defaultHeight: 'tall',
    keywords: ['weekly recap', 'your week', 'week in review', 'weekly summary', 'weekly digest', 'this week', 'week recap'],
  },
];

const REMOVED_PERSONAL_FINANCE_SURFACE_IDS = new Set<DashboardSurfaceId>([
  'net-worth-graph',
  'portfolio-allocation',
  'allocation-flow',
]);

const DEFAULT_SURFACE_IDS: DashboardSurfaceId[] = [
  'property-overview',
  'cash-flow-graph',
  'bookkeeping-trend',
  'maintenance-summary',
];

const DASHBOARD_SURFACE_INTENT_ALIASES: Partial<Record<DashboardSurfaceId, string[]>> = {
  'property-overview': ['property overview', 'portfolio overview', 'property summary', 'property page', 'property details'],
  'avm-history': ['price history', 'avm history', 'valuation history', 'value history', 'property value', 'property values', 'total property value', 'real estate value'],
  'portfolio-overview-price-history': ['portfolio overview price history', 'overview avm', 'compact avm card'],
  'portfolio-overview-cash-flow': ['portfolio overview cash flow', 'overview cash flow', 'compact cash flow card'],
  'portfolio-overview-tax-history': ['portfolio overview tax history', 'overview tax history', 'compact tax card'],
  'portfolio-overview-tenant-correspondence-summary': ['tenant correspondence summary', 'tenant message summary', 'tenant communications', 'tenant summary'],
  'cash-flow-graph': ['cash flow', 'cashflow', 'portfolio cash flow', 'rental cash flow'],
  'income-expenses': ['income expenses', 'income vs expenses', 'expense breakdown', 'income and expenses'],
  'tax-history': ['tax history', 'property taxes', 'tax trend'],
  'coc-return': ['cash on cash', 'coc return', 'cash on cash return'],
  'mortgage-amortization': ['mortgage amortization', 'loan balance', 'principal and interest'],
  'net-operating-income': ['net operating income', 'noi', 'operating income'],
  'equity-appreciation': ['equity and appreciation', 'equity appreciation', 'property value growth'],
  'total-return': ['total return', 'cumulative return', 'wealth creation'],
  'irr-holding-period': ['irr by holding period', 'holding period irr', 'irr'],
  'reserve-summary': ['reserve summary', 'cash reserves', 'reserves', 'liquidity'],
  'property-image': ['property image', 'property photo', 'street view', 'listing image', 'property exterior'],
  'property-details-overview': ['property details overview', 'expanded property overview', 'modal overview'],
  'property-details-tax-history': ['property details tax history', 'expanded tax history', 'modal taxes'],
  'property-details-mortgage': ['property details mortgage', 'mortgage info', 'assumability'],
  'property-details-owner': ['property owner', 'owner information', 'owner details', 'absentee owner'],
  'property-details-environmental': ['environmental risks', 'property risk grid', 'expanded environmental risks'],
  'property-details-schools': ['nearby schools', 'school district', 'property schools'],
  'property-details-building-permits': ['building permits', 'permit history', 'property permits'],
  'property-details-sale-history': ['last sale', 'sale history', 'property sale'],
  'property-details-location': ['location details', 'zoning', 'county', 'municipality'],
  'rental-pricing-power': ['rental pricing power', 'rent pricing power', 'pricing power analysis', 'recommended rent analysis'],
  'rental-pricing-power-bar-comparison': ['rental pricing comparison', 'current vs market rent', 'recommended rent bars'],
  'rental-pricing-power-comparable-listings-map': ['rental pricing comp map', 'comparable listings map', 'rent comp map'],
  'rental-pricing-power-strategy': ['rental pricing strategy', 'market supported pricing strategy', 'pricing power score'],
  'rental-pricing-power-rent-sweep': ['rent sweep', 'interactive rent sweep', 'pricing slider'],
  'rental-pricing-power-model-metrics': ['pricing model metrics', 'target vacancy metrics', 'pricing model outputs'],
  'rental-pricing-power-vacancy-cutoff': ['vacancy cutoff', 'market rejection point', 'vacancy cutoff logic'],
  'rental-pricing-power-renovation-separation': ['renovation guidance', 'renovation analysis separate', 'pricing renovation guidance'],
  'rental-pricing-power-market-conditions': ['market conditions', 'pricing market conditions', 'pricing macro signals'],
  'rental-pricing-power-local-leasing-signals': ['local leasing signals', 'leasing signals', 'pricing local signals'],
  'rental-pricing-power-renovation-analysis-link': ['renovation cta', 'go to renovation analysis', 'pricing renovation link'],
  'tax-pdf-viewer': ['tax pdf', 'pdf viewer', 'cpa pdf', 'schedule e pdf', 'tax packet'],
  'irs-draft-forms': ['irs draft forms', 'schedule e draft', 'taxpayer profile', 'draft forms', 'irs preview'],
  'maintenance-summary': ['maintenance snapshot', 'maintenance', 'predictive maintenance'],
  'bookkeeping-trend': ['bookkeeping trend', 'income trend', 'expense trend', 'cash flow trend', 'income expenses net', 'income expenses net chart'],
  'bookkeeping-cash-balance-history': ['cash balance by month', 'cash balance history', 'cash history', 'ending cash balance graph'],
  'bookkeeping-cash-balance': ['cash balance', 'operating cash', 'cash number'],
  'bookkeeping-reserve-runway': ['reserve runway', 'runway', 'reserve coverage months'],
  'bookkeeping-average-net': ['average net', 'average monthly net', 'trailing average net'],
  'bookkeeping-data-quality': ['data quality', 'quality items', 'recon evidence docs'],
  'bookkeeping-analytics-explanations': ['analytics explanations', 'explain this analytics snapshot', 'bookkeeping citations'],
  'bookkeeping-reserve-posture': ['reserve posture', 'cash coverage posture', 'reserve health'],
  'bookkeeping-analytics-foundation': ['bookkeeping analytics foundation', 'bookkeeping analytics', 'ledger analytics', 'analytics foundation', 'bookkeeping overview'],
  ...DASHBOARD_INCOME_PROJECTIONS_SURFACE_ALIASES,
  ...DASHBOARD_MARKET_INSIGHTS_SURFACE_ALIASES,
  'workflow-shortcuts': ['workflow shortcuts', 'workflow controls', 'control center', 'quick actions'],
};

const PROPERTY_MANAGEMENT_FINANCE_ACTION_IDS = [
  'nav-property-management',
  'property-management-documents-tab',
  'property-management-bookkeeping-tab',
  'property-management-tax-tab',
  'open-quickbooks-modal',
];

const TENANT_PIPELINE_ACTION_IDS = [
  'property-management-tenants-tab',
  'property-management-add-tenant',
  'property-management-screen-applicant',
];

const LEASING_PAYMENTS_ACTION_IDS = [
  'property-management-send-payment-request',
  'open-payment-modal',
  'property-management-create-listing',
];

const MAINTENANCE_COMMAND_ACTION_IDS = [
  'property-management-maintenance-tab',
  'open-maintenance-modal',
  'nav-sensors',
];

const FEATURED_WORKFLOW_ACTION_IDS = [
  'open-payment-modal',
  'add-tenant',
  'open-maintenance-modal',
  'upload-document',
  'open-messaging-modal',
  'add-property',
];

const ANALYTICS_SUITE_SURFACE_IDS: DashboardSurfaceId[] = [
  'avm-history',
  'cash-flow-graph',
  'income-expenses',
  'tax-history',
  'coc-return',
  'mortgage-amortization',
  'net-operating-income',
  'equity-appreciation',
  'total-return',
  'irr-holding-period',
  'rental-pricing-power',
];

const SURFACE_LIBRARY_INDEX = Object.fromEntries(
  SURFACE_LIBRARY.map((surface, index) => [surface.id, index]),
) as Record<DashboardSurfaceId, number>;

const DASHBOARD_ANNOTATION_PLACEMENTS: DashboardAnnotationPlacement[] = [
  'top-left',
  'top',
  'top-right',
  'right',
  'bottom-right',
  'bottom',
  'bottom-left',
  'left',
  'center',
];

const DASHBOARD_ANNOTATION_TONES: DashboardAnnotationTone[] = ['neutral', 'info', 'success', 'warning'];
const DASHBOARD_ANNOTATION_WIDTHS: DashboardAnnotationWidth[] = ['sm', 'md', 'lg'];

function isDashboardSurfaceSize(value: unknown): value is DashboardSurfaceSize {
  return value === 'full' || value === 'wide' || value === 'half' || value === 'third';
}

function isDashboardSurfaceHeight(value: unknown): value is DashboardSurfaceHeight {
  return value === 'compact' || value === 'standard' || value === 'tall' || value === 'hero';
}

function isDashboardAnnotationPlacement(value: unknown): value is DashboardAnnotationPlacement {
  return typeof value === 'string' && DASHBOARD_ANNOTATION_PLACEMENTS.includes(value as DashboardAnnotationPlacement);
}

function isDashboardAnnotationTone(value: unknown): value is DashboardAnnotationTone {
  return typeof value === 'string' && DASHBOARD_ANNOTATION_TONES.includes(value as DashboardAnnotationTone);
}

function isDashboardAnnotationWidth(value: unknown): value is DashboardAnnotationWidth {
  return typeof value === 'string' && DASHBOARD_ANNOTATION_WIDTHS.includes(value as DashboardAnnotationWidth);
}
const DASHBOARD_SCENE_WIDTH = 1200;
const DASHBOARD_SCENE_GAP = 18;
const DASHBOARD_SCENE_COLUMN_COUNT = 12;
const DASHBOARD_SCENE_MIN_HEIGHT = 720;
const DASHBOARD_SCENE_FOCUSED_MIN_HEIGHT = 460;
const DASHBOARD_SCENE_CARD_MIN_WIDTH = 240;
const DASHBOARD_SCENE_CARD_MAX_WIDTH = DASHBOARD_SCENE_WIDTH;
const DASHBOARD_SCENE_CARD_MIN_HEIGHT = 220;
const DASHBOARD_SCENE_CARD_MAX_HEIGHT = 560;
const DASHBOARD_STANDALONE_ANALYTICS_SURFACE_MIN_HEIGHT = 420;
const DASHBOARD_STANDALONE_SOURCE_SURFACE_MIN_HEIGHTS: Partial<Record<DashboardSurfaceId, number>> = {
  'portfolio-overview-price-history': 420,
  'portfolio-overview-cash-flow': 420,
  'portfolio-overview-tax-history': 420,
  'portfolio-overview-tenant-correspondence-summary': 420,
  'property-details-overview': 620,
  'property-details-tax-history': 680,
  'property-details-mortgage': 560,
  'property-details-owner': 420,
  'property-details-environmental': 420,
  'property-details-schools': 720,
  'property-details-building-permits': 720,
  'property-details-sale-history': 320,
  'property-details-location': 320,
  'rental-pricing-power': 1120,
  'rental-pricing-power-bar-comparison': 360,
  'rental-pricing-power-comparable-listings-map': 520,
  'rental-pricing-power-strategy': 280,
  'rental-pricing-power-rent-sweep': 340,
  'rental-pricing-power-model-metrics': 340,
  'rental-pricing-power-vacancy-cutoff': 220,
  'rental-pricing-power-renovation-separation': 220,
  'rental-pricing-power-market-conditions': 560,
  'rental-pricing-power-local-leasing-signals': 360,
  'rental-pricing-power-renovation-analysis-link': 220,
  'bookkeeping-analytics-foundation': 920,
  'bookkeeping-analytics-explanations': 620,
  ...DASHBOARD_INCOME_PROJECTIONS_SURFACE_MIN_HEIGHTS,
  ...DASHBOARD_MARKET_INSIGHTS_SURFACE_MIN_HEIGHTS,
  'irs-draft-forms': 820,
};
const DASHBOARD_ANNOTATION_PERCENT_MIN = 0;
const DASHBOARD_ANNOTATION_PERCENT_MAX = 100;
const DASHBOARD_SCENE_SIZE_SPANS: Record<DashboardSurfaceSize, number> = {
  full: 12,
  wide: 8,
  half: 6,
  third: 4,
};
const DASHBOARD_SCENE_HEIGHTS: Record<DashboardSurfaceHeight, number> = {
  compact: 240,
  standard: 280,
  tall: 340,
  hero: 420,
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getDashboardSceneColumnWidth() {
  return (DASHBOARD_SCENE_WIDTH - (DASHBOARD_SCENE_GAP * (DASHBOARD_SCENE_COLUMN_COUNT - 1))) / DASHBOARD_SCENE_COLUMN_COUNT;
}

function getSceneWidthForSize(size: DashboardSurfaceSize) {
  const columnWidth = getDashboardSceneColumnWidth();
  const span = DASHBOARD_SCENE_SIZE_SPANS[size];

  return Math.round((columnWidth * span) + (DASHBOARD_SCENE_GAP * (span - 1)));
}

function getSceneHeightForPreset(height: DashboardSurfaceHeight) {
  return DASHBOARD_SCENE_HEIGHTS[height];
}

function getEffectiveSurfaceHeight(surfaceId: DashboardSurfaceId, height: number) {
  if (isPropertyAnalyticsSurfaceId(surfaceId)) {
    return Math.max(height, DASHBOARD_STANDALONE_ANALYTICS_SURFACE_MIN_HEIGHT);
  }

  const standaloneMinHeight = DASHBOARD_STANDALONE_SOURCE_SURFACE_MIN_HEIGHTS[surfaceId];
  return standaloneMinHeight ? Math.max(height, standaloneMinHeight) : height;
}

function clampSceneWidth(width: number) {
  return clampNumber(Math.round(width), DASHBOARD_SCENE_CARD_MIN_WIDTH, DASHBOARD_SCENE_CARD_MAX_WIDTH);
}

function clampSceneHeight(height: number) {
  return clampNumber(Math.round(height), DASHBOARD_SCENE_CARD_MIN_HEIGHT, DASHBOARD_SCENE_CARD_MAX_HEIGHT);
}

function clampSceneX(x: number, width: number) {
  return clampNumber(Math.round(x), 0, Math.max(DASHBOARD_SCENE_WIDTH - width, 0));
}

function clampSceneY(y: number) {
  return Math.max(0, Math.round(y));
}

function hasExplicitSceneGeometry(layoutPatch: DashboardSurfaceLayoutPatch) {
  return typeof layoutPatch.x === 'number'
    || typeof layoutPatch.y === 'number'
    || typeof layoutPatch.w === 'number'
    || typeof layoutPatch.h === 'number';
}

function getPackedSceneFrames(
  surfaceIds: DashboardSurfaceId[],
  surfaceLayouts: Record<DashboardSurfaceId, DashboardSurfaceLayoutState>,
) {
  const columnWidth = getDashboardSceneColumnWidth();
  const columnHeights = Array.from({ length: DASHBOARD_SCENE_COLUMN_COUNT }, () => 0);
  const sortedIds = [...surfaceIds].sort((left, right) => {
    const leftLayout = surfaceLayouts[left];
    const rightLayout = surfaceLayouts[right];

    if (leftLayout.order !== rightLayout.order) {
      return leftLayout.order - rightLayout.order;
    }

    return SURFACE_LIBRARY_INDEX[left] - SURFACE_LIBRARY_INDEX[right];
  });
  const nextFrames = {} as Record<DashboardSurfaceId, Pick<DashboardSurfaceLayoutState, 'x' | 'y' | 'w' | 'h' | 'zIndex'>>;

  sortedIds.forEach((surfaceId, index) => {
    const layout = surfaceLayouts[surfaceId];
    const span = DASHBOARD_SCENE_SIZE_SPANS[layout.size];
    const width = getSceneWidthForSize(layout.size);
    const height = getSceneHeightForPreset(layout.height);
    let bestStart = 0;
    let bestTop = Number.POSITIVE_INFINITY;

    for (let start = 0; start <= DASHBOARD_SCENE_COLUMN_COUNT - span; start += 1) {
      const top = Math.max(...columnHeights.slice(start, start + span));

      if (top < bestTop) {
        bestTop = top;
        bestStart = start;
      }
    }

    const x = Math.round(bestStart * (columnWidth + DASHBOARD_SCENE_GAP));
    const y = Math.round(bestTop);
    const nextBottom = y + height + DASHBOARD_SCENE_GAP;

    for (let column = bestStart; column < bestStart + span; column += 1) {
      columnHeights[column] = nextBottom;
    }

    nextFrames[surfaceId] = {
      x,
      y,
      w: width,
      h: height,
      zIndex: Math.max(layout.zIndex, index + 1),
    };
  });

  return nextFrames;
}

function buildDefaultSurfaceLayoutState(
  surface: DashboardSurfaceDefinition,
  order: number,
  frame: Pick<DashboardSurfaceLayoutState, 'x' | 'y' | 'w' | 'h' | 'zIndex'>,
): DashboardSurfaceLayoutState {
  return {
    order,
    size: surface.defaultSize,
    height: surface.defaultHeight,
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    zIndex: frame.zIndex,
    emphasis: false,
    visible: DEFAULT_SURFACE_IDS.includes(surface.id),
  };
}

function buildDefaultSurfaceLayouts() {
  const nextLayouts = {} as Record<DashboardSurfaceId, DashboardSurfaceLayoutState>;

  SURFACE_LIBRARY.forEach((surface, index) => {
    nextLayouts[surface.id] = {
      order: index,
      size: surface.defaultSize,
      height: surface.defaultHeight,
      x: 0,
      y: 0,
      w: getSceneWidthForSize(surface.defaultSize),
      h: getSceneHeightForPreset(surface.defaultHeight),
      zIndex: index + 1,
      emphasis: false,
      visible: DEFAULT_SURFACE_IDS.includes(surface.id),
    };
  });

  const packedFrames = getPackedSceneFrames(
    SURFACE_LIBRARY.map((surface) => surface.id),
    nextLayouts,
  );

  SURFACE_LIBRARY.forEach((surface, index) => {
    nextLayouts[surface.id] = buildDefaultSurfaceLayoutState(surface, index, packedFrames[surface.id]);
  });

  return nextLayouts;
}

const DEFAULT_SURFACE_LAYOUTS = buildDefaultSurfaceLayouts();

function sortSurfaceIdsByLayout(
  ids: DashboardSurfaceId[],
  surfaceLayouts: Record<DashboardSurfaceId, DashboardSurfaceLayoutState>,
) {
  return [...ids].sort((left, right) => {
    const leftLayout = surfaceLayouts[left] || DEFAULT_SURFACE_LAYOUTS[left];
    const rightLayout = surfaceLayouts[right] || DEFAULT_SURFACE_LAYOUTS[right];

    if (leftLayout.y !== rightLayout.y) {
      return leftLayout.y - rightLayout.y;
    }

    if (leftLayout.x !== rightLayout.x) {
      return leftLayout.x - rightLayout.x;
    }

    if (leftLayout.zIndex !== rightLayout.zIndex) {
      return leftLayout.zIndex - rightLayout.zIndex;
    }

    if (leftLayout.order !== rightLayout.order) {
      return leftLayout.order - rightLayout.order;
    }

    return SURFACE_LIBRARY_INDEX[left] - SURFACE_LIBRARY_INDEX[right];
  });
}

function getSurfaceDesktopStyle(surfaceId: DashboardSurfaceId, layout: DashboardSurfaceLayoutState): React.CSSProperties {
  const span = DASHBOARD_SCENE_SIZE_SPANS[layout.size];
  const minHeight = Math.max(
    DASHBOARD_SCENE_CARD_MIN_HEIGHT,
    Math.min(getEffectiveSurfaceHeight(surfaceId, layout.h), 680),
  );

  return {
    gridColumn: `span ${span} / span ${span}`,
    order: layout.order,
    minHeight: `${minHeight}px`,
    alignSelf: 'start',
  };
}

function getDashboardCanvasHeight(
  surfaceIds: DashboardSurfaceId[],
  surfaceLayouts: Record<DashboardSurfaceId, DashboardSurfaceLayoutState>,
) {
  if (surfaceIds.length === 0) {
    return DASHBOARD_SCENE_MIN_HEIGHT;
  }

  const tallestEdge = surfaceIds.reduce((maxBottom, surfaceId) => {
    const layout = surfaceLayouts[surfaceId] || DEFAULT_SURFACE_LAYOUTS[surfaceId];
    return Math.max(maxBottom, layout.y + getEffectiveSurfaceHeight(surfaceId, layout.h) + 24);
  }, 0);

  if (surfaceIds.length === 1) {
    return Math.max(DASHBOARD_SCENE_FOCUSED_MIN_HEIGHT, tallestEdge);
  }

  return Math.max(DASHBOARD_SCENE_MIN_HEIGHT, tallestEdge);
}

function sanitizeDashboardAnnotation(raw: unknown): DashboardAnnotation | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as {
    id?: unknown;
    text?: unknown;
    title?: unknown;
    surfaceId?: unknown;
    placement?: unknown;
    tone?: unknown;
    width?: unknown;
    x?: unknown;
    y?: unknown;
    persistent?: unknown;
    arrow?: unknown;
  };
  const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';

  if (!text) {
    return null;
  }

  const surfaceId = isDashboardSurfaceId(candidate.surfaceId) ? candidate.surfaceId : null;
  const placement = isDashboardAnnotationPlacement(candidate.placement)
    ? candidate.placement
    : (surfaceId ? 'bottom-right' : 'top-right');
  const tone = isDashboardAnnotationTone(candidate.tone) ? candidate.tone : 'info';
  const width = isDashboardAnnotationWidth(candidate.width) ? candidate.width : 'md';
  const x = typeof candidate.x === 'number'
    ? clampNumber(candidate.x, DASHBOARD_ANNOTATION_PERCENT_MIN, DASHBOARD_ANNOTATION_PERCENT_MAX)
    : undefined;
  const y = typeof candidate.y === 'number'
    ? clampNumber(candidate.y, DASHBOARD_ANNOTATION_PERCENT_MIN, DASHBOARD_ANNOTATION_PERCENT_MAX)
    : undefined;
  const id = typeof candidate.id === 'string' && candidate.id.trim().length > 0
    ? candidate.id.trim()
    : `annotation-${surfaceId || 'canvas'}-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`;

  return {
    id,
    text: text.slice(0, 280),
    title: typeof candidate.title === 'string' && candidate.title.trim().length > 0
      ? candidate.title.trim().slice(0, 80)
      : undefined,
    surfaceId,
    placement,
    tone,
    width,
    x,
    y,
    persistent: candidate.persistent === true,
    arrow: ['up', 'down', 'left', 'right'].includes(candidate.arrow as string)
      ? candidate.arrow as 'up' | 'down' | 'left' | 'right'
      : undefined,
  };
}

function mergeDashboardAnnotations(
  currentAnnotations: DashboardAnnotation[],
  incomingAnnotations: DashboardAnnotation[],
  clearAnnotations: boolean,
  visibleSurfaceIds: DashboardSurfaceId[],
) {
  const visibleSurfaceIdSet = new Set(visibleSurfaceIds);
  const baseAnnotations = (clearAnnotations
    ? currentAnnotations.filter((annotation) => annotation.persistent)
    : [...currentAnnotations]
  ).filter((annotation) => !annotation.surfaceId || visibleSurfaceIdSet.has(annotation.surfaceId));

  if (incomingAnnotations.length === 0) {
    return baseAnnotations;
  }

  const incomingIds = new Set(incomingAnnotations.map((annotation) => annotation.id));
  const preserved = baseAnnotations.filter((annotation) => !incomingIds.has(annotation.id));

  return [...preserved, ...incomingAnnotations];
}

function getAnnotationPlacementClass(
  placement: DashboardAnnotationPlacement,
  isCanvasAnnotation: boolean,
) {
  const offsetClass = isCanvasAnnotation ? 'm-4' : 'm-3';

  switch (placement) {
    case 'top-left':
      return `top-0 left-0 ${offsetClass}`;
    case 'top':
      return `top-0 left-1/2 -translate-x-1/2 ${offsetClass}`;
    case 'top-right':
      return `top-0 right-0 ${offsetClass}`;
    case 'right':
      return `top-1/2 right-0 -translate-y-1/2 ${offsetClass}`;
    case 'bottom-right':
      return `right-0 bottom-0 ${offsetClass}`;
    case 'bottom':
      return `bottom-0 left-1/2 -translate-x-1/2 ${offsetClass}`;
    case 'bottom-left':
      return `bottom-0 left-0 ${offsetClass}`;
    case 'left':
      return `top-1/2 left-0 -translate-y-1/2 ${offsetClass}`;
    case 'center':
    default:
      return 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2';
  }
}

function getAnnotationWidthClass(width: DashboardAnnotationWidth) {
  switch (width) {
    case 'sm':
      return 'w-44';
    case 'lg':
      return 'w-72';
    case 'md':
    default:
      return 'w-56';
  }
}

function getAnnotationToneClass(tone: DashboardAnnotationTone) {
  switch (tone) {
    case 'success':
      return 'border-emerald-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.82),rgba(236,253,245,0.66))] text-emerald-950 shadow-[0_16px_40px_rgba(16,185,129,0.12)]';
    case 'warning':
      return 'border-amber-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.84),rgba(254,243,199,0.66))] text-amber-950 shadow-[0_16px_40px_rgba(245,158,11,0.13)]';
    case 'neutral':
      return 'border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.86),rgba(248,250,252,0.68))] text-slate-700 shadow-[0_16px_40px_rgba(15,23,42,0.08)]';
    case 'info':
    default:
      return 'border-sky-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.84),rgba(224,242,254,0.68))] text-slate-800 shadow-[0_16px_40px_rgba(37,99,235,0.11)]';
  }
}

function getAnnotationArrowClass(direction: 'up' | 'down' | 'left' | 'right') {
  switch (direction) {
    case 'up':    return 'before:absolute before:bottom-full before:left-1/2 before:-translate-x-1/2 before:border-8 before:border-transparent before:border-b-current';
    case 'down':  return 'before:absolute before:top-full before:left-1/2 before:-translate-x-1/2 before:border-8 before:border-transparent before:border-t-current';
    case 'left':  return 'before:absolute before:right-full before:top-1/2 before:-translate-y-1/2 before:border-8 before:border-transparent before:border-r-current';
    case 'right': return 'before:absolute before:left-full before:top-1/2 before:-translate-y-1/2 before:border-8 before:border-transparent before:border-l-current';
  }
}

function DashboardAnnotationBubble({
  annotation,
  canvas = false,
}: {
  annotation: DashboardAnnotation;
  canvas?: boolean;
}) {
  const hasCustomPosition = typeof annotation.x === 'number' && typeof annotation.y === 'number';
  const arrowClass = annotation.arrow ? getAnnotationArrowClass(annotation.arrow) : '';

  return (
    <div
      style={hasCustomPosition
        ? {
          left: `${annotation.x}%`,
          top: `${annotation.y}%`,
          transform: 'translate(-50%, -50%)',
        }
        : undefined}
      className={`pointer-events-none absolute z-20 rounded-[20px] border px-4 py-3 backdrop-blur-sm ${hasCustomPosition ? '' : getAnnotationPlacementClass(annotation.placement, canvas)} ${getAnnotationWidthClass(annotation.width)} ${getAnnotationToneClass(annotation.tone)} ${arrowClass}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">AI note</div>
      {annotation.title ? (
        <div className="mt-1 text-sm font-semibold tracking-[-0.02em] text-slate-900">{annotation.title}</div>
      ) : null}
      <div className="mt-2 text-sm leading-5">{annotation.text}</div>
    </div>
  );
}

function shouldRenderInlineSurfaceAnnotation(annotation: DashboardAnnotation) {
  return Boolean(annotation.surfaceId);
}

function DashboardInlineAnnotationCard({ annotation }: { annotation: DashboardAnnotation }) {
  return (
    <div className={`dashboard-insight-card border ${getAnnotationToneClass(annotation.tone)}`}>
      <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        <span className="inline-flex h-2 w-2 rounded-full bg-sky-400/75 shadow-[0_0_14px_rgba(56,189,248,0.42)]" />
        <span>AI insight</span>
        {annotation.surfaceId ? (
          <span className="rounded-full border border-white/70 bg-white/60 px-2 py-0.5 text-[8px] tracking-[0.16em] text-slate-500">Context</span>
        ) : null}
      </div>
      {annotation.title ? (
        <div className="mt-1.5 text-[0.88rem] font-semibold tracking-[-0.03em] text-slate-900">{annotation.title}</div>
      ) : null}
      <div className="mt-1.5 text-[0.9rem] leading-6 text-slate-700">{annotation.text}</div>
    </div>
  );
}

function getDashboardGreetingPrefix(date: Date = new Date()) {
  const hour = date.getHours();

  if (hour < 12) return 'good morning, ';
  if (hour < 18) return 'good afternoon, ';
  return 'good evening, ';
}

const GREETING_PREFIX = getDashboardGreetingPrefix();
const GREETING_FONT_SIZE = 120;
const GREETING_TRACKING = GREETING_FONT_SIZE * -0.06;
const GREETING_BASELINE_Y = 94;
const GREETING_VIEWBOX_HEIGHT = 128;
const GREETING_NAME_JOIN_SPACE = GREETING_FONT_SIZE * 0.2;
const GREETING_REVEAL_EASING = 'cubic-bezier(0.32, 0, 0.18, 1)';
const GREETING_WARMUP_LABELS = [`${GREETING_PREFIX}Demo`, `${GREETING_PREFIX}Griffin`, `${GREETING_PREFIX}Olivia`];
const DASHBOARD_LOGIN_SPLASH_STORAGE_KEY = 'dashboard-login-splash';
const DASHBOARD_LOGIN_SPLASH_MIN_MS = 1550;
const DASHBOARD_BODY_START_DELAY_MS = 180;
const DASHBOARD_PROMPT_PLACEHOLDERS = ["What's on your mind?", 'How can I help you today?', 'What can I help you with?'];
const GREETING_FONT_STACK =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

type GreetingGlyphLayout = {
  index: number;
  char: string;
  x: number;
  width: number;
  advance: number;
  durationMs: number;
  delayMs: number;
};

type GreetingAnimationLayout = {
  glyphs: GreetingGlyphLayout[];
  totalWidth: number;
  totalDurationMs: number;
};

let greetingMeasureContext: CanvasRenderingContext2D | null = null;

function getGreetingMeasureContext() {
  if (typeof document === 'undefined') return null;
  if (greetingMeasureContext) return greetingMeasureContext;

  const canvas = document.createElement('canvas');
  greetingMeasureContext = canvas.getContext('2d');

  if (greetingMeasureContext) {
    greetingMeasureContext.font = `700 ${GREETING_FONT_SIZE}px ${GREETING_FONT_STACK}`;
  }

  return greetingMeasureContext;
}

function getFallbackGreetingCharacterWidth(char: string) {
  if (char === ' ') return GREETING_FONT_SIZE * 0.34;
  if (/[mwMW]/.test(char)) return GREETING_FONT_SIZE * 0.94;
  if (/[ilIjtf]/.test(char)) return GREETING_FONT_SIZE * 0.34;
  if (/[A-Z]/.test(char)) return GREETING_FONT_SIZE * 0.74;
  if (/[,.'-]/.test(char)) return GREETING_FONT_SIZE * 0.26;
  return GREETING_FONT_SIZE * 0.58;
}

function getGreetingCharacterWidth(char: string) {
  const ctx = getGreetingMeasureContext();
  const fallbackWidth = getFallbackGreetingCharacterWidth(char);

  if (!ctx) return fallbackWidth;

  ctx.font = `700 ${GREETING_FONT_SIZE}px ${GREETING_FONT_STACK}`;
  return Math.max(ctx.measureText(char).width, fallbackWidth);
}

function getGreetingCharacterRenderWidth(char: string) {
  const ctx = getGreetingMeasureContext();
  const fallbackWidth = getFallbackGreetingCharacterWidth(char);

  if (!ctx) return fallbackWidth;

  ctx.font = `700 ${GREETING_FONT_SIZE}px ${GREETING_FONT_STACK}`;

  const metrics = ctx.measureText(char);
  const actualWidth = (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0);

  return Math.max(fallbackWidth, metrics.width, actualWidth);
}

function getGreetingTextWidth(text: string) {
  if (!text) return 0;

  const ctx = getGreetingMeasureContext();

  if (!ctx) {
    return Array.from(text).reduce((sum, char) => sum + getFallbackGreetingCharacterWidth(char), 0);
  }

  ctx.font = `700 ${GREETING_FONT_SIZE}px ${GREETING_FONT_STACK}`;
  return ctx.measureText(text).width;
}

function roundSvg(value: number) {
  return Number(value.toFixed(1));
}

function createGreetingStrokePath(char: string, left: number, width: number) {
  const lower = char.toLowerCase();
  const isUpper = /[A-Z]/.test(char);
  const topY = isUpper ? 14 : 28;
  const xHeightY = isUpper ? 30 : 44;
  const midY = 56;
  const baselineY = 82;
  const descenderY = 104;
  const sx = (factor: number) => roundSvg(left + width * factor);
  const sy = (value: number) => roundSvg(value);

  if (char === ' ') return null;

  if (isUpper && lower === 'g') {
    return `M ${sx(0.84)} ${sy(44)} C ${sx(0.76)} ${sy(18)} ${sx(0.48)} ${sy(12)} ${sx(0.24)} ${sy(30)} C ${sx(0.08)} ${sy(44)} ${sx(0.08)} ${sy(74)} ${sx(0.28)} ${sy(88)} C ${sx(0.48)} ${sy(102)} ${sx(0.78)} ${sy(92)} ${sx(0.82)} ${sy(66)} L ${sx(0.58)} ${sy(66)}`;
  }

  switch (lower) {
    case ',':
      return `M ${sx(0.58)} ${sy(86)} C ${sx(0.66)} ${sy(96)} ${sx(0.58)} ${sy(106)} ${sx(0.42)} ${sy(112)}`;
    case '.':
      return `M ${sx(0.46)} ${sy(92)} Q ${sx(0.5)} ${sy(86)} ${sx(0.54)} ${sy(92)}`;
    case '-':
      return `M ${sx(0.22)} ${sy(60)} Q ${sx(0.5)} ${sy(56)} ${sx(0.78)} ${sy(60)}`;
    case "'":
      return `M ${sx(0.58)} ${sy(20)} C ${sx(0.66)} ${sy(10)} ${sx(0.6)} ${sy(18)} ${sx(0.5)} ${sy(32)}`;
    case 'i':
      return `M ${sx(0.5)} ${sy(baselineY)} C ${sx(0.48)} ${sy(64)} ${sx(0.48)} ${sy(52)} ${sx(0.5)} ${sy(xHeightY - 2)}`;
    case 'j':
      return `M ${sx(0.56)} ${sy(xHeightY)} C ${sx(0.58)} ${sy(62)} ${sx(0.58)} ${sy(88)} ${sx(0.48)} ${sy(descenderY)} C ${sx(0.42)} ${sy(112)} ${sx(0.28)} ${sy(110)} ${sx(0.32)} ${sy(96)}`;
    case 'm':
    case 'w':
      return `M ${sx(0.14)} ${sy(baselineY)} C ${sx(0.16)} ${sy(66)} ${sx(0.2)} ${sy(54)} ${sx(0.3)} ${sy(46)} C ${sx(0.42)} ${sy(34)} ${sx(0.54)} ${sy(44)} ${sx(0.58)} ${sy(58)} C ${sx(0.62)} ${sy(40)} ${sx(0.74)} ${sy(34)} ${sx(0.86)} ${sy(48)} C ${sx(0.96)} ${sy(60)} ${sx(0.98)} ${sy(72)} ${sx(0.92)} ${sy(baselineY - 8)}`;
    case 'n':
    case 'u':
    case 'v':
    case 'r':
      return `M ${sx(0.22)} ${sy(baselineY)} C ${sx(0.22)} ${sy(66)} ${sx(0.26)} ${sy(54)} ${sx(0.36)} ${sy(46)} C ${sx(0.5)} ${sy(34)} ${sx(0.72)} ${sy(38)} ${sx(0.84)} ${sy(baselineY - 8)}`;
    case 'g':
    case 'p':
    case 'q':
    case 'y':
      return `M ${sx(0.76)} ${sy(midY)} C ${sx(0.68)} ${sy(38)} ${sx(0.42)} ${sy(34)} ${sx(0.24)} ${sy(52)} C ${sx(0.14)} ${sy(64)} ${sx(0.18)} ${sy(84)} ${sx(0.42)} ${sy(86)} C ${sx(0.66)} ${sy(88)} ${sx(0.82)} ${sy(70)} ${sx(0.72)} ${sy(54)} C ${sx(0.66)} ${sy(92)} ${sx(0.62)} ${sy(100)} ${sx(0.5)} ${sy(descenderY)} C ${sx(0.38)} ${sy(112)} ${sx(0.22)} ${sy(108)} ${sx(0.26)} ${sy(94)}`;
    case 'a':
    case 'c':
    case 'e':
    case 'o':
    case 's':
      return `M ${sx(0.8)} ${sy(midY)} C ${sx(0.7)} ${sy(xHeightY - 12)} ${sx(0.44)} ${sy(xHeightY - 10)} ${sx(0.26)} ${sy(midY - 2)} C ${sx(0.12)} ${sy(midY + 14)} ${sx(0.18)} ${sy(84)} ${sx(0.46)} ${sy(86)} C ${sx(0.72)} ${sy(86)} ${sx(0.86)} ${sy(70)} ${sx(0.62)} ${sy(58)} L ${sx(0.32)} ${sy(58)} C ${sx(0.42)} ${sy(44)} ${sx(0.68)} ${sy(42)} ${sx(0.82)} ${sy(52)}`;
    case 'b':
    case 'd':
    case 'f':
    case 'h':
    case 'k':
    case 'l':
    case 't':
      return `M ${sx(0.3)} ${sy(baselineY)} C ${sx(0.18)} ${sy(midY)} ${sx(0.18)} ${sy(topY + 10)} ${sx(0.3)} ${sy(topY)} C ${sx(0.36)} ${sy(topY - 6)} ${sx(0.42)} ${sy(topY + 2)} ${sx(0.4)} ${sy(topY + 18)} C ${sx(0.38)} ${sy(48)} ${sx(0.38)} ${sy(64)} ${sx(0.4)} ${sy(baselineY)} C ${sx(0.52)} ${sy(56)} ${sx(0.72)} ${sy(48)} ${sx(0.84)} ${sy(baselineY - 8)}`;
    case 'x':
    case 'z':
      return `M ${sx(0.2)} ${sy(xHeightY)} C ${sx(0.34)} ${sy(48)} ${sx(0.5)} ${sy(62)} ${sx(0.8)} ${sy(baselineY - 6)} M ${sx(0.78)} ${sy(xHeightY)} C ${sx(0.6)} ${sy(52)} ${sx(0.4)} ${sy(62)} ${sx(0.18)} ${sy(baselineY - 4)}`;
    default:
      if (isUpper) {
        return `M ${sx(0.14)} ${sy(84)} C ${sx(0.2)} ${sy(58)} ${sx(0.24)} ${sy(34)} ${sx(0.36)} ${sy(20)} C ${sx(0.5)} ${sy(6)} ${sx(0.76)} ${sy(12)} ${sx(0.86)} ${sy(34)} C ${sx(0.92)} ${sy(52)} ${sx(0.86)} ${sy(76)} ${sx(0.74)} ${sy(88)} C ${sx(0.6)} ${sy(102)} ${sx(0.34)} ${sy(100)} ${sx(0.22)} ${sy(84)}`;
      }
      return `M ${sx(0.16)} ${sy(baselineY)} C ${sx(0.22)} ${sy(58)} ${sx(0.34)} ${sy(42)} ${sx(0.52)} ${sy(42)} C ${sx(0.72)} ${sy(42)} ${sx(0.84)} ${sy(58)} ${sx(0.86)} ${sy(baselineY - 8)}`;
  }
}

function getGreetingGlyphDuration(char: string, width: number) {
  if (char === ' ') return 140;
  if (/[,.'-]/.test(char)) return 180;
  if (/[ilIjtf]/.test(char)) return 260;
  if (/[mwMW]/.test(char)) return 400;
  if (/[A-Z]/.test(char)) return 340;
  return Math.round(290 + Math.min(120, width * 0.5));
}

function getGreetingGlyphCadence(char: string, durationMs: number, index: number) {
  if (char === ' ') {
    return index === GREETING_PREFIX.length - 1 ? 20 : 56;
  }

  if (/[,.'-]/.test(char)) return Math.round(durationMs * 0.78) + 22;
  if (/[mwMW]/.test(char)) return Math.round(durationMs * 0.58) + 26;
  if (/[A-Z]/.test(char)) return Math.round(durationMs * 0.6) + 24;
  return Math.round(durationMs * 0.56) + 22;
}

function isGreetingNameGlyph(index: number) {
  return index >= GREETING_PREFIX.length;
}

function getGreetingSheenLeadMs(glyph: GreetingGlyphLayout) {
  if (!isGreetingNameGlyph(glyph.index)) return 18;

  const nameIndex = glyph.index - GREETING_PREFIX.length;
  return 74 + Math.min(34, nameIndex * 7);
}

function getGreetingSheenDuration(glyph: GreetingGlyphLayout) {
  if (!isGreetingNameGlyph(glyph.index)) {
    return Math.max(760, glyph.durationMs + 380);
  }

  const nameIndex = glyph.index - GREETING_PREFIX.length;
  const extraDuration = 220 + Math.min(140, nameIndex * 20);

  return Math.max(980, glyph.durationMs + 460 + extraDuration);
}

function getGreetingSheenInset(glyph: GreetingGlyphLayout) {
  if (!isGreetingNameGlyph(glyph.index)) return 28;

  const nameIndex = glyph.index - GREETING_PREFIX.length;
  return 40 + Math.min(12, nameIndex * 2);
}

function buildGreetingAnimationLayout(label: string): GreetingAnimationLayout {
  const glyphs: GreetingGlyphLayout[] = [];
  let delayMs = 0;
  let maxRight = 0;
  let cumulativeAdjustment = 0;

  Array.from(label).forEach((char, index) => {
    const naturalStart = getGreetingTextWidth(label.slice(0, index));
    const naturalEnd = getGreetingTextWidth(label.slice(0, index + 1));
    const naturalAdvance = naturalEnd - naturalStart;
    const measuredWidth = getGreetingCharacterWidth(char);
    const renderWidth = getGreetingCharacterRenderWidth(char);
    const tracking = char === ' ' ? GREETING_TRACKING * 0.4 : GREETING_TRACKING;
    const isNameJoinSpace = char === ' ' && index === GREETING_PREFIX.length - 1;
    const advance = isNameJoinSpace
      ? GREETING_NAME_JOIN_SPACE
      : Math.max(naturalAdvance + tracking, char === ' ' ? 24 : naturalAdvance * 0.72);
    const durationMs = getGreetingGlyphDuration(char, measuredWidth);
    const width = Math.max(renderWidth + (/[ij]/i.test(char) ? 16 : 10), 24);
    const glyphX = 4 + naturalStart + cumulativeAdjustment;

    if (char !== ' ') {
      glyphs.push({
        index,
        char,
        x: roundSvg(glyphX),
        width: roundSvg(width),
        advance: roundSvg(advance),
        durationMs,
        delayMs,
      });

      maxRight = Math.max(maxRight, glyphX + width);
    }

    delayMs += getGreetingGlyphCadence(char, durationMs, index);

    cumulativeAdjustment += advance - naturalAdvance;
  });

  const totalWidth = 4 + getGreetingTextWidth(label) + cumulativeAdjustment;

  return {
    glyphs,
    totalWidth: Math.max(560, roundSvg(Math.max(totalWidth + 40, maxRight + 24))),
    totalDurationMs: Math.round(delayMs + 320),
  };
}

let dashboardGreetingWarmupScheduled = false;

function primeDashboardGreetingAnimation() {
  getGreetingMeasureContext();
  GREETING_WARMUP_LABELS.forEach((label) => {
    buildGreetingAnimationLayout(label);
  });
}

function scheduleDashboardGreetingWarmup() {
  if (dashboardGreetingWarmupScheduled) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  dashboardGreetingWarmupScheduled = true;

  primeDashboardGreetingAnimation();

  const fontSet = document.fonts;
  const fontDescriptor = `700 ${GREETING_FONT_SIZE}px ${GREETING_FONT_STACK}`;
  const fontReady = fontSet?.ready ? fontSet.ready.catch(() => undefined) : Promise.resolve();
  const fontLoads = fontSet?.load
    ? Promise.all(GREETING_WARMUP_LABELS.map((label) => fontSet.load(fontDescriptor, label).catch(() => undefined)))
    : Promise.resolve();

  void Promise.all([fontReady, fontLoads]).finally(() => {
    primeDashboardGreetingAnimation();
  });
}

function shouldShowDashboardLoginSplash() {
  if (typeof window === 'undefined') return false;

  return window.sessionStorage.getItem(DASHBOARD_LOGIN_SPLASH_STORAGE_KEY) === '1';
}

scheduleDashboardGreetingWarmup();

function extractFirstName(name?: string | null, email?: string | null) {
  if (name?.trim()) return name.trim().split(/\s+/)[0];
  if (email?.trim()) return email.trim().split('@')[0];
  return 'there';
}

function buildCategoryBreakdown(transactions: BookkeepingTransaction[]) {
  const totals = new Map<string, number>();

  transactions
    .filter((transaction) => transaction.type === 'expense')
    .forEach((transaction) => {
      const key = transaction.category || 'Uncategorized';
      totals.set(key, (totals.get(key) || 0) + Math.abs(Number(transaction.amount || 0)));
    });

  return Array.from(totals.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([name, amount]) => ({ name, amount }));
}

function buildSummaryFromTransactions(transactions: BookkeepingTransaction[]) {
  const totalIncome = transactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0);

  const totalExpenses = transactions
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0);

  const netCashFlow = totalIncome - totalExpenses;

  return {
    totalIncome,
    totalExpenses,
    netCashFlow,
    margin: totalIncome > 0 ? Number(((netCashFlow / totalIncome) * 100).toFixed(1)) : 0,
  };
}

function buildBookkeepingWorkspaceSummary(transactions: BookkeepingTransaction[], cashBalance: number = 0): BookkeepingSummary {
  const bucketTotals = (type: 'income' | 'expense') => {
    const totals = new Map<string, number>();

    transactions
      .filter((transaction) => transaction.type === type)
      .forEach((transaction) => {
        const key = transaction.category || 'Uncategorized';
        totals.set(key, (totals.get(key) || 0) + Math.abs(Number(transaction.amount || 0)));
      });

    return Array.from(totals.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([category, amount]) => ({ category, amount }));
  };

  const totalIncome = transactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0);

  const totalExpenses = transactions
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0);

  return {
    totalIncome,
    totalExpenses,
    netIncome: totalIncome - totalExpenses,
    cashBalance,
    incomeByCategory: bucketTotals('income'),
    expensesByCategory: bucketTotals('expense'),
  };
}

function buildNetWorthChartSeries(
  snapshots: PortfolioSnapshot[],
  timePeriod: NetWorthTimePeriod,
  viewMode: 'assets' | 'equity',
  totalAssets: number,
  totalLiabilities: number,
): NetWorthChartSeriesPoint[] {
  const isHourly = timePeriod === '1d';
  const isDaily = timePeriod === '1w' || timePeriod === '1m';
  const buckets: Array<{ key: string; label: string; fullLabel: string }> = [];
  const now = new Date();
  let startDate: Date;

  switch (timePeriod) {
    case '1d':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      startDate.setMinutes(0, 0, 0);
      break;
    case '1w':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
      startDate.setHours(0, 0, 0, 0);
      break;
    case '1m':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'YTD':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case '3m':
      startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      break;
    case '6m':
      startDate = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      break;
    case '1y':
      startDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      break;
    case '2y':
      startDate = new Date(now.getFullYear() - 2, now.getMonth(), 1);
      break;
    case '3y':
      startDate = new Date(now.getFullYear() - 3, now.getMonth(), 1);
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      break;
  }

  if (isHourly) {
    const current = new Date(startDate);
    while (current <= now) {
      const key = current.toISOString().slice(0, 16);
      const hourLabel = current.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const dayLabel = current.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      buckets.push({ key, label: hourLabel, fullLabel: `${dayLabel} ${hourLabel}` });
      current.setHours(current.getHours() + 1);
    }
  } else if (isDaily) {
    const current = new Date(startDate);
    while (current <= now) {
      const key = current.toISOString().split('T')[0];
      const dayLabel = current.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const year = current.getFullYear();
      const isFirst = buckets.length === 0;
      buckets.push({ key, label: isFirst ? `${dayLabel} ${year}` : dayLabel, fullLabel: `${dayLabel}, ${year}` });
      current.setDate(current.getDate() + 1);
    }
  } else {
    const current = new Date(startDate);
    while (current <= now) {
      const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
      const monthLabel = current.toLocaleDateString('en-US', { month: 'short' });
      const year = current.getFullYear();
      const isJanuary = current.getMonth() === 0;
      const isFirstMonth = buckets.length === 0;
      buckets.push({ key, label: isFirstMonth || isJanuary ? `${monthLabel} ${year}` : monthLabel, fullLabel: `${monthLabel} ${year}` });
      current.setMonth(current.getMonth() + 1);
    }
  }

  const bucketValues: Record<string, { value: number; date: string }> = {};
  snapshots.forEach((snapshot) => {
    let bucketKey: string;
    if (isHourly) {
      bucketKey = snapshot.date.length > 10 ? snapshot.date.slice(0, 16) : `${snapshot.date}T12:00`;
      bucketKey = `${bucketKey.slice(0, 13)}:00`;
    } else if (isDaily) {
      bucketKey = snapshot.date.split('T')[0];
    } else {
      const date = new Date(snapshot.date);
      bucketKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    let snapshotValue = snapshot.totalValue;
    if (viewMode === 'equity') {
      if (snapshot.netWorth !== undefined) {
        snapshotValue = snapshot.netWorth;
      } else if (totalLiabilities > 0 && totalAssets > 0) {
        snapshotValue = snapshot.totalValue * (1 - totalLiabilities / totalAssets);
      }
    }

    if (!bucketValues[bucketKey] || snapshot.date > bucketValues[bucketKey].date) {
      bucketValues[bucketKey] = { value: snapshotValue, date: snapshot.date };
    }
  });

  return buckets
    .map((bucket) => ({ bucket, data: bucketValues[bucket.key] }))
    .filter((entry) => entry.data !== undefined)
    .map((entry) => ({
      label: entry.bucket.label,
      fullLabel: entry.bucket.fullLabel,
      value: entry.data!.value,
      date: entry.data!.date,
    }));
}

function getVisibleAxisIndices(length: number, maxLabels: number): number[] {
  if (length <= maxLabels) return Array.from({ length }, (_, index) => index);
  const indices = new Set<number>();
  for (let index = 0; index < maxLabels; index += 1) {
    indices.add(Math.round(((length - 1) * index) / (maxLabels - 1)));
  }
  return Array.from(indices).sort((left, right) => left - right);
}

function formatCompactCurrency(value: number): string {
  const absoluteValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absoluteValue >= 1_000_000_000) {
    return `${sign}$${(absoluteValue / 1_000_000_000).toFixed(absoluteValue >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (absoluteValue >= 1_000_000) {
    return `${sign}$${(absoluteValue / 1_000_000).toFixed(absoluteValue >= 10_000_000 ? 0 : 1)}M`;
  }
  if (absoluteValue >= 1_000) {
    return `${sign}$${(absoluteValue / 1_000).toFixed(absoluteValue >= 10_000 ? 0 : 1)}k`;
  }
  return `${sign}$${absoluteValue.toFixed(0)}`;
}

function formatCurrency(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function formatPreciseCurrency(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedPercent(value: number, digits: number = 2) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateCashFlow(inputs: FinancialInputs): number[] {
  const years = 10;
  const results: number[] = [];

  for (let year = 0; year < years; year += 1) {
    const rent = inputs.monthlyRent * Math.pow(1 + inputs.rentGrowth / 100, year);
    const otherIncome = inputs.otherIncome * Math.pow(1 + inputs.rentGrowth / 100, year);
    const effectiveGrossIncome = 12 * (rent + otherIncome) * (1 - inputs.vacancyRate / 100);

    const expenseInflation = inputs.expenseInflation / 100;
    const insurance = inputs.insurance * Math.pow(1 + expenseInflation, year);
    const utilities = inputs.utilities * Math.pow(1 + expenseInflation, year);
    const hoa = inputs.hoa * Math.pow(1 + expenseInflation, year);
    const repairs = inputs.repairsCapEx * Math.pow(1 + expenseInflation, year);
    const taxes = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, year);
    const management = (inputs.managementPct / 100) * effectiveGrossIncome;
    const operatingExpenses = taxes + insurance + utilities + hoa + repairs + management;
    const netOperatingIncome = effectiveGrossIncome - operatingExpenses;

    let annualDebtService = 0;
    const baseLoan = inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
    const loanTermMonths = inputs.remainingLoanTermMonths ?? inputs.loanTerm;

    if (inputs.monthlyDebtService !== undefined && inputs.monthlyDebtService > 0) {
      annualDebtService = inputs.monthlyDebtService * 12;
    } else if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const monthlyRate = inputs.interestRate / 100 / 12;
      const payment = (monthlyRate * baseLoan) / (1 - Math.pow(1 + monthlyRate, -loanTermMonths));
      annualDebtService = payment * 12;
    }

    results.push((netOperatingIncome - annualDebtService) / 1000);
  }

  return results;
}

function calculateIncomeExpenses(inputs: FinancialInputs): IncomeExpenseAnalytics {
  const years = 10;
  const income: number[] = [];
  const expenses: number[] = [];
  const expenseBreakdown = {
    taxes: [] as number[],
    operations: [] as number[],
    repairs: [] as number[],
    management: [] as number[],
    debtService: [] as number[],
  };

  for (let year = 0; year < years; year += 1) {
    const rent = inputs.monthlyRent * Math.pow(1 + inputs.rentGrowth / 100, year);
    const otherIncome = inputs.otherIncome * Math.pow(1 + inputs.rentGrowth / 100, year);
    const effectiveGrossIncome = 12 * (rent + otherIncome) * (1 - inputs.vacancyRate / 100);

    const expenseInflation = inputs.expenseInflation / 100;
    const insurance = inputs.insurance * Math.pow(1 + expenseInflation, year);
    const utilities = inputs.utilities * Math.pow(1 + expenseInflation, year);
    const hoa = inputs.hoa * Math.pow(1 + expenseInflation, year);
    const repairs = inputs.repairsCapEx * Math.pow(1 + expenseInflation, year);
    const taxes = inputs.taxAmount * Math.pow(1 + inputs.taxGrowth / 100, year);
    const management = (inputs.managementPct / 100) * effectiveGrossIncome;

    let annualDebtService = 0;
    const baseLoan = inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
    const loanTermMonths = inputs.remainingLoanTermMonths ?? inputs.loanTerm;

    if (inputs.monthlyDebtService !== undefined && inputs.monthlyDebtService > 0) {
      annualDebtService = inputs.monthlyDebtService * 12;
    } else if (!inputs.isInterestOnly && inputs.interestRate > 0) {
      const monthlyRate = inputs.interestRate / 100 / 12;
      const payment = (monthlyRate * baseLoan) / (1 - Math.pow(1 + monthlyRate, -loanTermMonths));
      annualDebtService = payment * 12;
    }

    const operations = insurance + utilities + hoa;
    const totalExpenses = taxes + operations + repairs + management + annualDebtService;

    income.push(effectiveGrossIncome / 1000);
    expenses.push(totalExpenses / 1000);
    expenseBreakdown.taxes.push(taxes / 1000);
    expenseBreakdown.operations.push(operations / 1000);
    expenseBreakdown.repairs.push(repairs / 1000);
    expenseBreakdown.management.push(management / 1000);
    expenseBreakdown.debtService.push(annualDebtService / 1000);
  }

  return { income, expenses, expenseBreakdown };
}

function calculateCoCReturn(inputs: FinancialInputs): number[] {
  const cashFlows = calculateCashFlow(inputs);
  const initialCashIn = inputs.downPayment + inputs.closingCosts + inputs.initialRehab;

  return cashFlows.map((cashFlow) => (initialCashIn > 0 ? ((cashFlow * 1000) / initialCashIn) * 100 : 0));
}

function calculateMortgageAmortization(inputs: FinancialInputs, years: number = 10): MortgageAmortizationAnalytics {
  const principal: number[] = [];
  const interest: number[] = [];
  const loanBalance: number[] = [];

  const startingBalance = inputs.currentLoanBalance ?? inputs.originalLoanAmount ?? Math.max(inputs.avm - inputs.downPayment, 0);
  if (startingBalance <= 0) {
    return { principal, interest, loanBalance };
  }

  const monthlyRate = inputs.interestRate / 100 / 12;
  const totalMonths = inputs.remainingLoanTermMonths ?? inputs.loanTerm;
  const monthlyPayment = inputs.monthlyDebtService && inputs.monthlyDebtService > 0
    ? inputs.monthlyDebtService
    : monthlyRate > 0 && !inputs.isInterestOnly
      ? (monthlyRate * startingBalance) / (1 - Math.pow(1 + monthlyRate, -totalMonths))
      : 0;

  let remainingBalance = startingBalance;

  for (let year = 0; year < years; year += 1) {
    let annualPrincipal = 0;
    let annualInterest = 0;

    for (let month = 0; month < 12; month += 1) {
      if (remainingBalance <= 0) break;

      const monthlyInterest = monthlyRate > 0 ? remainingBalance * monthlyRate : 0;
      const monthlyPrincipal = inputs.isInterestOnly
        ? 0
        : Math.max(Math.min(monthlyPayment - monthlyInterest, remainingBalance), 0);

      annualInterest += monthlyInterest;
      annualPrincipal += monthlyPrincipal;
      remainingBalance = Math.max(remainingBalance - monthlyPrincipal, 0);
    }

    principal.push(annualPrincipal / 1000);
    interest.push(annualInterest / 1000);
    loanBalance.push(remainingBalance / 1000);
  }

  return { principal, interest, loanBalance };
}

function buildProjectedYearLabels(length: number) {
  const startYear = new Date().getFullYear();
  return Array.from({ length }, (_, index) => String(startYear + index));
}

function normalizeDashboardPropertyAddress(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildDashboardApiUrl(pathname: string, searchParams: Record<string, string>) {
  const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
  const useProxy = import.meta.env.MODE === 'development' && !baseEnv;

  if (useProxy) {
    const query = new URLSearchParams(searchParams).toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  const url = new URL(baseEnv || 'http://127.0.0.1:3001');
  url.pathname = pathname;
  Object.entries(searchParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function buildAvmHistorySeries(property: DashboardProperty | null): PropertyValueHistoryPoint[] {
  if (!property?.data) return [];

  const avmHistory = (property.data.avm_history ?? [])
    .filter((entry) => typeof entry.value === 'number')
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())
    .slice(-10)
    .map((entry) => {
      const date = new Date(entry.date);
      return {
        label: date.toLocaleDateString('en-US', { year: 'numeric' }),
        fullLabel: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        value: entry.value ?? 0,
        low: entry.low,
        high: entry.high,
      };
    });

  if (avmHistory.length >= 2) return avmHistory;

  const lastSalePrice = property.data.summary.last_sale_price;
  const currentAvm = property.data.summary.avm_value;

  if (!lastSalePrice || !currentAvm) return avmHistory;

  const saleDate = property.data.summary.last_sale_date ? new Date(property.data.summary.last_sale_date) : null;
  const fallbackLabel = saleDate && !Number.isNaN(saleDate.getTime())
    ? saleDate.toLocaleDateString('en-US', { year: 'numeric' })
    : 'Sale';
  const fallbackFullLabel = saleDate && !Number.isNaN(saleDate.getTime())
    ? saleDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : 'Last sale';

  return [
    {
      label: fallbackLabel,
      fullLabel: fallbackFullLabel,
      value: lastSalePrice,
    },
    {
      label: String(new Date().getFullYear()),
      fullLabel: 'Current AVM',
      value: currentAvm,
      low: property.data.summary.avm_low,
      high: property.data.summary.avm_high,
    },
  ];
}

function buildTaxHistorySeries(property: DashboardProperty | null): PropertyTaxHistoryPoint[] {
  if (!property?.data) return [];

  return (property.data.tax_history ?? [])
    .filter((entry) => typeof entry.tax_amount === 'number')
    .sort((left, right) => left.year - right.year)
    .slice(-10)
    .map((entry) => ({
      label: String(entry.year),
      fullLabel: String(entry.year),
      amount: entry.tax_amount ?? 0,
      yoy: typeof entry.tax_amount_yoy_pct === 'number' ? entry.tax_amount_yoy_pct : null,
    }));
}

function matchesCategory(category: string | null | undefined, keywords: string[]) {
  if (!category) return false;
  const normalized = category.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function sumTransactionsByType(transactions: BookkeepingTransaction[], type: 'income' | 'expense') {
  return transactions.reduce((sum, transaction) => {
    if (transaction.type !== type) return sum;
    return sum + Math.abs(Number(transaction.amount || 0));
  }, 0);
}

function sumTransactionCategories(
  transactions: BookkeepingTransaction[],
  type: 'income' | 'expense',
  keywords: string[],
) {
  return transactions.reduce((sum, transaction) => {
    if (transaction.type !== type) return sum;

    const matches = matchesCategory(transaction.category, keywords)
      || matchesCategory(transaction.accountCode, keywords)
      || matchesCategory(transaction.taxMap, keywords);

    return matches ? sum + Math.abs(Number(transaction.amount || 0)) : sum;
  }, 0);
}

function sumSummaryCategories(summary: BookkeepingSummary | null, keywords: string[]) {
  if (!summary) return 0;

  return summary.expensesByCategory.reduce((sum, entry) => (
    matchesCategory(entry.category, keywords) ? sum + Math.abs(Number(entry.amount || 0)) : sum
  ), 0);
}

function weightedAverage(entries: Array<{ weight: number; value?: number | null }>, fallback: number) {
  const validEntries = entries.filter((entry) => typeof entry.value === 'number' && Number.isFinite(entry.value) && entry.weight > 0);
  if (validEntries.length === 0) return fallback;

  const totalWeight = validEntries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return fallback;

  return validEntries.reduce((sum, entry) => sum + (entry.value as number) * entry.weight, 0) / totalWeight;
}

function buildPortfolioAvmHistorySeries(
  snapshots: PortfolioSnapshot[],
  currentRealEstateValue: number,
  ytdChange: number,
): { series: PropertyValueHistoryPoint[]; modeled: boolean } {
  const historicalSeries = [...snapshots]
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())
    .filter((snapshot) => snapshot.assets.realEstate > 0)
    .slice(-6)
    .map((snapshot) => {
      const date = new Date(snapshot.date);
      return {
        label: date.toLocaleDateString('en-US', { month: 'short' }),
        fullLabel: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        value: snapshot.assets.realEstate,
      };
    });

  if (historicalSeries.length >= 2) {
    return { series: historicalSeries, modeled: false };
  }

  if (currentRealEstateValue <= 0) {
    return { series: [], modeled: false };
  }

  const currentDate = new Date();
  const startingValue = ytdChange !== 0 ? currentRealEstateValue / (1 + ytdChange / 100) : currentRealEstateValue;
  const series = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - (5 - index), 1);
    const progress = index / 5;
    const value = startingValue + (currentRealEstateValue - startingValue) * progress;

    return {
      label: date.toLocaleDateString('en-US', { month: 'short' }),
      fullLabel: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      value,
    };
  });

  return { series, modeled: true };
}

function buildPortfolioTaxHistorySeries(
  transactions: BookkeepingTransaction[],
  currentTaxAmount: number,
): { series: PropertyTaxHistoryPoint[]; modeled: boolean } {
  const yearlyTotals = new Map<number, number>();

  transactions.forEach((transaction) => {
    if (transaction.type !== 'expense') return;
    if (!matchesCategory(transaction.category, ['tax']) && !matchesCategory(transaction.taxMap, ['tax'])) return;

    const date = new Date(transaction.date);
    if (Number.isNaN(date.getTime())) return;

    const year = date.getFullYear();
    yearlyTotals.set(year, (yearlyTotals.get(year) || 0) + Math.abs(Number(transaction.amount || 0)));
  });

  const historicalSeries = Array.from(yearlyTotals.entries())
    .sort((left, right) => left[0] - right[0])
    .slice(-5)
    .map(([year, amount], index, entries) => {
      const previous = index > 0 ? entries[index - 1][1] : null;
      return {
        label: String(year),
        fullLabel: String(year),
        amount,
        yoy: previous && previous > 0 ? ((amount - previous) / previous) * 100 : null,
      };
    });

  if (historicalSeries.length > 0) {
    return { series: historicalSeries, modeled: false };
  }

  if (currentTaxAmount <= 0) {
    return { series: [], modeled: false };
  }

  const currentYear = new Date().getFullYear();
  const annualGrowth = 0.02;
  const series = Array.from({ length: 5 }, (_, index) => {
    const year = currentYear - 4 + index;
    const yearsBack = currentYear - year;
    return {
      label: String(year),
      fullLabel: String(year),
      amount: currentTaxAmount / Math.pow(1 + annualGrowth, yearsBack),
      yoy: index === 0 ? null : annualGrowth * 100,
    };
  });

  return { series, modeled: true };
}

function derivePortfolioFinancialInputs(
  assets: PortfolioAssets,
  liabilities: PortfolioLiabilities,
  summary: BookkeepingSummary | null,
  transactions: BookkeepingTransaction[],
): FinancialInputs | null {
  const totalRealEstateValue = assets.realEstate.reduce((sum, asset) => sum + asset.value, 0);
  const mortgageLiabilities = liabilities.filter((liability) => liability.type === 'mortgage');
  const totalOriginalLoanAmount = mortgageLiabilities.reduce((sum, liability) => sum + (liability.originalAmount ?? liability.balance), 0);
  const totalCurrentLoanBalance = mortgageLiabilities.reduce((sum, liability) => sum + liability.balance, 0);
  const annualIncome = summary?.totalIncome && summary.totalIncome > 0
    ? summary.totalIncome
    : sumTransactionsByType(transactions, 'income');

  const taxExpense = sumTransactionCategories(transactions, 'expense', ['tax']);
  const insuranceExpense = sumTransactionCategories(transactions, 'expense', ['insurance']);
  const utilityExpense = sumTransactionCategories(transactions, 'expense', ['utility', 'utilities', 'water', 'electric', 'gas', 'sewer']);
  const hoaExpense = sumTransactionCategories(transactions, 'expense', ['hoa', 'association']);
  const repairExpense = sumTransactionCategories(transactions, 'expense', ['repair', 'maintenance', 'capex', 'turn']);
  const managementExpense = sumTransactionCategories(transactions, 'expense', ['management', 'leasing', 'property manager']);

  const annualTaxExpense = taxExpense > 0 ? taxExpense : sumSummaryCategories(summary, ['tax']);
  const annualInsuranceExpense = insuranceExpense > 0 ? insuranceExpense : sumSummaryCategories(summary, ['insurance']);
  const annualUtilityExpense = utilityExpense > 0 ? utilityExpense : sumSummaryCategories(summary, ['utility', 'utilities', 'water', 'electric', 'gas', 'sewer']);
  const annualHoaExpense = hoaExpense > 0 ? hoaExpense : sumSummaryCategories(summary, ['hoa', 'association']);
  const annualRepairExpense = repairExpense > 0 ? repairExpense : sumSummaryCategories(summary, ['repair', 'maintenance', 'capex', 'turn']);
  const annualManagementExpense = managementExpense > 0 ? managementExpense : sumSummaryCategories(summary, ['management', 'leasing', 'property manager']);

  const monthlyDebtServiceTotal = mortgageLiabilities.reduce((sum, liability) => sum + (liability.monthlyPayment ?? 0), 0);
  const mortgageRate = weightedAverage(
    mortgageLiabilities.map((liability) => ({
      weight: liability.balance || liability.originalAmount || 0,
      value: liability.interestRate,
    })),
    7,
  );
  const remainingTermMonths = Math.round(weightedAverage(
    mortgageLiabilities.map((liability) => ({
      weight: liability.balance || liability.originalAmount || 0,
      value: liability.termMonths,
    })),
    360,
  ));
  const baseValue = totalRealEstateValue > 0 ? totalRealEstateValue : Math.max(totalOriginalLoanAmount, totalCurrentLoanBalance, 0);

  if (baseValue <= 0 && annualIncome <= 0 && monthlyDebtServiceTotal <= 0) {
    return null;
  }

  const taxAmount = annualTaxExpense > 0 ? annualTaxExpense : baseValue * 0.011;
  const insurance = annualInsuranceExpense > 0 ? annualInsuranceExpense : baseValue * 0.004;
  const repairsCapEx = annualRepairExpense > 0 ? annualRepairExpense : (baseValue > 0 ? Math.max(baseValue * 0.008, 2400) : 2400);
  const downPayment = Math.max(baseValue - (totalOriginalLoanAmount || totalCurrentLoanBalance), baseValue * 0.2);

  return {
    avm: baseValue,
    taxAmount,
    originalLoanAmount: totalOriginalLoanAmount || undefined,
    currentLoanBalance: totalCurrentLoanBalance || totalOriginalLoanAmount || undefined,
    remainingLoanTermMonths: remainingTermMonths,
    monthlyDebtService: monthlyDebtServiceTotal || undefined,
    monthlyRent: annualIncome / 12,
    otherIncome: 0,
    vacancyRate: 5,
    rentGrowth: 3,
    insurance,
    utilities: annualUtilityExpense,
    hoa: annualHoaExpense,
    repairsCapEx,
    managementPct: annualIncome > 0 ? (annualManagementExpense / annualIncome) * 100 : 8,
    expenseInflation: 2.5,
    taxGrowth: 2,
    interestRate: mortgageRate,
    loanTerm: remainingTermMonths,
    isInterestOnly: false,
    downPayment,
    closingCosts: baseValue * 0.03,
    initialRehab: 0,
  };
}

function getAnalyticsContextLabel(
  property: DashboardProperty | null,
  usingPortfolioFallback: boolean,
  isPortfolioScope: boolean,
  portfolioLabel: string,
) {
  if (isPortfolioScope) return portfolioLabel;
  if (!property) return 'Selected property';
  return usingPortfolioFallback ? property.address : property.data?.summary.address || property.address;
}

function deriveFinancialInputsFromProperty(property: DashboardProperty | null): FinancialInputs | null {
  if (!property) return null;

  const propertyData = property.data || null;
  const summary = propertyData?.summary || null;
  const financials = property.financialData || null;
  const avm = Number(summary?.avm_value) || 0;

  if (avm === 0) {
    return null;
  }

  const latestTaxRecord = Array.isArray(propertyData?.tax_history)
    ? [...propertyData.tax_history].sort((left, right) => Number(right?.year || 0) - Number(left?.year || 0))[0]
    : null;
  const taxAmount = Number(latestTaxRecord?.tax_amount) || 0;

  return {
    avm,
    taxAmount,
    monthlyRent: Number(financials?.monthlyRent) || Number(summary?.rental_avm) || 0,
    otherIncome: Number(financials?.otherIncome) || 0,
    vacancyRate: Number(financials?.vacancyRate ?? 5),
    rentGrowth: Number(financials?.rentGrowth ?? 3),
    insurance: Number(financials?.insurance) || 0,
    utilities: Number(financials?.utilities) || 0,
    hoa: Number(financials?.hoa) || 0,
    repairsCapEx: Number(financials?.repairsCapEx) || 0,
    managementPct: Number(financials?.managementPct ?? 8),
    expenseInflation: Number(financials?.expenseInflation ?? 3),
    taxGrowth: Number(financials?.taxInflation ?? 3),
    interestRate: Number(financials?.interestRate) || 0,
    loanTerm: Number(financials?.loanTerm) || 360,
    isInterestOnly: Boolean(financials?.isInterestOnly),
    downPayment: Number(financials?.downPayment) || 0,
    closingCosts: Number(financials?.closingCosts) || 0,
    initialRehab: Number(financials?.initialRehab) || 0,
    appreciationRate: Number(financials?.appreciationRate ?? 3),
    originalLoanAmount: financials?.originalLoanAmount,
    currentLoanBalance: financials?.currentLoanBalance,
    remainingLoanTermMonths: financials?.remainingLoanTermMonths,
    monthlyDebtService: financials?.monthlyDebtService,
  };
}

function buildDashboardPropertyCashFlowSnapshot({
  surfaceId,
  property,
  propertyLabel,
}: {
  surfaceId: string;
  property: DashboardProperty | null;
  propertyLabel: string;
}): DashboardPropertyCashFlowSnapshot | null {
  const financialInputs = deriveFinancialInputsFromProperty(property);
  if (!financialInputs) {
    return null;
  }

  const chartData = buildAnalyticsChartData(financialInputs as PropertyAnalyticsSurfaceFinancialInputs, 'annual');
  if (!chartData || chartData.projectionLabels.length === 0 || chartData.cashFlow.length === 0) {
    return null;
  }

  const yearlyValues = chartData.projectionLabels.reduce<DashboardPropertyCashFlowSnapshot['yearlyValues']>((points, year, index) => {
    const rawValue = chartData.cashFlow[index];
    if (rawValue === undefined || rawValue === null || Number.isNaN(rawValue)) {
      return points;
    }

    const value = Math.round(rawValue * 1000);
    points.push({
      year,
      value,
      formatted: `${value < 0 ? '-$' : '$'}${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    });
    return points;
  }, []);

  if (yearlyValues.length === 0) {
    return null;
  }

  return {
    surfaceId,
    propertyId: property?.id,
    propertyLabel,
    yearlyValues,
  };
}

function calculateTotalAssets(assets: PortfolioAssets) {
  return Object.values(assets || {}).reduce(
    (total, assetGroup) => total + (Array.isArray(assetGroup) ? assetGroup : []).reduce((sum, asset) => sum + Number(asset.value || 0), 0),
    0,
  );
}

function calculateTotalLiabilities(liabilities: PortfolioLiabilities) {
  return (Array.isArray(liabilities) ? liabilities : []).reduce((total, liability) => total + Number(liability.balance || 0), 0);
}

function normalizeDashboardAnalyticsPropertyDashboard(
  propertyDashboard: PropertyDashboard | null | undefined,
  fallbackAddress: string,
): PropertyDashboard {
  const safeSummary = propertyDashboard?.summary || {};
  const safeTaxHistory = Array.isArray(propertyDashboard?.tax_history) ? propertyDashboard.tax_history : [];
  const safeAvmHistory = Array.isArray(propertyDashboard?.avm_history) ? propertyDashboard.avm_history : [];

  return {
    ...(propertyDashboard || {}),
    summary: {
      ...safeSummary,
      address: safeSummary.address || fallbackAddress,
    },
    tax_history: safeTaxHistory,
    tax_meta: propertyDashboard?.tax_meta || { count: safeTaxHistory.length },
    avm_history: safeAvmHistory,
  };
}

function buildPortfolioAnalyticsPropertyDashboard(
  analytics: PortfolioAnalyticsContext | null | undefined,
): PropertyDashboard {
  const avmHistory = Array.isArray(analytics?.avmHistory) ? analytics.avmHistory : [];
  const taxHistory = Array.isArray(analytics?.taxHistory) ? analytics.taxHistory : [];
  const today = new Date();

  return {
    summary: {
      address: analytics?.label || 'Portfolio-wide view',
      avm_value: avmHistory[avmHistory.length - 1]?.value,
    },
    tax_history: taxHistory.map((point, index) => ({
      year: Number(point.label) || today.getFullYear() - (taxHistory.length - 1 - index),
      tax_amount: point.amount,
      tax_amount_yoy_pct: point.yoy ?? undefined,
    })),
    tax_meta: { count: taxHistory.length },
    avm_history: avmHistory.map((point, index) => {
      const parsedDate = new Date(point.fullLabel);
      const fallbackDate = new Date(today.getFullYear(), today.getMonth() - (avmHistory.length - 1 - index), 1);

      return {
        date: Number.isNaN(parsedDate.getTime()) ? fallbackDate.toISOString() : parsedDate.toISOString(),
        value: point.value,
        low: point.low ?? undefined,
        high: point.high ?? undefined,
      };
    }),
  };
}

function buildCanonicalOwnerPropertyInputs(properties: DashboardProperty[]): OwnerPropertyApiRecord[] {
  return properties.map((property) => ({
    id: property.id,
    address: property.address,
    createdAt: property.savedAt,
    updatedAt: property.updatedAt,
    financials: property.financialData || {},
    propertyData: property.data || undefined,
    property_data: property.data || undefined,
    tenantCount: property.tenantCount,
  }));
}

function filterRemovedPersonalFinanceSurfaces(ids: DashboardSurfaceId[]): DashboardSurfaceId[] {
  return ids.filter((id) => !REMOVED_PERSONAL_FINANCE_SURFACE_IDS.has(id));
}

function buildPropertyValueBreakdown(
  realEstateAssets: Array<{ id?: string; name: string; value: number }>,
): Array<{ key: string; label: string; value: number; percent: number; color: string }> {
  const palette = ['#14b8a6', '#6366f1', '#ec4899', '#f97316', '#8b5cf6', '#3b82f6'];
  const positiveAssets = realEstateAssets.filter((asset) => asset.value > 0);
  const total = positiveAssets.reduce((sum, asset) => sum + asset.value, 0);

  return positiveAssets
    .sort((left, right) => right.value - left.value)
    .map((asset, index) => ({
      key: asset.id || asset.name,
      label: asset.name,
      value: asset.value,
      percent: total > 0 ? (asset.value / total) * 100 : 0,
      color: palette[index % palette.length],
    }));
}

function buildRealEstateYtdChange(snapshots: PortfolioSnapshot[], currentValue: number): number {
  const historicalSeries = [...snapshots]
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())
    .filter((snapshot) => snapshot.assets.realEstate > 0);

  if (historicalSeries.length >= 2) {
    const startValue = historicalSeries[0].assets.realEstate;
    const endValue = historicalSeries[historicalSeries.length - 1].assets.realEstate;
    return startValue > 0 ? ((endValue - startValue) / startValue) * 100 : 0;
  }

  if (currentValue <= 0) {
    return 0;
  }

  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const yearStartSnapshot = historicalSeries.find((snapshot) => new Date(snapshot.date) >= yearStart);
  if (yearStartSnapshot && yearStartSnapshot.assets.realEstate > 0) {
    return ((currentValue - yearStartSnapshot.assets.realEstate) / yearStartSnapshot.assets.realEstate) * 100;
  }

  return 0;
}

function buildPortfolioAllocation(
  assets: PortfolioAssets,
  realEstateAssets: PortfolioAssets['realEstate'],
  liabilities: PortfolioLiabilities,
  viewMode: 'assets' | 'equity',
): PortfolioAllocationSlice[] {
  const totalRealEstateValue = realEstateAssets.reduce((sum, asset) => sum + asset.value, 0);
  const totalAlternativeValue = assets.alternatives.reduce((sum, asset) => sum + asset.value, 0);
  const totalStockValue = assets.stocks.reduce((sum, asset) => sum + asset.value, 0);
  const totalBondValue = assets.bonds.reduce((sum, asset) => sum + asset.value, 0);
  const totalCashValue = assets.cash.reduce((sum, asset) => sum + asset.value, 0);
  const totalAssetValue = totalRealEstateValue + totalAlternativeValue + totalStockValue + totalBondValue + totalCashValue;
  const totalLiabilityValue = calculateTotalLiabilities(liabilities);
  const realEstateEquityValue = realEstateAssets.reduce((sum, asset) => {
    const linkedMortgage = liabilities.find((liability) => liability.linkedAssetId === asset.id);
    return sum + Math.max(asset.value - (linkedMortgage?.balance || 0), 0);
  }, 0) + totalAlternativeValue;
  const realEstateDisplayValue = viewMode === 'equity'
    ? realEstateEquityValue
    : totalRealEstateValue + totalAlternativeValue;
  const totalValue = viewMode === 'equity'
    ? totalAssetValue - totalLiabilityValue
    : totalAssetValue;
  const realEstateAssetList = viewMode === 'equity'
    ? [
        ...realEstateAssets.map((asset) => {
          const linkedMortgage = liabilities.find((liability) => liability.linkedAssetId === asset.id);
          return {
            name: asset.name,
            value: Math.max(0, asset.value - (linkedMortgage?.balance || 0)),
          };
        }),
        ...assets.alternatives.map((asset) => ({
          name: asset.name,
          value: asset.value,
        })),
      ]
    : [...realEstateAssets, ...assets.alternatives].map((asset) => ({
        name: asset.name,
        value: asset.value,
      }));

  const slices = [
    {
      key: 'realEstate',
      label: 'Real Estate',
      value: realEstateDisplayValue,
      color: '#ec4899',
      assetList: realEstateAssetList
        .filter((asset) => asset.value > 0)
        .sort((left, right) => right.value - left.value)
        .map((asset) => ({
          name: asset.name,
          value: asset.value,
        })),
    },
    {
      key: 'stocks',
      label: 'Equities',
      value: assets.stocks.reduce((sum, asset) => sum + asset.value, 0),
      color: '#f97316',
      assetList: [...assets.stocks]
        .filter((asset) => asset.value > 0)
        .sort((left, right) => right.value - left.value)
        .map((asset) => ({
          name: asset.name,
          value: asset.value,
        })),
    },
    {
      key: 'bonds',
      label: 'Fixed income & preferreds',
      value: assets.bonds.reduce((sum, asset) => sum + asset.value, 0),
      color: '#3b82f6',
      assetList: [...assets.bonds]
        .filter((asset) => asset.value > 0)
        .sort((left, right) => right.value - left.value)
        .map((asset) => ({
          name: asset.name,
          value: asset.value,
        })),
    },
    {
      key: 'cash',
      label: 'Cash',
      value: assets.cash.reduce((sum, asset) => sum + asset.value, 0),
      color: '#a855f7',
      assetList: [...assets.cash]
        .filter((asset) => asset.value > 0)
        .sort((left, right) => right.value - left.value)
        .map((asset) => ({
          name: asset.name,
          value: asset.value,
        })),
    },
  ].filter((slice) => slice.value > 0);

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  return slices.map((slice) => ({
      ...slice,
      percent: totalValue > 0 ? (slice.value / totalValue) * 100 : 0,
    }));
}

function buildPortfolioAllocationClassDetails(
  assets: PortfolioAssets,
  ownerProperties: CanonicalOwnerPropertyRecord[],
  realEstateAssets: PortfolioAssets['realEstate'],
  liabilities: PortfolioLiabilities,
  totalValue: number,
  viewMode: 'assets' | 'equity',
  stockBasicInfo: DashboardStockBasicInfoMap,
) {
  const normalizeLookupKey = (value: string | null | undefined) => String(value || '').trim().toLowerCase();
  const findPropertyForAsset = (asset: { id?: string; name: string }) => {
    const assetName = normalizeLookupKey(asset.name);
    const assetStem = assetName.split(',')[0];

    return ownerProperties.find((property) => {
      const propertyAddress = normalizeLookupKey(property.address || property.propertyData.summary?.address);
      const propertyStem = propertyAddress.split(',')[0];

      return property.id === asset.id || Boolean(
        assetStem
        && propertyStem
        && (propertyStem.includes(assetStem) || assetStem.includes(propertyStem))
      );
    }) || null;
  };

  const totalMortgageDebt = liabilities
    .filter((liability) => liability.type === 'mortgage')
    .reduce((sum, liability) => sum + liability.balance, 0);
  const occupiedProperties = ownerProperties.filter((property) => (property.tenantCount ?? 0) > 0 || property.derived.monthlyIncome > 0).length;
  const totalMonthlyRent = ownerProperties.reduce((sum, property) => sum + property.derived.monthlyIncome, 0);
  const totalMonthlyCashFlow = ownerProperties.reduce((sum, property) => sum + property.derived.monthlyCashFlow, 0);
  const totalAlternativeValue = assets.alternatives.reduce((sum, asset) => sum + asset.value, 0);
  const totalStockValue = assets.stocks.reduce((sum, asset) => sum + asset.value, 0);
  const totalBondValue = assets.bonds.reduce((sum, asset) => sum + asset.value, 0);
  const totalCashValue = assets.cash.reduce((sum, asset) => sum + asset.value, 0);
  const realEstateDisplayValue = viewMode === 'equity'
    ? realEstateAssets.reduce((sum, asset) => {
        const linkedMortgage = liabilities.find((liability) => liability.linkedAssetId === asset.id);
        return sum + Math.max(asset.value - (linkedMortgage?.balance || 0), 0);
      }, 0) + totalAlternativeValue
    : realEstateAssets.reduce((sum, asset) => sum + asset.value, 0) + totalAlternativeValue;

  const realEstateHoldings = [
    ...realEstateAssets.map((asset, index) => {
      const matchedProperty = findPropertyForAsset(asset);
      const linkedMortgage = liabilities.find((liability) => liability.linkedAssetId === asset.id);
      const rent = matchedProperty?.derived.monthlyIncome ?? 0;
      const cashFlow = matchedProperty?.derived.monthlyCashFlow ?? 0;
      const tenantCount = matchedProperty?.tenantCount ?? 0;
      const equityValue = asset.value - (linkedMortgage?.balance || 0);
      const displayValue = viewMode === 'equity' ? Math.max(equityValue, 0) : asset.value;

      return {
        id: asset.id || `real-estate-${index}`,
        name: asset.name,
        subtitle: tenantCount > 0
          ? `${tenantCount} tenant${tenantCount === 1 ? '' : 's'} on file`
          : 'Property profile synced into portfolio',
        value: displayValue,
        weight: realEstateDisplayValue > 0 ? (displayValue / realEstateDisplayValue) * 100 : 0,
        primaryMeta: rent > 0 ? `${formatCurrency(rent)} / mo gross rent` : 'No rent baseline on file',
        secondaryMeta: linkedMortgage
          ? `${formatCurrency(Math.max(0, equityValue))} equity after debt`
          : cashFlow !== 0
            ? `${formatCurrency(cashFlow)} / mo cash flow`
            : 'No linked mortgage',
        badgeText: 'RE',
      };
    }),
    ...assets.alternatives.map((asset, index) => ({
      id: asset.id || `alternative-${index}`,
      name: asset.name,
      subtitle: 'Alternative holding grouped with real estate sleeve',
      value: asset.value,
      weight: realEstateDisplayValue > 0 ? (asset.value / realEstateDisplayValue) * 100 : 0,
      primaryMeta: viewMode === 'equity'
        ? 'Included in equity-mode real estate view'
        : 'Included in market-value real estate view',
      secondaryMeta: 'Manual alternative asset entry',
      badgeText: 'AL',
    })),
  ]
    .sort((left, right) => right.value - left.value);

  const equityHoldings = [...assets.stocks]
    .map((stock, index) => ({
      id: stock.id || `equity-${index}`,
      name: stock.name,
      subtitle: stock.ticker || 'Equity position',
      value: stock.value,
      weight: totalStockValue > 0 ? (stock.value / totalStockValue) * 100 : 0,
      primaryMeta: stock.shares
        ? `${stock.shares.toLocaleString()} shares tracked`
        : 'Position sized by market value',
      secondaryMeta: stock.costBasis
        ? `${stock.value - stock.costBasis >= 0 ? '+' : '-'}${formatCurrency(Math.abs(stock.value - stock.costBasis))} vs cost`
        : 'No dividend or cost basis data',
      badgeText: (stock.ticker || stock.name || 'EQ').slice(0, 2).toUpperCase(),
      logoUrl: stock.ticker ? stockBasicInfo[stock.ticker]?.logoUrl : undefined,
      interactiveType: 'stock' as const,
    }))
    .sort((left, right) => right.value - left.value);

  const bondHoldings = [...assets.bonds]
    .map((bond, index) => ({
      id: bond.id || `bond-${index}`,
      name: bond.name,
      subtitle: bond.ticker || 'Fixed income holding',
      value: bond.value,
      weight: totalBondValue > 0 ? (bond.value / totalBondValue) * 100 : 0,
      primaryMeta: `${(4.5).toFixed(2)}% est. yield`,
      secondaryMeta: `${formatCurrency(bond.value * 0.045)} / yr income`,
      badgeText: (bond.ticker || 'FI').slice(0, 2).toUpperCase(),
    }))
    .sort((left, right) => right.value - left.value);

  const cashHoldings = [...assets.cash]
    .map((cash, index) => ({
      id: cash.id || `cash-${index}`,
      name: cash.name,
      subtitle: 'Liquid balance',
      value: cash.value,
      weight: totalCashValue > 0 ? (cash.value / totalCashValue) * 100 : 0,
      primaryMeta: totalValue > 0 ? `${((cash.value / totalValue) * 100).toFixed(1)}% of portfolio` : 'Liquidity reserve',
      secondaryMeta: 'Available for reserves or deployment',
      badgeText: 'CA',
    }))
    .sort((left, right) => right.value - left.value);

  const realEstateValue = realEstateHoldings.reduce((sum, holding) => sum + holding.value, 0);
  const equitiesValue = equityHoldings.reduce((sum, holding) => sum + holding.value, 0);
  const bondValue = bondHoldings.reduce((sum, holding) => sum + holding.value, 0);
  const cashValue = cashHoldings.reduce((sum, holding) => sum + holding.value, 0);

  const largestRealEstateHolding = realEstateHoldings[0];
  const largestEquityHolding = equityHoldings[0];
  const largestBondHolding = bondHoldings[0];
  const largestCashHolding = cashHoldings[0];

  return {
    'Real Estate': {
      label: 'Real Estate',
      color: '#ec4899',
      value: realEstateValue,
      percentage: totalValue > 0 ? (realEstateValue / totalValue) * 100 : 0,
      description: 'Properties and alternative real-estate sleeve holdings pulled into the finance view from the canonical property profile plus unmatched manual fallback entries.',
      stats: [
        { label: 'Holdings', value: `${realEstateHoldings.length}` },
        { label: 'Rent-paying properties', value: `${occupiedProperties}` },
        { label: 'Gross monthly rent', value: formatCurrency(totalMonthlyRent) },
        { label: viewMode === 'equity' ? 'Sleeve equity value' : 'Linked mortgage debt', value: formatCurrency(viewMode === 'equity' ? realEstateValue : totalMortgageDebt) },
        { label: 'Largest holding', value: largestRealEstateHolding ? `${largestRealEstateHolding.name} (${largestRealEstateHolding.weight.toFixed(1)}%)` : '—' },
      ],
      holdings: realEstateHoldings,
    },
    Equities: {
      label: 'Equities',
      color: '#f97316',
      value: equitiesValue,
      percentage: totalValue > 0 ? (equitiesValue / totalValue) * 100 : 0,
      description: 'Public equity positions sized by live market value, with ticker metadata carried through from the same portfolio service used on the net-worth page.',
      stats: [
        { label: 'Positions', value: `${equityHoldings.length}` },
        { label: 'Dividend payers', value: '0' },
        { label: 'Annual dividends', value: formatCurrency(0) },
        { label: 'Largest position', value: largestEquityHolding ? `${largestEquityHolding.subtitle} (${largestEquityHolding.weight.toFixed(1)}%)` : '—' },
        { label: 'Avg position size', value: equityHoldings.length > 0 ? `${(100 / equityHoldings.length).toFixed(1)}% of sleeve` : '—' },
      ],
      holdings: equityHoldings,
    },
    'Fixed income & preferreds': {
      label: 'Fixed income & preferreds',
      color: '#3b82f6',
      value: bondValue,
      percentage: totalValue > 0 ? (bondValue / totalValue) * 100 : 0,
      description: 'Yield-oriented fixed-income and preferred positions, summarized by sleeve weight, estimated income, and blended portfolio yield.',
      stats: [
        { label: 'Holdings', value: `${bondHoldings.length}` },
        { label: 'Est. annual income', value: formatCurrency(bondValue * 0.045) },
        { label: 'Blended sleeve yield', value: `${(bondValue > 0 ? ((bondValue * 0.045) / bondValue) * 100 : 0).toFixed(2)}%` },
        { label: 'Largest holding', value: largestBondHolding ? `${largestBondHolding.subtitle} (${largestBondHolding.weight.toFixed(1)}%)` : '—' },
        { label: 'Avg position size', value: bondHoldings.length > 0 ? `${(100 / bondHoldings.length).toFixed(1)}% of sleeve` : '—' },
      ],
      holdings: bondHoldings,
    },
    Cash: {
      label: 'Cash',
      color: '#a855f7',
      value: cashValue,
      percentage: totalValue > 0 ? (cashValue / totalValue) * 100 : 0,
      description: 'Immediate liquidity across connected or manually entered cash balances that can fund reserves, obligations, or new deployments.',
      stats: [
        { label: 'Accounts / buckets', value: `${cashHoldings.length}` },
        { label: 'Portfolio share', value: totalValue > 0 ? `${((cashValue / totalValue) * 100).toFixed(2)}%` : '0.00%' },
        { label: 'Largest balance', value: largestCashHolding ? formatCurrency(largestCashHolding.value) : '—' },
        { label: 'Deployable now', value: formatCurrency(cashValue) },
      ],
      holdings: cashHoldings,
    },
  };
}

function buildBookkeepingTrendSeries(transactions: BookkeepingTransaction[]): BookkeepingTrendPoint[] {
  const monthBuckets: Array<{ key: string; label: string; fullLabel: string }> = [];
  const now = new Date();

  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    monthBuckets.push({
      key,
      label: date.toLocaleDateString('en-US', { month: 'short' }),
      fullLabel: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
    });
  }

  const totals = new Map<string, { income: number; expense: number }>();

  transactions.forEach((transaction) => {
    const date = new Date(transaction.date);
    if (Number.isNaN(date.getTime())) return;

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!totals.has(key)) {
      totals.set(key, { income: 0, expense: 0 });
    }

    const entry = totals.get(key)!;
    const amount = Math.abs(Number(transaction.amount || 0));
    if (transaction.type === 'income') {
      entry.income += amount;
    } else {
      entry.expense += amount;
    }
  });

  return monthBuckets.map((bucket) => {
    const entry = totals.get(bucket.key) || { income: 0, expense: 0 };
    return {
      label: bucket.label,
      fullLabel: bucket.fullLabel,
      income: entry.income,
      expense: entry.expense,
      net: entry.income - entry.expense,
    };
  });
}

function getFeaturedWorkflowActions(): ControlAction[] {
  return getWorkflowActionsByIds(FEATURED_WORKFLOW_ACTION_IDS);
}

function getWorkflowActionsByIds(actionIds: string[]): ControlAction[] {
  return actionIds
    .map((actionId) => WEBSITE_ACTIONS.find((action) => action.id === actionId) || null)
    .filter((action): action is ControlAction => action !== null);
}

function getActionDestination(action: ControlAction) {
  return action.route || action.requiresNavigation || null;
}

function formatRouteLabel(route: string) {
  return route
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/-/g, ' '))
    .join(' / ');
}

function isDashboardSurfaceId(value: unknown): value is DashboardSurfaceId {
  return typeof value === 'string' && SURFACE_LIBRARY.some((surface) => surface.id === value);
}

function orderSurfaceIds(ids: DashboardSurfaceId[]) {
  return SURFACE_LIBRARY.map((surface) => surface.id).filter((surfaceId) => ids.includes(surfaceId));
}

function normalizeDashboardMatchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeDashboardMatchToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getDashboardSurfaceSearchTerms(surface: DashboardSurfaceDefinition) {
  return [
    surface.title,
    surface.source,
    surface.id.replace(/-/g, ' '),
    ...surface.keywords,
    ...(DASHBOARD_SURFACE_INTENT_ALIASES[surface.id] || []),
  ].filter((term): term is string => typeof term === 'string' && term.trim().length > 0);
}

function damerauLevenshteinDistance(left: string, right: string) {
  const leftLength = left.length;
  const rightLength = right.length;

  if (leftLength === 0) return rightLength;
  if (rightLength === 0) return leftLength;

  const matrix = Array.from({ length: leftLength + 1 }, () => Array<number>(rightLength + 1).fill(0));

  for (let leftIndex = 0; leftIndex <= leftLength; leftIndex += 1) {
    matrix[leftIndex][0] = leftIndex;
  }

  for (let rightIndex = 0; rightIndex <= rightLength; rightIndex += 1) {
    matrix[0][rightIndex] = rightIndex;
  }

  for (let leftIndex = 1; leftIndex <= leftLength; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightLength; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;

      matrix[leftIndex][rightIndex] = Math.min(
        matrix[leftIndex - 1][rightIndex] + 1,
        matrix[leftIndex][rightIndex - 1] + 1,
        matrix[leftIndex - 1][rightIndex - 1] + substitutionCost,
      );

      if (
        leftIndex > 1
        && rightIndex > 1
        && left[leftIndex - 1] === right[rightIndex - 2]
        && left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        matrix[leftIndex][rightIndex] = Math.min(
          matrix[leftIndex][rightIndex],
          matrix[leftIndex - 2][rightIndex - 2] + 1,
        );
      }
    }
  }

  return matrix[leftLength][rightLength];
}

function getDashboardTokenDistanceThreshold(tokenLength: number) {
  if (tokenLength >= 9) return 3;
  if (tokenLength >= 6) return 2;
  if (tokenLength >= 4) return 1;
  return 0;
}

function isDashboardTokenApproximateMatch(promptToken: string, keywordToken: string) {
  if (promptToken === keywordToken) {
    return true;
  }

  if (!promptToken || !keywordToken) {
    return false;
  }

  const lengthDifference = Math.abs(promptToken.length - keywordToken.length);
  const threshold = getDashboardTokenDistanceThreshold(keywordToken.length);

  if (lengthDifference > threshold) {
    return false;
  }

  return damerauLevenshteinDistance(promptToken, keywordToken) <= threshold;
}

function matchesDashboardKeyword(prompt: string, promptTokens: string[], keyword: string) {
  const normalizedKeyword = normalizeDashboardMatchText(keyword);

  if (!normalizedKeyword) {
    return false;
  }

  if (prompt.includes(normalizedKeyword)) {
    return true;
  }

  const keywordTokens = normalizedKeyword
    .split(/\s+/)
    .map((token) => normalizeDashboardMatchToken(token))
    .filter(Boolean);

  if (keywordTokens.length === 0) {
    return false;
  }

  return keywordTokens.every((keywordToken) =>
    promptTokens.some((promptToken) => isDashboardTokenApproximateMatch(promptToken, keywordToken)),
  );
}

function scoreDashboardKeywordMatch(prompt: string, promptTokens: string[], keyword: string) {
  const normalizedKeyword = normalizeDashboardMatchText(keyword);

  if (!normalizedKeyword) {
    return 0;
  }

  if (prompt.includes(normalizedKeyword)) {
    return 120 + normalizedKeyword.length;
  }

  const keywordTokens = normalizedKeyword
    .split(/\s+/)
    .map((token) => normalizeDashboardMatchToken(token))
    .filter(Boolean);

  if (keywordTokens.length === 0) {
    return 0;
  }

  let totalDistance = 0;

  for (const keywordToken of keywordTokens) {
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const promptToken of promptTokens) {
      const threshold = getDashboardTokenDistanceThreshold(keywordToken.length);
      const distance = damerauLevenshteinDistance(promptToken, keywordToken);

      if (distance <= threshold && distance < bestDistance) {
        bestDistance = distance;
      }
    }

    if (!Number.isFinite(bestDistance)) {
      return 0;
    }

    totalDistance += bestDistance;
  }

  return 64 + (keywordTokens.length * 14) - (totalDistance * 8);
}

function getDashboardSurfaceMatchScores(prompt: string) {
  const normalized = normalizeDashboardMatchText(prompt);
  const promptTokens = normalized
    .split(/\s+/)
    .map((token) => normalizeDashboardMatchToken(token))
    .filter(Boolean);

  return SURFACE_LIBRARY.map((surface) => {
    const score = getDashboardSurfaceSearchTerms(surface).reduce((bestScore, keyword) => {
      const keywordScore = scoreDashboardKeywordMatch(normalized, promptTokens, keyword);
      return Math.max(bestScore, keywordScore);
    }, 0);

    return { surface, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return SURFACE_LIBRARY_INDEX[left.surface.id] - SURFACE_LIBRARY_INDEX[right.surface.id];
    });
}

function shouldKeepDashboardBoardContext(prompt: string) {
  return /\b(add|include|alongside|along with|compare|versus|vs|remove|hide|dismiss|close|clear|reset)\b/.test(normalizeDashboardMatchText(prompt));
}

function parseDashboardCommand(prompt: string, currentIds: DashboardSurfaceId[]): CommandPlan {
  const normalized = prompt.toLowerCase().trim();

  if (!normalized) {
    return {
      nextIds: currentIds,
      highlightId: currentIds[0] || null,
      message: 'Ask for a property image, tax PDF, bookkeeping trend, workflow shortcuts, or any property analytics card like price history, cash flow, NOI, equity, total return, or IRR.',
    };
  }

  if (/reset|default board|restore board/.test(normalized)) {
    return {
      nextIds: filterRemovedPersonalFinanceSurfaces(DEFAULT_SURFACE_IDS),
      highlightId: DEFAULT_SURFACE_IDS[0],
      message: 'Reset the board to the default snapshot layout.',
    };
  }

  if (/clear|empty board|remove everything/.test(normalized)) {
    return {
      nextIds: [],
      highlightId: null,
      message: 'Cleared the board. Ask for any graph or overview card and I will render it here.',
    };
  }

  if (/all analytics|additional analytics|analytics suite|property analytics/.test(normalized)) {
    return {
      nextIds: orderSurfaceIds(ANALYTICS_SUITE_SURFACE_IDS),
      highlightId: ANALYTICS_SUITE_SURFACE_IDS[0],
      message: 'Rendered the full additional analytics suite.',
    };
  }

  const actionMatch = websiteControl.findAction(normalized);
  const workflowSurfaceIntent = /workflow|shortcut|shortcuts|controls|control center|quick actions/.test(normalized);

  if (actionMatch && !workflowSurfaceIntent) {
    return {
      nextIds: currentIds,
      highlightId: currentIds[0] || null,
      message: `Prepared ${actionMatch.name} for dashboard control.`,
      actionId: actionMatch.id,
    };
  }

  const matches = findDashboardSurfaceMatches(normalized);

  if (!matches.length) {
    if (actionMatch) {
      return {
        nextIds: currentIds,
        highlightId: currentIds[0] || null,
        message: `Prepared ${actionMatch.name} for dashboard control.`,
        actionId: actionMatch.id,
      };
    }

    return {
      nextIds: currentIds,
      highlightId: currentIds[0] || null,
      message: 'I can render a property image, tax PDF viewer, price history, cash flow, income-expenses, tax history, CoC return, amortization, NOI, equity-appreciation, total return, IRR by holding period, reserves, maintenance, bookkeeping trend, or workflow shortcuts.',
    };
  }

  const matchedIds = matches.map((surface) => surface.id);
  const shouldRemove = /(hide|remove|dismiss|close)/.test(normalized);
  const shouldReplace = /(only|just|focus on|strictly|show me only)/.test(normalized);

  const nextIds = filterRemovedPersonalFinanceSurfaces(
    shouldRemove
      ? currentIds.filter((id) => !matchedIds.includes(id))
      : shouldReplace
        ? orderSurfaceIds(matchedIds)
        : orderSurfaceIds([...currentIds, ...matchedIds]),
  );

  const titleList = matches.map((surface) => surface.title).join(', ');

  return {
    nextIds,
    highlightId: matches[0]?.id || null,
    message: shouldRemove
      ? `Removed ${titleList} from the board.`
      : shouldReplace
        ? `Rendered only ${titleList}.`
        : `Rendered ${titleList} into the dashboard.`,
  };
}

function findDashboardSurfaceMatches(prompt: string) {
  return getDashboardSurfaceMatchScores(prompt).map((entry) => entry.surface);
}

const DASHBOARD_EXPLANATION_PROMPT_PATTERN = /\b(why|what|how|explain|summary|overview|tell me|walk me through|break down|top|largest|biggest|show me|highlight|focus on|which)\b/i;

function isDashboardExplanationPrompt(prompt: string) {
  return DASHBOARD_EXPLANATION_PROMPT_PATTERN.test(prompt);
}

function getSingleDashboardSurfaceMatch(prompt: string): DashboardSurfaceId | null {
  const scoredMatches = getDashboardSurfaceMatchScores(prompt);

  if (scoredMatches.length === 0) {
    return null;
  }

  const [bestMatch, secondMatch] = scoredMatches;

  if (bestMatch.score < 56) {
    return null;
  }

  if (!secondMatch || bestMatch.score >= secondMatch.score + 24) {
    return bestMatch.surface.id;
  }

  return null;
}

function getDashboardPromptFocusSurface(prompt: string): DashboardSurfaceId | null {
  const surfaceId = getSingleDashboardSurfaceMatch(prompt);

  if (!surfaceId || shouldKeepDashboardBoardContext(prompt)) {
    return null;
  }

  return surfaceId;
}

function isGenericDashboardResponseText(text?: string | null) {
  const normalized = (text || '').trim().toLowerCase();
  return normalized === 'updated the dashboard.' || normalized === 'dashboard updated.' || normalized === 'updated the dashboard';
}

const DASHBOARD_SENSITIVE_FINANCIAL_PROMPT_PATTERNS = [
  /transaction/i,
  /bookkeep/i,
  /ledger/i,
  /tax/i,
  /net\s*worth/i,
  /holding/i,
  /balance\s*sheet/i,
  /cash\s*flow/i,
  /bank\s*account/i,
  /statement/i,
  /schedule\s*e/i,
  /1099/i,
  /reserve/i,
  /equity/i,
];

const PORTFOLIO_SEGMENT_KEYWORD_MAP: Record<string, string[]> = {
  stocks: ['stock', 'stocks', 'equity', 'equities', 'share', 'shares', 'holding', 'holdings', 'ticker', 'vanguard', 'etf', 'fund', 'funds'],
  realEstate: ['real estate', 'realestate', 'property', 'properties', 'house', 'home', 'rental', 'rentals', 'land', 'residential', 'cre', 'commercial'],
  cash: ['cash', 'savings', 'liquid', 'liquidity', 'money market', 'checking', 'bank'],
  bonds: ['bond', 'bonds', 'fixed income', 'treasury', 'treasuries', 'fixed-income', 'debt instrument'],
  alternatives: ['alternative', 'alternatives', 'crypto', 'bitcoin', 'commodity', 'commodities', 'private equity', 'hedge', 'art', 'collectible'],
};

function inferPortfolioSegmentKeysFromPrompt(prompt: string): string[] | null {
  const lower = prompt.toLowerCase();
  const matched: string[] = [];
  for (const [key, keywords] of Object.entries(PORTFOLIO_SEGMENT_KEYWORD_MAP)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push(key);
    }
  }
  return matched.length > 0 ? matched : null;
}

function summarizeDashboardAnnotationText(text: string) {
  const firstSentence = text.trim().split(/(?<=[.!?])\s+/)[0] || text.trim();
  return firstSentence.slice(0, 180);
}

  function sanitizeAssistantPlan(
    rawContent: string,
    prompt: string,
    currentIds: DashboardSurfaceId[],
  ): DashboardAssistantPlan {
    const fallbackPlan = parseDashboardCommand(prompt, currentIds);
    const normalized = rawContent.trim().replace(/^```json\s*/i, '').replace(/```$/i, '');
    const parsed = JSON.parse(normalized) as {
      mode?: DashboardAssistantMode;
      surfaces?: string[];
      layout?: Array<{
        id?: string;
        visible?: boolean;
        order?: number;
        size?: string;
        height?: string;
        x?: number;
        y?: number;
        w?: number;
        h?: number;
        zIndex?: number;
        emphasis?: boolean;
      }>;
      annotations?: Array<{
        id?: string;
        text?: string;
        title?: string;
        surfaceId?: string | null;
        placement?: string;
        tone?: string;
        width?: string;
        x?: number;
        y?: number;
        persistent?: boolean;
      }>;
      clearAnnotations?: boolean;
      highlightId?: string | null;
      message?: string;
      answer?: string;
      actionId?: string | null;
      segmentHighlights?: Array<{ surfaceId?: string; keys?: string[] }>;
    };

    const mode = parsed.mode && ['add', 'replace', 'remove', 'clear', 'reset', 'arrange', 'annotate'].includes(parsed.mode)
      ? parsed.mode
      : 'add';
    const requestedIds = Array.isArray(parsed.surfaces)
      ? parsed.surfaces.filter((value): value is DashboardSurfaceId => isDashboardSurfaceId(value))
      : [];
    const parsedLayout = Array.isArray(parsed.layout)
      ? parsed.layout
        .map((entry) => {
          if (!isDashboardSurfaceId(entry.id)) {
            return null;
          }

          return {
            id: entry.id,
            visible: typeof entry.visible === 'boolean' ? entry.visible : undefined,
            order: typeof entry.order === 'number' ? entry.order : undefined,
            size: isDashboardSurfaceSize(entry.size) ? entry.size : undefined,
            height: isDashboardSurfaceHeight(entry.height) ? entry.height : undefined,
            x: typeof entry.x === 'number' ? entry.x : undefined,
            y: typeof entry.y === 'number' ? entry.y : undefined,
            w: typeof entry.w === 'number' ? entry.w : undefined,
            h: typeof entry.h === 'number' ? entry.h : undefined,
            zIndex: typeof entry.zIndex === 'number' ? entry.zIndex : undefined,
            emphasis: typeof entry.emphasis === 'boolean' ? entry.emphasis : undefined,
          } as DashboardSurfaceLayoutPatch;
        })
        .filter((entry): entry is DashboardSurfaceLayoutPatch => entry !== null)
      : [];
    const annotations = Array.isArray(parsed.annotations)
      ? parsed.annotations.map((entry) => sanitizeDashboardAnnotation(entry)).filter((entry): entry is DashboardAnnotation => entry !== null)
      : [];

    let nextIds: DashboardSurfaceId[];
    switch (mode) {
      case 'clear':
        nextIds = [];
        break;
      case 'reset':
        nextIds = DEFAULT_SURFACE_IDS;
        break;
      case 'remove':
        nextIds = currentIds.filter((id) => !requestedIds.includes(id));
        break;
      case 'replace':
        nextIds = requestedIds.length ? orderSurfaceIds(requestedIds) : fallbackPlan.nextIds;
        break;
      case 'arrange':
      case 'annotate':
        nextIds = currentIds;
        break;
      case 'add':
      default:
        nextIds = requestedIds.length ? orderSurfaceIds([...currentIds, ...requestedIds]) : fallbackPlan.nextIds;
        break;
    }

    let layout = parsedLayout;
    let clearAnnotations = parsed.clearAnnotations === true;

    if (mode === 'clear') {
      layout = SURFACE_LIBRARY.map((surface) => ({
        id: surface.id,
        visible: false as boolean,
        emphasis: false as boolean,
      }));
      clearAnnotations = true;
    } else if (mode === 'reset') {
      layout = SURFACE_LIBRARY.map((surface) => {
        const defaults = DEFAULT_SURFACE_LAYOUTS[surface.id];
        return {
          id: surface.id,
          order: defaults.order,
          size: defaults.size,
          height: defaults.height,
          x: defaults.x,
          y: defaults.y,
          w: defaults.w,
          h: defaults.h,
          zIndex: defaults.zIndex,
          emphasis: defaults.emphasis,
          visible: nextIds.includes(surface.id),
        } as DashboardSurfaceLayoutPatch;
      });
      clearAnnotations = true;
    }

    const highlightId = isDashboardSurfaceId(parsed.highlightId)
      ? parsed.highlightId
      : requestedIds[0] || nextIds[0] || null;
    const actionId = typeof parsed.actionId === 'string' && WEBSITE_ACTIONS.some((action) => action.id === parsed.actionId)
      ? parsed.actionId
      : null;

    return {
      nextIds,
      highlightId,
      message: typeof parsed.message === 'string' && parsed.message.trim().length > 0 ? parsed.message : fallbackPlan.message,
      answer: typeof parsed.answer === 'string' && parsed.answer.trim().length > 0 ? parsed.answer.trim() : undefined,
      actionId,
      layout,
      annotations,
      clearAnnotations,
      segmentHighlights: Array.isArray(parsed.segmentHighlights)
        ? parsed.segmentHighlights
            .filter((entry) => isDashboardSurfaceId(entry.surfaceId) && Array.isArray(entry.keys))
            .map((entry) => ({
              surfaceId: entry.surfaceId as DashboardSurfaceId,
              keys: (entry.keys as string[]).filter((k) => typeof k === 'string'),
            }))
        : undefined,
    };
  }

function buildFallbackAssistantAnswer({
  prompt,
  plan,
  propertyCount,
  totalAssetValue,
  totalLiabilityValue,
  netCashFlow,
}: {
  prompt: string;
  plan: DashboardAssistantPlan;
  propertyCount: number;
  totalAssetValue: number;
  totalLiabilityValue: number;
  netCashFlow: number;
}) {
  const visibleTitles = plan.nextIds
    .map((id) => SURFACE_LIBRARY.find((surface) => surface.id === id)?.title)
    .filter((title): title is string => Boolean(title));
  const visibleSummary = visibleTitles.length > 0 ? visibleTitles.join(', ') : 'the default dashboard cards';
  const accountLabel = `${propertyCount} ${propertyCount === 1 ? 'property' : 'properties'}`;

  if (!prompt.trim()) {
    return `This dashboard is scoped to your real estate holdings across ${accountLabel}. Ask about property values, taxes, cash flow, maintenance, or workflow controls and I will explain the answer here while updating the board.`;
  }

  if (plan.actionId) {
    const action = WEBSITE_ACTIONS.find((entry) => entry.id === plan.actionId);
    return `${action?.name || 'That workflow'} was matched from your request on an account-wide dashboard. I kept the visible context on ${visibleSummary} so you can review the result in place while the workflow runs.`;
  }

  if (/why|what|how|explain|summary|overview|tell me|question/.test(prompt.toLowerCase())) {
    const totalPropertyValue = Math.max(totalAssetValue, 0);
    return `I answered this against your entire property portfolio, not a single property. The board is focused on ${visibleSummary}. Total property value is ${formatCurrency(totalPropertyValue)}, and bookkeeping is showing ${formatCurrency(netCashFlow)} in net cash flow across the account.`;
  }

  return `I updated the dashboard across ${accountLabel}. ${plan.message} The visible cards are ${visibleSummary}, so you can review the account-wide answer without changing scope.`;
}

function EmptySnapshot({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full min-h-[140px] items-center justify-center rounded-[20px] border border-dashed border-slate-300 bg-slate-50/80 px-5 text-center">
      <div className="max-w-sm">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
      </div>
    </div>
  );
}

function MetricTile({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'positive' | 'negative' }) {
  const toneClass = tone === 'positive'
    ? 'text-emerald-600'
    : tone === 'negative'
      ? 'text-rose-600'
      : 'text-slate-900';

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mt-2 text-xl font-semibold tracking-[-0.03em] ${toneClass}`}>{value}</div>
    </div>
  );
}

function DetailLine({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dotted border-slate-200 py-1.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`text-right font-semibold ${accent ? 'text-blue-600' : 'text-slate-900'}`}>{value}</span>
    </div>
  );
}

function DashboardOverviewKpiTile({
  label,
  value,
  delta,
  deltaTone = 'neutral',
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: 'positive' | 'negative' | 'neutral';
  accent?: string;
}) {
  const deltaClass = deltaTone === 'positive'
    ? 'text-emerald-700'
    : deltaTone === 'negative'
      ? 'text-rose-700'
      : 'text-slate-500';

  return (
    <div className="flex h-full flex-col justify-between rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-3 text-[1.55rem] font-semibold leading-none tracking-[-0.03em] text-slate-900">{value}</div>
      {delta ? <div className={`mt-1.5 text-xs font-semibold ${deltaClass}`}>{delta}</div> : null}
    </div>
  );
}

function DashboardOverviewSparkline({ series, emptyLabel = 'History will appear once snapshots are available.' }: { series: NetWorthChartSeriesPoint[]; emptyLabel?: string }) {
  const gradientId = useId().replace(/:/g, '');

  if (series.length < 2) {
    return (
      <div className="flex h-[120px] items-center justify-center text-xs font-medium text-slate-400">
        {emptyLabel}
      </div>
    );
  }

  const width = 520;
  const height = 130;
  const padding = 6;
  const values = series.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || Math.max(Math.abs(maxValue) * 0.08, 1000);
  const yMin = minValue - range * 0.16;
  const yMax = maxValue + range * 0.16;
  const points = series.map((point, index) => {
    const x = padding + (index / (series.length - 1)) * (width - padding * 2);
    const y = padding + (height - padding * 2) - ((point.value - yMin) / (yMax - yMin)) * (height - padding * 2);
    return { x, y };
  });
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(2)},${height - padding} L${points[0].x.toFixed(2)},${height - padding} Z`;
  const lastPoint = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="dashboard-overview-sparkline-fill h-[120px] w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`spark-fill-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`spark-line-${gradientId}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="55%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#spark-fill-${gradientId})`} />
      <path d={linePath} fill="none" stroke={`url(#spark-line-${gradientId})`} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastPoint.x} cy={lastPoint.y} r={3.6} fill="#fff" />
      <circle cx={lastPoint.x} cy={lastPoint.y} r={6.5} fill="#8b5cf6" fillOpacity={0.28} />
    </svg>
  );
}

const DASHBOARD_QUICK_ACTION_STYLE: Record<string, { icon: React.ComponentType<{ size?: number; className?: string; color?: string }>; accent: string }> = {
  'open-payment-modal': { icon: CreditCard, accent: '#34d399' },
  'add-tenant': { icon: UserPlus, accent: '#60a5fa' },
  'open-maintenance-modal': { icon: Wrench, accent: '#fbbf24' },
  'upload-document': { icon: FileUp, accent: '#8b5cf6' },
  'open-messaging-modal': { icon: MessageSquare, accent: '#0ea5e9' },
  'add-property': { icon: HousePlus, accent: '#f97316' },
  'open-quickbooks-modal': { icon: RefreshCw, accent: '#a78bfa' },
  'view-mortgage-rate': { icon: Percent, accent: '#f472b6' },
  'open-renovation-planner': { icon: Hammer, accent: '#38bdf8' },
};

const DASHBOARD_SHORTCUT_LABELS: Record<string, string> = {
  'open-payment-modal': 'Payments',
  'add-tenant': 'Tenants',
  'open-maintenance-modal': 'Maintenance',
  'upload-document': 'Documents',
  'open-messaging-modal': 'Messages',
  'add-property': 'Properties',
};

const DASHBOARD_SHORTCUT_DESTINATIONS: Record<string, string> = {
  'open-payment-modal': '/property-management?tab=tenants',
  'add-tenant': '/property-management?tab=tenants',
  'open-maintenance-modal': '/property-management?tab=maintenance',
  'upload-document': '/property-management?tab=documents',
  'open-messaging-modal': '/property-management?tab=tenants',
  'add-property': '/portfolio?tab=properties',
};

function DashboardQuickActions({
  actions,
  onLaunch,
}: {
  actions: ControlAction[];
  onLaunch: (action: ControlAction) => void | Promise<unknown>;
}) {
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Shortcuts</span>
      {actions.map((action) => {
        const style = DASHBOARD_QUICK_ACTION_STYLE[action.id];
        const Icon = style?.icon;
        const accent = style?.accent || '#94a3b8';
        const label = DASHBOARD_SHORTCUT_LABELS[action.id] || action.name;
        const voiceAttrs = buildVoiceUiAttrs({
          id: `dashboard-quick-action-${action.id}`,
          label,
          type: 'button',
          description: `Open ${label.toLowerCase()} from the dashboard shortcuts.`,
          pageSection: 'dashboard-quick-actions',
          keywords: [action.id, ...action.keywords.slice(0, 4)],
          interactive: true,
        });

        return (
          <button
            key={action.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void onLaunch(action);
            }}
            {...voiceAttrs}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1.5 pl-2 pr-3 text-xs font-semibold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-slate-300 hover:bg-slate-50"
          >
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{ background: `${accent}1c` }}
            >
              {Icon ? <Icon size={12} color={accent} className="shrink-0" /> : null}
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

type DashboardActionItemsData = {
  loading: boolean;
  rentCollected: number;
  rentExpected: number;
  expiringLeases: number;
  openMaintenance: number;
  newMessages: number;
};

const DASHBOARD_ACTION_ITEMS_EMPTY: DashboardActionItemsData = {
  loading: true,
  rentCollected: 0,
  rentExpected: 0,
  expiringLeases: 0,
  openMaintenance: 0,
  newMessages: 0,
};

function isOpenMaintenanceStatus(status: unknown): boolean {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return true;
  return !['resolved', 'closed', 'completed', 'complete', 'cancelled', 'canceled', 'done'].includes(normalized);
}

function useDashboardActionItems({
  ownerId,
  transactions,
  enabled,
}: {
  ownerId: string | null | undefined;
  transactions: BookkeepingTransaction[];
  enabled: boolean;
}): DashboardActionItemsData {
  const [remote, setRemote] = useState<Omit<DashboardActionItemsData, 'rentCollected'>>(DASHBOARD_ACTION_ITEMS_EMPTY);

  const rentCollected = useMemo(() => {
    const now = new Date();
    return transactions
      .filter((transaction) => {
        if (transaction.type !== 'income') return false;
        const date = new Date(transaction.date);
        if (Number.isNaN(date.getTime())) return false;
        if (date.getFullYear() !== now.getFullYear() || date.getMonth() !== now.getMonth()) return false;
        return /rent/i.test(`${transaction.category || ''} ${transaction.description || ''}`);
      })
      .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0);
  }, [transactions]);

  useEffect(() => {
    if (!enabled || !ownerId) {
      setRemote((current) => ({ ...current, loading: false }));
      return;
    }

    let isActive = true;
    const apiBase = getDevApiBaseUrl();

    const load = async () => {
      let openMaintenance = 0;
      let expiringLeases = 0;
      let rentExpected = 0;
      let newMessages = 0;

      const [maintenanceResult, propertiesResult] = await Promise.allSettled([
        fetch(`${apiBase}/api/maintenance/requests?ownerId=${encodeURIComponent(ownerId)}`).then((response) => response.json()),
        ownerPropertiesClient.listDetailed(ownerId, { withTenants: true }),
      ]);

      if (maintenanceResult.status === 'fulfilled' && Array.isArray(maintenanceResult.value?.requests)) {
        openMaintenance = maintenanceResult.value.requests.filter((request: { status?: string }) => isOpenMaintenanceStatus(request?.status)).length;
      }

      if (propertiesResult.status === 'fulfilled' && Array.isArray(propertiesResult.value)) {
        const horizon = new Date();
        horizon.setDate(horizon.getDate() + 60);
        const today = new Date();

        const ownerProperties = propertiesResult.value as Array<{ id?: string; tenants?: Array<{ leaseEnd?: string; monthlyRent?: number; rent?: number; status?: string }> }>;
        ownerProperties.forEach((property) => {
          (property.tenants || []).forEach((tenant) => {
            const monthlyRent = Number(tenant?.monthlyRent ?? tenant?.rent ?? 0);
            if (Number.isFinite(monthlyRent) && monthlyRent > 0) {
              rentExpected += monthlyRent;
            }
            const leaseEnd = tenant?.leaseEnd ? new Date(tenant.leaseEnd) : null;
            if (leaseEnd && !Number.isNaN(leaseEnd.getTime()) && leaseEnd >= today && leaseEnd <= horizon) {
              expiringLeases += 1;
            }
          });
        });

        const messageCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const messageChecks = ownerProperties
          .filter((property) => property.id)
          .slice(0, 6)
          .map(async (property) => {
            try {
              const response = await fetch(`${apiBase}/api/owner/messages?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(String(property.id))}`);
              const payload = await response.json().catch(() => ({}));
              const messages = Array.isArray(payload?.messages) ? payload.messages : [];
              return messages.filter((message: { createdAt?: string }) => {
                const created = message?.createdAt ? new Date(message.createdAt).getTime() : NaN;
                return Number.isFinite(created) && created >= messageCutoff;
              }).length;
            } catch {
              return 0;
            }
          });
        const messageCounts = await Promise.all(messageChecks);
        newMessages = messageCounts.reduce((sum, count) => sum + count, 0);
      }

      if (!isActive) return;
      setRemote({ loading: false, rentExpected, expiringLeases, openMaintenance, newMessages });
    };

    void load();

    return () => {
      isActive = false;
    };
  }, [enabled, ownerId]);

  return { ...remote, rentCollected };
}

function DashboardActionItemTile({
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'ok' | 'warn' | 'neutral';
  onClick: () => void;
}) {
  const toneColor = tone === 'warn' ? '#f59e0b' : tone === 'ok' ? '#10b981' : '#94a3b8';
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 bg-white px-3 py-3 text-left transition hover:bg-slate-50"
    >
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: toneColor }} />
        {label}
      </span>
      <span className="mt-1.5 block truncate text-xl font-semibold tracking-[-0.02em] text-slate-900">{value}</span>
      <span className="mt-0.5 block truncate text-[11px] text-slate-500">{detail}</span>
    </button>
  );
}

function DashboardActionItemsStrip({
  items,
  onNavigate,
}: {
  items: DashboardActionItemsData;
  onNavigate: (path: string) => void;
}) {
  const rentShort = items.rentExpected > 0 && items.rentCollected < items.rentExpected;
  const attentionItems = [
    rentShort ? {
      id: 'rent',
      label: 'Rent outstanding',
      value: items.loading ? '—' : formatCompactCurrency(Math.max(items.rentExpected - items.rentCollected, 0)),
      detail: `${formatCompactCurrency(items.rentCollected)} of ${formatCompactCurrency(items.rentExpected)} collected`,
      tone: 'warn' as const,
      path: '/property-management?tab=tenants',
    } : null,
    items.expiringLeases > 0 ? {
      id: 'leases',
      label: 'Leases expiring',
      value: items.loading ? '—' : `${items.expiringLeases}`,
      detail: 'Within the next 60 days',
      tone: 'warn' as const,
      path: '/property-management?tab=tenants',
    } : null,
    items.openMaintenance > 0 ? {
      id: 'maintenance',
      label: 'Open maintenance',
      value: items.loading ? '—' : `${items.openMaintenance}`,
      detail: 'Requests awaiting action',
      tone: 'warn' as const,
      path: '/property-management?tab=maintenance',
    } : null,
    items.newMessages > 0 ? {
      id: 'messages',
      label: 'New messages',
      value: items.loading ? '—' : `${items.newMessages}`,
      detail: 'Tenant messages in the last 7 days',
      tone: 'warn' as const,
      path: '/property-management?tab=tenants',
    } : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (items.loading) {
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-slate-200/80">
        {[0, 1].map((index) => (
          <div key={index} className="bg-white px-3 py-4">
            <div className="h-2.5 w-24 animate-pulse rounded bg-slate-200" />
            <div className="mt-3 h-6 w-12 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
    );
  }

  if (attentionItems.length === 0) {
    return (
      <div className="rounded-xl bg-emerald-50/70 px-4 py-5">
        <div className="text-sm font-semibold text-emerald-900">Nothing urgent right now</div>
        <p className="mt-1 text-sm text-emerald-700">Rent, leases, maintenance, and tenant messages are all clear.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-slate-200/80">
      {attentionItems.slice(0, 4).map((item) => (
        <DashboardActionItemTile
          key={item.id}
          label={item.label}
          value={item.value}
          detail={item.detail}
          tone={item.tone}
          onClick={() => onNavigate(item.path)}
        />
      ))}
    </div>
  );
}

function DashboardPortfolioPulse({
  overview,
  reserveSummary,
  propertyCount,
}: {
  overview: PropertyPortfolioOverview | null;
  reserveSummary: { totalIncome: number; totalExpenses: number; netCashFlow: number; margin: number };
  propertyCount: number;
}) {
  const metrics = [
    {
      label: 'Property value',
      value: overview ? formatCompactCurrency(overview.summary.totalValue) : '—',
      detail: overview ? `${formatSignedPercent(overview.summary.netYield, 2)} net yield` : 'Loading portfolio',
      tone: 'text-slate-950',
    },
    {
      label: 'Net cash flow',
      value: formatCompactCurrency(reserveSummary.netCashFlow),
      detail: `${reserveSummary.margin.toFixed(1)}% margin`,
      tone: reserveSummary.netCashFlow >= 0 ? 'text-emerald-700' : 'text-rose-700',
    },
    {
      label: 'Properties',
      value: String(overview?.summary.count ?? propertyCount),
      detail: `${formatCompactCurrency(reserveSummary.totalIncome)} income`,
      tone: 'text-slate-950',
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-slate-200/80">
      {metrics.map((metric) => (
        <div key={metric.label} className="min-w-0 bg-white px-3 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{metric.label}</div>
          <div className={`mt-1.5 truncate text-xl font-semibold tracking-[-0.03em] ${metric.tone}`}>{metric.value}</div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500">{metric.detail}</div>
        </div>
      ))}
    </div>
  );
}

const PORTFOLIO_VALUE_MILESTONES = [
  100_000, 250_000, 500_000, 750_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000,
  4_000_000, 5_000_000, 7_500_000, 10_000_000, 15_000_000, 20_000_000, 30_000_000,
  50_000_000, 75_000_000, 100_000_000,
];

function nextPortfolioMilestone(totalValue: number): number {
  const next = PORTFOLIO_VALUE_MILESTONES.find((milestone) => milestone > totalValue);
  if (next) return next;
  // Beyond the table: step in 50M increments.
  return Math.ceil((totalValue + 1) / 50_000_000) * 50_000_000;
}

function countTrailingGrowthPeriods(points: Array<{ value: number }>): number {
  let streak = 0;
  for (let index = points.length - 1; index > 0; index -= 1) {
    if (points[index].value > points[index - 1].value) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/** Derives an annualized growth rate from quarterly value history, clamped to a sane range. */
function computeAnnualGrowthRate(points: Array<{ value: number }>): number {
  const usable = points.filter((point) => point.value > 0);
  if (usable.length < 2) return 0;
  const first = usable[0].value;
  const last = usable[usable.length - 1].value;
  const periods = usable.length - 1;
  if (first <= 0 || periods <= 0) return 0;
  const perPeriodRate = Math.pow(last / first, 1 / periods) - 1;
  const annualRate = Math.pow(1 + perPeriodRate, 4) - 1;
  if (!Number.isFinite(annualRate)) return 0;
  return Math.max(-0.2, Math.min(annualRate, 0.4));
}

const ASSUMED_ANNUAL_RENT_GROWTH = 0.03;

function DashboardPortfolioProjections({
  totalValue,
  equity,
  annualCashFlow,
  annualGrowthRate,
  milestone,
}: {
  totalValue: number;
  equity: number;
  annualCashFlow: number;
  annualGrowthRate: number;
  milestone: number;
}) {
  if (totalValue <= 0) return null;

  const horizons = [1, 3, 5];
  const currentYear = new Date().getFullYear();

  const yearsToMilestone = annualGrowthRate > 0.001 && milestone > totalValue
    ? Math.log(milestone / totalValue) / Math.log(1 + annualGrowthRate)
    : null;

  const projections = horizons.map((years) => {
    const projectedValue = totalValue * Math.pow(1 + annualGrowthRate, years);
    const valueGrowth = projectedValue - totalValue;
    const projectedEquity = Math.max(0, Math.min(projectedValue, equity + valueGrowth));
    const projectedCashFlow = annualCashFlow * Math.pow(1 + ASSUMED_ANNUAL_RENT_GROWTH, years);
    return { years, projectedValue, projectedEquity, projectedCashFlow };
  });

  const growthLabel = annualGrowthRate >= 0
    ? `~${(annualGrowthRate * 100).toFixed(1)}%/yr`
    : `${(annualGrowthRate * 100).toFixed(1)}%/yr`;

  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Projected path</div>
        <div className="text-[11px] font-medium text-slate-400">
          Based on {growthLabel} value growth · {(ASSUMED_ANNUAL_RENT_GROWTH * 100).toFixed(0)}%/yr rent growth assumption
        </div>
      </div>

      {yearsToMilestone !== null ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">
          At this pace, you could reach{' '}
          <span className="font-semibold text-slate-950">{formatCompactCurrency(milestone)}</span>
          {' '}in about{' '}
          <span className="font-semibold text-slate-950">
            {yearsToMilestone < 1 ? '< 1 year' : `${yearsToMilestone.toFixed(1)} years`}
          </span>
          {' '}(around {currentYear + Math.max(Math.round(yearsToMilestone), 0)}).
        </p>
      ) : (
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Projections will sharpen once more quarters of value history accrue.
        </p>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        {projections.map((projection) => (
          <div key={projection.years} className="rounded-xl border border-slate-100 bg-slate-50/70 px-2.5 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              +{projection.years} yr{projection.years === 1 ? '' : 's'} · {currentYear + projection.years}
            </div>
            <div className="mt-1.5 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Value</span>
                <span className="font-semibold text-slate-900">{formatCompactCurrency(projection.projectedValue)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Equity</span>
                <span className="font-semibold text-blue-700">{formatCompactCurrency(projection.projectedEquity)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Cash flow</span>
                <span className={`font-semibold ${projection.projectedCashFlow >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {formatCompactCurrency(projection.projectedCashFlow)}/yr
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardPortfolioWins({
  overview,
  reserveSummary,
}: {
  overview: PropertyPortfolioOverview | null;
  reserveSummary: { totalIncome: number; totalExpenses: number; netCashFlow: number; margin: number };
}) {
  const summary = overview?.summary;
  const trend = overview?.valueTrendQuarterly?.length ? overview.valueTrendQuarterly : overview?.valueTrendAnnual || [];
  const totalValue = summary?.totalValue || 0;
  const firstTrendValue = trend.length > 0 ? trend[0].value : 0;
  const growthSinceStart = firstTrendValue > 0 ? totalValue - firstTrendValue : 0;
  const growthPercent = firstTrendValue > 0 ? (growthSinceStart / firstTrendValue) * 100 : 0;
  const growthStreak = countTrailingGrowthPeriods(trend);
  const milestone = nextPortfolioMilestone(totalValue);
  const milestoneProgress = milestone > 0 ? Math.max(0.02, Math.min(totalValue / milestone, 1)) : 0;
  const annualIncome = summary?.annualGrossIncome || Math.max(reserveSummary.totalIncome, 0);
  const equity = summary?.totalEquity || 0;
  const equityRatio = summary && summary.totalValue > 0 ? (equity / summary.totalValue) * 100 : 0;
  const annualGrowthRate = useMemo(() => computeAnnualGrowthRate(trend), [trend]);
  const annualCashFlow = summary?.annualNetCashFlow ?? reserveSummary.netCashFlow * 12;

  const ringRadius = 56;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - milestoneProgress);

  const wins = [
    growthSinceStart > 0 ? {
      id: 'growth',
      icon: TrendingUp,
      accent: '#0d9488',
      label: `${formatCompactCurrency(growthSinceStart)} of value growth`,
      detail: `Up ${growthPercent.toFixed(1)}% since your history began`,
    } : null,
    growthStreak >= 2 ? {
      id: 'streak',
      icon: Flame,
      accent: '#f97316',
      label: `${growthStreak}-quarter growth streak`,
      detail: 'Portfolio value has risen each recent quarter',
    } : null,
    equity > 0 ? {
      id: 'equity',
      icon: Landmark,
      accent: '#2563eb',
      label: `${formatCompactCurrency(equity)} equity built`,
      detail: `You own ${equityRatio.toFixed(0)}% of your portfolio's value`,
    } : null,
    annualIncome > 0 ? {
      id: 'income',
      icon: Sparkles,
      accent: '#7c3aed',
      label: `${formatCompactCurrency(annualIncome)} in annual income`,
      detail: summary?.monthlyRent
        ? `${formatCompactCurrency(summary.monthlyRent)}/mo in booked rent`
        : 'Rental income recorded across the account',
    } : null,
  ].filter((win): win is NonNullable<typeof win> => Boolean(win)).slice(0, 4);

  if (!overview) {
    return (
      <Card surface="light" compact eyebrow="Milestones" title="Portfolio wins">
        <p className="py-8 text-center text-sm text-slate-500">Milestones will appear once your portfolio history is loaded.</p>
      </Card>
    );
  }

  return (
    <Card surface="light" compact eyebrow="Milestones" title="Portfolio wins">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative mx-auto h-[150px] w-[150px] shrink-0 sm:mx-0">
          <svg viewBox="0 0 150 150" className="h-full w-full -rotate-90">
            <circle cx="75" cy="75" r={ringRadius} fill="none" stroke="#e2e8f0" strokeWidth="11" />
            <circle
              cx="75"
              cy="75"
              r={ringRadius}
              fill="none"
              stroke="url(#dashboard-wins-ring-gradient)"
              strokeWidth="11"
              strokeLinecap="round"
              strokeDasharray={ringCircumference}
              strokeDashoffset={ringOffset}
              className="transition-[stroke-dashoffset] duration-1000 ease-out"
            />
            <defs>
              <linearGradient id="dashboard-wins-ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#2dd4bf" />
                <stop offset="100%" stopColor="#0d9488" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <Trophy size={15} className="text-teal-600" />
            <div className="mt-0.5 text-lg font-semibold tracking-[-0.03em] text-slate-950">
              {Math.round(milestoneProgress * 100)}%
            </div>
            <div className="px-4 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              to {formatCompactCurrency(milestone)}
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm leading-6 text-slate-600">
            Your portfolio is worth{' '}
            <span className="font-semibold text-slate-950">{formatCompactCurrency(totalValue)}</span>
            {' '}— {formatCompactCurrency(Math.max(milestone - totalValue, 0))} away from the {formatCompactCurrency(milestone)} milestone.
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {wins.length > 0 ? wins.map((win) => {
              const Icon = win.icon;
              return (
                <div key={win.id} className="flex items-start gap-2.5 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
                  <span
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: `${win.accent}16` }}
                  >
                    <Icon size={14} color={win.accent} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-slate-900">{win.label}</span>
                    <span className="block truncate text-[11px] text-slate-500">{win.detail}</span>
                  </span>
                </div>
              );
            }) : (
              <p className="text-sm text-slate-500">Wins will light up here as value, equity, and income history accrue.</p>
            )}
          </div>
        </div>
      </div>

      <DashboardPortfolioProjections
        totalValue={totalValue}
        equity={equity}
        annualCashFlow={annualCashFlow}
        annualGrowthRate={annualGrowthRate}
        milestone={milestone}
      />
    </Card>
  );
}

function getFiniteDashboardCoordinate(...candidates: Array<string | number | null | undefined>) {
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildDashboardConstellationProperties(
  properties: DashboardProperty[],
  alerts: ShellyAlert[],
  devices: Array<{ deviceId: string; propertyId?: string | null; status?: string | null }> = [],
): ConstellationProperty[] {
  const openAlertsByProperty = new Map<string, ShellyAlert[]>();
  alerts
    .filter((alert) => !alert.acknowledged)
    .forEach((alert) => {
      const key = String(alert.propertyId || '');
      if (!key) return;
      const existing = openAlertsByProperty.get(key) || [];
      existing.push(alert);
      openAlertsByProperty.set(key, existing);
    });

  return properties
    .map((property) => {
      const summary = (property.data?.summary || {}) as Record<string, any>;
      const location = (property.data?.location || {}) as Record<string, any>;
      const parcelCentroid = ((property.data as any)?.parcel_map?.parcel?.centroid
        || (property.data as any)?.parcel_map?.subject?.centroid
        || {}) as Record<string, any>;

      const latitude = getFiniteDashboardCoordinate(
        summary.latitude,
        summary.lat,
        location.latitude,
        location.lat,
        parcelCentroid.lat,
      );
      const longitude = getFiniteDashboardCoordinate(
        summary.longitude,
        summary.lng,
        location.longitude,
        location.lng,
        parcelCentroid.lng,
      );

      const propertyAlerts = [
        ...(openAlertsByProperty.get(property.id) || []),
        ...(openAlertsByProperty.get(property.address) || []),
      ];
      const criticalAlerts = propertyAlerts.filter((alert) => alert.severity === 'critical');
      const warningAlerts = propertyAlerts.filter((alert) => alert.severity === 'warning');

      let health: ConstellationHealth = 'healthy';
      let healthDetail = 'Operating normally';
      if (criticalAlerts.length > 0) {
        health = 'critical';
        healthDetail = criticalAlerts[0].message || `${criticalAlerts.length} critical sensor alert${criticalAlerts.length === 1 ? '' : 's'}`;
      } else if (warningAlerts.length > 0) {
        health = 'attention';
        healthDetail = warningAlerts[0].message || `${warningAlerts.length} sensor warning${warningAlerts.length === 1 ? '' : 's'}`;
      } else if ((property.tenantCount || 0) === 0) {
        health = 'attention';
        healthDetail = 'No active tenant on file';
      }

      const marketValue = getFiniteDashboardCoordinate(
        summary.avm_value,
        summary.market_value,
        summary.value,
      );
      const monthlyRent = getFiniteDashboardCoordinate(
        property.financialData?.monthlyRent,
        summary.rental_avm,
        summary.market_rent,
      );

      const loanBalance = getFiniteDashboardCoordinate(property.financialData?.currentLoanBalance);
      const equity = marketValue !== null && loanBalance !== null
        ? Math.max(marketValue - loanBalance, 0)
        : marketValue;

      const propertyKeys = new Set([property.id, property.address].filter(Boolean));
      const propertyDevices = devices.filter((device) => device.propertyId && propertyKeys.has(device.propertyId));
      const devicesOnline = propertyDevices.filter((device) => device.status === 'online').length;

      return {
        id: property.id,
        address: property.address || summary.address || 'Saved property',
        latitude,
        longitude,
        marketValue,
        monthlyRent,
        health,
        healthDetail,
        beds: getFiniteDashboardCoordinate(summary.beds, summary.bedrooms),
        baths: getFiniteDashboardCoordinate(summary.baths, summary.bathrooms),
        sqft: getFiniteDashboardCoordinate(summary.living_sqft, summary.sqft),
        yearBuilt: getFiniteDashboardCoordinate(summary.year_built),
        equity,
        tenantCount: property.tenantCount ?? null,
        devicesOnline,
        devicesTotal: propertyDevices.length,
        openAlerts: propertyAlerts.slice(0, 3).map((alert) => ({
          severity: alert.severity === 'critical' ? 'critical' as const : 'warning' as const,
          message: alert.message || 'Sensor alert',
        })),
      } satisfies ConstellationProperty;
    })
    .filter((property): property is ConstellationProperty => Boolean(property));
}

function DashboardLandingOverview({
  propertyPortfolioOverview,
  reserveSummary,
  properties,
  constellationProperties,
  quickActions,
  actionItems,
  onNavigate,
  onLaunchAction,
  onRequestBriefing,
}: {
  propertyPortfolioOverview: PropertyPortfolioOverview | null;
  reserveSummary: { totalIncome: number; totalExpenses: number; netCashFlow: number; margin: number };
  properties: DashboardProperty[];
  constellationProperties: ConstellationProperty[];
  quickActions: ControlAction[];
  actionItems: DashboardActionItemsData;
  onNavigate: (path: string) => void;
  onLaunchAction: (action: ControlAction) => void | Promise<unknown>;
  onRequestBriefing: () => void | Promise<unknown>;
}) {
  const [valueTrendGranularity, setValueTrendGranularity] = useState<PropertyPortfolioHistoryGranularity>('quarterly');

  const openProperty = (propertyId: string) => {
    const match = properties.find((property) => property.id === propertyId);
    if (match?.address) {
      onNavigate(`/portfolio?tab=properties&address=${encodeURIComponent(match.address)}`);
    } else {
      onNavigate('/portfolio?tab=properties');
    }
  };

  return (
    <div className="space-y-4">
      <DashboardQuickActions actions={quickActions} onLaunch={onLaunchAction} />

      {/* Full-width square overview strip — same card language as Management / Sensors */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          surface="light"
          compact
          eyebrow="Needs attention"
          title="Account activity"
          action={
            <button
              type="button"
              onClick={() => void onRequestBriefing()}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-white hover:text-slate-950"
            >
              Brief me
            </button>
          }
        >
          <DashboardActionItemsStrip items={actionItems} onNavigate={onNavigate} />
        </Card>
        <Card surface="light" compact eyebrow="Portfolio" title="Account snapshot">
          <DashboardPortfolioPulse
            overview={propertyPortfolioOverview}
            reserveSummary={reserveSummary}
            propertyCount={properties.length}
          />
        </Card>
      </div>

      {/* Map twin (left) + Weekly recap (right) */}
      <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="min-h-[420px] min-w-0">
          <PortfolioConstellationMap
            properties={constellationProperties}
            onOpenProperty={openProperty}
          />
        </div>
        <div className="min-w-0">
          <Card surface="light" flushBody className="h-full min-h-[420px]">
            <div className="flex h-full min-h-[420px] flex-col p-4 sm:p-5">
              <YourWeekRecapCard theme="light" variant="dashboard" />
            </div>
          </Card>
        </div>
      </div>

      {/* Trend + milestones */}
      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        {propertyPortfolioOverview ? (
          <PortfolioValueHistoryCard
            overview={propertyPortfolioOverview}
            granularity={valueTrendGranularity}
            onGranularityChange={setValueTrendGranularity}
            compact
            showSummary={false}
          />
        ) : (
          <Card surface="light" eyebrow="Portfolio trend" title="Total property value">
            <p className="py-10 text-center text-sm text-slate-500">Property value history will appear once your holdings are loaded.</p>
          </Card>
        )}
        <DashboardPortfolioWins
          overview={propertyPortfolioOverview}
          reserveSummary={reserveSummary}
        />
      </div>
    </div>
  );
}

function SnapshotCard({
  surface,
  layout,
  annotations,
  highlighted,
  standalone = false,
  floating = false,
  style,
  onRemove,
  onSelect,
  surfaceRef,
  children,
}: {
  surface: DashboardSurfaceDefinition;
  layout: DashboardSurfaceLayoutState;
  annotations: DashboardAnnotation[];
  highlighted: boolean;
  standalone?: boolean;
  floating?: boolean;
  style?: React.CSSProperties;
  onRemove: () => void;
  onSelect: () => void;
  surfaceRef: (node: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  const inlineAnnotations = annotations.filter((annotation) => shouldRenderInlineSurfaceAnnotation(annotation));
  const overlayAnnotations = annotations.filter((annotation) => !shouldRenderInlineSurfaceAnnotation(annotation));
  const hasInlineAnnotations = inlineAnnotations.length > 0;
  const surfaceVoiceAttrs = buildVoiceUiAttrs({
    id: `dashboard-surface-${surface.id}`,
    label: surface.title,
    type: 'card',
    description: `${surface.source} surface on the fluid dashboard canvas.`,
    pageSection: 'dashboard-fluid-canvas',
    keywords: surface.keywords,
    interactive: true,
  });
  const removeButtonVoiceAttrs = buildVoiceUiAttrs({
    id: `dashboard-remove-${surface.id}-btn`,
    label: `Remove ${surface.title}`,
    type: 'button',
    description: `Remove the ${surface.title} surface from the dashboard canvas.`,
    pageSection: surface.id,
    interactive: true,
  });
  const sectionClassName = standalone
    ? `dashboard-surface dashboard-card-shell dashboard-standalone-shell ${floating ? 'absolute h-full' : 'relative'} flex min-h-0 flex-col overflow-visible rounded-[32px] transition-[left,top,width,height,box-shadow,transform] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]`
    : `dashboard-surface dashboard-card-shell ${floating ? 'absolute h-full' : 'relative'} flex min-h-0 flex-col overflow-visible rounded-[32px] border border-white/40 shadow-inner ring-2 ring-white/30 transition-[left,top,width,height,box-shadow,transform] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${highlighted || layout.emphasis ? 'shadow-[0_26px_52px_rgba(15,23,42,0.1)] ring-1 ring-sky-200/70' : 'hover:shadow-[0_24px_46px_rgba(15,23,42,0.08)]'}`;
  const effectiveSurfaceHeight = getEffectiveSurfaceHeight(surface.id, layout.h);

  return (
    <section
      ref={surfaceRef}
      onClick={onSelect}
      {...surfaceVoiceAttrs}
      style={floating
        ? style
        : {
          minHeight: `${Math.max(DASHBOARD_SCENE_CARD_MIN_HEIGHT, Math.min(effectiveSurfaceHeight, DASHBOARD_SCENE_CARD_MAX_HEIGHT))}px`,
          ...style,
        }}
      className={sectionClassName}
    >
      <div aria-hidden className="dashboard-shell-border-bevel pointer-events-none absolute inset-0 rounded-[32px]" />
      <div aria-hidden className="dashboard-shell-inner-bevel pointer-events-none absolute inset-[1px] rounded-[32px]" />
      <div aria-hidden className="dashboard-shell-top-edge pointer-events-none absolute left-4 right-4 top-0 h-[1px]" />
      <div aria-hidden className="dashboard-shell-side-edge dashboard-shell-side-edge-left pointer-events-none absolute bottom-4 left-0 top-4 w-[1px]" />
      <div aria-hidden className="dashboard-shell-side-edge dashboard-shell-side-edge-right pointer-events-none absolute bottom-4 right-0 top-4 w-[1px]" />
      {standalone ? null : (
        <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex items-start justify-between gap-3">
          <div className="max-w-[72%] rounded-[18px] bg-white/72 px-4 py-3 shadow-[0_10px_24px_rgba(15,23,42,0.06)] backdrop-blur-xl">
            <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">{surface.source}</div>
            <h2 className="mt-1 text-[1rem] font-semibold tracking-[-0.025em] text-slate-900">{surface.title}</h2>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            {...removeButtonVoiceAttrs}
            className="pointer-events-auto rounded-full bg-white/80 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 shadow-[0_10px_24px_rgba(15,23,42,0.06)] backdrop-blur-xl transition hover:bg-white hover:text-slate-900"
          >
            Remove
          </button>
        </div>
      )}
      <div className={`relative min-h-0 flex-1 ${standalone ? 'overflow-visible p-0' : 'overflow-visible px-3 pb-4 pt-[4.75rem]'}`}>
        {standalone ? (
          <div className="dashboard-card-stage dashboard-card-stage-standalone">
            {children}
          </div>
        ) : children}
        {hasInlineAnnotations ? (
          <div className={`dashboard-insight-tray ${standalone ? 'dashboard-insight-tray-standalone' : ''}`}>
            {inlineAnnotations.map((annotation) => (
              <DashboardInlineAnnotationCard key={annotation.id} annotation={annotation} />
            ))}
          </div>
        ) : null}
        {overlayAnnotations.length > 0 ? (
          <div className="pointer-events-none absolute inset-0 z-20">
            {overlayAnnotations.map((annotation) => (
              <DashboardAnnotationBubble key={annotation.id} annotation={annotation} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function NetWorthGraphWidget({
  series,
  currentValue,
  ytdChange,
  periodChange,
  loading,
  error,
}: {
  series: NetWorthChartSeriesPoint[];
  currentValue: number;
  ytdChange: number;
  periodChange: number;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex h-[250px] items-center justify-center rounded-[20px] border border-slate-200 bg-slate-50/80">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          Loading portfolio graph...
        </div>
      </div>
    );
  }

  if (error) {
    return <EmptySnapshot title="Unable to load net worth" description={error} />;
  }

  if (series.length < 2) {
    return <EmptySnapshot title="No net worth history yet" description="The dashboard will render the actual net worth graph once portfolio snapshots are available." />;
  }

  const width = 560;
  const height = 220;
  const leftPadding = 52;
  const rightPadding = 8;
  const topPadding = 12;
  const bottomPadding = 32;
  const innerWidth = width - leftPadding - rightPadding;
  const innerHeight = height - topPadding - bottomPadding;

  const values = series.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || Math.max(Math.abs(maxValue) * 0.1, 1000);
  const yMin = minValue - range * 0.12;
  const yMax = maxValue + range * 0.12;
  const points = series.map((point, index) => {
    const x = leftPadding + (index / (series.length - 1)) * innerWidth;
    const y = topPadding + innerHeight - ((point.value - yMin) / (yMax - yMin)) * innerHeight;
    return { x, y, ...point };
  });
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const tickValues = Array.from({ length: 4 }, (_, index) => yMin + ((yMax - yMin) * index) / 3);
  const visibleLabelIndices = getVisibleAxisIndices(points.length, Math.min(points.length, 6));
  const lastPoint = points[points.length - 1];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-sm text-slate-500">YTD Change</div>
            <div className={`mt-1 text-2xl font-semibold tracking-[-0.04em] ${ytdChange >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {formatSignedPercent(ytdChange)}
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-500">Current Value</div>
            <div className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-slate-900">{formatPreciseCurrency(currentValue)}</div>
          </div>
        </div>
        <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          1 month
        </div>
      </div>

      <div className="flex-1 rounded-[22px] border border-slate-200 bg-slate-50/60 px-2 py-2">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[190px] w-full">
          {tickValues.map((tickValue, index) => {
            const y = topPadding + innerHeight - ((tickValue - yMin) / (yMax - yMin)) * innerHeight;
            return (
              <g key={tickValue}>
                <line x1={leftPadding} y1={y} x2={width - rightPadding} y2={y} stroke="#dbe4ee" strokeWidth="1" strokeDasharray="4 6" />
                <text x={leftPadding - 10} y={y + 4} textAnchor="end" fontSize="11" fontWeight="600" fill="#526277">
                  {formatCompactCurrency(tickValue)}
                </text>
                {index === tickValues.length - 1 && (
                  <line x1={leftPadding} y1={y} x2={width - rightPadding} y2={y} stroke="#c8d4e3" strokeWidth="1.25" />
                )}
              </g>
            );
          })}

          <path d={linePath} fill="none" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={lastPoint.x} cy={lastPoint.y} r="5" fill="white" stroke="#2563eb" strokeWidth="3" />

          {points.map((point, index) => {
            if (!visibleLabelIndices.includes(index)) return null;
            return (
              <text key={point.fullLabel} x={point.x} y={height - 10} textAnchor="middle" fontSize="11" fontWeight="600" fill="#1e293b">
                {point.label}
              </text>
            );
          })}
        </svg>
      </div>

      <div className="mt-3 flex justify-center">
        <div className={`rounded-full px-4 py-2 text-sm font-semibold ${periodChange >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
          1M {formatSignedPercent(periodChange)}
        </div>
      </div>
    </div>
  );
}

function PropertyOverviewWidget({ properties }: { properties: DashboardProperty[] }) {
  if (properties.length === 0) {
    return <EmptySnapshot title="No portfolio properties found" description="Add properties to your account portfolio to populate this overview card." />;
  }

  const propertySummaries = properties.map((property) => {
    const summary = property.data?.summary;
    const financials = property.financialData;
    const value = summary?.avm_value
      ?? summary?.last_sale_price
      ?? ((financials?.originalLoanAmount ?? financials?.currentLoanBalance ?? 0) + (financials?.downPayment ?? 0));
    const monthlyRent = summary?.rental_avm ?? financials?.monthlyRent ?? 0;
    const debtBalance = summary?.mortgage?.amount ?? financials?.currentLoanBalance ?? financials?.originalLoanAmount ?? 0;

    return {
      id: property.id,
      address: summary?.address || property.address,
      value,
      monthlyRent,
      debtBalance,
      beds: summary?.beds,
      baths: summary?.baths,
      sourceLabel: property.data ? 'ATTOM detail' : property.financialData ? 'Portfolio financials' : 'Portfolio record',
    };
  });

  const totalValue = propertySummaries.reduce((sum, property) => sum + property.value, 0);
  const totalMonthlyRent = propertySummaries.reduce((sum, property) => sum + property.monthlyRent, 0);
  const visibleProperties = propertySummaries.slice(0, 4);
  const remainingCount = Math.max(propertySummaries.length - visibleProperties.length, 0);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="Properties" value={String(propertySummaries.length)} />
        <MetricTile label="Visible value" value={formatCurrency(totalValue)} />
        <MetricTile label="Monthly rent" value={formatCurrency(totalMonthlyRent)} tone="positive" />
      </div>

      <div className="grid flex-1 gap-3 sm:grid-cols-2">
        {visibleProperties.map((property) => (
          <div key={property.id} className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">{property.address}</div>
                <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{property.sourceLabel}</div>
              </div>
              <div className="text-right text-xs text-slate-500">
                <div>Value</div>
                <div className="mt-1 font-semibold text-slate-900">{formatCurrency(property.value)}</div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Rent</div>
                <div className="mt-1 text-sm font-semibold text-emerald-700">
                  {property.monthlyRent > 0 ? `${formatCurrency(property.monthlyRent)}/mo` : '--'}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Debt</div>
                <div className="mt-1 text-sm font-semibold text-slate-900">
                  {property.debtBalance > 0 ? formatCurrency(property.debtBalance) : '--'}
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
              <span>
                {property.beds != null || property.baths != null
                  ? `${property.beds ?? '--'} bd · ${property.baths ?? '--'} ba`
                  : 'Specs unavailable'}
              </span>
                <span>{property.value > 0 && property.debtBalance > 0 ? `${((property.debtBalance / property.value) * 100).toFixed(1)}%` : '--'} LTV</span>
            </div>

            </div>
          ))}
        </div>

      {remainingCount > 0 && (
        <div className="rounded-[18px] border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600">
          + {remainingCount} more {remainingCount === 1 ? 'property' : 'properties'} across your account portfolio.
        </div>
      )}
    </div>
  );
}

function ReserveSummaryWidget({
  reserveSummary,
  reserveCategories,
  accountBalance,
}: {
  reserveSummary: { totalIncome: number; totalExpenses: number; netCashFlow: number; margin: number };
  reserveCategories: Array<{ name: string; amount: number }>;
  accountBalance: number | null | undefined;
}) {
  return (
    <div className="flex h-full flex-col justify-between gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricTile label="Cash balance" value={formatCurrency(accountBalance ?? reserveSummary.netCashFlow)} />
        <MetricTile
          label="Net cash flow"
          value={formatCurrency(reserveSummary.netCashFlow)}
          tone={reserveSummary.netCashFlow >= 0 ? 'positive' : 'negative'}
        />
        <MetricTile label="Income" value={formatCurrency(reserveSummary.totalIncome)} />
        <MetricTile label="Margin" value={formatSignedPercent(reserveSummary.margin, 1)} tone={reserveSummary.margin >= 0 ? 'positive' : 'negative'} />
      </div>

      <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Top expense categories</div>
        <div className="mt-3 space-y-2">
          {reserveCategories.slice(0, 3).map((category) => (
            <div key={category.name} className="flex items-center justify-between text-sm text-slate-700">
              <span>{category.name}</span>
              <span className="font-semibold text-slate-900">{formatCurrency(category.amount)}</span>
            </div>
          ))}
          {reserveCategories.length === 0 && <div className="text-sm text-slate-500">No categorized expense activity yet.</div>}
        </div>
      </div>
    </div>
  );
}

function MaintenanceSummaryWidget({
  devices,
  alerts,
  readings,
}: {
  devices: ShellyDevice[];
  alerts: ShellyAlert[];
  readings: SensorReading[];
}) {
  if (devices.length === 0 && alerts.length === 0) {
    return <EmptySnapshot title="No maintenance telemetry yet" description="Connect Shelly devices to render live predictive-maintenance context in the dashboard." />;
  }

  const onlineDevices = devices.filter((device) => device.status === 'online').length;
  const offlineDevices = devices.filter((device) => device.status !== 'online').length;
  const criticalAlerts = alerts.filter((alert) => alert.severity === 'critical' && !alert.acknowledged).length;
  const warningAlerts = alerts.filter((alert) => alert.severity === 'warning' && !alert.acknowledged).length;
  const averageTemperature = average(readings.filter((reading) => typeof reading.temperature === 'number').slice(-12).map((reading) => reading.temperature as number));
  const averageHumidity = average(readings.filter((reading) => typeof reading.humidity === 'number').slice(-12).map((reading) => reading.humidity as number));

  return (
    <div className="flex h-full flex-col justify-between gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricTile label="Online" value={String(onlineDevices)} tone="positive" />
        <MetricTile label="Offline" value={String(offlineDevices)} tone={offlineDevices > 0 ? 'negative' : 'default'} />
        <MetricTile label="Critical alerts" value={String(criticalAlerts)} tone={criticalAlerts > 0 ? 'negative' : 'default'} />
        <MetricTile label="Warnings" value={String(warningAlerts)} tone={warningAlerts > 0 ? 'negative' : 'default'} />
      </div>

      <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3">
        <div className="flex items-center justify-between gap-3 text-sm text-slate-700">
          <span>Average temp</span>
          <span className="font-semibold text-slate-900">{averageTemperature !== null ? `${averageTemperature.toFixed(1)}C` : '--'}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-sm text-slate-700">
          <span>Average humidity</span>
          <span className="font-semibold text-slate-900">{averageHumidity !== null ? `${averageHumidity.toFixed(0)}%` : '--'}</span>
        </div>
        <div className="mt-4 border-t border-slate-200 pt-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Latest alerts</div>
          <div className="mt-3 space-y-2">
            {alerts.slice(0, 2).map((alert) => (
              <div key={alert.id} className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                <div className="font-medium text-slate-900">{alert.deviceName}</div>
                <div className="mt-1 text-xs text-slate-500">{alert.message}</div>
              </div>
            ))}
            {alerts.length === 0 && <div className="text-sm text-slate-500">No active alerts in the current scope.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function BookkeepingTrendWidget({
  series,
}: {
  series: BookkeepingTrendPoint[];
}) {
  const hasActivity = series.some((point) => point.income > 0 || point.expense > 0);

  if (!hasActivity) {
    return <EmptySnapshot title="No bookkeeping trend yet" description="Categorized transactions will render a monthly income, expense, and net trend snapshot here." />;
  }

  const latest = series[series.length - 1];
  const averageNet = series.reduce((sum, point) => sum + point.net, 0) / series.length;
  const strongestMonth = series.reduce((best, point) => (point.net > best.net ? point : best), series[0]);
  const width = 420;
  const height = 210;
  const leftPadding = 24;
  const rightPadding = 12;
  const topPadding = 18;
  const bottomPadding = 32;
  const innerWidth = width - leftPadding - rightPadding;
  const innerHeight = height - topPadding - bottomPadding;
  const maxAbs = Math.max(...series.map((point) => Math.abs(point.net)), 1);
  const zeroY = topPadding + innerHeight / 2;
  const barGap = 10;
  const barWidth = (innerWidth - barGap * (series.length - 1)) / series.length;

  return (
    <div className="flex h-full flex-col justify-between gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="Latest net" value={formatCurrency(latest.net)} tone={latest.net >= 0 ? 'positive' : 'negative'} />
        <MetricTile label="Avg monthly" value={formatCurrency(averageNet)} tone={averageNet >= 0 ? 'positive' : 'negative'} />
        <MetricTile label="Best month" value={strongestMonth.label} />
      </div>

      <div className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-2 py-2">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[190px] w-full">
          <line x1={leftPadding} y1={zeroY} x2={width - rightPadding} y2={zeroY} stroke="#cbd5e1" strokeWidth="1.5" />
          {series.map((point, index) => {
            const x = leftPadding + index * (barWidth + barGap);
            const barHeight = (Math.abs(point.net) / maxAbs) * (innerHeight / 2 - 8);
            const y = point.net >= 0 ? zeroY - barHeight : zeroY;
            return (
              <g key={point.fullLabel}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(barHeight, 2)}
                  rx="6"
                  fill={point.net >= 0 ? '#2563eb' : '#f97316'}
                  opacity={0.95}
                />
                <text x={x + barWidth / 2} y={height - 10} textAnchor="middle" fontSize="11" fontWeight="600" fill="#1e293b">
                  {point.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Income {formatCurrency(latest.income)}</span>
        <span>Expenses {formatCurrency(latest.expense)}</span>
      </div>
    </div>
  );
}

function WorkflowShortcutsWidget({
  actions,
  onLaunch,
}: {
  actions: ControlAction[];
  onLaunch: (action: ControlAction) => void | Promise<unknown>;
}) {
  if (actions.length === 0) {
    return <EmptySnapshot title="No workflow shortcuts wired" description="Add website control actions to render cross-app shortcuts inside the dashboard." />;
  }

  return (
    <div className="flex h-full flex-col justify-between gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {actions.map((action) => (
          <DashboardActionButton
            key={action.id}
            action={action}
            onLaunch={onLaunch}
            pageSection="workflow-shortcuts"
          />
        ))}
      </div>

      <div className="rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        These controls are sourced from the live website control registry, so the dashboard agent can render shortcuts from portfolio, bookkeeping, market data, and renovations in one place.
      </div>
    </div>
  );
}

function DashboardActionButton({
  action,
  onLaunch,
  pageSection,
}: {
  action: ControlAction;
  onLaunch: (action: ControlAction) => void | Promise<unknown>;
  pageSection: string;
}) {
  const destination = getActionDestination(action);
  const voiceAttrs = buildVoiceUiAttrs({
    id: `dashboard-action-${action.id}-btn`,
    label: action.name,
    type: 'button',
    description: `${action.description} from the fluid dashboard.`,
    pageSection,
    keywords: [action.id, ...action.keywords.slice(0, 4)],
    interactive: true,
  });

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void onLaunch(action);
      }}
      {...voiceAttrs}
      className="rounded-[20px] border border-slate-200 bg-slate-50/80 px-4 py-3 text-left transition hover:border-slate-300 hover:bg-white"
    >
      <div className="text-sm font-semibold text-slate-900">{action.name}</div>
      <div className="mt-1 text-xs leading-5 text-slate-500">{action.description}</div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        <span>{destination ? formatRouteLabel(destination) : 'in place'}</span>
        <span>{action.voiceId || action.category}</span>
      </div>
    </button>
  );
}

function PortfolioAllocationWidget({
  slices,
  classDetails,
  totalValue,
  totalLiabilities,
  viewMode,
  loading,
  error,
  highlightedKeys,
}: {
  slices: PortfolioAllocationSlice[];
  classDetails: Record<string, AllocationClassDetail>;
  totalValue: number;
  totalLiabilities: number;
  viewMode: 'assets' | 'equity';
  loading: boolean;
  error: string | null;
  highlightedKeys?: string[];
}) {
  if (loading) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-[20px] border border-slate-200 bg-slate-50/80">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          Loading allocation mix...
        </div>
      </div>
    );
  }

  if (error && slices.length === 0) {
    return <EmptySnapshot title="Unable to load allocation" description={error} />;
  }

  if (slices.length === 0) {
    return <EmptySnapshot title="No allocation data yet" description="Add assets to render the actual portfolio allocation mix from the net worth page." />;
  }

  const highlightedLabels = slices
    .filter((slice) => (highlightedKeys ?? []).includes(slice.key))
    .map((slice) => slice.label);

  return (
    <NetWorthAllocationPanel
      allocations={slices.map((slice) => ({
        label: slice.label,
        value: slice.value,
        percentage: slice.percent,
        color: slice.color,
      }))}
      totalValue={totalValue}
      totalLiabilities={totalLiabilities}
      viewMode={viewMode}
      hasRealEstateHoldings={slices.some((slice) => slice.key === 'realEstate' && slice.value > 0)}
      classDetails={classDetails}
      formatCurrency={(value) => formatCurrency(typeof value === 'number' ? value : Number(value))}
      highlightedLabels={highlightedLabels}
    />
  );
}

function PortfolioAllocationFlowChart({ slices }: { slices: PortfolioAllocationSlice[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientIdBase = useId().replace(/[^a-zA-Z0-9_-]/g, '-');
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [hoveredLink, setHoveredLink] = useState<any>(null);

  const rootValue = useMemo(
    () => slices.filter((slice) => slice.value > 0).reduce((sum, slice) => sum + slice.value, 0),
    [slices],
  );

  useEffect(() => {
    const width = 1320;
    const height = 520;
    const margin = { top: 60, right: 240, bottom: 40, left: 160 };

    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .style('background', 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)')
      .style('border-radius', '16px');

    const activeAllocations = slices.filter((slice) => slice.value > 0);

    if (activeAllocations.length === 0 || rootValue === 0) {
      svg.append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#9ca3af')
        .attr('font-size', '16px')
        .text('No assets to display');
      return;
    }

    const nodes: any[] = [];
    const links: any[] = [];
    let nodeId = 0;

    nodes.push({ id: nodeId++, name: 'Total Assets', value: rootValue, x: 0, order: 0, color: '#3b82f6' });

    let classOrder = 0;
    activeAllocations.forEach((assetClass) => {
      const classNodeId = nodeId++;
      nodes.push({
        id: classNodeId,
        name: assetClass.label,
        value: assetClass.value,
        x: 1,
        order: classOrder++,
        color: assetClass.color,
      });

      links.push({ source: 0, target: classNodeId, value: assetClass.value });

      const topAssets = assetClass.assetList.filter((asset) => asset.value > 0).slice(0, 5);
      const topSum = topAssets.reduce((sum, asset) => sum + asset.value, 0);
      const remainder = assetClass.value - topSum;

      topAssets.forEach((asset) => {
        const assetNodeId = nodeId++;
        nodes.push({
          id: assetNodeId,
          name: asset.name,
          value: asset.value,
          x: 2,
          order: nodes.filter((node) => node.x === 2).length,
          color: assetClass.color,
        });

        links.push({ source: classNodeId, target: assetNodeId, value: asset.value });
      });

      if (remainder > 1) {
        const otherCount = Math.max(assetClass.assetList.length - topAssets.length, 0);
        const assetNodeId = nodeId++;
        nodes.push({
          id: assetNodeId,
          name: otherCount > 0 ? `Other (${otherCount} more)` : 'Other',
          value: remainder,
          x: 2,
          order: nodes.filter((node) => node.x === 2).length,
          color: assetClass.color,
        });

        links.push({ source: classNodeId, target: assetNodeId, value: remainder });
      }
    });

    const nodeWidth = 28;
    const nodePadding = 16;
    const columnWidth = (width - margin.left - margin.right - nodeWidth * 3) / 2;
    const maxValuePerColumn = d3.max(d3.rollup(nodes, (value: any) => d3.sum(value, (entry: any) => entry.value), (entry: any) => entry.x).values());
    const availableHeight = height - margin.top - margin.bottom;
    const scale = availableHeight / ((maxValuePerColumn || 1) * 1.2);

    nodes.forEach((node: any) => {
      node.x0 = margin.left + node.x * columnWidth + node.x * nodeWidth;
      node.x1 = node.x0 + nodeWidth;
      node.height = Math.max(node.value * scale, 8);
    });

    const columns = d3.group(nodes, (node: any) => node.x);
    columns.forEach((columnNodes: any) => {
      columnNodes.sort((left: any, right: any) => left.order - right.order);
      const totalHeight = d3.sum(columnNodes, (node: any) => node.height);
      const padding = (columnNodes.length - 1) * nodePadding;
      const startY = margin.top + (availableHeight - totalHeight - padding) / 2;

      let currentY = startY;
      columnNodes.forEach((node: any) => {
        node.y0 = currentY;
        node.y1 = currentY + node.height;
        currentY = node.y1 + nodePadding;
      });
    });

    nodes.forEach((node: any) => {
      node.sourceY = node.y0;
      node.targetY = node.y0;
    });

    const linkData = links.map((link) => {
      const source = nodes.find((node) => node.id === link.source)!;
      const target = nodes.find((node) => node.id === link.target)!;
      const linkHeight = Math.max(link.value * scale, 4);
      const sourceY = source.sourceY;
      const targetY = target.targetY;

      source.sourceY += linkHeight;
      target.targetY += linkHeight;

      return {
        ...link,
        source,
        target,
        width: linkHeight,
        sy0: sourceY,
        sy1: sourceY + linkHeight,
        ty0: targetY,
        ty1: targetY + linkHeight,
      };
    });

    const defs = svg.append('defs');

    linkData.forEach((link, index) => {
      const gradient = defs.append('linearGradient')
        .attr('id', `${gradientIdBase}-asset-gradient-${index}`)
        .attr('gradientUnits', 'userSpaceOnUse')
        .attr('x1', link.source.x1)
        .attr('x2', link.target.x0);

      gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', link.source.color)
        .attr('stop-opacity', 0.5);

      gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', link.target.color)
        .attr('stop-opacity', 0.5);
    });

    const generateLinkPath = (datum: any) => {
      const sourceX = datum.source.x1;
      const targetX = datum.target.x0;
      const curvature = 0.5;
      const xi = d3.interpolateNumber(sourceX, targetX);
      const x2 = xi(curvature);
      const x3 = xi(1 - curvature);

      return `
        M ${sourceX},${datum.sy0}
        C ${x2},${datum.sy0} ${x3},${datum.ty0} ${targetX},${datum.ty0}
        L ${targetX},${datum.ty1}
        C ${x3},${datum.ty1} ${x2},${datum.sy1} ${sourceX},${datum.sy1}
        Z
      `;
    };

    const link = svg.append('g')
      .selectAll('path')
      .data(linkData)
      .join('path')
      .attr('d', generateLinkPath)
      .attr('fill', (_datum: any, index: number) => `url(#${gradientIdBase}-asset-gradient-${index})`)
      .attr('stroke', 'none')
      .attr('opacity', 0)
      .on('mouseover', function(_event: any, datum: any) {
        setHoveredLink(datum);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 0.8);
      })
      .on('mouseout', function() {
        setHoveredLink(null);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 0.5);
      });

    link.transition()
      .duration(1000)
      .delay((_datum: any, index: number) => index * 30)
      .attr('opacity', 0.5);

    const nodeGroup = svg.append('g');

    nodeGroup.selectAll('rect')
      .data(nodes)
      .join('rect')
      .attr('x', (node: any) => node.x0)
      .attr('y', (node: any) => node.y0)
      .attr('height', (node: any) => node.y1 - node.y0)
      .attr('width', (node: any) => node.x1 - node.x0)
      .attr('fill', (node: any) => node.color)
      .attr('opacity', 0)
      .attr('rx', 3)
      .style('cursor', 'pointer')
      .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))')
      .on('mouseover', function(_event: any, datum: any) {
        setHoveredNode(datum);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 1)
          .style('filter', 'drop-shadow(0 4px 12px rgba(0,0,0,0.2))');
      })
      .on('mouseout', function() {
        setHoveredNode(null);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 0.95)
          .style('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))');
      })
      .transition()
      .duration(800)
      .delay((_datum: any, index: number) => index * 50)
      .attr('opacity', 0.95);

    svg.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .attr('x', (node: any) => node.x === 0 ? node.x0 - 12 : node.x1 + 12)
      .attr('y', (node: any) => (node.y1 + node.y0) / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', (node: any) => node.x === 0 ? 'end' : 'start')
      .attr('fill', '#1e293b')
      .attr('font-size', '14px')
      .attr('font-weight', '600')
      .attr('opacity', 0)
      .text((node: any) => node.name.length > 24 ? `${node.name.substring(0, 24)}...` : node.name)
      .transition()
      .duration(800)
      .delay((_datum: any, index: number) => index * 50 + 400)
      .attr('opacity', 1);

    svg.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .attr('x', (node: any) => node.x === 0 ? node.x0 - 12 : node.x1 + 12)
      .attr('y', (node: any) => (node.y1 + node.y0) / 2 + 18)
      .attr('dy', '0.35em')
      .attr('text-anchor', (node: any) => node.x === 0 ? 'end' : 'start')
      .attr('fill', '#64748b')
      .attr('font-size', '12px')
      .attr('font-weight', '500')
      .attr('opacity', 0)
      .text((node: any) => node.x === 0 ? formatCurrency(node.value) : `${formatCurrency(node.value)} (${((node.value / rootValue) * 100).toFixed(1)}%)`)
      .transition()
      .duration(800)
      .delay((_datum: any, index: number) => index * 50 + 500)
      .attr('opacity', 0.9);

    svg.append('text')
      .attr('x', width / 2)
      .attr('y', 30)
      .attr('text-anchor', 'middle')
      .attr('fill', '#0f172a')
      .attr('font-size', '24px')
      .attr('font-weight', '700')
      .attr('opacity', 0)
      .text('Asset Allocation Flow')
      .transition()
      .duration(800)
      .attr('opacity', 1);
  }, [gradientIdBase, rootValue, slices]);

  return (
    <div className="w-full rounded-xl overflow-hidden">
      <div className="relative w-full" style={{ height: '520px' }}>
        <svg ref={svgRef} className="h-full w-full" />

        {hoveredNode ? (
          <div className="absolute right-4 top-4 rounded-xl border border-slate-200 bg-white p-4 text-slate-800 shadow-2xl">
            <div className="text-sm font-semibold" style={{ color: hoveredNode.color }}>{hoveredNode.name}</div>
            <div className="mt-1 text-2xl font-bold text-slate-900">{formatCurrency(hoveredNode.value)}</div>
            <div className="mt-1 text-xs text-slate-500">{((hoveredNode.value / rootValue) * 100).toFixed(2)}% of portfolio</div>
          </div>
        ) : null}

        {!hoveredNode && hoveredLink ? (
          <div className="absolute right-4 top-4 rounded-xl border border-slate-200 bg-white p-4 text-slate-800 shadow-2xl">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Flow</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{hoveredLink.source.name} → {hoveredLink.target.name}</div>
            <div className="mt-1 text-2xl font-bold" style={{ color: hoveredLink.target.color }}>{formatCurrency(hoveredLink.value)}</div>
            <div className="mt-1 text-xs text-slate-500">{((hoveredLink.value / rootValue) * 100).toFixed(2)}% of total</div>
          </div>
        ) : null}

        <div className="absolute bottom-4 left-4 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Asset Classes</div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {slices.filter((slice) => slice.value > 0).map((slice) => (
              <div key={`flow-legend-${slice.key}`} className="flex items-center gap-2">
                <div className="h-3 w-3 rounded" style={{ backgroundColor: slice.color }} />
                <span className="text-slate-700">{slice.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PortfolioAllocationFlowWidget({
  slices,
  totalValue,
  viewMode,
  loading,
  error,
}: {
  slices: PortfolioAllocationSlice[];
  totalValue: number;
  viewMode: 'assets' | 'equity';
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-[20px] border border-slate-200 bg-slate-50/80">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          Loading allocation flow...
        </div>
      </div>
    );
  }

  if (error && slices.length === 0) {
    return <EmptySnapshot title="Unable to load allocation flow" description={error} />;
  }

  if (slices.length === 0) {
    return <EmptySnapshot title="No allocation flow yet" description="Add assets to render the net worth allocation flow from asset classes into individual holdings." />;
  }

  return (
    <div className="min-h-[620px] overflow-x-auto">
      <ComprehensiveAssetSankey
        allocations={slices.map((slice) => ({
          label: slice.label,
          value: slice.value,
          percentage: slice.percent,
          color: slice.color,
          assetList: slice.assetList,
        }))}
        totalValue={totalValue}
        viewMode={viewMode}
      />
    </div>
  );
}

function PropertyImageWidget({
  property,
  properties,
  isPortfolioScope,
}: {
  property: DashboardProperty | null;
  properties: DashboardProperty[];
  isPortfolioScope: boolean;
}) {
  if (!property) {
    return <EmptySnapshot title="No property image yet" description="Select a property or load portfolio properties to render a live street-view image here." />;
  }

  const summary = property.data?.summary;
  const address = summary?.address || property.address;
  const value = summary?.avm_value ?? summary?.last_sale_price ?? property.financialData?.originalLoanAmount ?? 0;
  const rent = summary?.rental_avm ?? property.financialData?.monthlyRent ?? 0;
  const comparisonProperties = isPortfolioScope ? properties.filter((candidate) => candidate.id !== property.id).slice(0, 3) : [];

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="relative overflow-hidden rounded-[24px] border border-slate-200 bg-slate-100">
        <div className="h-[260px] w-full">
          <StreetViewImage address={address} className="h-full w-full object-cover" width={900} height={420} />
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/90 via-slate-950/40 to-transparent p-5 text-white">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-200">{isPortfolioScope ? 'Featured portfolio property' : 'Selected property'}</div>
          <div className="mt-2 max-w-2xl text-2xl font-semibold tracking-[-0.03em]">{address}</div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-100">
            <span className="rounded-full bg-white/12 px-3 py-1">{summary?.beds ?? '--'} bed</span>
            <span className="rounded-full bg-white/12 px-3 py-1">{summary?.baths ?? '--'} bath</span>
            <span className="rounded-full bg-white/12 px-3 py-1">{summary?.living_sqft ? `${summary.living_sqft.toLocaleString()} sqft` : 'Square footage unavailable'}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="Estimated value" value={formatCurrency(value)} />
        <MetricTile label="Estimated rent" value={formatCurrency(rent)} tone={rent > 0 ? 'positive' : 'default'} />
        <MetricTile label="Properties in scope" value={String(isPortfolioScope ? properties.length : 1)} />
      </div>

      {comparisonProperties.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {comparisonProperties.map((candidate) => {
            const candidateAddress = candidate.data?.summary?.address || candidate.address;
            return (
              <div key={candidate.id} className="overflow-hidden rounded-[20px] border border-slate-200 bg-white">
                <div className="h-24 w-full">
                  <StreetViewImage address={candidateAddress} className="h-full w-full object-cover" width={420} height={180} />
                </div>
                <div className="p-3 text-xs text-slate-600">
                  <div className="line-clamp-2 font-semibold text-slate-900">{candidateAddress}</div>
                  <div className="mt-1">{formatCurrency(candidate.data?.summary?.avm_value ?? candidate.financialData?.originalLoanAmount ?? 0)}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function TaxPdfViewerWidget({
  hasAuthenticatedUser,
  propertyId,
  propertyAddress,
  isPortfolioScope,
}: {
  hasAuthenticatedUser: boolean;
  propertyId?: string;
  propertyAddress?: string;
  isPortfolioScope: boolean;
}) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [resolvedYear, setResolvedYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    let objectUrl: string | null = null;

    if (!hasAuthenticatedUser) {
      setPdfUrl(null);
      setResolvedYear(null);
      setLoading(false);
      setError('Sign in to load the live tax packet PDF.');
      return () => {
        isActive = false;
      };
    }

    const loadPacket = async () => {
      setLoading(true);
      setError(null);
      setPdfUrl(null);
      setResolvedYear(null);

      const currentYear = new Date().getFullYear();
      const candidateYears = [currentYear, currentYear - 1];
      let lastError: Error | null = null;

      for (const year of candidateYears) {
        try {
          const blob = await taxClient.downloadCpaReviewPacket({
            year,
            propertyId: isPortfolioScope ? undefined : propertyId,
            filingStatus: 'single',
            otherIncome: '0',
            otherDeductions: '0',
            taxCredits: '0',
            withholdingYtd: '0',
          });

          if (!isActive) {
            return;
          }

          if (blob.size === 0) {
            lastError = new Error('The generated packet was empty.');
            continue;
          }

          objectUrl = URL.createObjectURL(blob);
          setPdfUrl(objectUrl);
          setResolvedYear(year);
          setLoading(false);
          return;
        } catch (nextError) {
          lastError = nextError instanceof Error ? nextError : new Error('Unable to load tax packet PDF.');
        }
      }

      if (!isActive) {
        return;
      }

      setError(lastError ? lastError.message : 'Unable to load tax packet PDF.');
      setLoading(false);
    };

    void loadPacket();

    return () => {
      isActive = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [hasAuthenticatedUser, isPortfolioScope, propertyId]);

  if (loading) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-[20px] border border-slate-200 bg-slate-50/80">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          Loading tax packet PDF...
        </div>
      </div>
    );
  }

  if (error && !pdfUrl) {
    return <EmptySnapshot title="Tax PDF unavailable" description={error} />;
  }

  if (!pdfUrl) {
    return <EmptySnapshot title="No tax PDF yet" description="The dashboard will show the latest CPA review packet PDF here when a generated tax packet is available." />;
  }

  const scopeLabel = isPortfolioScope
    ? 'Portfolio CPA review packet'
    : propertyAddress
      ? `CPA review packet for ${propertyAddress}`
      : 'Property CPA review packet';

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">PDF Viewer</div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{scopeLabel}</div>
          <div className="mt-1 text-sm text-slate-500">Showing the latest available Schedule E / CPA review packet PDF{resolvedYear ? ` for ${resolvedYear}` : ''}.</div>
        </div>
        <a
          href={pdfUrl}
          download={`schedule-e-report-${resolvedYear ?? 'latest'}.pdf`}
          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
        >
          Download PDF
        </a>
      </div>

      <div className="flex-1 overflow-hidden rounded-[24px] border border-slate-200 bg-slate-50">
        <iframe
          title={scopeLabel}
          src={`${pdfUrl}#toolbar=0&navpanes=0&view=FitH`}
          className="h-[460px] w-full bg-white"
        />
      </div>
    </div>
  );
}

function PropertyOverviewAssetWidget({
  property,
  focusAsset,
}: {
  property: DashboardProperty | null;
  focusAsset: PropertyOverviewAssetId;
}) {
  const { user } = useAuth();
  const [avmGranularity, setAvmGranularity] = useState<AvmGranularity>('annual');
  const [avmRange, setAvmRange] = useState<string>('10Y');
  const [taxHistoryRange, setTaxHistoryRange] = useState<TaxHistoryRange>('5Y');
  const analyticsGranularity: ProjectionGranularity = 'annual';
  const propertyDashboard = property?.data ?? null;
  const tenantSummaryEnabled = focusAsset === 'tenant-correspondence-summary' && Boolean(property?.id) && Boolean(user?.id);
  const {
    summary: tenantCorrespondenceSummary,
    loading: tenantSummaryLoading,
    refresh: refreshTenantSummary,
  } = useTenantCorrespondenceSummary({
    ownerId: user?.id,
    propertyId: property?.id,
    enabled: tenantSummaryEnabled,
  });
  const financialInputs = useMemo(
    () => deriveFinancialInputsFromProperty(property),
    [property],
  );
  const chartData = useMemo(
    () => (financialInputs ? buildAnalyticsChartData(financialInputs as PropertyAnalyticsSurfaceFinancialInputs, analyticsGranularity) : null),
    [analyticsGranularity, financialInputs],
  );
  const { avmPoints, avmLabels } = useMemo(
    () => buildPropertyAnalyticsAvmHistorySeries(propertyDashboard, avmGranularity, avmRange),
    [avmGranularity, avmRange, propertyDashboard],
  );
  const taxHistorySeries = useMemo(
    () => buildPropertyAnalyticsTaxHistorySeries(propertyDashboard?.tax_history as Array<{ year?: number | string; tax_amount?: number | string }> | undefined, taxHistoryRange),
    [propertyDashboard, taxHistoryRange],
  );

  if (!property) {
    return <EmptySnapshot title="No portfolio overview asset" description="Select a property to render this exact portfolio overview card." />;
  }

  const hasRenderableData = focusAsset === 'overview-price-history'
    ? avmPoints.length > 0
    : focusAsset === 'overview-tax-history'
      ? taxHistorySeries.values.length > 0
      : focusAsset === 'tenant-correspondence-summary'
        ? true
        : chartData !== null;

  if (!hasRenderableData) {
    return <EmptySnapshot title="Portfolio overview asset unavailable" description="This property does not have enough source data yet to render that exact portfolio overview card." />;
  }

  return (
    <PropertyOverviewAnalyticsGrid
      compact
      dense
      focusAsset={focusAsset}
      avmGranularity={avmGranularity}
      avmRange={avmRange}
      avmPoints={avmPoints}
      avmLabels={avmLabels}
      chartData={chartData}
      analyticsGranularity={analyticsGranularity}
      propertyDashLoading={false}
      taxHistoryRange={taxHistoryRange}
      taxHistorySeries={taxHistorySeries}
      tenantCorrespondenceSummary={tenantCorrespondenceSummary}
      summaryLoading={tenantSummaryLoading}
      onAvmGranularityChange={setAvmGranularity}
      onAvmRangeChange={setAvmRange}
      onTaxHistoryRangeChange={setTaxHistoryRange}
      onRefreshTenantSummary={() => {
        void refreshTenantSummary();
      }}
      hasCurrentTenant={Boolean((property.tenantCount ?? 0) > 0)}
    />
  );
}

function hasRenderablePropertyDetailsSection(propertyDashboard: PropertyDashboard | null | undefined, focusSection: PropertyDetailsFocusSection) {
  if (!propertyDashboard) return false;

  switch (focusSection) {
    case 'overview':
      return Boolean(propertyDashboard.summary);
    case 'tax-history':
      return Array.isArray(propertyDashboard.tax_history) && propertyDashboard.tax_history.length > 0;
    case 'mortgage':
      return Boolean(propertyDashboard.summary?.mortgage);
    case 'owner':
      return Boolean(propertyDashboard.summary?.owner);
    case 'environmental':
      return Boolean(propertyDashboard.environmental && Object.keys(propertyDashboard.environmental).length > 0);
    case 'schools':
      return Array.isArray(propertyDashboard.schools) && propertyDashboard.schools.length > 0;
    case 'building-permits':
      return Array.isArray(propertyDashboard.building_permits) && propertyDashboard.building_permits.length > 0;
    case 'sale-history':
      return Boolean(propertyDashboard.summary?.last_sale_date || propertyDashboard.summary?.last_sale_price);
    case 'location':
      return Boolean(propertyDashboard.summary?.area_context && Object.keys(propertyDashboard.summary.area_context).length > 0);
    default:
      return false;
  }
}

function PropertyDetailsSectionWidget({
  property,
  focusSection,
}: {
  property: DashboardProperty | null;
  focusSection: PropertyDetailsFocusSection;
}) {
  const { user } = useAuth();

  if (!property) {
    return <EmptySnapshot title="No property details asset" description="Select a property to render this exact expanded property modal section." />;
  }

  if (!hasRenderablePropertyDetailsSection(property.data, focusSection)) {
    return <EmptySnapshot title="Property details asset unavailable" description="This property does not have enough source data yet to render that expanded property details section." />;
  }

  return (
    <PropertyDetailsModal
      isOpen
      onClose={() => undefined}
      address={property.data?.summary?.address || property.address}
      embedded
      hideFooter
      focusSection={focusSection}
      propertyData={property.data}
      taxPropertyId={buildBookkeepingPropertyId(user?.id, property)}
    />
  );
}

function RentalPricingPowerWidget({
  property,
  userId,
  focusAsset,
}: {
  property: DashboardProperty | null;
  userId?: string;
  focusAsset?: RentalPricingPowerAssetId;
}) {
  const [pricingProjectionMode, setPricingProjectionMode] = useState<'none' | 'market' | 'recommended' | 'custom'>('none');
  const propertyDashboard = property?.data ?? null;
  const summary = propertyDashboard?.summary ?? null;
  const financialInputs = useMemo(
    () => deriveFinancialInputsFromProperty(property),
    [property],
  );
  const chartData = useMemo(
    () => (financialInputs ? buildAnalyticsChartData(financialInputs as PropertyAnalyticsSurfaceFinancialInputs, 'annual') : null),
    [financialInputs],
  );

  if (!property) {
    return <EmptySnapshot title="No rental pricing power asset" description="Select a property to render this exact rental pricing power surface." />;
  }

  const address = summary?.address || property.address;
  const zipCode = address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '90210';
  const monthlyExpenses = financialInputs
    ? ((financialInputs.insurance + financialInputs.utilities + financialInputs.hoa + financialInputs.repairsCapEx) / 12)
      + (financialInputs.taxAmount / 12)
      + ((financialInputs.monthlyRent * financialInputs.managementPct) / 100)
    : undefined;
  const monthlyMortgage = financialInputs
    ? (financialInputs.monthlyDebtService ?? (() => {
      if (financialInputs.isInterestOnly || financialInputs.interestRate <= 0) return 0;
      const loanBalance = financialInputs.currentLoanBalance
        ?? financialInputs.originalLoanAmount
        ?? Math.max(financialInputs.avm - financialInputs.downPayment, 0);
      const monthlyRate = financialInputs.interestRate / 100 / 12;
      const remainingTerm = financialInputs.remainingLoanTermMonths ?? financialInputs.loanTerm;
      if (!loanBalance || !remainingTerm || monthlyRate <= 0) return 0;
      return (monthlyRate * loanBalance) / (1 - Math.pow(1 + monthlyRate, -remainingTerm));
    })())
    : undefined;
  const currentCashFlow = chartData?.cashFlow?.[0] != null
    ? (chartData.cashFlow[0] * 1000) / 12
    : undefined;
  const bookedMonthlyRent = Number(financialInputs?.monthlyRent) || null;

  if (!bookedMonthlyRent) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h3 className="font-semibold">Booked rent required</h3>
        <p className="mt-1">
          Add the property&apos;s actual monthly rent before running Rental Pricing Power.
          The ATTOM rental AVM is shown elsewhere as a market estimate and is not substituted
          for booked rent.
        </p>
      </div>
    );
  }

  return (
    <RentalPricingPowerGraph
      propertyId={address}
      currentRent={bookedMonthlyRent}
      bedrooms={Number(summary?.beds) || undefined}
      bathrooms={Number(summary?.baths) || undefined}
      squareFeet={Number(summary?.living_sqft) || undefined}
      zipCode={zipCode}
      userId={userId}
      cachePropertyId={property.id || address}
      latitude={Number(summary?.latitude) || undefined}
      longitude={Number(summary?.longitude) || undefined}
      propertyType={summary?.property_type || undefined}
      yearBuilt={Number(summary?.year_built) || undefined}
      attomRentAvm={Number(summary?.rental_avm) || undefined}
      attomRentLow={Number(summary?.rental_avm_low) || undefined}
      attomRentHigh={Number(summary?.rental_avm_high) || undefined}
      monthlyExpenses={monthlyExpenses}
      monthlyMortgage={monthlyMortgage}
      currentCashFlow={currentCashFlow}
      vacancyRate={financialInputs?.vacancyRate}
      onNavigateToRenovations={() => {
        window.location.href = '/renovations';
      }}
      pricingProjectionMode={pricingProjectionMode}
      onPricingProjectionModeChange={setPricingProjectionMode}
      focusAsset={focusAsset}
    />
  );
}

function MarketInsightsAssetWidget({
  focusAsset,
}: {
  focusAsset: MarketInsightsAssetId;
}) {
  const asset = MARKET_INSIGHTS_ASSET_METADATA[focusAsset];
  const src = `/market-data?marketEmbed=1&marketTab=${encodeURIComponent(asset.tab)}&marketAsset=${encodeURIComponent(focusAsset)}`;

  return (
    <div
      className="flex h-full min-h-full flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_12px_34px_rgba(15,23,42,0.06)]"
      style={{ minHeight: `${asset.minHeight}px` }}
    >
      <iframe
        title={asset.title}
        src={src}
        loading="lazy"
        className="min-h-[180px] flex-1 bg-white"
        style={{ minHeight: `${asset.minHeight}px`, width: '100%', border: '0' }}
      />
    </div>
  );
}

function IncomeProjectionAssetWidget({
  focusAsset,
}: {
  focusAsset: IncomeProjectionAssetId;
}) {
  const asset = INCOME_PROJECTION_ASSET_METADATA[focusAsset];
  const src = `/income-projections?incomeEmbed=1&incomeTab=${encodeURIComponent(asset.tab)}&incomeAsset=${encodeURIComponent(focusAsset)}`;

  return (
    <div
      className="flex h-full min-h-full flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_12px_34px_rgba(15,23,42,0.06)]"
      style={{ minHeight: `${asset.minHeight}px` }}
    >
      <iframe
        title={asset.title}
        src={src}
        loading="lazy"
        className="min-h-[180px] flex-1 bg-white"
        style={{ minHeight: `${asset.minHeight}px`, width: '100%', border: '0' }}
      />
    </div>
  );
}

function BookkeepingAnalyticsFoundationWidget({
  summary,
  transactions,
  cashBalance,
  focusAsset,
}: {
  summary: BookkeepingSummary | null;
  transactions: BookkeepingTransaction[];
  cashBalance: number | null;
  focusAsset?: BookkeepingAnalyticsAssetId;
}) {
  if (!summary && transactions.length === 0) {
    return <EmptySnapshot title="No bookkeeping analytics yet" description="Posted bookkeeping transactions will render the canonical analytics foundation workspace here." />;
  }

  return (
    <BookkeepingAnalyticsWorkspace
      summary={summary}
      cashflowTrend={[]}
      transactions={transactions}
      cashBalance={cashBalance}
      propertyCashBalances={{}}
      reconExceptions={[]}
      evidenceTotalCount={0}
      evidencePendingCount={0}
      pendingFinanceDocumentsCount={0}
      onSelectCategory={() => undefined}
      onSelectVendor={() => undefined}
      focusAsset={focusAsset}
    />
  );
}

function IrsDraftFormsWidget({
  hasAuthenticatedUser,
  propertyId,
  propertyAddress,
  isPortfolioScope,
}: {
  hasAuthenticatedUser: boolean;
  propertyId?: string;
  propertyAddress?: string;
  isPortfolioScope: boolean;
}) {
  const [resolvedYear, setResolvedYear] = useState<number>(new Date().getFullYear() - 1);
  const [draftFormProfile, setDraftFormProfile] = useState<TaxpayerDraftProfile>(EMPTY_DASHBOARD_TAXPAYER_DRAFT_PROFILE);
  const [homeState, setHomeState] = useState('');
  const [scheduleSummary, setScheduleSummary] = useState<DashboardTaxScheduleSummary | null>(null);
  const [scheduleDetail, setScheduleDetail] = useState<{ scheduleELines?: Record<string, DashboardTaxScheduleLineDetail>; summary?: DashboardTaxScheduleSummary } | null>(null);
  const [depreciationTotal, setDepreciationTotal] = useState(0);
  const [rulesVersion, setRulesVersion] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!hasAuthenticatedUser) {
      setScheduleSummary(null);
      setScheduleDetail(null);
      setRulesVersion(undefined);
      setLoading(false);
      setError('Sign in to load the draft IRS form workspace.');
      return () => {
        active = false;
      };
    }

    const loadDraftForms = async () => {
      setLoading(true);
      setError(null);

      const currentYear = new Date().getFullYear();
      const candidateYears = [currentYear, currentYear - 1];
      let loaded = false;
      let lastError: string | null = null;

      for (const candidateYear of candidateYears) {
        try {
          const scopedParams = { year: candidateYear, propertyId: isPortfolioScope ? undefined : propertyId };
          const portfolioParams = { year: candidateYear };

          const [yearSummaryResponse, scheduleResponse, portfolioYearSummaryResponse, portfolioScheduleResponse, snapshotResponse, draftProfileResponse] = await Promise.all([
            taxClient.getYearSummary(scopedParams).catch(() => null),
            taxClient.getScheduleE(scopedParams).catch(() => null),
            propertyId && !isPortfolioScope ? taxClient.getYearSummary(portfolioParams).catch(() => null) : Promise.resolve(null),
            propertyId && !isPortfolioScope ? taxClient.getScheduleE(portfolioParams).catch(() => null) : Promise.resolve(null),
            taxClient.getWorkpaperSnapshot(candidateYear).catch(() => null),
            taxClient.getDraftFormProfile({ year: candidateYear }).catch(() => null),
          ]);

          const scopedYearSummary = yearSummaryResponse?.ok ? yearSummaryResponse : null;
          const scopedScheduleDetail = scheduleResponse?.ok ? scheduleResponse : null;
          const portfolioYearSummary = portfolioYearSummaryResponse?.ok ? portfolioYearSummaryResponse : null;
          const portfolioScheduleDetail = portfolioScheduleResponse?.ok ? portfolioScheduleResponse : null;
          const usePortfolioFallback = Boolean(propertyId && !isPortfolioScope)
            && !hasRenderableDashboardTaxDataset(scopedScheduleDetail?.summary || scopedYearSummary?.scheduleE || null, scopedScheduleDetail)
            && hasRenderableDashboardTaxDataset(portfolioScheduleDetail?.summary || portfolioYearSummary?.scheduleE || null, portfolioScheduleDetail);

          const effectiveYearSummary = usePortfolioFallback ? portfolioYearSummary : scopedYearSummary;
          const effectiveScheduleDetail = usePortfolioFallback ? portfolioScheduleDetail : scopedScheduleDetail;
          const effectiveScheduleSummary = effectiveScheduleDetail?.summary || effectiveYearSummary?.scheduleE || null;

          if (!hasRenderableDashboardTaxDataset(effectiveScheduleSummary, effectiveScheduleDetail)) {
            continue;
          }

          if (!active) return;

          const snapshot = snapshotResponse?.snapshot || null;
          const nextDraftProfile = normalizeDashboardDraftFormProfile(
            draftProfileResponse?.ok ? draftProfileResponse.profile : snapshot?.draftFormProfile,
            homeState,
          );

          setResolvedYear(candidateYear);
          setScheduleSummary(effectiveScheduleSummary);
          setScheduleDetail(effectiveScheduleDetail);
          setDepreciationTotal(Number(effectiveYearSummary?.depreciation?.totalCurrentYearDepreciation || 0));
          setRulesVersion(snapshot?.rulesVersion);
          setDraftFormProfile(nextDraftProfile);
          if (nextDraftProfile.mailingState) {
            setHomeState(nextDraftProfile.mailingState);
          }
          loaded = true;
          setLoading(false);
          return;
        } catch (nextError) {
          lastError = nextError instanceof Error ? nextError.message : 'Unable to load draft IRS forms.';
        }
      }

      if (!active) return;

      if (!loaded) {
        setScheduleSummary(null);
        setScheduleDetail(null);
        setRulesVersion(undefined);
        setError(lastError || 'No draft IRS form data is available for the current scope.');
        setLoading(false);
      }
    };

    void loadDraftForms();

    return () => {
      active = false;
    };
  }, [hasAuthenticatedUser, isPortfolioScope, propertyId]);

  const scheduleLines = useMemo(
    () => Object.entries(scheduleDetail?.scheduleELines || {})
      .filter(([, line]) => Number(line.amount || 0) > 0)
      .sort((left, right) => Number(left[1].line || 999) - Number(right[1].line || 999))
      .map(([, line]) => ({
        line: line.line ?? null,
        name: line.name || 'Schedule E line',
        amount: Number(line.amount || 0),
      })),
    [scheduleDetail],
  );

  const resolvedDepreciationTotal = useMemo(() => {
    const depreciationLine = scheduleLines.find((line) => Number(line.line || 0) === 18);
    return Number(depreciationTotal || depreciationLine?.amount || 0);
  }, [depreciationTotal, scheduleLines]);

  if (loading) {
    return (
      <div className="flex h-[460px] items-center justify-center rounded-[20px] border border-slate-200 bg-slate-50/80">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          Loading IRS draft forms...
        </div>
      </div>
    );
  }

  if (error && !hasRenderableDashboardTaxDataset(scheduleSummary, scheduleDetail)) {
    return <EmptySnapshot title="IRS draft forms unavailable" description={error} />;
  }

  if (!hasRenderableDashboardTaxDataset(scheduleSummary, scheduleDetail)) {
    return <EmptySnapshot title="No IRS draft data yet" description="The dashboard will show the canonical IRS draft workspace here once Schedule E preview data is available." />;
  }

  return (
    <IrsDraftFormWorkspace
      year={resolvedYear}
      filingStatus="single"
      profile={draftFormProfile}
      onProfileChange={setDraftFormProfile}
      propertyAddress={isPortfolioScope ? undefined : propertyAddress}
      rulesVersion={rulesVersion}
      scheduleIncome={Number(scheduleSummary?.totalIncome || 0)}
      scheduleExpenses={Number(scheduleSummary?.totalExpenses || 0)}
      scheduleNet={Number(scheduleSummary?.netIncomeOrLoss || 0)}
      depreciationTotal={resolvedDepreciationTotal}
      scheduleLines={scheduleLines}
    />
  );
}

function DashboardPropertyAnalyticsSurface({
  metric,
  scopes,
  portfolioAnalytics,
}: {
  metric: PropertyAnalyticsMetricKey;
  scopes?: DashboardAnalyticsSurfaceScope[];
  portfolioAnalytics?: PortfolioAnalyticsContext | null;
}) {
  const safeScopes = Array.isArray(scopes) ? scopes : [];

  if (safeScopes.length === 0) {
    return <EmptySnapshot title="No analytics context" description="Select a property or ask for a portfolio-wide analytics view to render this source card." />;
  }

  const visibleScopes = safeScopes.slice(0, DASHBOARD_PROPERTY_COMPARISON_MAX);
  const portfolioDashboard = buildPortfolioAnalyticsPropertyDashboard(portfolioAnalytics);

  return (
    <div className={visibleScopes.length > 1 ? 'grid h-full grid-cols-1 gap-4 xl:grid-cols-2' : 'grid h-full grid-cols-1'}>
      {visibleScopes.map((scope) => {
        const propertyDashboard = scope.isPortfolioScope
          ? portfolioDashboard
          : normalizeDashboardAnalyticsPropertyDashboard(scope.property?.data, scope.label);
        const financialInputs = scope.isPortfolioScope
          ? portfolioAnalytics?.financialInputs ?? null
          : deriveFinancialInputsFromProperty(scope.property);

        return (
          <PropertyAnalyticsMetricSurface
            key={scope.key}
            metric={metric}
            propertyDashboard={propertyDashboard}
            financialInputs={financialInputs}
            scopeLabel={scope.label}
            showScopeHeader={false}
            dashboardCardMode
          />
        );
      })}
    </div>
  );
}

function buildAnalyzingFramePath(width: number, height: number, radius: number) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  const x = roundSvg(1.5);
  const y = roundSvg(1.5);
  const w = roundSvg(Math.max(1, width - 3));
  const h = roundSvg(Math.max(1, height - 3));
  const r = roundSvg(safeRadius);

  return [
    `M ${roundSvg(x + r)} ${y}`,
    `H ${roundSvg(x + w - r)}`,
    `A ${r} ${r} 0 0 1 ${roundSvg(x + w)} ${roundSvg(y + r)}`,
    `V ${roundSvg(y + h - r)}`,
    `A ${r} ${r} 0 0 1 ${roundSvg(x + w - r)} ${roundSvg(y + h)}`,
    `H ${roundSvg(x + r)}`,
    `A ${r} ${r} 0 0 1 ${x} ${roundSvg(y + h - r)}`,
    `V ${roundSvg(y + r)}`,
    `A ${r} ${r} 0 0 1 ${roundSvg(x + r)} ${y}`,
    'Z',
  ].join(' ');
}

type DashboardDotRippleParticle = {
  centerX: number;
  centerY: number;
  baseSize: number;
  baseAlpha: number;
  centerPull: number;
  radialDistance: number;
  distanceNorm: number;
  edgePull: number;
  angle: number;
  phase: number;
  edgePhase: number;
};

type DashboardDotRipplePulse = {
  originX: number;
  originY: number;
  startedAt: number;
  radius: number;
  width: number;
  duration: number;
  strength: number;
};

type DashboardDotRipplePointer = {
  pointerX: number;
  pointerY: number;
  updatedAt: number;
};

type DashboardDotRippleOrb = {
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  trailX: number;
  trailY: number;
  startX: number;
  startY: number;
  controlX: number;
  controlY: number;
  targetX: number;
  targetY: number;
  startedAt: number;
  duration: number;
  seed: number;
};

type DashboardDotRippleInfluence = {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  rotation: number;
  weight: number;
  push: number;
  swirl: number;
  growth: number;
};

type DashboardDotRippleState = {
  width: number;
  height: number;
  pixelRatio: number;
  particles: DashboardDotRippleParticle[];
  pulses: DashboardDotRipplePulse[];
  pointer: DashboardDotRipplePointer | null;
  orb: DashboardDotRippleOrb | null;
  lastAutoPulseAt: number;
  reducedMotion: boolean;
};

function easeDashboardDotRipple(value: number) {
  const clampedValue = clampNumber(value, 0, 1);
  return clampedValue * clampedValue * (3 - (2 * clampedValue));
}

function DashboardDotRippleField({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const animationFrameRef = useRef<number | null>(null);
  const ensureLoopRef = useRef<(() => void) | null>(null);
  const spawnPulseRef = useRef<((originX: number, originY: number, strength?: number, duration?: number) => void) | null>(null);
  const stateRef = useRef<DashboardDotRippleState>({
    width: 1,
    height: 1,
    pixelRatio: 1,
    particles: [],
    pulses: [],
    pointer: null,
    orb: null,
    lastAutoPulseAt: 0,
    reducedMotion: false,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const renderingContext = canvas?.getContext('2d');
    if (!canvas || !host || !renderingContext) return;

    const canvasElement = canvas;
    const hostElement = host;
    const canvasContext = renderingContext;

    const fullCircle = Math.PI * 2;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const state = stateRef.current;
    state.reducedMotion = motionQuery.matches;

    function buildParticles(width: number, height: number) {
      const dotSpacing = width < 720 ? 18 : 21;
      const columnCount = Math.ceil(width / dotSpacing) + 7;
      const rowCount = Math.ceil(height / dotSpacing) + 7;
      const startX = (width - ((columnCount - 1) * dotSpacing)) / 2;
      const startY = (height - ((rowCount - 1) * dotSpacing)) / 2;
      const centerX = width / 2;
      const centerY = height / 2;
      const maxDistance = Math.hypot(centerX, centerY) || 1;
      const nextParticles: DashboardDotRippleParticle[] = [];

      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
          const particleX = startX + (columnIndex * dotSpacing);
          const particleY = startY + (rowIndex * dotSpacing);
          const centerDistance = Math.hypot(particleX - centerX, particleY - centerY);
          const distanceNorm = clampNumber(centerDistance / maxDistance, 0, 1);
          const centerPull = easeDashboardDotRipple(1 - clampNumber(distanceNorm / 0.94, 0, 1));
          const edgePull = easeDashboardDotRipple(clampNumber((distanceNorm - 0.56) / 0.44, 0, 1));
          const angle = Math.atan2(particleY - centerY, particleX - centerX);
          const edgePhase = Math.sin((rowIndex * 19.91) + (columnIndex * 47.67)) * Math.PI;

          nextParticles.push({
            centerX: particleX,
            centerY: particleY,
            baseSize: 0.5 + (centerPull * 0.07) + (edgePull * 0.04),
            baseAlpha: 0.044 + (centerPull * 0.016) + (edgePull * 0.012),
            centerPull,
            radialDistance: centerDistance,
            distanceNorm,
            edgePull,
            angle,
            phase: (rowIndex * 0.47) + (columnIndex * 0.31) + (distanceNorm * 2.1),
            edgePhase,
          });
        }
      }

      stateRef.current.particles = nextParticles;
    }

    function syncCanvasSize() {
      const hostRect = hostElement.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.ceil(hostRect.width));
      const nextHeight = Math.max(1, Math.ceil(hostRect.height));
      const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const currentState = stateRef.current;

      if (
        currentState.width === nextWidth
        && currentState.height === nextHeight
        && currentState.pixelRatio === nextPixelRatio
      ) {
        return;
      }

      canvasElement.width = Math.max(1, Math.floor(nextWidth * nextPixelRatio));
      canvasElement.height = Math.max(1, Math.floor(nextHeight * nextPixelRatio));
      currentState.width = nextWidth;
      currentState.height = nextHeight;
      currentState.pixelRatio = nextPixelRatio;
      canvasContext.setTransform(nextPixelRatio, 0, 0, nextPixelRatio, 0, 0);
      buildParticles(nextWidth, nextHeight);
      currentState.orb = null;
    }

    function addPulse(originX: number, originY: number, strength = 0.65, duration = 2200) {
      const currentState = stateRef.current;
      if (currentState.width <= 1 || currentState.height <= 1) return;

      currentState.pulses = [
        ...currentState.pulses.slice(-4),
        {
          originX,
          originY,
          startedAt: performance.now(),
          radius: Math.hypot(currentState.width / 2, currentState.height / 2) * 1.12,
          width: clampNumber(Math.min(currentState.width, currentState.height) * 0.085, 26, 50),
          duration,
          strength,
        },
      ];
    }

    function pickOrbTarget(width: number, height: number, fromX = width / 2, fromY = height / 2) {
      const centerX = width / 2;
      const centerY = height / 2;
      const horizontalPadding = clampNumber(width * 0.065, 28, 102);
      const verticalPadding = clampNumber(height * 0.078, 28, 88);
      const horizontalRadius = Math.max(1, centerX - horizontalPadding);
      const verticalRadius = Math.max(1, centerY - verticalPadding);
      const minTravel = clampNumber(Math.min(width, height) * 0.53, 164, 400);
      const anchorTargets = [
        { x: horizontalPadding, y: verticalPadding },
        { x: width - horizontalPadding, y: verticalPadding },
        { x: width - horizontalPadding, y: height - verticalPadding },
        { x: horizontalPadding, y: height - verticalPadding },
        { x: centerX, y: verticalPadding },
        { x: width - horizontalPadding, y: centerY },
        { x: centerX, y: height - verticalPadding },
        { x: horizontalPadding, y: centerY },
      ];
      let selectedTarget = { x: centerX, y: centerY };
      let selectedScore = Number.NEGATIVE_INFINITY;

      for (let candidateIndex = 0; candidateIndex < 14; candidateIndex += 1) {
        const useAnchor = candidateIndex < 9 && Math.random() < 0.9;
        const anchor = anchorTargets[Math.floor(Math.random() * anchorTargets.length)];
        const angle = Math.random() * fullCircle;
        const radius = 0.42 + (Math.sqrt(Math.random()) * 0.58);
        const jitterX = (Math.random() - 0.5) * horizontalPadding * 0.55;
        const jitterY = (Math.random() - 0.5) * verticalPadding * 0.55;
        const candidateX = useAnchor
          ? clampNumber(anchor.x + jitterX, horizontalPadding, width - horizontalPadding)
          : clampNumber(centerX + (Math.cos(angle) * horizontalRadius * radius), horizontalPadding, width - horizontalPadding);
        const candidateY = useAnchor
          ? clampNumber(anchor.y + jitterY, verticalPadding, height - verticalPadding)
          : clampNumber(centerY + (Math.sin(angle) * verticalRadius * radius), verticalPadding, height - verticalPadding);
        const travelDistance = Math.hypot(candidateX - fromX, candidateY - fromY);
        const lateralBias = Math.abs(candidateX - fromX) * 0.24;
        const verticalBias = Math.abs(candidateY - fromY) * 0.17;
        const edgeDistance = Math.min(candidateX, width - candidateX, candidateY, height - candidateY);
        const edgeBias = (Math.max(horizontalPadding, verticalPadding) - edgeDistance) * 0.16;
        const anchorBias = useAnchor ? minTravel * 0.3 : 0;
        const score = travelDistance
          + lateralBias
          + verticalBias
          + edgeBias
          + anchorBias
          + (Math.random() * minTravel * 0.1)
          - (travelDistance < minTravel ? minTravel * 1.34 : 0);

        if (score > selectedScore) {
          selectedScore = score;
          selectedTarget = { x: candidateX, y: candidateY };
        }
      }

      return selectedTarget;
    }

    function retargetOrb(targetX: number, targetY: number, timestamp: number, duration?: number) {
      const currentState = stateRef.current;
      const existingOrb = currentState.orb;
      const originX = existingOrb?.x ?? (currentState.width / 2);
      const originY = existingOrb?.y ?? (currentState.height / 2);
      const distance = Math.hypot(targetX - originX, targetY - originY);
      const safeDistance = distance || 1;
      const bendDirection = Math.random() > 0.5 ? 1 : -1;
      const bend = bendDirection * clampNumber(distance * 0.34, 40, Math.min(currentState.width, currentState.height) * 0.28);
      const normalX = -(targetY - originY) / safeDistance;
      const normalY = (targetX - originX) / safeDistance;
      const midpointX = (originX + targetX) / 2;
      const midpointY = (originY + targetY) / 2;
      const seed = Math.random() * fullCircle;

      currentState.orb = {
        x: originX,
        y: originY,
        previousX: originX,
        previousY: originY,
        trailX: existingOrb?.trailX ?? originX,
        trailY: existingOrb?.trailY ?? originY,
        startX: originX,
        startY: originY,
        controlX: clampNumber(midpointX + (normalX * bend) + ((currentState.width / 2 - midpointX) * 0.045), 0, currentState.width),
        controlY: clampNumber(midpointY + (normalY * bend) + ((currentState.height / 2 - midpointY) * 0.045), 0, currentState.height),
        targetX,
        targetY,
        startedAt: timestamp,
        duration: duration ?? clampNumber(4600 + (distance * 3.1) + (Math.random() * 780), 5000, 7800),
        seed,
      };
    }

    function updateOrb(timestamp: number) {
      const currentState = stateRef.current;
      const centerX = currentState.width / 2;
      const centerY = currentState.height / 2;

      if (currentState.reducedMotion) {
        currentState.orb = {
          x: centerX,
          y: centerY,
          previousX: centerX,
          previousY: centerY,
          trailX: centerX,
          trailY: centerY,
          startX: centerX,
          startY: centerY,
          controlX: centerX,
          controlY: centerY,
          targetX: centerX,
          targetY: centerY,
          startedAt: timestamp,
          duration: 1,
          seed: 0,
        };
        return currentState.orb;
      }

      if (!currentState.orb) {
        const nextTarget = pickOrbTarget(currentState.width, currentState.height, centerX, centerY);
        retargetOrb(nextTarget.x, nextTarget.y, timestamp, 4600);
      }

      const currentOrb = currentState.orb;
      if (currentOrb && timestamp - currentOrb.startedAt >= currentOrb.duration) {
        const nextTarget = pickOrbTarget(currentState.width, currentState.height, currentOrb.x, currentOrb.y);
        retargetOrb(nextTarget.x, nextTarget.y, timestamp);
      }

      const activeOrb = currentState.orb;
      if (!activeOrb) {
        return null;
      }

      const linearProgress = clampNumber((timestamp - activeOrb.startedAt) / activeOrb.duration, 0, 1);
      const progress = easeDashboardDotRipple(linearProgress);
      const inverseProgress = 1 - progress;
      const travelDistance = Math.hypot(activeOrb.targetX - activeOrb.startX, activeOrb.targetY - activeOrb.startY);
      const safeTravelDistance = travelDistance || 1;
      const normalX = -(activeOrb.targetY - activeOrb.startY) / safeTravelDistance;
      const normalY = (activeOrb.targetX - activeOrb.startX) / safeTravelDistance;
      const waveTaper = Math.sin(linearProgress * Math.PI);
      const waveOffset = Math.sin((linearProgress * Math.PI * 1.14) + activeOrb.seed) * waveTaper * clampNumber(travelDistance * 0.04, 5, 22);

      activeOrb.previousX = activeOrb.x;
      activeOrb.previousY = activeOrb.y;
      activeOrb.x = (inverseProgress * inverseProgress * activeOrb.startX)
        + (2 * inverseProgress * progress * activeOrb.controlX)
        + (progress * progress * activeOrb.targetX)
        + (normalX * waveOffset);
      activeOrb.y = (inverseProgress * inverseProgress * activeOrb.startY)
        + (2 * inverseProgress * progress * activeOrb.controlY)
        + (progress * progress * activeOrb.targetY)
        + (normalY * waveOffset);
      activeOrb.trailX += (activeOrb.x - activeOrb.trailX) * 0.102;
      activeOrb.trailY += (activeOrb.y - activeOrb.trailY) * 0.102;

      return activeOrb;
    }

    function draw(timestamp: number) {
      animationFrameRef.current = null;
      syncCanvasSize();

      const currentState = stateRef.current;
      canvasContext.clearRect(0, 0, currentState.width, currentState.height);

      if (!activeRef.current) {
        currentState.pulses = [];
        currentState.pointer = null;
        currentState.orb = null;
        return;
      }

      const orb = updateOrb(timestamp);
      const orbX = orb?.x ?? (currentState.width / 2);
      const orbY = orb?.y ?? (currentState.height / 2);
      const orbVelocityX = orb ? orb.x - orb.previousX : 0;
      const orbVelocityY = orb ? orb.y - orb.previousY : 0;
      const orbVelocity = Math.hypot(orbVelocityX, orbVelocityY);
      const orbSeed = orb?.seed ?? 0;
      const fallbackDirectionX = Math.cos((timestamp * 0.00072) + orbSeed);
      const fallbackDirectionY = Math.sin((timestamp * 0.00072) + orbSeed);
      const safeOrbVelocity = orbVelocity || 1;
      const orbDirectionX = orbVelocity > 0.08 ? orbVelocityX / safeOrbVelocity : fallbackDirectionX;
      const orbDirectionY = orbVelocity > 0.08 ? orbVelocityY / safeOrbVelocity : fallbackDirectionY;
      const orbSideX = -orbDirectionY;
      const orbSideY = orbDirectionX;
      const orbVelocityEnergy = clampNumber(orbVelocity / 0.9, 0, 1);
      const panelMin = Math.min(currentState.width, currentState.height);
      const fieldRadiusX = clampNumber(Math.max(currentState.width * 0.335, panelMin * 1), 300, 740);
      const fieldRadiusY = clampNumber(panelMin * 0.82, 230, 455);
      const shapeBreath = currentState.reducedMotion ? 0.5 : ((Math.sin((timestamp * 0.00032) + orbSeed) + 1) / 2);
      const shapeStretch = currentState.reducedMotion ? 0.5 : ((Math.sin((timestamp * 0.00027) + (orbSeed * 2.35)) + 1) / 2);
      const growthSurge = currentState.reducedMotion ? 0.35 : easeDashboardDotRipple((Math.sin((timestamp * 0.00042) + (orbSeed * 1.4)) + 1) / 2);
      const shapeTilt = currentState.reducedMotion
        ? 0
        : (Math.sin((timestamp * 0.00027) + (orbSeed * 0.7)) * 0.62)
          + (Math.sin((timestamp * 0.00013) + (orbSeed * 2.2)) * 0.2);
      const splitWave = currentState.reducedMotion ? 0 : ((Math.sin((timestamp * 0.0003) + (orbSeed * 1.7)) + 1) / 2);
      const splitEnergy = easeDashboardDotRipple(clampNumber((splitWave - 0.52) / 0.48, 0, 1));
      const splitDistance = clampNumber(Math.min(fieldRadiusX, fieldRadiusY) * (0.26 + (splitEnergy * 0.28)), 66, 205) * splitEnergy;
      const splitDrift = Math.sin((timestamp * 0.00022) + orbSeed) * 0.46;
      const companionDirectionX = (orbSideX * Math.cos(splitDrift)) + (orbDirectionX * Math.sin(splitDrift));
      const companionDirectionY = (orbSideY * Math.cos(splitDrift)) + (orbDirectionY * Math.sin(splitDrift));
      const lobeRotation = Math.atan2(orbDirectionY, orbDirectionX) + shapeTilt;
      const influencePoints: DashboardDotRippleInfluence[] = orb
        ? [
          {
            x: orbX,
            y: orbY,
            radiusX: fieldRadiusX * (0.84 + (shapeBreath * 0.26) + (shapeStretch * 0.18)),
            radiusY: fieldRadiusY * (0.74 + ((1 - shapeBreath) * 0.22) + ((1 - shapeStretch) * 0.12)),
            rotation: lobeRotation,
            weight: 0.86 - (splitEnergy * 0.07),
            push: 0.58,
            swirl: 0.18,
            growth: 0.66 + (growthSurge * 0.22),
          },
          ...(splitEnergy > 0.02
            ? [{
              x: clampNumber(orbX + (companionDirectionX * splitDistance), 0, currentState.width),
              y: clampNumber(orbY + (companionDirectionY * splitDistance), 0, currentState.height),
              radiusX: fieldRadiusX * (0.48 + (splitEnergy * 0.2) + ((1 - shapeStretch) * 0.06)),
              radiusY: fieldRadiusY * (0.54 + (splitEnergy * 0.18) + (shapeStretch * 0.06)),
              rotation: lobeRotation - 0.46 + (splitDrift * 0.58),
              weight: splitEnergy * 0.42,
              push: 0.42,
              swirl: 0.16,
              growth: 0.54 + (growthSurge * 0.18),
            }]
            : []),
        ]
        : [];

      const backgroundPulse = currentState.reducedMotion ? 0.2 : ((Math.sin(timestamp * 0.001) + 1) / 2);
      for (const influence of influencePoints.slice(0, 4)) {
        if (influence.weight <= 0.02) continue;

        const backdrop = canvasContext.createRadialGradient(
          influence.x,
          influence.y,
          0,
          influence.x,
          influence.y,
          Math.max(influence.radiusX, influence.radiusY) * 1.12,
        );
        backdrop.addColorStop(0, `rgba(198, 255, 247, ${(0.006 + (backgroundPulse * 0.006)) * influence.weight})`);
        backdrop.addColorStop(0.42, `rgba(45, 212, 191, ${0.006 * influence.weight})`);
        backdrop.addColorStop(1, 'rgba(8, 15, 31, 0)');
        canvasContext.fillStyle = backdrop;
        canvasContext.fillRect(0, 0, currentState.width, currentState.height);
      }

      const activePulses = currentState.pulses.filter((pulse) => timestamp - pulse.startedAt < pulse.duration);
      currentState.pulses = activePulses;

      const pointer = currentState.pointer;
      const pointerAge = pointer ? timestamp - pointer.updatedAt : Number.POSITIVE_INFINITY;
      if (pointer && pointerAge > 900) {
        currentState.pointer = null;
      }

      for (const particle of currentState.particles) {
        let pulseEnergy = 0;
        let orbEnergy = 0;
        let orbGrowthEnergy = 0;
        let orbOffsetX = 0;
        let orbOffsetY = 0;
        let radialOffset = 0;
        let tangentialOffset = 0;
        const canvasCenterX = currentState.width / 2;
        const canvasCenterY = currentState.height / 2;
        const safeRadialDistance = particle.radialDistance || 1;
        const radialUnitX = (particle.centerX - canvasCenterX) / safeRadialDistance;
        const radialUnitY = (particle.centerY - canvasCenterY) / safeRadialDistance;
        const tangentialUnitX = -radialUnitY;
        const tangentialUnitY = radialUnitX;

        for (const pulse of activePulses) {
          const pulseAge = timestamp - pulse.startedAt;
          const pulseProgress = clampNumber(pulseAge / pulse.duration, 0, 1);
          const pulseFront = easeDashboardDotRipple(pulseProgress) * pulse.radius;
          const distanceToPulse = Math.hypot(particle.centerX - pulse.originX, particle.centerY - pulse.originY);
          const signedDistance = distanceToPulse - pulseFront;
          const bandEnergy = easeDashboardDotRipple(1 - clampNumber(Math.abs(signedDistance) / pulse.width, 0, 1));
          const echoEnergy = easeDashboardDotRipple(1 - clampNumber(Math.abs(signedDistance + (pulse.width * 0.68)) / (pulse.width * 1.16), 0, 1));
          const angularPattern = clampNumber(
            0.78
              + (Math.sin((particle.angle * 5.2) + particle.edgePhase + (timestamp * 0.00046)) * 0.13)
              + (Math.cos((particle.angle * 8.4) - (timestamp * 0.00038) + particle.phase) * 0.09),
            0.52,
            1,
          );
          const pulseFade = Math.pow(1 - pulseProgress, 0.38);
          const ringEnergy = ((bandEnergy * 0.92) + (echoEnergy * 0.26)) * pulse.strength * pulseFade * angularPattern;
          const direction = signedDistance >= 0 ? 1 : -1;

          pulseEnergy = Math.max(pulseEnergy, ringEnergy);
          radialOffset += direction * ringEnergy * (1.18 + (particle.edgePull * 3.35));
          tangentialOffset += Math.sin((particle.angle * 6.5) + (timestamp * 0.0015) + particle.edgePhase) * ringEnergy * particle.edgePull * 1.08;
        }

        if (orb) {
          for (const influence of influencePoints) {
            if (influence.weight <= 0.02) continue;

            const deltaX = particle.centerX - influence.x;
            const deltaY = particle.centerY - influence.y;
            const influenceDistance = Math.hypot(deltaX, deltaY);
            const safeInfluenceDistance = influenceDistance || 1;
            const influenceUnitX = deltaX / safeInfluenceDistance;
            const influenceUnitY = deltaY / safeInfluenceDistance;
            const rotationCos = Math.cos(influence.rotation);
            const rotationSin = Math.sin(influence.rotation);
            const localX = ((deltaX * rotationCos) + (deltaY * rotationSin)) / Math.max(1, influence.radiusX);
            const localY = ((-deltaX * rotationSin) + (deltaY * rotationCos)) / Math.max(1, influence.radiusY);
            const normalizedInfluenceDistance = Math.hypot(localX, localY);
            const influenceFalloff = easeDashboardDotRipple(1 - clampNumber(normalizedInfluenceDistance, 0, 1));
            const influenceCore = easeDashboardDotRipple(1 - clampNumber(normalizedInfluenceDistance / 0.58, 0, 1));
            const influenceShoulder = easeDashboardDotRipple(1 - clampNumber(Math.abs(normalizedInfluenceDistance - 0.7) / 0.54, 0, 1));
            const organicPattern = clampNumber(
              0.88
                + (Math.sin((particle.phase * 1.22) + (timestamp * 0.00032) + orb.seed + (influence.x * 0.0012)) * 0.09)
                + (Math.cos((particle.angle * 2.6) - (timestamp * 0.00028) + particle.edgePhase + (influence.y * 0.001)) * 0.065),
              0.72,
              1.06,
            );
            const localFieldEnergy = ((influenceFalloff * 0.6) + (influenceShoulder * 0.25))
              * influence.weight
              * organicPattern
              * (0.98 + (orbVelocityEnergy * 0.08));
            const localGrowthEnergy = ((influenceCore * 0.68) + (influenceFalloff * 0.24) + (influenceShoulder * 0.15))
              * influence.weight
              * organicPattern
              * influence.growth;
            const localEnergy = localFieldEnergy + localGrowthEnergy;
            const localSwirl = Math.sin(
              (particle.angle * 2.4)
                + (timestamp * 0.00042)
                + particle.phase
                + orb.seed
                + (influence.weight * 1.2),
            ) * influence.swirl;

            orbEnergy += localEnergy;
            orbGrowthEnergy += localGrowthEnergy;
            orbOffsetX += (influenceUnitX * localGrowthEnergy * (0.95 + (particle.edgePull * 0.24)) * influence.push)
              + (-influenceUnitY * localSwirl * localGrowthEnergy * 0.24)
              + (orbDirectionX * localFieldEnergy * orbVelocityEnergy * 0.22 * influence.push);
            orbOffsetY += (influenceUnitY * localGrowthEnergy * (0.95 + (particle.edgePull * 0.24)) * influence.push)
              + (influenceUnitX * localSwirl * localGrowthEnergy * 0.24)
              + (orbDirectionY * localFieldEnergy * orbVelocityEnergy * 0.22 * influence.push);
          }

          orbEnergy = clampNumber(orbEnergy, 0, 0.96);
          orbGrowthEnergy = clampNumber(orbGrowthEnergy, 0, 0.9);
        }

        let pointerEnergy = 0;
        if (pointer && pointerAge <= 900) {
          const pointerFade = 1 - clampNumber(pointerAge / 900, 0, 1);
          const pointerDistance = Math.hypot(particle.centerX - pointer.pointerX, particle.centerY - pointer.pointerY);
          pointerEnergy = easeDashboardDotRipple(1 - clampNumber(pointerDistance / 150, 0, 1)) * pointerFade * 0.18;
        }

        const edgeBreath = currentState.reducedMotion
          ? 0
          : ((Math.sin((particle.distanceNorm * 13.4) - (timestamp * 0.00122) + (particle.phase * 0.28)) + 1) / 2) * particle.edgePull;
        const shimmer = currentState.reducedMotion
          ? 0.012
          : ((Math.sin((timestamp * 0.00096) + particle.phase) + 1) / 2) * 0.026;
        const brightEnergy = clampNumber(orbEnergy + pulseEnergy + pointerEnergy, 0, 1);
        const particleSize = particle.baseSize + (orbGrowthEnergy * 1.62) + (orbEnergy * 0.34) + (pulseEnergy * 0.5) + (pointerEnergy * 0.4) + (edgeBreath * 0.16) + shimmer;
        const particleAlpha = clampNumber(particle.baseAlpha + (orbEnergy * 0.34) + (orbGrowthEnergy * 0.12) + (pulseEnergy * 0.13) + (pointerEnergy * 0.07) + (edgeBreath * 0.034) + (shimmer * 0.3), 0, 0.62);
        const particleX = particle.centerX + orbOffsetX + (radialUnitX * (radialOffset + (edgeBreath * particle.edgePull * 0.46))) + (tangentialUnitX * tangentialOffset);
        const particleY = particle.centerY + orbOffsetY + (radialUnitY * (radialOffset + (edgeBreath * particle.edgePull * 0.46))) + (tangentialUnitY * tangentialOffset);

        if (brightEnergy > 0.22) {
          canvasContext.beginPath();
          canvasContext.fillStyle = `rgba(205, 230, 238, ${brightEnergy * 0.018})`;
          canvasContext.arc(particleX, particleY, particleSize * 1.68, 0, fullCircle);
          canvasContext.fill();
        }

        const redChannel = Math.round(154 + (brightEnergy * 58) + (particle.centerPull * 6));
        const greenChannel = Math.round(168 + (brightEnergy * 60) + (particle.centerPull * 8));
        const blueChannel = Math.round(184 + (brightEnergy * 46) + (particle.centerPull * 10));

        canvasContext.beginPath();
        canvasContext.fillStyle = `rgba(${redChannel}, ${greenChannel}, ${blueChannel}, ${particleAlpha})`;
        canvasContext.arc(particleX, particleY, particleSize, 0, fullCircle);
        canvasContext.fill();
      }

      if (!currentState.reducedMotion) {
        animationFrameRef.current = window.requestAnimationFrame(draw);
      }
    }

    function ensureLoop() {
      if (animationFrameRef.current === null) {
        animationFrameRef.current = window.requestAnimationFrame(draw);
      }
    }

    function spawnPulse(originX: number, originY: number, strength = 0.65, duration = 2200) {
      addPulse(originX, originY, strength, duration);
      ensureLoop();
    }

    function updatePointer(event: PointerEvent) {
      if (!activeRef.current) return;

      const hostRect = hostElement.getBoundingClientRect();
      stateRef.current.pointer = {
        pointerX: event.clientX - hostRect.left,
        pointerY: event.clientY - hostRect.top,
        updatedAt: performance.now(),
      };
      ensureLoop();
    }

    function handlePointerDown(event: PointerEvent) {
      if (!activeRef.current) return;

      updatePointer(event);
      const currentState = stateRef.current;
      const hostRect = hostElement.getBoundingClientRect();
      const targetX = event.clientX - hostRect.left;
      const targetY = event.clientY - hostRect.top;
      retargetOrb(targetX, targetY, performance.now(), 2600);
      spawnPulse(targetX, targetY, 0.28, 1500);
    }

    function handleResize() {
      syncCanvasSize();
      if (activeRef.current) ensureLoop();
    }

    function handleMotionPreferenceChange() {
      stateRef.current.reducedMotion = motionQuery.matches;
      if (activeRef.current) ensureLoop();
    }

    syncCanvasSize();
    ensureLoopRef.current = ensureLoop;
    spawnPulseRef.current = spawnPulse;

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(handleResize)
      : null;

    resizeObserver?.observe(hostElement);
    window.addEventListener('resize', handleResize);
    hostElement.addEventListener('pointermove', updatePointer, { passive: true });
    hostElement.addEventListener('pointerdown', handlePointerDown, { passive: true });
    motionQuery.addEventListener('change', handleMotionPreferenceChange);

    return () => {
      ensureLoopRef.current = null;
      spawnPulseRef.current = null;
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
      hostElement.removeEventListener('pointermove', updatePointer);
      hostElement.removeEventListener('pointerdown', handlePointerDown);
      motionQuery.removeEventListener('change', handleMotionPreferenceChange);

      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    activeRef.current = active;
    const currentState = stateRef.current;

    if (active) {
      currentState.orb = null;
      currentState.pulses = [];
      ensureLoopRef.current?.();
      return;
    }

    currentState.pulses = [];
    currentState.pointer = null;
    currentState.orb = null;

    if (typeof window !== 'undefined' && animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const canvas = canvasRef.current;
    const renderingContext = canvas?.getContext('2d');
    if (renderingContext) {
      renderingContext.clearRect(0, 0, currentState.width, currentState.height);
    }
  }, [active]);

  return <canvas ref={canvasRef} aria-hidden="true" className={`dashboard-dot-ripple-field ${active ? 'is-active' : ''}`} />;
}

function DashboardAnalyzingFrame({
  children,
  isAnalyzing,
  className = '',
  contentClassName = '',
  cornerRadius = 20,
  bleed = 10,
}: {
  children: React.ReactNode;
  isAnalyzing: boolean;
  className?: string;
  contentClassName?: string;
  cornerRadius?: number;
  bleed?: number;
}) {
  const frameId = useId();
  const gradientId = useMemo(
    () => `dashboard-analyzing-gradient-${frameId.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    [frameId],
  );
  const shellRef = useRef<HTMLDivElement | null>(null);
  const ambientPathRef = useRef<SVGPathElement | null>(null);
  const trailOuterPathRef = useRef<SVGPathElement | null>(null);
  const trailMidPathRef = useRef<SVGPathElement | null>(null);
  const runnerPathRef = useRef<SVGPathElement | null>(null);
  const leadPathRef = useRef<SVGPathElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const geometryRef = useRef({
    pathLength: 0,
    trailOuterLength: 0,
    trailMidLength: 0,
    runnerLength: 0,
    leadLength: 0,
  });
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const shell = shellRef.current;
    if (!shell) return;

    const measure = () => {
      const rect = shell.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.ceil(rect.width));
      const nextHeight = Math.max(1, Math.ceil(rect.height));
      setFrameSize((previous) => (
        previous.width === nextWidth && previous.height === nextHeight
          ? previous
          : { width: nextWidth, height: nextHeight }
      ));

      const d = buildAnalyzingFramePath(nextWidth, nextHeight, cornerRadius - 0.5);
      const ambientPath = ambientPathRef.current;
      const trailOuterPath = trailOuterPathRef.current;
      const trailMidPath = trailMidPathRef.current;
      const runnerPath = runnerPathRef.current;
      const leadPath = leadPathRef.current;

      [ambientPath, trailOuterPath, trailMidPath, runnerPath, leadPath].forEach((pathNode) => {
        pathNode?.setAttribute('d', d);
      });

      if (!ambientPath || !trailOuterPath || !trailMidPath || !runnerPath || !leadPath) return;

      const pathLength = ambientPath.getTotalLength();
      const trailOuterLength = Math.max(pathLength * 0.22, 80);
      const trailMidLength = Math.max(Math.min(trailOuterLength * 0.62, trailOuterLength - 12), 52);
      const runnerLength = Math.max(Math.min(trailOuterLength * 0.36, trailMidLength - 10), 28);
      const leadLength = Math.max(Math.min(runnerLength * 0.24, 18), 9);

      trailOuterPath.style.strokeDasharray = `${trailOuterLength} ${Math.max(pathLength - trailOuterLength, 1)}`;
      trailMidPath.style.strokeDasharray = `${trailMidLength} ${Math.max(pathLength - trailMidLength, 1)}`;
      runnerPath.style.strokeDasharray = `${runnerLength} ${Math.max(pathLength - runnerLength, 1)}`;
      leadPath.style.strokeDasharray = `${leadLength} ${Math.max(pathLength - leadLength, 1)}`;

      geometryRef.current = {
        pathLength,
        trailOuterLength,
        trailMidLength,
        runnerLength,
        leadLength,
      };
    };

    measure();

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => measure())
      : null;

    resizeObserver?.observe(shell);
    window.addEventListener('resize', measure);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [bleed, cornerRadius]);

  useEffect(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    const runnerPath = runnerPathRef.current;
    const leadPath = leadPathRef.current;
    const trailOuterPath = trailOuterPathRef.current;
    const trailMidPath = trailMidPathRef.current;

    if (!isAnalyzing || !trailOuterPath || !trailMidPath || !runnerPath || !leadPath) {
      if (trailOuterPath) trailOuterPath.style.strokeDashoffset = '0';
      if (trailMidPath) trailMidPath.style.strokeDashoffset = '0';
      if (runnerPath) runnerPath.style.strokeDashoffset = '0';
      if (leadPath) leadPath.style.strokeDashoffset = '0';
      return;
    }

    const startTime = performance.now();
    const loopDuration = 4000;

    const tick = (now: number) => {
      const {
        pathLength,
        trailOuterLength,
        trailMidLength,
        runnerLength,
        leadLength,
      } = geometryRef.current;

      if (pathLength > 0) {
        const progress = ((now - startTime) % loopDuration) / loopDuration;
        const offset = -progress * pathLength;
        trailOuterPath.style.strokeDashoffset = `${offset}`;
        trailMidPath.style.strokeDashoffset = `${offset - trailOuterLength + trailMidLength * 0.98}`;
        runnerPath.style.strokeDashoffset = `${offset - trailOuterLength + runnerLength * 0.96}`;
        leadPath.style.strokeDashoffset = `${offset - trailOuterLength + leadLength * 0.9}`;
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isAnalyzing]);

  return (
    <div
      ref={shellRef}
      className={`dashboard-analyzing-shell ${isAnalyzing ? 'is-analyzing' : ''} ${className}`}
      style={{
        ['--dashboard-analyzing-corner-radius' as string]: `${cornerRadius}px`,
        ['--dashboard-analyzing-bleed' as string]: `${bleed}px`,
      }}
    >
      <div className={`dashboard-analyzing-content ${contentClassName}`}>{children}</div>
      <svg
        aria-hidden
        className="dashboard-analyzing-frame"
        viewBox={`0 0 ${frameSize.width} ${frameSize.height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#06b6d4" />
            <stop offset="35%" stopColor="#22c55e" />
            <stop offset="68%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
        <path ref={ambientPathRef} className="dashboard-analyzing-path-ambient" stroke={`url(#${gradientId})`} />
        <path ref={trailOuterPathRef} className="dashboard-analyzing-path-trail-outer" stroke={`url(#${gradientId})`} />
        <path ref={trailMidPathRef} className="dashboard-analyzing-path-trail-mid" stroke={`url(#${gradientId})`} />
        <path ref={runnerPathRef} className="dashboard-analyzing-path-runner" stroke={`url(#${gradientId})`} />
        <path ref={leadPathRef} className="dashboard-analyzing-path-lead" />
      </svg>
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const greetingDomId = useId();
  const bookkeeping = useFirestoreBookkeeping();
  const bookkeepingRange = useMemo(() => getDefaultBookkeepingDateRange(), []);
  const ownerId = user?.id;
  const firstName = useMemo(() => extractFirstName(user?.name, user?.email), [user?.email, user?.name]);
  const greetingIdBase = useMemo(
    () => `dashboard-greeting-${greetingDomId.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
    [greetingDomId],
  );
  const greetingLabel = useMemo(() => `${GREETING_PREFIX}${firstName}`, [firstName]);
  const dashboardPromptPlaceholder = useMemo(() => {
    const hour = new Date().getHours();

    if (hour < 12) return DASHBOARD_PROMPT_PLACEHOLDERS[0];
    if (hour < 18) return DASHBOARD_PROMPT_PLACEHOLDERS[1];
    return DASHBOARD_PROMPT_PLACEHOLDERS[2];
  }, []);
  const greetingAnimation = useMemo(() => buildGreetingAnimationLayout(greetingLabel), [greetingLabel]);
  const greetingGradientId = useMemo(
    () => `dashboard-greeting-fill-${greetingIdBase}`,
    [greetingIdBase],
  );
  const greetingSweepGradientId = useMemo(
    () => `dashboard-greeting-sweep-${greetingIdBase}`,
    [greetingIdBase],
  );
  const greetingViewBoxWidth = greetingAnimation.totalWidth;

  const { devices, alerts, readings } = useShellyFirestore(ownerId);

  const [portfolioProperties, setPortfolioProperties] = useState<DashboardProperty[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>(PORTFOLIO_SCOPE_ID);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentResponseText, setAgentResponseText] = useState('');
  const [agentResponsePrompt, setAgentResponsePrompt] = useState('');
  const [hasSubmittedDashboardPrompt, setHasSubmittedDashboardPrompt] = useState(false);
  const [assistantMemoriesOpen, setAssistantMemoriesOpen] = useState(false);
  const [activeSurfaceIds, setActiveSurfaceIds] = useState<DashboardSurfaceId[]>([]);
  const [focusedSurfaceId, setFocusedSurfaceId] = useState<DashboardSurfaceId | null>(null);
  const [surfaceLayouts, setSurfaceLayouts] = useState<Record<DashboardSurfaceId, DashboardSurfaceLayoutState>>(() => ({ ...DEFAULT_SURFACE_LAYOUTS }));
  const [surfacePropertyTargets, setSurfacePropertyTargets] = useState<Partial<Record<DashboardSurfaceId, string[]>>>({});
  const [dashboardAnnotations, setDashboardAnnotations] = useState<DashboardAnnotation[]>([]);
  const [dashboardSegmentHighlights, setDashboardSegmentHighlights] = useState<DashboardSegmentHighlight[]>([]);
  const [highlightedSurfaceId, setHighlightedSurfaceId] = useState<DashboardSurfaceId | null>(null);
  const [portfolioAssets, setPortfolioAssets] = useState<PortfolioAssets>({ realEstate: [], stocks: [], cash: [], bonds: [], alternatives: [] });
  const [portfolioLiabilities, setPortfolioLiabilities] = useState<PortfolioLiabilities>([]);
  const [portfolioSnapshots, setPortfolioSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [portfolioYtdChange, setPortfolioYtdChange] = useState(0);
  const [portfolioLoading, setPortfolioLoading] = useState(true);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [portfolioStockBasicInfo, setPortfolioStockBasicInfo] = useState<DashboardStockBasicInfoMap>({});
  const loginSplashStartedAt = useRef<number | null>(null);
  const [loginSplashVisible, setLoginSplashVisible] = useState(() => {
    const shouldShow = shouldShowDashboardLoginSplash();

    if (shouldShow && typeof performance !== 'undefined') {
      loginSplashStartedAt.current = performance.now();
    }

    return shouldShow;
  });
  const [greetingAnimationActive, setGreetingAnimationActive] = useState(() => !shouldShowDashboardLoginSplash());
  const [greetingAnimationSettled, setGreetingAnimationSettled] = useState(false);
  const [dashboardBodyVisible, setDashboardBodyVisible] = useState(false);
  const [dashboardBodyReady, setDashboardBodyReady] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const surfaceRefs = useRef<Partial<Record<DashboardSurfaceId, HTMLDivElement | null>>>({});
  const propertyHydrationAttempts = useRef(new Set<string>());
  const lastRealtimeDashboardPromptRef = useRef('');
  const lastRealtimeDashboardRequestIdRef = useRef('');
  const lastDashboardControlRequestIdRef = useRef('');
  const localDashboardResponseOverrideRef = useRef<{ requestId: string; text: string } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      startTransition(() => {
        setDashboardBodyVisible(true);
        setDashboardBodyReady(true);
      });
      return;
    }

    let rafId = 0;
    let settleRafId = 0;
    let timeoutId = 0;

    rafId = window.requestAnimationFrame(() => {
      settleRafId = window.requestAnimationFrame(() => {
        startTransition(() => {
          setDashboardBodyVisible(true);
        });

        timeoutId = window.setTimeout(() => {
          startTransition(() => {
            setDashboardBodyReady(true);
          });
        }, DASHBOARD_BODY_START_DELAY_MS);
      });
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      window.cancelAnimationFrame(settleRafId);
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (!loginSplashVisible || typeof window === 'undefined') {
      return;
    }

    window.sessionStorage.removeItem(DASHBOARD_LOGIN_SPLASH_STORAGE_KEY);
  }, [loginSplashVisible]);

  useEffect(() => {
    if (!loginSplashVisible || typeof window === 'undefined') {
      return;
    }

    const elapsedMs =
      loginSplashStartedAt.current !== null && typeof performance !== 'undefined'
        ? performance.now() - loginSplashStartedAt.current
        : 0;
    const remainingMs = Math.max(0, DASHBOARD_LOGIN_SPLASH_MIN_MS - elapsedMs);

    const timeoutId = window.setTimeout(() => {
      setGreetingAnimationActive(true);
      setLoginSplashVisible(false);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loginSplashVisible]);

  useEffect(() => {
    if (!greetingAnimationActive || typeof window === 'undefined') {
      return;
    }

    setGreetingAnimationSettled(false);

    const timeoutId = window.setTimeout(() => {
      setGreetingAnimationSettled(true);
    }, greetingAnimation.totalDurationMs + 80);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [greetingAnimation.totalDurationMs, greetingAnimationActive]);

  useEffect(() => {
    let isActive = true;

    if (!dashboardBodyReady) {
      return () => {
        isActive = false;
      };
    }

    if (!ownerId) {
      setPortfolioProperties([]);
      return () => {
        isActive = false;
      };
    }

    const loadPortfolioProperties = async () => {
      try {
        const ownerProperties = await ownerPropertiesClient.listDetailed(ownerId, { withTenants: true });

        if (!isActive) return;

        const allProperties: Array<{
          id?: string;
          address?: string;
          property_data?: PropertyDashboard | null;
          propertyData?: PropertyDashboard | null;
          financial_data?: DashboardPropertyFinancialData | null;
          financials?: DashboardPropertyFinancialData | null;
          tenantCount?: number;
          tenants?: Array<Record<string, unknown>>;
          created_at?: string;
          createdAt?: string;
          updated_at?: string;
          updatedAt?: string;
        }> = ownerProperties.map((property: any) => ({
          id: property.id,
          address: property.address,
          property_data: property.propertyData || null,
          financial_data: property.financials || null,
          tenantCount: typeof property.tenantCount === 'number'
            ? property.tenantCount
            : Array.isArray(property.tenants)
              ? property.tenants.length
              : 0,
          created_at: property.createdAt,
          updated_at: property.updatedAt,
        }));

        const deduped = new Map<string, DashboardProperty>();
        allProperties.forEach((property) => {
          const address = String(property.address || '').trim();
          if (!address) return;
          const key = normalizeDashboardPropertyAddress(address);
          deduped.set(key, {
            id: String(property.id || key),
            address,
            data: property.property_data ?? property.propertyData ?? null,
            financialData: property.financial_data ?? property.financials ?? null,
            tenantCount: property.tenantCount,
            savedAt: property.created_at ?? property.createdAt,
            updatedAt: property.updated_at ?? property.updatedAt,
            source: 'portfolio',
          });
        });

        setPortfolioProperties(Array.from(deduped.values()));
      } catch (error) {
        if (!isActive) return;
        console.error('[Dashboard] Failed to load Firestore portfolio properties:', error);
        setPortfolioProperties([]);
      }
    };

    void loadPortfolioProperties();

    return () => {
      isActive = false;
    };
  }, [dashboardBodyReady, ownerId]);

  useEffect(() => {
    let isActive = true;

    const loadStockInfo = async () => {
      const tickers = Array.from(new Set(
        [...portfolioAssets.stocks, ...portfolioAssets.bonds]
          .map((asset) => asset.ticker)
          .filter((ticker): ticker is string => Boolean(ticker)),
      ));

      if (tickers.length === 0) {
        setPortfolioStockBasicInfo({});
        return;
      }

      const nextInfo: DashboardStockBasicInfoMap = {};

      for (const ticker of tickers) {
        try {
          const info = await getStockBasicInfo(ticker);
          if (info) {
            nextInfo[ticker] = {
              name: info.name,
              logoUrl: info.logoUrl,
              change: info.change,
              changePercent: info.changePercent,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Error loading dashboard stock info for ${ticker}:`, error);
        }
      }

      if (isActive) {
        setPortfolioStockBasicInfo(nextInfo);
      }
    };

    void loadStockInfo();

    return () => {
      isActive = false;
    };
  }, [portfolioAssets.bonds, portfolioAssets.stocks]);

  const availableProperties = portfolioProperties;

  const syncDashboardPropertyTargets = (prompt: string, surfaceIds: DashboardSurfaceId[]) => {
    if (!prompt.trim() || availableProperties.length === 0) {
      return;
    }

    const analyticsSurfaceIds = surfaceIds.filter(isPropertyAnalyticsSurfaceId);
    const matchedProperties = findDashboardPromptPropertyMatches(prompt, availableProperties);
    const matchedPropertyIds = matchedProperties.map((property) => property.id);

    if (PORTFOLIO_SCOPE_PROMPT_PATTERN.test(prompt)) {
      startTransition(() => {
        setSelectedPropertyId(PORTFOLIO_SCOPE_ID);
        if (analyticsSurfaceIds.length > 0) {
          setSurfacePropertyTargets((current) => {
            const next = { ...current };
            analyticsSurfaceIds.forEach((surfaceId) => {
              delete next[surfaceId];
            });
            return next;
          });
        }
      });
      return;
    }

    if (matchedPropertyIds.length === 0) {
      return;
    }

    const comparisonRequested = PROPERTY_COMPARISON_PROMPT_PATTERN.test(prompt) || matchedPropertyIds.length > 1;
    const targetPropertyIds = comparisonRequested
      ? matchedPropertyIds.slice(0, DASHBOARD_PROPERTY_COMPARISON_MAX)
      : [matchedPropertyIds[0]];

    startTransition(() => {
      setSelectedPropertyId(matchedPropertyIds[0]);

      if (analyticsSurfaceIds.length > 0) {
        setSurfacePropertyTargets((current) => {
          const next = { ...current };
          analyticsSurfaceIds.forEach((surfaceId) => {
            next[surfaceId] = targetPropertyIds;
          });
          return next;
        });
      }
    });
  };
  const propertyManagementFinanceActions = useMemo(() => getWorkflowActionsByIds(PROPERTY_MANAGEMENT_FINANCE_ACTION_IDS), []);
  const tenantPipelineActions = useMemo(() => getWorkflowActionsByIds(TENANT_PIPELINE_ACTION_IDS), []);
  const leasingPaymentsActions = useMemo(() => getWorkflowActionsByIds(LEASING_PAYMENTS_ACTION_IDS), []);
  const maintenanceCommandActions = useMemo(() => getWorkflowActionsByIds(MAINTENANCE_COMMAND_ACTION_IDS), []);

  useEffect(() => {
    if (availableProperties.length === 0) {
      setSelectedPropertyId(PORTFOLIO_SCOPE_ID);
      return;
    }

    if (selectedPropertyId === PORTFOLIO_SCOPE_ID) return;
    if (!availableProperties.some((property) => property.id === selectedPropertyId)) {
      setSelectedPropertyId(PORTFOLIO_SCOPE_ID);
    }
  }, [availableProperties, selectedPropertyId]);

  useEffect(() => {
    if (!dashboardBodyReady) return;
    if (!bookkeeping.user || !bookkeeping.isInitialized) return;
    bookkeeping.fetchData(bookkeepingRange);
  }, [bookkeeping, bookkeepingRange, dashboardBodyReady]);

  useEffect(() => {
    if (!dashboardBodyVisible) return;
    if (!highlightedSurfaceId) return;
    surfaceRefs.current[highlightedSurfaceId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [dashboardBodyVisible, highlightedSurfaceId]);

  useEffect(() => {
    let isActive = true;

    if (!dashboardBodyReady) {
      return () => {
        isActive = false;
      };
    }

    if (!ownerId) {
      setPortfolioAssets({ realEstate: [], stocks: [], cash: [], bonds: [], alternatives: [] });
      setPortfolioLiabilities([]);
      setPortfolioSnapshots([]);
      setPortfolioYtdChange(0);
      setPortfolioLoading(false);
      setPortfolioError('Sign in to render live property data.');
      return () => {
        isActive = false;
      };
    }

    const loadPortfolioData = async () => {
      setPortfolioLoading(true);
      setPortfolioError(null);

      try {
        const [nextAssets, nextLiabilities] = await Promise.all([
          getAssets(ownerId),
          getLiabilities(ownerId),
        ]);

        const monthRange = getDateRangeForPeriod(NET_WORTH_PERIOD);
        const ytdRange = getDateRangeForPeriod('YTD');
        const [monthSnapshots, ytdSnapshots] = await Promise.all([
          getPortfolioSnapshots(ownerId, monthRange.startDate, monthRange.endDate),
          getPortfolioSnapshots(ownerId, ytdRange.startDate, ytdRange.endDate),
        ]);

        if (!isActive) return;

        const totalAssets = calculateTotalAssets(nextAssets);
        const totalLiabilities = calculateTotalLiabilities(nextLiabilities);
        const currentRealEstateValue = (nextAssets.realEstate || []).reduce((sum, asset) => sum + (asset.value || 0), 0);
        const nextYtdChange = buildRealEstateYtdChange(ytdSnapshots, currentRealEstateValue);

        setPortfolioAssets(nextAssets);
        setPortfolioLiabilities(nextLiabilities);
        setPortfolioSnapshots(monthSnapshots);
        setPortfolioYtdChange(nextYtdChange);
      } catch (error) {
        if (!isActive) return;
        setPortfolioError(error instanceof Error ? error.message : 'Unable to load live property data.');
      } finally {
        if (isActive) {
          setPortfolioLoading(false);
        }
      }
    };

    void loadPortfolioData();

    return () => {
      isActive = false;
    };
  }, [dashboardBodyReady, ownerId]);

  const featuredProperty = useMemo(() => {
    if (selectedPropertyId !== PORTFOLIO_SCOPE_ID) {
      return availableProperties.find((property) => property.id === selectedPropertyId) || null;
    }
    return availableProperties[0] || null;
  }, [availableProperties, selectedPropertyId]);

  useEffect(() => {
    let isActive = true;

    if (!dashboardBodyReady) {
      return () => {
        isActive = false;
      };
    }

    if (!featuredProperty || featuredProperty.data || !featuredProperty.address) {
      return () => {
        isActive = false;
      };
    }

    if (propertyHydrationAttempts.current.has(featuredProperty.id)) {
      return () => {
        isActive = false;
      };
    }

    propertyHydrationAttempts.current.add(featuredProperty.id);

    const hydrateProperty = async () => {
      try {
        const response = await fetch(buildDashboardApiUrl('/api/attom/dashboard', { address: featuredProperty.address }));
        const json = await response.json();
        if (!isActive || !json.ok) return;

        const propertyData = json.data || json;
        setPortfolioProperties((currentProperties) => currentProperties.map((property) => (
          property.id === featuredProperty.id
            ? { ...property, data: propertyData }
            : property
        )));
      } catch (error) {
        if (!isActive) return;
        console.warn('[Dashboard] ATTOM property hydration failed:', error);
      }
    };

    void hydrateProperty();

    return () => {
      isActive = false;
    };
  }, [dashboardBodyReady, featuredProperty]);

  const isPortfolioScope = selectedPropertyId === PORTFOLIO_SCOPE_ID;
  const usingPortfolioFallback = selectedPropertyId === PORTFOLIO_SCOPE_ID && featuredProperty !== null;

  const selectedPropertyKeys = useMemo(() => {
    if (selectedPropertyId === PORTFOLIO_SCOPE_ID || !featuredProperty) return null;

    return new Set(
      [selectedPropertyId, featuredProperty.address, featuredProperty.data?.summary.address]
        .filter((value): value is string => Boolean(value)),
    );
  }, [featuredProperty, selectedPropertyId]);

  const filteredTransactions = useMemo(() => {
    if (!selectedPropertyKeys) {
      return bookkeeping.transactions;
    }
    return bookkeeping.transactions.filter((transaction) => transaction.propertyId && selectedPropertyKeys.has(transaction.propertyId));
  }, [bookkeeping.transactions, selectedPropertyKeys]);

  const reserveSummary = useMemo(() => {
    if (selectedPropertyId === PORTFOLIO_SCOPE_ID && bookkeeping.summary) {
      return {
        totalIncome: bookkeeping.summary.totalIncome,
        totalExpenses: bookkeeping.summary.totalExpenses,
        netCashFlow: bookkeeping.summary.netIncome,
        margin: bookkeeping.summary.totalIncome > 0
          ? Number(((bookkeeping.summary.netIncome / bookkeeping.summary.totalIncome) * 100).toFixed(1))
          : 0,
      };
    }

    return buildSummaryFromTransactions(filteredTransactions);
  }, [bookkeeping.summary, filteredTransactions, selectedPropertyId]);

  const reserveCategories = useMemo(() => buildCategoryBreakdown(filteredTransactions), [filteredTransactions]);

  const dashboardActionItems = useDashboardActionItems({
    ownerId,
    transactions: filteredTransactions,
    enabled: dashboardBodyReady,
  });

  const filteredDevices = useMemo(() => {
    if (!selectedPropertyKeys) return devices;
    return devices.filter((device) => device.propertyId && selectedPropertyKeys.has(device.propertyId));
  }, [devices, selectedPropertyKeys]);

  const filteredAlerts = useMemo(() => {
    if (!selectedPropertyKeys) return alerts;
    return alerts.filter((alert) => alert.propertyId && selectedPropertyKeys.has(alert.propertyId));
  }, [alerts, selectedPropertyKeys]);

  const constellationProperties = useMemo(
    () => buildDashboardConstellationProperties(availableProperties, alerts, devices),
    [availableProperties, alerts, devices],
  );

  const filteredDeviceIds = useMemo(() => new Set(filteredDevices.map((device) => device.deviceId)), [filteredDevices]);

  const filteredReadings = useMemo(() => {
    if (selectedPropertyId === PORTFOLIO_SCOPE_ID) return readings;
    return readings.filter((reading) => filteredDeviceIds.has(reading.deviceId));
  }, [filteredDeviceIds, readings, selectedPropertyId]);

  const canonicalPortfolioProjection = useMemo(
    () => buildCanonicalPortfolioProjection({
      ownerProperties: buildCanonicalOwnerPropertyInputs(portfolioProperties),
      manualRealEstateAssets: portfolioAssets.realEstate as any,
      manualLiabilities: portfolioLiabilities as any,
    }),
    [portfolioAssets.realEstate, portfolioLiabilities, portfolioProperties],
  );
  const canonicalOwnerProperties = canonicalPortfolioProjection.ownerProperties;
  const allocationRealEstateAssets = canonicalPortfolioProjection.realEstateAssets;
  const allocationLiabilities = canonicalPortfolioProjection.liabilities;
  const allocationAssets = useMemo(
    () => ({ ...portfolioAssets, realEstate: allocationRealEstateAssets }),
    [allocationRealEstateAssets, portfolioAssets],
  );
  const allocationTotalAssetValue = useMemo(() => calculateTotalAssets(allocationAssets), [allocationAssets]);
  const allocationTotalLiabilityValue = useMemo(() => calculateTotalLiabilities(allocationLiabilities), [allocationLiabilities]);
  const portfolioAllocationViewMode = useMemo<'assets' | 'equity'>(
    () => allocationTotalLiabilityValue > 0 ? 'equity' : 'assets',
    [allocationTotalLiabilityValue],
  );
  const portfolioAllocationTotalValue = useMemo(
    () => portfolioAllocationViewMode === 'equity'
      ? allocationTotalAssetValue - allocationTotalLiabilityValue
      : allocationTotalAssetValue,
    [allocationTotalAssetValue, allocationTotalLiabilityValue, portfolioAllocationViewMode],
  );
  const totalAssetValue = allocationTotalAssetValue;
  const totalLiabilityValue = allocationTotalLiabilityValue;
  const totalRealEstateValue = useMemo(
    () => allocationRealEstateAssets.reduce((sum, asset) => sum + Number(asset.value || 0), 0),
    [allocationRealEstateAssets],
  );
  const portfolioAllocation = useMemo(
    () => buildPortfolioAllocation(portfolioAssets, allocationRealEstateAssets, allocationLiabilities, portfolioAllocationViewMode),
    [allocationLiabilities, allocationRealEstateAssets, portfolioAllocationViewMode, portfolioAssets],
  );
  const portfolioAllocationClassDetails = useMemo(
    () => buildPortfolioAllocationClassDetails(
      portfolioAssets,
      canonicalOwnerProperties,
      allocationRealEstateAssets,
      allocationLiabilities,
      portfolioAllocationTotalValue,
      portfolioAllocationViewMode,
      portfolioStockBasicInfo,
    ),
    [
      allocationLiabilities,
      allocationRealEstateAssets,
      canonicalOwnerProperties,
      portfolioAllocationTotalValue,
      portfolioAllocationViewMode,
      portfolioAssets,
      portfolioStockBasicInfo,
    ],
  );
  const bookkeepingTrend = useMemo(() => buildBookkeepingTrendSeries(filteredTransactions), [filteredTransactions]);
  const featuredWorkflowActions = useMemo(() => getFeaturedWorkflowActions(), []);
  const dashboardControlActions = useMemo(() => {
    const deduped = new Map<string, ControlAction>();

    [
      ...featuredWorkflowActions,
      ...propertyManagementFinanceActions,
      ...tenantPipelineActions,
      ...leasingPaymentsActions,
      ...maintenanceCommandActions,
    ].forEach((action) => {
      deduped.set(action.id, action);
    });

    return Array.from(deduped.values());
  }, [featuredWorkflowActions, leasingPaymentsActions, maintenanceCommandActions, propertyManagementFinanceActions, tenantPipelineActions]);
  const portfolioFinancialInputs = useMemo(
    () => derivePortfolioFinancialInputs(allocationAssets, allocationLiabilities, bookkeeping.summary, filteredTransactions),
    [allocationAssets, allocationLiabilities, bookkeeping.summary, filteredTransactions],
  );
  const portfolioAvmHistory = useMemo(
    () => buildPortfolioAvmHistorySeries(portfolioSnapshots, totalRealEstateValue, portfolioYtdChange),
    [portfolioSnapshots, portfolioYtdChange, totalRealEstateValue],
  );
  const portfolioTaxHistory = useMemo(
    () => buildPortfolioTaxHistorySeries(filteredTransactions, portfolioFinancialInputs?.taxAmount ?? 0),
    [filteredTransactions, portfolioFinancialInputs?.taxAmount],
  );
  const portfolioAnalytics = useMemo<PortfolioAnalyticsContext>(() => ({
    label: 'Portfolio-wide view',
    financialInputs: portfolioFinancialInputs,
    avmHistory: portfolioAvmHistory.series,
    avmHistoryMode: portfolioAvmHistory.modeled ? 'modeled' : 'historical',
    taxHistory: portfolioTaxHistory.series,
    taxHistoryMode: portfolioTaxHistory.modeled ? 'modeled' : 'historical',
  }), [portfolioAvmHistory.modeled, portfolioAvmHistory.series, portfolioFinancialInputs, portfolioTaxHistory.modeled, portfolioTaxHistory.series]);
  const propertyPortfolioOverview = useMemo(
    () => (portfolioProperties.length > 0
      ? buildPropertyPortfolioOverview(buildCanonicalOwnerPropertyInputs(portfolioProperties), 'combined')
      : null),
    [portfolioProperties],
  );
  const propertyBreakdown = useMemo(
    () => (propertyPortfolioOverview?.allocations ?? []).map((slice) => ({
      key: slice.id,
      label: slice.label,
      value: slice.value,
      percent: slice.percentage,
    })),
    [propertyPortfolioOverview],
  );
  const propertyValueTrendChange = useMemo(() => {
    const series = propertyPortfolioOverview?.valueTrendQuarterly ?? [];
    if (series.length < 2 || series[0].value <= 0) {
      return 0;
    }

    const latestValue = propertyPortfolioOverview?.summary.totalValue ?? series[series.length - 1].value;
    return ((latestValue - series[0].value) / series[0].value) * 100;
  }, [propertyPortfolioOverview]);

  const orderedSurfaceIds = useMemo(
    () => sortSurfaceIdsByLayout(activeSurfaceIds, surfaceLayouts),
    [activeSurfaceIds, surfaceLayouts],
  );
  const displayedSurfaceIds = useMemo(
    () => (focusedSurfaceId && orderedSurfaceIds.includes(focusedSurfaceId) ? [focusedSurfaceId] : orderedSurfaceIds),
    [focusedSurfaceId, orderedSurfaceIds],
  );
  const canvasAnnotations = useMemo(
    () => dashboardAnnotations.filter((annotation) => !annotation.surfaceId),
    [dashboardAnnotations],
  );

  const resolveAnalyticsSurfaceScopes = useCallback((surfaceId: DashboardSurfaceId): DashboardAnalyticsSurfaceScope[] => {
    if (!isPropertyAnalyticsSurfaceId(surfaceId)) {
      return [];
    }

    const targetedPropertyIds = surfacePropertyTargets[surfaceId] || [];
    const targetedProperties = targetedPropertyIds
      .map((propertyId) => availableProperties.find((property) => property.id === propertyId) || null)
      .filter((property): property is DashboardProperty => property !== null);

    if (targetedProperties.length > 0) {
      return targetedProperties.map((property) => ({
        key: `${surfaceId}-${property.id}`,
        property,
        isPortfolioScope: false,
        usingPortfolioFallback: false,
        label: property.data?.summary.address || property.address,
      }));
    }

    return [
      {
        key: `${surfaceId}-${isPortfolioScope ? PORTFOLIO_SCOPE_ID : featuredProperty?.id || 'default'}`,
        property: featuredProperty,
        isPortfolioScope,
        usingPortfolioFallback,
        label: getAnalyticsContextLabel(featuredProperty, usingPortfolioFallback, isPortfolioScope, portfolioAnalytics?.label || 'Portfolio-wide view'),
      },
    ];
  }, [availableProperties, featuredProperty, isPortfolioScope, portfolioAnalytics?.label, surfacePropertyTargets, usingPortfolioFallback]);

  const dashboardCashFlowSnapshots = useMemo(() => {
    const snapshots: DashboardPropertyCashFlowSnapshot[] = [];

    if (displayedSurfaceIds.includes('cash-flow-graph')) {
      resolveAnalyticsSurfaceScopes('cash-flow-graph').forEach((scope) => {
        const snapshot = buildDashboardPropertyCashFlowSnapshot({
          surfaceId: 'cash-flow-graph',
          property: scope.property,
          propertyLabel: scope.label,
        });

        if (snapshot) {
          snapshots.push(snapshot);
        }
      });
    }

    if (displayedSurfaceIds.includes('portfolio-overview-cash-flow')) {
      const snapshot = buildDashboardPropertyCashFlowSnapshot({
        surfaceId: 'portfolio-overview-cash-flow',
        property: featuredProperty,
        propertyLabel: featuredProperty?.data?.summary?.address || featuredProperty?.address || (isPortfolioScope ? 'Portfolio featured property' : 'Current property'),
      });

      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots;
  }, [displayedSurfaceIds, featuredProperty, isPortfolioScope, resolveAnalyticsSurfaceScopes]);

  function buildDashboardPromptAnswer(plan: DashboardAssistantPlan, prompt: string) {
    const targetSurfaceId = plan.highlightId || plan.nextIds[0] || null;
    const analyticsScopes = targetSurfaceId && isPropertyAnalyticsSurfaceId(targetSurfaceId)
      ? resolveAnalyticsSurfaceScopes(targetSurfaceId)
      : [];
    const analyticsScopeSummary = analyticsScopes.length > 1
      ? analyticsScopes.map((scope) => scope.label).join(' vs ')
      : analyticsScopes[0]?.label || (isPortfolioScope ? 'your portfolio' : 'the selected property');

    switch (targetSurfaceId) {
      case 'avm-history':
        return `Total property value is ${formatPreciseCurrency(propertyPortfolioOverview?.summary.totalValue ?? totalRealEstateValue)} today, with a quarterly trend move of ${formatSignedPercent(propertyValueTrendChange)} and a YTD change of ${formatSignedPercent(portfolioYtdChange)}.`;
      case 'cash-flow-graph':
      case 'income-expenses':
      case 'tax-history':
      case 'coc-return':
      case 'mortgage-amortization':
      case 'net-operating-income':
      case 'equity-appreciation':
      case 'total-return':
      case 'irr-holding-period': {
        const surfaceTitle = SURFACE_LIBRARY.find((surface) => surface.id === targetSurfaceId)?.title || 'Property analytics';
        return `${surfaceTitle} is rendering the live source analytics card for ${analyticsScopeSummary}.${analyticsScopes.length > 1 ? ' The surface is comparing those properties side by side.' : analyticsScopes[0]?.usingPortfolioFallback ? ' The card is using the dashboard\'s featured-property fallback while portfolio scope is selected.' : ' The card is scoped to the requested property.'}`;
      }
      case 'reserve-summary':
      case 'bookkeeping-trend':
        return `Bookkeeping is showing ${formatCurrency(reserveSummary.netCashFlow)} in net cash flow on ${formatCurrency(reserveSummary.totalIncome)} of income and ${formatCurrency(reserveSummary.totalExpenses)} of expenses${typeof reserveSummary.margin === 'number' ? `, which implies a ${reserveSummary.margin.toFixed(1)}% margin.` : '.'}`;
      case 'property-image': {
        if (!featuredProperty) {
          return 'There is no property image to render yet because no property is currently in scope.';
        }

        const address = featuredProperty.data?.summary?.address || featuredProperty.address;
        const value = featuredProperty.data?.summary?.avm_value ?? featuredProperty.financialData?.originalLoanAmount ?? 0;
        return `The property image surface is focused on ${address}. The current estimated value in scope is ${formatCurrency(value)}.`;
      }
      case 'tax-pdf-viewer':
        return `The tax PDF viewer loads the latest available CPA review packet for the current ${isPortfolioScope ? 'portfolio' : 'property'} scope, so you can inspect the actual PDF in place instead of jumping out to downloads.`;
      case 'maintenance-summary':
        return `Maintenance is currently tracking ${filteredAlerts.length} active alert${filteredAlerts.length === 1 ? '' : 's'} across ${filteredDevices.length} monitored device${filteredDevices.length === 1 ? '' : 's'}.`;
      default:
        return buildFallbackAssistantAnswer({
          prompt,
          plan,
          propertyCount: availableProperties.length,
          totalAssetValue,
          totalLiabilityValue,
          netCashFlow: reserveSummary.netCashFlow,
        });
    }
  }

  function enrichAssistantPlanForExplanation(
    assistantPlan: DashboardAssistantPlan,
    fallbackPlan: DashboardAssistantPlan,
    prompt: string,
  ) {
    const resolvedFocusSurfaceId = getDashboardPromptFocusSurface(prompt);
    const shouldGenerateExplanation = isDashboardExplanationPrompt(prompt) || Boolean(assistantPlan.answer);

    if (!shouldGenerateExplanation && !resolvedFocusSurfaceId) {
      return {
        plan: assistantPlan,
        responseText: assistantPlan.answer || '',
      };
    }

    const targetSurfaceId = resolvedFocusSurfaceId
      || assistantPlan.highlightId
      || fallbackPlan.highlightId
      || fallbackPlan.nextIds[0]
      || assistantPlan.nextIds[0]
      || null;
    const shouldFocusSingleSurface = Boolean(
      resolvedFocusSurfaceId
      && targetSurfaceId
      && resolvedFocusSurfaceId === targetSurfaceId,
    );
    const nextIds = shouldFocusSingleSurface
      ? [targetSurfaceId as DashboardSurfaceId]
      : (targetSurfaceId && !assistantPlan.nextIds.includes(targetSurfaceId)
        ? orderSurfaceIds([...assistantPlan.nextIds, targetSurfaceId])
        : assistantPlan.nextIds);
    const responseText = assistantPlan.answer || (shouldGenerateExplanation
      ? buildDashboardPromptAnswer({
        ...assistantPlan,
        nextIds,
        highlightId: targetSurfaceId,
      }, prompt)
      : '');

    const layout = shouldFocusSingleSurface
      ? (assistantPlan.layout || []).filter((entry) => entry.id === targetSurfaceId)
      : (assistantPlan.layout ? [...assistantPlan.layout] : []);
    if (targetSurfaceId) {
      const targetIndex = layout.findIndex((entry) => entry.id === targetSurfaceId);
      const targetLayoutPatch: DashboardSurfaceLayoutPatch = {
        id: targetSurfaceId,
        visible: true,
        order: 0,
        size: shouldFocusSingleSurface ? 'full' : undefined,
        height: shouldFocusSingleSurface ? 'hero' : undefined,
        emphasis: true,
        zIndex: (surfaceLayouts[targetSurfaceId]?.zIndex ?? DEFAULT_SURFACE_LAYOUTS[targetSurfaceId].zIndex) + 10,
      };

      if (targetIndex >= 0) {
        layout[targetIndex] = {
          ...layout[targetIndex],
          ...targetLayoutPatch,
        };
      } else {
        layout.push(targetLayoutPatch);
      }
    }

    const filteredAssistantAnnotations = assistantPlan.annotations && assistantPlan.annotations.length > 0
      ? assistantPlan.annotations.filter((annotation) => !shouldFocusSingleSurface || !annotation.surfaceId || annotation.surfaceId === targetSurfaceId)
      : [];
    const annotations = filteredAssistantAnnotations.length > 0
      ? filteredAssistantAnnotations
      : targetSurfaceId
        && responseText
        ? [{
          id: `explain-${targetSurfaceId}`,
          title: `${SURFACE_LIBRARY.find((surface) => surface.id === targetSurfaceId)?.title || 'Dashboard'} insight`,
          text: summarizeDashboardAnnotationText(responseText),
          surfaceId: targetSurfaceId,
          placement: 'top-right' as const,
          tone: 'info' as const,
          width: 'md' as const,
        }]
        : [];

    // Auto-derive segment highlights from the prompt when the AI hasn't provided them
    const derivedSegmentHighlights: DashboardSegmentHighlight[] = assistantPlan.segmentHighlights || [];

    return {
      plan: {
        ...assistantPlan,
        nextIds,
        highlightId: targetSurfaceId,
        answer: responseText,
        layout,
        annotations,
        clearAnnotations: shouldFocusSingleSurface ? true : assistantPlan.clearAnnotations,
        segmentHighlights: derivedSegmentHighlights.length > 0 ? derivedSegmentHighlights : assistantPlan.segmentHighlights,
      },
      responseText,
    };
  }

  const activateSidebarRealtimeAssistant = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('houseyield:voice-assistant-toggle', {
      detail: {
        provider: 'openai',
        action: 'connect',
      },
    }));
  };

  const mirrorPromptToSidebarAssistant = (
    prompt: string,
    modalities: RealtimeResponseModality[] = ['text'],
    options?: { source?: string; requestId?: string },
  ) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('houseyield:voice-assistant-prompt', {
      detail: {
        prompt,
        modalities,
        ...options,
      },
    }));
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleRealtimeDashboardResponse = (event: Event) => {
      const customEvent = event as CustomEvent<DashboardRealtimeResponseDetail>;
      const detail = customEvent.detail || {};

      if (!detail.requestId || detail.requestId !== lastRealtimeDashboardRequestIdRef.current) {
        return;
      }

      if (!detail.error && detail.requestId !== lastDashboardControlRequestIdRef.current) {
        const prompt = detail.prompt || lastRealtimeDashboardPromptRef.current;
        const fallbackPlan = parseDashboardCommand(prompt, activeSurfaceIds);
        const localAssistantPlan: DashboardAssistantPlan = {
          ...fallbackPlan,
          answer: detail.text || undefined,
        };
        const { plan: resolvedPlan } = enrichAssistantPlanForExplanation(localAssistantPlan, fallbackPlan, prompt);
        syncDashboardPropertyTargets(prompt, resolvedPlan.nextIds);
        applyDashboardPlan(resolvedPlan);
      }

      setAgentBusy(false);
      setAgentResponsePrompt(detail.prompt || lastRealtimeDashboardPromptRef.current);
      const localOverride = localDashboardResponseOverrideRef.current;
      const nextText = localOverride
        && localOverride.requestId === detail.requestId
        && isGenericDashboardResponseText(detail.text)
        ? localOverride.text
        : (detail.text || detail.error || 'Updated the dashboard.');

      if (!isGenericDashboardResponseText(detail.text)) {
        localDashboardResponseOverrideRef.current = null;
      }

      setAgentResponseText(nextText);
    };

    window.addEventListener('houseyield:dashboard-response', handleRealtimeDashboardResponse as EventListener);

    return () => {
      window.removeEventListener('houseyield:dashboard-response', handleRealtimeDashboardResponse as EventListener);
    };
  }, [activeSurfaceIds, applyDashboardPlan, enrichAssistantPlanForExplanation]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleRealtimeDashboardControl = (event: Event) => {
      const customEvent = event as CustomEvent<Record<string, unknown>>;
      const prompt = lastRealtimeDashboardPromptRef.current;
      const fallbackPlan = parseDashboardCommand(prompt, activeSurfaceIds);

      try {
        const assistantPlan = sanitizeAssistantPlan(
          JSON.stringify(customEvent.detail || {}),
          prompt,
          activeSurfaceIds,
        );
        const { plan: resolvedPlan, responseText } = enrichAssistantPlanForExplanation(assistantPlan, fallbackPlan, prompt);

        if (responseText) {
          lastDashboardControlRequestIdRef.current = lastRealtimeDashboardRequestIdRef.current;
          localDashboardResponseOverrideRef.current = {
            requestId: lastRealtimeDashboardRequestIdRef.current,
            text: responseText,
          };
          setAgentBusy(false);
          setAgentResponsePrompt(prompt);
          setAgentResponseText(responseText);
        }

        syncDashboardPropertyTargets(prompt, resolvedPlan.nextIds);
        applyDashboardPlan(resolvedPlan);

        if (resolvedPlan.actionId) {
          const action = WEBSITE_ACTIONS.find((entry) => entry.id === resolvedPlan.actionId);
          if (action) {
            void launchWorkflowAction(action);
          }
        }
      } catch (error) {
        const { plan: resolvedFallbackPlan, responseText } = enrichAssistantPlanForExplanation(fallbackPlan, fallbackPlan, prompt);
        lastDashboardControlRequestIdRef.current = lastRealtimeDashboardRequestIdRef.current;
        localDashboardResponseOverrideRef.current = {
          requestId: lastRealtimeDashboardRequestIdRef.current,
          text: responseText,
        };
        setAgentBusy(false);
        setAgentResponsePrompt(prompt);
        setAgentResponseText(responseText);
        syncDashboardPropertyTargets(prompt, resolvedFallbackPlan.nextIds);
        applyDashboardPlan(resolvedFallbackPlan);

        if (resolvedFallbackPlan.actionId) {
          const action = WEBSITE_ACTIONS.find((entry) => entry.id === resolvedFallbackPlan.actionId);
          if (action) {
            void launchWorkflowAction(action);
          }
        }
      }
    };

    window.addEventListener('houseyield:dashboard-control', handleRealtimeDashboardControl as EventListener);

    return () => {
      window.removeEventListener('houseyield:dashboard-control', handleRealtimeDashboardControl as EventListener);
    };
  }, [activeSurfaceIds, applyDashboardPlan, launchWorkflowAction]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.dispatchEvent(new CustomEvent('houseyield:dashboard-context', {
      detail: {
        enabled: true,
        currentSurfaceIds: displayedSurfaceIds,
        availableSurfaces: SURFACE_LIBRARY.map((surface) => ({
          id: surface.id,
          title: surface.title,
          source: surface.source,
          keywords: surface.keywords,
        })),
        currentSurfaceLayouts: displayedSurfaceIds.map((surfaceId) => ({
          id: surfaceId,
          order: surfaceLayouts[surfaceId]?.order ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].order,
          size: surfaceLayouts[surfaceId]?.size ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].size,
          height: surfaceLayouts[surfaceId]?.height ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].height,
          x: surfaceLayouts[surfaceId]?.x ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].x,
          y: surfaceLayouts[surfaceId]?.y ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].y,
          w: surfaceLayouts[surfaceId]?.w ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].w,
          h: surfaceLayouts[surfaceId]?.h ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].h,
          zIndex: surfaceLayouts[surfaceId]?.zIndex ?? DEFAULT_SURFACE_LAYOUTS[surfaceId].zIndex,
          emphasis: surfaceLayouts[surfaceId]?.emphasis ?? false,
        })),
        annotationsEnabled: true,
        annotationPlacements: DASHBOARD_ANNOTATION_PLACEMENTS,
        annotationTones: DASHBOARD_ANNOTATION_TONES,
        annotationWidths: DASHBOARD_ANNOTATION_WIDTHS,
        availableActions: dashboardControlActions.map((action) => ({
          id: action.id,
          name: action.name,
          description: action.description,
          destination: getActionDestination(action),
        })),
        propertyCount: availableProperties.length,
        propertyAddresses: availableProperties.slice(0, 8).map((property) => property.address),
        portfolioSnapshotCount: portfolioSnapshots.length,
        transactionCount: filteredTransactions.length,
        maintenanceDeviceCount: filteredDevices.length,
        totalPropertyValue: propertyPortfolioOverview?.summary.totalValue ?? totalRealEstateValue,
        reserveSummary,
        propertyValueBreakdown: propertyBreakdown.map((slice) => ({
          key: slice.key,
          label: slice.label,
          value: slice.value,
          percent: slice.percent,
        })),
        propertyCashFlowSnapshots: dashboardCashFlowSnapshots,
        activeSegmentHighlights: dashboardSegmentHighlights,
        lastHighlightedSurfaceId: highlightedSurfaceId,
      },
    }));
  }, [
    availableProperties,
    dashboardControlActions,
    filteredDevices.length,
    filteredTransactions.length,
    displayedSurfaceIds,
    portfolioSnapshots.length,
    propertyBreakdown,
    dashboardCashFlowSnapshots,
    dashboardSegmentHighlights,
    highlightedSurfaceId,
    reserveSummary,
    surfaceLayouts,
    totalRealEstateValue,
    propertyPortfolioOverview?.summary.totalValue,
  ]);

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;

      window.dispatchEvent(new CustomEvent('houseyield:dashboard-context', {
        detail: { enabled: false },
      }));
    };
  }, []);

  function applyDashboardPlan(plan: DashboardAssistantPlan) {
    const nextIdsSet = new Set(plan.nextIds);
    let nextLayouts = { ...DEFAULT_SURFACE_LAYOUTS, ...surfaceLayouts };

    (plan.layout || []).forEach((layoutPatch) => {
      const currentLayout = nextLayouts[layoutPatch.id] || DEFAULT_SURFACE_LAYOUTS[layoutPatch.id];
      if (layoutPatch.visible === true) {
        nextIdsSet.add(layoutPatch.id);
      } else if (layoutPatch.visible === false) {
        nextIdsSet.delete(layoutPatch.id);
      }

      const nextSize = layoutPatch.size ?? currentLayout.size;
      const nextHeightPreset = layoutPatch.height ?? currentLayout.height;
      const nextWidth = typeof layoutPatch.w === 'number'
        ? clampSceneWidth(layoutPatch.w)
        : layoutPatch.size
          ? getSceneWidthForSize(nextSize)
          : currentLayout.w;
      const nextHeight = typeof layoutPatch.h === 'number'
        ? clampSceneHeight(layoutPatch.h)
        : layoutPatch.height
          ? getSceneHeightForPreset(nextHeightPreset)
          : currentLayout.h;

      nextLayouts[layoutPatch.id] = {
        ...currentLayout,
        order: typeof layoutPatch.order === 'number' ? Math.max(0, Math.round(layoutPatch.order)) : currentLayout.order,
        size: nextSize,
        height: nextHeightPreset,
        x: typeof layoutPatch.x === 'number' ? clampSceneX(layoutPatch.x, nextWidth) : clampSceneX(currentLayout.x, nextWidth),
        y: typeof layoutPatch.y === 'number' ? clampSceneY(layoutPatch.y) : currentLayout.y,
        w: nextWidth,
        h: nextHeight,
        zIndex: typeof layoutPatch.zIndex === 'number' ? Math.max(1, Math.round(layoutPatch.zIndex)) : currentLayout.zIndex,
        emphasis: typeof layoutPatch.emphasis === 'boolean' ? layoutPatch.emphasis : currentLayout.emphasis,
        visible: layoutPatch.visible ?? currentLayout.visible,
      };
    });

    const nextIds = filterRemovedPersonalFinanceSurfaces(sortSurfaceIdsByLayout(Array.from(nextIdsSet), nextLayouts));
    const nextIdSetNormalized = new Set(nextIds);

    (Object.keys(nextLayouts) as DashboardSurfaceId[]).forEach((surfaceId) => {
      nextLayouts[surfaceId] = {
        ...nextLayouts[surfaceId],
        visible: nextIdSetNormalized.has(surfaceId),
      };
    });

    const packedFrames = getPackedSceneFrames(nextIds, nextLayouts);

    nextIds.forEach((surfaceId) => {
      const currentLayout = nextLayouts[surfaceId];
      const packedFrame = packedFrames[surfaceId];

      if (!packedFrame) {
        return;
      }

      nextLayouts[surfaceId] = {
        ...currentLayout,
        ...packedFrame,
      };
    });

    const nextAnnotations = mergeDashboardAnnotations(
      dashboardAnnotations,
      plan.annotations || [],
      plan.clearAnnotations === true,
      nextIds,
    );

    startTransition(() => {
      setSurfaceLayouts(nextLayouts);
      setDashboardAnnotations(nextAnnotations);
      setActiveSurfaceIds(nextIds);
      setHighlightedSurfaceId(plan.highlightId && nextIds.includes(plan.highlightId) ? plan.highlightId : nextIds[0] || null);
      if (plan.segmentHighlights !== undefined) {
        setDashboardSegmentHighlights(plan.segmentHighlights);
      } else if (plan.clearAnnotations) {
        setDashboardSegmentHighlights([]);
      }
    });
  }

  async function launchWorkflowAction(action: ControlAction) {
    let message: string;

    try {
      const executed = await websiteControl.executeAction(action, {
        requestSummary: `Dashboard asked HouseYield AI to ${action.name.toLowerCase()}.`,
      });
      if (executed) {
        message = action.category === 'navigation'
          ? `Opened ${action.name}.`
          : `Executed ${action.name}.`;
      } else {
        const destination = getActionDestination(action);
        if (destination) {
          navigate(destination);
          message = `Opened ${action.name}. The system can now target ${action.voiceId || destination}.`;
        } else {
          message = `Prepared ${action.name} for in-place control.`;
        }
      }
    } catch (error) {
      const destination = getActionDestination(action);
      if (destination) {
        navigate(destination);
        message = `Opened ${action.name}. The system can now target ${action.voiceId || destination}.`;
      } else {
        message = error instanceof Error ? error.message : `Unable to execute ${action.name}.`;
      }
    }

    setAgentResponseText(message);

    return message;
  }

  async function launchDashboardShortcut(action: ControlAction) {
    const destination = DASHBOARD_SHORTCUT_DESTINATIONS[action.id] || getActionDestination(action);
    if (destination) {
      navigate(destination);
      return `Opened ${action.name}.`;
    }

    return launchWorkflowAction(action);
  }

  const executePrompt = async (prompt: string) => {
    const trimmedPrompt = prompt.trim();
    const fallbackPlan = parseDashboardCommand(trimmedPrompt, activeSurfaceIds);

    if (!trimmedPrompt) {
      setFocusedSurfaceId(null);
      applyDashboardPlan(fallbackPlan);
      setAgentPrompt('');
      return;
    }

    setHasSubmittedDashboardPrompt(true);

    const localFocusSurfaceId = getDashboardPromptFocusSurface(trimmedPrompt);

    setFocusedSurfaceId(localFocusSurfaceId);

    const requestId = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    lastRealtimeDashboardPromptRef.current = trimmedPrompt;
    lastRealtimeDashboardRequestIdRef.current = requestId;
    lastDashboardControlRequestIdRef.current = '';
    localDashboardResponseOverrideRef.current = null;
    setAgentResponsePrompt(trimmedPrompt);
    setAgentResponseText('');
    setAgentBusy(true);

    try {
      mirrorPromptToSidebarAssistant(trimmedPrompt, ['text'], {
        source: 'dashboard',
        requestId,
      });
    } finally {
      setAgentPrompt('');
    }
  };

  const runDashboardDailyBriefing = async () => {
    const actionId = `dashboard-daily-briefing-${Date.now()}`;
    const steps = [
      'Check Dashboard priorities',
      'Analyze Management: payments and leases',
      'Review Management: maintenance, messages, and documents',
      'Inspect Sensors: safety and device health',
      'Compare Properties and Market Insights',
      'Prepare suggested actions',
    ];
    const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const emit = (
      status: 'start' | 'step' | 'complete' | 'error',
      currentStep: number,
      detailMessage: string,
      extras: {
        result?: AssistantDailyBriefingResult;
        actions?: AssistantPadAction[];
        error?: string;
      } = {},
    ) => {
      emitAssistantActionProgress({
        actionId,
        title: 'Your daily briefing',
        summary: 'Reviewing the account without leaving your Dashboard.',
        status,
        currentStep,
        steps,
        detailMessage,
        ...extras,
      });
    };

    emit('start', 0, 'Gathering the priorities already visible on your Dashboard…');

    const digestPromise: Promise<WeeklyDigest | null> = previewWeeklyDigest().catch((error) => {
      console.warn('[Dashboard] Daily briefing digest unavailable:', error);
      return null;
    });
    const documentsPromise: Promise<Array<Record<string, any>>> = ownerId
      ? requestOwnerFinanceJson(
          buildOwnerFinanceUrl(`/api/documents?ownerId=${encodeURIComponent(ownerId)}`),
        )
          .then((response) => Array.isArray(response?.documents) ? response.documents : [])
          .catch((error) => {
            console.warn('[Dashboard] Daily briefing documents unavailable:', error);
            return [];
          })
      : Promise.resolve([]);

    try {
      await pause(450);
      emit('step', 1, 'Comparing collected rent, cash flow, and upcoming lease dates…');
      const digest = await digestPromise;

      await pause(350);
      emit('step', 2, 'Checking maintenance, tenant messages, and documents that need action…');
      const documents = await documentsPromise;
      const pendingDocuments = documents.filter((document) => (
        ['pending_signatures', 'partially_signed'].includes(String(document.status || '').toLowerCase())
      ));

      await pause(350);
      emit('step', 3, 'Reviewing connected sensors and unacknowledged safety alerts…');
      const openSensorAlerts = filteredAlerts.filter((alert) => !alert.acknowledged);
      const criticalSensorAlerts = openSensorAlerts.filter((alert) => alert.severity === 'critical');

      await pause(350);
      emit('step', 4, 'Comparing portfolio performance with current rental pricing signals…');
      const pricingPower = Array.isArray(digest?.pricingPower?.properties)
        ? [...digest.pricingPower.properties].sort(
            (left, right) => Math.abs(right.pricingPowerDollar) - Math.abs(left.pricingPowerDollar),
          )
        : [];
      const strongestPricingSignal = pricingPower[0] || null;

      const rentExpected = dashboardActionItems.rentExpected || digest?.financialWeek?.expectedMonthlyRent || 0;
      const rentCollected = dashboardActionItems.rentCollected || digest?.financialWeek?.rentCollected || 0;
      const rentOutstanding = Math.max(0, rentExpected - rentCollected);
      const expiringLeaseCount = Math.max(
        dashboardActionItems.expiringLeases,
        digest?.leases?.expiringLeases?.length || 0,
      );
      const openMaintenanceCount = Math.max(
        dashboardActionItems.openMaintenance,
        digest?.managementActivity?.openMaintenanceCount || 0,
      );
      const unreadMessageCount = Math.max(
        dashboardActionItems.newMessages,
        digest?.managementActivity?.unreadMessageCount || 0,
      );
      const attentionCount = [
        rentOutstanding > 0,
        expiringLeaseCount > 0,
        openMaintenanceCount > 0,
        unreadMessageCount > 0,
        pendingDocuments.length > 0,
        openSensorAlerts.length > 0,
      ].filter(Boolean).length;

      const financialDetails = [
        rentExpected > 0
          ? `${formatCurrency(rentCollected)} of ${formatCurrency(rentExpected)} in expected monthly rent is recorded.`
          : `${formatCurrency(reserveSummary.totalIncome)} income and ${formatCurrency(reserveSummary.totalExpenses)} expenses are recorded in the current view.`,
        digest?.financialWeek?.topExpenseCategories?.length
          ? `Largest recent expense: ${digest.financialWeek.topExpenseCategories[0].category} at ${formatCurrency(digest.financialWeek.topExpenseCategories[0].amount)}.`
          : null,
      ].filter((detail): detail is string => Boolean(detail));

      const leaseDetails = (digest?.leases?.expiringLeases || []).slice(0, 2).map((lease) => (
        `${lease.tenantName}${lease.address ? ` · ${lease.address}` : ''} · ${lease.daysUntil} days remaining`
      ));
      const documentDetails = pendingDocuments.slice(0, 2).map((document) => (
        `${String(document.title || 'Untitled document')} · ${String(document.status || '').replace(/_/g, ' ')}`
      ));
      const sensorDetails = openSensorAlerts.slice(0, 2).map((alert) => alert.message);
      const marketDetails = strongestPricingSignal
        ? [
            `${strongestPricingSignal.address || 'A portfolio property'} is ${strongestPricingSignal.position || 'showing a pricing signal'} at ${formatCurrency(strongestPricingSignal.pricingPowerDollar)}/mo versus the market median.`,
          ]
        : ['No material rental-pricing change was available in this briefing run.'];

      const result: AssistantDailyBriefingResult = {
        type: 'daily_briefing',
        title: attentionCount > 0 ? `${attentionCount} areas deserve a look` : 'Your account looks steady',
        generatedAt: new Date().toISOString(),
        summary: attentionCount > 0
          ? 'The items below are ranked by operational urgency. Nothing was changed while this briefing ran.'
          : 'No urgent account-wide issue surfaced. The latest available financial, operating, document, and sensor data was reviewed.',
        metrics: [
          {
            label: 'Rent outstanding',
            value: formatCurrency(rentOutstanding),
            tone: rentOutstanding > 0 ? 'warning' : 'positive',
          },
          {
            label: 'Net cash flow',
            value: formatCurrency(digest?.financialWeek?.netCashFlow ?? reserveSummary.netCashFlow),
            tone: (digest?.financialWeek?.netCashFlow ?? reserveSummary.netCashFlow) >= 0 ? 'positive' : 'critical',
          },
          {
            label: 'Open operations',
            value: String(openMaintenanceCount + unreadMessageCount),
            tone: openMaintenanceCount + unreadMessageCount > 0 ? 'warning' : 'positive',
          },
          {
            label: 'Sensor alerts',
            value: String(openSensorAlerts.length),
            tone: criticalSensorAlerts.length > 0 ? 'critical' : openSensorAlerts.length > 0 ? 'warning' : 'positive',
          },
        ],
        sections: [
          {
            id: 'financial',
            label: 'Payments & cash flow',
            status: rentOutstanding > 0 || (digest?.financialWeek?.netCashFlow ?? reserveSummary.netCashFlow) < 0 ? 'attention' : 'clear',
            headline: rentOutstanding > 0
              ? `${formatCurrency(rentOutstanding)} of expected rent is not yet recorded`
              : 'Rent and cash flow do not show an urgent exception',
            details: financialDetails,
          },
          {
            id: 'leases-documents',
            label: 'Leases & documents',
            status: expiringLeaseCount > 0 || pendingDocuments.length > 0 ? 'attention' : 'clear',
            headline: `${expiringLeaseCount} expiring lease${expiringLeaseCount === 1 ? '' : 's'} · ${pendingDocuments.length} document${pendingDocuments.length === 1 ? '' : 's'} awaiting signature`,
            details: [...leaseDetails, ...documentDetails].slice(0, 4),
          },
          {
            id: 'operations',
            label: 'Maintenance & messages',
            status: openMaintenanceCount > 0 || unreadMessageCount > 0 ? 'attention' : 'clear',
            headline: `${openMaintenanceCount} open maintenance · ${unreadMessageCount} unread tenant message${unreadMessageCount === 1 ? '' : 's'}`,
            details: (digest?.managementActivity?.newMaintenanceRequests || []).slice(0, 2).map((request) => (
              `${request.title} · ${request.status}${request.tenantName ? ` · ${request.tenantName}` : ''}`
            )),
          },
          {
            id: 'sensors',
            label: 'Sensors & protection',
            status: criticalSensorAlerts.length > 0 ? 'critical' : openSensorAlerts.length > 0 ? 'attention' : 'clear',
            headline: criticalSensorAlerts.length > 0
              ? `${criticalSensorAlerts.length} critical sensor alert${criticalSensorAlerts.length === 1 ? '' : 's'} needs attention`
              : `${filteredDevices.length} device${filteredDevices.length === 1 ? '' : 's'} reviewed · ${openSensorAlerts.length} open alert${openSensorAlerts.length === 1 ? '' : 's'}`,
            details: sensorDetails,
          },
          {
            id: 'portfolio-market',
            label: 'Properties & market',
            status: strongestPricingSignal && Math.abs(strongestPricingSignal.pricingPowerDollar) >= 100 ? 'info' : 'clear',
            headline: propertyPortfolioOverview
              ? `${formatCurrency(propertyPortfolioOverview.summary.totalValue)} across ${propertyPortfolioOverview.summary.count} properties`
              : `${availableProperties.length} propert${availableProperties.length === 1 ? 'y' : 'ies'} in the current portfolio`,
            details: marketDetails,
          },
        ],
      };

      const suggestions: AssistantPadAction[] = [];
      const pendingDocument = pendingDocuments[0];
      if (pendingDocument?.id) {
        suggestions.push({
          id: 'approve-signature-reminder',
          label: 'Approve signature reminder',
          kind: 'confirm',
          primary: true,
          payload: {
            actionId: 'follow-up-esignature-request',
            documentId: pendingDocument.id,
            stayOnCurrentPage: true,
            requestSummary: `Draft a signature reminder for ${String(pendingDocument.title || 'the pending document')}.`,
          },
        });
      }
      if (openSensorAlerts.length > 0) {
        suggestions.push({
          id: 'approve-sensor-analysis',
          label: 'Approve sensor risk analysis',
          kind: 'confirm',
          primary: suggestions.length === 0,
          payload: {
            actionId: 'analyze-sensor-data',
            stayOnCurrentPage: true,
            requestSummary: 'Analyze the open sensor alerts and recommend the safest next actions.',
          },
        });
      }
      if (strongestPricingSignal && Math.abs(strongestPricingSignal.pricingPowerDollar) >= 100) {
        suggestions.push({
          id: 'approve-market-analysis',
          label: 'Approve market analysis',
          kind: 'confirm',
          payload: {
            actionId: 'analyze-market-insight',
            stayOnCurrentPage: true,
            requestSummary: 'Analyze current market changes that could affect this portfolio and rental strategy.',
          },
        });
      }

      await pause(400);
      emit('step', 5, 'Ranking the findings and preparing actions for your approval…');
      await pause(450);
      emit('complete', steps.length - 1, suggestions.length > 0
        ? 'Briefing ready. Suggested actions will only run after you approve them.'
        : 'Briefing ready. No safe one-click action is needed right now.', {
        result,
        actions: suggestions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The daily briefing could not be completed.';
      emit('error', 1, message, { error: message });
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await executePrompt(agentPrompt);
  };

  const renderSurface = (surfaceId: DashboardSurfaceId) => {
    if (isIncomeProjectionSurfaceId(surfaceId)) {
      return <IncomeProjectionAssetWidget focusAsset={surfaceId} />;
    }

    if (isMarketInsightsSurfaceId(surfaceId)) {
      return <MarketInsightsAssetWidget focusAsset={surfaceId} />;
    }

    switch (surfaceId) {
      case 'property-overview':
        return <PropertyOverviewWidget properties={availableProperties} />;
      case 'avm-history':
      case 'cash-flow-graph':
      case 'income-expenses':
      case 'tax-history':
      case 'coc-return':
      case 'mortgage-amortization':
      case 'net-operating-income':
      case 'equity-appreciation':
      case 'total-return':
      case 'irr-holding-period':
        return (
          <DashboardPropertyAnalyticsSurface
            metric={DASHBOARD_PROPERTY_ANALYTICS_SURFACE_METRICS[surfaceId]}
            scopes={resolveAnalyticsSurfaceScopes(surfaceId)}
            portfolioAnalytics={portfolioAnalytics}
          />
        );
      case 'reserve-summary':
        return (
          <ReserveSummaryWidget
            reserveSummary={reserveSummary}
            reserveCategories={reserveCategories}
            accountBalance={bookkeeping.summary?.cashBalance ?? null}
          />
        );
      case 'property-image':
        return (
          <PropertyImageWidget
            property={featuredProperty}
            properties={availableProperties}
            isPortfolioScope={isPortfolioScope}
          />
        );
      case 'portfolio-overview-price-history':
      case 'portfolio-overview-cash-flow':
      case 'portfolio-overview-tax-history':
      case 'portfolio-overview-tenant-correspondence-summary':
        return <PropertyOverviewAssetWidget property={featuredProperty} focusAsset={DASHBOARD_PORTFOLIO_OVERVIEW_SURFACE_ASSETS[surfaceId]} />;
      case 'property-details-overview':
      case 'property-details-tax-history':
      case 'property-details-mortgage':
      case 'property-details-owner':
      case 'property-details-environmental':
      case 'property-details-schools':
      case 'property-details-building-permits':
      case 'property-details-sale-history':
      case 'property-details-location':
        return <PropertyDetailsSectionWidget property={featuredProperty} focusSection={DASHBOARD_PROPERTY_DETAILS_SURFACE_SECTIONS[surfaceId]} />;
      case 'rental-pricing-power':
        return <RentalPricingPowerWidget property={featuredProperty} userId={ownerId} />;
      case 'rental-pricing-power-bar-comparison':
      case 'rental-pricing-power-comparable-listings-map':
      case 'rental-pricing-power-strategy':
      case 'rental-pricing-power-rent-sweep':
      case 'rental-pricing-power-model-metrics':
      case 'rental-pricing-power-vacancy-cutoff':
      case 'rental-pricing-power-renovation-separation':
      case 'rental-pricing-power-market-conditions':
      case 'rental-pricing-power-local-leasing-signals':
      case 'rental-pricing-power-renovation-analysis-link':
        return <RentalPricingPowerWidget property={featuredProperty} userId={ownerId} focusAsset={DASHBOARD_RENTAL_PRICING_SURFACE_ASSETS[surfaceId]} />;
      case 'tax-pdf-viewer':
        return (
          <TaxPdfViewerWidget
            hasAuthenticatedUser={Boolean(ownerId)}
            propertyId={isPortfolioScope ? undefined : featuredProperty?.id}
            propertyAddress={featuredProperty?.data?.summary?.address || featuredProperty?.address}
            isPortfolioScope={isPortfolioScope}
          />
        );
      case 'irs-draft-forms':
        return (
          <IrsDraftFormsWidget
            hasAuthenticatedUser={Boolean(ownerId)}
            propertyId={isPortfolioScope ? undefined : featuredProperty?.id}
            propertyAddress={featuredProperty?.data?.summary?.address || featuredProperty?.address}
            isPortfolioScope={isPortfolioScope}
          />
        );
      case 'maintenance-summary':
        return <MaintenanceSummaryWidget devices={filteredDevices} alerts={filteredAlerts} readings={filteredReadings} />;
      case 'bookkeeping-trend':
      case 'bookkeeping-cash-balance-history':
      case 'bookkeeping-cash-balance':
      case 'bookkeeping-reserve-runway':
      case 'bookkeeping-average-net':
      case 'bookkeeping-data-quality':
      case 'bookkeeping-analytics-explanations':
      case 'bookkeeping-reserve-posture':
      case 'bookkeeping-analytics-foundation':
        return (
          <BookkeepingAnalyticsFoundationWidget
            summary={selectedPropertyId === PORTFOLIO_SCOPE_ID
              ? bookkeeping.summary
              : filteredTransactions.length > 0
                ? buildBookkeepingWorkspaceSummary(filteredTransactions, 0)
                : null}
            transactions={filteredTransactions}
            cashBalance={selectedPropertyId === PORTFOLIO_SCOPE_ID ? bookkeeping.summary?.cashBalance ?? null : null}
            focusAsset={DASHBOARD_BOOKKEEPING_ANALYTICS_SURFACE_ASSETS[surfaceId] ?? undefined}
          />
        );
      case 'workflow-shortcuts':
        return <WorkflowShortcutsWidget actions={featuredWorkflowActions} onLaunch={launchWorkflowAction} />;
      case 'weekly-recap':
        return <YourWeekRecapCard theme="light" variant="surface" />;
      default:
        return null;
    }
  };

  const deferredBodyClassName = greetingAnimationSettled
    ? 'dashboard-deferred-body'
    : 'dashboard-deferred-body dashboard-deferred-body-priority';

  return (
    <>
      <style>{dashboardStyles}</style>
      {loginSplashVisible ? (
        <div className="dashboard-login-splash" aria-label="HouseYield loading screen">
          <div className="dashboard-login-splash-brand">HouseYield</div>
        </div>
      ) : null}
      <main className="dashboard-shell flex-1 overflow-y-auto">
        <div className="dashboard-fixed-header border-b border-slate-200/80 bg-white/90">
          <div className="mx-auto max-w-7xl px-6 py-3">
            <section className="bg-white/80 pb-3 pt-1">
                    <div className="mb-2 flex flex-col gap-1.5 lg:flex-row lg:items-end lg:justify-between">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">Dashboard</div>
                    <div className="mt-0.5 min-h-[40px]">
                      <svg
                        viewBox={`0 0 ${greetingViewBoxWidth} ${GREETING_VIEWBOX_HEIGHT}`}
                        className={`dashboard-greeting-svg ${greetingAnimationActive ? 'dashboard-greeting-svg-active' : 'dashboard-greeting-svg-primed'}`}
                        role="img"
                        aria-label={greetingLabel}
                        aria-hidden={loginSplashVisible ? true : undefined}
                      >
                        <defs>
                          <linearGradient id={greetingGradientId} x1="0" y1="0" x2={greetingViewBoxWidth} y2="0" gradientUnits="userSpaceOnUse">
                            <stop offset="0%" stopColor="#214268" />
                            <stop offset="100%" stopColor="#2eb8b4" />
                          </linearGradient>
                          <linearGradient id={greetingSweepGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
                            <stop offset="24%" stopColor="#ffffff" stopOpacity="0" />
                            <stop offset="48%" stopColor="#f8fdff" stopOpacity="0.96" />
                            <stop offset="66%" stopColor="#b8ffff" stopOpacity="0.54" />
                            <stop offset="82%" stopColor="#7fe3df" stopOpacity="0.2" />
                            <stop offset="100%" stopColor="#7fe3df" stopOpacity="0" />
                          </linearGradient>
                          {greetingAnimation.glyphs.map((glyph) => {
                            const clipId = `dashboard-greeting-clip-${greetingIdBase}-${glyph.index}`;

                            return (
                              <clipPath key={clipId} id={clipId} clipPathUnits="userSpaceOnUse">
                                <text
                                  x={glyph.x}
                                  y={GREETING_BASELINE_Y}
                                  className="dashboard-greeting-letter"
                                >
                                  {glyph.char}
                                </text>
                              </clipPath>
                            );
                          })}
                        </defs>
                        {greetingAnimation.glyphs.map((glyph) => {
                          const clipId = `dashboard-greeting-clip-${greetingIdBase}-${glyph.index}`;
                          const isNameGlyph = isGreetingNameGlyph(glyph.index);
                          const fill = glyph.index >= GREETING_PREFIX.length ? `url(#${greetingGradientId})` : '#203854';
                          const sheenInset = getGreetingSheenInset(glyph);
                          const sheenAnimationName = isNameGlyph ? 'dashboard-greeting-sheen-pass-name' : 'dashboard-greeting-sheen-pass';

                          return (
                            <g key={clipId} clipPath={`url(#${clipId})`}>
                              <rect
                                x={glyph.x - 12}
                                y="0"
                                width={glyph.width + 24}
                                height={GREETING_VIEWBOX_HEIGHT}
                                fill={fill}
                                className="dashboard-greeting-reveal-rect"
                                style={{
                                  animation: greetingAnimationActive
                                    ? `dashboard-greeting-vertical-reveal ${glyph.durationMs}ms ${GREETING_REVEAL_EASING} ${glyph.delayMs}ms forwards`
                                    : 'none',
                                }}
                              />
                              <rect
                                x={glyph.x - sheenInset}
                                y="-4"
                                width={glyph.width + sheenInset * 2}
                                height={GREETING_VIEWBOX_HEIGHT + 8}
                                fill={`url(#${greetingSweepGradientId})`}
                                className={isNameGlyph ? 'dashboard-greeting-sheen-rect dashboard-greeting-sheen-rect-name' : 'dashboard-greeting-sheen-rect'}
                                style={{
                                  animation: greetingAnimationActive
                                    ? `${sheenAnimationName} ${getGreetingSheenDuration(glyph)}ms cubic-bezier(0.2, 0.02, 0.16, 1) ${Math.max(0, glyph.delayMs - getGreetingSheenLeadMs(glyph))}ms forwards`
                                    : 'none',
                                }}
                              />
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  </div>

                  <div className="w-full max-w-sm lg:w-[320px] lg:shrink-0">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 lg:text-right">Scope</div>
                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 lg:text-right">
                      {availableProperties.length > 0
                        ? `${availableProperties.length} portfolio properties across your account`
                        : 'Account-wide portfolio view'}
                    </div>
                  </div>
                </div>

                {dashboardBodyVisible ? (
                  <DashboardAnalyzingFrame
                    isAnalyzing={agentBusy}
                    className="dashboard-agent-analysis-frame"
                    contentClassName={deferredBodyClassName}
                    cornerRadius={24}
                    bleed={8}
                  >
                    <form onSubmit={handleSubmit} className="dashboard-agent-shell flex items-center gap-3 rounded-[24px] border border-slate-200 px-3 py-3">
                      <button
                        type="button"
                        onClick={() => inputRef.current?.focus()}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-[#214268] text-white transition hover:bg-[#18314c]"
                        aria-label="Focus dashboard agent"
                      >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 15a3 3 0 003-3V7a3 3 0 10-6 0v5a3 3 0 003 3zm0 0v4m-4 0h8" />
                        </svg>
                      </button>

                      <div className="min-w-0 flex-1">
                        <input
                          ref={inputRef}
                          value={agentPrompt}
                          onChange={(event) => setAgentPrompt(event.target.value)}
                          placeholder={dashboardPromptPlaceholder}
                          className="w-full bg-transparent text-base font-medium tracking-[-0.02em] text-slate-800 outline-none placeholder:text-slate-400"
                          data-voice-id="dashboard-agent-input"
                          data-voice-label="Dashboard agent prompt"
                          data-voice-type="input"
                          data-voice-description="Prompt field for arranging dashboard cards, annotations, and workflow actions."
                          data-voice-section="dashboard-agent"
                          data-voice-interactive="true"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => setAssistantMemoriesOpen(true)}
                        disabled={!user?.id}
                        className="shrink-0 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="View saved assistant memories"
                      >
                        Memories
                      </button>

                      <button
                        type="button"
                        onClick={activateSidebarRealtimeAssistant}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                        aria-label="Activate OpenAI realtime speech assistant"
                        title="Activate OpenAI GPT-Realtime-2 speech assistant"
                      >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.9} d="M12 18a4 4 0 004-4V8a4 4 0 10-8 0v6a4 4 0 004 4zm0 0v3m-4 0h8" />
                        </svg>
                      </button>

                      <button
                        type="submit"
                        disabled={agentBusy}
                        {...buildVoiceUiAttrs({
                          id: 'dashboard-agent-render-btn',
                          label: 'Render dashboard change',
                          type: 'button',
                          description: 'Submit the dashboard agent prompt and apply a fluid UI update.',
                          pageSection: 'dashboard-agent',
                          interactive: true,
                        })}
                        className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
                      >
                        {agentBusy ? 'Thinking...' : 'Render'}
                      </button>
                    </form>

                    {(agentBusy || agentResponseText) ? (
                      <div className="mt-3 rounded-[22px] border border-slate-200 bg-white/88 px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">AI response</div>
                        {agentResponsePrompt ? (
                          <div className="mt-1 text-xs font-medium text-slate-400">For: {agentResponsePrompt}</div>
                        ) : null}
                        {agentBusy ? (
                          <div className="mt-3 flex items-center gap-3 text-sm font-medium text-slate-500">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
                            Thinking through your dashboard request...
                          </div>
                        ) : (
                          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{agentResponseText}</p>
                        )}
                      </div>
                    ) : null}

                    <DashboardAssistantMemoriesModal
                      isOpen={assistantMemoriesOpen}
                      userId={user?.id}
                      onClose={() => setAssistantMemoriesOpen(false)}
                    />
                  </DashboardAnalyzingFrame>
                ) : (
                  <div className="mt-2 h-[72px]" aria-hidden="true" />
                )}
            </section>
          </div>
        </div>

        {dashboardBodyVisible ? (
          <div className="px-6 pb-6 pt-4">
            <div className="mx-auto max-w-7xl">
              {!agentBusy && displayedSurfaceIds.length === 0 ? (
                hasSubmittedDashboardPrompt ? (
                  <div className="rounded-[28px] border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
                    <div className="text-lg font-semibold text-slate-900">The dashboard is empty.</div>
                    <p className="mt-2 text-sm text-slate-500">Ask the agent for a graph or overview card and it will render here.</p>
                  </div>
                ) : (
                  <div className={deferredBodyClassName}>
                    <DashboardLandingOverview
                      propertyPortfolioOverview={propertyPortfolioOverview}
                      reserveSummary={reserveSummary}
                      properties={availableProperties}
                      constellationProperties={constellationProperties}
                      quickActions={getFeaturedWorkflowActions()}
                      actionItems={dashboardActionItems}
                      onNavigate={(path) => navigate(path)}
                      onLaunchAction={launchDashboardShortcut}
                      onRequestBriefing={runDashboardDailyBriefing}
                    />
                  </div>
                )
              ) : (
                <div className="dashboard-fluid-analysis-frame">
                  <SidebarLiquidGlassShell className="dashboard-fluid-shell" roundedClassName="rounded-[36px]">
                    <div className={`${deferredBodyClassName} dashboard-fluid-canvas ${agentBusy ? 'is-analyzing' : ''} ${agentBusy && displayedSurfaceIds.length === 0 ? 'is-searching-empty' : ''}`}>
                      <DashboardDotRippleField active={agentBusy} />
                      <div className="dashboard-fluid-canvas-inner px-6 pb-6 pt-4">
                        <div className="relative">
                          {displayedSurfaceIds.length > 0 ? (
                            <>
                              <div className="space-y-4 xl:hidden">
                                {displayedSurfaceIds.map((surfaceId) => {
                                  const surface = SURFACE_LIBRARY.find((entry) => entry.id === surfaceId);
                                  if (!surface) return null;
                                  const standalone = isStandaloneDashboardSurfaceId(surface.id);

                                  return (
                                    <SnapshotCard
                                      key={`${surface.id}-stacked`}
                                      surface={surface}
                                      layout={surfaceLayouts[surface.id] || DEFAULT_SURFACE_LAYOUTS[surface.id]}
                                      annotations={dashboardAnnotations.filter((annotation) => annotation.surfaceId === surface.id)}
                                      highlighted={highlightedSurfaceId === surface.id}
                                      standalone={standalone}
                                      onSelect={() => setHighlightedSurfaceId(surface.id)}
                                      onRemove={() => {
                                        const nextIds = activeSurfaceIds.filter((id) => id !== surface.id);
                                        applyDashboardPlan({
                                          nextIds,
                                          highlightId: nextIds[0] || null,
                                          message: `Removed ${surface.title} from the dashboard.`,
                                          layout: [{ id: surface.id, visible: false, emphasis: false }],
                                        });
                                      }}
                                      surfaceRef={(node) => {
                                        surfaceRefs.current[surface.id] = node;
                                      }}
                                    >
                                      {renderSurface(surface.id)}
                                    </SnapshotCard>
                                  );
                                })}
                              </div>

                              {canvasAnnotations.length > 0 ? (
                                <div className="mb-5 hidden grid-cols-3 gap-4 xl:grid">
                                  {canvasAnnotations.map((annotation) => (
                                    <DashboardInlineAnnotationCard key={annotation.id} annotation={annotation} />
                                  ))}
                                </div>
                              ) : null}

                              <div className="hidden min-h-0 xl:grid xl:grid-flow-dense xl:grid-cols-12 xl:gap-6">
                                {displayedSurfaceIds.map((surfaceId) => {
                                  const surface = SURFACE_LIBRARY.find((entry) => entry.id === surfaceId);
                                  if (!surface) return null;
                                  const layout = surfaceLayouts[surface.id] || DEFAULT_SURFACE_LAYOUTS[surface.id];
                                  const standalone = isStandaloneDashboardSurfaceId(surface.id);

                                  return (
                                    <SnapshotCard
                                      key={surface.id}
                                      surface={surface}
                                      layout={layout}
                                      annotations={dashboardAnnotations.filter((annotation) => annotation.surfaceId === surface.id)}
                                      highlighted={highlightedSurfaceId === surface.id}
                                      standalone={standalone}
                                      style={getSurfaceDesktopStyle(surface.id, layout)}
                                      onSelect={() => setHighlightedSurfaceId(surface.id)}
                                      onRemove={() => {
                                        const nextIds = activeSurfaceIds.filter((id) => id !== surface.id);
                                        applyDashboardPlan({
                                          nextIds,
                                          highlightId: nextIds[0] || null,
                                          message: `Removed ${surface.title} from the dashboard.`,
                                          layout: [{ id: surface.id, visible: false, emphasis: false }],
                                        });
                                      }}
                                      surfaceRef={(node) => {
                                        surfaceRefs.current[surface.id] = node;
                                      }}
                                    >
                                      {renderSurface(surface.id)}
                                    </SnapshotCard>
                                  );
                                })}
                              </div>
                            </>
                          ) : (
                            <div className="rounded-[28px] border border-dashed border-slate-300 bg-white/85 px-6 py-16 text-center">
                              <div className="text-lg font-semibold text-slate-900">Working on it…</div>
                              <p className="mt-2 text-sm text-slate-500">The agent is arranging your dashboard.</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </SidebarLiquidGlassShell>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}