/**
 * Renovation ROI Calculation Engine
 * Calculates renovation-attributed value increase by subtracting natural appreciation
 * and validates against tax assessment changes
 */

import type {
  RenovationComparable,
  DetectedRenovation,
  PhotoComparisonResult,
  PropertyPriceTier,
  YearBuiltBracket,
  ConfidenceLevel
} from '../types/renovationROI';

// ============================================================================
// NATURAL APPRECIATION DATA
// ============================================================================

/**
 * Regional housing price index data (approximate annual appreciation rates)
 * In production, this would come from FRED API or Case-Shiller
 */
const REGIONAL_APPRECIATION_RATES: Record<string, Record<number, number>> = {
  // National average by year
  'NATIONAL': {
    2018: 5.2,
    2019: 4.1,
    2020: 7.5,
    2021: 18.8,
    2022: 10.2,
    2023: 5.8,
    2024: 4.5,
    2025: 3.8,
    2026: 3.5
  },
  // Can add state/metro specific rates
  'TX': {
    2018: 6.1, 2019: 4.8, 2020: 8.2, 2021: 20.5, 2022: 12.1, 2023: 4.2, 2024: 3.8, 2025: 4.1, 2026: 3.8
  },
  'CA': {
    2018: 5.5, 2019: 3.2, 2020: 9.1, 2021: 22.3, 2022: 8.5, 2023: 2.1, 2024: 4.8, 2025: 5.2, 2026: 4.5
  },
  'FL': {
    2018: 6.8, 2019: 5.2, 2020: 10.5, 2021: 25.1, 2022: 15.2, 2023: 6.5, 2024: 4.2, 2025: 3.5, 2026: 3.2
  },
  'AZ': {
    2018: 7.2, 2019: 6.5, 2020: 12.1, 2021: 28.5, 2022: 18.2, 2023: -2.5, 2024: 2.8, 2025: 4.5, 2026: 4.2
  }
};

/**
 * Get cumulative appreciation between two dates for a region
 */
export function getCumulativeAppreciation(
  startDate: Date,
  endDate: Date,
  state?: string
): number {
  const rates = REGIONAL_APPRECIATION_RATES[state || 'NATIONAL'] || REGIONAL_APPRECIATION_RATES['NATIONAL'];
  
  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();
  
  let cumulativeRate = 1.0;
  
  for (let year = startYear; year <= endYear; year++) {
    const annualRate = rates[year] || 4.0; // Default 4% if no data
    
    // Handle partial years
    let yearFraction = 1.0;
    if (startYear === endYear) {
      // Same year: fraction is just the months between the two dates
      yearFraction = (endDate.getMonth() - startDate.getMonth() + 1) / 12;
    } else if (year === startYear) {
      yearFraction = (12 - startDate.getMonth()) / 12;
    } else if (year === endYear) {
      yearFraction = (endDate.getMonth() + 1) / 12;
    }
    
    cumulativeRate *= (1 + (annualRate / 100) * yearFraction);
  }
  
  return (cumulativeRate - 1) * 100; // Return as percentage
}

/**
 * Calculate natural appreciation amount
 */
export function calculateNaturalAppreciation(
  beforePrice: number,
  beforeDate: Date,
  afterDate: Date,
  state?: string
): { amount: number; percent: number } {
  const appreciationPercent = getCumulativeAppreciation(beforeDate, afterDate, state);
  const amount = beforePrice * (appreciationPercent / 100);
  
  return {
    amount: Math.round(amount),
    percent: Math.round(appreciationPercent * 100) / 100
  };
}

// ============================================================================
// PRICE TIER & YEAR BRACKET HELPERS
// ============================================================================

export function getPriceTier(price: number): PropertyPriceTier {
  if (price < 200000) return 'under_200k';
  if (price < 350000) return '200k_350k';
  if (price < 500000) return '350k_500k';
  if (price < 750000) return '500k_750k';
  if (price < 1000000) return '750k_1m';
  return 'over_1m';
}

export function getYearBuiltBracket(yearBuilt: number): YearBuiltBracket {
  if (yearBuilt < 1950) return 'pre_1950';
  if (yearBuilt < 1970) return '1950_1970';
  if (yearBuilt < 1990) return '1970_1990';
  if (yearBuilt < 2005) return '1990_2005';
  if (yearBuilt < 2015) return '2005_2015';
  return 'post_2015';
}

