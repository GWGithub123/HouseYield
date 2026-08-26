/**
 * Wedge Deal Detection System
 * Identifies investment opportunities: valuation gaps, distressed sellers, value-add, etc.
 * ENHANCED: Data-driven renovation recommendations from Snowflake MLS analysis
 */

import {
  AttomProperty,
  DetailedConditionScore,
  ValuationAnalysis,
  RenovationAnalysis,
  BRRRRAnalysis,
  WedgeOpportunity,
  WedgeType
} from '../types/propertyAnalysis';
import type { AreaRenovationSummary, RenovationCategory } from '../types/renovationROI';
// Note: areaRenovationROIService removed - using API directly instead

// ============================================================================
// LOCAL HELPERS (simplified in-file implementations)
// ============================================================================
function getBestRenovationOpportunities(summary: AreaRenovationSummary, limit: number = 5) {
  if (!summary.bestROIRenovations) return [];
  return summary.bestROIRenovations.slice(0, limit).map((r: any) => ({
    renovationType: r.renovationType,
    estimatedROI: r.avgROI,
    avgValueIncrease: r.avgValueUplift || (r.avgROI * 1000), // Use real data if available
    avgRentIncrease: r.avgRentIncrease || 0,
    avgCost: r.avgCost || 0,
    confidence: r.confidenceLevel || 'medium',
    trend: (r.roiTrend === 'rising' ? 'rising' : r.roiTrend === 'falling' ? 'falling' : 'stable') as 'rising' | 'stable' | 'falling',
    paybackMonths: r.paybackMonths || 0,
    sampleSize: r.sampleSize || 0
  }));
}

function getMarketTimingSignals(summary: AreaRenovationSummary): {
  overallSignal: 'favorable' | 'neutral' | 'unfavorable';
  saturationRisk: 'low' | 'medium' | 'high';
  roiTrend: 'rising' | 'stable' | 'falling';
  recommendations: string[];
} {
  const signals = summary.marketSignals;
  if (!signals) {
    return {
      overallSignal: 'neutral',
      saturationRisk: 'low',
      roiTrend: 'stable',
      recommendations: ['Limited market data available']
    };
  }
  
  // Determine ROI trend from individual renovation trends
  const renovations = summary.bestROIRenovations || [];
  const trendCounts = { rising: 0, falling: 0, stable: 0 };
  for (const r of renovations as any[]) {
    const trend = r.roiTrend || 'stable';
    if (trend in trendCounts) trendCounts[trend as keyof typeof trendCounts]++;
  }
  const dominantTrend = trendCounts.rising > trendCounts.falling ? 'rising' : trendCounts.falling > trendCounts.rising ? 'falling' : 'stable';
  
  return {
    overallSignal: signals.overallHealth === 'strong' ? 'favorable' : signals.overallHealth === 'weak' ? 'unfavorable' : 'neutral',
    saturationRisk: signals.saturatedRenovations?.length > 3 ? 'high' : signals.saturatedRenovations?.length > 0 ? 'medium' : 'low',
    roiTrend: dominantTrend,
    recommendations: signals.warnings || []
  };
}

// ============================================================================
// AREA ROI DATA INTEGRATION
// ============================================================================

// Cache for area summaries
let areaROICache: Map<string, { data: AreaRenovationSummary | null; timestamp: number }> = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour cache

/**
 * Fetch area renovation summary from API
 */
async function fetchAreaROISummary(zipCode: string): Promise<AreaRenovationSummary | null> {
  try {
    const cached = areaROICache.get(zipCode);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.data;
    }
    
    const response = await fetch(`/api/renovation-roi/area-summary/${zipCode}`);
    if (!response.ok) return null;
    
    const result = await response.json();
    const data = result.ok ? (result.summary || null) : null;
    
    if (data && result.source === 'regional_uplift_analysis') {
      console.log(`[WedgeDetector] ✅ Using regional uplift data for ${zipCode} (${data.totalComparables} comps)`);
    }
    
    areaROICache.set(zipCode, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.warn('[WedgeDetector] Error fetching area ROI data:', error);
    return null;
  }
}

/**
 * Data-driven renovation opportunity detection
 * Uses actual market data from Snowflake MLS to recommend high-ROI renovations
 */
export interface DataDrivenRenovationSignal {
  renovationType: RenovationCategory;
  avgROI: number;
  avgValueIncrease: number;
  sampleSize: number;
  confidence: 'high' | 'medium' | 'low';
  trend: 'rising' | 'stable' | 'falling';
  recommendationStrength: 'strong' | 'moderate' | 'weak';
}

export interface MarketTimingSignal {
  overallSignal: 'favorable' | 'neutral' | 'caution';
  saturationRisk: 'low' | 'medium' | 'high';
  roiTrend: 'rising' | 'stable' | 'falling';
  recommendations: string[];
}

/**
 * Get data-driven renovation recommendations for an area
 */
export async function getDataDrivenRenovationOpportunities(
  zipCode: string
): Promise<{
  topOpportunities: DataDrivenRenovationSignal[];
  marketTiming: MarketTimingSignal;
  dataAvailable: boolean;
}> {
  const areaSummary = await fetchAreaROISummary(zipCode);
  
  if (!areaSummary) {
    return {
      topOpportunities: [],
      marketTiming: {
        overallSignal: 'neutral',
        saturationRisk: 'low',
        roiTrend: 'stable',
        recommendations: ['Insufficient local data - using national estimates']
      },
      dataAvailable: false
    };
  }
  
  const bestOps = getBestRenovationOpportunities(areaSummary, 5);
  const timing = getMarketTimingSignals(areaSummary);
  
  const topOpportunities: DataDrivenRenovationSignal[] = bestOps.map(op => ({
    renovationType: op.renovationType,
    avgROI: op.estimatedROI,
    avgValueIncrease: op.avgValueIncrease,
    sampleSize: op.sampleSize,
    confidence: op.confidence,
    trend: op.trend,
    recommendationStrength: op.estimatedROI >= 100 ? 'strong' : op.estimatedROI >= 70 ? 'moderate' : 'weak'
  }));
  
  return {
    topOpportunities,
    marketTiming: timing,
    dataAvailable: true
  };
}

