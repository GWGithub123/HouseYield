/**
 * Renovation Impact Analyzer
 * Generates renovation plans, estimates costs, analyzes BRRRR viability
 * NOW WITH: ROI filtering, rental cash flow impact, payback period analysis
 * ENHANCED: Area-specific ROI data from Snowflake MLS historical analysis
 */

import {
  AttomProperty,
  DetailedConditionScore,
  RenovationAnalysis,
  RenovationPlan,
  RenovationItem,
  ValuationImpact,
  RentalImpact,
  BRRRRAnalysis,
  RenovationCostEstimate
} from '../types/propertyAnalysis';
import { conductComprehensiveRenovationResearch } from '../services/googleSearchApi';
import { getRegionalLaborMultiplier } from '../services/blsApi';
import { parseRenovationCosts } from '../services/openaiApi';
import type { AreaRenovationSummary, RenovationCategory, PropertyPriceTier, YearBuiltBracket } from '../types/renovationROI';
// Note: areaRenovationROIService removed - using API directly instead
import { getPriceTier, getYearBuiltBracket, normalizePropertyType } from '../services/renovationROICalculator';

// ============================================================================
// LOCAL HELPER: getAreaRenovationROI (simplified in-file implementation)
// ============================================================================
function getAreaRenovationROI(
  areaSummary: AreaRenovationSummary,
  renovationType: RenovationCategory,
  propertyType: string,
  priceTier: PropertyPriceTier,
  yearBracket: YearBuiltBracket,
  materialTier?: string
): {
  estimatedROI: number;
  confidence: 'high' | 'medium' | 'low';
  sampleSize: number;
  dataSource: 'area_specific' | 'area_stratified' | 'area_general' | 'national_estimate';
  avgValueUplift?: number;
  stratifiedUplift?: number; // Uplift from the best stratification match (material tier, price tier, etc.)
  avgRentIncrease?: number;
  avgCost?: number;
  paybackMonths?: number;
  roiTrend?: string;
  materialTierInsight?: { tier: string; avgUplift: number; sampleSize: number } | null;
} {
  // Build list of category names to search for (handles kitchen vs kitchen_full etc.)
  const CATEGORY_ALIASES: Record<string, string[]> = {
    'kitchen': ['kitchen_full', 'kitchen_cosmetic'],
    'kitchen_full': ['kitchen'],
    'kitchen_cosmetic': ['kitchen'],
    'bathroom_master': ['bathroom_full', 'bathroom_cosmetic'],
    'bathroom_secondary': ['bathroom_full', 'bathroom_cosmetic'],
    'bathroom_full': ['bathroom_master', 'bathroom_secondary'],
    'bathroom_cosmetic': ['bathroom_master', 'bathroom_secondary'],
    'basement': ['basement_finish'],
    'basement_finish': ['basement'],
  };
  const categoriesToSearch = [renovationType, ...(CATEGORY_ALIASES[renovationType] || [])];

  // Look up in bestROIRenovations — try exact match first, then aliases
  const match = (areaSummary.bestROIRenovations || []).find(
    (r: any) => categoriesToSearch.includes(r.renovationType)
  );
  
  if (!match) {
    return {
      estimatedROI: getDefaultNationalROI(renovationType),
      confidence: 'low',
      sampleSize: 0,
      dataSource: 'national_estimate'
    };
  }
  
  // Try stratified uplift data first (most specific).
  // Uplift amounts from comps are RELIABLE; ROI from comps is NOT (GPT cost estimates are unreliable).
  // The analyzer will compute accurate ROI using the property's own measurement-based costs.
  let stratifiedUplift: number | null = null;
  let stratifiedSource: 'area_stratified' | 'area_specific' = 'area_specific';
  
  // Check material tier stratification (highest priority — most actionable for user)
  if (materialTier && materialTier !== 'unknown') {
    const matData = match.byMaterialTier?.[materialTier];
    if (matData && matData.sampleSize >= 3) {
      stratifiedUplift = matData.weightedAvgUplift ?? matData.avgUplift;
      stratifiedSource = 'area_stratified';
    }
  }

  // Check price tier stratification
  if (!stratifiedUplift) {
    const tierData = match.byPriceTier?.[priceTier];
    if (tierData && tierData.sampleSize >= 3) {
      stratifiedUplift = tierData.weightedAvgUplift ?? tierData.avgUplift;
      stratifiedSource = 'area_stratified';
    }
  }
  
  // Check property type stratification
  if (!stratifiedUplift) {
    const typeData = match.byPropertyType?.[propertyType];
    if (typeData && typeData.sampleSize >= 3) {
      stratifiedUplift = typeData.weightedAvgUplift ?? typeData.avgUplift;
      stratifiedSource = 'area_stratified';
    }
  }
  
  // Check year built stratification
  if (!stratifiedUplift) {
    const yearData = match.byYearBuilt?.[yearBracket];
    if (yearData && yearData.sampleSize >= 3) {
      stratifiedUplift = yearData.weightedAvgUplift ?? yearData.avgUplift;
      stratifiedSource = 'area_stratified';
    }
  }

  // Material tier insight: always include comparative uplift data if available
  let materialTierInsight: { tier: string; avgUplift: number; sampleSize: number } | null = null;
  if (match.byMaterialTier) {
    const tiers = Object.entries(match.byMaterialTier) as [string, any][];
    const validTiers = tiers.filter(([k, v]: [string, any]) => k !== 'unknown' && v.sampleSize >= 2);
    if (validTiers.length > 0 && materialTier && materialTier !== 'unknown') {
      const currentTierData = match.byMaterialTier[materialTier];
      if (currentTierData) {
        materialTierInsight = {
          tier: materialTier,
          avgUplift: currentTierData.weightedAvgUplift ?? currentTierData.avgUplift,
          sampleSize: currentTierData.sampleSize
        };
      }
    }
  }
  
  // Primary signal: stratified or overall uplift (reliable from comps)
  const finalUplift = stratifiedUplift ?? match.weightedAvgUplift ?? match.avgValueUplift;
  // Secondary signal: ROI (kept for backward compat but less reliable from comps)
  const finalROI = match.avgROI;
  
  return {
    estimatedROI: finalROI,
    confidence: match.confidenceLevel || (match.sampleSize >= 10 ? 'high' : match.sampleSize >= 5 ? 'medium' : 'low'),
    sampleSize: match.sampleSize,
    dataSource: stratifiedSource,
    avgValueUplift: match.weightedAvgUplift ?? match.avgValueUplift,
    stratifiedUplift: finalUplift,
    avgRentIncrease: match.avgRentIncrease,
    avgCost: match.avgCost,
    paybackMonths: match.paybackMonths,
    roiTrend: match.roiTrend,
    materialTierInsight
  };
}

