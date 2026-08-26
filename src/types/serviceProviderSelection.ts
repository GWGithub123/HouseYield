/**
 * AI Service Provider Selection Types
 * Type definitions for the smart repair service provider selection system
 */

// ============================================================================
// SERVICE CATEGORY TYPES
// ============================================================================

export type ServiceCategory =
  | 'plumbing'
  | 'electrical'
  | 'hvac'
  | 'roofing'
  | 'pest'
  | 'appliance'
  | 'locksmith'
  | 'window'
  | 'general'
  | 'flooring'
  | 'painting'
  | 'landscaping'
  | 'garage'
  | 'pool'
  | 'septic'
  | 'foundation'
  | 'waterproofing'
  | 'mold'
  | 'chimney'
  | 'gutter';

export type UrgencyLevel = 'emergency' | 'high' | 'medium' | 'low';

export type RecommendationLevel = 
  | 'highly_recommended' 
  | 'recommended' 
  | 'acceptable' 
  | 'not_recommended';

// ============================================================================
// PROVIDER TYPES
// ============================================================================

export interface ProviderReview {
  author: string;
  rating: number;
  text: string;
  time: number;
  relativeTime: string;
}

export interface ProviderBasicInfo {
  placeId: string;
  name: string;
  address: string;
  rating: number;
  reviewCount: number;
  businessStatus?: string;
  types?: string[];
  searchTerm?: string;
}

export interface ProviderDetails extends ProviderBasicInfo {
  phone?: string;
  website?: string;
  googleMapsUrl?: string;
  openNow?: boolean;
  weekdayHours?: string[];
  reviews: ProviderReview[];
}

export interface ProviderWithAnalysis extends ProviderDetails {
  selectionConfidence?: number;
  selectionReasoning?: string;
  reviewAnalysis?: ReviewAnalysisResult;
}

// ============================================================================
// REVIEW ANALYSIS TYPES
// ============================================================================

export interface ReviewEvidenceScore {
  score: number;
  evidence: string[];
}

export interface ResponsivenessScore extends ReviewEvidenceScore {
  supportsUrgency: boolean;
}

export interface ReviewAnalysisResult {
  overallScore: number;
  recommendationLevel: RecommendationLevel;
  expertiseMatch: ReviewEvidenceScore;
  responsiveness: ResponsivenessScore;
  qualityOfWork: ReviewEvidenceScore;
  professionalism: ReviewEvidenceScore;
  pricingFairness: ReviewEvidenceScore;
  redFlags: string[];
  strengths: string[];
  summary: string;
  suggestedQuestions: string[];
}

// ============================================================================
// SELECTION TYPES
// ============================================================================

export interface ProviderComparisonNotes {
  bestForQuality: number;
  bestForSpeed: number;
  bestForPrice: number | null;
  mostReviews: number;
}

export interface CallScript {
  introduction: string;
  keyQuestions: string[];
  urgencyPhrase: string;
}