// ============================================================================
// MAIN WEDGE DETECTION
// ============================================================================

export interface WedgeDetectionOptions {
  zipCode?: string;
  useDataDrivenROI?: boolean;
}

export function detectWedgeOpportunities(
  property: AttomProperty,
  valuation: ValuationAnalysis,
  conditionScore: DetailedConditionScore,
  renovationAnalysis?: RenovationAnalysis,
  brrrr?: BRRRRAnalysis,
  listPrice?: number
): WedgeOpportunity[] {
  
  const wedges: WedgeOpportunity[] = [];
  
  // 1. Valuation Gap Wedge
  const valuationGapWedge = detectValuationGap(valuation, listPrice);
  if (valuationGapWedge) wedges.push(valuationGapWedge);
  
  // 2. Distressed Seller Wedge
  const distressedWedge = detectDistressedSeller(property);
  if (distressedWedge) wedges.push(distressedWedge);
  
  // 3. Value-Add Wedge
  const valueAddWedge = detectValueAdd(conditionScore, renovationAnalysis);
  if (valueAddWedge) wedges.push(valueAddWedge);
  
  // 4. Value-Add Rental Wedge
  const rentalValueAddWedge = detectValueAddRental(renovationAnalysis);
  if (rentalValueAddWedge) wedges.push(rentalValueAddWedge);
  
  // 5. Off-Market Wedge
  const offMarketWedge = detectOffMarket(property, listPrice);
  if (offMarketWedge) wedges.push(offMarketWedge);
  
  // 6. Assumable Loan Wedge (VA only for rentals)
  const assumableWedge = detectAssumableLoan(property);
  if (assumableWedge) wedges.push(assumableWedge);
  
  // 7. House-Hack Wedge (FHA/VA with owner-occupancy)
  const houseHackWedge = detectHouseHack(property, renovationAnalysis);
  if (houseHackWedge) wedges.push(houseHackWedge);
  
  // 8. Tax Appeal Wedge
  const taxAppealWedge = detectTaxAppeal(property, valuation);
  if (taxAppealWedge) wedges.push(taxAppealWedge);
  
  // 9. BRRRR Wedge
  const brrrrWedge = detectBRRRR(brrrr);
  if (brrrrWedge) wedges.push(brrrrWedge);
  
  // 10. Flip Wedge
  const flipWedge = detectFlip(renovationAnalysis, property);
  if (flipWedge) wedges.push(flipWedge);
  
  // Sort by potential profit (descending)
  return wedges.sort((a, b) => b.potentialProfit - a.potentialProfit);
}

/**
 * Enhanced wedge detection with data-driven renovation recommendations
 * Uses Snowflake MLS historical data to identify highest-ROI renovations for the area
 */
export async function detectWedgeOpportunitiesEnhanced(
  property: AttomProperty,
  valuation: ValuationAnalysis,
  conditionScore: DetailedConditionScore,
  renovationAnalysis?: RenovationAnalysis,
  brrrr?: BRRRRAnalysis,
  listPrice?: number,
  options?: WedgeDetectionOptions
): Promise<{
  wedges: WedgeOpportunity[];
  dataDrivenInsights?: {
    topRenovations: DataDrivenRenovationSignal[];
    marketTiming: MarketTimingSignal;
    dataAvailable: boolean;
  };
}> {
  
  // Get standard wedges
  const wedges = detectWedgeOpportunities(
    property,
    valuation,
    conditionScore,
    renovationAnalysis,
    brrrr,
    listPrice
  );
  
  // Get data-driven insights if ZIP code provided
  let dataDrivenInsights;
  
  if (options?.zipCode && options?.useDataDrivenROI !== false) {
    try {
      dataDrivenInsights = await getDataDrivenRenovationOpportunities(options.zipCode);
      
      // Enhance value-add wedges with data-driven confidence
      if (dataDrivenInsights.dataAvailable) {
        for (const wedge of wedges) {
          if (wedge.type === WedgeType.VALUE_ADD || wedge.type === WedgeType.FLIP) {
            // Boost confidence if market timing is favorable
            if (dataDrivenInsights.marketTiming.overallSignal === 'favorable') {
              wedge.confidence = Math.min(0.95, wedge.confidence + 0.10);
              wedge.signals = [
                ...wedge.signals,
                '📈 Market timing favorable for renovations',
                `📊 Based on ${dataDrivenInsights.topRenovations.reduce((sum, r) => sum + r.sampleSize, 0)} local renovation comparables`
              ];
            } else if (dataDrivenInsights.marketTiming.overallSignal === 'caution') {
              wedge.confidence = Math.max(0.30, wedge.confidence - 0.15);
              wedge.signals = [
                ...wedge.signals,
                '⚠️ Market timing cautious - renovation ROI declining in area'
              ];
            }
            
            // Add top renovation opportunities to details
            wedge.details = {
              ...wedge.details,
              dataDrivenRecommendations: dataDrivenInsights.topRenovations.slice(0, 3)
            };
          }
        }
      }
    } catch (error) {
      console.warn('[WedgeDetector] Error getting data-driven insights:', error);
    }
  }
  
  return {
    wedges: wedges.sort((a, b) => b.potentialProfit - a.potentialProfit),
    dataDrivenInsights
  };
}