// ============================================================================
// AREA-SPECIFIC ROI LOOKUP (NEW - from Snowflake MLS data)
// ============================================================================

// Cache for area summaries
let areaROICache: Map<string, { data: AreaRenovationSummary; timestamp: number }> = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour cache

/**
 * Fetch area renovation summary from API
 */
async function fetchAreaROISummary(zipCode: string): Promise<AreaRenovationSummary | null> {
  try {
    // Check cache first
    const cached = areaROICache.get(zipCode);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.data;
    }
    
    // Fetch from API (v2 returns { ok, source, summary })
    const response = await fetch(`/api/renovation-roi/area-summary/${zipCode}`);
    if (!response.ok) {
      console.warn(`[AreaROI] Failed to fetch area summary for ${zipCode}: ${response.status}`);
      return null;
    }
    
    const result = await response.json();
    if (!result.ok || !result.summary) {
      return null;
    }
    
    const summary = result.summary as AreaRenovationSummary;
    
    // Log data source for debugging
    if (result.source === 'regional_uplift_analysis') {
      console.log(`[AreaROI] ✅ Using real regional uplift data for ${zipCode} (${summary.totalComparables} comps, ${summary.bestROIRenovations?.length || 0} reno types)`);
    } else {
      console.log(`[AreaROI] ⚠️ Using raw MLS stats for ${zipCode} — background processing not yet available`);
    }
    
    // Cache the result
    areaROICache.set(zipCode, { data: summary, timestamp: Date.now() });
    
    return summary;
  } catch (error) {
    console.error(`[AreaROI] Error fetching area summary:`, error);
    return null;
  }
}

/**
 * Map internal renovation item categories to RenovationCategory
 */
function mapToRenovationCategory(item: string, category: string): RenovationCategory {
  const itemLower = item.toLowerCase();
  const categoryLower = category.toLowerCase();
  
  // Kitchen
  if (itemLower.includes('kitchen')) {
    return itemLower.includes('full') || itemLower.includes('renovation') 
      ? 'kitchen_full' : 'kitchen_cosmetic';
  }
  
  // Bathroom
  if (itemLower.includes('bathroom') || itemLower.includes('bath')) {
    return itemLower.includes('full') || itemLower.includes('renovation') 
      ? 'bathroom_full' : 'bathroom_cosmetic';
  }
  
  // Flooring
  if (itemLower.includes('floor') || itemLower.includes('carpet') || itemLower.includes('hardwood')) {
    return 'flooring';
  }
  
  // Paint
  if (itemLower.includes('paint')) {
    return categoryLower.includes('exterior') ? 'paint_exterior' : 'paint_interior';
  }
  
  // Roof
  if (itemLower.includes('roof')) return 'roof';
  
  // HVAC
  if (itemLower.includes('hvac') || itemLower.includes('heating') || itemLower.includes('cooling') || itemLower.includes('ac')) {
    return 'hvac';
  }
  
  // Windows
  if (itemLower.includes('window')) return 'windows';
  
  // Siding
  if (itemLower.includes('siding')) return 'siding';
  
  // Landscaping
  if (itemLower.includes('landscape') || itemLower.includes('yard') || itemLower.includes('lawn')) {
    return 'landscaping';
  }
  
  // Deck/Patio
  if (itemLower.includes('deck') || itemLower.includes('patio')) return 'deck_patio';
  
  // Garage
  if (itemLower.includes('garage')) return 'garage';
  
  // Basement
  if (itemLower.includes('basement')) return 'basement_finish';
  
  // Addition
  if (itemLower.includes('addition') || itemLower.includes('expand')) return 'addition';
  
  // Pool
  if (itemLower.includes('pool')) return 'pool';
  
  // Solar
  if (itemLower.includes('solar')) return 'solar';
  
  // Smart home
  if (itemLower.includes('smart') || itemLower.includes('automation')) return 'smart_home';
  
  return 'other';
}

/**
 * Get area-specific ROI for a renovation type
 * Falls back to national estimates if no local data available
 */
export async function getLocalizedROI(
  renovationType: RenovationCategory,
  zipCode: string,
  propertyType: string,
  purchasePrice: number,
  yearBuilt: number,
  materialTier?: string
): Promise<{
  estimatedROI: number;
  confidence: 'high' | 'medium' | 'low';
  sampleSize: number;
  dataSource: 'area_specific' | 'area_stratified' | 'area_general' | 'national_estimate';
  avgValueUplift?: number;
  stratifiedUplift?: number;
  avgRentIncrease?: number;
  avgCost?: number;
  paybackMonths?: number;
  roiTrend?: string;
  materialTierInsight?: { tier: string; avgUplift: number; sampleSize: number } | null;
}> {
  try {
    const areaSummary = await fetchAreaROISummary(zipCode);
    
    if (!areaSummary) {
      return {
        estimatedROI: getDefaultNationalROI(renovationType),
        confidence: 'low',
        sampleSize: 0,
        dataSource: 'national_estimate'
      };
    }
    
    const priceTier = getPriceTier(purchasePrice);
    const yearBracket = getYearBuiltBracket(yearBuilt);
    const normalizedType = normalizePropertyType(propertyType);
    
    return getAreaRenovationROI(
      areaSummary,
      renovationType,
      normalizedType,
      priceTier,
      yearBracket,
      materialTier
    );
  } catch (error) {
    console.error('[LocalizedROI] Error:', error);
    return {
      estimatedROI: getDefaultNationalROI(renovationType),
      confidence: 'low',
      sampleSize: 0,
      dataSource: 'national_estimate'
    };
  }
}

/**
 * Default national ROI estimates (fallback)
 */
