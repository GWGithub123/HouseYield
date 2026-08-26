/**
 * Detailed Condition Scoring System
 * Converts Visual AI photo analysis into comprehensive 0-100 room-by-room scores
 */

import {
  DetailedConditionScore,
  ExteriorScore,
  InteriorScore,
  SystemsScore,
  ComponentScore,
  RoomScore,
  SystemScore,
  QualitativeFactors,
  DeferredMaintenanceItem
} from '../types/propertyAnalysis';
import type { CanonicalVisualEvidence } from '../types/renovationPipeline';

type CanonicalAwareVisualData = {
  renovation_opportunities?: unknown[];
  canonicalEvidence?: CanonicalVisualEvidence;
};

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Process Visual AI data into detailed condition scoring
 * @param visualAIData - Raw data from Visual AI photo analysis
 * @param propertyData - ATTOM property data for context
 * @returns Complete detailed condition score
 */
export function calculateDetailedConditionScore(
  visualAIData: any,
  propertyData: any
): DetailedConditionScore {
  const hasVisualData = visualAIData && Object.keys(visualAIData).length > 0 && 
    (visualAIData.exterior || visualAIData.interior || visualAIData.systems);
  
  console.log('[ConditionScoring] Visual AI data available:', hasVisualData);
  
  // If no visual data, use optimistic defaults for well-maintained properties
  // Most homes that are still standing and marketable are reasonably maintained
  const defaultCondition = hasVisualData ? 'average' : 'good';
  
  const exterior = analyzeExteriorCondition(visualAIData?.exterior || {}, propertyData, defaultCondition);
  const interior = analyzeInteriorCondition(visualAIData?.interior || {}, propertyData, defaultCondition);
  const systems = analyzeSystemsCondition(visualAIData?.systems || {}, propertyData, defaultCondition);
  const qualitative = analyzeQualitativeFactors(visualAIData?.qualitative || {});
  
  let overallScore = calculateOverallScore(exterior, interior, systems, qualitative);
  
  // If no visual data provided, ensure minimum score of 75 (grade B)
  // Properties on market are typically at least reasonably maintained
  if (!hasVisualData) {
    overallScore = Math.max(75, overallScore);
  }
  
  const overallGrade = scoreToGrade(overallScore);
  
  console.log('[ConditionScoring] Calculated scores:', {
    hasVisualData,
    defaultCondition,
    exterior: Math.round(exterior.overallScore),
    interior: Math.round(interior.overallScore),
    systems: Math.round(systems.overallScore),
    overall: Math.round(overallScore),
    grade: overallGrade
  });
  
  const deferredMaintenance = compileDeferredMaintenance(
    exterior,
    interior,
    systems,
    propertyData
  );
  
  const totalDeferredCost = deferredMaintenance.reduce((sum, item) => sum + item.cost, 0);
  const renovationPotential = calculateRenovationPotential(exterior, interior, systems);
  
  // Capture AI-identified renovation opportunities
  const aiRenovationOpportunities = getAIRenovationOpportunities(visualAIData);
  
  console.log('[ConditionScoring] AI Renovation Opportunities:', aiRenovationOpportunities.length);
  if (aiRenovationOpportunities.length > 0) {
    console.log('[ConditionScoring] Opportunities:', aiRenovationOpportunities.map((o: any) => ({
      area: o.area,
      value_add: o.value_add_potential,
      rent_increase: o.rent_increase_potential
    })));
  }
  
  return {
    overallGrade,
    overallScore,
    exterior,
    interior,
    systems,
    qualitativeFactors: qualitative,
    deferredMaintenance,
    totalDeferredCost,
    renovationPotential,
    aiRenovationOpportunities
  };
}

function getAIRenovationOpportunities(visualAIData: CanonicalAwareVisualData | null | undefined) {
  const legacyOpportunities = Array.isArray(visualAIData?.renovation_opportunities)
    ? visualAIData.renovation_opportunities
    : [];

  if (legacyOpportunities.length > 0) {
    return legacyOpportunities;
  }

  const canonicalOpportunities = visualAIData?.canonicalEvidence?.opportunities || [];
  if (canonicalOpportunities.length === 0) {
    return [];
  }

  return canonicalOpportunities.map((opportunity) => ({
    area: opportunity.roomType,
    description: opportunity.suggestedIntervention || opportunity.problemStatement,
    estimated_cost_range: 'Needs deterministic cost estimate',
    value_add_potential: mapCanonicalMarketFitToValueAddPotential(opportunity.marketFit),
    rent_increase_potential: 'Needs deterministic rent uplift estimate',
    priority: mapCanonicalPriorityToLegacyPriority(opportunity.priority),
    roi_estimate: 'Needs deterministic ROI estimate',
  }));
}

function mapCanonicalMarketFitToValueAddPotential(
  marketFit: CanonicalVisualEvidence['opportunities'][number]['marketFit']
): 'high' | 'medium' | 'low' {
  if (marketFit === 'excellent' || marketFit === 'good') {
    return 'high';
  }

  if (marketFit === 'neutral') {
    return 'medium';
  }

  return 'low';
}

function mapCanonicalPriorityToLegacyPriority(
  priority: CanonicalVisualEvidence['opportunities'][number]['priority']
): 'immediate' | 'short-term' | 'long-term' {
  if (priority === 'critical') {
    return 'immediate';
  }

  if (priority === 'high' || priority === 'medium') {
    return 'short-term';
  }

  return 'long-term';
}

// ============================================================================
// EXTERIOR ANALYSIS
// ============================================================================