// ============================================================================
// WEDGE TYPE 1: VALUATION GAP
// ============================================================================

function detectValuationGap(
  valuation: ValuationAnalysis,
  listPrice?: number
): WedgeOpportunity | null {
  
  if (!listPrice) return null;
  
  const gap = valuation.indicatedValue - listPrice;
  const gapPercent = (gap / listPrice) * 100;
  
  // Only wedge if undervalued by at least 10%
  if (gapPercent < 10) return null;
  
  let confidence = 0.70;
  if (valuation.confidence === 'high' && gapPercent > 15) confidence = 0.90;
  else if (valuation.confidence === 'high') confidence = 0.85;
  else if (valuation.confidence === 'medium' && gapPercent > 20) confidence = 0.80;
  else if (gapPercent > 25) confidence = 0.75;
  
  const potentialProfit = gap * 0.85; // 15% haircut for transaction costs
  
  return {
    type: WedgeType.VALUATION_GAP,
    confidence,
    potentialProfit,
    timeframe: 'Immediate (buy and hold)',
    capitalRequired: listPrice * 0.20, // 20% down
    risk: gapPercent > 20 ? 'low' : 'medium',
    strategy: `Property is ${gapPercent.toFixed(1)}% undervalued. Purchase at list price and capture immediate equity.`,
    barriers: ['Requires verification of valuation', 'Competition from other buyers'],
    details: {
      listPrice,
      indicatedValue: valuation.indicatedValue,
      gap,
      gapPercent,
      confidence: valuation.confidence
    },
    signals: [
      `${gapPercent.toFixed(1)}% below market value`,
      `$${gap.toFixed(0)} immediate equity`,
      `${valuation.confidence} confidence valuation`
    ]
  };
}

// ============================================================================
// WEDGE TYPE 2: DISTRESSED SELLER
// ============================================================================

function detectDistressedSeller(property: AttomProperty): WedgeOpportunity | null {
  
  const signals: string[] = [];
  let distressScore = 0;
  
  // Check for distress signals
  
  // 1. Tax history shows declining payments or high increases
  if (property.tax_history && property.tax_history.length >= 2) {
    const recent = property.tax_history[0];
    const _previous = property.tax_history[1];
    
    if (recent.tax_amount_yoy_pct && recent.tax_amount_yoy_pct > 20) {
      distressScore += 15;
      signals.push(`Property taxes increased ${recent.tax_amount_yoy_pct.toFixed(0)}% YoY`);
    }
  }
  
  // 2. Absentee owner (out-of-state landlord may be motivated)
  if (property.owner?.absentee_status === 'Absentee Owner') {
    distressScore += 20;
    signals.push('Absentee owner - may be tired landlord');
  }
  
  // 3. Corporate ownership (institutional may be portfolio trimming)
  if (property.owner?.is_corporate) {
    distressScore += 10;
    signals.push('Corporate ownership');
  }
  
  // 4. Old ownership (long-term hold may indicate inheritance or burnout)
  const ownershipYears = estimateOwnershipDuration(property);
  if (ownershipYears > 15) {
    distressScore += 15;
    signals.push(`${ownershipYears}+ years ownership - potential burnout`);
  }
  
  // 5. Building permits (recent work may indicate preparation to sell)
  if (property.building_permits && property.building_permits.length > 0) {
    distressScore += 10;
    signals.push('Recent building permits - preparing to sell');
  }
  
  // Need at least 30 distress score for wedge
  if (distressScore < 30) return null;
  
  const confidence = distressScore >= 50 ? 0.75 : 0.60;
  const potentialDiscount = Math.min(20, distressScore / 3); // Up to 20% discount
  const potentialProfit = property.avm_value * (potentialDiscount / 100) * 0.85;
  
  return {
    type: WedgeType.DISTRESSED_SELLER,
    confidence,
    potentialProfit,
    timeframe: '3-6 months (negotiation)',
    capitalRequired: property.avm_value * 0.80 * 0.20, // Discounted price, 20% down
    risk: 'medium',
    strategy: `Seller shows ${distressScore} distress indicators. Negotiate ${potentialDiscount.toFixed(0)}% discount with creative terms.`,
    barriers: ['Requires direct contact with seller', 'May need creative financing'],
    details: {
      distressScore,
      estimatedDiscount: potentialDiscount,
      ownershipYears
    },
    signals
  };
}

