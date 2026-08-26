/**
 * RentalPricingPowerGraph - Shows current rent vs potential rent
 * Side-by-side bar comparison with renovation impact and AI analysis
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { loadGoogleMaps } from '../utils/googleMaps';
import { estimateVacancyForRentModel, estimateLeaseUpRecoveryForRent } from '../utils/rentalVacancyModel.js';

interface CompListing {
  id?: string;
  formattedAddress?: string;
  latitude?: number | null;
  longitude?: number | null;
  price?: number | null;
  daysOnMarket?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
  pricePerSqFt?: number | null;
  sizeAdjustedRent?: number | null;
  status?: string | null;
  distanceMiles?: number | null;
  compScore?: number | null;
  propertyType?: string | null;
}

interface BookkeepingTransaction {
  date?: string;
  description?: string;
  category?: string;
  type?: string;
  amount?: number | null;
}

interface BookkeepingCashflowPoint {
  month?: string;
  year?: number;
  revenue?: number | null;
  income?: number | null;
  totalIncome?: number | null;
}

interface MarketFactor {
  name: string;
  impact: number;
  description: string;
  source?: string;
  rawValue?: string;
  trend?: 'up' | 'down' | 'flat';
}

interface PricingPowerAssessment {
  score: number;
  pricingPowerPercent: number;
  pricingPowerDollar: number;
  marketPosition: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
}

interface PricingScenario {
  recommendedRent: number;
  currentVacancyRate: number;
  benchmarkVacancyRate?: number;
  recommendedVacancyRate: number;
  projectedRentGrowth: number;
  currentProjectedRentGrowth?: number;
  benchmarkProjectedRentGrowth?: number;
  recommendedProjectedRentGrowth?: number;
  monthlyRevenueUpside: number;
  annualRevenueUpside: number;
  objectiveHorizonYears?: number;
  objectiveNpvUpside?: number;
  objectiveLabel?: string;
  recommendationMode?: 'vacancy_recovery' | 'npv_optimization';
  vacancyRecovery?: {
    elapsedVacantDays: number;
    realizedVacancyPct: number;
    marketLeaseUpDays: number;
    subjectDomEvidenceWeight: number;
    currentExpectedAdditionalDays: number;
    benchmarkExpectedAdditionalDays: number;
    recommendedExpectedAdditionalDays: number;
    currentProjectedCampaignVacancyPct: number;
    recommendedProjectedCampaignVacancyPct: number;
    currentStabilizedVacancyRate: number;
    recommendedStabilizedVacancyRate: number;
    method: string;
  } | null;
  strategyOptions?: {
    maxReturn?: PricingStrategyOption;
    balanced?: PricingStrategyOption;
    vacancyRecovery?: PricingStrategyOption;
  };
  currentEffectiveAnnualRevenue?: number;
  benchmarkEffectiveAnnualRevenue?: number;
  recommendedEffectiveAnnualRevenue?: number;
  supportedCeilingRent?: number;
  rentAtFullVacancy?: number;
  fullVacancyReason?: string;
  demandScore: number;
  marketTightness: 'tight' | 'balanced' | 'soft';
  sliderMinRent?: number;
  sliderMaxRent?: number;
  vacancyModel?: {
    anchorRent: number;
    baseVacancyRate: number;
    compP25Rent?: number;
    compMedianRent?: number;
    compP75Rent?: number;
    compP90Rent?: number;
    compHighRent?: number;
    supportedCeilingRent?: number;
    rentAtFullVacancy?: number;
    demandAdjustment: number;
    domAdjustment: number;
    listingsAdjustment: number;
    mortgageAdjustment: number;
    sentimentAdjustment: number;
    employmentAdjustment: number;
    minVacancyRate: number;
    maxVacancyRate: number;
    subjectCurrentRent?: number | null;
    subjectDaysOnMarket?: number | null;
    subjectStaleThresholdDays?: number | null;
    subjectMarketingPressure?: number | null;
    subjectListingIsStale?: boolean;
    marketLeaseUpDays?: number | null;
    leaseUpPriceElasticity?: number | null;
    subjectDomEvidenceWeight?: number | null;
    domBins?: {
      bins: { avgRent: number; avgVacancy: number; avgDom: number; count: number }[];
      n: number;
      overallMedianVacancy: number;
    } | null;
  };
  growthModel?: {
    baseGrowthRate: number;
    recommendedGrowthRate?: number;
    compMedianRent: number;
    compP75Rent?: number;
    compP90Rent?: number;
    supportedCeilingRent?: number;
    rentAtFullVacancy?: number;
    minGrowthRate: number;
    maxGrowthRate: number;
  };
  summary: string;
}

interface PricingStrategyOption {
  rent: number;
  vacancyRate: number;
  effectiveAnnualRevenue: number;
  deltaVsCurrent: number;
  description: string;
}

interface PricingData {
  currentRent: number;
  marketPotentialRent: number;
  comparableRents: number[];
  marketAverage: number;
  percentileRank: number;
  marketFactors: MarketFactor[];
  pricingPower?: PricingPowerAssessment;
  scenario?: PricingScenario;
  comparableListings?: CompListing[];
  dataSources?: {
    rentcast?: boolean;
    fred?: boolean;
    listingComps?: boolean;
    listingCompSampleAdequate?: boolean;
    censusAcs?: boolean;
    conditionVision?: boolean;
    estimated?: boolean;
    rentcastUpdated?: string | null;
  };
  comparablesMethod?: {
    source?: string;
    matching?: string[];
    limitations?: string[];
    diagnostics?: Record<string, unknown>;
  };
  marketIntelligence?: {
    averageDaysOnMarket?: number | null;
    compAverageDaysOnMarket?: number | null;
    compFreshShare?: number | null;
    compStaleShare?: number | null;
    activeStatusShare?: number | null;
    listingChurnRate?: number | null;
    monthsOfSupply?: number | null;
    grossYieldPct?: number | null;
    priceToRentRatio?: number | null;
    saleVsRentDomSpread?: number | null;
    propertyTypePremiumPct?: number | null;
    rentSpreadRatio?: number | null;
  };
  vacancyEvidence?: {
    observedLocal?: Record<string, unknown> | null;
    liveMarket?: Record<string, unknown>;
    subject?: Record<string, unknown>;
    finalBaselineRate?: number;
  };
  conditionEvidence?: RentalConditionAnalysis | null;
  pricingAudit?: {
    version?: string;
    inputs?: Record<string, unknown>;
    comparableBenchmark?: Record<string, unknown>;
    conditionAdjustment?: Record<string, unknown>;
    vacancyModel?: Record<string, unknown>;
    optimizer?: Record<string, unknown>;
  };
  macroContext?: {
    mortgage15Rate: string | null;
    rentalVacancyRate: string | null;
    consumerSentiment: string | null;
    constructionPPI: string | null;
    employmentClaims: string | null;
  } | null;
}

interface RentalConditionAnalysis {
  conditionScore: number;
  conditionClass: string;
  confidence: number;
  coverageScore: number;
  photoCount: number;
  roomsObserved?: string[];
  strengths?: string[];
  deficiencies?: string[];
  missingCoverage?: string[];
  marketabilitySummary?: string;
  rentAdjustmentPct: number;
  adjustmentMethod?: string;
  rentAdjustmentDollar?: number;
  benchmarkBeforeAdjustment?: number;
  benchmarkAfterAdjustment?: number;
}

interface RentalPhotoInput {
  name: string;
  dataUrl: string;
}

interface RentalSubjectOverride {
  address: string;
  zipCode: string;
  latitude: number;
  longitude: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFeet?: number | null;
  yearBuilt?: number | null;
  propertyType?: string | null;
  listedRent?: number | null;
  daysOnMarket?: number | null;
  attomRentAvm?: number | null;
  attomRentLow?: number | null;
  attomRentHigh?: number | null;
}

interface AIAnalysisInsightCard {
  icon: string;
  title: string;
  value: string;
  subtext: string;
  color: 'green' | 'yellow' | 'red' | 'blue' | 'purple';
}

interface AIAnalysisResult {
  summary: string;
  situation: 'above_market' | 'at_market' | 'below_market';
  situationSeverity: 'significant' | 'moderate' | 'slight';
  marketComparison: {
    explanation: string;
    percentDifference: number;
    dollarDifference: number;
    marketPosition: string;
  };
  conditionAssessment?: {
    explanation: string;
    justifiesCurrentRent: boolean;
    conditionVsRentAlignment: string;
  };
  risks?: {
    title: string;
    description: string;
    severity: 'high' | 'medium' | 'low';
  }[];
  opportunities?: {
    title: string;
    description: string;
    potentialImpact: string;
  }[];
  financialImpact: {
    currentMonthlyCashFlow: number;
    potentialMonthlyCashFlow: number;
    annualDifference: number;
    fiveYearImpact: number;
    explanation: string;
  };
  recommendations: {
    primary: string;
    actions: {
      action: string;
      impact: string;
      priority: 'immediate' | 'short-term' | 'long-term';
    }[];
    suggestedRenovations?: {
      name: string;
      cost: number;
      rentJustification: number;
      reason: string;
    }[];
  };
  insightCards: AIAnalysisInsightCard[];
}

interface RentalPricingPowerGraphProps {
  propertyId?: string;
  currentRent?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  zipCode?: string;
  userId?: string;
  cachePropertyId?: string;
  latitude?: number;
  longitude?: number;
  propertyType?: string;
  yearBuilt?: number;
  schoolRating?: number;
  attomRentAvm?: number;
  attomRentLow?: number;
  attomRentHigh?: number;
  // Additional props for AI analysis
  conditionScore?: number;
  conditionGrade?: string;
  monthlyExpenses?: number;
  monthlyMortgage?: number;
  currentCashFlow?: number;
  vacancyRate?: number;
  bookkeepingTransactions?: BookkeepingTransaction[];
  bookkeepingCashflowTrend?: BookkeepingCashflowPoint[];
  onNavigateToRenovations?: () => void;
  pricingProjectionMode?: 'none' | 'market' | 'recommended' | 'custom';
  onPricingProjectionModeChange?: (mode: 'none' | 'market' | 'recommended' | 'custom') => void;
  focusAsset?: RentalPricingPowerAssetId;
  onPricingDataChange?: (data: {
    currentRent: number;
    marketPotentialRent: number;
    recommendedRent: number;
    currentVacancyRate: number;
    benchmarkVacancyRate?: number;
    recommendedVacancyRate: number;
    projectedRentGrowth: number;
    currentProjectedRentGrowth: number;
    benchmarkProjectedRentGrowth?: number;
    recommendedProjectedRentGrowth: number;
    annualRevenueUpside: number;
    benchmarkAnnualRevenueUpside?: number;
    recommendedAnnualRevenueUpside: number;
    pricingPowerScore: number;
    customRent?: number;
    customVacancyRate?: number;
    customProjectedRentGrowth?: number;
    customAnnualRevenueUpside?: number;
  }) => void;
}

export type RentalPricingPowerAssetId =
  | 'bar-comparison'
  | 'comparable-listings-map'
  | 'pricing-strategy'
  | 'interactive-rent-sweep'
  | 'pricing-model-metrics'
  | 'vacancy-cutoff'
  | 'renovation-separation'
  | 'market-conditions'
  | 'local-leasing-signals'
  | 'renovation-analysis-link';

function readPhotoAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(`Unable to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export default function RentalPricingPowerGraph({
  propertyId,
  currentRent = 1500,
  bedrooms = 3,
  bathrooms = 2,
  squareFeet = 1500,
  zipCode = '90210',
  userId,
  cachePropertyId,
  latitude,
  longitude,
  propertyType,
  yearBuilt,
  schoolRating,
  attomRentAvm,
  attomRentLow,
  attomRentHigh,
  conditionScore,
  conditionGrade,
  monthlyExpenses,
  monthlyMortgage,
  currentCashFlow,
  vacancyRate,
  bookkeepingTransactions = [],
  bookkeepingCashflowTrend = [],
  onNavigateToRenovations,
  pricingProjectionMode = 'none',
  onPricingProjectionModeChange,
  focusAsset,
  onPricingDataChange
}: RentalPricingPowerGraphProps) {
  const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const round1 = (value: number) => Math.round(value * 10) / 10;
  const parseNumberValue = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const formatMonthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const parseMonthKey = (value: string) => {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, 1);
  };
  const addMonths = (date: Date, delta: number) => new Date(date.getFullYear(), date.getMonth() + delta, 1);
  const monthDistance = (from: Date, to: Date) => ((to.getFullYear() - from.getFullYear()) * 12) + (to.getMonth() - from.getMonth());
  const monthNameToIndex = new Map([
    ['january', 0],
    ['february', 1],
    ['march', 2],
    ['april', 3],
    ['may', 4],
    ['june', 5],
    ['july', 6],
    ['august', 7],
    ['september', 8],
    ['october', 9],
    ['november', 10],
    ['december', 11],
  ]);
  const parseTrendMonthDate = (point: BookkeepingCashflowPoint) => {
    const monthName = String(point.month || '').toLowerCase();
    const monthIndex = monthNameToIndex.get(monthName);
    const yearValue = parseNumberValue(point.year);
    if (monthIndex == null || yearValue == null) return null;
    return new Date(yearValue, monthIndex, 1);
  };
  const bookkeepingTrendByMonth = useMemo(() => {
    const valuesByMonth = new Map<string, number>();
    bookkeepingCashflowTrend.forEach((point) => {
      const monthDate = parseTrendMonthDate(point);
      if (!monthDate) return;
      const revenue = parseNumberValue(point.revenue) ?? parseNumberValue(point.income) ?? parseNumberValue(point.totalIncome);
      if (revenue == null || revenue <= 0) return;
      valuesByMonth.set(formatMonthKey(monthDate), revenue);
    });
    return valuesByMonth;
  }, [bookkeepingCashflowTrend]);
  const bookkeepingTransactionsByMonth = useMemo(() => {
    const incomeTransactions = bookkeepingTransactions.filter((transaction) => {
      const amount = parseNumberValue(transaction.amount);
      if (amount == null || amount <= 0) return false;
      const transactionType = String(transaction.type || '').toLowerCase();
      return !transactionType.includes('expense');
    });
    const rentLikePattern = /\brent(?:al)?\b|\blease\b|\btenant\b/i;
    const rentTaggedTransactions = incomeTransactions.filter((transaction) => {
      const lookupText = `${transaction.category || ''} ${transaction.description || ''}`;
      return rentLikePattern.test(lookupText);
    });
    // Never silently substitute all property income for booked rent.
    const selectedIncomeTransactions = rentTaggedTransactions;
    const valuesByMonth = new Map<string, number>();
    selectedIncomeTransactions.forEach((transaction) => {
      const dateKey = String(transaction.date || '').slice(0, 7);
      const amount = parseNumberValue(transaction.amount);
      if (!dateKey || amount == null || amount <= 0) return;
      valuesByMonth.set(dateKey, (valuesByMonth.get(dateKey) || 0) + amount);
    });
    return valuesByMonth;
  }, [bookkeepingTransactions]);
  const actualRentObservationsByMonth = useMemo(() => {
    const valuesByMonth = new Map<string, number>();
    bookkeepingTransactionsByMonth.forEach((value, monthKey) => {
      valuesByMonth.set(monthKey, value);
    });
    return valuesByMonth;
  }, [bookkeepingTransactionsByMonth]);
  const latestBookkeepingActualRent = useMemo(() => {
    const latestEntry = Array.from(actualRentObservationsByMonth.entries())
      .sort(([leftMonth], [rightMonth]) => leftMonth.localeCompare(rightMonth))
      .pop();
    const latestValue = latestEntry?.[1] ?? null;
    return latestValue != null && latestValue > 0 ? Math.round(latestValue) : null;
  }, [actualRentObservationsByMonth]);

  // Asking rent for the model is explicit: manual override → property financials.
  // Bookkeeping history is kept for the trend chart only and never silently
  // replaces the current asking rent (it often belongs to another property).
  const [currentRentInput, setCurrentRentInput] = useState(
    Number.isFinite(currentRent) && currentRent > 0 ? String(Math.round(currentRent)) : '',
  );
  const [subjectAddressInput, setSubjectAddressInput] = useState(propertyId || '');
  const [subjectOverride, setSubjectOverride] = useState<RentalSubjectOverride | null>(null);
  const [subjectLookupLoading, setSubjectLookupLoading] = useState(false);
  const [subjectLookupError, setSubjectLookupError] = useState<string | null>(null);
  const [compsCacheNote, setCompsCacheNote] = useState<string | null>(null);
  const [appliedCurrentRent, setAppliedCurrentRent] = useState<number | null>(null);
  const [subjectDomInput, setSubjectDomInput] = useState('');
  const [appliedSubjectDaysOnMarket, setAppliedSubjectDaysOnMarket] = useState<number | null>(null);
  const [rentalPhotos, setRentalPhotos] = useState<RentalPhotoInput[]>([]);
  const [conditionAnalysis, setConditionAnalysis] = useState<RentalConditionAnalysis | null>(null);
  const [conditionAnalyzing, setConditionAnalyzing] = useState(false);
  const [conditionError, setConditionError] = useState<string | null>(null);

  useEffect(() => {
    const address = (subjectAddressInput || propertyId || '').trim();
    if (!address || subjectOverride) return;
    try {
      const raw = window.sessionStorage.getItem(`rent-subject:${address.toLowerCase()}`);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved?.subject?.zipCode || !saved?.subject?.latitude) return;
      if (Date.now() - Number(saved.savedAt || 0) > 12 * 60 * 60 * 1000) return;
      setSubjectOverride(saved.subject);
      setSubjectAddressInput(saved.subject.address || address);
      if (saved.currentRentInput) {
        setCurrentRentInput(String(saved.currentRentInput));
        const rentParsed = Number(saved.currentRentInput);
        if (Number.isFinite(rentParsed) && rentParsed > 0) setAppliedCurrentRent(Math.round(rentParsed));
      }
      if (saved.subjectDomInput != null && saved.subjectDomInput !== '') {
        setSubjectDomInput(String(saved.subjectDomInput));
        const domParsed = Number(saved.subjectDomInput);
        if (Number.isFinite(domParsed) && domParsed >= 0) setAppliedSubjectDaysOnMarket(domParsed);
      }
      setCompsCacheNote('Restored cached subject package for this address.');
    } catch {
      // Ignore corrupt session cache.
    }
  }, [propertyId, subjectAddressInput, subjectOverride]);

  const effectiveCurrentRent = appliedCurrentRent
    ?? (Number.isFinite(currentRent) && currentRent > 0 ? Math.round(currentRent) : 0);
  const currentRentSourceLabel = appliedCurrentRent != null
    ? 'Manual asking rent'
    : 'Property financials';
  const analysisAddress = subjectOverride?.address || propertyId;
  const analysisZipCode = subjectOverride?.zipCode || zipCode;
  const analysisLatitude = subjectOverride?.latitude ?? latitude;
  const analysisLongitude = subjectOverride?.longitude ?? longitude;
  const analysisBedrooms = subjectOverride?.bedrooms ?? bedrooms;
  const analysisBathrooms = subjectOverride?.bathrooms ?? bathrooms;
  const analysisSquareFeet = subjectOverride?.squareFeet ?? squareFeet;
  const analysisYearBuilt = subjectOverride?.yearBuilt ?? yearBuilt;
  const analysisPropertyType = subjectOverride?.propertyType || propertyType;
  const analysisAttomRentAvm = subjectOverride?.attomRentAvm ?? attomRentAvm;
  const analysisAttomRentLow = subjectOverride?.attomRentLow ?? attomRentLow;
  const analysisAttomRentHigh = subjectOverride?.attomRentHigh ?? attomRentHigh;

  const [loading, setLoading] = useState(true);
  const [pricingData, setPricingData] = useState<PricingData | null>(null);
  const [selectedRent, setSelectedRent] = useState(effectiveCurrentRent);
  
  // AI Analysis state
  const [aiAnalysis, setAiAnalysis] = useState<AIAnalysisResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [showAiAnalysis, setShowAiAnalysis] = useState(false);

  // Comp map state
  const [showCompMap, setShowCompMap] = useState(true);
  const [compMapReady, setCompMapReady] = useState(false);
  const compMapRef = useRef<HTMLDivElement>(null);
  const compMapInstanceRef = useRef<any>(null);
  const compMarkersRef = useRef<any[]>([]);

  // Preload Maps JS in parallel with pricing data fetch
  useEffect(() => {
    void loadGoogleMaps();
  }, []);

  const estimateVacancyForRent = (candidateRent: number, scenario?: PricingScenario) => {
    const model = scenario?.vacancyModel;
    const recoveryEstimate = estimateLeaseUpRecoveryForRent(candidateRent, model, {
      baseVacancyRate: scenario?.benchmarkVacancyRate ?? scenario?.currentVacancyRate ?? vacancyRate ?? 5,
    });
    if (model?.subjectListingIsStale && recoveryEstimate) {
      return recoveryEstimate.projectedCampaignVacancyPct;
    }
    const canonicalEstimate = estimateVacancyForRentModel(candidateRent, model, {
      baseVacancyRate: scenario?.benchmarkVacancyRate ?? scenario?.currentVacancyRate ?? vacancyRate ?? 5,
    });
    if (canonicalEstimate != null) return canonicalEstimate;

    if (model?.anchorRent) {
      if (model.rentAtFullVacancy && candidateRent >= model.rentAtFullVacancy) {
        return 100;
      }

      const rawMacroAdj = (model.demandAdjustment || 0)
        + (model.domAdjustment || 0)
        + (model.listingsAdjustment || 0)
        + (model.mortgageAdjustment || 0)
        + (model.sentimentAdjustment || 0)
        + (model.employmentAdjustment || 0);

      const compP25Rent = model.compP25Rent ?? Math.max(model.anchorRent * 0.94, 500);
      const supportedCeilingRent = model.supportedCeilingRent ?? Math.max(model.anchorRent * 1.16);
      const rejectionRent = model.rentAtFullVacancy ?? Math.max(supportedCeilingRent * 1.06);

      // ── Empirical path: interpolate from binned DOM data ─────────
      if (model.domBins && model.domBins.bins.length >= 2) {
        const bins = model.domBins.bins;
        const cappedMacroAdj = clamp(rawMacroAdj, -2.0, 2.0);

        // Find the minimum-vacancy bin — the "sweet spot" price tier where
        // listings absorb fastest. Cheap comp listings often have high DOM
        // because they're distressed or poor-quality, not because pricing
        // below market is hard to fill. Anchoring below-market discounts to
        // this sweet-spot bin prevents a spurious U-shaped vacancy curve.
        const minVacBinIdx = bins.reduce(
          (minIdx, bin, i) => bin.avgVacancy < bins[minIdx].avgVacancy ? i : minIdx, 0
        );
        const minVacBin = bins[minVacBinIdx];

        let empiricalRate: number;
        if (candidateRent <= minVacBin.avgRent) {
          // At or below the fastest-leasing tier: vacancy decreases
          // monotonically as rent drops further below the sweet spot.
          const discountRatio = minVacBin.avgRent > 0
            ? clamp((minVacBin.avgRent - candidateRent) / minVacBin.avgRent, 0, 0.3)
            : 0;
          empiricalRate = minVacBin.avgVacancy - discountRatio * 8;
        } else if (candidateRent >= bins[bins.length - 1].avgRent) {
          const lastBin = bins[bins.length - 1];
          const prevBin = bins[bins.length - 2];
          const binSlope = lastBin.avgRent !== prevBin.avgRent
            ? (lastBin.avgVacancy - prevBin.avgVacancy) / (lastBin.avgRent - prevBin.avgRent)
            : 0;
          const extrapolationSlope = Math.max(binSlope, 0.002);
          empiricalRate = lastBin.avgVacancy + extrapolationSlope * (candidateRent - lastBin.avgRent);

          if (candidateRent > supportedCeilingRent) {
            const ceilingRate = lastBin.avgVacancy + extrapolationSlope * (supportedCeilingRent - lastBin.avgRent);
            const progress = clamp(
              (candidateRent - supportedCeilingRent) / Math.max(rejectionRent - supportedCeilingRent, 1),
              0, 0.999
            );
            empiricalRate = ceilingRate + progress * (80 - ceilingRate);
          }
        } else {
          // Between minVacBin and the highest bin: interpolate upward only.
          // Starting at minVacBinIdx ensures vacancy only rises as rent rises.
          empiricalRate = minVacBin.avgVacancy;
          for (let i = minVacBinIdx; i < bins.length - 1; i++) {
            if (candidateRent >= bins[i].avgRent && candidateRent <= bins[i + 1].avgRent) {
              const span = Math.max(bins[i + 1].avgRent - bins[i].avgRent, 1);
              const progress = (candidateRent - bins[i].avgRent) / span;
              empiricalRate = bins[i].avgVacancy + progress * (bins[i + 1].avgVacancy - bins[i].avgVacancy);
              break;
            }
          }
        }

        empiricalRate += cappedMacroAdj;
        return round1(clamp(empiricalRate, model.minVacancyRate, Math.max(model.maxVacancyRate, 100)));
      }

      // ── Fallback: synthetic piecewise curve ──────────────────────
      const cappedMacroAdj = clamp(rawMacroAdj, -3.5, 3.5);
      let rate = model.baseVacancyRate + cappedMacroAdj;

      const compMedianRent = model.compMedianRent ?? model.anchorRent;
      const compP75Rent = model.compP75Rent ?? Math.max(compMedianRent, model.anchorRent * 1.04);
      const compP90Rent = model.compP90Rent ?? Math.max(compP75Rent, model.anchorRent * 1.08);

      if (candidateRent <= compP25Rent) {
        const discountRatio = compP25Rent > 0 ? (compP25Rent - candidateRent) / compP25Rent : 0;
        rate -= Math.min(3, discountRatio * 10);
      } else if (candidateRent <= compMedianRent) {
        const span = Math.max(compMedianRent - compP25Rent, 1);
        const progress = (candidateRent - compP25Rent) / span;
        rate -= 1.4 - progress * 1.4;
      } else if (candidateRent <= compP75Rent) {
        const span = Math.max(compP75Rent - compMedianRent, 1);
        const progress = (candidateRent - compMedianRent) / span;
        rate += progress * 1.5;
      } else if (candidateRent <= compP90Rent) {
        const span = Math.max(compP90Rent - compP75Rent, 1);
        const progress = (candidateRent - compP75Rent) / span;
        rate += 1.5 + progress * 4.0;
      } else if (candidateRent <= supportedCeilingRent) {
        const span = Math.max(supportedCeilingRent - compP90Rent, 1);
        const progress = (candidateRent - compP90Rent) / span;
        rate += 5.5 + progress * 7.0;
      } else {
        const progress = clamp(
          (candidateRent - supportedCeilingRent) / Math.max(rejectionRent - supportedCeilingRent, 1),
          0,
          0.999
        );

        if (progress >= 0.82) {
          rate = Math.max(rate, 35);
        } else if (progress >= 0.5) {
          rate = Math.max(rate, 28);
        } else if (progress >= 0.2) {
          rate = Math.max(rate, 22);
        } else {
          rate = Math.max(rate, 16 + progress * 12);
        }
      }

      return round1(clamp(rate, model.minVacancyRate, Math.max(model.maxVacancyRate, 100)));
    }

    const fallbackAnchorRent = pricingData?.marketPotentialRent || scenario?.recommendedRent || effectiveCurrentRent;
    const baseVacancy = scenario?.benchmarkVacancyRate ?? scenario?.currentVacancyRate ?? (vacancyRate ?? 5);
    const compP25Rent = fallbackAnchorRent * 0.94;
    const compMedianRent = fallbackAnchorRent;
    const compP75Rent = fallbackAnchorRent * 1.04;
    const compP90Rent = fallbackAnchorRent * 1.08;
    const compHighRent = fallbackAnchorRent * 1.12;
    const supportedCeilingRent = fallbackAnchorRent * 1.18;
    const rejectionRent = fallbackAnchorRent * 1.32;
    let rate = baseVacancy;

    if (candidateRent >= rejectionRent) {
      return 100;
    }

    if (candidateRent <= compP25Rent) {
      const discountRatio = compP25Rent > 0 ? (compP25Rent - candidateRent) / compP25Rent : 0;
      rate -= Math.min(3, discountRatio * 10);
    } else if (candidateRent <= compMedianRent) {
      const span = Math.max(compMedianRent - compP25Rent, 1);
      const progress = (candidateRent - compP25Rent) / span;
      rate -= 1.4 - progress * 1.4;
    } else if (candidateRent <= compP75Rent) {
      const span = Math.max(compP75Rent - compMedianRent, 1);
      const progress = (candidateRent - compMedianRent) / span;
      rate += progress * 1.5;
    } else if (candidateRent <= compP90Rent) {
      const span = Math.max(compP90Rent - compP75Rent, 1);
      const progress = (candidateRent - compP75Rent) / span;
      rate += 1.5 + progress * 4.0;
    } else if (candidateRent <= supportedCeilingRent) {
      const span = Math.max(supportedCeilingRent - compP90Rent, 1);
      const progress = (candidateRent - compP90Rent) / span;
      rate += 5.5 + progress * 7.0;
    } else {
      const progress = clamp(
        (candidateRent - supportedCeilingRent) / Math.max(rejectionRent - supportedCeilingRent, 1),
        0,
        0.999
      );

      if (progress >= 0.82) {
        rate = Math.max(rate, 35);
      } else if (progress >= 0.5) {
        rate = Math.max(rate, 28);
      } else if (progress >= 0.2) {
        rate = Math.max(rate, 22);
      } else {
        rate = Math.max(rate, 16 + progress * 12);
      }
    }

    return round1(clamp(rate, 2, 100));
  };

  const estimateProjectedGrowthForRent = (candidateRent: number, candidateVacancyRate: number, scenario?: PricingScenario) => {
    const growthModel = scenario?.growthModel;
    if (growthModel?.compMedianRent) {
      let candidateGrowth = growthModel.baseGrowthRate;
      const compMedianRent = growthModel.compMedianRent;
      const compP90Rent = growthModel.compP90Rent ?? Math.max(compMedianRent, compMedianRent * 1.08);
      const premiumRatio = compMedianRent > 0 ? (candidateRent - compMedianRent) / compMedianRent : 0;

      if (premiumRatio > 0) {
        candidateGrowth -= Math.min(1.8, premiumRatio * 4.8);
      } else {
        candidateGrowth += Math.min(0.45, Math.abs(premiumRatio) * 1.2);
      }

      if (candidateRent >= compP90Rent) candidateGrowth -= 0.4;
      if (candidateVacancyRate >= 20) candidateGrowth -= 0.6;
      if (candidateVacancyRate >= 40) candidateGrowth -= 1.2;

      return round1(clamp(candidateGrowth, growthModel.minGrowthRate, growthModel.maxGrowthRate));
    }

    const fallbackBaseGrowth = scenario?.projectedRentGrowth ?? 3;
    const fallbackAnchorRent = pricingData?.marketPotentialRent || scenario?.recommendedRent || effectiveCurrentRent;
    const premiumRatio = fallbackAnchorRent > 0 ? (candidateRent - fallbackAnchorRent) / fallbackAnchorRent : 0;
    let candidateGrowth = fallbackBaseGrowth;
    if (premiumRatio > 0) candidateGrowth -= Math.min(1.2, premiumRatio * 4);
    else candidateGrowth += Math.min(0.3, Math.abs(premiumRatio));
    if (candidateVacancyRate >= 20) candidateGrowth -= 0.6;
    return round1(clamp(candidateGrowth, 0.5, 6.5));
  };

  const lookupRentalSubject = async () => {
    const address = subjectAddressInput.trim();
    if (!address) {
      setSubjectLookupError('Enter the full rental property address.');
      return;
    }
    setSubjectLookupLoading(true);
    setSubjectLookupError(null);
    setLoading(true);
    // Clear stale portfolio-property comps immediately so the UI does not keep
    // showing the previously selected home while the subject package loads.
    setPricingData(null);

    const rentParsed = Number(currentRentInput);
    if (Number.isFinite(rentParsed) && rentParsed > 0) {
      setAppliedCurrentRent(Math.round(rentParsed));
    }
    const domParsed = Number(subjectDomInput);
    if (Number.isFinite(domParsed) && domParsed >= 0) {
      setAppliedSubjectDaysOnMarket(domParsed);
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`${baseUrl}/api/market-analysis/rent-subject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          address,
          userId: userId || null,
          warmComps: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Unable to resolve the rental property.');
      }
      setSubjectOverride(payload.subject);
      setSubjectAddressInput(payload.subject.address || address);
      try {
        window.sessionStorage.setItem(
          `rent-subject:${String(payload.subject.address || address).toLowerCase()}`,
          JSON.stringify({
            subject: payload.subject,
            currentRentInput,
            subjectDomInput,
            savedAt: Date.now(),
          }),
        );
      } catch {
        // Ignore private-mode / quota failures.
      }
      if (payload.compsCache?.warmed) {
        setCompsCacheNote(
          payload.compsCache.fromCache
            ? `Using cached comps (${payload.compsCache.matchedCount} listings).`
            : `Cached ${payload.compsCache.matchedCount} comps for this subject.`,
        );
      } else {
        setCompsCacheNote('Subject loaded. Comp cache will populate with the pricing refresh.');
      }
      if (Number.isFinite(Number(payload.subject.listedRent)) && Number(payload.subject.listedRent) > 0 && !currentRentInput) {
        const listedRent = Math.round(Number(payload.subject.listedRent));
        setCurrentRentInput(String(listedRent));
        setAppliedCurrentRent(listedRent);
      }
      if (Number.isFinite(Number(payload.subject.daysOnMarket)) && Number(payload.subject.daysOnMarket) >= 0 && !subjectDomInput) {
        const daysOnMarket = Number(payload.subject.daysOnMarket);
        setSubjectDomInput(String(daysOnMarket));
        setAppliedSubjectDaysOnMarket(daysOnMarket);
      }
      setRentalPhotos([]);
      setConditionAnalysis(null);
      setConditionError(null);
      if (payload.compsCache?.warmed) {
        setSubjectLookupError(null);
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      setSubjectLookupError(
        aborted
          ? 'Property lookup timed out. Try again — cached subjects should load faster on retry.'
          : (error instanceof Error ? error.message : 'Subject lookup failed.'),
      );
      setLoading(false);
    } finally {
      window.clearTimeout(timeoutId);
      setSubjectLookupLoading(false);
    }
  };

  const handleRentalPhotoSelection = async (files: FileList | null) => {
    if (!files?.length) return;
    setConditionError(null);
    const selected = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .filter((file) => file.size <= 8 * 1024 * 1024)
      .slice(0, 12);
    try {
      const photos = await Promise.all(
        selected.map(async (file) => ({ name: file.name, dataUrl: await readPhotoAsDataUrl(file) })),
      );
      setRentalPhotos(photos);
      setConditionAnalysis(null);
    } catch (error) {
      setConditionError(error instanceof Error ? error.message : 'Unable to read property photos.');
    }
  };

  const analyzeRentalPhotos = async () => {
    if (!rentalPhotos.length) {
      setConditionError('Choose at least one property photo.');
      return;
    }
    setConditionAnalyzing(true);
    setConditionError(null);
    try {
      const response = await fetch(`${baseUrl}/api/market-analysis/rent-condition-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: rentalPhotos.map((photo) => photo.dataUrl),
          property: {
            address: analysisAddress,
            propertyType: analysisPropertyType,
            bedrooms: analysisBedrooms,
            bathrooms: analysisBathrooms,
            squareFeet: analysisSquareFeet,
            yearBuilt: analysisYearBuilt,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Photo condition analysis failed.');
      }
      setConditionAnalysis(payload.analysis);
    } catch (error) {
      setConditionError(error instanceof Error ? error.message : 'Photo condition analysis failed.');
    } finally {
      setConditionAnalyzing(false);
    }
  };

  // Fetch market data and calculate potential rent
  useEffect(() => {
    const controller = new AbortController();
    const fetchPricingData = async () => {
      setLoading(true);
      try {
        // Try to fetch real market data
        const response = await fetch(`${baseUrl}/api/market-analysis/rent-potential`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            propertyId: analysisAddress,
            currentRent: effectiveCurrentRent,
            bedrooms: analysisBedrooms,
            bathrooms: analysisBathrooms,
            squareFeet: analysisSquareFeet,
            zipCode: analysisZipCode,
            userId,
            cachePropertyId: subjectOverride ? analysisAddress : cachePropertyId,
            latitude: analysisLatitude,
            longitude: analysisLongitude,
            propertyType: analysisPropertyType,
            yearBuilt: analysisYearBuilt,
            schoolRating,
            subjectDaysOnMarket: appliedSubjectDaysOnMarket,
            conditionAnalysis,
            attomRentAvm: analysisAttomRentAvm,
            attomRentLow: analysisAttomRentLow,
            attomRentHigh: analysisAttomRentHigh
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (!controller.signal.aborted) setPricingData(data);
        } else {
          // Use calculated estimates based on property attributes
          if (!controller.signal.aborted) generateEstimatedData();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        // Fallback to estimated data
        generateEstimatedData();
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    const generateEstimatedData = () => {
      const pricePerSqFt = effectiveCurrentRent / analysisSquareFeet;
      const marketPricePerSqFt = pricePerSqFt * 1.12;
      const marketPotentialRent = Math.round(analysisSquareFeet * marketPricePerSqFt);

      const comparableRents = [0.85, 0.9, 0.94, 0.97, 0.99, 1, 1.01, 1.03, 1.06, 1.1, 1.15]
        .map((ratio) => Math.round(marketPotentialRent * ratio));

      const marketAverage = Math.round(comparableRents.reduce((a, b) => a + b, 0) / comparableRents.length);
      const percentileRank = Math.round((comparableRents.filter(r => r < effectiveCurrentRent).length / comparableRents.length) * 100);

      const marketFactors = [
        { name: 'Location Score', impact: 85, description: 'Neighborhood desirability' },
        { name: 'School District', impact: 72, description: 'Quality of nearby schools' },
        { name: 'Amenities', impact: 65, description: 'In-unit and building features' },
        { name: 'Condition', impact: 78, description: 'Property condition rating' },
        { name: 'Market Demand', impact: 88, description: 'Local rental market activity' }
      ];

      const estimatedCurrentVacancyRate = Math.max(2.5, Math.min(9, (vacancyRate ?? 5) + (effectiveCurrentRent > marketPotentialRent ? 1.5 : -0.4)));
      const recommendedRent = marketPotentialRent;
      const recommendedVacancyRate = Math.max(2.5, Math.min(7.5, estimatedCurrentVacancyRate - 0.8));
      const benchmarkEffectiveAnnualRevenue = marketPotentialRent * 12 * (1 - estimatedCurrentVacancyRate / 100);
      const annualRevenueUpside = Math.round(
        recommendedRent * 12 * (1 - recommendedVacancyRate / 100) -
        effectiveCurrentRent * 12 * (1 - estimatedCurrentVacancyRate / 100)
      );
      const pricingPowerDollar = recommendedRent - effectiveCurrentRent;

      setPricingData({
        currentRent: effectiveCurrentRent,
        marketPotentialRent,
        comparableRents,
        marketAverage,
        percentileRank,
        marketFactors,
        dataSources: {
          rentcast: false,
          fred: false,
          listingComps: false,
          listingCompSampleAdequate: false,
          estimated: true,
        },
        pricingPower: {
          score: Math.max(20, Math.min(95, Math.round(55 + (pricingPowerDollar / Math.max(effectiveCurrentRent, 1)) * 220))),
          pricingPowerPercent: Math.round((pricingPowerDollar / Math.max(effectiveCurrentRent, 1)) * 1000) / 10,
          pricingPowerDollar,
          marketPosition: pricingPowerDollar >= 0 ? 'some pricing power remains' : 'current pricing is likely above market support',
          explanation: pricingPowerDollar >= 0
            ? `Estimated benchmark rent is about $${pricingPowerDollar.toLocaleString()}/mo above current pricing based on comparable inventory.`
            : `Current pricing appears to be ahead of the local benchmark once lease-up risk is considered.`,
          confidence: 'low'
        },
        scenario: {
          recommendedRent,
          currentVacancyRate: Math.round(estimatedCurrentVacancyRate * 10) / 10,
          benchmarkVacancyRate: Math.round(estimatedCurrentVacancyRate * 10) / 10,
          recommendedVacancyRate: Math.round(recommendedVacancyRate * 10) / 10,
          projectedRentGrowth: 3.2,
          currentProjectedRentGrowth: 3,
          benchmarkProjectedRentGrowth: 3.1,
          recommendedProjectedRentGrowth: 3.2,
          monthlyRevenueUpside: Math.round(annualRevenueUpside / 12),
          annualRevenueUpside,
          currentEffectiveAnnualRevenue: Math.round(effectiveCurrentRent * 12 * (1 - estimatedCurrentVacancyRate / 100)),
          benchmarkEffectiveAnnualRevenue: Math.round(benchmarkEffectiveAnnualRevenue),
          recommendedEffectiveAnnualRevenue: Math.round(recommendedRent * 12 * (1 - recommendedVacancyRate / 100)),
          demandScore: 68,
          marketTightness: 'balanced',
          sliderMinRent: Math.max(500, Math.floor(Math.min(effectiveCurrentRent, marketPotentialRent) * 0.85 / 25) * 25),
          sliderMaxRent: Math.ceil(Math.max(effectiveCurrentRent, recommendedRent) * 1.35 / 25) * 25,
          supportedCeilingRent: Math.round(marketPotentialRent * 1.18),
          rentAtFullVacancy: Math.round(marketPotentialRent * 1.32),
          fullVacancyReason: 'Fallback estimate assumes the listing becomes functionally unleaseable once asking rent moves well above the local comp range.',
          vacancyModel: {
            anchorRent: marketPotentialRent,
            baseVacancyRate: Math.round(estimatedCurrentVacancyRate * 10) / 10,
            compP25Rent: Math.round(marketPotentialRent * 0.94),
            compMedianRent: marketPotentialRent,
            compP75Rent: Math.round(marketPotentialRent * 1.04),
            compP90Rent: Math.round(marketPotentialRent * 1.08),
            compHighRent: Math.round(marketPotentialRent * 1.12),
            supportedCeilingRent: Math.round(marketPotentialRent * 1.18),
            rentAtFullVacancy: Math.round(marketPotentialRent * 1.32),
            demandAdjustment: 0,
            domAdjustment: 0,
            listingsAdjustment: 0,
            mortgageAdjustment: 0,
            sentimentAdjustment: 0,
            employmentAdjustment: 0,
            minVacancyRate: 2,
            maxVacancyRate: 100,
          },
          growthModel: {
            baseGrowthRate: 3.1,
            recommendedGrowthRate: 3.2,
            compMedianRent: marketPotentialRent,
            compP75Rent: Math.round(marketPotentialRent * 1.04),
            compP90Rent: Math.round(marketPotentialRent * 1.08),
            supportedCeilingRent: Math.round(marketPotentialRent * 1.18),
            rentAtFullVacancy: Math.round(marketPotentialRent * 1.32),
            minGrowthRate: 0.5,
            maxGrowthRate: 6.5,
          },
          summary: `Estimated revenue is stronger closer to $${recommendedRent.toLocaleString()}/mo than at the current pricing once vacancy is considered.`
        }
      });
    };

    fetchPricingData();
    return () => controller.abort();
  }, [analysisAddress, effectiveCurrentRent, analysisBedrooms, analysisBathrooms, analysisSquareFeet, analysisZipCode, userId, cachePropertyId, subjectOverride, analysisLatitude, analysisLongitude, analysisPropertyType, analysisYearBuilt, schoolRating, appliedSubjectDaysOnMarket, conditionAnalysis, analysisAttomRentAvm, analysisAttomRentLow, analysisAttomRentHigh]);

  useEffect(() => {
    setAppliedCurrentRent(null);
    setCurrentRentInput(Number.isFinite(currentRent) && currentRent > 0 ? String(Math.round(currentRent)) : '');
    setSubjectAddressInput(propertyId || '');
    setSubjectOverride(null);
    setSubjectLookupError(null);
    setCompsCacheNote(null);
    setSubjectDomInput('');
    setAppliedSubjectDaysOnMarket(null);
    setRentalPhotos([]);
    setConditionAnalysis(null);
    setConditionError(null);
  }, [propertyId, currentRent]);

  useEffect(() => {
    setSelectedRent(effectiveCurrentRent);
  }, [effectiveCurrentRent, propertyId]);

  // Initialize/update comparable listings map
  useEffect(() => {
    if (!showCompMap) return;
    const comps = (pricingData?.comparableListings ?? []).filter(
      (c): c is CompListing & { latitude: number; longitude: number } =>
        typeof c.latitude === 'number' && typeof c.longitude === 'number'
    );
    if (!comps.length) {
      setCompMapReady(false);
      return;
    }

    let mounted = true;
    setCompMapReady(false);
    const marketRent = pricingData?.marketPotentialRent ?? effectiveCurrentRent;

    const initCompMap = async () => {
      await loadGoogleMaps();
      const mapHost = compMapRef.current;
      if (!mapHost || !mounted) return;

      const center =
        analysisLatitude && analysisLongitude
          ? { lat: analysisLatitude, lng: analysisLongitude }
          : { lat: comps[0].latitude, lng: comps[0].longitude };

      const existingMap = compMapInstanceRef.current;
      if (!existingMap || existingMap.getDiv?.() !== mapHost) {
        compMapInstanceRef.current = new (window as any).google.maps.Map(mapHost, {
          center,
          zoom: 13,
          mapTypeId: 'roadmap',
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
        });
      }

      const map = compMapInstanceRef.current;

      // Clear existing markers
      compMarkersRef.current.forEach((m) => m.setMap(null));
      compMarkersRef.current = [];

      // Subject property marker
      if (analysisLatitude && analysisLongitude) {
        const subjectMarker = new (window as any).google.maps.Marker({
          position: { lat: analysisLatitude, lng: analysisLongitude },
          map,
          title: 'Your Property',
          zIndex: 1000,
          icon: {
            path: (window as any).google.maps.SymbolPath.CIRCLE,
            scale: 12,
            fillColor: '#111827',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 3,
          },
        });
        const subjectInfo = new (window as any).google.maps.InfoWindow({
          content: `<div style="font-family:sans-serif;padding:6px 10px;min-width:140px">
            <div style="font-weight:700;color:#1e3a5f;margin-bottom:4px">&#128205; Your Property</div>
            <div style="color:#374151;font-size:13px">Current Rent: <b>$${effectiveCurrentRent.toLocaleString()}/mo</b></div>
          </div>`,
        });
        subjectMarker.addListener('click', () => subjectInfo.open(map, subjectMarker));
        compMarkersRef.current.push(subjectMarker);
      }

      // Comp markers
      comps.forEach((comp) => {
        const price = comp.price ?? 0;
        let fillColor = '#6b7280';
        if (price <= effectiveCurrentRent * 1.05) fillColor = '#3b82f6';
        else if (price <= marketRent * 1.05) fillColor = '#8b5cf6';
        else fillColor = '#10b981';

        const marker = new (window as any).google.maps.Marker({
          position: { lat: comp.latitude, lng: comp.longitude },
          map,
          title: comp.formattedAddress || 'Comparable',
          icon: {
            path: (window as any).google.maps.SymbolPath.CIRCLE,
            scale: 9,
            fillColor,
            fillOpacity: 0.9,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        });

        const details = [
          comp.bedrooms != null ? `${comp.bedrooms} bd / ${comp.bathrooms ?? '?'} ba` : null,
          comp.squareFootage ? `${comp.squareFootage.toLocaleString()} sqft` : null,
          comp.pricePerSqFt ? `$${comp.pricePerSqFt.toFixed(2)}/sqft` : null,
          comp.daysOnMarket != null ? `${comp.daysOnMarket} DOM` : null,
          comp.status || null,
          comp.distanceMiles != null ? `${comp.distanceMiles.toFixed(2)} mi away` : null,
        ]
          .filter(Boolean)
          .join(' &middot; ');

        const infoWindow = new (window as any).google.maps.InfoWindow({
          content: `<div style="font-family:sans-serif;padding:6px 10px;min-width:170px">
            <div style="font-weight:700;color:#1e3a5f;margin-bottom:4px;font-size:12px">${comp.formattedAddress || 'Comparable'}</div>
            <div style="color:#059669;font-size:15px;font-weight:700;margin-bottom:4px">$${price.toLocaleString()}/mo</div>
            ${details ? `<div style="color:#6b7280;font-size:12px">${details}</div>` : ''}
          </div>`,
        });
        marker.addListener('click', () => infoWindow.open(map, marker));
        compMarkersRef.current.push(marker);
      });

      // Fit bounds to all markers
      const bounds = new (window as any).google.maps.LatLngBounds();
      comps.forEach((c) => bounds.extend({ lat: c.latitude, lng: c.longitude }));
      if (analysisLatitude && analysisLongitude) {
        bounds.extend({ lat: analysisLatitude, lng: analysisLongitude });
      }
      map.fitBounds(bounds);

      requestAnimationFrame(() => {
        if (!mounted || !compMapInstanceRef.current) return;
        (window as any).google.maps.event.trigger(compMapInstanceRef.current, 'resize');
        compMapInstanceRef.current.fitBounds(bounds);
        setCompMapReady(true);
      });
    };

    initCompMap();
    return () => {
      mounted = false;
      compMarkersRef.current.forEach((marker) => marker.setMap(null));
      compMarkersRef.current = [];
    };
  }, [showCompMap, pricingData?.comparableListings, analysisLatitude, analysisLongitude, effectiveCurrentRent, pricingData?.marketPotentialRent]);

  // Report pricing data changes to parent for analytics integration
  const onPricingDataChangeRef = useRef(onPricingDataChange);
  onPricingDataChangeRef.current = onPricingDataChange;
  const sliderMinRent = pricingData?.scenario?.sliderMinRent
    ?? Math.max(500, Math.floor(Math.min(effectiveCurrentRent, pricingData?.marketPotentialRent ?? effectiveCurrentRent) * 0.85 / 25) * 25);
  const sliderMaxRent = pricingData?.scenario?.sliderMaxRent
    ?? Math.ceil(Math.max(effectiveCurrentRent, pricingData?.scenario?.recommendedRent ?? pricingData?.marketPotentialRent ?? effectiveCurrentRent) * 1.08 / 25) * 25;
  const sliderStep = 25;
  const normalizedSelectedRent = Math.round(clamp(selectedRent, sliderMinRent, sliderMaxRent) / sliderStep) * sliderStep;
  const selectedVacancyRate = pricingData
    ? estimateVacancyForRent(normalizedSelectedRent, pricingData.scenario)
    : (vacancyRate ?? 5);
  const selectedLeaseUpRecovery = pricingData?.scenario?.recommendationMode === 'vacancy_recovery'
    ? estimateLeaseUpRecoveryForRent(
      normalizedSelectedRent,
      pricingData.scenario.vacancyModel,
      { baseVacancyRate: pricingData.scenario.benchmarkVacancyRate ?? vacancyRate ?? 5 },
    )
    : null;
  const selectedProjectedRentGrowth = pricingData
    ? estimateProjectedGrowthForRent(normalizedSelectedRent, selectedVacancyRate, pricingData.scenario)
    : 3;
  const currentEffectiveAnnualRevenue = pricingData?.scenario?.currentEffectiveAnnualRevenue
    ?? (effectiveCurrentRent * 12 * (1 - (pricingData?.scenario?.currentVacancyRate ?? vacancyRate ?? 5) / 100));
  const benchmarkEffectiveAnnualRevenue = pricingData?.scenario?.benchmarkEffectiveAnnualRevenue
    ?? ((pricingData?.marketPotentialRent ?? effectiveCurrentRent) * 12 * (1 - (pricingData?.scenario?.benchmarkVacancyRate ?? pricingData?.scenario?.currentVacancyRate ?? vacancyRate ?? 5) / 100));
  const selectedEffectiveAnnualRevenue = selectedLeaseUpRecovery
    ? normalizedSelectedRent * 12 * (1 - selectedLeaseUpRecovery.expectedAdditionalLeaseUpDays / 365)
    : normalizedSelectedRent * 12 * (1 - selectedVacancyRate / 100);
  const benchmarkAnnualRevenueUpside = Math.round(benchmarkEffectiveAnnualRevenue - currentEffectiveAnnualRevenue);
  const selectedAnnualRevenueUpside = Math.round(selectedEffectiveAnnualRevenue - currentEffectiveAnnualRevenue);

  useEffect(() => {
    if (pricingData && onPricingDataChangeRef.current) {
      const scenario = pricingData.scenario;
      const scenarioCurrentEffectiveAnnualRevenue = scenario?.currentEffectiveAnnualRevenue ?? currentEffectiveAnnualRevenue;
      const scenarioBenchmarkEffectiveAnnualRevenue = scenario?.benchmarkEffectiveAnnualRevenue ?? benchmarkEffectiveAnnualRevenue;
      onPricingDataChangeRef.current({
        currentRent: effectiveCurrentRent,
        marketPotentialRent: pricingData.marketPotentialRent,
        recommendedRent: scenario?.recommendedRent ?? pricingData.marketPotentialRent,
        currentVacancyRate: scenario?.currentVacancyRate ?? (vacancyRate ?? 5),
        benchmarkVacancyRate: scenario?.benchmarkVacancyRate,
        recommendedVacancyRate: scenario?.recommendedVacancyRate ?? (vacancyRate ?? 5),
        projectedRentGrowth: scenario?.projectedRentGrowth ?? 3,
        currentProjectedRentGrowth: scenario?.currentProjectedRentGrowth ?? scenario?.projectedRentGrowth ?? 3,
        benchmarkProjectedRentGrowth: scenario?.benchmarkProjectedRentGrowth ?? scenario?.projectedRentGrowth ?? 3,
        recommendedProjectedRentGrowth: scenario?.recommendedProjectedRentGrowth ?? scenario?.projectedRentGrowth ?? 3,
        annualRevenueUpside: scenario?.annualRevenueUpside ?? 0,
        benchmarkAnnualRevenueUpside: Math.round(scenarioBenchmarkEffectiveAnnualRevenue - scenarioCurrentEffectiveAnnualRevenue),
        recommendedAnnualRevenueUpside: scenario?.annualRevenueUpside ?? 0,
        pricingPowerScore: pricingData.pricingPower?.score ?? 50,
        customRent: normalizedSelectedRent,
        customVacancyRate: selectedVacancyRate,
        customProjectedRentGrowth: selectedProjectedRentGrowth,
        customAnnualRevenueUpside: selectedAnnualRevenueUpside,
      });
    }
  }, [benchmarkEffectiveAnnualRevenue, currentEffectiveAnnualRevenue, effectiveCurrentRent, normalizedSelectedRent, pricingData, selectedAnnualRevenueUpside, selectedProjectedRentGrowth, selectedVacancyRate, vacancyRate]);

  // Fetch AI analysis
  const fetchAIAnalysis = async () => {
    if (!pricingData) return;
    
    setAiLoading(true);
    try {
      const response = await fetch(`${baseUrl}/api/rental-pricing/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentRent: effectiveCurrentRent,
          marketPotentialRent: pricingData.marketPotentialRent,
          marketAverage: pricingData.marketAverage,
          bedrooms,
          bathrooms,
          squareFeet,
          propertyAddress: propertyId,
          zipCode,
          conditionScore,
          conditionGrade,
          monthlyExpenses,
          monthlyMortgage,
          currentCashFlow,
          vacancyRate,
          recommendedRent: pricingData.scenario?.recommendedRent,
          estimatedCurrentVacancyRate: pricingData.scenario?.currentVacancyRate,
          estimatedRecommendedVacancyRate: pricingData.scenario?.recommendedVacancyRate,
          comparableRents: pricingData.comparableRents,
          percentileRank: pricingData.percentileRank
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.analysis) {
          setAiAnalysis(data.analysis);
          setShowAiAnalysis(true);
        }
      }
    } catch (err) {
      console.error('[RentalPricingAI] Error fetching analysis:', err);
    } finally {
      setAiLoading(false);
    }
  };

  // Get color class for insight cards
  const getCardColorClasses = (color: string) => {
    switch (color) {
      case 'green': return 'bg-green-50 border-green-200 text-green-700';
      case 'yellow': return 'bg-yellow-50 border-yellow-200 text-yellow-700';
      case 'red': return 'bg-red-50 border-red-200 text-red-700';
      case 'blue': return 'bg-blue-50 border-blue-200 text-blue-700';
      case 'purple': return 'bg-purple-50 border-purple-200 text-purple-700';
      default: return 'bg-gray-50 border-gray-200 text-gray-700';
    }
  };

  if (loading) {
    if (focusAsset === 'comparable-listings-map') {
      return (
        <div className="rounded-xl border bg-white p-5">
          <div className="h-4 bg-gray-200 rounded w-56 mb-3 animate-pulse" />
          <div className="rounded-lg border border-gray-200 bg-gray-100 animate-pulse flex items-center justify-center text-sm text-gray-400" style={{ height: '400px' }}>
            Loading comparable listings...
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-xl border bg-white p-5 animate-pulse">
        <div className="h-6 bg-gray-200 rounded w-48 mb-4"></div>
        <div className="h-64 bg-gray-100 rounded"></div>
      </div>
    );
  }

  if (!pricingData) return null;

  const { marketPotentialRent } = pricingData;
  const recommendedRent = pricingData.scenario?.recommendedRent ?? marketPotentialRent;
  const currentVacancyRateEstimate = pricingData.scenario?.currentVacancyRate ?? (vacancyRate ?? 5);
  const benchmarkVacancyRate = pricingData.scenario?.benchmarkVacancyRate ?? currentVacancyRateEstimate;
  const recommendedVacancyRate = pricingData.scenario?.recommendedVacancyRate ?? currentVacancyRateEstimate;
  const vacancyRecovery = pricingData.scenario?.vacancyRecovery;
  const currentProjectedRentGrowth = pricingData.scenario?.currentProjectedRentGrowth ?? pricingData.scenario?.projectedRentGrowth ?? 3;
  const benchmarkProjectedRentGrowth = pricingData.scenario?.benchmarkProjectedRentGrowth ?? pricingData.scenario?.projectedRentGrowth ?? 3;
  const recommendedProjectedRentGrowth = pricingData.scenario?.recommendedProjectedRentGrowth ?? pricingData.scenario?.projectedRentGrowth ?? 3;
  const annualRevenueUpside = pricingData.scenario?.annualRevenueUpside ?? 0;
  const objectiveNpvUpside = pricingData.scenario?.objectiveNpvUpside ?? null;
  const pricingPowerScore = pricingData.pricingPower?.score ?? 50;
  const rentGap = marketPotentialRent - effectiveCurrentRent;
  const modeledMonthlyRevenueDelta = Math.round(annualRevenueUpside / 12);
  const targetVacancyRate = pricingProjectionMode === 'market'
    ? benchmarkVacancyRate
    : pricingProjectionMode === 'custom'
      ? selectedVacancyRate
      : recommendedVacancyRate;
  const targetAnnualRevenueDelta = pricingProjectionMode === 'market'
    ? benchmarkAnnualRevenueUpside
    : pricingProjectionMode === 'custom'
      ? selectedAnnualRevenueUpside
      : annualRevenueUpside;
  const targetDisplayRent = pricingProjectionMode === 'market'
    ? marketPotentialRent
    : pricingProjectionMode === 'custom'
      ? normalizedSelectedRent
      : recommendedRent;
  const targetProjectedRentGrowth = pricingProjectionMode === 'market'
    ? benchmarkProjectedRentGrowth
    : pricingProjectionMode === 'custom'
      ? selectedProjectedRentGrowth
      : recommendedProjectedRentGrowth;
  const supportedCeilingRent = pricingData.scenario?.supportedCeilingRent ?? pricingData.scenario?.vacancyModel?.supportedCeilingRent;
  const rentAtFullVacancy = pricingData.scenario?.rentAtFullVacancy ?? pricingData.scenario?.vacancyModel?.rentAtFullVacancy;
  const benchmarkSourceLabel = pricingData.dataSources?.estimated
    ? 'Estimated fallback'
    : pricingData.dataSources?.listingCompSampleAdequate
      ? `Size-adjusted listing comps · ${pricingData.pricingPower?.confidence || 'unknown'} confidence`
      : `ZIP/ATTOM aggregate · ${pricingData.pricingPower?.confidence || 'unknown'} confidence`;
  const currentMonthStart = new Date();
  currentMonthStart.setDate(1);
  currentMonthStart.setHours(0, 0, 0, 0);
  const rentcastCompReferenceDate = new Date();
  rentcastCompReferenceDate.setHours(0, 0, 0, 0);

  const rentcastCompBuckets = new Map<string, { total: number; count: number }>();
  (pricingData.comparableListings ?? []).forEach((listing) => {
    const price = parseNumberValue(listing.price);
    const daysOnMarket = parseNumberValue(listing.daysOnMarket);
    if (price == null || price <= 0 || daysOnMarket == null || daysOnMarket < 0) return;
    const listedDate = new Date(rentcastCompReferenceDate);
    listedDate.setDate(rentcastCompReferenceDate.getDate() - daysOnMarket);
    const monthKey = formatMonthKey(new Date(listedDate.getFullYear(), listedDate.getMonth(), 1));
    const bucket = rentcastCompBuckets.get(monthKey) || { total: 0, count: 0 };
    bucket.total += price;
    bucket.count += 1;
    rentcastCompBuckets.set(monthKey, bucket);
  });

  const monthsToShow = 24;
  const marketGrowthRate = benchmarkProjectedRentGrowth || pricingData.scenario?.projectedRentGrowth || 3;
  const monthlyGrowthFactor = 1 + (marketGrowthRate / 100 / 12);
  const earliestKnownActualRent = Array.from(actualRentObservationsByMonth.entries())
    .sort(([leftMonth], [rightMonth]) => leftMonth.localeCompare(rightMonth))[0]?.[1] ?? effectiveCurrentRent;
  let rollingActualRent = earliestKnownActualRent;
  const currentMonthKey = formatMonthKey(currentMonthStart);

  const pricingPowerTrendSeries = Array.from({ length: monthsToShow }, (_, index) => {
    const monthDate = addMonths(currentMonthStart, index - (monthsToShow - 1));
    const monthKey = formatMonthKey(monthDate);
    const monthsBackFromCurrent = monthDistance(monthDate, currentMonthStart);
    const baselineMarketRent = Math.round(
      marketPotentialRent / Math.pow(monthlyGrowthFactor, Math.max(monthsBackFromCurrent, 0))
    );
    const compBucket = rentcastCompBuckets.get(monthKey);
    const compMeanRent = compBucket && compBucket.count > 0 ? compBucket.total / compBucket.count : null;
    const marketRent = monthKey === currentMonthKey
      ? Math.round(marketPotentialRent)
      : Math.round(
          compMeanRent != null
            ? (compMeanRent * 0.7) + (baselineMarketRent * 0.3)
            : baselineMarketRent
        );
    const observedActualRent = actualRentObservationsByMonth.get(monthKey) ?? null;
    if (observedActualRent != null && observedActualRent > 0) {
      rollingActualRent = observedActualRent;
    }
    const actualRentValue = rollingActualRent;
    const gapDollar = marketRent - actualRentValue;
    const pricingPowerPercent = marketRent > 0 ? (gapDollar / marketRent) * 100 : 0;
    const showAxisLabel = monthsToShow <= 12 || index === 0 || index === monthsToShow - 1 || monthDate.getMonth() % 3 === 0;
    const axisLabel = monthDate.getMonth() === 0 || index === 0 || index === monthsToShow - 1
      ? monthDate.toLocaleString('default', { month: 'short', year: '2-digit' })
      : monthDate.toLocaleString('default', { month: 'short' });

    return {
      key: monthKey,
      label: monthDate.toLocaleString('default', { month: 'short' }),
      axisLabel,
      showAxisLabel,
      actualRent: Math.round(actualRentValue),
      marketRent,
      gapDollar,
      pricingPowerPercent,
    };
  });

  const latestTrendPoint = pricingPowerTrendSeries[pricingPowerTrendSeries.length - 1] || null;
  const actualTrendSourceLabel = actualRentObservationsByMonth.size > 0
    ? 'bookkeeping-backed rent history'
    : 'current booked rent fallback';
  const marketTrendSourceLabel = rentcastCompBuckets.size > 0
    ? 'RentCast comps + back-cast'
    : 'RentCast benchmark back-cast';
  const trendValues = pricingPowerTrendSeries.flatMap((point) => [point.actualRent, point.marketRent]);
  const trendMinValue = trendValues.some((value) => value <= 0)
    ? 0
    : Math.max(0, Math.floor((Math.min(...trendValues) * 0.88) / 25) * 25);
  const trendMaxValue = Math.max(
    trendMinValue + 100,
    Math.ceil((Math.max(...trendValues) * 1.08) / 25) * 25,
  );
  const trendChartWidth = 520;
  const trendChartHeight = 240;
  const trendChartPadding = { top: 16, right: 16, bottom: 30, left: 48 };
  const trendChartInnerWidth = trendChartWidth - trendChartPadding.left - trendChartPadding.right;
  const trendChartInnerHeight = trendChartHeight - trendChartPadding.top - trendChartPadding.bottom;
  const getTrendX = (index: number) => (
    trendChartPadding.left
    + (pricingPowerTrendSeries.length <= 1
      ? trendChartInnerWidth / 2
      : (index * trendChartInnerWidth) / (pricingPowerTrendSeries.length - 1))
  );
  const getTrendY = (value: number) => {
    const normalized = (value - trendMinValue) / Math.max(trendMaxValue - trendMinValue, 1);
    return trendChartPadding.top + trendChartInnerHeight - (normalized * trendChartInnerHeight);
  };
  const actualTrendPoints = pricingPowerTrendSeries.map((point, index) => ({
    x: getTrendX(index),
    y: getTrendY(point.actualRent),
  }));
  const marketTrendPoints = pricingPowerTrendSeries.map((point, index) => ({
    x: getTrendX(index),
    y: getTrendY(point.marketRent),
  }));
  const buildLinePath = (points: Array<{ x: number; y: number }>) => points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');
  const pricingGapSegments: Array<{ path: string; fill: string }> = [];

  for (let index = 0; index < pricingPowerTrendSeries.length - 1; index += 1) {
    const actualStart = actualTrendPoints[index];
    const actualEnd = actualTrendPoints[index + 1];
    const marketStart = marketTrendPoints[index];
    const marketEnd = marketTrendPoints[index + 1];
    const startGap = pricingPowerTrendSeries[index].gapDollar;
    const endGap = pricingPowerTrendSeries[index + 1].gapDollar;
    const startSign = Math.sign(startGap);
    const endSign = Math.sign(endGap);

    if (startSign === 0 && endSign === 0) continue;

    if (startSign === 0 || endSign === 0 || startSign === endSign) {
      const fill = (startSign || endSign) >= 0 ? 'rgba(16, 185, 129, 0.18)' : 'rgba(244, 63, 94, 0.18)';
      pricingGapSegments.push({
        path: `M ${actualStart.x.toFixed(1)} ${actualStart.y.toFixed(1)} L ${actualEnd.x.toFixed(1)} ${actualEnd.y.toFixed(1)} L ${marketEnd.x.toFixed(1)} ${marketEnd.y.toFixed(1)} L ${marketStart.x.toFixed(1)} ${marketStart.y.toFixed(1)} Z`,
        fill,
      });
      continue;
    }

    const crossingProgress = Math.abs(startGap) / (Math.abs(startGap) + Math.abs(endGap));
    const intersectionX = actualStart.x + ((actualEnd.x - actualStart.x) * crossingProgress);
    const intersectionY = actualStart.y + ((actualEnd.y - actualStart.y) * crossingProgress);
    const firstFill = startSign >= 0 ? 'rgba(16, 185, 129, 0.18)' : 'rgba(244, 63, 94, 0.18)';
    const secondFill = endSign >= 0 ? 'rgba(16, 185, 129, 0.18)' : 'rgba(244, 63, 94, 0.18)';

    pricingGapSegments.push({
      path: `M ${actualStart.x.toFixed(1)} ${actualStart.y.toFixed(1)} L ${intersectionX.toFixed(1)} ${intersectionY.toFixed(1)} L ${marketStart.x.toFixed(1)} ${marketStart.y.toFixed(1)} Z`,
      fill: firstFill,
    });
    pricingGapSegments.push({
      path: `M ${intersectionX.toFixed(1)} ${intersectionY.toFixed(1)} L ${actualEnd.x.toFixed(1)} ${actualEnd.y.toFixed(1)} L ${marketEnd.x.toFixed(1)} ${marketEnd.y.toFixed(1)} Z`,
      fill: secondFill,
    });
  }

  const trendTickValues = Array.from({ length: 4 }, (_, index) => {
    const progress = index / 3;
    return Math.round(trendMaxValue - ((trendMaxValue - trendMinValue) * progress));
  });
  const pricingPowerTrend = latestTrendPoint ? (
    <div className="mb-6 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-emerald-50/30 p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Pricing Power Trend</div>
          <div className="text-sm text-slate-700 mt-1">Market benchmark vs rent-tagged bookkeeping observations over the past {monthsToShow} months.</div>
        </div>
        <div className="text-right">
          <div className={`text-lg font-bold ${latestTrendPoint.pricingPowerPercent >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {latestTrendPoint.pricingPowerPercent >= 0 ? '+' : ''}{latestTrendPoint.pricingPowerPercent.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-500">current pricing power</div>
        </div>
      </div>

      <svg viewBox={`0 0 ${trendChartWidth} ${trendChartHeight}`} className="w-full h-56 overflow-visible">
        {trendTickValues.map((tickValue) => {
          const y = getTrendY(tickValue);
          return (
            <g key={tickValue}>
              <line x1={trendChartPadding.left} y1={y} x2={trendChartWidth - trendChartPadding.right} y2={y} stroke="#E2E8F0" strokeDasharray="4 4" />
              <text x={trendChartPadding.left - 10} y={y + 4} textAnchor="end" className="fill-slate-400 text-[10px]">
                ${tickValue.toLocaleString()}
              </text>
            </g>
          );
        })}

        {pricingGapSegments.map((segment, index) => (
          <path key={`${segment.fill}-${index}`} d={segment.path} fill={segment.fill} />
        ))}

        <path d={buildLinePath(marketTrendPoints)} fill="none" stroke="#A855F7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d={buildLinePath(actualTrendPoints)} fill="none" stroke="#2563EB" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

        {pricingPowerTrendSeries.map((point, index) => (
          <g key={point.key}>
            <circle cx={marketTrendPoints[index].x} cy={marketTrendPoints[index].y} r="4" fill="#A855F7" stroke="#ffffff" strokeWidth="2" />
            <circle cx={actualTrendPoints[index].x} cy={actualTrendPoints[index].y} r="4" fill="#2563EB" stroke="#ffffff" strokeWidth="2" />
            {point.showAxisLabel ? (
              <text x={getTrendX(index)} y={trendChartHeight - 8} textAnchor="middle" className="fill-slate-500 text-[10px] font-medium">
                {point.axisLabel}
              </text>
            ) : null}
          </g>
        ))}
      </svg>

      <div className="grid grid-cols-3 gap-3 mt-4 text-center">
        <div className="rounded-lg border border-blue-100 bg-blue-50/80 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Latest Actual</div>
          <div className="text-lg font-bold text-blue-700 mt-1">${latestTrendPoint.actualRent.toLocaleString()}</div>
          <div className="text-[10px] text-slate-500 mt-1">{actualTrendSourceLabel}</div>
        </div>
        <div className="rounded-lg border border-purple-100 bg-purple-50/80 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Market Benchmark</div>
          <div className="text-lg font-bold text-purple-700 mt-1">${latestTrendPoint.marketRent.toLocaleString()}</div>
          <div className="text-[10px] text-slate-500 mt-1">{marketTrendSourceLabel}</div>
        </div>
        <div className={`rounded-lg border p-3 ${latestTrendPoint.gapDollar >= 0 ? 'border-emerald-100 bg-emerald-50/80' : 'border-rose-100 bg-rose-50/80'}`}>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Benchmark Gap</div>
          <div className={`text-lg font-bold mt-1 ${latestTrendPoint.gapDollar >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {latestTrendPoint.gapDollar >= 0 ? '+' : '-'}${Math.abs(latestTrendPoint.gapDollar).toLocaleString()}
          </div>
          <div className={`text-[10px] mt-1 ${latestTrendPoint.pricingPowerPercent >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {latestTrendPoint.pricingPowerPercent >= 0 ? '+' : ''}{latestTrendPoint.pricingPowerPercent.toFixed(1)}% vs benchmark
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 mt-4 pt-3 border-t border-slate-100 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium shadow-sm">
          <span className="w-2 h-2 rounded-full bg-blue-600"></span>
          Actual rent
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium shadow-sm">
          <span className="w-2 h-2 rounded-full bg-purple-500"></span>
          Market benchmark
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium shadow-sm">
          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-400/70"></span>
          Below benchmark
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium shadow-sm">
          <span className="w-2.5 h-2.5 rounded-sm bg-rose-400/70"></span>
          Above benchmark
        </span>
      </div>
    </div>
  ) : null;

  // Calculate max for bar heights
  const maxRent = Math.max(recommendedRent, marketPotentialRent, effectiveCurrentRent, normalizedSelectedRent, rentAtFullVacancy ?? 0) * 1.08;
  const comparableListingsCount = (pricingData.comparableListings ?? []).filter(
    (c) => typeof c.latitude === 'number' && typeof c.longitude === 'number'
  ).length;

  const barComparison = (
    <>
      {pricingPowerTrend}
      <div className={pricingPowerTrend ? 'pt-5 border-t border-gray-100' : ''}>
        <div className="flex items-end justify-center gap-8 h-64">
          <div className="flex flex-col items-center">
            <div className="text-base font-semibold text-blue-600 mb-1.5 tracking-tight">
              ${effectiveCurrentRent.toLocaleString()}
            </div>
            <div
              className="w-20 rounded-t-lg bg-gradient-to-t from-indigo-500 to-indigo-400 shadow-[0_6px_16px_rgba(99,102,241,0.25)] transition-all duration-500"
              style={{ height: `${(effectiveCurrentRent / maxRent) * 200}px` }}
            />
            <div className="mt-2.5 text-xs font-semibold text-gray-700 tracking-wide uppercase">Current Rent</div>
            <div className="text-[11px] text-gray-400">{currentRentSourceLabel}</div>
          </div>

          <div className="flex flex-col items-center">
            <div className="text-base font-semibold text-purple-600 mb-1.5 tracking-tight">
              ${marketPotentialRent.toLocaleString()}
            </div>
            <div
              className="w-20 rounded-t-lg bg-gradient-to-t from-violet-500 to-violet-400 shadow-[0_6px_16px_rgba(139,92,246,0.25)] transition-all duration-500 relative"
              style={{ height: `${(marketPotentialRent / maxRent) * 200}px` }}
            >
              <div className="absolute -right-9 top-1/2 -translate-y-1/2 text-[11px] text-gray-500 font-medium whitespace-nowrap">
                {rentGap >= 0 ? '+' : ''}${rentGap.toLocaleString()}
              </div>
            </div>
            <div className="mt-2.5 text-xs font-semibold text-gray-700 tracking-wide uppercase">Market Benchmark</div>
            <div className="max-w-44 text-center text-[11px] text-gray-400">{benchmarkSourceLabel}</div>
          </div>

          <div className="flex flex-col items-center">
            <div className="text-base font-semibold text-emerald-600 mb-1.5 tracking-tight">
              ${recommendedRent.toLocaleString()}
            </div>
            <div
              className="w-20 rounded-t-lg bg-gradient-to-t from-emerald-500 to-teal-400 shadow-[0_6px_16px_rgba(16,185,129,0.25)] transition-all duration-500 relative"
              style={{ height: `${(recommendedRent / maxRent) * 200}px` }}
            >
              <div className="absolute -right-11 top-1/4 text-[11px] text-gray-500 font-medium whitespace-nowrap">
                {recommendedVacancyRate.toFixed(1)}% vac
              </div>
            </div>
            <div className="mt-2.5 text-xs font-semibold text-gray-700 tracking-wide uppercase">Recommended Rent</div>
            <div className="text-[11px] text-gray-400">Best return after vacancy</div>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2.5 mt-4 pt-3 border-t border-gray-100 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium shadow-sm">
            <span className="w-2 h-2 rounded-full bg-gradient-to-t from-indigo-500 to-indigo-400"></span>
            Current
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium shadow-sm">
            <span className="w-2 h-2 rounded-full bg-gradient-to-t from-violet-500 to-violet-400"></span>
            Market
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium shadow-sm">
            <span className="w-2 h-2 rounded-full bg-gradient-to-t from-emerald-500 to-teal-400"></span>
            Recommended
          </span>
        </div>
      </div>
    </>
  );

  const comparableListingsMap = (
    <div className="mt-5 pt-4 border-t border-gray-100">
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="text-xs font-semibold text-gray-700 tracking-wide uppercase">Comparable Listings Map</span>
        {comparableListingsCount > 0 ? (
          <span className="text-[11px] font-normal text-gray-400">({comparableListingsCount} listings)</span>
        ) : null}
      </div>

      <div>
        {comparableListingsCount === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 h-40 flex items-center justify-center text-sm text-gray-400">
            No comparable listings with location data available
          </div>
        ) : (
          <>
            <div className="relative rounded-lg overflow-hidden border border-gray-200" style={{ height: '400px' }}>
              <div ref={compMapRef} className="h-full w-full" />
              {!compMapReady && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gray-50 text-sm text-gray-400">
                  <svg className="w-5 h-5 animate-spin text-gray-300" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Loading map...
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-900 inline-block"></span>
                Subject property
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block"></span>
                Comp ≤ current +5%
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500 inline-block"></span>
                Comp between current and benchmark
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
                Comp above benchmark +5%
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const pricingStrategySummary = (
    <>
      <div className="flex items-center justify-between mb-4">
        <h5 className="font-semibold text-gray-800">Market-Supported Pricing Strategy</h5>
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${
          pricingPowerScore >= 70
            ? 'bg-emerald-100 text-emerald-700'
            : pricingPowerScore >= 45
              ? 'bg-amber-100 text-amber-700'
              : 'bg-rose-100 text-rose-700'
        }`}>
          {pricingPowerScore}/100 pricing power
        </span>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <p className="text-sm text-gray-700 leading-relaxed">
          {pricingData.pricingPower?.explanation || 'This view compares current rent to market-supported rent and adjusts for vacancy risk, demand, and local macro conditions.'}
        </p>
        <p className="text-sm text-gray-600 mt-3 leading-relaxed">
          {pricingData.scenario?.summary || 'Target pricing reflects the rent level that appears to maximize collected revenue, not simply the highest asking rent.'}
        </p>
      </div>

      {pricingData.scenario?.strategyOptions && (
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {([
            ['Max return', pricingData.scenario.strategyOptions.maxReturn, 'border-emerald-200 bg-emerald-50 text-emerald-800'],
            ['Balanced', pricingData.scenario.strategyOptions.balanced, 'border-blue-200 bg-blue-50 text-blue-800'],
            ['Vacancy recovery', pricingData.scenario.strategyOptions.vacancyRecovery, 'border-amber-200 bg-amber-50 text-amber-800'],
          ] as const).map(([label, option, color]) => option ? (
            <div key={label} className={`rounded-lg border p-3 ${color}`}>
              <div className="text-[10px] font-semibold uppercase tracking-wide">{label}</div>
              <div className="mt-1 text-xl font-bold">${option.rent.toLocaleString()}/mo</div>
              <div className="mt-1 text-[11px]">
                {option.vacancyRate.toFixed(1)}% risk · ${option.effectiveAnnualRevenue.toLocaleString()}/yr collected
              </div>
              <div className={`mt-1 text-[11px] font-semibold ${option.deltaVsCurrent >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {option.deltaVsCurrent >= 0 ? '+' : '-'}${Math.abs(option.deltaVsCurrent).toLocaleString()}/yr vs current
              </div>
            </div>
          ) : null)}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          Analysis inputs
        </div>
        <p className="mt-1 text-xs text-amber-700">
          Load the exact subject address first, then set its current asking rent and days on market.
          Bookkeeping history is shown in the trend chart only and no longer overrides asking rent.
          {latestBookkeepingActualRent != null
            ? ` Latest bookkeeping rent observation: $${latestBookkeepingActualRent.toLocaleString()}/mo.`
            : ''}
        </p>
        <div className="mt-3">
          <label className="block text-[11px] font-medium text-amber-800" htmlFor="pricing-subject-address">
            Subject property address
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              id="pricing-subject-address"
              type="text"
              value={subjectAddressInput}
              onChange={(event) => setSubjectAddressInput(event.target.value)}
              placeholder="11402 Gainsborough Rd, Potomac, MD 20854"
              className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
            <button
              type="button"
              onClick={() => void lookupRentalSubject()}
              disabled={subjectLookupLoading}
              className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {subjectLookupLoading ? 'Loading property…' : 'Load property'}
            </button>
          </div>
          {subjectLookupError && (
            <p className="mt-1 text-xs font-medium text-rose-700">{subjectLookupError}</p>
          )}
          {compsCacheNote && !subjectLookupError && (
            <p className="mt-1 text-xs text-emerald-800">{compsCacheNote}</p>
          )}
          {subjectOverride && (
            <>
              <p className="mt-1 text-xs text-emerald-800">
                Loaded ZIP {analysisZipCode} and exact coordinates. Verify any physical field the
                property source could not supply; these values control comparable matching.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  ['Bedrooms', 'bedrooms', subjectOverride.bedrooms],
                  ['Bathrooms', 'bathrooms', subjectOverride.bathrooms],
                  ['Square feet', 'squareFeet', subjectOverride.squareFeet],
                  ['Year built', 'yearBuilt', subjectOverride.yearBuilt],
                ] as const).map(([label, key, value]) => (
                  <label key={key} className="text-[10px] font-medium text-amber-800">
                    {label}
                    <input
                      type="number"
                      min="0"
                      value={value ?? ''}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        setSubjectOverride((current) => current ? {
                          ...current,
                          [key]: Number.isFinite(parsed) && event.target.value !== '' ? parsed : null,
                        } : current);
                      }}
                      className="mt-1 w-full rounded border border-amber-300 bg-white px-2 py-1.5 text-xs text-slate-800"
                    />
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-[11px] font-medium text-amber-800" htmlFor="pricing-current-rent">
              Current asking rent
            </label>
            <input
              id="pricing-current-rent"
              type="number"
              min="0"
              step="25"
              value={currentRentInput}
              onChange={(event) => setCurrentRentInput(event.target.value)}
              placeholder="e.g. 4700"
              className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-amber-800" htmlFor="pricing-subject-dom">
              Days on market
            </label>
            <input
              id="pricing-subject-dom"
              type="number"
              min="0"
              max="730"
              value={subjectDomInput}
              onChange={(event) => setSubjectDomInput(event.target.value)}
              placeholder="e.g. 61"
              className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-800"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              const rentParsed = Number(currentRentInput);
              setAppliedCurrentRent(
                Number.isFinite(rentParsed) && rentParsed > 0 ? Math.round(rentParsed) : null,
              );
              const domParsed = Number(subjectDomInput);
              setAppliedSubjectDaysOnMarket(
                Number.isFinite(domParsed) && domParsed >= 0 ? domParsed : null,
              );
            }}
            className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700"
          >
            Recalculate
          </button>
          {(subjectOverride || appliedCurrentRent != null || appliedSubjectDaysOnMarket != null) && (
            <button
              type="button"
              onClick={() => {
                setAppliedCurrentRent(null);
                setCurrentRentInput(
                  Number.isFinite(currentRent) && currentRent > 0 ? String(Math.round(currentRent)) : '',
                );
                setSubjectDomInput('');
                setAppliedSubjectDaysOnMarket(null);
                setSubjectAddressInput(propertyId || '');
                setSubjectOverride(null);
                setSubjectLookupError(null);
              }}
              className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800"
            >
              Reset to property defaults
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-violet-800">
          AI visible-condition analysis
        </div>
        <p className="mt-1 text-xs leading-relaxed text-violet-700">
          Add up to 12 exterior and interior photos. Vision scores only visible condition,
          reports missing coverage, and applies a confidence-weighted adjustment capped at −5% to +4%.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-lg border border-violet-300 bg-white px-3 py-2 text-xs font-semibold text-violet-800 hover:bg-violet-100">
            Choose property photos
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(event) => void handleRentalPhotoSelection(event.target.files)}
            />
          </label>
          <button
            type="button"
            disabled={!rentalPhotos.length || conditionAnalyzing}
            onClick={() => void analyzeRentalPhotos()}
            className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {conditionAnalyzing ? 'Analyzing photos…' : 'Analyze condition & reprice'}
          </button>
          {rentalPhotos.length > 0 && (
            <span className="text-xs text-violet-700">{rentalPhotos.length} photo(s) selected</span>
          )}
        </div>
        {rentalPhotos.length > 0 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {rentalPhotos.map((photo, index) => (
              <div key={`${photo.name}-${index}`} className="shrink-0">
                <img
                  src={photo.dataUrl}
                  alt={`Property upload ${index + 1}`}
                  className="h-16 w-20 rounded-md border border-violet-200 object-cover"
                />
              </div>
            ))}
          </div>
        )}
        {conditionError && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {conditionError}
          </div>
        )}
        {conditionAnalysis && (
          <div className="mt-3 rounded-lg border border-violet-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Condition score</div>
                <div className="text-xl font-bold text-violet-700">
                  {conditionAnalysis.conditionScore}/100 · {conditionAnalysis.conditionClass}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Benchmark adjustment</div>
                <div className={`text-lg font-bold ${conditionAnalysis.rentAdjustmentPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {conditionAnalysis.rentAdjustmentPct >= 0 ? '+' : ''}{conditionAnalysis.rentAdjustmentPct}%
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">Evidence quality</div>
                <div className="text-sm font-semibold text-slate-700">
                  {Math.round(conditionAnalysis.confidence * 100)}% confidence · {Math.round(conditionAnalysis.coverageScore * 100)}% coverage
                </div>
              </div>
            </div>
            {conditionAnalysis.marketabilitySummary && (
              <p className="mt-2 text-xs leading-relaxed text-slate-600">
                {conditionAnalysis.marketabilitySummary}
              </p>
            )}
            {conditionAnalysis.deficiencies && conditionAnalysis.deficiencies.length > 0 && (
              <div className="mt-2 text-xs text-slate-600">
                <span className="font-semibold">Visible weaknesses:</span>{' '}
                {conditionAnalysis.deficiencies.join(' · ')}
              </div>
            )}
            {conditionAnalysis.missingCoverage && conditionAnalysis.missingCoverage.length > 0 && (
              <div className="mt-1 text-xs text-amber-700">
                <span className="font-semibold">Not shown:</span>{' '}
                {conditionAnalysis.missingCoverage.join(' · ')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">Apply To Additional Analytics</div>
        <div className="grid grid-cols-4 gap-2">
          <button
            onClick={() => {
              setSelectedRent(effectiveCurrentRent);
              onPricingProjectionModeChange?.('none');
            }}
            className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
              pricingProjectionMode === 'none'
                ? 'bg-slate-800 text-white'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            Keep Current
          </button>
          <button
            onClick={() => {
              setSelectedRent(marketPotentialRent);
              onPricingProjectionModeChange?.('market');
            }}
            className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
              pricingProjectionMode === 'market'
                ? 'bg-purple-600 text-white'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-purple-50'
            }`}
          >
            Apply Benchmark
          </button>
          <button
            onClick={() => {
              setSelectedRent(recommendedRent);
              onPricingProjectionModeChange?.('recommended');
            }}
            className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
              pricingProjectionMode === 'recommended'
                ? 'bg-emerald-600 text-white'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-emerald-50'
            }`}
          >
            Apply Recommended
          </button>
          <button
            onClick={() => onPricingProjectionModeChange?.('custom')}
            className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
              pricingProjectionMode === 'custom'
                ? 'bg-amber-500 text-white'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-amber-50'
            }`}
          >
            Apply Slider
          </button>
        </div>
      </div>
    </>
  );

  const interactiveRentSweep = (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Interactive Rent Sweep</div>
          <div className="text-sm text-slate-700 mt-1">Slide the rent and the portfolio projections update using the pricing model's vacancy response curve.</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-amber-700">Slider Rent</div>
          <div className="text-2xl font-bold text-amber-700">${normalizedSelectedRent.toLocaleString()}</div>
        </div>
      </div>

      <input
        type="range"
        min={sliderMinRent}
        max={sliderMaxRent}
        step={sliderStep}
        value={normalizedSelectedRent}
        onChange={(event) => {
          setSelectedRent(Number(event.target.value));
          onPricingProjectionModeChange?.('custom');
        }}
        className="w-full accent-amber-500"
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>${sliderMinRent.toLocaleString()}</span>
        <span>Current ${effectiveCurrentRent.toLocaleString()}</span>
        <span>Benchmark ${marketPotentialRent.toLocaleString()}</span>
        <span>Recommended ${recommendedRent.toLocaleString()}</span>
        {supportedCeilingRent != null && <span>Ceiling ${supportedCeilingRent.toLocaleString()}</span>}
        {rentAtFullVacancy != null && <span>Modeled rejection ${rentAtFullVacancy.toLocaleString()}</span>}
        <span>${sliderMaxRent.toLocaleString()}</span>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-4 text-center">
        <div className="rounded-lg bg-white border border-amber-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">
            {vacancyRecovery ? 'Projected Campaign Vacancy' : 'Modeled Vacancy Risk'}
          </div>
          <div className="text-lg font-bold text-blue-700 mt-1">{selectedVacancyRate.toFixed(1)}%</div>
        </div>
        <div className="rounded-lg bg-white border border-amber-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">At Slider: Year-1 Delta</div>
          <div className={`text-lg font-bold mt-1 ${selectedAnnualRevenueUpside >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {selectedAnnualRevenueUpside >= 0 ? '+' : '-'}${Math.abs(selectedAnnualRevenueUpside).toLocaleString()}/yr
          </div>
        </div>
        <div className="rounded-lg bg-white border border-amber-100 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Projection Mode</div>
          <div className="text-sm font-semibold text-amber-700 mt-2">
            {pricingProjectionMode === 'custom' ? 'Slider Applied' : 'Move slider to apply'}
          </div>
        </div>
      </div>
    </div>
  );

  const pricingModelMetrics = (
    <div className="grid grid-cols-2 gap-3 mt-4 lg:grid-cols-3">
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
        <div className="text-xs font-medium text-blue-600">
          {vacancyRecovery ? 'Projected Campaign Vacancy At Current Ask' : 'Modeled Vacancy Risk Now'}
        </div>
        <div className="text-2xl font-bold text-blue-700 mt-1">{currentVacancyRateEstimate.toFixed(1)}%</div>
        <div className="text-xs text-blue-500 mt-1">
          {vacancyRecovery
            ? `${vacancyRecovery.realizedVacancyPct.toFixed(1)}% realized + ${vacancyRecovery.currentExpectedAdditionalDays} expected days`
            : 'At current asking rent'}
        </div>
      </div>
      <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
        <div className="text-xs font-medium text-emerald-600">
          {vacancyRecovery ? 'Projected Campaign Vacancy At Target' : 'Modeled Vacancy Risk At Target'}
        </div>
        <div className="text-2xl font-bold text-emerald-700 mt-1">{targetVacancyRate.toFixed(1)}%</div>
        <div className="text-xs text-emerald-500 mt-1">At ${targetDisplayRent.toLocaleString()}/mo</div>
      </div>
      {vacancyRecovery && (
        <div className="rounded-lg border border-cyan-100 bg-cyan-50 p-4">
          <div className="text-xs font-medium text-cyan-700">Realized Vacancy To Date</div>
          <div className="text-2xl font-bold text-cyan-800 mt-1">{vacancyRecovery.realizedVacancyPct.toFixed(1)}%</div>
          <div className="text-xs text-cyan-600 mt-1">{vacancyRecovery.elapsedVacantDays} elapsed vacant days</div>
        </div>
      )}
      <div className="rounded-lg border border-purple-100 bg-purple-50 p-4">
        <div className="text-xs font-medium text-purple-600">Projected Rent Growth</div>
        <div className="text-2xl font-bold text-purple-700 mt-1">{targetProjectedRentGrowth.toFixed(1)}%</div>
        <div className="text-xs text-purple-500 mt-1">
          {pricingProjectionMode === 'market' ? 'Benchmark path' : pricingProjectionMode === 'custom' ? 'Slider path' : 'Recommended path'}
        </div>
      </div>
      <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
        <div className="text-xs font-medium text-amber-600">At Target: Year-1 Collected-Rent Delta</div>
        <div className={`text-2xl font-bold mt-1 ${targetAnnualRevenueDelta >= 0 ? 'text-amber-700' : 'text-rose-700'}`}>
          {targetAnnualRevenueDelta >= 0 ? '+' : '-'}${Math.abs(targetAnnualRevenueDelta).toLocaleString()}/yr
        </div>
        <div className="text-xs text-amber-500 mt-1">Gross scheduled rent less modeled vacancy; excludes expenses</div>
      </div>
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
        <div className="text-xs font-medium text-slate-600">Supported Ceiling</div>
        <div className="text-2xl font-bold text-slate-700 mt-1">{supportedCeilingRent != null ? `$${supportedCeilingRent.toLocaleString()}` : 'N/A'}</div>
        <div className="text-xs text-slate-500 mt-1">Upper comp-supported asking band</div>
      </div>
      <div className="rounded-lg border border-rose-100 bg-rose-50 p-4">
        <div className="text-xs font-medium text-rose-600">Market Rejection Point</div>
        <div className="text-2xl font-bold text-rose-700 mt-1">{rentAtFullVacancy != null ? `$${rentAtFullVacancy.toLocaleString()}` : 'N/A'}</div>
        <div className="text-xs text-rose-500 mt-1">Modeled boundary, not an observed vacancy threshold</div>
      </div>
      {objectiveNpvUpside != null && (
        <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-4">
          <div className="text-xs font-medium text-indigo-600">Recommendation Objective Delta</div>
          <div className={`text-2xl font-bold mt-1 ${objectiveNpvUpside >= 0 ? 'text-indigo-700' : 'text-rose-700'}`}>
            {objectiveNpvUpside >= 0 ? '+' : '-'}${Math.abs(objectiveNpvUpside).toLocaleString()}
          </div>
          <div className="text-xs text-indigo-500 mt-1">
            {pricingData.scenario?.objectiveLabel || 'Discounted collected-rent NPV'}
          </div>
        </div>
      )}
    </div>
  );

  const audit = pricingData.pricingAudit;
  const auditComps = audit?.comparableBenchmark || {};
  const auditCondition = audit?.conditionAdjustment || {};
  const auditVacancy = audit?.vacancyModel || {};
  const auditOptimizer = audit?.optimizer || {};
  const observedVacancy = pricingData.vacancyEvidence?.observedLocal || {};
  const liveVacancy = pricingData.vacancyEvidence?.liveMarket || {};
  const displayAuditValue = (value: unknown, fallback = '—') => (
    value === null || value === undefined || value === '' ? fallback : String(value)
  );

  const pricingCalculationBreakdown = (
    <details className="mt-5 rounded-xl border border-slate-200 bg-white" open>
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-800">
        How the ${recommendedRent.toLocaleString()}/mo recommendation was calculated
        <span className="ml-2 text-xs font-normal text-slate-500">
          Full evidence, adjustments, formulas, and comparable set
        </span>
      </summary>
      <div className="border-t border-slate-200 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">1 · Subject inputs</div>
            <dl className="mt-2 space-y-1 text-xs text-slate-700">
              <div className="flex justify-between gap-3"><dt>Current ask</dt><dd className="font-semibold">${effectiveCurrentRent.toLocaleString()}</dd></div>
              <div className="flex justify-between gap-3"><dt>Days on market</dt><dd className="font-semibold">{appliedSubjectDaysOnMarket ?? 'Not supplied'}</dd></div>
              <div className="flex justify-between gap-3"><dt>Size</dt><dd className="font-semibold">{squareFeet.toLocaleString()} sqft</dd></div>
              <div className="flex justify-between gap-3"><dt>Configuration</dt><dd className="font-semibold">{bedrooms} bd / {bathrooms} ba</dd></div>
            </dl>
          </div>

          <div className="rounded-lg border border-purple-100 bg-purple-50 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-purple-600">2 · Comparable benchmark</div>
            <dl className="mt-2 space-y-1 text-xs text-slate-700">
              <div className="flex justify-between gap-3"><dt>Clean comps</dt><dd className="font-semibold">{displayAuditValue(auditComps.cleanCompCount)}</dd></div>
              <div className="flex justify-between gap-3"><dt>Size-adjusted median</dt><dd className="font-semibold">${Number(auditComps.weightedMedianSizeAdjustedRent || marketPotentialRent).toLocaleString()}</dd></div>
              <div className="flex justify-between gap-3"><dt>Weighted $/sqft</dt><dd className="font-semibold">{auditComps.weightedMedianRentPerSqFt != null ? `$${Number(auditComps.weightedMedianRentPerSqFt).toFixed(2)}` : '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt>P25–P90 band</dt><dd className="font-semibold">${Number(auditComps.p25 || 0).toLocaleString()}–${Number(auditComps.p90 || 0).toLocaleString()}</dd></div>
            </dl>
          </div>

          <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">3 · Vacancy evidence</div>
            <dl className="mt-2 space-y-1 text-xs text-slate-700">
              <div className="flex justify-between gap-3">
                <dt>Observed local ACS</dt>
                <dd className="font-semibold">
                  {observedVacancy.vacancyRate != null
                    ? `${observedVacancy.vacancyRate}%${observedVacancy.vacancyRateMoe != null ? ` ±${observedVacancy.vacancyRateMoe}` : ''}`
                    : 'Unavailable'}
                </dd>
              </div>
              <div className="flex justify-between gap-3"><dt>RentCast median DOM</dt><dd className="font-semibold">{displayAuditValue(liveVacancy.medianDaysOnMarket, 'Unavailable')}</dd></div>
              {vacancyRecovery && <div className="flex justify-between gap-3"><dt>Realized vacancy to date</dt><dd className="font-semibold">{vacancyRecovery.realizedVacancyPct.toFixed(1)}%</dd></div>}
              <div className="flex justify-between gap-3"><dt>{vacancyRecovery ? 'Current campaign projection' : 'Current modeled risk'}</dt><dd className="font-semibold">{currentVacancyRateEstimate.toFixed(1)}%</dd></div>
              <div className="flex justify-between gap-3"><dt>{vacancyRecovery ? 'Recommended campaign projection' : 'Recommended risk'}</dt><dd className="font-semibold">{recommendedVacancyRate.toFixed(1)}%</dd></div>
              {vacancyRecovery && <div className="flex justify-between gap-3"><dt>Expected remaining days</dt><dd className="font-semibold">{vacancyRecovery.currentExpectedAdditionalDays} → {vacancyRecovery.recommendedExpectedAdditionalDays}</dd></div>}
            </dl>
          </div>

          <div className="rounded-lg border border-amber-100 bg-amber-50 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">4 · Return optimizer</div>
            <dl className="mt-2 space-y-1 text-xs text-slate-700">
              <div className="flex justify-between gap-3"><dt>Mode</dt><dd className="font-semibold">{displayAuditValue(auditOptimizer.recommendationMode).replace(/_/g, ' ')}</dd></div>
              <div className="flex justify-between gap-3"><dt>Search range</dt><dd className="font-semibold">${Number(auditOptimizer.searchMin || 0).toLocaleString()}–${Number(auditOptimizer.searchMax || 0).toLocaleString()}</dd></div>
              <div className="flex justify-between gap-3"><dt>Current collected rent</dt><dd className="font-semibold">${Number(auditOptimizer.currentEffectiveAnnualRevenue || 0).toLocaleString()}/yr</dd></div>
              <div className="flex justify-between gap-3"><dt>Recommended collected rent</dt><dd className="font-semibold">${Number(auditOptimizer.recommendedEffectiveAnnualRevenue || 0).toLocaleString()}/yr</dd></div>
            </dl>
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <div className="font-semibold text-slate-800">Condition adjustment</div>
            <p className="mt-1">
              Benchmark before condition: ${Number(auditCondition.benchmarkBefore || marketPotentialRent).toLocaleString()} ·
              adjustment {Number(auditCondition.adjustmentPct || 0) >= 0 ? '+' : ''}{Number(auditCondition.adjustmentPct || 0).toFixed(1)}%
              (${Number(auditCondition.adjustmentDollar || 0).toLocaleString()}) ·
              adjusted benchmark: ${Number(auditCondition.benchmarkAfter || marketPotentialRent).toLocaleString()}.
            </p>
            <p className="mt-1 text-slate-500">Photo adjustment is capped at −5% to +4% and weighted by visible coverage and confidence.</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <div className="font-semibold text-slate-800">Core formula</div>
            <p className="mt-1 font-mono text-[11px]">
              {displayAuditValue(
                auditOptimizer.formula,
                'effective annual revenue = monthly rent × 12 × (1 − stabilized vacancy risk)',
              )}
            </p>
            <p className="mt-1">
              The optimizer evaluates every ${displayAuditValue(auditOptimizer.searchStep, '25')} increment and selects the strongest collected-return result,
              with a vacancy-recovery near-tie preference when the active subject is stale.
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
          <div className="bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
            Comparable evidence used ({pricingData.comparableListings?.length || 0})
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="sticky top-0 bg-white text-slate-500">
                <tr>
                  <th className="px-3 py-2">Address</th>
                  <th className="px-3 py-2">Ask</th>
                  <th className="px-3 py-2">Size-adjusted</th>
                  <th className="px-3 py-2">Sqft</th>
                  <th className="px-3 py-2">DOM</th>
                  <th className="px-3 py-2">Distance</th>
                  <th className="px-3 py-2">Match score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(pricingData.comparableListings || []).map((comp, index) => (
                  <tr key={comp.id || `${comp.formattedAddress}-${index}`}>
                    <td className="px-3 py-2 font-medium text-slate-700">{comp.formattedAddress || 'Unknown'}</td>
                    <td className="px-3 py-2">${Number(comp.price || 0).toLocaleString()}</td>
                    <td className="px-3 py-2">${Number(comp.sizeAdjustedRent || comp.price || 0).toLocaleString()}</td>
                    <td className="px-3 py-2">{comp.squareFootage?.toLocaleString() || '—'}</td>
                    <td className="px-3 py-2">{comp.daysOnMarket ?? '—'}</td>
                    <td className="px-3 py-2">{comp.distanceMiles != null ? `${comp.distanceMiles.toFixed(2)} mi` : '—'}</td>
                    <td className="px-3 py-2">{comp.compScore != null ? comp.compScore.toFixed(1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-sky-100 bg-sky-50 p-3 text-xs text-sky-800">
          <span className="font-semibold">Evidence limits:</span> ACS is observed but lagged survey data;
          RentCast provides current asking listings rather than closed leases; photo analysis covers only visible areas.
          The recommendation is an auditable decision estimate, not a guaranteed achieved rent or lease-up date.
        </div>
      </div>
    </details>
  );

  const vacancyCutoff = pricingData.scenario?.fullVacancyReason ? (
    <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50/70 p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-rose-700">Vacancy Cutoff Logic</div>
      <p className="mt-2 text-sm text-rose-900 leading-relaxed">{pricingData.scenario.fullVacancyReason}</p>
    </div>
  ) : null;

  const renovationSeparation = (
    <div className="mt-4 rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-sky-50 p-4 flex items-center justify-between gap-4">
      <div>
        <div className="font-semibold text-gray-900">Renovation analysis is separate</div>
        <div className="text-sm text-gray-600 mt-1">
          Use the renovation workflow for property-specific scope, costs, and ROI instead of generic rent add-ons.
        </div>
      </div>
      <button
        onClick={() => {
          if (onNavigateToRenovations) {
            onNavigateToRenovations();
          }
        }}
        className="px-4 py-2 bg-white text-indigo-600 rounded-lg font-semibold hover:bg-indigo-50 transition-colors whitespace-nowrap border border-indigo-200"
      >
        Open Renovation Analysis
      </button>
    </div>
  );

  const localLeasingSignals = pricingData.marketIntelligence ? (
    <div className="mt-6 pt-6 border-t">
      <div className="flex items-center justify-between mb-3">
        <h5 className="font-semibold text-gray-800">Local Leasing Signals</h5>
        <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded font-medium">Scenario inputs</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {pricingData.marketIntelligence.monthsOfSupply != null && (
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <div className="text-[10px] text-slate-600 font-medium">Months of Supply</div>
            <div className="text-lg font-bold text-slate-900 mt-1">{pricingData.marketIntelligence.monthsOfSupply.toFixed(1)}</div>
          </div>
        )}
        {pricingData.marketIntelligence.compStaleShare != null && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-100">
            <div className="text-[10px] text-rose-600 font-medium">Stale Listings</div>
            <div className="text-lg font-bold text-rose-700 mt-1">{pricingData.marketIntelligence.compStaleShare.toFixed(1)}%</div>
          </div>
        )}
        {pricingData.marketIntelligence.compFreshShare != null && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100">
            <div className="text-[10px] text-emerald-600 font-medium">Fresh Listings</div>
            <div className="text-lg font-bold text-emerald-700 mt-1">{pricingData.marketIntelligence.compFreshShare.toFixed(1)}%</div>
          </div>
        )}
        {pricingData.marketIntelligence.listingChurnRate != null && (
          <div className="p-3 rounded-lg bg-sky-50 border border-sky-100">
            <div className="text-[10px] text-sky-600 font-medium">Inventory Flow</div>
            <div className="text-lg font-bold text-sky-700 mt-1">{pricingData.marketIntelligence.listingChurnRate.toFixed(1)}%</div>
          </div>
        )}
        {pricingData.marketIntelligence.grossYieldPct != null && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-100">
            <div className="text-[10px] text-amber-600 font-medium">Gross Yield</div>
            <div className="text-lg font-bold text-amber-700 mt-1">{pricingData.marketIntelligence.grossYieldPct.toFixed(2)}%</div>
          </div>
        )}
        {pricingData.marketIntelligence.priceToRentRatio != null && (
          <div className="p-3 rounded-lg bg-violet-50 border border-violet-100">
            <div className="text-[10px] text-violet-600 font-medium">Price-to-Rent</div>
            <div className="text-lg font-bold text-violet-700 mt-1">{pricingData.marketIntelligence.priceToRentRatio.toFixed(1)}x</div>
          </div>
        )}
      </div>
    </div>
  ) : null;

  const marketConditions = pricingData.macroContext ? (
    <div className="mt-6 pt-6 border-t">
      <div className="flex items-center justify-between mb-3">
        <h5 className="font-semibold text-gray-800 flex items-center gap-2">
          <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          Market Conditions
        </h5>
        <div className="flex items-center gap-1.5">
          {pricingData.dataSources?.rentcast && (
            <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">Rentcast</span>
          )}
          {pricingData.dataSources?.fred && (
            <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded font-medium">FRED</span>
          )}
          {!pricingData.dataSources?.rentcast && !pricingData.dataSources?.fred && (
            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded font-medium">Estimated</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {pricingData.macroContext.mortgage15Rate && (
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-100">
            <div className="text-[10px] text-blue-600 font-medium">15yr Mortgage</div>
            <div className="text-lg font-bold text-blue-700">{pricingData.macroContext.mortgage15Rate}%</div>
            <div className="text-[10px] text-blue-500">Fixed rate</div>
          </div>
        )}
        {pricingData.macroContext.rentalVacancyRate && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-100">
            <div className="text-[10px] text-amber-600 font-medium">Vacancy Rate</div>
            <div className="text-lg font-bold text-amber-700">{pricingData.macroContext.rentalVacancyRate}%</div>
            <div className="text-[10px] text-amber-500">National avg</div>
          </div>
        )}
        {pricingData.macroContext.consumerSentiment && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100">
            <div className="text-[10px] text-emerald-600 font-medium">Consumer Sentiment</div>
            <div className="text-lg font-bold text-emerald-700">{pricingData.macroContext.consumerSentiment}</div>
            <div className="text-[10px] text-emerald-500">UMich Index</div>
          </div>
        )}
        {pricingData.macroContext.constructionPPI && (
          <div className="p-3 rounded-lg bg-orange-50 border border-orange-100">
            <div className="text-[10px] text-orange-600 font-medium">Construction PPI</div>
            <div className="text-lg font-bold text-orange-700">{pricingData.macroContext.constructionPPI}</div>
            <div className="text-[10px] text-orange-500">Materials cost</div>
          </div>
        )}
        {pricingData.macroContext.employmentClaims && (
          <div className="p-3 rounded-lg bg-purple-50 border border-purple-100">
            <div className="text-[10px] text-purple-600 font-medium">Jobless Claims</div>
            <div className="text-lg font-bold text-purple-700">{pricingData.macroContext.employmentClaims}</div>
            <div className="text-[10px] text-purple-500">Weekly avg</div>
          </div>
        )}
      </div>

      {pricingData.marketFactors.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {pricingData.marketFactors.map((factor, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <div className="flex-1">
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="text-gray-700 font-medium">{factor.name}</span>
                  <span className="text-gray-500 flex items-center gap-1">
                    {factor.impact}/100
                    {factor.trend === 'up' && <span className="text-green-500">&#9650;</span>}
                    {factor.trend === 'down' && <span className="text-red-500">&#9660;</span>}
                  </span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      factor.impact >= 80 ? 'bg-emerald-500' :
                      factor.impact >= 60 ? 'bg-blue-500' :
                      factor.impact >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${factor.impact}%` }}
                  />
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5">{factor.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {localLeasingSignals}
    </div>
  ) : null;

  const renovationAnalysisLink = (
    <div className="mt-6 pt-6 border-t">
      <div className="p-4 bg-gradient-to-r from-indigo-500 to-sky-600 rounded-xl text-white flex items-center justify-between gap-4">
        <div>
          <div className="font-semibold">Need renovation-specific ROI?</div>
          <div className="text-sm text-indigo-100">
            Run the dedicated renovation analysis flow for real scope, cost, and value assumptions.
          </div>
        </div>
        <button
          onClick={() => {
            if (onNavigateToRenovations) {
              onNavigateToRenovations();
            }
          }}
          className="px-5 py-2 bg-white text-indigo-600 rounded-lg font-semibold hover:bg-indigo-50 transition-colors whitespace-nowrap"
        >
          Go to Renovation Analysis →
        </button>
      </div>
    </div>
  );

  const unavailableFocusedAsset = (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-500">
      This rental pricing power asset is unavailable for the selected property.
    </div>
  );

  if (focusAsset) {
    switch (focusAsset) {
      case 'bar-comparison':
        return barComparison;
      case 'comparable-listings-map':
        return comparableListingsMap;
      case 'pricing-strategy':
        return pricingStrategySummary;
      case 'interactive-rent-sweep':
        return interactiveRentSweep;
      case 'pricing-model-metrics':
        return pricingModelMetrics;
      case 'vacancy-cutoff':
        return vacancyCutoff ?? unavailableFocusedAsset;
      case 'renovation-separation':
        return renovationSeparation;
      case 'market-conditions':
        return marketConditions ?? unavailableFocusedAsset;
      case 'local-leasing-signals':
        return localLeasingSignals ?? unavailableFocusedAsset;
      case 'renovation-analysis-link':
        return renovationAnalysisLink;
      default:
        return unavailableFocusedAsset;
    }
  }

  return (
    <div className="rounded-xl border bg-white p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h4 className="font-semibold text-gray-900 text-lg flex items-center gap-2">
            <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            Rental Pricing Power
          </h4>
          <p className="text-sm text-gray-500">Current rent vs market potential</p>
        </div>
        <div className="flex items-center gap-4">
          {/* AI Analysis Button */}
          <button
            onClick={fetchAIAnalysis}
            disabled={aiLoading}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              showAiAnalysis
                ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                : 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700'
            } disabled:opacity-50`}
          >
            {aiLoading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Analyzing...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                {showAiAnalysis ? 'Refresh Analysis' : 'AI Pricing Analysis'}
              </>
            )}
          </button>
          <div className="text-right">
            <div className="text-xs text-gray-500">Modeled Year-1 Collected-Rent Delta</div>
            <div className={`text-2xl font-bold ${modeledMonthlyRevenueDelta >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {modeledMonthlyRevenueDelta >= 0 ? '+' : '-'}${Math.abs(modeledMonthlyRevenueDelta).toLocaleString()}/mo
            </div>
          </div>
        </div>
      </div>

      {pricingData.dataSources?.estimated && (
        <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">Estimated fallback:</span> live RentCast comparables were unavailable.
          These values are deterministic placeholders, not comparable-listing evidence; pricing actions should wait for a successful refresh.
        </div>
      )}

      {!pricingData.dataSources?.estimated && !pricingData.dataSources?.listingCompSampleAdequate && (
        <div className="mb-5 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span className="font-semibold">Aggregate benchmark:</span> fewer than eight clean listing comps passed
          the similarity checks, so this analysis uses guarded ZIP/ATTOM market aggregates.
        </div>
      )}

      {/* AI Analysis Panel */}
      {showAiAnalysis && aiAnalysis && (
        <div className="mb-6 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 p-5">
          {/* Analysis Header */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${
                aiAnalysis.situation === 'above_market' 
                  ? aiAnalysis.situationSeverity === 'significant' ? 'bg-yellow-100' : 'bg-green-100'
                  : aiAnalysis.situation === 'below_market'
                  ? 'bg-red-100'
                  : 'bg-blue-100'
              }`}>
                <span className="text-2xl">
                  {aiAnalysis.situation === 'above_market' 
                    ? aiAnalysis.situationSeverity === 'significant' ? '⚠️' : '📈'
                    : aiAnalysis.situation === 'below_market'
                    ? '💸'
                    : '✅'}
                </span>
              </div>
              <div>
                <h5 className="font-bold text-gray-900 text-lg">AI Pricing Analysis</h5>
                <span className={`text-sm font-medium px-2 py-0.5 rounded ${
                  aiAnalysis.situation === 'above_market' 
                    ? 'bg-purple-100 text-purple-700'
                    : aiAnalysis.situation === 'below_market'
                    ? 'bg-orange-100 text-orange-700'
                    : 'bg-green-100 text-green-700'
                }`}>
                  {aiAnalysis.situation === 'above_market' ? 'Above Market' : 
                   aiAnalysis.situation === 'below_market' ? 'Below Market' : 'At Market'}
                  {aiAnalysis.situationSeverity !== 'slight' && ` (${aiAnalysis.situationSeverity})`}
                </span>
              </div>
            </div>
            <button 
              onClick={() => setShowAiAnalysis(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Summary */}
          <p className="text-gray-700 mb-4 leading-relaxed">{aiAnalysis.summary}</p>

          {/* Insight Cards */}
          {aiAnalysis.insightCards && aiAnalysis.insightCards.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {aiAnalysis.insightCards.map((card, idx) => (
                <div 
                  key={idx}
                  className={`p-3 rounded-lg border ${getCardColorClasses(card.color)}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">{card.icon}</span>
                    <span className="text-xs font-medium opacity-80">{card.title}</span>
                  </div>
                  <div className="text-xl font-bold">{card.value}</div>
                  <div className="text-xs opacity-70">{card.subtext}</div>
                </div>
              ))}
            </div>
          )}

          {/* Risks & Opportunities */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {/* Risks */}
            {aiAnalysis.risks && aiAnalysis.risks.length > 0 && (
              <div className="bg-white rounded-lg p-4 border">
                <h6 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                  <span>⚠️</span> Potential Risks
                </h6>
                <div className="space-y-2">
                  {aiAnalysis.risks.map((risk, idx) => (
                    <div key={idx} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          risk.severity === 'high' ? 'bg-red-500' :
                          risk.severity === 'medium' ? 'bg-yellow-500' : 'bg-gray-400'
                        }`}></span>
                        <span className="font-medium text-gray-800">{risk.title}</span>
                      </div>
                      <p className="text-gray-600 ml-4 mt-0.5">{risk.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Opportunities */}
            {aiAnalysis.opportunities && aiAnalysis.opportunities.length > 0 && (
              <div className="bg-white rounded-lg p-4 border">
                <h6 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                  <span>💡</span> Opportunities
                </h6>
                <div className="space-y-2">
                  {aiAnalysis.opportunities.map((opp, idx) => (
                    <div key={idx} className="text-sm">
                      <div className="font-medium text-gray-800">{opp.title}</div>
                      <p className="text-gray-600">{opp.description}</p>
                      <span className="text-xs text-green-600 font-medium">{opp.potentialImpact}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Financial Impact */}
          {aiAnalysis.financialImpact && (
            <div className="bg-white rounded-lg p-4 border mb-4">
              <h6 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <span>💰</span> Financial Impact
              </h6>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
                <div className="text-center">
                  <div className="text-xs text-gray-500">Current Cash Flow</div>
                  <div className={`text-lg font-bold ${aiAnalysis.financialImpact.currentMonthlyCashFlow >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${aiAnalysis.financialImpact.currentMonthlyCashFlow.toLocaleString()}/mo
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-500">Potential Cash Flow</div>
                  <div className="text-lg font-bold text-blue-600">
                    ${aiAnalysis.financialImpact.potentialMonthlyCashFlow.toLocaleString()}/mo
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-500">Annual Difference</div>
                  <div className={`text-lg font-bold ${aiAnalysis.financialImpact.annualDifference >= 0 ? 'text-green-600' : 'text-gray-600'}`}>
                    {aiAnalysis.financialImpact.annualDifference >= 0 ? '+' : ''}${aiAnalysis.financialImpact.annualDifference.toLocaleString()}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-gray-500">5-Year Impact</div>
                  <div className="text-lg font-bold text-purple-600">
                    {aiAnalysis.financialImpact.fiveYearImpact >= 0 ? '+' : ''}${aiAnalysis.financialImpact.fiveYearImpact.toLocaleString()}
                  </div>
                </div>
              </div>
              <p className="text-sm text-gray-600">{aiAnalysis.financialImpact.explanation}</p>
            </div>
          )}

          {/* Recommendations */}
          {aiAnalysis.recommendations && (
            <div className="bg-gradient-to-r from-emerald-50 to-teal-50 rounded-lg p-4 border border-emerald-200">
              <h6 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
                <span>🎯</span> Recommendations
              </h6>
              <p className="text-gray-800 font-medium mb-3">{aiAnalysis.recommendations.primary}</p>
              
              {aiAnalysis.recommendations.actions && aiAnalysis.recommendations.actions.length > 0 && (
                <div className="space-y-2 mb-3">
                  {aiAnalysis.recommendations.actions.map((action, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-sm">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        action.priority === 'immediate' ? 'bg-red-100 text-red-700' :
                        action.priority === 'short-term' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {action.priority}
                      </span>
                      <div>
                        <span className="text-gray-800">{action.action}</span>
                        <span className="text-gray-500 ml-1">→ {action.impact}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-xl p-5 border border-gray-100">
          {barComparison}
          {comparableListingsMap}
        </div>
        <div>
          {pricingStrategySummary}
          {interactiveRentSweep}
          {pricingModelMetrics}
          {vacancyCutoff}
          {renovationSeparation}
        </div>
      </div>

      {pricingCalculationBreakdown}

      {marketConditions}

      {renovationAnalysisLink}
    </div>
  );
}