function getDefaultNationalROI(renovationType: RenovationCategory): number {
  const nationalEstimates: Record<RenovationCategory, number> = {
    'kitchen_full': 75,
    'kitchen_cosmetic': 85,
    'bathroom_full': 70,
    'bathroom_cosmetic': 80,
    'flooring': 90,
    'paint_interior': 120,
    'paint_exterior': 110,
    'roof': 60,
    'hvac': 65,
    'windows': 70,
    'siding': 75,
    'landscaping': 85,
    'deck_patio': 70,
    'garage': 65,
    'basement_finish': 70,
    'addition': 55,
    'pool': 45,
    'solar': 60,
    'smart_home': 50,
    'accessibility': 40,
    'other': 70
  };
  
  return nationalEstimates[renovationType] || 70;
}

// ============================================================================
// RENTAL CASH FLOW IMPACT ANALYSIS - NEW
// ============================================================================

export interface RenovationRentalImpact {
  renovationItem: string;
  cost: number;
  monthlyRentIncrease: number;
  paybackMonths: number;
  paybackYears: number;
  yearlyRentIncrease: number;
  fiveYearReturn: number;
  fiveYearROI: number;
  cashFlowPositiveMonth: number; // Month when cumulative rent increase exceeds cost
  isPositiveROI: boolean;
  rentIncreasePercent: number;
  recommendation: 'highly_recommended' | 'recommended' | 'marginal' | 'not_recommended';
}

export interface RenovationPortfolioAnalysis {
  totalCost: number;
  totalMonthlyRentIncrease: number;
  totalYearlyRentIncrease: number;
  portfolioPaybackMonths: number;
  portfolioROI: number; // 5-year ROI
  cashFlowImpact: {
    before: number;
    after: number;
    improvement: number;
    improvementPercent: number;
  };
  positiveROIItems: RenovationRentalImpact[];
  marginalItems: RenovationRentalImpact[];
  notRecommendedItems: RenovationRentalImpact[];
  wedgePotential: {
    createsWedge: boolean;
    wedgeType: string;
    reason: string;
  };
}

/**
 * Analyze rental cash flow impact of each renovation
 * Returns only renovations with positive ROI for rental properties
 */
export function analyzeRenovationRentalImpact(
  renovations: RenovationItem[],
  currentMonthlyRent: number,
  currentMonthlyCashFlow: number
): RenovationPortfolioAnalysis {
  
  const impacts: RenovationRentalImpact[] = renovations.map(reno => {
    const monthlyRentIncrease = reno.rentImpact || 0;
    const yearlyRentIncrease = monthlyRentIncrease * 12;
    const cost = reno.cost || 0;
    
    // Calculate payback period
    const paybackMonths = monthlyRentIncrease > 0 ? Math.ceil(cost / monthlyRentIncrease) : 999;
    const paybackYears = paybackMonths / 12;
    
    // 5-year return calculation
    const fiveYearReturn = (yearlyRentIncrease * 5) - cost;
    const fiveYearROI = cost > 0 ? ((yearlyRentIncrease * 5) / cost) * 100 : 0;
    
    // Rent increase as percentage
    const rentIncreasePercent = currentMonthlyRent > 0 
      ? (monthlyRentIncrease / currentMonthlyRent) * 100 
      : 0;
    
    // Determine recommendation based on payback and ROI
    let recommendation: RenovationRentalImpact['recommendation'];
    if (paybackMonths <= 24 && fiveYearROI >= 150) {
      recommendation = 'highly_recommended';
    } else if (paybackMonths <= 36 && fiveYearROI >= 100) {
      recommendation = 'recommended';
    } else if (paybackMonths <= 60 && fiveYearROI >= 50) {
      recommendation = 'marginal';
    } else {
      recommendation = 'not_recommended';
    }
    
    return {
      renovationItem: reno.item,
      cost,
      monthlyRentIncrease,
      paybackMonths,
      paybackYears,
      yearlyRentIncrease,
      fiveYearReturn,
      fiveYearROI,
      cashFlowPositiveMonth: paybackMonths,
      isPositiveROI: fiveYearROI > 0,
      rentIncreasePercent,
      recommendation
    };
  });
  
  // Categorize items
  const positiveROIItems = impacts.filter(i => 
    i.recommendation === 'highly_recommended' || i.recommendation === 'recommended'
  );
  const marginalItems = impacts.filter(i => i.recommendation === 'marginal');
  const notRecommendedItems = impacts.filter(i => i.recommendation === 'not_recommended');
  
  // Calculate portfolio totals (only positive ROI items)
  const recommendedItems = [...positiveROIItems, ...marginalItems];
  const totalCost = recommendedItems.reduce((sum, i) => sum + i.cost, 0);
  const totalMonthlyRentIncrease = recommendedItems.reduce((sum, i) => sum + i.monthlyRentIncrease, 0);
  const totalYearlyRentIncrease = totalMonthlyRentIncrease * 12;
  const portfolioPaybackMonths = totalMonthlyRentIncrease > 0 
    ? Math.ceil(totalCost / totalMonthlyRentIncrease) 
    : 999;
  const portfolioROI = totalCost > 0 
    ? ((totalYearlyRentIncrease * 5) / totalCost) * 100 
    : 0;
  
  // Cash flow impact
  const newMonthlyCashFlow = currentMonthlyCashFlow + totalMonthlyRentIncrease;
  const improvement = totalMonthlyRentIncrease;
  const improvementPercent = currentMonthlyCashFlow !== 0 
    ? (improvement / Math.abs(currentMonthlyCashFlow)) * 100 
    : 0;
  
  // Determine wedge potential
  let wedgePotential: RenovationPortfolioAnalysis['wedgePotential'];
  if (currentMonthlyCashFlow < 0 && newMonthlyCashFlow >= 0) {
    wedgePotential = {
      createsWedge: true,
      wedgeType: 'cash_flow_turnaround',
      reason: `Renovations turn negative $${Math.abs(currentMonthlyCashFlow)}/mo cash flow into positive $${newMonthlyCashFlow}/mo`
    };
  } else if (portfolioROI >= 150 && portfolioPaybackMonths <= 24) {
    wedgePotential = {
      createsWedge: true,
      wedgeType: 'high_roi_value_add',
      reason: `${portfolioROI.toFixed(0)}% 5-year ROI with ${portfolioPaybackMonths} month payback creates strong value-add opportunity`
    };
  } else if (totalMonthlyRentIncrease >= currentMonthlyRent * 0.15) {
    wedgePotential = {
      createsWedge: true,
      wedgeType: 'rent_growth_wedge',
      reason: `${((totalMonthlyRentIncrease / currentMonthlyRent) * 100).toFixed(0)}% rent increase significantly above market`
    };
  } else {
    wedgePotential = {
      createsWedge: false,
      wedgeType: 'none',
      reason: 'Renovations improve property but don\'t create exceptional wedge opportunity'
    };
  }
  
  console.log(`[Renovation ROI] Portfolio: $${totalCost} cost, +$${totalMonthlyRentIncrease}/mo rent, ${portfolioPaybackMonths}mo payback, ${portfolioROI.toFixed(0)}% 5yr ROI`);
  console.log(`[Renovation ROI] Recommended: ${positiveROIItems.length}, Marginal: ${marginalItems.length}, Not Recommended: ${notRecommendedItems.length}`);
  
  return {
    totalCost,
    totalMonthlyRentIncrease,
    totalYearlyRentIncrease,
    portfolioPaybackMonths,
    portfolioROI,
    cashFlowImpact: {
      before: currentMonthlyCashFlow,
      after: newMonthlyCashFlow,
      improvement,
      improvementPercent
    },
    positiveROIItems,
    marginalItems,
    notRecommendedItems,
    wedgePotential
  };
}