function estimateOwnershipDuration(property: AttomProperty): number {
  // Use mortgage date if available
  if (property.mortgage?.date) {
    const mortgageDate = new Date(property.mortgage.date);
    const years = (Date.now() - mortgageDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
    return Math.floor(years);
  }
  
  // Otherwise estimate from property age and ownership type
  return 0;
}

// ============================================================================
// WEDGE TYPE 3: VALUE-ADD (FLIP)
// ============================================================================

function detectValueAdd(
  conditionScore: DetailedConditionScore,
  renovationAnalysis?: RenovationAnalysis
): WedgeOpportunity | null {
  
  if (!renovationAnalysis) return null;
  
  const { valuationImpact, renovationPlan } = renovationAnalysis;
  
  // Need significant forced appreciation for value-add wedge
  const forcedAppreciation = valuationImpact.forcedAppreciation;
  const renovationCost = renovationPlan.totalCost;
  const roi = forcedAppreciation / renovationCost;
  
  // Need at least 50% ROI on renovations
  if (roi < 0.50) return null;
  
  const netProfit = forcedAppreciation - renovationCost;
  
  // After transaction costs (buy at 3%, sell at 8% = 11%)
  const transactionCosts = valuationImpact.afterRepairValue * 0.11;
  const finalProfit = netProfit - transactionCosts;
  
  // Need at least $20k profit after costs
  if (finalProfit < 20000) return null;
  
  let confidence = 0.70;
  if (renovationAnalysis.confidence > 0.85 && roi > 0.70) confidence = 0.85;
  else if (roi > 0.60) confidence = 0.75;
  
  // Boost confidence if AI identified high-value opportunities
  const aiOpportunities = conditionScore.aiRenovationOpportunities || [];
  const highValueAIOpps = aiOpportunities.filter(o => o.value_add_potential === 'high');
  if (highValueAIOpps.length > 0) {
    confidence = Math.min(0.95, confidence + 0.10);
  }
  
  const timeline = renovationPlan.timeline + 2; // + 2 months to sell
  
  // Build signals from AI opportunities
  const aiSignals = aiOpportunities.slice(0, 3).map(o => 
    `${o.area}: ${o.description.slice(0, 50)}${o.description.length > 50 ? '...' : ''}`
  );
  
  return {
    type: WedgeType.VALUE_ADD,
    confidence,
    potentialProfit: finalProfit,
    timeframe: `${timeline} months (renovate + sell)`,
    capitalRequired: valuationImpact.purchasePrice * 0.20 + renovationCost,
    risk: roi > 0.70 ? 'low' : 'medium',
    strategy: `Invest $${renovationCost.toFixed(0)} in renovations to create $${forcedAppreciation.toFixed(0)} in value (${(roi * 100).toFixed(0)}% ROI). Sell for $${finalProfit.toFixed(0)} profit.`,
    barriers: [
      'Requires renovation capital',
      'Time to complete renovations',
      'Market conditions must hold'
    ],
    details: {
      renovationCost,
      forcedAppreciation,
      roi,
      afterRepairValue: valuationImpact.afterRepairValue,
      transactionCosts,
      timeline,
      aiOpportunities: aiOpportunities.map(o => ({
        area: o.area,
        description: o.description,
        costRange: o.estimated_cost_range,
        valueAdd: o.value_add_potential,
        rentIncrease: o.rent_increase_potential
      }))
    },
    signals: [
      `${(roi * 100).toFixed(0)}% ROI on renovations`,
      `$${forcedAppreciation.toFixed(0)} forced appreciation`,
      `${conditionScore.overallGrade} to ${renovationPlan.targetGrade} grade improvement`,
      ...aiSignals
    ]
  };
}

// ============================================================================
// WEDGE TYPE 4: VALUE-ADD RENTAL - ENHANCED WITH RENTAL VIABILITY IMPACT
// ============================================================================

function detectValueAddRental(
  renovationAnalysis?: RenovationAnalysis
): WedgeOpportunity | null {
  
  if (!renovationAnalysis) return null;
  
  const { rentalImpact, renovationPlan, brrrr } = renovationAnalysis;
  
  // Access the new rental portfolio analysis if available
  const rentalPortfolio = (renovationAnalysis as any).rentalPortfolioAnalysis;
  
  // Need significant rent increase and positive post-reno cash flow
  const rentIncrease = rentalImpact.monthlyIncrease;
  const annualIncrease = rentIncrease * 12;
  const renovationCost = renovationPlan.totalCost;
  
  // Calculate payback using monthly rent increase (more accurate)
  const paybackMonths = rentIncrease > 0 ? Math.ceil(renovationCost / rentIncrease) : 999;
  const paybackYears = paybackMonths / 12;
  
  // Calculate 5-year ROI
  const fiveYearReturn = annualIncrease * 5;
  const fiveYearROI = renovationCost > 0 ? ((fiveYearReturn / renovationCost) * 100) : 0;
  
  // Need payback within 5 years AND positive ROI
  if (paybackYears > 5 || rentIncrease < 100 || fiveYearROI < 50) return null;
  
  // If BRRRR viable with good capital recovery, prefer that wedge
  if (brrrr?.viable && brrrr.capitalRecoveryPercent > 80) return null;
  
  let confidence = renovationAnalysis.confidence;
  
  // Extract renovation items by ROI recommendation
  const highlyRecommended = rentalPortfolio?.positiveROIItems || [];
  const _marginalItems = rentalPortfolio?.marginalItems || []; // For future use
  
  // Build renovation breakdown with individual payback periods
  const renovationBreakdown = renovationPlan.scope.map(item => {
    const itemPaybackMonths = item.rentImpact > 0 ? Math.ceil(item.cost / item.rentImpact) : 999;
    const itemFiveYearROI = item.cost > 0 ? ((item.rentImpact * 12 * 5) / item.cost * 100) : 0;
    
    return {
      item: item.item,
      cost: item.cost,
      rentImpact: item.rentImpact,
      paybackMonths: itemPaybackMonths,
      fiveYearROI: itemFiveYearROI,
      isHighROI: itemPaybackMonths <= 36 && itemFiveYearROI >= 100
    };
  }).sort((a, b) => a.paybackMonths - b.paybackMonths); // Sort by fastest payback
  
  // Calculate cash flow transformation
  const cashFlowBefore = rentalPortfolio?.cashFlowImpact?.before || 0;
  const cashFlowAfter = rentalPortfolio?.cashFlowImpact?.after || (cashFlowBefore + rentIncrease);
  const cashFlowImprovement = rentIncrease;
  const turnsCashFlowPositive = cashFlowBefore < 0 && cashFlowAfter >= 0;
  
  // Boost confidence based on analysis quality
  if (highlyRecommended.length >= 2) {
    confidence = Math.min(0.95, confidence + 0.15);
  } else if (highlyRecommended.length >= 1) {
    confidence = Math.min(0.90, confidence + 0.10);
  }
  
  // Extra boost if this turns cash flow positive
  if (turnsCashFlowPositive) {
    confidence = Math.min(0.95, confidence + 0.10);
  }
  
  const potentialProfit = fiveYearReturn - renovationCost; // Net profit over 5 years
  
  // Build specific signals from renovation plan items - prioritize high ROI items
  const renovationSignals = renovationBreakdown
    .filter(item => item.rentImpact > 25 && item.paybackMonths <= 48)
    .slice(0, 4)
    .map(item => `${item.item}: +$${item.rentImpact}/mo (${item.paybackMonths}mo payback)`);
  
  // Determine risk level based on payback and cash flow impact
  let risk: 'low' | 'medium' | 'high' = 'medium';
  if (paybackMonths <= 24 && fiveYearROI >= 150 && turnsCashFlowPositive) {
    risk = 'low';
  } else if (paybackMonths <= 36 && fiveYearROI >= 100) {
    risk = 'low';
  } else if (paybackMonths > 48 || fiveYearROI < 75) {
    risk = 'high';
  }
  
  return {
    type: WedgeType.VALUE_ADD_RENTAL,
    confidence,
    potentialProfit,
    timeframe: `${renovationPlan.timeline} months (renovate), ${paybackMonths} months payback`,
    capitalRequired: renovationCost,
    risk,
    strategy: turnsCashFlowPositive
      ? `🎯 CASH FLOW TURNAROUND: Invest $${renovationCost.toLocaleString()} to transform from -$${Math.abs(cashFlowBefore)}/mo to +$${cashFlowAfter}/mo cash flow. ${fiveYearROI.toFixed(0)}% 5-year ROI.`
      : `Invest $${renovationCost.toLocaleString()} to increase rent by $${rentIncrease}/mo (+${((rentIncrease / rentalImpact.currentRent) * 100).toFixed(1)}%). Payback in ${paybackMonths} months, then permanent +$${rentIncrease}/mo cash flow.`,
    barriers: [
      'Requires renovation capital upfront',
      'Property must be held long-term for full ROI',
      paybackMonths > 36 ? 'Extended payback period requires patience' : null,
      cashFlowBefore < 0 ? 'Current negative cash flow during renovation period' : null
    ].filter(Boolean) as string[],
    details: {
      renovationCost,
      rentIncrease,
      annualIncrease,
      paybackMonths,
      paybackYears,
      fiveYearROI,
      fiveYearReturn,
      timeline: renovationPlan.timeline,
      // NEW: Cash flow transformation data
      cashFlowAnalysis: {
        before: cashFlowBefore,
        after: cashFlowAfter,
        improvement: cashFlowImprovement,
        turnsCashFlowPositive
      },
      // NEW: Individual renovation ROI breakdown
      renovationBreakdown,
      // Counts by recommendation
      highROICount: renovationBreakdown.filter(r => r.isHighROI).length,
      totalRenovations: renovationBreakdown.length
    },
    signals: [
      `💰 $${rentIncrease}/mo rent increase`,
      `⏱️ ${paybackMonths} month payback`,
      `📈 ${fiveYearROI.toFixed(0)}% 5-year ROI`,
      turnsCashFlowPositive ? `🎯 Turns cash flow POSITIVE!` : null,
      `$${fiveYearReturn.toLocaleString()} 5-year rental income gain`,
      ...renovationSignals
    ].filter(Boolean) as string[]
  };
}

// ============================================================================
// WEDGE TYPE 5: OFF-MARKET
// ============================================================================

function detectOffMarket(
  property: AttomProperty,
  listPrice?: number
): WedgeOpportunity | null {
  
  // Only applies if property is not currently listed
  if (listPrice) return null;
  
  const signals: string[] = [];
  let offMarketScore = 0;
  
  // 1. Absentee owner
  if (property.owner?.absentee_status === 'Absentee Owner') {
    offMarketScore += 30;
    signals.push('Absentee owner - may not be monitoring property closely');
  }
  
  // 2. Corporate owner
  if (property.owner?.is_corporate) {
    offMarketScore += 20;
    signals.push('Corporate owner - may respond to cash offer');
  }
  
  // 3. High equity (likely free and clear)
  if (!property.mortgage || !property.mortgage.amount) {
    offMarketScore += 25;
    signals.push('Likely owned free and clear - flexible seller');
  }
  
  // 4. Long ownership
  const ownershipYears = estimateOwnershipDuration(property);
  if (ownershipYears > 10) {
    offMarketScore += 15;
    signals.push(`${ownershipYears}+ years ownership - significant equity`);
  }
  
  // Need at least 40 score for wedge
  if (offMarketScore < 40) return null;
  
  const confidence = 0.50; // Lower confidence - requires direct marketing
  const estimatedDiscount = 10; // 10% discount for off-market
  const potentialProfit = property.avm_value * (estimatedDiscount / 100) * 0.85;
  
  return {
    type: WedgeType.OFF_MARKET,
    confidence,
    potentialProfit,
    timeframe: '3-12 months (direct marketing)',
    capitalRequired: property.avm_value * 0.90 * 0.20,
    risk: 'medium',
    strategy: `Contact owner directly with cash offer at ${100 - estimatedDiscount}% of market value. Property not currently listed - opportunity for off-market deal.`,
    barriers: [
      'Requires direct marketing effort',
      'Seller may not be motivated',
      'Lower success rate'
    ],
    details: {
      offMarketScore,
      estimatedDiscount,
      ownerInfo: property.owner
    },
    signals
  };
}

// ============================================================================
// WEDGE TYPE 6: ASSUMABLE LOAN
// ============================================================================

function detectAssumableLoan(property: AttomProperty): WedgeOpportunity | null {
  
  if (!property.mortgage?.assumability) return null;
  
  const assumability = property.mortgage.assumability;
  
  if (assumability.assumable !== 'Yes') return null;
  
  const loanType = property.mortgage.loan_type;
  
  // For rental properties: Only VA loans are truly assumable
  // FHA requires owner-occupancy for 1 year (house-hacking only)
  const isVALoan = loanType === 'VA';
  const isFHALoan = loanType === 'FHA';
  
  // Skip FHA for pure rental investment (covered by house-hack wedge)
  if (isFHALoan) return null;
  
  // Only proceed with VA loans for rental properties
  if (!isVALoan) return null;
  
  // Calculate monthly savings vs conventional
  const assumedRate = property.mortgage.estimated_interest_rate;
  const currentRate = 7.0; // Current market
  const rateDifference = currentRate - assumedRate;
  
  // Need at least 1% rate advantage
  if (rateDifference < 1.0) return null;
  
  const loanBalance = property.mortgage.amount;
  const monthlySavings = calculateMonthlySavings(loanBalance, rateDifference);
  const annualSavings = monthlySavings * 12;
  const tenYearSavings = annualSavings * 10;
  
  let confidence = 0.75;
  if (assumability.confidence === 'High') confidence = 0.85;
  else if (assumability.confidence === 'Medium') confidence = 0.70;
  
  return {
    type: WedgeType.ASSUMABLE_LOAN,
    confidence,
    potentialProfit: tenYearSavings * 0.6, // Present value discount
    timeframe: '10 years (interest savings)',
    capitalRequired: property.avm_value * 0.20 + (property.avm_value - loanBalance) * 0.20, // Down + gap
    risk: 'low',
    strategy: `Assume existing VA loan at ${assumedRate.toFixed(2)}% vs ${currentRate.toFixed(2)}% market rate for rental property. Save $${monthlySavings.toFixed(0)}/mo ($${tenYearSavings.toFixed(0)} over 10 years). VA loans are assumable without owner-occupancy requirement.`,
    barriers: assumability.nextSteps || [
      'Must qualify with lender',
      'Assumption fee required',
      'May need gap financing'
    ],
    details: {
      loanType: property.mortgage.loan_type,
      loanBalance,
      assumedRate,
      currentRate,
      rateDifference,
      monthlySavings,
      attractiveness: assumability.attractiveness
    },
    signals: [
      `${rateDifference.toFixed(2)}% below market rate`,
      `$${monthlySavings.toFixed(0)}/mo savings`,
      'VA loan - assumable for rental properties',
      assumability.attractiveness
    ]
  };
}

function calculateMonthlySavings(loanBalance: number, rateDifference: number): number {
  // Simplified monthly savings calculation
  const monthlyRateDiff = rateDifference / 100 / 12;
  return loanBalance * monthlyRateDiff;
}

// ============================================================================
// WEDGE TYPE 7: HOUSE-HACK (FHA/VA with Owner-Occupancy)
// ============================================================================

function detectHouseHack(
  property: AttomProperty,
  _renovationAnalysis?: RenovationAnalysis
): WedgeOpportunity | null {
  
  // House-hacking: Live in property while renting out rooms/units
  // Best with FHA 3.5% down or VA 0% down, or assumable FHA/VA loans
  
  const hasFHAAssumable = property.mortgage?.assumability?.assumable === 'Yes' && 
                          property.mortgage?.loan_type === 'FHA';
  const hasVAAssumable = property.mortgage?.assumability?.assumable === 'Yes' && 
                         property.mortgage?.loan_type === 'VA';
  
  // Property needs to be suitable for house-hacking (2+ bedrooms, or multi-unit)
  const beds = property.beds || 0;
  const propertyType = (property.property_type || '').toLowerCase();
  const isMultiUnit = propertyType.includes('duplex') ||
                      propertyType.includes('triplex') ||
                      propertyType.includes('fourplex');
  
  if (!isMultiUnit && beds < 2) return null;
  
  // Calculate potential rental income (rent out all but one bedroom/unit)
  const estimatedRent = property.rental_avm || 0;
  if (estimatedRent === 0) return null;
  
  // For multi-unit: rent all units except one
  // For single-family: estimate $500-800 per bedroom rented
  let rentalIncome = 0;
  if (isMultiUnit) {
    // Assume 2-4 units, live in one
    rentalIncome = estimatedRent * 0.70; // Conservative 70% of full rental value
  } else {
    // Rent out bedrooms
    const rentableRooms = Math.max(1, beds - 1);
    rentalIncome = rentableRooms * 650; // $650/room average
  }
  
  // Calculate housing costs
  const purchasePrice = property.avm_value;
  
  // FHA 3.5% down scenario
  const fhaDownPayment = purchasePrice * 0.035;
  const fhaLoan = purchasePrice * 0.965;
  const fhaRate = 6.5;
  const fhaPayment = calculateLoanPayment(fhaLoan, fhaRate, 360);
  
  // Operating expenses (taxes, insurance, maintenance)
  const monthlyTax = (property.tax_history?.[0]?.tax_amount || purchasePrice * 0.012) / 12;
  const monthlyInsurance = (purchasePrice * 0.004) / 12;
  const monthlyMaintenance = estimatedRent * 0.08; // 8% for owner-occupied
  
  const totalExpenses = fhaPayment + monthlyTax + monthlyInsurance + monthlyMaintenance;
  const netHousingCost = totalExpenses - rentalIncome;
  
  // Assumable loan advantage
  let assumableSavings = 0;
  if (hasFHAAssumable || hasVAAssumable) {
    const assumedRate = property.mortgage?.estimated_interest_rate || 4.0;
    const assumedBalance = property.mortgage?.amount || 0;
    const assumedPayment = calculateLoanPayment(assumedBalance, assumedRate, 300);
    
    // Gap financing
    const gap = purchasePrice - (purchasePrice * 0.20) - assumedBalance;
    const gapPayment = gap > 0 ? calculateLoanPayment(gap, 7.0, 360) : 0;
    
    const totalAssumablePayment = assumedPayment + gapPayment + monthlyTax + monthlyInsurance + monthlyMaintenance;
    assumableSavings = totalExpenses - totalAssumablePayment;
  }
  
  // Only a wedge if significantly reduces housing costs
  const _housingCostReduction = estimatedRent - netHousingCost;
  if (netHousingCost > estimatedRent * 0.5) return null; // Must reduce costs by at least 50%
  
  // Calculate 5-year savings vs renting
  const monthlyRentSavings = estimatedRent - netHousingCost;
  const annualSavings = monthlyRentSavings * 12;
  const fiveYearSavings = annualSavings * 5;
  
  // Add equity buildup
  const principalPaydown = fhaLoan * 0.10; // Roughly 10% over 5 years
  const appreciation = purchasePrice * 0.04 * 5; // 4% annual appreciation
  const totalWealth = fiveYearSavings + principalPaydown + appreciation;
  
  let confidence = 0.70;
  if (isMultiUnit) confidence = 0.85; // Multi-unit is ideal for house-hacking
  if (hasFHAAssumable || hasVAAssumable) confidence += 0.10; // Boost for assumable
  confidence = Math.min(0.95, confidence);
  
  const strategy = hasFHAAssumable || hasVAAssumable
    ? `House-hack with assumable ${property.mortgage?.loan_type} loan at ${property.mortgage?.estimated_interest_rate?.toFixed(2)}%. Live in one ${isMultiUnit ? 'unit' : 'bedroom'}, rent others for $${rentalIncome.toFixed(0)}/mo. Net housing cost: $${netHousingCost.toFixed(0)}/mo (${(netHousingCost / estimatedRent * 100).toFixed(0)}% of market rent).`
    : `House-hack with FHA 3.5% down ($${fhaDownPayment.toFixed(0)}). Live in one ${isMultiUnit ? 'unit' : 'bedroom'}, rent ${isMultiUnit ? 'other units' : `${Math.max(1, beds - 1)} bedrooms`} for $${rentalIncome.toFixed(0)}/mo. Net housing cost: $${netHousingCost.toFixed(0)}/mo vs $${estimatedRent.toFixed(0)}/mo market rent.`;
  
  return {
    type: WedgeType.HOUSE_HACK,
    confidence,
    potentialProfit: totalWealth,
    timeframe: '5 years (live-in + equity buildup)',
    capitalRequired: hasFHAAssumable || hasVAAssumable ? purchasePrice * 0.20 : fhaDownPayment,
    risk: isMultiUnit ? 'low' : 'medium',
    strategy,
    barriers: [
      'Must live on-site for 1 year minimum',
      'Need to manage tenant roommates/units',
      'Requires FHA/VA loan approval'
    ],
    details: {
      isMultiUnit,
      beds,
      rentalIncome,
      netHousingCost,
      monthlyRentSavings,
      fiveYearSavings,
      totalWealth,
      hasAssumable: hasFHAAssumable || hasVAAssumable,
      assumableSavings
    },
    signals: [
      `$${monthlyRentSavings.toFixed(0)}/mo rent savings`,
      `${(netHousingCost / estimatedRent * 100).toFixed(0)}% housing cost vs market`,
      `$${totalWealth.toFixed(0)} wealth creation in 5 years`,
      isMultiUnit ? 'Multi-unit property - ideal for house-hacking' : `${beds} bedrooms available`,
      ...(hasFHAAssumable || hasVAAssumable ? [`Assumable ${property.mortgage?.loan_type} loan at ${property.mortgage?.estimated_interest_rate?.toFixed(2)}%`] : ['FHA 3.5% down eligible'])
    ]
  };
}

function calculateLoanPayment(principal: number, annualRate: number, months: number): number {
  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate === 0) return principal / months;
  
  return principal * (
    monthlyRate * Math.pow(1 + monthlyRate, months)
  ) / (
    Math.pow(1 + monthlyRate, months) - 1
  );
}

