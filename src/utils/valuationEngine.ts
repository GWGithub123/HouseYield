/**
 * Comprehensive Property Valuation Engine
 * 2-Method Valuation with Visual AI Condition Integration:
 * - ATTOM AVM (35% weight) - Primary market-based valuation
 * - Sales Comparison (65% weight) - Regional comparable sales with Visual AI condition adjustments
 * 
 * Also factors in:
 * - Regional market heat (hot markets get premium)
 * - Environmental factors (flood, fire, noise)
 * - School quality
 * - Visual AI condition scoring applied directly to sales comparison
 */

import {
  AttomProperty,
  SalesComparable,
  ValuationAnalysis,
  MethodResult,
  ComparableAnalysis,
  ConditionAdjustment,
  DetailedConditionScore,
  RegionalMarketAnalysis
} from '../types/propertyAnalysis';
import { getConditionMultiplier } from './conditionScoring';

// ============================================================================
// REGIONAL MARKET & ENVIRONMENTAL ADJUSTMENT FUNCTIONS
// ============================================================================

/**
 * Calculate market heat multiplier based on regional market conditions
 * Hot markets command premium, cold markets have discount
 */
function calculateMarketHeatMultiplier(regionalMarket?: RegionalMarketAnalysis): number {
  if (!regionalMarket) return 1.0;
  
  const heatScore = regionalMarket.marketHeatScore;
  const marketHeat = regionalMarket.marketHeat;
  
  // Market heat multipliers:
  // Very Hot (85-100): +8% to +15%
  // Hot (70-84): +4% to +8%
  // Warm (55-69): +1% to +4%
  // Neutral (45-54): no adjustment
  // Cool (35-44): -1% to -4%
  // Cold (20-34): -4% to -8%
  // Very Cold (0-19): -8% to -12%
  
  switch (marketHeat) {
    case 'Very Hot':
      return 1.08 + (heatScore - 85) * 0.0047; // 1.08 to 1.15
    case 'Hot':
      return 1.04 + (heatScore - 70) * 0.0029; // 1.04 to 1.08
    case 'Warm':
      return 1.01 + (heatScore - 55) * 0.0021; // 1.01 to 1.04
    case 'Neutral':
      return 1.0;
    case 'Cool':
      return 0.96 + (heatScore - 35) * 0.003; // 0.96 to 0.99
    case 'Cold':
      return 0.92 + (heatScore - 20) * 0.0029; // 0.92 to 0.96
    case 'Very Cold':
      return 0.88 + (heatScore) * 0.002; // 0.88 to 0.92
    default:
      return 1.0;
  }
}

/**
 * Calculate environmental and location quality adjustment
 * Factors in: flood risk, fire risk, noise, and school quality
 */
function calculateEnvironmentalAdjustment(property: AttomProperty): {
  multiplier: number;
  schoolBonus: number;
  floodPenalty: number;
  firePenalty: number;
  noisePenalty: number;
  breakdown: string;
} {
  let multiplier = 1.0;
  let schoolBonus = 0;
  let floodPenalty = 0;
  let firePenalty = 0;
  let noisePenalty = 0;
  const factors: string[] = [];
  
  // Flood risk adjustment (ATTOM provides 1-10 scale, 10 = highest risk)
  if (property.hazard_scores?.flood) {
    const floodRisk = property.hazard_scores.flood;
    if (floodRisk >= 8) {
      floodPenalty = 0.08; // -8% for severe flood risk
      factors.push('Severe flood risk (-8%)');
    } else if (floodRisk >= 6) {
      floodPenalty = 0.05; // -5% for high flood risk
      factors.push('High flood risk (-5%)');
    } else if (floodRisk >= 4) {
      floodPenalty = 0.02; // -2% for moderate flood risk
      factors.push('Moderate flood risk (-2%)');
    }
    multiplier -= floodPenalty;
  }
  
  // Fire risk adjustment (ATTOM provides 1-10 scale)
  if (property.hazard_scores?.fire) {
    const fireRisk = property.hazard_scores.fire;
    if (fireRisk >= 8) {
      firePenalty = 0.06; // -6% for severe fire risk
      factors.push('Severe fire risk (-6%)');
    } else if (fireRisk >= 6) {
      firePenalty = 0.03; // -3% for high fire risk
      factors.push('High fire risk (-3%)');
    } else if (fireRisk >= 4) {
      firePenalty = 0.01; // -1% for moderate fire risk
      factors.push('Moderate fire risk (-1%)');
    }
    multiplier -= firePenalty;
  }
  
  // Noise impact (if available from noise analysis)
  // Typically measured in dB, >70dB is high traffic noise
  if ((property as any).noiseLevel) {
    const noiseLevel = (property as any).noiseLevel;
    if (noiseLevel >= 75) {
      noisePenalty = 0.05; // -5% for very high noise
      factors.push('High noise area (-5%)');
    } else if (noiseLevel >= 70) {
      noisePenalty = 0.02; // -2% for elevated noise
      factors.push('Elevated noise (-2%)');
    }
    multiplier -= noisePenalty;
  }
  
  // School quality bonus (great schools add value)
  // Assume schools array with rating 1-10
  if (property.schools && property.schools.length > 0) {
    const avgSchoolRating = property.schools.reduce((sum, s) => sum + (s.rating || 5), 0) / property.schools.length;
    if (avgSchoolRating >= 9) {
      schoolBonus = 0.06; // +6% for excellent schools
      factors.push('Excellent schools (+6%)');
    } else if (avgSchoolRating >= 8) {
      schoolBonus = 0.04; // +4% for very good schools
      factors.push('Very good schools (+4%)');
    } else if (avgSchoolRating >= 7) {
      schoolBonus = 0.02; // +2% for good schools
      factors.push('Good schools (+2%)');
    } else if (avgSchoolRating < 5) {
      schoolBonus = -0.02; // -2% for poor schools
      factors.push('Below average schools (-2%)');
    }
    multiplier += schoolBonus;
  }
  
  // Cap the total adjustment to reasonable bounds
  multiplier = Math.max(0.80, Math.min(1.10, multiplier));
  
  return {
    multiplier,
    schoolBonus,
    floodPenalty,
    firePenalty,
    noisePenalty,
    breakdown: factors.length > 0 ? factors.join(', ') : 'No significant environmental factors'
  };
}