export function analyzeExteriorCondition(
  exteriorData: any,
  propertyData: any,
  defaultCondition: string = 'average'
): ExteriorScore {
  const age = propertyData.age || new Date().getFullYear() - (propertyData.year_built || propertyData.summary?.year_built || 2000);
  
  // Safely access exterior data with fallback to empty objects
  const roof = analyzeRoof(exteriorData?.roof || {}, age, defaultCondition);
  const siding = analyzeSiding(exteriorData?.siding || {}, age, defaultCondition);
  const windows = analyzeWindows(exteriorData?.windows || {}, age, defaultCondition);
  const doors = analyzeDoors(exteriorData?.doors || {}, defaultCondition);
  const foundation = analyzeFoundation(exteriorData?.foundation || {}, age, defaultCondition);
  const driveway = analyzeDriveway(exteriorData?.driveway || {}, defaultCondition);
  const landscaping = analyzeLandscaping(exteriorData?.landscaping || {}, defaultCondition);
  
  const overallScore = (
    roof.score * 0.30 +
    siding.score * 0.25 +
    windows.score * 0.15 +
    foundation.score * 0.15 +
    doors.score * 0.05 +
    driveway.score * 0.05 +
    landscaping.score * 0.05
  );
  
  return {
    roof,
    siding,
    windows,
    doors,
    foundation,
    driveway,
    landscaping,
    overallScore
  };
}

function analyzeRoof(roofData: any, age: number, defaultCondition: string = 'average'): ComponentScore {
  const condition = roofData?.condition || defaultCondition;
  const type = roofData?.type || 'asphalt_shingle';
  // Without visual data, estimate roof age based on default condition
  // If condition is "good" or better, assume roof is well-maintained (5-10 years old)
  // This prevents unfairly penalizing properties without photo analysis
  let estimatedAge: number;
  if (roofData?.age) {
    estimatedAge = roofData.age;
  } else if (condition === 'excellent') {
    estimatedAge = Math.min(5, age); // Nearly new roof
  } else if (condition === 'good') {
    estimatedAge = Math.min(8, age); // Well-maintained, mid-life roof
  } else if (condition === 'average') {
    estimatedAge = Math.min(15, age); // Average age
  } else {
    estimatedAge = Math.min(age, 20); // Older/unknown
  }
  
  const typicalLifespans: { [key: string]: number } = {
    asphalt_shingle: 20,
    architectural_shingle: 30,
    metal: 50,
    tile: 50,
    slate: 100,
    flat: 15
  };
  
  const expectedLife = typicalLifespans[type] || 20;
  const remainingLife = Math.max(0, expectedLife - estimatedAge);
  const lifeRemaining = remainingLife / expectedLife;
  
  let baseScore = lifeRemaining * 100;
  
  // Adjust for visual condition
  // "good" is baseline (1.0), "excellent" is premium, below "good" gets penalties
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.85,
    fair: 0.70,
    poor: 0.45
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.85);
  
  // Check for issues
  if (roofData?.issues?.missing_shingles) baseScore -= 15;
  if (roofData?.issues?.visible_damage) baseScore -= 20;
  if (roofData?.issues?.sagging) baseScore -= 30;
  if (roofData?.issues?.moss_algae) baseScore -= 5;
  
  const score = Math.max(0, Math.min(100, baseScore));
  
  const replacementCosts: { [key: string]: number } = {
    asphalt_shingle: 8000,
    architectural_shingle: 12000,
    metal: 18000,
    tile: 20000,
    slate: 30000,
    flat: 10000
  };
  
  const replacementCost = replacementCosts[type] || 8000;
  
  let urgency: 'immediate' | 'soon' | 'monitor' | 'none' = 'none';
  if (score < 40 || roofData?.issues?.active_leaks) urgency = 'immediate';
  else if (score < 60) urgency = 'soon';
  else if (score < 75) urgency = 'monitor';
  
  return {
    score,
    condition: scoreToCondition(score),
    age: estimatedAge,
    remainingLife,
    replacementCost,
    urgency,
    notes: `${type} roof, ${estimatedAge} years old, ${remainingLife} years remaining life`
  };
}

function analyzeSiding(sidingData: any, age: number, defaultCondition: string = 'average'): ComponentScore {
  const condition = sidingData?.condition || defaultCondition;
  const type = sidingData?.type || 'vinyl';
  // Estimate siding age based on condition rating
  // If marked as "good" condition, assume it's well-maintained/replaced
  let estimatedAge: number;
  if (sidingData?.age) {
    estimatedAge = sidingData.age;
  } else if (condition === 'excellent') {
    estimatedAge = Math.min(10, age);
  } else if (condition === 'good') {
    estimatedAge = Math.min(15, age);
  } else if (condition === 'average') {
    estimatedAge = Math.min(25, age);
  } else {
    estimatedAge = age > 40 ? Math.min(age * 0.5, 30) : age;
  }
  
  const typicalLifespans: { [key: string]: number } = {
    vinyl: 40,
    fiber_cement: 50,
    brick: 100,
    stucco: 50,
    wood: 30,
    aluminum: 40,
    stone: 100
  };
  
  const expectedLife = typicalLifespans[type] || 40;
  const remainingLife = Math.max(0, expectedLife - estimatedAge);
  const lifeRemaining = remainingLife / expectedLife;
  
  let baseScore = lifeRemaining * 100;
  
  // "good" is baseline (1.0), "excellent" is premium, below "good" gets penalties
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.85,
    fair: 0.70,
    poor: 0.45
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.85);
  
  if (sidingData?.issues?.cracks) baseScore -= 15;
  if (sidingData?.issues?.warping) baseScore -= 20;
  if (sidingData?.issues?.rot) baseScore -= 25;
  if (sidingData?.issues?.paint_peeling) baseScore -= 10;
  
  const score = Math.max(0, Math.min(100, baseScore));
  
  const replacementCosts: { [key: string]: number } = {
    vinyl: 12000,
    fiber_cement: 18000,
    brick: 25000,
    stucco: 15000,
    wood: 20000,
    aluminum: 10000,
    stone: 35000
  };
  
  const replacementCost = replacementCosts[type] || 12000;
  
  let urgency: 'immediate' | 'soon' | 'monitor' | 'none' = 'none';
  if (score < 40) urgency = 'immediate';
  else if (score < 60) urgency = 'soon';
  else if (score < 75) urgency = 'monitor';
  
  return {
    score,
    condition: scoreToCondition(score),
    age: estimatedAge,
    remainingLife,
    replacementCost,
    urgency,
    notes: `${type} siding, ${estimatedAge} years old`
  };
}