// ============================================================================
// WEDGE TYPE 8: TAX APPEAL
// ============================================================================

function detectTaxAppeal(
  property: AttomProperty,
  valuation: ValuationAnalysis
): WedgeOpportunity | null {
  
  if (!property.tax_history || property.tax_history.length === 0) return null;
  
  const currentTax = property.tax_history[0].tax_amount;
  const assessedValue = currentTax / 0.012; // Assume 1.2% rate
  const marketValue = valuation.indicatedValue;
  
  const overAssessment = assessedValue - marketValue;
  const overAssessmentPercent = (overAssessment / marketValue) * 100;
  
  // Need at least 10% over-assessment for appeal
  if (overAssessmentPercent < 10) return null;
  
  const potentialTaxSavings = overAssessment * 0.012; // Annual savings
  const tenYearSavings = potentialTaxSavings * 10;
  
  return {
    type: WedgeType.TAX_APPEAL,
    confidence: 0.70,
    potentialProfit: tenYearSavings * 0.6, // Present value
    timeframe: '6-12 months (appeal process)',
    capitalRequired: 2000, // Appeal filing costs
    risk: 'low',
    strategy: `Property assessed at $${assessedValue.toFixed(0)}, ${overAssessmentPercent.toFixed(0)}% above market value of $${marketValue.toFixed(0)}. File tax appeal to save $${potentialTaxSavings.toFixed(0)}/year.`,
    barriers: ['Requires evidence of value', 'Appeal process takes time'],
    details: {
      assessedValue,
      marketValue,
      overAssessment,
      overAssessmentPercent,
      currentTax,
      potentialNewTax: (marketValue * 0.012) / 12,
      monthlySavings: potentialTaxSavings / 12
    },
    signals: [
      `${overAssessmentPercent.toFixed(0)}% over-assessed`,
      `$${potentialTaxSavings.toFixed(0)}/year savings`,
      `$${(potentialTaxSavings / 12).toFixed(0)}/mo savings`
    ]
  };
}