export function normalizePropertyType(type: string): 'SFH' | 'CONDO' | 'TOWNHOUSE' | 'MULTI' | 'OTHER' {
  const normalized = (type || '').toUpperCase();
  
  if (normalized.includes('SINGLE') || normalized.includes('SFR') || normalized.includes('DETACH')) {
    return 'SFH';
  }
  if (normalized.includes('CONDO')) return 'CONDO';
  if (normalized.includes('TOWN') || normalized.includes('ROW')) return 'TOWNHOUSE';
  if (normalized.includes('MULTI') || normalized.includes('DUPLEX') || normalized.includes('TRIPLEX')) {
    return 'MULTI';
  }
  return 'OTHER';
}

// ============================================================================
// RENOVATION ROI CALCULATION
// ============================================================================

export interface RenovationROICalculation {
  // Price data
  beforePrice: number;
  afterPrice: number;
  rawPriceIncrease: number;
  rawPriceIncreasePercent: number;
  
  // Natural appreciation adjustment
  naturalAppreciation: number;
  naturalAppreciationPercent: number;
  
  // Renovation-attributed value
  renovationAttributedValue: number;
  renovationAttributedPercent: number;
  
  // ROI calculation
  totalRenovationCost: number;
  valueROI: number;              // (renovation value / cost) * 100
  
  // Rent impact (if available)
  rentIncrease?: number;
  rentROI?: number;              // (rent increase * 12 / cost) * 100
  paybackMonths?: number;
  
  // Tax validation
  taxDelta?: number;
  taxValidation: 'validated' | 'partial' | 'unvalidated' | 'mismatch';
  
  // Confidence
  confidence: ConfidenceLevel;
  confidenceScore: number;
  flags: string[];
}

/**
 * Calculate renovation ROI for a property transaction pair
 */
export function calculateRenovationROI(
  beforePrice: number,
  afterPrice: number,
  beforeDate: Date,
  afterDate: Date,
  renovations: DetectedRenovation[],
  state?: string,
  beforeTaxAssessment?: number,
  afterTaxAssessment?: number,
  beforeRent?: number,
  afterRent?: number
): RenovationROICalculation {
  
  const flags: string[] = [];
  
  // Raw price increase
  const rawPriceIncrease = afterPrice - beforePrice;
  const rawPriceIncreasePercent = (rawPriceIncrease / beforePrice) * 100;
  
  // Natural appreciation
  const appreciation = calculateNaturalAppreciation(beforePrice, beforeDate, afterDate, state);
  
  // Renovation-attributed value (what's left after natural appreciation)
  let renovationAttributedValue = rawPriceIncrease - appreciation.amount;
  
  // Handle edge cases
  if (renovationAttributedValue < 0) {
    flags.push('Renovation value negative - property may have declined or sold below market');
    renovationAttributedValue = Math.max(0, renovationAttributedValue);
  }
  
  const renovationAttributedPercent = (renovationAttributedValue / beforePrice) * 100;
  
  // Calculate total renovation cost
  const totalRenovationCost = renovations.reduce((sum, reno) => sum + (reno.estimatedCost || 0), 0);
  
  if (totalRenovationCost === 0) {
    flags.push('No renovation cost data - ROI cannot be calculated');
  }
  
  // Value ROI
  const valueROI = totalRenovationCost > 0 
    ? (renovationAttributedValue / totalRenovationCost) * 100 
    : 0;
  
  // Check for outlier ROI
  if (valueROI > 500) {
    flags.push('Unusually high ROI - may indicate underestimated renovation cost or market anomaly');
  }
  if (valueROI < 50 && totalRenovationCost > 10000) {
    flags.push('Low ROI - renovations may have been over-improved for the area');
  }
  
  // Rent impact
  let rentIncrease: number | undefined;
  let rentROI: number | undefined;
  let paybackMonths: number | undefined;
  
  if (beforeRent && afterRent) {
    rentIncrease = afterRent - beforeRent;
    rentROI = totalRenovationCost > 0 
      ? ((rentIncrease * 12) / totalRenovationCost) * 100 
      : 0;
    paybackMonths = rentIncrease > 0 
      ? Math.ceil(totalRenovationCost / rentIncrease) 
      : 999;
  }
  
  // Tax validation
  let taxDelta: number | undefined;
  let taxValidation: 'validated' | 'partial' | 'unvalidated' | 'mismatch' = 'unvalidated';
  
  if (beforeTaxAssessment && afterTaxAssessment) {
    taxDelta = afterTaxAssessment - beforeTaxAssessment;
    
    // Tax assessments typically lag market by 70-90%
    const expectedTaxDelta = renovationAttributedValue * 0.8;
    const taxRatio = taxDelta / expectedTaxDelta;
    
    if (taxRatio >= 0.6 && taxRatio <= 1.5) {
      taxValidation = 'validated';
    } else if (taxRatio >= 0.3 && taxRatio <= 2.0) {
      taxValidation = 'partial';
      flags.push('Tax assessment partially aligns with renovation value');
    } else {
      taxValidation = 'mismatch';
      flags.push('Tax assessment does not align with renovation value');
    }
  }
  
  // Calculate confidence
  const { confidence, confidenceScore } = calculateConfidence(
    renovations,
    rawPriceIncreasePercent,
    valueROI,
    taxValidation,
    flags
  );
  
  return {
    beforePrice,
    afterPrice,
    rawPriceIncrease,
    rawPriceIncreasePercent: Math.round(rawPriceIncreasePercent * 100) / 100,
    naturalAppreciation: appreciation.amount,
    naturalAppreciationPercent: appreciation.percent,
    renovationAttributedValue: Math.round(renovationAttributedValue),
    renovationAttributedPercent: Math.round(renovationAttributedPercent * 100) / 100,
    totalRenovationCost,
    valueROI: Math.round(valueROI * 100) / 100,
    rentIncrease,
    rentROI: rentROI ? Math.round(rentROI * 100) / 100 : undefined,
    paybackMonths,
    taxDelta,
    taxValidation,
    confidence,
    confidenceScore,
    flags
  };
}