function analyzeWindows(windowsData: any, age: number, defaultCondition: string = 'average'): ComponentScore {
  const condition = windowsData?.condition || defaultCondition;
  const type = windowsData?.type || 'double_pane';
  // Windows are often upgraded in older homes
  const estimatedAge = windowsData?.age || (age > 30 ? Math.min(age * 0.5, 20) : age);
  
  let baseScore = 75;
  
  if (type === 'single_pane') baseScore = 40;
  else if (type === 'double_pane') baseScore = 75;
  else if (type === 'triple_pane' || type === 'low_e') baseScore = 95;
  
  // "good" is baseline (1.0), "excellent" is premium
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.85,
    fair: 0.70,
    poor: 0.50
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.85);
  
  if (windowsData?.issues?.broken_seals) baseScore -= 15;
  if (windowsData?.issues?.rot) baseScore -= 20;
  if (windowsData?.issues?.difficult_to_open) baseScore -= 10;
  if (windowsData?.issues?.drafty) baseScore -= 15;
  
  const score = Math.max(0, Math.min(100, baseScore));
  const replacementCost = (windowsData?.count || 15) * 600;
  
  let urgency: 'immediate' | 'soon' | 'monitor' | 'none' = 'none';
  if (score < 50) urgency = 'soon';
  else if (score < 70) urgency = 'monitor';
  
  return {
    score,
    condition: scoreToCondition(score),
    age: estimatedAge,
    replacementCost,
    urgency,
    notes: `${type} windows, ${windowsData?.count || 15} windows total`
  };
}

function analyzeDoors(doorsData: any, defaultCondition: string = 'good'): ComponentScore {
  const condition = doorsData?.condition || defaultCondition;
  const frontDoorQuality = doorsData?.front_door?.quality || 'mid';
  
  let baseScore = 80;
  
  const qualityScores: { [key: string]: number } = {
    luxury: 100,
    high: 90,
    mid: 75,
    builder: 60,
    low: 40
  };
  
  baseScore = qualityScores[frontDoorQuality] || 75;
  
  // "good" is baseline (1.0), "excellent" is premium
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.90,
    fair: 0.75,
    poor: 0.55
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.90);
  
  if (doorsData?.issues?.damaged) baseScore -= 15;
  if (doorsData?.issues?.security_concerns) baseScore -= 20;
  
  const score = Math.max(0, Math.min(100, baseScore));
  const replacementCost = 3000;
  
  return {
    score,
    condition: scoreToCondition(score),
    replacementCost,
    urgency: score < 60 ? 'soon' : 'none',
    notes: `${frontDoorQuality} quality doors`
  };
}

function analyzeFoundation(foundationData: any, age: number, defaultCondition: string = 'good'): ComponentScore {
  const condition = foundationData?.condition || defaultCondition;
  const type = foundationData?.type || 'concrete_slab';
  
  let baseScore = 90;
  
  // "good" is baseline (1.0), "excellent" is premium
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.05,
    good: 1.0,
    average: 0.90,
    fair: 0.75,
    poor: 0.50
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.90);
  
  if (foundationData?.issues?.cracks) baseScore -= 20;
  if (foundationData?.issues?.settlement) baseScore -= 30;
  if (foundationData?.issues?.water_damage) baseScore -= 25;
  if (foundationData?.issues?.structural_concerns) baseScore -= 40;
  
  const score = Math.max(0, Math.min(100, baseScore));
  const replacementCost = 15000;
  
  let urgency: 'immediate' | 'soon' | 'monitor' | 'none' = 'none';
  if (score < 50 || foundationData?.issues?.structural_concerns) urgency = 'immediate';
  else if (score < 70) urgency = 'soon';
  else if (score < 85) urgency = 'monitor';
  
  return {
    score,
    condition: scoreToCondition(score),
    age,
    replacementCost,
    urgency,
    notes: `${type} foundation`
  };
}