// ============================================================================
// MAIN VALUATION FUNCTION
// ============================================================================

export function analyzePropertyValuation(
  property: AttomProperty,
  conditionScore: DetailedConditionScore,
  listPrice?: number,
  salesComps?: SalesComparable[],
  regionalMarket?: RegionalMarketAnalysis
): ValuationAnalysis {
  
  console.log('[Valuation] Starting enhanced valuation analysis...');
  console.log('[Valuation] Property:', {
    address: property.address,
    avm: property.avm_value,
    sqft: property.living_sqft,
    age: property.age,
    rental_avm: property.rental_avm,
    listPrice,
    marketHeat: regionalMarket?.marketHeat || 'unknown'
  });
  
  // Method 1: ATTOM AVM (35% weight) - Primary market-based valuation
  const attomAVM = calculateAttomAVMMethod(property);
  console.log('[Valuation] Method 1 - ATTOM AVM:', {
    value: Math.round(attomAVM.value),
    weight: attomAVM.weight,
    confidence: (attomAVM.confidence * 100).toFixed(0) + '%'
  });
  
  // Method 2: Sales Comparison (65% weight) - Regional comparable sales with Visual AI condition adjustments
  const salesComparison = analyzeSalesComparables(property, conditionScore, salesComps);
  console.log('[Valuation] Method 2 - Sales Comparison (with Visual AI):', {
    value: Math.round(salesComparison.value),
    weight: salesComparison.weight,
    confidence: (salesComparison.confidence * 100).toFixed(0) + '%',
    hasComps: salesComps && salesComps.length > 0,
    compCount: salesComps?.length || 0,
    conditionScore: conditionScore.overallScore,
    conditionGrade: conditionScore.overallGrade
  });
  
  // Calculate total weight (in case some methods have zero weight due to missing data)
  const totalWeight = attomAVM.weight + salesComparison.weight;
  
  console.log('[Valuation] Weighted calculation:', {
    totalWeight,
    attomAVM_contribution: Math.round(attomAVM.value * attomAVM.weight),
    salesComp_contribution: Math.round(salesComparison.value * salesComparison.weight)
  });
  
  // If no valid data at all, use list price or fallback
  if (totalWeight === 0) {
    const fallbackValue = listPrice || property.avm_value || 0;
    return {
      listPrice: listPrice || 0,
      indicatedValue: fallbackValue,
      methods: { attomAVM, salesComparison, weightedAverage: fallbackValue },
      comparableAnalysis: salesComparison.details,
      visualAIAdjustment: {
        baseValue: fallbackValue,
        conditionMultiplier: 1,
        adjustedValue: fallbackValue,
        deferredMaintenance: 0,
        finalAdjustedValue: fallbackValue,
        roomByRoomImpact: { kitchen: { score: 0, impact: 0 }, bathrooms: { score: 0, impact: 0 }, overall: { score: 0, impact: 0 } }
      },
      valuationGap: 0,
      valuationGapPercent: 0,
      status: 'fair_valued',
      confidence: 'low',
      recommendation: 'Insufficient data for accurate valuation'
    };
  }
  
  // Calculate weighted average (normalize by total weight)
  const weightedAverage = (
    attomAVM.value * attomAVM.weight +
    salesComparison.value * salesComparison.weight
  ) / totalWeight;
  
  // Apply regional market heat adjustment
  // Hot markets command premium, cold markets have discount
  const marketMultiplier = calculateMarketHeatMultiplier(regionalMarket);
  const marketAdjustedValue = weightedAverage * marketMultiplier;
  
  console.log('[Valuation] Market heat adjustment:', {
    marketHeat: regionalMarket?.marketHeat || 'unknown',
    marketScore: regionalMarket?.marketHeatScore || 50,
    multiplier: marketMultiplier.toFixed(3),
    beforeMarket: Math.round(weightedAverage),
    afterMarket: Math.round(marketAdjustedValue)
  });
  
  // Apply environmental and location quality factors
  const environmentalAdjustment = calculateEnvironmentalAdjustment(property);
  const environmentAdjustedValue = marketAdjustedValue * environmentalAdjustment.multiplier;
  
  console.log('[Valuation] Environmental adjustment:', {
    floodRisk: property.hazard_scores?.flood,
    fireRisk: property.hazard_scores?.fire,
    schoolBonus: environmentalAdjustment.schoolBonus,
    multiplier: environmentalAdjustment.multiplier.toFixed(3),
    afterEnvironment: Math.round(environmentAdjustedValue)
  });
  
  // Apply condition adjustment (more moderate - condition should fine-tune, not dominate)
  const visualAIAdjustment = applyDetailedConditionAdjustment(
    environmentAdjustedValue,
    conditionScore,
    property
  );
  
  const indicatedValue = visualAIAdjustment.finalAdjustedValue;
  
  // Determine valuation status
  let status: 'undervalued' | 'fair_valued' | 'overvalued' = 'fair_valued';
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  
  if (listPrice) {
    const valuationGapPercent = ((listPrice - indicatedValue) / indicatedValue) * 100;
    
    if (valuationGapPercent > 10) status = 'overvalued';
    else if (valuationGapPercent < -10) status = 'undervalued';
    else status = 'fair_valued';
    
    // Confidence based on data quality
    const hasComps = salesComps && salesComps.length >= 3;
    const hasConditionData = conditionScore.overallScore > 0;
    const hasAVM = property.avm_value > 0;
    
    if (hasComps && hasConditionData && hasAVM) confidence = 'high';
    else if (hasComps || hasConditionData) confidence = 'medium';
    else confidence = 'low';
  }
  
  const valuationGap = listPrice ? listPrice - indicatedValue : 0;
  const valuationGapPercent = listPrice ? (valuationGap / indicatedValue) * 100 : 0;
  
  const recommendation = generateValuationRecommendation(
    status,
    valuationGapPercent,
    confidence,
    conditionScore
  );
  
  return {
    listPrice: listPrice || 0,
    indicatedValue,
    methods: {
      attomAVM,
      salesComparison,
      weightedAverage,
      marketAdjustedAverage: marketAdjustedValue,
      environmentAdjustedAverage: environmentAdjustedValue
    },
    comparableAnalysis: salesComparison.details,
    visualAIAdjustment,
    regionalMarketAdjustment: {
      marketHeat: regionalMarket?.marketHeat || 'Neutral',
      heatScore: regionalMarket?.marketHeatScore || 50,
      multiplier: marketMultiplier,
      valueImpact: marketAdjustedValue - weightedAverage
    },
    environmentalAdjustment: {
      multiplier: environmentalAdjustment.multiplier,
      schoolBonus: environmentalAdjustment.schoolBonus,
      floodPenalty: environmentalAdjustment.floodPenalty,
      firePenalty: environmentalAdjustment.firePenalty,
      breakdown: environmentalAdjustment.breakdown,
      valueImpact: environmentAdjustedValue - marketAdjustedValue
    },
    status,
    valuationGap,
    valuationGapPercent,
    confidence,
    recommendation
  };
}