/**
 * Filter renovation plan to only include positive ROI items for rentals
 * NOW: Less aggressive - includes value-add renovations even if rental payback is longer
 */
export function filterPositiveROIRenovations(
  plan: RenovationPlan,
  _currentMonthlyRent: number, // Used for future enhancements
  _minPaybackMonths: number = 60, // Not used anymore - we categorize instead of filter
  _minROI: number = 50 // Not used anymore
): RenovationPlan {
  
  // DON'T filter out renovations - instead, add ROI metrics to each
  // This way we show ALL suggested renovations but indicate which are rental-positive
  const enhancedScope = plan.scope.map(item => {
    const paybackMonths = (item.rentImpact && item.rentImpact > 0) ? Math.ceil(item.cost / item.rentImpact) : 999;
    const fiveYearRentalReturn = (item.rentImpact || 0) * 12 * 5;
    const fiveYearRentalROI = item.cost > 0 ? (fiveYearRentalReturn / item.cost) * 100 : 0;
    
    // Value ROI (property appreciation from renovation)
    const valueROI = item.cost > 0 ? ((item.valueImpact || 0) / item.cost) * 100 : 0;
    
    // Combined ROI (rental income + value appreciation)
    const combinedFiveYearReturn = fiveYearRentalReturn + (item.valueImpact || 0);
    const combinedROI = item.cost > 0 ? (combinedFiveYearReturn / item.cost) * 100 : 0;
    
    // Is this a good rental investment? (pays back within 5 years from rent alone)
    const isRentalPositive = paybackMonths <= 60 && fiveYearRentalROI >= 50;
    
    // Is this a good value-add investment? (adds significant property value)
    const isValuePositive = valueROI >= 50;
    
    // Is this worth doing? (either rental positive OR value positive)
    const isRecommended = isRentalPositive || isValuePositive || combinedROI >= 75;
    
    console.log(`[ROI Analysis] ${item.item}: Cost $${item.cost}, Rent +$${item.rentImpact}/mo (${paybackMonths}mo payback, ${fiveYearRentalROI.toFixed(0)}% rental ROI), Value +$${item.valueImpact} (${valueROI.toFixed(0)}% value ROI), Combined: ${combinedROI.toFixed(0)}% ROI - ${isRecommended ? 'RECOMMENDED' : 'MARGINAL'}`);
    
    return {
      ...item,
      // Add computed metrics
      paybackMonths,
      fiveYearRentalROI,
      valueROI,
      combinedROI,
      isRentalPositive,
      isValuePositive,
      isRecommended
    };
  });
  
  // Filter to only recommended items (but much more inclusive now)
  const filteredScope = enhancedScope.filter(item => 
    (item as any).isRecommended || item.cost > 0
  );
  
  // Recalculate totals
  const totalCost = filteredScope.reduce((sum, item) => sum + item.cost, 0);
  const expectedRentIncrease = filteredScope.reduce((sum, item) => sum + (item.rentImpact || 0), 0);
  
  console.log(`[ROI Filter] ${plan.scope.length} items → ${filteredScope.length} recommended items`);
  console.log(`[ROI Filter] Total cost: $${totalCost}, Expected rent increase: +$${expectedRentIncrease}/mo`);
  
  return {
    ...plan,
    scope: filteredScope,
    totalCost,
    expectedRentIncrease
  };
}

// ============================================================================
// MAIN RENOVATION ANALYSIS - ENHANCED WITH ROI FILTERING
// ============================================================================

export async function analyzeRenovationImpact(
  property: AttomProperty,
  conditionScore: DetailedConditionScore,
  currentValue: number,
  currentRent: number,
  purchasePrice: number,
  currentMonthlyCashFlow?: number, // Optional: current cash flow for impact analysis
  measurementBasedCosts?: Map<string, { cost: number; costRange: { low: number; high: number }; materials?: any[]; labor?: any[]; confidence: string }> // Optional: pre-computed measurement-based costs from AI renovation endpoint
): Promise<RenovationAnalysis & { rentalPortfolioAnalysis?: RenovationPortfolioAnalysis }> {
  
  // Generate full renovation plan based on condition
  const fullRenovationPlan = await generateRenovationPlan(
    property,
    conditionScore,
    undefined,
    measurementBasedCosts
  );
  
  // FILTER to only positive ROI renovations for rental properties
  // This uses the renovation-market-data.js logic: payback within 5 years, positive 5-year ROI
  const renovationPlan = filterPositiveROIRenovations(
    fullRenovationPlan,
    currentRent,
    60, // 5 year max payback
    50  // 50% minimum 5-year ROI
  );
  
  console.log(`[RenovationAnalysis] Filtered ${fullRenovationPlan.scope.length} renovations to ${renovationPlan.scope.length} positive ROI items`);
  
  // Calculate rental impact analysis for each renovation
  const rentalPortfolioAnalysis = analyzeRenovationRentalImpact(
    renovationPlan.scope,
    currentRent,
    currentMonthlyCashFlow || 0
  );
  
  // Calculate valuation impact
  const valuationImpact = calculateValuationImpact(
    purchasePrice,
    renovationPlan.totalCost,
    currentValue,
    renovationPlan
  );
  
  // Calculate rental impact
  const rentalImpact = calculateRentalImpact(
    currentRent,
    renovationPlan,
    conditionScore
  );
  
  // Analyze BRRRR strategy
  const brrrr = analyzeBRRRRStrategy(
    purchasePrice,
    renovationPlan.totalCost,
    valuationImpact.afterRepairValue,
    rentalImpact.postRenoRent
  );
  
  // Calculate confidence
  const confidence = calculateRenovationConfidence(renovationPlan);
  
  return {
    renovationPlan,
    valuationImpact,
    rentalImpact,
    brrrr,
    confidence,
    dataSources: {
      costs: 'Google Search + OpenAI + BLS',
      rents: 'ATTOM Rental AVM + Condition Adjustment',
      financing: 'Conventional 75% LTV Refinance'
    },
    rentalPortfolioAnalysis // NEW: Detailed rental impact for each renovation
  };
}