function analyzeDriveway(drivewayData: any, defaultCondition: string = 'average'): ComponentScore {
  const condition = drivewayData?.condition || defaultCondition;
  const type = drivewayData?.type || 'asphalt';
  
  let baseScore = 70;
  
  // "good" is baseline (1.0), "excellent" is premium
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.85,
    fair: 0.70,
    poor: 0.50
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.85);
  
  if (drivewayData?.issues?.cracks) baseScore -= 10;
  if (drivewayData?.issues?.potholes) baseScore -= 15;
  if (drivewayData?.issues?.drainage_issues) baseScore -= 10;
  
  const score = Math.max(0, Math.min(100, baseScore));
  
  const replacementCosts: { [key: string]: number } = {
    asphalt: 4000,
    concrete: 6000,
    pavers: 8000,
    gravel: 1500
  };
  
  const replacementCost = replacementCosts[type] || 4000;
  
  return {
    score,
    condition: scoreToCondition(score),
    replacementCost,
    urgency: score < 50 ? 'soon' : 'none',
    notes: `${type} driveway`
  };
}

function analyzeLandscaping(landscapingData: any, defaultCondition: string = 'average'): ComponentScore {
  const condition = landscapingData?.condition || defaultCondition;
  const quality = landscapingData?.quality || 'basic';
  
  const qualityScores: { [key: string]: number } = {
    luxury: 95,
    high: 85,
    mid: 70,
    basic: 60,
    neglected: 30
  };
  
  let baseScore = qualityScores[quality] || 60;
  
  // "good" is baseline (1.0), "excellent" is premium
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.85,
    fair: 0.70,
    poor: 0.50
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.85);
  
  const score = Math.max(0, Math.min(100, baseScore));
  const replacementCost = 5000;
  
  return {
    score,
    condition: scoreToCondition(score),
    replacementCost,
    urgency: 'none',
    notes: `${quality} quality landscaping`
  };
}

// ============================================================================
// INTERIOR ANALYSIS
// ============================================================================

export function analyzeInteriorCondition(
  interiorData: any,
  _propertyData: any,
  defaultCondition: string = 'average'
): InteriorScore {
  // If no interior data provided, use optimistic defaults
  const hasData = interiorData && Object.keys(interiorData).length > 0;
  const effectiveData = hasData ? interiorData : {
    kitchen: { condition: defaultCondition, quality: 'mid', appliances_age: 10 },
    bathrooms: { master: { condition: defaultCondition }, secondary: [] },
    living_room: { condition: defaultCondition },
    bedrooms: { master: { condition: defaultCondition }, secondary: [] },
    flooring: { condition: defaultCondition, type: 'hardwood' },
    paint: { condition: defaultCondition },
    lighting: { condition: defaultCondition }
  };
  
  const kitchen = analyzeKitchen(effectiveData?.kitchen || {});
  
  const masterBath = analyzeBathroom(effectiveData?.bathrooms?.master || {}, 'master');
  const secondaryBaths = (effectiveData?.bathrooms?.secondary || []).map((bath: any, i: number) => 
    analyzeBathroom(bath, `secondary_${i}`)
  );
  const avgBathScore = secondaryBaths.length > 0
    ? (masterBath.score + secondaryBaths.reduce((sum: number, b: RoomScore) => sum + b.score, 0)) / (secondaryBaths.length + 1)
    : masterBath.score;
  
  const livingRoom = analyzeLivingRoom(effectiveData?.living_room || {});
  
  const masterBed = analyzeBedroom(effectiveData?.bedrooms?.master || {}, 'master');
  const secondaryBeds = (effectiveData?.bedrooms?.secondary || []).map((bed: any, i: number) =>
    analyzeBedroom(bed, `secondary_${i}`)
  );
  const avgBedScore = secondaryBeds.length > 0
    ? (masterBed.score + secondaryBeds.reduce((sum: number, b: RoomScore) => sum + b.score, 0)) / (secondaryBeds.length + 1)
    : masterBed.score;
  
  const flooring = analyzeFlooring(effectiveData.flooring);
  const paint = analyzePaint(effectiveData.paint);
  const lighting = analyzeLighting(effectiveData.lighting);
  
  const overallScore = (
    kitchen.score * 0.25 +
    avgBathScore * 0.20 +
    livingRoom.score * 0.15 +
    avgBedScore * 0.15 +
    flooring.score * 0.10 +
    paint.score * 0.10 +
    lighting.score * 0.05
  );
  
  return {
    kitchen,
    bathrooms: {
      master: masterBath,
      secondary: secondaryBaths,
      avgScore: avgBathScore
    },
    livingRoom,
    bedrooms: {
      master: masterBed,
      secondary: secondaryBeds,
      avgScore: avgBedScore
    },
    flooring,
    paint,
    lighting,
    overallScore
  };
}