// ============================================================================
// METHOD 1: ATTOM AVM (35% WEIGHT) - Primary market-based valuation
// ============================================================================

function calculateAttomAVMMethod(property: AttomProperty): MethodResult {
  const value = property.avm_value || 0;
  const weight = 0.35; // 35% weight for ATTOM AVM
  
  // Return zero-value result if no AVM data
  if (!value || value === 0) {
    return {
      value: 0,
      weight: 0, // Don't weight this method if no data
      confidence: 0,
      details: { source: 'ATTOM AVM', error: 'No AVM data available' }
    };
  }
  
  // Confidence based on AVM range
  const avmHigh = property.avm_high || value * 1.1;
  const avmLow = property.avm_low || value * 0.9;
  const avmRange = avmHigh - avmLow;
  const rangePercent = (avmRange / value) * 100;
  
  let confidence = 0.85;
  if (rangePercent < 10) confidence = 0.95;
  else if (rangePercent < 20) confidence = 0.85;
  else if (rangePercent < 30) confidence = 0.75;
  else confidence = 0.65;
  
  return {
    value,
    weight,
    confidence,
    details: {
      avm_low: property.avm_low,
      avm_high: property.avm_high,
      range_percent: rangePercent
    }
  };
}

// ============================================================================
// METHOD 2: SALES COMPARISON (65% WEIGHT) - Regional comparable sales with Visual AI
// ============================================================================