// ============================================================================
// WEDGE TYPE 8: BRRRR
// ============================================================================

function detectBRRRR(brrrr?: BRRRRAnalysis): WedgeOpportunity | null {
  
  if (!brrrr || !brrrr.viable) return null;
  
  const profit = brrrr.forcedAppreciation + (brrrr.postRefinanceCashFlow * 12 * 10); // 10-year cash flow
  
  let confidence = 0.75;
  if (brrrr.infiniteReturn && brrrr.postRefinanceCashFlow > 500) confidence = 0.90;
  else if (brrrr.capitalRecoveryPercent > 90) confidence = 0.85;
  else if (brrrr.capitalRecoveryPercent > 75) confidence = 0.75;
  
  return {
    type: WedgeType.BRRRR,
    confidence,
    potentialProfit: profit,
    timeframe: `${brrrr.renovationCost > 30000 ? '4-6' : '2-3'} months (renovate + refinance)`,
    capitalRequired: brrrr.cashLeftInDeal > 0 ? brrrr.cashLeftInDeal : 0,
    risk: brrrr.infiniteReturn ? 'low' : 'medium',
    strategy: brrrr.recommendation,
    barriers: [
      'Requires renovation expertise',
      'Must qualify for refinance',
      'Market timing risk'
    ],
    details: brrrr,
    signals: [
      brrrr.infiniteReturn ? 'Infinite return potential' : `${brrrr.capitalRecoveryPercent.toFixed(0)}% capital recovery`,
      `$${brrrr.postRefinanceCashFlow.toFixed(0)}/mo post-refi cash flow`,
      `$${brrrr.forcedAppreciation.toFixed(0)} forced appreciation`
    ]
  };
}

