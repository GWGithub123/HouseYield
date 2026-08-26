export type VisualFindingSeverity = 'minor' | 'moderate' | 'major' | 'critical';

export type VisualFindingSupport =
  | 'observed'
  | 'partially_visible'
  | 'unclear'
  | 'not_visible'
  | 'likely_but_unconfirmed';

export type RenovationScopeType =
  | 'cosmetic_refresh'
  | 'full_remodel'
  | 'repair'
  | 'replacement'
  | 'deferred_maintenance'
  | 'value_add_upgrade'
  | 'further_review';

export type RenovationPriority = 'critical' | 'high' | 'medium' | 'low';

export type RenovationMarketFit = 'poor' | 'neutral' | 'good' | 'excellent' | 'unknown';

export interface CanonicalSourceReference {
  source: string;
  reference: string;
  note?: string;
}

export interface CanonicalPropertyProfile {
  address: string;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  yearBuilt: number | null;
  beds: number | null;
  baths: number | null;
  livingSqft: number | null;
  propertyType: string | null;
  rawAttomFacts: Record<string, unknown> | null;
  livingAreaContext: {
    sqft: number | null;
    source: string;
  };
  lotContext: {
    acres: number | null;
    sqft: number | null;
    source: string;
  };
  ageContext: {
    actualAge: number | null;
    effectiveAge: number | null;
    source: string;
  };
  hazardContext: {
    flood: number | null;
    fire: number | null;
    earthquake: number | null;
    source: string;
  };
  taxContext: {
    assessedValue: number | null;
    latestTaxAmount: number | null;
    taxHistoryYears: number;
    source: string;
  };
  avmContext: {
    avmValue: number | null;
    avmLow: number | null;
    avmHigh: number | null;
    source: string;
  };
  marketContextReferences: CanonicalSourceReference[];
  existingRentBaselineReferences: CanonicalSourceReference[];
}

export interface VisualFindingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'normalized';
}

export interface VisualFinding {
  findingId: string;
  photoIndex: number | null;
  roomType: string;
  category: string;
  subcategory: string;
  severity: VisualFindingSeverity;
  confidence: number;
  visibleOnly: true;
  support: VisualFindingSupport;
  requiresHumanVerification: boolean;
  bbox: VisualFindingRegion | null;
  description: string;
  normalizedTags: string[];
  evidenceText: string;
}

export interface MeasuredDimensions {
  width: number | null;
  length: number | null;
  height: number | null;
  depth: number | null;
  area: number | null;
  unit: 'feet' | 'inches' | 'meters' | 'square_feet' | 'mixed' | 'unknown';
}

export interface MeasurementUncertainty {
  percent: number | null;
  notes: string[];
}

export interface MeasuredElement {
  measuredElementId: string;
  photoIndexes: number[];
  roomType: string;
  elementType: string;
  dimensions: MeasuredDimensions;
  method: string;
  calibrationSource: string | null;
  uncertainty: MeasurementUncertainty;
  confidence: number;
}

export interface RenovationOpportunity {
  opportunityId: string;
  roomType: string;
  category: string;
  scopeType: RenovationScopeType;
  triggerFindings: string[];
  measuredElements: string[];
  problemStatement: string;
  suggestedIntervention: string;
  marketFit: RenovationMarketFit;
  priority: RenovationPriority;
  confidence: number;
}

export interface CostEstimate {
  estimateId: string;
  opportunityId: string;
  totalCostLow: number;
  totalCostHigh: number;
  lineItems: Array<{
    category: string;
    label: string;
    quantity: number | null;
    unit: string;
    costLow: number;
    costHigh: number;
  }>;
  assumptions: string[];
  confidence: number;
}

export interface RentUpliftEstimate {
  estimateId: string;
  opportunityId: string;
  asIsRent: number | null;
  renovatedRent: number | null;
  monthlyDelta: number | null;
  annualDelta: number | null;
  assumptions: string[];
  confidence: number;
}

export interface ValueUpliftEstimate {
  estimateId: string;
  opportunityId: string;
  asIsValue: number | null;
  renovatedValue: number | null;
  upliftAmount: number | null;
  appreciationAdjustedUplift: number | null;
  assumptions: string[];
  confidence: number;
}

export interface RenovationROIResult {
  resultId: string;
  opportunityId: string;
  costEstimateId: string;
  rentUpliftEstimateId: string | null;
  valueUpliftEstimateId: string | null;
  rentOnlyRoi: number | null;
  valueOnlyRoi: number | null;
  blendedFiveYearRoi: number | null;
  paybackMonths: number | null;
  confidenceAdjustedRoi: number | null;
  recommendation: 'recommend' | 'recommend_with_verification' | 'borderline' | 'not_recommended';
  assumptions: string[];
  confidence: number;
}

export interface CanonicalVisualEvidenceRoomSummary {
  roomType: string;
  photoIndexes: number[];
  categoriesObserved: string[];
  requiresHumanVerification: boolean;
  confidence: number;
}

export interface CanonicalVisualEvidence {
  findings: VisualFinding[];
  opportunities: RenovationOpportunity[];
  roomSummaries: CanonicalVisualEvidenceRoomSummary[];
  summary: {
    photoCount: number;
    findingCount: number;
    opportunityCount: number;
    uncertainFindingCount: number;
    requiresHumanVerification: boolean;
    status: 'complete' | 'partial' | 'unavailable';
    notes: string[];
  };
}