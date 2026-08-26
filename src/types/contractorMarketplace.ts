/**
 * Contractor Marketplace Types
 * Types for the contractor bidding marketplace system
 */

// Contractor Profile
export interface Contractor {
  id: string;
  companyName: string;
  email: string;
  phone: string;
  website?: string;
  logoUrl?: string;
  description?: string;
  specialties: string[];
  yearsInBusiness: number;
  licenseNumber?: string;
  insuranceVerified: boolean;
  location: {
    city: string;
    state: string;
    zipCode: string;
    serviceRadius: number; // in miles
  };
  rating: {
    overall: number; // 0-5
    qualityOfWork: number;
    communication: number;
    punctuality: number;
    value: number;
    totalReviews: number;
  };
  credentials: {
    backgroundChecked: boolean;
    licensedAndInsured: boolean;
    bondedAmount?: number;
    certifications: string[];
  };
  // D&B DUNS verification
  dunsNumber?: string;
  dunsVerified?: boolean;
  dunsVerifiedAt?: string;
  dunsData?: {
    registeredName: string;
    primaryAddress: {
      streetAddress?: string;
      city?: string;
      state?: string;
      postalCode?: string;
    };
    operatingStatus?: string;
    employeeCount?: number;
    sicCodes?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

// Renovation Listing on Marketplace
export interface MarketplaceListing {
  id: string;
  propertyOwnerId: string;
  propertyAddress: string;
  scanId: string;
  scanThumbnailUrl: string;
  renovationType: string;
  renovationDescription: string;
  estimatedCostRange: {
    low: number;
    high: number;
  };
  desiredStartDate?: string;
  flexibleTimeline: boolean;
  roomDimensions?: {
    widthFeet: number;
    lengthFeet: number;
    heightFeet: number;
    floorAreaSqFt: number;
  };
  highlightedAreas?: Array<{
    id: string;
    description: string;
    coordinates?: { x: number; y: number; z: number };
  }>;
  // Model files for 3D viewer
  modelFiles?: {
    obj?: string;
    mtl?: string;
    glb?: string;
    texture?: string;
    ply?: string;
  };
  // Processing result metadata
  processingResult?: {
    numPoints?: number;
    numVertices?: number;
    numFaces?: number;
    numViewpoints?: number;
    dimensions?: Record<string, number>;
  };
  photos?: string[];
  // AI-generated and enriched fields
  aiDescription?: string;
  aiDescriptionGeneratedAt?: string;
  coverImageUrl?: string;
  aiAfterImages?: Array<{ url: string; angleIndex: number }>;
  materialBreakdown?: Array<{
    item: string;
    quantity?: number;
    unit?: string;
    unitCost: number;
    totalCost: number;
  }>;
  laborBreakdown?: Array<{
    task: string;
    hours?: number;
    ratePerHour?: number;
    totalCost: number;
  }>;
  // Source tracking
  sourceType?: 'suggestion' | 'scan' | 'manual';
  suggestionId?: string;
  // Location for region filtering
  propertyZipCode?: string;
  propertyCity?: string;
  propertyState?: string;
  // Social data
  commentsCount?: number;
  status: 'active' | 'pending_review' | 'in_progress' | 'completed' | 'cancelled';
  bids: MarketplaceBid[];
  createdAt: string;
  updatedAt: string;
}

// Bid from a Contractor
export interface MarketplaceBid {
  id: string;
  listingId: string;
  contractorId: string;
  contractor: Contractor;
  bidAmount: number;
  estimatedDuration: string; // e.g., "2-3 weeks"
  proposedStartDate?: string;
  scope: string;
  materials?: Array<{
    item: string;
    cost: number;
  }>;
  laborCost?: number;
  warranty?: string;
  notes?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  createdAt: string;
  updatedAt: string;
}

// Bid Price Analytics
export interface BidAnalytics {
  listingId: string;
  totalBids: number;
  highBid: {
    amount: number;
    bid: MarketplaceBid;
  };
  lowBid: {
    amount: number;
    bid: MarketplaceBid;
  };
  medianBid: {
    amount: number;
    bids: MarketplaceBid[]; // Could be 1-2 bids at median
  };
  averageBid: number;
  bidRange: {
    low: number;
    high: number;
    spread: number;
    spreadPercent: number;
  };
}

// AI Contractor Analysis
export interface ContractorAIOverview {
  contractorId: string;
  summary: string;
  qualityAssessment: {
    score: number; // 0-100
    strengths: string[];
    concerns: string[];
  };
  reviewAnalysis: {
    sentiment: 'positive' | 'neutral' | 'negative';
    commonPraise: string[];
    commonComplaints: string[];
    responseToIssues: string;
  };
  credibilityScore: number; // 0-100
  recommendationLevel: 'highly_recommended' | 'recommended' | 'proceed_with_caution' | 'not_recommended';
  sources: Array<{
    platform: string;
    url?: string;
    reviewCount: number;
    averageRating: number;
  }>;
  generatedAt: string;
}

// Contractor Dashboard Data
export interface ContractorDashboardData {
  activeListings: MarketplaceListing[];
  myBids: Array<{
    bid: MarketplaceBid;
    listing: MarketplaceListing;
  }>;
  wonProjects: Array<{
    bid: MarketplaceBid;
    listing: MarketplaceListing;
  }>;
  stats: {
    totalBidsPlaced: number;
    bidsWon: number;
    winRate: number;
    averageBidAmount: number;
    totalEarnings: number;
  };
}

// Property Owner Marketplace View
export interface OwnerMarketplaceData {
  myListings: MarketplaceListing[];
  analytics: Record<string, BidAnalytics>; // keyed by listingId
  totalActiveBids: number;
  totalCompletedProjects: number;
}

// Create Listing Request
export interface CreateListingRequest {
  scanId: string;
  propertyAddress: string;
  renovationType: string;
  renovationDescription: string;
  estimatedCostRange?: {
    low: number;
    high: number;
  };
  desiredStartDate?: string;
  flexibleTimeline: boolean;
  highlightedAreas?: Array<{
    id: string;
    description: string;
    coordinates?: { x: number; y: number; z: number };
  }>;
}

// Submit Bid Request
export interface SubmitBidRequest {
  listingId: string;
  bidAmount: number;
  estimatedDuration: string;
  proposedStartDate?: string;
  scope: string;
  materials?: Array<{
    item: string;
    cost: number;
  }>;
  laborCost?: number;
  warranty?: string;
  notes?: string;
}

// DM-style comment on a listing
export interface ListingComment {
  id: string;
  listingId: string;
  authorId: string;
  authorName: string;
  authorRole: 'owner' | 'contractor';
  authorCompanyName?: string;
  message: string;
  bidId?: string;
  createdAt: string;
  updatedAt: string;
}

// Bid enriched with AI analysis scores
export interface BidWithAIAnalysis extends MarketplaceBid {
  aiAnalysis?: {
    companySearchSummary: string;
    reviewSentiment: 'positive' | 'neutral' | 'negative';
    qualityScore: number;     // 0-100
    credibilityScore: number; // 0-100
    valueScore: number;       // 0-100 (quality/cost ratio)
    recommendation: string;
    rank?: number;
    sources: Array<{ platform: string; url?: string; snippet: string }>;
    analyzedAt: string;
  };
}

// Listing creation wizard step
export type ListingWizardStep = 'confirm' | 'attach_scan' | 'ai_generate' | 'review';

// All state the 4-step listing wizard needs
export interface ListingWizardState {
  step: ListingWizardStep;
  renovationType: string;
  renovationDescription: string;
  estimatedCostLow: string;
  estimatedCostHigh: string;
  desiredStartDate: string;
  flexibleTimeline: boolean;
  propertyAddress: string;
  sourceType: 'suggestion' | 'scan' | 'manual';
  suggestionData?: any;
  selectedScanId?: string;
  scanThumbnailUrl?: string;
  modelFiles?: Record<string, string>;
  roomDimensions?: any;
  aiDescription?: string;
  aiGenerating?: boolean;
  aiGenerated?: boolean;
  photos?: string[];
  aiAfterImages?: Array<{ url: string; angleIndex: number }>;
}