// ============================================================================
// RENOVATION PLAN GENERATION - ENHANCED WITH LOCALIZED ROI
// ============================================================================

export async function generateRenovationPlan(
  property: AttomProperty,
  conditionScore: DetailedConditionScore,
  options?: {
    zipCode?: string;
    purchasePrice?: number;
    useLocalizedROI?: boolean;
  },
  measurementBasedCosts?: Map<string, { cost: number; costRange: { low: number; high: number }; materials?: any[]; labor?: any[]; confidence: string }> // Pre-computed from AI renovation endpoint
): Promise<RenovationPlan> {
  
  const scope: RenovationItem[] = [];
  // Extract city from address string (format: "123 Main St, City, ST 12345")
  const addressParts = (property?.address || '').split(',');
  const city = addressParts[1]?.trim() || 'Unknown';
  const state = property?.area_context?.county || addressParts[2]?.trim()?.split(' ')[0] || 'Unknown';
  
  // Extract zipCode from address or options
  const zipCode = options?.zipCode || addressParts[2]?.trim()?.match(/\d{5}/)?.[0] || '';
  const purchasePrice = options?.purchasePrice || property.last_sale_price || 300000;
  const yearBuilt = property.year_built || 1990;
  const propertyType = property.property_type || 'SFH';
  const useLocalizedROI = options?.useLocalizedROI !== false; // Default to true
  
  // Get regional labor multiplier
  const blsMultiplier = await getRegionalLaborMultiplier(city, state);
  
  // Helper function to get ROI + regional uplift data for a renovation type
  async function getROIMultiplier(itemName: string, category: string, defaultROI: number): Promise<{
    roi: number;
    source: string;
    regionalRentIncrease?: number; // Real regional avg rent increase from comps
    regionalValueUplift?: number; // Real regional avg value uplift from comps
    regionalCost?: number; // Real regional avg cost from comps
    paybackMonths?: number;
    roiTrend?: string;
  }> {
    if (!useLocalizedROI || !zipCode) {
      return { roi: defaultROI, source: 'national_estimate' };
    }
    
    try {
      const renoCategory = mapToRenovationCategory(itemName, category);
      const localROI = await getLocalizedROI(
        renoCategory,
        zipCode,
        propertyType,
        purchasePrice,
        yearBuilt
      );
      
      const isRegional = localROI.dataSource !== 'national_estimate';
      // Use stratified uplift (most specific) or overall uplift as the primary value signal.
      // ROI from comps is unreliable (GPT cost estimates); the analyzer computes ROI using its own costs.
      const bestUplift = localROI.stratifiedUplift ?? localROI.avgValueUplift;
      console.log(`[LocalizedROI] ${itemName}: uplift=$${bestUplift || '?'} (${localROI.dataSource}, n=${localROI.sampleSize})${isRegional ? ` | rent=+$${localROI.avgRentIncrease || '?'}/mo` : ''}`);
      
      return { 
        roi: localROI.estimatedROI / 100, // Secondary fallback — comp-based ROI (less reliable)
        source: localROI.dataSource,
        regionalRentIncrease: localROI.avgRentIncrease,
        regionalValueUplift: bestUplift, // PRIMARY signal: uplift from stratified comps
        regionalCost: localROI.avgCost,
        paybackMonths: localROI.paybackMonths,
        roiTrend: localROI.roiTrend
      };
    } catch (error) {
      console.warn(`[LocalizedROI] Error for ${itemName}, using default:`, error);
      return { roi: defaultROI, source: 'national_estimate' };
    }
  }
  
  // Helper: check for measurement-based costs before falling back to Google Search
  function getMeasurementCost(itemName: string): RenovationCostEstimate | null {
    if (!measurementBasedCosts) return null;
    
    // Try exact match first, then fuzzy match
    const normalizedName = itemName.toLowerCase();
    for (const [key, val] of measurementBasedCosts.entries()) {
      if (key.toLowerCase() === normalizedName || 
          normalizedName.includes(key.toLowerCase()) || 
          key.toLowerCase().includes(normalizedName)) {
        console.log(`[MeasurementCost] ✅ Using measurement-based cost for "${itemName}": $${val.cost}`);
        return {
          renovationType: itemName,
          baseCost: val.cost,
          laborCost: val.labor?.reduce((s: number, l: any) => s + (l.cost || 0), 0) || val.cost * 0.4,
          materialCost: val.materials?.reduce((s: number, m: any) => s + (m.cost || 0), 0) || val.cost * 0.6,
          totalCost: val.cost,
          costRange: val.costRange,
          breakdown: {
            labor: val.labor?.reduce((s: number, l: any) => s + (l.cost || 0), 0) || val.cost * 0.4,
            materials: val.materials?.reduce((s: number, m: any) => s + (m.cost || 0), 0) || val.cost * 0.5,
            permits: val.cost * 0.02,
            contingency: val.cost * 0.08
          },
          regionalFactors: ['Photo-measurement-based estimate'],
          confidence: val.confidence as 'high' | 'medium' | 'low' || 'high',
          dataSource: 'Photo Measurements (DA V3 + GPT-4o Vision)',
          lastUpdated: new Date()
        };
      }
    }
    return null;
  }
  
  // =========================================================================
  // PRIORITY 1: AI-Identified Renovation Opportunities (from Visual AI)
  // These are specific value-add opportunities identified from photos
  // =========================================================================
  const aiOpportunities = conditionScore.aiRenovationOpportunities || [];
  
  console.log('[RenovationPlan] Processing AI opportunities:', aiOpportunities.length);
  
  for (const opportunity of aiOpportunities) {
    // Parse cost range (e.g., "$5,000 - $10,000")
    const costMatch = opportunity.estimated_cost_range?.match(/\$?([\d,]+)\s*-\s*\$?([\d,]+)/);
    let estimatedCost = 5000; // Default
    if (costMatch) {
      const lowCost = parseInt(costMatch[1].replace(/,/g, ''));
      const highCost = parseInt(costMatch[2].replace(/,/g, ''));
      estimatedCost = Math.round((lowCost + highCost) / 2);
    }
    
    // Parse rent increase (e.g., "$150/month")
    const rentMatch = opportunity.rent_increase_potential?.match(/\$?([\d,]+)/);
    const rentIncrease = rentMatch ? parseInt(rentMatch[1].replace(/,/g, '')) : 50;
    
    // Determine impact level
    const impact = opportunity.value_add_potential === 'high' ? 'high' : 
                   opportunity.value_add_potential === 'medium' ? 'medium' : 'low';
    
    // Calculate value impact (use ROI estimate if available)
    const roiMatch = opportunity.roi_estimate?.match(/([\d.]+)%/);
    const roiPercent = roiMatch ? parseFloat(roiMatch[1]) / 100 : 0.7;
    const valueImpact = estimatedCost * Math.max(0.5, roiPercent);
    
    scope.push({
      category: opportunity.area,
      item: opportunity.description,
      cost: estimatedCost * blsMultiplier, // Adjust for regional labor
      costRange: { 
        low: estimatedCost * 0.8 * blsMultiplier, 
        high: estimatedCost * 1.2 * blsMultiplier 
      },
      impact: impact as 'high' | 'medium' | 'low',
      rentImpact: rentIncrease,
      valueImpact,
      dataSource: 'Visual AI Analysis',
      confidence: opportunity.value_add_potential === 'high' ? 'high' : 'medium'
    });
    
    console.log(`[RenovationPlan] Added AI opportunity: ${opportunity.area} - ${opportunity.description}, cost: $${estimatedCost}, rent impact: +$${rentIncrease}/mo`);
  }
  
  // =========================================================================
  // PRIORITY 2: Critical/Immediate items (from deferred maintenance)
  // =========================================================================
  const criticalItems = conditionScore.deferredMaintenance.filter(
    item => item.urgency === 'immediate' || item.severity === 'critical'
  );
  
  for (const item of criticalItems) {
    scope.push({
      category: item.category,
      item: item.item,
      cost: item.cost,
      impact: 'high',
      rentImpact: -item.impactOnRent, // Fixing it improves rent
      valueImpact: -item.impactOnValue
    });
  }
  
  // Kitchen renovation (if score < 65)
  if (conditionScore.interior.kitchen.score < 65) {
    const itemName = conditionScore.interior.kitchen.score < 50 ? 'Full Kitchen Renovation' : 'Kitchen Update';
    
    // Prefer measurement-based cost, fall back to Google Search
    const kitchenReno = getMeasurementCost(itemName) || getMeasurementCost('kitchen') || await getRenovationCostEstimate(
      'kitchen remodel',
      city,
      state,
      blsMultiplier,
      property.living_sqft
    );
    const kitchenROIData = await getROIMultiplier(itemName, 'Interior', 0.7);
    
    // Use regional rent increase if available, otherwise fall back to estimates
    const kitchenDefaultRent = conditionScore.interior.kitchen.score < 50 ? 200 : 100;
    const kitchenRentImpact = kitchenROIData.regionalRentIncrease ?? kitchenDefaultRent;
    
    // Use regional value uplift if available, otherwise use cost × ROI multiplier
    const kitchenValueImpact = kitchenROIData.regionalValueUplift ?? (kitchenReno.totalCost * kitchenROIData.roi);
    
    scope.push({
      category: 'Interior',
      item: itemName,
      cost: kitchenReno.totalCost,
      costRange: kitchenReno.costRange,
      impact: 'high',
      rentImpact: kitchenRentImpact,
      valueImpact: kitchenValueImpact,
      dataSource: `${kitchenReno.dataSource} | ROI: ${kitchenROIData.source}${kitchenROIData.roiTrend ? ` (${kitchenROIData.roiTrend})` : ''}`,
      confidence: kitchenReno.confidence
    });
  }
  
  // Bathroom renovations
  if (conditionScore.interior.bathrooms.master.score < 60) {
    const bathroomReno = getMeasurementCost('Master Bathroom Renovation') || getMeasurementCost('master bathroom') || await getRenovationCostEstimate(
      'master bathroom remodel',
      city,
      state,
      blsMultiplier
    );
    
    const masterBathROIData = await getROIMultiplier('Master Bathroom Renovation', 'Interior', 0.65);
    
    scope.push({
      category: 'Interior',
      item: 'Master Bathroom Renovation',
      cost: bathroomReno.totalCost,
      costRange: bathroomReno.costRange,
      impact: 'high',
      rentImpact: masterBathROIData.regionalRentIncrease ?? 100,
      valueImpact: masterBathROIData.regionalValueUplift ?? (bathroomReno.totalCost * masterBathROIData.roi),
      dataSource: `${bathroomReno.dataSource} | ROI: ${masterBathROIData.source}${masterBathROIData.roiTrend ? ` (${masterBathROIData.roiTrend})` : ''}`,
      confidence: bathroomReno.confidence
    });
  }
  
  // Secondary bathrooms
  const needsSecondaryBathReno = conditionScore.interior.bathrooms.secondary.some(
    bath => bath.score < 60
  );
  
  if (needsSecondaryBathReno) {
    const bathReno = getMeasurementCost('Secondary Bathroom Renovation') || getMeasurementCost('bathroom') || await getRenovationCostEstimate(
      'bathroom remodel',
      city,
      state,
      blsMultiplier
    );
    
    const secBathROIData = await getROIMultiplier('Secondary Bathroom Renovation', 'Interior', 0.60);
    
    scope.push({
      category: 'Interior',
      item: 'Secondary Bathroom Renovation',
      cost: bathReno.totalCost,
      costRange: bathReno.costRange,
      impact: 'medium',
      rentImpact: secBathROIData.regionalRentIncrease ?? 50,
      valueImpact: secBathROIData.regionalValueUplift ?? (bathReno.totalCost * secBathROIData.roi),
      dataSource: `${bathReno.dataSource} | ROI: ${secBathROIData.source}${secBathROIData.roiTrend ? ` (${secBathROIData.roiTrend})` : ''}`,
      confidence: bathReno.confidence
    });
  }
  
  // Flooring (if score < 60)
  if (conditionScore.interior.flooring.score < 60) {
    const flooringReno = getMeasurementCost('Flooring Replacement') || getMeasurementCost('flooring') || await getRenovationCostEstimate(
      'flooring replacement',
      city,
      state,
      blsMultiplier,
      property.living_sqft
    );
    
    const floorROIData = await getROIMultiplier('Flooring Replacement', 'Interior', 0.80);
    
    scope.push({
      category: 'Interior',
      item: 'Flooring Replacement',
      cost: flooringReno.totalCost,
      costRange: flooringReno.costRange,
      impact: 'medium',
      rentImpact: floorROIData.regionalRentIncrease ?? 75,
      valueImpact: floorROIData.regionalValueUplift ?? (flooringReno.totalCost * floorROIData.roi),
      dataSource: `${flooringReno.dataSource} | ROI: ${floorROIData.source}${floorROIData.roiTrend ? ` (${floorROIData.roiTrend})` : ''}`,
      confidence: flooringReno.confidence
    });
  }
  
  // Paint (if score < 60)
  if (conditionScore.interior.paint.score < 60) {
    const paintReno = getMeasurementCost('Interior Paint') || getMeasurementCost('paint') || await getRenovationCostEstimate(
      'interior paint',
      city,
      state,
      blsMultiplier,
      property.living_sqft
    );
    
    scope.push({
      category: 'Interior',
      item: 'Interior Paint',
      cost: paintReno.totalCost,
      costRange: paintReno.costRange,
      impact: 'low',
      rentImpact: 25,
      valueImpact: paintReno.totalCost * 1.5, // Paint has excellent ROI
      dataSource: paintReno.dataSource,
      confidence: paintReno.confidence
    });
  }
  
  // Calculate totals
  const totalCost = scope.reduce((sum, item) => sum + item.cost, 0);
  const expectedRentIncrease = scope.reduce((sum, item) => sum + item.rentImpact, 0);
  
  // Estimate timeline (months)
  let timeline = 0;
  if (scope.some(item => item.item.toLowerCase().includes('kitchen'))) timeline += 2;
  if (scope.some(item => item.item.toLowerCase().includes('bathroom'))) timeline += 1.5;
  if (scope.some(item => item.item.toLowerCase().includes('flooring'))) timeline += 1;
  timeline = Math.max(1, Math.ceil(timeline));
  
  // Target grade after renovation
  const currentGrade = conditionScore.overallGrade;
  const targetGrade = calculateTargetGrade(currentGrade, scope);
  
  return {
    scope,
    totalCost,
    timeline,
    targetGrade,
    expectedRentIncrease
  };
}