function analyzeSalesComparables(
  property: AttomProperty,
  conditionScore: DetailedConditionScore,
  salesComps?: SalesComparable[]
): MethodResult {
  const weight = 0.65; // 65% weight - primary valuation method with Visual AI condition adjustments
  
  console.log('[Sales Comparison] Input:', {
    hasComps: !!salesComps,
    compCount: salesComps?.length || 0,
    firstComp: salesComps?.[0] ? {
      address: salesComps[0].address,
      price: salesComps[0].sale_price,
      sqft: salesComps[0].living_sqft
    } : null
  });
  
  if (!salesComps || salesComps.length === 0) {
    // Fallback to ATTOM AVM if no comps
    console.log('[Sales Comparison] No comps provided, falling back to AVM:', property.avm_value);
    return {
      value: property.avm_value,
      weight,
      confidence: 0.60,
      details: {
        salesComps: [],
        adjustedValues: [],
        weightedAverage: property.avm_value,
        pricePerSqftRange: { low: 0, median: 0, high: 0 },
        confidence: 'low' as const
      }
    };
  }
  
  // Analyze and adjust each comparable
  const adjustedComps = salesComps.map(comp => 
    adjustComparable(comp, property, conditionScore)
  );
  
  console.log('[Sales Comparison] Adjusted comps:', adjustedComps.map(c => ({
    address: c.address,
    originalPrice: c.sale_price,
    adjustedPrice: c.adjustedPrice,
    weight: c.weight
  })));
  
  // Calculate weighted average based on similarity and recency
  const totalWeight = adjustedComps.reduce((sum, comp) => sum + (comp.weight || 0), 0);
  const baseWeightedAverage = adjustedComps.reduce(
    (sum, comp) => sum + (comp.adjustedPrice || 0) * (comp.weight || 0),
    0
  ) / totalWeight;
  
  // ============================================================================
  // APPLY VISUAL AI CONDITION ADJUSTMENTS DIRECTLY TO SALES COMPARISON
  // This uses the FULL condition analysis including:
  // - Exterior: Roof, Siding, Windows, Doors, Foundation, Driveway, Landscaping
  // - Interior: Kitchen, Bathrooms, Living Room, Bedrooms, Flooring, Paint, Lighting
  // - Systems: HVAC, Electrical, Plumbing, Water Heater
  // ============================================================================
  
  // Get condition multiplier from Visual AI scoring (based on overall grade which incorporates ALL components)
  const conditionMultiplier = getConditionMultiplier(conditionScore.overallGrade);
  
  // Calculate deferred maintenance impact (buyers discount 20%)
  const deferredMaintenanceImpact = conditionScore.totalDeferredCost * 0.80;
  
  // Apply Visual AI condition adjustment to weighted average
  const conditionAdjustedValue = baseWeightedAverage * conditionMultiplier;
  const weightedAverage = conditionAdjustedValue - deferredMaintenanceImpact;
  
  // Capture all component scores for detailed breakdown
  const exteriorScore = conditionScore.exterior?.overallScore || 0;
  const interiorScore = conditionScore.interior?.overallScore || 0;
  const systemsScore = conditionScore.systems?.overallScore || 0;
  
  // Individual component impacts (for detailed reporting)
  const componentScores = {
    // Exterior components
    roof: conditionScore.exterior?.roof?.score || 0,
    siding: conditionScore.exterior?.siding?.score || 0,
    windows: conditionScore.exterior?.windows?.score || 0,
    foundation: conditionScore.exterior?.foundation?.score || 0,
    // Interior components
    kitchen: conditionScore.interior?.kitchen?.score || 0,
    bathrooms: conditionScore.interior?.bathrooms?.avgScore || 0,
    livingRoom: conditionScore.interior?.livingRoom?.score || 0,
    bedrooms: conditionScore.interior?.bedrooms?.avgScore || 0,
    flooring: conditionScore.interior?.flooring?.score || 0,
    // Systems
    hvac: conditionScore.systems?.hvac?.score || 0,
    electrical: conditionScore.systems?.electrical?.score || 0,
    plumbing: conditionScore.systems?.plumbing?.score || 0
  };
  
  console.log('[Sales Comparison] Visual AI Condition Adjustment:', {
    conditionGrade: conditionScore.overallGrade,
    overallScore: conditionScore.overallScore,
    conditionMultiplier: conditionMultiplier.toFixed(3),
    baseWeightedAverage: Math.round(baseWeightedAverage),
    conditionAdjustedValue: Math.round(conditionAdjustedValue),
    deferredMaintenanceImpact: Math.round(deferredMaintenanceImpact),
    finalWeightedAverage: Math.round(weightedAverage),
    // Category scores
    exteriorScore: Math.round(exteriorScore),
    interiorScore: Math.round(interiorScore),
    systemsScore: Math.round(systemsScore),
    // Key component scores
    components: componentScores
  });
  
  console.log('[Sales Comparison] Result:', {
    totalWeight,
    weightedAverage: Math.round(weightedAverage),
    compCount: adjustedComps.length
  });
  
  // Calculate price per sqft range
  const pricePerSqfts = adjustedComps.map(comp => 
    (comp.adjustedPrice || comp.sale_price) / comp.living_sqft
  ).sort((a, b) => a - b);
  
  const pricePerSqftRange = {
    low: pricePerSqfts[0],
    median: pricePerSqfts[Math.floor(pricePerSqfts.length / 2)],
    high: pricePerSqfts[pricePerSqfts.length - 1]
  };
  
  // Confidence based on comp quality AND condition data quality
  const avgSimilarity = adjustedComps.reduce((sum, comp) => sum + (comp.similarity || 0), 0) / adjustedComps.length;
  const avgRecency = adjustedComps.reduce((sum, comp) => sum + (comp.recency || 0), 0) / adjustedComps.length;
  const hasConditionData = conditionScore.overallScore > 0;
  
  // Boost confidence if we have Visual AI condition data
  let confidence = (avgSimilarity * 0.5 + avgRecency * 0.3 + (hasConditionData ? 0.2 : 0));
  let confidenceLevel: 'high' | 'medium' | 'low' = 'medium';
  
  if (confidence >= 0.85 && adjustedComps.length >= 5 && hasConditionData) confidenceLevel = 'high';
  else if (confidence >= 0.70 || hasConditionData) confidenceLevel = 'medium';
  else confidenceLevel = 'low';
  
  const comparableAnalysis: ComparableAnalysis = {
    salesComps: adjustedComps,
    adjustedValues: adjustedComps.map(c => c.adjustedPrice || c.sale_price),
    weightedAverage,
    pricePerSqftRange,
    confidence: confidenceLevel
  };
  
  return {
    value: weightedAverage,
    weight,
    confidence,
    details: {
      ...comparableAnalysis,
      visualAIConditionApplied: true,
      conditionGrade: conditionScore.overallGrade,
      conditionMultiplier,
      baseWeightedAverage,
      conditionAdjustedValue,
      deferredMaintenanceImpact,
      // Category scores (0-100)
      categoryScores: {
        exterior: exteriorScore,
        interior: interiorScore,
        systems: systemsScore
      },
      // All component scores for detailed breakdown
      componentScores
    }
  };
}