/**
 * Calculate confidence score based on data quality
 */
function calculateConfidence(
  renovations: DetectedRenovation[],
  priceIncreasePercent: number,
  valueROI: number,
  taxValidation: string,
  flags: string[]
): { confidence: ConfidenceLevel; confidenceScore: number } {
  
  let score = 50; // Base score
  
  // Renovation detection confidence
  const avgRenoConfidence = renovations.length > 0
    ? renovations.reduce((sum, r) => sum + r.confidence, 0) / renovations.length
    : 0;
  score += avgRenoConfidence * 20; // Up to +20
  
  // Multiple renovations detected increases confidence
  if (renovations.length >= 2) score += 5;
  if (renovations.length >= 4) score += 5;
  
  // Reasonable price increase (not too extreme)
  if (priceIncreasePercent >= 5 && priceIncreasePercent <= 50) {
    score += 10;
  } else if (priceIncreasePercent > 80) {
    score -= 10;
  }
  
  // Reasonable ROI (not extreme)
  if (valueROI >= 80 && valueROI <= 300) {
    score += 10;
  } else if (valueROI > 400 || valueROI < 30) {
    score -= 10;
  }
  
  // Tax validation bonus
  if (taxValidation === 'validated') score += 15;
  else if (taxValidation === 'partial') score += 5;
  else if (taxValidation === 'mismatch') score -= 10;
  
  // Penalty for flags
  score -= flags.length * 3;
  
  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));
  
  let confidence: ConfidenceLevel;
  if (score >= 75) confidence = 'high';
  else if (score >= 45) confidence = 'medium';
  else confidence = 'low';
  
  return { confidence, confidenceScore: Math.round(score) };
}

// ============================================================================
// CREATE RENOVATION COMPARABLE
// ============================================================================

/**
 * Create a complete renovation comparable from raw data
 */