async function getRenovationCostEstimate(
  renovationType: string,
  city: string,
  state: string,
  blsMultiplier: number,
  sqft?: number
): Promise<RenovationCostEstimate> {
  
  // Default fallback costs if API calls fail
  const defaultCosts: { [key: string]: number } = {
    'kitchen remodel': 35000,
    'master bathroom remodel': 18000,
    'bathroom remodel': 12000,
    'flooring replacement': sqft ? sqft * 8 : 15000,
    'interior paint': sqft ? sqft * 3 : 6000,
    'roof replacement': 12000,
    'hvac replacement': 8000,
    'siding replacement': 15000,
    'window replacement': 10000
  };
  
  try {
    // Conduct Google Search research
    const searchResults = await conductComprehensiveRenovationResearch(
      renovationType,
      city,
      state,
      sqft
    );
    
    // Parse with OpenAI
    const estimate = await parseRenovationCosts(
      renovationType,
      city,
      state,
      searchResults,
      blsMultiplier
    );
    
    // If API returned valid cost, use it; otherwise use default
    if (estimate.totalCost > 0) {
      return estimate;
    }
  } catch (error) {
    console.error('[RenovationCost] API call failed, using defaults:', error);
  }
  
  // Fallback to default costs
  const baseCost = defaultCosts[renovationType.toLowerCase()] || 10000;
  const adjustedCost = baseCost * blsMultiplier;
  
  return {
    renovationType,
    baseCost: adjustedCost,
    laborCost: adjustedCost * 0.4,
    materialCost: adjustedCost * 0.6,
    totalCost: adjustedCost,
    costRange: {
      low: adjustedCost * 0.8,
      high: adjustedCost * 1.2
    },
    breakdown: {
      labor: adjustedCost * 0.4,
      materials: adjustedCost * 0.5,
      permits: adjustedCost * 0.02,
      contingency: adjustedCost * 0.08
    },
    regionalFactors: [`${city}, ${state} market average`],
    confidence: 'medium',
    dataSource: 'Industry average estimates',
    lastUpdated: new Date()
  };
}