function analyzeKitchen(kitchenData: any): RoomScore {
  // Map condition strings to scores
  const conditionScores: { [key: string]: number } = {
    excellent: 95,
    good: 82,
    average: 70,
    fair: 55,
    poor: 35
  };
  
  // Use condition from Visual AI if available, otherwise use component scores
  const baseConditionScore = conditionScores[kitchenData?.condition] || 70;
  
  // Individual component analysis
  const cabinets = kitchenData?.cabinets?.score || 
    (kitchenData?.cabinets === 'good' ? 80 : kitchenData?.cabinets === 'excellent' ? 92 : baseConditionScore);
  const countertops = kitchenData?.countertops?.score ||
    (kitchenData?.countertops === 'granite' || kitchenData?.countertops === 'quartz' ? 90 : 
     kitchenData?.countertops === 'laminate' ? 65 : baseConditionScore);
  const appliances = kitchenData?.appliances?.score ||
    (kitchenData?.appliances === 'modern' || kitchenData?.appliances === 'stainless' ? 85 : 
     kitchenData?.appliances === 'dated' ? 55 : baseConditionScore);
  const flooring = kitchenData?.flooring?.score ||
    (kitchenData?.flooring === 'hardwood' || kitchenData?.flooring === 'tile' ? 85 : baseConditionScore);
  const backsplash = kitchenData?.backsplash?.score || baseConditionScore - 5;
  const lighting = kitchenData?.lighting?.score || baseConditionScore;
  const layout = kitchenData?.layout?.score || 75;
  
  const score = (
    cabinets * 0.25 +
    countertops * 0.20 +
    appliances * 0.20 +
    flooring * 0.10 +
    backsplash * 0.10 +
    lighting * 0.05 +
    layout * 0.10
  );
  
  const materialQuality = determineMaterialQuality(kitchenData);
  const modernization = kitchenData?.modernization || (score > 80 ? 85 : score > 60 ? 65 : 45);
  const functionality = kitchenData?.functionality || 75;
  
  // Only flag renovation if score is quite low (< 55 instead of 65)
  const renovationNeeded = score < 55;
  const estimatedRenovationCost = estimateKitchenRenovationCost(kitchenData, materialQuality);
  
  return {
    score,
    components: { cabinets, countertops, appliances, flooring, backsplash, lighting, layout },
    materialQuality,
    modernization,
    functionality,
    renovationNeeded,
    estimatedRenovationCost
  };
}

function analyzeBathroom(bathroomData: any, type: string): RoomScore {
  // Map condition strings to scores
  const conditionScores: { [key: string]: number } = {
    excellent: 95,
    good: 82,
    average: 70,
    fair: 55,
    poor: 35
  };
  
  // Use condition from Visual AI if available
  const baseConditionScore = conditionScores[bathroomData?.condition] || 70;
  
  // Check for "updated" or "modern" fixtures indicators
  const fixturesUpdated = bathroomData?.fixtures === 'updated' || bathroomData?.fixtures === 'modern';
  const fixturesDated = bathroomData?.fixtures === 'dated' || bathroomData?.fixtures === 'old';
  
  const fixtures = bathroomData?.fixtures?.score || (fixturesUpdated ? 88 : fixturesDated ? 50 : baseConditionScore);
  const vanity = bathroomData?.vanity?.score || baseConditionScore;
  const flooring = bathroomData?.flooring?.score || baseConditionScore;
  const tile = bathroomData?.tile?.score || baseConditionScore - 5;
  const lighting = bathroomData?.lighting?.score || baseConditionScore;
  const shower_tub = bathroomData?.shower_tub?.score || baseConditionScore;
  
  const score = (
    fixtures * 0.20 +
    vanity * 0.20 +
    tile * 0.20 +
    shower_tub * 0.15 +
    flooring * 0.15 +
    lighting * 0.10
  );
  
  const materialQuality = determineMaterialQuality(bathroomData);
  const modernization = bathroomData?.modernization || (score > 80 ? 85 : score > 60 ? 65 : 45);
  const functionality = bathroomData?.functionality || 80;
  
  // Only flag renovation if score is quite low (< 50 instead of 60)
  const renovationNeeded = score < 50;
  const estimatedRenovationCost = type === 'master' ? 15000 : 8000;
  
  return {
    score,
    components: { fixtures, vanity, flooring, tile, lighting, shower_tub },
    materialQuality,
    modernization,
    functionality,
    renovationNeeded,
    estimatedRenovationCost
  };
}

function analyzeLivingRoom(livingRoomData: any): RoomScore {
  const flooring = livingRoomData?.flooring?.score || 75;
  const paint = livingRoomData?.paint?.score || 70;
  const lighting = livingRoomData?.lighting?.score || 70;
  const windows = livingRoomData?.windows?.score || 75;
  const layout = livingRoomData?.layout?.score || 80;
  
  const score = (
    flooring * 0.30 +
    paint * 0.20 +
    lighting * 0.20 +
    windows * 0.15 +
    layout * 0.15
  );
  
  return {
    score,
    components: { flooring, paint, lighting, windows, layout },
    materialQuality: 'mid',
    modernization: score,
    functionality: layout,
    renovationNeeded: score < 60,
    estimatedRenovationCost: 5000
  };
}

function analyzeBedroom(bedroomData: any, _type: string): RoomScore {
  const flooring = bedroomData?.flooring?.score || 75;
  const paint = bedroomData?.paint?.score || 70;
  const lighting = bedroomData?.lighting?.score || 70;
  const closet = bedroomData?.closet?.score || 75;
  
  const score = (
    flooring * 0.35 +
    paint * 0.25 +
    closet * 0.20 +
    lighting * 0.20
  );
  
  return {
    score,
    components: { flooring, paint, lighting, closet },
    materialQuality: 'mid',
    modernization: score,
    functionality: 75,
    renovationNeeded: score < 60,
    estimatedRenovationCost: 3000
  };
}

function analyzeFlooring(flooringData: any): ComponentScore {
  const condition = flooringData?.condition || 'average';
  const type = flooringData?.type || 'carpet';
  
  const typeScores: { [key: string]: number } = {
    hardwood: 90,
    engineered_hardwood: 85,
    luxury_vinyl: 80,
    tile: 85,
    laminate: 70,
    carpet: 60,
    vinyl: 55
  };
  
  let baseScore = typeScores[type] || 60;
  
  // "good" is baseline (1.0), "excellent" is premium
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.85,
    fair: 0.70,
    poor: 0.50
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.85);
  
  const score = Math.max(0, Math.min(100, baseScore));
  const replacementCost = 8000;
  
  return {
    score,
    condition: scoreToCondition(score),
    replacementCost,
    urgency: score < 50 ? 'soon' : 'none',
    notes: `${type} flooring throughout`
  };
}

