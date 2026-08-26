/**
 * Renovation ROI System Types
 * Data-driven renovation value analysis using historical MLS photo comparisons
 */

// ============================================================================
// RENOVATION DETECTION (from Visual AI photo comparison)
// ============================================================================

export type RenovationCategory = 
  | 'kitchen'
  | 'kitchen_full'
  | 'kitchen_cosmetic'
  | 'bathroom_master'
  | 'bathroom_secondary'
  | 'bathroom_full'
  | 'bathroom_cosmetic'
  | 'flooring'
  | 'paint_interior'
  | 'paint_exterior'
  | 'roof'
  | 'windows'
  | 'doors'
  | 'siding'
  | 'landscaping'
  | 'driveway'
  | 'hvac'
  | 'electrical'
  | 'plumbing'
  | 'basement'
  | 'basement_finish'
  | 'attic'
  | 'garage'
  | 'deck_patio'
  | 'pool'
  | 'addition'
  | 'solar'
  | 'smart_home'
  | 'accessibility'
  | 'other';

/**
 * Normalize variant renovation categories to their canonical form.
 * GPT-4o Vision returns 'kitchen' while the analyzer returns 'kitchen_full'/'kitchen_cosmetic'.
 * This maps both directions so lookups always find matches.
 */
export const CATEGORY_ALIASES: Record<string, RenovationCategory[]> = {
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

export type RenovationScope = 
  | 'cosmetic'      // Paint, hardware, light fixtures ($2k-$10k)
  | 'refresh'       // Counters, backsplash, appliances ($10k-$25k)
  | 'full_remodel'  // Cabinets, layout changes ($25k-$75k)
  | 'gut_reno';     // Down to studs ($75k+)

export type PropertyPriceTier = 
  | 'under_200k'
  | '200k_350k'
  | '350k_500k'
  | '500k_750k'
  | '750k_1m'
  | 'over_1m';

export type YearBuiltBracket = 
  | 'pre_1950'
  | '1950_1970'
  | '1970_1990'
  | '1990_2005'
  | '2005_2015'
  | 'post_2015';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * A single detected renovation from photo comparison
 */
export interface DetectedRenovation {
  category: RenovationCategory;
  scope: RenovationScope;
  description: string;          // "Updated quartz countertops, new backsplash, stainless appliances"
  confidence: number;           // 0-1, how confident the AI is about this detection
  estimatedCost: number;        // AI-estimated cost based on scope
  costRange: {
    low: number;
    high: number;
  };
  beforeDescription?: string;   // "Laminate counters, white appliances, dated cabinets"
  afterDescription?: string;    // "Quartz counters, stainless appliances, painted cabinets"
  qualityLevel: 'budget' | 'mid_grade' | 'high_end' | 'luxury';
}

/**
 * Result of comparing before/after photos for a property
 */
export interface PhotoComparisonResult {
  propertyId: string;
  beforeListingKey: string;
  afterListingKey: string;
  beforePhotos: string[];       // URLs analyzed
  afterPhotos: string[];        // URLs analyzed
  renovationsDetected: DetectedRenovation[];
  totalEstimatedCost: number;
  overallConfidence: number;
  analysisTimestamp: Date;
  rawAIResponse?: string;       // For debugging
}

// ============================================================================
// RENOVATION COMPARABLE (stored in Firestore)
// ============================================================================

/**
 * A single renovation comparable - one property that was renovated between sales
 */
export interface RenovationComparable {
  id: string;                   // Firestore document ID
  
  // Property identification
  address: string;
  city: string;
  state: string;
  zipCode: string;
  county?: string;
  
  // Property characteristics (for stratification)
  propertyType: 'SFH' | 'CONDO' | 'TOWNHOUSE' | 'MULTI' | 'OTHER';
  priceTier: PropertyPriceTier;
  yearBuilt: number;
  yearBuiltBracket: YearBuiltBracket;
  sqft: number;
  beds: number;
  baths: number;
  
  // Before state (older listing)
  before: {
    listingKey: string;
    listingDate: Date;
    listPrice: number;
    salePrice: number;
    saleDate: Date;
    photoUrls: string[];
    taxAssessment?: number;
    daysOnMarket?: number;
  };
  
  // After state (newer listing)
  after: {
    listingKey: string;
    listingDate: Date;
    listPrice: number;
    salePrice: number;
    saleDate: Date;
    photoUrls: string[];
    taxAssessment?: number;
    daysOnMarket?: number;
  };
  
  // Detected renovations (from Visual AI)
  renovationsDetected: DetectedRenovation[];
  
  // Calculated metrics
  holdingPeriodMonths: number;
  rawPriceIncrease: number;           // After sale - Before sale
  rawPriceIncreasePercent: number;
  naturalAppreciation: number;         // Market appreciation over period
  naturalAppreciationPercent: number;
  renovationAttributedValue: number;   // Raw - Natural
  renovationAttributedPercent: number;
  totalEstimatedRenoCost: number;      // Sum of detected renovation costs
  valueROI: number;                    // renovationAttributedValue / totalEstimatedRenoCost
  
  // Tax validation
  taxAssessmentDelta?: number;
  taxValidated: boolean;               // If tax delta aligns with value delta
  
  // Rent impact (if rental data available)
  rentBefore?: number;
  rentAfter?: number;
  rentIncrease?: number;
  rentIncreasePercent?: number;
  rentROI?: number;                    // (rentIncrease * 12) / totalEstimatedRenoCost
  
  // Quality flags
  dataQuality: 'verified' | 'estimated' | 'low_confidence';
  flags: string[];                     // Any warnings or notes
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  processedBy: 'auto' | 'manual';
}

// ============================================================================
// AREA RENOVATION ROI STATS (aggregated, stored in Firestore)
// ============================================================================

/**
 * Aggregated renovation ROI statistics for a specific area + renovation type
 */
export interface AreaRenovationROI {
  id: string;                   // Format: "{zipCode}_{renovationType}_{scope}_{priceTier}"
  
  // Location
  zipCode: string;
  city: string;
  state: string;
  county?: string;
  
  // Renovation specification
  renovationType: RenovationCategory;
  scope: RenovationScope;
  
  // Filters applied (for stratification)
  filters: {
    propertyTypes: string[];    // Which property types included
    priceTiers: PropertyPriceTier[];
    yearBuiltRange?: [number, number];
  };
  
  // Sample information
  sampleSize: number;
  comparableIds: string[];      // References to RenovationComparable docs
  
  // Cost statistics
  avgCost: number;
  medianCost: number;
  costRange: { low: number; high: number };
  
  // Value increase statistics
  avgValueIncrease: number;
  medianValueIncrease: number;
  valueIncreaseRange: { low: number; high: number };
  
  // ROI statistics (primary metrics)
  avgValueROI: number;          // Avg (value increase / cost) * 100
  medianValueROI: number;
  valueROIRange: { low: number; high: number };
  stdDeviation: number;
  
  // Rent impact statistics
  avgRentIncrease: number;      // Monthly $
  medianRentIncrease: number;
  avgRentROI: number;           // (rent increase * 12) / cost * 100
  avgPaybackMonths: number;     // cost / monthly rent increase
  
  // Confidence scoring
  confidenceLevel: ConfidenceLevel;
  confidenceScore: number;      // 0-100
  
  // Trend tracking (for market timing signals)
  historicalROI: Array<{
    year: number;
    avgROI: number;
    sampleSize: number;
  }>;
  roiTrend: 'increasing' | 'stable' | 'decreasing';
  roiTrendPercent: number;      // YoY change
  
  // Timestamps
  lastUpdated: Date;
  dataFreshness: 'fresh' | 'stale'; // Stale if > 90 days old
}

/**
 * Summary of all renovation ROI data for an area
 */
export interface AreaRenovationSummary {
  zipCode: string;
  city: string;
  state: string;
  
  // Best renovations ranked by ROI (v2: enriched with uplift-isolated data)
  bestROIRenovations: Array<{
    renovationType: RenovationCategory;
    scope: RenovationScope;
    avgROI: number;
    avgValueUplift: number;     // Average $ value increase attributed to this renovation
    avgRentIncrease: number;    // Average $/month rent increase
    avgCost: number;            // Average cost from comps
    medianROI: number;          // Median ROI (less sensitive to outliers)
    sampleSize: number;
    confidenceLevel: ConfidenceLevel;
    paybackMonths: number;      // Average months for rent to pay back cost
    roiTrend: 'rising' | 'stable' | 'falling'; // Recent trend direction
    // Stratification breakdowns
    stratification?: {
      byPriceTier?: Record<string, { avgROI: number; sampleSize: number }>;
      byPropertyType?: Record<string, { avgROI: number; sampleSize: number }>;
      byYearBuilt?: Record<string, { avgROI: number; sampleSize: number }>;
    };
  }>;
  
  // Market timing signals
  marketSignals: {
    overallHealth: 'strong' | 'moderate' | 'weak';
    saturatedRenovations: RenovationCategory[];  // ROI declining
    highOpportunityRenovations: RenovationCategory[];  // ROI increasing
    warnings: string[];
  };
  
  // Rental analysis (v2)
  rentalAnalysis?: {
    available: boolean;
    sampleSize: number;
    avgRentIncrease: number;
    medianRentIncrease: number;
    byRenovationType?: Record<string, { avgRentIncrease: number; sampleSize: number }>;
  };
  
  // Totals
  totalComparables: number;
  lastUpdated: Date;
}

// ============================================================================
// RENOVATION RECOMMENDATION (output for property analysis)
// ============================================================================

/**
 * A renovation recommendation with area-specific ROI data
 */
export interface RenovationRecommendation {
  renovationType: RenovationCategory;
  scope: RenovationScope;
  description: string;
  
  // Cost estimates
  estimatedCost: number;
  costRange: { low: number; high: number };
  costSource: 'area_data' | 'national_estimate' | 'ai_estimate';
  
  // Value impact (from area ROI data)
  expectedValueIncrease: number;
  valueIncreaseRange: { low: number; high: number };
  expectedValueROI: number;     // (value increase / cost) * 100
  
  // Rent impact
  expectedRentIncrease: number; // Monthly $
  expectedRentROI: number;      // (rent * 12) / cost * 100
  paybackMonths: number;
  
  // Confidence
  confidenceLevel: ConfidenceLevel;
  sampleSize: number;           // How many comparables this is based on
  
  // Ranking
  ranking: 'highly_recommended' | 'recommended' | 'marginal' | 'not_recommended';
  rankScore: number;            // For sorting
  
  // Supporting data
  comparableCount: number;
  exampleComparables?: Array<{
    address: string;
    beforePhotoUrl: string;
    afterPhotoUrl: string;
    valueIncrease: number;
    roi: number;
  }>;
  
  // Market timing
  roiTrend: 'increasing' | 'stable' | 'decreasing';
  marketWarning?: string;       // "ROI declining, market may be saturated"
}

/**
 * Complete renovation analysis for a property
 */
export interface PropertyRenovationAnalysis {
  propertyAddress: string;
  zipCode: string;
  analyzedAt: Date;
  
  // Detected renovation needs (from Visual AI on property photos)
  detectedNeeds: DetectedRenovation[];
  
  // Recommendations with area-specific ROI
  recommendations: RenovationRecommendation[];
  
  // Summary metrics
  totalRecommendedCost: number;
  totalExpectedValueGain: number;
  totalExpectedRentGain: number;  // Monthly
  overallROI: number;
  overallPaybackMonths: number;
  
  // Data quality
  areaDataAvailable: boolean;
  areaDataConfidence: ConfidenceLevel;
  areaComparableCount: number;
  
  // Wedge potential
  createsWedge: boolean;
  wedgeType?: 'value_add' | 'cash_flow_turnaround' | 'brrrr_candidate';
  wedgeDescription?: string;
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

export interface FindRenovationCandidatesRequest {
  city?: string;
  state?: string;
  zipCode?: string;
  minListings?: number;         // Minimum listings per property (default 2)
  minPriceIncrease?: number;    // Minimum price increase to filter noise
  limit?: number;
}

export interface FindRenovationCandidatesResponse {
  ok: boolean;
  data: Array<{
    address: string;
    city: string;
    state: string;
    zipCode: string;
    listingCount: number;
    listings: Array<{
      listingKey: string;
      listDate: Date;
      listPrice: number;
      salePrice?: number;
      saleDate?: Date;
      photoCount: number;
    }>;
    priceChange: number;
    priceChangePercent: number;
  }>;
  count: number;
}

export interface ProcessRenovationComparableRequest {
  beforeListingKey: string;
  afterListingKey: string;
}

export interface GetAreaRenovationROIRequest {
  zipCode: string;
  renovationType?: RenovationCategory;
  scope?: RenovationScope;
  propertyType?: string;
  priceTier?: PropertyPriceTier;
}

export interface GetAreaRenovationROIResponse {
  ok: boolean;
  data: AreaRenovationROI | AreaRenovationSummary;
  comparablesAvailable: number;
}

// ============================================================================
// SNOWFLAKE MLS TYPES (matching actual column names)
// ============================================================================

export interface SnowflakeMLSProperty {
  LISTINGKEY: string;
  LISTINGID?: string;
  LISTPRICE: number;
  ORIGINALLISTPRICE?: number;
  CLOSEPRICE?: number;
  CLOSEDATE?: string;
  STREETNUMBER?: string;
  STREETNAME?: string;
  STREETSUFFIX?: string;
  UNPARSEDADDRESS?: string;
  CITY: string;
  STATEORPROVINCE: string;
  POSTALCODE: string;
  COUNTYORPARISH?: string;
  BEDROOMSTOTAL?: number;
  BATHROOMSTOTALINTEGER?: number;
  LIVINGAREA?: number;
  YEARBUILT?: number;
  PROPERTYTYPE?: string;
  PROPERTYSUBTYPE?: string;
  STANDARDSTATUS: string;
  ONMARKETDATE?: string;
  OFFMARKETDATE?: string;
  DAYSONMARKET?: number;
  MODIFICATIONTIMESTAMP?: string;
  PHOTOSCOUNT?: number;
  LATITUDE?: number;
  LONGITUDE?: number;
  PUBLICREMARKS?: string;
}

export interface SnowflakeMLSMedia {
  MEDIAKEY?: string;
  LISTINGKEY: string;
  MEDIAURL: string;
  MEDIACATEGORY?: string;
  PREFERREDPHOTOYN?: boolean;
  order?: number;
  IMAGEWIDTH?: number;
  IMAGEHEIGHT?: number;
  LONGDESCRIPTION?: string;
  SHORTDESCRIPTION?: string;
  MEDIAMODIFICATIONTIMESTAMP?: string;
}

export interface PropertyWithHistory {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  listings: Array<{
    listingKey: string;
    listDate: Date | null;
    saleDate: Date | null;
    listPrice: number;
    salePrice: number | null;
    status: string;
    photos: SnowflakeMLSMedia[];
  }>;
}