function calculateTargetGrade(currentGrade: string, scope: RenovationItem[]): string {
  const gradeOrder = ['D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];
  const currentIndex = gradeOrder.indexOf(currentGrade);
  
  // Each major renovation moves up ~1 grade
  const majorRenos = scope.filter(item => item.impact === 'high').length;
  const mediumRenos = scope.filter(item => item.impact === 'medium').length;
  
  const gradeImprovement = Math.floor(majorRenos + (mediumRenos * 0.5));
  const targetIndex = Math.min(gradeOrder.length - 1, currentIndex + gradeImprovement + 1);
  
  return gradeOrder[targetIndex];
}

// ============================================================================
// VALUATION IMPACT
// ============================================================================

function calculateValuationImpact(
  purchasePrice: number,
  renovationCost: number,
  currentValue: number,
  renovationPlan: RenovationPlan
): ValuationImpact {
  
  // Calculate forced appreciation (value added from renovations)
  const forcedAppreciation = renovationPlan.scope.reduce(
    (sum, item) => sum + item.valueImpact,
    0
  );
  
  // After Repair Value
  const afterRepairValue = currentValue + forcedAppreciation;
  
  // Total equity created
  const totalEquityCreated = afterRepairValue - purchasePrice - renovationCost;
  
  return {
    purchasePrice,
    renovationCost,
    afterRepairValue,
    forcedAppreciation,
    totalEquityCreated
  };
}

// ============================================================================
// RENTAL IMPACT
// ============================================================================

function calculateRentalImpact(
  currentRent: number,
  renovationPlan: RenovationPlan,
  _conditionScore: DetailedConditionScore
): RentalImpact {
  
  const monthlyIncrease = renovationPlan.expectedRentIncrease;
  const postRenoRent = currentRent + monthlyIncrease;
  const annualIncrease = monthlyIncrease * 12;
  
  return {
    currentRent,
    postRenoRent,
    monthlyIncrease,
    annualIncrease
  };
}

// ============================================================================
// BRRRR STRATEGY ANALYSIS
// ============================================================================

export function analyzeBRRRRStrategy(
  purchasePrice: number,
  renovationCost: number,
  afterRepairValue: number,
  postRenoRent: number,
  _existingLoanBalance: number = 0
): BRRRRAnalysis {
  
  const totalInvestment = purchasePrice + renovationCost;
  
  // Initial financing: 20% down conventional
  const initialDownPayment = purchasePrice * 0.20;
  const initialLoan = purchasePrice - initialDownPayment;
  
  // Cash required upfront
  const initialCashRequired = initialDownPayment + renovationCost + (purchasePrice * 0.025); // + closing
  
  // After renovations, refinance at 75% LTV
  const refinanceAmount = afterRepairValue * 0.75;
  const refinanceRate = 7.25; // Slightly higher for cash-out refi
  const newMonthlyDebtService = calculateMonthlyPayment(refinanceAmount, refinanceRate, 360);
  
  // Calculate cash recovered
  const cashRecovered = refinanceAmount - initialLoan;
  const cashLeftInDeal = initialCashRequired - cashRecovered;
  const capitalRecoveryPercent = (cashRecovered / initialCashRequired) * 100;
  
  // Operating expenses (simplified - 50% rule)
  const monthlyExpenses = postRenoRent * 0.50;
  
  // Post-refinance cash flow
  const postRefinanceCashFlow = postRenoRent - monthlyExpenses - newMonthlyDebtService;
  const annualCashFlow = postRefinanceCashFlow * 12;
  
  // Final metrics
  const infiniteReturn = cashLeftInDeal <= 0;
  const finalCashOnCash = cashLeftInDeal > 0
    ? (annualCashFlow / cashLeftInDeal) * 100
    : 999; // Infinite
  
  // Forced appreciation
  const forcedAppreciation = afterRepairValue - totalInvestment;
  
  // Determine viability
  const viable = (
    afterRepairValue > totalInvestment * 1.10 && // At least 10% equity
    postRefinanceCashFlow > 0 && // Positive cash flow
    capitalRecoveryPercent > 75 // Recover most of capital
  );
  
  const recommendation = generateBRRRRRecommendation(
    viable,
    infiniteReturn,
    capitalRecoveryPercent,
    postRefinanceCashFlow,
    forcedAppreciation
  );
  
  return {
    strategy: 'BRRRR',
    purchasePrice,
    renovationCost,
    totalInvestment,
    initialCashRequired,
    afterRepairValue,
    forcedAppreciation,
    refinanceAmount,
    refinanceRate,
    newMonthlyDebtService,
    originalLoan: initialLoan,
    cashRecovered,
    cashLeftInDeal,
    capitalRecoveryPercent,
    postRefinanceCashFlow,
    infiniteReturn,
    finalCashOnCash,
    viable,
    recommendation
  };
}

function calculateMonthlyPayment(principal: number, annualRate: number, months: number): number {
  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate === 0) return principal / months;
  
  return principal * (
    monthlyRate * Math.pow(1 + monthlyRate, months)
  ) / (
    Math.pow(1 + monthlyRate, months) - 1
  );
}