function analyzePaint(paintData: any): ComponentScore {
  const condition = paintData?.condition || 'average';
  const age = paintData?.years_since_painted || 5;
  
  let baseScore = Math.max(40, 100 - (age * 8));
  
  // "good" is baseline (1.0), "excellent" is premium
  const conditionMultipliers: { [key: string]: number } = {
    excellent: 1.1,
    good: 1.0,
    average: 0.85,
    fair: 0.70,
    poor: 0.50
  };
  
  baseScore *= (conditionMultipliers[condition] || 0.85);
  
  const score = Math.max(0, Math.min(100, baseScore));
  const replacementCost = 3500;
  
  return {
    score,
    condition: scoreToCondition(score),
    age,
    replacementCost,
    urgency: score < 50 ? 'soon' : 'none',
    notes: `Last painted ${age} years ago`
  };
}

function analyzeLighting(lightingData: any): ComponentScore {
  const quality = lightingData?.quality || 'builder';
  const modernization = lightingData?.modernization || 60;
  
  const qualityScores: { [key: string]: number } = {
    luxury: 95,
    high: 85,
    mid: 70,
    builder: 60,
    dated: 40
  };
  
  const score = Math.min(qualityScores[quality] || 60, modernization);
  const replacementCost = 2000;
  
  return {
    score,
    condition: scoreToCondition(score),
    replacementCost,
    urgency: score < 50 ? 'monitor' : 'none',
    notes: `${quality} grade lighting fixtures`
  };
}

// ============================================================================
// SYSTEMS ANALYSIS
// ============================================================================

export function analyzeSystemsCondition(
  systemsData: any,
  propertyData: any,
  defaultCondition: string = 'average'
): SystemsScore {
  const age = propertyData.age || new Date().getFullYear() - (propertyData.year_built || propertyData.summary?.year_built || 2000);
  
  // If no systems data, assume they've been maintained/updated
  // Most homes on the market have had systems updated over time
  const hasData = systemsData && Object.keys(systemsData).length > 0;
  
  // For well-maintained homes (defaultCondition='good'), assume systems have been updated
  const assumeUpdated = defaultCondition === 'good' || defaultCondition === 'excellent';
  
  const effectiveData = hasData ? systemsData : {
    hvac: { 
      type: 'central_ac', 
      condition: defaultCondition, 
      // Assume HVAC replaced recently for well-maintained homes (5-7 years old)
      // This gives score of ~53-60% remaining life, avoiding deferred maintenance flags
      age: assumeUpdated ? 5 : (age > 20 ? 10 : Math.min(age, 15))
    },
    electrical: { 
      type: 'circuit_breaker',  // Most homes have been updated
      condition: defaultCondition, 
      amperage: assumeUpdated ? 200 : (age > 30 ? 100 : 200)
    },
    plumbing: { 
      // Assume copper or pex for maintained homes, not galvanized
      material: assumeUpdated ? 'copper' : (age > 50 ? 'galvanized' : 'copper'), 
      condition: defaultCondition 
    },
    water_heater: { 
      type: 'tank', 
      condition: defaultCondition, 
      // Water heaters replaced every 10-15 years
      // Assume 4-6 years old for maintained homes
      age: assumeUpdated ? 4 : (age > 15 ? 8 : Math.min(age, 12))
    }
  };
  
  const hvac = analyzeHVAC(effectiveData.hvac, age);
  const electrical = analyzeElectrical(effectiveData.electrical, age);
  const plumbing = analyzePlumbing(effectiveData.plumbing, age);
  const waterHeater = analyzeWaterHeater(effectiveData.water_heater, age);
  
  const overallScore = (
    hvac.score * 0.35 +
    electrical.score * 0.25 +
    plumbing.score * 0.25 +
    waterHeater.score * 0.15
  );
  
  return {
    hvac,
    electrical,
    plumbing,
    waterHeater,
    overallScore
  };
}

function analyzeHVAC(hvacData: any, houseAge: number): SystemScore {
  const type = hvacData?.type || 'central_ac';
  const age = hvacData?.age || Math.min(houseAge, 15);
  const expectedLife = 15;
  const efficiency = hvacData?.seer || (age < 5 ? 16 : age < 10 ? 14 : 12);
  
  const lifeRemaining = Math.max(0, expectedLife - age) / expectedLife;
  let baseScore = lifeRemaining * 100;
  
  if (efficiency >= 16) baseScore += 10;
  else if (efficiency < 13) baseScore -= 15;
  
  if (hvacData?.issues?.not_cooling) baseScore -= 30;
  if (hvacData?.issues?.noisy) baseScore -= 10;
  if (hvacData?.issues?.inconsistent) baseScore -= 15;
  
  const score = Math.max(0, Math.min(100, baseScore));
  const operatingProperly = !hvacData?.issues?.not_cooling && !hvacData?.issues?.not_heating;
  
  return {
    score,
    type,
    age,
    expectedLife,
    efficiency,
    replacementCost: 8000,
    operatingProperly
  };
}