// ============================================================================
// WEDGE TYPE 9: FLIP
// ============================================================================

function detectFlip(
  renovationAnalysis?: RenovationAnalysis,
  property?: AttomProperty
): WedgeOpportunity | null {
  
  if (!renovationAnalysis || !property) return null;
  
  const { valuationImpact, renovationPlan } = renovationAnalysis;
  
  // Already covered by value-add wedge, but check for pure flip opportunity
  const renovationCost = renovationPlan.totalCost;
  const forcedAppreciation = valuationImpact.forcedAppreciation;
  const arv = valuationImpact.afterRepairValue;
  
  // Transaction costs: buy (3%) + sell (8%) + holding (2%) = 13%
  const transactionCosts = arv * 0.13;
  const grossProfit = forcedAppreciation - renovationCost;
  const netProfit = grossProfit - transactionCosts;
  
  // Need at least $30k net profit for flip
  if (netProfit < 30000) return null;
  
  const roi = netProfit / (valuationImpact.purchasePrice * 0.20 + renovationCost);
  
  // Need at least 40% ROI
  if (roi < 0.40) return null;
  
  const timeline = renovationPlan.timeline + 2; // + 2 months to sell
  
  return {
    type: WedgeType.FLIP,
    confidence: renovationAnalysis.confidence,
    potentialProfit: netProfit,
    timeframe: `${timeline} months`,
    capitalRequired: valuationImpact.purchasePrice * 0.20 + renovationCost,
    risk: timeline < 4 ? 'low' : 'medium',
    strategy: `Buy at $${valuationImpact.purchasePrice.toFixed(0)}, invest $${renovationCost.toFixed(0)} in renovations, sell at $${arv.toFixed(0)} for $${netProfit.toFixed(0)} profit (${(roi * 100).toFixed(0)}% ROI).`,
    barriers: [
      'Requires cash or hard money',
      'Market timing risk',
      'Renovation expertise needed'
    ],
    details: {
      purchasePrice: valuationImpact.purchasePrice,
      renovationCost,
      arv,
      grossProfit,
      transactionCosts,
      netProfit,
      roi,
      timeline
    },
    signals: [
      `${(roi * 100).toFixed(0)}% ROI`,
      `$${netProfit.toFixed(0)} net profit`,
      `${timeline}-month timeline`
    ]
  };
}