export function createRenovationComparable(
  propertyData: {
    address: string;
    city: string;
    state: string;
    zipCode: string;
    county?: string;
    propertyType: string;
    beds: number;
    baths: number;
    sqft: number;
    yearBuilt: number;
  },
  beforeData: {
    listingKey: string;
    listDate: Date;
    saleDate: Date;
    listPrice: number;
    salePrice: number;
    photoUrls: string[];
    taxAssessment?: number;
    daysOnMarket?: number;
  },
  afterData: {
    listingKey: string;
    listDate: Date;
    saleDate: Date;
    listPrice: number;
    salePrice: number;
    photoUrls: string[];
    taxAssessment?: number;
    daysOnMarket?: number;
  },
  photoComparison: PhotoComparisonResult,
  rentBefore?: number,
  rentAfter?: number
): RenovationComparable {
  
  // Calculate ROI
  const roiCalc = calculateRenovationROI(
    beforeData.salePrice,
    afterData.salePrice,
    beforeData.saleDate,
    afterData.saleDate,
    photoComparison.renovationsDetected,
    propertyData.state,
    beforeData.taxAssessment,
    afterData.taxAssessment,
    rentBefore,
    rentAfter
  );
  
  // Calculate holding period
  const holdingPeriodMonths = Math.round(
    (afterData.saleDate.getTime() - beforeData.saleDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
  );
  
  // Determine data quality
  let dataQuality: 'verified' | 'estimated' | 'low_confidence' = 'estimated';
  if (roiCalc.confidenceScore >= 75 && roiCalc.taxValidation === 'validated') {
    dataQuality = 'verified';
  } else if (roiCalc.confidenceScore < 45) {
    dataQuality = 'low_confidence';
  }
  
  const id = `${propertyData.zipCode}_${beforeData.listingKey}_${afterData.listingKey}`;
  
  return {
    id,
    address: propertyData.address,
    city: propertyData.city,
    state: propertyData.state,
    zipCode: propertyData.zipCode,
    county: propertyData.county,
    propertyType: normalizePropertyType(propertyData.propertyType),
    priceTier: getPriceTier(beforeData.salePrice),
    yearBuilt: propertyData.yearBuilt,
    yearBuiltBracket: getYearBuiltBracket(propertyData.yearBuilt),
    sqft: propertyData.sqft,
    beds: propertyData.beds,
    baths: propertyData.baths,
    before: {
      listingKey: beforeData.listingKey,
      listingDate: beforeData.listDate,
      listPrice: beforeData.listPrice,
      salePrice: beforeData.salePrice,
      saleDate: beforeData.saleDate,
      photoUrls: beforeData.photoUrls,
      taxAssessment: beforeData.taxAssessment,
      daysOnMarket: beforeData.daysOnMarket
    },
    after: {
      listingKey: afterData.listingKey,
      listingDate: afterData.listDate,
      listPrice: afterData.listPrice,
      salePrice: afterData.salePrice,
      saleDate: afterData.saleDate,
      photoUrls: afterData.photoUrls,
      taxAssessment: afterData.taxAssessment,
      daysOnMarket: afterData.daysOnMarket
    },
    renovationsDetected: photoComparison.renovationsDetected,
    holdingPeriodMonths,
    rawPriceIncrease: roiCalc.rawPriceIncrease,
    rawPriceIncreasePercent: roiCalc.rawPriceIncreasePercent,
    naturalAppreciation: roiCalc.naturalAppreciation,
    naturalAppreciationPercent: roiCalc.naturalAppreciationPercent,
    renovationAttributedValue: roiCalc.renovationAttributedValue,
    renovationAttributedPercent: roiCalc.renovationAttributedPercent,
    totalEstimatedRenoCost: roiCalc.totalRenovationCost,
    valueROI: roiCalc.valueROI,
    taxAssessmentDelta: roiCalc.taxDelta,
    taxValidated: roiCalc.taxValidation === 'validated',
    rentBefore,
    rentAfter,
    rentIncrease: roiCalc.rentIncrease,
    rentIncreasePercent: roiCalc.rentIncrease && rentBefore 
      ? (roiCalc.rentIncrease / rentBefore) * 100 
      : undefined,
    rentROI: roiCalc.rentROI,
    dataQuality,
    flags: roiCalc.flags,
    createdAt: new Date(),
    updatedAt: new Date(),
    processedBy: 'auto'
  };
}

// ============================================================================
// TIME-WEIGHTED RECENCY
// ============================================================================

/**
 * Calculate recency weight for a comparable
 * More recent data is weighted more heavily
 */
export function calculateRecencyWeight(saleDate: Date): number {
  const now = new Date();
  const yearsAgo = (now.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24 * 365);
  
  // Exponential decay: weight = e^(-0.3 * years)
  // 1 year ago: 0.74
  // 2 years ago: 0.55
  // 3 years ago: 0.41
  // 5 years ago: 0.22
  return Math.exp(-0.3 * yearsAgo);
}

/**
 * Calculate weighted average ROI from multiple comparables
 */
export function calculateWeightedROI(
  comparables: RenovationComparable[],
  renovationType: string
): { avgROI: number; weightedAvgROI: number; sampleSize: number } {
  
  // Filter comparables that have the specified renovation type
  const relevant = comparables.filter(comp => 
    comp.renovationsDetected.some(r => r.category === renovationType)
  );
  
  if (relevant.length === 0) {
    return { avgROI: 0, weightedAvgROI: 0, sampleSize: 0 };
  }
  
  // Calculate simple average
  const avgROI = relevant.reduce((sum, c) => sum + c.valueROI, 0) / relevant.length;
  
  // Calculate time-weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  
  for (const comp of relevant) {
    const weight = calculateRecencyWeight(comp.after.saleDate);
    weightedSum += comp.valueROI * weight;
    totalWeight += weight;
  }
  
  const weightedAvgROI = totalWeight > 0 ? weightedSum / totalWeight : 0;
  
  return {
    avgROI: Math.round(avgROI * 100) / 100,
    weightedAvgROI: Math.round(weightedAvgROI * 100) / 100,
    sampleSize: relevant.length
  };
}