function analyzeElectrical(electricalData: any, houseAge: number): SystemScore {
  const type = electricalData?.panel_type || (houseAge > 40 ? 'fuse_box' : 'circuit_breaker');
  const amperage = electricalData?.amperage || (houseAge > 30 ? 100 : 200);
  
  let baseScore = 75;
  
  if (type === 'fuse_box') baseScore = 40;
  else if (type === 'circuit_breaker' && amperage >= 200) baseScore = 90;
  else if (type === 'circuit_breaker' && amperage >= 150) baseScore = 75;
  else baseScore = 60;
  
  if (electricalData?.issues?.flickering) baseScore -= 15;
  if (electricalData?.issues?.tripping) baseScore -= 20;
  if (electricalData?.issues?.ungrounded) baseScore -= 25;
  if (electricalData?.issues?.aluminum_wiring) baseScore -= 30;
  
  const score = Math.max(0, Math.min(100, baseScore));
  const operatingProperly = !electricalData?.issues?.tripping && !electricalData?.issues?.flickering;
  
  return {
    score,
    type,
    age: houseAge,
    expectedLife: 100,
    efficiency: amperage >= 200 ? 90 : 70,
    replacementCost: 3000,
    operatingProperly
  };
}

function analyzePlumbing(plumbingData: any, houseAge: number): SystemScore {
  const type = plumbingData?.pipe_type || (houseAge > 50 ? 'galvanized' : 'copper');
  
  let baseScore = 75;
  
  if (type === 'pex' || type === 'cpvc') baseScore = 95;
  else if (type === 'copper') baseScore = 85;
  else if (type === 'galvanized') baseScore = 40;
  else if (type === 'polybutylene') baseScore = 30;
  
  if (plumbingData?.issues?.leaks) baseScore -= 25;
  if (plumbingData?.issues?.low_pressure) baseScore -= 15;
  if (plumbingData?.issues?.slow_drains) baseScore -= 10;
  if (plumbingData?.issues?.corrosion) baseScore -= 20;
  
  const score = Math.max(0, Math.min(100, baseScore));
  const operatingProperly = !plumbingData?.issues?.leaks && !plumbingData?.issues?.major_issues;
  
  return {
    score,
    type,
    age: houseAge,
    expectedLife: type === 'copper' ? 50 : type === 'pex' ? 100 : 30,
    efficiency: 80,
    replacementCost: 6000,
    operatingProperly
  };
}

function analyzeWaterHeater(waterHeaterData: any, houseAge: number): SystemScore {
  const type = waterHeaterData?.type || 'tank';
  const age = waterHeaterData?.age || Math.min(houseAge, 12);
  const expectedLife = type === 'tankless' ? 20 : 12;
  
  const lifeRemaining = Math.max(0, expectedLife - age) / expectedLife;
  let baseScore = lifeRemaining * 100;
  
  if (type === 'tankless') baseScore += 10;
  if (waterHeaterData?.issues?.not_heating) baseScore -= 40;
  if (waterHeaterData?.issues?.leaking) baseScore -= 30;
  
  const score = Math.max(0, Math.min(100, baseScore));
  const operatingProperly = !waterHeaterData?.issues?.not_heating && !waterHeaterData?.issues?.leaking;
  
  return {
    score,
    type,
    age,
    expectedLife,
    efficiency: type === 'tankless' ? 95 : 80,
    replacementCost: type === 'tankless' ? 3000 : 1500,
    operatingProperly
  };
}

// ============================================================================
// QUALITATIVE FACTORS
// ============================================================================

function analyzeQualitativeFactors(qualitativeData: any): QualitativeFactors {
  const layoutFlow = qualitativeData?.layout_flow || 75;
  const naturalLight = qualitativeData?.natural_light || 70;
  const ceilingHeight = qualitativeData?.ceiling_height || (qualitativeData?.ceiling_height_feet >= 9 ? 85 : 70);
  const storageSpace = qualitativeData?.storage_space || 70;
  const modernization = qualitativeData?.modernization || 65;
  const curbAppeal = qualitativeData?.curb_appeal || 70;
  
  const avgScore = (layoutFlow + naturalLight + ceilingHeight + storageSpace + modernization + curbAppeal) / 6;
  
  return {
    layoutFlow,
    naturalLight,
    ceilingHeight,
    storageSpace,
    modernization,
    curbAppeal,
    avgScore
  };
}

// ============================================================================
// DEFERRED MAINTENANCE
// ============================================================================