function adjustComparable(
  comp: SalesComparable,
  subject: AttomProperty,
  conditionScore: DetailedConditionScore
): SalesComparable {
  let adjustedPrice = comp.sale_price;
  
  // 1. Size adjustment
  const sizeDiff = subject.living_sqft - comp.living_sqft;
  const avgPricePerSqft = comp.sale_price / comp.living_sqft;
  adjustedPrice += sizeDiff * avgPricePerSqft * 0.8; // 80% adjustment factor
  
  // 2. Age adjustment
  const subjectAge = subject.age || new Date().getFullYear() - (subject.year_built || 2000);
  const compAge = new Date().getFullYear() - comp.year_built;
  const ageDiff = subjectAge - compAge;
  adjustedPrice += ageDiff * avgPricePerSqft * subject.living_sqft * -0.005; // -0.5% per year
  
  // 3. Bed/bath adjustment
  const bedDiff = (subject.beds || 0) - comp.beds;
  const bathDiff = subject.baths - comp.baths;
  adjustedPrice += bedDiff * 10000; // $10k per bedroom
  adjustedPrice += bathDiff * 8000;  // $8k per bathroom
  
  // 4. Lot size adjustment
  const lotDiff = (subject.lot_acres || 0) - comp.lot_acres;
  adjustedPrice += lotDiff * 20000; // $20k per acre
  
  // 5. Condition adjustment
  if (comp.condition_score && conditionScore.overallScore) {
    const conditionDiff = conditionScore.overallScore - comp.condition_score;
    adjustedPrice += (conditionDiff / 100) * adjustedPrice * 0.15; // 15% max adjustment
  }
  
  // 6. Time adjustment (appreciation)
  const saleDate = new Date(comp.sale_date);
  const monthsAgo = (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
  const appreciationRate = 0.04 / 12; // 4% annual appreciation
  adjustedPrice *= (1 + appreciationRate * monthsAgo);
  
  // Calculate similarity score (0-1)
  const similarity = calculateSimilarity(comp, subject, conditionScore);
  
  // Calculate recency score (0-1)
  const recency = Math.max(0, 1 - (monthsAgo / 12)); // Decay over 12 months
  
  // Calculate weight (for weighted average)
  const weight = similarity * 0.7 + recency * 0.3;
  
  return {
    ...comp,
    adjustedPrice,
    similarity,
    recency,
    weight
  };
}

function calculateSimilarity(
  comp: SalesComparable,
  subject: AttomProperty,
  _conditionScore: DetailedConditionScore
): number {
  let similarity = 1.0;
  
  // Size similarity (within 20% = 100%, more = penalty)
  const sizeDiff = Math.abs(subject.living_sqft - comp.living_sqft) / subject.living_sqft;
  similarity *= Math.max(0.6, 1 - sizeDiff);
  
  // Age similarity
  const subjectAge = subject.age || new Date().getFullYear() - (subject.year_built || 2000);
  const compAge = new Date().getFullYear() - comp.year_built;
  const ageDiff = Math.abs(subjectAge - compAge);
  similarity *= Math.max(0.7, 1 - (ageDiff / 30)); // Penalty for >30 year difference
  
  // Bed/bath similarity
  const bedMatch = (subject.beds || 0) === comp.beds ? 1 : 0.9;
  const bathMatch = Math.abs(subject.baths - comp.baths) < 1 ? 1 : 0.9;
  similarity *= bedMatch * bathMatch;
  
  // Distance penalty (if available)
  if (comp.distance_miles) {
    similarity *= Math.max(0.8, 1 - (comp.distance_miles / 2)); // Penalty for >2 miles
  }
  
  return Math.max(0, Math.min(1, similarity));
}

// ============================================================================
// METHOD 3: INCOME APPROACH (15% WEIGHT)
// ============================================================================

function calculateIncomeApproach(property: AttomProperty): MethodResult {
  const weight = 0.15;
  
  if (!property.rental_avm || property.rental_avm === 0) {
    console.log('[Income Approach] No rental AVM data, falling back to property AVM');
    return {
      value: property.avm_value,
      weight,
      confidence: 0.50,
      details: { method: 'fallback_to_avm', reason: 'no_rental_data' }
    };
  }
  
  const monthlyRent = property.rental_avm;
  const annualRent = monthlyRent * 12;
  
  // Operating expenses - be more conservative for single family rentals
  const propertyTax = property.tax_history?.[0]?.tax_amount || property.avm_value * 0.012;
  const insurance = property.avm_value * 0.004; // 0.4% of value
  const maintenance = annualRent * 0.08; // 8% of rent (lower for SFR)
  const vacancy = annualRent * 0.05; // 5% vacancy
  const management = annualRent * 0.08; // 8% management (owner-managed often lower)
  
  const totalExpenses = propertyTax + insurance + maintenance + vacancy + management;
  const noi = annualRent - totalExpenses;
  
  // Cap rate varies by location and property value
  // Higher-value markets have lower cap rates, lower-value markets have higher
  // PA secondary markets: typically 6-8% for properties under $350k
  let capRate = 0.07; // Base for PA secondary markets
  if (property.avm_value > 400000) capRate = 0.055; // Premium markets
  else if (property.avm_value > 300000) capRate = 0.06;
  else if (property.avm_value < 200000) capRate = 0.085; // Cheaper areas have higher cap
  
  const value = noi / capRate;
  
  // GRM (Gross Rent Multiplier) - derive from cap rate for consistency
  // GRM ≈ (12 / capRate) × expense_ratio, where expense ratio is typically 0.65-0.75
  // This keeps GRM and cap rate approaches aligned
  const expenseRatio = (annualRent - noi) / annualRent;
  const impliedGRM = (12 / capRate) * (1 - expenseRatio);
  const grmValue = monthlyRent * Math.max(100, Math.min(160, impliedGRM * 12)); // GRM in months, clamped
  
  // Weight cap rate approach higher as it's more fundamental
  const blendedValue = (value * 0.6) + (grmValue * 0.4);
  
  // Actual GRM used for logging
  const grm = Math.round(grmValue / monthlyRent);
  
  console.log('[Income Approach] Calculation:', {
    monthlyRent,
    annualRent,
    propertyTax: Math.round(propertyTax),
    insurance: Math.round(insurance),
    maintenance: Math.round(maintenance),
    vacancy: Math.round(vacancy),
    management: Math.round(management),
    totalExpenses: Math.round(totalExpenses),
    noi: Math.round(noi),
    capRate,
    capRateValue: Math.round(value),
    grm,
    grmValue: Math.round(grmValue),
    blendedValue: Math.round(blendedValue)
  });
  
  // Confidence
  const rentalRange = (property.rental_avm_high || monthlyRent * 1.1) - (property.rental_avm_low || monthlyRent * 0.9);
  const rangePercent = (rentalRange / monthlyRent) * 100;
  
  let confidence = 0.80;
  if (rangePercent < 15) confidence = 0.90;
  else if (rangePercent < 25) confidence = 0.80;
  else confidence = 0.70;
  
  return {
    value: blendedValue,
    weight,
    confidence,
    details: {
      monthlyRent,
      annualRent,
      expenses: {
        tax: propertyTax,
        insurance,
        maintenance,
        vacancy,
        management,
        total: totalExpenses
      },
      noi,
      capRate,
      capRateValue: value,
      grm,
      grmValue,
      rental_avm_range: { low: property.rental_avm_low, high: property.rental_avm_high }
    }
  };
}

// ============================================================================
// METHOD 4: COST APPROACH (15% WEIGHT) - Replacement cost minus depreciation
// ============================================================================

function calculateCostApproach(
  property: AttomProperty,
  conditionScore: DetailedConditionScore
): MethodResult {
  const weight = 0.15;
  
  console.log('[Cost Approach] Condition score input:', {
    overallScore: conditionScore.overallScore,
    overallGrade: conditionScore.overallGrade,
    totalDeferredCost: conditionScore.totalDeferredCost
  });
  
  // Land value - use lot size and regional land values
  const lotAcres = property.lot_acres || 0.20;
  const landValuePerAcre = estimateLandValue(property);
  const landValue = lotAcres * landValuePerAcre;
  
  // Replacement cost new
  const sqft = property.living_sqft;
  const costPerSqft = estimateConstructionCost(property);
  const replacementCostNew = sqft * costPerSqft;
  
  // Age-based depreciation should be moderated by condition
  const age = property.age || new Date().getFullYear() - (property.year_built || 2000);
  
  // Well-maintained homes depreciate much slower
  // A well-maintained 70-year-old home might have effective age of only 30-40 years
  const effectiveAge = calculateEffectiveAge(age, conditionScore);
  
  // Economic life varies significantly by condition
  // A well-maintained home can last 100+ years, poorly maintained might only be 50
  let economicLife = 85; // Base assumption
  if (conditionScore.overallScore >= 80) economicLife = 100; // Excellent - virtually indefinite with maintenance
  else if (conditionScore.overallScore >= 70) economicLife = 95; // Good condition
  else if (conditionScore.overallScore >= 60) economicLife = 85; // Above average
  else if (conditionScore.overallScore >= 50) economicLife = 75; // Average
  else economicLife = 60; // Below average
  
  // Cap depreciation at 70% for land + some residual structure value
  // Even old homes have significant value if structurally sound
  const depreciationPercent = Math.min(0.70, effectiveAge / economicLife);
  const physicalDepreciation = depreciationPercent * replacementCostNew;
  
  // Functional obsolescence should be minimal for well-maintained homes
  const functionalObsolescence = calculateFunctionalObsolescence(property, conditionScore);
  const externalObsolescence = 0;
  
  const totalDepreciation = physicalDepreciation + functionalObsolescence + externalObsolescence;
  
  // Minimum residual value of 30% for standing structures
  const depreciatedValue = Math.max(replacementCostNew * 0.30, replacementCostNew - totalDepreciation);
  
  const value = landValue + depreciatedValue;
  
  console.log('[Cost Approach] Calculation breakdown:', {
    landValue: Math.round(landValue),
    landValuePerAcre: Math.round(landValuePerAcre),
    lotAcres,
    sqft,
    costPerSqft,
    replacementCostNew: Math.round(replacementCostNew),
    age,
    effectiveAge: Math.round(effectiveAge),
    economicLife,
    depreciationPercent: (depreciationPercent * 100).toFixed(1) + '%',
    physicalDepreciation: Math.round(physicalDepreciation),
    functionalObsolescence: Math.round(functionalObsolescence),
    totalDepreciation: Math.round(totalDepreciation),
    depreciatedValue: Math.round(depreciatedValue),
    finalValue: Math.round(value)
  });
  
  return {
    value,
    weight,
    confidence: 0.75,
    details: {
      landValue,
      replacementCostNew,
      costPerSqft,
      depreciation: {
        physical: physicalDepreciation,
        functional: functionalObsolescence,
        external: externalObsolescence,
        total: totalDepreciation
      },
      depreciatedValue,
      effectiveAge,
      actualAge: age
    }
  };
}

function estimateLandValue(property: AttomProperty): number {
  // Land value per acre varies by location and property type
  // Use AVM and typical land-to-total value ratios
  
  const avm = property.avm_value || 200000;
  const sqft = property.living_sqft || 1500;
  
  // In suburban/rural areas, land is typically 15-25% of total value
  // In urban areas, land can be 30-40% of total value
  
  // Estimate based on price per sqft of improvements
  const pricePerSqft = avm / sqft;
  
  let landRatio = 0.20; // Default 20%
  if (pricePerSqft < 80) landRatio = 0.15; // Rural/low-cost areas
  else if (pricePerSqft < 150) landRatio = 0.20; // Suburban
  else if (pricePerSqft < 250) landRatio = 0.25; // Urban
  else landRatio = 0.30; // High-value urban
  
  const estimatedTotalLandValue = avm * landRatio;
  const lotAcres = property.lot_acres || 0.20;
  
  return estimatedTotalLandValue / lotAcres;
}

function estimateConstructionCost(property: AttomProperty): number {
  // 2024 construction costs - replacement cost (modern equivalent)
  // Pennsylvania is slightly below national average
  // National average $150-200/sqft, PA area ~$175/sqft
  let baseCost = 175; // $/sqft for average quality construction
  
  // Adjust for property type
  const propertyType = (property.property_type || 'single family').toLowerCase();
  if (propertyType.includes('luxury') || propertyType.includes('custom')) {
    baseCost = 275;
  } else if (propertyType.includes('townhouse') || propertyType.includes('condo')) {
    baseCost = 140;
  }
  
  // Quality adjustments based on features
  const baths = property.baths || 2;
  const sqft = property.living_sqft || 1500;
  
  // More bathrooms indicates higher quality construction
  if (baths >= 3) baseCost *= 1.05;
  if (baths >= 4) baseCost *= 1.05;
  
  // Larger homes have economy of scale (per sqft cost drops)
  if (sqft > 3000) baseCost *= 0.95;
  if (sqft > 4000) baseCost *= 0.95;
  
  // Smaller homes cost more per sqft (fixed costs distributed over less space)
  if (sqft < 1200) baseCost *= 1.10;
  
  // NO AGE PENALTY - we use replacement cost (modern equivalent)
  // not reproduction cost. A house is a house regardless of when built.
  // The depreciation calculation handles age separately.
  
  console.log(`[Cost Approach] Construction cost: $${baseCost.toFixed(0)}/sqft`);
  
  return baseCost;
}

function calculateEffectiveAge(actualAge: number, conditionScore: DetailedConditionScore): number {
  // Effective age can be MUCH less than actual age if well-maintained
  // A 70-year-old home in excellent condition might have effective age of only 25-30 years
  
  // Condition score of 75 is "average" - at this point, effective age = actual age
  // Higher scores mean LOWER effective age
  // Lower scores mean HIGHER effective age
  
  const baseMultiplier = 75 / Math.max(conditionScore.overallScore, 40);
  
  // Apply diminishing returns - very old homes can't have effective age of 0
  let effectiveAge = actualAge * baseMultiplier;
  
  // For well-maintained homes (score >= 70), cap effective age at 60% of actual
  if (conditionScore.overallScore >= 70) {
    effectiveAge = Math.min(effectiveAge, actualAge * 0.6);
  }
  
  // Minimum effective age is 5 years (even brand new homes have some wear)
  // Maximum effective age is 1.3x actual (severely neglected)
  return Math.max(5, Math.min(actualAge * 1.3, effectiveAge));
}

function calculateFunctionalObsolescence(
  property: AttomProperty,
  conditionScore: DetailedConditionScore
): number {
  let obsolescence = 0;
  
  // Deferred maintenance
  obsolescence += conditionScore.totalDeferredCost;
  
  // Outdated systems
  if (conditionScore.systems.overallScore < 60) {
    obsolescence += property.avm_value * 0.05; // 5% penalty
  }
  
  // Outdated kitchen/baths
  if (conditionScore.interior.kitchen.score < 60) {
    obsolescence += property.avm_value * 0.03; // 3% penalty
  }
  
  if (conditionScore.interior.bathrooms.avgScore < 60) {
    obsolescence += property.avm_value * 0.02; // 2% penalty
  }
  
  return obsolescence;
}

// ============================================================================
// CONDITION ADJUSTMENT
// ============================================================================

export function applyDetailedConditionAdjustment(
  baseValue: number,
  conditionScore: DetailedConditionScore,
  _property: AttomProperty
): ConditionAdjustment {
  
  const conditionMultiplier = getConditionMultiplier(conditionScore.overallGrade);
  const adjustedValue = baseValue * conditionMultiplier;
  
  // Deferred maintenance reduces value dollar-for-dollar (with some discount)
  const deferredMaintenance = conditionScore.totalDeferredCost * 0.80; // Buyers discount 20%
  const finalAdjustedValue = adjustedValue - deferredMaintenance;
  
  // Room-by-room impact
  const kitchenImpact = calculateKitchenImpact(conditionScore.interior.kitchen, baseValue);
  const bathroomsImpact = calculateBathroomsImpact(conditionScore.interior.bathrooms, baseValue);
  const overallImpact = (finalAdjustedValue - baseValue) / baseValue;
  
  return {
    baseValue,
    conditionMultiplier,
    adjustedValue,
    deferredMaintenance,
    finalAdjustedValue,
    roomByRoomImpact: {
      kitchen: {
        score: conditionScore.interior.kitchen.score,
        impact: kitchenImpact
      },
      bathrooms: {
        score: conditionScore.interior.bathrooms.avgScore,
        impact: bathroomsImpact
      },
      overall: {
        score: conditionScore.overallScore,
        impact: overallImpact
      }
    }
  };
}

function calculateKitchenImpact(kitchen: any, baseValue: number): number {
  // Kitchen represents ~15% of home value
  const kitchenPortion = baseValue * 0.15;
  const kitchenMultiplier = kitchen.score / 75; // 75 is "average"
  const adjustedKitchenValue = kitchenPortion * kitchenMultiplier;
  
  return (adjustedKitchenValue - kitchenPortion) / baseValue;
}

function calculateBathroomsImpact(bathrooms: any, baseValue: number): number {
  // Bathrooms represent ~10% of home value
  const bathroomsPortion = baseValue * 0.10;
  const bathroomsMultiplier = bathrooms.avgScore / 75;
  const adjustedBathroomsValue = bathroomsPortion * bathroomsMultiplier;
  
  return (adjustedBathroomsValue - bathroomsPortion) / baseValue;
}

// ============================================================================
// RECOMMENDATIONS
// ============================================================================

function generateValuationRecommendation(
  status: 'undervalued' | 'fair_valued' | 'overvalued',
  valuationGapPercent: number,
  confidence: 'high' | 'medium' | 'low',
  conditionScore: DetailedConditionScore
): string {
  const gap = Math.abs(valuationGapPercent);
  
  if (status === 'overvalued') {
    if (gap > 20) {
      return `Property is significantly overvalued by ${gap.toFixed(1)}%. Avoid or negotiate aggressively (${confidence} confidence).`;
    } else if (gap > 10) {
      return `Property is overvalued by ${gap.toFixed(1)}%. Offer 10-15% below asking (${confidence} confidence).`;
    } else {
      return `Property is slightly overvalued by ${gap.toFixed(1)}%. Room for minor negotiation (${confidence} confidence).`;
    }
  } else if (status === 'undervalued') {
    if (gap > 20) {
      return `Excellent opportunity! Property is undervalued by ${gap.toFixed(1)}%. Act quickly (${confidence} confidence).`;
    } else if (gap > 10) {
      return `Good value. Property is undervalued by ${gap.toFixed(1)}%. Strong purchase candidate (${confidence} confidence).`;
    } else {
      return `Fair pricing. Property is slightly undervalued by ${gap.toFixed(1)}% (${confidence} confidence).`;
    }
  } else {
    if (conditionScore.overallScore >= 75) {
      return `Property is fairly valued with good condition. Solid investment at asking price (${confidence} confidence).`;
    } else {
      return `Property is fairly valued but requires improvements. Factor renovation costs into offer (${confidence} confidence).`;
    }
  }
}