function generateBRRRRRecommendation(
  viable: boolean,
  infiniteReturn: boolean,
  capitalRecoveryPercent: number,
  cashFlow: number,
  forcedAppreciation: number
): string {
  
  if (!viable) {
    return `BRRRR not viable. Insufficient equity creation or negative post-refi cash flow.`;
  }
  
  if (infiniteReturn) {
    return `Excellent BRRRR opportunity! Infinite return - all capital recovered with $${cashFlow.toFixed(0)}/mo positive cash flow.`;
  }
  
  if (capitalRecoveryPercent >= 90) {
    return `Strong BRRRR candidate. ${capitalRecoveryPercent.toFixed(0)}% capital recovery, $${cashFlow.toFixed(0)}/mo cash flow, $${forcedAppreciation.toFixed(0)} forced appreciation.`;
  }
  
  if (capitalRecoveryPercent >= 75) {
    return `Good BRRRR potential. ${capitalRecoveryPercent.toFixed(0)}% capital recovery, $${cashFlow.toFixed(0)}/mo cash flow.`;
  }
  
  return `Marginal BRRRR. Only ${capitalRecoveryPercent.toFixed(0)}% capital recovery. Consider if appreciation outlook is strong.`;
}

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

function calculateRenovationConfidence(plan: RenovationPlan): number {
  // Average confidence of all renovation items
  const itemsWithConfidence = plan.scope.filter(item => item.confidence);
  
  if (itemsWithConfidence.length === 0) return 0.70; // Default medium
  
  const confidenceScores = itemsWithConfidence.map(item => {
    switch (item.confidence) {
      case 'high': return 0.90;
      case 'medium': return 0.75;
      case 'low': return 0.60;
      default: return 0.70;
    }
  });
  
  const avgConfidence = confidenceScores.reduce((sum, score) => sum + score, 0) / confidenceScores.length;
  
  return avgConfidence;
}