export function compileDeferredMaintenance(
  exterior: ExteriorScore,
  interior: InteriorScore,
  systems: SystemsScore,
  _propertyData: any
): DeferredMaintenanceItem[] {
  const items: DeferredMaintenanceItem[] = [];
  
  // Exterior items
  if (exterior.roof.urgency === 'immediate' || exterior.roof.score < 40) {
    items.push({
      category: 'Exterior',
      item: 'Roof Replacement',
      severity: exterior.roof.urgency === 'immediate' ? 'critical' : 'high',
      cost: exterior.roof.replacementCost,
      urgency: (exterior.roof.urgency === 'immediate' ? 'immediate' : '1-6 months') as 'immediate' | '1-6 months' | '6-12 months' | '1-2 years',
      impactOnValue: -exterior.roof.replacementCost * 0.8,
      impactOnRent: -50
    });
  }
  
  if (exterior.foundation.urgency === 'immediate' || exterior.foundation.score < 50) {
    items.push({
      category: 'Exterior',
      item: 'Foundation Repair',
      severity: 'critical',
      cost: exterior.foundation.replacementCost,
      urgency: 'immediate',
      impactOnValue: -exterior.foundation.replacementCost * 1.2,
      impactOnRent: -100
    });
  }
  
  if (exterior.siding.urgency === 'immediate' || exterior.siding.score < 50) {
    items.push({
      category: 'Exterior',
      item: 'Siding Replacement',
      severity: 'high',
      cost: exterior.siding.replacementCost,
      urgency: (exterior.siding.urgency === 'immediate' ? 'immediate' : '1-6 months') as 'immediate' | '1-6 months' | '6-12 months' | '1-2 years',
      impactOnValue: -exterior.siding.replacementCost * 0.7,
      impactOnRent: -30
    });
  }
  
  // Interior items
  if (interior.kitchen.renovationNeeded) {
    items.push({
      category: 'Interior',
      item: 'Kitchen Renovation',
      severity: interior.kitchen.score < 40 ? 'high' : 'medium',
      cost: interior.kitchen.estimatedRenovationCost,
      urgency: interior.kitchen.score < 40 ? '1-6 months' : '6-12 months',
      impactOnValue: -interior.kitchen.estimatedRenovationCost * 0.5,
      impactOnRent: -150
    });
  }
  
  if (interior.bathrooms.master.renovationNeeded) {
    items.push({
      category: 'Interior',
      item: 'Master Bathroom Renovation',
      severity: interior.bathrooms.master.score < 40 ? 'high' : 'medium',
      cost: interior.bathrooms.master.estimatedRenovationCost,
      urgency: interior.bathrooms.master.score < 40 ? '1-6 months' : '6-12 months',
      impactOnValue: -interior.bathrooms.master.estimatedRenovationCost * 0.6,
      impactOnRent: -75
    });
  }
  
  // Systems items
  if (systems.hvac.score < 50 || !systems.hvac.operatingProperly) {
    items.push({
      category: 'Systems',
      item: 'HVAC Replacement',
      severity: !systems.hvac.operatingProperly ? 'critical' : 'high',
      cost: systems.hvac.replacementCost,
      urgency: !systems.hvac.operatingProperly ? 'immediate' : '1-6 months',
      impactOnValue: -systems.hvac.replacementCost * 0.9,
      impactOnRent: -100
    });
  }
  
  if (systems.electrical.score < 60) {
    items.push({
      category: 'Systems',
      item: 'Electrical Panel Upgrade',
      severity: 'high',
      cost: systems.electrical.replacementCost,
      urgency: '1-6 months',
      impactOnValue: -systems.electrical.replacementCost * 0.8,
      impactOnRent: 0
    });
  }
  
  if (systems.plumbing.score < 50) {
    items.push({
      category: 'Systems',
      item: 'Plumbing Replacement',
      severity: 'high',
      cost: systems.plumbing.replacementCost,
      urgency: systems.plumbing.operatingProperly ? '6-12 months' : '1-6 months',
      impactOnValue: -systems.plumbing.replacementCost * 0.8,
      impactOnRent: -50
    });
  }
  
  if (systems.waterHeater.score < 40) {
    items.push({
      category: 'Systems',
      item: 'Water Heater Replacement',
      severity: 'medium',
      cost: systems.waterHeater.replacementCost,
      urgency: systems.waterHeater.operatingProperly ? '6-12 months' : 'immediate',
      impactOnValue: -systems.waterHeater.replacementCost * 0.5,
      impactOnRent: 0
    });
  }
  
  return items.sort((a, b) => {
    const urgencyOrder = { immediate: 0, '1-6 months': 1, '6-12 months': 2, '1-2 years': 3 };
    return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function calculateOverallScore(
  exterior: ExteriorScore,
  interior: InteriorScore,
  systems: SystemsScore,
  qualitative: QualitativeFactors
): number {
  return (
    exterior.overallScore * 0.25 +
    interior.overallScore * 0.40 +
    systems.overallScore * 0.25 +
    qualitative.avgScore * 0.10
  );
}

function scoreToGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  return 'D';
}

function scoreToCondition(score: number): 'excellent' | 'good' | 'average' | 'fair' | 'poor' {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 55) return 'average';
  if (score >= 40) return 'fair';
  return 'poor';
}

function determineMaterialQuality(data: any): 'luxury' | 'high' | 'mid' | 'builder' | 'low' {
  const quality = data?.material_quality || data?.quality;
  if (quality) return quality;
  
  const avgScore = data?.score || 70;
  if (avgScore >= 90) return 'luxury';
  if (avgScore >= 80) return 'high';
  if (avgScore >= 65) return 'mid';
  if (avgScore >= 50) return 'builder';
  return 'low';
}

function estimateKitchenRenovationCost(_kitchenData: any, materialQuality: string): number {
  const baseCosts: { [key: string]: number } = {
    luxury: 75000,
    high: 50000,
    mid: 35000,
    builder: 25000,
    low: 18000
  };
  
  return baseCosts[materialQuality] || 35000;
}

function calculateRenovationPotential(
  exterior: ExteriorScore,
  interior: InteriorScore,
  systems: SystemsScore
): number {
  // Higher score = more room for improvement
  const exteriorPotential = (100 - exterior.overallScore) / 100;
  const interiorPotential = (100 - interior.overallScore) / 100;
  const systemsPotential = (100 - systems.overallScore) / 100;
  
  return (exteriorPotential * 0.3 + interiorPotential * 0.5 + systemsPotential * 0.2);
}

export function getConditionMultiplier(grade: string): number {
  const multipliers: { [key: string]: number } = {
    'A+': 1.15,
    'A': 1.12,
    'A-': 1.10,
    'B+': 1.05,
    'B': 1.00,
    'B-': 0.97,
    'C+': 0.93,
    'C': 0.90,
    'C-': 0.85,
    'D': 0.75
  };
  
  return multipliers[grade] || 1.00;
}