export interface ProviderSelectionResult {
  selectedIndex: number;
  selectedName: string;
  confidence: number;
  reasoning: string;
  alternativeIndex: number | null;
  alternativeName: string | null;
  alternativeReason?: string;
  comparisonNotes: ProviderComparisonNotes;
  callScript: CallScript;
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

export interface SmartProviderSearchRequest {
  repairType?: string;
  serviceCategory?: ServiceCategory;
  location: string;
  urgency?: UrgencyLevel;
  quick?: boolean;
}

export interface SmartProviderSearchResponse {
  ok: boolean;
  error?: string;
  selected?: ProviderWithAnalysis;
  alternative?: {
    name: string;
    phone?: string;
    rating: number;
    reason: string;
  };
  comparison?: ProviderComparisonNotes;
  callScript?: CallScript;
  selectionMethod?: 'ai_analysis' | 'rating_fallback';
  allCandidates?: ProviderDetails[];
  location?: {
    lat: number;
    lng: number;
    formattedAddress: string;
  };
  searchCriteria?: {
    repairType: string;
    serviceCategory: string;
    urgency: string;
    searchLocation: string;
  };
  voiceCallReady?: {
    providerName: string;
    providerPhone?: string;
    providerAddress?: string;
    selectionConfidence?: number;
    callScript?: CallScript;
    reviewSummary?: string;
  };
}

export interface ProviderDetailsRequest {
  placeId: string;
  repairType?: string;
  urgency?: UrgencyLevel;
  analyze?: boolean;
}

export interface ProviderDetailsResponse {
  ok: boolean;
  error?: string;
  provider?: ProviderDetails;
  reviewAnalysis?: ReviewAnalysisResult;
  voiceCallReady?: {
    providerName: string;
    providerPhone?: string;
    providerAddress?: string;
  };
}

export interface CompareProvidersRequest {
  placeIds: string[];
  repairType: string;
  urgency?: UrgencyLevel;
}

export interface CompareProvidersResponse {
  ok: boolean;
  error?: string;
  selected?: ProviderWithAnalysis;
  alternative?: ProviderWithAnalysis;
  comparison?: ProviderComparisonNotes;
  callScript?: CallScript;
  candidatesAnalyzed?: number;
}

// ============================================================================
// VOICE CALL INTEGRATION TYPES
// ============================================================================

export interface MaintenanceContext {
  issue?: string;
  urgency?: UrgencyLevel;
  location?: string;
  serviceCategory?: ServiceCategory;
  tenantAvailability?: string;
  tenantName?: string;
  tenantEmail?: string;
  tenantPhone?: string;
  propertyAddress?: string;
  unitNumber?: string;
  providerName?: string;
  providerAddress?: string;
  providerRating?: number;
  providerReviewCount?: number;
  selectionReasoning?: string;
  reviewSummary?: string;
  suggestedQuestions?: string[];
}

export interface SmartVoiceCallRequest {
  repairType?: string;
  serviceCategory?: ServiceCategory;
  location: string;
  urgency?: UrgencyLevel;
  maintenanceContext?: MaintenanceContext;
}

export interface SmartVoiceCallResponse {
  ok: boolean;
  error?: string;
  step?: 'provider_selection' | 'phone_validation' | 'call_initiation';
  callInitiated?: boolean;
  call?: {
    callSid: string;
    to: string;
    from: string;
    status: string;
    twimlUrl?: string;
  };
  selectedProvider?: ProviderWithAnalysis;
  alternativeProvider?: {
    name: string;
    phone?: string;
    reason: string;
  };
  callScript?: CallScript;
  comparison?: ProviderComparisonNotes;
  allCandidates?: number;
  suggestion?: string;
}

export interface ProcessEmailRequest {
  emailContent: string;
  subject?: string;
  from?: string;
  propertyLocation?: string;
  tenantName?: string;
  autoCall?: boolean;
}

export interface EmailAnalysisResult {
  isMaintenanceIssue: boolean;
  confidence: number;
  issue?: string;
  serviceCategory?: ServiceCategory;
  urgency?: UrgencyLevel;
  location?: string;
  keywords?: string[];
  searchQuery?: string;
  tenantAvailability?: string;
  tenantPhone?: string;
  propertyAddress?: string;
  unitNumber?: string;
  reasoning?: string;
}

export interface ProcessEmailResponse {
  ok: boolean;
  error?: string;
  step?: string;
  isMaintenanceIssue?: boolean;
  analysis?: EmailAnalysisResult;
  selectedProvider?: ProviderWithAnalysis;
  alternativeProvider?: {
    name: string;
    phone?: string;
    reason: string;
  };
  callContext?: MaintenanceContext;
  callScript?: CallScript;
  voiceCallReady?: boolean;
  callInitiated?: boolean;
  call?: {
    callSid: string;
    to: string;
    from: string;
    status: string;
  };
  callError?: string;
  reviewSummary?: string;
  nextSteps?: string[];
  message?: string;
}

// ============================================================================
// QUICK SEARCH TYPES
// ============================================================================

export interface QuickProviderResult extends ProviderBasicInfo {
  qualityScore: number;
  popularityScore: number;
  combinedScore: number;
}

export interface QuickSearchResponse {
  ok: boolean;
  error?: string;
  providers?: QuickProviderResult[];
  location?: {
    lat: number;
    lng: number;
    formattedAddress: string;
  };
}
